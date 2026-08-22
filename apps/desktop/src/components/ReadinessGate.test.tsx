// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type { ClaudeAuthStatus, AuthStatusSource } from "../preflight";
import type { Account, Identity, Usage } from "../services/accountStore";
import type { AccountState } from "../services/accountSelection";

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

// The ROTATION read. Only `loadAccountState` (the one-shot accounts+identities+usage bundle) and the
// background live-usage rows are stubbed; the rest of accountSelection AND all of accountStore stay
// REAL, so `eligibleAccounts` / `pickAccount` / `accountDisplay` / `setPreferredAccountId` run their
// production logic against the seeded state — the gate's block-vs-banner and steering decisions are
// exercised for real, not mocked away.
const loadAccountStateMock = vi.fn();
const liveUsageRowsMock = vi.fn(() => []);
vi.mock("../services/accountSelection", async (orig) => {
  const actual = await orig<typeof import("../services/accountSelection")>();
  return {
    ...actual,
    loadAccountState: (...a: unknown[]) => loadAccountStateMock(...a),
    liveUsageRows: () => liveUsageRowsMock(),
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

import { ReadinessGate, READINESS_AUTH_BANNER_TESTID, ensureUsablePreferred } from "./ReadinessGate";
import {
  rotationOutIds,
  setAccountInRotation,
  ROTATION_OUT_STORAGE_KEY,
  RESCUED_ONTO_STORAGE_KEY,
} from "../services/rotationState";
import { reportClaudeAuthFailed, resetClaudeAuthSignalForTests } from "../services/claudeAuthSignal";
import {
  getPreferredAccountId,
  setPreferredAccountId,
  clearPreferredAccount,
  pickAccount,
} from "../services/accountStore";
import { getCredentialHealth, resetCredentialHealthForTests } from "../services/credentialHealth";

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

// ── Account-store fixtures ────────────────────────────────────────────────────────────────────
const acct = (id: string, over: Partial<Account> = {}): Account => ({
  id,
  nickname: id,
  configDir: `/cfg/${id}`,
  isDefault: false,
  createdAt: 0,
  ...over,
});
const ident = (id: string, email: string | null, organization: string | null = null): Identity => ({
  id,
  email,
  organization,
  accountUuid: email ? `uuid-${id}` : null,
});
const usageRow = (id: string, over: Partial<Usage> = {}): Usage => ({
  id,
  tokens5h: 0,
  tokens7d: 0,
  exhaustedUntil: null,
  ...over,
});
const accountState = (over: Partial<AccountState> = {}): AccountState => ({
  accounts: [],
  usage: [],
  identities: [],
  ceilings: [],
  failed: false,
  ...over,
});

// The default account the gate probes — signed in by its RECORDED email even after its OAuth lapses.
const DEFAULT_ACCT = acct("default", {
  isDefault: true,
  nickname: "DROdio Personal",
  configDir: "",
});
const DEFAULT_IDENT = ident("default", "drodio@personal.com", "Personal Org");
// A healthy alternate account in the rotation.
const WORK_ACCT = acct("work", { nickname: "DROdio Work" });
const WORK_IDENT = ident("work", "drodio@work.com", "Amforge");

beforeEach(() => {
  vi.clearAllMocks();
  resetClaudeAuthSignalForTests();
  resetCredentialHealthForTests();
  localStorage.clear();
  liveUsageRowsMock.mockReturnValue([]);
  // Default: a rotation with NO usable alternative (single default account), so every existing
  // auth-failure test still resolves to the full-screen BLOCK it asserts.
  loadAccountStateMock.mockResolvedValue(
    accountState({
      accounts: [DEFAULT_ACCT],
      identities: [DEFAULT_IDENT],
      usage: [usageRow("default")],
    }),
  );
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
    // A healthy default never consults the rotation.
    expect(loadAccountStateMock).not.toHaveBeenCalled();
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

  // THE CENTRAL CASE for a SINGLE-account machine. A fully-installed machine whose only account's
  // session has lapsed — the founder's second machine — is a genuine dead end, and still blocks.
  it("installed but expired, no other usable account → BLOCKS with the sign-in surface", async () => {
    checkPrereqs.mockResolvedValue(report());
    checkClaudeAuthStatus.mockResolvedValue(auth(false));
    render(app);
    expect(await screen.findByText("CLAUDE SIGN IN")).toBeTruthy();
    expect(screen.queryByText("SETUP CHECKLIST")).toBeNull();
    // No non-blocking banner — this is the real dead end.
    expect(screen.queryByTestId(READINESS_AUTH_BANNER_TESTID)).toBeNull();
    // The copy must name the expiry rather than greeting them as a new user.
    expect(screen.getByText(/sign-in expired/i)).toBeTruthy();
  });

  it("a fresh machine with nothing recorded gets first-run copy, not expiry copy", async () => {
    checkPrereqs.mockResolvedValue(report());
    checkClaudeAuthStatus.mockResolvedValue({ ...auth(false, "absent"), email: null });
    // Fresh machine: no accounts registered at all → no usable alternative → block (sign-in).
    loadAccountStateMock.mockResolvedValue(accountState({}));
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

  // ══ THE CREDENTIAL-HEALTH PUBLISHER (bead sparkle-s8xi35) ══════════════════════════════════════
  // The gate is the ONE authoritative computer of "all accounts expired": a full-screen BLOCK is
  // exactly that fact. This asserts it PUBLISHES that fact into `credentialHealth`, which the send
  // path, the auto-dispatch and the proactive scheduler read. A wiring bug needs a wiring test — the
  // pure `authGateDecision` is already covered, but nothing proved the gate feeds it into the state.
  // Verified to FAIL with the publishing effect removed (the store stays "ok" on a block).
  it("publishes credential-health = expired while it BLOCKS, and clears it on a confirmed sign-in", async () => {
    checkPrereqs.mockResolvedValue(report());
    // Expired then healthy, so the sign-in re-probe recovers — the self-healing half of the state.
    checkClaudeAuthStatus.mockResolvedValueOnce(auth(false)).mockResolvedValue(auth(true));
    render(app);
    const btn = await screen.findByText("CLAUDE SIGN IN");
    // The block is on screen → the one state the consumers gate on is expired.
    await waitFor(() => expect(getCredentialHealth()).toBe("expired"));

    await act(async () => {
      btn.click();
    });
    // The human signed in → the gate re-probes, the decision leaves "block", the state self-heals.
    await waitFor(() => expect(screen.queryByText("CLAUDE SIGN IN")).toBeNull());
    expect(getCredentialHealth()).toBe("ok");
  });

  it("does NOT publish expired when a healthy alternative keeps the app working (banner, not block)", async () => {
    checkPrereqs.mockResolvedValue(report());
    checkClaudeAuthStatus.mockResolvedValue(auth(false));
    // A rotation WITH a usable alternative → banner, not block. The default lapsed but the app keeps
    // running on another account, so this is not the all-expired dead end and must not gate sends.
    loadAccountStateMock.mockResolvedValue(
      accountState({
        accounts: [DEFAULT_ACCT, WORK_ACCT],
        identities: [DEFAULT_IDENT, WORK_IDENT],
        usage: [usageRow("default"), usageRow("work")],
      }),
    );
    render(app);
    expect(await screen.findByTestId(READINESS_AUTH_BANNER_TESTID)).toBeTruthy();
    expect(screen.queryByText("CLAUDE SIGN IN")).toBeNull();
    expect(getCredentialHealth()).toBe("ok");
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

  // ── ROTATION AWARENESS — the founder's SIX-account machine ─────────────────────────────────────

  // THE CENTRAL NEW CASE. The DEFAULT account's session lapsed, but another account is healthy. The
  // app must NOT full-screen block; it shows a non-blocking banner naming the expired account, and it
  // steers the fleet preference onto the healthy account so spawns keep working.
  it("default expired BUT another account usable → NO block; shows a naming banner + steers preference", async () => {
    checkPrereqs.mockResolvedValue(report());
    checkClaudeAuthStatus.mockResolvedValue(auth(false));
    // DEFAULT is deliberately NOT first, so "name the default" is distinguishable from "name the
    // first account" (the task's explicit warning) and steering must skip the default, not accounts[0].
    loadAccountStateMock.mockResolvedValue(
      accountState({
        accounts: [WORK_ACCT, DEFAULT_ACCT],
        identities: [WORK_IDENT, DEFAULT_IDENT],
        usage: [usageRow("work"), usageRow("default")],
      }),
    );
    render(app);

    // The non-blocking banner appears…
    const banner = await screen.findByTestId(READINESS_AUTH_BANNER_TESTID);
    // …and the full-screen block does NOT: no sign-in PTY overlay is mounted.
    expect(screen.queryByText("CLAUDE SIGN IN")).toBeNull();
    // The app itself is never covered.
    expect(screen.getByText("APP")).toBeTruthy();
    // The banner NAMES the expired (default) account — nickname, not the healthy alternate's.
    expect(banner.textContent).toContain("DROdio Personal");
    expect(banner.textContent).not.toContain("DROdio Work");

    // SIDE EFFECT: the fleet preference now points at the HEALTHY account, so spawns route there.
    await waitFor(() => expect(getPreferredAccountId()).toBe("work"));
  });

  // PAIRED NEGATIVE. Same shape, but every non-default account is unusable (one never signed in, one
  // rate-limited). With no usable alternative it IS the dead end → full-screen block, no banner.
  it("default expired AND no other account usable (all signed-out/exhausted) → full-screen block", async () => {
    checkPrereqs.mockResolvedValue(report());
    checkClaudeAuthStatus.mockResolvedValue(auth(false));
    loadAccountStateMock.mockResolvedValue(
      accountState({
        accounts: [
          DEFAULT_ACCT,
          acct("loggedout", { nickname: "Never signed in" }),
          acct("walled", { nickname: "Rate limited" }),
        ],
        identities: [
          DEFAULT_IDENT,
          ident("loggedout", null), // email null → not signed in → not eligible
          ident("walled", "walled@example.com"),
        ],
        usage: [
          usageRow("default"),
          usageRow("loggedout"),
          usageRow("walled", { exhaustedUntil: Date.now() + 60 * 60 * 1000 }), // observed wall
        ],
      }),
    );
    render(app);
    expect(await screen.findByText("CLAUDE SIGN IN")).toBeTruthy();
    expect(screen.queryByTestId(READINESS_AUTH_BANNER_TESTID)).toBeNull();
    // The preference is NOT steered when there is nothing usable to steer to.
    expect(getPreferredAccountId()).toBeUndefined();

  });

  // The re-login UI must let the user tell WHICH account to fix. In the BLOCK screen, render the
  // expired account's nickname + email + org — cross-referenced from the store, not the (often-null)
  // probe email.
  it("names the expired account by nickname + email + org in the full-screen block", async () => {
    checkPrereqs.mockResolvedValue(report());
    // Probe email is null (the common expiry shape); the store must supply the identity.
    checkClaudeAuthStatus.mockResolvedValue({ ...auth(false), email: null });
    loadAccountStateMock.mockResolvedValue(
      accountState({
        accounts: [DEFAULT_ACCT],
        identities: [DEFAULT_IDENT],
        usage: [usageRow("default")],
      }),
    );
    render(app);
    await screen.findByText("CLAUDE SIGN IN");
    expect(screen.getByText("DROdio Personal")).toBeTruthy();
    expect(screen.getByText("drodio@personal.com")).toBeTruthy();
    expect(screen.getByText("Personal Org")).toBeTruthy();
  });

  // …and the SAME naming in the non-blocking banner.
  it("names the expired account by nickname + email in the non-blocking banner", async () => {
    checkPrereqs.mockResolvedValue(report());
    checkClaudeAuthStatus.mockResolvedValue({ ...auth(false), email: null });
    // DEFAULT second again — the banner must name the probed default, not accounts[0].
    loadAccountStateMock.mockResolvedValue(
      accountState({
        accounts: [WORK_ACCT, DEFAULT_ACCT],
        identities: [WORK_IDENT, DEFAULT_IDENT],
        usage: [usageRow("work"), usageRow("default")],
      }),
    );
    render(app);
    const banner = await screen.findByTestId(READINESS_AUTH_BANNER_TESTID);
    expect(banner.textContent).toContain("DROdio Personal");
    expect(banner.textContent).toContain("drodio@personal.com");
    // NOT the healthy alternate that happens to sit first in the list.
    expect(banner.textContent).not.toContain("DROdio Work");
  });

  // FAIL OPEN. A throwing store read must never lock the user out — it degrades to the non-blocking
  // banner, never the full-screen block.
  it("a throwing rotation read does NOT block (fails open to a banner)", async () => {
    checkPrereqs.mockResolvedValue(report());
    checkClaudeAuthStatus.mockResolvedValue(auth(false));
    loadAccountStateMock.mockRejectedValue(new Error("accounts ipc down"));
    render(app);
    // Not blocked: the app stays visible and no sign-in PTY is force-mounted.
    expect(await screen.findByTestId(READINESS_AUTH_BANNER_TESTID)).toBeTruthy();
    expect(screen.queryByText("CLAUDE SIGN IN")).toBeNull();
    expect(screen.getByText("APP")).toBeTruthy();
  });

  // A store that reports `failed: true` (IPC hiccup, empty arrays) is UNKNOWN, not "no accounts" —
  // it also fails open to a banner rather than blocking.
  it("a failed:true rotation read does NOT block (fails open to a banner)", async () => {
    checkPrereqs.mockResolvedValue(report());
    checkClaudeAuthStatus.mockResolvedValue(auth(false));
    loadAccountStateMock.mockResolvedValue(accountState({ failed: true }));
    render(app);
    expect(await screen.findByTestId(READINESS_AUTH_BANNER_TESTID)).toBeTruthy();
    expect(screen.queryByText("CLAUDE SIGN IN")).toBeNull();
    expect(screen.getByText("APP")).toBeTruthy();
  });

  // STEERING must not clobber a preference the user already set to a usable account.
  it("does NOT overwrite an existing preference that already names a usable account", async () => {
    setPreferredAccountId("work2");
    checkPrereqs.mockResolvedValue(report());
    checkClaudeAuthStatus.mockResolvedValue(auth(false));
    loadAccountStateMock.mockResolvedValue(
      accountState({
        accounts: [DEFAULT_ACCT, acct("work1", { nickname: "Work One" }), acct("work2", { nickname: "Work Two" })],
        identities: [DEFAULT_IDENT, ident("work1", "w1@example.com"), ident("work2", "w2@example.com")],
        usage: [usageRow("default"), usageRow("work1"), usageRow("work2")],
      }),
    );
    render(app);
    await screen.findByTestId(READINESS_AUTH_BANNER_TESTID);
    // Preference is untouched — not moved to work1 despite work1 also being usable.
    expect(getPreferredAccountId()).toBe("work2");
  });

  // The banner's "Sign in" opens the sign-in surface ON DEMAND (user-initiated), without the app ever
  // having been force-blocked.
  it("banner's Sign in opens the sign-in surface on demand", async () => {
    checkPrereqs.mockResolvedValue(report());
    checkClaudeAuthStatus.mockResolvedValue(auth(false));
    loadAccountStateMock.mockResolvedValue(
      accountState({
        accounts: [DEFAULT_ACCT, WORK_ACCT],
        identities: [DEFAULT_IDENT, WORK_IDENT],
        usage: [usageRow("default"), usageRow("work")],
      }),
    );
    render(app);
    const banner = await screen.findByTestId(READINESS_AUTH_BANNER_TESTID);
    expect(screen.queryByText("CLAUDE SIGN IN")).toBeNull();
    const signIn = within(banner).getByText("Sign in");
    await act(async () => {
      signIn.click();
    });
    expect(await screen.findByText("CLAUDE SIGN IN")).toBeTruthy();
  });
});


// ── THE FIFTH PREFERENCE WRITER ────────────────────────────────────────────────────────────────
// `ensureUsablePreferred` is the auth-lapse rescue: it moves the fleet preference onto a healthy
// account so future spawns stop landing on an expired default. It is silent and automatic, which is
// how it came to be the one writer that knew nothing about the rotation opt-out — in BOTH directions.
describe("ensureUsablePreferred and the rotation opt-out", () => {
  const acc = (id: string): Account => ({
    id,
    nickname: id,
    configDir: `/cfg/${id}`,
    isDefault: false,
    createdAt: 0,
  });
  const use = (id: string, tokens: number): Usage => ({
    id,
    tokens5h: tokens,
    tokens7d: tokens,
    exhaustedUntil: null,
  });

  afterEach(() => {
    localStorage.removeItem(ROTATION_OUT_STORAGE_KEY);
    localStorage.removeItem(RESCUED_ONTO_STORAGE_KEY);
    clearPreferredAccount();
  });

  it("re-points away from a preference the user took OUT of rotation", () => {
    // It used to read an opted-out `current` as "already usable → leave it" and not even try, so the
    // rescue did nothing while the fleet sat on the account it was rescuing them from.
    setPreferredAccountId("a");
    setAccountInRotation("a", false);

    ensureUsablePreferred([acc("a"), acc("b")], [use("a", 10), use("b", 20)], {});

    expect(getPreferredAccountId()).toBe("b");
  });

  it("leaves an in-rotation preference alone", () => {
    // The paired negative: a choice the user made on purpose is never overwritten, which is the
    // whole reason this function checks `current` first.
    setPreferredAccountId("a");
    ensureUsablePreferred([acc("a"), acc("b")], [use("a", 10), use("b", 20)], {});
    expect(getPreferredAccountId()).toBe("a");
  });

  it("prefers an in-rotation account when it picks a new one", () => {
    // `b` is the LOWER tally, so plain auto-pick takes it; the opt-out is what has to move the pick
    // to `c`. Asserting `c` is therefore evidence the exclusion reached `pickAccount`.
    setAccountInRotation("b", false);

    ensureUsablePreferred(
      [acc("b"), acc("c")],
      [use("b", 10), use("c", 20)],
      {},
    );

    expect(getPreferredAccountId()).toBe("c");
  });

  // THE "REPEATED PROBE" TEST LIVED HERE and its subject moved rather than vanished. It asserted
  // that an opt-out survives repeated focus events, which is still required — but it drove an
  // ORDINARY rescue first and then a single opt-out, and under the corrected rule that first click
  // legitimately gets one rescue. The property it existed for is now split across the two cases
  // above, each driving the branch it actually names: "does not fight the user when they take it out
  // AGAIN" holds the opt-out across four focus events after a genuine second answer, and "an ORDINARY
  // rescue does not spend the one-shot" pins the half that made the old version pass for the wrong
  // reason.

  it("rescues ONCE onto an opted-out account, because declining strands the fleet", () => {
    // THIS TEST HAS BEEN INVERTED TWICE and the history is the point, because both earlier
    // expectations were written on premises that turned out to be false.
    //
    // v1 asserted the rescue always writes and clears the opt-out — true to "keep the app working",
    // but `probe()` runs on every window focus, so it re-cleared the user's kebab click forever.
    // v2 asserted it always declines, on the reasoning that "`partitionAccounts` keeps a demoted
    // account in `eligible`, so `leastBad` still returns it and the spawn still happens". That is
    // false where it matters: `leastBad` runs only when `candidates` is EMPTY, and at
    // `chooseAccountForAgent` the lapsed default is STILL a candidate — its recorded email keeps it
    // in `signedInIds`, and it carries no wall and no live-spent row. So declining does not fall back
    // to the opted-out account; it falls onto the EXPIRED one, and every agent opens on a login
    // prompt. Steering off that account is the whole reason this rescue exists.
    setPreferredAccountId("gone");
    setAccountInRotation("b", false);

    ensureUsablePreferred([acc("b")], [use("b", 10)], {});

    // FIRST TIME: the app keeps working. The opt-out is revised, visibly — the card flips.
    expect(getPreferredAccountId()).toBe("b");
    expect(rotationOutIds().has("b")).toBe(false);
  });

  it("does not fight the user when they take it out AGAIN", () => {
    // THE SEQUENCE THE MODULE DOC DESCRIBES, driven end to end. An earlier version of this test began
    // with `b` IN rotation, so its first call went through the ORDINARY branch — it asserted the
    // one-shot being spent by a rescue that had contradicted nobody, and its
    // `rotationOutIds().has("b") === false` was vacuous because nothing had ever opted `b` out.
    setAccountInRotation("b", false);

    // FIRST answer: the rescue overrides it, because the alternative is stranding the fleet.
    ensureUsablePreferred([acc("b")], [use("b", 10)], {});
    expect(rotationOutIds().has("b")).toBe(false);
    expect(getPreferredAccountId()).toBe("b");

    setAccountInRotation("b", false); // SECOND answer — the deliberate one

    // Four more focus events. None of them may revert it.
    for (let i = 0; i < 4; i++) ensureUsablePreferred([acc("b")], [use("b", 10)], {});

    expect(rotationOutIds().has("b")).toBe(true);
    // …and no inert preference is left behind pointing at it.
    expect(getPreferredAccountId()).toBeUndefined();

    // AND WHERE A SPAWN ACTUALLY GOES, which neither storage assertion above can see. This came from
    // the retired "repeated probe" test and is re-homed rather than dropped: it ends in the same
    // state, and it is the only assertion here about the outcome the user cares about. With no
    // preference, selection auto-picks — `b` is DEMOTED by the opt-out, so a healthy sibling wins,
    // and `b` is still returned when it is all there is, because the opt-out never blocks.
    expect(
      pickAccount([acc("b"), acc("c")], [use("b", 10), use("c", 20)], {
        signedInIds: ["b", "c"],
        outOfRotationIds: rotationOutIds(),
      })?.id,
    ).toBe("c"); // `b` is CHEAPER — only the opt-out moves the pick
    expect(
      pickAccount([acc("b")], [use("b", 10)], {
        signedInIds: ["b"],
        outOfRotationIds: rotationOutIds(),
      })?.id,
    ).toBe("b");
  });

  it("an ORDINARY rescue does not spend the one-shot", () => {
    // The first finding this rule shipped with: marking on the path that steers onto an account the
    // user has said nothing about made their FIRST kebab click read as their second. The next focus
    // declined, and the fleet stranded on the expired default — permanently.
    ensureUsablePreferred([acc("b")], [use("b", 10)], {}); // ordinary: `b` was never opted out
    expect(getPreferredAccountId()).toBe("b");

    setAccountInRotation("b", false); // the user's FIRST answer

    ensureUsablePreferred([acc("b")], [use("b", 10)], {});

    // It must still be willing to rescue once, or the click above was read as an answer to a
    // question nobody asked.
    expect(rotationOutIds().has("b")).toBe(false);
  });

  it("an answered account stays answered when the pick alternates", () => {
    // A single last-wins string was reassigned out from under an answer already given: rescue onto
    // `b`, user takes `b` out, the pick returns `c` (lowest-usage-first, and usage moves as agents
    // run) so the memory became `c`, user takes `c` out, the pick returns `b` — and the guard missed.
    // Unbounded, just on a longer cycle. The memory is a set.
    setAccountInRotation("b", false);
    ensureUsablePreferred([acc("b")], [use("b", 10)], {}); // rescues over b's opt-out
    setAccountInRotation("b", false); // b: answered twice

    setAccountInRotation("c", false);
    ensureUsablePreferred([acc("c")], [use("c", 10)], {}); // rescues over c's opt-out
    setAccountInRotation("c", false); // c: answered twice

    // Back to `b`. Its answer must still stand.
    ensureUsablePreferred([acc("b")], [use("b", 10)], {});
    expect(rotationOutIds().has("b")).toBe(true);
    expect(rotationOutIds().has("c")).toBe(true);
  });

  it("a deliberate put-back starts a fresh episode", () => {
    // Otherwise the memory is once-ever: an account rescued over in March could never be rescued
    // onto again in June, however the fleet had changed since.
    setAccountInRotation("b", false);
    ensureUsablePreferred([acc("b")], [use("b", 10)], {});
    setAccountInRotation("b", false);
    ensureUsablePreferred([acc("b")], [use("b", 10)], {});
    expect(rotationOutIds().has("b")).toBe(true); // answered; the rescue stands off

    setAccountInRotation("b", true); // the user puts it back ON PURPOSE
    setAccountInRotation("b", false); // …and later takes it out again

    ensureUsablePreferred([acc("b")], [use("b", 10)], {});
    expect(rotationOutIds().has("b")).toBe(false); // a new episode, so it rescues once more
  });
});
