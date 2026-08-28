// @vitest-environment jsdom
/**
 * THE FIVE-SECOND REQUIREMENT, DRIVEN THROUGH THE REAL LISTENERS (bead sparkle-klkcwu).
 *
 * With the transcription leg dead, starting to speak must put a visible error in front of the user
 * within five seconds — instead of a level meter that responds to their voice forever and never
 * produces a word. That is the shape the founder hit: the relay refused once
 * (`refusal="unreachable"`), the on-device engine took over, and for three and a half minutes the
 * ring read "actively listening" over an empty compose box.
 *
 * IN ITS OWN JSDOM FILE, for the reason `useDictation.engine.test.tsx` states: the node-env
 * controller tests never construct the hook, and the `speaking` listener that arms this deadline is
 * attached by `createDictationController` — so the whole mechanism could be deleted and they would
 * all stay green.
 *
 * IT DRIVES THE VAD EVENT, NOT THE TIMER. Calling the watchdog's predicate directly would prove the
 * arithmetic and nothing about the wiring; `deliveryWatchdog.test.ts` already owns the arithmetic.
 * What is under test here is that a real `dictation://speaking` edge arms a real deadline that
 * writes a real notice.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

const listeners: Record<string, Array<(e: { payload: unknown }) => void>> = {};
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    (listeners[name] ??= []).push(cb);
    return Promise.resolve(() => {
      listeners[name] = (listeners[name] ?? []).filter((c) => c !== cb);
    });
  },
}));

const invoke = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

vi.mock("./services/dictationTerminalSink", () => ({
  routeDictationToTerminal: vi
    .fn()
    .mockResolvedValue({ kind: "delivered", agentId: "a1", text: "x" }),
}));

vi.mock("./services/aiGate", () => ({ useAiFeature: () => true, aiFeatureNow: () => true }));

import { useDictationStore } from "./stores/dictationStore";
import { useDictationEngineStore } from "./stores/dictationEngineStore";
import { useAmbientVoice } from "./useDictation";
import { voiceErrorNotice } from "./voice/dictationCopy";
import { deliveryReasonOf } from "./voice/deliveryWatchdog";
import { deriveMicPresentation, micIsHearing } from "./voice/micPresentation";
import { useMicToggle } from "./components/MicButton";

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

/** See `focusTheComposer` in useDictation.engine.test.tsx — jsdom reports `document.hasFocus()`
 *  false until something is focused, and `isCapturable()` fails on that alone. */
function focusTheComposer(): void {
  const ta = document.createElement("textarea");
  document.body.appendChild(ta);
  ta.focus();
}

/** Fire a backend event through the REAL listener the controller registered. */
async function emit(name: string, payload: unknown): Promise<void> {
  await act(async () => {
    for (const cb of listeners[name] ?? []) cb({ payload });
  });
}

async function mountListening(): Promise<void> {
  renderHook(() => useAmbientVoice());
  await flush();
  await act(async () => {
    useDictationStore.setState({ phase: "active" });
  });
  await flush();
}

beforeEach(() => {
  document.body.innerHTML = "";
  focusTheComposer();
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  for (const k of Object.keys(listeners)) delete listeners[k];
  useDictationStore.setState({
    enabled: true,
    status: "listening",
    error: null,
    phase: "passive",
    interim: "",
    windowFocused: true,
    focusOwner: "other",
    committedSeq: 0,
    // A composer IS mounted and listening. That isolates this file to the "nothing ever arrives"
    // half — with a null target every delivered segment would report `no-target` instead, which is
    // a different reason with its own coverage in dictationStore.delivery.test.ts.
    insertTarget: () => {},
  });
  useDictationEngineStore.setState({
    fallbackReason: null,
    dismissed: false,
    observedAt: null,
    openRefusals: 0,
    captureSession: 0,
    observedSession: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the transcription leg is dead and the user is talking", () => {
  it("puts a visible error in front of them inside five seconds", async () => {
    await mountListening();
    expect(useDictationStore.getState().error).toBeNull();

    vi.useFakeTimers();
    const startedAt = Date.now();
    await emit("dictation://speaking", true);

    // Everything the backend still does correctly while the transcription leg is dead: the VAD
    // keeps firing and the meter keeps moving. None of it is a word.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });

    const state = useDictationStore.getState();
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(deliveryReasonOf(state.error)).toBe("no-transcript");

    // What the founder would actually have seen. The composer error slot renders exactly this.
    const notice = voiceErrorNotice(state.error);
    expect(notice?.kind).toBe("transcript-undelivered");
    expect(notice?.headline).toBe("Sparkle is hearing you, but no words are coming back.");
  });

  it("stops the mic surfaces painting a healthy listening state", async () => {
    await mountListening();
    vi.useFakeTimers();
    await emit("dictation://speaking", true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });

    const s = useDictationStore.getState();
    // `deriveMicPresentation` returns "error" on a live notice, so `micIsHearing` goes false.
    // Before this change it stayed "activeListening" — the indicator that lied for three and a
    // half minutes.
    expect(
      micIsHearing(
        deriveMicPresentation({
          enabled: true,
          status: s.status,
          phase: "active",
          modelProgress: null,
          outOfCreditsNotice: false,
          pauseReason: null,
          hasError: voiceErrorNotice(s.error) !== null,
        }),
      ),
    ).toBe(false);
    // …and the routing gates are untouched, so the mic keeps listening and retrying (roborev 71065).
    expect(s.status).toBe("listening");
  });
});

// ONE FIX, FOUR CALL SITES — so each is checked (AGENTS.md). Covering only the change would go
// green the moment any single site was wired, reporting the uncovered siblings as verified.
describe("recognised words dropped by a gate, rather than never produced", () => {
  it("reports the mic being paused instead of discarding the words in silence", async () => {
    renderHook(() => useAmbientVoice());
    await flush();
    // Armed and routable, but PASSIVE — push-to-talk between holds. `micIsHearing()` paints
    // `passiveWaiting` as "hearing you" in exactly this state, which is why the discard has to say
    // something.
    await act(async () => {
      useDictationStore.setState({ phase: "passive" });
    });
    await flush();

    await emit("dictation://partial", "the words he actually said");

    expect(deliveryReasonOf(useDictationStore.getState().error)).toBe("mic-paused");
    expect(voiceErrorNotice(useDictationStore.getState().error)?.headline).toBe(
      "Sparkle heard you, but the mic is paused.",
    );
  });

  it("reports an unroutable window instead of discarding the words in silence", async () => {
    await mountListening();
    // Take focus away from the composer. `isWindowActive()` reads `document.hasFocus()`, which
    // jsdom answers false once nothing in the document is focused.
    await act(async () => {
      (document.activeElement as HTMLElement | null)?.blur();
      document.body.innerHTML = "";
    });

    await emit("dictation://partial", "the words he actually said");

    expect(deliveryReasonOf(useDictationStore.getState().error)).toBe("not-routable");
  });

  // ── THE CLAIM CHECKED AGAINST REALITY, NOT AGAINST ITS OWN COPY (roborev 71065) ──────────────
  // The notice for `no-target` promises the words were kept; the notices for `mic-paused` and
  // `not-routable` must not, because neither path reaches `appendHeldSegment`. Asserting the copy
  // strings cannot catch that promise drifting from the code — this asserts the store.
  it("holds the words only on the reason whose copy claims it does", async () => {
    // no-target: `insert()` runs after `appendHeldSegment`, so the words really are recoverable.
    await mountListening();
    useDictationStore.setState({ insertTarget: null, heldSegments: [] });
    await emit("dictation://partial", "kept words");
    expect(deliveryReasonOf(useDictationStore.getState().error)).toBe("no-target");
    expect(useDictationStore.getState().heldSegments).toEqual(["kept words"]);
    expect(voiceErrorNotice(useDictationStore.getState().error)!.detail).toContain("kept");

    // mic-paused: returns before `appendHeldSegment`, so nothing is held — and the copy says so.
    useDictationStore.setState({ heldSegments: [], error: null, phase: "passive" });
    await emit("dictation://partial", "lost words");
    expect(deliveryReasonOf(useDictationStore.getState().error)).toBe("mic-paused");
    expect(useDictationStore.getState().heldSegments).toEqual([]);
    const detail = voiceErrorNotice(useDictationStore.getState().error)!.detail.toLowerCase();
    expect(detail).not.toContain("kept");
    expect(detail).not.toContain("clipboard");
  });

  // ── THE GLYPH, WHICH READS `status` AND NOT THE NOTICE (roborev 71078) ──────────────────────
  // `deriveMicState` has no error term by design — every OTHER fault demotes it through
  // `status === "error"`. A delivery drop deliberately does not write `status`, because that is a
  // routing input (roborev 71065), so without the demotion at this call site the mic button stays
  // GREEN while every recognised word is discarded — the precise contradiction this change exists
  // to delete.
  //
  // DRIVEN THROUGH THE REAL HOOK, not through a re-implementation of the demotion expression: an
  // earlier draft asserted `deriveMicState(enabled, notice ? "idle" : status, …)`, which restates
  // the production line rather than exercising it and stayed green with the call site reverted.
  it("never leaves the mic button reading active while a notice stands", async () => {
    await mountListening();
    useDictationStore.setState({ insertTarget: null, phase: "active", error: null });
    await emit("dictation://partial", "the words he actually said");
    expect(deliveryReasonOf(useDictationStore.getState().error)).toBe("no-target");
    // `status` is untouched, so a glyph reading it alone would still say "listening".
    expect(useDictationStore.getState().status).toBe("listening");

    const { result } = renderHook(() => useMicToggle());
    // What is PAINTED is demoted…
    expect(result.current.glyphState).not.toBe("active");
  });

  // ── AND THE CONTROL STILL DOES WHAT IT SAYS (roborev 71168) ─────────────────────────────────
  // The demotion must change only what is painted. An earlier draft demoted the single shared
  // value, which also drives `onClick` and the labels: over a genuinely live mic the button read
  // "Turn off" and one click DISARMED capture instead of pausing it — and since `no-transcript` is
  // cleared only by a delivered segment, the control could never reach "Pause" again for the rest
  // of a session on a dead transcription leg. `state !== "active"` alone passes under that bug,
  // which is why this asserts the ACTION.
  it("still pauses rather than disarms while a notice stands", async () => {
    await mountListening();
    useDictationStore.setState({ insertTarget: null, phase: "active", error: null });
    await emit("dictation://partial", "the words he actually said");
    expect(deliveryReasonOf(useDictationStore.getState().error)).toBe("no-target");

    const { result } = renderHook(() => useMicToggle());
    expect(result.current.state).toBe("active");
    expect(result.current.title).toBe("Pause");
    expect(result.current.ariaLabel).toBe("Pause listening");

    await act(async () => {
      result.current.onClick();
    });

    expect(useDictationStore.getState().phase).toBe("passive");
    expect(useDictationStore.getState().enabled).toBe(true);
  });

  // A blank or noise-only segment is not something the user said, so it must not raise a notice
  // about words that never existed. The empty guard sits above the phase gate for this.
  it("says nothing about an empty segment", async () => {
    await mountListening();
    useDictationStore.setState({ phase: "passive", error: null });
    await emit("dictation://partial", "   ");
    expect(useDictationStore.getState().error).toBeNull();
  });
});

describe("the cases that must stay silent", () => {
  // The branch that keeps this from accusing someone who has simply not spoken yet. Arming the mic
  // and thinking for ten seconds is not a fault.
  it("says nothing when the user has not spoken, however long they wait", async () => {
    await mountListening();
    vi.useFakeTimers();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(useDictationStore.getState().error).toBeNull();
  });

  it("says nothing once words come back", async () => {
    await mountListening();
    vi.useFakeTimers();
    await emit("dictation://speaking", true);

    // A committed segment arrives well inside the deadline — the pipeline works.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await emit("dictation://partial", "the words he actually said");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });

    expect(useDictationStore.getState().error).toBeNull();
  });

  // A user speaking in bursts must not reset the clock, or the deadline never fires for exactly the
  // person it is meant to help — someone talking continuously into a dead pipeline.
  it("does not let a second speech edge restart the deadline", async () => {
    await mountListening();
    vi.useFakeTimers();
    await emit("dictation://speaking", true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    await emit("dictation://speaking", false);
    await emit("dictation://speaking", true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });

    expect(deliveryReasonOf(useDictationStore.getState().error)).toBe("no-transcript");
  });
});
