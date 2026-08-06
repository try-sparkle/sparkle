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
  accountedNeedsYou,
  buildProactivePrompt,
  createProactiveScheduler,
  markStaleProactive,
  significantDigest,
  surfacedDigest,
  type ProactiveDeps,
} from "./conciergeProactive";
import type { ConciergeAgent, ConciergeFeed } from "./conciergeFeed";
import type { ConciergeMessage } from "../components/Concierge/types";

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
  const fired: { prompt: string; digest: string }[] = [];
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
    startTurn: (prompt, digest) => {
      fired.push({ prompt, digest });
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

  it("bounds what one turn carries, keeping the newest", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    for (let i = 0; i < MAX_PENDING_NOTICES + 4; i++) s.notify(`finding ${i}`);
    h.advance(PROACTIVE_COALESCE_MS);
    const prompt = h.fired[0]!.prompt;
    expect(prompt).not.toContain("finding 0");
    expect(prompt).toContain(`finding ${MAX_PENDING_NOTICES + 3}`);
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
