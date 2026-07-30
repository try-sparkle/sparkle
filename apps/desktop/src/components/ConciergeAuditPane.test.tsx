// @vitest-environment jsdom
//
// The audit pane — the READER for services/conciergeAudit, which until now had none.
//
// WHAT THESE PIN, AND WHY THEY ARE NOT ASSERTIONS ABOUT THE STORE. The store already has its own
// tests, and they prove the RECORD is right. Asserting here that an entry exists would re-prove
// that and prove nothing about this component: every one of these assertions would pass against a
// pane that rendered an empty <div>. So each test below reads what a human would read on screen —
// the refusal's code AND its sentence, the word a running call shows, the redacted value rather
// than the raw one — and would fail if the pane dropped it.
//
// The store is REAL here (it is a plain zustand store with no IO), driven through the module's own
// recorder so the pane sees exactly the shape controlListener writes. `describeApprovalArgs` is
// real for the same reason it is real in the store's tests: the redaction is the claim.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConciergeAuditPane, AUDIT_ROWS_SHOWN, clockTime } from "./ConciergeAuditPane";
import { noteConciergeAuditCall, _resetConciergeAuditForTests } from "../services/conciergeAudit";

beforeEach(() => _resetConciergeAuditForTests());
afterEach(cleanup);

/** The rendered rows, in the order they appear on screen. */
function rows(): HTMLElement[] {
  return screen.queryAllByTestId("concierge-audit-entry");
}

/** The row whose call name matches `name` (e.g. "workflow.merge_pr"). */
function rowFor(name: string): HTMLElement {
  const row = rows().find((r) => within(r).queryByText(name));
  if (!row) throw new Error(`no rendered row for ${name}`);
  return row;
}

describe("an empty log is an honest empty state, not a blank box", () => {
  it("says what WILL appear here rather than rendering nothing", () => {
    render(<ConciergeAuditPane />);
    const empty = screen.getByTestId("concierge-audit-empty");
    // The sentence has to promise the thing the log is FOR — that refused calls show up too —
    // otherwise an empty pane reads as "this only logs successes, and there were none".
    expect(empty.textContent ?? "").toMatch(/refus/i);
    expect(rows()).toHaveLength(0);
  });
});

describe("every call is on screen, newest first", () => {
  it("renders one row per recorded call, most recent at the top", () => {
    noteConciergeAuditCall("a", "board", "list_items", {}, 1_000)({ ok: true }, 1_010);
    noteConciergeAuditCall("b", "lifecycle", "close_agent", {}, 2_000)({ ok: true }, 2_010);
    noteConciergeAuditCall("c", "workflow", "merge_pr", {}, 3_000)({ ok: true }, 3_010);

    render(<ConciergeAuditPane />);
    const names = rows().map((r) => within(r).getByTestId("concierge-audit-call").textContent);
    expect(names).toEqual(["workflow.merge_pr", "lifecycle.close_agent", "board.list_items"]);
  });

  it("re-renders when a new call is recorded while the pane is open", () => {
    render(<ConciergeAuditPane />);
    expect(rows()).toHaveLength(0);

    // Wrapped in `act` because the write is a store update from OUTSIDE React — which is exactly
    // how the real one arrives (controlListener's dispatch seam, not an event handler).
    act(() => void noteConciergeAuditCall("a", "board", "list_items", {}, 1_000));

    expect(rows()).toHaveLength(1);
    expect(screen.queryByTestId("concierge-audit-empty")).toBeNull();
  });
});

describe("a REFUSED call says why — the entry the log exists for", () => {
  it("renders the refusal code and the sentence the concierge got back", () => {
    noteConciergeAuditCall("tc", "workflow", "merge_pr", { number: 753 }, 1_000)(
      { ok: false, code: "needs-approval", message: "merge_pr needs your go-ahead." },
      1_050,
    );

    render(<ConciergeAuditPane />);
    const row = rowFor("workflow.merge_pr");
    expect(within(row).getByTestId("concierge-audit-outcome").textContent).toMatch(/refused/i);
    // BOTH, and they are different facts: the code is what the concierge can act on, the sentence
    // is what the human reads. A row showing only one of them cannot answer "why didn't it?".
    expect(within(row).getByText("needs-approval")).toBeTruthy();
    expect(within(row).getByText("merge_pr needs your go-ahead.")).toBeTruthy();
  });

  it("a refusal that carried no sentence still says so rather than showing an empty line", () => {
    noteConciergeAuditCall("tc", "workflow", "push_branch", {}, 1_000)(
      { ok: false, code: "denied" },
      1_050,
    );

    render(<ConciergeAuditPane />);
    const row = rowFor("workflow.push_branch");
    expect(within(row).getByText("denied")).toBeTruthy();
    expect(within(row).getByTestId("concierge-audit-reason").textContent?.trim()).toBeTruthy();
  });

  it("does not print a code or a reason on a call that SUCCEEDED", () => {
    noteConciergeAuditCall("tc", "board", "list_items", {}, 1_000)({ ok: true }, 1_010);

    render(<ConciergeAuditPane />);
    const row = rowFor("board.list_items");
    expect(within(row).getByTestId("concierge-audit-outcome").textContent).toMatch(/done/i);
    expect(within(row).queryByTestId("concierge-audit-reason")).toBeNull();
  });
});

describe("a call that never settled READS as still running", () => {
  it("shows the running word, and no duration it cannot know", () => {
    noteConciergeAuditCall("tc", "lifecycle", "spawn_worker", {}, 1_000);

    render(<ConciergeAuditPane />);
    const row = rowFor("lifecycle.spawn_worker");
    expect(within(row).getByTestId("concierge-audit-outcome").textContent).toMatch(/running/i);
    // The duration is derived from `settledAt`, which is null here. Printing "0ms" — or anything —
    // would state a fact the record does not hold.
    expect(within(row).queryByTestId("concierge-audit-duration")).toBeNull();
  });

  it("flips to the settled reading when the reply lands", () => {
    const settle = noteConciergeAuditCall("tc", "lifecycle", "spawn_worker", {}, 1_000);
    render(<ConciergeAuditPane />);
    expect(within(rowFor("lifecycle.spawn_worker")).getByTestId("concierge-audit-outcome").textContent).toMatch(
      /running/i,
    );

    act(() => settle({ ok: true }, 1_250));

    const row = rowFor("lifecycle.spawn_worker");
    expect(within(row).getByTestId("concierge-audit-outcome").textContent).toMatch(/done/i);
    expect(within(row).getByTestId("concierge-audit-duration").textContent).toContain("250ms");
  });
});

describe("the arguments shown are the REDACTED ones", () => {
  it("renders each display-safe key/value line", () => {
    noteConciergeAuditCall("tc", "workspace", "add_project_from_folder", {
      path: "/Users/someone/Projects/thing",
      recurse: true,
    })({ ok: true });

    render(<ConciergeAuditPane />);
    const args = within(rowFor("workspace.add_project_from_folder")).getByTestId(
      "concierge-audit-args",
    );
    expect(within(args).getByText("path")).toBeTruthy();
    expect(within(args).getByText("/Users/someone/Projects/thing")).toBeTruthy();
    expect(within(args).getByText("recurse")).toBeTruthy();
    expect(within(args).getByText("true")).toBeTruthy();
  });

  // THE FIXTURE VALUE MUST CONTAIN NO SECRET-ISH WORD (roborev 55458). The mask is driven by
  // `SECRETISH_KEY` applied to the ARGUMENT NAME, and this case exists to pin that. My first
  // gitleaks-safe replacement was `"fake-not-a-key"` — which matches that same regex on `\bkey\b`,
  // so the test would have passed whether the mask keyed off the name or the value, killing the one
  // distinction it is for. `"plainvalue"` matches no branch of the regex, so a mutant that ORs the
  // VALUE into the predicate (which would render `{ apiKey: "abc123" }` in full) still dies here.
  // Low-entropy, so gitleaks does not flag it either.
  it("shows the MASK for a secret-ish argument, never the value", () => {
    noteConciergeAuditCall("tc", "app", "set_config", { apiKey: "plainvalue" })({ ok: true });

    render(<ConciergeAuditPane />);
    const row = rowFor("app.set_config");
    expect(within(row).getByText("••••••")).toBeTruthy();
    expect(row.textContent ?? "").not.toContain("plainvalue");
  });

  it("renders no argument block at all for a call that took none", () => {
    noteConciergeAuditCall("tc", "board", "list_items", {})({ ok: true });

    render(<ConciergeAuditPane />);
    expect(within(rowFor("board.list_items")).queryByTestId("concierge-audit-args")).toBeNull();
  });
});

// THE TIMESTAMP HAD NO TEST AND ASSERTED A SAME-DAY READING (roborev 55406). The log is
// process-lifetime state pruned only by the row cap, and this app stays open for days — so a bare
// `14:05:03` on a row from Monday reads on Wednesday as "just now". That is the one thing this pane's
// own thesis forbids: it refuses to print `0ms` for a running call because the record does not hold a
// duration, then asserted a day the record does not support either.
describe("a row from another day says so", () => {
  const MONDAY_2PM = new Date(2026, 6, 27, 14, 5, 3).getTime();

  it("prints bare HH:MM:SS for a call made today", () => {
    const today = new Date(2026, 6, 27, 18, 40, 0).getTime();
    expect(clockTime(MONDAY_2PM, today)).toBe("14:05:03");
  });

  it("prefixes the weekday once the call is not from today", () => {
    const wednesday = new Date(2026, 6, 29, 9, 0, 0).getTime();
    expect(clockTime(MONDAY_2PM, wednesday)).toBe("Mon 14:05:03");
  });

  // Same clock reading, different day — the case a same-day-only format renders identically and so
  // cannot distinguish. This is the assertion that would fail if the guard compared only the time.
  it("distinguishes two calls that share a wall-clock time", () => {
    const sameTimeWednesday = new Date(2026, 6, 29, 14, 5, 3).getTime();
    expect(clockTime(MONDAY_2PM, sameTimeWednesday)).not.toBe(
      clockTime(sameTimeWednesday, sameTimeWednesday),
    );
  });

  // THE WEEKDAY WRAPS AT SEVEN DAYS, and the first fix stopped there (roborev 55559). A row from
  // exactly a week ago rendered `Mon 14:05:03` while today is also Monday — the original defect
  // verbatim — and at eight days it read as yesterday. The row-count cap does not prevent this: it
  // bounds how MANY entries are kept, not how old they get, which is the whole reason this function
  // needed a date at all.
  it("spells out the date once a weekday would be ambiguous", () => {
    const oneWeekLater = new Date(2026, 7, 3, 9, 0, 0).getTime(); // also a Monday
    expect(clockTime(MONDAY_2PM, oneWeekLater)).toBe("Jul 27 14:05:03");
    // Six days back is still unambiguous, so it keeps the shorter form.
    const sixDaysLater = new Date(2026, 7, 2, 9, 0, 0).getTime();
    expect(clockTime(MONDAY_2PM, sixDaysLater)).toBe("Mon 14:05:03");
  });

  // THE COLLISION THAT ACTUALLY EXISTED (roborev 55593). The first version of this compared a
  // week-old row against a today row sharing its weekday — which ALREADY differed under weekday-only
  // ("Mon 14:05:03" vs "14:05:03"), so it could not fail for the defect it named. It was vacuous.
  //
  // The pair that genuinely rendered identically is two rows a WEEK APART, both landing on the same
  // weekday, neither of them today: 1 day old and 8 days old both printed "Mon 14:05:03". This
  // assertion is red under weekday-only and green under the three tiers, which is the only thing that
  // makes it evidence.
  it("distinguishes two rows a week apart that fall on the same weekday", () => {
    const tuesday = new Date(2026, 6, 28, 9, 0, 0).getTime();
    const oneDayOld = new Date(2026, 6, 27, 14, 5, 3).getTime(); // Mon
    const eightDaysOld = new Date(2026, 6, 20, 14, 5, 3).getTime(); // also Mon, same wall clock

    expect(clockTime(oneDayOld, tuesday)).toBe("Mon 14:05:03");
    expect(clockTime(eightDaysOld, tuesday)).toBe("Jul 20 14:05:03");
    expect(clockTime(oneDayOld, tuesday)).not.toBe(clockTime(eightDaysOld, tuesday));
  });

  // A clock change (or a row stamped from a future-dated expiry) is the only way this arises. A
  // weekday would be actively misleading — "Wed" for something that has not happened — where a date
  // is merely surprising.
  it("dates a future-stamped row rather than naming a weekday for it", () => {
    const earlier = new Date(2026, 6, 20, 9, 0, 0).getTime();
    expect(clockTime(MONDAY_2PM, earlier)).toBe("Jul 27 14:05:03");
  });

  it("renders the prefixed form in the row a human actually reads", () => {
    const wednesday = new Date(2026, 6, 29, 9, 0, 0).getTime();
    vi.setSystemTime(wednesday);
    try {
      noteConciergeAuditCall("old", "board", "list_items", {}, MONDAY_2PM)({ ok: true }, MONDAY_2PM);
      render(<ConciergeAuditPane />);
      expect(within(rowFor("board.list_items")).getByText("Mon 14:05:03")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the list is bounded, and says so", () => {
  it("renders at most AUDIT_ROWS_SHOWN rows and names how many are older", () => {
    const total = AUDIT_ROWS_SHOWN + 4;
    for (let i = 0; i < total; i++) {
      noteConciergeAuditCall(`id-${i}`, "board", `op_${i}`, {}, 1_000 + i)({ ok: true });
    }

    render(<ConciergeAuditPane />);
    expect(rows()).toHaveLength(AUDIT_ROWS_SHOWN);
    // Truncating SILENTLY is the failure: the reader would take the oldest visible row as the
    // beginning of the record. The count is what makes the cut honest.
    expect(screen.getByTestId("concierge-audit-more").textContent).toContain("4");
  });

  it("says nothing about older calls when everything fits", () => {
    noteConciergeAuditCall("id-0", "board", "list_items", {})({ ok: true });

    render(<ConciergeAuditPane />);
    expect(screen.queryByTestId("concierge-audit-more")).toBeNull();
  });
});
