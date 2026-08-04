import { describe, it, expect } from "vitest";
import {
  deriveMicPresentation,
  micCaptionKind,
  micIndicatorFor,
  MIC_INDICATOR_LABEL,
  type MicIndicatorInput,
  type MicPresentation,
  type MicPresentationInput,
} from "./micPresentation";
import { micIntentForMode, SEND_MODES, type SendMode } from "./sendMode";
import { micVisual } from "../components/MicButton";
import { C } from "../theme/colors";
import type { Phase } from "./dictationPhase";

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

  it("armed + capturing + passive phase → PASSIVE WAITING (hearing, routing nothing)", () => {
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
/** A healthy mic that agrees with whatever position is being tested: armed, capturing, no download.
 *  `phase` is deliberately `active` in the default so the routing case is the DEFAULT rather than
 *  a special one — the derivation must not consult it except where documented. */
/** Every distinct focus situation the indicator must be total over: not in a terminal, in one that
 *  is paused, and in one that is actively receiving the phrase. */
const FOCUS_CASES: Partial<MicIndicatorInput>[] = [
  { focusOwner: "other" },
  { focusOwner: "terminal", terminalRoutes: false },
  { focusOwner: "terminal", terminalRoutes: true },
];

const live = (over: Partial<MicIndicatorInput> = {}): MicIndicatorInput => ({
  enabled: true,
  status: "listening",
  phase: "active",
  modelProgress: null,
  ...over,
});

describe("micIndicatorFor — the tray position, with the hardware able only to DEMOTE it", () => {
  it("Speak + capturing → a live open mic in the left-column GREEN", () => {
    expect(micVisual(micIndicatorFor("speak", live()).state, false)).toEqual({
      color: C.successInk,
      variant: "open",
    });
  });

  it("Push to talk → the mic + pause bars in the SAME amber the tray's ptt pill uses", () => {
    expect(micVisual(micIndicatorFor("ptt", live()).state, false)).toEqual({
      color: C.amber,
      variant: "pause",
    });
  });

  it("Send + a released mic → OFF: slashed glyph, muted grey", () => {
    expect(micVisual(micIndicatorFor("send", live({ enabled: false })).state, false)).toEqual({
      color: C.muted,
      variant: "slash",
    });
  });

  it("the three positions produce three DISTINCT colours (so 'they agree' is falsifiable)", () => {
    // Without this, a mapping that collapsed every position onto one colour would satisfy each
    // assertion above only by luck of which constant it collapsed to — and a future retune that
    // made two tokens equal would make all three of them vacuous at once.
    const colors = SEND_MODES.map(
      (m) => micVisual(micIndicatorFor(m, live({ enabled: m !== "send" })).state, false).color,
    );
    expect(new Set(colors).size).toBe(3);
  });

  it("the accessible name describes a STATE, and comes from the same value as the glyph", () => {
    // The indicator is not a control, so a name like "Pause listening" would promise an action
    // nothing performs. Keyed off the derived state, so the words and the glyph cannot disagree.
    for (const mode of SEND_MODES)
      for (const enabled of [true, false])
        for (const status of STATUSES)
          for (const modelProgress of [null, DOWNLOADING]) {
            const { state, label } = micIndicatorFor(
              mode,
              live({ enabled, status, modelProgress }),
            );
            expect(label).toBe(MIC_INDICATOR_LABEL[state]);
            expect(label).not.toMatch(/^(turn|pause|set|click)/i);
            // Only the live-mic state may claim we are hearing the user — in EVERY combination.
            expect(/actively listening/i.test(label)).toBe(state === "active");
          }
  });

  it("a corrupt persisted position fails CLOSED — it never draws a live mic", () => {
    // Inherited from micIntentForMode, and worth pinning at this layer too: an indicator is what a
    // user checks before speaking, so a value nobody recognises must read OFF, not green.
    const bogus = "wat" as SendMode;
    expect(micVisual(micIndicatorFor(bogus, live({ enabled: false })).state, false)).toEqual({
      color: C.muted,
      variant: "slash",
    });
  });

  // ── THE DEMOTIONS. Each is a state where the position is not a true statement about the mic. ──

  it("Push to talk stays AMBER when the phase is active — the original defect", () => {
    // `live()` already has `phase: "active"` and `status: "listening"`, i.e. something has
    // fired with nothing about the tray having changed. Green here is what this whole change exists
    // to prevent, and no demotion may accidentally re-enable it.
    expect(micVisual(micIndicatorFor("ptt", live()).state, false)).toEqual({
      color: C.amber,
      variant: "pause",
    });
  });

  it("Speak with capture NOT live → amber, never the green 'we are hearing you' mic", () => {
    // Focus-paused (`idle`) and a backend failure (`error`) both leave the tray on Speak while
    // nothing is being captured; the caption beside the ring says "Listening paused…" / shows the
    // error notice, and a green mic above it would be arguing with it.
    for (const status of ["idle", "error"] as const) {
      const { state, label } = micIndicatorFor("speak", live({ status }));
      expect(micVisual(state, false)).toEqual({ color: C.amber, variant: "pause" });
      expect(label).not.toMatch(/actively listening/i);
    }
  });

  it("a model download outranks EVERY position — download glyph, not a mic shape", () => {
    // MicButton documents the `loading` variant as deliberately not a mic shape "so it cannot be
    // mistaken for a ready mic at a glance". Deriving from the position alone lost it, painting the
    // green live mic under a caption reading "Setting up voice (50%)".
    for (const mode of SEND_MODES) {
      if (micIntentForMode(mode) === "off") continue; // covered by the armed-elsewhere case below
      const { state, label } = micIndicatorFor(mode, live({ modelProgress: DOWNLOADING }));
      expect(micVisual(state, false)).toEqual({ color: C.muted, variant: "loading" });
      expect(label).toMatch(/setting up voice/i);
    }
  });

  it("Send + a mic armed ELSEWHERE reports the mic, not the position", () => {
    // useSendMode's reconcile deliberately stands down here rather than switching off a mic the
    // user armed somewhere else, and `dictationStore` persists `{enabled, phase}` while
    // `conciergeSendMode` defaults to `send` — so this survives a relaunch. Drawing "Microphone:
    // off" over a live capture (beside a waveform strip sweeping with real audio) is the indicator
    // affirmatively denying the hardware, which is worse than the desync it replaced.
    const dictating = micIndicatorFor("send", live());
    expect(micVisual(dictating.state, false)).toEqual({ color: C.successInk, variant: "open" });
    expect(dictating.label).toMatch(/actively listening/i);

    // …and it reports the mic HONESTLY, not just "on": armed but waiting reads amber.
    const waiting = micIndicatorFor("send", live({ phase: "passive" }));
    expect(micVisual(waiting.state, false)).toEqual({ color: C.amber, variant: "pause" });
    expect(waiting.label).not.toMatch(/actively listening/i);
  });

  it("ONLY Speak — or a mic the tray does not govern — can ever reach the green mic", () => {
    // The directional invariant that keeps the original fix intact while the demotions exist: no
    // hardware input may PROMOTE a position. Sweeping every combination, a green ring implies
    // either the tray said Speak or the tray had released the mic and something else armed it.
    for (const mode of SEND_MODES)
      for (const enabled of [true, false])
        for (const status of STATUSES)
          for (const phase of PHASES)
            for (const modelProgress of [null, DOWNLOADING])
              // The focus dimension, so the new terminal branch is INSIDE the invariant rather than
              // outside it (roborev 56699). Both terminal states are swept: a paused one must never
              // reach green, and a routing one must reach it only on the same terms as anywhere else.
              for (const focus of FOCUS_CASES) {
              const { state } = micIndicatorFor(mode, {
                enabled,
                status,
                phase,
                modelProgress,
                ...focus,
              });
              if (state !== "active") continue;
              // A green ring in a terminal is only honest when that terminal is RECEIVING.
              if (focus.focusOwner === "terminal") expect(focus.terminalRoutes).toBe(true);
              // Capture must be genuinely live in EVERY green case — that is the floor.
              expect(status).toBe("listening");
              // And the green came from one of exactly two places: the tray said Speak, or the tray
              // had released the mic and something else armed it into the active phase. `phase` is
              // consulted ONLY on that second path — on the Speak path it is deliberately ignored,
              // since reading it is what let the phase repaint a position the user had chosen.
              expect(
                mode === "speak" || (micIntentForMode(mode) === "off" && enabled && phase === "active"),
              ).toBe(true);
            }
  });

  it("is total over every (position × hardware) combination", () => {
    const KNOWN = ["off", "paused", "preparing", "active"];
    for (const mode of [...SEND_MODES, "wat" as SendMode])
      for (const enabled of [true, false])
        for (const status of STATUSES)
          for (const phase of PHASES)
            for (const modelProgress of [null, DOWNLOADING])
              for (const focus of FOCUS_CASES) {
                const out = micIndicatorFor(mode, {
                  enabled,
                  status,
                  phase,
                  modelProgress,
                  ...focus,
                });
                expect(KNOWN).toContain(out.state);
                expect(out.label).toBe(MIC_INDICATOR_LABEL[out.state]);
              }
  });
});

describe("micCaptionKind — the caption takes the SAME one input as the glyph", () => {
  // THE DEFECT THIS TABLE CAUSED, pinned as its own case. `ptt` used to fall through to
  // `"wakeInvite"` because there were only two kinds and Speak owned one of them — so push-to-talk
  // borrowed Speak's OPPOSITE and the founder was shown wake-word copy in a mode that never had a
  // wake word. This assertion fails against that version by construction: `"pushToTalk"` did not
  // exist as a MicCaptionKind member.
  it("EVERY armed position names ITSELF — push to talk no longer borrows Speak's opposite", () => {
    expect(micCaptionKind("speak")).toBe("dictating");
    expect(micCaptionKind("ptt")).toBe("pushToTalk");
    expect(micCaptionKind("send")).toBe("none");
  });

  // The structural version of the same thing: no two armed positions may share a kind. That is what
  // makes "a caption describing the wrong mode" unreachable rather than merely absent today.
  it("no two armed positions share a caption kind", () => {
    const armed = SEND_MODES.filter((m) => micIntentForMode(m) !== "off");
    const kinds = armed.map(micCaptionKind);
    expect(new Set(kinds).size).toBe(armed.length);
    expect(kinds).not.toContain("none");
  });

  it("says 'we are hearing you' in EXACTLY the position whose glyph is green, and no other", () => {
    // The invariant, stated as one expression, with the hardware AGREEING with each position — the
    // state in which no demotion applies. The caption promises dictation iff the indicator is
    // drawing the live mic. Two tables that happened to agree today would pass the case-by-case
    // assertions above; this fails the moment they diverge for any position.
    for (const mode of SEND_MODES) {
      const agreeing = live({ enabled: micIntentForMode(mode) !== "off" });
      expect(micCaptionKind(mode) === "dictating").toBe(
        micIndicatorFor(mode, agreeing).state === "active",
      );
    }
  });

  it("a corrupt persisted position promises nothing", () => {
    expect(micCaptionKind("wat" as SendMode)).toBe("none");
  });
});

describe("a terminal draws the SAME grey off glyph as Send", () => {
  // ── THE FOUNDER'S RULE, AND WHY IT IS NOT THE `status` DEMOTION ────────────────────────────────
  // "When listening is paused because my caret is in a terminal, the mic must show the gray off
  // icon — the microphone with a line struck through it — EXACTLY as it does in Send mode."
  //
  // The hardware demotion lands on "paused" (amber), which is right for a mic that is armed and
  // merely between utterances and WRONG for one whose words are going nowhere. What he needs from
  // this glyph is binary: is the mic taking my voice or not. The reason still gets said in the
  // caption underneath.
  it("renders Speak-in-a-terminal identically to Send", () => {
    const inTerminal = micIndicatorFor("speak", live({ focusOwner: "terminal" }));
    const send = micIndicatorFor("send", { ...live(), enabled: false });
    // Asserted AGAINST EACH OTHER, not against the literal "off": the requirement is SAMENESS, so a
    // future change to what Send draws must drag this with it or fail here.
    expect(inTerminal.state).toBe(send.state);
    expect(inTerminal.state).toBe("off");
    expect(micVisual(inTerminal.state, false)).toEqual(micVisual(send.state, false));
  });

  it("takes every position to off ONLY when the wake gate is shut", () => {
    // ── THE SPLIT THIS ROW USED TO MISS (roborev 56699) ─────────────────────────────────────────
    // The earlier version asserted "off" for `live({ focusOwner: "terminal" })` — but `live()`
    // defaults to enabled + listening + phase "active", which IS `terminalRoutingArmed`. So it
    // asserted the demotion for the one terminal state where the mic IS feeding a destination, and
    // pinned the bug instead of catching it.
    //
    // Paused-in-a-terminal is the wake gate SHUT. Each of the three ways it shuts, independently.
    const shut = [
      { phase: "passive" as const },
      { enabled: false },
      { status: "error" as const },
    ];
    for (const mode of ["send", "ptt", "speak"] as const) {
      for (const gate of shut) {
        expect(
          micIndicatorFor(mode, live({ focusOwner: "terminal", terminalRoutes: false, ...gate }))
            .state,
        ).toBe("off");
      }
    }
  });

  it("reports the mic HONESTLY when the terminal is receiving the phrase", () => {
    // A routing terminal is NOT paused. `useDictation` types committed phrases into it, `armedStatus`
    // keeps status "listening", `dictationPauseReason` returns null — so a grey "Microphone: off"
    // ring here would sit directly under the live "Actively listening" caption, over a sweeping
    // waveform, denying hardware that is transcribing the user's speech at that moment.
    const routing = live({ focusOwner: "terminal", terminalRoutes: true });
    expect(micIndicatorFor("speak", routing).state).toBe("active");
    // …and it matches what the SAME position reports with no terminal involved, which is the point:
    // routing changes where the words go, not whether the mic is taking them.
    expect(micIndicatorFor("speak", routing).state).toBe(micIndicatorFor("speak", live()).state);
  });

  it("still lets a model download outrank the caret", () => {
    // Ordering check: an in-flight download is a truer thing to say about the microphone than where
    // the caret happens to be, so `preparing` is evaluated first.
    expect(
      micIndicatorFor("speak", live({ focusOwner: "terminal", modelProgress: { done: 1, total: 2 } }))
        .state,
    ).toBe("preparing");
  });

  it("leaves every position alone when the caret is anywhere else", () => {
    // The guard against over-correcting: "other" includes NOTHING FOCUSED AT ALL, which is the
    // flagship hands-free case. Pausing there would kill wake-word dictation outright.
    for (const mode of ["send", "ptt", "speak"] as const) {
      expect(micIndicatorFor(mode, live({ focusOwner: "other" })).state).toBe(
        micIndicatorFor(mode, live()).state,
      );
    }
  });
});
