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
import { EpicTaskCards } from "./EpicTaskCard";
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
import { openBeadOnBoard } from "../services/openBeadOnBoard";
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

  // ── ON AN EPIC, BOTH LINEAGE ROWS COME OFF THE CARD ─────────────────────────────────────────
  // Bead sparkle-huw924.10, the founder re-asking for the second time: *"I had already previously
  // asked that the build agents not show outside of the tasks — that the epic will surface the
  // tasks. And I want the tasks to look more like they do in the Plan board cards."*
  //
  //   • `Tasks:` went because it was a LOSSY copy of what the task cards below now draw in full —
  //     one chip and a `+4 more` standing in for the whole plan. The board's own epic card dropped
  //     it for the same reason and by the same means (`BoardView.DetailOverlay`, bead
  //     sparkle-huw924.9); this is that decision reaching the column it was never applied to.
  //   • `Build agents:` went because it was the WRONG SHAPE, not merely a duplicate: a flat list
  //     beside a flat list, *"so nothing tells you WHICH agent is on WHICH task — which is the
  //     entire question the card should answer."* Every one of those agents is still drawn, now
  //     inside the task it is bound to (`planView.groupEpicAgentsByTask`), and the ones nothing can
  //     attribute are drawn in the fallback group rather than dropped — see `EpicTaskCards`.
  //
  // A NON-EPIC CARD IS UNTOUCHED. It has no task cards under it, so its `Tasks:` row is the only
  // place its children are ever named and removing it would delete information rather than a
  // duplicate. Same asymmetry, same reason, as the board's overlay.
  const cardLineage = useMemo(
    () => (beadIsEpic ? { ...lineage, tasks: [], buildAgents: [] } : lineage),
    [lineage, beadIsEpic],
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
        // ── `Board` — RIGHT OF THE YELLOW EPIC PILL ──────────────────────────────────────────
        // The founder, 2026-08-24, with a screenshot of this very card: *"For epics on the epic
        // column, I want a [link] to the right of the yellow epic pill that says 'board view' and
        // opens the epic on the planning board"* — and, on how it should read: *"in the epic column
        // just have 'Board view' where 'Board' is hyperlink."* On 2026-08-26 he took the trailing
        // word out too (*"take out the word 'view'"*, sparkle-huw924.14), so it reads `Board`.
        //
        // THIS COLUMN HAD NO WAY TO THE BOARD AT ALL. Not a rename and not a move: `EpicInlineCard`
        // passed neither destination callback, so the epic card here offered the board nowhere,
        // while the concierge's copy of the same `BeadCard` had carried one since it was written.
        // The card draws the link itself, in its chrome row, off this callback alone.
        //
        // ══ ONLY THE BOARD, NOT THE PAIR — AND THAT IS DELIBERATE ═══════════════════════════════
        // `onOpenInColumn` is NOT passed, so no `Column` link is drawn here and the row reads
        // `Board` alone. Asked directly, the founder chose just the board link: this column's
        // whole job is already to narrow the build column — clicking an epic ROW does exactly that
        // (`uiStore.epicFocusBySide` calls it *"the point of the epics column rather than a
        // refinement of it"*) — so a `Column` link on the card would be a second, quieter way to do
        // what the reader just did to open the card.
        //
        // ══ NOT GATED ON `canWrite`, UNLIKE ITS NEIGHBOURS ══════════════════════════════════════
        // Chat, the priority control and the goal field all take `canWrite` because they WRITE
        // through `bd` and a card with no project path can only fail. This navigates. A project
        // with no `bd` path still has a board and still has this bead on it, so gating it would
        // remove a working destination to protect a write that never happens — the same reading
        // `Concierge/BeadPill` records for its own copy of this link.
        //
        // `openBeadOnBoard` is the SHARED service, not a sequence written out here. Its four writes
        // have a load-bearing order and have already been mis-derived once in this very file (it
        // used to hold an `openBeadCardOnBoard` that called the wrong project selector — roborev
        // 68041). It returns whether a board could be opened at all; there is nothing on this card
        // to say so with, and the bead came FROM this project's own ladder, so the answer is always
        // true here and is deliberately dropped rather than pretended to be handled.
        onViewOnBoard={() => {
          openBeadOnBoard({ beadId: bead.id, projectId });
        }}
        onBuildIt={canWrite ? (build.buildIt ?? undefined) : undefined}
        onBuildAllPrd={canWrite ? (build.buildAllPrd ?? undefined) : undefined}
        prdEpicCount={build.prdEpics.length}
        lineage={cardLineage}
        // ── THE TASKS, AS PLAN-BOARD CARDS, INSIDE THIS CARD'S BORDER ─────────────────────────
        // `EpicTaskCard` IS the Plan board's task card — mounting it here is what makes the two
        // surfaces one treatment rather than a third drawing of an epic (bead sparkle-xelans
        // records that this repo already shipped three). It goes through `footer` rather than
        // beside the card because in THIS column the card carries the border, so a sibling would
        // hang below the edge; the board's overlay is a bordered panel and can render it beside.
        //
        // `lineage.buildAgents` — the FULL resolved set, not the emptied `cardLineage` one — is
        // what gets partitioned, so nothing the deleted row used to name can be lost.
        footer={
          beadIsEpic ? (
            <EpicTaskCards
              epicId={bead.id}
              allBeads={allBeads as Bead[]}
              agents={agents}
              buildAgents={lineage.buildAgents}
              // DOUBLE CLICK / Enter on a task NARROWS THE BUILD COLUMN to it — the founder's
              // gesture, *"if I click on one of the children, I can see the exact build agent or
              // agents that are working on that child"* — which is what the `Tasks:` pill used to
              // do here and is preserved verbatim through the task card's own open seam. A SINGLE
              // click expands the card in place instead, which is the other half of the same ask.
              onOpenTask={(b) => focusChildTaskInColumn(b.id, projectId)}
              // ── A BUILD-AGENT CHIP IS A REAL LINK ──────────────────────────────────────────
              // Unchanged from the row it replaces: *"clicking one jumps to that agent, the same
              // affordance the concierge uses in chat."* `openProjectTab` IS that affordance.
              onOpenAgent={({ agentId, projectId: pillProjectId }) => {
                openProjectTab(pillProjectId ?? projectId, agentId);
              }}
            />
          ) : undefined
        }
        // ── A TASK PILL NARROWS THE BUILD COLUMN TO THAT TASK ────────────────────────────────
        // THE FOUNDER ASKED FOR THIS GESTURE BY NAME: *"if I click on one of the children, I can
        // see the exact build agent or agents that are working on that child… that's one way for me
        // to get a view that I need, which is to be able to see what actual active building is
        // being done against any given task."*
        //
        // It previously opened the task's own card on the BOARD, which is a defensible reading of
        // "open that bead" and the wrong one for THIS column. The Epics column exists to drive the
        // build column's focus — `uiStore.epicFocusBySide` calls it "the point of the epics column
        // rather than a refinement of it" — so its rows narrow, and a child row narrowing one rung
        // further is that same gesture rather than a jump to a different surface.
        //
        // NOTHING IS LOST: the task's card is still one click away wherever cards are read (the
        // concierge's own card carries `Open · on board`), whereas the per-task build view had no
        // entry point anywhere in the app before this line.
        onOpenBead={(beadId) => focusChildTaskInColumn(beadId, projectId)}
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
 * NARROW THE BUILD COLUMN TO ONE CHILD TASK — the epics column's own gesture, one rung down.
 *
 * The founder: *"if I click on one of the children, I can see the exact build agent or agents that
 * are working on that child."* This is that click. It REPLACED a version that opened the task's
 * card on the board; see the call site for why this column narrows rather than jumps.
 *
 * ══ WHY IT LEAVES THE OPEN EPIC CARD OPEN, WHICH IS THE FOUNDER'S OTHER CONSTRAINT ══════════════
 * It writes ONLY `beadFocusBySide`. The epics column decides which card is expanded from
 * `epicFocusBySide` (`focusedEpicId === epic.id`), so a task id written into THAT key would match
 * no epic and snap shut the very card the reader just clicked into. Keeping the two rungs in two
 * keys is what makes this a drill-DOWN: `focusedBeadIdForSide` is `child ?? epic`, so the narrower
 * one wins while it holds and clearing it hands the column back to the epic (rule 2).
 *
 * ══ BOTH WRITES ARE REQUIRED ════════════════════════════════════════════════════════════════════
 * `showBuildStage` FIRST, then the focus. The narrowing is real but INVISIBLE while that side shows
 * the Plan board: `AgentSidebar` gates the focus banner — the only thing on screen that says a
 * filter is in force, and the only place its clear control lives — on `mode !== "plan"`. Unlike the
 * board path this file used to hold, neither write is a one-shot, so the order is for legibility
 * rather than correctness; both writes, however, are mandatory.
 *
 * ══ THE SIDE IS READ, NOT PICKED — BY BOTH WRITES ═══════════════════════════════════════════════
 * The focus is per-side, so the side has to come from somewhere. It comes from where the
 * bead's project already lives (`sideOf`, total, defaulting to the historical single-pair "right"),
 * which is the only answer that stays correct in a two-pair cockpit. The project is SELECTED first
 * for the same reason: a build column showing a different project holds none of this bead's agents,
 * so the narrowing would empty a column the reader never asked about and the click would look like
 * it did nothing.
 *
 * The selection therefore goes through `services/openProjectTab.selectProjectOnItsSide`, NOT
 * `projectStore.selectProject`. That heading used to be a half-truth here: only the side-aware line
 * read the side, while the bare `selectProject` wrote `selectedProjectId` — which is the RIGHT
 * pair's selection. For a LEFT-assigned project the two writes then DISAGREED, and the disagreement
 * was not confined to this card: `Workspace`'s reconcile effect discards a left id it finds there
 * and the right pair falls back to its own first project, so opening a left-pair epic's task
 * silently changed what the OTHER half of the screen was showing (roborev 55149 / 68041). The
 * helper is idempotent for a project already selected on its own side, so there is no guard here.
 *
 * ══ THIS IS THE SECOND COPY OF THIS SEQUENCE, KNOWINGLY ═════════════════════════════════════════
 * `Concierge/BeadPill.viewInColumn` does the same select-then-show-then-focus for the same reason
 * (a column beside the build column, reached from somewhere that is neither). The two differ only
 * in which setter they end on — a LINK there wants the idempotent `openBeadFocus`, a ROW here wants
 * the toggling `setBeadFocus` — so the shared part is the first two writes. It belongs in a shared
 * service and this comment is the marker for that extraction; `selectProjectOnItsSide` is what it
 * should look like when it happens — one exported helper the callers reach for, rather than a rule
 * re-derived per surface. It was itself extracted after four copy-pasted derivations of the same
 * rule, one of which was wrong (roborev 55192).
 *
 * Returns whether the column could be narrowed at all, so a caller that wants to say something can.
 */
function focusChildTaskInColumn(beadId: string, projectId: string): boolean {
  const projects = useProjectStore.getState();
  // No such project: there is no column to narrow, and nothing is written.
  if (!projects.projects.some((p) => p.id === projectId)) return false;
  selectProjectOnItsSide(projectId);
  const ui = useUiStore.getState();
  const side = sideOf(ui.pairAssignment, projectId);
  // BOTH WRITES, and the first is the one that is easy to drop: `AgentSidebar` gates the focus
  // banner — the only thing on screen that says a filter is in force, and the only place its clear
  // control lives — on `mode !== "plan"`. Narrowing a side that is showing the board is a filter
  // the reader can neither see nor undo.
  ui.showBuildStage(side);
  // `setBeadFocus`, the TOGGLING setter, deliberately: this is a ROW-like control that is its own
  // off-switch, exactly like the epic rows above it, so pressing the same task again hands the
  // column back to the epic (rule 2). A LINK labelled "Open" would want the idempotent
  // `openBeadFocus` instead — that is the distinction between the two setters, not an oversight.
  ui.setBeadFocus(side, beadId);
  return true;
}

/** A little breathing room from the rows above and below, and nothing else — the card paints its
 *  own surface. Separate so the caller's JSX stays a bare `<EpicInlineCard/>` between two rows. */
function EpicCardFrame({ children }: { children: React.ReactNode }) {
  return <div data-testid="epic-inline-card">{children}</div>;
}
