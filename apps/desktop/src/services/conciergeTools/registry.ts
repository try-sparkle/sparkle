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

import {
  DISCARD_CONFIRM_TOKEN,
  LIFECYCLE_OPS,
  closeAgent,
  discardAgent,
  previewClose,
  previewDiscard,
  saveAgent,
  shipAgent,
  spawnBuildAgent,
  spinDownWorkerAgent,
  type LifecycleOp,
  type LifecycleResult,
} from "./lifecycle";
import {
  CONCIERGE_TERMINAL_TOOLS,
  getAgentStatus,
  readAgentTerminal,
  sendToAgentTerminal,
} from "./terminal";
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
  projectAgentsStatusTool,
  projectOpenPrsTool,
  pushAgentBranchTool,
  refreshAgentBranchTool,
  type AgentWorkflowContext,
  type WorkflowOperation,
  type WorkflowResult,
} from "./workflow";
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
import { conciergeToolConfigPath } from "./policy";
import { conciergeToolAuthority, type ToolPolicyDecision } from "../dispatchAuthority";
import { useProjectStore } from "../../stores/projectStore";
import { log } from "../../logger";
import type { AgentTab, Project } from "../../types";
import type { HistoryHit } from "../history";

// ---------------------------------------------------------------------------------------------
// The wire shapes
// ---------------------------------------------------------------------------------------------

/** The four tool domains, exactly as they appear on the wire. */
export const CONCIERGE_TOOL_DOMAINS = ["lifecycle", "terminal", "workflow", "workspace"] as const;

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
function fromLifecycle<T>(ctx: OpContext, r: LifecycleResult<T>): ConciergeToolReply {
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

/** workspace: `{ ok, op, risk, value }` | `{ ok: false, …, reason, message }`. Note `value`, not
 *  `data` — the one place the four conventions differ in the SUCCESS arm too. */
function fromWorkspace<T>(ctx: OpContext, r: WorkspaceResult<T>): ConciergeToolReply {
  return r.ok ? ok(ctx, r.value) : err(ctx, r.reason, r.message);
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

const LIFECYCLE_ROUTES: Record<LifecycleOp, Handler> = {
  spawn_build_agent: route(spawnArgs, (a, ctx) =>
    fromLifecycle(ctx, spawnBuildAgent({ projectId: a.projectId, runtime: a.runtime ?? "local" })),
  ),
  // Routed rather than omitted so the model gets lifecycle's honest "this bills per minute and needs
  // a goal up front" refusal instead of an `unknown-op` that reads like a bug.
  spawn_cloud_build_agent: route(spawnArgs, (a, ctx) =>
    fromLifecycle(ctx, spawnBuildAgent({ projectId: a.projectId, runtime: "cloud" })),
  ),
  preview_close: route(agentOnly, (a, ctx) => fromLifecycle(ctx, previewClose(a.agentId))),
  preview_discard: route(agentOnly, (a, ctx) => fromLifecycle(ctx, previewDiscard(a.agentId))),
  close_agent: route(agentOnly, async (a, ctx) => fromLifecycle(ctx, await closeAgent(a.agentId))),
  ship_agent: route(agentOnly, async (a, ctx) => fromLifecycle(ctx, await shipAgent(a.agentId))),
  save_agent: route(agentOnly, async (a, ctx) => fromLifecycle(ctx, await saveAgent(a.agentId))),
  discard_agent: route(discardArgs, async (a, ctx) =>
    // `as never`-free: discardAgent's parameter is typed, but the value is unknown, so it goes
    // through the same `isDiscardIntent` check every other caller does. A missing intent lands on
    // `intent-required`, not on a crash and not on a delete.
    fromLifecycle(ctx, await discardAgent(a.agentId, a.intent as Parameters<typeof discardAgent>[1])),
  ),
  spin_down_worker: route(agentOnly, async (a, ctx) =>
    fromLifecycle(ctx, await spinDownWorkerAgent(a.agentId)),
  ),
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
  ship_agent: true,
  save_agent: true,
  discard_agent: true,
  spin_down_worker: true,
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

const sendTerminalArgs = z
  .object({
    agentId: agentIdArg,
    text: z.string().min(1, "there is nothing to send"),
    userPrompt: z.boolean().optional(),
  })
  .strict();

const TERMINAL_ROUTES: Record<TerminalOp, Handler> = {
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
    const r = await sendToAgentTerminal(a.agentId, a.text, authority, {
      userPrompt: a.userPrompt,
    });
    return r.ok ? ok(ctx, r) : err(ctx, r.path, r.detail);
  }),
};

/** Read vs write, straight off each descriptor — terminal already classifies itself. */
const TERMINAL_WRITE: Record<string, boolean> = Object.fromEntries(
  CONCIERGE_TERMINAL_TOOLS.map((t) => [t.name, t.write]),
);

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
    withProject(ctx, a.projectId, async (p) => fromWorkflow(ctx, await projectOpenPrsTool(p.rootPath))),
  ),
  pr_checks_status: route(prNumberArgs, (a, ctx) =>
    withProject(ctx, a.projectId, async (p) =>
      fromWorkflow(ctx, await prChecksStatusTool(p.rootPath, a.number)),
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
          number: a.number,
          // Forwarded so mergePrTool's runtime backstop — not this schema — is what refuses them.
          ...(a.method !== undefined ? { method: a.method as "merge" } : {}),
          ...(a.auto !== undefined ? { auto: a.auto as never } : {}),
          ...(a.squash !== undefined ? { squash: a.squash as never } : {}),
          ...(a.rebase !== undefined ? { rebase: a.rebase as never } : {}),
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

const searchHistoryArgs = z
  .object({ query: z.string(), limit: z.number().int().positive().optional() })
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
    fromWorkspace(ctx, await searchHistory(a.query, a.limit)),
  ),
  jump_to_history_hit: route(historyHitArgs, (a, ctx) =>
    fromWorkspace(ctx, jumpToHistoryHit(a.hit as HistoryHit)),
  ),
  quit_app: route(z.object({ confirm: confirmArg }).strict(), async (a, ctx) =>
    fromWorkspace(ctx, await quitApp({ confirm: a.confirm === true })),
  ),
};

// ---------------------------------------------------------------------------------------------
// The domain table
// ---------------------------------------------------------------------------------------------

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
  terminal: {
    routes: TERMINAL_ROUTES,
    // Unknown ops never reach here (the route lookup refuses first); default to `true` anyway, so
    // the fallback for an unclassified op is the one that gets ASKED about rather than waved through.
    write: (op) => TERMINAL_WRITE[op] ?? true,
    ops: CONCIERGE_TERMINAL_TOOLS.map((t) => t.name),
  },
  workflow: {
    routes: WORKFLOW_ROUTES,
    write: (op) => WORKFLOW_RISK[op as WorkflowOperation]?.risk !== "read-only",
    ops: WORKFLOW_OPERATIONS,
  },
  workspace: {
    routes: WORKSPACE_ROUTES,
    write: (op) => WORKSPACE_OP_RISK[op as WorkspaceOp] !== "read-only",
    ops: WORKSPACE_OPS,
  },
};

/** Every domain's op list, for the MCP layer's enums and for tests that assert the two agree. */
export const CONCIERGE_TOOL_OPS: Record<ConciergeToolDomain, readonly string[]> = {
  lifecycle: DOMAINS.lifecycle.ops,
  terminal: DOMAINS.terminal.ops,
  workflow: DOMAINS.workflow.ops,
  workspace: DOMAINS.workspace.ops,
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
