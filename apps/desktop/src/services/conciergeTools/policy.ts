// The concierge's PER-TOOL AUTONOMY POLICY — the mechanism by which the human decides, tool by
// tool, how much the concierge may do on its own versus check in about first.
//
// THE SHAPE OF THE CONTROL IS THE REQUIREMENT. The founder chose PER-TOOL configuration over a
// single coarse "autonomy level" dial, and that is not a UI preference — it is the only shape that
// can express what people actually want. A single dial has to be set to the strictness of the most
// dangerous thing it governs, so "let it read my terminals freely" and "never merge a PR without
// asking me" collapse into one number, and the number that keeps `merge_pr` safe also makes
// `list_projects` ask. There is deliberately NO global autonomy enum in this module. What plays the
// role a dial would have played is the DEFAULT, derived per-tool from the risk the domain modules
// already classify — so the file stays small without the small file being a policy hole.
//
// THREE VALUES, and the third is not a synonym for the second:
//   • `allow` — the concierge performs it silently. No prompt, no confirmation.
//   • `ask`   — the human must approve this invocation before it happens.
//   • `deny`  — refuse outright. Not "ask and expect a no": there is no prompt to answer, so a
//               denied tool cannot be talked into running by a persuasive model turn.
//
// FOUR PROPERTIES, in the order they matter:
//
// 1. THE DEFAULTS ARE DERIVED, NEVER HAND-LISTED. Every tool's default comes from its domain's own
//    risk map (`LIFECYCLE_RISK`, `WORKSPACE_OP_RISK`, `WORKFLOW_RISK`, and the terminal domain's
//    `write` flag) through `DEFAULT_DECISION_BY_RISK`. A hand-written per-tool default table would
//    be a second classification of the same facts, and the second one is the one nobody updates.
//    Read-only and routine work defaults to `allow`; everything that is irreversible, outward-facing,
//    metered, disruptive, or touches main defaults to `ask`.
//
// 2. NOTHING RESOLVES TO `allow` BY ACCIDENT. An absent config key resolves through the risk class,
//    which is total. A config value we cannot read (`"allwo"`, a number, a stray `true`) resolves to
//    `ask` — never to the tool's default, because a default of `allow` plus a typo'd `deny` would
//    silently hand back exactly the authority the human was trying to remove. And a tool name this
//    module has never heard of resolves to `deny`: an unclassified tool is a BUG (property 3 makes
//    it a compile error), and the safe read of "I have no idea how dangerous this is" is to refuse
//    it rather than to ask a human to adjudicate something nobody classified.
//
// 3. AN UNCLASSIFIED TOOL IS A TYPECHECK FAILURE. `ConciergeToolName` is the union of the domains'
//    OWN exported operation unions, and `RISK_BY_TOOL` is a `Record<ConciergeToolName, …>` built by
//    spreading each domain's risk map through a vocabulary translation. So a new operation is
//    classified in its domain's map (or that domain fails to compile), and it lands here
//    automatically — there is no list in this file for someone to forget to update.
//
//    The terminal domain is the one seam where that guarantee is bought with a test rather than the
//    compiler, and the reason is worth stating: `CONCIERGE_TERMINAL_TOOLS` is a
//    `readonly ConciergeToolDescriptor[]` whose `name` is typed `string`, so there is no literal
//    union to derive from and no type-level way to notice a fourth descriptor. `TERMINAL_TOOL_RISK`
//    below is therefore the classification, and `policy.test.ts` asserts set-equality against the
//    descriptor list — a new terminal tool fails that test on the first run. (That list is imported
//    by the TEST, not by this module: nothing here has a runtime use for the descriptors.)
//
// 4. THE DECISION FUNCTION IS PURE AND SYNCHRONOUS. `evaluateToolPolicy` reads no store, touches no
//    IO, and imports no React. Everything it needs — the override table — arrives as an explicit
//    parameter, so the call site (which this module does not own) can supply a config mirror, a
//    per-project layer, or a literal in a test without this module knowing the difference.
//
// SCOPE NOTE: this module classifies and decides. It does not PROMPT, does not remember an answer,
// and does not perform anything. `ask` is a verdict the caller acts on; the confirmation UI and the
// authority token it mints (see services/dispatchAuthority's `concierge-tool` arm) belong to the
// call site.

import { LIFECYCLE_RISK, LIFECYCLE_OPS, type LifecycleOp, type LifecycleRisk } from "./lifecycle";
import { REVIEW_OPS, REVIEW_RISK, type ReviewOp } from "./review";
import {
  WORKFLOW_OPERATIONS,
  WORKFLOW_RISK,
  type WorkflowOperation,
  type WorkflowRiskClass,
} from "./workflow";
import { EVENTS_OPS, EVENTS_RISK, type EventsOp } from "./events";
import {
  WORKSPACE_OPS,
  WORKSPACE_OP_RISK,
  type RiskClass as WorkspaceRiskClass,
  type WorkspaceOp,
} from "./workspace";
import { ATTACHMENTS_OPS, ATTACHMENTS_RISK, type AttachmentsOp } from "./attachments";
import { BOARD_OPS, BOARD_RISK, type BoardOp } from "./board";
import { APPROVALS_OPS, APPROVALS_RISK, type ApprovalsOp } from "./approvals";
import { PLANS_OPS, PLANS_RISK, type PlansOp } from "./plans";
import { DIFF_OPS, DIFF_RISK, type DiffOp } from "./diff";
import { FLEET_OPS, FLEET_RISK, type FleetOp } from "./fleet";
import { SCREENSHOT_OPS, SCREENSHOT_RISK, type ScreenshotOp, type ScreenshotRisk } from "./screenshot";
import { RESEARCH_OPS, RESEARCH_RISK, type ResearchOp } from "./research";
import {
  ACCOUNTS_OPS,
  ACCOUNTS_RISK,
  ACCOUNTS_TOOL_SUMMARY,
  type AccountsOp,
} from "./accounts";
import { WIDE_HISTORY_SCOPE } from "@sparkle/core";

// ---------------------------------------------------------------------------------------------
// The three values
// ---------------------------------------------------------------------------------------------

/** What the concierge may do with one tool. See the header for why `deny` is distinct from `ask`. */
export type PolicyDecision = "allow" | "ask" | "deny";

/** The three values, in increasing strictness — the order the settings control lists them in. */
export const POLICY_DECISIONS = ["allow", "ask", "deny"] as const satisfies readonly PolicyDecision[];

/** Narrow an arbitrary value (a hand-edited TOML string, an older backend's payload) to a decision.
 *  Returns null for anything unrecognized rather than guessing — the caller decides what an
 *  unreadable value means, and `evaluateToolPolicy` deliberately does NOT read it as the default. */
export function asPolicyDecision(v: unknown): PolicyDecision | null {
  return v === "allow" || v === "ask" || v === "deny" ? v : null;
}

/** How the pane and the concierge say each value out loud. */
export const POLICY_DECISION_LABEL: Record<PolicyDecision, string> = {
  allow: "Allow",
  ask: "Ask first",
  deny: "Never",
};

// ---------------------------------------------------------------------------------------------
// One risk vocabulary across four domains
// ---------------------------------------------------------------------------------------------

/**
 * The UNION of the four domains' risk vocabularies, flattened into one so a single default table
 * can cover every tool. Each arm keeps the meaning its originating domain gave it:
 *
 *  • `read-only`       — observes; changes nothing anywhere.
 *  • `privacy-sensitive` — observes the HUMAN rather than the app: their screen, their
 *    surroundings, or their own private conversations with Sparkle. Changes nothing, and still
 *    must be asked about.
 *  • `routine`         — local, reversible, or one click from undone.
 *  • `disruptive`      — interrupts work in flight; the records survive, the running state doesn't.
 *  • `rewrites-branch` — rewrites the agent's own history (a rebase). Reflog-recoverable, ids change.
 *  • `outward-facing`  — reaches the network / other people (a push, a PR).
 *  • `costs-money`     — starts something metered that bills while it runs.
 *  • `mutates-main`    — changes the branch everything else is measured against.
 *  • `irreversible`    — destroys something nothing here can put back.
 *
 * Deliberately a union rather than a lowest-common-denominator re-classification: collapsing
 * `costs-money` and `mutates-main` into a generic "dangerous" would throw away exactly the
 * distinction the human is being asked to rule on.
 */
export type ConciergeRiskClass =
  | "read-only"
  | "privacy-sensitive"
  | "routine"
  | "disruptive"
  | "rewrites-branch"
  | "outward-facing"
  | "costs-money"
  | "mutates-main"
  | "irreversible";

/** One line per risk class, for the settings row and for the concierge explaining itself. */
export const CONCIERGE_RISK_NOTE: Record<ConciergeRiskClass, string> = {
  "read-only": "Observes only — changes nothing.",
  // Covers both shapes this class is used for: a screen capture, and a history search asking for
  // `scope: "all"` (which reaches your own concierge conversations). One sentence for both, because
  // the class is one fact — "this reads something private to you" — and a second note per tool is
  // the one that goes stale.
  "privacy-sensitive": "Reads something private to you — your screen, or your own conversations with Sparkle.",
  routine: "Local and reversible.",
  disruptive: "Stops work that is in flight.",
  "rewrites-branch": "Rewrites the agent's own commit history.",
  "outward-facing": "Reaches the outside world (a push or a pull request).",
  "costs-money": "Starts something that bills while it runs.",
  "mutates-main": "Changes the branch everything else is measured against.",
  irreversible: "Permanently destroys something that cannot be recovered.",
};

/** Which tool domain a tool belongs to — the grouping the settings pane renders.
 *
 *  DELIBERATELY NOT the registry's wire union: this one also carries `app` (the original
 *  sparkle-control ops, which are not dispatched through `concierge_tool` at all). It is the
 *  SETTINGS vocabulary, not the wire vocabulary, and the two are kept separate on purpose. A new
 *  dispatched domain therefore has to be added here as well — which is a typecheck failure until it
 *  is, via `DOMAIN_BY_TOOL` and `NAMES_BY_DOMAIN` below. */
export type ConciergeToolDomain =
  | "lifecycle"
  | "review"
  | "terminal"
  | "attachments"
  | "workflow"
  | "events"
  | "workspace"
  | "screenshot"
  | "board"
  | "approvals"
  | "plans"
  | "diff"
  | "fleet"
  | "research"
  | "accounts"
  | "app";

/** The domains in the order the pane lists them, with the heading each renders under. */
export const CONCIERGE_TOOL_DOMAINS = [
  { id: "lifecycle", label: "Agent lifecycle" },
  { id: "review", label: "Code review" },
  { id: "terminal", label: "Terminal" },
  { id: "attachments", label: "Files & attachments" },
  { id: "workflow", label: "Git & pull requests" },
  { id: "events", label: "Change notifications" },
  { id: "workspace", label: "Projects & window" },
  { id: "screenshot", label: "Screenshots" },
  { id: "board", label: "Tasks & work graph" },
  { id: "approvals", label: "Approvals" },
  { id: "plans", label: "Plans" },
  { id: "diff", label: "Diff" },
  { id: "fleet", label: "Fleet awareness" },
  { id: "research", label: "Background research" },
  { id: "accounts", label: "Claude accounts" },
  { id: "app", label: "App & settings" },
] as const satisfies readonly { id: ConciergeToolDomain; label: string }[];

// ---------------------------------------------------------------------------------------------
// The `app` domain: the ORIGINAL sparkle-control ops (roborev 54226, finding 1)
// ---------------------------------------------------------------------------------------------

/**
 * The pre-existing `sparkle-control` ops, brought under the same per-tool policy as everything else.
 *
 * WHY THESE ARE HERE. They predate the concierge tool spine and are gated only by
 * `callerMayAdminister`, which returns `true` for the concierge outright. Every OTHER caller that
 * clears that check is an interactive agent whose input is the human's own typing. The concierge is
 * categorically different: each turn's prompt is a snapshot of live agent and TERMINAL output, i.e.
 * text this app did not author and cannot vouch for. That makes an ungated `set_config` a
 * prompt-injection path into machine-wide configuration — text scrolling past in some agent's
 * terminal could talk the concierge into a config write.
 *
 * So these are classified and policed exactly like the domain tools. They are NOT removed from the
 * concierge's reach (the founder's requirement is that it can do everything in the app, settings
 * included) — they become *tunable*, with defaults chosen below.
 *
 * The two `free`-tier read/self-report ops (`get_state`, `get_config`) are included so the pane is
 * complete and the human can deny them if they want; they default to `allow`, which is exactly the
 * behaviour they have today.
 *
 * DELIBERATELY ABSENT: `pin_agent`, `set_agent_ordering` and `unpin_agent`. All three are RETIRED —
 * their handlers refuse unconditionally and none is registered in `apps/mcp-control/src/server.ts`.
 * Listing them would put dead rows in the settings pane for tools that can never run, and invite a
 * summary describing behaviour they no longer have. `controlListener`'s `CONCIERGE_EXEMPT_OPS`
 * names them as the exempt set, and a test keeps the two lists in step.
 *
 * `unpin_agent` joined them on 2026-07-31 with the removal of agent pinning. It was briefly left
 * here with a summary reading "Removed — agent pinning no longer exists", which is exactly the
 * "summary describing behaviour they no longer have" this note forbids: a togglable Settings row,
 * risk-classed `routine`, for a tool that can only refuse.
 */
export const APP_TOOL_NAMES = [
  "get_state",
  "get_config",
  "rename_agent",
  "set_agent_activity",
  "set_theme",
  "set_zoom",
  "navigate",
  "set_agent_model",
  "set_config",
  "append_communication_guideline",
  "set_agent_goal",
  "set_agent_goal_met",
  "claim_pr",
  "release_pr",
] as const;

export type AppToolName = (typeof APP_TOOL_NAMES)[number];

/**
 * Risk for the app domain.
 *
 * `set_config` is `irreversible` — the strongest word available — which under the derived-default
 * table makes it `ask`. That is the point of this whole addition: a machine-wide configuration
 * write, reachable from untrusted terminal text, must not happen silently. It overstates
 * recoverability slightly (a config value can be set back by hand), and that trade is deliberate:
 * the vocabulary has no "machine-wide write" class, and erring toward asking is the cheap mistake.
 *
 * The UI ops (`set_theme`, `set_zoom`, `navigate`, `pin_agent`, …) are `routine`: visible, trivially
 * undone by the human, and constantly useful — "put me where the work is" is a core concierge move,
 * and making it ask every time would make the concierge annoying enough to switch off.
 */
export const APP_TOOL_RISK: Record<AppToolName, ConciergeRiskClass> = {
  get_state: "read-only",
  get_config: "read-only",
  rename_agent: "routine",
  set_agent_activity: "routine",
  set_theme: "routine",
  set_zoom: "routine",
  navigate: "routine",
  set_agent_model: "routine",
  // ROUTINE, and that is the founder's explicit call rather than an oversight. Asked whether the
  // concierge should propose a communication rule for approval or just save it and say so, they
  // chose save-and-say-so — re-explaining a preference is the exact friction the file exists to
  // remove, and an approval prompt per preference reintroduces it. It earns `routine` on the
  // merits too: the write is append-only, visible in the reply that announces it, and undone by
  // deleting a line in Settings → "How Sparkle talks to you". Anyone who disagrees can set this one
  // tool to Ask in Settings → Concierge tools; that is what the per-tool policy is for.
  append_communication_guideline: "routine",
  set_config: "irreversible",
  // ROUTINE. These write one short field about who is doing what: an agent's objective, and a
  // courtesy claim that expires on its own. Nothing here is destructive and nothing reaches the
  // repo — the claim only makes `merge_pr` pause and point at the claimant.
  set_agent_goal: "routine",
  set_agent_goal_met: "routine",
  claim_pr: "routine",
  release_pr: "routine",
};

const APP_TOOL_SUMMARY: Record<AppToolName, string> = {
  get_state: "Read the agent roster and the current theme.",
  get_config: "Read Sparkle's workflow and worker settings.",
  rename_agent: "Rename an agent.",
  set_agent_activity: "Update an agent's one-line activity caption.",
  set_theme: "Switch the app between light and dark.",
  set_zoom: "Change the terminal text size.",
  navigate: "Move you to a view or open a specific agent.",
  set_agent_model: "Change which Claude model an agent runs on.",
  append_communication_guideline: "Save a rule about how Sparkle should talk to you.",
  set_config: "Write Sparkle's machine-wide configuration.",
  set_agent_goal: "Set an agent's current objective (what it is trying to finish).",
  set_agent_goal_met: "Mark a stalled-but-finished agent's goal met — the only thing that makes an idle agent count as done.",
  claim_pr: "Record that you will land a pull request yourself, so nothing merges around you.",
  release_pr: "Give up your claim on a pull request.",
};

// ---------------------------------------------------------------------------------------------
// The terminal domain's names + risk (the one classification this module owns — see header §3)
// ---------------------------------------------------------------------------------------------

/** The terminal tools, as a literal union this module can key a `Record` on.
 *
 *  Not derived from `CONCIERGE_TERMINAL_TOOLS` because that array's `name` is typed `string`, which
 *  widens to `string` and would make every `Record` over it an index signature — the exact hole this
 *  layer exists to close. `policy.test.ts` asserts the two agree, so a descriptor added to the
 *  terminal domain fails a test rather than silently arriving unclassified. */
export const TERMINAL_TOOL_NAMES = [
  "read_agent_terminal",
  "get_agent_status",
  "read_picker_options",
  "select_picker_option",
  "send_control_key",
  "send_to_agent_terminal",
] as const;

export type TerminalToolName = (typeof TERMINAL_TOOL_NAMES)[number];

/** The terminal domain's risk map, in this module's vocabulary.
 *
 *  `send_to_agent_terminal` is `disruptive`, not `routine`: typing into a live agent changes what a
 *  running process does next, and the text cannot be un-typed. It is the tool whose descriptor
 *  carries `write: true`, and the one an autonomy policy most needs to be able to gate. */
export const TERMINAL_TOOL_RISK: Record<TerminalToolName, ConciergeRiskClass> = {
  read_agent_terminal: "read-only",
  get_agent_status: "read-only",
  read_picker_options: "read-only",
  // `disruptive` for the same reason as a send, and it is NOT a lesser act: pressing a menu option
  // decides what a running process does next, on the human's behalf, and cannot be un-pressed.
  // Classifying it below a send would let an autonomy policy gate typing "2" while waving through
  // pressing option 2 — the same outcome by a different route.
  select_picker_option: "disruptive",
  // `esc` can discard work in flight; this is at least as consequential as typing.
  send_control_key: "disruptive",
  send_to_agent_terminal: "disruptive",
};

/** Short, row-sized summaries. The descriptors' own `description` fields are model-facing prose
 *  (several sentences each, written to steer an LLM); a settings row needs one line. */
const TERMINAL_TOOL_SUMMARY: Record<TerminalToolName, string> = {
  read_agent_terminal: "Read what an agent's terminal recently showed.",
  get_agent_status: "Read an agent's live status and whether it is waiting on you.",
  read_picker_options: "Read the menu an agent is showing right now.",
  select_picker_option: "Answer a menu an agent is showing, as if you had picked it.",
  send_control_key: "Press esc, shift+tab, ctrl+b, enter or an arrow key in an agent's terminal.",
  send_to_agent_terminal:
    "Type a message into an agent's terminal, as if you had typed it. State `goal` (a verifiable " +
    "completion criterion) or `notWork: { reason }`.",
};

/**
 * The research domain's rows — and here a summary is REQUIRED rather than nice to have.
 *
 * These four op names (`dispatch`, `list`, `get`, `cancel`) are the wire contract, and they are the
 * most generic in the whole catalog. A settings row that fell back to the risk note would read
 * "dispatch — Local and reversible", which tells the human nothing about what they are being asked
 * to allow. Every row here says what it does AND that a research task is a background `claude` run,
 * because "this spends money in the background" is the fact someone deciding to gate `dispatch`
 * actually needs.
 */
const RESEARCH_TOOL_SUMMARY: Record<ResearchOp, string> = {
  dispatch:
    "Send a question off to a background research agent and keep talking — it answers later, and " +
    "it is a metered Claude run.",
  list: "See which background research is still running and what has come back.",
  get: "Read one research task in full, including its findings.",
  cancel: "Stop a background research task that is still running.",
};

/**
 * The workspace domain's rows — deliberately just ONE of them.
 *
 * The workspace domain publishes no per-op prose, and inventing a sentence for all sixteen here
 * would be a second description that drifts (see `SUMMARY_BY_TOOL`). `search_history` earns an
 * exception because it is the only tool whose settings row and APPROVAL CARD are about an argument
 * rather than the verb: the card is only ever raised for `scope: "all"`, and the fallback prose for
 * this row is the `read-only` note — "Observes only — changes nothing." — which is true of the op
 * and useless as the headline on a card asking whether a model may read your private conversations.
 */
const WORKSPACE_TOOL_SUMMARY: Partial<Record<WorkspaceOp, string>> = {
  // The "even if you allow it" clause is load-bearing, not emphasis: allowing this row really does
  // NOT cover `scope: "all"` (see `perCallRiskFor`'s floor), and a summary that merely said "it asks
  // first" would be describing a promise the rule below it has to keep. These two move together.
  // The scope value is INTERPOLATED, not spelled out, for the same reason `server.ts`'s model-facing
  // description is: this sentence names an argument the `.strict()` zod enum has to accept, so a
  // rename that missed it would leave the consent card telling the human to expect a value the
  // schema now refuses — and nothing would go red, because prose is not typechecked.
  search_history:
    "Search your saved prompt and response history. Normally it searches build history only; " +
    `reading your own conversations with the concierge needs \`scope: "${WIDE_HISTORY_SCOPE}"\`, ` +
    "which always asks first — even if you allow this tool.",
};

/** The attachment domain's rows. Keyed on that domain's own op union, so an op added there is a
 *  typecheck failure here rather than a settings row that silently falls back to a risk note. */
const ATTACHMENTS_TOOL_SUMMARY: Record<AttachmentsOp, string> = {
  list_attachments: "See which files are queued to ride along with an agent's next message.",
  attach_to_message: "Attach a file from the project to an agent's next message.",
  clear_attachments: "Un-stage the files queued for an agent (nothing is deleted).",
};

// ---------------------------------------------------------------------------------------------
// Vocabulary translation + the exhaustive per-tool tables
// ---------------------------------------------------------------------------------------------

// Each domain's own risk words, mapped into the shared vocabulary. Written as exhaustive `Record`s
// over the DOMAIN's type so a domain that adds a risk word fails to compile here — the translation
// is the one place the vocabularies can drift apart.

const LIFECYCLE_RISK_TO_CLASS: Record<LifecycleRisk, ConciergeRiskClass> = {
  irreversible: "irreversible",
  "outward-facing": "outward-facing",
  "costs-money": "costs-money",
  routine: "routine",
};

const WORKSPACE_RISK_TO_CLASS: Record<WorkspaceRiskClass, ConciergeRiskClass> = {
  "read-only": "read-only",
  routine: "routine",
  disruptive: "disruptive",
  irreversible: "irreversible",
};

/** The screenshot domain publishes ONE risk word, and it maps to the class minted for it. Written as
 *  a translation table like every other domain's rather than inlined, so a second screenshot risk
 *  word (a camera? the clipboard?) cannot be added without deciding what it means here. */
const SCREENSHOT_RISK_TO_CLASS: Record<ScreenshotRisk, ConciergeRiskClass> = {
  "privacy-sensitive": "privacy-sensitive",
};

/** Row-sized summaries for the settings pane. Both say WHAT LANDS ON DISK, because that — not the
 *  act of looking — is what the human is being asked to consent to. */
const SCREENSHOT_TOOL_SUMMARY: Record<ScreenshotOp, string> = {
  capture_window: "Save a picture of Sparkle's window to a file.",
  capture_agent: "Save a picture of one agent's pane to a file.",
};

const WORKFLOW_RISK_TO_CLASS: Record<WorkflowRiskClass, ConciergeRiskClass> = {
  "read-only": "read-only",
  "rewrites-branch": "rewrites-branch",
  "outward-facing": "outward-facing",
  "mutates-main": "mutates-main",
  irreversible: "irreversible",
};

/** Translate one domain's `Record<Op, DomainRisk>` into `Record<Op, ConciergeRiskClass>`. Generic in
 *  the key so the result stays exhaustive over that domain's op union rather than degrading to an
 *  index signature. */
function translateRisk<K extends string, R extends string>(
  source: Record<K, R>,
  vocabulary: Record<R, ConciergeRiskClass>,
): Record<K, ConciergeRiskClass> {
  const out = {} as Record<K, ConciergeRiskClass>;
  for (const key of Object.keys(source) as K[]) out[key] = vocabulary[source[key]];
  return out;
}

/** Stamp one constant value across a domain's key set, keeping the key union exact. */
function constantOver<K extends string, V>(source: Record<K, unknown>, value: V): Record<K, V> {
  const out = {} as Record<K, V>;
  for (const key of Object.keys(source) as K[]) out[key] = value;
  return out;
}

/** The workflow domain stores a profile per op; lift out just the risk word. */
const WORKFLOW_OP_RISK: Record<WorkflowOperation, WorkflowRiskClass> = (() => {
  const out = {} as Record<WorkflowOperation, WorkflowRiskClass>;
  for (const op of WORKFLOW_OPERATIONS) out[op] = WORKFLOW_RISK[op].risk;
  return out;
})();

/**
 * EVERY tool the concierge can name, as the union of the domains' own exported operation unions.
 *
 * This is the type-level guarantee described in the header: adding an operation to a domain forces
 * that domain to classify it (its risk map is a `Record` over its own union), and `RISK_BY_TOOL`
 * below is a `Record` over THIS union — so nothing can reach the policy layer unclassified.
 */
export type ConciergeToolName =
  | LifecycleOp
  | ReviewOp
  | TerminalToolName
  | AttachmentsOp
  | WorkflowOperation
  | EventsOp
  | WorkspaceOp
  | ScreenshotOp
  | BoardOp
  | ApprovalsOp
  | DiffOp
  | PlansOp
  | FleetOp
  | ResearchOp
  | AccountsOp
  | AppToolName;

/**
 * The exhaustive risk classification, assembled from the domains rather than restated.
 *
 * The annotation is load-bearing: `Record<ConciergeToolName, ConciergeRiskClass>` means that if the
 * spread below ever fails to cover the union — a domain export renamed, a terminal tool added to the
 * union without a `TERMINAL_TOOL_RISK` line — `tsc` fails HERE, at the table, rather than the tool
 * quietly falling through to the unclassified path at runtime.
 */
/**
 * Reclassifications applied AFTER the domains' own maps (roborev 54240).
 *
 * A domain's risk word is written for that domain's vocabulary, and two of them lack a
 * `disruptive` arm — so an op that stops work in flight collapses to `routine`, and `routine`
 * derives to `allow`. The result was that the module's headline property ("nothing resolves to
 * `allow` by accident") did NOT hold for stopping work in flight: `close_agent` and
 * `spin_down_worker` tear down a live PTY, tab and worktree of a possibly-running agent and were
 * silently allowed, while the semantically identical `stop_project_agents` — which happens to live
 * in a domain that HAS `disruptive` — asked first. Whether the human gets consulted before their
 * running agent is killed should not depend on which file the op was implemented in.
 *
 * Kept as an explicit, commented override rather than edited into each domain's map: the domains
 * own their own vocabulary, this module owns the cross-domain policy, and a silent divergence
 * between two spellings of "this stops work" is exactly what produced the bug.
 */
const RISK_OVERRIDES: Partial<Record<ConciergeToolName, ConciergeRiskClass>> = {
  // Kills a running process and removes the tab. The records survive; the running state does not.
  close_agent: "disruptive",
  // Same, for a worker: stops its session and deletes its worktree.
  spin_down_worker: "disruptive",
  // BOTH ARE `routine` IN THEIR DOMAIN AND `disruptive` HERE, which is exactly the split this table
  // exists for. Their domain word answers "is this reversible" — it is: a stop is undone by a
  // restart, and a restart resumes the Claude session rather than starting it over. This table
  // answers a different question: may it stop work IN FLIGHT without asking a human first? It may —
  // a restart kills a `claude` mid-turn — and that is the property the `disruptive` tier gates on,
  // the same reason close_agent and spin_down_worker are listed above. Bead sparkle-x0pvw.
  restart_agent: "disruptive",
  stop_agent: "disruptive",
  // Registers an ARBITRARY absolute path as a project. Not destructive, but it is the one
  // workspace op that takes a filesystem path from the model and gives it standing in the app.
  add_project_from_folder: "disruptive",
};

const RISK_BY_TOOL: Record<ConciergeToolName, ConciergeRiskClass> = {
  ...translateRisk(LIFECYCLE_RISK, LIFECYCLE_RISK_TO_CLASS),
  // The review domain publishes the SAME four risk words as workspace, so it reuses that
  // translation. `close_finding` is `disruptive` there, which derives to `ask` — see review.ts for
  // why `disruptive` and not `irreversible` (roborev's `close --reopen` genuinely puts it back, so
  // calling it irreversible would overstate the damage while landing on the same decision).
  ...translateRisk(REVIEW_RISK, WORKSPACE_RISK_TO_CLASS),
  ...translateRisk(WORKSPACE_OP_RISK, WORKSPACE_RISK_TO_CLASS),
  ...translateRisk(SCREENSHOT_RISK, SCREENSHOT_RISK_TO_CLASS),
  ...translateRisk(WORKFLOW_OP_RISK, WORKFLOW_RISK_TO_CLASS),
  // The events domain publishes only `read-only` and `routine` — both members of workspace's
  // vocabulary — so it reuses that translation rather than declaring a third identical one. Both map
  // to `allow`, which is the point: finding out what changed is not something to ask permission for.
  ...translateRisk(EVENTS_RISK, WORKSPACE_RISK_TO_CLASS),
  // The board domain publishes the SAME four risk words as workspace, so it reuses that
  // translation rather than declaring a second identical one.
  ...translateRisk(BOARD_RISK, WORKSPACE_RISK_TO_CLASS),
  ...translateRisk(APPROVALS_RISK, WORKSPACE_RISK_TO_CLASS),
  // Accounts publishes `read-only` and `disruptive` — both members of workspace's vocabulary. The
  // load-bearing row is `switch_all`: `disruptive` derives to `ask`, which IS its confirmation gate
  // (see accounts.ts). Re-classing it `routine` would silently let the concierge move the entire
  // fleet between Anthropic logins unprompted.
  ...translateRisk(ACCOUNTS_RISK, WORKSPACE_RISK_TO_CLASS),
  ...translateRisk(PLANS_RISK, WORKSPACE_RISK_TO_CLASS),
  ...translateRisk(DIFF_RISK, WORKSPACE_RISK_TO_CLASS),
  // Fleet publishes the same four risk words. The load-bearing rows are the two `routine` sends:
  // a queued inbox message never touches a PTY and cannot interrupt a turn, so it auto-allows,
  // while `send_to_agent_terminal` stays `disruptive` and asks. That asymmetry is what makes the
  // non-interrupting channel the path of least resistance — and Level 3 correspondingly rare.
  ...translateRisk(FLEET_RISK, WORKSPACE_RISK_TO_CLASS),
  // Research publishes two of workspace's four risk words, so it reuses that translation. Both
  // `dispatch` and `cancel` are `routine` and therefore auto-allowed, which is the FOUNDER'S
  // EXPLICIT CALL ("no cap, trust the concierge") rather than a default nobody looked at —
  // research.ts's header records the reasoning, including why `dispatch` is not `costs-money` and
  // why `cancel` is not the `disruptive` that RISK_OVERRIDES gives close_agent/stop_agent.
  ...translateRisk(RESEARCH_RISK, WORKSPACE_RISK_TO_CLASS),
  ...TERMINAL_TOOL_RISK,
  // The attachments domain publishes the same four risk words as workspace, so it reuses that
  // translation rather than declaring a fifth identical one.
  ...translateRisk(ATTACHMENTS_RISK, WORKSPACE_RISK_TO_CLASS),
  ...APP_TOOL_RISK,
  // LAST, so a cross-domain correction wins over the domain's own word. See RISK_OVERRIDES.
  ...RISK_OVERRIDES,
};

// ---------------------------------------------------------------------------------------------
// PER-CALL RISK — the one place a tool's danger lives in its ARGUMENTS, not in its name
// ---------------------------------------------------------------------------------------------

/**
 * Risk that depends on WHAT WAS ASKED FOR, not on which tool was asked for.
 *
 * Everything above this comment keys risk off the op NAME, and that is right for nearly the whole
 * catalog: `merge_pr` is `mutates-main` on every call anyone will ever make. `RISK_OVERRIDES` bends
 * that by name too — it corrects a domain's vocabulary, it does not look at a call.
 *
 * `search_history` is the exception, and it is worth stating why it is an exception rather than the
 * start of a pattern. Its two modes are not two degrees of the same thing: the default searches
 * BUILD history — logs, prompts, agent chatter, regenerable and unremarkable — while
 * `scope: "all"` additionally reaches `concierge`-sourced rows, which are to hold the founder's own
 * private conversations with his minder (services/history.ts's `HistorySource`). The founder's
 * explicit decision is that those must be RECORDED and findable by him while NOT being something
 * the model can silently vacuum up. One op, two genuinely different questions to put to a human.
 *
 * (The RECORDING half has since landed — `services/conciergeHistoryCapture.ts`. The gate went first
 * so the rows were never readable without one; conciergeTools/workspace.ts's `HistorySearchScope`
 * lists the two constraints that half had to satisfy, and records that it does.)
 *
 * WHY IT CANNOT BE SOLVED BY SPLITTING THE OP IN TWO. A `search_all_history` sibling would key off
 * the name again and would be the tidier shape — but the model chooses which tool it calls, so the
 * gate would be exactly as strong as the model's willingness to pick the gated name, i.e. not a
 * gate. The argument is what the model actually sends, so the argument is what has to be inspected.
 *
 * WHY IT CANNOT BE SOLVED IN THE ALLOWLIST EITHER. `src-tauri/src/concierge.rs` records, measured
 * against Claude Code 2.1.220, that `--allowedTools` does NOT gate MCP tools; the `controlListener`
 * policy — this module, through policyBinding — is the only real gate on this surface.
 *
 * SHAPE. A table keyed by `ConciergeToolName`, so the day someone renames the op this stops
 * compiling instead of silently going quiet. `args` arrives RAW and UNVALIDATED (the policy is
 * consulted before the registry's zod runs, deliberately — a denial must not leak which arguments
 * it would have wanted), so every reader here has to be total over arbitrary JSON, and anything it
 * cannot positively recognise as the wider request escalates NOTHING and falls through to the
 * name-keyed class. That is safe in this direction only because the narrow default is the one that
 * does not need a card; a mis-parse cannot hand out MORE than the name-keyed risk, and the
 * registry's `.strict()` schema refuses the malformed call a moment later anyway.
 *
 * IT IS A FLOOR, NOT JUST A DEFAULT — an `allow` cannot cover an escalated call (roborev 61894-H1).
 *
 * The first cut escalated only the DERIVED DEFAULT, on the reasoning that a standing "yes" is the
 * one thing this module treats as the human's to give. That was wrong here, and the reason is worth
 * keeping because it generalises: the consent was never obtained for the wide case.
 *
 *   • The bulk "Allow every concierge tool?" dialog (`components/ConciergeToolsPane.tsx`) warns
 *     about the privacy axis by DERIVING the names from `riskClass === "privacy-sensitive"` in the
 *     CATALOG — and this op's catalog class is `read-only` on purpose (see `WORKSPACE_TOOL_SUMMARY`
 *     and workspace.ts). So it is invisible to that warning by construction: one click would have
 *     handed over unprompted reads of the founder's private conversations while the dialog named
 *     only screen capture.
 *   • The row's own summary says the wide scope asks first. A human setting Allow after reading
 *     that has consented under a description an `allow`-beats-everything rule would have voided.
 *
 * So an `allow` covers the DEFAULT scope — the common case, and what someone setting that row is
 * actually asking for — and `scope: "all"` still asks. `deny` is unaffected: tightening is always
 * the human's, and `ask` is not the ceiling. This costs a real thing (there is now no way to say
 * "never ask me about reading my own history"), and that is the founder's stated priority: the
 * model must not be able to vacuum those rows silently, and one click on an approval card is the
 * price of the wide read.
 *
 * Returns null for "no per-call opinion", which is the answer for every tool but one.
 */
const PER_CALL_RISK: Partial<
  Record<ConciergeToolName, (args: unknown) => ConciergeRiskClass | null>
> = {
  search_history: (args) => {
    if (!args || typeof args !== "object") return null;
    // `WIDE_HISTORY_SCOPE` is the only value that widens what is read. Anything else — omitted,
    // `"default"`, a typo, a number, an array — is the narrow search, which is also what the
    // registry will accept or refuse on its own terms.
    //
    // COMPARED AGAINST THE SHARED CONSTANT, NOT A LITERAL, and that is load-bearing: `args` is
    // `unknown` here, so this comparison has no typecheck coupling to the scope union at all.
    // Re-spelling the value would fail to compile in the zod enum and the filter, but would leave
    // THIS test silently false — and a silently-false escalation means the widened read of the
    // user's own conversations runs as an auto-allowed `read-only` call with no approval card. The
    // failure is silent and in the permissive direction, which is the worst pair.
    return (args as { scope?: unknown }).scope === WIDE_HISTORY_SCOPE ? "privacy-sensitive" : null;
  },
};

/**
 * The per-call escalation for one call, or null when this call's risk is fully described by its
 * name. Exported so the binding and the tests can ask the question without reimplementing it.
 */
export function perCallRiskFor(toolName: string, args: unknown): ConciergeRiskClass | null {
  if (!isConciergeToolName(toolName)) return null;
  return PER_CALL_RISK[toolName]?.(args) ?? null;
}

/** The risk class that actually governs ONE call: its per-call escalation if it has one, otherwise
 *  the name-keyed classification. The single place the two are combined. */
function riskForCall(toolName: ConciergeToolName, args: unknown): ConciergeRiskClass {
  return perCallRiskFor(toolName, args) ?? RISK_BY_TOOL[toolName];
}

/** Which domain each tool belongs to. Total for the same structural reason as `RISK_BY_TOOL`. */
const DOMAIN_BY_TOOL: Record<ConciergeToolName, ConciergeToolDomain> = {
  ...constantOver(LIFECYCLE_RISK, "lifecycle" as const),
  ...constantOver(REVIEW_RISK, "review" as const),
  ...constantOver(WORKSPACE_OP_RISK, "workspace" as const),
  ...constantOver(SCREENSHOT_RISK, "screenshot" as const),
  ...constantOver(WORKFLOW_OP_RISK, "workflow" as const),
  ...constantOver(EVENTS_RISK, "events" as const),
  ...constantOver(TERMINAL_TOOL_RISK, "terminal" as const),
  ...constantOver(ATTACHMENTS_RISK, "attachments" as const),
  ...constantOver(BOARD_RISK, "board" as const),
  ...constantOver(APPROVALS_RISK, "approvals" as const),
  ...constantOver(PLANS_RISK, "plans" as const),
  ...constantOver(DIFF_RISK, "diff" as const),
  ...constantOver(FLEET_RISK, "fleet" as const),
  ...constantOver(RESEARCH_RISK, "research" as const),
  ...constantOver(ACCOUNTS_RISK, "accounts" as const),
  ...constantOver(APP_TOOL_RISK, "app" as const),
};

/** Per-tool one-liners, where the domain offers one. Partial on purpose: the lifecycle and
 *  workspace domains classify risk but publish no per-op prose, and inventing a sentence per op
 *  here would be a second description that drifts from the code it describes. Those rows fall back
 *  to the risk note, which is a fact the domain DID publish. */
// EXPORTED FOR ITS GUARD (roborev 61938/61960). Every line below is a spread on a block of adjacent
// lines that has already been a merge conflict once and was resolved by hand. Dropping any one of
// them is SILENT: `entryFor` falls back to `CONCIERGE_RISK_NOTE[riskClass]`, so the rows survive and
// merely lose their prose, and a "summary is non-empty" check is satisfied by that fallback. The
// screenshot rows are the worst case — they are `privacy-sensitive`, and their whole reason for
// having prose is that a generic risk note is the wrong headline on a consent card.
//
// `policy.test.ts` asserts every entry here reaches the catalog verbatim, so losing ANY spread goes
// red — rather than one test per domain, which leaves the next domain unguarded until someone
// remembers this file.
export const SUMMARY_BY_TOOL: Partial<Record<ConciergeToolName, string>> = {
  ...RESEARCH_TOOL_SUMMARY,
  ...WORKSPACE_TOOL_SUMMARY,
  ...SCREENSHOT_TOOL_SUMMARY,
  ...TERMINAL_TOOL_SUMMARY,
  ...ATTACHMENTS_TOOL_SUMMARY,
  ...APP_TOOL_SUMMARY,
  ...ACCOUNTS_TOOL_SUMMARY,
  ...Object.fromEntries(WORKFLOW_OPERATIONS.map((op) => [op, WORKFLOW_RISK[op].summary])),
};

/** The names, grouped by domain, in each domain's own declared order. */
const NAMES_BY_DOMAIN: Record<ConciergeToolDomain, readonly ConciergeToolName[]> = {
  lifecycle: LIFECYCLE_OPS,
  review: REVIEW_OPS,
  terminal: TERMINAL_TOOL_NAMES,
  attachments: ATTACHMENTS_OPS,
  workflow: WORKFLOW_OPERATIONS,
  events: EVENTS_OPS,
  workspace: WORKSPACE_OPS,
  screenshot: SCREENSHOT_OPS,
  board: BOARD_OPS,
  approvals: APPROVALS_OPS,
  plans: PLANS_OPS,
  diff: DIFF_OPS,
  fleet: FLEET_OPS,
  research: RESEARCH_OPS,
  accounts: ACCOUNTS_OPS,
  app: APP_TOOL_NAMES,
};

// ---------------------------------------------------------------------------------------------
// Derived defaults
// ---------------------------------------------------------------------------------------------

/**
 * THE default table — one decision per risk class, and the only place a default is decided.
 *
 * `deny` never appears, and that is deliberate rather than an omission: refusing outright is a
 * standing instruction from the human ("the concierge may never merge a PR"), and Sparkle has no
 * business inferring one on their behalf. The strictest thing a derived default does is stop and
 * ask. Turning a tool off entirely stays an explicit act.
 */
export const DEFAULT_DECISION_BY_RISK: Record<ConciergeRiskClass, PolicyDecision> = {
  // Nothing changes, so there is nothing to approve.
  "read-only": "allow",
  // Local, reversible, one click from undone — the concierge doing this unprompted is the point.
  routine: "allow",
  // THE ONE `ask` THAT IS NOT ABOUT CONSEQUENCES. A screen capture changes nothing and destroys
  // nothing; it is gated because of what it can SEE. `read-only` would be true on the letter and
  // would derive to `allow`, which is how "the concierge may photograph my screen whenever it
  // likes" becomes a default nobody chose. See conciergeTools/screenshot.ts.
  "privacy-sensitive": "ask",
  // Everything below interrupts work, spends money, publishes, or destroys. The human rules on it.
  disruptive: "ask",
  "rewrites-branch": "ask",
  "outward-facing": "ask",
  "costs-money": "ask",
  "mutates-main": "ask",
  irreversible: "ask",
};

/** The decision that applies to a tool with no explicit config entry. Total over the tool union. */
export function defaultDecisionFor(tool: ConciergeToolName): PolicyDecision {
  return DEFAULT_DECISION_BY_RISK[RISK_BY_TOOL[tool]];
}

/** Is this string a tool this module has a classification for? */
export function isConciergeToolName(name: string): name is ConciergeToolName {
  return Object.prototype.hasOwnProperty.call(RISK_BY_TOOL, name);
}

// ---------------------------------------------------------------------------------------------
// The catalog (what the settings pane renders)
// ---------------------------------------------------------------------------------------------

export interface ConciergeToolEntry {
  name: ConciergeToolName;
  domain: ConciergeToolDomain;
  riskClass: ConciergeRiskClass;
  /** One line describing what the tool does, or the risk note when the domain publishes no prose. */
  summary: string;
  /** What applies with no config entry — shown so the pane can mark a row "default". */
  defaultDecision: PolicyDecision;
  /** The dotted config path the settings control writes. */
  configPath: string;
}

/** The dotted `config.toml` path of the TABLE every per-tool rule lives in.
 *
 *  Named separately from the per-tool paths below because clearing every rule at once is one
 *  `unset` of this table rather than N unsets of its keys — and that difference is not cosmetic.
 *  Each write emits a `config-changed`, so N unsets would let a mid-bulk hydrate read a
 *  half-cleared file and revert the keys not yet written (the same flicker `set_values` exists to
 *  avoid). Removing the table also takes hand-edited keys naming no tool with it, which is what
 *  "reset everything to defaults" has to mean if it is to be believed. `[concierge]` holds nothing
 *  else — see ConciergeConfig in config.rs — so this removes exactly the policy and nothing more. */
export const CONCIERGE_TOOLS_CONFIG_TABLE = "concierge.tools";

/** The dotted `config.toml` path for one tool's rule (`[concierge.tools]`). */
export function conciergeToolConfigPath(tool: string): string {
  return `${CONCIERGE_TOOLS_CONFIG_TABLE}.${tool}`;
}

function entryFor(name: ConciergeToolName, domain: ConciergeToolDomain): ConciergeToolEntry {
  const riskClass = RISK_BY_TOOL[name];
  return {
    name,
    domain,
    riskClass,
    summary: SUMMARY_BY_TOOL[name] ?? CONCIERGE_RISK_NOTE[riskClass],
    defaultDecision: DEFAULT_DECISION_BY_RISK[riskClass],
    configPath: conciergeToolConfigPath(name),
  };
}

/** Every tool, grouped by domain in the pane's order — the pane renders this directly. */
export const CONCIERGE_TOOL_GROUPS: readonly {
  domain: ConciergeToolDomain;
  label: string;
  tools: readonly ConciergeToolEntry[];
}[] = CONCIERGE_TOOL_DOMAINS.map(({ id, label }) => ({
  domain: id,
  label,
  tools: NAMES_BY_DOMAIN[id].map((name) => entryFor(name, id)),
}));

/** Every tool, flattened. Domain order, then each domain's own declared order. */
export const CONCIERGE_TOOL_CATALOG: readonly ConciergeToolEntry[] = CONCIERGE_TOOL_GROUPS.flatMap(
  (g) => g.tools,
);

/** Every tool name. */
export const CONCIERGE_TOOL_NAMES: readonly ConciergeToolName[] = CONCIERGE_TOOL_CATALOG.map(
  (t) => t.name,
);

// ---------------------------------------------------------------------------------------------
// The decision function — THE contract
// ---------------------------------------------------------------------------------------------

/**
 * The human's explicit per-tool rules, as they came from `[concierge.tools]` in config.toml.
 *
 * Keyed by plain `string`, not `ConciergeToolName`, because this is a HAND-EDITED FILE: a user can
 * type a key that names no tool, and the type has to be able to hold what the file can hold. Values
 * are equally untrusted — `evaluateToolPolicy` narrows them, and an unreadable one is a distinct
 * outcome rather than a silent fall-back to the default (see the header, property 2).
 *
 * An ABSENT key is the normal case, not a gap: it means "use the derived default", which is why the
 * config file stays short and why a key nobody wrote can never be a policy hole.
 */
export type ToolPolicyOverrides = Readonly<Record<string, string | null | undefined>>;

/** The empty table — no explicit rules, everything on its derived default. */
export const NO_TOOL_POLICY_OVERRIDES: ToolPolicyOverrides = Object.freeze({});

/**
 * Everything the decision needs, as explicit parameters. Pure by construction: this module reads no
 * store and performs no IO, so whatever the call site knows has to arrive here.
 */
export interface ToolPolicyContext {
  /** The human's explicit rules. Pass `NO_TOOL_POLICY_OVERRIDES` when there are none. */
  readonly overrides: ToolPolicyOverrides;
  /**
   * Are AI enhancements live for the concierge (bead sparkle-4562)?
   *
   * `false` refuses EVERY tool before any other rule is consulted, because with the gate off the
   * concierge has no brain to reach them with — a `claude -p` turn is what drives this surface and
   * that is exactly what the gate turns off. This is deliberately not expressed as fifty `deny`
   * overrides: it is ONE fact with ONE remedy, and a caller (or a settings pane) that can see
   * `source: "ai-disabled"` can say so once instead of fifty times.
   *
   * It also covers a build compiled from the open-source repo with no Sparkle backend: there is no
   * signed-in `me`, so the binding's gate read is false and every tool refuses for this reason,
   * with no separate open-source code path to keep in step.
   *
   * Optional and defaulting to ON so every existing caller and test keeps its meaning; the binding
   * that talks to the stores is what actually supplies it.
   */
  readonly aiEnabled?: boolean;
  /**
   * The model's RAW, UNVALIDATED arguments for this call, when the caller has them.
   *
   * Read by exactly one thing — {@link perCallRiskFor} — and only to answer "is this the wider
   * request?" for the one op whose risk lives in its arguments. Nothing here reads a `confirm`
   * flag or any other model-supplied consent: those arrive inside the model's own arguments, so
   * treating one as permission would let the model approve itself.
   *
   * OPTIONAL, and its absence means "no per-call opinion", never "assume the narrow call". That
   * distinction is what keeps the settings pane honest: the pane asks about a TOOL, not a call, and
   * it must keep rendering `search_history` as the `read-only` row it is by default rather than as
   * a permanently-asking one.
   */
  readonly args?: unknown;
}

/** Where a decision came from — the pane shows it, and the concierge can say it out loud. */
export type ToolPolicySource =
  /** The human set this tool explicitly in `[concierge.tools]`. */
  | "override"
  /** No entry; resolved through the tool's risk class. */
  | "default"
  /** An entry exists but is not one of allow/ask/deny — resolved to `ask`, never to the default. */
  | "unreadable-override"
  /** The human allowed this tool, but THIS CALL asked for something their `allow` does not cover —
   *  resolved to `ask`. Only `perCallRiskFor` produces this; see it for why an `allow` is a
   *  statement about the tool's ordinary use and not about the escalated call. */
  | "per-call-escalation"
  /** No classification for this name at all. Resolved to `deny`; see the header, property 2. */
  | "unclassified"
  /** AI enhancements are off for the concierge, so nothing can run regardless of the rules. */
  | "ai-disabled";

export interface ToolPolicyEvaluation {
  /** The name as asked about, verbatim — including a name that resolved `unclassified`. */
  tool: string;
  decision: PolicyDecision;
  source: ToolPolicySource;
  /** One sentence, fit to show the human or hand to the model. */
  reason: string;
  /** Null only for an unclassified name — there is no risk class to report. */
  riskClass: ConciergeRiskClass | null;
  domain: ConciergeToolDomain | null;
  /** What would apply with no override. Null for an unclassified name. */
  defaultDecision: PolicyDecision | null;
  /** True when a config entry (readable or not) governed this, rather than the derived default. */
  overridden: boolean;
  /** Convenience mirror of `decision === "ask"`, so a caller can gate on one boolean. */
  requiresConfirmation: boolean;
}

/**
 * Decide what the concierge may do with one tool. PURE and SYNCHRONOUS — no store reads, no IO, no
 * React. The signature is the contract; the call site is owned elsewhere.
 *
 * TOTAL over every input: any string is answerable, because a tool name can arrive from a model
 * turn or an older build, and "I don't know" has to be a decision rather than a thrown error.
 *
 *   evaluateToolPolicy("merge_pr", { overrides: {} })
 *     → { decision: "ask", riskClass: "mutates-main", source: "default", … }
 *   evaluateToolPolicy("merge_pr", { overrides: { merge_pr: "deny" } })
 *     → { decision: "deny", source: "override", … }
 *   evaluateToolPolicy("teleport_agent", { overrides: {} })
 *     → { decision: "deny", source: "unclassified", riskClass: null, … }
 *
 * `ctx.args` is consulted ONLY by `perCallRiskFor`, and today only for `search_history`:
 *
 *   evaluateToolPolicy("search_history", { overrides: {} })
 *     → { decision: "allow", riskClass: "read-only", … }
 *   evaluateToolPolicy("search_history", { overrides: {}, args: { query: "x", scope: "all" } })
 *     → { decision: "ask",   riskClass: "privacy-sensitive", … }
 */
export function evaluateToolPolicy(
  toolName: string,
  ctx: ToolPolicyContext,
): ToolPolicyEvaluation {
  // THE AI-ENHANCEMENTS GATE, checked first — before classification, overrides and defaults alike.
  // With the gate off there is no concierge turn to invoke a tool, so reporting anything other than
  // "off" would describe a rule that cannot be reached. Note it deliberately does NOT clear the
  // human's saved rules: `overridden` still reflects whether they set one, so their configuration
  // survives switching enhancements off and back on.
  if (ctx.aiEnabled === false) {
    const known = isConciergeToolName(toolName);
    return {
      tool: toolName,
      decision: "deny",
      source: "ai-disabled",
      reason:
        "AI enhancements are off, so the concierge can't run tools. Turn them on to let it act for you.",
      riskClass: known ? riskForCall(toolName, ctx.args) : null,
      domain: known ? DOMAIN_BY_TOOL[toolName] : null,
      defaultDecision: known ? DEFAULT_DECISION_BY_RISK[riskForCall(toolName, ctx.args)] : null,
      overridden: asPolicyDecision(ctx.overrides[toolName]) !== null,
      requiresConfirmation: false,
    };
  }
  if (!isConciergeToolName(toolName)) {
    // Fail CLOSED. This is unreachable for a real tool (property 3 makes it a compile error), so
    // reaching it means a bug or a name from somewhere we don't control — neither is a thing to
    // hand a human an approval prompt about.
    return {
      tool: toolName,
      decision: "deny",
      source: "unclassified",
      reason: `“${toolName}” is not a concierge tool this build knows how to classify, so it is refused.`,
      riskClass: null,
      domain: null,
      defaultDecision: null,
      overridden: false,
      requiresConfirmation: false,
    };
  }

  // THE CALL'S risk, not merely the op's — see `perCallRiskFor`. Identical to `RISK_BY_TOOL` for
  // every tool but `search_history`, and identical for that one too unless this call asked for
  // `scope: "all"`. Everything downstream (the derived default, the reason sentence, the risk note
  // on the approval card) reads from here, so the human is told about the call they are being asked
  // to rule on rather than about the op in the abstract.
  const riskClass = riskForCall(toolName, ctx.args);
  const domain = DOMAIN_BY_TOOL[toolName];
  const defaultDecision = DEFAULT_DECISION_BY_RISK[riskClass];
  const raw = ctx.overrides[toolName];

  // Absent (or explicitly cleared) — the derived default, which is total over the risk class.
  if (raw === undefined || raw === null) {
    return {
      tool: toolName,
      decision: defaultDecision,
      source: "default",
      reason:
        defaultDecision === "allow"
          ? `No rule set; allowed by default because it is ${riskClass}. ${CONCIERGE_RISK_NOTE[riskClass]}`
          : `No rule set; asks first by default because it is ${riskClass}. ${CONCIERGE_RISK_NOTE[riskClass]}`,
      riskClass,
      domain,
      defaultDecision,
      overridden: false,
      requiresConfirmation: defaultDecision === "ask",
    };
  }

  const parsed = asPolicyDecision(raw);
  if (parsed === null) {
    // A value we cannot read is NOT the same as no value. Falling back to the default here would
    // silently restore `allow` on a tool whose typo'd entry was an attempt to take it away.
    return {
      tool: toolName,
      decision: "ask",
      source: "unreadable-override",
      reason: `The rule for “${toolName}” in config.toml is “${String(raw)}”, which is not allow, ask, or deny — asking first until it is fixed.`,
      riskClass,
      domain,
      defaultDecision,
      overridden: true,
      requiresConfirmation: true,
    };
  }

  // AN `allow` DOES NOT COVER AN ESCALATED CALL. The human's rule is a statement about the tool's
  // ordinary use — and for the one op with a per-call rule, the escalated call is by construction
  // not what they were shown when they set it. See `perCallRiskFor`. `deny` and `ask` fall through
  // untouched: tightening is always the human's, and this only ever tightens.
  if (parsed === "allow" && perCallRiskFor(toolName, ctx.args) !== null) {
    return {
      tool: toolName,
      decision: "ask",
      source: "per-call-escalation",
      reason: `You allowed “${toolName}”, but this call is ${riskClass}, which that rule doesn't cover. ${CONCIERGE_RISK_NOTE[riskClass]} Asking about this one.`,
      riskClass,
      domain,
      defaultDecision,
      overridden: true,
      requiresConfirmation: true,
    };
  }

  return {
    tool: toolName,
    decision: parsed,
    source: "override",
    reason:
      parsed === "allow"
        ? `You allowed this (${riskClass}). ${CONCIERGE_RISK_NOTE[riskClass]}`
        : parsed === "ask"
          ? `You asked to approve this each time (${riskClass}). ${CONCIERGE_RISK_NOTE[riskClass]}`
          : `You turned this off (${riskClass}). ${CONCIERGE_RISK_NOTE[riskClass]}`,
    riskClass,
    domain,
    defaultDecision,
    overridden: true,
    requiresConfirmation: parsed === "ask",
  };
}

/**
 * Narrow a raw `[concierge.tools]` payload (or any untyped object) into a `ToolPolicyOverrides`,
 * dropping non-string values. Values are NOT validated here — `evaluateToolPolicy` owns what an
 * unrecognized string means, and dropping it at the door would erase the distinction between "the
 * user typo'd a rule" and "the user set no rule", which is exactly the distinction that keeps a
 * typo from handing back `allow`.
 */
export function toToolPolicyOverrides(raw: unknown): ToolPolicyOverrides {
  if (!raw || typeof raw !== "object") return NO_TOOL_POLICY_OVERRIDES;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
