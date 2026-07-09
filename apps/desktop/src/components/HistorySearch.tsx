// HistorySearch — the full-text search box under the Brainstorm/Build buttons in AgentSidebar.
// Presentational: it binds the input to the historyStore (which owns the debounce + the Tauri
// `history_search` call) and renders the ranked results. Clicking a result jumps to the AGENT that
// produced it: selecting it in place when it lives in this window's project, asking the window that
// owns its project to focus it when that window is open, or opening that project in a new window
// otherwise. If the agent has since been closed (deleted), the row reports "That agent has been
// closed" instead of navigating.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { C, DANGER, FONT_WEIGHT, ON_BRAND_FILL } from "../theme/colors";
import { useHistoryStore } from "../stores/historyStore";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useScrollIntentStore } from "../stores/scrollIntentStore";
import { emitFocusAgent } from "../services/attention";
import { findWindowForProject } from "../services/windowRegistry";
import { correlatePromptId } from "./promptCorrelate";
import type { PromptHistoryEntry } from "../types";
import type { HistoryHit, RetentionTier } from "../services/history";
import { purchaseRetention } from "../services/credits";
import {
  openProjectInWindow,
  defaultDeps,
  type OpenMode,
} from "../services/projectWindows";

/** Shown on a row whose source agent no longer exists. Closing an agent deletes its worktree from
 *  disk (see AgentSidebar.onClose), so there's nothing left to reopen — say so honestly. */
const AGENT_CLOSED_MESSAGE = "This agent was closed — its workspace no longer exists.";
/** How long the "agent closed" notice lingers before it auto-dismisses. */
const NOTICE_TIMEOUT_MS = 4000;

interface HistorySearchProps {
  /** Route a hit's project into a window, deep-linking to its agent. Injected in tests; defaults
   *  to the real Tauri wiring. Only ever called with mode `"new"` (a DIFFERENT project than this
   *  window's, with no window currently showing it). */
  openInWindow?: (projectId: string, mode: OpenMode, agentId?: string) => void;
  /** This window's current project id. Injected in tests; defaults to the store's selection. */
  currentProjectId?: string | null;
  /** Does the hit's source agent still exist (i.e. hasn't been closed)? Injected in tests;
   *  defaults to a projectStore lookup. */
  agentExists?: (projectId: string, agentId: string | null) => boolean;
  /** Select + mount an agent that lives in THIS window's project. Injected in tests; defaults to
   *  the open + selectAgent store pair (mirrors notification-click routing). */
  selectAgentHere?: (projectId: string, agentId: string) => void;
  /** Ask the window that owns the hit's project to bring itself forward and focus the agent.
   *  Injected in tests; defaults to the focus-agent broadcast. */
  focusAgentElsewhere?: (projectId: string, agentId: string) => void;
  /** Is some window currently showing this project? Injected in tests; defaults to the registry. */
  projectHasWindow?: (projectId: string) => boolean;
  /** This agent's recorded prompts, for correlating a hit to a terminal marker. Injected in
   *  tests; defaults to a projectStore lookup. */
  promptHistoryFor?: (projectId: string, agentId: string) => PromptHistoryEntry[];
  /** Queue a "scroll this agent's terminal to a prompt" intent. Injected in tests; defaults to
   *  the scrollIntent store. */
  requestScroll?: (agentId: string, promptId: string) => void;
}

/** Human label for the active retention window, shown in the results caption. */
const RETENTION_LABEL: Record<RetentionTier, string> = {
  "24h": "the last 24 hours",
  "7d": "the last 7 days",
  "30d": "the last 30 days",
  "90d": "the last 90 days",
  "1y": "the last year",
  indefinite: "all time",
};

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
// Largest-fitting unit, walked from seconds up — no new dep, no absolute dates in the row.
const DIVISIONS: [number, Intl.RelativeTimeFormatUnit][] = [
  [60, "second"],
  [60, "minute"],
  [24, "hour"],
  [7, "day"],
  [4.34524, "week"],
  [12, "month"],
  [Number.POSITIVE_INFINITY, "year"],
];

export function relativeTime(createdAt: number, now = Date.now()): string {
  let duration = (createdAt - now) / 1000; // seconds; negative = in the past
  for (const [amount, unit] of DIVISIONS) {
    if (Math.abs(duration) < amount) return RELATIVE.format(Math.round(duration), unit);
    duration /= amount;
  }
  return RELATIVE.format(Math.round(duration), "year");
}

/** Render an FTS5 snippet() string, turning its `<b>…</b>` match markers into bold text by
 *  SPLITTING on the literal markers — never `dangerouslySetInnerHTML`, so stored content can't
 *  inject markup. Any other `<…>` in the text is treated as plain text. */
export function renderSnippet(snippet: string): ReactNode[] {
  const parts = snippet.split(/(<b>|<\/b>)/);
  const nodes: ReactNode[] = [];
  let bold = false;
  parts.forEach((part, i) => {
    if (part === "<b>") {
      bold = true;
      return;
    }
    if (part === "</b>") {
      bold = false;
      return;
    }
    if (part === "") return;
    nodes.push(
      bold ? (
        <strong key={i} style={{ color: C.cream, fontWeight: FONT_WEIGHT.semibold }}>
          {part}
        </strong>
      ) : (
        <span key={i}>{part}</span>
      ),
    );
  });
  return nodes;
}

const badgeStyle = (kind: HistoryHit["kind"]): CSSProperties => ({
  flex: "0 0 auto",
  fontSize: 9,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  fontWeight: FONT_WEIGHT.semibold,
  padding: "1px 5px",
  borderRadius: 4,
  // Badge always sits on a constant brand blue fill (accentMid or teal), so its text must stay
  // light in both themes — C.cream would flip to navy in light mode and go low-contrast.
  color: ON_BRAND_FILL,
  background: kind === "prompt" ? C.accentMid : C.teal,
});

export function HistorySearch({
  openInWindow,
  currentProjectId,
  agentExists,
  selectAgentHere,
  focusAgentElsewhere,
  projectHasWindow,
  promptHistoryFor,
  requestScroll,
}: HistorySearchProps = {}) {
  const query = useHistoryStore((s) => s.query);
  const results = useHistoryStore((s) => s.results);
  const entitlement = useHistoryStore((s) => s.entitlement);
  const setQuery = useHistoryStore((s) => s.setQuery);
  const storeSelectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const touchProjectOpened = useProjectStore((s) => s.touchProjectOpened);

  // A transient "that agent has been closed" notice, keyed by the row that triggered it so it can
  // render inline on that row. Cleared when it times out or the query changes (see below).
  const [closedHitId, setClosedHitId] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);
  // A new search invalidates any stale "closed" notice from the previous result set.
  useEffect(() => {
    setClosedHitId(null);
  }, [query]);

  // Prefer the injected current project id (tests); otherwise this window's store selection.
  const currentId = currentProjectId !== undefined ? currentProjectId : storeSelectedProjectId;

  // Does the hit's source agent still exist? A closed agent is removed from projectStore, so a
  // missing lookup is exactly the "agent has been closed" case.
  const agentStillExists =
    agentExists ??
    ((projectId: string, agentId: string | null) => {
      if (!agentId) return false;
      const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
      return !!project?.agents.some((a) => a.id === agentId);
    });

  // Select + mount an agent in THIS window — the same open + selectAgent pair a notification
  // click uses (see useAttentionNotifications.selectAndOpen).
  const focusHere =
    selectAgentHere ??
    ((projectId: string, agentId: string) => {
      useRuntimeStore.getState().open(agentId);
      useProjectStore.getState().selectAgent(projectId, agentId);
    });

  // Cross-project, window already open: let that window bring itself forward and select the agent.
  const focusElsewhere = focusAgentElsewhere ?? ((projectId, agentId) =>
    emitFocusAgent({ projectId, agentId }));

  const hasWindow = projectHasWindow ?? ((projectId: string) => findWindowForProject(projectId) != null);

  // The agent's recorded prompts (for hit -> terminal-marker correlation).
  const lookupPromptHistory =
    promptHistoryFor ??
    ((projectId: string, agentId: string) => {
      const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
      return project?.agents.find((a) => a.id === agentId)?.promptHistory ?? [];
    });

  const queueScroll = requestScroll ?? ((agentId, promptId) =>
    useScrollIntentStore.getState().request(agentId, promptId));

  // Best-effort: correlate the hit to one of the agent's prompts and queue a scroll to its
  // terminal marker. Only meaningful in THIS window (the scroll-intent store is per-window, and
  // the marker only exists in a continuously-mounted terminal from this session); cross-window
  // navigations skip it. A miss (no correlation / no marker) simply doesn't scroll.
  const queueScrollToHit = (h: HistoryHit) => {
    if (!h.projectId || !h.agentId) return;
    const promptId = correlatePromptId(h, lookupPromptHistory(h.projectId, h.agentId));
    if (promptId) queueScroll(h.agentId, promptId);
  };

  // Real cross-project router. The "new" path of openProjectInWindow never touches
  // replaceCurrent/currentLabel (only the in-place "replace" path does), so the dummies below are
  // safe — and this component renders fine outside CurrentProjectProvider (e.g. in AgentSidebar
  // tests) because it depends on no window context.
  const routeToWindow =
    openInWindow ??
    ((projectId: string, mode: OpenMode, agentId?: string) => {
      void openProjectInWindow(
        projectId,
        mode,
        defaultDeps(
          () => {}, // replaceCurrent — unused on the "new" path
          touchProjectOpened,
          "main", // currentLabel — unused on the "new" path
        ),
        agentId,
      );
    });

  /** Flash the "agent has been closed" notice on a row, auto-dismissing after a beat. */
  const flashClosed = (hitId: string) => {
    setClosedHitId(hitId);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setClosedHitId(null), NOTICE_TIMEOUT_MS);
  };

  const onResultClick = (h: HistoryHit) => {
    if (!h.projectId) return; // unknown/deleted project — row is disabled
    // The source agent may have been closed since this row was recorded. If it's gone, say so
    // rather than navigating to an empty project.
    if (!h.agentId || !agentStillExists(h.projectId, h.agentId)) {
      flashClosed(h.id);
      return;
    }
    setClosedHitId(null);
    if (h.projectId === currentId) {
      // The agent lives in this window's project — select + mount it in place, then (best-effort)
      // scroll its terminal to the matching turn.
      focusHere(h.projectId, h.agentId);
      queueScrollToHit(h);
      return;
    }
    // A different project. If a window is already showing it, that window focuses the agent;
    // otherwise open the project in a new window deep-linked to the agent (?agent= → the new
    // window selects it on mount, see windowContext).
    if (hasWindow(h.projectId)) {
      focusElsewhere(h.projectId, h.agentId);
    } else {
      routeToWindow(h.projectId, "new", h.agentId);
    }
  };

  const open = query.trim().length > 0;

  return (
    <div style={{ margin: "0 10px 8px" }}>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search history…"
        spellCheck={false}
        style={{
          width: "100%",
          boxSizing: "border-box",
          background: C.deepForest,
          color: C.cream,
          border: `1px solid ${C.forest}`,
          borderRadius: 8,
          padding: "7px 10px",
          fontSize: 13,
          fontFamily: '"IBM Plex Sans", sans-serif',
          outline: "none",
        }}
      />

      {open && (
        <div
          style={{
            marginTop: 6,
            border: `1px solid ${C.forest}`,
            borderRadius: 8,
            overflow: "hidden",
            background: C.deepForest,
          }}
        >
          {results.length === 0 ? (
            <div style={{ color: C.muted, fontSize: 12, padding: "10px 12px" }}>
              No matches in {RETENTION_LABEL[entitlement]}.
            </div>
          ) : (
            <div style={{ maxHeight: 280, overflowY: "auto" }}>
              {results.map((h) => {
                const disabled = !h.projectId;
                return (
                  <button
                    key={h.id}
                    data-testid="history-result"
                    onClick={() => onResultClick(h)}
                    disabled={disabled}
                    title={
                      disabled
                        ? "This project is no longer available"
                        : h.projectId === currentId
                          ? "Jump to this agent"
                          : "Jump to this agent in its window"
                    }
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      border: "none",
                      borderBottom: `1px solid ${C.forest}`,
                      background: "transparent",
                      color: C.cream,
                      cursor: disabled ? "default" : "pointer",
                      opacity: disabled ? 0.5 : 1,
                      padding: "8px 12px",
                      fontFamily: '"IBM Plex Sans", sans-serif',
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                      <span style={badgeStyle(h.kind)}>{h.kind}</span>
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          color: C.muted,
                          fontSize: 11,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {[h.projectName, h.agentName].filter(Boolean).join(" · ") || "—"}
                      </span>
                      <span style={{ flex: "0 0 auto", color: C.muted, fontSize: 11 }}>
                        {relativeTime(h.createdAt)}
                      </span>
                    </div>
                    <div
                      style={{
                        color: C.muted,
                        fontSize: 12,
                        lineHeight: 1.4,
                        // Clamp the snippet to two lines so a long hit can't blow out the row.
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {renderSnippet(h.snippet)}
                    </div>
                    {closedHitId === h.id && (
                      <div
                        role="alert"
                        style={{
                          marginTop: 4,
                          color: DANGER,
                          fontSize: 11,
                          fontWeight: FONT_WEIGHT.semibold,
                        }}
                      >
                        {AGENT_CLOSED_MESSAGE}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Retention caption + free-tier upsell. The buy flow is stubbed until the credit
              system lands, so the upsell is a best-effort no-op for now. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 12px",
              borderTop: `1px solid ${C.forest}`,
              color: C.muted,
              fontSize: 11,
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>
              Searching {RETENTION_LABEL[entitlement]}
            </span>
            {entitlement === "24h" && (
              <button
                onClick={() => {
                  // Stub: the real purchase flow is owned by the credit system (throws today).
                  void purchaseRetention("7d").catch(() => {});
                }}
                style={{
                  flex: "0 0 auto",
                  border: "none",
                  background: "transparent",
                  color: C.accentInk,
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: FONT_WEIGHT.semibold,
                  padding: 0,
                  fontFamily: '"IBM Plex Sans", sans-serif',
                }}
              >
                Extend history →
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
