// @vitest-environment jsdom
//
// useThreadScrubber — the rail's controller (bead sparkle-7m719).
//
// EVERY ASSERTION IS ON WHAT THE CONTROLLER PRODUCED — the markers it exposes, the id it jumped to,
// the backlog it grew — never on whether a query or a loader was merely called. "loadBack ran" is
// the precondition; "the turn is now loaded and the jump went to it" is the claim.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SCOPE_MS,
  fractionOf,
  setThreadScrubberIo,
  useThreadScrubber,
  type ScrubberMarker,
  type ScrubberScope,
  type ThreadScrubberController,
} from "./useThreadScrubber";
import {
  setConciergeBacklogIo,
  useConciergeBacklogStore,
} from "../../stores/conciergeBacklogStore";
import { setConciergeChat, useConciergeThreadStore } from "../../stores/conciergeThreadStore";
import type { PromptMarkerRow, HistoryRangeRow } from "../../services/history";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

function marker(id: string, atMs: number): PromptMarkerRow {
  return { id, createdAt: atMs, textPrefix: `prefix of ${id}` };
}

/** Mount the hook and expose its latest controller. */
function mount(deps: Parameters<typeof useThreadScrubber>[0] = {}) {
  const seen: ThreadScrubberController[] = [];
  function Probe() {
    seen.push(useThreadScrubber(deps));
    return null;
  }
  const utils = render(<Probe />);
  return {
    ...utils,
    latest: () => seen[seen.length - 1]!,
    renders: () => seen.length,
  };
}

beforeEach(() => {
  useConciergeBacklogStore.getState().clear();
  setConciergeChat([]);
  setThreadScrubberIo({ now: () => NOW, promptsInRange: async () => [] });
  setConciergeBacklogIo({ now: () => NOW, entriesInRange: async () => [] });
});

afterEach(() => cleanup());

describe("markers", () => {
  it("fetches the scope's window and numbers the dots 1-based in ascending time", async () => {
    const windows: Array<[number, number]> = [];
    setThreadScrubberIo({
      promptsInRange: async (fromMs, toMs) => {
        windows.push([fromMs, toMs]);
        return [marker("a", NOW - 90 * MINUTE), marker("b", NOW - 10 * MINUTE)];
      },
    });

    const h = mount({ initialScope: "3h" });
    await act(async () => {});

    expect(windows[0]).toEqual([NOW - SCOPE_MS["3h"], NOW]);
    expect(h.latest().markers.map((m) => [m.id, m.index])).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  it("re-fetches on a scope change, against the NEW scope's window", async () => {
    const windows: Array<[number, number]> = [];
    setThreadScrubberIo({
      promptsInRange: async (fromMs, toMs) => {
        windows.push([fromMs, toMs]);
        return [];
      },
    });

    const h = mount({ initialScope: "1h" });
    await act(async () => {});
    await act(async () => {
      h.latest().setScope("1y");
    });

    expect(windows.at(-1)).toEqual([NOW - SCOPE_MS["1y"], NOW]);
    expect(h.latest().scope).toBe("1y");
  });

  // ── THE STALE-FETCH RACE ──────────────────────────────────────────────────────────────────────
  // A wide scope is the SLOW query by construction, so it very often lands after the narrow one that
  // superseded it. Without a ticket, a year of dots is painted onto a one-hour axis.
  it("ignores a slow fetch that resolves after a newer one", async () => {
    const gates: Array<(rows: PromptMarkerRow[]) => void> = [];
    setThreadScrubberIo({
      promptsInRange: () =>
        new Promise<PromptMarkerRow[]>((resolve) => {
          gates.push(resolve);
        }),
    });

    const h = mount({ initialScope: "1y" });
    await act(async () => {});
    await act(async () => {
      h.latest().setScope("1h");
    });
    expect(gates.length).toBe(2);

    // The FRESH one lands first…
    await act(async () => {
      gates[1]!([marker("fresh", NOW - MINUTE)]);
    });
    // …and then the superseded one, holding a year of dots.
    await act(async () => {
      gates[0]!([marker("stale-1", NOW - 300 * 24 * 60 * MINUTE), marker("stale-2", NOW)]);
    });

    expect(h.latest().markers.map((m) => m.id)).toEqual(["fresh"]);
  });

  // A prompt sent RIGHT NOW must get its dot without a reload.
  it("re-fetches when the live thread gains a new `you` message", async () => {
    let calls = 0;
    setThreadScrubberIo({
      promptsInRange: async () => {
        calls++;
        return calls === 1 ? [] : [marker("just-sent", NOW)];
      },
    });

    const h = mount({ initialScope: "1d" });
    await act(async () => {});
    expect(h.latest().markers).toEqual([]);

    await act(async () => {
      setConciergeChat([{ id: "just-sent", kind: "you", text: "hello" }]);
    });

    expect(h.latest().markers.map((m) => m.id)).toEqual(["just-sent"]);
  });

  it("does NOT re-fetch when only a sparkle reply grows", async () => {
    let calls = 0;
    setThreadScrubberIo({
      promptsInRange: async () => {
        calls++;
        return [];
      },
    });
    setConciergeChat([{ id: "you-1", kind: "you", text: "q" }]);

    mount({ initialScope: "1d" });
    await act(async () => {});
    const after = calls;

    await act(async () => {
      setConciergeChat([
        { id: "you-1", kind: "you", text: "q" },
        { id: "brain-1", kind: "sparkle", text: "streaming…" },
      ]);
    });

    expect(calls).toBe(after);
  });
});

describe("fractionOf", () => {
  it("puts the oldest edge at 0 and now at 1", () => {
    expect(fractionOf(NOW - 60 * MINUTE, NOW, 60 * MINUTE)).toBe(0);
    expect(fractionOf(NOW, NOW, 60 * MINUTE)).toBe(1);
    expect(fractionOf(NOW - 30 * MINUTE, NOW, 60 * MINUTE)).toBeCloseTo(0.5);
  });

  it("clamps a marker older than the window rather than reporting a negative position", () => {
    expect(fractionOf(NOW - 10 * 60 * MINUTE, NOW, 60 * MINUTE)).toBe(0);
  });
});

describe("onPick", () => {
  const old: ScrubberMarker = {
    id: "you-ancient",
    createdAt: NOW - 3 * 24 * 60 * MINUTE,
    textPrefix: "three days ago",
    index: 1,
  };

  // ── THE BEHAVIOUR THE WHOLE BEAD IS GATED ON ─────────────────────────────────────────────────
  // The founder's goal is "dragging to an old prompt actually loads and scrolls to it". The
  // side effect asserted here is that the turn IS IN THE STORE the thread renders from at the moment
  // the jump is issued — not that `loadBack` was called.
  it("pages an unloaded turn in BEFORE it jumps to it", async () => {
    const rows: HistoryRangeRow[] = [
      { id: "you-ancient", kind: "prompt", createdAt: old.createdAt, text: "what did we decide" },
    ];
    setConciergeBacklogIo({ entriesInRange: async () => rows });
    /** What the backlog held at the instant the jump fired — the ordering is the feature. */
    const loadedWhenJumped: string[] = [];
    const jumped: string[] = [];

    const h = mount({
      onJump: (id) => {
        jumped.push(id);
        loadedWhenJumped.push(
          ...useConciergeBacklogStore.getState().backlog.map((m) => m.id),
        );
      },
    });
    await act(async () => {});

    // Precondition, stated so the assertion below cannot be true for the wrong reason.
    expect(useConciergeBacklogStore.getState().backlog).toEqual([]);

    await act(async () => {
      h.latest().onPick(old);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(jumped).toEqual(["you-ancient"]);
    expect(loadedWhenJumped).toContain("you-ancient");
  });

  it("jumps straight to a turn the live thread is already showing, without a query", async () => {
    let queries = 0;
    setConciergeBacklogIo({
      entriesInRange: async () => {
        queries++;
        return [];
      },
    });
    setConciergeChat([{ id: "you-here", kind: "you", text: "still on screen" }]);
    const jumped: string[] = [];

    const h = mount({ onJump: (id) => jumped.push(id) });
    await act(async () => {});

    await act(async () => {
      h.latest().onPick({ ...old, id: "you-here" });
      await Promise.resolve();
    });

    expect(jumped).toEqual(["you-here"]);
    expect(queries).toBe(0);
  });

  it("still jumps when the page came back empty, rather than swallowing the pick", async () => {
    setConciergeBacklogIo({ entriesInRange: async () => [] });
    const jumped: string[] = [];

    const h = mount({ onJump: (id) => jumped.push(id) });
    await act(async () => {});
    await act(async () => {
      h.latest().onPick(old);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(jumped).toEqual(["you-ancient"]);
  });

  it("moves the handle to the picked dot's own place on the track", async () => {
    setConciergeBacklogIo({ entriesInRange: async () => [] });
    const h = mount({ initialScope: "1d" });
    await act(async () => {});

    const halfADayAgo: ScrubberMarker = {
      id: "mid",
      createdAt: NOW - SCOPE_MS["1d"] / 2,
      textPrefix: "mid",
      index: 1,
    };
    await act(async () => {
      h.latest().onPick(halfADayAgo);
      await Promise.resolve();
    });

    expect(h.latest().position).toBeCloseTo(0.5);
  });
});

describe("onSeek", () => {
  it("clamps a drag that left the track", async () => {
    const h = mount();
    await act(async () => {});

    act(() => h.latest().onSeek(-0.4, null));
    expect(h.latest().position).toBe(0);
    act(() => h.latest().onSeek(1.9, null));
    expect(h.latest().position).toBe(1);
  });
});

describe("scopes", () => {
  // The entitlement stub in services/credits.ts returns a hardcoded "24h"; reading it would grey out
  // twelve of the thirteen scopes for a limit that does not apply to concierge rows at all
  // (history.rs excludes source='concierge' from the age prune). This pins that every scope resolves
  // to a real span, so a future edit that gates them has to break a test to do it.
  it("every scope in the contract has a live span", () => {
    const all: ScrubberScope[] = [
      "1h",
      "3h",
      "6h",
      "12h",
      "1d",
      "3d",
      "7d",
      "1w",
      "2w",
      "1m",
      "3m",
      "6m",
      "1y",
    ];
    for (const s of all) expect(SCOPE_MS[s]).toBeGreaterThan(0);
    expect(SCOPE_MS["1y"]).toBeGreaterThan(SCOPE_MS["6m"]);
  });
});

describe("loading", () => {
  it("reports the backlog's own load, so the rail can say a pick is still working", async () => {
    let release: (rows: HistoryRangeRow[]) => void = () => {};
    setConciergeBacklogIo({
      entriesInRange: () =>
        new Promise<HistoryRangeRow[]>((resolve) => {
          release = resolve;
        }),
    });

    const h = mount();
    await act(async () => {});
    expect(h.latest().loading).toBe(false);

    await act(async () => {
      h.latest().onPick({
        id: "far",
        createdAt: NOW - 10 * 24 * 60 * MINUTE,
        textPrefix: "far",
        index: 1,
      });
      await Promise.resolve();
    });
    expect(h.latest().loading).toBe(true);

    await act(async () => {
      release([]);
      await Promise.resolve();
    });
    expect(h.latest().loading).toBe(false);
  });
});

describe("the live thread store is the source of `already loaded`", () => {
  it("treats a turn in the backlog as loaded too", async () => {
    let queries = 0;
    setConciergeBacklogIo({
      entriesInRange: async () => {
        queries++;
        return [
          { id: "paged", kind: "prompt", createdAt: NOW - 5 * MINUTE, text: "paged in" },
        ];
      },
    });
    const jumped: string[] = [];
    const h = mount({ onJump: (id) => jumped.push(id) });
    await act(async () => {});

    const m: ScrubberMarker = {
      id: "paged",
      createdAt: NOW - 5 * MINUTE,
      textPrefix: "paged in",
      index: 1,
    };
    await act(async () => {
      h.latest().onPick(m);
      await Promise.resolve();
      await Promise.resolve();
    });
    const afterFirst = queries;

    await act(async () => {
      h.latest().onPick(m);
      await Promise.resolve();
    });

    expect(queries).toBe(afterFirst);
    expect(jumped).toEqual(["paged", "paged"]);
    expect(useConciergeThreadStore.getState().chat).toEqual([]);
  });
});

// ── A REJECTED QUERY IS NOT AN EMPTY ONE (roborev 66443) ────────────────────────────────────────
//
// The `failed` flag was added with only its PRESENTATIONAL half pinned: `scrubberHandleLabel`'s
// branch was mutation-checked, but nothing ever passed it `true`, so `setFailed(true)` in the
// catch, `setFailed(false)` on the next success, and the `failed={scrubber.failed}` hand-off in
// ConciergeColumn could each be deleted with the suite green.
//
// That is the SAME shape as this branch's worst bug: the two Tauri commands the rail depends on
// were missing from `generate_handler!` for four commits, every query rejected, and the view layer
// was fully tested while the wire was not. So these rows drive the producer.
describe("a rejected history query is recorded, not swallowed", () => {
  it("sets failed and clears the markers when the query REJECTS", async () => {
    setThreadScrubberIo({
      now: () => NOW,
      promptsInRange: async () => {
        throw new Error("command not found: history_prompts_in_range");
      },
    });
    const h = mount({ initialScope: "1d" });
    await act(async () => {});

    expect(h.latest().failed).toBe(true);
    expect(h.latest().markers).toEqual([]);
    expect(h.latest().loading).toBe(false);
  });

  // THE PAIRED CASE, and the one that pins the commit's stated behaviour ("cleared on the next
  // success, so a transient failure does not stick"). Without it, `setFailed(false)` is dead code.
  it("clears failed on the next SUCCESSFUL fetch", async () => {
    let reject = true;
    setThreadScrubberIo({
      now: () => NOW,
      promptsInRange: async () => {
        if (reject) throw new Error("bridge down");
        return [marker("m1", NOW - MINUTE)];
      },
    });
    const h = mount({ initialScope: "1d" });
    await act(async () => {});
    expect(h.latest().failed).toBe(true);

    // A scope change re-fetches, and this time the bridge answers.
    reject = false;
    await act(async () => {
      h.latest().setScope("7d");
    });
    await act(async () => {});

    expect(h.latest().failed).toBe(false);
    expect(h.latest().markers.map((m: ScrubberMarker) => m.id)).toEqual(["m1"]);
  });

  // …and a query that simply returns nothing must NOT set the flag, or every quiet week would
  // report a broken bridge and the distinction would be worthless in the other direction.
  it("does NOT set failed when the query succeeds with no rows", async () => {
    setThreadScrubberIo({ now: () => NOW, promptsInRange: async () => [] });
    const h = mount({ initialScope: "1d" });
    await act(async () => {});

    expect(h.latest().failed).toBe(false);
    expect(h.latest().markers).toEqual([]);
  });
});
