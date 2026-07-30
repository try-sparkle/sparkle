import { describe, expect, it } from "vitest";

import {
  QUIET_AFTER_MS,
  SILENT_AFTER_MS,
  contradictionsOf,
  freshestEvidence,
  progressOf,
  reasonFor,
  shouldEscalate,
  thrashInputFrom,
  verdictFor,
  verdictsFor,
  type FleetAgentFacts,
  type FleetDigest,
} from "./fleetVerdict";

const NOW = 1_800_000_000_000;

/**
 * Build a fact record. `over.hooks` / `over.git` are merged over the defaults rather than replacing
 * them, so a test names only the one or two fields it is actually about — which keeps each test's
 * intent legible and stops an added field from breaking every case.
 */
type FactsOverride = Partial<Omit<FleetAgentFacts, "hooks" | "git">> & {
  hooks?: Partial<FleetAgentFacts["hooks"]>;
  git?: Partial<FleetAgentFacts["git"]>;
};

function facts(over: FactsOverride = {}): FleetAgentFacts {
  const { hooks, git, ...rest } = over;
  return {
    agentId: "a1",
    worktree: "/wt/a1",
    worktreeExists: true,
    hookMtimeMs: null,
    newestWriteMs: null,
    walkTruncated: false,
    task: null,
    resultStatus: null,
    ...rest,
    hooks: {
      lastEvent: null,
      lastEventMs: null,
      sessionId: null,
      transcriptPath: null,
      lastTurnEndMs: null,
      turnsRecent: 0,
      toolsRecent: 0,
      compactionsRecent: 0,
      recentTools: [],
      linesScanned: 0,
      tailTruncated: false,
      ...hooks,
    },
    git: {
      ahead: null,
      dirtyFiles: null,
      lastCommitMs: null,
      branch: null,
      changedFiles: [],
      ...git,
    },
  };
}

describe("freshestEvidence", () => {
  it("takes the most recent artifact, not the oldest, and names which one", () => {
    // A commit an hour ago but a file write ten seconds ago is an agent that is working.
    const f = facts({
      git: { ahead: 1, dirtyFiles: 0, lastCommitMs: NOW - 3_600_000, branch: "b", changedFiles: [] },
      newestWriteMs: NOW - 10_000,
    });
    expect(freshestEvidence(f, NOW)).toEqual({ ageMs: 10_000, source: "file-write" });
  });

  it("reports null when every artifact is absent", () => {
    expect(freshestEvidence(facts(), NOW)).toBeNull();
  });

  it("ignores a future timestamp instead of treating it as just-now", () => {
    // Clock skew between the hook emitter and us is real. Treating a future ts as age 0 would mask
    // a dead agent forever — the exact failure this module exists to prevent.
    const f = facts({ hooks: { lastEventMs: NOW + 60_000 } });
    expect(freshestEvidence(f, NOW)).toBeNull();
  });

  it("prefers a real older signal over a skewed future one", () => {
    const f = facts({
      hooks: { lastEventMs: NOW + 60_000 },
      newestWriteMs: NOW - 5_000,
    });
    expect(freshestEvidence(f, NOW)).toEqual({ ageMs: 5_000, source: "file-write" });
  });

  it("ignores zero and negative timestamps", () => {
    expect(freshestEvidence(facts({ newestWriteMs: 0 }), NOW)).toBeNull();
    expect(freshestEvidence(facts({ newestWriteMs: -1 }), NOW)).toBeNull();
  });
});

describe("progressOf", () => {
  it("maps freshness onto the four verdicts at the documented thresholds", () => {
    expect(progressOf(null)).toBe("unobserved");
    expect(progressOf(0)).toBe("advancing");
    expect(progressOf(QUIET_AFTER_MS - 1)).toBe("advancing");
    expect(progressOf(QUIET_AFTER_MS)).toBe("quiet");
    expect(progressOf(SILENT_AFTER_MS - 1)).toBe("quiet");
    expect(progressOf(SILENT_AFTER_MS)).toBe("silent");
  });
});

describe("contradictionsOf", () => {
  it("flags a terminal-rendered agent that still holds uncommitted work", () => {
    // The founder's rule: gray is TERMINAL. An agent with uncommitted work is working or blocked,
    // never idle — so gray + dirty files is a bug in the fleet's reporting.
    const f = facts({ git: { dirtyFiles: 3 } });
    expect(contradictionsOf(f, "quiet", { renderedTerminal: true })).toContain(
      "idle-with-uncommitted-work",
    );
  });

  it("does not flag a terminal-rendered agent whose tree is clean", () => {
    const f = facts({ git: { dirtyFiles: 0 } });
    expect(contradictionsOf(f, "quiet", { renderedTerminal: true })).not.toContain(
      "idle-with-uncommitted-work",
    );
  });

  it("does not flag uncommitted work when the agent is NOT rendered terminal", () => {
    // A working agent with dirty files is normal and must not raise noise. `hookMtimeMs` AND
    // `linesScanned` are both set so this case is about the dirty files alone and not about a hook
    // log that is absent or empty.
    const f = facts({ hookMtimeMs: NOW - 1_000, hooks: { linesScanned: 40 }, git: { dirtyFiles: 3 } });
    expect(contradictionsOf(f, "advancing", { renderedTerminal: false })).toEqual([]);
  });

  it("flags a silent agent that still has work outstanding, by either measure", () => {
    expect(contradictionsOf(facts({ git: { dirtyFiles: 1 } }), "silent")).toContain(
      "silent-with-work-outstanding",
    );
    expect(contradictionsOf(facts({ git: { ahead: 2 } }), "silent")).toContain(
      "silent-with-work-outstanding",
    );
  });

  it("does not flag a silent agent that has landed everything", () => {
    const f = facts({ hookMtimeMs: NOW - 1_000, hooks: { linesScanned: 40 }, git: { dirtyFiles: 0, ahead: 0 } });
    expect(contradictionsOf(f, "silent")).toEqual([]);
  });









  it("flags a live worktree whose hooks never fired", () => {
    const f = facts({ worktreeExists: true, hookMtimeMs: null });
    expect(contradictionsOf(f, "unobserved")).toContain("hooks-never-fired");
  });

  it("flags a hook log that EXISTS but holds no readable line", () => {
    // The likelier real-world shape, and the one the previous `&&` silently excluded: the emitter
    // mkdirSync's and appends, so a truncated or failed write leaves a file with a valid mtime and
    // nothing parseable in it. Every hook-derived status for that agent is then guesswork.
    const f = facts({ worktreeExists: true, hookMtimeMs: NOW - 1_000, hooks: { linesScanned: 0 } });
    expect(contradictionsOf(f, "quiet")).toContain("hooks-never-fired");
  });

  it("does not blame a deleted worktree for having no hooks", () => {
    const f = facts({ worktreeExists: false, hookMtimeMs: null });
    expect(contradictionsOf(f, "unobserved")).not.toContain("hooks-never-fired");
  });
});

describe("shouldEscalate — the trigger", () => {
  it("escalates on silence and on nothing-to-observe", () => {
    expect(shouldEscalate("silent", [])).toBe(true);
    expect(shouldEscalate("unobserved", [])).toBe(true);
  });

  it("does not escalate an advancing agent with nothing wrong", () => {
    expect(shouldEscalate("advancing", [])).toBe(false);
    expect(shouldEscalate("quiet", [])).toBe(false);
  });


  it("escalates a quiet agent only when it has an unmet goal", () => {
    expect(shouldEscalate("quiet", [], { hasUnmetGoal: false })).toBe(false);
    expect(shouldEscalate("quiet", [], { hasUnmetGoal: true })).toBe(true);
  });
});

describe("the 42-minute stall that motivated this — acceptance test", () => {
  /**
   * The author of this module stopped mid-task for roughly 42 minutes: the turn ended, no hook
   * fired again, no file was written, nothing was committed, an unmet goal was outstanding and the
   * row rendered GRAY with uncommitted changes. Nothing noticed until a human looked at the row.
   *
   * This is the shape of that agent. If this test ever goes green for the wrong reason, Level 0 has
   * stopped doing the one job it exists for.
   */
  const stalled = facts({
    agentId: "b2d902e0",
    worktreeExists: true,
    hookMtimeMs: NOW - 42 * 60_000,
    hooks: {
      lastEvent: "Stop",
      lastEventMs: NOW - 42 * 60_000,
      lastTurnEndMs: NOW - 42 * 60_000,
      linesScanned: 120,
    },
    git: { dirtyFiles: 4, ahead: 0, lastCommitMs: NOW - 90 * 60_000 },
    newestWriteMs: NOW - 42 * 60_000,
  });

  it("calls it silent rather than idle", () => {
    const v = verdictFor(stalled, NOW, { renderedTerminal: true, hasUnmetGoal: true });
    expect(v.progress).toBe("silent");
    expect(v.evidenceAgeMs).toBe(42 * 60_000);
  });

  it("names the gray-with-uncommitted-work contradiction", () => {
    const v = verdictFor(stalled, NOW, { renderedTerminal: true, hasUnmetGoal: true });
    expect(v.contradictions).toContain("idle-with-uncommitted-work");
    expect(v.contradictions).toContain("silent-with-work-outstanding");
  });

  it("escalates", () => {
    expect(verdictFor(stalled, NOW, { renderedTerminal: true, hasUnmetGoal: true }).shouldEscalate).toBe(
      true,
    );
  });

  it("would NOT have escalated two minutes in, so the threshold is doing the work", () => {
    // Same agent, sampled at 90 seconds. Proves the verdict tracks elapsed time rather than always
    // firing — a detector that escalates everything is not a detector.
    const early = { ...stalled, hookMtimeMs: NOW - 90_000, newestWriteMs: NOW - 90_000 };
    early.hooks = { ...stalled.hooks, lastEventMs: NOW - 90_000, lastTurnEndMs: NOW - 90_000 };
    const v = verdictFor(early, NOW, { renderedTerminal: false, hasUnmetGoal: true });
    expect(v.progress).toBe("advancing");
    expect(v.shouldEscalate).toBe(false);
  });

  it("explains itself in one readable line", () => {
    const v = verdictFor(stalled, NOW, { renderedTerminal: true, hasUnmetGoal: true });
    expect(v.reason).toContain("silent");
    expect(v.reason).toContain("42 minutes ago");
    expect(v.reason).toContain("4 uncommitted files");
    expect(v.reason).toContain("idle-with-uncommitted-work");
  });
});

describe("reasonFor", () => {
  it("says plainly when there is no artifact at all", () => {
    expect(reasonFor(facts(), "unobserved", null, [])).toContain("no artifact of any kind");
  });

  it("singularises one uncommitted file and pluralises more", () => {
    const one = reasonFor(facts({ git: { dirtyFiles: 1 } }), "quiet", { ageMs: 300_000, source: "file-write" }, []);
    expect(one).toContain("1 uncommitted file");
    expect(one).not.toContain("uncommitted files");

    const many = reasonFor(facts({ git: { dirtyFiles: 4 } }), "quiet", { ageMs: 300_000, source: "file-write" }, []);
    expect(many).toContain("4 uncommitted files");
  });
});

describe("verdictsFor", () => {
  it("judges every agent in a digest against the digest's own clock", () => {
    const digest: FleetDigest = {
      generatedAtMs: NOW,
      windowMs: 900_000,
      agents: [
        facts({ agentId: "moving", newestWriteMs: NOW - 1_000 }),
        facts({ agentId: "gone-quiet", newestWriteMs: NOW - 30 * 60_000 }),
      ],
      conflicts: [],
    };
    const verdicts = verdictsFor(digest);
    expect(verdicts.map((v) => [v.agentId, v.progress])).toEqual([
      ["moving", "advancing"],
      ["gone-quiet", "silent"],
    ]);
  });

  it("applies per-agent context from the caller", () => {
    const digest: FleetDigest = {
      generatedAtMs: NOW,
      windowMs: 900_000,
      agents: [
        facts({
          agentId: "gray",
          hookMtimeMs: NOW - 1_000,
          newestWriteMs: NOW - 1_000,
          hooks: { linesScanned: 40 },
          git: { dirtyFiles: 2 },
        }),
      ],
      conflicts: [],
    };
    const withoutCtx = verdictsFor(digest);
    expect(withoutCtx[0]?.contradictions).toEqual([]);

    const withCtx = verdictsFor(digest, () => ({ renderedTerminal: true }));
    expect(withCtx[0]?.contradictions).toContain("idle-with-uncommitted-work");
  });
});

describe("bounded reads — a window is never reported as the whole result", () => {
  /**
   * `walkTruncated` and `tailTruncated` were computed in Rust, mirrored into these interfaces, and
   * then read by NOBODY, while `freshestEvidence` consumed `newestWriteMs` as if it were the answer.
   * That is the exact thing `fleet.rs`'s own header forbids. And truncation is the NORMAL case, not
   * the edge: this repo's worktree has directories deeper than the walk's depth limit, so a routine
   * pass truncates and `newestWriteMs` becomes traversal-order-dependent.
   */
  const truncatedWalk = facts({
    hookMtimeMs: null,
    hooks: { linesScanned: 40 },
    newestWriteMs: NOW - 30 * 60_000,
    walkTruncated: true,
  });

  it("does not let a truncated walk's file-write establish SILENCE", () => {
    // The write we found is the newest we HAPPENED to reach before the budget ran out — a lower bound.
    // The real newest write may be in the part of the tree never visited, so `silent` would assert a
    // fact we do not hold, in the one direction that costs something.
    expect(verdictFor(truncatedWalk, NOW).progress).toBe("quiet");
  });

  it("still calls it silent when the walk was COMPLETE", () => {
    // The control. Without this, the test above could pass because nothing ever reports silence.
    const complete = { ...truncatedWalk, walkTruncated: false };
    expect(verdictFor(complete, NOW).progress).toBe("silent");
  });

  it("leaves a truncated walk alone when a fresher COMPLETE signal decides the verdict", () => {
    // The downgrade is narrow on purpose: a hook event is a complete signal, so it stands. This is
    // what keeps the 42-minute stall (which reads its hook log, not its worktree) escalating.
    const hookDecides = {
      ...truncatedWalk,
      hookMtimeMs: NOW - 40 * 60_000,
      newestWriteMs: NOW - 90 * 60_000,
    };
    const v = verdictFor(hookDecides, NOW);
    expect(v.evidenceSource).toBe("hook-log-mtime");
    expect(v.progress).toBe("silent");
  });

  it("downgrades the VERDICT without downgrading the ALARM", () => {
    // The dead-worker case AGENTS.md names: an app restart killed the agent, but a background build
    // kept writing files, and the walk that found those writes was truncated. The honest verdict is
    // `quiet` (we could not establish silence) — but the agent must still reach the escalate
    // shortlist, or the downgrade has converted a wrong answer into an invisible one. Level 1 is a
    // free artifact read, so escalating here costs nothing and NOT escalating costs the whole feature.
    const killedWorker = facts({
      agentId: "killed-by-restart",
      hookMtimeMs: NOW - 45 * 60_000,
      hooks: { lastEvent: "Stop", lastEventMs: NOW - 45 * 60_000, linesScanned: 300 },
      newestWriteMs: NOW - 12 * 60_000, // a background build, not the agent
      walkTruncated: true,
      git: { dirtyFiles: 4, ahead: 0 },
    });
    const v = verdictFor(killedWorker, NOW);
    expect(v.progress).toBe("quiet");
    expect(v.contradictions).toContain("silent-with-work-outstanding");
    expect(v.shouldEscalate).toBe(true);
  });

  it("puts that agent on fleetDigest's escalate shortlist, not just in its verdict", () => {
    // shouldEscalate is the ONLY thing the shortlist is derived from, so asserting the boolean above
    // is not enough on its own — this asserts the output the concierge actually reads.
    const digest: FleetDigest = {
      generatedAtMs: NOW,
      windowMs: 900_000,
      agents: [
        facts({
          agentId: "killed-by-restart",
          hookMtimeMs: NOW - 45 * 60_000,
          hooks: { lastEvent: "Stop", lastEventMs: NOW - 45 * 60_000, linesScanned: 300 },
          newestWriteMs: NOW - 12 * 60_000,
          walkTruncated: true,
          git: { dirtyFiles: 4 },
        }),
      ],
      conflicts: [],
    };
    const escalate = verdictsFor(digest)
      .filter((v) => v.shouldEscalate)
      .map((v) => v.agentId);
    expect(escalate).toEqual(["killed-by-restart"]);
  });

  it("escalates unestablished silence on its OWN, with no contradiction to carry it", () => {
    // The case that isolates the rule. The agent above also raised `silent-with-work-outstanding`,
    // which escalates by itself — so it could not tell whether the uncertainty rule was doing any
    // work. (mutation-check proved exactly that: deleting the rule left that test green.) Here the
    // tree is CLEAN, so no contradiction fires and the only thing standing between this agent and
    // invisibility is "a bounded read stopped us calling it silent".
    const cleanButUnknown = facts({
      hookMtimeMs: NOW - 45 * 60_000,
      hooks: { lastEvent: "Stop", lastEventMs: NOW - 45 * 60_000, linesScanned: 300 },
      newestWriteMs: NOW - 12 * 60_000,
      walkTruncated: true,
      git: { dirtyFiles: 0, ahead: 0 },
    });
    const v = verdictFor(cleanButUnknown, NOW);
    expect(v.progress).toBe("quiet");
    expect(v.contradictions).toEqual([]);
    expect(v.shouldEscalate).toBe(true);
  });

  it("does NOT escalate a truncated walk whose agent is genuinely fresh", () => {
    // The control that stops the rule above from becoming "escalate everything, since walkTruncated is
    // true on a routine pass". Truncation alone is not an alarm; truncation that PREVENTED a silence
    // call is.
    const f = facts({
      hookMtimeMs: NOW - 5_000,
      hooks: { linesScanned: 40 },
      newestWriteMs: NOW - 5_000,
      walkTruncated: true,
    });
    const v = verdictFor(f, NOW);
    expect(v.progress).toBe("advancing");
    expect(v.evidenceIncomplete).toBe(true);
    expect(v.shouldEscalate).toBe(false);
  });

  it("admits in the verdict and in the reason that the reads were bounded", () => {
    const v = verdictFor(truncatedWalk, NOW);
    expect(v.evidenceIncomplete).toBe(true);
    expect(v.reason).toContain("reads were bounded");
  });

  it("reports a truncated hook TAIL as incomplete too", () => {
    const f = facts({ hookMtimeMs: NOW - 1_000, hooks: { linesScanned: 900, tailTruncated: true } });
    expect(verdictFor(f, NOW).evidenceIncomplete).toBe(true);
  });

  it("claims completeness when neither read was truncated", () => {
    const f = facts({ hookMtimeMs: NOW - 1_000, hooks: { linesScanned: 40 } });
    const v = verdictFor(f, NOW);
    expect(v.evidenceIncomplete).toBe(false);
    expect(v.reason).not.toContain("reads were bounded");
  });
});

describe("thrashInputFrom", () => {
  it("passes the hook-derived tool run through for the thrash reducer", () => {
    // The point of this adapter: agentThrash's own registry is fed only from a mounted AgentPane,
    // so an unwatched agent can thrash forever unseen. These facts come from the log instead.
    const f = facts({
      hooks: { recentTools: ["Bash", "Bash", "Bash"], toolsRecent: 3, turnsRecent: 3, compactionsRecent: 2 },
    });
    expect(thrashInputFrom(f)).toEqual({
      recentTools: ["Bash", "Bash", "Bash"],
      turnsWithoutTools: 0,
      compactions: 2,
    });
  });


  it("does not feed the reducer a toolless count derived from a truncated tail", () => {
    // Same reasoning as the contradiction: a bounded read cannot establish that no tool ran, so
    // passing 5 here would hand the thrash reducer a number manufactured by our own read limit.
    const f = facts({ hooks: { turnsRecent: 30, toolsRecent: 0, tailTruncated: true } });
    expect(thrashInputFrom(f).turnsWithoutTools).toBe(0);
  });
});
