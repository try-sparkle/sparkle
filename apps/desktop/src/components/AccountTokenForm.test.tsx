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
import { copyToClipboard } from "../clipboard";
import { C } from "../theme/colors";

// The copy button routes through the shared `copyToClipboard` helper. Mock it so the test asserts
// the EXACT string handed to the clipboard, without depending on jsdom's clipboard shims.
vi.mock("../clipboard", () => ({ copyToClipboard: vi.fn(async () => true) }));
const copyMock = vi.mocked(copyToClipboard);

afterEach(() => {
  cleanup();
  copyMock.mockClear();
});

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

  it("keeps 'Use this token' DISABLED until a token is pasted, then enables it", () => {
    render(<AccountTokenForm configDir="/cfg/acct-1" onSaved={vi.fn()} deps={makeDeps()} />);
    const submit = screen.getByTestId("account-token-submit") as HTMLButtonElement;

    // Empty field → disabled (grayed out).
    expect(submit.disabled).toBe(true);
    expect(submit.style.opacity).toBe("0.5");

    // Whitespace-only is still empty → still disabled.
    fireEvent.change(screen.getByTestId("account-token-input"), { target: { value: "   " } });
    expect(submit.disabled).toBe(true);

    // A real paste → enabled.
    fireEvent.change(screen.getByTestId("account-token-input"), { target: { value: "sk-ant-oat01-X" } });
    expect(submit.disabled).toBe(false);
    expect(submit.style.opacity).toBe("1");

    // Clearing it again → disabled once more.
    fireEvent.change(screen.getByTestId("account-token-input"), { target: { value: "" } });
    expect(submit.disabled).toBe(true);
  });

  it("RIGHT-justifies the 'Use this token' button", () => {
    render(<AccountTokenForm configDir="/cfg/acct-1" onSaved={vi.fn()} deps={makeDeps()} />);
    const submit = screen.getByTestId("account-token-submit");
    // The button sits in a flex row justified to the trailing (right) edge.
    expect((submit.parentElement as HTMLElement).style.justifyContent).toBe("flex-end");
  });

  it("copies exactly `claude setup-token` when the copy button is clicked", () => {
    render(<AccountTokenForm configDir="/cfg/acct-1" onSaved={vi.fn()} deps={makeDeps()} />);
    fireEvent.click(screen.getByTestId("account-token-copy"));
    expect(copyMock).toHaveBeenCalledTimes(1);
    expect(copyMock).toHaveBeenCalledWith("claude setup-token");
  });

  it("renders the command `claude setup-token` as a distinctly-colored monospace terminal command", () => {
    render(<AccountTokenForm configDir="/cfg/acct-1" onSaved={vi.fn()} deps={makeDeps()} />);
    const cmd = screen.getByTestId("account-token-cmd");
    expect(cmd.textContent).toBe("claude setup-token");
    // Monospace face AND a distinct command color — asserted as the EXACT token, and specifically
    // NOT the muted prose color it must stand apart from (a bare not-"" would pass even if the
    // command regressed to the surrounding prose color). roborev.
    expect(cmd.style.fontFamily).toContain("monospace");
    expect(cmd.style.color).toBe(C.tealInk);
    expect(cmd.style.color).not.toBe(C.muted);
    // And it is genuinely different from the paragraph prose it sits inside.
    expect(cmd.style.color).not.toBe((cmd.parentElement as HTMLElement).style.color);
  });

  it("HARD GATE: a verified token with NO email surfaces an error and does NOT report success", async () => {
    // A token account with no routable email silently drops out of rotation while the UI says
    // "added" — the exact failure that blocks a blind switch to tokens. It must NOT be a success.
    const deps = makeDeps({
      checkAuthStatus: vi.fn(async () => authStatus({ loggedIn: true, source: "cli", email: null })),
    });
    const onSaved = vi.fn();

    render(<AccountTokenForm configDir="/cfg/acct-ne" onSaved={onSaved} deps={deps} />);
    fireEvent.change(screen.getByTestId("account-token-input"), { target: { value: "sk-ant-oat01-NOEMAIL" } });
    fireEvent.click(screen.getByTestId("account-token-submit"));

    await waitFor(() => expect(deps.setOauthToken).toHaveBeenCalledWith("/cfg/acct-ne", "sk-ant-oat01-NOEMAIL"));
    const err = await screen.findByTestId("account-token-error");
    expect(err.textContent).toMatch(/no email/i);
    expect(onSaved).not.toHaveBeenCalled();
    expect(deps.recordOauthIdentity).not.toHaveBeenCalled();
  });

  it("HARD GATE: if recording the identity THROWS, surfaces an error and does NOT report success", async () => {
    // recordOauthIdentity is what makes the account routable; if it fails the account is not
    // routable, so a genuine-looking token must still not be reported as added.
    const deps = makeDeps({
      recordOauthIdentity: vi.fn(async () => {
        throw new Error("write failed");
      }),
    });
    const onSaved = vi.fn();

    render(<AccountTokenForm configDir="/cfg/acct-th" onSaved={onSaved} deps={deps} />);
    fireEvent.change(screen.getByTestId("account-token-input"), { target: { value: "sk-ant-oat01-THROW" } });
    fireEvent.click(screen.getByTestId("account-token-submit"));

    await waitFor(() =>
      expect(deps.recordOauthIdentity).toHaveBeenCalledWith("/cfg/acct-th", "placeholder@example.com"),
    );
    const err = await screen.findByTestId("account-token-error");
    expect(err.textContent).toMatch(/routable|identity/i);
    expect(onSaved).not.toHaveBeenCalled();
  });
});
