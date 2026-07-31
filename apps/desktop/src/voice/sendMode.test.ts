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
  DEFAULT_SPEAK_LEFT_FRAC,
  TRAY_PILL_COUNT,
  fullLabelsFitAtPx,
} from "../components/Concierge/trayGeometry";
import { CONCIERGE_DEFAULT_WIDTH } from "../engine/columnResize";
import {
  SEND_MODES,
  SEND_MODE_LABEL,
  SEND_MODE_LABEL_SHORT,
  SWEEP_FLOOR_MS,
  TRAY_SHORT_LABEL_MAX_PX,
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
  it("Send releases the mic, Push to talk arms it, Speak takes it live", () => {
    expect(micIntentForMode("send")).toBe("off");
    expect(micIntentForMode("ptt")).toBe("paused");
    expect(micIntentForMode("speak")).toBe("active");
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

  it("in Push to talk NOTHING sends by chord — ⌘ means talk there", () => {
    // One meaning per chord per mode. The alternative is a timing heuristic trying to tell a tap
    // from a hold, which is exactly the guesswork this control was designed to delete. Releasing
    // already sends, so nothing is lost.
    expect(chordSends("ptt", "cmd-enter", { key: "Enter", metaKey: true })).toBe(false);
    expect(chordSends("ptt", "enter", { key: "Enter" })).toBe(false);
  });

  it("the chip shows the chord the handler honours, and ⌘ where ⌘ means talk", () => {
    // The two halves of the same fact: whatever `chordSends` accepts is what `chicletFor` draws.
    expect(chicletFor("send", "cmd-enter")).toBe("⌘↩");
    expect(chicletFor("speak", "cmd-enter")).toBe("⌘↩");
    expect(chicletFor("send", "enter")).toBe("↩");
    expect(chicletFor("ptt", "cmd-enter")).toBe("⌘");
    expect(chicletFor("ptt", "enter")).toBe("⌘");
  });

  it("a chip is never drawn for a chord its own mode refuses", () => {
    // The vacuous-test guard for the pair above: this asserts the RELATIONSHIP rather than two
    // independent literals, so changing one function without the other fails here.
    for (const mode of SEND_MODES) {
      for (const chord of ["cmd-enter", "enter"] as const) {
        const cap = chicletFor(mode, chord);
        if (cap === "⌘") {
          expect(chordSends(mode, chord, { key: "Enter", metaKey: true })).toBe(false);
          continue;
        }
        const press =
          chord === "cmd-enter" ? { key: "Enter", metaKey: true } : { key: "Enter" };
        expect(chordSends(mode, chord, press)).toBe(true);
      }
    }
  });

  // ── THE NARROW TRAY ────────────────────────────────────────────────────────────────────────
  // The founder's report: a narrow concierge column drew the tray as "S… P… S…". The pills are
  // `flex: 1`, so the longest label sets the pressure for all three and they ellipsize together.
  // The fix picks a shorter WORD instead of clipping, and this is where that rule lives — the
  // component only measures. (jsdom has no layout engine, so proving it in the render would read
  // every width as 0 and pass vacuously.)
  describe("trayLabelFor", () => {
    it("spells every position out when the tray is wide", () => {
      for (const mode of SEND_MODES) {
        expect(trayLabelFor(mode, TRAY_SHORT_LABEL_MAX_PX)).toBe(SEND_MODE_LABEL[mode]);
        expect(trayLabelFor(mode, TRAY_SHORT_LABEL_MAX_PX + 200)).toBe(SEND_MODE_LABEL[mode]);
      }
    });

    it("shortens only the label that could not fit, and keeps the other two intact", () => {
      const narrow = TRAY_SHORT_LABEL_MAX_PX - 1;
      // The whole point: Send and Speak are NOT abbreviated. A narrow tray still reads
      // "Send | Push | Speak" — three words, none of them clipped.
      expect(trayLabelFor("send", narrow)).toBe("Send");
      expect(trayLabelFor("ptt", narrow)).toBe("Push");
      expect(trayLabelFor("speak", narrow)).toBe("Speak");
      // Asserted as a RELATIONSHIP too, so renaming a position in one table without the other
      // fails here rather than silently drifting.
      expect(trayLabelFor("ptt", narrow)).not.toBe(SEND_MODE_LABEL.ptt);
      expect(trayLabelFor("ptt", narrow)).toBe(SEND_MODE_LABEL_SHORT.ptt);
    });

    it("never emits an ellipsis or a truncated word in either table", () => {
      // The defect being fixed was a CHARACTER the user had to decode. Neither table may reintroduce
      // one, at any width.
      for (const width of [0, 1, TRAY_SHORT_LABEL_MAX_PX - 1, TRAY_SHORT_LABEL_MAX_PX, 9999]) {
        for (const mode of SEND_MODES) {
          const label = trayLabelFor(mode, width);
          expect(label).not.toMatch(/[…]|\.\.\./);
          expect(label.trim()).toBe(label);
          expect(label.length).toBeGreaterThan(0);
        }
      }
    });

    it("keeps every short label a SUBSTRING of its full label", () => {
      // The invariant that lets the tray shrink the VISIBLE text while holding the accessible name
      // at the full label: WCAG 2.5.3 requires the visible string to be CONTAINED IN the name, and
      // "Push" is inside "Push to talk". The two tables are edited independently, so nothing else
      // would notice them drifting apart — this is the thing that fails when they do.
      expect(shortLabelsAreContainedInFullLabels()).toBe(true);
      // Asserted through the predicate AND spelled out, so a predicate that started returning a
      // constant `true` could not carry this row on its own.
      for (const mode of SEND_MODES) {
        expect(SEND_MODE_LABEL[mode]).toContain(SEND_MODE_LABEL_SHORT[mode]);
      }
    });

    it("switches to short labels BEFORE the full ones stop fitting, never after", () => {
      // The regression this pins (roborev 56198): between the threshold and the real fit width the
      // component still picks the FULL table and the span clips, so a threshold set too low paints
      // "Push to tal" — a silently truncated word, strictly worse than the "P…" being replaced.
      //
      // DERIVED FROM THE COMPONENT'S OWN CONSTANTS, not from literals copied out of it. An earlier
      // version of this row spelled the arithmetic as `3 * (86 + 52) + 14`, which meant bumping
      // CHICLET_SLOT to 40 moved the real fit width to 458 and left this comparing 430 against a
      // stale 428 — green, while widths 430-458 clipped mid-word (roborev 56213). Now a change to
      // any of the geometry fails HERE.
      expect(TRAY_SHORT_LABEL_MAX_PX).toBeGreaterThanOrEqual(fullLabelsFitAtPx());
      // …and at every width below it, the widest label is the SHORT one.
      for (const w of [280, 320, 360, 400, TRAY_SHORT_LABEL_MAX_PX - 1]) {
        expect(trayLabelFor("ptt", w)).toBe(SEND_MODE_LABEL_SHORT.ptt);
      }
    });

    it("derives the tray's pill count from SEND_MODES, never from a copy of it", () => {
      // ── roborev 56301 ─────────────────────────────────────────────────────────────────────────
      // trayGeometry briefly hand-wrote `3`. Adding a fourth position is a SUPPORTED change —
      // `stepSendMode` walks the array and the component maps over it — and with a copied literal
      // `fullLabelsFitAtPx()` would keep returning the three-pill number while the true requirement
      // grew, leaving the `>=` guard green while every width in between clipped mid-word. The sweep
      // would stop short of Speak's edge for the same reason.
      expect(TRAY_PILL_COUNT).toBe(SEND_MODES.length);
      // ── AND THE ORDERING UNDERNEATH IT (roborev 56312) ──────────────────────────────────────
      // The first version of this line asserted `(SEND_MODES.length - 1) / SEND_MODES.length`,
      // which is a VERBATIM RESTATEMENT of what the implementation computed — so it stayed green on
      // the one edit it was written to guard against. Assert Speak's POSITION instead, which is the
      // value's actual contract.
      expect(DEFAULT_SPEAK_LEFT_FRAC).toBeCloseTo(
        SEND_MODES.indexOf("speak") / SEND_MODES.length,
        10,
      );
      // The last-ness assumption, stated ONCE and explicitly rather than re-encoded in a formula.
      // The sweep is anchored `right: 0` and fills leftward toward the position that counts down,
      // so Speak being the final pill is load-bearing for the geometry as a whole — not just for
      // this fraction. If a position is ever appended after it, this is the row that should fail.
      expect(SEND_MODES.at(-1)).toBe("speak");
    });

    it("takes the short labels at the DEFAULT concierge column width", () => {
      // The cross-file claim the threshold's doc rests on, finally pinned (roborev 56204):
      // CONCIERGE_DEFAULT_WIDTH was module-private in Workspace.tsx, so it could move with nothing
      // here noticing — and at the default width the full labels do not fit, which is why the
      // founder saw "S… P… S…" without having resized anything.
      //
      // A CONSERVATIVE proxy, deliberately: this is the COLUMN width, while the tray measures its
      // own contentRect, which is strictly SMALLER (the column insets it). So the real tray width is
      // even further below the threshold than this comparison shows — it errs toward short labels,
      // which is the safe direction.
      expect(TRAY_SHORT_LABEL_MAX_PX).toBeGreaterThan(CONCIERGE_DEFAULT_WIDTH);
      expect(trayLabelFor("ptt", CONCIERGE_DEFAULT_WIDTH)).toBe(SEND_MODE_LABEL_SHORT.ptt);
    });

    it("takes the FULL labels before it has been measured, so nothing flickers on first paint", () => {
      // 0 = "the ResizeObserver has not fired yet". Booting abbreviated and widening a frame later
      // is a visible flicker; a too-long label for one frame is not.
      for (const mode of SEND_MODES) {
        expect(trayLabelFor(mode, 0)).toBe(SEND_MODE_LABEL[mode]);
      }
    });
  });
});
