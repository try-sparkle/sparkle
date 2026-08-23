// THE EPIC CARD, OPENED IN PLACE UNDER ITS OWN ROW.
//
// The founder: "when I click on an Epic row... it would open that Epic card below that row and it
// would push the rest of the epics down", and separately "I want to make sure that I'll be able to
// make comments on that epic."
//
// ══ WHY THIS IS A WRAPPER AND NOT A NEW CARD ═══════════════════════════════════════════════════
// `BeadCard` is already THE bead card, and its header records why: a bead used to be drawn by three
// components that shared no code, and the founder's ask was that they be identical. A fourth
// drawing of the same fields is exactly the drift that ended. So this resolves the four things the
// card needs from the surface it is on — the stage, the workers, the build actions and the comment
// thread — and renders the shared component in its `epics` chrome.
//
// It is the same shape as `ConciergeBeadCard`, deliberately: that wrapper solved this exact problem
// (wire a bead id to the shared card inside a narrow column) and any difference between them is a
// bug in one of the two.
//
// ══ A SIBLING, NOT A CHILD ═════════════════════════════════════════════════════════════════════
// `EpicRow` is a `<button>`, and a button may not contain another one — this card carries several.
// The board's own card documents the same constraint. The caller therefore renders this AFTER the
// row inside the stage group, which is also what makes the push-down free: it is in normal flow,
// so the rows below simply move.
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { BeadCard } from "./BeadCard/BeadCard";
import { beadsComment, beadsDetail, type BeadComment } from "../services/beadsCommands";
import { dispatchBeadChat } from "../services/beadChat";
import { beadStage, workersInEpic } from "../services/planView";
import { DELIVERED_LABEL, isEpic, type Bead } from "../services/beads";
import { setBeadPriority } from "./BeadCard/beadPriority";
import { useBeadBuildActions } from "./BeadCard/useBeadBuildActions";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { sideOf } from "../engine/pairs";
import { beadLineageOf } from "../engine/beadLineage";
import { openProjectTab, selectProjectOnItsSide } from "../services/openProjectTab";
import type { WorkflowStageId } from "../engine/workflowStage";
import type { AgentTab } from "../types";

const NO_AGENTS: AgentTab[] = [];

export function EpicInlineCard({
  bead,
  projectId,
  rootPath,
  allBeads,
}: {
  bead: Bead;
  projectId: string;
  /** Every bd write is addressed by path. `null` degrades the card to read-only rather than
   *  offering controls that cannot work — the same contract the board's overlay takes. */
  rootPath: string | null;
  allBeads: readonly Bead[];
}) {
  const agents = useProjectStore(
    (s) => s.projects.find((p) => p.id === projectId)?.agents ?? NO_AGENTS,
  );
  // THE GOAL, READ AND WRITTEN THROUGH THE SAME STORE `EpicGoalRow` USES. Two surfaces reading one
  // record, not two records — `setEpicGoal` is the only writer either of them has.
  const goal = useProjectStore(
    (s) => s.projects.find((p) => p.id === projectId)?.epicGoals?.[bead.id],
  );
  const setEpicGoal = useProjectStore((s) => s.setEpicGoal);
  const workerIds = agents.filter((a) => a.kind === "worker" && a.beadId === bead.id).map((a) => a.id);
  // ONLY this bead's workers' stages, shallow-compared — the same narrowing the concierge card uses,
  // so a stage tick on an unrelated agent does not repaint the open card on every poll.
  const workerStages = useRuntimeStore(
    useShallow((s) => workerIds.map((w) => s.workflowStage[w]).filter(Boolean) as WorkflowStageId[]),
  );
  const stage = beadStage(bead.status, bead.labels.includes(DELIVERED_LABEL), workerStages);
  const build = useBeadBuildActions({ bead, projectId, allBeads });

  // EPIC-NESS COMES FROM `isEpic`, NEVER FROM A TYPE-FIELD EQUALITY TEST WRITTEN OUT HERE. That
  // predicate has one owner (`services/beads.ts`) and `scripts/lib/epic-membership-guard.sh` fails
  // CI on a second copy — which is exactly what the two inline type tests here were, and they
  // reddened `Node — shell` on this branch's first commit.
  //
  // The forbidden comparison is DESCRIBED rather than quoted, on purpose: the guard's pattern is
  // deliberately broad and does not skip comment lines, so writing the literal out — even inside a
  // sentence telling you not to write it — reds the guard. It did, one edit ago. Same convention as
  // `services/planView.ts` and as `EpicsColumn.tsx` for the label-treatment ratchet. Do not
  // "restore" the example.
  //
  // IT IS ALSO THE WRONG ANSWER, not merely a duplicated one. `isEpic` is `isTypedEpic(bead) ||
  // has children`: structure first, because `issue_type` is a label someone did or did not remember
  // to set while a parent edge is a fact another bead asserted. A raw type test therefore denies the
  // goal field to every epic that was never typed but has children — and those render in this very
  // column, so the card would show no goal on a card the Epics column had already called an epic.
  //
  // Computed ONCE rather than at each of the two props below: `isEpic` walks the memoised epic index
  // per call, and two identical reads per render is the shape that later drifts into two different
  // answers.
  const beadIsEpic = isEpic(allBeads, bead);

  // ── THIS CARD'S LINEAGE: THE `Tasks:` AND `Build agents:` ROWS ───────────────────────────────
  // The founder, 2026-08-22: *"I should ALWAYS be able to see the children or parent of any card"*
  // — and the rows must be the SAME two rows here as in the concierge thread and on the board:
  // *"whether it's in the concierge chat or on the planning board, I think it would still just show
  // me two rows."* One engine, three surfaces; a card that resolved its own lineage is a card that
  // can disagree with the next one.
  //
  // `allBeads` is passed STRAIGHT THROUGH from the
  // store. The index is WeakMap-cached on the array's IDENTITY, so copying, slicing or re-sorting it
  // first would mint a fresh key on every render and silently defeat the cache — and this column
  // re-reads its ladder on the beads store's 5s poll. A raw per-card scan measured 3.4–4.0s on the
  // founder's 7,364-bead store.
  const lineage = useMemo(
    () => beadLineageOf({ beads: allBeads, bead, agents, projectId }),
    [allBeads, bead, agents, projectId],
  );

  // ── THE COMMENT THREAD, READ PER-OPEN ───────────────────────────────────────────────────────
  // `beads_detail` carries `--include-comments`, and this effect runs when a card is OPENED rather
  // than on the beads poll. That matters more here than on the board: the Epics column re-reads its
  // ladder on the same 5s tick, and pulling a whole thread on every tick would hammer a bd store
  // that is already single-writer and contended.
  const [comments, setComments] = useState<BeadComment[] | undefined>(undefined);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (rootPath === null) return;
    let alive = true;
    beadsDetail(rootPath, bead.id)
      .then((d) => {
        if (alive) setComments(d.comments);
      })
      // A failed read degrades to an EMPTY thread rather than to no thread: the compose box has its
      // own error surface, and a card that cannot be commented on because a read failed is worse
      // than one that shows nothing yet.
      .catch(() => {
        if (alive) setComments([]);
      });
    return () => {
      alive = false;
    };
  }, [rootPath, bead.id, reload]);

  const canWrite = rootPath !== null && rootPath !== "";
  return (
    <EpicCardFrame>
      <BeadCard
        chrome="epics"
        bead={bead}
        stage={stage}
        // EVERY WORKER IN THE EPIC, not just the ones bound to the epic's own bead id. The
        // founder saw an empty space on a card reading nine-of-nine: workers are dispatched
        // against the CHILDREN, so `workersForBead(agents, bead.id)` was correct code answering
        // the wrong question and rendered empty on precisely the busiest epics.
        workers={workersInEpic(agents, allBeads, bead.id)}
        // CAPPED, unlike the board's overlay. That panel is its own scroller; this card sits inside
        // the column's list, so an uncapped description would push the whole ladder off screen.
        descMaxHeight={160}
        // NO BLUE BAR ON THIS CARD — the founder's item 22, [13:17] *"we don't wanna have this
        // little blue bar here."* The switch is a prop rather than a branch inside `BeadCard`, so
        // this surface owns the decision and no other card is changed by it; see `showStageLine`.
        showStageLine={false}
        // NO CLOSE BUTTON ON THIS CARD — item 16, [07:30]: the chat button *replaces* it. The X did
        // not disappear, it MOVED: it now renders in the epic row's count slot, where the founder
        // put it ([07:51] "put the x in the top, where it says the six out of six when it's
        // closed"). Passing `onClose` here as well would paint a SECOND close control one row below
        // the first, which is what shipped briefly while the two halves of item 15 were in separate
        // PRs. `EpicsColumn` owns closing now, through the row's own toggle.
        // THE CHAT BUTTON, [07:30] *"We're also missing a chat button."* Bound HERE rather than
        // threaded down from `Workspace` through `EpicsColumn`, which is exactly what the
        // concierge's `BeadPill` does (`dispatchBeadChat(bead, projectId)`) and for the same
        // reason: this card already holds both arguments, and the callback `BeadCard` takes is a
        // bare `() => void` that never learns what a bead chat is addressed by.
        //
        // GATED ON `canWrite` for the same reason every other control here is: `dispatchBeadChat`
        // writes a draft addressed to this project, and a card with no project path is read-only.
        onChat={canWrite ? () => dispatchBeadChat(bead, projectId) : undefined}
        // ONLY FOR AN EPIC, and gated on being able to WRITE. `canWrite` is the same `rootPath`
        // test every other control here takes: a card with no project path shows a read-only bead
        // rather than a field whose save can only fail.
        //
        // WHY THIS MATTERS RIGHT NOW: PR #2285 removes the goal from the epic ROW, which was its
        // only editing surface anywhere in the app — and the epic goal is not a readout. It is a
        // live input to dispatch (`workerSpawn.ladderGoalFor` injects it into every spawned
        // worker's goal; `sendToBuild.epicGoalLadder` pastes it verbatim into the build handoff).
        // Until this field exists, an auto-written goal steers real work with nothing able to
        // correct it.
        goal={beadIsEpic ? goal : undefined}
        onSetGoal={
          canWrite && beadIsEpic
            ? (text, source) => setEpicGoal(projectId, bead.id, text, source)
            : undefined
        }
        onSetPriority={canWrite ? (p) => setBeadPriority(rootPath, bead.id, p) : undefined}
        onBuildIt={canWrite ? (build.buildIt ?? undefined) : undefined}
        onBuildAllPrd={canWrite ? (build.buildAllPrd ?? undefined) : undefined}
        prdEpicCount={build.prdEpics.length}
        lineage={lineage}
        // ── A TASK PILL OPENS THAT TASK'S OWN CARD, ON THE BOARD ─────────────────────────────
        // The Epics column opens EPIC rows in place (`EpicRow` → this card); a child task has no
        // row of its own here, so "open that bead's card" means the board's `DetailOverlay` —
        // exactly what `Concierge/BeadPill` does from the other column that has no board of its
        // own. See `openBeadCardOnBoard` for why the two writes are ordered the way they are.
        onOpenBead={(beadId) => openBeadCardOnBoard(beadId, projectId)}
        // ── A BUILD-AGENT PILL IS A REAL LINK ────────────────────────────────────────────────
        // The founder: build-agent pills *"are REAL LINKS: clicking one jumps to that agent, the
        // same affordance the concierge uses in chat."* `openProjectTab` IS that affordance — the
        // concierge's `AgentPill` reaches the same `selectAndOpen` through it — so a pill clicked
        // in this column and the same pill clicked in chat land the reader in the same place.
        //
        // No `onClose` here, unlike the board's overlay: this card is not a modal over the thing
        // being revealed. `selectAndOpen` switches this pair to Build, which paints the agent's
        // pane over the column the card sits in, so the jump is visible without closing anything.
        //
        // The pill's own `projectId` first, this card's as the fallback — an agent is addressed by
        // the project whose roster it came from.
        onOpenAgent={({ agentId, projectId: pillProjectId }) => {
          openProjectTab(pillProjectId ?? projectId, agentId);
        }}
        comments={comments}
        onComment={
          canWrite
            ? async (text: string) => {
                await beadsComment(rootPath, bead.id, text);
                setReload((n) => n + 1);
              }
            : undefined
        }
      />
    </EpicCardFrame>
  );
}

/**
 * OPEN A BEAD'S CARD THE WAY THE BOARD OPENS ONE — from a column that has no board of its own.
 *
 * ══ THE ORDER IS LOAD-BEARING ═══════════════════════════════════════════════════════════════════
 * `openPlanBoard` FIRST, `setBoardFocusBeadId` SECOND. The focus id is a ONE-SHOT that `BoardView`
 * consumes and clears as soon as the bead appears in a snapshot; set against a board that is not
 * rendering yet, the handoff is spent on a surface nobody mounted and the card simply never opens.
 * `openPlanBoard`, never a bare `setWorkMode(side, "plan")` — the latter moves the chevron and
 * leaves the board invisible, which is the identical failure by a different route.
 *
 * ══ THE SIDE IS READ, NOT PICKED — BY BOTH WRITES ═══════════════════════════════════════════════
 * `boardFocusBeadId` is app-global, so the side has to come from somewhere. It comes from where the
 * bead's project already lives (`sideOf`, total, defaulting to the historical single-pair "right"),
 * which is the only answer that stays correct in a two-pair cockpit. The project is SELECTED first
 * for the same reason: a board showing a different project would never contain the bead, the
 * one-shot would sit unconsumed, and the click would look like it did nothing.
 *
 * The selection therefore goes through `services/openProjectTab.selectProjectOnItsSide`, NOT
 * `projectStore.selectProject`. That heading used to be a half-truth: only the `openPlanBoard` line
 * read the side, while the bare `selectProject` wrote `selectedProjectId` — which is the RIGHT
 * pair's selection. For a LEFT-assigned project the two writes then DISAGREED, and the disagreement
 * was not confined to this card: `Workspace`'s reconcile effect discards a left id it finds there
 * and the right pair falls back to its own first project, so opening a left-pair epic's task
 * silently changed what the OTHER half of the screen was showing (roborev 55149 / 68041). The
 * helper is idempotent for a project already selected on its own side, so there is no guard here.
 *
 * ══ THIS IS THE SECOND COPY OF THIS SEQUENCE, KNOWINGLY ═════════════════════════════════════════
 * `Concierge/BeadPill` holds a module-private `viewOnBoard` doing the same three writes for the same
 * reason (a column beside the board, with no board of its own). It belongs in a shared service and
 * this comment is the marker for the extraction; it was not done in this change because that file
 * is owned by concurrent work and a rewrite of it here would delete edits nobody had read.
 * `selectProjectOnItsSide` is what that extraction should look like when it happens — one exported
 * helper the callers reach for, rather than a rule re-derived per surface. It was itself extracted
 * after four copy-pasted derivations of the same rule, one of which was wrong (roborev 55192).
 *
 * Returns whether a board could be opened at all, so a caller that wants to say something can.
 */
function openBeadCardOnBoard(beadId: string, projectId: string): boolean {
  const projects = useProjectStore.getState();
  // No such project: there is no board to open, and nothing is written.
  if (!projects.projects.some((p) => p.id === projectId)) return false;
  selectProjectOnItsSide(projectId);
  const ui = useUiStore.getState();
  ui.openPlanBoard(sideOf(ui.pairAssignment, projectId));
  ui.setBoardFocusBeadId(beadId);
  return true;
}

/** A little breathing room from the rows above and below, and nothing else — the card paints its
 *  own surface. Separate so the caller's JSX stays a bare `<EpicInlineCard/>` between two rows. */
function EpicCardFrame({ children }: { children: React.ReactNode }) {
  return <div data-testid="epic-inline-card">{children}</div>;
}
