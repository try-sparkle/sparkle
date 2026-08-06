// THE MONOSPACE FACE INSIDE RENDERED MARKDOWN — one declaration, read by everything that needs it.
//
// `Markdown` can render in the UI face or the TERMINAL's (see its `face` prop). Prose follows that
// by inheritance, but every element that must stay monospace regardless — a `code` span, a fenced
// block, a bead pill carrying an id — has to RE-DECLARE a family, and a re-declaration is a second
// opinion about which monospace. Hardcoding `FONT_MONO` in those places paints `--k-mono`
// (ui-monospace/SF Mono) inside a column set in the terminal's Source Code Pro: a different typeface
// that looks plausible, matches nothing, and goes red nowhere, because both are monospace.
//
// So they read a custom property the Markdown root publishes instead. The root decides once, per
// face; every monospace descendant follows at any depth, through any component boundary.
//
// WHY ITS OWN MODULE rather than living in `Markdown.tsx`: `Markdown` imports `BeadPill` (the bead
// linkifier renders one inline), so a `BeadPill` that imported the constant back from `Markdown`
// would close an import cycle. A leaf module both can import keeps one declaration site without one.
//
// The fallback is load-bearing: an element rendered OUTSIDE a Markdown root — a pill in a plain
// chat row, a code span in some future surface — keeps the UI mono face it has always had.
import { FONT_MONO } from "../theme/scale";

/** The custom property a `Markdown` root publishes to name the face its monospace children wear. */
export const MD_CODE_FACE_VAR = "--md-code-face";

/** What a monospace child DECLARES: the property, falling back to the UI mono face. */
export const MD_CODE_FACE = `var(${MD_CODE_FACE_VAR}, ${FONT_MONO})`;
