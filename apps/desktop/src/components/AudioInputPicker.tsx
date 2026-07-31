// The microphone section of Settings: what Sparkle is listening to, and whether that includes
// system audio.
//
// See ../services/audioInputs for WHY this exists (a HAL plug-in stealing the default input for
// nine silent minutes; a Twitch stream transcribed into the composer). The design rules that fall
// out of those two incidents, and which this component is the enforcement point for:
//
//   1. The current device is always visible — never inferred from "it says listening".
//   2. A non-microphone input is always MARKED as one.
//   3. Binding to a non-microphone is opt-in, off by default, and the opt-in states what it costs
//      you rather than what it does technically.
//
// WHAT CHANGED, AND WHY. This used to hang off the mic indicator's hover menu, and it opened with
// an amber warning, then "Automatic (recommended)", then the built-in microphone, then FOUR
// loopback devices as its peers, then a checkbox under a three-line explanation. A user read the
// whole thing as "a recommended microphone, then maybe system audio, then a checkbox I assume lets
// me use both" — every part of which is wrong, and the last part is the opposite of what the
// checkbox does. The wordiness was not a cosmetic problem: it was what hid the choice.
//
// So the shape is now the two questions a user actually has, in the order they have them:
//
//   (a) WHAT IS BEING CAPTURED?  → the first status row, naming the device Rust actually bound to.
//   (b) IS SYSTEM AUDIO INCLUDED? → the second status row, three words, and the toggle that owns it.
//
// and everything else is subordinate to those: microphones under "Microphone", loopback devices
// under "System audio" where the toggle governing them lives — never interleaved as peers in one
// flat list, which is what made a Steam streaming device look like a reasonable thing to talk into.
//
// THE ONE DELIBERATE REMOVAL. Loopback devices used to stay LISTED-but-dimmed while the opt-in was
// off, so that a user being captured by one could see it and find the setting. They are hidden now,
// and that reasoning is preserved rather than dropped: the fact it protected — "something that is
// not a microphone is being captured" — is exactly what the status block states in two rows, above
// the fold, whether or not the device is still enumerable. That is strictly better than a dimmed
// row, because it also covers the case the dimmed row never did: a stale bind to a loopback whose
// plug-in has since been uninstalled, which appears in no list at all.
import { useEffect } from "react";
import { FiAlertTriangle, FiCheck, FiMic, FiVolume2 } from "react-icons/fi";
import { C, DANGER, FONT_WEIGHT } from "../theme/colors";
import { FONT_UI, RADIUS, TYPE } from "../theme/scale";
import { useAudioInputStore } from "../stores/audioInputStore";
import { useMicIsHearing } from "../voice/useMicIsHearing";
import {
  useAudioInputSync,
  ALLOW_VIRTUAL_CAPTION,
  ALLOW_VIRTUAL_FAILED,
  ALLOW_VIRTUAL_LABEL,
  AUTOMATIC_LABEL,
  VIRTUAL_MARKER,
  inputStatus,
  isDeviceSelectable,
  refreshAudioInputs,
  setAllowVirtualInput,
  setAudioInput,
  type AudioInput,
} from "../services/audioInputs";

/** The microphone group's heading. Exported so the tests name the group the way production does. */
export const MICROPHONE_GROUP_LABEL = "Microphone";

/** Shown under an ENABLED opt-in that has no loopback device to offer. Without it the section
 *  turns on into visible emptiness, which reads as a broken control rather than as a machine with
 *  nothing of that kind installed. */
export const NO_SYSTEM_AUDIO_INPUTS = "No system-audio inputs on this Mac.";

/** One row of the status block: a label and the value it answers with. `role="status"` is on the
 *  block rather than each row, so a device change is announced once. */
function StatusRow({
  label,
  value,
  warn,
  testId,
}: {
  label: string;
  value: string;
  warn: boolean;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: TYPE.small, lineHeight: 1.5 }}
    >
      <span style={{ flex: "0 0 auto", minWidth: 84, color: C.muted }}>{label}</span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: warn ? C.amber : C.cream,
          fontWeight: FONT_WEIGHT.semibold,
        }}
      >
        {value}
      </span>
    </div>
  );
}

/** One selectable device. `aria-disabled` rather than the `disabled` ATTRIBUTE, deliberately: the
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
        // Redundant with the render gate below (a loopback row only exists while the opt-in is on)
        // and kept anyway: this is the one decision in the component that must not depend on two
        // separate conditions agreeing, and `isDeviceSelectable` is the shared expression every row
        // is rendered through, not a special case bolted onto this one.
        if (!selectable) return;
        onSelect();
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        textAlign: "left",
        padding: "6px 8px",
        borderRadius: RADIUS.input,
        border: `1px solid ${selected ? C.teal : "transparent"}`,
        background: selected ? `color-mix(in srgb, ${C.teal} 18%, transparent)` : "transparent",
        color: C.cream,
        fontFamily: FONT_UI,
        fontSize: TYPE.small,
        cursor: selectable ? "pointer" : "default",
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
      <span aria-hidden style={{ flex: "0 0 auto", width: 12, display: "flex", color: C.teal }}>
        {selected ? <FiCheck size={12} /> : null}
      </span>
    </button>
  );
}

/** A group heading. The typographic job the old per-row "System audio" badge was doing, done once. */
function GroupLabel({ text }: { text: string }) {
  return (
    <div
      style={{
        fontSize: TYPE.micro,
        fontWeight: FONT_WEIGHT.semibold,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: C.muted,
        margin: "2px 0 4px 2px",
      }}
    >
      {text}
    </div>
  );
}

/** The microphone pane: status, the microphone list, and the system-audio opt-in with its devices. */
export function AudioInputPicker() {
  const devices = useAudioInputStore((s) => s.devices);
  const chosenUid = useAudioInputStore((s) => s.chosenUid);
  const allowVirtual = useAudioInputStore((s) => s.allowVirtual);
  const bound = useAudioInputStore((s) => s.bound);
  const grantFailed = useAudioInputStore((s) => s.grantFailed);
  // Picks the status row's verb, through the SHARED presentation rather than raw `status` — which
  // stays "listening" through the error and preparing states (roborev 55289). `bound` itself is
  // cleared on disarm by useAudioInputSync, so an off mic reports the CHOICE, not a stale capture.
  const live = useMicIsHearing();

  // Subscribe HERE, not just wherever else this happens to be rendered. The "what am I bound to
  // right now" row is this component's own Rule 1 affordance; making it depend on a sibling being
  // mounted leaves it inert in any window that does not mount that sibling, while a test that pokes
  // the store directly still passes.
  useAudioInputSync();
  // Capture devices are hot-pluggable, so the list is refreshed each time this pane opens rather
  // than cached at startup — a headset plugged in two minutes ago must be in this list.
  useEffect(() => {
    void refreshAudioInputs();
  }, []);

  const status = inputStatus({ bound, live, chosenUid, devices, allowVirtual });
  // The split that stops a Steam streaming device from sitting next to the built-in microphone as
  // though the two were alternatives for the same job.
  const microphones = devices.filter((d) => !d.isVirtual);
  const systemAudioInputs = devices.filter((d) => d.isVirtual);

  return (
    <div
      role="group"
      aria-label="Microphone input device"
      style={{ display: "flex", flexDirection: "column", gap: 14, fontFamily: FONT_UI }}
    >
      {/* (a) and (b), in that order, before anything the user has to decide about. */}
      <div
        role="status"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2,
          padding: "8px 10px",
          borderRadius: RADIUS.input,
          border: `1px solid ${status.systemAudioIsWarning || status.captureIsVirtual ? C.amber : C.hairline}`,
        }}
      >
        <StatusRow
          label={status.captureLabel}
          value={status.captureValue}
          warn={status.captureIsVirtual}
          testId="audio-status-capture"
        />
        <StatusRow
          label={VIRTUAL_MARKER}
          value={status.systemAudioValue}
          warn={status.systemAudioIsWarning}
          testId="audio-status-system-audio"
        />
      </div>

      <div role="group" aria-label={MICROPHONE_GROUP_LABEL}>
        <GroupLabel text={MICROPHONE_GROUP_LABEL} />
        <DeviceRow
          label={AUTOMATIC_LABEL}
          selected={chosenUid === null}
          selectable
          virtual={false}
          hint="recommended"
          onSelect={() => void setAudioInput(null)}
          testId="audio-input-automatic"
        />
        {microphones.map((d: AudioInput) => (
          <DeviceRow
            key={d.uid}
            label={d.name}
            selected={chosenUid === d.uid}
            selectable={isDeviceSelectable(d, allowVirtual)}
            virtual={false}
            hint={d.isDefault ? "system default" : d.isBuiltin ? "built-in" : undefined}
            onSelect={() => void setAudioInput(d.uid)}
            testId={`audio-input-${d.uid}`}
          />
        ))}
      </div>

      {/* Rule 3. Not a SettingCheckbox: this row carries a consequence line and a failure state
          that no shared checkbox has a slot for. */}
      <div role="group" aria-label={VIRTUAL_MARKER}>
        <GroupLabel text={VIRTUAL_MARKER} />
        <button
          type="button"
          role="checkbox"
          aria-checked={allowVirtual}
          aria-label={ALLOW_VIRTUAL_LABEL}
          onClick={() => void setAllowVirtualInput(!allowVirtual)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            textAlign: "left",
            background: "transparent",
            border: "none",
            padding: "2px 8px",
            cursor: "pointer",
            color: allowVirtual ? C.amber : C.cream,
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
        <div style={{ padding: "2px 8px 0 30px", fontSize: TYPE.micro, lineHeight: 1.4, color: C.muted }}>
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
              gap: 6,
              margin: "6px 2px 0",
              padding: "6px 8px",
              borderRadius: RADIUS.input,
              border: `1px solid ${DANGER}`,
              color: DANGER,
              fontSize: TYPE.micro,
              lineHeight: 1.35,
            }}
          >
            <FiAlertTriangle size={12} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{ALLOW_VIRTUAL_FAILED}</span>
          </div>
        ) : null}

        {/* Loopback devices appear only once the user has opted in — under the heading and the
            toggle that govern them, never mixed into the microphone list above. */}
        {allowVirtual ? (
          <div style={{ marginTop: 6 }}>
            {systemAudioInputs.length === 0 ? (
              <div style={{ padding: "2px 8px", fontSize: TYPE.micro, color: C.muted }}>
                {NO_SYSTEM_AUDIO_INPUTS}
              </div>
            ) : (
              systemAudioInputs.map((d: AudioInput) => (
                <DeviceRow
                  key={d.uid}
                  label={d.name}
                  selected={chosenUid === d.uid}
                  selectable={isDeviceSelectable(d, allowVirtual)}
                  virtual
                  onSelect={() => void setAudioInput(d.uid)}
                  testId={`audio-input-${d.uid}`}
                />
              ))
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
