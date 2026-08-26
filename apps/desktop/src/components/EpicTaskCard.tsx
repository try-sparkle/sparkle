/**
 * ONE TASK CARD ON AN EPIC CARD — the hierarchy, rendered.
 *
 * ══ THE FOUNDER'S WORDS, 2026-08-24 (bead sparkle-huw924.9) ════════════════════════════════════
 * *"When I see orchestrator, it makes me think of build agents. Which makes me wonder if those are
 * build agents. But the build agents should be on the task. Like, the way that it should work is a
 * hierarchy where epics have tasks and tasks get built… I think what I would wanna see where it
 * says orchestrator I would want that to be task cards. And then each task card would have the
 * orchestrator, like, the orchestrator agents, the actual build agents, that are attached to it.
 * Within that task card… I'd like to be able to click to expand a task card within the epic and
 * have it and see it embedded inside the epic. And then be able to double click on it to have it
 * open on its own."*
 *
 * So: EPIC → TASKS → BUILD AGENTS. A build agent is never shown as a child of the epic, only as a
 * child of the task it is bound to. This component is the middle rung.
 *
 * ══ WHY THE SINGLE CLICK IS DEFERRED, AND WHY THE DEFER IS NOT A STYLE CHOICE ═════════════════
 * A double click in a real browser is `click`(detail 1) → `click`(detail 2) → `dblclick`. So the
 * FIRST click of the founder's double click is indistinguishable from a single click at the moment
 * it arrives — the only thing that separates the two gestures is what happens next. Acting
 * immediately would toggle the expand on the way to opening the task, leaving the card expanded as
 * a side effect of a gesture that means "open this somewhere else". {@link DOUBLE_CLICK_GRACE_MS}
 * is how long we wait to find out; `onDoubleClick` cancels the pending toggle.
 *
 * The timer is cleared on unmount too. An epic card can close (or the store can poll a child away)
 * inside the grace window, and a `setState` from a timer owned by an unmounted tree is the classic
 * React leak warning — here it would also toggle an expand nobody would ever see.
 *
 * ══ EXPANDED STATE IS THE PARENT'S ═══════════════════════════════════════════════════════════
 * `expanded` / `onToggleExpand` are props rather than local state, because "which task is open"
 * belongs to the epic card that owns the list, and it must RESET when that card closes. Holding it
 * here would work by accident (unmount drops it) but would make "expand exactly one at a time" or
 * session persistence impossible to add without moving it. It is deliberately NOT in `uiStore`
 * yet — see the note in `BoardView.EpicLiveStatus`.
 *
 * ══ MEMBERSHIP IS NOT RE-DERIVED HERE ════════════════════════════════════════════════════════
 * This component is handed an {@link EpicChildView} that `services/planView.epicChildViews` already
 * resolved through `services/beads.childrenOf`. The epic↔child edge has exactly one owner and
 * `scripts/lib/epic-membership-guard.sh` fails CI on a second one. The only roster question asked
 * here is "which agents are bound to THIS bead", which is the worker↔bead edge, not the epic edge.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { C } from "../theme/colors";
import { FONT_UI, RADIUS, TYPE } from "../theme/scale";
import {
  beadStage,
  epicChildViews,
  groupEpicAgentsByTask,
  type EpicAgentPill,
  type EpicChildView,
} from "../services/planView";
import { DELIVERED_LABEL } from "../services/beads";
import { useRuntimeStore } from "../stores/runtimeStore";
import { stageMeta, stageLineColor, type WorkflowStageId } from "../engine/workflowStage";
import { WorkflowLine } from "./WorkflowLine";
import { EpicHealthSquare } from "./EpicHealthSquare";
import { beadHealthApplies, beadHealthLabel } from "../engine/beadHealth";
import { useBeadHealthOf } from "../hooks/useEpicHealthOf";
import type { EpicHealth } from "../engine/epicHealth";
import type { AgentTab } from "../types";
import type { Bead } from "../services/beads";

/** How long a single click waits to find out whether it was the first half of a double click.
 *  ~250ms is the platform double-click threshold; long enough that the second click lands first,
 *  short enough that a real single click still feels immediate. */
export const DOUBLE_CLICK_GRACE_MS = 250;

/** What an expanded task card says when nobody is building it yet.
 *
 *  SHOWN, NOT HIDDEN — the card still expands with zero agents. An expander that silently does
 *  nothing reads as broken, and "nobody is on this" is exactly the fact the founder opens an epic
 *  to learn. Exported so the test asserts the shipped string rather than a copy of it. */
export const NO_BUILD_AGENTS = "No build agents on this task yet";

export interface EpicTaskCardProps {
  /** The child task + the workers bound to it, from `planView.epicChildViews`. */
  row: EpicChildView;
  /** The live roster — read only for THIS bead's worker ids, to subscribe to their stages. */
  agents: AgentTab[];
  /** This task's health square, or `null` for finished work that gets none. Computed by the
   *  PARENT so the rollup view is built once for the list rather than once per card. */
  health: EpicHealth | null;
  /** Is this card open, showing its build agents inside the epic? */
  expanded: boolean;
  /** Single click (after the double-click grace window). */
  onToggleExpand: (beadId: string) => void;
  /** Double click — open this task on its own. Absent on a read-only mount, which leaves the card
   *  expandable but not openable rather than offering a gesture that does nothing. */
  onOpen?: (b: Bead) => void;
  /**
   * THE AGENTS ON THIS TASK, AS PILLS THAT CAN BE CLICKED.
   *
   * Absent, the chips fall back to {@link EpicChildView.workers} — the same NAMES this card has
   * always drawn, now through the same renderer, so there is exactly one agent-chip treatment on
   * this card rather than one per caller. Supplied, each chip carries the agent's ID as well, which
   * is what {@link onOpenAgent} needs to reveal it.
   *
   * WHY A CALLER MAY WANT TO SUPPLY IT: the names in `row.workers` come from
   * `planView.workersForBead`, which sees WORKERS bound to this exact bead. The epic card's own
   * lineage resolves a wider set (orchestrators included, transitively), and the epics column hands
   * that set down partitioned by task — see `planView.groupEpicAgentsByTask` — so the card can say
   * WHICH agent is on WHICH task without either surface re-deriving epic membership.
   */
  agentPills?: readonly EpicAgentPill[];
  /** Reveal a build agent — *"clicking one jumps to that agent, the same affordance the concierge
   *  uses in chat."* Absent renders the chips as static text, the callback-is-the-switch convention
   *  every other affordance here takes. */
  onOpenAgent?: (agent: { agentId: string; projectId?: string }) => void;
}

/**
 * ONE BUILD-AGENT CHIP — the single agent treatment on this surface.
 *
 * ══ THE FOUNDER'S HARD RULE, 2026-08-25 (bead sparkle-huw924.10) ══════════════════════════════
 * *"I do want it to work exactly like the build agents, so that's the hard rule. The colors work
 * the same between the two, and don't let any instruction ever override that."*
 *
 * So the ink is `C.tealInk` and the box is a hairline chip — literally what `BeadCard`'s
 * `Build agents:` row paints for the same agent (`BeadLineageRows.pillStyle`, `ink = C.tealInk`)
 * and what the `Workers` field paints for it (`BeadCard`, `color: C.tealInk`). ONE renderer here
 * rather than one per call site, so a chip inside a task card and a chip in the unassigned group
 * below it cannot drift into two colours.
 */
function AgentChip({
  pill,
  onOpen,
}: {
  pill: EpicAgentPill;
  onOpen?: (agent: { agentId: string; projectId?: string }) => void;
}) {
  const interactive = onOpen !== undefined;
  return (
    <span
      data-testid="epic-task-card-agent"
      data-agent-id={pill.id}
      title={pill.label}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={
        interactive
          ? (e) => {
              // THE CARD BODY IS THE EXPAND/OPEN TARGET, so a chip click must not ALSO toggle or
              // open the task it sits inside — the same rule every interactive child of a card
              // body takes in `BeadCard`.
              e.stopPropagation();
              onOpen?.({ agentId: pill.id, projectId: pill.projectId });
            }
          : undefined
      }
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              e.stopPropagation();
              onOpen?.({ agentId: pill.id, projectId: pill.projectId });
            }
          : undefined
      }
      style={{
        color: C.tealInk,
        fontSize: 12,
        border: `1px solid ${C.hairline}`,
        borderRadius: RADIUS.input,
        padding: "1px 7px",
        maxWidth: "100%",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        cursor: interactive ? "pointer" : "default",
      }}
    >
      {pill.label}
    </span>
  );
}

export function EpicTaskCard({
  row,
  agents,
  health,
  expanded,
  onToggleExpand,
  onOpen,
  agentPills,
  onOpenAgent,
}: EpicTaskCardProps) {
  const { bead, workers } = row;
  // ONE list, one renderer. A caller that knows the agents' IDS supplies them and its chips
  // navigate; a caller that only has names gets the same chips, inert. Branching on the SHAPE of
  // the data here rather than on the caller keeps a single agent treatment on this card — the
  // founder's colour rule is a statement about that single treatment.
  const chips: readonly EpicAgentPill[] =
    agentPills ?? workers.map((name) => ({ id: name, label: name }));
  const workerIds = agents
    .filter((a) => a.kind === "worker" && a.beadId === bead.id)
    .map((a) => a.id);
  const workerStages = useRuntimeStore(
    useShallow(
      (s) => workerIds.map((id) => s.workflowStage[id]).filter(Boolean) as WorkflowStageId[],
    ),
  );
  const stage = beadStage(bead.status, bead.labels.includes(DELIVERED_LABEL), workerStages);

  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPending = useCallback(() => {
    if (pending.current !== null) {
      clearTimeout(pending.current);
      pending.current = null;
    }
  }, []);
  // Nothing may fire from a card that is gone; see the header.
  useEffect(() => cancelPending, [cancelPending]);

  const handleClick = useCallback(() => {
    cancelPending();
    pending.current = setTimeout(() => {
      pending.current = null;
      onToggleExpand(bead.id);
    }, DOUBLE_CLICK_GRACE_MS);
  }, [bead.id, cancelPending, onToggleExpand]);

  const handleDoubleClick = useCallback(() => {
    // ORDER MATTERS: kill the pending toggle BEFORE opening, so a double click can never leave the
    // card expanded behind the task it just opened.
    cancelPending();
    onOpen?.(bead);
  }, [bead, cancelPending, onOpen]);

  return (
    <div
      data-testid="epic-task-card"
      data-bead-id={bead.id}
      // A DIV WITH `role="button"`, NOT A `<button>`: the expanded body carries its own agent chips,
      // and a <button> may not contain interactive content. The keyboard contract is written out
      // below rather than inherited, which is the price of that choice.
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          // Enter is the keyboard's "open it", matching the double click; Space is the toggle.
          e.preventDefault();
          cancelPending();
          onOpen?.(bead);
          return;
        }
        if (e.key === " ") {
          e.preventDefault();
          cancelPending();
          onToggleExpand(bead.id);
        }
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "6px 8px",
        background: C.forest,
        borderRadius: 6,
        width: "100%",
        textAlign: "left",
        border: "none",
        font: "inherit",
        fontFamily: FONT_UI,
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {/* THE TASK'S SQUARE — *"just like the epic has a square status, the children should also
            have that status"*. Literally the epic row's component, so the two surfaces cannot paint
            the same fleet different colours; only the hover NOUN differs, which is why
            `beadHealthLabel` exists beside the rule. */}
        {health !== null && <EpicHealthSquare health={health} label={beadHealthLabel(health)} />}
        <span style={{ flex: 1, minWidth: 0, color: C.cream, fontSize: 13 }}>{bead.title}</span>
        <span
          style={{
            flex: "0 0 auto",
            fontSize: 10,
            fontWeight: 600,
            color: stageLineColor(stage),
            whiteSpace: "nowrap",
          }}
        >
          {stageMeta(stage).short}
        </span>
      </div>
      <WorkflowLine stage={stage} height={3} />
      {expanded && (
        <div
          data-testid="epic-task-card-body"
          style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 2 }}
        >
          <div style={{ color: C.muted, fontSize: TYPE.small }}>
            {`Stage: ${stageMeta(stage).label}`}
          </div>
          {chips.length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
              <span style={{ color: C.muted, fontSize: TYPE.small }}>Build agents:</span>
              {chips.map((pill) => (
                <AgentChip key={pill.id} pill={pill} onOpen={onOpenAgent} />
              ))}
            </div>
          ) : (
            <div data-testid="epic-task-card-no-agents" style={{ color: C.muted, fontSize: 12 }}>
              {NO_BUILD_AGENTS}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * What the fallback group is called on screen. Exported so a test asserts the SHIPPED string rather
 * than a copy of it.
 *
 * It is deliberately NOT `Build agents:` — that was the label on the top-level row bead
 * sparkle-huw924.10 deletes, and reusing it would re-create, one row lower, the very thing the
 * founder asked to go away. This row means something narrower and says so: these agents are inside
 * the epic and we cannot tell you which task they are on.
 */
export const UNASSIGNED_AGENTS_LABEL = "Not on a task:";

/**
 * AN EPIC'S TASKS, AS CARDS — one {@link EpicTaskCard} per direct child, each owning the build
 * agents bound to it, plus the fallback group for the ones nothing can attribute.
 *
 * ══ THE FOUNDER'S RE-ASK, 2026-08-25 (bead sparkle-huw924.10) ═════════════════════════════════
 * *"I had already previously asked that the build agents not show outside of the tasks — that the
 * epic will surface the tasks. And I want the tasks to look more like they do in the Plan board
 * cards."* Both halves are the same component: the Plan board's task card IS `EpicTaskCard`, and
 * mounting it here is what makes the two surfaces one treatment rather than a third.
 *
 * `services/beads` already records what happens when they are not: this repo shipped three
 * incompatible drawings of an epic (bead sparkle-xelans). A fourth is the thing to avoid, so the
 * only new code here is the LIST — expansion state, the health lookup, and the fallback group.
 *
 * ══ NOTHING VANISHES — READ `planView.groupEpicAgentsByTask` FOR THE CONTRACT ═════════════════
 * `spawn_build_agent` takes no epic parameter, so an orchestrator is normally bound to no bead and
 * many workers are bound to nothing either. Under the row this replaces they were still NAMED. Any
 * pill that matches no task on this card therefore lands in the fallback group below the cards —
 * visible, and clickable, in exactly the chip treatment the task cards use.
 *
 * ══ WHY THE EXPANDED SET IS LOCAL STATE ══════════════════════════════════════════════════════
 * The same reasoning `BoardView.EpicLiveStatus` records: it resets when the epic card closes, which
 * is the behaviour asked for — expanding a task in place is a reading gesture, not a saved
 * preference. Putting it in `uiStore` is the change to make when someone wants it to survive a
 * close, and not before.
 */
export interface EpicTaskCardsProps {
  /** The epic whose direct children become the cards. */
  epicId: string;
  /** The project's FULL bead snapshot, straight from the store — `childrenOf` walks a WeakMap-cached
   *  index keyed on this array's IDENTITY, so a copy, slice or re-sort defeats the cache silently. */
  allBeads: Bead[];
  /** The project's agent roster. */
  agents: AgentTab[];
  /**
   * The epic's RESOLVED build agents, from `engine/beadLineage.beadLineageOf(...).buildAgents`.
   *
   * Passed in rather than resolved here for the reason `BeadCardProps.lineage` records: epic
   * membership has ONE owner (`scripts/lib/epic-membership-guard.sh` fails CI on a second), and the
   * caller has already paid for it. Absent, the cards fall back to the names in
   * `planView.epicChildViews` and NO fallback group is drawn — there is no wider set to have lost
   * anything from.
   */
  buildAgents?: readonly EpicAgentPill[];
  /** Open a task on its own — the double-click / Enter gesture. */
  onOpenTask?: (b: Bead) => void;
  /** Reveal a build agent. Absent renders every chip as static text. */
  onOpenAgent?: (agent: { agentId: string; projectId?: string }) => void;
}

export function EpicTaskCards({
  epicId,
  allBeads,
  agents,
  buildAgents,
  onOpenTask,
  onOpenAgent,
}: EpicTaskCardsProps) {
  const rows = epicChildViews(allBeads, agents, epicId);
  // ONCE FOR THE WHOLE LIST, never per card. `hooks/useEpicHealthOf`'s header states the reason:
  // `rollupViewFor` buckets every worker by `parentId` on construction, so asking inside
  // `EpicTaskCard` would rebuild that map once per child on every 5s poll. Called BEFORE the early
  // return below, because a hook cannot sit after a conditional exit.
  const beadHealthOf = useBeadHealthOf(agents);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const toggleExpanded = useCallback((beadId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(beadId)) next.delete(beadId);
      else next.add(beadId);
      return next;
    });
  }, []);

  const grouped =
    buildAgents === undefined
      ? null
      : groupEpicAgentsByTask({
          buildAgents,
          agents,
          taskIds: rows.map((r) => r.bead.id),
        });

  // An epic with no tasks AND no strays draws nothing at all — the same rule `BeadLineageRows`
  // rule 3 takes, and what keeps a still-decomposing epic free of an empty block.
  if (rows.length === 0 && (grouped === null || grouped.unassigned.length === 0)) return null;

  return (
    <div
      data-testid="epic-task-cards"
      style={{ display: "flex", flexDirection: "column", gap: 6 }}
    >
      {rows.map((row) => (
        <EpicTaskCard
          key={row.bead.id}
          row={row}
          agents={agents}
          /* FINISHED WORK GETS NO MARK — `beadHealthApplies` is where that is decided, the same
             shape `EpicsColumn` uses for a terminal rung. A closed child sitting under a gray
             square would read "nobody is working on this", which is true and useless; nothing
             rendered cannot be mistaken for calm. */
          health={beadHealthApplies(row.bead.status) ? beadHealthOf(row.bead.id) : null}
          expanded={expandedIds.has(row.bead.id)}
          onToggleExpand={toggleExpanded}
          onOpen={onOpenTask}
          agentPills={grouped === null ? undefined : (grouped.byTask.get(row.bead.id) ?? [])}
          onOpenAgent={onOpenAgent}
        />
      ))}

      {/* ── THE FALLBACK GROUP ────────────────────────────────────────────────────────────────
          NOT BEHIND AN EXPAND, unlike a task card's agents: there is no task here to expand INTO,
          and an affordance that hides a thing behind a gesture that has no subject is how the
          agents got lost in the first place. Drawn only when there is something to draw. */}
      {grouped !== null && grouped.unassigned.length > 0 && (
        <div
          data-testid="epic-unassigned-agents"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 4,
            alignItems: "center",
            padding: "6px 8px",
            background: C.forest,
            borderRadius: 6,
            fontFamily: FONT_UI,
          }}
        >
          <span style={{ color: C.muted, fontSize: TYPE.small }}>{UNASSIGNED_AGENTS_LABEL}</span>
          {grouped.unassigned.map((pill) => (
            <AgentChip key={pill.id} pill={pill} onOpen={onOpenAgent} />
          ))}
        </div>
      )}
    </div>
  );
}
