import { describe, expect, it } from "vitest";
import {
  buildNotice,
  senderDisplayName,
  truncatePreview,
  verbFor,
  type CrossAgentMention,
} from "./crossAgentNotice";

describe("verbFor — the interaction verb selection", () => {
  it("a request from Improve reads as asking the concierge for feedback", () => {
    expect(verbFor("improve", "request")).toBe("asked for my feedback");
  });
  it("a request from the concierge reads as requesting Improve Sparkle's feedback", () => {
    expect(verbFor("sparkle", "request")).toBe("requested Improve Sparkle's feedback");
  });
  it("a response reads as 'responded' from either side", () => {
    expect(verbFor("improve", "response")).toBe("responded");
    expect(verbFor("sparkle", "response")).toBe("responded");
  });
  it("a challenge reads as 'challenged'", () => {
    expect(verbFor("improve", "challenge")).toBe("challenged");
  });
});

describe("senderDisplayName", () => {
  it("names Improve-Sparkle and the concierge distinctly", () => {
    expect(senderDisplayName("improve")).toBe("Improve Sparkle");
    expect(senderDisplayName("sparkle")).toBe("Concierge");
  });
});

describe("truncatePreview", () => {
  it("leaves a short body untouched and adds no ellipsis", () => {
    expect(truncatePreview("short and sweet")).toBe("short and sweet");
  });
  it("caps a long body at the limit and appends an ellipsis", () => {
    const body = "x".repeat(250);
    const out = truncatePreview(body, 100);
    expect(out.endsWith("…")).toBe(true);
    // 100 chars + the one ellipsis glyph.
    expect(out.length).toBe(101);
    expect(out.slice(0, 100)).toBe("x".repeat(100));
  });
  it("flattens newlines and collapses whitespace to one line before counting", () => {
    expect(truncatePreview("line one\n\nline   two\ttab")).toBe("line one line two tab");
  });
  it("respects a custom cap", () => {
    expect(truncatePreview("abcdefghij", 4)).toBe("abcd…");
  });
});

describe("buildNotice — the whole view-model", () => {
  const base: CrossAgentMention = {
    id: "c1",
    from: "improve",
    interaction: "request",
    beadId: "sparkle-hdlhox",
    body: "should PR #2153 supersede the artifact fixes? " + "detail ".repeat(40),
  };

  it("assembles sender, verb, bead id, and a truncated preview", () => {
    const v = buildNotice(base, 100);
    expect(v.senderName).toBe("Improve Sparkle");
    expect(v.verb).toBe("asked for my feedback");
    expect(v.beadId).toBe("sparkle-hdlhox");
    expect(v.preview.length).toBeLessThanOrEqual(101);
    expect(v.preview.endsWith("…")).toBe(true);
    expect(v.preview.startsWith("should PR #2153 supersede")).toBe(true);
  });

  it("carries the interaction through to the verb — a response is 'responded'", () => {
    const v = buildNotice({ ...base, from: "sparkle", interaction: "response", body: "agreed." });
    expect(v.senderName).toBe("Concierge");
    expect(v.verb).toBe("responded");
    expect(v.preview).toBe("agreed.");
  });
});
