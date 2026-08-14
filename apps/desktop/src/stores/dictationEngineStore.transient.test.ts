// ── A SELF-HEALING DEGRADATION MUST NOT RAISE AN ALARM (sparkle-cbyhg) ─────────────────────────────
// The founder reported the amber bar firing on a condition its OWN copy calls self-healing ("It
// usually reconnects on its own, so try dictating again in a moment"). Two defects produced that,
// and this suite pins both:
//
//   1. THE TEARDOWN SEAM HAD NO DEBOUNCE AT ALL. `noteCloudUnavailable` is the sink for BOTH the
//      relay's definitive answers (401/402/403 → `signed_out`/`exhausted`/`not_entitled`) and the
//      mid-stream `cloud-ended` teardown, which reports the ambiguous `unavailable`. It zeroed
//      `openRefusals` for all of them, so a SINGLE dropped socket painted the bar instantly and
//      simultaneously destroyed the corroboration the open seam had been accumulating. The relay
//      measured 68-183 ms per handshake over 8 consecutive probes on the machine where this was
//      reported, so one failure against it is a blip, not an outage.
//   2. IT WENT TO A WINDOW-WIDE WARNING. `unavailable` loses the live preview and nothing else —
//      every word is still captured — so it now renders next to the mic instead of stealing a full
//      row above the whole app. The reasons the user can ACT on keep the bar.
//
// The debounce is deliberately BOTH a count and a duration. A count alone still fires on two
// failures a second apart, which is the same blip; a duration alone never fires for a user who
// dictates once every few minutes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  localEngineNoticeSurface,
  shouldWarnLocalEngine,
  UNAVAILABLE_FAILURES_BEFORE_NOTICE,
  UNAVAILABLE_SUSTAINED_MS,
  useDictationEngineStore,
  type DictationEngineState,
} from "./dictationEngineStore";

const read = (): DictationEngineState => useDictationEngineStore.getState();

beforeEach(() => {
  vi.useRealTimers();
  useDictationEngineStore.setState({
    fallbackReason: null,
    dismissed: false,
    observedAt: null,
    openRefusals: 0,
    captureSession: 0,
    observedSession: null,
    unavailableSince: null,
  });
});

/** Drive the mid-stream teardown seam — the one that had no debounce — at a chosen wall clock. */
function relayDroppedAt(t: number): void {
  vi.setSystemTime(t);
  useDictationEngineStore.getState().noteCloudUnavailable("unavailable");
}

describe("transient cloud-transcription outages stay quiet", () => {
  // ── THE HEADLINE REGRESSION ────────────────────────────────────────────────────────────────────
  // This is the founder's screenshot, reduced: one relay teardown, and the bar was up.
  it("says nothing on a single failure", () => {
    vi.useFakeTimers();
    relayDroppedAt(1_000_000);

    expect(shouldWarnLocalEngine(read())).toBe(false);
    expect(localEngineNoticeSurface(read())).toBe(null);
  });

  // The COUNT half of the gate. Two failures is enough corroboration only if they also span the
  // sustained window — a relay that drops twice inside a second is flapping, not down.
  it("says nothing on two failures inside the sustained window", () => {
    vi.useFakeTimers();
    const t0 = 1_000_000;
    relayDroppedAt(t0);
    relayDroppedAt(t0 + UNAVAILABLE_SUSTAINED_MS - 1);

    expect(read().openRefusals).toBeGreaterThanOrEqual(UNAVAILABLE_FAILURES_BEFORE_NOTICE);
    expect(shouldWarnLocalEngine(read())).toBe(false);
    expect(localEngineNoticeSurface(read())).toBe(null);
  });

  // The DURATION half. A long gap alone is not evidence either: the first failure could have been
  // the only one, with the user simply away from the keyboard since.
  it("says nothing on a single failure however long ago it was", () => {
    vi.useFakeTimers();
    const t0 = 1_000_000;
    relayDroppedAt(t0);
    vi.setSystemTime(t0 + UNAVAILABLE_SUSTAINED_MS * 10);

    expect(shouldWarnLocalEngine(read(), Date.now())).toBe(false);
    expect(localEngineNoticeSurface(read(), Date.now())).toBe(null);
  });

  // BOTH gates satisfied → it finally speaks. Without this the suite would pass against a
  // `shouldWarnLocalEngine` hard-wired to false, which would mute every real outage.
  it("speaks once failures are both repeated AND sustained", () => {
    vi.useFakeTimers();
    const t0 = 1_000_000;
    relayDroppedAt(t0);
    relayDroppedAt(t0 + UNAVAILABLE_SUSTAINED_MS + 1);

    expect(shouldWarnLocalEngine(read())).toBe(true);
    expect(localEngineNoticeSurface(read())).toBe("mic");
  });

  // ── AUTO-DISMISS ──────────────────────────────────────────────────────────────────────────────
  // The founder must never have to click ✕ on a condition that already healed. `noteCloudLive` is
  // reached by a successful open AND by the relay's first streamed word, so recovery clears it
  // without any user action.
  it("clears itself the moment the service reconnects", () => {
    vi.useFakeTimers();
    const t0 = 1_000_000;
    relayDroppedAt(t0);
    relayDroppedAt(t0 + UNAVAILABLE_SUSTAINED_MS + 1);
    expect(localEngineNoticeSurface(read())).toBe("mic");

    useDictationEngineStore.getState().noteCloudLive();

    expect(localEngineNoticeSurface(read())).toBe(null);
    expect(shouldWarnLocalEngine(read())).toBe(false);
    // The debounce evidence goes with the episode. Leaving `unavailableSince` set would let the
    // NEXT lone blip read as "sustained since ages ago" and speak on its own — the exact
    // single-failure alarm this whole change deletes, reintroduced one recovery later.
    expect(read().unavailableSince).toBe(null);
    expect(read().openRefusals).toBe(0);
  });

  // A recovery must genuinely RESET the gate, not merely hide the notice: after reconnecting, one
  // fresh failure has to be as silent as the very first one was.
  it("requires the full debounce again after a recovery", () => {
    vi.useFakeTimers();
    const t0 = 1_000_000;
    relayDroppedAt(t0);
    relayDroppedAt(t0 + UNAVAILABLE_SUSTAINED_MS + 1);
    useDictationEngineStore.getState().noteCloudLive();

    relayDroppedAt(t0 + UNAVAILABLE_SUSTAINED_MS * 5);

    expect(shouldWarnLocalEngine(read())).toBe(false);
    expect(localEngineNoticeSurface(read())).toBe(null);
  });

  // ── THE DEBOUNCE IS SCOPED TO THE AMBIGUOUS REASON ONLY ───────────────────────────────────────
  // A relay that ANSWERS is not a relay we cannot reach. Making a user dictate twice over twenty
  // seconds before being told their session expired would be withholding an answer we already have.
  it.each(["exhausted", "signed_out", "not_entitled", "too_many_streams"] as const)(
    "still reports %s immediately — the relay stated it, and the user can act on it",
    (reason) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      useDictationEngineStore.getState().noteCloudUnavailable(reason);

      expect(shouldWarnLocalEngine(read())).toBe(true);
      expect(localEngineNoticeSurface(read())).toBe("banner");
    },
  );

  // Words were LOST here, not merely the live preview, so these keep the loud surface AND the
  // immediacy. They are also the reason the debounce could not simply be applied at the sink.
  it.each(["mic_missed_hold", "model_still_loading"] as const)(
    "still reports %s immediately on the banner — the utterance was lost",
    (reason) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      useDictationEngineStore
        .getState()
        .noteMicMissedHold(reason === "model_still_loading" ? "model" : "capture");

      expect(shouldWarnLocalEngine(read())).toBe(true);
      expect(localEngineNoticeSurface(read())).toBe("banner");
    },
  );

  // ── THE SURFACE SPLIT ─────────────────────────────────────────────────────────────────────────
  // The founder's actual complaint: this one condition stole a full row above his entire agent
  // fleet for a degradation that loses no words. It may never return "banner", corroborated or not.
  it("never routes a transient outage to the window-wide banner", () => {
    vi.useFakeTimers();
    const t0 = 1_000_000;
    relayDroppedAt(t0);
    relayDroppedAt(t0 + UNAVAILABLE_SUSTAINED_MS + 1);

    expect(localEngineNoticeSurface(read())).not.toBe("banner");
  });

  // A definitive answer arriving mid-episode must end the ambiguous one rather than inheriting its
  // accumulated evidence — the roborev-60366 invariant, which the debounce must not break.
  it("lets a definitive answer end an in-progress ambiguous episode", () => {
    vi.useFakeTimers();
    const t0 = 1_000_000;
    relayDroppedAt(t0);
    vi.setSystemTime(t0 + UNAVAILABLE_SUSTAINED_MS + 1);
    useDictationEngineStore.getState().noteCloudUnavailable("exhausted");

    expect(read().unavailableSince).toBe(null);
    expect(read().openRefusals).toBe(0);
    expect(localEngineNoticeSurface(read())).toBe("banner");
  });
});
