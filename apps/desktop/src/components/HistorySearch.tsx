// HistorySearch — the full-text search box under the Brainstorm/Build buttons in AgentSidebar.
// Presentational: it binds the input to the historyStore (which owns the debounce + the Tauri
// `history_search` call) and renders the ranked results. Clicking a result opens its source —
// in place when it's the current window's project, in a new Sparkle window otherwise.
import type { CSSProperties, ReactNode } from "react";
import { C, FONT_WEIGHT } from "../theme/colors";
import { useHistoryStore } from "../stores/historyStore";
import { useProjectStore } from "../stores/projectStore";
import type { HistoryHit, RetentionTier } from "../services/history";
import { purchaseRetention } from "../services/credits";
import {
  openProjectInWindow,
  defaultDeps,
  type OpenMode,
} from "../services/projectWindows";

interface HistorySearchProps {
  /** Route a hit's project into a window. Injected in tests; defaults to the real Tauri wiring.
   *  Only ever called with mode `"new"` (a result in a DIFFERENT project than this window's). */
  openInWindow?: (projectId: string, mode: OpenMode) => void;
  /** This window's current project id. Injected in tests; defaults to the store's selection. */
  currentProjectId?: string | null;
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
  color: C.cream,
  background: kind === "prompt" ? C.accentMid : C.teal,
});

export function HistorySearch({ openInWindow, currentProjectId }: HistorySearchProps = {}) {
  const query = useHistoryStore((s) => s.query);
  const results = useHistoryStore((s) => s.results);
  const entitlement = useHistoryStore((s) => s.entitlement);
  const setQuery = useHistoryStore((s) => s.setQuery);
  const storeSelectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const touchProjectOpened = useProjectStore((s) => s.touchProjectOpened);

  // Prefer the injected current project id (tests); otherwise this window's store selection.
  const currentId = currentProjectId !== undefined ? currentProjectId : storeSelectedProjectId;

  // Real cross-project router. The "new" path of openProjectInWindow never touches
  // replaceCurrent/currentLabel (only the in-place "replace" path does), so the dummies below are
  // safe — and this component renders fine outside CurrentProjectProvider (e.g. in AgentSidebar
  // tests) because it depends on no window context.
  const routeToWindow =
    openInWindow ??
    ((projectId: string, mode: OpenMode) => {
      void openProjectInWindow(
        projectId,
        mode,
        defaultDeps(
          () => {}, // replaceCurrent — unused on the "new" path
          touchProjectOpened,
          "main", // currentLabel — unused on the "new" path
        ),
      );
    });

  const onResultClick = (h: HistoryHit) => {
    if (!h.projectId) return; // unknown/deleted project — row is disabled
    if (h.projectId === currentId) {
      // Already this window's project — it's on screen. Deep-linking to the specific agent is a
      // v1 non-goal (the source agent may no longer exist), so there's nothing to route.
      return;
    }
    routeToWindow(h.projectId, "new");
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
                          ? "Open in this window"
                          : "Open in a new window"
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
