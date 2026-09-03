// @vitest-environment jsdom
//
// What this file is really pinning: a login started from this modal goes into a FRESH config dir,
// and the account it creates is named from its own email without the user typing anything.
//
// That is the entire fix. The founder's five Claude Max accounts were invisible to Sparkle because
// every terminal `claude login` overwrote ONE shared config dir — his identity ledger recorded six
// different Anthropic identities behind `~/.claude` in six hours, so Sparkle saw one account with a
// rotating identity and `reset_by_identity_change` discarded every ceiling it had learned. A modal
// that offered a login but let it land in the shared dir would look identical on screen and fix
// nothing, so the assertions below are about ORDER and TARGET (addAccount runs first; ClaudeSignIn
// is pointed at the dir it returned), not about the button existing.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const addAccount = vi.fn();
const listAccounts = vi.fn();
const getIdentities = vi.fn();
const setNickname = vi.fn();
const invalidateAccountState = vi.fn();

vi.mock("../services/accountStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/accountStore")>()),
  addAccount: (...a: unknown[]) => addAccount(...a),
  listAccounts: (...a: unknown[]) => listAccounts(...a),
  getIdentities: (...a: unknown[]) => getIdentities(...a),
  setNickname: (...a: unknown[]) => setNickname(...a),
}));
vi.mock("../services/accountSelection", () => ({
  invalidateAccountState: (...a: unknown[]) => invalidateAccountState(...a),
}));

// The real ClaudeSignIn owns a PTY. Stand in for it with something that records the config dir it
// was pointed at and lets the test fire a CONFIRMED sign-in.
let signInConfigDir: string | null = null;
vi.mock("./ClaudeSignIn", () => ({
  ClaudeSignIn: ({ configDir, onSignedIn }: { configDir: string; onSignedIn: () => void }) => {
    signInConfigDir = configDir;
    return (
      <button type="button" data-testid="fake-signed-in" onClick={onSignedIn}>
        complete login
      </button>
    );
  },
}));

import { AccountLimitModal, PENDING_NICKNAME, resetLabel } from "./AccountLimitModal";
import { expectBoundedCard } from "./dialogCardGeometryTestUtils";
import { useAccountLimitStore } from "../stores/accountLimitStore";

const LIMITED = { id: "old", nickname: "DROdio Personal", configDir: "/Users/x/.claude", isDefault: true, createdAt: 0 };
const FRESH = { id: "new", nickname: PENDING_NICKNAME, configDir: "/app-data/accounts/new", isDefault: false, createdAt: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  signInConfigDir = null;
  useAccountLimitStore.setState({ current: null, dismissed: new Set() });
  listAccounts.mockResolvedValue([LIMITED]);
  addAccount.mockResolvedValue(FRESH);
  setNickname.mockResolvedValue(undefined);
});
afterEach(cleanup);

/** A FIXED reset instant. Deriving it from `Date.now()` at each call site makes two "same" limits
 *  differ by the milliseconds between them — a different {@link limitKey}, so the dismissal test
 *  silently asserts the re-raise path instead of the one it names. */
const UNTIL = 4_000_000_000_000;

/** Raise a limit and wait for the modal to have loaded the account list. */
async function openWithLimit() {
  useAccountLimitStore.getState().raise({ accountId: "old", until: UNTIL });
  render(<AccountLimitModal />);
  await screen.findByText(/hit its Claude limit/);
}

describe("AccountLimitModal", () => {
  // The card must not be able to outgrow the window, and its scroll must live on a DESCENDANT — the
  // dismiss and sign-in buttons sit in pinned chrome, so a card-level scrollport would carry them
  // off the screen on exactly the short window the ceiling exists for. Asserted on the rendered DOM
  // rather than by reading the source: see dialogCardGeometry.ts for why.
  it("is bounded to the viewport and scrolls a descendant, not itself", async () => {
    await openWithLimit();
    const body = screen.getByTestId("account-limit-body");
    expectBoundedCard({ card: body.parentElement as HTMLElement, scrollport: body });
  });

  it("renders nothing until an account is actually limited", () => {
    render(<AccountLimitModal />);
    expect(screen.queryByTestId("account-limit-backdrop")).toBeNull();
  });

  it("names the limited account and says a retry cannot clear it", async () => {
    await openWithLimit();
    expect(screen.getByText(/“DROdio Personal” hit its Claude limit/)).toBeTruthy();
    expect(screen.getByText(/Retrying can’t clear it/)).toBeTruthy();
  });

  // THE LOAD-BEARING ONE. The row — and therefore its own config dir — must exist BEFORE the login
  // runs, because that is the only thing that stops the credential landing in the shared dir.
  it("creates a fresh account first and points the login at ITS dir, not the limited one", async () => {
    await openWithLimit();
    fireEvent.click(screen.getByText("Log in to another account"));

    await waitFor(() => expect(signInConfigDir).toBe(FRESH.configDir));
    expect(addAccount).toHaveBeenCalledTimes(1);
    expect(signInConfigDir).not.toBe(LIMITED.configDir);
  });

  it("names the new account from its email — the user types nothing", async () => {
    getIdentities.mockResolvedValue([
      { id: "new", email: "drodio@storytell.ai", organization: null, accountUuid: "u-new" },
      { id: "old", email: "daniel@danielodio.com", organization: null, accountUuid: "u-old" },
    ]);
    listAccounts.mockResolvedValue([LIMITED, FRESH]);

    await openWithLimit();
    fireEvent.click(screen.getByText("Log in to another account"));
    fireEvent.click(await screen.findByTestId("fake-signed-in"));

    await waitFor(() => expect(setNickname).toHaveBeenCalledWith("new", "drodio@storytell.ai"));
    expect((await screen.findByTestId("account-limit-result")).textContent).toMatch(/drodio@storytell\.ai/);
    // Without this the 5s selection-cache snapshot hides the account that was just registered.
    expect(invalidateAccountState).toHaveBeenCalled();
  });

  // Signing into an account that is ALREADY registered buys no headroom — it is the same quota.
  // Reporting it as success is the failure mode that would send the founder back to the terminal.
  it("refuses a duplicate login instead of renaming a second row onto one quota", async () => {
    getIdentities.mockResolvedValue([
      { id: "new", email: "daniel@danielodio.com", organization: null, accountUuid: "SAME" },
      { id: "old", email: "daniel@danielodio.com", organization: null, accountUuid: "SAME" },
    ]);
    listAccounts.mockResolvedValue([LIMITED, FRESH]);

    await openWithLimit();
    fireEvent.click(screen.getByText("Log in to another account"));
    fireEvent.click(await screen.findByTestId("fake-signed-in"));

    const result = await screen.findByTestId("account-limit-result");
    expect(result.textContent).toMatch(/same Claude account as “DROdio Personal”/);
    expect(setNickname).not.toHaveBeenCalled();
  });

  it("dismissing closes it and it does not come back for the same limit", async () => {
    await openWithLimit();
    fireEvent.click(screen.getByText("Not now"));
    await waitFor(() => expect(screen.queryByTestId("account-limit-backdrop")).toBeNull());

    useAccountLimitStore.getState().raise({ accountId: "old", until: UNTIL });
    expect(useAccountLimitStore.getState().current).toBeNull();
  });
});

// `until` is resolved by parsing a limit event's reset text, so a malformed/absent reset can hand
// `resetLabel` a NaN. `Intl.DateTimeFormat.format(new Date(NaN))` throws `RangeError: Invalid time
// value`, which would take down the whole limit modal — the one surface that tells a rate-limited
// user what happened. The guard degrades to null (the render already has a no-reset-time copy).
describe("resetLabel", () => {
  const NOW = 4_000_000_000_000;

  it("returns null for a non-finite reset instant instead of throwing", () => {
    // Side effect under test: NO throw, and the null the render treats as "no reset time".
    expect(() => resetLabel(Number.NaN, NOW)).not.toThrow();
    expect(resetLabel(Number.NaN, NOW)).toBeNull();
    expect(resetLabel(Number.POSITIVE_INFINITY, NOW)).toBeNull();
  });

  it("still formats a valid FUTURE reset instant (guard did not over-widen to always-null)", () => {
    const label = resetLabel(NOW + 60 * 60 * 1000, NOW);
    expect(label).not.toBeNull();
    expect(label).toMatch(/\d/);
  });

  it("still returns null for a reset instant already in the past", () => {
    expect(resetLabel(NOW - 1, NOW)).toBeNull();
  });
});
