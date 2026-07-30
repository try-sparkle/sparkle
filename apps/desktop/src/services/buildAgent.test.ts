import { describe, it, expect } from "vitest";
import {
  parseWorkerResult,
  workerPersona,
  workerMission,
  orchestrationPersona,
  beadsProtocol,
  guardrailsProtocol,
  sparkleControlProtocol,
  KEYCHAIN_SAFETY_RULE,
  WORKER_RESULT_RELPATH,
  retroEmissionProtocol,
} from "./buildAgent";
import { RETRO_MARKER_TEMPLATE, RETRO_SEVERITY_SCALE_LINE } from "./retroMarker";

describe("sparkleControlProtocol — name yourself early, but never in a turn of your own", () => {
  it("still demands rename_agent in the agent's FIRST tool-calling turn", () => {
    // Naming defers a build/worker's first paid call (agentNaming.ts's deferred_first_turn branch)
    // on the bet that the agent names itself. The old copy merely described rename_agent as
    // available, so agents named themselves late or never and the sidebar sat on "Build 4" for many
    // turns (founder screenshot, 2026-07-15). That EARLINESS requirement survives the batching
    // rule below — "batched" must never be read as "later".
    const p = sparkleControlProtocol();
    expect(p).toMatch(/FIRST turn/);
    expect(p).toMatch(/rename_agent/);
  });

  it("forbids spending a whole turn on a control call (the 39%-of-usage regression)", () => {
    // Every control op is a full API round-trip that re-bills the entire context to deliver ~40
    // bytes. Measured 2026-07-27 across this app's transcripts: 1,545 narration turns, 100% of them
    // solo, ~82.5k billed tokens each — 33-51% of a short session's spend. The fix is purely this
    // prose (batch the call into a turn that also does real work), so if the rule ever falls out of
    // the persona the cost silently comes back.
    const p = sparkleControlProtocol();
    expect(p).toMatch(/NEVER send a control call as a turn BY ITSELF/);
    expect(p).toMatch(/SAME assistant turn/);
  });

  it("tells the agent to narrate at phase boundaries, not per sub-task", () => {
    expect(sparkleControlProtocol()).toMatch(/PHASE boundaries/);
  });

  it("carves out the hand-back case, where skipping narration costs a PAID call instead", () => {
    // roborev 53476: "skip it if you have nothing to batch with" aims straight at the turn that
    // hands back to the human — which has no other tool call by construction. But that is exactly
    // when useAttentionNotifications wants a recent narration to use as the needs-you notification
    // body; without one it falls through to the credit-metered summarize_attention scrape. So the
    // saving is illusory there, and the exemption has to survive in the prose or it comes back.
    const p = sparkleControlProtocol();
    expect(p).toMatch(/ONE EXCEPTION/);
    expect(p).toMatch(/hand back to the human/);
    expect(p).toMatch(/LAST tool-using turn/);
  });

  it("gives the carve-out a fallback, so it can never justify a solo control turn", () => {
    // roborev 53552: an agent does not know a turn is its LAST until the results come back and it
    // decides to stop — so the literal-compliance path is a narration issued after the last real
    // tool call, i.e. exactly the solo turn the COST RULE forbids (~82,575 billed tokens). That
    // would spend an Opus-tier context replay to avoid one Haiku summary: strictly worse than the
    // thing it replaces. The exemption is only safe while the fallback rides with it.
    const p = sparkleControlProtocol();
    expect(p).toMatch(/if you only realize you're stopping AFTER your last tool call/i);
    expect(p).toMatch(/do NOT send the narration/i);
    expect(p).toMatch(/COST RULE wins/);
  });

  it("warns that get_state is expensive and offers the narrowing scope", () => {
    const p = sparkleControlProtocol();
    expect(p).toMatch(/get_state\(\{ scope \}\)/);
    expect(p).toMatch(/EXPENSIVE/);
  });

  it("does not sell scope 'active' as a process check, and points at liveness", () => {
    // roborev 53556: the per-row `liveness` label was corrected to stop asserting aliveness, but
    // the SCOPE contract one level up still said "agents with a live process" — the same overclaim,
    // and the more dangerous one: a caller that trusts it ("I asked for live processes, I got N
    // rows, so N workers are running") never reaches the liveness field at all. The persona is the
    // surface every agent reads unconditionally, so if it still claims live processes it silently
    // contradicts the corrected MCP tool description sitting in the same context window.
    const p = sparkleControlProtocol();
    expect(p).not.toMatch(/agents with a live process/);
    expect(p).toMatch(/not a process check/);
    expect(p).toMatch(/liveness/);
  });

  it("the demands ride in every code-producing persona, not just the snippet", () => {
    // The snippet is appended to both personas via --append-system-prompt; if it ever stops being
    // included, the self-naming bet reverts to deferred-forever AND the batching rule is lost.
    for (const persona of [
      workerPersona({ parentBranch: "main", resultPath: ".sparkle/result.json" }),
      orchestrationPersona({ ownBranch: "b", maxConcurrentWorkers: 3 }),
    ]) {
      expect(persona).toMatch(/FIRST turn/);
      expect(persona).toMatch(/NEVER send a control call as a turn BY ITSELF/);
    }
  });
});

describe("WORKER_RESULT_RELPATH", () => {
  it("is the .sparkle/result.json contract path", () => {
    expect(WORKER_RESULT_RELPATH).toBe(".sparkle/result.json");
  });
});

describe("parseWorkerResult", () => {
  const valid = JSON.stringify({
    schemaVersion: 1,
    taskId: "t1",
    branch: "sparkle/agent-w1",
    status: "success",
    filesChanged: ["a.ts", "b.ts"],
    summary: "did the thing",
  });

  it("parses a valid result", () => {
    const r = parseWorkerResult(valid);
    expect(r.status).toBe("success");
    expect(r.filesChanged).toEqual(["a.ts", "b.ts"]);
    expect(r.notes).toBeUndefined();
  });

  it("throws on a bad status value", () => {
    const bad = JSON.stringify({ ...JSON.parse(valid), status: "done" });
    expect(() => parseWorkerResult(bad)).toThrow(/status/);
  });

  it("throws on a missing required field", () => {
    const bad = JSON.stringify({ ...JSON.parse(valid), branch: undefined });
    expect(() => parseWorkerResult(bad)).toThrow(/branch/);
  });

  it("throws on non-JSON", () => {
    expect(() => parseWorkerResult("not json")).toThrow();
  });

  it("throws on null JSON", () => {
    expect(() => parseWorkerResult("null")).toThrow(/object/);
  });

  it("throws on scalar JSON", () => {
    expect(() => parseWorkerResult("123")).toThrow(/object/);
  });

  it("throws on array JSON", () => {
    expect(() => parseWorkerResult("[]")).toThrow(/object/);
  });

  it("throws on empty summary", () => {
    const bad = JSON.stringify({ ...JSON.parse(valid), summary: "" });
    expect(() => parseWorkerResult(bad)).toThrow(/summary/);
  });

  // The `retro` key is OPTIONAL (missing → fine) but STRICT-when-present: a malformed retro throws,
  // and that throw is caught at the one AgentPane call site. The capture hook reads result.json.retro
  // and forwards each pain point into the agent-feedback beads inbox, so its shape must be validated
  // to docs/schemas/worker-retro.schema.json.
  describe("retro", () => {
    const withRetro = (retro: unknown) => JSON.stringify({ ...JSON.parse(valid), retro });

    it("is absent by default — a worker that emits no retro still parses", () => {
      expect(parseWorkerResult(valid).retro).toBeUndefined();
    });

    it("parses a valid retro with pain points", () => {
      const r = parseWorkerResult(
        withRetro({
          tldr: "Built X; the worktree step was slow.",
          painPoints: [
            { summary: "worktree add took minutes", severity: 2, recommendation: "warm a pool", subsystem: "worktree" },
          ],
        }),
      );
      expect(r.retro?.tldr).toContain("Built X");
      expect(r.retro?.painPoints).toHaveLength(1);
      expect(r.retro?.painPoints[0]?.severity).toBe(2);
      expect(r.retro?.painPoints[0]?.subsystem).toBe("worktree");
      // Unset optionals are dropped, not carried as undefined-valued keys.
      expect(r.retro?.painPoints[0]?.context).toBeUndefined();
    });

    it("accepts an empty painPoints array (a frictionless task)", () => {
      const r = parseWorkerResult(withRetro({ tldr: "smooth", painPoints: [] }));
      expect(r.retro?.painPoints).toEqual([]);
    });

    it("throws when tldr is missing", () => {
      expect(() => parseWorkerResult(withRetro({ painPoints: [] }))).toThrow(/retro\.tldr/);
    });

    it("throws when painPoints is not an array", () => {
      expect(() => parseWorkerResult(withRetro({ tldr: "t", painPoints: "nope" }))).toThrow(
        /retro\.painPoints/,
      );
    });

    it("throws on a severity outside 1-3", () => {
      const bad = withRetro({
        tldr: "t",
        painPoints: [{ summary: "s", severity: 4, recommendation: "r" }],
      });
      expect(() => parseWorkerResult(bad)).toThrow(/severity/);
    });

    it("throws when a pain point is missing its recommendation", () => {
      const bad = withRetro({ tldr: "t", painPoints: [{ summary: "s", severity: 1 }] });
      expect(() => parseWorkerResult(bad)).toThrow(/recommendation/);
    });

    it("carries orchestrator-stamped provenance through when present", () => {
      const r = parseWorkerResult(
        withRetro({ tldr: "t", painPoints: [], prNumber: 42, mergedSha: "abc123" }),
      );
      expect(r.retro?.prNumber).toBe(42);
      expect(r.retro?.mergedSha).toBe("abc123");
    });
  });
});

describe("workerPersona", () => {
  const p = workerPersona({ parentBranch: "sparkle/agent-build1", resultPath: "/wt/.sparkle/result.json" });
  it("names the result path and parent branch and forbids spawning workers", () => {
    expect(p).toContain("/wt/.sparkle/result.json");
    expect(p).toContain("sparkle/agent-build1");
    expect(p).toMatch(/exactly ONE task/i);
    expect(p).toMatch(/do not.*spawn/i);
  });
  it("tells the worker it is unattended: don't ask questions, assume-and-report instead", () => {
    // No human is watching a worker, so a clarifying question or approval wait is a silent stall.
    expect(p).toMatch(/unattended|no one is watching|no human/i);
    expect(p).toMatch(/do not ask/i);
    expect(p).toMatch(/assumption/i);
    expect(p).toMatch(/notes/i);
  });
  it("forbids the macOS `security` CLI / touching the ai.sparkle.desktop keychain", () => {
    // sparkle-0ezz: an agent shelling out to `security` against the app keychain pops a scary OS prompt.
    expect(p).toContain(KEYCHAIN_SAFETY_RULE);
    expect(p).toMatch(/security/);
    expect(p).toContain("ai.sparkle.desktop");
    expect(p).toMatch(/never/i);
  });
  it("makes the structured founder-format retro + PR-body marker the required final output", () => {
    // The retro REPLACES any free-form completion report. The human copy is the founder format;
    // the machine copy is the single-line PR-body marker the merge-time capture hook reads. Both
    // come from the shared retroEmissionProtocol(), so assert the block is present verbatim plus
    // the load-bearing anchors a reader would eyeball.
    expect(p).toContain(retroEmissionProtocol());
    expect(p).toContain("**TL;DR:**");
    expect(p).toContain("**PERCENT COMPLETE:**");
    expect(p).toContain("**SPARKLE IMPROVEMENTS:**");
    expect(p).toContain(RETRO_SEVERITY_SCALE_LINE);
    expect(p).toContain(RETRO_MARKER_TEMPLATE);
    expect(p).toMatch(/painPoints/);
    expect(p).toMatch(/severity/);
    // Anonymized — the retro leaves the worktree, so it carries the same no-PII rule as everything else.
    expect(p).toMatch(/ANONYMIZED|no.*PII/i);
  });
});

describe("retroEmissionProtocol — the frozen retro emit contract, shared across personas", () => {
  const r = retroEmissionProtocol();
  it("prints the founder format, the severity scale once, and the PR-body marker template", () => {
    for (const anchor of [
      "**TL;DR:**",
      "**PERCENT COMPLETE:**",
      "**EST COMPLETION:**",
      "**MORE DETAILS:**",
      "**SPARKLE IMPROVEMENTS:**",
      "**AGENT ID:**",
      "**PAIN POINT:**",
      "**SEVERITY:**",
      "**RECOMMENDATION:**",
      "**ADDITIONAL CONTEXT:**",
    ]) {
      expect(r).toContain(anchor);
    }
    expect(r.split(RETRO_SEVERITY_SCALE_LINE)).toHaveLength(2); // scale line printed exactly once
    expect(r).toContain(RETRO_MARKER_TEMPLATE);
    expect(r).toMatch(/REPLACES any free-form completion report/);
    expect(r).toMatch(/ANONYMIZED|no PII/);
  });
});

describe("guardrailsProtocol", () => {
  const g = guardrailsProtocol();
  it("names the core quality gates: run tests/typecheck before commit, red = not done", () => {
    expect(g).toMatch(/GUARDRAILS/);
    expect(g).toMatch(/test/i);
    expect(g).toMatch(/typecheck|lint|build/i);
    expect(g).toMatch(/red/i);
    expect(g).toMatch(/not done|before you commit/i);
  });
  it("is adaptive: a project with no tests is nudged, not hard-blocked", () => {
    expect(g).toMatch(/no test setup/i);
    expect(g).toMatch(/do not hard-block|not hard-block/i);
  });
});

describe("guardrails gating in personas", () => {
  it("workerPersona includes the guardrails snippet only when guardrails is on", () => {
    const on = workerPersona({ parentBranch: "b", resultPath: "/r", guardrails: true });
    const off = workerPersona({ parentBranch: "b", resultPath: "/r", guardrails: false });
    const dflt = workerPersona({ parentBranch: "b", resultPath: "/r" });
    expect(on).toContain(guardrailsProtocol());
    expect(off).not.toContain(guardrailsProtocol());
    // Absent opt (undefined) → off: the flag is opt-in from the caller's settings.
    expect(dflt).not.toContain(guardrailsProtocol());
  });
  it("orchestrationPersona includes the guardrails snippet only when guardrails is on", () => {
    const base = { ownBranch: "b", maxConcurrentWorkers: 4 };
    expect(orchestrationPersona({ ...base, guardrails: true })).toContain(guardrailsProtocol());
    expect(orchestrationPersona({ ...base, guardrails: false })).not.toContain(guardrailsProtocol());
    expect(orchestrationPersona(base)).not.toContain(guardrailsProtocol());
  });
});

describe("workerMission", () => {
  it("embeds the task", () => {
    expect(workerMission("Implement the login form", "agent-abc")).toContain("Implement the login form");
  });

  it("puts the taskId on a leading Task <id>: line", () => {
    const out = workerMission("Implement the login form", "agent-abc");
    expect(out).toContain("Task agent-abc:");
    expect(out).toContain("Implement the login form");
    // The id line must come before the task text
    expect(out.indexOf("Task agent-abc:")).toBeLessThan(out.indexOf("Implement the login form"));
  });
});

describe("orchestrationPersona", () => {
  const p = orchestrationPersona({ ownBranch: "sparkle/agent-build1", maxConcurrentWorkers: 4 });

  it("establishes the orchestrator role and decomposition", () => {
    expect(p).toMatch(/ORCHESTRATOR|orchestrator/);
    expect(p).toMatch(/decompose/i);
  });

  it("states the division of labor: subagents for research, spawn_worker for code units", () => {
    expect(p).toMatch(/subagent/i);
    expect(p).toMatch(/read-only|research/i);
    expect(p).toContain("spawn_worker");
  });

  it("names the wait + list tools and the concurrency cap", () => {
    expect(p).toContain("wait_for_workers");
    expect(p).toContain("list_workers");
    expect(p).toContain("4"); // the cap value is interpolated
  });

  it("uses explicit batching up to the cap — no 'queues automatically' promise", () => {
    // The persona must instruct batching explicitly and warn against exceeding the cap.
    // It must NOT claim that spawn_worker queues transparently (that caused deadlock).
    expect(p).not.toMatch(/queue.*automatically|automatically.*queue/i);
    // Instructs to spawn up to the cap per batch.
    expect(p).toMatch(/up to.*4|batch/i);
    // Instructs to spin_down_worker to free slots before the next batch.
    expect(p).toMatch(/spin.?down|free.*slot|slot.*free/i);
    // Warns against exceeding the cap without spinning down first.
    expect(p).toMatch(/exceed.*cap|reach the cap|cap.*time|not.*more than.*cap/i);
    // Positively asserts the ACCURATE mechanism (over-cap queues but BLOCKS the REPL → deadlock/timeout),
    // not just the absence of the old "queues automatically" phrasing.
    expect(p).toMatch(/block|deadlock/i);
  });

  it("instructs a SEQUENTIAL merge into its own branch, never main", () => {
    expect(p).toContain("sparkle/agent-build1"); // its own branch, the merge target
    expect(p).toMatch(/one at a time|sequentially/i);
    expect(p).toMatch(/never/i);
    expect(p).toMatch(/\bmain\b/);
    expect(p).toMatch(/conflict/i);
  });

  it("tells it to land its OWN PR via `gh pr merge --merge`, not to hand off a manual command", () => {
    // The Composer "Merge PR" CTA prompts the build agent to merge; the persona must permit that
    // one sanctioned, GitHub-gated path rather than declaring itself blocked from touching main.
    expect(p).toMatch(/gh pr merge <PR#> --merge/);
    // It must own the merge end-to-end, not punt it back to the user.
    expect(p).toMatch(/do not hand the user a raw command|not to explain that you're blocked|RUN the\n?\s*merge/i);
    // And it must still forbid DIRECT main writes (the 2026-06-23 merge-mess mitigation).
    expect(p).toMatch(/never .*write to `main` locally|direct-`?main`? writes/i);
    // The strategy flag is required non-interactively — the exact footgun from the field report.
    expect(p).toMatch(/no strategy flag fails/i);
  });

  it("tells it to spin_down_worker after merging and to report the consolidated outcome", () => {
    expect(p).toContain("spin_down_worker");
    expect(p).toMatch(/report|consolidated/i);
  });

  it("ends the report as the structured retro + embeds the PR-body marker", () => {
    // The orchestrator is the agent that opens the landing PR, so the machine-readable marker rides
    // on its PR body; the human copy is the founder-format retro. Both come from the shared block.
    expect(p).toContain(retroEmissionProtocol());
    expect(p).toContain("**SPARKLE IMPROVEMENTS:**");
    expect(p).toContain(RETRO_MARKER_TEMPLATE);
  });

  it("makes it drain roborev findings on each worker branch BEFORE spinning the worker down", () => {
    // spin_down deletes the worktree (not a checkout), so the pre-checkout gate never fires and
    // FAIL findings on worker commits would orphan. The persona must instruct an explicit drain.
    expect(p).toMatch(/roborev list --open/);
    expect(p).toMatch(/triage/i);
    // The drain must be ordered BEFORE the spin-down, not after.
    expect(p.indexOf("roborev list --open")).toBeLessThan(p.lastIndexOf("spin_down_worker"));
    // References the cross-branch sweep backstop.
    expect(p).toContain("roborev-list-all.py");
  });

  it("reflects a different cap value", () => {
    expect(orchestrationPersona({ ownBranch: "b", maxConcurrentWorkers: 2 })).toContain("2");
  });

  it("tells it to handle an `errored` worker (decide: respawn / redirect / escalate) and not merge it", () => {
    expect(p).toMatch(/errored/);
    expect(p).toMatch(/respawn|re-?spawn/i);
    expect(p).toMatch(/escalate|report/i);
    // An errored worker must not be merged as if it succeeded.
    expect(p).toMatch(/do not merge|not.*merge/i);
  });

  it("forbids the macOS `security` CLI / touching the ai.sparkle.desktop keychain", () => {
    // sparkle-0ezz: same keychain-safety rule the worker carries, enforced on the orchestrator too.
    expect(p).toContain(KEYCHAIN_SAFETY_RULE);
    expect(p).toContain("ai.sparkle.desktop");
    expect(p).toMatch(/generic-password/);
  });
});

describe("beadsProtocol", () => {
  const p = beadsProtocol({ epicId: "epic-42" });

  it("binds the orchestrator to the epic and its child tasks", () => {
    expect(p).toContain("epic-42");
    expect(p).toContain("bd show epic-42 --json");
    expect(p).toContain("spawn_worker");
  });

  it("instructs exactly one worker per task, linked to its bead via the beadId argument", () => {
    expect(p).toMatch(/one worker/i);
    expect(p).toContain("beadId"); // the worker↔bead linkage argument
    expect(p).toContain("spawn_worker");
  });

  it("tells the orchestrator to check list_workers for existing claims before re-fanning out", () => {
    // NOTE ON WHAT THIS TEST IS WORTH. It pins PROSE, and prose is not a mechanism — the actual
    // enforcement is the bead claim guard in orchestrationListener (separately tested, and
    // mutation-tested). This exists only so the clause can't be silently dropped, because the
    // persona is what a FRESH agent reads after a restart, which is precisely when the duplicate
    // fan-out happened. A previous attempt at deduplication shipped as persona text with a test
    // asserting the text existed and no mechanism behind it; that is the mistake this comment
    // exists to keep visible.
    expect(p).toMatch(/list_workers/);
    expect(p).toMatch(/re-entrancy|restart|resume/i);
    expect(p).toMatch(/skip/i);
  });

  it("leaves status transitions to the app, not manual bd commands", () => {
    // in_progress/closed/delivered are now written programmatically (syncBeadLifecycle); the
    // orchestrator is explicitly told NOT to run them by hand so the board can't drift.
    expect(p).toMatch(/do not run/i);
    expect(p).toMatch(/automatically/i);
  });
});

describe("KEYCHAIN_SAFETY_RULE", () => {
  it("names the security CLI, the generic-password surface, and the app keychain item", () => {
    expect(KEYCHAIN_SAFETY_RULE).toMatch(/security/);
    expect(KEYCHAIN_SAFETY_RULE).toMatch(/generic-password/);
    expect(KEYCHAIN_SAFETY_RULE).toContain("ai.sparkle.desktop");
    expect(KEYCHAIN_SAFETY_RULE).toMatch(/NEVER/);
  });
});
