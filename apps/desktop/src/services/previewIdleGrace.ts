// previewIdleGrace — stop a preview server after its pane has been COVERED (not stopped outright,
// just not on screen) for `[preview] idle_grace_min` minutes.
//
// Design doc §4 (`docs/live-browser-preview.md`): "Stopping the instant a pane is covered would
// make flipping to Plan and back pay a full cold compile … so a covered preview keeps serving for
// the grace window and only then stops." This is that timer, and it is the ONLY concurrency-shaped
// piece Phase 2 builds — no `max_servers`, no LRU, no `memwatch` registration (see `preview.rs`'s
// module header for why those were dropped): the two-pane layout is already the ceiling, and
// admission already feels a preview server's RSS via `available_bytes`. This timer is what keeps a
// covered-but-forgotten server from running forever, which the two-pane ceiling alone does not do.
//
// WHY THIS IS FRONTEND-OWNED rather than living in `preview.rs`'s `supervise()` loop: "is a human
// looking at this" is a fact about React layout state (`workModeBySide`, which project/agent is
// selected on which side), which Rust has no channel to observe. Rather than build a heartbeat
// protocol so Rust could own the timer, this reuses the stop path Rust already exposes
// (`stopPreviewForAgent`, `services/preview.ts`) and decides "covered" the same way
// `revealOutcomeFor` (`agentReveal.ts`) decides "already-showing" — by reading store state, not by
// asking a component that might not be mounted.
//
// MODULE-SCOPED TIMERS, NOT COMPONENT STATE, because "covered" is precisely the case where
// `PreviewSlot` may not be mounted at all (design doc: "cover, never unmount" is about the columns
// UNDER the slot, not the slot itself — leaving Preview mode unmounts `PreviewSlot`, by
// `previewSlotUp`'s own conditional render). A `setTimeout` living in a component's `useEffect`
// would be cancelled by exactly the unmount this timer needs to survive.
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { usePreviewStore, type PreviewState } from "../stores/previewStore";
import { stopPreviewForAgent } from "./preview";
import { getConfig, onConfigChanged, type EffectiveConfig } from "./config";

/** States `preview.rs` still considers the server live — mirrors `live_for_reattach` in preview.rs
 *  (Installing/Starting/Listening/Ready/Serving), i.e. everything that is not already a terminal
 *  state. A terminal entry (`stopped`/`failed`/`crashed`) has nothing left to stop.
 *
 *  MUST include every `live_for_reattach` arm, not just the ones a human is likely to see covered.
 *  `installing` was added to that Rust set without a matching update here once before (roborev
 *  63963): a pane covered while its preview is still waiting on `node_modules` — up to
 *  `INSTALL_WAIT_TIMEOUT`, 300s on the Rust side — armed no idle-grace timer at all, so that whole
 *  window accrued nothing toward the grace period. `previewSeam.test.ts` pins this set against the
 *  Rust enum so the next added state fails a test rather than drifting silently again. */
const LIVE_STATES: ReadonlySet<PreviewState> = new Set(["installing", "starting", "listening", "ready", "serving"]);

const DEFAULT_IDLE_GRACE_MIN = 10;

/** Which agent's preview is actually rendered on screen right now, one per side. Pure — reads two
 *  stores, writes nothing, same shape as `revealOutcomeFor`'s "already-showing" half. Mirrors the
 *  exact conditions `Workspace.tsx` renders `<PreviewSlot>` under (`leftPreviewActive`/
 *  `previewActive`): left has no extra gate, right is additionally hidden while the Improve-Sparkle
 *  special is active, since that overlay covers the same pair. */
export function visiblePreviewAgentIds(): ReadonlySet<string> {
  const ui = useUiStore.getState();
  const ps = useProjectStore.getState();
  const visible = new Set<string>();

  if (ui.workModeBySide.left === "preview") {
    const project = ps.projects.find((p) => p.id === ui.leftProjectId);
    if (project?.selectedAgentId) visible.add(project.selectedAgentId);
  }
  if (ui.workModeBySide.right === "preview" && ui.activeSpecial !== "sparkle") {
    const project = ps.projects.find((p) => p.id === ps.selectedProjectId);
    if (project?.selectedAgentId) visible.add(project.selectedAgentId);
  }
  return visible;
}

function liveAgentIds(): ReadonlySet<string> {
  const byAgent = usePreviewStore.getState().byAgent;
  return new Set(
    Object.keys(byAgent).filter((id) => {
      const entry = byAgent[id];
      return entry !== undefined && LIVE_STATES.has(entry.status);
    }),
  );
}

/** agentId -> pending stop timer. Module-scoped so it survives whatever component triggered the
 *  reconcile that armed it. */
let pending = new Map<string, ReturnType<typeof setTimeout>>();

/** Read once at watcher start and refreshed on every config change, NOT re-read per timer — a
 *  config edit mid-grace-window changes the deadline for the NEXT covered agent, not one already
 *  counting down, which matches every other "read config, act on it" path in this codebase (no
 *  retroactive rewrite of in-flight state). */
let idleGraceMs = DEFAULT_IDLE_GRACE_MIN * 60_000;

function applyConfig(eff: EffectiveConfig): void {
  const minutes = eff.config.preview?.idle_grace_min;
  idleGraceMs = Math.max(1, minutes ?? DEFAULT_IDLE_GRACE_MIN) * 60_000;
}

function clearPending(agentId: string): void {
  const handle = pending.get(agentId);
  if (handle !== undefined) {
    clearTimeout(handle);
    pending.delete(agentId);
  }
}

/**
 * Reconcile pending stop timers against current visibility. Exported so a store subscription can
 * call it directly, and so tests can drive it without the subscribe/config-fetch machinery in
 * `startPreviewIdleGraceWatcher`.
 *
 * Two passes, in this order: cancel first, then arm. An agent that is simultaneously "no longer
 * live" (its entry moved to `stopped`) and formerly pending must lose its timer before the arm pass
 * ever looks at it — reversing the order would let a stale timer survive one extra reconcile.
 */
export function reconcilePreviewIdleGrace(): void {
  const visible = visiblePreviewAgentIds();
  const live = liveAgentIds();

  for (const agentId of pending.keys()) {
    if (visible.has(agentId) || !live.has(agentId)) clearPending(agentId);
  }
  for (const agentId of live) {
    if (visible.has(agentId) || pending.has(agentId)) continue;
    const handle = setTimeout(() => {
      pending.delete(agentId);
      void stopPreviewForAgent(agentId);
    }, idleGraceMs);
    pending.set(agentId, handle);
  }
}

let unlistenConfig: (() => void) | undefined;

/** Start watching. Call once at app startup, alongside `startPreviewListener` (`Workspace.tsx`).
 *  Returns a cleanup function that unsubscribes and cancels every pending timer — nothing here
 *  should keep counting down in a window that unmounted. */
export function startPreviewIdleGraceWatcher(): () => void {
  const unsubUi = useUiStore.subscribe(reconcilePreviewIdleGrace);
  const unsubPs = useProjectStore.subscribe(reconcilePreviewIdleGrace);
  const unsubPreview = usePreviewStore.subscribe(reconcilePreviewIdleGrace);

  void getConfig()
    .then(applyConfig)
    .catch(() => {});
  void onConfigChanged(applyConfig)
    .then((u) => {
      unlistenConfig = u;
    })
    .catch(() => {});

  reconcilePreviewIdleGrace();

  return () => {
    unsubUi();
    unsubPs();
    unsubPreview();
    unlistenConfig?.();
    unlistenConfig = undefined;
    for (const agentId of Array.from(pending.keys())) clearPending(agentId);
  };
}

/** Test seam: drop module-global state between tests. Never called by app code. */
export function resetPreviewIdleGraceStateForTests(): void {
  for (const handle of pending.values()) clearTimeout(handle);
  pending = new Map();
  idleGraceMs = DEFAULT_IDLE_GRACE_MIN * 60_000;
}

/** Test seam: set the grace window directly, bypassing the async config round trip. Never called
 *  by app code. */
export function setPreviewIdleGraceMinutesForTests(minutes: number): void {
  idleGraceMs = Math.max(1, minutes) * 60_000;
}
