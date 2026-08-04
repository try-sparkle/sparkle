import { describe, it, expect } from "vitest";
import { captionFor, barFraction, nextBars } from "./LogoWaveform";

describe("captionFor — the FOCUS-PAUSED caption, and only that", () => {
  // `enabled` = mic armed (user intent). `listening` = capture actually live AND not focus-paused.
  // The two can disagree — armed but focus-paused — and the caption must stay honest rather than
  // claim we're hearing the user when we're not.
  //
  // THIS FUNCTION NO LONGER ANSWERS FOR THE LIVE STATES. It used to take `phase` and return the
  // wake hint for passive and the stop hint for active — a SECOND derivation of a caption the
  // component already computes from the tray (`micCaptionKind`), keyed on a different input. Both
  // hints went with the words they named; what is left is the one state the render delegates here.
  it("capture live → null, because the live caption is the render's, from the tray", () =>
    expect(captionFor(true, true)).toBeNull());
  it("muted → no caption", () => expect(captionFor(false, false)).toBeNull());
  it("muted stays null even if status briefly reads listening", () =>
    expect(captionFor(false, true)).toBeNull());
  it("armed but paused (not listening) → honest 'Listening paused' auto-resume hint", () =>
    expect(captionFor(true, false)).toBe(
      "Listening paused: Will auto-resume when you re-focus on this project.",
    ));
  it("a terminal pause names the terminal, not the window", () =>
    expect(captionFor(true, false, "terminal")).toBe(
      "Listening paused: Your cursor is in a terminal. Click the message box to resume.",
    ));
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

describe("nextBars", () => {
  // The waveform animates ONLY while the VAD says the user is speaking; in silence it must
  // settle to a flat, static line and stop changing. These pin that gating (the actual fix
  // for "the meter wiggles when I'm not talking") without needing to drive a real rAF loop.
  const flat = () => Array(8).fill(0) as number[];
  const wave = () => [0.1, 0.5, 0.9, 0.4, 0.2, 0.7, 0.3, 0.6];

  it("not speaking + already flat → returns the SAME array (React bails, line is still)", () => {
    const prev = flat();
    // Reference equality is the signal the render loop relies on to stop re-rendering.
    expect(nextBars(prev, false, 0.9, 1)).toBe(prev);
  });

  it("not speaking → decays a residual wave toward zero (no scroll)", () => {
    const prev = wave();
    const out = nextBars(prev, false, 0.9, 1);
    // Every bar shrinks (or is snapped to 0); nothing grows, and it doesn't shift.
    out.forEach((h, i) => expect(h).toBeLessThan(prev[i]!));
  });

  it("not speaking → repeated frames reach and then HOLD a flat line", () => {
    let bars = wave();
    for (let i = 0; i < 40; i++) bars = nextBars(bars, false, 0.9, 1);
    expect(bars.every((h) => h === 0)).toBe(true);
    // Once flat, the next frame returns the identical reference (truly static).
    expect(nextBars(bars, false, 0.9, 1)).toBe(bars);
  });

  it("speaking → scrolls left by one and appends the current level (length preserved)", () => {
    const prev = wave();
    const out = nextBars(prev, true, 0.1, 1); // jitterFactor 1 → no random pulldown
    expect(out.length).toBe(prev.length);
    // Oldest sample dropped off the left; the rest shifted down one slot.
    expect(out.slice(0, -1)).toEqual(prev.slice(1));
    // Newest slot reflects the gain-curved level.
    expect(out[out.length - 1]).toBeCloseTo(barFraction(0.1));
  });

  it("speaking but silent (level 0) → appended bar is 0 (height floor handled at render)", () => {
    const out = nextBars(flat(), true, 0, 1);
    expect(out[out.length - 1]).toBe(0);
  });
});
