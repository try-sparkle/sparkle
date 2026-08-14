// THE DISPATCH SPINE for the concierge's tool domains — the one function that turns a `concierge_tool`
// control op off the wire into a call on `lifecycle` / `terminal` / `workflow` / `workspace`, and
// turns their four different result conventions back into ONE reply shape.
//
// Until this file existed those four modules were complete, tested, and had ZERO callers: the
// concierge brain could not invoke any of them. This is the path.
//
// ---------------------------------------------------------------------------------------------
// THE FROZEN WIRE CONTRACT (mirrored by `concierge_tool` in services/controlListener.ts and by the
// four dispatcher tools in apps/mcp-control/src/tools.ts):
//
//   call  → { domain, op, args, toolCallId }
//   reply → { ok: true,  domain, op, data }
//         | { ok: false, domain, op, code, message }
//
// `code` is machine-readable and `message` is a sentence the concierge can say out loud. Where a
// domain already has its own machine-readable refusal vocabulary (LifecycleRefusalReason,
// WorkflowFailureCode, WorkspaceRefusalReason, ConciergeSendPath) that vocabulary is FORWARDED as
// the code rather than flattened — a caller that could branch on "needs-decision" before must still
// be able to.
//
// ---------------------------------------------------------------------------------------------
// FOUR PROPERTIES, in the order they matter:
//
// 1. `dispatchConciergeTool` IS TOTAL. It never throws and never rejects. An unknown domain or op is
//    `unknown-op`; an unexpected exception anywhere below is `internal-error`. The caller is a Rust
//    bridge round-trip with a timeout on the other end, so a rejection here would surface to the
//    human as a hang, not as an error.
//
// 2. THE OP UNION PER DOMAIN IS DERIVED FROM THE DOMAIN, not restated here. Each route table is a
//    `Record<DomainOp, Handler>` over that module's own exported union (LIFECYCLE_OPS,
//    CONCIERGE_TERMINAL_TOOLS, WORKFLOW_OPERATIONS, WORKSPACE_OPS), so a domain that gains an op the
//    registry does not route is a TYPECHECK FAILURE. Verified empirically, not just by reading: add
//    an op to any of those lists and `tsc --noEmit` fails on the route table (and on the write map).
//
// 3. ARGUMENT COERCION IS A SECURITY BOUNDARY. `args` is untyped JSON produced by a model. Every op
//    validates its own arguments with a STRICT zod schema before a single domain function is
//    reached; a malformed argument is `bad-args` with a message naming the offending field, and an
//    unrecognised field is refused rather than passed through. Nothing here casts model input into a
//    destructive call.
//
//    The confirmation gates stay where they are. `remove_project` / `relocate_project` / `quit_app`
//    still receive whatever `confirm` the caller sent (defaulting to FALSE, never to true), and
//    `discard_agent` forwards its `intent` object verbatim so lifecycle's own `isDiscardIntent` is
//    still the gate. This layer never synthesises a confirmation on the caller's behalf.
//
// 4. THE PTY WRITE IS AUTHORITY-GATED, and there is exactly one way to build that authority.
//    `send_to_agent_terminal` constructs its `DispatchAuthority` through `conciergeToolAuthority`
//    (services/dispatchAuthority) from the toolCallId ON THE WIRE and the policy decision. That
//    constructor returns null for a denied tool, an unapproved ask-tier tool, and a missing id — and
//    a null authority is a refusal, never a write. No new authority arm is added here and the union
//    is not weakened; the concierge has no other route to a terminal.
//
// ---------------------------------------------------------------------------------------------
// THE POLICY SEAM. `dispatchConciergeTool(call, { policy })` takes ONE optional function. It is
// consulted for every op, before arguments are even parsed, and its `ToolPolicyDecision` is what
// `conciergeToolAuthority` consumes for the write path. The default is
// {@link permissiveToolPolicy} — permissive but EXPLICIT: it is a named export whose whole body is
// `() => ({ tier: "allow" })`, so "no policy configured" is a visible decision in the code rather
// than an absent check. The real per-tool allow/ask/deny evaluator is bound in
// services/conciergeTools/policyBinding.ts and passed in by controlListener — one line at the call
// site, `dispatchConciergeTool(call, { policy: configuredToolPolicy })`. This file still imports no
// evaluator: the decision arrives through the seam.
//
// AN `ask` DECISION IS NOT A WAIT. The binding resolves it against the human's pending-approval
// ledger (stores/conciergeApprovals) synchronously — spending an approval a human already gave, or
// raising the question in the concierge column and returning unapproved. Dispatch then REFUSES,
// with a message that says so and names the setting. It never blocks: the concierge brain is one
// `claude -p` process per turn, so a held call would hold the whole turn (and the bridge's 600s
// round trip) on a human who may be away. The answer outlives the turn instead; the next turn's
// retry spends it.
//
// NOTE ON THE ALLOWLIST. `--allowedTools` does NOT gate MCP tools in headless `claude -p` (verified
// against Claude Code 2.1.220: a tool absent from the allowlist still executed). That makes the gate
// below THE gate, not defence in depth. Everything here fails closed for that reason.
import { z } from "zod";
import type { CategoryId } from "../../stores/uiStore";

import {
  DISCARD_CONFIRM_TOKEN,
  LIFECYCLE_OPS,
  closeAgent,
  retireAgent,
  discardAgent,
  previewClose,
  previewDiscard,
  saveAgent,
  shipAgent,
  spawnBuildAgent,
  spinDownWorkerAgent,
  type LifecycleOp,
  type LifecycleResult,
  restartAgent,
  stopAgent,
} from "./lifecycle";
import {
  REVIEW_OPS,
  REVIEW_RISK,
  listFindings,
  getFinding,
  closeFinding,
  type ReviewOp,
  type ReviewResult,
} from "./review";
import {
  CONCIERGE_TERMINAL_TOOLS,
  getAgentStatus,
  readAgentTerminal,
  CONTROL_KEY_NAMES,
  readPickerOptions,
  selectPickerOption,
  sendControlKey,
  type ControlKeyName,
  sendToAgentTerminal,
} from "./terminal";
import {
  ATTACHMENTS_OPS,
  ATTACHMENTS_RISK,
  attachToMessage,
  clearAttachments,
  listAttachments,
  type AttachmentsOp,
  type AttachmentsResult,
} from "./attachments";
import {
  WORKFLOW_OPERATIONS,
  WORKFLOW_RISK,
  agentBranchName,
  agentBranchStatusTool,
  agentLandedCheckTool,
  agentWorkflowStateTool,
  deleteAgentBranchIfMergedTool,
  deleteAgentBranchTool,
  landAgentBranchTool,
  mergePrTool,
  openAgentPrTool,
  prChecksStatusTool,
  prRoborevStatusTool,
  projectAgentsStatusTool,
  projectOpenPrsTool,
  prOwnerTool,
  pushAgentBranchTool,
  refreshAgentBranchTool,
  type AgentWorkflowContext,
  type WorkflowOperation,
  type WorkflowResult,
} from "./workflow";
import {
  EVENTS_OPS,
  EVENTS_RISK,
  listEventSubscriptions,
  readEvents,
  subscribe,
  unsubscribe,
  type EventsOp,
  type EventsResult,
} from "./events";
import {
  WORKSPACE_OPS,
  WORKSPACE_OP_RISK,
  addProjectFromFolder,
  closeProjectTab,
  jumpToHistoryHit,
  listProjects,
  openProjectTab,
  quitApp,
  relocateProject,
  removeProject,
  reorderProjectTab,
  searchHistory,
  selectProject,
  setHelperBounds,
  setHelperEnabled,
  setProjectPinned,
  showMainWindow,
  type WorkspaceOp,
  type WorkspaceResult,
} from "./workspace";
// ONE symbol from the policy module, and only the dotted-path helper: the refusal below has to
// name the exact config key the human would edit, and a second copy of `concierge.tools.${op}`
// spelled out here is the copy that goes stale. This file still routes and classifies entirely on
// its own — the policy DECISION arrives through the `policy` seam, never by importing an evaluator.
import {
  BOARD_OPS,
  BOARD_RISK,
  listItems,
  getItem,
  getBoard,
  readyItems,
  blockedItems,
  createItem,
  updateItem,
  deleteItem,
  type BoardOp,
  type BoardResult,
} from "./board";
import {
  APPROVALS_OPS,
  APPROVALS_RISK,
  listPendingApprovals,
  getApproval,
  type ApprovalsOp,
  type ApprovalsResult,
} from "./approvals";
import {
  ACCOUNTS_OPS,
  ACCOUNTS_RISK,
  readUsage,
  switchAll,
  type AccountsOp,
  type AccountsResult,
} from "./accounts";
import {
  PLANS_OPS,
  PLANS_RISK,
  listPlans,
  getPlan,
  createPlan,
  promotePlanToBuild,
  type PlansOp,
  type PlansResult,
} from "./plans";
import {
  DIFF_OPS,
  DIFF_RISK,
  listChangedFiles,
  readFileDiff,
  listCommits,
  type DiffOp,
  type DiffResult,
} from "./diff";
import {
  SCREENSHOT_OPS,
  captureWindow,
  captureAgent,
  type ScreenshotOp,
  type ScreenshotResult,
} from "./screenshot";
import {
  PREVIEW_INSPECT_OPS,
  PREVIEW_INSPECT_RISK,
  previewScreenshot,
  previewQueryDom,
  type PreviewInspectOp,
  type PreviewInspectResult,
} from "./previewInspect";
import {
  RESEARCH_OPS,
  cancelResearchTask,
  dispatchResearchTask,
  getResearchTask,
  listResearchTasks,
  type ResearchOp,
  type ResearchResult,
} from "./research";
import { RESEARCH_DEPTHS } from "../research/types";
import {
  MEMORY_OPS,
  MEMORY_RISK,
  forgetMemory,
  listMemories,
  recallMemory,
  rememberMemory,
  type MemoryOp,
  type MemoryResult,
} from "./memory";
import { conciergeToolConfigPath } from "./policy";
// The founder's words go where HE aimed them — see ./relayGate for his ruling and for why this is a
// refused SEND rather than a relabelled one.
import { refuseUnaddressedRelay } from "./relayGate";

/** Every op that carries a MESSAGE to an agent, and so can relay the founder's own words.
 *
 *  A SET RATHER THAN A CONDITION AT THE GATE, so the population is one named list a reader can check
 *  against the receipt classifier's `kind: "sent"` arms. It was a single `op === …` test first, which
 *  left the ruling walkable by picking `inbox_send` instead (roborev 64191). A new message-carrying
 *  op must be added here; `relayGate.test.ts` pins the list against the classifier so a missing entry
 *  is a red test rather than a silent hole. */
export const RELAY_GATED_OPS = new Set<string>([
  "send_to_agent_terminal",
  "inbox_send",
  "inbox_broadcast",
]);
import { conciergeToolAuthority, type ToolPolicyDecision } from "../dispatchAuthority";
import { useProjectStore } from "../../stores/projectStore";
// The SAME predicate spawn_worker gates on — one copy, shared, so the two dispatch surfaces cannot
// drift into enforcing different definitions of "a goal".
import { validateWorkerGoal, HISTORY_SCOPES } from "@sparkle/core";
import { log } from "../../logger";
import {
  FLEET_OPS,
  FLEET_RISK,
  fleetDigest,
  inboxBroadcast,
  inboxSend,
  inboxStatus,
  readAgentStream,
  readAgentTranscript,
  type FleetOp,
  type FleetResult,
} from "./fleet";
import type { AgentTab, Project } from "../../types";
import type { HistoryHit } from "../history";

// ---------------------------------------------------------------------------------------------
// The wire shapes
// ---------------------------------------------------------------------------------------------

/** The tool domains, exactly as they appear on the wire. */
export const CONCIERGE_TOOL_DOMAINS = [
  "lifecycle",
  "review",
  "terminal",
  "attachments",
  "workflow",
  "events",
  "workspace",
  "screenshot",
  "preview_inspect",
  "board",
  "approvals",
  "plans",
  "diff",
  "fleet",
  "research",
  "accounts",
  "memory",
] as const;

export type ConciergeToolDomain = (typeof CONCIERGE_TOOL_DOMAINS)[number];

/** One `concierge_tool` call. Typed for in-app callers; validated anyway, because the real one
 *  arrives as JSON a model wrote. */
export interface ConciergeToolCall {
  domain: string;
  op: string;
  args: unknown;
  /** Minted by the MCP server (crypto.randomUUID) — NEVER supplied by the model. It is what a PTY
   *  write is attributed to, so a blank one costs the write. */
  toolCallId: string;
}

export interface ConciergeToolOk {
  ok: true;
  domain: string;
  op: string;
  data: unknown;
}

export interface ConciergeToolError {
  ok: false;
  domain: string;
  op: string;
  /** Machine-readable. Either one of {@link REGISTRY_CODES} or the domain's own refusal reason. */
  code: string;
  /** A sentence fit to say to the human. */
  message: string;
}

export type ConciergeToolReply = ConciergeToolOk | ConciergeToolError;

/** The codes this layer mints itself (a domain's own vocabulary passes through untouched). */
export const REGISTRY_CODES = {
  /** No such domain, or no such op in that domain. Never a throw, never a silent success. */
  unknownOp: "unknown-op",
  /** The arguments failed validation; `message` names the field. */
  badArgs: "bad-args",
  /** The policy layer said deny. */
  denied: "denied",
  /** Ask-tier and nobody has approved it — not a denial, but not permission either. */
  needsApproval: "needs-approval",
  /** A well-formed call naming a project/agent that does not exist. */
  unknownAgent: "unknown-agent",
  unknownProject: "unknown-project",
  /** No authority could be built for a write (blank toolCallId, or an unresolved policy). */
  unauthorized: "unauthorized",
  /** The send would relay the FOUNDER'S OWN WORDS to an agent he never named. See
   *  {@link refuseUnaddressedRelay} — his aim is the authority for where his words go, and this is
   *  the one refusal that protects it. */
  unaddressedRelay: "unaddressed-relay",
  /** An unexpected exception. The bug bucket — it should stay empty. */
  internalError: "internal-error",
} as const;

// ---------------------------------------------------------------------------------------------
// The policy seam
// ---------------------------------------------------------------------------------------------

/** What the policy layer is asked about. `write` is the domain's own read/write classification, not
 *  a guess made here — see the write maps below. */
export interface ToolPolicyQuery {
  domain: ConciergeToolDomain;
  op: string;
  /** False for a pure read. True for anything that can change the world. */
  write: boolean;
  toolCallId: string;
  /**
   * The model's raw, UNVALIDATED arguments — forwarded verbatim, exactly as they arrived.
   *
   * Here so an ask-tier policy can scope one human approval to one specific call: "approve this
   * discard" must not become "may always discard", which it would if the only thing an approval
   * could name were the op. The binding uses this to render what the human is being asked about
   * and to fingerprint the call, so a retry can spend the approval ONLY by asking for the same
   * thing again (see stores/conciergeApprovals).
   *
   * It is deliberately unparsed: the policy runs BEFORE argument validation (a denied tool must be
   * refused as denied, not as a validation error), so there is nothing to hand over but the raw
   * value. A policy must therefore treat it as untrusted — matching on it is safe because it
   * NARROWS what an approval covers and can never widen it.
   */
  args: unknown;
}

/** The seam. Pure: a query in, a decision out. `services/conciergeTools/policy.ts`'s
 *  `evaluateToolPolicy` is intended to satisfy this exactly. */
export type ConciergeToolPolicy = (q: ToolPolicyQuery) => ToolPolicyDecision;

/**
 * The default policy: allow everything.
 *
 * Permissive, and deliberately EXPLICIT rather than an absent check — a reader of `dispatch` sees a
 * policy being consulted and can ask which one, instead of discovering later that there was none.
 * Swap it at the call site the moment the real evaluator lands.
 */
export const permissiveToolPolicy: ConciergeToolPolicy = () => ({ tier: "allow" });

export interface DispatchOptions {
  /** Defaults to {@link permissiveToolPolicy}. */
  policy?: ConciergeToolPolicy;
}

// ---------------------------------------------------------------------------------------------
// Reply helpers
// ---------------------------------------------------------------------------------------------

/** Everything a handler needs to name itself in a reply, plus the decision that permitted it. */
interface OpContext {
  domain: string;
  op: string;
  toolCallId: string;
  decision: ToolPolicyDecision;
}

function ok(ctx: OpContext, data: unknown): ConciergeToolOk {
  return { ok: true, domain: ctx.domain, op: ctx.op, data };
}

function err(ctx: OpContext, code: string, message: string): ConciergeToolError {
  return { ok: false, domain: ctx.domain, op: ctx.op, code, message };
}

/** A refusal for a call that never got as far as having a policy decision. */
function bareErr(domain: string, op: string, code: string, message: string): ConciergeToolError {
  return { ok: false, domain, op, code, message };
}

// ---------------------------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------------------------

/**
 * Turn a zod failure into a message that NAMES THE FIELD.
 *
 * "invalid input" tells a model nothing it can act on; "`agentId`: Required" tells it exactly what
 * to send next. Unrecognised keys get their own phrasing because their issue carries the offending
 * names in `keys` rather than in `path` — and they are refused rather than stripped, so a model
 * cannot smuggle an extra field past a schema and have it silently ignored.
 */
function describeIssue(issue: z.ZodIssue): string {
  if (issue.code === "unrecognized_keys") {
    return `unrecognised argument(s) ${issue.keys.map((k) => `\`${k}\``).join(", ")} — this op does not accept them`;
  }
  const field = issue.path.length ? issue.path.join(".") : "(the arguments object)";
  return `\`${field}\`: ${issue.message}`;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; reply: ConciergeToolError };

function parseArgs<T>(ctx: OpContext, schema: z.ZodType<T>, raw: unknown): Parsed<T> {
  // `undefined` means "no arguments", which is a legitimate call for the arg-less ops. `null` is
  // not coerced — a model that sent null meant something, and guessing is how a security boundary
  // stops being one.
  const r = schema.safeParse(raw === undefined ? {} : raw);
  if (r.success) return { ok: true, value: r.data };
  const first = r.error.issues[0];
  return {
    ok: false,
    reply: err(
      ctx,
      REGISTRY_CODES.badArgs,
      `${ctx.domain}.${ctx.op} was called with bad arguments — ${first ? describeIssue(first) : "the arguments did not validate"}.`,
    ),
  };
}

/** One op: its argument schema and what to do with the parsed value. */
type Handler = (raw: unknown, ctx: OpContext) => Promise<ConciergeToolReply>;

function route<T>(
  schema: z.ZodType<T>,
  run: (value: T, ctx: OpContext) => ConciergeToolReply | Promise<ConciergeToolReply>,
): Handler {
  return async (raw, ctx) => {
    const parsed = parseArgs(ctx, schema, raw);
    if (!parsed.ok) return parsed.reply;
    return run(parsed.value, ctx);
  };
}

// ---------------------------------------------------------------------------------------------
// Per-domain normalizers — four result conventions in, one reply shape out
// ---------------------------------------------------------------------------------------------

/** lifecycle: `{ ok, op, risk, data }` | `{ ok: false, …, reason, message }`. The refusal's `reason`
 *  becomes the code. A `needs-decision` refusal also carries a `preview`; the wire reply has no room
 *  for it, but the message already states what closing would risk, and `preview_close` returns the
 *  full preview as its own op. */
/**
 * A refusal that carries a SELF-SERVE FIX must carry it across this boundary.
 *
 * `LifecycleRefused.deepLink` names the Settings section that unblocks the user (the cloud gate's
 * own, or the server's, forwarded unchanged), and `ConciergeToolReply`'s refusal arm has no slot for
 * a structured one — so the route is folded into the sentence rather than dropped, exactly as
 * `fromWorkflow` folds in its conflicted `files`. Without this the concierge relays "you don't have
 * enough credits to start a cloud agent" and stops there, leaving the user to find Credits
 * themselves: the dead end the creation dialog's button exists to remove, re-created on the tool
 * path. The gate's own sentence stays VERBATIM and untouched; this is a second sentence after it.
 */
const SETTINGS_ROUTE: Partial<Record<CategoryId, string>> = {
  credits: "You can add credits in Settings → Credits.",
  cloudauth: "You can add it in Settings → Cloud auth.",
};

function fromLifecycle<T>(ctx: OpContext, r: LifecycleResult<T>): ConciergeToolReply {
  if (r.ok) return ok(ctx, r.data);
  const route = r.deepLink ? SETTINGS_ROUTE[r.deepLink] : undefined;
  return err(ctx, r.reason, route ? `${r.message} ${route}` : r.message);
}

/** review: same convention as board. The domain's own refusal codes (`roborev-daemon-down`,
 *  `roborev-unregistered`, …) pass through as the code, which is the point of having four of them:
 *  a caller that can branch on WHICH of roborev's supported-but-unavailable states it hit can name
 *  the one remedy that applies, instead of saying "roborev is unavailable" four different times. */
function fromReview<T>(ctx: OpContext, r: ReviewResult<T>): ConciergeToolReply {
  return r.ok ? ok(ctx, r.data) : err(ctx, r.reason, r.message);
}

/** workflow: `{ ok, op, risk, data }` | `{ ok: false, …, kind, code, message, files? }`. The
 *  refusal's `code` passes straight through; conflicted paths are folded into the message, since a
 *  caller that has to say WHICH files conflicted cannot get them any other way. */
function fromWorkflow<T>(ctx: OpContext, r: WorkflowResult<T>): ConciergeToolReply {
  if (r.ok) return ok(ctx, r.data);
  const files = r.files?.length ? ` Files: ${r.files.join(", ")}.` : "";
  return err(ctx, r.code, `${r.message}${files}`);
}

/** attachments: the lifecycle/board convention. Its refusal `reason` is the path-containment code
 *  (`outside-project`, `symlink-escape`, `hidden-path`, `too-large`, …) and passes straight through,
 *  which is the whole point of having one code per rejection reason — a caller that has to tell
 *  "that file isn't in your project" from "that path is a link out of it" can still branch. */
function fromAttachments<T>(ctx: OpContext, r: AttachmentsResult<T>): ConciergeToolReply {
  return r.ok ? ok(ctx, r.data) : err(ctx, r.reason, r.message);
}

/** events: the board convention. The refusal `reason` (`unknown-subscription`,
 *  `unknown-event-kind`) passes through as the code, because a caller that must tell "your
 *  subscription is gone" apart from "nothing happened" can only do it on that word. */
function fromEvents<T>(ctx: OpContext, r: EventsResult<T>): ConciergeToolReply {
  return r.ok ? ok(ctx, r.data) : err(ctx, r.reason, r.message);
}

/** workspace: `{ ok, op, risk, value }` | `{ ok: false, …, reason, message }`. Note `value`, not
 *  `data` — the one place the conventions differ in the SUCCESS arm too. */
function fromWorkspace<T>(ctx: OpContext, r: WorkspaceResult<T>): ConciergeToolReply {
  return r.ok ? ok(ctx, r.value) : err(ctx, r.reason, r.message);
}

/** screenshot: the board/diff convention. Its refusals carry the reason a capture could not be
 *  taken — most often that the named agent is not the one on screen, which is a REFUSAL rather than
 *  a wrong picture because every agent's pane occupies the same rect (see screenshot.ts). */
function fromScreenshot<T>(ctx: OpContext, r: ScreenshotResult<T>): ConciergeToolReply {
  return r.ok ? ok(ctx, r.data) : err(ctx, r.reason, r.message);
}

/** preview_inspect: same convention as screenshot, but see previewInspect.ts's header for why its
 *  ops are `read-only` rather than `privacy-sensitive` — this reads the agent's own dev-server
 *  output, not the human's screen. */
function fromPreviewInspect<T>(ctx: OpContext, r: PreviewInspectResult<T>): ConciergeToolReply {
  return r.ok ? ok(ctx, r.data) : err(ctx, r.reason, r.message);
}

/** board: `{ ok, op, risk, data }` | `{ ok: false, …, reason, message }` — the lifecycle convention.
 *  `beads-unavailable` passes through as the code, so a project with no `bd` database is reported as
 *  the supported state it is rather than as a failure. */
function fromBoard<T>(ctx: OpContext, r: BoardResult<T>): ConciergeToolReply {
  return r.ok ? ok(ctx, r.data) : err(ctx, r.reason, r.message);
}

/** plans: same convention as board — the Plan side of the Plan/Build toggle. */
function fromPlans<T>(ctx: OpContext, r: PlansResult<T>): ConciergeToolReply {
  return r.ok ? ok(ctx, r.data) : err(ctx, r.reason, r.message);
}

/** diff: same convention as board. Read-only throughout — every op is one git plumbing READ, which
 *  is what lets the domain answer without an approval round-trip. */
function fromDiff<T>(ctx: OpContext, r: DiffResult<T>): ConciergeToolReply {
  return r.ok ? ok(ctx, r.data) : err(ctx, r.reason, r.message);
}

/** approvals: same convention as board. Read-only throughout — see approvals.ts's header for why
 *  there is deliberately no `approve` op for this to normalize. */
function fromApprovals<T>(ctx: OpContext, r: ApprovalsResult<T>): ConciergeToolReply {
  return r.ok ? ok(ctx, r.data) : err(ctx, r.reason, r.message);
}

/** accounts: same convention as board. Its four refusal codes pass through because they demand
 *  different next moves — `same-quota` means "pick a different login" (the switch would be a no-op
 *  that interrupts the whole fleet), while `already-current` means there is nothing to do at all. A
 *  caller that cannot tell them apart will retry the one that costs everyone a turn boundary. */
function fromAccounts<T>(ctx: OpContext, r: AccountsResult<T>): ConciergeToolReply {
  return r.ok ? ok(ctx, r.data) : err(ctx, r.reason, r.message);
}

/** research: same convention as board. `not-acknowledged` and `unknown-task` pass through as the
 *  code because they demand opposite responses — the first says "do NOT re-dispatch, read the list",
 *  the second says "that id was never real" — and a caller that cannot tell them apart will retry
 *  exactly the one that starts a second metered child. */
function fromResearch<T>(ctx: OpContext, r: ResearchResult<T>): ConciergeToolReply {
  return r.ok ? ok(ctx, r.data) : err(ctx, r.reason, r.message);
}

/** memory: same convention as research/board — the refusal's `reason` becomes the wire code. */
function fromMemory<T>(ctx: OpContext, r: MemoryResult<T>): ConciergeToolReply {
  return r.ok ? ok(ctx, r.data) : err(ctx, r.reason, r.message);
}

// ---------------------------------------------------------------------------------------------
// Store lookups — the context a MODEL is never allowed to supply
// ---------------------------------------------------------------------------------------------

// An agent id is the only handle the model gets. Everything else an operation needs — the repo root,
// the project id, the agent's kind, its base/default branch — is resolved HERE, from the store, so
// an invented id cannot be dressed up with a root path of the caller's choosing. This is the rule
// AgentWorkflowContext's doc comment states; this is where it is enforced.

function locateAgent(agentId: string): { project: Project; agent: AgentTab } | null {
  for (const project of useProjectStore.getState().projects) {
    const agent = project.agents.find((a) => a.id === agentId);
    if (agent) return { project, agent };
  }
  return null;
}

function findProject(projectId: string): Project | undefined {
  return useProjectStore.getState().projects.find((p) => p.id === projectId);
}

function workflowContext(project: Project, agent: AgentTab): AgentWorkflowContext {
  return {
    root: project.rootPath,
    projectId: project.id,
    agentId: agent.id,
    kind: agent.kind,
    parentId: agent.parentId,
    baseBranch: agent.baseBranch,
    defaultBranch: project.defaultBranch,
  };
}

/** Run `fn` against a resolved agent context, or refuse with `unknown-agent`. */
async function withAgentContext(
  ctx: OpContext,
  agentId: string,
  fn: (c: AgentWorkflowContext) => Promise<ConciergeToolReply>,
): Promise<ConciergeToolReply> {
  const found = locateAgent(agentId);
  if (!found) {
    return err(
      ctx,
      REGISTRY_CODES.unknownAgent,
      `I can't find an agent with id ${agentId} in any open project — it may already be closed.`,
    );
  }
  return fn(workflowContext(found.project, found.agent));
}

/** Run `fn` against a resolved project, or refuse with `unknown-project`. */
async function withProject(
  ctx: OpContext,
  projectId: string,
  fn: (p: Project) => Promise<ConciergeToolReply>,
): Promise<ConciergeToolReply> {
  const project = findProject(projectId);
  if (!project) {
    return err(ctx, REGISTRY_CODES.unknownProject, `No project with id ${projectId}.`);
  }
  return fn(project);
}

// ---------------------------------------------------------------------------------------------
// Shared argument pieces
// ---------------------------------------------------------------------------------------------

const agentIdArg = z.string().min(1, "an agent id is required");
const projectIdArg = z.string().min(1, "a project id is required");
const noArgs = z.object({}).strict();
const agentOnly = z.object({ agentId: agentIdArg }).strict();
const agentAndSelector = z
  .object({ agentId: agentIdArg, selector: z.string().min(1, "a CSS selector is required") })
  .strict();
/** close_agent, plus the agent's own stated reason for having no retro (bead sparkle-0l9xk). */
const closeAgentArgs = z
  .object({
    agentId: agentIdArg,
    noRetro: z.object({ reasonCode: z.unknown(), reasonText: z.unknown() }).optional(),
  })
  .strict();
/**
 * retire_agent — the unattended close. `reason` is REQUIRED and non-empty here as well as in the
 * domain, because it lands verbatim on the permanent record the founder reads afterwards.
 *
 * `deadClaim` is optional and, when present, fully specified: an agent asserting "this one is dead"
 * owes the excerpt it read, when it read it, and which terminal tier produced it. The DOMAIN judges
 * those (only the live scrollback describes the present, and only inside a freshness window) — this
 * layer only guarantees the fields are there to judge, so the refusal can name what was wrong.
 */
const retireAgentArgs = z
  .object({
    agentId: agentIdArg,
    reason: z.string().min(1, "a reason is required — it goes on the permanent record"),
    deadClaim: z
      .object({
        evidence: z.string(),
        observedAt: z.number(),
        source: z.string(),
      })
      .nullish(),
  })
  .strict();
const projectOnly = z.object({ projectId: projectIdArg }).strict();

/** The confirmation flag on workspace's destructive ops. Optional so the DOMAIN produces the
 *  refusal (with its own sentence naming what would be destroyed), and defaulted to FALSE so an
 *  omitted flag can never read as consent. */
const confirmArg = z.boolean().optional();

// ---------------------------------------------------------------------------------------------
// LIFECYCLE
// ---------------------------------------------------------------------------------------------

const spawnArgs = z
  .object({
    projectId: z.string().min(1).optional(),
    runtime: z.enum(["local", "cloud"]).optional(),
    /** The opening brief, delivered with the spawn. Non-empty when present: a blank string would
     *  create exactly the briefless agent this argument exists to prevent, so it is refused as
     *  bad-args rather than treated as "no prompt". */
    prompt: z.string().min(1, "a brief cannot be empty — omit `prompt` for an empty agent").optional(),
    name: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    mode: z.enum(["plan", "build"]).optional(),
  })
  .strict();

const discardArgs = z
  .object({
    agentId: agentIdArg,
    /**
     * The caller's confirmation, forwarded VERBATIM. Deliberately `unknown`: `isDiscardIntent` in
     * lifecycle.ts is the gate, and validating the token here would either duplicate that gate or —
     * worse — turn a missing confirmation into a `bad-args` error instead of the domain's own
     * refusal, which is the one that explains what discard destroys and what token to send.
     */
    intent: z.unknown().optional(),
  })
  .strict();

const spinDownArgs = z
  .object({
    agentId: agentIdArg,
    /** Acknowledge that the worker's UNCOMMITTED changes are about to be deleted. Same shape and
     *  same reasoning as `confirmArg`: optional so the domain refuses (naming the loss) rather than
     *  this layer erroring on bad args, and absent can never read as consent. */
    discardUncommitted: confirmArg,
    /** Proceed when the worktree's git state could NOT BE READ (`status-unknown`). Strictly weaker
     *  than `discardUncommitted`: it does not consent to losing anything, and it still refuses a tree
     *  we positively read as dirty. It exists because the unknown case was previously inescapable —
     *  a permanently-stale cache entry deadlocked seven finished workers and the only workaround was
     *  `discard_agent`, which destroys branches outright (bead sparkle-plxhx). */
    allowUnknownStatus: confirmArg,
  })
  .strict();

const LIFECYCLE_ROUTES: Record<LifecycleOp, Handler> = {
  spawn_build_agent: route(spawnArgs, async (a, ctx) =>
    fromLifecycle(
      ctx,
      // Awaited: `briefed` is now an OBSERVATION of the brief's delivery, not a restatement of the
      // input, so the op has to wait for that outcome before it can answer honestly.
      await spawnBuildAgent({
        projectId: a.projectId,
        runtime: a.runtime ?? "local",
        prompt: a.prompt,
        name: a.name,
        model: a.model,
        mode: a.mode,
      }),
    ),
  ),
  // ══ `prompt` AND `name` ARE FORWARDED, AND `prompt` IS THE POINT ════════════════════════════════
  // This route used to pass `{ projectId, runtime: "cloud" }` and nothing else, which was harmless
  // only while the op was a guaranteed refusal — lifecycle threw the arguments away before reading
  // them. It performs a real start now (design 2026-08-01 §Decision 7), and a cloud agent's GOAL is
  // its `prompt`: the runner seeds Claude Code with it via stdin as the sandbox comes up, and there
  // is no way to send it afterwards. Dropping it here would turn every call into lifecycle's
  // `cloud-goal-required` refusal, however carefully the model had written the brief.
  //
  // `model`/`mode` are deliberately NOT forwarded: `POST /sessions/start` takes neither, so passing
  // them would let a caller believe a choice was applied that nothing ever read. The schema still
  // ACCEPTS them (it is shared with the local spawn) — lifecycle ignores them for a cloud start.
  spawn_cloud_build_agent: route(spawnArgs, async (a, ctx) =>
    fromLifecycle(
      ctx,
      await spawnBuildAgent({
        projectId: a.projectId,
        runtime: "cloud",
        prompt: a.prompt,
        name: a.name,
      }),
    ),
  ),
  preview_close: route(agentOnly, (a, ctx) => fromLifecycle(ctx, previewClose(a.agentId))),
  preview_discard: route(agentOnly, (a, ctx) => fromLifecycle(ctx, previewDiscard(a.agentId))),
  // `noRetro` is OPTIONAL and unvalidated beyond being an object: engine/retroMuster owns the
  // vocabulary and the wording rules, and duplicating them in a zod schema here is how the two
  // would drift. A malformed reason comes back as a refusal carrying muster's own phrase.
  close_agent: route(closeAgentArgs, async (a, ctx) =>
    fromLifecycle(ctx, await closeAgent(a.agentId, a.noRetro)),
  ),
  // The unattended close. Every safety reading is taken LIVE inside the domain — this layer must not
  // pre-read anything from the stores and pass it down, or the staleness the op exists to avoid
  // comes straight back in through its own arguments.
  retire_agent: route(retireAgentArgs, async (a, ctx) =>
    fromLifecycle(
      ctx,
      await retireAgent(a.agentId, { reason: a.reason, deadClaim: a.deadClaim ?? null }),
    ),
  ),
  ship_agent: route(agentOnly, async (a, ctx) => fromLifecycle(ctx, await shipAgent(a.agentId))),
  save_agent: route(agentOnly, async (a, ctx) => fromLifecycle(ctx, await saveAgent(a.agentId))),
  discard_agent: route(discardArgs, async (a, ctx) =>
    // `as never`-free: discardAgent's parameter is typed, but the value is unknown, so it goes
    // through the same `isDiscardIntent` check every other caller does. A missing intent lands on
    // `intent-required`, not on a crash and not on a delete.
    fromLifecycle(ctx, await discardAgent(a.agentId, a.intent as Parameters<typeof discardAgent>[1])),
  ),
  // Not `agentOnly`: a spin-down deletes the worker's checkout, so it carries the same optional
  // confirmation the other destructive ops do — omitted reads as "no", and the DOMAIN produces the
  // refusal that names the uncommitted work rather than this layer inventing a sentence.
  spin_down_worker: route(spinDownArgs, async (a, ctx) =>
    fromLifecycle(
      ctx,
      await spinDownWorkerAgent(a.agentId, {
        discardUncommitted: a.discardUncommitted,
        allowUnknownStatus: a.allowUnknownStatus,
      }),
    ),
  ),
  // `agentOnly` like the previews: both take just an id. The DOMAIN owns every refusal — unknown
  // agent, no pane, and the app-owned agent being mid-pass — so this layer invents no sentence.
  restart_agent: route(agentOnly, async (a, ctx) => fromLifecycle(ctx, await restartAgent(a.agentId))),
  stop_agent: route(agentOnly, async (a, ctx) => fromLifecycle(ctx, await stopAgent(a.agentId))),
};

/**
 * Read vs write, per lifecycle op — for the policy query.
 *
 * Lifecycle has no `read-only` risk class to derive this from (its previews are classified
 * `routine`, same as a real close), so the classification is stated here as an exhaustive
 * `Record<LifecycleOp, boolean>`: a new lifecycle op is a typecheck failure until someone decides
 * whether it changes the world.
 */
const LIFECYCLE_WRITE: Record<LifecycleOp, boolean> = {
  spawn_build_agent: true,
  spawn_cloud_build_agent: true,
  preview_close: false,
  preview_discard: false,
  close_agent: true,
  retire_agent: true,
  ship_agent: true,
  save_agent: true,
  discard_agent: true,
  spin_down_worker: true,
  // Both change the world: one re-spawns a process, the other kills one.
  restart_agent: true,
  stop_agent: true,
};

// ---------------------------------------------------------------------------------------------
// REVIEW — roborev's findings. See review.ts for why the four "unavailable" states are four codes.
// ---------------------------------------------------------------------------------------------

/**
 * READS may default their project; the WRITE must name one — the same asymmetry as the board's, for
 * the same reason. `close_finding` is `ask`-tier, and an approval is fingerprinted over the model's
 * RAW arguments: a close naming no project would be resolved against `selectedProjectId` on the
 * RETRY turn, which can move in between (the concierge can move it itself with
 * `workspace.select_project`). Requiring the id makes the approved call and the performed call the
 * same call.
 */
const reviewScope = z.object({ projectId: z.string().min(1).optional() }).strict();

/** `branch` widens the read past the checkout's current branch — optional, and never defaulted to
 *  something machine-wide. `limit` may only LOWER the Rust-side cap; a hallucinated 5000 is clamped
 *  there, and the applied cap comes back so a full page is still recognised as possibly truncated. */
const listFindingsArgs = reviewScope.extend({
  branch: z.string().min(1).optional(),
  limit: z.number().int().positive().optional(),
});

const findingIdArgs = reviewScope.extend({
  id: z.string().min(1, "a finding id is required"),
});

/**
 * The close. `projectId` REQUIRED (see reviewScope) and `rationale` non-empty AT THE SCHEMA.
 *
 * The domain refuses a blank rationale too, and the duplication is deliberate: this schema turns it
 * into a `bad-args` reply naming the field, which is what a model needs to fix its next call, while
 * the domain's own guard is what protects every non-registry caller. Neither is redundant with the
 * other — a blank rationale must never reach roborev, because roborev would ACCEPT it and record a
 * close indistinguishable from one made without reading the finding.
 */
const closeFindingArgs = z
  .object({
    projectId: projectIdArg,
    id: z.string().min(1, "a finding id is required"),
    rationale: z
      .string()
      .min(1, "closing a finding needs a rationale — it is recorded on the review before the close"),
  })
  .strict();

const REVIEW_ROUTES: Record<ReviewOp, Handler> = {
  list_findings: route(listFindingsArgs, (a, ctx) =>
    withBoardProject(ctx, a.projectId, async (p) =>
      fromReview(ctx, await listFindings(p.rootPath, { branch: a.branch, limit: a.limit })),
    ),
  ),
  get_finding: route(findingIdArgs, (a, ctx) =>
    withBoardProject(ctx, a.projectId, async (p) =>
      fromReview(ctx, await getFinding(p.rootPath, a.id)),
    ),
  ),
  // The write resolves through `withProject` — no store fallback. See reviewScope.
  close_finding: route(closeFindingArgs, (a, ctx) =>
    withProject(ctx, a.projectId, async (p) =>
      fromReview(ctx, await closeFinding(p.rootPath, a.id, a.rationale)),
    ),
  ),
};

// ---------------------------------------------------------------------------------------------
// TERMINAL
// ---------------------------------------------------------------------------------------------

/** The terminal domain's ops, derived from the module's own descriptor list. */
export type TerminalOp = (typeof CONCIERGE_TERMINAL_TOOLS)[number]["name"];

const readTerminalArgs = z
  .object({
    agentId: agentIdArg,
    // The module clamps these to its own ceiling and floor; the schema only has to keep a string or
    // an object from reaching arithmetic.
    maxChars: z.number().finite().optional(),
    maxLines: z.number().finite().optional(),
    query: z.string().optional(),
    historyLimit: z.number().finite().optional(),
  })
  .strict();

/**
 * ── EVERY SEND STATES A GOAL, OR DECLARES ITSELF NOT WORK ─────────────────────────────────────────
 * `goal` is OPTIONAL AT THE SCHEMA and REQUIRED BY THE GATE — see goalGate's header for why the
 * schema cannot be the enforcer. The failure this closes is not a bad goal; it is a FORGOTTEN one. `set_agent_goal` already existed as a separate
 * call and was routinely skipped: a real message sent on 2026-07-30 assigned an agent multi-part work
 * in prose and left its `AgentGoal` empty, so `goalStateOf` read `none`, auto-continue stayed
 * disabled, and nothing could tell that agent apart from one that had merely stopped. Making the goal
 * part of THIS call is the fix — stating it is no longer a second thing to remember.
 *
 * `notWork` is the escape hatch for the sends that genuinely carry no objective (answering a
 * question, a nudge, asking something). It must carry a reason so the choice is RECORDED rather than
 * inferred: nothing here guesses intent from the message text, because a model that can label its own
 * intent can mislabel work as chatter.
 *
 * The RULES live in `@sparkle/core`'s `validateWorkerGoal` — the same predicate `spawn_worker` uses.
 * Deliberately not re-stated here: two copies would drift, and this is a second SURFACE, not a second
 * policy.
 */
const sendTerminalArgs = z
  .object({
    agentId: agentIdArg,
    text: z.string().min(1, "there is nothing to send"),
    userPrompt: z.boolean().optional(),
    // Optional at the schema, required by the gate — same reasoning as spawn_worker's `goal`
    // (roborev 55743): a required key made the documented `notWork` form fail zod before the handler
    // ran, so the caller got "goal: Required" instead of the message that teaches what a goal is.
    goal: z
      .string()
      .optional()
      .describe(
        "REQUIRED unless you pass notWork. The objectively verifiable completion criterion this " +
          "send advances — what will be TRUE when it is met, checkable by someone else.",
      ),
    notWork: z
      .object({ reason: z.string() })
      .optional()
      .describe(
        "This send assigns no work (an answer, a nudge, a question). Omit `goal` when using this; " +
          "the reason is stated on the call, and the agent's goal is left untouched.",
      ),
  })
  .strict();

/** The press takes the index AND the `fingerprint` from `read_picker_options` — see terminal.ts for
 *  why an index alone (or an index plus a label) is not a safe way to answer a LIVE menu. */
const selectPickerArgs = z
  .object({
    agentId: agentIdArg,
    index: z.number().int().min(0, "an option index is required"),
    // NOT `.min(1)`. An empty fingerprint is a real value `read_picker_options` returns — it means
    // the menu is present but its question could not be read, so the ask cannot be told apart from
    // any other with the same option shape. Rejecting it at the schema handed the model a validation
    // error telling it to do exactly what it had just done, while the refusal that actually explains
    // the situation (`unreadable-picker`) was unreachable through the registry (roborev 55195).
    expectFingerprint: z.string(),
  })
  .strict();

/** A NAMED key, not arbitrary bytes — the enum is the whole safety boundary here (see terminal.ts). */
const controlKeyArgs = z
  .object({
    agentId: agentIdArg,
    key: z.enum(CONTROL_KEY_NAMES as [string, ...string[]]),
  })
  .strict();

const TERMINAL_ROUTES: Record<TerminalOp, Handler> = {
  send_control_key: route(controlKeyArgs, async (a, ctx) => {
    // Same authority as any other terminal write: pressing esc can discard work in flight, so it is
    // not a lesser act than typing and does not get a lesser gate.
    const authority = conciergeToolAuthority(ctx.toolCallId, ctx.decision);
    if (!authority) {
      log.warn("concierge-tools", "control key refused — no authority could be built", {
        agentId: a.agentId,
        tier: ctx.decision.tier,
      });
      return err(
        ctx,
        REGISTRY_CODES.unauthorized,
        "Not pressed: nothing authorized this write. A concierge tool write needs a tool-call id and a resolved allow/approved policy.",
      );
    }
    const r = await sendControlKey(a.agentId, a.key as ControlKeyName, authority);
    return r.ok ? ok(ctx, r) : err(ctx, r.reason ?? "action-failed", r.detail ?? "Not pressed.");
  }),
  read_picker_options: route(agentOnly, (a, ctx) => ok(ctx, readPickerOptions(a.agentId))),
  select_picker_option: route(selectPickerArgs, async (a, ctx) => {
    // Pressing a menu option writes to a PTY, so it rides the SAME authority as typed text — a
    // picked option is attributable to a toolCallId exactly like a send.
    const authority = conciergeToolAuthority(ctx.toolCallId, ctx.decision);
    if (!authority) {
      log.warn("concierge-tools", "picker press refused — no authority could be built", {
        agentId: a.agentId,
        tier: ctx.decision.tier,
      });
      return err(
        ctx,
        REGISTRY_CODES.unauthorized,
        "Not pressed: nothing authorized this write. Answering a menu needs a tool-call id and a resolved allow/approved policy.",
      );
    }
    const r = await selectPickerOption(a.agentId, a.index, a.expectFingerprint, authority);
    return r.ok ? ok(ctx, r) : err(ctx, r.reason ?? "action-failed", r.detail ?? "Not pressed.");
  }),
  read_agent_terminal: route(readTerminalArgs, async (a, ctx) =>
    ok(
      ctx,
      await readAgentTerminal(a.agentId, {
        maxChars: a.maxChars,
        maxLines: a.maxLines,
        query: a.query,
        historyLimit: a.historyLimit,
      }),
    ),
  ),
  get_agent_status: route(agentOnly, (a, ctx) => ok(ctx, getAgentStatus(a.agentId))),
  send_to_agent_terminal: route(sendTerminalArgs, async (a, ctx) => {
    // THE GOAL GATE, first — before authority is built and before anything reaches a PTY. Cheapest
    // possible refusal: no authority, no store read, no I/O, so a send stating no objective costs
    // nothing. `a.text` is passed as the "task" so a goal that merely echoes the message is refused
    // (an echo adds no checkable fact). This ordering is the EXISTING contract, not a change to it:
    // zod arg validation already runs before the authority check.
    const goalVerdict = validateWorkerGoal(a.goal, a.text, a.notWork, {
      // NAME THIS SURFACE, not spawn_worker's. The refusal is the caller's only route to this
      // contract — none of the three model-facing descriptions of this tool mention `goal`/`notWork` —
      // so a message naming `goalOverride` sent the caller to a key `.strict()` rejects, and its
      // second refusal repeated the same advice: a loop with no successful send (roborev 55826/55836).
      tool: "send_to_agent_terminal",
      overrideParam: "notWork",
    });
    if (!goalVerdict.ok) {
      return err(ctx, REGISTRY_CODES.badArgs, `Not sent: ${goalVerdict.message}`);
    }
    // THE RELAY GATE IS NOT HERE — it is GATE 0 in `dispatchConciergeTool`, above the policy tier,
    // and this note exists so nobody "tidies" it back down into this body. It lived here first and
    // was almost entirely inert: this op is `disruptive`, so its default decision is `ask`, and the
    // ask-tier return fires BEFORE the handler runs. The first call therefore never reached this
    // line, and the approved re-run arrives from a click handler after the founder's turn has
    // ended — when the turn text the gate compares against is already gone. See the comment at
    // gate 0 for the full reasoning.
    //
    // THE ONLY constructor, from the toolCallId ON THE WIRE. Null for a denied tool, an ask-tier
    // tool nobody approved, and a blank id — all three are refusals, and none of them reach a PTY.
    // (The policy tiers are already refused above, so a null here means the id was unusable.)
    const authority = conciergeToolAuthority(ctx.toolCallId, ctx.decision);
    if (!authority) {
      log.warn("concierge-tools", "terminal send refused — no authority could be built", {
        agentId: a.agentId,
        tier: ctx.decision.tier,
      });
      return err(
        ctx,
        REGISTRY_CODES.unauthorized,
        "Not sent: nothing authorized this write. A concierge tool write needs a tool-call id and a resolved allow/approved policy.",
      );
    }
    // WRITE THE `notWork` REASON DOWN. Unlike spawn_worker — where the accountability is the computed
    // fact that the worker has no goal — this path deliberately leaves the agent's PRIOR goal intact,
    // so nothing about the record distinguishes "chatter was sent" from "work dispatched with no
    // objective". The log entry IS the audit trail the escape hatch is justified by; without it the
    // reason is validated and thrown away, and calling it "recorded" is false (roborev 55826/55836).
    if (goalVerdict.override) {
      log.info("concierge-tools", "terminal send declared not-work", {
        agentId: a.agentId,
        reason: goalVerdict.override.reason,
        toolCallId: ctx.toolCallId,
      });
    }
    const r = await sendToAgentTerminal(a.agentId, a.text, authority, {
      userPrompt: a.userPrompt,
    });
    // Record the goal only once the work was actually DELIVERED. Ordered after the send on purpose:
    // `sendToAgentTerminal` legitimately refuses (an unanswered prompt on screen, a dead PTY), and
    // setting a goal for work that never arrived would make an agent accountable for something it was
    // never told to do — a false unmet goal that auto-continue would then try to drive. The residual
    // risk is the mirror image (a crash between send and set leaves delivered work goalless), and that
    // is the better failure: a missing goal is visible, a fabricated one is not.
    // ── RECORD THE GOAL, AS THE AGENT ──────────────────────────────────────────────────────────
    // `actor: "agent"` is load-bearing and its absence was a real defect (roborev 55877). The default
    // is `"human"`, which on CHANGED text builds a fresh `newGoal` (totalContinues 0) AND releases the
    // stashed `goalDebt`. Two failures followed from that one omission:
    //
    //   1. MAX_CONTINUES_TOTAL became refillable by ordinary concierge traffic. An agent auto-
    //      continued near the ceiling gets one send with reworded goal text, its budget returns to 0,
    //      it never reaches the ceiling, so it NEVER ESCALATES — and the escalation guard below
    //      protected a state this very call site prevented from being reached.
    //   2. The guard was walkable. An agent clears its goal via set_agent_goal (`actor: "agent"`),
    //      which drops the record but STASHES the escalation in `goalDebt`; the next send then sees
    //      `existing === undefined`, passes the guard, and a `"human"` write releases the debt —
    //      cancelling an escalation the human owned. Exactly what the guard was added to stop.
    //
    // `"agent"` makes chargeGoalDebt carry totalContinues and escalatedAt forward on its own. Do NOT
    // key the actor off `a.userPrompt`: that flag is model-supplied, so it would re-open the launder.
    let goalRecorded = false;
    let goalNote: string | undefined;
    if (r.ok && goalVerdict.goal) {
      const project = useProjectStore
        .getState()
        .projects.find((p) => p.agents.some((ag) => ag.id === a.agentId));
      const agent = project?.agents.find((ag) => ag.id === a.agentId);
      // Read the escalation from the STASH as well as the live goal — after a clear the record is
      // gone and only `goalDebt` remembers (projectStore's clear-then-set route, roborev 55451).
      const escalatedAt = agent?.goal?.escalatedAt ?? agent?.goalDebt?.escalatedAt;
      // Read the REASON off the same chain as the timestamp. Narrowing one and not the other made
      // the diagnostic always `undefined` on exactly the new path, which is the path worth
      // diagnosing (roborev 55900).
      const escalationReason = agent?.goal?.escalationReason ?? agent?.goalDebt?.escalationReason;
      if (!project) {
        // NOT SILENT, and not an edge case: services/sparkleAgent documents that `__sparkle_self__`
        // is never in any project's `agents` array, so EVERY work send to the built-in Improve
        // Sparkle agent lands here. A bare no-op would accept a goal, report success, and leave that
        // agent at goalStateOf === "none" with auto-continue disabled — the exact state the gate
        // exists to eliminate, now behind an enforcement that reported success.
        goalNote = "this agent is not part of a project, so no goal could be recorded on it";
        log.warn("concierge-tools", "goal not recorded — agent is not in any project", {
          agentId: a.agentId,
        });
      } else if (escalatedAt) {
        // DO NOT CLOBBER AN ESCALATED GOAL. It is one auto-continue already gave up on and handed to
        // the HUMAN; taking it back off their plate is not a routine send's decision to make.
        //
        // ⚠️ THE PROTECTION IS ABOUT THE *ROUTE*, NOT ABOUT WHO MAY CLEAR IT. This used to read
        // "clearing an escalation stays deliberate (resetAgentGoalRetries)" as though a human were
        // the only party that could, which is no longer true: the concierge holds a BOUNDED re-arm
        // lever (agentGoal's `rearmGoal`, capped by MAX_CONCIERGE_REARMS and refilled only by a
        // human typing to the agent), plus the free take-back of an escalation it raised itself.
        // What has not changed — and must not — is that none of that happens as a SIDE EFFECT of
        // sending prose. An un-latch has to be an explicit, counted, reasoned call
        // (`set_agent_escalation`) so the spend is attributable; a send that quietly cleared one
        // would be an unbounded re-arm loop wearing a work message.
        //
        // TWO DIFFERENT STATES, TWO DIFFERENT SENTENCES. With a live goal record this is "your text
        // was delivered, the standing goal stayed" — a normal outcome. With the escalation known only
        // from `goalDebt` the agent is GOALLESS and stays that way: the debt is released only by a
        // human-authored send (`releaseGoalDebt` off `appendPrompt`/`noteTerminalBrief`), and
        // `resetAgentGoalRetries` has no production caller to point anyone at. Telling the concierge
        // "the goal was not replaced" there names a goal that does not exist, so it reads the state as
        // fine and never routes to the human — the one thing that clears it (roborev 55900).
        goalNote = agent?.goal
          ? "the agent's goal is escalated, so it was not replaced — clearing an escalation is an " +
            "explicit, counted call (set_agent_escalation), never a side effect of sending text"
          : "this agent has an escalation outstanding to the human and NO goal recorded — it will " +
            "stay goalless until a person types to it, so route this to the human rather than re-sending";
        log.warn("concierge-tools", "goal not replaced — the agent's goal is escalated to the human", {
          agentId: a.agentId,
          escalationReason,
          fromDebt: agent?.goal === undefined,
        });
      } else {
        useProjectStore.getState().setAgentGoal(project.id, a.agentId, goalVerdict.goal, undefined, "agent");
        goalRecorded = true;
      }
    } else if (r.ok && goalVerdict.override) {
      // "NO GOAL WAS ASKED FOR" ≠ "A GOAL WAS ASKED FOR AND NOT RECORDED". Under an override the gate
      // returns `goal: null`, so the block above never runs and the reply was a bare
      // `goalRecorded: false` — shaped exactly like the two real failures minus their explanation.
      // The field's own contract makes that read as "your goal did not stick", which invites the
      // concierge to restate the objective and re-send text the PTY already has: a duplicate send on
      // the one path the override exists to make cheap (roborev 55900).
      goalNote = "declared not-work, so no goal was asked for or recorded — nothing to re-send";
    }
    // TELL THE CALLER WHAT HAPPENED TO THE GOAL. It was just refused unless it stated one, so a bare
    // `ok` reads as "the goal is recorded" and it will neither restate it nor route it to a human. A
    // warn line in the app log is not a channel the caller can read.
        return r.ok
      ? ok(ctx, { ...r, goalRecorded, ...(goalNote ? { goalNote } : {}) })
      : err(ctx, r.path, r.detail);
  }),
};

/** Read vs write, straight off each descriptor — terminal already classifies itself. */
const TERMINAL_WRITE: Record<string, boolean> = Object.fromEntries(
  CONCIERGE_TERMINAL_TOOLS.map((t) => [t.name, t.write]),
);

// ---------------------------------------------------------------------------------------------
// ATTACHMENTS — hand an agent a FILE. See attachments.ts for the containment rules.
// ---------------------------------------------------------------------------------------------

/**
 * The paths, as a strict schema — and note what it does NOT do.
 *
 * It checks SHAPE only: a non-empty array of non-empty strings, bounded so a hallucinated
 * thousand-element array is refused before a thousand IPC probes are issued. Every question about
 * what a path MEANS — absolute, no `..`, inside the project, a real file, small enough — is the
 * domain's, and the domain answers each with its own named refusal code. Restating any of them here
 * would turn an explained refusal ("that path is a link out of your project") into a bare `bad-args`
 * naming a field, which is precisely the trade `mergePrArgs` above is written to avoid.
 */
const attachArgs = z
  .object({
    agentId: agentIdArg,
    paths: z
      .array(z.string().min(1, "a path cannot be empty"))
      .min(1, "name at least one absolute path")
      .max(64, "that is more paths than this can take"),
  })
  .strict();

const ATTACHMENTS_ROUTES: Record<AttachmentsOp, Handler> = {
  list_attachments: route(agentOnly, (a, ctx) => fromAttachments(ctx, listAttachments(a.agentId))),
  attach_to_message: route(attachArgs, async (a, ctx) =>
    fromAttachments(ctx, await attachToMessage(a.agentId, a.paths)),
  ),
  clear_attachments: route(agentOnly, (a, ctx) =>
    fromAttachments(ctx, clearAttachments(a.agentId)),
  ),
};

// ---------------------------------------------------------------------------------------------
// WORKFLOW
// ---------------------------------------------------------------------------------------------

const openPrArgs = z
  .object({ agentId: agentIdArg, title: z.string().min(1, "a PR needs a title") })
  .strict();

const workflowStateArgs = z
  .object({ agentId: agentIdArg, probeGitHub: z.boolean().optional() })
  .strict();

const agentsStatusArgs = z
  .object({
    projectId: projectIdArg,
    probeGitHub: z.boolean().optional(),
    force: z.boolean().optional(),
  })
  .strict();

const prNumberArgs = z
  .object({ projectId: projectIdArg, number: z.number().int().positive() })
  .strict();

/**
 * merge_pr's arguments, forwarded rather than rejected.
 *
 * `method` / `auto` / `squash` / `rebase` are accepted by the SCHEMA and refused by `mergePrTool`,
 * on purpose. Refusing them here would produce a `bad-args` error naming a field; refusing them
 * there produces the sentence that explains WHY Sparkle merges with a merge commit only — that a
 * squash stops the branch tip being an ancestor of main, and that `--auto` merges immediately on
 * this repo with checks still pending. The model needs the reason, not the field name.
 */
const mergePrArgs = z
  .object({
    projectId: projectIdArg,
    number: z.number().int().positive(),
    method: z.unknown().optional(),
    auto: z.unknown().optional(),
    squash: z.unknown().optional(),
    rebase: z.unknown().optional(),
    // Forwarded unvalidated for the SAME reason as `method` above: `mergePrTool.normalizeAck` owns
    // the shape, and its refusal explains that waiving roborev findings means naming the ids you
    // read — a `bad-args` error naming a field would not.
    roborevOverride: z.unknown().optional(),
    // Same convention again. A `z.object({ reason: z.string().min(15) })` here would refuse a
    // one-word waiver with "bad-args: knightwatchOverride.reason too small" — true, and useless.
    // `mergePrTool` refuses it with the sentence that says the reason is PUBLISHED ON THE PULL
    // REQUEST beside the reviewer's unanswered question, which is the fact that should change what
    // the model does next.
    knightwatchOverride: z.unknown().optional(),
  })
  .strict();

const WORKFLOW_ROUTES: Record<WorkflowOperation, Handler> = {
  agent_branch_status: route(agentOnly, (a, ctx) =>
    withAgentContext(ctx, a.agentId, async (c) => fromWorkflow(ctx, await agentBranchStatusTool(c))),
  ),
  agent_workflow_state: route(workflowStateArgs, (a, ctx) =>
    withAgentContext(ctx, a.agentId, async (c) =>
      fromWorkflow(ctx, await agentWorkflowStateTool(c, { probeGitHub: a.probeGitHub })),
    ),
  ),
  project_agents_status: route(agentsStatusArgs, (a, ctx) =>
    withProject(ctx, a.projectId, async (p) =>
      fromWorkflow(
        ctx,
        await projectAgentsStatusTool(
          p.rootPath,
          p.id,
          // Built from the STORE, never from the caller — see the note above locateAgent.
          p.agents.map((agent) => ({
            agentId: agent.id,
            baseBranch: agent.baseBranch ?? "",
            parentBranch: agent.parentId ? agentBranchName(agent.parentId) : "",
            kind: agent.kind,
            force: a.force === true,
          })),
          a.probeGitHub === true,
        ),
      ),
    ),
  ),
  project_open_prs: route(projectOnly, (a, ctx) =>
    withProject(ctx, a.projectId, async (p) =>
      fromWorkflow(ctx, await projectOpenPrsTool(p.rootPath, p.id)),
    ),
  ),
  pr_owner: route(prNumberArgs, (a, ctx) =>
    withProject(ctx, a.projectId, async (p) =>
      fromWorkflow(ctx, await prOwnerTool(p.rootPath, p.id, a.number)),
    ),
  ),
  pr_checks_status: route(prNumberArgs, (a, ctx) =>
    withProject(ctx, a.projectId, async (p) =>
      fromWorkflow(ctx, await prChecksStatusTool(p.rootPath, p.id, a.number)),
    ),
  ),
  pr_roborev_status: route(prNumberArgs, (a, ctx) =>
    withProject(ctx, a.projectId, async (p) =>
      fromWorkflow(ctx, await prRoborevStatusTool(p.rootPath, p.id, a.number)),
    ),
  ),
  agent_landed_check: route(agentOnly, (a, ctx) =>
    withAgentContext(ctx, a.agentId, async (c) => fromWorkflow(ctx, await agentLandedCheckTool(c))),
  ),
  refresh_agent_branch: route(agentOnly, (a, ctx) =>
    withAgentContext(ctx, a.agentId, async (c) =>
      fromWorkflow(ctx, await refreshAgentBranchTool(c)),
    ),
  ),
  land_agent_branch: route(agentOnly, (a, ctx) =>
    withAgentContext(ctx, a.agentId, async (c) => fromWorkflow(ctx, await landAgentBranchTool(c))),
  ),
  push_agent_branch: route(agentOnly, (a, ctx) =>
    withAgentContext(ctx, a.agentId, async (c) => fromWorkflow(ctx, await pushAgentBranchTool(c))),
  ),
  open_agent_pr: route(openPrArgs, (a, ctx) =>
    withAgentContext(ctx, a.agentId, async (c) =>
      fromWorkflow(ctx, await openAgentPrTool(c, a.title)),
    ),
  ),
  merge_pr: route(mergePrArgs, (a, ctx) =>
    withProject(ctx, a.projectId, async (p) =>
      fromWorkflow(
        ctx,
        await mergePrTool({
          root: p.rootPath,
          projectId: p.id,
          number: a.number,
          // Forwarded so mergePrTool's runtime backstop — not this schema — is what refuses them.
          ...(a.method !== undefined ? { method: a.method as "merge" } : {}),
          ...(a.auto !== undefined ? { auto: a.auto as never } : {}),
          ...(a.squash !== undefined ? { squash: a.squash as never } : {}),
          ...(a.rebase !== undefined ? { rebase: a.rebase as never } : {}),
          ...(a.roborevOverride !== undefined
            ? { roborevOverride: a.roborevOverride as { acknowledgedJobIds: number[]; reason: string } }
            : {}),
          ...(a.knightwatchOverride !== undefined
            ? { knightwatchOverride: a.knightwatchOverride as { reason: string } }
            : {}),
        }),
      ),
    ),
  ),
  delete_agent_branch: route(agentOnly, (a, ctx) =>
    withAgentContext(ctx, a.agentId, async (c) => fromWorkflow(ctx, await deleteAgentBranchTool(c))),
  ),
  delete_agent_branch_if_merged: route(agentOnly, (a, ctx) =>
    withAgentContext(ctx, a.agentId, async (c) =>
      fromWorkflow(ctx, await deleteAgentBranchIfMergedTool(c)),
    ),
  ),
};

// ---------------------------------------------------------------------------------------------
// EVENTS — the drainable log of what changed. See events.ts for why this is a cursor and not a push.
// ---------------------------------------------------------------------------------------------

/**
 * Kinds arrive as PLAIN STRINGS and are narrowed by the DOMAIN, not by this schema.
 *
 * A `z.enum` here would refuse a typo as `bad-args` naming the field — true, and useless. The
 * domain's own refusal names the offending kind AND lists the seven real ones, which is the sentence
 * a model can act on. Same reasoning as `mergePrArgs` forwarding its refused options.
 */
const eventKindsArg = z.array(z.string().min(1, "an event kind cannot be empty")).optional();

const subscribeArgs = z.object({ kinds: eventKindsArg }).strict();

const readEventsArgs = z
  .object({
    subscriptionId: z.string().min(1).optional(),
    /** The cursor from a previous drain. Non-negative: seqs start at 1, so 0 means "everything". */
    since: z.number().int().min(0, "a cursor is never negative").optional(),
    /**
     * Which RUN of the log the cursor came from — the `epoch` handed back with it.
     *
     * A plain string rather than a validated shape, and narrowed by the DOMAIN for the same reason
     * `kinds` is: the useful answer to a stale epoch is "the log restarted, here is what this run
     * holds", which `bad-args` cannot say. Optional, because a caller that kept no epoch still gets
     * the `since > latestSeq` backstop.
     */
    epoch: z.string().min(1, "an epoch is never empty").optional(),
    kinds: eventKindsArg,
    limit: z.number().int().positive().optional(),
  })
  .strict();

const unsubscribeArgs = z
  .object({ subscriptionId: z.string().min(1, "a subscription id is required") })
  .strict();

const EVENTS_ROUTES: Record<EventsOp, Handler> = {
  subscribe: route(subscribeArgs, (a, ctx) => fromEvents(ctx, subscribe(a.kinds))),
  read_events: route(readEventsArgs, (a, ctx) =>
    fromEvents(
      ctx,
      readEvents({
        subscriptionId: a.subscriptionId,
        since: a.since,
        epoch: a.epoch,
        kinds: a.kinds,
        limit: a.limit,
      }),
    ),
  ),
  unsubscribe: route(unsubscribeArgs, (a, ctx) => fromEvents(ctx, unsubscribe(a.subscriptionId))),
  list_subscriptions: route(noArgs, (_a, ctx) => fromEvents(ctx, listEventSubscriptions())),
};

// ---------------------------------------------------------------------------------------------
// WORKSPACE
// ---------------------------------------------------------------------------------------------

const openTabArgs = z
  .object({ projectId: projectIdArg, agentId: z.string().min(1).nullable().optional() })
  .strict();

const pinArgs = z.object({ projectId: projectIdArg, pinned: z.boolean().optional() }).strict();

const reorderArgs = z
  .object({ projectId: projectIdArg, beforeProjectId: z.string().min(1).nullable() })
  .strict();

const addProjectArgs = z
  .object({ path: z.string().min(1, "an absolute folder path is required"), name: z.string().optional() })
  .strict();

const relocateArgs = z
  .object({
    projectId: projectIdArg,
    newPath: z.string().min(1, "an absolute destination path is required"),
    confirm: confirmArg,
  })
  .strict();

const helperBoundsArgs = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite(),
    height: z.number().finite(),
  })
  .strict();

/**
 * `scope` is OPTIONAL and its absence means the narrow search, so every caller written before it
 * existed keeps its exact meaning — but it has to be DECLARED here regardless, because the schema is
 * `.strict()` and an undeclared field is a `bad-args` refusal rather than a field politely ignored.
 *
 * The value is what `policy.ts`'s `perCallRiskFor` gates on: `"all"` also reads `concierge`-sourced
 * rows (the founder's own conversations with the minder) and therefore raises an approval card,
 * while `"default"` stays the silent read-only search. Note the ORDER — the policy is consulted
 * before this schema runs, so `perCallRiskFor` sees the raw string and this enum is the second line
 * of defence, not the first.
 */
const searchHistoryArgs = z
  .object({
    query: z.string(),
    limit: z.number().int().positive().optional(),
    // Built from the shared list rather than a second spelling of it — see
    // @sparkle/core/historyScope for why the value lives in one place.
    scope: z.enum(HISTORY_SCOPES).optional(),
  })
  .strict();

/** A history hit, as `search_history` returned it. Validated field by field rather than passed
 *  through: `jumpToHit` navigates on the strength of `agentId`/`projectId`, and a hallucinated hit
 *  would move the human's window to somewhere they never asked about. */
const historyHitArgs = z
  .object({
    hit: z
      .object({
        id: z.string(),
        kind: z.string(),
        source: z.string(),
        projectId: z.string().nullable(),
        agentId: z.string().nullable(),
        projectName: z.string().nullable(),
        agentName: z.string().nullable(),
        snippet: z.string(),
        createdAt: z.number().finite(),
      })
      .strict(),
  })
  .strict();

const WORKSPACE_ROUTES: Record<WorkspaceOp, Handler> = {
  list_projects: route(noArgs, (_a, ctx) => fromWorkspace(ctx, listProjects())),
  select_project: route(projectOnly, (a, ctx) => fromWorkspace(ctx, selectProject(a.projectId))),
  open_project_tab: route(openTabArgs, (a, ctx) =>
    fromWorkspace(ctx, openProjectTab(a.projectId, a.agentId ?? null)),
  ),
  close_project_tab: route(projectOnly, async (a, ctx) =>
    fromWorkspace(ctx, await closeProjectTab(a.projectId, { stopAgents: false })),
  ),
  // The same function, asked for the disruptive variant. workspace.ts reports the op it ACTUALLY
  // performed, so this reply is labelled stop_project_agents either way.
  stop_project_agents: route(projectOnly, async (a, ctx) =>
    fromWorkspace(ctx, await closeProjectTab(a.projectId, { stopAgents: true })),
  ),
  set_project_pinned: route(pinArgs, (a, ctx) =>
    fromWorkspace(ctx, setProjectPinned(a.projectId, a.pinned)),
  ),
  reorder_project_tab: route(reorderArgs, (a, ctx) =>
    fromWorkspace(ctx, reorderProjectTab(a.projectId, a.beforeProjectId)),
  ),
  add_project_from_folder: route(addProjectArgs, async (a, ctx) =>
    fromWorkspace(ctx, await addProjectFromFolder(a.path, a.name)),
  ),
  remove_project: route(
    z.object({ projectId: projectIdArg, confirm: confirmArg }).strict(),
    (a, ctx) => fromWorkspace(ctx, removeProject(a.projectId, { confirm: a.confirm === true })),
  ),
  relocate_project: route(relocateArgs, async (a, ctx) =>
    fromWorkspace(ctx, await relocateProject(a.projectId, a.newPath, { confirm: a.confirm === true })),
  ),
  show_main_window: route(noArgs, (_a, ctx) => fromWorkspace(ctx, showMainWindow())),
  set_helper_enabled: route(z.object({ enabled: z.boolean() }).strict(), (a, ctx) =>
    fromWorkspace(ctx, setHelperEnabled(a.enabled)),
  ),
  set_helper_bounds: route(helperBoundsArgs, (a, ctx) => fromWorkspace(ctx, setHelperBounds(a))),
  search_history: route(searchHistoryArgs, async (a, ctx) =>
    fromWorkspace(ctx, await searchHistory(a.query, a.limit, { scope: a.scope })),
  ),
  jump_to_history_hit: route(historyHitArgs, (a, ctx) =>
    fromWorkspace(ctx, jumpToHistoryHit(a.hit as HistoryHit)),
  ),
  quit_app: route(z.object({ confirm: confirmArg }).strict(), async (a, ctx) =>
    fromWorkspace(ctx, await quitApp({ confirm: a.confirm === true })),
  ),
};

// ---------------------------------------------------------------------------------------------
// SCREENSHOT — the only domain that observes the human's SCREEN rather than the app's own data.
// ---------------------------------------------------------------------------------------------

/**
 * `capture_window` takes NO arguments, deliberately.
 *
 * There is no rect, no window id and no display to name: the Rust side reads the main window's own
 * geometry. A rect argument here would turn the command into a general-purpose "photograph this
 * part of the screen" primitive reachable from model-authored JSON — which is exactly what
 * window_capture.rs's clamp exists to prevent, handed back through the front door.
 */
const SCREENSHOT_ROUTES: Record<ScreenshotOp, Handler> = {
  capture_window: route(noArgs, async (_a, ctx) => fromScreenshot(ctx, await captureWindow())),
  capture_agent: route(agentOnly, async (a, ctx) =>
    fromScreenshot(ctx, await captureAgent(a.agentId)),
  ),
};

/**
 * Read vs write, per screenshot op.
 *
 * BOTH ARE `true`, and it is not a slip. Nothing about the app changes — but a capture WRITES A
 * FILE holding a picture of the user's screen, and `write` is what the policy layer's approval
 * fingerprinting treats as "this call did something in the world". Stated as an exhaustive
 * `Record<ScreenshotOp, boolean>` for the same reason `LIFECYCLE_WRITE` is: a new op cannot be
 * added without someone deciding, and the `?? true` fallback at the call site means the answer for
 * an unclassified name is the one that gets ASKED about rather than waved through.
 */
const SCREENSHOT_WRITE: Record<ScreenshotOp, boolean> = {
  capture_window: true,
  capture_agent: true,
};

/**
 * preview_inspect: reads an already-open preview's own render — see previewInspect.ts's header for
 * why `agentId` here names the AGENT WHOSE PREVIEW to look at, not the pane on screen (there is no
 * "on screen" requirement at all: this drives its own throwaway headless browser).
 */
const PREVIEW_INSPECT_ROUTES: Record<PreviewInspectOp, Handler> = {
  screenshot: route(agentOnly, async (a, ctx) => fromPreviewInspect(ctx, await previewScreenshot(a.agentId))),
  query_dom: route(agentAndSelector, async (a, ctx) =>
    fromPreviewInspect(ctx, await previewQueryDom(a.agentId, a.selector)),
  ),
};

// ---------------------------------------------------------------------------------------------
// The domain table
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// BOARD — the work graph (beads). See board.ts for why this answers both the "board" and "beads"
// shapes the PRD asks for as separate surfaces.
// ---------------------------------------------------------------------------------------------

/**
 * READS may default their project; WRITES must name one. The asymmetry is deliberate.
 *
 * On the read side, the board is the surface the human is looking at while they talk to the
 * concierge, so "what's on my board" must not need an id the human doesn't know. The fallback
 * resolves through the STORE, never through anything the model supplied, so it cannot be used to
 * reach an unopened project.
 *
 * On the write side that same fallback is a hole, and `delete_item` shows it most sharply. It is
 * `irreversible` → `ask`, and an approval is fingerprinted over the model's RAW ARGS — so an
 * approval minted for `{id: "x"}` with no project binds no project. The target would be resolved
 * from `selectedProjectId` on the RETRY turn, up to a grant TTL later, and the selection can move
 * in between — the concierge can move it itself with `workspace.select_project`. The human would
 * also be shown a card naming a bead but not whose board it is on. Requiring the id makes the
 * approved call and the performed call the same call, which is the property the ledger rests on.
 */
const boardScope = z.object({ projectId: z.string().min(1).optional() }).strict();
const boardItem = boardScope.extend({ id: z.string().min(1, "an item id is required") });

/** The write scope: `projectId` REQUIRED. See the note above. */
const boardWriteScope = z.object({ projectId: projectIdArg }).strict();
const boardWriteItem = boardWriteScope.extend({ id: z.string().min(1, "an item id is required") });

const createItemArgs = boardWriteScope.extend({
  title: z.string().min(1, "a title is required"),
  body: z.string().optional(),
});

/** At least one field must actually change — `.refine` rather than all-optional, so an empty update
 *  is a `bad-args` error naming the problem instead of a success that did nothing. */
const updateItemArgs = boardWriteItem
  .extend({
    status: z.enum(["in_progress", "closed"]).optional(),
    addLabels: z.array(z.string().min(1)).optional(),
    removeLabels: z.array(z.string().min(1)).optional(),
  })
  .refine(
    (a) => a.status !== undefined || a.addLabels?.length || a.removeLabels?.length,
    "nothing to update — pass `status`, `addLabels`, or `removeLabels`",
  );

/** Resolve the board's project: the named one, or the selected one when the name is omitted. */
async function withBoardProject(
  ctx: OpContext,
  projectId: string | undefined,
  fn: (p: Project) => Promise<ConciergeToolReply>,
): Promise<ConciergeToolReply> {
  const state = useProjectStore.getState();
  const id = projectId ?? state.selectedProjectId;
  if (!id) {
    return err(
      ctx,
      REGISTRY_CODES.unknownProject,
      "No project is selected, so I don't know whose board to read. Pass a `projectId`.",
    );
  }
  return withProject(ctx, id, fn);
}

const BOARD_ROUTES: Record<BoardOp, Handler> = {
  list_items: route(boardScope, (a, ctx) =>
    withBoardProject(ctx, a.projectId, async (p) => fromBoard(ctx, await listItems(p.rootPath))),
  ),
  get_item: route(boardItem, (a, ctx) =>
    withBoardProject(ctx, a.projectId, async (p) => fromBoard(ctx, await getItem(p.rootPath, a.id))),
  ),
  get_board: route(boardScope, (a, ctx) =>
    withBoardProject(ctx, a.projectId, async (p) => fromBoard(ctx, await getBoard(p.rootPath))),
  ),
  ready_items: route(boardScope, (a, ctx) =>
    withBoardProject(ctx, a.projectId, async (p) => fromBoard(ctx, await readyItems(p.rootPath))),
  ),
  blocked_items: route(boardScope, (a, ctx) =>
    withBoardProject(ctx, a.projectId, async (p) => fromBoard(ctx, await blockedItems(p.rootPath))),
  ),
  // The writes resolve through `withProject` — no store fallback. See boardWriteScope.
  create_item: route(createItemArgs, (a, ctx) =>
    withProject(ctx, a.projectId, async (p) =>
      fromBoard(ctx, await createItem(p.rootPath, a.title, a.body ?? "")),
    ),
  ),
  update_item: route(updateItemArgs, (a, ctx) =>
    withProject(ctx, a.projectId, async (p) =>
      fromBoard(
        ctx,
        await updateItem(p.rootPath, a.id, {
          status: a.status,
          addLabels: a.addLabels,
          removeLabels: a.removeLabels,
        }),
      ),
    ),
  ),
  delete_item: route(boardWriteItem, (a, ctx) =>
    withProject(ctx, a.projectId, async (p) => fromBoard(ctx, await deleteItem(p.rootPath, a.id))),
  ),
};

// ---------------------------------------------------------------------------------------------
// APPROVALS — read-only visibility into the concierge's own pending requests.
// ---------------------------------------------------------------------------------------------

const approvalIdArgs = z.object({ id: z.string().min(1, "an approval id is required") }).strict();

const APPROVALS_ROUTES: Record<ApprovalsOp, Handler> = {
  list_pending_approvals: route(noArgs, (_a, ctx) => fromApprovals(ctx, listPendingApprovals())),
  get_approval: route(approvalIdArgs, (a, ctx) => fromApprovals(ctx, getApproval(a.id))),
};

// ---------------------------------------------------------------------------------------------
// ACCOUNTS — which Claude account has room, and moving the fleet onto it.
// ---------------------------------------------------------------------------------------------

/** The target account. No `confirm` flag: `switch_all` is `disruptive`, so the ASK TIER is its gate
 *  (see accounts.ts's header). A confirm argument here would be a gate a model satisfies by setting
 *  a boolean, in front of the one a human actually answers. */
const switchAllArgs = z
  .object({ accountId: z.string().min(1, "an account id is required") })
  .strict();

const ACCOUNTS_ROUTES: Record<AccountsOp, Handler> = {
  read_usage: route(noArgs, async (_a, ctx) => fromAccounts(ctx, await readUsage())),
  switch_all: route(switchAllArgs, async (a, ctx) => fromAccounts(ctx, await switchAll(a.accountId))),
};

// ---------------------------------------------------------------------------------------------
// RESEARCH — "Concierge Agents": ask a question, keep talking, read the answer later.
// ---------------------------------------------------------------------------------------------

/** 2000 chars is a QUESTION; past that it is a payload, and a research child briefed with a wall of
 *  text answers a different question than the one the human asked. The cap refuses rather than
 *  truncating — a silently clipped brief is the confidently-wrong answer research/types.ts warns
 *  about, one layer up. */
const researchDispatchArgs = z
  .object({
    question: z
      .string()
      .min(1, "say what to find out")
      .max(2000, "keep the question under 2000 characters"),
    /** OPTIONAL, and an omitted one is not an error: a task with no project is a supported state
     *  (research/types.ts), so this falls back to the selected project and then to `null` rather
     *  than refusing. A project NAMED and not found is still a refusal — that is a mistake, not a
     *  choice. */
    projectId: z.string().min(1).optional(),
    depth: z.enum(RESEARCH_DEPTHS).optional(),
  })
  .strict();

const researchTaskIdArgs = z
  .object({ taskId: z.string().min(1, "a research task id is required") })
  .strict();

const RESEARCH_ROUTES: Record<ResearchOp, Handler> = {
  dispatch: route(researchDispatchArgs, async (a, ctx) => {
    // The project is resolved HERE, from the store, for the reason the store-lookup section above
    // states: a model supplies an id at most, never a root, and the runner is handed something this
    // window has confirmed exists.
    const projectId = a.projectId ?? useProjectStore.getState().selectedProjectId ?? null;
    // RESOLVE THE ROOT, not just the id. This used to validate the project and then throw its
    // `rootPath` away, which left the runner with no directory to work in — and the runner's own
    // fallback was the process cwd, so every dispatch would have researched an arbitrary tree and
    // answered confidently about it. Both halves were green and the merge was clean; the defect
    // lived entirely in the gap between them.
    const project = projectId === null ? undefined : findProject(projectId);
    if (!project) {
      return err(
        ctx,
        REGISTRY_CODES.unknownProject,
        a.projectId !== undefined
          ? `No project with id ${a.projectId}.`
          : "I don't have a project selected to research in — name one with `projectId`.",
      );
    }
    return fromResearch(
      ctx,
      await dispatchResearchTask({
        question: a.question,
        projectId: project.id,
        projectRoot: project.rootPath,
        // `quick` is the default the contract names: cheap by default, escalate on demand.
        depth: a.depth ?? "quick",
      }),
    );
  }),
  list: route(noArgs, async (_a, ctx) => fromResearch(ctx, await listResearchTasks())),
  get: route(researchTaskIdArgs, async (a, ctx) =>
    fromResearch(ctx, await getResearchTask(a.taskId)),
  ),
  cancel: route(researchTaskIdArgs, async (a, ctx) =>
    fromResearch(ctx, await cancelResearchTask(a.taskId)),
  ),
};

// The memory domain's argument schemas. `key`/`value`/`query` are the only fields; `.strict()`
// refuses an unrecognized one, matching every other domain.
const memoryRememberArgs = z
  .object({
    key: z.string().min(1, "give the fact a short key to file it under"),
    value: z.string().min(1, "tell me what to remember"),
  })
  .strict();

const memoryRecallArgs = z
  .object({ query: z.string().min(1, "give a keyword or phrase to search memory for") })
  .strict();

const memoryForgetArgs = z
  .object({ key: z.string().min(1, "name the memory key to drop") })
  .strict();

const MEMORY_ROUTES: Record<MemoryOp, Handler> = {
  remember: route(memoryRememberArgs, async (a, ctx) =>
    fromMemory(ctx, await rememberMemory(a.key, a.value)),
  ),
  recall: route(memoryRecallArgs, async (a, ctx) => fromMemory(ctx, await recallMemory(a.query))),
  forget: route(memoryForgetArgs, async (a, ctx) => fromMemory(ctx, await forgetMemory(a.key))),
  list_memories: route(noArgs, async (_a, ctx) => fromMemory(ctx, await listMemories())),
};

/**
 * Does this op change the world? Written as an exhaustive `Record` rather than derived from
 * `RESEARCH_RISK`, so a fifth op is a TYPECHECK FAILURE here until someone decides — which is the
 * completeness a `!== "read-only"` lookup cannot give.
 *
 * `dispatch` is a write even though it is auto-allowed: `write` describes the ACT, `risk` describes
 * how much the human cares, and conflating them is how an approval layer ends up asking about reads.
 */
const RESEARCH_WRITE: Record<ResearchOp, boolean> = {
  dispatch: true,
  list: false,
  get: false,
  cancel: true,
};

// ---------------------------------------------------------------------------------------------
// PLANS — epics and their children, plus the handoff into a build agent.
// ---------------------------------------------------------------------------------------------

const planScope = z.object({ projectId: z.string().min(1).optional() }).strict();
const planIdArgs = planScope.extend({ id: z.string().min(1, "a plan id is required") });

const createPlanArgs = z
  .object({
    projectId: projectIdArg,
    title: z.string().min(1, "a title is required"),
    body: z.string().optional(),
  })
  .strict();

/** Promotion is a WRITE that starts an agent, so it names its project explicitly — same rule as the
 *  board's writes, and for the same reason (the call that runs must be the call that was asked for). */
const promoteArgs = z
  .object({
    projectId: projectIdArg,
    epicId: z.string().min(1, "a plan id is required"),
    /** Repo-relative PRD path, or omitted for a plan with no PRD — sendToBuild then points the
     *  orchestrator at the epic's own description instead of blocking on a file that isn't there. */
    prdPath: z.string().min(1).nullable().optional(),
  })
  .strict();

/** Diff args. `limit`/`maxLines` are OPTIONAL and only ever LOWER the module's cap — the ceiling
 *  lives in Rust, so a hallucinated `limit: 5_000_000` cannot widen it. */
const diffListArgs = z
  .object({ agentId: agentIdArg, limit: z.number().int().positive().optional() })
  .strict();

const diffFileArgs = z
  .object({
    agentId: agentIdArg,
    path: z.string().min(1, "name a path from list_changed_files"),
    maxLines: z.number().int().positive().optional(),
  })
  .strict();

const DIFF_ROUTES: Record<DiffOp, Handler> = {
  list_changed_files: route(diffListArgs, async (a, ctx) =>
    fromDiff(ctx, await listChangedFiles(a.agentId, a.limit)),
  ),
  read_file_diff: route(diffFileArgs, async (a, ctx) =>
    fromDiff(ctx, await readFileDiff(a.agentId, a.path, a.maxLines)),
  ),
  list_commits: route(diffListArgs, async (a, ctx) =>
    fromDiff(ctx, await listCommits(a.agentId, a.limit)),
  ),
};

function fromFleet<T>(ctx: OpContext, r: FleetResult<T>): ConciergeToolReply {
  return r.ok ? ok(ctx, r.data) : err(ctx, r.reason, r.message);
}

/** Level 0: `{ agents: [{agentId, projectId}], baseBranch?, windowMs? }`. */
const fleetDigestArgs = z
  .object({
    agents: z
      .array(z.object({ agentId: agentIdArg, projectId: z.string().min(1) }).strict())
      .min(1, "name at least one agent"),
    baseBranch: z.string().min(1).optional(),
    windowMs: z.number().int().positive().optional(),
  })
  .strict();

/** Level 1 paging. `maxBytes` is clamped Rust-side; a caller may not raise the ceiling. */
const streamArgs = z
  .object({
    agentId: agentIdArg,
    cursor: z.number().int().nonnegative().optional(),
    maxBytes: z.number().int().positive().optional(),
  })
  .strict();

const transcriptArgs = z
  .object({
    transcriptPath: z.string().min(1, "pass hooks.transcriptPath from fleet_digest"),
    cursor: z.number().int().nonnegative().optional(),
    maxBytes: z.number().int().positive().optional(),
  })
  .strict();

const severityArg = z.enum(["fyi", "act"]).optional();

const inboxSendArgs = z
  .object({ agentId: agentIdArg, text: z.string().min(1, "an empty message is not a message"), severity: severityArg })
  .strict();

const inboxBroadcastArgs = z
  .object({
    agentIds: z.array(agentIdArg).min(1, "name at least one recipient"),
    text: z.string().min(1, "an empty message is not a message"),
    severity: severityArg,
  })
  .strict();

const inboxStatusArgs = z.object({ agentIds: z.array(agentIdArg).min(1) }).strict();

const FLEET_ROUTES: Record<FleetOp, Handler> = {
  fleet_digest: route(fleetDigestArgs, async (a, ctx) =>
    fromFleet(ctx, await fleetDigest(a.agents, { baseBranch: a.baseBranch, windowMs: a.windowMs })),
  ),
  read_agent_stream: route(streamArgs, async (a, ctx) =>
    fromFleet(ctx, await readAgentStream(a.agentId, a.cursor, a.maxBytes)),
  ),
  read_agent_transcript: route(transcriptArgs, async (a, ctx) =>
    fromFleet(ctx, await readAgentTranscript(a.transcriptPath, a.cursor, a.maxBytes)),
  ),
  inbox_send: route(inboxSendArgs, async (a, ctx) =>
    fromFleet(ctx, await inboxSend(a.agentId, a.text, a.severity ?? "fyi")),
  ),
  inbox_broadcast: route(inboxBroadcastArgs, async (a, ctx) =>
    fromFleet(ctx, await inboxBroadcast(a.agentIds, a.text, a.severity ?? "fyi")),
  ),
  inbox_status: route(inboxStatusArgs, async (a, ctx) =>
    fromFleet(ctx, await inboxStatus(a.agentIds)),
  ),
};

const PLANS_ROUTES: Record<PlansOp, Handler> = {
  list_plans: route(planScope, (a, ctx) =>
    withBoardProject(ctx, a.projectId, async (p) =>
      fromPlans(ctx, await listPlans(p.rootPath, p.id)),
    ),
  ),
  get_plan: route(planIdArgs, (a, ctx) =>
    withBoardProject(ctx, a.projectId, async (p) =>
      fromPlans(ctx, await getPlan(p.rootPath, p.id, a.id)),
    ),
  ),
  create_plan: route(createPlanArgs, (a, ctx) =>
    withProject(ctx, a.projectId, async (p) =>
      fromPlans(ctx, await createPlan(p.rootPath, a.title, a.body ?? "")),
    ),
  ),
  promote_plan_to_build: route(promoteArgs, (a, ctx) =>
    withProject(ctx, a.projectId, async (p) =>
      fromPlans(ctx, await promotePlanToBuild(p.rootPath, p.id, a.epicId, a.prdPath ?? null)),
    ),
  ),
};

interface DomainEntry {
  routes: Record<string, Handler>;
  /** Whether an op changes the world — asked of the DOMAIN's own classification wherever it has one
   *  (workflow and workspace both publish a risk map; terminal marks each descriptor). */
  write: (op: string) => boolean;
  /** Every op this domain routes, for the tool-listing surfaces. */
  ops: readonly string[];
}

const DOMAINS: Record<ConciergeToolDomain, DomainEntry> = {
  lifecycle: {
    routes: LIFECYCLE_ROUTES,
    write: (op) => LIFECYCLE_WRITE[op as LifecycleOp] ?? true,
    ops: LIFECYCLE_OPS,
  },
  review: {
    routes: REVIEW_ROUTES,
    write: (op) => REVIEW_RISK[op as ReviewOp] !== "read-only",
    ops: REVIEW_OPS,
  },
  terminal: {
    routes: TERMINAL_ROUTES,
    // Unknown ops never reach here (the route lookup refuses first); default to `true` anyway, so
    // the fallback for an unclassified op is the one that gets ASKED about rather than waved through.
    write: (op) => TERMINAL_WRITE[op] ?? true,
    ops: CONCIERGE_TERMINAL_TOOLS.map((t) => t.name),
  },
  attachments: {
    routes: ATTACHMENTS_ROUTES,
    write: (op) => ATTACHMENTS_RISK[op as AttachmentsOp] !== "read-only",
    ops: ATTACHMENTS_OPS,
  },
  workflow: {
    routes: WORKFLOW_ROUTES,
    write: (op) => WORKFLOW_RISK[op as WorkflowOperation]?.risk !== "read-only",
    ops: WORKFLOW_OPERATIONS,
  },
  events: {
    routes: EVENTS_ROUTES,
    // `subscribe`/`unsubscribe` are `routine`, so they report as writes — honestly, since they do
    // mutate the subscription ledger. Both still default to `allow` (policy.ts maps `routine` there),
    // so nothing here asks the human's permission to find out what changed.
    write: (op) => EVENTS_RISK[op as EventsOp] !== "read-only",
    ops: EVENTS_OPS,
  },
  workspace: {
    routes: WORKSPACE_ROUTES,
    write: (op) => WORKSPACE_OP_RISK[op as WorkspaceOp] !== "read-only",
    ops: WORKSPACE_OPS,
  },
  screenshot: {
    routes: SCREENSHOT_ROUTES,
    write: (op) => SCREENSHOT_WRITE[op as ScreenshotOp] ?? true,
    ops: SCREENSHOT_OPS,
  },
  preview_inspect: {
    routes: PREVIEW_INSPECT_ROUTES,
    write: (op) => PREVIEW_INSPECT_RISK[op as PreviewInspectOp] !== "read-only",
    ops: PREVIEW_INSPECT_OPS,
  },
  diff: {
    routes: DIFF_ROUTES,
    write: (op) => DIFF_RISK[op as DiffOp] !== "read-only",
    ops: DIFF_OPS,
  },
  fleet: {
    routes: FLEET_ROUTES,
    write: (op) => FLEET_RISK[op as FleetOp] !== "read-only",
    ops: FLEET_OPS,
  },
  board: {
    routes: BOARD_ROUTES,
    write: (op) => BOARD_RISK[op as BoardOp] !== "read-only",
    ops: BOARD_OPS,
  },
  plans: {
    routes: PLANS_ROUTES,
    write: (op) => PLANS_RISK[op as PlansOp] !== "read-only",
    ops: PLANS_OPS,
  },
  approvals: {
    // Every op is read-only by construction (see approvals.ts), so this is a constant rather than a
    // map lookup. It is written as one anyway — `APPROVALS_RISK` is the classification, and reading
    // it here means a future write-tier op cannot be added without this line noticing.
    routes: APPROVALS_ROUTES,
    write: (op) => APPROVALS_RISK[op as ApprovalsOp] !== "read-only",
    ops: APPROVALS_OPS,
  },
  research: {
    routes: RESEARCH_ROUTES,
    // The domain's OWN write map, not its risk map. `dispatch` is `routine` (auto-allowed) and is
    // still a write; reading the risk word here would report it as one only by accident.
    write: (op) => RESEARCH_WRITE[op as ResearchOp] ?? true,
    ops: RESEARCH_OPS,
  },
  accounts: {
    routes: ACCOUNTS_ROUTES,
    write: (op) => ACCOUNTS_RISK[op as AccountsOp] !== "read-only",
    ops: ACCOUNTS_OPS,
  },
  memory: {
    routes: MEMORY_ROUTES,
    // `remember`/`forget` are `routine` (a write); `recall`/`list` are `read-only`. The risk map
    // answers "is this a write" exactly, so there is no separate MEMORY_WRITE table to keep in step.
    write: (op) => MEMORY_RISK[op as MemoryOp] !== "read-only",
    ops: MEMORY_OPS,
  },
};

/**
 * Does this op CHANGE THE WORLD? The dispatcher's own answer, exposed for readers outside it.
 *
 * This is the question `DomainEntry.write` already answers for the approval path, and exporting it
 * is what stops a second copy being maintained elsewhere — `conciergeLint/checks/askWithoutAction`
 * needs exactly this and had begun hand-listing ops, which cannot stay exhaustive (roborev 56103).
 * `LIFECYCLE_WRITE` and `SCREENSHOT_WRITE` are `Record<Op, boolean>`, so a new op there is a
 * typecheck failure until someone decides — completeness this cannot get from a string array.
 *
 * Returns `undefined` for an unknown domain so the caller can pick its own default rather than
 * inheriting a `false` that would read as "changes nothing".
 */
export function conciergeOpWrites(domain: string, op: string): boolean | undefined {
  const entry = DOMAINS[domain as ConciergeToolDomain];
  return entry ? entry.write(op) : undefined;
}

/** Every domain's op list, for the MCP layer's enums and for tests that assert the two agree. */
export const CONCIERGE_TOOL_OPS: Record<ConciergeToolDomain, readonly string[]> = {
  lifecycle: DOMAINS.lifecycle.ops,
  review: DOMAINS.review.ops,
  terminal: DOMAINS.terminal.ops,
  attachments: DOMAINS.attachments.ops,
  workflow: DOMAINS.workflow.ops,
  events: DOMAINS.events.ops,
  workspace: DOMAINS.workspace.ops,
  screenshot: DOMAINS.screenshot.ops,
  preview_inspect: DOMAINS.preview_inspect.ops,
  board: DOMAINS.board.ops,
  approvals: DOMAINS.approvals.ops,
  plans: DOMAINS.plans.ops,
  diff: DOMAINS.diff.ops,
  fleet: DOMAINS.fleet.ops,
  research: DOMAINS.research.ops,
  accounts: DOMAINS.accounts.ops,
  memory: DOMAINS.memory.ops,
};

function isDomain(v: string): v is ConciergeToolDomain {
  return (CONCIERGE_TOOL_DOMAINS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------------

/**
 * Run one concierge tool call. TOTAL: never throws, never rejects.
 *
 * Order of gates, and it matters:
 *   1. the domain and op must exist            → `unknown-op`
 *   2. the policy must permit the op           → `denied` / `needs-approval`
 *   3. the arguments must validate             → `bad-args`
 *   4. the domain's OWN guards run last        → the domain's own code, verbatim
 *
 * Policy BEFORE arguments is deliberate: a denied tool must be refused as denied, not as a
 * validation error that leaks which arguments it would have wanted.
 */
export async function dispatchConciergeTool(
  call: ConciergeToolCall,
  opts: DispatchOptions = {},
): Promise<ConciergeToolReply> {
  // Everything below reads off the wire, so nothing is assumed to be the type it claims.
  const domain = typeof call?.domain === "string" ? call.domain : "";
  const op = typeof call?.op === "string" ? call.op : "";
  const toolCallId = typeof call?.toolCallId === "string" ? call.toolCallId : "";
  try {
    if (!isDomain(domain)) {
      return bareErr(
        domain,
        op,
        REGISTRY_CODES.unknownOp,
        `There is no concierge tool domain called "${domain}". The domains are: ${CONCIERGE_TOOL_DOMAINS.join(", ")}.`,
      );
    }
    const entry = DOMAINS[domain];
    const handler = Object.prototype.hasOwnProperty.call(entry.routes, op)
      ? entry.routes[op]
      : undefined;
    if (!handler) {
      return bareErr(
        domain,
        op,
        REGISTRY_CODES.unknownOp,
        `The ${domain} domain has no op called "${op}". Its ops are: ${entry.ops.join(", ")}.`,
      );
    }

    const policy = opts.policy ?? permissiveToolPolicy;
    const decision = policy({ domain, op, write: entry.write(op), toolCallId, args: call.args });
    const ctx: OpContext = { domain, op, toolCallId, decision };
    // ══ THE RELAY GATE, AND IT MUST SIT ABOVE THE APPROVAL TIER ══════════════════════════════════
    //
    // GATE 0, ahead of policy — because the two returns below END THE CALL, and one of them comes
    // BACK. `send_to_agent_terminal` is `disruptive`, whose default decision is `ask`, so the common
    // path is: this dispatch returns `needs-approval`, the human clicks approve, and
    // `conciergeApprovalResume` runs the call AGAIN from a click handler. The route body — where
    // this check first lived — is therefore never reached on the first call, and by the time the
    // resumed call reaches it the founder's turn has ended, so `currentConciergeTurnContent()` is
    // empty and the gate fails open. Net effect of placing it lower: a relay of his words to an
    // agent he never named is refused only for the tools that DON'T ask, which is the opposite of
    // the population that matters.
    //
    // Here it is judged on the FIRST call, while the turn state is live — and a send that must not
    // happen never even raises an approval prompt for the human to answer.
    //
    // ARGS READ DEFENSIVELY: this is above zod (see the gate order in this function's header), so
    // the fields are whatever the model sent. That is fine — both are compared, never dispatched,
    // and a non-string simply fails the comparison and allows the call, which is this gate's own
    // fail-open direction (see ./relayGate).
    //
    // EVERY OP THAT CARRIES A MESSAGE TO AN AGENT, not just the terminal one. `fleet.inbox_send`
    // takes the same `text`, classifies to the same `kind: "sent"`, and the badge gate admits
    // `channel: "inbox"` — so gating only the terminal write leaves the founder's ruling walkable by
    // choosing the other tool. `inbox_broadcast` passes every recipient, and is refused if his words
    // would reach ANY agent he did not name.
    if (RELAY_GATED_OPS.has(op)) {
      const a = (call.args ?? {}) as Record<string, unknown>;
      // The recipients, however this op spells them. Read defensively: this is above zod, so the
      // fields are whatever the model sent — a shape that yields no ids simply cannot be shown to
      // be an unaddressed relay, which is this gate's fail-open direction (see ./relayGate).
      const ids = [
        ...(typeof a.agentId === "string" ? [a.agentId] : []),
        ...(Array.isArray(a.agentIds) ? a.agentIds.filter((x): x is string => typeof x === "string") : []),
      ];
      const unaddressed =
        ids.length > 0 && typeof a.text === "string"
          ? refuseUnaddressedRelay(ids, a.text)
          : null;
      if (unaddressed) {
        log.warn("concierge-tools", "send refused — unaddressed relay of the founder's words", {
          domain,
          op,
          recipients: ids.length,
        });
        return err(ctx, REGISTRY_CODES.unaddressedRelay, unaddressed);
      }
    }
    if (decision.tier === "deny") {
      return err(
        ctx,
        REGISTRY_CODES.denied,
        decision.reason?.trim()
          ? `I'm not allowed to run ${domain}.${op}: ${decision.reason}`
          : `I'm not allowed to run ${domain}.${op}.`,
      );
    }
    if (decision.tier === "ask" && decision.approvedByUser !== true) {
      // HONEST AND ACTIONABLE, in that order. This message used to say only "needs your go-ahead",
      // which promised a prompt that did not exist and named no way to change the setting — so the
      // model's only recourse was to keep re-calling a tool that could never succeed.
      //
      // The dispatch does NOT wait: the concierge is a `claude -p` child, one process per turn, and
      // holding this call would hold the turn (and the bridge's 600s round trip) hostage on a human
      // who may be away. So the question is raised in the column and answered there.
      //
      // AND THE APPROVAL RUNS IT — do not tell the model otherwise. This used to end "approve it
      // there and then tell me to go ahead, and I'll run it", which was true when a grant could only
      // be spent by a later retry. Approving now dispatches at click time
      // (services/conciergeApprovalResume), so that sentence invites a DUPLICATE: the human
      // approves (it runs), obediently says "go ahead", and the model calls again for something
      // already done. `policyBinding` refuses that repeat, but the honest fix is not to ask for it —
      // a refusal the model was told to trigger is a refusal that should not have been provoked.
      const settings = `To stop being asked each time, set \`${conciergeToolConfigPath(op)}\` to "Allow" in Settings → Concierge tools.`;
      return err(
        ctx,
        REGISTRY_CODES.needsApproval,
        toolCallId
          ? `${domain}.${op} needs your go-ahead. I've put an approval request in your Sparkle column — approving it there runs it, so there's nothing more for you to tell me. ${settings}`
          : `${domain}.${op} needs your go-ahead, but this call carries no tool-call id, so there is nothing to attach an approval to and I can't raise the prompt. ${settings}`,
      );
    }

    return await handler(call.args, ctx);
  } catch (e) {
    // The bug bucket. A domain that throws instead of returning its typed refusal, a store read that
    // blew up, a schema that did something unexpected — none of it may reach the bridge as a
    // rejection, because on the other end that is a timeout and a hang, not an error.
    const message = e instanceof Error ? e.message : String(e);
    log.error("concierge-tools", "dispatch threw — this is a bug", { domain, op, message });
    return bareErr(
      domain,
      op,
      REGISTRY_CODES.internalError,
      `Something went wrong running ${domain || "?"}.${op || "?"}: ${message}`,
    );
  }
}

/** Re-exported so a caller building a discard intent doesn't have to import lifecycle directly. */
export { DISCARD_CONFIRM_TOKEN };
