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
  recentTasks,
  RECENT_RESEARCH_WINDOW_MS,
  markResearchRead,
  refreshResearch,
  sortedTasks,
  unreadTasks,
  useResearchStore,
  visibleTasks,
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

describe("visibleTasks — what the row renders, and what it tears down", () => {
  // The bug in one assertion: the row rendered every task the store had ever seen. The fixture's
  // already-claimed `done` task is the one that has said everything it is going to say.
  it("drops a task the concierge has already been told about", () => {
    const ids = visibleTasks(FIXTURE).map((t) => t.id);
    expect(ids).not.toContain("rsh_01HQZX000000000000CLAIMED_DONE");
    // …and the rest are all still there, so this is a retirement and not a filter that ate the list.
    expect(ids).toHaveLength(FIXTURE.length - 1);
  });

  // THE ONE THAT MUST NEVER REGRESS. A row that retires an undelivered finding has discarded it from
  // the only surface the founder can see, while the drain still believes it is owed.
  it("KEEPS a finished task whose findings are still owed", () => {
    expect(visibleTasks(FIXTURE).map((t) => t.id)).toContain("rsh_01HQZX000000000000UNREAD_DONE");
  });

  it("keeps everything still in flight, so work in progress stays visible", () => {
    const statuses = visibleTasks(FIXTURE).map((t) => t.status);
    expect(statuses).toContain("queued");
    expect(statuses).toContain("running");
  });

  // The 11 red rows. Unclaimed failures are still owed a surfacing, so they stay — the retirement is
  // what happens AFTER they are told, which is the next case.
  it("keeps an unclaimed failed or cancelled task until it has been surfaced", () => {
    const statuses = visibleTasks(FIXTURE).map((t) => t.status);
    expect(statuses).toContain("failed");
    expect(statuses).toContain("cancelled");
  });

  // THE TRANSITION, which is the side effect the whole feature is. Asserting the end states alone
  // would hold for a selector that keyed on `status` and ignored the claim entirely; this pins that
  // stamping the claim is what removes the row, on the SAME list with ONE field changed.
  it("retires a task the moment its claim is stamped, and only then", () => {
    const before = visibleTasks(FIXTURE).map((t) => t.id);
    expect(before).toContain("rsh_01HQZX000000000000000FAILED");

    const claimed = FIXTURE.map((t) =>
      t.id === "rsh_01HQZX000000000000000FAILED" ? { ...t, readAt: 1_754_700_500_000 } : t,
    );
    const after = visibleTasks(claimed).map((t) => t.id);
    expect(after).not.toContain("rsh_01HQZX000000000000000FAILED");
    // Exactly one row went away — nothing else moved.
    expect(after).toHaveLength(before.length - 1);
  });

  // A claim can never retire something still running, whatever else is true of it. Belt and braces
  // against a future edit that drops the `isTerminal` half of the predicate.
  it("never retires a live task, even one carrying a stray claim", () => {
    const odd = FIXTURE.map((t) => (t.status === "running" ? { ...t, readAt: 123 } : t));
    expect(visibleTasks(odd).map((t) => t.status)).toContain("running");
  });

  it("is newest first, like everything else the human looks at", () => {
    const two: ResearchTask[] = [
      { ...FIXTURE[0]!, id: "older", createdAt: 1000 },
      { ...FIXTURE[0]!, id: "newer", createdAt: 2000 },
    ];
    expect(visibleTasks(two).map((t) => t.id)).toEqual(["newer", "older"]);
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

// ══ recentTasks — THE SELECTOR THAT MAKES `+0` READABLE ═════════════════════════════════════════
//
// `liveTasks` above is a GAUGE: it falls back to zero minutes after every burst, which is true and
// unreadable. The founder read `Concierge Agents +0` off a store holding 28 dispatched tasks and
// concluded the concierge never delegates. This selector answers the different question — *has it
// been delegating at all* — and the two must not be conflated, so every test here is paired against
// what `liveTasks` would have said.
describe("recentTasks — has the concierge been delegating at all", () => {
  const NOW = 1_800_000_000_000;
  const HOUR = 60 * 60_000;
  const at = (id: string, agoMs: number, status = "done") =>
    ({ ...FIXTURE[0]!, id, status, createdAt: NOW - agoMs }) as (typeof FIXTURE)[number];

  it("counts finished work that `liveTasks` cannot see — the whole point", () => {
    const tasks = [at("a", HOUR), at("b", 2 * HOUR), at("c", 3 * HOUR)];
    expect(liveTasks(tasks)).toHaveLength(0);
    expect(recentTasks(tasks, NOW)).toHaveLength(3);
  });

  it("counts EVERY terminal status, because a failure is still a delegation", () => {
    const tasks = [
      at("a", HOUR, "done"),
      at("b", HOUR, "failed"),
      at("c", HOUR, "cancelled"),
      at("d", HOUR, "running"),
    ];
    expect(recentTasks(tasks, NOW)).toHaveLength(4);
  });

  it("drops anything outside the window, and the boundary is real", () => {
    expect(recentTasks([at("a", RECENT_RESEARCH_WINDOW_MS)], NOW)).toHaveLength(1);
    expect(recentTasks([at("a", RECENT_RESEARCH_WINDOW_MS + 1)], NOW)).toHaveLength(0);
  });

  // FAIL CLOSED. `createdAt` comes off a JSON file, and `NOW - NaN <= window` is FALSE — so a naive
  // comparison happens to exclude it, which is the safe direction here and is asserted rather than
  // relied on. Inflating this number manufactures evidence of delegation that never happened, which
  // is the one claim it must never make.
  it("excludes a task whose dispatch time cannot be read", () => {
    const broken = { ...FIXTURE[0]!, id: "x", createdAt: Number.NaN };
    expect(recentTasks([broken], NOW)).toHaveLength(0);
  });

  it("is newest-first, like every other selector here", () => {
    const out = recentTasks([at("old", 3 * HOUR), at("new", HOUR)], NOW);
    expect(out.map((t) => t.id)).toEqual(["new", "old"]);
  });

  // THE VALUE, not just the boundary — a calendar day would reset the number at midnight while the
  // founder is in the same working session, re-creating the false zero for a reason that has
  // nothing to do with the concierge.
  it("looks back twelve hours, not a calendar day", () => {
    expect(RECENT_RESEARCH_WINDOW_MS).toBe(12 * 60 * 60_000);
  });
});
