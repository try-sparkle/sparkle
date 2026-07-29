// ── THE APPROVED DESIGN, AS DATA ───────────────────────────────────────────────────────────────
//
// These are the `--k-*` custom properties of `[data-dir="blueprint"]` in
// `PRD/sparkle/ui-directions/index.html` — the direction the founder signed off — transcribed
// VERBATIM. Not derived, not solved for, not adjusted. `blueprintSpec.test.ts` re-reads that page
// and fails if a single value here disagrees with it.
//
// ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────────────────────────
// Three releases (v0.53–v0.58) shipped a palette I DERIVED with a contrast solver instead of
// porting, and a type scale I INVENTED, and the founder's verdict each time was that the app
// "doesn't look anything like" the design. Every one of those errors has the same shape: I was the
// lossy step between a spec that was already precise and the code. So the spec is data now, and
// the only honest way to change the app's colours is to change the design and re-run the check.
//
// ── THE THING THE OLD PALETTE GOT STRUCTURALLY WRONG ───────────────────────────────────────────
// The direction states its own thesis: *structure is drawn, not filled — hairlines on a faint grid,
// panels are outlines, and the registers separate by LINE WEIGHT.* Read the numbers below and it is
// unmistakable: in light mode the assistant column and the ground are BOTH `#ffffff`, and the step
// from the assistant to the builder column is 1.084 — the columns barely differ at all. What
// divides them is `seam`, a 1px rule.
//
// The shipped palette did the opposite. It forced every adjacent plane at least 1.2 apart
// (`PLANE_MIN_SPLIT`) and then REMOVED the sidebar's hairline on the grounds that "the plane step
// carries the boundary". That guard would reject this file: the design's own steps are 1.069–1.194,
// all of them under the floor. Separation by fill and separation by line are alternatives, and the
// app was enforcing the one the design rejects.
export interface BlueprintTheme {
  /** The app ground, and the assistant column — the same surface in this design. */
  ground: string;
  assist: string;
  /** The builder column. A hair off the ground, not a plane step. */
  bridge: string;
  /** Bars: the top strip and the composer's frame. */
  bar: string;
  /** The terminal. The ONE register that gets a real fill step. */
  term: string;
  /** Selected row / active fill. */
  sel: string;
  /** Input field ground. */
  input: string;
  /** The user's chat bubble. */
  bubble: string;
  /** Primary ink, secondary ink, and the quietest tier. */
  ink: string;
  muted: string;
  faint: string;
  /** The terminal's own inks — a separate register from the shell's. */
  termInk: string;
  termMuted: string;
  /** The one accent, and what reads on top of it. */
  primary: string;
  onPrimary: string;
  /** EDGES. These do the work the plane steps do not — see the thesis above.
   *  `hair` is the faint interior rule; `seam` is the stronger column boundary;
   *  `hairSolid` sits between them; `rule` is a bare colour for custom borders. */
  hair: string;
  hairSolid: string;
  seam: string;
  termHair: string;
  rule: string;
  /** Modal surfaces. */
  dialog: string;
  dialogNav: string;
  dialogEdge: string;
  inputEdge: string;
  /** Overlay scrim and modal shadow. */
  scrim: string;
  shadow: string;
  /** ── THE WORDMARK RAMP (`--wm-dark` → `--wm-lit` in rev4.html) ────────────────────────────────
   *  The concierge's "Sparkle" mark runs DARK → LIGHT, left to right, ending on a LIGHTER blue.
   *
   *  IT IS ITS OWN TOKEN PAIR PER THEME, and that is the whole point of it existing rather than
   *  being written as `linear-gradient(ink, primary)` at the call site. WHICH of those two is the
   *  darker one FLIPS between themes: in light, `primary` (#1550cf) is the LIGHTER of the pair and
   *  `ink` (#0a1b33) the darker; in dark, `ink` (#dce8fc) is the lighter and `primary` (#5c96ff)
   *  the darker. Any single hard-coded order therefore runs the ramp BACKWARDS in exactly one
   *  theme, and a backwards ramp is not a visible failure — it just looks slightly wrong forever.
   *
   *  The values are also not simply those two tokens: light's lit end is #4a8bf5, a lighter blue
   *  than `primary`, because the ramp has to arrive somewhere brighter than the accent to read as
   *  a ramp at all on a white column. `blueprintSpec.test.ts` re-reads rev4.html and pins both
   *  ends, the direction, and the theme flip that makes the pair necessary. */
  wmDark: string;
  wmLit: string;
  /** ── THE UNPLUGGED CONCIERGE'S ELEVATION (`--z-lift` in rev4.html) ────────────────────────────
   *  Unwired, the concierge LIFTS: a soft shadow and no colour change, so it reads as a layer
   *  ABOVE the build+terminal pairs. Wired, it drops flush — loses this shadow entirely and takes
   *  the terminal's colour (the "flood"). There is no `--z-flush` value to store: flush is the
   *  ABSENCE of this one, so it is `box-shadow: none` at the call site rather than a token that
   *  could drift away from meaning "nothing". */
  lift: string;
}

/** LIGHT — a near-white shell. The assistant column IS the ground. */
export const BLUEPRINT_LIGHT: BlueprintTheme = {
  ground: "#ffffff",
  assist: "#ffffff",
  bridge: "#f2f6fd",
  bar: "#f7fafe",
  term: "#d9e3f3",
  sel: "#e4ecfa",
  input: "#ffffff",
  bubble: "#e8f0fd",
  ink: "#0a1b33",
  muted: "#4f6284",
  faint: "#7387a5",
  termInk: "#14263f",
  termMuted: "#5a6f8e",
  primary: "#1550cf",
  onPrimary: "#ffffff",
  hair: "#dbe4f2",
  hairSolid: "#cbd8ea",
  seam: "#c3d1e6",
  termHair: "#c0cfe4",
  rule: "#d5e0f0",
  dialog: "#ffffff",
  dialogNav: "#f2f6fd",
  dialogEdge: "#c3d1e6",
  inputEdge: "#c3d1e6",
  scrim: "rgba(10, 27, 51, 0.28)",
  shadow: "0 18px 44px rgba(10, 27, 51, 0.16)",
  wmDark: "#0a1b33",
  wmLit: "#4a8bf5",
  lift: "0 14px 40px rgba(10,27,51,.16), 0 2px 6px rgba(10,27,51,.06)",
};

/** DARK — a deep navy shell, with the terminal dropping to near-black. */
export const BLUEPRINT_DARK: BlueprintTheme = {
  ground: "#0d1b31",
  assist: "#0d1b31",
  bridge: "#091426",
  bar: "#101f39",
  term: "#030913",
  sel: "#172b4b",
  input: "#0c1728",
  bubble: "#14294a",
  ink: "#dce8fc",
  muted: "#8ba3c8",
  faint: "#647ca4",
  termInk: "#b6c8e6",
  termMuted: "#61789c",
  primary: "#5c96ff",
  onPrimary: "#04101f",
  hair: "#1b3050",
  hairSolid: "#21395c",
  seam: "#24406a",
  termHair: "#1a2f4d",
  rule: "#1b3050",
  dialog: "#0d1b31",
  dialogNav: "#091426",
  dialogEdge: "#2a4d7c",
  inputEdge: "#26456f",
  scrim: "rgba(2, 8, 18, 0.6)",
  shadow: "0 20px 50px rgba(0, 0, 0, 0.55)",
  wmDark: "#5c96ff",
  wmLit: "#dce8fc",
  lift: "0 18px 48px rgba(0,0,0,.55), 0 2px 8px rgba(0,0,0,.4)",
};

export const BLUEPRINT = { light: BLUEPRINT_LIGHT, dark: BLUEPRINT_DARK } as const;
