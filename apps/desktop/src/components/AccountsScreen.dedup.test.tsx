// @vitest-environment jsdom
//
// Identity-keyed reconciliation on "Add account". `claude auth login` grants whatever identity the
// browser is signed into at claude.ai (no forced account selection), so "Add account" routinely
// resolves to a login the user ALREADY has. The rule under test is one identity = one account: a
// fresh slot that shares a login with a pre-existing account is silently discarded, with a message
// naming the account it already is; a fresh slot that resolves to a NEW distinct identity is kept.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountsScreen, type AccountsDeps } from "./AccountsScreen";
import type { Account, Identity } from "../services/accountStore";

afterEach(() => cleanup());

function acct(id: string, over: Partial<Account> = {}): Account {
  return { id, nickname: id, configDir: `/cfg/${id}`, isDefault: false, createdAt: 0, ...over };
}

/** A deps harness that models the real login sequence: the new slot's identity does not exist until
 *  `onLogin` settles, at which point `onLoginEffect` pushes whatever the browser signed in as. Starts
 *  with one PRE-EXISTING signed-in account so the duplicate case has something to collide with. */
function harness(onLoginEffect: (ids: Identity[], newId: string) => void) {
  const accounts: Account[] = [acct("existing", { nickname: "Personal" })];
  const identities: Identity[] = [
    { id: "existing", email: "personal@example.com", organization: null, accountUuid: "u-personal" },
  ];
  const removeAccount = vi.fn(async (id: string) => {
    const i = accounts.findIndex((a) => a.id === id);
    if (i >= 0) accounts.splice(i, 1);
  });
  // Partial<AccountsDeps>: the component merges `{ ...DEPS, ...deps }`, so we override only what this
  // flow touches. Typed Partial so a field ADDED to AccountsDeps later cannot break this build — the
  // exact churn that made the first cut of this test go stale. The routing readers below default to
  // "nothing activated/pinned" so the mount renders without reaching the real Tauri bridge.
  const deps: Partial<AccountsDeps> = {
    listAccounts: vi.fn(async () => [...accounts]),
    getUsage: vi.fn(async () => []),
    getIdentities: vi.fn(async () => [...identities]),
    listCeilings: vi.fn(async () => []),
    getUsageLive: vi.fn(async () => {
      throw new Error("live usage unavailable in test");
    }),
    addAccount: vi.fn(async (nickname: string) => {
      const a = acct("new", { nickname });
      accounts.push(a);
      return a;
    }),
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
  const onLogin = vi.fn(async () => onLoginEffect(identities, "new"));
  return { deps, onLogin, removeAccount };
}

async function addAccountNamed(name: string) {
  fireEvent.click(await screen.findByText("+ Add account"));
  fireEvent.change(screen.getByLabelText("New account nickname"), { target: { value: name } });
  fireEvent.click(screen.getByText("Create & log in"));
}

describe("AccountsScreen — identity-keyed add reconciliation", () => {
  it("discards the redundant slot when the login resolves to an account you already have", async () => {
    // The browser is signed into the SAME identity the user already has → the new slot duplicates it.
    const { deps, onLogin, removeAccount } = harness((ids, newId) =>
      ids.push({ id: newId, email: "personal@example.com", organization: null, accountUuid: "u-personal" }),
    );
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    await addAccountNamed("Second Personal");

    // The SIDE EFFECT: the redundant new slot is removed (never happens without the reconciliation).
    await waitFor(() => expect(removeAccount).toHaveBeenCalledWith("new"));
    // And the message names the existing account it already is.
    const msg = await screen.findByText(/already signed in to this account as/);
    expect(msg.textContent).toContain("Personal");
  });

  it("keeps the slot when the login resolves to a NEW distinct identity", async () => {
    // The browser is signed into a DIFFERENT account → a genuinely new identity, which must be kept.
    const { deps, onLogin, removeAccount } = harness((ids, newId) =>
      ids.push({ id: newId, email: "other@example.com", organization: null, accountUuid: "u-other" }),
    );
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    await addAccountNamed("Gmail");

    await waitFor(() => expect(deps.addAccount).toHaveBeenCalledWith("Gmail"));
    // A distinct identity is not a duplicate — the slot stays, nothing is removed.
    expect(removeAccount).not.toHaveBeenCalled();
  });
});
