// @vitest-environment jsdom
//
// knightwatch probe 2. A second reachable "Log in" swaps `loginAccount` beneath an ALREADY-MOUNTED
// AccountLoginModal (KebabMenu keeps the modal mounted and replaces its `account` prop). The modal
// itself holds no state — but `ClaudeSignIn` does: `done`, `confirming` and `unconfirmed` are its
// own `useState`. Without a remount those survive the swap, so the second account inherits the
// FIRST account's verdict: it can render as already signed in, and its login PTY never starts.
//
// The guard is `key={account.configDir}` at the mount site. This asserts the REMOUNT (a fresh
// ClaudeSignIn instance for a different account), which is the side effect — not that the key
// attribute exists, which would pass against any implementation that merely spelled it.
import { cleanup, render, screen } from "@testing-library/react";
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

  it("remounts the sign-in surface, so account B cannot inherit account A's verdict", () => {
    const { rerender } = render(
      <AccountLoginModal account={acct("a", "/dirs/a")} onClose={vi.fn()} />,
    );
    expect(mounts).toEqual(["/dirs/a"]);

    // The swap: same mounted modal, different account.
    rerender(<AccountLoginModal account={acct("b", "/dirs/b")} onClose={vi.fn()} />);

    // A FRESH mount for B — not a re-render of A's instance carrying its state forward.
    expect(mounts).toEqual(["/dirs/a", "/dirs/b"]);
  });

  it("does NOT remount when the same account merely re-renders", () => {
    // Narrowness: keying must not throw away an in-progress login on an unrelated parent render,
    // which would kill a PTY the user is mid-way through.
    const { rerender } = render(
      <AccountLoginModal account={acct("a", "/dirs/a")} onClose={vi.fn()} />,
    );
    rerender(<AccountLoginModal account={acct("a", "/dirs/a")} onClose={vi.fn()} />);
    expect(mounts).toEqual(["/dirs/a"]);
  });
});
