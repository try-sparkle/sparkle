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
// THIS FILE WAS REOPENED ONCE ALREADY. A build carrying the fully engine-close-based design in this
// suite's previous form — `owed`/`deferred`, hardened across three roborev passes, every row here
// green — shipped and still cut off the founder's words in his own testing (most likely against a
// stale pre-fix build that hadn't updated yet, but that could not be confirmed with certainty, and
// the point stands regardless: a green suite is not proof of correct behaviour when every row trusts
// the same signal). So `useSendMode.ts` no longer trusts `speechEndSeq` alone — a STABLE-PARTIAL
// detector (composer text + live interim going quiet for `QUIET_WINDOW_MS`) is the primary mechanism
// now, with the engine's own close kept only as a faster-settling optimization. The rows below cover
// both, and specifically the scenario named in the reopening: partials that keep growing after
// release, asserting the sent text is the LAST one's full content, not merely that a send happened.
//
// THE PIPELINE IS MODELLED FROM ITS OWN CONTRACT, not invented:
//   • `dictation://interim` — the live preview, cloud only, replaced in place (dictationStore.interim)
//   • `dictation://partial` — a COMMITTED segment. useDictation clears the interim and then inserts,
//     and ComposeBox's `append` puts dictated text at the caret, which follows the text: so a segment
//     lands AFTER whatever was already in the box, and (in production) `onComposedText` reports the
//     new value to `ConciergeHost` synchronously off the same update, re-rendering `useSendMode`.
//   • `dictation://speech-end` — the engine's endpoint decision, bumping `speechEndSeq`. Rust emits
//     it AFTER the committed transcript of the same utterance, on both capture paths.
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

// A local copy of `QUIET_WINDOW_MS`, since useSendMode.ts deliberately does not export it (it is an
// implementation detail of the drain, not a contract this suite should import and silently follow
// wherever the source changes it — a mismatch here is exactly what SHOULD fail these rows).
const QUIET_WINDOW_MS_FOR_TEST = 500;
/** Mirrors STABLE_PARTIAL_POLL_MS. The tick that OBSERVES an arrival is the one that starts the
 *  quiet clock, so a wait measured from the commit needs one extra tick of margin. */
const STABLE_PARTIAL_POLL_MS_FOR_TEST = 100;
// The stable-partial poll is a plain `setInterval`, so it notices a change on its NEXT tick, not the
// instant it happens — up to `STABLE_PARTIAL_POLL_MS` (100ms in the source) of detection lag. A row
// that asserts against the exact millisecond of the quiet window is asserting against a boundary the
// mechanism does not promise. These give every "not yet" / "now" check real margin on both sides —
// generously, per the same "bound it generously" reasoning as the production code itself.
const GROWTH_GAP_MS = 200; // comfortably under the window, even with detection lag on both ends
const SETTLE_MARGIN_MS = 800; // comfortably over the window, even with detection lag on both ends

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
  // `composedText` is a PROP, not something this hook can read off `box` directly — in production
  // it is React state in ConciergeHost, re-rendering `useSendMode` on every change. `rerender` is
  // that re-render; `sync()` is what a test calls after mutating `box.text` directly (a typed draft,
  // with no dictation event of its own) to make it happen, the same way `ConciergeHost` re-renders
  // whenever `ComposeBox`'s `onComposedText` fires.
  const view = renderHook((composedText: string) => useSendMode({ onSend, composedText }), {
    initialProps: box.text,
  });
  const sync = () => act(() => view.rerender(box.text));
  /**
   * A COMMITTED segment reaches this window: the interim is cleared and the text is appended to the
   * box — the two halves of useDictation's `dictation://partial` handler, in its order — and THEN
   * the composer's own re-render is simulated, the same order production runs in (`ComposeBox.append`
   * calls `onComposedText` synchronously off the same state update).
   */
  const commits = (text: string) =>
    act(() => {
      useDictationStore.getState().setInterim("");
      box.text = box.text ? `${box.text} ${text}` : text;
      view.rerender(box.text);
    });
  return { box, onSend, sync, commits, ...view };
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
/** The engine's endpoint decision. Always AFTER the transcript it belongs to — see the header. */
const speechEnds = () => act(() => useDictationStore.getState().noteSpeechEnd());
/**
 * The mic meter, ~25×/sec for the whole capturing window (`LEVEL_EMIT_INTERVAL` = 40ms, dictation.rs)
 * — UNRELATED to the transcript, but a store write like any other, so the watch's subscriber sees it.
 */
const levelTicks = () => act(() => useDictationStore.getState().setLevel(Math.random()));

/** Let the queued macrotask (the send) and its render run — well under QUIET_WINDOW_MS, so a row
 *  using this to check an intermediate state is checking it before the stable-partial poll could
 *  possibly have fired on its own. */
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
    // nothing was outstanding, and sent the truncated phrase. Resolved here via the engine-close
    // race — well within QUIET_WINDOW_MS, via a single `flush()` — but see the "GROWING PARTIALS"
    // row below for the case where that race is not available at all.
    const { box, commits } = setup();
    down();
    vad(true);
    interim("let's ship the");
    commits("let's ship the feature");
    // …and he says "tomorrow", which has produced nothing observable yet, and lets go.
    up();

    expect(box.sent, "nothing may go out while the utterance is still open").toEqual([]);

    // The tail commits, the VAD closes, and only then does the engine close the utterance.
    commits("tomorrow");
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
    const { box, commits } = setup();
    down();
    vad(true);
    interim("deploy the");
    commits("deploy the");
    speechEnds(); // the clause closed on a ~220ms breath — he is still talking
    up();

    expect(box.sent, "a mid-sentence clause close must not release the send").toEqual([]);

    commits("staging branch");
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
    const { box, commits } = setup();
    down();
    vad(true);
    interim("let's ship the");
    up();

    commits("let's ship the feature");
    speechEnds();
    await flush();
    expect(box.sent, "a commit-and-close with no quiet after it must not release the send").toEqual(
      [],
    );

    commits("tomorrow");
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
    const { box, sync, commits } = setup();
    box.text = "ship it";
    sync();
    vad(true);
    down();
    up();

    expect(
      box.sent,
      "speech already in progress at keydown is still speech that owes us a transcript",
    ).toEqual([]);

    commits("by friday");
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
    const { box, commits } = setup();
    down();
    vad(true);
    interim("ship it");
    commits("ship it");
    speechEnds();
    vad(false);
    up();

    expect(box.sent, "the send must not wait for a close that has already happened").toEqual([
      "ship it",
    ]);
  });

  it("ON-DEVICE: the VAD dropping is not the same as the transcript arriving", async () => {
    // The on-device path has NO `interim` at all (only cloud.rs emits it) and Silero's VAD drops
    // `speaking` at 250ms of silence, while the Whisper decode that actually produces the segment's
    // `dictation://partial` can lag hundreds of ms to seconds behind that drop. A release read at
    // "the room is quiet right now" lands in exactly that gap: the VAD has dropped, there is nothing
    // to preview (there never was, on this path), and the transcript has not arrived yet. That is
    // the case a bare `quiet` fast-path check gets wrong — it has nothing left to distinguish "never
    // spoke" from "spoke, decode still pending" once the VAD has dropped, which is why the debt has
    // to be a watch, not a keyup-time read.
    const { box, commits } = setup();
    down();
    vad(true); // he starts talking, mic captures audio
    vad(false); // 250ms of silence — Silero closes, decode is still running
    up(); // released right after — nothing has been transcribed yet

    expect(box.sent, "the VAD dropping must not be read as the transcript having landed").toEqual(
      [],
    );

    // The decode finally finishes: the segment's own partial-then-speech-end pair.
    commits("restart the server");
    speechEnds();
    await flush();

    expect(box.sent).toEqual(["restart the server"]);
  });

  it("ON-DEVICE: a SECOND queued segment is not discarded by the FIRST one's close", async () => {
    // Two closed-but-undecoded segments can coexist when Whisper's decode lags the audio: "restart
    // the server" <VAD closes, quiet> "now" <VAD closes again, quiet> — both fully captured before
    // the key ever comes up. A debt that only remembers ONE outstanding run confirms itself the
    // instant the FIRST segment's close lands in a now-quiet room, and the second segment — "now" —
    // is discarded outright. Both must land.
    const { box, commits } = setup();
    down();
    vad(true); // segment 1 starts
    vad(false); // segment 1's VAD closes
    vad(true); // segment 2 starts
    vad(false); // segment 2's VAD closes
    up(); // both captured, neither decoded yet

    expect(box.sent, "nothing to send until at least the first decode lands").toEqual([]);

    // Segment 1 finishes decoding first — the room is quiet, so this confirms IMMEDIATELY, but only
    // for the one run it belongs to.
    commits("restart the server");
    speechEnds();
    await flush();
    expect(box.sent, "segment 2 is still owed — its own close hasn't landed").toEqual([]);

    // Segment 2 finishes.
    commits("now");
    speechEnds();
    await flush();

    expect(box.sent).toEqual(["restart the server now"]);
  });

  it("CLOUD RACE: the final clause's own speech-end can land before the VAD confirms — it still resolves, not stalls", async () => {
    // Deepgram's `speech_final` rides a Results frame ~200ms after the last word (plus network RTT);
    // Silero drops `speaking` at 250ms. On a fast connection the bump for the FINAL clause can land
    // while the local VAD still reads speech — and `speech_end_action` dedupes to one speech-end per
    // utterance, re-arming only on a fresh interim/non-final partial, so if settling required the
    // bump and quiet to coincide in the very same event, no SECOND bump would ever arrive. It must
    // resolve the moment the VAD catches up instead — well inside the cap, with no interim and no
    // second bump — via the engine-close race, not the stable-partial one (nothing here changes
    // `composedText` after the commit, so this row also proves the close race alone is still enough
    // when it works correctly).
    const { box, commits } = setup();
    down();
    vad(true);
    up();

    commits("ship it");
    speechEnds(); // the bump for the only clause — but the VAD hasn't caught up yet
    await flush();
    expect(box.sent, "a bump while still noisy must not settle on its own").toEqual([]);

    // THE METER KEEPS TICKING while he's still (apparently) speaking — ~25×/sec in production, and
    // each one is a store write the watch's subscriber sees, same as any other. An earlier version
    // treated any tick where `speaking` READ true as fresh evidence and cleared the deferred close —
    // which every one of these ticks would do, since `speaking` hasn't dropped yet — destroying the
    // confirmation within 40ms of it being armed and stranding this release on the cap.
    levelTicks();
    levelTicks();
    levelTicks();
    await flush();
    expect(box.sent, "unrelated meter ticks must not disturb the deferred close").toEqual([]);

    vad(false); // no second bump is coming — the VAD confirming quiet is what resolves this
    await flush();

    expect(box.sent, "confirmed by the VAD catching up, not by the cap").toEqual(["ship it"]);
    // Prove it wasn't the cap: nothing left to advance into.
    await advance(PARTIAL_SETTLE_CAP_MS);
    expect(box.sent).toEqual(["ship it"]);
  });
});

describe("a release is a SEND, not a send-if-there-was-speech", () => {
  it("a SILENT hold sends the typed draft, and does not sit out the cap first", async () => {
    // In this mode the release is the ONLY send path a typed draft has — `chordSends` makes ⌘↩ inert
    // in Push to talk on purpose. So a silent hold is not a no-op, and it must not feel like one:
    // the assertion is made BEFORE any timer is advanced, so a drain that ran unconditionally fails
    // this row even though it would eventually send.
    const { box, sync } = setup();
    box.text = "ship it";
    sync();
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
    const { box, sync, commits } = setup();
    box.text = "ship it";
    sync();
    down();
    vad(true);
    up();

    expect(box.sent, "the typed half must not go out on its own").toEqual([]);

    commits("by friday");
    vad(false);
    speechEnds();
    await flush();

    expect(box.sent).toEqual(["ship it by friday"]);
  });
});

// ══ THE STABLE-PARTIAL DETECTOR — the drain's PRIMARY mechanism, not a fallback bolted onto the
// engine-close race. See useSendMode.ts's QUIET_WINDOW_MS doc for why: a build trusting the
// engine-close race alone shipped and still cut off the founder's words in his own testing. These
// rows exist so that claim cannot regress silently — they never call `speechEnds()` at all, so
// `utterance.owed` never reaches zero on its own; the ONLY thing that can send here is the box
// going quiet, or the absolute cap. ═══════════════════════════════════════════════════════════════
describe("the stable-partial detector — sends once nothing is CHANGING, with no help from speechEnds", () => {
  it("GROWING PARTIALS: keeps waiting while the box keeps growing, then sends the LAST one — not merely that a send happened", async () => {
    // THE EXACT SCENARIO THE REOPENING NAMED: Deepgram (or a slow on-device decode) keeps delivering
    // partials after release, and NO speech-end ever arrives to confirm anything via the engine-close
    // race. Each new partial must reset the quiet clock, and the sent text must be the FULL, LATEST
    // content — not an earlier partial, and not merely "a send occurred", which is the assertion
    // AGENTS.md calls out as the one that let a truncating build ship green.
    //
    // Each `commits()` call is a genuinely NEW chunk (matching production: a committed segment lands
    // AFTER whatever was already in the box, never revising it), so the box accumulates exactly the
    // way ComposeBox's `append` does. The gaps between them are comfortably under the quiet window —
    // and the final wait comfortably over it, with margin either side for the poll's own granularity
    // (`STABLE_PARTIAL_POLL_MS` — the poll notices a change on its NEXT tick, not the instant it
    // happens, so a check timed to the exact millisecond of the window is not safe to assert on).
    const { box, commits } = setup();
    down();
    vad(true);
    up(); // released — nothing has committed yet, `owed` is 1 and staying that way: no speechEnds()
    // anywhere in this row.

    // Partials keep landing, each one well before the previous one's quiet window would have expired.
    commits("we");
    await advance(GROWTH_GAP_MS);
    expect(box.sent, "must not settle mid-growth").toEqual([]);

    commits("should");
    await advance(GROWTH_GAP_MS);
    expect(box.sent, "a fresh partial resets the quiet clock").toEqual([]);

    commits("deploy the staging environment");
    await advance(GROWTH_GAP_MS);
    expect(box.sent, "still growing — still must not settle").toEqual([]);

    // …and now he is actually done. Nothing else lands.
    await advance(SETTLE_MARGIN_MS);

    expect(box.sent, "the sent text is the LAST partial's full content").toEqual([
      "we should deploy the staging environment",
    ]);
  });

  it("a live INTERIM still updating (nothing committed yet) also resets the quiet clock", async () => {
    // Deepgram can preview words for a while before committing them. If only `composedText` were
    // watched, an actively-updating interim with no commits yet would look "quiet" and send an
    // incomplete phrase — this proves the interim itself is watched too.
    const { box, commits } = setup();
    down();
    vad(true);
    up();

    interim("we should");
    await advance(GROWTH_GAP_MS);
    expect(box.sent, "an updating interim is not quiet").toEqual([]);

    interim("we should deploy the");
    await advance(GROWTH_GAP_MS);
    expect(box.sent, "still previewing — still not quiet").toEqual([]);

    // It commits, and THEN goes quiet for real.
    commits("we should deploy the staging environment");
    await advance(SETTLE_MARGIN_MS);

    expect(box.sent).toEqual(["we should deploy the staging environment"]);
  });

  it("falls to the CAP when a run was captured and NOTHING ever arrives", async () => {
    // ── THIS ROW'S EXPECTATION CHANGED, DELIBERATELY (roborev 57281) ─────────────────────────────
    // It used to assert a quiet settle at 500ms. That was only reachable because the quiet clock was
    // seeded from "the box is non-empty" — and here the box is non-empty only because of a TYPED
    // draft. Nothing is ever transcribed in this scenario: a run opens (`vad(true)`), never closes,
    // and no partial lands. Settling on quiet there is precisely the truncation the founder
    // reported, since a decode arriving later has nowhere to go.
    //
    // So this is now the CAP's case — "the engine never closes and nothing ever arrives" — which is
    // what the cap exists for. Slower, and correct: losing his words is the failure being fixed, and
    // a slower send is strictly better than a truncated one. The fast quiet path is still pinned, by
    // the row below where a segment actually COMMITS during the hold.
    const { box, sync } = setup();
    box.text = "ship it";
    sync();
    down();
    vad(true);
    up();

    await advance(QUIET_WINDOW_MS_FOR_TEST + 50);
    expect(box.sent, "a typed draft is not an arrival — quiet must not settle it").toEqual([]);

    await advance(PARTIAL_SETTLE_CAP_MS);
    expect(box.sent, "the cap is the backstop, and it still sends rather than dropping").toEqual([
      "ship it",
    ]);
  });

  it("THE ABSOLUTE CAP: content that never once goes quiet still sends everything received, never a prefix", async () => {
    // The backstop beneath the backstop. If partials keep landing faster than the quiet window can
    // ever close — a runaway stream, a decode that never stops producing fragments — the release
    // must not hang forever, and when the cap fires it must send the FULL accumulated text, not
    // whatever an earlier, smaller send would have contained.
    const { box, commits } = setup();
    down();
    vad(true);
    up();

    // Keep the box growing at a steady drumbeat SHORTER than the quiet window, so it can never once
    // close, and track exactly what was committed — the loop stops the instant a send is observed,
    // so `words` always matches what was actually in the box at that moment, whatever iteration it
    // happened to be. A loop that kept running past the send (tracking its OWN counter instead) would
    // let a truncated send masquerade as complete, by comparing against the wrong, later value.
    const STEP_MS = QUIET_WINDOW_MS_FOR_TEST - 150;
    const words: string[] = [];
    // Bounded generously above what the cap could possibly need (cap / step, plus slack) so a bug
    // that never sends fails with a clear assertion instead of an opaque test-runner timeout.
    const MAX_ITERATIONS = Math.ceil(PARTIAL_SETTLE_CAP_MS / STEP_MS) + 5;
    for (let i = 0; i < MAX_ITERATIONS && box.sent.length === 0; i++) {
      const word = `word${i + 1}`;
      words.push(word);
      commits(word);
      await advance(STEP_MS);
    }

    expect(box.sent, "the cap must have fired by now — never once went quiet").toHaveLength(1);
    expect(box.sent[0], "everything committed before the cap fired, never a prefix of it").toBe(
      words.join(" "),
    );
  });
});

describe("the cap is a backstop, and it SENDS", () => {
  it("sends only once when the utterance closes and the cap expires", async () => {
    // Proves the engine-close race and the cap timer are torn down together, so a close that lands
    // just before the (now much longer) cap does not ALSO fire the cap and send twice.
    const { box, sync } = setup();
    box.text = "ship it";
    sync();
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
    const { box, sync, commits } = setup();
    box.text = "ship it";
    sync();
    down();
    vad(true);
    act(() => void fireEvent.blur(window));

    commits("by friday");
    speechEnds();
    await advance(PARTIAL_SETTLE_CAP_MS * 2);

    expect(box.sent).toEqual([]);
  });

  it("a second hold calls off a release that is still draining", async () => {
    // He carried on talking, so the phrase he was about to send is no longer the whole of what he
    // means to say. The pending send is cancelled, not merely postponed — and that includes the
    // stable-partial poll, not only the engine-close subscription and the cap timer.
    const { box, commits } = setup();
    down();
    vad(true);
    up();
    down();

    commits("and one more thing");
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

describe("a decode that lags LONGER than the quiet window", () => {
  // ── roborev 57274 (High) ──────────────────────────────────────────────────────────────────────
  // THE GAP EVERY OTHER ON-DEVICE ROW LEFT OPEN. They all advance only `flush()` (1ms) between the
  // release and the commit, so the stable-partial poll can never TICK before the transcript lands —
  // which is exactly why a drain that settled after 500ms of NO ARRIVAL stayed green.
  //
  // On the on-device path there is no `interim` at all and `composedText` does not move until the
  // decode lands, so "nothing has changed since the release" is what a PENDING DECODE looks like.
  // Treating that as quiet sent the short box and stranded the segment arriving afterwards —
  // reintroducing the very truncation the founder reported. The cap could not save it, because the
  // poll won the race first.
  //
  // This asserts the guard itself. That the full phrase then goes out is already pinned by the
  // "ON-DEVICE: the VAD dropping is not the same as the transcript arriving" row above.
  it("does NOT send while nothing has arrived, however long the silence runs", async () => {
    const { onSend } = setup();
    down();
    vad(true);
    vad(false); // Silero closes the segment; the decode is still running
    up(); // released into the gap — empty box, no interim, nothing arrived yet

    // Well past the quiet window and many poll ticks. A decode running "hundreds of ms to seconds"
    // behind the audio is the DOCUMENTED case, not an adversarial one.
    await advance(QUIET_WINDOW_MS_FOR_TEST * 3);

    // ASSERTED ON `onSend`, NOT ON `box.sent` — and that distinction is the whole row. A premature
    // settle here calls `onSend` against an EMPTY box, which pushes nothing, so `box.sent` reads []
    // whether the drain behaved or not. The first draft of this row asserted exactly that and was
    // VACUOUS: restoring the bug left it green. What separates the two states is whether the send
    // was ATTEMPTED at all — and an attempt here also drops the mic, stranding the segment that
    // arrives moments later.
    expect(onSend, "silence during a pending decode is not the utterance being finished")
      .not.toHaveBeenCalled();
  });

  it("a TYPED draft is not an arrival — a pending decode still holds the send", async () => {
    // ── roborev 57281 (High) ──────────────────────────────────────────────────────────────────────
    // The first version of the seed treated ANY non-empty box as "something already arrived", which
    // is false for text the user typed. This file calls typed-text-plus-speech a first-class case,
    // and it is where the truncation survived: type "ship it", hold, say "by friday", release into
    // the on-device gap (no interim on that path, `composedText` frozen at the draft) — the clock was
    // seeded at the release, settled ~500ms later, dispatched "ship it" alone, and stranded
    // "by friday" arriving at ~800ms in a composer whose message had already gone out.
    const { box, onSend, sync } = setup();
    box.text = "ship it"; // TYPED, before the key is ever pressed
    sync();

    down();
    vad(true);
    vad(false); // segment closed, decode still running
    up();

    await advance(QUIET_WINDOW_MS_FOR_TEST * 3);
    expect(onSend, "a typed draft must not be mistaken for the transcript having landed")
      .not.toHaveBeenCalled();
  });

  it("MULTI-CLAUSE: a clause committed during the hold does not license a quiet settle", async () => {
    // ── roborev 57287 (High) — THE EXPECTATION THAT MOVED ────────────────────────────────────────
    // This row used to assert the opposite: that a clause landing during the hold let the quiet
    // clock start at the release. That is the ordinary multi-clause case — `endpointing=200` closes
    // a clause on a mid-sentence breath — and it is the same truncation one segment later. Say
    // "let's ship the feature by friday": clause 1 commits during the hold, clause 2 is still
    // decoding at the keyup, and starting the clock at the release ships "let's ship the feature"
    // while "by friday" is stranded in a composer whose message has already gone out.
    //
    // The poll is reachable ONLY with a run still outstanding (the fast path returns early on
    // `owed <= 0`), so "already waiting on something" is the premise here. Quiet may only start on a
    // POST-RELEASE arrival; a transcript that never lands falls to the cap.
    const { box, onSend, commits } = setup();
    down();
    vad(true);
    commits("let's ship the feature"); // clause 1 lands DURING the hold
    vad(false);
    up(); // clause 2 still decoding

    await advance(QUIET_WINDOW_MS_FOR_TEST * 3);
    expect(onSend, "a clause from during the hold is not the utterance being finished")
      .not.toHaveBeenCalled();

    // Clause 2 finally lands, and THEN the quiet window runs — the whole phrase goes out. The extra
    // margin covers the poll tick that OBSERVES the arrival: that tick starts the quiet clock, so
    // the window is measured from it rather than from the commit itself.
    commits("by friday");
    await advance(QUIET_WINDOW_MS_FOR_TEST + STABLE_PARTIAL_POLL_MS_FOR_TEST + 50);
    expect(box.sent).toEqual(["let's ship the feature by friday"]);
  });
});
