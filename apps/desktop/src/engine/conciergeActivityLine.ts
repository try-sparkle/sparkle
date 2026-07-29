// What the concierge is DOING, in a sentence — the policy half of the thinking indicator.
//
// THE COMPLAINT this answers: "the concierge only gives a little '…' to show that it received and
// is thinking. I want it to show more than that." Three dots say a process is alive and nothing
// else; a turn that spends twenty seconds reading two terminals and checking a PR looks exactly
// like a turn that is stuck.
//
// THE SIGNAL IS REAL, and that is the whole design constraint. The concierge drives this app
// through `concierge_tool` control calls, and the frontend dispatches every one of them
// (services/controlListener → services/conciergeTools/registry). So the app already knows, with no
// guessing and no new plumbing through the `claude -p` stream, exactly which tool the brain reached
// for and what it aimed it at. Every line this module produces is a call that actually happened.
// Nothing here animates, invents, or predicts — an op with no phrase says its own name rather than
// being dressed up in a sentence somebody hoped was true.
//
// DOM-free and store-free on purpose, the same as this directory's other policy modules: the store
// that records the calls (services/conciergeActivity) resolves ids to names, and the component
// (components/Concierge/ThinkingIndicator) picks the glyph and paints it. This file only decides
// WHICH subject an op takes and WHAT to call it.
import type { ConciergeToolDomain, TerminalOp } from "../services/conciergeTools/registry";
import type { LifecycleOp } from "../services/conciergeTools/lifecycle";
import type { WorkflowOperation } from "../services/conciergeTools/workflow";
import type { WorkspaceOp } from "../services/conciergeTools/workspace";
import type { BoardOp } from "../services/conciergeTools/board";
import type { ApprovalsOp } from "../services/conciergeTools/approvals";
import type { DiffOp } from "../services/conciergeTools/diff";
import type { PlansOp } from "../services/conciergeTools/plans";

/** Which glyph family a line wears. A KIND, not a component: this module stays React-free, and the
 *  indicator maps these onto react-icons/fi (this repo uses Feather; no emoji as icons). */
export type ConciergeActivityIcon = "agents" | "terminal" | "workflow" | "workspace";

/** One observed `concierge_tool` call, as the indicator sees it.
 *
 *  `subject` is already RESOLVED to something sayable ("Kraken Auth", "#753") or null when it could
 *  not be — an agent the concierge named by an id no open project holds, most often because it just
 *  closed it. Null is rendered as an honest indefinite ("an agent"), never as a guess. */
export interface ConciergeToolActivity {
  domain: string;
  op: string;
  subject: string | null;
  /** How far the call got — the tense, and whether the past tense is even usable.
   *
   *  `refused` is the one that matters. `dispatchConciergeTool` is TOTAL: a policy denial, an
   *  ask-tier tool the human has not approved, `bad-args`, `unknown-op` and `internal-error` all
   *  come back as ordinary resolved replies with `ok: false`. Treating those as `done` made the
   *  column announce "Merged PR #753" for a merge that was refused — and for the ask tier it said so
   *  in the same 360px column that was simultaneously showing the approval request for it. */
  outcome: "running" | "done" | "refused";
  /** Monotonic, per app run. The indicator uses it to tell activity from THIS turn apart from a
   *  call left over from the last one — see ThinkingIndicator. */
  seq: number;
}

/** The rendered line: a glyph family and one sentence. */
export interface ConciergeActivityLine {
  icon: ConciergeActivityIcon;
  text: string;
}

/**
 * One op's two tenses.
 *
 * `%s` — where the op takes one — is the subject. Two tenses rather than one string plus a suffix
 * because the indicator says two different true things: "Reading Kraken Auth's terminal…" while the
 * call is in flight, and "Read Kraken Auth's terminal" once it came back and the brain is thinking
 * again. Fudging that with a single present-tense phrase would leave the column claiming to be doing
 * something it finished seconds ago, which is the exact failure this feature exists to avoid.
 *
 * A REFUSED call gets neither: it is reported from the present phrase as an attempt ("Tried reading
 * Kraken Auth's terminal") — see {@link conciergeActivityLine}.
 */
interface OpPhrase {
  present: string;
  past: string;
  /** What `%s` becomes when the subject could not be resolved. */
  indefinite?: string;
}

/** A phrase that names a subject. Written as a template literal type so the compiler can tell the
 *  two shapes apart — see {@link phrase}. */
type SubjectTemplate = `${string}%s${string}`;

/** The same, negated: `never` for a template that DOES carry `%s`. */
type WithoutSubject<T extends string> = T extends SubjectTemplate ? never : T;

/**
 * Build one phrase, with the `%s`/`indefinite` pairing ENFORCED BY THE COMPILER.
 *
 * The rule it enforces: a phrase containing `%s` must supply the noun that `%s` degrades to when the
 * subject cannot be resolved — which is a NORMAL outcome here, not an edge case (an agent closed
 * before its own reply lands, a project just removed). Left to a comment, the first op added without
 * one would put "Reading 's terminal" in front of the founder, and nothing would fail.
 *
 * The two overloads are what makes the omission unrepresentable. `P & WithoutSubject<P>` is the load
 * bearing half: `P` is inferred from the intersection's first member, and the second collapses to
 * `never` for a template with `%s`, so the subject-less overload cannot accept one — leaving the
 * three-argument overload, which demands the noun.
 */
function phrase<P extends string>(present: P & WithoutSubject<P>, past: string): OpPhrase;
function phrase(present: SubjectTemplate, past: SubjectTemplate, indefinite: string): OpPhrase;
function phrase(present: string, past: string, indefinite?: string): OpPhrase {
  return { present, past, indefinite };
}

const AGENT = "an agent";
const PROJECT = "a project";
/** A PR's subject carries its own noun ("PR #753"), so the templates must NOT spell out "PR"
 *  themselves — one that did read "Checking PR the PR's checks" the moment the number was missing.
 *  The recorder formats the subject to match (services/conciergeActivity). */
const PR = "the PR";

/** Records over each domain's OWN op union, so a domain that gains an op the indicator cannot
 *  describe is a typecheck failure rather than a silent fallback. Same technique the registry's
 *  route tables use, for the same reason. */
const LIFECYCLE_PHRASES: Record<LifecycleOp, OpPhrase> = {
  spawn_build_agent: phrase("Starting a new agent", "Started a new agent"),
  spawn_cloud_build_agent: phrase("Starting a cloud agent", "Started a cloud agent"),
  preview_close: phrase("Checking what closing %s would do", "Checked what closing %s would do", AGENT),
  preview_discard: phrase("Checking what discarding %s would lose", "Checked what discarding %s would lose", AGENT),
  close_agent: phrase("Closing %s", "Closed %s", AGENT),
  ship_agent: phrase("Shipping %s's work", "Shipped %s's work", AGENT),
  save_agent: phrase("Saving %s's work", "Saved %s's work", AGENT),
  discard_agent: phrase("Discarding %s", "Discarded %s", AGENT),
  spin_down_worker: phrase("Spinning down %s", "Spun down %s", AGENT),
};

const TERMINAL_PHRASES: Record<TerminalOp, OpPhrase> = {
  read_agent_terminal: phrase("Reading %s's terminal", "Read %s's terminal", AGENT),
  get_agent_status: phrase("Checking on %s", "Checked on %s", AGENT),
  read_picker_options: phrase("Reading %s's options", "Read %s's options", AGENT),
  select_picker_option: phrase("Answering %s's prompt", "Answered %s's prompt", AGENT),
  send_control_key: phrase("Pressing a key in %s", "Pressed a key in %s", AGENT),
  send_to_agent_terminal: phrase("Writing to %s", "Wrote to %s", AGENT),
};

const WORKFLOW_PHRASES: Record<WorkflowOperation, OpPhrase> = {
  agent_branch_status: phrase("Checking %s's branch", "Checked %s's branch", AGENT),
  agent_workflow_state: phrase("Working out where %s stands", "Worked out where %s stands", AGENT),
  project_agents_status: phrase("Checking every agent in %s", "Checked every agent in %s", PROJECT),
  project_open_prs: phrase("Listing %s's open PRs", "Listed %s's open PRs", PROJECT),
  // The "PR" belongs to the SUBJECT ("PR #753"), not to the template — see the PR note beside
  // `indefinite`. A template that spelled it out read "Checking PR the PR's checks" the moment the
  // number was missing.
  pr_checks_status: phrase("Checking %s's checks", "Checked %s's checks", PR),
  pr_owner: phrase("Working out who owns %s", "Worked out who owns %s", PR),
  // "review" rather than "roborev": the human reading this line cares that the code was reviewed,
  // not which daemon did it. Same PR subject rule as the line above.
  pr_roborev_status: phrase("Checking %s's review", "Checked %s's review", PR),
  agent_landed_check: phrase("Checking whether %s's work landed", "Checked whether %s's work landed", AGENT),
  refresh_agent_branch: phrase("Refreshing %s's branch", "Refreshed %s's branch", AGENT),
  land_agent_branch: phrase("Landing %s's branch", "Landed %s's branch", AGENT),
  push_agent_branch: phrase("Pushing %s's branch", "Pushed %s's branch", AGENT),
  open_agent_pr: phrase("Opening a PR for %s", "Opened a PR for %s", AGENT),
  merge_pr: phrase("Merging %s", "Merged %s", PR),
  delete_agent_branch: phrase("Deleting %s's branch", "Deleted %s's branch", AGENT),
  delete_agent_branch_if_merged: phrase("Tidying up %s's branch", "Tidied up %s's branch", AGENT),
};

const WORKSPACE_PHRASES: Record<WorkspaceOp, OpPhrase> = {
  list_projects: phrase("Looking over your projects", "Looked over your projects"),
  select_project: phrase("Switching to %s", "Switched to %s", PROJECT),
  open_project_tab: phrase("Opening %s", "Opened %s", PROJECT),
  close_project_tab: phrase("Closing %s", "Closed %s", PROJECT),
  stop_project_agents: phrase("Stopping %s's agents", "Stopped %s's agents", PROJECT),
  set_project_pinned: phrase("Pinning %s", "Pinned %s", PROJECT),
  reorder_project_tab: phrase("Reordering your tabs", "Reordered your tabs"),
  add_project_from_folder: phrase("Adding a project", "Added a project"),
  remove_project: phrase("Removing %s", "Removed %s", PROJECT),
  relocate_project: phrase("Moving %s", "Moved %s", PROJECT),
  show_main_window: phrase("Bringing Sparkle forward", "Brought Sparkle forward"),
  set_helper_enabled: phrase("Adjusting the helper window", "Adjusted the helper window"),
  set_helper_bounds: phrase("Moving the helper window", "Moved the helper window"),
  search_history: phrase("Searching your history", "Searched your history"),
  jump_to_history_hit: phrase("Jumping to a moment in your history", "Jumped to a moment in your history"),
  quit_app: phrase("Quitting Sparkle", "Quit Sparkle"),
};

/** The work-graph ops. `%s` is never used here: a bead id is not a name the human recognises, and
 *  resolving it would need a `bd` round-trip on the render path.
 *
 *  Typed over the domain's own op union — like every other table here — so a new board op is a
 *  COMPILE error rather than a silent fall through to the un-phrased "Using board · …" default. */
const BOARD_PHRASES: Record<BoardOp, OpPhrase> = {
  list_items: phrase("Reading your task list", "Read your task list"),
  get_item: phrase("Looking up a task", "Looked up a task"),
  get_board: phrase("Reading your board", "Read your board"),
  ready_items: phrase("Checking what's ready to start", "Checked what's ready to start"),
  blocked_items: phrase("Checking what's blocked", "Checked what's blocked"),
  create_item: phrase("Filing a task", "Filed a task"),
  update_item: phrase("Updating a task", "Updated a task"),
  delete_item: phrase("Deleting a task", "Deleted a task"),
};

/** The approval-visibility ops — how the concierge checks on something it asked YOU for. */
const APPROVALS_PHRASES: Record<ApprovalsOp, OpPhrase> = {
  list_pending_approvals: phrase("Checking what's waiting on you", "Checked what's waiting on you"),
  get_approval: phrase("Checking an approval", "Checked an approval"),
};

/** The Plan-side ops. Typed over the domain's op union like every other table here, so a new plan
 *  op is a compile error rather than an un-phrased fallback. */
const PLANS_PHRASES: Record<PlansOp, OpPhrase> = {
  list_plans: phrase("Reading your plans", "Read your plans"),
  get_plan: phrase("Looking at a plan", "Looked at a plan"),
  create_plan: phrase("Writing up a plan", "Wrote up a plan"),
  promote_plan_to_build: phrase("Handing a plan to a build agent", "Handed a plan to a build agent"),
};

const DIFF_PHRASES: Record<DiffOp, OpPhrase> = {
  list_changed_files: phrase("Looking at what %s changed", "Looked at what %s changed", AGENT),
  read_file_diff: phrase("Reading a file %s changed", "Read a file %s changed", AGENT),
  list_commits: phrase("Reading %s's commits", "Read %s's commits", AGENT),
};

/** Domain → its phrase table and its glyph. Keyed on the registry's own domain union, so a new
 *  domain cannot be added without deciding how the column describes it.
 *
 *  `board` and `approvals` reuse existing glyphs rather than introducing their own: the icon union
 *  is consumed by the indicator's renderer, and a new value there is a UI change with no bearing on
 *  what these ops DO. Worth revisiting if the column ever grows a real board glyph. */
const DOMAINS: Record<
  ConciergeToolDomain,
  { icon: ConciergeActivityIcon; phrases: Record<string, OpPhrase | undefined> }
> = {
  lifecycle: { icon: "agents", phrases: LIFECYCLE_PHRASES },
  terminal: { icon: "terminal", phrases: TERMINAL_PHRASES },
  workflow: { icon: "workflow", phrases: WORKFLOW_PHRASES },
  workspace: { icon: "workspace", phrases: WORKSPACE_PHRASES },
  board: { icon: "workspace", phrases: BOARD_PHRASES },
  approvals: { icon: "agents", phrases: APPROVALS_PHRASES },
  plans: { icon: "workspace", phrases: PLANS_PHRASES },
  // Reuses the workflow glyph: reading a diff is asking about the shape of landed work, which is the
  // same question the workflow ops answer from the other side.
  diff: { icon: "workflow", phrases: DIFF_PHRASES },
};

/** What an op's `%s` refers to, so the recorder knows which id to resolve into a name.
 *
 *  Derived from the arguments the call actually carried rather than from a per-op table: every one
 *  of the registry's schemas names its subject `agentId`, `number` (a PR) or `projectId`, and an op
 *  that grows a new argument shape simply resolves to null — an indefinite phrase — instead of
 *  naming the wrong thing. Read in that order because an agent-scoped op is about the AGENT even
 *  though several also carry the project it lives in. */
export type ConciergeActivitySubject =
  | { kind: "agent"; agentId: string }
  | { kind: "pr"; number: number }
  | { kind: "project"; projectId: string }
  | null;

export function conciergeActivitySubject(args: unknown): ConciergeActivitySubject {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  if (typeof a.agentId === "string" && a.agentId) return { kind: "agent", agentId: a.agentId };
  if (typeof a.number === "number" && Number.isFinite(a.number)) {
    return { kind: "pr", number: a.number };
  }
  if (typeof a.projectId === "string" && a.projectId) {
    return { kind: "project", projectId: a.projectId };
  }
  return null;
}

/**
 * The line for one observed call, or null when there is nothing honest to say — an unknown DOMAIN,
 * which only happens for a malformed call the registry itself would refuse. The indicator falls
 * back to the plain pulse on null; a wrong sentence is worse than three dots.
 *
 * An unknown OP inside a known domain is different, and deliberately still rendered: the tool name
 * is a fact, so it is shown verbatim ("Using terminal · read_agent_screen") rather than run through
 * a phrase this module made up for it. That is the shape a newly-added tool takes until somebody
 * writes it a sentence — informative, and visibly un-polished so it gets one.
 *
 * A REFUSED call reads as an attempt — "Tried merging PR #753" — built from the PRESENT phrase, not
 * the past one. Nothing happened, so the past tense would be a plain falsehood (the ask tier makes
 * that vivid: the same column would show "Merged PR #753" beside the approval request for the merge
 * it is still waiting on). Reporting the attempt rather than dropping the line keeps the honest
 * information a refusal carries — the concierge did reach for that tool — and it is what makes a
 * denied tool visible to the human who denied it.
 */
export function conciergeActivityLine(
  activity: ConciergeToolActivity,
): ConciergeActivityLine | null {
  const domain = DOMAINS[activity.domain as ConciergeToolDomain];
  if (!domain) return null;
  const phrase = domain.phrases[activity.op];
  if (!phrase) {
    if (!activity.op) return null;
    // THE UN-PHRASED BRANCH TAKES THE TENSE TOO, and it is not a formality: `unknown-op` is one of
    // the refusal codes, and it is the one that lands HERE. A model that hallucinates an op —
    // `workflow.squash_pr` — is recorded before validation, refused, and would otherwise leave the
    // column reading "Using workflow · squash_pr" for the rest of the turn: an action this app has
    // no code for, asserted in the present tense.
    const verb =
      activity.outcome === "done" ? "Used" : activity.outcome === "refused" ? "Tried using" : "Using";
    return { icon: domain.icon, text: `${verb} ${activity.domain} · ${activity.op}` };
  }
  const template = activity.outcome === "done" ? phrase.past : phrase.present;
  const filled = template.replace("%s", activity.subject ?? phrase.indefinite ?? "");
  // "Reading %s's terminal" → "Tried reading …". Every present phrase is a capitalised participle
  // (they are sentence openers), so lowering the first letter is all the frame needs — no second
  // table, and no op can be added that has a present tense but no attempt phrasing.
  const text =
    activity.outcome === "refused"
      ? `Tried ${filled.charAt(0).toLowerCase()}${filled.slice(1)}`
      : filled;
  return { icon: domain.icon, text };
}
