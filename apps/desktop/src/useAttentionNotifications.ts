// Drives the dock badge + Notification Center banners off live agent status, and routes a
// notification click back to the exact worker that asked. Mounted once per window (inside the
// CurrentProjectProvider) by <AttentionController/>.
//
// Each window owns ONE project, so it only knows/reports the status of that project's agents:
//  - badge: report this window's red count; the backend sums across windows (the macOS dock
//    badge is app-global) — see attention.rs.
//  - notification: fire once when an agent crosses INTO a status the user has enabled for
//    notifications (Settings ⋯ → Notifications; newlyEntered), not on every tick. Switching the
//    window to a different project re-baselines silently so the switch itself doesn't ping you
//    for agents that were already in a notifiable status.
//  - click: the backend broadcasts attention://focus-agent to every window; the window that
//    owns that project brings itself forward and selects the agent (main adopts an orphaned
//    project no window is currently showing).
import { useEffect, useMemo, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  countAttention,
  newlyEntered,
  notificationFor,
  suppressNotification,
  type StatusMap,
} from "./engine/attention";
import { useRuntimeStore } from "./stores/runtimeStore";
import { useSettingsStore } from "./stores/settingsStore";
import { useScrollIntentStore } from "./stores/scrollIntentStore";
import { useProjectStore } from "./stores/projectStore";
import { useUiStore } from "./stores/uiStore";
import { revealModeForKind } from "./engine/workMode";
import { aiFeatureNow } from "./services/aiGate";
import {
  useCurrentProjectId,
  useCurrentWindowLabel,
  useIsMainWindow,
  useReplaceCurrentProject,
} from "./windowContext";
import { findWindowForProject } from "./services/windowRegistry";
import {
  reportAttentionCount,
  notifyAttention,
  summarizeAttention,
  onFocusAgent,
  type FocusAgentPayload,
} from "./services/attention";
import { emitAttention, emitResolved } from "./services/relayClient";
import { getAgentScrollback } from "./services/terminalScrollback";
import { suggestedRepliesFor } from "./services/suggestions/attentionReplies";
import { safeUnlisten } from "./services/safeUnlisten";
import {
  publishWindowRedAgents,
  clearWindowStatus,
  isRedStatus,
} from "./services/windowStatus";
import type { AgentTab, AgentTabStatus } from "./types";

/** The "needs you" red statuses relayed to the phone (mirrors engine/attention's ATTENTION set).
 *  Includes `errored`: a crashed or mid-stream-stalled agent is stuck until you step in (the
 *  "never lose time" intent). Now set-equal to windowStatus.isRedStatus — both cover
 *  waiting|approval|errored — so the badge, the phone relay, and the cross-window red tier agree. */
const isRelayRed = (s: AgentTabStatus | undefined): boolean =>
  s === "approval" || s === "waiting" || s === "errored";

/** The name other windows should show — Claude Code's title if known, else the auto-name, else the
 *  fallback. Mirrors useRosterPublisher.displayName. */
const displayName = (a: AgentTab): string =>
  a.aiTitle || a.autoNameVariants?.title || a.name;

/** Cap the raw terminal `detail` we relay to the phone. The trigger sits at the BOTTOM of the
 *  screen/scrollback, so keep the tail (a runaway scrollback would otherwise bloat the payload).
 *  Trailing blank lines a terminal snapshot pads with are stripped so the card doesn't render a
 *  wall of empty space. */
export const DETAIL_MAX = 4000;
export const truncateDetail = (raw: string): string => {
  const trimmed = raw.replace(/[ \t]*\n(?:[ \t]*\n)+$/g, "\n").trimEnd();
  if (trimmed.length <= DETAIL_MAX) return trimmed;
  return `…\n${trimmed.slice(trimmed.length - DETAIL_MAX)}`;
};

/** Bring this window to the foreground (notification click landed here). */
async function bringToFront(): Promise<void> {
  try {
    const w = getCurrentWindow();
    await w.unminimize();
    await w.show();
    await w.setFocus();
  } catch (e) {
    console.debug("bringToFront failed", e);
  }
}

/** Mount the agent (so its pane exists) and make it the selected tab — and crucially REVEAL it.
 *  A cross-window "needs attention" jump lands here in the owning window, but that window may be
 *  showing a special overlay (Sparkle/Plan board) or sitting on a chevron whose mode filter HIDES
 *  this agent (the publish side advertises every red agent regardless of kind/mode, while the
 *  sidebar only paints the current mode's rows). Selecting alone would leave the agent filtered out
 *  of view — the "it's red somewhere but I can't find it" report. So leave any special overlay and
 *  switch the chevron to the agent's kind first, so the agent is actually surfaced and shown. */
export function selectAndOpen(projectId: string, agentId: string): void {
  const agent = useProjectStore
    .getState()
    .projects.find((p) => p.id === projectId)
    ?.agents.find((a) => a.id === agentId);
  useUiStore.getState().setActiveSpecial(null);
  // Gate-aware so this can't fight reconcileWorkMode: a gated-off think agent maps to Build (its
  // ThinkPanel pane still shows by kind; only the chevron/row stays on Build).
  if (agent) {
    useUiStore.getState().setWorkMode(revealModeForKind(agent.kind, aiFeatureNow("brainstorm")));
  }
  useRuntimeStore.getState().open(agentId);
  useProjectStore.getState().selectAgent(projectId, agentId);
}

export function useAttentionNotifications(): void {
  const status = useRuntimeStore((s) => s.status);
  const projectId = useCurrentProjectId();
  const label = useCurrentWindowLabel();
  const isMain = useIsMainWindow();
  const replace = useReplaceCurrentProject();
  const agents = useProjectStore(
    (s) => s.projects.find((p) => p.id === projectId)?.agents ?? EMPTY_AGENTS,
  );
  const projectName = useProjectStore(
    (s) => s.projects.find((p) => p.id === projectId)?.name ?? "",
  );
  // Which statuses the user wants notifications for (⋯ → Notifications). Built into a Set so the
  // edge detector is a cheap membership test. Recomputed only when the prefs object changes.
  const notifyStatuses = useSettingsStore((s) => s.notifyStatuses);
  const enabled = useMemo(
    () =>
      new Set(
        (Object.keys(notifyStatuses) as Array<keyof typeof notifyStatuses>).filter(
          (k) => notifyStatuses[k],
        ),
      ),
    [notifyStatuses],
  );

  // Previous status snapshot + which project it was for, so a project switch re-baselines
  // instead of firing a notification for every already-notifiable agent in the new project.
  const prevStatus = useRef<StatusMap>({});
  const prevProject = useRef<string | null>(null);
  // agentId -> the attention_id we sent the phone, so we can resolve it when it clears.
  const attentionIds = useRef<Record<string, string>>({});
  // agentId -> epoch ms it entered the red tier. Stamped on the FIRST red tick, reused on later
  // ticks (so the timestamp is "when it went red", not "when we last recomputed"), and pruned to the
  // currently-red set each run so an agent that leaves red and returns gets a FRESH timestamp. Read
  // cross-window as the `since` that picks each window's most-recently-red representative row.
  const redSince = useRef<Record<string, number>>({});

  // Badge + notification side-effects, recomputed whenever status, the owned agent set, or the
  // notify prefs change. The badge stays strictly waiting/approval (countAttention); the banner
  // fires for any newly-entered status the user enabled.
  useEffect(() => {
    const ownedIds = agents.map((a) => a.id);
    reportAttentionCount(label, countAttention(status, ownedIds));

    // Publish THIS window's red (needs-attention) agents to the cross-window status channel so other
    // windows can surface them at the top of their sidebar. Uses the red-color set
    // (waiting|approval|errored), same tier as the relay. Empty set deletes our entry.
    const nextRedSince: Record<string, number> = {};
    const redList = agents.flatMap((a) => {
      const st = status[a.id];
      if (!isRedStatus(st)) return [];
      // Reuse the existing stamp if this agent was already red; else it just entered red now.
      const since = redSince.current[a.id] ?? Date.now();
      nextRedSince[a.id] = since;
      return [{ id: a.id, name: displayName(a), status: st, since }];
    });
    // Prune to only currently-red ids so a later return-to-red gets a fresh Date.now() above.
    redSince.current = nextRedSince;
    publishWindowRedAgents(label, projectId ?? "", projectName, redList);

    const sameProject = prevProject.current === projectId;
    if (sameProject) {
      // Read live at fire time (no extra deps / re-baselining): is THIS window the OS-focused
      // window, and which of its agents is the selected tab. Together they let us suppress the
      // single "you're already looking at this exact agent" case while still firing for a
      // different agent, a background window/project, or another app in front.
      const windowFocused = typeof document !== "undefined" && document.hasFocus();
      const selectedAgentId =
        useProjectStore.getState().projects.find((p) => p.id === projectId)?.selectedAgentId ?? null;
      // For each agent that just crossed into a notifiable status, dispatch ONE independent
      // fire-and-forget task. The task computes the Haiku "what is it asking" summary ONCE (for the
      // waiting/approval ask statuses) and feeds it to BOTH channels — the paired phone (emitAttention
      // → the iOS push body) and the native macOS banner (notifyAttention body) — so the Mac and the
      // phone read identically. Tasks are independent (not serialized behind one another's await) so a
      // slow/hung summary (the Haiku call can take up to ~40s before its timeout falls back) never
      // delays an unrelated notice. The effect can't be async, so each task has its own catch.
      const pid = projectId;
      for (const { id, status: st } of newlyEntered(prevStatus.current, status, ownedIds, enabled)) {
        const agent = agents.find((a) => a.id === id);
        if (!agent || pid == null) continue;
        const agentName = agent.name;
        const relay = isRelayRed(st); // mirrored to the phone regardless of local suppression
        const suppressed = suppressNotification({ windowFocused, selectedAgentId, agentId: id });
        if (!relay && suppressed) continue; // not relayed and locally suppressed — nothing to send
        void (async () => {
          // The agent's ask, summarized once and shared by phone + banner. Only the two "ask"
          // statuses are summarized (cost control); any miss/empty/throw → null → generic copy below.
          // `awaited` records whether we actually yielded on the Haiku call — it gates the live
          // status re-check below so the synchronous path doesn't second-guess the just-validated `st`.
          let summary: string | null = null;
          let awaited = false;
          if (st === "waiting" || st === "approval") {
            const screenText = useRuntimeStore.getState().attentionScreen[id];
            if (screenText) {
              awaited = true;
              const trimmed = (await summarizeAttention(screenText))?.trim();
              if (trimmed) summary = trimmed;
            }
          }

          // Phone relay (separate device — fires regardless of local suppression). Only when we
          // actually awaited the summary do we re-check that the agent is STILL red: that await is the
          // gap in which the user could have answered/cleared it, and emitting after the fact would
          // race the resolve-cleanup below and leave a stale card on the phone. With no await we run
          // synchronously in the same tick `newlyEntered` validated `st`, so the captured status holds
          // and no re-check is needed (it would only re-read the same snapshot).
          if (relay && (!awaited || isRelayRed(useRuntimeStore.getState().status[id]))) {
            const attentionId = crypto.randomUUID();
            attentionIds.current[id] = attentionId;
            const approval = st === "approval";
            // `errored` covers both a crash and a mid-stream API-error/self-prompt stall — the agent
            // is stuck until you look, so it relays as a (reply-less) "needs you" with its own copy.
            const errored = st === "errored";
            // The EXACT terminal text that put this agent into the red state — the ask-screen
            // snapshot captured when it crossed into waiting/approval, else the recent scrollback
            // tail (errored/stalled agents have no ask snapshot). The phone renders this verbatim in
            // monospace under the plain-English `question` summary.
            const detail = truncateDetail(
              useRuntimeStore.getState().attentionScreen[id] ?? getAgentScrollback(id) ?? "",
            );
            emitAttention({
              attention_id: attentionId,
              agent_id: id,
              agent_name: agentName, // plain — the relay server prefixes the 🔴 in the push title
              project_name: projectName,
              kind: approval ? "approval" : "question",
              question:
                summary ??
                (approval
                  ? `${agentName} needs you to approve an action in ${projectName}.`
                  : errored
                    ? `${agentName} hit an error / stalled in ${projectName} and needs you.`
                    : `${agentName} is waiting on your answer in ${projectName}.`),
              ...(detail ? { detail } : {}),
              // Real heuristic-detected direct-answers (y/n, numbered menu) when present, else a
              // generic Approve/Deny for approvals. See suggestedRepliesFor.
              suggested_replies: suggestedRepliesFor(getAgentScrollback(id) ?? "", approval),
              created_at: new Date().toISOString(),
            });
          }

          // Native macOS banner — emoji'd title from notificationFor, body = the SAME summary the
          // phone got (or its generic reason fallback). Skipped only when you're already looking at
          // this exact agent (suppressNotification). Unlike the phone relay above, the banner does
          // NOT re-check live status after the await: a banner is a transient OS notification (it
          // appears and auto-dismisses), so a slightly-stale one is low-harm — whereas a phone card
          // persists until resolved, which is why only the relay re-validates. Intentional asymmetry.
          if (!suppressed) {
            const banner = notificationFor(st, agentName, projectName);
            notifyAttention({
              projectId: pid,
              agentId: id,
              title: banner.title,
              body: summary ?? banner.body,
            });
          }
        })().catch((e) => console.debug("attention notify dispatch failed", e));
      }
    }
    // Clear the phone's card for any agent we raised that is no longer red — including agents
    // that left the owned set entirely (project switch / removed), which the loop above misses.
    for (const [id, attentionId] of Object.entries(attentionIds.current)) {
      if (!isRelayRed(status[id])) {
        emitResolved(attentionId);
        delete attentionIds.current[id];
      }
    }
    prevStatus.current = status;
    prevProject.current = projectId;
  }, [status, agents, projectId, label, projectName, enabled]);

  // Report 0 + drop our cross-window status entry on unmount so a closed window stops contributing
  // to the badge total and stops surfacing its (now-gone) red agents in other windows' sidebars.
  useEffect(
    () => () => {
      reportAttentionCount(label, 0);
      clearWindowStatus(label);
    },
    [label],
  );

  // Notification-click routing. Registered once; reads live window/project via refs.
  const ctx = useRef({ projectId, label, isMain, replace });
  ctx.current = { projectId, label, isMain, replace };
  useEffect(() => {
    const handle = (p: FocusAgentPayload) => {
      const { projectId: mine, isMain: main, replace: setProject } = ctx.current;
      // If the click carried a specific prompt (tray breadcrumb), queue a scroll to that turn; the
      // target agent's AgentPane consumes it once its terminal is mounted + PTY-ready. Missing/
      // scrolled-out markers (or think agents with no terminal) simply open without scrolling.
      const jumpToPrompt = () => {
        if (p.promptId) useScrollIntentStore.getState().request(p.agentId, p.promptId);
      };
      if (p.projectId === mine) {
        void bringToFront();
        selectAndOpen(p.projectId, p.agentId);
        jumpToPrompt();
        return;
      }
      // Orphaned project (no window currently shows it) — the main window adopts it. Otherwise
      // the window that owns it handles this same broadcast via the `=== mine` branch above.
      if (findWindowForProject(p.projectId) == null && main) {
        setProject(p.projectId);
        selectAndOpen(p.projectId, p.agentId);
        jumpToPrompt();
        void bringToFront();
      }
    };
    // Keep the listen() promise; safeUnlisten awaits it on cleanup so a listener that resolves
    // AFTER unmount is still torn down (and the Tauri teardown race is swallowed).
    const unlistenPromise = onFocusAgent(handle);
    return () => {
      void safeUnlisten(unlistenPromise);
    };
  }, []);
}

// Stable empty reference so the agents selector doesn't return a fresh [] each render.
const EMPTY_AGENTS: AgentTab[] = [];
