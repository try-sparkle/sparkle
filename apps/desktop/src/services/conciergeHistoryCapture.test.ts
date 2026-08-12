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

  it("uses the bubble id as the row id, which is what makes dedupe structural", () => {
    // `record_into` is INSERT OR IGNORE on this primary key, so a re-render or a second subscribe
    // cannot produce a duplicate row. Any other id scheme silently gives up that property.
    const { recorded, stop } = capture();
    useConciergeThreadStore.setState({ chat: [you("bubble-42", "x")] });
    stop();
    expect(recorded[0]!.id).toBe("bubble-42");
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
