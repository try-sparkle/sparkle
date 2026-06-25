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
import { writePty } from "../pty";
import { captureScreenRegion, type Screenshot } from "../screenshot";
import { useUiStore, COMPOSER_MIN } from "../stores/uiStore";
import { useDictation } from "../useDictation";
import { useDictationStore } from "../stores/dictationStore";
import { log } from "../logger";

const maxComposerHeight = () => Math.max(COMPOSER_MIN, window.innerHeight - 140);

// Bracketed-paste wrappers: ESC[200~ … ESC[201~. ESC is char code 27 — constructed
// here so the source file contains no literal ESC byte.
const ESC = String.fromCharCode(27);
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

/** Microphone glyph for the voice-dictation button. Filled when active (recording). */
function MicIcon({ active }: { active: boolean }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill={active ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
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
 * The friendly prompt composer (spec §7). A real <textarea>, so Shift+arrow selection,
 * multi-line, and Cmd+A/C/V all work natively. ⏎ sends, ⇧⏎ inserts a newline. Send
 * injects into the PTY via bracketed paste, then (after a beat) a carriage return.
 *
 * The composer is a bottom overlay floating over the terminal: the grab handle at the top
 * drags it taller (up, over the terminal) or shorter, and the height persists (uiStore).
 * Because it overlays rather than shares the flex column, dragging never resizes the
 * terminal beneath it. All input belongs here — the terminal bounces focus back to us.
 */
export function Composer({
  agentId,
  active = true,
  disabled = false,
  inputRef,
  composerApiRef,
  onSubmitPrompt,
}: {
  agentId: string;
  // Only the visible pane's composer reacts to native file drops (panes stay mounted).
  active?: boolean;
  disabled?: boolean;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  // Imperative hook so the terminal can route a typed character into this composer.
  composerApiRef?: RefObject<{ insert: (text: string) => void } | null>;
  onSubmitPrompt: (text: string) => void;
}) {
  const [value, setValue] = useState("");
  // True while a native file (e.g. a log) is dragged over the window — drives the drop hint.
  const [dropActive, setDropActive] = useState(false);

  // Voice dictation: appends each transcribed segment into the textarea.
  // `dictation://partial` is a global broadcast and every open agent's pane stays
  // mounted (visibility only toggles), so every Composer hears each segment. Gate on
  // `active` — only the visible pane consumes — or dictation leaks into other agents'
  // inputs (same reason the native-file-drop effect below gates on `active`).
  // Note: gate on `active`, NOT micStatus — the backend flushes a final partial right
  // before stop, which must still land in the pane that was being dictated into.
  const { status: micStatus, level, toggle: toggleMic, modelProgress } = useDictation({
    onSegment: (text) => {
      // Diagnostic for the "prints twice" bug: log every segment THIS composer
      // receives, with its agent + active flag, so the unified log shows whether one
      // backend emission gets appended once or twice (and in which pane). Pair with
      // the Rust "emit partial" seq logs to localize the duplicate. [dictation-dup]
      log.info(
        "composer",
        `dictation recv agent=${agentId} active=${active} text=${JSON.stringify(text)}`,
      );
      if (!active) return;
      setValue((v) => (v ? `${v} ${text}` : text));
      inputRef?.current?.focus();
    },
  });
  const dictationError = useDictationStore((s) => s.error);

  // Screenshots attached to the next message. On send we splice their file paths
  // into the text so the Claude Code CLI reads each PNG from disk.
  const [attachments, setAttachments] = useState<Screenshot[]>([]);
  const [capturing, setCapturing] = useState(false);
  const height = useUiStore((s) => s.composerHeight);
  const setComposerHeight = useUiStore((s) => s.setComposerHeight);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

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
      const next = Math.max(height, Math.min(maxComposerHeight(), desired));
      setAutoHeight(next);
    };
    recomputeHeightRef.current();
  }, [value, height, attachments.length, modelProgress, dictationError]);

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
  // terminal underneath.
  useEffect(() => {
    if (!disabled) inputRef?.current?.focus();
  }, [disabled, inputRef]);

  // Expose insert() so the terminal can hand off prompt-typing to the composer: focus
  // here and append the character the user just pressed in the terminal.
  useEffect(() => {
    if (!composerApiRef) return;
    composerApiRef.current = {
      insert: (text: string) => {
        if (disabled) return; // textarea is hidden/disabled until the PTY is ready
        setValue((v) => v + text);
        inputRef?.current?.focus();
      },
    };
    return () => {
      if (composerApiRef) composerApiRef.current = null;
    };
  }, [composerApiRef, inputRef, disabled]);

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
  }, [active, inputRef]);

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
    log.info("composer", "send prompt", { agentId, chars: text.length, shots: shots.length });
    onSubmitPrompt(display);
    await writePty(agentId, `${PASTE_START}${payload}${PASTE_END}`);
    await new Promise((r) => setTimeout(r, 60));
    await writePty(agentId, "\r");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  // Pointer-capture keeps move/up events scoped to the handle element, so they're cleaned
  // up automatically if the component unmounts mid-drag (no leaked window listeners).
  const onHandleDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    // Base the drag on the height actually on screen (which may be auto-expanded above the
    // stored floor), so the handle tracks the cursor from the first pixel instead of having
    // to close the auto-expand gap first.
    dragRef.current = { startY: e.clientY, startH: autoHeight };
  };
  const onHandleMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    // Drag up (clientY decreases) => taller. Cap so it can't fully bury the rest.
    setComposerHeight(Math.min(maxComposerHeight(), d.startH + (d.startY - e.clientY)));
  };
  const onHandleUp = (e: PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  const micDisabled = modelProgress !== null || (disabled && micStatus !== "listening");

  // The default placeholder is rendered as a styled overlay (so "Hey Sparkle" can be bold +
  // blue, which a native textarea placeholder can't do). Only show it in the clean empty state
  // where the textarea sits at the top of its column, so the overlay lines up with row one.
  const showRichPlaceholder =
    !value && !disabled && !dropActive && attachments.length === 0 && !modelProgress && !dictationError;

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: autoHeight,
        zIndex: 5,
        display: "flex",
        flexDirection: "column",
        background: C.forest,
        borderTop: `1px solid ${C.deepForest}`,
      }}
    >
      {/* Grab handle */}
      <div
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        title="Drag to resize"
        style={{
          height: 10,
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "ns-resize",
        }}
      >
        <div style={{ width: 36, height: 3, borderRadius: 2, background: C.muted, opacity: 0.6 }} />
      </div>

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
          {modelProgress && (
            <div
              style={{
                flex: "0 0 auto",
                fontSize: 12,
                color: C.muted,
                paddingBottom: 2,
                fontFamily: '"IBM Plex Sans", sans-serif',
              }}
            >
              Downloading voice model…{" "}
              {modelProgress.total
                ? `${Math.round((modelProgress.done / modelProgress.total) * 100)}%`
                : ""}
            </div>
          )}
          {dictationError && (
            <div
              style={{
                flex: "0 0 auto",
                fontSize: 12,
                color: C.sienna,
                paddingBottom: 2,
                fontFamily: '"IBM Plex Sans", sans-serif',
              }}
            >
              ⚠ {dictationError}
            </div>
          )}
          <textarea
            ref={setTaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={disabled}
            placeholder={
              dropActive
                ? "Drop the file here to attach it…"
                : disabled
                ? "Starting your agent…"
                : showRichPlaceholder
                ? "" // the styled overlay below renders this state's placeholder
                : 'Just say "Hey Sparkle" and I\'ll start listening to you talk.'
            }
            spellCheck={false}
            style={{
              flex: 1,
              minHeight: 0,
              resize: "none",
              background: C.deepForest,
              color: C.cream,
              // Highlight the drop target while a file is dragged over the window.
              border: dropActive ? `1.5px dashed ${C.teal}` : `1px solid ${CHAT_USER_BUBBLE}`,
              borderRadius: 8,
              padding: "8px 10px",
              fontFamily: '"IBM Plex Sans", sans-serif',
              fontSize: 14,
              lineHeight: 1.4,
              outline: "none",
              opacity: disabled ? 0.6 : 1,
            }}
          />
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
              Just say{" "}
              <span style={{ fontWeight: FONT_WEIGHT.bold, color: C.teal }}>&quot;Hey Sparkle&quot;</span>{" "}
              and I&apos;ll start listening to you talk.
            </div>
          )}
        </div>
        <button
          onClick={() => void toggleMic()}
          disabled={micDisabled}
          title={
            modelProgress !== null
              ? "Downloading voice model…"
              : micStatus === "listening"
              ? "Stop dictation"
              : "Dictate (voice → text)"
          }
          style={{
            alignSelf: "flex-end",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 40,
            height: 40,
            // While model is downloading: muted border, no teal fill (preparing state).
            // While actively recording: teal fill.
            // Otherwise: transparent (idle).
            background:
              modelProgress !== null
                ? "transparent"
                : micStatus === "listening"
                ? C.teal
                : "transparent",
            color:
              modelProgress !== null ? C.muted : C.cream,
            border:
              modelProgress !== null
                ? `1.5px dashed ${C.muted}`
                : micStatus === "listening"
                ? `1.5px solid ${C.teal}`
                : `1.5px dashed ${C.muted}`,
            borderRadius: 8,
            cursor: micDisabled ? "not-allowed" : "pointer",
            opacity: micDisabled ? 0.5 : 1,
            padding: 0,
            // subtle live-level pulse while listening (suppressed while downloading)
            boxShadow:
              modelProgress === null && micStatus === "listening"
                ? `0 0 0 ${Math.round(level * 12)}px ${C.teal}22`
                : "none",
          }}
        >
          {modelProgress !== null ? "⋯" : <MicIcon active={micStatus === "listening"} />}
        </button>
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
    </div>
  );
}
