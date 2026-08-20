// @vitest-environment jsdom
//
// Identity-keyed reconciliation on RE-LOGIN (the twin of AccountsScreen.dedup.test.tsx, which covers
// the ADD path). `claude auth login` grants whatever identity the browser is signed into at
// claude.ai — no forced account selection — so re-authing an EXISTING slot while the browser is on a
// different identity silently overwrites that slot's login. The rule under test: a re-login can
// never SILENTLY duplicate or lose an account.
//   • re-login resolves the SAME identity  → normal, no warning (the legit "token expired" case);
//   • re-login resolves an identity ANOTHER slot holds → loud duplicate-via-relogin warning;
//   • re-login resolves a NEW identity no slot holds → loud "the old account is gone" warning.
// Unlike the add path, slot A is NEVER auto-deleted — the user acted on it deliberately.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountsScreen, type AccountsDeps } from "./AccountsScreen";
import type { Account, Identity } from "../services/accountStore";

afterEach(() => cleanup());

function acct(id: string, over: Partial<Account> = {}): Account {
  return { id, nickname: id, configDir: `/cfg/${id}`, isDefault: false, createdAt: 0, ...over };
}

/** Replace (or insert) the identity recorded for `id` — models `claude auth login` writing whatever
 *  the browser resolved into that account's config dir. */
function setIdentity(ids: Identity[], id: string, over: Partial<Identity>) {
  const next: Identity = { id, email: null, organization: null, accountUuid: null, ...over };
  const i = ids.findIndex((x) => x.id === id);
  if (i >= 0) ids[i] = next;
  else ids.push(next);
}

/** Harness modelling a re-login. `slotA` starts signed into identity X. Extra accounts (e.g. a
 *  second slot already holding Y, for the duplicate case) are supplied via `others`. `onLoginEffect`
 *  runs when the login window closes and mutates the identities array — that is the ONLY moment the
 *  new identity becomes visible, exactly as the real re-read-after-login sequence sees it. */
function harness(opts: {
  others?: { account: Account; identity: Identity }[];
  onLoginEffect: (ids: Identity[]) => void;
  /** Override slot A's STARTING identity (e.g. to give it a known organization). */
  slotAOver?: Partial<Identity>;
}) {
  const slotA = acct("slotA", { nickname: "Work" });
  const accounts: Account[] = [slotA, ...(opts.others ?? []).map((o) => o.account)];
  const identities: Identity[] = [
    { id: "slotA", email: "work@example.com", organization: null, accountUuid: "u-work", ...opts.slotAOver },
    ...(opts.others ?? []).map((o) => o.identity),
  ];
  const removeAccount = vi.fn(async (id: string) => {
    const i = accounts.findIndex((a) => a.id === id);
    if (i >= 0) accounts.splice(i, 1);
  });
  // Partial<AccountsDeps>: the component merges `{ ...DEPS, ...deps }`, so we override only what this
  // flow touches. Typed Partial so a field ADDED to AccountsDeps later cannot break this build.
  const deps: Partial<AccountsDeps> = {
    listAccounts: vi.fn(async () => [...accounts]),
    getUsage: vi.fn(async () => []),
    getIdentities: vi.fn(async () => identities.map((i) => ({ ...i }))),
    listCeilings: vi.fn(async () => []),
    getUsageLive: vi.fn(async () => {
      throw new Error("live usage unavailable in test");
    }),
    addAccount: vi.fn(async (nickname: string) => acct("unused", { nickname })),
    setNickname: vi.fn(async () => {}),
    removeAccount,
    readSpawnLog: vi.fn(async () => []),
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
  const onLogin = vi.fn(async () => opts.onLoginEffect(identities));
  return { deps, onLogin, removeAccount };
}

/** Open slot A's ⋮ kebab and click its "Switch login" item (the control moved into the kebab). */
async function reloginSlotA() {
  fireEvent.click(await screen.findByTestId("account-menu-button-slotA"));
  const menu = await screen.findByTestId("account-menu-slotA");
  fireEvent.click(within(menu).getByText("Switch login"));
}

describe("AccountsScreen — identity-keyed re-login reconciliation", () => {
  it("SAME identity re-login → no warning (the legit 'token expired, re-auth' case)", async () => {
    // The browser is still signed into slot A's own identity X — a plain token refresh.
    const { deps, onLogin, removeAccount } = harness({
      onLoginEffect: (ids) =>
        setIdentity(ids, "slotA", { email: "work@example.com", accountUuid: "u-work" }),
    });
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    await reloginSlotA();

    // The login ran and re-read, but nothing changed → no alert, and slot A is untouched.
    await waitFor(() => expect(onLogin).toHaveBeenCalled());
    await waitFor(() => expect(deps.getIdentities).toHaveBeenCalledTimes(3)); // mount + refresh + re-read
    expect(removeAccount).not.toHaveBeenCalled();
    expect(screen.queryByText(/no longer in your accounts/)).toBeNull();
    expect(screen.queryByText(/Switch your browser to the account you meant/)).toBeNull();
  });

  it("a token refresh that reads a NULL org does NOT false-alarm (the O1 group-collapse scenario)", async () => {
    // THE scenario the org-blind revert exists to protect, and the one a membership-delta heuristic
    // gets wrong: slot A holds "Amforge Team" and slot B holds "Amforge (Personal)" under ONE uuid, so
    // `duplicateAccountGroups` SPLITS them (two known orgs → two singletons → not a duplicate). An
    // ordinary token refresh on A that reads `organization: null` collapses `knownOrgs` to 1, which
    // makes the group WHOLE again → a `becameNewDuplicate` membership-delta clause (the reverted
    // round-6 heuristic) reads that as a new duplicate and fires the false "Switch your browser to the
    // account you meant" alarm on an account that did not change. Org-blind Case 1 (key equality)
    // stays silent, as it must. Re-add the `becameNewDuplicate` clause and this goes RED — the guard
    // the prose comment claims, now enforced.
    const { deps, onLogin, removeAccount } = harness({
      slotAOver: { organization: "Amforge Team" },
      others: [
        {
          account: acct("slotB", { nickname: "Personal" }),
          identity: {
            id: "slotB",
            email: "work@example.com",
            organization: "Amforge (Personal)",
            accountUuid: "u-work",
          },
        },
      ],
      onLoginEffect: (ids) =>
        setIdentity(ids, "slotA", {
          email: "work@example.com",
          accountUuid: "u-work",
          organization: null, // the collapse: A's org read goes unknown on a routine refresh
        }),
    });
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    await reloginSlotA();

    await waitFor(() => expect(onLogin).toHaveBeenCalled());
    await waitFor(() => expect(deps.getIdentities).toHaveBeenCalledTimes(3));
    expect(screen.queryByText(/Switch your browser to the account you meant/)).toBeNull();
    expect(screen.queryByText(/no longer in your accounts/)).toBeNull();
    expect(removeAccount).not.toHaveBeenCalled();
  });

  it("an org RENAME on a token refresh never false-alarms — Case 1 is org-blind on the key", async () => {
    // The ordinary case org-blindness protects: slot A is the SAME account across the re-login (same
    // email + uuid), and only its `organizationName` changed — an org rename in the Anthropic console
    // that this dir's cache had not yet picked up. `organizationName` is a mutable display string, so
    // gating Case 1 on `accountsAreSame` would read the rename as a different account and fire the
    // "your account is no longer in your accounts, re-add it" alarm (whose remedy creates a duplicate).
    // Org-blind Case 1 swallows it silently, as it must. Swap line 970 back to `accountsAreSame` and
    // this goes red — the guarantee the code comment claims, now enforced.
    const { deps, onLogin, removeAccount } = harness({
      slotAOver: { organization: "Amforge Team" },
      onLoginEffect: (ids) =>
        setIdentity(ids, "slotA", {
          email: "work@example.com",
          accountUuid: "u-work",
          organization: "Amforge Corp", // a rename of the SAME account, not a different one
        }),
    });
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    await reloginSlotA();

    await waitFor(() => expect(onLogin).toHaveBeenCalled());
    await waitFor(() => expect(deps.getIdentities).toHaveBeenCalledTimes(3));
    expect(screen.queryByText(/no longer in your accounts/)).toBeNull();
    expect(screen.queryByText(/Switch your browser to the account you meant/)).toBeNull();
    expect(removeAccount).not.toHaveBeenCalled();
  });

  it("re-login to an identity ANOTHER slot holds → loud duplicate warning, slot NOT deleted", async () => {
    // A second slot "Personal" already holds identity Y; the browser was signed into Y, so re-authing
    // slot A points it at Y too → two slots, one login.
    const { deps, onLogin, removeAccount } = harness({
      others: [
        {
          account: acct("slotB", { nickname: "Personal" }),
          identity: {
            id: "slotB",
            email: "personal@example.com",
            organization: null,
            accountUuid: "u-personal",
          },
        },
      ],
      onLoginEffect: (ids) =>
        setIdentity(ids, "slotA", { email: "personal@example.com", accountUuid: "u-personal" }),
    });
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    await reloginSlotA();

    // SIDE EFFECT: a loud, actionable message naming the slot Y already is.
    const msg = await screen.findByText(/Switch your browser to the account you meant/);
    expect(msg.textContent).toContain("Personal");
    expect(msg.textContent).toContain("personal@example.com");
    // The user acted on slot A deliberately — it is never auto-deleted (unlike the add path).
    expect(removeAccount).not.toHaveBeenCalled();
  });

  it("re-login to a NEW identity no slot holds → loud 'account lost' warning", async () => {
    // The browser was signed into a DIFFERENT account Y that no slot holds. slot A's old identity X
    // just vanished from the account set; that must be surfaced, not silently swallowed.
    const { deps, onLogin, removeAccount } = harness({
      onLoginEffect: (ids) =>
        setIdentity(ids, "slotA", { email: "gmail@example.com", accountUuid: "u-gmail" }),
    });
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    await reloginSlotA();

    // SIDE EFFECT: the warning names the OLD identity X (now gone) and the NEW one Y.
    const msg = await screen.findByText(/no longer in your accounts/);
    expect(msg.textContent).toContain("work@example.com"); // X — the lost account
    expect(msg.textContent).toContain("gmail@example.com"); // Y — what it is now
    // Nothing is duplicated (no other slot holds Y) and nothing is deleted.
    expect(removeAccount).not.toHaveBeenCalled();
    expect(screen.queryByText(/Switch your browser to the account you meant/)).toBeNull();
  });
});
