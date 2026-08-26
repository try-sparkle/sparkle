// VerifyGatePanel — what the verify-before-PR gate looks like (bead `.1`).
//
// One row per check: its name, the command that ran, the outcome, and how long it took. Then the
// evidence strip, then the PR-gate sentence. The panel's job is to make a claim CHECKABLE, so
// everything it shows is something the report actually recorded — there is no summary line here
// that is not derived from a check.
//
// ── THREE OUTCOMES, NOT TWO, AND THE PAINT HAS TO SAY SO ────────────────────────────────────────
// A check that TIMED OUT or could NOT BE STARTED judged nothing. Painting it red next to a real
// test failure tells the reader to go and read their diff, which is exactly wrong — the same
// distinction `scripts/pr-checks.sh` draws between its exit 1 ("judged; here is where to look") and
// its exit 5 ("never ran; stop reading your diff"). So an unjudged check gets the caution ink and a
// different glyph from a failing one, and the verdict line for a `not-run` report says the checks
// did not run rather than that anything failed.
//
// ── NO EMOJI ICONS (founder's standing rule) ────────────────────────────────────────────────────
// Every glyph is `react-icons/fi` (Feather). Status is carried by an icon AND a word, never by
// colour alone — a red/green dot is unreadable to a colour-blind reader and invisible in a
// screenshot pasted into a PR.
//
// ── IT RENDERS FROM THE STORE, NEVER FROM `invoke` ──────────────────────────────────────────────
// Every backend call goes through `services/verifyGate`, so this component is renderable in jsdom
// by seeding `verifyGateStore` — the split `services/preview` uses, for the reason stated there: a
// component that invokes directly cannot be tested at all without a bridge mock, so the tests that
// would catch a regression stop being written.
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import {
  FiAlertTriangle,
  FiCheck,
  FiClock,
  FiHelpCircle,
  FiImage,
  FiPaperclip,
  FiPlay,
  FiRefreshCw,
  FiX,
} from "react-icons/fi";
import { C } from "../theme/colors";
import { FONT_UI, RADIUS, SPACE, TYPE, WEIGHT } from "../theme/scale";
import { SECTION_LABEL } from "./labelTreatment";
import {
  entryFor,
  humanMs,
  statusLabel,
  useVerifyGateStore,
  verdictLabel,
  type CheckResult,
  type CheckStatus,
  type EvidenceItem,
} from "../stores/verifyGateStore";
import {
  fetchVerifyGateReport,
  fetchVerifyGateStatus,
  runVerifyGate,
  verifyGateTestingMarkdown,
} from "../services/verifyGate";

/** Hooks a real-layout or integration test can find the panel by. */
export const VERIFY_GATE_PANEL_TESTID = "verify-gate-panel";
export const VERIFY_GATE_ROW_TESTID = "verify-gate-check-row";

export interface VerifyGatePanelProps {
  /** The repo root whose `.sparkle/verify-gate/` holds the reports. */
  projectRoot: string;
  agentId: string;
  /** The tree the checks run INSIDE — an agent's worktree, not the project root. */
  worktree: string;
}

/** Icon + ink for one check status.
 *
 *  `timeout` and `not-run` share the CAUTION ink and a distinct glyph from `fail`, because they are
 *  a different fact: see the header. `C.amberInk` rather than `C.dangerInk` is the whole point. */
function statusPaint(status: CheckStatus): { Icon: typeof FiCheck; ink: string } {
  switch (status) {
    case "pass":
      return { Icon: FiCheck, ink: C.successInk };
    case "fail":
      return { Icon: FiX, ink: C.dangerInk };
    case "timeout":
      return { Icon: FiClock, ink: C.amberInk };
    case "not-run":
      return { Icon: FiHelpCircle, ink: C.amberInk };
  }
}

function CheckRow({ check }: { check: CheckResult }) {
  const { Icon, ink } = statusPaint(check.status);
  const [open, setOpen] = useState(false);
  const hasTail = check.tail.trim().length > 0;
  return (
    <div data-testid={VERIFY_GATE_ROW_TESTID} data-status={check.status} style={rowWrap}>
      <div style={row}>
        <Icon aria-hidden size={14} style={{ color: ink, flex: "0 0 auto" }} />
        <span style={{ ...checkName, color: C.cream }}>{check.name}</span>
        <code style={cmdText}>{check.cmd}</code>
        <span style={{ ...statusText, color: ink }}>{statusLabel(check.status)}</span>
        <span style={durationText}>{humanMs(check.durationMs)}</span>
      </div>
      {hasTail && (
        <button type="button" style={tailToggle} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide output" : "Show output"}
        </button>
      )}
      {hasTail && open && <pre style={tailBox}>{check.tail}</pre>}
    </div>
  );
}

function EvidenceStrip({ items }: { items: EvidenceItem[] }) {
  if (items.length === 0) {
    return (
      <p style={quietHint}>
        No evidence attached yet. Screenshots, recordings and log tails captured for this run appear
        here and are embedded in the PR&apos;s Testing section.
      </p>
    );
  }
  return (
    <ul style={evidenceList}>
      {items.map((e) => {
        const Icon = e.kind === "image" ? FiImage : FiPaperclip;
        return (
          <li key={e.id} style={evidenceItem} data-testid="verify-gate-evidence">
            <Icon aria-hidden size={13} style={{ color: C.muted, flex: "0 0 auto" }} />
            {/* An uncaptioned artifact still shows — dropping it would lose proof over a missing
                string, which is the opposite of what this panel is for. */}
            <span style={{ color: C.cream }}>{e.caption || `evidence ${e.id}`}</span>
            <span style={{ color: C.muted }}>{e.fileName}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function VerifyGatePanel({ projectRoot, agentId, worktree }: VerifyGatePanelProps) {
  const entry = useVerifyGateStore((s) => entryFor(s, agentId));
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  // One status read on mount, so a panel opened after a run in another window shows that run
  // rather than "never run". Deliberately not a poll: this panel is opened deliberately, and a
  // background poll on every mounted agent would run the whole fleet's worth of file reads.
  useEffect(() => {
    void fetchVerifyGateStatus(projectRoot, agentId);
    void fetchVerifyGateReport(projectRoot, agentId).catch(() => {
      // A missing report is the normal first-run state, not an error worth surfacing — the panel
      // already says "never run" for it.
    });
  }, [projectRoot, agentId]);

  const onRun = useCallback(() => {
    void runVerifyGate(projectRoot, agentId, worktree).catch(() => {
      // The failure is already in the store's `error`; swallowing here keeps an unhandled rejection
      // out of the console without hiding anything from the user.
    });
  }, [projectRoot, agentId, worktree]);

  const onCopyMarkdown = useCallback(async () => {
    setCopied(false);
    setCopyFailed(false);
    const md = await verifyGateTestingMarkdown(projectRoot, agentId);
    // NEVER substitute a hand-written section for a missing report. A Testing section claiming
    // verification that never happened is precisely the failure this feature exists to end.
    if (!md) {
      setCopyFailed(true);
      return;
    }
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
    } catch {
      setCopyFailed(true);
    }
  }, [projectRoot, agentId]);

  const report = entry.report;
  const verdict = report?.verdict ?? null;
  const verdictInk =
    verdict === "pass" ? C.successInk : verdict === "fail" ? C.dangerInk : C.amberInk;

  return (
    <section data-testid={VERIFY_GATE_PANEL_TESTID} style={panel} aria-label="Verify before PR">
      <div style={header}>
        <span style={SECTION_LABEL}>Verify before PR</span>
        <div style={{ display: "flex", gap: SPACE.sm, alignItems: "center" }}>
          <button
            type="button"
            style={primaryBtn}
            onClick={onRun}
            disabled={entry.running}
            aria-label="Run checks"
          >
            {entry.running ? (
              <FiRefreshCw aria-hidden size={13} />
            ) : (
              <FiPlay aria-hidden size={13} />
            )}
            {entry.running ? "Running…" : "Run checks"}
          </button>
          <button
            type="button"
            style={smallBtn}
            onClick={() => void onCopyMarkdown()}
            disabled={!report}
            aria-label="Copy Testing section"
          >
            Copy Testing section
          </button>
        </div>
      </div>

      <p style={{ ...verdictLine, color: verdictInk }} data-testid="verify-gate-verdict">
        {verdictLabel(verdict)}
        {report && (
          <span style={{ color: C.muted, fontWeight: WEIGHT.med }}>
            {" · "}
            {report.branch ?? "(detached)"}
            {" · "}
            {report.checks.filter((c) => c.status === "pass").length}/{report.checks.length} passed
          </span>
        )}
      </p>

      {entry.error && (
        // A COMMAND failure, not a check failure. Said differently on purpose: "we could not run
        // the gate" is not "the gate says no", and conflating them sends the reader to their diff.
        <p style={{ ...quietHint, color: C.dangerInk }} role="alert">
          <FiAlertTriangle aria-hidden size={13} /> Couldn&apos;t run the gate: {entry.error}
        </p>
      )}

      {report && report.checks.length === 0 && (
        <p style={{ ...quietHint, color: C.amberInk }}>
          No checks were configured or discovered for this project, so nothing was verified. Set
          <code style={inlineCode}>[verify_gate].checks</code> in
          <code style={inlineCode}>.sparkle/config.toml</code>.
        </p>
      )}

      {report?.checks.map((c) => <CheckRow key={c.name} check={c} />)}

      {!report && !entry.running && (
        <p style={quietHint}>
          These checks have never been run for this agent. Running them here means CI is green
          before the PR exists — and the report becomes the PR&apos;s Testing section.
        </p>
      )}

      <div style={{ marginTop: SPACE.sm }}>
        <span style={SECTION_LABEL}>Evidence</span>
        <EvidenceStrip items={entry.evidence} />
      </div>

      {entry.prGate.enforced && (
        <p
          style={{ ...quietHint, color: entry.prGate.allowed ? C.successInk : C.amberInk }}
          data-testid="verify-gate-pr-decision"
        >
          {entry.prGate.allowed ? "PR gate: clear to open. " : "PR gate: blocked. "}
          {entry.prGate.reason}
        </p>
      )}

      {copied && <p style={quietHint}>Testing section copied to the clipboard.</p>}
      {copyFailed && (
        <p style={{ ...quietHint, color: C.dangerInk }} role="alert">
          Couldn&apos;t copy — run the checks first, so there is a real report to copy.
        </p>
      )}
    </section>
  );
}

const panel: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: SPACE.xs,
  fontFamily: FONT_UI,
  fontSize: TYPE.body,
};

const header: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: SPACE.sm,
};

const verdictLine: CSSProperties = {
  margin: 0,
  fontSize: TYPE.body,
  fontWeight: WEIGHT.bold,
};

const rowWrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: SPACE.xs,
  paddingTop: SPACE.xs,
  paddingBottom: SPACE.xs,
  borderTop: `1px solid ${C.hairline}`,
};

const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: SPACE.sm,
  minWidth: 0,
};

const checkName: CSSProperties = {
  fontWeight: WEIGHT.med,
  flex: "0 0 auto",
};

const cmdText: CSSProperties = {
  color: C.muted,
  fontSize: TYPE.small,
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const statusText: CSSProperties = {
  fontSize: TYPE.small,
  fontWeight: WEIGHT.med,
  flex: "0 0 auto",
};

const durationText: CSSProperties = {
  color: C.muted,
  fontSize: TYPE.small,
  flex: "0 0 auto",
};

const tailToggle: CSSProperties = {
  alignSelf: "flex-start",
  background: "transparent",
  border: "none",
  color: C.muted,
  cursor: "pointer",
  fontFamily: FONT_UI,
  fontSize: TYPE.small,
  padding: 0,
};

const tailBox: CSSProperties = {
  background: C.inputSurface,
  border: `1px solid ${C.inputEdge}`,
  borderRadius: RADIUS.input,
  color: C.cream,
  fontSize: TYPE.small,
  margin: 0,
  maxHeight: 240,
  overflow: "auto",
  padding: SPACE.sm,
  whiteSpace: "pre-wrap",
};

const quietHint: CSSProperties = {
  color: C.muted,
  fontSize: TYPE.small,
  margin: 0,
  display: "flex",
  alignItems: "center",
  gap: SPACE.xs,
  flexWrap: "wrap",
};

const inlineCode: CSSProperties = {
  color: C.cream,
  fontSize: TYPE.small,
};

const evidenceList: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: SPACE.xs,
  listStyle: "none",
  margin: 0,
  padding: 0,
  fontSize: TYPE.small,
};

const evidenceItem: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: SPACE.sm,
  minWidth: 0,
};

const primaryBtn: CSSProperties = {
  alignItems: "center",
  background: C.teal,
  border: "none",
  borderRadius: RADIUS.input,
  color: C.onFillInk,
  cursor: "pointer",
  display: "flex",
  fontFamily: FONT_UI,
  fontSize: TYPE.small,
  fontWeight: WEIGHT.med,
  gap: SPACE.xs,
  padding: `${SPACE.xs}px ${SPACE.row}px`,
};

const smallBtn: CSSProperties = {
  background: "transparent",
  border: `1px solid ${C.inputEdge}`,
  borderRadius: RADIUS.input,
  color: C.cream,
  cursor: "pointer",
  fontFamily: FONT_UI,
  fontSize: TYPE.small,
  padding: `${SPACE.xs}px ${SPACE.row}px`,
};
