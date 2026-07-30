import { describe, it, expect } from "vitest";
import {
  WAKE_PHRASE,
  STOP_PHRASE,
  WAKE_PLACEHOLDER,
  MIC_HOT_PLACEHOLDER,
  wakePlaceholder,
  micHotPlaceholder,
  preparingCaption,
  preparingPlaceholder,
  modelPercent,
  classifyVoiceError,
  MICROPHONE_SETTINGS_URL,
  voiceErrorNotice,
  type VoiceErrorKind,
} from "./dictationCopy";
import {
  BACKEND_MIC_DENIED,
  BACKEND_MIC_RESTRICTED,
  BACKEND_MIC_NOT_ANSWERED,
  BACKEND_NO_AUDIO_PREFIX,
} from "./backendVoiceErrors";
// The advanced opt-in's own label, imported rather than retyped: the no-device remedy tells the user
// to turn it on, and an instruction naming a control by a stale label is worse than none.
import { ALLOW_VIRTUAL_LABEL } from "../services/audioInputs";

describe("dictationCopy — dynamic placeholders", () => {
  it("called with no arg reproduces the default constants (back-compat)", () => {
    expect(wakePlaceholder()).toBe(WAKE_PLACEHOLDER);
    expect(micHotPlaceholder()).toBe(MIC_HOT_PLACEHOLDER);
  });

  it("wakePlaceholder embeds the given wake word between the fixed prefix/suffix", () => {
    const p = wakePlaceholder("Hey Jarvis");
    expect(p).toContain("Hey Jarvis");
    expect(p).not.toContain(WAKE_PHRASE); // the default phrase is gone
    // Same framing as the default, just a different phrase.
    expect(p.startsWith("Mic paused. Say")).toBe(true);
  });

  it("micHotPlaceholder embeds the given stop phrase", () => {
    const p = micHotPlaceholder("Jarvis, halt");
    expect(p).toContain("Jarvis, halt");
    expect(p).not.toContain(STOP_PHRASE);
    expect(p.startsWith("I'm listening")).toBe(true);
  });
});

describe("modelPercent / preparing copy — the first-run download", () => {
  it("rounds the completed fraction to a percent", () => {
    expect(modelPercent({ done: 241_000_000, total: 482_000_000 })).toBe(50);
    expect(modelPercent({ done: 0, total: 482_000_000 })).toBe(0);
  });

  it("returns null when there is no usable total (no content-length → no fake number)", () => {
    expect(modelPercent(null)).toBeNull();
    expect(modelPercent({ done: 5, total: null })).toBeNull();
    expect(modelPercent({ done: 5, total: 0 })).toBeNull();
  });

  it("clamps to 0..100 (a done>total overshoot must never render 103%)", () => {
    expect(modelPercent({ done: 500_000_000, total: 482_000_000 })).toBe(100);
    expect(modelPercent({ done: -10, total: 482_000_000 })).toBe(0);
  });

  it("the caption says setting-up, never that the mic is ready", () => {
    expect(preparingCaption(42)).toBe("Setting up voice (42%)");
    expect(preparingCaption(null)).toBe("Setting up voice…");
  });

  it("the composer placeholder adds the still-typeable reassurance to the same caption", () => {
    // Built from preparingCaption so the sidebar and composer can't drift apart.
    expect(preparingPlaceholder(42).startsWith(preparingCaption(42))).toBe(true);
    expect(preparingPlaceholder(42)).toMatch(/type here meanwhile/);
  });

  it("never invites the wake word (the bug: this state used to render wakePlaceholder)", () => {
    for (const pct of [null, 0, 50, 100]) {
      expect(preparingPlaceholder(pct)).not.toContain(WAKE_PHRASE);
      expect(preparingPlaceholder(pct)).not.toContain("to activate");
    }
  });
});

// The whole point of this helper: BEFORE it existed, every dictation failure rendered the single
// hardcoded sentence "Mic unavailable — check System Settings → Privacy → Microphone", so an
// OFFLINE first-run user (whose real failure was the 482 MB model download) was sent to fiddle with
// mic permissions they'd already granted. These cases pin that each distinct backend failure gets
// its OWN honest remedy, and — most important — that an unrecognized error surfaces the raw string
// instead of guessing a cause.
/** The frame-liveness watchdog's message as the backend assembles it: a fixed noun phrase wrapped
 *  around the OS-reported DEVICE NAME. Built via a helper because the device name is the variable —
 *  it is both the thing that makes the notice actionable and the thing that can carry hostile text
 *  into the classifier, so the tests below exercise it in both roles.
 *
 *  Built FROM `BACKEND_NO_AUDIO_PREFIX` rather than re-typing it, so this fixture cannot drift from
 *  the constant the classifier and the device-name parser are both pinned to. (That constant is
 *  only half a pin until the Rust watchdog asserts it too — see backendVoiceErrors.ts.) */
const noAudioError = (device: string) =>
  `${BACKEND_NO_AUDIO_PREFIX}${device}". Another app (a screen recorder or virtual audio device) ` +
  `may be holding the microphone. Pick a different input in the mic menu, or turn the mic off and on.`;

describe("classifyVoiceError — bucket the raw backend error string", () => {
  const cases: [VoiceErrorKind, string][] = [
    // The frame-liveness watchdog: capture is LIVE, zero frames arriving. The real 2026-07-29
    // incident — a screen recorder's CoreAudio HAL plug-in held the mic for nine minutes while the
    // UI painted a normal idle waveform.
    ["no-audio", noAudioError("MacBook Pro Microphone")],
    // cpal: no microphone hardware at all.
    ["no-device", "no input device available"],
    ["no-device", "No default input device"],
    // cpal: an exotic device whose sample format we don't handle.
    ["unsupported-format", "unsupported sample format: F64"],
    // ureq/network during the one-time model download (the offline first-run case).
    ["download", "https://models.example.com/asr.tar.gz: Dns Failed: resolve error"],
    ["download", "Network Error: connection timed out"],
    ["download", "io: failed to lookup address information"],
    // model.rs's own post-unpack integrity check — a download that didn't land correctly.
    ["download", "model download completed but expected files are missing"],
    // std::io on a full disk, plus the friendlier Rust-side message that replaces it.
    ["disk-space", "No space left on device (os error 28)"],
    ["disk-space", "Need ~1.3 GB free to install the voice model, only 0.2 GB available"],
    // A genuine microphone-permission denial (must mention the mic — see the misattribution guard).
    ["permission", "microphone permission denied"],
    ["permission", "Audio capture not authorized"],
  ];

  it.each(cases)("classifies %s from %j", (kind, raw) => {
    expect(classifyVoiceError(raw)).toBe(kind);
  });

  it("falls back to UNKNOWN rather than guessing a cause", () => {
    expect(classifyVoiceError("app_data_dir() failed: no home directory")).toBe("unknown");
    expect(classifyVoiceError("something nobody has ever seen")).toBe("unknown");
    expect(classifyVoiceError("")).toBe("unknown");
  });

  // The misattribution guard, from both directions: "permission" requires a mic CONTEXT and a
  // DENIAL together. Either half alone must fall through, so no stray word can route an unrelated
  // failure to the Microphone privacy pane — the exact bug this helper exists to kill.
  it("does NOT blame the microphone for a non-mic 'denied' (denial without mic context)", () => {
    // A filesystem permission error while writing the model directory.
    expect(classifyVoiceError("Permission denied (os error 13)")).not.toBe("permission");
    expect(classifyVoiceError("privacy policy fetch rejected")).not.toBe("permission");
  });

  it("does NOT blame permission for a mic message that isn't a denial (mic context alone)", () => {
    expect(classifyVoiceError("microphone stream closed unexpectedly")).toBe("unknown");
  });

  it("still catches a macOS TCC-style microphone denial (both halves present)", () => {
    expect(classifyVoiceError("TCC deny kTCCServiceMicrophone")).toBe("permission");
  });

  it("is case-insensitive and tolerant of surrounding wrapper text", () => {
    expect(classifyVoiceError("Error: NO INPUT DEVICE AVAILABLE (cpal)")).toBe("no-device");
  });

  // Why `no-audio` is matched FIRST. The device name inside the message is an arbitrary
  // third-party string — and the drivers that CAUSE this fault (loopback/virtual-audio devices)
  // are the ones naming themselves. Each name below contains another bucket's noun phrase, so if
  // the pattern were checked later, the watchdog's positive observation would be demoted into a
  // guess: "plug in a microphone" to someone whose microphone is plugged in and selected.
  it.each([
    ["no-device — a virtual device named after the missing-hardware phrase", "No Input Device (Loopback)"],
    ["disk-space — a device whose name quotes a size", "Recorder 2 GB Free"],
    ["download — a device named after the network bucket's vocabulary", "Downloads Monitor Audio"],
    ["unsupported-format — a device that names a sample format", "Unsupported Sample Format Bridge"],
  ])("a device name that reads like %s still classifies as no-audio", (_label, device) => {
    expect(classifyVoiceError(noAudioError(device))).toBe("no-audio");
  });
});

describe("voiceErrorNotice — the rendered copy for each bucket", () => {
  it("returns null when there is no error (nothing to show)", () => {
    expect(voiceErrorNotice(null)).toBeNull();
    expect(voiceErrorNotice(undefined)).toBeNull();
    expect(voiceErrorNotice("   ")).toBeNull();
  });

  it("an offline download failure never mentions microphone permission", () => {
    const n = voiceErrorNotice("Dns Failed: resolve error")!;
    expect(n.kind).toBe("download");
    expect(n.headline.toLowerCase()).toContain("download");
    expect(`${n.headline} ${n.detail}`).toMatch(/internet|connection/i);
    expect(`${n.headline} ${n.detail}`).not.toMatch(/privacy|permission/i);
  });

  it("only the real permission failure points at the Privacy pane", () => {
    const n = voiceErrorNotice("microphone permission denied")!;
    expect(n.kind).toBe("permission");
    expect(n.detail).toContain("Privacy");
  });

  // ---------------------------------------------------------------------------
  // The cross-language contract with src-tauri/src/mic_permission.rs
  //
  // That module is what finally makes a TCC-denied mic visible at all: cpal/CoreAudio hand a
  // denied user a stream that succeeds and then delivers zeros forever, so until it existed there
  // was no error to classify — the mic just went quietly dead. Its error strings are the ONLY
  // thing that turns that silence into a `permission` notice, and they only do so if this
  // classifier actually routes them: the bucket needs a mic CONTEXT *and* a DENIAL, and four other
  // buckets are tested first. So the strings are pinned VERBATIM below rather than paraphrased.
  //
  // The strings come from backendVoiceErrors.ts — the ONE frontend copy, which mic_permission.rs's
  // `the_frontend_test_pins_these_exact_strings` reads and fails on if the Rust constants drift
  // from it. That is what makes a backend reword loud, in a failure mode that is otherwise entirely
  // silent (a reworded string just falls through to `unknown`, the user loses the System Settings
  // remedy, and nothing raises a compile error in either language). mic_permission.rs also mirrors
  // the regexes below from the Rust side.
  // ---------------------------------------------------------------------------
  const BACKEND_PERMISSION_ERRORS: [string, string][] = [
    ["denied — the user said No to the prompt (or had already)", BACKEND_MIC_DENIED],
    ["restricted — Screen Time / MDM policy forbids capture", BACKEND_MIC_RESTRICTED],
  ];

  it.each(BACKEND_PERMISSION_ERRORS)(
    "routes the backend's %s string to `permission`",
    (_label, raw) => {
      expect(classifyVoiceError(raw)).toBe("permission");
    },
  );

  it("gives every backend permission error the actionable Privacy-pane remedy", () => {
    for (const [, raw] of BACKEND_PERMISSION_ERRORS) {
      const n = voiceErrorNotice(raw)!;
      expect(n.kind).toBe("permission");
      // The remedy must name where to go, not merely restate that the mic is broken.
      expect(n.detail).toContain("Privacy");
      expect(n.detail).toContain("Microphone");
    }
  });

  it("the backend's permission errors are not stolen by an earlier bucket", () => {
    // Order matters in PATTERNS: no-device / format / disk-space / download are all tested before
    // permission. A backend string that happened to contain "no microphone", "download" or
    // "connection" would be misrouted — sending a denied user to buy disk space or check their
    // wifi. Assert the negative explicitly; the positive test above would still pass if, say,
    // `permission` were reached for the wrong reason.
    for (const [, raw] of BACKEND_PERMISSION_ERRORS) {
      for (const wrong of ["no-device", "unsupported-format", "disk-space", "download", "unknown"]) {
        expect(classifyVoiceError(raw)).not.toBe(wrong);
      }
    }
  });

  it("an UNANSWERED prompt is not sent to System Settings (it would be a dead end)", () => {
    // Verbatim from mic_permission.rs's NOT_ANSWERED_ERROR — the one backend permission-adjacent
    // string that must NOT reach `permission`. We timed out waiting for the prompt, so the status
    // is still NotDetermined: the Microphone pane has no Sparkle entry to switch on yet, and the
    // `permission` remedy would march the user to a pane where there is nothing to do. `unknown`
    // renders the raw string, which is what lets it name the remedy that actually works — click the
    // mic again, which re-prompts. (roborev 37736)
    const raw = BACKEND_MIC_NOT_ANSWERED;
    expect(classifyVoiceError(raw)).not.toBe("permission");
    const n = voiceErrorNotice(raw)!;
    expect(n.detail).toContain("try again");
    expect(n.detail).not.toContain("Privacy");
  });

  it("the System Settings deep link targets the Microphone privacy pane", () => {
    // The button in Composer/LogoWaveform hands this to openUrl. The `Privacy_Microphone` anchor
    // is what lands the user on the Microphone list rather than the top of Privacy & Security.
    expect(MICROPHONE_SETTINGS_URL).toBe(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    );
  });

  it("no-device and unsupported-format each get their own remedy", () => {
    expect(voiceErrorNotice("no input device available")!.headline).toMatch(/no microphone/i);
    expect(voiceErrorNotice("unsupported sample format: F64")!.headline).toMatch(/format/i);
  });

  it("UNKNOWN surfaces the raw error string verbatim so the cause is discoverable", () => {
    const raw = "app_data_dir() failed: no home directory";
    const n = voiceErrorNotice(raw)!;
    expect(n.kind).toBe("unknown");
    expect(n.detail).toContain(raw);
    // No invented cause in the headline.
    expect(n.headline).not.toMatch(/microphone|network/i);
  });

  it("disk-space prefers the backend's specific message when it quotes a size", () => {
    // Another worker is landing clearer Rust-side disk copy ("Need ~1.3 GB free…"). When the
    // backend is that specific, pass it through rather than flattening it to a vaguer sentence.
    const n = voiceErrorNotice("Need ~1.3 GB free to install the voice model, only 0.2 GB available")!;
    expect(n.kind).toBe("disk-space");
    expect(n.detail).toContain("1.3 GB");
  });

  it("disk-space still reads well for a bare io error that quotes no size", () => {
    const n = voiceErrorNotice("No space left on device (os error 28)")!;
    expect(n.kind).toBe("disk-space");
    expect(n.headline).toMatch(/disk space/i);
    expect(n.detail).toMatch(/free up/i);
    // The bare os error is not useful prose — it must not be the remedy line.
    expect(n.detail).not.toContain("os error 28");
  });

  // ---------------------------------------------------------------------------
  // The dead microphone (2026-07-29): a screen recorder's CoreAudio HAL plug-in held the mic while
  // capture stayed "live" and delivered ZERO frames for nine minutes. The UI painted a normal idle
  // waveform the whole time, so the user talked to a dead mic believing it was listening. A dead
  // mic must never look like a quiet room — these pin the copy that makes it look like neither.
  // ---------------------------------------------------------------------------
  it("names the SPECIFIC dead device, which is the only thing that makes the remedy followable", () => {
    const n = voiceErrorNotice(noAudioError("MacBook Pro Microphone"))!;
    expect(n.kind).toBe("no-audio");
    // THE assertion. "Pick a different input" is unfollowable until the user knows which input to
    // pick a different one FROM, and the backend's string is the only place that name exists — a
    // notice that classified correctly but flattened the detail to generic prose would still leave
    // the user guessing, so asserting `kind` alone would prove nothing.
    expect(n.detail).toContain("MacBook Pro Microphone");
    // And it survives per-device, not because some fixed sentence happens to mention a Mac.
    expect(voiceErrorNotice(noAudioError("Krisp Microphone"))!.detail).toContain("Krisp Microphone");
  });

  it("the headline says the mic isn't being HEARD, not that it is missing or never started", () => {
    const n = voiceErrorNotice(noAudioError("MacBook Pro Microphone"))!;
    // The device exists, is selected, and is open — that is exactly what made this invisible. Both
    // of the wrong stories send the user to fix something that isn't broken.
    expect(n.headline).toMatch(/hearing/i);
    expect(n.headline).not.toMatch(/no microphone found|couldn't start/i);
  });

  it("sends the user to the control that actually REBINDS capture — the mic menu's picker", () => {
    // A remedy string is an instruction the user will follow, so it gets the same scrutiny as the
    // code path it replaces. This assertion used to demand the opposite, and both halves of that
    // reasoning have since flipped in one change:
    //
    //  1. The mic menu was a three-mode pill (listening / muted / off) with no device list, so the
    //     backend's "pick a different input in the mic menu" named a control that did not exist.
    //     `AudioInputPicker` now lives in that menu — it does.
    //  2. System Settings became actively WRONG. Capture no longer follows the system default:
    //     automatic selection prefers a physical input over it, and a pinned UID ignores it
    //     (audio_devices::select_device). Changing the OS default can leave capture on the exact
    //     device this notice just named — a remedy that does nothing.
    const n = voiceErrorNotice(noAudioError("MacBook Pro Microphone"))!;
    expect(n.detail).toMatch(/hover the mic and pick a different input/i);
    expect(n.detail).not.toContain("System Settings");
    // The other half of the advice is still followable (the pill has off/on), so it survives.
    expect(n.detail).toMatch(/off and on/i);
  });

  it("the no-device remedy names BOTH real ways out of a virtual-only machine", () => {
    // roborev 55360. Driven by the ACTUAL audio.rs Refuse sentence, not a hand-written fixture,
    // because the point is what the real backend produces. This fires precisely BECAUSE inputs were
    // enumerated and they were all virtual — so "pick an input device in System Settings → Sound"
    // does nothing: only virtual inputs exist, and select_device refuses a virtual device
    // regardless of the OS default. The backend's own sentence names both options and this bucket
    // used to discard the second one.
    const REFUSE = // verbatim from audio.rs's Resolution::Refuse arm
      "No microphone found — only virtual audio devices are available. Connect a microphone, or " +
      "allow non-microphone input in the mic menu if you really want to transcribe system audio.";
    expect(classifyVoiceError(REFUSE)).toBe("no-device");
    const n = voiceErrorNotice(REFUSE)!;
    // Option one: get real hardware.
    expect(n.detail).toMatch(/connect a microphone/i);
    // Option two: the advanced opt-in — the ONLY in-app control that resolves this state. Named by
    // its exact label so a rename in audioInputs.ts cannot silently orphan this instruction.
    expect(n.detail).toContain(ALLOW_VIRTUAL_LABEL);
    // And not the remedy that cannot work here.
    expect(n.detail).not.toContain("System Settings");
  });

  it("the unsupported-format remedy names the picker too — the LAST bucket still sent to System Settings", () => {
    // roborev 55413. This bucket was left behind by the first audit pass, defended in a comment
    // saying the picker "has nothing better to offer" because the chosen device cannot be opened at
    // all. That reasoning does not hold: an unsupported sample format is a property of ONE device
    // and says nothing about the others, which is exactly when a picker helps.
    //
    // Driven by the REAL producer's sentence rather than a fixture — audio.rs's only raiser is
    // `format!("unsupported sample format: {other}")`, and it fires for the device
    // `resolve_device(choice)` already bound, i.e. Sparkle's own selection. A pinned UID ignores
    // kAudioHardwarePropertyDefaultInputDevice outright and auto_select prefers a physical input
    // over it, so changing the OS default cannot rebind capture off the failing device.
    const REAL = "unsupported sample format: u8";
    expect(classifyVoiceError(REAL)).toBe("unsupported-format");
    const n = voiceErrorNotice(REAL)!;
    expect(n.detail).toMatch(/mic menu/i);
    expect(n.detail).not.toContain("System Settings");
  });

  it("falls back to the RAW string when the device name can't be parsed out", () => {
    // If the backend rewords past the quoted-device shape, the parse fails. Show the raw sentence
    // rather than authoring a confident remedy that omits the only detail that mattered — the same
    // fail-soft principle as the `unknown` bucket. Still classified no-audio (the noun phrase held),
    // which is what keeps dictation://audio-recovered able to retract it.
    const raw = "No audio from the selected input for 9s — capture is live but no frames arrived.";
    const n = voiceErrorNotice(raw)!;
    expect(n.kind).toBe("no-audio");
    expect(n.detail).toBe(raw);
  });

  it("does NOT send the user to the Privacy pane — nothing was denied", () => {
    // The message is full of mic vocabulary, which is what `permission` matches on. Sending a user
    // whose permission is already granted to a pane where Sparkle is already switched on is the
    // misattribution this whole module exists to kill.
    const n = voiceErrorNotice(noAudioError("MacBook Pro Microphone"))!;
    expect(n.kind).not.toBe("permission");
    expect(n.detail).not.toContain("Privacy");
  });

  it("every bucket yields a non-empty headline AND remedy", () => {
    for (const raw of [
      noAudioError("MacBook Pro Microphone"),
      "no input device available",
      "unsupported sample format: F64",
      "Dns Failed",
      "No space left on device (os error 28)",
      "microphone permission denied",
      "totally unknown thing",
    ]) {
      const n = voiceErrorNotice(raw)!;
      expect(n.headline.length).toBeGreaterThan(0);
      expect(n.detail.length).toBeGreaterThan(0);
    }
  });
});
