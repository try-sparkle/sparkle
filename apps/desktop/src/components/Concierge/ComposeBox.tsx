// The one compose box in the app (the terminal has none — the concierge is where you talk).
// Attach row (ONE paperclip, expanding to Screenshot / Upload) above a textarea + Send row;
// ⌘/Ctrl+Enter submits. Purely presentational: submit reports trimmed text via onSend and clears.
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
// textarea and are editable and sendable like typed text; the INTERIM preview stays outside the
// textarea, because Deepgram replaces it word-by-word and a send that captured it would ship a
// half-heard phrase that is about to be superseded.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { FiAlertTriangle, FiCamera, FiFile, FiPaperclip, FiUpload, FiX } from "react-icons/fi";
// `C` ALONE, and the three tokens that left are the two halves of this merge, not an oversight:
// FONT_WEIGHT / ON_GOLD_FILL went with the Send button when it moved into ./SendRail (the gold
// rect's styling travelled verbatim, so SendRail imports them itself), and COMPOSE_SCRIM went with
// the scrim when `.cmp` became a box on `--k-input` — see the long note on the root's `background`.
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
import { useVoicePlaceholder } from "../../voice/useVoicePlaceholder";
import { useDictationStore } from "../../stores/dictationStore";
import { focusQuietly, isProgrammaticFocus } from "../../services/programmaticFocus";
import {
  CONCIERGE_THREAD_TESTID,
  composeDragH,
  composeDragReleasesManual,
  composeRenderH,
} from "../../engine/composeBoxHeight";
import { MentionPicker, MENTION_LISTBOX_ID, mentionOptionId } from "./MentionPicker";
import {
  backspaceMention,
  insertMention,
  isCompletedMention,
  mentionQuery,
  mentionRoster,
  mentionsIn,
  orderMentionAgents,
  type ConciergeMention,
  type MentionAgent,
} from "./mentions";
import { SendRail, type SendRailModel } from "./SendRail";

const line = `color-mix(in srgb, ${C.muted} 25%, transparent)`;

/** The rail a box mounted WITHOUT auto-send wiring draws: off, aimed nowhere, nothing counting.
 *  Module-level so it is the same object every render — the rail is memo-friendly and a fresh
 *  literal per render would defeat that for no gain. */
const DISARMED_RAIL: SendRailModel = {
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

/** The id `aria-controls` points at — one control, one target, so a constant rather than a hook. */
const ATTACH_ACTIONS_ID = "concierge-attach-actions";

/** THE TWO THINGS THE PAPERCLIP CAN DO. The row used to be three permanently-visible labelled
 *  buttons — Screenshot / Image / Files — which is three controls' worth of chrome above a compose
 *  box whose whole design is to look empty. It is one resting icon now, expanding into these on
 *  hover or focus (see AttachControl).
 *
 *  Two, not three: `image` and `files` are the same OS panel, differing only in whether it is
 *  narrowed to the image extensions, and "upload an image" vs "upload a file" is not a distinction
 *  worth a second target in a two-target menu — the unfiltered picker takes images too, and the
 *  chip it produces is identical (loadAttachment classifies by extension, so a picked .png is still
 *  `kind: "image"` with a thumbnail).
 *
 *  `pickAttachments("image")` is NOT dead: the kind stays in ConciergeAttachKind and keeps its unit
 *  coverage in services/conciergeAttach.test.ts. It is a supported service option this surface
 *  currently doesn't spend a target on. Don't delete it to "clean up" — restoring an image-narrowed
 *  entry point (a paste path, a second surface) should not have to re-derive the picker. */
const ATTACH_ACTIONS: {
  kind: ConciergeAttachKind;
  label: string;
  Icon: typeof FiCamera;
  title: string;
  // The keyboard-hint id, carried here rather than derived from `kind`: the ids are named for what
  // the user sees ("upload") while the kind is named for the service call it makes ("files"), and a
  // derived id would silently break the hint the day either name changes for its own reasons.
  hint: string;
}[] = [
  {
    kind: "screenshot",
    label: "Screenshot",
    Icon: FiCamera,
    title: "Capture a screen region",
    hint: "attach-screenshot",
  },
  {
    kind: "files",
    label: "Upload",
    Icon: FiUpload,
    title: "Upload a file from your desktop",
    hint: "attach-upload",
  },
];

/**
 * ONE resting paperclip that expands into its two real actions on hover — the founder's ask, and
 * the reason it is a hover EXPANSION rather than a click-then-menu: a menu makes you commit a click
 * before it will tell you what is behind the icon, and there are only two things back there.
 *
 * HOVER IS NOT THE ONLY PATH, and that is not decoration. A pointer-only disclosure is unusable by
 * keyboard and by touch, so `open` is driven by TWO independent inputs:
 *   • `hovered` — mouseenter/mouseleave on the group.
 *   • `pinned`  — focus anywhere inside the group (React's onFocus/onBlur are focusin/focusout, so
 *     they bubble from the buttons), plus a click on the paperclip for touch, where nothing hovers.
 * `open = hovered || pinned`, so neither input can close what the other is holding open: tabbing
 * in opens it and it stays open while you tab BETWEEN the two actions (the blur only counts when
 * the new target is outside the group), and moving the mouse away doesn't yank it from under a
 * keyboard user.
 *
 * THE PAPERCLIP'S CLICK OPENS; IT NEVER CLOSES. A toggle reads tidier but is wrong on the mouse
 * path: by the time you can click it, hover has already opened it, so the click's only visible
 * effect would be to collapse the thing you just aimed at, out from under a cursor that cannot
 * re-fire mouseenter without leaving and coming back. Escape closes (and returns focus to the
 * paperclip), and so does leaving/tabbing away. `aria-expanded` still reports the true state.
 *
 * The actions carry the `hidden` attribute when collapsed rather than being unmounted or merely
 * painted out: `hidden` takes them out of the accessibility tree AND the tab order together, so the
 * announced state and the reachable state can't drift apart. Choosing one collapses the group back
 * to the single icon — the picker it opened is the surface now.
 */
function AttachControl({ onAttach }: { onAttach: (kind: ConciergeAttachKind) => void }) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const groupRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<HTMLButtonElement>(null);
  // Escape closes the group AND hands focus back to the paperclip — but that refocus lands INSIDE
  // the group, so the focusin it raises would immediately re-pin what Escape just closed and the
  // key would do nothing at all. This one-shot flag lets the handler know that focus event is our
  // own. Set only when a focus event will actually fire (i.e. the clip isn't already focused), so
  // it can never be left armed to swallow a genuine one.
  const reclaimingFocus = useRef(false);
  const open = hovered || pinned;
  // BOTH INPUTS, because `open` is their OR and an explicit dismissal has to beat both (roborev
  // 54158). Clearing `pinned` alone is not closing: on the ordinary mouse path the pointer is still
  // over the group when Escape is pressed — keydown only fires with focus inside, and that focus
  // almost always arrived by clicking the paperclip — so hover holds the group open, `aria-expanded`
  // stays "true", and Escape looks inert. The group is then un-closable by keyboard until the
  // pointer physically leaves. Choosing an action is the same bug and the worse one: the picker it
  // opens takes the pointer away without necessarily delivering a `mouseleave` to the webview, so
  // `hovered` latches true and the row stays expanded after the picker dismisses.
  //
  // Hover is cleared, not disarmed: `mouseenter` fires again the next time the pointer actually
  // enters the group, which is what "I dismissed this" should mean — dismissed until you come back.
  //
  // Closing takes the actions OUT of the tree (`hidden` + display:none), so whoever closed it must
  // also say where focus goes — otherwise it falls to <body>, dropping the user out of the compose
  // box entirely, and for a moment leaves a focused element inside a hidden subtree (roborev
  // 54233). That was invisible while `pinned` was cleared alone: hover kept the group mounted, so
  // the focused action button stayed valid. Both close paths need the handback, and both need the
  // `reclaimingFocus` guard with it, since the paperclip is INSIDE the group and the focus event it
  // raises would otherwise re-pin what we just closed.
  //
  // ONLY when focus is already inside the group, though. WebKit on macOS does not focus a <button>
  // on click unless Full Keyboard Access is on, and this app is a WKWebView — so the ordinary path
  // is "caret in the textarea, user clicks Screenshot", and grabbing focus unconditionally would
  // yank the caret out of the composer to attach a file. Focus outside the group is already
  // somewhere the user chose; only focus that is about to be destroyed needs rehoming.
  const close = useCallback(() => {
    setHovered(false);
    setPinned(false);
    const active = document.activeElement;
    if (active !== clipRef.current && groupRef.current?.contains(active)) {
      reclaimingFocus.current = true;
      clipRef.current?.focus();
    }
  }, []);

  return (
    <div
      ref={groupRef}
      data-testid="concierge-attach"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={(e) => {
        if (reclaimingFocus.current) {
          reclaimingFocus.current = false;
          return;
        }
        // A PROGRAMMATIC focus is not the user arriving here, so it must not pin the group open.
        // The keyboard-hint overlay hands focus back to the paperclip when it abandons a chain
        // (HintOverlay.leaveChain → focusQuietly), and re-pinning on that would re-expand the very
        // group the same gesture just collapsed — leaving it stranded with its badges scoped away.
        // Genuine focus still pins, and chain ENTRY uses a plain focus() precisely so that it does.
        if (isProgrammaticFocus(e.target as HTMLElement)) return;
        setPinned(true);
      }}
      onBlur={(e) => {
        // Only a focus move OUT of the group closes it — moving between the paperclip and the two
        // actions fires blur too, and treating that as "left" would collapse the group mid-tab.
        if (!groupRef.current?.contains(e.relatedTarget as Node | null)) setPinned(false);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !open) return;
        // Stop here: Escape inside the compose box otherwise reaches the surfaces around it, and
        // closing this group is the whole of what the user asked for.
        e.stopPropagation();
        // `close` carries the focus handback — a keydown can only have reached here with focus
        // inside the group, so its guard is always satisfied on this path.
        close();
      }}
      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
    >
      <button
        ref={clipRef}
        type="button"
        aria-label="Attach"
        aria-expanded={open}
        aria-controls={ATTACH_ACTIONS_ID}
        title="Attach a screenshot or a file"
        // A CHAINING hint, like the Recent-projects trigger: this click only EXPANDS the group, so
        // the overlay keeps hint mode alive and badges the two actions rather than closing on a
        // menu the keyboard then can't reach.
        data-hint="attach"
        onClick={() => setPinned(true)}
        style={{
          ...attachStyle,
          padding: "5px 7px",
          // The one lit-on-open cue the resting state gets: with the label gone, nothing else says
          // this icon is the thing the two buttons came out of.
          color: open ? C.cream : C.conciergeMuted,
        }}
      >
        <FiPaperclip size={13} aria-hidden />
      </button>
      <div
        id={ATTACH_ACTIONS_ID}
        hidden={!open}
        style={{ display: open ? "inline-flex" : "none", gap: 6, alignItems: "center" }}
      >
        {ATTACH_ACTIONS.map(({ kind, label, Icon, title, hint }) => (
          <button
            key={kind}
            type="button"
            title={title}
            // Only badged while the overlay's attach chain is open — the group expands on hover too,
            // and "s" is also the agent-pane composer's screenshot mnemonic. See HintLayer.
            data-hint={hint}
            onClick={() => {
              onAttach(kind);
              close();
            }}
            style={attachStyle}
          >
            <Icon size={12} aria-hidden />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Where a committed dictation segment goes in the box: appended, space-separated, never
 *  double-spaced. Pure so the commit rule is testable without a mic. */
export function appendDictated(current: string, segment: string): string {
  const chunk = segment.trim();
  if (!chunk) return current;
  if (!current) return chunk;
  return current.endsWith(" ") ? `${current}${chunk}` : `${current} ${chunk}`;
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
  autoSend,
  onToggleAutoSend,
  onComposedText,
  registerSubmit,
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
  onSend: (text: string, mentions?: ConciergeMention[]) => void | Promise<boolean>;
  onAttach: (kind: ConciergeAttachKind) => void;
  onRemoveAttachment?: (id: string) => void;
  /** Staged files, owned by the host — rendered as chips, cleared by the host on send. */
  attachments?: Attachment[];
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
  registerInsert?: (append: ((text: string) => void) | null) => void;
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
  /** The auto-send rail's live state (PRD §4), supplied by the host from voice/autoSendTimer.
   *
   *  OPTIONAL, and its absence means DISARMED rather than absent: the rail is where the Send button
   *  lives now, so it renders either way. A host that has not wired auto-send up yet gets a Send
   *  button with an inert off-switch beside it, which is exactly what a disarmed rail is. */
  autoSend?: SendRailModel;
  /** The user flipped the rail's arming switch. Absent → the switch is inert (see `autoSend`). */
  onToggleAutoSend?: (armed: boolean) => void;
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
}) {
  const [text, setText] = useState("");
  // Concrete hex for the two spec tokens that have no CSS var of their own (see
  // theme/blueprintSpec) — the terminal plane the wired composer floats on, and its edge.
  const mode = useResolvedTheme();
  // The voice state behind the placeholder copy, read from the store rather than taken as a prop.
  // Deliberate: deriveMicPresentation exists so every mic surface renders the SAME state for one
  // store snapshot, and a second path to it through this component's prop contract is exactly how
  // the "sidebar says Actively listening, composer says Mic paused" desync comes back. See
  // voice/useVoicePlaceholder.
  const { micPresentation, wakeWord, stopWord, modelProgress, errorNotice } = useVoicePlaceholder();
  // The overlay stands in for a native placeholder, so it shows on exactly the same terms one
  // would: an empty textarea. Staged attachments and a live interim transcript each render in
  // their OWN row above the textarea (see below), so neither competes for this slot.
  const showRichPlaceholder = text === "";
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
    focusQuietly(textareaRef.current);
    // …but dictation DOES follow, said outright rather than inferred from that focus. Every caller
    // of requestComposeFocus is a user gesture (the drop pill's "go to compose", a file drop,
    // spawning an agent, the capture-window handoff), so reaching this effect at all IS the user
    // asking for this box. Stating it here rather than carrying an intent flag through the focus
    // event is what makes it survive the caret arriving late — or already being here, in which case
    // no focus event fires at all (roborev 54259).
    ownVoiceRef.current();
  }, [composeFocusSeq]);
  useEffect(() => {
    if (!registerInsert) return;
    const append = (segment: string) =>
      setText((prev) => {
        const next = appendDictated(prev, segment);
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
  // The space this box's TEXTAREA and the THREAD share — not the window, and not the box's whole
  // root either. Two distinct traps, both of which clip the Send row off the bottom (roborev
  // 53572 / 53586):
  //
  //   1. The column carries a fixed header (wordmark, spend pill, scope vitals) and a suggestions
  //      slot that cannot compress, so sizing against `window.innerHeight` over-allocates by all of
  //      it and the thread collapses to zero.
  //   2. The ceiling is applied to the TEXTAREA, but the root also holds the attach row, the chips,
  //      the interim dictation line and the drag handle — ~60px the textarea never sees. Measuring
  //      the pool in root units and spending it in textarea units silently hands the thread that
  //      much less than COMPOSE_MIN_THREAD_H promises. So the box's own chrome comes off the pool.
  //
  // And because the dragged height is persisted, either mistake survives a relaunch.
  const rootRef = useRef<HTMLDivElement>(null);
  // The thread node currently under observation. Tracked so `measure` re-observes only when the
  // node IDENTITY changes (ConciergeThread remounting), never on every callback.
  const observedThread = useRef<HTMLElement | null>(null);
  const [availableH, setAvailableH] = useState(() =>
    typeof window === "undefined" ? 800 : window.innerHeight,
  );
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const findThread = () =>
      root
        .closest("section")
        ?.querySelector<HTMLElement>(`[data-testid="${CONCIERGE_THREAD_TESTID}"]`) ?? null;

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
    ta.style.height = "auto";
    const next = ta.scrollHeight;
    ta.style.height = prev;
    setContentH((cur) => (cur === next ? cur : next));

    // The same measurement for the RICH PLACEHOLDER, which the scrollHeight above cannot see: the
    // overlay is a SIBLING of the textarea, not its content, so an empty box measures one line
    // while the copy painted over it runs three. Auto-grow alone would therefore reproduce exactly
    // the clipping this branch replaced `placeholder=""` to fix — and worst for the voice-error
    // notice, the tallest copy in the slot and the only one carrying controls (Dismiss / Open
    // System Settings) that must not be clipped out of reach.
    //
    // Everything in the slot that is not the textarea IS an overlay, so no marker attribute is
    // needed; at most one failure overlay and the decorative one are up at once, and the taller
    // wins. Releasing `bottom` first is the same collapse-then-measure trick as above and is
    // load-bearing for the same reason: scrollHeight can never report LESS than the box we already
    // sized, so measuring it in place would ratchet the floor up and never let it back down.
    const slot = slotRef.current;
    let overlayH = 0;
    if (slot) {
      for (const el of Array.from(slot.children)) {
        if (el === ta || !(el instanceof HTMLElement)) continue;
        const prevBottom = el.style.bottom;
        el.style.bottom = "auto";
        overlayH = Math.max(overlayH, el.scrollHeight);
        el.style.bottom = prevBottom;
      }
    }
    setPlaceholderH((cur) => (cur === overlayH ? cur : overlayH));
  }, [text, interim, showRichPlaceholder, micPresentation, errorNotice, modelProgress, wakeWord, stopWord]);

  const height = composeRenderH({ contentH, userH: userH ?? null, availableH, placeholderH });

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
  const canSend = text.trim().length > 0 || attachments.length > 0;
  // RETURNS WHETHER A MESSAGE WENT OUT, for the auto-send rail (see `registerSubmit`). The button
  // ignores it; the rail cannot, because "I called submit" and "a message was sent" differ exactly
  // here — an empty box early-returns, and the rail would otherwise announce "Sent to …" and record
  // a tuning sample for a send that never happened.
  const submit = (): boolean => {
    if (!canSend) return false;
    const v = text.trim();
    // Resolved HERE, at submit, off the trimmed text that is actually going out — never carried
    // along in state. That is the whole point of deriving mentions (see ./mentions): what the user
    // can read in the box at the moment they press Send is what the message is addressed to, with
    // no second copy that could have drifted from it.
    const mentions = mentionsIn(v, roster);
    // ONE argument when nothing is addressed, not a second one holding `undefined`. An unaddressed
    // send has to be indistinguishable from what this box has always sent — the host's `onSend` is
    // the column's oldest contract and every consumer and test of it was written against the
    // single-argument call. Passing an explicit `undefined` is a different call, and arity is
    // observable (a spy asserted with `toHaveBeenCalledWith(text)` sees it and fails).
    const outcome = mentions.length ? onSend(v, mentions) : onSend(v);
    setText("");
    setCaret(0);
    setDismissedAnchor(null);
    if (outcome && typeof outcome.then === "function") {
      void outcome.then((ok) => {
        if (!ok && v) setText((cur) => (cur === "" ? v : cur));
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
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
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
        // presence slider, the interim transcript, the textarea's own text) is read on it. The
        // approved direction does not scrim the composer at all: `.cmp` is an inset box sitting on
        // `--k-input` with a rule around it, which is both the faithful reading of the mock and the
        // one that clears the floor. DO NOT REINTRODUCE THE SCRIM — theme/amberInk.test.ts already
        // models this plate as `inputSurface` and will go red if it moves.
        //
        // Inset rather than full-bleed (`margin`, `borderRadius`), because a box is what makes the
        // surface change read as "this is the field" rather than as a second plane in the column.
        margin: "0 10px 10px",
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
      {attachments.length > 0 && (
        <div
          data-testid="concierge-attachment-chips"
          style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}
        >
          {attachments.map((a) => (
            <span
              key={a.id}
              title={a.name}
              style={{
                ...attachStyle,
                cursor: "default",
                maxWidth: 170,
                color: C.cream,
                background: `color-mix(in srgb, ${C.teal} 10%, transparent)`,
              }}
            >
              {a.dataUrl ? (
                <img
                  src={a.dataUrl}
                  alt=""
                  style={{ width: 16, height: 16, objectFit: "cover", borderRadius: 3 }}
                />
              ) : (
                <FiFile size={12} aria-hidden />
              )}
              <span
                style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}
              >
                {a.name}
              </span>
              <button
                type="button"
                aria-label={`Remove ${a.name}`}
                onClick={() => onRemoveAttachment?.(a.id)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  border: "none",
                  background: "transparent",
                  color: C.conciergeMuted,
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                <FiX size={12} aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center" }}>
        <AttachControl onAttach={onAttach} />
        {/* Right-aligned in the attach row, which puts it directly ABOVE the Send button — the
            action whose autonomy it governs. It reads and writes presenceStore itself rather than
            taking props; see PresenceSlider's header for why, and note this box already reads
            useUiStore for the same class of reason. */}
        <PresenceSlider />
      </div>
      {interim ? (
        <div
          data-testid="concierge-interim"
          // aria-live="off", deliberately (roborev 48171): Deepgram replaces this preview word by
          // word, so a polite region hands the screen reader a fresh announcement per partial and
          // the queue never drains — drowning out everything else. The text is decorative and
          // immediately superseded. What matters — the finished reply, and each send outcome — is
          // announced by the column's hidden role="status" node (ConciergeColumn), which is fed
          // FINISHED lines only. Not the thread: it renders the streaming transcript, so a live
          // region there re-announces the reply on every chunk (roborev 52648/53010/53088).
          aria-live="off"
          style={{
            fontSize: 12,
            fontStyle: "italic",
            color: C.muted,
            padding: "0 2px 6px",
          }}
        >
          {interim}
        </div>
      ) : null}
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
              // Read from the DOM, not inferred from the new string: an edit can move the caret
              // anywhere (a paste, a middle-of-word deletion, an IME commit), and the query depends
              // on where it actually landed.
              setCaret(e.target.selectionStart ?? e.target.value.length);
              // One of the two things that resets the five-minute idle timer (the other is
              // a terminal keystroke, Terminal.tsx's onData). Deliberately on the USER's
              // edits only, for the same reason onTextEdit is: a dictated segment landing in
              // the box, or the clear-on-send, would otherwise keep the app reporting Here
              // while nobody is at the keyboard.
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
              background: "transparent",
              border: "1px solid transparent",
              borderRadius: 6,
              color: "inherit",
              padding: "10px 12px",
              fontSize: 13,
              lineHeight: PLACEHOLDER_TYPE.lineHeight,
              fontFamily: "inherit",
              outline: "none",
              // BELOW the overlays (zIndex 2) so a control inside one of them — Refill, Dismiss —
              // can actually receive its click instead of being buried under the textarea.
              position: "relative",
              zIndex: 1,
            }}
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
                wakeWord={wakeWord}
                stopWord={stopWord}
                modelProgress={modelProgress}
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
      {/* THE SEND RAIL — its own full-width row BENEATH the textarea, carrying the Send button.
          Send used to sit to the RIGHT of the textarea in the row above; it moved because the rail
          cannot fit beside the box. The concierge column's minimum is 320px, and a ~190px rail
          there would leave ~120px of typing room. Nothing about the button changed but its
          position: same gold rect, same 42px, same `aria-label="Send"` and same ⌘↩ shortcut, so
          every existing query and keybinding still finds it.

          Rendered ALWAYS, armed or not. The rail is where Send lives now, so it is not conditional
          on the auto-send feature being on — a disarmed rail is just a Send button with an off
          switch beside it (see ./SendRail). */}
      <SendRail
        model={autoSend ?? DISARMED_RAIL}
        onToggleArmed={(next) => onToggleAutoSend?.(next)}
        onSend={submit}
        canSend={canSend}
      />
    </div>
  );
}
