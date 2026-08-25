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
import { useCallback, useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import { C } from "../theme/colors";
import { FONT_UI, TYPE } from "../theme/scale";
import { beadStage, type EpicChildView } from "../services/planView";
import { DELIVERED_LABEL } from "../services/beads";
import { useRuntimeStore } from "../stores/runtimeStore";
import { stageMeta, stageLineColor, type WorkflowStageId } from "../engine/workflowStage";
import { WorkflowLine } from "./WorkflowLine";
import { EpicHealthSquare } from "./EpicHealthSquare";
import { beadHealthLabel } from "../engine/beadHealth";
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
}

export function EpicTaskCard({
  row,
  agents,
  health,
  expanded,
  onToggleExpand,
  onOpen,
}: EpicTaskCardProps) {
  const { bead, workers } = row;
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
          {workers.length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
              <span style={{ color: C.muted, fontSize: TYPE.small }}>Build agents:</span>
              {workers.map((name) => (
                <span
                  key={name}
                  data-testid="epic-task-card-agent"
                  style={{
                    color: C.tealInk,
                    fontSize: 12,
                    border: `1px solid ${C.hairline}`,
                    borderRadius: 4,
                    padding: "1px 7px",
                  }}
                >
                  {name}
                </span>
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
