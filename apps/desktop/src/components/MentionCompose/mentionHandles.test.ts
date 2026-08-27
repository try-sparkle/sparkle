import { describe, expect, it } from "vitest";
import {
  candidateTargets,
  isResolved,
  isUnknownHandle,
  leadingHandleQuery,
  parseMention,
  targetOf,
} from "./mentionHandles";

describe("parseMention — the routing decision", () => {
  it("resolves a leading @improve to the improve target and strips the handle from the body", () => {
    const p = parseMention("@improve why is CI red?");
    expect(isResolved(p)).toBe(true);
    if (!isResolved(p)) throw new Error("unreachable");
    // The SIDE EFFECT that matters: the handle the backend will route to, and the body without sigil.
    expect(p.target.handle).toBe("improve");
    expect(p.body).toBe("why is CI red?");
  });

  it("resolves a leading @sparkle to the concierge target", () => {
    const p = parseMention("@sparkle stand down the blocked agents");
    expect(isResolved(p)).toBe(true);
    if (!isResolved(p)) throw new Error("unreachable");
    expect(p.target.handle).toBe("sparkle");
    expect(p.body).toBe("stand down the blocked agents");
  });

  it("is case-insensitive on the handle but preserves body casing", () => {
    const p = parseMention("@Improve Look At CI");
    expect(isResolved(p)).toBe(true);
    if (!isResolved(p)) throw new Error("unreachable");
    expect(p.target.handle).toBe("improve");
    expect(p.body).toBe("Look At CI");
  });

  it("reports an unrecognized leading handle distinctly, carrying the token", () => {
    const p = parseMention("@nobody hello there");
    expect(isUnknownHandle(p)).toBe(true);
    if (!isUnknownHandle(p)) throw new Error("unreachable");
    expect(p.token).toBe("nobody");
    // And it must NOT read as resolved — an unknown handle can never reach the backend.
    expect(isResolved(p)).toBe(false);
  });

  it("does not treat a MID-SENTENCE mention as an address (positional, like composerRoute)", () => {
    // "ask @improve about it" NAMES improve as a subject; it does not address it.
    expect(parseMention("ask @improve about it")).toBeNull();
  });

  it("returns null for plain prose with no leading handle", () => {
    expect(parseMention("just a normal message")).toBeNull();
  });

  it("resolves the handle even when the body is empty (caller rejects the empty send, not the parse)", () => {
    const p = parseMention("@improve");
    expect(isResolved(p)).toBe(true);
    if (!isResolved(p)) throw new Error("unreachable");
    expect(p.body).toBe("");
  });
});

describe("typeahead helpers", () => {
  it("leadingHandleQuery is the token while a leading @… is open with no trailing space", () => {
    expect(leadingHandleQuery("@imp")).toBe("imp");
    expect(leadingHandleQuery("@")).toBe("");
  });

  it("leadingHandleQuery closes (null) once a space commits the handle", () => {
    expect(leadingHandleQuery("@improve ")).toBeNull();
    expect(leadingHandleQuery("@improve hi")).toBeNull();
  });

  it("candidateTargets filters by prefix; empty query offers both", () => {
    expect(candidateTargets("").map((t) => t.handle)).toEqual(["improve", "sparkle"]);
    expect(candidateTargets("imp").map((t) => t.handle)).toEqual(["improve"]);
    expect(candidateTargets("sp").map((t) => t.handle)).toEqual(["sparkle"]);
    expect(candidateTargets("zzz")).toEqual([]);
  });

  it("targetOf maps only the two known handles", () => {
    expect(targetOf("improve")?.handle).toBe("improve");
    expect(targetOf("sparkle")?.handle).toBe("sparkle");
    expect(targetOf("other")).toBeUndefined();
  });
});
