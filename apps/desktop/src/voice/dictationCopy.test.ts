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
} from "./backendVoiceErrors";

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
describe("classifyVoiceError — bucket the raw backend error string", () => {
  const cases: [VoiceErrorKind, string][] = [
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

  it("every bucket yields a non-empty headline AND remedy", () => {
    for (const raw of [
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
