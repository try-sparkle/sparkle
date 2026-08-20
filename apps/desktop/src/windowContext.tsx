// SINGLE-WINDOW SHELL (bead sparkle-qd80 / CM-U7 part 2). The multi-window era's per-window
// React context is gone: there is one app window, its current project is
// `projectStore.selectedProjectId` (driven by the project tabs), and its identity is constant.
// The hooks keep their original names because they still answer the same questions — the answers
// are just global now. `AppBoot` carries the two boot-time jobs the old provider did (cold-start
// hygiene + boot selection/deep-link landing) without providing any context.
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { useProjectStore } from "./stores/projectStore";
import { useRuntimeStore } from "./stores/runtimeStore";
import { useUiStore } from "./stores/uiStore";
import { bootSelection } from "./engine/openProjects";
import { markProjectOpen } from "./services/projectTabs";
import { selectProjectOnItsSide } from "./services/openProjectTab";
import {
  setWindowProject,
  clearWindowProject,
  resetWindowRegistry,
  pruneWindowRegistry,
} from "./services/windowRegistry";
import { resetWindowStatus } from "./services/windowStatus";
import {
  isTornOutIn,
  onSatellitesChange,
  parseSnapshot,
  reconcileSatellites,
  satellitesSnapshot,
} from "./services/satelliteWindows";
import { parseAgentIdFromSearch, parseProjectIdFromSearch } from "./services/windowIdentity";

/** The one window's fixed label. Kept exported for the persistence keys (per-window Sparkle agent
 *  id, roster publishing) that were keyed by label and must not change across the purge. */
export const APP_WINDOW_LABEL = "main";

/** The multi-window era's per-window session snapshot. Its module (services/windowSession) is gone;
 *  the key is named here only so AppBoot can clear the orphaned blob. Delete with that cleanup. */
const LEGACY_WINDOW_SESSION_KEY = "sparkle-window-session";

/** How long the boot selection waits for uiStore to hydrate before settling against the in-memory
 *  default. uiStore persists to synchronous localStorage, so in practice it has ALREADY hydrated by
 *  the time AppBoot's effect runs and this timer never arms — it exists so a hydration that never
 *  finishes (see the resolver) degrades to "everything open" instead of stalling boot forever.
 *  Short enough to be invisible, long enough to cover a genuinely deferred hydrate. */
export const UI_HYDRATION_GRACE_MS = 250;

/** Deep-link: a `?agent=` param (notification hand-off from a cold start) selects + mounts that
 *  agent once its project is present. A closed/unknown agent id is silently ignored. */
function openDeepLinkAgent(projectId: string, agentId: string | null): void {
  if (!agentId) return;
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
  if (!project?.agents.some((a) => a.id === agentId)) return;
  useRuntimeStore.getState().open(agentId);
  useProjectStore.getState().selectAgent(projectId, agentId);
}

/**
 * Boot-time effects for the single window (mounted once from App, wraps nothing):
 *  - cold-start hygiene: the window registry / cross-webview status maps persist in localStorage
 *    and outlive the process, so stale entries are wiped. The mic's persisted `phase` is NOT among
 *    them — it is restored untouched, on the same terms as `enabled`; see the note in the effect;
 *  - boot selection: adopt a `?project=` deep link, else keep a valid persisted selection, else
 *    the first project — tolerating a store that hydrates a tick after mount;
 *  - the `?agent=` deep link landing.
 */
export function AppBoot({ children }: { children: ReactNode }) {
  useEffect(() => {
    // The label→project map. PRUNE against the live window list rather than wiping, for exactly the
    // reason spelled out below for the satellite map — satellites write this one too
    // (`setWindowProject`), and only on their OWN mount, which a main-window reload does not
    // trigger. A wipe erased a live satellite's row, `findWindowForProject` started answering null,
    // and capture-sends / orchestration events for that project "fell through" to main: main adopted
    // the send and navigated onto the re-dock placeholder while the satellite was the window
    // actually showing the project. The wipe is kept only as the no-Tauri fallback, where there is
    // no window list to check and nothing but main can have written the map.
    if (!("__TAURI_INTERNALS__" in window)) {
      // No window list to ask and nothing but main can have written the map, so the wipe is still
      // right here — and it must run SYNCHRONOUSLY, before the boot-selection effect below writes
      // `setWindowProject(APP_WINDOW_LABEL, …)`. Deferring it into a microtask made it erase main's
      // own freshly-written row, which nothing rewrites until the selection next changes.
      resetWindowRegistry();
    } else {
      void (async () => {
        try {
          const { getAllWindows } = await import("@tauri-apps/api/window");
          pruneWindowRegistry((await getAllWindows()).map((w) => w.label));
        } catch (e) {
          // LEAVE THE MAP ALONE. Falling back to the wipe here would silently reinstate the exact
          // erase-a-live-satellite's-row bug this replaced, on every remount, for any transient
          // failure. An unanswerable liveness question is not evidence that nothing is live — the
          // same rule `windowExists` applies in satelliteWindows.
          console.debug("window-registry prune skipped; leaving the map as-is", e);
        }
      })();
    }
    // Satellite ownership is durable and the windows are not, so a crash while a project was torn
    // out would leave it owned by a `project-N` label that will never exist again — main's pane gate
    // would skip it forever and the tab would render the re-dock placeholder with no window behind
    // it. RECONCILE rather than wipe: this effect runs on every mount of `<App/>`, not only at
    // process start (the error card's "Reload UI" remounts the tree, as does an HMR update), and a
    // wipe would hand a LIVE satellite's project back to main while its panes were still on screen —
    // both webviews then mount the same agent and race its PTY. Checking against the real window
    // list cannot make that mistake. `boot: true` additionally clears rows stuck mid-tear-off, but
    // only when no satellite window exists at all.
    void reconcileSatellites({ boot: true });
    // One-time cleanups: the multi-window era left two durable blobs with no writer and no reader
    // since CM-U7 part 2 — the per-window status channel (resetWindowStatus, which sweeps its own
    // keys) and the per-window session snapshot below. Both can go a release or two from now.
    resetWindowStatus();
    try {
      localStorage.removeItem(LEGACY_WINDOW_SESSION_KEY);
    } catch {
      // best-effort
    }
    // THE MIC'S `phase` IS DELIBERATELY LEFT ALONE HERE. Boot used to force a persisted "active"
    // back to "passive" on the theory that relaunching should never resume mid-dictation. That
    // reset restored only HALF of a two-field setting: `dictationStore` persists `enabled` (on/off)
    // and `phase` (paused vs. listening) together, and stripping just the second brought the mic
    // back ARMED AND CAPTURING with routing silently off — every hold recording audio and
    // transcribing nothing, with nothing on screen saying why.
    //
    // It cost the founder a live session (bead sparkle-ysv1gj): 49 mic toggles across ten minutes,
    // 0 cloud streams opened, 1 transcript — against 3 toggles / 24 opens on the previous launch,
    // with every file in the mic path byte-identical between the two builds. The reset was the
    // entire difference.
    //
    // What made it a trap rather than an annoyance WAS that the obvious gesture could not undo it:
    // `useMicToggle` (the mic button) cycled off → paused → off and never reached "active" — the
    // app's only `setPhase("active")` call site was the hover pill's Listening option, so a user who
    // did not know about the pill had no way back. That half is now fixed too (bead sparkle-yvvu27):
    // a plain mic click arms AND routes (off → active), so the button itself reaches the routing
    // state and this phase-restore is no longer the only path back to a working mic
    // (components/MicButton.tsx).
    //
    // "Never resume mid-dictation" is still honoured, by the half that actually decides it: capture
    // is driven by `enabled` and the arm gestures, and a relaunched window with no hold in flight
    // routes nothing until the user speaks. Restoring `phase` restores the user's stated intent,
    // which is the same contract `enabled` has always had. Pinned by windowContext.test.tsx.
  }, []);

  // Boot selection. Resolve ONCE against the hydrated store, then stop — so this can never fight
  // a later tab click. zustand's `persist` can apply the localStorage snapshot a microtask AFTER
  // mount even with synchronous storage, so a first pass that finds nothing subscribes and
  // retries until the projects land.
  useEffect(() => {
    const search = typeof window !== "undefined" ? window.location.search : "";
    const paramProjectId = parseProjectIdFromSearch(search);
    const paramAgentId = parseAgentIdFromSearch(search);
    let unsubs: Array<() => void> = [];
    // Once true, resolve() stops waiting on uiStore and settles against whatever is in memory.
    let uiWaitOver = useUiStore.persist.hasHydrated();
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const detach = () => {
      for (const u of unsubs) u();
      unsubs = [];
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
    };
    const resolve = (): boolean => {
      const st = useProjectStore.getState();
      if (st.projects.length === 0) return false;
      // The open set lives in uiStore, which has its OWN hydration schedule. Settling before it
      // lands would read the default `null` ("everything open") and could restore a CLOSED project
      // — and this resolver runs exactly once, so nothing would ever correct it.
      //
      // A SUCCESSFUL hydrate releases this through `onFinishHydration` below — not through a store
      // subscription, which provably cannot see it (see the note there).
      //
      // The wait is also BOUNDED, because "not hydrated yet" and "hydration failed" are
      // indistinguishable from here and only one of them ever ends. zustand sets `hasHydrated` (and
      // fires its finish listeners) inside a `.then()` that a `.catch()` bypasses, and
      // `createJSONStorage().getItem` JSON.parses with no guard — so a truncated `sparkle-ui` blob,
      // a throwing migrate, or a `localStorage` that throws leaves `hasHydrated` false FOREVER and
      // fires no finish listener either. Gating unconditionally would turn a corrupt
      // UI-preferences blob (which used to cost only preferences) into "the app boots with tabs and
      // nothing selected, and a cold-start notification hand-off is silently dropped". After the
      // grace window we settle against the in-memory default — `openProjectIds === null`, i.e.
      // every project open, which is precisely the state the gate was waiting to confirm.
      if (!uiWaitOver && !useUiStore.persist.hasHydrated()) return false;
      const has = (id: string | null) => !!id && st.projects.some((p) => p.id === id);
      // Detach BEFORE any write: everything below is a store `set` that would re-enter this
      // resolver through its own subscriptions and recurse. Hoisted above the branch, because
      // `markProjectOpen` is itself such a write and this effect now subscribes to uiStore too —
      // on the deferred path (empty store at mount, `?project=` naming a closed project, projects
      // hydrating after) it would have re-entered synchronously, resolved the whole thing, and then
      // let the outer frame run `setSelectedProject` + `openDeepLinkAgent` a SECOND time. Harmless
      // only by accident (runtimeStore.open unions and selectAgent is idempotent), which is the
      // callees upholding this function's "resolve ONCE" contract for it. Safe to detach here: the
      // resolver has already committed to answering.
      detach();
      let target: string | null;
      if (paramProjectId && has(paramProjectId)) {
        // A `?project=` deep link is an explicit "show me this one", so it OPENS a closed project
        // rather than being skipped — landing on a project with no tab is the incoherence to avoid,
        // and a deep link earns its tab.
        markProjectOpen(paramProjectId);
        target = paramProjectId;
      } else {
        // Only OPEN projects are eligible; bootSelection falls back to the first open one, and to
        // null when the user closed every tab (the welcome state, not a phantom selection).
        target = bootSelection(
          st.projects.map((p) => p.id),
          useUiStore.getState().openProjectIds,
          st.selectedProjectId,
        );
      }
      // setSelectedProject, not selectProject: adopting a tab at boot must not rewrite recency.
      if (st.selectedProjectId !== target) st.setSelectedProject(target);
      // `target === null` — every tab is closed — is a SETTLED answer, not "try again": the shell
      // shows its welcome hint and the next tab click owns the selection from there.
      if (target) openDeepLinkAgent(target, paramAgentId);
      return true;
    };
    if (resolve()) return;
    unsubs = [useProjectStore.subscribe(() => resolve())];
    if (!uiWaitOver) {
      // Release the wait from the API that actually SIGNALS hydration. A plain
      // `useUiStore.subscribe` cannot do it: zustand applies the stored state with
      // `set(stateFromStorage, true)` in one `.then()` and flips `hasHydrated` in the NEXT one
      // (zustand/esm/middleware.mjs:421 vs :431), so the single `set` hydration ever fires reaches a
      // store subscriber while `hasHydrated()` is still false — it bails, and no further `set`
      // follows. The gate's only exit would be the timer below, which means a hydrate landing after
      // the grace window settles against `openProjectIds === null` ("everything open") and restores
      // a CLOSED project: exactly the incoherence the gate exists to prevent, arrived at silently.
      unsubs.push(
        useUiStore.persist.onFinishHydration(() => {
          uiWaitOver = true;
          resolve();
        }),
      );
      // The timer is now purely the corrupt-blob backstop: `onFinishHydration` listeners live in
      // the same `.then()` that a `.catch()` bypasses, so a throwing storage/migrate fires neither.
      graceTimer = setTimeout(() => {
        graceTimer = null;
        uiWaitOver = true;
        resolve();
      }, UI_HYDRATION_GRACE_MS);
    }
    return () => detach();
  }, []);

  // Keep the (single-entry) window registry pointing at the selected project, so the surfaces
  // that still ask "which window owns this project?" — the capture hand-off — stay truthful.
  //
  // A TORN-OUT project is the exception, and it is not hypothetical: selecting its tab is now an
  // ordinary click (the tab both raises the satellite and selects, so main's re-dock placeholder
  // stays reachable). Writing main's row here would make TWO labels map to that project, and
  // `findWindowForProject` returns the FIRST match in insertion order — which is `main`, since main
  // writes its row at boot and an update keeps a key's original position. The election would then
  // name main as the owner of a project main renders nothing but a placeholder for: main adopts the
  // capture-send, navigates onto that placeholder, and the satellite — the window actually showing
  // the project — declines it. Clearing instead of writing leaves the satellite's row as the only
  // match, which is the truth.
  //
  // Subscribed to the ownership map, not just to the selection, so this corrects itself the moment a
  // project is torn out or re-docked while it is the selected tab — both of which happen without the
  // selection changing at all.
  const projectId = useProjectStore((s) => s.selectedProjectId);
  const satellites = useSyncExternalStore(onSatellitesChange, satellitesSnapshot, () => "");
  useEffect(() => {
    if (projectId && !isTornOutIn(parseSnapshot(satellites), projectId)) {
      setWindowProject(APP_WINDOW_LABEL, projectId);
    } else {
      clearWindowProject(APP_WINDOW_LABEL);
    }
  }, [projectId, satellites]);

  return <>{children}</>;
}

/** The project the app is showing — the selected TAB. Reads the store directly, so any leaf can
 *  call it without a provider. */
export const useCurrentProjectId = (): string | null =>
  useProjectStore((s) => s.selectedProjectId);

/** One window: it is always the main window. Constant, kept for call-site continuity. */
export const useIsMainWindow = (): boolean => true;
export const useCurrentWindowLabel = (): string => APP_WINDOW_LABEL;

/** Legacy seam: "show this project instead". Now simply selects its tab — and OPENS that tab if the
 *  project was closed. Without the open, this is the one "show me this project" path that could
 *  select a project the tab bar doesn't list: the notification-banner reveal
 *  (useAttentionNotifications' focus-agent handler) routes through here, and Rust posts that
 *  notification against whatever project was current at the time, which the user may have closed
 *  since. The result would be the exact incoherence the open set exists to prevent — the workspace
 *  showing Alpha's agent while no tab is selected — and it would self-heal in the WRONG direction,
 *  since the next close treats a selection with no tab as stale and yanks the user elsewhere
 *  (engine/openProjects.selectionAfterClose). Kept here rather than at the two call sites so the
 *  seam itself cannot reintroduce it. */
export const useReplaceCurrentProject = (): ((id: string | null) => void) => {
  return useMemo(
    () => (id: string | null) => {
      const st = useProjectStore.getState();
      if (id) {
        markProjectOpen(id);
        // SIDE-AWARE, exactly as `openProjectTab` is (engine/pairs).
        //
        // This is the seam the notification reveal ACTUALLY uses: useAttentionNotifications'
        // focus-agent handler calls here, and reaches `openProjectTab` only in its stale-agent
        // fallback. So routing only that one left this path writing the RIGHT pair's selection for a
        // LEFT-assigned project — and the Workspace's reconcile effect then cancels the write on the
        // next commit, leaving `leftProjectId` untouched and the reveal invisible. Clicking a
        // notification for a left-pair agent did nothing at all. Same for App.tsx's capture
        // hand-off. (roborev 55158)
        selectProjectOnItsSide(id);
      } else st.setSelectedProject(null);
    },
    [],
  );
};
