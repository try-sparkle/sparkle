// @vitest-environment jsdom
//
// The MANUAL "switch all agents here" button on each account row. It re-uses the existing
// safe-boundary switch engine via a request that the app-wide host drives; this suite pins the ROW
// behaviour — that clicking through the confirm invokes the trigger with the RIGHT account id (the
// side effect), and that the button is withheld exactly where switching makes no sense (a
// login-less account, and the account the fleet is already on).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountsScreen, type AccountsDeps } from "./AccountsScreen";
import type { Account, Usage, Identity } from "../services/accountStore";
import type { Ceiling } from "../services/headroom";

afterEach(() => cleanup());

function acct(id: string, over: Partial<Account> = {}): Account {
  return { id, nickname: id, configDir: `/cfg/${id}`, isDefault: false, createdAt: 0, ...over };
}

/** A signed-in identity (has an accountUuid) — neutral placeholders only, never a real login. */
function signedIn(id: string): Identity {
  return { id, email: `${id}@example.test`, organization: null, accountUuid: `uuid-${id}` };
}

function makeDeps(
  accounts: Account[],
  identities: Identity[],
  requestSwitchAll: (accountId: string) => void,
  usage: Usage[] = [],
  ceilings: Ceiling[] = [],
): AccountsDeps {
  return {
    listAccounts: vi.fn(async () => accounts),
    getUsage: vi.fn(async () => usage),
    getIdentities: vi.fn(async () => identities),
    listCeilings: vi.fn(async () => ceilings),
    getUsageLive: vi.fn(async () => {
      throw new Error("live usage unavailable in test");
    }),
    addAccount: vi.fn(async (nickname: string) => acct("new", { nickname })),
    setNickname: vi.fn(async () => {}),
    removeAccount: vi.fn(async () => {}),
    readSpawnLog: vi.fn(async () => []),
    requestSwitchAll: vi.fn(requestSwitchAll),
  };
}

describe("AccountsScreen — Switch all agents here", () => {
  it("clicking through the confirm invokes the trigger with THAT account's id", async () => {
    const spy = vi.fn();
    const deps = makeDeps(
      [acct("personal"), acct("work")],
      [signedIn("personal"), signedIn("work")],
      spy,
    );
    // No currentAccountId → both signed-in rows offer the button.
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    // First click arms the two-step confirm; the trigger must NOT fire yet.
    const btn = await screen.findByTestId("switch-all-work");
    fireEvent.click(btn);
    expect(spy).not.toHaveBeenCalled();

    // Confirm actually fires it — with "work", the row's id, not the other account.
    fireEvent.click(screen.getByTestId("switch-all-confirm-work"));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("work");

    // And the row now reports the switch is underway (the in-progress side effect on the row).
    expect(screen.getByTestId("switching-all-work")).toBeTruthy();
  });

  it("does NOT fire the trigger on the first (arming) click — confirm is required", async () => {
    const spy = vi.fn();
    const deps = makeDeps([acct("work")], [signedIn("work")], spy);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    fireEvent.click(await screen.findByTestId("switch-all-work"));
    // The confirm button exists but the destructive trigger has not run.
    expect(screen.getByTestId("switch-all-confirm-work")).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  it("withholds the button for an account that is NOT signed in", async () => {
    const spy = vi.fn();
    // `personal` is signed in; `nologin` has no identity, so it cannot receive agents.
    const deps = makeDeps(
      [acct("personal"), acct("nologin")],
      [signedIn("personal")],
      spy,
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);

    // The signed-in row has the button…
    expect(await screen.findByTestId("switch-all-personal")).toBeTruthy();
    // …the login-less row does not (it shows the "Finish sign-in" block instead).
    expect(screen.queryByTestId("switch-all-nologin")).toBeNull();
    expect(screen.getByTestId("account-blocked-nologin")).toBeTruthy();
  });

  it("withholds the button on the account the fleet is ALREADY on", async () => {
    const spy = vi.fn();
    const deps = makeDeps(
      [acct("personal"), acct("work")],
      [signedIn("personal"), signedIn("work")],
      spy,
    );
    // The fleet is on `personal` → switching to it is a no-op, so its row omits the button while the
    // other signed-in account still offers it.
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} currentAccountId="personal" />);

    expect(await screen.findByTestId("switch-all-work")).toBeTruthy();
    expect(screen.queryByTestId("switch-all-personal")).toBeNull();
  });
});
