// apps/desktop/src/services/captureSends.ts
// The capture://send router. The capture window broadcasts one CaptureSendPayload to every
// window; exactly ONE window may act on it. Ownership's source of truth is the window
// registry (windowRegistry.ts, localStorage-backed and shared same-origin across webviews):
// the window whose label === findWindowForProject(projectId) owns the project; an orphan
// project (no registered window) falls to the main window. routeCaptureSend is the pure
// decision; the capture://send listener (wired in App.tsx via CaptureSendController) applies it
// via shouldHandleCaptureSend and dispatches by mode (Build / Chat).
//
// BOTH MODES END IN THE SAME PLACE: a draft in the concierge compose box (stores/
// composeHandoffStore → ConciergeHost). They differ only in what they do BEFORE that — Build
// selects (or creates) the build agent the capture named, so the concierge's auto-router aims
// there; Chat marks the draft for Sparkle and touches no agent.
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { normalizeCaptureMode, type CaptureSendPayload } from "../capture/types";
import { clearWindowProject, findWindowForProject } from "./windowRegistry";
import { useProjectStore } from "../stores/projectStore";
import { landInAgent } from "./landInAgent";
import { useComposeHandoffStore } from "../stores/composeHandoffStore";
import { sideOf } from "../engine/pairs";
import { useUiStore } from "../stores/uiStore";
import {
  routeToOwningWindow,
  shouldHandleInThisWindow,
  type WindowRouteDeps,
  type WindowDispatchDeps,
} from "./windowOwnership";
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

/** Bring this window forward so the routed result (the concierge compose box, holding the draft) is
 *  visible even if the window was hidden/minimized while the capture modal had focus. */
async function focusThisWindow(): Promise<void> {
  const win = getCurrentWindow();
  await win.show().catch(() => {});
  await win.unminimize().catch(() => {});
  await win.setFocus().catch(() => {});
}

/** Build: route the capture into a build agent per the payload's Build-menu selection, then hand
 *  the text + shots to the concierge compose box as a DRAFT (not auto-sent) and switch to Build.
 *
 *  WHERE THE DRAFT GOES, and why it moved. This used to call `handoffStore.setBuildDraft`, read by
 *  the terminal composer inside AgentPane. That composer was deleted in db29f0a48 and the concierge
 *  box became the input surface for a build agent — so the draft was writing to a store with no
 *  reader, and every island capture since has created an agent and dropped the user's words and
 *  screenshot on the floor without so much as a log line. The handoff now goes to
 *  composeHandoffStore, which ConciergeHost consumes AND LOGS.
 *
 *  THE ORDER OF THE LAST TWO STEPS IS THE RACE HANDLING. The agent may be created in this very
 *  tick, so it cannot be waited for; instead `selectAgent` + `open` run BEFORE the handoff is
 *  queued, all three synchronously. React therefore renders the concierge with the new agent
 *  already selected in the same commit that first sees the handoff, so the auto-router's aim is the
 *  agent this capture named. Queue the handoff first and the box could be prefilled a frame before
 *  the selection lands, aiming the user's Enter at whatever they were looking at before.
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
  // ── THE TWO DROPS, NOW AUDIBLE ──────────────────────────────────────────────────────────────
  // Both of these are real losses of user work: the narration and the screenshot go nowhere and
  // the user is never told. They were bare `return`s, which is the same class of silence as the
  // orphaned store this whole change exists to fix — the bug survived for days precisely because
  // nothing in this path ever wrote a log line. Anything that discards a capture says so.
  if (!project) {
    log.error("capture", "capture→build dropped: no such project in this window", {
      projectId: payload.projectId,
      chars: payload.text.length,
      attachments: payload.attachments.length,
    });
    return;
  }
  const picked =
    !payload.forceNewAgent && payload.targetAgentId
      ? project.agents.find((a) => a.id === payload.targetAgentId && a.kind === "build")
      : undefined;
  const existing = payload.forceNewAgent ? undefined : picked ?? project.agents.find((a) => a.kind === "build");
  const agentId = existing ? existing.id : store.addAgent(payload.projectId, { kind: "build" });
  if (!agentId) {
    // The project vanished between the lookup above and the create (another window closed it).
    log.error("capture", "capture→build dropped: could not create a build agent", {
      projectId: payload.projectId,
      chars: payload.text.length,
      attachments: payload.attachments.length,
    });
    return;
  }
  // The user asked for a SPECIFIC existing agent and it was gone by the time the send arrived, so
  // this capture is about to land somewhere they did not choose. Not fatal — the fallback is a
  // build agent in the right project, and it is still a draft they have to send — but it is a
  // silent re-aim, and re-aiming without a trace is how the wrong-agent class of bug hides.
  if (payload.targetAgentId && !payload.forceNewAgent && !picked) {
    log.warn("capture", "capture→build: the picked build agent is gone — falling back", {
      projectId: payload.projectId,
      requestedAgentId: payload.targetAgentId,
      fallbackAgentId: agentId,
    });
  }
  // Leave the special view, select, open — and (new) scroll the row on screen, which this path was
  // missing: a capture can land on an agent well below the fold of a long column.
  //
  // ══ DELIBERATELY *NOT* GATED ON THE ATTENTION HOLD ══════════════════════════════════════════
  // It was, for one review round, and that was a defect rather than a conservative choice. The
  // select on this line is a LOAD-BEARING PRECONDITION of the handoff published three lines below,
  // not merely a courtesy: `ConciergeHost`'s handoff effect drains `composeHandoffStore` on the
  // next render and inserts the text into the composer's LIVE aim, and its own wrong-agent guard
  // states the invariant explicitly — *"dispatchBuild selects that agent synchronously before
  // queueing the draft, so by the time this effect runs the box's live aim should already BE that
  // agent"*. Suppressing the select does not defer the landing; it publishes the capture into a
  // composer still aimed at whatever agent the founder was typing in, so his next Enter sends it
  // to the wrong PTY. A silent wrong-agent send is a strictly worse outcome than a moved view.
  //
  // It is also the wrong surface for the rule on its own terms. A capture send is the founder's own
  // gesture — he pressed send in the capture window — and the guard declines only jumps the app
  // starts.
  //
  // AND THE COST WOULD BE THE OPPOSITE OF SMALL, which is worth stating because an earlier version
  // of this note claimed the reverse. `attentionHold()` deliberately does NOT consult
  // `document.hasFocus()` (see its header), so a gate here would read the MAIN window's live
  // `activeElement` — which in a terminal-first shell is a terminal essentially always. It would
  // therefore decline nearly every capture, permanently, on top of breaking the precondition above.
  landInAgent(payload.projectId, agentId);
  useComposeHandoffStore.getState().set({
    origin: "capture-build",
    projectId: payload.projectId,
    agentId,
    text: payload.text,
    attachments: payload.attachments,
    // No `route`: Build wants the concierge's ordinary aim, which the selection above has just
    // pointed at this agent.
  });
  // The capture landed in ONE project's build agent — switch that project's column, not both.
  useUiStore
    .getState()
    .setWorkMode(sideOf(useUiStore.getState().pairAssignment, payload.projectId), "build");
  log.info("capture", "capture→build handed off to the concierge compose box", {
    projectId: payload.projectId,
    agentId,
    createdAgent: !existing,
    chars: payload.text.length,
    attachments: payload.attachments.length,
  });
}

/** Chat: hand the capture to the SPARKLE CONCIERGE as a draft. No agent is selected, created or
 *  touched — the point of this mode is that the user wants to talk to Sparkle about what they
 *  captured, not to set a builder off.
 *
 *  REPLACES THE OLD "Plan" ROUTE, which ran a Chief round trip (copy asset → synthesize a PRD →
 *  decompose into beads) straight off the button. That pipeline could only work for a project with
 *  a Chief PAT and a mapped Chief project, and threw for everyone else; capture is a two-second
 *  gesture and had no business fronting it. `services/capturePlan.ts` went with it (this route was
 *  its only caller). `prd.ts` / `tasks.ts` are UNTOUCHED — the Plan board and sendToBuild still use
 *  them.
 *
 *  `route: "sparkle"` is what makes the mode mean anything. Without it the concierge's auto-router
 *  would classify the draft like any other message and could aim it at whatever build agent happens
 *  to be on screen — which is precisely the destination the user declined by not pressing Build. */
export function dispatchChat(payload: CaptureSendPayload): void {
  useComposeHandoffStore.getState().set({
    origin: "capture-chat",
    projectId: payload.projectId,
    text: payload.text,
    attachments: payload.attachments,
    route: "sparkle",
  });
  log.info("capture", "capture→chat handed off to the concierge compose box", {
    projectId: payload.projectId,
    chars: payload.text.length,
    attachments: payload.attachments.length,
  });
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

  // Normalized, never switched on raw: a capture window that hasn't reloaded since the upgrade
  // still emits the retired "plan", and an unmatched arm here is a silent drop (see
  // normalizeCaptureMode).
  const mode = normalizeCaptureMode(payload.mode);
  try {
    switch (mode) {
      case "build":
        dispatchBuild(payload);
        break;
      case "chat":
        dispatchChat(payload);
        break;
    }
    await focusThisWindow();
  } catch (e) {
    log.error("capture", `capture://send ${mode} dispatch failed`, e);
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
