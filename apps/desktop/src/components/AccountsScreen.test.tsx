// @vitest-environment jsdom
//
// Interaction tests for the Accounts settings screen: load/list, add → onLogin seam, inline
// rename, and the two-step remove confirm (default guarded). IO is injected via the `deps` prop.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountsScreen, SIGNED_IN_NO_EMAIL, type AccountsDeps } from "./AccountsScreen";
import { NOT_SIGNED_IN, type Account, type Usage, type Identity } from "../services/accountStore";

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
    // No identities were supplied, so neither account is signed in — the nickname appears only on
    // the secondary alias line, never in the identity slot (see the identity-slot suite below).
    expect(await screen.findByText("alias: Personal")).toBeTruthy();
    expect(screen.getByText("alias: Work")).toBeTruthy();
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
    const deps: AccountsDeps = {
      listAccounts: vi.fn(async () => [...accounts]),
      getUsage: vi.fn(async () => []),
      getIdentities: vi.fn(async () => [...identities]),
      addAccount: vi.fn(async (nickname: string) => {
        // Distinct ids so the multi-add case renders distinct rows, the way real ones do.
        const a = acct(`acct-${accounts.length}`, { nickname });
        accounts.push(a);
        return a;
      }),
      setNickname: vi.fn(async () => {}),
      removeAccount: vi.fn(async () => {}),
    };
    let readsAtLoginStart = -1;
    const onLogin = vi.fn(async () => {
      readsAtLoginStart = vi.mocked(deps.getIdentities).mock.calls.length;
      onLoginEffect(identities);
    });
    return { deps, onLogin, readsAtLoginStart: () => readsAtLoginStart };
  }

  async function addAccountNamed(name: string) {
    fireEvent.click(await screen.findByText("+ Add account"));
    fireEvent.change(screen.getByLabelText("New account nickname"), { target: { value: name } });
    fireEvent.click(screen.getByText("Create & log in"));
  }

  it("re-reads identities after the login window closes and shows the email signed in as", async () => {
    const { deps, onLogin, readsAtLoginStart } = store((ids) =>
      ids.push({ id: "acct-0", email: "drodio@gmail.com", organization: null, accountUuid: "u5" }),
    );
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    await addAccountNamed("Cloud Max");

    // The resolved EMAIL, not the nickname the user typed. Unreachable without a read that
    // happens after the login attempt ends — the identity did not exist before then.
    const slot = await screen.findByTestId("account-identity-acct-0");
    expect(slot.textContent).toBe("drodio@gmail.com");
    expect(screen.getByText("alias: Cloud Max")).toBeTruthy();
    // And that read is strictly AFTER onLogin started, not one of the earlier two.
    expect(vi.mocked(deps.getIdentities).mock.calls.length).toBeGreaterThan(readsAtLoginStart());
  });

  it("leaves the account visibly NOT signed in when the login resolves no identity", async () => {
    // The failure state has to look like failure. This is exactly the founder's `602064ad` account:
    // a config dir that exists with no `oauthAccount` in it. A closed window is not a sign-in.
    const { deps, onLogin } = store(() => {
      /* login window closed, nothing was written — the OAuth never completed */
    });
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    await addAccountNamed("Cloud Max");

    const slot = await screen.findByTestId("account-identity-acct-0");
    expect(slot.textContent).toBe("Not signed in");
    expect(slot.textContent).not.toContain("Cloud Max");
    expect(screen.getByText("alias: Cloud Max")).toBeTruthy();
  });

  it("does not cap how many accounts can be added", async () => {
    // The founder has four or five. Nothing in the add path is allowed to bound the list.
    const { deps, onLogin } = store(() => {});
    render(<AccountsScreen onLogin={onLogin} deps={deps} />);
    for (const n of ["One", "Two", "Three", "Four", "Five"]) await addAccountNamed(n);
    await waitFor(() => expect(deps.addAccount).toHaveBeenCalledTimes(5));
    expect(await screen.findByText("alias: Five")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
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
    expect(await screen.findByText("alias: Old")).toBeTruthy();
    expect(deps.setNickname).not.toHaveBeenCalled();
  });

  it("does not offer Remove on the default account", async () => {
    const deps = makeDeps([acct("a", { nickname: "Default", isDefault: true })]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    await screen.findByText("alias: Default");
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

  it("shows 'Not signed in' — NOT the nickname — in the identity slot when no identity resolves", async () => {
    // The founder's live state (bead sparkle-gwkui): `<app_data>/accounts/602064ad…/.claude.json`
    // carries no `oauthAccount` at all, and the screen rendered the string he had typed —
    // "DROdio Gmail" — in the slot reserved for a verified identity. An unauthenticated
    // registration displayed as a login. The nickname is a user-typed label and is never evidence
    // of who is signed in, so it may appear only on the secondary alias line.
    const deps = makeDeps(
      [acct("a", { nickname: "DROdio Chief" })],
      [],
      [{ id: "a", email: null, organization: null, accountUuid: null }],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const slot = await screen.findByTestId("account-identity-a");
    expect(slot.textContent).toBe("Not signed in");
    // The nickname is present, but demoted — it must not be what the identity slot says.
    expect(slot.textContent).not.toContain("DROdio Chief");
    expect(screen.getByText("alias: DROdio Chief")).toBeTruthy();
  });

  it("states a uuid-only login honestly instead of borrowing the nickname for it", async () => {
    // A login with a uuid but no readable email IS signed in, so "Not signed in" would be the same
    // lie pointed the other way — and falling back to the nickname is the lie this fix removes.
    const deps = makeDeps([acct("a", { nickname: "Nick" })], [], [
      { id: "a", email: null, organization: null, accountUuid: "u1" },
    ]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const slot = await screen.findByTestId("account-identity-a");
    expect(slot.textContent).not.toBe("Nick");
    expect(slot.textContent).not.toBe("Not signed in");
    expect(slot.textContent).toMatch(/signed in/i);
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
    expect(await screen.findByText("alias: One")).toBeTruthy();
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

    fireEvent.click(await screen.findByRole("button", { name: "Switch login" }));
    expect(onLogin).not.toHaveBeenCalled(); // first click only arms the confirm

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
    expect(await screen.findByRole("button", { name: "Switch login" })).toBeTruthy();
    const slot = screen.getByTestId("account-identity-a");
    expect(slot.textContent).toBe(SIGNED_IN_NO_EMAIL);
    expect(slot.textContent).not.toContain("Nick");
    expect(screen.queryByText(NOT_SIGNED_IN)).toBeNull();
  });
});
