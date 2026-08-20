// A COLUMN HEADER'S TEXT LINK — the one shape, used by every header that offers a way somewhere.
//
// WHY A COMPONENT RATHER THAN FIVE INLINE STYLES. This link is the successor to `PlanBuildToggle`,
// which the founder retired: the planning board is now something you OPEN and CLOSE rather than a
// mode you toggle. That control had FOUR mounts and the two board headers already carry a standing
// warning that they drift when only one is edited (SatelliteApp.tsx: "THE SAME ROW AS THE MAIN
// WINDOW'S PlanBoardSlot, AND IT HAS TO STAY THAT WAY"). Five hand-rolled copies of a link would
// reproduce exactly that, so the look lives here once.
//
// THE INK IS `accentInk`, NOT `tealInk`, and not a fill token. `theme/linkContrast.test.ts` SCANS
// .tsx files for `textDecoration: underline` and fails any whose colour is not provably on an ink
// tier — so the style is written inline here, in a .tsx, rather than lifted into a .ts style
// module: that same suite forbids an underlined style outside the .tsx scan precisely because it
// cannot follow the import.
import type { CSSProperties } from "react";
import { C } from "../theme/colors";
import { FONT_UI, TYPE } from "../theme/scale";

export function HeaderLink({
  label,
  onClick,
  testId,
  hint,
  title,
  style,
}: {
  label: string;
  onClick: () => void;
  testId: string;
  /** `data-hint` for the ⌘-tap overlay. The `p`/`b` mnemonics MOVED here from the retired toggle
   *  rather than being deleted: `keyboardHints/hintTargets.test.ts` pins the literal letters, and
   *  removing the CHROME_HINTS entries would also widen `AGENT_OVERFLOW_POOL` by two characters and
   *  reshuffle every project-tab and overflow-agent label. Moving the attribute keeps both keys
   *  working AND fixes a latent ambiguity: `data-hint="build"` used to match several live elements
   *  at once, and `HintOverlay` fires whichever is first in DOM order. */
  hint?: string;
  /** Hover/tooltip text. OPTIONAL, but not decorative: `label` is a short verb phrase and the same
   *  words recur on unrelated controls — "Show all" alone appears on three buttons in the build
   *  column, one of them in this very band beside the status filter's own reset. Where a link's
   *  label does not by itself say WHICH thing it acts on, pass this so hover and the accessible
   *  name do. Omitted when the label is already unambiguous ("Open Planning Board"). */
  title?: string;
  style?: CSSProperties;
}) {
  return (
    <button
      data-testid={testId}
      {...(hint ? { "data-hint": hint } : null)}
      {...(title ? { title, "aria-label": title } : null)}
      onClick={onClick}
      style={{
        background: "transparent",
        border: "none",
        padding: 0,
        margin: 0,
        color: C.accentInk,
        cursor: "pointer",
        fontFamily: FONT_UI,
        fontSize: TYPE.micro,
        textDecoration: "underline",
        textUnderlineOffset: 2,
        whiteSpace: "nowrap",
        flex: "0 0 auto",
        ...style,
      }}
    >
      {label}
    </button>
  );
}
