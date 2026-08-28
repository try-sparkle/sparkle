// The drop that emptied the founder's compose box (bead sparkle-klkcwu).
//
// Measured from his log: the backend emitted twelve committed segments (`emit partial seq=0..11`,
// `source="accept"`) over three and a half minutes and not one reached the box, because
// `insert()` was `if (fn) fn(text)` with no else. These tests drive the REAL store action rather
// than asserting on the shape of the state, so they fail against that original line.
import { describe, it, expect, beforeEach } from "vitest";
import { useDictationStore } from "./dictationStore";
import { voiceErrorNotice } from "../voice/dictationCopy";
import { deliveryReasonOf } from "../voice/deliveryWatchdog";
import { deriveMicPresentation, micIsHearing } from "../voice/micPresentation";

const read = () => useDictationStore.getState();

beforeEach(() => {
  useDictationStore.setState({
    error: null,
    status: "listening",
    insertTarget: null,
    heldSegments: [],
  });
});

describe("a committed segment with no composer to receive it", () => {
  it("is reported instead of vanishing", () => {
    read().insert("the words he actually said");

    // The defect: this used to be null, forever, with the ring still reading "listening".
    expect(read().error).not.toBeNull();
    expect(deliveryReasonOf(read().error)).toBe("no-target");
  });

  it("makes the mic surfaces stop claiming they are hearing him", () => {
    read().insert("the words he actually said");
    // `hasError` is derived from the NOTICE, never from `status` (useVoicePlaceholder,
    // useMicIsHearing) — so the ring goes to "error" and `micIsHearing` goes false.
    expect(
      micIsHearing(
        deriveMicPresentation({
          enabled: true,
          status: read().status,
          phase: "active",
          modelProgress: null,
          outOfCreditsNotice: false,
          pauseReason: null,
          hasError: voiceErrorNotice(read().error) !== null,
        }),
      ),
    ).toBe(false);
  });

  // ── THE REGRESSION GUARD FOR roborev 71065 ────────────────────────────────────────────────────
  // `status` is a ROUTING input, not presentation: `terminalRoutingArmed()` goes false on
  // `status === "error"`, which cascades through `isTerminalRoutable()` → `focusPauseReason()` →
  // `isRoutable()`. An earlier draft wrote it here, and the notice then became unretractable —
  // delivery was structurally impossible, so `noteDelivered()` could never run and terminal
  // dictation stayed dead for the session. Writing `error` alone is what keeps the mic live.
  it("never writes status, so every routing gate keeps working", () => {
    read().insert("the words he actually said");
    expect(read().status).toBe("listening");
  });

  // The rate limit, and it is not cosmetic: the on-device engine keeps emitting committed segments
  // during ordinary passive push-to-talk, so reporting per segment would raise a notice on every
  // ambient phrase — the flapping OPEN_REFUSALS_BEFORE_WARNING was left alone to avoid.
  //
  // ASSERTING THE STORE WRITE, NOT THE VALUE. Both drops encode the same reason, so comparing
  // `error` before and after passes whether or not the guard exists — the first version of this
  // test did exactly that and stayed green with the guard deleted. What the guard actually changes
  // is whether a `set` happens at all, so this counts subscriber notifications.
  it("does not re-report a reason that is already standing", () => {
    read().insert("one");

    let notifications = 0;
    const unsub = useDictationStore.subscribe(() => {
      notifications += 1;
    });
    read().insert("two");
    read().insert("three");
    unsub();

    expect(notifications).toBe(0);
  });

  it("reaches the user as written copy, not a raw sentinel", () => {
    read().insert("the words he actually said");
    const notice = voiceErrorNotice(read().error);
    expect(notice?.kind).toBe("transcript-undelivered");
    expect(notice?.headline).toBe("Sparkle heard you, but had nowhere to put the text.");
    expect(notice?.detail).not.toContain("voice-delivery");
  });
});

describe("a committed segment that lands", () => {
  it("goes to the registered target and reports nothing", () => {
    const got: string[] = [];
    read().registerInsert((t) => got.push(t));

    read().insert("hello");

    expect(got).toEqual(["hello"]);
    expect(read().error).toBeNull();
  });

  // "Keep listening and retry" — the notice must come down on its own the moment the pipeline
  // proves itself, with no restart. A notice that outlives the outage is the defect
  // `dictationEngineStore`'s header describes the founder reporting: "still seeing the banner, no
  // idea why".
  it("retracts a standing delivery notice and returns to listening", () => {
    read().insert("dropped");
    expect(read().error).not.toBeNull();

    read().registerInsert(() => {});
    read().insert("delivered");

    expect(read().error).toBeNull();
    expect(read().status).toBe("listening");
  });

  // A delivered segment says the DELIVERY leg works. It says nothing about a dead microphone or a
  // revoked permission, so those must survive it — retracting them here would be the app telling
  // the user a fault had cleared on evidence that does not bear on it.
  it("does not retract an unrelated voice error", () => {
    useDictationStore.setState({ error: "microphone access was denied", status: "error" });
    read().registerInsert(() => {});

    read().insert("delivered");

    expect(read().error).toBe("microphone access was denied");
    expect(read().status).toBe("error");
  });
});
