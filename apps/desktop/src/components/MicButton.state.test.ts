import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { deriveMicState, shouldBlockMicArm, type MicState } from "./MicButton";
import { useDictationStore, OUT_OF_CREDITS_NOTICE_MS } from "../stores/dictationStore";
import type { Me } from "../services/entitlement";
import type { Phase } from "../voice/wakeMachine";

const me = (balanceCents: number): Me => ({
  clerkUserId: "u1",
  entitled: true,
  balanceCents,
  tokenVersion: 1,
});

// deriveMicState is THE single source of truth for the mic tri-state. Both mic surfaces (the top
// ring in LogoWaveform and the composer-left ComposerMic) render from it via useMicToggle, so if
// this derivation is right the two controls can never disagree within a window. This pins every
// (enabled × status × phase) combination so a future refactor can't silently fork the two mics.
type Status = "idle" | "listening" | "error";
const STATUSES: Status[] = ["idle", "listening", "error"];
const PHASES: Phase[] = ["passive", "active"];

describe("deriveMicState — the shared mic tri-state", () => {
  it("mic disarmed → OFF regardless of status/phase", () => {
    for (const status of STATUSES)
      for (const phase of PHASES)
        expect(deriveMicState(false, status, phase)).toBe<MicState>("off");
  });

  it("armed + capture live + active phase → ACTIVE (the only path to active)", () => {
    expect(deriveMicState(true, "listening", "active")).toBe<MicState>("active");
  });

  it("armed but NOT (live && active) → PAUSED for every other armed combination", () => {
    for (const status of STATUSES)
      for (const phase of PHASES) {
        if (status === "listening" && phase === "active") continue; // the one active case
        expect(deriveMicState(true, status, phase)).toBe<MicState>("paused");
      }
  });

  it("focus-paused (armed, active phase, but capture idle) reads PAUSED, never active", () => {
    // The subtle one: we can hold the active PHASE while focus-paused (status idle). The mic must
    // read paused then — claiming active while nothing is captured is exactly the desync to avoid.
    expect(deriveMicState(true, "idle", "active")).toBe<MicState>("paused");
  });
});

// PREPARING — the first-run bug. useDictation optimistically sets status "listening" BEFORE
// invoke("start_dictation"), which on a cold start blocks for MINUTES downloading the voice model.
// For that whole wait the old derivation returned "paused", byte-identical to a healthy ready mic,
// while the composer invited the user to say the wake word at a model that didn't exist yet.
// modelProgress (non-null only while the backend is fetching the model) is the signal that tells
// the two apart — and it is precisely the signal a WARM start never emits, which is what keeps the
// already-downloaded case untouched.
describe("deriveMicState — the preparing (voice-model download) state", () => {
  const progress = { done: 100_000_000, total: 482_000_000 };

  it("armed + a model download in flight → PREPARING (not the healthy-looking 'paused')", () => {
    expect(deriveMicState(true, "listening", "passive", progress)).toBe<MicState>("preparing");
  });

  it("preparing outranks ACTIVE: the model isn't there, so nothing can be dictated yet", () => {
    // Reachable: the user picks "Listening" from the mic pill mid-download, setting phase active
    // under the optimistic "listening" status. Claiming active here is the same lie in a new hat.
    expect(deriveMicState(true, "listening", "active", progress)).toBe<MicState>("preparing");
  });

  it("holds while the total is unknown (no content-length → total null)", () => {
    expect(deriveMicState(true, "listening", "passive", { done: 1, total: null })).toBe<MicState>(
      "preparing",
    );
  });

  it("mic OFF still wins over a download in flight (the user disarmed; nothing is preparing)", () => {
    expect(deriveMicState(false, "listening", "passive", progress)).toBe<MicState>("off");
  });

  // THE regression guard for the founder/warm-start path: model already on disk → the backend emits
  // no model-progress at all → every state must be exactly what it was before this state existed.
  it("WARM start (no progress events) is byte-for-byte the old behavior", () => {
    for (const status of STATUSES)
      for (const phase of PHASES) {
        // Passing null explicitly and omitting the argument must agree, so existing call sites that
        // never pass it can't drift from the ones that do.
        expect(deriveMicState(true, status, phase, null)).toBe(deriveMicState(true, status, phase));
        expect(deriveMicState(true, status, phase, null)).not.toBe<MicState>("preparing");
      }
    expect(deriveMicState(true, "listening", "active", null)).toBe<MicState>("active");
    expect(deriveMicState(true, "listening", "passive", null)).toBe<MicState>("paused");
  });

  it("download finishing (progress cleared) hands straight back to the normal states", () => {
    // dictation://level and ://partial null out modelProgress the moment capture really starts.
    expect(deriveMicState(true, "listening", "passive", null)).toBe<MicState>("paused");
    expect(deriveMicState(true, "listening", "active", null)).toBe<MicState>("active");
  });
});

describe("shouldBlockMicArm — the out-of-credits arm decision", () => {
  it("blocks arming when there is no signed-in user (anonymous trial has no credits)", () => {
    expect(shouldBlockMicArm(null)).toBe(true);
  });
  it("blocks arming at a zero (or negative) balance", () => {
    expect(shouldBlockMicArm(me(0))).toBe(true);
    expect(shouldBlockMicArm(me(-50))).toBe(true);
  });
  it("allows arming with a positive credit balance", () => {
    expect(shouldBlockMicArm(me(1))).toBe(false);
    expect(shouldBlockMicArm(me(500))).toBe(false);
  });
});

describe("showOutOfCreditsNotice — the refuse-to-arm effect + 5s auto-deactivate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useDictationStore.setState({ enabled: false, outOfCreditsNotice: false });
  });
  afterEach(() => {
    // Drop any pending timer and restore real timers so no countdown leaks into the next test.
    useDictationStore.getState().clearOutOfCreditsNotice();
    vi.useRealTimers();
  });

  it("shows the notice immediately and never arms the mic", () => {
    useDictationStore.getState().showOutOfCreditsNotice();
    expect(useDictationStore.getState().outOfCreditsNotice).toBe(true);
    expect(useDictationStore.getState().enabled).toBe(false);
  });

  it("after 5s: forces the mic off and clears the notice", () => {
    // Even if the mic were somehow on, the timer releases it.
    useDictationStore.setState({ enabled: true });
    useDictationStore.getState().showOutOfCreditsNotice();
    vi.advanceTimersByTime(OUT_OF_CREDITS_NOTICE_MS);
    expect(useDictationStore.getState().enabled).toBe(false);
    expect(useDictationStore.getState().outOfCreditsNotice).toBe(false);
  });

  it("each new attempt restarts the 5s countdown (no early clear)", () => {
    useDictationStore.getState().showOutOfCreditsNotice();
    vi.advanceTimersByTime(OUT_OF_CREDITS_NOTICE_MS - 1000); // 4s in
    useDictationStore.getState().showOutOfCreditsNotice(); // restart
    vi.advanceTimersByTime(OUT_OF_CREDITS_NOTICE_MS - 1000); // 4s since restart — still under 5s
    expect(useDictationStore.getState().outOfCreditsNotice).toBe(true);
    vi.advanceTimersByTime(1000); // now 5s since the restart
    expect(useDictationStore.getState().outOfCreditsNotice).toBe(false);
    expect(useDictationStore.getState().enabled).toBe(false);
  });

  it("refill-then-rearm within 5s is NOT force-disarmed (arm cancels the stale timer)", () => {
    // Refused → 5s timer armed.
    useDictationStore.getState().showOutOfCreditsNotice();
    vi.advanceTimersByTime(2000); // 2s later the user refills and successfully arms…
    // …which is exactly what the MicButton arm paths do on success: clear the notice, then enable.
    useDictationStore.getState().clearOutOfCreditsNotice();
    useDictationStore.setState({ enabled: true });
    // The originally-pending timer must NOT fire and disarm the now-legitimate mic.
    vi.advanceTimersByTime(OUT_OF_CREDITS_NOTICE_MS);
    expect(useDictationStore.getState().enabled).toBe(true);
    expect(useDictationStore.getState().outOfCreditsNotice).toBe(false);
  });

  it("clearOutOfCreditsNotice cancels the pending timer (no later flip)", () => {
    useDictationStore.setState({ enabled: true });
    useDictationStore.getState().showOutOfCreditsNotice();
    useDictationStore.getState().clearOutOfCreditsNotice();
    expect(useDictationStore.getState().outOfCreditsNotice).toBe(false);
    // The cancelled timer must not fire and force the mic off later.
    useDictationStore.setState({ enabled: true });
    vi.advanceTimersByTime(OUT_OF_CREDITS_NOTICE_MS * 2);
    expect(useDictationStore.getState().enabled).toBe(true);
  });
});
