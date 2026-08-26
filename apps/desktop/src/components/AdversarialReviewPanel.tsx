// ── THE ADVERSARIAL REVIEW PANEL (bead `.4`) ────────────────────────────────────────
//
// What an independent reviewer said about this branch's diff, and whether that answer is still
// about the commit you are looking at.
//
// THE STALENESS BANNER IS THE POINT OF THIS SURFACE, not decoration. A verdict is a statement about
// ONE commit, and the moment you push again it stops being a statement about your branch — while
// still rendering as a big green "ship". That is the exact shape of a reassuring lie, so a stale
// record renders its banner FIRST, above the verdict, and the verdict row is dimmed behind it.
//
// `unknown` IS RENDERED AS A REAL, VISIBLE OUTCOME rather than an empty state. It is what the
// backend's parser produces when it could not read a verdict at all — a CLI failure, a truncated
// reply, a changed output shape — and the default `block_on` treats it as blocking. Drawing it as
// "no result yet" would turn the one fail-closed outcome into the one that looks like nothing
// happened.
//
// NO EMOJI ICONS — react-icons/fi throughout, per the founder's standing rule.
import { useCallback, useEffect, useState } from "react";
import {
  FiAlertOctagon,
  FiAlertTriangle,
  FiCheckCircle,
  FiClock,
  FiHelpCircle,
  FiRefreshCw,
  FiShield,
  FiSlash,
} from "react-icons/fi";

import { C, FONT_WEIGHT } from "../theme/colors";
import { TYPE } from "../theme/scale";
import { SECTION_LABEL } from "./labelTreatment";
import {
  type AdversarialFinding,
  type AdversarialSeverity,
  type AdversarialVerdictKind,
  gateSentence,
  groupBySeverity,
  readAdversarialStatus,
  runAdversarialReview,
} from "../services/adversarialReview";
import { selectEntry, useAdversarialReviewStore } from "../stores/adversarialReviewStore";

export interface AdversarialReviewPanelProps {
  /** Project root the branch lives in. */
  root: string;
  /** Branch whose diff was (or will be) reviewed. */
  branch: string;
}

/** Icon + ink for each verdict. `unknown` gets the QUESTION mark and the danger ink deliberately:
 *  it is blocking by default, and it must not read as a mild "no answer". */
const VERDICT_LOOK: Record<
  AdversarialVerdictKind,
  { Icon: typeof FiShield; ink: string; label: string }
> = {
  ship: { Icon: FiCheckCircle, ink: C.successInk, label: "Ship" },
  "ship-with-notes": { Icon: FiAlertTriangle, ink: C.amberInk, label: "Ship with notes" },
  block: { Icon: FiAlertOctagon, ink: C.dangerInk, label: "Block" },
  unknown: { Icon: FiHelpCircle, ink: C.dangerInk, label: "Unknown — could not read a verdict" },
};

const SEVERITY_LOOK: Record<AdversarialSeverity, { ink: string; label: string }> = {
  high: { ink: C.dangerInk, label: "High" },
  medium: { ink: C.amberInk, label: "Medium" },
  low: { ink: C.muted, label: "Low" },
  unknown: { ink: C.muted, label: "Unspecified severity" },
};

/** `file:line`, or just the file when the finding is about the file as a whole.
 *
 *  `line` is `number | null | undefined` because the Rust `Option<u32>` crosses the wire as an
 *  explicit `null` — writing this against `number | undefined` alone would miss the shape the wire
 *  actually produces. An absent file reads as "(file not named)" rather than an empty gap, so a
 *  finding whose location the reviewer omitted is still legible as a finding. */
export function findingLocation(f: AdversarialFinding): string {
  const file = f.file.trim() === "" ? "(file not named)" : f.file;
  return f.line === null || f.line === undefined ? file : `${file}:${f.line}`;
}

function FindingRow({ finding }: { finding: AdversarialFinding }) {
  return (
    <li
      data-testid="adversarial-finding"
      style={{ padding: "6px 0", borderTop: `1px solid ${C.hairline}`, listStyle: "none" }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <code style={{ fontSize: TYPE.micro, color: C.muted }}>{findingLocation(finding)}</code>
        {/* The category is a FIELD NAME, so it takes the shell's label treatment rather than a
            hand-typed uppercase+tracking pair — `labelTreatment.ts` is explicit that a tracked
            uppercase run in the body face is just small shouty body copy, and the mono advance
            width is what reads as a machine label. */}
        <span style={SECTION_LABEL}>{finding.category}</span>
      </div>
      <div style={{ fontWeight: FONT_WEIGHT.medium, fontSize: TYPE.small }}>{finding.summary}</div>
      {finding.rationale !== "" && (
        <div style={{ fontSize: TYPE.small, color: C.muted }}>{finding.rationale}</div>
      )}
    </li>
  );
}

export function AdversarialReviewPanel({ root, branch }: AdversarialReviewPanelProps) {
  const entry = useAdversarialReviewStore((s) => selectEntry(s, root, branch));
  const setStatus = useAdversarialReviewStore((s) => s.setStatus);
  const beginRun = useAdversarialReviewStore((s) => s.beginRun);
  const finishRun = useAdversarialReviewStore((s) => s.finishRun);
  const failRun = useAdversarialReviewStore((s) => s.failRun);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(root, branch, await readAdversarialStatus(root, branch));
    } catch (e) {
      failRun(root, branch, e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [root, branch, setStatus, failRun]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onRun = useCallback(async () => {
    beginRun(root, branch);
    try {
      finishRun(root, branch, await runAdversarialReview(root, branch));
      // The run only tells us the RECORD; `gate` is the backend's derivation from config, so the
      // authoritative status is re-read rather than guessed at here. Two implementations of one
      // rule is how the two ends of a gate end up disagreeing.
      await refresh();
    } catch (e) {
      failRun(root, branch, e instanceof Error ? e.message : String(e));
    }
  }, [root, branch, beginRun, finishRun, failRun, refresh]);

  const status = entry.status;
  const record = status?.record ?? null;
  const busy = entry.running || loading;

  return (
    <section
      data-testid="adversarial-review-panel"
      style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: TYPE.small }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <FiShield aria-hidden size={14} />
        <span style={{ fontWeight: FONT_WEIGHT.semibold }}>Adversarial review</span>
        <code style={{ color: C.muted, fontSize: TYPE.micro }}>{branch}</code>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => void onRun()}
          disabled={busy || status?.enabled === false}
          data-testid="adversarial-run"
        >
          <FiRefreshCw aria-hidden size={12} /> {entry.running ? "Reviewing…" : "Review this diff"}
        </button>
      </header>

      {status?.enabled === false && (
        <p data-testid="adversarial-off" style={{ color: C.muted, margin: 0 }}>
          <FiSlash aria-hidden size={12} /> {gateSentence(status)} Set{" "}
          <code>[adversarial_review].enabled = true</code> in config.toml to turn it on.
        </p>
      )}

      {/* STALENESS FIRST, ABOVE THE VERDICT. A verdict about a commit you have replaced still
          renders as a confident answer, and reading it before the caveat is how it gets believed. */}
      {status?.stale === true && record !== null && (
        <p
          data-testid="adversarial-stale"
          style={{ color: C.amberInk, margin: 0, fontWeight: FONT_WEIGHT.medium }}
        >
          <FiClock aria-hidden size={12} /> This verdict is about commit{" "}
          <code>{record.reviewedSha.slice(0, 8)}</code>, not the branch&rsquo;s current head
          {status.headSha === "" ? " (which could not be read)" : ` ${status.headSha.slice(0, 8)}`}.
          Re-run the review before relying on it.
        </p>
      )}

      {record === null && status?.enabled !== false && (
        <p data-testid="adversarial-none" style={{ color: C.muted, margin: 0 }}>
          {status === null ? "Loading…" : gateSentence(status)}
        </p>
      )}

      {record !== null && (
        <>
          <div
            data-testid="adversarial-verdict"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              color: VERDICT_LOOK[record.verdict].ink,
              fontWeight: FONT_WEIGHT.semibold,
              // Dimmed when stale — the banner above is the thing to read first.
              opacity: status?.stale === true ? 0.55 : 1,
            }}
          >
            {(() => {
              const { Icon } = VERDICT_LOOK[record.verdict];
              return <Icon aria-hidden size={14} />;
            })()}
            <span>{VERDICT_LOOK[record.verdict].label}</span>
            <span style={{ color: C.muted, fontWeight: FONT_WEIGHT.regular }}>
              {record.findings.length} finding{record.findings.length === 1 ? "" : "s"}
            </span>
          </div>

          {record.summary !== "" && <p style={{ margin: 0 }}>{record.summary}</p>}

          {record.note !== null && record.note !== undefined && record.note !== "" && (
            <p data-testid="adversarial-note" style={{ margin: 0, color: C.muted }}>
              {record.note}
            </p>
          )}

          {record.truncated && (
            <p data-testid="adversarial-truncated" style={{ margin: 0, color: C.amberInk }}>
              <FiAlertTriangle aria-hidden size={12} /> The diff was truncated at{" "}
              {record.diffBytes.toLocaleString()} bytes — findings cover only the part the reviewer
              saw.
            </p>
          )}

          {groupBySeverity(record.findings).map((group) => (
            <div key={group.severity} data-testid={`adversarial-group-${group.severity}`}>
              <div
                // A section heading, so: the shell's label treatment, overridden only in INK —
                // the severity colour is the one thing this heading says that a generic label
                // cannot. Re-typing the casing and tracking by hand is what the tree-wide ratchet
                // in `labelTreatment.test.ts` exists to stop.
                style={{ ...SECTION_LABEL, color: SEVERITY_LOOK[group.severity].ink }}
              >
                {SEVERITY_LOOK[group.severity].label} · {group.findings.length}
              </div>
              <ul style={{ margin: 0, padding: 0 }}>
                {group.findings.map((f, i) => (
                  <FindingRow key={`${f.file}:${f.line ?? "-"}:${i}`} finding={f} />
                ))}
              </ul>
            </div>
          ))}

          <footer style={{ color: C.muted, fontSize: TYPE.micro }}>
            Reviewed <code>{record.reviewedSha.slice(0, 8)}</code> with {record.model}
          </footer>
        </>
      )}

      {entry.error !== null && (
        <p data-testid="adversarial-error" style={{ color: C.dangerInk, margin: 0 }}>
          {entry.error}
        </p>
      )}
    </section>
  );
}
