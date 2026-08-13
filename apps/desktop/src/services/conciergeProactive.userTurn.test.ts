// AN OWED NOTICE RIDES THE NEXT USER TURN — because the proactive channel is SELF-DEFEATING for
// exactly the conditions that matter most.
//
// ══ THE DEFECT, STATED AS THE CONTRADICTION IT IS ══════════════════════════════════════════════
// Two rules this app already holds, put side by side:
//
//   • `concierge_proactive_turn` STANDS DOWN for any user turn in flight — `ProactiveDeps.startTurn`
//     says so in its own header, and that stand-down is correct: the user owns the conversation.
//   • A NON-EMPTY QUEUE MEANS A USER TURN IS ALWAYS IN FLIGHT. That is not a coincidence, it is
//     `engine/conciergeTurnQueue.enqueue`'s own invariant — a send only WAITS when `s.running !==
//     null`, so `waiting > 0` implies something is running, continuously, until the queue drains.
//
// So a finding about the queue is declined for precisely as long as the finding is true. It is
// worse than a delay: `notify()` returns `true` (the finding really is owed), `notifyConcierge` and
// `sendVerified` pass that through, and `pusherRunner` takes its `delivered` branch — spending one
// of four hourly slots and stamping the condition as reported for FOUR HOURS. The message the
// founder eventually gets, if he ever gets it, is about a backlog that has long since drained.
//
// ══ THE FIX, AND WHY IT IS THIS ONE ════════════════════════════════════════════════════════════
// Fold the owed notices into the prompt of a turn that is GUARANTEED TO RUN — the user's own next
// turn — exactly as `services/research/drain` folds findings, and for a stronger reason: research
// findings merely have no interruption budget, whereas these findings have a channel that is
// structurally shut while they hold.
//
// PEEK CLAIMS NOTHING, which is the drain's rule and it is load-bearing here too: a turn that is
// superseded, cancelled or killed has told the founder nothing, so a notice claimed at
// prompt-build time would be gone with no residue. The claim happens once the transport has
// returned a real turn id.
import { describe, expect, it } from "vitest";

import {
  PROACTIVE_COALESCE_MS,
  PROACTIVE_MIN_INTERVAL_MS,
  PUSHER_NOTICE_PREAMBLE,
  createProactiveScheduler,
  withNoticeSection,
  type PendingNotice,
  type ProactiveDeps,
} from "./conciergeProactive";

/** The same manual clock the sibling suite uses — deterministic and instant. */
function harness(over: Partial<ProactiveDeps> = {}) {
  let now = 1_000_000;
  let nextHandle = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const fired: { prompt: string }[] = [];
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
    startTurn: (prompt) => {
      fired.push({ prompt });
      return accept;
    },
    ...over,
  };
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
    armed: () => timers.size,
    decline: () => {
      accept = false;
    },
  };
}

describe("peekNotices — the user-turn seam", () => {
  it("offers what is owed", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.notify("6 messages are queued for the concierge with no research task running");
    expect(s.peekNotices()).toEqual([
      pusherNotice("6 messages are queued for the concierge with no research task running"),
    ]);
  });

  it("CLAIMS NOTHING — two peeks in a row see the same finding", () => {
    // The drain's rule. A user turn can be superseded before it ever reaches the brain (the whole
    // reason `conciergeTurnQueue` exists is that a new send used to KILL the running child), and a
    // finding claimed at prompt-build time would be destroyed with no record and no retry.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.notify("Agent A has been quota-walled for 3h");
    expect(s.peekNotices()).toHaveLength(1);
    expect(s.peekNotices()).toHaveLength(1);
  });

  it("offers nothing when nothing is owed", () => {
    const h = harness();
    expect(createProactiveScheduler(h.deps).peekNotices()).toEqual([]);
  });

  it("does not ARM anything — peeking must not schedule a push", () => {
    // A peek happens on every user turn, which on a busy queue is continuous. If it re-armed, the
    // seam meant to relieve the proactive channel would be pumping it instead.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.notify("Agent A has been quota-walled for 3h");
    const before = h.armed();
    s.peekNotices();
    expect(h.armed()).toBe(before);
  });
});

describe("claimNotices — delivery through the user's own turn", () => {
  it("stops a delivered notice being repeated on the next turn", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.notify("Agent A has been quota-walled for 3h");
    const carried = s.peekNotices();
    s.claimNotices(carried);
    expect(s.peekNotices()).toEqual([]);
  });

  it("removes BY IDENTITY, so a notice that arrived mid-turn is still owed", () => {
    // The same rule `settle`'s delivered branch follows, and for the same reason: truncating the
    // list instead would destroy a finding this turn's prompt never mentioned.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.notify("first");
    const carried = s.peekNotices();
    s.notify("second");
    s.claimNotices(carried);
    expect(s.peekNotices()).toEqual([pusherNotice("second")]);
  });

  it("keeps the finding owed when the turn never installed", () => {
    // `startConciergeTurn` resolves null for a turn that was superseded before install, cancelled,
    // or failed locally. Nothing is claimed, so the next turn carries it again — a REPEAT is
    // recoverable where a LOSS is not.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.notify("Agent A has been quota-walled for 3h");
    s.peekNotices(); // the host built a prompt with it…
    // …and then claimed nothing, because the transport returned no id.
    expect(s.peekNotices()).toHaveLength(1);
  });

  it("lowers the owed flag, so the next feed change still gets its full window", () => {
    // roborev 57705, arriving through the new door. `dropPending` keeps `pendingSince` alive while
    // notices are owed; if a user-turn claim empties the list without lowering it, `observe`'s
    // `pendingSince ??=` keeps a stale origin and `dueAt` computes a deadline already in the past —
    // so the next genuine change fires with NO coalescing window at all, turning a burst of roster
    // ticks into several turns.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.notify("Agent A has been quota-walled for 3h");
    s.claimNotices(s.peekNotices());
    expect(h.armed()).toBe(0);

    h.advance(PROACTIVE_MIN_INTERVAL_MS * 2);
    s.observe(feedNeeding("working", "running"));
    s.observe(feedNeeding("approval", "needs_you"));
    h.advance(PROACTIVE_COALESCE_MS - 1);
    expect(h.fired).toHaveLength(0); // still held by the window
    h.advance(1);
    expect(h.fired).toHaveLength(1); // and fires exactly when it closes
  });

  it("does NOT spend a proactive slot — the founder was not interrupted, he asked", () => {
    // The hourly cap is a budget for turns the user did not ask for. A notice riding a turn he
    // started costs him nothing, so charging it there would rate-limit out a genuine push later.
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.notify("Agent A has been quota-walled for 3h");
    s.claimNotices(s.peekNotices());
    expect(s.stats().fired).toBe(0);
    expect(s.stats().noticesRidden).toBe(1);
  });

  it("ignores a claim for something that was never owed", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.notify("real");
    s.claimNotices([pusherNotice("something nobody ever notified")]);
    expect(s.peekNotices()).toEqual([pusherNotice("real")]);
    // ...AND IS NOT COUNTED. This is the assertion that discriminates — the removal alone is a
    // no-op either way, so without the tally an unfiltered claim would look identical. The number
    // is read as "findings this channel actually got through", and a claim naming something this
    // scheduler never held (a stale prompt, a host that outlived a remount) delivered nothing.
    expect(s.stats().noticesRidden).toBe(0);
  });

  it("is inert once disposed", () => {
    const h = harness();
    const s = createProactiveScheduler(h.deps);
    s.notify("Agent A has been quota-walled for 3h");
    s.dispose();
    expect(s.peekNotices()).toEqual([]);
  });
});

describe("withNoticeSection — putting the owed findings in front of the user's prompt", () => {
  it("is IDENTITY when nothing is owed", () => {
    // The same contract `withResearchPreamble` publishes. Both seams call it unconditionally, so
    // "nothing owed adds NOTHING to the prompt" has to be a property of the function rather than a
    // discipline at the call site — otherwise every ordinary turn carries an empty header, and the
    // one turn that matters gets skimmed.
    const prompt = "the founder's message";
    expect(withNoticeSection([], prompt)).toBe(prompt);
  });

  it("leads with the instruction preamble, then the findings, then the prompt", () => {
    const out = withNoticeSection(
      [pusherNotice("Agent A has been quota-walled for 3h")],
      "what needs me?",
    );
    expect(out).toContain(PUSHER_NOTICE_PREAMBLE.trim());
    expect(out).toContain("Agent A has been quota-walled for 3h");
    expect(out.indexOf("quota-walled")).toBeLessThan(out.indexOf("what needs me?"));
  });

  it("names EVERY owed finding, however many there are", () => {
    // `buildNoticeSection`'s rule, inherited rather than re-implemented: past the readability
    // threshold the section changes SHAPE, never length. A cap without a disclosure is the defect
    // that module was rewritten to remove.
    const many = Array.from({ length: 12 }, (_, i) => pusherNotice(`finding number ${i}`));
    const out = withNoticeSection(many, "what needs me?");
    for (const n of many) expect(out).toContain(n.text);
    expect(out).toContain("none has been withheld");
  });
});

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────

/**
 * What `notify(text)` with no explicit kind puts on the owed list.
 *
 * The seam carries the OBJECTS rather than their text, because a `NoticeKind` is an instruction and
 * `buildNoticeSection` renders each kind under the preamble that says what to do about it. Written
 * as a helper so the default kind lives in one place here: if `notify`'s default ever moves, these
 * assertions fail together and loudly rather than one at a time.
 */
function pusherNotice(text: string): PendingNotice {
  return { kind: "pusher", text };
}

/** A one-agent feed in the given state — enough to move `significantDigest` and `surfacedDigest`. */
function feedNeeding(status: string, band: string) {
  const counts = {
    needs_you: band === "needs_you" ? 1 : 0,
    questions: 0,
    running: band === "running" ? 1 : 0,
    done: 0,
  };
  const agent = {
    id: "a",
    name: "Agent A",
    projectId: "p1",
    projectName: "sparkle-desktop",
    kind: "build",
    status,
    statusColor: "#e0533f",
    statusLabel: "Approve?",
    band,
    inScope: true,
    muted: false,
    topLevel: true,
    parentRowId: null,
    representedElsewhere: false,
    rolledUpGreen: false,
  };
  return {
    projects: [{ id: "p1", name: "sparkle-desktop", inScope: true, counts, agents: [agent] }],
    counts,
    scopedCounts: counts,
    pinnedProjectId: null,
  } as unknown as Parameters<ReturnType<typeof createProactiveScheduler>["observe"]>[0];
}
