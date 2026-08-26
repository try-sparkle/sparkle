// THE RECORD IS OPENED AT SPAWN, CLOSED AT `exit()`, AND — THE ONE THAT BITES — NOT CLOSED ON
// UNMOUNT.
//
// That third property is the whole reason this file exists. A pane unmounts on tab close, on a
// StrictMode double-mount, and on "Start again", and in NONE of those is the agent necessarily dead:
// `Terminal.tsx`'s cleanup calls `transport.detach()`, and `unregisterStatusEngine` is
// identity-guarded precisely because a `pty:exit` from that teardown can still arrive after the pane
// has remounted. A close on unmount would write a false `unknown` over a healthy agent's record —
// and `unknown` is what the reaper reads, so it would hand a running agent's worktree to the
// reconciler while telling the resurrector nothing is wrong.
//
// Driven through the REAL `StatusEngine`, not a stand-in, because the guarantee lives in the
// engine's `disposed` latch and in which method `Terminal`'s cleanup happens to call. A test against
// a fake would assert my own understanding of that wiring rather than the wiring.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentGoal } from "../engine/agentGoal";

import { TRANSPORT_FAILURE_WINDOW_MS } from "../engine/deathTypes";
import {
  lastFailureForAgent,
  quotaBlockForAgent,
  recentFailureForAgent,
  registerStatusEngine,
  unregisterStatusEngine,
} from "../engine/engineRegistry";
import { StatusEngine } from "../engine/statusEngine";
import {
  type DeathRecordDeps,
  type RetiredEvidence,
  liveDeps,
  midTaskExitNotice,
  openDeathRecord,
  recordAgentRetirement,
  readRetirementLog,
  recordDeath,
} from "./deathRecordWriter";
import {
  _resetOrphanedSubagentRegistryForTests,
  orphanedSubagentsForAgent,
} from "./orphanedSubagentRegistry";
import {
  agentTranscriptPath,
  forgetAgentTranscriptPath,
  noteAgentTranscriptPath,
} from "./agentTranscriptRegistry";
import { SUBAGENT_TRANSCRIPT_GLOB } from "./subagentTranscripts";
import {
  _resetBackgroundTaskRegistryForTests,
  noteBackgroundTasks,
} from "./backgroundTaskRegistry";
import {
  clearConciergeNotifier,
  setConciergeNotifier,
} from "./conciergeNotifier";

const NOW = 1_754_534_400_000;
const SESSION_WALL = "You've hit your session limit · resets 10:30pm (America/Los_Angeles)";
const ENOTFOUND = "API Error: Unable to connect to API (ENOTFOUND)";

interface Calls {
  deps: DeathRecordDeps;
  /** `[command, args]` for every invoke the writer made. */
  invoked: Array<[string, Record<string, unknown>]>;
  /** Just the closes, which is what most assertions here are about. */
  closes: () => Array<Record<string, unknown>>;
}

function deps(over: Partial<DeathRecordDeps> = {}): Calls {
  const invoked: Array<[string, Record<string, unknown>]> = [];
  const d: DeathRecordDeps = {
    quota: () => undefined,
    lastFailure: () => undefined,
    recentFailure: () => undefined,
    // "local" means THIS window watched the agent. Anything else and `classifyDeath`'s Gate 0
    // refuses to claim anything, which is asserted on its own below.
    liveness: () => "local",
    goal: () => undefined,
    blockingTool: () => undefined,
    resumeBanner: () => false,
    escalate: () => true,
    orphanedSubagents: () => undefined,
    // Defaults to "this window recorded no exact session file", matching production for an agent
    // whose first turn never ended. Tests that care supply a path explicitly.
    parentTranscriptPath: () => undefined,
    invoke: (cmd, args) => {
      invoked.push([cmd, args]);
      return Promise.resolve(undefined as never);
    },
    now: () => NOW,
    ...over,
  };
  return {
    deps: d,
    invoked,
    closes: () =>
      invoked.filter(([cmd]) => cmd === "agent_life_close").map(([, args]) => args),
  };
}

/** A real engine whose deaths are recorded through the real writer, with injected edges. */
function engineWith(c: Calls, agentId = "a1"): StatusEngine {
  return new StatusEngine({
    agentId,
    onStatus: () => {},
    onDeath: ({ terminator }) => void recordDeath(agentId, terminator, c.deps),
  });
}

/** The writer's `invoke` resolves on a microtask, and `onDeath` is fired synchronously without
 *  awaiting it (a status transition must not block on a disk write). Flush before asserting. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("the record is opened at spawn", () => {
  it("opens with the agent, project and worktree the pane was given", async () => {
    const c = deps();
    await openDeathRecord("a1", "proj-1", "/wt/a1", c.deps);
    expect(c.invoked).toEqual([
      ["agent_life_open", { agentId: "a1", projectId: "proj-1", worktree: "/wt/a1" }],
    ]);
  });

  it("never throws when the ledger write fails", async () => {
    // A recovery affordance that can break the thing it protects is worse than not having one: a
    // rejected invoke here must not stop a terminal coming up.
    const c = deps({ invoke: () => Promise.reject(new Error("no tauri host")) });
    await expect(openDeathRecord("a1", "p", "/wt", c.deps)).resolves.toBe(false);
  });
});

describe("the record is closed at exit()", () => {
  it("writes a verdict when the PTY exits", async () => {
    const c = deps();
    engineWith(c).exit();
    await settle();

    expect(c.closes()).toHaveLength(1);
    const [close] = c.closes();
    expect(close?.agentId).toBe("a1");
    // A bare PTY exit names the EVIDENCE and refuses to guess the cause — a local PTY carries no
    // exit code, so `unknown` is the honest answer and it is deliberately not resurrectable.
    expect(close?.death).toMatchObject({ cause: "unknown", evidence: "pty-exit", at: NOW });
  });

  it("carries the API banner through, so the death is resurrectable", async () => {
    // THE CASE THE WHOLE FEATURE IS FOR. Without the banner this exit is `unknown`, which never
    // comes back; with it, `transport-transient`, which does.
    const c = deps({ lastFailure: () => ({ message: ENOTFOUND, at: NOW - 1_000 }) });
    engineWith(c).exit();
    await settle();

    expect(c.closes()[0]?.death).toMatchObject({
      cause: "transport-transient",
      evidence: "api-banner",
      message: ENOTFOUND,
    });
  });

  it("sends the wall alongside the cause, not folded into it", async () => {
    // An agent walled at 18:19 and killed by the app quitting at 18:20 has BOTH facts true, and
    // recovery needs both: resurrect BECAUSE the app died, but NOT before the reset.
    const { quotaBlocksIn } = await import("../engine/quotaBlock");
    const wall = quotaBlocksIn(SESSION_WALL, NOW - 1_000)[0]!;
    const c = deps({ quota: () => wall });
    engineWith(c).exit();
    await settle();

    const close = c.closes()[0];
    expect(close?.death).toMatchObject({ cause: "wall-session", evidence: "quota-block" });
    expect(close?.wall).toMatchObject({ message: SESSION_WALL, resetParsed: true });
  });

  it("writes nothing when this window did not watch the agent", async () => {
    // Gate 0. `engineRegistry`'s readers return undefined for BOTH "healthy" and "no pane here", so
    // a verdict from a window that wasn't watching is not evidence — and persisting it would clobber
    // a record another window wrote with real evidence. An erasure dressed as an observation.
    const c = deps({ liveness: () => "other-window" });
    await expect(recordDeath("a1", "pty-exit", c.deps)).resolves.toBeNull();
    expect(c.closes()).toEqual([]);
  });
});

describe("UNMOUNTING IS NOT A DEATH", () => {
  it("writes nothing when the pane unmounts", async () => {
    // `Terminal.tsx`'s cleanup calls `engine.dispose()`, never `engine.exit()`. If a close were
    // hung off unmount, every tab close and every StrictMode double-mount would write a false
    // `unknown` over a healthy agent.
    const c = deps();
    engineWith(c).dispose();
    await settle();
    expect(c.closes()).toEqual([]);
  });

  it("writes nothing when a late pty:exit arrives after the pane was torn down", async () => {
    // THE ACTUAL RACE, not a restatement of the test above. Unmount DETACHES the transport, and for
    // a local PTY detach IS kill — so a `pty:exit` really does follow every unmount, and it arrives
    // over an async Tauri unlisten that may not have completed. The `disposed` latch is what makes
    // that late event this engine's business to ignore.
    const c = deps();
    const engine = engineWith(c);
    engine.dispose();
    engine.exit(); // the kill's own exit, landing after teardown
    await settle();
    expect(c.closes()).toEqual([]);
  });

  it("still writes for an engine that was NOT disposed — the control for the two above", async () => {
    // Without this, both tests above would pass against an `onDeath` that never fires at all.
    const c = deps();
    engineWith(c).exit();
    await settle();
    expect(c.closes()).toHaveLength(1);
  });
});

describe("a wall trips a close while the agent is still alive to see it", () => {
  /**
   * An engine wired the way PRODUCTION wires it: the writer's `quota` dep reads the wall back off
   * the ENGINE, which is exactly what `engineRegistry.quotaBlockForAgent` does for a registered
   * engine.
   *
   * That indirection is the point rather than an inconvenience. It makes these tests assert an
   * ORDERING inside `StatusEngine` that nothing else covers: the wall branch assigns
   * `this.quotaBlock` BEFORE it calls `tripStreamFailure("quota")`, so by the time `onDeath` fires,
   * the registry can already answer with the wall. Reverse those two lines and `classifyDeath` sees
   * no wall, falls through every gate, and returns `evidence: "none"` — the writer then declines to
   * write and the death is silently lost. Stubbing `quota` with a hand-built wall (which is what
   * this file did first) hides that completely.
   */
  function walledEngine(): { engine: StatusEngine; calls: Calls } {
    // A holder rather than a `let`, because the `quota` closure has to read the engine that does not
    // exist yet when `deps` is built — which is precisely the production shape: `engineRegistry`
    // resolves the engine at CALL time, not at wiring time.
    const held: { engine?: StatusEngine } = {};
    const calls = deps({ quota: () => held.engine?.quotaBlockNow(Date.now()) });
    const engine = new StatusEngine({
      agentId: "a1",
      onStatus: () => {},
      onDeath: ({ terminator }) => void recordDeath("a1", terminator, calls.deps),
    });
    held.engine = engine;
    return { engine, calls };
  }

  it("NOTES the wall without closing the record — a walled agent is not a dead one", async () => {
    // `quota-trip` fires while the process is explicitly still running: `deathRecord.ts` says "the
    // agent may still be alive; it simply cannot proceed". Closing here would set `LifeState::Dead`
    // on a LIVE agent, `derive` would report `alive: false` for a running process, and the revival
    // thread would publish it as due the moment the reset passed — an `already-live` refusal loop
    // over an agent that never died.
    const { engine, calls } = walledEngine();
    engine.ingest(`${SESSION_WALL}\n`);
    await settle();

    expect(calls.closes(), "a wall must NOT close the record").toEqual([]);
    const notes = calls.invoked.filter(([cmd]) => cmd === "agent_life_note_wall");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.[1].wall).toMatchObject({ message: SESSION_WALL, resetParsed: true });
  });

  it("does NOT rewrite the record every time Claude reprints the banner", async () => {
    // Claude reprints the wall on each retry. A level trigger would rewrite the durable record
    // dozens of times for ONE incident — which is why `tripStreamFailure` fires on the EDGE.
    const { engine, calls } = walledEngine();
    engine.ingest(`${SESSION_WALL}\n`);
    engine.ingest(`${SESSION_WALL}\n`);
    engine.ingest(`${SESSION_WALL}\n`);
    await settle();

    expect(calls.invoked.filter(([cmd]) => cmd === "agent_life_note_wall")).toHaveLength(1);
  });

  it("and the wall it noted rides along with a LATER death, so recovery gets both facts", async () => {
    // The pair that makes the split work. `note_wall_at` leaves the record open; `close_at` never
    // drops a wall already on it. So an agent walled at 18:19 and killed at 18:20 is resurrected
    // BECAUSE the app died, but NOT before the reset — which is the whole reason `DeathWall` is
    // carried independently of `DeathCause`.
    const { engine, calls } = walledEngine();
    engine.ingest(`${SESSION_WALL}\n`);
    engine.exit();
    await settle();

    expect(calls.invoked.filter(([cmd]) => cmd === "agent_life_note_wall")).toHaveLength(1);
    const closes = calls.closes();
    expect(closes, "the PTY exiting IS a death, and still closes").toHaveLength(1);
    expect(closes[0]?.death).toMatchObject({ cause: "wall-session" });
    expect(closes[0]?.wall).toMatchObject({ message: SESSION_WALL });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE TRANSPORT DEATH, AND THE RACE THAT MADE IT INVISIBLE
//
// Census on the founder's live v0.95.0 install: 76 agent-life records, of which ZERO classified
// `transport-transient` and 25 landed on `unknown` with evidence `pty-exit`. `isResurrectable`
// refuses `unknown`, so those 25 were structurally outside recovery — the feature had never once
// fired in production.
//
// The cause is a race, not a missing matcher. Claude Code does NOT print an API banner and exit; it
// RETRIES. Measured 2026-08-08 against a non-resolving `ANTHROPIC_BASE_URL`: a real `claude` retried
// for 2m56s, then exited 1, with `API Error: Unable to connect to API (ENOTFOUND)` as its FINAL line
// of output. Every one of those retries emits a signal `StatusEngine.clearStreamFailure()` treats as
// recovery — a classified tool event, a redrawn prompt, a token advance — and that method nulls
// `lastFailure`, which is the only thing Gate 4 used to read. So the banner was reliably destroyed
// by the very retry loop it was supposed to describe.
//
// ── WHY THESE DRIVE THE REAL ENGINE THROUGH THE REAL REGISTRY ────────────────────────────────
// A test that hand-builds a `DeathObservation` with `recentFailure` already populated asserts my own
// understanding of the wiring rather than the wiring, and — the part that matters — it CANNOT
// reproduce the race at all, because the race is a sequence of calls inside `StatusEngine`. So these
// register a real engine in the real `engineRegistry`, feed it real bytes, and let the writer read
// it back exactly as production does. The precondition is ASSERTED rather than assumed: each test
// below checks that `lastFailureForAgent` really has been cleared before `exit()`, so if a future
// change stopped that chunk counting as recovery the test would fail loudly instead of passing for
// a reason it never intended.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("a transport-killed agent is classified as such, even though its retries cleared the banner", () => {
  /** Whatever `Date.now()` reads. The engine stamps banners with it and the writer's `now` reads it,
   *  so both halves of the recency comparison move together — a real clock would let them drift. */
  let clock = NOW;
  const registered: Array<[string, StatusEngine]> = [];

  beforeEach(() => {
    clock = NOW;
    // NOT fake timers: `settle()` below needs a real `setTimeout` to flush the writer's microtask.
    // Only the wall-clock reading is controlled.
    vi.spyOn(Date, "now").mockImplementation(() => clock);
  });

  afterEach(() => {
    for (const [id, engine] of registered.splice(0)) unregisterStatusEngine(id, engine);
  });

  /**
   * A real engine wired the way PRODUCTION wires it: registered in `engineRegistry`, with the
   * writer's failure/quota deps being the REAL registry readers rather than stubs.
   *
   * That is what makes these tests assert the chain instead of a hand-built object — the banner has
   * to survive `StatusEngine`'s own recovery handling, cross the registry, and reach `classifyDeath`
   * under the recency window. Every link is live except the Tauri `invoke`.
   */
  function engineOn(agentId: string): { engine: StatusEngine; calls: Calls } {
    const calls = deps({
      quota: quotaBlockForAgent,
      lastFailure: lastFailureForAgent,
      recentFailure: recentFailureForAgent,
      now: () => Date.now(),
    });
    const engine = new StatusEngine({
      agentId,
      onStatus: () => {},
      onDeath: ({ terminator }) => void recordDeath(agentId, terminator, calls.deps),
    });
    registerStatusEngine(agentId, engine);
    registered.push([agentId, engine]);
    return { engine, calls };
  }

  /**
   * The recovery signal a retry emits. A classified command line is the shape `StatusEngine` treats
   * as unambiguous forward progress, and the `if (ev)` arm calls `clearStreamFailure()`.
   *
   * VERIFIED TO ACTUALLY CLEAR, not assumed: several plausible-looking shapes (`⏺ Read(...)`,
   * `Bash(ls)`, `│ > `) do NOT classify, and a test built on one of those would never reproduce the
   * race — it would leave `lastFailure` set, so the OLD code would pass it too. Each test below
   * re-asserts the clearing rather than trusting this constant.
   */
  const RETRY_PROGRESS = "$ pnpm test\n";

  /** The OTHER doors into `clearStreamFailure()`, so the retention is not specific to one of them.
   *  The field's own doc names these: a classified tool event, a real prompt, user input. */
  const RECOVERY_SHAPES: ReadonlyArray<readonly [string, string]> = [
    ["a classified tool event", RETRY_PROGRESS],
    ["a redrawn prompt", "Do you want to proceed? (y/n)\n"],
    ["an option row", "❯ 1. Yes\n"],
  ];

  it.each(RECOVERY_SHAPES)(
    "classifies transport-transient after %s destroyed the live banner",
    async (label, recovery) => {
      // THE TEST THIS WHOLE CHANGE EXISTS FOR. It fails against the previous code — not
      // incidentally, but because Gate 4 read only `lastFailure`, which the recovery chunk erases.
      const id = `t-race-${label.replace(/\s+/g, "-")}`;
      const { engine, calls } = engineOn(id);
      engine.ingest(`${ENOTFOUND}\n`);
      engine.ingest(recovery); // ← the race: a retry's own output reads as recovery
      clock += 1_000;

      // THE PRECONDITION, ASSERTED. Without this the test could pass while never reproducing the
      // race — if the chunk stopped counting as recovery, `lastFailure` would still be set and the
      // OLD code would classify correctly too. The assertion is what keeps it honest, and it has
      // already earned its place: the first shape tried here silently did not clear.
      expect(lastFailureForAgent(id), "the recovery signal must really have cleared the live banner")
        .toBeUndefined();

      engine.exit();
      await settle();

      expect(calls.closes()[0]?.death).toMatchObject({
        cause: "transport-transient",
        evidence: "api-banner",
        message: ENOTFOUND,
      });
    },
  );

  it("retains the banner from the UNTERMINATED tail too — the shape the founder actually saw", async () => {
    // The measured death prints its banner as the FINAL line before the PTY closes, i.e. with no
    // trailing newline, so it lands entirely in the partial-tail capture path rather than the
    // completed-line one. Both sites must retain, which is why they funnel through one writer
    // (`noteApiFailure`); this is the test that would catch a future edit retaining on only one.
    const { engine, calls } = engineOn("t-tail");
    engine.ingest(ENOTFOUND); // no "\n"
    engine.ingest(RETRY_PROGRESS);
    clock += 1_000;
    expect(lastFailureForAgent("t-tail")).toBeUndefined();

    engine.exit();
    await settle();

    expect(calls.closes()[0]?.death).toMatchObject({
      cause: "transport-transient",
      message: ENOTFOUND,
    });
  });

  it("PAIRED NEGATIVE — an agent that never printed a banner is still unknown", async () => {
    // Required, and not a formality: without it "the banner produced the verdict" is unfalsifiable,
    // because a bug that returned `transport-transient` for EVERY pty-exit would pass the test
    // above. This is also the human-clicked-stop case, which must stay unresurrectable.
    const { engine, calls } = engineOn("t-quiet");
    engine.ingest(RETRY_PROGRESS);
    clock += 1_000;

    engine.exit();
    await settle();

    expect(calls.closes()[0]?.death).toMatchObject({ cause: "unknown", evidence: "pty-exit" });
  });

  it("AGED OUT — a banner older than the window no longer explains the death", async () => {
    // The retained copy is bounded on READ rather than cleared on recovery, so this is the only
    // thing standing between it and the permanent stamp `lastFailure` correctly refuses to be. An
    // agent that blipped an hour ago and was later stopped by a human is NOT a transport death.
    const { engine, calls } = engineOn("t-old");
    engine.ingest(`${ENOTFOUND}\n`);
    engine.ingest(RETRY_PROGRESS);
    clock += TRANSPORT_FAILURE_WINDOW_MS + 1;

    engine.exit();
    await settle();

    expect(calls.closes()[0]?.death).toMatchObject({ cause: "unknown", evidence: "pty-exit" });
  });

  it("still counts at exactly the window boundary — the measured retry run must fit inside it", async () => {
    // Pins the comparison's DIRECTION, which the aged-out test alone cannot: `<=` vs `<` differ only
    // here. It also states the sizing constraint — the measured sequence is 176s and the window is
    // 300s, so a death at the far edge of a retry run is still inside it.
    const { engine, calls } = engineOn("t-edge");
    engine.ingest(`${ENOTFOUND}\n`);
    engine.ingest(RETRY_PROGRESS);
    clock += TRANSPORT_FAILURE_WINDOW_MS;

    engine.exit();
    await settle();

    expect(calls.closes()[0]?.death).toMatchObject({ cause: "transport-transient" });
  });

  it("A LIVE WALL STILL OUTRANKS A RETAINED BANNER — never retry into a closed door", async () => {
    // THE REGRESSION THIS CHANGE COULD HAVE INTRODUCED. Before it, a retained banner did not exist,
    // so nothing competed with the wall at Gate 2. Now both survive `clearStreamFailure()` — the
    // wall in `quotaBlock`, the banner in `lastFailureEver` — and if Gate 4 ran first, an agent
    // barred by its account limit would be recorded `transport-transient` and retried against a door
    // no keystroke opens. That is the measured 45-retry failure this area exists to prevent.
    const { engine, calls } = engineOn("t-wall");
    engine.ingest(`${SESSION_WALL}\n`); // sets the quota block AND fires the quota-trip note
    engine.ingest(`${ENOTFOUND}\n`); // …and then the transport fails too
    engine.ingest(RETRY_PROGRESS); // …and the retry clears the live banner, retaining it
    clock += 1_000;
    expect(lastFailureForAgent("t-wall")).toBeUndefined();
    expect(
      recentFailureForAgent("t-wall", Date.now()),
      "the banner really is retained — otherwise the wall wins for the wrong reason",
    ).toMatchObject({ message: ENOTFOUND });

    engine.exit();
    await settle();

    const close = calls.closes()[0];
    expect(close?.death).toMatchObject({ cause: "wall-session", evidence: "quota-block" });
    expect(close?.wall).toMatchObject({ message: SESSION_WALL, resetParsed: true });
  });

  it("wires the retained reader into the REAL deps, not just the test's", () => {
    // The defaulted-seam trap (AGENTS.md): every test above injects its own deps, so the one line in
    // `liveDeps()` that supplies the production reader would be covered by nothing — delete it and
    // the whole suite stays green while the fix is inert for every real agent.
    const { engine } = engineOn("t-live");
    engine.ingest(`${ENOTFOUND}\n`);
    engine.ingest(RETRY_PROGRESS);
    clock += 1_000;

    expect(liveDeps().lastFailure("t-live")).toBeUndefined();
    expect(liveDeps().recentFailure("t-live", Date.now())).toMatchObject({ message: ENOTFOUND });
  });
});

// ── THE RETIREMENT AUDIT TRAIL ────────────────────────────────────────────────────────────────
//
// The concierge's `retire_agent` verb closes finished agents unattended and with NO cap. The
// founder's condition for that autonomy is a record he can read afterwards — which agent, why, and
// what safety reading was in hand — and the caller TEARS THE ROW DOWN on this function's boolean.
// So the two things worth testing are the payload that reaches the ledger and, above everything
// else, that a failed write cannot come back as `true`.
describe("retiring an agent records who did it and what they saw", () => {
  /** A fully-populated reading, so an assertion cannot pass on a half-built object. */
  const FULL: RetiredEvidence = {
    worktreeRisk: "clean",
    landed: true,
    stage: "merged",
    branch: "sparkle/agent-42",
    ahead: 0,
    retroStanding: "settled",
    gapReceiptWritten: false,
    terminalEvidence: "  PR #1776 merged.\n  goal met\n",
    terminalEvidenceObservedAt: NOW - 5_000,
  };

  const retires = (c: Calls) =>
    c.invoked.filter(([cmd]) => cmd === "agent_life_retire").map(([, args]) => args);

  it("sends the retirer and the whole evidence object to the durable ledger", async () => {
    const c = deps();
    const ok = await recordAgentRetirement(
      { agentId: "a1", reason: "finished", retiredBy: "concierge", evidence: FULL },
      c.deps,
    );

    expect(ok).toBe(true);
    // The SIDE EFFECT: what actually reached the command, field for field. `toEqual` rather than
    // `toMatchObject` on purpose — a dropped evidence field is exactly the defect that would leave
    // the founder reading a retirement with no reading behind it, and `toMatchObject` would not
    // notice.
    expect(retires(c)).toEqual([
      { agentId: "a1", reason: "finished", retiredBy: "concierge", evidence: FULL },
    ]);
  });

  it("keeps the terminal excerpt VERBATIM — the independent check on the retirer's summary", async () => {
    const c = deps();
    const verbatim = "  ⏵⏵ accept edits on\n\n> [2mwaiting[0m   \n";
    await recordAgentRetirement(
      {
        agentId: "a1",
        reason: "idle",
        retiredBy: "concierge",
        evidence: { ...FULL, terminalEvidence: verbatim },
      },
      c.deps,
    );

    const sent = retires(c)[0]?.evidence as RetiredEvidence;
    expect(sent.terminalEvidence).toBe(verbatim);
  });

  it("RETURNS FALSE when the durable write fails — the caller gates a teardown on this", async () => {
    // THE ONE THAT MATTERS. A `true` here destroys the row AND the record that was supposed to
    // outlive it, which is the exact failure this record exists to prevent. The write is made to
    // genuinely fail (a rejected invoke, the shape a missing Tauri host or a full disk produces),
    // not stubbed to return false.
    const attempted: string[] = [];
    const c = deps({
      invoke: (cmd) => {
        attempted.push(cmd);
        return Promise.reject(new Error("io: no space left on device"));
      },
    });
    const ok = await recordAgentRetirement(
      { agentId: "a1", reason: "finished", retiredBy: "concierge", evidence: FULL },
      c.deps,
    );

    expect(ok).toBe(false);
    // …and it did not throw either: an accountability affordance that crashes its caller is worse
    // than none. And the attempt was really MADE: without this, a future short-circuit that skips
    // the durable write entirely would satisfy the `false` above while writing nothing at all.
    expect(attempted).toEqual(["agent_life_retire"]);
  });

  it("a human retirement is attributed to the human, not left blank", async () => {
    const c = deps();
    await recordAgentRetirement(
      {
        agentId: "a1",
        reason: "I'm done with this one",
        retiredBy: "human",
        evidence: { ...FULL, worktreeRisk: "dirty", retroStanding: "absent" },
      },
      c.deps,
    );

    expect(retires(c)[0]?.retiredBy).toBe("human");
    expect(retires(c)[0]?.evidence).toMatchObject({
      worktreeRisk: "dirty",
      retroStanding: "absent",
    });
  });

  // ── THE TS→RUST SEAM ────────────────────────────────────────────────────────────────────────
  //
  // `agent_life::RetiredEvidence` carries `skip_serializing_if` on every optional field, so the
  // wire can present an optional as an explicit `null` OR as an absent key. Both must reach serde
  // as `None`. These two payloads are the exact fixtures
  // `the_wire_accepts_both_an_explicit_null_and_an_omitted_key` parses on the Rust side — asserted
  // AFTER a `JSON.stringify` round trip, because that is the transform Tauri applies and it is what
  // silently turns an `undefined` into an absent key.
  it("an undefined optional leaves the key ABSENT, which is what serde reads as None", async () => {
    const c = deps();
    const evidence: RetiredEvidence = {
      worktreeRisk: "dirty",
      retroStanding: "reported",
      gapReceiptWritten: true,
      landed: undefined,
      stage: undefined,
    };
    await recordAgentRetirement(
      { agentId: "a1", reason: "unknown state", retiredBy: "concierge", evidence },
      c.deps,
    );

    const onTheWire = JSON.parse(JSON.stringify(retires(c)[0]?.evidence));
    expect(onTheWire).toEqual({
      worktreeRisk: "dirty",
      retroStanding: "reported",
      gapReceiptWritten: true,
    });
    expect("landed" in onTheWire).toBe(false);
  });

  it("an explicit null survives the round trip and means the same thing", async () => {
    const c = deps();
    const evidence: RetiredEvidence = {
      worktreeRisk: "dirty",
      landed: null,
      stage: null,
      branch: null,
      ahead: null,
      retroStanding: "reported",
      gapReceiptWritten: true,
      terminalEvidence: null,
      terminalEvidenceObservedAt: null,
    };
    await recordAgentRetirement(
      { agentId: "a1", reason: "unknown state", retiredBy: "concierge", evidence },
      c.deps,
    );

    const onTheWire = JSON.parse(JSON.stringify(retires(c)[0]?.evidence));
    // `null`, NOT dropped — this is the half of the wire an `?: T` type would have rejected.
    expect(onTheWire.landed).toBeNull();
    expect(onTheWire.terminalEvidenceObservedAt).toBeNull();
    expect(onTheWire.worktreeRisk).toBe("dirty");
  });

  it("the PRODUCTION default deps are wired, and they too refuse to report a false success", async () => {
    // The defaulted-seam trap (AGENTS.md): every test above injects `deps`, so the one line that
    // supplies `liveDeps()` at the real call site is covered by nothing — delete it and the suite
    // stays green while every real retirement writes through a dep that does not exist. Driven with
    // NO deps argument, exactly as the concierge caller invokes it. There is no Tauri host under
    // vitest, so the real `invoke` genuinely fails, and the answer must be `false`.
    await expect(
      recordAgentRetirement({
        agentId: "a1",
        reason: "finished",
        retiredBy: "concierge",
        evidence: FULL,
      }),
    ).resolves.toBe(false);
  });
});

// ══ READING THE DURABLE LEDGER BACK ═════════════════════════════════════════════════════════════
// The write side has been covered since the verb landed; the READER was missing, and its absence was
// the defect (roborev 63376): the audit pane was reading the in-memory receipt ring instead, which
// is capped across all receipt kinds and empty after a restart.
describe("readRetirementLog", () => {
  const wire = (over: Record<string, unknown> = {}) => ({
    record: {
      agentId: "a1",
      retiredAt: 1_700_000_000_000,
      retiredReason: "landed and idle",
      retiredBy: "concierge",
      ...over,
    },
  });

  it("returns retirements newest first, with the reason verbatim", async () => {
    const c = deps({
      invoke: () =>
        Promise.resolve({
          old: wire({ agentId: "old", retiredAt: 1_000, retiredReason: "first" }),
          recent: wire({ agentId: "recent", retiredAt: 9_000, retiredReason: "second" }),
        } as never),
    });
    const r = await readRetirementLog(c.deps);
    expect(r.ok).toBe(true);
    expect(r.records.map((x) => x.agentId)).toEqual(["recent", "old"]);
    expect(r.records[0]!.reason).toBe("second");
  });

  it("ignores records that were never retired", async () => {
    // `retiredAt` is the stamp the retire path writes. Absent AND null both mean "still open" —
    // reading either as a retirement would invent rows for every live agent on the ledger.
    const c = deps({
      invoke: () =>
        Promise.resolve({
          live: { record: { agentId: "live" } },
          nulled: { record: { agentId: "nulled", retiredAt: null } },
          real: wire({ agentId: "real" }),
        } as never),
    });
    const r = await readRetirementLog(c.deps);
    expect(r.records.map((x) => x.agentId)).toEqual(["real"]);
  });

  it("attributes anything that is not exactly `concierge` to a HUMAN", async () => {
    // Records predating the field carry no `retiredBy`. Guessing "concierge" there would credit the
    // app with a decision a person made, on a permanent record.
    const c = deps({
      invoke: () =>
        Promise.resolve({
          older: wire({ agentId: "older", retiredBy: undefined }),
          bot: wire({ agentId: "bot", retiredBy: "concierge", retiredAt: 2 }),
        } as never),
    });
    const r = await readRetirementLog(c.deps);
    const by = Object.fromEntries(r.records.map((x) => [x.agentId, x.retiredBy]));
    expect(by).toEqual({ older: "human", bot: "concierge" });
  });

  it("reports ok:false on a failed read, so an empty list is never mistaken for `nothing retired`", async () => {
    // THE DISTINCTION THE VOLATILE READER DESTROYED. Both a healthy-but-empty ledger and an
    // unreadable one produce zero rows; only this flag tells the surface which it is looking at.
    const c = deps({ invoke: () => Promise.reject(new Error("no tauri host")) });
    const r = await readRetirementLog(c.deps);
    expect(r.ok).toBe(false);
    expect(r.records).toEqual([]);

    const healthy = deps({ invoke: () => Promise.resolve({} as never) });
    const empty = await readRetirementLog(healthy.deps);
    expect(empty.ok).toBe(true);
    expect(empty.records).toEqual([]);
  });

  it("survives a ledger far larger than the receipt ring — the overnight case", async () => {
    // The ring caps at 64 ACROSS ALL KINDS, so a busy night evicted the earliest retirements before
    // the pane ever subscribed: not shown, and not counted either.
    const many = Object.fromEntries(
      Array.from({ length: 250 }, (_, i) => [
        `a${i}`,
        wire({ agentId: `a${i}`, retiredAt: i + 1, retiredReason: `r${i}` }),
      ]),
    );
    const c = deps({ invoke: () => Promise.resolve(many as never) });
    const r = await readRetirementLog(c.deps);
    expect(r.records).toHaveLength(250);
    expect(r.records[0]!.agentId).toBe("a249");
  });
});

describe("a mid-task exit is surfaced as a hard signal, not left as a bare resume line (sparkle-ffm5bn)", () => {
  // An unmet goal, live and within its ttl — the in-flight-work case.
  function unmetGoal(over: Partial<AgentGoal> = {}): AgentGoal {
    return {
      text: "land the retry PR",
      setAt: NOW - 60_000,
      ttlMs: 4 * 60 * 60_000,
      continues: 0,
      totalContinues: 0,
      ...over,
    };
  }

  it("escalates when a pty-exit with the resume banner leaves the goal unmet — and still closes the record", async () => {
    const escalations: string[] = [];
    const c = deps({
      goal: () => unmetGoal(),
      resumeBanner: () => true,
      escalate: (text) => {
        escalations.push(text);
        return true;
      },
    });

    const verdict = await recordDeath("a1", "pty-exit", c.deps);

    // THE SURFACE — the whole point of the change. A silent auto-resume left the founder to re-derive
    // hours of lost work; the hard signal is what says the in-flight deliverable may be gone.
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatch(/exited mid-task/i);
    expect(escalations[0]).toContain("a1");
    // Recovery is NOT suppressed: the record still closes with the resurrectable `unknown` cause, so
    // #2492's fast-track still resumes the session. Surfacing and recovering are both true here.
    expect(verdict?.cause).toBe("unknown");
    expect(c.closes()).toHaveLength(1);
  });

  it("reads the resume banner BEFORE the close await, so a teardown mid-await cannot suppress the signal", async () => {
    // The read-order race (roborev 68290/68291). `resumeBannerForAgent` is a LIVE read that goes
    // false the instant the engine is disposed or #2492's fast-track repaints the pane — both of which
    // can happen during the `agent_life_close` IPC await. If the read were taken AFTER that await this
    // escalation would vanish in exactly the scenarios the bead names. The stub flips the banner
    // source to false the moment `invoke` runs; the signal must still fire, proving the read is
    // snapshotted synchronously with the rest of the observation.
    let bannerNow = true;
    const escalations: string[] = [];
    const c = deps({
      goal: () => unmetGoal(),
      resumeBanner: () => bannerNow,
      escalate: (text) => {
        escalations.push(text);
        return true;
      },
      invoke: () => {
        // The teardown that clears the banner, happening DURING the close await.
        bannerNow = false;
        return Promise.resolve(undefined as never);
      },
    });

    await recordDeath("a1", "pty-exit", c.deps);

    expect(escalations).toHaveLength(1);
  });

  it("does NOT stamp the death record's message — that field is the resurrection COHORT KEY, not display", async () => {
    // roborev 68295/68296: `resurrectionCohort.cohortKeyOf` is `${cause}:${message ?? ""}` (exact
    // equality). A mid-task exit is `unknown`, and `unknown` is resurrectable and DOES go through
    // `groupCohorts`. Writing a marker onto `message` would split the `unknown:` bucket, drop a cohort
    // below SHARED_FAILURE_MIN_VICTIMS, and respawn lone deaths in parallel — the resume-flood the
    // cohort machinery exists to prevent. So a mid-task exit must key IDENTICALLY to a bare stop.
    const midTask = deps({ goal: () => unmetGoal(), resumeBanner: () => true, escalate: () => true });
    const bareStop = deps({ goal: () => unmetGoal(), resumeBanner: () => false, escalate: () => true });

    await recordDeath("a1", "pty-exit", midTask.deps);
    await recordDeath("a1", "pty-exit", bareStop.deps);

    const midMsg = (midTask.closes()[0]!.death as { message?: string }).message;
    const bareMsg = (bareStop.closes()[0]!.death as { message?: string }).message;
    // Both leave `message` exactly as classifyDeath set it (undefined for a bare pty-exit) — the mid-
    // task surface must not perturb the byte the cohort key reads.
    expect(midMsg).toBeUndefined();
    expect(midMsg).toBe(bareMsg);
  });

  it("closes the record normally when the concierge push is REFUSED — the signal is owed, not persisted", async () => {
    // A refused push (no sink in this window) must not change what is written or throw. The finding is
    // owed via the WARN log; nothing durable is stamped, precisely because `message` is a cohort key.
    const c = deps({ goal: () => unmetGoal(), resumeBanner: () => true, escalate: () => false });

    const verdict = await recordDeath("a1", "pty-exit", c.deps);

    expect(verdict?.cause).toBe("unknown");
    expect(c.closes()).toHaveLength(1);
    expect((c.closes()[0]!.death as { message?: string }).message).toBeUndefined();
  });

  it("does NOT escalate without the resume banner — a silent crash is not a clean mid-task exit", async () => {
    // The paired negative that pins the banner gate: same unmet goal, same pty-exit, banner absent.
    const escalations: string[] = [];
    const c = deps({
      goal: () => unmetGoal(),
      resumeBanner: () => false,
      escalate: (text) => {
        escalations.push(text);
        return true;
      },
    });

    const verdict = await recordDeath("a1", "pty-exit", c.deps);

    expect(escalations).toEqual([]);
    // The death is still recorded — only the extra surface is withheld.
    expect(verdict?.cause).toBe("unknown");
    expect(c.closes()).toHaveLength(1);
  });

  it("does NOT escalate when the goal was already met — nothing was in flight", async () => {
    // The paired negative that pins the goal gate: banner present, but a met goal makes this an
    // ordinary finish (`clean-goal-met`), not lost work.
    const escalations: string[] = [];
    const c = deps({
      goal: () => unmetGoal({ metAt: NOW - 1_000 }),
      resumeBanner: () => true,
      escalate: (text) => {
        escalations.push(text);
        return true;
      },
    });

    const verdict = await recordDeath("a1", "pty-exit", c.deps);

    expect(escalations).toEqual([]);
    expect(verdict?.cause).toBe("clean-goal-met");
  });

  it("does NOT escalate on a window that did not watch the agent (Refusal 1)", async () => {
    // No record is written for an unobserved death, so no surface may fire off it either.
    const escalations: string[] = [];
    const c = deps({
      liveness: () => "other-window",
      goal: () => unmetGoal(),
      resumeBanner: () => true,
      escalate: (text) => {
        escalations.push(text);
        return true;
      },
    });

    await expect(recordDeath("a1", "pty-exit", c.deps)).resolves.toBeNull();
    expect(escalations).toEqual([]);
    expect(c.closes()).toEqual([]);
  });
});

// THE MEASURED LAYOUT, verbatim in the shape Claude Code writes on this machine: a session file
// `<project-slug>/<sessionId>.jsonl`, with each dispatched subagent's own transcript in a
// `subagents/` directory named for that session. Written out longhand rather than built with the
// helper under test, so the derivation is pinned against an OBSERVED path and not against itself.
const PARENT_TRANSCRIPT =
  "/Users/x/.claude/projects/-Users-x-wt/a9907495-45e0-426a-ba81-b0a29346a15a.jsonl";
const SUBAGENT_DIR =
  "/Users/x/.claude/projects/-Users-x-wt/a9907495-45e0-426a-ba81-b0a29346a15a/subagents";

describe("the mid-task-exit notice names ORPHANED SUBAGENTS when the parent had fan-out in flight (sparkle-y5dk8x)", () => {
  function unmetGoal(over: Partial<AgentGoal> = {}): AgentGoal {
    return {
      text: "land the retry PR",
      setAt: NOW - 60_000,
      ttlMs: 4 * 60 * 60_000,
      continues: 0,
      totalContinues: 0,
      ...over,
    };
  }

  beforeEach(() => {
    _resetOrphanedSubagentRegistryForTests();
    _resetBackgroundTaskRegistryForTests();
  });
  afterEach(() => {
    _resetOrphanedSubagentRegistryForTests();
    _resetBackgroundTaskRegistryForTests();
  });

  // ── THE PURE COPY, both branches (non-vacuous: each assertion fails under the other branch) ──────
  it("with orphaned subagents: says they did NOT survive and points at the recoverable transcripts", () => {
    const notice = midTaskExitNotice("a1", 3, PARENT_TRANSCRIPT);
    expect(notice).toContain("3 background tasks/subagents");
    expect(notice).toMatch(/did NOT survive/);
    expect(notice).toContain(`${SUBAGENT_DIR}/${SUBAGENT_TRANSCRIPT_GLOB}`);
    expect(notice).toContain("a1");
    // THE DEFECT THIS BRANCH FIXES: PR #2613 sent the reader to the parent's OWN transcript,
    // "where the subagents' turns were interleaved". Measured on disk, a parent transcript holds no
    // `isSidechain:true` record at all — that sentence must never come back.
    expect(notice).not.toMatch(/own session transcript/);
    expect(notice).not.toMatch(/interleaved/);
    // The overclaim the bead was filed about must be GONE on this branch — the work was not merely
    // "not lost", it was affirmatively orphaned.
    expect(notice).not.toContain("in-flight deliverable may not have been written");
  });

  it("pluralizes: a single orphan reads '1 background task/subagent'", () => {
    expect(midTaskExitNotice("a1", 1)).toContain("1 background task/subagent");
    expect(midTaskExitNotice("a1", 1)).not.toContain("1 background tasks/subagents");
  });

  it("with NO fan-out (0 or undefined): the subagent clause is ABSENT — no overclaim", () => {
    for (const count of [0, undefined] as const) {
      const notice = midTaskExitNotice("a1", count);
      expect(notice).toContain("in-flight deliverable may not have been written");
      expect(notice).not.toMatch(/subagent/i);
      expect(notice).not.toMatch(/did NOT survive/);
    }
  });

  // ── recordDeath THREADS the dep into the escalation (side effect at the real entry point) ────────
  it("escalation names the orphans when the death path reports a positive orphaned count", async () => {
    const escalations: string[] = [];
    const c = deps({
      goal: () => unmetGoal(),
      resumeBanner: () => true,
      orphanedSubagents: () => 2,
      parentTranscriptPath: () => PARENT_TRANSCRIPT,
      escalate: (text) => {
        escalations.push(text);
        return true;
      },
    });

    await recordDeath("a1", "pty-exit", c.deps);

    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toContain("2 background tasks/subagents");
    expect(escalations[0]).toContain(`${SUBAGENT_DIR}/${SUBAGENT_TRANSCRIPT_GLOB}`);
  });

  it("escalation stays the plain copy when the death path reports NO orphaned subagents", async () => {
    const escalations: string[] = [];
    const c = deps({
      goal: () => unmetGoal(),
      resumeBanner: () => true,
      // The default dep is `() => undefined`; assert the negative wiring explicitly.
      orphanedSubagents: () => undefined,
      escalate: (text) => {
        escalations.push(text);
        return true;
      },
    });

    await recordDeath("a1", "pty-exit", c.deps);

    expect(escalations).toHaveLength(1);
    expect(escalations[0]).not.toMatch(/subagent/i);
  });

  // ── END TO END: statusEngine.exit() CAPTURES the live count, and the notice reads it back ────────
  it("engine.exit snapshots the live background count → the notice names it (the whole chain)", async () => {
    // The footer count as it stood the instant before the PTY closed.
    noteBackgroundTasks("e2e", 3);
    const engine = new StatusEngine({ agentId: "e2e", onStatus: () => {} });
    // exit() must capture the 3 into the orphan registry BEFORE it forgets the live footer count.
    engine.exit();
    expect(orphanedSubagentsForAgent("e2e")).toBe(3);

    const escalations: string[] = [];
    const c = deps({
      goal: () => unmetGoal(),
      resumeBanner: () => true,
      // The PRODUCTION dep — reads the real registry the engine just wrote, not a stub.
      orphanedSubagents: orphanedSubagentsForAgent,
      escalate: (text) => {
        escalations.push(text);
        return true;
      },
    });

    await recordDeath("e2e", "pty-exit", c.deps);

    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toContain("3 background tasks/subagents");
  });

  it("engine.exit with NO live background tasks records nothing — the paired negative", () => {
    const engine = new StatusEngine({ agentId: "none", onStatus: () => {} });
    engine.exit();
    expect(orphanedSubagentsForAgent("none")).toBeUndefined();
  });

  // ── The snapshot is cleared at the SPAWN edge, so a recovered episode's count cannot bleed forward ─
  it("openDeathRecord (respawn) clears the orphaned-subagent snapshot", async () => {
    noteBackgroundTasks("respawn", 5);
    new StatusEngine({ agentId: "respawn", onStatus: () => {} }).exit();
    expect(orphanedSubagentsForAgent("respawn")).toBe(5);

    // A successful open (respawn) must forget it, exactly as it forgets the dead-session mark.
    const landed = await openDeathRecord("respawn", "proj", "/wt", deps().deps);
    expect(landed).toBe(true);
    expect(orphanedSubagentsForAgent("respawn")).toBeUndefined();
  });

  // ── PRODUCTION default is wired to the real registry (the defaulted-seam trap, AGENTS.md) ─────────
  it("liveDeps().orphanedSubagents reads the real registry, not a stub", () => {
    noteBackgroundTasks("seam-orphan", 7);
    new StatusEngine({ agentId: "seam-orphan", onStatus: () => {} }).exit();
    expect(liveDeps().orphanedSubagents("seam-orphan")).toBe(7);
    expect(liveDeps().orphanedSubagents("nobody-here")).toBeUndefined();
  });

  // ══ THE RECOVERABLE PARTIAL TRANSCRIPT (the sparkle-y5dk8x half PR #2613 left open) ═════════════
  //
  // Every assertion below is on the CONTENT of the surface a parent actually receives — the notice
  // string — never on a helper having been called. The bead's own complaint is that the old copy
  // "implied the work is fine when it is actually gone", so the only thing worth asserting is
  // whether the words handed to the concierge carry an address the work is really at.

  it("names no directory when this window recorded no exact session file — but still says the fan-out was lost", () => {
    const notice = midTaskExitNotice("a1", 3, undefined);
    // The orphan half is UNCONDITIONAL: the fan-out died whether or not we can address it.
    expect(notice).toContain("3 background tasks/subagents");
    expect(notice).toMatch(/did NOT survive/);
    // …but no path is invented. Naming a directory we are not sure of is the exact defect being
    // fixed, so the recovery glob must be absent rather than pointed somewhere plausible.
    expect(notice).not.toContain(SUBAGENT_TRANSCRIPT_GLOB);
    expect(notice).not.toContain(SUBAGENT_DIR);
    expect(notice).toMatch(/never recorded which session file/);
  });

  it("a path that is not an exact `.jsonl` session file (a worktree) yields no address", () => {
    // `agentTranscriptRegistry` writer (2) stores a WORKTREE, resolved to a file only at read time.
    // Appending `/subagents` to that would name a directory inside the user's source tree.
    const notice = midTaskExitNotice("a1", 2, "/Users/x/Projects/sparkle/.wt-feature");
    expect(notice).not.toContain(SUBAGENT_TRANSCRIPT_GLOB);
    expect(notice).not.toContain("/Users/x/Projects/sparkle/.wt-feature/subagents");
    expect(notice).toMatch(/never recorded which session file/);
  });

  it("THE TWO GATES ARE INDEPENDENT: a known path with NO fan-out still names no directory", () => {
    // The paired negative the bead's overclaim rule demands, in its hardest form: we HAVE an
    // address, and must still stay silent because nothing was orphaned. A single fused condition
    // ("mention the directory whenever we know it") passes every other test in this file and fails
    // exactly here — which is why this one is worth its own case.
    for (const count of [0, undefined] as const) {
      const notice = midTaskExitNotice("a1", count, PARENT_TRANSCRIPT);
      expect(notice).toContain("in-flight deliverable may not have been written");
      expect(notice).not.toMatch(/subagent/i);
      expect(notice).not.toContain(SUBAGENT_DIR);
    }
  });

  // ── THROUGH THE REAL DEATH PATH, with EVERY earlier gate satisfied (AGENTS.md short-circuit trap) ─
  //
  // `recordDeath` reaches the escalation only past: Gate 0 liveness "local", Refusal 1
  // (evidence !== "none"), Refusal 2 (terminator !== "quota-trip"), and `exitedMidTask`'s own three
  // inputs — unknown cause, UNMET goal, resume banner on screen. Seed all of them, or the assertion
  // is about a path the code never took.
  it("recordDeath's escalation carries the REAL subagents directory derived from this agent's transcript", async () => {
    const escalations: string[] = [];
    const c = deps({
      goal: () => unmetGoal(),
      resumeBanner: () => true,
      orphanedSubagents: () => 4,
      parentTranscriptPath: () => PARENT_TRANSCRIPT,
      escalate: (text) => {
        escalations.push(text);
        return true;
      },
    });

    await recordDeath("a1", "pty-exit", c.deps);

    expect(escalations).toHaveLength(1);
    // THE OUTPUT, not the plumbing: the concierge is handed the directory the orphans' partial
    // JSONL transcripts are really in, plus the glob that selects them.
    expect(escalations[0]).toContain(`${SUBAGENT_DIR}/${SUBAGENT_TRANSCRIPT_GLOB}`);
    expect(escalations[0]).toMatch(/meta\.json/);
    expect(escalations[0]).toContain("4 background tasks/subagents");
  });

  it("THE PAIRED POSITIVE: the identical setup still escalates when the address is unknown", async () => {
    // Proves the previous test's assertion is about the ADDRESS and not about whether the death
    // path fires at all. Same seeded gates, only `parentTranscriptPath` differs; the notice still
    // arrives, and only the directory is missing from it.
    const escalations: string[] = [];
    const c = deps({
      goal: () => unmetGoal(),
      resumeBanner: () => true,
      orphanedSubagents: () => 4,
      parentTranscriptPath: () => undefined,
      escalate: (text) => {
        escalations.push(text);
        return true;
      },
    });

    await recordDeath("a1", "pty-exit", c.deps);

    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toContain("4 background tasks/subagents");
    expect(escalations[0]).not.toContain(SUBAGENT_DIR);
  });

  it("an EARLIER gate short-circuits: no resume banner ⇒ no notice at all, address or not", async () => {
    // The one shape that would make every assertion above vacuous — a surface that never fires.
    const escalations: string[] = [];
    const c = deps({
      goal: () => unmetGoal(),
      resumeBanner: () => false,
      orphanedSubagents: () => 4,
      parentTranscriptPath: () => PARENT_TRANSCRIPT,
      escalate: (text) => {
        escalations.push(text);
        return true;
      },
    });

    await recordDeath("a1", "pty-exit", c.deps);

    expect(escalations).toHaveLength(0);
  });

  it("liveDeps().parentTranscriptPath reads the real registry, not a stub (the defaulted-seam trap)", () => {
    // Without this, the line wiring production to `agentTranscriptRegistry` is covered by nothing:
    // every test above injects its own path, so deleting that line leaves the suite green while the
    // shipped notice silently loses its address forever.
    noteAgentTranscriptPath("seam-transcript", PARENT_TRANSCRIPT);
    try {
      expect(agentTranscriptPath("seam-transcript")).toBe(PARENT_TRANSCRIPT);
      expect(liveDeps().parentTranscriptPath("seam-transcript")).toBe(PARENT_TRANSCRIPT);
      expect(liveDeps().parentTranscriptPath("nobody-here")).toBeUndefined();
    } finally {
      forgetAgentTranscriptPath("seam-transcript");
    }
  });
});

// The graceful-exit banner Claude Code leaves on screen, verbatim shape from #2492's own fixture.
const RESUME_SCREEN_FOR_SEAM = [
  "work done.",
  "",
  "Resume this session with:",
  "  claude --resume 4c1f6312-e927-47c2-aa8b-4a08cbdb3df9",
  "",
].join("\n");

describe("the PRODUCTION default deps for the mid-task surface are wired (sparkle-ffm5bn)", () => {
  // The defaulted-seam trap (AGENTS.md, roborev 68291): every test above injects `resumeBanner` and
  // `escalate`, so the two lines in `liveDeps()` that supply the REAL edges are covered by nothing —
  // replace `resumeBannerForAgent` with `() => false` (feature permanently inert for real agents) or
  // drop the `notifyConcierge` wiring (signal goes nowhere) and the whole suite above stays green.
  // These drive the real defaults, in the style of the two seam tests already in this file.
  const seamEngines: StatusEngine[] = [];
  afterEach(() => {
    for (const e of seamEngines.splice(0)) unregisterStatusEngine("seam-mte", e);
  });

  it("resumeBanner reads the live registered engine: false unregistered, false alive, true once exited with the banner", () => {
    // The SAFE default first: no engine registered → no fast-track, no surface.
    expect(liveDeps().resumeBanner("seam-mte")).toBe(false);

    const engine = new StatusEngine({
      agentId: "seam-mte",
      onStatus: () => {},
      getScreen: () => RESUME_SCREEN_FOR_SEAM,
    });
    registerStatusEngine("seam-mte", engine);
    seamEngines.push(engine);

    // Registered but ALIVE → still false (the `exited` liveness gate #2492 added).
    expect(liveDeps().resumeBanner("seam-mte")).toBe(false);

    engine.exit();
    // Registered AND exited AND banner on screen → the production read answers true.
    expect(liveDeps().resumeBanner("seam-mte")).toBe(true);
  });

  it("escalate is the real notifier: false with no sink, true once a sink accepts the text", () => {
    // No sink registered → the push goes nowhere, which is `false` (the refusal the WARN path handles).
    expect(liveDeps().escalate("mid-task exit test")).toBe(false);

    const seen: string[] = [];
    const sink = (text: string) => {
      seen.push(text);
      return true;
    };
    setConciergeNotifier(sink);
    try {
      expect(liveDeps().escalate("mid-task exit test")).toBe(true);
      expect(seen).toEqual(["mid-task exit test"]);
    } finally {
      clearConciergeNotifier(sink);
    }
  });
});
