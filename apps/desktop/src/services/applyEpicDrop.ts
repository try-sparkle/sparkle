// EXECUTING a drop plan — the ONE place a ladder drop talks to `bd`.
//
// The split from `services/epicDrop` is deliberate and load-bearing: that module decides and this
// one acts. Nothing here has an opinion about the ladder (it never mentions a rung), and nothing
// there can reach `invoke` (its output is an inert list of named writes). So the rule stays
// testable with no mocked Tauri, and this file stays testable with no fixture backlog.
//
// ── EVERY WRITE IS A PRIMITIVE THAT ALREADY EXISTS ────────────────────────────────────────────
// No new Tauri command, no new bead field. `claimBead` / `unclaimBead` / `closeBead` / `labelBead`
// are the same wrappers the board's own controls use, and `sendToBuild` is the one existing binder
// of an orchestrator to an epic. That is what "reuse, do not duplicate" has to mean here — the
// board has no card drag to share, so what is shared is the WRITE LAYER underneath both.
import { claimBead, closeBead, labelBead, unclaimBead } from "./beads";
import { sendToBuild } from "./sendToBuild";
import { useBeadsStore } from "../stores/beadsStore";
import type { EpicDropAccepted } from "./epicDrop";

/** The seams `applyEpicDrop` writes through. Injectable ONLY so the test can observe order and
 *  failure; production always takes the defaults below.
 *
 *  ══ WHY THE DEFAULTS LIVE HERE AND NOT AT THE CALL SITE ═══════════════════════════════════════
 *  `AGENTS.md` names the "defaulted seam every test injects" as a shape that goes silently vacuous:
 *  when every test passes its own `deps`, the line supplying the real value is covered by nothing —
 *  delete it and the suite stays green while the feature is dead. So the column calls
 *  `applyEpicDrop` with NO deps argument, and `EpicsColumn.drag.test.tsx` drives that same
 *  no-argument path with the module mocked, which is what keeps this wiring covered. */
export interface EpicDropDeps {
  claim: typeof claimBead;
  unclaim: typeof unclaimBead;
  close: typeof closeBead;
  label: typeof labelBead;
  build: typeof sendToBuild;
  refresh: (projectId: string, rootPath: string) => Promise<void>;
}

const DEFAULT_DEPS: EpicDropDeps = {
  claim: claimBead,
  unclaim: unclaimBead,
  close: closeBead,
  label: labelBead,
  build: sendToBuild,
  refresh: (projectId, rootPath) => useBeadsStore.getState().refresh(projectId, rootPath),
};

export interface ApplyEpicDropArgs {
  projectId: string;
  rootPath: string;
  epicId: string;
  /** Repo-relative PRD path parsed from the epic's description, or null for a PRD-less epic —
   *  `sendToBuild` then seeds the orchestrator from the epic bead itself. Same rule the card's own
   *  Build It button uses; not re-derived here. */
  prdPath: string | null;
  plan: EpicDropAccepted;
}

/**
 * Run an accepted plan's writes, then refresh so the card moves NOW rather than on the next poll.
 *
 * ══ SEQUENTIAL, AND IN THE ORDER THE PLAN LISTS ═══════════════════════════════════════════════
 * Not `Promise.all`. The writes are not independent — `epicDrop.writesFor` emits `label-remove`
 * BEFORE `close` for the Done rung precisely because `columnFor` ranks `delivered` above plain
 * closed, and a concurrent pair can land in either order. Each `await` also means a failure stops
 * the rest instead of leaving a half-applied bead behind.
 *
 * ══ THE REFRESH IS NOT COSMETIC ═══════════════════════════════════════════════════════════════
 * The beads poll is on a 5s cadence at its FLOOR and backs off to 60s under fleet load. Without an
 * explicit refresh the card sits in its old rung for up to a minute after a gesture the user has
 * already completed, which reads as a drop that did not work — and invites them to drag it again,
 * which is a second write.
 *
 * ══ WHY A FAILED WRITE IS NOT ROLLED BACK ═════════════════════════════════════════════════════
 * `useBeadBuildActions` rolls its claim back when `sendToBuild` throws, and that is right THERE:
 * the claim is bookkeeping for a handoff that did not happen. Here the bead writes are what the
 * user asked for in their own right — a `claim` that succeeded before a later write failed has
 * genuinely moved the epic to the rung they aimed at, and undoing it would discard a change they
 * can see. The refresh still runs (in `finally`), so the column shows what actually landed rather
 * than what was hoped for, and the error is re-thrown for the caller to surface.
 */
export async function applyEpicDrop(
  { projectId, rootPath, epicId, prdPath, plan }: ApplyEpicDropArgs,
  deps: EpicDropDeps = DEFAULT_DEPS,
): Promise<void> {
  try {
    for (const write of plan.writes) {
      switch (write.kind) {
        case "claim":
          await deps.claim(rootPath, epicId);
          break;
        case "unclaim":
          await deps.unclaim(rootPath, epicId);
          break;
        case "close":
          await deps.close(rootPath, epicId);
          break;
        case "label-add":
          await deps.label(rootPath, "add", epicId, write.label);
          break;
        case "label-remove":
          await deps.label(rootPath, "remove", epicId, write.label);
          break;
        case "send-to-build":
          // NOT awaited-as-a-promise: `sendToBuild` is synchronous and returns the agent id. It is
          // also the one write that can throw for a reason the user must see (unknown project, at
          // capacity), so it is deliberately inside the try.
          //
          // `reveal` is left at its default. A drop onto Build: Active is a direct request to build
          // this epic now — the same gesture as the card's Build It button, which takes the view —
          // so quietly starting an orchestrator the user is never shown would be the surprising
          // half of the behaviour, not the polite one.
          deps.build({ projectId, epicId, prdPath, mode: "epic" });
          break;
      }
    }
  } finally {
    await deps.refresh(projectId, rootPath).catch(() => {
      // A refresh that fails costs the user a few seconds of staleness — the poll will catch up.
      // It must never mask the write error this `finally` is running underneath.
    });
  }
}
