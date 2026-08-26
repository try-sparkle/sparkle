// verifyGate — the ONE module that talks to the Rust verify-before-PR gate (bead `.1`).
//
// Every `invoke` lives here, so `VerifyGatePanel` is testable by seeding `verifyGateStore` instead
// of stubbing the Tauri bridge. Same split as `services/preview` and `services/staleness`, for the
// same reason: a component that invokes directly cannot be rendered in jsdom at all without a
// bridge mock, so the tests that would catch a regression stop being written.
//
// THE COMMAND NAMES AND PAYLOAD SHAPES ARE A FROZEN CONTRACT with `verify_gate.rs`. Do not rename a
// field to something that reads better — see the `T | null` rule at the top of `verifyGateStore`.
import { invoke } from "@tauri-apps/api/core";
import {
  useVerifyGateStore,
  type EvidenceItem,
  type VerifyGateReport,
  type VerifyGateStatus,
} from "../stores/verifyGateStore";

/** The `verify_gate_report` reply. `report` is an explicit `null` when none exists. */
export interface VerifyGateReportReply {
  report: VerifyGateReport | null;
  evidence: EvidenceItem[];
}

/**
 * In-flight runs, keyed `"<projectRoot>::<agentId>"`.
 *
 * COALESCED, because the gate has two independent callers that cannot see each other — the panel's
 * button and any programmatic pre-PR check — and a check list is minutes of `tsc` and a unit suite.
 * Two overlapping runs in one worktree would fight over the same `node_modules`/`target` locks and
 * over the same log files, and the second would report a red that is an artifact of the first. The
 * late caller gets the WINNER'S real outcome rather than a silent skip: a skip would leave its
 * caller with nothing to render. Same shape as `staleness.remedyStale`.
 */
const inFlight = new Map<string, Promise<VerifyGateReport>>();

function key(projectRoot: string, agentId: string): string {
  return `${projectRoot}::${agentId}`;
}

/**
 * Run the gate for one agent and fold the report into the store.
 *
 * Rejects when the COMMAND failed (the run could not happen); a run that happened and found
 * failures RESOLVES with a report whose verdict is `fail`. Those are different facts and the panel
 * renders them differently — "we could not run the gate" is not "the gate says no".
 */
export async function runVerifyGate(
  projectRoot: string,
  agentId: string,
  worktree: string,
): Promise<VerifyGateReport> {
  const k = key(projectRoot, agentId);
  const existing = inFlight.get(k);
  if (existing) return existing;

  const store = useVerifyGateStore.getState();
  // Optimistic, so the button disables on CLICK rather than on the next poll — a check list takes
  // minutes, and a button that stays live for a poll interval gets pressed twice.
  store.patch(agentId, { running: true, error: null });

  const run = (async () => {
    try {
      const report = await invoke<VerifyGateReport>("verify_gate_run", {
        projectRoot,
        agentId,
        worktree,
      });
      const evidence = await loadEvidenceQuietly(projectRoot, agentId);
      useVerifyGateStore.getState().applyReport(agentId, report, evidence);
      return report;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      useVerifyGateStore.getState().patch(agentId, { error: message });
      throw e;
    } finally {
      // ALWAYS clear both, on every path. A stuck `running` is a permanently disabled button, and a
      // stuck `inFlight` entry means the gate can never be run again for this agent in this session.
      inFlight.delete(k);
      useVerifyGateStore.getState().patch(agentId, { running: false });
    }
  })();

  inFlight.set(k, run);
  return run;
}

/** Evidence, or an empty list — used on the run path, where a failed evidence read must not throw
 *  away a report the checks just spent minutes producing. */
async function loadEvidenceQuietly(
  projectRoot: string,
  agentId: string,
): Promise<EvidenceItem[]> {
  try {
    const reply = await invoke<VerifyGateReportReply>("verify_gate_report", {
      projectRoot,
      agentId,
    });
    return reply.evidence ?? [];
  } catch {
    return [];
  }
}

/** The cheap poll. Folds into the store and returns the status. */
export async function fetchVerifyGateStatus(
  projectRoot: string,
  agentId: string,
): Promise<VerifyGateStatus | null> {
  try {
    const status = await invoke<VerifyGateStatus>("verify_gate_status", {
      projectRoot,
      agentId,
    });
    useVerifyGateStore.getState().applyStatus(status);
    return status;
  } catch (e) {
    // A status we could not read must NOT clear the fail-closed `prGate` the entry starts with —
    // `patch` leaves untouched fields alone, which is what keeps an unreadable status from
    // rendering as "clear to open a PR".
    useVerifyGateStore
      .getState()
      .patch(agentId, { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** The full last report plus its evidence. Folds into the store. */
export async function fetchVerifyGateReport(
  projectRoot: string,
  agentId: string,
): Promise<VerifyGateReportReply> {
  const reply = await invoke<VerifyGateReportReply>("verify_gate_report", {
    projectRoot,
    agentId,
  });
  useVerifyGateStore
    .getState()
    .applyReport(agentId, reply.report ?? null, reply.evidence ?? []);
  return reply;
}

/**
 * Copy an artifact into this agent's evidence store.
 *
 * THE SEAM A BROWSER DRIVER PLUGS INTO. A Playwright/`storageState` run writes a PNG or a WebM
 * wherever it likes and hands us the path; Rust copies it in (never moves, never deletes the
 * source) and gives it a content-addressed id. Nothing about a driver is referenced here, which is
 * why one can be added later without reopening any of this. See `PRD/verify-before-pr-gate.md`.
 */
export async function attachVerifyGateEvidence(
  projectRoot: string,
  agentId: string,
  sourcePath: string,
  caption: string,
): Promise<EvidenceItem> {
  const item = await invoke<EvidenceItem>("verify_gate_attach_evidence", {
    projectRoot,
    agentId,
    sourcePath,
    caption,
  });
  const store = useVerifyGateStore.getState();
  const prev = store.byAgent[agentId]?.evidence ?? [];
  // Content-addressed ids mean a re-attach REPLACES rather than appends — mirror Rust's manifest
  // rule here so the panel does not show a duplicate until the next full report read.
  const next = prev.some((e) => e.id === item.id)
    ? prev.map((e) => (e.id === item.id ? item : e))
    : [...prev, item];
  store.patch(agentId, { evidence: next });
  return item;
}

/**
 * The rendered `## Testing` markdown for this agent's last report.
 *
 * `null` when no report exists — and the caller MUST NOT substitute an empty string or a hand-
 * written section. A Testing section that claims verification which never happened is precisely the
 * "the agent says it works" failure this feature exists to end.
 */
export async function verifyGateTestingMarkdown(
  projectRoot: string,
  agentId: string,
): Promise<string | null> {
  return (
    (await invoke<string | null>("verify_gate_testing_markdown", {
      projectRoot,
      agentId,
    })) ?? null
  );
}
