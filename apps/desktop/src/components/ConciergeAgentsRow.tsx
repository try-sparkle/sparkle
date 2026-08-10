// THE "CONCIERGE AGENTS" ROW — one pinned row, sitting directly above Improve Sparkle, standing in
// for every research task the concierge has dispatched. Bead `sparkle-s7rfc`.
//
// The founder's spec, verbatim: *"Let's have a row right above improved sparkle called 'Concierge
// Agents'. it's just one row, like a build orchestrator with '+[n]' showing how many agents are
// running I can click on the row to open up the agents, which are indented like regular build
// workers, and click on any of them to see details."*
//
// ══ IT IS A BUILD ORCHESTRATOR THAT HAPPENS TO HAVE NO PTY ══════════════════════════════════════
//
// READ `SparkleAgentRow`'s HEADER BEFORE CHANGING ANYTHING HERE. It is a written argument against
// exactly the drift this row could reintroduce — "the whole point of the column is that it is
// scannable straight down; a row with its own dialect is a row you have to stop and read" — and it
// records, one by one, the special cases that had to be taken back off the last row that grew them
// (a bigger disc, its own inset, its own font size, a gradient bar, a bordered pill, and worst, its
// own status derivation).
//
// So this row borrows, and invents nothing:
//   • the disc slot          — `DOT_SLOT_W` / `DOT_SIZE` / `GLYPH_SLOT_H`, centered, same line
//   • the box                — `rowBoxFor({ pinned: true })`, the same rule the Sparkle row takes
//                              because it likewise sits OUTSIDE the padded scroll container
//   • the title              — `AGENT_NAME_FONT_SIZE`, `rowTitleWeight`, NEUTRAL ink (`C.cream`).
//                              Colour lives in the disc, on every row in this column.
//   • the `+N`               — `C.muted` / 12px / lineHeight 1, the collapsed orchestrator's badge
//   • the child indent       — `DEPTH_INDENT`, fed to the SAME `rowBoxFor`, so a task's disc lands
//                              where this row's TITLE begins, exactly as a worker's does
//   • the elapsed reading    — `ElapsedTimer` on the shared `useRowClock`
//   • the selected paint     — `ActiveFillets` + the `forest` fill, on the open child
//
// ══ THE DOT IS DERIVED BY THE CALLER, NOT HERE ═════════════════════════════════════════════════
//
// `status` / `dotColor` / `dotLabel` / `liveCount` / `hydrated` arrive as PRIMITIVE PROPS from
// `AgentSidebar`, which runs them through the same `rollupDot` + `ROLLUP_DOT_COLOR` + `rollupLabel`
// pipeline every build row goes through. Do NOT re-derive any of them in here. A second derivation
// is precisely how the Improve Sparkle row came to render GREEN while its agent sat on an unanswered
// four-option picker: it had a private copy of the logic, so a fix to the shared pipeline landed on
// every other row and silently missed it.
//
// ══ A RESEARCH TASK IS NOT AN AGENT ════════════════════════════════════════════════════════════
//
// Nothing here widens `AgentKind` and nothing is added to `projectStore.agents`. A research task has
// no worktree, no branch, no pane and no PTY — every roster consumer (the ladder, the band chips,
// `get_state`, the concierge's sidebar view, close/retire/promote) would have to learn a fourth kind
// that answers differently to all of them. The row reads `useResearchStore` directly instead, which
// is the same posture `SupportTicketRow` takes toward its own store.
//
// ══ WHY THE `+0` IS RENDERED WHERE THE SPARKLE ROW HIDES ITS BADGE ═════════════════════════════
//
// `SparkleAgentRow` renders `+N` only when N > 0, because there the badge is incidental. Here the
// number IS the row — the founder asked for "'+[n]' showing how many agents are running" on a row
// that is always present — so a live count of zero is a fact the row reports rather than a badge it
// suppresses. `hydrated` is what separates that from "we have not looked yet": before the first
// `listResearch()` lands, the row shows NO badge at all rather than claiming zero.
import { memo, useCallback, useEffect, useId, useMemo, useState } from "react";
import { C } from "../theme/colors";
import { FONT_MONO, TYPE } from "../theme/scale";
import { DOT_SIZE, DOT_SLOT_W, GLYPH_SLOT_H, DEPTH_INDENT } from "../engine/rowGeometry";
import type { PairSide } from "../engine/rowGeometry";
import { ActiveFillets, rowBoxFor } from "./rowAnatomy";
import { StatusDot } from "./StatusDot";
import { AGENT_NAME_FONT_SIZE, rowTitleWeight } from "./FittedAgentName";
import { useRowClock, ElapsedTimer, formatElapsed } from "./rowClock";
import type { AgentTabStatus } from "../types";
import {
  cancelResearch,
  refreshResearch,
  RESEARCH_POLL_INTERVAL_MS,
  sortedTasks,
  useResearchStore,
} from "../services/research/store";
import { isLive, type ResearchStatus, type ResearchTask } from "../services/research/types";

/** The row's label. A CONSTANT because two surfaces read it — the row and its tests — and a literal
 *  in each is a place for them to disagree, the same reason `SPARKLE_AGENT_DISPLAY_NAME` exists. */
export const CONCIERGE_AGENTS_TITLE = "Concierge Agents";

/** `data-hint` for the header row, mirroring `"improve"` / `"agent"`. */
export const CONCIERGE_AGENTS_HINT = "concierge-agents";

/**
 * A research task's life stage, expressed in the column's OWN status vocabulary.
 *
 * This is a TRANSLATION, not a second status taxonomy: it exists so a research task can go through
 * `rollupDot` / `bandOfStatus` / `StatusDot` unchanged, rather than teaching those three about a
 * fifth enum. Exported so the sidebar's rollup and this row's child discs call the same function —
 * one derivation used twice, never two derivations.
 *
 * `failed` → `errored` is the only mapping worth arguing about, and the argument is that a research
 * run that died IS something the founder wants to see when they open the row. It is deliberately
 * NOT allowed to paint the header red forever, though — see `researchRollupStatuses`.
 */
export function agentStatusForResearch(status: ResearchStatus): AgentTabStatus {
  switch (status) {
    // Both LIVE states are green. `queued` has no process yet, but it is work in flight from the
    // founder's point of view — and it is one of the two states `+[n]` counts, so painting it calm
    // would put a number on the row that its own disc contradicts.
    case "queued":
    case "running":
      return "working";
    case "done":
      return "done";
    case "failed":
      return "errored";
    // `cancelled` is a state the founder PUT it in. It is not an alarm and never becomes one.
    case "cancelled":
      return "stopped";
  }
}

/**
 * What the header's disc rolls up: the LIVE tasks only.
 *
 * Terminal tasks are history — they stay in the expanded list, where the founder is deliberately
 * looking, and they do not paint the collapsed row. That is not tidiness, it is the `unmerged`
 * lesson from `engine/workerRollup` applied one row over: a red that can never be cleared stops
 * being a signal. A failed research task has no "read" concept (`readAt` is stamped for `done`
 * only), so escalating it here would leave the row permanently red after the first failure, for
 * everyone, with no gesture that calms it.
 *
 * Consequence, stated so it is a decision rather than an oversight: the collapsed row is GREEN while
 * anything is live and GRAY otherwise, and it never goes red. If research ever grows a state that
 * genuinely blocks the founder, add it here and the whole rollup/band/chip chain follows for free.
 */
export function researchRollupStatuses(tasks: readonly ResearchTask[]): AgentTabStatus[] {
  return tasks.filter(isLive).map((t) => agentStatusForResearch(t.status));
}

/** The human word for a task's state, used in the detail block. Sentence case, like every other
 *  label in the column. */
function researchStatusLabel(status: ResearchStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

/** When this task's clock started, and when it stopped (`null` = still running). */
function spanOf(task: ResearchTask): { since: number; until: number | null } {
  return { since: task.startedAt ?? task.createdAt, until: task.finishedAt };
}

/**
 * The pinned "Concierge Agents" row and, when it is open, one indented row per research task.
 *
 * `React.memo`'d with primitive props and no callbacks at all, for the same reason `SparkleAgentRow`
 * is (sparkle-alrm.3): a project agent's status flip re-renders that agent's row and must not reach
 * this one. The expansion is LOCAL state and the task list comes from the row's own store
 * subscription, so neither travels through props and neither can be invalidated by the column.
 */
export const ConciergeAgentsRow = memo(function ConciergeAgentsRow({
  status,
  dotColor,
  dotLabel,
  liveCount,
  hydrated,
  paneSide,
  jointOpen,
}: {
  /** The row's own status, from the caller's `rollupDot` pipeline. See the header. */
  status: AgentTabStatus;
  /** Rolled-up disc paint, when the tasks under this row disagree with its own status. Same override
   *  every build head takes; `undefined` means "use the status taxonomy". */
  dotColor?: string;
  dotLabel?: string;
  /** Queued + running. Straight from the store's `liveTasks` selector via the caller — NOT counted
   *  again in here, so the badge and the disc can never tell different stories. */
  liveCount: number;
  /** Has the first `listResearch()` landed? Separates "+0" from "we have not looked yet". */
  hydrated: boolean;
  /** The same two geometry inputs every row in this column takes — see engine/rowGeometry. */
  paneSide: PairSide;
  jointOpen: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const byId = useResearchStore((s) => s.byId);
  const openTaskId = useResearchStore((s) => s.openTaskId);
  const setOpenTask = useResearchStore((s) => s.setOpenTask);
  // Newest first, through the store's OWN selector. Sorting here instead would be a second answer to
  // "which task is the latest", which is the drift `sortedTasks` exists to prevent.
  const tasks = useMemo(() => sortedTasks(Object.values(byId)), [byId]);

  // HYDRATE ON MOUNT, THEN KEEP POLLING. The store is a cache and the disk is the truth: the
  // concierge that dispatched a task has usually exited by the time this window paints, so a row
  // that trusted an empty store would report "+0" for work that is running right now. Failures are
  // swallowed inside `refreshResearch` — a cache refresh must not turn a working column into a
  // crashing one.
  //
  // ══ THE POLL LIVES WITH THE ROW, NOT WITH THE CONCIERGE ═══════════════════════════════════════
  //
  // It was in `ConciergeHost` first, which paints no row — and `AgentSidebar` renders this one in
  // windows where no `ConciergeHost` is mounted at all (a torn-off satellite), and in the main
  // window whenever the host unmounts because no project is open. Those windows refreshed once at
  // mount and never again: `+[n]` frozen, a finished task stuck on `running`, indefinitely
  // (roborev 61724). A poll that outlives the thing it feeds is not a poll.
  //
  // ONE PER WINDOW is guaranteed one level up — `Workspace.tsx` passes `showConciergeRow={false}`
  // to all but one sidebar (sparkle-x0pvw), so two columns cannot each start a timer.
  //
  // A poll rather than an event because the runner has no change channel: research completes on a
  // wall clock of minutes, so this cadence is far finer than what it watches, and each tick is one
  // directory read. Same posture as `BEADS_POLL_INTERVAL_MS` — a cache mirroring a file we do not own.
  useEffect(() => {
    void refreshResearch();
    const timer = setInterval(() => {
      void refreshResearch();
    }, RESEARCH_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const rowBox = rowBoxFor({ paneSide, jointOpen, isActive: false, pinned: true });
  // PER-INSTANCE, not a module constant. A module-level id is emitted once per mounted row, and
  // this component can legitimately mount more than once across windows — a duplicated `id` is
  // invalid HTML and, worse, silently resolves every header's `aria-controls` to the FIRST
  // subtree in the document, so a screen reader following the second row lands on the wrong one
  // (roborev 61699).
  const groupId = useId();

  return (
    <>
      <div
        data-hint={CONCIERGE_AGENTS_HINT}
        // A DISCLOSURE, not a selection — this row claims no pane, because a research task has no
        // pane to claim. `aria-expanded` is therefore the whole of its state, and it is the same
        // attribute a build head carries for its own subtree (AgentRow sets it from
        // `subtreeCollapsed`), so a screen reader hears one vocabulary down the column.
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-controls={tasks.length > 0 ? groupId : undefined}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        title="Concierge Agents — research tasks the concierge has dispatched"
        style={{
          flex: "0 0 auto",
          position: "relative",
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
          // THE PINNED BOX, unconditional on any selected state — the list-twitch rule in
          // engine/rowGeometry. The trailing 2 is the gap to the row below, matching a list row's.
          margin: `0 ${rowBox.marginRight}px 2px ${rowBox.marginLeft}px`,
          padding: rowBox.padding,
          cursor: "pointer",
          background: "transparent",
          borderRadius: rowBox.borderRadius,
        }}
      >
        <div
          style={{
            flex: "0 0 auto",
            width: DOT_SLOT_W,
            height: GLYPH_SLOT_H,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <StatusDot status={status} size={DOT_SIZE} color={dotColor} label={dotLabel} />
        </div>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
            height: GLYPH_SLOT_H,
          }}
        >
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
            <span
              style={{
                flex: "0 1 auto",
                minWidth: 0,
                // Neutral, like every other row title in this column.
                color: C.cream,
                fontSize: AGENT_NAME_FONT_SIZE,
                fontWeight: rowTitleWeight(false),
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {CONCIERGE_AGENTS_TITLE}
            </span>
            {/* The collapsed orchestrator's badge, ink for ink — and rendered at ZERO too. See the
                header for why this one does not hide itself. */}
            {hydrated && (
              <span
                aria-label={`${liveCount} running`}
                title={`${liveCount} research ${liveCount === 1 ? "agent" : "agents"} running`}
                style={{ flex: "0 0 auto", color: C.muted, fontSize: 12, lineHeight: 1 }}
              >
                +{liveCount}
              </span>
            )}
          </div>
        </div>
        {/* Empty while unselected — this row is never selected, so this draws nothing today. Kept so
            the anatomy is literally the same call every other row makes, rather than a row that has
            quietly opted out of the shared chrome. */}
        <ActiveFillets ends={rowBox.filletEnds} paneSide={paneSide} />
      </div>

      {/* THE SUBTREE. A `group`, exactly as a build head's workers are, and rendered only when there
          are children — an empty group is something a screen reader announces and then finds
          nothing in. */}
      {expanded && tasks.length > 0 && (
        <div id={groupId} role="group" aria-label={`Agents for ${CONCIERGE_AGENTS_TITLE}`}>
          {tasks.map((task) => (
            <ConciergeTaskRow
              key={task.id}
              task={task}
              open={openTaskId === task.id}
              onToggle={setOpenTask}
              paneSide={paneSide}
              jointOpen={jointOpen}
            />
          ))}
        </div>
      )}
    </>
  );
});

/**
 * ONE research task, indented under the header exactly as a worker is under its orchestrator.
 *
 * `depthIndent: DEPTH_INDENT` through the SAME `rowBoxFor` a worker row uses, so the task's disc
 * lands on the header's TITLE line — the hanging indent engine/rowGeometry describes — rather than
 * on some second, arbitrary column of this row's own invention.
 */
const ConciergeTaskRow = memo(function ConciergeTaskRow({
  task,
  open,
  onToggle,
  paneSide,
  jointOpen,
}: {
  task: ResearchTask;
  open: boolean;
  onToggle: (id: string | null) => void;
  paneSide: PairSide;
  jointOpen: boolean;
}) {
  const { since, until } = spanOf(task);
  // Ticks only while the task is live: `useRowClock(undefined)` registers nothing at all, so a
  // column of finished tasks costs no timers.
  const clockNow = useRowClock(until === null ? since : undefined);
  const box = rowBoxFor({
    paneSide,
    jointOpen,
    isActive: open,
    depthIndent: DEPTH_INDENT,
    pinned: true,
  });
  const st = agentStatusForResearch(task.status);
  // OPEN/CLOSE, not "select" — clicking the open task closes its detail, which is the same
  // click-again-to-fold gesture a selected build head uses on its subtree.
  const toggle = useCallback(
    () => onToggle(open ? null : task.id),
    [onToggle, open, task.id],
  );

  return (
    <>
      <div
        data-hint="concierge-agent"
        data-task-id={task.id}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        title={task.question}
        style={{
          flex: "0 0 auto",
          position: "relative",
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
          margin: `0 ${box.marginRight}px 2px ${box.marginLeft}px`,
          padding: box.padding,
          cursor: "pointer",
          // The build row's selected fill, on the one row here that CAN be selected: the open task
          // is the one whose detail the founder is reading. Same `forest`, same fillets below.
          background: open ? C.forest : "transparent",
          borderRadius: box.borderRadius,
        }}
      >
        <div
          style={{
            flex: "0 0 auto",
            width: DOT_SLOT_W,
            height: GLYPH_SLOT_H,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <StatusDot status={st} size={DOT_SIZE} label={researchStatusLabel(task.status)} />
        </div>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
            height: GLYPH_SLOT_H,
          }}
        >
          {/* Timer, then title — the collapsed row's strip, element for element. */}
          <ElapsedTimer since={since} now={until ?? clockNow} color={C.muted} />
          <span
            style={{
              flex: "0 1 auto",
              minWidth: 0,
              color: C.cream,
              fontSize: AGENT_NAME_FONT_SIZE,
              fontWeight: rowTitleWeight(open),
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {task.question}
          </span>
        </div>
        <ActiveFillets ends={box.filletEnds} paneSide={paneSide} />
      </div>
      {open && <ConciergeTaskDetail task={task} />}
    </>
  );
});

/**
 * THE DETAIL: the question as asked, where it stands, how long it took, and the findings IN FULL.
 *
 * Untruncated on purpose — `types.ts` records the same rule on the write side: "a clipped finding is
 * a confidently-wrong answer — strictly worse than a long one the reader can scroll."
 */
function ConciergeTaskDetail({ task }: { task: ResearchTask }) {
  const { since, until } = spanOf(task);
  const clockNow = useRowClock(until === null ? since : undefined);
  const live = isLive(task);
  const [cancelling, setCancelling] = useState(false);

  const onCancel = useCallback(async () => {
    setCancelling(true);
    try {
      // THE KILL. The founder chose no cap on concurrent research, so "visible and killable" is the
      // whole guardrail — this is the killable half, and it is the only surface that has it.
      useResearchStore.getState().upsert(await cancelResearch(task.id));
    } finally {
      setCancelling(false);
    }
  }, [task.id]);

  return (
    <div
      data-testid="concierge-agent-detail"
      // Indented past the child row's own disc, so the detail reads as belonging to the task above
      // it rather than as another row.
      style={{
        margin: `0 ${DEPTH_INDENT}px 6px ${DEPTH_INDENT + DOT_SLOT_W}px`,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        fontSize: 12,
        lineHeight: 1.5,
        color: C.cream,
      }}
    >
      <div style={{ color: C.cream }}>{task.question}</div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          color: C.muted,
          fontFamily: FONT_MONO,
          fontSize: TYPE.micro,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span>{researchStatusLabel(task.status)}</span>
        <span>{formatElapsed(Math.max(0, (until ?? clockNow) - since))}</span>
        {live && (
          <button
            onClick={(e) => {
              // The row above toggles on click; a Cancel that also folded the detail away would
              // hide the outcome of the button you just pressed.
              e.stopPropagation();
              void onCancel();
            }}
            disabled={cancelling}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              font: "inherit",
              // accentInk, not BRAND.accent — a link, not a fill (see the ink/fill split in
              // colors.ts; the constant cyan reads at 1.6:1 on light mode's white column).
              color: C.accentInk,
              cursor: cancelling ? "default" : "pointer",
              textDecoration: "underline",
            }}
          >
            Cancel
          </button>
        )}
      </div>
      {task.findings !== null && (
        <div data-testid="concierge-agent-findings" style={{ whiteSpace: "pre-wrap" }}>
          {task.findings}
        </div>
      )}
      {task.error !== null && (
        <div data-testid="concierge-agent-error" style={{ color: C.muted }}>
          {task.error}
        </div>
      )}
    </div>
  );
}
