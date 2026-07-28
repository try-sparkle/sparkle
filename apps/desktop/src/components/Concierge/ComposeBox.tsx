// The one compose box in the app (the terminal has none — the concierge is where you talk).
// Attach row (Screenshot / Image / Files) above a mic + textarea + Send row; ⌘/Ctrl+Enter
// submits. Purely presentational: submit reports trimmed text via onSend and clears; the mic
// button only reports onMicToggle — micLive (the armed state) is a prop, owned upstream.
//
// ATTACHMENTS (parity row #21). The attach buttons report a KIND; the host runs the picker and owns
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
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { FiCamera, FiFile, FiImage, FiMic, FiPaperclip, FiX } from "react-icons/fi";
import { C, COMPOSE_SCRIM, FONT_WEIGHT, ON_GOLD_FILL } from "../../theme/colors";
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
import {
  COMPOSE_MIN_H,
  CONCIERGE_THREAD_TESTID,
  composeDragH,
  composeDragReleasesManual,
  composeRenderH,
} from "../../engine/composeBoxHeight";

const line = `color-mix(in srgb, ${C.muted} 25%, transparent)`;

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
 *  column's own 12px×2 padding, the mic button (~31), the Send button (~63), the row's two 8px
 *  gaps, and the textarea's 12px×2 padding + 1px×2 border all come off. Approximate on purpose —
 *  it exists to be COMPARED against SUGGESTION_PILL_ZONE, and the two are far enough apart that a
 *  few pixels either way cannot change the answer. Exported so that comparison is a test rather
 *  than a claim in a comment (see ComposeBox.placeholder.test.tsx). */
export const CONCIERGE_TEXTAREA_TEXT_WIDTH = 360 - 24 - 31 - 63 - 16 - 26;

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
  fontSize: 11,
  color: C.conciergeMuted,
  background: "transparent",
  border: `1px solid ${line}`,
  borderRadius: 8,
  padding: "5px 9px",
  cursor: "pointer",
  display: "inline-flex",
  gap: 5,
  alignItems: "center",
};

const ATTACHMENTS: { kind: ConciergeAttachKind; label: string; Icon: typeof FiCamera; title: string }[] = [
  { kind: "screenshot", label: "Screenshot", Icon: FiCamera, title: "Capture a screenshot" },
  { kind: "image", label: "Image", Icon: FiImage, title: "Upload an image" },
  { kind: "files", label: "Files", Icon: FiPaperclip, title: "Attach files from your desktop" },
];

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
  onMicToggle,
  onAttach,
  onRemoveAttachment,
  attachments = [],
  dropActive = false,
  micLive = false,
  interim = "",
  registerInsert,
  onTextEdit,
}: {
  /** Reports the trimmed text (empty only when something is attached). May return a promise
   *  resolving FALSE when the send failed, in which case the box restores the draft (see submit). */
  onSend: (text: string) => void | Promise<boolean>;
  onMicToggle: () => void;
  onAttach: (kind: ConciergeAttachKind) => void;
  onRemoveAttachment?: (id: string) => void;
  /** Staged files, owned by the host — rendered as chips, cleared by the host on send. */
  attachments?: Attachment[];
  /** A native file drag is over this box (the host hit-tests the window-global event). */
  dropActive?: boolean;
  micLive?: boolean;
  /** Live, uncommitted transcript; rendered as a ghost line, never submitted. */
  interim?: string;
  /** Must be referentially STABLE (useCallback upstream) — the box re-registers whenever it
   *  changes, and an unstable identity would churn the app-wide dictation target every render. */
  registerInsert?: (append: ((text: string) => void) | null) => void;
  /** The user TYPED (or deleted) — reports the new value. Not fired for dictated segments or the
   *  clear-on-send, so the host can see the box being emptied by hand. */
  onTextEdit?: (text: string) => void;
}) {
  const [text, setText] = useState("");
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
    textareaRef.current?.focus();
  }, [composeFocusSeq]);
  useEffect(() => {
    if (!registerInsert) return;
    const append = (segment: string) => setText((prev) => appendDictated(prev, segment));
    registerInsert(append);
    return () => registerInsert(null);
  }, [registerInsert]);

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
  const submit = () => {
    if (!canSend) return;
    const v = text.trim();
    const outcome = onSend(v);
    setText("");
    if (outcome && typeof outcome.then === "function") {
      void outcome.then((ok) => {
        if (!ok && v) setText((cur) => (cur === "" ? v : cur));
      });
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      ref={rootRef}
      data-testid="concierge-compose"
      style={{
        flex: "none",
        borderTop: `1px solid ${line}`,
        padding: "10px 12px 12px",
        // COMPOSE_SCRIM, not a literal: it is the plate every control in this row sits on, so the
        // contrast tests have to composite from the same number (theme/colors.ts, roborev 53655-H).
        background: dropActive ? `color-mix(in srgb, ${C.teal} 10%, ${COMPOSE_SCRIM})` : COMPOSE_SCRIM,
        outline: dropActive ? `1.5px dashed ${C.teal}` : "none",
        outlineOffset: -2,
      }}
    >
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
        {ATTACHMENTS.map(({ kind, label, Icon, title }) => (
          <button
            key={kind}
            type="button"
            title={title}
            onClick={() => onAttach(kind)}
            style={attachStyle}
          >
            <Icon size={12} aria-hidden />
            {label}
          </button>
        ))}
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
      <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
        <button
          type="button"
          aria-label="Talk to Sparkle"
          aria-pressed={micLive}
          title="Talk to Sparkle"
          onClick={onMicToggle}
          style={{
            ...attachStyle,
            padding: "7px 8px",
            // Prototype `.composer .mic.live` — a gold-hot glyph in a gold-bordered gold tint.
            // The BORDER is opaque, so it takes the themed goldFill; the 12% wash stays literal,
            // because a translucent tint composites against whatever is behind it.
            ...(micLive
              ? {
                  color: C.goldHotInk,
                  borderColor: C.goldFill,
                  background: `color-mix(in srgb, ${C.gold} 12%, transparent)`,
                }
              : null),
          }}
        >
          <FiMic size={15} aria-hidden />
        </button>
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
            value={text}
            onChange={(e) => {
              setText(e.target.value);
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
            onKeyDown={onKeyDown}
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
              // barSurface, not forest: under the black-and-gold palette forest is the
              // near-black TERMINAL plane and punches a hole through the composer.
              background: C.barSurface,
              border: `1px solid ${line}`,
              borderRadius: 12,
              color: C.cream,
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
        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          aria-label="Send"
          // Carries the shortcut the placeholder no longer spends its text on — without this the
          // keybinding would have no on-screen discoverability at all. A tooltip alone would hide
          // it from keyboard and touch users entirely, so it is also declared to assistive tech,
          // which announces it without anyone having to hover.
          title="Send (⌘↩)"
          aria-keyshortcuts="Meta+Enter Control+Enter"
          style={{
            fontSize: 13,
            fontWeight: FONT_WEIGHT.bold,
            // Prototype `.composer .send { color: var(--ink); background: var(--gold) }` — the
            // single loudest gold in the shell, and the reason the gold token exists. `goldFill`,
            // not BRAND.gold: this button has no border, so the fill's contrast with the column
            // behind it IS its edge, and the literal is a cross-theme constant that disappears on
            // light mode's concierge surface. The themed pair keeps the prototype's gold in dark
            // and goes deep gold + light ink in light, so the button reads as a button in both.
            color: ON_GOLD_FILL,
            background: C.goldFill,
            border: "none",
            borderRadius: 12,
            padding: "10px 15px",
            cursor: canSend ? "pointer" : "default",
            opacity: canSend ? 1 : 0.45,
            height: 42,
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
