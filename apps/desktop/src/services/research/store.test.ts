// The pure selectors, the Tauri seam, and the cache semantics. Tested against the SAME fixture the
// Rust round-trip reads.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The Tauri seam is MOCKED rather than skipped. Every wrapper below was untested at first
// (roborev 61562), which left the exact failure the command-name const exists to prevent wide open:
// an `invoke` argument typo has no compile-time signal and no test signal — only a runtime error in
// the built app, in a feature nobody would think to re-check.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";

import {
  RESEARCH_COMMANDS,
  _resetResearchStoreForTests,
  allTasksNow,
  cancelResearch,
  dispatchResearch,
  getResearch,
  liveTasks,
  markResearchRead,
  refreshResearch,
  sortedTasks,
  unreadTasks,
  useResearchStore,
} from "./store";
import type { ResearchTask } from "./types";

const invokeMock = vi.mocked(invoke);

const FIXTURE: ResearchTask[] = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "researchTasks.sample.json"), "utf8"),
);

beforeEach(() => {
  _resetResearchStoreForTests();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined as never);
});

describe("the command surface", () => {
  // These five strings are the contract with research.rs. An `invoke` typo has no compile-time
  // signal, so the names are pinned here and the Rust side has one list to satisfy.
  it("names exactly the five commands research.rs implements", () => {
    expect(RESEARCH_COMMANDS).toEqual({
      dispatch: "research_dispatch",
      list: "research_list",
      get: "research_get",
      cancel: "research_cancel",
      markRead: "research_mark_read",
    });
  });

  // ── THE CROSS-LANGUAGE PIN ──────────────────────────────────────────────────────────────────
  // The assertion above compares this module to a literal in this same file, so it can only fail if
  // someone edits store.ts — it says NOTHING about research.rs (roborev 61562). The direction that
  // actually breaks is a rename on the Rust side: both TS files would agree, this suite would stay
  // green, and every invoke would fail at runtime.
  //
  // So read the Rust source. It is written by a sibling unit and may not have landed yet; while it
  // is absent this reports that fact loudly rather than passing quietly, because a check that
  // fails open forever is the thing being fixed here.
  it("matches the #[tauri::command] names in research.rs once that file exists", () => {
    const rs = join(__dirname, "..", "..", "..", "src-tauri", "src", "research.rs");
    if (!existsSync(rs)) {
      console.warn(
        `[research] cross-language command pin is INERT: ${rs} does not exist yet. ` +
          `This assertion goes live when the Rust runner lands.`,
      );
      expect(existsSync(rs)).toBe(false); // records the state rather than silently passing
      return;
    }
    const src = readFileSync(rs, "utf8");
    const declared = [...src.matchAll(/#\[tauri::command\][\s\S]*?fn\s+(\w+)/g)].map((m) => m[1]!);
    expect([...declared].sort()).toEqual([...Object.values(RESEARCH_COMMANDS)].sort());
  });
});

describe("the Tauri seam — the argument names are the contract", () => {
  it("dispatch sends the camelCase keys Tauri maps to snake_case Rust params", async () => {
    await dispatchResearch({
      question: "why",
      projectId: "p1",
      projectRoot: "/tmp/p1",
      depth: "quick",
    });
    expect(invokeMock).toHaveBeenCalledWith("research_dispatch", {
      question: "why",
      projectId: "p1",
      // The ROOT is what the runner needs; it refuses to guess a directory.
      projectRoot: "/tmp/p1",
      depth: "quick",
    });
  });

  it("forwards a null projectId rather than dropping the key", async () => {
    await dispatchResearch({
      question: "why",
      projectId: null,
      projectRoot: "/tmp/p1",
      depth: "deep",
    });
    const [, args] = invokeMock.mock.calls[0]!;
    expect(args).toHaveProperty("projectId");
    expect((args as { projectId: unknown }).projectId).toBeNull();
  });

  it("get and cancel send taskId", async () => {
    await getResearch("t1");
    expect(invokeMock).toHaveBeenCalledWith("research_get", { taskId: "t1" });
    invokeMock.mockClear();
    await cancelResearch("t2");
    expect(invokeMock).toHaveBeenCalledWith("research_cancel", { taskId: "t2" });
  });

  it("markResearchRead sends taskIds and at", async () => {
    await markResearchRead(["a", "b"], 1234);
    expect(invokeMock).toHaveBeenCalledWith("research_mark_read", {
      taskIds: ["a", "b"],
      at: 1234,
    });
  });

  // Delete the short-circuit and this goes red. Without it an empty claim round-trips to Rust on
  // every single turn, which is the common case — most turns have no findings to claim.
  it("does not round-trip an EMPTY claim", async () => {
    await markResearchRead([], 1234);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("refreshResearch", () => {
  it("does not throw when the backend is unreachable, and keeps what it last knew", async () => {
    useResearchStore.getState().replaceAll(FIXTURE);
    invokeMock.mockRejectedValueOnce(new Error("no backend"));

    await expect(refreshResearch()).resolves.toBeUndefined();
    expect(allTasksNow()).toHaveLength(FIXTURE.length);
  });

  it("still hydrates after a failed FIRST load, so the row is not blank forever", async () => {
    invokeMock.mockRejectedValueOnce(new Error("no backend"));
    await refreshResearch();
    expect(useResearchStore.getState().hydrated).toBe(true);
  });

  // THE RACE. replaceAll is destructive, so a stale response does not merely show old data — it
  // DELETES the task the founder just dispatched.
  it("drops a stale response so a just-dispatched task cannot vanish", async () => {
    const older = [FIXTURE[0]!];
    const newer = [FIXTURE[0]!, FIXTURE[1]!];

    let resolveOlder!: (v: ResearchTask[]) => void;
    invokeMock.mockImplementationOnce(
      () => new Promise((res) => { resolveOlder = res as (v: ResearchTask[]) => void; }),
    );
    invokeMock.mockResolvedValueOnce(newer as never);

    const first = refreshResearch(); // issued first, will resolve SECOND
    await refreshResearch(); // issued second, resolves first
    expect(allTasksNow()).toHaveLength(2);

    resolveOlder(older);
    await first;

    // The stale answer must not win.
    expect(allTasksNow()).toHaveLength(2);
  });
});

describe("liveTasks — what the row's +[n] counts", () => {
  it("counts queued and running only", () => {
    expect(liveTasks(FIXTURE).map((t) => t.status)).toEqual(["running", "queued"]);
  });

  it("excludes done, failed and cancelled", () => {
    const statuses = new Set(liveTasks(FIXTURE).map((t) => t.status));
    expect(statuses.has("done")).toBe(false);
    expect(statuses.has("failed")).toBe(false);
    expect(statuses.has("cancelled")).toBe(false);
  });
});

describe("unreadTasks — what the drain folds into the preamble", () => {
  it("returns only the done task nobody has claimed", () => {
    expect(unreadTasks(FIXTURE).map((t) => t.id)).toEqual([
      "rsh_01HQZX000000000000UNREAD_DONE",
    ]);
  });

  // The ORDER is the assertion, and it is deliberately the opposite of sortedTasks. A preamble is
  // read as a narrative by the model that then answers the founder; newest-first tells it backwards.
  it("is oldest first, unlike everything the human looks at", () => {
    const two: ResearchTask[] = [
      { ...FIXTURE[2]!, id: "newer", createdAt: 2000 },
      { ...FIXTURE[2]!, id: "older", createdAt: 1000 },
    ];
    expect(unreadTasks(two).map((t) => t.id)).toEqual(["older", "newer"]);
    // …and the human-facing sort really is the other way, so this is a contrast and not a copy.
    expect(sortedTasks(two).map((t) => t.id)).toEqual(["newer", "older"]);
  });

  it("drops a task once it is claimed, so a finding is never re-told forever", () => {
    const claimed = FIXTURE.map((t) =>
      t.status === "done" && t.readAt === null ? { ...t, readAt: 999 } : t,
    );
    expect(unreadTasks(claimed)).toEqual([]);
  });
});

describe("the store is a cache, not the truth", () => {
  it("replaceAll drops tasks that are gone from disk rather than merging them", () => {
    const store = useResearchStore.getState();
    store.replaceAll(FIXTURE);
    expect(allTasksNow()).toHaveLength(FIXTURE.length);

    // A task reaped on disk must not survive in the mirror. Merging would leave it in the row
    // forever, which is the failure mode a merge-shaped update has and a replace does not.
    useResearchStore.getState().replaceAll([FIXTURE[0]!]);
    expect(allTasksNow().map((t) => t.id)).toEqual([FIXTURE[0]!.id]);
  });

  it("upsert replaces a task in place rather than duplicating it", () => {
    const store = useResearchStore.getState();
    store.replaceAll([FIXTURE[1]!]);
    useResearchStore.getState().upsert({ ...FIXTURE[1]!, status: "done", findings: "answered" });

    expect(allTasksNow()).toHaveLength(1);
    expect(allTasksNow()[0]!.status).toBe("done");
  });

  it("starts unhydrated, so the row can tell 'no tasks' from 'not looked yet'", () => {
    expect(useResearchStore.getState().hydrated).toBe(false);
    useResearchStore.getState().replaceAll([]);
    expect(useResearchStore.getState().hydrated).toBe(true);
  });
});
