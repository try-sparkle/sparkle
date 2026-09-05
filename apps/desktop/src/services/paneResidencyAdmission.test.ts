import { describe, it, expect } from "vitest";

import { admitPaneResidency, type PaneResidencyInput } from "./paneResidencyAdmission";

// THE GATE THAT CLOSES THE HOLE (bead `sparkle-ftapmp`).
//
// `agentCapacity` stopped spending a residents-denominated memory ceiling against a count of rows.
// The comment that defended that mismatch gave one reason — "a dormant row becomes resident the
// moment its tab is clicked, with no gate in between" — so this module IS the gate, and these tests
// are what stop it becoming either of the two things it must not be: a no-op (the hole stays open)
// or a virtualiser (panes that never mount, which reads as a dead fleet).

function input(over: Partial<PaneResidencyInput> = {}): PaneResidencyInput {
  return {
    candidateIds: ["a", "b", "c", "d"],
    priorityIds: [null, null],
    residentIds: [],
    residentCeiling: null,
    ...over,
  };
}

describe("admitPaneResidency — no basis to narrow", () => {
  it("admits EVERY candidate when the ceiling is null", () => {
    const v = admitPaneResidency(input({ residentCeiling: null }));
    expect([...v.admitted].sort()).toEqual(["a", "b", "c", "d"]);
    expect(v.deferred).toEqual([]);
  });

  it("admits every candidate when the ceiling is not a finite number", () => {
    // A garbage payload must behave like no payload. The alternative — arithmetic on NaN — silently
    // produces `admitted.size < NaN === false`, i.e. deferring EVERY pane on a machine nobody could
    // measure. Same failure direction the memory cache's own null contract exists to prevent.
    const v = admitPaneResidency(input({ residentCeiling: Number.NaN }));
    expect(v.deferred).toEqual([]);
    expect(v.admitted.size).toBe(4);
  });

  it("DOES defer once a real ceiling arrives — the paired case", () => {
    // Without this, both tests above pass for a gate that admits everything unconditionally, which
    // is exactly the "no-op" failure. Only the ceiling differs from the first test.
    const v = admitPaneResidency(input({ residentCeiling: 2 }));
    expect([...v.admitted].sort()).toEqual(["a", "b"]);
    expect(v.deferred).toEqual(["c", "d"]);
  });
});

describe("admitPaneResidency — spending the budget", () => {
  it("admits in mount order and defers the tail", () => {
    const v = admitPaneResidency(input({ candidateIds: ["a", "b", "c", "d"], residentCeiling: 3 }));
    expect([...v.admitted].sort()).toEqual(["a", "b", "c"]);
    expect(v.deferred).toEqual(["d"]);
  });

  it("defers NOTHING when the fleet already fits under the ceiling", () => {
    const v = admitPaneResidency(input({ candidateIds: ["a", "b"], residentCeiling: 9 }));
    expect(v.deferred).toEqual([]);
    expect(v.admitted.size).toBe(2);
  });

  it("floors a ceiling of zero at one, rather than blanking the window", () => {
    // A zero ceiling would leave a live tab with no pane at all and no explanation on screen — the
    // shape `useStaggeredPaneMounts` calls worse than the burst it exists to spread. `limit` and
    // Rust's own `sampled_admission` floor at 1 for the same reason.
    const v = admitPaneResidency(input({ residentCeiling: 0 }));
    expect(v.admitted.size).toBe(1);
    expect(v.deferred).toEqual(["b", "c", "d"]);
  });

  it("gives the SAME answer when driven twice with the same inputs", () => {
    // Bead `sparkle-yskany`. Nothing here may accumulate between calls: an order- or
    // history-dependent answer would mount and unmount panes on nothing but a re-render, and a
    // `Terminal` unmount kills its PTY.
    const args = input({ residentCeiling: 2 });
    const first = admitPaneResidency(args);
    const second = admitPaneResidency(args);
    expect([...second.admitted].sort()).toEqual([...first.admitted].sort());
    expect(second.deferred).toEqual(first.deferred);
  });
});

describe("admitPaneResidency — what may never be deferred", () => {
  it("keeps an ALREADY-RESIDENT pane admitted even past the ceiling", () => {
    // Unmounting is not a lever this gate has: a `Terminal` unmount KILLS ITS PTY, so evicting a
    // pane to save memory destroys the live work of an agent that was already paying honestly.
    const v = admitPaneResidency(
      input({ candidateIds: ["a", "b", "c", "d"], residentIds: ["c", "d"], residentCeiling: 2 }),
    );
    expect(v.admitted.has("c")).toBe(true);
    expect(v.admitted.has("d")).toBe(true);
    // …and the budget is SPENT by them, so the newcomers are the ones held back.
    expect(v.deferred).toEqual(["a", "b"]);
  });

  it("admits every resident pane even when residency ALREADY exceeds the ceiling", () => {
    // The normal way to arrive here: the reading narrows under a fleet that is already mounted. Hold
    // the line where it is; never walk it back.
    const v = admitPaneResidency(
      input({ candidateIds: ["a", "b", "c", "d"], residentIds: ["a", "b", "c"], residentCeiling: 1 }),
    );
    expect([...v.admitted].sort()).toEqual(["a", "b", "c"]);
    expect(v.deferred).toEqual(["d"]);
  });

  it("keeps the ON-SCREEN pane admitted even when the budget is already spent", () => {
    // A blank stage under a live tab is the worse bug. `d` is last in mount order, so a gate that
    // only honoured the budget would defer exactly it.
    const v = admitPaneResidency(
      input({ candidateIds: ["a", "b", "c", "d"], priorityIds: ["d", null], residentCeiling: 1 }),
    );
    expect(v.admitted.has("d")).toBe(true);
    expect(v.deferred).toContain("c");
  });

  it("COUNTS the on-screen pane against the budget rather than exempting it", () => {
    // The paired case, and the one that keeps the ceiling meaningful: a priority pane displaces a
    // dormant candidate instead of being free. Ceiling 2, one priority → exactly one more admitted.
    const v = admitPaneResidency(
      input({ candidateIds: ["a", "b", "c", "d"], priorityIds: ["d", null], residentCeiling: 2 }),
    );
    expect(v.admitted.size).toBe(2);
    expect(v.admitted.has("d")).toBe(true);
    expect(v.deferred.length).toBe(2);
  });

  it("ignores a priority or resident id that has LEFT the candidate list", () => {
    // A closed agent is not mounted either way, and admitting it would let it skip the budget if it
    // ever came back — the same pruning rule `useStaggeredPaneMounts` keeps for its own queue.
    const v = admitPaneResidency(
      input({
        candidateIds: ["a", "b"],
        priorityIds: ["gone", null],
        residentIds: ["also-gone"],
        residentCeiling: 5,
      }),
    );
    expect(v.admitted.has("gone")).toBe(false);
    expect(v.admitted.has("also-gone")).toBe(false);
    expect([...v.admitted].sort()).toEqual(["a", "b"]);
  });

  it("admits nothing and defers nothing when there are no candidates", () => {
    const v = admitPaneResidency(input({ candidateIds: [], residentCeiling: 1 }));
    expect(v.admitted.size).toBe(0);
    expect(v.deferred).toEqual([]);
  });
});
