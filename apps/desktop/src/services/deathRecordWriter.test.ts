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
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StatusEngine } from "../engine/statusEngine";
import {
  type DeathRecordDeps,
  openDeathRecord,
  recordDeath,
} from "./deathRecordWriter";

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
    // "local" means THIS window watched the agent. Anything else and `classifyDeath`'s Gate 0
    // refuses to claim anything, which is asserted on its own below.
    liveness: () => "local",
    goal: () => undefined,
    blockingTool: () => undefined,
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
