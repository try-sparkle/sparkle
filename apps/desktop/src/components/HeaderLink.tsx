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
  description,
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
  /** WHAT THIS LINK ACTS ON, when `label` alone cannot say — "Show all" appears on three separate
   *  buttons in the build column, one of them in this very band beside the status filter's reset.
   *
   *  IT IS NOT A TOOLTIP, and must not be described as one. `disableNativeTooltips()` (wired at
   *  `main.tsx`) installs a CAPTURE-PHASE `mouseover` listener that walks the hovered element and
   *  every ancestor and deletes `title` before the webview's tooltip delay elapses, so a native
   *  `title` here is dead by construction — see `ProjectTabs.tsx` and bead `sparkle-7h01z`, which
   *  reached this conclusion already. Worse, that helper only promotes `title` to a name when the
   *  element is otherwise UNNAMED; this button has visible text, so a `title` would be deleted
   *  and nothing kept. So this feeds the ACCESSIBLE NAME only.
   *
   *  The name is composed as `<label> — <description>` rather than replacing the label, because an
   *  accessible name that does not contain the visible text fails WCAG 2.5.3 (Label in Name): a
   *  voice-control user saying "click Show all" would no longer match the control.
   *
   *  If a VISIBLE hover explanation is ever wanted, the established pattern is local hover state
   *  plus a portaled fixed-position card (`composer/SuggestionRow.tsx`, `ProjectTabs.tsx`) — not
   *  this prop. Omit it when the label is already unambiguous ("Open Planning Board"). */
  description?: string;
  style?: CSSProperties;
}) {
  return (
    <button
      data-testid={testId}
      {...(hint ? { "data-hint": hint } : null)}
      {...(description ? { "aria-label": `${label} — ${description}` } : null)}
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
