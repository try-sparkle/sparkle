import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { FiRefreshCw } from "react-icons/fi";
import { C, DANGER } from "../theme/colors";
import { FONT_WEIGHT } from "@sparkle/ui";
import { FONT_MONO, FONT_UI, RADIUS } from "../theme/scale";
import { SECTION_LABEL, tag } from "./labelTreatment";
import {
  fetchSpendReport,
  type Bucket,
  type SpendReport,
} from "../services/spendApi";
import {
  axisLabelIndexes,
  barPercent,
  costCell,
  formatTokens,
  formatUsd,
  maxDaily,
  shortDate,
} from "./spendFormat";

// Settings → History & Spend: a local-first read of what your agents have actually spent.
//
// Everything on screen comes from ONE Tauri call (`spend_report`), which reads Claude Code's own
// session transcripts on this machine. Nothing here talks to the network, and nothing should:
// this pane is also the substrate for a future OPT-IN Builder Index (tkmx) reporter, which would
// summarize the same report behind its own consent gate rather than adding egress here.
//
// The honesty rules this pane is built around:
//   • Cost is an ESTIMATE at list API rates. The caveat text is owned by Rust (`pricingNote`) and
//     rendered verbatim, so the words can't drift from the arithmetic.
//   • A model with no published rate contributes TOKENS but no cost. Those rows render "—", never
//     "$0.00", and the totals row says how many tokens are unpriced.
//   • A scan cut short by the file cap says so.
//
// No chart library: the repo has none, and a 28-column bar chart is a flex row of divs.

/** Selectable trailing windows. 28 days is the default — it's the Builder Index's own window. */
const WINDOWS = [7, 28, 90] as const;
const DEFAULT_WINDOW = 28;

/** Rust rejections are raw strings; JS-side throws are Errors. Render both the same way. */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type PaneState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; report: SpendReport };

export function SpendPane() {
  const [windowDays, setWindowDays] = useState<number>(DEFAULT_WINDOW);
  const [state, setState] = useState<PaneState>({ kind: "loading" });

  // Monotonic epoch so a window switch mid-flight can't be repainted by the slower earlier scan.
  const epoch = useRef(0);
  const load = useCallback(async (days: number) => {
    const mine = ++epoch.current;
    setState({ kind: "loading" });
    try {
      const report = await fetchSpendReport(days);
      if (mine !== epoch.current) return;
      setState({ kind: "ready", report });
    } catch (e) {
      if (mine !== epoch.current) return;
      setState({ kind: "error", message: errorMessage(e) });
    }
  }, []);

  useEffect(() => {
    void load(windowDays);
  }, [load, windowDays]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 6 }}>
          {WINDOWS.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={d === windowDays}
              onClick={() => setWindowDays(d)}
              style={{
                ...chipBtn,
                color: d === windowDays ? C.cream : C.muted,
                borderColor: d === windowDays ? C.accentInk : C.muted,
              }}
            >
              {d} days
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label="Refresh spend"
          title="Rescan transcripts"
          style={iconBtn}
          onClick={() => void load(windowDays)}
        >
          <FiRefreshCw size={13} />
        </button>
      </div>

      {state.kind === "loading" && <div style={hint}>Reading local transcripts…</div>}

      {state.kind === "error" && (
        <div style={panel}>
          <div style={errorText}>Couldn&apos;t read spend: {state.message}</div>
          <button type="button" style={actionBtn} onClick={() => void load(windowDays)}>
            <FiRefreshCw size={13} />
            Retry
          </button>
        </div>
      )}

      {state.kind === "ready" && <Report report={state.report} />}
    </div>
  );
}

function Report({ report }: { report: SpendReport }) {
  const empty = report.totals.tokens.total === 0;
  return (
    <>
      <Totals totals={report.totals} />

      <section>
        <div style={subLabel}>Daily tokens</div>
        {empty ? (
          <div style={{ ...panel, ...hint }}>
            No Claude Code usage in the last {report.windowDays} days
            {report.roots.length > 0 ? ` under ${report.roots.join(", ")}` : ""}.
          </div>
        ) : (
          <DailyChart days={report.days} />
        )}
      </section>

      {report.models.length > 0 && (
        <section>
          <div style={subLabel}>By model</div>
          <Table
            head={["Model", "Turns", "In", "Out", "Cache w/r", "Total", "Est. cost"]}
            rows={report.models.map((m) => ({
              key: m.model,
              cells: [
                <span key="n" style={nameCell}>
                  {m.model}
                  {!m.priced && (
                    <span style={unpricedTag} title="No published price for this model">
                      unpriced
                    </span>
                  )}
                </span>,
                formatTokens(m.messages),
                formatTokens(m.tokens.input),
                formatTokens(m.tokens.output),
                `${formatTokens(m.tokens.cacheCreation)} / ${formatTokens(m.tokens.cacheRead)}`,
                formatTokens(m.tokens.total),
                costCell(m.estimatedCostUsd, m.unpricedTokens) ?? "—",
              ],
            }))}
          />
        </section>
      )}

      {report.projects.length > 0 && (
        <section>
          <div style={subLabel}>By project</div>
          <Table
            head={["Project", "Sessions", "Turns", "Total", "Est. cost", "Last active"]}
            rows={report.projects.map((p) => ({
              key: p.project,
              cells: [
                <span key="n" style={nameCell}>
                  {p.project}
                </span>,
                formatTokens(p.sessions),
                formatTokens(p.messages),
                formatTokens(p.tokens.total),
                costCell(p.estimatedCostUsd, p.unpricedTokens) ?? "—",
                shortDate(p.lastActive),
              ],
            }))}
          />
        </section>
      )}

      {report.sessions.length > 0 && (
        <section>
          <div style={subLabel}>Heaviest sessions</div>
          <Table
            head={["Session", "Project", "Turns", "Total", "Est. cost", "Last active"]}
            rows={report.sessions.map((s) => ({
              key: s.sessionId,
              cells: [
                // Session ids are uuids — show a readable prefix, full id on hover.
                <span key="n" style={monoCell} title={s.sessionId}>
                  {s.sessionId.slice(0, 8)}
                </span>,
                s.project,
                formatTokens(s.messages),
                formatTokens(s.tokens.total),
                costCell(s.estimatedCostUsd, s.unpricedTokens) ?? "—",
                shortDate(s.lastActive),
              ],
            }))}
          />
        </section>
      )}

      <Footnotes report={report} />
    </>
  );
}

/** The headline row: tokens, estimated cost, billed turns, cache reads. */
function Totals({ totals }: { totals: Bucket }) {
  // The headline cost obeys the same rule as every table cell: a window whose usage was ENTIRELY
  // on unpriced models has an UNKNOWN cost, not a zero one. Rendering "$0.00" there would be the
  // single most misleading number on the pane.
  const cost = costCell(totals.estimatedCostUsd, totals.unpricedTokens);
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
      <Stat id="tokens" label="Tokens" value={formatTokens(totals.tokens.total)} />
      <Stat
        id="cost"
        label="Est. cost"
        value={cost ?? "—"}
        accent
        title={cost === null ? "No published price for the models used" : undefined}
      />
      <Stat id="turns" label="Turns" value={formatTokens(totals.messages)} />
      <Stat
        id="cache-read"
        label="Cache read"
        value={formatTokens(totals.tokens.cacheRead)}
        title="Cached input tokens — billed at 0.1× the input rate"
      />
    </div>
  );
}

function Stat({
  id,
  label,
  value,
  accent,
  title,
}: {
  id: string;
  label: string;
  value: string;
  accent?: boolean;
  title?: string;
}) {
  return (
    <div data-testid={`spend-stat-${id}`} style={statBox} title={title}>
      <div style={statValue(accent)}>{value}</div>
      <div style={statLabel}>{label}</div>
    </div>
  );
}

/** Bar chart with no chart library: one flex column per day, height as a % of the busiest day. */
function DailyChart({ days }: { days: SpendReport["days"] }) {
  const max = maxDaily(days);
  const labelled = axisLabelIndexes(days.length);
  return (
    <div style={panel}>
      <div style={{ alignSelf: "stretch" }}>
        <div style={chartMax}>peak {formatTokens(max)} / day</div>
        <div style={chartRow} role="img" aria-label={`Daily tokens for the last ${days.length} days`}>
          {days.map((d) => (
            <div
              key={d.date}
              data-testid="spend-bar"
              // The title IS the accessible detail for a given day — a bar chart of divs has no
              // other affordance, and per-day numbers are the whole point of the column.
              title={`${d.date}: ${formatTokens(d.tokens.total)} tokens · ${formatUsd(d.estimatedCostUsd)}`}
              style={barTrack}
            >
              <div
                style={{
                  ...bar,
                  height: `${barPercent(d.tokens.total, max)}%`,
                  // A zero day paints nothing rather than a stub that reads as light usage.
                  background: d.tokens.total > 0 ? C.teal : "transparent",
                }}
              />
            </div>
          ))}
        </div>
        <div style={chartAxis}>
          {days.map((d, i) => (
            <div key={d.date} style={axisCell}>
              {labelled.has(i) ? shortDate(d.date) : ""}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The estimates caveat plus anything that would otherwise make a number quietly misleading. */
function Footnotes({ report }: { report: SpendReport }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {report.truncated && (
        <div style={warnText}>
          This scan hit its file limit, so the numbers below cover only part of your history.
        </div>
      )}
      {report.totals.unpricedTokens > 0 && (
        <div style={warnText}>
          {formatTokens(report.totals.unpricedTokens)} tokens came from models with no published
          price ({report.unknownModels.join(", ")}) and are counted but not costed.
        </div>
      )}
      <div style={footnote}>{report.pricingNote}</div>
      <div style={footnote}>
        Read locally from {formatTokens(report.filesScanned)} transcript
        {report.filesScanned === 1 ? "" : "s"}. Nothing on this pane leaves your machine.
      </div>
    </div>
  );
}

/** Small read-only table. First column is the name (left, flexible); the rest are right-aligned. */
function Table({
  head,
  rows,
}: {
  head: string[];
  rows: { key: string; cells: ReactNode[] }[];
}) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={table}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={h} style={{ ...th, textAlign: i === 0 ? "left" : "right" }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              {r.cells.map((cell, i) => (
                <td key={i} style={{ ...td, textAlign: i === 0 ? "left" : "right" }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── styles (inline CSSProperties, matching SettingsDialog's convention) ─────────────────────

const subLabel: CSSProperties = { ...SECTION_LABEL, marginBottom: 8 };

const panel: CSSProperties = {
  background: C.forest,
  border: `1px solid ${C.hairline}`,
  borderRadius: 6,
  padding: "14px 16px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  alignItems: "flex-start",
};

const hint: CSSProperties = {
  fontSize: 12,
  color: C.muted,
  lineHeight: 1.5,
};

const footnote: CSSProperties = {
  fontSize: 12,
  color: C.muted,
  lineHeight: 1.5,
};

const warnText: CSSProperties = {
  fontSize: 12,
  color: C.amber,
  lineHeight: 1.5,
};

const errorText: CSSProperties = {
  fontSize: 12,
  color: DANGER,
  lineHeight: 1.5,
};

const statBox: CSSProperties = {
  flex: "1 1 96px",
  minWidth: 96,
  background: C.forest,
  borderRadius: 6,
  padding: "10px 12px",
};

const statValue = (accent?: boolean): CSSProperties => ({
  fontSize: 17,
  fontWeight: FONT_WEIGHT.semibold,
  color: accent ? C.accentInk : C.cream,
  fontVariantNumeric: "tabular-nums",
  lineHeight: 1.2,
});

const statLabel: CSSProperties = { ...SECTION_LABEL, marginTop: 3 };

const chartMax: CSSProperties = {
  fontSize: 10,
  color: C.muted,
  marginBottom: 6,
};

const chartRow: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 2,
  height: 96,
};

const barTrack: CSSProperties = {
  flex: 1,
  minWidth: 2,
  height: "100%",
  display: "flex",
  alignItems: "flex-end",
};

const bar: CSSProperties = {
  width: "100%",
  borderRadius: 3,
  minHeight: 0,
};

const chartAxis: CSSProperties = {
  display: "flex",
  gap: 2,
  marginTop: 5,
};

const axisCell: CSSProperties = {
  flex: 1,
  minWidth: 2,
  fontSize: 10,
  color: C.muted,
  textAlign: "center",
  whiteSpace: "nowrap",
  overflow: "visible",
};

const table: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 12,
  fontVariantNumeric: "tabular-nums",
};

const th: CSSProperties = {
  ...SECTION_LABEL,
  padding: "6px 8px",
  borderBottom: `1px solid ${C.hairline}`,
  whiteSpace: "nowrap",
};

const td: CSSProperties = {
  padding: "6px 8px",
  color: C.cream,
  borderBottom: `1px solid ${C.hairline}`,
  whiteSpace: "nowrap",
};

const nameCell: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  maxWidth: 220,
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const monoCell: CSSProperties = {
  fontFamily: FONT_MONO,
};

const unpricedTag: CSSProperties = { ...tag(C.amber), flex: "none" };

const chipBtn: CSSProperties = {
  background: "transparent",
  border: `1px solid ${C.muted}`,
  borderRadius: RADIUS.input,
  padding: "4px 11px",
  cursor: "pointer",
  fontSize: 12,
  fontFamily: FONT_UI,
};

const iconBtn: CSSProperties = {
  display: "grid",
  placeItems: "center",
  background: "transparent",
  border: "none",
  color: C.muted,
  cursor: "pointer",
  padding: 4,
  borderRadius: 6,
};

const actionBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: "7px 12px",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: FONT_UI,
};
