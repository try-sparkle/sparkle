/**
 * The pre-arm gate for the push-to-talk relay pre-connect (sparkle-v3990, the latency half).
 *
 * Every case here is a REASON, not a permutation: each `false` prevents a specific bad thing (a
 * billable socket for a gesture that is not coming, a race with the hold's own opener, a relay
 * connection held open while the user is in another app, a request on a path `openCloud` would have
 * refused), and the single `true` is the state the founder is actually in when the mic "does not
 * work".
 */

import { describe, expect, it } from "vitest";
import { shouldPreconnectCloud, type PreconnectInputs } from "./cloudPreconnect";

/** Push to talk, at rest, focused, everything entitled — the state a pre-connect exists for. */
const ARMED_AND_FOCUSED: PreconnectInputs = {
  mode: "ptt",
  phase: "passive",
  windowFocused: true,
  aiComposer: true,
  voiceDictation: true,
};

describe("shouldPreconnectCloud", () => {
  it("fires for push to talk at rest in a focused, entitled window", () => {
    // The whole point: this is the moment the socket must open, so that the hold which follows —
    // 76-567 ms of it, measured — resumes a warm socket instead of starting a ~490 ms handshake it
    // cannot outlast.
    expect(shouldPreconnectCloud(ARMED_AND_FOCUSED)).toBe(true);
  });

  it("does not fire for the tray positions that have no cold-start problem", () => {
    // Speak holds the phase ACTIVE for as long as the tray sits there, so its socket is opened once
    // by the ordinary phase edge and stays. Send releases the microphone entirely. Pre-connecting
    // for either opens a billable relay socket for a gesture that is never coming.
    expect(shouldPreconnectCloud({ ...ARMED_AND_FOCUSED, mode: "speak" })).toBe(false);
    expect(shouldPreconnectCloud({ ...ARMED_AND_FOCUSED, mode: "send" })).toBe(false);
  });

  it("does not fire DURING a hold", () => {
    // `phase === "active"` means the hold is already underway and `start_cloud_stream` owns the
    // socket. A second opener racing it is exactly the shape the epoch / ptr_eq guards exist to
    // clean up after — nothing to gain, a race to lose.
    expect(shouldPreconnectCloud({ ...ARMED_AND_FOCUSED, phase: "active" })).toBe(false);
  });

  it("treats focus as the OUTER term, exactly as the microphone policy does", () => {
    // `capture_should_be_live` is `focused && (armed || hold_recent)`: tab away and the OS mic is
    // released whatever else is true. A socket held open to Sparkle's relay while the user is in
    // another app is the same class of promise, so it gets the same answer — and because this
    // verdict is re-sent on every change, the resulting `false` is a RELEASE, not merely a refusal
    // to open the next one.
    expect(shouldPreconnectCloud({ ...ARMED_AND_FOCUSED, windowFocused: false })).toBe(false);
    // Unfocused beats every other term, singly and together.
    expect(
      shouldPreconnectCloud({ ...ARMED_AND_FOCUSED, windowFocused: false, mode: "speak" }),
    ).toBe(false);
  });

  it("respects both live prefs openCloud itself gates on", () => {
    // `openCloud` early-returns on `aiFeatureNow("composer") && aiFeatureNow("voiceDictation")`. A
    // pre-connect that skipped either would reach the relay on a path the real open refuses — and
    // would occupy one of the account's concurrent stream slots, which is how a `too_many_streams`
    // refusal appears in a different window that is genuinely dictating.
    expect(shouldPreconnectCloud({ ...ARMED_AND_FOCUSED, aiComposer: false })).toBe(false);
    expect(shouldPreconnectCloud({ ...ARMED_AND_FOCUSED, voiceDictation: false })).toBe(false);
  });
});
