import { describe, expect, it } from "vitest";
import type { AgentTabStatus } from "@sparkle/ui";
import { AGENT_STATUS } from "@sparkle/ui";
import { newGoal } from "./agentGoal";
import { stallReport, type StallInput } from "./agentStall";
import type { StatusMap } from "./attention";
import { withNudgeLoopCalm } from "./nudgeLoopCalm";
import { withFinishedHeadCalm } from "./finishedHeadCalm";
import type { ThrashReport } from "./agentThrash";
import {
  mustLeaveCalm,
  withDismissedStallAttention,
  withStallAttention,
} from "./stallEscalation";
import {
  advanceAlertRecord,
  alertControlKind,
  withDismissedAlerts,
  dismissedRecord,
  reenabledRecord,
  type AgentAlertRecord,
} from "./alertDismissal";

const T0 = 1_700_000_000_000;
/** MotionAgent shape: the escalation now refuses a head whose worker subtree is in motion, so the
 *  fixtures have to say what kind of row they are. Both are parentless heads with no workers. */
const AGENTS = [
  { id: "a", kind: "build" as const, parentId: null },
  { id: "b", kind: "build" as const, parentId: null },
];

/** A row whose git state was fully READ and has nothing outstanding — genuinely finished. */
function resting(over: Partial<StallInput> = {}): StallInput {
  return {
    status: "idle",
    now: T0,
    goal: undefined,
    hasOpenPr: false,
    hasUnlandedWork: false,
    hasUncommittedChanges: false,
    ...over,
  };
}

/**
 * A resting row that only the FOUNDER can clear — the fixture for every case about the RED tier.
 *
 * Both halves of `human-verified-goal` (engine/agentStall): auto-continue has stopped (`escalatedAt`)
 * AND the goal's stated check is one no agent may ever discharge (`{kind:"human"}`).
 *
 * ⚠️ WHY SO MANY CASES BELOW NEEDED IT ON 2026-08-07. They were written against an ordinary unmet
 * goal or a dirty worktree back when those painted red, and they are not ABOUT the tier at all —
 * they cover liveness refusal, dismissal, the episode counter and cross-fleet selectivity. Rewriting
 * their expectation to `lapsed` would have kept them green while quietly deleting the only coverage
 * the red path has in those mechanisms. Swapping the FIXTURE keeps each test testing what it was
 * written to test.
 */
function founderOnly(over: Partial<StallInput> = {}): StallInput {
  return resting({
    goal: {
      ...newGoal("sign off on the launch copy", T0, undefined, { kind: "human" }),
      escalatedAt: T0 + 1,
    },
    ...over,
  });
}

const reportFor = (input: StallInput) => (id: string) =>
  id === "a" ? stallReport(input) : undefined;
/** Every agent alive unless a test says otherwise — the common case. */
const allAlive = () => true;

describe("THE FOUNDER'S ACCEPTANCE TEST — gray is a terminal state", () => {
  // "An agent with an unmet goal, or with uncommitted changes, or with an open unmerged branch, must
  // never render gray. If your state model can produce that combination, it is not finished."
  // The third element is the tier the row must land in. It was implicitly `blocked` for every case
  // until 2026-08-06, when `an escalated goal` moved to AMBER; on 2026-08-07 the remaining four
  // followed it, because each names work ANOTHER ACTOR clears — the concierge lands a branch, the
  // agent commits its worktree, CI clears a PR, auto-continue drives an unmet goal (see OUTSTANDING
  // in stallEscalation.ts).
  //
  // ⚠️ THE FOUNDER'S RULE HERE IS UNCHANGED AND STILL FULLY ASSERTED: none of these may render GRAY.
  // That is what the colour assertion in each `it` checks, and it is the actual content of "gray is a
  // terminal state" — the rule says a row that owes work must LEAVE CALM, it never said which
  // non-calm colour. Amber satisfies it. Do not read the tier change below as a weakening of it; the
  // last case pins the red tier still being reachable, so the matrix is non-trivial in both
  // directions.
  const cases: Array<[string, StallInput, AgentTabStatus]> = [
    ["an unmet goal", resting({ goal: newGoal("ship the ladder", T0) }), "lapsed"],
    ["uncommitted changes", resting({ hasUncommittedChanges: true }), "lapsed"],
    ["an open unmerged PR", resting({ hasOpenPr: true }), "lapsed"],
    ["committed work that never landed", resting({ hasUnlandedWork: true }), "lapsed"],
    [
      "an escalated goal",
      resting({ goal: { ...newGoal("hard", T0), escalatedAt: T0 + 1 } }),
      "lapsed",
    ],
    // …and the one that IS his. Auto-continue has stopped AND the goal's stated check is one no
    // agent may ever discharge, so nobody but the founder can clear this row.
    [
      "a goal only a person can close, with no retry coming",
      resting({
        goal: {
          ...newGoal("approve the copy", T0, undefined, { kind: "human" }),
          escalatedAt: T0 + 1,
        },
      }),
      "blocked",
    ],
    // NOTE: "an expired goal" USED TO BE A CASE HERE and was removed on purpose (sparkle-biezi).
    // Expiry is a fact about the clock, not about the work, so it is no longer sufficient on its own
    // — see the `expiry is not an alarm` describe block below, which pins both halves of the rule.
  ];

  it.each(cases)("a row with %s does not render gray", (_label, input, expected) => {
    const out = withStallAttention(AGENTS, { a: "idle", b: "working" }, reportFor(input), allAlive);
    expect(out.a).toBe(expected);
    // The actual requirement, asserted against the token table rather than a status name — a future
    // rename cannot quietly satisfy the letter of this test while breaking the rule.
    expect(AGENT_STATUS[out.a as AgentTabStatus].color).not.toBe(AGENT_STATUS.idle.color);
  });

  it.each(cases)("...and the same holds from the `unmerged` band, with %s", (_label, input, expected) => {
    const out = withStallAttention(
      AGENTS,
      { a: "unmerged", b: "working" },
      reportFor(input),
      allAlive,
    );
    expect(out.a).toBe(expected);
    expect(AGENT_STATUS[out.a as AgentTabStatus].color).not.toBe(AGENT_STATUS.idle.color);
  });

  it("STUCK IS NOT GRAY — the founder's second complaint, asserted as colour", () => {
    // "the user also asked why an agent that is STUCK is not red. Their expectation is that stuck
    // means red, not gray."
    //
    // ⚠️ THIS ASSERTED `waiting.color` (RED) UNTIL 2026-08-07, and the founder himself superseded it:
    // *"Why are all these agents red? They don't seem to need anything from me."* A row stuck on an
    // unmet goal is one auto-continue is still driving, so it needs nothing from him — the ANSWER to
    // "why isn't this gray" was never "because it needs you", it was "because it isn't finished".
    // Amber says exactly that, and the complaint the case was written for — a stuck row rendering as
    // calm as a shipped one — is still fully guarded here.
    const out = withStallAttention(
      AGENTS,
      { a: "idle" },
      reportFor(resting({ goal: newGoal("stuck on the merge", T0) })),
      allAlive,
    );
    const color = AGENT_STATUS[out.a as AgentTabStatus].color;
    expect(color).not.toBe(AGENT_STATUS.idle.color);
    expect(color).toBe(AGENT_STATUS.lapsed.color);
  });

  it("…and RED still reaches the rows that ARE his, so the tier is not dead", () => {
    // The other direction, and the reason the change above is safe: making rows less red must not
    // make the red tier unreachable. A goal only a person can close, with no retry coming, still
    // paints the loudest colour the app has.
    const out = withStallAttention(
      AGENTS,
      { a: "idle" },
      reportFor(
        resting({
          goal: {
            ...newGoal("sign off on the launch copy", T0, undefined, { kind: "human" }),
            escalatedAt: T0 + 1,
          },
        }),
      ),
      allAlive,
    );
    expect(out.a).toBe("blocked");
    expect(AGENT_STATUS[out.a as AgentTabStatus].color).toBe(AGENT_STATUS.waiting.color);
  });
});

describe("EXPIRY IS NOT AN ALARM — sparkle-biezi", () => {
  /** The live state of agent 11a52157 ("Babysit PR 1104") in the founder's screenshot: idle, calm,
   *  a spotless worktree, nothing unlanded — and a goal whose TTL had simply run out. */
  const expiredAndDone = resting({ goal: newGoal("stale", T0, 1_000), now: T0 + 5_000 });

  it("leaves a FINISHED agent whose goal merely expired GRAY, not red", () => {
    const out = withStallAttention(AGENTS, { a: "idle" }, reportFor(expiredAndDone), allAlive);
    // The side effect that was wrong: the row's rendered COLOUR. Asserted against the token table,
    // not the status name, so a rename cannot satisfy the letter of this while breaking the rule.
    expect(AGENT_STATUS[out.a as AgentTabStatus].color).toBe(AGENT_STATUS.idle.color);
    expect(AGENT_STATUS[out.a as AgentTabStatus].color).not.toBe(AGENT_STATUS.waiting.color);
    expect(out.a).toBe("idle");
  });

  it("does not escalate it from the `unmerged` band either", () => {
    // Three of the four red rows were labelled MERGED TO MAIN. `unmerged` is the other calm band,
    // and it is the one `ESCALATABLE` also covers, so the rule has to hold from both.
    const out = withStallAttention(AGENTS, { a: "unmerged" }, reportFor(expiredAndDone), allAlive);
    expect(out.a).toBe("unmerged");
  });

  it("mustLeaveCalm is false when `expired-goal` is the ONLY cause", () => {
    const report = stallReport(expiredAndDone);
    // The cause is still REPORTED — this is the "surfaced, never red" half. `agentStall` is
    // untouched, so the "goal expired" chip and the amber "ran out of time" badge still render.
    expect(report.verdict).toBe("stalled");
    expect(report.causes).toEqual(["expired-goal"]);
    // …it just no longer votes for red.
    expect(mustLeaveCalm(report)).toBe(false);
  });

  it("STILL leaves calm when the expiry sits on top of UNLANDED work", () => {
    // The other half of the founder's rule: a row that genuinely owes something must not go quiet
    // just because its clock also ran out. Without this, the expiry fix would have silenced real
    // stalls too.
    //
    // ⚠️ THIS ASSERTED `blocked` UNTIL 2026-08-07 ("keeps exactly the colour it had — on the strength
    // of the work"). `unlanded-work` is amber now: the concierge lands a stranded branch alone, and
    // did so for 15 of them in one night. The half of the rule this case exists for is untouched —
    // the row still LEAVES CALM on the strength of the work rather than of the clock, which is what
    // separates it from the spotless expired row above.
    const out = withStallAttention(
      AGENTS,
      { a: "idle" },
      reportFor({ ...expiredAndDone, hasUnlandedWork: true }),
      allAlive,
    );
    expect(out.a).toBe("lapsed");
    expect(mustLeaveCalm(stallReport({ ...expiredAndDone, hasUnlandedWork: true }))).toBe(true);
    expect(AGENT_STATUS[out.a as AgentTabStatus].color).not.toBe(AGENT_STATUS.idle.color);
    expect(stallReport({ ...expiredAndDone, hasUnlandedWork: true }).causes).toContain(
      "expired-goal",
    );
  });

  it("STILL leaves calm when the expiry sits on top of uncommitted changes", () => {
    const out = withStallAttention(
      AGENTS,
      { a: "idle" },
      reportFor({ ...expiredAndDone, hasUncommittedChanges: true }),
      allAlive,
    );
    expect(out.a).toBe("lapsed");
    expect(AGENT_STATUS[out.a as AgentTabStatus].color).not.toBe(AGENT_STATUS.idle.color);
  });

  it("an ESCALATED goal leaves calm — but AMBER, not the red it used to be", () => {
    // THIS ASSERTION READ `blocked` UNTIL 2026-08-06, on the reasoning that auto-continue handing
    // the agent back "is a human's problem". The founder overruled that with two measured rows:
    // both escalated, both with spotless worktrees and every PR they owned merged, both painted the
    // loudest colour the app has. *"why are they red when they don't require my assistance?"*
    //
    // The distinction the old membership missed is the same one `expired-goal` taught: escalation is
    // a fact about OUR retry budget — how long auto-continue was willing to keep spending — not
    // about the work, and not about whether a human is required. It still leaves calm, because the
    // agent really did stop and nothing is coming to restart it; it just no longer says that in the
    // colour reserved for "a human is blocking this".
    const out = withStallAttention(
      AGENTS,
      { a: "idle" },
      reportFor(resting({ goal: { ...newGoal("hard", T0), escalatedAt: T0 + 1 } })),
      allAlive,
    );
    expect(out.a).toBe("lapsed");
    expect(AGENT_STATUS.lapsed.color).not.toBe(AGENT_STATUS.waiting.color);
  });

  it("…but a row that owes the FOUNDER a verdict is still RED, whatever else is true of it", () => {
    // The safety property, and the reason none of this is a way to silence real stalls: `OUTSTANDING`
    // is tested before `LIFECYCLE`, so a cause only he can clear still outranks the amber tier.
    //
    // ⚠️ THIS DROVE `hasUncommittedChanges` UNTIL 2026-08-07, when uncommitted work moved to amber
    // (the agent commits or discards its own worktree — the founder never does). Amber-plus-amber
    // must NOT add up to red, which is pinned in redAttentionTaxonomy; what this case guards is the
    // ORDERING, so it now carries a genuinely red cause plus a pile of amber ones.
    const out = withStallAttention(
      AGENTS,
      { a: "idle" },
      reportFor(founderOnly({ hasUncommittedChanges: true, hasUnlandedWork: true })),
      allAlive,
    );
    expect(out.a).toBe("blocked");
  });
});

describe("what it must NOT recolour", () => {
  it("leaves a genuinely finished row gray — gray still means something", () => {
    // If everything went red, the colour would carry no information, which is the 27-of-51 failure
    // the 2026-07-26 de-redding was about.
    const out = withStallAttention(AGENTS, { a: "idle" }, reportFor(resting()), allAlive);
    expect(out.a).toBe("idle");
  });

  it("returns the SAME map reference when nothing is escalated — no render churn", () => {
    const map: Record<string, AgentTabStatus> = { a: "idle", b: "done" };
    expect(withStallAttention(AGENTS, map, reportFor(resting()), allAlive)).toBe(map);
  });

  it("never touches a WORKING row, however much it owes", () => {
    // The green tier is the one colour that was already telling the truth.
    const out = withStallAttention(
      AGENTS,
      { a: "working" },
      reportFor(resting({ status: "working", goal: newGoal("g", T0) })),
      allAlive,
    );
    expect(out.a).toBe("working");
  });

  it.each(["waiting", "approval", "errored", "blocked"] as const)(
    "leaves the already-red %s row alone — no second alarm on the row that is not the problem",
    (status) => {
      const out = withStallAttention(
        AGENTS,
        { a: status },
        reportFor(resting({ status, goal: newGoal("g", T0) })),
        allAlive,
      );
      expect(out.a).toBe(status);
    },
  );

  it("does NOT escalate an unread git state — a red dot on ignorance trains the human to ignore it", () => {
    // verdict `unknown`: no cause was found, but nothing was looked up either.
    const unread = stallReport({ status: "idle", now: T0, goal: undefined });
    expect(unread.verdict).toBe("unknown");
    expect(mustLeaveCalm(unread)).toBe(false);
    expect(withStallAttention(AGENTS, { a: "idle" }, () => unread, allAlive).a).toBe("idle");
  });

  it("does NOT escalate an agent this window has no reading for", () => {
    expect(mustLeaveCalm(undefined)).toBe(false);
    expect(withStallAttention(AGENTS, { a: "idle" }, () => undefined, allAlive).a).toBe("idle");
  });

  it("leaves an unbriefed `new` agent alone", () => {
    // Not by an exclusion here but by construction: `stallReport` answers `active` for it, so no
    // report about a new agent is ever stalled. Keeps newAgentAttention's work intact.
    const out = withStallAttention(
      AGENTS,
      { a: "new" },
      reportFor(resting({ status: "new" })),
      allAlive,
    );
    expect(out.a).toBe("new");
  });
});

describe("a DEAD process, shaped the way production presents it", () => {
  // THE TRAP THIS MODULE FELL INTO (roborev 55318). Excluding `done`/`stopped` from ESCALATABLE looked
  // like it excluded dead agents. It does not: `withUnmergedWork` relabels a `done`/`stopped` row that
  // holds unlanded commits to `unmerged` BEFORE this overlay runs, so the dead tab arrives wearing a
  // status that IS escalatable, and the band is its own evidence of outstanding work. The row went red
  // saying "needs you to unstick it" about an agent with no PTY. The earlier test could not see it
  // because it passed the PRE-overlay status, which the real pipeline never presents here.
  //
  // The goal is the FOUNDER-ONLY one so the "while the process is alive" control below still lands
  // on RED. The liveness refusal itself runs BEFORE the tier split (`withStallAttention` continues
  // on a dead process without ever calling `escalationFor`), so it covers both tiers either way —
  // but the loudest colour is the one worth pinning against a dead PTY.
  const deadUnmergedRow: StallInput = {
    status: "unmerged", // what withUnmergedWork wrote over `stopped`
    now: T0,
    goal: {
      ...newGoal("never finished", T0, undefined, { kind: "human" }),
      escalatedAt: T0 + 1,
    },
    hasOpenPr: false,
    hasUncommittedChanges: true,
  };

  it("stays in its band when the PTY is known gone", () => {
    const out = withStallAttention(
      AGENTS,
      { a: "unmerged" },
      reportFor(deadUnmergedRow),
      () => false, // turnEndAuthority.processAliveOf: observed dead
    );
    expect(out.a).toBe("unmerged");
  });

  it("but DOES escalate the same row while the process is alive", () => {
    // The control that stops the test above from passing for the wrong reason.
    const out = withStallAttention(AGENTS, { a: "unmerged" }, reportFor(deadUnmergedRow), () => true);
    expect(out.a).toBe("blocked");
  });

  it("escalates when liveness is UNKNOWN — the opposite trade-off from auto-continue", () => {
    // `goalContinuation` fails CLOSED on absent liveness because a wrong yes there spends money by
    // typing into a terminal. Here a wrong yes only colours a dot, and failing closed would re-open
    // the gray lie this module exists to close. Same evidence, different cost, different default.
    const out = withStallAttention(AGENTS, { a: "idle" }, reportFor(founderOnly()), () => undefined);
    expect(out.a).toBe("blocked");
  });
});

describe("the red it produces is a red the human can ACKNOWLEDGE", () => {
  // FOUNDER-ONLY since 2026-08-07: this suite is about acknowledging the RED tier, and its old
  // fixture (a plain unmet goal) is amber now. The amber tier has its own end-to-end suite at the
  // bottom of this file; keeping both means neither path loses its dismissal coverage.
  const stalled = founderOnly();
  const CALM: Record<string, AgentTabStatus> = { a: "unmerged" };

  /**
   * The row as the pipeline builds it, in the real order: escalate unconditionally, let the alert
   * recorder see THAT map, then undo any acknowledged escalation.
   *
   * The two passes are what keeps the episode counter honest — see withDismissedStallAttention. A
   * fixture that only re-ran the escalation with a hand-built record (as the first version of this
   * suite did) could not see either failure roborev 55379 found.
   */
  /**
   * BOTH MAPS THE SIDEBAR BUILDS, and which consumer gets which is the thing under test:
   * `recorded` (pre-undo) is what `advanceAlerts` and the Dismiss/Re-enable control see, `presented`
   * (post-undo) is what the row's colour reads.
   *
   * Derived here rather than hand-authored, because the earlier fixture typed the presented status
   * itself — so it stayed green against a wiring that fed the recorder the POST-undo map, which is
   * exactly the ratchet these tests exist to catch (roborev 55434).
   */
  function pipeline(alert?: AgentAlertRecord): {
    recorded: Record<string, AgentTabStatus>;
    presented: Record<string, AgentTabStatus>;
  } {
    const agents = [{ id: "a", kind: "build" as const, parentId: null, alert }];
    const recorded = withStallAttention(
      agents,
      CALM,
      () => stallReport({ ...stalled, status: "unmerged" }),
      allAlive,
    );
    return { recorded, presented: withDismissedStallAttention(agents, recorded, CALM) };
  }

  /** `projectStore.advanceAlerts`, fed what the sidebar feeds it: the PRE-undo map. */
  const recordFrom = (prev: AgentAlertRecord | undefined, alert?: AgentAlertRecord) =>
    advanceAlertRecord(prev, pipeline(alert).recorded.a ?? "stopped");

  /** What the row PRESENTS — the only thing the colour reads. */
  function escalate(alert?: AgentAlertRecord): Record<string, AgentTabStatus> {
    return pipeline(alert).presented;
  }

  it("offers a Dismiss control once the alert path is fed the ESCALATED status", () => {
    // The wiring contract, and the reason it is stated so loudly in the module header: every
    // dismissal entry point takes a status, and handed the RAW map they see `unmerged`, return null,
    // and render nothing — a red nobody can acknowledge, which is exactly what forced the 2026-07-26
    // rollback. Asserted from the escalated map rather than from the constant `"blocked"`, which is
    // what the previous version of this test did: that assertion was already true before the module
    // existed and proved nothing about a row.
    const escalated = escalate();
    expect(alertControlKind(undefined, escalated.a)).toBe("dismiss");
  });

  it("a dismissal returns the row to ITS OWN band, not to `idle`", () => {
    // The whole chain: escalate, record the episode from the escalated status, dismiss, re-run.
    // Relying on `withDismissedAlerts` instead would de-escalate `blocked` to `idle` unconditionally,
    // so this row would come back as `idle` — losing "Needs merge", losing its ordering band, and
    // (because agentStall reads `status === "unmerged"` as the EVIDENCE of unlanded work) making the
    // next stall report read `unknown` instead of `stalled`. One acknowledgement would have erased the
    // fact that the branch exists (roborev 55318).
    const escalated = escalate();
    expect(escalated.a).toBe("blocked");

    const acked = dismissedRecord(advanceAlertRecord(undefined, escalated.a));
    const after = escalate(acked);
    expect(after.a).toBe("unmerged");
    // ...and the row is still KNOWN to be stalled — acknowledging is not resolving.
    expect(mustLeaveCalm(stallReport({ ...stalled, status: "unmerged" }))).toBe(true);
  });

  it("re-enabling brings the red back", () => {
    const acked = dismissedRecord(advanceAlertRecord(undefined, escalate().a));
    expect(escalate(acked).a).toBe("unmerged");
    expect(escalate(reenabledRecord(acked)).a).toBe("blocked");
  });

  it("a STALE dismissal of an unrelated red does not suppress the first stall", () => {
    // ROBOREV 55379's first case. `isAlertSuppressed` only says "the dismissal matches the current
    // episode" — it never says WHICH red was acknowledged. An agent goes `waiting`, the human
    // dismisses, the agent recovers: the record is left `{seq:1, lastRed:null, dismissedSeq:1}`, i.e.
    // dismissedSeq === seq FOREVER. Weeks later the row stalls. Gating the escalation on that record
    // read it as "already acknowledged" and rendered gray — nothing about THIS alarm was ever
    // acknowledged. Escalating unconditionally means the recorder sees `blocked`, bumps the episode
    // past the stale dismissal, and the row goes red.
    const stale = dismissedRecord(advanceAlertRecord(undefined, "waiting")); // dismissed while waiting
    const recovered = advanceAlertRecord(stale, "idle"); // recovered → lastRed null, dismissedSeq === seq
    expect(recovered.dismissedSeq).toBe(recovered.seq);

    expect(escalate(recovered).a).toBe("blocked");
    // ...and the episode advances off the stale dismissal, so the acknowledge state is honest again.
    const advanced = recordFrom(recovered, recovered);
    expect(advanced.seq).toBeGreaterThan(recovered.seq);
    expect(escalate(advanced).a).toBe("blocked");
  });

  it("a dismissal does not become a RATCHET — a later stall re-raises it", () => {
    // ROBOREV 55379's second case, and the reason this is two passes. When the escalation suppressed
    // ITSELF, the row never presented `blocked`, so `seq` could never move past `dismissedSeq` and the
    // skip repeated forever: the module's own "a new episode must re-raise red" requirement was
    // unreachable by construction. Here the recorder always sees the escalated map, so the counter
    // keeps moving and a new episode outranks the old acknowledgement.
    let rec = recordFrom(undefined); // recorder sees the escalated map → seq 1, lastRed blocked
    rec = dismissedRecord(rec);
    expect(escalate(rec).a).toBe("unmerged"); // acknowledged → the row presents its own band again

    // …and the recorder KEEPS seeing `blocked` (it reads the pre-undo map), so the acknowledgement
    // stays about this episode instead of becoming a permanent suppression. Feeding it the presented
    // map here is the bug: `unmerged` is not red, `seq` never moves, and no future stall can re-raise.
    rec = recordFrom(rec, rec);
    expect(rec.lastRed).not.toBeNull();
    expect(escalate(rec).a).toBe("unmerged");

    // A genuinely NEW episode outranks the old acknowledgement. Modelled the way production produces
    // one: the stall clears (the row leaves red), then a new stall arrives and the recorder sees
    // `blocked` again — which bumps `seq` past `dismissedSeq`.
    rec = advanceAlertRecord(rec, "idle"); // stall cleared → leaves red
    rec = recordFrom(rec, rec); // stalled again → new episode
    expect(rec.seq).toBeGreaterThan(rec.dismissedSeq ?? 0);
    expect(escalate(rec).a).toBe("blocked");
  });

  it("escalates only the rows that owe something, across a mixed fleet", () => {
    const out = withStallAttention(
      [
        { id: "stalled", kind: "build" as const, parentId: null },
        { id: "clean", kind: "build" as const, parentId: null },
        { id: "busy", kind: "build" as const, parentId: null },
      ],
      { stalled: "idle", clean: "idle", busy: "working" },
      (id) =>
        id === "stalled"
          ? stallReport(founderOnly())
          : id === "clean"
            ? stallReport(resting())
            : undefined,
      allAlive,
    );
    expect(out).toEqual({ stalled: "blocked", clean: "idle", busy: "working" });
  });
});

// ── The AMBER tier must be acknowledgeable too (roborev 59922) ────────────────────────────────────
//
// The amber tier widened three coupled paths — `alertDismissal.DISMISSIBLE`/`isAlertingStatus`,
// `redSignature` returning an `AlertingStatus`, and `withDismissedStallAttention`'s two comparisons
// — and every case in the acknowledge suite above drives the `unmerged → blocked` fixture, while the
// `redAttentionTaxonomy` cases stop at `escalationFor`. So the end-to-end property nothing else
// covered: escalate → the recorder sees `lapsed` → dismiss → the row is handed back to its OWN band
// rather than flattened to `idle`, and re-enabling restores the amber.
//
// The failure this guards is named at alertDismissal.ts's own header: an UNDISMISSABLE coloured row
// is what forced the 2026-07-26 rollback. An amber one would be the same bug in a new hue.
describe("an AMBER `lapsed` row is dismissible exactly like the red one", () => {
  const lapsedInput = resting({ goal: { ...newGoal("hard", T0), escalatedAt: T0 + 1 } });
  const CALM: Record<string, AgentTabStatus> = { a: "idle" };

  function pipeline(alert?: AgentAlertRecord): {
    recorded: Record<string, AgentTabStatus>;
    presented: Record<string, AgentTabStatus>;
  } {
    const agents = [{ id: "a", kind: "build" as const, parentId: null, alert }];
    const recorded = withStallAttention(agents, CALM, () => stallReport(lapsedInput), allAlive);
    return { recorded, presented: withDismissedStallAttention(agents, recorded, CALM) };
  }

  it("escalates to `lapsed`, and the alert recorder is fed that status", () => {
    const { recorded, presented } = pipeline();
    expect(recorded.a).toBe("lapsed");
    // Un-acknowledged, the row PRESENTS the amber — the undo pass must not swallow it.
    expect(presented.a).toBe("lapsed");
  });

  it("offers a Dismiss control for the amber row", () => {
    // If `alertControlKind` returned null here the row would be a colour the human cannot clear.
    expect(alertControlKind(undefined, pipeline().recorded.a ?? "stopped")).toBe("dismiss");
  });

  it("hands a dismissed amber row back to its OWN band, not to a flattened `idle`", () => {
    const rec = advanceAlertRecord(undefined, pipeline().recorded.a ?? "stopped");
    const dismissed = dismissedRecord(rec);
    // `withDismissedStallAttention` restores the pre-escalation status, which here IS `idle` —
    // asserted against CALM rather than the literal so this stays honest if the fixture's band moves.
    expect(pipeline(dismissed).presented.a).toBe(CALM.a);
    // The signature really was the amber one — this is what ties the acknowledgement to THIS alarm.
    expect(rec.lastRed).toBe("lapsed");
  });

  it("re-raises the amber after the human re-enables it", () => {
    const rec = advanceAlertRecord(undefined, pipeline().recorded.a ?? "stopped");
    expect(pipeline(reenabledRecord(dismissedRecord(rec))).presented.a).toBe("lapsed");
  });
});

// ── AN ORCHESTRATOR CAN BE BLOCKED ON A PERSON WHILE ITS WORKERS RUN (2026-08-18) ──────────────────
//
// `withStallAttention` refuses to escalate a head whose worker subtree is in motion (roborev
// 55423/55434), and that refusal is right for every cause it was written about: those are INFERENCES
// from a resting status, and delegation is work the parent is not doing itself.
//
// `blocked-on-human` is not an inference — `nudge_ladder` asked the agent what was blocking it and it
// answered that a person is. A busy subtree does not discharge that. Without the exemption the fix
// would be silently unreachable for orchestrators, which on this fleet are the heads MOST likely to
// be waiting on the founder.
describe("blocked-on-human outranks the in-motion refusal", () => {
  /** A head with a worker beneath it — the shape `isInMotion` is about.
   *
   *  ⚠️ THE CHILD'S `kind` MUST BE `"worker"`. `isInMotion` matches on
   *  `a.kind === "worker" && a.parentId === agentId`, so a child written as `"build"` makes the veto
   *  never fire — and then BOTH tests below pass without exercising the thing they name. The first
   *  cut of this fixture did exactly that and the paired negative caught it, which is the whole
   *  reason that test exists. */
  const HEAD_AND_WORKER = [
    { id: "a", kind: "build" as const, parentId: null },
    { id: "w", kind: "worker" as const, parentId: "a" },
  ];
  const withHumanBlock = (over: Partial<StallInput> = {}): StallInput =>
    resting({ humanBlock: { raisedAtMs: T0 }, ...over });

  it("the head goes RED even though its worker is working", () => {
    const out = withStallAttention(
      HEAD_AND_WORKER,
      { a: "idle", w: "working" },
      (id) => (id === "a" ? stallReport(withHumanBlock()) : undefined),
      allAlive,
    );
    expect(out.a).toBe("blocked");
    expect(AGENT_STATUS[out.a as AgentTabStatus].color).toBe(AGENT_STATUS.waiting.color);
  });

  it("…while the SAME moving subtree still suppresses an inferred cause — the refusal is intact", () => {
    // THE PAIRED NEGATIVE, and the one that keeps the exemption narrow. Identical agents, identical
    // statuses; only the CAUSE differs. If this went red too, the change would have deleted roborev
    // 55423/55434's protection wholesale rather than carving one cause out of it.
    const out = withStallAttention(
      HEAD_AND_WORKER,
      { a: "idle", w: "working" },
      (id) => (id === "a" ? stallReport(founderOnly()) : undefined),
      allAlive,
    );
    expect(out.a).toBe("idle");
  });

  it("a head with NO worker in motion is unaffected either way", () => {
    // Guards against the exemption being what makes the first case pass for the wrong reason: with
    // a quiet subtree the veto never fires, so both causes escalate exactly as they did before.
    // Typed rather than a bare literal: without it TS widens the values to `string` and the call
    // does not compile. vitest does not typecheck, so only `tsc --noEmit` catches this.
    const quiet: StatusMap = { a: "idle", w: "idle" };
    expect(
      withStallAttention(HEAD_AND_WORKER, quiet, (id) => (id === "a" ? stallReport(withHumanBlock()) : undefined), allAlive).a,
    ).toBe("blocked");
    expect(
      withStallAttention(HEAD_AND_WORKER, quiet, (id) => (id === "a" ? stallReport(founderOnly()) : undefined), allAlive).a,
    ).toBe("blocked");
  });
});

// ── THE COMPOSED CHAIN, NOT THE FIRST OVERLAY (roborev 65357, the second Medium) ───────────────────
//
// The in-motion tests above call `withStallAttention` directly, which proves only that the FIRST
// overlay emits `blocked`. Production runs three more passes over that map, and one of them —
// `withNudgeLoopCalm` — demoted the result straight back to amber for exactly the rows this red was
// written for. The unit tests stayed green throughout, because the thing they assert is not the
// thing the founder looks at.
//
// THE POPULATIONS ARE THE SAME, NOT MERELY OVERLAPPING, which is what makes this the whole feature
// rather than an edge: `agentThrash` raises `nudge-loop` after three nudge-opened turns that ran no
// tool, and answering the ladder's question in prose IS a nudge-opened turn that ran no tool. So the
// flag is produced by the same nudging that produces the verdict.
describe("blocked-on-human survives the whole sidebar chain", () => {
  /** TWO agents, so `humanBlockedOf` is checked for PER-ROW selectivity (roborev 65373). With one
   *  agent a predicate that ignores its `id` — or reads the wrong one — passes every case, and the
   *  sibling `thrashOf` already has a two-agent test for exactly this reason. */
  const AGENTS2 = [
    { id: "said", kind: "build" as const, parentId: null },
    { id: "inferred", kind: "build" as const, parentId: null },
  ];
  const CALM2: StatusMap = { said: "idle", inferred: "idle" };
  const humanBlocked = (): StallInput => resting({ humanBlock: { raisedAtMs: T0 } });
  /** The verdict every flagged agent also carries — see the block comment above. */
  const nudgeLoop = { verdict: "nudge-loop" } as ThrashReport;

  /**
   * ALL FOUR PASSES, in the sidebar's real order (roborev 65373).
   *
   * ⚠️ THE PREVIOUS CUT RAN ONLY TWO and still called itself "the whole chain" — which is the very
   * defect the round before it was about, repeated one layer out: a claim about the PAINTED status
   * asserted against a prefix of the chain. `withFinishedHeadCalm` runs AFTER `withNudgeLoopCalm`
   * in production and can also demote to `lapsed`, so leaving it out left the final word untested.
   */
  const painted = (inputOf: (id: string) => StallInput, humanBlockedOf: (id: string) => boolean) => {
    const reportOf = (id: string) => stallReport(inputOf(id));
    const escalated = withStallAttention(AGENTS2, CALM2, reportOf, allAlive);
    return withFinishedHeadCalm(
      AGENTS2,
      withNudgeLoopCalm(AGENTS2, withDismissedAlerts(AGENTS2, escalated), () => nudgeLoop, humanBlockedOf),
      CALM2,
      (id) => reportOf(id).verdict === "finished",
    );
  };

  it("the stated row stays RED while an inferred one beside it is demoted — same call", () => {
    // Both halves in ONE composition, which is what makes this about the PREDICATE rather than about
    // two independent runs: `said` answered, `inferred` did not, and the same pass must treat them
    // differently. A `humanBlockedOf` that ignored its `id` would fail one side or the other.
    const out = painted(
      (id) => (id === "said" ? humanBlocked() : founderOnly()),
      (id) => id === "said",
    );
    expect(out.said).toBe("blocked");
    expect(out.inferred).toBe("lapsed");
  });

  it("…and with NOBODY blocked, both are demoted — the module still does its job", () => {
    // `nudgeLoopCalm` exists because the founder was shown red rows that were Sparkle's own pings
    // looping (bead sparkle-hpbkw). Exempting a stated block must not become exempting everything.
    const out = painted(() => founderOnly(), () => false);
    expect(out.said).toBe("lapsed");
    expect(out.inferred).toBe("lapsed");
  });

  it("the exemption is keyed on the ANSWER, not on the status being blocked", () => {
    // Guards the shape of the carve-out: were it keyed on `blocked` itself, the cases above would
    // pass while the module was disabled outright. Both rows present `blocked` before the demotion;
    // only the flag separates them.
    expect(painted(() => founderOnly(), () => true).said).toBe("blocked");
    expect(painted(() => humanBlocked(), () => false).said).toBe("lapsed");
  });

  it("survives the LAST pass too — a human-blocked row is never `finished`", () => {
    // `withFinishedHeadCalm` is the pass the previous cut omitted. It happens not to demote here
    // because a `humanBlock` cause forces `verdict: "stalled"`, so `isFinished` is false — but that
    // coupling was unpinned, and a change to `stallInputsFor` could break it invisibly.
    expect(stallReport(humanBlocked()).verdict).toBe("stalled");
    expect(painted(() => humanBlocked(), () => true).said).toBe("blocked");
  });
});
