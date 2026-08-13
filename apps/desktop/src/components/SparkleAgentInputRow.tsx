import { useCallback, useRef, useState } from "react";
import { C, CHAT_USER_BUBBLE, FONT_WEIGHT, ON_BRAND_FILL } from "../theme/colors";
import { PtyGoneError, submitPrompt } from "../pty";

/**
 * THE ROW YOU TYPE INTO on the Improve Sparkle pane.
 *
 * Founder, 2026-08-12 (dictated): "There's a problem where the improved sparkle agent doesn't have a
 * row to type into." He was watching that agent sit BLOCKED ON HIM — it had shipped a release and was
 * asking him a direct question — with no visible way to answer it. Every other build agent can be
 * answered; this one could not.
 *
 * WHAT THIS IS NOT. It is not the bespoke bottom composer he had stripped out on 2026-07-29 (the mic,
 * the "I'm listening" placeholder, the screenshot button, attachments, prompt history, the drop
 * catch-all that swallowed terminal drops). That instruction said the pane should work "like other
 * build agents do", and it stands: none of those affordances come back, and this row deliberately
 * carries no `composerOverlay` claim over the terminal, no focus callbacks, and no dictation surface
 * registration. It is a text box and a Send button.
 *
 * WHERE THE TEXT GOES. Straight into this agent's PTY via `submitPrompt` — the same bracketed
 * paste + carriage return every other user-typed prompt in the app takes, and the same path the
 * terminal ops already use to reach `__sparkle_self__`. Deliberately NOT through the concierge relay
 * (founder's call, same dictation): `__sparkle_self__` is app-owned and lives in no project store, so
 * anything that resolves it the ordinary way gets null — see `services/knownAgents` and
 * `services/sparkleAgent`. The PTY is addressed by id and needs no such lookup.
 *
 * `machine: false` because a PERSON typed it: that is what lets StatusEngine treat the send as the
 * human-presence signal that clears an account-limit wall (see `pty.submitPrompt`).
 */

/** The textarea's accessible name. Exported so the pane's guards name the same string the UI does. */
export const SPARKLE_INPUT_LABEL = "Message Improve Sparkle";
/** The landmark the row publishes, so a guard can assert the ROW's presence without depending on the
 *  field inside it. Distinct from {@link SPARKLE_INPUT_LABEL} — see the call site. */
export const SPARKLE_INPUT_ROW_LABEL = "Improve Sparkle message row";
/** Plain, and plainly about typing — NOT the old composer's "I'm listening" mic placeholder. */
export const SPARKLE_INPUT_PLACEHOLDER = "Reply to Improve Sparkle…";
/** Shown when the send found no process. Names the remedy the pane can actually perform (Terminal's
 *  own restart / the pane's Try again), rather than reporting a delivery that did not happen. */
export const SPARKLE_INPUT_PTY_GONE =
  "Improve Sparkle isn't running right now, so that wasn't delivered. Start it again and resend.";

export function SparkleAgentInputRow({
  agentId,
  ready,
}: {
  agentId: string;
  /** The PTY is up. False while the workspace is still being prepared — there is nothing to write
   *  to yet, and claiming otherwise is the exact failure `submitPrompt` is strict about. */
  ready: boolean;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);

  const send = useCallback(async () => {
    const body = text.trim();
    if (!body || !ready || sending) return;
    setSending(true);
    setError(null);
    try {
      await submitPrompt(agentId, body, { machine: false });
      // Cleared only AFTER the write lands. A pre-emptive clear loses the user's words on exactly
      // the send that failed, which is the one they most need to keep.
      setText("");
    } catch (e) {
      setError(e instanceof PtyGoneError ? SPARKLE_INPUT_PTY_GONE : String((e as Error)?.message ?? e));
    } finally {
      setSending(false);
      boxRef.current?.focus();
    }
  }, [agentId, ready, sending, text]);

  const disabled = !ready || sending || text.trim() === "";

  return (
    <div
      role="region"
      // Deliberately NOT the textarea's own label: an accessible name shared by the region and the
      // field inside it makes every by-label lookup ambiguous (and did, on the first run of
      // SparkleAgentPane.inputRow.test.tsx).
      aria-label={SPARKLE_INPUT_ROW_LABEL}
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "flex-end",
        gap: 8,
        padding: "8px 10px 10px",
        background: C.forest,
        borderTop: `1px solid ${CHAT_USER_BUBBLE}`,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <textarea
          ref={boxRef}
          aria-label={SPARKLE_INPUT_LABEL}
          placeholder={SPARKLE_INPUT_PLACEHOLDER}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter is a newline — the convention every compose surface in the
            // app uses. `preventDefault` so the newline isn't also inserted into the box we clear.
            if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          style={{
            width: "100%",
            boxSizing: "border-box",
            resize: "none",
            background: C.deepForest,
            color: C.cream,
            border: `1px solid ${CHAT_USER_BUBBLE}`,
            borderRadius: 6,
            padding: "7px 9px",
            fontSize: 13,
            lineHeight: 1.45,
            outline: "none",
          }}
        />
        {error && (
          <div role="status" style={{ color: C.sienna, fontSize: 12, paddingTop: 4 }}>
            {error}
          </div>
        )}
      </div>
      <button
        onClick={() => void send()}
        disabled={disabled}
        style={{
          background: disabled ? C.deepForest : C.teal,
          color: disabled ? C.muted : ON_BRAND_FILL,
          border: "none",
          borderRadius: 6,
          padding: "8px 14px",
          fontWeight: FONT_WEIGHT.semibold,
          fontSize: 13,
          cursor: disabled ? "default" : "pointer",
        }}
      >
        Send
      </button>
    </div>
  );
}
