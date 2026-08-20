// THE PRODUCTION FOLD — the one piece of wiring that TRANSFORMS a verdict rather than forwarding a
// value, and therefore the one place a bug would be completely invisible.
//
// `spendGate.ts` is pure and has 14 tests. None of them can see this function. If the fold
// re-projected a REFUSAL into a shape the single-payload gate reads as PERMISSION, every one of
// those tests would still pass while the machine spent money — which is exactly the "both halves
// green, the seam broken" failure AGENTS.md records. So the round trip is asserted here: fold N
// account payloads down, then run the result back through the gate `pass.ts` actually calls, and
// assert the verdict survived.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocked at the MODULE boundary so the production defaults inside `readUsageForAllAccounts` execute
// — see "the production reader" below for why injecting them instead is the vacuous shape.
const usageMock = vi.fn();
const accountsMock = vi.fn();
vi.mock("../accountUsage", () => ({ getAccountUsageLive: (...a: unknown[]) => usageMock(...a) }));
vi.mock("../accountStore", () => ({ listAccounts: () => accountsMock() }));

const { readUsageForAllAccounts } = await import("./deps");
import { checkSpendGate, type UsagePayloadForGate } from "./spendGate";

const DISARMED: UsagePayloadForGate = { extraUsage: { isEnabled: false, usedCredits: 5 } };
const ARMED: UsagePayloadForGate = { extraUsage: { isEnabled: true } };

beforeEach(() => {
  usageMock.mockReset();
  accountsMock.mockReset();
});

/** The round trip `pass.ts` performs: fold, then gate. */
async function verdictFor(payloads: Array<UsagePayloadForGate | Error>) {
  const read = vi.fn(async (dir: string) => {
    const p = payloads[Number(dir)]!;
    if (p instanceof Error) throw p;
    return p;
  });
  const list = async () => payloads.map((_p, i) => ({ configDir: String(i) }));
  return checkSpendGate(await readUsageForAllAccounts(read, list));
}

describe("the production account fold, round-tripped through the gate pass.ts calls", () => {
  it("PERMITS only when every account is disarmed, and carries the summed credits", async () => {
    const v = await verdictFor([DISARMED, DISARMED]);
    expect(v).toEqual({ allowed: true, usedCreditsBefore: 10 });
  });

  it("REFUSES with 'credits-armed' when one account is armed", async () => {
    // The projection must preserve WHICH refusal it was, not merely that it refused — the audit
    // note the founder reads days later has to name the actual reason.
    const v = await verdictFor([DISARMED, ARMED]);
    expect(v).toEqual({ allowed: false, reason: "credits-armed" });
  });

  it("REFUSES with 'spend-limit-reached', not with the disarmed permission beside it", async () => {
    const v = await verdictFor([{ extraUsage: { isEnabled: false, spendLimitReached: true } }]);
    expect(v).toEqual({ allowed: false, reason: "spend-limit-reached" });
  });

  it("REFUSES when one account's usage read THROWS", async () => {
    // An account whose meter cannot be read is an account whose meter is unknown, and an unknown
    // meter is not permission. This is the row a `catch { return DISARMED }` would invert.
    const v = await verdictFor([DISARMED, new Error("keychain refused")]);
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toBe("usage-unreadable");
  });

  it("REFUSES when one account's payload carries no readable extra_usage", async () => {
    const v = await verdictFor([DISARMED, { extraUsage: {} }]);
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toBe("usage-field-absent");
  });

  it("REFUSES when there are NO registered accounts", async () => {
    // Nothing was checked, so nothing may be permitted. On a machine with no accounts this is the
    // whole gate.
    const v = await verdictFor([]);
    expect(v.allowed).toBe(false);
  });

});

// ── THE PRODUCTION READER — driven with NO ARGUMENTS, so the DEFAULTS execute ───────────────────
//
// Everything above injects `read` and `list`, which means the default expressions — the one place
// the untypeable `AccountUsageLive` projection and the `force` decision actually live — run in no
// test at all. That is precisely the `deps = realThing` shape this file's own header says it
// rejects, so the block below calls `readUsageForAllAccounts()` bare against a mocked module
// boundary instead.
describe("the production reader", () => {
  it("does NOT force the read — a forced read pops a macOS keychain prompt per account", async () => {
    // THE ASSERTION HAS TO BE ON `getAccountUsageLive`, NOT on an injected reader. `force` is
    // decided inside the DEFAULT reader, so a test that injects its own `read` and checks the loop
    // passed it one argument has grip on the wrong function: change the default to
    // `getAccountUsageLive(dir, true)` and that test stays green while every Build It click raises a
    // keychain dialog per account — the exact regression it was written to prevent.
    //
    // A gate that popped a password dialog on every click would be its own outage. The token cache
    // the forced read bypasses holds the TOKEN, not the usage numbers, so the figures are still live.
    usageMock.mockResolvedValue(DISARMED as never);
    accountsMock.mockResolvedValue([{ configDir: "/a" }] as never);
    await readUsageForAllAccounts();
    expect(usageMock).toHaveBeenCalledTimes(1);
    // EXACTLY ONE ARGUMENT — the second was never supplied, which is what "not forced" means here.
    expect(usageMock.mock.calls[0]).toEqual(["/a"]);
  });

  it("REFUSES when the reader's payload carries no extraUsage at all", async () => {
    // NOT "today's production state" any more — the `sparkle-iclm0` passthrough has landed, so
    // `AccountUsageLive` does carry `extraUsage` and the gate can reach a permitting verdict. This
    // is still reachable, though: an older backend, or a fetch that returned a payload without the
    // block. Asserted because it is the state a reader would otherwise mistake for a broken gate.
    usageMock.mockResolvedValue({ fiveHourPercent: 10, limits: [] } as never);
    accountsMock.mockResolvedValue([{ configDir: "/a" }] as never);
    const v = checkSpendGate(await readUsageForAllAccounts());
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toBe("usage-field-absent");
  });

  it("REFUSES when the real reader REJECTS", async () => {
    usageMock.mockRejectedValue(new Error("no token"));
    accountsMock.mockResolvedValue([{ configDir: "/a" }] as never);
    expect(checkSpendGate(await readUsageForAllAccounts()).allowed).toBe(false);
  });
});

// ── THE CROSS-LANGUAGE PIN ──────────────────────────────────────────────────────────────────────
//
// `defaultUsageRead` is now a plain typed call — `AccountUsageLive` carries `extraUsage`, so `tsc`
// checks that projection and the old unverifiable cast is gone.
//
// What `tsc` still cannot see is the WIRE. The authoritative pin for the serialized names lives in
// Rust — `the_serialized_key_names_are_exactly_what_the_advisor_spend_gate_reads` asserts the
// camelCase keys are present and the snake_case ones absent — because the Rust FIELD name is
// `extra_usage` in both the correct and the broken case, and only `rename_all` (which does not
// descend into nested structs) decides what actually crosses.
//
// What remains here is the UPSTREAM half: that Anthropic's payload still calls these fields what
// this module's confirmed-live fixture says it does. Reading a file off disk in a unit test is
// unusual and deliberate: it is the only thing that can fail when the two sides drift.
describe("the extra_usage seam, upstream names and landed state", () => {
  const rustPath = resolve(__dirname, "../../../src-tauri/src/account_usage.rs");

  it("pins the UPSTREAM wire names — which is not the same as pinning what Rust serializes", () => {
    // READ THE LIMIT OF THIS TEST BEFORE TRUSTING IT. It asserts that Anthropic's payload — as
    // captured in this module's own confirmed-live fixture — still calls these fields what it called
    // them. That is worth pinning: if upstream renames one, the passthrough `sparkle-iclm0` is
    // building is against a shape that no longer exists.
    //
    // It does NOT assert that the names `spendGate.ts` reads are the ones Rust emits — that is the
    // Rust seam test's job (see the describe header). `spendGate.ts` reads CAMELCASE.
    //
    // SCOPED TO THE FIXTURE, which matters now in a way it did not before. These snake_case tokens
    // are also `WireExtraUsage`'s own Rust field names, so a whole-file grep can no longer fail as
    // designed: upstream could rename a field, the fixture be updated to match, and the tokens
    // would still be found in the struct declaration. Searching only the fixture's JSON keeps the
    // assertion about the WIRE rather than about our own code.
    const src = readFileSync(rustPath, "utf8");
    const fixture = src.slice(src.indexOf("const FIXTURE"), src.indexOf("const FIXTURE") + 4000);
    expect(fixture, "the confirmed-live FIXTURE const must be findable").toContain("five_hour");
    expect(fixture).toContain('"extra_usage"');
    for (const field of ["is_enabled", "used_credits", "spend_limit_reached"]) {
      expect(fixture, `the upstream wire fixture must carry ${field}`).toContain(field);
    }
  });

  it("the passthrough has landed, and the JS field name is the one the gate reads", () => {
    // This REPLACES the BLOCKED-ON-sparkle-iclm0 tripwire, which existed only because there was no
    // serializing struct to check against: `extra_usage` was discarded, so every account folded to
    // `usage-field-absent` and the gate refused unconditionally — correct, but permanently inert.
    //
    // The passthrough is now on `AccountUsageLive`, so `defaultUsageRead` is a plain typed call and
    // this asserts the Rust side still declares the field rather than that it is still missing.
    //
    // What this test CANNOT do is prove the serialized NAME, and that is the whole hazard: the Rust
    // field is `pub extra_usage` (snake) in both the correct and the broken case, because serde's
    // `rename_all` — not the field name — decides the wire form, and it does not descend into a
    // nested struct. So the real verification lives in Rust, on the serialized JSON:
    // `the_serialized_key_names_are_exactly_what_the_advisor_spend_gate_reads` in
    // `account_usage.rs` asserts `extraUsage.isEnabled` et al are present AND that the snake_case
    // forms are not. Grepping source text here would pass whatever the wire really looked like.
    const src = readFileSync(rustPath, "utf8");
    expect(/pub\s+extra_usage\s*:/.test(src)).toBe(true);
    expect(
      src,
      "the serialized-name assertion must exist in Rust — a source grep here cannot prove the wire",
    ).toContain("the_serialized_key_names_are_exactly_what_the_advisor_spend_gate_reads");
  });
});
