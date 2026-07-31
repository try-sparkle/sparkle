import { describe, it, expect } from "vitest";
import {
  deriveMicPresentation,
  micCaptionKind,
  micIndicatorForMode,
  MIC_INDICATOR_LABEL,
  type MicPresentation,
  type MicPresentationInput,
} from "./micPresentation";
import { micIntentForMode } from "./sendMode";
import { SEND_MODES, type SendMode } from "./sendMode";
import { micVisual } from "../components/MicButton";
import { C } from "../theme/colors";
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

// ---------------------------------------------------------------------------
// The mic INDICATOR: the send tray's position, drawn as a mic
// ---------------------------------------------------------------------------
//
// The tray is the only mic control in the concierge column, so the indicator has to be a read-out
// of it. These assert the DERIVED OUTPUT for each of the three positions — the colour and glyph the
// ring actually paints, and the words the caption actually shows — not that some intermediate
// mapping was consulted.
//
// The colours are pulled through `micVisual`, the same table SendModeTray paints its own pills
// from (its MODE_COLOR is `C.amber` for ptt and `C.successInk` for speak, and its comment says so).
// That is what makes "the mic and the slider are the same green" a fact rather than a coincidence:
// if either table is retuned alone, this goes red.
describe("micIndicatorForMode — the mic indicator IS the tray position", () => {
  it("Speak → a live open mic in the left-column GREEN", () => {
    const { state } = micIndicatorForMode("speak");
    expect(micVisual(state, false)).toEqual({ color: C.successInk, variant: "open" });
  });

  it("Push to talk → the mic + pause bars in the SAME amber the tray's ptt pill uses", () => {
    const { state } = micIndicatorForMode("ptt");
    expect(micVisual(state, false)).toEqual({ color: C.amber, variant: "pause" });
  });

  it("Send → the mic is OFF: slashed glyph, muted grey", () => {
    const { state } = micIndicatorForMode("send");
    expect(micVisual(state, false)).toEqual({ color: C.muted, variant: "slash" });
  });

  it("the three positions produce three DISTINCT colours (so 'they agree' is falsifiable)", () => {
    // Without this, a mapping that collapsed every position onto one colour would satisfy each
    // assertion above only by luck of which constant it collapsed to — and a future retune that
    // made two tokens equal would make all three of them vacuous at once.
    const colors = SEND_MODES.map((m) => micVisual(micIndicatorForMode(m).state, false).color);
    expect(new Set(colors).size).toBe(3);
  });

  it("the accessible name describes a STATE, and comes from the same value as the glyph", () => {
    // The indicator is not a control, so a name like "Pause listening" would promise an action
    // nothing performs. Keyed off the derived state, so the words and the glyph cannot disagree.
    for (const mode of SEND_MODES) {
      const { state, label } = micIndicatorForMode(mode);
      expect(label).toBe(MIC_INDICATOR_LABEL[state]);
      expect(label).not.toMatch(/^(turn|pause|set|click)/i);
    }
    expect(micIndicatorForMode("speak").label).toMatch(/actively listening/i);
    expect(micIndicatorForMode("ptt").label).toMatch(/push to talk/i);
    expect(micIndicatorForMode("send").label).toMatch(/off/i);
  });

  it("a corrupt persisted position fails CLOSED — it never draws a live mic", () => {
    // Inherited from micIntentForMode, and worth pinning at this layer too: an indicator is what a
    // user checks before speaking, so a value nobody recognises must read OFF, not green.
    const bogus = "wat" as SendMode;
    expect(micVisual(micIndicatorForMode(bogus).state, false)).toEqual({
      color: C.muted,
      variant: "slash",
    });
  });
});

describe("micCaptionKind — the caption takes the SAME one input as the glyph", () => {
  it("Speak invites the stop phrase; Push to talk invites the wake phrase; Send says nothing", () => {
    expect(micCaptionKind("speak")).toBe("dictating");
    expect(micCaptionKind("ptt")).toBe("wakeInvite");
    expect(micCaptionKind("send")).toBe("none");
  });

  it("says 'we are hearing you' in EXACTLY the position whose glyph is green, and no other", () => {
    // The invariant, stated as one expression: the caption promises dictation iff the indicator is
    // drawing the live mic. Two tables that happened to agree today would pass the case-by-case
    // assertions above; this fails the moment they diverge for any position.
    for (const mode of SEND_MODES)
      expect(micCaptionKind(mode) === "dictating").toBe(
        micIndicatorForMode(mode).state === "active",
      );
  });

  it("a corrupt persisted position promises nothing", () => {
    expect(micCaptionKind("wat" as SendMode)).toBe("none");
  });
});

describe("a terminal draws the SAME grey off glyph as Send", () => {
  // ── THE FOUNDER'S RULE ────────────────────────────────────────────────────────────────────────
  // "When listening is paused because my caret is in a terminal, the mic must show the gray off
  // icon — the microphone with a line struck through it — EXACTLY as it does in Send mode."
  //
  // The reasoning is that focus-paused means nothing is being captured, which is functionally
  // identical to Send from where he sits, so a third "paused" treatment invents a state he has to
  // learn in order to conclude the same thing. What he needs is binary.
  it("renders Speak-in-a-terminal identically to Send", () => {
    const inTerminal = micIndicatorForMode("speak", "terminal");
    const send = micIndicatorForMode("send", "other");
    // ASSERTED AGAINST EACH OTHER, not against the literal "off": the requirement is SAMENESS, so a
    // future change to what Send draws must drag this with it or fail here.
    expect(inTerminal.state).toBe(send.state);
    expect(inTerminal.state).toBe("off");
  });

  it("takes EVERY position to off in a terminal — the glyph tracks capture, not the tray", () => {
    // The bug this pins: Speak keeps its `active` intent while the routing gate has already stopped
    // the composer route, so a position-only reading painted a live green mic over a pipeline that
    // was not feeding this box at all.
    for (const mode of ["send", "ptt", "speak"] as const) {
      expect(micIndicatorForMode(mode, "terminal").state).toBe("off");
    }
  });

  it("leaves every position alone when the caret is anywhere else", () => {
    // The guard against over-correcting: "other" includes NOTHING FOCUSED AT ALL, which is the
    // flagship hands-free case. Pausing there would kill wake-word dictation outright.
    for (const mode of ["send", "ptt", "speak"] as const) {
      expect(micIndicatorForMode(mode, "other").state).toBe(micIntentForMode(mode));
    }
  });
});
