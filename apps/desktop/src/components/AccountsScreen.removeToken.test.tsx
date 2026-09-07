// @vitest-environment jsdom
//
// THE FEATURE (PR #3047, "Remove pasted token" control): an account whose credential is a pasted
// `setup-token` should offer a way back to a browser OAuth login. The Tauri command
// `account_clear_pasted_token(configDir)` (wrapped as `clearPastedToken`) deletes the config dir's
// credential file ONLY when it holds a non-refreshable pasted token, so exposing it is safe.
//
// ── WHAT THIS FILE ASSERTS ────────────────────────────────────────────────────────────────────────
// It renders the REAL `AccountsScreen` with one TOKEN account and one OAUTH account mounted together,
// and asserts the SIDE EFFECTS the control is FOR, each proved by the other row as its control:
//   • the "Remove pasted token" ⋮ item is present on the token account and ABSENT on the oauth one
//     (an OAuth login has no pasted credential to remove), so the `loginMethod === "token"` gate is
//     pinned in BOTH directions — dropping the gate reddens the oauth-absent assertion, inverting it
//     reddens the token-present one;
//   • clicking it calls `clearPastedToken` with THIS row's configDir and no other — a wrong-arg
//     mutation reddens the `toHaveBeenCalledWith` assertion.
// Mounting both rows at once is deliberate: absence in a card that was never rendered proves nothing.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountsScreen, type AccountsDeps } from "./AccountsScreen";
import type { Account, Identity, Usage } from "../services/accountStore";
import type { ClaudeAuthStatus } from "../preflight";

afterEach(cleanup);

const TOKEN_ID = "token-acct";
const OAUTH_ID = "oauth-acct";

function acct(id: string): Account {
  return { id, nickname: id, configDir: `/cfg/${id}`, isDefault: false, createdAt: 0 };
}

function identity(id: string, authKind: "oauth" | "token"): Identity {
  return {
    id,
    email: `${id}@example.com`,
    organization: null,
    accountUuid: `uuid-${id}`,
    authKind,
  };
}

// A live CLI answer that reports a healthy session for every account, so both rows are signed-in and
// nothing about the health path interferes with the method gate under test.
function authStatus(): ClaudeAuthStatus {
  return {
    loggedIn: true,
    source: "cli",
    email: "x@example.com",
    authMethod: "claude.ai",
    subscriptionType: "max",
  };
}

const IDS = [TOKEN_ID, OAUTH_ID];

function usageRows(): Usage[] {
  return IDS.map((id) => ({ id, tokens5h: 0, tokens7d: 0, exhaustedUntil: null }));
}

function makeDeps(clearPastedToken: ReturnType<typeof vi.fn>): Partial<AccountsDeps> {
  return {
    listAccounts: vi.fn(async () => IDS.map(acct)),
    getUsage: vi.fn(async () => usageRows()),
    getIdentities: vi.fn(async () => [
      identity(TOKEN_ID, "token"),
      identity(OAUTH_ID, "oauth"),
    ]),
    listCeilings: vi.fn(async () => []),
    getUsageLive: vi.fn(async () => {
      throw new Error("live usage unavailable in test");
    }),
    getAuthStatus: vi.fn(async (): Promise<ClaudeAuthStatus> => authStatus()),
    addAccount: vi.fn(async () => acct("new")),
    setNickname: vi.fn(async () => {}),
    removeAccount: vi.fn(async () => {}),
    clearPastedToken,
    readSpawnLog: vi.fn(async () => []),
  };
}

async function renderScreen(clearPastedToken: ReturnType<typeof vi.fn>) {
  render(<AccountsScreen onLogin={vi.fn()} deps={makeDeps(clearPastedToken)} />);
  // Both rows are on screen once their method labels settle.
  await screen.findByTestId(`account-login-method-${TOKEN_ID}`);
  await screen.findByTestId(`account-login-method-${OAUTH_ID}`);
}

function openMenu(id: string) {
  fireEvent.click(screen.getByTestId(`account-menu-button-${id}`));
}

describe("the Remove pasted token control", () => {
  it("appears in the ⋮ menu of a pasted-token account and NOT an oauth account", async () => {
    await renderScreen(vi.fn(async () => true));

    openMenu(TOKEN_ID);
    expect(screen.getByTestId(`account-remove-token-${TOKEN_ID}`).textContent).toBe(
      "Remove pasted token",
    );

    openMenu(OAUTH_ID);
    // The oauth row's own menu is open, yet it carries no such control — nothing to remove.
    expect(screen.queryByTestId(`account-remove-token-${OAUTH_ID}`)).toBeNull();
  });

  it("clears THIS account's pasted token — with its own configDir — when clicked", async () => {
    const clearPastedToken = vi.fn(async () => true);
    await renderScreen(clearPastedToken);

    openMenu(TOKEN_ID);
    fireEvent.click(screen.getByTestId(`account-remove-token-${TOKEN_ID}`));

    await waitFor(() => expect(clearPastedToken).toHaveBeenCalledTimes(1));
    expect(clearPastedToken).toHaveBeenCalledWith(`/cfg/${TOKEN_ID}`);
    // Never the sibling's config dir — the click acts on the row it belongs to, not on any token
    // account that happens to exist.
    expect(clearPastedToken).not.toHaveBeenCalledWith(`/cfg/${OAUTH_ID}`);
  });
});
