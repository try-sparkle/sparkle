import { describe, it, expect } from "vitest";
import {
  INITIAL_TRIGGER,
  reduceTrigger,
  type TriggerEvent,
  type TriggerState,
} from "./hintTrigger";

// Feed a sequence of events through the reducer; return the final state and whether a tap fired.
function run(events: TriggerEvent[]): { state: TriggerState; taps: number } {
  let state = INITIAL_TRIGGER;
  let taps = 0;
  for (const e of events) {
    const out = reduceTrigger(state, e);
    state = out.state;
    if (out.tapped) taps += 1;
  }
  return { state, taps };
}

describe("reduceTrigger", () => {
  it("fires on a clean Meta down→up tap", () => {
    expect(
      run([
        { type: "keydown", key: "Meta" },
        { type: "keyup", key: "Meta" },
      ]).taps,
    ).toBe(1);
  });

  it("does NOT fire for a chord (Meta held + another key)", () => {
    expect(
      run([
        { type: "keydown", key: "Meta" },
        { type: "keydown", key: "j" },
        { type: "keyup", key: "j" },
        { type: "keyup", key: "Meta" },
      ]).taps,
    ).toBe(0);
  });

  it("does NOT fire for a plain keypress with no Meta", () => {
    expect(
      run([
        { type: "keydown", key: "a" },
        { type: "keyup", key: "a" },
      ]).taps,
    ).toBe(0);
  });

  it("fires once per tap across repeated taps", () => {
    expect(
      run([
        { type: "keydown", key: "Meta" },
        { type: "keyup", key: "Meta" },
        { type: "keydown", key: "Meta" },
        { type: "keyup", key: "Meta" },
      ]).taps,
    ).toBe(2);
  });

  it("ignores a Meta keyup that was never preceded by a Meta keydown", () => {
    // e.g. focus returns mid-chord and we only see the release.
    expect(run([{ type: "keyup", key: "Meta" }]).taps).toBe(0);
  });

  it("resets cleanly so a chord is not 'remembered' into the next tap", () => {
    const { taps } = run([
      { type: "keydown", key: "Meta" },
      { type: "keydown", key: "c" },
      { type: "keyup", key: "Meta" }, // chord — no tap
      { type: "keydown", key: "Meta" },
      { type: "keyup", key: "Meta" }, // clean tap
    ]);
    expect(taps).toBe(1);
  });
});
