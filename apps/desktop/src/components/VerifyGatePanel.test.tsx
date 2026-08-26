// @vitest-environment jsdom
//
// VerifyGatePanel — what the reader actually SEES, and the three things it must never say:
//   • that a check which never ran is a test failure (it sends someone to read an unjudged diff);
//   • that a PR is clear to open when nothing has been verified;
//   • that a Testing section exists when there is no report behind it.
//
// Every assertion here is on RENDERED OUTPUT, not on a prop or a store field, and the service layer
// is mocked so the panel is driven purely by seeding `verifyGateStore` — the split the component
// header describes.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runVerifyGateMock = vi.fn();
const fetchStatusMock = vi.fn();
const fetchReportMock = vi.fn();
const testingMarkdownMock = vi.fn();
vi.mock("../services/verifyGate", () => ({
  runVerifyGate: (...a: unknown[]) => runVerifyGateMock(...a),
  fetchVerifyGateStatus: (...a: unknown[]) => fetchStatusMock(...a),
  fetchVerifyGateReport: (...a: unknown[]) => fetchReportMock(...a),
  verifyGateTestingMarkdown: (...a: unknown[]) => testingMarkdownMock(...a),
}));

import { VerifyGatePanel, VERIFY_GATE_ROW_TESTID } from "./VerifyGatePanel";
import {
  useVerifyGateStore,
  type CheckResult,
  type CheckStatus,
  type EvidenceItem,
  type PrGateDecision,
  type VerifyGateReport,
} from "../stores/verifyGateStore";

/** `toHaveTextContent` needs jest-dom, which this suite does not install — read the DOM directly. */
function text(el: HTMLElement | null | undefined): string {
  return el?.textContent ?? "";
}

function check(name: string, status: CheckStatus, over: Partial<CheckResult> = {}): CheckResult {
  return {
    name,
    cmd: `pnpm run ${name}`,
    status,
    exitCode: status === "pass" ? 0 : status === "fail" ? 1 : null,
    durationMs: 2500,
    tail: "",
    logPath: null,
    ...over,
  };
}

function seed(
  checks: CheckResult[],
  verdict: VerifyGateReport["verdict"],
  over: { evidence?: EvidenceItem[]; prGate?: PrGateDecision; error?: string | null } = {},
) {
  useVerifyGateStore.setState({
    byAgent: {
      a1: {
        report: {
          version: 1,
          agentId: "a1",
          worktree: "/w/tree",
          branch: "feat/x",
          checks,
          verdict,
          startedAt: 1,
          finishedAt: 2,
        },
        evidence: over.evidence ?? [],
        running: false,
        error: over.error ?? null,
        enabled: true,
        prGate: over.prGate ?? { allowed: false, reason: "not checked", enforced: true },
      },
    },
  });
}

function renderPanel() {
  return render(<VerifyGatePanel projectRoot="/repo" agentId="a1" worktree="/w/tree" />);
}

beforeEach(() => {
  useVerifyGateStore.setState({ byAgent: {} });
  runVerifyGateMock.mockReset().mockResolvedValue(undefined);
  fetchStatusMock.mockReset().mockResolvedValue(null);
  fetchReportMock.mockReset().mockResolvedValue({ report: null, evidence: [] });
  testingMarkdownMock.mockReset();
});

afterEach(cleanup);

describe("check rows", () => {
  it("renders one row per check with its command, outcome and duration", () => {
    seed([check("typecheck", "pass"), check("test", "fail")], "fail");
    renderPanel();
    const rows = screen.getAllByTestId(VERIFY_GATE_ROW_TESTID);
    expect(rows).toHaveLength(2);
    expect(text(rows[0])).toContain("typecheck");
    expect(text(rows[0])).toContain("pnpm run typecheck");
    expect(text(rows[0])).toContain("pass");
    // The duration is the thing that makes a green table checkable at a glance.
    expect(text(rows[0])).toContain("2.5s");
    expect(text(rows[1])).toContain("failed");
  });

  it("does NOT call a timed-out or unrunnable check a failure", () => {
    seed([check("test", "timeout"), check("lint", "not-run")], "fail");
    renderPanel();
    const rows = screen.getAllByTestId(VERIFY_GATE_ROW_TESTID);
    // The distinction pr-checks.sh draws between exit 1 and exit 5: an unjudged check must not be
    // worded as a judgement about the code.
    expect(text(rows[0])).toContain("timed out");
    expect(text(rows[0])).not.toContain("failed");
    expect(text(rows[1])).toContain("not run");
    expect(text(rows[1])).not.toContain("failed");
  });

  it("hides a check's output behind a toggle and reveals it on click", () => {
    seed([check("test", "fail", { tail: "AssertionError: expected 2 to be 3" })], "fail");
    renderPanel();
    expect(screen.queryByText(/AssertionError/)).toBeNull();
    fireEvent.click(screen.getByText("Show output"));
    expect(screen.getByText(/AssertionError: expected 2 to be 3/)).toBeTruthy();
  });

  it("offers no output toggle for a check that produced none", () => {
    seed([check("typecheck", "pass")], "pass");
    renderPanel();
    expect(screen.queryByText("Show output")).toBeNull();
  });
});

describe("the verdict line", () => {
  it("says a not-run report did not RUN, never that it failed", () => {
    seed([check("test", "not-run")], "not-run");
    renderPanel();
    const verdict = screen.getByTestId("verify-gate-verdict");
    expect(text(verdict)).toContain("did not run");
    expect(text(verdict)).not.toContain("checks failed");
  });

  it("counts the passing checks so a partial green cannot read as a full one", () => {
    seed([check("typecheck", "pass"), check("lint", "pass"), check("test", "fail")], "fail");
    renderPanel();
    expect(text(screen.getByTestId("verify-gate-verdict"))).toContain("2/3 passed");
  });

  it("says NEVER RUN for an agent with no report at all", () => {
    renderPanel();
    expect(text(screen.getByTestId("verify-gate-verdict"))).toContain("never run");
    expect(screen.getByText(/have never been run for this agent/)).toBeTruthy();
  });

  it("names the empty check list as nothing verified rather than showing a blank table", () => {
    seed([], "not-run");
    renderPanel();
    expect(screen.getByText(/nothing was verified/)).toBeTruthy();
    expect(screen.queryAllByTestId(VERIFY_GATE_ROW_TESTID)).toHaveLength(0);
  });
});

describe("running", () => {
  it("invokes the run with this agent's WORKTREE, not the project root", () => {
    seed([check("test", "pass")], "pass");
    renderPanel();
    fireEvent.click(screen.getByLabelText("Run checks"));
    expect(runVerifyGateMock).toHaveBeenCalledWith("/repo", "a1", "/w/tree");
  });

  it("disables the run button while a run is in flight", () => {
    useVerifyGateStore.setState({
      byAgent: {
        a1: {
          report: null,
          evidence: [],
          running: true,
          error: null,
          enabled: true,
          prGate: { allowed: false, reason: "not checked", enforced: true },
        },
      },
    });
    renderPanel();
    // A check list takes minutes; a live button gets pressed twice.
    expect(screen.getByLabelText("Run checks")).toHaveProperty("disabled", true);
    expect(text(screen.getByLabelText("Run checks"))).toContain("Running…");
  });

  it("reports a COMMAND failure differently from a failing check", () => {
    seed([check("test", "pass")], "pass", { error: "could not save the report" });
    renderPanel();
    // "We could not run the gate" must not read as "the gate says no".
    expect(text(screen.getByRole("alert"))).toContain("Couldn't run the gate");
    expect(text(screen.getByTestId("verify-gate-verdict"))).toContain("Verified");
  });
});

describe("evidence", () => {
  it("lists each artifact with its caption and file name", () => {
    seed([check("test", "pass")], "pass", {
      evidence: [
        {
          id: "abc123",
          caption: "login flow, signed in",
          fileName: "abc123.png",
          path: "/w/e/abc123.png",
          kind: "image",
          bytes: 10,
          at: 1,
          sourcePath: null,
        },
      ],
    });
    renderPanel();
    const item = screen.getByTestId("verify-gate-evidence");
    expect(text(item)).toContain("login flow, signed in");
    expect(text(item)).toContain("abc123.png");
  });

  it("still shows an uncaptioned artifact rather than dropping the proof", () => {
    seed([check("test", "pass")], "pass", {
      evidence: [
        {
          id: "abc123",
          caption: "",
          fileName: "abc123.png",
          path: "/w/e/abc123.png",
          kind: "image",
          bytes: 10,
          at: 1,
          sourcePath: null,
        },
      ],
    });
    renderPanel();
    expect(text(screen.getByTestId("verify-gate-evidence"))).toContain("evidence abc123");
  });

  it("explains the empty strip instead of rendering nothing", () => {
    seed([check("test", "pass")], "pass");
    renderPanel();
    expect(screen.getByText(/No evidence attached yet/)).toBeTruthy();
  });
});

describe("the PR gate line", () => {
  it("says BLOCKED with the backend's own reason", () => {
    seed([check("test", "fail")], "fail", {
      prGate: { allowed: false, reason: "these checks did not pass: test", enforced: true },
    });
    renderPanel();
    const line = screen.getByTestId("verify-gate-pr-decision");
    expect(text(line)).toContain("PR gate: blocked");
    expect(text(line)).toContain("these checks did not pass: test");
  });

  it("says CLEAR only when the backend allowed it", () => {
    seed([check("test", "pass")], "pass", {
      prGate: { allowed: true, reason: "all 1 checks passed", enforced: true },
    });
    renderPanel();
    expect(text(screen.getByTestId("verify-gate-pr-decision"))).toContain("clear to open");
  });

  it("renders NO gate line at all when the gate is not enforced for this project", () => {
    seed([check("test", "pass")], "pass", {
      prGate: { allowed: true, reason: "not enforced", enforced: false },
    });
    renderPanel();
    // A repo that does not gate PRs must not be told it is "clear" — that reads as a verification
    // it never performed.
    expect(screen.queryByTestId("verify-gate-pr-decision")).toBeNull();
  });
});

describe("copying the Testing section", () => {
  it("copies the backend's rendered markdown", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    testingMarkdownMock.mockResolvedValue("## Testing\n\n**Verdict: PASS**\n");
    seed([check("test", "pass")], "pass");
    renderPanel();
    fireEvent.click(screen.getByLabelText("Copy Testing section"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("## Testing\n\n**Verdict: PASS**\n"));
    expect(await screen.findByText(/copied to the clipboard/)).toBeTruthy();
  });

  it("refuses rather than pasting a section for a report that does not exist", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    testingMarkdownMock.mockResolvedValue(null);
    seed([check("test", "pass")], "pass");
    renderPanel();
    fireEvent.click(screen.getByLabelText("Copy Testing section"));
    // A Testing section claiming verification that never happened is the failure this feature
    // exists to end — so nothing reaches the clipboard.
    await waitFor(() => expect(text(screen.getByRole("alert"))).toContain("Couldn't copy"));
    expect(writeText).not.toHaveBeenCalled();
  });

  it("disables the copy button until there is a report", () => {
    renderPanel();
    expect(screen.getByLabelText("Copy Testing section")).toHaveProperty("disabled", true);
  });
});

describe("mount", () => {
  it("reads the last report so a run from another window is visible on open", () => {
    renderPanel();
    expect(fetchStatusMock).toHaveBeenCalledWith("/repo", "a1");
    expect(fetchReportMock).toHaveBeenCalledWith("/repo", "a1");
  });
});
