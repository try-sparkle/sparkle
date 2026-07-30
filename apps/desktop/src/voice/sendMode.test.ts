// The send tray's rules, tested where they live — pure, no DOM, no React.
//
// Every row here asserts a rule the app did NOT have before the tray shipped: there was a Send
// button and a boolean auto-send switch, so there was no "position", no mode→microphone mapping, no
// clamp, no per-mode chord, and no chiclet. None of these functions existed to be called.
import { describe, expect, it } from "vitest";

import { CONFIDENCE_THRESHOLD_MS } from "./confidence";
import {
  SEND_MODES,
  SWEEP_FLOOR_MS,
  chicletFor,
  chordSends,
  micIntentForMode,
  modeCountsDown,
  stepSendMode,
  sweepThresholdMs,
  trayInert,
  type SendMode,
} from "./sendMode";

describe("the tray's three positions", () => {
  it("reads left to right as Send · Push to talk · Speak", () => {
    // The array IS the reading order AND the arrow-key order — `stepSendMode` walks it. Pinning the
    // order here is what stops a reorder from silently re-aiming every arrow keypress.
    expect(SEND_MODES).toEqual(["send", "ptt", "speak"]);
  });

  it("steps one position at a time", () => {
    expect(stepSendMode("send", 1)).toBe("ptt");
    expect(stepSendMode("ptt", 1)).toBe("speak");
    expect(stepSendMode("speak", -1)).toBe("ptt");
    expect(stepSendMode("ptt", -1)).toBe("send");
  });

  it("CLAMPS at both ends — one extra keypress can never flip Send to Speak", () => {
    // THE REASON, not a boundary nicety. Wrapping would put the two most opposite states in this
    // feature — microphone off with nothing listening, and microphone live and auto-sending — one
    // keypress apart, with the overshoot that produced it invisible. Clamping makes an overshoot
    // harmless, which is what every other slider in the world does.
    expect(stepSendMode("send", -1)).toBe("send");
    expect(stepSendMode("speak", 1)).toBe("speak");
    // Held down: still parked at the end, never wrapped round to the other one.
    let m: SendMode = "speak";
    for (let i = 0; i < 5; i++) m = stepSendMode(m, 1);
    expect(m).toBe("speak");
  });
});

describe("the position IS the microphone", () => {
  it("Send releases the mic, Push to talk arms it, Speak takes it live", () => {
    expect(micIntentForMode("send")).toBe("off");
    expect(micIntentForMode("ptt")).toBe("paused");
    expect(micIntentForMode("speak")).toBe("active");
  });

  it("an UNRECOGNISED position releases the mic — it never fails open into a live one", () => {
    // A corrupt, partial-rollout or hand-edited persisted blob can hand this a value outside the
    // union. The fall-through direction is not a style choice: defaulting to "active" would take the
    // microphone live on a value nobody recognises — spending credits and capturing audio — with no
    // pill reading selected to explain it. (composerPersist also coerces on rehydrate; two guards,
    // because one guard for "spends credits and captures audio" is one too few.)
    expect(micIntentForMode("nonsense" as SendMode)).toBe("off");
    expect(micIntentForMode(undefined as unknown as SendMode)).toBe("off");
  });

  it("every position maps to a mic intent — no position can leave the mic undecided", () => {
    // A position with no mapping is how the tray and the mic glyph end up telling different stories
    // about the same microphone, which is the whole defect this control was built to delete.
    for (const m of SEND_MODES) {
      expect(["off", "paused", "active"]).toContain(micIntentForMode(m));
    }
  });
});

describe("only Speak counts down", () => {
  it("Send sends on a press and Push to talk sends on a release, so neither runs a clock", () => {
    // A timer in Push to talk would make the DELIBERATE mode feel laggier than the automatic one,
    // which inverts the reason both exist.
    expect(modeCountsDown("speak")).toBe(true);
    expect(modeCountsDown("ptt")).toBe(false);
    expect(modeCountsDown("send")).toBe(false);
  });

  it("the sweep never runs faster than one second, whatever the ladder says", () => {
    // Today the ladder's fastest rung IS 1s, so this changes no number — it is the promise that a
    // future retune cannot drop below it. A sweep shorter than a second is not a countdown, it is a
    // flicker between two frames, and the user never gets the chance the countdown exists to give.
    expect(sweepThresholdMs("high")).toBe(SWEEP_FLOOR_MS);
    expect(sweepThresholdMs("normal")).toBe(CONFIDENCE_THRESHOLD_MS.normal);
    expect(sweepThresholdMs("verylow")).toBe(CONFIDENCE_THRESHOLD_MS.verylow);
    for (const tier of ["high", "normal", "low", "verylow"] as const) {
      expect(sweepThresholdMs(tier)).toBeGreaterThanOrEqual(SWEEP_FLOOR_MS);
    }
  });
});

describe("inert means NOT ADDRESSED, and is decided by who OWNS focus", () => {
  it("a terminal takes the tray inert; everything else — including nothing at all — does not", () => {
    // `FocusOwner`'s "other" is anything that is not a live PTY, INCLUDING no focused element. That
    // is the distinction that keeps the tray usable: keying on "is the composer focused" instead
    // greys it for every focus move the app's own chrome causes, because `focusin` fires before a
    // button's own click handler — the control would boot grey and no button could arm it.
    expect(trayInert("terminal")).toBe(true);
    expect(trayInert("other")).toBe(false);
  });
});

describe("the keycap chip cannot lie about the keystroke", () => {
  it("⌘↩ sends under the ⌘↩ setting; a bare ↩ does not", () => {
    expect(chordSends("send", "cmd-enter", { key: "Enter", metaKey: true })).toBe(true);
    expect(chordSends("send", "cmd-enter", { key: "Enter", ctrlKey: true })).toBe(true);
    expect(chordSends("send", "cmd-enter", { key: "Enter" })).toBe(false);
  });

  it("a bare ↩ sends under the ↩ setting, and ⇧↩ is a newline in both", () => {
    expect(chordSends("send", "enter", { key: "Enter" })).toBe(true);
    expect(chordSends("send", "enter", { key: "Enter", shiftKey: true })).toBe(false);
    expect(chordSends("send", "cmd-enter", { key: "Enter", metaKey: true, shiftKey: true })).toBe(false);
  });

  it("in Push to talk NOTHING sends by chord — ⌘ means talk there", () => {
    // One meaning per chord per mode. The alternative is a timing heuristic trying to tell a tap
    // from a hold, which is exactly the guesswork this control was designed to delete. Releasing
    // already sends, so nothing is lost.
    expect(chordSends("ptt", "cmd-enter", { key: "Enter", metaKey: true })).toBe(false);
    expect(chordSends("ptt", "enter", { key: "Enter" })).toBe(false);
  });

  it("the chip shows the chord the handler honours, and ⌘ where ⌘ means talk", () => {
    // The two halves of the same fact: whatever `chordSends` accepts is what `chicletFor` draws.
    expect(chicletFor("send", "cmd-enter")).toBe("⌘↩");
    expect(chicletFor("speak", "cmd-enter")).toBe("⌘↩");
    expect(chicletFor("send", "enter")).toBe("↩");
    expect(chicletFor("ptt", "cmd-enter")).toBe("⌘");
    expect(chicletFor("ptt", "enter")).toBe("⌘");
  });

  it("a chip is never drawn for a chord its own mode refuses", () => {
    // The vacuous-test guard for the pair above: this asserts the RELATIONSHIP rather than two
    // independent literals, so changing one function without the other fails here.
    for (const mode of SEND_MODES) {
      for (const chord of ["cmd-enter", "enter"] as const) {
        const cap = chicletFor(mode, chord);
        if (cap === "⌘") {
          expect(chordSends(mode, chord, { key: "Enter", metaKey: true })).toBe(false);
          continue;
        }
        const press =
          chord === "cmd-enter" ? { key: "Enter", metaKey: true } : { key: "Enter" };
        expect(chordSends(mode, chord, press)).toBe(true);
      }
    }
  });
});
