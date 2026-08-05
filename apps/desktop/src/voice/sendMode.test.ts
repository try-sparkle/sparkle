// The send tray's rules, tested where they live — no DOM, no rendering.
//
// The width threshold's correctness is
// arithmetic over the tray's geometry (padding, border, gaps, the keycap slot), and re-spelling
// those numbers here is exactly the defect roborev 56213 caught — a copied literal goes stale and
// the bound silently stops bounding anything. So it is imported from ./Concierge/trayGeometry, a
// LEAF module with no React: this file runs under node, and importing the component (or Workspace)
// to read a few integers would make a pure logic test hostage to any module-scope `document` added
// anywhere in that graph (roborev 56223).
//
// Every row here asserts a rule the app did NOT have before the tray shipped: there was a Send
// button and a boolean auto-send switch, so there was no "position", no mode→microphone mapping, no
// clamp, no per-mode chord, and no chiclet. None of these functions existed to be called.
import { describe, expect, it } from "vitest";

import { CONFIDENCE_THRESHOLD_MS } from "./confidence";
import {
  fullLabelsFitAtPx,
  trayFullNoChicletMinPx,
  trayShortNoChicletMinPx,
  trayShortTightMinPx,
} from "../components/Concierge/trayGeometry";
import {
  SEND_MODES,
  SEND_MODE_LABEL,
  SEND_MODE_LABEL_SHORT,
  SWEEP_FLOOR_MS,
  TALK_KEY_GLYPH,
  pttHeldIntent,
  TRAY_SHORT_LABEL_MAX_PX,
  TRAY_FULL_NO_CHICLET_MIN_PX,
  TRAY_SHORT_NO_CHICLET_MIN_PX,
  TRAY_SHORT_TIGHT_MIN_PX,
  trayShowsChiclet,
  trayShowsWords,
  trayDensityFor,
  chicletFor,
  chordSends,
  micIntentForMode,
  modeCountsDown,
  stepSendMode,
  shortLabelsAreContainedInFullLabels,
  sweepThresholdMs,
  trayInert,
  trayLabelFor,
  type SendMode,
} from "./sendMode";

describe("the tray's three positions", () => {
  it("reads left to right as Send · Push to talk · Speak", () => {
    // The array IS the reading order AND the arrow-key order — `stepSendMode` walks it. Pinning the
    // order here is what stops a reorder from silently re-aiming every arrow keypress.
    expect(SEND_MODES).toEqual(["send", "ptt", "speak"]);
  });

  it("steps one position at a time", () => {
    expect(stepSendMode("send", 1)).toBe("ptt");
    expect(stepSendMode("ptt", 1)).toBe("speak");
    expect(stepSendMode("speak", -1)).toBe("ptt");
    expect(stepSendMode("ptt", -1)).toBe("send");
  });

  it("CLAMPS at both ends — one extra keypress can never flip Send to Speak", () => {
    // THE REASON, not a boundary nicety. Wrapping would put the two most opposite states in this
    // feature — microphone off with nothing listening, and microphone live and auto-sending — one
    // keypress apart, with the overshoot that produced it invisible. Clamping makes an overshoot
    // harmless, which is what every other slider in the world does.
    expect(stepSendMode("send", -1)).toBe("send");
    expect(stepSendMode("speak", 1)).toBe("speak");
    // Held down: still parked at the end, never wrapped round to the other one.
    let m: SendMode = "speak";
    for (let i = 0; i < 5; i++) m = stepSendMode(m, 1);
    expect(m).toBe("speak");
  });
});

describe("the position IS the microphone", () => {
  it("Send AND Push to talk both release the mic; only Speak takes it live", () => {
    // PUSH TO TALK RESTS RELEASED (sparkle-u81cz). It rested at "paused" until the founder reported
    // the mic "gray but LISTENING" between holds — and "paused" is not a weaker "off": useSendMode
    // maps it to `setMuted`, which ARMS (`setEnabled(true)`). So the resting position of
    // push-to-talk was a live, capturing microphone. The hold is now the only thing that opens it.
    expect(micIntentForMode("send")).toBe("off");
    expect(micIntentForMode("ptt")).toBe("off");
    expect(micIntentForMode("speak")).toBe("active");
  });

  it("the HOLD is what opens the mic — and it is the only position whose two states differ", () => {
    // The other half of the fix, and what stops "ptt rests off" from meaning "ptt is just Send":
    // the resting intent releases, the held intent goes live. Asserted as a RELATIONSHIP so a
    // change that collapsed push-to-talk onto Send entirely would fail here rather than pass.
    expect(micIntentForMode("ptt")).toBe("off");
    expect(pttHeldIntent()).toBe("active");
    expect(pttHeldIntent()).not.toBe(micIntentForMode("ptt"));
  });

  it("an UNRECOGNISED position releases the mic — it never fails open into a live one", () => {
    // A corrupt, partial-rollout or hand-edited persisted blob can hand this a value outside the
    // union. The fall-through direction is not a style choice: defaulting to "active" would take the
    // microphone live on a value nobody recognises — spending credits and capturing audio — with no
    // pill reading selected to explain it. (composerPersist also coerces on rehydrate; two guards,
    // because one guard for "spends credits and captures audio" is one too few.)
    expect(micIntentForMode("nonsense" as SendMode)).toBe("off");
    expect(micIntentForMode(undefined as unknown as SendMode)).toBe("off");
  });

  it("every position maps to a mic intent — no position can leave the mic undecided", () => {
    // A position with no mapping is how the tray and the mic glyph end up telling different stories
    // about the same microphone, which is the whole defect this control was built to delete.
    for (const m of SEND_MODES) {
      expect(["off", "paused", "active"]).toContain(micIntentForMode(m));
    }
  });
});

describe("only Speak counts down", () => {
  it("Send sends on a press and Push to talk sends on a release, so neither runs a clock", () => {
    // A timer in Push to talk would make the DELIBERATE mode feel laggier than the automatic one,
    // which inverts the reason both exist.
    expect(modeCountsDown("speak")).toBe(true);
    expect(modeCountsDown("ptt")).toBe(false);
    expect(modeCountsDown("send")).toBe(false);
  });

  it("the sweep never runs faster than one second, whatever the ladder says", () => {
    // The floor is a PROMISE, not a description of today's ladder. It used to be exactly binding
    // (the fastest rung was 1s); after the founder's 1.2x pacing the fastest rung is 1200ms, so the
    // clamp is now slack on every tier — which is the safe direction and worth stating as such. A
    // sweep shorter than a second is not a countdown, it is a flicker between two frames.
    expect(sweepThresholdMs("high")).toBe(CONFIDENCE_THRESHOLD_MS.high);
    expect(CONFIDENCE_THRESHOLD_MS.high).toBeGreaterThanOrEqual(SWEEP_FLOOR_MS);
    expect(sweepThresholdMs("normal")).toBe(CONFIDENCE_THRESHOLD_MS.normal);
    expect(sweepThresholdMs("verylow")).toBe(CONFIDENCE_THRESHOLD_MS.verylow);
    for (const tier of ["high", "normal", "low", "verylow"] as const) {
      expect(sweepThresholdMs(tier)).toBeGreaterThanOrEqual(SWEEP_FLOOR_MS);
    }
  });
});

describe("inert means NOT ADDRESSED, and is decided by who OWNS focus", () => {
  it("a terminal takes the tray inert; everything else — including nothing at all — does not", () => {
    // `FocusOwner`'s "other" is anything that is not a live PTY, INCLUDING no focused element. That
    // is the distinction that keeps the tray usable: keying on "is the composer focused" instead
    // greys it for every focus move the app's own chrome causes, because `focusin` fires before a
    // button's own click handler — the control would boot grey and no button could arm it.
    expect(trayInert("terminal")).toBe(true);
    expect(trayInert("other")).toBe(false);
  });
});

describe("the keycap chip cannot lie about the keystroke", () => {
  it("⌘↩ sends under the ⌘↩ setting; a bare ↩ does not", () => {
    expect(chordSends("send", "cmd-enter", { key: "Enter", metaKey: true })).toBe(true);
    expect(chordSends("send", "cmd-enter", { key: "Enter", ctrlKey: true })).toBe(true);
    expect(chordSends("send", "cmd-enter", { key: "Enter" })).toBe(false);
  });

  it("a bare ↩ sends under the ↩ setting, and ⇧↩ is a newline in both", () => {
    expect(chordSends("send", "enter", { key: "Enter" })).toBe(true);
    expect(chordSends("send", "enter", { key: "Enter", shiftKey: true })).toBe(false);
    expect(chordSends("send", "cmd-enter", { key: "Enter", metaKey: true, shiftKey: true })).toBe(false);
  });

  it("⌘↩ ALSO sends in Push to talk — the chord and the hold are both send paths", () => {
    // REVERSED by the founder (sparkle-u81cz): "I can tap the command key to have what I typed
    // send, but I could also type command enter, and that would also send it." This used to assert
    // the opposite — that nothing sends by chord in this mode.
    //
    // It does not double-send, and the guard is in usePushToTalk rather than here: a second key
    // arriving mid-hold ABANDONS the hold (it was a chord, not speech), so ⌘↩ produces exactly one
    // send, from the composer. ComposeBox.test.tsx pins that COUNT at the surface that submits.
    expect(chordSends("ptt", "cmd-enter", { key: "Enter", metaKey: true })).toBe(true);
    expect(chordSends("ptt", "cmd-enter", { key: "Enter", ctrlKey: true })).toBe(true);
    expect(chordSends("ptt", "enter", { key: "Enter" })).toBe(true);
    // The exclusions still hold in this mode: ⇧↩ is a newline, and a bare ↩ does not send under
    // the ⌘↩ setting (the mention picker owns it).
    expect(chordSends("ptt", "cmd-enter", { key: "Enter", metaKey: true, shiftKey: true })).toBe(false);
    expect(chordSends("ptt", "cmd-enter", { key: "Enter" })).toBe(false);
  });

  it("every position now honours the SAME send chord — none refuses it", () => {
    // The generalisation of the case above: `chordSends` no longer branches on the mode at all, so
    // a future position cannot silently inherit a refusal. Asserted across SEND_MODES so adding one
    // is what fails here, not a hand-listed trio.
    for (const mode of SEND_MODES)
      expect(chordSends(mode, "cmd-enter", { key: "Enter", metaKey: true })).toBe(true);
  });

  it("the chip shows the chord the handler honours, and ⌘ where ⌘ means talk", () => {
    // The two halves of the same fact: whatever `chordSends` accepts is what `chicletFor` draws.
    expect(chicletFor("send", "cmd-enter")).toBe("⌘↩");
    expect(chicletFor("speak", "cmd-enter")).toBe("⌘↩");
    expect(chicletFor("send", "enter")).toBe("↩");
    expect(chicletFor("ptt", "cmd-enter")).toBe("⌘");
    expect(chicletFor("ptt", "enter")).toBe("⌘");
  });

  it("a chip never advertises a SEND chord its own mode refuses", () => {
    // The vacuous-test guard for the pair above: this asserts the RELATIONSHIP rather than two
    // independent literals, so changing one function without the other fails here.
    //
    // REPHRASED for sparkle-u81cz. It used to require the converse as well — that a "⌘" chip
    // implied `chordSends` was FALSE — which was true only while Push to talk refused the chord.
    // Now that ⌘↩ sends everywhere, that clause would fail on a mode whose chip is honest: the
    // push-to-talk chip names the TALK key (hold it), not a send chord, and ⌘↩ sending as well
    // does not make "⌘" a lie. What must never happen is a chip naming a send chord that is inert,
    // which is the direction that misleads — so that is the direction asserted.
    for (const mode of SEND_MODES) {
      for (const chord of ["cmd-enter", "enter"] as const) {
        const cap = chicletFor(mode, chord);
        // The talk-key chip makes no claim about ↩, so there is no send chord to hold it to.
        if (cap === TALK_KEY_GLYPH) continue;
        const press =
          chord === "cmd-enter" ? { key: "Enter", metaKey: true } : { key: "Enter" };
        expect(chordSends(mode, chord, press), `${mode}/${chord} chip "${cap}"`).toBe(true);
      }
    }
  });

  // ── THE NARROW TRAY ────────────────────────────────────────────────────────────────────────
  // The founder's report: a narrow concierge column drew the tray as "S… P… S…". The pills are
  // `flex: 1`, so the longest label sets the pressure for all three and they ellipsize together.
  // The fix picks a shorter WORD instead of clipping, and this is where that rule lives — the
  // component only measures. (jsdom has no layout engine, so proving it in the render would read
  // every width as 0 and pass vacuously.)
  // ── THE LADDER: WHOLE WORDS AT EVERY WIDTH ──────────────────────────────────────────────────
  //
  // THE FOUNDER'S SPEC, which replaced the icon tier that used to live here: "I don't see the words
  // Send, Push, and Speak. It just says Se..., Pu..., Sp.... I want to see the entire words Send,
  // Push, Speak when the column is not in its very wide open state."
  //
  // So an ELLIPSISED LABEL IS THE ONE OUTCOME RULED OUT, and these pin that no tier produces one.
  // ── EVERY THRESHOLD IS PINNED TO WHAT ITS TIER ACTUALLY NEEDS ───────────────────────────────
  //
  // THE BUG THIS CLOSES, and it shipped. The ladder's thresholds live in this module as literals
  // (they must — `trayGeometry` imports `SEND_MODES` from here, so importing it back would be a
  // cycle), and they were computed by hand from label widths RE-MEASURED at the same time. Only the
  // thresholds were ported. `trayGeometry` kept `WIDEST_LABEL_PX = 86` / `WIDEST_SHORT_LABEL_PX =
  // 44`, against which `fullTight` really needed 323 and `short` really needed 197 — both were set
  // BELOW that, so between 281–323px and 179–197px the ladder chose a label that does not fit and
  // the founder's "Se… Pu… Sp…" was still reachable.
  //
  // A literal that has drifted from its derivation is this module's documented recurring failure
  // (roborev 56213/56223/56301). `TRAY_SHORT_LABEL_MAX_PX` already had a guard of exactly this
  // shape; the three new rungs shipped without one. They have one now, so the cycle stays broken
  // AND the numbers cannot drift silently again.
  //
  // `>=`, not `===`: erring HIGH is safe (a shorter label a notch early), erring LOW is the clipped
  // word this whole ladder exists to delete.
  describe("the ladder's thresholds cannot drift from the pill geometry", () => {
    it("gives each rung at least what its own tier needs", () => {
      expect(TRAY_SHORT_LABEL_MAX_PX).toBeGreaterThanOrEqual(fullLabelsFitAtPx());
      expect(TRAY_FULL_NO_CHICLET_MIN_PX).toBeGreaterThanOrEqual(trayFullNoChicletMinPx());
      expect(TRAY_SHORT_NO_CHICLET_MIN_PX).toBeGreaterThanOrEqual(trayShortNoChicletMinPx());
      expect(TRAY_SHORT_TIGHT_MIN_PX).toBeGreaterThanOrEqual(trayShortTightMinPx());
    });

    it("keeps the rungs strictly ordered, so none is unreachable", () => {
      expect(TRAY_SHORT_LABEL_MAX_PX).toBeGreaterThan(TRAY_FULL_NO_CHICLET_MIN_PX);
      expect(TRAY_FULL_NO_CHICLET_MIN_PX).toBeGreaterThan(TRAY_SHORT_NO_CHICLET_MIN_PX);
      expect(TRAY_SHORT_NO_CHICLET_MIN_PX).toBeGreaterThan(TRAY_SHORT_TIGHT_MIN_PX);
    });
  });

  describe("the words-first density ladder", () => {
    it("descends full → fullTight → short → shortTight → floor as the tray narrows", () => {
      expect(trayDensityFor(TRAY_SHORT_LABEL_MAX_PX)).toBe("full");
      expect(trayDensityFor(TRAY_SHORT_LABEL_MAX_PX - 1)).toBe("fullTight");
      expect(trayDensityFor(TRAY_FULL_NO_CHICLET_MIN_PX)).toBe("fullTight");
      expect(trayDensityFor(TRAY_FULL_NO_CHICLET_MIN_PX - 1)).toBe("short");
      expect(trayDensityFor(TRAY_SHORT_NO_CHICLET_MIN_PX)).toBe("short");
      expect(trayDensityFor(TRAY_SHORT_NO_CHICLET_MIN_PX - 1)).toBe("shortTight");
      expect(trayDensityFor(TRAY_SHORT_TIGHT_MIN_PX)).toBe("shortTight");
      expect(trayDensityFor(TRAY_SHORT_TIGHT_MIN_PX - 1)).toBe("floor");
    });

    it("takes the FULL tier before it has been measured, so nothing flickers on first paint", () => {
      expect(trayDensityFor(0)).toBe("full");
      expect(trayDensityFor(-1)).toBe("full");
    });

    it("NEVER returns a truncated label — every tier shows a WHOLE word", () => {
      // The mechanism as a property: the ladder picks a SHORTER STRING rather than letting CSS cut
      // a longer one. A tier returning a prefix-with-ellipsis, or nothing at all, fails here.
      for (const d of ["full", "fullTight", "short", "shortTight", "floor"] as const) {
        for (const m of SEND_MODES) {
          const label = trayLabelFor(m, d);
          expect(label).toBeTruthy();
          expect(label).not.toContain("…");
          expect([SEND_MODE_LABEL[m], SEND_MODE_LABEL_SHORT[m]]).toContain(label);
        }
        expect(trayShowsWords(d), `${d} stopped showing words`).toBe(true);
      }
    });

    it("shows Send / Push / Speak WELL BELOW the default concierge column", () => {
      // The regression this exists for: the old ladder went to icons at 320px and truncated the
      // short words above it, so at ordinary widths the founder saw "Se… Pu… Sp…".
      expect(TRAY_SHORT_TIGHT_MIN_PX).toBeLessThan(180);
      for (const m of SEND_MODES) {
        expect(trayLabelFor(m, trayDensityFor(200))).toBe(SEND_MODE_LABEL_SHORT[m]);
        expect(trayLabelFor(m, trayDensityFor(140))).toBe(SEND_MODE_LABEL_SHORT[m]);
        // …and even at the very floor, where the pills wrap rather than truncate.
        expect(trayLabelFor(m, trayDensityFor(60))).toBe(SEND_MODE_LABEL_SHORT[m]);
      }
    });

    it("keeps every short label a SUBSTRING of its full label", () => {
      // WCAG 2.5.3 (Label in Name): the accessible name is held at the FULL label in every tier, so
      // the visible string must be contained in it. "Push" inside "Push to talk" satisfies that; an
      // ellipsised "Pu…" would not — one more reason truncation is ruled out rather than tuned.
      expect(shortLabelsAreContainedInFullLabels()).toBe(true);
    });

    it("drops the KEYCAP SLOT first — the single biggest win", () => {
      // 30px + a 6px gap per pill is 108px across the tray, reserved for a hover-only hint. That
      // reservation, not a narrow column, is what forced the truncation.
      expect(trayShowsChiclet("full")).toBe(true);
      for (const d of ["fullTight", "short", "shortTight", "floor"] as const) {
        expect(trayShowsChiclet(d)).toBe(false);
      }
    });
  });
});

describe("which positions offer the Auto-send toggle (sparkle-aew8t)", () => {
  it("exactly the positions that count down — Speak, and only Speak", () => {
    // ComposeBox gates the Auto-send switch on `modeCountsDown` itself rather than on a second
    // predicate of its own, so this is the whole rule: the switch governs what an EXPIRED countdown
    // does, and a position with no countdown has nothing for it to govern.
    //
    // Asserted across the WHOLE mode set rather than at three literals, so a fourth position cannot
    // be added that draws a switch over nothing without failing here.
    const offersToggle = SEND_MODES.filter((m) => modeCountsDown(m));
    expect(offersToggle).toEqual(["speak"]);
  });
});
