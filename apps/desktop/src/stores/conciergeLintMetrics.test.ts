import { readFileSync } from "node:fs";

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  useConciergeLintMetrics,
  checkTotals,
  correctionRate,
  LINT_CHECK_IDS,
  LINT_ACTIONS,
  type LintCheckId,
  type LintAction,
} from "./conciergeLintMetrics";

const zeroChecks = (): Record<LintCheckId, number> =>
  Object.fromEntries(LINT_CHECK_IDS.map((c) => [c, 0])) as Record<LintCheckId, number>;
const zeroActions = (): Record<LintAction, number> =>
  Object.fromEntries(LINT_ACTIONS.map((a) => [a, 0])) as Record<LintAction, number>;

describe("useConciergeLintMetrics — session-scoped increments", () => {
  beforeEach(() => {
    useConciergeLintMetrics.getState().reset();
  });

  it("starts every counter at zero (reset-on-launch: the store is in-memory only)", () => {
    const s = useConciergeLintMetrics.getState();
    expect(Object.values(s.checks).every((n) => n === 0)).toBe(true);
    expect(Object.values(s.actions).every((n) => n === 0)).toBe(true);
    // Every check has a key from the start, so a check that fired ZERO times is a readable reading
    // rather than an absent row.
    expect(Object.keys(s.checks).sort()).toEqual([...LINT_CHECK_IDS].sort());
  });

  it("INCREMENTS the check that fired and the action taken — and nothing else", () => {
    const { recordViolation } = useConciergeLintMetrics.getState();
    recordViolation("relay-paste", "revised");
    recordViolation("relay-paste", "revised");
    recordViolation("hedge-words", "warned");

    const s = useConciergeLintMetrics.getState();
    expect(s.checks["relay-paste"]).toBe(2);
    expect(s.checks["hedge-words"]).toBe(1);
    expect(s.checks["bare-pr-number"]).toBe(0);
    expect(s.actions.revised).toBe(2);
    expect(s.actions.warned).toBe(1);
    expect(s.actions.autofixed).toBe(0);
  });

  it("adds `count` occurrences, so a reply with three hedge words counts three", () => {
    // The JSONL record carries `count`; if the counter added 1 per record the two readouts shown
    // side by side would disagree, and the human could not tell which was wrong.
    useConciergeLintMetrics.getState().recordViolation("hedge-words", "warned", 3);
    const s = useConciergeLintMetrics.getState();
    expect(s.checks["hedge-words"]).toBe(3);
    expect(s.actions.warned).toBe(3);
  });

  it("ignores a non-finite or non-positive count rather than poisoning the tally", () => {
    const { recordViolation } = useConciergeLintMetrics.getState();
    recordViolation("relay-paste", "revised", 2);
    recordViolation("relay-paste", "revised", Number.NaN);
    recordViolation("relay-paste", "revised", 0);
    recordViolation("relay-paste", "revised", -5);

    const s = useConciergeLintMetrics.getState();
    // NaN is STICKY: one NaN increment makes every later read NaN forever, so the guard has to be
    // at the increment, not at the display.
    expect(s.checks["relay-paste"]).toBe(2);
    expect(s.actions.revised).toBe(2);
  });

  it("keeps the check total and the action total in agreement", () => {
    const { recordViolation } = useConciergeLintMetrics.getState();
    recordViolation("relay-paste", "revised", 2);
    recordViolation("bare-agent-name", "autofixed");
    recordViolation("naked-file-ref", "warned", 4);

    const s = useConciergeLintMetrics.getState();
    const byCheck = Object.values(s.checks).reduce((a, b) => a + b, 0);
    const byAction = Object.values(s.actions).reduce((a, b) => a + b, 0);
    expect(byCheck).toBe(7);
    expect(byAction).toBe(7);
  });

  it("reset() zeroes every tally", () => {
    const st = useConciergeLintMetrics.getState();
    st.recordViolation("relay-paste", "revised");
    st.recordViolation("hedge-words", "warned", 9);
    expect(useConciergeLintMetrics.getState().checks["relay-paste"]).toBe(1);

    st.reset();

    const s = useConciergeLintMetrics.getState();
    expect(s.checks["relay-paste"]).toBe(0);
    expect(s.checks["hedge-words"]).toBe(0);
    expect(s.actions.revised).toBe(0);
    expect(s.actions.warned).toBe(0);
  });

  it("holds ONLY count keys — no reply text, span, hash, or turn id can land in the store", () => {
    const st = useConciergeLintMetrics.getState();
    st.recordViolation("relay-paste", "revised", 1);
    st.recordViolation("bare-agent-name", "autofixed");

    const s = useConciergeLintMetrics.getState();
    // Every stored value is a number, and the key sets are exactly the fixed enums. That is the
    // whole privacy claim: there is nowhere in this shape for text to go.
    for (const rec of [s.checks, s.actions]) {
      for (const v of Object.values(rec)) expect(typeof v).toBe("number");
    }
    expect(Object.keys(s.checks).sort()).toEqual(
      [
        // The only BLOCKING check, and the one this list omitted while it shipped: with no column
        // here its violations were silently uncounted, which reads on the drift readout as "the
        // check never fires". `conciergeLintRegistry.test.ts` now derives this requirement from the
        // linter's own registry, so a future check cannot go uncounted the same way.
        "ask-without-action",
        "bare-agent-name",
        "bare-pr-number",
        "fat-pill-label",
        "unresolved-agent-pill",
        "relay-paste",
        "actions-first",
        "unreported-refusal",
        "hedge-words",
        "restated-state",
        "naked-file-ref",
      ].sort(),
    );
    expect(Object.keys(s.actions).sort()).toEqual(
      ["warned", "autofixed", "revised", "rendered_marked"].sort(),
    );
    // The store's own state has no other fields than the two count records plus its two actions.
    expect(Object.keys(s).sort()).toEqual(
      ["actions", "checks", "recordViolation", "reset"].sort(),
    );
  });

  it("performs no storage write when a violation is recorded", () => {
    // The cheap runtime half of the privacy claim: catches a hand-rolled write added to
    // `recordViolation`. It does NOT catch a `persist(...)` wrapper — see the source pin below for
    // why that needs a different kind of assertion.
    const setItem = vi.spyOn(localStorage, "setItem");
    try {
      useConciergeLintMetrics.getState().recordViolation("relay-paste", "revised");
      useConciergeLintMetrics.getState().recordViolation("hedge-words", "warned", 3);
      expect(setItem).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
    }
    // Prove the spy would have SEEN a write — otherwise `not.toHaveBeenCalled()` could be green
    // because it was attached to the wrong object.
    const setItem2 = vi.spyOn(localStorage, "setItem");
    localStorage.setItem("sentinel", "1");
    expect(setItem2).toHaveBeenCalledTimes(1);
    setItem2.mockRestore();
    localStorage.removeItem("sentinel");
  });

  it("SOURCE PIN: the store neither persists nor reaches the network", () => {
    // roborev 55657 (Medium). The header claims "NOT persisted and NEVER hits the network"; two
    // earlier attempts at guarding it were vacuous, and understanding WHY decides the assertion:
    //
    //   1. Comparing localStorage's key set before/after cannot work — `persist` writes on every
    //      `setState`, and `beforeEach` already calls `reset()`, so the key is in BOTH snapshots;
    //      and the counts live in the VALUE of one fixed key, which a key-set diff never reads.
    //   2. Spying on `setItem` cannot work either, and this was measured, not assumed: wrapping this
    //      store in `persist(...)` and re-running produced ZERO storage writes and no `store.persist`
    //      API in this environment (zustand's persist degrades to a silent no-op when it cannot
    //      resolve a usable Storage, and Node's stub-with-a-shim setup is exactly that case). A
    //      regression that is invisible at runtime cannot be caught at runtime.
    //
    // So pin the SOURCE — the same idiom `concierge_lint_log.rs` uses to pin this file's action
    // vocabulary, and the same idiom `roborev-cadence.test.sh` uses for a doc. This fails the moment
    // someone adds the middleware or a write, which is the actual regression.
    const src = readFileSync(new URL("./conciergeLintMetrics.ts", import.meta.url), "utf8");
    // Strip comments first: the privacy header discusses persistence and the network at length, and
    // matching prose would make every assertion below trivially true.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");

    expect(code).not.toMatch(/zustand\/middleware/);
    expect(code).not.toMatch(/\bpersist\b/);
    expect(code).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    // No network and no Tauri command: the counts must not leave the process. (The JSONL sink is
    // written from the linter's own call site, not from here — that separation is the point.)
    expect(code).not.toMatch(/\bfetch\b|XMLHttpRequest|WebSocket/);
    expect(code).not.toMatch(/\binvoke\b|@tauri-apps/);
    // Non-vacuous: the pin is reading the real file, not an empty string.
    expect(code).toMatch(/export const useConciergeLintMetrics/);
  });
});

describe("checkTotals", () => {
  it("returns no rows and a zero total when nothing has fired", () => {
    expect(checkTotals(zeroChecks())).toEqual({ rows: [], total: 0 });
  });

  it("ranks the checks that fired busiest-first and sums the grand total", () => {
    const t = checkTotals({
      ...zeroChecks(),
      "relay-paste": 5,
      "hedge-words": 12,
      "naked-file-ref": 1,
    });
    expect(t.rows).toEqual([
      { check: "hedge-words", count: 12 },
      { check: "relay-paste", count: 5 },
      { check: "naked-file-ref", count: 1 },
    ]);
    expect(t.total).toBe(18);
  });

  it("breaks ties on the check id so the row order is stable across renders", () => {
    const t = checkTotals({ ...zeroChecks(), "relay-paste": 3, "actions-first": 3, "bare-pr-number": 3 });
    expect(t.rows.map((r) => r.check)).toEqual(["actions-first", "bare-pr-number", "relay-paste"]);
  });

  it("omits zero-count checks from the rows but still counts them in the total", () => {
    const t = checkTotals({ ...zeroChecks(), "relay-paste": 2 });
    expect(t.rows).toHaveLength(1);
    expect(t.total).toBe(2);
  });
});

describe("correctionRate", () => {
  it("returns null pct when nothing has fired yet (0/0 is not a rate of zero)", () => {
    expect(correctionRate(zeroActions())).toEqual({ corrected: 0, uncorrected: 0, pct: null });
  });

  it("counts autofixed + revised as corrected, warned + rendered_marked as not", () => {
    const r = correctionRate({ warned: 1, autofixed: 2, revised: 1, rendered_marked: 0 });
    expect(r.corrected).toBe(3);
    expect(r.uncorrected).toBe(1);
    expect(r.pct).toBeCloseTo(0.75, 5);
  });

  it("treats rendered_marked as UNcorrected — it is the give-up path, not a fix", () => {
    const r = correctionRate({ warned: 0, autofixed: 0, revised: 0, rendered_marked: 4 });
    expect(r.corrected).toBe(0);
    expect(r.uncorrected).toBe(4);
    expect(r.pct).toBe(0);
  });
});
