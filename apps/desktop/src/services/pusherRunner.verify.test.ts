// VERIFY BEFORE SPEAK, through the whole sweep — the three findings the founder caught on
// 2026-08-07, each pinned at the layer where he read them: the delivered text.
//
// EVERY TEST HERE FAILS AGAINST THE UNVERIFIED SWEEP. That is deliberate and is the only thing that
// makes them worth having: the arithmetic in `pusherFleet` was always right, so a test that
// exercised composition would have been green before and after. What was missing was a re-read
// between measuring and speaking, and the only way to see its absence is to make the stored evidence
// disagree with what git says now — which is exactly what a four-hour cooldown over a ten-minute
// poll produces in production.
//
// The `sent` array is asserted, not the decision object: a report the founder never receives is the
// only outcome that counts, and asserting on an intermediate would let a build that computes the
// right answer and delivers the old text stay green.

import { describe, expect, it } from "vitest";
import {
  claimKey,
  type ClaimVerdict,
  type ClaimVerdicts,
  type ConflictingPr,
  type PusherClaim,
} from "@sparkle/core";
import {
  emptyPusherState,
  sweepPushers,
  type PusherLogEntry,
  type PusherRunnerDeps,
  type PusherState,
} from "./pusherRunner";
import { resolvePusherPolicy } from "@sparkle/core";

const T0 = 1_700_000_000_000;
const MIN = 60_000;

function fakeDeps(over: Partial<PusherRunnerDeps> = {}) {
  const sent: Array<{ agentId: string; text: string }> = [];
  const recorded: PusherLogEntry[] = [];
  const asked: PusherClaim[][] = [];
  const deps: PusherRunnerDeps = {
    now: () => T0,
    policy: () => resolvePusherPolicy({}),
    ownsProject: () => true,
    // ONE HEALTHY AGENT BY DEFAULT, not an empty roster: `sweepPushers` returns before it reaches the
    // report at all when this window owns nothing, so an empty default would make the conflict cases
    // below pass for the wrong reason (no report, because no sweep). This agent triggers nothing.
    snapshots: () => [{ agentId: "idle", projectId: "p", label: "Idle" }],
    inboxUsage: async (ids) => new Map(ids.map((id) => [id, 0])),
    reportRecipient: () => "concierge",
    duties: () => [],
    conflicts: () => undefined,
    // No concierge mounted — this suite is about claim verification, not the queue input.
    conciergeQueue: () => undefined,
    verifyClaims: async (claims) => {
      asked.push([...claims]);
      return new Map();
    },
    send: async (agentId, text) => {
      sent.push({ agentId, text });
      return true;
    },
    record: (e) => recorded.push(e),
    ...over,
  };
  return { deps, sent, recorded, asked };
}

/** Verdicts, written the way a real verifier answers: only what it could actually read. */
const says = (entries: Array<[PusherClaim, ClaimVerdict]>): ClaimVerdicts =>
  new Map(entries.map(([claim, v]) => [claimKey(claim), v]));

/** Two sweeps: the two-observation rule means nothing can be said on the first. */
async function sweepTwice(deps: PusherRunnerDeps): Promise<PusherState> {
  let st = emptyPusherState();
  st = await sweepPushers(deps, st);
  return sweepPushers(deps, st);
}

const conflict = (over: Partial<ConflictingPr> & { pr: number }): ConflictingPr => ({
  projectId: "project-alpha",
  branch: "sparkle/some-work",
  ownerAgentId: null,
  kind: "stale",
  commitsBehind: 220,
  unresolvedSecs: 32 * 3600,
  evidence: "n/a",
  ...over,
});

describe("a MERGED pull request is not reported as open-and-drifting", () => {
  // #1358 and #1406 were both reported as "mergeable but drifting behind main". Both had already
  // merged. The conflict store is refreshed on a ten-minute poll and the report's cooldown is four
  // hours, so the sentence outlived the fact by design.
  const conflicts = [conflict({ pr: 1358, branch: "still-open" }), conflict({ pr: 1406, branch: "merged-hours-ago" })];

  it("drops the merged one and recomposes the count around what is left", async () => {
    const { deps, sent } = fakeDeps({
      conflicts: () => conflicts,
      verifyClaims: async () =>
        says([
          [{ kind: "pr-open", pr: 1358 }, "holds"],
          [{ kind: "pr-open", pr: 1406 }, "refuted"],
        ]),
    });
    await sweepTwice(deps);

    const report = sent.find((s) => s.agentId === "concierge");
    expect(report).toBeDefined();
    expect(report!.text).not.toContain("#1406");
    expect(report!.text).toContain("#1358");
    // The HEADLINE, not just the line list. A build that filtered the finished text would leave
    // "2 open PRs" standing over one line — and `measured` still holding a 2, which is the shape
    // `gateChallenge` refuses wholesale.
    expect(report!.text).toContain("1 open PR is behind main");
  });

  it("says NOTHING when every PR it was about to name has merged", async () => {
    const { deps, sent, recorded } = fakeDeps({
      conflicts: () => conflicts,
      verifyClaims: async () =>
        says([
          [{ kind: "pr-open", pr: 1358 }, "refuted"],
          [{ kind: "pr-open", pr: 1406 }, "refuted"],
        ]),
    });
    await sweepTwice(deps);

    expect(sent).toEqual([]);
    // NAMED SEPARATELY. `no-condition` would read as "the fleet is healthy"; what happened is that
    // everything we were about to say turned out to be false, and the hit-rate log is the only place
    // that difference survives.
    expect(recorded.some((e) => e.reason === "verified-false" && e.scope === "fleet")).toBe(true);
  });

  it("still reports the PR when the re-read could not be taken", async () => {
    // The other direction, and the one that must never invert: an unauthenticated `gh` or an offline
    // machine would otherwise silence every conflicting PR at once. Silence is the failure this
    // whole feature exists to eliminate.
    const { deps, sent } = fakeDeps({
      conflicts: () => conflicts,
      verifyClaims: async () => new Map(),
    });
    await sweepTwice(deps);

    const report = sent.find((s) => s.agentId === "concierge");
    expect(report!.text).toContain("#1358");
    expect(report!.text).toContain("#1406");
  });

  it("survives a verifier that THROWS, and reports everything", async () => {
    const { deps, sent } = fakeDeps({
      conflicts: () => conflicts,
      verifyClaims: async () => {
        throw new Error("gh: not authenticated");
      },
    });
    await sweepTwice(deps);
    expect(sent.find((s) => s.agentId === "concierge")!.text).toContain("#1406");
  });

  it("costs no verification round-trip at all when there is nothing to say", async () => {
    // The efficiency property, asserted rather than assumed: a healthy fleet sweeps every minute and
    // must not pay a `gh` round-trip for it. Measured on the call log, not on timing.
    const { deps, asked } = fakeDeps({ conflicts: () => [] });
    await sweepTwice(deps);
    expect(asked).toEqual([]);
  });
});

describe("an agent whose branch is already on origin/main", () => {
  const holding = {
    agentId: "a1",
    projectId: "p",
    label: "Landed Already",
    // The per-partner side: `observeFleet` starts the unlanded clock from the fleet-wide boolean.
    hasUnlandedWork: true,
    unpushedCommits: 4,
  };

  it("is not challenged about unpushed work git says has landed", async () => {
    const { deps, sent } = fakeDeps({
      snapshots: () => [holding],
      reportRecipient: () => undefined,
      verifyClaims: async () =>
        says([[{ kind: "agent-holds-unlanded-work", agentId: "a1" }, "refuted"]]),
    });
    // Three sweeps: the unpushed trigger needs UNPUSHED_MINUTES of clock behind it, so the sighting
    // has to age. The clock is the runner's own, seeded on first sight.
    let st = emptyPusherState();
    let now = T0;
    const clocked: PusherRunnerDeps = { ...deps, now: () => now };
    st = await sweepPushers(clocked, st);
    now = T0 + 40 * MIN;
    st = await sweepPushers(clocked, st);
    await sweepPushers(clocked, st);

    expect(sent.filter((s) => s.agentId === "a1")).toEqual([]);
  });

  it("IS challenged when git confirms the work is still local", async () => {
    // Cover both directions: verification must not become a blanket mute for the trigger.
    const { deps, sent } = fakeDeps({
      snapshots: () => [holding],
      reportRecipient: () => undefined,
      verifyClaims: async () =>
        says([[{ kind: "agent-holds-unlanded-work", agentId: "a1" }, "holds"]]),
    });
    let st = emptyPusherState();
    let now = T0;
    const clocked: PusherRunnerDeps = { ...deps, now: () => now };
    st = await sweepPushers(clocked, st);
    now = T0 + 40 * MIN;
    st = await sweepPushers(clocked, st);
    await sweepPushers(clocked, st);

    expect(sent.filter((s) => s.agentId === "a1")).toHaveLength(1);
    expect(sent[0]!.text).toContain("4 commits unpushed");
  });
});

describe("an agent MID-MERGE is not called safe to retire", () => {
  // Twice on 2026-08-07: "met their goal with no unlanded work, safe to retire" about agents that
  // were waiting to merge their own PRs. Retiring either would have destroyed work. The branch poll
  // is the reason it looked clean — everything WAS pushed.
  const done = {
    agentId: "a1",
    projectId: "p",
    label: "One Sparkle Not Two",
    goalMetAt: T0 - 10 * MIN,
    hasUnlandedWork: false,
    retroSettled: true,
  };

  it("withdraws the retire recommendation when git finds work in flight", async () => {
    const { deps, sent } = fakeDeps({
      snapshots: () => [done],
      verifyClaims: async () =>
        says([
          [{ kind: "agent-has-no-unlanded-work", agentId: "a1" }, "refuted"],
          [{ kind: "goal-unmet", agentId: "a1" }, "unreadable"],
        ]),
    });
    await sweepTwice(deps);
    expect(sent).toEqual([]);
  });

  it("still recommends retirement when git CONFIRMS the tree is clean", async () => {
    const { deps, sent } = fakeDeps({
      snapshots: () => [done],
      verifyClaims: async () =>
        says([
          [{ kind: "agent-has-no-unlanded-work", agentId: "a1" }, "holds"],
          [{ kind: "goal-unmet", agentId: "a1" }, "refuted"],
        ]),
    });
    await sweepTwice(deps);
    const report = sent.find((s) => s.agentId === "concierge");
    expect(report!.text).toContain("Safe to retire");
    expect(report!.text).toContain("One Sparkle Not Two");
  });

  it("asks about BOTH halves of the claim — the work and the met goal", async () => {
    const { deps, asked } = fakeDeps({ snapshots: () => [done] });
    await sweepTwice(deps);
    expect(asked.at(-1)).toEqual([
      { kind: "agent-has-no-unlanded-work", agentId: "a1" },
      { kind: "goal-unmet", agentId: "a1" },
    ]);
  });
});

describe("a goal whose condition is already true is not reported as escalated", () => {
  // 'Unblock The Conflicting Three' — reported as escalated with "something is blocking it that
  // restarting cannot fix", while the three PRs it named were already mergeable with CI runs. The
  // agent had finished and was being reported as stuck.
  const escalated = (id: string, label: string) => ({
    agentId: id,
    projectId: "p",
    label,
    escalation: { reason: "auto-continue gave up" },
  });

  it("names only the agents that are genuinely still stuck", async () => {
    const { deps, sent } = fakeDeps({
      snapshots: () => [
        escalated("a1", "Unblock The Conflicting Three"),
        escalated("a2", "Still Genuinely Stuck"),
      ],
      verifyClaims: async () =>
        says([
          [{ kind: "goal-unmet", agentId: "a1" }, "refuted"],
          [{ kind: "goal-unmet", agentId: "a2" }, "holds"],
        ]),
    });
    await sweepTwice(deps);

    const report = sent.find((s) => s.agentId === "concierge");
    expect(report!.text).toContain("1 goal is escalated");
    expect(report!.text).toContain("Still Genuinely Stuck");
    expect(report!.text).not.toContain("Unblock The Conflicting Three");
  });

  it("keeps an escalation whose goal no machine can answer", async () => {
    // A `{kind:"human"}` goal is unreadable BY CONSTRUCTION — that is what the kind means. It must
    // keep reaching the founder, because he is the only one who can clear it.
    const { deps, sent } = fakeDeps({
      snapshots: () => [escalated("a1", "Needs A Design Call")],
      verifyClaims: async () => says([[{ kind: "goal-unmet", agentId: "a1" }, "unreadable"]]),
    });
    await sweepTwice(deps);
    expect(sent.find((s) => s.agentId === "concierge")!.text).toContain("Needs A Design Call");
  });
});

describe("what verification does NOT touch", () => {
  it("reports a quota wall without asking anything — it is already re-checked against now", async () => {
    const WEEKLY = "You've hit your weekly limit · resets Aug 4 at 11pm (America/Bogota)";
    const { deps, sent, asked } = fakeDeps({
      snapshots: () => [
        {
          agentId: "q1",
          projectId: "p",
          label: "Walled",
          quota: { message: WEEKLY, resetAt: T0 + 4 * 60 * MIN, resetParsed: true },
        },
      ],
    });
    await sweepTwice(deps);
    // No claim, so no round-trip — and the report still lands. A build that made verification a
    // precondition for speaking would go silent here, which is the inverted failure.
    expect(asked).toEqual([]);
    expect(sent.find((s) => s.agentId === "concierge")!.text).toContain("1 agent is quota-blocked");
  });
});
