import { describe, expect, it } from "vitest";
import { resolveAgentMention } from "../agentMentionResolve";
import { SPECIAL_CANDIDATES, resolveSpecialHandle } from "./specialTargets";

describe("the app-global handles", () => {
  // Driven through the REAL resolver rather than by inspecting the array, because "the entry exists"
  // is not the claim that matters — "typing @improve reaches the improvement agent" is.
  const resolve = (token: string) => resolveAgentMention(SPECIAL_CANDIDATES, token);

  it("@improve resolves — the handle from the incident that commissioned this feature", () => {
    const r = resolve("improve");
    expect(r.kind).toBe("ok");
    expect(r.kind === "ok" && r.id).toBe("__sparkle_self__");
  });

  it("resolves the improvement agent by its full display name too", () => {
    const r = resolve("Improve Sparkle");
    expect(r.kind === "ok" && r.id).toBe("__sparkle_self__");
  });

  it("@sparkle and @concierge both reach the concierge", () => {
    for (const token of ["sparkle", "concierge"]) {
      const r = resolve(token);
      expect(r.kind === "ok" && r.id).toBe("sparkle:concierge");
    }
  });

  it("two spellings of one target are NOT an ambiguity — they are the same agent", () => {
    // A target listed under two names must never resolve to `ambiguous`; that would refuse the most
    // common handle in the fleet. Ambiguity is about two AGENTS answering to one name.
    for (const token of ["improve", "sparkle"]) {
      expect(resolve(token).kind).toBe("ok");
    }
  });

  it("matches the CAPITALIZED spellings the app itself teaches", () => {
    // `@Sparkle` (capital S) is documented as the mention handle, is what the concierge composer
    // reserves, and is what speech dictation produces — while the parser and resolver are exact and
    // case-SENSITIVE by design. Registering these lowercase-only made the single most likely handle
    // in the fleet resolve to nobody, and post a false "matches no agent" refusal onto a bead.
    expect(resolveSpecialHandle("Sparkle")?.id).toBe("sparkle:concierge");
    expect(resolveSpecialHandle("Improve")?.id).toBe("__sparkle_self__");
    expect(resolveSpecialHandle("Concierge")?.id).toBe("sparkle:concierge");
    expect(resolveSpecialHandle("IMPROVE SPARKLE")?.id).toBe("__sparkle_self__");
  });

  it("agrees with the Rust authority's handle set (mention.rs::resolve_handle)", () => {
    // `mention.rs` owns the same four spellings and lowercases before matching. Two tables for one
    // vocabulary drift on the first edit either side makes, and neither suite can see the other —
    // so this is the assertion that notices.
    for (const handle of ["improve", "sparkle", "concierge"]) {
      expect(resolveSpecialHandle(handle)).not.toBeNull();
    }
    expect(resolveSpecialHandle("improve")?.id).toBe("__sparkle_self__");
    expect(resolveSpecialHandle("sparkle")?.id).toBe("sparkle:concierge");
    expect(resolveSpecialHandle("concierge")?.id).toBe("sparkle:concierge");
  });

  it("does not resolve a handle that merely CONTAINS a reserved one", () => {
    expect(resolveSpecialHandle("improve-later")).toBeNull();
    expect(resolveSpecialHandle("")).toBeNull();
  });

  it("does not turn an unrelated handle into one of them", () => {
    expect(resolve("improve-later").kind).toBe("unknown");
  });
});
