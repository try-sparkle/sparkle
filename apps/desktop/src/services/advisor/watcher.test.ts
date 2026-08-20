// The half that turns `advisor:skipped (not yet)` into `advisor:reviewed` — driven with a fake task
// reader, no timers and no Tauri.
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ResearchTask, ResearchStatus } from "../research/types";
import { heldVerdict, resetHeldVerdicts } from "./findings";
import {
  ADVISOR_REVIEWED_LABEL,
  ADVISOR_SKIPPED_LABEL,
  type AdvisorLatch,
  type AdvisorPassDeps,
} from "./pass";
import {
  pollAdvisorTasks,
  resetWatchedPasses,
  watchAdvisorPass,
  watchedCount,
} from "./watcher";

function task(status: ResearchStatus, findings: string | null = null): ResearchTask {
  return {
    id: "task-1",
    question: "q",
    depth: "quick",
    projectId: null,
    projectRoot: "/repo",
    status,
    createdAt: 0,
    startedAt: null,
    finishedAt: null,
    findings,
    error: null,
    readAt: null,
  };
}

const latch: AdvisorLatch = {
  isLatched: () => false,
  latch: () => {},
  creditsBefore: () => null,
  recordCreditsBefore: () => {},
  measured: () => true, // already measured, so the credit read is skipped in these cases
  markMeasured: () => {},
};

function harness() {
  const labels: Array<{ action: string; label: string }> = [];
  const comments: string[] = [];
  const deps: AdvisorPassDeps = {
    readUsage: async () => null,
    plannerModel: async () => "claude-sonnet-4-6",
    catalog: () => [],
    config: () => ({ enabled: true, model: null }),
    dispatchResearch: async () => ({ id: "x" }),
    labelBead: async (_p, action, _id, label) => {
      labels.push({ action, label });
    },
    commentBead: async (_p, _id, text) => {
      comments.push(text);
    },
    latch,
  };
  return { deps, labels, comments };
}

beforeEach(() => {
  resetWatchedPasses();
  resetHeldVerdicts();
});

describe("the advisor watcher", () => {
  it("leaves a RUNNING task alone", async () => {
    const h = harness();
    watchAdvisorPass({ taskId: "task-1", epicId: "e", projectPath: "/repo", model: "claude-opus-5" });
    for (const live of ["queued", "running"] as const) {
      await pollAdvisorTasks(h.deps, async () => task(live));
      expect(h.labels).toEqual([]);
      // …and it is STILL WATCHED. Without this the test passes against a watcher that silently
      // dropped every entry on its first tick, which is the one failure mode that leaves a verdict
      // permanently unrecorded.
      expect(watchedCount()).toBe(1);
    }
  });

  it("settles a DONE task to advisor:reviewed and holds the verdict", async () => {
    const h = harness();
    watchAdvisorPass({ taskId: "task-1", epicId: "e", projectPath: "/repo", model: "claude-opus-5" });
    await pollAdvisorTasks(h.deps, async () =>
      task("done", '```json\n{"findings":[{"lens":"scope","severity":"high","summary":"too big"}]}\n```'),
    );
    expect(h.labels).toContainEqual({ action: "remove", label: ADVISOR_SKIPPED_LABEL });
    expect(h.labels).toContainEqual({ action: "add", label: ADVISOR_REVIEWED_LABEL });
    expect(heldVerdict("e")?.findings[0]?.summary).toBe("too big");
    // And the entry is GONE — re-settling on every tick would rewrite the bead comment forever.
    expect(watchedCount()).toBe(0);
  });

  it("settles a FAILED or CANCELLED task to advisor:skipped, holding NOTHING", async () => {
    for (const dead of ["failed", "cancelled"] as const) {
      resetWatchedPasses();
      resetHeldVerdicts();
      const h = harness();
      watchAdvisorPass({ taskId: "task-1", epicId: "e", projectPath: "/repo", model: "claude-opus-5" });
      await pollAdvisorTasks(h.deps, async () => task(dead));
      expect(h.labels).toContainEqual({ action: "add", label: ADVISOR_SKIPPED_LABEL });
      expect(h.labels).not.toContainEqual({ action: "add", label: ADVISOR_REVIEWED_LABEL });
      // THE FAILURE CONTRACT at the watch layer: a pass that could not answer paints nothing.
      expect(heldVerdict("e")).toBeNull();
      expect(watchedCount()).toBe(0);
    }
  });

  it("KEEPS WATCHING when the task read throws — a transient failure is not a verdict", async () => {
    const h = harness();
    watchAdvisorPass({ taskId: "task-1", epicId: "e", projectPath: "/repo", model: "claude-opus-5" });
    await pollAdvisorTasks(h.deps, async () => {
      throw new Error("bridge down");
    });
    expect(watchedCount()).toBe(1);
    expect(h.labels).toEqual([]);
  });

  it("DROPS a task the store does not have", async () => {
    // The record is the source of truth; an id that is not in it will not appear later. Dropping it
    // settles nothing, so the epic keeps the `advisor:skipped` the handoff already gave it.
    const h = harness();
    watchAdvisorPass({ taskId: "task-1", epicId: "e", projectPath: "/repo", model: "claude-opus-5" });
    await pollAdvisorTasks(h.deps, async () => null);
    expect(watchedCount()).toBe(0);
    expect(h.labels).toEqual([]);
  });

  it("does not let one pass's failure stop the others settling", async () => {
    const h = harness();
    watchAdvisorPass({ taskId: "task-1", epicId: "e1", projectPath: "/repo", model: "claude-opus-5" });
    watchAdvisorPass({ taskId: "task-2", epicId: "e2", projectPath: "/repo", model: "claude-opus-5" });
    const reader = vi.fn(async (id: string) => {
      if (id === "task-1") throw new Error("boom");
      return { ...task("done", '```json\n{"findings":[]}\n```'), id: "task-2" };
    });
    await pollAdvisorTasks(h.deps, reader);
    expect(watchedCount()).toBe(1); // task-1 is retained, task-2 settled
    expect(heldVerdict("e2")).not.toBeNull();
  });
});
