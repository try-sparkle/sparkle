// WHY THE PUSHER'S QUOTA CLASS NEVER FIRED, pinned at the layer that is actually broken.
//
// The fleet hit "You've hit your monthly spend limit · raise it at claude.ai/settings/usage" and
// agents sat dead. The concierge received four Pusher reports in that window and not one mentioned
// quota. The founder found the wall by reading an agent's terminal by hand.
//
// ── WHAT IS *NOT* BROKEN, ESTABLISHED BEFORE WRITING THIS ───────────────────────────────────────
// `packages/core/pusherFleetReport.test.ts` ("reports all three classes in ONE message") is GREEN
// today: given snapshots that carry `quota`, `evaluateFleetConditions` emits `quota-blocked`, the
// report contains "2 agents are quota-blocked", and `pusherGate` accepts it. So the condition, the
// ordering, the `quotedNumbers` whitelist and the gate all work. The break is strictly upstream, in
// the ADAPTER — which is the one seam `pusherSnapshots.ts`'s own header says its unit tests
// "structurally cannot cover".
//
// ── THE MECHANISM ───────────────────────────────────────────────────────────────────────────────
// `FleetSnapshotInput.quotaFor` is `engineRegistry.quotaBlockForAgent`, and that registry is written
// by ONE thing: a mounted `Terminal` registering its `StatusEngine` on PTY spawn (Terminal.tsx), and
// unregistering on teardown. So the wall is per-window and pane-mount-scoped. Worse, teardown does
// not merely hide it — `StatusEngine.dispose()` calls `releaseQuotaBlock()`, which DELETES it.
//
// That is fatal for this exact class, because a quota wall is the condition under which the agent's
// process ENDS. The production logs for the incident show the banner arriving with
// `exit_code=Some(1)`. A row that has exited is the row a human then closes — and closing it is what
// erases the only evidence the Pusher had.
//
// ── THE CONTRAST THAT LOCALISES IT ──────────────────────────────────────────────────────────────
// `escalation` reached the concierge repeatedly and accurately from the same builder in the same
// ticks. It is read from `agent.goal` — projectStore state, durable and fleet-wide. Every field that
// failed (`quota`, and `failure` with it) is read from the engine registry. Same report, same tick,
// same gate; different source, and only the ephemeral source went silent.
//
// ── WHAT THIS TEST ASSERTS ──────────────────────────────────────────────────────────────────────
// The SIDE EFFECT, not the precondition: a wall that was genuinely observed must still reach the
// snapshot after the pane that observed it is gone. Asserting "a mounted pane's wall is mapped"
// would pass against the broken code — that path already works, and it is not the path the incident
// took.
//
// ── WHY THE DURABILITY CASES ARE `it.fails` AND NOT `it` (roborev 63125, High) ───────────────────
// They are written to fail against current code, which is the point — but a live red case in the
// tracked suite is not a reminder, it is a broken gate. It masks the NEXT failure on this branch (a
// second red is indistinguishable from the two planted here), and "DO NOT MERGE" in a commit message
// enforces nothing: the app opens and merges PRs on agent branches autonomously, so a red file
// reaches `main` and the whole fleet's CI goes with it.
//
// `it.fails` keeps the artifact AND the verdict. It passes today because the assertion inside throws
// — the diagnosis stays executable rather than becoming a comment — and it flips to a hard red the
// moment the producer fix lands, which is exactly the reminder wanted. The PR that lands the durable
// store converts these back to plain `it()`; nothing else in the file needs to change.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StatusEngine } from "../engine/statusEngine";
import {
  registerStatusEngine,
  unregisterStatusEngine,
  quotaBlockForAgent,
  releaseQuotaBlockForAgent,
} from "../engine/engineRegistry";
import { SESSION_LIMIT_FALLBACK_MS } from "../engine/quotaBlock";
import { buildFleetSnapshots } from "./pusherSnapshots";
import { evaluateFleetConditions, isQuotaWalled } from "@sparkle/core";
import type { Project } from "../types";

/** VERBATIM from the incident's own logs, `?from=cc_cli_limit_message` and all. Not the tidied
 *  string the existing suites use — this is the one the fleet actually printed. */
const SPEND_LIMIT =
  "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message";

const NOW = Date.parse("2026-08-12T18:00:00.000Z");

/**
 * A FRESH AGENT ID PER TEST, and it is a correctness rule rather than tidiness (roborev 63125,
 * Medium). The registry these tests write is a module-global `Map`, so a shared id makes every test
 * readable by every other one. Today that is only a leak; the moment the fix these cases demand
 * exists it is worse than a leak, because durability across pane teardown means an agent-id-keyed
 * store that OUTLIVES the engine. A second test reusing the id would then read the first test's
 * residue and report `quota-blocked` even if its own `ingest` had recorded nothing at all — the very
 * test meant to prove the end-to-end path goes vacuous exactly when it starts passing.
 */
let nextAgent = 0;
const freshAgent = () => `agent-walled-${++nextAgent}`;

function projectWith(agentId: string): Project {
  return {
    id: "proj-1",
    name: "sparkle",
    path: "/tmp/proj",
    agents: [{ id: agentId, kind: "build", name: "Walled Agent" }],
  } as unknown as Project;
}

/** The adapter input with every OTHER source empty, so the only thing under test is `quotaFor`. */
function inputFor(agentId: string) {
  return {
    projects: [projectWith(agentId)],
    branchStatus: {},
    quotaFor: quotaBlockForAgent,
    failureFor: () => undefined,
    retroSettledFor: () => false,
    sessionEndedFor: () => undefined,
    now: NOW,
  };
}

/**
 * Every engine this file mounts, so teardown happens even when the test throws BEFORE reaching its
 * own `unregisterStatusEngine`/`dispose` pair — which, for the `it.fails` cases below, is the
 * expected path rather than an edge case. Without this, a live undisposed `StatusEngine` keeps its
 * pending timers (including the 5h `quotaTimer`) registered while `afterEach` swaps fake timers back
 * for real ones.
 */
const mounted: Array<{ agentId: string; engine: StatusEngine }> = [];
function mount(agentId: string): StatusEngine {
  const engine = new StatusEngine({ agentId, onStatus: () => {} });
  registerStatusEngine(agentId, engine);
  mounted.push({ agentId, engine });
  return engine;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  for (const { agentId, engine } of mounted.splice(0)) {
    unregisterStatusEngine(agentId, engine);
    engine.dispose();
  }
  vi.useRealTimers();
});

describe("the Pusher can still see a quota wall after the pane that saw it is gone", () => {
  // `it.fails` — see the header. RED against current code is the assertion; when the durable store
  // lands this goes red as a PASS and gets converted back to a plain `it()`.
  it.fails("keeps the wall on the snapshot once the agent's pane tears down", () => {
    const agent = freshAgent();
    const engine = mount(agent);
    engine.ingest("✻ Cogitating… (12s · ↑ 1.2k tokens · esc to interrupt)");
    engine.ingest(`\r⏺ ${SPEND_LIMIT}`);

    // PRECONDITION, asserted rather than assumed: while the pane is mounted this all works, which is
    // why the defect is invisible to every existing test.
    expect(buildFleetSnapshots(inputFor(agent))[0]?.quota?.message).toBe(SPEND_LIMIT);

    // THE INCIDENT'S ACTUAL SEQUENCE. The banner ended the turn (`exit_code=Some(1)` in the logs),
    // and the row was closed — which is exactly Terminal.tsx's teardown pair.
    unregisterStatusEngine(agent, engine);
    engine.dispose();

    // THE SIDE EFFECT. The wall was really observed and its 5h bounded window has not elapsed, so
    // the Pusher must still be able to report it. Today both of these are empty: the registry entry
    // is gone AND `dispose()` deleted the block behind it.
    const snaps = buildFleetSnapshots(inputFor(agent));
    expect(snaps[0]?.quota?.message).toBe(SPEND_LIMIT);
    expect(isQuotaWalled(snaps[0]!, NOW)).toBe(true);
  });

  it.fails("yields a quota-blocked condition end-to-end for that agent", () => {
    // The half the founder actually reads. Same teardown, then the real condition evaluator — no
    // hand-built snapshot anywhere, so this cannot pass on a fixture that already had the field.
    const agent = freshAgent();
    const engine = mount(agent);
    engine.ingest(`\r⏺ ${SPEND_LIMIT}`);
    unregisterStatusEngine(agent, engine);
    engine.dispose();

    const conditions = evaluateFleetConditions(buildFleetSnapshots(inputFor(agent)), NOW);
    expect(conditions.map((c) => c.id)).toContain("quota-blocked");
  });
});

/**
 * ── THE BOUND ON THE FIX, NOT JUST ITS EXISTENCE (roborev 63125, Medium) ─────────────────────────
 *
 * The two cases above pin only that the wall SURVIVES teardown. Nothing there pins its LIMITS, so
 * the cheapest implementation that turns them green is a never-expiring, never-cleared global keyed
 * by agent id — and that implementation regresses the fix landed one commit earlier (an account
 * switch retiring the wall it switched away from). The failure it would reintroduce runs the wrong
 * direction: an agent is walled, a human moves it to an account with headroom, the row is closed,
 * and the Pusher resurrects a wall the switch already retired — a healthy agent reported as
 * quota-blocked, which is the manufactured claim `quotaBlockForAgent`'s own header forbids.
 *
 * These two are plain `it()` and they PASS today. Read that honestly: their teardown-side assertion
 * is vacuous right now, because there is no durable copy for it to be wrong about. Each is therefore
 * paired with a MOUNTED-side assertion that is live against current code — the 5h bound and the
 * release path both work today, and these would catch a regression in either. The teardown line is
 * the part that starts doing work when the durable store lands; it is a constraint written before
 * the thing it constrains, which is the only moment it is cheap to write.
 */
describe("the durable wall the cases above demand must still expire and still be releasable", () => {
  it("does not outlive its bounded window", () => {
    const agent = freshAgent();
    const engine = mount(agent);
    engine.ingest(`\r⏺ ${SPEND_LIMIT}`);
    const expired = NOW + SESSION_LIMIT_FALLBACK_MS + 1;

    // LIVE TODAY. The banner names no reset time, so `resetAt` is the bounded fallback from the
    // sighting — walled at the instant it was seen, history once that window has passed.
    const whileMounted = buildFleetSnapshots(inputFor(agent))[0]!;
    expect(isQuotaWalled(whileMounted, NOW)).toBe(true);
    expect(isQuotaWalled(whileMounted, expired)).toBe(false);

    unregisterStatusEngine(agent, engine);
    engine.dispose();

    // THE CONSTRAINT. Vacuous today (there is no wall at all after teardown); the line that fails
    // the day someone makes durability mean "forever".
    const afterTeardown = buildFleetSnapshots(inputFor(agent))[0]!;
    expect(isQuotaWalled(afterTeardown, expired)).toBe(false);
  });

  it("stays gone once the agent has been moved to an account with headroom", () => {
    const agent = freshAgent();
    const engine = mount(agent);
    engine.ingest(`\r⏺ ${SPEND_LIMIT}`);

    // LIVE TODAY, both of them: the wall is visible while mounted, and the account-switch release
    // retires it. A regression in `releaseQuotaBlockForAgent` reds this line now, not later.
    expect(buildFleetSnapshots(inputFor(agent))[0]?.quota?.message).toBe(SPEND_LIMIT);
    releaseQuotaBlockForAgent(agent);
    expect(buildFleetSnapshots(inputFor(agent))[0]?.quota).toBeUndefined();

    unregisterStatusEngine(agent, engine);
    engine.dispose();

    // THE CONSTRAINT. A durable copy written at OBSERVATION time, with only the engine's copy
    // released, would resurrect the retired wall right here.
    expect(buildFleetSnapshots(inputFor(agent))[0]?.quota).toBeUndefined();
  });
});
