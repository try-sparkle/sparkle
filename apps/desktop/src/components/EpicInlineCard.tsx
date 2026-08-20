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
import { beadStage, workersForBead } from "../services/planView";
import { DELIVERED_LABEL, type Bead } from "../services/beads";
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
  const workerIds = agents.filter((a) => a.kind === "worker" && a.beadId === bead.id).map((a) => a.id);
  // ONLY this bead's workers' stages, shallow-compared — the same narrowing the concierge card uses,
  // so a stage tick on an unrelated agent does not repaint the open card on every poll.
  const workerStages = useRuntimeStore(
    useShallow((s) => workerIds.map((w) => s.workflowStage[w]).filter(Boolean) as WorkflowStageId[]),
  );
  const stage = beadStage(bead.status, bead.labels.includes(DELIVERED_LABEL), workerStages);
  const build = useBeadBuildActions({ bead, projectId, allBeads });

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
        workers={workersForBead(agents, bead.id)}
        // CAPPED, unlike the board's overlay. That panel is its own scroller; this card sits inside
        // the column's list, so an uncapped description would push the whole ladder off screen.
        descMaxHeight={160}
        onClose={onClose}
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
