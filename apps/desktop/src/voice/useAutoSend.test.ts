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
import { thresholdMs } from "./confidence";

// Threshold-crossing waits are DERIVED from the ladder, never written as literals. The founder
// retuned the pace (x1.2) and every hard-coded 1_000/10_000 here silently stopped crossing its
// threshold — the tests went red without a single behaviour changing. What these rows assert is
// "advance past THIS tier's threshold and the send fires", which is independent of the tuning.
const HIGH = thresholdMs("high");
const NORMAL = thresholdMs("normal");
const VERYLOW = thresholdMs("verylow");

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("../analytics", () => ({ capture: vi.fn() }));

import { useDictationStore } from "../stores/dictationStore";
import { useAutoSend, notifyManualSend, AUTO_SEND_TICK_MS } from "./useAutoSend";
import { resetAutoSendTelemetry } from "./autoSendTelemetry";

/** A clean sentence — `high`, so the threshold is 1s and tests stay short. */
const DONE = "Deploy the staging branch.";
/** A trailing conjunction — `verylow`, so the threshold is 10s. */
const MID_CLAUSE = "deploy the staging branch and";
/** Short, unpunctuated, no bad tail — `normal`, so the threshold is 3s. The founder's shape. */
const PLAIN = "ship it now";
/** A second `normal` utterance, so the two can be told apart in an ordinal test. */
const PLAIN_AGAIN = "run the tests";

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

/** The on-device VAD's view of "they are talking right now" — the cancel the on-device path has. */
function speakingAgain(v: boolean) {
  act(() => {
    useDictationStore.getState().setOnDeviceSpeech(v);
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

    await tick(HIGH + AUTO_SEND_TICK_MS);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("waits far longer on a mid-clause utterance than a finished one", async () => {
    const { onFire } = setup({ composedText: MID_CLAUSE });
    speechEnds();

    // Well past `high`, nowhere near `verylow`.
    await tick(HIGH + 1_000);
    expect(onFire).not.toHaveBeenCalled();

    await tick(VERYLOW - HIGH - 1_000 + AUTO_SEND_TICK_MS);
    expect(onFire).toHaveBeenCalledTimes(1);
  });
});

// ══ THE FIRST UTTERANCE AFTER ACTIVATION ═══════════════════════════════════════════════════════
// Reproduced live: switch the tray to Speak, say a sentence — nothing sends. Say another — THAT one
// sends. Ordinal-dependent, not length-dependent (both sentences scored `normal`).
//
// WHY. The backend emits the transcript FIRST and the speech-end second, deliberately and on both
// capture paths (dictation.rs `PartialThenSpeechEnd`), so that the rail scores THIS sentence rather
// than the previous one. That ordering does not survive the trip into this hook. `speechEndSeq` is
// a store field the hook subscribes to directly, so it lands in the very next commit. The text
// takes three more hops — the dictation insert writes ComposeBox's own `text` state, a ComposeBox
// effect reports it up via `onComposedText`, the host stores it, and only then does it arrive here
// as `composedText`. So the speech-end is evaluated a commit or two BEFORE the words it belongs to.
//
// `noteSpeechEnd` refuses to start a clock on an empty transcript — correctly, there is nothing to
// send — and nothing ever bumps `speechEndSeq` again for that utterance, so the first sentence
// after activation sits in the box forever. The SECOND one works only by accident: the first
// sentence's text is still in the box, so its speech-end finds a non-empty transcript.
//
// Every test above this line hands `setup` a full `composedText` at mount, which is why a suite
// this thorough never saw it. These feed the two facts in the order the app actually delivers them.
describe("the transcript can arrive AFTER the speech-end it belongs to", () => {
  it("fires the first utterance, whose text lands a commit behind its speech-end", async () => {
    // The box is empty because the user has only just switched the tray to Speak.
    const { onFire, update } = setup({ composedText: "" });

    speechEnds(); // Deepgram's boundary reaches the store first…
    update({ composedText: PLAIN }); // …and the words it belongs to a commit later.

    await tick(NORMAL + AUTO_SEND_TICK_MS); // the `normal` tier's accumulated silence
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("treats the FIRST and the SECOND utterance identically", async () => {
    // The property the founder actually reported. A suite that only ever exercises the second
    // utterance is what let this ship, so this walks both in one run, through the same box-emptying
    // that a successful send performs.
    const { onFire, update } = setup({ composedText: "" });

    speechEnds();
    update({ composedText: PLAIN });
    await tick(NORMAL + AUTO_SEND_TICK_MS);
    expect(onFire).toHaveBeenCalledTimes(1);

    // The send emptied the compose box behind it, so the next utterance starts from "" exactly as
    // the first did — which is why this is ordinal-dependent and not a one-off mount artefact.
    update({ composedText: "" });

    speechEnds();
    update({ composedText: PLAIN_AGAIN });
    await tick(NORMAL + AUTO_SEND_TICK_MS);
    expect(onFire).toHaveBeenCalledTimes(2);
  });

  it("does not arm on text the user TYPES long after an unrelated speech-end", async () => {
    // The bound that keeps the hold from becoming a latch. A speech-end whose words never arrived is
    // the propagation lag it exists for only for as long as that lag plausibly lasts; a minute later
    // the next thing to reach the box is a different user action, and arming on it would count down
    // over a draft nobody spoke.
    const { onFire, update, result } = setup({ composedText: "" });
    speechEnds(); // a boundary whose words never came
    await tick(60_000); // …and the user does something else entirely for a minute

    update({ composedText: PLAIN }); // now they TYPE into the box
    expect(result.current.phase).not.toBe("counting");

    await tick(30_000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("drops the held boundary when the mic moves to another surface before the text lands", async () => {
    // Same hazard the ownership gate closes, from the other side: a boundary held for a transcript
    // that has not arrived must not survive losing the mic and then arm off whatever text turns up.
    const { onFire, update, result } = setup({ composedText: "" });
    speechEnds();
    update({ micLive: false }); // the user clicked an agent composer's mic
    update({ composedText: PLAIN });
    expect(result.current.phase).not.toBe("counting");

    await tick(30_000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("does not arm off a held boundary while the user is talking again", async () => {
    // The on-device decode runs behind the audio, so the words can land after the speaker has
    // already resumed. The replay must meet the same still-talking guard a live boundary does,
    // rather than becoming a way around it.
    const { onFire, update, result } = setup({ composedText: "" });
    speechEnds();
    speakingAgain(true);
    update({ composedText: PLAIN });
    expect(result.current.phase).not.toBe("counting");

    await tick(30_000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("does not leave a refused boundary latched for the NEXT chunk to trip", async () => {
    // The hold is consumed BEFORE the replay, so a refusal spends it. Latched instead, the boundary
    // would sit there until any later transcript change — a committed chunk of the sentence the user
    // is STILL speaking — quietly armed a countdown anchored back at a boundary the guard had
    // already rejected, which is the double-arm race the on-device notes above warn against.
    const { onFire, update, result } = setup({ composedText: "" });
    speechEnds();
    speakingAgain(true); // they carried straight on into the next clause
    update({ composedText: PLAIN }); // the held boundary's words land — and are refused
    expect(result.current.phase).not.toBe("counting");

    speakingAgain(false);
    // A later chunk of the same continuing sentence, with NO new boundary behind it. Only a fresh
    // `speechEndSeq` may start a clock.
    update({ composedText: `${PLAIN} and rerun them` });
    expect(result.current.phase).not.toBe("counting");

    await tick(30_000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("does not arm off a held boundary while the user is talking again — ON THE CLOUD PATH", async () => {
    // The twin of the test above, and NOT redundant with it: the hook defines "they are talking" as
    // two sources because neither can speak for the other, and the cloud path reports it through
    // `interim` rather than the VAD level. Guarding only the on-device half leaves the cloud half
    // able to start a countdown that nothing can then stop — effect (4)'s dependency is the
    // `speaking` BOOLEAN, so once interim is already non-empty it does not re-run when a clock
    // starts underneath it, `noteTranscript` never touches the clock, and the next real speech-end
    // hits `noteSpeechEnd`'s idempotence branch. Three seconds later it would dispatch the previous
    // sentence plus a fragment of the one still being spoken.
    const { onFire, update, result } = setup({ composedText: "" });
    speechEnds(); // the first utterance's boundary — its words have not landed yet
    update({ interim: "and then also" }); // Deepgram streams the NEXT utterance
    update({ composedText: PLAIN }); // …and only now do the first one's words arrive
    expect(result.current.phase).not.toBe("counting");

    await tick(30_000);
    expect(onFire).not.toHaveBeenCalled();
  });

  // ── THE LAG BOUND'S VALUE, BRACKETED FROM BOTH SIDES ────────────────────────────────────────
  // Deliberately in ABSOLUTE milliseconds and not in terms of PENDING_TRANSCRIPT_MAX_LAG_MS. A
  // bracket written as `MAX_LAG - 100` / `MAX_LAG + 100` moves with the constant, so it pins the
  // comparison and says nothing whatever about the value — retuning to 5s or to 100ms leaves both
  // rows green. (Confirmed by mutation: that is exactly what the first draft of these two did.)
  // What actually needs pinning is that the number stays inside the band where it means what its
  // doc claims, and only fixed times either side can do that.
  const WITHIN_PROPAGATION_MS = 400;
  const TYPING_DELAY_MS = 1_000;

  it("is long enough for the propagation delay it exists for", async () => {
    // The lower edge. Three React hops under load is the case this hold was built for; a bound
    // retuned below that silently restores the original bug — the first utterance stops sending
    // again, with no error anywhere.
    const { onFire, update } = setup({ composedText: "" });
    speechEnds();
    await tick(WITHIN_PROPAGATION_MS);

    update({ composedText: PLAIN });
    await tick(NORMAL + AUTO_SEND_TICK_MS);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("is short enough that text arriving a beat later cannot cash it in", async () => {
    // The upper edge, and the one that guards a send rather than a symptom. Stretch the bound to
    // seconds and a stray empty-transcript boundary — background noise closing a segment while the
    // box is empty — followed by the user typing their first character arms a countdown over a
    // draft they never spoke, and auto-dispatches it. That is irreversible.
    const { onFire, update, result } = setup({ composedText: "" });
    speechEnds();
    await tick(TYPING_DELAY_MS);

    update({ composedText: PLAIN });
    expect(result.current.phase).not.toBe("counting");
    await tick(30_000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("holds nothing at all while the tray is in Send mode", async () => {
    // Speaking with auto-send OFF must not leave a boundary lying around that switching the tray to
    // Speak then cashes in. The words the user spoke a moment ago under a different tray position
    // are not a countdown they started.
    const { onFire, update, result } = setup({ armed: false, composedText: "" });
    speechEnds(); // spoken while the tray was still in Send mode
    update({ armed: true }); // the user switches to Speak…
    update({ composedText: PLAIN }); // …and only now do those words reach the box
    expect(result.current.phase).not.toBe("counting");

    await tick(30_000);
    expect(onFire).not.toHaveBeenCalled();
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
    await tick(HIGH + AUTO_SEND_TICK_MS);
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
    // (verylow -> high) but must not touch the 600ms already elapsed. Advance the remainder of the
    // HIGH window and it must fire, rather than starting the whole window over.
    update({ composedText: DONE });
    await tick(HIGH - 600 + AUTO_SEND_TICK_MS);
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

    await tick(HIGH + AUTO_SEND_TICK_MS);
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
    await tick(HIGH + AUTO_SEND_TICK_MS);

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

    await tick(HIGH + AUTO_SEND_TICK_MS);
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
    // waits out a longer silence than their tier promises. DONE is `high`; 300ms of that window is
    // already spent by the time the claim lands.
    const { onFire, update } = setup({ micLive: false });
    speechEnds();
    await tick(300);

    update({ micLive: true });
    // 300ms already elapsed, plus enough to land just SHORT of the high threshold.
    await tick(HIGH - 300 - 100);
    expect(onFire).not.toHaveBeenCalled();

    // …and past it, measured from the real speech end rather than from the claim.
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
