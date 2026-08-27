// @vitest-environment jsdom
//
// THE DEFECT (bead sparkle-p92mtz): an account card said nothing about HOW the account logs in, and
// nothing at a glance about whether that login is working. Two accounts side by side — one on a
// browser OAuth session, one on a pasted long-lived token, one of them dead — rendered identically.
//
// ── WHAT THIS FILE ASSERTS, AND WHAT IT DELIBERATELY DOES NOT ────────────────────────────────────
// It renders the REAL `AccountsScreen` with fixture accounts and asserts the SIDE EFFECT: the words
// on each card and the state of its dot. Every candidate state is MOUNTED AT ONCE, in one screen,
// because absence in a component that is not in the tree proves nothing — a badge keyed to the wrong
// field would still be "absent" from a card that was never rendered. With all five up together, each
// card is the control for the other four: the assertions below require that exactly the right label
// is painted on each and that the other two labels appear on NEITHER of the others by mistake.
//
// It does NOT assert contrast, size or position. jsdom loads no stylesheet and does no layout, so
// `getComputedStyle` reads empty for anything class-derived and every box is zero-sized; a test
// claiming to check either would be theatre. What IS real here is the INLINE declaration — this
// screen styles everything inline, so `element.style.background` is the actual authored value, and
// the two health inks are asserted to be different values rather than the same one twice.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountsScreen, type AccountsDeps } from "./AccountsScreen";
import { C } from "../theme/colors";
import type { Account, Identity, Usage } from "../services/accountStore";
import type { ClaudeAuthStatus } from "../preflight";

afterEach(cleanup);

const HOUR_MS = 3_600_000;

function acct(id: string): Account {
  return { id, nickname: id, configDir: `/cfg/${id}`, isDefault: false, createdAt: 0 };
}

function identity(id: string, over: Partial<Identity>): Identity {
  return {
    id,
    email: `${id}@example.com`,
    organization: null,
    accountUuid: `uuid-${id}`,
    ...over,
  };
}

/** A live CLI answer. `loggedIn: false` from `source: "cli"` is the ONLY shape that proves a session
 *  is dead — the same asymmetry `deriveRowLogin` is built on. */
function authStatus(loggedIn: boolean): ClaudeAuthStatus {
  return {
    loggedIn,
    source: "cli",
    email: "x@example.com",
    authMethod: "claude.ai",
    subscriptionType: "max",
  };
}

// ── THE FIVE STATES, MOUNTED TOGETHER ────────────────────────────────────────────────────────────
//
// Both methods × both healths, plus the honest unknown. `authMethod` is "claude.ai" on EVERY row on
// purpose: that is what `claude auth status` really reports for a pasted `claude setup-token` value
// as well as for a browser login, so a badge derived from it would label the token rows "OAuth".
// Only `Identity.authKind` — which Rust fills by reading the credential the config dir actually
// holds — can tell them apart, and these fixtures are what force that.
const ROWS = [
  { id: "oauth-ok", authKind: "oauth" as const, method: "OAuth login", health: "working" },
  { id: "token-ok", authKind: "token" as const, method: "Token login", health: "working" },
  { id: "oauth-dead", authKind: "oauth" as const, method: "OAuth login", health: "failing" },
  { id: "token-capped", authKind: "token" as const, method: "Token login", health: "failing" },
  { id: "no-login", authKind: null, method: "Login method unknown", health: "failing" },
];

const IDENTITIES: Identity[] = [
  identity("oauth-ok", { authKind: "oauth" }),
  identity("token-ok", { authKind: "token" }),
  // Signed in per the recorded identity — its `.claude.json` still names an email — but the live CLI
  // probe below says the session is dead. This is the case the identity read alone CANNOT catch.
  identity("oauth-dead", { authKind: "oauth" }),
  identity("token-capped", { authKind: "token" }),
  // Never signed into: no email, no uuid, and no credential for Rust to classify.
  identity("no-login", { email: null, accountUuid: null, authKind: null }),
];

function usageRows(now: number): Usage[] {
  return ROWS.map((r) => ({
    id: r.id,
    tokens5h: 0,
    tokens7d: 0,
    // ONLY the capped row carries an observed rate-limit wall. `exhaustedUntil` is epoch MS on this
    // side of the boundary (accountStore.mapUsage multiplies the Rust seconds by 1000).
    exhaustedUntil: r.id === "token-capped" ? now + HOUR_MS : null,
  }));
}

function deps(identities: Identity[]): Partial<AccountsDeps> {
  return {
    listAccounts: vi.fn(async () => ROWS.map((r) => acct(r.id))),
    getUsage: vi.fn(async () => usageRows(Date.now())),
    getIdentities: vi.fn(async () => identities),
    listCeilings: vi.fn(async () => []),
    getUsageLive: vi.fn(async () => {
      throw new Error("live usage unavailable in test");
    }),
    getAuthStatus: vi.fn(async (configDir?: string): Promise<ClaudeAuthStatus> => {
      return authStatus(configDir !== "/cfg/oauth-dead");
    }),
    addAccount: vi.fn(async () => acct("new")),
    setNickname: vi.fn(async () => {}),
    removeAccount: vi.fn(async () => {}),
    readSpawnLog: vi.fn(async () => []),
  };
}

async function renderScreen(identities: Identity[] = IDENTITIES) {
  render(<AccountsScreen onLogin={vi.fn()} deps={deps(identities)} />);
  await screen.findByTestId("account-login-badge-oauth-ok");
  // The auth probe resolves per account after mount; wait for the row it is decisive about to
  // settle, or the dead login would still be reading as healthy when the assertions run.
  await waitFor(() =>
    expect(screen.getByTestId("account-login-badge-oauth-dead").dataset.health).toBe("failing"),
  );
}

const ALL_LABELS = ["OAuth login", "Token login", "Login method unknown"];

describe("the account card says how the account logs in, and whether that login works", () => {
  it("paints each card's own login method and no other card's", async () => {
    await renderScreen();
    for (const row of ROWS) {
      const label = screen.getByTestId(`account-login-method-${row.id}`);
      expect(label.textContent).toBe(row.method);
      // The other two labels are absent FROM THIS CARD — the point of mounting all five at once.
      for (const other of ALL_LABELS.filter((l) => l !== row.method)) {
        expect(label.textContent).not.toBe(other);
      }
    }
    // And every label really is on screen somewhere, so "not that one" above is not vacuously true
    // over a screen that rendered nothing.
    for (const l of ALL_LABELS) expect(screen.getAllByText(l).length).toBeGreaterThan(0);
  });

  it("colours the dot green only for a login that is actually working", async () => {
    await renderScreen();
    // The two inks must be DIFFERENT values, or every assertion below passes against a single
    // hard-coded colour and the dot means nothing.
    expect(C.successInk).not.toBe(C.dangerInk);
    for (const row of ROWS) {
      const badge = screen.getByTestId(`account-login-badge-${row.id}`);
      const dot = screen.getByTestId(`account-login-health-${row.id}`);
      const label = screen.getByTestId(`account-login-method-${row.id}`);
      const ink = row.health === "working" ? C.successInk : C.dangerInk;
      const wrongInk = row.health === "working" ? C.dangerInk : C.successInk;
      expect(badge.dataset.health).toBe(row.health);
      // The dot is a styled element, never an emoji — this repo renders no emoji as icons.
      expect(dot.textContent).toBe("");
      expect(dot.style.background).toBe(ink);
      expect(dot.style.background).not.toBe(wrongInk);
      // The LABEL carries its ink explicitly too. A colour set only on an ancestor would not
      // re-resolve here, so the badge would read in one theme and vanish in the other.
      expect(label.style.color).toBe(ink);
    }
  });

  it("reads red for a dead session, a rate-limited account, and one never signed in — three separate causes", async () => {
    await renderScreen();
    // Each red card is red for a DIFFERENT reason, and each is proved distinct by a green control:
    //   • oauth-dead   — the live CLI probe says the session is gone (identity alone reads healthy)
    //   • token-capped — an observed `exhaustedUntil` wall, while it is fully signed in
    //   • no-login     — no identity at all
    expect(screen.getByTestId("account-login-badge-oauth-dead").dataset.health).toBe("failing");
    expect(screen.getByTestId("account-login-badge-token-capped").dataset.health).toBe("failing");
    expect(screen.getByTestId("account-login-badge-no-login").dataset.health).toBe("failing");
    // …and the same-method siblings stay green, so none of the three is a blanket red.
    expect(screen.getByTestId("account-login-badge-oauth-ok").dataset.health).toBe("working");
    expect(screen.getByTestId("account-login-badge-token-ok").dataset.health).toBe("working");
    // A rate-limited account is still SIGNED IN: its method is read and named, not blanked.
    expect(screen.getByTestId("account-login-method-token-capped").textContent).toBe("Token login");
  });

  it("says the method is unknown rather than guessing, when the backend does not report one", async () => {
    // A build whose Rust side predates `AccountIdentity.auth_kind`: every identity arrives with the
    // field absent. The badge must degrade to "Login method unknown" on EVERY card rather than
    // defaulting to the likelier answer — a wrong login type is a lie the user cannot check.
    await renderScreen(
      IDENTITIES.map(({ authKind: _dropped, ...rest }) => rest as Identity),
    );
    for (const row of ROWS) {
      expect(screen.getByTestId(`account-login-method-${row.id}`).textContent).toBe(
        "Login method unknown",
      );
    }
    // Health is a SEPARATE reading and survives the missing method — the dot still tells the truth.
    expect(screen.getByTestId("account-login-badge-oauth-ok").dataset.health).toBe("working");
    expect(screen.getByTestId("account-login-badge-oauth-dead").dataset.health).toBe("failing");
  });
});
