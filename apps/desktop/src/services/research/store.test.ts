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
  getResearchTail,
  groupTasks,
  liveTasks,
  recentTasks,
  recentWindowLabel,
  RECENT_RESEARCH_WINDOW_LABEL,
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
  // These strings are the contract with research.rs. An `invoke` typo has no compile-time
  // signal, so the names are pinned here and the Rust side has one list to satisfy.
  it("names exactly the commands research.rs implements", () => {
    expect(RESEARCH_COMMANDS).toEqual({
      dispatch: "research_dispatch",
      list: "research_list",
      get: "research_get",
      // The live-tail read — a running task's main-pane view polls this for the child's incremental
      // output (bead sparkle-s7rfc).
      tail: "research_tail",
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
      // An ABSENT model override is sent as an explicit `null`, not dropped. The Rust param is
      // `Option<String>`, which reads a null and an absent key alike, so this is about the wire
      // shape staying legible rather than about correctness — a reader diffing the two dispatch
      // call sites sees the same set of keys either way. `resolve_research_model` treats it as
      // "no override" and pins the depth's own model (bead `sparkle-revqiv`).
      model: null,
    });
  });

  it("forwards a MODEL OVERRIDE when one is given", async () => {
    // The second-model advisor pass is the only caller that sets this, and its whole premise is
    // running on a model DIFFERENT from the planner's — so an override that were silently dropped
    // here would turn second-model review back into self-review with nothing reporting it. Rust
    // refuses an off-list id at dispatch; this pins that the id gets there at all.
    await dispatchResearch({
      question: "why",
      projectId: "p1",
      projectRoot: "/tmp/p1",
      depth: "quick",
      model: "claude-opus-5",
    });
    const [, args] = invokeMock.mock.calls[0]!;
    expect((args as { model: unknown }).model).toBe("claude-opus-5");
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

  it("getResearchTail sends taskId and returns the tail string", async () => {
    invokeMock.mockResolvedValueOnce("→ Bash: git log\nreading the history");
    const tail = await getResearchTail("t3");
    expect(invokeMock).toHaveBeenCalledWith("research_tail", { taskId: "t3" });
    expect(tail).toBe("→ Bash: git log\nreading the history");
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

// THE REVEAL IS AN EVENT, NOT A STICKY VALUE (roborev 63906/63907). The sidebar keys its
// auto-expand on `openTaskSeq` so a repeat click on the same pill after a manual collapse is a fresh
// gesture — `openTaskId` alone could not carry that, since writing the id it already holds is a
// no-op. And a poll must never look like a reveal, so `replaceAll` leaves the seq alone.
describe("setOpenTask — the open GESTURE bumps a seq the reveal keys on", () => {
  it("bumps openTaskSeq on every OPEN, even when the id is unchanged", () => {
    const before = useResearchStore.getState().openTaskSeq;
    useResearchStore.getState().setOpenTask("rsh_a");
    const after1 = useResearchStore.getState().openTaskSeq;
    expect(after1).toBe(before + 1);

    // The SAME id again — the sticky-value bug's trigger. The seq must still advance, because this is
    // a second click the founder made and the group must be able to re-open on it.
    useResearchStore.getState().setOpenTask("rsh_a");
    expect(useResearchStore.getState().openTaskSeq).toBe(after1 + 1);
    expect(useResearchStore.getState().openTaskId).toBe("rsh_a");
  });

  it("does NOT bump the seq when closing (a null), so closing a detail never triggers a reveal", () => {
    useResearchStore.getState().setOpenTask("rsh_a");
    const seq = useResearchStore.getState().openTaskSeq;
    useResearchStore.getState().setOpenTask(null);
    expect(useResearchStore.getState().openTaskSeq).toBe(seq);
    expect(useResearchStore.getState().openTaskId).toBeNull();
  });

  it("replaceAll — the poll path — leaves the seq untouched, so a poll is never a reveal", () => {
    useResearchStore.getState().setOpenTask("rsh_a");
    const seq = useResearchStore.getState().openTaskSeq;
    useResearchStore.getState().replaceAll(FIXTURE);
    expect(useResearchStore.getState().openTaskSeq).toBe(seq);
    // …and the open id survives the poll, which is what makes it sticky across `replaceAll`.
    expect(useResearchStore.getState().openTaskId).toBe("rsh_a");
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
  // AGES ARE EXPRESSED AS FRACTIONS OF THE WINDOW, not in literal hours. These tests are about what
  // the selector MEANS — counts finished work, counts every status, newest-first — and none of them
  // is about the window's size. Written in hours they broke as a body when the window moved 12h → 1h
  // (bead: the founder's "62 recently" said over what period?), which is noise that hides whether
  // the real invariants still hold. Relative ages cannot go stale on the next change either.
  const WIN = RECENT_RESEARCH_WINDOW_MS;
  const at = (id: string, agoMs: number, status = "done") =>
    ({ ...FIXTURE[0]!, id, status, createdAt: NOW - agoMs }) as (typeof FIXTURE)[number];

  it("counts finished work that `liveTasks` cannot see — the whole point", () => {
    const tasks = [at("a", WIN / 4), at("b", WIN / 2), at("c", (WIN * 3) / 4)];
    expect(liveTasks(tasks)).toHaveLength(0);
    expect(recentTasks(tasks, NOW)).toHaveLength(3);
  });

  it("counts EVERY terminal status, because a failure is still a delegation", () => {
    const tasks = [
      at("a", WIN / 2, "done"),
      at("b", WIN / 2, "failed"),
      at("c", WIN / 2, "cancelled"),
      at("d", WIN / 2, "running"),
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
    const out = recentTasks([at("old", (WIN * 3) / 4), at("new", WIN / 4)], NOW);
    expect(out.map((t) => t.id)).toEqual(["new", "old"]);
  });

  // THE VALUE, not just the boundary. An EXACT-VALUE ratchet on purpose: this number is what the
  // row's label claims out loud, so it must never move as a side effect of something else. Changing
  // it is a decision about what the founder reads, and it should cost a deliberate edit here.
  //
  // ONE HOUR at his direction (2026-08-20). A calendar day was rejected long before that and stays
  // rejected: a boundary makes the number reset at midnight mid-session for a reason that has
  // nothing to do with the concierge. One hour is a SLIDING span, so it keeps that property.
  it("looks back one hour — the period the badge states out loud", () => {
    expect(RECENT_RESEARCH_WINDOW_MS).toBe(60 * 60_000);
  });

  // ══ THE ANTI-DRIFT ASSERTION — the reason the label is derived and not typed ═════════════════
  //
  // The original complaint was that `62 recently` never said over WHAT PERIOD. The failure mode of
  // the fix is subtler and worse: a row that states a period it is not enforcing, because a literal
  // "in the last hour" sat beside a constant someone later changed. A stated period is BELIEVED, so
  // a wrong one is worse than none.
  //
  // These two lines are what make that unrepresentable. The boundary is asserted at the exact
  // millisecond, and the words are asserted to be computed FROM that same bound — so the copy
  // cannot describe a window the selector does not enforce.
  it("states the period it actually enforces", () => {
    expect(recentTasks([at("in", RECENT_RESEARCH_WINDOW_MS)], NOW)).toHaveLength(1);
    expect(recentTasks([at("out", RECENT_RESEARCH_WINDOW_MS + 1)], NOW)).toHaveLength(0);
    expect(RECENT_RESEARCH_WINDOW_LABEL).toBe(recentWindowLabel(RECENT_RESEARCH_WINDOW_MS));
    expect(RECENT_RESEARCH_WINDOW_LABEL).toBe("the last hour");
  });
});

// ══ recentWindowLabel — THE WORDS, DERIVED FROM THE ARITHMETIC ═══════════════════════════════════
//
// Small and pure, and tested at more than the one value in use, because the whole point of deriving
// the phrase is that it stays true if the window moves. A helper only ever exercised at its current
// input is a constant wearing a function's clothes.
describe("recentWindowLabel — a window that says its own name", () => {
  it("names the hour the row uses today", () => {
    expect(recentWindowLabel(60 * 60_000)).toBe("the last hour");
  });

  // THE VALUE THIS REPLACED. If the window ever goes back, the copy follows it with no edit — which
  // is the property being bought, so it is asserted rather than assumed.
  it("follows the window back up to twelve hours without a copy change", () => {
    expect(recentWindowLabel(12 * 60 * 60_000)).toBe("the last 12 hours");
  });

  it("handles sub-hour windows, singular and plural", () => {
    expect(recentWindowLabel(30 * 60_000)).toBe("the last 30 minutes");
    expect(recentWindowLabel(60_000)).toBe("the last minute");
  });

  // NEVER "the last 1.5 hours" — a non-integer hour count falls back to minutes rather than
  // rendering a decimal into a badge a human scans.
  it("falls back to minutes rather than printing a fractional hour", () => {
    expect(recentWindowLabel(90 * 60_000)).toBe("the last 90 minutes");
  });
});

// ══ groupTasks — WHAT THE EXPANDED GROUP RENDERS, AND WHY THE LABEL CAN NO LONGER LIE ═══════════
//
// THE BUG, exactly: the header's `· N recently` badge is `recentTasks` (which KEEPS retired tasks)
// and the group rendered `visibleTasks` (which drops them). Replayed against the founder's records
// at the moment of his screenshot: live 0, recent 15, rendered 0 — a row promising fifteen children
// and opening onto nothing. Every test here is written against BOTH inputs, because the defect was
// never in either selector; it was in the two of them being different answers to one question.
describe("groupTasks — the live rows AND the recently-finished ones", () => {
  const NOW = 1_800_000_000_000;
  /** Ages relative to the window, for the reason given in `recentTasks` above. */
  const WIN = RECENT_RESEARCH_WINDOW_MS;
  /** A task `agoMs` old. `readAt` non-null on a terminal status is what RETIRES it (isRetired). */
  const at = (
    id: string,
    agoMs: number,
    status: ResearchTask["status"] = "done",
    readAt: number | null = null,
  ): ResearchTask => ({ ...FIXTURE[0]!, id, status, createdAt: NOW - agoMs, readAt });

  // THE FOUNDER'S CLICK, at the selector level. A store of nothing but retired tasks inside the
  // window: `visibleTasks` is empty (the group had no rows to draw) and `groupTasks` is not. Seeding
  // a live task here would make this pass against the very bug it exists to catch.
  it("renders a store of ONLY retired tasks — the exact dead click", () => {
    const retired = [
      at("a", WIN / 4, "done", NOW - WIN / 4),
      at("b", WIN / 2, "failed", NOW - WIN / 4),
    ];
    expect(visibleTasks(retired)).toHaveLength(0);
    expect(recentTasks(retired, NOW)).toHaveLength(2);
    expect(groupTasks(retired, NOW).map((t) => t.id)).toEqual(["a", "b"]);
  });

  // THE INVARIANT THE WHOLE CHANGE IS FOR, stated as a property rather than a count: whatever the
  // badge counts, the click shows. Asserted over a mixed store so it is not satisfiable by "returns
  // everything" — the out-of-window retired task below proves the set is genuinely bounded.
  it("contains every task the `· N recently` badge counts", () => {
    const tasks = [
      at("live_recent", WIN / 4, "running"),
      at("retired_recent", WIN / 2, "done", NOW - WIN / 4),
      at("owed_recent", (WIN * 3) / 4, "done"),
      at("retired_old", 30 * WIN, "cancelled", NOW - 29 * WIN),
    ];
    const badge = recentTasks(tasks, NOW);
    const group = groupTasks(tasks, NOW);
    expect(badge.length).toBeGreaterThan(0);
    for (const t of badge) expect(group.map((g) => g.id)).toContain(t.id);
    // …and it is a BOUND, not "everything": the retired task outside the window is in neither.
    expect(group.map((t) => t.id)).not.toContain("retired_old");
  });

  // THE OTHER HALF OF THE UNION, and the reason it is not simply `recentTasks`: a `deep` run started
  // fourteen hours ago and still going is live work the founder must be able to reach. Bounding the
  // group by the dispatch window alone would tear its row out from under him mid-run.
  it("keeps a LIVE task that is older than the window, which `recentTasks` alone would drop", () => {
    const tasks = [at("long_runner", 14 * WIN, "running")];
    expect(recentTasks(tasks, NOW)).toHaveLength(0);
    expect(groupTasks(tasks, NOW).map((t) => t.id)).toEqual(["long_runner"]);
  });

  // A task inside the window that is NOT retired is in both input sets. One row, not two — a
  // duplicate here is a duplicate React key as well as a duplicate row.
  it("dedupes a task that both selectors return", () => {
    const tasks = [at("both", WIN / 4, "running"), at("both_terminal", WIN / 2, "failed")];
    expect(visibleTasks(tasks)).toHaveLength(2);
    expect(recentTasks(tasks, NOW)).toHaveLength(2);
    const group = groupTasks(tasks, NOW);
    expect(group).toHaveLength(2);
    expect(new Set(group.map((t) => t.id)).size).toBe(group.length);
  });

  it("is newest-first, through the store's one sort", () => {
    const tasks = [
      at("old_retired", (WIN * 3) / 4, "done", NOW - WIN / 4),
      at("mid_live", WIN / 2, "running"),
      at("new_retired", WIN / 4, "cancelled", NOW - 10),
    ];
    expect(groupTasks(tasks, NOW).map((t) => t.id)).toEqual([
      "new_retired",
      "mid_live",
      "old_retired",
    ]);
  });

  // The window is the label's window. A second bound here is how the two would drift apart again,
  // so the default is asserted to BE `RECENT_RESEARCH_WINDOW_MS` at its exact boundary.
  it("bounds retired rows by the same window the label states", () => {
    const inside = at("in", RECENT_RESEARCH_WINDOW_MS, "done", NOW - 1);
    const outside = at("out", RECENT_RESEARCH_WINDOW_MS + 1, "done", NOW - 1);
    expect(groupTasks([inside, outside], NOW).map((t) => t.id)).toEqual(["in"]);
  });
});
