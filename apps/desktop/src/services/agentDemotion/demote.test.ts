// The six invariants of the copy-then-cut demotion machine (plan W3), each asserted on a SIDE
// EFFECT rather than a precondition.
//
// The harness gives every dep a shared call log, so "was it called", "how many times" and "in what
// order relative to the others" are all observable in one place. That matters more here than a
// return-value assertion would: the safety argument of this module is an ORDER, and a machine that
// deleted the sandbox first would satisfy any "the happy path deletes it" assertion.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  demoteAgentToLocal,
  DEFAULT_FIRST_FRAME_TIMEOUT_MS,
  type DemoteDeps,
  type DemoteInput,
  type DemotionStep,
} from "./demote";
import { CLOUD_WIP_COMMIT_MESSAGE } from "./plan";
import type { DemotionLanding } from "./rust";
import type { SessionHandoff } from "../cloudAgents/api";

const TAB_ID = "tab-1";
const PUSHED_SHA = "1111111111111111111111111111111111111111";
/** What the sandbox's HEAD was BEFORE the handoff's own WIP commit moved it. Never a valid
 *  baseline — a machine that used it would refuse every ordinary demotion. */
const PRE_HANDOFF_SHA = "0000000000000000000000000000000000000000";
const LATE_SHA = "9999999999999999999999999999999999999999";

function handoff(over: Partial<SessionHandoff> = {}): SessionHandoff {
  return {
    branch: "sparkle/agent-42",
    pushedSha: PUSHED_SHA,
    transcript: { sessionId: "claude-sess-9", jsonl: '{"a":1}', truncated: false, bytes: 7 },
    transcriptError: null,
    ...over,
  };
}

const LANDING: DemotionLanding = {
  worktree: "/Users/x/wt/agent-42",
  headSha: PUSHED_SHA,
  created: false,
};

/** What each dep DOES on this run. Every dep records itself in the call log regardless, so ordering
 *  and non-invocation are observable in exactly one place. Throw from any of these to drive a
 *  failure branch. */
interface Behavior {
  sessionHandoff?: () => SessionHandoff;
  landBranch?: () => DemotionLanding;
  writeTranscript?: () => number;
  spawnLocalAgent?: () => void;
  awaitLocalFirstFrame?: () => void;
  killLocalAgent?: () => void;
  /** A QUEUE, so a machine that read the sandbox head more than once gets a DIFFERENT answer the
   *  second time — which is how "it reads it exactly once, at cutover" is provable rather than
   *  merely asserted. */
  sandboxHeads?: string[];
  deleteSession?: () => void;
  setRuntimeLocal?: () => void;
  sendBriefing?: () => void;
}

function harness(b: Behavior = {}) {
  const log: string[] = [];
  const landed: Array<{ branch: string; expectedSha: string; existingWorktree: string | null }> = [];
  const written: Array<{ worktree: string; sessionId: string; jsonl: string }> = [];
  const spawned: Array<{ agentId: string; worktree: string; branch: string }> = [];
  const awaited: Array<{ agentId: string; timeoutMs: number }> = [];
  const deleted: string[] = [];
  const killed: string[] = [];
  const flips: Array<{ projectId: string; agentId: string }> = [];
  const briefings: Array<{ agentId: string; text: string }> = [];
  const steps: DemotionStep[] = [];
  const heads = [...(b.sandboxHeads ?? [PUSHED_SHA])];

  const deps: DemoteDeps = {
    async sessionHandoff() {
      log.push("sessionHandoff");
      return (b.sessionHandoff ?? handoff)();
    },
    async landBranch(a) {
      log.push("landBranch");
      landed.push({
        branch: a.branch,
        expectedSha: a.expectedSha,
        existingWorktree: a.existingWorktree,
      });
      return (b.landBranch ?? (() => LANDING))();
    },
    async writeTranscript(a) {
      log.push("writeTranscript");
      written.push(a);
      return (b.writeTranscript ?? (() => 1))();
    },
    async spawnLocalAgent(a) {
      log.push("spawnLocalAgent");
      spawned.push(a);
      b.spawnLocalAgent?.();
    },
    // Two log entries, not one. `attach` is when the listeners go on and `resolved` is when the
    // frame actually arrived, and they are DIFFERENT facts: the machine must subscribe before the
    // spawn (or it races the agent's first bytes) and must not cut until the frame lands. A fake
    // that recorded only its invocation would make an async body look like it settled at call time
    // and would let a cut-before-live machine pass.
    awaitLocalFirstFrame(a) {
      log.push("awaitLocalFirstFrame:attach");
      awaited.push(a);
      // Settle on a LATER microtask so "resolved" genuinely orders after anything the machine does
      // between the attach and the await.
      return Promise.resolve()
        .then(() => Promise.resolve())
        .then(() => {
          b.awaitLocalFirstFrame?.();
          log.push("awaitLocalFirstFrame:resolved");
        });
    },
    async killLocalAgent(id) {
      log.push("killLocalAgent");
      killed.push(id);
      b.killLocalAgent?.();
    },
    async sandboxHead() {
      log.push("sandboxHead");
      // Shift, don't peek: a second read gets the NEXT scripted value.
      const next = heads.shift();
      if (next === undefined) throw new Error("sandboxHead called more times than the test scripted");
      if (next === "THROW") throw new Error("sandbox unreachable");
      return next;
    },
    async deleteSession(id) {
      log.push("deleteSession");
      deleted.push(id);
      b.deleteSession?.();
    },
    setRuntimeLocal(a) {
      log.push("setRuntimeLocal");
      flips.push(a);
      b.setRuntimeLocal?.();
    },
    sendBriefing(a) {
      log.push("sendBriefing");
      briefings.push(a);
      b.sendBriefing?.();
    },
    onStep(s) {
      steps.push(s);
    },
  };

  return { deps, log, landed, written, spawned, awaited, deleted, killed, flips, briefings, steps };
}

function input(over: Partial<DemoteInput> = {}): DemoteInput {
  return {
    agentId: TAB_ID,
    projectId: "proj-1",
    root: "/Users/x/repo",
    agentName: "Widget Builder",
    goal: "ship the widget",
    ...over,
  };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

/** Index of a call in the log, or -1. */
const at = (log: string[], name: string) => log.indexOf(name);

describe("demoteAgentToLocal — the happy path", () => {
  it("lands, writes the transcript, spawns, waits, guards, cuts, then flips — in that order", async () => {
    const h = harness();
    const res = await demoteAgentToLocal(input(), h.deps);

    expect(res).toEqual({
      ok: true,
      worktree: "/Users/x/wt/agent-42",
      transcriptMoved: true,
      createdWorktree: false,
      transcriptTruncated: false,
    });
    expect(h.log).toEqual([
      "sessionHandoff",
      "landBranch",
      "writeTranscript",
      // The listeners go on BEFORE the spawn — see the dep's contract.
      "awaitLocalFirstFrame:attach",
      "spawnLocalAgent",
      "awaitLocalFirstFrame:resolved",
      "sandboxHead",
      "deleteSession",
      "setRuntimeLocal",
    ]);
    expect(h.steps).toEqual([
      "preflight",
      "handoff",
      "land",
      "transcript",
      "spawn",
      "await_live",
      "cutover",
    ]);
  });

  it("lands the branch the HANDOFF named, at the sha it pushed — not the caller's guesses", async () => {
    const h = harness({ sessionHandoff: () => handoff({ branch: "sparkle/other", pushedSha: "abc123" }) });
    await demoteAgentToLocal(input({ existingWorktree: "/Users/x/wt/old" }), h.deps);
    expect(h.landed).toEqual([
      { branch: "sparkle/other", expectedSha: "abc123", existingWorktree: "/Users/x/wt/old" },
    ]);
  });

  it("spawns the local agent in the worktree the LANDING reported", async () => {
    const h = harness({ landBranch: () => ({ ...LANDING, worktree: "/fresh/wt", created: true }) });
    const res = await demoteAgentToLocal(input(), h.deps);
    expect(h.spawned).toEqual([
      { agentId: TAB_ID, worktree: "/fresh/wt", branch: "sparkle/agent-42" },
    ]);
    expect(res).toMatchObject({ ok: true, createdWorktree: true, worktree: "/fresh/wt" });
  });

  it("writes the transcript under the CLAUDE session id, into the landed worktree", async () => {
    const h = harness();
    await demoteAgentToLocal(input(), h.deps);
    expect(h.written).toEqual([
      { worktree: "/Users/x/wt/agent-42", sessionId: "claude-sess-9", jsonl: '{"a":1}' },
    ]);
  });

  it("uses the default first-frame deadline, and honours an override", async () => {
    const a = harness();
    await demoteAgentToLocal(input(), a.deps);
    expect(a.awaited[0]!.timeoutMs).toBe(DEFAULT_FIRST_FRAME_TIMEOUT_MS);

    const b = harness();
    await demoteAgentToLocal(input({ awaitFirstFrameMs: 5_000 }), b.deps);
    expect(b.awaited[0]!.timeoutMs).toBe(5_000);
  });

  it("deletes the SERVER session id when it differs from the tab id, but flips the TAB", async () => {
    const h = harness();
    await demoteAgentToLocal(input({ sessionId: "sess-server" }), h.deps);
    expect(h.deleted).toEqual(["sess-server"]);
    expect(h.flips).toEqual([{ projectId: "proj-1", agentId: TAB_ID }]);
  });
});

// ── Invariant 1: the cut happens only after the local agent is proven live ─────────────────────
describe("deleteSession is called ONLY after awaitLocalFirstFrame resolves", () => {
  it("orders the delete strictly after the first frame RESOLVES", async () => {
    const h = harness();
    await demoteAgentToLocal(input(), h.deps);
    expect(at(h.log, "deleteSession")).toBeGreaterThan(at(h.log, "awaitLocalFirstFrame:resolved"));
    expect(at(h.log, "awaitLocalFirstFrame:resolved")).toBeGreaterThan(at(h.log, "spawnLocalAgent"));
  });

  it("attaches the first-frame listener BEFORE the spawn, so the first bytes can't be missed", async () => {
    // The local transport registers its listeners asynchronously, so a subscribe-after-spawn races
    // the agent's opening frame — and an agent that banners then idles emits nothing else. Both
    // orders produce an identical RESULT here, which is why this asserts the attach's position.
    const h = harness();
    await demoteAgentToLocal(input(), h.deps);
    expect(at(h.log, "awaitLocalFirstFrame:attach")).toBeLessThan(at(h.log, "spawnLocalAgent"));
    expect(at(h.log, "awaitLocalFirstFrame:attach")).toBeGreaterThan(at(h.log, "landBranch"));
  });

  // Every failure BEFORE the first frame resolves. Each must leave the sandbox untouched — which is
  // the whole safety argument, and is exactly what a "delete early, clean up later" machine breaks.
  const preLiveFailures: Array<[string, Behavior, DemotionStep]> = [
    ["the handoff fails", { sessionHandoff: () => { throw new Error("push_failed"); } }, "handoff"],
    ["the landing is refused", { landBranch: () => { throw new Error("diverged"); } }, "land"],
    ["the local spawn fails", { spawnLocalAgent: () => { throw new Error("no claude"); } }, "spawn"],
    ["the first frame times out", { awaitLocalFirstFrame: () => { throw new Error("deadline"); } }, "await_live"],
  ];
  for (const [name, behavior, step] of preLiveFailures) {
    it(`does not delete the session when ${name}`, async () => {
      const h = harness(behavior);
      const res = await demoteAgentToLocal(input(), h.deps);
      expect(res).toMatchObject({ ok: false, step });
      expect(h.deleted).toEqual([]);
      expect(h.log).not.toContain("deleteSession");
      expect(h.flips).toEqual([]);
      expect(res.ok === false && res.message).toContain("still running in the cloud");
    });
  }

  it("does not delete the session when the cut guard refuses", async () => {
    const h = harness({ sandboxHeads: [LATE_SHA] });
    const res = await demoteAgentToLocal(input(), h.deps);
    expect(res).toMatchObject({ ok: false, step: "cutover" });
    expect(h.deleted).toEqual([]);
    expect(h.flips).toEqual([]);
  });

  it("does not delete the session when the sandbox head can't be read", async () => {
    const h = harness({ sandboxHeads: ["THROW"] });
    const res = await demoteAgentToLocal(input(), h.deps);
    expect(res).toMatchObject({ ok: false, step: "cutover" });
    expect(h.deleted).toEqual([]);
  });
});

// ── Invariant 2: the cut guard's baseline is the PUSHED sha ────────────────────────────────────
describe("the cut guard compares the sandbox's live head to the handoff's pushedSha", () => {
  it("STILL CUTS when the handoff's own WIP commit moved the sandbox HEAD", async () => {
    // The sandbox's head before the handoff was PRE_HANDOFF_SHA; the handoff committed and pushed,
    // so the live head is now PUSHED_SHA. A machine that had captured a head EARLIER and compared
    // against that would see a difference here and refuse every ordinary demotion.
    const h = harness({
      sandboxHeads: [PUSHED_SHA, PRE_HANDOFF_SHA],
      sessionHandoff: () => handoff({ pushedSha: PUSHED_SHA }),
    });
    const res = await demoteAgentToLocal(input(), h.deps);
    expect(res).toMatchObject({ ok: true });
    expect(h.deleted).toEqual([TAB_ID]);
    // Exactly ONE read, and it is at cutover. A machine that also read the head early would have
    // consumed the second scripted value — the count is what makes "no earlier read" provable.
    expect(h.log.filter((c) => c === "sandboxHead")).toHaveLength(1);
    // `at` returns -1 for an absent entry, so name the entry that must EXIST — comparing against a
    // label the log never carries would pass against anything greater than -1.
    expect(at(h.log, "awaitLocalFirstFrame:resolved")).toBeGreaterThan(-1);
    expect(at(h.log, "sandboxHead")).toBeGreaterThan(at(h.log, "awaitLocalFirstFrame:resolved"));
  });

  it("does NOT cut when a commit lands AFTER the push", async () => {
    const h = harness({ sandboxHeads: [LATE_SHA] });
    const res = await demoteAgentToLocal(input(), h.deps);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ step: "cutover" });
    expect(h.deleted).toEqual([]);
    // The message must say the new commit is SAFE and to demote again — a user told only "it
    // failed" would reasonably assume the commit was lost with the refusal.
    const msg = res.ok === false ? res.message : "";
    expect(msg).toMatch(/safe in the sandbox/i);
    expect(msg).toMatch(/demote again/i);
  });
});

// ── Invariant 3: exactly one local PTY at the end ──────────────────────────────────────────────
describe("exactly one local agent exists at the end", () => {
  it("spawns exactly once and never stands it down on success", async () => {
    const h = harness();
    await demoteAgentToLocal(input(), h.deps);
    expect(h.log.filter((c) => c === "spawnLocalAgent")).toHaveLength(1);
    expect(h.killed).toEqual([]);
  });

  // Once the local agent is up, two Claudes are live on ONE branch. Every failure from there on has
  // to end that state, or a refusal leaves the user worse off than before they clicked.
  const postSpawnFailures: Array<[string, Behavior, DemotionStep]> = [
    ["the first frame never arrives", { awaitLocalFirstFrame: () => { throw new Error("deadline"); } }, "await_live"],
    ["the sandbox head can't be read", { sandboxHeads: ["THROW"] }, "cutover"],
    ["the sandbox moved", { sandboxHeads: [LATE_SHA] }, "cutover"],
    ["the delete fails", { deleteSession: () => { throw new Error("502"); } }, "cutover"],
  ];
  for (const [name, behavior, step] of postSpawnFailures) {
    it(`stands the local agent back down when ${name}`, async () => {
      const h = harness(behavior);
      const res = await demoteAgentToLocal(input(), h.deps);
      expect(res).toMatchObject({ ok: false, step });
      expect(h.killed).toEqual([TAB_ID]);
      expect(h.log.filter((c) => c === "killLocalAgent")).toHaveLength(1);
    });
  }

  const preSpawnFailures: Array<[string, Behavior]> = [
    ["the handoff fails", { sessionHandoff: () => { throw new Error("push_failed"); } }],
    ["the landing is refused", { landBranch: () => { throw new Error("no-remote"); } }],
    ["the spawn itself fails", { spawnLocalAgent: () => { throw new Error("no claude"); } }],
  ];
  for (const [name, behavior] of preSpawnFailures) {
    it(`does not try to kill a local agent that never came up when ${name}`, async () => {
      const h = harness(behavior);
      await demoteAgentToLocal(input(), h.deps);
      expect(h.killed).toEqual([]);
    });
  }

  it("reports the failure even when standing the local agent down also fails", async () => {
    const h = harness({
      sandboxHeads: [LATE_SHA],
      killLocalAgent: () => {
        throw new Error("pty gone");
      },
    });
    const res = await demoteAgentToLocal(input(), h.deps);
    // The user's problem is the cutover refusal, not the cleanup — the kill failure is logged only.
    expect(res).toMatchObject({ ok: false, step: "cutover" });
    expect(res.ok === false && res.message).not.toContain("pty gone");
    expect(warn).toHaveBeenCalled();
  });

  it("refuses at preflight with no root, before anything writes", async () => {
    const h = harness();
    const res = await demoteAgentToLocal(input({ root: "" }), h.deps);
    expect(res).toMatchObject({ ok: false, step: "preflight" });
    expect(h.log).toEqual([]);
  });
});

// ── Invariant 4: a dirty/diverged refusal names files ──────────────────────────────────────────
describe("a land refusal surfaces its file list, not a flattened git error", () => {
  it("names every dirty file", async () => {
    const h = harness({
      landBranch: () => {
        throw new Error("dirty:src/a.ts,src/b.ts,docs/c.md");
      },
    });
    const res = await demoteAgentToLocal(input(), h.deps);
    expect(res).toMatchObject({ ok: false, step: "land" });
    const msg = res.ok === false ? res.message : "";
    expect(msg).toContain("src/a.ts");
    expect(msg).toContain("src/b.ts");
    expect(msg).toContain("docs/c.md");
    // The stable prefix is machine grammar, never user copy.
    expect(msg).not.toContain("dirty:");
    expect(msg).toContain("still running in the cloud");
  });

  it("explains a divergence in terms of local commits, and carries a file list when one is given", async () => {
    const bare = harness({ landBranch: () => { throw new Error("diverged"); } });
    const bareRes = await demoteAgentToLocal(input(), bare.deps);
    const bareMsg = bareRes.ok === false ? bareRes.message : "";
    expect(bareMsg).toMatch(/aren't on origin\/sparkle\/agent-42/);
    expect(bareMsg).not.toContain("diverged");

    const listed = harness({ landBranch: () => { throw new Error("diverged:src/z.ts"); } });
    const listedRes = await demoteAgentToLocal(input(), listed.deps);
    expect(listedRes.ok === false && listedRes.message).toContain("src/z.ts");
  });

  it("does not dress an unrecognized git error up as a dirty or diverged refusal", async () => {
    const h = harness({
      landBranch: () => {
        throw new Error("fatal: the remote end hung up (it had diverged earlier)");
      },
    });
    const res = await demoteAgentToLocal(input(), h.deps);
    const msg = res.ok === false ? res.message : "";
    expect(msg).toContain("hung up");
    expect(msg).not.toMatch(/uncommitted changes/i);
    expect(msg).not.toMatch(/aren't on origin/i);
  });
});

// ── Invariant 5: the transcript is never fatal ─────────────────────────────────────────────────
describe("a transcript that does not travel is not fatal", () => {
  it("continues and briefs the local agent when the WRITE fails", async () => {
    const h = harness({
      writeTranscript: () => {
        throw new Error("disk full");
      },
    });
    const res = await demoteAgentToLocal(input(), h.deps);
    expect(res).toMatchObject({ ok: true, transcriptMoved: false });
    expect(h.deleted).toEqual([TAB_ID]);
    expect(h.briefings).toHaveLength(1);
    expect(h.briefings[0]!.text).toContain("sparkle/agent-42");
    expect(h.briefings[0]!.text).toContain("ship the widget");
  });

  it("continues and briefs when the SERVER could not read it", async () => {
    const h = harness({
      sessionHandoff: () => handoff({ transcript: null, transcriptError: "no jsonl found" }),
    });
    const res = await demoteAgentToLocal(input(), h.deps);
    expect(res).toMatchObject({ ok: true, transcriptMoved: false });
    expect(h.written).toEqual([]);
    expect(h.briefings).toHaveLength(1);
  });

  it("sends NO briefing when the conversation did travel — a resumed agent needs no prompt", async () => {
    const h = harness();
    const res = await demoteAgentToLocal(input(), h.deps);
    expect(res).toMatchObject({ ok: true, transcriptMoved: true });
    expect(h.briefings).toEqual([]);
    expect(h.log).not.toContain("sendBriefing");
  });

  it("sends the briefing only AFTER the cut and the flip", async () => {
    const h = harness({ sessionHandoff: () => handoff({ transcript: null, transcriptError: "x" }) });
    await demoteAgentToLocal(input(), h.deps);
    expect(at(h.log, "sendBriefing")).toBeGreaterThan(at(h.log, "deleteSession"));
    expect(at(h.log, "sendBriefing")).toBeGreaterThan(at(h.log, "setRuntimeLocal"));
  });

  it("a briefing that throws does not turn a completed demotion into a failure", async () => {
    const h = harness({
      sessionHandoff: () => handoff({ transcript: null, transcriptError: "x" }),
      sendBriefing: () => {
        throw new Error("pty write failed");
      },
    });
    const res = await demoteAgentToLocal(input(), h.deps);
    expect(res).toMatchObject({ ok: true, transcriptMoved: false });
  });

  it("reports truncation so the UI can say the oldest turns were dropped", async () => {
    const h = harness({
      sessionHandoff: () =>
        handoff({ transcript: { sessionId: "s", jsonl: "{}", truncated: true, bytes: 2 } }),
    });
    const res = await demoteAgentToLocal(input(), h.deps);
    expect(res).toMatchObject({ ok: true, transcriptMoved: true, transcriptTruncated: true });
  });
});

// ── Invariant 6: the flip runs once, after the delete succeeds ─────────────────────────────────
describe("setRuntimeLocal runs exactly once, after the delete succeeds", () => {
  it("flips once, and only after the delete", async () => {
    const h = harness();
    await demoteAgentToLocal(input(), h.deps);
    expect(h.flips).toEqual([{ projectId: "proj-1", agentId: TAB_ID }]);
    expect(at(h.log, "setRuntimeLocal")).toBeGreaterThan(at(h.log, "deleteSession"));
  });

  it("does NOT flip when the delete fails, and reports the orphaned session", async () => {
    const h = harness({
      deleteSession: () => {
        throw new Error("502 bad gateway");
      },
    });
    const res = await demoteAgentToLocal(input(), h.deps);
    expect(res).toMatchObject({
      ok: false,
      step: "cutover",
      orphanedSessionId: TAB_ID,
    });
    expect(h.flips).toEqual([]);
    // A billing sandbox with no tab is a cost, so the message must name the session AND say it is
    // still billing — "it failed" would leave the user paying for it indefinitely.
    const msg = res.ok === false ? res.message : "";
    expect(msg).toContain(TAB_ID);
    expect(msg).toMatch(/still billing/i);
    // …and it must NOT claim the cloud agent is fine: it is running, unattached, costing money.
    expect(msg).not.toContain("still running in the cloud");
  });

  it("reports a completed demotion the UI must reconcile when the flip itself throws", async () => {
    const h = harness({
      setRuntimeLocal: () => {
        throw new Error("tab gone");
      },
    });
    const res = await demoteAgentToLocal(input(), h.deps);
    expect(res).toMatchObject({ ok: true, runtimeFlipFailed: true });
    expect(h.deleted).toEqual([TAB_ID]);
  });

  it("a throwing step observer cannot abort a demotion", async () => {
    const h = harness();
    const deps: DemoteDeps = {
      ...h.deps,
      onStep() {
        throw new Error("observer blew up");
      },
    };
    const res = await demoteAgentToLocal(input(), deps);
    expect(res).toMatchObject({ ok: true });
  });
});

describe("the WIP message the dialog promises is the one the runner uses", () => {
  it("is the pinned cloud demotion message", () => {
    // Pinned against plan W1.2's WIP_COMMIT_MESSAGE_CLOUD. The two live in different packages with
    // no shared module, so this string IS the coupling.
    expect(CLOUD_WIP_COMMIT_MESSAGE).toBe("Sparkle: WIP before local demotion");
  });
});
