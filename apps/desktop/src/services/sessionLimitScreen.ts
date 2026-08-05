// THE SHARED SOURCE OF TRUTH FOR "IS THIS CLAUDE CODE'S SESSION-LIMIT PICKER?"
//
// ── WHY THIS FILE EXISTS, AND WHY IT IS NOT IN screenClassifier.ts ────────────────────────────
// Two units need this answer and they run in different processes:
//
//   * The TypeScript status classifier (`engine/screenClassifier.ts`, owned by W-DETECT) needs it
//     to publish the REASON CODE {@link SESSION_LIMIT_REASON} alongside a `waiting` status, so a
//     recovery service can act on the pair without importing the classifier.
//   * `src-tauri/src/nudge_gate.rs` needs it in RUST, because the exemption it grants — permitting
//     exactly one `Esc` at a screen it otherwise refuses — is evaluated on the nudger thread, which
//     is the one layer that keeps working when the WebView is wedged and every model returns 529.
//
// The Rust side cannot call TypeScript, so it TRANSCRIBES the patterns below, and
// `nudge_gate.rs`'s `ported_typescript_patterns_have_not_drifted` reads THIS FILE at `cargo test`
// time and fails if a pattern here changed without the port changing. That is the same mechanism
// already guarding `SELECTION_CURSOR` and the footer patterns; this module exists so the
// session-limit matcher can be enrolled in it without W-RESUME editing W-DETECT's files.
//
// A change to this file therefore MUST re-run the Rust jobs. `RUST_RE` in `.github/workflows/ci.yml`
// covers it, and `tools/tests/ci-workflow.test.mjs` derives that requirement from the crate's own
// source rather than trusting the filter to be hand-maintained — so removing the path from RUST_RE
// fails CI rather than silently skipping the coherence guard.
//
// ── WHY THE MATCH IS NARROW, AND WHICH DIRECTION IT FAILS ────────────────────────────────────
// The three options on this picker are account-level BILLING decisions ("Switch to usage credits"
// moves the user onto paid overage; "Switch to Team plan" changes their subscription). The only
// key any machine may ever send here is `Esc`. Everything downstream is gated on this predicate,
// so a FALSE POSITIVE means a machine pressed Esc at some other live dialog — cancelling a tool
// approval a human was mid-answer on. A false negative costs one un-resumed agent that a human can
// still unstick by hand. So every rule below fails CLOSED: unreadable, ambiguous, or partially
// matched ⇒ `false`.
//
// ── WHY IT DOES NOT FIRE ON PROSE, INCLUDING ON THE PRD THAT SPECIFIES IT ────────────────────
// `PRD/sparkle/claude-account-identity-truth.md` §6 quotes this very screen. Four independent
// properties keep that block (and this file) from classifying true:
//
//   1. the option labels must carry a `screenClassifier.SELECTION_CURSOR`-class glyph — a bare `>` is not
//      accepted, and the PRD's reproduction uses `>` deliberately;
//   2. the PRD's option labels carry a zero-width space inside each keyword, so they do not match
//      the literals below at all;
//   3. a picker FOOTER must be co-present, and the PRD rewrites its footer so it cannot match;
//   4. the picker must be BOTTOM-ANCHORED — nothing UNRECOGNIZED may follow the footer: blanks,
//      up to {@link MAX_CHROME_BELOW_FOOTER} {@link AMBIENT_CHROME_LINE} rows, and one closing
//      border are free — so prose or a fence continuing beneath it disqualifies the frame.
//
// This module deliberately does NOT export a full `isSessionLimitPicker(snapshot)`; that is
// W-DETECT's deliverable in `engine/screenClassifier.ts`, where the settle-time viewport and the
// shared `SELECTION_CURSOR` / `PICKER_FOOTER` matchers live. What lives here is the part BOTH sides
// must agree on byte-for-byte: the option labels, the anchoring constant, and the reason code.

/** The reason code W-DETECT publishes alongside `status === "waiting"` when the rendered viewport is
 *  this picker, and the ONLY value `services/authRecovery.ts` acts on.
 *
 *  It is a REASON CODE and never the bare band, and that distinction is the single most important
 *  correctness rule in the recovery path: `waiting` is the app's most common attention state — any
 *  mid-stream question sets it, and the idle-only screen escalation sets it for permission dialogs,
 *  AskUserQuestion menus and `/model` pickers. Acting on `waiting` alone would send `Esc` to every
 *  correlated agent sitting at a legitimate dialog. Account correlation does not narrow that at all,
 *  because a fleet is typically all on one account. */
export const SESSION_LIMIT_REASON = "session-limit-picker";

/** A DOM `CustomEvent` `statusEngine` dispatches on the RISING EDGE of a screen read that sees the
 *  picker, for narration and observability.
 *
 *  §6c permits either a `StatusTransition` field or a dedicated event and requires the worker to
 *  pick one and say which. **The chosen channel is `StatusTransition.reason`, NOT this event** —
 *  `AgentPane`'s `onTransition` sink hands it to `authRecovery.noteAgentStatus`. The reason is not
 *  bus plumbing but semantics: this event is edge-triggered on the SCREEN, so a listener keyed on it
 *  would un-register an agent the instant `Esc` dismissed the dialog, before anyone knew whether the
 *  resume took. §6c requires the stuck state to persist until POSITIVE PROGRESS, and only the
 *  router's latch has that property. Nothing in the recovery path reads this constant. */
export const SESSION_LIMIT_PICKER_EVENT = "sparkle://session-limit-picker";

/** The auth-recovery event, per §6d. Payload {@link AuthRecoveredPayload}. */
export const AUTH_RECOVERED_EVENT = "sparkle://auth-recovered";

/** Emitted after a recovery attempt so a failed resume stays VISIBLE rather than being assumed. */
export const AUTH_RECOVERY_RESULT_EVENT = "sparkle://auth-recovery-result";

/** `{ configDir, accountUuid, email }` — the frozen §6d shape. Do not add required fields. */
export interface AuthRecoveredPayload {
  configDir: string;
  accountUuid: string | null;
  email: string | null;
}

// ── THE OPTION LABELS ─────────────────────────────────────────────────────────────────────────
// Anchored per rendered row, tolerant of the box gutter (`│`) and of the selection glyph being on
// any one of the three rows. `>` is NOT accepted as a cursor here for the same reason
// `SELECTION_CURSOR` rejects it: a markdown blockquote renders as `> 1. …` and would otherwise make
// every quoted list a live picker.

/** "1. Stop and wait for limit to reset" — the option that exists on NO other Claude Code picker.
 *  Required; the matcher never fires without it. */
export const SESSION_LIMIT_RESET_OPTION = /^\s*[│|]?\s*[❯›]?\s*\d+\.\s+stop and wait for (?:the )?limit to reset\b/im;

/** "2. Switch to usage credits" — moves the user onto PAID OVERAGE. Never machine-selected.
 *
 *  The trailing `s` is REQUIRED, not optional, and that is not pedantry: `\b` treats U+200B as a
 *  non-word character, so a permissive `credits?\b` happily matches the PRD's de-fanged
 *  `credit`+U+200B+`s`. Demanding the full word restores rule (2) of the module header for this
 *  label instead of leaving it resting entirely on the reset option. */
export const SESSION_LIMIT_CREDITS_OPTION = /^\s*[│|]?\s*[❯›]?\s*\d+\.\s+switch to usage credits\b/im;

/** "3. Switch to Team plan" — changes the user's SUBSCRIPTION. Never machine-selected. */
export const SESSION_LIMIT_TEAM_OPTION = /^\s*[│|]?\s*[❯›]?\s*\d+\.\s+switch to team plan\b/im;

/** What may sit BELOW the picker's footer and still leave it "the bottom of the grid".
 *
 *  This is the bottom-anchored rule, and it is what stops prose that merely QUOTES the picker from
 *  matching: a live Ink dialog IS the bottom of the grid, whereas a document continues underneath.
 *
 *  IT WAS ZERO, AND ZERO WAS WRONG — measured against the wrong screens. The argument was that all
 *  four pickers captured from 2.1.220 end at their footer, so nothing but a blank may follow. Those
 *  four are the permission box, its two-option sibling, the AskUserQuestion menu and `/model` — and
 *  none of them is the SESSION-LIMIT picker. When that screen was finally captured in situ it had
 *  FIVE rows of persistent chrome stacked beneath the footer (a rule, the composer, a rule, and two
 *  status bars), so a zero-row rule rejects the one screen this whole feature exists to detect. The
 *  ports were independently green because each tested its own fixtures; the contradiction only
 *  surfaced when the two branches met (bead `sparkle-d2i0c`, and knightwatch probe 1 on PR #1261).
 *
 *  So the rule is no longer "nothing follows" but "nothing UNRECOGNIZED follows", which keeps the
 *  anti-prose property that motivated zero. Below the footer we accept, in any order:
 *
 *    - BLANK lines, unbounded — always were.
 *    - Up to {@link MAX_CHROME_BELOW_FOOTER} lines matching {@link AMBIENT_CHROME_LINE}: the
 *      status glyphs, horizontal rules and empty composer caret Claude Code paints persistently.
 *    - ONE closing-border row (`╰────╯`), because a bordered dialog draws its own bottom edge
 *      there. Exactly one, and an OPENING border (`╭──────╮`) is never free at all — that is
 *      positive evidence a DIFFERENT frame starts below, which is the shape that would arm `Esc`
 *      at a dialog somebody is mid-answer on (roborev 58557/58571).
 *
 *  A bare `────────` transcript divider is admitted by the chrome class, not by the border rule —
 *  it is chrome and it closes nothing. Prose, code fences and option rows are none of these, so a
 *  markdown file quoting this screen still fails: the fence beneath the footer is not chrome.
 *
 *  The asymmetry that set the old bound still holds and still argues for a TIGHT class rather than
 *  a large budget: a false negative costs one un-resumed agent a human can unstick by hand; a false
 *  positive presses `Esc` at a live dialog. The fix for the false negative is to RECOGNIZE more
 *  precisely, never to count more loosely. */
export const MAX_CHROME_BELOW_FOOTER = 8;

/** The persistent chrome Claude Code paints below an open dialog, as one shared pattern so the two
 *  ports cannot disagree about what "recognized" means. Ported byte-for-byte into
 *  `nudge_gate.rs::is_ambient_chrome_line`, which `ported_typescript_patterns_have_not_drifted`
 *  pins at `cargo test` time.
 *
 *  Written as escapes, not glyphs: the glyph-icon ratchet reads a literal class here as one more
 *  affordance drawn with a character, and it is not — these are bytes we RECOGNIZE, not bytes we
 *  render. Escapes also keep the codepoints legible.
 *
 *    status  \u26a0 ⚠  \u23f8 ⏸  \u25b6 ▶  \u25c6 ◆  \u25cf ●  \u2713 ✓  \u2717 ✗
 *            \u273b ✻  \u273d ✽  \u2722 ✢
 *    rules   \u2500 ─  \u2501 ━  \u2550 ═  \u2594 ▔  \u2581 ▁  and a run of underscores
 *    frame   \u2502 │  with a rule after it
 *    caret   \u276f ❯  \u203a ›  or a bare > — an EMPTY composer only, hence the `$` */
export const AMBIENT_CHROME_LINE =
  /^[ \t\u00a0]*(?:[\u26a0\u23f8\u25b6\u25c6\u25cf\u2713\u2717\u273b\u273d\u2722]|[\u2500\u2501\u2550\u2594\u2581_]{4,}[ \t\u00a0]*$|[\u2502|][ \t\u00a0]*[\u2500\u2501\u2550]{4,}[ \t\u00a0]*$|[\u2502|]?[ \t\u00a0]*[\u276f\u203a>][ \t\u00a0]*$)/u;

/** How many rendered rows may separate the LAST option row from the picker's footer.
 *
 *  This is what makes "the same rendered frame" mean something. Without it, option rows far up the
 *  viewport — scrolled transcript from an earlier turn — would pair with an unrelated footer at the
 *  bottom of the grid and read as one live dialog.
 *
 *  EIGHT, measured. The gap in the four pickers captured verbatim from 2.1.220 is 2, 2, 2 and 6 —
 *  the `/model` picker is the wide one, since it draws extra rows between its last option and its
 *  footer. Eight clears the widest real case with room for a version that adds a row, and is far
 *  short of a scrolled transcript. */
export const MAX_OPTION_FOOTER_GAP = 8;

/** How many of the three option labels must be co-present. The reset option is mandatory; this
 *  requires at least one of the two "Switch to …" options alongside it.
 *
 *  Not three-of-three: Claude Code does not always render all three (a user already on Team does
 *  not get the Team option), and demanding all three would make the feature never fire for them —
 *  a false negative is cheap, but a feature that cannot fire is the same as not shipping it. Not
 *  one-of-three either: the reset label alone appearing in some future unrelated dialog would be
 *  enough to send Esc into it. */
export const MIN_OPTIONS_PRESENT = 2;

// A `SELECTION_CURSOR_HINT` constant lived here, holding the two cursor glyphs purely as a
// documentation anchor. Deleted: it had no callers, and `glyphIcons.test.ts`'s exact-count ratchet
// counted it as a seventh glyph-as-icon site against a ceiling of six. That ratchet is the
// mechanism enforcing "affordances are react-icons, never characters", and raising a ceiling to
// admit a string nothing reads is precisely the erosion it exists to catch. The authoritative
// cursor matcher is `screenClassifier`'s `SELECTION_CURSOR`; rule (1) in the header above points at
// it by name, which is the anchor that was actually wanted.

/** Is this ONE rendered row one of the picker's option lines? The bottom-anchor rule needs to know
 *  where the options END so it can look for the footer below them, and both ports must agree on
 *  that boundary or they would anchor on different rows. */
export function isSessionLimitOptionLine(line: string): boolean {
  return (
    SESSION_LIMIT_RESET_OPTION.test(line) ||
    SESSION_LIMIT_CREDITS_OPTION.test(line) ||
    SESSION_LIMIT_TEAM_OPTION.test(line)
  );
}

/** How many of the three labels this frame carries. Exported so callers can log WHICH evidence they
 *  had — a two-of-three match and a three-of-three match are different confidences and the operator
 *  reading the log should be able to tell them apart. */
export function sessionLimitOptionsPresent(text: string): number {
  let n = 0;
  if (SESSION_LIMIT_RESET_OPTION.test(text)) n += 1;
  if (SESSION_LIMIT_CREDITS_OPTION.test(text)) n += 1;
  if (SESSION_LIMIT_TEAM_OPTION.test(text)) n += 1;
  return n;
}

/** The label half of the verdict: the mandatory reset option plus at least
 *  {@link MIN_OPTIONS_PRESENT} labels overall.
 *
 *  This is NOT the whole predicate — a caller must additionally require the selection cursor, a
 *  picker footer, and the bottom-anchoring rule. It is exported separately so both the TS
 *  classifier and the Rust port test the same middle layer. */
export function hasSessionLimitOptions(text: string): boolean {
  if (!SESSION_LIMIT_RESET_OPTION.test(text)) return false;
  return sessionLimitOptionsPresent(text) >= MIN_OPTIONS_PRESENT;
}
