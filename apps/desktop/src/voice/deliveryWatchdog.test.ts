import { describe, it, expect } from "vitest";
import {
  DELIVERY_DEADLINE_MS,
  deliveryErrorFor,
  deliveryReasonOf,
  shouldReportNoTranscript,
  type DeliveryDropReason,
} from "./deliveryWatchdog";
import { classifyVoiceError, voiceErrorNotice } from "./dictationCopy";

const REASONS: DeliveryDropReason[] = [
  "no-target",
  "mic-paused",
  "not-routable",
  "no-transcript",
];

/** The state in which the app is telling the user it can hear them and nothing has come back. */
const stalled = (over: Partial<Parameters<typeof shouldReportNoTranscript>[0]> = {}) => ({
  msSinceFirstSpeech: DELIVERY_DEADLINE_MS,
  delivered: false,
  hearing: true,
  ...over,
});

describe("shouldReportNoTranscript", () => {
  it("speaks when the user has been heard, the deadline has passed and nothing arrived", () => {
    expect(shouldReportNoTranscript(stalled())).toBe(true);
  });

  // THE REQUIREMENT, as a number. The notice has to be ON SCREEN within five seconds of the user
  // talking to a dead pipeline, so the deadline that triggers the render must land before it with
  // room for the store write and a paint. A regression that widened this past 5s would satisfy
  // every other assertion in this file.
  it("fires strictly inside the five-second budget", () => {
    expect(DELIVERY_DEADLINE_MS).toBeLessThan(5_000);
    expect(shouldReportNoTranscript(stalled({ msSinceFirstSpeech: 4_999 }))).toBe(true);
  });

  it("says nothing before the deadline", () => {
    expect(shouldReportNoTranscript(stalled({ msSinceFirstSpeech: DELIVERY_DEADLINE_MS - 1 }))).toBe(
      false,
    );
  });

  // The branch that keeps this from becoming an accusation aimed at someone who has done nothing.
  // A deadline measured from ARMING fires at every user who turns the mic on and then thinks.
  it("never speaks before the user has been heard speaking, however long it has been", () => {
    expect(shouldReportNoTranscript(stalled({ msSinceFirstSpeech: null }))).toBe(false);
    // Not even at an absurd elapsed time — there is no elapsed time, by construction.
    expect(
      shouldReportNoTranscript({ msSinceFirstSpeech: null, delivered: false, hearing: true }),
    ).toBe(false);
  });

  it("stays quiet once words have landed", () => {
    expect(shouldReportNoTranscript(stalled({ delivered: true }))).toBe(false);
  });

  it("stays quiet when the UI is not claiming to hear anything", () => {
    expect(shouldReportNoTranscript(stalled({ hearing: false }))).toBe(false);
  });
});

describe("the sentinel round-trip", () => {
  it("recovers every reason it encodes", () => {
    for (const r of REASONS) expect(deliveryReasonOf(deliveryErrorFor(r))).toBe(r);
  });

  it("does not claim strings that are not ours", () => {
    // The real backend errors this must not swallow, from dictationCopy's own PATTERNS.
    for (const raw of [
      "",
      "no microphone found",
      "microphone access was denied",
      "Sparkle was updated in the background",
      "no space left on device (os error 28)",
    ])
      expect(deliveryReasonOf(raw)).toBeNull();
  });

  it("degrades an unrecognised reason to the copy that assumes least", () => {
    // Forward-compat: a future reason arriving from a newer window must not render as `unknown`,
    // which would print the raw sentinel at the user.
    expect(deliveryReasonOf("voice-delivery:something-new")).toBe("no-transcript");
  });
});

describe("the delivery notice as the user sees it", () => {
  it("classifies every reason into its own bucket, never `unknown`", () => {
    for (const r of REASONS)
      expect(classifyVoiceError(deliveryErrorFor(r))).toBe("transcript-undelivered");
  });

  // The `unknown` branch of voiceErrorNotice renders the RAW string. If any reason ever fell
  // through to it the user would be shown "voice-delivery:no-target", which is worse than silence.
  it("never leaks the sentinel to the user", () => {
    for (const r of REASONS) {
      const n = voiceErrorNotice(deliveryErrorFor(r));
      expect(n).not.toBeNull();
      expect(`${n!.headline} ${n!.detail}`).not.toContain("voice-delivery");
      expect(n!.headline).not.toHaveLength(0);
      expect(n!.detail).not.toHaveLength(0);
    }
  });

  // AGENTS.md: a remedy is an instruction the user will follow, so it must be safe under the
  // conditions that raised it. Every sibling voice error sends the user to the mic; on this path
  // the mic is provably working, so that advice would be a dead end.
  it("never sends the user to the microphone, which is not what broke", () => {
    for (const r of REASONS) {
      const detail = voiceErrorNotice(deliveryErrorFor(r))!.detail.toLowerCase();
      expect(detail).not.toContain("privacy");
      expect(detail).not.toContain("system settings");
      expect(detail).not.toContain("turn the mic back on");
    }
  });

  // The distinction the `too-slow` banner got wrong once already: promising words that were never
  // recorded. ONLY `no-target` may claim it, and only because the code path proves it — it is
  // raised inside `insert()`, which `onSegment` reaches after calling `appendHeldSegment`.
  // `mic-paused` returns before that line and `not-routable` never enters `onSegment` at all, so
  // both would be lying. An earlier draft claimed it on all three (roborev 71065).
  //
  // THIS ASSERTS THE COPY; `dictationStore.delivery.test.ts` asserts `heldSegments` itself. Copy
  // alone cannot catch the claim drifting away from the code, which is exactly how it went wrong.
  it("only promises the words are kept on the one reason that actually holds them", () => {
    for (const r of REASONS) {
      const detail = voiceErrorNotice(deliveryErrorFor(r))!.detail.toLowerCase();
      const claimsKept = detail.includes("kept") || detail.includes("clipboard");
      expect(claimsKept).toBe(r === "no-target");
    }
  });

  it("gives each reason its own discriminating headline", () => {
    const headlines = REASONS.map((r) => voiceErrorNotice(deliveryErrorFor(r))!.headline);
    expect(new Set(headlines).size).toBe(REASONS.length);
  });
});
