import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SPARKLE_AGENT_ID, sparkleAgentIdFor } from "../services/sparkleAgent";
import {
  PERSON_ID_PREFIX,
  personAgentId,
  isPersonAgentId,
  socialIdFromPersonAgentId,
  availabilityFromWire,
  usernameKey,
  validateUsernameFormat,
  isReservedUsername,
  ADVISORY_RESERVED_USERNAMES,
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

describe("engine/social — the advisory reserved list", () => {
  it.each(["admin", "support", "sparkle", "root", "everyone", "noreply"])(
    "knows %s is reserved before Save is ever pressed",
    (name) => {
      expect(isReservedUsername(name)).toBe(true);
    },
  );

  it("matches on the KEY, so the way a name is typed cannot dodge the check", () => {
    // The server's list is compared against the NFKC-lowercased key (§6.1). A check that only fired
    // for the lowercase spelling would paint "Looks free" for `Admin` — the same lie, one shift key
    // away.
    for (const spelling of ["Admin", "ADMIN", "  admin  ", "AdMiN"]) {
      expect(isReservedUsername(spelling)).toBe(true);
    }
  });

  it("says NOTHING about an ordinary name — the server still decides", () => {
    for (const name of ["ada_l", "support1", "admin1", "alice", "sparkler"]) {
      expect(isReservedUsername(name)).toBe(false);
    }
  });

  // ── `drodio` IS AN ORDINARY NAME ──────────────────────────────────────────────────────────────
  // The headline fix of bead sparkle-3g97m was that the founder can claim `drodio`. It was first
  // built as an OWNER EXEMPTION — the handle stayed reserved server-side and one identity was let
  // through — and this block used to subtract that exemption from the client copy so the pane would
  // not tell the very person being unblocked "That username is reserved." The exemption keyed off
  // the super-admin email allowlist, which the address he actually signs in with is not on, so it
  // never unblocked him; at his instruction the RESERVATION itself was removed instead, and the
  // exemption machinery went with it. So there is nothing to subtract any more: the handle is
  // absent from both lists and this asserts it stays that way, because the pane's check runs BEFORE
  // Save and no server round trip can correct it.
  it("does NOT claim `drodio` is reserved, in any casing", () => {
    expect(isReservedUsername("drodio")).toBe(false);
    expect(isReservedUsername("DROdio")).toBe(false);
    expect(isReservedUsername("DRODIO")).toBe(false);
    expect(isReservedUsername("  drodio  ")).toBe(false);
  });

  it("does not claim a CONFUSABLE of it is reserved either — skeleton protection went too", () => {
    // The client never knew how to skeletonize, so this half was always the server's to answer;
    // what changed is the server's answer. Asserted here so the client copy is not "helpfully"
    // widened to re-add by hand what the server no longer refuses.
    for (const name of ["dr0dio", "dr_odio", "drod1o"]) {
      expect(isReservedUsername(name)).toBe(false);
    }
  });

  it("still passes the FORMAT check — nothing about the handle is refused locally", () => {
    // The two checks are independent, and the claim must be able to reach the network. A `reserved`
    // reason may never come out of the format validator (see its docstring).
    expect(validateUsernameFormat("DROdio")).toEqual({ ok: true, key: "drodio" });
    expect(validateUsernameFormat("admin")).toEqual({ ok: true, key: "admin" });
  });
});

// ── THE DRIFT GUARD ─────────────────────────────────────────────────────────────────────────────
//
// Two hardcoded lists in two apps WILL drift. The desktop copy exists only because the server's is
// frozen ("changing the set is a code change + PR"), and that promise is worth exactly as much as
// this test: it reads the orchestration file FROM DISK and pins
//
//     ADVISORY_RESERVED_USERNAMES  ===  RESERVED_USERNAMES
//
// EXACT equality, with nothing subtracted. It used to be "minus the owner-exempt handles", a set
// holding exactly one name (`drodio`); the reservation and its exemption were both retired, so the
// subtraction has nothing left to subtract and an escape hatch that can explain away a difference
// is precisely what a drift guard must not have.
//
// It reads the source text rather than importing the module on purpose. `apps/orchestration` is a
// separate package with its own build and its own deps; a static import here would couple the
// desktop test run to it, and the point is to notice an edit to a FILE, which is a thing that can
// be read without being loaded.
describe("engine/social — the reserved list does not drift from the server's", () => {
  const policyPath = fileURLToPath(
    new URL("../../../orchestration/src/lib/usernamePolicy.ts", import.meta.url),
  );
  const source = readFileSync(policyPath, "utf8");

  /** Comments FIRST, always. The server's list has `// NOT "no-reply": …` and `// "me" is omitted
   *  deliberately` sitting inside it, so a naive string-literal sweep harvests two names that are
   *  not entries — and the failure would read as a genuine drift. */
  const stripComments = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  /**
   * The text of `export const <NAME>`'s literal, from its opening bracket to the first closing one.
   *
   * Scanned from the `=`, NOT from the declaration, and that is not a detail: the type annotation
   * gets there first. `export const RESERVED_USERNAMES: readonly string[] = Object.freeze([` has
   * its first `[` *and* its first `]` inside `string[]`, so the obvious version of this slices out
   * six characters of type syntax, extracts zero names, and compares two empty sets — the exact
   * silent-agreement failure the vacuity guard below exists to catch (it did catch it).
   */
  const blockFor = (name: string, open: "[" | "{", close: "]" | "}"): string | null => {
    const decl = source.indexOf(`export const ${name}`);
    if (decl === -1) return null;
    const eq = source.indexOf("=", decl);
    const start = eq === -1 ? -1 : source.indexOf(open, eq);
    const end = start === -1 ? -1 : source.indexOf(close, start);
    return end === -1 ? null : stripComments(source.slice(start, end));
  };

  const serverReserved = (() => {
    const block = blockFor("RESERVED_USERNAMES", "[", "]");
    if (block === null) return null;
    // `flatMap` rather than `map`: under `noUncheckedIndexedAccess` a capture group is
    // `string | undefined`, and this is the one place a widened type would be load-bearing —
    // an `undefined` in the extracted set compares unequal to every real name and would report
    // a drift that is not there.
    return [...block.matchAll(/["'`]([a-z0-9_]+)["'`]/g)].flatMap((m) => (m[1] ? [m[1]] : []));
  })();

  // THE VACUITY GUARD, and it is not decoration: every assertion below compares two sets, and two
  // EMPTY sets are equal. A regex that silently stopped matching (the server reformats the literal,
  // switches quote style, wraps it differently) would turn this whole block green while the lists
  // drifted freely. So the extraction is asserted to have WORKED before anything is compared.
  it("actually extracted the server's list — a parse failure must not read as agreement", () => {
    expect(serverReserved, `could not find RESERVED_USERNAMES in ${policyPath}`).not.toBeNull();
    expect(serverReserved!.length).toBeGreaterThan(20);
    // Spot-checks, so a regex that matched the wrong literal is caught too.
    expect(serverReserved).toContain("admin");
    expect(serverReserved).toContain("sparkle");
  });

  it("the desktop list is EXACTLY the server's — nothing subtracted", () => {
    const expected = [...serverReserved!].sort();
    const actual = [...ADVISORY_RESERVED_USERNAMES].sort();

    const missing = expected.filter((n) => !actual.includes(n));
    const extra = actual.filter((n) => !expected.includes(n));

    expect(
      { missing, extra },
      `apps/desktop/src/engine/social.ts ADVISORY_RESERVED_USERNAMES has drifted from ` +
        `apps/orchestration/src/lib/usernamePolicy.ts RESERVED_USERNAMES.\n` +
        `  MISSING from the desktop copy: ${missing.join(", ") || "(none)"}\n` +
        `  EXTRA in the desktop copy:     ${extra.join(", ") || "(none)"}\n` +
        `Fix the desktop list — do NOT delete an entry from the server's to make this pass.`,
    ).toEqual({ missing: [], extra: [] });
  });

  it("`drodio` is in NEITHER list — the retirement holds on both sides", () => {
    // The specific regression the headline fix cannot survive, asserted on its own so the exact-set
    // comparison above is not the only thing standing between the founder and his handle: that test
    // stays green if a well-meaning sync-the-lists commit re-adds the entry to BOTH copies, which is
    // exactly the shape such a commit takes.
    expect(
      serverReserved,
      "`drodio` was re-added to the server's RESERVED_USERNAMES — see the ⚠️ note on that list",
    ).not.toContain("drodio");
    expect(ADVISORY_RESERVED_USERNAMES).not.toContain("drodio");
  });

  it("no PROTECTED_HANDLES entry names a person — every one of them is Sparkle or a role", () => {
    // The other half of the retirement: skeleton protection is derived from PROTECTED_HANDLES and
    // nothing else, so leaving `drodio` there would keep `dr0dio`/`dr_odio` refused as
    // `impersonation` while the plain spelling was free — the confusing half-state the removal
    // exists to avoid.
    const block = blockFor("PROTECTED_HANDLES", "[", "]");
    expect(block, `could not find PROTECTED_HANDLES in ${policyPath}`).not.toBeNull();
    const protectedHandles = [...block!.matchAll(/["'`]([a-z0-9_]+)["'`]/g)].flatMap((m) =>
      m[1] ? [m[1]] : [],
    );
    expect(protectedHandles.length).toBeGreaterThan(3);
    expect(protectedHandles).toContain("sparkle");
    expect(protectedHandles).not.toContain("drodio");

    // And the containment the server's own header promises, re-checked from here because the two
    // lists are read from one file but consumed by two apps.
    for (const handle of protectedHandles) {
      expect(
        serverReserved,
        `"${handle}" is protected but absent from RESERVED_USERNAMES — its legitimate holder ` +
          `would be told they were impersonating themselves`,
      ).toContain(handle);
    }
  });
});
