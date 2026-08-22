// @vitest-environment jsdom
//
// knightwatch probe 2 + roborev. A second reachable "Log in" swaps `loginAccount` beneath an
// ALREADY-MOUNTED AccountLoginModal (KebabMenu keeps the modal mounted and replaces its `account`
// prop). Two failures live here, and these tests pin the SIDE EFFECTS of the fix, not the spelling
// of it:
//   1. `ClaudeSignIn` is now behind an opt-in, and its browser-popping PTY must NOT start for an
//      account the user did not click for. So a swapped-in account (including a swap BACK to one
//      previously opened, A → B → A) must leave the surface unmounted until a fresh click.
//   2. Because the opt-in CLOSES on every account change, the surface is unmounted and freshly
//      remounted per opt-in — so `ClaudeSignIn`'s own `done`/`confirming`/`unconfirmed` state can
//      never be inherited by a different account. That replaced the old `key={account.configDir}`
//      remount guard, so no `key` is asserted here any more; the unmount-on-swap is the guard.
// Mounts are counted per INSTANCE (a `[]`-dep effect), so an ordinary re-render is not miscounted as
// a remount and the "same account re-render" narrowness test can still fail.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Count MOUNTS per configDir — recorded from a `[]`-dep effect, not the render body. A component
// body runs on every render, so counting there would make an ordinary re-render look like a
// remount and the narrowness test below could never fail.
const mounts: string[] = [];
vi.mock("./ClaudeSignIn", async () => {
  const { useEffect, useRef } = await import("react");
  return {
    ClaudeSignIn: ({ configDir }: { configDir?: string }) => {
      // Records once per INSTANCE, which is the whole discriminator. A `[configDir]`-dep effect
      // would re-fire when the prop merely CHANGES — which happens with or without a remount — so
      // the assertion would pass against the unkeyed implementation too, i.e. be vacuous. It WAS:
      // a mutation check caught it. The dir is captured in a ref at first render so the effect can
      // have truly empty deps without lying to exhaustive-deps about what it closes over.
      const mountedAs = useRef(configDir);
      useEffect(() => {
        mounts.push(mountedAs.current ?? "<none>");
      }, []);
      return <div data-testid="signin" data-dir={configDir} />;
    },
  };
});

import { expectBoundedCard } from "./dialogCardGeometryTestUtils";
import { AccountLoginModal } from "./AccountLoginModal";
import type { Account } from "../services/accountStore";

const acct = (id: string, configDir: string): Account => ({
  id,
  nickname: `nick-${id}`,
  configDir,
  isDefault: false,
  createdAt: 0,
});

afterEach(() => {
  cleanup();
  mounts.length = 0;
});

describe("AccountLoginModal — swapping the account underneath it", () => {
  // This card's ONLY dismiss control is the "Done" button in its header row, which makes it the
  // sharpest case for the rule: a card-level scrollport scrolls the way out off the screen.
  it("is bounded to the viewport and scrolls a descendant, not itself", () => {
    render(<AccountLoginModal account={acct("a", "/dirs/a")} onClose={vi.fn()} />);
    const body = screen.getByTestId("account-login-body");
    expectBoundedCard({ card: body.parentElement as HTMLElement, scrollport: body });
  });

  it("lets the body fill the fixed-height card in the default (OAuth-closed) state", () => {
    // roborev: the card is a fixed 520px sized for when ClaudeSignIn took the remainder via flex:1.
    // With OAuth now opt-in, the body must GROW to fill in the default state, or the bottom half of
    // every modal open is blank. Opening OAuth hands the slack back to the terminal container.
    render(<AccountLoginModal account={acct("a", "/dirs/a")} onClose={vi.fn()} />);
    const body = screen.getByTestId("account-login-body");
    expect(body.style.flex).toBe("1 1 auto");

    fireEvent.click(screen.getByTestId("account-oauth-open"));
    expect(body.style.flex).toBe("0 1 auto");
  });

  it("unmounts the sign-in surface on an account swap, so B cannot inherit A's verdict", () => {
    const { rerender } = render(
      <AccountLoginModal account={acct("a", "/dirs/a")} onClose={vi.fn()} />,
    );
    // OAuth is opt-in now: the sign-in surface is not even mounted until the user opens it.
    fireEvent.click(screen.getByTestId("account-oauth-open"));
    expect(mounts).toEqual(["/dirs/a"]);
    expect(screen.getByTestId("signin")).toBeTruthy();

    // The swap: same mounted modal, different account. The opt-in closes on the account change, so
    // A's ClaudeSignIn instance is UNMOUNTED (its state cannot carry to B) and B starts CLOSED.
    rerender(<AccountLoginModal account={acct("b", "/dirs/b")} onClose={vi.fn()} />);
    expect(screen.queryByTestId("signin")).toBeNull();
    expect(mounts).toEqual(["/dirs/a"]);

    // Opening it for B mounts a FRESH instance — never a re-render of A's carrying state forward.
    fireEvent.click(screen.getByTestId("account-oauth-open"));
    expect(mounts).toEqual(["/dirs/a", "/dirs/b"]);
  });

  it("does NOT auto-open OAuth for a swapped-in account (browser can't pop without a click)", () => {
    // roborev: the opt-in is scoped to the account's id, not a bare boolean. After opening OAuth for
    // A and swapping to B beneath the same mounted modal, B's sign-in surface (and its PTY) must
    // stay unmounted — otherwise B's browser login pops without the user ever clicking for B.
    const { rerender } = render(
      <AccountLoginModal account={acct("a", "/dirs/a")} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("account-oauth-open"));
    expect(mounts).toEqual(["/dirs/a"]);

    rerender(<AccountLoginModal account={acct("b", "/dirs/b")} onClose={vi.fn()} />);

    // B is closed again: teaser shown, no sign-in surface, no new mount.
    expect(screen.getByTestId("account-oauth-teaser")).toBeTruthy();
    expect(screen.queryByTestId("signin")).toBeNull();
    expect(mounts).toEqual(["/dirs/a"]);
  });

  it("does NOT re-arm OAuth when swapping BACK to a previously-opened account (A → B → A)", () => {
    // roborev: the opt-in must be CLEARED on an account change, not merely remembered for the dir it
    // was granted for. Otherwise returning to A re-satisfies the gate and A's browser PTY pops with
    // no click in that visit — the same bug one hop out.
    const { rerender } = render(
      <AccountLoginModal account={acct("a", "/dirs/a")} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("account-oauth-open"));
    expect(mounts).toEqual(["/dirs/a"]);

    rerender(<AccountLoginModal account={acct("b", "/dirs/b")} onClose={vi.fn()} />);
    rerender(<AccountLoginModal account={acct("a", "/dirs/a")} onClose={vi.fn()} />);

    // Back on A, but the opt-in was cleared by the swap away: closed, no auto-pop, no new mount.
    expect(screen.getByTestId("account-oauth-teaser")).toBeTruthy();
    expect(screen.queryByTestId("signin")).toBeNull();
    expect(mounts).toEqual(["/dirs/a"]);

    // Only a fresh click re-opens it.
    fireEvent.click(screen.getByTestId("account-oauth-open"));
    expect(mounts).toEqual(["/dirs/a", "/dirs/a"]);
  });

  it("does NOT unmount an in-progress login when the same account merely re-renders", () => {
    // Narrowness: the reset-on-account-change must key on `account.id`, so an unrelated parent
    // re-render (same account) does NOT close the opt-in and kill a PTY the user is mid-way through.
    const { rerender } = render(
      <AccountLoginModal account={acct("a", "/dirs/a")} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("account-oauth-open"));
    rerender(<AccountLoginModal account={acct("a", "/dirs/a")} onClose={vi.fn()} />);
    expect(screen.getByTestId("signin")).toBeTruthy();
    expect(mounts).toEqual(["/dirs/a"]);
  });

  it("header reads 'Claude Code account' (singular, C-L-A-U-D-E — not 'Cloud', not 'accounts')", () => {
    render(<AccountLoginModal account={acct("a", "/dirs/a")} onClose={vi.fn()} />);
    const body = screen.getByTestId("account-login-body");
    const header = body.querySelector("p");
    expect(header?.textContent).toBe(
      "Log in to your Claude Code account. Sparkle never sees your credentials.",
    );
    // Guard the two spellings the founder called out by name.
    expect(header?.textContent).not.toMatch(/Cloud/);
    expect(header?.textContent).not.toMatch(/Claude Code accounts/);
  });

  it("keeps the OAuth browser flow HIDDEN until the user clicks to open it", () => {
    render(<AccountLoginModal account={acct("a", "/dirs/a")} onClose={vi.fn()} />);
    // Before the click: the teaser + button show, but the sign-in surface (and its PTY) do not.
    expect(screen.getByTestId("account-oauth-teaser")).toBeTruthy();
    expect(screen.queryByTestId("signin")).toBeNull();
    expect(mounts).toEqual([]);

    fireEvent.click(screen.getByTestId("account-oauth-open"));

    // After the click: the surface mounts (PTY starts) and the teaser is replaced.
    expect(screen.getByTestId("signin")).toBeTruthy();
    expect(screen.queryByTestId("account-oauth-teaser")).toBeNull();
    expect(mounts).toEqual(["/dirs/a"]);
  });
});
