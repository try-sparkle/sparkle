// THE TYPESCRIPT HALF OF THE `dictation://capture-missed` SEAM (roborev 61729).
//
// The payload crosses from Rust as JSON and decides which REMEDY the user is shown — "hold the key
// a moment longer" for a capture race, "try again in a moment" for a model load. Those are not
// interchangeable: no achievable hold clears a 46-second ONNX init. Before this, the whole contract
// was two inline `json!` literals in Rust and a hand-written TS type with nothing pinning them, so
// a renamed key produced `{stage: undefined}`, fell back to the capture branch, and reinstated the
// exact defect the stage split fixed — with no type error and no failing test.
//
// The payloads come from `src/fixtures/captureMissed.json`, the SAME file the Rust test parses via
// include_str! — not a copy of it. That is what makes "the two suites fail together" true rather
// than aspirational: an earlier version asserted hand-written literals on each side and merely
// claimed the coupling, which a coordinated Rust-side rename would have defeated silently.
import { describe, it, expect } from "vitest";
import { missedStageOf } from "./useDictation";
import fixture from "./fixtures/captureMissed.json";

describe("the capture-missed wire contract", () => {
  it("reads the exact payloads Rust emits", () => {
    expect(missedStageOf(fixture.model)).toBe("model");
    expect(missedStageOf(fixture.capture)).toBe("capture");
  });

  it("falls back to the CAPTURE remedy for anything it cannot read", () => {
    // The safe default: telling someone to hold longer when the cause was a model load costs one
    // wasted attempt, while "try again in a moment" against a real capture race is advice that
    // never clears. Covers a dropped key, a renamed key, a null payload, and the pre-change shape
    // (a bare number), which is what a half-deployed rename would actually look like.
    expect(missedStageOf({ ms: 100 })).toBe("capture");
    expect(missedStageOf({ phase: "model", ms: 100 })).toBe("capture");
    expect(missedStageOf(null)).toBe("capture");
    expect(missedStageOf(undefined)).toBe("capture");
    expect(missedStageOf(2083)).toBe("capture");
  });

  it("does not treat a near-miss token as the model stage", () => {
    // Only the exact token counts — a loose check (substring, startsWith) would let "modelling" or
    // "model_load" through and is the shape that rots quietly.
    expect(missedStageOf({ stage: "Model" })).toBe("capture");
    expect(missedStageOf({ stage: "model_load" })).toBe("capture");
  });
});
