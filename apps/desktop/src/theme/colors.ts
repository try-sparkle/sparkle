// Desktop-local theme color layer. The shared @sparkle/ui tokens stay literal hex (mobile
// is React Native and web reads them at build, neither can consume CSS var()), so the
// light/dark switch lives entirely in the desktop app.
//
// THEME_HEX is the ONE place the light/dark hex values live. index.css mirrors these into
// CSS variables (an enforced equality test guards the mirror — see theme.test / index.css),
// and Terminal reads them directly via xtermTheme() because xterm needs concrete hex.
import { C as BRAND, AGENT_STATUS } from "@sparkle/ui";

// DARK IS THE BLACK-AND-GOLD PALETTE FROM THE CANONICAL PROTOTYPE
// (PRD/sparkle/concierge-mode/prototype.html `:root`). Dark is the default theme and the
// prototype is a dark design, so it is repainted IN PLACE rather than added as a third theme
// value — ThemePref stays light|dark|auto. Every dark value below is a prototype variable;
// the mapping (and why each one landed where it did) is written up in
// PRD/sparkle/black-gold-repaint.md. LIGHT keeps its own values: it was already coherent and
// legible, and the repaint's job was to restore the approved DARK look.
//
// The surfaces, from the content plane outward:
//
// • forest — the TERMINAL CONTENT plane and the app body background: prototype `--term #05070d`,
//   the DARKEST plane. xtermTheme() reads it directly as the terminal background.
//
// • deepForest — the LEFT SIDEBAR / BUILDER column (and its internals: the Think/Plan/Build
//   chevron seam, the sticky New-Agent slot) plus shared secondary surfaces (modals, dropdowns,
//   pills): prototype `--bg-builder #0f1220`.
//
// • barSurface — the TOP BAR and the COMPOSER input box. These frame the live terminal
//   directly, so they sit ABOVE deepForest and recede against the content instead of competing
//   with the sidebar: prototype `--panel-2 #161a2b`.
//
// • conciergeSurface — the SPARKLE CONCIERGE column, the LIGHTEST of the three depth layers in
//   the concierge shell (PRD/sparkle/concierge-mode.md §3: "three depth layers, Sparkle lightest →
//   builder → terminal darkest"): prototype `--bg-sparkle #191d2d`.
//
// So dark now ramps term #05070d → builder #0f1220 → bars #161a2b → concierge #191d2d, which is
// the prototype's own ordering. In light mode the ordering inverts with the theme, as before.
//
// ── THE PLANES ARE A RAMP, NOT A SEPARATOR ────────────────────────────────────────────────────
// The pre-repaint comment said `deepForest` was "held ONE STEP away from `forest` so the active
// row — painted in `forest` — stands out against inactive rows", and the old navies delivered
// 1.50:1. The prototype's planes are four shades of near-black, so that step all but vanishes.
// That is CORRECT for a depth ramp (the planes are meant to recede, not to divide) and it is why
// they are NOT nudged here — `forest` is also the terminal plane xtermTheme() paints on, and
// every calm ink's contrast floor is measured against it.
//
// What a naive repaint breaks is everything that had been leaning on that 1.50:1 to draw a
// LINE: `border: 1px solid ${C.forest}` on a `deepForest` panel, and `background: C.forest`
// filled pills. Those never wanted "the plane below", they wanted "a visible edge", and on
// near-black planes an edge has to go the other way — LIGHTER, like the prototype's own
// `--line: #232841`. So the separation lives on four explicit tokens (`chatBubble`, `pillFill`,
// `chatBubbleActive`, `hairline`) with numeric floors in theme/chromeContrast.test.ts. The ramp
// keeps its ordering; the chrome keeps its edges; neither is doing the other's job.
//
// ── THE NEUTRAL LADDER — READ THIS BEFORE CHANGING ANY VALUE BELOW ────────────────────────────
// The eight neutral tokens are ONE designed ladder, not eight independently-tuned values, and
// three rounds of review were spent learning that the hard way. Each round nudged a single token
// to clear a single floor, and each nudge landed the token on top of a NEIGHBOUR: `chatBubble`
// came to rest on `hairline` and `chatBubbleActive` on `pillFill`, in both themes — two distinct
// values one hair apart, which is the exact defect the round before had existed to catch. A
// fourth nudge would have produced a fifth round.
//
// So the ladder is derived ONCE, from the constraints, and written down here as the record of
// intent. Ordered by DISTANCE FROM THE PLANES (which is "lighter" in dark and "darker" in light,
// so the ordering below is the same sentence in both themes):
//
//   the four PLANES, a recession ramp — deliberately tight, see the section above
//     dark   forest #05070d → deepForest #0f1220 → barSurface #161a2b → conciergeSurface #191d2d
//     light  forest #ffffff → barSurface #f1f4fa → conciergeSurface #eceef2 → deepForest #d9dce1
//   then the four CHROME slots, each one step further out:
//     slot 1  chatBubble        dark #354065   light #92ade5   the hovered row / user's bubble
//     slot 2  pillFill          dark #454d71   light #929bad   the filled chip
//     slot 3  chatBubbleActive  dark #4e5a90   light #5f87e0   the row you are IN
//     slot 4  hairline          dark #63698c   light #6e7a93   the panel EDGE
//
// WHY THAT ORDER, AND WHY EACH GAP IS THE SIZE IT IS. Three kinds of constraint fix it:
//
//  1. FLOOR — every chrome slot must clear CHROME_MIN_CONTRAST against all four planes, because
//     the same border/fill draws on each. That is what puts slot 1 where it is.
//  2. SPACING — two slots that a component actually COMPOSITES (paints one on the other) clear
//     CHROME_MIN_CONTRAST between them: `hairline` around a `pillFill` chip (DragVisionHintPill),
//     `hairline` on a `chatBubble` fill (the sidebar's Improve row), and `chatBubble` against
//     `chatBubbleActive` (the three row states). Two slots that merely coexist in the ladder clear
//     the weaker RAMP_MIN_SPLIT — enough that they can never again be one hair apart, and by
//     construction more than any deliberate step between two PLANES.
//  3. CAP — `cream` is the ink on all three FILL slots, and it has to stay readable, so the fills
//     cannot be pushed away from the planes without limit. `hairline` is the only chrome token
//     with NO ink on it, which is exactly why it is the slot that can afford to be furthest out —
//     and why it, not `pillFill`, sits at the end of the ladder. (`pillFill` was documented as
//     "one step stronger than hairline"; the ladder inverts that, and the reason is this cap.)
//
// The cap is what makes this a system rather than four preferences: the whole band between the
// floor and the cap is narrower than three CHROME_MIN_CONTRAST steps in BOTH themes, so the
// constraint set has no slack to spend on a reactive nudge. Move one value and something else
// must move; theme/chromeContrast.test.ts asserts the ORDER and every gap of the whole ladder, so
// an edit that collapses any two of the eight fails there rather than in a fourth review round.
//
// ONE PAIRING THE LADDER CANNOT HOLD, stated rather than hidden: `muted` cannot clear the ink
// floor on ANY chrome fill, in either theme, and no choice of values fixes that. In dark every
// slot that clears the FLOOR is already lighter than the darkest backdrop `muted` can be read on;
// in light every slot that clears it is already darker than the lightest one. `muted` is a
// PLANE ink. Surfaces that carry it belong on a plane — which is why the sidebar's hover card
// moved to `barSurface`, and why the three 10px secondary lines on AgentPane's selected account
// row take `cream` there instead. See theme/chromeContrast.test.ts for the measurement.
//
// ── LIGHT'S THREE COLUMNS ARE A RAMP TOO, AND IT WAS TOO FLAT TO READ ─────────────────────────
// The founder's complaint about light mode was "a mishmash of shades … gray-on-gray": the concierge
// column, the builder column and the terminal are three planes, and light spaced them 1.16:1 and
// 1.18:1 apart — under RAMP_MIN_SPLIT, i.e. below the bar this file already sets for two CHROME
// tokens that merely coexist. They are now re-spaced to PLANE_MIN_SPLIT (see below).
//
// THE CEILING IS NOT A PREFERENCE, IT IS ANOTHER GUARD. `forest`↔`deepForest` must stay BELOW
// CHROME_MIN_CONTRAST in both themes — chromeContrast.test.ts records that step as insufficient,
// which is the whole justification for the Improve-Sparkle row's gold rail. Contrast ratios
// MULTIPLY along a ramp, so forest→concierge→builder is capped at 1.5 END TO END and each of the
// two steps at √1.5 ≈ 1.2247. That is why the light planes land where they do (≈1.206 / ≈1.208,
// ≈1.457 end to end) rather than somewhere more emphatic: there is no more room, and taking it
// would mean deleting a guard to make a colour pass. The rest of light's column separation comes
// from EDGES instead — the concierge column's right border is `hairline` now, not a 25% wash of
// `muted` — which is the same division of labour the dark ramp already documents above.
//
// FOUR INKS MOVED WITH THE PLANES, because their floors are measured ON them: `muted` (AA on the
// concierge column), `conciergeMuted` (AA on the nudge-card gradient AND the bounded residual on the
// composer plate — amberInk.test.ts pins it from both sides), and `dangerInk` (AA on the nudge
// badge's own sienna fill). Each was re-derived against the NEW surface, not nudged until a test
// went quiet.
export const THEME_HEX = {
  dark: { forest: "#05070d", deepForest: "#0f1220", conciergeSurface: "#191d2d", conciergeMuted: "#8b90a6", barSurface: "#161a2b", hairline: "#63698c", pillFill: "#454d71", cream: "#ece7da", muted: "#8b90a6", chatBubble: "#354065", chatBubbleActive: "#4e5a90", accentInk: "#34e0f0", agentIdle: "#8b90a6", successInk: "#34c759", dangerInk: "#e87b7b", goldInk: "#f5c26b", goldHotInk: "#ffe9b8", goldFill: "#f5c26b", onGoldFill: "#090b14", amberInk: "#ecb968", mixedInk: "#ecb968", tealInk: "#6f9bff", violetInk: "#a084f5" },
  light: { forest: "#ffffff", deepForest: "#d3d6db", conciergeSurface: "#e7eaef", conciergeMuted: "#4e5c79", barSurface: "#f1f4fa", hairline: "#6e7a93", pillFill: "#929bad", cream: "#0a1a3f", muted: "#586885", chatBubble: "#92ade5", chatBubbleActive: "#5f87e0", accentInk: "#0a1a3f", agentIdle: "#3f4e6b", successInk: "#15803d", dangerInk: "#a01f18", goldInk: "#7a5205", goldHotInk: "#5c3f05", goldFill: "#9a6a00", onGoldFill: "#ffffff", amberInk: "#664200", mixedInk: "#b45309", tealInk: "#1c47bd", violetInk: "#5636b8" },
} as const;

// Themed token object for component inline styles. The four theme-dependent tokens become
// var()-based, so a single `data-theme` flip on <html> re-themes the whole app through CSS
// with no React re-render. Everything else (teal, amber, accent, status, …) is brand
// identity, unchanged across themes, and passes through as literal hex from BRAND.
export const C = {
  ...BRAND,
  forest: "var(--c-forest)",
  deepForest: "var(--c-deep-forest)",
  // The concierge column — the lightest of the shell's three depth layers. See THEME_HEX above.
  conciergeSurface: "var(--c-concierge-surface)",
  // Secondary text INSIDE the concierge column — the scope line, the vitals, every secondary
  // label (roborev 46254-L). The contract is unchanged (clear the ink floor on conciergeSurface),
  // but the black-and-gold repaint is what satisfies it in DARK: this token existed because the
  // old conciergeSurface was a LIFTED navy (#33477a) on which `muted` fell short, and the
  // prototype's concierge column is near-black (#191d2d) instead, where the ordinary muted ink
  // clears the floor comfortably. So dark now equals `muted`, exactly as the prototype uses a
  // single `--text-dim` everywhere. LIGHT still needs its own darker value, so the token stays.
  //
  // LIGHT went one step deeper again, for the surface it is actually read on. A nudge card's meta
  // row (`NudgeCard.tsx` — the agent name beside the band badge) and its ghost action both paint
  // this ink directly on the card's sienna-tinted GRADIENT, not on the bare column, and in light
  // that tint DARKENS the backdrop — so the ink loses ground exactly where the earlier value was
  // measured as passing on the column. Three of the card's four inks were re-measured on their
  // real stack; this was the fourth, and it was the one that failed. Both gradient stops are
  // enforced in theme/chromeContrast.test.ts.
  conciergeMuted: "var(--c-concierge-muted)",
  // Lighter chrome for the top bar + composer box. Kept distinct from (lighter than) deepForest
  // so those bars recede against the terminal while the sidebar stays a step darker. See
  // THEME_HEX above.
  barSurface: "var(--c-bar-surface)",
  // THE PANEL EDGE. Every 1px rule that has to be SEEN — modal and dropdown outlines, section
  // dividers, the well around an embedded terminal, the nesting rule under a checkbox. It is
  // deliberately NOT one of the depth planes: on the prototype's near-black shell an edge reads
  // by going lighter than its panel (the prototype's own `--line`), and the four planes are a
  // recession ramp with barely any step between neighbours. Painting a border in `C.forest` —
  // which is what these sites did before, back when forest was a mid navy a clear step below
  // deepForest — draws a line nobody can see. Floor enforced numerically against EVERY panel
  // surface in theme/chromeContrast.test.ts.
  //
  // SLOT 4, the far end of the ladder (see THE NEUTRAL LADDER above), and the value that moved
  // furthest in the consolidation. It has to be seen not only on the four planes but ON the two
  // chrome fills that components paint it against — a `pillFill` chip and a `chatBubble` row —
  // and those fills are themselves a measured step out from the planes. Being the ONLY chrome
  // token with no ink sitting on it, it is the one slot with no cap on the far side, so it is the
  // one that absorbs that requirement. The consequence is deliberate: the app's panel edge is now
  // a real boundary rather than a whisper, at both ends of the theme.
  hairline: "var(--c-hairline)",
  // FILLED chip/pill background — the credit badge, the tier-filter chip, the small selects, a
  // dropdown's selected row. Same story as `hairline` and the same floor: a filled shape has to
  // read as a shape and not just as an edge. Use `hairline` for the 1px rule, this for the fill;
  // a pill that wants both still gets two distinguishable values.
  //
  // "Distinguishable" is a MEASURED separation from `hairline`, not just a different string. The
  // first pair were two distinct values a hair apart, so a chip carrying both drew no border at
  // all — `DragVisionHintPill` is exactly that chip.
  //
  // SLOT 2. This token used to be documented as "one step STRONGER than hairline" and the ladder
  // inverts that: it is a fill, so `cream` has to stay readable on it, and that cap is what keeps
  // it nearer the planes than the uncapped edge token. Its own ink is `cream` — NOT `muted`,
  // which cannot clear the ink floor on this or any other chrome fill in either theme (see the
  // stated exception in THE NEUTRAL LADDER above).
  pillFill: "var(--c-pill-fill)",
  cream: "var(--c-cream)",
  muted: "var(--c-muted)",
  // Cyan (brand accent) is legible as TEXT only on dark backgrounds. As text it must flip to
  // dark ink in light mode — so this themed token is cyan in dark, navy in light. Use it for
  // accent-colored text/glyphs; keep BRAND.accent (constant cyan) for fills/strokes/borders.
  accentInk: "var(--c-accent-ink)",
  // Inactive (done/stopped) agent name text. The brand "gray" (#8aa0c4) is too light to read
  // on the light sidebar, so this themed token keeps it in dark mode but goes much darker in
  // light. (AGENT_STATUS red/amber stay brand-constant; the green flips via successInk below.)
  agentIdle: "var(--c-agent-idle)",
  // Brand success GREEN as TEXT. #34c759 reads fine on dark navy but is too light on the white
  // light-mode sidebar — so this themed token keeps the brand green in dark and goes to a darker,
  // readable green (#15803d) in light. Use it for green text/glyphs (the "working" status name,
  // the ✓ "Landed" mark, the ahead pill's label/border); keep BRAND.success (constant green) for
  // fills, alpha tints, and status dots, the same split as accentInk vs accent.
  successInk: "var(--c-success-ink)",
  // Brand amber as TEXT, the fourth member of the accentInk/agentIdle/successInk family — except
  // that this one has to move in BOTH themes, which the others don't. #e0982f is a warm mid-tone,
  // and the surface it has to work on is the presence slider's active Away segment: a 16% amber
  // tint over the composer scrim. That plate is mid-gray in light (1.3:1) and mid-navy in dark
  // (3.6:1), so the brand value fails AA on both. Light goes to a dark ochre, dark to a lightened
  // amber; both stay in the amber family, because Away being amber is the point of the control.
  // Use this for amber TEXT only — keep BRAND.amber for fills, tints and borders, which is where
  // amber belongs (everywhere else in the app it is a fill behind dark ink, not ink itself).
  // Measured, not asserted: theme/amberInk.test.ts.
  amberInk: "var(--c-amber-ink)",
  // Brand BLUE as TEXT — the same split as accent/accentInk, and the one the family was missing.
  // BRAND.teal (#2f6bff) is the CTA/fill colour and stays constant wherever it is a SHAPE; as an
  // INK it clears AA in NEITHER theme on the surfaces it is actually read on. It is a saturated mid
  // blue, so it is too dark on light's near-white planes (3.09:1 at worst) AND too dark on dark's
  // near-black ones (3.72:1) — the black-and-gold repaint took `forest` to #05070d and pulled it
  // under there too, which is exactly the accentInk story one hue over. Eighteen `color: C.teal`
  // sites are text or a glyph — the wake-word phrase in the composer placeholder, BoardView's
  // worker lists, the drop pill's clip, SelectionPopup's header — and take this instead. TWO are
  // deliberately still on the brand literal: `WORKFLOW_STAGES`' stage colours, which are a fill in
  // WorkflowLine before they are ever an ink, and one label in `AgentSidebar` that belongs to a
  // concurrent worker's file this pass.
  tealInk: "var(--c-teal-ink)",
  // Brand VIOLET as TEXT, completing the same family. `violet` is the "blocked / stalled on
  // something external" hue and, like teal, only clears AA as a fill (2.60:1 light / 4.42:1 dark).
  //
  // ITS TEXT CONSUMERS ARE NOT REPOINTED YET, stated rather than left to be discovered. The two
  // live ones are `OpenPrMenu.tsx`'s PR chip and its per-PR link, and that file is owned by a
  // concurrent worker this pass, so touching it would just be a merge conflict. The token is added
  // now because the palette merge is the expensive part — cssMirror.test.ts holds both halves in
  // sync from here — and repointing those two `color:` values is a one-line follow-up.
  violetInk: "var(--c-violet-ink)",
  // ALARM RED as TEXT — the fourth instance of the accent/ink split, and the one that was missing.
  // BRAND.sienna is the fill/rail/tint colour and passes through unthemed everywhere it is a
  // SHAPE; as an INK it does not clear the floor at either end. That value paints the nudge card's
  // band badge, i.e. the label on the most urgent thing the column can show. Keep BRAND.sienna for
  // the fill/border/glow side of the split.
  //
  // THE BACKDROP IS THREE LAYERS DEEP, and the first cut of this token only counted two. The badge
  // label is not read on the bare column, nor even on the card: `conciergeSurface`, then the card's
  // `color-mix(sienna 9%…3%)` gradient, then the badge's OWN `color-mix(sienna 16%)` fill. Each
  // tint lifts the backdrop in dark and darkens it in light, so the ink loses ground in both
  // themes. Measured against that full stack, the first pair (dark `#e56a6a` — the prototype's own
  // `--bad` — and light `#b3261e`) came in UNDER the AA floor at both ends, while a test named for
  // exactly this case reported green because it composited only the gradient. Dark is therefore one
  // step brighter than the prototype's `--bad` and light one step deeper, purely to clear the floor
  // on the surface the label is actually read on. Both stops of the gradient are enforced in
  // theme/chromeContrast.test.ts; the badge's own layer is composited there, not assumed.
  dangerInk: "var(--c-danger-ink)",
  // Concierge GOLD as TEXT — the exact same split as accent/accentInk and success/successInk,
  // for the same reason. BRAND.gold (#f5c26b) and BRAND.goldHot (#ffe9b8) are the prototype's
  // accent and are constant across themes; they are correct for TRANSLUCENT tints, glows and the
  // star-field canvas (which needs literal hex and cannot consume var()). As TEXT they only work
  // on the dark shell — #f5c26b on light mode's near-white surfaces is invisible. These themed
  // inks keep the prototype's gold in dark and drop to a deep, readable gold-brown in light
  // (goldHotInk is darker still, so "hot" keeps reading as the stronger emphasis in both themes).
  goldInk: "var(--c-gold-ink)",
  goldHotInk: "var(--c-gold-hot-ink)",
  // SOLID gold — the Send button, the selected palette row's rail, the keycap chiclets, the
  // offline banner, the live mic's border. The third role, and the one a naive repaint gets
  // wrong: the tempting rule is "gold you can SEE THROUGH or sit ON → BRAND.gold", but that rule
  // is written against the near-black DARK shell and BRAND.gold is a literal constant. On light
  // mode's near-white surfaces #f5c26b has no visible edge at all, so the Send button stops
  // reading as a button and the rails stop being rails. Opaque gold therefore has to be themed
  // like every other opaque brand colour: prototype gold in dark, a deep bronze-gold in light.
  // TRANSLUCENT gold (`color-mix(… C.gold …%, transparent)`) still uses the literal — it
  // composites against whatever is behind it and is meant to be a wash.
  goldFill: "var(--c-gold-fill)",
  // Text/icons sitting ON `goldFill` — its partner, and themed WITH it. The prototype's own
  // answer for dark (`.composer .send { color: var(--ink) }`) is its near-black #090b14, which is
  // why a literal is tempting; once the fill goes deep bronze in light, near-black ink on it is
  // the same invisibility one layer in, so light pairs the deep fill with white. The two move
  // together — never pick one and hardcode the other.
  onGoldFill: "var(--c-on-gold-fill)",
  // MIXED — the orange an orchestrator's status disc takes when its workers disagree: some running,
  // some needing you. It is a SHAPE token (a 12px disc), never text.
  //
  // It is deliberately NOT an AGENT_STATUS entry, and that is the important part. There is no PTY
  // state called "mixed"; the color summarizes a SET. AGENT_STATUS's three color tiers are pinned
  // 1:1 to the three filter bands (engine/statusBandLabels.test.ts), so a fourth entry would either
  // need a fourth chip or silently break that agreement — and the two times this taxonomy has been
  // edited casually (`blocked`, `unmerged`) both produced shipped bugs. The rollup keeps its own
  // vocabulary in engine/workerRollup.ts and maps into a band there.
  //
  // Dark reuses the amber the app already carries; light goes to a deep burnt orange, because
  // #ecb968 on light mode's near-white planes has no visible edge — the same split every other
  // opaque brand color takes here. Held to the non-text CONTROL floor on all four planes in
  // theme/chromeContrast.test.ts.
  mixedInk: "var(--c-mixed-ink)",
};

// ── THE CHROME FLOORS ─────────────────────────────────────────────────────────────────────────
// Modelled on CALM_MIN_CONTRAST/CALM_MIN_SPLIT below: the numbers live next to the palette they
// constrain, and theme/chromeContrast.test.ts computes them from the actual hex in BOTH themes so
// a palette edit cannot silently flatten the shell. NO RATIOS ARE WRITTEN IN THE COMMENTS ABOVE
// (the same rule the calm palette learned the hard way) — the test is the only contract.

/** Floor for a chrome SHAPE — `hairline`, `pillFill`, `goldFill` — against the surface it is
 *  drawn on. These are not text, so the bar is separation, not readability. `hairline`/`pillFill`
 *  sit at the pre-repaint forest↔deepForest step (the one four near-black planes collapse, taking
 *  every modal outline and filled pill with it); `goldFill` is held to the stricter WCAG 1.4.11
 *  non-text floor because it is the only thing giving the Send BUTTON an edge. */
export const CHROME_MIN_CONTRAST = 1.5;
/** Floor between ANY two neighbouring slots of the neutral ladder (see THE NEUTRAL LADDER above),
 *  including the pairs no component happens to composite today.
 *
 *  It is deliberately WEAKER than CHROME_MIN_CONTRAST and deliberately STRONGER than any step the
 *  four planes take between neighbours. That is the whole two-tier idea: a pair a component
 *  actually paints on top of itself has to be SEEN (CHROME_MIN_CONTRAST); a pair that merely
 *  coexists in the ladder only has to be TELLABLE APART — but it does have to be tellable apart,
 *  which is precisely what "two distinct values one hair apart" was not. The collapses this catches
 *  measured a whisker over 1.0 while every per-pair floor someone had remembered to write still
 *  reported green, so the guard sweeps the whole ladder rather than a list of remembered pairs. */
export const RAMP_MIN_SPLIT = 1.2;
/** Floor between the THREE COLUMN PLANES in LIGHT mode — terminal (`forest`), concierge column
 *  (`conciergeSurface`), builder column (`deepForest`).
 *
 *  DARK IS DELIBERATELY EXEMPT and that is not an oversight: dark's planes are the prototype's four
 *  near-blacks, a recession ramp that is MEANT to collapse, and `forest` there is also the terminal
 *  background every calm ink is measured against. Light is the opposite case — `forest` is WHITE,
 *  the columns are the only thing telling the eye where one pane ends and the next begins, and the
 *  old spacing (1.16 and 1.18) sat under even RAMP_MIN_SPLIT, the bar this file sets for two chrome
 *  tokens no component ever paints together. That is what "gray-on-gray" was.
 *
 *  IT IS BOXED IN FROM ABOVE, WHICH IS WHY IT IS THIS NUMBER AND NOT A ROUNDER ONE. Contrast
 *  multiplies along a ramp and `forest`↔`deepForest` is pinned BELOW CHROME_MIN_CONTRAST by the
 *  guard that justifies the Improve-Sparkle rail, so the two steps together cannot reach 1.5 and
 *  neither can exceed √1.5 ≈ 1.2247. A floor much above this would make the two guards
 *  unsatisfiable together, i.e. it would force one of them to be deleted — which is the move this
 *  whole file exists to prevent.
 *
 *  IT IS `RAMP_MIN_SPLIT`, NOT A HAIR UNDER IT (roborev 53986). It shipped at 1.18 for one round,
 *  which is BELOW the defect it was written to catch: the old `conciergeSurface`↔`deepForest` step
 *  measured 1.184, so a revert to the exact gray-on-gray spacing stayed green — and 1.18 was also
 *  weaker than the bar this file already applies to two chrome tokens no component composites.
 *
 *  THE CORRIDOR IS NARROW, AND THE REAL NUMBERS ARE HERE RATHER THAN THE WORD "room" (roborev
 *  54019). Light measures 1.2060 (`forest`↔`conciergeSurface`) and 1.2083
 *  (`conciergeSurface`↔`deepForest`) against this 1.2 floor — 0.5% and 0.7% of headroom — and
 *  1.4572 end to end against the 1.5 ceiling, ~2.9%. So light's three planes are pinned to within
 *  about 1% and MUST BE CHANGED AS A SET: nudging one of them alone will go red on the floor below
 *  or the ceiling above, and the fix for one is a violation of the other. That is the intended
 *  state — the box is what stops "make it pop" from quietly deleting a guard — but it is a box, not
 *  a comfortable margin, and anyone re-spacing these should re-derive all three plus the four inks
 *  measured on them. */
export const PLANE_MIN_SPLIT = 1.2;
/** The stricter floor, for a shape that is a control boundary rather than a divider. */
export const CONTROL_MIN_CONTRAST = 3;
/** Floor for any themed INK against the surface it is read on — WCAG AA for normal text. The
 *  reason accentInk / successInk / conciergeMuted / goldInk / dangerInk all exist. */
export const INK_MIN_CONTRAST = 4.5;

// The user's own chat bubble — and, at a dozen other sites, a hovered row's fill, a small inset
// panel, the terminal's selection band, and a 1px border (Terminal, Composer, PinnedPrompt,
// AttachmentTile, SparkleConsentBanner). It is CHROME, and it is held to the chrome floor on every
// plane in theme/chromeContrast.test.ts.
//
// It did not used to be. This pair moved with the black-and-gold repaint (dark #1d3a7a → #1b2033,
// #2c57b0 → #2c3352) and was deliberately EXCLUDED from those floors — so nothing caught that it
// collapsed along with the planes, down to ~1.04–1.16:1 across the whole ramp, while the comment
// below went on promising three readable states. The exclusion was the bug; the floors now cover
// it, and the values are SLOT 1 of the neutral ladder above.
//
// ITS INK IS `cream`, AND THAT IS NOT A LOOSE CLAIM ANYMORE. The cap on this value was once
// justified as "these fills carry `cream` text at every site that uses them", which was false: the
// sidebar's hover card painted this token as a whole CONTENT PANEL and filled it with the column's
// PLANE inks — `muted` labels, a `successInk` landed mark, an `accentInk` path link. No cap on this
// token could have made those legible (see the stated exception in THE NEUTRAL LADDER), so the card
// moved to `barSurface`, where the plane inks are correct by construction. What is left on this
// token is what its name says: chat bubbles and row fills, carrying `cream`.


// ── The washes the concierge paints OVER `conciergeSurface`, as percentages ─────────────────────
// Ink contrast has to be measured against the plate a control actually sits on. Checking it against
// the column's base color flatters every one of these components, and shipping a check that did is
// how an under-AA control got past review once already: the Away segment was measured on
// `barSurface` (the BUILDER's chrome) when it renders on the composer's scrim, which is a full
// stop of contrast away in both themes (roborev 53655-H). These live here, with the palette, so the
// components and theme/amberInk.test.ts composite from ONE number — change a wash and the contrast
// rows re-measure instead of quietly going stale.
/** ComposeBox's scrim over the concierge column — colour and alpha, with the `rgba()` the component
 *  paints DERIVED from both, so a scrim that stops being black can't leave the test measuring black
 *  (roborev 53665-M). */
export const COMPOSE_SCRIM_HEX = "#000000";
export const COMPOSE_SCRIM_PCT = 16;
export const COMPOSE_SCRIM = `rgba(${[1, 3, 5]
  .map((i) => parseInt(COMPOSE_SCRIM_HEX.slice(i, i + 2), 16))
  .join(", ")}, ${COMPOSE_SCRIM_PCT / 100})`;
/** The accent wash behind a concierge CARD (RecapCard). */
export const CARD_WASH_PCT = 6;
/** The tint behind the ACTIVE presence segment — the topmost wash of the stack `amberInk` is tuned
 *  against, so it belongs here rather than as a literal in the component. */
export const PRESENCE_SEGMENT_TINT_PCT = 16;

export const CHAT_USER_BUBBLE = "var(--c-chat-bubble)";

// The starker active-row fill — one notch more contrast than CHAT_USER_BUBBLE so three states read
// at a glance: idle (the bare plane), hovered/expanded (CHAT_USER_BUBBLE), and the row you're
// actually IN (this). Brighter/more-saturated blue in dark, darker blue in light.
//
// Both halves of "three states" are now numbers, not adjectives: each fill clears the chrome floor
// against every plane, AND this one clears it against CHAT_USER_BUBBLE. The second is the one that
// matters here — without it the two can converge while each still reads against its own plane, and
// "one notch more" quietly becomes no notch. Held to the same CHROME_MIN_CONTRAST as every other
// chrome fill rather than a softer constant invented to fit: the pre-repaint dark pair delivered
// 1.598:1, so this restores what the contract was written against.
//
// SLOT 3 of the neutral ladder above — and note that satisfying the pair floor alone is what put
// this value on top of `pillFill`, in both themes, the last time it was re-derived on its own. It
// is placed by the ladder now, so the slot it clears is measured against `pillFill` and `hairline`
// too, not only against the bubble it is "one notch" from. Its ink is `cream`; anything painting
// it with a plane ink is making the mistake CHAT_USER_BUBBLE's note above describes.
//
// NOT to be confused with the AgentSidebar's active ROW, which is `C.forest` — that state reads by
// MERGING into the terminal it opens over, deliberately, and its separation comes from the card's
// hairline outline rather than a fill step. See the note at AgentSidebar's `cardBg`.
export const ROW_ACTIVE_BUBBLE = "var(--c-chat-bubble-active)";

// Map a raw AGENT_STATUS color to a light-mode-legible THEMED ink, for use as TEXT/glyph color.
// The brand gray (idle/done/stopped) and brand green (working) are both too light to read
// on the white light-mode sidebar, so they flip to darker themed tokens in light mode (and keep
// their brand color in dark, via the var()s). Red/amber/violet are already legible in both themes
// and pass through unchanged (`blocked` is red, so its name reads red; `unmerged` is gray). For FILLS
// (status dots, badges) keep the raw brand color instead.
export function statusInk(color: string): string {
  if (color === AGENT_STATUS.done.color) return C.agentIdle; // brand gray
  if (color === AGENT_STATUS.working.color) return C.successInk; // brand green
  return color;
}

// Foreground for text/icons sitting ON a brand-colored fill (e.g. teal). The fill is constant
// across themes, so this must stay light in BOTH — use the brand cream LITERAL, not the themed
// var, which flips to navy ink in light mode and would go low-contrast on teal.
export const ON_BRAND_FILL = BRAND.cream;

// Counterpart for text/icons sitting on a LIGHT brand fill (e.g. the cyan Think button),
// where dark ink reads better than cream. Constant navy in both themes — the fill is constant too.
export const ON_BRAND_FILL_DARK = BRAND.forest;

// Foreground for text/icons sitting ON a GOLD fill — the Send button, the keycap chiclets, the
// offline banner. Kept here rather than inline so the on-gold ink can never drift between the
// surfaces that use it. It is NOT a literal "because the gold fill is constant across themes":
// that premise is what breaks light mode (see `goldFill` above), so the fill and its ink are a
// themed PAIR — prototype gold + near-black ink in dark, deep bronze + white ink in light.
// Anything painting this must paint `C.goldFill` underneath it, or the pairing is a lie.
export const ON_GOLD_FILL = C.onGoldFill;

// Error/alert text (failed browser hand-off, redeem errors). Constant across themes — small
// alert strings on the dark forest/deepForest surfaces. One place so the error UX never drifts
// between the gate, the welcome screen, and the trial pill.
export const DANGER = "#e5484d";

// xterm cannot use CSS var() — it needs concrete hex. Build its theme from THEME_HEX indexed
// by the resolved theme (order-independent, unlike reading the live data-theme). `cursor` is
// the brand accent (constant across themes), so it stays literal from BRAND.
/** The calm inks (PRD §3 / prototype `.terminal.calm .term-body span { color: #7d818e }`),
 *  INDEXED BY THEME (roborev 46341): the prototype's grays were picked against a navy terminal
 *  and go ~3.9:1 on light mode's white background, so light mode gets its own values.
 *  Two luminance levels per theme — `dim` for the dark ANSI slots, `bright` for the bright ones —
 *  so a TUI that paints cell BACKGROUNDS (diff hunks, selected rows) keeps text/background
 *  contrast instead of collapsing to gray-on-identical-gray.
 *
 *  TWO FLOORS, BOTH ENFORCED (roborev 46485-M), because the palette has two jobs that pull apart:
 *   1. every ink ≥ CALM_MIN_CONTRAST against the theme's own `forest` — the common case is text on
 *      the terminal background, and the first cut chose `dim` by "how far can it fall toward the
 *      background", landing too close to the background to read (that cut is why the floor exists — the exact
 *      values live only in xtermTheme.test.ts);
 *   2. `bright` ≥ CALM_MIN_SPLIT against `dim` — the reason the two levels exist at all, so a TUI
 *      that paints cell BACKGROUNDS (diff hunks, selected rows) keeps text/fill contrast instead
 *      of collapsing to gray-on-identical-gray. Raising `dim` to satisfy (1) had quietly crushed
 *      this split below its floor while this comment still claimed it held.
 *
 *  ONE PAIR IS DELIBERATELY UNCOVERED: `ink` over a `dim`-painted fill (default-foreground text on
 *  a cell whose background came from a dark ANSI slot). Satisfying that too would push the band so
 *  far apart that calm stops reading as calm, and it is the rarest combination on screen — a TUI
 *  that paints a background almost always paints its foreground too, which is the pair (2) covers.
 *  NO RATIOS ARE WRITTEN IN THESE COMMENTS (roborev 46897): the first set of annotations was
 *  measurably wrong (a "4.6:1" that was really 6.7:1, "2.1:1" pairs that were 2.03), and a reader
 *  checks the comment before the test. `xtermTheme.test.ts` computes both floors from the actual
 *  hex and is the only contract — inequality assertions ("bright is lighter than dim") are what let
 *  the first regression through, so it asserts numbers.
 *
 *  MARGIN: light mode is the tight one. `bright` has to clear the background floor against WHITE
 *  while staying light enough to read as the brighter of the two levels, which leaves it close to
 *  both limits — nudging either light value is likely to trip a floor, and that is the test's job
 *  to catch. Dark mode has room, so `bright` there sits comfortably clear of `dim` rather than
 *  hugging CALM_MIN_SPLIT — and the black-and-gold repaint gave it MORE room, not less: the dark
 *  terminal background dropped from the old navy to the prototype's near-black `--term #05070d`,
 *  so every dark ink gained contrast against it and the ramp needed no adjustment. (Re-verified
 *  against the new background; xtermTheme.test.ts computes both floors from the actual hex.) */
const CALM = {
  dark: {
    ink: "#7d818e", // the prototype's value
    dim: "#656a77", // recessive, still legible on the near-black terminal
    bright: "#a2a8b5", // clearly above dim — see the margin note below
    selectionForeground: "#c8ccd6",
  },
  light: {
    ink: "#5f6470", // readable on white, still recessive
    dim: "#575c68", // in LIGHT mode the dark ANSI slots read DARKER, not lighter
    bright: "#8b909c", // the lightest ink that still clears the background floor on white
    selectionForeground: "#1f232c",
  },
} as const;

/** Floor for a calm ink against the terminal background it sits on. */
export const CALM_MIN_CONTRAST = 3;
/** Floor between the two calm levels, so a painted-background cell stays readable. */
export const CALM_MIN_SPLIT = 2;

/** Every ANSI slot pointed at a calm gray — flattened hue, preserved luminance ordering. */
function calmAnsi(c: (typeof CALM)["dark" | "light"]) {
  return {
    black: c.dim,
    red: c.dim,
    green: c.dim,
    yellow: c.dim,
    blue: c.dim,
    magenta: c.dim,
    cyan: c.dim,
    white: c.dim,
    brightBlack: c.dim,
    brightRed: c.bright,
    brightGreen: c.bright,
    brightYellow: c.bright,
    brightBlue: c.bright,
    brightMagenta: c.bright,
    brightCyan: c.bright,
    brightWhite: c.bright,
  } as const;
}

/**
 * The xterm theme object. `calm` desaturates the terminal's OWN COLORS — the prototype's treatment
 * — rather than putting a CSS `filter` on an ancestor of the pane (roborev 46254). A filter over
 * the stage costs a full-layer composite on every frame of streaming output (calm is the default
 * state for a `working` agent, i.e. exactly the heavy-output case, and the canvas is WebGL), grays
 * the pane's chrome and the onboarding empty states along with the text, and — because a non-`none`
 * filter makes the element a containing block for `position: fixed` descendants — silently shrank
 * the account-switcher's full-screen click-away backdrop to the stage.
 */
export function xtermTheme(resolved: "light" | "dark", calm = false) {
  const hex = THEME_HEX[resolved];
  const calmC = CALM[resolved];
  return {
    background: hex.forest,
    foreground: calm ? calmC.ink : hex.cream,
    cursor: calm ? calmC.bright : BRAND.accent,
    selectionBackground: hex.chatBubble,
    // While calm the text goes gray, so pin a selection foreground that stays readable over
    // the selection fill (roborev 46341).
    ...(calm ? { selectionForeground: calmC.selectionForeground } : {}),
    // ANSI blue override. xterm's default blue is a light periwinkle that reads fine on the
    // dark-mode navy background but goes low-contrast on the light-mode white background — and
    // TUIs like Claude Code paint headings/links/prompts in (bright) blue. In light mode we
    // pin both to the PRIMARY brand blue (#2f6bff, the right end of the logo's blue→cyan fade),
    // which is dark enough to stay legible on white. Dark mode keeps xterm's defaults.
    ...(resolved === "light" ? { blue: BRAND.teal, brightBlue: BRAND.teal } : {}),
    // LAST, so calm wins: while calm, even the legibility override above is one of the colors
    // being flattened.
    ...(calm ? calmAnsi(calmC) : {}),
  };
}

// Re-export the non-themed runtime VALUES so re-pointed components import one module.
// (Types stay on @sparkle/ui — this module intentionally does not re-export them.)
export { AGENT_STATUS, FONT, FONT_WEIGHT } from "@sparkle/ui";
