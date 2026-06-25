import { describe, it, expect } from "vitest";
import { captionFor, barFraction } from "./LogoWaveform";

describe("captionFor", () => {
  it("passive + enabled → wake hint", () =>
    expect(captionFor("passive", true)).toBe("Just say Sparkle to talk to me"));
  it("active + enabled → stop hint", () =>
    expect(captionFor("active", true)).toBe("Just say Send It to stop"));
  it("muted → no caption", () => expect(captionFor("passive", false)).toBeNull());
});

describe("barFraction", () => {
  // Raw RMS (audio.rs rms_level): 0 = silence, 1 = full-scale clip. Normal speech
  // sits around 0.03–0.15, so a linear 1:1 map pins bars at the ~8% idle floor and
  // the meter looks like static dotted lines. barFraction applies gain + a
  // perceptual curve so speech sweeps a visible range.
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

  it("is monotonic in level", () => {
    expect(barFraction(0.2)).toBeGreaterThan(barFraction(0.1));
    expect(barFraction(0.1)).toBeGreaterThan(barFraction(0.03));
  });
});
