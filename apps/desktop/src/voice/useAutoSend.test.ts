// @vitest-environment jsdom
//
// The wiring that makes the rail fire (PRD 1 §4).
//
// `autoSendTimer` already proves the reducer in isolation. What can only be proven HERE is that the
// three inputs are plumbed to the right reducer calls — which is exactly what was missing when this
// hook did not exist: every piece of §4 was built and unit-tested, and the feature was still inert
// because nothing connected them.
//
// So these tests are about the SEAMS: does a speech-end start the clock, does interim stop it, does
// a manual press cancel it, and does an expired countdown fire the composer's own submit.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("../analytics", () => ({ capture: vi.fn() }));

import { useDictationStore } from "../stores/dictationStore";
import { useAutoSend, notifyManualSend, AUTO_SEND_TICK_MS } from "./useAutoSend";
import { resetAutoSendTelemetry } from "./autoSendTelemetry";

/** A clean sentence — `high`, so the threshold is 1s and tests stay short. */
const DONE = "Deploy the staging branch.";
/** A trailing conjunction — `verylow`, so the threshold is 10s. */
const MID_CLAUSE = "deploy the staging branch and";

type Props = Parameters<typeof useAutoSend>[0];

function setup(overrides: Partial<Props> = {}) {
  const onFire = vi.fn(() => true);
  const onAnnounce = vi.fn();
  const base: Props = {
    armed: true,
    micLive: true,
    composedText: DONE,
    interim: "",
    targetName: "Concierge",
    onFire,
    onAnnounce,
  };
  const props = { ...base, ...overrides };
  const view = renderHook((p: Props) => useAutoSend(p), { initialProps: props });
  /** Re-render with the same props except the named overrides. */
  const update = (next: Partial<Props>) =>
    act(() => {
      Object.assign(props, next);
      view.rerender({ ...props });
    });
  return { onFire, onAnnounce, update, ...view };
}

/** The engine reports the speaker stopped. This is the ONLY thing that starts the clock. */
function speechEnds() {
  act(() => {
    useDictationStore.getState().noteSpeechEnd();
  });
}

/** Advance past a tick boundary and let the queued microtask (the actual send) run. */
async function tick(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  useDictationStore.setState({ speechEndSeq: 0, onDeviceSpeech: false });
  resetAutoSendTelemetry();
});

afterEach(() => {
  resetAutoSendTelemetry();
  vi.useRealTimers();
});

describe("the clock starts on SPEECH END, not on the transcript settling", () => {
  it("does not count until the engine says the speaker stopped", async () => {
    const { onFire, result } = setup();
    // Transcript is present and complete, but nobody has said speech ended.
    expect(result.current.phase).toBe("listening");
    await tick(5_000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("fires once the tier's threshold of silence has passed", async () => {
    const { onFire, result } = setup();
    speechEnds();
    expect(result.current.phase).toBe("counting");

    await tick(1_000 + AUTO_SEND_TICK_MS);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("waits far longer on a mid-clause utterance than a finished one", async () => {
    const { onFire } = setup({ composedText: MID_CLAUSE });
    speechEnds();

    // Well past `high`'s 1s, nowhere near `verylow`'s 10s.
    await tick(3_000);
    expect(onFire).not.toHaveBeenCalled();

    await tick(7_500);
    expect(onFire).toHaveBeenCalledTimes(1);
  });
});

describe("keep talking and it waits", () => {
  it("stops counting when interim arrives, and does not send", async () => {
    const { onFire, update, result } = setup();
    speechEnds();
    await tick(500);

    // The user started speaking again.
    update({ interim: "and also" });
    expect(result.current.phase).toBe("listening");

    await tick(5_000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("counts again from the NEXT speech-end, rather than staying stuck", async () => {
    const { onFire, update } = setup();
    speechEnds();
    await tick(500);
    update({ interim: "more" });
    update({ interim: "" });

    speechEnds();
    await tick(1_000 + AUTO_SEND_TICK_MS);
    expect(onFire).toHaveBeenCalledTimes(1);
  });
});

describe("elapsed silence ACCUMULATES across re-evaluations", () => {
  it("does not restart the clock when a late transcript chunk lands", async () => {
    // THE bug this design exists to avoid: re-evaluating on every chunk while resetting the clock
    // means the countdown never completes as long as transcription keeps trickling in.
    const { onFire, update } = setup({ composedText: MID_CLAUSE });
    speechEnds();
    await tick(600);

    // A committed chunk lands mid-countdown and completes the sentence. That moves the THRESHOLD
    // (verylow → high) but must not touch the 600ms already elapsed — so 600ms is now past the new
    // 1s... not quite. Advance a little and it must fire, rather than starting 1s over.
    update({ composedText: DONE });
    await tick(500 + AUTO_SEND_TICK_MS);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("honours the grace window when a re-evaluation drops the threshold below the elapsed time", async () => {
    const { onFire, update } = setup({ composedText: MID_CLAUSE });
    speechEnds();
    // 4s of silence under verylow (10s) — nowhere near firing.
    await tick(4_000);
    expect(onFire).not.toHaveBeenCalled();

    // The sentence now reads clean: high (1s), which 4s has already blown past. It must NOT fire on
    // that instant — the user is owed one visible moment (THRESHOLD_DROP_GRACE_MS).
    update({ composedText: DONE });
    await tick(AUTO_SEND_TICK_MS);
    expect(onFire).not.toHaveBeenCalled();

    await tick(600 + AUTO_SEND_TICK_MS);
    expect(onFire).toHaveBeenCalledTimes(1);
  });
});

describe("manual send always overrides", () => {
  it("cancels a running countdown so the rail cannot fire a second copy", async () => {
    const { onFire, result } = setup();
    speechEnds();
    await tick(500);
    expect(result.current.phase).toBe("counting");

    act(() => notifyManualSend());
    expect(result.current.phase).toBe("listening");

    await tick(5_000);
    expect(onFire).not.toHaveBeenCalled();
  });
});

describe("disarmed is genuinely inert", () => {
  it("never fires, whatever the transcript or the engine says", async () => {
    const { onFire, result } = setup({ armed: false });
    speechEnds();
    expect(result.current.phase).toBe("disarmed");

    await tick(30_000);
    expect(onFire).not.toHaveBeenCalled();
  });
});

describe("the rail's label is the routing target", () => {
  it("reports the target it was given — the mis-route safety net", () => {
    const { result } = setup({ targetName: "Build 4" });
    expect(result.current.targetName).toBe("Build 4");
  });
});

// The dangerous one. `speechEndSeq` is GLOBAL — bumped for every utterance in the focused window,
// whichever surface owns the mic — while the cancel signal is not: useConciergeDictation returns
// interim "" unless the concierge owns dictation. Ungated, the rail counts down on somebody else's
// speech with a cancel that can never arrive, and dispatches whatever draft is sitting in this box.
describe("only OUR speech starts the clock", () => {
  it("ignores a speech-end while an agent composer owns the mic", async () => {
    const { onFire, result } = setup({ micLive: false, composedText: "let me think about the schema" });
    // The user is dictating into an agent composer; Deepgram still emits speech-end for it.
    speechEnds();
    expect(result.current.phase).not.toBe("counting");

    await tick(30_000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("stops a live countdown when the mic moves to another surface", async () => {
    const { onFire, update, result } = setup();
    speechEnds();
    await tick(300);
    expect(result.current.phase).toBe("counting");

    // The user clicked an agent composer's mic mid-countdown.
    update({ micLive: false });
    expect(result.current.phase).toBe("listening");

    await tick(10_000);
    expect(onFire).not.toHaveBeenCalled();
  });
});

describe("the countdown is audible, not just visible", () => {
  it("announces the arm, the countdown and the send — each naming the target", async () => {
    const { onAnnounce, update } = setup({ armed: false, targetName: "Build 4" });
    onAnnounce.mockClear();

    update({ armed: true });
    expect(onAnnounce.mock.calls.at(-1)?.[0]).toContain("Build 4");

    speechEnds();
    // The countdown line has to name the destination — that IS the mis-route safety net, and the
    // draining fill is aria-hidden, so this is a screen reader's only notice.
    expect(onAnnounce.mock.calls.at(-1)?.[0]).toContain("Build 4");

    await tick(1_000 + AUTO_SEND_TICK_MS);
    expect(onAnnounce.mock.calls.at(-1)?.[0]).toBe("Sent to Build 4.");
  });

  it("does not announce anything merely for mounting disarmed", () => {
    const { onAnnounce } = setup({ armed: false });
    expect(onAnnounce).not.toHaveBeenCalled();
  });
});

describe("a send that did not happen is not announced or recorded", () => {
  it("stays silent when onFire reports no dispatch", async () => {
    // onFire returns false whenever nothing was actually sent — the compose box unmounted behind an
    // AI lock so no submit is registered, or submit early-returned on an empty box. Announcing
    // "Sent to …" there tells a screen-reader user a message went out when none did, which is worse
    // than the silent no-op it replaced; recording a sample is worse still, because that corpus is
    // the entire input to the §4f tuner and a phantom sample TRAINS the thresholds.
    const onFire = vi.fn(() => false);
    const { onAnnounce } = setup({ onFire });
    onAnnounce.mockClear();
    speechEnds();
    await tick(1_000 + AUTO_SEND_TICK_MS);

    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onAnnounce.mock.calls.map((c) => c[0]).join(" ")).not.toContain("Sent to");
  });
});

describe("a speech-end that beats the mic claim is not lost", () => {
  it("replays it once ownership arrives", async () => {
    // micLive = owning && routing, and `owning` is React state written by a claim effect — so it
    // lags by a commit. On the hands-free path the wake word and the speech-end for the SAME
    // utterance come from one Deepgram frame pair, so the speech-end can land while micLive is
    // still false. DROPPING it there is unrecoverable: only a new speechEndSeq can start a clock,
    // so the user's first sentence would sit in the box and never send.
    const { onFire, update, result } = setup({ micLive: false });
    speechEnds();
    expect(result.current.phase).not.toBe("counting");

    update({ micLive: true }); // the claim lands a beat later
    expect(result.current.phase).toBe("counting");

    await tick(1_000 + AUTO_SEND_TICK_MS);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("keeps holding while ownership never arrives", async () => {
    const { onFire, result } = setup({ micLive: false });
    speechEnds();
    speechEnds(); // a second utterance, also held

    await tick(30_000);
    expect(result.current.phase).not.toBe("counting");
    expect(onFire).not.toHaveBeenCalled();
  });

  it("does NOT replay a hold that is older than the claim lag it exists for", async () => {
    // The hazard the ownership gate exists to close, reopened from the other side. `speechEndSeq` is
    // GLOBAL, so an utterance dictated into an AGENT composer records a hold in this hook too. On
    // sequence alone that hold stays valid for as long as nobody speaks again — so the next time the
    // concierge becomes micLive (the user re-targets the column minutes later) it would replay,
    // start a countdown against whatever draft is sitting in the box, and dispatch it to an agent on
    // speech this column never received. Only the AGE bound can tell the two apart: a claim that
    // arrives a commit later is the lag, one that arrives a minute later is a different user action.
    const { onFire, update, result } = setup({ micLive: false });
    speechEnds(); // somebody else's utterance
    await tick(60_000); // …and the user does something else entirely for a minute

    update({ micLive: true }); // now they re-target the concierge column
    expect(result.current.phase).not.toBe("counting");

    await tick(30_000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("anchors the replayed clock at the SPEECH END, not at the moment ownership landed", async () => {
    // Re-anchoring at the claim silently hands back the time the claim itself took, so the user
    // waits out a longer silence than their tier promises. DONE is `high` → a 1s threshold; 300ms of
    // that is already spent by the time the claim lands.
    const { onFire, update } = setup({ micLive: false });
    speechEnds();
    await tick(300);

    update({ micLive: true });
    // 300ms already elapsed + 600ms more = 900ms of silence. Still short of the threshold.
    await tick(600);
    expect(onFire).not.toHaveBeenCalled();

    // Past 1s measured from the real speech end.
    await tick(100 + AUTO_SEND_TICK_MS);
    expect(onFire).toHaveBeenCalledTimes(1);
  });
});

describe("keep talking and it waits — ON THE ON-DEVICE PATH TOO", () => {
  // THE HAZARD THIS CLOSES. `dictation://speech-end` arms the clock on BOTH capture paths. The
  // CANCEL used to exist on only one: it was derived purely from `interim`, and interim results are
  // cloud-only — the on-device engine decodes whole closed VAD segments and streams nothing. So
  // on-device, once a mid-thought pause closed a segment on a sentence that merely SOUNDED
  // finished, the clock could not be stopped by talking: the next VAD segment does not close until
  // the user pauses AGAIN, and a committed segment landing mid-countdown is specified NOT to touch
  // the clock. At the `high` tier that is a 1s fuse on a sentence the user has not finished.
  //
  // Rust now reports the on-device VAD level on its own channel, false whenever the cloud owns the
  // audio (`frame_on_device_speech`), and these pin both directions of it.
  const resumeSpeaking = (v: boolean) =>
    act(() => {
      useDictationStore.getState().setOnDeviceSpeech(v);
    });

  it("resumed on-device speech CANCELS a running countdown instead of sending", async () => {
    const { onFire, result } = setup();
    speechEnds();
    expect(result.current.phase).toBe("counting");
    resumeSpeaking(true);
    expect(result.current.phase).not.toBe("counting");
    // …and it stays uncounted right through the threshold it would otherwise have fired at.
    await tick(2000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("a speech-end that lands while the user is ALREADY talking does not arm at all", async () => {
    // The decode runs hundreds of ms behind the audio, so a user who resumes inside that gap
    // produces resume-then-arm IN THAT ORDER. A pulse-shaped cancel would have been consumed before
    // the arm it needed to prevent; the level is still true when the arm lands, so nothing starts.
    const { onFire, result } = setup();
    resumeSpeaking(true);
    speechEnds();
    expect(result.current.phase).not.toBe("counting");
    await tick(2000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("and once they genuinely stop, the very next speech-end arms and fires as normal", async () => {
    const { onFire } = setup();
    resumeSpeaking(true);
    speechEnds(); // suppressed — still talking
    resumeSpeaking(false); // the VAD falls: they really did stop
    speechEnds(); // the next closed segment arms
    await tick(1200);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  // ── THE GUARD MEETS THE CLAIM-LAG REPLAY (roborev 55498) ──────────────────────────────────────
  // Effect (3b) consumes the hold (`deferredSpeechEnd.current = null`) BEFORE calling startClock, so
  // when the guard refuses, that held boundary is gone. The reviewer read that as unrecoverable, by
  // analogy to the Rust-side suppression this branch reverted for exactly that reason.
  //
  // For REAL SPEECH it is recoverable, and that is what these two tests pin. `onDeviceSpeech` is
  // driven by the same VAD flag whose FALL closes a segment (dictation.rs `frame_on_device_speech`),
  // and the speech-end is emitted hundreds of ms later, after the decode. So a true level at replay
  // time means the user RESUMED after that segment closed, and speech that carries words closes a
  // segment which emits its own boundary. The Rust case had no successor at all: there the audio had
  // moved to the relay, so the on-device engine was no longer fed and nothing could ever supply one.
  //
  // ── BUT THE SUCCESSOR IS NOT UNCONDITIONAL, AND AN EARLIER VERSION OF THIS NOTE SAID IT WAS ──────
  // Corrected per roborev 55561, which is right and defeats the word "structural" I used here.
  // `plan_decode_emit` emits NO boundary for two closed segments: an EMPTY decode (the VAD closed on
  // a cough, a door, a keyboard, clipped breath) and a PANICKED one. `onDeviceSpeech` is the RAW VAD
  // level, so it goes true on exactly that non-speech noise. Hence the hole:
  //
  //   hold deferred → a cough raises the VAD → the claim lands, so (3b) nulls the hold and the guard
  //   refuses → the cough's segment closes and decodes to nothing → no successor boundary, ever.
  //
  // The dictated command then sits in the composer with no countdown — the silent, unrecoverable side
  // of the very asymmetry this branch invoked twice (and the reason the Rust-side suppression was
  // withdrawn). It is narrow: it needs a non-speech VAD edge inside the ≤500ms
  // DEFERRED_SPEECH_END_MAX_LAG_MS claim window AND that segment decoding empty. Narrow is not zero.
  //
  // ACCEPTED, NOT FIXED, and deliberately so. The remedy is to keep the hold when the guard refuses
  // and re-attempt it on the guard's falling edge — which means a new trigger in the auto-send state
  // machine, and this branch's brief explicitly excludes redesigning the countdown mechanism. Filed
  // rather than smuggled in (bead sparkle-24pt). Recorded at its true size here in the style of `plan_decode_emit`'s own
  // accepted-risk note, because an unstated hole is the thing that actually costs the next reader.
  //
  // So: do NOT read the first test as licence to add a pending-arm latch without also pinning the
  // double-arm race against the successor — that race is why the remedy is a mechanism change and not
  // a one-liner.

  it("a held speech-end replayed while the user is still talking does NOT arm", async () => {
    const { onFire, update, result } = setup({ micLive: false });
    speechEnds(); // the wake segment's boundary, deferred: the claim has not landed yet
    resumeSpeaking(true); // they carry straight on into the command
    update({ micLive: true }); // the claim lands mid-sentence → (3b) replays into the guard
    expect(result.current.phase).not.toBe("counting");
    await tick(2000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("…and the NEXT closed segment still arms, when that segment carries words", async () => {
    // THE ASSERTION THAT MAKES THE DROP SAFE FOR REAL SPEECH — which is the common case but, per the
    // note above, not every case: a segment that decodes empty emits no boundary and is the
    // accepted-risk hole. If even THIS failed, the guard would strand the hands-free path outright.
    const { onFire, update } = setup({ micLive: false });
    speechEnds();
    resumeSpeaking(true);
    update({ micLive: true }); // hold consumed and refused
    resumeSpeaking(false); // they finish the command; the VAD falls
    speechEnds(); // that segment closes and emits its own boundary
    await tick(1200);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("the CLOUD path is unaffected — its own countdowns still fire", async () => {
    // WHAT THIS PINS: that the on-device latch is INERT during a cloud session, so cloud countdowns
    // still fire. Rust keeps `onDeviceSpeech` false while the relay owns the audio
    // (`frame_on_device_speech`) because the cloud cancel belongs to `interim`, which tracks
    // Deepgram's view of the utterance rather than a local VAD the relay has taken the audio from.
    // If this channel ever went true on the cloud path, it would suspend every cloud countdown and
    // auto-send would never fire there at all — so this asserts the frontend consequence.
    //
    // (An earlier version of this note justified the split by claiming the waveform's `speaking` flag
    // is pinned TRUE for the whole cloud stream. That stopped being true in the 2026-07-29 dead-mic
    // fix — `speaking` is now the raw VAD on both paths — so the note was arguing from a property
    // that no longer exists, which invites collapsing the two signals. See roborev 55503.)
    const { onFire } = setup();
    expect(useDictationStore.getState().onDeviceSpeech).toBe(false);
    speechEnds();
    await tick(1200);
    expect(onFire).toHaveBeenCalledTimes(1);
  });
});
