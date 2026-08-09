import { C, MODAL_SHADOW, SCRIM } from "../theme/colors";
import { FONT_UI, RADIUS } from "../theme/scale";
import type { Account } from "../services/accountStore";
import { ClaudeSignIn } from "./ClaudeSignIn";
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
              stay put. */}
          <div data-testid="account-login-body" style={{ flex: "0 1 auto", minHeight: 0, overflowY: "auto" }}>
          <p style={{ fontSize: 12, color: C.muted, marginTop: 0, lineHeight: 1.4 }}>
            Complete the normal Claude login below (it opens your browser). Sparkle never sees your
            credentials. Close when you’re done.
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
          </div>
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            {/* Closes on a CONFIRMED sign-in rather than on the PTY exiting. The old wiring closed
                on exit, which dismissed the modal while the user was still on the OAuth page in
                their browser — and reported nothing when the login had in fact failed. */}
            <ClaudeSignIn
              // `key` is load-bearing, not decoration (knightwatch probe 2). A second reachable
              // "Log in" swaps the account BENEATH this modal without unmounting it, and
              // ClaudeSignIn's `done` / `confirming` / `unconfirmed` are component state: without a
              // key they survive the swap, so the new account inherits the PREVIOUS account's
              // verdict — rendering "signed in" for one that was never signed into, and never
              // starting its PTY. Keying on the config dir remounts it, which is exactly the reset.
              key={account.configDir}
              configDir={account.configDir}
              onSignedIn={onClose}
            />
          </div>
        </div>
      </div>
    </ModalLayer>
  );
}
