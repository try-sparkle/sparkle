import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promoteAgentToCloud, type PromoteDeps, type PromoteInput,
  type PromotionStep,
} from "./promote";
import { WIP_COMMIT_MESSAGE } from "./plan";
import { normalizePreflight } from "./rust";
import type { PromotionPreflight, PromotionTranscript, PushOutcome } from "./rust";
import type { StartSessionInput } from "../cloudAgents/api";

const TAB_ID = "tab-1";

function preflight(over: Partial<PromotionPreflight> = {}): PromotionPreflight {
  return {
    branch: "sparkle/agent-42",
    branchExists: true,
    hasRemote: true,
    originUrl: "https://github.com/acme/widgets.git",
    headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    detached: false,
    dirtyFiles: ["src/a.ts", "src/b.ts"],
    dirtyCount: 2,
    unpushed: 1,
    ...over,
  };
}

const TRANSCRIPT: PromotionTranscript = {
  sessionId: "claude-sess-9",
  jsonl: '{"a":1}',
  truncated: false,
  bytes: 7,
  records: 1,
};

/** What each dep DOES on this run. Every dep still records itself in the call log regardless, so
 *  ordering and non-invocation are observable in exactly one place. Throw from any of these to
 *  drive a failure branch. */
interface Behavior {
  /** The FIRST read, before anything is written. */
  preflight?: () => PromotionPreflight;
  /** The SECOND read, immediately before the cut. Defaults to a pushed, clean tree — which is what
   *  a local agent that sat still through the copy window actually looks like. */
  postPreflight?: () => PromotionPreflight;
  commitDirty?: () => number;
  pushBranch?: () => PushOutcome;
  readTranscript?: () => PromotionTranscript | null;
  startSession?: () => { sessionId: string };
  awaitFirstFrame?: () => void;
  deleteSession?: () => void;
  killLocalPty?: () => void;
  sendHandoff?: () => void;
}

function harness(b: Behavior = {}) {
  const log: string[] = [];
  const started: StartSessionInput[] = [];
  const commits: Array<{ worktree: string; message: string }> = [];
  const pushes: Array<{ root: string; branch: string }> = [];
  const deleted: string[] = [];
  const handoffs: Array<{ sessionId: string; text: string }> = [];
  const flips: Array<{ projectId: string; agentId: string }> = [];
  const kills: string[] = [];

  let preflightCalls = 0;
  /** A tree that has been committed + pushed and left alone since: the shape the pre-cut re-read
   *  sees when the local agent did NOT keep working. Reports the branch that was ACTUALLY pushed,
   *  so the default post-read never manufactures a spurious branch-switch. */
  const settled = () =>
    preflight({
      branch: pushes[0]?.branch ?? "sparkle/agent-42",
      dirtyFiles: [],
      dirtyCount: 0,
      unpushed: 0,
    });

  const deps: PromoteDeps = {
    preflight: async () => {
      preflightCalls += 1;
      if (preflightCalls === 1) {
        log.push("preflight");
        return (b.preflight ?? (() => preflight()))();
      }
      log.push("recheck");
      return (b.postPreflight ?? settled)();
    },
    commitDirty: async (a) => {
      log.push("commitDirty");
      commits.push(a);
      return (b.commitDirty ?? (() => 2))();
    },
    pushBranch: async (a) => {
      log.push("pushBranch");
      pushes.push(a);
      return (b.pushBranch ?? (() => "pushed"))();
    },
    readTranscript: async () => {
      log.push("readTranscript");
      return (b.readTranscript ?? (() => TRANSCRIPT))();
    },
    startSession: async (i) => {
      log.push("startSession");
      started.push(i);
      return (b.startSession ?? (() => ({ sessionId: TAB_ID })))();
    },
    awaitFirstFrame: async () => {
      log.push("awaitFirstFrame");
      (b.awaitFirstFrame ?? (() => {}))();
    },
    deleteSession: async (id) => {
      log.push("deleteSession");
      deleted.push(id);
      (b.deleteSession ?? (() => {}))();
    },
    killLocalPty: async (id) => {
      log.push("killLocalPty");
      kills.push(id);
      (b.killLocalPty ?? (() => {}))();
    },
    setRuntimeCloud: (a) => {
      log.push("setRuntimeCloud");
      flips.push(a);
    },
    sendHandoff: (a) => {
      log.push("sendHandoff");
      handoffs.push(a);
      (b.sendHandoff ?? (() => {}))();
    },
  };
  return { deps, log, started, commits, pushes, deleted, handoffs, flips, kills };
}

function input(over: Partial<PromoteInput> = {}): PromoteInput {
  return {
    agentId: TAB_ID,
    projectId: "proj-local",
    cloudProjectId: "proj-cloud",
    root: "/repo",
    worktree: "/repo/.wt/a1",
    branch: "sparkle/agent-42",
    baseBranch: "main",
    repoUrl: "https://github.com/acme/repo",
    agentName: "Retry Hardening",
    goal: "land the retry PR",
    dirtyPolicy: "commit",
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

describe("promoteAgentToCloud — the happy path, in order", () => {
  it("runs every step in the pinned order and reports what moved", async () => {
    const h = harness();
    const r = await promoteAgentToCloud(input(), h.deps);
    expect(r).toEqual({
      ok: true,
      sessionId: TAB_ID,
      transcriptMoved: true,
      transcriptTruncated: false,
      committed: 2,
    });
    expect(h.log).toEqual([
      "preflight",
      "commitDirty",
      "pushBranch",
      "readTranscript",
      "startSession",
      "awaitFirstFrame",
      "recheck",
      "killLocalPty",
      "setRuntimeCloud",
      "sendHandoff",
    ]);
  });

  it("kills the local PTY strictly AFTER the first frame arrives, never before", async () => {
    // The whole safety argument: copy, THEN cut. Asserting only "the kill happened" would pass
    // against a machine that cut first, which is the exact bug this test exists to catch.
    const h = harness();
    await promoteAgentToCloud(input(), h.deps);
    expect(h.log.indexOf("killLocalPty")).toBeGreaterThan(h.log.indexOf("awaitFirstFrame"));
    expect(h.log.indexOf("killLocalPty")).toBeGreaterThan(h.log.indexOf("startSession"));
  });

  it("flips the runtime exactly once, and only after the kill", async () => {
    const h = harness();
    await promoteAgentToCloud(input(), h.deps);
    expect(h.flips).toEqual([{ projectId: "proj-local", agentId: TAB_ID }]);
    expect(h.log.filter((s) => s === "setRuntimeCloud")).toHaveLength(1);
    expect(h.log.indexOf("setRuntimeCloud")).toBeGreaterThan(h.log.indexOf("killLocalPty"));
  });

  it("sends the handoff nudge LAST, after the flip", async () => {
    const h = harness();
    await promoteAgentToCloud(input(), h.deps);
    expect(h.log.indexOf("sendHandoff")).toBeGreaterThan(h.log.indexOf("setRuntimeCloud"));
    expect(h.handoffs[0]!.sessionId).toBe(TAB_ID);
    expect(h.handoffs[0]!.text).toMatch(/conversation came with you/i);
    expect(h.handoffs[0]!.text).toContain("land the retry PR");
  });

  it("commits in the WORKTREE with the WIP message, before the push", async () => {
    const h = harness();
    await promoteAgentToCloud(input(), h.deps);
    expect(h.commits).toEqual([{ worktree: "/repo/.wt/a1", message: WIP_COMMIT_MESSAGE }]);
    expect(h.log.indexOf("commitDirty")).toBeLessThan(h.log.indexOf("pushBranch"));
  });

  it("pushes from the repo ROOT, on the freshly resolved branch", async () => {
    const h = harness({ preflight: () => preflight({ branch: "renamed/branch" }) });
    await promoteAgentToCloud(input({ branch: "stale/branch" }), h.deps);
    // The dialog's branch can be stale (a rename between opening it and confirming); the sandbox
    // has to check out what the worktree is ACTUALLY on.
    expect(h.pushes).toEqual([{ root: "/repo", branch: "renamed/branch" }]);
    expect(h.started[0]!.promotion!.branch).toBe("renamed/branch");
  });

  it("adopts the agent's OWN id as the server session id and threads the transcript", async () => {
    const h = harness();
    await promoteAgentToCloud(input(), h.deps);
    expect(h.started[0]!.promotion).toEqual({
      sessionId: TAB_ID,
      branch: "sparkle/agent-42",
      transcript: { sessionId: "claude-sess-9", jsonl: '{"a":1}' },
    });
    expect(h.started[0]!.projectId).toBe("proj-cloud");
  });
});

describe("promoteAgentToCloud — the dirty policy", () => {
  it('skips the commit entirely when the user chose "leave"', async () => {
    const h = harness();
    const r = await promoteAgentToCloud(input({ dirtyPolicy: "leave" }), h.deps);
    expect(h.log).not.toContain("commitDirty");
    expect(r.ok && r.committed).toBe(0);
  });

  it("skips the commit on a clean tree even when the policy is commit", async () => {
    const h = harness({ preflight: () => preflight({ dirtyCount: 0, dirtyFiles: [] }) });
    const r = await promoteAgentToCloud(input(), h.deps);
    expect(h.log).not.toContain("commitDirty");
    expect(r.ok && r.committed).toBe(0);
  });

  it("reports the number of files actually committed", async () => {
    const h = harness({ commitDirty: () => 7 });
    const r = await promoteAgentToCloud(input(), h.deps);
    expect(r.ok && r.committed).toBe(7);
  });
});

describe("promoteAgentToCloud — the transcript is never fatal", () => {
  it("proceeds without a conversation when there is none, and says so in the nudge", async () => {
    const h = harness({ readTranscript: () => null });
    const r = await promoteAgentToCloud(input(), h.deps);
    expect(r).toMatchObject({ ok: true, transcriptMoved: false });
    expect(h.started[0]!.promotion!.transcript).toBeUndefined();
    expect(h.handoffs[0]!.text).toMatch(/did NOT come with you/);
    expect(h.handoffs[0]!.text).not.toMatch(/conversation came with you/i);
  });

  it("proceeds when the transcript read THROWS", async () => {
    const h = harness({
      readTranscript: () => {
        throw new Error("EACCES");
      },
    });
    const r = await promoteAgentToCloud(input(), h.deps);
    expect(r.ok).toBe(true);
    expect(r.ok && r.transcriptMoved).toBe(false);
    expect(h.log).toContain("startSession");
    expect(h.log).toContain("killLocalPty");
  });
});

// ── The invariant that matters most: no failure may cut the local agent ─────────────────────────

const FAILURES: Array<{
  name: string;
  behavior: Behavior;
  step: string;
  /** True only for the one branch where the kill is legitimately attempted (the kill itself fails). */
  attemptsKill?: boolean;
}> = [
  {
    name: "preflight throws",
    behavior: {
      preflight: () => {
        throw new Error("not a git repository");
      },
    },
    step: "preflight",
  },
  {
    name: "detached HEAD",
    behavior: { preflight: () => preflight({ detached: true }) },
    step: "preflight",
  },
  {
    name: "no origin remote",
    behavior: { preflight: () => preflight({ hasRemote: false }) },
    step: "preflight",
  },
  {
    name: "the WIP commit fails",
    behavior: {
      commitDirty: () => {
        throw new Error("index.lock exists");
      },
    },
    step: "commit",
  },
  {
    name: "the push fails",
    behavior: {
      pushBranch: () => {
        throw new Error("permission denied");
      },
    },
    step: "push",
  },
  {
    name: "the push finds no remote",
    behavior: { pushBranch: () => "no-remote" },
    step: "push",
  },
  {
    name: "the start call fails",
    behavior: {
      startSession: () => {
        throw new Error("boom");
      },
    },
    step: "start",
  },
  {
    name: "the server mints a different session id",
    behavior: { startSession: () => ({ sessionId: "some-other-id" }) },
    step: "start",
  },
  {
    name: "the first frame never arrives",
    behavior: {
      awaitFirstFrame: () => {
        throw new Error("timed out");
      },
    },
    step: "await_live",
  },
  {
    // The local agent kept working across the copy window and COMMITTED. Those commits are not on
    // origin, so cutting now would destroy them while the sandbox resumed from a stale ref.
    name: "the local agent commits during the copy window",
    behavior: { postPreflight: () => preflight({ unpushed: 1, dirtyCount: 0, dirtyFiles: [] }) },
    step: "cutover",
  },
  {
    // Same window, uncommitted writes. `git add -A` left the tree clean, so anything dirty now is
    // new work that was never pushed.
    name: "the local agent writes files during the copy window",
    behavior: { postPreflight: () => preflight({ unpushed: 0, dirtyCount: 3 }) },
    step: "cutover",
  },
  {
    name: "the branch moves out from under us during the copy window",
    behavior: {
      postPreflight: () => preflight({ branch: "someone/else", unpushed: 0, dirtyCount: 0, dirtyFiles: [] }),
    },
    step: "cutover",
  },
  {
    // Mid-rebase is routine in this repo, and a detached read reports branch "" / unpushed 0 —
    // i.e. it looks exactly like "nothing changed" to every counter.
    name: "the worktree is left detached during the copy window",
    behavior: {
      postPreflight: () => preflight({ detached: true, unpushed: 0, dirtyCount: 0, dirtyFiles: [] }),
    },
    step: "cutover",
  },
  {
    name: "the pre-cut re-read cannot resolve a branch",
    behavior: {
      postPreflight: () =>
        preflight({ branch: "", branchExists: false, unpushed: 0, dirtyCount: 0, dirtyFiles: [] }),
    },
    step: "cutover",
  },
  {
    // The real coercion path: an empty/renamed payload from the parallel-branch Rust side. Every
    // discriminator degrades to 0/false/"" — which must REFUSE, not read as proof of quiescence.
    name: "the pre-cut re-read returns a malformed payload",
    behavior: { postPreflight: () => normalizePreflight({}) },
    step: "cutover",
  },
  {
    // We cannot PROVE nothing changed, so we must not cut. Fail closed.
    name: "the pre-cut re-read fails",
    behavior: {
      postPreflight: () => {
        throw new Error("worktree vanished");
      },
    },
    step: "cutover",
  },
  {
    name: "the kill itself fails",
    behavior: {
      killLocalPty: () => {
        throw new Error("no such pty");
      },
    },
    step: "cutover",
    attemptsKill: true,
  },
];

describe("promoteAgentToCloud — every failure leaves the local agent running", () => {
  for (const f of FAILURES) {
    it(`${f.name} → step "${f.step}", and the runtime is NOT flipped`, async () => {
      const h = harness(f.behavior);
      const r = await promoteAgentToCloud(input({ branch: "sparkle/agent-42" }), h.deps);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.step).toBe(f.step);
      expect(!r.ok && r.message.length).toBeGreaterThan(0);
      expect(h.flips).toEqual([]);
      expect(h.log).not.toContain("setRuntimeCloud");
      expect(h.log).not.toContain("sendHandoff");
    });
  }

  // The kill-itself-fails case is the ONE branch where killLocalPty is legitimately invoked, so it
  // is excluded here rather than weakening the assertion for all the others. Note the exclusion is
  // by that FACT, not by step: the four pre-cut race refusals are also `cutover` and must not kill.
  for (const f of FAILURES.filter((x) => !x.attemptsKill)) {
    it(`${f.name} → the local PTY is never killed`, async () => {
      const h = harness(f.behavior);
      await promoteAgentToCloud(input(), h.deps);
      expect(h.log).not.toContain("killLocalPty");
      expect(h.kills).toEqual([]);
    });
  }
});

describe("promoteAgentToCloud — failure messages tell the user where their work is", () => {
  it("a push failure states the WIP commit was made and how to undo it", async () => {
    const h = harness({
      commitDirty: () => 3,
      pushBranch: () => {
        throw new Error("remote rejected");
      },
    });
    const r = await promoteAgentToCloud(input(), h.deps);
    expect(r.ok).toBe(false);
    const msg = !r.ok ? r.message : "";
    expect(msg).toContain("remote rejected");
    expect(msg).toContain(WIP_COMMIT_MESSAGE);
    expect(msg).toContain("git reset --soft HEAD~1");
    expect(msg).toMatch(/still running locally/);
  });

  it("a push failure does NOT claim a commit when nothing was committed", async () => {
    const h = harness({
      pushBranch: () => {
        throw new Error("remote rejected");
      },
    });
    const r = await promoteAgentToCloud(input({ dirtyPolicy: "leave" }), h.deps);
    const msg = !r.ok ? r.message : "";
    expect(msg).not.toContain("git reset --soft");
    expect(msg).not.toContain(WIP_COMMIT_MESSAGE);
  });

  it("a commit failure says nothing was changed", async () => {
    const h = harness({
      commitDirty: () => {
        throw new Error("index.lock exists");
      },
    });
    const r = await promoteAgentToCloud(input(), h.deps);
    expect(!r.ok && r.message).toMatch(/Nothing was changed/);
  });

  it("a start failure surfaces the CLASSIFIED server guidance, not a raw stack", async () => {
    const h = harness({
      startSession: () => {
        throw Object.assign(new Error("nope"), { status: 402, code: "insufficient_credits" });
      },
    });
    const r = await promoteAgentToCloud(input(), h.deps);
    expect(!r.ok && r.message).toMatch(/out of credits/i);
  });

  it("every failure message ends by saying the agent is still local", async () => {
    for (const f of FAILURES) {
      const h = harness(f.behavior);
      const r = await promoteAgentToCloud(input(), h.deps);
      expect(r.ok, f.name).toBe(false);
      expect(r.ok ? "" : r.message, f.name).toMatch(/still running locally/);
    }
  });

  it("refuses when neither the preflight nor the tab knows a branch", async () => {
    // Separate from the table because the fallback is deliberate: an EMPTY preflight branch alone
    // is not a refusal — the tab's recorded branch is used. Only when both are empty is there
    // genuinely nothing to push.
    const h = harness({ preflight: () => preflight({ branch: "" }) });
    const withTab = await promoteAgentToCloud(input({ branch: "sparkle/agent-42" }), h.deps);
    expect(withTab.ok).toBe(true);
    expect(h.pushes[0]!.branch).toBe("sparkle/agent-42");

    const h2 = harness({ preflight: () => preflight({ branch: "" }) });
    const r = await promoteAgentToCloud(input({ branch: "" }), h2.deps);
    expect(!r.ok && r.step).toBe("preflight");
    expect(h2.log).not.toContain("killLocalPty");
    expect(h2.log).not.toContain("pushBranch");
  });
});

describe("promoteAgentToCloud — the billing orphan", () => {
  it("deletes the started session when the first frame never arrives", async () => {
    const h = harness({
      awaitFirstFrame: () => {
        throw new Error("timed out");
      },
    });
    const r = await promoteAgentToCloud(input(), h.deps);
    expect(h.deleted).toEqual([TAB_ID]);
    expect(!r.ok && r.orphanedSessionId).toBeUndefined();
  });

  it("carries orphanedSessionId when the cleanup delete ALSO fails", async () => {
    const h = harness({
      awaitFirstFrame: () => {
        throw new Error("timed out");
      },
      deleteSession: () => {
        throw new Error("offline");
      },
    });
    const r = await promoteAgentToCloud(input(), h.deps);
    expect(!r.ok && r.orphanedSessionId).toBe(TAB_ID);
    expect(!r.ok && r.message).toContain(TAB_ID);
    expect(warn).toHaveBeenCalled();
  });

  it("deletes the SERVER's id — not the tab id — when the server minted a different one", async () => {
    // Deleting the tab id here would leave the real session running and bill for it, while
    // 404-ing (or worse, killing an unrelated row) on the id we sent.
    const h = harness({ startSession: () => ({ sessionId: "some-other-id" }) });
    const r = await promoteAgentToCloud(input(), h.deps);
    expect(h.deleted).toEqual(["some-other-id"]);
    expect(!r.ok && r.step).toBe("start");
  });

  it("stands the cloud session down when the cut itself fails", async () => {
    // Both sides would otherwise be alive on one branch — the exact hazard the ordering exists to
    // prevent. The local agent is the one that keeps running.
    const h = harness({
      killLocalPty: () => {
        throw new Error("no such pty");
      },
    });
    const r = await promoteAgentToCloud(input(), h.deps);
    expect(h.deleted).toEqual([TAB_ID]);
    expect(!r.ok && r.step).toBe("cutover");
    expect(h.log).not.toContain("setRuntimeCloud");
  });
});

describe("promoteAgentToCloud — verify, then cut", () => {
  it("re-reads the worktree AFTER the first frame and BEFORE the kill", async () => {
    const h = harness();
    await promoteAgentToCloud(input(), h.deps);
    expect(h.log.indexOf("recheck")).toBeGreaterThan(h.log.indexOf("awaitFirstFrame"));
    expect(h.log.indexOf("recheck")).toBeLessThan(h.log.indexOf("killLocalPty"));
  });

  it("names what happened, and that nothing was lost, when the agent raced us", async () => {
    const h = harness({ postPreflight: () => preflight({ unpushed: 2, dirtyCount: 0, dirtyFiles: [] }) });
    const r = await promoteAgentToCloud(input(), h.deps);
    const msg = r.ok ? "" : r.message;
    expect(msg).toMatch(/kept working/);
    expect(msg).toMatch(/nothing was lost/i);
    expect(msg).toMatch(/promote again/);
    expect(h.deleted).toEqual([TAB_ID]); // the started cloud session is stood back down
  });

  it("says the worktree SWITCHED BRANCHES — not that there are unpushed changes on the old one", async () => {
    // Three triggers used to share one sentence, and it asserted the one thing a branch switch does
    // not imply: work sitting unpushed on a branch the worktree has left.
    const h = harness({
      postPreflight: () => preflight({ branch: "someone/else", unpushed: 0, dirtyCount: 0, dirtyFiles: [] }),
    });
    const r = await promoteAgentToCloud(input(), h.deps);
    const msg = r.ok ? "" : r.message;
    expect(msg).toContain("now on someone/else");
    expect(msg).toContain("sparkle/agent-42");
    expect(msg).not.toMatch(/never pushed/);
    expect(msg).not.toMatch(/kept working/);
  });

  it("says it COULDN'T CONFIRM when the re-read is unusable, rather than naming a new branch", async () => {
    for (const post of [
      () => preflight({ detached: true }),
      () => preflight({ branch: "", branchExists: false }),
      () => normalizePreflight({}),
    ]) {
      const h = harness({ postPreflight: post });
      const r = await promoteAgentToCloud(input(), h.deps);
      const msg = r.ok ? "" : r.message;
      expect(msg).toMatch(/Couldn't confirm the worktree is still on sparkle\/agent-42/);
      expect(msg).not.toMatch(/now on/);
    }
  });

  it("refuses on an unreadable re-read even though every counter reads 'nothing changed'", async () => {
    // The whole point: `normalizePreflight({})` yields unpushed 0, dirtyCount 0, branch "". A guard
    // built on absence of evidence would read that as proof of quiescence and cut.
    const empty = normalizePreflight({});
    expect(empty.unpushed).toBe(0);
    expect(empty.dirtyCount).toBe(0);
    const h = harness({ postPreflight: () => empty });
    const r = await promoteAgentToCloud(input(), h.deps);
    expect(!r.ok && r.step).toBe("cutover");
    expect(h.log).not.toContain("killLocalPty");
  });

  it('does NOT treat the deliberately-left dirty files as a race under "leave"', async () => {
    // Under "leave" the tree was dirty on purpose and stays dirty, so a dirty re-read proves
    // nothing. Asserting on it would make the "leave" policy impossible to complete.
    const h = harness({
      postPreflight: () => preflight({ dirtyCount: 2, dirtyFiles: ["a", "b"], unpushed: 0 }),
    });
    const r = await promoteAgentToCloud(input({ dirtyPolicy: "leave" }), h.deps);
    expect(r.ok).toBe(true);
    expect(h.log).toContain("killLocalPty");
  });

  it('still catches a NEW COMMIT under "leave" — that is unambiguous either way', async () => {
    const h = harness({
      postPreflight: () => preflight({ dirtyCount: 2, dirtyFiles: ["a", "b"], unpushed: 1 }),
    });
    const r = await promoteAgentToCloud(input({ dirtyPolicy: "leave" }), h.deps);
    expect(!r.ok && r.step).toBe("cutover");
    expect(h.log).not.toContain("killLocalPty");
  });
});

describe("promoteAgentToCloud — the nudge tells the truth about what travelled", () => {
  it("says the conversation was truncated when it was", async () => {
    const h = harness({ readTranscript: () => ({ ...TRANSCRIPT, truncated: true }) });
    const r = await promoteAgentToCloud(input(), h.deps);
    expect(r.ok && r.transcriptTruncated).toBe(true);
    expect(h.handoffs[0]!.text).toMatch(/TRUNCATED/);
    expect(h.handoffs[0]!.text).toMatch(/oldest turns were dropped/);
  });

  it("says nothing about truncation when the whole conversation travelled", async () => {
    const h = harness();
    const r = await promoteAgentToCloud(input(), h.deps);
    expect(r.ok && r.transcriptTruncated).toBe(false);
    expect(h.handoffs[0]!.text).not.toMatch(/TRUNCATED/);
  });

  it('does NOT claim work was committed when the user chose "leave"', async () => {
    // The dialog offers "leave" as a first-class option; a nudge that says "any uncommitted work
    // was committed before the move" would have the cloud agent act on a clone missing its edits.
    const h = harness();
    await promoteAgentToCloud(input({ dirtyPolicy: "leave" }), h.deps);
    const text = h.handoffs[0]!.text;
    expect(text).not.toMatch(/uncommitted work was committed/);
    expect(text).toMatch(/2 uncommitted files were deliberately left/);
    expect(text).toMatch(/NOT in this clone/);
  });

  it('does claim work was committed when the user chose "commit"', async () => {
    const h = harness();
    await promoteAgentToCloud(input({ dirtyPolicy: "commit" }), h.deps);
    expect(h.handoffs[0]!.text).toMatch(/uncommitted work was committed/);
  });
});

describe("promoteAgentToCloud — after the cut, nothing can un-promote it", () => {
  it("a store flip that throws is still a successful promotion, flagged for reconciliation", async () => {
    // Past the cut the local PTY is dead, so "your agent is still running locally" — the tail every
    // failure message in this module carries — would be a lie. The promotion HAPPENED; the tab is
    // what is wrong, and a retry would start (and bill) a second session.
    const h = harness();
    const deps: PromoteDeps = {
      ...h.deps,
      setRuntimeCloud: () => {
        throw new Error("project closed");
      },
    };
    const r = await promoteAgentToCloud(input(), deps);
    expect(r.ok).toBe(true);
    expect(r.ok && r.runtimeFlipFailed).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/still running locally/);
    expect(warn).toHaveBeenCalled();
  });

  it("carries no runtimeFlipFailed flag on the ordinary path", async () => {
    const h = harness();
    const r = await promoteAgentToCloud(input(), h.deps);
    expect(r.ok && "runtimeFlipFailed" in r).toBe(false);
  });

  it("a handoff nudge that fails to send is still a successful promotion", async () => {
    const h = harness({
      sendHandoff: () => {
        throw new Error("socket gone");
      },
    });
    const r = await promoteAgentToCloud(input(), h.deps);
    expect(r.ok).toBe(true);
    expect(h.flips).toHaveLength(1);
    expect(h.deleted).toEqual([]); // the session is the agent now — never delete it here
    expect(warn).toHaveBeenCalled();
  });
});

describe("promoteAgentToCloud — the start payload", () => {
  it("passes the timeout through to awaitFirstFrame", async () => {
    const seen: number[] = [];
    const h = harness();
    const deps: PromoteDeps = {
      ...h.deps,
      awaitFirstFrame: async (a) => {
        seen.push(a.timeoutMs);
      },
    };
    await promoteAgentToCloud(input({ awaitFirstFrameMs: 1234 }), deps);
    expect(seen).toEqual([1234]);
  });

  it("substitutes a non-empty goal — the server requires one even though the runner ignores it", async () => {
    const h = harness();
    await promoteAgentToCloud(input({ goal: "   " }), h.deps);
    expect(h.started[0]!.goal.length).toBeGreaterThan(0);
    expect(h.started[0]!.goal).toContain("sparkle/agent-42");
  });
});

// ── the step observer ───────────────────────────────────────────────────────────────────────────
//
// Not a progress spinner. The whole safety story is an ORDER (spec Decision 5), and the step a
// failure names is what tells the user whether their branch was touched — "it failed at push" and
// "it failed at cutover" mean very different things about their work.
describe("onStep", () => {
  it("announces each step as it begins, in the copy-then-cut order", async () => {
    const h = harness();
    const steps: PromotionStep[] = [];
    const res = await promoteAgentToCloud(input(), {
      ...h.deps,
      onStep: (s) => steps.push(s),
    });
    expect(res.ok).toBe(true);
    expect(steps).toEqual([
      "preflight",
      "commit",
      "push",
      "transcript",
      "start",
      "await_live",
      "cutover",
    ]);
  });

  it("stops at the step that failed, and never announces one past it", async () => {
    const h = harness({
      pushBranch: () => {
        throw new Error("remote rejected");
      },
    });
    const steps: PromotionStep[] = [];
    const res = await promoteAgentToCloud(input(), { ...h.deps, onStep: (s) => steps.push(s) });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.step).toBe("push");
    expect(steps).toEqual(["preflight", "commit", "push"]);
    // The named step and the announced steps agree — a dialog showing "start" while reporting a
    // push failure would be telling the user their branch got further than it did.
    expect(steps[steps.length - 1]).toBe(res.step);
  });

  it("survives an observer that throws — a UI bug must not cost the user their agent", async () => {
    const h = harness();
    const res = await promoteAgentToCloud(input(), {
      ...h.deps,
      onStep: () => {
        throw new Error("render exploded");
      },
    });
    expect(res.ok).toBe(true);
    expect(h.kills).toEqual([TAB_ID]);
  });
});
