import { describe, expect, it } from "vitest";
import { withFinishedHeadCalm, isFinishedHeadCalmed } from "./finishedHeadCalm";
import { bandOfStatus } from "./buildSections";
import { stallReport } from "./agentStall";
import { markGoalMet, newGoal } from "./agentGoal";
import { AGENT_STATUS } from "@sparkle/ui";
import type { StatusMap } from "./attention";
import type { AgentTabStatus } from "../types";

// CASE 1 of bead sparkle-hpbkw — agent 6dc70c58 ("Preview Work In A Browser"). It read `idle`,
// needsYou FALSE, goal `met`, stall verdict `finished` ("genuinely done"), and the sidebar painted
// it red anyway, because the dot reads an overlay chain that `getAgentStatus` cannot see.
const agents = (...ids: string[]) => ids.map((id) => ({ id }));
const NOW = 1_700_000_000_000;

/** Every agent finished. */
const allFinished = () => true;
/** Nothing read — the honest answer for a row nobody polled. */
const unread = () => undefined;

describe("a finished head stops inheriting its worker's alarm", () => {
  it("demotes the measured case — idle head, finished, wearing a bubbled `approval`", () => {
    // THE SHAPE THE FOUNDER MEASURED. The head's OWN status is `idle` — which is why
    // `getAgentStatus` truthfully answered needsYou:false — while the published map carries the red
    // that `withUnstartedWorkerAttention` painted onto it from a stranded worker.
    const own: StatusMap = { head: "idle", worker: "approval" };
    const published: StatusMap = { head: "approval", worker: "approval" };
    const out = withFinishedHeadCalm(agents("head", "worker"), published, own, allFinished);

    expect(out.head).toBe("lapsed");
    // Asserted on the BAND, because the band is what decides whether he is told about it.
    expect(bandOfStatus(out.head!)).not.toBe("needs_you");
  });

  it("LEAVES THE WORKER'S OWN RED ALONE — the ask is un-inherited, never hidden", () => {
    // The safety property. The worker still carries its own red on its own row, and
    // workerExpansion's peek line still names it under the folded head.
    const own: StatusMap = { head: "idle", worker: "waiting" };
    const published: StatusMap = { head: "waiting", worker: "waiting" };
    // NOTE the worker is reported finished too, to prove the demotion is gated on the ask being
    // INHERITED rather than on the finished flag alone — the worker's red IS its own, so it stays.
    const out = withFinishedHeadCalm(agents("head", "worker"), published, own, allFinished);

    expect(out.worker).toBe("waiting");
    expect(bandOfStatus(out.worker!)).toBe("needs_you");
    expect(bandOfStatus(out.head!)).not.toBe("needs_you");
  });

  it("REFUSES on a head asking on its own behalf — every ask status, by name", () => {
    for (const s of ["waiting", "approval", "errored", "questions"] as const) {
      const out = withFinishedHeadCalm(agents("a"), { a: s }, { a: s }, allFinished);
      expect(out.a, `${s} is the head's OWN ask and must survive`).toBe(s);
    }
  });

  it("REFUSES without positive evidence — unread and not-finished both keep the red", () => {
    // The evidence-not-inference rule, in the direction that is easy to get wrong. Making a row
    // calm on missing data is the mirror of making it red on missing data, and both cost the
    // colour its meaning.
    const own: StatusMap = { head: "idle" };
    const published: StatusMap = { head: "approval" };
    expect(withFinishedHeadCalm(agents("head"), published, own, unread).head).toBe("approval");
    expect(withFinishedHeadCalm(agents("head"), published, own, () => false).head).toBe("approval");
  });

  it("does not touch a row that was never in the ask band", () => {
    for (const s of ["working", "idle", "unmerged", "lapsed", "done", "new"] as const) {
      expect(withFinishedHeadCalm(agents("a"), { a: s }, { a: "idle" }, allFinished).a).toBe(s);
    }
  });

  it("returns the SAME reference when nothing changes — no render churn", () => {
    const published: StatusMap = { a: "working", b: "waiting" };
    expect(withFinishedHeadCalm(agents("a", "b"), published, published, allFinished)).toBe(
      published,
    );
  });

  it("never invents a status for an agent it was given nothing about", () => {
    expect(withFinishedHeadCalm(agents("ghost"), {}, {}, allFinished).ghost).toBeUndefined();
  });
});

describe("the gate is driven by the REAL stall engine, not a hand-set boolean", () => {
  // The `finished` flag is only trustworthy if it comes from the engine that actually reads git.
  // Hand-passing `true` everywhere else in this file proves the TRANSFORM; this proves the INPUT is
  // reachable — that `stallReport` really does answer `finished` for the state the founder measured,
  // so the wiring is not gated on a verdict that never occurs in practice.
  const finishedInput = {
    status: "idle" as AgentTabStatus,
    now: NOW,
    goal: markGoalMet(newGoal("preview the work in a browser", NOW), NOW),
    hasOpenPr: false,
    hasUnlandedWork: false,
    hasUncommittedChanges: false,
  };

  it("stallReport calls the measured state `finished`", () => {
    expect(stallReport(finishedInput).verdict).toBe("finished");
  });

  it("and that verdict, fed in, demotes the row", () => {
    const isFinished = (id: string) =>
      id === "head" ? stallReport(finishedInput).verdict === "finished" : undefined;
    const out = withFinishedHeadCalm(
      agents("head"),
      { head: "approval" },
      { head: "idle" },
      isFinished,
    );
    expect(out.head).toBe("lapsed");
  });

  it("an UNREAD row answers `unknown`, and unknown demotes nothing", () => {
    // The paired negative: same call, git state absent. `agentStall` returns `unknown`, which is
    // not `finished`, so the red stands. Without this the test above would also pass for a gate
    // that treated "not stalled" as "finished".
    const unreadInput = { ...finishedInput, hasOpenPr: undefined, hasUnlandedWork: undefined, hasUncommittedChanges: undefined };
    expect(stallReport(unreadInput).verdict).not.toBe("finished");
    const isFinished = () => stallReport(unreadInput).verdict === "finished";
    expect(
      withFinishedHeadCalm(agents("head"), { head: "approval" }, { head: "idle" }, isFinished).head,
    ).toBe("approval");
  });
});

describe("the predicate and the transform are ONE rule", () => {
  const ALL = Object.keys(AGENT_STATUS) as AgentTabStatus[];

  it("agree across every (published, own) pair and every evidence value", () => {
    for (const pub of ALL) {
      for (const own of ALL) {
        for (const fin of [true, false, undefined]) {
          const out = withFinishedHeadCalm(agents("a"), { a: pub }, { a: own }, () => fin);
          const calmed = isFinishedHeadCalmed(pub, own, fin);
          expect(out.a, `${pub}/${own}/${String(fin)}`).toBe(calmed ? "lapsed" : pub);
        }
      }
    }
  });

  it("the predicate is not vacuous in either direction", () => {
    expect(isFinishedHeadCalmed("approval", "idle", true)).toBe(true);
    expect(isFinishedHeadCalmed("approval", "idle", undefined)).toBe(false);
    expect(isFinishedHeadCalmed("approval", "approval", true)).toBe(false);
    expect(isFinishedHeadCalmed("working", "idle", true)).toBe(false);
  });
});
