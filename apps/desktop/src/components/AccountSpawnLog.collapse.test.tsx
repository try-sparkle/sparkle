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
    expect(within(summary).getByText("12 agents")).toBeTruthy();
  });

  // ── THE "recorded selections" CAPTION IS REMOVED (founder's ask, 2026-08-21 live session) ────
  // It read "Newest 25 recorded selections; older ones are not shown … not spawn totals". The
  // founder found it noise and cut it; the account row now carries a bare "N agents" count. This
  // pins the removal so the caption cannot creep back, and confirms the count still renders. It is
  // non-vacuous: were the caption present, the queryByText(...).toBeNull() assertions would fail.
  it("shows a bare agent count and NO 'recorded selections' caption", async () => {
    render(<AccountSpawnLog read={vi.fn(async () => sameAccount(SHOW))} />);

    expect(await screen.findByText(`${SHOW} agents`)).toBeTruthy();
    expect(screen.queryByText(/recorded selections/i)).toBeNull();
    expect(screen.queryByText(/older ones are not shown/i)).toBeNull();
    expect(screen.queryByText(/not spawn totals/i)).toBeNull();
  });

  it("keeps genuinely different accounts as separate rows, newest-used first", async () => {
    // The paired negative for the collapse: if it merged on anything coarser than account identity
    // it would erase the evidence of rotation this panel was built to show.
    render(
      <AccountSpawnLog
        read={vi.fn(async () => [
          entry({ accountId: "b", email: "second@example.com", key: "agent-b1", signedInCount: 2 }),
          // TWO DISTINCT agents on account "a" — the summary shows a distinct-agent count, so two
          // spawns by ONE agent would read "1 agent", not "2". Distinct keys make it a real 2.
          entry({ accountId: "a", email: "first@example.com", key: "agent-a1", signedInCount: 2 }),
          entry({ accountId: "a", email: "first@example.com", key: "agent-a2", signedInCount: 2 }),
        ])}
      />,
    );

    expect(await screen.findAllByText("second@example.com")).toHaveLength(1);
    expect(screen.getAllByText("first@example.com")).toHaveLength(1);
    // Order: `b` was used most recently, so it leads. Two rows, with the DISTINCT-AGENT counts on the
    // right ones: account "a" had two different agents, "b" had one.
    expect(screen.getByText("2 agents")).toBeTruthy();
    expect(screen.getByText("1 agent")).toBeTruthy();
  });

  it("the account ROW shows the distinct-agent count, not the raw selection count", async () => {
    // Guards the RENDER's use of g.agentCount (not g.count): three spawns by ONE agent on one account
    // must read "1 agent", never "3 agents". The groupByAccount unit test covers the pure function;
    // this pins the JSX at AccountSpawnLog.tsx's row. Reverting the row to {g.count} reds this
    // (findByText "1 agent" fails and "3 agents" appears).
    render(
      <AccountSpawnLog
        read={vi.fn(async () => [
          entry({ accountId: "a", key: "agent-1" }),
          entry({ accountId: "a", key: "agent-1" }),
          entry({ accountId: "a", key: "agent-1" }),
        ])}
      />,
    );
    expect(await screen.findByText("1 agent")).toBeTruthy();
    expect(screen.queryByText("3 agents")).toBeNull();
  });

  it("keeps every spawn available behind a disclosure — collapsed is not discarded", async () => {
    render(<AccountSpawnLog read={vi.fn(async () => sameAccount(60))} />);

    // Collapsed by default, and UNMOUNTED rather than hidden: 60 rows left in the document would
    // still duplicate every account label and still be paid for on each render.
    const toggle = await screen.findByRole("button", { name: "Show the last 60 selections" });
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

    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
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

  it("counts DISTINCT agents per account (by ledger key), not raw selection records", () => {
    // The summary row shows "N agents". One agent that respawns many times on the non-sticky path
    // writes many ledger entries, so a raw entry count would overstate the agents — the group counts
    // distinct ledger keys instead.
    const respawns = groupByAccount([
      entry({ accountId: "a", key: "agent-1" }),
      entry({ accountId: "a", key: "agent-1" }),
      entry({ accountId: "a", key: "agent-1" }),
    ]);
    expect(respawns[0]!.count).toBe(3); // three selection records…
    expect(respawns[0]!.agentCount).toBe(1); // …but ONE distinct agent

    // The paired positive: three different agents count as three, so the distinct-key logic is not a
    // constant-1.
    const distinct = groupByAccount([
      entry({ accountId: "a", key: "agent-1" }),
      entry({ accountId: "a", key: "agent-2" }),
      entry({ accountId: "a", key: "agent-3" }),
    ]);
    expect(distinct[0]!.agentCount).toBe(3);
  });
});
