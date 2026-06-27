import { describe, it, expect } from "vitest";
import { captionFor, barFraction } from "./LogoWaveform";

describe("captionFor", () => {
  // `enabled` = mic armed (user intent). `listening` = capture actually live (a
  // Sparkle window is focused). The two can disagree — armed but focus-paused — and
  // the caption must stay honest rather than claim we're hearing the user when we're not.
  it("passive + enabled + listening → wake hint", () =>
    expect(captionFor("passive", true, true)).toBe("Just say Hey Sparkle to talk to me"));
  it("active + enabled + listening → stop hint", () =>
    expect(captionFor("active", true, true)).toBe("Just say Send It to stop"));
  it("muted → no caption", () =>
    expect(captionFor("passive", false, false)).toBeNull());
  it("muted stays null even if status briefly reads listening", () =>
    expect(captionFor("passive", false, true)).toBeNull());
  it("armed but paused (not listening) → honest 'Mic paused'", () =>
    expect(captionFor("passive", true, false)).toBe("Mic paused"));
  it("armed but paused while active phase → still 'Mic paused'", () =>
    expect(captionFor("active", true, false)).toBe("Mic paused"));
});

describe("barFraction", () => {
  // Raw RMS (audio.rs rms_level): 0 = silence, 1 = full-scale clip. Normal speech
  // sits around 0.03–0.15, so a linear 1:1 map pins bars at the idle floor and the
  // meter looks like static dotted lines. barFraction applies gain + a perceptual
  // curve so speech sweeps a visible range. The gain is punchy enough that normal
  // speech saturates the bar — that's intended (the meter should read as vibrant).
  it("silence maps to zero", () => expect(barFraction(0)).toBe(0));
  it("never goes negative", () => expect(barFraction(-1)).toBe(0));
  it("clamps above full scale to 1", () => expect(barFraction(2)).toBe(1));
  it("clamps full scale to 1", () => expect(barFraction(1)).toBe(1));

  it("quiet speech (~0.03) clears the 8% idle floor", () =>
    expect(barFraction(0.03)).toBeGreaterThan(0.08));
  it("normal speech (~0.1) drives bars well above the floor", () =>
    expect(barFraction(0.1)).toBeGreaterThan(0.3));
  it("loud speech (~0.5) nearly fills the bar", () =>
    expect(barFraction(0.5)).toBeGreaterThanOrEqual(0.9));

  it("is monotonic in level (within the unsaturated range)", () => {
    // The punchy gain saturates by ~0.1, so probe the quiet region where the curve
    // is still rising to prove monotonicity.
    expect(barFraction(0.06)).toBeGreaterThan(barFraction(0.03));
    expect(barFraction(0.03)).toBeGreaterThan(barFraction(0.01));
  });
});
