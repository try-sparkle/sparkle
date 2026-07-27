// The one compose box in the app (the terminal has none — the concierge is where you talk).
// Attach row (Screenshot / Image / Files) above a mic + textarea + Send row; ⌘/Ctrl+Enter
// submits. Purely presentational: submit reports trimmed text via onSend and clears; the mic
// button only reports onMicToggle — micLive (the armed state) is a prop, owned upstream.
//
// SEND TARGET. Because this box replaced the AgentPane composer as well as being the chat with
// Sparkle, it carries an explicit target toggle: "→ Sparkle" (the brain) or "→ <agent>" (a real
// prompt into that agent's terminal). Explicit, never inferred — guessing would either bury a
// prompt in a chat thread or fire an agent turn the user didn't ask for. The toggle is a prop
// pair (`send` + `onToggleSendTarget`); this file owns none of that state.
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { FiCamera, FiImage, FiMic, FiPaperclip, FiTerminal, FiZap } from "react-icons/fi";
import { C, FONT_WEIGHT, ON_BRAND_FILL_DARK } from "../../theme/colors";
import type { ConciergeAttachKind, ConciergeSendState } from "./types";
import { useUiStore } from "../../stores/uiStore";

const line = `color-mix(in srgb, ${C.muted} 25%, transparent)`;

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

export function ComposeBox({
  onSend,
  onMicToggle,
  onAttach,
  micLive = false,
  send,
  onToggleSendTarget,
}: {
  /** Reports the trimmed text. May return a promise resolving FALSE when the send failed, in
   *  which case the box restores the draft (see submit). */
  onSend: (text: string) => void | Promise<boolean>;
  onMicToggle: () => void;
  onAttach: (kind: ConciergeAttachKind) => void;
  micLive?: boolean;
  send?: ConciergeSendState;
  onToggleSendTarget?: () => void;
}) {
  const [text, setText] = useState("");
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
  const toAgent = send?.target === "agent" && !!send.agentName;
  // No agent to aim at → the toggle is inert (and says so), rather than offering a target that
  // would silently fall back to the brain.
  const canToggle = !!onToggleSendTarget && !!send?.agentName;

  // Clear optimistically (the send almost always lands), but PUT THE DRAFT BACK if the host reports
  // a failure — the removed composer did exactly this, and having to retype a paragraph because an
  // agent's terminal had closed is the worst possible outcome of a failed send. Only restored when
  // the box is still empty, so it can never clobber something the user started typing meanwhile.
  const submit = () => {
    const v = text.trim();
    if (!v) return;
    const outcome = onSend(v);
    setText("");
    if (outcome && typeof outcome.then === "function") {
      void outcome.then((ok) => {
        if (!ok) setText((cur) => (cur === "" ? v : cur));
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
      style={{
        flex: "none",
        borderTop: `1px solid ${line}`,
        padding: "10px 12px 12px",
        background: "rgba(0,0,0,0.16)",
      }}
    >
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
        {send && (
          <button
            type="button"
            data-testid="send-target-toggle"
            aria-label={
              toAgent
                ? `Sending to ${send.agentName} — switch to Sparkle`
                : send.agentName
                  ? `Sending to Sparkle — switch to ${send.agentName}`
                  : "Sending to Sparkle — no agent selected"
            }
            aria-pressed={toAgent}
            title={
              send.agentName
                ? "Where your message goes: Sparkle (chat) or the selected agent (a real prompt)"
                : "Select an agent to send it a prompt"
            }
            disabled={!canToggle}
            onClick={onToggleSendTarget}
            style={{
              ...attachStyle,
              marginLeft: "auto",
              maxWidth: 150,
              overflow: "hidden",
              whiteSpace: "nowrap",
              textOverflow: "ellipsis",
              cursor: canToggle ? "pointer" : "default",
              opacity: canToggle ? 1 : 0.55,
              ...(toAgent
                ? {
                    color: C.cream,
                    borderColor: C.teal,
                    background: `color-mix(in srgb, ${C.teal} 14%, transparent)`,
                  }
                : null),
            }}
          >
            {toAgent ? <FiTerminal size={12} aria-hidden /> : <FiZap size={12} aria-hidden />}
            {toAgent ? send.agentName : "Sparkle"}
          </button>
        )}
      </div>
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
            ...(micLive
              ? {
                  color: C.cream,
                  borderColor: C.amber,
                  background: `color-mix(in srgb, ${C.amber} 12%, transparent)`,
                }
              : null),
          }}
        >
          <FiMic size={15} aria-hidden />
        </button>
        <textarea
          ref={textareaRef}
          aria-label={toAgent ? `Message ${send!.agentName}` : "Message Sparkle"}
          // No "(⌘↩ to send)" tail. The shortcut still works (see onKeyDown) — but a placeholder is
          // prime real estate for saying what this box is FOR, and spending it on a keybinding the
          // adjacent Send button already teaches made the prompt read like a manual. The hint was
          // also permanently wrong for anyone who just presses the button.
          placeholder={toAgent ? `Prompt ${send!.agentName}…` : "Talk to Sparkle…"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          style={{
            flex: 1,
            resize: "none",
            height: 42,
            background: C.forest,
            border: `1px solid ${line}`,
            borderRadius: 12,
            color: C.cream,
            padding: "10px 12px",
            fontSize: 13,
            fontFamily: "inherit",
            outline: "none",
          }}
        />
        <button
          type="button"
          onClick={submit}
          disabled={text.trim().length === 0}
          aria-label="Send"
          // Carries the shortcut the placeholder no longer spends its text on — without this the
          // keybinding would have no on-screen discoverability at all.
          title="Send (⌘↩)"
          style={{
            fontSize: 13,
            fontWeight: FONT_WEIGHT.bold,
            color: ON_BRAND_FILL_DARK,
            background: C.amber,
            border: "none",
            borderRadius: 12,
            padding: "10px 15px",
            cursor: text.trim().length === 0 ? "default" : "pointer",
            opacity: text.trim().length === 0 ? 0.45 : 1,
            height: 42,
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
