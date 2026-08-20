// Auto-decompose watcher for Plan epics (spec §7, plan Task 5): a childless epic is decomposed
// into child beads by a PAID AI call — but ONLY when it carries an explicit opt-in label. Safety
// rules, in order:
//   1. Single-window election — only the MAIN window ever runs the watcher (no cross-window race).
//   2. EXPLICIT opt-in — the watcher spends iff the epic carries `decompose:requested`. The DEFAULT
//      state (no such label) is a strict no-op: removing an unrelated label, reopening a childless
//      epic, or a backlog-cleanup pass can never trigger an AI call. "Label absent" ≠ "please
//      decompose" (that inverted default was a money/safety landmine — bead sparkle-ynn8).
//   3. Guard labels — `decomposing` is written BEFORE the AI call (skip the epic if that write
//      fails), swapped to `decomposed` on success (and the opt-in label consumed) or
//      `decompose-failed` on error (opt-in kept, so clearing the failed badge retries).
//   4. Crash recovery — `decomposing` is transient (written before the call, cleared after), so a
//      label surviving into a fresh watcher session is stale by definition (crash/quit mid-run) and
//      is reset. This reclaim runs BEFORE the AI gate: clearing a stale label is a pure `bd` write
//      that spends nothing, so a crash must be reclaimable even while AI features are off.
// Pure pickers up top (unit-tested), thin IO sweeps below. The beadsStore calls
// `maybeRunDecomposeWatcher` after each poll; every guard lives here so the store stays dumb.
// `isTypedEpic`, NOT `isEpic`, and the distinction is load-bearing here — see the note on
// `pickEpicsToDecompose`. Decomposition looks for a bead DECLARED an epic that has no children yet;
// asking the membership resolver would be self-contradictory, since a structural epic has children
// by definition and so can never be a candidate.
import { childrenOf, isTypedEpic, labelBead, type Bead, type Board } from "./beads";
import {
  beadDepAdd,
  createBeadFull,
  decomposeEpic,
  readPrd,
} from "./tasks";
import { structuredJson } from "./anthropic";
import { advisorRevisionNote } from "./advisor";
import { writePrd } from "./prd";
import { aiFeatureMode, useSettingsStore } from "../stores/settingsStore";
import { isAppWindowSearch } from "./windowIdentity";
import { log } from "../logger";

/**
 * The EXPLICIT opt-in signal. A childless epic is decomposed (a paid AI call) ONLY if it carries
 * this label. Its ABSENCE is the safe default — the watcher never spends on an epic that has not
 * opted in, so label hygiene and epic reopens are free of spend.
 */
export const DECOMPOSE_REQUESTED_LABEL = "decompose:requested";

export const DECOMPOSING_LABEL = "decomposing";
export const DECOMPOSED_LABEL = "decomposed";
export const DECOMPOSE_FAILED_LABEL = "decompose-failed";

/**
 * Labels marking an epic that is already somewhere in the decompose pipeline — in-flight
 * (`decomposing`) or terminal (`decomposed` / `decompose-failed`). Any of them excludes the epic
 * from a fresh pick, so a requested epic is decomposed at most once. A failed epic re-enters only
 * when its `decompose-failed` badge is cleared (the retry affordance).
 */
const PIPELINE_LABELS = [DECOMPOSING_LABEL, DECOMPOSED_LABEL, DECOMPOSE_FAILED_LABEL];

/** Flatten the four board columns back into one bead list (childrenOf needs the full set). */
function boardBeads(board: Board): Bead[] {
  return [...board.backlog, ...board.inProgress, ...board.done, ...board.delivered];
}

/**
 * The epics the watcher may decompose this cycle. ALL of:
 *   - it was DECLARED an epic (`issue_type = 'epic'`) and is not closed (finished work never
 *     triggers an AI call). Declared, not resolved: a bead that is an epic only because things
 *     point at it already HAS children, so it fails the last clause anyway — using the membership
 *     resolver here would read as a widening while changing nothing;
 *   - it carries the EXPLICIT `decompose:requested` opt-in (the spend gate — absent ⇒ never picked);
 *   - it is not already in the pipeline (no `decomposing` / `decomposed` / `decompose-failed`);
 *   - it has ZERO children (in any column, any status).
 * Pure. The opt-in requirement is the money/safety fix: an epic without the label is a no-op.
 */
export function pickEpicsToDecompose(board: Board): Bead[] {
  const beads = boardBeads(board);
  return beads.filter(
    (b) =>
      isTypedEpic(b) &&
      b.status !== "closed" &&
      b.labels.includes(DECOMPOSE_REQUESTED_LABEL) &&
      !b.labels.some((l) => PIPELINE_LABELS.includes(l)) &&
      childrenOf(beads, b.id).length === 0,
  );
}

/**
 * Crash recovery: epics still labeled `decomposing` when the watcher starts. Only the main window
 * ever decomposes, and the label is written immediately before a synchronous AI call and cleared
 * right after — so a label surviving into a fresh session is stale by definition (crash or quit
 * mid-run). The caller clears them; a still-requested epic then re-enters the pipeline on a later
 * cycle (safe — it opted in), while one whose opt-in was withdrawn simply stays put. Pure.
 */
export function pickStuckDecomposing(board: Board): Bead[] {
  return boardBeads(board).filter(
    (b) => isTypedEpic(b) && b.labels.includes(DECOMPOSING_LABEL),
  );
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
 * `decomposed` (add before remove, so the epic is never label-less mid-swap) and consume the
 * `decompose:requested` opt-in so a later manual clear of `decomposed` can't silently re-spend. A
 * decomposition error labels `decompose-failed` (visible on the card, retryable) and logs, and
 * KEEPS the opt-in so clearing the failed badge re-picks the epic; one epic failing never stops the
 * sweep.
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
      // but bd being down must not throw out of the sweep. The opt-in label is deliberately kept
      // so clearing the `decompose-failed` badge re-picks the epic (retry).
      try {
        await deps.labelBead(projectPath, "add", epic.id, DECOMPOSE_FAILED_LABEL);
        await deps.labelBead(projectPath, "remove", epic.id, DECOMPOSING_LABEL);
      } catch (labelErr) {
        deps.logError?.(`decompose-failed label write failed for ${epic.id}`, labelErr);
      }
      continue;
    }
    // Decomposition succeeded (children created). Swap the guard label to `decomposed` (add
    // before remove so the epic is never label-less mid-swap) and consume the opt-in. A failure
    // HERE is a bookkeeping hiccup, not a decompose failure: log it and leave the `decomposing`
    // label for crash recovery / the next cycle to resolve — never apply `decompose-failed`.
    try {
      await deps.labelBead(projectPath, "add", epic.id, DECOMPOSED_LABEL);
      await deps.labelBead(projectPath, "remove", epic.id, DECOMPOSING_LABEL);
      await deps.labelBead(projectPath, "remove", epic.id, DECOMPOSE_REQUESTED_LABEL);
    } catch (labelErr) {
      deps.logError?.(
        `decomposed-label swap failed for ${epic.id} (children created; leaving decomposing for reclaim)`,
        labelErr,
      );
    }
  }
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
 * The post-poll watcher entry. Guards, in order: main-window election (spec §7 safety rule 1) and
 * per-project re-entrancy. Then, once per session per project, crash-recover any `decomposing`
 * label that survived a crash/quit — this runs BEFORE the AI gate on purpose: clearing a stale
 * label spends nothing, so a crashed run must be reclaimable even while AI features are off (that
 * gap left labels stranded — bead sparkle-ynn8). Only THEN, behind the master AI gate, the
 * decompose sweep, which spends only on epics carrying the explicit `decompose:requested` opt-in.
 */
export async function maybeRunDecomposeWatcher(
  deps: DecomposeWatcherDeps,
  opts: DecomposeWatcherOpts,
): Promise<void> {
  const { isMain, projectId, projectPath, board } = opts;
  if (!isMain) return;
  if (sweepInFlight.has(projectId)) return;
  sweepInFlight.add(projectId);
  try {
    // Crash recovery FIRST, independent of the AI gate. A `decomposing` label present at watcher
    // start is stale by definition (only main decomposes, and the label bracket is synchronous),
    // and clearing it is a pure bookkeeping write that fires no AI call — so this must run even
    // when AI features are off, or a crash strands the label forever (bead sparkle-ynn8).
    if (!bootReclaimed.has(projectId)) {
      // Mark the project reclaimed ONLY when every removal succeeded: the label is set-once, so a
      // transient bd failure here would otherwise strand the epic (PIPELINE_LABELS excludes a
      // `decomposing`-labeled epic) for the whole session. Idempotent — retrying next poll is safe.
      let allCleared = true;
      for (const epic of pickStuckDecomposing(board)) {
        try {
          await deps.labelBead(projectPath, "remove", epic.id, DECOMPOSING_LABEL);
        } catch (e) {
          allCleared = false;
          deps.logError?.(`crash recovery of stale decomposing label failed for ${epic.id}`, e);
        }
      }
      if (allCleared) bootReclaimed.add(projectId);
    }
    // Spend gate: everything below may fire a PAID AI call.
    if (!deps.aiEnabled()) return;
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
  // The APP window only — the helper/capture webviews (which carry `?view=`) must not run the
  // decompose watcher. This used to test for an absent `?label=`, which nothing mints any more,
  // so every webview passed (roborev 46485-M).
  const isMain = typeof window !== "undefined" && isAppWindowSearch(window.location.search);
  const visible = typeof document === "undefined" || document.visibilityState !== "hidden";
  if (!isMain || !visible) return Promise.resolve();
  return maybeRunDecomposeWatcher(
    {
      labelBead,
      decomposeEpic: ({ projectPath: p, epic }) =>
        decomposeEpic(
          {
            structuredJson,
            createBeadFull,
            beadDepAdd,
            readPrd,
            writePrd,
            // The ONE advisor revision round (bead `sparkle-revqiv`). Reads a verdict a pass
            // dispatched EARLIER has already delivered — never a fresh call — so this adds no stall
            // to a decompose and spends nothing here. `null` when no verdict is held or none of its
            // findings are `high`, which is the ordinary case and leaves the plan exactly as the
            // planner wrote it.
            advisorRevisionNote,
          },
          { projectPath: p, epic },
        ),
      aiEnabled: () => aiFeatureMode(useSettingsStore.getState()) !== "off",
      logError: (message, error) => log.error("epicDecompose", message, error),
    },
    { isMain, projectId, projectPath, board },
  ).catch((e) => log.error("epicDecompose", "decompose watcher crashed", e));
}
