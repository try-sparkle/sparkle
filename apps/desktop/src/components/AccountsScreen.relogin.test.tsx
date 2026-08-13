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
}) {
  const slotA = acct("slotA", { nickname: "Work" });
  const accounts: Account[] = [slotA, ...(opts.others ?? []).map((o) => o.account)];
  const identities: Identity[] = [
    { id: "slotA", email: "work@example.com", organization: null, accountUuid: "u-work" },
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

/** Click "Switch login" on slot A's row specifically (other rows carry the same label). */
async function reloginSlotA() {
  const row = await screen.findByTestId("account-row-slotA");
  fireEvent.click(within(row).getByText("Switch login"));
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
