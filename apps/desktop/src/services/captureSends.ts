// apps/desktop/src/services/captureSends.ts
// The capture://send router. The capture window broadcasts one CaptureSendPayload to every
// window; exactly ONE window may act on it. Ownership's source of truth is the window
// registry (windowRegistry.ts, localStorage-backed and shared same-origin across webviews):
// the window whose label === findWindowForProject(projectId) owns the project; an orphan
// project (no registered window) falls to the main window. routeCaptureSend is the pure
// decision; the capture://send listener (wired in App.tsx via CaptureSendController) applies it
// via shouldHandleCaptureSend and dispatches by mode (Build / Plan).
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { CaptureSendPayload } from "../capture/types";
import { clearWindowProject, findWindowForProject } from "./windowRegistry";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useHandoffStore } from "../stores/handoffStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore, effectiveChiefPat } from "../stores/settingsStore";
import { sendCaptureToPlan, copyCaptureAsset } from "./capturePlan";
import { synthesizePrd, writePrd } from "./prd";
import { generateTasks, createBeadFull, beadDepAdd } from "./tasks";
import { structuredJson } from "./anthropic";
import {
  routeToOwningWindow,
  shouldHandleInThisWindow,
  type WindowRouteDeps,
  type WindowDispatchDeps,
} from "./windowOwnership";
import { startChat, pollForResponse } from "./chief";
import { log } from "../logger";

// The single-owner election itself now lives in windowOwnership.ts — it is not capture-specific
// (orchestration:request needs the identical at-most-one/at-least-one guarantee). These stay as the
// capture-shaped names/signatures so call sites and tests read in terms of a payload.
export type CaptureRouteDeps = WindowRouteDeps;
export type CaptureDispatchDeps = WindowDispatchDeps;

/** Should THIS window handle the payload? See routeToOwningWindow. */
export function routeCaptureSend(payload: CaptureSendPayload, deps: CaptureRouteDeps): boolean {
  return routeToOwningWindow(payload.projectId, deps);
}

/** routeCaptureSend plus main's stale-owner self-heal. See shouldHandleInThisWindow.
 *  Stays `async` rather than returning the inner promise directly: callers absorb failures with
 *  `.catch(...)`, and a SYNCHRONOUS throw out of the registry read would bypass that if this
 *  forwarded the call bare. Every failure mode stays a rejection. */
export async function shouldHandleCaptureSend(
  payload: CaptureSendPayload,
  deps: CaptureDispatchDeps,
): Promise<boolean> {
  return shouldHandleInThisWindow(payload.projectId, deps);
}

// ── Dispatch (thin IO over the pure routing above) ──────────────────────────────────────────

/** This window's context, read fresh per event so a project switch between mount and event
 *  routes to the right owner (label/isMain are fixed for a window's life; projectId is not). */
export interface CaptureSendCtx {
  isMain: boolean;
  label: string;
  projectId: string | null;
  /** Swap this window's displayed project in place (windowContext's `replace`). */
  replace: (id: string | null) => void;
}

/** Bring this window forward so the routed result (Build composer / Plan board) is
 *  visible even if the window was hidden/minimized while the capture modal had focus. */
async function focusThisWindow(): Promise<void> {
  const win = getCurrentWindow();
  await win.show().catch(() => {});
  await win.unminimize().catch(() => {});
  await win.setFocus().catch(() => {});
}

/** Build: route the capture into a build agent per the payload's Build-menu selection, set the
 *  Build composer draft (consumed on mount/focus, NOT auto-sent), and switch to Build.
 *
 *  Agent selection (the Build options menu in CaptureApp drives which branch fires):
 *   - `forceNewAgent` → ALWAYS spawn a fresh build agent (the "New build agent" entry). This is
 *     the fix for "Build did not create a new build agent": the old code auto-reused the first
 *     existing build agent, so a new capture always landed in the same agent.
 *   - `targetAgentId` (a still-present build agent) → route into that EXACT agent the user picked.
 *   - neither → legacy reuse-or-create: the first existing build agent, or a fresh one if none. */
export function dispatchBuild(payload: CaptureSendPayload): void {
  const store = useProjectStore.getState();
  const project = store.projects.find((p) => p.id === payload.projectId);
  if (!project) return;
  const picked =
    !payload.forceNewAgent && payload.targetAgentId
      ? project.agents.find((a) => a.id === payload.targetAgentId && a.kind === "build")
      : undefined;
  const existing = payload.forceNewAgent ? undefined : picked ?? project.agents.find((a) => a.kind === "build");
  const agentId = existing ? existing.id : store.addAgent(payload.projectId, { kind: "build" });
  if (!agentId) return; // project vanished between the lookup and the create — drop the send
  useUiStore.getState().setActiveSpecial(null);
  store.selectAgent(payload.projectId, agentId);
  useRuntimeStore.getState().open(agentId);
  useHandoffStore.getState().setBuildDraft({
    projectId: payload.projectId,
    text: payload.text,
    attachments: payload.attachments,
  });
  useUiStore.getState().setWorkMode("build");
}

/** Plan: run the capture→Plan pipeline (copy shot → PRD synth → decompose), then switch to the
 *  Plan board. Throws on a missing project / unconfigured Chief so the caller logs it; the
 *  pipeline is atomic (spec §9) so a failure leaves nothing half-decomposed. */
async function dispatchPlan(payload: CaptureSendPayload): Promise<void> {
  const project = useProjectStore.getState().projects.find((p) => p.id === payload.projectId);
  if (!project) throw new Error(`capture→plan: unknown project ${payload.projectId}`);
  const s = useSettingsStore.getState();
  const pat = effectiveChiefPat(s.chiefPat, s.runtimeChiefPat);
  const chiefProjectId = s.chiefProjectByProject[payload.projectId];
  if (!pat || !chiefProjectId) {
    throw new Error("capture→plan: Chief is not configured for this project (no PAT or Chief project)");
  }
  await sendCaptureToPlan(
    {
      copyCaptureAsset,
      synthesize: (a) => synthesizePrd({ startChat, pollForResponse, writePrd }, a),
      generate: (a) => generateTasks({ structuredJson, createBeadFull, beadDepAdd, writePrd }, a),
    },
    {
      pat,
      chiefProjectId,
      projectPath: project.rootPath,
      text: payload.text,
      attachments: payload.attachments,
    },
  );
  const ui = useUiStore.getState();
  ui.setWorkMode("plan");
  ui.setActiveSpecial("board");
}

/** Handle one capture://send in THIS window: decide ownership (with main's stale-owner self-heal),
 *  make sure the window is showing the target project, then dispatch by mode + focus. Errors are
 *  logged, never thrown out (spec §9 — a send failure surfaces, it doesn't crash the listener). */
export async function handleCaptureSend(payload: CaptureSendPayload, ctx: CaptureSendCtx): Promise<void> {
  const deps: CaptureDispatchDeps = {
    myLabel: ctx.label,
    isMain: ctx.isMain,
    findWindowForProject: (pid) => findWindowForProject(pid),
    isWindowAlive: async (l) => (await WebviewWindow.getByLabel(l)) !== null,
    evictWindow: (l) => clearWindowProject(l),
  };

  let handle: boolean;
  try {
    handle = await shouldHandleCaptureSend(payload, deps);
  } catch (e) {
    log.error("capture", "capture://send ownership check failed", e);
    return;
  }
  if (!handle) return;

  // The owner already shows this project; an orphan adopted by main may be on another project —
  // switch to it so the routed result is visible in this window.
  if (ctx.projectId !== payload.projectId) ctx.replace(payload.projectId);

  try {
    switch (payload.mode) {
      case "build":
        dispatchBuild(payload);
        break;
      case "plan":
        await dispatchPlan(payload);
        break;
    }
    await focusThisWindow();
  } catch (e) {
    log.error("capture", `capture://send ${payload.mode} dispatch failed`, e);
  }
}

/** Mount the capture://send listener for THIS window (once, from CaptureSendController). `getCtx`
 *  is called per event so ownership/routing reads the window's current project. Returns the
 *  UnlistenFn (route it through safeUnlisten on teardown). */
export function initCaptureSendListener(getCtx: () => CaptureSendCtx): Promise<UnlistenFn> {
  return listen<CaptureSendPayload>("capture://send", (event) => {
    void handleCaptureSend(event.payload, getCtx());
  });
}
