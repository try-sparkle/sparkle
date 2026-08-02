import { describe, it, expect, beforeEach } from "vitest";
import {
  AI_SERVICE_DEGRADED_THRESHOLD,
  HEALTHY_SERVICE,
  RUN_MAX_GAP_MS,
  SERVICE_DEGRADED_MAX_AGE_MS,
  isServiceDegraded,
  classifyServiceFailure,
  reduceFailure,
  reduceSuccess,
  useAiServiceHealthStore,
  type AiServiceHealth,
} from "./aiServiceHealthStore";

/** Fold n genuine service failures (same reason) into a fresh state. */
function failTimes(n: number, reason: "unreachable" | "rate_limited"): AiServiceHealth {
  let s = HEALTHY_SERVICE;
  for (let i = 0; i < n; i += 1) s = reduceFailure(s, { kind: "degrade", reason }, NOW);
  return s;
}

const NOW = 1_700_000_000_000;

describe("classifyServiceFailure", () => {
  it("degrades on every 5xx the proxy surfaces, as 'unreachable'", () => {
    for (const code of [500, 502, 503, 504, 529, 599]) {
      expect(classifyServiceFailure(`ai request failed (HTTP ${code})`)).toEqual({
        kind: "degrade",
        reason: "unreachable",
      });
    }
  });

  it("degrades on a throttled vendor as 'rate_limited', distinct from unreachable", () => {
    // Repointed with the transport: the `(HTTP nnn)` shapes came from the server-side proxy, which
    // is gone. claude_oneshot emits `ai_rate_limited` for the CLI's own 429/529.
    expect(classifyServiceFailure("ai_rate_limited")).toEqual({
      kind: "degrade",
      reason: "rate_limited",
    });
  });

  it("degrades on a wedged CLI, and on one that produced no usable output at all", () => {
    expect(classifyServiceFailure("ai_timeout")).toEqual({ kind: "degrade", reason: "unreachable" });
    // A corrupt install, an unresolvable shebang, an OOM kill, or a flag removed by a CLI upgrade —
    // a permanent 100%-failure state, which is exactly what this store exists to surface.
    expect(classifyServiceFailure("ai request failed: claude exited Some(127): not found")).toEqual({
      kind: "degrade",
      reason: "unreachable",
    });
  });

  // THE distinction the detector depends on. `ai_busy` and `ai_timeout` come from the SAME wedged
  // CLI — it holds every slot, so concurrent callers are refused instantly while the wedged ones
  // time out one by one. If ai_busy RESET the run (kind: "ignore") instead of leaving it alone, the
  // interleaving would zero the very run the timeouts accumulate and the banner would never fire.
  it("treats a saturated pool as NEUTRAL, never as evidence of health", () => {
    expect(classifyServiceFailure("ai_busy")).toEqual({ kind: "neutral" });
  });

  it("an ai_busy burst cannot cancel the run a wedged CLI is accumulating", () => {
    let st = { ...HEALTHY_SERVICE };
    for (let i = 0; i < AI_SERVICE_DEGRADED_THRESHOLD; i += 1) {
      st = reduceFailure(st, classifyServiceFailure("ai_busy"), NOW);
      st = reduceFailure(st, classifyServiceFailure("ai_timeout"), NOW);
    }
    expect(st.degraded).toBe(true);
    expect(st.reason).toBe("unreachable");
  });

  it("IGNORES the local transport sentinel — offline is OfflineBanner's, not the service's", () => {
    // Finding: `ai_unreachable` means the machine has no network path; counting it would blame
    // Sparkle's service for the user's dead link and stack a banner on top of OfflineBanner.
    expect(classifyServiceFailure("ai_unreachable")).toEqual({ kind: "ignore" });
  });

  it("ignores an answer that is not a service problem — the CLI replied, so reset the run", () => {
    // These are per-request outcomes the CLI produced: the transport works, this one call was wrong.
    for (const e of ["ai_prompt_too_large", "ai_empty_reply"]) {
      expect(classifyServiceFailure(e)).toEqual({ kind: "ignore" });
    }
    expect(classifyServiceFailure("upstream returned 502 for the request")).toEqual({ kind: "ignore" });
    expect(classifyServiceFailure("")).toEqual({ kind: "ignore" });
  });

  it("YIELDS to the more specific banners rather than double-warning", () => {
    // $0 user balance → ZeroCreditBanner; provider-account sentinel → ProviderUnavailableBanner.
    expect(classifyServiceFailure("insufficient_credits:0")).toEqual({ kind: "yield" });
    expect(classifyServiceFailure("insufficient_credits:1234")).toEqual({ kind: "yield" });
    expect(classifyServiceFailure("ai_unconfigured")).toEqual({ kind: "yield" });
    expect(classifyServiceFailure("ai_unconfigured:provider_unfunded")).toEqual({ kind: "yield" });
    expect(classifyServiceFailure("ai_unconfigured:provider_key_rejected")).toEqual({ kind: "yield" });
  });

  it("YIELDS on the user's OWN account state — a spent allowance is not a service outage", () => {
    // The 2026-08-02 shape, and the one the whole incident turned on. A spent Claude subscription
    // allowance is a fact about the USER'S account, exactly like a $0 Sparkle balance: it has its
    // own banner (ProviderUnavailableBanner: "Claude usage limit reached — resumes when it resets")
    // which names the cause and says it clears itself. This store must step aside, never accumulate
    // it toward "the product is failing".
    expect(classifyServiceFailure("claude_usage_limit")).toEqual({ kind: "yield" });
    expect(classifyServiceFailure("claude_not_authenticated")).toEqual({ kind: "yield" });
  });

  it("a run of account-state rejections can NEVER light this banner", () => {
    // The end-to-end statement of the bug: for ~40 minutes every call came back as the user's own
    // allowance being spent, and each one was counted as a service failure. Whatever the run
    // length, account state must leave this detector at rest.
    let s: AiServiceHealth = { ...HEALTHY_SERVICE };
    for (let i = 0; i < AI_SERVICE_DEGRADED_THRESHOLD * 3; i += 1) {
      s = reduceFailure(s, classifyServiceFailure("claude_usage_limit"), NOW + i * 1_000);
    }
    expect(s.degraded).toBe(false);
    expect(s.consecutiveFailures).toBe(0);
    expect(s).toEqual(HEALTHY_SERVICE);
  });

  it("an account-state rejection RETIRES a banner an earlier real outage had lit", () => {
    // The recovery direction, and the one that mattered on the day: the CLI genuinely wedged, THEN
    // the account hit its limit. The vague "it keeps failing" bar must hand over to the specific,
    // actionable one rather than sitting on top of it.
    let s: AiServiceHealth = failTimes(AI_SERVICE_DEGRADED_THRESHOLD, "unreachable");
    expect(s.degraded).toBe(true);
    s = reduceFailure(s, classifyServiceFailure("claude_usage_limit"), NOW);
    expect(s.degraded).toBe(false);
    expect(s).toEqual(HEALTHY_SERVICE);
  });
});

describe("reduceFailure — the sustained-failure detector", () => {
  it("stays healthy below the threshold — a lone blip does NOT light the banner", () => {
    const s = failTimes(AI_SERVICE_DEGRADED_THRESHOLD - 1, "unreachable");
    expect(s.degraded).toBe(false);
    expect(s.consecutiveFailures).toBe(AI_SERVICE_DEGRADED_THRESHOLD - 1);
  });

  it("goes degraded EXACTLY on the threshold-th consecutive failure", () => {
    const below = failTimes(AI_SERVICE_DEGRADED_THRESHOLD - 1, "unreachable");
    expect(below.degraded).toBe(false);
    const at = reduceFailure(below, { kind: "degrade", reason: "unreachable" }, NOW);
    expect(at.degraded).toBe(true);
    expect(at.reason).toBe("unreachable");
  });

  it("carries the latest reason so the banner names the current cause", () => {
    let s = failTimes(AI_SERVICE_DEGRADED_THRESHOLD, "unreachable");
    expect(s.reason).toBe("unreachable");
    s = reduceFailure(s, { kind: "degrade", reason: "rate_limited" }, NOW);
    expect(s.reason).toBe("rate_limited");
    expect(s.degraded).toBe(true);
  });

  it("an IGNORE outcome resets the run — a 4xx or offline blip can't accumulate to degraded", () => {
    let s = failTimes(AI_SERVICE_DEGRADED_THRESHOLD - 1, "unreachable");
    s = reduceFailure(s, { kind: "ignore" }, NOW); // e.g. a 400, or ai_unreachable
    expect(s.consecutiveFailures).toBe(0);
    s = reduceFailure(s, { kind: "degrade", reason: "unreachable" }, NOW);
    expect(s.degraded).toBe(false); // run restarted, threshold not reached
  });

  it("an IGNORE outcome does NOT clear an already-degraded banner — that is not this arm's job", () => {
    let s = failTimes(AI_SERVICE_DEGRADED_THRESHOLD, "unreachable");
    expect(s.degraded).toBe(true);
    s = reduceFailure(s, { kind: "ignore" }, NOW);
    expect(s.degraded).toBe(true);
    expect(s.consecutiveFailures).toBe(0);
  });

  it("a YIELD outcome CLEARS an already-degraded banner — the specific banner takes over", () => {
    // Finding: 502s degrade us, then the server returns ai_unconfigured/insufficient_credits and its
    // dedicated banner lights. Ours must step aside so the user never sees two stacked amber bars.
    let s: AiServiceHealth = { ...failTimes(AI_SERVICE_DEGRADED_THRESHOLD, "unreachable"), dismissed: true };
    expect(s.degraded).toBe(true);
    s = reduceFailure(s, { kind: "yield" }, NOW);
    expect(s).toEqual(HEALTHY_SERVICE);
  });

  it("returns the SAME reference when a repeated ignore changes nothing", () => {
    const s = reduceFailure(HEALTHY_SERVICE, { kind: "ignore" }, NOW); // already zero run
    expect(s).toBe(HEALTHY_SERVICE);
  });
});

describe("reduceSuccess", () => {
  it("clears degradation AND a prior dismissal, so a later outage speaks again", () => {
    const degradedDismissed: AiServiceHealth = {
      consecutiveFailures: 9,
      degraded: true,
      degradedAt: NOW,
      reason: "unreachable",
      dismissed: true,
    };
    expect(reduceSuccess(degradedDismissed)).toEqual(HEALTHY_SERVICE);
  });

  it("returns the same reference when already healthy (no needless notify)", () => {
    expect(reduceSuccess(HEALTHY_SERVICE)).toBe(HEALTHY_SERVICE);
  });
});

describe("useAiServiceHealthStore wiring", () => {
  beforeEach(() => useAiServiceHealthStore.setState({ ...HEALTHY_SERVICE }));

  it("sustained 502s flip the store to degraded/unreachable; a success clears it", () => {
    const { noteFailure, noteSuccess } = useAiServiceHealthStore.getState();
    for (let i = 0; i < AI_SERVICE_DEGRADED_THRESHOLD; i += 1) {
      noteFailure("ai request failed (HTTP 502)");
    }
    expect(useAiServiceHealthStore.getState().degraded).toBe(true);
    expect(useAiServiceHealthStore.getState().reason).toBe("unreachable");
    noteSuccess();
    expect(useAiServiceHealthStore.getState().degraded).toBe(false);
    expect(useAiServiceHealthStore.getState().reason).toBeNull();
  });

  it("a single blip interleaved with a success never degrades", () => {
    const { noteFailure, noteSuccess } = useAiServiceHealthStore.getState();
    noteFailure("ai request failed (HTTP 502)");
    noteSuccess();
    noteFailure("ai request failed (HTTP 502)");
    expect(useAiServiceHealthStore.getState().degraded).toBe(false);
  });

  it("a sustained OFFLINE run (ai_unreachable) never degrades — OfflineBanner owns that", () => {
    const { noteFailure } = useAiServiceHealthStore.getState();
    for (let i = 0; i < AI_SERVICE_DEGRADED_THRESHOLD + 2; i += 1) noteFailure("ai_unreachable");
    expect(useAiServiceHealthStore.getState().degraded).toBe(false);
  });

  it("dismiss() hides the banner idempotently for the episode", () => {
    useAiServiceHealthStore.setState({
      consecutiveFailures: AI_SERVICE_DEGRADED_THRESHOLD,
      degraded: true,
      reason: "unreachable",
      dismissed: false,
    });
    useAiServiceHealthStore.getState().dismiss();
    expect(useAiServiceHealthStore.getState().dismissed).toBe(true);
    const ref = useAiServiceHealthStore.getState();
    ref.dismiss();
    expect(useAiServiceHealthStore.getState()).toBe(ref); // idempotent, same reference
  });
});

describe("degradation expiry — a stale claim must not outlive its evidence", () => {
  // `degraded` clears only on a success, and only the UNCACHED chatOnce may report one (judge,
  // naming and attention are cacheable, and a cache hit never touches the CLI). chatOnce's sole
  // caller is the learned-suggestions tier, which the user can switch off — so without an expiry
  // that user could raise the banner, fix their CLI, and never clear it, with `dismissed` muting a
  // genuine later outage forever.
  const degradedAt = (at: number): AiServiceHealth => ({
    ...HEALTHY_SERVICE,
    consecutiveFailures: AI_SERVICE_DEGRADED_THRESHOLD,
    degraded: true,
    degradedAt: at,
    reason: "unreachable" as const,
  });

  it("asserts a fresh degradation", () => {
    expect(isServiceDegraded(degradedAt(NOW), NOW + 1_000)).toBe(true);
  });

  it("retires one that has aged out", () => {
    expect(isServiceDegraded(degradedAt(NOW), NOW + SERVICE_DEGRADED_MAX_AGE_MS + 1)).toBe(false);
  });

  it("never asserts when nothing is degraded", () => {
    expect(isServiceDegraded(HEALTHY_SERVICE, NOW)).toBe(false);
  });

  it("a CONTINUING outage re-stamps, so it does not age out mid-outage", () => {
    // The expiry bounds a STALE claim, not a real one: each degrading failure refreshes the stamp.
    let st = degradedAt(NOW);
    const later = NOW + SERVICE_DEGRADED_MAX_AGE_MS - 1;
    st = reduceFailure(st, classifyServiceFailure("ai_timeout"), later);
    expect(isServiceDegraded(st, later + 1_000)).toBe(true);
  });
});

describe("a stale RUN ends the episode, so a dismissal cannot mute the next real outage", () => {
  // The dismissal lives with the RUN, not with the display claim. That matters because its other
  // clearers are ones a cache-only session cannot RELY on: a real chatOnce success (judge, naming
  // and attention are cacheable, so they may never report one) and the `yield` arm, which needs a
  // more specific banner to take over. Without a third, a user could dismiss the banner, fix their
  // CLI, and stay muted for the rest of the session — the next GENUINE outage would re-stamp
  // degradedAt, pass isServiceDegraded, and still render nothing. That third is the RUN_MAX_GAP_MS
  // fold, NOT the claim expiry: expiring the claim cleared the dismissal on a failure that
  // immediately re-derived `degraded` from a run already past the threshold, which made the bar
  // un-dismissable. The tests below pin the split — a claim expiry inside a continuing run KEEPS
  // the dismissal, a run-gap fold drops it, and an `ignore` resets the run without touching it.
  // (The authoritative row-by-row version of all of this is the table on AiServiceHealth. The prose
  // here is the ARGUMENT for why the run-gap fold has to exist, not a second copy of the spec.)
  const dismissedAndStale = (at: number): AiServiceHealth => ({
    consecutiveFailures: AI_SERVICE_DEGRADED_THRESHOLD,
    degraded: true,
    degradedAt: at,
    reason: "unreachable",
    dismissed: true,
  });

  it("HONOURS the dismissal across a claim expiry inside a continuing run", () => {
    // The inversion this guards against: clearing `dismissed` here re-armed the banner on the very
    // same failure, because `degraded` is recomputed from a run that is already past the threshold.
    // A CLI failing every ~15 minutes would then re-nag on every call with no way to mute it, while
    // a dense outage honoured the dismissal — exactly backwards. A dismissal is per-EPISODE, and an
    // episode ends when the RUN does, not when the display claim goes stale.
    const stale = dismissedAndStale(NOW);
    const later = NOW + SERVICE_DEGRADED_MAX_AGE_MS + 1;
    const next = reduceFailure(stale, classifyServiceFailure("ai_timeout"), later);
    expect(next.dismissed).toBe(true);
    expect(next.consecutiveFailures).toBe(AI_SERVICE_DEGRADED_THRESHOLD + 1);
  });

  it("re-arms the banner once the RUN gap is exceeded — a new episode may speak", () => {
    const stale = dismissedAndStale(NOW);
    const muchLater = NOW + RUN_MAX_GAP_MS + 1;
    const next = reduceFailure(stale, classifyServiceFailure("ai_timeout"), muchLater);
    expect(next.dismissed).toBe(false);
    expect(next.consecutiveFailures).toBe(1);
  });

  it("a genuine later outage becomes visible again", () => {
    // "Later" means after the RUN gap, not merely after the display expiry — that is what ends the
    // episode and re-arms the dismissal. A user who fixed their CLI and hits a new outage hours
    // later lands here.
    let st = dismissedAndStale(NOW);
    let t = NOW + RUN_MAX_GAP_MS + 1;
    for (let i = 0; i < AI_SERVICE_DEGRADED_THRESHOLD; i += 1) {
      st = reduceFailure(st, classifyServiceFailure("ai_timeout"), t);
      t += 1_000;
    }
    expect(isServiceDegraded(st, t)).toBe(true);
    expect(st.dismissed).toBe(false); // the whole point: it can speak again
  });

  it("a failure a second later keeps the dismissal — the episode is plainly still running", () => {
    // The user dismissed THIS episode; a failure a second later must not un-dismiss it.
    const fresh = dismissedAndStale(NOW);
    const next = reduceFailure(fresh, classifyServiceFailure("ai_timeout"), NOW + 1_000);
    expect(next.dismissed).toBe(true);
    expect(next.consecutiveFailures).toBe(AI_SERVICE_DEGRADED_THRESHOLD + 1);
  });

  it("an IGNORE resets the RUN without ending the EPISODE — the dismissal survives", () => {
    // The run and the episode are different boundaries, and this is the ONE case that separates
    // them — `ignore` is the single asymmetric row in the table on AiServiceHealth (resets the run,
    // does not end the episode). Without this pinned, an agent reconciling that table against
    // reduceFailure would add `dismissed: false` to the ignore arm and the whole suite would stay
    // green: the only other ignore-into-degraded test starts from failTimes(), where `dismissed` is
    // already false.
    // A single stray ai_empty_reply mid-outage would then un-mute a bar the user just dismissed,
    // and the wedged CLI would re-nag on every subsequent failure.
    const dismissedMidOutage: AiServiceHealth = {
      ...dismissedAndStale(NOW),
      consecutiveFailures: AI_SERVICE_DEGRADED_THRESHOLD,
    };
    const next = reduceFailure(dismissedMidOutage, classifyServiceFailure("ai_empty_reply"), NOW + 1_000);
    expect(next.consecutiveFailures).toBe(0); // the RUN restarts …
    expect(next.dismissed).toBe(true); // … but the EPISODE, and so the mute, does not
    expect(next.degraded).toBe(true); // and an open claim is left standing — the ignore arm drops neither
  });
});

describe("the RUN is bounded too, not just the claim", () => {
  // Isolated blips days apart are not a sustained outage. With success under-reported in a
  // cache-only session, an unbounded run would turn "consecutive since the last success" into
  // "cumulative forever" and eventually assert an outage that is not happening.
  // THE COST of the run bound, pinned as a deliberate value. Without this, shortening
  // SERVICE_DEGRADED_MAX_AGE_MS — a change that reads as purely about how fast the banner retires —
  // would silently make the detector harder to trip, with the whole suite green. That is why the
  // gap is its own constant.
  it("a SPARSE but total outage still degrades — the case the store exists for", () => {
    // A permanently broken CLI in a quiet session: every call fails, but they arrive far apart.
    let st: AiServiceHealth = { ...HEALTHY_SERVICE };
    let t = NOW;
    for (let i = 0; i < AI_SERVICE_DEGRADED_THRESHOLD; i += 1) {
      st = reduceFailure(st, classifyServiceFailure("ai request failed: claude exited"), t);
      t += 15 * 60 * 1000; // 15 minutes apart — well past the 10-minute CLAIM expiry
    }
    expect(st.degraded).toBe(true);
  });

  it("the run gap is LONGER than the claim expiry, which is the whole point of splitting them", () => {
    expect(RUN_MAX_GAP_MS).toBeGreaterThan(SERVICE_DEGRADED_MAX_AGE_MS);
  });

  it("folds at EXACTLY the run gap — the bound is >=, not >", () => {
    // Every other staleness test uses +1, so a `>` mutant survived all of them. The table on
    // AiServiceHealth states `>=`; this is what makes that claim checkable rather than decorative.
    const stale: AiServiceHealth = {
      ...HEALTHY_SERVICE,
      consecutiveFailures: AI_SERVICE_DEGRADED_THRESHOLD,
      degraded: true,
      degradedAt: NOW,
      reason: "unreachable",
      dismissed: true,
    };
    const exactly = NOW + RUN_MAX_GAP_MS;
    const next = reduceFailure(stale, classifyServiceFailure("ai_timeout"), exactly);
    expect(next.consecutiveFailures).toBe(1); // folded to HEALTHY_SERVICE, then counted this one
    expect(next.dismissed).toBe(false); // and the episode ended, so a new one may speak
    expect(next.degraded).toBe(false); // all three columns of the run-gap row, not just two
  });

  it("retires the claim at EXACTLY the expiry, on both the read bound and the reducer arm", () => {
    // isServiceDegraded uses `now - degradedAt < MAX_AGE` and the reducer arm uses `>= MAX_AGE`;
    // the two agree at the boundary only because of that pairing, and nothing pinned it.
    const exactly = NOW + SERVICE_DEGRADED_MAX_AGE_MS;
    const claim: AiServiceHealth = {
      ...HEALTHY_SERVICE,
      consecutiveFailures: AI_SERVICE_DEGRADED_THRESHOLD,
      degraded: true,
      degradedAt: NOW,
      reason: "unreachable",
    };
    expect(isServiceDegraded(claim, exactly)).toBe(false); // read bound: retired AT the boundary

    // Reducer arm: same boundary, on the one state where the arm is observable (run already zeroed).
    const latched: AiServiceHealth = { ...claim, consecutiveFailures: 0 };
    const next = reduceFailure(latched, classifyServiceFailure("ai_timeout"), exactly);
    expect(next.degraded).toBe(false);
    expect(next.consecutiveFailures).toBe(1);
  });

  it("elapsed time ALONE never folds — only a DEGRADING failure evaluates the gap", () => {
    // The table's rows are EVENTS, not clock readings: both time rules live in the `degrade` arm.
    // Without this, "gap > RUN_MAX_GAP_MS" reads as time alone being the trigger, and the cheapest
    // way to make that true is to expire `dismissed` on elapsed time — which un-mutes a bar the
    // user dismissed and re-enters the re-nag inversion this branch removed.
    const dismissedOutage: AiServiceHealth = {
      ...HEALTHY_SERVICE,
      consecutiveFailures: AI_SERVICE_DEGRADED_THRESHOLD,
      degraded: true,
      degradedAt: NOW,
      reason: "unreachable",
      dismissed: true,
    };
    const muchLater = NOW + RUN_MAX_GAP_MS * 2;
    for (const nonDegrading of ["ai_empty_reply", "ai_busy", "ai_unreachable"]) {
      const next = reduceFailure(dismissedOutage, classifyServiceFailure(nonDegrading), muchLater);
      expect(next.dismissed).toBe(true); // a quiet session keeps its dismissal indefinitely
      expect(next.degraded).toBe(true); // and its claim: neither arm folds on the clock
    }
  });

  it("a stale sub-threshold run restarts rather than accumulating", () => {
    const almost: AiServiceHealth = {
      ...HEALTHY_SERVICE,
      consecutiveFailures: AI_SERVICE_DEGRADED_THRESHOLD - 1,
      degraded: false,
      degradedAt: NOW,
    };
    const daysLater = NOW + RUN_MAX_GAP_MS + 1;
    const next = reduceFailure(almost, classifyServiceFailure("ai_timeout"), daysLater);
    expect(next.consecutiveFailures).toBe(1);
    expect(next.degraded).toBe(false);
  });

  it("a run whose failures arrive close together still accumulates", () => {
    let st: AiServiceHealth = { ...HEALTHY_SERVICE };
    let t = NOW;
    for (let i = 0; i < AI_SERVICE_DEGRADED_THRESHOLD; i += 1) {
      st = reduceFailure(st, classifyServiceFailure("ai_timeout"), t);
      t += 1_000;
    }
    expect(st.degraded).toBe(true);
  });
});

describe("the claim-expiry arm has an observable effect of its own", () => {
  // Without this the arm was VACUOUSLY covered: every test crossing the expiry started at or above
  // the threshold, so `degraded` was recomputed to true three lines later and the arm's only
  // remaining effect was erased before it could be asserted — deleting the whole clause left the
  // suite green.
  //
  // The distinguishing case is a run the `ignore` verdict already zeroed while `degraded` stayed
  // latched. WITH the arm the stale claim retires and the run restarts at 1; WITHOUT it, `degraded`
  // stays asserted off a single failure.
  it("retires a latched claim whose run was already reset", () => {
    const latched: AiServiceHealth = {
      ...HEALTHY_SERVICE,
      degraded: true,
      consecutiveFailures: 0, // an `ignore` outcome zeroed the run but left the banner latched
      degradedAt: NOW,
      reason: "unreachable",
    };
    const later = NOW + SERVICE_DEGRADED_MAX_AGE_MS + 1;
    const next = reduceFailure(latched, classifyServiceFailure("ai_timeout"), later);
    expect(next.degraded).toBe(false); // the stale claim is retired, not carried forward
    expect(next.consecutiveFailures).toBe(1); // and this failure starts a new run
  });

  it("retires a latched claim on a run of ONE too — the guard is < THRESHOLD, not === 0", () => {
    // The arm is not conditioned on the run being ZERO; it is conditioned on the run still being
    // below the threshold AFTER this failure is counted. A run of 1 is reachable and was unpinned:
    // an `ignore` zeroes the run mid-outage leaving `degraded` latched, one degrading failure inside
    // the expiry window takes it to 1 and re-stamps degradedAt, and the next one an expiry later
    // lands here. Without this, narrowing the guard to `state.consecutiveFailures === 0` leaves the
    // whole suite green — and a latched claim then survives on a two-failure run forever, because
    // every degrading failure re-stamps degradedAt so isServiceDegraded never lets it age out. That
    // is precisely the flappy false positive AI_SERVICE_DEGRADED_THRESHOLD = 4 exists to prevent.
    const latchedOnAShortRun: AiServiceHealth = {
      ...HEALTHY_SERVICE,
      degraded: true,
      consecutiveFailures: 1,
      degradedAt: NOW,
      reason: "unreachable",
    };
    const later = NOW + SERVICE_DEGRADED_MAX_AGE_MS + 1;
    const next = reduceFailure(latchedOnAShortRun, classifyServiceFailure("ai_timeout"), later);
    expect(next.degraded).toBe(false); // still retired — 2 is under the threshold
    expect(next.consecutiveFailures).toBe(2); // and the run continues rather than restarting
  });
});
