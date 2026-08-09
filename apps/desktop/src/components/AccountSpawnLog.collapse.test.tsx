// @vitest-environment jsdom
//
// "No Need to show the same account multiple times. You can just show it once in terms of what's
// currently signed in." — the founder, looking at ~14 visible rows all reading
// `founder@example.com / picked automatically / limit not learned yet`, with more below the bottom
// of the window.
//
// One row per SPAWN is the wrong unit for a panel whose subject is ACCOUNTS. On a machine with one
// account signed in — which is the exact situation this panel exists to explain — it renders the
// same sentence N times and grows without bound. The ledger data was never wrong; the presentation
// repeated it until the page outgrew the screen.
//
// These assert the collapsed OUTPUT: how many account rows exist for N spawns, and that the count
// is on the row. Asserting that the entries were passed in would have been true before the
// component existed.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountSpawnLog, groupByAccount, SHOW } from "./AccountSpawnLog";
import type { SpawnLogEntry } from "../services/accountLedger";

afterEach(cleanup);

function entry(over: Partial<SpawnLogEntry> = {}): SpawnLogEntry {
  return {
    at: Date.parse("2026-08-08T18:00:00Z"),
    key: "agent-abcdef123456",
    accountId: "personal",
    nickname: "Personal",
    configDir: "/cfg/personal",
    email: "founder@example.com",
    reason: "auto",
    tokens5h: null,
    ceiling: null,
    fraction: null,
    eligibleCount: 1,
    signedInCount: 1,
    candidateIds: ["personal"],
    ...over,
  };
}

/** The founder's ledger: N spawns, one account, every line identical. */
function sameAccount(n: number): SpawnLogEntry[] {
  return Array.from({ length: n }, (_, i) =>
    entry({ at: Date.parse("2026-08-08T18:00:00Z") - i * 60_000, key: `agent-${i}` }),
  );
}

describe("the ledger shows each account once, not each spawn", () => {
  it("collapses N identical spawns to ONE account row carrying the count", async () => {
    render(<AccountSpawnLog read={vi.fn(async () => sameAccount(12))} />);

    // The direct measure of the complaint: the account's name appeared once per spawn. Now once,
    // full stop — `getAllByText` would return 12 against the old rendering.
    const labels = await screen.findAllByText("founder@example.com");
    expect(labels).toHaveLength(1);
    // The count is what replaces the repetition. Without it the collapse would be hiding data
    // rather than summarising it.
    const summary = labels[0]!.parentElement as HTMLElement;
    expect(within(summary).getByText("12 shown")).toBeTruthy();
  });

  // ── THE COUNT IS NOT A TOTAL, AND MUST NOT READ AS ONE ──────────────────────────────────────
  // Collapsing replaced a visibly bounded list of dated rows with a bare cardinal number. Two
  // independent things make that number smaller than the truth, and BOTH are invisible in the
  // rendering unless the copy names them: the read is capped at SHOW and the Rust side truncates to
  // it, and the ledger records selection DECISIONS, skipping a sticky key whose answer did not
  // change. On the founder's machine — one account, hundreds of agents — an unqualified figure
  // would sit at 25 forever while reading as "25 spawns, ever".
  it("says the list is capped when it is, rather than presenting the cap as a total", async () => {
    // Exactly SHOW entries: the only volume `read(SHOW)` can actually return at the boundary, and
    // the state neither of the other cases in this file reaches.
    render(<AccountSpawnLog read={vi.fn(async () => sameAccount(SHOW))} />);

    expect(await screen.findByText(new RegExp(`Newest ${SHOW} recorded selections`))).toBeTruthy();
    expect(screen.getByText(/older ones are not shown/i)).toBeTruthy();
    // The de-dupe is the other half, and it applies whether or not the list is capped.
    expect(screen.getByText(/not re-recorded, so these are not spawn totals/i)).toBeTruthy();
    // The row is scoped to what is shown and names NO denominator — a ratio inside a row labelled
    // with one account reads as "this account has M selections", which is false.
    expect(screen.getByText(`${SHOW} shown`)).toBeTruthy();
  });

  it("does NOT claim truncation when the whole ledger fits", async () => {
    // The paired negative. Without it the capped sentence could render unconditionally and the test
    // above would still pass — the exact vacuity that makes a guard worthless.
    render(<AccountSpawnLog read={vi.fn(async () => sameAccount(3))} />);

    expect(await screen.findByText(/All 3 recorded selections/)).toBeTruthy();
    expect(screen.queryByText(/older ones are not shown/i)).toBeNull();
    // The de-dupe caveat is NOT conditional on truncation — it is true either way.
    expect(screen.getByText(/not re-recorded, so these are not spawn totals/i)).toBeTruthy();
  });

  it("keeps genuinely different accounts as separate rows, newest-used first", async () => {
    // The paired negative for the collapse: if it merged on anything coarser than account identity
    // it would erase the evidence of rotation this panel was built to show.
    render(
      <AccountSpawnLog
        read={vi.fn(async () => [
          entry({ accountId: "b", email: "second@example.com", signedInCount: 2 }),
          entry({ accountId: "a", email: "first@example.com", signedInCount: 2 }),
          entry({ accountId: "a", email: "first@example.com", signedInCount: 2 }),
        ])}
      />,
    );

    expect(await screen.findAllByText("second@example.com")).toHaveLength(1);
    expect(screen.getAllByText("first@example.com")).toHaveLength(1);
    // Order: `b` was used most recently, so it leads. Two rows, with the counts on the right ones.
    expect(screen.getByText("2 shown")).toBeTruthy();
    expect(screen.getByText("1 shown")).toBeTruthy();
  });

  it("keeps every spawn available behind a disclosure — collapsed is not discarded", async () => {
    render(<AccountSpawnLog read={vi.fn(async () => sameAccount(60))} />);

    // Collapsed by default, and UNMOUNTED rather than hidden: 60 rows left in the document would
    // still duplicate every account label and still be paid for on each render.
    const toggle = await screen.findByRole("button", { name: "Show each of the 60 selections" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("spawn-detail-list")).toBeNull();

    fireEvent.click(toggle);

    // Every spawn is there for anyone debugging a specific agent.
    const detail = screen.getByTestId("spawn-detail-list");
    expect(within(detail).getAllByText("founder@example.com")).toHaveLength(60);
    // And opening it cannot re-create the overflow: the list is bounded and scrolls inside itself
    // rather than growing the panel that carried the accounts screen off the window.
    expect(detail.style.overflowY).toBe("auto");
    expect(parseFloat(detail.style.maxHeight)).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Hide the individual selections" }));
    expect(screen.queryByTestId("spawn-detail-list")).toBeNull();
  });
});

describe("groupByAccount", () => {
  it("gives spawns that got NO account their own group rather than dropping them", () => {
    // `accountId: null` is a real, distinct state — the spawn inherited the terminal's login. Using
    // it as a map key directly would collapse it into whatever `undefined` hashes to, or drop it.
    const groups = groupByAccount([
      entry({ accountId: null, email: null, nickname: null, reason: "none" }),
      entry({ accountId: null, email: null, nickname: null, reason: "none" }),
      entry({ accountId: "a", email: "a@example.com" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!).toMatchObject({ accountId: null, count: 2 });
    expect(groups[0]!.label).toMatch(/no account/i);
  });

  it("reads every as-of-now figure off the NEWEST spawn, not an arbitrary one", () => {
    // Entries arrive newest-first. An older spawn's limit fraction describes a machine state that
    // has since moved on, so a summary quoting it would be stale the moment it rendered.
    const groups = groupByAccount([
      entry({ at: 3000, fraction: 0.9 }),
      entry({ at: 2000, fraction: 0.1 }),
      entry({ at: 1000, fraction: 0.2 }),
    ]);
    expect(groups[0]!.newest.at).toBe(3000);
    expect(groups[0]!.newest.fraction).toBe(0.9);
  });

  it("counts DISTINCT reasons so one spawn's reason is never presented as covering all of them", () => {
    // A summary row shows a single reason label. When the underlying spawns disagree, the row has
    // to qualify it — and it can only do that if the grouping counted them.
    const mixed = groupByAccount([
      entry({ reason: "auto" }),
      entry({ reason: "fallback" }),
      entry({ reason: "auto" }),
    ]);
    expect(mixed[0]!.reasonCount).toBe(2);

    // The paired negative: unanimous spawns must report 1, or the qualifier renders unconditionally
    // and the assertion above would pass against a hard-coded value.
    const unanimous = groupByAccount([entry({ reason: "auto" }), entry({ reason: "auto" })]);
    expect(unanimous[0]!.reasonCount).toBe(1);
  });
});
