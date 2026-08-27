// The PROACTIVE PUSH CHANNEL's trigger and cost controls (PRD/sparkle/concierge-proactive-push.md).
//
// Every one of these cases is about SPENDING: a proactive turn is a `claude` run the user did not
// ask for, so the interesting assertions are all "how many turns did that cost?" rather than "what
// did it say". The roster aggregator publishes `roster://changed` every 250ms; a trigger that fires
// on ticks instead of on CHANGES would run 14,400 turns an hour.
import { describe, expect, it } from "vitest";
import {
  PROACTIVE_COALESCE_MS,
  PROACTIVE_MAX_PER_HOUR,
  PROACTIVE_MIN_INTERVAL_MS,
  MAX_PENDING_NOTICES,
  PENDING_NOTICE_HARD_CAP,
  PUSHER_NOTICE_PREAMBLE,
  REPORT_NOTICE_PREAMBLE,
  accountedNeedsYou,
  buildNoticeSection,
  buildProactivePrompt,
  createProactiveScheduler,
  markStaleProactive,
  significantDigest,
  surfacedDigest,
  type ProactiveDeps,
} from "./conciergeProactive";
import {
  setConciergeNotifier,
  clearConciergeNotifier,
  notifyConcierge,
  _resetConciergeNotifierForTests,
} from "./conciergeNotifier";
import type { ConciergeAgent, ConciergeFeed } from "./conciergeFeed";
import type { ConciergeMessage } from "../components/Concierge/types";
import type { ResearchTask } from "./research/types";

const agent = (over: Partial<ConciergeAgent> & { id: string }): ConciergeAgent =>
  ({
    name: over.id,
    projectId: "p1",
    projectName: "sparkle-desktop",
    kind: "build",
    status: "approval",
    statusColor: "#e0533f",
    statusLabel: "Approve?",
    band: "needs_you",
    inScope: true,
    muted: false,
    topLevel: true,
    parentRowId: null,
    representedElsewhere: false,
    rolledUpGreen: false,
    ...over,
  }) as ConciergeAgent;

/** A one-project feed over `agents`, with scopedCounts derived so the prompt can't misstate them. */
function feed(agents: ConciergeAgent[]): ConciergeFeed {
  const count = (band: string) =>
    agents.filter((a) => a.band === band && a.inScope && !a.muted).length;
  const counts = { needs_you: count("needs_you"),
    questions: count("questions"), running: count("running"), done: count("done") };
  return {
    projects: [{ id: "p1", name: "sparkle-desktop", inScope: true, counts, agents }],
    counts,
    scopedCounts: counts,
    pinnedProjectId: null,
  } as ConciergeFeed;
}

/** A manual clock + timer queue, so every case below is deterministic and instant. */
function harness(over: Partial<ProactiveDeps> = {}) {
  let now = 1_000_000;
  let nextHandle = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const fired: { prompt: string; digest: string; researchTaskIds: readonly string[] }[] = [];
  /** What the transport reports back. `false` = the push never ran (declined because the user owns
   *  the conversation, a dead bridge, a claude error) — the outcome the scheduler must not treat
   *  as delivery. Flipped mid-test by the decline cases below. */
  let accept = true;
  const deps: ProactiveDeps = {
    now: () => now,
    setTimer: (fn, ms) => {
      const h = ++nextHandle;
      timers.set(h, { at: now + ms, fn });
      return h;
    },
    clearTimer: (h) => {
      timers.delete(h);
    },
    startTurn: (prompt, digest, researchTaskIds) => {
      fired.push({ prompt, digest, researchTaskIds });
      return accept;
    },
    ...over,
  };
  /** Advance the clock, running every timer that comes due, in due order. */
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = target;
  };
  return {
    deps,
    fired,
    advance,
    pending: () => timers.size,
    decline: () => {
      accept = false;
    },
    acceptAgain: () => {
      accept = true;
    },
  };
}

describe("significantDigest", () => {
  it("ignores movement that is only a timestamp", () => {
    // `since` is the user's last touch of an agent and it moves constantly; it is the single
    // biggest source of roster churn that means nothing. Same for the display name.
    const a = feed([agent({ id: "a", since: 111 })]);
    const b = feed([agent({ id: "a", since: 999, name: "renamed" })]);
    expect(significantDigest(b)).toBe(significantDigest(a));
  });

  it("changes when an agent enters or leaves the needs_you band", () => {
    const calm = feed([agent({ id: "a", status: "working", band: "running" })]);
    const asking = feed([agent({ id: "a", status: "approval", band: "needs_you" })]);
    expect(significantDigest(asking)).not.toBe(significantDigest(calm));
  });

  it("changes when an agent finishes", () => {
    const working = feed([agent({ id: "a", status: "working", band: "running" })]);
    const done = feed([agent({ id: "a", status: "idle", band: "done" })]);
    expect(significantDigest(done)).not.toBe(significantDigest(working));
  });

  it("changes when a stage advances, because the stage overlay lands on the status", () => {
    // `unmerged` IS the workflow-stage overlay (conciergeFeed.publishedStatusFor); the concierge
    // never sees a separate stage field, so digesting status is what covers stage movement.
    const built = feed([agent({ id: "a", status: "idle", band: "done" })]);
    const unmerged = feed([agent({ id: "a", status: "unmerged", band: "done" })]);
    expect(significantDigest(unmerged)).not.toBe(significantDigest(built));
  });

  it("is order-stable, so a reshuffled roster is not a change", () => {
    const one = feed([agent({ id: "a" }), agent({ id: "b", status: "working", band: "running" })]);
    const other = feed([agent({ id: "b", status: "working", band: "running" }), agent({ id: "a" })]);
    expect(significantDigest(other)).toBe(significantDigest(one));
  });

  it("ignores agents the user muted or scoped away — the concierge doesn't surface those", () => {
    const base = feed([agent({ id: "a" })]);
    const withNoise = feed([
      agent({ id: "a" }),
      agent({ id: "muted", muted: true }),
      agent({ id: "elsewhere", inScope: false }),
    ]);
    expect(significantDigest(withNoise)).toBe(significantDigest(base));
  });
});

describe("createProactiveScheduler", () => {
  it("fires ZERO turns when the digest never changes, however many roster ticks arrive", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    const f = feed([agent({ id: "a" })]);
    // The first observation SEEDS the baseline; the column is already rendering this state.
    s.observe(f);
    for (let i = 0; i < 200; i++) {
      // Timestamps move on every tick, exactly as the real aggregator's do.
      s.observe(feed([agent({ id: "a", since: 1000 + i })]));
      h.advance(250); // the aggregator's real cadence
    }
    expect(h.fired).toEqual([]);
    expect(s.stats().fired).toBe(0);
    expect(s.stats().skipped.unchanged).toBeGreaterThan(0);
  });

  it("fires exactly one turn when an agent enters needs_you", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.observe(feed([agent({ id: "a", status: "working", band: "running" })]));
    s.observe(feed([agent({ id: "a", status: "approval", band: "needs_you" })]));
    expect(h.fired).toHaveLength(0); // still inside the coalescing window
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.prompt).toContain("Approve?");
    s.dispose();
  });

  // ══ ALL CLAUDE ACCOUNTS OAUTH-EXPIRED → NO PROACTIVE TURN FIRES (bead sparkle-s8xi35) ═══════════
  // The SIDE EFFECT under test is that `startTurn` is never invoked while credentials are dead — a
  // push is a `claude` turn that would die on the same auth every concierge turn dies on. Driven
  // through the REAL fire path (a genuine needs_you change, coalescing window elapsed), and paired
  // with the identical scenario at a healthy credential which DOES fire, so the silence is proven to
  // be caused by the gate. This is the mutation guard: delete the `credentialExpired` check at the top
  // of `fire` and the expired case fires a turn, reding the first assertion.
  it("stands down while credentials are expired, and fires once they recover", () => {
    let expired = true;
    const h = harness({ credentialExpired: () => expired });
    const s = createProactiveScheduler(h.deps);
    s.observe(feed([agent({ id: "a", status: "working", band: "running" })]));
    s.observe(feed([agent({ id: "a", status: "approval", band: "needs_you" })]));
    h.advance(PROACTIVE_COALESCE_MS);
    // Expired: the coalescing window elapsed on a real change, and STILL nothing was sent.
    expect(h.fired).toHaveLength(0);

    // The credential recovers (a /login landed). The next genuine change fires normally — proving the
    // stand-down was the credential, not a scheduler that had gone permanently quiet.
    expired = false;
    s.observe(feed([agent({ id: "a", status: "working", band: "running" })]));
    s.observe(feed([agent({ id: "a", status: "approval", band: "needs_you" })]));
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);
    s.dispose();
  });

  it("coalesces a burst of ticks inside the window into ONE turn", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.observe(feed([agent({ id: "a", status: "working", band: "running" })]));
    // 40 ticks over 1s of a fleet in motion — several genuinely significant, all inside the window.
    for (let i = 0; i < 40; i++) {
      s.observe(
        feed([
          agent({ id: "a", status: "approval", band: "needs_you" }),
          agent({ id: `w${i}`, status: "working", band: "running" }),
        ]),
      );
      h.advance(25);
    }
    expect(h.fired).toHaveLength(0);
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);
    // The turn speaks about the LATEST state, not the state that opened the window. It carries the
    // SURFACED digest (was: `significantDigest`) — see `surfacedDigest` for why staleness is scored
    // against what the message actually asserts rather than against every in-scope agent.
    expect(h.fired[0]!.digest).toBe(
      surfacedDigest(feed([agent({ id: "a", status: "approval", band: "needs_you" })])),
    );
  });

  it("cancels a pending turn when the state settles back to what it already was", () => {
    // A flicker — an agent that goes red and recovers before anyone could read it — must cost
    // nothing at all.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    const calm = feed([agent({ id: "a", status: "working", band: "running" })]);
    s.observe(calm);
    s.observe(feed([agent({ id: "a", status: "approval", band: "needs_you" })]));
    h.advance(PROACTIVE_COALESCE_MS / 2);
    s.observe(calm);
    h.advance(PROACTIVE_COALESCE_MS * 4);
    expect(h.fired).toEqual([]);
  });

  it("says nothing when the change is that everything went CALM", () => {
    // A turn to announce that nothing needs you is money spent to say nothing. The message that
    // claimed otherwise is marked stale instead — see markStaleProactive.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.observe(feed([agent({ id: "a", status: "approval", band: "needs_you" })]));
    s.observe(feed([agent({ id: "a", status: "idle", band: "done" })]));
    h.advance(PROACTIVE_COALESCE_MS * 4);
    expect(h.fired).toEqual([]);
    expect(s.stats().skipped.calm).toBeGreaterThan(0);
  });

  it("enforces the minimum interval between turns", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.observe(feed([agent({ id: "a", status: "working", band: "running" })]));
    s.observe(feed([agent({ id: "a", status: "approval", band: "needs_you" })]));
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);

    // A second, genuinely significant change immediately afterwards.
    s.observe(feed([agent({ id: "a" }), agent({ id: "b", status: "blocked", band: "needs_you" })]));
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1); // held by the floor, not dropped

    h.advance(PROACTIVE_MIN_INTERVAL_MS);
    expect(h.fired).toHaveLength(2); // …and delivered once the floor lifts
  });

  it("caps the number of turns per hour", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.observe(feed([agent({ id: "seed", status: "working", band: "running" })]));
    // Change the fleet, wait out the interval, over and over — far more times than the cap allows.
    const attempts = PROACTIVE_MAX_PER_HOUR + 6;
    for (let i = 0; i < attempts; i++) {
      s.observe(
        feed([
          agent({ id: "seed", status: "working", band: "running" }),
          agent({ id: `a${i}`, status: "approval", band: "needs_you" }),
        ]),
      );
      h.advance(PROACTIVE_COALESCE_MS + PROACTIVE_MIN_INTERVAL_MS);
    }
    expect(h.fired.length).toBe(PROACTIVE_MAX_PER_HOUR);
    expect(s.stats().skipped["hourly-cap"]).toBeGreaterThan(0);
    expect(s.stats().fired).toBe(PROACTIVE_MAX_PER_HOUR);
  });

  it("lets the cap refill as the hour rolls forward", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.observe(feed([agent({ id: "seed", status: "working", band: "running" })]));
    for (let i = 0; i < PROACTIVE_MAX_PER_HOUR; i++) {
      s.observe(
        feed([
          agent({ id: "seed", status: "working", band: "running" }),
          agent({ id: `a${i}`, status: "approval", band: "needs_you" }),
        ]),
      );
      h.advance(PROACTIVE_COALESCE_MS + PROACTIVE_MIN_INTERVAL_MS);
    }
    expect(h.fired).toHaveLength(PROACTIVE_MAX_PER_HOUR);
    s.observe(feed([agent({ id: "late", status: "approval", band: "needs_you" })]));
    h.advance(60 * 60 * 1000);
    expect(h.fired).toHaveLength(PROACTIVE_MAX_PER_HOUR + 1);
  });

  // ── A TURN THAT NEVER RAN IS NOT A TURN (roborev 54166-M2) ─────────────────────────────────
  // `concierge_proactive_turn` stands down for any user turn, in flight or merely preparing, and
  // the frontend transport resolves null on every failure. Treating "asked" as "delivered" loses
  // the change forever — the baseline moves, the founder is never told, and one of the six hourly
  // slots is spent on a message nobody received.
  describe("a declined push", () => {
    it("keeps the change pending and re-delivers it once the floor lifts", () => {
      const h = harness();
      const s = createProactiveScheduler(h.deps);
      s.observe(feed([agent({ id: "a", status: "working", band: "running" })]));
      h.decline();
      s.observe(feed([agent({ id: "a", status: "approval", band: "needs_you" })]));
      h.advance(PROACTIVE_COALESCE_MS);
      expect(h.fired, "it was attempted").toHaveLength(1);
      expect(s.stats().fired, "…but nothing was delivered").toBe(0);
      expect(s.stats().skipped.declined).toBe(1);

      // The user puts their turn down; the same unreported change is still owed to them.
      h.acceptAgain();
      h.advance(PROACTIVE_MIN_INTERVAL_MS);
      expect(h.fired).toHaveLength(2);
      expect(h.fired[1]!.prompt).toContain("Approve?");
      expect(s.stats().fired).toBe(1);
      s.dispose();
    });

    it("does not burn one of the six hourly slots", () => {
      // The cap is a budget for turns the founder actually got. A declined push that consumed one
      // would let a busy hour of user activity silence the channel outright.
      const h = harness();
      const s = createProactiveScheduler(h.deps);
      s.observe(feed([agent({ id: "seed", status: "working", band: "running" })]));
      h.decline();
      for (let i = 0; i < PROACTIVE_MAX_PER_HOUR + 3; i++) {
        s.observe(
          feed([
            agent({ id: "seed", status: "working", band: "running" }),
            agent({ id: `a${i}`, status: "approval", band: "needs_you" }),
          ]),
        );
        h.advance(PROACTIVE_COALESCE_MS + PROACTIVE_MIN_INTERVAL_MS);
      }
      expect(s.stats().fired).toBe(0);
      expect(s.stats().skipped["hourly-cap"], "no slot was consumed").toBe(0);
      // And the channel is still alive: the first acceptance after all that still lands.
      h.acceptAgain();
      h.advance(PROACTIVE_COALESCE_MS + PROACTIVE_MIN_INTERVAL_MS);
      expect(s.stats().fired).toBe(1);
      s.dispose();
    });

    it("still respects the minimum interval, so a persistent refusal is not a retry storm", () => {
      const h = harness();
      const s = createProactiveScheduler(h.deps);
      s.observe(feed([agent({ id: "a", status: "working", band: "running" })]));
      h.decline();
      s.observe(feed([agent({ id: "a", status: "approval", band: "needs_you" })]));
      h.advance(PROACTIVE_COALESCE_MS);
      expect(h.fired).toHaveLength(1);
      // Half an hour of the user holding the conversation: one attempt per two-minute floor, not
      // one per coalescing window and certainly not one per roster tick.
      h.advance(30 * 60_000);
      expect(h.fired.length).toBeLessThanOrEqual(16);
      expect(h.fired.length).toBeGreaterThan(1);
      s.dispose();
    });

    it("is reported as an ASYNC outcome too — the real transport resolves a promise", async () => {
      // The scheduler's edge is `startProactiveConciergeTurn`, which is async. A sync-only decline
      // check would pass the cases above and still commit every real push optimistically.
      const h = harness({ startTurn: () => Promise.resolve(false) });
      const s = createProactiveScheduler(h.deps);
      s.observe(feed([agent({ id: "a", status: "working", band: "running" })]));
      s.observe(feed([agent({ id: "a", status: "approval", band: "needs_you" })]));
      h.advance(PROACTIVE_COALESCE_MS);
      await Promise.resolve();
      await Promise.resolve();
      expect(s.stats().fired).toBe(0);
      expect(s.stats().skipped.declined).toBe(1);
      s.dispose();
    });

    it("a REJECTED transport is a decline, not an unhandled rejection", async () => {
      const h = harness({ startTurn: () => Promise.reject(new Error("bridge is gone")) });
      const s = createProactiveScheduler(h.deps);
      s.observe(feed([agent({ id: "a", status: "working", band: "running" })]));
      s.observe(feed([agent({ id: "a", status: "approval", band: "needs_you" })]));
      h.advance(PROACTIVE_COALESCE_MS);
      await Promise.resolve();
      await Promise.resolve();
      expect(s.stats().fired).toBe(0);
      expect(s.stats().skipped.declined).toBe(1);
      s.dispose();
    });
  });

  // ── NEVER SAY THE SAME THING TWICE (roborev 54166-M4) ──────────────────────────────────────
  // The prompt only ever describes the surfaced `needs_you` set, but the trigger digested EVERY
  // in-scope agent's status — so movement the message could not possibly mention still bought a
  // turn, and the founder got the identical sentence again. A notifier that repeats itself gets
  // muted, which costs the whole feature.
  it("says nothing when the change cannot alter the sentence it would say", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    const asking = agent({ id: "a", status: "approval", band: "needs_you" });
    s.observe(feed([asking, agent({ id: "w", status: "working", band: "running" })]));
    // A running worker advances. Genuinely a change; genuinely not something the push would name.
    s.observe(feed([asking, agent({ id: "w", status: "idle", band: "running" })]));
    h.advance(PROACTIVE_COALESCE_MS * 4);
    expect(h.fired).toEqual([]);
    expect(s.stats().skipped["same-surface"]).toBeGreaterThan(0);
    // A rolled-up worker changing state is the same story: it is counted but never listed.
    s.observe(
      feed([
        asking,
        agent({ id: "w", status: "idle", band: "running" }),
        agent({ id: "rep", status: "blocked", band: "needs_you", representedElsewhere: true }),
      ]),
    );
    h.advance(PROACTIVE_COALESCE_MS * 4);
    expect(h.fired).toEqual([]);
    s.dispose();
  });

  it("still fires when the surfaced set itself moves", () => {
    // The guard above must not swallow the channel's entire reason for existing.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.observe(feed([agent({ id: "a", status: "approval", band: "needs_you" })]));
    s.observe(
      feed([
        agent({ id: "a", status: "approval", band: "needs_you" }),
        agent({ id: "b", status: "blocked", band: "needs_you" }),
      ]),
    );
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);
    s.dispose();
  });

  it("carries the SURFACED digest, so a push goes stale exactly when its sentence stops being true", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.observe(feed([agent({ id: "a", status: "working", band: "running" })]));
    const live = feed([agent({ id: "a", status: "approval", band: "needs_you" })]);
    s.observe(live);
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired[0]!.digest).toBe(surfacedDigest(live));
    // Unrelated churn does NOT stale it — the sentence still holds.
    const churned = feed([
      agent({ id: "a", status: "approval", band: "needs_you" }),
      agent({ id: "w", status: "working", band: "running" }),
    ]);
    expect(surfacedDigest(churned)).toBe(h.fired[0]!.digest);
    s.dispose();
  });

  it("stops spending the moment it is disposed", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.observe(feed([agent({ id: "a", status: "working", band: "running" })]));
    s.observe(feed([agent({ id: "a", status: "approval", band: "needs_you" })]));
    s.dispose();
    h.advance(PROACTIVE_COALESCE_MS * 10);
    expect(h.fired).toEqual([]);
    expect(h.pending()).toBe(0);
  });
});

describe("buildProactivePrompt", () => {
  it("states the count and the items, and asks for an UNPROMPTED line", () => {
    const p = buildProactivePrompt(
      feed([
        agent({ id: "a", name: "OG Image Pipeline", statusLabel: "Approve?" }),
        agent({ id: "b", name: "Kraken Auth", status: "blocked", statusLabel: "Blocked" }),
      ]),
    );
    expect(p).toContain("OG Image Pipeline");
    expect(p).toContain("Kraken Auth");
    expect(p).toContain("2 Need you");
    // The brain must know nobody asked it anything — otherwise it answers a question that isn't there.
    expect(p.toLowerCase()).toContain("the user has not asked you anything");
  });

  it("counts what it LISTS, not what the vitals line counts (roborev 54166-M1)", () => {
    // `scopedCounts.needs_you` includes agents rolled up into an ancestor's row; the enumerated
    // lines exclude them. Handed the wider number, the brain asserts a count column one never
    // shows — "3 need you" over two visible items — and the founder has no way to find the third.
    const p = buildProactivePrompt(
      feed([
        agent({ id: "a", name: "OG Image Pipeline" }),
        agent({ id: "b", name: "Kraken Auth", status: "blocked", statusLabel: "Blocked" }),
        agent({ id: "rolled", name: "Worker", representedElsewhere: true }),
      ]),
    );
    expect(p).toContain("2 Need you");
    expect(p).not.toContain("3 Need you");
    expect(p).not.toContain("Worker");
  });
});

describe("surfacedDigest", () => {
  it("moves only when the set the push DESCRIBES moves", () => {
    const base = feed([agent({ id: "a" })]);
    // Everything here is invisible to the prompt: a running worker's state, a muted agent, an
    // out-of-scope one, a rolled-up one, and the timestamps that move on every roster tick.
    const noisy = feed([
      agent({ id: "a", since: 999 }),
      agent({ id: "w", status: "working", band: "running" }),
      agent({ id: "muted", muted: true }),
      agent({ id: "elsewhere", inScope: false }),
      agent({ id: "rolled", representedElsewhere: true }),
    ]);
    expect(surfacedDigest(noisy)).toBe(surfacedDigest(base));
    // …whereas anything that changes a line does change it.
    expect(surfacedDigest(feed([agent({ id: "a", status: "blocked" })]))).not.toBe(
      surfacedDigest(base),
    );
    expect(surfacedDigest(feed([agent({ id: "a" }), agent({ id: "b" })]))).not.toBe(
      surfacedDigest(base),
    );
    expect(surfacedDigest(feed([]))).toBe("");
  });

  it("is order-stable, so a reshuffled roster is not a change", () => {
    expect(surfacedDigest(feed([agent({ id: "b" }), agent({ id: "a" })]))).toBe(
      surfacedDigest(feed([agent({ id: "a" }), agent({ id: "b" })])),
    );
  });
});

describe("accountedNeedsYou", () => {
  it("is the surfacing gate: in scope, not muted, not already spoken for, needs_you", () => {
    const agents = [
      agent({ id: "keep" }),
      agent({ id: "calm", status: "working", band: "running" }),
      agent({ id: "muted", muted: true }),
      agent({ id: "elsewhere", inScope: false }),
      agent({ id: "represented", representedElsewhere: true }),
    ];
    expect(accountedNeedsYou(feed(agents)).map((a) => a.id)).toEqual(["keep"]);
  });
});

describe("markStaleProactive", () => {
  const push = (over: Partial<ConciergeMessage> = {}): ConciergeMessage =>
    ({ id: "brain-7", kind: "sparkle", text: "You have 3 P1s.", proactive: true, digest: "D1", ...over }) as ConciergeMessage;

  it("marks a push stale once the state it was authored against no longer holds", () => {
    const out = markStaleProactive([push()], "D2");
    expect(out[0]).toMatchObject({ stale: true });
  });

  it("leaves a push alone while its state still holds", () => {
    const chat = [push()];
    expect(markStaleProactive(chat, "D1")).toBe(chat); // same array — no re-render churn
  });

  it("never touches a message the USER or a normal reply owns", () => {
    const chat: ConciergeMessage[] = [
      { id: "you-1", kind: "you", text: "hi" },
      { id: "brain-2", kind: "sparkle", text: "hello" },
    ];
    expect(markStaleProactive(chat, "D9")).toBe(chat);
  });

  it("marks EVERY superseded push, not just the newest", () => {
    const out = markStaleProactive(
      [push({ id: "brain-1", digest: "D1" }), push({ id: "brain-2", digest: "D2" })],
      "D3",
    );
    expect(out.map((m) => (m as { stale?: boolean }).stale)).toEqual([true, true]);
  });

  it("is idempotent — an already-stale push is not rewritten", () => {
    const chat = [push({ stale: true })];
    expect(markStaleProactive(chat, "D2")).toBe(chat);
  });
});

describe("notify — the Pusher's second input (sparkle-4cd0x)", () => {
  // Founder: "the build agent AND THE CONCIERGE are both just sitting silent… I'm wondering if the
  // pusher can be the thing that does that." Nothing pushed the concierge about a measured fleet
  // condition, because those move no roster digest — so the channel could only ever speak about
  // needs-you churn, and the conditions worth escalating were invisible to it by construction.

  it("speaks on its own, with no feed change behind it at all", () => {
    // THE CASE THAT DID NOT EXIST. Before this, a scheduler that had never seen a digest change
    // fired nothing, forever, however much the Pusher measured.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.notify("Agent A has been quota-walled for 3h; its goal expires inside the wall.");
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.prompt).toContain("quota-walled for 3h");
  });

  it("tells the concierge to ACT, rather than to relay it to the founder", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.notify("Agent A is blocked on CI");
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired[0]!.prompt).toMatch(/yours to act on/);
    expect(h.fired[0]!.prompt).toMatch(/do not simply relay them to him/);
  });

  it("obeys the same coalescing window — several findings cost ONE turn, not one each", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.notify("one");
    s.notify("two");
    s.notify("three");
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);
    for (const t of ["one", "two", "three"]) expect(h.fired[0]!.prompt).toContain(t);
  });

  it("obeys the two-minute floor and the six-an-hour cap", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    for (let i = 0; i < 20; i++) {
      s.notify(`finding ${i}`);
      h.advance(PROACTIVE_COALESCE_MS);
      h.advance(PROACTIVE_MIN_INTERVAL_MS);
    }
    expect(h.fired.length).toBeLessThanOrEqual(PROACTIVE_MAX_PER_HOUR);
  });

  it("is idempotent while a finding is still owed — a sweep re-measuring costs nothing", () => {
    // The Pusher re-measures the same fleet every five minutes, so the identical sentence arrives
    // again and again while the condition holds. Re-arming on each would push the coalescing window
    // out in front of itself and the finding would never be spoken.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    for (let i = 0; i < 10; i++) {
      s.notify("Agent A is blocked on CI");
      h.advance(PROACTIVE_COALESCE_MS / 2);
    }
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.prompt.match(/Agent A is blocked on CI/g)).toHaveLength(1);
  });

  it("SURVIVES A DECLINE — an undelivered finding is still owed, unlike a digest", () => {
    // The rule this whole feature turns on. A feed change is dropped when the fleet settles back;
    // a finding is not, because "this agent has been walled for three hours" does not stop being
    // true because the roster stopped moving.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    h.decline();
    s.notify("Agent A is blocked on CI");
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);

    h.acceptAgain();
    h.advance(PROACTIVE_MIN_INTERVAL_MS);
    expect(h.fired).toHaveLength(2);
    expect(h.fired[1]!.prompt).toContain("Agent A is blocked on CI");
  });

  it("is cleared by DELIVERY and only by delivery — it is not re-sent forever", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.notify("Agent A is blocked on CI");
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);

    h.advance(PROACTIVE_MIN_INTERVAL_MS * 3);
    expect(h.fired).toHaveLength(1);
    expect(h.pending()).toBe(0);
  });

  it("is not dropped when the fleet flickers back to a state already spoken about", () => {
    // `observe` calls `dropPending` on an unchanged digest. That is right for a digest and wrong for
    // a finding, and getting it wrong would strand the finding until some unrelated change happened
    // to re-arm the timer — on a quiet fleet, never.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    const calm = feed([agent({ id: "a", status: "working", band: "running" })]);
    s.observe(calm);
    s.notify("Agent A has been pushed twice and has not moved.");
    s.observe(calm);
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.prompt).toContain("pushed twice");
  });

  it("rides an existing feed change rather than buying a second turn", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.observe(feed([agent({ id: "a", status: "working", band: "running" })]));
    s.observe(feed([agent({ id: "a", status: "approval", band: "needs_you" })]));
    s.notify("Agent B is blocked on CI");
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.prompt).toContain("Agent B is blocked on CI");
    expect(h.fired[0]!.prompt).toMatch(/needs you|Approve/i);
  });

  it("a declined feed change is STILL re-pended when a finding is also owed", () => {
    // The regression this guards: the re-pend used to test `pendingSince === null`, and a finding
    // now holds `pendingSince` non-null on purpose — so under the old test an owed finding would
    // have swallowed the re-pend and the founder would never hear about the feed change.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.observe(feed([agent({ id: "a", status: "working", band: "running" })]));
    h.decline();
    s.observe(feed([agent({ id: "a", status: "approval", band: "needs_you" })]));
    s.notify("Agent B is blocked on CI");
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);

    h.acceptAgain();
    h.advance(PROACTIVE_MIN_INTERVAL_MS);
    expect(h.fired).toHaveLength(2);
    expect(h.fired[1]!.prompt).toMatch(/needs you|Approve/i);
    expect(h.fired[1]!.prompt).toContain("Agent B is blocked on CI");
  });

  it("ignores empty text and does nothing after dispose", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.notify("   ");
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(0);

    s.dispose();
    s.notify("too late");
    h.advance(PROACTIVE_COALESCE_MS * 10);
    expect(h.fired).toHaveLength(0);
  });
});

describe("a picker notice is re-validated at DELIVERY, not at raise (bead sparkle-st06sq)", () => {
  // THE BUG: a "needs you" picker notice is raised the moment a build agent stops at a menu, but the
  // push does not reach the concierge for seconds-to-a-minute — longer than the multi-question wizards
  // that raise it stay on any one question. So by delivery the menu is GONE and the agent is working
  // again: measured, 20 of 20 picker notices across three concierge turns described a state that no
  // longer existed. The fix carries a liveness predicate ON the notice and re-tests it at the two
  // delivery seams, dropping any whose menu has resolved.
  //
  // THE PAIRING IS THE PROOF. A notice whose predicate still holds is delivered; the one beside it
  // whose predicate has gone false is dropped — same turn, same channel, differing only in the live
  // state the predicate reads. Delete the `dropStaleNotices` calls in `fire`/`peekNotices` and the
  // stale notice rides the turn, reding the "not delivered" assertions. Asserting only the drop would
  // pass against a channel that delivered NOTHING, which is why the live half is tested in the same
  // breath.

  it("drops the resolved one and delivers the still-live one, in the same turn", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    // Raised together, as a wizard's successive questions are. By the time the coalescing window
    // elapses, the first menu has resolved (predicate false) and the second is still on screen.
    s.notify("Agent A is STOPPED at a menu — question one", "pusher", () => false);
    s.notify("Agent B is STOPPED at a menu — still on screen", "pusher", () => true);
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.prompt).toContain("Agent B is STOPPED at a menu — still on screen");
    expect(h.fired[0]!.prompt).not.toContain("Agent A is STOPPED at a menu — question one");
    s.dispose();
  });

  it("fires NO turn at all when the only owed picker notice has already resolved", () => {
    // The common case the founder measured: every picker notice in the batch is stale. Nothing is
    // spoken, so no read_picker_options round-trip is spent and the "needs you" count is not inflated.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.notify("Agent A is STOPPED at a menu that is already gone", "pusher", () => false);
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toEqual([]);
    // And the owed flag came down with it — no armed timer is left ticking on a resolved notice.
    expect(h.pending()).toBe(0);
    s.dispose();
  });

  it("drops a resolved picker notice from the USER-turn seam too, so it never rides a user turn", () => {
    // peekNotices is the other delivery path — an owed notice riding a turn the user started. A menu
    // that resolved while the notice sat owed must be filtered here as well, or it reaches the
    // concierge unfiltered on the next user turn.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.notify("Agent A — resolved before the user's next turn", "pusher", () => false);
    s.notify("Agent B — still live", "pusher", () => true);
    expect(s.peekNotices().map((n) => n.text)).toEqual(["Agent B — still live"]);
    s.dispose();
  });

  it("a notice with NO predicate is always delivered — reports and feed findings never go stale", () => {
    // The predicate is opt-in. Everything without one (a retirement report, a PR/goal finding) is
    // delivered exactly as before, so this can only ever suppress a menu it positively re-confirmed
    // as gone — never a notice whose subject cannot resolve underneath it.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.notify("Retired Kraken Auth — its PR merged 4h ago", "report");
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.prompt).toContain("Retired Kraken Auth — its PR merged 4h ago");
    s.dispose();
  });

  it("FAILS OPEN — a predicate that throws keeps the notice rather than losing a real escalation", () => {
    // A transient read error (pane mid-remount, scrollback momentarily unavailable) must not delete a
    // notice that may describe a live menu. Losing a real "needs you" is the costlier failure, so a
    // throwing predicate is treated as still-valid.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.notify("Agent A is STOPPED at a menu — read threw", "pusher", () => {
      throw new Error("scrollback unavailable");
    });
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.prompt).toContain("Agent A is STOPPED at a menu — read threw");
    s.dispose();
  });
});

describe("NOTHING OWED IS EVER SILENTLY LOST (bead sparkle-qogah)", () => {
  // FOUNDER'S RULE, VERBATIM, P0: "We should never hide a row that needs action from me."
  //
  // These findings are the most explicitly actionable items this app produces — the preamble that
  // carries them says "they are yours to act on… Act on each one now". `notify` used to end with
  // `while (pendingNotices.length > MAX_PENDING_NOTICES) pendingNotices.shift()`, discarding the
  // OLDEST with no record, no count, no retry and no residue of any kind, while telling the Pusher
  // it had been delivered. The test below this comment block used to PIN that behaviour as intended
  // (`expect(prompt).not.toContain("finding 0")`); it is inverted here.
  //
  // Rule 3 of the same bead answers the objection this cap was defending against: if uncapping
  // makes the surface tall, that is CORRECT. Prompt length is the "height" argument, and height is
  // never a licence to conceal work the founder owes.

  it("names EVERY finding in the emitted prompt, well past the readability threshold", () => {
    // Asserted on the EMITTED PROMPT, not on the internal list — the prompt is the only thing the
    // concierge can act on, so it is the only place "not lost" means anything.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    const total = MAX_PENDING_NOTICES + 4;
    for (let i = 0; i < total; i++) s.notify(`finding ${i}`);
    h.advance(PROACTIVE_COALESCE_MS);

    expect(h.fired).toHaveLength(1);
    const prompt = h.fired[0]!.prompt;
    // The one that used to be destroyed, first and by name.
    expect(prompt).toContain("finding 0");
    for (let i = 0; i < total; i++) expect(prompt).toContain(`finding ${i}`);
    // Every one as its own bullet, so "accounted for" is not satisfied by a summary sentence that
    // happens to contain the substring.
    expect(prompt.match(/^• finding \d+$/gm)).toHaveLength(total);
  });

  it("discloses the count and states outright that nothing was withheld", () => {
    // If a future change re-introduces a drop, this sentence becomes false — which is the point of
    // asserting on it. A cap is only tolerable with an explicit, non-optional disclosure.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    const total = MAX_PENDING_NOTICES + 4;
    for (let i = 0; i < total; i++) s.notify(`finding ${i}`);
    h.advance(PROACTIVE_COALESCE_MS);

    const prompt = h.fired[0]!.prompt;
    expect(prompt).toContain(`All ${total} are listed below`);
    expect(prompt).toContain("none has been withheld");
  });

  it("keeps the short form when the list is short — the header is for the wall, not for two items", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.notify("Agent A is quota-walled");
    s.notify("Agent B has an expired goal");
    h.advance(PROACTIVE_COALESCE_MS);

    const prompt = h.fired[0]!.prompt;
    expect(prompt).toContain("• Agent A is quota-walled");
    expect(prompt).toContain("• Agent B has an expired goal");
    expect(prompt).not.toContain("none has been withheld");
  });

  it("carries every one across a DECLINE too — the overflow is not laundered by a retry", () => {
    // The two mechanisms have to compose: surviving a decline is worthless if the list was already
    // truncated before the turn was attempted.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    h.decline();
    const total = MAX_PENDING_NOTICES + 4;
    for (let i = 0; i < total; i++) s.notify(`finding ${i}`);
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);

    h.acceptAgain();
    h.advance(PROACTIVE_MIN_INTERVAL_MS);
    expect(h.fired).toHaveLength(2);
    for (let i = 0; i < total; i++) expect(h.fired[1]!.prompt).toContain(`finding ${i}`);
  });
});

describe("notify reports the truth about what it accepted (bead sparkle-qogah)", () => {
  // `notify` returned `void`, and every caller in the chain read that as success:
  // `notifyConcierge` did `fn(text); return true;`, `pusherMount.sendVerified` handed the `true`
  // back, and `pusherRunner` took its `delivered` branch — recording outcome "sent", spending a
  // rate-budget slot, and STAMPING the condition as reported for a four-hour cooldown. A finding
  // discarded here was therefore also suppressed at source for four hours.

  it("returns TRUE when the finding is genuinely now owed", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    expect(s.notify("Agent A is quota-walled")).toBe(true);
  });

  it("returns FALSE after dispose — the text reaches no prompt, ever", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.dispose();
    expect(s.notify("Agent A is quota-walled")).toBe(false);
    // ...and the boolean is not merely decorative: nothing is delivered either.
    h.advance(PROACTIVE_COALESCE_MS * 10);
    expect(h.fired).toHaveLength(0);
  });

  it("returns FALSE on empty text rather than counting a blank as delivered", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    expect(s.notify("   ")).toBe(false);
  });

  it("returns TRUE for an already-owed finding — it IS pending and WILL be delivered", () => {
    // The one refusal that is honestly a success, and the reason this is not simply "false unless we
    // pushed". The Pusher re-measures a standing condition every sweep; the work is owed either way,
    // so the cooldown is legitimately earned and a second identical bullet would help nobody.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    expect(s.notify("Agent A is quota-walled")).toBe(true);
    expect(s.notify("Agent A is quota-walled")).toBe(true);
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired[0]!.prompt.match(/Agent A is quota-walled/g)).toHaveLength(1);
  });

  it("returns FALSE at the hard ceiling, refusing the NEWCOMER instead of destroying an incumbent", () => {
    // The ceiling exists so an owed list cannot grow without bound when a transport declines for
    // hours against a Pusher minting text that differs by a digit. Which END it refuses is the whole
    // question: dropping the oldest destroys a finding whose condition is already stamped for four
    // hours, with no retry. Refusing the arrival returns false, so `pusherRunner` records
    // transport-failed, stamps nothing, and re-offers it next sweep.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    for (let i = 0; i < PENDING_NOTICE_HARD_CAP; i++) {
      expect(s.notify(`finding ${i}`)).toBe(true);
    }
    expect(s.notify("the one that arrives at a full list")).toBe(false);

    // THE INCUMBENTS ARE ALL STILL THERE — the refusal cost nothing that was already owed.
    h.advance(PROACTIVE_COALESCE_MS);
    const prompt = h.fired[0]!.prompt;
    expect(prompt).toContain("finding 0");
    expect(prompt).toContain(`finding ${PENDING_NOTICE_HARD_CAP - 1}`);
    expect(prompt.match(/^• finding \d+$/gm)).toHaveLength(PENDING_NOTICE_HARD_CAP);
    expect(prompt).not.toContain("the one that arrives at a full list");

    // ...and once they drain, the refused one is accepted on the retry the `false` bought.
    expect(s.notify("the one that arrives at a full list")).toBe(true);
  });
});

describe("a delivered notice lowers the owed flag (roborev 57705)", () => {
  it("still coalesces the NEXT feed change, instead of firing it with no window", () => {
    // THE REGRESSION. `dropPending` keeps `pendingSince` alive while notices are owed, and `fire`
    // runs it before the transport reports back — so nothing lowered it once the notices were
    // delivered. `observe`'s `pendingSince ??=` then kept that stale origin, `dueAt` computed a
    // coalescing deadline already in the past, and the next change fired instantly: a burst of
    // roster ticks becomes several turns and spends the six-an-hour budget the window protects.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.notify("Agent A is blocked on CI");
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);

    // Well past the min-interval, so the ONLY thing that could hold the next turn is the coalescing
    // window itself.
    h.advance(PROACTIVE_MIN_INTERVAL_MS * 2);
    s.observe(feed([agent({ id: "a", status: "working", band: "running" })]));
    s.observe(feed([agent({ id: "a", status: "approval", band: "needs_you" })]));

    h.advance(PROACTIVE_COALESCE_MS - 1);
    expect(h.fired).toHaveLength(1); // ...still held
    h.advance(1);
    expect(h.fired).toHaveLength(2); // ...and fires exactly when the window closes
  });

  it("arms nothing once the notices are gone", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.notify("Agent A is blocked on CI");
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);
    expect(h.pending()).toBe(0);
  });

  it("keeps the flag up when a notice arrived while the turn was in flight", () => {
    // The invariant is "owed <-> flag", in both directions. Lowering it unconditionally would
    // strand a notice that landed mid-turn.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.notify("first");
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);
    s.notify("second");
    h.advance(PROACTIVE_MIN_INTERVAL_MS);
    expect(h.fired).toHaveLength(2);
    expect(h.fired[1]!.prompt).toContain("second");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE RESEARCH DRAIN'S SECOND SEAM (bead sparkle-s7rfc, reporting-channel PRD §3.3)
//
// §3.3's free improvement: a turn that is happening anyway carries the unread findings. The two
// properties worth pinning are opposite in direction — it must ride EVERY proactive turn, and it
// must never CAUSE one. The second is the expensive half: a finding that bought a push would spend
// the six-an-hour ceiling on routine results and rate-limit out a genuine blocker.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("research findings ride a proactive turn", () => {
  const staging = (preamble: string, ...taskIds: string[]) => () => ({ preamble, taskIds });

  it("puts the preamble AHEAD of the roster section, and names the ids for the caller to stage", () => {
    const h = harness({ peekResearch: staging("RESEARCH BACK — 1 finding(s):\nrelay p90 is 7.4s", "r-1") });
    const s = createProactiveScheduler(h.deps);
    s.observe(feed([agent({ id: "a", status: "working", band: "running" })]));
    s.observe(feed([agent({ id: "a", status: "approval", band: "needs_you" })]));
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);
    const { prompt, researchTaskIds } = h.fired[0]!;
    expect(prompt).toContain("relay p90 is 7.4s");
    // "Approve?" is the roster line's status label — the first thing the old prompt began with.
    expect(prompt).toContain("Approve?");
    expect(prompt.indexOf("relay p90 is 7.4s")).toBeLessThan(prompt.indexOf("Approve?"));
    expect(researchTaskIds).toEqual(["r-1"]);
  });

  it("folds SAVED MEMORY into a proactive turn — the persona promises it is always folded in (roborev 63933)", () => {
    // The gap this closes: only the user-turn seam folded memory in, so an unprompted turn carried
    // no WHAT YOU'VE REMEMBERED section while the persona claimed it always does. A proactive turn is
    // exactly where re-grounding matters most — there is no human message to re-supply context.
    const h = harness({
      peekMemoryPreamble: () => "WHAT YOU'VE REMEMBERED — 1 fact(s):\n\n- founder-priority: wall-clock speed over token cost",
    });
    const s = createProactiveScheduler(h.deps);
    s.observe(feed([agent({ id: "a", status: "working", band: "running" })]));
    s.observe(feed([agent({ id: "a", status: "approval", band: "needs_you" })]));
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);
    const prompt = h.fired[0]!.prompt;
    // The remembered VALUE actually reaches the proactive prompt, ahead of the roster.
    expect(prompt).toContain("wall-clock speed over token cost");
    expect(prompt.indexOf("wall-clock speed over token cost")).toBeLessThan(prompt.indexOf("Approve?"));
  });

  it("rides a NOTICE-ONLY turn too — the one that never calls buildProactivePrompt", () => {
    const h = harness({ peekResearch: staging("RESEARCH BACK — 1 finding(s):\nthe answer", "r-1") });
    const s = createProactiveScheduler(h.deps);
    s.notify("Agent A has been quota-walled for 3h");
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.prompt).toContain("the answer");
    expect(h.fired[0]!.prompt).toContain("quota-walled");
  });

  it("buys NOTHING until it is told — a scheduler never handed the store speaks about nothing", () => {
    // WHAT THIS PINS CHANGED WITH `observeResearch` (bead sparkle-wo4c79), so read it carefully:
    // research CAN now buy a turn, but only once the store has actually been fed in. What stays
    // true, and is what this case guards, is that the drain is never polled speculatively — no
    // `peekResearch` on a quiet fleet, so a peek still cannot be the thing that decides to speak.
    let peeks = 0;
    const h = harness({
      peekResearch: () => {
        peeks++;
        return { preamble: "RESEARCH BACK — 1 finding(s):\nnobody asked", taskIds: ["r-1"] };
      },
    });
    const s = createProactiveScheduler(h.deps);
    // A quiet fleet, seeded and unchanged: nothing needs the user, nothing was notified.
    s.observe(feed([agent({ id: "a", status: "working", band: "running" })]));
    s.observe(feed([agent({ id: "a", status: "working", band: "running" })]));
    h.advance(60 * 60_000);
    expect(h.fired).toEqual([]);
    // And it was not even CONSULTED — peeking is free, but a peek here would mean the decision to
    // speak had already been taken.
    expect(peeks).toBe(0);
  });

  it("stages nothing when the push is DECLINED — the finding stays owed", () => {
    // The caller stages against the turn id the transport returns; a decline returns none. This
    // pins the scheduler half: it must still hand over the ids rather than pre-emptively clearing
    // them, so the next turn carries the same finding.
    const h = harness({ peekResearch: staging("RESEARCH BACK — 1 finding(s):\nheld", "r-1") });
    h.decline();
    const s = createProactiveScheduler(h.deps);
    s.observe(feed([agent({ id: "a", status: "working", band: "running" })]));
    s.observe(feed([agent({ id: "a", status: "approval", band: "needs_you" })]));
    h.advance(PROACTIVE_COALESCE_MS);
    expect(s.stats().skipped.declined).toBe(1);
    h.acceptAgain();
    h.advance(PROACTIVE_MIN_INTERVAL_MS);
    expect(h.fired).toHaveLength(2);
    expect(h.fired[1]!.prompt).toContain("held");
    expect(h.fired[1]!.researchTaskIds).toEqual(["r-1"]);
  });

  it("adds NOTHING to the prompt when nothing is unread", () => {
    const withDrain = harness({ peekResearch: () => ({ preamble: "", taskIds: [] }) });
    const without = harness();
    for (const h of [withDrain, without]) {
      const s = createProactiveScheduler(h.deps);
      s.observe(feed([agent({ id: "a", status: "working", band: "running" })]));
      s.observe(feed([agent({ id: "a", status: "approval", band: "needs_you" })]));
      h.advance(PROACTIVE_COALESCE_MS);
      s.dispose();
    }
    // Byte-identical to a scheduler with no drain wired at all — no empty header, no stray blank
    // line, on the overwhelmingly common turn.
    expect(withDrain.fired[0]!.prompt).toBe(without.fired[0]!.prompt);
    expect(withDrain.fired[0]!.researchTaskIds).toEqual([]);
  });
});

// ══ RESEARCH COMING BACK WAKES HIM ══════════════════════════════════════════════════════════════
//
// The reported bug (bead sparkle-wo4c79): the founder commissioned research, it FINISHED, and he
// had to ask "what did you find out about Epic versus tasks?" to hear the answer — because a
// finished finding could only ride a turn bought by something else, and on a quiet fleet nothing
// ever bought one. Two more runs died that day with "the Claude CLI is not signed in" and he was
// never told at all.
//
// Every case below is still about SPENDING, in the same terms as the rest of this file — the point
// is not merely that research speaks, but that it speaks WITHOUT touching the fleet's budget, so
// §3.3's starvation objection stays answered rather than traded away.
describe("research coming back wakes the concierge", () => {
  const task = (over: Partial<ResearchTask> & { id: string }): ResearchTask =>
    ({
      question: "epic vs tasks",
      depth: "quick",
      projectId: "p1",
      projectRoot: "/p1",
      status: "done",
      createdAt: 1,
      startedAt: 2,
      finishedAt: 3,
      findings: "Epics are containers; tasks are the unit of work.",
      error: null,
      readAt: null,
      ...over,
    }) as ResearchTask;

  /** A drain stubbed to report exactly what the (mutable) task list still owes, so a test can stamp
   *  `readAt` and have the peek agree — the real drain's behaviour, and what the stand-down reads. */
  const drainOver = (tasks: () => ResearchTask[]): Partial<ProactiveDeps> => ({
    peekResearch: () => {
      const owed = tasks().filter((t) => t.readAt === null);
      return {
        preamble: owed.length === 0 ? "" : owed.map((t) => t.findings ?? t.error ?? "").join("\n"),
        taskIds: owed.map((t) => t.id),
      };
    },
  });

  /** A fleet that is up and running: nothing needs him, so nothing else can buy the turn. */
  const quiet = () => feed([agent({ id: "a", status: "working", band: "running" })]);

  it("a FINISHED run buys a turn on a quiet fleet, and carries the answer", () => {
    // THE REGRESSION TEST. Before `observeResearch` this fired nothing, forever, which is exactly
    // what made the founder ask for an answer he had already commissioned.
    const tasks = [task({ id: "r1" })];
    const h = harness(drainOver(() => tasks));
    const s = createProactiveScheduler(h.deps);
    s.observe(quiet());
    s.observeResearch(tasks);
    h.advance(PROACTIVE_COALESCE_MS);

    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.prompt).toContain("Epics are containers");
    expect(h.fired[0]!.researchTaskIds).toEqual(["r1"]);
    // It is framed as speaking first, and told to deliver the ANSWER rather than a two-line digest
    // — the fleet instruction's "ONE or TWO short sentences" is what made the old channel useless
    // for a question he was waiting on.
    expect(h.fired[0]!.prompt).toContain("speaking first, unprompted");
    expect(h.fired[0]!.prompt).toContain("give him the ANSWER");
  });

  it("a FAILED run wakes him exactly like a successful one", () => {
    // Requirement 1, and the half that actually bit: two runs died with this precise message and
    // the founder learned nothing until someone happened to speak.
    const tasks = [
      task({
        id: "r1",
        status: "failed",
        findings: null,
        error: "The research run could not start — the Claude CLI is not signed in.",
      }),
    ];
    const h = harness(drainOver(() => tasks));
    const s = createProactiveScheduler(h.deps);
    s.observe(quiet());
    s.observeResearch(tasks);
    h.advance(PROACTIVE_COALESCE_MS);

    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.prompt).toContain("not signed in");
    expect(h.fired[0]!.prompt).toContain("say plainly that it failed");
  });

  it("a CANCELLED run buys nothing — he stopped it, so it is not news", () => {
    const tasks = [task({ id: "r1", status: "cancelled", findings: null, error: null })];
    const h = harness(drainOver(() => tasks));
    const s = createProactiveScheduler(h.deps);
    s.observe(quiet());
    s.observeResearch(tasks);
    h.advance(60 * 60_000);

    expect(h.fired).toEqual([]);
  });

  it("several runs finishing together COALESCE into one turn", () => {
    // Requirement 3. The window opens at the first and does not reset, so the later two ride it.
    const tasks = [task({ id: "r1" })];
    const h = harness(drainOver(() => tasks));
    const s = createProactiveScheduler(h.deps);
    s.observe(quiet());
    s.observeResearch(tasks);
    h.advance(1_000);
    tasks.push(task({ id: "r2", findings: "second answer" }));
    s.observeResearch(tasks);
    h.advance(1_000);
    tasks.push(task({ id: "r3", findings: "third answer" }));
    s.observeResearch(tasks);
    h.advance(PROACTIVE_COALESCE_MS);

    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.researchTaskIds).toEqual(["r1", "r2", "r3"]);
    expect(h.fired[0]!.prompt).toContain("second answer");
    expect(h.fired[0]!.prompt).toContain("third answer");
  });

  it("does NOT report again what a user turn already delivered", () => {
    // Requirement 2, at the one instant it is hard: the wake is already armed and sitting in its
    // coalescing window when the founder types, and HIS turn carries the findings. The claim is
    // stamped, so the wake must stand down rather than tell him a second time.
    const tasks = [task({ id: "r1" })];
    const h = harness(drainOver(() => tasks));
    const s = createProactiveScheduler(h.deps);
    s.observe(quiet());
    s.observeResearch(tasks);
    // A user turn delivers it mid-window: the drain stamps the durable claim.
    tasks[0]!.readAt = 12_345;
    h.advance(60 * 60_000);

    expect(h.fired).toEqual([]);
    // ...and the window is closed rather than left armed, so nothing is still ticking on a quiet
    // fleet an hour later.
    expect(h.pending()).toBe(0);
  });

  it("tells him ONCE — a delivered answer does not come back on the next tick", () => {
    const tasks = [task({ id: "r1" })];
    const h = harness(drainOver(() => tasks));
    const s = createProactiveScheduler(h.deps);
    s.observe(quiet());
    s.observeResearch(tasks);
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);

    // The turn delivered, so the drain stamps the claim and the store re-reports.
    tasks[0]!.readAt = 99_999;
    s.observeResearch(tasks);
    h.advance(60 * 60_000);
    expect(h.fired).toHaveLength(1);
  });

  it("is NOT held by a fleet hourly ceiling that is already spent", () => {
    // §3.3's objection, answered rather than overridden. Six fleet pushes exhaust the hour; an
    // answer he is waiting on must still arrive, because it spends a different budget.
    const tasks: ResearchTask[] = [];
    const h = harness(drainOver(() => tasks));
    const s = createProactiveScheduler(h.deps);
    s.observe(quiet());
    for (let i = 0; i < PROACTIVE_MAX_PER_HOUR; i++) {
      s.observe(feed([agent({ id: `x${i}`, status: "approval", band: "needs_you" })]));
      h.advance(PROACTIVE_COALESCE_MS + PROACTIVE_MIN_INTERVAL_MS);
    }
    expect(s.stats().fired).toBe(PROACTIVE_MAX_PER_HOUR);

    tasks.push(task({ id: "r1" }));
    s.observeResearch(tasks);
    h.advance(PROACTIVE_COALESCE_MS);

    expect(h.fired).toHaveLength(PROACTIVE_MAX_PER_HOUR + 1);
    expect(h.fired.at(-1)!.prompt).toContain("Epics are containers");
    // And it did not take a fleet slot on the way through.
    expect(s.stats().fired).toBe(PROACTIVE_MAX_PER_HOUR);
    expect(s.stats().researchFired).toBe(1);
  });

  it("spends no fleet slot, so a real blocker right after it is NOT rate-limited out", () => {
    // The mirror of the case above, and the one §3.3 actually cared about. If a research turn
    // charged `lastAttemptAt`, the blocker below would be held two minutes behind routine results.
    const tasks = [task({ id: "r1" })];
    const h = harness(drainOver(() => tasks));
    const s = createProactiveScheduler(h.deps);
    s.observe(quiet());
    s.observeResearch(tasks);
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);

    tasks[0]!.readAt = 1;
    s.observeResearch(tasks);
    // A blocker appears immediately afterwards — well inside the two-minute floor.
    s.observe(feed([agent({ id: "b", status: "blocked", band: "needs_you" })]));
    h.advance(PROACTIVE_COALESCE_MS);

    expect(h.fired).toHaveLength(2);
    expect(h.fired[1]!.prompt).toContain("Approve?");
  });

  it("a DECLINED wake keeps the answer owed and retries behind its own floor", () => {
    // The push stands down because the founder owns the conversation. Nothing may be lost, and
    // nothing may busy-loop: without this track's own retry floor it would re-ask every four
    // seconds for as long as he keeps typing.
    const tasks = [task({ id: "r1" })];
    const h = harness(drainOver(() => tasks));
    h.decline();
    const s = createProactiveScheduler(h.deps);
    s.observe(quiet());
    s.observeResearch(tasks);
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);
    expect(s.stats().skipped.declined).toBe(1);
    expect(s.stats().researchFired).toBe(0);

    // It did not retry once per coalescing window while it was refused.
    h.advance(PROACTIVE_MIN_INTERVAL_MS - PROACTIVE_COALESCE_MS - 1);
    expect(h.fired).toHaveLength(1);

    h.acceptAgain();
    h.advance(PROACTIVE_MIN_INTERVAL_MS);
    expect(h.fired).toHaveLength(2);
    expect(h.fired[1]!.researchTaskIds).toEqual(["r1"]);
    expect(s.stats().researchFired).toBe(1);
  });

  it("rides an ALREADY-BOUGHT fleet turn instead of buying a second one", () => {
    // The pre-existing ride-along, still true and now load-bearing for spend: when both tracks come
    // due together they produce ONE turn carrying both, not a fleet turn plus a research turn. Both
    // counters move because both things genuinely happened; what must never rise is the turn count.
    const tasks = [task({ id: "r1" })];
    const h = harness(drainOver(() => tasks));
    const s = createProactiveScheduler(h.deps);
    s.observe(quiet());
    s.observeResearch(tasks);
    s.observe(feed([agent({ id: "a", status: "approval", band: "needs_you" })]));
    h.advance(PROACTIVE_COALESCE_MS);

    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.prompt).toContain("Epics are containers");
    expect(h.fired[0]!.prompt).toContain("Approve?");
    expect(s.stats().fired).toBe(1);
    expect(s.stats().researchFired).toBe(1);
  });

  it("SURVIVES a picker-notice drop that empties the main track — the research wake is re-armed", () => {
    // roborev 69362 (High). `clearOwed` tears the ONE timer down when the main track empties, and
    // the file's invariant is that every `clearOwed` is followed by `arm()` — `settle` does exactly
    // that. `dropStaleNotices` did not, and it is reached from `fire` and `peekNotices`, neither of
    // which re-arms either. So a stale picker notice dropped at the fire seam destroyed the timer,
    // `fire` then fell through `if (!hasMain && !researchReady) return;`, and `researchSince` — which
    // a notice drop never touches — was left non-null with NOTHING RUNNING. The answer sat unspoken
    // until some unrelated notify/observeFeed/observeResearch happened along, which on a quiet fleet
    // is the failure `observeResearch` was written to remove.
    //
    // THE ORDERING IS THE TEST. The research wake is armed one tick AFTER the notice, so its due
    // moment is strictly later: the main track comes due first, drops its only notice, and the
    // research wake is the only thing left for the timer to be holding.
    const tasks = [task({ id: "r1" })];
    const h = harness(drainOver(() => tasks));
    const s = createProactiveScheduler(h.deps);
    s.observe(quiet());
    s.notify("Agent A is STOPPED at a menu that is already gone", "pusher", () => false);
    h.advance(1);
    s.observeResearch(tasks);

    // The main track's moment: the notice is re-validated, found stale, and dropped. Nothing is
    // spoken — and before the fix the timer died here.
    h.advance(PROACTIVE_COALESCE_MS - 1);
    expect(h.fired).toEqual([]);

    // The research wake's own moment, one tick later. It must still fire.
    h.advance(1);
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.prompt).toContain("Epics are containers");
    expect(h.fired[0]!.researchTaskIds).toEqual(["r1"]);
    s.dispose();
  });

  it("…and the pair: with the notice still LIVE, the main track speaks at that same moment", () => {
    // The assertion above cannot stand alone. Byte-identical setup, ONE bit different — the
    // predicate holds — so the notice is not dropped, the main track is still owed when its moment
    // arrives, and it buys a turn there. That contrast is what pins the cause: at
    // `PROACTIVE_COALESCE_MS` the drop case is silent and this one speaks, so the earlier test's
    // "nothing fired yet" is the DROP, not a scheduler that simply never fires.
    const tasks = [task({ id: "r1" })];
    const h = harness(drainOver(() => tasks));
    const s = createProactiveScheduler(h.deps);
    s.observe(quiet());
    s.notify("Agent A is STOPPED at a menu that is still on screen", "pusher", () => true);
    h.advance(1);
    s.observeResearch(tasks);

    h.advance(PROACTIVE_COALESCE_MS - 1);
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.prompt).toContain("Agent A is STOPPED at a menu that is still on screen");
    s.dispose();
  });
});

// ══ THE OWED CHANNEL'S SECOND KIND — A REPORT, NOT A PUSH ═══════════════════════════════════════
//
// `retire_agent` retires finished agents unattended and overnight, and the founder asked to be told
// what it did while he was away. The owed-notice channel is the right transport — it survives a
// decline, it is deduplicated, it is rate-limited — but its ONE preamble said "Act on each one now
// … do not simply relay them to him", which is the exact inverse of what a report needs. These
// already happened; relaying them plainly IS the deliverable.
//
// Every assertion below is on the EMITTED PROMPT, because the prompt is the only thing the concierge
// ever sees, and each one is written to be RED against a single-preamble build: a report rendered
// under the pusher instruction contains the pusher preamble, which `not.toContain` catches.

/** Where `text` sits in `prompt` — the position tests below compare against the preambles'. */
function at(prompt: string, text: string): number {
  const i = prompt.indexOf(text);
  expect(i, `expected the prompt to contain ${JSON.stringify(text)}`).toBeGreaterThanOrEqual(0);
  return i;
}

describe("buildNoticeSection renders one section per KIND present", () => {
  it("renders nothing at all for an empty list", () => {
    expect(buildNoticeSection([])).toBe("");
  });

  it("a report-only list carries the REPORT instruction and NOT the pusher one", () => {
    // THE SIDE EFFECT, and the one that would have passed before this change only if the function
    // ignored its input entirely: a report list must not be introduced by "Act on each one now".
    const out = buildNoticeSection([
      { kind: "report", text: "Retired Kraken Auth — its PR merged 4h ago" },
    ]);
    expect(out).toContain(REPORT_NOTICE_PREAMBLE);
    expect(out).not.toContain(PUSHER_NOTICE_PREAMBLE);
    expect(out).toContain("• Retired Kraken Auth — its PR merged 4h ago");
  });

  it("a pusher-only list is byte-identical to what it always was", () => {
    // The additive half. A caller that never mentions a kind must get the old string exactly —
    // same preamble, same bullets, no report section, no stray separator.
    const out = buildNoticeSection([
      { kind: "pusher", text: "Agent A is quota-walled" },
      { kind: "pusher", text: "Agent B has an expired goal" },
    ]);
    expect(out).toBe(
      PUSHER_NOTICE_PREAMBLE + "• Agent A is quota-walled\n• Agent B has an expired goal",
    );
  });

  it("puts each notice under ITS OWN preamble when both kinds are present", () => {
    const out = buildNoticeSection([
      { kind: "report", text: "Retired Kraken Auth" },
      { kind: "pusher", text: "Agent A is quota-walled" },
      { kind: "report", text: "Retired Left Pair" },
      { kind: "pusher", text: "Agent B has an expired goal" },
    ]);
    // BOTH instructions are present — one section cannot swallow the other's notices.
    const pusherAt = at(out, PUSHER_NOTICE_PREAMBLE);
    const reportAt = at(out, REPORT_NOTICE_PREAMBLE);
    // WORK FIRST, REPORT SECOND.
    expect(pusherAt).toBeLessThan(reportAt);
    // Each notice sits inside the right section — the assertion a single mixed section fails.
    expect(at(out, "• Agent A is quota-walled")).toBeGreaterThan(pusherAt);
    expect(at(out, "• Agent A is quota-walled")).toBeLessThan(reportAt);
    expect(at(out, "• Agent B has an expired goal")).toBeLessThan(reportAt);
    expect(at(out, "• Retired Kraken Auth")).toBeGreaterThan(reportAt);
    expect(at(out, "• Retired Left Pair")).toBeGreaterThan(reportAt);
  });

  it("EVERY notice of both kinds survives the split — nothing is dropped by grouping", () => {
    const notices = [
      ...Array.from({ length: 5 }, (_, i) => ({ kind: "pusher" as const, text: `finding ${i}` })),
      ...Array.from({ length: 5 }, (_, i) => ({ kind: "report" as const, text: `did ${i}` })),
    ];
    const out = buildNoticeSection(notices);
    for (let i = 0; i < 5; i++) {
      expect(out).toContain(`• finding ${i}`);
      expect(out).toContain(`• did ${i}`);
    }
    expect(out.match(/^• /gm)).toHaveLength(10);
  });
});

describe("the withheld-nothing count is honest about the SECTION it stands over", () => {
  // The disclosure sentence is an assertion `buildNoticeSection` has to keep true. Split into two
  // sections, a count taken over the WHOLE list would print "All 14 are listed below" above three
  // bullets — the reader would take the other eleven as withheld, which is the same concealment the
  // sentence exists to deny, wearing the disclosure's own clothes.
  const many = (kind: "pusher" | "report", n: number, label: string) =>
    Array.from({ length: n }, (_, i) => ({ kind, text: `${label} ${i}` }));

  it("states each section's OWN count, not the combined one", () => {
    const reports = MAX_PENDING_NOTICES + 4;
    const out = buildNoticeSection([...many("pusher", 2, "finding"), ...many("report", reports, "did")]);

    // The long section discloses its own number...
    expect(out).toContain(`All ${reports} are listed below`);
    expect(out).toContain("none has been withheld");
    // ...and never the combined one, which is the number a whole-list count would have printed.
    expect(out).not.toContain(`All ${reports + 2} are listed below`);
  });

  it("applies the readability threshold per section — a short section keeps the short form", () => {
    const reports = MAX_PENDING_NOTICES + 4;
    const out = buildNoticeSection([...many("pusher", 2, "finding"), ...many("report", reports, "did")]);
    // Exactly ONE disclosure sentence: the two-item pusher section did not grow a header just
    // because the report section is long.
    expect(out.match(/none has been withheld/g)).toHaveLength(1);
    // ...and the disclosure belongs to the REPORT section, not the pusher one.
    expect(at(out, "none has been withheld")).toBeGreaterThan(at(out, REPORT_NOTICE_PREAMBLE));
    // Every entry of both sections is still named.
    expect(out.match(/^• /gm)).toHaveLength(reports + 2);
  });

  it("discloses in BOTH sections when both are long, each with its own number", () => {
    const findings = MAX_PENDING_NOTICES + 1;
    const reports = MAX_PENDING_NOTICES + 5;
    const out = buildNoticeSection([
      ...many("pusher", findings, "finding"),
      ...many("report", reports, "did"),
    ]);
    expect(out).toContain(`All ${findings} are listed below`);
    expect(out).toContain(`All ${reports} are listed below`);
    expect(out.match(/none has been withheld/g)).toHaveLength(2);
    expect(out.match(/^• /gm)).toHaveLength(findings + reports);
  });
});

describe("notify carries the kind, and defaults to the behaviour every caller already had", () => {
  it("DEFAULTS TO pusher — a caller that names no kind is unchanged", () => {
    // The additive requirement, asserted through the scheduler rather than the pure function:
    // `ConciergeHost` hands `(text) => s.notify(text)` to the notifier sink, and that call site was
    // not edited by this change.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.notify("Agent A is quota-walled");
    h.advance(PROACTIVE_COALESCE_MS);

    const prompt = h.fired[0]!.prompt;
    expect(prompt).toContain(PUSHER_NOTICE_PREAMBLE);
    expect(prompt).not.toContain(REPORT_NOTICE_PREAMBLE);
  });

  it("a report reaches the prompt under the report instruction", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    expect(s.notify("Retired Kraken Auth — its PR merged 4h ago", "report")).toBe(true);
    h.advance(PROACTIVE_COALESCE_MS);

    expect(h.fired).toHaveLength(1);
    const prompt = h.fired[0]!.prompt;
    expect(prompt).toContain(REPORT_NOTICE_PREAMBLE);
    expect(prompt).not.toContain(PUSHER_NOTICE_PREAMBLE);
    expect(prompt).toContain("• Retired Kraken Auth — its PR merged 4h ago");
  });

  it("a report alone is enough to buy a turn, exactly as a finding is", () => {
    // The whole point of the second input: a retirement moves no roster digest, so requiring a feed
    // change would mean the overnight report could only ever ride an unrelated one.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.notify("Retired Kraken Auth", "report");
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);
  });

  it("mixes a live finding and an overnight report into ONE turn, each under its own preamble", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.notify("Agent A is quota-walled");
    s.notify("Retired Kraken Auth", "report");
    h.advance(PROACTIVE_COALESCE_MS);

    expect(h.fired).toHaveLength(1);
    const prompt = h.fired[0]!.prompt;
    expect(at(prompt, "• Agent A is quota-walled")).toBeLessThan(at(prompt, REPORT_NOTICE_PREAMBLE));
    expect(at(prompt, "• Retired Kraken Auth")).toBeGreaterThan(at(prompt, REPORT_NOTICE_PREAMBLE));
  });

  it("rides the same turn as a feed change, with the roster section still first", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.observe(feed([agent({ id: "a", status: "working", band: "running" })]));
    s.observe(feed([agent({ id: "a", status: "approval", band: "needs_you" })]));
    s.notify("Retired Kraken Auth", "report");
    h.advance(PROACTIVE_COALESCE_MS);

    expect(h.fired).toHaveLength(1);
    const prompt = h.fired[0]!.prompt;
    expect(prompt).toMatch(/needs you|Approve/i);
    expect(at(prompt, "The user has not asked you anything")).toBeLessThan(
      at(prompt, REPORT_NOTICE_PREAMBLE),
    );
  });
});

describe("two kinds carrying the SAME text are two notices, not a duplicate", () => {
  it("keeps both, because the two instructions contradict each other", () => {
    // Deduplicating on text alone would drop whichever arrived second while telling its caller the
    // message had been delivered — the false-success this path was rewritten to remove. "Kraken
    // Auth is stuck" owed as live work and as a report of something already done are opposite
    // claims; only one of them can be true, and the concierge has to see which one it was handed.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    expect(s.notify("Kraken Auth is finished")).toBe(true);
    expect(s.notify("Kraken Auth is finished", "report")).toBe(true);
    h.advance(PROACTIVE_COALESCE_MS);

    const prompt = h.fired[0]!.prompt;
    expect(prompt.match(/^• Kraken Auth is finished$/gm)).toHaveLength(2);
    expect(at(prompt, PUSHER_NOTICE_PREAMBLE)).toBeLessThan(at(prompt, REPORT_NOTICE_PREAMBLE));
  });

  it("still deduplicates WITHIN a kind — a re-measured report is one bullet", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    expect(s.notify("Retired Kraken Auth", "report")).toBe(true);
    expect(s.notify("Retired Kraken Auth", "report")).toBe(true);
    h.advance(PROACTIVE_COALESCE_MS);

    expect(h.fired[0]!.prompt.match(/^• Retired Kraken Auth$/gm)).toHaveLength(1);
  });
});

describe("delivery and decline behave the same for a report as for a finding", () => {
  it("clears BOTH kinds on delivery — neither is re-sent on the next turn", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.notify("Agent A is quota-walled");
    s.notify("Retired Kraken Auth", "report");
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);

    // A later, unrelated feed change buys the next turn; the delivered notices must not ride it.
    h.advance(PROACTIVE_MIN_INTERVAL_MS);
    s.observe(feed([agent({ id: "a", status: "working", band: "running" })]));
    s.observe(feed([agent({ id: "a", status: "approval", band: "needs_you" })]));
    h.advance(PROACTIVE_COALESCE_MS);

    expect(h.fired).toHaveLength(2);
    expect(h.fired[1]!.prompt).not.toContain("Retired Kraken Auth");
    expect(h.fired[1]!.prompt).not.toContain("Agent A is quota-walled");
    expect(h.fired[1]!.prompt).not.toContain(REPORT_NOTICE_PREAMBLE);
  });

  it("a DECLINED report stays owed, with its kind intact", () => {
    // The kind has to survive the re-pend as well as the text: a report that came back under the
    // pusher preamble would tell the concierge to act on a retirement that already happened.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    h.decline();
    s.notify("Retired Kraken Auth", "report");
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);

    h.acceptAgain();
    h.advance(PROACTIVE_MIN_INTERVAL_MS);
    expect(h.fired).toHaveLength(2);
    expect(h.fired[1]!.prompt).toContain("• Retired Kraken Auth");
    expect(h.fired[1]!.prompt).toContain(REPORT_NOTICE_PREAMBLE);
    expect(h.fired[1]!.prompt).not.toContain(PUSHER_NOTICE_PREAMBLE);
  });

  it("refuses the newcomer at the hard ceiling whichever kind it is, and keeps every incumbent", () => {
    // The ceiling bounds this scheduler's MEMORY, which is not per-kind — so a full list refuses a
    // report too, and refuses it in the direction that keeps what is already owed.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    for (let i = 0; i < PENDING_NOTICE_HARD_CAP; i++) expect(s.notify(`finding ${i}`)).toBe(true);
    expect(s.notify("Retired Kraken Auth", "report")).toBe(false);

    h.advance(PROACTIVE_COALESCE_MS);
    const prompt = h.fired[0]!.prompt;
    expect(prompt.match(/^• finding \d+$/gm)).toHaveLength(PENDING_NOTICE_HARD_CAP);
    expect(prompt).not.toContain("Retired Kraken Auth");
    expect(prompt).not.toContain(REPORT_NOTICE_PREAMBLE);
  });
});

// ══ THE SEAM: A RETIREMENT REPORT ACTUALLY REACHES A PROACTIVE TURN ══════════════════════════════
// Both halves of the digest were unit-tested in isolation — `retire_agent` calls `notifyConcierge`
// with kind "report", and `buildNoticeSection` renders a report section — and NEITHER test proves
// the two are joined. That is the exact shape AGENTS.md warns about (two suites green, the merge
// clean, the shipped feature never once running), so this drives the real production path:
// notifyConcierge -> the registered sink -> the scheduler -> the prompt a turn is actually given.
describe("a retirement report reaches the turn, under the REPORT preamble", () => {
  it("carries the text and the report instruction, not the Pusher's", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.observe(feed([agent({ id: "a" })]));
    // THE PRODUCTION CALL. `retire_agent` reaches the scheduler through exactly this seam, so the
    // sink registration is part of what is under test rather than something stubbed around.
    setConciergeNotifier((text, kind) => s.notify(text, kind));
    const owed = notifyConcierge(
      "Retired “Kraken Auth” — landed and idle (72 of 81 agent slots now in use).",
      "report",
    );
    expect(owed).toBe(true);
    h.advance(PROACTIVE_COALESCE_MS);
    expect(h.fired).toHaveLength(1);
    const prompt = h.fired[0]!.prompt;
    expect(prompt).toContain("Retired “Kraken Auth”");
    // The instruction is the whole point of the kind: handed the Pusher preamble, a FINISHED
    // retirement becomes an instruction to go and act on it — to undo or re-do completed work.
    expect(prompt).toContain(REPORT_NOTICE_PREAMBLE.trim().slice(0, 40));
    expect(prompt).not.toContain("do not simply relay them to him");
    clearConciergeNotifier(() => true);
    s.dispose();
  });

  it("a Pusher finding still gets the Pusher instruction — the kinds do not bleed", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.observe(feed([agent({ id: "a" })]));
    setConciergeNotifier((text, kind) => s.notify(text, kind));
    notifyConcierge("Two agents are walled and cannot act.", "pusher");
    h.advance(PROACTIVE_COALESCE_MS);
    const prompt = h.fired[0]!.prompt;
    expect(prompt).toContain("Two agents are walled");
    expect(prompt).toContain("do not simply relay them to him");
    s.dispose();
  });
});
