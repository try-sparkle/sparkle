import { describe, it, expect } from "vitest";
import { capForRoster } from "./controlListener";
import { hasLoneSurrogate } from "./safeText";

// `capForRoster` caps author-supplied goal prose for the roster row, and its output rides into
// `control_respond`'s args — which serde_json parses WHOLE. A cut that split a UTF-16 surrogate pair
// used to leave a lone surrogate that serde_json rejects ("unexpected end of hex escape"), dropping
// the entire reply silently (the exact flood documented in services/safeText.ts, on an unguarded
// sibling boundary). These tests assert the SIDE EFFECT the fix guarantees — the output is always
// well-formed UTF-16 — and that well-formed BMP text is untouched.
describe("capForRoster surrogate safety", () => {
  const CAP = 120; // ROSTER_TEXT_CAP

  it("never emits a lone surrogate when the cut lands inside an emoji", () => {
    // 😀 is a surrogate PAIR. Placed so the cut at CAP-1 falls between its two code units, a plain
    // `.slice()` would keep only the leading half — a lone surrogate. Total length > CAP so the
    // truncation branch runs.
    const input = "a".repeat(CAP - 2) + "😀" + "bbbb";
    expect(input.length).toBeGreaterThan(CAP);
    // Sanity: the naive slice this fix replaces DOES leave a lone surrogate here — so the assertion
    // below is not vacuous.
    expect(hasLoneSurrogate(input.slice(0, CAP - 1))).toBe(true);

    const out = capForRoster(input);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out.endsWith("…")).toBe(true);
    // Cap is still honoured (the dropped half-char plus the ellipsis stay within the budget).
    expect(out.length).toBeLessThanOrEqual(CAP);
  });

  it("repairs a lone surrogate that arrived malformed in short text", () => {
    const malformedShort = "hi \uD83C there"; // a lone high surrogate, under the cap
    expect(malformedShort.length).toBeLessThanOrEqual(CAP);
    expect(hasLoneSurrogate(malformedShort)).toBe(true);
    expect(hasLoneSurrogate(capForRoster(malformedShort))).toBe(false);
  });

  it("leaves well-formed short text byte-identical", () => {
    expect(capForRoster("ship the parser")).toBe("ship the parser");
  });

  it("caps well-formed long BMP text exactly as the plain slice did", () => {
    const long = "x".repeat(200);
    expect(capForRoster(long)).toBe("x".repeat(CAP - 1) + "…");
  });

  it("keeps a whole emoji that lands wholly before the cut", () => {
    const input = "😀" + "z".repeat(200);
    const out = capForRoster(input);
    expect(out.startsWith("😀")).toBe(true);
    expect(hasLoneSurrogate(out)).toBe(false);
  });
});
