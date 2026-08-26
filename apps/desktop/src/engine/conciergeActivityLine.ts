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
import type { ReviewOp } from "../services/conciergeTools/review";
import type { AttachmentsOp } from "../services/conciergeTools/attachments";
import type { WorkflowOperation } from "../services/conciergeTools/workflow";
import type { EventsOp } from "../services/conciergeTools/events";
import type { WorkspaceOp } from "../services/conciergeTools/workspace";
import type { ScreenshotOp } from "../services/conciergeTools/screenshot";
import type { PreviewInspectOp } from "../services/conciergeTools/previewInspect";
import type { BoardOp } from "../services/conciergeTools/board";
import type { ApprovalsOp } from "../services/conciergeTools/approvals";
import type { DiffOp } from "../services/conciergeTools/diff";
import type { FleetOp } from "../services/conciergeTools/fleet";
import type { PlansOp } from "../services/conciergeTools/plans";
import type { ResearchOp } from "../services/conciergeTools/research";
import type { AccountsOp } from "../services/conciergeTools/accounts";
import type { MemoryOp } from "../services/conciergeTools/memory";
import type { DispatchMemoryOp } from "../services/conciergeTools/dispatchMemory";
import type { PublishOp } from "../services/conciergeTools/publish";
import { conciergeNativeToolLine } from "./conciergeNativeToolLine";

/** Which glyph family a line wears. A KIND, not a component: this module stays React-free, and the
 *  indicator maps these onto react-icons/fi (this repo uses Feather; no emoji as icons). */
export type ConciergeActivityIcon = "agents" | "terminal" | "workflow" | "workspace";

/**
 * The reserved `domain` for a NATIVE Claude Code tool call — `Bash`, `Read`, `Grep`, `Task` — as
 * opposed to a `concierge_tool` control call.
 *
 * ══ WHY THIS EXISTS: THE DOTS THE FOUNDER KEPT SEEING ═══════════════════════════════════════════
 * Every phrase table above describes a CONTROL call, dispatched through services/controlListener.
 * Those are a minority of what a turn actually does. The concierge also shells out — `git`, `gh`,
 * `bd`, `roborev` — reads files, greps the codebase and dispatches subagents, and until now not one
 * of those was reported anywhere. The column had nothing to say for the majority of a turn's
 * elapsed time, so it fell back to the bare pulse, and the founder's complaint was precise: *"when
 * I ask you a question and I see three dots that go from gray to orange to red, I'm wondering what
 * more context you can give me about what you're actually doing."*
 *
 * The signal was already being parsed — Rust reads every `tool_use` block off the same stream the
 * deltas come from — it was simply not being sent until the turn was over, which is the one moment
 * a status line is worthless. It is now emitted live (`concierge:tool`).
 *
 * The PHRASING for these lives in ./conciergeNativeToolLine rather than here, because sniffing a
 * shell command's leading verb is a different kind of decision from mapping a known op to a
 * sentence: this file's tables are TOTAL over closed unions the compiler checks, while that one is
 * a heuristic over an open set and has to degrade honestly when it does not recognise something.
 */
export const NATIVE_DOMAIN = "native";

/**
 * The reserved `domain` for a TURN PHASE — a state of the turn itself rather than a tool it ran.
 *
 * ══ WHY A SYNTHETIC ENTRY IS STILL "OBSERVED" ═══════════════════════════════════════════════════
 * services/conciergeActivity's header states the rule this has to answer to: *everything here is
 * observed, never predicted.* These entries keep that rule. `reading_message` is recorded when a
 * turn is STARTED — the send genuinely happened, and "reading your message" is the true description
 * of a turn that has been handed a prompt and not yet done anything else. `composing` is recorded
 * when the first assistant TEXT DELTA arrives — the app is at that moment literally receiving the
 * reply. Neither guesses at the model's inner state, and neither is a prediction: both name an
 * event the app watched happen.
 *
 * They exist because the founder's bar is that the fallback should be *rare enough that seeing it
 * counts as a bug*. Without them there are two guaranteed dead zones in every single turn — the gap
 * between sending and the first tool call, and the stretch after the last tool call while the reply
 * streams — and both are stretches where the human is most likely to be staring at the column
 * wondering whether anything is happening.
 */
export const PHASE_DOMAIN = "phase";

/** The turn phases. A closed union so the phrase table below is total over it. */
export type ConciergePhase = "reading_message" | "composing";

/**
 * What each phase says. Present tense only, and the `past` is deliberately identical in shape to
 * the tables above so the same renderer handles it — but a phase never settles: it is superseded by
 * the next thing that happens, never "finished".
 */
const PHASE_PHRASES: Record<ConciergePhase, { text: string; icon: ConciergeActivityIcon }> = {
  // The founder's own first item: "Reading your message".
  reading_message: { text: "Reading your message", icon: "workspace" },
  // The founder's own last item: "Composing".
  composing: { text: "Composing", icon: "workspace" },
};

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
  /** The subject's AGENT ID, when the subject is an agent that still resolves — null otherwise.
   *
   *  Carried BESIDE `subject` rather than replacing it, and the redundancy is the point: `subject`
   *  is what the sentence says, and this is what a click would open. A line that has the name but
   *  not the id is still a correct sentence; it simply cannot be a pill. Keeping them separate is
   *  what stops the id from ever being rendered as words when resolution fails. */
  agentId?: string | null;
  /**
   * For a NATIVE call ({@link NATIVE_DOMAIN}) only: the tool's arguments, as Rust's compact JSON,
   * CLAMPED AT 512 CHARS AND THEREFORE POSSIBLY NOT VALID JSON. Whoever reads it must guard the
   * parse — see services/concierge's `ConciergeToolEvent`.
   *
   * Carried here rather than stuffed into `subject` because it is not a subject: it is the raw
   * material a heuristic reads to DECIDE the subject, and it must never be rendered. `subject` is
   * what the sentence says; this never reaches a screen.
   */
  nativeInput?: string;
}

/** The rendered line: a glyph family and one sentence.
 *
 *  `agentRef` is present only when the sentence names an agent the reader could open — the pieces
 *  either side of the subject plus the name itself, so the component can draw a live pill where the
 *  name goes without re-deriving the split (slicing it back out of `text` by offset is the same
 *  answer arrived at fragilely). `text` is ALWAYS the complete plain sentence, including the name,
 *  because it is what the screen reader is given and what a test can assert in one string. */
export interface ConciergeActivityLine {
  icon: ConciergeActivityIcon;
  text: string;
  agentRef?: {
    agentId: string;
    /** The name as it stood when the call was recorded. The pill re-resolves the id and prefers the
     *  LIVE name; this is only what it falls back to if the agent has gone since. */
    name: string;
    before: string;
    after: string;
  };
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
 *
 * ══ THE TENSES ARE GUARDED INDEPENDENTLY, AND THAT IS NEW ═══════════════════════════════════════
 * The first cut required BOTH tenses to carry `%s` or neither, which read as tidiness and was
 * actually a constraint on meaning — it made the one phrase shape this feature needs
 * unrepresentable. `spawn_build_agent` is the case: the call CREATES its own subject, so while it is
 * in flight there is genuinely no agent to name ("Starting a new agent"), and only once it replies
 * does an id exist to name one with ("Started @Kraken Auth"). A rule that forces a `%s` into the
 * present tense too would have the column naming an agent that does not exist yet.
 *
 * So each tense is checked on its own, and the noun is demanded when EITHER carries a slot. The
 * asymmetric shape stays honest at both ends: an unresolvable subject still degrades to "Started a
 * new agent" rather than to "Started ".
 */
function phrase<P extends string, Q extends string>(
  present: P & WithoutSubject<P>,
  past: Q & WithoutSubject<Q>,
): OpPhrase;
function phrase(present: string, past: string, indefinite: string): OpPhrase;
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
  // PROGRESSIVE DISCLOSURE, and the asymmetry between the two tenses is the whole feature.
  //
  // The founder's ask: *"once you have the agent ID, it would say starting agent 12345 except that
  // would render as a pill so I would see it as Build 17 or whatever. And then as it renames, I
  // would see it rename."* Before the reply lands there is no agent — the call is what creates it —
  // so the present tense names nothing and says so. Once it lands, the id exists, the subject
  // resolves through it (see `conciergeActivityResultSubject`), and the past tense hands the
  // component a pill that tracks every later rename in place.
  //
  // `a new agent` is not decoration: a spawn that succeeds and is then closed before its own reply
  // is rendered resolves to nothing, and "Started a new agent" is the true sentence for that.
  spawn_build_agent: phrase("Starting a new agent", "Started %s", "a new agent"),
  spawn_cloud_build_agent: phrase("Starting a cloud agent", "Started a cloud agent"),
  preview_close: phrase("Checking what closing %s would do", "Checked what closing %s would do", AGENT),
  preview_discard: phrase("Checking what discarding %s would lose", "Checked what discarding %s would lose", AGENT),
  close_agent: phrase("Closing %s", "Closed %s", AGENT),
  // "Retiring", NOT "Closing", and for the reason the whole `retired` vocabulary exists: a close is
  // something the founder asked for while watching, a retirement is the concierge deciding on its
  // own that a finished agent is done with. He is reading this column precisely to catch the app
  // doing things he did not ask for, so the one op he did not request must not borrow the wording of
  // the ops he did.
  retire_agent: phrase("Retiring %s", "Retired %s", AGENT),
  // "Restarting", not "Closing" or "Starting": a human reading this column must not think their
  // agent was torn down and replaced. It is the same terminal with the same resumed conversation.
  restart_agent: phrase("Restarting %s's terminal", "Restarted %s's terminal", AGENT),
  // "Stopping ... terminal", with the noun spelled out for the same reason. A bare "Stopping %s"
  // reads as the agent being ended, which is `close_agent`'s meaning — this kills only the process,
  // and the tab, worktree and branch all survive.
  stop_agent: phrase("Stopping %s's terminal", "Stopped %s's terminal", AGENT),
  ship_agent: phrase("Shipping %s's work", "Shipped %s's work", AGENT),
  save_agent: phrase("Saving %s's work", "Saved %s's work", AGENT),
  discard_agent: phrase("Discarding %s", "Discarded %s", AGENT),
  spin_down_worker: phrase("Spinning down %s", "Spun down %s", AGENT),
  // "Resuming", not "Restarting": the human reading this column should be able to tell the
  // concierge unwedging a terminal apart from an orchestrator picking its own stalled worker back
  // up, because only one of those is something they might have asked for.
  resume_worker: phrase("Resuming %s", "Resumed %s", AGENT),
};

/** The roborev ops. `%s` is never used: a finding id is a bare number the human has no way to
 *  recognise, and roborev's own store is the only thing that could turn it into a name.
 *
 *  Typed over the domain's own op union like every other table here, so a new review op is a COMPILE
 *  error rather than a silent fall through to the un-phrased "Using review · …" default. */
const REVIEW_PHRASES: Record<ReviewOp, OpPhrase> = {
  list_findings: phrase("Checking code review findings", "Checked code review findings"),
  get_finding: phrase("Reading a review finding", "Read a review finding"),
  // "Resolving", not "Closing": a human reading the column should not have to wonder whether an
  // AGENT was just closed. `close_agent` already owns that verb one table up.
  close_finding: phrase("Resolving a review finding", "Resolved a review finding"),
};

const TERMINAL_PHRASES: Record<TerminalOp, OpPhrase> = {
  read_agent_terminal: phrase("Reading %s's terminal", "Read %s's terminal", AGENT),
  get_agent_status: phrase("Checking on %s", "Checked on %s", AGENT),
  read_picker_options: phrase("Reading %s's options", "Read %s's options", AGENT),
  select_picker_option: phrase("Answering %s's prompt", "Answered %s's prompt", AGENT),
  send_control_key: phrase("Pressing a key in %s", "Pressed a key in %s", AGENT),
  // "a pager", not "a key": the human reading this column needs to know the concierge is UNSTICKING
  // an agent, not steering one. The two acts look identical in a generic "pressed a key" line, and
  // the whole reason this op exists is that the first was impossible (bead sparkle-w11lll).
  quit_alternate_screen: phrase("Getting %s out of a pager", "Got %s out of a pager", AGENT),
  send_to_agent_terminal: phrase("Writing to %s", "Wrote to %s", AGENT),
};

/** The file-attachment ops. Every one names the AGENT, never the file: a path is not a name the
 *  human recognises, and the compose box's own chips are where they see what is attached. Saying
 *  the path aloud here would also put a filesystem path in the same column the temp-path leak was
 *  removed from (see `buildDisplay` in components/composer/attachments). */
const ATTACHMENTS_PHRASES: Record<AttachmentsOp, OpPhrase> = {
  list_attachments: phrase("Checking what's attached for %s", "Checked what's attached for %s", AGENT),
  attach_to_message: phrase("Attaching a file for %s", "Attached a file for %s", AGENT),
  clear_attachments: phrase("Clearing %s's attachments", "Cleared %s's attachments", AGENT),
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

/**
 * The change-log ops. `%s` is never used: an event kind ("agent_status") and a subscription id
 * ("sub-3") are both internal handles, and neither is a thing the human would recognise in a 360px
 * column.
 *
 * The phrasing deliberately says "catching up on what changed" rather than anything about
 * subscribing or cursors. What the human cares about is that the concierge went and found out; the
 * mechanism is this app's problem, and naming it in the status line would be jargon in the one place
 * there is no room for it.
 */
const EVENTS_PHRASES: Record<EventsOp, OpPhrase> = {
  subscribe: phrase("Starting to watch for changes", "Started watching for changes"),
  read_events: phrase("Catching up on what changed", "Caught up on what changed"),
  unsubscribe: phrase("Stopping watching for changes", "Stopped watching for changes"),
  list_subscriptions: phrase("Checking what it's watching", "Checked what it's watching"),
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

/**
 * The screen-capture ops.
 *
 * These are the lines most worth getting right in this whole file. A capture is `ask`-tier because
 * of what it can SEE (conciergeTools/screenshot.ts), so the human is being asked to consent to it —
 * and the same 360px column shows this caption. "Taking a screenshot of Sparkle" says plainly that
 * the app, not the whole screen, is the subject; a vaguer "Looking at the screen" would understate
 * exactly the thing they are ruling on.
 */
const SCREENSHOT_PHRASES: Record<ScreenshotOp, OpPhrase> = {
  capture_window: phrase("Taking a screenshot of Sparkle", "Took a screenshot of Sparkle"),
  capture_agent: phrase("Taking a screenshot of %s", "Took a screenshot of %s", AGENT),
};

/** The preview-eyes ops (docs/live-browser-preview.md, Phase 3) — an agent looking at its OWN
 *  running preview, not at Sparkle or the human's screen. Worded to say "preview" rather than
 *  reusing the screenshot domain's "%s" pattern, so the two are never visually confused. */
const PREVIEW_INSPECT_PHRASES: Record<PreviewInspectOp, OpPhrase> = {
  screenshot: phrase("Looking at %s's preview", "Looked at %s's preview", AGENT),
  query_dom: phrase("Inspecting %s's preview", "Inspected %s's preview", AGENT),
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
  list_comments: phrase("Reading a task's notes", "Read a task's notes"),
  create_item: phrase("Filing a task", "Filed a task"),
  update_item: phrase("Updating a task", "Updated a task"),
  // "Adding a note", not "Commenting": the human's word for what lands on a bead is a note, and the
  // line is read by someone watching the concierge work, not by someone reading the API.
  comment_item: phrase("Adding a note to a task", "Added a note to a task"),
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
  set_plan_goal: phrase("Setting a plan's goal", "Set a plan's goal"),
  generate_plan_goal: phrase("Writing a goal for a plan", "Wrote a goal for a plan"),
};

const DIFF_PHRASES: Record<DiffOp, OpPhrase> = {
  list_changed_files: phrase("Looking at what %s changed", "Looked at what %s changed", AGENT),
  read_file_diff: phrase("Reading a file %s changed", "Read a file %s changed", AGENT),
  list_commits: phrase("Reading %s's commits", "Read %s's commits", AGENT),
};

/** Fleet awareness. The digest is deliberately described as reading rather than asking: it spends
 *  no agent's turn, and the column saying "checking on the fleet" where it means "messaged 40
 *  agents" would misrepresent the one property that matters about it. */
const FLEET_PHRASES: Record<FleetOp, OpPhrase> = {
  fleet_digest: phrase("Checking on every agent", "Checked on every agent"),
  read_agent_stream: phrase("Reading %s's history", "Read %s's history", AGENT),
  read_agent_transcript: phrase("Reading %s's transcript", "Read %s's transcript", AGENT),
  inbox_send: phrase("Leaving %s a message", "Left %s a message", AGENT),
  inbox_broadcast: phrase("Leaving several agents a message", "Left several agents a message"),
  inbox_status: phrase("Checking who has read their messages", "Checked who has read their messages"),
};

/**
 * Background research. The dispatch phrase says SENT, not "researching": the whole property of that
 * op is that it returns before the work is done, so a column line reading "Researching…" would
 * describe the concierge as busy on something it has already handed off — and would go stale the
 * moment the turn ends while the child runs on.
 */
const RESEARCH_PHRASES: Record<ResearchOp, OpPhrase> = {
  dispatch: phrase("Sending off a research question", "Sent off a research question"),
  list: phrase("Checking on your research", "Checked on your research"),
  get: phrase("Reading a research finding", "Read a research finding"),
  cancel: phrase("Calling off a research task", "Called off a research task"),
};

/**
 * Claude accounts. `switch_all` phrases the half that ALWAYS happens, because this line cannot see
 * which halves did.
 *
 * The op has two outcomes — the durable preference change, which is unconditional, and the live
 * migration of running agents, which enrolls nobody when every pane is already on the target or all
 * remaining ones are pinned. The reply distinguishes them with `migratingNow`; a phrase table is
 * keyed on the OP ALONE and gets no result to branch on, so any wording that asserts agents are
 * moving is false in exactly the case the reply exists to flag. "Which account your agents use"
 * covers both: it is the thing that changed either way. A past tense "Asked every agent to move"
 * reads as a fleet-wide migration and would put the claim the tool refuses to make into the one
 * surface a non-model human actually reads.
 */
const ACCOUNTS_PHRASES: Record<AccountsOp, OpPhrase> = {
  read_usage: phrase("Checking your Claude accounts", "Checked your Claude accounts"),
  switch_all: phrase(
    "Changing which Claude account your agents use",
    "Changed which Claude account your agents use",
  ),
};

const MEMORY_PHRASES: Record<MemoryOp, OpPhrase> = {
  remember: phrase("Saving something to memory", "Saved something to memory"),
  recall: phrase("Searching my memory", "Searched my memory"),
  forget: phrase("Dropping a memory", "Dropped a memory"),
  list_memories: phrase("Reading my memory", "Read my memory"),
};

/**
 * Dispatch memory. The phrase says WHAT IS BEING LOOKED UP, not that a database is being read: the
 * user reading this line wants to know the concierge is checking whether it already sent someone,
 * which is the whole reason the op exists (see conciergeTools/dispatchMemory.ts).
 */
const DISPATCH_MEMORY_PHRASES: Record<DispatchMemoryOp, OpPhrase> = {
  recall_dispatches: phrase(
    "Checking what I've already sent agents to do",
    "Checked what I've already sent agents to do",
  ),
};

/**
 * Publishing. Every phrase names the USER'S OWN SITE, and the two that reach the public say so.
 *
 * THIS LINE IS READ BY A HUMAN WHO IS NOT THE MODEL, and it is the one place a publish shows up
 * outside the approval card. So the wording draws the same line the risk table does: a draft is
 * "a draft", and `publish_go_live` says "Publishing" rather than something softer like "Updating
 * your site". A phrase that understates what happened is the copy half of settling a receipt from
 * absence-of-exception — see conciergeTools/publish.ts.
 */
const PUBLISH_PHRASES: Record<PublishOp, OpPhrase> = {
  publish_list_destinations: phrase("Checking where you can publish", "Checked where you can publish"),
  publish_probe: phrase("Checking what your site supports", "Checked what your site supports"),
  publish_list_projects: phrase("Reading your site's sections", "Read your site's sections"),
  publish_get: phrase("Reading one of your posts", "Read one of your posts"),
  publish_list: phrase("Listing your posts", "Listed your posts"),
  publish_create_draft: phrase("Creating a draft on your site", "Created a draft on your site"),
  publish_update_draft: phrase("Editing a draft on your site", "Edited a draft on your site"),
  publish_attach_media: phrase(
    "Attaching an image to a draft on your site",
    "Attached an image to a draft on your site",
  ),
  publish_update_live: phrase("Rewriting a live post", "Rewrote a live post"),
  publish_go_live: phrase("Publishing a post to your site", "Published a post to your site"),
  publish_take_down: phrase("Taking a post down", "Took a post down"),
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
  // Reuses the workflow glyph, like `diff`: a review finding is about a commit's fate, which is the
  // same question the workflow ops answer from the other side.
  review: { icon: "workflow", phrases: REVIEW_PHRASES },
  terminal: { icon: "terminal", phrases: TERMINAL_PHRASES },
  // Reuses the terminal glyph: a staged file rides along with the next message typed at that
  // agent, so it is the same act from the human's side.
  attachments: { icon: "terminal", phrases: ATTACHMENTS_PHRASES },
  workflow: { icon: "workflow", phrases: WORKFLOW_PHRASES },
  // Reuses the agents glyph: everything the log actually carries today is about AGENTS — their
  // statuses, their spawns and exits, and the approvals their work provoked.
  events: { icon: "agents", phrases: EVENTS_PHRASES },
  workspace: { icon: "workspace", phrases: WORKSPACE_PHRASES },
  // Reuses the workspace glyph: a capture is a fact about the WINDOW — what the app currently looks
  // like — which is the same subject the workspace ops act on. No new glyph is minted for it,
  // consistent with `board` and `plans` above.
  screenshot: { icon: "workspace", phrases: SCREENSHOT_PHRASES },
  preview_inspect: { icon: "workspace", phrases: PREVIEW_INSPECT_PHRASES },
  // Reuses the workflow glyph: publishing is the same shape of act as a push or a merge — work
  // leaving this machine for somewhere other people can see it.
  publish: { icon: "workflow", phrases: PUBLISH_PHRASES },
  board: { icon: "workspace", phrases: BOARD_PHRASES },
  approvals: { icon: "agents", phrases: APPROVALS_PHRASES },
  plans: { icon: "workspace", phrases: PLANS_PHRASES },
  // Reuses the workflow glyph: reading a diff is asking about the shape of landed work, which is the
  // same question the workflow ops answer from the other side.
  diff: { icon: "workflow", phrases: DIFF_PHRASES },
  fleet: { icon: "agents", phrases: FLEET_PHRASES },
  // Reuses the agents glyph: a research task IS an agent — a background `claude` child the
  // concierge started — so it belongs with the other lines about agents doing work.
  research: { icon: "agents", phrases: RESEARCH_PHRASES },
  // Reuses the agents glyph: both ops are about where the AGENTS are running — which login has
  // room for them, and moving them onto it. No new glyph, consistent with `board` and `plans`.
  accounts: { icon: "agents", phrases: ACCOUNTS_PHRASES },
  // Reuses the workspace glyph: durable memory is a fact about the concierge's own state, not an
  // agent or a branch. No new glyph, consistent with `board` and `plans`.
  memory: { icon: "workspace", phrases: MEMORY_PHRASES },
  // Reuses the agents glyph rather than memory's workspace one: the SUBJECT of every row is an
  // agent the concierge started, so this line belongs with the other lines about agents — the
  // substrate it happens to be stored in is not what the user is being told about.
  dispatch_memory: { icon: "agents", phrases: DISPATCH_MEMORY_PHRASES },
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
 * The subject a call's REPLY names, for the ops whose subject does not exist until they return.
 *
 * ══ WHY THIS EXISTS AT ALL ══════════════════════════════════════════════════════════════════════
 * `conciergeActivitySubject` reads the ARGUMENTS, which is right for every op that operates ON
 * something: you cannot close an agent without naming it. A SPAWN is the one shape that inverts
 * that — it is the call that brings the agent into existence, so its arguments cannot possibly
 * carry the id, and its reply is the first moment the id exists anywhere.
 *
 * Without this the spawn line would take the only subject its args offer, the PROJECT, and the
 * column would say "Started a new agent" forever — the exact failure that started this work: a line
 * with no identity attached, which the reader cannot click and cannot follow as it takes on a name.
 *
 * ══ WHY IT IS A TABLE OF ONE AND NOT A HEURISTIC ════════════════════════════════════════════════
 * "Read `data.agentId` off any reply that has one" is a shorter rule and a wrong one: plenty of ops
 * echo the agent they acted on, and letting a reply RE-point the subject means an op whose args and
 * reply disagree silently reports the reply's answer. Only an op that had no subject to begin with
 * may learn one here, so this is keyed on the op that genuinely has that property, and every other
 * call gets null and keeps the subject its arguments named.
 *
 * `data` is UNTRUSTED in shape (it crosses the registry's `unknown`-typed reply), so this validates
 * rather than casts — a malformed reply resolves to null and the line degrades to the indefinite.
 */
export function conciergeActivityResultSubject(
  domain: string,
  op: string,
  data: unknown,
): ConciergeActivitySubject {
  if (!learnsSubjectFromReply(domain, op)) return null;
  if (!data || typeof data !== "object") return null;
  const agentId = (data as Record<string, unknown>).agentId;
  return typeof agentId === "string" && agentId ? { kind: "agent", agentId } : null;
}

/**
 * Does this op take its subject from its REPLY rather than from its arguments?
 *
 * ══ WHY THIS IS SEPARATE FROM `conciergeActivityResultSubject` ══════════════════════════════════
 * They answer different questions, and collapsing them produced a real bug (roborev 55373). The
 * function above answers *"who does this reply name"* — and returns null both for an op that never
 * learns from its reply AND for a spawn whose reply named someone the store cannot resolve. The
 * recorder needs to tell those apart, because it must DISCARD the arguments' subject in the second
 * case and KEEP it in the first.
 *
 * The concrete failure when it could not: a spawn's arguments are `{ projectId }`, which
 * `conciergeActivitySubject` happily resolves to the PROJECT. With the past tense now `"Started
 * %s"`, a successful spawn whose new agent had already been closed fell through to that leftover
 * subject and rendered **"Started web"** — naming the project as though it were the agent that had
 * just been created. The intended degradation, "Started a new agent", only held when the project
 * ALSO failed to resolve, which is why an empty-store test could pass over it.
 *
 * So this asks about the OP alone, is answerable without a reply in hand, and is the one place the
 * spawn's special status is written down.
 */
export function learnsSubjectFromReply(domain: string, op: string): boolean {
  return domain === "lifecycle" && op === "spawn_build_agent";
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
  // A TURN PHASE, not a tool. Checked before the domain table because `phase` is deliberately NOT a
  // member of `ConciergeToolDomain` — it is a state of the turn, and adding it to the registry's
  // union would oblige every consumer of that union to handle a value no control call can ever
  // carry. See PHASE_DOMAIN for why these entries are observations rather than predictions.
  //
  // No tense: a phase is superseded by whatever happens next, never "completed", so there is no
  // moment at which "Composed" would be the true thing to say. An unknown phase string returns null
  // and the column falls back to the pulse, which is the honest rendering of "we don't know".
  if (activity.domain === PHASE_DOMAIN) {
    const phase = PHASE_PHRASES[activity.op as ConciergePhase];
    return phase ? { icon: phase.icon, text: phase.text } : null;
  }
  // A NATIVE Claude Code tool. Delegated to ./conciergeNativeToolLine, which owns the heuristic
  // half of the vocabulary — see NATIVE_DOMAIN for why that is a different kind of decision from
  // the total, compiler-checked tables below.
  //
  // Null is a REAL answer here and the common one: every `mcp__sparkle-control__*` call arrives on
  // the same live channel as the native ones, and that module returns null for all of them because
  // the control path has already described the same call far better (a resolved agent name, and a
  // pill the reader can click). Rendering a generic "Used mcp__sparkle-control__sparkle_terminal"
  // over "Reading Kraken Auth's terminal" would be a strict downgrade of a line we already had.
  //
  // NO PAST TENSE IS REACHABLE, and that is not an oversight: a native call never settles (the app
  // never observes its `tool_result` — see services/conciergeActivity), so `outcome` is always
  // "running". `past` is carried by the module because it is the honest shape of the data and
  // because the moment the app CAN observe a native call finishing it is the correct phrase; it is
  // wired here so that day needs no second change.
  if (activity.domain === NATIVE_DOMAIN) {
    const native = conciergeNativeToolLine({
      name: activity.op,
      input: activity.nativeInput ?? "",
    });
    if (!native) return null;
    return {
      icon: native.icon,
      text: activity.outcome === "done" ? native.past : native.present,
    };
  }
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
  // SPLIT RATHER THAN `replace`, so the subject stays addressable.
  //
  // The sentence used to be built with a single `String.replace`, which is fine for words and
  // useless for a CONTROL: the component has to draw a clickable pill exactly where the name goes,
  // and a finished string offers no way to find that span again that isn't re-matching the name
  // against its own output — which breaks the moment an agent is called something that also appears
  // in the template. Splitting at the slot is the same sentence and keeps the seam.
  const slot = template.indexOf("%s");
  const before = slot < 0 ? template : template.slice(0, slot);
  const after = slot < 0 ? "" : template.slice(slot + 2);
  const subject = slot < 0 ? "" : (activity.subject ?? phrase.indefinite ?? "");
  // "Reading %s's terminal" → "Tried reading …". Every present phrase is a capitalised participle
  // (they are sentence openers), so lowering the first letter is all the frame needs — no second
  // table, and no op can be added that has a present tense but no attempt phrasing.
  //
  // Applied to the HEAD, not to the assembled sentence, which is what it used to be. Identical
  // output for every template here (they all open with the participle, so only the head's first
  // character is ever touched) — and strictly better for one that opened WITH the slot, where
  // lowercasing the whole string would have de-capitalised the agent's own name.
  const head =
    activity.outcome === "refused"
      ? `Tried ${before.charAt(0).toLowerCase()}${before.slice(1)}`
      : before;
  const text = `${head}${subject}${after}`;
  // A PILL ONLY WHEN ALL THREE ARE TRUE: the sentence has a slot, the subject is an agent, and it
  // RESOLVED. The third is the one that matters — an unresolved subject has already degraded to the
  // indefinite noun ("an agent"), and wrapping that in a pill would offer a click that opens
  // nothing. No ref means the component renders plain words, which is the honest rendering.
  const agentRef =
    slot >= 0 && activity.agentId && activity.subject
      ? { agentId: activity.agentId, name: activity.subject, before: head, after }
      : undefined;
  return agentRef ? { icon: domain.icon, text, agentRef } : { icon: domain.icon, text };
}
