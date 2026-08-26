// The detector's three rules, each asserted by its SIDE EFFECT — how many times `onDetect` ran and
// what it was handed. There is no real timer anywhere in this file: the clock is a `let` the test
// moves by hand, which is the only way the window and cooldown rules can be stated in whole
// milliseconds instead of slept through.
//
// EVERY NEGATIVE HERE IS PAIRED WITH A POSITIVE using the same setup. "nothing fired" is satisfied by
// a detector that is broken outright, so on its own it proves nothing; the pair pins the CAUSE — the
// mute, the window expiry, the near-miss — rather than merely observing an absence.
import { describe, it, expect, vi } from "vitest";
import { createWakeWordDetector, DEFAULT_COOLDOWN_MS, DEFAULT_WINDOW_MS } from "./detector";
import type { WakeWordEvent } from "./events";

const COOLDOWN_MS = 2_000;
const WINDOW_MS = 4_000;

/** A detector on a hand-cranked clock. `at(t)` moves the clock; `events` is what fired. */
function harness(overrides: Partial<Parameters<typeof createWakeWordDetector>[0]> = {}) {
  let clock = 1_000;
  const events: WakeWordEvent[] = [];
  const onDetect = vi.fn((e: WakeWordEvent) => {
    events.push(e);
  });
  const detector = createWakeWordDetector({
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
    get clock() {
      return clock;
    },
  };
}

describe("the happy path — one phrase, one event, carrying the request", () => {
  it("fires once with the residual, the configured phrase and the injected clock's reading", () => {
    const h = harness();
    h.at(5_000).feed("hey sparkle what's on my calendar");

    expect(h.onDetect).toHaveBeenCalledTimes(1);
    expect(h.events[0]).toEqual({
      at: 5_000, // the INJECTED clock, not Date.now
      phrase: "hey sparkle",
      residual: "what's on my calendar",
      confidence: 1,
    });
  });

  it("stitches a phrase split across two chunks inside the window", () => {
    const h = harness();
    h.at(1_000).feed("hey");
    expect(h.onDetect).not.toHaveBeenCalled(); // half a phrase is not a phrase

    h.at(1_200).feed("sparkle open settings");
    expect(h.onDetect).toHaveBeenCalledTimes(1);
    expect(h.events[0]?.residual).toBe("open settings");
  });

  it("reports the tolerant match's score, not a flat 1", () => {
    const h = harness();
    h.at(1_000).feed("hey sparkel open settings");
    expect(h.events[0]?.confidence).toBeCloseTo(0.9, 5);
  });
});

describe("the cooldown — this repo's ASR re-delivers the same words in every interim", () => {
  it("fires EXACTLY ONCE across five overlapping partials of one utterance", () => {
    // Deepgram's interims are cumulative: each one contains the whole phrase again. Without a
    // cooldown this is five overlay wakes for one "hey sparkle".
    const h = harness();
    const partials = [
      "hey",
      "hey sparkle",
      "hey sparkle what's",
      "hey sparkle what's on my",
      "hey sparkle what's on my calendar",
    ];
    partials.forEach((p, i) => h.at(1_000 + i * 200).feed(p));

    expect(h.onDetect).toHaveBeenCalledTimes(1);
    // …and the ONE event is the earliest complete sighting, so the overlay opens the moment the
    // phrase lands rather than waiting for the sentence to finish.
    expect(h.events[0]?.at).toBe(1_200);
    expect(h.events[0]?.residual).toBe("");
  });

  it("is anchored to the last SIGHTING, so a long sentence still fires once", () => {
    // THE REGRESSION THIS ROW EXISTS FOR. Anchor the cooldown to the last FIRE and it expires while
    // the user is still talking: the interims keep re-delivering the phrase, so the detector fires a
    // second time mid-sentence. The whole run below spans 4s against a 2s cooldown.
    const h = harness();
    h.at(1_000).feed("hey sparkle");
    for (let i = 1; i <= 8; i++) {
      h.at(1_000 + i * 500).feed(`hey sparkle ${"word ".repeat(i).trim()}`);
    }
    expect(h.clock - 1_000).toBeGreaterThan(COOLDOWN_MS); // the run really did outlast the cooldown
    expect(h.onDetect).toHaveBeenCalledTimes(1);
  });

  it("fires again once the phrase has been ABSENT for a full cooldown", () => {
    const h = harness();
    h.at(1_000).feed("hey sparkle first request");
    expect(h.onDetect).toHaveBeenCalledTimes(1);

    // One tick short: still suppressed.
    h.at(1_000 + COOLDOWN_MS - 1).feed("hey sparkle second request");
    expect(h.onDetect).toHaveBeenCalledTimes(1);

    // The cooldown is measured from that suppressed sighting, so wait it out from there.
    h.at(1_000 + COOLDOWN_MS - 1 + COOLDOWN_MS).feed("hey sparkle third request");
    expect(h.onDetect).toHaveBeenCalledTimes(2);
    expect(h.events[1]?.residual).toBe("third request");
  });

  it("consumes the matched words, so a later fire's residual is not the earlier request", () => {
    const h = harness();
    h.at(1_000).feed("hey sparkle open settings");
    h.at(1_000 + COOLDOWN_MS).feed("hey sparkle close them");

    expect(h.onDetect).toHaveBeenCalledTimes(2);
    expect(h.events[1]?.residual).toBe("close them");
    expect(h.events[1]?.residual).not.toContain("open settings");
  });
});

describe("the rolling window — two unrelated utterances must never fuse into a phrase", () => {
  it("does not fire when the halves arrive windowMs + 1 apart, and DOES at windowMs", () => {
    const stale = harness();
    stale.at(1_000).feed("hey");
    stale.at(1_000 + WINDOW_MS + 1).feed("sparkle open settings");
    expect(stale.onDetect).not.toHaveBeenCalled();

    // The paired positive, identical but for the one millisecond: this is what proves the absence
    // above was the EXPIRY and not a detector that simply cannot stitch chunks.
    const fresh = harness();
    fresh.at(1_000).feed("hey");
    fresh.at(1_000 + WINDOW_MS).feed("sparkle open settings");
    expect(fresh.onDetect).toHaveBeenCalledTimes(1);
    expect(fresh.events[0]?.residual).toBe("open settings");
  });

  it("expires the old half even when the new chunk alone completes nothing", () => {
    const h = harness();
    h.at(1_000).feed("hey");
    h.at(1_000 + WINDOW_MS + 1).feed("the lights are on");
    h.at(1_000 + WINDOW_MS + 2).feed("sparkle");
    expect(h.onDetect).not.toHaveBeenCalled();
  });
});

describe("setEnabled — the privacy control", () => {
  it("fires NOTHING while disabled, for input that provably fires when enabled", () => {
    const h = harness();
    h.detector.setEnabled(false);
    expect(h.detector.isEnabled()).toBe(false);

    h.at(1_000).feed("hey sparkle what's on my calendar");
    expect(h.onDetect).not.toHaveBeenCalled();

    // THE PAIR. Same detector, same words, same clock reading — the only difference is the switch.
    h.detector.setEnabled(true);
    expect(h.detector.isEnabled()).toBe(true);
    h.at(1_000).feed("hey sparkle what's on my calendar");
    expect(h.onDetect).toHaveBeenCalledTimes(1);
    expect(h.events[0]?.residual).toBe("what's on my calendar");
  });

  it("RETAINS NOTHING heard while disabled — words cannot cross the switch", () => {
    // A detector that merely skipped the callback while muted would still be accumulating text, and
    // the half-phrase spoken during the mute would complete the moment it was un-muted. That is a
    // privacy failure, not a timing quirk.
    const muted = harness();
    muted.at(1_000).feed("hey");
    muted.detector.setEnabled(false);
    muted.at(1_010).feed("sparkle open settings");
    muted.detector.setEnabled(true);
    muted.at(1_020).feed("sparkle open settings");
    expect(muted.onDetect).not.toHaveBeenCalled();

    // The pair: without the mute, those very chunks complete the phrase well inside the window.
    const live = harness();
    live.at(1_000).feed("hey");
    live.at(1_020).feed("sparkle open settings");
    expect(live.onDetect).toHaveBeenCalledTimes(1);
  });

  it("can be created already disabled", () => {
    const h = harness({ enabled: false });
    h.at(1_000).feed("hey sparkle go");
    expect(h.onDetect).not.toHaveBeenCalled();
    expect(h.detector.isEnabled()).toBe(false);
  });
});

describe("reset — forget the window AND the cooldown", () => {
  it("lets an identical phrase fire again immediately after a reset", () => {
    const h = harness();
    h.at(1_000).feed("hey sparkle open settings");
    expect(h.onDetect).toHaveBeenCalledTimes(1);

    // Without the reset this second feed is inside the cooldown and is suppressed — asserted just
    // below, so the reset is shown to be the cause rather than the timing.
    h.detector.reset();
    h.at(1_100).feed("hey sparkle open settings");
    expect(h.onDetect).toHaveBeenCalledTimes(2);

    const unreset = harness();
    unreset.at(1_000).feed("hey sparkle open settings");
    unreset.at(1_100).feed("hey sparkle open settings");
    expect(unreset.onDetect).toHaveBeenCalledTimes(1);
  });

  it("drops a half-heard phrase, so it cannot complete after the reset", () => {
    const h = harness();
    h.at(1_000).feed("hey");
    h.detector.reset();
    h.at(1_100).feed("sparkle open settings");
    expect(h.onDetect).not.toHaveBeenCalled();
  });
});

describe("near misses stay quiet", () => {
  it.each([
    ["a bare mention mid-prompt", "make the sparkle logo bigger"],
    ["a carrier that is not adjacent", "hey there sparkle"],
    ["a longer real word", "hey sparkling water please"],
  ])("does not fire on %s", (_label, text) => {
    const h = harness();
    h.at(1_000).feed(text);
    expect(h.onDetect).not.toHaveBeenCalled();

    // The pair: the same detector hears the real phrase, so the silence above is a refusal rather
    // than a dead detector.
    h.at(1_000 + COOLDOWN_MS + 1).feed("hey sparkle go");
    expect(h.onDetect).toHaveBeenCalledTimes(1);
  });
});

describe("configuration", () => {
  it("listens for a custom phrase and reports it on the event", () => {
    const h = harness({ phrase: "Yo, Genie!" });
    h.at(1_000).feed("yo genie what's the weather");
    expect(h.events[0]?.phrase).toBe("yo genie"); // normalized, as configured
    expect(h.events[0]?.residual).toBe("what's the weather");

    h.at(1_000 + COOLDOWN_MS + 1).feed("hey sparkle what's the weather");
    expect(h.onDetect).toHaveBeenCalledTimes(1); // the default phrase is NOT also live
  });

  it("honours a raised minConfidence", () => {
    const strict = harness({ minConfidence: 0.95 });
    strict.at(1_000).feed("hey sparkel go"); // 0.9
    expect(strict.onDetect).not.toHaveBeenCalled();
    strict.at(1_100).feed("hey sparkle go"); // 1.0 — the pair
    expect(strict.onDetect).toHaveBeenCalledTimes(1);
  });

  it("refuses to be built with a phrase that has no words", () => {
    expect(() => createWakeWordDetector({ phrase: " , ", onDetect: () => {} })).toThrow(
      /at least one word/,
    );
  });

  it("ships defaults that are usable without configuration", () => {
    // Not a tautology: it pins that the default window is long enough to stitch a split phrase and
    // the default cooldown long enough to swallow an interim storm, using the real constants.
    expect(DEFAULT_WINDOW_MS).toBeGreaterThanOrEqual(1_000);
    expect(DEFAULT_COOLDOWN_MS).toBeGreaterThanOrEqual(1_000);

    let clock = 1_000;
    const onDetect = vi.fn();
    const d = createWakeWordDetector({ now: () => clock, onDetect });
    d.feed("hey");
    clock += DEFAULT_WINDOW_MS;
    d.feed("sparkle go");
    expect(onDetect).toHaveBeenCalledTimes(1);
    clock += DEFAULT_COOLDOWN_MS - 1;
    d.feed("hey sparkle go again");
    expect(onDetect).toHaveBeenCalledTimes(1);
  });
});

describe("the module performs no I/O of its own", () => {
  it("never schedules a timer — every rule is evaluated inside feed()", () => {
    // The "on-device" guarantee is structural: there is nothing in this module to audit but string
    // handling. A detector that armed a timeout would also be a detector that could fire with no
    // transcript in hand, which is the one thing the overlay must never do.
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    try {
      const h = harness();
      h.at(1_000).feed("hey sparkle open settings");
      expect(h.onDetect).toHaveBeenCalledTimes(1); // it really did the work
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(setIntervalSpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
      setIntervalSpy.mockRestore();
    }
  });

  it("fires synchronously, so the caller's handler runs before feed() returns", () => {
    const seen: string[] = [];
    const d = createWakeWordDetector({
      now: () => 1_000,
      onDetect: (e) => seen.push(e.residual),
    });
    d.feed("hey sparkle go");
    // Recorded by the time the call returns — not on a microtask, not on a timer.
    expect(seen).toEqual(["go"]);
  });
});
