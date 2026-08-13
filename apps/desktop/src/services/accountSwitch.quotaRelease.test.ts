// THE SECOND HALF OF THE RETRY CONTRACT: a quota-walled agent must come back IMMEDIATELY when the
// human moves it to another account — not at the old account's reset instant.
//
// The first half already works and is covered by `engine/quotaBlock.test.ts`: a wall arms a timer at
// its stated reset (`StatusEngine.armQuotaRelease`), `decideContinuation` refuses with
// `quota-blocked` until then, and the next sweep resumes the agent once it lifts. That is the
// "bounded timer" half.
//
// This suite is about the other trigger, and it is the one nothing implements today. `moveAgent`
// re-pins the agent to a new account and re-spawns it — but the wall lives in that agent's
// StatusEngine, and the ONLY things that retire it are its stated reset, positive evidence a command
// ran, and a HUMAN typing (`noteUserInput` with `machine !== true`). An account switch is none of
// those. So after the switch the agent is running on an account with full headroom while every
// consumer still reads the OLD account's wall: the sidebar paints "Rate limited", `stallReport` says
// `quota-blocked`, and auto-continue refuses to resume it — for as long as the abandoned account's
// window had left, which for a session limit is up to five hours.
//
// The wall is a claim about an ACCOUNT, not about an agent. The moment the agent stops running under
// that account, the claim no longer describes it and must be dropped.
//
// WHY THE PAIRED NEGATIVE MATTERS (AGENTS.md, "Tests must assert the SIDE EFFECT"): asserting only
// that the wall is gone after a move would also pass if the wall had never been set, or if some
// unrelated gate ahead of it had swallowed the banner. The second test holds an agent that is NOT in
// the switch and asserts its wall SURVIVES, so the pair can only be satisfied by the move itself
// releasing it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StatusEngine } from "./../engine/statusEngine";
import {
  registerStatusEngine,
  unregisterStatusEngine,
  quotaBlockForAgent,
} from "./../engine/engineRegistry";
import { decideContinuation } from "./../engine/goalContinuation";
import { newGoal } from "./../engine/agentGoal";
import { moveAgent } from "./accountSwitch";

// `moveAgent` persists a pin as its first effect. That is not what this suite is about, and the real
// implementation reaches localStorage — stub it so a storage failure can never be mistaken for the
// wall assertion below failing.
vi.mock("./accountStore", () => ({ setPin: vi.fn() }));

/** Verbatim from the founder's screenshot — the same string `quotaBlock.test.ts` pins. */
const SESSION_LIMIT =
  "You've hit your session limit · resets 4pm (America/Bogota) — /usage-credits to finish what you're working on.";

const SPINNER = "✻ Cogitating… (12s · ↑ 1.2k tokens · esc to interrupt)";

// 18:00Z is 13:00 in America/Bogota (UTC-5), so the stated 4pm reset is a real THREE HOURS out from
// "now". Pinning the clock is load-bearing: with a live clock this suite would run after 4pm Bogota
// for part of every day, the wall would already be expired on arrival, and both tests would pass
// vacuously against code that does nothing.
const NOW = Date.parse("2026-07-30T18:00:00.000Z");
const RESET = Date.parse("2026-07-30T21:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** An agent sitting behind a live account-limit wall, registered in the engine registry exactly as a
 *  mounted Terminal registers it. Returns the engine so the caller can unregister it. */
function walledAgent(agentId: string): StatusEngine {
  const engine = new StatusEngine({ agentId, onStatus: () => {} });
  registerStatusEngine(agentId, engine);
  engine.ingest(SPINNER);
  engine.ingest(`\r⏺ ${SESSION_LIMIT}`);
  // Precondition, asserted rather than assumed: the wall really is up and really is still in force
  // at `NOW`. If this ever stops holding, the tests below would go green for the wrong reason.
  const block = quotaBlockForAgent(agentId, NOW);
  expect(block).toBeDefined();
  expect(block?.resetAt).toBe(RESET);
  return engine;
}

/** Everything `decideContinuation` needs to say "continue", so the only thing that can refuse is the
 *  quota gate. Mirrors the helper in `engine/quotaBlock.test.ts`. */
function readyToResume() {
  return {
    goal: newGoal("land the retry PR", NOW, 8 * 60 * 60 * 1000),
    status: "idle" as const,
    now: NOW + 60_000,
    idleSince: NOW - 120_000,
    hasTurnEndAuthority: true,
    canAcceptInput: true,
    processAlive: true,
    mark: "m",
    runtime: "local" as const,
    cloud: undefined,
  };
}

describe("an account switch retires the wall it is switching AWAY from", () => {
  it("drops the quota block for the agent it moves, so the agent can resume at once", () => {
    const agentId = "agent-walled";
    const engine = walledAgent(agentId);
    try {
      // The production entry point the switch loop calls for each agent that reaches a safe boundary
      // (`advanceSwitch` → `moveAgent`). The restart is injected exactly as production injects the
      // pane registry's restart.
      const restarted = moveAgent(agentId, "account-with-headroom", () => true);
      expect(restarted).toBe(true);

      // THE SIDE EFFECT. Not "a pin was written" (that is the precondition the move already had) —
      // the wall the old account produced is gone, one minute after the switch and three hours
      // before that account's own reset.
      expect(quotaBlockForAgent(agentId, NOW + 60_000)).toBeUndefined();

      // ...and the effect that actually matters to the human: auto-continue resumes it instead of
      // reporting `quota-blocked` about an account it is no longer running on.
      const decision = decideContinuation({
        ...readyToResume(),
        quotaBlock: quotaBlockForAgent(agentId, NOW + 60_000),
      });
      expect(decision.action).toBe("continue");
    } finally {
      unregisterStatusEngine(agentId, engine);
      engine.dispose();
    }
  });

  it("leaves an agent that was NOT moved still walled", () => {
    // The paired control. Same wall, same clock, same registry — the only difference is that no
    // switch touched this agent. If this one also came back undefined, the assertion above would be
    // proving nothing about `moveAgent`.
    const moved = "agent-moved";
    const bystander = "agent-bystander";
    const movedEngine = walledAgent(moved);
    const bystanderEngine = walledAgent(bystander);
    try {
      moveAgent(moved, "account-with-headroom", () => true);

      expect(quotaBlockForAgent(moved, NOW + 60_000)).toBeUndefined();
      expect(quotaBlockForAgent(bystander, NOW + 60_000)).toBeDefined();
      expect(
        decideContinuation({
          ...readyToResume(),
          quotaBlock: quotaBlockForAgent(bystander, NOW + 60_000),
        }),
      ).toEqual({ action: "none", reason: "quota-blocked" });
    } finally {
      unregisterStatusEngine(moved, movedEngine);
      unregisterStatusEngine(bystander, bystanderEngine);
      movedEngine.dispose();
      bystanderEngine.dispose();
    }
  });
});
