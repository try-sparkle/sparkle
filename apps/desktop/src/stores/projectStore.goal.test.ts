import { beforeEach, describe, expect, it } from "vitest";
import { migratePersisted, mergePreservingLiveWorkers, useProjectStore } from "./projectStore";
import { goalStateOf } from "../engine/agentGoal";
import { conciergeToolAuthority, isHumanAuthored } from "../services/dispatchAuthority";
import {
  MAX_CONTINUES_TOTAL,
  MAX_CONTINUES_WITHOUT_PROGRESS,
  decideContinuation,
} from "../engine/goalContinuation";
import type { AgentTab, Project } from "../types";

function mkAgent(): AgentTab {
  return {
    id: "a1", name: "A1", kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}

function seed() {
  const project: Project = {
    id: "p1", name: "P", rootPath: "/tmp/p", defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: null, agents: [mkAgent()],
  };
  useProjectStore.setState({ projects: [project] } as never);
}

/** The instant an escalation is stamped at in these tests. Explicit because the action REQUIRES
 *  the deciding instant — the sweep's judged `now`, never the wall clock; see projectStore. */
const ESC_AT = 1_700_000_000_000;

const agent = () => useProjectStore.getState().projects[0]!.agents[0]!;
const store = () => useProjectStore.getState();

/** Spend N auto-continues at an unchanged mark, as a stuck agent's runner would. */
function burn(n: number, mark = "stuck") {
  for (let i = 0; i < n; i++) store().noteAgentGoalContinue("p1", "a1", mark);
}

describe("setAgentGoal", () => {
  beforeEach(seed);

  it("sets a goal that reads as unmet", () => {
    store().setAgentGoal("p1", "a1", "Land the PR");
    expect(agent().goal?.text).toBe("Land the PR");
    expect(goalStateOf(agent().goal, Date.now())).toBe("unmet");
  });

  it("trims the text", () => {
    store().setAgentGoal("p1", "a1", "  Land the PR  ");
    expect(agent().goal?.text).toBe("Land the PR");
  });

  it("empty text DROPS the goal key entirely — the documented opt-out", () => {
    store().setAgentGoal("p1", "a1", "something");
    store().setAgentGoal("p1", "a1", "   ");
    expect(agent().goal).toBeUndefined();
    expect("goal" in agent()).toBe(false);
  });

  it("re-asserting the SAME text keeps the retry counters", () => {
    // A restarted agent re-asserts its objective routinely. Refilling the budget on that would
    // quietly defeat the escalation bound.
    store().setAgentGoal("p1", "a1", "same");
    burn(2);
    store().setAgentGoal("p1", "a1", "same");
    expect(agent().goal?.continues).toBe(2);
    expect(agent().goal?.totalContinues).toBe(2);
  });

  it("NEW text starts a fresh budget — it is different work", () => {
    store().setAgentGoal("p1", "a1", "first");
    burn(3);
    store().setAgentGoal("p1", "a1", "second");
    expect(agent().goal?.continues).toBe(0);
    expect(agent().goal?.totalContinues).toBe(0);
  });

  it("re-asserting the same text RE-ARMS a met goal", () => {
    // It used to preserve `metAt`, so an agent that met "keep the build green" and re-asserted it
    // for the next round kept the goal `met` forever and the row read "done" (roborev 55254).
    store().setAgentGoal("p1", "a1", "keep the build green");
    store().setAgentGoalMet("p1", "a1", true);
    expect(goalStateOf(agent().goal, Date.now())).toBe("met");

    store().setAgentGoal("p1", "a1", "keep the build green");
    expect(goalStateOf(agent().goal, Date.now())).toBe("unmet");
  });

  it("re-asserting the same text REVIVES an expired goal", () => {
    // `setAt` never moved before, so expiry recurred immediately and re-typing could never revive it.
    store().setAgentGoal("p1", "a1", "long job", 1);
    const expiredAt = Date.now() + 1_000;
    expect(goalStateOf(agent().goal, expiredAt)).toBe("expired");

    store().setAgentGoal("p1", "a1", "long job", 60_000);
    expect(goalStateOf(agent().goal, Date.now())).toBe("unmet");
  });

  it("re-asserting does NOT clear an escalation — that is the human's call", () => {
    store().setAgentGoal("p1", "a1", "hard");
    store().escalateAgentGoal("p1", "a1", "gave up", ESC_AT);
    store().setAgentGoal("p1", "a1", "hard");
    expect(goalStateOf(agent().goal, Date.now())).toBe("escalated");
  });
});

describe("the AGENT's own set is weaker than the human's", () => {
  beforeEach(seed);

  it("a self-set NEW goal cannot launder a spent retry budget", () => {
    // THE HOLE (roborev 55339). `set_agent_goal` is agent-reachable and free-tier, and only IDENTICAL
    // text preserved the counters — so a one-word paraphrase reached `newGoal()` and zeroed
    // `totalContinues`, making the ceiling `MAX_CONTINUES_TOTAL` documents as unreachable-by-the-agent
    // vacuous. Repeatable forever: continue to the ceiling, reword, twenty more.
    store().setAgentGoal("p1", "a1", "land the PR");
    burn(MAX_CONTINUES_TOTAL);
    store().setAgentGoal("p1", "a1", "land the pull request", undefined, "agent");
    expect(agent().goal?.text).toBe("land the pull request");
    expect(agent().goal?.totalContinues).toBe(MAX_CONTINUES_TOTAL);
    // The consecutive streak DOES reset — the work genuinely changed, and that counter answers "is
    // restarting getting anywhere", not "how much has this cost".
    expect(agent().goal?.continues).toBe(0);
  });

  it("a self-set NEW goal cannot cancel an escalation a human owns", () => {
    store().setAgentGoal("p1", "a1", "hard thing");
    store().escalateAgentGoal("p1", "a1", "three tries, no progress", ESC_AT);
    store().setAgentGoal("p1", "a1", "hard thing, take two", undefined, "agent");
    expect(goalStateOf(agent().goal, Date.now())).toBe("escalated");
    expect(agent().goal?.escalationReason).toBe("three tries, no progress");
  });

  it("...but a HUMAN setting new text does start clean — that is the point of the distinction", () => {
    store().setAgentGoal("p1", "a1", "hard thing");
    burn(4);
    store().escalateAgentGoal("p1", "a1", "gave up", ESC_AT);
    store().setAgentGoal("p1", "a1", "different work entirely");
    expect(agent().goal?.totalContinues).toBe(0);
    expect(goalStateOf(agent().goal, Date.now())).toBe("unmet");
  });

  it("nor can it launder the budget by CLEARING first — the debt outlives the record", () => {
    // THE HOLE (roborev 55451). The guard above only covered overwriting the text. Every bound in
    // goalContinuation is read off the goal record and nowhere else, so `set_agent_goal {goal: ""}`
    // deleted the debt outright — and the agent-facing skill doc teaches both halves of the sequence.
    // Two free-tier calls put the agent back in the pool with a full ceiling.
    store().setAgentGoal("p1", "a1", "land the PR");
    burn(MAX_CONTINUES_TOTAL);
    store().setAgentGoal("p1", "a1", "", undefined, "agent"); //  1. clear
    expect(agent().goal).toBeUndefined();
    store().setAgentGoal("p1", "a1", "land the PR", undefined, "agent"); //  2. set it again
    expect(agent().goal?.totalContinues).toBe(MAX_CONTINUES_TOTAL);
    // And the bound the counter exists for actually bites — asserting the SIDE EFFECT, not the field.
    expect(
      decideContinuation({
        goal: agent().goal,
        status: "idle",
        now: Date.now() + 60_000,
        idleSince: Date.now(),
        hasTurnEndAuthority: true,
        canAcceptInput: true,
        mark: "stuck",
        processAlive: true,
        runtime: "local",
        cloud: undefined,
      }).action,
    ).toBe("escalate");
  });

  it("clear-then-set cannot cancel an escalation either", () => {
    store().setAgentGoal("p1", "a1", "hard thing");
    store().escalateAgentGoal("p1", "a1", "three tries, no progress", ESC_AT);
    store().setAgentGoal("p1", "a1", "", undefined, "agent");
    store().setAgentGoal("p1", "a1", "hard thing", undefined, "agent");
    expect(goalStateOf(agent().goal, Date.now())).toBe("escalated");
    expect(agent().goal?.escalationReason).toBe("three tries, no progress");
  });

  it("a CLEAN goal cleared by the agent stashes nothing — the common path stays empty", () => {
    // Keeps this out of the persisted blob for the fleet's ordinary agents, and keeps a later
    // agent-set goal genuinely fresh rather than charged with a zero it never owed.
    store().setAgentGoal("p1", "a1", "quick thing");
    store().setAgentGoal("p1", "a1", "", undefined, "agent");
    expect(agent().goalDebt).toBeUndefined();
    expect("goalDebt" in agent()).toBe(false);
  });

  it("a HUMAN clearing the goal RELEASES the debt — their clear is a real opt-out", () => {
    store().setAgentGoal("p1", "a1", "land the PR");
    burn(MAX_CONTINUES_TOTAL);
    store().setAgentGoal("p1", "a1", ""); // human, no actor argument
    expect(agent().goalDebt).toBeUndefined();
    store().setAgentGoal("p1", "a1", "land the PR", undefined, "agent");
    expect(agent().goal?.totalContinues).toBe(0);
  });

  it("resetAgentGoalRetries releases a debt stashed with no goal present", () => {
    // The human's lever has to reach every place the debt is written, or it is partial: reset, then
    // let the agent set a goal, and the ceiling it just cleared comes straight back.
    store().setAgentGoal("p1", "a1", "land the PR");
    burn(MAX_CONTINUES_TOTAL);
    store().setAgentGoal("p1", "a1", "", undefined, "agent");
    expect(agent().goalDebt?.totalContinues).toBe(MAX_CONTINUES_TOTAL);
    store().resetAgentGoalRetries("p1", "a1"); // …with no goal on the agent at all
    expect(agent().goalDebt).toBeUndefined();
    store().setAgentGoal("p1", "a1", "land the PR", undefined, "agent");
    expect(agent().goal?.totalContinues).toBe(0);
  });

  it("A HUMAN TYPING releases the debt end-to-end — auto-continue works again", () => {
    // roborev 55525, the regression that closing the laundering hole created. `resetAgentGoalRetries`
    // had ZERO production callers and the only `setAgentGoal` caller always passes "agent", so both
    // documented releases were dead code: the first escalation pinned the agent at
    // `already-escalated` for the life of its persisted record, across restarts. The old exploit had
    // at least been an escape hatch. THE ASSERTION IS THE SIDE EFFECT — that `decideContinuation`
    // resumes — not that a field changed, because the field was never the thing that was broken.
    store().setAgentGoal("p1", "a1", "land the PR");
    burn(MAX_CONTINUES_TOTAL);
    store().escalateAgentGoal("p1", "a1", "gave up", ESC_AT);
    const ask = () =>
      decideContinuation({
        goal: agent().goal,
        status: "idle",
        now: Date.now() + 60_000,
        idleSince: Date.now(),
        hasTurnEndAuthority: true,
        canAcceptInput: true,
        mark: "stuck",
        processAlive: true,
        runtime: "local",
        cloud: undefined,
      });
    const before = ask();
    expect(before.action).toBe("none"); // latched: already escalated
    // Narrowed rather than cast — `reason` only exists on the non-continue arms, and asserting WHICH
    // refusal it is matters: "none" alone would also be satisfied by a fixture that simply failed one
    // of the gates, which would make the release assertion below prove nothing.
    if (before.action === "none") expect(before.reason).toBe("already-escalated");

    // The human types to the agent. This is the trigger `resetGoalRetries` always documented.
    store().appendPrompt("p1", "a1", "try it this way instead");

    expect(agent().goalDebt).toBeUndefined();
    expect(agent().goal?.totalContinues).toBe(0);
    expect(goalStateOf(agent().goal, Date.now())).toBe("unmet");
    expect(ask().action).toBe("continue");
  });

  it("…and so does a line typed straight into the terminal, even on an ALREADY-briefed agent", () => {
    // The write-once stamp must not swallow the release. A human unsticking an escalated agent has
    // almost certainly briefed it before, so bailing out on `terminalBriefedAt` alone would skip the
    // release on exactly the keystroke meant to perform it.
    store().setAgentGoal("p1", "a1", "land the PR");
    store().noteTerminalBrief("p1", "a1"); // briefed EARLIER — the stamp is already set
    const stampedAt = agent().terminalBriefedAt;
    expect(stampedAt).toEqual(expect.any(Number));
    burn(MAX_CONTINUES_TOTAL);
    store().escalateAgentGoal("p1", "a1", "gave up", ESC_AT);

    store().noteTerminalBrief("p1", "a1"); // …and types again, now to unstick it

    expect(agent().goal?.totalContinues).toBe(0);
    expect(goalStateOf(agent().goal, Date.now())).toBe("unmet");
    // The stamp itself stays write-once — it answers "was this EVER briefed", not "when last".
    expect(agent().terminalBriefedAt).toBe(stampedAt);
  });

  it("a MACHINE-authored send must not release it — that bound is the whole feature", () => {
    // roborev 55588. My first version of this test called noteAgentGoalContinue N times and asserted
    // the counter went up and goalDebt was undefined — both TRUE BEFORE the change, neither touching
    // appendPrompt or the authorship gate. It could not have gone red if the gate were removed, which
    // is the exact vacuous-assertion failure it was written to prevent.
    //
    // The seam that carries the bound is `appendPrompt`'s `humanAuthored` flag, which
    // conciergeDispatch derives from `dispatchAuthority.isHumanAuthored`. `send_to_agent_terminal`
    // dispatches with `userPrompt: true` for prose the concierge LLM composed, so keying the release
    // on `userPrompt` let a MACHINE clear the escalation latch whose entire purpose is to hand the
    // agent to a human — and that op is `disruptive`, so under a policy allowing disruptive writes it
    // happened unattended, refilling the ceiling indefinitely.
    store().setAgentGoal("p1", "a1", "land the PR");
    burn(MAX_CONTINUES_TOTAL);
    store().escalateAgentGoal("p1", "a1", "gave up", ESC_AT);

    // Machine-authored: the concierge's own tool layer writing prose it composed.
    store().appendPrompt("p1", "a1", "continue", "composer", false);

    expect(goalStateOf(agent().goal, Date.now())).toBe("escalated");
    expect(agent().goal?.totalContinues).toBe(MAX_CONTINUES_TOTAL);
    expect(
      decideContinuation({
        goal: agent().goal, status: "idle", now: Date.now() + 60_000, idleSince: Date.now(),
        hasTurnEndAuthority: true, canAcceptInput: true, mark: "stuck", processAlive: true,
        runtime: "local", cloud: undefined,
      }).action,
    ).toBe("none");

    // …and the SIBLING case: the same call, human-authored, DOES release. Without this the test above
    // would pass against a release that never fires for anyone.
    store().appendPrompt("p1", "a1", "try it this way instead", "composer", true);
    expect(goalStateOf(agent().goal, Date.now())).toBe("unmet");
    expect(agent().goal?.totalContinues).toBe(0);
  });

  it("isHumanAuthored draws the line the union already documents", () => {
    // A Record over every authority kind, so ADDING an arm fails to compile until someone decides
    // which side it is on — the default-by-omission is what went wrong the first time.
    expect(isHumanAuthored({ kind: "suggestion", agentId: "a1" })).toBe(true);
    expect(isHumanAuthored({ kind: "nudge-approve", agentId: "a1" })).toBe(true);
    expect(isHumanAuthored({ kind: "countdown", intentId: "i1" })).toBe(true);
    // The two machine arms. The union's own docstring says it: "An AI tool call is NOT a user gesture".
    expect(isHumanAuthored({ kind: "goal-continue", agentId: "a1" })).toBe(false);
    const tool = conciergeToolAuthority("call-1", { tier: "allow" });
    expect(tool).not.toBeNull();
    if (tool) expect(isHumanAuthored(tool)).toBe(false);
  });

  it("a nothing-owed agent is left REFERENCE-IDENTICAL, so a typed line does not churn the blob", () => {
    // roborev 55588. `releaseGoalDebt`'s fast path asked only whether a goal EXISTED, but
    // `resetGoalRetries` always allocates — so every goal-bearing agent got a fresh object, which made
    // `noteTerminalBrief`'s write-once bail never fire: one persisted-blob write, cross-window
    // broadcast and fleet re-render PER SUBMITTED LINE, for exactly the agents being actively driven.
    store().setAgentGoal("p1", "a1", "land the PR"); // clean goal: nothing owed
    store().noteTerminalBrief("p1", "a1"); // stamp it
    const before = useProjectStore.getState().projects;
    store().noteTerminalBrief("p1", "a1"); // …and type again
    expect(useProjectStore.getState().projects).toBe(before);
  });

  it("a stash holding ONLY a check is also nothing-owed, so it does not churn the blob either", () => {
    // The verify-only stash is a NEW way into the 55588 regression above, and that test cannot see
    // it: it seeds a clean goal with no stash at all, so it passes identically whether or not
    // `debtOwesNothing` accounts for a debt whose entire content is a check. Once a check survives a
    // human release (which is the point of carrying it), an agent that cleared a verified goal holds
    // `{ totalContinues: 0, verify }` forever — and every subsequent typed line would rewrite the
    // agent, the persisted blob, the cross-window broadcast and the fleet render (roborev 55960).
    store().setAgentGoal("p1", "a1", "the work is on origin main", undefined, "agent", { kind: "landed" });
    store().setAgentGoal("p1", "a1", "", undefined, "agent"); // the agent clears; the check is stashed
    // `verifyStated` rides along with the check: the stash must remember that a CALLER chose this
    // one, or a clear-then-set would launder a stated check into a machine-defaulted one and shed
    // the stickiness the debt exists to carry (roborev 57806).
    expect(agent().goalDebt).toEqual({
      totalContinues: 0,
      verify: { kind: "landed" },
      verifyStated: true,
    });
    store().noteTerminalBrief("p1", "a1"); // the human types
    const before = useProjectStore.getState().projects;
    store().noteTerminalBrief("p1", "a1"); // …and types again
    expect(useProjectStore.getState().projects).toBe(before);
    // And the check is still there — the fast path must not be bought by dropping it.
    expect(agent().goalDebt?.verify).toEqual({ kind: "landed" });
  });

  it("the debt cannot be diluted by repeated clear/set cycles", () => {
    // `chargeGoalDebt` takes the MAX, so the bound can only ever tighten. Without that, a cycle that
    // spends one continue and re-clears could walk the stored total DOWN.
    store().setAgentGoal("p1", "a1", "land the PR");
    burn(MAX_CONTINUES_TOTAL);
    for (let i = 0; i < 3; i++) {
      store().setAgentGoal("p1", "a1", "", undefined, "agent");
      store().setAgentGoal("p1", "a1", `attempt ${i}`, undefined, "agent");
    }
    expect(agent().goal?.totalContinues).toBe(MAX_CONTINUES_TOTAL);
  });
});

describe("setAgentGoalMet", () => {
  beforeEach(seed);

  it("marks the goal met, which is what stops auto-continue", () => {
    store().setAgentGoal("p1", "a1", "ship it");
    store().setAgentGoalMet("p1", "a1", true);
    expect(goalStateOf(agent().goal, Date.now())).toBe("met");
  });

  it("un-marking does NOT refill the total budget", () => {
    // THE HOLE THIS CLOSES (roborev 55254). This is the AGENT's own surface, so the actor holding
    // the lever is exactly the one MAX_CONTINUES_TOTAL defends the fleet against: mark met, un-mark,
    // and the twenty-restart ceiling resets — repeatable forever.
    store().setAgentGoal("p1", "a1", "g");
    burn(5);
    store().setAgentGoalMet("p1", "a1", true);
    store().setAgentGoalMet("p1", "a1", false);
    expect(agent().goal?.totalContinues).toBe(5);
    // The consecutive streak DOES clear — the agent is going back to work.
    expect(agent().goal?.continues).toBe(0);
  });

  it("un-marking does NOT un-latch an escalation", () => {
    // Otherwise an agent could take back a goal a human had already been handed.
    store().setAgentGoal("p1", "a1", "g");
    store().escalateAgentGoal("p1", "a1", "gave up", ESC_AT);
    store().setAgentGoalMet("p1", "a1", true);
    store().setAgentGoalMet("p1", "a1", false);
    expect(goalStateOf(agent().goal, Date.now())).toBe("escalated");
  });

  it("un-marking a goal that was never met is a no-op, not a budget reset", () => {
    store().setAgentGoal("p1", "a1", "g");
    burn(3);
    store().setAgentGoalMet("p1", "a1", false);
    expect(agent().goal?.continues).toBe(3);
    expect(agent().goal?.totalContinues).toBe(3);
  });
});

describe("escalation and the human's reset", () => {
  beforeEach(seed);

  it("escalate latches, keeping the first reason", () => {
    store().setAgentGoal("p1", "a1", "g");
    store().escalateAgentGoal("p1", "a1", "first reason", ESC_AT);
    store().escalateAgentGoal("p1", "a1", "second reason", ESC_AT);
    expect(agent().goal?.escalationReason).toBe("first reason");
  });

  it("resetAgentGoalRetries — the HUMAN's lever — clears everything and re-enables continues", () => {
    store().setAgentGoal("p1", "a1", "g");
    burn(MAX_CONTINUES_WITHOUT_PROGRESS);
    store().escalateAgentGoal("p1", "a1", "gave up", ESC_AT);
    store().resetAgentGoalRetries("p1", "a1");

    expect(agent().goal?.continues).toBe(0);
    expect(agent().goal?.totalContinues).toBe(0);
    expect(goalStateOf(agent().goal, Date.now())).toBe("unmet");
    // And the agent is genuinely eligible again — asserting the side effect, not just the fields.
    const d = decideContinuation({
      goal: agent().goal,
      status: "idle",
      now: Date.now() + 60_000,
      idleSince: Date.now(),
      hasTurnEndAuthority: true,
      canAcceptInput: true,
      mark: "stuck",
      // `idle` witnesses its own liveness, but the field is required-but-nullable so a caller has to
      // say what it knows — CI caught this exact omission here, which is the gate working.
      processAlive: undefined,
      runtime: "local",
      cloud: undefined,
    });
    expect(d.action).toBe("continue");
  });

  it("the three counter actions no-op on an agent with no goal", () => {
    store().noteAgentGoalContinue("p1", "a1", "m");
    store().escalateAgentGoal("p1", "a1", "why", ESC_AT);
    store().setAgentGoalMet("p1", "a1", true);
    expect(agent().goal).toBeUndefined();
  });
});

describe("persistence", () => {
  beforeEach(seed);

  it("the goal survives the real rehydrate path — serialize, migrate, merge", () => {
    // The claim the original commit message rested on and never verified (roborev 55254), and the
    // one that matters most: a relaunch is itself a common way a turn ends with work remaining, so
    // a goal that did not survive one would disable auto-continue exactly when it is needed.
    //
    // This drives the store's OWN rehydrate functions rather than a hand-built object. The store
    // has no `partialize`, so the JSON round-trip is the whole of the serialization step — which is
    // the real risk here, since a field holding anything non-JSON (a Date, a Map) would be silently
    // mangled by it.
    store().setAgentGoal("p1", "a1", "survive the relaunch", 60_000);
    burn(2);

    const onDisk = JSON.parse(JSON.stringify({ projects: useProjectStore.getState().projects }));
    const migrated = migratePersisted(onDisk, 12) as { projects: Project[] };
    // ...and through the cross-window merge, against a live store that has the same agent.
    const merged = mergePreservingLiveWorkers(migrated, useProjectStore.getState());

    const revived = merged.projects[0]!.agents.find((a) => a.id === "a1")!;
    expect(revived.goal?.text).toBe("survive the relaunch");
    expect(revived.goal?.totalContinues).toBe(2);
    expect(goalStateOf(revived.goal, Date.now())).toBe("unmet");
  });
});

describe("the three expiry actions stamp the DECIDING instant, not the wall clock", () => {
  // ⚠️ THE VALUE, NOT THE PRESENCE, and each action separately. The sweep decides against an injected
  // `now` while these actions used to stamp `Date.now()`, and `rearmedAt` is the deadline ORIGIN — so
  // the two clocks could disagree and no test would notice, which is AGENTS.md's "control only one of
  // two coupled clocks". A `toBeDefined()` assertion cannot catch a dropped `now`: the `?? Date.now()`
  // fallback supplies a perfectly plausible number. Asserting equality is what makes the seam real.
  //
  // Covered HERE rather than only through the sweep because the mount cannot reach a discharge at all
  // (`BranchStatus` carries no shas, so `decideExpiry` always answers `proof-unauditable`) — so
  // without this the discharge call site's `now` had no coverage anywhere.
  const T = 1_700_000_000_000;
  beforeEach(seed);

  it("rearmAgentGoal", () => {
    store().setAgentGoal("p1", "a1", "land it");
    store().rearmAgentGoal("p1", "a1", 60_000, T);
    expect(agent().goal!.rearmedAt).toBe(T);
  });

  it("dischargeAgentGoal", () => {
    store().setAgentGoal("p1", "a1", "land it");
    store().dischargeAgentGoal("p1", "a1", "a1b2c3d", "d4e5f6a", T);
    expect(agent().goal!.dischargedAt).toBe(T);
    expect(agent().goal!.dischargedSha).toBe("a1b2c3d");
    expect(agent().goal!.dischargedBaseSha).toBe("d4e5f6a");
  });

  it("abandonAgentGoal", () => {
    store().setAgentGoal("p1", "a1", "land it");
    store().abandonAgentGoal("p1", "a1", "3 commits, none on origin/main", T);
    expect(agent().goal!.abandonedAt).toBe(T);
    // It rides on the escalation, so that stamp takes the same instant.
    expect(agent().goal!.escalatedAt).toBe(T);
  });

  // ⚠️ A FALLBACK CASE WAS DELETED HERE, and the reason is worth more than the case was. It pinned the
  // `?? Date.now()` arm and justified itself with "resetGoalRetries and any future non-sweep caller
  // has no instant of its own" — which is false in both halves: `resetGoalRetries` routes through
  // `releaseGoalDebt` and never touches these actions, and all three production call sites pass
  // `now`. So the arm had no caller, and the test pinned an unreachable branch behind a claim a
  // future reader would take at face value. The parameter is REQUIRED now, which deletes the branch
  // rather than testing it.
});
