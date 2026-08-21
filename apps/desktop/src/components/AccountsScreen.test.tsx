// @vitest-environment jsdom
//
// Interaction tests for the Accounts settings screen: load/list, add → onLogin seam, inline
// rename, and the two-step remove confirm (default guarded). IO is injected via the `deps` prop.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountsScreen, SIGNED_IN_NO_EMAIL, type AccountsDeps } from "./AccountsScreen";
import { PENDING_NICKNAME, EXPIRED_LOGIN_NICKNAME } from "./accountsView";
import {
  NOT_SIGNED_IN,
  type Account,
  type Usage,
  type Identity,
} from "../services/accountStore";
import type { Ceiling } from "../services/headroom";
import type { AccountUsageLive } from "../services/accountUsage";
import type { ClaudeAuthStatus } from "../preflight";

/** A neutral live-usage payload for the effect tests. */
function liveUsage(fiveHourPercent: number, sevenDayPercent: number): AccountUsageLive {
  return {
    fiveHourPercent,
    fiveHourResetsAt: null,
    sevenDayPercent,
    sevenDayResetsAt: null,
    limits: [],
  };
}

afterEach(() => cleanup());

function acct(id: string, over: Partial<Account> = {}): Account {
  return { id, nickname: id, configDir: `/cfg/${id}`, isDefault: false, createdAt: 0, ...over };
}

/** Open an account card's ⋮ kebab and return the open menu. Rename / Remove / Switch login /
 *  Check usage levels all live inside it now (overhaul item 11). */
async function openKebab(id: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByTestId(`account-menu-button-${id}`));
  return screen.findByTestId(`account-menu-${id}`);
}

function makeDeps(
  accounts: Account[],
  usage: Usage[] = [],
  identities: Identity[] = [],
  ceilings: Ceiling[] = [],
): AccountsDeps {
  return {
    listAccounts: vi.fn(async () => accounts),
    getUsage: vi.fn(async () => usage),
    getIdentities: vi.fn(async () => identities),
    listCeilings: vi.fn(async () => ceilings),
    // Default: live usage is unavailable (no Tauri bridge in these suites). The row degrades to the
    // "Real usage unavailable" note, and since the two "(local estimate)" bars were removed there is
    // now NO progressbar at all in that state — Anthropic's figures are the only usage on the card.
    // Tests that need a bar override this per case.
    getUsageLive: vi.fn(async () => {
      throw new Error("live usage unavailable in test");
    }),
    // Default: the live auth probe errors (no Tauri bridge), which `deriveRowLogin` treats as "no
    // decisive signal" — every row falls back to its recorded identity, exactly as before this probe
    // existed. Tests that need an EXPIRED reading override this per case.
    getAuthStatus: vi.fn(async (): Promise<ClaudeAuthStatus> => {
      throw new Error("auth status unavailable in test");
    }),
    addAccount: vi.fn(async (nickname: string) => acct("new", { nickname })),
    setNickname: vi.fn(async () => {}),
    removeAccount: vi.fn(async () => {}),
    // Without this the panel falls back to the real invoke("accounts_spawn_log") inside a suite
    // that mocks no Tauri bridge: it rejects, resolves to [] outside act() after the assertions
    // have run, and the mount cannot be asserted at all.
    readSpawnLog: vi.fn(async () => []),
    // Routing readers default to "nothing activated, nothing running" so every pre-existing test
    // renders exactly the screen it was written against. The activation suite overrides them.
    activateAccount: vi.fn((_accountId: string) => true),
    getPreferredAccountId: vi.fn((): string | undefined => undefined),
    clearPreferredAccount: vi.fn(),
    paneAccountMap: vi.fn((): Record<string, string | undefined> => ({})),
    stickyAccountSnapshot: vi.fn((_key: string): string | undefined => undefined),
    getPin: vi.fn((_key: string): string | undefined => undefined),
    setPin: vi.fn(),
    clearPin: vi.fn(),
    clearSwitchWrittenPins: vi.fn((): string[] => []),
    agentNames: vi.fn((): Record<string, string> => ({})),
  };
}

/** A deps set whose routing readers are backed by MUTABLE state, so a click can actually change
 *  what the next render reads. A stub that always returns the same value cannot tell "the button
 *  wrote the preference" from "the badge was hard-coded". */
function routableDeps(accounts: Account[], identities: Identity[] = []) {
  const state: {
    preferred?: string;
    panes: Record<string, string | undefined>;
    names: Record<string, string>;
    pins: Record<string, string>;
    /** Which of `pins` the MIGRATION wrote, as `setPinFromSwitch` marks them for real. Modelled
     *  here because "Back to automatic" has to undo one kind and not the other, and a stub with no
     *  provenance cannot tell a sweep that works from one that deletes everything. */
    switchWritten: Set<string>;
    sticky: Record<string, string>;
  } = { panes: {}, names: {}, pins: {}, switchWritten: new Set(), sticky: {} };
  const deps = makeDeps(accounts, [], identities);
  deps.activateAccount = vi.fn((id: string) => {
    state.preferred = id;
    // The migration half: every mounted pane not already there is pinned to the new account, which
    // is what `moveAgent` → `setPinFromSwitch` does in production.
    for (const agentId of Object.keys(state.panes)) {
      if (state.panes[agentId] === id) continue;
      state.pins[agentId] = id;
      state.switchWritten.add(agentId);
    }
    return true;
  });
  deps.getPreferredAccountId = vi.fn(() => state.preferred);
  deps.clearPreferredAccount = vi.fn(() => {
    state.preferred = undefined;
  });
  deps.clearSwitchWrittenPins = vi.fn(() => {
    const dropped: string[] = [];
    for (const id of state.switchWritten) {
      if (id in state.pins) {
        delete state.pins[id];
        dropped.push(id);
      }
    }
    state.switchWritten.clear();
    return dropped;
  });
  deps.paneAccountMap = vi.fn(() => state.panes);
  deps.agentNames = vi.fn(() => state.names);
  deps.getPin = vi.fn((key: string) => state.pins[key]);
  deps.setPin = vi.fn((key: string, accountId: string) => {
    state.pins[key] = accountId;
    // A person overriding a machinery pin takes ownership of it — same unmark as `setPin` does.
    state.switchWritten.delete(key);
  });
  deps.clearPin = vi.fn((key: string) => {
    delete state.pins[key];
  });
  deps.stickyAccountSnapshot = vi.fn((key: string) => state.pins[key] ?? state.sticky[key]);
  return { deps, state };
}

const signedIn = (id: string): Identity => ({
  id,
  email: `${id}@example.invalid`,
  organization: null,
  accountUuid: `u-${id}`,
});

describe("AccountsScreen", () => {
  it("lists accounts with nickname and default tag, and shows NO usage bar when the real figure is unavailable", async () => {
    const deps = makeDeps(
      [acct("a", { nickname: "Personal", isDefault: true }), acct("b", { nickname: "Work" })],
      [{ id: "a", tokens5h: 0, tokens7d: 0, exhaustedUntil: null }],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    // Nickname is the bold card title now (overhaul item 3) — no "alias:" prefix. Neither account is
    // signed in (no identities), so each title still shows its nickname with a "Not signed in"
    // secondary line beneath (asserted in the identity-slot suite below).
    expect((await screen.findByTestId("account-identity-a")).textContent).toBe("Personal");
    expect(screen.getByTestId("account-identity-b").textContent).toBe("Work");
    expect(screen.queryByText(/alias:/)).toBeNull();
    expect(screen.getByText("default")).toBeTruthy();
    // NO bars. `getUsageLive` rejects here, and Anthropic's figures are now the only usage on the
    // card — so the honest rendering of "we could not read the real number" is the explanatory note,
    // not a bar drawn from a local estimate that can contradict it.
    expect(screen.queryAllByRole("progressbar")).toHaveLength(0);
  });

  it("renders REAL live usage percentages when the live fetch resolves", async () => {
    const deps = makeDeps([acct("a", { nickname: "Personal", isDefault: true })]);
    // Override the default (which rejects) with the NEUTRAL confirmed shape.
    deps.getUsageLive = vi.fn(async () => ({
      fiveHourPercent: 42,
      fiveHourResetsAt: "2026-08-12T04:09:59.793055+00:00",
      sevenDayPercent: 15,
      sevenDayResetsAt: "2026-08-17T10:59:59.793078+00:00",
      limits: [],
    }));
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    // The real percentages appear — proof the AccountsScreen actually consumes and displays the
    // live dep (would fail if the section weren't wired, i.e. non-vacuous). The fetch is keyed on
    // the account's configDir.
    expect(await screen.findByText("42%")).toBeTruthy();
    expect(screen.getByText("15%")).toBeTruthy();
    expect(deps.getUsageLive).toHaveBeenCalledWith("/cfg/a");
    // Two bars for one account — the 5h and 7d LIVE windows, and nothing else. The two
    // "(local estimate)" bars that used to bring this to 4 were removed: they were computed from
    // local transcripts, so they could read 0 for an account Anthropic reported as fully spent.
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
  });

  it("states WHICH billing meter is live — subscription when no credits meter is reported", async () => {
    // `extraUsage: null` is the wire's common case (a Rust `Option::None` crosses as an explicit
    // null). The honest reading is "subscription", and it must be SAID rather than left implied —
    // before this line the screen could not distinguish the two meters at all.
    const deps = makeDeps([acct("a", { nickname: "Personal", isDefault: true })]);
    deps.getUsageLive = vi.fn(async () => ({
      fiveHourPercent: 42,
      fiveHourResetsAt: null,
      sevenDayPercent: 15,
      sevenDayResetsAt: null,
      limits: [],
      extraUsage: null,
    }));
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    // …but SAID WITH THE CAVEAT, and that half is load-bearing rather than decoration. A bare
    // "subscription" here would be indistinguishable from the disarmed-meter case below, and the
    // two are opposite verdicts to `advisorSpendVerdict`: this state refuses every advisor pass.
    // Asserting only /Billing: subscription/ would pass against a component that cannot tell them
    // apart at all, which is precisely the defect this pair exists to catch.
    expect(await screen.findByText(/Billing: subscription/)).toBeTruthy();
    expect(await screen.findByText(/This account: no credits meter reported/)).toBeTruthy();
    // …and nothing invents a credits figure or a warning out of a null meter.
    expect(screen.queryByText(/used/)).toBeNull();
    expect(screen.queryByText(/Spend limit reached/)).toBeNull();
  });

  it("names the USAGE-CREDITS meter and its spend when the account is on credits", async () => {
    // The case the line exists for: the subscription bars can read comfortable while real money is
    // being spent beside them. Non-vacuous against the test above — same component, same bars,
    // opposite verdict, and the figures must come through rather than be flattened away.
    const deps = makeDeps([acct("a", { nickname: "Personal", isDefault: true })]);
    deps.getUsageLive = vi.fn(async () => ({
      fiveHourPercent: 42,
      fiveHourResetsAt: null,
      sevenDayPercent: 15,
      sevenDayResetsAt: null,
      limits: [],
      extraUsage: {
        isEnabled: true,
        monthlyLimit: 200,
        usedCredits: 199.5,
        utilization: 99.75,
        spendLimitReached: false,
      },
    }));
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect(
      await screen.findByText(/Billing: usage credits · 199\.50 of 200 credits used this month/),
    ).toBeTruthy();
    // spendLimitReached is false here, so the warning must NOT appear — that keeps the warning
    // assertion below from passing on a component that simply always renders it.
    expect(screen.queryByText(/Spend limit reached/)).toBeNull();
  });

  it("warns when the usage-credit SPEND LIMIT has been reached", async () => {
    // The whole point of surfacing this: a human sees the wall BEFORE a fleet of agents hits it.
    const deps = makeDeps([acct("a", { nickname: "Personal", isDefault: true })]);
    deps.getUsageLive = vi.fn(async () => ({
      fiveHourPercent: 42,
      fiveHourResetsAt: null,
      sevenDayPercent: 15,
      sevenDayResetsAt: null,
      limits: [],
      extraUsage: {
        isEnabled: true,
        monthlyLimit: 200,
        usedCredits: 200,
        utilization: 100,
        spendLimitReached: true,
      },
    }));
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect(await screen.findByText(/Credit spend limit reached/)).toBeTruthy();
  });

  it("reads DIFFERENTLY for a disarmed credits meter than for one that was never reported", async () => {
    // The distinction the whole line turns on, and the one `summarizeMeter` cannot make: it folds
    // absent / null / false into "subscription", but `advisorSpendVerdict` treats them as OPPOSITE
    // outcomes — an explicit `false` is the ONLY state that permits an advisor call, while a
    // missing meter is `meter-unreadable` and every pass refuses. Rendering both as plain
    // "subscription" would be most reassuring in exactly the state where the advisor is silently
    // skipping. Paired with the `extraUsage: null` test above: same component, same bars, and the
    // two must not produce the same sentence.
    const deps = makeDeps([acct("a", { nickname: "Personal", isDefault: true })]);
    deps.getUsageLive = vi.fn(async () => ({
      fiveHourPercent: 42,
      fiveHourResetsAt: null,
      sevenDayPercent: 15,
      sevenDayResetsAt: null,
      limits: [],
      extraUsage: {
        isEnabled: false,
        monthlyLimit: null,
        usedCredits: null,
        utilization: null,
        spendLimitReached: false,
      },
    }));
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect(await screen.findByText(/Billing: subscription/)).toBeTruthy();
    // The unreported-meter caveat must NOT appear here — credits are provably disarmed, which is
    // the one state the advisor can run in. Without this assertion the two cases could still be
    // rendering the identical string and the test above would not notice.
    // The permitting account fact, stated positively. Silence would be ambiguous — and, before the
    // fleet line existed, was being read as a fleet-wide permission claim it could not support.
    expect(screen.getByText(/This account: usage credits disarmed/)).toBeTruthy();
  });

  it("the FLEET line refuses when a SIBLING account has credits armed", async () => {
    // The account-vs-fleet gap, and it is the one a per-card line structurally cannot close.
    // Production asks `checkSpendGateForAccounts`, which requires UNANIMITY, so account A being
    // disarmed decides nothing while account B is armed. An earlier cut rendered A with no caveat
    // at all and said nothing anywhere about the fleet, which made silence a permission claim.
    const deps = makeDeps([
      acct("a", { nickname: "Personal", isDefault: true }),
      acct("b", { nickname: "Work" }),
    ]);
    deps.getUsageLive = vi.fn(async (dir: string) => ({
      fiveHourPercent: 10,
      fiveHourResetsAt: null,
      sevenDayPercent: 10,
      sevenDayResetsAt: null,
      limits: [],
      extraUsage:
        dir === "/cfg/b"
          ? { isEnabled: true, monthlyLimit: null, usedCredits: null, utilization: null, spendLimitReached: false }
          : { isEnabled: false, monthlyLimit: null, usedCredits: null, utilization: null, spendLimitReached: false },
    })) as never;
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const line = await screen.findByTestId("advisor-gate-line");
    expect(line.textContent).toMatch(/Advisor passes are SKIPPING/);
    expect(line.textContent).toMatch(/usage credits armed/);
    // …and account A's own card still truthfully reports its own meter as disarmed. Both must hold:
    // the fix is that the ACCOUNT fact and the FLEET verdict are stated separately, not that the
    // account fact was wrong.
    expect(screen.getAllByText(/This account: usage credits disarmed/).length).toBeGreaterThan(0);
  });

  it("the FLEET line refuses when a SIBLING account's usage read FAILS", async () => {
    // The nastier half: a rejected read mounts "Real usage unavailable." and NO meter line at all,
    // so before the fleet line there was nowhere on the screen that said the advisor was off. The
    // gate treats an unreadable account as a refusal, not an abstention.
    const deps = makeDeps([
      acct("a", { nickname: "Personal", isDefault: true }),
      acct("b", { nickname: "Work" }),
    ]);
    deps.getUsageLive = vi.fn(async (dir: string) => {
      if (dir === "/cfg/b") throw new Error("no token");
      return {
        fiveHourPercent: 10,
        fiveHourResetsAt: null,
        sevenDayPercent: 10,
        sevenDayResetsAt: null,
        limits: [],
        extraUsage: { isEnabled: false, monthlyLimit: null, usedCredits: null, utilization: null, spendLimitReached: false },
      };
    }) as never;
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const line = await screen.findByTestId("advisor-gate-line");
    expect(line.textContent).toMatch(/Advisor passes are SKIPPING/);
    expect(line.textContent).toMatch(/could not be read/);
  });

  it("the FLEET line says passes CAN run when every account is disarmed", async () => {
    // The permitting direction, asserted in the same file as both refusals above — a suite that
    // only ever exercised the refusal would not prove the line can distinguish anything.
    const deps = makeDeps([
      acct("a", { nickname: "Personal", isDefault: true }),
      acct("b", { nickname: "Work" }),
    ]);
    deps.getUsageLive = vi.fn(async () => ({
      fiveHourPercent: 10,
      fiveHourResetsAt: null,
      sevenDayPercent: 10,
      sevenDayResetsAt: null,
      limits: [],
      extraUsage: { isEnabled: false, monthlyLimit: null, usedCredits: null, utilization: null, spendLimitReached: false },
    })) as never;
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const line = await screen.findByTestId("advisor-gate-line");
    expect(line.textContent).toMatch(/Advisor passes can run/);
    expect(line.textContent).not.toMatch(/SKIPPING/);
  });

  it("distinguishes a meter that was not reported from one that did not say whether it is armed", async () => {
    // The fourth branch, which had no test: `extraUsage` PRESENT with `isEnabled` null and
    // `spendLimitReached` FALSE. The only null-isEnabled fixture set spendLimitReached true, which
    // short-circuits at the first ternary and never reaches this branch — so collapsing the last
    // two branches into one string would have left the whole suite green, reintroducing the very
    // self-contradiction ("no credits meter reported" for a block that plainly was) this removes.
    // Positive AND negative, since either alone is half the evidence.
    const deps = makeDeps([acct("a", { nickname: "Personal", isDefault: true })]);
    deps.getUsageLive = vi.fn(async () => ({
      fiveHourPercent: 42,
      fiveHourResetsAt: null,
      sevenDayPercent: 15,
      sevenDayResetsAt: null,
      limits: [],
      extraUsage: {
        isEnabled: null,
        monthlyLimit: null,
        usedCredits: null,
        utilization: null,
        spendLimitReached: false,
      },
    }));
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect(
      await screen.findByText(/This account: credits meter did not say whether it is armed/),
    ).toBeTruthy();
    expect(screen.queryByText(/no credits meter reported/)).toBeNull();
  });

  it("a DISARMED meter at its spend limit does not read as the permitting state", async () => {
    // The ordering bug this pins, and it is not intuitive: `spendGate.ts` checks
    // `spendLimitReached` BEFORE the `isEnabled` gate, so `isEnabled: false` + limit reached
    // REFUSES. Reading the label off the tri-state while the warning came off `summarizeMeter`
    // rendered exactly this case as a plain unqualified "subscription" — which under this line's
    // contract is the one reading that means a pass is permitted. Most reassuring in a refusing
    // state is the failure the whole line exists to prevent.
    const deps = makeDeps([acct("a", { nickname: "Personal", isDefault: true })]);
    deps.getUsageLive = vi.fn(async () => ({
      fiveHourPercent: 42,
      fiveHourResetsAt: null,
      sevenDayPercent: 15,
      sevenDayResetsAt: null,
      limits: [],
      extraUsage: {
        isEnabled: false,
        monthlyLimit: 200,
        usedCredits: 200,
        utilization: 100,
        spendLimitReached: true,
      },
    }));
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect(
      await screen.findByText(/This account: credit spend limit reported reached/),
    ).toBeTruthy();
    // Paired with the disarmed-and-under-limit test above, which asserts NO skip line at all: the
    // two disarmed cases must not render the same sentence, or the distinction cannot regress-fail.
    expect(screen.getByText(/Credit spend limit reached/)).toBeTruthy();
  });

  it("does not call the meter unreported while stating a definite fact about it", async () => {
    // `isEnabled: null` with `spendLimitReached: true` is a shape the Rust `Option<bool>` really
    // sends. The block plainly WAS reported — it carried a spend-limit fact — so saying "reported no
    // credits meter" one line above "Credit spend limit reached" contradicts itself. Both refuse,
    // but only a wholly absent block can honestly be called unreported.
    const deps = makeDeps([acct("a", { nickname: "Personal", isDefault: true })]);
    deps.getUsageLive = vi.fn(async () => ({
      fiveHourPercent: 42,
      fiveHourResetsAt: null,
      sevenDayPercent: 15,
      sevenDayResetsAt: null,
      limits: [],
      extraUsage: {
        isEnabled: null,
        monthlyLimit: null,
        usedCredits: null,
        utilization: null,
        spendLimitReached: true,
      },
    }));
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect(await screen.findByText(/Credit spend limit reached/)).toBeTruthy();
    expect(screen.queryByText(/no credits meter reported/)).toBeNull();
    // …and the skip reason names the ORDER the gate actually applies: the spend limit refuses
    // first, so that — not the unknown `isEnabled` — is what this account is told. Asserting the
    // positive wording as well as the absent one is what gives this test power; a bare
    // "does not say X" passes against any component that says nothing at all.
    expect(
      screen.getByText(/This account: credit spend limit reported reached/),
    ).toBeTruthy();
  });

  it("never prints a credit figure beside the word subscription", async () => {
    // A meter disabled part-way through a month: `isEnabled: false` with `usedCredits` still
    // populated. Every field is its own `Option` on the Rust side, so this shape is permitted by
    // the type. Reading the figure off `summarizeMeter` rendered "Billing: subscription · 47.50 of
    // 200 used" — one meter asserted while the other's spend sits beside it, which is the exact
    // confusion this line was added to remove.
    const deps = makeDeps([acct("a", { nickname: "Personal", isDefault: true })]);
    deps.getUsageLive = vi.fn(async () => ({
      fiveHourPercent: 42,
      fiveHourResetsAt: null,
      sevenDayPercent: 15,
      sevenDayResetsAt: null,
      limits: [],
      extraUsage: {
        isEnabled: false,
        monthlyLimit: 200,
        usedCredits: 47.5,
        utilization: 23.75,
        spendLimitReached: false,
      },
    }));
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect(await screen.findByText(/Billing: subscription/)).toBeTruthy();
    expect(screen.queryByText(/47\.50/)).toBeNull();
    expect(screen.queryByText(/used this month/)).toBeNull();
  });

  it("shows a window's reset caption even when that window's PERCENT is null (the two are independent)", async () => {
    // The wire nullable percent and reset instant separately, so a window can report "resets at T"
    // with no utilization figure. The bar reads "—" for the missing percent, but the reset caption
    // must still render — gating it on the percent (the pre-fix behavior) silently dropped the one
    // signal that window did carry. Non-vacuous: re-adding the `known &&` gate hides the caption and
    // fails the findByText below.
    const deps = makeDeps([acct("a", { nickname: "Personal", isDefault: true })]);
    deps.getUsageLive = vi.fn(async () => ({
      fiveHourPercent: null,
      fiveHourResetsAt: "2026-08-17T10:59:00.000Z", // percent unknown, but we know WHEN it resets
      sevenDayPercent: 15,
      sevenDayResetsAt: null,
      limits: [],
    }));
    // Pin the wall clock so the RELATIVE half of the caption ("Resets in …") is deterministic: the
    // component reads Date.now() at render, and this test's reset instant is a fixed absolute date, so
    // once real time passes it the caption collapses to "Resets now" and the regex below never matches.
    // Spy on Date.now (not fake timers, which would stall testing-library's async findByText polling).
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-15T22:59:00.000Z"));
    try {
      render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
      // The 7d percent still renders (proves the section is mounted)…
      expect(await screen.findByText("15%")).toBeTruthy();
      // …and the 5h window shows its reset caption despite a null percent (bar reads "—").
      expect(await screen.findByText(/Resets in .* \(Aug 17, 3:59am PT\)/)).toBeTruthy();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("a plain rename does NOT re-fetch live usage (the effect key excludes the nickname)", async () => {
    const deps = makeDeps(
      [acct("a", { nickname: "Old" })],
      [],
      [{ id: "a", email: "e@x.com", organization: null, accountUuid: "u1" }],
    );
    deps.getUsageLive = vi.fn(async () => liveUsage(42, 15));
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect(await screen.findByText("42%")).toBeTruthy();
    expect(deps.getUsageLive).toHaveBeenCalledTimes(1);
    // Rename → setNickname → refresh(). id/configDir/accountUuid are unchanged, so the live effect
    // must NOT re-run (no extra keychain read / endpoint hit). Non-vacuous: keying on the array
    // identity or a per-refresh nonce would fire a second fetch here and fail this assertion.
    fireEvent.click(within(await openKebab("a")).getByText("Rename"));
    const input = screen.getByLabelText("Rename Old");
    fireEvent.change(input, { target: { value: "New Name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(deps.setNickname).toHaveBeenCalledWith("a", "New Name"));
    await new Promise((r) => setTimeout(r, 0)); // give any errant refetch a chance to fire
    expect(deps.getUsageLive).toHaveBeenCalledTimes(1);
  });

  it("the ADD flow re-fetches live usage after sign-in (covers the handleAdd nonce)", async () => {
    // Non-vacuous coverage for the handleAdd bump SPECIFICALLY — the primary add-and-sign-in flow,
    // and a distinct call site from handleLogin (the "one fix, N sites, only one covered" trap,
    // sparkle-50m03). A DEFERRED onLogin reproduces the real login window taking time: the account is
    // created and fetched BEFORE the login completes (the pre-login fetch, which in production writes
    // "error" against a dir with no creds yet), then the post-login nonce re-fetches. Deleting the
    // handleAdd `setLiveNonce` drops that second call and fails the final assertion.
    const accounts: Account[] = [];
    let resolveLogin: () => void = () => {};
    const deps = makeDeps([]);
    deps.listAccounts = vi.fn(async () => [...accounts]);
    deps.addAccount = vi.fn(async (nickname: string) => {
      const a = acct("new", { nickname });
      accounts.push(a);
      return a;
    });
    deps.getUsageLive = vi.fn(async () => liveUsage(42, 15));
    const onLogin = vi.fn(() => new Promise<void>((res) => (resolveLogin = res)));
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    fireEvent.click(await screen.findByText("+ Add account"));
    fireEvent.change(screen.getByLabelText("New account nickname"), { target: { value: "Cloud Max" } });
    fireEvent.click(screen.getByText("Create & log in"));
    // Pre-login fetch: the new account is fetched while the login window is still "open".
    await waitFor(() =>
      expect(vi.mocked(deps.getUsageLive).mock.calls.filter((c) => c[0] === "/cfg/new")).toHaveLength(1),
    );
    // Close the login window → handleAdd's post-login refresh + nonce → the SECOND fetch.
    resolveLogin();
    await waitFor(() => {
      const forNew = vi.mocked(deps.getUsageLive).mock.calls.filter((c) => c[0] === "/cfg/new");
      expect(forNew.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("re-authenticating an account RE-fetches its live usage (recovery + null-uuid path)", async () => {
    // The post-login regression and its two subtlest cases in one: a login changes neither id nor
    // configDir, and here the account has NO identity at all (so no accountUuid to key on) — yet a
    // completed login must re-fetch. This is the recovery path a user takes from a failed
    // ("unavailable") row: click "Finish sign-in", re-authenticate, expect fresh usage. The nonce
    // bumped after onLogin drives it. Non-vacuous: without the nonce the click's refresh changes no
    // key, so the fetch stays at 1 and the waitFor times out. Two SEPARATE events (mount + click) so
    // the second effect run cannot batch into the first.
    const deps = makeDeps([acct("a", { nickname: "A" })]); // no identity → "Finish sign-in" shows
    deps.getUsageLive = vi.fn(async () => liveUsage(42, 15));
    const onLogin = vi.fn(async () => {});
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    await waitFor(() => expect(deps.getUsageLive).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("Finish sign-in"));
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith(expect.objectContaining({ id: "a" })));
    await waitFor(() => expect(deps.getUsageLive).toHaveBeenCalledTimes(2));
    expect(deps.getUsageLive).toHaveBeenLastCalledWith("/cfg/a");
  });

  it("discards a STALE live-usage batch that resolves after a newer one", async () => {
    // The generation ref must keep the NEWEST batch: with a 15s window an older batch can resolve
    // last, and a naive write would clobber fresh data. Batch 1 (the mount fetch) is left pending; a
    // re-login (nonce) fires batch 2, which resolves FIRST with the new value, then batch 1 resolves
    // LATE with stale data and must be discarded.
    let resolveFirst: (v: AccountUsageLive) => void = () => {};
    let resolveSecond: (v: AccountUsageLive) => void = () => {};
    let n = 0;
    const deps = makeDeps([acct("a", { nickname: "A" })]);
    deps.getUsageLive = vi.fn(
      () =>
        new Promise<AccountUsageLive>((res) => {
          n += 1;
          if (n === 1) resolveFirst = res;
          else resolveSecond = res;
        }),
    );
    render(<AccountsScreen onLogin={vi.fn(async () => {})} deps={deps} />);
    await waitFor(() => expect(deps.getUsageLive).toHaveBeenCalledTimes(1)); // batch 1 pending
    fireEvent.click(screen.getByText("Finish sign-in"));
    await waitFor(() => expect(deps.getUsageLive).toHaveBeenCalledTimes(2)); // batch 2 pending (nonce)
    resolveSecond(liveUsage(15, 7)); // newest batch resolves first
    expect(await screen.findByText("15%")).toBeTruthy();
    resolveFirst(liveUsage(42, 99)); // stale, arrives late
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("42%")).toBeNull();
    expect(screen.getByText("15%")).toBeTruthy();
  });

  it("Check usage levels (⋮ menu) force-refreshes ONLY that card's account and updates its bar", async () => {
    // Item 14: the per-card ⋮ → "Check usage levels" must call the FORCE path — the arg the Rust
    // command reads to bypass the TTL cache — for THAT account only, and the new figure must reach the
    // card's bar. Non-vacuous on force: the mount effect calls getUsageLive WITHOUT force, so a handler
    // that forgot `force` (or reused the cached path) leaves zero force=true calls and fails below.
    // Non-vacuous on the update: the returned percent changes between mount and check, so a handler
    // that fetched but never wrote state would still show the old number. Non-vacuous on SCOPE: only
    // /cfg/a is forced — a handler that force-refreshed every account would fail the scope assertion.
    const deps = makeDeps(
      [acct("a", { nickname: "A" }), acct("b", { nickname: "B" })],
      [],
      [
        { id: "a", email: "a@x.com", organization: null, accountUuid: "ua" },
        { id: "b", email: "b@x.com", organization: null, accountUuid: "ub" },
      ],
    );
    // First round (mount, unforced) → 10%; forced check → 88%. Keyed on the force arg so the two
    // rounds are distinguishable and the assertion can't pass on the mount data alone.
    deps.getUsageLive = vi.fn(async (_configDir: string, force?: boolean) =>
      liveUsage(force ? 88 : 10, force ? 88 : 10),
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    // Mount fetch landed (unforced).
    await waitFor(() => expect(screen.getAllByText("10%").length).toBeGreaterThan(0));
    expect(vi.mocked(deps.getUsageLive).mock.calls.filter((c) => c[1] === true)).toHaveLength(0);

    fireEvent.click(within(await openKebab("a")).getByText("Check usage levels"));

    // Exactly one force=true call, and only for account a's config dir — b is untouched.
    await waitFor(() => {
      const forced = vi.mocked(deps.getUsageLive).mock.calls.filter((c) => c[1] === true);
      expect(forced.map((c) => c[0])).toEqual(["/cfg/a"]);
    });
    // …and the forced figure reached account a's own bar (scoped to its card, not b's).
    await waitFor(() =>
      expect(
        within(screen.getByTestId("account-row-a")).getAllByText("88%").length,
      ).toBeGreaterThan(0),
    );
  });

  it("checks each card independently: one card's failure errors only that card, the other still updates", async () => {
    // Replaces the old aggregate "partial failure" copy — there is no global verdict now. The property
    // that matters post-overhaul is ISOLATION: account a's keychain denial marks ONLY a's card, and a
    // separate check on the healthy account b still lands b's number. Non-vacuous: a handler that
    // wrote the error to a shared (non-keyed) slot would surface it on b too; one that keyed the fetch
    // result to the wrong card would move the wrong bar.
    const deps = makeDeps(
      [acct("a", { nickname: "A" }), acct("b", { nickname: "B" })],
      [],
      [
        { id: "a", email: "a@x.com", organization: null, accountUuid: "ua" },
        { id: "b", email: "b@x.com", organization: null, accountUuid: "ub" },
      ],
    );
    // A forced read of a is denied; a forced read of b succeeds → 55%. Unforced (mount) → 10%.
    deps.getUsageLive = vi.fn(async (configDir: string, force?: boolean) => {
      if (force && configDir === "/cfg/a") throw new Error("keychain denied");
      return liveUsage(force ? 55 : 10, force ? 55 : 10);
    });
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    await waitFor(() => expect(screen.getAllByText("10%").length).toBeGreaterThan(0));

    // a fails → a's own inline error, and NO error on b.
    fireEvent.click(within(await openKebab("a")).getByText("Check usage levels"));
    expect(await screen.findByTestId("account-usage-error-a")).toBeTruthy();
    expect(screen.queryByTestId("account-usage-error-b")).toBeNull();

    // b succeeds → b's bar updates to 55%, b never shows an error, and a's bar is not overwritten.
    fireEvent.click(within(await openKebab("b")).getByText("Check usage levels"));
    await waitFor(() =>
      expect(
        within(screen.getByTestId("account-row-b")).getAllByText("55%").length,
      ).toBeGreaterThan(0),
    );
    expect(screen.queryByTestId("account-usage-error-b")).toBeNull();
    expect(within(screen.getByTestId("account-row-a")).queryByText("55%")).toBeNull();
  });

  it("a failed Check usage surfaces THIS card's inline alert — never a browser dialog", async () => {
    // A keychain denial / network failure must NOT be a silent no-op, and (item 11) must use an
    // in-app, per-card alert rather than a native confirm()/alert. Non-vacuous: the success path
    // writes a number and no error (the tests above), so a handler that swallowed the rejection or
    // hard-coded the message fails one of the two; asserting role=alert pins the accessible surface.
    const deps = makeDeps(
      [acct("a", { nickname: "A" })],
      [],
      [{ id: "a", email: "a@x.com", organization: null, accountUuid: "ua" }],
    );
    deps.getUsageLive = vi.fn(async (_c: string, force?: boolean) => {
      if (force) throw new Error("keychain access denied");
      return liveUsage(10, 10);
    });
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    // Let the mount fetch settle first so the check's fetch is the one we assert on.
    await waitFor(() => expect(deps.getUsageLive).toHaveBeenCalled());

    fireEvent.click(within(await openKebab("a")).getByText("Check usage levels"));

    const err = await screen.findByTestId("account-usage-error-a");
    expect(err.textContent).toBe("Couldn't refresh usage. Check your connection or sign in again.");
    expect(err.getAttribute("role")).toBe("alert");
  });

  it("a Check usage SUPERSEDED by a newer check writes no stale row", async () => {
    // The generation guard in checkUsageLevels: each check bumps `liveGenRef`, so if a second check
    // starts while the first account's forced fetch is still pending, the pending result must be
    // DISCARDED (not written over the newer data). Non-vacuous: delete the `liveGenRef.current === gen`
    // write guard and the stale 88% lands on account a's bar, failing the final assertion.
    let resolveForcedA: (v: AccountUsageLive) => void = () => {};
    const deps = makeDeps(
      [acct("a", { nickname: "A" }), acct("b", { nickname: "B" })],
      [],
      [
        { id: "a", email: "a@x.com", organization: null, accountUuid: "ua" },
        { id: "b", email: "b@x.com", organization: null, accountUuid: "ub" },
      ],
    );
    // a's forced fetch is held pending (controllable); b's forced fetch resolves immediately → 50%.
    deps.getUsageLive = vi.fn((configDir: string, force?: boolean) => {
      if (force && configDir === "/cfg/a")
        return new Promise<AccountUsageLive>((res) => {
          resolveForcedA = res;
        });
      return Promise.resolve(liveUsage(force ? 50 : 10, force ? 50 : 10));
    });
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    // Mount (unforced) fetch → both rows show 10%.
    await waitFor(() => expect(screen.getAllByText("10%").length).toBeGreaterThan(0));

    // Start a's check; its forced fetch is left pending (generation G).
    fireEvent.click(within(await openKebab("a")).getByText("Check usage levels"));
    await waitFor(() =>
      expect(
        vi.mocked(deps.getUsageLive).mock.calls.filter((c) => c[1] === true && c[0] === "/cfg/a"),
      ).toHaveLength(1),
    );

    // Supersede it: checking b bumps the generation to G+1 and resolves immediately (b → 50%).
    fireEvent.click(within(await openKebab("b")).getByText("Check usage levels"));
    await waitFor(() =>
      expect(
        within(screen.getByTestId("account-row-b")).getAllByText("50%").length,
      ).toBeGreaterThan(0),
    );

    // Now a's stale forced fetch resolves with a DIFFERENT value — it must be discarded.
    resolveForcedA(liveUsage(88, 88));
    await new Promise((r) => setTimeout(r, 0));

    const rowA = screen.getByTestId("account-row-a");
    expect(within(rowA).queryByText("88%")).toBeNull(); // stale write discarded
    expect(within(rowA).getAllByText("10%").length).toBeGreaterThan(0); // a keeps its last figures
  });

  it("Add account creates then calls onLogin with the new account", async () => {
    const deps = makeDeps([]);
    const onLogin = vi.fn();
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    fireEvent.click(await screen.findByText("+ Add account"));
    fireEvent.change(screen.getByLabelText("New account nickname"), { target: { value: "Cloud Max" } });
    fireEvent.click(screen.getByText("Create & log in"));
    await waitFor(() => expect(deps.addAccount).toHaveBeenCalledWith("Cloud Max"));
    expect(onLogin).toHaveBeenCalledWith(expect.objectContaining({ nickname: "Cloud Max" }));
  });

  // ── The add-account loop, end to end ────────────────────────────────────────────────────────
  // Adding an account used to be a one-way hand-off: create the dir, fire onLogin, and never look
  // again. So whatever the login did — succeed, fail, or (for as long as the spawn ran the
  // non-existent `claude login`) never even open a browser — the row afterwards showed the
  // nickname the user typed, which is what left the founder believing he had accounts he did not
  // have. The fix is that the attempt ENDING triggers a re-read, and the re-read drives the row.
  //
  // `store()` models the real sequence: the identity does not exist while the login window is
  // open, so both reads before it closes come back empty. Only a THIRD read, after onLogin
  // settles, can see an email — which makes displaying that email proof the re-read happened.
  function store(onLoginEffect: (ids: Identity[]) => void) {
    const accounts: Account[] = [];
    const identities: Identity[] = [];
    // Held separately from `deps` because the assertions below COUNT its calls. Reading it back off
    // a `Partial<…>` would be `possibly undefined`, and a `!` there would be a type assertion
    // standing exactly where the test's evidence comes from.
    const getIdentities = vi.fn(async () => [...identities]);
    // PARTIAL: this helper models the add→login→re-read loop, so it overrides only the IO that loop
    // touches. The routing readers fall through to the real ones, which read empty registries here.
    const deps: Partial<AccountsDeps> = {
      listAccounts: vi.fn(async () => [...accounts]),
      getUsage: vi.fn(async () => []),
      getIdentities,
      listCeilings: vi.fn(async () => []),
      getUsageLive: vi.fn(async () => {
        throw new Error("live usage unavailable in test");
      }),
      addAccount: vi.fn(async (nickname: string) => {
        // Distinct ids so the multi-add case renders distinct rows, the way real ones do.
        const a = acct(`acct-${accounts.length}`, { nickname });
        accounts.push(a);
        return a;
      }),
      setNickname: vi.fn(async () => {}),
      removeAccount: vi.fn(async () => {}),
      readSpawnLog: vi.fn(async () => []),
    };
    let readsAtLoginStart = -1;
    const onLogin = vi.fn(async () => {
      readsAtLoginStart = getIdentities.mock.calls.length;
      onLoginEffect(identities);
    });
    return { deps, onLogin, getIdentities, readsAtLoginStart: () => readsAtLoginStart };
  }

  async function addAccountNamed(name: string) {
    fireEvent.click(await screen.findByText("+ Add account"));
    fireEvent.change(screen.getByLabelText("New account nickname"), { target: { value: name } });
    fireEvent.click(screen.getByText("Create & log in"));
  }

  it("re-reads identities after the login window closes and shows the email signed in as", async () => {
    const { deps, onLogin, getIdentities, readsAtLoginStart } = store((ids) =>
      ids.push({ id: "acct-0", email: "drodio@gmail.com", organization: null, accountUuid: "u5" }),
    );
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    await addAccountNamed("Cloud Max");

    // The resolved EMAIL appears on the SECONDARY line (the title is the nickname now). Its presence
    // is unreachable without a read that happens AFTER the login attempt ends — the identity did not
    // exist before then.
    expect((await screen.findByTestId("account-identity-acct-0")).textContent).toBe("Cloud Max");
    expect(screen.getByTestId("account-identity-sub-acct-0").textContent).toBe("drodio@gmail.com");
    expect(screen.queryByText(/alias:/)).toBeNull();
    // And that read is strictly AFTER onLogin started, not one of the earlier two.
    expect(getIdentities.mock.calls.length).toBeGreaterThan(readsAtLoginStart());
  });

  it("leaves the account visibly NOT signed in when the login resolves no identity", async () => {
    // The failure state has to look like failure. This is exactly the founder's `602064ad` account:
    // a config dir that exists with no `oauthAccount` in it. A closed window is not a sign-in.
    const { deps, onLogin } = store(() => {
      /* login window closed, nothing was written — the OAuth never completed */
    });
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    await addAccountNamed("Cloud Max");

    // The title is the nickname, but the failure still LOOKS like failure: the secondary line reads
    // "Not signed in" and the loud blocked banner renders. A closed window is not a sign-in.
    expect((await screen.findByTestId("account-identity-acct-0")).textContent).toBe("Cloud Max");
    expect(screen.getByTestId("account-identity-sub-acct-0").textContent).toBe("Not signed in");
    expect(screen.getByTestId("account-blocked-acct-0")).toBeTruthy();
  });

  it("does not cap how many accounts can be added", async () => {
    // The founder has four or five. Nothing in the add path is allowed to bound the list.
    const { deps, onLogin } = store(() => {});
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    for (const n of ["One", "Two", "Three", "Four", "Five"]) await addAccountNamed(n);
    await waitFor(() => expect(deps.addAccount).toHaveBeenCalledTimes(5));
    // The 5th account's nickname is its card title (overhaul item 3). Assert via its row's identity
    // slot rather than a bare text match (the name can appear in more than one node).
    expect((await screen.findByTestId("account-identity-acct-4")).textContent).toBe("Five");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("inline rename calls setNickname exactly once on Enter (no blur double-commit)", async () => {
    const deps = makeDeps([acct("a", { nickname: "Old" })]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    fireEvent.click(within(await openKebab("a")).getByText("Rename"));
    const input = screen.getByLabelText("Rename Old");
    fireEvent.change(input, { target: { value: "New Name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // A trailing blur (as the input unmounts on commit) must NOT re-submit.
    fireEvent.blur(input);
    await waitFor(() => expect(deps.setNickname).toHaveBeenCalledWith("a", "New Name"));
    expect(deps.setNickname).toHaveBeenCalledTimes(1);
  });

  it("Escape cancels rename without saving (no blur-driven save of the cancelled edit)", async () => {
    const deps = makeDeps([acct("a", { nickname: "Old" })]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    fireEvent.click(within(await openKebab("a")).getByText("Rename"));
    const input = screen.getByLabelText("Rename Old");
    fireEvent.change(input, { target: { value: "Cancelled" } });
    fireEvent.keyDown(input, { key: "Escape" });
    // The blur the unmount would trigger must not commit the discarded draft.
    fireEvent.blur(input);
    // The edit is discarded: original name is shown again (as the card title) and setNickname never ran.
    expect((await screen.findByTestId("account-identity-a")).textContent).toBe("Old");
    expect(deps.setNickname).not.toHaveBeenCalled();
  });

  it("does not offer Remove on the default account", async () => {
    const deps = makeDeps([acct("a", { nickname: "Default", isDefault: true })]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    // Open the kebab: it must carry Rename but NOT Remove for the default account.
    const menu = await openKebab("a");
    expect(within(menu).getByText("Rename")).toBeTruthy();
    expect(within(menu).queryByText("Remove")).toBeNull();
  });

  it("Remove (from the kebab) requires a confirm step", async () => {
    const deps = makeDeps([acct("a", { nickname: "Removable" })]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    fireEvent.click(within(await openKebab("a")).getByText("Remove"));
    // Choosing Remove only opens the in-app confirm — nothing is removed yet.
    expect(deps.removeAccount).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByText("Confirm remove"));
    await waitFor(() => expect(deps.removeAccount).toHaveBeenCalledWith("a"));
  });

  // ── THE DELETE MUST BE INSTANT, NOT MERELY EVENTUAL ─────────────────────────────────────────
  //
  // The founder removed an account, saw the card still sitting there while `removeAccount` ran
  // (it deletes a whole config directory before rewriting accounts.json), read that as a dead
  // click, and clicked Remove again — the second call hit an id the first had already deleted and
  // put `account not found: <id>` on screen for a delete that had in fact worked.
  //
  // These pin the two halves separately: the row leaves BEFORE the backend answers, and a genuine
  // failure still brings it back. Both fail against the awaited version.

  it("removes the row IMMEDIATELY, without waiting for the backend to answer", async () => {
    const deps = makeDeps([acct("a", { nickname: "Doomed" }), acct("b", { nickname: "Keeper" })]);
    // Never settles — stands in for the slow `remove_dir_all` the founder actually waited on.
    // If the row only disappears when this resolves, it never disappears and the test fails.
    deps.removeAccount = vi.fn(() => new Promise<void>(() => {}));
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    expect(await screen.findByTestId("account-identity-a")).toBeTruthy();
    fireEvent.click(within(await openKebab("a")).getByText("Remove"));
    fireEvent.click(await screen.findByText("Confirm remove"));

    // Gone while the call is still in flight — and the SIBLING is untouched, which is what proves
    // the filter removed one row rather than blanking the list.
    await waitFor(() => expect(screen.queryByTestId("account-identity-a")).toBeNull());
    expect(screen.getByTestId("account-identity-b")).toBeTruthy();
    expect(deps.removeAccount).toHaveBeenCalledWith("a");
  });

  it("puts the row BACK when the remove genuinely fails, and says why", async () => {
    // The optimistic drop must not be able to hide a real failure: this is the paired test without
    // which "always remove it from the list" would pass the one above and silently lose an account.
    const deps = makeDeps([acct("a", { nickname: "Doomed" })]);
    deps.removeAccount = vi.fn(async () => {
      throw "rename accounts.json into place: Device or resource busy";
    });
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    fireEvent.click(within(await openKebab("a")).getByText("Remove"));
    fireEvent.click(await screen.findByText("Confirm remove"));

    // The backend still lists it, so the re-read restores the card — and the cause is shown.
    // (`refresh()` clears `error` on entry, so this also pins that the message is set AFTER it.)
    expect(await screen.findByText(/Device or resource busy/)).toBeTruthy();
    expect(await screen.findByTestId("account-identity-a")).toBeTruthy();
  });

  // The two failure modes the optimistic drop could otherwise introduce, both raised in review.
  // Neither is reachable through the happy-path deps, which is exactly why they need their own
  // cases: `makeDeps().listAccounts` always resolves, so the restore-on-failure test above passes
  // whether the restore is real or merely a side effect of a re-read that happened to work.

  it("keeps the card when the remove AND the re-read both fail (the correlated outage)", async () => {
    // IPC down / accounts lock held / unparseable accounts.json reject BOTH calls. Relying on
    // `refresh()` to restore the row cannot work here: it swallows its own error and returns
    // without touching `accounts`, so the optimistic filter would stand and the account would be
    // gone from the screen while still on disk.
    const deps = makeDeps([acct("a", { nickname: "Doomed" })]);
    let listFails = false;
    deps.listAccounts = vi.fn(async () => {
      if (listFails) throw "ipc unavailable";
      return [acct("a", { nickname: "Doomed" })];
    });
    deps.removeAccount = vi.fn(async () => {
      listFails = true; // the outage that rejected the remove also takes down the re-read
      throw "ipc unavailable";
    });
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect(await screen.findByTestId("account-identity-a")).toBeTruthy();
    fireEvent.click(within(await openKebab("a")).getByText("Remove"));
    fireEvent.click(await screen.findByText("Confirm remove"));

    // The account still exists, so its card must still be here.
    expect(await screen.findByTestId("account-identity-a")).toBeTruthy();
  });

  it("a failed remove does not leave the account filtered out of every LATER refresh", async () => {
    // The tombstone-clear on the failure path is the one line the other two failure tests cannot
    // fail on: both pass with it deleted, because the explicit restore puts the row back either
    // way. The damage surfaces one refresh later — the id stays in `removingRef` forever, so the
    // next `refresh()` from ANY other flow (rename, add, login) silently filters a still-existing
    // account out of the list permanently, with no error and no recovery short of a remount. That
    // is the same "card gone while the account is on disk" shape the optimistic drop must never
    // cause, merely deferred (roborev 65220).
    const rows = [acct("a", { nickname: "Doomed" }), acct("b", { nickname: "Other" })];
    const deps = makeDeps(rows);
    deps.listAccounts = vi.fn(async () => rows); // the backend still HAS both, throughout
    deps.removeAccount = vi.fn(async () => {
      throw "rename accounts.json into place: Device or resource busy";
    });
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    fireEvent.click(within(await openKebab("a")).getByText("Remove"));
    fireEvent.click(await screen.findByText("Confirm remove"));
    // The immediate restore works even without the tombstone-clear, so this alone proves nothing…
    expect(await screen.findByTestId("account-identity-a")).toBeTruthy();

    // …so drive a LATER refresh through an unrelated flow. A committed rename calls refresh().
    fireEvent.click(within(await openKebab("b")).getByText("Rename"));
    const input = screen.getByLabelText("Rename Other");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(deps.setNickname).toHaveBeenCalled());
    // Pin the REFRESH itself, not just the rename that triggers it. The whole discriminating power
    // of this case rests on a later `refresh()` actually running; if the rename path ever stops
    // refreshing, the explicit restore in handleRemove's catch would keep the row on screen and
    // this test would go green with the tombstone-clear unguarded again — the exact shape it was
    // written to close (roborev 65225). Three reads: mount, the remove-failure re-read, the rename.
    await waitFor(() => expect(deps.listAccounts).toHaveBeenCalledTimes(3));

    // The account still exists on the backend, so it must still be on screen.
    expect(screen.getByTestId("account-identity-a")).toBeTruthy();
  });

  it("does not let a refresh that was already in flight resurrect the removed row", async () => {
    // A `refresh()` started BEFORE the delete (mount effect, rename, add, login) resolves after it
    // with a list that still contains the id, and `refresh` writes the list unconditionally.
    // A box rather than a bare `let`: TS's control-flow analysis cannot see the assignment inside
    // the Promise executor, so a nullable local narrows to `never` at the call site below.
    const gate: { open?: () => void } = {};
    let calls = 0;
    const both = [acct("a", { nickname: "Doomed" }), acct("b", { nickname: "Keeper" })];
    const deps = makeDeps(both);
    deps.listAccounts = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return both; // mount
      if (calls === 2) {
        // The stale one: held open across the delete, then resolved with the PRE-delete list.
        await new Promise<void>((r) => {
          gate.open = r;
        });
        return both;
      }
      return [acct("b", { nickname: "Keeper" })];
    });
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    await screen.findByTestId("account-identity-a");

    // Start a second refresh and leave it hanging. A COMMITTED rename is one of the five paths that
    // calls `refresh()`; Escape would only cancel, which refreshes nothing.
    fireEvent.click(within(await openKebab("a")).getByText("Rename"));
    const input = screen.getByLabelText("Rename Doomed");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls).toBe(2));

    fireEvent.click(within(await openKebab("a")).getByText("Remove"));
    fireEvent.click(await screen.findByText("Confirm remove"));
    await waitFor(() => expect(screen.queryByTestId("account-identity-a")).toBeNull());

    // Now let the stale read land carrying the removed account.
    gate.open?.();
    await waitFor(() => expect(screen.getByTestId("account-identity-b")).toBeTruthy());
    // It must NOT come back.
    expect(screen.queryByTestId("account-identity-a")).toBeNull();
  });

  // The RENAME on recovery has to be driven through the real "Finish sign-in" path. The display
  // rule added alongside it masks the stored nickname, so a test that only renders a fixture
  // exercises the display branch and leaves the durable half — the write — guarded by nothing:
  // delete the rename and the suite stays green. That is the untested-production-seam shape.
  it("renames a recovered placeholder row when 'Finish sign-in' actually succeeds", async () => {
    let recovered = false;
    const deps = makeDeps([acct("rec", { nickname: PENDING_NICKNAME })]);
    deps.getIdentities = vi.fn(async () =>
      recovered ? [signedInAs("rec", "someone@example.com")] : [neverLoggedIn("rec")],
    );
    const onLogin = vi.fn(async () => {
      recovered = true; // the login lands a credential in the account's own dir
    });
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);

    fireEvent.click(await screen.findByText("Finish sign-in"));

    await waitFor(() =>
      expect(deps.setNickname).toHaveBeenCalledWith("rec", "someone@example.com"),
    );
  });

  it("does NOT rename when the login was cancelled or failed", async () => {
    // The paired negative. Without it, renaming unconditionally would pass the test above while
    // stamping an email onto a row whose login never completed.
    const deps = makeDeps([acct("rec", { nickname: PENDING_NICKNAME })]);
    deps.getIdentities = vi.fn(async () => [neverLoggedIn("rec")]); // never resolves an identity
    const onLogin = vi.fn(async () => {});
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);

    fireEvent.click(await screen.findByText("Finish sign-in"));

    // `onLogin` is called synchronously at the TOP of handleLogin, before its first await, so
    // waiting on it proves nothing — the rename decision is four awaits later and the assertion
    // below would run before the code under test could act. Wait for the post-login identity
    // re-read instead, which happens immediately BEFORE the rename branch, so absence afterwards is
    // a real absence rather than a race (roborev 65223).
    // Three reads: mount, handleLogin's own refresh(), then the post-login re-read that sits
    // immediately before the rename branch.
    await waitFor(() => expect(deps.getIdentities).toHaveBeenCalledTimes(3));
    expect(deps.setNickname).not.toHaveBeenCalled();
  });

  // ── THE DEFAULT ACCOUNT'S DIRECTORY CAN BE RE-LOGGED-IN UNDERNEATH SPARKLE ──────────────────
  //
  // The founder found his "FC Superadmin" (DEFAULT) card reporting a DIFFERENT account's email,
  // with both cards showing identical usage because they had genuinely become one login. The
  // default account is imported by reference — it IS ~/.claude — so a terminal `claude` login
  // rewrites it and this card follows. `forkNotice` already computed exactly that, but was rendered
  // only in AgentPane, never on the screen someone visits to ask "which account is this?".

  it("warns on the DEFAULT card when the terminal is signed in as someone else", async () => {
    const deps = makeDeps(
      [acct("def", { nickname: "FC Superadmin", isDefault: true })],
      [],
      [
        {
          id: "def",
          email: "super@example.com",
          organization: null,
          accountUuid: "uuid-super",
          // The terminal has been logged into a DIFFERENT account since.
          shellEmail: "someone-else@example.com",
          shellAccountUuid: "uuid-other",
        },
      ],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    const notice = await screen.findByTestId("account-fork-notice-def");
    // Both sides are named — a warning that does not say WHICH other account is not actionable.
    expect(notice.textContent).toContain("someone-else@example.com");
    expect(notice.textContent).toContain("super@example.com");
  });

  it("stays quiet when the terminal and the default account agree", async () => {
    // The paired direction: without it, "always warn" would pass the test above and put a false
    // fork warning on every default card.
    const deps = makeDeps(
      [acct("def", { nickname: "FC Superadmin", isDefault: true })],
      [],
      [
        {
          id: "def",
          email: "super@example.com",
          organization: null,
          accountUuid: "uuid-super",
          shellEmail: "super@example.com",
          shellAccountUuid: "uuid-super",
        },
      ],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    await screen.findByTestId("account-identity-def");
    expect(screen.queryByTestId("account-fork-notice-def")).toBeNull();
  });

  // THE SIGNAL THAT ACTUALLY FIRES FOR A RE-LOGGED-IN DEFAULT.
  //
  // `shellForked` compares the account's own config dir against the shell's, and for the normalized
  // default (`config_dir: ""`) those are two reads of the SAME file — identical by construction, so
  // it can never fire for the founder's case. `identityChanged` is the temporal signal the Rust side
  // records per config dir (`identity_log::takeover_at`), and a terminal `claude` login into another
  // account is exactly that: one file, one identity at a time, a CHANGE rather than a divergence.

  it("warns when the account's folder has hosted a DIFFERENT login recently", async () => {
    const deps = makeDeps(
      [acct("def", { nickname: "FC Superadmin", isDefault: true })],
      [],
      [
        {
          id: "def",
          email: "now@example.com",
          organization: null,
          accountUuid: "uuid-now",
          identityChanged: true,
        },
      ],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    const notice = await screen.findByTestId("account-identity-changed-def");
    expect(notice.textContent).toMatch(/signed into a different Claude account/i);
    // The DEFAULT account gets the explanation that names the cause, since it is the shared dir.
    expect(notice.textContent).toMatch(/terminal/i);
  });

  it("stays quiet when the folder has not changed hands", async () => {
    // Paired direction: without it, rendering the notice unconditionally would pass the test above
    // and put a takeover warning on every card.
    const deps = makeDeps(
      [acct("def", { nickname: "FC Superadmin", isDefault: true })],
      [],
      [{ id: "def", email: "now@example.com", organization: null, accountUuid: "uuid-now" }],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    await screen.findByTestId("account-identity-def");
    expect(screen.queryByTestId("account-identity-changed-def")).toBeNull();
  });

  // ── A SIGN-IN THAT NEVER FINISHED SAYS SO ───────────────────────────────────────────────────
  //
  // The founder found a card still titled "Signing in…" long after the login was abandoned. That
  // placeholder is the row's PERSISTED nickname, written before the login runs and renamed only on a
  // CONFIRMED sign-in — so a failed login leaves it up forever and the card lies indefinitely.

  it("titles a long-pending sign-in 'Trouble signing in' instead of 'Signing in…'", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const deps = makeDeps([
      // Ten minutes into a two-minute window — abandoned by any measure.
      acct("stuck", { nickname: PENDING_NICKNAME, createdAt: nowSec - 600 }),
    ]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    const title = await screen.findByTestId("account-identity-stuck");
    expect(title.textContent).toBe("Trouble signing in");
    // …and the misleading claim is gone from the card entirely, not merely relegated.
    expect(screen.getByTestId("account-row-stuck").textContent).not.toContain(PENDING_NICKNAME);
  });

  it("leaves a sign-in that is still in progress alone", async () => {
    // The paired case. Without it, "always show Trouble signing in for a pending row" would pass
    // the test above while breaking every login the instant it starts.
    const nowSec = Math.floor(Date.now() / 1000);
    const deps = makeDeps([acct("fresh", { nickname: PENDING_NICKNAME, createdAt: nowSec - 5 })]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    const title = await screen.findByTestId("account-identity-fresh");
    expect(title.textContent).toBe(PENDING_NICKNAME);
    expect(title.textContent).not.toContain("Trouble");
  });

  it("stops calling it trouble once the sign-in is RECOVERED", async () => {
    // `signInStalled` reads only the placeholder nickname and `createdAt`, and NEITHER changes when
    // a login is recovered from this card's own "Finish sign-in" button — `handleLogin` renames
    // best-effort, and the modal's rename is bound to its own pending state. So without the
    // signed-in gate the card would show a verified email under a title reading "Trouble signing
    // in", permanently. Both existing cases use identity-less accounts, so this direction was
    // unguarded (roborev 65218).
    const nowSec = Math.floor(Date.now() / 1000);
    const deps = makeDeps(
      [acct("recovered", { nickname: PENDING_NICKNAME, createdAt: nowSec - 600 })],
      [],
      [signedInAs("recovered", "someone@example.com")],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    const title = await screen.findByTestId("account-identity-recovered");
    expect(title.textContent).not.toBe("Trouble signing in");
    // …and it does not fall back to the stale placeholder either — it shows who it really is.
    expect(title.textContent).toBe("someone@example.com");
    expect(screen.getByTestId("account-row-recovered").textContent).not.toContain(PENDING_NICKNAME);
  });

  // ── CONTROLS ABOVE THE TEXT ─────────────────────────────────────────────────────────────────
  //
  // The founder screenshotted buttons colliding with the account name and email: they shared one
  // flex row with the text at `flex: 1`, so at any width where the buttons did not fit, the text
  // wrapped around them. The fix is two stacked blocks — controls first, then a full-width text
  // block with no floated sibling.
  //
  // WHAT THIS CAN AND CANNOT PROVE. jsdom does not lay out (see docs/jsdom-test-caveats.md), so no
  // test here can assert the boxes do not overlap — `getBoundingClientRect` is all zeros. What it
  // CAN pin is the mechanism: the controls precede the identity text in document order, and the two
  // are siblings rather than one containing the other. Both are exactly what a careless refactor
  // would undo, and the "one flex row" arrangement fails this test.

  it("renders the header controls (kebab) BEFORE the identity text, as separate blocks", async () => {
    const deps = makeDeps(
      [acct("a", { nickname: "Removable" })],
      [],
      [signedInAs("a", "someone@example.com")],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    const identity = await screen.findByTestId("account-identity-a");
    // The ⋮ kebab is the persistent header control now (Remove et al. live inside it).
    const kebab = screen.getByTestId("account-menu-button-a");

    // Neither contains the other — they are siblings in the card, not a control inside the text run.
    expect(identity.contains(kebab)).toBe(false);
    expect(kebab.contains(identity)).toBe(false);

    // DOCUMENT_POSITION_FOLLOWING (4) on `kebab.compareDocumentPosition(identity)` means the
    // identity comes AFTER the header controls — i.e. the header row is first.
    const rel = kebab.compareDocumentPosition(identity);
    expect(rel & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // ── A REJECTED COMMAND MUST REPORT WHAT THE BACKEND SAID ────────────────────────────────────
  //
  // A Tauri command's `Err(String)` arrives in JS as a BARE STRING, not an `Error`. Every catch on
  // this screen used `e instanceof Error ? e.message : "Failed to …"`, which is false for exactly
  // that shape — so the real cause was discarded and replaced with a generic line, and the generic
  // line is not logged either. The founder hit a repeated "Failed to remove" that later succeeded,
  // and the reason was unrecoverable afterwards.

  it("surfaces the backend's own message when a remove is rejected with a STRING (Tauri's shape)", async () => {
    const deps = makeDeps([acct("a", { nickname: "Removable" })]);
    // Rejecting with a string, exactly as `invoke` does for `Err(String)` — NOT `new Error(...)`.
    deps.removeAccount = vi.fn(async () => {
      throw "rename accounts.json into place: Device or resource busy";
    });
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    fireEvent.click(within(await openKebab("a")).getByText("Remove"));
    fireEvent.click(await screen.findByText("Confirm remove"));
    // The CAUSE, not the fallback. Against the old code this read "Failed to remove".
    expect(await screen.findByText(/Device or resource busy/)).toBeTruthy();
  });

  it("still falls back to the generic line when the rejection carries no message at all", async () => {
    // The fallback is not dead code — it is what an empty/objectless rejection must produce, and
    // `String(e)` would render "[object Object]" here instead, which is its own useless message.
    const deps = makeDeps([acct("a", { nickname: "Removable" })]);
    deps.removeAccount = vi.fn(async () => {
      throw {};
    });
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    fireEvent.click(within(await openKebab("a")).getByText("Remove"));
    fireEvent.click(await screen.findByText("Confirm remove"));
    expect(await screen.findByText("Failed to remove")).toBeTruthy();
  });

  it("shows the nickname as the bold title, the email as the secondary line, and no org line", async () => {
    // Overhaul items 3 & 4 (founder): the nickname is the card TITLE on its own (no "alias:" prefix),
    // the verified email is the secondary line beneath, and the organization sub-line is gone.
    const deps = makeDeps(
      [acct("a", { nickname: "DROdio Gmail", isDefault: true })],
      [],
      [{ id: "a", email: "drodio@storytell.ai", organization: "drodio@storytell.ai's Organization", accountUuid: null }],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    // The nickname is the bold title (identity slot) — on its own, no "alias:" prefix anywhere.
    expect((await screen.findByTestId("account-identity-a")).textContent).toBe("DROdio Gmail");
    expect(screen.queryByText(/alias:/)).toBeNull();
    // The email is the SECONDARY line beneath.
    expect(screen.getByTestId("account-identity-sub-a").textContent).toBe("drodio@storytell.ai");
    // The organization line was removed entirely.
    expect(screen.queryByText("drodio@storytell.ai's Organization")).toBeNull();
  });

  it("a not-signed-in account: nickname title, but the sub-line AND blocked banner say Not signed in", async () => {
    // The founder's live state (bead sparkle-gwkui): a config dir with no `oauthAccount`. The
    // overhaul makes the nickname the title, but sign-in status must NOT be hidden — the secondary
    // line reads "Not signed in" (amber) and the loud blocked banner still renders, so an
    // unauthenticated registration is never disguised as a working login.
    const deps = makeDeps(
      [acct("a", { nickname: "DROdio Chief" })],
      [],
      [{ id: "a", email: null, organization: null, accountUuid: null }],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect((await screen.findByTestId("account-identity-a")).textContent).toBe("DROdio Chief");
    expect(screen.getByTestId("account-identity-sub-a").textContent).toBe("Not signed in");
    expect(screen.getByTestId("account-blocked-a")).toBeTruthy();
  });

  it("states a uuid-only login honestly in the secondary line (not 'Not signed in')", async () => {
    // A login with a uuid but no readable email IS signed in, so "Not signed in" would be a lie. The
    // title is the nickname; the SECONDARY line carries the honest "signed in, no email" status —
    // never the false "Not signed in", and the card is NOT blocked.
    const deps = makeDeps([acct("a", { nickname: "Nick" })], [], [
      { id: "a", email: null, organization: null, accountUuid: "u1" },
    ]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect((await screen.findByTestId("account-identity-a")).textContent).toBe("Nick");
    const sub = screen.getByTestId("account-identity-sub-a");
    expect(sub.textContent).not.toBe("Not signed in");
    expect(sub.textContent).toMatch(/signed in/i);
    expect(screen.queryByTestId("account-blocked-a")).toBeNull();
  });

  it("shows an exhausted-until indicator when an account is rate-limited", async () => {
    const future = Date.now() + 60 * 60 * 1000;
    const deps = makeDeps(
      [acct("a", { nickname: "Limited" })],
      [{ id: "a", tokens5h: 0, tokens7d: 0, exhaustedUntil: future }],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect(await screen.findByText(/Exhausted until/)).toBeTruthy();
  });
});

describe("account card ordering (item 1) — wired and stable under a rename", () => {
  afterEach(cleanup);

  it("renders cards most-REAL-space first: roomy, then tight, then unknown-usage, then signed-out", async () => {
    // Item 1 WIRING. The comparator itself is unit-tested in accountsView.test.ts; this pins that the
    // SCREEN actually applies it to the rendered rows. Non-vacuous: reverting `orderedAccounts` to
    // `accounts.map(...)` renders registration order [tight, roomy, err, out] and fails here; swapping
    // the projection's session/weekly windows also fails once the two data rows differ.
    const deps = makeDeps(
      [
        acct("tight", { nickname: "Tight" }),
        acct("roomy", { nickname: "Roomy" }),
        acct("err", { nickname: "Err" }),
        acct("out", { nickname: "Out" }),
      ],
      [],
      [
        signedInAs("tight", "tight@x.com"),
        signedInAs("roomy", "roomy@x.com"),
        signedInAs("err", "err@x.com"),
        neverLoggedIn("out"),
      ],
    );
    deps.getUsageLive = vi.fn(async (configDir: string) => {
      if (configDir === "/cfg/roomy") return liveUsage(10, 10); // most space → top
      if (configDir === "/cfg/tight") return liveUsage(92, 92); // little space → below roomy
      if (configDir === "/cfg/err") throw new Error("no creds"); // unknown-usage tier
      return liveUsage(50, 50); // out: has data, but signed-out sorts LAST regardless
    });
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    // Wait for both data rows to settle so the sort key is populated before asserting order.
    await waitFor(() => expect(screen.getAllByText("10%").length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getAllByText("92%").length).toBeGreaterThan(0));
    await waitFor(() => {
      const ids = screen
        .getAllByTestId(/^account-row-/)
        .map((el) => el.getAttribute("data-testid"));
      expect(ids).toEqual([
        "account-row-roomy",
        "account-row-tight",
        "account-row-err",
        "account-row-out",
      ]);
    });
  });

  it("holds the row order steady while a rename is open, so a sibling's usage landing can't move the edited row", async () => {
    // A rename commits on blur; row order is a function of async per-account usage. Without the freeze
    // in AccountsScreen (`editingId !== null` → reuse the last settled order), a sibling's usage
    // landing mid-rename re-sorts the keyed list, re-parents the edited row, blurs its <input>, and
    // its onBlur commits the half-typed draft. Non-vacuous: delete the freeze and this resolves to
    // order [b, a] with the edited "a" row moved, failing the order assertion.
    let resolveB: (v: AccountUsageLive) => void = () => {};
    const deps = makeDeps(
      [acct("a", { nickname: "Alpha" }), acct("b", { nickname: "Bravo" })],
      [],
      [signedInAs("a", "a@x.com"), signedInAs("b", "b@x.com")],
    );
    deps.getUsageLive = vi.fn((configDir: string) =>
      configDir === "/cfg/a"
        ? Promise.resolve(liveUsage(90, 90)) // a: little space, but it HAS data (tier 0)
        : new Promise<AccountUsageLive>((res) => {
            resolveB = res; // b: unknown (tier 1) until we resolve it
          }),
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    // Initial order: a (has data, tier 0) above b (unknown, tier 1).
    await waitFor(() => {
      const ids = screen
        .getAllByTestId(/^account-row-/)
        .map((el) => el.getAttribute("data-testid"));
      expect(ids).toEqual(["account-row-a", "account-row-b"]);
    });

    // Open a rename on account a (currently on top).
    fireEvent.click(within(await openKebab("a")).getByText("Rename"));
    const input = screen.getByLabelText("Rename Alpha");
    fireEvent.change(input, { target: { value: "Alpha EDITED" } });

    // b's usage now lands with MUCH more space than a — absent the freeze this reorders to [b, a].
    resolveB(liveUsage(5, 5));
    await new Promise((r) => setTimeout(r, 0));

    // Order held steady, the rename input is still mounted, and nothing was committed.
    const ids = screen
      .getAllByTestId(/^account-row-/)
      .map((el) => el.getAttribute("data-testid"));
    expect(ids).toEqual(["account-row-a", "account-row-b"]);
    expect(screen.getByLabelText("Rename Alpha")).toBeTruthy();
    expect(deps.setNickname).not.toHaveBeenCalled();
  });
});

describe("duplicate-login warning", () => {
  // Reproduces the live-machine state that motivated this: "DROdio Storytell" and "DROdio Gmail"
  // were two config dirs holding ONE login (accountUuid 5fb3d67c-…), presented as two accounts
  // with independent headroom bars.
  const UUID = "5fb3d67c-f4ed-417b-9bf2-f9156450eb73";

  it("warns when two registered accounts are the same Claude login", async () => {
    const deps = makeDeps(
      [
        acct("s", { nickname: "DROdio Storytell", isDefault: true }),
        acct("g", { nickname: "DROdio Gmail" }),
      ],
      [],
      [
        { id: "s", email: "drodio@gmail.com", organization: null, accountUuid: UUID },
        { id: "g", email: "drodio@gmail.com", organization: null, accountUuid: UUID },
      ],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const alert = await screen.findByText(/are the same Claude login/i);
    expect(alert).toBeTruthy();
    expect(alert.textContent).toContain("drodio@gmail.com");
    // Names both offenders so the user knows which to re-log-in.
    const banner = alert.closest("[role='alert']");
    expect(banner?.textContent).toContain("DROdio Storytell");
    expect(banner?.textContent).toContain("DROdio Gmail");
  });

  // Four registrations of one login is the live-machine state that exposed the join: the names were
  // `.join(" and ")`-ed, so the banner read "A and B and C and D" — a sentence nobody can parse at a
  // glance, in the one place the user has to identify WHICH accounts to fix.
  it("comma-separates the names when more than two accounts share the login", async () => {
    const deps = makeDeps(
      [
        acct("p", { nickname: "DROdio Personal", isDefault: true }),
        acct("g", { nickname: "DROdio Gmail" }),
        acct("s", { nickname: "DROdio Storytell II" }),
        acct("a", { nickname: "DROdio AmForge" }),
      ],
      [],
      ["p", "g", "s", "a"].map((id) => ({
        id,
        email: "drodio@gmail.com",
        organization: null,
        accountUuid: UUID,
      })),
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const alert = await screen.findByText(/are the same Claude login/i);
    const banner = alert.closest("[role='alert']");
    expect(banner?.textContent).toContain(
      "DROdio Personal, DROdio Gmail, DROdio Storytell II and DROdio AmForge share one usage quota",
    );
    // The defect this replaces, stated directly: no name is introduced by a repeated "and".
    expect(banner?.textContent).not.toContain("and DROdio Gmail and");
  });

  it("shows no warning when the accounts are genuinely different logins", async () => {
    const deps = makeDeps(
      [acct("s", { nickname: "Storytell" }), acct("g", { nickname: "Gmail" })],
      [],
      [
        { id: "s", email: "drodio@storytell.ai", organization: null, accountUuid: "uuid-a" },
        { id: "g", email: "drodio@gmail.com", organization: null, accountUuid: "uuid-b" },
      ],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect(await screen.findByText("drodio@storytell.ai")).toBeTruthy();
    expect(screen.queryByText(/are the same Claude login/i)).toBeNull();
  });

  it("does not warn about accounts that simply aren't signed in yet", async () => {
    const deps = makeDeps(
      [acct("s", { nickname: "One" }), acct("g", { nickname: "Two" })],
      [],
      [
        { id: "s", email: null, organization: null, accountUuid: null },
        { id: "g", email: null, organization: null, accountUuid: null },
      ],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect((await screen.findByTestId("account-identity-s")).textContent).toBe("One");
    expect(screen.queryByText(/are the same Claude login/i)).toBeNull();
  });
});

describe("log in / switch login on an EXISTING account", () => {
  // Before this, onLogin fired only at account-CREATION time, so an account that was never signed
  // into — or two that turned out to hold the same login — had no route to a fix but delete and
  // recreate. Re-logging one of a duplicate pair into a different Claude account IS the remedy.
  it("offers 'Finish sign-in' for an account with no identity — exactly once", async () => {
    // Renamed from "Log in": the label has to say the login is UNFINISHED, because the state it
    // fixes is a registered row that looks like a working account. Exactly one such button per row —
    // the header affordance is suppressed for an unsigned account so the loud block owns it, and two
    // identically-named buttons in one card would be noise and an ambiguous target for this test.
    const onLogin = vi.fn();
    const deps = makeDeps([acct("a", { nickname: "Third" })], [], [
      { id: "a", email: null, organization: null, accountUuid: null },
    ]);
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    const btn = await screen.findByRole("button", { name: "Finish sign-in" });
    expect(screen.getAllByRole("button", { name: "Finish sign-in" })).toHaveLength(1);
    fireEvent.click(btn);
    expect(onLogin).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("offers 'Switch login' for an account that IS signed in", async () => {
    const onLogin = vi.fn();
    const deps = makeDeps([acct("a", { nickname: "Gmail" })], [], [
      { id: "a", email: "drodio@gmail.com", organization: null, accountUuid: "u1" },
    ]);
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    fireEvent.click(within(await openKebab("a")).getByText("Switch login"));
    expect(onLogin).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("is offered for the default account too — behind a confirm", async () => {
    // The default (~/.claude) is the one most likely to be signed into the wrong account, and it
    // can't be removed — so without a login button it would be permanently stuck. But its config
    // dir is the user's REAL ~/.claude, so it takes a confirm step; see the guard suite below.
    const onLogin = vi.fn();
    const deps = makeDeps([acct("a", { nickname: "Default", isDefault: true })], [], [
      { id: "a", email: "drodio@gmail.com", organization: null, accountUuid: "u1" },
    ]);
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    fireEvent.click(within(await openKebab("a")).getByText("Switch login"));
    fireEvent.click(screen.getByRole("button", { name: "Change default account login" }));
    expect(onLogin).toHaveBeenCalledOnce();
  });
});

describe("the DEFAULT account's login is guarded", () => {
  // Its configDir is the user's real ~/.claude (registered by reference, never copied — which is
  // why the Rust side also refuses to delete it). Re-logging it in replaces the login used by
  // `claude` everywhere on the machine, not just inside Sparkle. That must not be one click.
  it("requires a confirm step before re-logging in the default account", async () => {
    const onLogin = vi.fn();
    const deps = makeDeps([acct("a", { nickname: "Default", isDefault: true })], [], [
      { id: "a", email: "drodio@gmail.com", organization: null, accountUuid: "u1" },
    ]);
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);

    fireEvent.click(within(await openKebab("a")).getByText("Switch login"));
    expect(onLogin).not.toHaveBeenCalled(); // choosing it only arms the confirm

    const confirm = screen.getByRole("button", { name: "Change default account login" });
    fireEvent.click(confirm);
    expect(onLogin).toHaveBeenCalledOnce();
  });

  it("the confirm can be cancelled without logging in", async () => {
    const onLogin = vi.fn();
    const deps = makeDeps([acct("a", { nickname: "Default", isDefault: true })], [], [
      { id: "a", email: "drodio@gmail.com", organization: null, accountUuid: "u1" },
    ]);
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    fireEvent.click(within(await openKebab("a")).getByText("Switch login"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onLogin).not.toHaveBeenCalled();
    // Cancelling returns to the pre-confirm state — Switch login is still available in the kebab.
    expect(within(await openKebab("a")).getByText("Switch login")).toBeTruthy();
  });

  it("a NON-default account still logs in with one click", async () => {
    const onLogin = vi.fn();
    const deps = makeDeps([acct("a", { nickname: "Second" })], [], [
      { id: "a", email: "drodio@gmail.com", organization: null, accountUuid: "u1" },
    ]);
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    // "One click" = the menu item itself; a non-default account has NO confirm step (unlike default).
    fireEvent.click(within(await openKebab("a")).getByText("Switch login"));
    expect(onLogin).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Change default account login" })).toBeNull();
  });

  it("treats an identity with a uuid but no email as signed in — while saying it has no email", async () => {
    // The login AFFORDANCE keys on uuid-OR-email (`isSignedIn`), because the Rust AccountIdentity
    // allows those independently and duplicate detection matches on uuid alone: keying the button
    // on email would offer "Log in" for an account that IS signed in.
    //
    // The IDENTITY SLOT keys on EMAIL, so for an `oauthAccount` carrying no readable
    // `emailAddress` the two deliberately differ in what they can say — but NOT in whether the
    // account is signed in. Two parallel branches disagreed here and the merge had to pick: §4c's
    // two-state rule would print the literal "Not signed in", which is FALSE for a login that
    // genuinely has a uuid, and false in the direction that pushes the user to re-authenticate an
    // account they are already on. "A wrong identity is worse than none" (§5) cuts both ways, so
    // the slot gets a third honest string instead. What must NOT happen on any branch is the
    // nickname appearing as the identity.
    const deps = makeDeps([acct("a", { nickname: "Nick" })], [], [
      { id: "a", email: null, organization: null, accountUuid: "u1" },
    ]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    // Signed in (uuid present) → the kebab offers "Switch login".
    expect(within(await openKebab("a")).getByText("Switch login")).toBeTruthy();
    // Post-overhaul: the title slot is the nickname, and the honest "signed in, no email" status
    // lives on the SECONDARY line — never the false "Not signed in". (The old rule forbidding the
    // nickname in the identity slot was superseded by the founder's title-is-the-nickname overhaul;
    // sign-in status stays honest via the sub-line + the absence of the blocked banner.)
    expect(screen.getByTestId("account-identity-a").textContent).toBe("Nick");
    expect(screen.getByTestId("account-identity-sub-a").textContent).toBe(SIGNED_IN_NO_EMAIL);
    expect(screen.queryByText(NOT_SIGNED_IN)).toBeNull();
    expect(screen.queryByTestId("account-blocked-a")).toBeNull();
  });
});

// ── Rotation visibility ───────────────────────────────────────────────────────────────────────
// The founder opened this screen, counted two rows, saw every agent land on the same account and
// concluded rotation was broken. It was never running: one of those rows had never been signed
// into, so the candidate pool had exactly one member and `pickAccount` had exactly one answer.
// Everything below asserts the screen now SAYS that, in the states that actually occur.

const CEIL = 100_000_000;
function ceiling(id: string, value: number | null): Ceiling {
  return { id, samples: value == null ? [] : [value], ceiling: value };
}
function used(id: string, tokens5h: number, exhaustedUntil: number | null = null): Usage {
  return { id, tokens5h, tokens7d: tokens5h, exhaustedUntil };
}
function signedInAs(id: string, email: string, uuid: string | null = `uuid-${id}`): Identity {
  return { id, email, organization: null, accountUuid: uuid };
}
function neverLoggedIn(id: string): Identity {
  return { id, email: null, organization: null, accountUuid: null };
}
/** Locale-formatted clock time, matching the screen's own formatter. */
function clock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

describe("rotation-readiness banner", () => {
  it("THE FOUNDER'S STATE: says ONE account is usable and names the dead row", async () => {
    // Two registered accounts, one of which has no `oauthAccount` in its config dir. Before this
    // banner the screen said nothing at all about the difference, so "2 accounts" was the only
    // number on offer and "rotation is broken" the only conclusion it supported.
    const deps = makeDeps(
      [
        acct("personal", { nickname: "DROdio Personal", isDefault: true }),
        acct("gmail", { nickname: "DROdio Gmail" }),
      ],
      [used("personal", 10_000_000)],
      [signedInAs("personal", "drodio@gmail.com"), neverLoggedIn("gmail")],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const banner = await screen.findByTestId("rotation-banner");
    expect(banner.textContent).toContain("Only 1 account is signed in");
    expect(banner.textContent).toContain("nothing to rotate to");
    // Names the account every agent will actually land on — by its VERIFIED email.
    expect(banner.textContent).toContain("drodio@gmail.com");
    expect(banner.textContent).toContain("Sign in another account to enable rotation");
    // ...and names the registration that does NOT count, which is the part that was invisible.
    expect(banner.textContent).toContain("DROdio Gmail");
    expect(banner.textContent).toContain("never been signed in");
    expect(banner.textContent).not.toContain("Rotation active");
  });

  it("says NOTHING is signed in when no account has a login", async () => {
    const deps = makeDeps(
      [acct("a", { nickname: "One" }), acct("b", { nickname: "Two" })],
      [],
      [neverLoggedIn("a"), neverLoggedIn("b")],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const banner = await screen.findByTestId("rotation-banner");
    expect(banner.textContent).toContain("No account is signed in");
    expect(banner.textContent).toContain("whatever your terminal is logged into");
    expect(banner.textContent).not.toContain("Rotation active");
  });

  it("reports rotation ACTIVE with the count and the accounts once two logins exist", async () => {
    const deps = makeDeps(
      [acct("a", { nickname: "One" }), acct("b", { nickname: "Two" })],
      [],
      [signedInAs("a", "one@example.com", "u1"), signedInAs("b", "two@example.com", "u2")],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const banner = await screen.findByTestId("rotation-banner");
    expect(banner.textContent).toContain("Rotation active — 2 accounts available");
    expect(banner.textContent).toContain("one@example.com");
    expect(banner.textContent).toContain("two@example.com");
    expect(banner.textContent).not.toContain("nothing to rotate to");
  });

  it("counts two registrations of the SAME login as ONE usable account", async () => {
    // Two config dirs, one Anthropic account, one quota. Counting rows would report "Rotation
    // active — 2 accounts available" for a user who cannot rotate at all: both "targets" hit the
    // same wall at the same instant.
    const UUID = "5fb3d67c-f4ed-417b-9bf2-f9156450eb73";
    const deps = makeDeps(
      [acct("s", { nickname: "Storytell" }), acct("g", { nickname: "Gmail" })],
      [],
      [signedInAs("s", "drodio@gmail.com", UUID), signedInAs("g", "drodio@gmail.com", UUID)],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const banner = await screen.findByTestId("rotation-banner");
    expect(banner.textContent).toContain("Only 1 account is signed in");
    expect(banner.textContent).not.toContain("2 accounts available");
    // ...and says WHICH row was discounted, and why.
    expect(banner.textContent).toContain("Gmail");
    expect(banner.textContent).toContain("share one quota");
  });

  it("collapses two same-placeholder excluded accounts into ONE counted bullet", async () => {
    // "Signing in…" / "Login expired — reconnect" are GENERIC placeholder nicknames shared by every
    // not-signed-in account, so two of them used to render the SAME sentence twice — a visible bug,
    // and a React key collision. One real login keeps the banner in the "only 1 signed in" state where
    // the excluded bullets show.
    const deps = makeDeps(
      [
        acct("real", { nickname: "Real", isDefault: true }),
        acct("p1", { nickname: PENDING_NICKNAME }),
        acct("p2", { nickname: PENDING_NICKNAME }),
      ],
      [],
      [signedInAs("real", "real@example.com", "u1"), neverLoggedIn("p1"), neverLoggedIn("p2")],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const banner = await screen.findByTestId("rotation-banner");
    const placeholderBullets = within(banner)
      .getAllByRole("listitem")
      .filter((li) => /never signed in|never been signed in/i.test(li.textContent ?? ""));
    // ONE bullet for the two shared-placeholder accounts, not two byte-identical ones.
    expect(placeholderBullets).toHaveLength(1);
    expect(placeholderBullets[0]!.textContent).toContain("2 accounts are still");
    expect(placeholderBullets[0]!.textContent).toContain(PENDING_NICKNAME);
  });

  it("keeps distinctly-named excluded accounts on their OWN bullets (no over-collapse)", async () => {
    // The collapse keys on the shared nickname: a user who renamed a not-signed-in account must still
    // see it called out separately, not folded into a count with an unrelated one.
    const deps = makeDeps(
      [
        acct("real", { nickname: "Real", isDefault: true }),
        acct("p1", { nickname: "Renamed A" }),
        acct("p2", { nickname: "Renamed B" }),
      ],
      [],
      [signedInAs("real", "real@example.com", "u1"), neverLoggedIn("p1"), neverLoggedIn("p2")],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const banner = await screen.findByTestId("rotation-banner");
    expect(banner.textContent).toContain("Renamed A");
    expect(banner.textContent).toContain("Renamed B");
    expect(banner.textContent).not.toContain("2 accounts are still");
  });

  it("collapses two EXPIRED-login accounts (in notSignedIn) with EXPIRED copy, not 'never signed in'", async () => {
    // The expired placeholder is produced with email AND accountUuid BOTH null — the oauthAccount was
    // cleared — so rotationReadiness files it under notSignedIn, NOT noEmail (the earlier "noEmail
    // retains the uuid" premise was wrong; roborev 67153/67154). The two collapse to ONE bullet whose
    // copy must say the login EXPIRED — never "registered but never signed in", which contradicts the
    // nickname it quotes and points at the wrong remedy. Fixture uses the shape the wire actually emits:
    // {email: null, accountUuid: null}.
    const deps = makeDeps(
      [
        acct("real", { nickname: "Real", isDefault: true }),
        acct("x1", { nickname: EXPIRED_LOGIN_NICKNAME }),
        acct("x2", { nickname: EXPIRED_LOGIN_NICKNAME }),
      ],
      [],
      [
        signedInAs("real", "real@example.com", "u1"),
        { id: "x1", email: null, organization: null, accountUuid: null },
        { id: "x2", email: null, organization: null, accountUuid: null },
      ],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const banner = await screen.findByTestId("rotation-banner");
    const expiredBullets = within(banner)
      .getAllByRole("listitem")
      .filter((li) => /login expired/i.test(li.textContent ?? ""));
    expect(expiredBullets).toHaveLength(1); // collapsed, not two identical bullets
    expect(expiredBullets[0]!.textContent).toContain("2 accounts show");
    expect(expiredBullets[0]!.textContent).toContain("reconnect them");
    // The contradiction the earlier fix shipped: an expired login labelled "never signed in".
    expect(banner.textContent).not.toContain("never signed in");
  });

  it("does NOT collapse REDUNDANT accounts — two same-nickname rows can be DIFFERENT logins", async () => {
    // roborev 67907: `redundant` rows are signed in with real emails and can duplicate two DIFFERENT
    // usable logins, so a plural "…they share one quota and count as one" would assert a relationship
    // that need not hold. Here `dupA` duplicates login X and `dupB` duplicates login Y — both nicknamed
    // "Extra" — so they must render as TWO separate per-account bullets, never one collapsed count.
    const deps = makeDeps(
      [
        acct("a", { nickname: "Work A", isDefault: true }),
        acct("dupA", { nickname: "Extra" }),
        acct("c", { nickname: "Work C" }),
        acct("dupB", { nickname: "Extra" }),
      ],
      [],
      [
        signedInAs("a", "a@example.com", "uX"),
        signedInAs("dupA", "a@example.com", "uX"), // same login as a → redundant
        signedInAs("c", "c@example.com", "uY"),
        signedInAs("dupB", "c@example.com", "uY"), // same login as c → redundant, DIFFERENT login from dupA
      ],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const banner = await screen.findByTestId("rotation-banner");
    const redundantBullets = within(banner)
      .getAllByRole("listitem")
      .filter((li) => /the same Claude login as another account/i.test(li.textContent ?? ""));
    expect(redundantBullets).toHaveLength(2); // per-account, never collapsed
    // And never the false group-level claim about the two grouped rows.
    expect(banner.textContent).not.toContain("2 accounts are “Extra”");
  });

  it("offers the fix inline: the banner's own add button opens the add form", async () => {
    const deps = makeDeps([acct("a")], [], [signedInAs("a", "one@example.com")]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    fireEvent.click(await screen.findByRole("button", { name: /Add another account/ }));
    // The form is open and ready to type into — the remedy is one click from the diagnosis.
    expect(screen.getByLabelText("New account nickname")).toBeTruthy();
  });

  // THE PROSE IS GONE, THE CONTROLS ARE NOT (sparkle-cjpte). The founder cut the "Adding a Claude
  // account takes two minutes" step list and the "Each account is a separate Claude login…"
  // paragraph: the controls carry the meaning now. That makes this a PAIRED test on purpose —
  // asserting only the absence would stay green if the controls the copy used to name disappeared
  // with it, which is the actual risk when you delete the text that explains a screen.
  it("drops the explanatory prose but keeps the controls it used to describe", async () => {
    const deps = makeDeps([acct("a")], [], [signedInAs("a", "one@example.com")]);
    const { container } = render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    // Wait for a real control rather than the deleted block, so this cannot pass by rendering nothing.
    expect(await screen.findByRole("button", { name: /\+ Add account/ })).toBeTruthy();

    // Gone: the step list and the paragraph, asserted on the RENDERED document.
    expect(screen.queryByTestId("add-account-steps")).toBeNull();
    const text = container.textContent ?? "";
    expect(text).not.toContain("Adding a Claude account takes two minutes");
    expect(text).not.toContain("Each account is a separate Claude login");
    expect(text).not.toContain("Bars show each account");
    expect(text).not.toContain("never sees your Claude credentials");
  });

  it("still reaches the per-row Finish sign-in control the deleted copy pointed at", async () => {
    // An account with a config dir but no identity = registered, never logged in. That is the exact
    // row the removed step 4 told the user to click "Finish sign-in" on.
    const deps = makeDeps([acct("a"), acct("dead")], [], [signedInAs("a", "one@example.com"), neverLoggedIn("dead")]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const finish = await screen.findAllByRole("button", { name: /Finish sign-in/ });
    expect(finish.length).toBeGreaterThan(0);
  });
});

describe("the estimated 'usual limit' headroom bar is GONE (real Anthropic usage is the truth)", () => {
  // The account card used to render a `HeadroomLine` from the LEARNED-CEILING estimate — a yellow
  // "Close to its limit — X of about Y · N% of its usual limit / Stops taking new agents at 90% of
  // that" bar. It was removed at the founder's instruction: it screamed "90%, close to the wall"
  // while the REAL USAGE (ANTHROPIC) section right below showed the account clear. These tests pin
  // the removal (the copy is gone even for the exact inputs that used to draw it) and that the real
  // section stays.
  const ESTIMATE_COPY = [
    "Close to its limit",
    "Room to spare",
    "Limit unknown",
    "usual limit",
    "of about",
    "Stops taking new agents",
    "Not enough history to estimate a limit yet",
  ];

  it("renders NO estimate bar or copy even when a learned ceiling IS present", async () => {
    // A learned ceiling at 90% usage is the exact input that used to draw the "Close to its limit …
    // 90% of its usual limit" bar. None of that copy renders now, and there is no headroom testid.
    const deps = makeDeps(
      [acct("a", { nickname: "One" })],
      [used("a", 0.9 * CEIL)],
      [signedInAs("a", "one@example.com")],
      [ceiling("a", CEIL)],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const card = await screen.findByTestId("account-row-a");
    expect(screen.queryByTestId("account-headroom-a")).toBeNull();
    for (const gone of ESTIMATE_COPY) expect(card.textContent).not.toContain(gone);
    // getUsageLive rejects in this fixture, so the ONLY usage state is the "unavailable" note and
    // there is no progressbar of any origin — the estimate bar is not hiding under a role.
    expect(within(card).queryAllByRole("progressbar")).toHaveLength(0);
  });

  it("renders no estimate copy for a NULL (unlearned) ceiling either", async () => {
    const deps = makeDeps(
      [acct("a", { nickname: "One" })],
      [used("a", 45_000_000)],
      [signedInAs("a", "one@example.com")],
      [ceiling("a", null)],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const card = await screen.findByTestId("account-row-a");
    for (const gone of ESTIMATE_COPY) expect(card.textContent).not.toContain(gone);
  });

  it("STILL shows the REAL USAGE (ANTHROPIC) section when live figures are available", async () => {
    // The section the founder keeps — session 39% / weekly 71% on his card, comfortably clear while
    // the removed estimate had been screaming 90%.
    const deps = makeDeps(
      [acct("a", { nickname: "One" })],
      [used("a", 0.9 * CEIL)],
      [signedInAs("a", "one@example.com")],
      [ceiling("a", CEIL)],
    );
    deps.getUsageLive = vi.fn(async () => liveUsage(39, 71));
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const card = await screen.findByTestId("account-row-a");
    expect(await within(card).findByText("Session (5h)")).toBeTruthy();
    expect(within(card).getByText("Weekly (7d)")).toBeTruthy();
    expect(within(card).getByText("39%")).toBeTruthy();
    expect(within(card).getByText("71%")).toBeTruthy();
    // Two real bars, and NOTHING from the removed estimate.
    expect(within(card).getAllByRole("progressbar").length).toBe(2);
    for (const gone of ESTIMATE_COPY) expect(card.textContent).not.toContain(gone);
  });

  it("still shows the observed 'Exhausted until' line for a real rate limit", async () => {
    // The observed wall is fact, not estimate, so its line stays. It is a SEPARATE element from the
    // removed HeadroomLine.
    const reset = Date.now() + 47 * 60_000;
    const deps = makeDeps(
      [acct("a")],
      [used("a", 1_000, reset)],
      [signedInAs("a", "one@example.com")],
      [ceiling("a", CEIL)],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect(await screen.findByText(`Exhausted until ${clock(reset)}`)).toBeTruthy();
    expect(screen.queryByTestId("account-headroom-a")).toBeNull();
  });

  it("keeps rendering accounts when the ceilings read FAILS", async () => {
    // Ceilings are an enrichment. Sharing a rejection path with `listAccounts` would trade a missing
    // number for a screen showing no accounts at all.
    const deps = makeDeps([acct("a", { nickname: "One" })], [used("a", 5)], [
      signedInAs("a", "one@example.com"),
    ]);
    deps.listCeilings = vi.fn(async () => {
      throw new Error("accounts_ceilings unavailable");
    });
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect(await screen.findByText("one@example.com")).toBeTruthy();
    // ...and no error banner: a missing enrichment is not a failure to report to the user.
    expect(screen.queryByText(/accounts_ceilings unavailable/)).toBeNull();
  });
});

describe("AC8 — every account at its limit", () => {
  it("says so, and names the EARLIEST reset across the accounts", async () => {
    const soon = Date.now() + 20 * 60_000;
    const later = Date.now() + 95 * 60_000;
    const deps = makeDeps(
      [acct("a"), acct("b")],
      [used("a", 1_000, later), used("b", 1_000, soon)],
      [signedInAs("a", "one@example.com", "u1"), signedInAs("b", "two@example.com", "u2")],
      [ceiling("a", CEIL), ceiling("b", CEIL)],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const banner = await screen.findByTestId("all-at-limit-banner");
    expect(banner.textContent).toContain("All accounts are at their limit");
    // The EARLIER instant, not merely "a" instant — that ordering is the whole content of AC8.
    expect(banner.textContent).toContain(`The first frees up at ${clock(soon)}`);
    expect(banner.textContent).not.toContain(clock(later));
    // MUST NOT promise spawns are blocked: `pickAccount` still returns an account rather than
    // refusing. The wording is the founder's (sparkle-cjpte) — it replaced "new agents go to the
    // least-bad account — so work carries on" — but the CONSTRAINT it has to satisfy is unchanged,
    // which is why the negative assertion below outlived the sentence above it.
    expect(banner.textContent).toContain("Sparkle spawns new agents in the least-used account.");
    expect(banner.textContent).not.toMatch(/blocked|will not spawn|stops spawning/i);
  });

  it("uses singular phrasing when there is only one signed-in account", async () => {
    const reset = Date.now() + 33 * 60_000;
    const deps = makeDeps(
      [acct("a"), acct("dead")],
      [used("a", 1_000, reset)],
      [signedInAs("a", "one@example.com"), neverLoggedIn("dead")],
      [ceiling("a", CEIL)],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const banner = await screen.findByTestId("all-at-limit-banner");
    expect(banner.textContent).toContain("Your only signed-in account is at its limit");
    expect(banner.textContent).toContain(`It frees up at ${clock(reset)}`);
  });

  it("is NOT shown while any account still has room", async () => {
    const deps = makeDeps(
      [acct("a"), acct("b")],
      [used("a", 1_000, Date.now() + 60_000), used("b", 5_000_000)],
      [signedInAs("a", "one@example.com", "u1"), signedInAs("b", "two@example.com", "u2")],
      [ceiling("a", CEIL), ceiling("b", CEIL)],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    await screen.findByText("two@example.com");
    expect(screen.queryByTestId("all-at-limit-banner")).toBeNull();
  });

  it("fires from REAL Anthropic usage with no observed wall — and quotes NO reset time", async () => {
    // AC8 tracks the SAME signal the spawn gate excludes on: an account at 97% of its REAL Anthropic
    // limit with NO rate-limit event is out of room to auto-pick, so the banner must say so. And
    // because there is no observed wall, there is no reset instant to quote — the "No reset time"
    // branch (unreachable under observed-only) is reachable again exactly here. Remove the live
    // clause from `exhaustionOutlook` and this banner never renders (the gate and banner disagree).
    const deps = makeDeps(
      [acct("a")],
      [used("a", 5)], // low local tally, NOT exhausted
      [signedInAs("a", "one@example.com")],
      [ceiling("a", CEIL)],
    );
    deps.getUsageLive = vi.fn(async () => liveUsage(97, 50)); // 97% real → spent
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const banner = await screen.findByTestId("all-at-limit-banner");
    expect(banner.textContent).toContain("Your only signed-in account is at its limit");
    expect(banner.textContent).toContain("No reset time has been reported yet");
    expect(banner.textContent).not.toMatch(/frees up at/);
  });
});

describe("AC9 — runway warning on an observed wall", () => {
  // The runway warning now fires ONLY on a real, OBSERVED rate limit — the learned-ceiling estimate
  // (the old 85% "approaching" trigger) was retired as a driver. It read "close to its limit" while
  // the real Anthropic figures were clear.
  it("warns with the switch target when an account hits a real wall", async () => {
    // `a` has actually hit its limit; `b` is healthy — so move to `b`.
    const deps = makeDeps(
      [acct("a"), acct("b")],
      [used("a", 1_000, Date.now() + 60_000), used("b", 5_000_000)],
      [signedInAs("a", "one@example.com", "u1"), signedInAs("b", "two@example.com", "u2")],
      [ceiling("a", CEIL), ceiling("b", CEIL)],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const warn = await screen.findByTestId("runway-warning-a");
    // `describeRecommendation`'s sentence verbatim — the observed-wall message, no "usual limit".
    expect(warn.textContent).toBe(
      "one@example.com has hit its limit. Switch to two@example.com to keep working.",
    );
    expect(warn.textContent).not.toContain("usual limit");
    // The healthy account gets no warning of its own; and it is not yet the whole-pool wall.
    expect(screen.queryByTestId("runway-warning-b")).toBeNull();
    expect(screen.queryByTestId("all-at-limit-banner")).toBeNull();
  });

  it("does NOT warn off the learned-ceiling estimate alone (the retired proactive nudge)", async () => {
    // `a` is at 85% of its learned ceiling — the OLD trigger — but has not hit a real wall. No
    // warning now. Reinstate the `warn` clause in the runway filter / `switchRecommendation` and this
    // goes from absent to present.
    const deps = makeDeps(
      [acct("a"), acct("b")],
      [used("a", 0.85 * CEIL), used("b", 5_000_000)],
      [signedInAs("a", "one@example.com", "u1"), signedInAs("b", "two@example.com", "u2")],
      [ceiling("a", CEIL), ceiling("b", CEIL)],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    await screen.findByText("two@example.com");
    expect(screen.queryByTestId("runway-warning-a")).toBeNull();
    expect(screen.queryByTestId("runway-warning-b")).toBeNull();
  });

  it("recommends a near-ceiling account as the target rather than reporting no target", async () => {
    // The estimate no longer VETOES a switch target: `a` hit a real wall, `b` is near its learned
    // ceiling (the old excluded case) but has NOT hit a wall — so `b` is a valid target and the
    // runway warning offers the switch instead of "there is nowhere to move to". This pins the High
    // finding: a walled fleet is never stranded because a guess said the only alternative was busy.
    const deps = makeDeps(
      [acct("a"), acct("b")],
      [used("a", 1_000, Date.now() + 60_000), used("b", 0.85 * CEIL)],
      [signedInAs("a", "one@example.com", "u1"), signedInAs("b", "two@example.com", "u2")],
      [ceiling("a", CEIL), ceiling("b", CEIL)],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const warn = await screen.findByTestId("runway-warning-a");
    expect(warn.textContent).toBe(
      "one@example.com has hit its limit. Switch to two@example.com to keep working.",
    );
    expect(warn.textContent).not.toContain("no other signed-in account to move to");
    expect(warn.textContent).not.toContain("usual limit");
  });

  it("does NOT offer a LIVE-SPENT account as the escape route (AC8 and AC9 agree on the live signal)", async () => {
    // `a` hit a real wall; `b` reads 99% on Anthropic's own number (no wall). The spawn gate refuses
    // `b`, so AC9 must not point the fleet at it — and AC8 already calls the whole pool at-limit. This
    // is the contradiction the live-blind `switchRecommendation` produced: the banner said "all at
    // their limit" while the runway sentence offered `b`. Drop the live clause from the candidate
    // filter and this offers `b` again.
    const deps = makeDeps(
      [acct("a"), acct("b")],
      [used("a", 5, Date.now() + 60_000), used("b", 5)],
      [signedInAs("a", "one@example.com", "u1"), signedInAs("b", "two@example.com", "u2")],
      [ceiling("a", CEIL), ceiling("b", CEIL)],
    );
    deps.getUsageLive = vi.fn(async (configDir: string) =>
      configDir === "/cfg/b" ? liveUsage(99, 10) : liveUsage(10, 10),
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    // AC8 fires once the live rows land (a walled + b live-spent = whole pool at limit).
    await screen.findByTestId("all-at-limit-banner");
    // And `b` is never offered as a switch target.
    expect(screen.queryByText(/Switch to two@example.com/)).toBeNull();
  });

  it("AC8 and AC9 agree across the DUPLICATE-login ordering (per-login live everywhere)", async () => {
    // The ordering the live signal made contradict itself: `b` and `a2` are two dirs of ONE login;
    // `b` is FIRST so `rotationReadiness` makes it the usable rep, and only `a2` (the redundant dir)
    // reports 99% live — `b`'s own fetch reads clear. `x` is walled and current. Per-DIR, AC8 (judging
    // the deduped usable set `[x, b]`) reads `b` healthy → no banner, while a per-login
    // switchRecommendation returns null → the runway fallback fires with `b`/`a2` on screen: the two
    // verdicts disagree. Per-login EVERYWHERE, `b`'s login is spent (via its twin `a2`), so AC8 fires
    // and no switch is offered — banner and runway agree. Drop `siblingIds` from `exhaustionOutlook`
    // and the banner disappears while the fallback contradicts it.
    const deps = makeDeps(
      [acct("x"), acct("b"), acct("a2")],
      [used("x", 5, Date.now() + 60_000), used("b", 5), used("a2", 5)],
      [
        signedInAs("x", "x@example.com", "u-x"),
        signedInAs("b", "dup@example.com", "u-dup"),
        signedInAs("a2", "dup@example.com", "u-dup"),
      ],
      [ceiling("x", CEIL), ceiling("b", CEIL), ceiling("a2", CEIL)],
    );
    // Only the redundant dir `a2` reports spent; `b`'s own fetch reads clear.
    deps.getUsageLive = vi.fn(async (configDir: string) =>
      configDir === "/cfg/a2" ? liveUsage(99, 10) : liveUsage(10, 10),
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} currentAccountId="x" />);
    // The banner fires (x walled + the dup login spent per-login = whole usable pool at limit)...
    await screen.findByTestId("all-at-limit-banner");
    // ...and, agreeing with it, no runway row contradicts it by offering the spent login.
    expect(screen.queryByTestId("runway-warning-x")).toBeNull();
  });

  it("still warns when a walled account's only alternative is its OWN duplicate (no silent gap)", async () => {
    // `a` and `b` are the SAME login (shared uuid); `b` is first so it is the usable rep and `a` is
    // redundant. `currentAccountId` names the walled `a`. `switchRecommendation` drops `b` as
    // same-login → null, and `exhaustionOutlook` (over the login-deduped usable set = [b], not walled)
    // says allAtLimit=false → no AC8. Without the no-target fallback the screen is SILENT while the
    // fleet sits behind a five-hour wall — the founder's blind spot. The fallback row fires instead.
    const deps = makeDeps(
      [acct("b"), acct("a")],
      [used("b", 5), used("a", 5, Date.now() + 60_000)],
      [
        signedInAs("b", "shared@example.com", "u-shared"),
        signedInAs("a", "shared@example.com", "u-shared"),
      ],
      [ceiling("b", CEIL), ceiling("a", CEIL)],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} currentAccountId="a" />);
    const warn = await screen.findByTestId("runway-warning-a");
    expect(warn.textContent).toContain("has hit its limit");
    // The copy states the REAL reason — the other account is the SAME login (shared quota) — rather
    // than the false "no other signed-in account" (both ARE signed in and both are on screen).
    expect(warn.textContent).toContain("the same Claude login");
    expect(warn.textContent).toContain("shares this limit");
    expect(warn.textContent).toContain("shared@example.com");
    expect(warn.textContent).not.toContain("no other signed-in account to move to");
    expect(warn.textContent).not.toContain("Switch to");
    expect(screen.queryByTestId("all-at-limit-banner")).toBeNull();
  });

  it("names an EMAIL-bearing same-login sibling even when a uuid-only one is registered first", async () => {
    // The N2 shape: a login with THREE registrations — `z` (uuid-only, no readable email, registered
    // FIRST), `b` (the email-bearing sibling and the usable rep, so `allAtLimit` is false and the
    // runway fires), `a` (walled, current). The fallback must name the SIBLING's email, not blank it
    // because `z` comes first in group order and would revert the copy to the false "no other
    // signed-in account". The sibling's email is DISTINCT from the walled account's own so the
    // assertion is not satisfied by `leadName`'s subject — it pins the email-PREFERRING selection.
    const deps = makeDeps(
      [acct("z"), acct("b"), acct("a")],
      [
        used("z", 5),
        used("b", 5),
        used("a", 5, Date.now() + 60_000),
      ],
      [
        { id: "z", email: null, organization: null, accountUuid: "u-shared" },
        signedInAs("b", "sibling@example.com", "u-shared"),
        signedInAs("a", "walled@example.com", "u-shared"),
      ],
      [ceiling("z", CEIL), ceiling("b", CEIL), ceiling("a", CEIL)],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} currentAccountId="a" />);
    const warn = await screen.findByTestId("runway-warning-a");
    expect(warn.textContent).toContain("the same Claude login");
    // The sibling's email (picked past the uuid-only `z`), NOT blanked. Distinct from the subject
    // `walled@example.com`, so `[0]`-order selection (which would pick `z`'s null) fails this.
    expect(warn.textContent).toContain("sibling@example.com");
    expect(warn.textContent).not.toContain("no other signed-in account to move to");
  });

  it("names the walled account by leadName in the fallback — never the false 'Not signed in'", async () => {
    // A uuid-only login (real, but no readable email) is `readiness.noEmail` — never in `usable`, so
    // `allAtLimit` is false — and its own runway fallback must read "The account Sparkle is signed
    // into", not the `AccountDisplay.primary` fallback "Not signed in". `currentAccountId` names it so
    // it is the judged account, and a signed-in sibling `keep` gives it a wall with a target that is
    // nonetheless excluded (same login), so the fallback fires.
    const deps = makeDeps(
      [acct("uuidonly"), acct("keep")],
      [used("uuidonly", 5, Date.now() + 60_000), used("keep", 5)],
      [
        { id: "uuidonly", email: null, organization: null, accountUuid: "u-shared" },
        { id: "keep", email: "keep@example.com", organization: null, accountUuid: "u-shared" },
      ],
      [ceiling("uuidonly", CEIL), ceiling("keep", CEIL)],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} currentAccountId="uuidonly" />);
    const warn = await screen.findByTestId("runway-warning-uuidonly");
    expect(warn.textContent).toContain("The account Sparkle is signed into has hit its limit");
    expect(warn.textContent).not.toContain("Not signed in");
  });

  it("says nothing while every account has room", async () => {
    const deps = makeDeps(
      [acct("a"), acct("b")],
      [used("a", 1_000_000), used("b", 2_000_000)],
      [signedInAs("a", "one@example.com", "u1"), signedInAs("b", "two@example.com", "u2")],
      [ceiling("a", CEIL), ceiling("b", CEIL)],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    await screen.findByText("two@example.com");
    expect(screen.queryByTestId("runway-warning-a")).toBeNull();
    expect(screen.queryByTestId("runway-warning-b")).toBeNull();
  });

  it("judges ONLY the named account when the integrator supplies one", async () => {
    // `currentAccountId` is the precise answer when the integrator knows the fleet's real account;
    // it must narrow the warning rather than adding to it. `b` hit a real wall; `a` is healthy but
    // NOT the named account, so it is not judged even though it could be a target.
    const deps = makeDeps(
      [acct("a"), acct("b")],
      [used("a", 5_000_000), used("b", 1_000, Date.now() + 60_000)],
      [signedInAs("a", "one@example.com", "u1"), signedInAs("b", "two@example.com", "u2")],
      [ceiling("a", CEIL), ceiling("b", CEIL)],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} currentAccountId="b" />);
    expect(await screen.findByTestId("runway-warning-b")).toBeTruthy();
    expect(screen.queryByTestId("runway-warning-a")).toBeNull();
  });
});

describe("an account with no login reads as BROKEN", () => {
  it("says it cannot receive agents and offers a one-click Finish sign-in", async () => {
    const onLogin = vi.fn();
    const deps = makeDeps([acct("dead", { nickname: "DROdio Gmail" })], [], [neverLoggedIn("dead")]);
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    const block = await screen.findByTestId("account-blocked-dead");
    expect(block.textContent).toContain("Not signed in — this account cannot receive agents");
    fireEvent.click(within(block).getByRole("button", { name: "Finish sign-in" }));
    expect(onLogin).toHaveBeenCalledWith(expect.objectContaining({ id: "dead" }));
  });

  it("does not brand a signed-in account as broken", async () => {
    const deps = makeDeps([acct("a")], [], [signedInAs("a", "one@example.com")]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    await screen.findByText("one@example.com");
    expect(screen.queryByTestId("account-blocked-a")).toBeNull();
  });

  it("an unsigned DEFAULT account signs in with one click — there is no login to replace", async () => {
    // The two-step confirm protects an EXISTING login from being swapped. With none there, the
    // confirm would be friction guarding nothing, in front of the exact fix the screen is demanding.
    const onLogin = vi.fn();
    const deps = makeDeps(
      [acct("a", { nickname: "Default", isDefault: true })],
      [],
      [neverLoggedIn("a")],
    );
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    fireEvent.click(await screen.findByRole("button", { name: "Finish sign-in" }));
    expect(onLogin).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Change default account login" })).toBeNull();
  });
});

describe("the spawn-history panel is actually mounted", () => {
  // The mount is easy to delete silently: nothing else on this screen references the panel, so
  // without these two the whole retrospective half could vanish and the suite would stay green.
  it("renders the recorded spawns under the account cards", async () => {
    const deps = makeDeps([acct("a", { nickname: "Personal", isDefault: true })]);
    deps.readSpawnLog = vi.fn(async () => [
      {
        at: Date.parse("2026-08-07T18:00:00Z"),
        key: "agent-abc123456",
        accountId: "a",
        nickname: "Personal",
        configDir: "/cfg/a",
        email: "someone@example.com",
        reason: "auto" as const,
        tokens5h: 10,
        ceiling: 100,
        fraction: 0.1,
        eligibleCount: 1,
        signedInCount: 2,
        candidateIds: ["a"],
      },
    ]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    expect(await screen.findByText("Which account recent agents ran on")).toBeTruthy();
    // The row itself, not just the heading — so the panel is wired to the seam, not merely present.
    expect(await screen.findByText("someone@example.com")).toBeTruthy();
  });

  it("shows the panel's empty state when nothing has been recorded", async () => {
    const deps = makeDeps([acct("a", { nickname: "Personal", isDefault: true })]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect(await screen.findByText(/nothing recorded yet/i)).toBeTruthy();
  });
});

// ── "Manual Override" — override rotation to run agents on one account ────────────────────────
//
// The founder's ask, verbatim: "I thought I wanna be able to specify an account that I want to make
// the primary. For agents." And immediately after: "Then what actual agents would go on to that
// account? It's not clear to me." Both halves are asserted here — the control, and the list that
// says what it will affect. The "PRIMARY" BADGE was later removed (flat equal rotation); the active
// account is shown only by the subtle `account-active-state-*` line, which is what these assert on.
//
// Every assertion below is on a state the screen could NOT have rendered before the click: the deps
// are backed by mutable state (`routableDeps`), so a badge that was hard-coded, or a button wired to
// nothing, fails rather than passing on a fixture.
describe("AccountsScreen — activation", () => {
  it("Manual Override records the account and marks that card Active (no PRIMARY badge)", async () => {
    const { deps, state } = routableDeps(
      [acct("a", { nickname: "Personal", isDefault: true }), acct("b", { nickname: "Work" })],
      [signedIn("a"), signedIn("b")],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    // Before: no card is active, and both offer the control.
    // `.textContent`, not jest-dom's `toHaveTextContent` — this repo does not load jest-dom.
    // No override is set yet, so this is AUTOMATIC mode — the card must not claim it takes none.
    expect((await screen.findByTestId("account-active-state-b")).textContent).toBe(
      "Automatic — new agents may run here",
    );
    // The PRIMARY badge was removed — it must not exist in either state.
    expect(screen.queryByTestId("account-primary-badge-b")).toBeNull();

    const cardB = screen.getByTestId("account-row-b");
    fireEvent.click(within(cardB).getByText("Manual Override"));

    // The lever ran with the right account — and the SCREEN now reflects it, which it can only do
    // by re-reading the preference the lever wrote. The subtle active-state line is the ONLY marker.
    expect(deps.activateAccount).toHaveBeenCalledWith("b");
    expect(state.preferred).toBe("b");
    expect((await screen.findByTestId("account-active-state-b")).textContent).toBe(
      "Active — new agents run here",
    );
    // Still no crown — the removed badge must not have crept back.
    expect(screen.queryByTestId("account-primary-badge-b")).toBeNull();
    // …and only that card is active. The DEFAULT account is a different idea.
    expect(screen.getByTestId("account-active-state-a").textContent).toBe("Not taking new agents");
  });

  // ── THE LABEL MUST NOT CONTRADICT THE LINE BELOW IT ─────────────────────────────────────────
  //
  // The founder screenshotted a card reading "Inactive" directly above "Running agents: Concierge"
  // and reported the state as a bug. The state was right — the label is about ROUTING (where the
  // NEXT agent starts), not about activity — but it made a claim the very next line disproved.
  //
  // This asserts the two lines together on ONE card, which is the only arrangement that can catch
  // it: asserting the label alone passes with any wording, and asserting the running list alone
  // never looks at the label. A revert to the bare word "Inactive" fails here.
  it("a non-routed account that IS running agents does not describe itself as inactive", async () => {
    const { deps, state } = routableDeps(
      [acct("a", { nickname: "Routed" }), acct("b", { nickname: "Busy" })],
      [signedIn("a"), signedIn("b")],
    );
    // "b" is NOT the routing target, but a live agent is running on it — the founder's exact shape.
    state.preferred = "a";
    state.panes = { agent1: "b" };
    state.names = { agent1: "Concierge" };
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    const label = await screen.findByTestId("account-active-state-b");
    const card = screen.getByTestId("account-row-b");

    // The card really is showing a running agent…
    expect(card.textContent).toContain("Concierge");
    // …so the label above it must not assert the account is inactive.
    expect(label.textContent).not.toMatch(/inactive/i);
    // It states the routing fact instead, which is what is actually true of this card.
    expect(label.textContent).toBe("Not taking new agents");
  });

  // AUTOMATIC MODE IS THE DEFAULT STATE, AND IT HAS ITS OWN LABEL.
  //
  // With no manual override anywhere, `preferredId` is unset, so NO card is primary. A two-way
  // label therefore tells EVERY card it takes no new agents while `chooseAccountForAgent` is
  // auto-picking one of them by lowest usage. The single-account fleet is the sharpest case: the
  // one card receiving 100% of spawns declaring it receives none.
  it("does not tell a lone auto-picked account that it takes no new agents", async () => {
    const { deps } = routableDeps([acct("solo", { nickname: "Only" })], [signedIn("solo")]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const label = await screen.findByTestId("account-active-state-solo");
    expect(label.textContent).not.toMatch(/not taking new agents/i);
    expect(label.textContent).toBe("Automatic — new agents may run here");
  });

  it("says 'not taking new agents' only when ANOTHER card actually holds the override", async () => {
    // The paired direction: the strict wording is correct here and must not be lost. Without this,
    // "always say automatic" would pass the test above.
    const { deps } = routableDeps(
      [acct("a", { nickname: "Chosen" }), acct("b", { nickname: "Other" })],
      [signedIn("a"), signedIn("b")],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    fireEvent.click(within(await screen.findByTestId("account-row-a")).getByText("Manual Override"));
    await waitFor(() =>
      expect(screen.getByTestId("account-active-state-b").textContent).toBe("Not taking new agents"),
    );
  });

  // A SIGNED-OUT CARD CANNOT RECEIVE AGENTS AT ALL, so the automatic wording must not reach it.
  // `chooseAccountForAgent` filters both `eligibleAccounts` and `autoPick` on `signedInIds`, and
  // this same card renders "Not signed in — this account cannot receive agents". Claiming
  // "Automatic — new agents may run here" above that banner rebuilds the founder's original
  // complaint INSIDE one card (roborev 65221). Every other test on this label uses a signed-in
  // identity, so this direction was unguarded.
  it("does not tell a signed-OUT account that new agents may run there", async () => {
    const { deps } = routableDeps([acct("blocked", { nickname: "Dead" })], [neverLoggedIn("blocked")]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    // The card really is rendering the cannot-receive banner…
    expect(await screen.findByText(/Not signed in — this account cannot receive agents/)).toBeTruthy();
    // …so the routing label must not contradict it.
    const label = screen.getByTestId("account-active-state-blocked");
    expect(label.textContent).not.toMatch(/may run here/i);
    expect(label.textContent).toBe("Not taking new agents");
  });

  // A STORED PREFERENCE CAN OUTLIVE THE LOGIN IT POINTED AT. Nothing clears it when an account's
  // identity goes away — `handleActivate` checks eligibility at CLICK time only — and
  // `usablePreferredAccount` then drops that preference from routing. So the card would read the
  // unqualified "Active — new agents run here" directly above its own "cannot receive agents"
  // banner: the same contradiction as the automatic case, in the loudest possible wording
  // (roborev 65223).
  it("does not call a signed-OUT account Active even when the preference still points at it", async () => {
    const { deps, state } = routableDeps([acct("blocked", { nickname: "Dead" })], [neverLoggedIn("blocked")]);
    state.preferred = "blocked"; // the preference survived; the login did not
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    expect(await screen.findByText(/Not signed in — this account cannot receive agents/)).toBeTruthy();
    const label = screen.getByTestId("account-active-state-blocked");
    expect(label.textContent).not.toBe("Active — new agents run here");
    expect(label.textContent).toBe("Not taking new agents");
  });

  it("the Active indicator and the default tag are distinct (active is not standing in for default)", async () => {
    const { deps } = routableDeps([acct("a", { nickname: "Personal", isDefault: true })], [signedIn("a")]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    fireEvent.click(within(await screen.findByTestId("account-row-a")).getByText("Manual Override"));
    // The active-state line and the separate `default` tag both render, so neither stands in for the
    // other (the confusion the removed "primary" badge used to cause with an exhausted default).
    expect((await screen.findByTestId("account-active-state-a")).textContent).toBe(
      "Active — new agents run here",
    );
    expect(screen.getByText("default")).toBeTruthy();
  });

  it("back to automatic clears the preference", async () => {
    const { deps, state } = routableDeps([acct("a", { nickname: "Personal" })], [signedIn("a")]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    fireEvent.click(within(await screen.findByTestId("account-row-a")).getByText("Manual Override"));
    fireEvent.click(await screen.findByText("Back to automatic"));

    expect(state.preferred).toBeUndefined();
    // What this test is ABOUT is the preference being cleared, so assert the card stops claiming to
    // be the override target — NOT the exact non-primary string. Pinning that string here locked in
    // a label that is false for the state this test creates (a single account, automatic mode, so it
    // receives 100% of new spawns), which would have made the wording uncorrectable without the
    // suite going red for the wrong reason (roborev 65216).
    await waitFor(() =>
      expect(screen.getByTestId("account-active-state-a").textContent).not.toBe(
        "Active — new agents run here",
      ),
    );
    expect(screen.getByTestId("account-active-state-a").textContent).not.toMatch(
      /not taking new agents/i,
    );
  });

  it("…and the pins the activation wrote, or nothing actually goes back to automatic", async () => {
    // Clearing the preference alone is not automatic. The activation had TWO durable effects, and
    // the other one outranks the preference: `moveAgent` pins every pane it moves, a pin beats the
    // fleet preference in `chooseAccountForAgent`, and only an agent CLOSE clears one. So dropping
    // the preference by itself leaves each of those agents spawning on the activated account
    // forever — the button reports success and the fleet does not move.
    const { deps, state } = routableDeps(
      [acct("a", { nickname: "Personal" }), acct("b", { nickname: "AmForge" })],
      [signedIn("a"), signedIn("b")],
    );
    state.panes = { "agent-1": "a" };
    state.names = { "agent-1": "Stripe Checkout Flow" };
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    fireEvent.click(within(await screen.findByTestId("account-row-b")).getByText("Manual Override"));
    expect(state.pins["agent-1"]).toBe("b"); // the migration half ran

    fireEvent.click(await screen.findByText("Back to automatic"));
    expect(state.pins["agent-1"]).toBeUndefined();
  });

  it("…but back to automatic leaves a pin a PERSON set, and the screen still shows it", async () => {
    // PAIRED with the sweep above and the reason it is not a wrecking ball: the sticky consumers'
    // own controls in this same modal write pins, and so does `AgentPane`'s per-agent override. A
    // sweep of "every pin" would silently undo all of them on one click. Asserted on SCREEN, since
    // the concierge control renders the pin back as the user's own choice.
    const { deps, state } = routableDeps(
      [acct("a", { nickname: "Personal" }), acct("b", { nickname: "AmForge" })],
      [signedIn("a"), signedIn("b")],
    );
    state.panes = { "agent-1": "a" };
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    const conciergeSelect = (await screen.findByTestId("sticky-account-sparkle:concierge")) as HTMLSelectElement;
    fireEvent.change(conciergeSelect, { target: { value: "a" } });
    fireEvent.click(within(await screen.findByTestId("account-row-b")).getByText("Manual Override"));
    fireEvent.click(await screen.findByText("Back to automatic"));

    expect(state.pins["agent-1"]).toBeUndefined(); // machinery's — swept
    expect(state.pins["sparkle:concierge"]).toBe("a"); // the person's — kept
    await waitFor(() =>
      expect((screen.getByTestId("sticky-account-sparkle:concierge") as HTMLSelectElement).value).toBe("a"),
    );
  });

  it("refuses to activate an account that has never been signed in", async () => {
    // The selection gate would reject the preference on the very next spawn, so offering the button
    // would be a control that reports success and changes nothing.
    const { deps } = routableDeps([acct("a", { nickname: "Personal" })], []);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const button = within(await screen.findByTestId("account-row-a")).getByText("Manual Override") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(deps.activateAccount).not.toHaveBeenCalled();
  });

  it("refuses to offer PRIMARY to a login the selection gate would reject", async () => {
    // The button's predicate must be the GATE's, not the wider "is this signed in at all". A login
    // with an accountUuid but no readable email is real — Log in / Switch login beside it treat it
    // as signed in, correctly — but `usablePreferredAccount` tests `signedInAccountIds`, which keys
    // on EMAIL. With the wider predicate the button is enabled, the card flips to "Active — new
    // agents run here", and the very next spawn discards the preference with the ledger recording a
    // bland "auto": the same silent defeat this feature exists to prevent, wearing a green badge.
    const uuidOnly: Identity = {
      id: "a",
      email: null,
      organization: null,
      accountUuid: "u-a",
    };
    const { deps } = routableDeps(
      [acct("a", { nickname: "Personal" }), acct("b", { nickname: "Work" })],
      [uuidOnly, signedIn("b")],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    const card = await screen.findByTestId("account-row-a");
    const button = within(card).getByText("Manual Override") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(deps.activateAccount).not.toHaveBeenCalled();
    // PAIRED, in the same render: the account that DOES report an email is still offerable, so this
    // is evidence about the predicate rather than about the button being broken everywhere.
    const ok = within(screen.getByTestId("account-row-b")).getByText("Manual Override") as HTMLButtonElement;
    expect(ok.disabled).toBe(false);
  });

  it("names what is running on each account, by the name the user knows", async () => {
    const { deps, state } = routableDeps(
      [acct("a", { nickname: "Personal" }), acct("b", { nickname: "Work" })],
      [signedIn("a"), signedIn("b")],
    );
    state.panes = { "id-1": "a", "id-2": "b" };
    state.names = { "id-1": "Stripe Checkout Flow", "id-2": "Docs Sweep" };
    state.sticky = { "sparkle:concierge": "a", __sparkle_self__: "b" };
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    const cardA = (await screen.findByTestId("account-routing-a")).textContent ?? "";
    expect(cardA).toContain("Stripe Checkout Flow");
    expect(cardA).toContain("Concierge");
    // …and NOT the things that are on the other account. A list that named everything everywhere
    // would satisfy a "does it mention the agent" assertion while answering nothing.
    expect(cardA).not.toContain("Docs Sweep");
    expect(cardA).not.toContain("Improve Sparkle");

    const cardB = screen.getByTestId("account-routing-b").textContent ?? "";
    expect(cardB).toContain("Docs Sweep");
    expect(cardB).toContain("Improve Sparkle");
    expect(cardB).not.toContain("Stripe Checkout Flow");
  });

  it("collapses a long Running agents list to 2 names + N more, expands to all, and collapses again", async () => {
    // Item 13: 38 running agents. Collapsed shows exactly 2 names + "+ 36 more" and hides the rest;
    // expanding shows the full list (a late agent appears) with a Collapse link; collapsing returns
    // to the one-line form. Non-vacuous: the assertions flip on the presence of a hidden agent and
    // the toggle links, which only the collapse logic + per-card state produce.
    const { deps, state } = routableDeps([acct("a", { nickname: "Personal" })], [signedIn("a")]);
    const panes: Record<string, string> = {};
    const names: Record<string, string> = {};
    for (let i = 0; i < 38; i++) {
      panes[`ag-${i}`] = "a";
      names[`ag-${i}`] = `Agent ${i}`;
    }
    state.panes = panes;
    state.names = names;
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    const routing = await screen.findByTestId("account-routing-a");
    // Collapsed: the "+ 36 more" link is present and a late agent (Agent 37) is hidden.
    expect(within(routing).getByText("+ 36 more")).toBeTruthy();
    expect(routing.textContent).toContain("Agent 0");
    expect(routing.textContent).not.toContain("Agent 37");

    // Expand.
    fireEvent.click(within(routing).getByText("+ 36 more"));
    expect(routing.textContent).toContain("Agent 37");
    expect(within(routing).getByText("Collapse")).toBeTruthy();
    expect(within(routing).queryByText("+ 36 more")).toBeNull();

    // Collapse again → back to the one-line form.
    fireEvent.click(within(routing).getByText("Collapse"));
    expect(routing.textContent).not.toContain("Agent 37");
    expect(within(routing).getByText("+ 36 more")).toBeTruthy();
  });

  it("lists Improve Sparkle ONCE and never by its internal id, though its pane is in the pane map", async () => {
    // Improve Sparkle's pane is an ordinary AgentPane whose agent.id IS the sticky key
    // (`sparkleAgent.ts`), so registerPaneAccount files it under `__sparkle_self__`. Rendering the
    // pane map verbatim and then appending the sticky label listed it twice — the second time as a
    // raw internal id, which names nothing the user has ever seen.
    const { deps, state } = routableDeps(
      [acct("a", { nickname: "Personal" }), acct("b", { nickname: "Work" })],
      [signedIn("a"), signedIn("b")],
    );
    state.panes = { "id-1": "b", __sparkle_self__: "b" };
    state.names = { "id-1": "Docs Sweep" };
    state.sticky = { __sparkle_self__: "b" };
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    const cardB = (await screen.findByTestId("account-routing-b")).textContent ?? "";
    expect(cardB).not.toContain("__sparkle_self__");
    expect(cardB.match(/Improve Sparkle/g) ?? []).toHaveLength(1);
    // The ordinary agent beside it is still listed — the fix removes a duplicate, not the list.
    expect(cardB).toContain("Docs Sweep");
  });

  it("still lists Improve Sparkle when only a satellite-window pane names it", async () => {
    // PAIRED with the test above. Satellite panes register under a `-win-<uuid>` VARIANT while
    // stickyAccountSnapshot is read on the base key, so discarding the pane evidence rather than
    // folding it in would drop Improve Sparkle off the list entirely here.
    const { deps, state } = routableDeps(
      [acct("a", { nickname: "Personal" }), acct("b", { nickname: "Work" })],
      [signedIn("a"), signedIn("b")],
    );
    state.panes = { "__sparkle_self__-win-6f2c": "b" };
    state.sticky = {};
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    const cardB = (await screen.findByTestId("account-routing-b")).textContent ?? "";
    expect(cardB).not.toContain("__sparkle_self__");
    expect(cardB.match(/Improve Sparkle/g) ?? []).toHaveLength(1);
  });

  it("says an account is empty rather than leaving the question unanswered", async () => {
    const { deps } = routableDeps([acct("a", { nickname: "Personal" })], [signedIn("a")]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect((await screen.findByTestId("account-routing-a")).textContent).toContain(
      "Nothing is running on this account right now.",
    );
  });

  it("no longer shows the mounted-panes coverage caption (removed in the overhaul)", async () => {
    // Overhaul item 7: the "The lists below cover agents with an open tab in this window…" caption
    // was removed at the founder's instruction. Assert it is gone — non-vacuous, since it would fail
    // if the caption (or its testid) rendered. Wait for a real row first so absence isn't just
    // "hasn't rendered yet".
    const { deps } = routableDeps([acct("a")], [signedIn("a")]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    await screen.findByTestId("account-row-a");
    expect(screen.queryByTestId("routing-coverage-note")).toBeNull();
    expect(screen.queryByText(/open tab in this window/i)).toBeNull();
  });
});

describe("AccountsScreen — the sticky consumers", () => {
  it("parks the concierge on a chosen account by pinning its key", async () => {
    const { deps, state } = routableDeps(
      [acct("a", { nickname: "Personal" }), acct("b", { nickname: "Work" })],
      [signedIn("a"), signedIn("b")],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    const select = await screen.findByTestId("sticky-account-sparkle:concierge");
    fireEvent.change(select, { target: { value: "b" } });

    // A PIN on the concierge's own key — not the fleet preference, which deliberately leaves the
    // sticky consumers alone.
    expect(deps.setPin).toHaveBeenCalledWith("sparkle:concierge", "b");
    expect(state.pins["sparkle:concierge"]).toBe("b");
    expect(state.preferred).toBeUndefined();
    // The screen re-reads, so the concierge now shows up on that account's card.
    expect((await screen.findByTestId("account-routing-b")).textContent).toContain("Concierge");
  });

  it("names each account in the picker without claiming a signed-in one is not signed in", async () => {
    // An `oauthAccount` with a uuid but NO readable email IS signed in — `SIGNED_IN_NO_EMAIL` is
    // the state that exists to say so. The identity slot's `email ?? NOT_SIGNED_IN` fallback is
    // right for a slot and wrong for an option label, which has to NAME the thing being chosen:
    // it rendered the literal "Not signed in" as this account's name in the list.
    const { deps } = routableDeps(
      [acct("a", { nickname: "Nick" }), acct("b", { nickname: "Work" })],
      [{ id: "a", email: null, organization: null, accountUuid: "u1" }, signedIn("b")],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    const options = Array.from(
      (await screen.findByTestId("sticky-account-sparkle:concierge")).querySelectorAll("option"),
    ).map((o) => o.textContent);
    // The no-email account falls back to its nickname…
    expect(options).toContain("Nick");
    // …and is never labelled with the falsehood.
    expect(options).not.toContain(NOT_SIGNED_IN);
    // A signed-in account carries both parts, so two accounts are never indistinguishable and the
    // option text stays distinct from the identity slot's.
    expect(options).toContain("Work — b@example.invalid");
  });

  it("hands a sticky consumer back to automatic", async () => {
    const { deps, state } = routableDeps([acct("a"), acct("b")], [signedIn("a"), signedIn("b")]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    const select = await screen.findByTestId("sticky-account-__sparkle_self__");
    fireEvent.change(select, { target: { value: "b" } });
    expect(state.pins["__sparkle_self__"]).toBe("b");

    fireEvent.change(select, { target: { value: "" } });
    expect(deps.clearPin).toHaveBeenCalledWith("__sparkle_self__");
    expect(state.pins["__sparkle_self__"]).toBeUndefined();
  });

  it("activating an account does not move the sticky consumers", async () => {
    const { deps, state } = routableDeps(
      [acct("a", { nickname: "Personal" }), acct("b", { nickname: "Work" })],
      [signedIn("a"), signedIn("b")],
    );
    state.sticky = { "sparkle:concierge": "a" };
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    fireEvent.click(within(await screen.findByTestId("account-row-b")).getByText("Manual Override"));

    // The concierge is still listed on `a`, and no pin was written for it. Moving it mid-
    // conversation nulls both session pointers and re-probes, which is why it gets its own control.
    await waitFor(() =>
      expect(screen.getByTestId("account-active-state-b").textContent).toBe(
        "Active — new agents run here",
      ),
    );
    expect(screen.getByTestId("account-routing-a").textContent).toContain("Concierge");
    expect(screen.getByTestId("account-routing-b").textContent).not.toContain("Concierge");
    expect(deps.setPin).not.toHaveBeenCalled();
  });

  // ── LOADING vs LOADED-EMPTY: the intermittent false "No accounts yet" flicker ──────────────────
  describe("load state never flashes a false empty", () => {
    it("shows a LOADING skeleton while the account read is pending, NOT the empty CTA", async () => {
      // A read that never resolves during this assertion window models the mid-load frame.
      let release!: (a: Account[]) => void;
      const pending = new Promise<Account[]>((r) => {
        release = r;
      });
      const deps = makeDeps([]);
      deps.listAccounts = vi.fn(() => pending);

      render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

      // The distinction the fix exists for: skeleton yes, empty CTA no, WHILE loading.
      await screen.findByTestId("accounts-loading");
      expect(screen.queryByTestId("accounts-empty")).toBeNull();

      // Now the read resolves with accounts → they render and the skeleton is gone.
      release([acct("a", { nickname: "Personal" })]);
      await screen.findByTestId("account-row-a");
      expect(screen.queryByTestId("accounts-loading")).toBeNull();
      expect(screen.queryByTestId("accounts-empty")).toBeNull();
    });

    it("shows the empty CTA ONLY after a read that definitively completed with zero accounts", async () => {
      const deps = makeDeps([]); // resolves to [] immediately
      render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

      // Once the read completes with zero, the CTA is honest and appears; the skeleton is gone.
      await screen.findByTestId("accounts-empty");
      expect(screen.queryByTestId("accounts-loading")).toBeNull();
    });

    it("a FAILED account read shows neither the empty CTA nor a stuck skeleton — it shows the error", async () => {
      const deps = makeDeps([]);
      deps.listAccounts = vi.fn(async () => {
        throw new Error("ledger read failed");
      });
      render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

      await screen.findByText("ledger read failed");
      // The false-empty must NOT appear on a transient read failure (the founder's flicker).
      expect(screen.queryByTestId("accounts-empty")).toBeNull();
      expect(screen.queryByTestId("accounts-loading")).toBeNull();
    });
  });

  // ── EXPIRED login surfaced from the LIVE probe, and the Renew control ──────────────────────────
  describe("expired-login visibility and Renew", () => {
    it("flags a signed-in account whose LIVE session is dead as EXPIRED with a Renew control", async () => {
      // Identity reads signed-in (email present) — the recorded flag says "fine". The live probe
      // says the CLI session is dead. Without the probe this row would look healthy.
      const deps = makeDeps([acct("a", { nickname: "Build" })], [], [signedIn("a")]);
      deps.getAuthStatus = vi.fn(async (): Promise<ClaudeAuthStatus> => ({
        loggedIn: false,
        source: "cli",
        email: "a@example.invalid",
        authMethod: "oauth",
        subscriptionType: "max",
      }));

      render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

      const expired = await screen.findByTestId("account-expired-a");
      expect(expired.textContent).toContain("Login expired");
      // The probe was made against THIS account's config dir.
      expect(deps.getAuthStatus).toHaveBeenCalledWith("/cfg/a");
      expect(within(expired).getByText("Renew Login")).toBeTruthy();
    });

    it("clicking Renew opens the login flow for THAT account (asserts the call + args, not just a handler)", async () => {
      const onLogin = vi.fn();
      const deps = makeDeps([acct("a", { nickname: "Build" })], [], [signedIn("a")]);
      deps.getAuthStatus = vi.fn(async (): Promise<ClaudeAuthStatus> => ({
        loggedIn: false,
        source: "cli",
        email: "a@example.invalid",
        authMethod: "oauth",
        subscriptionType: "max",
      }));

      render(<AccountsScreen onLogin={onLogin} deps={deps} />);

      fireEvent.click(await screen.findByTestId("account-renew-a"));
      // The SIDE EFFECT: re-auth is initiated for exactly this account (config dir /cfg/a).
      await waitFor(() => expect(onLogin).toHaveBeenCalledTimes(1));
      expect(onLogin.mock.calls[0]![0]).toMatchObject({ id: "a", configDir: "/cfg/a" });
    });

    it("does NOT flag a healthy signed-in account as expired (the paired negative)", async () => {
      const deps = makeDeps([acct("a", { nickname: "Build" })], [], [signedIn("a")]);
      deps.getAuthStatus = vi.fn(async (): Promise<ClaudeAuthStatus> => ({
        loggedIn: true,
        source: "cli",
        email: "a@example.invalid",
        authMethod: "oauth",
        subscriptionType: "max",
      }));

      render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

      await screen.findByTestId("account-row-a");
      // Give the probe a tick to resolve, then confirm no expired card and no blocked card.
      await waitFor(() => expect(deps.getAuthStatus).toHaveBeenCalled());
      expect(screen.queryByTestId("account-expired-a")).toBeNull();
      expect(screen.queryByTestId("account-blocked-a")).toBeNull();
    });
  });
});
