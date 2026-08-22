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
import { PREVIEW_INSPECT_OPS, PREVIEW_INSPECT_RISK, type PreviewInspectOp } from "./previewInspect";
import { RESEARCH_OPS, RESEARCH_RISK, type ResearchOp } from "./research";
import { MEMORY_OPS, MEMORY_RISK, type MemoryOp } from "./memory";
// `PublishRisk` is deliberately NOT imported: publishing reuses WORKSPACE's four risk words
// verbatim, and `translateRisk(PUBLISH_RISK, WORKSPACE_RISK_TO_CLASS)` already fails to compile if
// publish.ts ever adds a fifth — the vocabulary check is structural, not an annotation.
import { PUBLISH_OPS, PUBLISH_RISK, type PublishOp } from "./publish";
import {
  CHIEF_OPS,
  CHIEF_RISK,
  chiefCallToolName,
  type ChiefOp,
} from "./chief";
// The DESTRUCTIVE-VERB predicate, read by `PER_CALL_RISK`'s `chief_call` floor. chiefScope.ts is a
// pure module that imports nothing, so this adds no cycle and no IO to a module whose purity is a
// stated property.
import { isDestructiveChiefTool } from "../chiefScope";
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
  // WIDENED FOR `publish` (bead `sparkle-131ms.6`). This sentence RENDERS ON THE APPROVAL CARD,
  // and it used to name only the two git cases — so after publishing landed it would have
  // described posting to the founder's public site as "a pull request". This repo's rule: a
  // change to WHEN something happens must update every string that described the old behaviour.
  // (The two public publish ops are classed `irreversible`, not `outward-facing` — see
  // publish.ts for why — but `publish_take_down` and any future outward publish op land here.)
  "outward-facing": "Reaches the outside world — a push, a pull request, or a post on your own site.",
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
  | "preview_inspect"
  | "board"
  | "approvals"
  | "plans"
  | "diff"
  | "fleet"
  | "research"
  | "chief"
  | "accounts"
  | "memory"
  | "publish"
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
  { id: "preview_inspect", label: "Preview inspection" },
  { id: "board", label: "Tasks & work graph" },
  { id: "approvals", label: "Approvals" },
  { id: "plans", label: "Plans" },
  { id: "diff", label: "Diff" },
  { id: "fleet", label: "Fleet awareness" },
  { id: "research", label: "Background research" },
  { id: "chief", label: "Chief (client work)" },
  { id: "accounts", label: "Claude accounts" },
  { id: "memory", label: "Durable memory" },
  { id: "publish", label: "Publishing" },
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
  "set_agent_landed",
  "set_agent_escalation",
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
  // ROUTINE, same class and same reasoning: one short field about who did what, written by the only
  // party that can know it. Nothing is destructive and nothing reaches a repo — the stamp is a
  // POINTER (`owner/repo#N`) whose whole value is that a human can check it in one click, and it is
  // cleared by one more call. What it changes is where a row files on the ladder, which is a
  // statement the app was previously making WRONGLY on its own (bead `sparkle-pgh1ue`).
  set_agent_landed: "routine",
  // ROUTINE — reclassified from `irreversible` on 2026-08-13 by founder ruling, and the reasoning
  // is worth keeping because the original class was defensible and still lost.
  //
  // The old argument: clearing an escalation takes work OFF A HUMAN'S PLATE, spends one of an
  // allowance only they can refill, and restarts a token-spending retry loop. True, and it derived
  // to `ask`. THAT IS THE DEFECT. `irreversible` → `ask` meant the one lever built so a machine
  // could unstick a stalled agent could not fire unless a human was awake to approve it — which is
  // precisely the situation it exists to end. Measured: nine goals escalated simultaneously, some
  // of them false, and nothing but the founder could touch any of them. An autonomy lever gated on
  // the attention it was built to save is not a lever.
  //
  // WHAT REPLACES THE CARD IS THE BOUND, NOT TRUST, and the bound was always the real guard:
  // `MAX_CONCIERGE_REARMS` caps this at two per goal; the third refusal re-notifies the human
  // rather than failing quietly; `resetGoalRetries` — reachable only by a human typing — is the
  // only thing that refills the allowance, which keeps the human strictly stronger by construction.
  // A per-use approval card added nothing to that except a human in the loop at 3am.
  //
  // The one genuinely non-reversible part is the allowance decrement, and that is the DESIGNED
  // cost of the lever rather than a hazard it exposes: spending it is how the bound is enforced.
  // Everything else is local, touches no repo, bills nothing, and a raise puts the escalation
  // straight back in front of the human. Unlike `set_config` — which keeps `irreversible` because
  // it overstates recoverability on purpose — the recoverability here is not overstated.
  //
  // A human who disagrees sets this tool to Ask in Settings → Concierge tools; the override is
  // tested. This changes a DEFAULT, not the availability of the control.
  set_agent_escalation: "routine",
  claim_pr: "routine",
  release_pr: "routine",
};

const APP_TOOL_SUMMARY: Record<AppToolName, string> = {
  get_state: "Read the agent roster and the current theme.",
  get_config: "Read Sparkle's workflow and worker settings.",
  rename_agent: "Rename an agent.",
  set_agent_activity: "Update an agent's one-line activity caption.",
  set_agent_landed: "Record which repository and pull request an agent's work landed in.",
  set_theme: "Switch the app between light and dark.",
  set_zoom: "Change the terminal text size.",
  navigate: "Move you to a view or open a specific agent.",
  set_agent_model: "Change which Claude model an agent runs on.",
  append_communication_guideline: "Save a rule about how Sparkle should talk to you.",
  set_config: "Write Sparkle's machine-wide configuration.",
  set_agent_goal: "Set an agent's current objective (what it is trying to finish).",
  set_agent_goal_met: "Mark a stalled-but-finished agent's goal met — the only thing that makes an idle agent count as done.",
  set_agent_escalation: "Hand an agent to you, or put one back to work after auto-continue gave up on it (twice at most).",
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
/**
 * The memory domain's rows — and, like research's, a summary is REQUIRED rather than nice to have.
 * `remember`/`recall`/`forget`/`list` are among the most generic op names in the catalog, and the
 * risk-note fallback ("Local and reversible.") tells the human nothing about what is being stored or
 * where. Each row says what it does AND that this is the concierge's OWN durable, searchable memory.
 */
const MEMORY_TOOL_SUMMARY: Record<MemoryOp, string> = {
  remember: "Save a durable fact to the concierge's own memory, so it survives past the chat window.",
  recall: "Search the concierge's saved memory for a keyword or phrase.",
  forget: "Drop one saved memory by its key.",
  list_memories: "List everything the concierge has saved to its durable memory.",
};

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

/**
 * The Chief domain's rows — and like research's, a summary is REQUIRED rather than nice to have.
 *
 * Two reasons, both about the human at the settings pane. First, the risk-note fallback for a read
 * is "Observes only — changes nothing", which is true and tells them nothing about WHOSE data is
 * being read: Chief holds live client work, and that is the entire fact someone deciding to gate
 * these rows needs. Second, four of these rows are the only tools in the whole catalog that put
 * content in front of a person who is not the user — so each one says where it lands, in words,
 * rather than leaving the `outward-facing` note ("Reaches the outside world (a push or a pull
 * request)") to describe a client message as if it were a git push.
 */
const CHIEF_TOOL_SUMMARY: Record<ChiefOp, string> = {
  chief_list_projects: "List the Chief projects this account can reach — the choice list to ask you from.",
  chief_list_assets: "List the files stored in a Chief project.",
  chief_get_asset: "Read one file out of a Chief project.",
  chief_list_chats: "List a Chief project's conversations.",
  chief_list_messages: "Read the messages in one Chief conversation.",
  chief_list_memories: "Read what Chief remembers about a project.",
  chief_list_skills: "List the skills configured on a Chief project.",
  chief_create_chat: "Start a new conversation in a client's Chief project.",
  chief_send_message: "Post a message into a client's Chief conversation — they will see it.",
  chief_upload_file: "Upload a file into a client's Chief project.",
  chief_create_memory: "Save a note into a Chief project's long-term memory.",
  // The "even if you allow it" clause is load-bearing, exactly as it is on `search_history`: the
  // sentence describes the floor in `PER_CALL_RISK` below, and the two move together or the row is
  // promising something the rule does not keep.
  chief_call:
    "Call any other Chief tool by name — the escape hatch, so it could be anything Chief offers, " +
    "including a write. Naming a Chief tool that DELETES or reconfigures always asks first, even " +
    "if you allow this tool.",
};

/** The attachment domain's rows. Keyed on that domain's own op union, so an op added there is a
 *  typecheck failure here rather than a settings row that silently falls back to a risk note. */
/**
 * The publishing rows — REQUIRED, not nice to have, and exhaustive by construction.
 *
 * WHY EVERY ROW HAS PROSE. `SUMMARY_BY_TOOL` is `Partial<>`, so a missing row is SILENT: `entryFor`
 * falls back to `CONCIERGE_RISK_NOTE[riskClass]` and the settings row survives having merely lost
 * its words. For most domains that is a cosmetic loss. Here it is not — the fallback for the two
 * public acts is "Permanently destroys something that cannot be recovered", which is the WRONG
 * headline on a card asking whether a model may post to the founder's public site. It describes
 * deletion; the thing being consented to is publication. Typed as a total `Record<PublishOp, …>`
 * so an op added without prose fails `tsc`, and `publish.test.ts` asserts every row reaches the
 * catalog verbatim.
 *
 * EACH ROW SAYS WHERE IT LANDS, in words, for the same reason `CHIEF_TOOL_SUMMARY` does: these are
 * the only tools in the catalog whose output is read by strangers.
 */
const PUBLISH_TOOL_SUMMARY: Record<PublishOp, string> = {
  publish_list_destinations:
    "List the places Sparkle is configured to publish to, and which one is active. Reads your " +
    "settings only — it does not contact the site.",
  publish_probe:
    "Ask a publish destination what it can do — which tools it offers and which arguments they " +
    "take — so Sparkle offers only what that site actually supports.",
  publish_list_projects:
    "List the sections of your site a post can be filed under. Required before a draft can be " +
    "created, because the destination has no default.",
  publish_get: "Read one of your posts back from the site, including whether it is still a draft.",
  publish_list: "List your posts on the site.",
  publish_create_draft:
    "Create a DRAFT on your site. The destination makes drafts only — this cannot publish " +
    "anything, and nobody but you can see the result.",
  publish_update_draft:
    "Edit a draft on your site. Editing a post that is already LIVE is refused here and needs " +
    "`publish_update_live`, which always asks first — even if you allow this tool.",
  publish_update_live:
    "Rewrite a post that is ALREADY PUBLIC on your site. People may be reading the old text; the " +
    "new text replaces it the moment this runs.",
  publish_go_live:
    "PUBLISH a draft to your public site. Anyone can read it, and it is scraped, syndicated and " +
    "archived within seconds — taking it down afterwards does not take that back.",
  publish_take_down:
    "Un-publish a live post, turning it back into a draft. Copies already scraped or syndicated " +
    "stay out there.",
};

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
  | PreviewInspectOp
  | BoardOp
  | ApprovalsOp
  | DiffOp
  | PlansOp
  | FleetOp
  | ResearchOp
  | ChiefOp
  | AccountsOp
  | MemoryOp
  | PublishOp
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
  // ── `retire_agent` IS DELIBERATELY ABSENT FROM THIS TABLE ──────────────────────────────────────
  // Not an omission — the one entry worth explaining is the one that ISN'T here. `close_agent` and
  // `spin_down_worker` are raised above because they can stop work IN FLIGHT, which is the property
  // this tier gates on. `retire_agent` cannot, and that is enforced rather than asserted:
  // `engine/retirementPredicate.mayRetire` refuses a dirty worktree, unlanded commits, an unreadable
  // reading of EITHER, and an agent that is still mid-exchange — each from a reading taken live at
  // the moment of the decision rather than from a cache. What survives all of that is an agent that
  // finished, landed, and went quiet, and asking a human to approve tearing that down is what left
  // the founder's fleet at ~78 of 81 slots on 2026-08-12 with nobody awake to click.
  //
  // So it keeps its domain word `routine` and derives to `allow`. THIS IS NOT A HOLE IN THE
  // NAME-KEYED GATE. The module header's worry — that a gate keyed on a tool name is only as strong
  // as the model's willingness to pick the gated name — runs the other way here: choosing
  // `retire_agent` is STRICTLY MORE RESTRICTIVE than choosing `close_agent`, which still asks. There
  // is no laxer path to escape into by picking it.
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
  // preview_inspect publishes ONLY `read-only` — a member of workspace's vocabulary — so it reuses
  // that translation rather than declaring a second one-entry table. See previewInspect.ts's header
  // for why this reads an agent's own dev-server output rather than the human's screen, and so is
  // NOT `privacy-sensitive` the way the screenshot domain's rows are.
  ...translateRisk(PREVIEW_INSPECT_RISK, WORKSPACE_RISK_TO_CLASS),
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
  // Memory publishes two of workspace's four risk words. `remember`/`forget` are `routine` and
  // auto-allow — the whole point is that the concierge accumulates durable context without the
  // human approving each fact; `recall`/`list` are `read-only`. See memory.ts.
  ...translateRisk(MEMORY_RISK, WORKSPACE_RISK_TO_CLASS),
  // Publishing reuses WORKSPACE's four words exactly, so it reuses that translation rather than
  // declaring a table identical to it. The load-bearing rows are the two `irreversible` ones —
  // `publish_update_live` and `publish_go_live` — and publish.ts records at length why that word
  // and not `outward-facing`: `ConciergeToolsPane` derives its bulk-allow warnings from
  // `irreversible` and `privacy-sensitive` and reads `outward-facing` NOWHERE, so an
  // `outward-facing` publish op would be invisible to the one dialog that exists to name what a
  // single click is about to hand over.
  ...translateRisk(PUBLISH_RISK, WORKSPACE_RISK_TO_CLASS),
  // Chief publishes two of WORKFLOW's five risk words, so it reuses that translation. The split is
  // the load-bearing part: the seven reads are `read-only` and auto-allow, while the four writes and
  // the `chief_call` hatch are `outward-facing` and ask — because what they write lands in a real
  // client's project, in front of someone who is not the user, and nothing in this app takes it back.
  // See chief.ts for why the hatch is classified by what it COULD name rather than by its usual use.
  ...translateRisk(CHIEF_RISK, WORKFLOW_RISK_TO_CLASS),
  ...TERMINAL_TOOL_RISK,
  // The attachments domain publishes the same four risk words as workspace, so it reuses that
  // translation rather than declaring a fifth identical one.
  ...translateRisk(ATTACHMENTS_RISK, WORKSPACE_RISK_TO_CLASS),
  ...APP_TOOL_RISK,
  // LAST, so a cross-domain correction wins over the domain's own word. See RISK_OVERRIDES.
  ...RISK_OVERRIDES,
};

// ---------------------------------------------------------------------------------------------
// PER-CALL RISK — where a tool's danger lives in its ARGUMENTS, not in its name
// ---------------------------------------------------------------------------------------------

/**
 * Risk that depends on WHAT WAS ASKED FOR, not on which tool was asked for.
 *
 * Everything above this comment keys risk off the op NAME, and that is right for nearly the whole
 * catalog: `merge_pr` is `mutates-main` on every call anyone will ever make. `RISK_OVERRIDES` bends
 * that by name too — it corrects a domain's vocabulary, it does not look at a call.
 *
 * TWO ops are exceptions, and they qualify for the SAME reason rather than by accumulation: the
 * model chooses the argument, and for these two the argument decides which of two genuinely
 * different questions the human is being asked. `search_history` is described below;
 * `chief_call` is described at its entry — it is a hatch that NAMES the verb it wants, so the name
 * it sends is the only thing that says whether the call destroys a client's data. Anything whose
 * danger is knowable from its op name alone does NOT belong here.
 *
 * `search_history` is the older of the two, and it is worth stating why it was an exception rather
 * than the start of a pattern. Its two modes are not two degrees of the same thing: the default searches
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
 * Returns null for "no per-call opinion", which is the answer for every tool but the two below.
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
  // THE SECOND OP WHOSE DANGER IS IN ITS ARGUMENTS, and the reasoning is `search_history`'s exactly
  // (roborev 63041, Medium). `chief_call` names an ARBITRARY upstream tool, and it is the ONLY route
  // the concierge has to Chief's destructive verbs — `checkChiefTool` returns `{ok:true}`
  // unconditionally for a concierge caller, by design, because the founder's model is that a
  // destructive Chief act is something the HUMAN does from the concierge. That design puts the whole
  // weight on this layer: with the hatch classified `outward-facing` by name alone, one
  // `[concierge.tools] chief_call = "allow"` — or one click on "Allow every concierge tool?" — would
  // grant unprompted `chief_call {tool: "delete_chat"}` against a real client's project.
  //
  // The bulk dialog cannot warn about it either: `ConciergeToolsPane` derives its inventory from
  // `riskClass === "irreversible"` in the CATALOG, and the catalog class here is `outward-facing` —
  // the same by-construction blindness that made the `search_history` case a floor rather than a
  // default (roborev 61894-H1).
  //
  // ESCALATING ON MODEL-SUPPLIED ARGUMENTS IS FINE; RELAXING ON THEM IS NOT. chief.ts's header
  // refuses to let the hatch argue its way DOWN to `allow` by naming a read — that would be the model
  // approving itself. This is the opposite direction: an unrecognised, missing or malformed `tool`
  // escalates NOTHING and falls through to the name-keyed `outward-facing` (which already asks), so a
  // mis-parse can never hand out more than the name alone would.
  //
  // Asked of `isDestructiveChiefTool` itself rather than of a copy of its contents, for the reason
  // the block above gives: a rule re-spelled here would go silently false, and silently false in the
  // permissive direction is the worst pair. That predicate is the frozen contract's own answer to
  // "is this verb destructive", so this floor and the build-agent gate can never disagree about a
  // verb — which they DID while this read the bare name set: `update_memory` was `outward-facing`
  // here (an explicit `allow` covered it) at the same time as it became refused there (roborev
  // 63036/63043). It is a structural rule over a name floor, so a destructive verb Chief ships
  // tomorrow escalates without anyone editing a list.
  // THE SHAPE COMES FROM chief.ts AND IS NOT RE-IMPLEMENTED HERE (roborev 63045). The argument key
  // is a constant the registry's schema is meant to be derived from — a floor reading `tool` while
  // the schema shipped `toolName` returns null silently and the `allow` covers the delete again,
  // with every test still green because the fixture would match this reader rather than the
  // producer. Normalization (padding, case, an `mcp__…__` wire prefix) now happens INSIDE the
  // predicate, next to the set it guards.
  chief_call: (args) => {
    const tool = chiefCallToolName(args);
    return tool && isDestructiveChiefTool(tool) ? "irreversible" : null;
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
  ...constantOver(PREVIEW_INSPECT_RISK, "preview_inspect" as const),
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
  ...constantOver(CHIEF_RISK, "chief" as const),
  ...constantOver(ACCOUNTS_RISK, "accounts" as const),
  ...constantOver(MEMORY_RISK, "memory" as const),
  ...constantOver(PUBLISH_RISK, "publish" as const),
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
  ...MEMORY_TOOL_SUMMARY,
  ...WORKSPACE_TOOL_SUMMARY,
  ...SCREENSHOT_TOOL_SUMMARY,
  ...TERMINAL_TOOL_SUMMARY,
  ...ATTACHMENTS_TOOL_SUMMARY,
  ...CHIEF_TOOL_SUMMARY,
  ...APP_TOOL_SUMMARY,
  ...ACCOUNTS_TOOL_SUMMARY,
  ...PUBLISH_TOOL_SUMMARY,
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
  preview_inspect: PREVIEW_INSPECT_OPS,
  board: BOARD_OPS,
  approvals: APPROVALS_OPS,
  plans: PLANS_OPS,
  diff: DIFF_OPS,
  fleet: FLEET_OPS,
  research: RESEARCH_OPS,
  chief: CHIEF_OPS,
  accounts: ACCOUNTS_OPS,
  memory: MEMORY_OPS,
  publish: PUBLISH_OPS,
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

/** The dotted path of the PER-PROJECT policy table (`[concierge.projects]`).
 *
 *  Stored GLOBALLY, keyed by repo slug — never in the repo's own `.sparkle/config.toml`. That is
 *  the existing security boundary in config.rs (`apply_project`'s section allowlist ignores
 *  `[concierge]` from a project file), and it matters most for exactly the repos this feature is
 *  about: a repo we do not own must never get a vote on what Sparkle may do inside it. */
export const CONCIERGE_PROJECTS_CONFIG_TABLE = "concierge.projects";

/** The dotted `config.toml` path for one tool's rule.
 *
 *  With no slug this is the GLOBAL rule (`[concierge.tools]`) and behaves exactly as it always
 *  has — every existing caller passes one argument and is unaffected.
 *
 *  With a slug it is that project's own rule
 *  (`concierge.projects."owner/repo".tools.<tool>`). The quotes are LOAD-BEARING, not decoration:
 *  a slug contains a `/`, and TOML's dotted-key syntax would otherwise read it as two more table
 *  levels. `set_dotted`/`unset_dotted` in config.rs parse the quoted segment as one key. */
export function conciergeToolConfigPath(tool: string, slug?: string | null): string {
  const normalized = normalizeSlug(slug ?? null);
  if (normalized === null) return `${CONCIERGE_TOOLS_CONFIG_TABLE}.${tool}`;
  return `${CONCIERGE_PROJECTS_CONFIG_TABLE}."${normalized}".tools.${tool}`;
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

// ---------------------------------------------------------------------------------------------
// THE STRICTNESS LATTICE — per-project policy (bead sparkle-gylxbo)
// ---------------------------------------------------------------------------------------------
//
// WHY THIS EXISTS. A tool tier used to be ONE GLOBAL NUMBER. The owner of this machine holds
// commit access to repos he does not own, and his standing rule there is that no PR merges without
// a human — while in his OWN repo he wants the concierge to merge a green PR unprompted. A single
// tier cannot hold both facts, so the conflict was being resolved by pinning the global tier to
// `ask`: he was interrupted for every merge in his own repo IN ORDER TO protect a repo he does not
// own. `policy.test.ts`'s "THE GOAL" test is those two facts asserted in one body.
//
// THE ONE ALGORITHM, and there is deliberately only one:
//
//   effective = strictest(base, pinnedFloor, foreignFloor, projectTier)
//
// Every contributor can only RAISE the answer. That single property is the whole security model:
// a project may tighten what the human already granted globally and can never widen it, so a
// hand-edited (or malformed, or hostile) project entry has no permissive direction to fail in.
// Global `deny` + project `allow` is `deny`, and that is its own named test.
//
// FAIL CLOSED IN EVERY DIRECTION. An unreadable project entry is `ask`, never the project's
// default. An unresolvable slug is FOREIGN, which floors merge-class tools at `ask` — we would
// rather ask once than merge in a repo we could not name.

/** allow(0) < ask(1) < deny(2). The rank IS the semantics; nothing else orders the three. */
export const POLICY_STRICTNESS: Readonly<Record<PolicyDecision, number>> = Object.freeze({
  allow: 0,
  ask: 1,
  deny: 2,
});

/** The strictest of the given decisions. No arguments is `allow` — the identity, so a `strictest`
 *  over an empty contributor set adds nothing rather than inventing a refusal. */
export function strictestDecision(...decisions: PolicyDecision[]): PolicyDecision {
  let out: PolicyDecision = "allow";
  for (const d of decisions) if (POLICY_STRICTNESS[d] > POLICY_STRICTNESS[out]) out = d;
  return out;
}

/** Trim + lowercase a slug, rejecting anything that is not exactly `owner/repo`.
 *  GitHub compares slugs case-insensitively, so every comparison in this module lowercases first. */
function normalizeSlug(slug: string | null | undefined): string | null {
  if (typeof slug !== "string") return null;
  // Destructured rather than indexed: under `noUncheckedIndexedAccess` an array read is typed
  // possibly-undefined, and the `!owner || !repo` guard below narrows both halves in one step.
  // `...rest` is what rejects `a/b/c` — a three-part path is not a slug, and guessing at one would
  // point the policy at a repo nobody named.
  const [owner, repo, ...rest] = slug.trim().toLowerCase().split("/");
  if (rest.length > 0) return null;
  if (!owner || !repo) return null;
  return `${owner}/${repo}`;
}

/** The `owner` half of `owner/repo`, lowercased, or null when there isn't one to read. */
export function ownerOfSlug(slug: string | null): string | null {
  const normalized = normalizeSlug(slug);
  return normalized === null ? null : (normalized.split("/")[0] ?? null);
}

/**
 * Is this repo one we do NOT own?
 *
 * NULL IS FOREIGN, and that is the fail-closed rule rather than an edge case. "We could not work
 * out which repo this is" and "this is somebody else's repo" get the same answer, because the
 * expensive mistake in both is the same mistake: merging on somebody else's behalf.
 */
export function isForeignSlug(slug: string | null, ownOrgs: readonly string[]): boolean {
  const owner = ownerOfSlug(slug);
  if (owner === null) return true;
  return !ownOrgs.some((o) => typeof o === "string" && o.trim().toLowerCase() === owner);
}

/**
 * Repos where Sparkle will NEVER merge on its own authority, whatever any config says.
 *
 * A FLOOR COMPILED INTO THE BUILD, not a default: config can tighten past it and nothing can
 * loosen it. That is what makes the owner's standing rule survive a future change to the global
 * default, a reset config file, or a hand-edit. Declared here rather than imported from the JSON so
 * `policy.ts` needs no build-config change (`resolveJsonModule`, bundler asset handling); the test
 * `policy.pinnedRepos.test.ts` reads `shared/merge-protected-repos.json` FROM DISK and pins this
 * list against it, exactly as `worktree.rs` pins `SPARKLE_DENY_RULES` against
 * `destructive-commands.json`. A slug added on one side and forgotten here fails a test.
 */
export const MERGE_PROTECTED_SLUGS: readonly string[] = Object.freeze([
  "plow-pbc/tkmx-client",
  "plow-pbc/tkmx-server",
]);

/** Is this slug on the shipped merge-protected list? A null slug is NOT pinned — it cannot name a
 *  pinned repo — and does not need to be: null is foreign, which floors it at `ask` anyway. */
export function isPinnedMergeProtectedSlug(slug: string | null): boolean {
  const normalized = normalizeSlug(slug);
  return normalized !== null && MERGE_PROTECTED_SLUGS.includes(normalized);
}

/** Per-project context for one call. Supplied by policyBinding; absent in most tests, and its
 *  absence means "no project layer at all" — byte-identical behaviour to before this existed. */
export interface ToolPolicyProjectContext {
  /** `owner/repo`, LOWERCASED. `null` when it could not be resolved — treated as foreign. */
  readonly slug: string | null;
  /** Owner not in `own_orgs`, OR slug is null. Fail-closed. */
  readonly foreign: boolean;
  /** This project's `[concierge.projects."<slug>".tools]` entries. */
  readonly overrides: ToolPolicyOverrides;
}

/**
 * Build the context the evaluator wants from the three raw store values.
 *
 * The one place the "is this foreign?" question is answered, so the binding, the settings pane and
 * the tests cannot each derive it slightly differently.
 */
export function projectPolicyContextFor(
  slug: string | null,
  ownOrgs: readonly string[],
  projectPolicies: Readonly<Record<string, ToolPolicyOverrides>>,
): ToolPolicyProjectContext {
  const normalized = normalizeSlug(slug);
  const overrides =
    (normalized !== null ? projectPolicies[normalized] : undefined) ?? NO_TOOL_POLICY_OVERRIDES;
  return {
    slug: normalized,
    foreign: isForeignSlug(normalized, ownOrgs),
    overrides,
  };
}

/**
 * What the UI shows when it says WHICH TIER IS IN FORCE AND WHERE IT CAME FROM (requirement 3 of
 * the brief). The pane can only show what this returns, so the inherited answer travels alongside
 * the effective one rather than being recomputed — a second computation is the one that drifts.
 *
 * Present ONLY when the caller supplied `ctx.project`, so nothing existing changes shape.
 */
export interface ToolPolicyProjectAttribution {
  slug: string | null;
  foreign: boolean;
  pinned: boolean;
  /** What the tier WOULD be with no project context — i.e. the inherited global answer. */
  inheritedDecision: PolicyDecision;
  inheritedSource: ToolPolicySource;
  /** The project's raw entry verbatim, or null when it set none. */
  projectEntry: string | null;
  /** True when project/pin/foreign made this stricter than the inherited answer. */
  tightened: boolean;
}

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
   * Read by exactly one thing — {@link perCallRiskFor} — and only to ask "is this the wider
   * request?" (`search_history`) or "does this hatch name a destructive verb?" (`chief_call`), for
   * the two ops whose risk lives in their arguments. Nothing here reads a `confirm`
   * flag or any other model-supplied consent: those arrive inside the model's own arguments, so
   * treating one as permission would let the model approve itself.
   *
   * OPTIONAL, and its absence means "no per-call opinion", never "assume the narrow call". That
   * distinction is what keeps the settings pane honest: the pane asks about a TOOL, not a call, and
   * it must keep rendering `search_history` as the `read-only` row it is by default rather than as
   * a permanently-asking one.
   */
  readonly args?: unknown;
  /**
   * WHICH PROJECT this call is about, when the caller knows.
   *
   * OPTIONAL, and its absence is not a gap: a caller with no project gets exactly today's answer,
   * byte for byte. The settings pane asks about a TOOL in the abstract and supplies nothing here;
   * the dispatch binding, which has the call's `root` in hand, supplies it.
   */
  readonly project?: ToolPolicyProjectContext;
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
  | "ai-disabled"
  /** THIS PROJECT'S own rule (`[concierge.projects."owner/repo".tools]`) tightened the global
   *  answer. It can only ever tighten — see {@link applyProjectPolicyLayer}. */
  | "project-override"
  /** This project's rule is not allow/ask/deny. Resolved to `ask`, never to the project's default,
   *  for the same reason `unreadable-override` does not fall back: a typo in a rule someone wrote
   *  to TIGHTEN something must not hand back the looser answer. */
  | "unreadable-project-override"
  /** The repo's owner is not in `[concierge].own_orgs` (or the repo could not be identified at
   *  all), so anything that mutates main is floored at `ask`. */
  | "foreign-repo"
  /** A slug shipped in `shared/merge-protected-repos.json`. Merge-class tools are floored at
   *  `deny` and no config can loosen it. */
  | "pinned-repo";

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
  /** The per-project story, present ONLY when the caller supplied `ctx.project`. This is what the
   *  UI reads to say "denied for THIS repo, though you allowed it globally". */
  project?: ToolPolicyProjectAttribution;
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
 * `ctx.args` is consulted ONLY by `perCallRiskFor`, and today only for `search_history` and
 * `chief_call`:
 *
 *   evaluateToolPolicy("search_history", { overrides: {} })
 *     → { decision: "allow", riskClass: "read-only", … }
 *   evaluateToolPolicy("search_history", { overrides: {}, args: { query: "x", scope: "all" } })
 *     → { decision: "ask",   riskClass: "privacy-sensitive", … }
 *   evaluateToolPolicy("chief_call", { overrides: { chief_call: "allow" },
 *                                      args: { tool: "delete_chat" } })
 *     → { decision: "ask",   riskClass: "irreversible", source: "per-call-escalation", … }
 *
 * The BASE answer — everything above, with no project layer. `evaluateToolPolicy` is this plus the
 * strictness lattice, and the split is what makes "a caller who supplies no project gets exactly
 * today's answer" true by construction rather than by inspection.
 */
function evaluateBaseToolPolicy(
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
  // every tool but the two with per-call rules, and identical for those two as well unless this
  // call asked for the wider thing: `scope: "all"` on `search_history`, or a destructive verb named
  // in `chief_call`'s `tool` argument. Everything downstream (the derived default, the reason
  // sentence, the risk note
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
  // ordinary use — and for the ops with a per-call rule (`search_history`, `chief_call`), the
  // escalated call is by construction not what they were shown when they set it. See `perCallRiskFor`. `deny` and `ask` fall through
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

/**
 * Apply the PER-PROJECT layer on top of a base answer. The whole lattice lives here.
 *
 *   effective = strictest(base, pinnedFloor, foreignFloor, projectTier)
 *
 * Each contributor can only RAISE the answer, which is the entire security property: a project
 * entry saying `allow` under a global `deny` resolves `deny`, and no arrangement of inputs can
 * produce an `allow` the global answer did not already grant.
 *
 * ATTRIBUTION. `source` reports the contributor that DETERMINED the answer — precedence
 * `project-override > pinned-repo > foreign-repo` among contributors whose value equals
 * `effective` — but ONLY when `effective` is strictly stricter than the base. When they agree, the
 * base's own source is kept: the global answer already decided it, and claiming otherwise would
 * tell the human to go and edit a project rule that changed nothing.
 */
function applyProjectPolicyLayer(
  base: ToolPolicyEvaluation,
  toolName: string,
  project: ToolPolicyProjectContext,
): ToolPolicyEvaluation {
  const slug = project.slug;
  const pinned = isPinnedMergeProtectedSlug(slug);
  // BOTH FLOORS ARE SCOPED TO `mutates-main` — deliberately, and it is the reason a foreign repo is
  // still fully usable. Reading its board, driving its terminals and spawning agents in it are
  // unaffected; what is floored is the class that pushes something into somebody else's main.
  const mutatesMain = base.riskClass === "mutates-main";
  const pinnedFloor: PolicyDecision = pinned && mutatesMain ? "deny" : "allow";
  const foreignFloor: PolicyDecision = project.foreign && mutatesMain ? "ask" : "allow";

  const rawEntry = project.overrides[toolName];
  const projectEntry = typeof rawEntry === "string" ? rawEntry : null;
  const parsedEntry = projectEntry === null ? null : asPolicyDecision(projectEntry);
  // An entry we cannot read is `ask`, NOT the absent-entry `allow`. Falling back to "contributes
  // nothing" would let a typo in a rule somebody wrote to TIGHTEN merge rights silently restore
  // the looser global answer — on the exact repo they were protecting.
  const projectTier: PolicyDecision =
    projectEntry === null ? "allow" : (parsedEntry ?? "ask");

  const effective = strictestDecision(base.decision, pinnedFloor, foreignFloor, projectTier);
  const tightened = POLICY_STRICTNESS[effective] > POLICY_STRICTNESS[base.decision];

  const named = slug ?? "this repo (which Sparkle could not identify)";
  let source = base.source;
  let reason = base.reason;
  if (tightened) {
    if (projectEntry !== null && projectTier === effective) {
      if (parsedEntry === null) {
        source = "unreadable-project-override";
        reason = `The rule for “${toolName}” under ${named} in config.toml is “${projectEntry}”, which is not allow, ask, or deny — asking first until it is fixed.`;
      } else {
        source = "project-override";
        reason = `Your rule for ${named} sets “${toolName}” to ${POLICY_DECISION_LABEL[parsedEntry]}, tighter than the ${POLICY_DECISION_LABEL[base.decision]} you set for every project. A project rule can only tighten, never loosen.`;
      }
    } else if (pinnedFloor === effective) {
      // NO CONFIG LEVER IS NAMED HERE, and that is not an omission. The reader cannot loosen a pin
      // — it is compiled into the build — so pointing them at config.toml would be an instruction
      // that fails, and a remedy string is an instruction people follow (AGENTS.md).
      source = "pinned-repo";
      reason = `${named} is a merge-protected repo: Sparkle will never merge there on its own authority, whatever the settings say. Hand this merge to a human.`;
    } else if (foreignFloor === effective) {
      source = "foreign-repo";
      reason = `${named} isn't one of your own repos, so I'll check with you before anything that touches its main branch. Add the org to \`[concierge].own_orgs\` in config.toml if it is yours.`;
    }
  }

  return {
    ...base,
    decision: effective,
    source,
    reason,
    // A project entry is a config entry too — but only say so when it actually governed, so the
    // settings pane's "default" marker keeps meaning what it means for the global row.
    overridden:
      base.overridden ||
      source === "project-override" ||
      source === "unreadable-project-override",
    requiresConfirmation: effective === "ask",
    project: {
      slug,
      foreign: project.foreign,
      pinned,
      inheritedDecision: base.decision,
      inheritedSource: base.source,
      projectEntry,
      tightened,
    },
  };
}

/**
 * Decide what the concierge may do with one tool — the PUBLIC entry point.
 *
 * With no `ctx.project` this is `evaluateBaseToolPolicy` verbatim: same object, same fields, no
 * `project` key. With one, the strictness lattice runs on top (see
 * {@link applyProjectPolicyLayer}), and it can only ever tighten.
 *
 *   evaluateToolPolicy("merge_pr", { overrides: { merge_pr: "allow" },
 *                                    project: projectPolicyContextFor("drodio/sparkle", ["drodio"], {}) })
 *     → { decision: "allow", … }
 *   evaluateToolPolicy("merge_pr", { overrides: { merge_pr: "allow" },
 *                                    project: projectPolicyContextFor("plow-pbc/tkmx-server", ["drodio"], {}) })
 *     → { decision: "deny", source: "pinned-repo", … }
 */
export function evaluateToolPolicy(
  toolName: string,
  ctx: ToolPolicyContext,
): ToolPolicyEvaluation {
  const base = evaluateBaseToolPolicy(toolName, ctx);
  if (!ctx.project) return base;
  return applyProjectPolicyLayer(base, toolName, ctx.project);
}
