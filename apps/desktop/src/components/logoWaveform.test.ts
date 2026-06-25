import { describe, it, expect } from "vitest";
import { captionFor } from "./LogoWaveform";

describe("captionFor", () => {
  it("passive + enabled → wake hint", () =>
    expect(captionFor("passive", true)).toBe("Just say Sparkle to talk to me"));
  it("active + enabled → stop hint", () =>
    expect(captionFor("active", true)).toBe("Just say Send It to stop"));
  it("muted → no caption", () => expect(captionFor("passive", false)).toBeNull());
});
