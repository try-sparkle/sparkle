import type { CSSProperties } from "react";
import { C } from "../theme/colors";
import { FONT_UI } from "../theme/scale";
import { SEND_MODE_LABEL, TALK_KEY_GLYPH } from "../voice/sendMode";

// "Voice controls" pane for the ⋯ settings dialog.
//
// ── WHAT THIS PANE NO LONGER CONTAINS, AND WHY ──────────────────────────────────────────────────
// It used to open with an always-listening mic CHECKBOX ("Sparkle listens for your wake word
// on-device and starts dictating when it hears it"), a WAKE WORD field, a STOP WORD field, a
// "when you submit a prompt" Keep-listening/Pause-listening segment, and a reset button for the
// four of them. All of it is gone, on the founder's instruction: "We're no longer doing the wake
// word. This section should be removed. We now have push to talk or speak buttons; SPEAK SHOULD BE
// ALWAYS ON."
//
// Every one of those controls existed to configure a wake word or to work around not having one:
//  • the checkbox armed the always-listening loop — the tray's Push to talk / Speak positions ARE
//    that arm now, and they say which mode they arm rather than only that something is on;
//  • the two word fields configured phrases the matcher no longer looks for;
//  • pause-on-submit dropped dictation back to "waiting for the wake word" after each message,
//    which with no wake word would have left the mic unable to resume — it would have silently
//    broken always-on Speak on the first send, which is the opposite of what was asked for.
//
// WHAT REPLACES IT IS NOT A SETTING. The three-position send tray in the concierge column is the
// mic control, so the pane explains it rather than duplicating it: a control that exists in two
// places is the two-controls-disagreeing failure voice/useSendMode was written to delete.
//
// The MICROPHONE PICKER still lives in this pane — it is rendered by SettingsDialog alongside this
// component (see `AudioInputPicker`), and it is the one genuinely configurable thing left about
// voice: which input device capture binds to.

const heading: CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: C.cream,
  marginBottom: 6,
  fontFamily: FONT_UI,
};

const caption: CSSProperties = {
  fontSize: 12,
  color: C.muted,
  marginTop: 4,
  lineHeight: 1.35,
  fontFamily: FONT_UI,
};

const term: CSSProperties = {
  fontWeight: 600,
  color: C.cream,
};

export function VoiceControlsMenu() {
  return (
    /* The testid is the visual harness's proof that the VOICE pane is the one on screen — its
       `settings-voice` surface waits on this rather than on the dialog, which is open for every
       category and would let a failed rail click photograph the wrong pane under this name. */
    <div data-testid="settings-voice-pane">
      <span style={heading}>How Sparkle listens</span>
      <div style={caption}>
        The send tray under the concierge message box is the microphone control. Its position
        decides everything — there is nothing to say to start it and nothing to say to stop it.
      </div>
      <ul style={{ ...caption, margin: "10px 0 0", paddingLeft: 18 }}>
        <li style={{ marginBottom: 6 }}>
          <span style={term}>{SEND_MODE_LABEL.speak}</span> — the microphone is on continuously.
          Just talk; pause when you&rsquo;re done and Sparkle sends it.
        </li>
        <li style={{ marginBottom: 6 }}>
          <span style={term}>{SEND_MODE_LABEL.ptt}</span> — Hold {TALK_KEY_GLYPH} anywhere in the
          window to talk, then let go to send.
        </li>
        <li>
          <span style={term}>{SEND_MODE_LABEL.send}</span> — the microphone is off.
        </li>
      </ul>
    </div>
  );
}
