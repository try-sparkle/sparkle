import { describe, expect, it } from "vitest";
import type { BeadComment } from "../../services/beadsCommands";
import {
  DEFAULT_INTERACTION,
  parseCrossAgentComment,
  senderFromAuthor,
  splitInteractionTag,
} from "./crossAgentComment";

function comment(over: Partial<BeadComment>): BeadComment {
  return { id: "c1", author: "Improve Sparkle [abc]", text: "[request] hello", createdAt: null, ...over };
}

describe("senderFromAuthor", () => {
  it("maps an author naming improve to the improve sender", () => {
    expect(senderFromAuthor("Improve Sparkle [abc]")).toBe("improve");
  });
  it("maps concierge / sparkle authors to the sparkle sender", () => {
    expect(senderFromAuthor("concierge")).toBe("sparkle");
    expect(senderFromAuthor("Sparkle")).toBe("sparkle");
  });
  it("returns null for a human or third-party author (and for null)", () => {
    expect(senderFromAuthor("DROdio")).toBeNull();
    expect(senderFromAuthor(null)).toBeNull();
  });
});

describe("splitInteractionTag", () => {
  it("pulls a leading [request] / [response] / [challenge] tag and strips it from the body", () => {
    expect(splitInteractionTag("[request] take a look")).toEqual({ interaction: "request", body: "take a look" });
    expect(splitInteractionTag("[RESPONSE] agreed")).toEqual({ interaction: "response", body: "agreed" });
    expect(splitInteractionTag("[challenge] I disagree")).toEqual({ interaction: "challenge", body: "I disagree" });
  });
  it("defaults an untagged body to the neutral interaction, keeping the whole text", () => {
    expect(splitInteractionTag("no tag here")).toEqual({ interaction: DEFAULT_INTERACTION, body: "no tag here" });
  });
});

describe("parseCrossAgentComment", () => {
  it("decodes a tagged agent comment into a full cross-agent mention on the given bead", () => {
    const m = parseCrossAgentComment(
      comment({ id: "x1", author: "concierge", text: "[request] please review", createdAt: "2026-08-19T10:00:00Z" }),
      "sparkle-hdlhox",
    );
    expect(m).not.toBeNull();
    expect(m).toMatchObject({
      id: "x1",
      from: "sparkle",
      interaction: "request",
      beadId: "sparkle-hdlhox",
      body: "please review",
    });
    expect(typeof m!.ts).toBe("number");
  });

  it("returns null for a comment whose author is neither agent (a human comment must not render)", () => {
    expect(parseCrossAgentComment(comment({ author: "DROdio", text: "[request] hi" }), "b1")).toBeNull();
  });

  it("keeps an untagged agent comment (as a response) rather than dropping a real exchange", () => {
    const m = parseCrossAgentComment(comment({ author: "Improve Sparkle", text: "just a note" }), "b1");
    expect(m?.interaction).toBe("response");
    expect(m?.body).toBe("just a note");
  });
});
