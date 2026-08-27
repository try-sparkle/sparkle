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
    conciergeSurfaceLifted: BLUEPRINT.dark.assistLift,
    conciergeMuted: BLUEPRINT.dark.muted, muted: BLUEPRINT.dark.muted,
    // agentIdle is READ AS TEXT, not just painted as a dot: statusInk() maps idle/done/stopped to
    // it and BandBadge colours its count with it. The spec's `faint` tier is a hairline/label
    // grey (3.68 on the concierge column, 2.85 on the terminal plane) and fails AA at every one
    // of those sites. `muted` is the spec's readable secondary ink; that is the right tier here.
    agentIdle: BLUEPRINT.dark.muted, cream: BLUEPRINT.dark.ink,
    // THE LABEL INK OF A CLICKABLE PILL. Same value as `cream` — deliberately, and it is a
    // SEPARATE TOKEN precisely so it can be overridden separately. See `C.pillInk`.
    pillInk: BLUEPRINT.dark.ink,
    hairline: BLUEPRINT.dark.seam, pillFill: BLUEPRINT.dark.hairSolid,
    chatBubble: BLUEPRINT.dark.bubble, chatBubbleActive: BLUEPRINT.dark.sel,
    // A LITERAL, not a BLUEPRINT slot, and deliberately so: the direction has no "black" register —
    // its darkest plane is the terminal's `term` (#030913 dark / #d9e3f3 light), which is a THEMED
    // pair and therefore the opposite of what this token is for. See CHAT_SENT_BUBBLE below.
    chatBubbleSent: "#000000",
    accentInk: BLUEPRINT.dark.primary, goldInk: BLUEPRINT.dark.primary,
    tealInk: BLUEPRINT.dark.primary, goldHotInk: BLUEPRINT.dark.primary,
    goldFill: BLUEPRINT.dark.primary, onGoldFill: BLUEPRINT.dark.onPrimary,
    successInk: "#34c759", dangerInk: "#f4968f", amberInk: "#ecb968",
    mixedInk: "#ecb968", violetInk: "#a185f5", questionsInk: "#7dd3fc",
    // See the EPIC CARD block below `C` for why these three exist and how each value was derived.
    epicCardFill: "#1d3362", epicPillFill: "#e0982f", onEpicPillFill: "#0a1a3f",
    // EVERY OTHER TYPE'S PILL — cool slate, so the epic's warm badge stays the loud one.
    typePillFill: "#7690b9", onTypePillFill: "#04101f",
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
    conciergeSurfaceLifted: BLUEPRINT.light.assistLift,
    conciergeMuted: BLUEPRINT.light.muted, muted: BLUEPRINT.light.muted,
    agentIdle: BLUEPRINT.light.muted, cream: BLUEPRINT.light.ink,
    pillInk: BLUEPRINT.light.ink,
    hairline: BLUEPRINT.light.seam, pillFill: BLUEPRINT.light.hairSolid,
    chatBubble: BLUEPRINT.light.bubble, chatBubbleActive: BLUEPRINT.light.sel,
    // THE SAME BLACK IN BOTH THEMES — not an oversight. The founder asked for a black card, and a
    // card that is black in one theme and pale in the other is not the affordance he asked for: it
    // would stop being recognisable as "this one left the room" the moment he switched appearance.
    // It stays a TOKEN rather than a bare constant so the two halves can be split later without
    // touching a component (which is exactly the decision still open — see CHAT_SENT_BUBBLE).
    chatBubbleSent: "#000000",
    accentInk: BLUEPRINT.light.primary, goldInk: BLUEPRINT.light.primary,
    tealInk: BLUEPRINT.light.primary, goldHotInk: BLUEPRINT.light.primary,
    goldFill: BLUEPRINT.light.primary, onGoldFill: BLUEPRINT.light.onPrimary,
    successInk: "#0d5326", dangerInk: "#8f1d16", amberInk: "#664200",
    mixedInk: "#ab4e07", violetInk: "#5636b8", questionsInk: "#075985",
    // LIGHT DIFFERENTIATES BY HUE, NOT BY LUMINANCE — see the EPIC CARD block below `C`.
    epicCardFill: "#dce0ff", epicPillFill: "#664200", onEpicPillFill: "#ffffff",
    // The cool-slate pair, inverted for light: a DARK fill under white ink, because every
    // ground it sits on here is pale. See the block below `C`.
    typePillFill: "#546b8e", onTypePillFill: "#ffffff",
  },
} as const;

// ── SCOPING A TOKEN TO A SUBTREE: THE TWO CLAUSES, AND WHY ONE LINE IS NEVER ENOUGH ───────────
// (bead sparkle-cxekz, seen 8× — twice as a shipped, invisible defect one level apart)
//
// Redefining a `--c-*` token on an element is the sanctioned way to re-ink a subtree: no prop is
// threaded, no component below knows the override exists, and there is exactly one definition.
// SentToAgentRow.SENT_CARD_INK_VARS and NoticeAttribution.NOTICE_INK_VARS both do it. But a custom
// property is resolved at the element that NAMES it, and that is a much smaller population than
// "the subtree":
//
//   • a descendant writing `color: C.cream` resolves `var(--c-cream)` HERE, and re-inks. ✅
//   • a descendant writing NO `color` inherits a COMPUTED rgb value from whatever ancestor last
//     declared one — for this app, ConciergeColumn's `color: C.cream` on the section. That value
//     was resolved against the THEME's token, far ABOVE the override. Redefining the token below
//     cannot reach back and re-resolve it. ❌
//
// So the two halves of one subtree land on OPPOSITE sides of the same ground, silently. Measured:
// a card pinned its inks, the labels and pills followed, and the founder's own message body stayed
// near-black ON BLACK. Then again one level down, in the same shape.
//
// THE RULE. A scoped override of an ink token MUST carry both of these on the SAME element:
//
//   1. `color`, naming the token pinned in that very object — so inherited text re-resolves here
//      instead of keeping the value it computed upstairs. Write the token, not the literal, so
//      there is still one definition.
//   2. a pin for every FILL a descendant paints FOR ITSELF. `color` cannot reach those: the
//      descendant declares its own `background`, so it inherits nothing, and pinning only the ink
//      puts a fixed-dark label on a themed pale chip (~1.07:1 — the second measured instance).
//      CHAT_SENT_FILL below is that clause applied, and records which fills need no pin and why.
//
// Clause 1 is enforced by `scripts/scoped-ink-override-check.sh` (test:
// scripts/tests/scoped-ink-override-check.test.sh), which fails a declaration block that redefines
// a token some element declares as a `color` without declaring `color` beside it. Clause 2 is NOT
// mechanically decidable — knowing which descendants paint their own ground means knowing what
// renders inside the subtree — so it stays here, and it stays on you. A block that genuinely wants
// an unpaired override says so with `scoped-ink-ok` in a comment inside it.
//
// ⚠ NOT EVERY INK TOKEN BELONGS IN A GIVEN OVERRIDE. `--c-pill-ink` exists precisely so a row that
// re-inks its prose does not also grey a clickable pill's label: a GROUND change pins it, an
// EMPHASIS change must not. See C.pillInk and NOTICE_INK_VARS' own note.

// Themed token object for component inline styles. The four theme-dependent tokens become
// var()-based, so a single `data-theme` flip on <html> re-themes the whole app through CSS
// with no React re-render. Everything else (teal, amber, accent, status, …) is brand
// identity, unchanged across themes, and passes through as literal hex from BRAND.
export const C = {
  ...BRAND,
  forest: "var(--c-forest)",
  /**
   * TEXT ON A BRAND FILL — the ink tier `ON_BRAND_FILL_DARK` has always been, finally NAMED.
   *
   * Same value, byte for byte: `BRAND.forest`, the CONSTANT navy. This adds no colour and changes no
   * pixel; what it adds is a name the contrast guard can VERIFY.
   *
   * ⚠️ CONSTANT, NOT THEMED, AND THE FIRST CUT OF THIS GOT IT WRONG. Two different values are named
   * `forest`: `THEME_HEX.forest` is the THEMED terminal surface, while `BRAND.forest` — what
   * `ON_BRAND_FILL_DARK` actually is — is constant navy in both themes. Pointing this token at the
   * themed one flipped light mode's banner text to near-WHITE on a constant sienna fill, which is
   * verbatim the low-contrast failure `ON_BRAND_FILL`'s own comment warns about. It is constant for
   * the reason stated there: THE FILL IS CONSTANT TOO, so its ink must not move under it. That is
   * also why it is a literal here rather than a `var(--c-*)` — it needs no `THEME_HEX` entry and no
   * CSS mirror, because there is nothing to theme.
   *
   * Measured, sRGB relative luminance per WCAG 2.x — the numbers are why this is not a style call:
   *
   *                  constant #0a1a3f     themed light #d9e3f3
   *   on `C.amber`           7.06                     1.87   <- near-invisible
   *   on `C.sienna`          4.45                     2.96
   *
   * `theme/statusInk.test.ts` pins all of it: byte-identity with `ON_BRAND_FILL_DARK`, that this is
   * a constant absent from both `THEME_HEX` palettes, and that it BEATS the themed value on BOTH
   * fills — asserting merely "it is dark" would not have caught the substitution.
   *
   * WHY IT HAD TO EXIST. `theme/linkContrast.test.ts` fails CLOSED — "an expression that cannot be
   * traced to an ink is not evidence of safety" — and it traces by looking for a `C.<name>` matching
   * `/.*Ink|muted|…/`. A bare module export carries no such token, so `color: ON_BRAND_FILL_DARK` on
   * an underlined element was unverifiable and red on the default branch, blocking every PR cut from
   * it. The two obvious escapes were both wrong: `statusInk(C.sienna)` returns `C.dangerInk`, i.e.
   * red text on a red fill, and widening the guard's allowlist to admit a bare export would trade a
   * measurable rule for an unmeasurable one.
   *
   * So the fix is the one the guard's own message asks for: point it at an ink token. Use this
   * wherever text sits on `C.sienna` / `C.amber` / any saturated brand fill.
   */
  onFillInk: BRAND.forest,
  deepForest: "var(--c-deep-forest)",
  // The concierge column — the lightest of the shell's three depth layers. See THEME_HEX above.
  conciergeSurface: "var(--c-concierge-surface)",
  // …AND THE SURFACE IT ACTUALLY PAINTS WHILE UNMOUNTED. `conciergeSurface` is the column's
  // surface in the abstract and is still what the ink tokens above are measured against; this is
  // the UNWIRED state's fill. Wired, the column floods to `forest` and neither applies.
  //
  // In LIGHT the two are the same #ffffff — there is nothing above white, and the lift shadow
  // does the separating. In DARK this is a real step (+16.3% L*), which is what stops the
  // unplugged concierge reading as one more dark column. See blueprintSpec's `assistLift`.
  //
  // THE LIFTED PLANE IS THE STRICTER ONE FOR INK — measure against BOTH, and if you only have the
  // budget for one, measure this. Dark is the only theme where the two differ, and dark reads LIGHT
  // ink on a DARK plane, so lightening the plane REDUCES contrast: `conciergeMuted` falls 6.71 →
  // 6.48, `faint` 4.07 → 3.93, `hairline` 1.66 → 1.60. Nothing breaks at these values, but the
  // implication runs the opposite way to the intuition — clearing the floor on `conciergeSurface`
  // does NOT imply clearing it here.
  //
  // `theme/chromeContrast.test.ts` sweeps the concierge inks over both planes for exactly this
  // reason. Keep it that way: a guard pinned only to `conciergeSurface` stops measuring the surface
  // the unwired column actually paints.
  conciergeSurfaceLifted: "var(--c-concierge-surface-lifted)",
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
  inputSurface: "var(--c-input-surface)",
  // Lighter chrome for the top bar + composer box. Kept distinct from (lighter than) deepForest
  // so those bars recede against the terminal while the sidebar stays a step darker. See
  // THEME_HEX above.
  barSurface: "var(--c-bar-surface)",
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
  /**
   * ══ THE LABEL INK OF A CLICKABLE PILL — AND WHY IT IS NOT `cream` ═════════════════════════════
   *
   * Identical in value to `cream` in both themes. It exists as its OWN token for one reason: a row
   * can redefine the ink of its whole subtree, and the two rows in this app that do so want
   * OPPOSITE things from a pill.
   *
   *   • `SentToAgentRow.SENT_CARD_INK_VARS` changes the GROUND — a card that is black in both
   *     themes. A pill on it MUST follow, or in light mode its label is near-black on black. That
   *     row therefore pins `--c-pill-ink` too.
   *   • `NoticeAttribution.NOTICE_INK_VARS` changes only the EMPHASIS — an app-authored line
   *     addressed to the concierge, drawn in secondary ink because the founder is reading over its
   *     shoulder. A pill inside it must NOT follow, and that row leaves this token alone.
   *
   * THE BUG THAT SPLIT THEM (bead sparkle-s6gonk). Every pill painted `C.cream`, so the de-emphasis
   * reached the pill's label while the STATUS DOT beside it — which resolves `bandColor(band)`,
   * an entirely different token — kept its colour. A live, working agent therefore rendered as a
   * GREEN DOT next to a GREY NAME, and the founder read the grey as "this agent is no longer
   * relevant" and stopped believing the pill was clickable. His words: *"is it grayed out because
   * it's no longer relevant? Is that what's going on?"*
   *
   * THE RULE THIS TOKEN ENCODES, chosen by the founder on 2026-08-20 and applied everywhere a pill
   * renders: **the DOT alone carries status; the LABEL is plainly neutral.** A pill's label never
   * varies with the agent's band and never varies with the surrounding row's emphasis, so a pill
   * always reads as the live control it is. The one exception is deliberate and is not a status
   * colour at all: a pill whose target is genuinely gone (`AgentPill`'s `quiet` form) is not a live
   * control, and says so in muted ink.
   */
  pillInk: "var(--c-pill-ink)",
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
  // sites are text or a glyph — the emphasised phrase in the composer placeholder, BoardView's
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
  // The BLUE status tier (`questions`) as TEXT. Same job dangerInk does for red: BRAND.azure
  // (#38bdf8) is a FILL color chosen to read on an 8px dot, and it is far too pale as text on
  // light's white column. These are the themed twins — #7dd3fc measures 10.2:1 on the dark shell,
  // #075985 measures 7.6:1 on white. Paint dots with C.azure and words with this.
  questionsInk: "var(--c-questions-ink)",
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
  // ── THE EPIC CARD ────────────────────────────────────────────────────────────────────────────
  // The founder: "I want epic cards to have a different colored background than regular cards" —
  // an epic must read as structurally different from a task AT A GLANCE, not only by its
  // affordances. An ordinary card is `forest`; an epic card is this.
  //
  // THE TWO THEMES SOLVE DIFFERENT PROBLEMS, and that is why this is a themed token rather than one
  // literal. Dark had room to go LIGHTER, which is what was asked for: `#1d3362` sits 1.62:1 off
  // `forest` (above CHROME_MIN_CONTRAST, so the step is a guarantee and not a matter of taste)
  // while keeping `cream` at 9.98 and `muted` at 4.80 — both above the AA ink floor.
  //
  // LIGHT HAD NO SUCH ROOM, and the naive "darken it a little" is the trap. `muted` on the ORDINARY
  // light card already measures only 4.756:1 — barely over AA — so ANY darkening of the light card
  // pushes every description preview and id on it UNDER the floor, and going lighter instead
  // collapses it into the near-white column plane (`deepForest` #f2f6fd). So light differentiates
  // by HUE AT MATCHED LIGHTNESS: `#dce0ff` is a periwinkle that measures ΔE 8.2 from the ordinary
  // card and 14.4 from the column, while `muted` stays at 4.73 — i.e. the epic card costs the body
  // text nothing. Contrast RATIO between the two light fills is ~1.05 by construction and that is
  // the intended result, not a miss: ratio is a luminance metric and cannot see a hue difference.
  epicCardFill: "var(--c-epic-card-fill)",
  // THE `EPIC` PILL. The founder asked for a GOLD pill, and the reason it cannot read `goldFill` is
  // the note on that token: Blueprint retired gold and the four `gold*` names now carry BLUE. A
  // `goldFill` pill would be blue-on-blue against the epic card above — invisible, which is the one
  // outcome the pill exists to prevent. The live warm family is `amber`, so that is what this is.
  //
  // THEMED AS A PAIR, for the same reason `goldFill`/`onGoldFill` are. BRAND.amber (#e0982f) is a
  // FILL constant and works on dark (5.11:1 on the epic card, above CONTROL_MIN_CONTRAST), but on
  // light's pale card it measures 1.5:1 and fails that floor outright — so light takes the deep
  // ochre the `amberInk` tier already uses (6.89:1 on the light epic card). Each fill carries the
  // ink it was measured with: near-navy on dark's amber (7.06:1), white on light's ochre (8.96:1).
  epicPillFill: "var(--c-epic-pill-fill)",
  onEpicPillFill: "var(--c-on-epic-pill-fill)",
  // EVERY OTHER TYPE'S PILL — `BUG`, `TASK`, `FEATURE`. The founder's ruling (sparkle-huw924.8) is
  // that the top-left pill is the general treatment for a bead's type and not an epic-only badge,
  // so this is the pair the non-epic majority takes.
  //
  // COOL SLATE, DELIBERATELY, and that is the whole design decision in this pair. The epic pill is
  // the only WARM fill on a card; if the type pill were warm too, a board of tasks would shout as
  // loudly as its one epic and the gold would stop meaning anything. Slate reads as neutral
  // metadata beside it while still being a filled badge rather than a second register.
  //
  // THE BINDING CONSTRAINT IS THE EPIC CARD, NOT THE ORDINARY ONE. `BeadCard` has three chrome
  // surfaces — `dialogSurface` (the board's overlay), `forest` (the concierge) and `epicCardFill`
  // (the epics column) — and the pill must clear CONTROL_MIN_CONTRAST on ALL THREE. On dark,
  // `epicCardFill` (#1d3362) is the lightest of them, and nothing DARKER than it can clear 3:1
  // against it without also disappearing into `forest` (#030913); so dark's fill goes LIGHTER than
  // its grounds while light's goes darker, and each carries the ink it was measured with. Both
  // directions are asserted in theme/epicCardContrast.test.ts.
  typePillFill: "var(--c-type-pill-fill)",
  onTypePillFill: "var(--c-on-type-pill-fill)",
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

// ── THE CARD FOR A MESSAGE THAT LEFT THE ROOM ──────────────────────────────────────────────────
// The founder: *"it would be a black background instead of a blue background when it was sent to an
// agent."* He had just spent a minute working out, after the fact, which of his own messages had
// gone to a build agent and which the concierge had answered itself — the two were the same blue
// bubble, distinguished only by a grey line hanging outside and below it. This token is the "it
// left" half of that answer; the agent pill drawn inside the card is the "where it went" half.
//
// SAME VALUE IN BOTH THEMES, which makes it the only chrome fill here that is not a themed pair.
// That is the point rather than a shortcut: the card has to be recognisable as the same object in
// either appearance, and a "black" that turns pale in light mode is not the affordance he asked for.
//
// ⚠ IT IS NOT HELD TO CHROME_MIN_CONTRAST AGAINST THE PLANE, AND CANNOT BE. Against dark's
// concierge surface (#0d1b31) black measures ~1.22:1 — over EDGE_MIN_CONTRAST, under the 1.5 chrome
// floor. Every other fill in this file is placed by the neutral ladder; this one is placed by an
// explicit instruction, so the contrast it does have is recorded in theme/chromeContrast.test.ts as
// a MEASUREMENT rather than asserted against a floor it was never going to clear. If the founder
// later asks for an edge (a 1px hairline is the house answer — the direction draws structure rather
// than filling it), that is what closes the gap; do not close it by quietly lightening this value.
export const CHAT_SENT_BUBBLE = "var(--c-chat-bubble-sent)";

// The inks the sent card pins on itself. NOT tokens, and this is the crux of the whole change.
//
// Every color in this app is the string `var(--c-*)`, and `cream` is the INK token — #dce8fc in
// dark, #0a1b33 in LIGHT. So a card that is black in both themes cannot use the themed ink: in light
// mode `C.cream` is near-black, and the message text, the agent pill's label and the collapsed-paste
// pills would all be black-on-black. A fixed-luminance surface needs fixed inks.
//
// The card applies these by REDEFINING `--c-cream` and `--c-concierge-muted` on its own element, so
// the whole subtree — AgentPill, MentionPill, TextPill, CopyAnswerButton — resolves to them with no
// component changes and nothing to keep in sync. Values are the dark theme's own ink pair, which is
// what "light ink on a dark ground" already means everywhere else in this app.
export const CHAT_SENT_INK = BLUEPRINT.dark.ink;
export const CHAT_SENT_MUTED = BLUEPRINT.dark.muted;

// ⚠ PINNING THE INK IS ONLY HALF THE CONTRACT — THE FILLS ITS SUBTREE PAINTS MUST BE PINNED TOO.
//
// The first version of this pinned inks and stopped, on the reasoning that the card supplies the
// ground. It does — for text drawn straight onto it. But two descendants draw a ground of their OWN
// inside the bubble, and those grounds stayed THEMED while the ink on them became fixed-dark. In
// light mode that inverts the pair and the label vanishes into its own chip:
//
//   • composer/AttachmentStrip.tsx:105 — a non-thumbnail attachment chip fills with
//     CHAT_USER_BUBBLE (light #e8f0fd) and labels it `C.cream` → pinned #dce8fc ≈ 1.07:1.
//     Its own comment calls the chip form "the designed steady state after a restart", so every
//     previously-sent message carrying an attachment renders exactly this way. Not a rare state.
//
// Declaring `color` on the card cannot help there, because the chip declares its own ground. So the
// card pins that fill to the DARK theme's value alongside the inks — same mechanism, same element,
// same one-definition property: a descendant resolving `var(--c-chat-bubble)` gets a ground that
// matches the ink it was already going to use.
//
// ── TWO FILLS THAT NEED NO PIN, and the reasons are different ──────────────────────────────────
// Recorded because "not in the list" is otherwise indistinguishable from "overlooked", and a wrong
// example here is worse than none: the sweep below tells the next reader to add fills to it.
//
//   • the COLLAPSED PASTE PILL is safe because it is TRANSLUCENT, not because anything pins it.
//     ConciergeMessageRow's `collapsedPayload` draws every transcript paste as `variant="inline"`,
//     whose fill is `color-mix(in srgb, teal 16%, transparent)` — it composites over whatever is
//     behind it, which inside this card is the pinned black. (`C.deepForest` is TextPill's OTHER
//     arm, the composer's 46px dashed draft box, which never appears in the transcript. An earlier
//     version of this block pinned `--c-deep-forest` on that mistaken basis: nothing in a card's
//     subtree resolves it, so the pin was inert and the test asserting it was vacuous by
//     construction — roborev 62750.)
//   • `C.sienna` is NOT IN THE SUBTREE AT ALL, which is a stronger reason than the one first given
//     here (it was described as "TextPill's error branch" — TextPill has no error branch). It is the
//     REMOVE BADGE on a pill or an attachment chip, drawn only when `onRemove` is passed, and
//     `collapsedPayload` deliberately passes none: "a sent message is a record, and offering to
//     delete half of one implies an edit the app cannot make". So it never paints inside a sent
//     card. Were it ever drawn here it would still need no pin, since it carries ON_BRAND_FILL as
//     its own ink rather than `cream` — but that is the second reason, not the first.
//
// chromeContrast.test.ts sweeps BOTH pinned inks against every fill that IS in the list.
export const CHAT_SENT_FILL = BLUEPRINT.dark.bubble;

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
  // Brand RED (waiting / approval / blocked / errored). This used to fall through to `return color`
  // under a comment — and a test — asserting the red tier was "already legible in both themes". It
  // is not: BRAND.sienna measures 3.83:1 on light's white sidebar and 3.54:1 on the builder column,
  // and it paints the NAME of a worker row, which is an underlined-on-hover link. `dangerInk` is
  // the themed alarm-red-as-text tier that already existed for exactly this (see above).
  if (color === AGENT_STATUS.waiting.color) return C.dangerInk;
  // Brand BLUE (`questions`) — same reasoning as the red above, and it matters MORE here because
  // this tier paints a row NAME beside a count the founder is meant to act on. BRAND.azure is a
  // dot fill; `questionsInk` is its themed as-text twin.
  if (color === AGENT_STATUS.questions.color) return C.questionsInk;
  // Brand AMBER (`lapsed`) — the third repeat of the same lesson, so it is worth stating as a rule:
  // ANY new status tier owes an arm here, because the fall-through paints raw brand colour as TEXT.
  // BRAND.amber measures ≈1.7:1 on light's builder column — less than half the 3.83:1 that was
  // judged insufficient for red — and `lapsed` reaches text directly: `alertControlKind` returns a
  // dismiss/re-enable control for it, and `AlertToggleButton` uses the status colour for its label
  // and border. `amberInk` is the themed as-text twin that already existed for this ("amber TEXT
  // only — keep BRAND.amber for fills").
  if (color === AGENT_STATUS.lapsed.color) return C.amberInk;
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
 *  That freedom SURVIVES `TERM_MIN_CONTRAST_RATIO` (roborev 56774-M3): the floor handed to xterm
 *  while calm is a backstop for combinations this palette never designed, and an uncovered pair is
 *  by definition one of them — if a future tune drops it under the floor, xterm lifts that CELL's
 *  foreground and the band is left alone. Tune (1) and (2); this does not add a third constraint.
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

/** Floor for LINK TEXT against the surface it is read on. WCAG AA for body-size text, in both
 *  themes. Measured by theme/linkContrast.test.ts, which also scans the call sites — a link that
 *  consumes a brand FILL token instead of its `…Ink` counterpart fails there even though the
 *  token's own hex is fine, which is how all four of the original failures got in. */
export const LINK_MIN_CONTRAST = 4.5;

/** Floor for a light-mode ANSI slot against whatever it is read against — the terminal plane when
 *  it is a foreground, the opposing register when it is a cell FILL. WCAG AA, body text. */
export const TERM_ANSI_MIN_CONTRAST = 4.5;

/**
 * xterm's own per-cell foreground adjuster, and the answer to everything `ANSI_LIGHT` cannot reach.
 *
 * WHY IT EXISTS HERE. Pinning the sixteen basic slots fixed the colours a TUI names with `\e[3Xm`,
 * but a terminal LINK — a path, a URL, an OSC 8 word — is drawn in whatever colour the emitter
 * chose, and xterm has no link colour of its own to override (its `ITheme` has none; a detected
 * link only gains an underline). When that colour comes from the 256-COLOUR CUBE, the palette never
 * sees it: 201 of the cube's 240 entries fail AA on this plane, and the TUI in this app reaches
 * into it — `\e[38;5;215m` measures 1.41:1 and `\e[38;5;242m` 4.06:1. That is a link you cannot
 * read, which is precisely the report, and no amount of tuning the sixteen fixes it.
 *
 * `minimumContrastRatio` is xterm's built-in remedy and it is strictly better than the clamp I
 * previously declined to write. It adjusts the FOREGROUND against the ACTUAL background of each
 * cell, so:
 *   • it covers the cube AND 24-bit truecolor, not just the slots this file names;
 *   • it leaves BACKGROUNDS alone — which dissolves the objection that made me defer the cube
 *     (a blanket palette clamp would have turned a light `\e[48;5;Nm` fill dark under text chosen
 *     to sit on a light fill; this cannot, because it never rewrites a background);
 *   • it is measured against the real backdrop, so a painted-background cell is handled correctly
 *     rather than assumed to be the plane.
 *
 * It defaults to 1 ("do nothing") and was simply never set. LIGHT ONLY: dark mode was not the
 * report and its defaults already clear the floor, so it keeps xterm's untouched behaviour.
 *
 * This does NOT make `ANSI_LIGHT` redundant. The adjuster preserves hue only as far as it can
 * before it has to drive a colour toward black or white, so a palette that already clears the floor
 * keeps its intended hue and the adjuster never fires on it. The sixteen slots stay hand-chosen;
 * this catches everything outside them.
 *
 * ── WHY CALM GETS ITS OWN FLOOR, AND WHY IT IS NOT 1 ─────────────────────────────────────────────
 * The first version of this indexed on the THEME alone, and that is wrong: light mode has a SECOND
 * palette. `CALM` is built deliberately BELOW AA — `CALM_MIN_CONTRAST` is 3 and `CALM_MIN_SPLIT` is
 * 2 — because a calm agent's output is meant to recede. A blanket 4.5 overrides that intent exactly
 * where calm works hardest: calm's `bright` sits at 2.14:1 over a `dim`-painted cell, and `calmAnsi`
 * points `black`…`brightBlack` at `dim`, so every painted-background cell a TUI draws (diff hunks,
 * selected rows — the case `CALM_MIN_SPLIT` exists for) would be dragged to full contrast. Calm is
 * the default state for a `working` agent, so that is the common path, not an edge case.
 *
 * It is NOT 1 either, because calm does not fix the bug above — `calmAnsi` flattens the sixteen
 * NAMED slots and nothing else, so a calm terminal still emits cube and truecolor at their own
 * values, and `\e[38;5;215m` is still 1.41:1. Turning the net off while calm would leave the
 * original report unfixed in the state the app is in most of the time.
 *
 * So the calm floor is CALM'S OWN weakest deliberate relationship, `CALM_MIN_SPLIT`. The rule reads:
 * nothing on screen may sit below the least contrast the calm palette DESIGNS.
 *
 * WHICH IS NOT "the adjuster never fires while calm" — an earlier draft of this comment said that
 * and it was false (roborev 56774-M1). Calm ships two grays across sixteen slots, so the palette
 * necessarily produces combinations it never designed, and the sharpest is degenerate: a dark slot
 * on a dark-slot fill (`\e[44m\e[37m`) is fg == bg exactly — invisible, not merely recessive. That
 * one follows from a property the test DOES pin (xtermTheme.test.ts asserts all sixteen light calm
 * slots collapse onto two grays), which is the only reason it is asserted here as fact and not as
 * prose — an earlier draft also claimed something about ink over a `bright` fill, and that
 * relationship is measured nowhere and constrained by neither calm floor, so it is gone rather than
 * left to drift (roborev 57272-M2). No ratios, per this file's rule.
 * Those are not calm working as intended, they are calm having nothing to
 * say about a pair; the net lifting them is the whole reason it exists. What the floor guarantees is
 * narrower and is what xtermTheme.test.ts measures: the pairs calm DOES design — each ink on the
 * plane, and `bright` over a `dim` fill — clear it, so the adjuster never rewrites a relationship
 * the palette was tuned for.
 */
export const TERM_MIN_CONTRAST_RATIO = {
  light: { normal: TERM_ANSI_MIN_CONTRAST, calm: CALM_MIN_SPLIT },
  // Dark keeps xterm's untouched behaviour in both states — it was not the report.
  dark: { normal: 1, calm: 1 },
} as const;

/** The floor to hand xterm for a given pane state. Mirrors `xtermTheme(resolved, calm)`, which
 *  chooses the palette this floor has to leave alone. */
export function termMinContrastRatio(resolved: "light" | "dark", calm = false): number {
  return TERM_MIN_CONTRAST_RATIO[resolved][calm ? "calm" : "normal"];
}

/** Floor between a light-mode ANSI slot and its `bright` counterpart, so the two stay tellable.
 *  The `white`/`brightWhite` pair is the exception and has its own, looser floor below: both are
 *  paper tones by construction, and every light terminal profile keeps them close (Solarized
 *  Light's base2/base3 sit at 1.12:1). Holding them to the ink floor would force one of them off
 *  paper, which is the entire failure this pair exists to prevent. */
export const TERM_ANSI_MIN_SPLIT = 1.3;
/** Floor between the two paper tones. Low on purpose — see above. */
export const TERM_PAPER_MIN_SPLIT = 1.1;

/**
 * ── THE LIGHT-MODE ANSI PALETTE ────────────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS. Light mode used to ship xterm.js's DEFAULT palette — the Tango set, which is
 * tuned for a near-black terminal — and overrode exactly two of its sixteen slots (`blue` and
 * `brightBlue`, pointed at `BRAND.teal`). Measured against light's actual terminal background
 * (`term` #d9e3f3), ELEVEN of the sixteen defaults failed AA, and so did the override that was
 * supposed to be the fix: brightWhite 1.11:1, brightYellow 1.04:1, brightCyan 1.24:1, brightGreen
 * 1.25:1, white 1.13:1, brightBlue 2.14:1, brightMagenta 2.55:1, cyan 2.72:1, green 2.73:1, yellow
 * 1.94:1, brightRed 3.23:1 — and `blue`/`brightBlue` → #2f6bff at 3.48:1. That is the founder's
 * report ("terminal inks are way too light in light mode"): a TUI's coloured tokens — a path, a
 * `.rs` filename, a table cell — washed out to near-invisible on a near-white plane.
 *
 * The root cause is not any individual value. It is that a palette designed for a dark ground was
 * placed on a light one and patched two slots deep, so the fix is a GENUINE light palette rather
 * than more per-token nudges. Dark mode still takes xterm's defaults untouched — it is the mode
 * those defaults were built for, and nothing here reaches it.
 *
 * ── AN ANSI SLOT IS A FILL AS WELL AS AN INK, AND THAT SPLITS THE SIXTEEN IN TWO ───────────────
 *
 * The first cut of this palette got the diagnosis right and the remedy wrong: it made all sixteen
 * slots dark ink, because it reasoned only about `\e[3Xm` (set foreground). But `\e[4Xm` / `\e[10Xm`
 * set a cell BACKGROUND, and a TUI paints those constantly — status bars, selected rows, diff
 * hunks. Sixteen dark slots means every fg/bg pair drawn from the palette collapses:
 * `\e[47;30m` (white bg, black fg) measured 1.71:1 and `\e[44;37m` (blue bg, white fg) 1.00:1,
 * i.e. invisible. The CALM block above already knew this — `CALM_MIN_SPLIT` exists to keep "a
 * painted-background cell" readable — and the new palette had no equivalent.
 *
 * So the sixteen are two registers, not one ramp:
 *
 *   • FOURTEEN INK SLOTS — the six hues, their brights, `black` and `brightBlack`. Each is read
 *     as text on the terminal plane (AA) AND used as a cell fill with a paper tone on top (AA).
 *     Within a hue the normal slot is a deep, nearly-black tint and `bright` is a lighter, more
 *     SATURATED one; emphasis is vividness. `brightBlack` is the conventional "dim/comment" slate
 *     — TUIs draw box rules and de-emphasised text in it, so it is READ, and it gets the floor.
 *   • TWO PAPER SLOTS — `white` and `brightWhite`. These are the light register: the fill a
 *     `\e[47m` cell paints, and the foreground a TUI puts ON the dark hue fills. They are NOT
 *     inks and are deliberately not measured as inks.
 *
 * THE PAPER PAIR CANNOT BE INK, and this is arithmetic rather than preference. For `white` to
 * carry `black` (L≈0.017) at AA it needs luminance ≥ 0.2515; to clear AA as text ON the plane
 * (L≈0.7396) it needs ≤ 0.1254. There is no value satisfying both, so a palette must choose which
 * job `white` does. Every light terminal profile — Solarized Light, Apple Terminal Basic, GitHub
 * Light — chooses paper, and so does this one: default body text is carried by `theme.foreground`
 * (`hex.cream`, ~13:1 on the plane), not by `\e[37m`.
 *
 * THE COST, STATED PLAINLY: a TUI that paints body text with an explicit `\e[37m`/`\e[97m` on this
 * light terminal stays low-contrast, because it asked for paper-on-paper. That was equally true
 * before this change (xterm's default `white` #d3d7cf measured 1.13:1) and no palette can fix it.
 * What this change does fix is every COLOURED token, which is what the report was about.
 *
 * ── THE FILL CONTRACT IS PAPER-ON-INK, AND BLACK-ON-HUE IS OUTSIDE IT ──────────────────────────
 * There are three fg/bg directions, not two, and the third is `\e[3Xm` over `\e[4Xm` — an ink on
 * an ink. `\e[42;30m` (black on a green fill) measures 1.71:1 here, and `chalk.bgGreen.black` is a
 * real badge/diff-hunk idiom, so this must be stated rather than left for someone to discover.
 *
 * IT IS THE SAME FORCED CHOICE THE PAPER PAIR FACES, one hue over. For a fill to carry `black` at
 * AA it needs luminance ≥ 0.2528; to clear AA as text on this plane it needs ≤ 0.1304. No value
 * does both, so each hue is either an ink or a black-carrying fill and cannot be both. The hues are
 * INKS here, deliberately: coloured TEXT washing out is the reported bug, whereas black-on-hue is
 * a fill idiom whose light foreground (`white`/`brightWhite`) already clears AA on every one of
 * them. `xtermTheme.test.ts` asserts the contract AND re-derives the impossibility, so if the
 * terminal plane ever darkens enough to make both satisfiable the test fails and the choice gets
 * re-made rather than inherited.
 *
 * DO NOT read this as "no worse than before": it IS worse for that one idiom, and by how much is
 * worth knowing. xterm.js's default is the Tango set, where black-on-green measured 3.58:1 and
 * black-on-blue 2.13:1 — i.e. already under AA. (A ~9:1 figure belongs to the classic `#00cd00`
 * xterm palette, which is not what this app ever shipped.) So the direction went from failing to
 * failing worse, while the two directions a TUI relies on most went from failing to passing.
 *
 * ── WHAT THIS PALETTE DOES NOT REACH, MEASURED RATHER THAN GUESSED ─────────────────────────────
 * `pty.rs` exports `COLORTERM=truecolor`, so the obvious worry is that a chalk/Ink TUI emits
 * 24-bit `\e[38;2;R;G;Bm` and bypasses all of this. For the TUI that prompted the report it does
 * NOT: its binary contains zero `38;2` foreground sequences. What it emits is `\e[3Xm`/`\e[9Xm`
 * plus `\e[38;5;N]`, and for N ≤ 15 xterm resolves the 256-colour form through these very slots —
 * `38;5;12` and `38;5;14` are `brightBlue` and `brightCyan`, which is precisely the pale blue-grey
 * the report described. Those are governed here.
 *
 * THE REAL BOUNDARY IS THE 256-COLOUR CUBE (N ≥ 16), which xterm computes internally. 201 of its
 * 240 entries fail AA on this plane, and the TUI above does reach into it — `38;5;215` (a light
 * orange) measures 1.41:1 and `38;5;242` (a mid grey) 4.06:1.
 *
 * THAT IS LEFT ALONE DELIBERATELY. xterm exposes `extendedAnsi` and clamping the cube would be a
 * dozen lines — but the cube is addressed as a BACKGROUND (`\e[48;5;Nm`) as often as a foreground,
 * and darkening every light entry is the identical mistake the ink/paper note above exists to
 * record: it would turn a light fill into a dark one under text chosen to sit on a light fill.
 * With sixteen slots the two roles are separable because the palette assigns them; across 240
 * indices the emitter's intent is unknowable from here. A cube fix therefore needs the emitter's
 * own light theme, not a blanket transform in this file.
 *
 * So: "sixteen slots pinned" is NOT the same claim as "every terminal is legible in light mode".
 * If a specific token still washes out, read what it actually emits before retuning anything here.
 *
 * NO RATIOS ARE WRITTEN AS PROSE ELSEWHERE IN THIS FILE and none are asserted here beyond the
 * failing sets above, which are the case for the change existing. `xtermTheme.test.ts` recomputes
 * every floor from the actual hex and is the only contract — it measures both directions (ink on
 * plane AND slot as fill), because measuring only the first is what shipped the 1.00:1 pair.
 */
const ANSI_LIGHT = {
  black: "#172438",
  red: "#921019",
  green: "#045422",
  yellow: "#683f03",
  blue: "#1041a4",
  magenta: "#782080",
  cyan: "#034f63",
  // PAPER, not ink — see the note above. A `\e[47m` cell is a page, and this is the light
  // foreground a TUI lays over the dark hue fills.
  white: "#eef3fb",
  brightBlack: "#4a6288",
  brightRed: "#bb1520",
  brightGreen: "#066d2c",
  brightYellow: "#875203",
  brightBlue: "#1554d3",
  brightMagenta: "#9a29a5",
  brightCyan: "#03667f",
  brightWhite: "#ffffff",
} as const;

/** The light ANSI palette, exported for the contrast guard. Not for component use. */
export const TERM_ANSI_LIGHT = ANSI_LIGHT;

/** The two PAPER slots — the light register. Measured as fills and as the ink that goes ON a
 *  hue fill, never as text on the terminal plane. See the note above for why that is arithmetic
 *  and not taste. */
export const TERM_ANSI_PAPER = ["white", "brightWhite"] as const;

/** The fourteen INK slots — read as text on the plane, and used as cell fills under paper. */
export const TERM_ANSI_INKS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan",
] as const;

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
    // ALL SIXTEEN ANSI slots in light mode, not the two this used to patch — see ANSI_LIGHT above
    // for why a two-slot override could not work. Dark mode keeps xterm's defaults, which is the
    // ground they were designed for.
    ...(resolved === "light" ? ANSI_LIGHT : {}),
    // LAST, so calm wins: while calm, even the legibility palette above is one of the colors
    // being flattened.
    ...(calm ? calmAnsi(calmC) : {}),
  };
}

// Re-export the non-themed runtime VALUES so re-pointed components import one module.
// (Types stay on @sparkle/ui — this module intentionally does not re-export them.)
export { AGENT_STATUS, FONT, FONT_WEIGHT } from "@sparkle/ui";
