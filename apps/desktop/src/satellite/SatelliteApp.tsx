// THE SATELLITE — one project, torn out of the tab strip onto another monitor.
//
// It renders columns ② + ③ ONLY (builder agents + terminal stage). There is deliberately no
// concierge column, no tab strip, no control listener and no tabs inside it: that is what keeps a
// satellite a fourth constrained VIEW — the same kind of thing as `helper` and `capture` — rather
// than the peer app window that CM-U7 part 2 purged. The three hazards that purge named ("its own
// store copy, its own concierge and a second control listener") are dodged by construction here,
// not by care. See PRD/sparkle/project-tab-tear-off.md.
//
// THE ONE INVARIANT: exactly one webview mounts a given agent's pane. A Terminal unmount detaches,
// and for a local agent detach IS kill (agentTransport.ts) — so two mounts would be two xterms
// racing one PTY. `services/satelliteWindows` is the ownership channel that enforces it, and every
// handover in here is ordered "old owner unmounts, THEN new owner mounts":
//   • arriving: main claimed the project BEFORE building this window, so its panes are already
//     down and their PTYs already dead by the time we mount and `claude --resume` brings them back.
//   • leaving: the close button unmounts our panes FIRST, waits for the detaches to land, and only
//     then releases the project and destroys the window.
//
// WHAT THIS WINDOW DOES NOT DO, and why each is deliberate:
//   • It never writes `sparkle-ui` (see satellite/uiPersistence) — that blob is main's.
//   • It runs no boot side effects: `main.tsx` gates every one of them on `isAppWindow`, which is
//     false here because the URL carries `?view=`.
//   • It mounts no attention notifications. Main can't raise them for a torn-out project (it has no
//     live status for agents it isn't mounting), so this is a real gap, not a duplicate-suppression
//     — recorded in the PRD as follow-up rather than half-built here.

import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { FiPlay } from "react-icons/fi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { C, FONT_WEIGHT } from "../theme/colors";
import { useApplyTheme } from "../theme/theme";
import type { AgentTab, Project } from "../types";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { planBoardUp } from "../engine/planBoard";
import type { ZoomColumn } from "../engine/columnZoom";
import { ZoomColumnOverride } from "../hooks/useZoomColumn";
import type { PairSide } from "../engine/cable";
import { useSettingsStore } from "../stores/settingsStore";
import { AgentSidebar } from "../components/AgentSidebar";
import { PlanBuildToggle } from "../components/PlanBuildToggle";
import { BoardFilterBar } from "../components/BoardFilterBar";
import { PLAN_COLUMN_Z } from "../components/layers";
import { ErrorBoundary, AgentPaneErrorCard } from "../components/ErrorBoundary";
import { TERMINAL_STAGE_DND_TARGET } from "../services/dndTargets";
import { subscribeToCrossWindowSync } from "../services/crossWindowSync";
import { startPresenceTracking } from "../stores/presenceStore";
import { startAgentGoalDiskMirror } from "../services/agentGoalDisk";
import { startGoalContinuationRunner } from "../services/goalContinuationRunner";
import { startEpicSweepRunner } from "../services/epicSweepRunner";
import { safeUnlisten } from "../services/safeUnlisten";
import { setWindowProject, clearWindowProject } from "../services/windowRegistry";
import { FONT_UI } from "../theme/scale";
import {
  SATELLITE_REDOCK_EVENT,
  releaseSatellite,
  settleSatellite,
} from "../services/satelliteWindows";

/** THIS WINDOW IS ONE REGION. A torn-off terminal has no cockpit around it — no pairs, no
 *  concierge — so "which column has focus" has a constant answer here, and its zoom level is its
 *  own rather than shared with a column in another window. */
export const SATELLITE_ZOOM_COLUMN: ZoomColumn = "satellite";

/** A satellite hosts one project in one column — the primary side. Named rather than inlined so
 *  the four reads below are visibly the SAME side, not four independent guesses. */
const SATELLITE_PAIR_SIDE: PairSide = "right";

const AgentPane = lazy(() => import("../components/AgentPane").then((m) => ({ default: m.AgentPane })));
const BoardView = lazy(() => import("../components/BoardView").then((m) => ({ default: m.BoardView })));

function PaneFallback() {
  return <div style={{ position: "absolute", inset: 0, background: C.forest }} />;
}

/**
 * How long the panes get to unmount before this window destroys itself.
 *
 * `Terminal`'s cleanup fires `transport.detach()`, which is an `invoke` — dispatched synchronously
 * from the unmount but completed in Rust a round-trip later. Releasing the project the instant the
 * React tree came down would let main remount and `pty_spawn` the same agent id while the kill is
 * still in flight, and `pty_spawn` INSERTS into the session map (pty.rs) rather than refusing — so
 * the loser isn't an error, it's an orphaned child process nobody can reach. One frame is not
 * enough; a short settle is, and it is invisible because the window's content is already gone.
 */
export const CLOSE_SETTLE_MS = 250;

/** This window's Tauri label — one of `project_window.rs`'s POOL slots. Everything this component
 *  writes to the shared ownership map is keyed by it.
 *
 *  Resolved lazily at RENDER, not at module scope: `main.tsx` deliberately refuses to touch
 *  `getCurrentWindow()` before `createRoot` (a malformed `__TAURI_INTERNALS__` would throw and blank
 *  the window with no error card to recover from), and this component renders inside the app-root
 *  ErrorBoundary, so a throw here degrades to the recoverable card instead. Falls back to the first
 *  pool label in the plain-browser dev preview, where there is no window to ask. */
function useSatelliteLabel(): string {
  const [label] = useState(() => {
    try {
      return "__TAURI_INTERNALS__" in window ? getCurrentWindow().label : "project-1";
    } catch {
      return "project-1";
    }
  });
  return label;
}

export function SatelliteApp({ projectId }: { projectId: string }) {
  const label = useSatelliteLabel();
  useApplyTheme();

  const projects = useProjectStore((s) => s.projects);
  const openAgentIds = useRuntimeStore((s) => s.openAgentIds);
  const open = useRuntimeStore((s) => s.open);
  const setActiveSpecial = useUiStore((s) => s.setActiveSpecial);
  // A satellite window hosts exactly ONE project in ONE column, so it is always the primary
  // ("right") side of the per-column mode map. It has no second pair to be confused with — the
  // singleton the map replaced was only ever a problem in the two-pair cockpit.
  const workMode = useUiStore((s) => s.workModeBySide[SATELLITE_PAIR_SIDE]);
  // Both chevrons go through the store actions that own the mode-plus-yield pairing; nothing here
  // writes a bare `setWorkMode`, which is why that selector is gone.
  const openPlanBoard = useUiStore((s) => s.openPlanBoard);
  const showBuildStage = useUiStore((s) => s.showBuildStage);
  const beadsEnabled = useSettingsStore((s) => s.beadsEnabled);
  const stepColumnZoom = useUiStore((s) => s.stepColumnZoom);
  const resetColumnZoom = useUiStore((s) => s.resetColumnZoom);

  // Once true the panes are gone and we are counting down to `destroy` — see CLOSE_SETTLE_MS.
  const [closing, setClosing] = useState(false);
  // Set the moment the project goes back to main. A ref, not state: it is read inside the
  // `onCloseRequested` callback, which is registered once and would otherwise close over the
  // first render's value forever.
  const releasedRef = useRef(false);

  const project = useMemo(
    () => projects.find((p) => p.id === projectId) ?? null,
    [projects, projectId],
  );

  // Assert ownership from THIS side too. Main writes the claim before building us, so this is
  // normally a no-op that only fills in the label — but it is also the self-heal for a window that
  // outlived the write (a main-window reload, a hand-cleared blob): the satellite that is actually
  // on screen is the authority on which window owns the project.
  useEffect(() => {
    settleSatellite(projectId, label);
    // captureSends still routes on the label→project map, so keep it truthful for this window.
    setWindowProject(label, projectId);
  }, [projectId, label]);

  // Inherit the user's persisted prefs but never land on a view this window cannot render: main's
  // blob may say `activeSpecial: "sparkle"`, and Improve Sparkle is main's agent (its id is keyed to
  // main's label — sparkleAgentIdFor), so mounting it here would be a second pane on one PTY. The
  // sidebar's Sparkle row is hidden below for the same reason.
  useEffect(() => {
    if (useUiStore.getState().activeSpecial === "sparkle") setActiveSpecial(null);
  }, [setActiveSpecial]);

  // Project renames, new agents, deletions — everything structural main does has to land here.
  useEffect(() => subscribeToCrossWindowSync(), []);
  // Presence is fed by TERMINAL keystrokes as much as by the compose box, and this window is where
  // those keystrokes happen for a torn-out project. Ref-counted + idempotent disposer.
  useEffect(() => startPresenceTracking(), []);

  // Auto-continue / escalation for a torn-out project's agents. The runner is per-window: it gates
  // every project through routeToOwningWindow, so it acts only on projects THIS window owns. Mounted
  // only in App.tsx before, a satellite-displayed project got main deferring ownership to the
  // satellite while the satellite never ran the runner — nobody swept it, so no agent in a
  // torn-off window was ever auto-continued or escalated (bead sparkle-l7bmm). Mounting it here
  // makes the owning satellite the one handler; main still defers, so there is no double-sweep.
  useEffect(() => startGoalContinuationRunner(), []);

  // The EPIC sweep, mounted here for exactly the reason the agent sweep above is: this window OWNS
  // the project it displays, so main defers to it. Mounted only in App.tsx, a torn-off project's
  // stalled epics would be swept by nobody.
  useEffect(() => startEpicSweepRunner(), []);

  // The goal's durable mirror, mounted here for exactly the reason the runner above is: this
  // window OWNS the project it displays, so main defers to it. Mounted only in App.tsx, a
  // torn-off project's goals would never reach disk and its agents would wake with no brief —
  // the same gap bead sparkle-l7bmm records for auto-continue. The sweep's own single-owner
  // election keeps main and the satellite from both writing the same file.
  useEffect(() => startAgentGoalDiskMirror(), []);

  // Name the window after the project. Unlike the main window — which is titled "Sparkle" because
  // its tab strip already says which project you're on — a satellite has no tabs, and its title is
  // the ONLY thing distinguishing four of them in the Window menu and in Mission Control.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const name = project?.name;
    if (!name) return;
    getCurrentWindow()
      .setTitle(`${name} — Sparkle`)
      .catch(() => {});
  }, [project?.name]);

  // ⌘+ / ⌘- / ⌘0 terminal zoom, same bindings the main window carries.
  //
  // NO FOCUS LOOKUP HERE, and that is the point of giving this window its own `ZoomColumn`. The main
  // window has to ask which of five columns a press belongs to; this one holds exactly ONE region, so
  // the answer is a constant and the gesture can never be ambiguous. It also keeps the satellite's
  // text size independent of the cockpit's terminals rather than silently sharing a level with
  // whichever column the pane was torn off from — see `ZoomColumnOverride`, which is what makes the
  // pane inside actually READ this key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        stepColumnZoom(SATELLITE_ZOOM_COLUMN, 1);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        stepColumnZoom(SATELLITE_ZOOM_COLUMN, -1);
      } else if (e.key === "0") {
        e.preventDefault();
        resetColumnZoom(SATELLITE_ZOOM_COLUMN);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stepColumnZoom, resetColumnZoom]);

  // The red traffic light re-docks: intercept it, take the panes down, and let the effect below
  // finish the job. NOT a plain close — the project has to get back to main, and the PTYs have to
  // die here before they are respawned there.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const unlistenPromise = getCurrentWindow().onCloseRequested((event) => {
      // ONCE THE PROJECT IS RELEASED, stop intercepting. Otherwise a `destroy()` that failed or
      // never landed leaves a blank window that can never be closed again: this handler would keep
      // preventing the default, and `setClosing(true)` on an already-true state does not re-run the
      // teardown effect. The window would sit there holding a pool label with no ownership row for
      // `reconcileSatellites` to clean up — one of the four slots gone until the app quits. After
      // the release there is nothing left to order, so a plain close is exactly right.
      if (releasedRef.current) return;
      event.preventDefault();
      setClosing(true);
    });
    return () => void safeUnlisten(unlistenPromise);
  }, []);

  // Main's "Bring it back here" button. It asks rather than destroying us, because a destroyed
  // webview runs no React cleanup — no Terminal unmount, so no `transport.detach()`, so no PTY kill,
  // and main would then respawn those agent ids over live children (satelliteWindows'
  // SATELLITE_REDOCK_EVENT). Answering it is what makes the ordered teardown below run at all.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const unlistenPromise = listen<{ projectId?: string }>(SATELLITE_REDOCK_EVENT, (e) => {
      // The event is broadcast to every webview, so each satellite answers only for its own project.
      if (e.payload?.projectId === projectId) setClosing(true);
    });
    return () => void safeUnlisten(unlistenPromise);
  }, [projectId]);

  // Phase two of the close: panes are unmounted (`closing` gates the whole stage below), so give the
  // detaches a beat to land in Rust, hand the project back, and destroy the window. Main is watching
  // the ownership channel and remounts the moment the release lands.
  useEffect(() => {
    if (!closing) return;
    const t = setTimeout(() => {
      clearWindowProject(label);
      releaseSatellite(projectId);
      // Flag BEFORE the destroy, not in its `.then`: the point of the flag is that the red button
      // still works if the destroy never lands, and a rejected destroy would skip a `.then`.
      releasedRef.current = true;
      if ("__TAURI_INTERNALS__" in window) {
        getCurrentWindow()
          .destroy()
          .catch((e) => {
            // The project is already home, so this is not a correctness failure any more — but it
            // is worth a line, and the close handler above now lets the user finish the job.
            console.warn("satellite destroy failed; the window can be closed manually", e);
          });
      }
    }, CLOSE_SETTLE_MS);
    return () => clearTimeout(t);
  }, [closing, projectId, label]);

  // A project deleted from the main window leaves this satellite with nothing to render — and
  // holding an ownership row for a project that no longer exists. Re-dock rather than sit there
  // blank. Gated on the store having hydrated (`projects.length > 0`), so a cold first frame
  // isn't mistaken for a deletion.
  useEffect(() => {
    if (!closing && projects.length > 0 && !project) setClosing(true);
  }, [closing, projects.length, project]);

  const activeAgentId = project?.selectedAgentId ?? null;
  const boardActive = planBoardUp(workMode, !!project, beadsEnabled);

  // Only THIS project's open agents ever mount here — the whole point of the ownership split. No
  // visited-set bookkeeping either: a satellite shows one project, so there is no tab you can leave.
  const live: Array<{ project: Project; agent: AgentTab }> = useMemo(() => {
    if (!project || closing) return [];
    const openSet = new Set(openAgentIds);
    return project.agents.filter((a) => openSet.has(a.id)).map((a) => ({ project, agent: a }));
  }, [project, openAgentIds, closing]);

  const onPickPlan = () => {
    openPlanBoard(SATELLITE_PAIR_SIDE);
  };
  const onPickBuild = () => {
    showBuildStage(SATELLITE_PAIR_SIDE);
  };

  return (
    // EVERY PANE BELOW READS THIS WINDOW'S OWN ZOOM KEY. Without the provider `useZoomColumn` would
    // derive a column from the project's side in the SHARED assignment map and return
    // `terminal-right` — silently tying this window's text size to a column in the main window,
    // which is the exact cross-column coupling this whole change exists to remove.
    <ZoomColumnOverride.Provider value={SATELLITE_ZOOM_COLUMN}>
    <div
      style={{
        display: "flex",
        height: "100vh",
        width: "100vw",
        background: C.deepForest,
        color: C.cream,
        fontFamily: FONT_UI,
      }}
    >
      <div style={{ flex: 1, display: "flex", minWidth: 0, position: "relative" }}>
        {/* ② Builder agents. `showSparkleRow={false}`: Improve Sparkle is main's agent.
            `covered` because this window has ALWAYS had the shape main only just grew: the board
            below is `absolute; inset: 0` inside this relative wrapper, so it covers this column
            too, and both render a PlanBuildToggle. Without it Tab walks hidden agent rows and a
            duplicate mode toggle behind an opaque surface and AT announces both. The condition
            mirrors the board's own render gate exactly — they must not be able to disagree. */}
        <AgentSidebar
          project={closing ? null : project}
          showSparkleRow={false}
          forcePairSide={SATELLITE_PAIR_SIDE}
          covered={boardActive && !!project && !closing}
        />
        {/* ③ The terminal stage. */}
        <div
          data-testid="terminal-stage"
          data-dnd-target={TERMINAL_STAGE_DND_TARGET}
          style={{ flex: 1, position: "relative", minHeight: 0, background: C.forest }}
        >
          <Suspense fallback={<PaneFallback />}>
            {live.map(({ project: p, agent }) => {
              const visible = !boardActive && agent.id === activeAgentId;
              return (
                <ErrorBoundary
                  key={agent.id}
                  scope="agent-pane"
                  fallback={({ error, reset }) => (
                    <AgentPaneErrorCard error={error} reset={reset} visible={visible} />
                  )}
                >
                  <AgentPane project={p} agent={agent} visible={visible} />
                </ErrorBoundary>
              );
            })}
          </Suspense>

          {closing && <Hint title="Returning to the main window…" />}
          {!closing && !boardActive && !project && <Hint title="Loading project…" />}
          {!closing && !boardActive && project && project.agents.length === 0 && (
            <Hint title={project.name}>
              No agents in this project yet — start one from the main Sparkle window.
            </Hint>
          )}
          {!closing && !boardActive && project && project.agents.length > 0 && !activeAgentId && (
            <Hint title={project.name}>Pick an agent on the left.</Hint>
          )}
          {!closing && !boardActive && project && activeAgentId && !live.some((l) => l.agent.id === activeAgentId) && (
            <Hint title={project.name}>
              <button
                onClick={() => open(activeAgentId)}
                style={{
                  background: C.teal,
                  color: "#04231d",
                  border: "none",
                  borderRadius: 6,
                  padding: "10px 20px",
                  fontWeight: FONT_WEIGHT.semibold,
                  cursor: "pointer",
                  fontFamily: FONT_UI,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                }}
              >
                <FiPlay size={13} aria-hidden />
                Start this agent
              </button>
            </Hint>
          )}
        </div>

        {boardActive && project && !closing && (
          <div
            data-testid="plan-column"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              background: C.deepForest,
              zIndex: PLAN_COLUMN_Z,
            }}
          >
            {/* THE SAME ROW AS THE MAIN WINDOW'S PlanBoardSlot, AND IT HAS TO STAY THAT WAY.
                BoardFilterBar.tsx's header records that this top row has TWO hosts and that a change
                made in only one DRIFTS; this is the second host. Toggle FIRST and left-justified,
                filters to its RIGHT, on AgentSidebar's `.bhd` geometry (`minHeight: 34`,
                `padding: "0 10px"`) so the control sits on the same x and y in Plan as in Build —
                the founder's "keep it where it is so I can switch between them easily". The long
                rationale, including why these are literals and not an imported constant, is on the
                Workspace.tsx copy; the tests pin both hosts to the same numbers. */}
            <div
              data-testid="plan-board-header"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-start",
                flexWrap: "wrap",
                gap: 8,
                minHeight: 34,
                padding: "0 10px",
                // A margin, not bottom padding: padding would pull the toggle off the Build
                // header's centre line, which is the alignment this row exists to hold.
                marginBottom: 8,
                flex: "0 0 auto",
              }}
            >
              <PlanBuildToggle
                mode={workMode}
                beadsEnabled={beadsEnabled}
                variant="mini"
                onPickPlan={onPickPlan}
                onPickBuild={onPickBuild}
              />
              {workMode === "plan" && <BoardFilterBar side={SATELLITE_PAIR_SIDE} />}
            </div>
            <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
              <Suspense fallback={<PaneFallback />}>
                <BoardView project={project} side={SATELLITE_PAIR_SIDE} />
              </Suspense>
            </div>
          </div>
        )}
      </div>
    </div>
    </ZoomColumnOverride.Provider>
  );
}

function Hint({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        textAlign: "center",
        padding: 24,
      }}
    >
      <div style={{ fontSize: 17, fontWeight: FONT_WEIGHT.semibold, color: C.cream }}>{title}</div>
      {children && (
        <div style={{ color: C.muted, maxWidth: 420, lineHeight: 1.5 }}>{children}</div>
      )}
    </div>
  );
}
