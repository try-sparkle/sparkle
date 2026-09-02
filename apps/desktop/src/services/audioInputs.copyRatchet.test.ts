// THE PAIRED COPY-RATCHET IDIOM — the worked example. Read this before writing a ratchet on copy.
//
// THE RULE — `copy-ratchet-pairing`
// A test that bans a false claim from user-facing copy is only half a ratchet. It must be written
// as a PAIR:
//   * the NEGATIVE bans the claim, written with a NEGATION LOOKBEHIND so it bans only the
//     AFFIRMATIVE form, and
//   * a POSITIVE in the same `describe` requires the true statement.
//
// WHY — and the because-clause is the whole point, because a rule with no reason is the one people
// route around (bead sparkle-j0b6fc):
//
//   1. THE OBVIOUS NEGATIVE REDS THE CORRECT COPY. The honest replacement usually has to DENY the
//      banned claim in so many words. Here the false claim was that the bound device is a
//      microphone, and the honest copy is literally "This is not a microphone — it can capture
//      system audio." A naive /a microphone/i bans the very sentence the positive below demands,
//      and the failure output is genuinely confusing: the assertion appears to reject the one
//      sentence its neighbour requires. That is what cost a write-run-fix round trip.
//   2. THE NEGATIVE ALONE PASSES ON COPY THAT SAYS NOTHING. Deleting a lie is not the same fact as
//      stating the truth. Trim this string to "Bound to a system-audio device." and it makes no
//      false claim at all — the negative is green, and the reader is left with exactly the
//      inference that was wrong in the first place.
//
// NEITHER HALF CATCHES BOTH, and this pair was mutation-proved in both directions before it was
// committed: restoring the old false sentence reds the NEGATIVE, and removing the denial while
// leaving the lie out reds the POSITIVE.
//
// IS THIS REAL COPY? YES — `BOUND_VIRTUAL_WARNING` in ./audioInputs is shipped, user-facing, and
// rendered by components/BoundDeviceCaption.tsx beside the live capture device. It is not a
// fixture. It is worth ratcheting because it is the sentence standing between "Sparkle listens to
// your microphone" and "Sparkle is transcribing your Zoom call": the module's own header records
// two incidents where that distinction was lost, and this caption is the surface that states it.
//
// A LOOKBEHIND IS SAFE HERE AND UNSAFE IN SOURCE. `(?<!…)` is a PARSE error in the safari14 WebView
// this app pins (see services/safeText.test.ts) — but a test runs in node, never in that WebView,
// so the idiom belongs in the TEST and must not leak into the shipped module.
//
// THE GUARD: scripts/lib/copy-ratchet-pairing-guard.sh reports a negative-only copy ratchet, so
// this rule does not survive on prose alone.
import { describe, it, expect } from "vitest";
import { BOUND_VIRTUAL_WARNING } from "./audioInputs";

// ── THE TWO REGEXES, SIDE BY SIDE. Read them together; they are one assertion in two halves. ──

// THE NEGATIVE. The three lookbehinds are the load-bearing part: each one is a form the DENIAL
// actually takes in English, and without them this pattern matches "This is not a microphone" —
// the sentence the positive below requires. What is banned is the AFFIRMATIVE claim only.
const CLAIMS_TO_BE_A_MICROPHONE = /(?<!not )(?<!isn't )(?<!is not )\b(?:a|your|the) microphone\b/i;

// THE POSITIVE. Not the inverse of the regex above and not derivable from it: it asserts the
// presence of a fact, where the negative asserts the absence of a lie. Copy that states neither
// satisfies the negative and fails this.
const DENIES_BEING_A_MICROPHONE = /\bnot a microphone\b/i;
const NAMES_WHAT_IT_ACTUALLY_CAPTURES = /system audio/i;

// `expect(actual, message)` throughout. A failure message is the one surface GUARANTEED to be read
// at the moment of violation, so spending it on a bare regex mismatch wastes the only teachable
// moment the rule gets. Each message names the rule and says what to do.
const NEG_RULE =
  "copy-ratchet-pairing (negative): this caption must never claim the bound device IS a " +
  "microphone. Ban only the AFFIRMATIVE form — the honest copy has to say 'not a microphone', " +
  "so a negative without the negation lookbehind reds the sentence the positive below requires.";
const POS_RULE =
  "copy-ratchet-pairing (positive): deleting the lie is not the same fact as stating the truth. " +
  "This caption must SAY that the device is not a microphone and that it can capture system " +
  "audio — copy that merely stays silent passes the negative and misleads the reader anyway.";

describe("BOUND_VIRTUAL_WARNING — the paired copy ratchet", () => {
  it("bans the affirmative microphone claim AND requires the denial (both halves)", () => {
    // NEGATIVE — the lie can never come back.
    expect(BOUND_VIRTUAL_WARNING, NEG_RULE).not.toMatch(CLAIMS_TO_BE_A_MICROPHONE);

    // POSITIVE — the truth must be present. Paired with the line above, never standing alone.
    expect(BOUND_VIRTUAL_WARNING, POS_RULE).toMatch(DENIES_BEING_A_MICROPHONE);
    expect(BOUND_VIRTUAL_WARNING, POS_RULE).toMatch(NAMES_WHAT_IT_ACTUALLY_CAPTURES);
  });

  // THE PAIR'S OWN PRECONDITION, asserted rather than assumed. The negative is only meaningful if
  // its lookbehinds actually spare the denial — and that is a fact about the REGEX, which no
  // assertion about the current copy can establish. Without this, someone "simplifying" the
  // pattern to /a microphone/i would find every test above still green until the day the copy is
  // re-edited, at which point the ratchet reds the correct sentence and reads as a copy bug.
  it("the negative spares a denial and still catches the affirmative claim", () => {
    const DENIAL = "This is not a microphone — it can capture system audio.";
    const LIE = "This is a microphone that can also capture system audio.";
    expect(DENIAL, "the lookbehinds must spare the honest denial").not.toMatch(
      CLAIMS_TO_BE_A_MICROPHONE,
    );
    expect(LIE, "the negative must still catch the affirmative claim").toMatch(
      CLAIMS_TO_BE_A_MICROPHONE,
    );
  });
});
