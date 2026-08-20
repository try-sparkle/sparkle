// @vitest-environment jsdom
//
// THE CONCIERGE RESEARCH VIEW in the MAIN pane — bead `sparkle-s7rfc`.
//
// Founder 2026-08-17: a research agent should work "exactly like any other worker" — click its name
// and the right pane shows what was SENT and what is HAPPENING. The sidebar row's job is to SELECT
// (asserted in ConciergeAgentsRow.test.tsx); THIS pane's job is to SHOW. So the question, the
// status/tier/elapsed strip, Cancel, the full findings and the error — everything that used to
// render inline below the row — is asserted here, plus the headline feature: a LIVE TAIL of the
// child's output while it runs, polled from the backend on the research cadence.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";

import { ConciergeResearchPane } from "./ConciergeResearchPane";
import {
  _resetResearchStoreForTests,
  RESEARCH_POLL_INTERVAL_MS,
  useResearchStore,
} from "../services/research/store";
import { openResearchTaskInPane } from "../services/research/selection";
import { useUiStore } from "../stores/uiStore";
import type { ResearchTask } from "../services/research/types";

const invokeMock = vi.mocked(invoke);

const FIXTURE: ResearchTask[] = JSON.parse(
  readFileSync(
    join(__dirname, "..", "services", "research", "fixtures", "researchTasks.sample.json"),
    "utf8",
  ),
);
// The FIRST done task carries findings; started 1754700004000 → finished 1754700120000 = 116_000ms,
// which formatElapsed spells "1.9m" (the same value the old inline-detail test pinned).
const DONE = FIXTURE.find((t) => t.status === "done" && t.findings !== null)!;
const RUNNING = FIXTURE.find((t) => t.status === "running")!;
const FAILED = FIXTURE.find((t) => t.status === "failed")!;

const TAIL = "→ Bash: git log --oneline\nreading the commit history";

function seed(tasks: readonly ResearchTask[]) {
  useResearchStore.setState({
    byId: Object.fromEntries(tasks.map((t) => [t.id, t])),
    hydrated: true,
    openTaskId: null,
    openTaskSeq: 0,
  });
}

beforeEach(() => {
  _resetResearchStoreForTests();
  useUiStore.setState({ activeSpecial: null } as never);
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "research_tail") return TAIL;
    if (cmd === "research_cancel") return { ...RUNNING, status: "cancelled", finishedAt: 1 };
    return undefined;
  });
});
afterEach(cleanup);

// ── WHAT WAS SENT + WHERE IT STANDS ─────────────────────────────────────────────────────────────
describe("ConciergeResearchPane — a done task's question, status, tier and full findings", () => {
  it("renders the question, status, tier, elapsed and the findings IN FULL", () => {
    seed([DONE]);
    act(() => openResearchTaskInPane(DONE.id));
    render(<ConciergeResearchPane visible />);

    expect(screen.getByTestId("concierge-research-question").textContent).toBe(DONE.question);
    expect(screen.getByTestId("concierge-research-status").textContent).toBe("Done");
    expect(screen.getByTestId("concierge-agent-tier").textContent).toBe("Quick research");
    expect(screen.getByTestId("concierge-research-elapsed").textContent).toBe("1.9m");
    // IN FULL, not clipped — types.ts records the same rule on the write side.
    expect(screen.getByTestId("concierge-agent-findings").textContent).toBe(DONE.findings);

    // A finished task shows NO live tail and offers NO Cancel, and never polls research_tail.
    expect(screen.queryByTestId("concierge-research-tail")).toBeNull();
    expect(screen.queryByText("Cancel")).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith("research_tail", expect.anything());
  });

  it("shows a failed task's error, not findings", () => {
    seed([FAILED]);
    act(() => openResearchTaskInPane(FAILED.id));
    render(<ConciergeResearchPane visible />);
    expect(screen.getByTestId("concierge-research-status").textContent).toBe("Failed");
    expect(screen.getByTestId("concierge-agent-error").textContent).toBe(FAILED.error);
    expect(screen.queryByTestId("concierge-agent-findings")).toBeNull();
  });

  // The tier is the founder's "which model", named by the stable `depth` field. DONE is quick,
  // RUNNING is deep — assert each maps to its own label so a hardcoded string cannot satisfy both.
  it("names the quick vs deep tier from the task's depth", () => {
    seed([DONE, RUNNING]);
    act(() => openResearchTaskInPane(DONE.id));
    const { rerender } = render(<ConciergeResearchPane visible />);
    expect(screen.getByTestId("concierge-agent-tier").textContent).toBe("Quick research");

    act(() => openResearchTaskInPane(RUNNING.id));
    rerender(<ConciergeResearchPane visible />);
    expect(screen.getByTestId("concierge-agent-tier").textContent).toBe("Deep research");
  });
});

// ── THE HEADLINE: A LIVE TAIL WHILE THE TASK RUNS ───────────────────────────────────────────────
describe("ConciergeResearchPane — the live output tail", () => {
  it("polls the backend tail and shows the child's incremental output while running", async () => {
    seed([RUNNING]);
    act(() => openResearchTaskInPane(RUNNING.id));
    render(<ConciergeResearchPane visible />);

    // THE DECISION UNDER TEST: a live task shows the TAIL, never the findings block. The tail
    // arrives from the backend poll, so wait for it rather than asserting synchronously.
    await waitFor(() =>
      expect(screen.getByTestId("concierge-research-tail").textContent).toContain(
        "→ Bash: git log --oneline",
      ),
    );
    expect(screen.getByTestId("concierge-research-tail").textContent).toContain(
      "reading the commit history",
    );
    expect(invokeMock).toHaveBeenCalledWith("research_tail", { taskId: RUNNING.id });
    // The paired negative: a running task shows NO findings/error block — the two branches are
    // mutually exclusive, which is what makes the `live ?` decision non-vacuous.
    expect(screen.queryByTestId("concierge-agent-findings")).toBeNull();
  });

  it("keeps polling the tail on the research cadence", () => {
    vi.useFakeTimers();
    try {
      seed([RUNNING]);
      act(() => openResearchTaskInPane(RUNNING.id));
      render(<ConciergeResearchPane visible />);
      const tailCalls = () =>
        invokeMock.mock.calls.filter((c) => c[0] === "research_tail").length;
      // The mount pull, then one per interval — the poll is the fix, so it is asserted on the CALL
      // COUNT, not on the constant existing.
      expect(tailCalls()).toBe(1);
      act(() => void vi.advanceTimersByTime(RESEARCH_POLL_INTERVAL_MS));
      expect(tailCalls()).toBe(2);
      act(() => void vi.advanceTimersByTime(RESEARCH_POLL_INTERVAL_MS));
      expect(tailCalls()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT poll the tail for a finished task", () => {
    vi.useFakeTimers();
    try {
      seed([DONE]);
      act(() => openResearchTaskInPane(DONE.id));
      render(<ConciergeResearchPane visible />);
      act(() => void vi.advanceTimersByTime(RESEARCH_POLL_INTERVAL_MS * 3));
      expect(invokeMock.mock.calls.filter((c) => c[0] === "research_tail")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── THE KILL ────────────────────────────────────────────────────────────────────────────────────
//
// The founder chose NO CAP on concurrent research, so "visible and killable" is the whole guardrail,
// and this pane is now the surface that carries the killable half.
describe("ConciergeResearchPane — cancel", () => {
  it("cancels a running task and the store update removes the Cancel affordance", async () => {
    seed([RUNNING]);
    act(() => openResearchTaskInPane(RUNNING.id));
    render(<ConciergeResearchPane visible />);

    fireEvent.click(screen.getByText("Cancel"));
    expect(invokeMock).toHaveBeenCalledWith("research_cancel", { taskId: RUNNING.id });
    // THE SIDE EFFECT, not the call: the returned cancelled task lands in the store, the task is no
    // longer live, and the pane stops offering a kill.
    await waitFor(() => expect(screen.queryByText("Cancel")).toBeNull());
  });

  it("offers no Cancel on a task that has already finished", () => {
    seed([DONE]);
    act(() => openResearchTaskInPane(DONE.id));
    render(<ConciergeResearchPane visible />);
    expect(screen.queryByText("Cancel")).toBeNull();
  });
});

// ── THE TASK IS GONE ─────────────────────────────────────────────────────────────────────────────
describe("ConciergeResearchPane — closes when its task disappears", () => {
  it("clears the research surface when the open task is reaped from the store", () => {
    seed([DONE]);
    act(() => openResearchTaskInPane(DONE.id));
    render(<ConciergeResearchPane visible />);
    expect(useUiStore.getState().activeSpecial).toBe("research");

    // The task vanishes from disk (a full listing no longer carries it). The pane must not sit over
    // the stage with nothing to show — it closes the surface.
    act(() => useResearchStore.setState({ byId: {} }));
    expect(useUiStore.getState().activeSpecial).toBeNull();
    expect(useResearchStore.getState().openTaskId).toBeNull();
  });
});
