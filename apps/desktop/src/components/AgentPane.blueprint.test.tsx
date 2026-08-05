// @vitest-environment jsdom
//
// AgentPane's chrome, ported to the Blueprint cockpit direction.
//
// The pane renders ON the terminal plane, which is a different register from the shell's: its own
// inks, and its own — darker — rule. `theme/chromeContrast.test.ts` floors the chrome `hairline`
// against every plane EXCEPT this one (it skips the pair deliberately and floors `termHairline`
// there instead), so a chrome-hairline edge drawn here is not "a slightly wrong colour", it is the
// one edge in the app with no contrast guard behind it at all.
//
// The whole pane cannot be rendered in a test — it pulls the spawn/worktree/preflight tree, which
// needs the Tauri runtime — so this file asserts the one piece of pane chrome that IS renderable:
// the account chip. The pane ROOT's surface, the absent build-boundary rule, and the
// no-remount-on-theme-flip invariant are asserted over the source in
// `AgentPane.blueprintSource.test.ts` (a node-env sibling, because `import.meta.url` is not a file
// URL under jsdom).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountBadge } from "./AgentPane";
import { PinnedPrompt } from "./PinnedPrompt";
import { C } from "../theme/colors";
import { TERM_HAIRLINE, TERM_RADIUS, TERM_TYPE, termInk, termMuted } from "./terminalChrome";
import { NOT_SIGNED_IN, type Account, type Identity } from "../services/accountStore";

afterEach(() => cleanup());

/** jsdom serialises an inline `color` to `rgb(r, g, b)`. */
function rgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

const acct = (id: string, nickname: string, isDefault = false): Account => ({
  id,
  nickname,
  configDir: `/tmp/${id}`,
  isDefault,
  createdAt: 0,
});
const ident = (id: string, email: string | null): Identity => ({
  id,
  email,
  organization: null,
  accountUuid: null,
});

function setup(open = true) {
  const accounts = [acct("a", "work-alias", true), acct("b", "spare")];
  render(
    <AccountBadge
      accounts={accounts}
      identities={[ident("a", "me@example.com")]}
      chosen={accounts[0]!}
      open={open}
      onToggle={vi.fn()}
      onPick={vi.fn()}
    />,
  );
}

// No matchMedia in jsdom, so `systemPrefersDark` falls back to its documented default: dark.
const MODE = "dark" as const;

describe("AgentPane — the account chip sits ON the terminal plane", () => {
  it("draws its edge with `termHairline`, not the chrome hairline and not an ink", () => {
    setup(false);
    const chip = screen.getByRole("button");
    expect(chip.style.border).toBe(`1px solid ${TERM_HAIRLINE}`);
    // It carried `C.muted` — an INK used as a border, whose only floors are as TEXT on the shell's
    // planes. And `C.hairline` is unguarded on this plane. Neither may come back.
    expect(chip.style.border).not.toContain(C.muted);
    expect(chip.style.border).not.toContain(C.hairline);
  });

  it("takes the terminal's ink register and the spec's type scale and radii", () => {
    setup(false);
    const chip = screen.getByRole("button");
    expect(chip.style.color).toBe(rgb(termInk(MODE)));
    expect(chip.style.fontSize).toBe(`${TERM_TYPE.small}px`);
    expect(chip.style.borderRadius).toBe(`${TERM_RADIUS.modal}px`);
    // The caret is secondary chrome, so it drops to the register's quiet tier.
    const caret = screen.getByText("▾");
    expect(caret.style.color).toBe(rgb(termMuted(MODE)));
  });

  it("outlines its dropdown against the terminal plane with the same rule", () => {
    setup(true);
    // The menu is the element carrying a minWidth of 180 — its own popover shell.
    const menu = [...document.querySelectorAll<HTMLElement>("div")].find(
      (d) => d.style.minWidth === "180px",
    );
    expect(menu, "expected the account dropdown").toBeTruthy();
    expect(menu!.style.border).toBe(`1px solid ${TERM_HAIRLINE}`);
    expect(menu!.style.borderRadius).toBe(`${TERM_RADIUS.modal}px`);
  });

  it("leaves the menu's INTERNAL ink pairing alone — those rows are read on its own plane", () => {
    // The direction changes the register of things ON the terminal plane. It does not change the
    // neutral ladder inside a popover: those rows sit on `deepForest`/`pillFill`, where `cream` and
    // `muted` are the measured inks (theme/chromeContrast + AgentPane.accountBadge.test). Sweeping
    // them into the terminal register would break a floor that IS enforced, to fix one that isn't.
    setup(true);
    // The row that carries this rule used to be a lowercase "not signed in" SECONDARY line beside
    // the nickname. That line is gone: the identity slot itself now says `NOT_SIGNED_IN`, because
    // rendering a user-typed nickname where a verified login belongs was the bug (sparkle-gwkui).
    // The INK RULE this test exists for is unchanged and still enforced — assert it on the element
    // that inherited the role rather than deleting the guard with the line it happened to name.
    // Fixture: account "b" has no identity, so its row is the unverified one.
    const unverified = screen
      .getAllByTestId("account-row-identity")
      .find((el) => el.textContent === NOT_SIGNED_IN);
    expect(unverified, `expected an unverified row rendering "${NOT_SIGNED_IN}"`).toBeTruthy();
    expect(unverified!.style.color).toBe(C.muted);
    expect(screen.getByText("work-alias").style.color).toBe(C.cream);
  });
});

describe("AgentPane — the pane HEADER's rule is where a bar meets the terminal plane", () => {
  it("underlines with `termHairline`, not the chrome hairline", () => {
    // `PinnedPrompt` is the pane's header. It is painted in `barSurface` and its BOTTOM edge is the
    // boundary between that bar and the terminal plane below it — which the direction draws with a
    // different, darker rule. This was the app's one completely unguarded edge: chromeContrast
    // floors `C.hairline` on every plane EXCEPT the terminal's, deliberately, because `termHairline`
    // is the token measured there.
    render(<PinnedPrompt prompt="hello" history={[]} />);
    const bar = [...document.querySelectorAll<HTMLElement>("div")].find(
      (d) => d.style.background === C.barSurface,
    );
    expect(bar, "expected the pinned-prompt header bar").toBeTruthy();
    expect(bar!.style.borderBottom).toBe(`1px solid ${TERM_HAIRLINE}`);
    expect(bar!.style.borderBottom).not.toContain(C.hairline);
  });
});
