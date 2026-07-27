import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  armIntent,
  armedIntents,
  cancelIntent,
  clearAllIntents,
  confirmIntent,
  countdownAnnouncement,
  countdownSentence,
  fireIntent,
  getIntent,
  isStale,
  queuedIntents,
  remainingMs,
  remainingSeconds,
  resumeQueuedIntents,
  shouldDispatchOnExpiry,
  subscribeIntents,
  STALE_INTENT_MS,
  type DispatchIntent,
  type DispatchPresence,
} from "./dispatchIntent";
import { DESTRUCTIVE_DELAY_MS, ROUTINE_DELAY_MS } from "./dispatchClass";
import type { DispatchAuthority } from "./dispatchAuthority";

/** A recording harness: arms an intent and captures what its expiry did. */
function harness(over: Partial<Parameters<typeof armIntent>[0]> = {}) {
  const dispatched: Array<{ intent: DispatchIntent; authority: DispatchAuthority }> = [];
  const queued: DispatchIntent[] = [];
  const cancelled: DispatchIntent[] = [];
  const represented: DispatchIntent[] = [];
  let presence: DispatchPresence = "here";
  const intent = armIntent({
    text: "add retry logic",
    targetAgentId: "ag-1",
    targetName: "Kraken Auth",
    presence: () => presence,
    onDispatch: (i, authority) => dispatched.push({ intent: i, authority }),
    onQueue: (i) => queued.push(i),
    onCancel: (i) => cancelled.push(i),
    onRepresent: (i) => represented.push(i),
    ...over,
    // AFTER the spread, so `harness({ text })` gets a matching display rather than a stale one.
    // Mirrors production when there are no attachments, where the two renderings are identical;
    // a test that cares about them DIFFERING passes `display` explicitly.
    display: over.display ?? over.text ?? "add retry logic",
  });
  return {
    intent,
    dispatched,
    queued,
    cancelled,
    represented,
    setPresence: (p: DispatchPresence) => {
      presence = p;
    },
  };
}

/** Arm a destructive send, walk away, and let it expire — the standard way to get one into the
 *  queue. Returns the harness with the intent already held. */
function queuedDestructive(over: Partial<Parameters<typeof armIntent>[0]> = {}) {
  const h = harness({ class: "destructive", ...over });
  h.setPresence("away");
  vi.advanceTimersByTime(DESTRUCTIVE_DELAY_MS);
  return h;
}

beforeEach(() => {
  vi.useFakeTimers();
  clearAllIntents();
});
afterEach(() => {
  clearAllIntents();
  vi.useRealTimers();
});

describe("shouldDispatchOnExpiry — the precedence rule", () => {
  // The rule the whole module exists to encode. Both directions, because implementing only the
  // memorable half ("destructive waits longer") is exactly how the two halves of the source spec
  // ended up contradicting each other.
  it("sends both classes while the user is HERE", () => {
    expect(shouldDispatchOnExpiry({ class: "routine" }, "here")).toBe(true);
    expect(shouldDispatchOnExpiry({ class: "destructive" }, "here")).toBe(true);
  });
  it("QUEUES a destructive intent while AWAY — presence outranks the countdown", () => {
    expect(shouldDispatchOnExpiry({ class: "destructive" }, "away")).toBe(false);
  });
  it("still sends a ROUTINE intent while AWAY", () => {
    expect(shouldDispatchOnExpiry({ class: "routine" }, "away")).toBe(true);
  });
});

describe("arming", () => {
  it("publishes the intent to subscribers with a stable snapshot identity", () => {
    const seen: number[] = [];
    const off = subscribeIntents(() => seen.push(armedIntents().length));
    const { intent } = harness();
    expect(armedIntents()).toHaveLength(1);
    expect(armedIntents()[0]!.id).toBe(intent.id);
    // Identity must NOT change between mutations, or useSyncExternalStore re-renders forever.
    expect(armedIntents()).toBe(armedIntents());
    expect(seen).toEqual([1]);
    off();
  });

  it("classifies off the text, giving a destructive send the 5s tier and a routine one 3s", () => {
    // "run the command" hits the shared APPROVAL_CATEGORIES `bash` rule → destructive.
    const destructive = harness({ text: "run the deploy command" });
    const routine = harness({ text: "add retry logic" });
    expect(destructive.intent.class).toBe("destructive");
    expect(routine.intent.class).toBe("routine");
    expect(DESTRUCTIVE_DELAY_MS).toBe(5000);
    expect(ROUTINE_DELAY_MS).toBe(3000);
  });

  it("gives the destructive tier 5s, not 3s — it survives the routine deadline", () => {
    const h = harness({ class: "destructive" });
    vi.advanceTimersByTime(ROUTINE_DELAY_MS);
    expect(h.dispatched, "a destructive send must not fire at the routine deadline").toHaveLength(0);
    expect(armedIntents()).toHaveLength(1);
    vi.advanceTimersByTime(DESTRUCTIVE_DELAY_MS - ROUTINE_DELAY_MS);
    expect(h.dispatched).toHaveLength(1);
  });
});

describe("ticking", () => {
  it("counts down and floors at zero", () => {
    const { intent } = harness({ class: "routine" });
    const t0 = intent.armedAt;
    expect(remainingMs(intent, t0)).toBe(ROUTINE_DELAY_MS);
    expect(remainingSeconds(intent, t0)).toBe(3);
    expect(remainingSeconds(intent, t0 + 1500)).toBe(2);
    expect(remainingSeconds(intent, t0 + 2500)).toBe(1);
    expect(remainingMs(intent, t0 + 99999)).toBe(0);
    expect(remainingSeconds(intent, t0 + 99999)).toBe(0);
  });

  it("announces the target, the message and the counter in one line", () => {
    const { intent } = harness({ text: "ship the DMG", targetName: "Kraken Auth" });
    expect(countdownSentence(intent)).toContain("Kraken Auth");
    expect(countdownSentence(intent)).toContain("ship the DMG");
    expect(countdownAnnouncement(intent, intent.armedAt)).toMatch(/Sending in 3…/);
  });

  it("elides a pasted paragraph rather than letting it run the banner off screen", () => {
    const { intent } = harness({ text: "x".repeat(400) });
    expect(countdownSentence(intent).length).toBeLessThan(200);
    expect(countdownSentence(intent)).toContain("…");
  });

  it("collapses newlines so the quote stays one line", () => {
    const { intent } = harness({ text: "first line\n\nsecond line" });
    expect(countdownSentence(intent)).toContain("first line second line");
  });

  // roborev 53650/53657. The banner and the live region quote `display`, never `text`. `text` is
  // the wire payload, which prefixes each attachment's quoted temp path so the agent can read the
  // file — quoting it made an attachment send announce the contents of /var/folders aloud. The
  // clean rendering is computed one line from the arm site in ConciergeHost, so it is carried.
  it("never shows or speaks an attachment's temp path", () => {
    const tempPath = "/var/folders/x9/T/sparkle-shot-1753.png";
    const { intent } = harness({
      text: `'${tempPath}' what is wrong here?`,
      display: "what is wrong here?",
    });
    expect(countdownSentence(intent)).not.toContain(tempPath);
    expect(countdownSentence(intent)).not.toContain("/var/folders");
    expect(countdownSentence(intent)).toContain("what is wrong here?");

    const spoken = countdownAnnouncement(intent, intent.armedAt);
    expect(spoken).not.toContain(tempPath);
    expect(spoken).not.toContain("/var/folders");

    // The payload itself must still carry the path — that is what the agent needs.
    expect(intent.text).toContain(tempPath);
  });
});

describe("expiry", () => {
  it("dispatches with a countdown authority naming THIS intent", () => {
    const h = harness();
    vi.advanceTimersByTime(ROUTINE_DELAY_MS);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]!.authority).toEqual({ kind: "countdown", intentId: h.intent.id });
    expect(h.queued).toHaveLength(0);
    // Gone from the banner the moment it fires.
    expect(armedIntents()).toHaveLength(0);
    expect(getIntent(h.intent.id)).toBeNull();
  });

  it("QUEUES a destructive intent that expires while away — and does NOT send it", () => {
    const h = harness({ class: "destructive" });
    h.setPresence("away");
    vi.advanceTimersByTime(DESTRUCTIVE_DELAY_MS);
    expect(h.queued, "a destructive expiry while away must queue").toHaveLength(1);
    expect(h.dispatched, "and must not reach the terminal").toHaveLength(0);
  });

  it("still SENDS a routine intent that expires while away", () => {
    const h = harness({ class: "routine" });
    h.setPresence("away");
    vi.advanceTimersByTime(ROUTINE_DELAY_MS);
    expect(h.dispatched).toHaveLength(1);
    expect(h.queued).toHaveLength(0);
  });

  it("reads presence AT EXPIRY, not at arm time — walking away mid-countdown counts", () => {
    const h = harness({ class: "destructive" });
    // Armed while Here; the user leaves during the 5 seconds.
    h.setPresence("away");
    vi.advanceTimersByTime(DESTRUCTIVE_DELAY_MS);
    expect(h.dispatched).toHaveLength(0);
    expect(h.queued).toHaveLength(1);
  });
});

describe("cancelling", () => {
  it("stops the send and never dispatches", () => {
    const h = harness();
    expect(cancelIntent(h.intent.id)?.id).toBe(h.intent.id);
    expect(armedIntents()).toHaveLength(0);
    vi.advanceTimersByTime(60_000);
    expect(h.dispatched, "a cancelled intent must never fire").toHaveLength(0);
    expect(h.queued).toHaveLength(0);
  });

  it("tells the arm site, so the user's files and draft can be handed back", () => {
    const h = harness();
    cancelIntent(h.intent.id);
    expect(h.cancelled).toHaveLength(1);
    expect(h.cancelled[0]!.id).toBe(h.intent.id);
  });

  it("is a no-op the second time, so a double-click can't report twice", () => {
    const h = harness();
    expect(cancelIntent(h.intent.id)).not.toBeNull();
    expect(cancelIntent(h.intent.id)).toBeNull();
    expect(h.cancelled, "the second cancel must not re-restore anything").toHaveLength(1);
  });

  it("cancels only the intent named, leaving the others counting", () => {
    const a = harness({ text: "message A" });
    const b = harness({ text: "message B" });
    cancelIntent(a.intent.id);
    vi.advanceTimersByTime(ROUTINE_DELAY_MS);
    expect(a.dispatched).toHaveLength(0);
    expect(b.dispatched).toHaveLength(1);
  });

  it("cannot un-send an intent that already fired", () => {
    const h = harness();
    vi.advanceTimersByTime(ROUTINE_DELAY_MS);
    expect(h.dispatched).toHaveLength(1);
    expect(cancelIntent(h.intent.id)).toBeNull();
  });
});

describe("fireIntent", () => {
  it("reports what it did and refuses an unknown id", () => {
    const h = harness();
    expect(fireIntent(h.intent.id)).toBe("dispatched");
    expect(fireIntent(h.intent.id)).toBe("unknown");
    expect(fireIntent("nope")).toBe("unknown");
  });

  it("does not double-deliver when the timer would also have fired", () => {
    const h = harness();
    fireIntent(h.intent.id);
    vi.advanceTimersByTime(60_000);
    expect(h.dispatched).toHaveLength(1);
  });
});

describe("clearAllIntents", () => {
  it("drops everything silently — no dispatch, no queue callback", () => {
    const h = harness();
    clearAllIntents();
    vi.advanceTimersByTime(60_000);
    expect(armedIntents()).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
    expect(h.queued).toHaveLength(0);
    // SILENT by contract — this is teardown, not a user cancelling a send.
    expect(h.cancelled).toHaveLength(0);
  });

  it("clears the QUEUE too, so a held intent can't leak into the next test", () => {
    queuedDestructive();
    expect(queuedIntents()).toHaveLength(1);
    clearAllIntents();
    expect(queuedIntents()).toHaveLength(0);
  });
});

// ── The queue ────────────────────────────────────────────────────────────────────────────────────
// "Queues" is only a safety property if it is distinguishable from "drops". A test asserting nothing
// but `dispatched.length === 0` passes against an implementation that threw the user's message away,
// which is the same silent-loss failure the countdown exists to remove — so every row here asserts
// the intent is still THERE, with its text, and comes back.
describe("queueing — held, not dropped", () => {
  it("keeps the intent retrievable, with its text, after an Away expiry", () => {
    const h = queuedDestructive({ text: "delete the staging bucket" });
    expect(h.dispatched, "must not have reached the terminal").toHaveLength(0);

    const held = getIntent(h.intent.id);
    expect(held, "a queued intent must survive — dropping it loses the user's message").not.toBeNull();
    expect(held!.status).toBe("queued");
    expect(held!.text, "and it must still carry what the user actually wrote").toBe(
      "delete the staging bucket",
    );
    expect(queuedIntents().map((i) => i.id)).toEqual([h.intent.id]);
  });

  it("CLEARS the timer when it queues — a held send is not still counting down", () => {
    const h = queuedDestructive();
    expect(getIntent(h.intent.id)!.timerId).toBeNull();
    // Nothing left to fire: an hour passes and it is still exactly where it was.
    vi.advanceTimersByTime(60 * 60_000);
    expect(h.dispatched).toHaveLength(0);
    expect(queuedIntents()).toHaveLength(1);
  });

  it("is NOT in the banner while held — the banner shows what is counting down", () => {
    queuedDestructive();
    expect(armedIntents()).toHaveLength(0);
    expect(queuedIntents()).toHaveLength(1);
  });

  it("survives until the away → here transition, then re-presents with a FRESH countdown", () => {
    const h = queuedDestructive();
    // Time passes while the user is out — but well short of stale.
    vi.advanceTimersByTime(30_000);
    h.setPresence("here");
    resumeQueuedIntents();

    expect(h.represented, "coming back must be announced, not silent").toHaveLength(1);
    const back = getIntent(h.intent.id)!;
    expect(back.status).toBe("armed");
    expect(back.needsConfirmation).toBe(false);
    // A FULL window, not the remains of the one it expired out of 30 seconds ago.
    expect(remainingMs(back, Date.now())).toBe(DESTRUCTIVE_DELAY_MS);
    // `armedAt` is the intent's AGE and must NOT be rewritten — staleness is measured from it.
    expect(back.armedAt).toBe(h.intent.armedAt);

    vi.advanceTimersByTime(DESTRUCTIVE_DELAY_MS);
    expect(h.dispatched, "and it finally sends, under a countdown authority").toHaveLength(1);
    expect(h.dispatched[0]!.authority).toEqual({ kind: "countdown", intentId: h.intent.id });
  });

  it("stays queued if the user is still away when the drain runs", () => {
    const h = queuedDestructive();
    resumeQueuedIntents(); // called while still away — must not present anything
    expect(h.represented).toHaveLength(0);
    expect(queuedIntents()).toHaveLength(1);
    expect(armedIntents()).toHaveLength(0);
  });

  it("can be cancelled while held, and then it is really gone", () => {
    const h = queuedDestructive();
    expect(cancelIntent(h.intent.id)?.id).toBe(h.intent.id);
    expect(h.cancelled, "the arm site still gets its files and draft back").toHaveLength(1);
    expect(getIntent(h.intent.id)).toBeNull();
    expect(queuedIntents()).toHaveLength(0);
  });

  it("a routine intent never reaches the queue at all", () => {
    const h = harness({ class: "routine" });
    h.setPresence("away");
    vi.advanceTimersByTime(ROUTINE_DELAY_MS);
    expect(h.dispatched).toHaveLength(1);
    expect(queuedIntents()).toHaveLength(0);
  });
});

// ── Serialization ────────────────────────────────────────────────────────────────────────────────
// THE correction that motivates the one-at-a-time drain. The queue is plural and unbounded; the
// column has ONE `role="status"` announcer. If N held intents re-armed together, one would be
// announced and the rest would run their 3–5 seconds out unheard and dispatch — "a destructive
// command fired without the user seeing it", rebuilt on the return edge.
describe("re-presenting many — one at a time", () => {
  it("arms only the HEAD, and the next only after the head resolves", () => {
    const a = queuedDestructive({ text: "drop the users table" });
    // A second held send, armed a tick later so the ordering is unambiguous.
    vi.advanceTimersByTime(1000);
    const b = queuedDestructive({ text: "force push to main" });
    expect(queuedIntents()).toHaveLength(2);

    a.setPresence("here");
    b.setPresence("here");
    resumeQueuedIntents();

    // THE ASSERTION. Exactly one is counting down; the other is still held.
    expect(armedIntents().map((i) => i.id), "only the head may arm").toEqual([a.intent.id]);
    expect(queuedIntents().map((i) => i.id)).toEqual([b.intent.id]);

    // Halfway through the head's window: still exactly one counting down.
    vi.advanceTimersByTime(DESTRUCTIVE_DELAY_MS / 2);
    expect(armedIntents()).toHaveLength(1);

    // The head resolves — and only now does the next take the banner.
    vi.advanceTimersByTime(DESTRUCTIVE_DELAY_MS / 2);
    expect(a.dispatched).toHaveLength(1);
    expect(b.dispatched, "the second must not have fired alongside the first").toHaveLength(0);
    expect(armedIntents().map((i) => i.id)).toEqual([b.intent.id]);

    vi.advanceTimersByTime(DESTRUCTIVE_DELAY_MS);
    expect(b.dispatched).toHaveLength(1);
  });

  it("never has two counting down at ANY moment of the drain", () => {
    const a = queuedDestructive({ text: "drop the users table" });
    vi.advanceTimersByTime(1000);
    const b = queuedDestructive({ text: "force push to main" });
    vi.advanceTimersByTime(1000);
    const c = queuedDestructive({ text: "rm -rf node_modules" });

    a.setPresence("here");
    b.setPresence("here");
    c.setPresence("here");
    resumeQueuedIntents();

    // Sample the registry every 250ms (the banner's own tick) across the whole drain. If any
    // implementation re-armed the queue in bulk, one of these samples would see two.
    let maxConcurrent = 0;
    for (let t = 0; t < DESTRUCTIVE_DELAY_MS * 4; t += 250) {
      maxConcurrent = Math.max(maxConcurrent, armedIntents().length);
      vi.advanceTimersByTime(250);
    }
    expect(maxConcurrent, "at most one send may be counting down at a time").toBe(1);
    // And all three still got sent — serializing must not lose the tail.
    expect(a.dispatched).toHaveLength(1);
    expect(b.dispatched).toHaveLength(1);
    expect(c.dispatched).toHaveLength(1);
  });

  it("moves the queue up when the head is CANCELLED, not only when it sends", () => {
    const a = queuedDestructive({ text: "drop the users table" });
    vi.advanceTimersByTime(1000);
    const b = queuedDestructive({ text: "force push to main" });
    a.setPresence("here");
    b.setPresence("here");
    resumeQueuedIntents();

    cancelIntent(a.intent.id);
    // Declining one held send must not strand every send behind it.
    expect(armedIntents().map((i) => i.id)).toEqual([b.intent.id]);
  });

  it("stops the drain if the user turns away again partway through", () => {
    const a = queuedDestructive({ text: "drop the users table" });
    vi.advanceTimersByTime(1000);
    const b = queuedDestructive({ text: "force push to main" });
    a.setPresence("here");
    b.setPresence("here");
    resumeQueuedIntents();

    // The user leaves while the head is counting down. The head re-queues on its own expiry, and
    // the one behind it must NOT be promoted into an unwatched countdown.
    a.setPresence("away");
    b.setPresence("away");
    vi.advanceTimersByTime(DESTRUCTIVE_DELAY_MS);
    expect(a.dispatched).toHaveLength(0);
    expect(armedIntents(), "nothing may arm while nobody is watching").toHaveLength(0);
    expect(queuedIntents()).toHaveLength(2);
  });
});

// ── Staleness ────────────────────────────────────────────────────────────────────────────────────
// The countdown's bargain is "you saw this go past and chose not to stop it". After a long absence
// the user has no memory of the message to hold it up against, so re-arming a timer would ask them
// to veto something they no longer recognise, in five seconds, from a standing start.
describe("staleness — an old held intent needs an explicit yes", () => {
  it("isStale is measured from the ORIGINAL send, at the named constant", () => {
    const at = { armedAt: 1_000_000 };
    expect(isStale(at, at.armedAt + STALE_INTENT_MS - 1)).toBe(false);
    expect(isStale(at, at.armedAt + STALE_INTENT_MS)).toBe(true);
  });

  it("re-presents with NO timer and NEVER auto-dispatches", () => {
    const h = queuedDestructive({ text: "drop the users table" });
    vi.advanceTimersByTime(STALE_INTENT_MS);
    h.setPresence("here");
    resumeQueuedIntents();

    const back = getIntent(h.intent.id)!;
    expect(back.needsConfirmation, "an old send must ask before it goes").toBe(true);
    expect(back.timerId, "and it must have no deadline at all").toBeNull();
    // THE assertion. An hour of timers, and it has still not sent itself.
    vi.advanceTimersByTime(60 * 60_000);
    expect(h.dispatched, "a stale intent must NEVER auto-dispatch").toHaveLength(0);
    expect(armedIntents(), "it stays in front of the user until they act").toHaveLength(1);
  });

  it("says so in the announcement instead of reading out a countdown", () => {
    const h = queuedDestructive();
    vi.advanceTimersByTime(STALE_INTENT_MS);
    h.setPresence("here");
    resumeQueuedIntents();

    const line = countdownAnnouncement(getIntent(h.intent.id)!, Date.now());
    expect(line).toContain("held it");
    expect(line, "a deadline that never arrives must not be announced").not.toContain("Sending in");
  });

  it("sends on an explicit confirm — under an ordinary countdown, not instantly", () => {
    const h = queuedDestructive();
    vi.advanceTimersByTime(STALE_INTENT_MS);
    h.setPresence("here");
    resumeQueuedIntents();

    expect(confirmIntent(h.intent.id)?.id).toBe(h.intent.id);
    // Still a window with a Cancel button in it — confirming is not a bypass of the countdown.
    expect(h.dispatched, "confirming must not dispatch on the spot").toHaveLength(0);
    expect(getIntent(h.intent.id)!.needsConfirmation).toBe(false);
    expect(remainingMs(getIntent(h.intent.id)!, Date.now())).toBe(DESTRUCTIVE_DELAY_MS);

    vi.advanceTimersByTime(DESTRUCTIVE_DELAY_MS);
    expect(h.dispatched).toHaveLength(1);
  });

  it("can still be declined outright", () => {
    const h = queuedDestructive();
    vi.advanceTimersByTime(STALE_INTENT_MS);
    h.setPresence("here");
    resumeQueuedIntents();
    cancelIntent(h.intent.id);
    vi.advanceTimersByTime(60 * 60_000);
    expect(h.dispatched).toHaveLength(0);
    expect(h.cancelled).toHaveLength(1);
  });

  it("confirmIntent refuses anything that is not awaiting confirmation", () => {
    const h = harness();
    expect(confirmIntent(h.intent.id), "a counting intent has nothing to confirm").toBeNull();
    expect(confirmIntent("nope")).toBeNull();
  });

  it("fireIntent refuses to move one — no stray timer can send it", () => {
    const h = queuedDestructive();
    // Held: no deadline to elapse.
    expect(fireIntent(h.intent.id)).toBe("unknown");
    vi.advanceTimersByTime(STALE_INTENT_MS);
    h.setPresence("here");
    resumeQueuedIntents();
    // Awaiting confirmation: still not something an expiry may resolve.
    expect(fireIntent(h.intent.id)).toBe("unknown");
    expect(h.dispatched).toHaveLength(0);
  });

  it("a NOT-yet-stale intent re-presents with a real countdown", () => {
    const h = queuedDestructive();
    vi.advanceTimersByTime(STALE_INTENT_MS - DESTRUCTIVE_DELAY_MS - 1000);
    h.setPresence("here");
    resumeQueuedIntents();
    expect(getIntent(h.intent.id)!.needsConfirmation).toBe(false);
    vi.advanceTimersByTime(DESTRUCTIVE_DELAY_MS);
    expect(h.dispatched).toHaveLength(1);
  });
});

// ── The seam itself ──────────────────────────────────────────────────────────────────────────────
describe("the presence seam fails SAFE", () => {
  it("treats a presence getter that THROWS as away", () => {
    // A getter is someone else's code — a store read, a hook escape hatch. If it fails we know
    // nothing about whether anyone is watching, and "I don't know" has to mean "don't send".
    const h = harness({
      class: "destructive",
      presence: () => {
        throw new Error("store not ready");
      },
    });
    vi.advanceTimersByTime(DESTRUCTIVE_DELAY_MS);
    expect(h.dispatched, "an unreadable presence must not authorize a destructive send").toHaveLength(0);
    expect(queuedIntents()).toHaveLength(1);
  });

  it("still delivers a ROUTINE send when presence is unreadable", () => {
    // Fail-safe, not fail-shut: the rule holds back destructive sends, not everything.
    const h = harness({
      class: "routine",
      presence: () => {
        throw new Error("store not ready");
      },
    });
    vi.advanceTimersByTime(ROUTINE_DELAY_MS);
    expect(h.dispatched).toHaveLength(1);
  });
});
