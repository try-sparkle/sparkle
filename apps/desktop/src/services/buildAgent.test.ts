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

  it("teaches BOTH ends of set_agent_goal — set one, and mark it met", () => {
    // The exit from auto-continue only works if the agent knows the tool exists BEFORE it is
    // resumed. `engine/goalContinuation.continuePrompt` names it in the resume text, but an agent
    // that never set a goal is never resumed in the first place — so the persona has to carry the
    // "set one when you start" half too, or the whole mechanism stays dormant. And an agent that
    // sets a goal and never marks it met is worse off than one with no goal at all: it gets
    // restarted after finishing until the ceiling escalates a false alarm.
    const p = sparkleControlProtocol();
    // BOTH OPS BY NAME. This claimed to test "both ends" while asserting only /set_agent_goal/ and
    // /met: true/ — a substring the wrong copy satisfies too (`set_agent_goal({ met: true })`, the
    // pre-split form), so it proved neither end and let the stale briefing ship (roborev 55549).
    expect(p).toMatch(/set_agent_goal\(\{ goal \}\)/);
    expect(p).toMatch(/set_agent_goal_met\(\{ met: true \}\)/);
    // The dead form must be gone: `set_agent_goal({ met: ... })` names an op signature that no
    // longer exists, and this is the one call that stops an agent being auto-resumed.
    expect(p).not.toMatch(/set_agent_goal\(\{ met/);
    expect(p).toMatch(/resumed automatically/);
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

    it("accepts SEVERITY 4 — a blocker must not cost the worker its whole result.json", () => {
      // This validator said 1-3 while the JSON Schema, the marker parser, the persona and both
      // bead-capture paths all say 1-4. A malformed retro throws for the WHOLE file, so a worker
      // that reported a full blocker lost its status, summary and filesChanged along with it —
      // the worst finding being the one guaranteed to be discarded.
      const r = parseWorkerResult(
        withRetro({ tldr: "t", painPoints: [{ summary: "s", severity: 4, recommendation: "r" }] }),
      );
      expect(r.retro?.painPoints[0]?.severity).toBe(4);
      expect(r.status).toBe("success");
    });

    it("throws on a severity outside 1-4", () => {
      for (const severity of [0, 5]) {
        const bad = withRetro({ tldr: "t", painPoints: [{ summary: "s", severity, recommendation: "r" }] });
        expect(() => parseWorkerResult(bad)).toThrow(/severity/);
      }
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
      "**PAIN POINT [<bead id>]:**",
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

  it("tells the agent to FILE each pain point as a bead and print the id in the heading", () => {
    // The hole this closes (bead sparkle-w4fjz): the merge-capture hook fires only on
    // `gh pr merge`, so an agent that never opens a PR loses its whole retro when the pane
    // scrolls. The instruction has to name the real script — a persona that says "file a bead"
    // without the command is one an agent satisfies by running `bd create` by hand, which
    // produces exactly the un-deduped duplicate the shared fbkey exists to prevent.
    expect(r).toContain("scripts/file-retro-pain-point.sh");
    expect(r).toMatch(/--summary/);
    expect(r).toMatch(/--severity/);
    expect(r).toMatch(/--recommendation/);
    // BEFORE the retro is printed, not after — filing at merge time is what already failed.
    expect(r).toMatch(/BEFORE you print the retro/);
    // The id goes in the heading, and the decline token is printable too, so a reader can tell
    // "this is in the backlog" from "this is only on screen".
    expect(r).toContain("**PAIN POINT [sparkle-xxxx]:**");
    expect(r).toMatch(/unfiled:/);
    // Hand-filing is the failure mode to forbid explicitly.
    expect(r).toMatch(/[Nn]ever `bd create` a pain point by hand/);
    // Re-running must be advertised as safe, or an agent that is unsure will skip filing.
    expect(r).toMatch(/IDEMPOTENT/);
  });

  it("asks for severity-1 findings instead of telling agents to drop them", () => {
    // The capture floor moved from SEV2 to SEV1 (scripts/lib/retro-beads.sh). The persona and
    // the filing script have to agree: a persona that still said "only file 2+" would silently
    // re-open the hole for the class of finding the founder specifically kept.
    expect(r).toMatch(/SEVERITY 1 points too/);
    expect(r).not.toMatch(/severity 1.*(?:skip|omit|drop|not worth filing)/i);
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
  /** The fixture's cap, referenced by the guards below instead of a literal. Hardcoding `4` couples
   *  a guard to this fixture, so changing it here would silently stop the guard from guarding
   *  (roborev 56186). */
  const CAP = 4;
  const p = orchestrationPersona({ ownBranch: "sparkle/agent-build1", maxConcurrentWorkers: CAP });

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

  it("describes the cap as SHARED machine-wide, never as this agent's own allowance", () => {
    // roborev 56166, Medium. `[workers].max_concurrent` is machine-wide (bead `sparkle-axtkw`), and
    // AgentPane hands EVERY orchestrator the same number. While this persona said "workers YOU have
    // spawned" and "spawn UP TO N per batch", two orchestrators were each told to fan out to N
    // against a gate that admits N in TOTAL — and the persona's own next paragraph makes that
    // expensive rather than cosmetic: an over-cap spawn "BLOCKS your REPL … deadlocks until it times
    // out (~600s)". The second orchestrator stalled ten minutes by following its brief correctly.
    //
    // This asserts the SHARED framing, which is the part that changes behavior — not merely that the
    // number appears (the test above already covers that, and would pass on the old per-agent copy).
    expect(p).toMatch(/shared/i);
    expect(p).toMatch(/on this machine/i);
    // The specific claim that misled: workers counted as the agent's own.
    expect(p).not.toMatch(/workers you have spawned but not yet spun down/i);
    // And it must say the ceiling may not all be available, so the agent doesn't plan for all of it.
    expect(p).toMatch(/may not have all of|fewer are available/i);
  });

  /** The ONE bullet, sliced to its own text — from `marker` up to the next top-level `- ` bullet.
   *  A slice that runs to the END of the persona is not a guard: a positive assertion on it can be
   *  satisfied by any later section that happens to use the same words, which made an earlier
   *  version of these tests non-vacuous only by luck (roborev 56178). */
  const bullet = (marker: string): string => {
    const start = p.indexOf(marker);
    expect(start, `persona no longer contains "${marker}"`).toBeGreaterThan(-1);
    const end = p.indexOf("\n- ", start + marker.length);
    return end === -1 ? p.slice(start) : p.slice(start, end);
  };

  it("states the capacity rule on the spawn REPLY, the only signal the model receives", () => {
    // roborev 56170 → 56178, two laps on the same bullet. Attempt 1 said "let a blocked spawn tell
    // you the real number" — the remedy WAS the ~600s deadlock the same bullet warns about. Attempt
    // 2 said "keep going while each call RETURNS PROMPTLY", which is (a) the same prohibited probe
    // reworded and (b) not observable: `SpawnReply` in apps/mcp-orchestrator/src/tools.ts is
    // `{workerId?, branch?, worktree?, error?}` — no elapsed time, no queued flag — so the model
    // cannot measure promptness at all. It just LOOKED evaluable, which is worse.
    //
    // The rule must therefore hang off `error`, which is the one field that reaches the model.
    const rule = bullet("- THE RULE");
    expect(rule).toMatch(/error/i);
    // The consequence that makes it actionable: the unit did NOT start, so it is still to do.
    expect(rule).toMatch(/not\s+started|still\s+unclaimed/i);
    // And it must NOT reintroduce a latency-based judgement, in any phrasing.
    expect(rule).not.toMatch(/promptly|straight back|how long|elapsed|quickly|immediately returns/i);
  });

  it("tells the orchestrator a spawned worker is UNREACHABLE, and what the two real moves are", () => {
    // Beads sparkle-o6wmb / sparkle-1rknx, filed independently from two different runs: an
    // orchestrator discovered a corrected contract minutes after fanning out, reached for a
    // messaging tool, and got back only that no such agent is reachable. The persona said nothing
    // about this, so both agents learned it by losing the batch — one of them by hand-reconciling
    // superseded work, including a live work-loss path.
    //
    // Assert the CONSEQUENCE the orchestrator has to act on (the contract is frozen; here are the
    // two moves), not merely that the word "worker" appears — the persona is full of those.
    const b = bullet("- The `task` string you pass to `spawn_worker`");
    expect(b).toMatch(/frozen/i);
    expect(b).toMatch(/no inbox|cannot reach|unreachable|no such agent is reachable/i);
    // The actionable half: a post-spawn correction is never delivered, so don't wait for it to be.
    expect(b).toMatch(/never\s+be\s+delivered/i);

    // The remedy bullet must offer BOTH moves — a persona that named only "spin it down and
    // respawn" would instruct the agent to DELETE a worktree holding uncommitted work, which is the
    // unsafe half of the pair (AGENTS.md: a remedy string is an instruction, audit it as code).
    const moves = bullet("- When a contract does change mid-flight");
    expect(moves).toMatch(/spin_down_worker/);
    expect(moves).toMatch(/DELETES the worktree/i);
    expect(moves).toMatch(/not\s+committed/i);
    expect(moves).toMatch(/let it finish|reconcile at merge/i);
    // And it must not tell the agent to sit and wait for a message it can never receive.
    expect(moves).not.toMatch(/send (it |the worker )?a (message|correction)/i);
  });

  it("distinguishes a CAPACITY error from every other spawn failure (roborev 56186)", () => {
    // Two defects in one line, both High/Medium. The copy said "An ERROR or timeout → the machine
    // was FULL and THAT UNIT WAS NOT STARTED … re-spawn exactly that unit":
    //
    //  (a) FALSE for a timeout, and the duplicate-worker hazard. An over-cap request sits in
    //      `spawnQueue`; the MCP client gave up at its own 660s socket timeout, but nothing dropped
    //      the entry, so `drainQueue` created the worker minutes later. Re-spawning then produced a
    //      SECOND worktree + branch on the same unit — un-deduplicated for an ad-hoc (no-bead)
    //      spawn. Fixed in orchestrationListener by expiring the queued entry UNDER the client
    //      timeout, so the caller gets a real error and "did not start" is now true.
    //  (b) It treated EVERY error as capacity. A refused goal, an already-claimed bead or a failed
    //      worktree cut are not capacity, and "do not spawn anything else until a spin_down of yours
    //      frees a slot" deadlocks on the first unit — there is nothing live to spin down.
    const rule = bullet("- THE RULE");
    // Capacity is named by the signal that actually indicates it, not by "any error".
    expect(rule).toMatch(/timed\s+out\s+waiting\s+for\s+a\s+free\s+slot/i);
    // BOTH capacity strings. roborev 56200: naming only the desktop-side expiry reply left the MCP
    // client's own socket timeout (`bridge request timeout: spawn_worker`, bridgeClient.ts) falling
    // into the "any other error → carry on" branch — so the orchestrator would DROP a unit that never
    // started and keep firing spawns into a machine still at cap, each stalling ~10 minutes.
    expect(rule).toMatch(/bridge\s+request\s+timeout/i);
    // ...and the general instruction, so a third timeout phrasing is covered too.
    expect(rule).toMatch(/any\s+TIMEOUT\s+as\s+capacity|treat\s+any\s+timeout/i);
  });

  it("does not claim a SOCKET timeout proves the unit never started (roborev 56222)", () => {
    // Collapsing both timeout strings into one "was NOT started, re-spawn it" branch was right about
    // capacity and wrong about certainty. The desktop-side expiry reply proves the entry never
    // reached `runSpawn`. A bare `bridge request timeout` proves nothing about what the app did: the
    // expiry fires at SPAWN_QUEUE_MAX_WAIT_MS while the socket dies at the bridge's own bound, so a
    // request drained near its deadline can still be inside `spawnWorker` (worktree cut + record +
    // open) when the socket goes. `handleSpawn` de-duplicates only when a `beadId` is present, so for
    // an ad-hoc spawn "re-spawn exactly that unit" yields a second worktree + branch on the same
    // work — the duplicate-agent failure this whole area exists to prevent.
    const rule = bullet("- THE RULE");
    // The uncertainty must be stated, and tied to the check that resolves it.
    expect(rule).toMatch(/unknown/i);
    expect(rule).toMatch(/list_workers/);
    // Only the PROVABLE case may carry the certainty language.
    const provable = rule.slice(0, rule.search(/bare `bridge request/i));
    expect(provable).toMatch(/provably did not start|did not start/i);
    // ...and the ambiguous case must not be told to re-spawn without checking first.
    const ambiguous = rule.slice(rule.search(/bare `bridge request/i));
    expect(ambiguous).toMatch(/only if|do NOT re-spawn it blind|blind/i);
    // Non-capacity failures get their own branch that says CARRY ON.
    expect(rule).toMatch(/any\s+other\s+error/i);
    expect(rule).toMatch(/carry\s+on|continue\s+with\s+the\s+rest|rest\s+of\s+the\s+batch/i);
    // And the blanket conflation must be gone.
    expect(rule).not.toMatch(/an error or timeout\s*→\s*the machine was full/i);
  });

  it("does not both forbid and prescribe discovering the cap by spawning (roborev 56178)", () => {
    // Attempt 2 carried a prohibition ("do NOT try to discover it by spawning until one blocks") and
    // its own violation ("keep going while each call returns promptly") in the SAME bullet. An LLM
    // reading both literally gets contradictory instructions. Only one prohibition may govern.
    const shared = bullet("- The concurrency cap is");
    const rule = bullet("- THE RULE");
    const both = `${shared}\n${rule}`;
    expect(both).not.toMatch(/do not try to discover|don't try to discover/i);
    // The honest framing survives instead: you cannot compute your share up front.
    expect(both).toMatch(/cannot compute|cannot avoid it by calculation|assume less is available/i);
  });

  it("its remedy for the shared cap is not the 600s deadlock it warns about (roborev 56170)", () => {
    // AGENTS.md: "a refusal or remedy message that says 'do X instead' is an INSTRUCTION the user
    // will follow — so it needs the same safety analysis as the code path it replaces." The first
    // attempt at the shared-cap copy told the agent to "let a blocked spawn tell you the real
    // number" — i.e. to discover its allowance by triggering the exact ~600s REPL deadlock the same
    // bullet exists to prevent. It relocated the stall instead of removing it.
    //
    // It also conditioned batch size on "when you are the sole orchestrator", a fact the persona had
    // just declared UNOBSERVABLE two lines earlier (`list_workers` shows only your own workers, and
    // no MCP op reports the machine-wide count). A decision rule the agent cannot evaluate is not a
    // rule. Both are asserted here because both are copy an LLM acts on literally.
    expect(p).not.toMatch(/let a blocked spawn tell you/i);
    // A PROPERTY, not a phrase ban (roborev 56178): the earlier `not.toMatch(/sole orchestrator/i)`
    // was already evaded by this file's own "no other orchestrator is running", so a rewrite saying
    // "when you are the only orchestrator running, spawn up to 4 per batch" would have passed it.
    // What must not exist is batch SIZING conditioned on being alone — which the agent cannot check.
    expect(p).not.toMatch(
      /(sole|only) orchestrator[^.]*\b(spawn|fan out|batch|up to)\b|\b(spawn|fan out|up to)\b[^.]*\b(sole|only) orchestrator/i,
    );
    expect(p).toMatch(/one at a time/i);
  });

  it("the batch RECIPE step (1) itself carries the shared-cap qualifier", () => {
    // roborev 56170 found step (1) still reading "spawn up to the cap"; roborev 56178 then found the
    // GUARD too weak in two ways, both fixed here:
    //   - the slice ran to the END of the persona, so the positive assertion could be satisfied by
    //     any later section using the same words (non-vacuous only by luck);
    //   - the negative banned one exact string, so "(1) spawn 4 workers" / "(1) fill the cap" would
    //     reintroduce the unqualified imperative and still pass.
    const recipe = bullet("- Batch workflow:");
    const step1 = recipe.slice(0, recipe.search(/\(2\)/) === -1 ? undefined : recipe.search(/\(2\)/));
    // The property: step (1) must carry a qualifier...
    expect(step1).toMatch(/shared|one at a time|do not assume|stopping on a capacity error/i);
    // ...and must not tell the agent to spawn a QUANTITY, however that is phrased. roborev 56186:
    // the previous pair of bans was still phrase-shaped — `(1) spawn up to 4 workers, one worker at
    // a time` passed all three assertions, because "up to " separated `spawn` from the number, the
    // word "cap" was absent, and the positive was satisfied by the trailing qualifier. So ban a bare
    // `spawn`/`fill`/`start` followed by EITHER the cap word or a number, with words allowed in
    // between.
    expect(step1).not.toMatch(/\b(spawn|fill|start)\b[^.]{0,40}\b(cap|\d+)\b/i);
    // And use the INTERPOLATED cap, not a literal 4: hardcoding the fixture's number means this
    // silently stops guarding the moment that fixture changes (roborev 56186).
    const cap = String(CAP);
    expect(step1).not.toMatch(new RegExp(String.raw`\bspawn\b[^.]{0,40}\b${cap}\b`, "i"));
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
