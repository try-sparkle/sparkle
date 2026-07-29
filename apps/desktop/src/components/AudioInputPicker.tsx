// The input-device section of the mic menu: what Sparkle is allowed to listen to, and what it is
// listening to right now.
//
// See ../services/audioInputs for WHY this exists (a HAL plug-in stealing the default input for
// nine silent minutes; a Twitch stream transcribed into the composer). The design rules that fall
// out of those two incidents, and which this component is the enforcement point for:
//
//   1. The current device is always visible — never inferred from "it says listening".
//   2. A non-microphone input is always MARKED as one, in the list and beside the live device.
//   3. Binding to a non-microphone is opt-in, off by default, and the opt-in states what it costs
//      you rather than what it does technically.
//   4. When that opt-in is ON it is visible in the menu itself — no submenu, no hover, no digging.
//      An advanced setting the user has to go looking for is one they forget they enabled.
//
// Virtual devices stay LISTED while the opt-in is off, only un-selectable. Hiding them would leave
// a user who is being captured by one unable to see it or find the setting that governs it.
import { useEffect } from "react";
import { FiAlertTriangle, FiCheck, FiMic, FiVolume2 } from "react-icons/fi";
import { C, DANGER, FONT_WEIGHT } from "../theme/colors";
import { FONT_UI, RADIUS, TYPE } from "../theme/scale";
import { useAudioInputStore } from "../stores/audioInputStore";
import { useMicIsHearing } from "../voice/useMicIsHearing";
import {
  useAudioInputSync,
  ALLOW_VIRTUAL_ACTIVE_WARNING,
  ALLOW_VIRTUAL_CAPTION,
  ALLOW_VIRTUAL_FAILED,
  ALLOW_VIRTUAL_LABEL,
  AUTOMATIC_LABEL,
  BOUND_VIRTUAL_WARNING,
  VIRTUAL_MARKER,
  boundDeviceCaption,
  isDeviceSelectable,
  refreshAudioInputs,
  setAllowVirtualInput,
  setAudioInput,
  type AudioInput,
} from "../services/audioInputs";

/** One selectable row. `aria-disabled` rather than the `disabled` ATTRIBUTE, deliberately: the
 *  refusal is a product rule (you have not opted into non-microphone inputs), so it must live in
 *  the handler where it can be tested by observing that no command was sent. A `disabled` button
 *  would have the browser swallow the click, and the test proving "a virtual device is refused"
 *  would then be asserting jsdom's behavior rather than ours. */
function DeviceRow({
  label,
  selected,
  selectable,
  virtual: isVirtual,
  hint,
  onSelect,
  testId,
}: {
  label: string;
  selected: boolean;
  selectable: boolean;
  virtual: boolean;
  hint?: string;
  onSelect: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      aria-disabled={!selectable}
      aria-label={label}
      data-testid={testId}
      title={selectable ? label : `${label} — ${ALLOW_VIRTUAL_LABEL} must be on to use this input`}
      onClick={() => {
        if (!selectable) return;
        onSelect();
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        width: "100%",
        textAlign: "left",
        padding: "5px 7px",
        borderRadius: RADIUS.input,
        border: `1px solid ${selected ? C.teal : "transparent"}`,
        background: selected ? `color-mix(in srgb, ${C.teal} 18%, transparent)` : "transparent",
        color: C.cream,
        fontFamily: FONT_UI,
        fontSize: TYPE.small,
        cursor: selectable ? "pointer" : "default",
        // Dimmed, but still legible: the user has to be able to READ the device that is being
        // withheld from them, otherwise the opt-in below has no visible subject.
        opacity: selectable ? 1 : 0.45,
      }}
    >
      <span aria-hidden style={{ flex: "0 0 auto", display: "flex", color: isVirtual ? C.amber : C.muted }}>
        {isVirtual ? <FiVolume2 size={13} /> : <FiMic size={13} />}
      </span>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
        {hint ? <span style={{ color: C.muted }}> · {hint}</span> : null}
      </span>
      {isVirtual ? (
        // Rule 2. A word, not just a differently-coloured icon — "this can hear your calls" is not
        // something a glyph can say, and it is the whole decision the user is making.
        <span
          style={{
            flex: "0 0 auto",
            fontSize: TYPE.micro,
            fontWeight: FONT_WEIGHT.semibold,
            color: C.amber,
            border: `1px solid ${C.amber}`,
            borderRadius: 4,
            padding: "0 4px",
          }}
        >
          {VIRTUAL_MARKER}
        </span>
      ) : null}
      <span aria-hidden style={{ flex: "0 0 auto", width: 12, display: "flex", color: C.teal }}>
        {selected ? <FiCheck size={12} /> : null}
      </span>
    </button>
  );
}

/** The device list + the advanced opt-in, rendered inside the mic hover menu. */
export function AudioInputPicker() {
  const devices = useAudioInputStore((s) => s.devices);
  const chosenUid = useAudioInputStore((s) => s.chosenUid);
  const allowVirtual = useAudioInputStore((s) => s.allowVirtual);
  const bound = useAudioInputStore((s) => s.bound);
  const grantFailed = useAudioInputStore((s) => s.grantFailed);
  // Picks the caption's verb (see boundDeviceCaption), through the SHARED presentation rather than
  // raw `status` — which stays "listening" through the error and preparing states (roborev 55289).
  // `bound` itself is cleared on disarm by useAudioInputSync, so an off mic shows no device line at
  // all rather than a stale one.
  const live = useMicIsHearing();

  // Subscribe HERE, not just wherever else this happens to be rendered. The menu's "what am I
  // bound to right now" line is its own Rule 1 affordance; making it depend on a sibling component
  // being mounted leaves it inert in any window that does not mount that sibling, while a test
  // that pokes the store directly still passes.
  useAudioInputSync();
  // Capture devices are hot-pluggable, so the list is refreshed each time the menu opens rather
  // than cached at startup — a headset plugged in two minutes ago must be in this list.
  useEffect(() => {
    void refreshAudioInputs();
  }, []);

  const caption = boundDeviceCaption(bound, live);

  return (
    <div
      role="group"
      aria-label="Microphone input device"
      // 230, not 250: with the pill's 5px padding + borders this makes the menu ~242px, which fits
      // inside the concierge column (clamped to a 280px minimum, less 14px inset each side = 252)
      // that the centered ring anchor has to live in.
      style={{ width: 230, display: "flex", flexDirection: "column", gap: 2, fontFamily: FONT_UI }}
    >
      {/* Rule 1, inside the menu: the device the backend actually bound to, not the one we asked
          for. When they differ (device gone, grabbed by another app) this is the only thing that
          tells the user. */}
      {caption ? (
        <div style={{ padding: "2px 7px 4px", fontSize: TYPE.micro, color: C.muted }}>
          <span style={{ color: bound?.isVirtual ? C.amber : C.muted }}>{caption}</span>
        </div>
      ) : null}

      {/* Rule 4: an enabled opt-in announces itself in the menu body. */}
      {allowVirtual ? (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 5,
            margin: "0 2px 4px",
            padding: "5px 6px",
            borderRadius: RADIUS.input,
            border: `1px solid ${C.amber}`,
            background: `color-mix(in srgb, ${C.amber} 14%, transparent)`,
            color: C.amber,
            fontSize: TYPE.micro,
            lineHeight: 1.3,
          }}
        >
          <FiAlertTriangle size={12} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{ALLOW_VIRTUAL_ACTIVE_WARNING}</span>
        </div>
      ) : null}

      <DeviceRow
        label={AUTOMATIC_LABEL}
        selected={chosenUid === null}
        selectable
        virtual={false}
        onSelect={() => void setAudioInput(null)}
        testId="audio-input-automatic"
      />

      {devices.map((d: AudioInput) => (
        <DeviceRow
          key={d.uid}
          label={d.name}
          selected={chosenUid === d.uid}
          selectable={isDeviceSelectable(d, allowVirtual)}
          virtual={d.isVirtual}
          hint={d.isDefault ? "system default" : d.isBuiltin ? "built-in" : undefined}
          onSelect={() => void setAudioInput(d.uid)}
          testId={`audio-input-${d.uid}`}
        />
      ))}

      {/* Rule 3. Not a SettingCheckbox: this row has to carry the consequence sentence directly
          beneath it, and it is the one control in this menu whose label alone is not enough. */}
      <div style={{ marginTop: 6, borderTop: `1px solid color-mix(in srgb, ${C.muted} 26%, transparent)`, paddingTop: 6 }}>
        <button
          type="button"
          role="checkbox"
          aria-checked={allowVirtual}
          aria-label={ALLOW_VIRTUAL_LABEL}
          onClick={() => void setAllowVirtualInput(!allowVirtual)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            width: "100%",
            textAlign: "left",
            background: "transparent",
            border: "none",
            padding: "2px 7px",
            cursor: "pointer",
            color: allowVirtual ? C.amber : C.muted,
            fontFamily: FONT_UI,
            fontSize: TYPE.small,
          }}
        >
          <span
            aria-hidden
            style={{
              flex: "0 0 auto",
              width: 14,
              height: 14,
              borderRadius: 4,
              border: `1px solid ${allowVirtual ? C.amber : C.muted}`,
              background: allowVirtual ? C.amber : "transparent",
              color: C.forest,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {allowVirtual ? <FiCheck size={11} /> : null}
          </span>
          <span style={{ flex: 1 }}>{ALLOW_VIRTUAL_LABEL}</span>
        </button>
        <div style={{ padding: "2px 7px 0 28px", fontSize: TYPE.micro, lineHeight: 1.35, color: C.muted }}>
          {ALLOW_VIRTUAL_CAPTION}
        </div>
        {/* The grant only applies once Rust confirms, so a refusal otherwise looks exactly like
            never having clicked — leaving the user to hammer a dead control with no way to tell
            "worked", "in flight" and "will never work" apart. */}
        {grantFailed ? (
          <div
            role="status"
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 5,
              margin: "5px 2px 0",
              padding: "5px 6px",
              borderRadius: RADIUS.input,
              border: `1px solid ${DANGER}`,
              color: DANGER,
              fontSize: TYPE.micro,
              lineHeight: 1.3,
            }}
          >
            <FiAlertTriangle size={12} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{ALLOW_VIRTUAL_FAILED}</span>
          </div>
        ) : null}
      </div>

      {/* Rule 2 again, at the live end: if the thing we are ACTUALLY bound to is not a microphone,
          say so here regardless of what the user picked or when they picked it. */}
      {bound?.isVirtual ? (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 5,
            margin: "6px 2px 0",
            padding: "5px 6px",
            borderRadius: RADIUS.input,
            border: `1px solid ${C.amber}`,
            color: C.amber,
            fontSize: TYPE.micro,
            lineHeight: 1.3,
          }}
        >
          <FiAlertTriangle size={12} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{BOUND_VIRTUAL_WARNING}</span>
        </div>
      ) : null}
    </div>
  );
}
