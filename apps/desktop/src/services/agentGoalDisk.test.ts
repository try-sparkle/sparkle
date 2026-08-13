// @vitest-environment jsdom
//
// THE ANTI-DRIFT TEST LIVES HERE, and it is the reason this file matters more than its size suggests.
//
// `scripts/tests/fixtures/agent-goal-record.json` is the ONE canonical instance of the frozen
// contract. This suite builds an equivalent goal in memory, runs it through the real serializer, and
// deep-equals the result against that parsed file — and the shell reader's suite reads the SAME
// file. So the two halves fail TOGETHER. AGENTS.md records what happens without that: two agents
// built the two halves of a payload in parallel against a frozen FIELD LIST, both suites passed, the
// merge was clean, and the shipped feature never once ran because one side's shape could not be
// produced by the other.
//
// Everything else here asserts a SIDE EFFECT — the command that was invoked and the bytes it
// carried — never that a variable was set. A record nobody wrote is exactly the silent failure this
// module exists to abolish.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real Tauri bridge, replaced at its ONE seam — so the zero-argument
// `startAgentGoalDiskMirror()` (the production call site) can be driven end to end. A seam every
// test injects leaves that line covered by nothing (sparkle-lgbwf): delete it and the suite stays
// green while the feature is dead.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import { type AgentGoal } from "../engine/agentGoal";
import { useProjectStore } from "../stores/projectStore";
import type { AgentTab, Project } from "../types";
import {
  type AgentGoalRecord,
  type GoalDiskDeps,
  GOAL_DISK_DEBOUNCE_MS,
  GOAL_DISK_SWEEP_MS,
  _resetAgentGoalDiskForTests,
  buildAgentGoalRecord,
  startAgentGoalDiskMirror,
  syncAgentGoalRecords,
} from "./agentGoalDisk";

const invokeMock = vi.mocked(tauriInvoke);

/** The frozen canonical instance. Read from disk, never re-typed — a copy pasted into this file
 *  would drift from the shell reader's copy, which is precisely what it exists to prevent. */
const FIXTURE_PATH = resolve(__dirname, "../../../../scripts/tests/fixtures/agent-goal-record.json");
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as AgentGoalRecord;

interface Harness {
  deps: GoalDiskDeps;
  /** `[command, args]` for every invoke the mirror made. */
  invoked: Array<[string, Record<string, unknown>]>;
  /** How many sweeps ran — one `projects()` read per pass. What the debounce test counts. */
  passes: () => number;
  setProjects: (p: Project[]) => void;
  /** The SIMULATED agent-goals directory, which the fake `invoke` keeps in step with the write and
   *  delete commands exactly as the Rust half does. Seed it to stage a record this window never
   *  wrote — an orphan from a previous session, or one left by the other window. */
  onDisk: Set<string>;
}

/** The Nth write's args, with the index check the strict `noUncheckedIndexedAccess` setting wants
 *  done once rather than with a `!` at every call site. */
function writeArgs(
  writes: Array<readonly [string, Record<string, unknown>]>,
  n: number,
): Record<string, unknown> {
  const at = writes[n];
  if (at === undefined) throw new Error(`expected a write at index ${n}, saw ${writes.length}`);
  return at[1];
}

const NOW = 1_786_000_000_000;

function harness(over: Partial<GoalDiskDeps> = {}): Harness {
  const invoked: Array<[string, Record<string, unknown>]> = [];
  const onDisk = new Set<string>();
  let projects: Project[] = [];
  let reads = 0;
  const deps: GoalDiskDeps = {
    // Models the REAL directory rather than answering `undefined` to everything: a write creates the
    // record, a delete removes it, and the listing reports what is actually there. Without that, the
    // cleanup rule would be tested against a disk that is permanently empty — it would never see an
    // orphan, and every delete assertion below would be vacuous.
    invoke: (cmd, args) => {
      invoked.push([cmd, args]);
      if (cmd === "write_agent_goal_record") onDisk.add(String(args.agentId));
      if (cmd === "delete_agent_goal_record") onDisk.delete(String(args.agentId));
      if (cmd === "list_agent_goal_records") return Promise.resolve([...onDisk].sort());
      return Promise.resolve(undefined);
    },
    ownsProject: () => true,
    projects: () => {
      reads += 1;
      return projects;
    },
    subscribe: () => () => {},
    now: () => NOW,
    ...over,
  };
  return {
    deps,
    invoked,
    onDisk,
    passes: () => reads,
    setProjects: (p) => {
      projects = p;
    },
  };
}

/** A goal carrying the fields the state-machine work is adding in parallel — cast because they do
 *  not exist on `AgentGoal` yet, which is the whole point of reading them defensively. */
function goalOf(over: Record<string, unknown> = {}): AgentGoal {
  return {
    text: FIXTURE.goal.text,
    setAt: FIXTURE.goal.setAt,
    ttlMs: FIXTURE.goal.ttlMs,
    continues: FIXTURE.goal.continues,
    totalContinues: FIXTURE.goal.totalContinues,
    rearms: FIXTURE.goal.rearms,
    verify: { kind: "landed" },
    ...over,
  } as unknown as AgentGoal;
}

function agentOf(over: Partial<AgentTab> = {}): AgentTab {
  return {
    id: FIXTURE.agentId,
    name: FIXTURE.agentName,
    worktreePath: FIXTURE.worktree,
    branch: FIXTURE.branch,
    goal: goalOf(),
    ...over,
  } as unknown as AgentTab;
}

function projectOf(agents: AgentTab[], id = "p1"): Project {
  return { id, name: "Demo", agents } as unknown as Project;
}

beforeEach(() => {
  _resetAgentGoalDiskForTests();
  invokeMock.mockClear();
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
});

afterEach(() => {
  _resetAgentGoalDiskForTests();
  vi.useRealTimers();
});

describe("buildAgentGoalRecord — the frozen contract", () => {
  // THE ANTI-DRIFT ASSERTION. The fixture's `updatedAt` is exactly `setAt + ttlMs`, so passing it as
  // `now` also makes the real `goalStateOf` answer `expired` — the state is DERIVED here rather than
  // copied out of the fixture, which is what makes this test able to catch a state-machine change.
  it("serializes to the canonical fixture, byte-for-byte in shape", () => {
    const record = buildAgentGoalRecord({
      agentId: FIXTURE.agentId,
      agentName: FIXTURE.agentName,
      worktree: FIXTURE.worktree,
      branch: FIXTURE.branch,
      goal: goalOf(),
      now: FIXTURE.updatedAt,
    });
    expect(record).toEqual(FIXTURE);
    // And the round trip through JSON, since that is what actually reaches disk — a value that
    // stringifies away (an `undefined`) survives `toEqual` and would not survive the write.
    expect(JSON.parse(JSON.stringify(record))).toEqual(FIXTURE);
  });

  // `toEqual` treats a MISSING key and an `undefined` one as equal, so the test above cannot see an
  // omitted optional. `Object.keys` can, and this is the property the whole reader contract rests
  // on: absence is `null`, and an ABSENT key means a malformed or older record instead.
  it("emits every optional field as `null` rather than omitting the key", () => {
    const bare = goalOf({ verify: undefined, escalationReason: undefined, rearms: undefined });
    const record = buildAgentGoalRecord({
      agentId: "a1",
      agentName: "A",
      worktree: null,
      branch: null,
      goal: bare,
      now: NOW,
    });

    expect(Object.keys(record).sort()).toEqual(
      ["agentId", "agentName", "branch", "goal", "schemaVersion", "updatedAt", "worktree"].sort(),
    );
    expect(Object.keys(record.goal).sort()).toEqual(Object.keys(FIXTURE.goal).sort());
    // Read off the SERIALIZED bytes: `JSON.stringify` drops an `undefined` value silently, so a key
    // that is present-but-undefined in memory is absent on disk and only this catches it.
    const onDisk = JSON.parse(JSON.stringify(record)) as AgentGoalRecord;
    expect(Object.keys(onDisk.goal).sort()).toEqual(Object.keys(FIXTURE.goal).sort());
    expect(onDisk.goal.verify).toBeNull();
    expect(onDisk.goal.escalationReason).toBeNull();
    expect(onDisk.worktree).toBeNull();
    expect(onDisk.branch).toBeNull();
    // A goal nobody re-armed has been re-armed zero times — and the field does not exist on
    // `AgentGoal` yet, so this is the defensive read compiling and behaving.
    expect(onDisk.goal.rearms).toBe(0);
  });

  it("writes the verification KIND alone, never the GoalVerify object", () => {
    const record = buildAgentGoalRecord({
      agentId: "a1",
      agentName: "A",
      worktree: null,
      branch: null,
      // A `command` check carries a `cmd`, which must NOT reach the brief a waking agent reads: a
      // stale command replayed as an instruction is the false-"done" hazard engine/agentGoal
      // documents at length.
      goal: goalOf({ verify: { kind: "command", cmd: "pnpm test parser" } }),
      now: NOW,
    });
    expect(record.goal.verify).toBe("command");
    expect(JSON.stringify(record)).not.toContain("pnpm test parser");
  });

  it("carries the state string through without switching over the union", () => {
    // `escalated` outranks `expired` in `goalStateOf`, so this is the real function's answer rather
    // than a value this module chose — the coupling that makes the record track the state machine.
    const record = buildAgentGoalRecord({
      agentId: "a1",
      agentName: "A",
      worktree: null,
      branch: null,
      goal: goalOf({ escalatedAt: NOW - 1, escalationReason: "auto-continue gave up" }),
      now: NOW,
    });
    expect(record.goal.state).toBe("escalated");
    expect(record.goal.escalationReason).toBe("auto-continue gave up");
  });
});

describe("syncAgentGoalRecords — the mirror", () => {
  it("INVOKES the write command with the serialized record when an agent has a goal", async () => {
    const h = harness();
    h.setProjects([projectOf([agentOf()])]);

    const outcomes = await syncAgentGoalRecords(h.deps);

    expect(outcomes).toEqual([{ agentId: FIXTURE.agentId, action: "wrote" }]);
    const writes = h.invoked.filter(([cmd]) => cmd === "write_agent_goal_record");
    expect(writes).toHaveLength(1);
    expect(writeArgs(writes, 0).agentId).toBe(FIXTURE.agentId);
    // The BYTES, not a spy call count: the record has to survive the wire as the reader's shape.
    expect(JSON.parse(String(writeArgs(writes, 0).json))).toEqual(FIXTURE);
  });

  it("does not rewrite an unchanged record, and DOES rewrite a changed one", async () => {
    const h = harness();
    h.setProjects([projectOf([agentOf()])]);
    await syncAgentGoalRecords(h.deps);
    const second = await syncAgentGoalRecords(h.deps);
    expect(second).toEqual([{ agentId: FIXTURE.agentId, action: "unchanged" }]);
    expect(h.invoked.filter(([cmd]) => cmd === "write_agent_goal_record")).toHaveLength(1);

    h.setProjects([projectOf([agentOf({ goal: goalOf({ text: "a different goal" }) })])]);
    const third = await syncAgentGoalRecords(h.deps);
    expect(third).toEqual([{ agentId: FIXTURE.agentId, action: "wrote" }]);
    const writes = h.invoked.filter(([cmd]) => cmd === "write_agent_goal_record");
    expect(writes).toHaveLength(2);
    expect(JSON.parse(String(writeArgs(writes, 1).json)).goal.text).toBe("a different goal");
  });

  it("DELETES the record when an owned agent's goal is cleared", async () => {
    const h = harness();
    h.setProjects([projectOf([agentOf()])]);
    await syncAgentGoalRecords(h.deps);

    h.setProjects([projectOf([agentOf({ goal: undefined })])]);
    const outcomes = await syncAgentGoalRecords(h.deps);

    expect(outcomes).toEqual([{ agentId: FIXTURE.agentId, action: "deleted" }]);
    expect(h.invoked.at(-1)).toEqual([
      "delete_agent_goal_record",
      { agentId: FIXTURE.agentId },
    ]);
  });

  it("DELETES the record when the agent is torn down entirely", async () => {
    const h = harness();
    h.setProjects([projectOf([agentOf()])]);
    await syncAgentGoalRecords(h.deps);

    h.setProjects([projectOf([])]);
    await syncAgentGoalRecords(h.deps);

    expect(h.invoked.at(-1)).toEqual([
      "delete_agent_goal_record",
      { agentId: FIXTURE.agentId },
    ]);
  });

  // THE MIRROR MUST NOT DELETE ITSELF. Ownership transfers between windows (a satellite is torn off,
  // main adopts an unowned project). A rule that deleted whatever this window no longer OWNS would
  // erase a record the other window had just written — on a project nobody changed.
  it("does NOT delete a record for an agent that merely moved out of this window's ownership", async () => {
    let owned = true;
    const h = harness({ ownsProject: () => owned });
    h.setProjects([projectOf([agentOf()])]);
    await syncAgentGoalRecords(h.deps);

    owned = false;
    const outcomes = await syncAgentGoalRecords(h.deps);

    expect(outcomes).toEqual([]);
    expect(h.invoked.filter(([cmd]) => cmd === "delete_agent_goal_record")).toHaveLength(0);
  });

  it("writes nothing for a project this window does not own", async () => {
    const h = harness({ ownsProject: () => false });
    h.setProjects([projectOf([agentOf()])]);
    expect(await syncAgentGoalRecords(h.deps)).toEqual([]);
    // The listing is a read and always happens; what must not happen is a WRITE or a DELETE.
    expect(h.invoked.map(([cmd]) => cmd)).toEqual(["list_agent_goal_records"]);
  });

  // ── CLEANUP RECONCILES AGAINST THE DIRECTORY, NOT AGAINST THIS WINDOW'S MEMORY ────────────────
  //
  // The two records below are the ones a `written`-keyed rule could never reach, because that map
  // only knows what THIS window wrote in THIS session. Both leave a stale file the hook still matches
  // by `worktree`/`$PWD`, briefing a waking agent with a goal that no longer exists.

  it("reclaims a record left by a PREVIOUS session, which this window never wrote", async () => {
    const h = harness();
    // On disk before we start, and in no project: an agent torn down while the app was closed. The
    // in-memory `written` map is empty at launch, so nothing else can ever see this file.
    h.onDisk.add("ghost-of-a-dead-session");
    h.setProjects([projectOf([agentOf()])]);

    const outcomes = await syncAgentGoalRecords(h.deps);

    expect(outcomes).toContainEqual({ agentId: "ghost-of-a-dead-session", action: "deleted" });
    expect(h.invoked).toContainEqual([
      "delete_agent_goal_record",
      { agentId: "ghost-of-a-dead-session" },
    ]);
    expect(h.onDisk.has("ghost-of-a-dead-session")).toBe(false);
  });

  it("reclaims a record orphaned by an OWNERSHIP HANDOFF between windows", async () => {
    // The sequence, with no race in it: a satellite wrote A's record and its memory died with the
    // webview; this window has since adopted the project; A's goal is then cleared. We own A and see
    // no goal, but we never wrote A — so a rule keyed on our own write history leaves the file
    // forever.
    const h = harness();
    h.onDisk.add(FIXTURE.agentId);
    h.setProjects([projectOf([agentOf({ goal: undefined })])]);

    const outcomes = await syncAgentGoalRecords(h.deps);

    expect(outcomes).toEqual([{ agentId: FIXTURE.agentId, action: "deleted" }]);
    expect(h.onDisk.has(FIXTURE.agentId)).toBe(false);
  });

  // ⚠️ AN EMPTY STORE IS NOT AN EMPTY FLEET. A relaunch races zustand's rehydration, so `projects` is
  // briefly `[]` — and a sweep landing there would read every record as an orphan and delete every
  // brief at exactly the relaunch this mechanism exists to serve.
  it("deletes NOTHING while the project store is empty, which may only mean it has not hydrated", async () => {
    const h = harness();
    h.onDisk.add("someone-elses-record");
    h.setProjects([]);

    expect(await syncAgentGoalRecords(h.deps)).toEqual([]);
    expect(h.invoked.filter(([cmd]) => cmd === "delete_agent_goal_record")).toHaveLength(0);
    expect(h.onDisk.has("someone-elses-record")).toBe(true);
  });

  // A failed listing means we cannot tell an orphan from a live record. Cleaning nothing is the safe
  // reading — and it must not cost us the writes that already landed in the same pass.
  it("keeps its writes and skips only the cleanup when the listing fails", async () => {
    const h = harness({
      invoke: (cmd, args) => {
        h.invoked.push([cmd, args]);
        if (cmd === "list_agent_goal_records") return Promise.reject(new Error("EIO"));
        return Promise.resolve(undefined);
      },
    });
    h.setProjects([projectOf([agentOf()])]);

    expect(await syncAgentGoalRecords(h.deps)).toEqual([
      { agentId: FIXTURE.agentId, action: "wrote" },
    ]);
    expect(h.invoked.filter(([cmd]) => cmd === "delete_agent_goal_record")).toHaveLength(0);
  });

  // NEVER THROWS, and the failure is not remembered as done: a rejected write must be retried on the
  // next pass rather than silently swallowed by the dedupe map.
  it("survives a rejected write and retries it on the next pass", async () => {
    let fail = true;
    const h = harness({
      invoke: (cmd, args) => {
        h.invoked.push([cmd, args]);
        return fail ? Promise.reject(new Error("disk full")) : Promise.resolve(undefined);
      },
    });
    h.setProjects([projectOf([agentOf()])]);

    const first = await syncAgentGoalRecords(h.deps);
    expect(first).toEqual([{ agentId: FIXTURE.agentId, action: "failed", detail: "Error: disk full" }]);

    fail = false;
    const second = await syncAgentGoalRecords(h.deps);
    expect(second).toEqual([{ agentId: FIXTURE.agentId, action: "wrote" }]);
  });
});

describe("startAgentGoalDiskMirror — the debounce", () => {
  it("collapses a burst of store changes into ONE trailing pass carrying the LAST value", async () => {
    vi.useFakeTimers();
    let onChange = (): void => {};
    const h = harness({ subscribe: (fn) => ((onChange = fn), () => {}) });
    h.setProjects([projectOf([agentOf({ goal: goalOf({ text: "goal 0" }) })])]);

    startAgentGoalDiskMirror(h.deps, GOAL_DISK_DEBOUNCE_MS);

    // Five changes inside one window, each a DIFFERENT goal — so an undebounced mirror would write
    // five distinct records rather than being collapsed by the unchanged-signature dedupe.
    for (let i = 1; i <= 5; i += 1) {
      h.setProjects([projectOf([agentOf({ goal: goalOf({ text: `goal ${i}` }) })])]);
      onChange();
      await vi.advanceTimersByTimeAsync(GOAL_DISK_DEBOUNCE_MS / 4);
    }
    expect(h.passes()).toBe(0);

    await vi.advanceTimersByTimeAsync(GOAL_DISK_DEBOUNCE_MS);

    expect(h.passes()).toBe(1);
    const writes = h.invoked.filter(([cmd]) => cmd === "write_agent_goal_record");
    expect(writes).toHaveLength(1);
    // TRAILING, not leading: the surviving write carries the last value, not the first.
    expect(JSON.parse(String(writeArgs(writes, 0).json)).goal.text).toBe("goal 5");
  });

  it("runs a first pass on mount, so a relaunch re-materializes records nothing has changed", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.setProjects([projectOf([agentOf()])]);

    startAgentGoalDiskMirror(h.deps, GOAL_DISK_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(GOAL_DISK_DEBOUNCE_MS);

    expect(h.invoked.map(([cmd]) => cmd)).toEqual([
      "write_agent_goal_record",
      "list_agent_goal_records",
    ]);
  });

  // ⚠️ `state` IS CLOCK-DERIVED, so the store never changes when a goal expires. A mirror driven only
  // by store mutations leaves `"unmet"` on disk indefinitely — and the quieter the agent, the staler
  // it gets, so the brief handed to an agent waking from a long stall is the one most likely to
  // assert a live goal that expired hours ago. Nothing else in this suite would notice: every other
  // test changes the store to provoke a write.
  it("re-sweeps on a timer, so a TTL expiry nobody touched the store for reaches disk", async () => {
    vi.useFakeTimers();
    const setAt = NOW;
    const ttlMs = 60_000;
    let clock = setAt;
    const h = harness({ now: () => clock });
    h.setProjects([projectOf([agentOf({ goal: goalOf({ setAt, ttlMs }) })])]);

    startAgentGoalDiskMirror(h.deps, GOAL_DISK_DEBOUNCE_MS, GOAL_DISK_SWEEP_MS);
    await vi.advanceTimersByTimeAsync(GOAL_DISK_DEBOUNCE_MS);

    let writes = h.invoked.filter(([cmd]) => cmd === "write_agent_goal_record");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writeArgs(writes, 0).json)).goal.state).toBe("unmet");

    // The ONLY thing that changes is the clock. The store is untouched, so nothing notifies.
    clock = setAt + ttlMs + 1;
    await vi.advanceTimersByTimeAsync(GOAL_DISK_SWEEP_MS + GOAL_DISK_DEBOUNCE_MS);

    writes = h.invoked.filter(([cmd]) => cmd === "write_agent_goal_record");
    expect(writes).toHaveLength(2);
    expect(JSON.parse(String(writeArgs(writes, 1).json)).goal.state).toBe("expired");
  });

  // Teardown DISARMS the interval rather than merely neutering it. The generation guard already
  // makes a stale tick a no-op, so "no further passes" is true either way and cannot see this — the
  // property that is actually at stake is the LEAK: an un-cleared interval keeps firing for the life
  // of the process, once a minute, for every mirror ever mounted. So the timer count is the
  // assertion, and it is the only one here that goes red if the `clearInterval` is dropped.
  it("stops the clock tick too, leaving no timer armed behind it", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.setProjects([projectOf([agentOf()])]);

    const stop = startAgentGoalDiskMirror(h.deps, GOAL_DISK_DEBOUNCE_MS, GOAL_DISK_SWEEP_MS);
    await vi.advanceTimersByTimeAsync(GOAL_DISK_DEBOUNCE_MS);
    expect(h.passes()).toBe(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    stop();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(GOAL_DISK_SWEEP_MS * 3);
    expect(h.passes()).toBe(1);
  });

  // ⚠️ THE TEARDOWN IS SCOPED TO ITS OWN MOUNT. Returning the bare module-global stop meant the FIRST
  // mount's cleanup tore down the SECOND, live mirror — and no goal reached disk for the rest of the
  // session, which is exactly what the generation counter exists to make impossible.
  it("a stale mount's teardown does NOT kill the mirror that replaced it", async () => {
    vi.useFakeTimers();
    let onChange = (): void => {};
    const h = harness({ subscribe: (fn) => ((onChange = fn), () => {}) });
    h.setProjects([projectOf([agentOf()])]);

    const stopFirst = startAgentGoalDiskMirror(h.deps, GOAL_DISK_DEBOUNCE_MS);
    startAgentGoalDiskMirror(h.deps, GOAL_DISK_DEBOUNCE_MS);
    stopFirst();

    onChange();
    await vi.advanceTimersByTimeAsync(GOAL_DISK_DEBOUNCE_MS);

    expect(h.invoked.filter(([cmd]) => cmd === "write_agent_goal_record")).toHaveLength(1);
  });

  // A teardown issued while a sweep's invoke is still outstanding — the realistic shape, where the
  // webview is going away and the IPC never answers — used to latch `syncing = true` with nothing
  // left to clear it. The next mount's first pass then took the `if (syncing)` branch and returned,
  // and the flag could only be discharged by the stale sweep's own closure, which the generation
  // guard has already made inert. The pass dropped that way is the one load-bearing for relaunch.
  it("a teardown during a sweep that never settles does not lock out the next mount", async () => {
    vi.useFakeTimers();
    const h = harness({
      invoke: (cmd, args) => {
        h.invoked.push([cmd, args]);
        // Never resolves, and is never released — the point is that nothing downstream of this can
        // be what clears the flag.
        return new Promise<undefined>(() => {});
      },
    });
    h.setProjects([projectOf([agentOf()])]);

    const stop = startAgentGoalDiskMirror(h.deps, GOAL_DISK_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(GOAL_DISK_DEBOUNCE_MS);
    expect(h.passes()).toBe(1);
    stop();

    startAgentGoalDiskMirror(h.deps, GOAL_DISK_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(GOAL_DISK_DEBOUNCE_MS);

    expect(h.passes()).toBe(2);
  });

  it("stops writing once torn down", async () => {
    vi.useFakeTimers();
    let onChange = (): void => {};
    const h = harness({ subscribe: (fn) => ((onChange = fn), () => {}) });
    h.setProjects([projectOf([agentOf()])]);

    const stop = startAgentGoalDiskMirror(h.deps, GOAL_DISK_DEBOUNCE_MS);
    stop();
    onChange();
    await vi.advanceTimersByTimeAsync(GOAL_DISK_DEBOUNCE_MS * 4);

    expect(h.passes()).toBe(0);
    expect(h.invoked).toEqual([]);
  });
});

// ── THE PRODUCTION PATH ─────────────────────────────────────────────────────────────────────────
//
// Every test above injects `deps`, which means `liveGoalDiskDeps()` — the real store read, the real
// subscription, the real ownership election, the real Tauri `invoke` — would be covered by NOTHING.
// That is the shape of sparkle-lgbwf (seen 4×): delete the defaulted seam and the suite stays green
// while the feature is dead. This drives `startAgentGoalDiskMirror()` with no arguments against the
// real `useProjectStore`, and asserts the command that reached the bridge.
describe("startAgentGoalDiskMirror() — no arguments, the real wiring", () => {
  it("mirrors a goal set on the REAL store through the REAL invoke", async () => {
    vi.useFakeTimers();
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const agentId = useProjectStore.getState().addAgent(projectId, { kind: "build" })!;
    useProjectStore.getState().setAgentGoal(projectId, agentId, "land the writer on my branch");

    startAgentGoalDiskMirror();
    await vi.advanceTimersByTimeAsync(GOAL_DISK_DEBOUNCE_MS * 2);

    const writes = invokeMock.mock.calls.filter(([cmd]) => cmd === "write_agent_goal_record");
    expect(writes).toHaveLength(1);
    // Read straight off the mock rather than through `writeArgs`: Tauri's own `invoke` signature
    // types its args as `InvokeArgs | undefined`, which is a different tuple shape.
    const call = writes[0];
    if (call === undefined) throw new Error("expected one write_agent_goal_record invoke");
    const args = call[1] as unknown as { agentId: string; json: string };
    expect(args.agentId).toBe(agentId);
    const record = JSON.parse(args.json) as AgentGoalRecord;
    expect(record.schemaVersion).toBe(1);
    expect(record.agentId).toBe(agentId);
    expect(record.goal.text).toBe("land the writer on my branch");
    expect(record.goal.state).toBe("unmet");
    // The always-present rule holds on the real path too, not only for hand-built goals.
    expect(Object.keys(record.goal).sort()).toEqual(Object.keys(FIXTURE.goal).sort());
  });
});
