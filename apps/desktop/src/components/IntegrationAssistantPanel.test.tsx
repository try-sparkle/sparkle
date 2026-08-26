// @vitest-environment jsdom
//
// What the panel is allowed to OFFER, which is the only thing about it that can cause harm. The
// rest of the render is prose; the Merge button is a merge.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INTEGRATION_HOLD_TESTID,
  INTEGRATION_ROW_TESTID,
  IntegrationAssistantPanel,
} from "./IntegrationAssistantPanel";
import { useIntegrationQueueStore } from "../stores/integrationQueueStore";
import { readIntegrationStatus } from "../services/integrationAssistant";
import type {
  GateReport,
  IntegrationStatus,
  MergePlan,
  PlannedMerge,
} from "../services/integrationAssistant";

vi.mock("../services/integrationAssistant", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readIntegrationStatus: vi.fn(),
  planIntegration: vi.fn(),
  gateBranch: vi.fn(),
  mergeBranch: vi.fn(),
}));
const statusMock = vi.mocked(readIntegrationStatus);

const STATUS: IntegrationStatus = {
  enabled: true,
  autoRebase: true,
  requireRoborevClean: true,
  mergeStrategy: "merge",
  cleanupAfterMerge: true,
  prChecksAvailable: true,
  prOverlapAvailable: true,
  slug: "drodio/sparkle",
  mergeProtected: false,
  localGate: "not-run",
};

function planned(branch: string, position: number): PlannedMerge {
  return {
    branch,
    pr: position,
    position,
    changedFiles: 2,
    overlapsWith: [],
    externalOverlap: null,
    prDraft: null,
  };
}

function gate(branch: string, verdict: string, reason: string | null): GateReport {
  return {
    branch,
    pr: 1,
    verdict,
    reason,
    checks: verdict === "ready" ? "pass" : "failed",
    roborevBlocking: 0,
    localGate: "not-run",
  };
}

function seed(plan: MergePlan) {
  useIntegrationQueueStore.getState().reset();
  useIntegrationQueueStore.getState().setPlan(plan);
}

function panel() {
  return <IntegrationAssistantPanel root="/r" projectId="p" candidates={[]} />;
}

beforeEach(() => {
  statusMock.mockReset();
  statusMock.mockResolvedValue(STATUS);
  useIntegrationQueueStore.getState().reset();
});
afterEach(cleanup);

describe("IntegrationAssistantPanel", () => {
  it("offers Merge ONLY on the head of the queue, even when a later branch is green", async () => {
    // THE SAFETY PROPERTY. `second` is ready; `first` is not. A panel that rendered a button next
    // to everything green would invite the out-of-order merge the ORDER exists to prevent.
    seed({
      base: "origin/main",
      order: [planned("first", 1), planned("second", 2)],
      warnings: [],
      unplannable: [],
    });
    useIntegrationQueueStore.getState().setGate(gate("first", "blocked", "CI checks failed"));
    useIntegrationQueueStore.getState().setGate(gate("second", "ready", null));

    render(panel());
    await waitFor(() => expect(screen.getAllByTestId(INTEGRATION_ROW_TESTID)).toHaveLength(2));
    expect(screen.queryByRole("button", { name: /Merge #2/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Merge #1/ })).toBeNull();
    // …and it says which entry is holding the line, so the absent button is explained rather than
    // reading as a broken panel.
    const hold = screen.getByTestId(INTEGRATION_HOLD_TESTID);
    expect(hold.textContent).toContain("first");
    expect(hold.textContent).toContain("CI checks failed");
  });

  it("...and DOES offer it once the head itself is ready", async () => {
    // The positive pair for the test above: without it, that one passes for a panel that never
    // renders a Merge button at all.
    seed({
      base: "origin/main",
      order: [planned("first", 1), planned("second", 2)],
      warnings: [],
      unplannable: [],
    });
    useIntegrationQueueStore.getState().setGate(gate("first", "ready", null));
    useIntegrationQueueStore.getState().setGate(gate("second", "ready", null));

    render(panel());
    await waitFor(() => expect(screen.getByRole("button", { name: /Merge #1/ })).toBeTruthy());
    // Still only ONE, and it is the head's.
    expect(screen.queryByRole("button", { name: /Merge #2/ })).toBeNull();
  });

  it("shows the collision sentence on both branches it names", async () => {
    const warning = {
      a: "first",
      b: "second",
      paths: ["src/shared.rs"],
      sentence: "first and second both change 1 file: src/shared.rs. Merge them one at a time.",
    };
    seed({
      base: "origin/main",
      order: [planned("first", 1), planned("second", 2)],
      warnings: [warning],
      unplannable: [{ branch: "third", reason: "changes no files against origin/main" }],
    });
    render(panel());
    await waitFor(() => expect(screen.getAllByTestId(INTEGRATION_ROW_TESTID)).toHaveLength(2));
    // Once per row — a collision belongs to both sides of the pair, and a reader looking at one
    // branch must not have to scan the other's row to learn it collides.
    expect(screen.getAllByText(new RegExp("src/shared\\.rs"))).toHaveLength(2);
    // A branch that could not be planned is REPORTED, not silently missing from the list.
    expect(screen.getByText(/third: changes no files/)).toBeTruthy();
  });

  it("shows a refusal's reason AND its remedy, because the remedy is the actionable half", async () => {
    seed({ base: "origin/main", order: [planned("first", 1)], warnings: [], unplannable: [] });
    useIntegrationQueueStore.getState().setOutcome({
      branch: "first",
      pr: 1,
      landed: false,
      refusal: {
        reason: "plow-pbc/tkmx-server is pinned merge-protected",
        remedy: "Hand the PR to a human who owns that repo.",
      },
      headSha: "abc",
      cleanup: "not run — nothing was merged",
    });
    render(panel());
    await waitFor(() => expect(screen.getByText(/pinned merge-protected/)).toBeTruthy());
    expect(screen.getByText(/Hand the PR to a human/)).toBeTruthy();
  });

  it("says so when the assistant is turned off, instead of rendering a live-looking queue", async () => {
    statusMock.mockResolvedValue({ ...STATUS, enabled: false });
    seed({ base: "origin/main", order: [planned("first", 1)], warnings: [], unplannable: [] });
    render(panel());
    await waitFor(() => expect(screen.getByText(/Turned off/)).toBeTruthy());
    expect(screen.getByText(/enabled = true/)).toBeTruthy();
    // The PAIR: with the assistant ON, that note must be absent — otherwise this test would pass
    // for a panel that always shows it.
    cleanup();
    statusMock.mockResolvedValue(STATUS);
    render(panel());
    await waitFor(() => expect(screen.getAllByTestId(INTEGRATION_ROW_TESTID)).toHaveLength(1));
    expect(screen.queryByText(/Turned off/)).toBeNull();
  });

  it("warns when pr-checks.sh is absent, because every gate will then answer unknown", async () => {
    statusMock.mockResolvedValue({ ...STATUS, prChecksAvailable: false });
    render(panel());
    await waitFor(() => expect(screen.getByText(/is not in this repo/)).toBeTruthy());
  });
});
