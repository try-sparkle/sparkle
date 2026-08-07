import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";

import { SPARKLE_AGENT_ID, sparkleAgentIdFor } from "../services/sparkleAgent";
import {
  PERSON_ID_PREFIX,
  personAgentId,
  isPersonAgentId,
  socialIdFromPersonAgentId,
  availabilityFromWire,
  usernameKey,
  validateUsernameFormat,
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
} from "./social";

describe("engine/social — the person: namespace", () => {
  it("round-trips a social id through the mount id", () => {
    const socialId = randomUUID();
    const mountId = personAgentId(socialId);
    expect(mountId).toBe(`${PERSON_ID_PREFIX}${socialId}`);
    expect(isPersonAgentId(mountId)).toBe(true);
    expect(socialIdFromPersonAgentId(mountId)).toBe(socialId);
  });

  it("is FALSE for a bare agent UUID — the collision the namespace exists to prevent", () => {
    const agentId = randomUUID();
    expect(isPersonAgentId(agentId)).toBe(false);
    expect(socialIdFromPersonAgentId(agentId)).toBeNull();
  });

  it("is FALSE for the app-owned Sparkle agent, canonical and per-window", () => {
    expect(isPersonAgentId(SPARKLE_AGENT_ID)).toBe(false);
    expect(isPersonAgentId(sparkleAgentIdFor("win-abc"))).toBe(false);
    expect(socialIdFromPersonAgentId(SPARKLE_AGENT_ID)).toBeNull();
  });

  it("is FALSE for the bare prefix — `person:` names nobody", () => {
    expect(isPersonAgentId(PERSON_ID_PREFIX)).toBe(false);
    expect(socialIdFromPersonAgentId(PERSON_ID_PREFIX)).toBeNull();
  });

  it("is FALSE for the empty string and for a lookalike that merely contains the prefix", () => {
    expect(isPersonAgentId("")).toBe(false);
    expect(isPersonAgentId(`not-a-${PERSON_ID_PREFIX}abc`)).toBe(false);
  });
});

describe("engine/social — availabilityFromWire", () => {
  // §6.3: green = visibility !== 'unavailable' AND liveness. The point of the table is that the two
  // facts are NOT merged server-side, so every cell is reachable.
  it.each([
    { visibility: "public", online: true, expected: "available" },
    { visibility: "public", online: false, expected: "offline" },
    { visibility: "connections", online: true, expected: "available" },
    { visibility: "connections", online: false, expected: "offline" },
    // "invisible", not "unreachable": an unavailable peer reports offline even while connected.
    { visibility: "unavailable", online: true, expected: "offline" },
    { visibility: "unavailable", online: false, expected: "offline" },
  ] as const)("$visibility + online=$online -> $expected", ({ visibility, online, expected }) => {
    expect(availabilityFromWire({ visibility, online })).toBe(expected);
  });

  it("never reports a PEER as away — away is a local-only state (§5: a coarse boolean, nothing finer)", () => {
    for (const visibility of ["public", "connections", "unavailable"] as const) {
      for (const online of [true, false]) {
        expect(availabilityFromWire({ visibility, online })).not.toBe("away");
      }
    }
  });
});

describe("engine/social — username format (advisory)", () => {
  it("normalizes to the key the server indexes on: trimmed, NFKC, lowercased", () => {
    expect(usernameKey("  DRodio  ")).toBe("drodio");
    // NFKC folds the fullwidth block onto ASCII — which is exactly why the ASCII gate below runs
    // on the RAW input, before this ever gets a chance to make a legal name from an illegal one.
    expect(usernameKey("ａｂｃ")).toBe("abc");
  });

  it.each(["drodio", "a_b", "ab1", "a1_b2_c3", "0a0"])("accepts %s", (name) => {
    const r = validateUsernameFormat(name);
    expect(r).toEqual({ ok: true, key: name.toLowerCase() });
  });

  it("keeps the typed case out of the key but accepts the name", () => {
    expect(validateUsernameFormat("DRodio")).toEqual({ ok: true, key: "drodio" });
  });

  // ── The pinned negative fixtures (§6.1). A rule with no negative fixture is a rule that
  //    silently is not implemented.
  it("REJECTS a__b — consecutive underscores (the flat [a-z0-9_]+ form would accept it)", () => {
    expect(validateUsernameFormat("a__b")).toEqual({ ok: false, reason: "invalid_format" });
  });

  it("REJECTS _ab — a leading underscore", () => {
    expect(validateUsernameFormat("_ab")).toEqual({ ok: false, reason: "invalid_format" });
  });

  it("REJECTS ab_ — a trailing underscore", () => {
    expect(validateUsernameFormat("ab_")).toEqual({ ok: false, reason: "invalid_format" });
  });

  it("REJECTS a name shorter than the minimum, measured on the key", () => {
    expect(validateUsernameFormat("ab")).toEqual({ ok: false, reason: "too_short" });
    expect("ab".length).toBe(USERNAME_MIN_LENGTH - 1);
  });

  it("REJECTS a 31-char name and accepts a 30-char one", () => {
    const thirty = "a".repeat(USERNAME_MAX_LENGTH);
    expect(validateUsernameFormat(thirty)).toEqual({ ok: true, key: thirty });
    expect(validateUsernameFormat(`${thirty}a`)).toEqual({ ok: false, reason: "too_long" });
  });

  it("length is a SEPARATE check, not a quantifier: a 31-char legal-shape name with underscores is too_long", () => {
    // 16 units of "a_" minus the trailing underscore = 31 characters but only 16 repeated units, so
    // any bound expressed as a quantifier on the unit would wave this through.
    const name = "a_".repeat(16).slice(0, -1);
    expect(name).toHaveLength(31);
    expect(name.length).toBeGreaterThan(USERNAME_MAX_LENGTH);
    expect(validateUsernameFormat(name)).toEqual({ ok: false, reason: "too_long" });
  });

  it("REJECTS an empty or whitespace-only name", () => {
    expect(validateUsernameFormat("")).toEqual({ ok: false, reason: "empty" });
    expect(validateUsernameFormat("   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("REJECTS non-ASCII on the RAW input, so NFKC cannot launder an illegal name into a legal one", () => {
    // Fullwidth "abc" normalizes to a perfectly legal "abc"; the raw gate must catch it first.
    expect(usernameKey("ａｂｃ")).toBe("abc");
    expect(validateUsernameFormat("ａｂｃ")).toEqual({ ok: false, reason: "non_ascii" });
    // Cyrillic homoglyphs — the whole class this one line retires.
    expect(validateUsernameFormat("аре")).toEqual({ ok: false, reason: "non_ascii" });
  });

  it("REJECTS punctuation and spaces inside the name", () => {
    for (const bad of ["a b", "a-b", "a.b", "a@b", "a/b"]) {
      expect(validateUsernameFormat(bad)).toEqual({ ok: false, reason: "invalid_format" });
    }
  });
});
