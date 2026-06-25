import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { C, CHAT_USER_BUBBLE, FONT_WEIGHT } from "../theme/colors";
import { submitPrompt } from "../pty";
import { captureScreenRegion, type Screenshot } from "../screenshot";
import {
  useUiStore,
  COMPOSER_MIN,
  COMPOSER_SNAP,
  COMPOSER_BAR,
  COMPOSER_SNAP_THRESHOLD,
  COMPOSER_MINIMIZE_THRESHOLD,
  COMPOSER_RESTORE_THRESHOLD,
} from "../stores/uiStore";
import { usePromptHistoryStore, computeGhost } from "../stores/promptHistoryStore";
import {
  resolveComposerDrag,
  resolveComposerRenderHeight,
  shouldRestoreFromBar,
} from "./composerDrag";
import { isComposerToggleKey } from "./composerToggle";
import { useDictationStore } from "../stores/dictationStore";
import { log } from "../logger";

const maxComposerHeight = () => Math.max(COMPOSER_MIN, window.innerHeight - 140);

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
  onSubmitPrompt,
}: {
  agentId: string;
  // Only the visible pane's composer reacts to native file drops (panes stay mounted).
  active?: boolean;
  disabled?: boolean;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  onSubmitPrompt: (text: string) => void;
}) {
  const [value, setValue] = useState("");
  // True while a native file (e.g. a log) is dragged over the window — drives the drop hint.
  const [dropActive, setDropActive] = useState(false);
  // While focused, the placeholder switches from the "Hey Sparkle" voice prompt to a typing hint.
  const [focused, setFocused] = useState(false);

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
  const ghost = caretAtEnd && !ghostDismissed ? computeGhost(value, history) : "";
  // Backing mirror behind the textarea, used to paint the ghost suffix (see render).
  const ghostRef = useRef<HTMLDivElement | null>(null);

  // When this composer is the visible/active pane, make it the target for
  // wake-word dictation. Only the visible pane registers (one at a time), so
  // dictation never leaks into another agent's input.
  useEffect(() => {
    if (!active || disabled) return;
    const append = (text: string) => {
      setValue((v) => (v ? `${v} ${text}` : text));
      setMinimized(false); // dictated text lands in the box — make sure it's visible
      inputRef?.current?.focus();
    };
    useDictationStore.getState().registerInsert(append);
    return () => {
      // Only clear if we're still the registered target (avoid clobbering a newer pane).
      const store = useDictationStore.getState();
      if (store.insertTarget === append) store.registerInsert(null);
    };
  }, [active, disabled, inputRef]);

  // Screenshots attached to the next message. On send we splice their file paths
  // into the text so the Claude Code CLI reads each PNG from disk.
  const [attachments, setAttachments] = useState<Screenshot[]>([]);
  const [capturing, setCapturing] = useState(false);
  const height = useUiStore((s) => s.composerHeight);
  const setComposerHeight = useUiStore((s) => s.setComposerHeight);
  const minimized = useUiStore((s) => s.composerMinimized);
  const setMinimized = useUiStore((s) => s.setComposerMinimized);
  const userSized = useUiStore((s) => s.composerUserSized);
  const setComposerUserSized = useUiStore((s) => s.setComposerUserSized);
  const dragRef = useRef<{ startY: number; startH: number; startMin: boolean } | null>(null);

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
      // status rows, the send/mic/camera buttons). The textarea is the only flexible
      // element, so this difference is invariant to the textarea's own height.
      const overhead = container.offsetHeight - ta.offsetHeight;
      const borderY = ta.offsetHeight - ta.clientHeight; // textarea border (client excludes it)
      // Read the natural content height free of the flex stretch, then restore.
      const prevFlex = ta.style.flex;
      const prevHeight = ta.style.height;
      ta.style.flex = "0 0 auto";
      ta.style.height = "auto";
      const contentH = ta.scrollHeight; // content + vertical padding (no border)
      ta.style.flex = prevFlex;
      ta.style.height = prevHeight;
      const desired = overhead + contentH + borderY;
      // Once the user has hand-sized the composer, `height` IS the rendered height (the draft
      // scrolls past it) — so the handle can drag it shorter than its content. Until then the
      // composer auto-grows from the rest height to fit the draft. (Pure policy in composerDrag.)
      const next = resolveComposerRenderHeight({
        height,
        desired,
        userSized,
        min: COMPOSER_MIN,
        cap: maxComposerHeight(),
      });
      setAutoHeight(next);
    };
    recomputeHeightRef.current();
    // `minimized` is a dep so autoHeight re-measures on restore: while minimized the textarea is
    // unmounted and the measurement early-returns (autoHeight freezes), so without this a
    // minimize→restore that changes nothing else would show the stale pre-minimize height.
    // `userSized` is a dep so toggling manual control re-resolves the height immediately.
  }, [value, height, attachments.length, minimized, userSized]);

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

  // Native file drag-and-drop: drag a log file (or any file) onto the active composer and
  // its absolute path is appended to the message, so it can be sent to the agent — which
  // reads the file straight from disk (same trick as screenshot attachments). Tauri's
  // webview drag-drop event carries real filesystem paths; a plain HTML5 drop in a
  // sandboxed webview does not. Only the visible pane listens (others stay mounted).
  useEffect(() => {
    if (!active) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void getCurrentWebview()
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
          const joined = paths.join(" ");
          setValue((v) => (v ? `${v}${v.endsWith(" ") ? "" : " "}${joined} ` : `${joined} `));
          setMinimized(false); // surface the box so the appended path is visible/editable
          inputRef?.current?.focus();
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((e) => log.error("composer", "drag-drop listen failed", e));
    return () => {
      cancelled = true;
      setDropActive(false);
      unlisten?.();
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
      if (shot) setAttachments((prev) => [...prev, shot]);
    } catch (err) {
      console.error("screen capture failed", err);
    } finally {
      setCapturing(false);
    }
  };

  const removeAttachment = (path: string) =>
    setAttachments((prev) => prev.filter((a) => a.path !== path));

  const send = async () => {
    if (disabled) return; // PTY not spawned yet — don't drop the prompt
    const text = value.trim();
    const shots = attachments;
    if (!text && shots.length === 0) return;
    // What the CLI receives: each screenshot's file path prefixed to the typed
    // prompt, so it reads the images from disk. A bare image (no text) is valid.
    const payload = [...shots.map((a) => a.path), text].filter(Boolean).join(" ");
    // What the transcript shows: the human text plus a count of attached shots —
    // never the raw temp-file paths (which would be an ugly user-visible leak).
    const display = [
      text,
      shots.length ? `📷 ${shots.length} screenshot${shots.length > 1 ? "s" : ""}` : "",
    ]
      .filter(Boolean)
      .join("  ");
    setValue("");
    setAttachments([]);
    // Remember the typed text (not the screenshot-annotated display string) so it can be
    // offered as a ghost-text suggestion next time the user types its prefix.
    if (text) recordPrompt(text);
    log.info("composer", "send prompt", { agentId, chars: text.length, shots: shots.length });
    onSubmitPrompt(display);
    await submitPrompt(agentId, payload);
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
  const showRichPlaceholder =
    !value && !disabled && !dropActive && attachments.length === 0;

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
        background: C.forest,
        borderTop: `1px solid ${C.deepForest}`,
      }}
    >
      {/* Persistent grab handle: open → thin pill (drag up taller, down to minimize); minimized
          → the full slim bar (click or drag up to bring the message box back). ⌘J also toggles. */}
      <div
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
        title={
          minimized
            ? "Click or drag up to bring back the message box (⌘J)"
            : "Drag to resize · drag down to minimize (⌘J)"
        }
        style={{
          height: minimized ? COMPOSER_BAR : 10,
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
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
          <>
            <span style={{ fontSize: 10 }}>▴</span>
            <span>Message your agent</span>
          </>
        ) : (
          <div style={{ width: 36, height: 3, borderRadius: 2, background: C.muted, opacity: 0.6 }} />
        )}
      </div>

      {!minimized && (
      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 8, padding: "0 10px 10px", alignItems: "stretch" }}>
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 6, position: "relative" }}>
          {attachments.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: "0 0 auto" }}>
              {attachments.map((a) => (
                <div key={a.path} style={{ position: "relative", lineHeight: 0 }}>
                  <img
                    src={a.dataUrl}
                    alt="screen capture"
                    title={a.path}
                    style={{
                      height: 46,
                      maxWidth: 96,
                      objectFit: "cover",
                      borderRadius: 6,
                      border: `1px solid ${CHAT_USER_BUBBLE}`,
                      display: "block",
                    }}
                  />
                  <button
                    onClick={() => removeAttachment(a.path)}
                    title="Remove"
                    style={{
                      position: "absolute",
                      top: -6,
                      right: -6,
                      width: 18,
                      height: 18,
                      borderRadius: 9,
                      background: C.sienna,
                      color: C.cream,
                      border: "none",
                      cursor: "pointer",
                      fontSize: 12,
                      lineHeight: "18px",
                      padding: 0,
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
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
              <span style={{ color: C.muted }}>{ghost}</span>
            </div>
            <textarea
              ref={setTaRef}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setGhostDismissed(false); // a fresh edit re-enables suggestions
                syncCaret();
              }}
              onKeyDown={onKeyDown}
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
                  : showRichPlaceholder
                  ? "" // the styled overlay below renders this state's placeholder
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
              {focused ? (
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
