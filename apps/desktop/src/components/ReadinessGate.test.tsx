// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ClaudeAuthStatus, AuthStatusSource } from "../preflight";

const checkPrereqs = vi.fn();
const checkClaudeAuthStatus = vi.fn();
vi.mock("../preflight", async (orig) => {
  // Keep the REAL `authIsDefinitelyExpired` / `authIsAbsent` — they are pure predicates the gate
  // uses to pick its copy, and stubbing them would let a wrong one pass unnoticed.
  const actual = await orig<typeof import("../preflight")>();
  return {
    ...actual,
    checkPrereqs: () => checkPrereqs(),
    checkClaudeAuthStatus: () => checkClaudeAuthStatus(),
  };
});

// Stub the (heavy, xterm-backed) install checklist so the gate test stays about the DECISION.
vi.mock("./SetupChecklist", () => ({
  SetupChecklist: ({ onReady }: { onReady: () => void }) => (
    <button onClick={onReady}>SETUP CHECKLIST</button>
  ),
}));

// Same for the sign-in surface: it owns a PTY. The gate's contract is that it MOUNTS this when auth
// is owed and dismisses when it reports success.
vi.mock("./ClaudeSignIn", () => ({
  ClaudeSignIn: ({ onSignedIn }: { onSignedIn: () => void }) => (
    <button onClick={onSignedIn}>CLAUDE SIGN IN</button>
  ),
}));

import { ReadinessGate } from "./ReadinessGate";
import { reportClaudeAuthFailed, resetClaudeAuthSignalForTests } from "../services/claudeAuthSignal";

const report = (over: Partial<Record<"git" | "node" | "claude", boolean>> = {}) => {
  const f = (installed: boolean) => ({ installed, path: installed ? "/x" : null });
  return { git: f(over.git ?? true), node: f(over.node ?? true), claude: f(over.claude ?? true) };
};

const auth = (loggedIn: boolean, source: AuthStatusSource = "cli"): ClaudeAuthStatus => ({
  loggedIn,
  source,
  email: loggedIn ? "me@example.com" : "stale@example.com",
  authMethod: null,
  subscriptionType: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetClaudeAuthSignalForTests();
});
afterEach(() => cleanup());

const app = (
  <ReadinessGate>
    <div>APP</div>
  </ReadinessGate>
);

describe("ReadinessGate", () => {
  it("installed + authenticated → renders children, NEVER shows a gate (invisible)", async () => {
    checkPrereqs.mockResolvedValue(report());
    checkClaudeAuthStatus.mockResolvedValue(auth(true));
    render(app);
    // Children paint immediately.
    expect(screen.getByText("APP")).toBeTruthy();
    await waitFor(() => expect(checkClaudeAuthStatus).toHaveBeenCalled());
    expect(screen.queryByText("SETUP CHECKLIST")).toBeNull();
    expect(screen.queryByText("CLAUDE SIGN IN")).toBeNull();
  });

  it("a missing dependency → overlays the install checklist, and never probes auth", async () => {
    checkPrereqs.mockResolvedValue(report({ claude: false }));
    render(app);
    expect(await screen.findByText("SETUP CHECKLIST")).toBeTruthy();
    // Children stay mounted underneath so the app reveals cleanly once setup completes.
    expect(screen.getByText("APP")).toBeTruthy();
    // claude absent → nothing to authenticate against, so we don't ask.
    expect(checkClaudeAuthStatus).not.toHaveBeenCalled();
  });

  // THE CENTRAL CASE. A fully-installed machine whose session has lapsed — the founder's second
  // machine. Under the old gate this was INVISIBLE (a recorded email read as signed in) and the user
  // discovered it by asking the concierge a question that could not be answered.
  it("installed but expired → BLOCKS with the sign-in surface, not the install checklist", async () => {
    checkPrereqs.mockResolvedValue(report());
    checkClaudeAuthStatus.mockResolvedValue(auth(false));
    render(app);
    expect(await screen.findByText("CLAUDE SIGN IN")).toBeTruthy();
    expect(screen.queryByText("SETUP CHECKLIST")).toBeNull();
    // The copy must name the expiry rather than greeting them as a new user.
    expect(screen.getByText(/sign-in expired/i)).toBeTruthy();
  });

  it("a fresh machine with nothing recorded gets first-run copy, not expiry copy", async () => {
    checkPrereqs.mockResolvedValue(report());
    checkClaudeAuthStatus.mockResolvedValue({ ...auth(false, "absent"), email: null });
    render(app);
    expect(await screen.findByText("CLAUDE SIGN IN")).toBeTruthy();
    expect(screen.getByText(/^Sign in to Claude$/)).toBeTruthy();
    expect(screen.queryByText(/expired/i)).toBeNull();
  });

  it("a confirmed sign-in re-probes and reveals the app", async () => {
    checkPrereqs.mockResolvedValue(report());
    checkClaudeAuthStatus.mockResolvedValueOnce(auth(false)).mockResolvedValue(auth(true));
    render(app);
    const btn = await screen.findByText("CLAUDE SIGN IN");
    await act(async () => {
      btn.click();
    });
    await waitFor(() => expect(screen.queryByText("CLAUDE SIGN IN")).toBeNull());
    expect(screen.getByText("APP")).toBeTruthy();
  });

  // The handoff the founder actually asked for: install runs unattended, then auth is the first
  // thing he is ASKED for. `onReady` must NOT dismiss straight into the app.
  it("finishing the installs hands off to the auth gate rather than opening the app", async () => {
    checkPrereqs.mockResolvedValueOnce(report({ claude: false })).mockResolvedValue(report());
    checkClaudeAuthStatus.mockResolvedValue(auth(false));
    render(app);
    const btn = await screen.findByText("SETUP CHECKLIST");
    await act(async () => {
      btn.click();
    });
    expect(await screen.findByText("CLAUDE SIGN IN")).toBeTruthy();
    expect(screen.queryByText("SETUP CHECKLIST")).toBeNull();
  });

  // WHAT MAKES THIS A GATE FOR "EVERY RUN AFTER" RATHER THAN JUST FIRST RUN. The app was healthy at
  // mount; the session dies later. Without the focus re-probe the gate would keep reporting the
  // stale healthy answer indefinitely.
  it("re-probes on window focus, so a session that dies mid-session still gets caught", async () => {
    checkPrereqs.mockResolvedValue(report());
    checkClaudeAuthStatus.mockResolvedValueOnce(auth(true)).mockResolvedValue(auth(false));
    render(app);
    await waitFor(() => expect(checkClaudeAuthStatus).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("CLAUDE SIGN IN")).toBeNull();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(await screen.findByText("CLAUDE SIGN IN")).toBeTruthy();
  });

  // The focus re-probe cannot cover a FOCUSED app whose concierge is the thing that discovers the
  // expiry — which is exactly how the founder hit it. The signal closes that hole.
  it("re-probes when something else reports an auth failure", async () => {
    checkPrereqs.mockResolvedValue(report());
    checkClaudeAuthStatus.mockResolvedValueOnce(auth(true)).mockResolvedValue(auth(false));
    render(app);
    await waitFor(() => expect(checkClaudeAuthStatus).toHaveBeenCalledTimes(1));

    await act(async () => {
      reportClaudeAuthFailed();
    });
    expect(await screen.findByText("CLAUDE SIGN IN")).toBeTruthy();
  });

  it("a broken probe does NOT block the app (fails open to the normal flow)", async () => {
    checkPrereqs.mockRejectedValue(new Error("ipc down"));
    render(app);
    await waitFor(() => expect(checkPrereqs).toHaveBeenCalled());
    expect(screen.queryByText("SETUP CHECKLIST")).toBeNull();
    expect(screen.queryByText("CLAUDE SIGN IN")).toBeNull();
    expect(screen.getByText("APP")).toBeTruthy();
  });

  // A fail-open `recorded` yes must not gate — the live probe simply couldn't speak.
  it("a recorded-only yes does not gate", async () => {
    checkPrereqs.mockResolvedValue(report());
    checkClaudeAuthStatus.mockResolvedValue(auth(true, "recorded"));
    render(app);
    await waitFor(() => expect(checkClaudeAuthStatus).toHaveBeenCalled());
    expect(screen.queryByText("CLAUDE SIGN IN")).toBeNull();
    expect(screen.getByText("APP")).toBeTruthy();
  });

  // THE ESCAPE HATCH. This gate blocks the entire app on a subprocess probe's word, so there has to
  // be a way out — and it must STAY out: re-blocking on the next focus event would be the same trap
  // with extra steps.
  it("Continue anyway dismisses the gate permanently for the session", async () => {
    checkPrereqs.mockResolvedValue(report());
    checkClaudeAuthStatus.mockResolvedValue(auth(false));
    render(app);
    const escape = await screen.findByText(/continue anyway/i);
    await act(async () => {
      escape.click();
    });
    await waitFor(() => expect(screen.queryByText("CLAUDE SIGN IN")).toBeNull());
    expect(screen.getByText("APP")).toBeTruthy();

    // A later focus (and a later auth-failure report) must not resurrect it.
    const callsBefore = checkClaudeAuthStatus.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      reportClaudeAuthFailed();
    });
    expect(screen.queryByText("CLAUDE SIGN IN")).toBeNull();
    expect(checkClaudeAuthStatus).toHaveBeenCalledTimes(callsBefore);
  });
});
