// The one compose box in the app (the terminal has none — the concierge is where you talk).
// Attach row (ONE paperclip, expanding to Screenshot / Upload) above a textarea + Send row;
// ⌘/Ctrl+Enter submits. Purely presentational: submit reports trimmed text via onSend and clears.
//
// A LONG PASTE COLLAPSES INTO A PILL here too, exactly as it does in the build-agent composer, off
// the same pure model and the same components (composer/attachments + composer/TextPill). What
// leaves this box is still the FULL pasted text — the pill is a display decision, expanded inline by
// `composeBody` at submit — and the one failure worth naming is a surface that sends a pill's LABEL
// instead, which would look like it worked. See `submit` and ComposeBox.collapsedPaste.test.tsx.
//
// THERE IS NO MIC BUTTON HERE, and putting one back would re-create the bug this box was fixed for.
// It used to carry one immediately left of the textarea, next to Send — which meant the concierge
// column showed TWO microphones, this one and the waveform ring in the column header a few inches
// above it, with nothing to say which was in charge. The ring won: it is the app's single mic
// control (arm / mute / off) and it also names the concierge as the voice surface, which is what
// steers dictated speech into this box. See LogoWaveform and dictationStore.voiceSurface.
//
// ATTACHMENTS (parity row #21). The attach control reports a KIND; the host runs the picker and owns
// the resulting list, which comes back as `attachments` and renders as removable chips. The box
// stays Tauri-free — it never opens a dialog, reads a file, or listens for a drop. It only paints
// `dropActive`; the drag hit-test itself is on the COLUMN around it (CONCIERGE_COLUMN_DND_TARGET,
// services/dndTargets), because a drop anywhere over the concierge belongs here and this box is a
// ~90px strip that a real cursor misses. With something attached, an EMPTY message is still
// sendable (an image alone is a
// message), which is the one place attachments change the submit rule.
//
// SEND TARGET — NOT HERE ANY MORE. This box used to carry an explicit "→ Sparkle" / "→ <agent>"
// toggle, on the reasoning that inferring the target would either bury a prompt in a chat thread
// or fire an agent turn the user didn't ask for. That call was reversed on 2026-07-26: the box is
// EMPTY and the host ROUTES (services/conciergeRouter, PRD/sparkle/concierge-auto-routing.md §2).
// What makes the inference safe is not better guessing — it's that every send posts a visible
// receipt naming where it went, with a one-tap redirect (§3). If you are ever tempted to route
// silently, put the toggle back instead.
//
// THE PLACEHOLDER IS A RICH OVERLAY, NOT AN EMPTY STRING. This box shipped with `placeholder=""`
// on the founder's ask for "just an empty compose window". Shown both renderings side by side, the
// user chose the RICH one, so the native placeholder stays "" and composer/RichPlaceholder paints
// the copy over the textarea instead. An overlay is not a flourish: a native `placeholder=` is one
// flat string and cannot render the wake phrase bold + brand blue inside an otherwise muted
// sentence, which is the whole point of the copy.
//
// What survives from the empty-box era, unchanged:
//   • the ⌘↩ hint stays on the Send button's tooltip + aria-keyshortcuts. Do NOT put a
//     "(⌘↩ to send)" tail back into the placeholder — it was deliberately removed in PR #631.
//   • nothing here NAMES A DESTINATION. The slot's `off` fallback (CONCIERGE_PLACEHOLDER) says
//     what the box is FOR, never where a send would land — the host routes, per message, and the
//     box cannot make that promise before the user has written anything (see SEND TARGET above).
//
// ACCESSIBILITY, corrected. The old header claimed "the box still reads as empty to a screen
// reader". That is still true of the ORDINARY copy — the decorative overlay is aria-hidden, so the
// textarea's own accessible name ("Message") is all that is announced — but it is deliberately NOT
// true of the two FAILURE states. A dictation error and a refused out-of-credits arm each carry a
// control (Dismiss / Refill), and aria-hidden hides a whole subtree with no way for a descendant to
// opt back in, so each gets its OWN sibling overlay with role="status". They are announced on
// purpose: this box is the app's only composer, so a mic failure has no other home.
//
// HEIGHT is measured, never fixed — and the placeholder counts as content. The box auto-grows with
// what you type up to a ten-line cap, past which it scrolls, and a drag handle on its top edge
// overrides that (policy in engine/composeBoxHeight; this file measures and listens). The overlay
// above forces one addition to that scheme: a textarea's scrollHeight cannot see a SIBLING, so an
// empty box measures one line while three lines of placeholder are painted over it. So the overlay
// is measured too and feeds `placeholderH`, a FLOOR under auto-grow. Get that wrong and the rich
// placeholder is clipped to its first fragment — which is the exact bug it replaced
// `placeholder=""` to fix, and it would fail silently, since nothing about a clipped overlay throws.
//
// Dictation (bead sparkle-4562.2 / CM-U9) keeps that contract. The box knows nothing about the
// mic pipeline: it hands its append fn to the integration layer through registerInsert (mirroring
// dictationStore registerInsert, which is what the agent composer already does) and renders
// whatever live transcript arrives back as the interim prop. COMMITTED segments land in the
// textarea and are editable and sendable like typed text; the INTERIM preview stays out of the
// textarea's VALUE, because Deepgram replaces it word-by-word and a send that captured it would
// ship a half-heard phrase that is about to be superseded (see `submit`, which sends `text`).
//
// Out of the value is NOT out of the box. This header used to say the preview "stays outside the
// textarea", and it was built that way — a strip of italic text in its own row above — which the
// founder reported as the spoken words "still showing above the actual text", one sentence drawn on
// two lines, each phrase jumping down into the box as it committed. The preview is now painted
// INSIDE the prompt bar, in the mention mirror behind the textarea, at the end of the draft and in
// the textarea's own metrics: italic while provisional, and simply gone once the committed words
// are drawn upright by the real textarea in the same place. See ./MentionMirror.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
// FiFile left with the chip row it belonged to — the shared AttachmentStrip draws the file glyph now.
import { FiAlertTriangle, FiUpload, FiX } from "react-icons/fi";
// THE SCREENSHOT GLYPH IS DRAWN HERE, NOT IMPORTED — see CaptureRegionIcon below for both the
// shape and the reason it is inline.
// `C` ALONE, and the three tokens that left are the two halves of this merge, not an oversight:
// FONT_WEIGHT / ON_GOLD_FILL went with the Send button when it moved into ./SendRail (the gold
// rect's styling travelled verbatim, so SendRail imports them itself), and COMPOSE_SCRIM went with
// the scrim when `.cmp` became a box on `--k-input` — see the long note on the root's `background`.
import { appendDictatedForClipboard } from "../../voice/dictationClipboard";
import { C } from "../../theme/colors";
import { BLUEPRINT } from "../../theme/blueprintSpec";
import { useResolvedTheme } from "../../theme/theme";
import type { Attachment, ConciergeAttachKind } from "./types";
import { useUiStore } from "../../stores/uiStore";
import { PresenceSlider } from "./PresenceSlider";
import { usePresenceStore } from "../../stores/presenceStore";
import {
  ComposerVoiceError,
  RichPlaceholderOverlay,
  VoicePlaceholderCopy,
} from "../composer/RichPlaceholder";
import { ComposerOutOfCreditsNotice } from "../OutOfCreditsNotice";
// A LONG PASTE COLLAPSES INTO A PILL — the same feature, the same components, the same pure model
// as the build-agent composer (see composer/TextPill's header for the three surfaces). Nothing here
// is a concierge-flavoured copy: the threshold, the expand rule and — above all — what a send
// EXPANDS TO all come from composer/attachments, so this box cannot grow its own idea of what a
// pill stands for. That matters because the failure would be silent: a surface transmitting a
// pill's LABEL instead of its text still looks like it worked.
import {
  collapseText,
  composeBody,
  expandTextBlock,
  shouldPasteAsPill,
  type CollapsedSend,
  type TextBlock,
} from "../composer/attachments";
import { nextId } from "../composer/attachmentsApi";
import { AttachmentStrip } from "../composer/AttachmentStrip";
import { TextPill } from "../composer/TextPill";
import { TextPillModal } from "../composer/TextPillModal";
import { QuoteChip } from "./QuoteChip";
import type { ComposeQuote } from "./composeQuote";
import { useVoicePlaceholder } from "../../voice/useVoicePlaceholder";
import { useDictationStore } from "../../stores/dictationStore";
import {
  focusQuietly,
  focusQuietlyUnlessMidMessage,
  isProgrammaticFocus,
} from "../../services/programmaticFocus";
import { classifyFocusOwner } from "../../voice/dictationFocus";
import { log } from "../../logger";
import {
  CONCIERGE_THREAD_TESTID,
  composeDragH,
  composeDragReleasesManual,
  composeRenderH,
} from "../../engine/composeBoxHeight";
import { MentionPicker, MENTION_LISTBOX_ID, mentionOptionId } from "./MentionPicker";
import {
  backspaceMention,
  dictatedSparkleAddress,
  insertMention,
  isCompletedMention,
  mentionQuery,
  mentionRoster,
  mentionsIn,
  orderMentionAgents,
  SPARKLE_MENTION_AGENT,
  SPARKLE_MENTION_ID,
  type ConciergeMention,
  type MentionAgent,
} from "./mentions";
import { classifyComposerRoute } from "./composerRoute";
import { TERM_BODY_BASE_SIZE, TERM_BODY_FONT } from "../terminalChrome";
import { MentionMirror, MENTION_MIRROR_SKIP_ATTR } from "./MentionMirror";
import { SendModeTray, type SendTrayModel } from "./SendModeTray";
import {
  DEFAULT_SEND_CHORD,
  chordSends,
  modeCountsDown,
  type SendChord,
  type SendMode,
} from "../../voice/sendMode";
import { AutoSendToggle } from "./AutoSendToggle";
import { micCaptionKind } from "../../voice/micPresentation";

const line = `color-mix(in srgb, ${C.muted} 25%, transparent)`;

/** The countdown a box mounted WITHOUT auto-send wiring draws: nothing. Module-level so it is the
 *  same object every render — the tray is memo-friendly and a fresh literal per render would defeat
 *  that for no gain. */
const IDLE_COUNTDOWN: SendTrayModel = {
  phase: "disarmed",
  targetName: "",
  tier: "verylow",
  remainingFraction: 1,
};

/** A module-level empty roster, so a box mounted without `mentionAgents` gets the SAME array every
 *  render. A `= []` default would mint a new one per render, and this list feeds the memo that
 *  builds the picker's rows — a fresh identity each time defeats it. */
const EMPTY_MENTION_AGENTS: readonly MentionAgent[] = [];

/** What the box is FOR, painted in the placeholder slot whenever the mic makes no voice promise —
 *  i.e. master mute, which is the DEFAULT (ambient listening is opt-in, dictationStore
 *  `enabled: false`), so this is what a fresh install reads. The build Composer renders nothing at
 *  all in that state and can afford to: it sits under an agent's terminal, which says what it is.
 *  This box floats under a chat thread with no label of its own, so an empty slot would leave the
 *  app's only composer unexplained.
 *
 *  It deliberately names NO DESTINATION. The reference rendering for this slot read "Talk to
 *  Sparkle — …" (and, when aimed at an agent, "Prompt <agent> — this goes straight to its
 *  terminal"), which was true while the box carried an explicit send-target toggle. Auto-routing
 *  removed that toggle: the host decides per message, so the box cannot promise a destination
 *  before the user has typed anything, and ComposeBox.test.tsx pins that it never tries. */
export const CONCIERGE_PLACEHOLDER = "Ask about any project, or say what to build.";

/** How wide the textarea's TEXT column actually is at the shipped column width, and therefore the
 *  budget any right-edge reservation would have to fit inside. From Workspace's 360px: the
 *  column's own 12px×2 padding, the Send button (~63), the row's 8px gap, and the textarea's
 *  12px×2 padding + 1px×2 border all come off. (It used to subtract a ~31px mic button and a
 *  second 8px gap as well; that button is gone — the header ring is the one mic — so the text
 *  column is 39px wider than it was.) Approximate on purpose — it exists to be COMPARED against
 *  SUGGESTION_PILL_ZONE, and the two are far enough apart that a few pixels either way cannot
 *  change the answer. Exported so that comparison is a test rather than a claim in a comment
 *  (see ComposeBox.placeholder.test.tsx). */
export const CONCIERGE_TEXTAREA_TEXT_WIDTH = 360 - 24 - 63 - 8 - 26;

/** The textarea's border (1px) + padding (10px/12px): where a native placeholder's first line would
 *  land, and therefore where the overlay must paint.
 *
 *  `bottom` is kept even though the box AUTO-GROWS to fit this overlay (engine/composeBoxHeight's
 *  placeholder floor), because that growth stops at COMPOSE_CAP_H. Copy past the cap has to go
 *  somewhere, and clipping at the box's edge — which is what `bottom` plus the overlay's
 *  `overflow: hidden` buys — is what a native placeholder does. Without it that copy would spill
 *  out over the composer's neighbours instead. Belt and braces: the floor means it should never
 *  actually bite. */
const PLACEHOLDER_INSET = { top: 11, left: 13, right: 13, bottom: 11 };
/** Must match the textarea's own type ramp below, or the overlay won't sit on row one. */
const PLACEHOLDER_TYPE = { fontFamily: "inherit", fontSize: 13, lineHeight: 1.4 };

/**
 * The textarea's TEXT GEOMETRY, in one object because two elements have to agree on it exactly.
 *
 * The mention mirror (./MentionMirror) paints the pill fills behind the real text, so every property
 * here that moves a glyph — the type ramp, the padding, the border that the padding is measured from
 * — must be identical on both or the fills slide off the words they belong to. Spreading one object
 * into both makes that structural; two lists of the same six properties would drift the first time
 * anybody tuned the padding, and it would drift SILENTLY (a misaligned pill still renders).
 *
 * `borderRadius` rides along because it is part of the same box, not because the mirror needs it.
 */
/** The textarea's resting bottom padding.
 *
 *  Named because the dictation spacer transiently ADDS to it — see `dictationPadBottom` in the
 *  component below — and because the layout effect must put it back to exactly this before reading
 *  `scrollHeight`, which counts padding. Exported so a test can model that measurement honestly
 *  rather than stubbing a constant height that no padding can move. */
export const COMPOSE_TEXT_PAD_BOTTOM = 10;

const COMPOSE_TEXT_METRICS: CSSProperties = {
  fontFamily: "inherit",
  fontSize: 13,
  lineHeight: PLACEHOLDER_TYPE.lineHeight,
  padding: `${COMPOSE_TEXT_PAD_BOTTOM}px 12px`,
  // The border is `transparent` rather than absent on purpose — see the textarea's own note below;
  // the placeholder overlay's geometry and the auto-grow measurement are both taken off this box.
  border: "1px solid transparent",
  borderRadius: 6,
};

/**
 * THE SAME GEOMETRY, SET IN THE TERMINAL'S OWN FACE — what the box looks like while what you type
 * is going into an agent's terminal rather than to the concierge.
 *
 * ══ THE FOUNDER'S ASK, AND WHY IT IS THE TYPEFACE ═══════════════════════════════════════════════
 * *"When I'm talking to a terminal view in a mounted concierge, I want the font style to change, to
 * be the same font style as it is in the terminal."* The font IS the routing indicator: with the
 * concierge patched to a build agent, plain text goes to that agent's PTY and `@Sparkle` pulls it
 * back to the concierge (Concierge/composerRoute) — and the difference between those two
 * destinations is otherwise invisible while you are mid-sentence. A label would have to be read; a
 * typeface is seen.
 *
 * ══ WHY THE FACE COMES FROM `TERM_BODY_FONT` ════════════════════════════════════════════════════
 * It is the literal stack xterm is constructed with (components/Terminal). Re-typing it here would
 * be the exact silent drift `terminalChrome`'s header is about: the composer would simply stop
 * looking like the terminal, and no test would go red because nothing would be WRONG, only
 * different. Same for the size — `TERM_BODY_BASE_SIZE` is what xterm gets at zoom 1, and it happens
 * to equal the composer's own 13, so today this changes the FACE and not the metrics. Reading it
 * from the constant is what keeps that true if somebody retunes the terminal.
 *
 * ZOOM IS DELIBERATELY NOT FOLLOWED — see TERM_BODY_BASE_SIZE. The base size, not the zoomed one.
 *
 * `fontWeight: 400` is stated rather than inherited because xterm's own default is `normal`, and the
 * composer sits inside the app's UI cascade, which is free to set something else. Matching "closely
 * enough that it reads as the same typeface" means the weight is part of the match, not an accident
 * of what the surrounding column happened to be set in.
 *
 * ONE OBJECT, SPREAD INTO BOTH CONSUMERS, for the reason the constant above exists at all: the
 * mention mirror paints pill fills behind the real glyphs, and a font swap that reached the textarea
 * but not the mirror would slide every fill off the word it belongs to — silently, because a
 * misaligned pill still renders.
 */
const COMPOSE_TEXT_METRICS_TERMINAL: CSSProperties = {
  ...COMPOSE_TEXT_METRICS,
  fontFamily: TERM_BODY_FONT,
  fontSize: TERM_BODY_BASE_SIZE,
  fontWeight: 400,
};

const attachStyle: CSSProperties = {
  fontSize: 12,
  color: C.conciergeMuted,
  background: "transparent",
  border: `1px solid ${line}`,
  borderRadius: 6,
  padding: "5px 9px",
  cursor: "pointer",
  display: "inline-flex",
  gap: 5,
  alignItems: "center",
};

/**
 * THE CAPTURE-REGION GLYPH: four solid rounded corner brackets with two short dashes along each
 * side between them — the macOS screen-capture marquee.
 *
 * THE FOUNDER SPECIFIED THIS SHAPE AND REJECTED THE ALTERNATIVE UNPROMPTED: "the four corners
 * screenshot with like a dotted lines in between the four solid corners… it shouldn't be the
 * camera, I don't think." He chose it over two other weight-matched candidates (Lucide `scan` —
 * the same corners with bare sides, crisper at this size; Tabler `capture` — corners plus a centre
 * circle, which reads as a lens).
 *
 * ── WHY IT IS HAND-DRAWN RATHER THAN IMPORTED ──────────────────────────────────────────────────
 * This is Lucide's `square-dashed`, path for path. It was first written as a `LuSquareDashed`
 * import from `react-icons/lu`, which works — but `react-icons/lu` is a single barrel module
 * declaring every Lucide icon, so importing one glyph puts the whole set into the module graph of
 * every suite that renders a concierge. `react-icons/fi` is already in this file's graph for the
 * other glyphs; adding a SECOND entire icon set for one shape is a different trade, and twelve
 * <path> elements is a smaller thing to own than that dependency.
 *
 * NO PERFORMANCE CLAIM IS BEING MADE HERE. The barrel was briefly suspected of causing a 48s
 * timeout in ConciergeHost.liveness's queue-overflow test; it was measured and it is not the cause
 * (that test times out identically with this whole feature reverted — it is load-sensitive). The
 * reason above is dependency weight, not speed. Do not cite this comment as evidence that barrel
 * imports are slow in tests.
 *
 * The geometry is Feather's own (24px grid, 2px stroke, round caps, `currentColor`) because Lucide
 * is a fork of Feather — which is the whole reason this shape could be borrowed without looking
 * heavier than the `fi` icons beside it. Keep those four attributes if you ever redraw it.
 */
/** What ATTACH_ACTIONS' `Icon` slot accepts: the props this file actually passes. Wide enough for a
 *  react-icons glyph and for the hand-drawn one above, so the two are interchangeable in the row. */
type AttachGlyphProps = { size?: number; "aria-hidden"?: boolean };
function CaptureRegionIcon({ size = 13 }: AttachGlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {/* The four solid corners. */}
      <path d="M5 3a2 2 0 0 0-2 2" />
      <path d="M19 3a2 2 0 0 1 2 2" />
      <path d="M21 19a2 2 0 0 1-2 2" />
      <path d="M5 21a2 2 0 0 1-2-2" />
      {/* Two dashes per side, between them. */}
      <path d="M9 3h1" />
      <path d="M14 3h1" />
      <path d="M9 21h1" />
      <path d="M14 21h1" />
      <path d="M3 9v1" />
      <path d="M3 14v1" />
      <path d="M21 9v1" />
      <path d="M21 14v1" />
    </svg>
  );
}

/** THE TWO ATTACH ACTIONS, BOTH ALWAYS ON SCREEN.
 *
 *  This row has had three shapes. It began as three permanently-visible LABELLED buttons
 *  (Screenshot / Image / Files) — three controls' worth of chrome above a compose box whose whole
 *  design is to look empty. That collapsed to ONE paperclip that expanded into these two on hover
 *  or focus. It is now these two, permanently visible, as icons with no word at all.
 *
 *  THE PAPERCLIP IS GONE BECAUSE OF WHAT IT COST THE COMMON CASE. Screenshot is the founder's
 *  single highest-frequency composer action — he sends them constantly, and each one turns a vague
 *  report into a diagnosis. The expansion made that action cost two interactions (reveal, then
 *  choose) where it had cost one, to save chrome that two icon-only buttons do not actually spend:
 *  the resting row is now 2 controls wide where the expanded row was 3.
 *
 *  NO PERMANENT WORD, BY REQUEST — "it doesn't have to say screenshot, it could say screenshot on a
 *  mouse over". So `label` is the hover tooltip AND the accessible name, and nothing is drawn but
 *  the glyph. That makes the two identical, which is the a11y-correct pairing anyway: what a
 *  pointer user is told on hover is exactly what a screen-reader user is told on focus.
 *
 *  Two actions, not three: `image` and `files` are the same OS panel, differing only in whether it
 *  is narrowed to the image extensions, and "upload an image" vs "upload a file" is not a
 *  distinction worth a second target — the unfiltered picker takes images too, and the chip it
 *  produces is identical (loadAttachment classifies by extension, so a picked .png is still
 *  `kind: "image"` with a thumbnail).
 *
 *  `pickAttachments("image")` is NOT dead: the kind stays in ConciergeAttachKind and keeps its unit
 *  coverage in services/conciergeAttach.test.ts. It is a supported service option this surface
 *  currently doesn't spend a target on. Don't delete it to "clean up" — restoring an image-narrowed
 *  entry point (a paste path, a second surface) should not have to re-derive the picker. */
const ATTACH_ACTIONS: {
  kind: ConciergeAttachKind;
  /** Drawn nowhere. It is the `title` (hover tooltip) and the `aria-label` (accessible name). */
  label: string;
  Icon: ComponentType<AttachGlyphProps>;
  // The keyboard-hint id, carried here rather than derived from `kind`: the ids are named for what
  // the user sees ("upload") while the kind is named for the service call it makes ("files"), and a
  // derived id would silently break the hint the day either name changes for its own reasons.
  hint: string;
}[] = [
  { kind: "screenshot", label: "Screenshot", Icon: CaptureRegionIcon, hint: "attach-screenshot" },
  { kind: "files", label: "Upload", Icon: FiUpload, hint: "attach-upload" },
];

/**
 * The composer's fixed horizontal insets, in px — what separates the COLUMN's width from the width
 * the toolbar row actually gets.
 *
 * `margin: 0 10px` (20) + `padding: "10px 12px 12px"` (24) + `border: 1px` (2) = 46.
 *
 * THE LABELLED VALUES, deliberately, even though the narrow state uses 2px margins. This number
 * feeds the threshold that DECIDES the narrow state, so reading the live margins here would rebuild
 * the feedback loop that was just removed (see the observer below). A fixed inset keeps the input
 * stable; being 16px pessimistic in the narrow state only means the labels stay collapsed slightly
 * longer than strictly necessary, which is the safe direction.
 */
export const COMPOSER_INSETS_PX = 46;

/**
 * Below this COLUMN width (px) the toolbar row drops its words and draws icons only.
 *
 * ── THE UNIT MATTERS, AND IT CHANGED (roborev 57270) ────────────────────────────────────────────
 * This was derived as the TOOLBAR ROW's own min-content width — the two attach labels (~76 + ~48px),
 * their icons and padding (~30px each), the row gap, and the Here/Away slider (~96px) — and it was
 * compared against a measurement of that row. When the observer moved to the composer's PARENT (to
 * kill an oscillation), the comparison silently started using a number 46px larger while the
 * constant kept its old value, so the collapse fired 46px too late: every column in [300, 346) hands
 * the labelled row less than the ~300px it needs, which is exactly the degradation this tier exists
 * to prevent.
 *
 * So the constant is expressed in COLUMN terms — the toolbar requirement plus the insets — and
 * named for it. `toolbarShowsLabels` takes a column width, and the parameter says so.
 *
 * ── THE ATTACH HALF OF THAT DERIVATION IS NOW SLACK, DELIBERATELY ───────────────────────────────
 * The attach group no longer HAS words to drop at any width: it is two icon-only buttons (~30px
 * each + a 6px gap ≈ 66px, fixed), so the ~124px the two labels used to claim is gone and the only
 * thing still trading width for words is the PresenceSlider (~96px labelled, ~52px as glyphs).
 * Re-derived from scratch the threshold would land near 170.
 *
 * The value is held at 300 anyway, and that is a decision rather than an oversight. Lowering it
 * would change WHEN the Here/Away slider collapses — a behaviour change to a control the founder
 * did not ask about, in the direction (labels surviving into narrower columns) that this tier
 * exists to prevent. Being pessimistic only means the slider collapses to glyphs slightly earlier
 * than strictly necessary, which the original derivation already called the safe direction.
 */
export const TOOLBAR_ICON_ONLY_MAX_COLUMN_PX = 300 + COMPOSER_INSETS_PX;

/**
 * Does the toolbar row draw words at this COLUMN width?
 *
 * Governs the PresenceSlider only — see the constant's second section for why the attach group no
 * longer consults it.
 *
 * Pure and exported for this file's usual reason (cf. `appendDictated`): jsdom has no layout engine,
 * so a test that rendered the row and measured would read 0 for every width and pass vacuously. The
 * component measures; this decides.
 *
 * 0 means "not measured yet" and takes the LABELLED form, matching `trayDensityFor`: booting into
 * the collapsed state and widening a frame later is a visible flicker.
 */
export function toolbarShowsLabels(columnWidthPx: number): boolean {
  return !(columnWidthPx > 0) || columnWidthPx >= TOOLBAR_ICON_ONLY_MAX_COLUMN_PX;
}

/**
 * THE TWO ATTACH ACTIONS, SIDE BY SIDE AND ALWAYS VISIBLE — the founder's ask, replacing the single
 * paperclip that expanded into them on hover.
 *
 * WHAT THIS DELETED, AND WHY NONE OF IT IS OWED A REPLACEMENT. The old control was a disclosure,
 * and nearly all of its code existed to make a disclosure survive contact with reality: `hovered ||
 * `pinned` as two independent opens so neither could close what the other held; a click that opened
 * but never closed (by the time you can click it, hover has already opened it); Escape unwinding it
 * with a one-shot guard so the focus handback would not immediately re-pin what Escape just closed;
 * `hidden` on the actions so the announced state and the tab order could not drift apart.
 *
 * Every one of those was correct, and every one of them was solving a problem created by hiding two
 * buttons behind a third. With both buttons simply present there is no open state to hold, nothing
 * to unwind, nothing to announce as expanded, and nothing that can be visible-but-unfocusable. That
 * is why this is ~15 lines where it was ~150 — the machinery went away with the thing it managed,
 * not into some other file. Do not reintroduce a disclosure here without re-reading the four
 * behaviours above; they are the cost of one.
 *
 * NARROWER AT REST THAN THE THING IT REPLACED. The concern with two permanent controls is the
 * narrow column (bead sparkle-kk9dg), but the arithmetic runs the right way: this row is 2
 * icon-only buttons where the EXPANDED old row was 3 (paperclip + two actions, labelled until
 * ~346px). The resting row grew by one control and the worst case shrank by one.
 *
 * `minWidth: 0` / `flexWrap` stay, and they are still load-bearing. This is a flex item of the
 * toolbar, so its own default `min-width: auto` refuses to go below its min-content and the
 * toolbar's `flex-wrap` cannot break INSIDE it — which is how the row ran past the column's right
 * edge in the founder's original narrow-column report.
 */
/** Exported for a RENDER test: only a render can prove these two buttons carry an accessible name,
 *  since neither ever draws a visible word (roborev 57049 pinned the same property of the older
 *  collapsed form). */
export function AttachControl({
  onAttach,
}: {
  onAttach: (kind: ConciergeAttachKind) => void;
}) {
  return (
    <div
      data-testid="concierge-attach"
      style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, flexWrap: "wrap" }}
    >
      {ATTACH_ACTIONS.map(({ kind, label, Icon, hint }) => (
        <button
          key={kind}
          type="button"
          // THE HOVER TOOLTIP AND THE ACCESSIBLE NAME ARE THE SAME STRING, on purpose. The founder
          // asked for no permanent word ("it could say screenshot on a mouse over"), which leaves
          // `title` as the only thing a pointer user is ever told — so an `aria-label` that said
          // something else would be describing a different control to a screen reader.
          title={label}
          aria-label={label}
          // A LEAF hint now, not a chaining trigger: there is no group left to expand, so selecting
          // one of these fires it and closes the overlay like any other chrome control. Both letters
          // live in CHROME_HINTS (see keyboardHints/hintTargets) rather than in a scoped sub-layer.
          data-hint={hint}
          onClick={() => onAttach(kind)}
          style={{ ...attachStyle, padding: "5px 7px" }}
        >
          <Icon size={13} aria-hidden />
        </button>
      ))}
    </div>
  );
}

/** Where a committed dictation segment goes in the box: appended, space-separated, never
 *  double-spaced. Pure so the commit rule is testable without a mic.
 *
 *  ONE IMPLEMENTATION, DELEGATED — not a copy (roborev 59596). The clipboard mirror has to produce
 *  exactly what this box would have held, and it was re-implementing the rule byte-for-byte with a
 *  comment claiming a cross-checking test that did not exist. Two identical bodies and no guard is
 *  the shape that drifts silently: normalize interior whitespace here, or join multi-sentence
 *  segments with a newline, and the mirror keeps the old rule while every suite stays green.
 *  Delegating makes the drift unrepresentable, and the direction is deliberate — the React-free
 *  module owns the rule so nothing has to import a component to reuse it. */
export function appendDictated(current: string, segment: string): string {
  return appendDictatedForClipboard(current, segment);
}

export function ComposeBox({
  onSend,
  onAttach,
  onRemoveAttachment,
  attachments = [],
  dropActive = false,
  attachNotice = null,
  onDismissAttachNotice,
  interim = "",
  registerInsert,
  onTextEdit,
  wired = false,
  mentionAgents = EMPTY_MENTION_AGENTS,
  preferredAgentId = null,
  mountedAgentId = null,
  autoSend,
  sendMode = "send",
  onSendModeChange,
  autoSendOn = true,
  onAutoSendChange,
  trayInert = false,
  pttHeld = false,
  sendChord = DEFAULT_SEND_CHORD,
  onComposedText,
  registerSubmit,
  quote = null,
  onRemoveQuote,
  draftKey = "concierge",
}: {
  /** Reports the trimmed text (empty only when something is attached), plus the agents that text
   *  ADDRESSES by name — `undefined` when it addresses none.
   *
   *  `undefined` rather than `[]` for an unaddressed send, matching what `attachments` does on a
   *  file-less one: the mentions ride all the way onto the persisted thread message, and a thread
   *  that grew an empty array per message would pay for a distinction it never draws.
   *
   *  May return a promise resolving FALSE when the send failed, in which case the box restores the
   *  draft (see submit). */
  /** `collapsed` is the BUBBLE's decomposition of the same body (see composer/attachments'
   *  `CollapsedSend`) and is passed ONLY when a pill was staged — an ordinary send stays the
   *  one- or two-argument call it has always been. See `submit` for why it is a third argument
   *  rather than something the host re-derives from `text`. */
  onSend: (
    text: string,
    mentions?: ConciergeMention[],
    collapsed?: CollapsedSend,
  ) => void | Promise<boolean>;
  onAttach: (kind: ConciergeAttachKind) => void;
  onRemoveAttachment?: (id: string) => void;
  /** Staged files, owned by the host — rendered as chips, cleared by the host on send. */
  attachments?: Attachment[];
  /**
   * The transcript fragment this message is replying to, staged by the "Quote in response" chiclet.
   *
   * HOST-OWNED, exactly like `attachments` above, and that is the load-bearing choice rather than a
   * stylistic one. `onSend`'s ARITY is meaningful (see `submit`: one argument when nothing is
   * addressed, never an explicit `undefined`), so threading the quote through as a fourth parameter
   * would force `onSend(text, undefined, undefined, quote)` and break that contract. Attachments
   * already solve this by living on the host and being read at send time; the quote does the same,
   * and `onSend` keeps the signature it has always had.
   *
   * Consequently this box neither clears it on send nor restores it on a failed one — the host owns
   * both, in the same place it owns them for attachments.
   */
  quote?: ComposeQuote | null;
  onRemoveQuote?: () => void;
  /** A native file drag is over this box (the host hit-tests the window-global event). */
  dropActive?: boolean;
  /** Set when an attach attempt lost files — the box states it instead of leaving the user to
   *  notice that nothing arrived (bead sparkle-zviq). */
  attachNotice?: string | null;
  onDismissAttachNotice?: () => void;
  /** Live, uncommitted transcript; rendered as a ghost line, never submitted. */
  interim?: string;
  /** Must be referentially STABLE (useCallback upstream) — the box re-registers whenever it
   *  changes, and an unstable identity would churn the app-wide dictation target every render. */
  registerInsert?: (
    append: ((text: string, opts?: { verbatim?: boolean }) => void) | null,
  ) => void;
  /** The user TYPED (or deleted) — reports the new value. Not fired for dictated segments or the
   *  clear-on-send, so the host can see the box being emptied by hand. */
  onTextEdit?: (text: string) => void;
  /** The column around this box is PATCHED to a terminal (`data-wired` is left/right), so it has
   *  taken the terminal's colour. The composer then stops painting its own `--k-input` plate — it
   *  goes transparent over the flood with the terminal's own edge token around it, exactly as
   *  rev4.html's `.shell[data-wired] .assist .cmp` does. Purely presentational; the column decides.
   */
  wired?: boolean;
  /** Every builder agent the "@" picker may offer. Supplied by the host from the cross-project feed
   *  — this box has no store of its own (see the file header) and cannot ask who exists.
   *
   *  It is ALSO the roster a mention is resolved against, which is what makes a mention exactly as
   *  live as the fleet: an agent that leaves this list stops being addressable, and the aim it was
   *  carrying disappears with it rather than pointing at a corpse (see ./mentions). */
  mentionAgents?: readonly MentionAgent[];
  /** The agent a send would reach WITHOUT a mention — the selected build agent. Sorts to the top of
   *  the picker, so "@" then Enter aims at the thing already in front of you. */
  preferredAgentId?: string | null;
  /**
   * The agent the concierge is MOUNTED to (the cable is patched to it), or null when it floats free.
   *
   * Purely a rendering input here: it is what lets the box ask `classifyComposerRoute` where the
   * draft in front of the user would actually go, and SET ITSELF IN THE TERMINAL'S FACE when the
   * answer is a terminal. The founder's ask, and the reason it is the typeface rather than a label:
   * *"I want the font style to change, to be the same font style as it is in the terminal… when the
   * concierge is mounted and I'm interacting with that agent."* You can see where your words are
   * going without reading anything.
   *
   * NOT how the message is routed. The host decides that at submit, from its own captured-at-submit
   * mount (ConciergeHost's `send`), and it must stay that way — a live prop read inside a queued send
   * would deliver to whatever the user mounted while it was waiting. This prop and that decision are
   * two readings of one fact, and they agree because both call the same pure rule.
   */
  mountedAgentId?: string | null;
  /** The auto-send countdown's live state (PRD §4), supplied by the host from voice/autoSendTimer.
   *
   *  OPTIONAL, and its absence means NOTHING IS COUNTING rather than no tray: the tray is where
   *  Send lives now, so it renders either way. A host that has not wired auto-send up yet gets a
   *  three-position tray whose Speak position simply never counts down. */
  autoSend?: SendTrayModel;
  /** Where the send tray is parked. Absent → `send`, i.e. microphone off, nothing counting — the
   *  same default a box with no voice wiring at all should show. */
  sendMode?: SendMode;
  /** The user moved the tray. Absent → the tray's positions are inert (see `sendMode`). */
  onSendModeChange?: (next: SendMode) => void;
  /**
   * The **Auto-send** toggle's position — does an expired Speak countdown actually send?
   *
   * OFF DOES NOT MEAN "NO COUNTDOWN": the countdown still runs and still ends the utterance; only
   * the dispatch is withheld, leaving the words in this box. See ./AutoSendToggle.
   *
   * DEFAULTS TRUE so a host that has not wired the toggle up behaves exactly as Speak always has.
   */
  autoSendOn?: boolean;
  /** The user flipped Auto-send. ABSENT HIDES THE TOGGLE ENTIRELY — a switch nothing listens to
   *  would paint a position the user could move and the engine would ignore, which is worse than
   *  no switch. Same posture `onSendModeChange` takes for the tray's own positions. */
  onAutoSendChange?: (next: boolean) => void;
  /** A live PTY owns the keyboard, so the tray is NOT BEING ADDRESSED — it goes flat grey while
   *  still showing which mode is selected. Decided by the host from voice/dictationFocus; see
   *  voice/sendMode `trayInert` for why "is the composer focused" is a different question. */
  trayInert?: boolean;
  /**
   * Is the push-to-talk gesture active right now — key or button down?
   *
   * FORWARDED, not derived. `useSendMode` owns this and the host passes it through; this box is
   * presentational. Without the pass-through the tray's held treatment was DEAD CODE in the running
   * app (roborev 57452): both ends existed and both suites were green, because each drove its own
   * end in isolation and nothing asserted the seam between them — so the founder's original report
   * ("when I hit the command key it doesn't look any different than standby") survived the fix
   * that was supposed to close it.
   */
  pttHeld?: boolean;
  /** Which keystroke sends, so the tray's keycap chiclets follow the setting instead of asserting
   *  a default the handler might not honour. Defaults to what this box actually implements. */
  sendChord?: SendChord;
  /**
   * The box's contents changed, WHATEVER put them there — typed, dictated, or restored after a
   * failed send.
   *
   * Deliberately NOT `onTextEdit`, which is narrower on purpose: that one fires only for the user's
   * own edits, because the host uses it to retire routing latches ("this box was emptied by hand").
   * Auto-send needs the opposite — it has to see DICTATED text above all, since that is the only
   * kind it ever fires on. Folding the two together would either break the latch semantics or leave
   * the rail blind to speech (PRD §4).
   */
  onComposedText?: (text: string) => void;
  /**
   * Hand the host this box's submit, so the auto-send rail can fire the SAME path the button does.
   *
   * Mirrors `registerInsert`, and for the same reason: the host owns the countdown but the box owns
   * the text, the mention resolution and the clear-on-send. A host that sent the text itself would
   * leave the words sitting in the textarea behind the message it just sent.
   *
   * Must be referentially STABLE (useCallback upstream) — see `registerInsert`.
   *
   * The registered fn RETURNS whether a message actually went out. An empty box early-returns
   * `false`, which is the difference between the rail announcing a send and staying quiet.
   */
  registerSubmit?: (submit: (() => boolean) | null) => void;
  /**
   * WHICH CONVERSATION THE CURRENT DRAFT BELONGS TO. Changing it swaps the draft.
   *
   * TWO DRAFTS, NOT ONE, and that is an opinion worth stating. A single shared box means a half-typed
   * message to a build agent is sitting in front of SPARKLE the moment you unmount — aimed at the
   * wrong reader, and one Enter away from being sent to them. Keyed drafts make the box show what you
   * were writing to whoever you are now looking at, and nothing else.
   *
   * Defaults to a constant, so every caller that does not mount agents keeps exactly one draft and
   * behaves as it always has.
   */
  draftKey?: string;
}) {
  const [text, setText] = useState("");
  // Pastes collapsed into pills, in paste order. Local state, unlike `attachments` (host-owned):
  // a collapsed paste never leaves this box — it is expanded inline into the string `submit` sends
  // — so there is nothing for the host to own, and the box already clears it on send.
  const [textBlocks, setTextBlocks] = useState<TextBlock[]>([]);
  /** The pill whose full-text modal is open. */
  const [openBlock, setOpenBlock] = useState<TextBlock | null>(null);
  // What is in the textarea RIGHT NOW, readable from an async continuation. `setText`'s own updater
  // sees the current text, but the pill restore below is a different piece of state and has to make
  // its decision on both halves at once — see the guard in `submit`'s failure path.
  const textRef = useRef(text);
  textRef.current = text;
  // Drafts for the conversations this box is NOT currently showing, keyed by `draftKey`. A ref, not
  // state: stashing a draft must not re-render the box, and the value is only ever read at the moment
  // the key changes.
  const draftsRef = useRef<Map<string, { text: string; blocks: TextBlock[] }>>(new Map());
  const blocksRef = useRef(textBlocks);
  blocksRef.current = textBlocks;
  const draftKeyRef = useRef(draftKey);
  // A LAYOUT effect, so the swap lands in the same frame the mount does. As a plain effect the box
  // paints once with the previous conversation's draft still in it — a visible flash of a message
  // addressed to somebody else, which is the exact confusion keyed drafts exist to prevent.
  useLayoutEffect(() => {
    const previous = draftKeyRef.current;
    if (previous === draftKey) return;
    // Stash what is in the box under the key it was written for, then restore the incoming key's own
    // draft (empty when there isn't one). Blocks travel with the text: a collapsed paste is part of
    // the message being composed, and leaving it behind would send it with the WRONG draft later.
    draftsRef.current.set(previous, { text: textRef.current, blocks: blocksRef.current });
    const restored = draftsRef.current.get(draftKey);
    draftKeyRef.current = draftKey;
    setText(restored?.text ?? "");
    setTextBlocks(restored?.blocks ?? []);
  }, [draftKey]);
  // Concrete hex for the two spec tokens that have no CSS var of their own (see
  // theme/blueprintSpec) — the terminal plane the wired composer floats on, and its edge.
  const mode = useResolvedTheme();
  // The voice state behind the placeholder copy, read from the store rather than taken as a prop.
  // Deliberate: deriveMicPresentation exists so every mic surface renders the SAME state for one
  // store snapshot, and a second path to it through this component's prop contract is exactly how
  // the "sidebar says Actively listening, composer says Mic paused" desync comes back. See
  // voice/useVoicePlaceholder.
  const { micPresentation, modelProgress, errorNotice, pauseReason } = useVoicePlaceholder();
  // WHICH live sentence the placeholder shows, from the TRAY — the same pure function the sidebar
  // caption uses, so the two surfaces cannot name different modes for one position. The presentation
  // above still selects WHICH state is rendered; this only decides the words for the live ones.
  // AN INERT TRAY PROMISES NOTHING. A live PTY owns the keyboard, so `usePushToTalk` has unbound the
  // hold — offering "Hold ⌘ to talk" here would instruct a gesture that does nothing (sparkle-u81cz).
  // It matters now that push-to-talk RESTS released: `deriveMicPresentation` answers "off" on
  // `!enabled` before it consults `pauseReason`, so the terminal case reaches the resting arm rather
  // than the honest focus-paused one it used to. Suppressing here rather than inside RichPlaceholder
  // keeps that component pure — the caller reads state, it renders words.
  const captionKind = trayInert ? "none" : micCaptionKind(sendMode);
  // The overlay stands in for a native placeholder, so it shows on exactly the same terms one
  // would: an empty textarea. Staged attachments render in their OWN row above the textarea (see
  // below), so they never compete for this slot.
  //
  // `!interim` IS LOAD-BEARING, and it is new. The live dictation preview used to have a row of its
  // own too, which is what made "empty textarea" a sufficient test; it is now painted into the
  // mention mirror at the end of the draft — i.e. into THIS slot, on row one, while `text` is still
  // "". Without this gate the invitation to speak would render on top of the words being spoken and
  // the two would interleave into garbled copy. Composer.tsx gates its own rich placeholder on
  // exactly this (`!interimActive`) for exactly this reason.
  //
  // It also stands on its own as copy: "Say Sparkle…" is an invitation, and the one moment it must
  // not be on screen is while the user is already talking.
  const showRichPlaceholder = text === "" && !interim;
  // Focus-on-request seam: any component can call uiStore.requestComposeFocus() (e.g. the
  // drag-vision pill pointing at the one surface that takes input) and this box takes the caret.
  //
  // Only a request made SINCE THIS MOUNT counts (roborev 46485-M). The seq is monotonic for the
  // session, so `seq > 0` also fires on mount — meaning any remount of the concierge column after
  // a single earlier request (HMR, a key change, a future collapse/expand) would yank the caret
  // out of the terminal. In a terminal-first shell that is silent keystroke loss, so the baseline
  // is captured at mount and only a CHANGE past it focuses.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composeFocusSeq = useUiStore((s) => s.composeFocusSeq);
  const handledFocusSeq = useRef(composeFocusSeq);
  useEffect(() => {
    if (composeFocusSeq === handledFocusSeq.current) return;
    handledFocusSeq.current = composeFocusSeq;
    // Quiet, because this effect runs a render after the request: it is the app moving the caret,
    // and the focus event it produces must not be mistaken for the user's.
    //
    // …and GUARDED, because "every caller of requestComposeFocus is a user gesture" is a documented
    // invariant with nothing enforcing it, and it is already stretched: ConciergeHost's
    // capture-window handoff reaches this seam from an inbound EVENT rather than from a gesture in
    // this window. An event-driven pull that lands while the user is mid-message somewhere else is
    // sparkle-d2ec verbatim — the caret leaves the box they are looking at, so their keystrokes go
    // somewhere they cannot see, and with dictation live it repeats every few seconds until the
    // whole app reads as dead to the keyboard. The box defends the caret itself rather than trusting
    // the caller list to stay honest.
    //
    // The veto is UNSENT TEXT elsewhere — never "some other editable element has focus", and never
    // "a terminal has focus" either. Each surface is asked in the only way it can answer: an ordinary
    // editable by its `value`, a terminal by the draft flag its `onData` scanner publishes, since its
    // half-typed command lives in the shell's line buffer and never appears in the DOM. Both looser
    // forms decline nearly every legitimate pull in a terminal-first shell — where the xterm key sink
    // holds the caret whenever the user is not typing into something else — which is the same feature
    // deleted by a different route, and the capture handoff below is the one it hurts most: it stages
    // a draft the caret then never reaches. See focusQuietlyUnlessMidMessage.
    const took = focusQuietlyUnlessMidMessage(textareaRef.current);
    // …but dictation DOES follow, said outright rather than inferred from that focus. Every caller
    // of requestComposeFocus is a user gesture (the drop pill's "go to compose", a file drop,
    // spawning an agent, the capture-window handoff), so reaching this effect at all IS the user
    // asking for this box. Stating it here rather than carrying an intent flag through the focus
    // event is what makes it survive the caret arriving late — or already being here, in which case
    // no focus event fires at all (roborev 54259).
    //
    // ONLY when the caret actually came, though. Claiming the mic for a box we just declined to focus
    // is the mirror of the bug above and every bit as invisible: the user would be typing in the
    // terminal and speaking into the concierge, with nothing on screen saying so.
    if (took) {
      ownVoiceRef.current();
      return;
    }
    // A DECLINE IS A HALF-COMPLETED OPERATION, so it must not be silent. `handledFocusSeq` is already
    // consumed above, so this request will not be retried when the other box empties — and on the
    // capture-window handoff the draft and attachments ARE staged, so the user is looking at a compose
    // box that filled itself but never took the caret, with dictation still aimed elsewhere. Nothing
    // on screen distinguishes that from a handoff that worked. This file's own handoff path logs far
    // less consequential outcomes, so a declined caret earns a line (roborev 59595).
    const active = document.activeElement;
    log.warn("composer", "compose-focus request declined — the user is mid-input elsewhere", {
      activeTag: active?.tagName ?? null,
      // The CLASS, not the content: an editable's text is the user's message and must never reach a
      // log. `logSafePaths` exists for the same reason on the attachment side.
      activeClass: active instanceof Element ? active.className || null : null,
      owner: classifyFocusOwner(active),
    });
  }, [composeFocusSeq]);
  // The live roster, readable from the dictation callback below without re-registering it.
  //
  // Declared HERE and filled where `roster` is built (further down, with the rest of the mention
  // wiring), because this effect depends only on `registerInsert` — see the note inside `append`. The
  // same forward-declare-and-assign shape `ownVoiceRef` uses just below.
  const rosterRef = useRef<readonly MentionAgent[]>(EMPTY_MENTION_AGENTS);
  useEffect(() => {
    if (!registerInsert) return;
    const append = (segment: string, opts?: { verbatim?: boolean }) =>
      setText((prev) => {
        // `verbatim` — a DRAFT COMING BACK, not a dictated segment. `appendDictated` trims what it
        // inserts, which is right for speech (Deepgram pads its segments) and destructive for a
        // restored body: the host hands back the composed message, so a collapsed paste's leading
        // indentation and trailing newline were being stripped on the way IN — before any latch
        // could protect them, which is why re-arming alone would not have helped (roborev 55793).
        // The latch is set too, so the retry does not trim what survived.
        if (opts?.verbatim) {
          heldExpansionRef.current = true;
          const restored = prev ? `${prev}${prev.endsWith("\n") ? "" : "\n"}${segment}` : segment;
          setCaret(restored.length);
          return restored;
        }
        // ── SPEAKING AN ADDRESS ──────────────────────────────────────────────────────────────────
        // You cannot say "@" out loud, so without this there is no spoken way to reach the concierge
        // once this column is patched to a terminal. Saying "Sparkle, …" at the head of a message
        // produces the SAME literal the picker would have inserted — `insertMention`, not a
        // hand-rolled string — so speech and typing leave the box in identical states: one pill, one
        // `ConciergeMention` on the send, one trailing space with the caret after it.
        //
        // The rule is deliberately narrow (head of the message only) and the reasoning, including
        // why the wake and stop phrases cannot collide with it, is in mentions.dictatedSparkleAddress.
        //
        // Resolved against the roster REF, not the captured `roster`: this effect re-runs only when
        // `registerInsert` changes, so closing over the render-time list would go stale the moment
        // the fleet did — and in the one case that matters (a build agent a human also named
        // "Sparkle") the roster's entry is the LABELLED `@Sparkle (the concierge)`, which is the only
        // spelling that still resolves to an aim.
        const addressed = dictatedSparkleAddress(prev, segment);
        const next = addressed
          ? appendDictated(
              insertMention(
                "",
                0,
                0,
                rosterRef.current.find((a) => a.id === SPARKLE_MENTION_ID) ?? SPARKLE_MENTION_AGENT,
              ).text,
              addressed.rest,
            )
          : appendDictated(prev, segment);
        // Follow the text with the caret. A dictated segment (or a draft handed back after a
        // cancelled countdown) lands at the END, and leaving `caret` on the old offset would leave
        // the mention query reading a stale slice of a string that has since grown — which is how a
        // picker pops open over words nobody typed an "@" into. Cheap, and it keeps the one
        // invariant this half depends on: `caret` is where the next character goes.
        setCaret(next.length);
        return next;
      });
    registerInsert(append);
    return () => registerInsert(null);
  }, [registerInsert]);
  /** "I am talking to Sparkle" — name this box the voice surface, so useConciergeDictation claims
   *  the app-wide dictation target for it. The box has no mic of its own to say it with (see the
   *  header above), so putting the caret in it, or typing in it, is the gesture. There is no
   *  registerInsert call to pair with it: the effect above already registered this box's append,
   *  and the hook claims off the arbiter. */
  const ownVoice = useCallback(() => {
    const s = useDictationStore.getState();
    if (s.voiceSurface !== "concierge") s.setVoiceSurface("concierge");
  }, []);
  // Read by the composeFocusSeq effect above, which must not re-run when this identity changes.
  const ownVoiceRef = useRef(ownVoice);
  ownVoiceRef.current = ownVoice;

  // Report what this box STARTS WITH, once, on mount — which for a fresh box is "" (`text` is
  // component state, so a remount resets it).
  //
  // This is the only signal the integration layer gets that distinguishes A NEW BOX from a mere
  // re-registration of the insert callback, and the difference is load-bearing (roborev 53836).
  // ConciergeHost holds latches that aim the NEXT send — the capture window's Chat ❯ routes to
  // Sparkle, bypassing the auto-router — and a latch belongs to the words that set it. When this
  // box remounts, those words are gone but the latch would survive, so the next message the user
  // types gets aimed at a destination they never chose for it. `registerInsert(null)` cannot carry
  // that signal: ComposeBox's effect above re-runs on any identity change of `registerInsert` and
  // its cleanup fires first, so a LIVE re-registration is also a null. A mount is not.
  //
  // Routed through `onTextEdit` rather than a new prop because the host already retires those
  // latches on an empty edit, and this is the same statement of the same fact: the box is empty.
  const reportedInitialText = useRef(false);
  useEffect(() => {
    if (reportedInitialText.current) return;
    reportedInitialText.current = true;
    onTextEdit?.(text);
    // Mount only — `text` is read once for the initial report and must NOT re-run this on edits
    // (the textarea's own onChange already reports those).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── @-mentions: the picker over the box, and the pill it inserts ────────────────────────────
  // Rules and reasoning live in ./mentions (pure, tested as data); this half owns the caret, the
  // keyboard, and where the overlay hangs.
  //
  // THE CARET IS TRACKED IN STATE because the query is "what sits between the nearest `@` and the
  // insertion point", and neither half of that is derivable from `text` alone — the same string
  // means a different query depending on where the caret is. It is refreshed from the DOM on every
  // event that can move it (typing, clicking, arrowing, selecting).
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  // The `@` the user explicitly dismissed with Escape. Recorded by ANCHOR rather than as a bare
  // boolean so it retires itself: typing a NEW `@` produces a different anchor and gets its own
  // picker, which is what "Escape closes this one" should mean. A boolean would suppress every
  // subsequent mention in the message until something thought to clear it.
  const [dismissedAnchor, setDismissedAnchor] = useState<number | null>(null);
  // THE ONE ROSTER, built once and used for everything below — the picker's rows, resolving a send,
  // and Backspace. `mentionRoster` both orders it and gives same-named agents uniquely addressable
  // labels, and doing it HERE rather than trusting the prop is the point (roborev 54555): the
  // ordering contract used to be a comment naming the host as its enforcer, which is not a contract.
  // Nothing in this file may reach for the raw `mentionAgents` prop again.
  const roster = useMemo(
    () => mentionRoster(mentionAgents, preferredAgentId),
    [mentionAgents, preferredAgentId],
  );
  // …and the same list for the dictation callback, which is registered once and must not re-register
  // on every fleet change (see `rosterRef` above).
  rosterRef.current = roster;
  // ══ WHERE THIS DRAFT WOULD GO, RIGHT NOW — and therefore what face to set it in ════════════════
  // THE SAME PURE RULE THE SEND PATH USES (Concierge/composerRoute), not a second reading of the
  // mount. That matters more than it looks: the indicator has to be right about the ESCAPE HATCH,
  // and "am I mounted" cannot answer that. Typing `@Sparkle ` at the head of the box reverts the box
  // to the concierge's face the moment the pill resolves, because the message really has stopped
  // being terminal-bound — and a mid-sentence "Sparkle" does NOT revert it, because that one is the
  // sentence's subject and the message is still going to the terminal. An indicator derived from
  // anything cheaper would lie in exactly the cases the founder needs it for.
  //
  // Resolved against `roster`, so what the box RESOLVED as a mention (and drew as a pill) is what the
  // font reflects — one matcher, one answer, no third notion of what an address looks like.
  const aimedAtTerminal =
    classifyComposerRoute({ text, mentions: mentionsIn(text, roster), mountedAgentId }).kind ===
    "agent";
  const textMetrics = aimedAtTerminal ? COMPOSE_TEXT_METRICS_TERMINAL : COMPOSE_TEXT_METRICS;
  const pending = mentionQuery(text, caret);
  const matches =
    pending &&
    pending.anchor !== dismissedAnchor &&
    // A finished mention closes its own list — without this the picker re-opens over the pill it
    // just inserted, because `@Kraken Auth ` still matches "Kraken Auth" at the top tier. See
    // ./mentions.isCompletedMention for why the trailing space, and not the exact match, is the tell.
    !isCompletedMention(pending.query, roster)
      ? orderMentionAgents(roster, pending.query, preferredAgentId)
      : [];
  const pickerOpen = matches.length > 0;
  // Fresh rows restart the highlight at the top — adjusted DURING RENDER rather than in an effect,
  // the same pattern CommandPalette uses, so there is no frame where the highlight points at a row
  // that has already been filtered out. Keyed on the id LIST, not its length: narrowing from two
  // matches to a different two must still reset.
  // Joined on an ESCAPED NUL, never a raw one: that byte makes git treat the whole file as
  // binary — no diffs, no review — and there is a repo-wide guard for it
  // (services/sourceIsText.test.ts). The runtime string is identical. NUL rather than a space
  // because an agent id is opaque, and a separator that could occur inside one would make two
  // different lists compare equal and silently skip the highlight reset.
  const matchKey = matches.map((a) => a.id).join("\u0000");
  const [lastMatchKey, setLastMatchKey] = useState(matchKey);
  if (matchKey !== lastMatchKey) {
    setLastMatchKey(matchKey);
    setSelected(0);
  }
  const active = matches[Math.min(selected, matches.length - 1)];

  // A caret position we have to WRITE BACK to the textarea after a programmatic edit (choosing from
  // the picker, or deleting a whole pill). React controls `value`, and setting it puts the caret at
  // the end of the new string — which for a mention chosen mid-sentence is several words past where
  // the user was. Applied in a layout effect so it lands before paint and the caret never visibly
  // jumps to the end and back.
  const restoreCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = restoreCaret.current;
    if (at === null) return;
    restoreCaret.current = null;
    const ta = textareaRef.current;
    if (!ta) return;
    ta.setSelectionRange(at, at);
    // Keep the caret in the box after a POINTER pick: the picker chooses on mousedown with the
    // default prevented (see MentionPicker), so focus was never taken — but a box that was not
    // focused to begin with (the user clicked the picker straight after a dictated segment landed)
    // still needs it, or the words they type next go nowhere.
    //
    // DELIBERATELY UNGUARDED, unlike the composeFocusSeq seam above. This looks like the same shape and
    // is the opposite kind of event: `applyEdit` runs from a mention pick or a pill deletion, i.e. an
    // explicit user gesture on THIS box, and MentionPicker chooses on mousedown with the default
    // prevented precisely so focus is never taken — which means `activeElement` is still whatever the
    // user last focused. Vetoing on that would break the exact case this call was added for ("a box
    // that was not focused to begin with … still needs it, or the words they type next go nowhere"):
    // the pick would silently not restore the caret whenever some other field held text. A
    // background-pull guard applied to a foreground gesture is a category error (roborev 59595).
    //
    // What actually bounds this effect is the `restoreCaret.current === null` early-return above — it
    // has no dependency array and so runs after every render, but it does nothing unless `applyEdit`
    // just armed it. That gate is the invariant, so it is pinned by a test rather than defended by a
    // predicate that would cost a real behaviour to guard a hypothetical one.
    if (document.activeElement !== ta) focusQuietly(ta);
  });

  /** Apply an edit that moves the caret, and report it as the hand edit it is. */
  const applyEdit = useCallback(
    (next: { text: string; caret: number }) => {
      setText(next.text);
      setCaret(next.caret);
      restoreCaret.current = next.caret;
      // A mention insert and a pill deletion are both the USER editing the box, so they report like
      // typing does — deleting the last pill can empty the box, and the host retires its
      // capture-Chat aim on exactly that signal.
      onTextEdit?.(next.text);
    },
    [onTextEdit],
  );

  const chooseMention = useCallback(
    (agent: MentionAgent) => {
      if (!pending || !agent.canAcceptInput) return;
      applyEdit(insertMention(text, pending.anchor, caret, agent));
      // NOT dismissed — the inserted literal ends in a space, so `mentionQuery` no longer sees an
      // open query and the picker closes on its own. Marking it dismissed would additionally
      // suppress a fresh `@` typed at the same offset later in the session.
      setSelected(0);
    },
    [pending, applyEdit, text, caret],
  );

  // ── A long paste collapses into a pill instead of flooding the box ───────────────────────────
  // Threshold and model are the shared ones (composer/attachments). A paste UNDER it is not
  // intercepted at all — no preventDefault — so the textarea's own insert handles it, caret and
  // undo stack included.
  const onPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = e.clipboardData.getData("text/plain");
    if (!shouldPasteAsPill(pasted)) return; // native paste
    e.preventDefault();
    setTextBlocks((prev) => [...prev, collapseText(nextId("blk"), pasted)]);
  };

  const removeTextBlock = (id: string) => {
    setTextBlocks((prev) => prev.filter((b) => b.id !== id));
    setOpenBlock((cur) => (cur?.id === id ? null : cur));
  };

  /** "Show as regular text": the block's full text goes back into the textarea and the pill goes.
   *
   *  Through `applyEdit`, not a bare `setText`, because this IS a user edit — the host retires its
   *  routing latches on `onTextEdit` (see that prop's doc), and an expand that bypassed it would
   *  leave the next send aimed at a destination the user never chose for these words. It also
   *  carries the caret to the end of the restored text, so typing continues after the paste rather
   *  than in front of it. */
  const showBlockAsText = (block: TextBlock) => {
    // The SHARED expand rule — the round-trip guarantee (expand → send is byte-identical to the
    // paste) is stated over that one function, not over this call site.
    const next = expandTextBlock(text, block);
    // …and the guarantee needs this latch to survive the trip out. See heldExpansionRef.
    heldExpansionRef.current = true;
    applyEdit({ text: next, caret: next.length });
    removeTextBlock(block.id);
  };

  /**
   * Has this box held an expanded pill since it was last emptied?
   *
   * The same latch the build-agent composer keeps, for the same reason and against the same bug:
   * expanding a pill moves its bytes out of a block and into `text`, where `composeBody`'s
   * `typed.trim()` strips a pasted diff's leading indentation and its trailing newline (roborev
   * 55720/55728). A latch rather than a comparison against the expanded string, because EDITING IS
   * WHY somebody takes "Show as regular text" — and `trim()` cuts the LEADING end too, where the
   * bytes belong to the paste and not to the user's stray whitespace.
   *
   * Cleared when the box is emptied, by a send or by hand.
   */
  const heldExpansionRef = useRef(false);

  // ── Height: auto-grow to a ten-line cap, or whatever the user dragged to ────────────────────
  // The box was a fixed 42px with `resize: none`, so a paragraph scrolled invisibly above the
  // caret. Policy (cap, floor, drag arithmetic) lives in engine/composeBoxHeight; this half just
  // measures and listens.
  const userH = useUiStore((s) => s.conciergeComposeH);
  const setUserH = useUiStore((s) => s.setConciergeComposeH);
  const [contentH, setContentH] = useState<number | null>(null);
  // The placeholder overlay's natural height — the other thing this box displays, and invisible to
  // the textarea's own scrollHeight. See the layout effect below.
  const slotRef = useRef<HTMLDivElement>(null);
  const [placeholderH, setPlaceholderH] = useState<number | null>(null);
  /** The live dictation preview's natural height — the other thing this box displays that the
   *  textarea's own scrollHeight cannot see, and for the opposite reason to the placeholder's: the
   *  words are painted BEHIND the textarea rather than over it, and are not in its value. See the
   *  layout effect, and `composeInterimExtraH` for why it is an INCREMENT applied in both height branches, never a value
   *  compared against them. */
  const [interimH, setInterimH] = useState<number | null>(null);
  // The space this box's TEXTAREA and the THREAD share — not the window, and not the box's whole
  // root either. Two distinct traps, both of which clip the Send row off the bottom (roborev
  // 53572 / 53586):
  //
  //   1. The column carries a fixed header (wordmark, spend pill, scope vitals) and a suggestions
  //      slot that cannot compress, so sizing against `window.innerHeight` over-allocates by all of
  //      it and the thread collapses to zero.
  //   2. The ceiling is applied to the TEXTAREA, but the root also holds the attach row, the chips
  //      and the drag handle — tens of px the textarea never sees. Measuring the pool in root units
  //      and spending it in textarea units silently hands the thread that much less than
  //      COMPOSE_MIN_THREAD_H promises. So the box's own chrome comes off the pool.
  //
  //      That list used to include "the interim dictation line", and putting a figure on it (~60px)
  //      is why this note needs correcting rather than trimming: the dictation line is GONE — the
  //      live transcript is painted inside the textarea's own text layer now (see MentionMirror) —
  //      so the chrome is a row shorter and its height is no longer a constant anyone can quote.
  //      Nothing in the code depended on the number: `chrome` is MEASURED below as root height minus
  //      textarea height, which is the whole point of measuring it.
  //
  // And because the dragged height is persisted, either mistake survives a relaunch.
  const rootRef = useRef<HTMLDivElement>(null);
  // ── HOW WIDE THE COLUMN IS — MEASURED OUTSIDE THE COMPOSER, NOT INSIDE IT ────────────────────
  //
  // Measured at all because this box lives in the concierge COLUMN, which the user resizes down to
  // 50px and which can be torn out into its own window — window width is not its width.
  //
  // THE PARENT, NOT THE TOOLBAR, and that is a correctness point rather than a preference. An
  // earlier version observed the toolbar row and derived BOTH the label density AND the composer's
  // own inset collapse from it — but the toolbar sits INSIDE those insets, so the measurement that
  // chose the margin was changed BY the margin. It does not settle: with a 300px threshold and
  // 10px/2px insets, any column width in [304, 320) satisfies both "collapse" and "expand", so the
  // observer re-fires forever on a band the user can land on by dragging. Observing the parent
  // removes the loop by construction; hysteresis was rejected because it makes the threshold depend
  // on which direction you dragged from, so one width renders two ways.
  //
  // 0 means "not measured yet" and the rules read that as the roomy form; the observer is created
  // lazily so an observer-less test env stays at 0 rather than throwing.
  const [columnWidth, setColumnWidth] = useState(0);
  useEffect(() => {
    const el = rootRef.current?.parentElement;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === "number" && w > 0) setColumnWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  /** Below the attach threshold the whole composer tightens, not just the labels — see `margin`. */
  const narrowColumn = !toolbarShowsLabels(columnWidth);

  // The thread node currently under observation. Tracked so `measure` re-observes only when the
  // node IDENTITY changes (ConciergeThread remounting), never on every callback.
  const observedThread = useRef<HTMLElement | null>(null);
  const [availableH, setAvailableH] = useState(() =>
    typeof window === "undefined" ? 800 : window.innerHeight,
  );
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    // WHICHEVER THREAD IS ON SCREEN. The column swaps `ConciergeThread` for `MountedAgentThread`
    // when the concierge is mounted to a build agent, so a query for one component's testid found
    // nothing for the whole mounted session and `measure()` fell back to `window.innerHeight` —
    // trap #1 below, which clips the Send row. Both scrollers carry `data-concierge-scroller`, so
    // this asks for "the thread" and stays agnostic about which one answers.
    const findThread = () =>
      root
        .closest("section")
        ?.querySelector<HTMLElement>(
          `[data-concierge-scroller="yes"], [data-testid="${CONCIERGE_THREAD_TESTID}"]`,
        ) ?? null;

    const ro = new ResizeObserver(() => measure());
    const measure = () => {
      const ta = textareaRef.current;
      const thread = findThread();
      // Keep the observation pointed at the LIVE thread node. Done here rather than inside the
      // callback's measurement path so a remount is picked up even when the early return below
      // fires, and guarded on identity because re-`observe`ing an already-observed target is
      // specified to reset its last-reported size to (0,0) — which marks it active again and
      // re-queues the callback. Blink and WebKit happen to early-return instead, but relying on
      // that would be resting correctness on engine behaviour rather than the spec (roborev 53599).
      if (thread !== observedThread.current) {
        if (observedThread.current) ro.unobserve(observedThread.current);
        if (thread) ro.observe(thread);
        observedThread.current = thread;
      }
      if (!thread || !ta) {
        setAvailableH(window.innerHeight);
        return;
      }
      // Everything in the root that is NOT the textarea, so the pool is in the same unit the
      // ceiling is spent in.
      const chrome = Math.max(0, root.offsetHeight - ta.offsetHeight);
      const pool = thread.clientHeight + root.offsetHeight - chrome;
      setAvailableH(pool > 0 ? pool : window.innerHeight);
    };

    // The THREAD is the half of the pool that moves when anything else in the column appears: it is
    // `flex: 1`, so a suggestions row or search slot mounting shrinks it. Neither the root (height
    // driven by React state) nor the section (window-sized) resizes when that happens, so without
    // observing the thread the ceiling would sit stale and too large with no event to correct it.
    ro.observe(root);
    measure();
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      observedThread.current = null;
      window.removeEventListener("resize", measure);
    };
  }, []);

  // Measure BEFORE paint (useLayoutEffect), so the box never renders one frame at the old height
  // and jumps. Collapsing to `auto` first is what makes scrollHeight report the content's natural
  // height rather than the height we last set — without it the box can only ever grow.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const prev = ta.style.height;
    const prevPad = ta.style.paddingBottom;
    ta.style.height = "auto";
    // …AND THE DICTATION SPACER OFF. `scrollHeight` counts padding, and while a phrase is
    // provisional this textarea carries `interimH` extra pixels of it (see `dictationPadBottom`), so
    // measuring through the spacer would read the spacer back as content.
    //
    // THIS LINE IS WHAT STOPS AN INFINITE LOOP, not merely a drifting measurement, and it became
    // that the moment `interimH` joined this effect's deps. Without the reset: pass 1 measures
    // `contentH`, derives `interimExtra = mirrorH - contentH = E`, and applies `paddingBottom`
    // 10 + E; pass 2 measures `contentH + E`, derives `0`, and drops the padding; pass 3 measures
    // `contentH` again and derives `E`. Every pass is a real state change from a useLayoutEffect, so
    // React raises "Maximum update depth exceeded" and takes the concierge tree down on the FIRST
    // Deepgram partial. With the reset, `next` is padding-independent, so pass 2 measures what pass 1
    // did, `setInterimH` bails on identity, and it settles in two passes.
    ta.style.paddingBottom = `${COMPOSE_TEXT_PAD_BOTTOM}px`;
    const next = ta.scrollHeight;
    ta.style.height = prev;
    ta.style.paddingBottom = prevPad;
    setContentH((cur) => (cur === next ? cur : next));

    // THE PROVISIONAL LINES GET MEASURED TOO — and this is where the box learns about them.
    //
    // `ta.scrollHeight` is taken off the textarea's VALUE, which the live transcript is deliberately
    // not in, so on the measurement above a dictated sentence is worth exactly zero pixels. That was
    // harmless while the preview had a strip of its own; now that it is painted INSIDE the box, at
    // inset 0 behind the textarea with `overflow: hidden`, "worth zero pixels" means the second and
    // every later line of what the user is saying is CLIPPED — invisible, in the one place the whole
    // feature exists to show it (roborev 57324, High). The empty-box case is the common one: there
    // the box would sit at its one-line resting height while a whole spoken sentence streams into it.
    //
    // It goes to `interimH`, its OWN input to the height, and not into `contentH` — which is where
    // it was first put, and that was wrong twice over (roborev 57333):
    //
    //   • `contentH` is ignored outright by a box at a persisted DRAG height, so folding it in there
    //     fixed auto-grow and left anyone who had once dragged the box short with the preview
    //     clipped exactly as before. Typed text a short box hides is still reachable by scrolling or
    //     by the caret; provisional speech is in neither the value nor the scroll, so a box too
    //     short for it doesn't hide those words, it erases them. It is a FLOOR in both branches.
    //   • It is likewise not a PLACEHOLDER floor — `composePlaceholderFloorH` adds the textarea's
    //     whole chrome (22px) to what it is handed, right for an overlay standing in for empty space
    //     and wrong for a layer that already carries the same padding and needs only the borders.
    //     That is what MENTION_MIRROR_SKIP_ATTR still buys: measuring the mirror in the walk below
    //     would grow the box by a spare line for every draft with any text in it.
    //
    // The other half of "the words must not move": the box that fits the phrase while it is italic
    // is the box that fits it once it commits — same string, same metrics, same wrap points — so the
    // settle changes the ink and nothing else. Measured only while `interim` is non-empty, so a
    // typed draft never pays for it.
    const mirrorEl = interim
      ? (slotRef.current?.querySelector<HTMLElement>(`[${MENTION_MIRROR_SKIP_ATTR}]`) ?? null)
      : null;
    let mirrorH = 0;
    if (mirrorEl) {
      // Same collapse-then-measure trick as the textarea and the overlays: the mirror is stretched
      // to the box by `inset: 0`, so measuring it in place would only ever report the height we
      // already set and the box could never come back down.
      //
      // AND PUT THE SCROLL BACK, in this same synchronous pass. Releasing `bottom` makes the layer
      // auto-height, which leaves it with nothing to scroll, so the reflow that `scrollHeight`
      // forces clamps its scrollTop to 0 — and restoring `bottom` re-creates the overflow without
      // restoring the offset. The mirror's own scroll sync is a passive effect, i.e. after paint, so
      // in a draft past the ten-line cap every Deepgram partial would paint one frame with the pill
      // fills snapped to the top of the box while the textarea stayed where it was: precisely the
      // misalignment MIRRORED_PILL exists to prevent (roborev 55574), several times a second while
      // someone speaks (roborev 57333).
      const prevBottom = mirrorEl.style.bottom;
      const prevTop = mirrorEl.scrollTop;
      const prevLeft = mirrorEl.scrollLeft;
      mirrorEl.style.bottom = "auto";
      mirrorH = mirrorEl.scrollHeight;
      mirrorEl.style.bottom = prevBottom;
      mirrorEl.scrollTop = prevTop;
      mirrorEl.scrollLeft = prevLeft;
    }
    // THE INCREMENT, not the mirror's total (roborev 57354). The mirror paints the whole draft plus
    // the provisional suffix, so its raw height is the draft's height as well — and handing that to
    // the dragged branch let the TYPED DRAFT outrank the drag for as long as anyone was speaking: a
    // two-line box holding a fifteen-line draft jumped to the cap on the first partial and snapped
    // back on every settle, several times an utterance. Only the pixels the interim adds PAST the
    // textarea's own content are unreachable, and only those are what a drag has to yield to.
    //
    // `next` is the textarea's own collapsed scrollHeight, measured a few lines above in the same
    // pass, so the two are like for like: same metrics, same wrap points, both padding-inclusive.
    const interimExtra = mirrorH > 0 ? Math.max(0, mirrorH - next) : 0;
    setInterimH((cur) => (cur === interimExtra ? cur : interimExtra));

    // MAKE THE EXTRA PIXELS REACHABLE, not merely allocated (roborev 57397).
    //
    // Growing the box is enough only while the textarea does not overflow. When it does — a draft
    // longer than a box the user dragged SHORT — the mirror copies `ta.scrollTop`, and the textarea's
    // own maximum is `contentH - clientH` while the mirror needs `mirrorH - clientH` to bring its
    // tail into view. Since `mirrorH = contentH + speaking`, no amount of extra height closes that
    // gap: every pixel the box grows clamps `ta.scrollTop` down by the same pixel, the window slides
    // up over the draft, and the live phrase stays below it. The words were allocated room and still
    // could not be seen — the pre-branch strip always showed them, so that is a regression.
    //
    // The spacer closes it at the source: `dictationPadBottom` gives the textarea exactly `speaking`
    // extra pixels of bottom padding while a phrase is provisional, so its scroll range becomes the
    // mirror's and the existing `mirror.scrollTop = ta.scrollTop` copy lines the two up EXACTLY.
    // Bottom padding moves no glyph and changes no wrap point, so every pill fill stays on its own
    // words — which is why this and not desynchronising the mirror (roborev 55574).
    //
    // Then pin to the bottom, because nothing else will: the caret is not in the provisional text and
    // the user is speaking, not scrolling. Only while dictating; the moment the phrase settles the
    // spacer goes and the box is the user's again.
    if (interim) ta.scrollTop = ta.scrollHeight;

    // The same measurement for the RICH PLACEHOLDER, which the scrollHeight above cannot see: the
    // overlay is a SIBLING of the textarea, not its content, so an empty box measures one line
    // while the copy painted over it runs three. Auto-grow alone would therefore reproduce exactly
    // the clipping this branch replaced `placeholder=""` to fix — and worst for the voice-error
    // notice, the tallest copy in the slot and the only one carrying controls (Dismiss / Open
    // System Settings) that must not be clipped out of reach.
    //
    // Every PLACEHOLDER overlay in the slot is measured, and the taller of them wins (at most one
    // failure overlay and the decorative one are up at once). Releasing `bottom` first is the same
    // collapse-then-measure trick as above and is load-bearing for the same reason: scrollHeight can
    // never report LESS than the box we already sized, so measuring it in place would ratchet the
    // floor up and never let it back down.
    //
    // NOT EVERY NON-TEXTAREA CHILD IS A PLACEHOLDER ANY MORE. This used to say "no marker attribute
    // is needed", which was true while placeholders were the only overlays here. The MENTION MIRROR
    // (./MentionMirror) is now a sibling too, and it is the opposite kind of thing: it mirrors the
    // CONTENT, so its natural height tracks the text rather than standing in for empty space. Feeding
    // it in as a floor would add the textarea's chrome on top of a height that already includes the
    // padding — growing the box by about a line for any draft with text in it, and overriding a
    // persisted drag height while doing so. It opts out by attribute; nothing else does.
    const slot = slotRef.current;
    let overlayH = 0;
    if (slot) {
      for (const el of Array.from(slot.children)) {
        if (el === ta || !(el instanceof HTMLElement)) continue;
        if (el.hasAttribute(MENTION_MIRROR_SKIP_ATTR)) continue;
        const prevBottom = el.style.bottom;
        el.style.bottom = "auto";
        overlayH = Math.max(overlayH, el.scrollHeight);
        el.style.bottom = prevBottom;
      }
    }
    setPlaceholderH((cur) => (cur === overlayH ? cur : overlayH));
    // `interim` IS a dependency — of the MIRROR measurement above, never of this floor: the mirror
    // is skipped by the walk and always will be. Every Deepgram partial re-runs this effect, which
    // is the price of the box fitting the words as they arrive, exactly as typing them would.
  }, [
    text,
    interim,
    // The SPACER's own size. It is written by this effect and applied on the next render, so without
    // re-running here the pin above would scroll against the range the box had one phrase ago and
    // stop short of the newest words. Settles in two passes: the second finds the same measurement
    // and both setState calls bail on identity.
    interimH,
    showRichPlaceholder,
    micPresentation,
    errorNotice,
    modelProgress,
    captionKind,
  ]);

  /**
   * THE DICTATION SPACER — the textarea's bottom padding while a phrase is provisional.
   *
   * A real binding rather than an expression inlined in the style, because three comments point a
   * reader here and a name that does not resolve is the dangling-reference defect this branch has
   * already been reviewed for twice.
   *
   * The mirror behind the textarea paints `interimH` more pixels than the textarea's own value does,
   * and the mirror follows the TEXTAREA's scroll — so without matching room down here the tail of the
   * preview sits below anything `ta.scrollTop` can reach, however tall the box grows. Padding rather
   * than content: it moves no glyph and changes no wrap point, so every pill fill stays on its own
   * words (roborev 55574). The layout effect resets this to `COMPOSE_TEXT_PAD_BOTTOM` before it
   * measures — see there for why that reset is load-bearing.
   */
  const dictationPadBottom = COMPOSE_TEXT_PAD_BOTTOM + (interim ? (interimH ?? 0) : 0);

  const height = composeRenderH({
    contentH,
    userH: userH ?? null,
    availableH,
    placeholderH,
    interimH,
  });

  // Drag the top edge. Pointer capture keeps the gesture alive when the cursor leaves the 6px
  // handle — without it a fast drag drops on the first frame that outruns the element.
  const dragFrom = useRef<{ y: number; h: number } | null>(null);
  const onHandleDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragFrom.current = { y: e.clientY, h: height };
      // Optional, not assumed: the Pointer Capture API is absent in jsdom and can throw on an
      // already-released id. The drag works without it (we just lose the leaves-the-element
      // guarantee), so a missing implementation must not take the whole gesture down with it.
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId);
      } catch {
        /* capture is a nicety; the pointer handlers below carry the drag regardless */
      }
    },
    [height],
  );
  const onHandleMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const from = dragFrom.current;
      if (!from) return;
      const next = composeDragH(from.h, e.clientY - from.y, availableH);
      // Dragging back down to the resting height hands the box back to auto-grow, so one stray
      // drag can't freeze it for the session with no obvious undo.
      setUserH(composeDragReleasesManual(next) ? null : next);
    },
    [availableH, setUserH],
  );
  const onHandleUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    dragFrom.current = null;
    try {
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }
    } catch {
      /* see onHandleDown — capture is optional */
    }
  }, []);

  // Clear optimistically (the send almost always lands), but PUT THE DRAFT BACK if the host reports
  // a failure — the removed composer did exactly this, and having to retype a paragraph because an
  // agent's terminal had closed is the worst possible outcome of a failed send. Only restored when
  // the box is still empty, so it can never clobber something the user started typing meanwhile.
  // An attachment alone IS a message — the removed composer allowed attachments-only sends — so the
  // gate is "text or attachments", not "text".
  // A COLLAPSED PASTE COUNTS, for the same reason an attachment does: a box holding one pill and no
  // typing is a message with a long body, and gating on the visible textarea alone would leave Send
  // dead with the user's whole paste sitting right there on screen.
  const canSend = text.trim().length > 0 || attachments.length > 0 || textBlocks.length > 0;
  // RETURNS WHETHER A MESSAGE WENT OUT, for the auto-send rail (see `registerSubmit`). The button
  // ignores it; the rail cannot, because "I called submit" and "a message was sent" differ exactly
  // here — an empty box early-returns, and the rail would otherwise announce "Sent to …" and record
  // a tuning sample for a send that never happened.
  const submit = (): boolean => {
    if (!canSend) return false;
    // WHAT GOES OUT IS EVERY PILL'S FULL TEXT PLUS WHAT WAS TYPED — never a pill's label. Through
    // the shared `composeBody`, which is where collapsing is proven lossless: a lone block in an
    // otherwise empty box comes out of it byte-identical to what was pasted in.
    const held = heldExpansionRef.current;
    // What goes back in the box if the send fails. The TRIMMED text ordinarily — but the untouched
    // string when this box is holding an expansion, because there the outer whitespace is the
    // paste's own and handing back a trimmed copy would quietly dedent the user's draft.
    const typed = held ? text : text.trim();
    const blocks = textBlocks;
    // `verbatimTyped` — this box has held an expanded pill, so its text keeps its own bytes rather
    // than being trimmed. See heldExpansionRef.
    const v = composeBody(blocks, text, { verbatimTyped: held });
    // Resolved HERE, at submit, off what the user can READ IN THE BOX — never carried along in
    // state. That is the whole point of deriving mentions (see ./mentions): what is visible at the
    // moment they press Send is what the message is addressed to, with no second copy that could
    // have drifted from it.
    //
    // THE VISIBLE TEXT, NOT THE COMPOSED BODY, and the difference is a collapsed paste (roborev
    // 55730). Scanning `v` would resolve an aim out of text the user cannot see: paste a Slack
    // thread or a log that happens to contain "@Docs" while an agent is addressable as Docs, and the
    // send silently aims at that agent's terminal instead of being routed. It also breaks the
    // guarantee this feature exists for — the host renders the wire text through `mentionFreeText`,
    // which REWRITES every span it resolves (deleting a leading address outright, and taking the
    // sigil off the rest), so a mention found inside a pill would have the paste itself altered on
    // its way out. A pill's contents are content,
    // never an envelope. For a box with no pills this is exactly what it always was.
    //
    // `text`, not `typed`: the two differ only in edge whitespace (see `typed` above), which cannot
    // change which spans match — and naming the raw visible string here says what the rule IS.
    const mentions = mentionsIn(text, roster);
    // ══ THE PILLS, FOR THE BUBBLE ONLY ═════════════════════════════════════════════════════════
    // The transcript draws the same pills this box drew, instead of the wall of text they were
    // collapsed to keep out of the box — the founder's ask, and the parity this feature is.
    //
    // A THIRD ARGUMENT RATHER THAN SOMETHING THE HOST RE-DERIVES, and the reason is not
    // convenience: the composed body is NOT decomposable. `composeBody` joins with a blank line, so
    // a blank-line split reads like its inverse — and a pasted diff or stack trace has blank lines
    // of its own, so that split shreds one block into fragments that are each under the collapse
    // threshold. This box is the only thing that knows where a block starts and ends.
    //
    // `typed`, not `text`: the trimmed-or-verbatim copy, which is what the bubble should show for
    // the same reason it is what a failed send restores.
    //
    // PASSED ONLY WHEN A PILL WAS STAGED. Below it, the call is exactly what it has always been:
    // ONE argument when nothing is addressed, not a second one holding `undefined`. An unaddressed
    // send has to be indistinguishable from what this box has always sent — the host's `onSend` is
    // the column's oldest contract and every consumer and test of it was written against the
    // single-argument call. Passing an explicit `undefined` is a different call, and arity is
    // observable (a spy asserted with `toHaveBeenCalledWith(text)` sees it and fails).
    const collapsed: CollapsedSend | undefined = blocks.length ? { blocks, typed } : undefined;
    const outcome = collapsed
      ? onSend(v, mentions.length ? mentions : undefined, collapsed)
      : mentions.length
        ? onSend(v, mentions)
        : onSend(v);
    setText("");
    setCaret(0);
    setDismissedAnchor(null);
    setTextBlocks([]);
    setOpenBlock(null);
    // Emptied, so it no longer holds anybody's paste. Cleared AFTER `v` was built off it; the
    // restore path below re-arms it, because putting the expansion back means the box is holding it
    // again.
    heldExpansionRef.current = false;
    if (outcome && typeof outcome.then === "function") {
      void outcome.then((ok) => {
        if (ok) return;
        // Restored SEPARATELY, as the two halves the user actually sees: the typed words go back
        // into the textarea and the pills go back to being pills. Putting `v` back into the
        // textarea instead would "restore" a failed send by flooding the box with the very paste
        // that was collapsed to keep it out — the draft would come back in a shape the user never
        // had. Each half is MERGED with whatever arrived meanwhile rather than dropped: the send is
        // in flight for as long as the host takes to decide, and a user who typed or pasted in that
        // window must not lose either their new words or the draft coming back (roborev 55758).
        //
        // Keeping both is the only option that never destroys text. Bailing out when the box is
        // non-empty silently discarded the returning draft; overwriting would discard the new words.
        // RE-ARM WHENEVER THIS SEND WAS VERBATIM, independent of what is in the box (roborev 55776).
        // An earlier draft restricted this to `cur === ""` on the reasoning that a draft merged with
        // new keystrokes is "no longer pristine" — which contradicts the latch's own semantics, set
        // out at `heldExpansionRef`: it is deliberately NOT a pristine test, because editing is
        // exactly why anyone expands a pill, and `trim()` cuts the LEADING end where the bytes
        // belong to the paste. The restore PREPENDS, so the string still begins with the paste's own
        // bytes either way; leaving the latch off re-opened the dedent on the retry.
        if (held) heldExpansionRef.current = true;
        // Has the host already put this draft back? `ConciergeHost.restoreDraft` appends the
        // composed BODY through `registerInsert` on paths this promise cannot see (a cancelled
        // countdown, a dead agent), so both halves below have to ask that question — but they must
        // ask it about the same EVIDENCE, not each with its own test.
        const pasteIsBack = blocks.some((b) => {
          const needle = b.text.trim();
          return needle !== "" && textRef.current.includes(needle);
        });
        // …and the typed half gets a duplicate guard too (roborev 55776) — but NOT a bare
        // `includes` of the typed text (roborev 55793). The block half's licence is that its needle
        // is a multi-line paste over the collapse threshold, so "text the user typed in a few
        // seconds cannot contain it". A TYPED needle can be two characters: with a pill staged and
        // "hi" typed, a user who then starts a new thought ("this is urgent") would have `hi`
        // silently deleted by `includes`, which is the exact loss this design exists to prevent.
        //
        // So: evidence of a HOST RESTORE, not bare containment. When there are blocks, the paste
        // being back is that evidence — the body carries both halves or neither. With no blocks the
        // restored body IS the typed text, so it can only be back at the END.
        if (typed) {
          const needle = typed.trim();
          const typedAlreadyBack =
            needle !== "" &&
            (blocks.length ? pasteIsBack : textRef.current.trim().endsWith(needle));
          if (!typedAlreadyBack) setText((cur) => (cur === "" ? typed : `${typed}\n\n${cur}`));
        }
        // THE PILLS COME BACK UNLESS THE PASTE IS ALREADY IN THE BOX (roborev 55730 / 55748).
        //
        // `cur.length === 0` alone guards nothing — we cleared it ourselves a moment ago. The case
        // to catch is the host putting the draft back FIRST: ConciergeHost.restoreDraft appends
        // through `registerInsert` on paths this promise cannot see (a cancelled countdown, a dead
        // agent), and it is handed the composed BODY, paste included. Re-adding the pill on top of
        // that leaves the paste in the draft twice and sends it twice.
        //
        // But the test cannot be "is the textarea empty". A keystroke while the send was in flight
        // would then destroy the whole collapsed paste — pill gone, block state already cleared,
        // and the typed half of this restore skipped as well — which is a far worse outcome than
        // the duplication being avoided. So it discriminates on the actual hazard: does the box
        // already CONTAIN this paste? Text the user typed in a few seconds cannot; a restored body
        // must. Compared on the trimmed text because the append path trims what it inserts
        // (appendDictated), so a block ending in a newline would not match verbatim.
        // MERGED, NOT BAILED (roborev 55758). A `cur.length === 0` test would discard the sent
        // paste outright whenever a NEW pill exists — and `onPaste` has no notion of a send being
        // in flight, so pasting a second chunk while the host is still deciding is exactly how that
        // happens. Losing the first paste that way is the same silent loss as the keystroke case,
        // arriving through the paste handler instead. Restored blocks go FIRST, keeping paste order,
        // and a block already in the list is not duplicated.
        if (blocks.length) {
          setTextBlocks((cur) => {
            if (pasteIsBack) return cur;
            const fresh = cur.filter((c) => !blocks.some((b) => b.id === c.id));
            return [...blocks, ...fresh];
          });
        }
      });
    }
    // TRUE means the message left this box, not that it arrived. A send that fails asynchronously
    // restores the draft above, and no synchronous return can know that yet — see the caller's doc
    // for why the rail treats the dispatch, not the delivery, as the thing it announces.
    return true;
  };

  // ══ THE AUTO-SEND SEAM ═══════════════════════════════════════════════════════════════════════
  // Two callbacks, both optional, both inert unless the host wires the rail up.

  // Report the contents on EVERY change — typed, dictated, cleared, or restored after a failed
  // send. This is the rail's ONLY view of what it would be sending, and dictated text is the case
  // it exists for, which is why this cannot be `onTextEdit` (see that prop's doc).
  useEffect(() => {
    onComposedText?.(text);
  }, [text, onComposedText]);

  // Hand the host something stable that always runs the CURRENT submit.
  //
  // `submit` closes over `text` and is rebuilt every render, so registering it directly would
  // either re-register on every keystroke or — worse — leave the host holding a closure over an
  // empty box and firing sends that do nothing.
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    if (!registerSubmit) return;
    registerSubmit(() => submitRef.current());
    return () => registerSubmit(null);
  }, [registerSubmit]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // ── The picker owns these keys while it is open ────────────────────────────────────────────
    // Ahead of the ⌘↩ submit check on purpose: none of them collide with it (the picker never
    // claims a modified Enter, so ⌘↩ still sends even mid-mention), but the reader should see the
    // narrower, conditional claim first.
    if (pickerOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      // Bare Enter takes the highlighted row — the founder's "if I press enter it shows me the
      // agent as a pill". A MODIFIED Enter is still Send: someone who has typed a whole message and
      // hits ⌘↩ with a half-finished `@Bl` at the end meant to send, not to pick.
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        if (active) chooseMention(active);
        return;
      }
      if (e.key === "Escape" && pending) {
        // Stop here: Escape inside the compose box otherwise reaches the surfaces around it (the
        // attach group does the same), and closing this list is the whole of what was asked for.
        e.preventDefault();
        e.stopPropagation();
        setDismissedAnchor(pending.anchor);
        return;
      }
    }
    // ── Backspace at a pill's trailing edge removes the WHOLE pill ─────────────────────────────
    // Only for a COLLAPSED caret: with a selection, Backspace means "delete what I highlighted",
    // and quietly widening that to a neighbouring mention would destroy text the user did not
    // select. See ./mentions.backspaceMention for why half a name is the failure to avoid.
    if (e.key === "Backspace" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const ta = e.currentTarget;
      if (ta.selectionStart === ta.selectionEnd) {
        const edit = backspaceMention(text, ta.selectionStart, roster);
        if (edit) {
          e.preventDefault();
          applyEdit(edit);
          return;
        }
      }
    }
    // THE SEND CHORD IS DECIDED BY voice/sendMode, not spelled out here. The tray PAINTS a keycap
    // chip from `chicletFor` and this line HANDLES the keystroke, and they are two different files —
    // a chip advertising a chord the handler does not honour is the exact defect this control was
    // built to fix, so both sides ask the same function.
    //
    // The mode is load-bearing rather than decorative: in Push to talk `⌘` means TALK, so `⌘↩` must
    // NOT also send. It used to, and the two paths then stacked — the composer submitted on the
    // keydown and the hold's own release fired a second send an instant later.
    if (chordSends(sendMode, sendChord, e)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      ref={rootRef}
      data-testid="concierge-compose"
      data-wired={wired ? "yes" : "no"}
      style={{
        flex: "none",
        // ── `.cmp` — A BOX ON `--k-input`, NOT A SCRIM ─────────────────────────────────────────
        // This was a full-bleed strip with a top rule, filled with COMPOSE_SCRIM: a 16% BLACK wash
        // over the concierge column. That scrim dropped `conciergeMuted` to 4.23 in light — under
        // AA — on the box you type into, and every control in this row (the attach buttons, the
        // presence slider, the textarea's own text, and the live interim transcript painted behind
        // it) is read on it. The approved direction does not scrim the composer at all: `.cmp` is
        // an inset box sitting on `--k-input` with a rule around it, which is both the faithful
        // reading of the mock and the one that clears the floor. DO NOT REINTRODUCE THE SCRIM — theme/amberInk.test.ts already
        // models this plate as `inputSurface` and will go red if it moves.
        //
        // Inset rather than full-bleed (`margin`, `borderRadius`), because a box is what makes the
        // surface change read as "this is the field" rather than as a second plane in the column.
        // TIGHTER IN A NARROW COLUMN. 10px per side is a comfortable inset at 360px and 40% of the
        // whole column at 50px — the composer's own margins become the thing squeezing its contents
        // out. Collapsed on the same signal the toolbar collapses its labels on.
        margin: narrowColumn ? "0 2px 4px" : "0 10px 10px",
        borderRadius: 4,
        // The positioning context for the MENTION PICKER, which hangs off this box's TOP edge.
        //
        // Anchored to the ROOT, deliberately, and not to the textarea's `slotRef` wrapper below —
        // even though that wrapper is already `position: relative` and looks like the obvious home.
        // The height engine treats every non-textarea child of that wrapper as a PLACEHOLDER
        // OVERLAY and measures it into `placeholderH`, a FLOOR under auto-grow (see the layout
        // effect above). A picker in there would push the compose box to the height of its own
        // list, on every keystroke of a query. Here it is outside that walk, and spanning the root
        // also lines the list up with the composer's outer edges rather than with the textarea.
        position: "relative",
        // NO `borderTop`. That line is the FULL-BLEED STRIP this box replaced — a rule across the
        // top of a scrimmed band — and the three-way merge with main reinstated it beside the new
        // `border`, giving the box a rule all the way round PLUS a doubled top edge. The direction
        // separates registers by line weight, so the edge is the whole border and nothing else.
        padding: "10px 12px 12px",
        // WIRED: the column has taken the terminal's colour, so the composer stops painting a plate
        // of its own and floats on the flood with the terminal's own edge token around it. Its inks
        // are the terminal register's, set by the column on the section (they inherit).
        background: wired
          ? dropActive
            ? `color-mix(in srgb, ${C.teal} 10%, ${BLUEPRINT[mode].term})`
            : "transparent"
          : dropActive
            ? `color-mix(in srgb, ${C.teal} 10%, ${C.inputSurface})`
            : C.inputSurface,
        border: `1px solid ${wired ? BLUEPRINT[mode].termHair : C.hairline}`,
        outline: dropActive ? `1.5px dashed ${C.teal}` : "none",
        outlineOffset: -2,
      }}
    >
      {/* Type "@" and the fleet appears. Renders nothing when there is nothing to offer, so a query
          that matches no agent simply closes the list rather than parking an empty panel over the
          thread — typing on is a better exit than a dead end the user has to dismiss. */}
      {pickerOpen && (
        <MentionPicker
          agents={matches}
          selected={Math.min(selected, matches.length - 1)}
          onSelect={chooseMention}
          onHover={setSelected}
        />
      )}
      {/* Sits ABOVE the chips, where the chip the user expected would have appeared — the notice
          has to land where the absence is, not in a corner of the window. It persists until
          acknowledged or until a later attach succeeds: a self-dismissing toast is exactly what
          this bug already did once (something happened, the user didn't catch it). */}
      {attachNotice && (
        <div
          role="alert"
          data-testid="concierge-attach-notice"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginBottom: 8,
            padding: "5px 8px",
            borderRadius: 6,
            // TYPE.small, matching the chips it sits above — the notice is secondary UI in the same
            // register, and an off-scale size here trips the type ratchet (theme/scale.test.ts).
            fontSize: 12,
            color: C.dangerInk,
            background: `color-mix(in srgb, ${C.dangerInk} 12%, transparent)`,
          }}
        >
          <FiAlertTriangle size={12} aria-hidden style={{ flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0 }}>{attachNotice}</span>
          <button
            type="button"
            aria-label="Dismiss attachment error"
            onClick={onDismissAttachNotice}
            style={{
              display: "inline-flex",
              alignItems: "center",
              border: "none",
              background: "transparent",
              color: C.dangerInk,
              cursor: "pointer",
              padding: 0,
            }}
          >
            <FiX size={12} aria-hidden />
          </button>
        </div>
      )}
      {/* WHAT THIS MESSAGE IS REPLYING TO — topmost of the four rows above the textarea, because it
          is CONTEXT for the draft rather than cargo riding along with it: the pills and chips below
          are things being sent, this is the thing being answered.
          THE DRAFT IS NEVER TOUCHED. Staging a quote sets this slot and nothing else — the founder
          asked for his typed text to be preserved with the quote attached above it, which is what he
          has been doing by hand. */}
      {quote && <QuoteChip quote={quote} onRemove={onRemoveQuote} />}
      {/* COLLAPSED PASTES, in their own row directly above the attachment chips — the same register,
          and the same place in the box, because a pill and a chip are the same statement ("this is
          riding along with the next message"). Its own row rather than mixed in with the chips so a
          46px tile never stretches the chip strip it shares a line with. */}
      {textBlocks.length > 0 && (
        <div
          data-testid="concierge-text-pills"
          style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}
        >
          {textBlocks.map((b) => (
            <TextPill
              key={b.id}
              block={b}
              variant="tile"
              onOpen={() => setOpenBlock(b)}
              onRemove={() => removeTextBlock(b.id)}
            />
          ))}
        </div>
      )}
      {openBlock && (
        <TextPillModal
          block={openBlock}
          onClose={() => setOpenBlock(null)}
          onShowAsText={() => showBlockAsText(openBlock)}
        />
      )}
      {/* THE SAME STRIP THE TRANSCRIPT DRAWS, not a composer-shaped twin of it.
          This was a hand-rolled chip row: a 16×16 image wedged beside the filename, `cursor:
          default`, no click target and no lightbox — so the founder's screenshot was a real
          thumbnail once SENT and a favicon-sized smudge while still a draft. Both surfaces now go
          through composer/AttachmentStrip, which is also the only reason there is one lightbox and
          not two. `onRemove` is what makes this copy the DRAFT one: it is still staged, so it can
          still be taken back out. */}
      <AttachmentStrip
        attachments={attachments}
        onRemove={onRemoveAttachment}
        testId="concierge-attachment-chips"
      />
      {/* THE TOOLBAR ROW MUST FIT THE COLUMN. Icons first, then wrap — an overflow menu was
          rejected: it hides controls behind a click for a row with four controls total, while
          wrapping keeps every one visible and directly pressable. `minWidth: 0` is what lets any of
          it shrink; a flex item's default `min-width: auto` refuses to go below its content, which
          is exactly how a row overflows its parent instead of compressing inside it. */}
      <div
        data-testid="concierge-compose-toolbar"
        style={{
          display: "flex",
          gap: 6,
          marginBottom: 8,
          alignItems: "center",
          flexWrap: "wrap",
          minWidth: 0,
        }}
      >
        <AttachControl onAttach={onAttach} />
        {/* Right-aligned in the attach row, which puts it directly ABOVE the Send button — the
            action whose autonomy it governs. It reads and writes presenceStore itself rather than
            taking props; see PresenceSlider's header for why, and note this box already reads
            useUiStore for the same class of reason. */}
        <PresenceSlider showLabels={toolbarShowsLabels(columnWidth)} />
      </div>
      {/* NO INTERIM STRIP HERE. The live dictation preview used to be its own row at exactly this
          point — above the drag handle, above the textarea — and the founder's report was that the
          spoken words were "still showing above the actual text": two stacked lines for one
          sentence, with each phrase visibly JUMPING down into the box as it committed. It is now
          painted in the mention mirror at the end of the draft (see the <MentionMirror> below), so
          the provisional words sit exactly where the settled ones will, italic until they settle.
          Do not put a row back here — that is the bug, not the feature. */}
      {/* Drag the compose box taller. Sits on its TOP edge, so dragging up grows it — past the
          ten-line auto cap if you want, which is the whole reason to offer a handle. Dragging back
          down to the resting height releases it to auto-grow again. */}
      <div
        data-testid="concierge-compose-handle"
        role="separator"
        aria-label="Resize the message box"
        aria-orientation="horizontal"
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
        style={{
          height: 6,
          margin: "-4px 0 4px",
          cursor: "ns-resize",
          // Invisible until hovered: a permanent rule across the pane would read as a divider, and
          // the affordance is discoverable from the resize cursor.
          background: "transparent",
          borderRadius: 3,
          touchAction: "none",
          flex: "none",
        }}
      />
      {/* NO MIC BUTTON IN THIS ROW. There used to be one immediately left of the textarea, beside
          Send — a second microphone in a column whose header already carries the waveform ring, ~2
          inches apart and with no way to tell which one was in charge. The ring is now the app's
          single mic control: it owns arm/mute/off AND, since it names the concierge as the voice
          surface, it is what routes speech into this box. See LogoWaveform and
          dictationStore.voiceSurface.

          Removing the button did not remove the box from the mic pipeline: it still registers its
          append fn (the effect above) and still paints the live interim preview and every voice
          placeholder state below. It just no longer offers a redundant way to arm. */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
        {/* Positioning context for the placeholder overlays. They are absolutely placed over the
            textarea's first text line, so the textarea cannot be their own parent.

            It is also what the height measurement walks: everything in here that is NOT the
            textarea is an overlay, which is how the box learns how tall its placeholder is. */}
        <div ref={slotRef} style={{ position: "relative", flex: 1, display: "flex" }}>
          <textarea
            ref={textareaRef}
            // "Message", not "Message Sparkle": the box no longer knows where a send will go — the
            // host routes it per message — so naming a destination here would be a claim it can't
            // keep. This is what a screen reader announces for the box; the decorative overlay
            // below is aria-hidden precisely so it does not compete with it.
            aria-label="Message"
            // EMPTY, on purpose — but no longer because the slot is empty. The RichPlaceholderOverlay
            // below paints this state's copy, and a native placeholder cannot style a substring
            // (the wake phrase must be bold + brand blue), so the two must never both render.
            // Nothing here names a destination either way (PRD/sparkle/concierge-auto-routing.md §1),
            // and the ⌘↩ hint stays on the Send button below rather than in this text.
            placeholder=""
            // The keyboard hint puts the CARET here — the overlay focuses a text field rather than
            // clicking it, since click() on a textarea moves nothing and the badge would look inert.
            // Anchored to the top edge because this box is ten lines tall when it's working hard,
            // and a centred badge would sit halfway down an otherwise empty left edge.
            data-hint="prompt"
            data-hint-anchor="top"
            value={text}
            // The mention picker's aria wiring. The list is a SIBLING that never takes focus (the
            // query is the text still being typed), so the textarea is what has to announce it:
            // `combobox` + `aria-controls` + an `aria-activedescendant` pointing at the highlighted
            // row's id. This is the same pattern CommandPalette uses between its input and its
            // listbox — there, though, the input is inside a modal dialog, and here it is the app's
            // one composer, so every attribute is conditional on the list actually being open.
            role={pickerOpen ? "combobox" : undefined}
            aria-expanded={pickerOpen || undefined}
            aria-controls={pickerOpen ? MENTION_LISTBOX_ID : undefined}
            aria-activedescendant={pickerOpen && active ? mentionOptionId(active.id) : undefined}
            onChange={(e) => {
              setText(e.target.value);
              // Deleting everything releases the verbatim latch: an empty box holds nobody's paste.
              // See heldExpansionRef — the other half of "cleared when emptied" is clear-on-send.
              if (e.target.value === "") heldExpansionRef.current = false;
              // Read from the DOM, not inferred from the new string: an edit can move the caret
              // anywhere (a paste, a middle-of-word deletion, an IME commit), and the query depends
              // on where it actually landed.
              setCaret(e.target.selectionStart ?? e.target.value.length);
              // One of the feeders that resets the five-minute idle timer — do not restate the
              // list here; it is enumerated ONCE, in ConciergeHost's mount-gate block, because an
              // earlier version of this comment named "the other" one and there are three
              // (roborev 60364). Deliberately on the USER's edits only, for the same reason
              // onTextEdit is: a dictated segment landing in the box, or the clear-on-send, would
              // otherwise keep the app reporting Here while nobody is at the keyboard.
              usePresenceStore.getState().noteInput();
              // Only the user's OWN edits report — dictation appends go through setText directly.
              // That is what lets the host tell "this box was emptied by hand" (which retires the
              // dictated-origin latch) from "a segment just landed in it".
              onTextEdit?.(e.target.value);
            }}
            onKeyDown={(e) => {
              ownVoice();
              onKeyDown(e);
            }}
            // A long paste becomes a pill above the box rather than flooding it (see onPaste). A
            // short one is left entirely to the browser.
            onPaste={onPaste}
            // EVERY other way the caret moves: arrowing, clicking into the middle of a word,
            // dragging a selection, ⌘A. React's onSelect on a textarea is the DOM `selectionchange`
            // for this element, so one handler covers all of them — without it, typing `@Bl`, then
            // clicking away and back, would leave the query reading from a stale offset.
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            // The MIRROR of the agent composer's surface claim (Composer.tsx `ownVoice`). Without
            // it the arbiter is one-way: once the user's cursor has been in an agent composer,
            // nothing short of the header ring brings dictation back here, so clicking into this
            // box and speaking would send every segment to a composer in another column while the
            // caret blinks here — this bug's own symptom, mirrored. Genuine focus only: this box is
            // focused programmatically too (after a send, and on a capture-window handoff), and
            // neither is the user saying where their voice should go.
            onFocus={(e) => {
              if (!isProgrammaticFocus(e.currentTarget)) ownVoice();
            }}
            // …and a pointer press, because a click on an already-focused box fires no focus event,
            // and this box IS often already focused — the composeFocusSeq effect above puts the
            // caret here on every requestComposeFocus (roborev 54239).
            onPointerDown={ownVoice}
            style={{
              flex: 1,
              // `resize: none` stays: the browser's own corner grip resizes only the textarea, which
              // would desync it from the row's buttons and from the persisted height. The handle
              // above is the one resize affordance.
              resize: "none",
              height,
              // Past the auto cap the content scrolls INSIDE the box rather than the box growing on
              // forever. `auto` (not `scroll`) so a one-line draft shows no dead scrollbar gutter.
              overflowY: "auto",
              // NO PLATE AND NO EDGE OF ITS OWN. The box AROUND this textarea is now `.cmp` — one
              // inset box on `--k-input` with a rule around it — and a second filled, outlined
              // field inside it would draw the same boundary twice, which is the box-in-a-box the
              // direction's "structure is drawn, not filled" thesis rejects.
              //
              // The border is kept as `transparent` rather than removed: the rich placeholder
              // overlay is positioned against the textarea's border + padding (PLACEHOLDER_INSET),
              // and the auto-grow measurement is taken off its box, so deleting a pixel of border
              // would shift the painted copy off row one and silently mis-size the box. Transparent
              // costs nothing and keeps that geometry exactly where it was.
              //
              // The type ramp, the padding and that border now come from COMPOSE_TEXT_METRICS,
              // because the MENTION MIRROR behind this element has to match them exactly or its pill
              // fills sit off the words they belong to (see that constant).
              //
              // …and the FACE follows the aim: while this draft is bound for a mounted agent's
              // terminal it is set in the terminal's own font, so the typeface says where the words
              // are going (see COMPOSE_TEXT_METRICS_TERMINAL). The mirror below takes the same
              // object, which is what keeps the pills on their words through the swap.
              ...textMetrics,
              // THE DICTATION SPACER. While a phrase is provisional the mirror behind this element
              // paints `interimH` more pixels than this element's own value does, and this element's
              // scroll range is what the mirror follows — so without matching room down here the tail
              // of the preview sits below anything `ta.scrollTop` can reach. Padding, not content:
              // it moves no glyph and changes no wrap point, so the pill fills stay on their words.
              // The layout effect measures with this reset, or it would feed itself.
              //
              // AFTER the spread, and that ordering is load-bearing: `textMetrics` carries a
              // `padding` shorthand, so a spacer written above it would be silently overwritten.
              paddingBottom: dictationPadBottom,
              background: "transparent",
              color: "inherit",
              outline: "none",
              // ABOVE the mention mirror (zIndex 0), whose pill fills read through this element's
              // transparent background, and BELOW the placeholder overlays (zIndex 2) so a control
              // inside one of them — Refill, Dismiss — can actually receive its click instead of
              // being buried under the textarea.
              position: "relative",
              zIndex: 1,
            }}
          />
          {/* THE PILLS. Painted behind the textarea, so a completed `@Kraken Auth` reads as a pill
              while the message is still being written — the founder's report was that it only became
              one after Send. Skipped by the height measurement above (it mirrors the content, so it
              is not a placeholder floor) and inert to the pointer; see ./MentionMirror for why this
              is a mirror rather than a contenteditable.

              AND THE LIVE DICTATION PREVIEW, for the same reason the pills are here: this layer is
              the only one drawing in the textarea's own metrics, so a word appended to it lands
              where that word will actually be. Passing `interim` here is what puts the spoken text
              IN the prompt bar instead of in a strip above it.

              The box DOES grow to fit those words — this comment used to say the opposite, which
              was the invariant for exactly one commit before it turned out to mean "the words are
              clipped" (roborev 57324/57333). What the mirror's opt-out buys is narrower and still
              true: it is skipped by the PLACEHOLDER-floor walk, which would add the textarea's 22px
              chrome to a height that already includes the same padding. It is measured as its own
              input to the height instead — see the layout effect and `composeInterimExtraH`. */}
          <MentionMirror
            text={text}
            agents={roster}
            metrics={textMetrics}
            textareaRef={textareaRef}
            interim={interim}
          />
          {/* The two FAILURE states each take the slot over as their OWN sibling overlay, because
              each carries a control the decorative (aria-hidden) overlay would bury: aria-hidden
              hides a whole subtree with no way for a descendant to opt back in. role="status"
              instead, so the failure is both seen AND announced — this box is the app's only
              composer, so a mic that just broke has nowhere else to say so.

              They occupy the same slot on the same terms as the decorative overlay, and
              VoicePlaceholderCopy returns null for both states, so the two can never double up. */}
          {showRichPlaceholder && micPresentation === "error" && errorNotice && (
            <RichPlaceholderOverlay
              announce
              testId="compose-voice-error"
              inset={PLACEHOLDER_INSET}
              type={PLACEHOLDER_TYPE}
              hasSuggestionPill={false}
            >
              <ComposerVoiceError notice={errorNotice} />
            </RichPlaceholderOverlay>
          )}
          {showRichPlaceholder && micPresentation === "outOfCredits" && (
            <RichPlaceholderOverlay
              announce
              testId="compose-out-of-credits"
              inset={PLACEHOLDER_INSET}
              type={PLACEHOLDER_TYPE}
              hasSuggestionPill={false}
            >
              <ComposerOutOfCreditsNotice />
            </RichPlaceholderOverlay>
          )}
          {showRichPlaceholder && (
            <RichPlaceholderOverlay
              testId="compose-placeholder"
              inset={PLACEHOLDER_INSET}
              type={PLACEHOLDER_TYPE}
              // FALSE, because the recommended-action pill is not on this surface at all: it
              // renders over the agent's TERMINAL, portalled onto that pane's stage (see
              // Concierge/ConciergeSuggestions). Nothing is painted over this textarea, so there is
              // nothing to wrap early around.
              //
              // The reason used to be stated as "the column renders the row with layout='row', a
              // static strip above this box (ConciergeColumn's suggestionsSlot)". Both halves are
              // now false — the slot was deleted when the pill moved, and the row renders
              // layout="overlay" — so anyone checking that premise would find "overlay" and flip
              // this to `true`, wrongly reserving pill room and re-wrapping the copy early
              // (roborev 53730-M). The VALUE is unchanged and still correct; only its reason moved.
              //
              // Worth keeping even though it no longer decides this flag: at the 360px column the
              // pill zone (SUGGESTION_PILL_ZONE, 253px) is WIDER than this textarea's whole text
              // column (CONCIERGE_TEXTAREA_TEXT_WIDTH, ~200px), so an overlay pill and this copy
              // could never have coexisted here regardless. Pinned by ComposeBox.placeholder.test.tsx.
              hasSuggestionPill={false}
            >
              <VoicePlaceholderCopy
                micPresentation={micPresentation}
                captionKind={captionKind}
                modelProgress={modelProgress}
                // WHY the mic is paused, so the `focusPaused` copy can name the cause rather than
                // saying "paused" and leaving the user to guess (they guessed "broken").
                pauseReason={pauseReason}
                // `off` (master mute) is the ONLY state that reaches this, and it is the default —
                // see CONCIERGE_PLACEHOLDER. `error` and `outOfCredits` deliberately render NOTHING
                // here rather than falling through to it: inviting someone to speak is the one
                // thing this slot must not do at the moment the mic failed or was refused.
                fallback={CONCIERGE_PLACEHOLDER}
              />
            </RichPlaceholderOverlay>
          )}
        </div>
      </div>
      {/* THE SEND TRAY — its own full-width row BENEATH the textarea, and the ONLY press target.
          Send used to sit to the RIGHT of the textarea; it moved because the tray cannot fit beside
          the box. The concierge column's minimum is 320px, and a ~190px strip there would leave
          ~120px of typing room.

          It replaced a Send button plus a separate auto-send arming switch — two controls asking
          one question. The Send POSITION keeps `aria-label="Send"` in every mode and still sends on
          ⌘↩, so every existing query and keybinding finds it exactly where it was (./SendModeTray).

          Rendered ALWAYS. The tray is where Send lives now, so it is not conditional on the voice
          feature being on — a box with no voice wiring simply shows a tray parked at Send. */}
      <SendModeTray
        mode={sendMode}
        onModeChange={(next) => onSendModeChange?.(next)}
        model={autoSend ?? IDLE_COUNTDOWN}
        inert={trayInert}
        pttHeld={pttHeld}
        chord={sendChord}
        onSend={submit}
        canSend={canSend}
        // The rail is drawn on whatever ground THIS box is on, so it needs the same flag the box's
        // own border does. Without it the counting track paints the chrome hairline on the terminal
        // flood, which theme/chromeContrast.test.ts measures BELOW the visibility floor in light —
        // i.e. the one cue that separates counting from armed-idle disappears (roborev 55244).
        wired={wired}
      />
      {/* THE AUTO-SEND SWITCH — below the tray, right-aligned, and ONLY in Speak.

          The founder's placement, verbatim: "below the slider tray, but to the right side".

          `modeCountsDown` rather than `sendMode === "speak"` spelled out again: the toggle governs
          what an expired countdown does, so "there is a switch here" and "there is a countdown here"
          are ONE fact (voice/sendMode). Two spellings is how a switch ends up in a position with
          nothing behind it.

          Hidden — not disabled — outside Speak. The setting is remembered while it is hidden (it
          lives in the persisted store, not in this subtree), so the founder's "every time I go to
          the speak slider, then it stays on" holds across mode changes and across relaunches.

          NO TOGGLE WITHOUT A LISTENER: `onAutoSendChange` absent means this host has not wired the
          setting to the countdown, and painting a movable switch the engine ignores is worse than
          painting none. */}
      {onAutoSendChange && modeCountsDown(sendMode) && (
        <AutoSendToggle
          checked={autoSendOn}
          onChange={onAutoSendChange}
          // Greyed with the tray when a live PTY owns the keyboard, for the same reason the tray
          // greys: keystrokes are going somewhere else. The VALUE is untouched and still shown.
          disabled={trayInert}
        />
      )}
    </div>
  );
}
