// "Build It" — the handoff from a unit of work to an agent that builds it.
//
// ══ WHY THIS IS A HOOK AND NOT THREE HANDLERS ON A COMPONENT ═══════════════════════════════════
// These three actions lived inside `BoardView`'s `DetailOverlay` and nowhere else, which meant the
// board's expanded card could start work and the concierge's card could not — the founder asked for
// full action parity between the two, and the only honest way to get it is for both to call the
// SAME code. Copying the bodies would have delivered parity for one afternoon.
//
// ══ WHAT WAS DROPPED IN THE EXTRACTION, AND WHY ════════════════════════════════════════════════
// The presentation. `DetailOverlay` held `buildBusy`/`buildErr` in its own state and each handler
// set them; here the actions THROW, and whichever card renders them owns the busy flag and the
// error line. That is what lets one card serve two chromes without either of them inheriting the
// other's error placement — and it keeps the partial-batch sentence ("Started 2 of 5; the rest are
// untouched.") intact, because it travels as the thrown Error's message rather than as a setState.
//
// Everything else is carried across unchanged, including the two orderings that were review
// findings in their own right:
//
//   * The capacity PREFLIGHT runs BEFORE the claim. `claimBead` moves the bead to `in_progress`,
//     which on the board moves the card out of the column that renders the control at all — so
//     claiming and then failing hides the button the user just pressed (roborev 55139).
//   * `handleBuildAllPrd` preflights INSIDE the loop. The ceiling can be reached partway through a
//     batch, and claiming an epic that then cannot be handed off marks it in progress with no
//     orchestrator behind it. It stops cleanly and says how far it got.
import { useCallback, useMemo } from "react";
import { claimBead, type Bead } from "../../services/beads";
import { parsePrdRef } from "../../services/tasks";
import { sendToBuild, sendToBuildBlockedReason } from "../../services/sendToBuild";
import { useProjectStore } from "../../stores/projectStore";

export interface BeadBuildActions {
  /** The PRD this epic's body names, or null for a PRD-less epic (the handoff seeds off the bead). */
  prdPath: string | null;
  /** Sibling epics sharing this PRD, INCLUDING this one. `<= 1` means there is no batch to offer. */
  prdEpics: Bead[];
  /** Claim this epic and hand it to the Build orchestrator, which fans one worker out per child. */
  buildEpic: () => Promise<void>;
  /** Claim this bead and build it on ONE isolated worker branch — no fan-out. */
  buildTask: () => Promise<void>;
  /**
   * Claim and hand off every epic that shares this PRD, in turn — or NULL when this bead is not an
   * epic, or is the only epic in its PRD.
   *
   * ══ THE EPIC GATE LIVES HERE, NOT AT THE CALL SITES ═════════════════════════════════════════
   * `prdPath` is parsed out of THIS bead's description, and `parsePrdRef` matches a `PRD file:`
   * line in any body regardless of type. So a task or bug carrying a PRD back-link resolves a
   * non-empty `prdEpics`, and a caller gating only on `prdEpics.length > 1` offers "Build all N
   * epics in this PRD" on a card for a bead that is not one of them — one press claiming and
   * handing off every epic in that PRD. Both surfaces made exactly that mistake independently
   * (roborev on BeadPill, then again on BoardView), which is the signal the gate belongs to the
   * shared hook rather than to whoever renders it.
   */
  buildAllPrd: (() => Promise<void>) | null;
  /** `buildEpic` for an epic, `buildTask` for a task, and null for anything else — the caller does
   *  not have to re-derive which of the two a bead deserves. */
  buildIt: (() => Promise<void>) | null;
}

/**
 * The build actions for one bead.
 *
 * `rootPath` is looked up from the project store rather than taken as a prop, exactly as
 * `DetailOverlay` did: the surfaces that render this hold a `projectId` and would each have to do
 * the same lookup. A project that is not in the store yields `null`, and — again matching the
 * original — the claim is then SKIPPED while the handoff still runs, because `sendToBuild` throws
 * its own error for an unknown project and that is the more specific complaint.
 */
export function useBeadBuildActions({
  bead,
  projectId,
  allBeads,
  onStarted,
}: {
  bead: Bead;
  projectId: string;
  /** Every bead in the project — read to find the epics that share this one's PRD. */
  allBeads: readonly Bead[];
  /** Ran after a handoff lands. The board closed its overlay here; the concierge closes its card. */
  onStarted?: () => void;
}): BeadBuildActions {
  const rootPath = useProjectStore(
    (s) => s.projects.find((p) => p.id === projectId)?.rootPath ?? null,
  );
  const prdPath = useMemo(() => parsePrdRef(bead.description)?.relPath ?? null, [bead.description]);
  const prdEpics = useMemo(
    () =>
      prdPath === null
        ? []
        : allBeads.filter((b) => b.type === "epic" && parsePrdRef(b.description)?.relPath === prdPath),
    [allBeads, prdPath],
  );

  const buildOne = useCallback(
    async (mode: "epic" | "task") => {
      const blocked = sendToBuildBlockedReason(projectId, bead.id, mode);
      if (blocked) throw new Error(blocked);
      if (rootPath) await claimBead(rootPath, bead.id);
      sendToBuild({ projectId, epicId: bead.id, prdPath, mode });
      onStarted?.();
    },
    [projectId, bead.id, rootPath, prdPath, onStarted],
  );

  const buildEpic = useCallback(() => buildOne("epic"), [buildOne]);
  const buildTask = useCallback(() => buildOne("task"), [buildOne]);

  const buildAllPrd = useCallback(async () => {
    let built = 0;
    for (const epic of prdEpics) {
      const blocked = sendToBuildBlockedReason(projectId, epic.id);
      if (blocked) {
        throw new Error(`${blocked} Started ${built} of ${prdEpics.length}; the rest are untouched.`);
      }
      if (rootPath) await claimBead(rootPath, epic.id);
      sendToBuild({ projectId, epicId: epic.id, prdPath });
      built += 1;
    }
    onStarted?.();
  }, [prdEpics, projectId, rootPath, prdPath, onStarted]);

  return {
    prdPath,
    prdEpics,
    buildEpic,
    buildTask,
    // BOTH conditions, here rather than at each call site — see the interface note. A non-epic with
    // a PRD back-link in its body resolves a non-empty `prdEpics`, so `length > 1` alone is not a
    // gate; and one epic in its own PRD is not a batch.
    buildAllPrd: bead.type === "epic" && prdEpics.length > 1 ? buildAllPrd : null,
    buildIt: bead.type === "epic" ? buildEpic : bead.type === "task" ? buildTask : null,
  };
}
