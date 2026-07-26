// @vitest-environment jsdom
//
// Interaction tests for the Accounts settings screen: load/list, add → onLogin seam, inline
// rename, and the two-step remove confirm (default guarded). IO is injected via the `deps` prop.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountsScreen, type AccountsDeps } from "./AccountsScreen";
import type { Account, Usage, Identity } from "../services/accountStore";

afterEach(() => cleanup());

function acct(id: string, over: Partial<Account> = {}): Account {
  return { id, nickname: id, configDir: `/cfg/${id}`, isDefault: false, createdAt: 0, ...over };
}

function makeDeps(accounts: Account[], usage: Usage[] = [], identities: Identity[] = []): AccountsDeps {
  return {
    listAccounts: vi.fn(async () => accounts),
    getUsage: vi.fn(async () => usage),
    getIdentities: vi.fn(async () => identities),
    addAccount: vi.fn(async (nickname: string) => acct("new", { nickname })),
    setNickname: vi.fn(async () => {}),
    removeAccount: vi.fn(async () => {}),
  };
}

describe("AccountsScreen", () => {
  it("lists accounts with nickname, default tag, and usage bars", async () => {
    const deps = makeDeps(
      [acct("a", { nickname: "Personal", isDefault: true }), acct("b", { nickname: "Work" })],
      [{ id: "a", tokens5h: 0, tokens7d: 0, exhaustedUntil: null }],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect(await screen.findByText("Personal")).toBeTruthy();
    expect(screen.getByText("Work")).toBeTruthy();
    expect(screen.getByText("default")).toBeTruthy();
    // Two windows per account × two accounts = 4 progressbars.
    expect(screen.getAllByRole("progressbar")).toHaveLength(4);
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

  it("inline rename calls setNickname exactly once on Enter (no blur double-commit)", async () => {
    const deps = makeDeps([acct("a", { nickname: "Old" })]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    fireEvent.click(await screen.findByText("Rename"));
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
    fireEvent.click(await screen.findByText("Rename"));
    const input = screen.getByLabelText("Rename Old");
    fireEvent.change(input, { target: { value: "Cancelled" } });
    fireEvent.keyDown(input, { key: "Escape" });
    // The blur the unmount would trigger must not commit the discarded draft.
    fireEvent.blur(input);
    // The edit is discarded: original name is shown again and setNickname never ran.
    expect(await screen.findByText("Old")).toBeTruthy();
    expect(deps.setNickname).not.toHaveBeenCalled();
  });

  it("does not offer Remove on the default account", async () => {
    const deps = makeDeps([acct("a", { nickname: "Default", isDefault: true })]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    await screen.findByText("Default");
    expect(screen.queryByText("Remove")).toBeNull();
  });

  it("Remove requires a confirm step", async () => {
    const deps = makeDeps([acct("a", { nickname: "Removable" })]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    fireEvent.click(await screen.findByText("Remove"));
    expect(deps.removeAccount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Confirm remove"));
    await waitFor(() => expect(deps.removeAccount).toHaveBeenCalledWith("a"));
  });

  it("shows the REAL authenticated email as the primary label, nickname as a secondary alias", async () => {
    const deps = makeDeps(
      [acct("a", { nickname: "DROdio Gmail", isDefault: true })],
      [],
      [{ id: "a", email: "drodio@storytell.ai", organization: "drodio@storytell.ai's Organization", accountUuid: null }],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    // The trustworthy identity (email + org) is surfaced...
    expect(await screen.findByText("drodio@storytell.ai")).toBeTruthy();
    expect(screen.getByText("drodio@storytell.ai's Organization")).toBeTruthy();
    // ...and the user-typed nickname is demoted to a secondary alias line, not the headline.
    expect(screen.getByText("alias: DROdio Gmail")).toBeTruthy();
  });

  it("falls back to the nickname and flags 'Not signed in' for an account with no identity", async () => {
    const deps = makeDeps(
      [acct("a", { nickname: "DROdio Chief" })],
      [],
      [{ id: "a", email: null, organization: null, accountUuid: null }],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect(await screen.findByText("DROdio Chief")).toBeTruthy();
    expect(screen.getByText("Not signed in")).toBeTruthy();
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
    expect(await screen.findByText("One")).toBeTruthy();
    expect(screen.queryByText(/are the same Claude login/i)).toBeNull();
  });
});

describe("log in / switch login on an EXISTING account", () => {
  // Before this, onLogin fired only at account-CREATION time, so an account that was never signed
  // into — or two that turned out to hold the same login — had no route to a fix but delete and
  // recreate. Re-logging one of a duplicate pair into a different Claude account IS the remedy.
  it("offers 'Log in' for an account with no identity", async () => {
    const onLogin = vi.fn();
    const deps = makeDeps([acct("a", { nickname: "Third" })], [], [
      { id: "a", email: null, organization: null, accountUuid: null },
    ]);
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    const btn = await screen.findByRole("button", { name: "Log in" });
    fireEvent.click(btn);
    expect(onLogin).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("offers 'Switch login' for an account that IS signed in", async () => {
    const onLogin = vi.fn();
    const deps = makeDeps([acct("a", { nickname: "Gmail" })], [], [
      { id: "a", email: "drodio@gmail.com", organization: null, accountUuid: "u1" },
    ]);
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    const btn = await screen.findByRole("button", { name: "Switch login" });
    fireEvent.click(btn);
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
    fireEvent.click(await screen.findByRole("button", { name: "Switch login" }));
    fireEvent.click(screen.getByRole("button", { name: "Change system-wide login" }));
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

    fireEvent.click(await screen.findByRole("button", { name: "Switch login" }));
    expect(onLogin).not.toHaveBeenCalled(); // first click only arms the confirm

    const confirm = screen.getByRole("button", { name: "Change system-wide login" });
    fireEvent.click(confirm);
    expect(onLogin).toHaveBeenCalledOnce();
  });

  it("the confirm can be cancelled without logging in", async () => {
    const onLogin = vi.fn();
    const deps = makeDeps([acct("a", { nickname: "Default", isDefault: true })], [], [
      { id: "a", email: "drodio@gmail.com", organization: null, accountUuid: "u1" },
    ]);
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    fireEvent.click(await screen.findByRole("button", { name: "Switch login" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onLogin).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Switch login" })).toBeTruthy();
  });

  it("a NON-default account still logs in with one click", async () => {
    const onLogin = vi.fn();
    const deps = makeDeps([acct("a", { nickname: "Second" })], [], [
      { id: "a", email: "drodio@gmail.com", organization: null, accountUuid: "u1" },
    ]);
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    fireEvent.click(await screen.findByRole("button", { name: "Switch login" }));
    expect(onLogin).toHaveBeenCalledOnce();
  });

  it("treats an identity with a uuid but no email as signed in", async () => {
    // All three affordances (label, tooltip, 'Not signed in' badge) must agree — keying on email
    // alone would claim a signed-in account isn't, while tinting it as a duplicate.
    const deps = makeDeps([acct("a", { nickname: "Nick" })], [], [
      { id: "a", email: null, organization: null, accountUuid: "u1" },
    ]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect(await screen.findByRole("button", { name: "Switch login" })).toBeTruthy();
    expect(screen.queryByText("Not signed in")).toBeNull();
  });
});
