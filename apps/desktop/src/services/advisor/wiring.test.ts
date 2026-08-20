// THE KILL SWITCH, ASSERTED AT THE PRODUCTION CALL SITE — not at the pure function under it.
//
// ══ WHY THIS FILE EXISTS ════════════════════════════════════════════════════════════════════════
//
// `config.test.ts` proves `resolveAdvisorConfig({enabled: false})` returns `enabled: false`. That is
// a true statement about a pure function and it is NOT evidence that `[advisor].enabled = false`
// stops anything — the value still has to travel from `get_config` into the cache `pass.ts` reads,
// and for a while it did not. `primeAdvisorConfig` had no caller anywhere in the app, so
// `cachedConfig` was permanently the shipped default: the documented master switch could not stop a
// pass, `[advisor].model` was never honoured, and a green pure-function test sat in front of it
// reading as evidence that the switch worked. For a feature that ships ON and dispatches a
// $5/$25-per-Mtok model, that gap is the whole safety story.
//
// So this drives `advisorHandoffHook` — the real production entry point, the one `prepareHandoff`
// calls — with `getConfig` mocked, and asserts the SIDE EFFECT: no research child was dispatched.
// Delete the `primeAdvisorConfig` call and this goes red.
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EffectiveConfig } from "../config";
import { resetHeldVerdicts } from "./findings";
import { resetAdvisorPassState } from "./pass";
import type { AdvisorPassArgs } from "./pass";

const getConfigMock = vi.fn();
/** Typed to the argument shape `productionDeps` sends, so `mock.calls[0]![0]` is a real tuple read
 *  rather than a cast — an untyped `vi.fn()` infers `[]` and the assertion below becomes a type
 *  error instead of the check it is meant to be. */
const dispatchMock = vi.fn(async (_input: { model: string }) => ({ id: "task-1" }));
const invokeMock = vi.fn(async () => "claude-sonnet-4-6");
const usageMock = vi.fn(async () => ({
  // Credits DISARMED, so the spend gate PERMITS. That is deliberate: with the gate refusing, every
  // assertion below would pass for the wrong reason and the test would prove nothing about the
  // flag. The only thing left that can stop a dispatch here is `[advisor].enabled`.
  extraUsage: { isEnabled: false, usedCredits: 0 },
}));

vi.mock("../config", async (orig) => ({
  ...(await orig<typeof import("../config")>()),
  getConfig: (...a: unknown[]) => getConfigMock(...a),
}));
vi.mock("../accountUsage", () => ({ getAccountUsageLive: () => usageMock() }));
vi.mock("../accountStore", () => ({ listAccounts: async () => [{ configDir: "/a" }] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => invokeMock() }));
vi.mock("../research/store", () => ({
  dispatchResearch: (input: { model: string }) => dispatchMock(input),
  getResearch: async () => null,
}));
vi.mock("../beads", async (orig) => ({
  ...(await orig<typeof import("../beads")>()),
  labelBead: vi.fn(async () => {}),
  commentBead: vi.fn(async () => {}),
}));

const { advisorHandoffHook } = await import("./index");

const ARGS: AdvisorPassArgs = {
  projectPath: "/repo",
  projectRoot: "/repo",
  projectId: "p",
  epicId: "sparkle-ep",
  epicTitle: "An epic",
  planText: "plan",
};

/** An `EffectiveConfig` carrying just the `[advisor]` section under test. */
function eff(advisor: unknown): EffectiveConfig {
  return { config: { advisor }, warnings: [] } as unknown as EffectiveConfig;
}

beforeEach(() => {
  resetHeldVerdicts();
  // The in-flight set is module-level and keyed by epic id, and every test here hands off the SAME
  // epic. Without this reset the second test onward is deduped rather than gated, so a test meaning
  // to prove `[advisor].enabled = true` dispatches would see no dispatch for an unrelated reason.
  resetAdvisorPassState();
  dispatchMock.mockClear();
  getConfigMock.mockReset();
});

describe("[advisor].enabled reaches the production pass", () => {
  it("enabled = FALSE stops the dispatch — the switch actually switches", async () => {
    getConfigMock.mockResolvedValue(eff({ enabled: false, model: "claude-opus-5" }));
    await advisorHandoffHook(ARGS);
    // THE SIDE EFFECT. Not "config() returned false" — no child was asked for.
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("enabled = TRUE dispatches, so the case above is not passing for another reason", async () => {
    // THE PAIRED HALF, and it is what makes the first test mean anything. A gate that refused
    // everything — an unreadable meter, an unresolvable model, a crash in the hook — would satisfy
    // "no dispatch" while the flag did nothing at all. One test proving absence is ambiguous; the
    // pair is what pins the cause to the flag.
    getConfigMock.mockResolvedValue(eff({ enabled: true, model: "claude-opus-5" }));
    await advisorHandoffHook(ARGS);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("honours [advisor].model end to end, and never dispatches the planner's own model", async () => {
    getConfigMock.mockResolvedValue(eff({ enabled: true, model: "claude-haiku-4-5" }));
    await advisorHandoffHook(ARGS);
    const sent = dispatchMock.mock.calls[0]![0];
    expect(sent.model).toBe("claude-haiku-4-5");
    // `invokeMock` returns the planner's real id, so this is a live comparison rather than a literal.
    expect(sent.model).not.toBe("claude-sonnet-4-6");
  });

  it("a config read that FAILS keeps the last known value rather than inventing one", async () => {
    // Prime once with the switch OFF, then make the read fail. The switch must STAY off: a failed
    // read is not permission, and re-defaulting to the shipped `enabled: true` would silently
    // re-arm a feature the user turned off.
    getConfigMock.mockResolvedValue(eff({ enabled: false, model: null }));
    await advisorHandoffHook(ARGS);
    expect(dispatchMock).not.toHaveBeenCalled();

    getConfigMock.mockRejectedValue(new Error("bridge down"));
    await advisorHandoffHook(ARGS);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("an ABSENT [advisor] section reads as the shipped defaults, so the pass still runs", async () => {
    // The back-compat rule, at the production call site: a Rust backend predating the section must
    // not silently stop a pass this build IS running, since the user would have no switch to turn
    // back on. Safe only because the zero-spend gate — not this flag — bounds spend.
    getConfigMock.mockResolvedValue(eff(undefined));
    await advisorHandoffHook(ARGS);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });
});
