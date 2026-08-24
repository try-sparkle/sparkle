// The recorder's own guards — the two invariants the `search_history` GATE depends on.
//
// Both were asserted in prose only (roborev 61950/61957): `conciergeTools/workspace.ts` says
// "SATISFIED: source is `concierge`" and "SATISFIED: `agentId` is null", and nothing executable held
// either. That is the shape this repo calls its #1 finding, and the consequence here is not cosmetic
// — if a later edit writes the row under `build`, or stamps the column's `mountedAgentId` onto it:
//
//   • `search_history`'s DEFAULT scope returns the row with no approval card at all, because the
//     filter is on `source` and nothing else; and
//   • `prune_in_with_max`'s `source <> 'concierge'` age statements start deleting the founder's
//     conversation at the 24h tier, which is the exact opposite of "kept forever".
//
// Both failures are silent and both are in the permissive/destructive direction, so they get tests.
import { describe, expect, it, beforeEach, vi } from "vitest";
import { startConciergeHistoryCapture } from "./conciergeHistoryCapture";
import {
  useConciergeThreadStore,
  RESTORED_ID_PREFIX,
  BRAIN_ID_PREFIX,
} from "../stores/conciergeThreadStore";
import type { HistoryEntry } from "./history";
import type { ConciergeMessage } from "../components/Concierge/types";
import {
  conciergeSessionToken,
  historyRowId,
  bubbleIdForCurrentSession,
  __resetConciergeSessionTokenForTest,
} from "./conciergeSessionToken";

const you = (id: string, text: string): ConciergeMessage =>
  ({ id, kind: "you", text }) as ConciergeMessage;
const sparkle = (id: string, text: string): ConciergeMessage =>
  ({ id, kind: "sparkle", text }) as ConciergeMessage;

/** Drive the REAL capture with only the sink swapped — the seam is already on the deps object, so
 *  this exercises the production subscription and entry-building path rather than a copy of it. */
function capture() {
  const recorded: HistoryEntry[] = [];
  const stop = startConciergeHistoryCapture({ record: (e) => void recorded.push(e) });
  return { recorded, stop };
}

beforeEach(() => {
  useConciergeThreadStore.setState({ chat: [] });
  // A fresh namespace per test, so no test depends on a token another one happened to mint.
  __resetConciergeSessionTokenForTest();
});

describe("the two invariants the search_history gate depends on", () => {
  it("stamps source `concierge` on BOTH halves — the literal the filter and the retention SQL match", () => {
    const { recorded, stop } = capture();
    useConciergeThreadStore.setState({
      chat: [you("m1", "an ask"), sparkle("m2", "an answer")],
    });
    stop();

    expect(recorded.map((e) => e.kind)).toEqual(["prompt", "response"]);
    // Both, asserted together: a test that checked only the prompt would stay green against a
    // recorder that dropped every reply — which is what the pre-existing AgentPane-shaped capture
    // does, so it is a live regression shape and not a hypothetical one.
    for (const e of recorded) expect(e.source).toBe("concierge");
  });

  it("never carries an agent or project id, so the auto-allowed terminal tier cannot reach it", () => {
    // `conciergeTools/terminal.ts`'s history tier is `read-only` (auto-allowed) and selects by
    // `agentId`. It also drops `source: "concierge"`, but that defence must not be the only one:
    // stamping a live agent id here would put private text one filter away in a tool that never asks.
    //
    // THE IDS ARE THE INVARIANT, NOT THE NAMES (sparkle-yd1ud × sparkle-s7rfc). `agentName` used to
    // be asserted null in this same loop, which read as though the whole row had to be blank. It
    // does not: nothing selects on `agentName` — it appears only in `search_history`'s result schema
    // — so the name is a DISPLAY label and a null one renders as an unlabelled orphan row. The merge
    // took main's `"Concierge"` for it, pinned separately below so this row keeps saying exactly one
    // thing.
    const { recorded, stop } = capture();
    useConciergeThreadStore.setState({ chat: [you("m1", "private"), sparkle("m2", "reply")] });
    stop();

    expect(recorded).toHaveLength(2);
    for (const e of recorded) {
      expect(e.agentId).toBeNull();
      expect(e.projectId).toBeNull();
      expect(e.projectName).toBeNull();
    }
  });

  it("labels the rows `Concierge` so a search hit is not an unattributed orphan", () => {
    // The concierge has no agent row, so the ID stays null (above) — but a hit in the palette shows
    // its source, and `null` there reads as "we don't know where this came from" for the one source
    // we always know. Carried over from the deleted `services/conciergeHistory.ts`, which is the
    // half of main's implementation worth keeping.
    const { recorded, stop } = capture();
    useConciergeThreadStore.setState({ chat: [you("m1", "an ask"), sparkle("m2", "an answer")] });
    stop();

    expect(recorded).toHaveLength(2);
    for (const e of recorded) expect(e.agentName).toBe("Concierge");
  });
});

describe("what it captures, and what it declines to", () => {
  it("captures what is already on screen at mount, not only what arrives after", () => {
    // A thread rehydrated from localStorage before the subscription starts would otherwise never be
    // indexed — the founder's most recent conversation is exactly the one he would search for.
    useConciergeThreadStore.setState({ chat: [you("pre", "said before mount")] });
    const { recorded, stop } = capture();
    stop();
    expect(recorded.map((e) => e.text)).toEqual(["said before mount"]);
  });

  it("records each message ONCE across repeated store writes", () => {
    const { recorded, stop } = capture();
    useConciergeThreadStore.setState({ chat: [you("m1", "once")] });
    useConciergeThreadStore.setState({ chat: [you("m1", "once"), sparkle("m2", "two")] });
    useConciergeThreadStore.setState({
      chat: [you("m1", "once"), sparkle("m2", "two"), you("m3", "three")],
    });
    stop();
    expect(recorded.filter((e) => e.text === "once")).toHaveLength(1);
    expect(recorded).toHaveLength(3);
  });

  it("keys the row on `<sessionToken>:<bubbleId>`, NOT on the bare bubble id", () => {
    // `record_into` is INSERT OR IGNORE on this primary key. The bubble id alone is unique only
    // WITHIN one app load — `ConciergeHost`'s `nextId` counter restarts at 0 on reload — so using it
    // bare made the next load's `you-1` collide with, and be silently dropped in favour of, the
    // previous load's. Namespacing keeps the within-session dedupe (the token is constant for the
    // load) while making the key unique across loads. See the cross-load suite at the bottom.
    const { recorded, stop } = capture();
    useConciergeThreadStore.setState({ chat: [you("bubble-42", "x")] });
    stop();
    expect(recorded[0]!.id).not.toBe("bubble-42");
    expect(recorded[0]!.id).toBe(`${conciergeSessionToken()}:bubble-42`);
    // And the row is still resolvable back to the live bubble, which is what the scrubber rail
    // needs — namespacing must not cost us the ability to jump to the message.
    expect(bubbleIdForCurrentSession(recorded[0]!.id)).toBe("bubble-42");
  });

  it("skips RESTORED bubbles, whose ids are rewritten and so could never dedupe", () => {
    const { recorded, stop } = capture();
    useConciergeThreadStore.setState({
      chat: [
        you(`${RESTORED_ID_PREFIX}old`, "from a previous session"),
        you("fresh", "said now"),
      ],
    });
    stop();
    // Without this, every restart re-indexes the whole visible thread under fresh ids.
    expect(recorded.map((e) => e.text)).toEqual(["said now"]);
  });

  it("ignores feed-derived rows and blank text", () => {
    const { recorded, stop } = capture();
    useConciergeThreadStore.setState({
      chat: [
        { id: "d1", kind: "digest", text: "3 need you" } as ConciergeMessage,
        // A REAL recap, not a `{ kind, text }` stand-in: `ConciergeRecapMessage` has no `text` at
        // all, so the stand-in was an excess-property cast that stopped compiling. Building the
        // actual shape also makes the case stronger — this is the row the capture must skip because
        // of its KIND, and a fixture that could never exist proves nothing about the real one.
        {
          id: "r1",
          kind: "recap",
          awayMs: 60_000,
          needsYou: [],
          finished: [],
          decisions: [],
        } as ConciergeMessage,
        you("blank", "   "),
        you("real", "real text"),
      ],
    });
    stop();
    expect(recorded.map((e) => e.text)).toEqual(["real text"]);
  });

  it("stops recording once unsubscribed", () => {
    const { recorded, stop } = capture();
    stop();
    useConciergeThreadStore.setState({ chat: [you("after", "post-unsubscribe")] });
    expect(recorded).toHaveLength(0);
  });

  it("a throwing sink cannot break the thread store's listener chain", () => {
    // This subscriber runs inside zustand's listener loop, which propagates a throw out of
    // `setState` — so one failure here would stop every LATER subscriber and surface as a failed
    // render at the call site that merely posted a message. Capture is bookkeeping; it does not get
    // to break the conversation it observes.
    const boom = vi.fn(() => {
      throw new Error("bridge unavailable");
    });
    const stop = startConciergeHistoryCapture({ record: boom });
    expect(() =>
      useConciergeThreadStore.setState({ chat: [you("m1", "still renders")] }),
    ).not.toThrow();
    expect(boom).toHaveBeenCalled();
    stop();
  });
});

// ══ A STREAMED REPLY IS INDEXED WHOLE, OR NOT AT ALL (roborev 62934) ═════════════════════════════
// The regression these pin is silent and permanent. `ConciergeHost` upserts a brain reply on EVERY
// delta — roughly per token chunk — so the bubble enters the store holding its first few tokens. A
// capture that fired on that first write would index the fragment and could never repair it: the
// sink is `INSERT OR IGNORE` on the bubble id, so the final text is dropped. Every row for every
// reply would be a few tokens long, and nothing would say so.
//
// `records each message ONCE across repeated store writes` cannot catch this — it only ever appends
// NEW ids, so it is green against a recorder that finalises on first sight. These drive the shape
// the component actually produces: one id, growing text, then a settle.
describe("a streamed reply is captured at its FINAL text, not its first chunk", () => {
  /** What `ConciergeHost.key()` builds. Imported rather than spelled so a prefix change breaks here
   *  rather than silently making every row below a `postSparkle`-shaped one that skips the gate. */
  const brain = (turnId: string, text: string, settled?: true): ConciergeMessage =>
    ({ id: `${BRAIN_ID_PREFIX}${turnId}`, kind: "sparkle", text, settled }) as ConciergeMessage;

  it("records nothing while deltas are still arriving", () => {
    const { recorded, stop } = capture();
    useConciergeThreadStore.setState({ chat: [brain("7", "I'll")] });
    useConciergeThreadStore.setState({ chat: [brain("7", "I'll get that")] });
    stop();
    expect(recorded).toHaveLength(0);
  });

  it("records the FINAL text once the turn settles", () => {
    const { recorded, stop } = capture();
    useConciergeThreadStore.setState({ chat: [brain("7", "I'll")] });
    useConciergeThreadStore.setState({ chat: [brain("7", "I'll get that")] });
    useConciergeThreadStore.setState({ chat: [brain("7", "I'll get that started.", true)] });
    stop();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.text).toBe("I'll get that started.");
  });

  it("indexes the CORRECTED reply on the lint-block path, never the violating draft", () => {
    // The worst shape: the draft streams fully onto the screen, `blankHeldBubble` takes it off while
    // the correction turn runs, and `settleHold` puts the corrected text back and settles it. A
    // capture that finalised on first sight would index the text the linter REJECTED and never the
    // one he was shown — inverting this module's invariant instead of upholding it. The blank middle
    // step is also why a bubble that yields no entry must not be marked seen.
    const { recorded, stop } = capture();
    useConciergeThreadStore.setState({ chat: [brain("9", "Say go and I'll spawn the worker")] });
    useConciergeThreadStore.setState({ chat: [brain("9", "")] });
    useConciergeThreadStore.setState({ chat: [brain("9", "Want me to spawn the worker?", true)] });
    stop();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.text).toBe("Want me to spawn the worker?");
  });

  it("still captures a proactive post, which is whole on arrival and never settles", () => {
    // `postSparkle` notices, receipts and refusals are appended complete and nothing ever stamps
    // them `settled` — `replyAnchors` reads that field to find the previous real ANSWER, and a
    // receipt that ended a burst is a defect it already fixed. So the gate keys on the id namespace,
    // not on `settled` alone; gating on `settled` would index none of these.
    const { recorded, stop } = capture();
    useConciergeThreadStore.setState({ chat: [sparkle("sparkle-4", "Sent to Kraken Auth.")] });
    stop();
    expect(recorded.map((e) => e.text)).toEqual(["Sent to Kraken Auth."]);
  });

  it("indexes an ABANDONED fragment once its stream ends, because it is still on screen", () => {
    // roborev 62935. Waiting for `settled` alone dropped a whole class of reply the founder DID
    // read: a turn that fails mid-stream, or that a newer send supersedes mid-stream, keeps its
    // painted text in the thread forever (ConciergeMessage's ABANDONED FRAGMENT note) and never
    // settles. `streamEnded` is what says it has stopped growing without having answered.
    const { recorded, stop } = capture();
    useConciergeThreadStore.setState({ chat: [brain("11", "I'll get that st")] });
    expect(recorded).toHaveLength(0);
    useConciergeThreadStore.setState({
      chat: [
        { ...brain("11", "I'll get that st"), streamEnded: true } as ConciergeMessage,
      ],
    });
    stop();
    expect(recorded.map((e) => e.text)).toEqual(["I'll get that st"]);
  });

  it("does not double-record a reply that ends AND settles", () => {
    // The two markers are independent fields and a bubble could carry both if the exits ever
    // overlap. `seen` is what makes that one row, and it is worth pinning because the sink's own
    // dedupe (INSERT OR IGNORE on the id) would hide a second write from this test but not from
    // the log.
    const { recorded, stop } = capture();
    useConciergeThreadStore.setState({ chat: [brain("12", "done", true)] });
    useConciergeThreadStore.setState({
      chat: [{ ...brain("12", "done", true), streamEnded: true } as ConciergeMessage],
    });
    stop();
    expect(recorded).toHaveLength(1);
  });

  it("captures the founder's own message immediately — it is never streamed", () => {
    // The prompt half must NOT wait for anything. It is appended whole at send, and a `you` bubble
    // has no settle to wait for, so a gate that treated both kinds alike would index nothing at all.
    const { recorded, stop } = capture();
    useConciergeThreadStore.setState({ chat: [you("you-1", "what needs me?")] });
    expect(recorded.map((e) => e.text)).toEqual(["what needs me?"]);
    stop();
  });
});

// ══ TWO APP LOADS, THE SAME BUBBLE IDS, AND ALL FOUR MESSAGES SURVIVE ════════════════════════════
// The regression this pins ran silently for ten days and cost the founder his own words.
//
// `ConciergeHost.tsx` mints bubble ids from `let seq = 0; nextId(p) => `${p}-${++seq}``, a
// MODULE-LEVEL counter that restarts at 0 on every app reload. This module used the bubble id as the
// history row's primary key, and the Rust sink is `INSERT OR IGNORE` on that key. So load #2's
// `you-1` was a different message under an already-taken key, and the write was discarded with no
// error anywhere. Measured on the live DB: 199 of 200 on-screen bubbles shared an id with a row
// holding DIFFERENT text; one whole day of conversation left zero rows.
//
// Nothing in the pre-existing suite above could see this — every test lives inside a single app
// load, which is exactly the scope in which the old scheme was correct.
describe("row ids survive an app reload that restarts the bubble counter", () => {
  /** Run one app load's worth of conversation through the REAL capture entry point. */
  function appLoad(record: (e: HistoryEntry) => void, chat: ConciergeMessage[]): void {
    // A reload starts with an empty thread and a fresh subscription, same as mount.
    useConciergeThreadStore.setState({ chat: [] });
    const stop = startConciergeHistoryCapture({ record });
    useConciergeThreadStore.setState({ chat });
    stop();
  }

  it("records four DISTINCT rows, and all four texts, from two loads using ids you-1/sparkle-1", () => {
    const recorded: HistoryEntry[] = [];
    const record = (e: HistoryEntry) => void recorded.push(e);

    appLoad(record, [you("you-1", "load one: what needs me?"), sparkle("sparkle-1", "load one: two things.")]);

    // ── THE APP RELOADED ── `seq` is back at 0, so the next conversation reuses the same ids.
    __resetConciergeSessionTokenForTest();

    appLoad(record, [you("you-1", "load two: ship the fix"), sparkle("sparkle-1", "load two: on it.")]);

    expect(recorded).toHaveLength(4);
    // The MECHANISM: four keys, so nothing can be ignored as a duplicate.
    expect(new Set(recorded.map((e) => e.id)).size).toBe(4);
    // The DELIVERABLE: four messages. Asserting on the texts is the point — distinct ids are only
    // how we get here, and a test that stopped at id inequality would not notice a capture that
    // dropped a message for some other reason.
    expect(recorded.map((e) => e.text).sort()).toEqual(
      [
        "load one: what needs me?",
        "load one: two things.",
        "load two: ship the fix",
        "load two: on it.",
      ].sort(),
    );
  });

  it("SURVIVES A SINK THAT REALLY BEHAVES LIKE `INSERT OR IGNORE` — first write on a key wins", () => {
    // The test above pushes into an array, so it can only prove the ids differ. This one models the
    // sink's actual semantics (src-tauri/src/history.rs `record_into`, pinned there by
    // `duplicate_id_is_ignored`): a Map keyed on the row id where a second write on a taken key is
    // DISCARDED. That is the machine that ate the founder's messages, and it is the only shape in
    // which the loss is visible as loss rather than as an id detail.
    //
    // Against the pre-fix `id: m.id` this holds 2 entries — load two's prompt and reply are gone —
    // so it fails on the size assertion AND on the two missing texts.
    const db = new Map<string, HistoryEntry>();
    const insertOrIgnore = (e: HistoryEntry) => {
      if (db.has(e.id)) return; // OR IGNORE
      db.set(e.id, e);
    };

    appLoad(insertOrIgnore, [you("you-1", "day one prompt"), sparkle("sparkle-1", "day one reply")]);
    __resetConciergeSessionTokenForTest();
    appLoad(insertOrIgnore, [you("you-1", "day two prompt"), sparkle("sparkle-1", "day two reply")]);

    expect(db.size).toBe(4);
    const stored = [...db.values()].map((e) => e.text);
    for (const text of ["day one prompt", "day one reply", "day two prompt", "day two reply"]) {
      expect(stored).toContain(text);
    }
  });

  it("still ignores a genuine re-write of the SAME bubble within ONE load", () => {
    // The paired half: namespacing must not have bought cross-load uniqueness by giving up the
    // within-load dedupe. Without this, "four rows from two loads" is also satisfied by a capture
    // that writes a fresh id every time it sees a bubble — which would re-index the whole thread on
    // every store write.
    const db = new Map<string, HistoryEntry>();
    const insertOrIgnore = (e: HistoryEntry) => {
      if (db.has(e.id)) return;
      db.set(e.id, e);
    };

    // Two separate subscriptions over one load, both seeing the same bubble.
    useConciergeThreadStore.setState({ chat: [] });
    const stopA = startConciergeHistoryCapture({ record: insertOrIgnore });
    const stopB = startConciergeHistoryCapture({ record: insertOrIgnore });
    useConciergeThreadStore.setState({ chat: [you("you-1", "said once")] });
    useConciergeThreadStore.setState({ chat: [you("you-1", "said once"), sparkle("sparkle-1", "answered")] });
    stopA();
    stopB();

    expect(db.size).toBe(2);
  });

  it("keys its own `seen` set on the namespaced id, so a reload is not mistaken for a re-render", () => {
    // `seen` is module-local to one `startConciergeHistoryCapture` call, so the two-load tests above
    // never exercise it across a reload. This drives ONE long-lived subscription across a token
    // reset — the shape a capture that outlived a reload would have — and pins that the second
    // load's identically-idded message is still recorded rather than swallowed as already-seen.
    const recorded: HistoryEntry[] = [];
    const stop = startConciergeHistoryCapture({ record: (e) => void recorded.push(e) });
    useConciergeThreadStore.setState({ chat: [you("you-1", "before reload")] });
    __resetConciergeSessionTokenForTest();
    useConciergeThreadStore.setState({ chat: [you("you-1", "after reload")] });
    stop();

    expect(recorded.map((e) => e.text)).toEqual(["before reload", "after reload"]);
    expect(new Set(recorded.map((e) => e.id)).size).toBe(2);
  });

  it("does not re-capture a RESTORED bubble, which its own load already wrote", () => {
    // A restored bubble is a replay of a message a PREVIOUS load already recorded under that load's
    // token. Capturing it now would stamp it with THIS load's token, so it could not dedupe against
    // the original even in principle — a real duplicate row of the same words, once per restart,
    // forever. The skip is why namespacing does not reopen the problem it used to guard.
    const recorded: HistoryEntry[] = [];
    const stop = startConciergeHistoryCapture({ record: (e) => void recorded.push(e) });
    useConciergeThreadStore.setState({
      chat: [you(`${RESTORED_ID_PREFIX}1`, "replayed from last load"), you("you-1", "typed just now")],
    });
    stop();

    expect(recorded.map((e) => e.text)).toEqual(["typed just now"]);
    expect(recorded[0]!.id).toBe(historyRowId("you-1"));
  });
});
