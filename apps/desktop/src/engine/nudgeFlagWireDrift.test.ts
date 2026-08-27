// nudgeFlagWireDrift — the pin the false layering rule was standing in for. Bead sparkle-4r68r7.
//
// ── WHAT WAS WRONG ────────────────────────────────────────────────────────────────────────────
// `engine/humanBlock.ts` and `engine/loginStanddown.ts` each declare a small structural interface
// (`HumanBlockFlag`, `LoginStanddownFlag`) restating the handful of fields they read off
// `services/authRecovery.NudgeFlag`. Both justified NOT importing the real type with the same
// sentence: "`engine/` keeps its no-dependency-on-`services/` direction". THAT RULE DOES NOT
// EXIST — nothing in this repo enforces an engine→services boundary, and most non-test `engine/*`
// modules import from `../services` today. A third site, `engine/projectIdentity.ts`, had already
// used the identical claim to justify a hand-copied helper before anyone checked it.
//
// Narrowing the shape is still the right call — it is a FOUR-field contract against a NINE-field
// wire mirror, so a test builds a literal without inventing `nudges`/`delivered`/`silentSecs`, and
// widening `NudgeFlag` cannot change what these modules read. But the reason is NARROWNESS, not
// layering, and narrowness carries a cost the false rule was hiding:
//
// ── THE COST, AND WHY ASSIGNABILITY CANNOT PIN IT ─────────────────────────────────────────────
// A hand-restated wire shape drifts silently (AGENTS.md, `sparkle-16y6h`). And the obvious pin —
// "does `NudgeFlag` satisfy `LoginStanddownFlag`?" — is VACUOUS here, because every field these
// modules actually turn on is OPTIONAL. `standdown?: string | null` and `account?: string | null`
// are satisfied by an object that has neither, so `{} as NudgeFlag` passes an assignability check.
// Rename `standdown` on the wire type and `loginStanddownOf` returns `undefined` forever, the
// founder-level escalation that bead `sparkle-qg71dl` exists to deliver silently stops arriving,
// and the entire desktop suite stays green.
//
// So this file pins the field NAMES, not the assignability, and then drives a literal typed
// against the REAL `NudgeFlag` through the REAL engine functions. Two failure directions, both
// covered: the wire type moving (typecheck reds) and the engine forgetting to read a field it
// declares (these assertions red).

import { describe, expect, it } from "vitest";

import type { NudgeFlag } from "../services/authRecovery";
import { humanBlockOf, type HumanBlockFlag } from "./humanBlock";
import { loginStanddownOf, type LoginStanddownFlag } from "./loginStanddown";

// ── COMPILE-TIME PINS ─────────────────────────────────────────────────────────────────────────

/** `true` only while every key the engine shape declares is still a key of the wire type. */
type DeclaredKeysStillOnWire<Declared> =
  Exclude<keyof Declared, keyof NudgeFlag> extends never ? true : never;

/** `true` only while the wire type's own version of those fields still fits what the engine says. */
type WireFieldsStillFit<Declared> =
  Pick<NudgeFlag, Extract<keyof Declared, keyof NudgeFlag>> extends Declared ? true : never;

// A `never` on either half makes the intersection `never`, and `= true` stops compiling. That is
// the whole assertion; the runtime `expect` below exists so the pin is not an unused local.
const humanBlockPin: DeclaredKeysStillOnWire<HumanBlockFlag> & WireFieldsStillFit<HumanBlockFlag> =
  true;
const loginStanddownPin: DeclaredKeysStillOnWire<LoginStanddownFlag> &
  WireFieldsStillFit<LoginStanddownFlag> = true;

// ── REAL WIRE LITERALS ────────────────────────────────────────────────────────────────────────
// `satisfies NudgeFlag` on an object LITERAL is the strict form: a renamed field shows up twice
// over, as a missing property and as an excess one. These are deliberately not built by a factory,
// because a spread would weaken the excess-property check that catches exactly that.

/** A login-expired flag as `nudger.rs` publishes it and `services/authRecovery` mirrors it. */
const loginExpiredWireFlag = {
  agentId: "agent-1",
  target: "founder",
  raisedAtMs: 1_000,
  nudges: 4,
  delivered: 4,
  blockedBy: null,
  silentSecs: 900,
  // Null BY CONSTRUCTION on this population — answering costs the API call that is failing.
  reply: null,
  standdown: "login-expired",
  account: "work",
} satisfies NudgeFlag;

/** The same wire shape carrying the agent's OWN answer instead of a stand-down. */
const blockedOnHumanWireFlag = {
  agentId: "agent-2",
  target: "founder",
  raisedAtMs: 2_000,
  nudges: 2,
  delivered: 2,
  blockedBy: null,
  silentSecs: 300,
  reply: "blocked-on-human",
  standdown: null,
  account: null,
} satisfies NudgeFlag;

describe("the engine's narrowed nudger-flag shapes against the real NudgeFlag", () => {
  it("carries a real login-expired wire flag all the way to a founder-level stand-down", () => {
    // The SIDE EFFECT, not the shape: this reds if `standdown` or `account` stops being read, and
    // (via the `satisfies` above) if the wire type stops carrying them under those names.
    expect(loginStanddownOf(loginExpiredWireFlag)).toEqual({ account: "work", raisedAtMs: 1_000 });
  });

  it("carries a real blocked-on-human wire flag all the way to a human block", () => {
    expect(humanBlockOf(blockedOnHumanWireFlag)).toEqual({ raisedAtMs: 2_000 });
  });

  it("keeps the compile-time key pins live", () => {
    // Worthless at runtime by design — the assertion happened at `tsc`. Present so the pins are
    // referenced, and so deleting them shows up as a deleted test rather than a silent removal.
    expect([humanBlockPin, loginStanddownPin]).toEqual([true, true]);
  });
});
