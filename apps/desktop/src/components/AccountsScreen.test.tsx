// @vitest-environment jsdom
//
// Interaction tests for the Accounts settings screen: load/list, add → onLogin seam, inline
// rename, and the two-step remove confirm (default guarded). IO is injected via the `deps` prop.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountsScreen, SIGNED_IN_NO_EMAIL, type AccountsDeps } from "./AccountsScreen";
import {
  NOT_SIGNED_IN,
  CEILING_AVOID_FRACTION,
  type Account,
  type Usage,
  type Identity,
} from "../services/accountStore";
import type { Ceiling } from "../services/headroom";

afterEach(() => cleanup());

function acct(id: string, over: Partial<Account> = {}): Account {
  return { id, nickname: id, configDir: `/cfg/${id}`, isDefault: false, createdAt: 0, ...over };
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
    addAccount: vi.fn(async (nickname: string) => acct("new", { nickname })),
    setNickname: vi.fn(async () => {}),
    removeAccount: vi.fn(async () => {}),
    // Without this the panel falls back to the real invoke("accounts_spawn_log") inside a suite
    // that mocks no Tauri bridge: it rejects, resolves to [] outside act() after the assertions
    // have run, and the mount cannot be asserted at all.
    readSpawnLog: vi.fn(async () => []),
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
      listCeilings: vi.fn(async () => []),
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

  it("offers the fix inline: the banner's own add button opens the add form", async () => {
    const deps = makeDeps([acct("a")], [], [signedInAs("a", "one@example.com")]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    fireEvent.click(await screen.findByRole("button", { name: /Add another account/ }));
    // The form is open and ready to type into — the remedy is one click from the diagnosis.
    expect(screen.getByLabelText("New account nickname")).toBeTruthy();
  });

  it("shows the numbered steps for adding an account", async () => {
    const deps = makeDeps([acct("a")], [], [signedInAs("a", "one@example.com")]);
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const steps = await screen.findByTestId("add-account-steps");
    expect(steps.querySelectorAll("li")).toHaveLength(4);
    // The third step — the browser login under the NEW config dir — is the one that gets skipped,
    // and the fourth is how you tell that it was.
    expect(steps.textContent).toContain("browser");
    expect(steps.textContent).toContain("Finish sign-in");
  });
});

describe("per-account headroom", () => {
  it("shows used vs the LEARNED ceiling and the percentage", async () => {
    const deps = makeDeps(
      [acct("a", { nickname: "One" })],
      [used("a", 45_000_000)],
      [signedInAs("a", "one@example.com")],
      [ceiling("a", CEIL)],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const line = await screen.findByTestId("account-headroom-a");
    expect(line.textContent).toContain("45%");
    expect(line.textContent).toContain("Room to spare");
    expect(line.textContent).toContain("45.0M");
  });

  it("a NULL ceiling reads as unknown — NEVER as 0% and never as a bar", async () => {
    // An unmeasured account must not look like the emptiest one in the pool. A bar implies a
    // denominator that does not exist, and either extreme of it is a lie in one direction.
    const deps = makeDeps(
      [acct("a", { nickname: "One" })],
      [used("a", 45_000_000)],
      [signedInAs("a", "one@example.com")],
      [ceiling("a", null)],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const line = await screen.findByTestId("account-headroom-a");
    expect(line.textContent).toContain("Not enough history to estimate a limit yet");
    expect(line.textContent).toContain("Limit unknown");
    expect(line.textContent).not.toMatch(/\d+%/);
    expect(line.querySelector("[role='progressbar']")).toBeNull();
    // The two cross-account UsageBars are still there; the headroom line added no third one.
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
  });

  it("states the ACT line — the fraction at which spawns stop — not the warn line", async () => {
    const deps = makeDeps(
      [acct("a")],
      [used("a", 10_000_000)],
      [signedInAs("a", "one@example.com")],
      [ceiling("a", CEIL)],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const line = await screen.findByTestId("account-headroom-a");
    expect(line.textContent).toContain(
      `Stops taking new agents at ${Math.round(CEILING_AVOID_FRACTION * 100)}%`,
    );
  });

  it("an exhausted account reads as at its limit and shows when it resets", async () => {
    const reset = Date.now() + 47 * 60_000;
    const deps = makeDeps(
      [acct("a")],
      [used("a", 1_000, reset)],
      [signedInAs("a", "one@example.com")],
      [ceiling("a", CEIL)],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const line = await screen.findByTestId("account-headroom-a");
    expect(line.textContent).toContain("At its limit");
    // The observed limit outranks the estimate: 1k of 100M is 0%, and it still reads exhausted.
    expect(screen.getByText(`Exhausted until ${clock(reset)}`)).toBeTruthy();
  });

  it("keeps rendering accounts when the ceilings read FAILS", async () => {
    // Ceilings are an enrichment. Sharing a rejection path with `listAccounts` would trade a missing
    // percentage for a screen showing no accounts at all.
    const deps = makeDeps([acct("a", { nickname: "One" })], [used("a", 5)], [
      signedInAs("a", "one@example.com"),
    ]);
    deps.listCeilings = vi.fn(async () => {
      throw new Error("accounts_ceilings unavailable");
    });
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    expect(await screen.findByText("one@example.com")).toBeTruthy();
    expect(screen.getByTestId("account-headroom-a").textContent).toContain(
      "Not enough history to estimate a limit yet",
    );
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
    // MUST NOT promise spawns are blocked: `pickAccount` still returns a least-bad account.
    expect(banner.textContent).toContain("work carries on");
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

  it("does not claim a reset time nobody reported", async () => {
    // Over the ACT line on an ESTIMATE, with no observed rate limit — so there is no instant to
    // quote and none may be invented.
    const overAct = CEILING_AVOID_FRACTION * CEIL;
    const deps = makeDeps(
      [acct("a")],
      [used("a", overAct)],
      [signedInAs("a", "one@example.com")],
      [ceiling("a", CEIL)],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const banner = await screen.findByTestId("all-at-limit-banner");
    expect(banner.textContent).toContain("No reset time has been reported yet");
    expect(banner.textContent).not.toMatch(/frees up at/);
  });
});

describe("AC9 — runway warning before the wall", () => {
  it("warns with the switch target while the account still has room left", async () => {
    // 85% is past the WARN line (0.8) and short of the ACT line (0.9): still receiving spawns, and
    // exactly the window in which telling the human is useful.
    const deps = makeDeps(
      [acct("a"), acct("b")],
      [used("a", 0.85 * CEIL), used("b", 5_000_000)],
      [signedInAs("a", "one@example.com", "u1"), signedInAs("b", "two@example.com", "u2")],
      [ceiling("a", CEIL), ceiling("b", CEIL)],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const warn = await screen.findByTestId("runway-warning-a");
    // `describeRecommendation`'s sentence verbatim — this screen must not own a second copy of it.
    expect(warn.textContent).toBe(
      "one@example.com is 85% of its usual limit. Switch to two@example.com before it runs out.",
    );
    // The healthy account gets no warning of its own.
    expect(screen.queryByTestId("runway-warning-b")).toBeNull();
    // Not yet the wall.
    expect(screen.queryByTestId("all-at-limit-banner")).toBeNull();
  });

  it("THE FOUNDER'S CASE: warns that there is nowhere to move to", async () => {
    const deps = makeDeps(
      [acct("a"), acct("dead", { nickname: "DROdio Gmail" })],
      [used("a", 0.85 * CEIL)],
      [signedInAs("a", "drodio@gmail.com"), neverLoggedIn("dead")],
      [ceiling("a", CEIL)],
    );
    render(<AccountsScreen onLogin={vi.fn()} deps={deps} />);
    const warn = await screen.findByTestId("runway-warning-a");
    expect(warn.textContent).toContain("drodio@gmail.com is at 85% of its usual limit");
    expect(warn.textContent).toContain("no other signed-in account to move to");
    // It must NOT propose a switch to the account that cannot receive agents.
    expect(warn.textContent).not.toContain("Switch to");
    expect(warn.textContent).not.toContain("DROdio Gmail");
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
    // it must narrow the warning rather than adding to it.
    const deps = makeDeps(
      [acct("a"), acct("b")],
      [used("a", 0.85 * CEIL), used("b", 0.85 * CEIL)],
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
