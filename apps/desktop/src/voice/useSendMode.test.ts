// @vitest-environment jsdom
//
// PUSH-TO-TALK RELEASE — what actually leaves the box when he lets go.
//
// WHAT THESE ROWS ASSERT, and why it is the sent TEXT rather than a call count. The bug being fixed
// here is not "the send did not happen"; it is that the send happened with the wrong words in it —
// the tail of the sentence had not arrived yet. A row asserting `onSend` was called is already green
// against the broken code, which is the vacuous test AGENTS.md warns about. So the composer is
// modelled as a box these tests can write into the way the real pipeline does, and every row asserts
// the STRING that went out.
//
// THE PIPELINE IS MODELLED FROM ITS OWN CONTRACT, not invented:
//   • `dictation://interim` — the live preview, cloud only, replaced in place (dictationStore.interim)
//   • `dictation://partial` — a COMMITTED segment. useDictation clears the interim and then inserts,
//     and ComposeBox's `append` puts dictated text at the caret, which follows the text: so a segment
//     lands AFTER whatever was already in the box.
//   • `dictation://speech-end` — the engine's endpoint decision, bumping `speechEndSeq`. Rust emits
//     it AFTER the committed transcript of the same utterance, on both capture paths — that ordering
//     is the whole reason `endHold` can use it as "everything for this utterance has arrived".
//   • `dictation://speaking` — the raw Silero VAD edge, on both capture paths, with no transcription
//     latency in front of it.
// Reproducing the ORDER of those events is what makes these rows mean anything: the failure is an
// ordering failure, so a test that fired them in a convenient order would prove nothing.
import { act, renderHook } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
// The mic is not what is under test here, and the real one reaches for auth + Tauri. The intents it
// receives are asserted in the rows that care.
const micCalls: string[] = [];
vi.mock("../components/MicButton", () => ({
  useMicActions: () => ({
    intent: "paused",
    setActive: () => micCalls.push("active"),
    setMuted: () => micCalls.push("paused"),
    setOff: () => micCalls.push("off"),
  }),
}));

import { useDictationStore } from "../stores/dictationStore";
import { useUiStore } from "../stores/uiStore";
import { PARTIAL_SETTLE_CAP_MS, useSendMode } from "./useSendMode";
import { TALK_KEY } from "./usePushToTalk";

/** The composer, as far as a send is concerned: what is in it, and what left it. */
interface Box {
  /** What the box holds right now — typed, dictated, or both. */
  text: string;
  /** Every string that has actually been sent, oldest first. */
  sent: string[];
}

function setup() {
  const box: Box = { text: "", sent: [] };
  // ComposeBox.submit: an empty box early-returns false and sends nothing; otherwise the box's
  // contents go out and the box is cleared.
  const onSend = vi.fn(() => {
    if (!box.text) return false;
    box.sent.push(box.text);
    box.text = "";
    return true;
  });
  const view = renderHook(() => useSendMode({ onSend }));
  return { box, onSend, ...view };
}

// ── THE GESTURE ──────────────────────────────────────────────────────────────────────────────────
// Dispatched on `window`, because that is where usePushToTalk binds ("hold ⌘ ANYWHERE").
const down = () => act(() => void fireEvent.keyDown(window, { key: TALK_KEY }));
const up = () => act(() => void fireEvent.keyUp(window, { key: TALK_KEY }));

// ── THE PIPELINE ─────────────────────────────────────────────────────────────────────────────────
/** The VAD's edge: he started (or stopped) making a sound. Zero transcription latency. */
const vad = (speaking: boolean) => act(() => useDictationStore.setState({ speaking }));
/** Deepgram's live preview for the clause in progress. */
const interim = (t: string) => act(() => useDictationStore.getState().setInterim(t));
/**
 * A COMMITTED segment reaches this window: the interim is cleared and the text is appended to the
 * box — the two halves of useDictation's `dictation://partial` handler, in its order.
 */
const commits = (box: Box, text: string) =>
  act(() => {
    useDictationStore.getState().setInterim("");
    box.text = box.text ? `${box.text} ${text}` : text;
  });
/** The engine's endpoint decision. Always AFTER the transcript it belongs to — see the header. */
const speechEnds = () => act(() => useDictationStore.getState().noteSpeechEnd());

/** Let the queued macrotask (the send) and its render run. */
async function flush() {
  await act(async () => {
    vi.advanceTimersByTime(1);
    await Promise.resolve();
  });
}

/** Push the clock forward without asserting anything about what runs. */
async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  micCalls.length = 0;
  useUiStore.setState({ conciergeSendMode: "ptt" });
  useDictationStore.setState({
    interim: "",
    speaking: false,
    speechEndSeq: 0,
    // Anything but "terminal" — a live PTY owning the keyboard makes the tray inert and unbinds the
    // gesture, which is a different feature's row.
    focusOwner: "other",
    enabled: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a release waits for the words he already said", () => {
  it("sends the COMPLETE phrase when the final is still in flight at the keyup", async () => {
    // ── THE ROW THIS WHOLE FIX EXISTS FOR ────────────────────────────────────────────────────────
    // The relay runs endpointing=200, so a 200ms gap between clauses commits what came before it.
    // He keeps talking through that gap and lets go a beat after the last word — at which point the
    // interim is EMPTY (the commit cleared it, and the words since have not been transcribed yet)
    // and the box is a sentence short. The old `endHold` tested exactly that empty interim, decided
    // nothing was outstanding, and sent the truncated phrase.
    const { box } = setup();
    down();
    vad(true);
    interim("let's ship the");
    commits(box, "let's ship the feature");
    // …and he says "tomorrow", which has produced nothing observable yet, and lets go.
    up();

    expect(box.sent, "nothing may go out while the utterance is still open").toEqual([]);

    // The tail commits, the VAD closes, and only then does the engine close the utterance.
    commits(box, "tomorrow");
    vad(false);
    speechEnds();
    await flush();

    expect(box.sent).toEqual(["let's ship the feature tomorrow"]);
  });

  it("a clause closing MID-HOLD does not mean he has finished the sentence", async () => {
    // ── THE SECOND HALF OF THE SAME BUG ──────────────────────────────────────────────────────────
    // `dictation://speech-end` fires per ENDPOINTED CLAUSE, not once per hold: Deepgram endpoints on
    // any ~200ms gap, so a breath mid-sentence produces one. A drain that let a speech-end simply
    // clear its "something is outstanding" flag reads the rest of the sentence as nothing.
    //
    // And it could not recover, which is what makes this sharp rather than theoretical: Silero's
    // min_silence_duration is 250ms, LONGER than the 200ms gap that closed the clause, so `speaking`
    // never falls across it and there is no rising edge to re-arm on. Hence the VAD is read as a
    // LEVEL — note this row never lowers it until he has genuinely stopped.
    const { box } = setup();
    down();
    vad(true);
    interim("deploy the");
    commits(box, "deploy the");
    speechEnds(); // the clause closed on a ~220ms breath — he is still talking
    up();

    expect(box.sent, "a mid-sentence clause close must not release the send").toEqual([]);

    commits(box, "staging branch");
    vad(false);
    speechEnds();
    await flush();

    expect(box.sent).toEqual(["deploy the staging branch"]);
  });

  it("keeps waiting through the SECOND clause's own commit-plus-close", async () => {
    // The sequence endpointing=200 actually produces after a keyup that lands mid-utterance: the
    // relay commits "let's ship the feature" and, because that gap also closes THIS clause, emits
    // its speech-end right alongside it — while the VAD still reads speech, since "tomorrow" hasn't
    // been said yet. A wait subscriber that settled on the bump ALONE, without reading `speaking` /
    // `interim` live at that same event, sends the first clause and drops the rest; only a bump that
    // coincides with quiet makes a close mean the whole utterance is over.
    const { box } = setup();
    down();
    vad(true);
    interim("let's ship the");
    up();

    commits(box, "let's ship the feature");
    speechEnds();
    await flush();
    expect(box.sent, "a commit-and-close with no quiet after it must not release the send").toEqual(
      [],
    );

    commits(box, "tomorrow");
    vad(false);
    speechEnds();
    await flush();

    expect(box.sent).toEqual(["let's ship the feature tomorrow"]);
  });

  it("waits when he was ALREADY talking as the key went down", async () => {
    // The mic is armed between holds (it listens for the wake word), so the VAD can already be true
    // when the gesture starts — he began the sentence a beat before pressing. `speaking` is
    // EDGE-triggered, so no further edge is coming for that speech: the watch has to read the level
    // at the start (`startUtteranceWatch`'s seed) or that hold's audio is never accounted for at all.
    //
    // TYPED TEXT IS SEEDED FIRST so the mid-row assertion actually discriminates. With an empty box,
    // dropping the VAD from the seed and sending immediately looks identical to waiting — `onSend`
    // early-returns false either way. With "ship it" already typed, the wrong behaviour is visible
    // immediately: it goes out alone, before "by friday" has joined it.
    const { box } = setup();
    box.text = "ship it";
    vad(true);
    down();
    up();

    expect(
      box.sent,
      "speech already in progress at keydown is still speech that owes us a transcript",
    ).toEqual([]);

    commits(box, "by friday");
    vad(false);
    speechEnds();
    await flush();

    expect(box.sent).toEqual(["ship it by friday"]);
  });

  it("does not wait when the engine already closed the utterance before the keyup", async () => {
    // The other side of the same coin, and the regression the fix must not introduce: he spoke,
    // stopped, the transcript landed and the engine closed it — all before he let go. There is
    // nothing outstanding, so the send happens in the keyup's own tick. A drain that waited for the
    // NEXT speech-end would sit here for the full cap on every ordinary release.
    const { box } = setup();
    down();
    vad(true);
    interim("ship it");
    commits(box, "ship it");
    speechEnds();
    vad(false);
    up();

    expect(box.sent, "the send must not wait for a close that has already happened").toEqual([
      "ship it",
    ]);
  });
});

describe("a release is a SEND, not a send-if-there-was-speech", () => {
  it("a SILENT hold sends the typed draft, and does not sit out the cap first", async () => {
    // In this mode the release is the ONLY send path a typed draft has — `chordSends` makes ⌘↩ inert
    // in Push to talk on purpose. So a silent hold is not a no-op, and it must not feel like one:
    // the assertion is made BEFORE any timer is advanced, so a drain that ran unconditionally fails
    // this row even though it would eventually send.
    const { box } = setup();
    box.text = "ship it";
    down();
    up();

    expect(box.sent, "a silent hold sends immediately — there is nothing to drain").toEqual([
      "ship it",
    ]);

    // And nothing is left armed behind it: the message goes out once.
    await advance(PARTIAL_SETTLE_CAP_MS * 2);
    expect(box.sent).toEqual(["ship it"]);
  });

  it("puts the typed text first and appends the transcript to it", async () => {
    // He had typed something before he started speaking, so the typed words lead. The composition is
    // ComposeBox's (`append` inserts at the caret, which follows the text); what this row pins is
    // that the release does not send BEFORE the spoken half has joined the typed half — which is
    // exactly what the old empty-interim test did here, since he let go before any interim arrived.
    const { box } = setup();
    box.text = "ship it";
    down();
    vad(true);
    up();

    expect(box.sent, "the typed half must not go out on its own").toEqual([]);

    commits(box, "by friday");
    vad(false);
    speechEnds();
    await flush();

    expect(box.sent).toEqual(["ship it by friday"]);
  });
});

describe("the cap is a backstop, and it SENDS", () => {
  it("sends what is in the box when the utterance never closes", async () => {
    // A dropped socket, a relay torn down mid-utterance, or a key bumped by accident so the
    // transcript comes back empty. Losing his words is the failure being fixed — it must never be
    // what the timeout does.
    const { box } = setup();
    box.text = "ship it";
    down();
    vad(true);
    up();

    await advance(PARTIAL_SETTLE_CAP_MS - 1);
    expect(box.sent, "still draining right up to the cap").toEqual([]);

    await advance(1);
    expect(box.sent, "on expiry it sends — it never drops").toEqual(["ship it"]);
  });

  it("sends only once when the utterance closes and the cap expires", async () => {
    const { box } = setup();
    box.text = "ship it";
    down();
    vad(true);
    up();
    vad(false);
    speechEnds();
    await flush();
    await advance(PARTIAL_SETTLE_CAP_MS * 2);

    expect(box.sent).toEqual(["ship it"]);
  });
});

describe("what still must NOT send", () => {
  it("an abandoned hold sends nothing, however much was said during it", async () => {
    // ⌘Tab never delivers its keyup, so blur is the only end that hold gets — and it must not
    // dispatch the draft. The drain must not turn an abandon into a delayed send either.
    const { box } = setup();
    box.text = "ship it";
    down();
    vad(true);
    act(() => void fireEvent.blur(window));

    commits(box, "by friday");
    speechEnds();
    await advance(PARTIAL_SETTLE_CAP_MS * 2);

    expect(box.sent).toEqual([]);
  });

  it("a second hold calls off a release that is still draining", async () => {
    // He carried on talking, so the phrase he was about to send is no longer the whole of what he
    // means to say. The pending send is cancelled, not merely postponed.
    const { box } = setup();
    down();
    vad(true);
    up();
    down();

    commits(box, "and one more thing");
    speechEnds();
    await advance(PARTIAL_SETTLE_CAP_MS * 2);

    expect(box.sent, "the cancelled release must not fire behind the new hold").toEqual([]);
  });
});

// ── A TERMINAL PAUSES SPEAK, EXACTLY AS IT ALREADY PAUSES PUSH TO TALK ──────────────────────────
describe("the caret moving into a terminal pauses Speak", () => {
  /** Move the caret, through the same store field the app's focus tracker writes. */
  const caret = (owner: "terminal" | "other") =>
    act(() => useDictationStore.setState({ focusOwner: owner }));

  it("demotes Speak to the PAUSED intent while a terminal owns the keyboard", () => {
    // ── THE FOUNDER'S REPORT ──────────────────────────────────────────────────────────────────
    // "When I am in push to talk mode and I go into terminal, that works correctly — it turns the
    // microphone off. But when it's in speak mode, it doesn't do that, and it should."
    //
    // It was never a missing focus gate: both positions read the same `focusOwner`. What differed
    // was `phase`. Speak's "active" intent PASSES the wake gate in `terminalRoutingArmed`, which
    // stops a terminal being a pause and makes it a DESTINATION — so dictated speech was typed into
    // the focused agent's PTY. Push to talk's resting "paused" intent fails that gate, which is the
    // only reason it behaved.
    useUiStore.setState({ conciergeSendMode: "speak" });
    setup(); // mount the hook so its reconcile effect is live
    micCalls.length = 0;

    caret("terminal");
    // The mic must be demoted. Asserting the LAST call, because the effect re-runs on the edge.
    expect(micCalls.at(-1)).toBe("paused");
    expect(micCalls).not.toContain("off"); // a demotion of phase, never of `enabled`
  });

  it("restores Speak's live intent when the caret leaves", () => {
    // The other half, and the reason this is `paused` rather than `off`: leaving a terminal must
    // cost a RESUME, not a re-arm, and must not rewrite the tray's position underneath the user.
    useUiStore.setState({ conciergeSendMode: "speak" });
    setup();
    caret("terminal");
    micCalls.length = 0;

    caret("other");
    expect(micCalls.at(-1)).toBe("active");
    expect(useUiStore.getState().conciergeSendMode).toBe("speak");
  });

  it("leaves Push to talk exactly as it already was", () => {
    // The regression guard: ptt's resting intent is ALREADY "paused", so the new term must be a
    // no-op there rather than a second, competing write.
    //
    // `every()` ALONE WAS VACUOUS (roborev 56315): it is true of an empty array, which is exactly
    // what `micCalls` holds if the effect never re-runs on the `inert` edge — the defect this
    // change fixes. So the row stayed green with the fix deleted and guarded nothing. Assert the
    // reconcile FIRED as well as what it wrote.
    useUiStore.setState({ conciergeSendMode: "ptt" });
    setup();
    caret("terminal");
    micCalls.length = 0;
    caret("other");
    expect(micCalls.length).toBeGreaterThan(0);
    expect(micCalls.every((c) => c === "paused")).toBe(true);
  });

  it("NEVER arms the mic when the tray is at Send", () => {
    // ── roborev 56315 (High) ──────────────────────────────────────────────────────────────────
    // `"paused"` is not a weaker "off" — `applyIntent("paused")` reaches `setMuted`, which is an
    // ARM (`setEnabled(true)`). Demoting unconditionally therefore turned the microphone ON when a
    // released mic met a terminal caret, and left it armed under a tray reading "Send" because the
    // stand-down guard then blocked the repair. Nothing about a caret move may arm a microphone.
    useUiStore.setState({ conciergeSendMode: "send" });
    useDictationStore.setState({ enabled: false });
    setup();
    micCalls.length = 0;

    caret("terminal");
    // An ARM is the thing that must never happen. `"off"` may legitimately appear (the reconcile
    // re-asserting the released state); `"paused"` and `"active"` both reach setters that call
    // `setEnabled(true)`, so neither may be written by a caret move.
    expect(micCalls).not.toContain("paused");
    expect(micCalls).not.toContain("active");
    caret("other");
    expect(micCalls).not.toContain("paused");
    expect(micCalls).not.toContain("active");
    // …and the mic really is still released, not merely un-narrated. This is the assertion the
    // mocked `useMicActions` could not make on its own — it reduces an arm to a pushed string.
    expect(useDictationStore.getState().enabled).toBe(false);
  });
});
