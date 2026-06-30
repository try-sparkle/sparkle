import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { C, CHAT_USER_BUBBLE, FONT_WEIGHT, ON_BRAND_FILL } from "../theme/colors";
import { submitPrompt, writePty } from "../pty";
import { SuggestionRow } from "./composer/SuggestionRow";
import { useSuggestions } from "../services/suggestions/useSuggestions";
import { deriveContextTags } from "../services/suggestions/contextTags";
import { getAgentScrollback } from "../services/terminalScrollback";
import { useSuggestionStore } from "../stores/suggestionStore";
import { closeBuildAgent } from "../services/closeBuildAgent";
import { parseControlAction, CLOSE_AGENT_ACTION } from "../services/suggestions/controlButtons";
import type { SuggestionButton } from "../services/suggestions/types";
import { trialSendAllowed, recordTrialSend } from "../services/trialMeter";
import { safeUnlisten } from "../services/safeUnlisten";
import { captureScreenRegion } from "../screenshot";
import { AttachmentRow } from "./composer/AttachmentRow";
import {
  buildSendPayload,
  buildDisplay,
  countLines,
  shouldPasteAsPill,
  type Attachment,
  type TextBlock,
} from "./composer/attachments";
import {
  loadAttachment,
  screenshotAttachment,
  nextId,
} from "./composer/attachmentsApi";
import {
  useUiStore,
  COMPOSER_MIN,
  COMPOSER_MIN_TEXTAREA,
  COMPOSER_SNAP,
  COMPOSER_DEFAULT,
  COMPOSER_BAR,
  COMPOSER_SNAP_THRESHOLD,
  COMPOSER_MINIMIZE_THRESHOLD,
  COMPOSER_RESTORE_THRESHOLD,
} from "../stores/uiStore";
import { usePromptHistoryStore, computeGhost } from "../stores/promptHistoryStore";
import {
  resolveComposerDrag,
  resolveComposerFloor,
  resolveComposerRenderHeight,
  resolveComposerReset,
  shouldRestoreFromBar,
} from "./composerDrag";
import { isComposerToggleKey } from "./composerToggle";
import { arrowOverflowDirection } from "./composerArrowOverflow";
import { useDictationStore } from "../stores/dictationStore";
import {
  STOP_PHRASE,
  MIC_HOT_PREFIX,
  MIC_HOT_SUFFIX,
  MIC_HOT_PLACEHOLDER,
  WAKE_PHRASE,
  WAKE_PREFIX,
  WAKE_SUFFIX,
  WAKE_PLACEHOLDER,
} from "../voice/dictationCopy";
import { log } from "../logger";

const maxComposerHeight = () => Math.max(COMPOSER_MIN, window.innerHeight - 140);

// Mic-hot ("audio is active") copy lives in voice/dictationCopy.ts so the Think composer reads
// the exact same wording (single source of truth). The overlay below paints STOP_PHRASE as a
// gradient; the native-textarea fallback reuses MIC_HOT_PLACEHOLDER verbatim.

/** The stop phrase ("Sparkle, stop") in solid brand blue (C.teal #2f6bff), matching the
 *  "Hey Sparkle" phrase. (The cyan→blue gradient fade was dropped per design feedback.) */
function StopPhrase() {
  return (
    <span style={{ fontWeight: FONT_WEIGHT.bold, color: C.teal }}>{STOP_PHRASE}</span>
  );
}

/** Simple camera glyph for the screen-capture button. Inherits color via currentColor. */
function CameraIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2L8 5h8l1.5 2h2A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
      <circle cx="12" cy="13" r="3.2" />
    </svg>
  );
}

/**
 * Imperative handle the parent uses to push text into the composer (e.g. "Send to Composer"
 * from the pinned-prompt history). `insertPrompt` is replace-only-if-empty: it sets the box to
 * `text` when empty, otherwise appends it on a new line — then un-minimizes and focuses.
 */
export interface ComposerApi {
  insertPrompt: (text: string) => void;
}

/**
 * The friendly prompt composer (spec §7). A real <textarea>, so Shift+arrow selection,
 * multi-line, and Cmd+A/C/V all work natively. ⏎ sends, ⇧⏎ inserts a newline. Send
 * injects into the PTY via bracketed paste, then (after a beat) a carriage return.
 *
 * The composer is a bottom overlay floating over the terminal. At rest it sits at the snap
 * height, covering Claude's terminal input line — so the user types here by default (that's
 * the gentle steer toward the box). The grab handle drags it taller for multi-line prompts,
 * or DOWN past the floor to MINIMIZE into a slim bar that exposes the terminal input for
 * answering Claude's menus directly. ⌘J toggles the two. Minimized state + height persist
 * globally (uiStore), so the choice sticks across every agent tab and across relaunch.
 * Because it overlays rather than shares the flex column, dragging never resizes the
 * terminal beneath it.
 */
export function Composer({
  agentId,
  active = true,
  disabled = false,
  inputRef,
  apiRef,
  onSubmitPrompt,
  onArrowOverflow,
  onEnterOverflow,
}: {
  agentId: string;
  // Only the visible pane's composer reacts to native file drops (panes stay mounted).
  active?: boolean;
  disabled?: boolean;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  // Imperative bridge so the parent can push text into the box (e.g. "Send to Composer").
  apiRef?: RefObject<ComposerApi | null>;
  // `display` is the transcript string (typed text + 📄/📷/📎 count markers) — recorded for
  // prompt history. `namingBasis` is the user's typed text ONLY (no attachment markers): the
  // basis for auto-naming. Empty when the message is attachments-only, in which case the parent
  // must not auto-name (the emoji-count markers must never reach the naming model).
  onSubmitPrompt: (display: string, namingBasis: string) => void;
  // Called when a vertical arrow runs off the edge of the text: Down off the last line, Up off
  // the first. Lets the parent hand focus (and the keypress) to the terminal so the user can
  // drive Claude's menus without clicking. Omit to keep arrows purely native.
  onArrowOverflow?: (dir: "up" | "down") => void;
  // Called when Enter is pressed while the composer is EMPTY: there's nothing to send, so hand
  // focus + a carriage return to the terminal to confirm whatever's highlighted there (e.g. the
  // menu option the user just arrowed to). Omit to keep Enter purely a (no-op) send.
  onEnterOverflow?: () => void;
}) {
  const [value, setValue] = useState("");
  // True while a native file (e.g. a log) is dragged over the window — drives the drop hint.
  const [dropActive, setDropActive] = useState(false);
  // While focused, the placeholder switches from the "Hey Sparkle" voice prompt to a typing hint.
  const [focused, setFocused] = useState(false);
  // Mic hot ("audio is active") → the placeholder drops the wake-word prompt and invites the
  // user to just start talking, since Sparkle is already listening. Gate on the ACTUAL capture
  // state (status === "listening"), not the armed/mute intent (`enabled`): `enabled` stays true
  // while capture is focus-paused, so keying off it falsely claims "I'm listening" when nothing
  // is being captured. When armed but not actually listening we fall back to the wake-word copy.
  const audioActive = useDictationStore((s) => s.status === "listening");
  // Capture being live is NOT the same as actively dictating. Split the mic-hot copy by PHASE so
  // the composer tells the truth: only the "active" phase (wake word heard) gets the "I'm
  // listening, say Sparkle, stop" copy; the "passive" phase (still waiting for "Hey Sparkle")
  // gets the wake-word copy that mirrors the sidebar. Bug fixed: previously ANY live capture
  // showed the active copy, so a passive (wake-word) session falsely read as "I'm listening".
  const phase = useDictationStore((s) => s.phase);
  const liveActive = audioActive && phase === "active";
  const livePassive = audioActive && phase === "passive";

  // Inline ghost-text autocomplete. `history` is the global list of past prompts; `caretAtEnd`
  // gates the suggestion so it only appears when the caret is at the very end of the text
  // (never while editing mid-line). The ghost is the suffix of the most recent past prompt
  // that starts with what's typed — accept the whole thing with → or Tab.
  const history = usePromptHistoryStore((s) => s.history);
  const recordPrompt = usePromptHistoryStore((s) => s.record);
  const [caretAtEnd, setCaretAtEnd] = useState(true);
  // Escape dismisses the current ghost so a keyboard-only user can Tab out of the composer
  // without first accepting the suggestion (Tab otherwise accepts). Reset on the next edit so
  // typing more brings suggestions back.
  const [ghostDismissed, setGhostDismissed] = useState(false);
  // Live cloud-dictation preview (Deepgram interim results). While speech is streaming we show
  // the in-progress phrase as muted/italic text trailing the committed text — the real-time
  // word-by-word feel — and suppress the autocomplete ghost so the two don't fight for the slot.
  // The subscription itself is gated on this being the active, enabled pane — the SAME scope that
  // routes committed dictated text (registerInsert below) — so interim churn (several frames/sec)
  // never re-renders other mounted/hidden panes, and the preview never leaks into them.
  const interim = useDictationStore((s) => (active && !disabled ? s.interim : ""));
  const interimActive = !!interim;
  const ghost = caretAtEnd && !ghostDismissed && !interimActive ? computeGhost(value, history) : "";
  // The interim phrase is the whole thing being spoken now; render it after the committed text.
  const interimSuffix = interimActive ? `${value && !value.endsWith(" ") ? " " : ""}${interim}` : "";
  // Backing mirror behind the textarea, used to paint the ghost suffix (see render).
  const ghostRef = useRef<HTMLDivElement | null>(null);

  // When this composer is the visible/active pane, make it the target for
  // wake-word dictation. Only the visible pane registers (one at a time), so
  // dictation never leaks into another agent's input.
  useEffect(() => {
    if (!active || disabled) return;
    const append = (text: string) => {
      // Insert the transcribed text at the user's caret, not the end. Resolve which caret to use:
      //  1. If the textarea is focused right now, use its live selection.
      //  2. Otherwise use the last caret the user placed while it WAS focused (lastCaretRef) — the
      //     common flow is to click into the box to position the caret, then talk, by which point
      //     the mic/voice UI has taken focus. The previous code required CURRENT focus and so fell
      //     back to end-append here, which is why dictation kept landing at the bottom.
      //  3. Only when no caret has ever been placed (never clicked in) do we append at the end, so
      //     we never silently prepend at offset 0.
      const ta = taRef.current;
      const focused = ta != null && document.activeElement === ta;
      const stored = lastCaretRef.current;
      const useCaret = focused || stored != null;
      const rawS = focused ? ta?.selectionStart ?? 0 : stored?.start ?? 0;
      const rawE = focused ? ta?.selectionEnd ?? 0 : stored?.end ?? 0;

      // Compute the new caret offset as a side effect of the functional updater (so the fallback
      // path splices into the freshest value, never a stale closure capture).
      let caret = 0;
      setValue((v) => {
        if (!useCaret) {
          const next = v ? `${v} ${text}` : text;
          caret = next.length;
          return next;
        }
        // A stored caret was measured against an earlier value — clamp it to the current length.
        const s = Math.min(rawS, v.length);
        const e = Math.min(rawE, v.length);
        const before = v.slice(0, s);
        const after = v.slice(e);
        // Keep the existing one-space separation, but applied at the caret rather than the end —
        // and only where it's actually needed, so we never produce a double space or a leading one.
        const lead = before.length > 0 && !before.endsWith(" ") ? " " : "";
        const trail = after.length > 0 && !after.startsWith(" ") ? " " : "";
        const inserted = `${lead}${text}${trail}`;
        // Drop the caret at the END of the just-inserted text (before any trailing space).
        caret = before.length + lead.length + text.length;
        return `${before}${inserted}${after}`;
      });
      setMinimized(false); // dictated text lands in the box — make sure it's visible
      inputRef?.current?.focus();
      // Selection must be set after React commits the new value, or it snaps back. Mirror the
      // exact rAF pattern acceptGhost uses (and re-sync the ghost mirror's scrollTop, since moving
      // the caret can scroll the textarea programmatically without firing onScroll).
      requestAnimationFrame(() => {
        const t = taRef.current;
        if (t) {
          t.selectionStart = t.selectionEnd = caret;
          if (ghostRef.current) ghostRef.current.scrollTop = t.scrollTop;
        }
        // Advance the remembered caret to just past this insert, so a follow-on dictation chunk
        // continues forward (rather than re-inserting at the same spot and reversing the words)
        // even if focus never returns to the box.
        lastCaretRef.current = { start: caret, end: caret };
      });
    };
    useDictationStore.getState().registerInsert(append);
    return () => {
      // Only clear if we're still the registered target (avoid clobbering a newer pane).
      const store = useDictationStore.getState();
      if (store.insertTarget === append) store.registerInsert(null);
    };
  }, [active, disabled, inputRef]);

  // Files riding along with the next message — screenshots and dropped images/files.
  // On send their paths are prefixed to the text so the Claude Code CLI reads each from
  // disk. Rendered as selectable tiles in the AttachmentRow above the textarea.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Large pastes collapsed into clickable pills (rather than flooding the textarea).
  // Their full text is expanded inline into the payload on send.
  const [textBlocks, setTextBlocks] = useState<TextBlock[]>([]);
  // Suggested action buttons (heuristic direct-answers + Haiku-learned next-actions). The row is
  // only shown when the box is empty and the user isn't typing or dictating — see suggestionsVisible.
  const composerEmptyNow = !value.trim() && attachments.length === 0 && textBlocks.length === 0;
  const {
    buttons: suggestionButtons,
    dismiss: dismissSuggestion,
    clear: clearSuggestions,
  } = useSuggestions(agentId, composerEmptyNow);
  const [capturing, setCapturing] = useState(false);
  const height = useUiStore((s) => s.composerHeight);
  const setComposerHeight = useUiStore((s) => s.setComposerHeight);
  const minimized = useUiStore((s) => s.composerMinimized);
  const setMinimized = useUiStore((s) => s.setComposerMinimized);
  const userSized = useUiStore((s) => s.composerUserSized);
  const setComposerUserSized = useUiStore((s) => s.setComposerUserSized);
  const dragRef = useRef<{ startY: number; startH: number; startMin: boolean } | null>(null);

  // Expose insertPrompt to the parent (used by the pinned-prompt "Send to Composer" action).
  // Replace-only-if-empty: drop the prompt straight in when the box is empty, otherwise append
  // it on a new line so an in-progress draft isn't clobbered. Then surface + focus the box.
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      insertPrompt: (text: string) => {
        setValue((v) => (v.trim() ? `${v}${v.endsWith("\n") ? "" : "\n"}${text}` : text));
        setGhostDismissed(true); // the inserted text isn't a typed prefix — don't ghost off it
        setMinimized(false);
        requestAnimationFrame(() => inputRef?.current?.focus());
      },
    };
    return () => {
      if (apiRef) apiRef.current = null;
    };
  }, [apiRef, inputRef, setMinimized]);

  // Snap the composer back to its regular rest height and drop any manual sizing — used right
  // after a send and when a brand-new thread's composer mounts, so a long message (or a
  // previously dragged size leaking in via the shared store) never leaves the box stuck tall.
  // A fully minimized composer is the one exception: that's a deliberate "keep it tucked away"
  // choice, so resolveComposerReset returns null and we leave the slim bar exactly as it is.
  const resetComposerSize = useCallback(() => {
    const reset = resolveComposerReset({
      minimized: useUiStore.getState().composerMinimized,
      rest: COMPOSER_DEFAULT,
    });
    if (!reset) return;
    setComposerHeight(reset.height);
    setComposerUserSized(reset.userSized);
  }, [setComposerHeight, setComposerUserSized]);

  // On mount the composer belongs to a freshly started thread (panes stay mounted, so this fires
  // once per new thread, never on a tab switch). Start it at the rest height — unless minimized,
  // which we honor — via useLayoutEffect so a stale tall height never flashes before first paint.
  useLayoutEffect(() => {
    resetComposerSize();
  }, [resetComposerSize]);

  // The composer auto-grows upward to fit the typed message. `height` (the persisted,
  // drag-set height) is the floor; content can push the composer taller up to the cap.
  // We keep this in a separate value (not the persisted store) so a long one-off message
  // doesn't permanently resize the composer.
  const [autoHeight, setAutoHeight] = useState(height);
  const containerRef = useRef<HTMLDivElement>(null);
  // Always hold a local handle to the textarea for measuring, while still honoring the
  // optional inputRef the parent passes in (used for focus + insert()).
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const setTaRef = (el: HTMLTextAreaElement | null) => {
    taRef.current = el;
    if (inputRef) inputRef.current = el;
  };
  // The last caret position the user placed in the textarea WHILE it was focused. Kept so
  // wake-word dictation can insert at that spot even after focus has since left the box (the
  // common flow: click to place the caret, then talk — by which point the mic/voice UI may
  // hold focus). `null` = the user has never placed a caret, so dictation appends at the end.
  const lastCaretRef = useRef<{ start: number; end: number } | null>(null);

  // Measure the textarea's intrinsic content height and size the composer to fit it,
  // clamped to [drag-set floor, viewport cap]. Held in a ref so the resize listener
  // (registered once below) always calls the latest measurement closure.
  const recomputeHeightRef = useRef<() => void>(() => {});
  // Runs before paint (no flicker) on every change that affects the content or chrome.
  useLayoutEffect(() => {
    recomputeHeightRef.current = () => {
      const ta = taRef.current;
      const container = containerRef.current;
      if (!ta || !container) return;
      // Overhead = everything that isn't the textarea (handle, padding, attachment thumbs,
      // status rows, the send/mic/camera buttons). We read it by DIFFERENCE (container minus
      // textarea), which is only valid when the container is sized to its content — but the
      // container is rendered at a FIXED `height: autoHeight`. So when a tall attachment row is
      // added it squeezes the (flex:1, minHeight:0) textarea inside that fixed box, and reading
      // container.offsetHeight here would report the stale pre-grow height instead of the chrome
      // the content now needs — the box then fails to grow and the thumbnail overlaps the input
      // (the reported drop-a-screenshot bug). Drop the fixed height for the measurement so the
      // container lays out to its natural content height, making the difference the true chrome.
      //
      // Read the natural content height free of the flex stretch too. The textarea is a child of a
      // `display:flex` wrapper whose direction is the default `row`, so the textarea's CROSS axis
      // (the one pinned by `align-items: stretch`) is VERTICAL and its MAIN axis is HORIZONTAL
      // (width). To collapse the height to content we opt out of the cross-axis stretch —
      // `align-self:flex-start` + `height:"auto"` — which lets scrollHeight report the real content
      // height instead of the stretched height, and lets the container (now height:auto) shrink-wrap.
      //
      // We must NOT touch `flex` here. `flex` sizes the MAIN (horizontal) axis: setting
      // `flex:"0 0 auto"` collapses the textarea's WIDTH to its intrinsic `cols`-based width (~20
      // chars), which re-wraps the draft into many more lines and INFLATES scrollHeight — so the box
      // grew to multiples of the real text, worst on dictation (long appended runs). An empty/1-row
      // draft hid this (one line measures the same at any width), so it only bit once text wrapped.
      // Leaving `flex:1` keeps the measured width equal to the rendered width, so wrapping matches.
      const prevContainerHeight = container.style.height;
      const prevHeight = ta.style.height;
      const prevAlignSelf = ta.style.alignSelf;
      container.style.height = "auto";
      ta.style.alignSelf = "flex-start";
      ta.style.height = "auto";
      // LOAD-BEARING ORDER: this scrollHeight read is the reflow trigger that flushes the three
      // style writes above, so the offsetHeight reads that follow see the shrink-wrapped layout
      // (not a stale one). Keep it first — moving a style write below this read would silently
      // reintroduce a stale-layout measurement.
      const contentH = ta.scrollHeight; // content + vertical padding (no border)
      const borderY = ta.offsetHeight - ta.clientHeight; // textarea border (client excludes it)
      // True chrome: with the container shrink-wrapped and the textarea at one row, everything
      // that isn't the textarea is the overhead — independent of any prior squeeze.
      const overhead = container.offsetHeight - ta.offsetHeight;
      ta.style.height = prevHeight;
      ta.style.alignSelf = prevAlignSelf;
      container.style.height = prevContainerHeight;
      const desired = overhead + contentH + borderY;
      // Attachment thumbnails eat a fixed row above the textarea; raise the height floor so they
      // can't squeeze the input to a sliver (overhead already includes the thumb row). Without
      // attachments this is just COMPOSER_MIN, so the drag-down behavior is unchanged.
      const min = resolveComposerFloor({
        baseMin: COMPOSER_MIN,
        overhead,
        minTextarea: COMPOSER_MIN_TEXTAREA,
        hasAttachments: attachments.length > 0,
      });
      // Once the user has hand-sized the composer, `height` IS the rendered height (the draft
      // scrolls past it) — so the handle can drag it shorter than its content. Until then the
      // composer auto-grows from the rest height to fit the draft. (Pure policy in composerDrag.)
      const next = resolveComposerRenderHeight({
        height,
        desired,
        userSized,
        min,
        cap: maxComposerHeight(),
      });
      setAutoHeight(next);
    };
    recomputeHeightRef.current();
    // `minimized` is a dep so autoHeight re-measures on restore: while minimized the textarea is
    // unmounted and the measurement early-returns (autoHeight freezes), so without this a
    // minimize→restore that changes nothing else would show the stale pre-minimize height.
    // `userSized` is a dep so toggling manual control re-resolves the height immediately.
  }, [value, height, attachments.length, textBlocks.length, minimized, userSized]);

  // The viewport cap depends on window height — re-measure on resize. Registered once.
  useEffect(() => {
    const onResize = () => recomputeHeightRef.current();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // A persisted/oversized height could bury the terminal on a smaller window — re-clamp to
  // the viewport on mount AND whenever the window resizes (read latest height from the
  // store to avoid a stale closure).
  useEffect(() => {
    const clamp = () => {
      const max = maxComposerHeight();
      if (useUiStore.getState().composerHeight > max) setComposerHeight(max);
    };
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [setComposerHeight]);

  // Once the PTY is live, pull focus into the composer so the user types here, not the
  // terminal underneath — unless it's minimized (then the terminal owns focus; see AgentPane).
  useEffect(() => {
    if (!disabled && !minimized) inputRef?.current?.focus();
  }, [disabled, inputRef, minimized]);

  // Native file drag-and-drop: drag a file (image or otherwise) onto the active composer
  // and it becomes a tile above the textarea — image files preview as a thumbnail, others
  // show as a file chip. The tile carries the file's absolute path, prefixed to the message
  // on send so the agent reads it straight from disk (same trick as screenshot attachments).
  // Tauri's webview drag-drop event carries real filesystem paths; a plain HTML5 drop in a
  // sandboxed webview does not. Only the visible pane listens (others stay mounted).
  useEffect(() => {
    if (!active) return;
    const unlistenPromise = getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          setDropActive(true);
        } else if (p.type === "leave") {
          setDropActive(false);
        } else if (p.type === "drop") {
          setDropActive(false);
          const paths = p.paths ?? [];
          if (paths.length === 0) return;
          log.info("composer", `dropped ${paths.length} file(s) into chat`, paths);
          setMinimized(false); // surface the box so the new tiles are visible
          inputRef?.current?.focus();
          // Load each dropped file into an attachment tile (images get a preview), then
          // append them in drop order — loads resolve at different speeds, so collect them
          // before appending rather than racing. A failed load is logged and skipped.
          void Promise.all(
            paths.map((path) =>
              loadAttachment(path).catch((e) => {
                log.error("composer", "load dropped file failed", { path, e });
                return null;
              }),
            ),
          ).then((loaded) => {
            const ok = loaded.filter((a): a is Attachment => a !== null);
            if (ok.length) setAttachments((prev) => [...prev, ...ok]);
          });
        }
      })
      .catch((e) => {
        // A failed listen has no unlisten fn to return; log and let cleanup no-op.
        log.error("composer", "drag-drop listen failed", e);
        return undefined;
      });
    return () => {
      setDropActive(false);
      // safeUnlisten awaits the listen() promise so a handler that resolves AFTER unmount is still
      // torn down (and the Tauri teardown race is swallowed).
      void safeUnlisten(unlistenPromise);
    };
  }, [active, inputRef, setMinimized]);

  // Open the native macOS crosshair picker and stash the result as a thumbnail.
  // Esc (cancel) resolves null — a quiet no-op. While the picker is up the call
  // blocks in Rust; `capturing` flips the button to a spinner.
  const capture = async () => {
    if (capturing) return;
    setCapturing(true);
    try {
      const shot = await captureScreenRegion();
      if (shot) {
        setAttachments((prev) => [...prev, screenshotAttachment(shot.path, shot.dataUrl)]);
      }
    } catch (err) {
      console.error("screen capture failed", err);
    } finally {
      setCapturing(false);
    }
  };

  const removeAttachment = (id: string) =>
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  const removeTextBlock = (id: string) =>
    setTextBlocks((prev) => prev.filter((b) => b.id !== id));

  // A large paste collapses into a pill instead of flooding the textarea. The threshold is
  // "more than five lines" (see shouldPasteAsPill). Shorter pastes fall through to the
  // textarea's native insert. "Show as regular text" (from the pill modal) reverses this by
  // appending the block's raw text back into the box and dropping the pill.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData("text/plain");
    if (!shouldPasteAsPill(text)) return; // native paste
    e.preventDefault();
    setTextBlocks((prev) => [
      ...prev,
      { id: nextId("blk"), text, lineCount: countLines(text) },
    ]);
  };

  const showBlockAsText = (block: TextBlock) => {
    setValue((v) => (v ? `${v}${v.endsWith("\n") ? "" : "\n"}${block.text}` : block.text));
    removeTextBlock(block.id);
    inputRef?.current?.focus();
  };

  // Single source of truth for "is there nothing to send?" — used by both send()'s own gate and
  // the Enter hand-off below, so the two definitions of "empty" can never drift apart.
  const isComposerEmpty = () =>
    !value.trim() && attachments.length === 0 && textBlocks.length === 0;

  // Shared delivery for both typed sends and prompt-kind suggestion clicks, so the trial/delivery
  // bookkeeping (payload/display build → parent callback → PTY → ghost-history → trial meter) can
  // never drift between the two paths. `typed` is the raw (untrimmed) text; naming/history use the
  // trimmed form. Callers are responsible for the trial-cap gate + clearing the box.
  const deliverPrompt = async (typed: string, atts: Attachment[], blocks: TextBlock[]) => {
    const payload = buildSendPayload({ attachments: atts, textBlocks: blocks, typed });
    const display = buildDisplay({ attachments: atts, textBlocks: blocks, typed });
    const naming = typed.trim();
    // Remember the typed text (not the attachment-annotated display) so it can be offered as a
    // ghost-text suggestion next time — clicked prompts feed this exactly like typed ones.
    if (naming) recordPrompt(naming);
    // Pass the typed text as the naming basis, separate from the marker-decorated `display`.
    // Attachments-only sends carry an empty basis, so auto-naming is skipped.
    onSubmitPrompt(display, naming);
    await submitPrompt(agentId, payload);
    // Consume a trial prompt only now that it's actually delivered (no-op for entitled users).
    void recordTrialSend();
  };

  const send = async () => {
    if (disabled) return; // PTY not spawned yet — don't drop the prompt
    const typed = value;
    const text = value.trim();
    const atts = attachments;
    const blocks = textBlocks;
    if (isComposerEmpty()) return;
    // Free-trial cap (checked BEFORE delivery, consumed AFTER): block once the 100 are spent.
    // Entitled users always pass. When blocked, AuthGate's TrialChrome overlay is already
    // visible (it shows whenever promptsUsed ≥ limit), so this is defense-in-depth, not a
    // silent dead-end.
    if (!trialSendAllowed()) return;
    setValue("");
    setAttachments([]);
    setTextBlocks([]);
    // The draft is gone — snap the box back to its regular rest height so a long message doesn't
    // leave it sitting tall (clears any manual sizing too). Send is unreachable while minimized,
    // so this never fights the keep-minimized exception.
    resetComposerSize();
    log.info("composer", "send prompt", {
      agentId,
      chars: text.length,
      attachments: atts.length,
      textBlocks: blocks.length,
    });
    await deliverPrompt(typed, atts, blocks);
    // Learn from a real typed action so the suggestion history reflects what the user actually
    // does in this terminal state. Only log when suggestions were on offer (the agent is waiting
    // on the user) so ordinary mid-turn messages don't pollute the history.
    if (text && suggestionButtons.length > 0) {
      useSuggestionStore.getState().recordEvent({
        contextTags: deriveContextTags(getAgentScrollback(agentId) ?? ""),
        label: text.slice(0, 40),
        value: text,
        kind: "prompt",
      });
    }
  };

  // Send a suggestion button's action immediately (one click). Terminal-kind buttons inject raw
  // keystrokes straight into the PTY (y/n, numbered choices); prompt-kind buttons go through the
  // normal message path as if the user had typed and sent them; control-kind buttons run an app
  // action (e.g. close this build agent). Then learn from the action and clear the row.
  const onSuggestionClick = async (b: SuggestionButton) => {
    if (b.kind === "control") {
      // Control buttons touch nothing in the PTY and aren't a learnable "action", so they don't
      // record to history and aren't gated by `disabled` (PTY not spawned). Route by action id.
      const action = parseControlAction(b.value);
      if (action === CLOSE_AGENT_ACTION) await closeBuildAgent(agentId);
      clearSuggestions();
      return;
    }
    if (disabled) return;
    if (b.kind === "terminal") {
      // Terminal-kind buttons come ONLY from the local heuristic detector and carry a bare control
      // keystroke (y/n, a menu digit) — interactive terminal input, not a metered "send". So they
      // intentionally bypass the trial-cap gate, exactly like typing into the terminal directly.
      await writePty(agentId, b.value);
    } else {
      if (!trialSendAllowed()) return;
      await deliverPrompt(b.value, [], []);
    }
    useSuggestionStore.getState().recordEvent({
      contextTags: deriveContextTags(getAgentScrollback(agentId) ?? ""),
      label: b.label,
      value: b.value,
      kind: b.kind,
    });
    clearSuggestions();
  };

  // Accept the ghost completion: replace the input with the full past prompt and drop the
  // caret at the end. Only reachable when a ghost is showing (which implies caret-at-end).
  const acceptGhost = () => {
    const full = value + ghost;
    setValue(full);
    setCaretAtEnd(true);
    // Selection must be set after React commits the new value, or it snaps back. Re-sync the
    // mirror's scroll too: moving the caret to the end can scroll the textarea programmatically
    // without firing onScroll, which would briefly misalign the painted text on long inputs.
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.selectionStart = ta.selectionEnd = full.length;
        if (ghostRef.current) ghostRef.current.scrollTop = ta.scrollTop;
      }
    });
  };

  // Keep `caretAtEnd` in sync with the real caret so the ghost hides the moment the user
  // moves into the middle of the text (arrow-left, click, select) and returns when at the end.
  const syncCaret = () => {
    const ta = taRef.current;
    if (!ta) return;
    setCaretAtEnd(ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length);
    // Remember where the caret is while the box is focused, so dictation that arrives after focus
    // has moved away (mic/voice UI) still inserts at the user's last position rather than the end.
    if (document.activeElement === ta) {
      lastCaretRef.current = { start: ta.selectionStart, end: ta.selectionEnd };
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposerToggleKey(e)) {
      // ⌘J: tuck the composer away and hand focus to the terminal (AgentPane moves it).
      e.preventDefault();
      setMinimized(true);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // Empty composer → there's nothing to send. Instead of a dead keypress, forward Enter to the
      // terminal so it confirms the highlighted choice in Claude's menu (mirrors onArrowOverflow:
      // arrows move the highlight, Enter picks it). Skip while an IME composition is committing.
      // Emptiness matches send()'s own gate via the shared isComposerEmpty() helper.
      if (isComposerEmpty() && onEnterOverflow && !e.nativeEvent.isComposing) {
        onEnterOverflow();
        return;
      }
      void send();
      return;
    }
    // → or Tab accepts the ghost when one is showing. At end-of-text → is otherwise a no-op,
    // and Tab is repurposed as accept (the user's choice) — Escape dismisses the ghost first
    // to free Tab for focus movement when needed. Shift+Tab is left alone so backward focus
    // traversal still works. Skip while an IME composition is active, so a →/Tab that commits
    // a CJK candidate isn't hijacked into accepting the ghost.
    if (
      ghost &&
      !e.nativeEvent.isComposing &&
      (e.key === "ArrowRight" || (e.key === "Tab" && !e.shiftKey))
    ) {
      e.preventDefault();
      acceptGhost();
      return;
    }
    // Escape dismisses the visible ghost (without clearing the input) so Tab can move focus.
    // Consume the event (stopPropagation) so dismissing the ghost doesn't also fire an
    // ancestor/global Escape handler in the same keystroke — Escape's effect stays predictable.
    if (ghost && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setGhostDismissed(true);
    }
    // A vertical arrow that runs off the edge of the text crosses into the terminal: Down off
    // the last line, Up off the first. Inside the text it stays native (move the caret a line),
    // so multi-line editing is unaffected — only the overflow press hands off. The edge logic
    // (modifiers, selection, IME, line position) lives in arrowOverflowDirection so it's unit-
    // tested; here we just act on its verdict.
    if (onArrowOverflow && taRef.current) {
      const ta = taRef.current;
      const dir = arrowOverflowDirection({
        key: e.key,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        isComposing: e.nativeEvent.isComposing,
        ghostActive: ghost !== "",
        value: ta.value,
        selectionStart: ta.selectionStart,
        selectionEnd: ta.selectionEnd,
      });
      if (dir) {
        e.preventDefault();
        onArrowOverflow(dir);
        return;
      }
    }
  };

  // Pointer-capture keeps move/up events scoped to the handle element, so they're cleaned
  // up automatically if the component unmounts mid-drag (no leaked window listeners). The
  // handle is a SINGLE element rendered in both the open and minimized states (below), so
  // capture survives the minimize/restore transition — the drag stays smooth across it.
  const onHandleDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    // Base the drag on the height actually on screen (which may be auto-expanded above the
    // stored floor), so the handle tracks the cursor from the first pixel instead of having
    // to close the auto-expand gap first.
    dragRef.current = { startY: e.clientY, startH: autoHeight, startMin: minimized };
  };
  const onHandleMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const r = resolveComposerDrag(
      { startHeight: d.startH, startMinimized: d.startMin, dy: d.startY - e.clientY, floor: height },
      {
        snap: COMPOSER_SNAP,
        min: COMPOSER_MIN,
        max: maxComposerHeight(),
        snapThreshold: COMPOSER_SNAP_THRESHOLD,
        minimizeThreshold: COMPOSER_MINIMIZE_THRESHOLD,
        restoreThreshold: COMPOSER_RESTORE_THRESHOLD,
      },
    );
    setComposerHeight(r.height);
    setMinimized(r.minimized);
    // A resize drag (not a minimize) hands manual control to the user, so the dragged height
    // becomes the composer's actual height — letting them size it DOWN past the content. Landing
    // back on the snap rest clears that, re-enabling auto-grow. Minimize drags don't touch the
    // flag, so a minimize→restore returns to whatever mode the composer was in.
    // The equality is exact because withSnap() (composerDrag.ts) returns precisely COMPOSER_SNAP
    // inside the magnet range. Guard the write so we only touch the persisted store when the
    // mode actually flips, not on every move frame of the drag.
    if (!r.minimized) {
      const nextSized = r.height !== COMPOSER_SNAP;
      if (nextSized !== userSized) setComposerUserSized(nextSized);
    }
  };
  const onHandleUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    // pointercancel is an aborted gesture, not a release — clean up but never restore on it.
    if (!d || e.type !== "pointerup") return;
    // From the minimized bar, a click or any upward release brings the composer back —
    // including the sub-threshold drag the snap math intentionally leaves minimized, so there's
    // no dead zone. Restore just flips the flag: the remembered open height is already in the
    // store (so a tall composer comes back tall). A downward tug stays minimized.
    if (
      shouldRestoreFromBar({
        startMinimized: d.startMin,
        dy: d.startY - e.clientY,
        stillMinimized: useUiStore.getState().composerMinimized,
      })
    ) {
      setMinimized(false);
    }
  };

  // The default placeholder is rendered as a styled overlay (so "Hey Sparkle" can be bold +
  // blue, which a native textarea placeholder can't do). Only show it in the clean empty state
  // where the textarea sits at the top of its column, so the overlay lines up with row one.
  // `!interimActive` is essential: a live cloud-dictation preview paints into the SAME top-left
  // slot (via the ghost mirror) while `value` is still empty, so without this gate the overlay
  // would render on top of the streaming words and the two would overlap into garbled text.
  const showRichPlaceholder =
    !value &&
    !interimActive &&
    !disabled &&
    !dropActive &&
    attachments.length === 0 &&
    textBlocks.length === 0;

  // The composer is one overlay in two states. Minimized → it collapses to the slim handle
  // bar, exposing the terminal input; otherwise the handle sits atop the full message box.
  // The handle (the drag target / pointer-capture owner) is the SAME element in both states,
  // so a drag that crosses the minimize/restore line never loses its capture.
  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: minimized ? COMPOSER_BAR : autoHeight,
        zIndex: 5,
        display: "flex",
        flexDirection: "column",
        // Minimized → no chrome: the strip is transparent so only the little gradient pull tab
        // floats over the exposed terminal. Open → the solid message-box surface with its top rule.
        background: minimized ? "transparent" : C.forest,
        borderTop: minimized ? "none" : `1px solid ${C.deepForest}`,
      }}
    >
      {/* Persistent grab handle: open → thin pill (drag up taller, down to minimize); minimized
          → a little gradient pull tab (click or drag up to bring the message box back). ⌘J also toggles. */}
      <div
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
        title={
          minimized
            ? "Click or drag up to bring back the prompt box (⌘J)"
            : "Drag to resize · drag down to minimize (⌘J)"
        }
        style={{
          height: minimized ? COMPOSER_BAR : 10,
          flex: "0 0 auto",
          display: "flex",
          // Minimized: anchor the pull tab to the very bottom edge so its rounded top reads as a
          // tab rising out of the window. Open: center the thin grab pill in the handle strip.
          alignItems: minimized ? "flex-end" : "center",
          justifyContent: "center",
          gap: 6,
          cursor: "ns-resize",
          color: C.muted,
          fontFamily: '"IBM Plex Sans", sans-serif',
          fontSize: 12,
          userSelect: "none",
        }}
      >
        {minimized ? (
          // A little gradient pull tab carrying the Sparkle logo's shading (lighter teal → darker
          // blue) and an upward caret, inviting the user back into the modern voice-enabled box.
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 16px",
              // Rounded only on top: the flat bottom meets the window edge, so it reads as a tab.
              borderRadius: "9px 9px 0 0",
              background: `linear-gradient(180deg, ${C.accent} 0%, ${C.teal} 100%)`,
              color: ON_BRAND_FILL,
              fontWeight: FONT_WEIGHT.semibold,
              fontSize: 12,
              lineHeight: 1.2,
              whiteSpace: "nowrap",
              boxShadow: "0 -1px 6px rgba(0,0,0,0.28)",
            }}
          >
            <span style={{ fontSize: 10 }}>▴</span>
            <span>Use the modern prompt box with voice</span>
          </div>
        ) : (
          <div style={{ width: 36, height: 3, borderRadius: 2, background: C.muted, opacity: 0.6 }} />
        )}
      </div>

      {!minimized && (
      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 8, padding: "0 10px 10px", alignItems: "stretch" }}>
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 6, position: "relative" }}>
          <AttachmentRow
            textBlocks={textBlocks}
            attachments={attachments}
            onRemoveTextBlock={removeTextBlock}
            onRemoveAttachment={removeAttachment}
            onShowAsText={showBlockAsText}
          />
          {/* The textarea and a mirror layer share one positioning context. The mirror sits
              behind a transparent-background textarea and re-renders the exact same text, but
              transparent — so only the trailing ghost suffix (painted muted) shows through.
              Because both boxes use identical font, padding, border width, and wrapping, the
              ghost lines up perfectly with the real caret, even across wrapped lines. */}
          <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex" }}>
            <div
              ref={ghostRef}
              aria-hidden="true"
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 0,
                overflow: "hidden",
                pointerEvents: "none",
                boxSizing: "border-box",
                background: C.deepForest,
                // Transparent border of the same width keeps the content box aligned with the
                // textarea's (whose visible border is painted on top).
                border: dropActive ? "1.5px solid transparent" : "1px solid transparent",
                borderRadius: 8,
                padding: "8px 10px",
                fontFamily: '"IBM Plex Sans", sans-serif',
                fontSize: 14,
                lineHeight: 1.4,
                whiteSpace: "pre-wrap",
                overflowWrap: "break-word",
                // Reserve the scrollbar gutter in both layers so the text content box width
                // matches even when the textarea overflows and shows a scrollbar — otherwise
                // lines would wrap at different points and the ghost would drift.
                scrollbarGutter: "stable",
                opacity: disabled ? 0.6 : 1,
              }}
            >
              <span style={{ color: "transparent" }}>{value}</span>
              <span style={{ color: C.muted, fontStyle: interimActive ? "italic" : "normal" }}>
                {ghost || interimSuffix}
              </span>
            </div>
            <textarea
              ref={setTaRef}
              // One row is the auto-grow baseline: when measuring (height:auto + align-self above),
              // an empty/single-line draft collapses to one line, so `desired` lands at the snap
              // rest height (COMPOSER_SNAP) rather than the textarea's 2-row default — that's what
              // lets a fresh or just-sent composer sit at its compact default. Flex drives the real
              // height the rest of the time, so `rows` only sets this measurement floor.
              rows={1}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setGhostDismissed(false); // a fresh edit re-enables suggestions
                syncCaret();
              }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onKeyUp={syncCaret}
              onSelect={syncCaret}
              onClick={syncCaret}
              onScroll={(e) => {
                if (ghostRef.current) ghostRef.current.scrollTop = e.currentTarget.scrollTop;
              }}
              // Swap to the typing hint on a real click, not on the mount auto-focus (which would
              // otherwise hide the "Hey Sparkle" voice prompt before the user ever interacts).
              onMouseDown={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              disabled={disabled}
              placeholder={
                dropActive
                  ? "Drop the file here to attach it…"
                  : disabled
                  ? "Starting your agent…"
                  : interimActive
                  ? "" // the live dictation preview occupies the slot — no placeholder
                  : showRichPlaceholder
                  ? "" // the styled overlay below renders this state's placeholder
                  : liveActive
                  ? MIC_HOT_PLACEHOLDER
                  : livePassive
                  ? WAKE_PLACEHOLDER
                  : "Just say Hey Sparkle and I'll start listening as you talk."
              }
              spellCheck={false}
              style={{
                position: "relative",
                zIndex: 1,
                flex: 1,
                minHeight: 0,
                resize: "none",
                boxSizing: "border-box",
                // Transparent so the mirror's ghost suffix shows through behind the real text.
                background: "transparent",
                color: C.cream,
                // Highlight the drop target while a file is dragged over the window.
                border: dropActive ? `1.5px dashed ${C.teal}` : `1px solid ${CHAT_USER_BUBBLE}`,
                borderRadius: 8,
                padding: "8px 10px",
                fontFamily: '"IBM Plex Sans", sans-serif',
                fontSize: 14,
                lineHeight: 1.4,
                // Match the mirror's long-token wrapping so a pasted URL/path breaks at the
                // same point in both layers and the ghost stays aligned with the caret.
                overflowWrap: "break-word",
                // Keep the scrollbar gutter reserved (mirror does the same) so the text width
                // is identical with or without a vertical scrollbar — no wrap drift.
                scrollbarGutter: "stable",
                outline: "none",
                opacity: disabled ? 0.6 : 1,
              }}
            />
          </div>
          {showRichPlaceholder && (
            // Styled stand-in for the native placeholder so "Hey Sparkle" can be bold + blue.
            // Aligned to the textarea's first text line (1px border + 8px/10px padding) and
            // click-through so it never blocks focusing the textarea underneath.
            <div
              aria-hidden
              style={{
                position: "absolute",
                top: 9,
                left: 11,
                right: 11,
                pointerEvents: "none",
                color: C.muted,
                fontFamily: '"IBM Plex Sans", sans-serif',
                fontSize: 14,
                lineHeight: 1.4,
              }}
            >
              {liveActive ? (
                // The mic-hot copy intentionally subsumes the typing hint ("…or start typing
                // here instead"), so it stays put on focus rather than swapping to the muted
                // focused hint below — that hint remains live only when the mic is muted.
                <>
                  {MIC_HOT_PREFIX}
                  <StopPhrase />
                  {MIC_HOT_SUFFIX}
                </>
              ) : livePassive ? (
                // Capturing but waiting for the wake word: tell the truth (not "I'm listening").
                // Mirrors the sidebar caption; the "(or you can type here instead)" tail subsumes
                // the typing hint, so like the mic-hot copy it stays put on focus.
                <>
                  {WAKE_PREFIX}
                  <span style={{ fontWeight: FONT_WEIGHT.bold, color: C.teal }}>{WAKE_PHRASE}</span>
                  {WAKE_SUFFIX}
                </>
              ) : focused ? (
                "…or type your command here (speaking is 3x faster)"
              ) : (
                <>
                  Just say{" "}
                  <span style={{ fontWeight: FONT_WEIGHT.bold, color: C.teal }}>Hey Sparkle</span>{" "}
                  and I&apos;ll start listening as you talk.
                </>
              )}
            </div>
          )}
        </div>
        <SuggestionRow
          buttons={suggestionButtons}
          visible={composerEmptyNow && !interimActive && !liveActive}
          onClick={(b) => void onSuggestionClick(b)}
          onDismiss={dismissSuggestion}
        />
        <button
          onClick={() => void capture()}
          disabled={disabled || capturing}
          title="Capture a region of your screen"
          style={{
            alignSelf: "flex-end",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 40,
            height: 40,
            background: "transparent",
            color: C.cream,
            border: `1.5px dashed ${C.muted}`,
            borderRadius: 8,
            cursor: disabled || capturing ? "not-allowed" : "pointer",
            opacity: disabled ? 0.6 : 1,
            padding: 0,
          }}
        >
          {capturing ? "…" : <CameraIcon />}
        </button>
        <button
          onClick={() => void send()}
          disabled={disabled}
          style={{
            alignSelf: "flex-end",
            background: C.teal,
            color: C.cream,
            border: "none",
            borderRadius: 8,
            padding: "9px 18px",
            fontWeight: FONT_WEIGHT.semibold,
            fontFamily: '"IBM Plex Sans", sans-serif',
            cursor: disabled ? "not-allowed" : "pointer",
            height: 40,
            opacity: disabled ? 0.6 : 1,
          }}
        >
          Send
        </button>
      </div>
      )}
    </div>
  );
}
