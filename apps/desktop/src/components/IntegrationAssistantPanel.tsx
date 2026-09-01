// IntegrationAssistantPanel — the ordered merge queue, each branch's gate verdict, and every file
// collision, rendered so a human can see WHY the order is what it is before authorizing anything.
//
// THE ONE RULE THIS UI ENFORCES, and the reason it is not just a list with buttons: only the HEAD of
// the queue gets a Merge action. Every merge moves the base under everything still queued, so a
// green verdict on position 3 is evidence about a base that stops existing the moment positions 1
// and 2 land. "Show me what's green and let me click it" is the obvious rendering and it is exactly
// the merge the ORDER existed to prevent, so the decision lives in `nextActionable` (pure, tested)
// and this component only paints it.
//
// A MERGE THAT LANDED NEVER REACHES THE ERROR LINE. `integration_merge` has one outcome that is a
// success carrying bad news: the PR merged, but commits on the pushed branch head were not in the
// merge commit (`outcome.stranded`, Rust's `MERGED-BUT-STRANDED` report). It arrives as a RESOLVED
// promise with `landed: true`, so the row paints as landed with the report beside it and the entry
// leaves `nextActionable`'s queue. Routing it to `setError` — which is what happened while the Rust
// side propagated it as a plain `Err` — left the entry offered for a second Merge click against an
// already-merged PR (roborev 72459). The `.catch` below is for merges that did NOT happen.
//
// No emoji icons anywhere — react-icons/fi (Feather), per the founder's standing rule.
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import {
  FiAlertTriangle,
  FiCheckCircle,
  FiGitMerge,
  FiHelpCircle,
  FiLayers,
  FiSlash,
  FiXCircle,
} from "react-icons/fi";
import { C } from "../theme/colors";
import { FONT_UI, RADIUS, SPACE, TYPE } from "../theme/scale";
import {
  gateTone,
  mergeBranch,
  nextActionable,
  planIntegration,
  readIntegrationStatus,
  summarizeQueue,
  type BranchCandidate,
  type IntegrationStatus,
  type QueueEntry,
} from "../services/integrationAssistant";
import { useIntegrationQueueStore, warningsFor } from "../stores/integrationQueueStore";

export const INTEGRATION_PANEL_TESTID = "integration-assistant-panel";
export const INTEGRATION_ROW_TESTID = "integration-queue-row";
export const INTEGRATION_HOLD_TESTID = "integration-queue-hold";
/** The landed-with-a-warning report. On a LANDED row — never in the panel's error line. */
export const INTEGRATION_STRANDED_TESTID = "integration-queue-stranded";

interface Props {
  root: string;
  projectId: string;
  /** The branches to plan over. The panel does not discover them — whoever knows which agents are
   *  ready owns that question, and guessing it here would plan over branches nobody offered. */
  candidates: BranchCandidate[];
  /** The ref to plan against. Empty asks the Rust side for `origin/<default>`. */
  base?: string;
}

const TONE_ICON = {
  ready: FiCheckCircle,
  blocked: FiXCircle,
  unknown: FiHelpCircle,
} as const;

const TONE_INK: Record<"ready" | "blocked" | "unknown", string> = {
  ready: C.successInk,
  blocked: C.dangerInk,
  unknown: C.amberInk,
};

const panel: CSSProperties = {
  font: FONT_UI,
  color: C.cream,
  background: C.dialogSurface,
  border: `1px solid ${C.dialogEdge}`,
  // RADIUS/SPACE/TYPE, never a literal: `apps/desktop/src/theme/scale.test.ts` is a RATCHET whose
  // ceiling for off-scale fontSize and borderRadius values is 0, so one hand-picked `10` here reds
  // the whole desktop suite. `modal` is the scale's largest radius and this is a panel.
  borderRadius: RADIUS.modal,
  padding: SPACE.md,
  display: "flex",
  flexDirection: "column",
  gap: SPACE.sm,
};

const row: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: SPACE.xs,
  padding: `${SPACE.sm}px ${SPACE.nav}px`,
  borderRadius: RADIUS.input,
  border: `1px solid ${C.hairline}`,
};

const meta: CSSProperties = { color: C.muted, fontSize: TYPE.small };

export function IntegrationAssistantPanel({ root, projectId, candidates, base = "" }: Props) {
  const { entries, warnings, unplannable, error, setPlan, setOutcome, setBusy, setError } =
    useIntegrationQueueStore();
  const [status, setStatus] = useState<IntegrationStatus | null>(null);

  useEffect(() => {
    let live = true;
    readIntegrationStatus(root)
      .then((s) => {
        if (live) setStatus(s);
      })
      // A status we could not read is NOT "enabled" — leaving it null keeps the panel in its
      // can't-say state rather than painting an assistant that may not be there.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [root]);

  const plan = useCallback(() => {
    setError(null);
    planIntegration({ root, projectId, base, candidates })
      .then(setPlan)
      .catch((e: unknown) => setError(String(e)));
  }, [root, projectId, base, candidates, setPlan, setError]);

  const merge = useCallback(
    (entry: QueueEntry) => {
      if (entry.pr == null) return;
      setBusy(entry.branch, true);
      setError(null);
      mergeBranch({ root, projectId, branch: entry.branch, pr: entry.pr })
        .then(setOutcome)
        .catch((e: unknown) => {
          setBusy(entry.branch, false);
          setError(String(e));
        });
    },
    [root, projectId, setBusy, setOutcome, setError],
  );

  const next = nextActionable(entries);

  return (
    <div style={panel} data-testid={INTEGRATION_PANEL_TESTID}>
      <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm }}>
        <FiGitMerge aria-hidden style={{ color: C.accentInk }} />
        <strong>Integration assistant</strong>
        <span style={meta}>{summarizeQueue(entries)}</span>
        <button type="button" onClick={plan} style={{ marginLeft: "auto", font: FONT_UI }}>
          Plan merge order
        </button>
      </div>

      {status !== null && !status.enabled && (
        <p style={meta}>
          <FiSlash aria-hidden /> Turned off. Nothing here plans, gates or merges until{" "}
          <code>[integration_assistant].enabled = true</code> is set in Sparkle&apos;s config. It is
          off by default because it merges pull requests.
        </p>
      )}
      {status !== null && status.enabled && !status.prChecksAvailable && (
        <p style={meta}>
          <FiAlertTriangle aria-hidden /> <code>scripts/pr-checks.sh</code> is not in this repo, so
          every gate here will answer <em>unknown</em> — which is never ready.
        </p>
      )}
      {error !== null && (
        <p style={{ ...meta, color: C.dangerInk }} role="alert">
          {error}
        </p>
      )}

      {entries.map((entry) => {
        const tone = gateTone(entry.gate);
        const Icon = TONE_ICON[tone];
        const mine = warningsFor(entry.branch, warnings);
        const actionable = next.entry?.branch === entry.branch;
        return (
          <div key={entry.branch} style={row} data-testid={INTEGRATION_ROW_TESTID}>
            <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm }}>
              <span style={meta}>{entry.position}.</span>
              <strong>{entry.branch}</strong>
              {entry.pr != null && <span style={meta}>#{entry.pr}</span>}
              <Icon aria-hidden style={{ color: TONE_INK[tone] }} />
              <span style={{ color: TONE_INK[tone] }}>
                {entry.outcome?.landed === true ? "landed" : (entry.gate?.verdict ?? "not gated")}
              </span>
              {actionable && (
                <button
                  type="button"
                  onClick={() => merge(entry)}
                  disabled={entry.busy}
                  style={{ marginLeft: "auto", font: FONT_UI }}
                >
                  Merge #{entry.pr}
                </button>
              )}
            </div>
            <div style={meta}>
              {entry.changedFiles} file(s) · checks {entry.gate?.checks ?? "unread"} · local gate{" "}
              {entry.gate?.localGate ?? "unread"}
            </div>
            {entry.gate?.reason != null && <div style={{ color: TONE_INK[tone] }}>{entry.gate.reason}</div>}
            {entry.outcome?.refusal != null && (
              <div>
                <div style={{ color: C.dangerInk }}>{entry.outcome.refusal.reason}</div>
                <div style={meta}>{entry.outcome.refusal.remedy}</div>
              </div>
            )}
            {entry.outcome?.stranded != null && (
              <div style={{ color: C.amberInk }} data-testid={INTEGRATION_STRANDED_TESTID}>
                <FiAlertTriangle aria-hidden /> {entry.outcome.stranded}
              </div>
            )}
            {entry.outcome?.landed === true && <div style={meta}>{entry.outcome.cleanup}</div>}
            {mine.map((w) => (
              <div key={`${w.a}|${w.b}`} style={{ color: C.amberInk }}>
                <FiLayers aria-hidden /> {w.sentence}
              </div>
            ))}
            {entry.externalOverlap != null && (
              <div style={{ color: C.amberInk }}>
                <FiAlertTriangle aria-hidden /> {entry.externalOverlap}
              </div>
            )}
          </div>
        );
      })}

      {next.entry === null && next.reason !== null && (
        <p style={meta} data-testid={INTEGRATION_HOLD_TESTID}>
          {next.reason}
        </p>
      )}

      {unplannable.map((u) => (
        <p key={u.branch || u.reason} style={{ ...meta, color: C.amberInk }}>
          <FiAlertTriangle aria-hidden /> {u.branch === "" ? u.reason : `${u.branch}: ${u.reason}`}
        </p>
      ))}
    </div>
  );
}
