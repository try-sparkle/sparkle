// The origin gate, asserted by its SIDE EFFECT — whether `onDetect` ran — never by the gate's own
// internals (bead `sparkle-uz87.3`).
//
// ══ EVERY REFUSAL HERE IS PAIRED, AND THE PAIR IS THE WHOLE TEST ════════════════════════════════
// "a cloud-origin transcript fires nothing" is satisfied by a detector that is broken outright, by a
// phrase that never matched, by a typo in the fixture — by anything at all. On its own it proves the
// gate exists about as well as an empty test file does. So every negative below is stated against a
// positive using the BYTE-IDENTICAL transcript text and the same clock, changing ONLY the origin
// argument. When the pair holds, the one variable that differs is the one thing that can explain the
// difference, and the assertion is about the gate rather than about the fixture.
//
// The `SAME_TEXT` constant exists to make that impossible to get wrong by editing one half of a pair.
import { describe, it, expect, vi } from "vitest";
import { createOnDeviceWakeWordDetector } from "./onDeviceDetector";
import { ON_DEVICE_ORIGIN, TRANSCRIPT_ORIGINS, isOnDeviceOrigin } from "./origin";
import type { TranscriptOrigin } from "./origin";
import type { WakeWordEvent } from "./events";

const COOLDOWN_MS = 2_000;
const WINDOW_MS = 4_000;

/**
 * The one transcript every paired test feeds. Contains the exact default wake phrase followed by a
 * residual, so a firing detector produces an event whose contents are also worth asserting.
 */
const SAME_TEXT = "hey sparkle what's on my calendar";

/** A gated detector on a hand-cranked clock. `at(t)` moves the clock; `events` is what fired. */
function harness(
  overrides: Partial<Parameters<typeof createOnDeviceWakeWordDetector>[0]> = {},
) {
  let clock = 1_000;
  const events: WakeWordEvent[] = [];
  const onDetect = vi.fn((e: WakeWordEvent) => {
    events.push(e);
  });
  const detector = createOnDeviceWakeWordDetector({
    cooldownMs: COOLDOWN_MS,
    windowMs: WINDOW_MS,
    now: () => clock,
    onDetect,
    ...overrides,
  });
  return {
    detector,
    onDetect,
    events,
    at(t: number) {
      clock = t;
      return detector;
    },
  };
}

/**
 * Feed a value the type system would reject. The gate's job is to hold against callers TypeScript
 * cannot vouch for — untyped JS, a value parsed off the wire, a caller who passed nothing — so the
 * suite has to be able to express those, and a cast is the only way to say it.
 */
function feedUntyped(
  detector: ReturnType<typeof harness>["detector"],
  text: string,
  origin: unknown,
): void {
  (detector.feed as (t: string, o: unknown) => void)(text, origin);
}

describe("the gate — only on-device text can wake anything", () => {
  it("REFUSES cloud-origin text containing the exact wake phrase", () => {
    const h = harness();
    h.at(5_000).feed(SAME_TEXT, "cloud");
    expect(h.onDetect).not.toHaveBeenCalled();
  });

  it("…and ACCEPTS the byte-identical text when it came from the device", () => {
    const h = harness();
    h.at(5_000).feed(SAME_TEXT, ON_DEVICE_ORIGIN);

    // The pair's positive half also pins the payload: had the gate merely let the text through to a
    // detector that was itself broken, an assertion of "called once" would still pass.
    expect(h.onDetect).toHaveBeenCalledTimes(1);
    expect(h.events[0]).toEqual({
      at: 5_000,
      phrase: "hey sparkle",
      residual: "what's on my calendar",
      confidence: 1,
    });
  });

  it("REFUSES `unknown` origin — an unanswered question is a no, not a maybe", () => {
    const h = harness();
    h.at(5_000).feed(SAME_TEXT, "unknown");
    expect(h.onDetect).not.toHaveBeenCalled();
  });

  it("REFUSES an ABSENT origin — omission is not permission", () => {
    const h = harness();
    feedUntyped(h.at(5_000), SAME_TEXT, undefined);
    expect(h.onDetect).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["empty string", ""],
    ["a near-miss spelling", "on device"],
    ["a near-miss casing", "On-Device"],
    ["a near-miss camelCase", "onDevice"],
    ["a truthy number", 1],
    ["an object that stringifies right", { toString: () => ON_DEVICE_ORIGIN }],
    ["an array that stringifies right", [ON_DEVICE_ORIGIN]],
  ])("REFUSES a malformed origin: %s", (_label, origin) => {
    const h = harness();
    feedUntyped(h.at(5_000), SAME_TEXT, origin);
    expect(h.onDetect).not.toHaveBeenCalled();
  });

  it("refuses EVERY member of the union except on-device, and accepts that one", () => {
    // Stated over the enumeration rather than as three hand-written cases so that adding a fourth
    // origin to the union without deciding its verdict here shows up as a covered case rather than
    // as one nobody wrote a test for.
    const verdicts = TRANSCRIPT_ORIGINS.map((origin) => {
      const h = harness();
      h.at(5_000).feed(SAME_TEXT, origin);
      return [origin, h.onDetect.mock.calls.length] as const;
    });
    expect(Object.fromEntries(verdicts)).toEqual({
      "on-device": 1,
      cloud: 0,
      unknown: 0,
    });
  });
});

describe("refusal is a DROP, not a mute — refused text is not retained", () => {
  it("cloud text cannot form HALF of a later on-device match", () => {
    // The shape a mute would leave open: "hey" heard by the cloud engine, "sparkle" heard on-device.
    // If the refused chunk were merely prevented from FIRING it would still sit in the window, and
    // the on-device chunk would complete a phrase Deepgram half-heard.
    const h = harness();
    h.at(1_000).feed("hey", "cloud");
    h.at(1_200).feed("sparkle what's on my calendar", ON_DEVICE_ORIGIN);

    expect(h.onDetect).not.toHaveBeenCalled();
  });

  it("…while the same two chunks BOTH on-device do stitch into one event", () => {
    const h = harness();
    h.at(1_000).feed("hey", ON_DEVICE_ORIGIN);
    h.at(1_200).feed("sparkle what's on my calendar", ON_DEVICE_ORIGIN);

    expect(h.onDetect).toHaveBeenCalledTimes(1);
    expect(h.events[0]?.residual).toBe("what's on my calendar");
  });

  it("a storm of refused cloud interims does not consume the cooldown", () => {
    // A mute would have marked the phrase SEEN on each refused chunk, and the sighting-anchored
    // cooldown would then suppress the genuine on-device wake that follows.
    const h = harness();
    for (let i = 0; i < 10; i += 1) h.at(1_000 + i * 100).feed(SAME_TEXT, "cloud");
    h.at(2_100).feed(SAME_TEXT, ON_DEVICE_ORIGIN);

    expect(h.onDetect).toHaveBeenCalledTimes(1);
  });
});

describe("refusal is silent and non-throwing — mixed-origin feeding is a normal state", () => {
  it("does not throw on any refused origin, typed or malformed", () => {
    const h = harness();
    expect(() => {
      h.at(5_000).feed(SAME_TEXT, "cloud");
      h.at(5_100).feed(SAME_TEXT, "unknown");
      feedUntyped(h.at(5_200), SAME_TEXT, undefined);
      feedUntyped(h.at(5_300), SAME_TEXT, null);
      feedUntyped(h.at(5_400), SAME_TEXT, 42);
    }).not.toThrow();
  });

  it("keeps working after a refusal — the detector is not left in a wedged state", () => {
    const h = harness();
    h.at(5_000).feed(SAME_TEXT, "cloud");
    h.at(5_100).feed(SAME_TEXT, ON_DEVICE_ORIGIN);

    expect(h.onDetect).toHaveBeenCalledTimes(1);
  });
});

describe("the two switches are independent — neither satisfies the other", () => {
  it("disabled refuses ON-DEVICE text…", () => {
    const h = harness({ enabled: false });
    h.at(5_000).feed(SAME_TEXT, ON_DEVICE_ORIGIN);
    expect(h.onDetect).not.toHaveBeenCalled();
  });

  it("…and re-enabling the same detector lets that same text through", () => {
    const h = harness({ enabled: false });
    h.at(5_000).feed(SAME_TEXT, ON_DEVICE_ORIGIN);
    h.detector.setEnabled(true);
    h.at(5_100).feed(SAME_TEXT, ON_DEVICE_ORIGIN);

    expect(h.onDetect).toHaveBeenCalledTimes(1);
    expect(h.detector.isEnabled()).toBe(true);
  });

  it("enabled does NOT admit cloud text — the gate still holds", () => {
    const h = harness({ enabled: true });
    h.at(5_000).feed(SAME_TEXT, "cloud");

    expect(h.detector.isEnabled()).toBe(true);
    expect(h.onDetect).not.toHaveBeenCalled();
  });
});

describe("the wrapper delegates rather than reimplementing", () => {
  it("still fires exactly once for one utterance re-delivered as cumulative interims", () => {
    const h = harness();
    h.at(1_000).feed("hey", ON_DEVICE_ORIGIN);
    h.at(1_100).feed("hey spar", ON_DEVICE_ORIGIN);
    h.at(1_200).feed("hey sparkle", ON_DEVICE_ORIGIN);
    h.at(1_300).feed("hey sparkle what's on", ON_DEVICE_ORIGIN);
    h.at(1_400).feed(SAME_TEXT, ON_DEVICE_ORIGIN);

    expect(h.onDetect).toHaveBeenCalledTimes(1);
  });

  it("still forgets the cooldown on reset, so the next phrase fires immediately", () => {
    const h = harness();
    h.at(1_000).feed(SAME_TEXT, ON_DEVICE_ORIGIN);
    expect(h.onDetect).toHaveBeenCalledTimes(1);

    // Inside the cooldown, so without the reset this second feed is suppressed.
    h.detector.reset();
    h.at(1_100).feed(SAME_TEXT, ON_DEVICE_ORIGIN);

    expect(h.onDetect).toHaveBeenCalledTimes(2);
  });

  it("…and WITHOUT the reset that same second feed is suppressed", () => {
    const h = harness();
    h.at(1_000).feed(SAME_TEXT, ON_DEVICE_ORIGIN);
    h.at(1_100).feed(SAME_TEXT, ON_DEVICE_ORIGIN);

    expect(h.onDetect).toHaveBeenCalledTimes(1);
  });

  it("still rejects an empty phrase at construction", () => {
    expect(() => createOnDeviceWakeWordDetector({ phrase: "   ", onDetect: vi.fn() })).toThrow(
      /at least one word/,
    );
  });
});

describe("isOnDeviceOrigin — the predicate the gate is built from", () => {
  it("admits exactly one value and refuses everything else", () => {
    expect(isOnDeviceOrigin(ON_DEVICE_ORIGIN)).toBe(true);
    for (const other of ["cloud", "unknown", "", "on device", "On-Device", undefined, null, 1, {}]) {
      expect(isOnDeviceOrigin(other)).toBe(false);
    }
  });

  it("narrows, so a caller can hand the result straight to a typed field", () => {
    const value: unknown = "cloud";
    let narrowed: TranscriptOrigin = "unknown";
    if (isOnDeviceOrigin(value)) narrowed = value;
    expect(narrowed).toBe("unknown");
  });
});
