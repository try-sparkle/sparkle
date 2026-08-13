// The ONE line under the waveform — the whole of the voice chrome the founder kept (sparkle-bbfsx).
//
// It draws whatever `voice/voiceStatusLine` returns and decides nothing itself, which is the same
// split every other voice surface here uses (the rule is data, the component is paint). See that
// module for the founder's words and for why blue now means LIVE.
//
// ══ IT MUST NOT REFLOW WHEN THE TEXT CHANGES ════════════════════════════════════════════════════
// "Hold ⌘ to talk" and "Release ⌘ to send" are different widths, and they swap on a keypress — the
// most noticeable moment in the whole feature. Two properties keep that from shoving anything:
//
//   • the line is a BLOCK at `width: 100%` with `textAlign: center`, so a longer string grows from
//     the middle outward instead of pushing its neighbours;
//   • `minHeight` is pinned to the rendered line box (`fontSize × lineHeight`), so the row keeps
//     exactly one line's height in both states — and, because it is a MINIMUM rather than a fixed
//     height, a narrow column that wraps the longer string still gets its second line rather than
//     clipping it.
//
// The height is reserved only WHILE A LINE IS SHOWING. When there is nothing to say this component
// is not rendered at all (see the caller), because the founder asked for the space to be reclaimed:
// an always-present empty row is the thing he was removing.
import type { CSSProperties } from "react";

import { C } from "../theme/colors";
import type { VoiceStatusLine as VoiceStatusLineModel } from "../voice/voiceStatusLine";

/** The line's own type scale, matching the caption it replaces (12px / 600) so nothing around it
 *  had to move. Held here rather than inline so the reserved height below is computed from the SAME
 *  numbers that are rendered — two literals that must agree is how a reserved row ends up the wrong
 *  size. */
const FONT_SIZE = 12;
const LINE_HEIGHT = 1.35;

const line: CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "center",
  marginTop: 4,
  fontSize: FONT_SIZE,
  lineHeight: LINE_HEIGHT,
  // ONE LINE'S WORTH, ALWAYS — see the header. A MINIMUM, so a wrap is still allowed to grow.
  minHeight: FONT_SIZE * LINE_HEIGHT,
  fontWeight: 600,
};

export function VoiceStatusLine({ model }: { model: VoiceStatusLineModel }) {
  return (
    <div
      style={{
        ...line,
        // BLUE WHILE LIVE, GREY AT REST. `C.tealInk` is the exact blue the old always-blue action
        // line used and `C.muted` the exact grey the deleted "Push to talk" headline used — the
        // founder asked for those two tokens by pointing at what was already on screen ("it should
        // be the color of push to talk"), so they are picked up rather than re-chosen.
        color: model.tone === "live" ? C.tealInk : C.muted,
      }}
      // The one live state is worth announcing as a status; the resting instruction is not
      // something to interrupt a screen-reader user with on every keyup.
      role={model.tone === "live" ? "status" : undefined}
      data-testid="voice-status-line"
      data-tone={model.tone}
    >
      {model.text}
    </div>
  );
}

/** Exported for the layout test, which cannot measure in jsdom (no layout engine) and so asserts
 *  the reserved height as a NUMBER instead — the same trick `trayGeometry` uses one folder over. */
export const VOICE_STATUS_LINE_MIN_HEIGHT = FONT_SIZE * LINE_HEIGHT;
