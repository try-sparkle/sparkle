import { describe, it, expect } from "vitest";
import {
  WAKE_PHRASE,
  STOP_PHRASE,
  WAKE_PLACEHOLDER,
  MIC_HOT_PLACEHOLDER,
  wakePlaceholder,
  micHotPlaceholder,
} from "./dictationCopy";

describe("dictationCopy — dynamic placeholders", () => {
  it("called with no arg reproduces the default constants (back-compat)", () => {
    expect(wakePlaceholder()).toBe(WAKE_PLACEHOLDER);
    expect(micHotPlaceholder()).toBe(MIC_HOT_PLACEHOLDER);
  });

  it("wakePlaceholder embeds the given wake word between the fixed prefix/suffix", () => {
    const p = wakePlaceholder("Hey Jarvis");
    expect(p).toContain("Hey Jarvis");
    expect(p).not.toContain(WAKE_PHRASE); // the default phrase is gone
    // Same framing as the default, just a different phrase.
    expect(p.startsWith("Listening for the wake word")).toBe(true);
  });

  it("micHotPlaceholder embeds the given stop phrase", () => {
    const p = micHotPlaceholder("Jarvis, halt");
    expect(p).toContain("Jarvis, halt");
    expect(p).not.toContain(STOP_PHRASE);
    expect(p.startsWith("I'm listening")).toBe(true);
  });
});
