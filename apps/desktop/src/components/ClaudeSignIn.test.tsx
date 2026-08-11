// @vitest-environment jsdom
//
// The non-obvious part of this component is the CONFIRM WINDOW, and every branch of it is a way to
// strand the user inside a blocking gate. `claude auth login` hands off to a browser, so the PTY can
// exit while the user is still on the OAuth page — a single probe at exit would report "not signed
// in" for a login about to succeed. These pin: the poll keeps trying, success fires exactly once,
// and a genuine failure keeps a retry reachable (roborev 57985).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ClaudeAuthStatus, AuthStatusSource } from "../preflight";

const checkClaude = vi.fn();
const checkClaudeAuthStatus = vi.fn();
vi.mock("../preflight", () => ({
  checkClaude: () => checkClaude(),
  checkClaudeAuthStatus: (d?: string) => checkClaudeAuthStatus(d),
}));

// The PTY is the one thing we cannot run here. Expose its onExit so a test can fire the exact edge
// the confirm window hangs off, and record the argv so the `auth login` fix is pinned end to end.
let lastSpawn: { args: string[]; cwd?: string; agentId: string } | null = null;
/** Every PTY mounted during a test, in order — the agentId is the `PtyManager.sessions` KEY, so a
 *  repeat here is a real session collision, not a cosmetic one. */
let spawns: { agentId: string; args: string[] }[] = [];
let fireExit: (() => void) | null = null;
vi.mock("./Terminal", () => ({
  Terminal: ({
    agentId,
    args,
    cwd,
    onExit,
  }: {
    agentId: string;
    args: string[];
    cwd?: string;
    onExit?: () => void;
  }) => {
    lastSpawn = { args, cwd, agentId };
    spawns.push({ agentId, args });
    fireExit = onExit ?? null;
    return <div data-testid="pty" />;
  },
}));

import { ClaudeSignIn } from "./ClaudeSignIn";
import { claudeSignInPtyId } from "../services/claudeSpawn";

/** Mirrors CONFIRM_POLL_MS in the component. Kept local (the constant is not exported) but named so
 *  the timer advances below read as "several poll intervals", not as a magic number. */
const CONFIRM_POLL_MS_FOR_TEST = 1500;

const auth = (loggedIn: boolean, source: AuthStatusSource = "cli"): ClaudeAuthStatus => ({
  loggedIn,
  source,
  email: loggedIn ? "me@example.com" : null,
  authMethod: null,
  subscriptionType: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  lastSpawn = null;
  spawns = [];
  fireExit = null;
  checkClaude.mockResolvedValue({ installed: true, path: "/bin/claude", version: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Mount and wait for the binary probe to land the PTY on screen. */
async function mount(onSignedIn = vi.fn()) {
  render(<ClaudeSignIn onSignedIn={onSignedIn} />);
  await screen.findByTestId("pty");
  return onSignedIn;
}

describe("ClaudeSignIn", () => {
  it("spawns `claude auth login` — the whole reason the onboarding window was dead", async () => {
    await mount();
    // The exec string is the last shell arg. `auth login`, not the bare `login` that commander read
    // as a prompt and answered with a REPL.
    expect(lastSpawn?.args.at(-1)).toContain("auth login");
    expect(lastSpawn?.args.at(-1)).not.toMatch(/claude'? login/);
  });

  it("tells the user when claude isn't installed rather than showing a dead terminal", async () => {
    checkClaude.mockResolvedValue({ installed: false, path: null, version: null });
    render(<ClaudeSignIn onSignedIn={vi.fn()} />);
    expect(await screen.findByText(/install claude code first/i)).toBeTruthy();
    expect(screen.queryByTestId("pty")).toBeNull();
  });

  // The PTY exiting is NOT success. A user who quit, failed, or hit ⌃C must not dismiss a gate.
  it("does not report success merely because the terminal exited", async () => {
    const onSignedIn = await mount();
    checkClaudeAuthStatus.mockResolvedValue(auth(false));
    await act(async () => {
      fireExit?.();
    });
    expect(onSignedIn).not.toHaveBeenCalled();
    // It is still waiting, not given up — the browser may not have finished.
    expect(screen.getByText(/waiting for your browser/i)).toBeTruthy();
  });

  it("confirms once the credential lands, and reports it exactly once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onSignedIn = await mount();
    // Signed-out at exit, then live on a later poll — the browser-handoff race this window exists
    // for. A single probe at exit would have reported failure here.
    checkClaudeAuthStatus.mockResolvedValueOnce(auth(false)).mockResolvedValue(auth(true));
    await act(async () => {
      fireExit?.();
    });
    // One poll interval is enough for the second (live) answer to land.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(onSignedIn).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/signed in to claude/i)).toBeTruthy();

    // THE POLL MUST STOP ON SUCCESS. This assertion was VACUOUS at first: it advanced 60ms of real
    // time against a 1500ms interval, so the poll could not have fired either way and the check
    // passed whether or not `stopPolling` ran (roborev 58006). Advancing well past several
    // intervals is what makes it able to fail — a leaked interval keeps calling the probe forever,
    // on a component that is done.
    const callsAtSuccess = checkClaudeAuthStatus.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONFIRM_POLL_MS_FOR_TEST * 5);
    });
    expect(checkClaudeAuthStatus.mock.calls.length).toBe(callsAtSuccess);
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });

  // A fail-open `recorded` yes must still dismiss: an identity exists and the live probe couldn't
  // speak. Refusing to proceed would strand a user whose login genuinely worked behind a broken
  // probe — inside a gate that blocks the whole app.
  it("accepts a recorded-only yes so a broken probe cannot trap the user", async () => {
    const onSignedIn = await mount();
    checkClaudeAuthStatus.mockResolvedValue(auth(true, "recorded"));
    await act(async () => {
      fireExit?.();
    });
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
  });

  // THE BUG THE REVIEW CAUGHT. On a real failure the window expires — and the retry used to vanish
  // with the spinner, leaving a dead PTY and no way out of a blocking gate.
  it("keeps a retry reachable, and says why, when the sign-in never confirms", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onSignedIn = await mount();
    checkClaudeAuthStatus.mockResolvedValue(auth(false));
    await act(async () => {
      fireExit?.();
    });
    // Push past the 90s confirm window, letting the interval fire.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(95_000);
    });

    expect(onSignedIn).not.toHaveBeenCalled();
    expect(screen.getByText(/couldn’t confirm the sign-in/i)).toBeTruthy();
    const retry = screen.getByRole("button", { name: /try again/i });
    expect(retry).toBeTruthy();
    // And the spinner is gone — nothing is running, so nothing should claim to be.
    expect(screen.queryByText(/waiting for your browser/i)).toBeNull();

    // Retry re-runs the login: a PTY that has exited cannot be restarted in place, so it remounts.
    await act(async () => {
      retry.click();
    });
    expect(screen.queryByText(/couldn’t confirm/i)).toBeNull();
    expect(screen.getByTestId("pty")).toBeTruthy();
  });

  it("probes the account's own config dir when one is given", async () => {
    render(<ClaudeSignIn configDir="/acc/dir" onSignedIn={vi.fn()} />);
    await screen.findByTestId("pty");
    expect(lastSpawn?.args.at(-1)).toContain("CLAUDE_CONFIG_DIR");
    checkClaudeAuthStatus.mockResolvedValue(auth(true));
    await act(async () => {
      fireExit?.();
    });
    await waitFor(() => expect(checkClaudeAuthStatus).toHaveBeenCalledWith("/acc/dir"));
  });

  // THE ADD-AN-ACCOUNT LOGIN COULD NEVER SPAWN (sparkle-mahbf).
  //
  // `pty_spawn` refuses any supplied `cwd` that does not resolve INSIDE `<app_data>/worktrees`
  // ("pty_spawn: cwd is outside the managed worktrees directory" — see validate_spawn_inner in
  // pty.rs). An account's config dir is `<app_data>/accounts/<id>`, a SIBLING of `worktrees`, so
  // handing it over as the cwd made every named-account login a guaranteed rejection: the pane
  // painted "Couldn't start the agent." and "Start again" re-ran the identical doomed spawn, which
  // is exactly the "sign-in page does nothing" the founder hit. The machine's own `~/.claude` login
  // passes no configDir, so it kept working — which is why only ADDING an account was broken.
  //
  // The config dir is targeted by `CLAUDE_CONFIG_DIR` in the exec string (asserted above), never by
  // the cwd, so there is nothing to replace it with: a null cwd is the contract pty.rs documents for
  // "the pre-worktree `claude login` flows", and it falls back to the managed app-data dir.
  // TWO ACCOUNTS' SIGN-INS MUST NOT SHARE ONE PTY SESSION (bead sparkle-znusx).
  //
  // The agentId IS the `PtyManager.sessions` key (`HashMap<String, PtySession>`), and `pty_spawn`
  // inserts with `sessions.insert`, which REPLACES silently. pty.rs states the consequence: the
  // first `PtySession` is "dropped on the floor — its child keeps running … and is invisible to
  // every surface in the app". For a sign-in that orphan is a live `claude auth login` still holding
  // the PREVIOUS account's CLAUDE_CONFIG_DIR *and* the loopback OAuth callback listener — so the
  // browser redirect completes into the wrong account's config dir.
  //
  // This is not hypothetical. On the founder's machine all five accounts were registered with the
  // right login and three then drifted onto one identity; `account-identity-log.json` shows "DROdio
  // Gmail CHANGED-TO superadmin@storytell.ai" at the exact second "FC SuperAdmin" was created, 13
  // seconds before FC SuperAdmin's own dir got it.
  //
  // Asserts the SIDE EFFECT (two distinct session keys exist at once), not the precondition. Against
  // the pre-fix id — `claude-signin-${attempt}` — both mounts are `claude-signin-0` and this fails.
  it("gives each account's sign-in its own PTY session id", async () => {
    render(<ClaudeSignIn configDir="/acc/gmail" onSignedIn={vi.fn()} />);
    render(<ClaudeSignIn configDir="/acc/superadmin" onSignedIn={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByTestId("pty")).toHaveLength(2));

    const ids = spawns.map((s) => s.agentId);
    expect(new Set(ids).size).toBe(ids.length);

    // …and each id belongs to the dir its OWN exec targets. Pairing them is the point: two unique
    // ids that were swapped between the accounts would satisfy the check above and still write each
    // login into the other's dir.
    for (const s of spawns) {
      const dir = /CLAUDE_CONFIG_DIR='([^']+)'/.exec(s.args.at(-1) ?? "")?.[1];
      expect(dir).toBeTruthy();
      expect(s.agentId).toBe(claudeSignInPtyId(dir, 0));
    }
  });

  // The default account (no configDir) is a namespace of its own, and must not collide with a named
  // account either — it is the one config dir whose login is the machine-wide `~/.claude` one.
  it("keeps the default account's sign-in distinct from a named account's", async () => {
    render(<ClaudeSignIn onSignedIn={vi.fn()} />);
    render(<ClaudeSignIn configDir="/acc/gmail" onSignedIn={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByTestId("pty")).toHaveLength(2));
    const ids = spawns.map((s) => s.agentId);
    expect(new Set(ids).size).toBe(2);
  });

  it("never hands the account config dir to the PTY as its cwd", async () => {
    render(<ClaudeSignIn configDir="/acc/dir" onSignedIn={vi.fn()} />);
    await screen.findByTestId("pty");
    // The account is still targeted — by env, which is the mechanism that actually works.
    expect(lastSpawn?.args.at(-1)).toContain("CLAUDE_CONFIG_DIR='/acc/dir'");
    // …and NOT by a cwd the spawn guard will reject.
    expect(lastSpawn?.cwd).toBeUndefined();
  });
});
