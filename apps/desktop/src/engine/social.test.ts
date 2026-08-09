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
  OWNER_EXEMPT_HANDLES,
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

  // ── THE OWNER EXEMPTION ───────────────────────────────────────────────────────────────────────
  // The headline fix of bead sparkle-3g97m is that the founder can claim `drodio`. The server half
  // exempts its owner; if the CLIENT list carried the handle, this pane would tell the very person
  // being unblocked "That username is reserved." and gate him out of his own fix — with no server
  // round trip to correct it, since the check runs before Save. This is the assertion that stops a
  // future sync-the-lists commit from pasting the entry back in.
  it("does NOT claim an owner-exempt handle is reserved, in any casing", () => {
    for (const handle of OWNER_EXEMPT_HANDLES) {
      expect(isReservedUsername(handle)).toBe(false);
      expect(isReservedUsername(handle.toUpperCase())).toBe(false);
    }
    // Named explicitly as well as looped: the loop is vacuous if the exempt list is ever emptied.
    expect(OWNER_EXEMPT_HANDLES).toContain("drodio");
    expect(isReservedUsername("drodio")).toBe(false);
    expect(isReservedUsername("DROdio")).toBe(false);
  });

  it("still passes the FORMAT check for an exempt handle — nothing about it is refused locally", () => {
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
//     ADVISORY_RESERVED_USERNAMES  ===  RESERVED_USERNAMES  minus  the owner-exempt handles
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

  /**
   * The exempt set, read from the server's `HANDLE_OWNERS` map when it is there.
   *
   * ⚠️ It may NOT be there: the orchestration half of this bead adds that map in a PARALLEL branch,
   * and this test has to be correct on a base that predates it as well as on the merge. So it falls
   * back to the desktop's own {@link OWNER_EXEMPT_HANDLES} — which still pins the RESERVED half in
   * full, and still fails the moment the two lists disagree about anything else. The fallback is
   * reported in the failure message so a red run is never ambiguous about which mode it ran in.
   */
  const exempt = (() => {
    const block = blockFor("HANDLE_OWNERS", "{", "}");
    if (block === null) return { handles: [...OWNER_EXEMPT_HANDLES], fromServer: false };
    const keys = [...block.matchAll(/(?:[{,]|^)\s*["'`]?([a-z0-9_]+)["'`]?\s*:/gm)].flatMap((m) =>
      m[1] ? [m[1]] : [],
    );
    return { handles: keys, fromServer: true };
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
    expect(serverReserved).toContain("drodio");
  });

  it("every owner-exempt handle IS reserved server-side — otherwise the exemption is about nothing", () => {
    expect(exempt.handles.length).toBeGreaterThan(0);
    for (const handle of exempt.handles) {
      expect(
        serverReserved,
        `"${handle}" is treated as owner-exempt but is not in the server's RESERVED_USERNAMES`,
      ).toContain(handle);
    }
  });

  it("the desktop list is EXACTLY the server's minus the owner-exempt handles", () => {
    const expected = [...serverReserved!].filter((n) => !exempt.handles.includes(n)).sort();
    const actual = [...ADVISORY_RESERVED_USERNAMES].sort();

    const missing = expected.filter((n) => !actual.includes(n));
    const extra = actual.filter((n) => !expected.includes(n));
    const how = exempt.fromServer
      ? "exempt handles read from the server's HANDLE_OWNERS"
      : `HANDLE_OWNERS not present yet — exempt handles taken from OWNER_EXEMPT_HANDLES (${OWNER_EXEMPT_HANDLES.join(", ")})`;

    expect(
      { missing, extra },
      `apps/desktop/src/engine/social.ts ADVISORY_RESERVED_USERNAMES has drifted from ` +
        `apps/orchestration/src/lib/usernamePolicy.ts RESERVED_USERNAMES.\n` +
        `  ${how}\n` +
        `  MISSING from the desktop copy: ${missing.join(", ") || "(none)"}\n` +
        `  EXTRA in the desktop copy:     ${extra.join(", ") || "(none)"}\n` +
        `Fix the desktop list — do NOT delete an entry from the server's to make this pass.`,
    ).toEqual({ missing: [], extra: [] });
  });

  it("no owner-exempt handle leaked into the desktop copy", () => {
    // The specific regression the headline fix cannot survive, asserted on its own so the diff
    // above is not the only thing standing between the founder and his handle.
    for (const handle of exempt.handles) {
      expect(ADVISORY_RESERVED_USERNAMES).not.toContain(handle);
    }
  });
});
