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
import { useEffect, useState } from "react";
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
import type { WorkflowStageId } from "../engine/workflowStage";
import type { AgentTab } from "../types";

const NO_AGENTS: AgentTab[] = [];

export function EpicInlineCard({
  bead,
  projectId,
  rootPath,
  allBeads,
  onClose,
}: {
  bead: Bead;
  projectId: string;
  /** Every bd write is addressed by path. `null` degrades the card to read-only rather than
   *  offering controls that cannot work — the same contract the board's overlay takes. */
  rootPath: string | null;
  allBeads: readonly Bead[];
  onClose: () => void;
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
        onClose={onClose}
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

/** A little breathing room from the rows above and below, and nothing else — the card paints its
 *  own surface. Separate so the caller's JSX stays a bare `<EpicInlineCard/>` between two rows. */
function EpicCardFrame({ children }: { children: React.ReactNode }) {
  return <div data-testid="epic-inline-card">{children}</div>;
}
