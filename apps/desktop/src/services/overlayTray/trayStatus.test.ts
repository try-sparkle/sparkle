// The tray status, which is a PRIVACY surface (bead sparkle-uz87.9).
//
// The assertion that matters most in this file is a negative one — "this never says listening" —
// and a negative is the shape that goes vacuously green most easily. So every one is paired with
// the input that provably DOES produce `listening`, and the exhaustive sweep below asserts the
// full mapping rather than spot-checking the cases I happened to think of.
import { describe, expect, it } from "vitest";
import { deriveTrayStatus, isCapturing, trayTooltip, type TrayStatus } from "./trayStatus";
import { INITIAL_SNAPSHOT, type SessionSnapshot, type SessionState } from "../sparkleSession";

const STATES: SessionState[] = ["idle", "listening", "processing", "responding"];

function snap(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { ...INITIAL_SNAPSHOT, ...over };
}

describe("what the tray is allowed to claim", () => {
  it("says listening ONLY when the session is actually awake and un-muted", () => {
    // The exhaustive sweep is the real guard: it fails if any state is ever quietly promoted.
    for (const state of STATES) {
      const status = deriveTrayStatus({ enabled: true, snapshot: snap({ state }) });
      expect(isCapturing(status)).toBe(state === "listening");
    }
  });

  it("never claims listening while muted — for ANY underlying state", () => {
    for (const state of STATES) {
      expect(deriveTrayStatus({ enabled: true, snapshot: snap({ state, muted: true }) })).toBe("muted");
    }
    // PAIRED: the identical states un-muted are not all "muted", so the sweep above is a real
    // negative rather than a function that returns "muted" unconditionally.
    expect(deriveTrayStatus({ enabled: true, snapshot: snap({ state: "listening" }) })).toBe("listening");
  });

  it("never claims listening while the feature is disabled — for ANY state, muted or not", () => {
    for (const state of STATES) {
      for (const muted of [true, false]) {
        expect(deriveTrayStatus({ enabled: false, snapshot: snap({ state, muted }) })).toBe("disabled");
      }
    }
    expect(deriveTrayStatus({ enabled: true, snapshot: snap({ state: "listening" }) })).toBe("listening");
  });

  it("treats 'no session yet' as idle, never as listening", () => {
    expect(deriveTrayStatus({ enabled: true, snapshot: null })).toBe("idle");
  });

  it("reports post-utterance states as working, because the mic is no longer capturing", () => {
    expect(deriveTrayStatus({ enabled: true, snapshot: snap({ state: "processing" }) })).toBe("working");
    expect(deriveTrayStatus({ enabled: true, snapshot: snap({ state: "responding" }) })).toBe("working");
  });
});

describe("authority order", () => {
  it("disabled outranks muted", () => {
    expect(deriveTrayStatus({ enabled: false, snapshot: snap({ muted: true }) })).toBe("disabled");
  });

  it("muted outranks a stale error — a mic that is off is the more important fact", () => {
    expect(
      deriveTrayStatus({ enabled: true, snapshot: snap({ muted: true }), lastErrored: true }),
    ).toBe("muted");
    // PAIRED: the same error un-muted does surface, so the precedence above is a real choice and
    // not an error path that never renders at all.
    expect(deriveTrayStatus({ enabled: true, snapshot: snap(), lastErrored: true })).toBe("error");
  });

  it("error outranks the session state", () => {
    expect(
      deriveTrayStatus({ enabled: true, snapshot: snap({ state: "idle" }), lastErrored: true }),
    ).toBe("error");
  });
});

describe("the tooltip carries the distinction the icon cannot", () => {
  const ALL: TrayStatus[] = ["disabled", "muted", "idle", "listening", "working", "error"];

  it("gives every status its own words", () => {
    const tips = ALL.map(trayTooltip);
    expect(new Set(tips).size).toBe(ALL.length);
    for (const t of tips) expect(t.length).toBeGreaterThan(0);
  });

  it("distinguishes 'the feature is off' from 'you muted it'", () => {
    // Collapsing these is how a user concludes they muted something that was never running.
    expect(trayTooltip("disabled")).not.toBe(trayTooltip("muted"));
    expect(trayTooltip("muted")).toMatch(/muted/i);
  });

  it("only the listening tooltip says it is hearing you now", () => {
    for (const s of ALL) {
      expect(/listening to you now/i.test(trayTooltip(s))).toBe(s === "listening");
    }
  });
});
