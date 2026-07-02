// Auto-decompose watcher for Plan epics (spec §7, plan Task 5): any epic that lands on the board
// with zero child tasks gets decomposed into child beads automatically. Safety rules, in order:
//   1. Single-window election — only the MAIN window ever runs the watcher (no cross-window race).
//   2. No retroactive backfill — a one-time baseline sweep per project labels every pre-existing
//      childless epic `decompose-exempt` WITHOUT decomposing it; only epics created after the
//      baseline auto-decompose. Removing the label opts an epic in manually.
//   3. Guard labels — `decomposing` is written BEFORE the AI call (skip the epic if that write
//      fails), swapped to `decomposed` on success or `decompose-failed` on error.
// Pure pickers up top (unit-tested), thin IO sweeps below. The beadsStore calls
// `maybeRunDecomposeWatcher` after each poll; every guard lives here so the store stays dumb.
import { childrenOf, labelBead, type Bead, type Board } from "./beads";
import {
  beadDepAdd,
  createBeadFull,
  decomposeEpic,
  readPrd,
} from "./tasks";
import { structuredJson } from "./anthropic";
import { writePrd } from "./prd";
import { aiFeatureMode, useSettingsStore } from "../stores/settingsStore";
import { parseWindowLabelFromSearch } from "./projectWindows.url";
import { log } from "../logger";

export const DECOMPOSING_LABEL = "decomposing";
export const DECOMPOSED_LABEL = "decomposed";
export const DECOMPOSE_FAILED_LABEL = "decompose-failed";
export const DECOMPOSE_EXEMPT_LABEL = "decompose-exempt";

/** Any of these labels takes an epic out of the auto-decompose pipeline. */
const SKIP_LABELS = [
  DECOMPOSING_LABEL,
  DECOMPOSED_LABEL,
  DECOMPOSE_FAILED_LABEL,
  DECOMPOSE_EXEMPT_LABEL,
];

/** Flatten the four board columns back into one bead list (childrenOf needs the full set). */
function boardBeads(board: Board): Bead[] {
  return [...board.backlog, ...board.inProgress, ...board.done, ...board.delivered];
}

/**
 * The epics the watcher may decompose this cycle: epics (only) that are not closed — finished
 * work never triggers an AI call — with ZERO children (in any column, any status) and NONE of
 * the four pipeline labels. Pure.
 */
export function pickEpicsToDecompose(board: Board): Bead[] {
  const beads = boardBeads(board);
  return beads.filter(
    (b) =>
      b.type === "epic" &&
      b.status !== "closed" &&
      !b.labels.some((l) => SKIP_LABELS.includes(l)) &&
      childrenOf(beads, b.id).length === 0,
  );
}

/**
 * The epics the one-time baseline sweep exempts: exactly the set that would otherwise
 * auto-decompose. Kept as its own export so the baseline contract is pinned independently.
 */
export function pickBaselineExemptEpics(board: Board): Bead[] {
  return pickEpicsToDecompose(board);
}

/**
 * Boot reclaim: epics still labeled `decomposing` when the watcher starts. Only the main window
 * ever decomposes, so a label surviving into a fresh session is stale by definition (crash or
 * quit mid-run) — the caller clears them so those epics re-enter the pipeline. Pure.
 */
export function pickStuckDecomposing(board: Board): Bead[] {
  return boardBeads(board).filter(
    (b) => b.type === "epic" && b.labels.includes(DECOMPOSING_LABEL),
  );
}

// ── Baseline flag ──────────────────────────────────────────────────────────────────────────────
// One localStorage flag per project marks "the baseline sweep already ran here". localStorage is
// per-app-instance, which matches the watcher's main-window election (one instance, one watcher).

function baselineKey(projectId: string): string {
  return `sparkle-decompose-baseline-${projectId}`;
}

export function hasDecomposeBaseline(projectId: string): boolean {
  try {
    return localStorage.getItem(baselineKey(projectId)) !== null;
  } catch {
    return false; // no localStorage (non-DOM env) → treat as un-baselined; the sweep is idempotent
  }
}

export function markDecomposeBaseline(projectId: string): void {
  try {
    localStorage.setItem(baselineKey(projectId), new Date().toISOString());
  } catch {
    // best-effort — worst case the baseline re-runs next session and re-labels (idempotent)
  }
}

// ── Sweep IO ───────────────────────────────────────────────────────────────────────────────────
// Thin, dependency-injected IO over the pickers. The beadsStore calls the watcher after each
// successful poll; everything below is unit-tested with fake deps.

export interface DecomposeSweepDeps {
  /** `bd label add|remove` — the guard-label writes. */
  labelBead: (
    projectPath: string,
    action: "add" | "remove",
    id: string,
    label: string,
  ) => Promise<void>;
  /** The AI decomposition itself (tasks.ts decomposeEpic with real backends wired). */
  decomposeEpic: (args: { projectPath: string; epic: Bead }) => Promise<unknown>;
  /** Failure reporting seam (log.error in prod). */
  logError?: (message: string, error: unknown) => void;
}

export interface DecomposeWatcherDeps extends DecomposeSweepDeps {
  /** Master AI gate — when off, the watcher must never fire an AI call (or mark failures). */
  aiEnabled: () => boolean;
}

/**
 * Decompose every picked epic, SERIALLY (each is an AI call — no parallel fan-out). Per epic:
 * write the `decomposing` guard label FIRST (skip the epic entirely if that write fails — an
 * unguarded AI call could race a second window), then decompose, then swap the label to
 * `decomposed` (add before remove, so the epic is never label-less mid-swap). A decomposition
 * error labels `decompose-failed` (visible on the card, retryable) and logs; one epic failing
 * never stops the sweep.
 *
 * `aiEnabled` (optional) is re-checked before EACH epic: the sweep is serial with one AI call per
 * epic and can run for minutes, so a master-gate toggle-off mid-sweep must stop further AI calls
 * (roborev 25169) — not just be honored at the watcher's entry.
 */
export async function runDecomposeSweep(
  deps: DecomposeSweepDeps,
  projectPath: string,
  board: Board,
  aiEnabled?: () => boolean,
): Promise<void> {
  for (const epic of pickEpicsToDecompose(board)) {
    // Master AI gate, re-checked per epic (see above) — bail the rest of the sweep if it flipped off.
    if (aiEnabled && !aiEnabled()) break;
    try {
      await deps.labelBead(projectPath, "add", epic.id, DECOMPOSING_LABEL);
    } catch (e) {
      deps.logError?.(`decompose guard-label write failed for ${epic.id} — skipping`, e);
      continue;
    }
    // Only the AI call itself decides success vs. failure. A bookkeeping-label write that fails
    // AFTER a successful decomposition must NOT masquerade as a decompose failure (roborev
    // 25168/25169): the children were created, so a red `decompose-failed` badge — or an epic
    // carrying BOTH `decomposed` and `decompose-failed` — would be a lie, and any retry off that
    // badge would re-decompose (duplicate children). So the AI call gets its own narrow try.
    try {
      await deps.decomposeEpic({ projectPath, epic });
    } catch (e) {
      deps.logError?.(`auto-decompose failed for epic ${epic.id}`, e);
      // Best-effort bookkeeping: the failure label is what makes the card badge + retry work,
      // but bd being down must not throw out of the sweep.
      try {
        await deps.labelBead(projectPath, "add", epic.id, DECOMPOSE_FAILED_LABEL);
        await deps.labelBead(projectPath, "remove", epic.id, DECOMPOSING_LABEL);
      } catch (labelErr) {
        deps.logError?.(`decompose-failed label write failed for ${epic.id}`, labelErr);
      }
      continue;
    }
    // Decomposition succeeded (children created). Swap the guard label to `decomposed` (add
    // before remove so the epic is never label-less mid-swap). A failure HERE is a bookkeeping
    // hiccup, not a decompose failure: log it and leave the `decomposing` label for boot reclaim
    // / the next cycle to resolve — never apply `decompose-failed`.
    try {
      await deps.labelBead(projectPath, "add", epic.id, DECOMPOSED_LABEL);
      await deps.labelBead(projectPath, "remove", epic.id, DECOMPOSING_LABEL);
    } catch (labelErr) {
      deps.logError?.(
        `decomposed-label swap failed for ${epic.id} (children created; leaving decomposing for reclaim)`,
        labelErr,
      );
    }
  }
}

/** The one-time baseline (spec §7 safety rule 2): label every pre-existing childless epic
 *  `decompose-exempt` WITHOUT decomposing it. The baseline flag is set only when every label
 *  write succeeded — a partial sweep re-runs next cycle (idempotent; already-labeled epics drop
 *  out of the pick). */
async function runBaselineExemptSweep(
  deps: DecomposeSweepDeps,
  projectId: string,
  projectPath: string,
  board: Board,
): Promise<void> {
  let allOk = true;
  for (const epic of pickBaselineExemptEpics(board)) {
    try {
      await deps.labelBead(projectPath, "add", epic.id, DECOMPOSE_EXEMPT_LABEL);
    } catch (e) {
      allOk = false;
      deps.logError?.(`baseline exempt-label write failed for ${epic.id}`, e);
    }
  }
  if (allOk) markDecomposeBaseline(projectId);
}

// Watcher session state, at module scope like beadsStore's timers: which projects have had their
// boot-time stuck-label reclaim, and which have a sweep currently in flight (a 5s poll cadence
// will land mid-AI-call; re-entrancy would double-decompose).
let bootReclaimed = new Set<string>();
let sweepInFlight = new Set<string>();

/** Test seam: the module-scope session state above survives across tests otherwise. */
export function __resetDecomposeWatcherStateForTests(): void {
  bootReclaimed = new Set();
  sweepInFlight = new Set();
}

export interface DecomposeWatcherOpts {
  isMain: boolean;
  projectId: string;
  projectPath: string;
  board: Board;
}

/**
 * The post-poll watcher entry. Guards, in order: main-window election (spec §7 safety rule 1),
 * the master AI gate, per-project re-entrancy. Then, once per session per project, boot-reclaim
 * any `decomposing` label that survived a crash/quit (only main ever decomposes, so a surviving
 * label is stale by definition). Then the one-time baseline exempt sweep — and when the baseline
 * runs, decomposition waits for the NEXT poll (this cycle's snapshot predates the exempt labels).
 * Otherwise, the decompose sweep.
 */
export async function maybeRunDecomposeWatcher(
  deps: DecomposeWatcherDeps,
  opts: DecomposeWatcherOpts,
): Promise<void> {
  const { isMain, projectId, projectPath, board } = opts;
  if (!isMain) return;
  if (!deps.aiEnabled()) return;
  if (sweepInFlight.has(projectId)) return;
  sweepInFlight.add(projectId);
  try {
    if (!bootReclaimed.has(projectId)) {
      const stuck = pickStuckDecomposing(board);
      // Mark the project reclaimed ONLY when every removal succeeded (roborev 25168/25169): the
      // guard is set-once, so a transient bd failure here would otherwise strand the epic
      // (SKIP_LABELS excludes a `decomposing`-labeled epic) for the whole session. Idempotent —
      // retrying next poll is safe.
      let allCleared = true;
      for (const epic of stuck) {
        try {
          await deps.labelBead(projectPath, "remove", epic.id, DECOMPOSING_LABEL);
        } catch (e) {
          allCleared = false;
          deps.logError?.(`boot reclaim of stale decomposing label failed for ${epic.id}`, e);
        }
      }
      if (allCleared) bootReclaimed.add(projectId);
      // Retroactive-backfill guard (spec §7 rule 2; roborev 25168/25169): on an UN-baselined
      // project a surviving `decomposing` label means a PRE-EXISTING epic (the label predates
      // this session — the baseline flag is per-instance localStorage and can be lost on
      // reinstall / profile clear / a second machine while bd labels persist in the repo). If we
      // ran the baseline sweep now, it would pick from this same stale snapshot where the epic
      // still shows `decomposing` and skip it — then mark the baseline, and the NEXT poll (label
      // gone) would auto-decompose a pre-existing epic. So bail this cycle without marking the
      // baseline; the next poll's fresh snapshot (labels cleared) exempts it correctly.
      if (!hasDecomposeBaseline(projectId) && stuck.length > 0) return;
    }
    if (!hasDecomposeBaseline(projectId)) {
      await runBaselineExemptSweep(deps, projectId, projectPath, board);
      return; // decompose next cycle, off a snapshot that reflects the exempt labels
    }
    await runDecomposeSweep(deps, projectPath, board, deps.aiEnabled);
  } finally {
    sweepInFlight.delete(projectId);
  }
}

/**
 * The production wiring beadsStore calls after each successful poll: computes the main-window
 * election the same way windowContext does (`?label=` absent ⇔ main), skips hidden windows
 * (nobody is looking at the board), and injects the real backends. Fire-and-forget — never throws.
 */
export function runDecomposeWatcherForPoll(
  projectId: string,
  projectPath: string,
  board: Board,
): Promise<void> {
  const isMain =
    typeof window !== "undefined" && parseWindowLabelFromSearch(window.location.search) === null;
  const visible = typeof document === "undefined" || document.visibilityState !== "hidden";
  if (!isMain || !visible) return Promise.resolve();
  return maybeRunDecomposeWatcher(
    {
      labelBead,
      decomposeEpic: ({ projectPath: p, epic }) =>
        decomposeEpic(
          { structuredJson, createBeadFull, beadDepAdd, readPrd, writePrd },
          { projectPath: p, epic },
        ),
      aiEnabled: () => aiFeatureMode(useSettingsStore.getState()) !== "off",
      logError: (message, error) => log.error("epicDecompose", message, error),
    },
    { isMain, projectId, projectPath, board },
  ).catch((e) => log.error("epicDecompose", "decompose watcher crashed", e));
}
