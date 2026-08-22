import { useEffect, useState } from "react";
import { C, MODAL_SHADOW, SCRIM } from "../theme/colors";
import { FONT_UI, RADIUS } from "../theme/scale";
import type { Account } from "../services/accountStore";
import { ClaudeSignIn } from "./ClaudeSignIn";
import { AccountTokenForm } from "./AccountTokenForm";
import { ModalLayer } from "./ModalLayer";

// The integrator seam for AccountsScreen's `onLogin` (multi Claude Max design, Task 4). After
// "Add account" creates an empty config dir, the user must complete a normal `claude login` (browser
// OAuth) INTO that dir so the genuine binary stores its own credentials there — Sparkle never sees
// them. We do that by spawning the user's real `claude` interactively in a PTY with
// CLAUDE_CONFIG_DIR pointed at the new account's dir, surfaced in a terminal the user can drive.
//
// This is the one place AccountsScreen's "must NOT import the spawn path" rule is satisfied from the
// outside: the modal (mounted by TopBar) owns the PTY; AccountsScreen just hands back the Account.

export function AccountLoginModal({ account, onClose }: { account: Account; onClose: () => void }) {
  // The sign-in flow itself — binary resolution, the `claude auth login` PTY, and confirming the
  // credential actually landed — lives in ClaudeSignIn, shared with the first-run auth gate.
  //
  // It used to be duplicated here, and the duplicate carried the same bug: both copies built
  // `claude login`, which is not a subcommand, so the PTY opened a REPL and OAuth never ran. One
  // implementation is the fix for that class of drift, not just for the instance.
  //
  // `configDir` targets this account's own credentials rather than the machine-wide login.

  // The browser OAuth flow (ClaudeSignIn) is the SECONDARY, opt-in path — token-based is the
  // recommended one above it. OAuth mints a token that expires in a few hours, so we do not start
  // its PTY (which is what pops the browser) until the user explicitly asks for it.
  //
  // SCOPED TO THE ACCOUNT IT WAS OPENED FOR, not a bare boolean (roborev). KebabMenu keeps ONE
  // AccountLoginModal mounted and swaps `account` beneath it (a second "Log in" from the screen
  // behind the backdrop is reachable), and this state is not remounted with it. A bare
  // `oauthOpen=true` would survive a swap and auto-start the swapped-in account's browser PTY with
  // no click — the exact thing the gate exists to prevent.
  //
  // Two parts, both required:
  //   1. Derive `oauthOpen` by matching the CURRENT account's id — during render, so a swapped-in
  //      account (different id) is closed on the very first frame, with no window in which its PTY
  //      could mount. Keyed on `account.id`, which is unique by construction and never empty; the
  //      config dir can be empty for a legacy default, and two empty-configDir accounts would
  //      collide on that key and reproduce the original auto-pop.
  //   2. Clear the opt-in whenever the account changes, so returning to an account it was once
  //      granted for (A → B → A) does NOT re-arm it — otherwise the match in (1) would re-open A's
  //      surface on the way back, with no click in that visit. The effect runs after the swap
  //      render, whose derivation already showed the new account closed, so there is no interim pop.
  // Because a swap always closes the surface, ClaudeSignIn is unmounted and remounted per opt-in —
  // which is why the account's stale sign-in verdict can no longer be inherited without a fresh key.
  //
  // Both parts are load-bearing: (2) alone (a bare boolean reset by the effect) would still mount the
  // swapped-in account's PTY for the one render between the swap and the effect firing; (1) alone
  // would re-arm on A → B → A. jsdom flushes the effect synchronously and cannot observe that interim
  // frame, so the A → B → A test guards (2) while (1)'s race-safety is verified by reasoning, not a
  // unit test — do not "simplify" it to a bare boolean on the strength of a green suite.
  const [oauthOpenFor, setOauthOpenFor] = useState<string | null>(null);
  const oauthOpen = oauthOpenFor === account.id;
  useEffect(() => setOauthOpenFor(null), [account.id]);

  // `zIndex: 120` only outranks anything if this competes at ROOT, and it is mounted from
  // Concierge/KebabMenu — inside the concierge column's `CONCIERGE_LIFT_Z` stacking context, which
  // would flatten it to layer 3 and let a pull tab at 4 paint over it. ModalLayer portals it out.
  return (
    <ModalLayer>
      <div
        data-testid="account-login-backdrop"
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: SCRIM,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 120,
        }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            width: 760,
            maxWidth: "92vw",
            height: 520,
            maxHeight: "85vh",
            // THE SCROLL IS ON THE PROSE BELOW, NOT HERE. This card's ONLY dismiss control is the
            // "Done" button in the header row, so making the card the scrollport would scroll the
            // way out off the screen on exactly the short window this ceiling exists for. The PTY
            // region keeps its own `flex: 1` sizing untouched — wrapping it in a scroll container
            // would resize the terminal.
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            background: C.dialogSurface,
            border: `1px solid ${C.dialogEdge}`,
            borderRadius: RADIUS.modal,
            padding: 16,
            color: C.cream,
            fontFamily: FONT_UI,
            boxShadow: MODAL_SHADOW,
          }}
        >
          {/* PINNED — this row holds the only way out of the modal. */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flex: "0 0 auto" }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Log in to “{account.nickname}”</div>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: "transparent",
                border: `1px solid ${C.muted}`,
                borderRadius: RADIUS.input,
                color: C.cream,
                fontSize: 12,
                padding: "4px 10px",
                cursor: "pointer",
              }}
            >
              Done
            </button>
          </div>
          {/* THE SCROLLPORT: the explanatory prose, which is what a short window has to give up.
              It scrolls here rather than on the card, so "Done" above and the terminal below both
              stay put.

              GROWS TO FILL when OAuth is closed (roborev). The card is a fixed 520px, sized when the
              ClaudeSignIn terminal took the remainder via `flex: 1`. That terminal is now behind the
              opt-in, so in the default state — every open of the modal — the body was the only child
              and, at `0 1 auto`, left the bottom half of the card blank. `1 1 auto` when closed lets
              it take the slack; when OAuth is open we go back to `0 1 auto` so the terminal's own
              `flex: 1` container keeps its sizing untouched. */}
          <div
            data-testid="account-login-body"
            style={{ flex: oauthOpen ? "0 1 auto" : "1 1 auto", minHeight: 0, overflowY: "auto" }}
          >
          <p style={{ fontSize: 12, color: C.muted, marginTop: 0, lineHeight: 1.4 }}>
            Log in to your Claude Code account. Sparkle never sees your credentials.
          </p>
          {/* The default account IS the user's real ~/.claude, so "this account's own config folder"
              would be actively misleading here — the login it writes is the one every `claude`
              invocation on the machine uses. Say so plainly rather than implying isolation. */}
          <p
            style={{
              fontSize: 12,
              color: account.isDefault ? C.amber : C.muted,
              marginTop: 0,
              lineHeight: 1.4,
            }}
          >
            {/* NOT "system-wide" / "everywhere" (knightwatch probe 3). That claim is FALSE for the
                exact case this feature exists for: a legacy default carries `configDir =
                $HOME/.claude`, so signing in here writes `$HOME/.claude/.claude.json` while a plain
                terminal `claude` reads `$HOME/.claude.json` and is untouched. A warning that
                overstates the blast radius is an instruction the user will follow — it talks them
                out of a sign-in that would not have done what it threatened. Name the directory and
                let it be checkable, rather than asserting a scope we cannot verify from here. */}
            {account.isDefault
              ? `Signing in here changes the Claude login Sparkle uses for this account, stored in ${account.configDir || "~/.claude.json"}. If that is also the config your terminal uses, it changes there too.`
              : "Credentials are stored in this account’s own config folder, separate from your other accounts."}
          </p>
          {/* The RECOMMENDED path: a pasted `claude setup-token` (≈1-year, subscription billing).
              Closes the modal on a CONFIRMED login, same as the PTY path. Offered for BOTH "Add
              account" and "Renew Login" (this modal serves both). */}
          <AccountTokenForm configDir={account.configDir} onSaved={onClose} />
          {/* The SECONDARY, opt-in OAuth path. Until the user clicks the button its terminal is not
              even mounted, so the browser never pops on its own — only token-based (above) is
              offered by default. */}
          {!oauthOpen && (
            <div data-testid="account-oauth-teaser" style={{ marginTop: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.cream }}>
                Alternative: OAuth login
              </div>
              <button
                type="button"
                data-testid="account-oauth-open"
                onClick={() => setOauthOpenFor(account.id)}
                style={{
                  marginTop: 8,
                  background: "transparent",
                  border: `1px solid ${C.muted}`,
                  borderRadius: RADIUS.input,
                  color: C.cream,
                  fontSize: 12,
                  fontWeight: 600,
                  padding: "6px 12px",
                  cursor: "pointer",
                }}
              >
                Click here to open a browser login window.
              </button>
              <p style={{ fontSize: 12, color: C.muted, margin: "8px 0 0", lineHeight: 1.4 }}>
                Not recommended, as you may have to re-auth every couple of hours.
              </p>
            </div>
          )}
          </div>
          {oauthOpen && (
            <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              {/* Closes on a CONFIRMED sign-in rather than on the PTY exiting. The old wiring closed
                  on exit, which dismissed the modal while the user was still on the OAuth page in
                  their browser — and reported nothing when the login had in fact failed. */}
              {/* No `key` remount guard is needed here any more (knightwatch probe 2). That guard
                  existed because ClaudeSignIn used to stay mounted across an account swap and its
                  `done`/`confirming`/`unconfirmed` state would let the new account inherit the old
                  one's verdict. The opt-in gate now CLOSES on every account change (see `oauthOpen`
                  above), so this surface is unmounted and freshly remounted per opt-in — a swapped-in
                  account can never see a prior account's ClaudeSignIn instance at all. */}
              <ClaudeSignIn configDir={account.configDir} onSignedIn={onClose} />
            </div>
          )}
        </div>
      </div>
    </ModalLayer>
  );
}
