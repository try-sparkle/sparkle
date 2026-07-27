// @vitest-environment jsdom
//
// The quiet rule. Autoplay must never fire for a typed turn, for a muted topic, or with the voice
// kill switch off — and speak() must not even be reached in those cases, since reaching it is what
// bills ElevenLabs and makes noise.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  speak: vi.fn(async () => "elevenlabs" as const),
  stopVoice: vi.fn(),
  voiceEnabled: true,
}));
vi.mock("../voice/tts/ttsService", () => ({
  speak: h.speak,
  stopVoice: h.stopVoice,
  isVoiceEnabled: () => h.voiceEnabled,
}));

import {
  CONCIERGE_VOICE_TOPIC,
  shouldSpeakConciergeReply,
  speakConciergeReply,
  speakOnDemand,
  stopConciergeVoice,
} from "./conciergeVoice";
import { useSparklePrefsStore } from "../stores/sparklePrefsStore";

const allow = () => true;
const quiet = () => false;

beforeEach(() => {
  h.speak.mockClear();
  h.stopVoice.mockClear();
  h.voiceEnabled = true;
  useSparklePrefsStore.setState({ rules: {} });
});
afterEach(() => useSparklePrefsStore.setState({ rules: {} }));

describe("shouldSpeakConciergeReply", () => {
  it("allows a voice-started turn when nothing is muted", () => {
    expect(
      shouldSpeakConciergeReply({ voiceTurn: true, voiceEnabled: true, shouldInterrupt: allow }),
    ).toBe(true);
  });

  it("refuses a TYPED turn even when everything else allows it", () => {
    expect(
      shouldSpeakConciergeReply({ voiceTurn: false, voiceEnabled: true, shouldInterrupt: allow }),
    ).toBe(false);
  });

  it("refuses when the prefs store says quiet", () => {
    expect(
      shouldSpeakConciergeReply({ voiceTurn: true, voiceEnabled: true, shouldInterrupt: quiet }),
    ).toBe(false);
  });

  it("refuses when the voice kill switch is off", () => {
    expect(
      shouldSpeakConciergeReply({ voiceTurn: true, voiceEnabled: false, shouldInterrupt: allow }),
    ).toBe(false);
  });

  it("asks the do-not-interrupt store about the concierge voice topic specifically", () => {
    const asked: string[] = [];
    shouldSpeakConciergeReply({
      voiceTurn: true,
      voiceEnabled: true,
      shouldInterrupt: (t) => {
        asked.push(t);
        return true;
      },
    });
    expect(asked).toEqual([CONCIERGE_VOICE_TOPIC]);
  });

  it("defaults to the live prefs store and the live kill switch", () => {
    expect(shouldSpeakConciergeReply({ voiceTurn: true })).toBe(true);
    useSparklePrefsStore.getState().setInterruptPreference(CONCIERGE_VOICE_TOPIC, "mute");
    expect(shouldSpeakConciergeReply({ voiceTurn: true })).toBe(false);
  });
});

describe("speakConciergeReply", () => {
  it("speaks an allowed reply", async () => {
    const r = await speakConciergeReply("All calm.", {
      voiceTurn: true,
      voiceEnabled: true,
      shouldInterrupt: allow,
    });
    expect(r).toBe("elevenlabs");
    expect(h.speak).toHaveBeenCalledWith("All calm.");
  });

  it("a muted topic suppresses the reply WITHOUT reaching the TTS service", async () => {
    const r = await speakConciergeReply("All calm.", {
      voiceTurn: true,
      voiceEnabled: true,
      shouldInterrupt: quiet,
    });
    expect(r).toBe("suppressed");
    expect(h.speak).not.toHaveBeenCalled();
  });

  it("a real mute rule in the prefs store suppresses it too", async () => {
    useSparklePrefsStore.getState().setInterruptPreference(CONCIERGE_VOICE_TOPIC, "mute");
    expect(await speakConciergeReply("All calm.", { voiceTurn: true })).toBe("suppressed");
    expect(h.speak).not.toHaveBeenCalled();
  });

  it("an expired mute rule lets the reply through again", async () => {
    useSparklePrefsStore.getState().setInterruptPreference(CONCIERGE_VOICE_TOPIC, "mute", {
      ttlMs: 1,
    });
    useSparklePrefsStore.getState().setClock(() => Date.now() + 60_000);
    expect(await speakConciergeReply("All calm.", { voiceTurn: true })).toBe("elevenlabs");
    useSparklePrefsStore.getState().setClock(Date.now);
  });

  it("blank text is never spoken", async () => {
    expect(
      await speakConciergeReply("   ", { voiceTurn: true, voiceEnabled: true, shouldInterrupt: allow }),
    ).toBe("suppressed");
    expect(h.speak).not.toHaveBeenCalled();
  });

  it("trims before speaking so the cache key is not whitespace-sensitive", async () => {
    await speakConciergeReply("  ship it  ", {
      voiceTurn: true,
      voiceEnabled: true,
      shouldInterrupt: allow,
    });
    expect(h.speak).toHaveBeenCalledWith("ship it");
  });
});

describe("speakOnDemand", () => {
  it("ignores the do-not-interrupt rule — an explicit click is not an interruption", async () => {
    useSparklePrefsStore.getState().setInterruptPreference(CONCIERGE_VOICE_TOPIC, "mute");
    expect(await speakOnDemand("read this")).toBe("elevenlabs");
    expect(h.speak).toHaveBeenCalledWith("read this");
  });

  it("still refuses blank text", async () => {
    expect(await speakOnDemand("")).toBe("suppressed");
    expect(h.speak).not.toHaveBeenCalled();
  });
});

describe("stopConciergeVoice", () => {
  it("cuts playback through the shared TTS service", () => {
    stopConciergeVoice();
    expect(h.stopVoice).toHaveBeenCalledTimes(1);
  });
});
