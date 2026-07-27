// @vitest-environment jsdom
//
// Settings → History & Spend. The Tauri IPC layer is mocked at spendApi's seam (invoke), so this
// exercises the real service wrapper plus the component. What's asserted is the pane's honesty
// contract as much as its layout: unpriced models must not read as free, a truncated scan must
// say so, and an empty window must be an empty state rather than a silent blank chart.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { SpendPane } from "./SpendPane";
import type { SpendReport } from "../services/spendApi";

function bucket(total: number, cost: number, unpriced = 0, messages = 1) {
  return {
    tokens: {
      input: total,
      output: 0,
      cacheCreation: 0,
      cacheRead: 0,
      total,
    },
    estimatedCostUsd: cost,
    unpricedTokens: unpriced,
    messages,
  };
}

function report(over: Partial<SpendReport> = {}): SpendReport {
  return {
    windowDays: 28,
    generatedAt: 1_784_000_000,
    days: [
      { date: "2026-07-23", ...bucket(0, 0, 0, 0) },
      { date: "2026-07-24", ...bucket(1_500_000, 12.5) },
    ],
    models: [{ model: "claude-opus-5", priced: true, ...bucket(1_500_000, 12.5) }],
    projects: [
      { project: "sparkle", sessions: 3, lastActive: "2026-07-24", ...bucket(1_500_000, 12.5) },
    ],
    sessions: [
      {
        sessionId: "abcdef12-3456-7890-abcd-ef1234567890",
        project: "sparkle",
        lastActive: "2026-07-24",
        ...bucket(1_500_000, 12.5),
      },
    ],
    totals: bucket(1_500_000, 12.5),
    unknownModels: [],
    filesScanned: 42,
    truncated: false,
    roots: ["/Users/me/.claude/projects"],
    pricingNote: "Estimated from local transcripts at published list API rates.",
    timezone: "UTC",
    ...over,
  };
}

beforeEach(() => invoke.mockReset());
afterEach(cleanup);

describe("SpendPane", () => {
  it("loads the default 28-day window and renders totals, chart, and tables", async () => {
    invoke.mockResolvedValue(report());
    render(<SpendPane />);

    // Scoped to the headline stats: "1.5M" also appears in every table row below.
    expect((await screen.findByTestId("spend-stat-tokens")).textContent).toContain("1.5M");
    expect(screen.getByTestId("spend-stat-cost").textContent).toContain("$12.50");
    expect(invoke).toHaveBeenCalledWith("spend_report", { windowDays: 28 });

    // One bar per day in the window, including the idle day.
    expect(screen.getAllByTestId("spend-bar")).toHaveLength(2);
    expect(screen.getByText("claude-opus-5")).toBeTruthy();
    // "sparkle" appears twice: as the project row, and as the session row's project column.
    expect(screen.getAllByText("sparkle")).toHaveLength(2);
    // Session ids are uuids — the table shows a readable prefix.
    expect(screen.getByText("abcdef12")).toBeTruthy();
  });

  it("re-scans with the chosen window when a range chip is clicked", async () => {
    invoke.mockResolvedValue(report());
    render(<SpendPane />);
    await screen.findByText("claude-opus-5");

    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenLastCalledWith("spend_report", { windowDays: 7 }),
    );
  });

  it("renders an unpriced model as '—' and says its tokens aren't costed", async () => {
    // The whole point of the unpriced path: a model we have no rate for must never render as a
    // confident "$0.00", which would read as "this run was free".
    invoke.mockResolvedValue(
      report({
        models: [
          { model: "some-future-model", priced: false, ...bucket(9_000, 0, 9_000) },
        ],
        totals: bucket(9_000, 0, 9_000),
        unknownModels: ["some-future-model"],
      }),
    );
    render(<SpendPane />);

    expect(await screen.findByText("some-future-model")).toBeTruthy();
    expect(screen.getByText("unpriced")).toBeTruthy();
    // Both the model row's cost cell AND the headline stat must read "—", never "$0.00".
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.getByTestId("spend-stat-cost").textContent).toContain("—");
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(
      screen.getByText(/9K tokens came from models with no published price/),
    ).toBeTruthy();
  });

  it("warns when the scan hit its file limit instead of presenting a partial total as complete", async () => {
    invoke.mockResolvedValue(report({ truncated: true }));
    render(<SpendPane />);
    expect(await screen.findByText(/hit its file limit/)).toBeTruthy();
  });

  it("shows an empty state — not a blank chart — for a window with no usage", async () => {
    invoke.mockResolvedValue(
      report({
        days: [{ date: "2026-07-24", ...bucket(0, 0, 0, 0) }],
        models: [],
        projects: [],
        sessions: [],
        totals: bucket(0, 0, 0, 0),
      }),
    );
    render(<SpendPane />);

    expect(await screen.findByText(/No Claude Code usage in the last 28 days/)).toBeTruthy();
    expect(screen.queryAllByTestId("spend-bar")).toHaveLength(0);
  });

  it("surfaces a scan failure with a retry rather than an empty pane", async () => {
    invoke.mockRejectedValueOnce("permission denied");
    render(<SpendPane />);

    expect(await screen.findByText(/Couldn't read spend: permission denied/)).toBeTruthy();
    invoke.mockResolvedValue(report());
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("claude-opus-5")).toBeTruthy();
  });

  it("renders the pricing caveat verbatim from the report", async () => {
    // The caveat is owned by Rust so the words can't drift from the arithmetic — the pane must
    // not paraphrase it.
    invoke.mockResolvedValue(report());
    render(<SpendPane />);
    expect(
      await screen.findByText("Estimated from local transcripts at published list API rates."),
    ).toBeTruthy();
  });
});
