import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { C, CHAT_USER_BUBBLE, FONT_WEIGHT } from "@sparkle/ui";
import { writePty } from "../pty";
import { useUiStore, COMPOSER_MIN } from "../stores/uiStore";

const maxComposerHeight = () => Math.max(COMPOSER_MIN, window.innerHeight - 140);

// Bracketed-paste wrappers: ESC[200~ … ESC[201~. ESC is char code 27 — constructed
// here so the source file contains no literal ESC byte.
const ESC = String.fromCharCode(27);
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

/**
 * The friendly prompt composer (spec §7). A real <textarea>, so Shift+arrow selection,
 * multi-line, and Cmd+A/C/V all work natively. ⏎ sends, ⇧⏎ inserts a newline. Send
 * injects into the PTY via bracketed paste, then (after a beat) a carriage return.
 *
 * The grab handle at the top resizes the composer vertically — drag it up to grow the
 * box over the terminal, down to shrink it. The height persists (uiStore).
 */
export function Composer({
  agentId,
  disabled = false,
  onSubmitPrompt,
}: {
  agentId: string;
  disabled?: boolean;
  onSubmitPrompt: (text: string) => void;
}) {
  const [value, setValue] = useState("");
  const height = useUiStore((s) => s.composerHeight);
  const setComposerHeight = useUiStore((s) => s.setComposerHeight);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

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

  const send = async () => {
    if (disabled) return; // PTY not spawned yet — don't drop the prompt
    const text = value.trim();
    if (!text) return;
    setValue("");
    onSubmitPrompt(text);
    await writePty(agentId, `${PASTE_START}${text}${PASTE_END}`);
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
    dragRef.current = { startY: e.clientY, startH: height };
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

  return (
    <div
      style={{
        height,
        flex: "0 0 auto",
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
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          placeholder={
            disabled
              ? "Starting your agent…"
              : "Message your agent…   (Enter to send, Shift+Enter for a new line)"
          }
          spellCheck={false}
          style={{
            flex: 1,
            resize: "none",
            background: C.deepForest,
            color: C.cream,
            border: `1px solid ${CHAT_USER_BUBBLE}`,
            borderRadius: 8,
            padding: "8px 10px",
            fontFamily: '"IBM Plex Sans", sans-serif',
            fontSize: 14,
            lineHeight: 1.4,
            outline: "none",
            opacity: disabled ? 0.6 : 1,
          }}
        />
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
