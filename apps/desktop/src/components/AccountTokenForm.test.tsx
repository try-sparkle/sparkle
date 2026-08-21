// @vitest-environment jsdom
//
// The add/renew-by-token form. These assert the SIDE EFFECTS, not that a handler exists:
//   • the pasted token is stored against THIS account's configDir (the exact call + args);
//   • success (onSaved) fires ONLY after a LIVE `claude auth status` (loggedIn && source === "cli")
//     confirms the token — a recorded/fail-open reading must NOT be trusted;
//   • a confirmed login records the identity so the account is routable;
//   • an empty paste never writes anything.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountTokenForm, type AccountTokenFormDeps } from "./AccountTokenForm";
import type { ClaudeAuthStatus } from "../preflight";

afterEach(() => cleanup());

function authStatus(over: Partial<ClaudeAuthStatus> = {}): ClaudeAuthStatus {
  return {
    loggedIn: true,
    source: "cli",
    email: "placeholder@example.com",
    authMethod: "oauth",
    subscriptionType: "max",
    ...over,
  };
}

/** Fresh mocks for one render; override per case. */
function makeDeps(over: Partial<AccountTokenFormDeps> = {}): AccountTokenFormDeps {
  return {
    setOauthToken: vi.fn(async () => {}),
    checkAuthStatus: vi.fn(async () => authStatus()),
    recordOauthIdentity: vi.fn(async () => {}),
    ...over,
  };
}

describe("AccountTokenForm", () => {
  it("stores the token against THIS configDir, records the confirmed identity, then closes", async () => {
    const deps = makeDeps();
    const onSaved = vi.fn();

    render(<AccountTokenForm configDir="/cfg/acct-7" onSaved={onSaved} deps={deps} />);

    fireEvent.change(screen.getByTestId("account-token-input"), {
      target: { value: "  sk-ant-oat01-PASTED  " },
    });
    fireEvent.click(screen.getByTestId("account-token-submit"));

    // SIDE EFFECT 1: the token was written to the RIGHT account's dir, trimmed.
    await waitFor(() => expect(deps.setOauthToken).toHaveBeenCalledWith("/cfg/acct-7", "sk-ant-oat01-PASTED"));
    // It verified against the SAME dir before trusting the token.
    expect(deps.checkAuthStatus).toHaveBeenCalledWith("/cfg/acct-7");
    // SIDE EFFECT 2: on a confirmed live login it records the identity so the account is routable.
    await waitFor(() =>
      expect(deps.recordOauthIdentity).toHaveBeenCalledWith("/cfg/acct-7", "placeholder@example.com"),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("account-token-error")).toBeNull();
  });

  it("does NOT trust a fail-open 'recorded' reading — no success, no identity write", async () => {
    // `claude auth status` fails open to {loggedIn:true, source:"recorded"} when it can't run — the
    // exact renew case. Trusting `loggedIn` alone would fire a silent inert success on a bad token.
    const deps = makeDeps({
      checkAuthStatus: vi.fn(async () => authStatus({ loggedIn: true, source: "recorded" })),
    });
    const onSaved = vi.fn();

    render(<AccountTokenForm configDir="/cfg/acct-r" onSaved={onSaved} deps={deps} />);

    fireEvent.change(screen.getByTestId("account-token-input"), { target: { value: "sk-ant-oat01-X" } });
    fireEvent.click(screen.getByTestId("account-token-submit"));

    await waitFor(() => expect(deps.setOauthToken).toHaveBeenCalledWith("/cfg/acct-r", "sk-ant-oat01-X"));
    await screen.findByTestId("account-token-error");
    expect(onSaved).not.toHaveBeenCalled();
    expect(deps.recordOauthIdentity).not.toHaveBeenCalled();
  });

  it("does NOT report success when the CLI says the token is not logged in", async () => {
    const deps = makeDeps({
      checkAuthStatus: vi.fn(async () => authStatus({ loggedIn: false, source: "cli" })),
    });
    const onSaved = vi.fn();

    render(<AccountTokenForm configDir="/cfg/acct-9" onSaved={onSaved} deps={deps} />);

    fireEvent.change(screen.getByTestId("account-token-input"), { target: { value: "sk-ant-oat01-BAD" } });
    fireEvent.click(screen.getByTestId("account-token-submit"));

    await waitFor(() => expect(deps.setOauthToken).toHaveBeenCalledWith("/cfg/acct-9", "sk-ant-oat01-BAD"));
    await screen.findByTestId("account-token-error");
    expect(onSaved).not.toHaveBeenCalled();
    expect(deps.recordOauthIdentity).not.toHaveBeenCalled();
  });

  it("writes nothing for an empty / whitespace-only paste", async () => {
    const deps = makeDeps();
    const onSaved = vi.fn();

    render(<AccountTokenForm configDir="/cfg/acct-3" onSaved={onSaved} deps={deps} />);

    fireEvent.change(screen.getByTestId("account-token-input"), { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("account-token-submit"));

    await Promise.resolve();
    expect(deps.setOauthToken).not.toHaveBeenCalled();
    expect(deps.checkAuthStatus).not.toHaveBeenCalled();
    expect(deps.recordOauthIdentity).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
