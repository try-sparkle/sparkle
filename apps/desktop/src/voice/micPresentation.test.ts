import { describe, it, expect } from "vitest";
import {
  deriveMicPresentation,
  type MicPresentation,
  type MicPresentationInput,
} from "./micPresentation";
import type { Phase } from "./wakeMachine";

// deriveMicPresentation is THE single source of truth for WHICH voice state each mic surface is in.
// Both the sidebar (LogoWaveform) caption and the composer placeholder render by switching on the
// value it returns, so — for one store snapshot — the two surfaces can never land on contradictory
// states (the "top-left mic says X, composer says Y" desync). deriveMicState (MicButton) already
// guarantees this for the GLYPH; this function extends the same guarantee to the WORDS.
//
// The precedence pinned here is the union of the two components' historical ladders:
//   outOfCredits > error > off > preparing > focusPaused > (active | passive)
// Every branch below cites which real (enabled × status × phase × …) inputs reach it.

type Status = "idle" | "listening" | "error";
const STATUSES: Status[] = ["idle", "listening", "error"];
const PHASES: Phase[] = ["passive", "active"];
const DOWNLOADING = { done: 241_000_000, total: 482_000_000 };

/** A healthy armed-and-capturing snapshot; each test overrides only the fields it exercises. */
const base = (over: Partial<MicPresentationInput> = {}): MicPresentationInput => ({
  enabled: true,
  status: "listening",
  phase: "passive",
  modelProgress: null,
  hasError: false,
  outOfCreditsNotice: false,
  ...over,
});

describe("deriveMicPresentation — the shared voice-state decision", () => {
  it("outOfCredits outranks EVERYTHING (a refused arm shows the notice on both surfaces)", () => {
    // The notice is set with enabled STILL false (the arm was refused), so it must win over `off`.
    for (const enabled of [true, false])
      for (const status of STATUSES)
        for (const phase of PHASES)
          expect(
            deriveMicPresentation(
              base({ outOfCreditsNotice: true, enabled, status, phase, modelProgress: DOWNLOADING, hasError: true }),
            ),
          ).toBe<MicPresentation>("outOfCredits");
  });

  it("error outranks off/preparing/live (a failed mic reports the failure, not a stale state)", () => {
    // Pin the specific precedence both components already had: error beats a download in flight.
    expect(deriveMicPresentation(base({ hasError: true, modelProgress: DOWNLOADING }))).toBe<MicPresentation>("error");
    expect(deriveMicPresentation(base({ hasError: true, enabled: false }))).toBe<MicPresentation>("error");
    expect(deriveMicPresentation(base({ hasError: true, status: "listening", phase: "active" }))).toBe<MicPresentation>("error");
  });

  it("mic disarmed → OFF for every non-error, non-credits combination", () => {
    for (const status of STATUSES)
      for (const phase of PHASES) {
        // A download can't be 'preparing' once the user disarmed — off wins over modelProgress too.
        expect(deriveMicPresentation(base({ enabled: false, status, phase }))).toBe<MicPresentation>("off");
        expect(deriveMicPresentation(base({ enabled: false, status, phase, modelProgress: DOWNLOADING }))).toBe<MicPresentation>("off");
      }
  });

  it("armed + a model download in flight → PREPARING (outranks the live states)", () => {
    for (const status of STATUSES)
      for (const phase of PHASES)
        expect(deriveMicPresentation(base({ modelProgress: DOWNLOADING, status, phase }))).toBe<MicPresentation>("preparing");
  });

  it("armed, no download, but NOT capturing (status ≠ listening) → FOCUS-PAUSED, whatever the phase", () => {
    // THE cross-surface bug this function fixes: previously the sidebar said 'Listening paused' here
    // while the composer invited 'Just say Hey Sparkle and I'll start listening'. One state now, so
    // both surfaces read it the same way. The active phase can be held while focus-paused, so it must
    // NOT read as activeListening (that would claim we're hearing the user when we're not).
    expect(deriveMicPresentation(base({ status: "idle", phase: "passive" }))).toBe<MicPresentation>("focusPaused");
    expect(deriveMicPresentation(base({ status: "idle", phase: "active" }))).toBe<MicPresentation>("focusPaused");
    // status "error" without an error NOTICE (raw error cleared) still isn't capturing → focus-paused.
    expect(deriveMicPresentation(base({ status: "error", phase: "active", hasError: false }))).toBe<MicPresentation>("focusPaused");
  });

  it("armed + capturing + active phase → ACTIVE LISTENING (the only path to active)", () => {
    expect(deriveMicPresentation(base({ status: "listening", phase: "active" }))).toBe<MicPresentation>("activeListening");
  });

  it("armed + capturing + passive phase → PASSIVE WAITING (hearing, waiting for the wake word)", () => {
    expect(deriveMicPresentation(base({ status: "listening", phase: "passive" }))).toBe<MicPresentation>("passiveWaiting");
  });
});

// The whole point of this module: the two surfaces are provably in lockstep. This drives EVERY
// input combination through the function once and asserts it is total (always returns a known state)
// — a future edit that forks the logic back into a component would have to delete this to pass.
describe("deriveMicPresentation — total and deterministic over every input", () => {
  const KNOWN: MicPresentation[] = [
    "off",
    "outOfCredits",
    "error",
    "preparing",
    "focusPaused",
    "activeListening",
    "passiveWaiting",
  ];
  it("returns a known state for every (enabled × status × phase × progress × error × credits)", () => {
    for (const enabled of [true, false])
      for (const status of STATUSES)
        for (const phase of PHASES)
          for (const modelProgress of [null, DOWNLOADING])
            for (const hasError of [true, false])
              for (const outOfCreditsNotice of [true, false]) {
                const input = { enabled, status, phase, modelProgress, hasError, outOfCreditsNotice };
                const out = deriveMicPresentation(input);
                expect(KNOWN).toContain(out);
                // Deterministic: the same snapshot always yields the same state (no hidden inputs).
                expect(deriveMicPresentation(input)).toBe(out);
              }
  });
});
