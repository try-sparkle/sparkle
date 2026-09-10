// "By agent" — the History & Spend pane's per-agent view, plus the per-agent cap (bead ).
//
// The pane could already tell you a session id had spent $4.12. It could not tell you WHICH AGENT
// that was, and it had no cap of any kind. This section is both halves.
//
// THREE HONESTY RULES, each of which is a thing this section refuses to do:
//   • It never presents attribution as complete. Whatever the folder join could not place shows as
//     an explicit "Unattributed" row, so the rows plus that remainder always reconcile to the
//     headline total above. A per-agent table with no remainder invites the reader to believe the
//     rows are everything.
//   • It never calls an UNKNOWN cost a low one. An agent whose whole window ran on an unpriced model
//     is listed as "not costed" and is deliberately NOT reported as being within the cap.
//   • It never calls the estimate a bill. The pane's `pricingNote` (owned by Rust) already says
//     these are list-rate estimates and that a subscription bills no per-token cost; the cap copy
//     here says "estimated" for the same reason and must keep saying it.
import { useMemo, useState, type CSSProperties } from "react";
import { C, DANGER } from "../theme/colors";
import { RADIUS, SPACE, TYPE } from "../theme/scale";
import { SECTION_LABEL } from "./labelTreatment";
import type { SpendReport } from "../services/spendApi";
import {
  attributeSpendToAgents,
  evaluateSpendCap,
  NEAR_FRACTION,
  normalizeCapUsd,
  type AgentIdentity,
  type AgentSpendRow,
} from "../engine/agentSpend";
import { costCell, formatTokens, formatUsd, shortDate } from "./spendFormat";

export function AgentSpendSection({
  report,
  roster,
  capUsd,
  onCapChange,
}: {
  report: SpendReport;
  roster: AgentIdentity[];
  capUsd: number | null;
  onCapChange: (value: number | null) => void;
}) {
  const breakdown = useMemo(
    () => attributeSpendToAgents(report, roster),
    [report, roster],
  );
  const verdict = useMemo(
    () => evaluateSpendCap(breakdown.rows, capUsd),
    [breakdown.rows, capUsd],
  );

  const hasRemainder = breakdown.unattributed.totalTokens > 0;

  return (
    <section data-testid="agent-spend-section">
      <div style={subLabel}>By agent</div>

      <CapControl capUsd={capUsd} onCapChange={onCapChange} />

      {verdict.state === "over" && (
        <div data-testid="agent-spend-cap-banner" style={{ ...banner, color: DANGER }}>
          {describeAgents(verdict.over)} past the {formatUsd(verdict.capUsd ?? 0)} estimated-spend
          cap for this {report.windowDays}-day window. Nothing has been stopped — this is a warning,
          not a limit.
        </div>
      )}
      {verdict.state === "near" && (
        <div data-testid="agent-spend-cap-banner" style={{ ...banner, color: C.amber }}>
          {describeAgents(verdict.near)} past {Math.round(NEAR_FRACTION * 100)}% of the{" "}
          {formatUsd(verdict.capUsd ?? 0)} estimated-spend cap for this {report.windowDays}-day
          window.
        </div>
      )}
      {verdict.unjudged.length > 0 && (
        <div data-testid="agent-spend-cap-unjudged" style={{ ...banner, color: C.amber }}>
          {describeAgents(verdict.unjudged)} spent only on models with no published price, so their
          cost is unknown and the cap cannot be applied to them.
        </div>
      )}

      {breakdown.rows.length === 0 ? (
        <div data-testid="agent-spend-empty" style={hint}>
          No spend in this window could be matched to an agent. Agents are matched by the folder name
          of their worktree, so usage from a plain terminal session never appears here.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={table}>
            <thead>
              <tr>
                {["Agent", "Project", "Sessions", "Turns", "Total", "Est. cost", "Last active"].map(
                  (h, i) => (
                    <th key={h} style={{ ...th, textAlign: i === 0 ? "left" : "right" }}>
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {breakdown.rows.map((row) => (
                <AgentRow
                  key={row.agentId}
                  row={row}
                  over={verdict.over.includes(row)}
                  near={verdict.near.includes(row)}
                />
              ))}
              {hasRemainder && (
                <tr data-testid="agent-spend-unattributed">
                  <td style={{ ...td, textAlign: "left", color: C.muted }} title={UNATTRIBUTED_HINT}>
                    Unattributed
                  </td>
                  <td style={{ ...td, textAlign: "right", color: C.muted }}>—</td>
                  <td style={{ ...td, textAlign: "right", color: C.muted }}>—</td>
                  <td style={{ ...td, textAlign: "right", color: C.muted }}>
                    {formatTokens(breakdown.unattributed.messages)}
                  </td>
                  <td style={{ ...td, textAlign: "right", color: C.muted }}>
                    {formatTokens(breakdown.unattributed.totalTokens)}
                  </td>
                  <td style={{ ...td, textAlign: "right", color: C.muted }}>
                    {costCell(
                      breakdown.unattributed.estimatedCostUsd,
                      breakdown.unattributed.unpricedTokens,
                    ) ?? "—"}
                  </td>
                  <td style={{ ...td, textAlign: "right", color: C.muted }}>—</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {breakdown.ambiguousFolders.length > 0 && (
        <div data-testid="agent-spend-ambiguous" style={footnote}>
          {breakdown.ambiguousFolders.length === 1 ? "One folder is" : "Some folders are"} claimed by
          more than one agent ({breakdown.ambiguousFolders.join(", ")}), so that usage is counted as
          unattributed rather than guessed at.
        </div>
      )}
    </section>
  );
}

const UNATTRIBUTED_HINT =
  "Everything in the window that no single agent could be matched to: plain terminal sessions, " +
  "deleted agents, and worktree folders claimed by more than one agent.";

/** "Foo is" / "Foo and Bar are" / "Foo, Bar and 3 others are" — a subject with its verb attached. */
function describeAgents(rows: AgentSpendRow[]): string {
  const names = rows.map((r) => r.name);
  if (names.length === 0) return "No agent is";
  if (names.length === 1) return `${names[0]} is`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are`;
  const rest = names.length - 2;
  return `${names[0]}, ${names[1]} and ${rest} other${rest === 1 ? "" : "s"} are`;
}

function AgentRow({
  row,
  over,
  near,
}: {
  row: AgentSpendRow;
  over: boolean;
  near: boolean;
}) {
  const cost = costCell(row.estimatedCostUsd, row.unpricedTokens);
  const costColor = over ? DANGER : near ? C.amber : undefined;
  return (
    <tr data-testid={`agent-spend-row-${row.agentId}`}>
      <td style={{ ...td, textAlign: "left" }} title={row.folder}>
        {row.name}
      </td>
      <td style={{ ...td, textAlign: "right", color: C.muted }}>{row.projectName}</td>
      <td style={{ ...td, textAlign: "right" }}>{formatTokens(row.sessions)}</td>
      <td style={{ ...td, textAlign: "right" }}>{formatTokens(row.messages)}</td>
      <td style={{ ...td, textAlign: "right" }}>{formatTokens(row.totalTokens)}</td>
      <td
        data-testid={`agent-spend-cost-${row.agentId}`}
        style={{ ...td, textAlign: "right", color: costColor }}
        title={cost === null ? "No published price for the models this agent used" : undefined}
      >
        {cost ?? "not costed"}
      </td>
      <td style={{ ...td, textAlign: "right", color: C.muted }}>{shortDate(row.lastActive)}</td>
    </tr>
  );
}

/**
 * The cap input. Held as a DRAFT string rather than written through on every keystroke: typing
 * "10" passes through "1", and committing that would flash a $1 cap that says every agent is over.
 */
function CapControl({
  capUsd,
  onCapChange,
}: {
  capUsd: number | null;
  onCapChange: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (capUsd === null ? "" : String(capUsd));

  const commit = () => {
    const text = (draft ?? "").trim();
    setDraft(null);
    if (draft === null) return;
    onCapChange(text === "" ? null : normalizeCapUsd(Number(text)));
  };

  return (
    <div style={capRow}>
      <label htmlFor="agent-spend-cap" style={capLabel}>
        Per-agent cap
      </label>
      <input
        id="agent-spend-cap"
        type="number"
        min={0}
        step="0.01"
        inputMode="decimal"
        placeholder="Off"
        aria-label="Per-agent estimated spend cap in US dollars"
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        style={capInput}
      />
      <span style={hint}>
        {capUsd === null
          ? "No cap. Set one in USD to be warned when an agent's estimated spend passes it."
          : "A warning only — reaching it does not stop or pause anything."}
      </span>
    </div>
  );
}

// ── styles (inline CSSProperties, matching SpendPane's convention) ──────────────────────────

const subLabel: CSSProperties = { ...SECTION_LABEL, marginBottom: SPACE.sm };

const capRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: SPACE.sm,
  flexWrap: "wrap",
  marginBottom: SPACE.sm,
};

const capLabel: CSSProperties = { ...SECTION_LABEL };

const capInput: CSSProperties = {
  width: 88,
  fontSize: TYPE.small,
  color: C.cream,
  // The FIELD tokens, not the shell's. `modalChrome.test.ts` ratchets the population of field
  // styles still borrowing `forest`/`hairline` downwards, so a new input reaching for the shell's
  // ground is a regression the suite catches by name.
  background: C.inputSurface,
  border: `1px solid ${C.inputEdge}`,
  borderRadius: RADIUS.input,
  padding: "4px 6px",
  fontVariantNumeric: "tabular-nums",
};

const banner: CSSProperties = {
  fontSize: TYPE.small,
  lineHeight: 1.5,
  marginBottom: SPACE.sm,
};

const hint: CSSProperties = {
  fontSize: TYPE.small,
  color: C.muted,
  lineHeight: 1.5,
};

const footnote: CSSProperties = {
  fontSize: TYPE.small,
  color: C.muted,
  lineHeight: 1.5,
  marginTop: SPACE.xs,
};

const table: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: TYPE.small,
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
