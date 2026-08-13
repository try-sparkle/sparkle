// The single voice status line, as data (bead sparkle-bbfsx).
//
// The founder cut three rows of chrome under the waveform down to one, and made that one RESPONSIVE:
// grey "Hold ⌘ to talk" at rest, blue "Release ⌘ to send" while the key is down, blue "Actively
// listening" in Speak. These rows pin the rule; LogoWaveform.render.test.tsx pins that the component
// is actually wired to it, and dictationCopy.test.ts pins the strings themselves.
import { describe, expect, it } from "vitest";

import { voiceStatusLine } from "./voiceStatusLine";
import {
  PTT_CAPTION_ACTION,
  PTT_CAPTION_HELD,
  SPEAK_CAPTION_HEADLINE,
} from "./dictationCopy";

describe("push to talk — the line follows the KEY", () => {
  it("rests GREY, telling the user how to open a mic that is shut", () => {
    expect(voiceStatusLine({ captionKind: "pushToTalk", pttHeld: false })).toEqual({
      text: PTT_CAPTION_ACTION,
      tone: "rest",
    });
  });

  it("goes BLUE and names the release while the key is down", () => {
    // "when I am actually holding it, that's when it should be blue" — and it says what to do next,
    // which by then is letting go rather than holding.
    expect(voiceStatusLine({ captionKind: "pushToTalk", pttHeld: true })).toEqual({
      text: PTT_CAPTION_HELD,
      tone: "live",
    });
  });

  it("THE COLOURS ARE THE OPPOSITE WAY ROUND FROM THE COPY THIS REPLACES", () => {
    // Worth its own row because it reads as a regression to anyone who knew the old surface: the
    // action line used to be blue in EVERY state. Blue now means live, full stop.
    const rest = voiceStatusLine({ captionKind: "pushToTalk", pttHeld: false });
    const held = voiceStatusLine({ captionKind: "pushToTalk", pttHeld: true });
    expect(rest?.tone).toBe("rest");
    expect(held?.tone).toBe("live");
    expect(rest?.tone).not.toBe(held?.tone);
  });

  it("the gesture is the ONLY input that moves it — nothing else is consulted", () => {
    // The requirement behind this: the label must not lag his finger. The rule takes no mic state
    // at all, so it cannot wait on capture starting up (or, on the way out, on the release drain
    // that keeps the mic live for up to PARTIAL_SETTLE_CAP_MS after he lets go).
    expect(voiceStatusLine({ captionKind: "pushToTalk", pttHeld: true })?.text).toBe(
      PTT_CAPTION_HELD,
    );
    expect(voiceStatusLine({ captionKind: "pushToTalk", pttHeld: false })?.text).toBe(
      PTT_CAPTION_ACTION,
    );
  });
});

describe("speak — one line, blue, and no second string", () => {
  it("says only 'Actively listening', in the live tone", () => {
    expect(voiceStatusLine({ captionKind: "dictating", pttHeld: false })).toEqual({
      text: SPEAK_CAPTION_HEADLINE,
      tone: "live",
    });
  });

  it("carries no instruction — 'Just pause when you're done' is gone", () => {
    const line = voiceStatusLine({ captionKind: "dictating", pttHeld: false });
    expect(line?.text).not.toMatch(/pause/i);
  });

  it("ignores the talk key, which belongs to the other position", () => {
    // Holding ⌘ in Speak is a chord (⌘V, ⌘A), not a talk gesture. A shared `pttHeld` term that
    // leaked into this arm would rewrite the line every time he pasted.
    expect(voiceStatusLine({ captionKind: "dictating", pttHeld: true })?.text).toBe(
      SPEAK_CAPTION_HEADLINE,
    );
  });
});

describe("nothing to claim", () => {
  it("returns null for Send — and null must render as NOTHING, not an empty row", () => {
    // The founder asked for the space to be reclaimed. Null is the caller's signal to render no
    // element at all; a blank line holding the gap open is precisely what he was removing.
    expect(voiceStatusLine({ captionKind: "none", pttHeld: false })).toBeNull();
    expect(voiceStatusLine({ captionKind: "none", pttHeld: true })).toBeNull();
  });
});
