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
import { reportAttentionSource } from "./services/selfReportObservability";
import type { AttentionSource } from "./stores/selfReportMetrics";
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

// --- Phase-2b: prefer a FRESH self-reported activity over the paid Haiku ask-summary ----------
// An agent narrates "what I'm building now" via the sparkle-control `set_agent_activity` MCP op
// (AgentTab.activity). When that narration was updated within a short window of the agent crossing
// into a needs-you (waiting/approval) state, it almost certainly describes the current ask — so we
// use it as the notification body and SKIP the credit-metered summarize_attention screen-scrape.
//
// `activity` carries NO timestamp today (adding one would touch projectStore/types, outside this
// file's ownership — see PRD/feat__claude-code-drives-.md), so we derive its age purely
// from state visible HERE: this effect re-runs whenever the owned `agents` array changes, and
// `setAgentActivity` produces a new array, so we can observe activity CHANGES across runs and stamp
// when each one first appeared (stampActivity). First sighting of an id is stamped `at = 0` —
// "unknown age" — so an activity restored from a previous session's persisted state is treated as
// stale (conservative: we keep calling Haiku) until the agent actually re-narrates in this session.
export const ACTIVITY_FRESH_MS = 10_000;

interface ActivityStamp {
  value: string; // the last-observed trimmed activity text
  at: number; // epoch ms we first observed THIS value ( 0 = first sighting / unknown age )
}

/** Fold this tick's owned agents into the activity-change stamp map. For each agent: first sighting
 *  → `at = 0` (unknown age); value changed vs last seen → `at = now` (just narrated); unchanged →
 *  keep the prior stamp. The returned map is pruned to exactly the current agents (an agent that
 *  left the set and returns gets a fresh first-sighting), mirroring the redSince bookkeeping. Pure. */
export function stampActivity(
  prev: Record<string, ActivityStamp>,
  agents: ReadonlyArray<{ id: string; activity?: string }>,
  now: number,
): Record<string, ActivityStamp> {
  const next: Record<string, ActivityStamp> = {};
  for (const a of agents) {
    const value = (a.activity ?? "").trim();
    const seen = prev[a.id];
    const at = seen === undefined ? 0 : seen.value !== value ? now : seen.at;
    next[a.id] = { value, at };
  }
  return next;
}

/** The notification body to use FROM a self-report, or null to fall back to the Haiku summary. Only
 *  the two "ask" statuses (waiting/approval) are eligible — the exact scope summarize_attention
 *  covers — so errored/other statuses keep their existing generic copy unchanged. Returns the
 *  activity text only when it is present AND fresh: stamped in-session (`at > 0`) and updated within
 *  ACTIVITY_FRESH_MS of `now` (≈ the needs-you transition, which fires this same tick). Pure. */
export function selfReportBody(
  activity: string | undefined,
  stamp: ActivityStamp | undefined,
  now: number,
  status: AgentTabStatus | undefined,
): string | null {
  // Only substitute the activity narration for a WAITING body, where "what I'm doing now" is a
  // reasonable proxy for the question. For APPROVAL we must NOT — the body has to describe the
  // action being approved (e.g. "Approve `rm -rf build/`?"), which the narration ("Refactoring
  // auth") does not capture and could dangerously misrepresent; approval always uses the Haiku
  // ask-summary. (roborev sparkle-jze5 review.)
  if (status !== "waiting") return null;
  const text = (activity ?? "").trim();
  if (!text) return null;
  if (!stamp || stamp.at <= 0) return null; // unknown age → treat as stale
  if (now - stamp.at > ACTIVITY_FRESH_MS) return null; // stale narration → Haiku fallback
  return text;
}

/** Classify what actually supplied a needs-you notification body (Phase-2c gate, sparkle-rl84):
 *  a fresh self-report wins; else the paid Haiku ask-summary if it produced a body; else the generic
 *  reason copy. `selfReported` is selfReportBody's result; `haikuBody` is the trimmed
 *  summarize_attention output (null if not called / empty / failed). Pure — no identifying data. */
export function attentionBodySource(
  selfReported: string | null,
  haikuBody: string | null,
): AttentionSource {
  if (selfReported != null) return "self_report";
  if (haikuBody != null) return "paid_haiku";
  return "generic_fallback";
}

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
  // agentId -> {value, at}: the last activity narration we observed and WHEN it first appeared this
  // session. Feeds selfReportBody's freshness test (Phase-2b). Pruned to the current owned agents
  // each run by stampActivity, same lifecycle as redSince.
  const activitySeen = useRef<Record<string, ActivityStamp>>({});

  // Badge + notification side-effects, recomputed whenever status, the owned agent set, or the
  // notify prefs change. The badge stays strictly waiting/approval (countAttention); the banner
  // fires for any newly-entered status the user enabled.
  useEffect(() => {
    const now = Date.now();
    const ownedIds = agents.map((a) => a.id);
    reportAttentionCount(label, countAttention(status, ownedIds));

    // Observe activity narrations so we can judge their freshness at fire time (Phase-2b). Done
    // every run (before the sameProject gate) so a project switch still re-baselines the stamps.
    activitySeen.current = stampActivity(activitySeen.current, agents, now);

    // Publish THIS window's red (needs-attention) agents to the cross-window status channel so other
    // windows can surface them at the top of their sidebar. Uses the red-color set
    // (waiting|approval|errored), same tier as the relay. Empty set deletes our entry.
    const nextRedSince: Record<string, number> = {};
    const redList = agents.flatMap((a) => {
      const st = status[a.id];
      if (!isRedStatus(st)) return [];
      // Reuse the existing stamp if this agent was already red; else it just entered red now.
      const since = redSince.current[a.id] ?? now;
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
        // Phase-2b: if the agent FRESHLY self-reported what it's doing (within ACTIVITY_FRESH_MS of
        // this needs-you transition), prefer that text as the body and skip the paid Haiku scrape.
        // Captured synchronously here — the ref reflects this tick's stamping above. Null for stale/
        // absent narration (and for non-ask statuses), which falls through to Haiku exactly as before.
        const selfReported = selfReportBody(agent.activity, activitySeen.current[id], now, st);
        void (async () => {
          // The agent's ask, summarized once and shared by phone + banner. A fresh self-report wins;
          // otherwise only the two "ask" statuses are summarized (cost control), and any miss/empty/
          // throw → null → generic copy below. `awaited` records whether we actually yielded on the
          // Haiku call — it gates the live status re-check below so the synchronous path (self-report
          // or no screen) doesn't second-guess the just-validated `st`.
          let summary: string | null = selfReported;
          let awaited = false;
          // Phase-2c gate: track whether the PAID Haiku summary actually produced a usable body, so
          // we can classify the body source (self-report vs paid vs generic) below — observation only.
          let haikuBody: string | null = null;
          if (summary == null && (st === "waiting" || st === "approval")) {
            const screenText = useRuntimeStore.getState().attentionScreen[id];
            // Match the backend's own empty-check: `summarize_attention` trims the screen before
            // deciding there's nothing to summarize, so a whitespace/newline-only snapshot would slip
            // past a bare truthiness guard, cost an IPC round-trip, and come back as a "failed empty
            // screen" non-error. Pre-trim here so we only summarize a screen with real content.
            if (screenText?.trim()) {
              awaited = true;
              const trimmed = (await summarizeAttention(screenText))?.trim();
              if (trimmed) {
                summary = trimmed;
                haikuBody = trimmed;
              }
            }
          }
          // Record which source supplied the body, once per DISPATCHED needs-you event (privacy-safe
          // enums only: source, status, kind — never the body text itself). Population = events that
          // reached at least one channel: red statuses always fire the phone relay here (even when the
          // LOCAL banner is suppressed because you're already looking at the agent), and the `!relay &&
          // suppressed` case already `continue`d above, so it never reaches this line. So this counts
          // "of needs-you events we surfaced somewhere," NOT "of banners visibly shown on this Mac."
          reportAttentionSource(attentionBodySource(selfReported, haikuBody), st, agent.kind);

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
