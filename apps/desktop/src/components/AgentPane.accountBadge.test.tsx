// @vitest-environment jsdom
//
// Two things are guarded here, and they fail in opposite directions.
//
// 1. IDENTITY TRUTH (PRD/sparkle/claude-account-identity-truth.md). The badge's identity slot used
//    to be `identity?.email ?? account.nickname`, so an account registered but never `claude
//    login`ed rendered a string the USER TYPED as though it were the Anthropic account this agent's
//    work runs under. A wrong identity is worse than none. Every assertion below about that is an
//    ABSENCE assertion — that the nickname is not in the slot — because asserting "Not signed in"
//    is present would pass just as happily if both were rendered.
//
// 2. INK PAIRING. The account dropdown's SELECTED row is one of the app's few live `pillFill`
//    surfaces, and it is the only site in the app that painted `C.muted` on one. That pairing
//    cannot be fixed by re-deriving a palette value: `muted` clears the ink floor on the depth
//    PLANES and on no chrome fill in either theme (theme/chromeContrast.test.ts asserts exactly
//    that, in both directions). The fix is at the SITE — the row's small secondary lines take the
//    on-fill ink when the row is selected and the plane ink when it is not. What can regress is a
//    future edit re-pointing one of these spans back at `C.muted` for consistency with the
//    unselected row, which is the exact reasoning that put it there in the first place.
//
// jsdom never loads the stylesheet (docs/jsdom-test-caveats.md), so everything asserted here is an
// INLINE style or textContent — never a class-derived getComputedStyle read.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountBadge } from "./AgentPane";
import { C } from "../theme/colors";
import { NOT_SIGNED_IN, type Account, type Identity } from "../services/accountStore";

afterEach(() => cleanup());

const acct = (id: string, nickname: string, isDefault = false): Account => ({
  id,
  nickname,
  configDir: `/tmp/${id}`,
  isDefault,
  createdAt: 0,
});
const ident = (id: string, email: string | null, over: Partial<Identity> = {}): Identity => ({
  id,
  email,
  organization: null,
  accountUuid: null,
  ...over,
});

function mount(accounts: Account[], identities: Identity[], chosen = accounts[0]!) {
  render(
    <AccountBadge
      accounts={accounts}
      identities={identities}
      chosen={chosen}
      open
      onToggle={vi.fn()}
      onPick={vi.fn()}
    />,
  );
}

/** Two accounts: the chosen one carries an alias (nickname ≠ email) AND is the default, so the
 *  selected row renders two secondary lines; the other has no login at all, so the UNSELECTED row
 *  renders its nickname as an alias under "Not signed in". One render covers both states. */
function setup() {
  mount([acct("a", "work-alias", true), acct("b", "spare")], [ident("a", "me@example.com")]);
}

describe("AccountBadge — the identity slot is a verified login or nothing", () => {
  it("an account with NO completed login does not show its nickname as its identity", () => {
    // The founder's account "DROdio Gmail": a config dir whose .claude.json carries no
    // `oauthAccount` at all. The pill had been showing him his own label back.
    mount([acct("g", "DROdio Gmail")], [ident("g", null)]);

    const pill = screen.getByTestId("account-badge-identity");
    expect(pill.textContent).not.toContain("DROdio Gmail");
    expect(pill.textContent).toBe(NOT_SIGNED_IN);

    const row = screen.getByTestId("account-row-identity");
    expect(row.textContent).not.toContain("DROdio Gmail");
    expect(row.textContent).toBe(NOT_SIGNED_IN);

    // The nickname is not erased — it is demoted to a clearly secondary alias line, which is a
    // DIFFERENT element from the identity slot asserted above.
    expect(screen.getByText("DROdio Gmail")).not.toBe(row);
  });

  it("an account with no identity row at all is treated the same way", () => {
    // Identities not loaded yet / an IPC hiccup returning []. Absent evidence is not a licence to
    // fall back to the nickname.
    mount([acct("g", "DROdio Gmail")], []);
    expect(screen.getByTestId("account-badge-identity").textContent).toBe(NOT_SIGNED_IN);
    expect(screen.getByTestId("account-row-identity").textContent).toBe(NOT_SIGNED_IN);
  });

  it("a SIGNED-IN account renders its live email, not its nickname", () => {
    // Regression guard for the fix above: removing the fallback must not remove the identity.
    mount([acct("a", "work-alias")], [ident("a", "me@example.com")]);
    expect(screen.getByTestId("account-badge-identity").textContent).toBe("me@example.com");
    expect(screen.getByTestId("account-row-identity").textContent).toBe("me@example.com");
  });

  it("names the nickname AS a nickname in the tooltip, never as the account", () => {
    mount([acct("g", "DROdio Gmail")], [ident("g", null)]);
    const title = screen.getByRole("button").getAttribute("title") ?? "";
    expect(title).toContain(`Claude account: ${NOT_SIGNED_IN}`);
    expect(title).toContain("Nickname: DROdio Gmail");
    expect(title).not.toContain("Claude account: DROdio Gmail");
  });

  it("an unverified account reads as unavailable — the live dot goes out", () => {
    // jsdom re-serializes the `background` shorthand as `rgb(...)`, so the token is normalized
    // before comparison rather than matched as a hex literal.
    const rgb = (hex: string) => {
      const n = Number.parseInt(hex.slice(1), 16);
      return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
    };
    const dot = () => screen.getByRole("button").querySelector("span") as HTMLElement;

    mount([acct("a", "signed-in")], [ident("a", "me@example.com")]);
    expect(dot().style.background).toBe(rgb(C.teal));
    cleanup();

    mount([acct("g", "DROdio Gmail")], [ident("g", null)]);
    expect(dot().style.background).not.toBe(rgb(C.teal));
    expect(dot().style.background).toBe("transparent");
  });
});

describe("AccountBadge — the shell fork warning", () => {
  const DEFAULT = acct("d", "DROdio Personal", true);
  const FORKED = ident("d", "drodio@storytell.ai", {
    accountUuid: "c70bea4e",
    shellEmail: "drodio@gmail.com",
    shellAccountUuid: "5fb3d67c",
  });
  const NOTICE =
    "Sparkle runs this account as drodio@storytell.ai; your terminal is signed in as drodio@gmail.com.";

  it("says so, in the dropdown and the tooltip, when the terminal is a DIFFERENT login", () => {
    mount([DEFAULT], [FORKED]);
    expect(screen.getByTestId("account-row-fork").textContent).toBe(NOTICE);
    expect(screen.getByRole("button").getAttribute("title")).toContain(NOTICE);
  });

  it("stays quiet when the terminal is the SAME anthropic account", () => {
    mount(
      [DEFAULT],
      [ident("d", "drodio@storytell.ai", {
        accountUuid: "c70bea4e",
        shellEmail: "drodio@storytell.ai",
        shellAccountUuid: "c70bea4e",
      })],
    );
    expect(screen.queryByTestId("account-row-fork")).toBeNull();
    expect(screen.getByRole("button").getAttribute("title")).not.toContain("your terminal");
  });

  it("stays quiet on a NON-default account — the shell's login says nothing about it", () => {
    mount(
      [acct("n", "DROdio Gmail")],
      [ident("n", "a@b.c", { accountUuid: "u1", shellEmail: "z@y.x", shellAccountUuid: "u2" })],
    );
    expect(screen.queryByTestId("account-row-fork")).toBeNull();
  });

  it("does not warn — or crash — when the backend has not shipped the shell fields yet", () => {
    // This UI can land before the Rust does. Unknown must never render as a warning about an
    // identity nobody read.
    mount([DEFAULT], [ident("d", "drodio@storytell.ai", { accountUuid: "c70bea4e" })]);
    expect(screen.queryByTestId("account-row-fork")).toBeNull();
    expect(screen.getByTestId("account-row-identity").textContent).toBe("drodio@storytell.ai");
    expect(screen.getByRole("button").getAttribute("title")).not.toContain("your terminal");
  });
});

describe("AccountBadge — the selected row's secondary ink is the on-fill ink, never `muted`", () => {
  it("the SELECTED row (a `pillFill` backdrop) paints its 10px lines in `cream`", () => {
    setup();
    // The alias line and the "default" marker both sit on the selected row's pillFill.
    for (const text of ["work-alias", "default"]) {
      const span = screen.getByText(text);
      expect(span.style.color, `${text} is read on C.pillFill`).toBe(C.cream);
      expect(span.style.color).not.toBe(C.muted);
    }
  });

  it("an UNSELECTED row is transparent over the menu plane, so it keeps the plane ink", () => {
    setup();
    // The signed-out account is not the chosen one — its row has no fill, so `muted` is correct
    // there and must NOT be swept up by the fix above. Its alias line is the nickname "spare",
    // demoted below the "Not signed in" identity slot.
    expect(screen.getByText("spare").style.color).toBe(C.muted);
  });

  it("the selected row really is the `pillFill` surface these inks were measured against", () => {
    // Without this the two assertions above could keep passing while the row's fill moved to
    // something else entirely — and the ink choice would then be justified by a surface that is
    // no longer there, which is the failure mode this whole ladder exists to stop.
    setup();
    // The alias text appears only in the selected row's secondary line, so walking up from it
    // lands on that row and nothing else.
    const selectedRow = screen.getByText("work-alias").closest("div") as HTMLElement;
    expect(selectedRow.style.background).toBe(C.pillFill);
  });
});
