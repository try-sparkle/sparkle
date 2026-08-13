// The three-position send tray — Send · Push to talk · Speak — reduced to pure decisions.
//
// WHAT THIS REPLACES. The composer used to carry a Send button plus a separate auto-send arming
// switch (components/Concierge/SendRail). Two controls, one question: "does this message go by
// hand or on its own, and is the microphone part of that?" This is that question as ONE control —
// a three-position tray that IS the composer's bottom bar, edge to edge, and the only press target.
//
// THE TRAY IS THE MICROPHONE CONTROL; IT IS NOT THE ONLY CONTROL IN THIS BAR. Speak carries one
// modifier — the Auto-send switch below the tray (components/Concierge/AutoSendToggle) — and the
// two answer different questions. A POSITION says what the microphone does. AUTO-SEND says what the
// countdown's END does. With it off the countdown still runs and still ends the utterance; only the
// dispatch is withheld, leaving the words in the composer. Collapsing them — wiring the switch into
// the countdown's arming — would delete the countdown while still looking like a working switch.
//
// The design was settled on a standalone prototype (PRD/sparkle/send-modes-live-spec.md) and the
// rules below are that spec, transcribed. What lives here is only the part that can be decided
// without a DOM: the mode set, the mic each mode implies, which mode owns a countdown, the floor
// under that countdown, which keystroke sends, and what the keycap chiclet is therefore allowed to
// claim. Everything visual lives in components/Concierge/SendModeTray.tsx; everything stateful
// lives in the host.
//
// PURE + EXPORTED, this codebase's convention for a decision two surfaces must not disagree about
// (cf. deriveMicPresentation, classifyFocusOwner, confidence). The value of that here is specific:
// the tray PAINTS a keycap chip and the textarea HANDLES a keystroke, and those are two different
// files. A chip that advertises a chord the handler does not honour is the exact defect the
// founder asked to have fixed, so both sides call `chordSends` / `chicletFor` rather than each
// spelling the modifier check out.

import type { FocusOwner } from "./dictationFocus";
import type { MicIntent } from "../components/MicButton";
import { thresholdMs, type Confidence } from "./confidence";

/** Where the tray is parked. Ordered LEFT → RIGHT exactly as the control draws them, because
 *  {@link stepSendMode} walks this array — the reading order and the arrow-key order are the same
 *  fact, and giving them two definitions is how they drift apart. */
export const SEND_MODES = ["send", "ptt", "speak"] as const;

/** One of the tray's three positions. */
export type SendMode = (typeof SEND_MODES)[number];

/** The user-facing name of each position. The tray draws these; nothing else invents its own. */
export const SEND_MODE_LABEL: Record<SendMode, string> = {
  send: "Send",
  ptt: "Push to talk",
  speak: "Speak",
};

/**
 * The same three positions, named for a tray too narrow to spell them out.
 *
 * ONLY `ptt` differs, and that is the point: "Push to talk" is the one label that cannot fit a
 * narrow concierge column, and it is the one that dragged the other two down with it. The pills are
 * `flex: 1`, so they share the width equally and every label ellipsizes together — the founder's
 * report was a tray reading "S… P… S…", three positions none of which could be told apart. Naming
 * the narrow state explicitly beats letting the browser truncate, because an ellipsis is a
 * character the user has to decode; "Push" is a word they can read.
 */
export const SEND_MODE_LABEL_SHORT: Record<SendMode, string> = {
  send: "Send",
  ptt: "Push",
  speak: "Speak",
};

/**
 * INVARIANT: every short label is a substring of its full label.
 *
 * This is what lets the tray shrink the VISIBLE text while holding the accessible name at the full
 * label — WCAG 2.5.3 (Label in Name) only requires the visible string to be CONTAINED IN the name,
 * so "Push" inside "Push to talk" satisfies it in both width states. Break this invariant and the
 * accessible name stops containing what is on screen, which is the actual failure the rule names.
 *
 * Exported as a checkable predicate rather than left as a comment because the two tables are edited
 * independently and nothing else would notice them drifting apart.
 */
export function shortLabelsAreContainedInFullLabels(): boolean {
  return SEND_MODES.every((m) => SEND_MODE_LABEL[m].includes(SEND_MODE_LABEL_SHORT[m]));
}

/**
 * Below this tray width (px) the pills use {@link SEND_MODE_LABEL_SHORT}.
 *
 * ── THE ARITHMETIC IS NOT HERE ──────────────────────────────────────────────────────────────────
 * It lives in `fullLabelsFitAtPx` (components/Concierge/trayGeometry), computed from the tray's
 * actual constants — pill padding, border, gap, keycap slot, inter-pill gaps. This module only
 * states the CHOSEN value; sendMode.test.ts asserts `TRAY_SHORT_LABEL_MAX_PX >= fullLabelsFitAtPx()`
 * so the two cannot drift. That separation is deliberate: three earlier revisions of this constant
 * (360, 390, 430) were each derived by re-spelling the geometry in prose or in a test, and each was
 * wrong in a different way — a copied literal going stale (roborev 56213), then an estimate that
 * omitted the keycap slot, then one that omitted the pill BORDER while also adding tray padding the
 * measured `contentRect` excludes, two errors that partially cancelled and hid each other
 * (roborev 56223). The derivation belongs next to its inputs.
 *
 * ERRING HIGH IS THE CORRECTNESS ARGUMENT, not a nicety. Between this threshold and the true fit
 * width the component still selects the FULL table and the label span clips — so a value set too low
 * paints "Push to tal", a silently truncated word, which is strictly worse than the "P…" this whole
 * change exists to delete. Showing "Push" a notch early costs nothing.
 *
 * 497 is the derived bound EXACTLY, and it grew from 440 when the keycap chiclet left the flow to
 * be justified right against a label centred alone (trayGeometry `fullLabelsFitAtPx` — a centred
 * label must be given the keycap's clearance on both sides, not one). The margin is not what makes
 * this safe. Two other things are: the test asserts
 * `TRAY_SHORT_LABEL_MAX_PX >= fullLabelsFitAtPx()`, so any geometry change that outgrows the margin
 * fails loudly rather than silently clipping; and `textOverflow: ellipsis` remains in the component
 * as a last-resort backstop if the estimate itself is wrong.
 *
 * WHAT MOVING IT COSTS, stated plainly: between 440 and 497 the tray now draws the `fullTight`
 * tier — the same three WHOLE words, minus the hover keycap. Nothing truncates and no label
 * shortens; the only thing that changes in that band is that hovering a pill no longer reveals its
 * shortcut. That is the right trade against the alternative, which is a keycap overlapping the word
 * it annotates.
 *
 * A residual backstop still exists in the component (`textOverflow: ellipsis`) for exactly that
 * reason: if the estimate is ever wrong, an ellipsis beats a word cut mid-stroke.
 *
 * It also sits above `CONCIERGE_DEFAULT_WIDTH` (engine/columnResize) on purpose — at the DEFAULT
 * column width the full labels genuinely do not fit, which is why the founder saw "S… P… S…"
 * without having resized anything unusual. That relationship is pinned in sendMode.test.ts too.
 */
export const TRAY_SHORT_LABEL_MAX_PX = 497;

/**
 * Below this tray width the pills drop their words entirely and draw ICONS ONLY.
 *
 * ── WHY A THIRD TIER EXISTS ─────────────────────────────────────────────────────────────────────
 * The short-label tier above was introduced for exactly this failure and did not go far enough. The
 * founder's screenshot of a narrow concierge column shows the tray reading **"S… P… S…"** — all
 * three positions ellipsised to a single letter, so the control that decides what happens when you
 * stop talking cannot be read at all. Short labels only moved the width at which that happens.
 *
 * It matters more now than it did: with every column width ceiling removed and a 50px floor in its
 * place (engine/columnResize), a narrow concierge stops being an edge case and becomes something the
 * user reaches deliberately and often.
 *
 * ── WHY ICONS AND NOT A SHORTER WORD ────────────────────────────────────────────────────────────
 * There is no shorter word. "Send"/"Push"/"Speak" are already one syllable each, and cutting them
 * further produces the abbreviations this tier exists to avoid — an icon at 16px still reads, a word
 * cut to "S…" does not. Icons come from `react-icons/fi`, the project's icon set; emoji are banned
 * as icons repo-wide.
 *
 * ── THE ACCESSIBLE NAME IS UNAFFECTED ───────────────────────────────────────────────────────────
 * The pill keeps `aria-label` at the FULL label in every tier, so the icon tier is a purely visual
 * reduction. WCAG 2.5.3 (Label in Name) is about the visible string being contained in the name;
 * with no visible string there is nothing to contain, and the requirement is satisfied trivially —
 * unlike a truncated "S…", which is visible text NOT contained in "Send".
 *
 * Set from `iconsFitAtPx()`'s sibling `shortLabelsFitAtPx()` and pinned by sendMode.test.ts the same
 * way `TRAY_SHORT_LABEL_MAX_PX` is, so a geometry change fails loudly instead of clipping.
 */
// ── THE LADDER'S THRESHOLDS, WORDS-FIRST ──────────────────────────────────────────────────────
//
// THE FOUNDER'S SPEC, which overrides the icon tier that used to sit here: "I don't see the words
// Send, Push, and Speak. It just says Se..., Pu..., Sp.... I want to see the entire words Send,
// Push, Speak when the column is not in its very wide open state."
//
// So an ellipsised label is the ONE outcome ruled out, and every way of fitting the words is
// exhausted before anything else gives:
//
//   tier         gives up                  needs   what he sees
//   full         nothing                   440px   "Push to talk" + keycap hint
//   fullTight    the KEYCAP SLOT           281px   "Push to talk"
//   short        the long wording          179px   "Send" / "Push" / "Speak"
//   shortTight   padding + one type step   131px   the same words, slightly smaller
//   floor        nothing — the pills WRAP    —     the same words, stacked
//
// THE KEYCAP SLOT GOES FIRST and it is the biggest single win: 30px + a 6px gap per pill is 108px
// across the tray, reserved for a hint that only appears on hover or keyboard focus. Dropping it
// takes the short words from needing 287px to 179px. That reservation — not a narrow column — is
// what produced "Se… Pu… Sp…" at ordinary widths.
//
// Measured in WebKit at fifteen widths from 500px to the 50px floor: whole words, zero truncation,
// zero overflow at every one.
export const TRAY_FULL_NO_CHICLET_MIN_PX = 281;
export const TRAY_SHORT_NO_CHICLET_MIN_PX = 179;
export const TRAY_SHORT_TIGHT_MIN_PX = 131;

/** How a tray of a given width draws its pills. */
export type TrayDensity = "full" | "fullTight" | "short" | "shortTight" | "floor";

/**
 * Which density a tray of `trayWidthPx` draws at.
 *
 * ONE function for all three tiers, rather than `trayLabelFor` plus a separate icon predicate: the
 * tiers are ordered and mutually exclusive, and two independent width comparisons is how a component
 * ends up drawing an icon AND reserving a label slot for it.
 *
 * A width of 0 means "not measured yet" (first paint, before the ResizeObserver fires) and takes the
 * FULL tier, for the reason `trayLabelFor` gives: booting into an abbreviated form and widening a
 * frame later is a visible flicker, whereas a too-long label for one frame merely truncates the way
 * it always did.
 */
export function trayDensityFor(trayWidthPx: number): TrayDensity {
  if (!(trayWidthPx > 0)) return "full";
  if (trayWidthPx >= TRAY_SHORT_LABEL_MAX_PX) return "full";
  if (trayWidthPx >= TRAY_FULL_NO_CHICLET_MIN_PX) return "fullTight";
  if (trayWidthPx >= TRAY_SHORT_NO_CHICLET_MIN_PX) return "short";
  if (trayWidthPx >= TRAY_SHORT_TIGHT_MIN_PX) return "shortTight";
  return "floor";
}

/** Does this tier draw the keycap hint? It is the FIRST thing dropped — see the ladder above. */
export function trayShowsChiclet(density: TrayDensity): boolean {
  return density === "full";
}

/** EVERY tier draws words. Derived from `trayLabelFor` rather than hardcoded `true`, so a tier that
 *  ever returned an empty label would make this false instead of asserting itself green. */
export function trayShowsWords(density: TrayDensity): boolean {
  return SEND_MODES.every((m) => trayLabelFor(m, density) !== "");
}

/**
 * The label a pill draws at a given tray width.
 *
 * Pure and exported for this codebase's usual reason (cf. `chicletFor`, `micIntentForMode`): the
 * decision is testable without a DOM, which MATTERS here because jsdom has no layout engine — a
 * test that tried to prove this by measuring a rendered node would read every width as 0 and pass
 * vacuously. The component measures; this decides.
 *
 * A width of 0 means "not measured yet" (the first paint, before the ResizeObserver fires) and
 * takes the FULL labels: booting into the abbreviated form and widening a frame later is a visible
 * flicker, whereas a too-long label for one frame merely truncates the way it always did.
 */
export function trayLabelFor(mode: SendMode, density: TrayDensity): string {
  if (density === "full" || density === "fullTight") return SEND_MODE_LABEL[mode];
  return SEND_MODE_LABEL_SHORT[mode] ?? SEND_MODE_LABEL[mode];
}

/**
 * Step the tray one position, CLAMPED at both ends — never wrapping.
 *
 * Wrapping would let one extra keypress flip `send` (microphone off, nothing listening) straight to
 * `speak` (microphone live, auto-sending): the two most opposite states this feature has, one
 * keystroke apart, with the overshoot that produced it invisible. Clamping makes overshooting
 * harmless — you hold the arrow and land on the end, which is what every other slider does.
 */
export function stepSendMode(mode: SendMode, delta: 1 | -1): SendMode {
  const i = SEND_MODES.indexOf(mode);
  const next = Math.min(SEND_MODES.length - 1, Math.max(0, i + delta));
  // `?? mode` is unreachable given the clamp, and is here only because `indexOf` returns -1 for a
  // value outside the union — which a hand-edited persisted blob can produce. Standing still beats
  // returning `undefined` into a prop typed as a mode.
  return SEND_MODES[next] ?? mode;
}

/**
 * The microphone state each position implies, expressed in the vocabulary the mic already has
 * (components/MicButton `MicIntent`) so the tray drives the SHIPPED mic actions rather than a
 * second, parallel notion of "on".
 *
 *   send  → "off"    the mic is released. **An off state for the MICROPHONE ONLY, never for the
 *                    control**: in Send the tray is the most actionable it ever gets (filled
 *                    primary blue). Two objects, opposite treatments, one frame.
 *   ptt   → "off"    RELEASED between holds. The hold is what opens the mic — {@link pttHeldIntent}.
 *   speak → "active" live, routing, and counting down.
 *
 * ── WHY PUSH TO TALK RESTS AT "off" AND NOT AT "paused" (sparkle-u81cz) ─────────────────────────
 * It used to return `"paused"`, and that was the bug the founder reported: *"it shows the
 * microphone as gray but LISTENING when I don't have the push-to-talk button pressed … AND IT
 * SHOULD NOT BE CAPTURING ANY WAVEFORM."*
 *
 * `"paused"` is NOT a weaker "off" — this module's own consumer says so in useSendMode: it maps to
 * `setMuted`, and `setMuted` is an **ARM** (`setEnabled(true); setPhase("passive")`). So the
 * resting position of push-to-talk held a LIVE, capturing microphone: a waveform sweeping with real
 * audio, a metered relay open, under a glyph that read as idle. Looks off, behaves on — the worst
 * of the two, and the one combination a user cannot detect.
 *
 * The whole promise of push-to-talk over Speak is that the microphone is CLOSED until you ask for
 * it. That promise is now literal: at rest the mic is released exactly as in Send, and the ONLY
 * thing that opens it is the hold. It matters more than it used to, because Speak is always-on
 * since the wake word was retired (sparkle-6hu3c) — push-to-talk is now the only position in which
 * the microphone is ever shut.
 *
 * WHAT THIS DOES NOT CHANGE: the HELD state. `pttHeldIntent` is untouched, and the surfaces that
 * draw a held hold read the live mic rather than this function (see micPresentation's `ptt` branch,
 * which keys on `enabled` precisely so the held rendering survived this change unaltered).
 */
export function micIntentForMode(mode: SendMode): MicIntent {
  if (mode === "speak") return "active";
  // EVERY OTHER VALUE — including `send`, and including anything a corrupt or hand-edited persisted
  // blob can produce — releases the mic. Written as an explicit `speak` match with an "off" default
  // rather than the other way round, because the fall-through direction is not a style choice here:
  // defaulting to `active` would take the microphone LIVE on a value nobody recognises, spending
  // credits and capturing audio, with no pill reading selected to explain it. Fail closed.
  return "off";
}

/** What Push to talk becomes WHILE the key is held: live, exactly like Speak. Separate from
 *  {@link micIntentForMode} because the resting state and the held state of the same position are
 *  different mic states, and collapsing them is how a push-to-talk ends up either always-hot or
 *  never-hot. */
export function pttHeldIntent(): MicIntent {
  return "active";
}

/**
 * Does this position run the auto-send countdown? **Speak only.**
 *
 * Send sends when you press it. Push to talk sends the instant you RELEASE — a timer there would
 * make the deliberate mode feel laggier than the automatic one, which inverts the whole point of
 * offering both.
 *
 * IT NO LONGER DECIDES WHERE THE **AUTO-SEND** TOGGLE APPEARS — see {@link modeHasAutoSend}. It did,
 * and that was one fact while Speak was the only position with anything to switch off. Push to talk
 * now has one too (sparkle-bbfsx), and it is not a countdown: the release is the trigger there. The
 * two questions have come apart, so they are two functions.
 */
export function modeCountsDown(mode: SendMode): boolean {
  return mode === "speak";
}

/**
 * Does this position have an **Auto-send** switch — i.e. is there a dispatch the user can turn off?
 *
 * Speak and Push to talk, for two different triggers: Speak dispatches when the countdown expires,
 * Push to talk when the key comes up. Send has nothing to switch — pressing Send IS the dispatch,
 * so a control there would be a switch over the user's own gesture.
 *
 * ── WHY THIS IS NOT `modeCountsDown` ANY MORE ─────────────────────────────────────────────────
 * The founder asked for the second switch by pointing at the first: *"For Push to talk. I also want
 * to have an auto-send option, so it should be the same slider as we have under speak. It can be in
 * the same spot in the bottom right."* Widening `modeCountsDown` to satisfy that would have armed
 * the SILENCE COUNTDOWN in push-to-talk — `useAutoSend`'s `armed` reads it through
 * `useSendMode` — so a release would race a timer that has no business running in the deliberate
 * mode. One predicate answering two questions is fine only while the answers coincide; they no
 * longer do.
 *
 * The two positions still read DIFFERENT persisted settings behind the one control shape
 * (`conciergeSpeakAutoSend` / `conciergePttAutoSend`) — see the store's doc for why one shared
 * boolean would switch off a mode the user was not in.
 */
export function modeHasAutoSend(mode: SendMode): boolean {
  return mode === "speak" || mode === "ptt";
}

/**
 * The floor under the countdown, in milliseconds.
 *
 * The adaptive ladder (voice/confidence `CONFIDENCE_THRESHOLD_MS`, 1 / 3 / 5 / 10 s) already bottoms
 * out at one second, so today this changes no number. It is stated as its OWN constant because it
 * is a different claim from the ladder's: the ladder is a heuristic that may be retuned, and this
 * is the promise that no retune may drop below one second of visible sweep. A sweep shorter than
 * that is not a countdown — it is a flicker between two frames, and the user never gets the chance
 * the countdown exists to give them.
 */
export const SWEEP_FLOOR_MS = 1_000;

/** The threshold the tray sweep actually runs against: the ladder's rung for this tier, never
 *  faster than {@link SWEEP_FLOOR_MS}. */
export function sweepThresholdMs(tier: Confidence): number {
  return Math.max(SWEEP_FLOOR_MS, thresholdMs(tier));
}

/**
 * Is the tray INERT — i.e. not being addressed?
 *
 * Reuses the SHIPPED focus-owner rule (./dictationFocus) rather than asking "is the composer
 * focused". Those look equivalent and are not. `FocusOwner` is `"terminal" | "other"` where
 * `"other"` is anything else INCLUDING NOTHING AT ALL, so `<body>`, a button, and the tray itself
 * are all addressed. Keying on "the composer has focus" instead greys the tray for every focus move
 * the app's own chrome causes — the control would boot grey and no button could arm it, because
 * `focusin` fires before a button's own `click` handler.
 *
 * GREY HERE DOES NOT MEAN DISABLED. It means your keystrokes are going somewhere else — a live PTY
 * owns the keyboard. The tray keeps showing which mode is selected (the mode has not been reset, it
 * is merely not receiving you) and colour returns the instant focus leaves the terminal.
 */
export function trayInert(focusOwner: FocusOwner): boolean {
  return focusOwner === "terminal";
}

/** Which keystroke sends. A SETTING in the design; a prop with a default in the app today, because
 *  no such setting has shipped yet — see {@link DEFAULT_SEND_CHORD}. */
export type SendChord = "cmd-enter" | "enter";

/** What the concierge composer honours today (`ComposeBox` sends on ⌘↩ / ⌃↩ and never on a bare
 *  ↩, which the mention picker owns). The chiclet must follow this, not lead it. */
export const DEFAULT_SEND_CHORD: SendChord = "cmd-enter";

/** The modifier state of a keydown, narrowed to what the decision needs — so this stays callable
 *  from a test with an object literal and no synthetic event. */
export interface ChordKey {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/**
 * Does this keystroke send, in this mode, under this setting?
 *
 * ── ⌘↩ SENDS IN EVERY POSITION, PUSH TO TALK INCLUDED (sparkle-u81cz) ──────────────────────────
 * This used to open with `if (mode === "ptt") return false`, on the reasoning that `⌘` means *talk*
 * there so `⌘↩` must not also mean send. The founder asked for both: *"I can tap the command key to
 * have what I typed send, but I could also type command enter, and that would also send it."*
 *
 * IT DOES NOT DOUBLE-SEND, and the reason is a guard that already exists rather than anything added
 * here. `usePushToTalk` treats a SECOND KEY arriving mid-hold as proof the gesture was a chord and
 * not speech, so it ABANDONS the hold — and an abandoned hold sends nothing. The full ⌘↩ sequence
 * is therefore: `Meta` down starts a hold → `Enter` down abandons it (no send) and this function
 * submits once → `Meta` up finds no hold and does nothing. Exactly one send, from the composer.
 * That guard was written for ⌘V/⌘A/⌘Z, and ⌘↩ is simply another chord it already covered; the
 * historical stacking this docblock used to warn about predates it. `ComposeBox.test.tsx` and
 * `sendMode.test.ts` both pin the call COUNT, not merely that a send happened.
 *
 * So the hold is no longer the only way a typed draft can leave the box in this mode — which also
 * removes the trap `usePushToTalk`'s header describes, where gating the release on a minimum
 * duration or a transcript delta would have stranded a typed message with no send path at all.
 *
 * ⌃↩ is accepted alongside ⌘↩ under the `cmd-enter` setting because the shipped composer already
 * accepts it and removing a working chord is not this change's business.
 */
export function chordSends(mode: SendMode, chord: SendChord, e: ChordKey): boolean {
  if (e.key !== "Enter") return false;
  if (e.shiftKey) return false; // ⇧↩ is a newline in both settings
  if (chord === "cmd-enter") return Boolean(e.metaKey || e.ctrlKey);
  return !e.metaKey && !e.ctrlKey && !e.altKey;
}

/**
 * The keycap the pill for `mode` is allowed to draw.
 *
 * A CHIP THAT LIES ABOUT THE KEYSTROKE IS WORSE THAN NO CHIP — it is the exact thing the founder
 * asked to have fixed. So this is derived from the same `chord` that {@link chordSends} decides on,
 * and Push to talk shows `⌘` (the gesture that mode actually has) rather than a send chord that is
 * inert there.
 */
/**
 * How the push-to-talk key is DRAWN. The key itself is `usePushToTalk.TALK_KEY` ("Meta"); this is
 * the same fact rendered for a human, and the two are documented as a pair there.
 *
 * ONE LITERAL, because three surfaces now name this key: the tray's keycap chiclet (below), the mic
 * caption, and the composer placeholder (both in ./dictationCopy). Push-to-talk copy exists at all
 * because the wake word was retired and PTT could no longer borrow Speak's opposite — so the copy
 * arrived on two surfaces at once, which is exactly the shape that drifts when each spells the
 * glyph out itself. The binding is not remappable today; if it ever becomes so, this constant is
 * the single place that has to start reading it.
 */
export const TALK_KEY_GLYPH = "⌘";

export function chicletFor(mode: SendMode, chord: SendChord): string {
  if (mode === "ptt") return TALK_KEY_GLYPH;
  // ↩ (U+21A9), not ↵ (U+21B5). The prototype drew ↵; the app already spells the Return glyph ↩ in
  // five places, and two different arrows for one key across one window is a difference a reader
  // has to decide is meaningless before they can ignore it.
  return chord === "cmd-enter" ? "⌘↩" : "↩";
}
