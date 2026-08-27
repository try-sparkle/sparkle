// The concierge column's AI-ENHANCEMENTS LOCKED STATE: what stands where the thread and the
// compose box would be when the paid half of the column isn't running.
//
// The approved design keeps the FREE half and locks only the paid one. Everything above this panel
// — the scope line, the needs-you counts, the per-project segments — is derived from local app
// state, costs nothing to run, and stays live (ConciergeColumn deliberately does NOT gate it). So
// the upsell sits directly beside live proof of its own value: three agents are waiting on you
// right there, and this is the thing that would answer them.
//
// The ACTION is the part that has to be right. Which of the three reasons we're in decides it (see
// ./conciergeAiLock): a switched-off setting is fixed in settings, not at a checkout; an unbought
// app is the existing $99 AiLockedNotice; an empty balance on a bought app is the existing Refill
// seam and must NEVER show a buy-the-app upsell. We reuse both of those components rather than
// growing private copies of them here.
//
// ══ AND, IN A DEV BUILD ONLY, THE REMEDY A DEVELOPER CAN ACTUALLY FOLLOW (bead sparkle-wfev6) ══
// A fresh dev profile has no Sparkle account at all, so it lands here every time, and the remedy on
// offer — buy the app — is not one a developer verifying a concierge change is going to run. That
// made the standing "verify this surface in a running build" instruction unexecutable: the column
// renders its locked state and there is nothing on screen naming a way through. The lock itself is
// correct and stays; what was missing was the DEV route beside it.
//
// {@link DevUnlockHint} is that route, and three things about it are deliberate:
//   • It is gated on `import.meta.env.DEV`, written INLINE so vite statically replaces it with
//     `false` in a `vite build` and Rollup drops the whole branch — the same single line that keeps
//     dev/devBypassAuth structurally dev-only. A shipped DMG cannot render it.
//   • It names `DEV_BYPASS_AUTH_FLAG` by importing the constant, so the copy cannot drift from the
//     flag `stores/authStore.refresh()` actually reads.
//   • It is NOT shown for `flag_off`. The bypass sets an entitled `me`; it does not turn a switched
//     -off setting on, so offering it there would be a remedy that does nothing — exactly the
//     dead-instruction failure AGENTS.md records ("a refusal that says 'do X instead' is an
//     instruction the user will follow"). `flag_off` already has a button that works.
// The full procedure, and what the bypass does and does not buy you, is in
// docs/orchestration-live-verification.md § 1a.
import type { CSSProperties } from "react";

import { C, FONT_WEIGHT, ON_BRAND_FILL } from "../../theme/colors";
import { useUiStore } from "../../stores/uiStore";
import { AiEnhancementsBadge } from "../AiEnhancementsBadge";
import { AiLockedNotice } from "../AiLockedNotice";
import { RefillLink } from "../OutOfCreditsNotice";
import type { ConciergeAiLockReason } from "./conciergeAiLock";
import { FONT_MONO, FONT_UI, TYPE } from "../../theme/scale";
import { DEV_BYPASS_AUTH_FLAG } from "../../dev/devBypassAuth";

/** The pitch, in the founder's words. Exported so tests (and any future surface that says the same
 *  thing) assert against the one string rather than a copy of it. */
export const CONCIERGE_AI_PITCH =
  "Your concierge can read these terminals, answer them, and drive the app for you.";

const wrap: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 12,
  padding: "16px 16px 20px",
  // The mock's rule between the live status readout above and the locked half below. `hairline` is
  // the token held to a visible floor on every plane in both themes (see theme/colors).
  borderTop: `1px solid ${C.hairline}`,
};

const pitch: CSSProperties = {
  margin: 0,
  color: C.cream,
  fontSize: 13,
  lineHeight: 1.5,
};

const settingsBtn: CSSProperties = {
  background: C.teal,
  color: ON_BRAND_FILL,
  border: "none",
  borderRadius: 4,
  padding: "8px 14px",
  fontSize: 12,
  fontWeight: FONT_WEIGHT.semibold,
  cursor: "pointer",
  fontFamily: FONT_UI,
  whiteSpace: "nowrap",
};

const refillLine: CSSProperties = {
  margin: 0,
  color: C.muted,
  fontSize: 12,
  lineHeight: 1.5,
};

const devHint: CSSProperties = {
  margin: 0,
  alignSelf: "stretch",
  color: C.muted,
  // `TYPE.small` (12), not a raw 11: the type scale is a ratchet with a ZERO off-scale ceiling
  // (theme/scale.test.ts), and `small` is the token documented for exactly this register —
  // "secondary UI: chips, hints, metadata".
  fontSize: TYPE.small,
  lineHeight: 1.6,
  borderTop: `1px solid ${C.hairline}`,
  paddingTop: 10,
};

const devHintCmd: CSSProperties = {
  fontFamily: FONT_MONO,
  color: C.cream,
  // Long enough to wrap in a narrow column; a command the reader has to retype by hand must not be
  // clipped by `overflow: hidden` somewhere up the tree.
  wordBreak: "break-word",
};

/** The exact line a developer has to run. Exported so the doc and any future surface assert against
 *  this one string rather than a copy of it. Built from {@link DEV_BYPASS_AUTH_FLAG} so it cannot
 *  drift from the flag `authStore.refresh()` reads.
 *
 *  `--filter @sparkle/desktop` RATHER THAN A BARE `pnpm tauri dev`, and this is the whole point of
 *  the bead rather than a style choice. `tauri` is a script in `apps/desktop/package.json` only, so
 *  the bare form depends on the reader's cwd — and the reader of THIS message is standing wherever
 *  they were when the column locked, which for an agent is the repo root. A remedy is an
 *  instruction the reader will follow (AGENTS.md), so it has to work in the state it is offered in;
 *  printing a command that resolves in one directory and not the other reproduces the dead-end this
 *  panel exists to remove. `--filter` resolves against the workspace root from ANY subdirectory and
 *  runs with cwd `apps/desktop`, so it is exactly the `cd apps/desktop && pnpm tauri dev` the docs
 *  use, minus the assumption about where you are standing. */
export const CONCIERGE_DEV_UNLOCK_COMMAND = `${DEV_BYPASS_AUTH_FLAG}=1 pnpm --filter @sparkle/desktop tauri dev`;

export const CONCIERGE_DEV_UNLOCK_TESTID = "concierge-dev-unlock-hint";

/** DEV-BUILD ONLY — see the header. Says what the column is waiting for and the one command that
 *  supplies it locally.
 *
 *  THE COPY DELIBERATELY DOES NOT SAY "this profile has no Sparkle account". It renders on TWO
 *  branches — `not_entitled` (no account) and `no_credits` (an account that IS bought, at an empty
 *  balance) — and naming only the first would be flatly wrong on the second, which is the same
 *  wrong-remedy failure the `flag_off` exclusion above avoids. The bypass supplies BOTH an
 *  entitlement and a balance, so "a funded dev account" is the true statement on both. */
function DevUnlockHint() {
  return (
    <p style={devHint} data-testid={CONCIERGE_DEV_UNLOCK_TESTID}>
      Dev build: nothing to buy to test this. The column is waiting for a paid Sparkle account —
      restart with <code style={devHintCmd}>{CONCIERGE_DEV_UNLOCK_COMMAND}</code> to run as a funded
      dev account, which restores the thread and the compose box. Runs from anywhere in the repo.
      Dev serve only — it cannot activate in a packaged build.
    </p>
  );
}

export function ConciergeAiLocked({ reason }: { reason: ConciergeAiLockReason }) {
  return (
    <div
      data-testid="concierge-ai-locked"
      role="region"
      aria-label="Sparkle AI enhancements"
      style={wrap}
    >
      <AiEnhancementsBadge />
      <p style={pitch}>{CONCIERGE_AI_PITCH}</p>
      {reason === "flag_off" && (
        // A SETTING, not a sale. Deep-opens the ⋯ Settings dialog on its AI-features pane — the
        // same `uiStore.openSettings` seam BalanceBadge and RefillLink use.
        <button
          type="button"
          style={settingsBtn}
          onClick={() => useUiStore.getState().openSettings("ai")}
        >
          Turn on AI enhancements
        </button>
      )}
      {reason === "not_entitled" && (
        <AiLockedNotice
          label="Buy Sparkle to talk to your concierge."
          style={{ alignSelf: "stretch" }}
        />
      )}
      {reason === "no_credits" && (
        // Bought, but empty. The credit flow, and deliberately no $99 anywhere on this branch.
        <p style={refillLine}>
          You are out of AI credits. <RefillLink /> to bring your concierge back.
        </p>
      )}
      {/* DEV ONLY, and not on the `flag_off` branch — see the header for why both halves of that
          condition are load-bearing. `import.meta.env.DEV` is written inline so a `vite build`
          replaces it with `false` and drops everything below it. */}
      {import.meta.env.DEV && reason !== "flag_off" && <DevUnlockHint />}
    </div>
  );
}
