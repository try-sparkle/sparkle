// WHICH concierge calls earn a receipt, and what each one says (bead sparkle-kr2jz, part B).
//
// ══ THE SPLIT ═══════════════════════════════════════════════════════════════════════════════════
// `services/conciergeReceipts` owns the TYPE and the fan-out; the concierge thread owns the drawing.
// This module is the middle third: given one settled `concierge_tool` call, decide whether the human
// should be able to CHECK it afterwards, and mint the record if so. Nothing here renders, subscribes,
// or performs — see conciergeReceipts' header for why the three are separate.
//
// ══ PURE, AND THAT IS LOAD-BEARING ══════════════════════════════════════════════════════════════
// No store reads, no IO, no clock, no id counter. Both non-deterministic values a receipt carries
// (`id`, `at`) arrive as PARAMETERS, stamped by the recorder at the seam. So every rule below is
// testable as a function of its inputs, and a classifier bug can never be a source of receipts that
// differ run to run.
//
// ══ THREE RULES, IN THE ORDER THEY APPLY ════════════════════════════════════════════════════════
//
// 1. WRITE-TIER ONLY. `conciergeOpWrites` — the registry's OWN predicate, exported precisely so a
//    second hand-maintained list does not exist (roborev 56103) — decides. A read op earns nothing:
//    the concierge reads constantly, and a receipt per read would bury the six lines that matter.
//
// 2. THE OP MUST MAP ONTO THE READER'S VOCABULARY. `ConciergeActionKind` has six arms, sized for the
//    human rather than for the registry, so most write ops legitimately map to `null`. The tables
//    below are `Record<Op, …>` over each domain's OWN op union — the same technique
//    `conciergeActivityLine`'s phrase tables use — so a new op is a TYPECHECK FAILURE here rather
//    than a receipt that silently never appears. Choosing `null` is a decision someone made; a
//    missing key is a decision nobody made, and those are the ones this module refuses to allow.
//
// 3. `ok` COMES FROM THE REPLY, NEVER FROM "IT DIDN'T THROW". `dispatchConciergeTool` is TOTAL: a
//    policy denial, a `bad-args` reply, `bad-args` and `unknown-op` all arrive as
//    ordinary resolved replies. A refused call still gets a receipt, with `ok: false` and the tool's
//    own words in `reason` — "I couldn't" is the answer to "why didn't it do the thing I asked", and
//    suppressing it rebuilds the silence this feature exists to end. Assuming success here is not
//    hypothetical: it is what made the thinking indicator announce "Merged PR #753" for a merge that
//    was refused, in the same column that was showing the approval request for it.
import type {
  ConciergeActionKind,
  ConciergeActionReceipt,
  ConciergeSendChannel,
} from "./conciergeReceipts";
import { conciergeOpWrites } from "./conciergeTools/registry";
import type { LifecycleOp } from "./conciergeTools/lifecycle";
import type { ReviewOp } from "./conciergeTools/review";
import type { AttachmentsOp } from "./conciergeTools/attachments";
import type { WorkflowOperation } from "./conciergeTools/workflow";
import type { EventsOp } from "./conciergeTools/events";
import type { WorkspaceOp } from "./conciergeTools/workspace";
import type { ScreenshotOp } from "./conciergeTools/screenshot";
import type { PreviewInspectOp } from "./conciergeTools/previewInspect";
import type { BoardOp } from "./conciergeTools/board";
import type { ApprovalsOp } from "./conciergeTools/approvals";
import type { DiffOp } from "./conciergeTools/diff";
import type { FleetOp } from "./conciergeTools/fleet";
import type { PlansOp } from "./conciergeTools/plans";
import type { AppToolName, TerminalToolName } from "./conciergeTools/policy";

/**
 * What one op becomes on the human's side, or `null` for "this changes the world but is not one of
 * the six things a receipt can say".
 *
 * THE `sent` ARM CARRIES ITS CHANNEL, AND THE COMPILER ENFORCES IT. `channel` is not optional here
 * the way it is on the receipt: a `sent` rule without one would produce "Sent to Kraken Auth" with
 * no indication of WHEN that message becomes visible, which is bead sparkle-zm0c8 exactly — a
 * terminal write lands in the PTY now, an inbox message sits queued and invisible until that agent's
 * next turn boundary. Making the pair unrepresentable is cheaper than a comment asking for it.
 */
type ReceiptRule =
  | { kind: Exclude<ConciergeActionKind, "sent"> }
  | { kind: "sent"; channel: ConciergeSendChannel };

type OpRule = ReceiptRule | null;

/**
 * Lifecycle.
 *
 * `discard_agent` and `spin_down_worker` map to `closed` rather than to nothing. Both understate
 * what happened — a discard destroys an unmerged branch, a spin-down deletes a worktree — but
 * "closed" is TRUE of each (the agent is gone), and understating is a different failure from lying.
 * Staying silent on the two most destructive ops in this domain would be the worse one: the whole
 * point is that the absence of a receipt is evidence.
 *
 * `ship_agent` / `save_agent` are `null`. They push a branch and may open a PR — real, outward-facing
 * work with no arm in a six-word vocabulary. `merged` would be a plain falsehood (nothing reached
 * main), and there is no honest alternative until the vocabulary grows one.
 *
 * The two previews are read-only and never reach the tables anyway; they are written out because a
 * `Record` demands it, which is the property that makes this file notice a tenth lifecycle op.
 */
const LIFECYCLE_RULES: Record<LifecycleOp, OpRule> = {
  spawn_build_agent: { kind: "spawned" },
  spawn_cloud_build_agent: { kind: "spawned" },
  preview_close: null,
  preview_discard: null,
  close_agent: { kind: "closed" },
  // `retired`, NOT `closed`, and the split is the whole reason that arm exists. `closed` reads as
  // something the founder asked for while watching — he pointed at a row and it went away. A
  // retirement is the concierge deciding on its own initiative, typically overnight, that a
  // finished agent is done with. Reported as `closed` he would read "Closed Kraken Auth" in the
  // morning with no way to tell whether he had asked for it and forgotten, which is precisely the
  // did-it-really-happen ambiguity this module exists to end. The receipt is the only witness.
  retire_agent: { kind: "retired" },
  ship_agent: null,
  save_agent: null,
  discard_agent: { kind: "closed" },
  spin_down_worker: { kind: "closed" },
  // BOTH `null`, and for the reason ship/save are: this vocabulary has no honest arm for them.
  // `closed` is the tempting one and it would be a plain falsehood — the agent is NOT gone after
  // either op; a restart leaves it running with its conversation resumed, and a stop leaves its
  // tab, worktree and branch in place for a restart to pick up. `spawned` is equally wrong: nothing
  // was created. Understating by staying silent is the lesser failure here, exactly as it is for
  // ship_agent, and the alternative is inventing an arm to describe two ops.
  restart_agent: null,
  stop_agent: null,
};

/** Review. `close_finding` is deliberately NOT `closed`: that arm reads as an AGENT closing, and
 *  `conciergeActivityLine` already made this exact call for the same reason ("Resolving, not
 *  Closing: a human reading the column should not have to wonder whether an agent was just
 *  closed"). One vocabulary, one answer. */
const REVIEW_RULES: Record<ReviewOp, OpRule> = {
  list_findings: null,
  get_finding: null,
  close_finding: null,
};

/**
 * Terminal.
 *
 * `send_to_agent_terminal` is the `terminal` half of the channel distinction — it lands in the PTY
 * immediately, which is what makes it worth telling apart from an inbox message.
 *
 * `select_picker_option` and `send_control_key` are `null`, and it is a close call. Both deliver
 * input to a live agent, so `sent` is nearly right — but a receipt reading "Sent a message to X"
 * for pressing option 2 or hitting esc describes something the concierge did not do. The vocabulary
 * has no arm for "answered a prompt on your behalf"; until it does, silence beats a wrong sentence.
 */
const TERMINAL_RULES: Record<TerminalToolName, OpRule> = {
  read_agent_terminal: null,
  get_agent_status: null,
  read_picker_options: null,
  select_picker_option: null,
  send_control_key: null,
  send_to_agent_terminal: { kind: "sent", channel: "terminal" },
};

/** Attachments. Staging a file changes what the NEXT message carries; nothing has been sent yet, so
 *  there is nothing to check up on. */
const ATTACHMENTS_RULES: Record<AttachmentsOp, OpRule> = {
  list_attachments: null,
  attach_to_message: null,
  clear_attachments: null,
};

/**
 * Git and pull requests.
 *
 * `merge_pr` and `land_agent_branch` are BOTH `merged`, which is the clearest example of why the
 * vocabulary is sized for the reader rather than for the registry: the two take different routes to
 * main, and to the human they are the same fact — the work is on main now.
 *
 * Everything else is `null`. A push, a PR opened, a branch deleted are all real writes with no arm
 * here; naming any of them `merged` would claim main changed when it did not.
 */
const WORKFLOW_RULES: Record<WorkflowOperation, OpRule> = {
  agent_branch_status: null,
  agent_workflow_state: null,
  project_agents_status: null,
  project_open_prs: null,
  pr_checks_status: null,
  pr_owner: null,
  pr_roborev_status: null,
  agent_landed_check: null,
  refresh_agent_branch: null,
  land_agent_branch: { kind: "merged" },
  push_agent_branch: null,
  open_agent_pr: null,
  merge_pr: { kind: "merged" },
  delete_agent_branch: null,
  delete_agent_branch_if_merged: null,
};

/** Change notifications. Subscribing mutates a ledger this app owns and nothing the human would
 *  ever go looking for. */
const EVENTS_RULES: Record<EventsOp, OpRule> = {
  subscribe: null,
  read_events: null,
  unsubscribe: null,
  list_subscriptions: null,
};

/** Projects and window. Every one of these is immediately VISIBLE — the tab moved, the window came
 *  forward, the project is gone from the list. A receipt exists to make an invisible act checkable;
 *  these are already checkable by looking. */
const WORKSPACE_RULES: Record<WorkspaceOp, OpRule> = {
  list_projects: null,
  select_project: null,
  open_project_tab: null,
  close_project_tab: null,
  stop_project_agents: null,
  set_project_pinned: null,
  reorder_project_tab: null,
  add_project_from_folder: null,
  remove_project: null,
  relocate_project: null,
  show_main_window: null,
  set_helper_enabled: null,
  set_helper_bounds: null,
  search_history: null,
  jump_to_history_hit: null,
  quit_app: null,
};

/** Screenshots. Classified `write` because a capture puts a file on disk, but the human already
 *  consented to each one through the ask tier — the approval IS the record. */
const SCREENSHOT_RULES: Record<ScreenshotOp, OpRule> = {
  capture_window: null,
  capture_agent: null,
};

/** Preview inspection ("agent eyes"). No receipt fields either — the reply's own `path`/matches are
 *  the record, exactly as a screenshot's is. */
const PREVIEW_INSPECT_RULES: Record<PreviewInspectOp, OpRule> = {
  screenshot: null,
  query_dom: null,
};

/** The work graph. `create_item` is the one that mints something with an id the human can open, and
 *  `beadId` is what lets the rendered line carry a real pill rather than a claim. */
const BOARD_RULES: Record<BoardOp, OpRule> = {
  list_items: null,
  get_item: null,
  get_board: null,
  ready_items: null,
  blocked_items: null,
  create_item: { kind: "filed" },
  update_item: null,
  delete_item: null,
};

/** Approvals — read-only by construction. */
const APPROVALS_RULES: Record<ApprovalsOp, OpRule> = {
  list_pending_approvals: null,
  get_approval: null,
};

/** Plans. `create_plan` writes a file the human can open in the Plans view; `promote_plan_to_build`
 *  hands it off. Neither is one of the six, and `filed` belongs to beads. */
const PLANS_RULES: Record<PlansOp, OpRule> = {
  list_plans: null,
  get_plan: null,
  create_plan: null,
  promote_plan_to_build: null,
};

/** Diff — read-only. */
const DIFF_RULES: Record<DiffOp, OpRule> = {
  list_changed_files: null,
  read_file_diff: null,
  list_commits: null,
};

/**
 * Fleet awareness — and the `inbox` half of the channel distinction (bead sparkle-zm0c8).
 *
 * An inbox message does NOT arrive when the concierge says it did. It is queued and drains at the
 * recipient's next turn boundary, appearing nowhere in the UI until then — so "I sent it" and "I
 * imagined sending it" were indistinguishable for exactly as long as that agent stayed busy. The
 * channel on the receipt is what lets the rendered line say which of the two kinds of "sent" this
 * was, instead of asserting an arrival that has not happened yet.
 */
const FLEET_RULES: Record<FleetOp, OpRule> = {
  fleet_digest: null,
  read_agent_stream: null,
  read_agent_transcript: null,
  inbox_send: { kind: "sent", channel: "inbox" },
  inbox_broadcast: { kind: "sent", channel: "inbox" },
  inbox_status: null,
};

/**
 * The `app` domain — the original sparkle-control ops, which do NOT travel through `concierge_tool`.
 *
 * WHY THEY ARE HERE ANYWAY. `set_agent_goal` is the op behind one of the founder's recorded
 * frustration turns verbatim — *"I don't see the goal … so I don't think I believe you."* It is
 * dispatched as a top-level control op rather than through the tool registry, so
 * `conciergeOpWrites` knows nothing about it and the seam that carries every other receipt never
 * sees it. Classifying it here (and wiring its own settle in `controlListener.dispatch`, guarded on
 * the reserved concierge id so no other agent's self-goal-setting can reach the human's thread) is
 * what makes `goal` a real arm rather than a vocabulary entry with no producer.
 *
 * `set_agent_goal_met` is `null`, and the reason is the vocabulary's limit rather than a judgement
 * about the act. There is one `goal` arm, so a met-receipt would render identically to a set-receipt
 * — "the concierge touched this agent's goal" — and the human could not tell which happened. A line
 * that cannot distinguish the two is worse than no line, because the whole feature is about being
 * able to check. Worth revisiting when the kind vocabulary grows.
 *
 * Deliberately NOT exhaustive over `AppToolName`: this is a `Partial`, because the app domain is
 * fourteen ops of which two concern goals, and forcing a `null` for `set_theme` would suggest this
 * module has an opinion about theme changes. The registry domains above stay exhaustive — that is
 * where a new op could silently lose its receipt.
 */
const APP_RULES: Partial<Record<AppToolName, OpRule>> = {
  set_agent_goal: { kind: "goal" },
  set_agent_goal_met: null,
};

/** The `app` ops this module classifies, for the seam that has to know which ones to settle. Derived
 *  from the table rather than restated, so the two cannot drift. */
export const CONCIERGE_RECEIPT_APP_OPS: readonly string[] = Object.keys(APP_RULES);

/** Domain → its rule table. Keyed by the wire domain name; `app` rides along for the reason in
 *  {@link APP_RULES}. An unknown domain resolves to undefined and earns no receipt. */
const RULES_BY_DOMAIN: Record<string, Record<string, OpRule | undefined> | undefined> = {
  lifecycle: LIFECYCLE_RULES,
  review: REVIEW_RULES,
  terminal: TERMINAL_RULES,
  attachments: ATTACHMENTS_RULES,
  workflow: WORKFLOW_RULES,
  events: EVENTS_RULES,
  workspace: WORKSPACE_RULES,
  screenshot: SCREENSHOT_RULES,
  preview_inspect: PREVIEW_INSPECT_RULES,
  board: BOARD_RULES,
  approvals: APPROVALS_RULES,
  plans: PLANS_RULES,
  diff: DIFF_RULES,
  fleet: FLEET_RULES,
  app: APP_RULES,
};

/** One settled call, as the seam knows it. `id` and `at` are supplied rather than minted so this
 *  module stays pure — see the header. */
export interface ConciergeReceiptInput {
  domain: string;
  op: string;
  /** The call's arguments, verbatim off the wire. Untrusted in shape. */
  args: unknown;
  /** The dispatch reply's OWN `ok`. Never "it didn't throw" — see the header, rule 3. */
  ok: boolean;
  /** The reply's `data`, present only on success. Untrusted in shape. */
  data?: unknown;
  /** The reply's `message` (or `error`), when it refused. */
  reason?: string;
  /** Minted by the recorder, via `conciergeReceipts.nextReceiptId()`. */
  id: string;
  /** Stamped by the recorder at the moment the call settled: `Date.now()`. */
  at: number;
}

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * The agent this was done TO.
 *
 * A SPAWN INVERTS THE USUAL DIRECTION and that is the one case worth stating: it is the call that
 * brings the agent into existence, so its arguments cannot carry the id — `{ projectId, prompt }` is
 * all they hold — and its reply is the first moment the id exists anywhere. Reading the args for a
 * spawn would find the PROJECT and name it as though it were the new agent, which is the shape of a
 * bug `conciergeActivityResultSubject` already had to fix once (roborev 55373).
 *
 * So the direction is keyed on the KIND, not on "whichever side happens to have an agentId": letting
 * a reply re-point the subject of an ordinary op means a call whose args and reply disagree silently
 * reports the reply's answer.
 *
 * `agentId` is what makes the rendered line clickable — a receipt naming an agent the reader cannot
 * open is the "you said it's up, but I can't click on it" complaint restated — so it is read
 * defensively and simply omitted when the reply is malformed, never guessed at.
 */
function subjectOf(
  kind: ConciergeActionKind,
  args: unknown,
  data: unknown,
): { agentId?: string; agentName?: string } {
  if (kind === "spawned") {
    const d = record(data);
    if (!d) return {};
    // `provisionalName` is what `spawnBuildAgent` returns, and it is omitted entirely when the row
    // is already gone — so an absent name here is a fact, not a lookup that failed.
    return { agentId: str(d.agentId), agentName: str(d.provisionalName) ?? str(d.name) };
  }
  const a = record(args);
  if (!a) return {};
  // `targetAgentId` is the app domain's spelling (`set_agent_goal`); every registry op uses
  // `agentId`. A broadcast carries `agentIds` and no single subject, which is why it is not read
  // here: naming one of N recipients would be worse than naming none.
  return { agentId: str(a.agentId) ?? str(a.targetAgentId), agentName: str(a.agentName) };
}

/** The bead a `filed` receipt points at. `createItem` returns `{ id }`; `beadId` is accepted too so
 *  a reply shape change degrades to a receipt without a pill rather than to no receipt. */
function beadIdOf(data: unknown): string | undefined {
  const d = record(data);
  return d ? (str(d.id) ?? str(d.beadId)) : undefined;
}

/** The PR a `merged` receipt names. Preferred from the REPLY — that is what the tool acted on — and
 *  falling back to the argument, which is where a refused merge's number still lives (a refusal
 *  carries no `data` at all, and "Couldn't merge the PR" is a poorer answer than naming it). */
function prNumberOf(args: unknown, data: unknown): number | undefined {
  const d = record(data);
  const fromReply = d ? (num(d.number) ?? num(d.prNumber)) : undefined;
  if (fromReply !== undefined) return fromReply;
  const a = record(args);
  return a ? num(a.number) : undefined;
}

/** The dispatch `path` off a terminal-send reply, when it reads as a string. */
function pathOf(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const p = (data as Record<string, unknown>).path;
  return typeof p === "string" ? p : undefined;
}

/** What a spawn reply says went WRONG, when it says anything. `fatal` means the agent is not there:
 *  no row, nothing to click, and no honest way to call the spawn a success. */
function spawnShortfall(data: unknown): { fatal: boolean; reason: string } | undefined {
  if (!data || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  if (d.agentExists === false) {
    return {
      fatal: true,
      reason:
        typeof d.briefFailure === "string" && d.briefFailure.trim()
          ? d.briefFailure
          : "that agent is already gone",
    };
  }
  if (d.briefed === false && typeof d.briefFailure === "string" && d.briefFailure.trim()) {
    return { fatal: false, reason: d.briefFailure };
  }
  return undefined;
}

/** `{queued, failed}` off a broadcast reply, when both read as numbers. Absent rather than zeroed
 *  when the shape is unrecognized: a fabricated count is worse than no count, and the renderer's
 *  plural arm keys on presence. */
function countsOf(data: unknown): { queued: number; failed: number } | undefined {
  if (!data || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  const queued = typeof d.queued === "number" && Number.isFinite(d.queued) ? d.queued : undefined;
  const failed = typeof d.failed === "number" && Number.isFinite(d.failed) ? d.failed : undefined;
  if (queued === undefined || failed === undefined) return undefined;
  return { queued, failed };
}

/**
 * Mint the receipt for one settled concierge call, or `null` when there is nothing to record.
 *
 * PURE and TOTAL: every input is read defensively (all of it crossed a wire a model assembled), no
 * input can make it throw, and the same input always produces the same output.
 *
 * Returns null for: a read-only op, an op with no arm in the reader's vocabulary, an unknown domain,
 * and an unknown op inside a known domain. The last one is the `unknown-op` refusal — a model that
 * hallucinated a tool name. That refusal is worth SAYING (the thinking indicator says it) and not
 * worth a durable receipt: nothing happened, and a permanent line for an op this build has no code
 * for would be a record of the model's imagination rather than of the app's behaviour.
 */
export function classifyConciergeActionReceipt(
  input: ConciergeReceiptInput,
): ConciergeActionReceipt | null {
  const { domain, op } = input;
  // RULE 1 — write tier, asked of the registry's own predicate rather than a list kept here.
  // `undefined` means the registry does not know this domain, which is true of `app`: those ops are
  // dispatched outside the tool spine entirely, so their rule table is the only classification there
  // is. Every OTHER unknown domain has no table either, so rule 2 drops it a line later.
  if (conciergeOpWrites(domain, op) === false) return null;
  // RULE 2 — the op must map onto something a human can read.
  const rule = RULES_BY_DOMAIN[domain]?.[op];
  if (!rule) return null;

  const { kind } = rule;
  const { agentId, agentName } = subjectOf(kind, input.args, input.data);
  // A SPAWN CAN RETURN ok FOR AN AGENT THAT IS GONE OR NEVER STARTED (roborev 57862).
  // `spawnBuildAgent` carries `agentExists` and `briefed` precisely because those states are real —
  // "That agent is gone — it was closed before its opening brief went in", and a `launch-failed`
  // terminal that never started. Reading only `agentId` minted a clean success carrying a
  // clickable-looking id for a row the store no longer has: verbatim the complaint in this feature's
  // header ("You said it's up. But I can't actually click on it").
  const spawnTrouble = kind === "spawned" && input.ok ? spawnShortfall(input.data) : undefined;
  const beadId = kind === "filed" ? beadIdOf(input.data) : undefined;
  // A FAN-OUT IS NAMED BY THE OP, NOT GUESSED FROM MISSING DATA (roborev 57888). This is the one
  // place that sees `domain`/`op`, so plurality is decided here and carried; the renderer must not
  // infer it from an absent `agentId`, which cannot tell a broadcast from a single send whose id
  // failed to parse. `inboxBroadcast` also reports a PARTIAL failure as an OK reply, so the counts
  // travel with it or the line would state flat delivery for a broadcast that half-failed.
  // UNCONDITIONAL for the broadcast op (roborev 57905). Keying plurality on whether COUNTS parsed
  // meant a broadcast refusal — which carries no data — fell through to the singular arm, and the
  // renderer then had to guess from a missing subject. But `channel: "inbox"` has TWO producers:
  // `inbox_send` and `inbox_broadcast`. So a `bad-args` refusal on a single `inbox_send` looked
  // exactly like a broadcast and rendered "those agents" for one intended recipient — the same
  // rule-1 inversion just removed from the terminal channel. The op is the only thing that knows,
  // and it is known HERE.
  // A TERMINAL SEND THAT WAS ONLY HELD IS NOT A DELIVERY (roborev 57862). `conciergeDispatch`
  // returns ok with `path: "queued"` when the PTY is not up, and `path: "picker-option"` when the
  // send collapsed onto pressing a button — which is not a message at all, and which
  // `TERMINAL_RULES` already refuses to describe as one for `select_picker_option`.
  const sendPath = pathOf(input.data);
  const isBroadcast = domain === "fleet" && op === "inbox_broadcast";
  const counts = isBroadcast ? countsOf(input.data) : undefined;
  const prNumber = kind === "merged" ? prNumberOf(input.args, input.data) : undefined;

  return {
    id: input.id,
    kind,
    // RULE 3 — the reply's own verdict. A refused call is a receipt, not a silence.
    // A spawn whose agent does not exist did NOT succeed, whatever the transport said.
    ok: input.ok && spawnTrouble?.fatal !== true,
    ...(agentId ? { agentId } : {}),
    ...(agentName ? { agentName } : {}),
    // A picker press really did write to the PTY, so it earns a receipt — it just gets its own
    // sentence rather than "sent a message" (roborev 57951). Suppressing it, as the first version
    // did, hid an action that happened.
    ...(rule.kind === "sent" && input.ok && sendPath === "picker-option"
      ? { viaPicker: true as const }
      : {}),
    ...(rule.kind === "sent"
      ? {
          channel:
            rule.channel === "terminal" && input.ok && sendPath === "queued"
              ? ("held" as const)
              : rule.channel,
        }
      : {}),
    ...(beadId ? { beadId } : {}),
    ...(prNumber !== undefined ? { prNumber } : {}),
    ...(isBroadcast ? { fanout: true as const } : {}),
    ...(counts ?? {}),
    // Only when it FAILED. A reason on a success would be a caveat the reader has no use for, and
    // the field's own contract is "the refusal, when `ok` is false".
    ...(!input.ok && input.reason ? { reason: input.reason } : {}),
    // A spawn that produced an agent but could not brief it is still a spawn — the row exists — so
    // it stays ok and carries the shortfall as the reason. An agent that starts unbriefed is the
    // observed "every agent I spawn starts dead until I go type into it" failure, and the receipt is
    // the only place the founder would see it.
    ...(spawnTrouble ? { reason: spawnTrouble.reason } : {}),
    at: input.at,
    op: `${domain}.${op}`,
  };
}
