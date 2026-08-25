import { describe, expect, it } from "vitest";
import {
  AUTO_MERGE_FAILURE_COOLDOWN_MS,
  chooseAutoMerge,
  resolveAutoMergeConfig,
  type AutoMergeCandidate,
} from "./autoMerge";
import { prMergeReadiness } from "./openPrs";

/** A PR that `prMergeReadiness` calls GREEN. Every non-ready fixture below is this, minus one thing. */
const ready = (number: number, over: Partial<AutoMergeCandidate> = {}): AutoMergeCandidate => ({
  number,
  checks: "passing",
  mergeable: "mergeable",
  mergeStateStatus: "clean",
  headRefOid: `sha-${number}`,
  ...over,
});

const ON = resolveAutoMergeConfig({ enabled: true });

describe("resolveAutoMergeConfig", () => {
  it("ships OFF, because this merges to main unattended", () => {
    expect(resolveAutoMergeConfig().enabled).toBe(false);
    expect(resolveAutoMergeConfig({}).enabled).toBe(false);
  });

  it("requires an explicit `true` — a truthy non-boolean does not enable it", () => {
    expect(resolveAutoMergeConfig({ enabled: 1 as unknown as boolean }).enabled).toBe(false);
    expect(resolveAutoMergeConfig({ enabled: true }).enabled).toBe(true);
  });

  it("falls back rather than propagating a cooldown that would DELETE the backoff", () => {
    // NaN compares false against every comparison, so propagating it would silently retry forever.
    expect(resolveAutoMergeConfig({ failureCooldownMs: NaN }).failureCooldownMs).toBe(
      AUTO_MERGE_FAILURE_COOLDOWN_MS,
    );
    expect(resolveAutoMergeConfig({ failureCooldownMs: -1 }).failureCooldownMs).toBe(
      AUTO_MERGE_FAILURE_COOLDOWN_MS,
    );
    expect(resolveAutoMergeConfig({ failureCooldownMs: 0 }).failureCooldownMs).toBe(0);
  });
});

describe("chooseAutoMerge — the one-merge-per-tick guarantee", () => {
  // THE LOAD-BEARING ASSERTION. Every merge to main fires a ~14-job per-SHA CI run that is never
  // cancelled, against a ~20-job concurrency ceiling. A decision that returned a BATCH would inject
  // ~224 jobs in one burst. Written as an exact identity — `kind: "merge"` naming ONE pr — because
  // "at least one PR is merged" would pass against a batching implementation and prove nothing.
  it("returns exactly ONE pr when several are ready, and says how many it deferred", () => {
    const decision = chooseAutoMerge([ready(10), ready(11), ready(12)], ON);
    expect(decision.kind).toBe("merge");
    if (decision.kind !== "merge") throw new Error("unreachable");
    // A single `pr`, not an array — the shape itself cannot express a batch.
    expect(decision.pr.number).toBe(10);
    expect(decision.readyCount).toBe(3);
    expect(decision.deferred).toBe(2);
  });

  it("drains oldest-first, whatever order the rows arrive in", () => {
    const decision = chooseAutoMerge([ready(99), ready(7), ready(41)], ON);
    expect(decision.kind === "merge" && decision.pr.number).toBe(7);
  });

  it("carries the head OID, so a branch that moved is refused rather than merged", () => {
    const decision = chooseAutoMerge([ready(10)], ON);
    expect(decision.kind === "merge" && decision.pr.headRefOid).toBe("sha-10");
  });
});

describe("chooseAutoMerge — what it refuses to merge", () => {
  it("does nothing at all when disabled, even with a ready PR waiting", () => {
    expect(chooseAutoMerge([ready(10)], resolveAutoMergeConfig({ enabled: false }))).toEqual({
      kind: "disabled",
    });
  });

  // The founder's stated bar. `prMergeReadiness` ranks probes ABOVE every check state, so this PR
  // is green on CI and still must not merge.
  it("never merges a PR with an unanswered [blocking] probe", () => {
    const probeBlocked = ready(10, { probes: { unansweredBlocking: 1, overridden: false, applicable: true } });
    expect(chooseAutoMerge([probeBlocked], ON).kind).toBe("none-ready");
  });

  it("merges a probe-blocked PR only once the probes are answered", () => {
    const answered = ready(10, { probes: { unansweredBlocking: 0, overridden: false, applicable: true } });
    expect(chooseAutoMerge([answered], ON).kind).toBe("merge");
  });

  it("skips a probe-blocked PR but still merges a clean one beside it", () => {
    const blocked = ready(5, { probes: { unansweredBlocking: 2, overridden: false, applicable: true } });
    const clean = ready(9);
    const decision = chooseAutoMerge([blocked, clean], ON);
    // 5 sorts first and would win on age alone — it is excluded on readiness, not on order.
    expect(decision.kind === "merge" && decision.pr.number).toBe(9);
    expect(decision.kind === "merge" && decision.readyCount).toBe(1);
  });

  it("never merges on failing or still-running checks", () => {
    expect(chooseAutoMerge([ready(10, { checks: "failing" })], ON).kind).toBe("none-ready");
    expect(chooseAutoMerge([ready(10, { checks: "pending" })], ON).kind).toBe("none-ready");
    expect(chooseAutoMerge([ready(10, { failingChecks: ["Node — shell"] })], ON).kind).toBe("none-ready");
    expect(chooseAutoMerge([ready(10, { pendingChecks: ["Node — build"] })], ON).kind).toBe("none-ready");
  });

  it("never merges a conflicting, draft, behind, or unsettled PR", () => {
    expect(chooseAutoMerge([ready(10, { mergeable: "conflicting" })], ON).kind).toBe("none-ready");
    expect(chooseAutoMerge([ready(10, { mergeStateStatus: "dirty" })], ON).kind).toBe("none-ready");
    expect(chooseAutoMerge([ready(10, { mergeStateStatus: "draft" })], ON).kind).toBe("none-ready");
    expect(chooseAutoMerge([ready(10, { mergeStateStatus: "behind" })], ON).kind).toBe("none-ready");
    expect(chooseAutoMerge([ready(10, { mergeable: "unknown" })], ON).kind).toBe("none-ready");
  });

  it("never merges where the user has no merge rights", () => {
    expect(chooseAutoMerge([ready(10, { viewerCanMerge: false })], ON).kind).toBe("none-ready");
  });

  it("reports how many it considered when nothing is ready", () => {
    const decision = chooseAutoMerge([ready(1, { checks: "failing" }), ready(2, { checks: "pending" })], ON);
    expect(decision).toEqual({ kind: "none-ready", considered: 2 });
  });

  it("an empty list is none-ready, not a crash", () => {
    expect(chooseAutoMerge([], ON)).toEqual({ kind: "none-ready", considered: 0 });
  });
});

describe("chooseAutoMerge — 'no checks at all' is NOT green (roborev 59679)", () => {
  // `prMergeReadiness` calls `checks: "none"` READY ("No checks on this PR, and GitHub reports it
  // clean"), and Rust's classify_checks maps an EMPTY rollup to "none". Inheriting that would merge
  // a PR whose CI never ran — a fresh push before checks register, a workflow that failed to
  // trigger, an Actions outage, or a CONFLICTING PR, which never gets a pull_request event and so
  // sits at [] forever. This is the same fail-open scripts/pr-checks.sh closed one commit earlier.
  it("refuses a PR with no checks at all, even though the UI predicate calls it ready", () => {
    const noChecks = ready(10, { checks: "none" });
    // The inherited predicate really does say ready — so this test is pinning an OVERRIDE, not
    // restating something that was already true.
    expect(prMergeReadiness(noChecks).tone).toBe("ready");
    expect(chooseAutoMerge([noChecks], ON).kind).toBe("none-ready");
  });

  it("still merges a PR with positively-passing checks", () => {
    expect(chooseAutoMerge([ready(10, { checks: "passing" })], ON).kind).toBe("merge");
  });

  it("skips the no-checks PR and merges a passing one behind it", () => {
    const decision = chooseAutoMerge([ready(3, { checks: "none" }), ready(8)], ON);
    expect(decision.kind === "merge" && decision.pr.number).toBe(8);
  });

  it("a repo that genuinely runs no CI can opt in", () => {
    const optedIn = resolveAutoMergeConfig({ enabled: true, requirePassingChecks: false });
    expect(chooseAutoMerge([ready(10, { checks: "none" })], optedIn).kind).toBe("merge");
  });

  it("only an explicit false relaxes it — an absent or garbled value stays strict", () => {
    expect(resolveAutoMergeConfig({ enabled: true }).requirePassingChecks).toBe(true);
    expect(
      resolveAutoMergeConfig({ enabled: true, requirePassingChecks: 0 as unknown as boolean })
        .requirePassingChecks,
    ).toBe(true);
  });
});

describe("chooseAutoMerge — an UNPINNABLE head is NOT auto-merged (bead sparkle-vo82zo)", () => {
  // The runner forwards `pr.headRefOid` to `mergePr` → `gh pr merge --match-head-commit`, and that
  // flag is what refuses a merge when the branch moved since this decision read it. But the flag is
  // DROPPED for an empty/absent oid, so an unattended merge with no pinnable head lands the LIVE
  // head unguarded — the exact race: a fix pushed while the merge settled is silently absent from
  // main afterwards, PR reads MERGED, branch recreated by the push, nothing looks wrong.

  it("refuses a ready PR whose head oid is absent — even though the UI predicate calls it ready", () => {
    const noOid = ready(10, { headRefOid: undefined });
    // `prMergeReadiness` does not read headRefOid (PrJudgeable does not carry it), so it still says
    // ready — this pins an OVERRIDE, not something already true before the change.
    expect(prMergeReadiness(noOid).tone).toBe("ready");
    expect(chooseAutoMerge([noOid], ON).kind).toBe("none-ready");
  });

  it("refuses an empty or whitespace-only head oid (the value that drops --match-head-commit)", () => {
    expect(chooseAutoMerge([ready(10, { headRefOid: "" })], ON).kind).toBe("none-ready");
    expect(chooseAutoMerge([ready(10, { headRefOid: "   " })], ON).kind).toBe("none-ready");
  });

  it("PAIRED: the identical PR merges once it carries a pinnable head — proving the oid is what gates", () => {
    // Same PR, one field different, to pin the CAUSE rather than mere absence (AGENTS.md).
    expect(chooseAutoMerge([ready(10, { headRefOid: undefined })], ON).kind).toBe("none-ready");
    expect(chooseAutoMerge([ready(10, { headRefOid: "sha-10" })], ON).kind).toBe("merge");
  });

  it("skips the unpinnable PR and merges a pinnable one behind it", () => {
    const decision = chooseAutoMerge([ready(3, { headRefOid: "" }), ready(8)], ON);
    // 3 sorts first and would win on age — it is excluded on the missing head, not on order.
    expect(decision.kind === "merge" && decision.pr.number).toBe(8);
    expect(decision.kind === "merge" && decision.pr.headRefOid).toBe("sha-8");
    expect(decision.kind === "merge" && decision.readyCount).toBe(1);
  });
});

describe("chooseAutoMerge — a DISMISSED PR is never auto-merged (roborev 59679)", () => {
  // Dismissal is the app's durable "not now", and its revival rule deliberately keeps a PR dismissed
  // even when it is GREEN — so a dismissed PR is exactly the shape this decision would select.
  it("does not merge a ready PR the user has dismissed", () => {
    expect(chooseAutoMerge([ready(10)], ON, { dismissed: new Set([10]) }).kind).toBe("none-ready");
  });

  it("merges a non-dismissed PR beside a dismissed one", () => {
    const decision = chooseAutoMerge([ready(4), ready(9)], ON, { dismissed: new Set([4]) });
    expect(decision.kind === "merge" && decision.pr.number).toBe(9);
  });

  it("an absent dismissal set does not block anything", () => {
    expect(chooseAutoMerge([ready(10)], ON, {}).kind).toBe("merge");
    expect(chooseAutoMerge([ready(10)], ON, { dismissed: new Set() }).kind).toBe("merge");
  });
});

describe("chooseAutoMerge — an UNKNOWN probe read (roborev 59697)", () => {
  // PINNED DELIBERATELY, not inherited by accident. A `null` count means the probe read FAILED, and
  // `prMergeReadiness` falls through on it. That is safe here only because Rust's `decide`
  // (knightwatch.rs:948-950) states "UNKNOWN is a read FAILURE, and it blocks", and merge_pr runs
  // knightwatch::enforce before shelling out — so the merge is REFUSED there and the failure
  // backoff absorbs the wasted attempt.
  //
  // If the Rust gate ever stops blocking on UNKNOWN, THIS test is the assumption that has to change
  // — which is the whole reason it asserts the current behaviour rather than leaving it unpinned.
  it("is still selected here, because the Rust gate is what refuses it", () => {
    const unknownRead = ready(10, { probes: { unansweredBlocking: null, overridden: false, applicable: true } });
    expect(chooseAutoMerge([unknownRead], ON).kind).toBe("merge");
  });
});

describe("chooseAutoMerge — failure backoff", () => {
  const T = 1_000_000;

  it("leaves a PR alone while its cooldown is still running", () => {
    const decision = chooseAutoMerge([ready(10)], ON, { failures: { 10: T }, now: T + 1 });
    expect(decision).toEqual({ kind: "all-cooling-down", considered: 1, readyCount: 1 });
  });

  it("retries the moment the cooldown has elapsed, not a tick later", () => {
    const at = T + AUTO_MERGE_FAILURE_COOLDOWN_MS;
    expect(chooseAutoMerge([ready(10)], ON, { failures: { 10: T }, now: at }).kind).toBe("merge");
    expect(chooseAutoMerge([ready(10)], ON, { failures: { 10: T }, now: at - 1 }).kind).toBe("all-cooling-down");
  });

  it("passes over a cooling PR to merge a healthy one behind it", () => {
    const decision = chooseAutoMerge([ready(3), ready(8)], ON, { failures: { 3: T }, now: T + 1 });
    expect(decision.kind === "merge" && decision.pr.number).toBe(8);
  });

  it("a corrupt cooldown record cannot retire a PR permanently", () => {
    expect(chooseAutoMerge([ready(10)], ON, { failures: { 10: NaN }, now: T }).kind).toBe("merge");
    expect(chooseAutoMerge([ready(10)], ON, { failures: { 10: undefined as unknown as number }, now: T }).kind).toBe("merge");
  });

  it("a failure on one PR does not cool down any other", () => {
    const decision = chooseAutoMerge([ready(4), ready(5)], ON, { failures: { 4: T }, now: T + 1 });
    expect(decision.kind === "merge" && decision.pr.number).toBe(5);
  });
});
