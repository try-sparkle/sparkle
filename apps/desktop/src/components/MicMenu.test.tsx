// The mic glyph color/variant mapping (micVisual): the resting colors each mic surface draws for
// off / preparing / paused / active. Pins the active tint to the left-column "working" green
// (successInk), matching the sidebar's running-agent color. (The three-option hover pill that used
// to live here was removed with the desktop Composer; micVisual is also covered end-to-end in
// voice/micPresentation.test.ts.)
import { describe, expect, it } from "vitest";

import { micVisual } from "./MicButton";
import { C } from "../theme/colors";

describe("micVisual — active is the left-column green (not blue)", () => {
  it("draws the active mic in successInk (the working-status green)", () => {
    expect(micVisual("active", false)).toEqual({ color: C.successInk, variant: "open" });
  });
  it("still draws off (gray slash) and paused (amber pause) unchanged", () => {
    expect(micVisual("off", false)).toEqual({ color: C.muted, variant: "slash" });
    expect(micVisual("paused", false)).toEqual({ color: C.amber, variant: "pause" });
  });
});
