// THE GATE MUST BE SATISFIABLE. That is the first property, and it is first on purpose.
//
// ── WHY THIS FILE OPENS WITH SATISFIABILITY RATHER THAN SAFETY ──────────────────────────────────
// A plan gate that can never reach zero open probes is WORSE than no gate: it strands every plan
// silently, and it does so while looking like it is working. This exact failure has shipped in this
// repo before, five times, on the knightwatch probe gate — beads sparkle-xmwxu and sparkle-tzb4m
// ("answering every probe makes a PR UNMERGEABLE"), sparkle-lsm0n ("unsatisfiable when several
// review rounds"), sparkle-9musi / sparkle-62eks / sparkle-0jpmw ("the answering window closes
// permanently when a NEWER review probe arrives").
//
// Every one of those is the same root cause: probe identity that is not stable across rounds, so a
// later round either invalidates earlier answers or renumbers the probes out from under them. That
// is why `Probe.id` here is `(round, index)` and why answers are recorded against that id — the
// property is structural, not a rule someone has to remember.
//
// ── THE OTHER HALF: SILENCE IS NEVER CONSENT ────────────────────────────────────────────────────
// The reviewer is spawned on demand and the doorbell transport has a VERIFIED silent-delivery
// failure (`fleet.inbox_send` returns `{ok:true}` and the message can still never arrive — observed
// 2026-08-14, an agent shipped a PR missing six follow-ups and said verbatim it never received
// them). So `ok:true` is not evidence of anything, an ACK is required, and a missing ACK is
// UNDELIVERED — never delivered-and-approved. Approval is only ever an explicit verdict.
import { describe, it, expect } from "vitest";
import {
  judgePlanReview,
  classifyPlanSurface,
  planNeedsProbe,
  WAKE_ACK_DEADLINE_MS,
  REVIEW_VERDICT_DEADLINE_MS,
  MAX_PROBE_ROUNDS,
  type PlanReviewLedger,
  type ProbeRound,
} from "./planReviewGate";

const T0 = 1_700_000_000_000;
/** When the reviewer acknowledged, in the helper below. Named because the VERDICT deadline runs
 *  from the ACK rather than from the mention — so every "the reviewer went silent" case has to be
 *  measured from here, and a case that measures from T0 instead silently tests nothing. */
const ACK_AT = T0 + 5_000;
/** The first instant a reviewer that acknowledged at {@link ACK_AT} counts as having gone silent. */
const PAST_REVIEW_DEADLINE = ACK_AT + REVIEW_VERDICT_DEADLINE_MS + 1;

/** A ledger for a plan that was mentioned at T0 and acknowledged promptly — the happy path's spine. */
function acked(over: Partial<PlanReviewLedger> = {}): PlanReviewLedger {
  return {
    planId: "plan-1",
    surface: "ordinary",
    mentionedAt: T0,
    ackAt: ACK_AT,
    rounds: [],
    answeredProbeIds: [],
    lastAnswerAt: null,
    approvedAt: null,
    ...over,
  };
}

/** One round of probes, ids derived the way the gate derives them: `r<round>#<index>`. */
function round(n: number, count: number, postedAt: number): ProbeRound {
  return {
    round: n,
    postedAt,
    probes: Array.from({ length: count }, (_, i) => ({
      id: `r${n}#${i + 1}`,
      text: `probe ${i + 1} of round ${n}`,
    })),
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 1. SATISFIABILITY — written before the gate, per the explicit instruction.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("the zero-open-probes state is REACHABLE", () => {
  // The baseline claim. If this cannot pass, nothing else about the gate matters: no plan ever
  // proceeds and the feature is a silent deadlock dressed up as review.
  it("reaches approval when every probe in the only round is answered and the verdict lands", () => {
    const r1 = round(1, 3, T0 + 30_000);
    const led = acked({
      rounds: [r1],
      answeredProbeIds: ["r1#1", "r1#2", "r1#3"],
      approvedAt: T0 + 60_000,
    });

    expect(judgePlanReview(led, T0 + 61_000).decision).toBe("approved");
  });

  // PAIRED with it — one unanswered probe and the SAME ledger does not approve. Without this, the
  // pass above could be explained by the gate approving everything it is shown.
  it("…and does NOT approve while even one probe of that round is unanswered", () => {
    const r1 = round(1, 3, T0 + 30_000);
    const led = acked({
      rounds: [r1],
      answeredProbeIds: ["r1#1", "r1#2"], // r1#3 outstanding
      approvedAt: T0 + 60_000, // even WITH a verdict comment present
    });

    const v = judgePlanReview(led, T0 + 61_000);
    expect(v.decision).toBe("wait");
    expect(v.openProbeIds).toEqual(["r1#3"]);
  });

  // The explicit-verdict rule. Every probe answered is necessary but NOT sufficient: approval is an
  // affirmative "0 open probes — approved" from the reviewer, never inferred from the absence of
  // open probes. Silence is not consent even when the board looks clean.
  it("does NOT approve on an empty probe list alone — approval must be explicit", () => {
    const led = acked({
      rounds: [round(1, 2, T0 + 30_000)],
      answeredProbeIds: ["r1#1", "r1#2"],
      approvedAt: null, // the reviewer never said the words
    });

    expect(judgePlanReview(led, T0 + 61_000).decision).toBe("wait");
  });
});

describe("the zero-open-probes state is STABLE — a later round cannot permanently close the window", () => {
  // THE KNIGHTWATCH BUG, REPRODUCED AS A TEST (sparkle-9musi / sparkle-62eks / sparkle-0jpmw). A
  // second review round arrived and the answers to the first round stopped counting, so the gate
  // could never be satisfied again no matter what anyone did. Here round 1's answers MUST survive
  // round 2 — the gate reopens (correctly: there are new concerns) but it is not poisoned.
  it("keeps round 1's answers valid when round 2 arrives", () => {
    const led = acked({
      rounds: [round(1, 2, T0 + 30_000), round(2, 1, T0 + 90_000)],
      answeredProbeIds: ["r1#1", "r1#2"],
      approvedAt: null,
    });

    const v = judgePlanReview(led, T0 + 100_000);
    expect(v.decision).toBe("wait");
    // Only the NEW probe is outstanding. If round 1's answers had been invalidated this would be
    // three ids, and the plan would be further from approval after answering than before.
    expect(v.openProbeIds).toEqual(["r2#1"]);
  });

  // …and answering the new round REACHES approval again. This is the half the knightwatch gate
  // could not do: the window reopened and then never closed. Reaching zero a second time is the
  // property, not merely counting correctly on the way there.
  it("…and re-reaches approval once the new round is answered and re-blessed", () => {
    const led = acked({
      rounds: [round(1, 2, T0 + 30_000), round(2, 1, T0 + 90_000)],
      answeredProbeIds: ["r1#1", "r1#2", "r2#1"],
      approvedAt: T0 + 120_000,
    });

    expect(judgePlanReview(led, T0 + 121_000).decision).toBe("approved");
  });

  // A STALE VERDICT MUST NOT APPROVE A NEWER ROUND. The mirror hazard of the one above: if approval
  // were a sticky boolean, a round-3 concern raised after the blessing would be silently overridden
  // by it — the gate would read "approved" while an unanswered objection sat on the record. The
  // verdict is only good for the probe set that existed when it was given.
  it("does not let a verdict predating a new round approve that round", () => {
    const led = acked({
      rounds: [round(1, 1, T0 + 30_000), round(2, 1, T0 + 200_000)],
      answeredProbeIds: ["r1#1"],
      approvedAt: T0 + 60_000, // blessed BEFORE round 2 existed
    });

    const v = judgePlanReview(led, T0 + 210_000);
    expect(v.decision).toBe("wait");
    expect(v.openProbeIds).toEqual(["r2#1"]);
  });

  // Answering is idempotent and order-free: an answer recorded for a probe id that no round carries
  // (a stale id from a superseded plan revision) must not crash the gate or count toward anything.
  it("ignores answers to probe ids no round carries", () => {
    const led = acked({
      rounds: [round(1, 1, T0 + 30_000)],
      answeredProbeIds: ["r1#1", "r9#7"],
      approvedAt: T0 + 60_000,
    });

    expect(judgePlanReview(led, T0 + 61_000).decision).toBe("approved");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 1b. THE DEADLINE MEASURES SILENCE, NOT ELAPSED TIME (roborev 65823, High).
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("an ACTIVE review is never killed by the verdict deadline", () => {
  // THE BUG THIS PINS. The verdict budget was anchored to `ackAt` and never advanced — but it is
  // the fall-through for EVERY post-ACK state, not just "no first probe set yet". So a review that
  // was progressing perfectly well died at ackAt + 10 min: on an ordinary surface that
  // auto-approved unattended edits while the reviewer was mid-sentence, and on a systemic one it
  // escalated a conversation nobody had abandoned. It also made rounds 2 and 3 practically
  // unreachable, which quietly contradicts MAX_PROBE_ROUNDS and the satisfiability property this
  // file opens with.
  //
  // The fix is to measure the REVIEWER'S SILENCE — time since its last word, or since the ball went
  // back to it — rather than time since the conversation began.
  it("waits when the reviewer posted a round recently, even though the ACK is long past", () => {
    const led = acked({
      surface: "ordinary",
      // Round 2 arrived 9 minutes after the ACK: recent, and the reviewer is clearly still working.
      rounds: [round(1, 1, ACK_AT + 60_000), round(2, 1, ACK_AT + 540_000)],
      answeredProbeIds: ["r1#1", "r2#1"],
      lastAnswerAt: ACK_AT + 560_000,
    });

    // Past the old ackAt-anchored budget, and nowhere near silent.
    expect(judgePlanReview(led, ACK_AT + REVIEW_VERDICT_DEADLINE_MS + 1).decision).toBe("wait");
  });

  // PAIRED on the one axis that matters: the SAME ledger, with the reviewer's last word genuinely
  // old. Now it is silence, and the timeout fires. Without this the case above could be explained by
  // the deadline having been removed rather than re-anchored.
  it("…and fires once the reviewer's last word IS old enough", () => {
    const led = acked({
      surface: "ordinary",
      rounds: [round(1, 1, ACK_AT + 60_000), round(2, 1, ACK_AT + 540_000)],
      answeredProbeIds: ["r1#1", "r2#1"],
      lastAnswerAt: ACK_AT + 560_000,
    });

    const v = judgePlanReview(led, ACK_AT + 560_000 + REVIEW_VERDICT_DEADLINE_MS + 1);
    expect(v.decision).toBe("proceed-unreviewed");
    expect(v.reason).toBe("review-timeout");
  });

  // The ball is in the REVIEWER'S court from the moment the last probe was answered, so that answer
  // restarts the clock. Otherwise a plan agent that took its time answering would burn the
  // reviewer's budget and the gate would time out the wrong party.
  it("restarts the clock when the plan agent answers, not only when the reviewer speaks", () => {
    const led = acked({
      surface: "systemic",
      rounds: [round(1, 1, ACK_AT + 10_000)],
      answeredProbeIds: ["r1#1"],
      lastAnswerAt: ACK_AT + REVIEW_VERDICT_DEADLINE_MS + 60_000, // a slow answer, but an answer
    });

    expect(judgePlanReview(led, ACK_AT + REVIEW_VERDICT_DEADLINE_MS + 120_000).decision).toBe("wait");
  });
});

describe("bounded rounds — the gate escalates rather than looping forever", () => {
  // Anti-loop. Without a cap, a reviewer and a plan agent can trade rounds indefinitely and the plan
  // never executes and never surfaces. The cap turns an infinite negotiation into one decision.
  it("escalates once the round cap is exceeded, whatever the surface", () => {
    const rounds = Array.from({ length: MAX_PROBE_ROUNDS + 1 }, (_, i) =>
      round(i + 1, 1, T0 + 30_000 * (i + 1)),
    );
    const led = acked({ surface: "ordinary", rounds, answeredProbeIds: [] });

    const v = judgePlanReview(led, T0 + 10_000_000);
    expect(v.decision).toBe("escalate");
    expect(v.reason).toBe("round-cap-exceeded");
  });

  // A CONVERGED REVIEW IS NOT A STUCK ONE (roborev 65823, Medium). The cap check ran BEFORE the
  // approval check, so a ledger past the cap escalated even when every probe was answered and the
  // reviewer had explicitly blessed it. That is the file's own opening failure — an unsatisfiable
  // gate — with the strand merely made loud instead of silent. The cap exists to end a negotiation
  // that is going nowhere, and a negotiation that ENDED is not going nowhere.
  it("does NOT escalate past the cap when the review actually converged", () => {
    const rounds = Array.from({ length: MAX_PROBE_ROUNDS + 1 }, (_, i) =>
      round(i + 1, 1, T0 + 30_000 * (i + 1)),
    );
    const led = acked({
      rounds,
      answeredProbeIds: rounds.map((r) => r.probes[0]!.id),
      approvedAt: T0 + 30_000 * (MAX_PROBE_ROUNDS + 2),
    });

    expect(judgePlanReview(led, T0 + 10_000_000).decision).toBe("approved");
  });

  // PAIRED: exactly AT the cap is still a live negotiation, not an escalation. An off-by-one here
  // would escalate every plan one round early, which is the same "trains everyone to ignore it"
  // failure as a too-tight deadline.
  it("…but not while it is exactly at the cap", () => {
    const rounds = Array.from({ length: MAX_PROBE_ROUNDS }, (_, i) =>
      round(i + 1, 1, T0 + 30_000 * (i + 1)),
    );
    const led = acked({ rounds, answeredProbeIds: [] });

    expect(judgePlanReview(led, T0 + 100_000).decision).toBe("wait");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 2. SILENCE — never consent, never a hang, and never the founder's problem by default.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("a missing ACK is UNDELIVERED, never delivered-and-approved", () => {
  // The transport lies. `inbox_send` returns {ok:true, messageId} on a message that never arrives —
  // verified 2026-08-14. So the ONLY evidence the reviewer heard us is its own ACK comment on the
  // bead, and its absence past the deadline means the doorbell did not ring.
  it("never approves a plan whose reviewer never acknowledged, however long it waits", () => {
    const led = acked({ ackAt: null, surface: "systemic" });

    const v = judgePlanReview(led, T0 + WAKE_ACK_DEADLINE_MS + 1);
    expect(v.decision).not.toBe("approved");
    expect(v.reason).toBe("no-ack");
  });

  // Before the deadline it simply waits — an un-ACKed plan is not yet a failure, and firing early is
  // how a deadline stops being believed.
  it("waits, rather than deciding, while the ACK deadline is still running", () => {
    const led = acked({ ackAt: null });

    expect(judgePlanReview(led, T0 + WAKE_ACK_DEADLINE_MS - 1).decision).toBe("wait");
  });

  // AN UNDELIVERED MENTION SPLITS BY SURFACE TOO, exactly like a review timeout — and this pair was
  // MISSING until mutation-check proved it (the surface test on the no-ACK path could be inverted
  // with the whole suite still green). The two failures are the same fact from the gate's point of
  // view: no verdict arrived and we cannot vouch for the plan. It would be incoherent for an
  // unanswered doorbell to be treated more harshly than an acknowledged reviewer that then went
  // silent — the second is strictly more evidence than the first.
  it("ESCALATES an un-acknowledged SYSTEMIC plan", () => {
    const led = acked({ ackAt: null, surface: "systemic" });

    const v = judgePlanReview(led, T0 + WAKE_ACK_DEADLINE_MS + 1);
    expect(v.decision).toBe("escalate");
    expect(v.reason).toBe("no-ack");
    expect(v.record).toContain("UNDELIVERED");
  });

  // PAIRED on the one axis that differs. An ordinary plan proceeds on the record rather than
  // becoming the founder's problem — amendment B applies to both timeout paths, not just one.
  it("…and PROCEEDS WITHOUT REVIEW on an un-acknowledged ORDINARY plan, recording that it did", () => {
    const led = acked({ ackAt: null, surface: "ordinary" });

    const v = judgePlanReview(led, T0 + WAKE_ACK_DEADLINE_MS + 1);
    expect(v.decision).toBe("proceed-unreviewed");
    expect(v.reason).toBe("no-ack");
    expect(v.record).toContain("without @improve review");
    // "never acknowledged" must stay legible in the record — this is the case where the reviewer may
    // never have heard us at all, which is a different story from one that read the plan and stalled.
    expect(v.record).toContain("never acknowledged");
  });
});

describe("a timeout splits by SURFACE — the founder is not the wire for ordinary plans", () => {
  // The concierge's amendment B, and the reason for it in one line: "silence -> escalate to the
  // founder" reintroduces him as the wire, which is the entire thing being removed. The founder's
  // own rule is NOTIFY, DON'T BLOCK. So only the expensive misses reach him.
  it("ESCALATES a systemic plan whose reviewer went silent", () => {
    const led = acked({ surface: "systemic", rounds: [] });

    const v = judgePlanReview(led, PAST_REVIEW_DEADLINE);
    expect(v.decision).toBe("escalate");
    expect(v.reason).toBe("review-timeout");
  });

  // PAIRED on the one axis that differs: the same silence, the same deadline, an ORDINARY surface.
  // It proceeds — visibly and on the record — rather than asking him.
  it("…and PROCEEDS WITHOUT REVIEW on an ordinary plan, recording that it did", () => {
    const led = acked({ surface: "ordinary", rounds: [] });

    const v = judgePlanReview(led, PAST_REVIEW_DEADLINE);
    expect(v.decision).toBe("proceed-unreviewed");
    expect(v.reason).toBe("review-timeout");
    // The audit sentence is part of the decision, not left to the caller to phrase: "proceeded
    // anyway" must be distinguishable from "never read it", and that distinction has to survive in
    // the bead comment a human reads weeks later.
    expect(v.record).toContain("without @improve review");
    expect(v.record).toContain("timed out");
  });

  // A plan still inside its review budget waits regardless of surface — the deadline is what
  // separates "thinking" from "silent", and nothing else may.
  it("waits while the review deadline is still running, on either surface", () => {
    expect(judgePlanReview(acked({ surface: "systemic" }), T0 + 60_000).decision).toBe("wait");
    expect(judgePlanReview(acked({ surface: "ordinary" }), T0 + 60_000).decision).toBe("wait");
  });

  // AN OPEN PROBE IS NOT SILENCE. The reviewer answered — it raised a concern — so the timeout rule
  // must not fire and quietly proceed past an objection nobody resolved. This is the case where
  // "proceed-unreviewed" would be actively wrong, and it is the one most easily got backwards.
  it("never proceeds past an OPEN probe by calling it a timeout", () => {
    const led = acked({
      surface: "ordinary",
      rounds: [round(1, 1, T0 + 30_000)],
      answeredProbeIds: [],
    });

    const v = judgePlanReview(led, PAST_REVIEW_DEADLINE);
    expect(v.decision).not.toBe("proceed-unreviewed");
    expect(v.decision).not.toBe("approved");
  });
});

describe("the deadlines are named, ordered, and honest about being provisional", () => {
  // Amendment A: the ~60s wake ACK was too tight — a cold spawn that must also read a plan blows it
  // routinely, and a deadline missed most of the time trains everyone to ignore the escalation.
  // Split: the ACK is on SPAWN-START (genuinely seconds), the VERDICT gets the longer budget.
  it("gives the verdict a strictly longer budget than the ACK", () => {
    expect(REVIEW_VERDICT_DEADLINE_MS).toBeGreaterThan(WAKE_ACK_DEADLINE_MS);
  });

  // Both are constants rather than magic numbers precisely so the miss rate can be measured and the
  // values replaced with evidence. Pinning them here means a change is a deliberate edit with this
  // test in front of it, not a silent tuning.
  it("holds the provisional values the design was agreed on", () => {
    expect(WAKE_ACK_DEADLINE_MS).toBe(90_000);
    expect(REVIEW_VERDICT_DEADLINE_MS).toBe(600_000);
  });

  // THE VERDICT BUDGET RUNS FROM THE ACK, NOT FROM THE MENTION — which is the whole reason the two
  // deadlines were split. A slow cold spawn must not eat the reviewing time; if this ran from the
  // mention, a reviewer that took 80s to wake would have 80s less to think, and the split would have
  // bought nothing. Found by the first run of this file, so it is pinned rather than left implicit.
  it("measures the verdict deadline from the ACK, so a slow spawn does not eat the review budget", () => {
    const slowSpawn = acked({ ackAt: T0 + WAKE_ACK_DEADLINE_MS - 1, surface: "ordinary" });

    // Already past the deadline had it run from the MENTION…
    expect(judgePlanReview(slowSpawn, T0 + REVIEW_VERDICT_DEADLINE_MS + 1).decision).toBe("wait");
    // …and it fires only once the budget has run from the ACK.
    expect(
      judgePlanReview(slowSpawn, slowSpawn.ackAt! + REVIEW_VERDICT_DEADLINE_MS + 1).decision,
    ).toBe("proceed-unreviewed");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 3. SURFACE + SCOPE — which plans are probed, and which timeouts reach the founder.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("systemic surfaces are classified from the paths a plan touches", () => {
  it.each([
    ["/.github/workflows/ci.yml"],
    ["/.github/workflows/release.yml"],
    ["scripts/lib/ci-gate.sh"],
    ["scripts/runner/setup-self-hosted-runner.sh"],
    [".beads/config.yaml"],
    ["apps/desktop/src-tauri/src/concierge.rs"],
  ])("treats %s as systemic", (path) => {
    expect(classifyPlanSurface([path])).toBe("systemic");
  });

  // PAIRED with the table above: an ordinary application path is NOT systemic. Without this, a
  // classifier that answered "systemic" unconditionally would pass every case above — and would
  // route every ordinary timeout to the founder, which is exactly amendment B's complaint.
  it("treats an ordinary application path as ordinary", () => {
    expect(classifyPlanSurface(["apps/desktop/src/components/Badge.tsx"])).toBe("ordinary");
  });

  // ONE systemic path in a large ordinary plan makes the whole plan systemic. The risk is not
  // diluted by the plan being mostly harmless.
  it("is systemic if ANY touched path is, however many ordinary ones surround it", () => {
    expect(
      classifyPlanSurface([
        "apps/desktop/src/a.ts",
        "apps/desktop/src/b.ts",
        "scripts/lib/ci-gate.sh",
      ]),
    ).toBe("systemic");
  });

  // THE OVER-MATCH THIS PINS (roborev 65823, Medium). The auth/credentials pattern was unanchored,
  // so it matched the substring anywhere and classified 109 of 5241 tracked files as systemic —
  // every "author…", "authority…" and "…tokens" path. The consequence is NOT fail-safe: a systemic
  // misclassification routes its timeout to the founder, which is the exact "reinstate him as the
  // wire" outcome amendment B removed, and it dilutes the escalation signal until nobody reads it.
  // These are the real repo paths that were being caught.
  it.each([
    ["apps/desktop/src/engine/turnEndAuthority.ts"],
    ["apps/desktop/src/services/dispatchAuthority.ts"],
    ["apps/desktop/src/components/cssTokens.test.ts"],
    ["apps/desktop/scripts/extract-design-tokens.mjs"],
    ["PRD/sparkle/app-authored-agent-pills.md"],
    ["apps/desktop/src/components/AuthorPanel.tsx"],
    ["apps/desktop/src/services/authoringHelpers.ts"],
    ["packages/ui/designTokens.ts"],
  ])("does NOT treat %s as systemic", (path) => {
    expect(classifyPlanSurface([path])).toBe("ordinary");
  });

  // THE POSITIVE HALF OF THE SAME AXIS (roborev 65827, High). The first narrowing over-corrected in
  // the FAIL-OPEN direction — requiring a separator on BOTH sides excluded camelCase, which is how
  // most auth code in this repo is actually spelled, so `authStore.ts` and `credentialHealth.ts`
  // became ORDINARY and a plan touching them would proceed unreviewed on reviewer silence. That is
  // strictly worse than the over-match it replaced: the over-match wasted the founder's attention,
  // this one hands unattended edits to credential code.
  //
  // It was invisible because the only positive assertion was `authTokens.ts`, which a DIFFERENT
  // regex matched — so the narrowed pattern was pinned in the negative direction only. Without a
  // positive and a negative assertion on the SAME axis, either direction can regress in silence,
  // which is why these are real repo paths rather than invented ones.
  it.each([
    ["apps/desktop/src/stores/authStore.ts"],
    ["apps/desktop/src/stores/cloudAuthStore.ts"],
    ["apps/desktop/src/services/authRecovery.ts"],
    ["apps/desktop/src/services/claudeAuthSignal.ts"],
    ["apps/desktop/src/services/credentialHealth.ts"],
    ["apps/desktop/src/guard/secretStagingGuard.ts"],
    ["apps/desktop/src/components/AuthGate.tsx"],
    ["apps/desktop/src/dev/devBypassAuth.ts"],
    ["apps/orchestration/src/lib/resolveAuth.ts"],
    ["apps/orchestration/src/routes/claudeAuth.ts"],
    ["apps/orchestration/src/lib/desktopToken.ts"],
    ["apps/orchestration/src/lib/githubToken.ts"],
    ["apps/web/src/app/(auth)/paywall/actions.ts"],
    ["apps/desktop/src/services/authTokens.ts"],
    // Credential-bearing without living under an `auth/` directory — a device push token and a
    // support magic-link route segment. Both are deliberate judgement calls taken on the safe side,
    // pinned here so the decision is visible rather than an accident of the regex.
    ["apps/orchestration/src/routes/pushTokens.ts"],
    ["apps/web/src/app/api/support/t/[token]/route.ts"],
  ])("treats %s as systemic", (path) => {
    expect(classifyPlanSurface([path])).toBe("systemic");
  });
});

describe("which plans warrant a probe — when unsure, PROBE", () => {
  // The stated default. A skipped probe on a systemic plan is the expensive miss, and the founder is
  // token-insensitive, so the bias is deliberate and one-directional.
  it("probes a systemic plan even when it is tiny and the agent called it trivial", () => {
    expect(
      planNeedsProbe({ paths: ["scripts/lib/ci-gate.sh"], agentMarkedTrivial: true, hasTests: true }),
    ).toBe(true);
  });

  // The three exemptions, exactly as specified — and each has to be genuinely narrow.
  it("skips a single-file localised fix that carries tests", () => {
    expect(
      planNeedsProbe({
        paths: ["apps/desktop/src/components/Badge.tsx"],
        agentMarkedTrivial: false,
        hasTests: true,
      }),
    ).toBe(false);
  });

  // …but a single file WITHOUT tests is not the exemption. The exemption is "localised fix WITH
  // tests"; dropping the tests half would make it "any one-file change", which is most changes.
  it("…but probes that same single file when it carries no tests", () => {
    expect(
      planNeedsProbe({
        paths: ["apps/desktop/src/components/Badge.tsx"],
        agentMarkedTrivial: false,
        hasTests: false,
      }),
    ).toBe(true);
  });

  it("probes anything above trivial size", () => {
    const paths = Array.from({ length: 6 }, (_, i) => `apps/desktop/src/f${i}.ts`);
    expect(planNeedsProbe({ paths, agentMarkedTrivial: false, hasTests: true })).toBe(true);
  });

  // An agent's own "this is trivial" is honoured ONLY on an ordinary, small, tested plan — it is a
  // hint from the party with the incentive to skip review, so it can never override the surface.
  it("honours an agent's trivial mark only on an ordinary, tested, single-file plan", () => {
    expect(
      planNeedsProbe({ paths: ["apps/desktop/src/f.ts"], agentMarkedTrivial: true, hasTests: false }),
    ).toBe(false);
    expect(
      planNeedsProbe({
        paths: ["apps/desktop/src-tauri/src/concierge.rs"],
        agentMarkedTrivial: true,
        hasTests: false,
      }),
    ).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 4. THE RECORD — an overruled review stays readable, weeks later, by a human who was not there.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("an overruled review stays on the record", () => {
  // "Proceeded anyway" and "never read it" must never render the same way. This is the whole reason
  // the decision carries its own audit sentence instead of leaving the caller to phrase one.
  it("distinguishes proceeding-without-review from a clean approval", () => {
    const timedOut = judgePlanReview(acked({ surface: "ordinary" }), PAST_REVIEW_DEADLINE);
    const approved = judgePlanReview(
      acked({
        rounds: [round(1, 1, T0 + 10_000)],
        answeredProbeIds: ["r1#1"],
        approvedAt: T0 + 20_000,
      }),
      T0 + 30_000,
    );

    expect(timedOut.record).not.toEqual(approved.record);
    expect(approved.record).toContain("0 open probes");
    expect(timedOut.record).toContain("without @improve review");
  });

  // The notify-don't-block sentence the founder reads in the concierge chat, carrying the count he
  // asked to see. He is being told, not asked.
  it("names the resolved probe count on an approval, for the concierge-chat notice", () => {
    const led = acked({
      rounds: [round(1, 2, T0 + 10_000), round(2, 1, T0 + 20_000)],
      answeredProbeIds: ["r1#1", "r1#2", "r2#1"],
      approvedAt: T0 + 30_000,
    });

    expect(judgePlanReview(led, T0 + 31_000).record).toContain("3 probes resolved");
  });
});
