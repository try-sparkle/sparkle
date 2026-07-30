import { describe, expect, it } from "vitest";
import type { AgentTabStatus } from "@sparkle/ui";
import { AGENT_STATUS } from "@sparkle/ui";
import { newGoal } from "./agentGoal";
import { stallReport, type StallInput } from "./agentStall";
import {
  mustLeaveCalm,
  withDismissedStallAttention,
  withStallAttention,
} from "./stallEscalation";
import {
  advanceAlertRecord,
  alertControlKind,
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

const reportFor = (input: StallInput) => (id: string) =>
  id === "a" ? stallReport(input) : undefined;
/** Every agent alive unless a test says otherwise — the common case. */
const allAlive = () => true;

describe("THE FOUNDER'S ACCEPTANCE TEST — gray is a terminal state", () => {
  // "An agent with an unmet goal, or with uncommitted changes, or with an open unmerged branch, must
  // never render gray. If your state model can produce that combination, it is not finished."
  const cases: Array<[string, StallInput]> = [
    ["an unmet goal", resting({ goal: newGoal("ship the ladder", T0) })],
    ["uncommitted changes", resting({ hasUncommittedChanges: true })],
    ["an open unmerged PR", resting({ hasOpenPr: true })],
    ["committed work that never landed", resting({ hasUnlandedWork: true })],
    ["an escalated goal", resting({ goal: { ...newGoal("hard", T0), escalatedAt: T0 + 1 } })],
    ["an expired goal", resting({ goal: newGoal("stale", T0, 1_000), now: T0 + 5_000 })],
  ];

  it.each(cases)("a row with %s does not render gray", (_label, input) => {
    const out = withStallAttention(AGENTS, { a: "idle", b: "working" }, reportFor(input), allAlive);
    expect(out.a).toBe("blocked");
    // The actual requirement, asserted against the token table rather than a status name — a future
    // rename cannot quietly satisfy the letter of this test while breaking the rule.
    expect(AGENT_STATUS[out.a as AgentTabStatus].color).not.toBe(AGENT_STATUS.idle.color);
  });

  it.each(cases)("...and the same holds from the `unmerged` band, with %s", (_label, input) => {
    const out = withStallAttention(
      AGENTS,
      { a: "unmerged", b: "working" },
      reportFor(input),
      allAlive,
    );
    expect(out.a).toBe("blocked");
  });

  it("STUCK IS RED — the founder's second complaint, asserted as colour", () => {
    // "the user also asked why an agent that is STUCK is not red. Their expectation is that stuck
    // means red, not gray."
    const out = withStallAttention(
      AGENTS,
      { a: "idle" },
      reportFor(resting({ goal: newGoal("stuck on the merge", T0) })),
      allAlive,
    );
    expect(AGENT_STATUS[out.a as AgentTabStatus].color).toBe(AGENT_STATUS.waiting.color);
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
  const deadUnmergedRow: StallInput = {
    status: "unmerged", // what withUnmergedWork wrote over `stopped`
    now: T0,
    goal: newGoal("never finished", T0),
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
    const out = withStallAttention(
      AGENTS,
      { a: "idle" },
      reportFor(resting({ goal: newGoal("g", T0) })),
      () => undefined,
    );
    expect(out.a).toBe("blocked");
  });
});

describe("the red it produces is a red the human can ACKNOWLEDGE", () => {
  const stalled = resting({ goal: newGoal("land the branch", T0) });
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
          ? stallReport(resting({ goal: newGoal("g", T0) }))
          : id === "clean"
            ? stallReport(resting())
            : undefined,
      allAlive,
    );
    expect(out).toEqual({ stalled: "blocked", clean: "idle", busy: "working" });
  });
});
