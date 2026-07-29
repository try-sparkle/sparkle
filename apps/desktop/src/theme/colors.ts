// Desktop-local theme color layer. The shared @sparkle/ui tokens stay literal hex (mobile
// is React Native and web reads them at build, neither can consume CSS var()), so the
// light/dark switch lives entirely in the desktop app.
//
// THEME_HEX is the ONE place the light/dark hex values live. index.css mirrors these into
// CSS variables (an enforced equality test guards the mirror — see theme.test / index.css),
// and Terminal reads them directly via xtermTheme() because xterm needs concrete hex.
import { C as BRAND, AGENT_STATUS } from "@sparkle/ui";
import { BLUEPRINT } from "./blueprintSpec";

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
// THE RAMP DARKENS LEFT TO RIGHT IN BOTH THEMES, and that is the Blueprint contract. It does NOT
// invert with the theme any more — an earlier version of this paragraph said it did, and that was
// the single most load-bearing false sentence in this file. Reading order is the same sentence
// twice: concierge column (lightest) → bars → builder column → terminal (darkest).
//
//   dark   conciergeSurface #212f4e → barSurface #1c2944 → deepForest #172036 → forest #070b12
//   light  conciergeSurface #ffffff → barSurface #e4eaf4 → deepForest #cbd7e8 → forest #b6c5dc
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
// ── WHICH COLUMN SEAMS GET A DRAWN RULE — DECIDE HERE, NOT AT THE CALL SITE ───────────────────
// The shell has two vertical seams, and for a while the two components carried comments giving
// OPPOSITE answers to the same question, each arguing from a contrast number (roborev 54215).
//
// THE RULE IS NOT DERIVED FROM THE MEASUREMENT, and two rounds were spent proving that the hard
// way. The first version of this block argued from a step size and claimed the two seams sit
// "within 0.02 of each other", carrying a figure that had gone stale when `deepForest` was
// re-derived; the second corrected the figure and wrote four more ratios into a section whose own
// rule is that ratios belong in the test, not the comment. Both are the same mistake.
//
// So there are no numbers here. The seams are NOT the same size — in light they are far apart —
// and it does not matter, because the answer never depended on the step at all. chromeContrast
// measures both pairs; read them there if you need them:
//
//   A seam that something must FLOW THROUGH cannot carry a drawn edge. A seam nothing crosses may.
//
// • builder↔terminal — NO RULE. The active agent row is painted in `forest`, the terminal's own
//   colour, precisely so it reads as an opening INTO the pane it selects, and its concave fillets
//   shape that opening. A 1px line across that seam seals it: the row docks against the rule
//   instead of bleeding through, and the fillets curve into nothing. The step carries the boundary
//   instead, which is why chromeContrast bounds that step from BOTH sides rather than only capping
//   it — an undrawn seam has no fallback if the fill goes flat.
// • concierge↔builder — `hairline`. Nothing crosses it: the concierge column is a closed surface,
//   so a rule costs nothing and buys a crisp edge that does not depend on the fill step at all.
//
// The test for a new boundary is therefore not "how big is the step" but "does anything need to
// pass through it".
//
// ── THE NEUTRAL LADDER IS RETIRED. THE VALUES BELOW COME FROM THE SPEC. ───────────────────────
// This block used to derive the eight neutrals as ONE ladder ordered by distance from the planes,
// and tabulated their hexes. Every one of those hexes is gone — the tokens resolve to
// `BLUEPRINT.*` now, i.e. they are PORTED from the approved direction rather than solved for. The
// old table listed `chatBubble` dark #3c4a6e / light #8ca0c7; the shipped values are #14294a and
// #e8f0fd. Leaving that table here would invite the next reader to re-derive the palette and undo
// the port, which is the exact failure this file's header records.
//
// THREE CLAIMS IN THE OLD BLOCK ARE NOW FALSE, and they are retracted here rather than quietly
// dropped, because each one reads as a rule someone would restore in good faith:
//
//  1. THE ORDERING. "Each chrome slot one step further out than the last" does not hold on this
//     palette, in either theme — slots 2 and 3 are swapped (light luminance .8657 → .6775 → .8339
//     → .6292). It does not sort because these are two FAMILIES, not one ramp: `chatBubble` and
//     `chatBubbleActive` are FILLS (a deliberately shallow hover ramp, 1.035:1 apart, sitting near
//     their ground), while `pillFill` and `hairline` are EDGES, which must read AGAINST the planes
//     and are therefore far from the fills by construction. Interleaving them can only zig-zag.
//  2. COMPOSITED PAIRS CLEARING `CHROME_MIN_CONTRAST`. Measured on this palette, `hairline` on
//     `pillFill` is 1.07 in light. That is not a regression: `seam` #c3d1e6 and `hairSolid`
//     #cbd8ea are ADJACENT BY DESIGN, because this direction separates by LINE WEIGHT, not fill.
//     A floor forcing them apart would rebuild the separate-by-fill model the port removes.
//  3. "chromeContrast.test.ts asserts the ORDER and every gap of the whole ladder." It does not,
//     and it should not. What it asserts today: INK floors on the surfaces ink is read on, EDGE
//     visibility per edge token against the planes it is actually drawn on (the terminal plane has
//     its own `termHairline`), the hover ramp pinned as a ramp, and the spec-fidelity diff in
//     blueprintSpec.test.ts. Separation between fills is no longer a contract.
//
// WHAT REPLACES THE LADDER as the thing that stops reactive nudges: the values are not ours to
// nudge. `theme/blueprintSpec.ts` is the direction transcribed verbatim and `blueprintSpec.test.ts`
// re-reads the spec page and fails on byte drift, so a "make it pop" edit to any neutral below is
// a failing diff against the design rather than an argument about a floor.
//
// ONE PAIRING THE LADDER CANNOT HOLD, stated rather than hidden: `muted` cannot clear the ink
// floor on ANY chrome fill, in either theme, and no choice of values fixes that. In dark every
// slot that clears the FLOOR is already lighter than the darkest backdrop `muted` can be read on;
// in light every slot that clears it is already darker than the lightest one. `muted` is a
// PLANE ink. Surfaces that carry it belong on a plane — which is why the sidebar's hover card
// moved to `barSurface`, and why the three 10px secondary lines on AgentPane's selected account
// row take `cream` there instead. See theme/chromeContrast.test.ts for the measurement.
//
// ── LIGHT'S PLANES ARE A RAMP TOO, AND EVERY ADJACENT PAIR NOW CLEARS THE FLOOR ────────────────
// The founder's complaint about light mode was "a mishmash of shades … gray-on-gray". The first
// repaint answered it for the three COLUMNS and left a hole: the guard swept
// forest → conciergeSurface → deepForest, which under the new ordering are not adjacent at all, so
// it measured the ramp's two ENDS (1.590) and called it one step. The pairs it never looked at were
// the two that had collapsed — conciergeSurface↔barSurface at 1.098 and barSurface↔deepForest at
// 1.109 — steps the retired PLANE_MIN_SPLIT floor would have rejected. `barSurface` is not a
// bystander there: it is what every bar,
// every dialog and every INACTIVE AGENT CARD is painted in, so that is exactly where the gray-on-gray
// had moved to. Light's four planes are now derived as one ladder, every adjacent pair measured:
//
//     conciergeSurface → barSurface 1.209   → deepForest 1.204   → forest 1.201   (1.749 end to end)
//
// DARK IS DELIBERATELY LEFT COLLAPSED (1.091 / 1.119 / 1.216, 1.484 end to end) and that asymmetry
// is a decision, not an oversight. Dark's planes are four near-blacks meant to RECEDE, per the ramp
// section above, and the arithmetic agrees: widening dark to a 1.2 ladder lifts the chrome FLOOR
// (every slot must clear CHROME_MIN_CONTRAST against the lightest plane) above the point where the
// CAP still holds — `cream` stops reading on `chatBubbleActive`. The ladder and the ink cap cross,
// so there is no solution, and chromeContrast sweeps light only. PRD/sparkle/ui-directions/derive.mjs
// re-derives this from the floors; solve.mjs encodes the same exemption so the tooling predicts the
// guard instead of contradicting it.
//
// THE CEILING IS NOT A PREFERENCE, IT IS ANOTHER GUARD — but it is a ceiling on ONE ADJACENT PAIR,
// not on the ramp end to end. `forest`↔`deepForest` must stay BELOW CHROME_MIN_CONTRAST in both
// themes (1.216 dark, 1.201 light): that is the ACTIVE ROW's fill step, and it has to read as a
// plane step rather than as a chrome fill. The former version of this paragraph turned it into an
// end-to-end cap of 1.5 and derived "each step at √1.5 ≈ 1.2247" from it — which was true of a
// three-plane ramp and became false the moment `barSurface` joined as a rung. Four planes at 1.2
// span ~1.75 by construction; that is the ramp working, not a violated ceiling.
//
// INKS MOVED WITH THE PLANES, because their floors are measured ON them. Light's plane ladder
// darkened `forest` from #ffffff to #b6c5dc, which cost every ink read on it ~1.55×, so `muted` /
// `conciergeMuted` / `agentIdle` and `mixedInk` were re-derived, `cream` went darker to buy the
// chrome fills room under the ink cap, and the terminal's calm band was re-solved against the new
// terminal plane. Each was derived against the NEW surface — see ui-directions/inks.mjs — not
// nudged until a test went quiet. `DANGER` stopped being a literal in the same pass, for the same
// reason: see its own note below.
export const THEME_HEX = {
  // ── THE PLANES AND CHROME COME FROM THE SPEC, NOT FROM A SOLVER ─────────────────────────────
  // Every surface/edge/accent below is `BLUEPRINT[mode].<token>` — the approved direction, read as
  // data (theme/blueprintSpec.ts) and checked against the spec page itself by blueprintSpec.test.
  // The values these replaced were DERIVED by a contrast solver, and three releases shipped looking
  // nothing like the design because a derived palette is a different palette however rigorous the
  // derivation.
  //
  // The STATUS inks are not in the spec and stay semantic: the direction's mock never shows an
  // error, a blocked agent or a mixed-status disc, so there is nothing to port. They keep their
  // own floors (statusInk / chromeContrast).
  dark: {
    inputSurface: BLUEPRINT.dark.input,
    dialogSurface: BLUEPRINT.dark.dialog,
    dialogNav: BLUEPRINT.dark.dialogNav,
    dialogEdge: BLUEPRINT.dark.dialogEdge,
    inputEdge: BLUEPRINT.dark.inputEdge,
    termHairline: BLUEPRINT.dark.termHair,
    forest: BLUEPRINT.dark.term, deepForest: BLUEPRINT.dark.bridge,
    conciergeSurface: BLUEPRINT.dark.assist, barSurface: BLUEPRINT.dark.bar,
    conciergeMuted: BLUEPRINT.dark.muted, muted: BLUEPRINT.dark.muted,
    // agentIdle is READ AS TEXT, not just painted as a dot: statusInk() maps idle/done/stopped to
    // it and BandBadge colours its count with it. The spec's `faint` tier is a hairline/label
    // grey (3.68 on the concierge column, 2.85 on the terminal plane) and fails AA at every one
    // of those sites. `muted` is the spec's readable secondary ink; that is the right tier here.
    agentIdle: BLUEPRINT.dark.muted, cream: BLUEPRINT.dark.ink,
    hairline: BLUEPRINT.dark.seam, pillFill: BLUEPRINT.dark.hairSolid,
    chatBubble: BLUEPRINT.dark.bubble, chatBubbleActive: BLUEPRINT.dark.sel,
    accentInk: BLUEPRINT.dark.primary, goldInk: BLUEPRINT.dark.primary,
    tealInk: BLUEPRINT.dark.primary, goldHotInk: BLUEPRINT.dark.primary,
    goldFill: BLUEPRINT.dark.primary, onGoldFill: BLUEPRINT.dark.onPrimary,
    successInk: "#34c759", dangerInk: "#f4968f", amberInk: "#ecb968",
    mixedInk: "#ecb968", violetInk: "#a185f5",
  },
  light: {
    inputSurface: BLUEPRINT.light.input,
    dialogSurface: BLUEPRINT.light.dialog,
    dialogNav: BLUEPRINT.light.dialogNav,
    dialogEdge: BLUEPRINT.light.dialogEdge,
    inputEdge: BLUEPRINT.light.inputEdge,
    termHairline: BLUEPRINT.light.termHair,
    forest: BLUEPRINT.light.term, deepForest: BLUEPRINT.light.bridge,
    conciergeSurface: BLUEPRINT.light.assist, barSurface: BLUEPRINT.light.bar,
    conciergeMuted: BLUEPRINT.light.muted, muted: BLUEPRINT.light.muted,
    agentIdle: BLUEPRINT.light.muted, cream: BLUEPRINT.light.ink,
    hairline: BLUEPRINT.light.seam, pillFill: BLUEPRINT.light.hairSolid,
    chatBubble: BLUEPRINT.light.bubble, chatBubbleActive: BLUEPRINT.light.sel,
    accentInk: BLUEPRINT.light.primary, goldInk: BLUEPRINT.light.primary,
    tealInk: BLUEPRINT.light.primary, goldHotInk: BLUEPRINT.light.primary,
    goldFill: BLUEPRINT.light.primary, onGoldFill: BLUEPRINT.light.onPrimary,
    successInk: "#0d5326", dangerInk: "#8f1d16", amberInk: "#664200",
    mixedInk: "#ab4e07", violetInk: "#5636b8",
  },
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
  // THE INPUT FIELD'S OWN GROUND — the spec's `--k-input`, white in light and a deep navy in dark.
  //
  // It exists as a `C` token because the concierge's COMPOSER sits on it, and that is the one
  // surface in the column whose plate the contrast suite already models (theme/amberInk.test.ts's
  // `composerPlate`). That box used to be a 16% black SCRIM over the concierge column instead,
  // which in light mode dropped `conciergeMuted` to 4.23 — under AA — on the box you type into.
  // The approved direction does not scrim the composer at all: it gives the input its own surface
  // with an edge rule around it, which is both the faithful reading and the one that clears the
  // floor. Do not reintroduce the scrim.
  //
  // The var is already in index.css (mirrored from THEME_HEX.inputSurface); this only names it for
  // component inline styles, which is why adding it needs no CSS edit.
  // Lighter chrome for the top bar + composer box. Kept distinct from (lighter than) deepForest
  // so those bars recede against the terminal while the sidebar stays a step darker. See
  // THEME_HEX above.
  barSurface: "var(--c-bar-surface)",
  // THE FIELD GROUND. `inputSurface` has been in THEME_HEX and mirrored into index.css since the
  // spec was ported, and no component ever read it — `C` had no entry, so there was nothing to
  // import. Every text field in the app therefore painted some nearby plane instead. Exposed here
  // because the settings search box is its first real consumer; pair it with `inputEdge`.
  inputSurface: "var(--c-input-surface)",
  // ── THE MODAL PLANE — `dialog` / `dialogNav`, AND WHY IT IS NOT `deepForest` ──────────────────
  // Roughly thirty dialogs paint here, and until now every one of them borrowed the BUILDER column's
  // plane (`deepForest`) because that was the nearest thing to a "secondary surface". The spec has
  // never agreed: `--k-dialog` is its OWN token, and in both themes it equals the GROUND, not the
  // builder column. A modal is not a panel inside the shell — it floats above the whole shell, so it
  // takes the paper the shell is drawn on and separates itself with a rule and a shadow, exactly the
  // mechanism the direction uses everywhere else.
  //
  // The consequence is visible: in LIGHT, `deepForest` is #f2f6fd and `dialog` is #ffffff, so every
  // dialog had been painted one plane too dark. In DARK the two are the other way round.
  //
  // `dialogNav` is the settings dialog's category RAIL (`.dlg .nav` in the spec page) — the one
  // interior register a dialog gets, and it is a hair off the surface rather than a step. Do not
  // "improve" that separation by darkening it: the rule between them is what divides them, and
  // theme/dialogContrast.test.ts pins BOTH halves of that claim.
  dialogSurface: "var(--c-dialog-surface)",
  dialogNav: "var(--c-dialog-nav)",
  // THE MODAL'S OWN OUTLINE. Distinct from `hairline` (the shell's column seam) because in dark the
  // spec draws it a full step stronger — a floating surface needs a harder boundary than an interior
  // rule. Use this for the outer border of a modal; use `hairline` for the rules INSIDE it.
  dialogEdge: "var(--c-dialog-edge)",
  // THE RULE AROUND AN INPUT. Every text field, search box and select in the app had been outlined in
  // `hairline` — the token whose job is the column seam. The spec gives inputs their own edge, and
  // wiring it is what stops a retune of the shell's seam silently restyling every form control.
  inputEdge: "var(--c-input-edge)",
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
  // The ACCENT as TEXT — the exact same fill/ink split as accent/accentInk and success/successInk,
  // for the same reason.
  //
  // THE NAME SAYS GOLD AND THE VALUE IS BLUE. That is deliberate, and this is the note that stops
  // it reading as a bug. Blueprint retired gold entirely — one accent, and it is blue — but the
  // four token NAMES survive because they carry a documented three-role split (translucent tint /
  // themed ink / opaque fill + its partner ink) that is threaded through a dozen call sites and is
  // still exactly right. It was the HUE that changed, not the structure; renaming them would bury
  // a behavioural change in a hundred-file mechanical diff. chromeContrast asserts that no gold
  // literal can come back, and that every one of these is blue-dominant in both themes.
  //
  // BRAND.gold / BRAND.goldHot are the constant-across-themes literals — correct for TRANSLUCENT
  // tints, glows and the star-field canvas, which needs real hex and cannot consume var(). As TEXT
  // a single constant cannot serve both themes, which is what these themed inks are for.
  goldInk: "var(--c-gold-ink)",
  goldHotInk: "var(--c-gold-hot-ink)",
  // SOLID accent — the Send button, the selected palette row's rail, the keycap chiclets, the
  // offline banner, the live mic's border. The third role, and the one a naive repaint gets wrong:
  // the tempting rule is "accent you can SEE THROUGH or sit ON → the BRAND literal", but that rule
  // is written against the near-black DARK shell, and the literal is constant. On light mode's
  // near-white surfaces a light accent has no visible edge at all, so the Send button stops reading
  // as a button and the rails stop being rails. Opaque accent therefore has to be themed like every
  // other opaque brand colour: a bright blue in dark, a deep saturated blue in light.
  // TRANSLUCENT accent (`color-mix(… C.gold …%, transparent)`) still uses the literal — it
  // composites against whatever is behind it and is meant to be a wash.
  goldFill: "var(--c-gold-fill)",
  // Text/icons sitting ON `goldFill` — its partner, and themed WITH it. Dark pairs the bright fill
  // with near-black ink; light pairs the deep fill with white. Picking one and hardcoding the other
  // is the failure this pairing exists to prevent — they move together.
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

// ── THE OVERLAY SCRIM AND THE MODAL SHADOW ────────────────────────────────────────────────────
// These two are spec tokens like every other value above, but they are NOT hex — `scrim` is an
// `rgba()` and `shadow` is a whole `box-shadow` — so they cannot live in THEME_HEX. That object is
// mirrored into the `--c-*` block by a test that parses `#rrggbb` and asserts KEY-SET equality, and
// a non-hex entry there would be a key with no parseable value: the mirror would report a missing
// var for something index.css actually declares.
//
// So they take the spec's OWN prefix in index.css (`--k-scrim` / `--k-shadow`), which also says what
// they are — untransformed spec values rather than app-derived tokens. They are not left as literals
// because that is precisely the state this repaint is undoing: eleven dialogs each carried their own
// hand-typed `rgba(0,0,0,0.5)` and `0 20px 60px rgba(0,0,0,0.5)`, none of them themed, so the scrim
// over light mode's near-white shell was the same flat black as over dark's navy. `cssMirror.test.ts`
// holds both against `BLUEPRINT[mode]` the same way it holds the hex.
export const SCRIM = "var(--k-scrim)";
export const MODAL_SHADOW = "var(--k-shadow)";

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
/** Floor for a drawn EDGE against the surface it is drawn on.
 *
 *  THIS IS THE FLOOR THAT MATTERS IN THIS DESIGN. The approved direction separates registers by
 *  LINE WEIGHT, not by fill — the assistant column and the ground are the same colour in light
 *  mode — so an invisible rule means an invisible boundary. It is deliberately LOWER than the old
 *  `CHROME_MIN_CONTRAST`: a hairline is a 1px line the eye resolves against its ground, not a
 *  filled shape that has to hold its own area, and the spec's own seams measure in the 1.2–1.6
 *  band. Held by theme/chromeContrast.test.ts on every plane in both themes.
 */
export const EDGE_MIN_CONTRAST = 1.2;

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
/** THE DIALOG PLANE'S CEILING — an UPPER bound, and the only constant in this file that is one.
 *
 *  A dialog's body and its nav rail must stay CLOSE: structure is drawn, not filled, so the rule
 *  between them is what divides them. theme/dialogContrast.test.ts asserts `toBeLessThan` on this.
 *
 *  IT IS ITS OWN CONSTANT. For one round it borrowed the since-DELETED `PLANE_MIN_SPLIT`
 *  (roborev 54686), a trap pointing the wrong way: that was a FLOOR on how far apart adjacent
 *  shell planes must be, and a ceiling reading it meant anyone raising the floor to strengthen the
 *  shell's planes would have silently LOOSENED this ceiling — the one edit most likely to be made
 *  in good faith
 *  would have unlocked "the rail looks too subtle, let me darken it" — the exact regression the
 *  ceiling exists to block.
 *
 *  The number coinciding with the floor's today is a coincidence of this palette, not a relationship.
 *  They are free to move independently, which is the whole point of separating them. */
export const DIALOG_MAX_FILL_SPLIT = 1.2;

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

// Foreground for text/icons sitting ON the opaque accent fill — the Send button, the keycap
// chiclets, the offline banner. Kept here rather than inline so the on-fill ink can never drift
// between the surfaces that use it. It is NOT a literal "because the fill is constant across
// themes": that premise is what breaks light mode (see `goldFill` above), so the fill and its ink
// are a themed PAIR — bright blue + near-black ink in dark, deep blue + white ink in light.
// Anything painting this must paint `C.goldFill` underneath it, or the pairing is a lie.
export const ON_GOLD_FILL = C.onGoldFill;

// Error/alert text and edges (failed browser hand-off, redeem errors, the define-stage banner's
// border). One place so the error UX never drifts between the gate, the welcome screen, and the
// trial pill.
//
// IT IS NOT A CONSTANT ANY MORE, and the reason is worth keeping. It used to be the literal
// `#e5484d` under a comment reading "constant across themes — small alert strings on the dark
// forest/deepForest surfaces". Blueprint falsified the premise in that sentence: light `forest`
// is no longer white but a mid blue-grey, and `forest` is the plane roughly thirty dialogs and
// cards paint. The literal measured 3.914 on the old white and 2.461 on the new plane — under
// CONTROL_MIN_CONTRAST, at every one of those sites at once, including a `1px solid DANGER`
// border whose own comment claimed it cleared 3:1.
//
// The themed twin already existed for exactly this: `dangerInk` is derived per theme and clears
// AA on all four planes in both (see chromeContrast). Pointing DANGER at it fixes every call
// site in one move instead of thirty, and means the next plane move is caught by the ink sweep
// rather than by a reviewer reading call sites. Ink and edges only — nothing paints DANGER as a
// FILL, which is why a var() is safe here.
export const DANGER = C.dangerInk;

// xterm cannot use CSS var() — it needs concrete hex. Build its theme from THEME_HEX indexed
// by the resolved theme (order-independent, unlike reading the live data-theme). `cursor` is
// the brand accent (constant across themes), so it stays literal from BRAND.
/** The calm inks (PRD §3 / prototype `.terminal.calm .term-body span { color: #7d818e }`),
 *  INDEXED BY THEME (roborev 46341): the prototype's grays were picked against a navy terminal and
 *  do not survive a light terminal plane, so light mode gets its own values. Blueprint darkened
 *  that plane from white to `#b6c5dc`, which re-solved this band a second time — see the note on
 *  the two floors below, and ui-directions/inks.mjs for the derivation.
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
    ink: "#5f6470", // readable on the light terminal plane, still recessive
    dim: "#31353d", // in LIGHT mode the dark ANSI slots read DARKER, not lighter
    bright: "#62666f", // the lightest ink that still clears the floor on the light terminal
    selectionForeground: "#1f232c",
  },
} as const;

/** Floor for a calm ink against the terminal background it sits on. */
/**
 * The two edge weights that carry the command palette badge's KIND (prompt vs everything else).
 *
 * IT LIVES IN `theme/`, NOT IN THE COMPONENT, and the direction matters. It was exported from
 * `CommandPalette.tsx` so `chromeContrast.test.ts` could stop keeping its own copy — which fixed
 * the duplication but inverted the layering: a pure-arithmetic guard running in the NODE
 * environment began importing a React component module, dragging in react, react-icons, the
 * history/credits services and four zustand stores just to read two integers. `projectStore`
 * instantiates a `persist`-wrapped store at import time, so the contrast guard became hostage to
 * any future module-scope DOM or Tauri touch anywhere in that subtree (roborev 54266). `theme/` is
 * the leaf every component imports; the constant belongs at the leaf.
 *
 * Whole percentages, matching the `color-mix(… N%, transparent)` they are interpolated into.
 * `chromeContrast.test.ts` measures both weights composited over the surfaces the badge actually
 * renders on, and `CommandPalette.test.tsx` asserts the rendered border still consumes THIS
 * constant — the two together are what make an edit to the weight observable.
 */
export const BADGE_EDGE_PCT = { prompt: 85, other: 45 } as const;

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
