// @vitest-environment jsdom
//
// Interaction tests for the Accounts settings screen: load/list, add → onLogin seam, inline
// rename, and the two-step remove confirm (default guarded). IO is injected via the `deps` prop.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountsScreen,
  IDENTITY_REFRESH_MS,
  SIGNED_IN_NO_EMAIL,
  type AccountsDeps,
} from "./AccountsScreen";
import { PENDING_NICKNAME, EXPIRED_LOGIN_NICKNAME } from "./accountsView";
import { ROTATION_OUT_STORAGE_KEY, ROTATION_PAUSED_STORAGE_KEY } from "../services/rotationState";
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

afterEach(() => {
  cleanup();
  // The rotation opt-outs and the pause persist in `localStorage` by design (the spawn path reads
  // them and is not React), so a test that toggles one would otherwise leak into the next file-order
  // neighbour and fail it for a reason that has nothing to do with what it is testing.
  localStorage.removeItem(ROTATION_OUT_STORAGE_KEY);
  localStorage.removeItem(ROTATION_PAUSED_STORAGE_KEY);
});

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
    getUsageLive: vi.fn(async (_configDir: string) => {
      throw new Error("live usage unavailable in test");
    }),
    // The INTERACTIVE reader — the only dep on this screen that may raise a macOS keychain prompt.
    // Separate from `getUsageLive` on purpose: it is reachable ONLY from the ⋮ "Check usage levels"
    // gesture, so a test that sees it called from a mount effect has caught a real regression.
    // Default: unavailable, same as the quiet reader. The check-usage suite overrides it.
    getUsageLiveForced: vi.fn(async (_configDir: string) => {
      throw new Error("forced live usage unavailable in test");
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

  // ── THE BILLING LINES ARE GONE, AND THE WARNING IS NOT ───────────────────────────────────────
  // Ten tests used to live here. They pinned a three-line billing block on every card — "Billing:
  // subscription", "This account: usage credits disarmed", and a fleet-level "Advisor passes are
  // SKIPPING — …" banner above the list — and they were right about the DISTINCTIONS they drew:
  // absent / null / false are opposite verdicts to the spend gate, and folding them would put a
  // reassuring sentence on a card whose advisor is silently refusing.
  //
  // The founder read the result on screen and asked for the two per-card lines gone ("get rid of
  // those two lines") and the fleet banner gone with them ("I've got no idea what any of that says…
  // I'm inclined to just get rid of that error"). His objection to the banner is the sharper one and
  // it is not about wording: it stated a per-account cause about ONE unnamed account, fleet-wide,
  // above a list of named cards, so the only way to act on it was to guess which row it meant.
  //
  // NONE OF THE GATE LOGIC MOVED. `spendGate.ts` still folds every account and still refuses, and it
  // has its own tests. What these now assert is the two things a UI test can: the card says nothing
  // about billing when there is nothing to act on, and it still says the ONE thing there is.

  it("says nothing about billing on an account there is nothing to act on", async () => {
    // All three meter shapes, in one test, because the claim is the same for each and the OLD suite's
    // whole difficulty was that they had to read differently. `queryByText` after an awaited render:
    // the bars are the proof the card actually rendered, so these absences are not vacuous.
    for (const extraUsage of [
      null,
      { isEnabled: false, monthlyLimit: null, usedCredits: null, utilization: null, spendLimitReached: false },
      { isEnabled: true, monthlyLimit: 200, usedCredits: 199.5, utilization: 99.75, spendLimitReached: false },
    ]) {
      const deps = makeDeps([acct("a", { nickname: "Personal", isDefault: true })]);
      deps.getUsageLive = vi.fn(async () => ({
        fiveHourPercent: 42,
        fiveHourResetsAt: null,
        sevenDayPercent: 15,
        sevenDayResetsAt: null,
        limits: [],
        extraUsage,
      }));
      const { unmount } = render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

      // The card is up and its live figures landed — without this the queries below pass against an
      // empty document.
      await waitFor(() => expect(screen.getAllByRole("progressbar").length).toBe(2));
      expect(screen.queryByText(/Billing:/)).toBeNull();
      expect(screen.queryByText(/This account:/)).toBeNull();
      expect(screen.queryByText(/Advisor passes/)).toBeNull();
      expect(screen.queryByTestId("advisor-gate-line")).toBeNull();
      expect(screen.queryByTestId("account-spend-limit")).toBeNull();
      unmount();
    }
  });

  // THE SPEND-LIMIT TEST WAS DELETED WITH ITS SUBJECT, and the deletion is deferred to rather than
  // argued with. This branch kept "Credit spend limit reached" on the grounds that the founder named
  // the two lines ABOVE it, not that one, and that it was the only place a spend limit was visible
  // anywhere in the app. Another agent read the same instruction as covering the whole block and
  // landed that on main first. Re-introducing it here would be overriding a landed decision inside a
  // merge, which is not what a merge is for — it is flagged in the branch's report instead, where a
  // human can restore it deliberately if the loss matters.

  it("no longer renders a FLEET-wide advisor verdict, however the siblings read", async () => {
    // The deleted banner's own trigger: one account disarmed, a sibling whose usage read FAILED.
    // That combination is what used to print "Advisor passes are SKIPPING — an account's usage could
    // not be read" above the cards, unable to say which account it meant. Driving exactly that state
    // is what makes this an assertion about the removal rather than about an easy case.
    const deps = makeDeps([
      acct("a", { nickname: "Personal", isDefault: true }),
      acct("b", { nickname: "Second" }),
    ]);
    deps.getUsageLive = vi.fn(async (configDir: string) => {
      if (configDir.includes("b")) throw new Error("usage read failed");
      return {
        fiveHourPercent: 10,
        fiveHourResetsAt: null,
        sevenDayPercent: 10,
        sevenDayResetsAt: null,
        limits: [],
        extraUsage: {
          isEnabled: false,
          monthlyLimit: null,
          usedCredits: null,
          utilization: null,
          spendLimitReached: false,
        },
      };
    });
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    await screen.findByTestId("account-identity-a");
    await waitFor(() => expect(deps.getUsageLive).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("advisor-gate-line")).toBeNull();
    expect(screen.queryByText(/Advisor passes/)).toBeNull();
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
    // The login SUCCEEDS here — `handleAdd` now undoes a create whose sign-in never landed, and an
    // undone account is not re-fetched at all, so without an identity this would be measuring the
    // removal path rather than the nonce.
    deps.getIdentities = vi.fn(async () =>
      accounts.map((a) => ({ id: a.id, email: "new@example.invalid", organization: null, accountUuid: "u-new" })),
    );
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
    // Item 14: the per-card ⋮ → "Check usage levels" must call the INTERACTIVE reader — the separate
    // export that bypasses the TTL cache and may prompt — for THAT account only, and the new figure
    // must reach the card's bar. THIS IS THE PAIR to "the mount effect never touches the interactive
    // reader" below: one test proving absence is ambiguous (it passes for a screen that force-reads
    // nothing at all), so the pair pins the cause — the loud read happens, and only on a click.
    // Non-vacuous on the update: the returned percent changes between mount and check, so a handler
    // that fetched but never wrote state would still show the old number. Non-vacuous on SCOPE: only
    // /cfg/a is checked — a handler that force-refreshed every account would fail the scope assertion.
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
    deps.getUsageLive = vi.fn(async (_configDir: string) => liveUsage(10, 10));
    deps.getUsageLiveForced = vi.fn(async (_configDir: string) => liveUsage(88, 88));
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    // Mount fetch landed, and it used the QUIET reader — the interactive one is untouched so far.
    await waitFor(() => expect(screen.getAllByText("10%").length).toBeGreaterThan(0));
    expect(deps.getUsageLiveForced).not.toHaveBeenCalled();

    fireEvent.click(within(await openKebab("a")).getByText("Check usage levels"));

    // Exactly one interactive read, and only for account a's config dir — b is untouched.
    await waitFor(() =>
      expect(vi.mocked(deps.getUsageLiveForced).mock.calls.map((c) => c[0])).toEqual(["/cfg/a"]),
    );
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
    // A forced read of a is denied; a forced read of b succeeds → 55%. The quiet (mount) read → 10%.
    deps.getUsageLive = vi.fn(async (_configDir: string) => liveUsage(10, 10));
    deps.getUsageLiveForced = vi.fn(async (configDir: string) => {
      if (configDir === "/cfg/a") throw new Error("keychain denied");
      return liveUsage(55, 55);
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
    deps.getUsageLive = vi.fn(async (_c: string) => liveUsage(10, 10));
    // A generic, non-auth failure on a signed-in, non-exhausted account: the TRANSIENT cause. The
    // amber alert must appear, and it must NOT tell a healthy signed-in account to sign in again
    // (that remedy is now reserved for a proven-dead login — see the usage-clarity suite).
    deps.getUsageLiveForced = vi.fn(async (_c: string) => {
      throw new Error("network down");
    });
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    // Let the mount fetch settle first so the check's fetch is the one we assert on.
    await waitFor(() => expect(deps.getUsageLive).toHaveBeenCalled());

    fireEvent.click(within(await openKebab("a")).getByText("Check usage levels"));

    const err = await screen.findByTestId("account-usage-error-a");
    expect(err.textContent).toBe(
      "Couldn't refresh usage — a temporary problem reaching Anthropic. Try again in a moment.",
    );
    expect(err.textContent).not.toContain("sign in again");
    expect(err.getAttribute("role")).toBe("alert");
  });

  // ── "usage unknown" IS NOT AN ERROR ───────────────────────────────────────────────────────────
  //
  // The quiet reader never touches the keychain, so an account whose cached OAuth token has lapsed
  // rejects EVERY polled read with `usage unknown: …` until the user checks it by hand. That account
  // is very probably perfectly healthy. Rendering "Couldn't refresh usage. Check your connection or
  // sign in again." for it would be actively wrong — it sends the user chasing a problem that does
  // not exist, constantly, on the exact path that fires several times a minute. Each of these is
  // PAIRED with the same fixture failing a DIFFERENT way, because an assertion that only ever sees
  // one outcome also passes for a screen that renders that outcome unconditionally.

  it("a quiet `usage unknown:` rejection renders the unknown affordance, not the failure copy", async () => {
    const deps = makeDeps(
      [acct("a", { nickname: "A" })],
      [],
      [{ id: "a", email: "a@x.com", organization: null, accountUuid: "ua" }],
    );
    // Exactly what the Rust command returns on a quiet miss: the stable `usage unknown: ` prefix.
    deps.getUsageLive = vi.fn(async (_c: string) => {
      throw new Error("usage unknown: no cached token for /cfg/a");
    });
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    const unknown = await screen.findByTestId("account-usage-unknown-a");
    // It names the state plainly AND points at the one action that trues it up — the gesture is the
    // remedy, so the affordance has to mention it or the user is told nothing actionable.
    expect(unknown.textContent).toContain("Usage unknown");
    expect(unknown.textContent).toContain("Check usage levels");
    // …and NOT the genuine-failure surfaces. Both are checked: the row-level "unavailable" note and
    // the card-level alert, since either one would read as "something is broken".
    expect(screen.queryByTestId("account-usage-unavailable-a")).toBeNull();
    expect(screen.queryByTestId("account-usage-error-a")).toBeNull();
    expect(screen.queryByText(/Check your connection or sign in again/)).toBeNull();
  });

  it("…while a GENUINE quiet failure on the same fixture still renders the unavailable note", async () => {
    // THE PAIR. Identical fixture, identical path — only the rejection differs. Without this, the
    // test above passes for a screen that renders "Usage unknown" for every failure, which would
    // silently swallow real network/401 breakage.
    const deps = makeDeps(
      [acct("a", { nickname: "A" })],
      [],
      [{ id: "a", email: "a@x.com", organization: null, accountUuid: "ua" }],
    );
    deps.getUsageLive = vi.fn(async (_c: string) => {
      throw new Error("error sending request: connection refused");
    });
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    expect(await screen.findByTestId("account-usage-unavailable-a")).toBeTruthy();
    expect(screen.queryByTestId("account-usage-unknown-a")).toBeNull();
  });

  it("a FORCED check that comes back `usage unknown:` gets a calm status, never the amber alert", async () => {
    // The interactive read reaching `usage unknown: ` means even the credential re-read produced no
    // token — the prompt was declined, or nothing is stored. Still not "your connection is broken",
    // so it must not borrow the alert. PAIRED with "a failed Check usage surfaces THIS card's inline
    // alert" directly above, which drives the SAME gesture on the SAME fixture into a genuine error
    // and asserts role=alert + the connection copy: together they pin that the handler branches on
    // the rejection rather than always producing one shape.
    const deps = makeDeps(
      [acct("a", { nickname: "A" })],
      [],
      [{ id: "a", email: "a@x.com", organization: null, accountUuid: "ua" }],
    );
    deps.getUsageLive = vi.fn(async (_c: string) => liveUsage(10, 10));
    deps.getUsageLiveForced = vi.fn(async (_c: string) => {
      throw new Error("usage unknown: keychain read declined");
    });
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    await waitFor(() => expect(deps.getUsageLive).toHaveBeenCalled());

    fireEvent.click(within(await openKebab("a")).getByText("Check usage levels"));

    const note = await screen.findByTestId("account-usage-unknown-note-a");
    expect(note.getAttribute("role")).toBe("status"); // NOT "alert"
    expect(note.textContent).toContain("Usage unknown");
    expect(note.textContent).not.toContain("Check your connection");
    expect(screen.queryByTestId("account-usage-error-a")).toBeNull();
  });

  it("the mount effect never touches the INTERACTIVE reader — only the ⋮ gesture does", async () => {
    // The whole point of the split (sparkle-dkxuf6 / sparkle-oe9y1k): the keychain-touching read must
    // be unreachable from anything that fires on its own. This drives the real component through its
    // real mount (and a login, which re-fires the live effect via `liveNonce`) and asserts the loud
    // dep was never called. PAIRED with "Check usage levels (⋮ menu) force-refreshes ONLY that
    // card's account" above, which proves the loud dep IS called on a click — absence alone would
    // also pass for a build where the forced path had simply been deleted.
    const deps = makeDeps(
      [acct("a", { nickname: "A" }), acct("b", { nickname: "B" })],
      [],
      [
        { id: "a", email: "a@x.com", organization: null, accountUuid: "ua" },
        { id: "b", email: "b@x.com", organization: null, accountUuid: "ub" },
      ],
    );
    deps.getUsageLive = vi.fn(async (_c: string) => liveUsage(10, 10));
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    await waitFor(() => expect(screen.getAllByText("10%").length).toBeGreaterThan(0));

    // Every quiet read landed (so the effect really ran), and none of them was the loud one.
    expect(vi.mocked(deps.getUsageLive).mock.calls.map((c) => c[0]).sort()).toEqual([
      "/cfg/a",
      "/cfg/b",
    ]);
    expect(deps.getUsageLiveForced).not.toHaveBeenCalled();
    // Arity too: a quiet reader handed a second argument has been written against the OLD force-as-a-
    // parameter signature, which is how a timer path used to reach the keychain.
    for (const call of vi.mocked(deps.getUsageLive).mock.calls) expect(call).toHaveLength(1);
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
    deps.getUsageLive = vi.fn((_configDir: string) => Promise.resolve(liveUsage(10, 10)));
    deps.getUsageLiveForced = vi.fn((configDir: string) => {
      if (configDir === "/cfg/a")
        return new Promise<AccountUsageLive>((res) => {
          resolveForcedA = res;
        });
      return Promise.resolve(liveUsage(50, 50));
    });
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    // Mount (unforced) fetch → both rows show 10%.
    await waitFor(() => expect(screen.getAllByText("10%").length).toBeGreaterThan(0));

    // Start a's check; its forced fetch is left pending (generation G).
    fireEvent.click(within(await openKebab("a")).getByText("Check usage levels"));
    await waitFor(() =>
      expect(
        vi.mocked(deps.getUsageLiveForced).mock.calls.filter((c) => c[0] === "/cfg/a"),
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
    // ACTUALLY REMOVES. It used to be a no-op spy, which was harmless while nothing in the add flow
    // called it — and became a silent lie the moment `handleAdd` started undoing a failed create:
    // the row would stay on screen in the test while disappearing in production, so the test would
    // have described the OPPOSITE of the shipped behaviour.
    const removeAccount = vi.fn(async (id: string) => {
      const i = accounts.findIndex((a) => a.id === id);
      if (i >= 0) accounts.splice(i, 1);
    });
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
      removeAccount,
      readSpawnLog: vi.fn(async () => []),
    };
    let readsAtLoginStart = -1;
    const onLogin = vi.fn(async () => {
      readsAtLoginStart = getIdentities.mock.calls.length;
      onLoginEffect(identities);
    });
    return { deps, onLogin, getIdentities, removeAccount, readsAtLoginStart: () => readsAtLoginStart };
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

  it("leaves NO row behind when the login resolves no identity", async () => {
    // THIS TEST WAS INVERTED, and the old expectation is worth stating because it was not wrong at
    // the time: it asserted the failed slot stayed on screen looking like failure — nickname title,
    // "Not signed in" sub-line, loud blocked banner — on the principle that a failure state has to
    // LOOK like failure.
    //
    // The founder looked at two such rows and drew the other conclusion: "if I say add account and
    // it doesn't add… it just shouldn't create the account in the first place… I shouldn't have to
    // remove the account." The blocked banner was honest about the row; the row itself was the
    // problem. So the create is UNDONE, and the failure is reported as an error on the add instead.
    const { deps, onLogin, removeAccount } = store(() => {
      /* login window closed, nothing was written — the OAuth never completed */
    });
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    await addAccountNamed("Cloud Max");

    // The slot is gone from the backend, not merely hidden — the same `removeAccount` the duplicate
    // branch uses, so a half-created dir cannot linger and be re-adopted later.
    await waitFor(() => expect(removeAccount).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("account-identity-acct-0")).toBeNull();
    expect(screen.queryByTestId("account-blocked-acct-0")).toBeNull();

    // …and the user is told why, rather than watching a button do nothing. "I could get an error
    // when I try to add it" — his words, in the same breath as "it should just silently go away".
    expect(screen.getByRole("alert").textContent).toMatch(
      /“Cloud Max” was not added — the Claude sign-in did not complete/,
    );
  });

  it("KEEPS a row whose login existed and later went away", async () => {
    // The paired positive, and the boundary the founder drew himself: "now if I was signed in and
    // then I signed out, then it should have the account information still. Right? It should have
    // the account name, the account email address, and I should have a sign in again."
    //
    // The undo above is scoped to a slot THIS add just created and watched fail. An account that is
    // merely signed out now — however it got that way — is never touched by it. Without this test,
    // widening the undo into a general "delete rows with no identity" sweep would stay green.
    const deps = makeDeps(
      [acct("a", { nickname: "Was Signed In", isDefault: true })],
      [],
      [neverLoggedIn("a")],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    expect((await screen.findByTestId("account-identity-a")).textContent).toBe("Was Signed In");
    expect(screen.getByTestId("account-blocked-a")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Finish sign-in/ }).length).toBeGreaterThan(0);
    expect(deps.removeAccount).not.toHaveBeenCalled();
  });

  it("does not cap how many accounts can be added", async () => {
    // The founder has four or five. Nothing in the add path is allowed to bound the list.
    // Each add must SIGN IN now: `handleAdd` undoes a create whose login never landed, so a
    // no-op `onLogin` would leave zero accounts and this would be testing the undo instead.
    // Distinct identities per slot, or the duplicate-reconciliation branch discards them as one.
    let n = 0;
    const { deps, onLogin } = store((ids) => {
      ids.push({
        id: `acct-${n}`,
        email: `add-${n}@example.invalid`,
        organization: null,
        accountUuid: `u-add-${n}`,
      });
      n += 1;
    });
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    for (const name of ["One", "Two", "Three", "Four", "Five"]) await addAccountNamed(name);
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

  // ── LOGIN-EXPIRED "reconnect" MUST ACTUALLY TAKE ────────────────────────────────────────────
  //
  // The founder's report: an account showing "Login expired — reconnect" (the sticky
  // `EXPIRED_LOGIN_NICKNAME` placeholder) — he clicked reconnect and "it didn't do anything", the
  // card stayed expired. The reconnect DID persist a fresh token, but nothing rewrote the stored
  // placeholder nickname, and the title is rendered verbatim from it — so the card kept offering
  // "reconnect" forever, even across a restart. Two halves, one durable and one cosmetic:
  //
  //   (A) the WRITE — a successful reconnect renames the row to its real email, exactly as the
  //       pending-placeholder recovery does. Driven through the REAL reconnect button so deleting
  //       the rename branch reds this test (the untested-production-seam shape the pending pair
  //       above guards against);
  //   (B) the DISPLAY — a row still STORING the expired placeholder but now signed in stops
  //       rendering the expired affordance, so the fix reads on screen even before (A) persists.
  it("renames an expired row to its real email when 'reconnect' actually succeeds", async () => {
    let recovered = false;
    // Non-default so "reconnect" calls handleLogin directly (the default routes through a confirm).
    const deps = makeDeps([acct("x1", { nickname: EXPIRED_LOGIN_NICKNAME })]);
    deps.getIdentities = vi.fn(async () =>
      recovered
        ? [signedInAs("x1", "someone@example.com")]
        : [{ id: "x1", email: null, organization: null, accountUuid: null }],
    );
    const onLogin = vi.fn(async () => {
      recovered = true; // the reconnect lands a fresh credential in the account's own dir
    });
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);

    fireEvent.click(await screen.findByTestId("account-reconnect-x1"));

    await waitFor(() =>
      expect(deps.setNickname).toHaveBeenCalledWith("x1", "someone@example.com"),
    );
  });

  it("does NOT rename an expired row when the reconnect was cancelled or failed", async () => {
    // The paired negative for the write above: renaming unconditionally would pass that test while
    // stamping an email onto a row whose reconnect never completed.
    const deps = makeDeps([acct("x1", { nickname: EXPIRED_LOGIN_NICKNAME })]);
    deps.getIdentities = vi.fn(async () => [
      { id: "x1", email: null, organization: null, accountUuid: null }, // never resolves an identity
    ]);
    const onLogin = vi.fn(async () => {});
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);

    fireEvent.click(await screen.findByTestId("account-reconnect-x1"));

    // Wait for the post-login identity re-read (immediately before the rename branch), so absence
    // afterwards is real rather than a race — same reasoning as the pending pair above.
    await waitFor(() => expect(deps.getIdentities).toHaveBeenCalledTimes(3));
    expect(deps.setNickname).not.toHaveBeenCalled();
  });

  it("stops showing the expired affordance on a row that is stored expired but now signed in", async () => {
    // The DISPLAY half (Gap B). A row whose STORED nickname is still the expired placeholder but
    // whose identity now resolves an email must render the email, not "Login expired — reconnect" —
    // otherwise the reconnect that just persisted a token still shows the user an expired card.
    const deps = makeDeps(
      [acct("x1", { nickname: EXPIRED_LOGIN_NICKNAME })],
      [],
      [signedInAs("x1", "someone@example.com")],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    const title = await screen.findByTestId("account-identity-x1");
    expect(title.textContent).toBe("someone@example.com");
    // The reconnect affordance is gone precisely because the title is no longer the expired string.
    expect(within(title).queryByTestId("account-reconnect-x1")).toBeNull();
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

  it("no longer warns that the folder hosted a DIFFERENT login recently — the notice was removed", async () => {
    // THIS TEST INVERTS A REAL FEATURE, deliberately, and the loss is worth naming rather than
    // glossing. `identityChanged` is the temporal signal from `identity_log::takeover_at`, and it
    // covered a symptom the founder himself hit: running `claude` in a terminal and logging into
    // another account silently turns the DEFAULT card into that account, with both cards then
    // showing identical usage because they had genuinely become one login. Nothing else reports it.
    //
    // He read the notice in situ and asked for it gone anyway — "let's just get rid of that message
    // completely" — which is his call. The Rust signal and `identityChanged` are untouched, so
    // restoring a surface costs only markup; this asserts the current, intended state so a later
    // reader knows the absence is a decision rather than a regression.
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

    // Wait for the card, or the absence below is an assertion about an empty document.
    expect((await screen.findByTestId("account-identity-def")).textContent).toBe("FC Superadmin");
    expect(screen.queryByTestId("account-identity-changed-def")).toBeNull();
    expect(screen.queryByText(/signed into a different Claude account/i)).toBeNull();
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

  // THE TOP-OF-SCREEN BANNERS ARE GONE. They read "2 accounts are the same Claude login
  // (x@y.com). A and B share one usage quota, so switching between them gains you nothing — they
  // hit the limit together. Log one of them into a different Claude account, or remove it." The
  // founder: "there's just too much text here… don't put something at the top that says all this
  // text. I think just put in the second box duplicate."
  //
  // The banner also had a defect the founder did not name and the new treatment fixes: it had to
  // identify its subjects by NICKNAME, which is user-typed, and telling two registrations of one
  // login apart is the exact thing a nickname cannot do. The label now sits ON the duplicate row,
  // where it needs no name at all.

  it("marks the duplicate row out of rotation and labels it, instead of a banner at the top", async () => {
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

    // EXACTLY ONE of the two is the duplicate — the FIRST claim of a login keeps it, so the other
    // row is the redundant one. Asserting both were marked would describe a screen that says the
    // pool is empty when it has one usable account in it.
    const marked = await screen.findByTestId("account-rotation-reason-g");
    expect(marked.textContent).toBe("duplicate");
    expect(screen.getByTestId("account-rotation-g").textContent).toMatch(/out of rotation/);
    expect(screen.getByTestId("account-rotation-s").textContent).toMatch(/in rotation/);
    expect(screen.queryByTestId("account-rotation-reason-s")).toBeNull();

    // And the banner it replaces is really gone, not merely re-worded.
    expect(screen.queryByText(/are the same Claude login/i)).toBeNull();
    expect(screen.queryByText(/share one usage quota/i)).toBeNull();
  });

  it("refuses to put a duplicate back in rotation, and says why", async () => {
    // The founder's explicit ask — "the ability to put it into rotation would be grayed out… because
    // it's a duplicate". A shared quota is no escape from a limit, so the control would not do what
    // pressing it implies.
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
    await screen.findByTestId("account-rotation-reason-g");

    const menu = await openKebab("g");
    const toggle = within(menu).getByTestId("account-rotation-toggle-g");
    expect(toggle.textContent).toBe("Put in rotation");
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(toggle.getAttribute("title")).toMatch(/share one quota/i);

    // The paired positive: the row that ISN'T a duplicate has a live toggle. Without it this test
    // would pass against a menu item that is disabled for everyone.
    const other = await openKebab("s");
    expect((within(other).getByTestId("account-rotation-toggle-s") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("counts four registrations of one login as ONE account in rotation", async () => {
    // Four is the live-machine state that exposed the old banner's `.join(" and ")` ("A and B and C
    // and D"). There is no sentence to mis-join now, so the claim worth pinning is the arithmetic
    // the founder actually cares about: four rows, one quota, and the header must not say four.
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

    expect((await screen.findByTestId("rotation-headline")).textContent).toBe(
      "Only 1 account is in rotation",
    );
    for (const id of ["g", "s", "a"]) {
      expect(screen.getByTestId(`account-rotation-reason-${id}`).textContent).toBe("duplicate");
    }
    expect(screen.queryByTestId("account-rotation-reason-p")).toBeNull();
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
    // Neither row is a duplicate, so neither carries the label — the paired negative for the two
    // tests above, which would otherwise pass against a screen that marks everything.
    expect(screen.queryByTestId("account-rotation-reason-s")).toBeNull();
    expect(screen.queryByTestId("account-rotation-reason-g")).toBeNull();
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
    // Out of rotation, yes — but for the reason a human can act on, not as a bogus duplicate. Two
    // config dirs with no login are not evidence of a shared one.
    expect(screen.getByTestId("account-rotation-reason-s").textContent).toBe("not signed in");
    expect(screen.getByTestId("account-rotation-reason-g").textContent).toBe("not signed in");
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

// ── THE GLANCE MOVED INTO THE HEADER, AND THE BULLETS ARE GONE ───────────────────────────────────
// This suite used to drive `rotation-banner`: a bordered card under the header carrying a headline,
// a sentence, and a `<ul>` naming every registration that did not count toward rotation. Eight of
// its tests were about that list — collapsing shared placeholder nicknames, NOT over-collapsing
// renamed ones, choosing expired copy over never-signed-in copy, refusing to collapse redundant
// rows. Every one of those was solving the same problem: the bullets described ACCOUNTS from a
// banner sitting above them, so each had to re-identify its subject by quoting a nickname — and the
// nicknames being quoted are generic placeholders that two rows can share.
//
// The founder read the result and could not parse it: "signing in is registered, but has never been
// signed in. Like, I don't know what that means." The facts are now a dot and a two-word label on
// the card each is ABOUT, where there is nothing to quote and nothing to collide, so the collapse
// logic and its tests both go. What is left here is the header's own claim — is rotation running,
// and how many accounts can receive a spawn — plus the paired negative that the list is really gone
// rather than re-worded, and the assertions that the count and the cards cannot disagree.
describe("the rotation glance in the header", () => {
  it("THE FOUNDER'S STATE: one usable account, and the dead row says so on its own card", async () => {
    const deps = makeDeps(
      [
        acct("personal", { nickname: "DROdio Personal", isDefault: true }),
        acct("gmail", { nickname: "DROdio Gmail" }),
      ],
      [used("personal", 10_000_000)],
      [signedInAs("personal", "drodio@gmail.com"), neverLoggedIn("gmail")],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    expect((await screen.findByTestId("rotation-headline")).textContent).toBe(
      "Only 1 account is in rotation",
    );
    // The account every agent will actually land on, by its VERIFIED email — never the nickname.
    expect(screen.getByTestId("accounts-header").textContent).toContain("drodio@gmail.com");
    expect(screen.getByTestId("accounts-header").textContent).toContain(
      "Sign in another account to enable rotation",
    );
    // NOT green, and not claiming rotation. "Do not display status as green when the account has
    // not yet been signed in" — the founder's rule, applied to the header that summarises them.
    expect(screen.getByTestId("rotation-state-label").textContent).toBe("rotation stalled");

    // …and the registration that does not count says so where a human is looking at it.
    expect(screen.getByTestId("account-rotation-gmail").textContent).toMatch(/out of rotation/);
    expect(screen.getByTestId("account-rotation-reason-gmail").textContent).toBe("not signed in");
    expect(screen.getByTestId("account-rotation-personal").textContent).toMatch(/in rotation/);
  });

  it("says NOTHING is signed in when no account has a login", async () => {
    const deps = makeDeps(
      [acct("a", { nickname: "One" }), acct("b", { nickname: "Two" })],
      [],
      [neverLoggedIn("a"), neverLoggedIn("b")],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    expect((await screen.findByTestId("rotation-headline")).textContent).toBe(
      "No account is signed in",
    );
    expect(screen.getByTestId("accounts-header").textContent).toContain(
      "whatever your terminal is logged into",
    );
    expect(screen.getByTestId("rotation-state-label").textContent).toBe("rotation stalled");
  });

  it("reports rotation ACTIVE with the count once two logins exist", async () => {
    const deps = makeDeps(
      [acct("a", { nickname: "One" }), acct("b", { nickname: "Two" })],
      [],
      [signedInAs("a", "one@example.com", "u1"), signedInAs("b", "two@example.com", "u2")],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    expect((await screen.findByTestId("rotation-headline")).textContent).toBe(
      "Rotation active: 2 accounts available",
    );
    expect(screen.getByTestId("rotation-state-label").textContent).toBe("rotation active");
    // The founder's own sentence for where the next agent goes. The banner used to LIST the
    // accounts here; he asked for the rule instead, and the rule does not grow with the fleet.
    expect(screen.getByTestId("accounts-header").textContent).toContain(
      "New agents go to whichever account has the most room left",
    );
    expect(screen.getByTestId("accounts-header").textContent).not.toContain("nothing to rotate to");
  });

  // ── THE PAIRED NEGATIVE FOR THE DELETED LIST ────────────────────────────────────────────────
  // Driven with the exact fixture that used to produce a COLLAPSED bullet ("2 accounts are still
  // “Signing in…”"), because that is the case the removed logic existed for. If the list came back
  // in any form this fails, and the per-card assertions below are what stop it passing by rendering
  // nothing at all.
  it("names excluded registrations on their own cards, not as bullets in the header", async () => {
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

    const header = await screen.findByTestId("accounts-header");
    expect(within(header).queryAllByRole("listitem")).toHaveLength(0);
    expect(header.textContent).not.toMatch(/never been signed in/i);
    expect(header.textContent).not.toMatch(/2 accounts are still/i);

    // Both rows say it themselves — no count, no quoted nickname, no way for two of them to collide.
    for (const id of ["p1", "p2"]) {
      expect(screen.getByTestId(`account-rotation-reason-${id}`).textContent).toBe("not signed in");
    }
  });

  it("an EXPIRED login reads as expired on its card, not as 'never signed in'", async () => {
    // The distinction the deleted bullet copy worked hard to preserve, and it still matters: an
    // expired login is not a dir that was never used, and pointing the user at "sign in" rather than
    // "reconnect" sends them to the wrong remedy. The wire shape is what production emits — email
    // AND accountUuid both null, because Claude Code cleared the whole `oauthAccount`.
    const deps = makeDeps(
      [
        acct("real", { nickname: "Real", isDefault: true }),
        acct("x1", { nickname: EXPIRED_LOGIN_NICKNAME }),
      ],
      [],
      [
        signedInAs("real", "real@example.com", "u1"),
        { id: "x1", email: null, organization: null, accountUuid: null },
      ],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    // The founder's ask for this card: "put login expired in red instead of white, and make
    // reconnect a clickable link."
    const title = await screen.findByTestId("account-identity-x1");
    expect(title.textContent).toBe("Login expired — reconnect");
    expect(within(title).getByTestId("account-reconnect-x1").tagName).toBe("BUTTON");
  });

  // ── MAIN'S CARRIER-ANCHORED GUARD, KEPT ─────────────────────────────────────────────────────
  // Landed on main (#2375) while this branch was in review, and it is better than what this branch
  // had: it anchors #2355's guarantee on the `account-blocked-<id>` card that actually carries it,
  // rather than on a nickname the fixture supplies — a shape that would stay green with every trace
  // of expired handling deleted. Only its POSITIVE 1 is adapted, because this branch moved the box
  // it read into the header.
  // Sentences that are FALSE of a login that expired. The first two are the deleted bullet's own
  // wording; the rest are what the blocked card's softened sentence would revert to if someone
  // "restored" the plainer copy without knowing why it was softened — which is the regression this
  // guard exists to catch, and the one the bullet-only phrasings miss entirely.
  const WRONG_FOR_AN_EXPIRED_LOGIN = [
    "never signed in",
    "never been signed in",
    "was ever completed",
    "never completed",
  ];

  // THE GUARANTEE #2355 LANDED, CARRIED ACROSS THE SURFACE THAT CARRIED IT (commit a2e60d636).
  //
  // #2355 fixed the rotation box's per-account bullets so an EXPIRED login stopped being described
  // as "never signed in" — a contradiction, because the bullet quoted a nickname that already read
  // "Login expired — reconnect", and it pointed at the wrong remedy (sign in for the first time, vs
  // reconnect). This branch then deleted those bullets wholesale at the founder's instruction, and
  // deleted #2355's test along with them, because a test that asserts on a bullet cannot outlive
  // the bullet.
  //
  // What must NOT be lost is the CLAIM, which is independent of the bullets: nothing on this screen
  // may tell a user with an expired login that they never signed in. So the claim is re-pinned here
  // against the surviving surface.
  //
  // PAIRED on purpose, because `not.toContain` alone is exactly the vacuous shape — it passes just
  // as well against a banner that renders nothing, or a screen where the expired rows never loaded.
  // The positive assertions establish that the screen really did render this state before the
  // negative ones are allowed to mean anything.
  //
  // ANCHORED ON THE CARRIER, NOT ON THE FIXTURE (roborev 67401). An earlier version of this test
  // asserted the ROW contained EXPIRED_LOGIN_NICKNAME, which is the precondition wearing the
  // costume of a side effect: the fixture hands the row that exact string and the title renders
  // `display.nickname || primary`, so it passes for any component that echoes `a.nickname` — every
  // trace of expired handling could be deleted from the card and it would stay green.
  //
  // The surface that actually carries #2355's guarantee is the `account-blocked-<id>` card, whose
  // SECOND sentence was deliberately softened to "no active Claude login" precisely because it now
  // also covers a login that EXPIRED (see the comment at its definition: "no login was ever
  // completed" would be a lie for that row). So that sentence is what a regression would revert,
  // and the negatives are widened to the phrasings it could revert TO — "never signed in" alone
  // does not match "no login was ever completed", so pinning only that leaves the real hole open.
  it("never tells an EXPIRED login it has never signed in — the reason moved to the row, not away", async () => {
    const deps = makeDeps(
      [
        acct("real", { nickname: "Real", isDefault: true }),
        acct("x1", { nickname: EXPIRED_LOGIN_NICKNAME }),
        acct("x2", { nickname: EXPIRED_LOGIN_NICKNAME }),
      ],
      [],
      [signedInAs("real", "real@example.com", "u1"), neverLoggedIn("x1"), neverLoggedIn("x2")],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    // POSITIVE 1 — the header rendered its real verdict for this state. Without this the negative
    // below would hold over an empty header. `rotation-banner` in main's version; this branch moved
    // that box into the header as `RotationGlance`, so the carrier of the same claim is the headline.
    expect((await screen.findByTestId("rotation-headline")).textContent).toBe(
      "Only 1 account is in rotation",
    );

    // POSITIVE 2 — THE CARRIER. Each expired row renders the blocked card, and that card's second
    // sentence is the expiry-compatible wording. This is DERIVED output (the card renders on
    // `!signedIn`, and this copy is a constant of the component, not of the fixture), so it fails
    // if the expired handling is removed — unlike a nickname echo, which the fixture supplies.
    for (const id of ["x1", "x2"]) {
      const blocked = await screen.findByTestId(`account-blocked-${id}`);
      expect(blocked.textContent).toContain("no active Claude login");
      // The remedy has to come with the diagnosis: this card is the only place an expired row is
      // offered a way back, so a card that states the problem without the control is half-useless.
      expect(within(blocked).getByRole("button", { name: /Finish sign-in/ })).toBeTruthy();

      // POSITIVE 3 — THE EXPIRY-DERIVED SURFACE, added when this test was carried onto this branch.
      // main's comment above claims POSITIVE 2 "fails if the expired handling is removed", and on
      // this branch that was not true: `account-blocked-<id>` renders on `!signedIn`, a function of
      // the recorded identity with NO expiry input, and its sentence and button are constants of that
      // branch. The whole expiry feature could be deleted and everything above would stay green.
      //
      // `account-reconnect-<id>` exists ONLY because of the `titleText === EXPIRED_LOGIN_NICKNAME`
      // branch, so it is the one assertion here that actually reads expired handling. Without it this
      // is a copy-pin on the blocked card wearing a carrier-anchored test's comment — the same
      // precondition-as-side-effect shape the comment above warns about, one level up.
      expect(
        within(screen.getByTestId(`account-identity-${id}`)).getByTestId(`account-reconnect-${id}`),
      ).toBeTruthy();

      // Scoped to the carrier as well as to the document below — a negative that only ever runs
      // over the whole body cannot say WHERE the wrong sentence would have appeared.
      const blockedText = blocked.textContent ?? "";
      for (const wrong of WRONG_FOR_AN_EXPIRED_LOGIN) {
        expect(blockedText).not.toContain(wrong);
      }
    }

    // THE CLAIM ITSELF — the wrong sentence is nowhere on the screen, not merely absent from the
    // bullets it used to live in, and not merely absent in the two phrasings the DELETED bullet
    // happened to use.
    const text = document.body.textContent ?? "";
    for (const wrong of WRONG_FOR_AN_EXPIRED_LOGIN) {
      expect(text).not.toContain(wrong);
    }
  });

  it("the reconnect link opens the login flow", async () => {
    // The paired positive: a link that looks like a link and does nothing would be worse than the
    // plain text it replaced. `x1` is NOT the default account, so it logs in with one click rather
    // than going through the default-account confirm.
    const onLogin = vi.fn();
    const deps = makeDeps(
      [acct("real", { nickname: "Real", isDefault: true }), acct("x1", { nickname: EXPIRED_LOGIN_NICKNAME })],
      [],
      [
        signedInAs("real", "real@example.com", "u1"),
        { id: "x1", email: null, organization: null, accountUuid: null },
      ],
    );
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);

    fireEvent.click(await screen.findByTestId("account-reconnect-x1"));
    await waitFor(() => expect(onLogin).toHaveBeenCalledTimes(1));
    expect(onLogin.mock.calls[0]![0]).toMatchObject({ id: "x1" });
  });

  // ── THE COUNT AND THE CARDS CANNOT DISAGREE ─────────────────────────────────────────────────
  // The contradiction the founder screenshotted: "Rotation active — 6 accounts available" over a
  // list explaining that four of them were not. Taking one out from its kebab is the cheapest way to
  // create that state, so it is what this drives.
  it("nets manual opt-outs off the header count", async () => {
    const deps = makeDeps(
      [acct("a", { nickname: "One", isDefault: true }), acct("b", { nickname: "Two" })],
      [],
      [signedInAs("a", "one@example.com", "u1"), signedInAs("b", "two@example.com", "u2")],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect((await screen.findByTestId("rotation-headline")).textContent).toBe(
      "Rotation active: 2 accounts available",
    );

    const menu = await openKebab("b");
    const toggle = within(menu).getByTestId("account-rotation-toggle-b");
    expect(toggle.textContent).toBe("Take out of rotation");
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(screen.getByTestId("rotation-headline").textContent).toBe(
        "Only 1 account is in rotation",
      ),
    );
    expect(screen.getByTestId("account-rotation-b").textContent).toMatch(/out of rotation/);
    expect(screen.getByTestId("account-rotation-reason-b").textContent).toBe("you took it out");
    expect(screen.getByTestId("account-rotation-a").textContent).toMatch(/in rotation/);

    // …and back again. Without this the test above passes against a toggle that is one-way.
    fireEvent.click(within(await openKebab("b")).getByTestId("account-rotation-toggle-b"));
    await waitFor(() =>
      expect(screen.getByTestId("rotation-headline").textContent).toBe(
        "Rotation active: 2 accounts available",
      ),
    );
  });

  it("pauses and resumes the fleet from the header icon", async () => {
    // The founder's control: "there would just be a pause button… then it would say rotation paused
    // … and if I click it again, then it goes back to rotation active." The icon IS the button.
    const deps = makeDeps(
      [acct("a", { nickname: "One", isDefault: true }), acct("b", { nickname: "Two" })],
      [],
      [signedInAs("a", "one@example.com", "u1"), signedInAs("b", "two@example.com", "u2")],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect((await screen.findByTestId("rotation-state-label")).textContent).toBe("rotation active");

    fireEvent.click(screen.getByTestId("rotation-toggle"));

    await waitFor(() =>
      expect(screen.getByTestId("rotation-state-label").textContent).toBe("rotation paused"),
    );
    expect(screen.getByTestId("rotation-headline").textContent).toBe(
      "Rotation paused — new agents are held",
    );
    // A pause HOLDS new agents (and stops new spend) rather than freezing them onto an account — the
    // copy must say so, or the reasonable reading is that nothing changed or that running agents died.
    expect(screen.getByTestId("accounts-header").textContent).toContain(
      "New agents are held — none will start, and no new account spend begins, until you restart.",
    );

    fireEvent.click(screen.getByTestId("rotation-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("rotation-state-label").textContent).toBe("rotation active"),
    );
  });

  // ── THE HEADER MUST NOT SAY ANYTHING THE ROUTER WOULD CONTRADICT ────────────────────────────
  // Three ways it could, all reachable, none of them exotic: the pool count and the "nothing signed
  // in" copy are different facts; a probe-expired row is signed-in by identity and dead in reality;
  // and a fleet target the spawn path has already discarded is still an account this screen can
  // name. Each one puts the loudest line on the screen at odds with where agents actually go.

  it("distinguishes 'nothing is signed in' from 'everything has been taken out'", async () => {
    // One click of the toggle this screen just gained. Taking the last account out used to render
    // "No account is signed in. Agents will run on whatever your terminal is logged into. Sparkle has
    // no account of its own to hand them." — false in both sentences, since `outOfRotationIds`
    // demotes out of `candidates` and never out of `eligible`, so spawns still land on a Sparkle
    // account. It also points at the wrong remedy: the fix is the ⋮ menu, not signing in.
    const deps = makeDeps(
      [acct("a", { nickname: "One", isDefault: true })],
      [],
      [signedInAs("a", "one@example.com", "u1")],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    await screen.findByTestId("account-rotation-a");
    fireEvent.click(within(await openKebab("a")).getByTestId("account-rotation-toggle-a"));

    await waitFor(() =>
      expect(screen.getByTestId("rotation-headline").textContent).toBe("No account is in rotation"),
    );
    const header = screen.getByTestId("accounts-header");
    expect(header.textContent).toContain("out of rotation by your own choice");
    expect(header.textContent).toContain("put one back from its ⋮ menu");
    // …and it does NOT invent an expiry that is not there. The copy is built from the actual mix.
    expect(header.textContent).not.toContain("dead — reconnect");
    expect(header.textContent).not.toContain("whatever your terminal is logged into");

    // The paired negative, in the state that copy IS true for: no login anywhere.
    cleanup();
    const none = makeDeps([acct("b", { nickname: "Two" })], [], [neverLoggedIn("b")]);
    render(<AccountsScreen onLogin={vi.fn()} deps={none} />);
    expect((await screen.findByTestId("rotation-headline")).textContent).toBe(
      "No account is signed in",
    );
    expect(screen.getByTestId("accounts-header").textContent).toContain(
      "whatever your terminal is logged into",
    );
  });

  it("drops a PROBE-EXPIRED account from the count, not just from its own card", async () => {
    // `rotationReadiness` decides `usable` from an email being present; `authIsDefinitelyExpired`
    // exists precisely to catch a row that still HAS an email over a dead OAuth session. So this row
    // is "usable" by identity and dead in fact, and the header used to count it — printing "Rotation
    // active: 2 accounts available" directly above a card reading "out of rotation · login expired".
    const deps = makeDeps(
      [acct("a", { nickname: "Live", isDefault: true }), acct("b", { nickname: "Dead" })],
      [],
      [signedInAs("a", "one@example.com", "u1"), signedInAs("b", "two@example.com", "u2")],
    );
    deps.getAuthStatus = vi.fn(async (configDir?: string): Promise<ClaudeAuthStatus> => ({
      loggedIn: !configDir?.includes("b"),
      source: "cli",
      email: "x@example.invalid",
      authMethod: "oauth",
      subscriptionType: "max",
    }));
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    await waitFor(() =>
      expect(screen.getByTestId("rotation-headline").textContent).toBe(
        "Only 1 account is in rotation",
      ),
    );
    expect(screen.getByTestId("account-rotation-reason-b").textContent).toBe("login expired");
    // …and the healthy sibling is still counted, so this is evidence about the expired row rather
    // than about the count collapsing whenever a probe runs at all.
    expect(screen.getByTestId("account-rotation-a").textContent).toMatch(/in rotation/);
  });

  it("stops naming a manual override once the account hits a real rate limit", async () => {
    // `usablePreferredAccount` drops a preference for an account at an OBSERVED wall, so every spawn
    // has already fallen through to auto-pick. The header applied only the pool test, so it kept
    // announcing "every new agent runs on X" about an account nothing was being routed to.
    const FUTURE_SECS = Math.floor(Date.now() / 1000) + 3600;
    const { deps, state } = routableDeps(
      [acct("a", { nickname: "Walled" }), acct("b", { nickname: "Fine" })],
      [signedIn("a"), signedIn("b")],
    );
    state.preferred = "a";
    deps.getUsage = vi.fn(async () => [
      { id: "a", tokens5h: 10, tokens7d: 10, exhaustedUntil: FUTURE_SECS * 1000 },
      { id: "b", tokens5h: 10, tokens7d: 10, exhaustedUntil: null },
    ]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    await screen.findByTestId("account-rotation-a");

    expect(screen.getByTestId("accounts-header").textContent).not.toContain("Manual override");

    // The paired positive: the SAME override, on an account that is not walled, IS announced —
    // without it this would pass against a header that never says "Manual override" at all.
    cleanup();
    const ok = routableDeps(
      [acct("a", { nickname: "Walled" }), acct("b", { nickname: "Fine" })],
      [signedIn("a"), signedIn("b")],
    );
    ok.state.preferred = "a";
    render(<AccountsScreen onLogin={vi.fn()} deps={ok.deps} />);
    await screen.findByTestId("account-rotation-a");
    await waitFor(() =>
      expect(screen.getByTestId("accounts-header").textContent).toContain("Manual override"),
    );
  });

  it("holds new agents while paused and never names a frozen account, even after one is taken out", async () => {
    // The spend-halt pause names no "frozen" account — new agents are HELD regardless of which accounts
    // are in the pool — so taking one out while paused must not change that copy or the paused state.
    // This replaces the old "freeze onto the leading account" behaviour, where the header did name a
    // target and had to stop naming it when the target was taken out.
    const deps = makeDeps(
      [acct("a", { nickname: "One", isDefault: true }), acct("b", { nickname: "Two" })],
      [],
      [signedInAs("a", "one@example.com", "u1"), signedInAs("b", "two@example.com", "u2")],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    await screen.findByTestId("account-rotation-a");

    fireEvent.click(screen.getByTestId("rotation-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("rotation-state-label").textContent).toBe("rotation paused"),
    );
    // Held, and no account is named as frozen.
    expect(screen.getByTestId("accounts-header").textContent).toContain("New agents are held");
    expect(screen.getByTestId("accounts-header").textContent).not.toContain("New agents stay on");

    // Take one account out; the pause is unchanged and the copy still says agents are held.
    fireEvent.click(within(await openKebab("a")).getByTestId("account-rotation-toggle-a"));
    await waitFor(() =>
      expect(screen.getByTestId("rotation-state-label").textContent).toBe("rotation paused"),
    );
    expect(screen.getByTestId("accounts-header").textContent).toContain("New agents are held");
    expect(screen.getByTestId("accounts-header").textContent).not.toContain("New agents stay on");
  });

  it("an all-EXPIRED pool points at reconnecting, not at the ⋮ menu", async () => {
    // The case a two-way zero branch gets wrong, and it is not exotic: a one-account install whose
    // OAuth session has died is `usable` by identity (an email is recorded) and out of the pool by
    // probe. It used to be told its only account had "been taken out or is a duplicate" — neither
    // true — and sent to a menu item that does not apply, past the Reconnect button on the card.
    const deps = makeDeps(
      [acct("a", { nickname: "Only", isDefault: true })],
      [],
      [signedInAs("a", "one@example.com", "u1")],
    );
    deps.getAuthStatus = vi.fn(async (): Promise<ClaudeAuthStatus> => ({
      loggedIn: false,
      source: "cli",
      email: "one@example.com",
      authMethod: "oauth",
      subscriptionType: "max",
    }));
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    await waitFor(() =>
      expect(screen.getByTestId("rotation-headline").textContent).toBe(
        "This account's login has expired",
      ),
    );
    const header = screen.getByTestId("accounts-header").textContent ?? "";
    expect(header).toContain("dead — reconnect from the card");
    // The remedy it must NOT name: the ⋮ toggle is greyed out for an expired row, so pointing at it
    // sends the user to a control disabled for exactly the reason they are there.
    expect(header).not.toContain("⋮ menu");
    expect(header).not.toContain("whatever your terminal is logged into");
    // …and the remedy it points at is really there.
    expect(screen.getByTestId("account-renew-a")).toBeTruthy();
  });

  it("an expired account that ALSO holds the override still points at reconnecting", async () => {
    // THE COLLISION between this branch's two halves, and it is the likely state rather than a
    // contrived one: `setPreferredAccountId` is written by the auto-switch path as well as by the
    // button, so a one-account install can hold a preference nobody clicked for. With the fleet-
    // target line evaluated first, the header read "This account's login has expired" over "Manual
    // override: every new agent runs on Only…" — two lines contradicting each other, with the
    // reconnect remedy unreachable.
    const { deps, state } = routableDeps([acct("only", { nickname: "Only" })], [signedIn("only")]);
    state.preferred = "only";
    deps.getAuthStatus = vi.fn(async (): Promise<ClaudeAuthStatus> => ({
      loggedIn: false,
      source: "cli",
      email: "only@example.invalid",
      authMethod: "oauth",
      subscriptionType: "max",
    }));
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    await waitFor(() =>
      expect(screen.getByTestId("rotation-headline").textContent).toBe(
        "This account's login has expired",
      ),
    );
    const header = screen.getByTestId("accounts-header").textContent ?? "";
    expect(header).toContain("dead — reconnect from the card");
    // AND WHERE THE WORK IS ACTUALLY GOING. `usablePreferredAccount` does not gate on the auth probe,
    // so this expired account still takes every spawn — an earlier cut of this branch replaced that
    // fact with a flat "New agents still run on the least-bad account", which was simply false.
    expect(header).toContain("Every new agent still runs on");
    expect(header).not.toContain("least-bad account");
  });

  it("names BOTH reasons when the pool is empty for two different ones", async () => {
    // An empty pool is almost never single-cause once there is more than one account. With A expired
    // and B taken out, asserting either cause alone is false about the other — and naming the ⋮ menu
    // for A sends the user to a toggle that is greyed out precisely BECAUSE A is expired.
    const deps = makeDeps(
      [acct("a", { nickname: "Dead", isDefault: true }), acct("b", { nickname: "Parked" })],
      [],
      [signedInAs("a", "dead@example.com", "u1"), signedInAs("b", "parked@example.com", "u2")],
    );
    deps.getAuthStatus = vi.fn(async (configDir?: string): Promise<ClaudeAuthStatus> => ({
      loggedIn: !configDir?.includes("/cfg/a"),
      source: "cli",
      email: "x@example.invalid",
      authMethod: "oauth",
      subscriptionType: "max",
    }));
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    await screen.findByTestId("account-rotation-b");

    fireEvent.click(within(await openKebab("b")).getByTestId("account-rotation-toggle-b"));

    await waitFor(() =>
      expect(screen.getByTestId("rotation-headline").textContent).toBe("No account is in rotation"),
    );
    const header = screen.getByTestId("accounts-header").textContent ?? "";
    expect(header).toContain("One account's session is dead — reconnect from the card.");
    expect(header).toContain("One account is out of rotation by your own choice");
    // The claim the single-cause copy used to make about BOTH of them.
    expect(header).not.toContain("Every signed-in account");
  });

  it("still names a manual override onto the redundant half of a duplicate pair", async () => {
    // The header must not be STRICTER than the router. `rotationPool` drops duplicates; the router's
    // own gate does not, and the Manual Override button is enabled on a readable email alone — so
    // activating the redundant row is one click and every spawn really does go there. A header that
    // dropped the line would print "New agents go to whichever account has the most room left" while
    // a fixed target was in force, which is the same false claim pointing the other way.
    const UUID = "5fb3d67c-f4ed-417b-9bf2-f9156450eb73";
    const { deps, state } = routableDeps(
      [acct("s", { nickname: "First", isDefault: true }), acct("g", { nickname: "Second" })],
      [
        { id: "s", email: "drodio@gmail.com", organization: null, accountUuid: UUID },
        { id: "g", email: "drodio@gmail.com", organization: null, accountUuid: UUID },
      ],
    );
    state.preferred = "g"; // the REDUNDANT half — out of the pool, in force with the router
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    await screen.findByTestId("account-rotation-reason-g");
    expect(screen.getByTestId("account-rotation-reason-g").textContent).toBe("duplicate");
    expect(screen.getByTestId("accounts-header").textContent).toContain(
      "Manual override: every new agent runs on",
    );
  });

  it("an override made while PAUSED is reported as winning, because it does", async () => {
    // `chooseAccountForAgent` consults the preference BEFORE the freeze, so an activation made while
    // rotation is paused really does take every spawn. Stated the other way round — and it was — the
    // header read "New agents stay on X until you resume" while agents were going to Y. An accepted
    // `switch_all` from the concierge reaches exactly that state without anyone touching this screen.
    const { deps, state } = routableDeps(
      [acct("a", { nickname: "Frozen", isDefault: true }), acct("b", { nickname: "Chosen" })],
      [signedIn("a"), signedIn("b")],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    await screen.findByTestId("account-rotation-a");

    fireEvent.click(screen.getByTestId("rotation-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("rotation-state-label").textContent).toBe("rotation paused"),
    );
    // The control: with no override, the pause hold is what the body reports.
    expect(screen.getByTestId("accounts-header").textContent).toContain("New agents are held");

    fireEvent.click(within(screen.getByTestId("account-row-b")).getByText("Manual Override"));
    expect(state.preferred).toBe("b");

    await waitFor(() =>
      expect(screen.getByTestId("accounts-header").textContent).toContain("Manual override"),
    );
    const header = screen.getByTestId("accounts-header").textContent ?? "";
    expect(header).not.toContain("New agents are held");
    // …and the pause is not hidden by the override winning — it is still true, and still says so.
    expect(header).toContain("this override outranks the hold");
    expect(screen.getByTestId("rotation-state-label").textContent).toBe("rotation paused");
  });

  it("promotes the sibling when a duplicate's FIRST registration is taken out", async () => {
    // The screen's half of the order-dependence: `aa` is the redundant row until `a` leaves, at which
    // point `aa` represents the login and must stop reading "out of rotation · duplicate" — otherwise
    // the count includes a row whose own card says it is excluded.
    const UUID = "5fb3d67c-f4ed-417b-9bf2-f9156450eb73";
    const deps = makeDeps(
      [acct("a", { nickname: "First", isDefault: true }), acct("aa", { nickname: "Second" })],
      [],
      [
        { id: "a", email: "shared@example.com", organization: null, accountUuid: UUID },
        { id: "aa", email: "shared@example.com", organization: null, accountUuid: UUID },
      ],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect((await screen.findByTestId("account-rotation-reason-aa")).textContent).toBe("duplicate");

    fireEvent.click(within(await openKebab("a")).getByTestId("account-rotation-toggle-a"));

    await waitFor(() =>
      expect(screen.getByTestId("account-rotation-reason-a").textContent).toBe("you took it out"),
    );
    // `aa` now holds the login, so it is in rotation and the count still says one.
    expect(screen.getByTestId("account-rotation-aa").textContent).toMatch(/in rotation/);
    expect(screen.queryByTestId("account-rotation-reason-aa")).toBeNull();
    expect(screen.getByTestId("rotation-headline").textContent).toBe(
      "Only 1 account is in rotation",
    );
  });

  it("an EMPTY pool with a surviving override names both the target and the remedy", async () => {
    // The two-account version of the state above, and the one the reviewer's fix is aimed at: A's
    // session is dead AND A holds the preference (which the auto-switch arm writes without a click);
    // B is taken out from the kebab. The pool is empty, yet `usablePreferredAccount` pins every spawn
    // to A — so the header owes both facts: what is wrong with A, and that A is nonetheless where
    // the work is going.
    const { deps, state } = routableDeps(
      [acct("a", { nickname: "Dead", isDefault: true }), acct("b", { nickname: "Parked" })],
      [signedIn("a"), signedIn("b")],
    );
    state.preferred = "a";
    deps.getAuthStatus = vi.fn(async (configDir?: string): Promise<ClaudeAuthStatus> => ({
      loggedIn: !configDir?.includes("/cfg/a"),
      source: "cli",
      email: "x@example.invalid",
      authMethod: "oauth",
      subscriptionType: "max",
    }));
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    await screen.findByTestId("account-rotation-b");

    fireEvent.click(within(await openKebab("b")).getByTestId("account-rotation-toggle-b"));

    await waitFor(() =>
      expect(screen.getByTestId("rotation-headline").textContent).toBe("No account is in rotation"),
    );
    const header = screen.getByTestId("accounts-header").textContent ?? "";
    // Both reasons, each with its own remedy…
    expect(header).toContain("session is dead — reconnect from the card");
    expect(header).toContain("out of rotation by your own choice");
    // …and the truth about routing, which is NOT least-bad here.
    expect(header).toContain("Every new agent still runs on");
    expect(header).not.toContain("least-bad account");
  });

  it("offers the fix inline: the header's add button opens the add form", async () => {
    const deps = makeDeps([acct("a")], [], [signedInAs("a", "one@example.com")]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    fireEvent.click(await screen.findByRole("button", { name: /\+ Add account/ }));
    // The form is open and ready to type into — the remedy is one click from the diagnosis.
    expect(screen.getByLabelText("New account nickname")).toBeTruthy();
  });

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

  // main's "no counted-out bullets" test asserted `rotation-banner`, the box this branch replaces
  // with the in-header `RotationGlance`. Its GUARANTEE is kept, not dropped: "names excluded
  // registrations on their own cards, not as bullets in the header" drives the same fixture (one
  // usable login, a never-signed-in row, a same-login duplicate) and asserts the header renders no
  // <li> and none of the removed sentences — plus the per-card reasons that replaced them, which
  // main's version could not assert because that half did not exist yet.
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

  it("fires from REAL Anthropic usage with no observed wall — and says NEAR, not AT, its limit", async () => {
    // AC8 tracks the SAME signal the spawn gate excludes on: an account at 97% of its REAL Anthropic
    // limit with NO rate-limit event is out of room to auto-pick, so the banner must say so. But
    // because there is no observed wall, the account is NEAR its limit, not AT it — agents still spawn
    // — so the copy must not claim a wall was hit. This distinction matters now that the avoid
    // threshold is 90 (LIVE_AVOID_PERCENT): the banner can fire with up to 10% real quota left. Remove
    // the live clause from `exhaustionOutlook` and this banner never renders (the gate and banner
    // disagree).
    const deps = makeDeps(
      [acct("a")],
      [used("a", 5)], // low local tally, NOT exhausted
      [signedInAs("a", "one@example.com")],
      [ceiling("a", CEIL)],
    );
    deps.getUsageLive = vi.fn(async () => liveUsage(97, 50)); // 97% real → spent (near limit, no wall)
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const banner = await screen.findByTestId("all-at-limit-banner");
    expect(banner.textContent).toContain("Your only signed-in account is near its limit");
    expect(banner.textContent).toContain("no hard wall yet");
    // The overstatement this fixes: no observed wall must not read as "at its limit" / a reset to wait on.
    expect(banner.textContent).not.toContain("at its limit");
    expect(banner.textContent).not.toContain("No reset time has been reported yet");
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
// ── `account-active-state-*` IS GONE, AND WHAT IT WAS PROTECTING IS NOT ──────────────────────────
// That line read "Active — new agents run here" / "Not taking new agents" / "Automatic — new agents
// may run here", and the tests below it are the scar tissue of three separate roborev findings
// (65216, 65221, 65223) — each one a case where the label contradicted something else on the same
// card. The founder read the survivor and could not tell what it meant: "when it says not taking new
// agents, I don't think I know what that means. Does it mean that it's not available to take new
// agents? Or that it's just not currently selected?… Let's just delete those two lines."
//
// He is describing the defect the three findings kept circling. The line was answering TWO questions
// in one three-way string — CAN this account receive an agent, and is it the one being routed to —
// and no single wording can do that without being false about one of them. They are now two separate
// unambiguous things in two places: the rotation dot at the top of the card answers the first, and
// the Manual Override / Back to automatic button answers the second by its own state.
//
// So these tests keep their SUBJECTS and change their SURFACE. Every "must not contradict" case
// below is re-aimed at the dot, and the override cases at the button — which is why they are
// rewritten rather than deleted.
describe("AccountsScreen — activation", () => {
  it("Manual Override records the account, and the button itself says which card holds it", async () => {
    const { deps, state } = routableDeps(
      [acct("a", { nickname: "Personal", isDefault: true }), acct("b", { nickname: "Work" })],
      [signedIn("a"), signedIn("b")],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    // Before: no card holds the override, so both offer to take it.
    const cardB = await screen.findByTestId("account-row-b");
    expect(within(cardB).getByText("Manual Override")).toBeTruthy();
    // The PRIMARY badge was removed — it must not exist in either state.
    expect(screen.queryByTestId("account-primary-badge-b")).toBeNull();

    fireEvent.click(within(cardB).getByText("Manual Override"));

    // The lever ran with the right account — and the SCREEN reflects it, which it can only do by
    // re-reading the preference the lever wrote.
    expect(deps.activateAccount).toHaveBeenCalledWith("b");
    expect(state.preferred).toBe("b");
    await waitFor(() =>
      expect(within(screen.getByTestId("account-row-b")).getByText("Back to automatic")).toBeTruthy(),
    );
    // …and ONLY that card. The other still offers the control rather than claiming anything.
    expect(within(screen.getByTestId("account-row-a")).getByText("Manual Override")).toBeTruthy();
    expect(screen.queryByTestId("account-primary-badge-b")).toBeNull();

    // THE HEADER STOPS CLAIMING PLAIN ROTATION. Two accounts are still in the pool, so the count is
    // honest — but every new agent is going to one of them, and a header that said only "Rotation
    // active: 2 accounts available" would be the count-contradicts-the-rows defect arriving from the
    // other direction.
    expect(screen.getByTestId("accounts-header").textContent).toContain(
      "Manual override: every new agent runs on",
    );
  });

  // ── THE DOT MUST NOT CONTRADICT THE LINE BELOW IT ───────────────────────────────────────────
  //
  // The founder screenshotted a card reading "Inactive" directly above "Running agents: Concierge"
  // and reported the state as a bug. The old label was about ROUTING and made a claim the next line
  // disproved. The dot is about the POOL, which is the question that has a stable answer — and this
  // asserts the two together on ONE card, the only arrangement that can catch a regression.
  it("a non-routed account that IS running agents does not read as out of rotation", async () => {
    const { deps, state } = routableDeps(
      [acct("a", { nickname: "Routed" }), acct("b", { nickname: "Busy" })],
      [signedIn("a"), signedIn("b")],
    );
    // "b" is NOT the routing target, but a live agent is running on it — the founder's exact shape.
    state.preferred = "a";
    state.panes = { agent1: "b" };
    state.names = { agent1: "Concierge" };
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    const card = await screen.findByTestId("account-row-b");
    // The card really is showing a running agent…
    expect(card.textContent).toContain("Concierge");
    // …so nothing on it may say the account is out of the pool. It is signed in and unique; the
    // override on the OTHER card is a routing fact, and the header is where that is stated.
    expect(screen.getByTestId("account-rotation-b").textContent).toMatch(/in rotation/);
    expect(screen.queryByTestId("account-rotation-reason-b")).toBeNull();
  });

  it("does not tell a lone auto-picked account it is out of rotation", async () => {
    // The sharpest case for the deleted label: one signed-in account receiving 100% of spawns, being
    // told it takes none. Whatever the dot says here, it cannot be "out of rotation".
    const { deps } = routableDeps([acct("solo", { nickname: "Only" })], [signedIn("solo")]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect((await screen.findByTestId("account-rotation-solo")).textContent).toMatch(/in rotation/);
    expect(screen.queryByTestId("account-rotation-reason-solo")).toBeNull();
  });

  it("an override on ANOTHER card does not take this one out of the pool", async () => {
    // The paired direction. An override is not an exclusion: `usablePreferredAccount` can drop the
    // preference on the very next spawn (exhausted, signed out), and rotation then falls back to
    // exactly this pool. Marking the other cards "out" would be false the moment that happened.
    const { deps } = routableDeps(
      [acct("a", { nickname: "Chosen" }), acct("b", { nickname: "Other" })],
      [signedIn("a"), signedIn("b")],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    fireEvent.click(within(await screen.findByTestId("account-row-a")).getByText("Manual Override"));
    await waitFor(() =>
      expect(within(screen.getByTestId("account-row-a")).getByText("Back to automatic")).toBeTruthy(),
    );
    expect(screen.getByTestId("account-rotation-b").textContent).toMatch(/in rotation/);
    expect(screen.getByTestId("rotation-headline").textContent).toBe(
      "Rotation active: 2 accounts available",
    );
  });

  // A SIGNED-OUT CARD CANNOT RECEIVE AGENTS AT ALL. `chooseAccountForAgent` filters both
  // `eligibleAccounts` and `autoPick` on `signedInIds`, and this same card renders "Not signed in —
  // this account cannot receive agents" (roborev 65221).
  it("marks a signed-OUT account out of rotation, agreeing with its own banner", async () => {
    const { deps } = routableDeps([acct("blocked", { nickname: "Dead" })], [neverLoggedIn("blocked")]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    // The card really is rendering the cannot-receive banner…
    expect(await screen.findByText(/Not signed in — this account cannot receive agents/)).toBeTruthy();
    // …and the dot above it agrees, in the founder's own two words.
    expect(screen.getByTestId("account-rotation-blocked").textContent).toMatch(/out of rotation/);
    expect(screen.getByTestId("account-rotation-reason-blocked").textContent).toBe("not signed in");
  });

  // A STORED PREFERENCE CAN OUTLIVE THE LOGIN IT POINTED AT. Nothing clears it when an account's
  // identity goes away — `handleActivate` checks eligibility at CLICK time only — and
  // `usablePreferredAccount` then drops that preference from routing. The card must not claim
  // anything the router has already discarded (roborev 65223).
  it("does not announce an override onto an account that is signed OUT", async () => {
    const { deps, state } = routableDeps([acct("blocked", { nickname: "Dead" })], [neverLoggedIn("blocked")]);
    state.preferred = "blocked"; // the preference survived; the login did not
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    expect(await screen.findByText(/Not signed in — this account cannot receive agents/)).toBeTruthy();
    expect(screen.getByTestId("account-rotation-blocked").textContent).toMatch(/out of rotation/);
    // The header applies the SAME gate the spawn path does, so it does not announce an override that
    // is not in force. Without this the loudest line on the screen would be the wrong one.
    expect(screen.getByTestId("accounts-header").textContent).not.toContain("Manual override");
  });

  it("the rotation dot and the default tag are distinct (neither stands in for the other)", async () => {
    const { deps } = routableDeps([acct("a", { nickname: "Personal", isDefault: true })], [signedIn("a")]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    fireEvent.click(within(await screen.findByTestId("account-row-a")).getByText("Manual Override"));
    // Both render, so neither is standing in for the other — the confusion the removed "primary"
    // badge used to cause with an exhausted default.
    await waitFor(() => expect(screen.getByText("Back to automatic")).toBeTruthy());
    expect(screen.getByTestId("account-rotation-a").textContent).toMatch(/in rotation/);
    expect(screen.getByText("default")).toBeTruthy();
  });

  it("back to automatic clears the preference", async () => {
    const { deps, state } = routableDeps([acct("a", { nickname: "Personal" })], [signedIn("a")]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    fireEvent.click(within(await screen.findByTestId("account-row-a")).getByText("Manual Override"));
    fireEvent.click(await screen.findByText("Back to automatic"));

    expect(state.preferred).toBeUndefined();
    // The control returns to offering the override, and the header stops announcing one — asserted
    // on the SCREEN rather than only on the state, since a lever that writes correctly while the UI
    // keeps showing the old answer is the failure this pair exists to catch.
    await waitFor(() => expect(screen.getByText("Manual Override")).toBeTruthy());
    expect(screen.getByTestId("accounts-header").textContent).not.toContain("Manual override");
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

  it("renders nothing at all for an account with nothing running on it", async () => {
    // "Nothing is running on this account right now." went with the routing label above it — the
    // founder named both in the same breath ("let's just delete those two lines"). An empty list
    // rendering as nothing says the same thing without a line, and this is the paired negative for
    // the running-agents tests above: without it, "renders the list" could be satisfied by a
    // component that renders the list AND a sentence contradicting it.
    const { deps } = routableDeps([acct("a", { nickname: "Personal" })], [signedIn("a")]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const routing = await screen.findByTestId("account-routing-a");
    expect(routing.textContent).not.toContain("Nothing is running");
    expect(routing.textContent).not.toContain("Running agents");
    expect(routing.textContent?.trim()).toBe("");
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
    // The override really did land on `b` — without waiting for that, the assertions below would
    // describe a screen where nothing happened yet and pass for the wrong reason.
    await waitFor(() =>
      expect(within(screen.getByTestId("account-row-b")).getByText("Back to automatic")).toBeTruthy(),
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

// ── FIX A: the displayed email LIVE-REFRESHES off the dir's current .claude.json ─────────────────
//
// The email a card shows is read from `identities`, which was written ONLY by `refresh()` (mount /
// add / rename / remove / login). A login that swaps a dir's `.claude.json` from OUTSIDE this screen
// — a terminal `claude login`, an automatic rotation/failover, an expiry-and-reauth — reaches none
// of those, so the row kept showing the PREVIOUS account's email indefinitely. A slow poll re-reads
// identities so the shown email tracks the dir's CURRENT login. Fake timers drive the poll boundary.
describe("displayed email live-refreshes off the dir's current .claude.json (FIX A)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  // Advance fake time by `ms` and let the injected promises (getIdentities et al.) settle, all inside
  // act() so the resulting React state writes are flushed before we assert.
  async function settle(ms = 0) {
    await act(async () => {
      vi.advanceTimersByTime(ms);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("the poll re-reads identities so a login swapped from OUTSIDE the pane updates the shown email", async () => {
    // `current` stands in for what each dir's `.claude.json` resolves to right now. It changes with
    // NO gesture on the pane — the whole point of the fix.
    let current: Identity[] = [
      { id: "a", email: "old@x.com", organization: null, accountUuid: "u1" },
    ];
    const deps = makeDeps([acct("a", { nickname: "A" })], []);
    deps.getIdentities = vi.fn(async () => current);

    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    await settle();
    // The mount read shows the original login's email.
    expect(screen.getByText("old@x.com")).toBeTruthy();

    // The login behind the dir is replaced from outside this screen — no add/rename/remove/login.
    current = [{ id: "a", email: "new@x.com", organization: null, accountUuid: "u2" }];

    // Just SHORT of the poll interval: nothing has re-read, so the stale email still stands. This is
    // what makes the next step's update attributable to the POLL rather than an incidental re-render.
    await settle(IDENTITY_REFRESH_MS - 1000);
    expect(screen.getByText("old@x.com")).toBeTruthy();

    // Cross the poll boundary → the row now reflects the dir's CURRENT login, with no user gesture.
    await settle(2000);
    expect(screen.getByText("new@x.com")).toBeTruthy();
    expect(screen.queryByText("old@x.com")).toBeNull();
  });
});

// ── FIX B: a failed "Check usage levels" is ROUTED FROM THE ACTUAL CAUSE ──────────────────────────
//
// The three tests share one signed-in fixture and one gesture; only the CAUSE differs, and each
// asserts BOTH its own message AND the absence of the other two — so a handler that hard-coded any
// single message (the pre-fix behaviour, which said "sign in again" for every failure) fails the
// other two. That is the paired, mutation-proof shape: the assertion cannot pass against a screen
// that renders one outcome unconditionally.
describe("Check usage failure is routed from the actual cause (FIX B)", () => {
  const identityA: Identity = { id: "a", email: "a@x.com", organization: null, accountUuid: "ua" };

  it("EXHAUSTED: a signed-in but rate-limited account shows 'Exhausted until …', never 'sign in again'", async () => {
    // exhaustedUntil is read against Date.now() (ms) on the frontend, so a future ms value is a live
    // wall. The forced fetch fails with a 429 — but the account is signed in and healthy, so the
    // remedy must NOT be "sign in again".
    const future = Date.now() + 60 * 60 * 1000;
    const usage: Usage[] = [{ id: "a", tokens5h: 1, tokens7d: 1, exhaustedUntil: future }];
    const deps = makeDeps([acct("a", { nickname: "A" })], usage, [identityA]);
    deps.getUsageLiveForced = vi.fn(async () => {
      throw new Error("usage fetch failed: HTTP 429 Too Many Requests");
    });
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    fireEvent.click(within(await openKebab("a")).getByText("Check usage levels"));

    const note = await screen.findByTestId("account-usage-exhausted-note-a");
    expect(note.textContent).toContain("Exhausted until");
    expect(note.textContent).not.toContain("sign in again");
    // A calm status, not the amber signed-out/transient alert.
    expect(note.getAttribute("role")).toBe("status");
    expect(screen.queryByTestId("account-usage-error-a")).toBeNull();
  });

  it("SIGNED-OUT: a proven-dead login (terminal 401) shows the 'sign in again' remedy", async () => {
    const deps = makeDeps([acct("a", { nickname: "A" })], [], [identityA]);
    // The exact terminal-401 string the Rust side returns after dropping the cache and re-reading.
    deps.getUsageLiveForced = vi.fn(async () => {
      throw new Error("usage fetch failed: unauthorized after keychain re-read");
    });
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    fireEvent.click(within(await openKebab("a")).getByText("Check usage levels"));

    const err = await screen.findByTestId("account-usage-error-a");
    expect(err.textContent).toContain("signed out");
    expect(err.textContent).toContain("Sign in again");
    expect(err.getAttribute("role")).toBe("alert");
    expect(screen.queryByTestId("account-usage-exhausted-note-a")).toBeNull();
  });

  it("TRANSIENT: a network failure on a signed-in, non-exhausted account says 'try again', not 'sign in again'", async () => {
    const deps = makeDeps([acct("a", { nickname: "A" })], [], [identityA]);
    deps.getUsageLiveForced = vi.fn(async () => {
      throw new Error("usage fetch failed: connection timed out");
    });
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    fireEvent.click(within(await openKebab("a")).getByText("Check usage levels"));

    const err = await screen.findByTestId("account-usage-error-a");
    expect(err.textContent).toContain("Try again");
    expect(err.textContent?.toLowerCase()).not.toContain("sign in again");
    expect(err.getAttribute("role")).toBe("alert");
    expect(screen.queryByTestId("account-usage-exhausted-note-a")).toBeNull();
  });
});
