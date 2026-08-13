// The **Auto-send** switch — a small on/off slider under the send tray, shown in Speak and in Push
// to talk.
//
// ══ PUSH TO TALK GOT THE SAME SWITCH (sparkle-bbfsx) ════════════════════════════════════════════
// *"For Push to talk. I also want to have an auto-send option, so it should be the same slider as we
// have under speak. It can be in the same spot in the bottom right. And so if auto-send is off, then
// when I let go of the push the talk button, it does not actually auto-send. It just leaves it in
// the [composer]."* One control, two positions, two persisted settings and TWO DIFFERENT TRIGGERS —
// Speak dispatches when the silence countdown expires, Push to talk when the key comes up. The only
// thing that varies here is the tooltip's verb; see `autoSendToggleTitle`.
//
// THE FOUNDER'S ASK, verbatim: *"when speak is active, I want to have a slider. on-off slider
// button. For auto-send. And I think what I'm imagining is that It shows up. Below the speak button.
// So maybe it shows up. Below the slider tray, but to the right side. And it's just an on-off slider
// that says auto-send. And it remembers the last position I set it to."*
//
// ══ WHAT "OFF" MEANS, BECAUSE IT IS NOT WHAT IT SOUNDS LIKE ═════════════════════════════════════
// OFF DOES NOT DISABLE THE COUNTDOWN. Speak ends a dictated utterance on a silence countdown, and
// typing during that countdown pauses it and re-evaluates — behaviour the founder separately asked
// for and had built. All of that still happens with this switch off. The countdown runs, the tray's
// fill drains, the utterance ends. The ONLY thing that changes is the last step: the words stay in
// the composer and wait for a deliberate Send instead of going out on their own.
//
// That distinction lives in voice/useAutoSend (`autoSend` vs `armed`) and in the reducer
// (`noteCountdownHeld` vs `setArmed(false)`). It is restated here because this component is the
// thing a reader will find first, and getting it backwards from the UI side — hiding the tray's
// fill when off, say — would make the app tell a story the engine does not.
//
// ══ WHY A `role="switch"` AND NOT A THIRD TRAY POSITION ═════════════════════════════════════════
// The tray answers "what happens when I stop talking" at the level of the MICROPHONE, and its three
// positions are mutually exclusive states of that one question. This is a modifier ON one of those
// positions, not a fourth peer: it only exists inside Speak, and it has to keep its remembered
// value while the user is in Send or Push to talk. A fourth pill would claim otherwise.
//
// `role="switch"` with `aria-checked` is the shape a screen reader already reads as on/off, and it
// matches the app's existing Switch (components/ToolsPane) — same track, same knob, same 120ms
// slide — so this is a familiar control in a new place rather than a new control.
//
// PRESENTATIONAL, like everything in this directory (./types.ts): it takes `checked` + `onChange`
// and reads no store. The persisted value lives in uiStore and reaches it through the host.
//
// IT CARRIES NO LIVE REGION. The concierge column has exactly ONE `role="status"` node and the host
// feeds it via `announce()`; a second region makes a screen reader read every change twice
// (roborev 52648/53010/53088). The toggle's own state is on `aria-checked`, which is announced by
// the switch role itself with no live region at all.
import { C, FONT_WEIGHT } from "../../theme/colors";
import { PILL, TYPE } from "../../theme/scale";

/** The visible label. Exported so the copy is pinned by a test rather than by whoever last edited
 *  the JSX — the same treatment `presenceTitle` gets one file over. */
export const AUTO_SEND_LABEL = "Auto-send";

/**
 * The tooltip, and the one place the "off ≠ no countdown" distinction is stated TO THE USER.
 *
 * Pure and exported for the reason above. Both spellings name what happens to the WORDS, because
 * that is the difference the user can act on: either the message goes on its own, or it is sitting
 * in the box waiting for them. Saying "auto-send is off" and stopping there would leave someone
 * reasonably assuming Speak had stopped ending their sentences too.
 */
export function autoSendToggleTitle(
  checked: boolean,
  /**
   * WHICH GESTURE dispatches in this position (sparkle-bbfsx). Speak's is the silence countdown;
   * Push to talk's is letting go of the key.
   *
   * The switch is the same control in both, but the sentence must not be: "when you stop talking"
   * is FALSE in push-to-talk — you can stop talking and hold the key all day — and it is exactly the
   * kind of copy-describing-another-mode defect this file family keeps being written about. Defaults
   * to the silence wording so the Speak call site is untouched.
   */
  trigger: AutoSendTrigger = "silence",
): string {
  const when = trigger === "release" ? "When you let go" : "When you stop talking";
  return checked
    ? `Auto-send is ON. ${when}, the message sends on its own.`
    : `Auto-send is OFF. ${when}, your words wait in the composer — press Send to send them.`;
}

/** What ends an utterance in this position, and therefore what the tooltip names. */
export type AutoSendTrigger = "silence" | "release";

/** Track and knob geometry, matching components/ToolsPane's Switch so the two read as one control
 *  in two places. Slightly smaller here: this sits under a compact tray in a column that can be
 *  narrow, next to 11px text rather than a settings row's 13px. */
const TRACK_W = 30;
const TRACK_H = 17;
const KNOB = 13;
const KNOB_INSET = 2;

export function AutoSendToggle({
  checked,
  onChange,
  disabled = false,
  trigger = "silence",
}: {
  /** Is auto-send on? The current position's persisted setting — `conciergeSpeakAutoSend` in Speak,
   *  `conciergePttAutoSend` in Push to talk. Resolved by `useSendMode`, not here. */
  checked: boolean;
  /** The user flipped it. */
  onChange: (next: boolean) => void;
  /** Which gesture dispatches in this position — see {@link autoSendToggleTitle}. The control is
   *  identical in both; only the sentence it explains itself with changes. */
  trigger?: AutoSendTrigger;
  /**
   * A live PTY owns the keyboard (voice/sendMode `trayInert`), so the tray is greyed and nothing is
   * counting. The switch greys with it rather than disappearing: its VALUE is unchanged and still
   * worth showing, and a control that vanishes on a focus move reads as a bug.
   *
   * GREY HERE DOES NOT MEAN THE SETTING WAS LOST — the same thing the tray's own inert state means.
   */
  disabled?: boolean;
}) {
  return (
    // RIGHT-ALIGNED UNDER THE TRAY, which is where the founder put it ("below the slider tray, but
    // to the right side"). `marginLeft: auto` inside a flex row rather than `text-align`, matching
    // how PresenceSlider parks itself at the right end of the attach row.
    //
    // The whole strip is the row; the group inside it is what sits at the right end. A row that is
    // `display: flex` with one auto-margined child is the least surprising way to do this, and it
    // leaves room for anything else that ever needs the left of this strip.
    <div
      data-testid="auto-send-row"
      style={{
        display: "flex",
        alignItems: "center",
        // Breathing room from the tray above it, and none below — the tray is already the composer's
        // bottom bar, so this strip is the last thing in the column.
        marginTop: 4,
        minWidth: 0,
      }}
    >
      <label
        data-testid="auto-send-toggle"
        data-checked={checked}
        title={autoSendToggleTitle(checked, trigger)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          marginLeft: "auto",
          minWidth: 0,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.5 : 1,
        }}
      >
        {/* The word, before the switch — reading order is "Auto-send: on". Muted rather than lit:
            this is a persistent modifier the user should be able to ignore once set, not a call to
            action. It is the SWITCH that carries the state colour. */}
        <span
          style={{
            // `TYPE.small`, the scale's token for "chips, hints, metadata, most controls" — which
            // is exactly what this is. An off-scale 11px would read as subordinate to the tray, but
            // theme/scale.test.ts ratchets off-scale font sizes for a reason: twenty-three of them
            // is how the type sprawl happened, and one more "just slightly smaller" is how it grows.
            // Subordination is carried by the muted colour instead.
            fontSize: TYPE.small,
            fontWeight: FONT_WEIGHT.regular,
            color: C.conciergeMuted,
            whiteSpace: "nowrap",
          }}
        >
          {AUTO_SEND_LABEL}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          // The accessible NAME is the constant label, with the on/off carried by `aria-checked` —
          // a toggle whose name changes ("Turn auto-send on"/"…off") reads to a screen reader as a
          // different control appearing each time. Same rule PresenceSlider's pin follows.
          aria-label={AUTO_SEND_LABEL}
          disabled={disabled}
          onClick={() => onChange(!checked)}
          style={{
            position: "relative",
            flex: "0 0 auto",
            width: TRACK_W,
            height: TRACK_H,
            // A switch TRACK is the capsule shape itself — `PILL` is what scale.ts keeps for these.
            borderRadius: PILL,
            border: "none",
            padding: 0,
            // ON is the brand accent, OFF is the muted plane — the same on/off vocabulary the rest
            // of the app's switches use, so no new colour meaning is introduced.
            background: checked ? C.accentInk : C.muted,
            cursor: disabled ? "not-allowed" : "pointer",
            transition: "background 120ms",
          }}
        >
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: KNOB_INSET,
              left: checked ? TRACK_W - KNOB - KNOB_INSET : KNOB_INSET,
              width: KNOB,
              height: KNOB,
              borderRadius: "50%",
              // A fixed near-white knob, not a theme ink: it rides ON the filled track in both
              // states, so it must contrast with the track rather than with the page behind it.
              background: "#fff",
              transition: "left 120ms",
            }}
          />
        </button>
      </label>
    </div>
  );
}
