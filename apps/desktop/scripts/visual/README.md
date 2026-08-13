# The visual fidelity harness

Photographs the running app and scores it against the approved mock
(`PRD/sparkle/ui-directions/rev4-standalone.html`), so structural fidelity is **demonstrated**
rather than asserted. `MAPPING.md`'s Verification section is what this closes.

It is a **measuring instrument**. It does not change any component's styling, and neither should
work that uses it — capture, read the number, fix the design, capture again.

Scoring a whole surface is not the only pixel question. When the report is about a **specific**
thing — a line, a gutter, a join, an edge that should not be there — the percentage cannot answer
it. [Settling a pixel question](#settling-a-pixel-question) is the section for that.

## Run it

```bash
pnpm --filter @sparkle/desktop visual:capture         # app  → visual-out/app/
pnpm --filter @sparkle/desktop visual:compare         # mock → visual-out/compare/ + the diff table
pnpm --filter @sparkle/desktop visual                 # both, in order
pnpm --filter @sparkle/desktop visual:verify-stable   # capture twice, assert byte-identical
```

**Run `visual:verify-stable` before you trust a number that surprised you.** It captures everything
twice and compares every artifact byte-for-byte; if it fails, the harness is non-deterministic and
every percentage it reports is suspect. Current result: 12/12 identical.

Output lands in `apps/desktop/visual-out/` (git-ignored). `visual:compare` reads the PNGs
`visual:capture` wrote, so run capture first.

Useful flags (both scripts):

| flag | meaning |
|---|---|
| `--surfaces=a,b` | only these surfaces (default: all) |
| `--theme=dark` | only this theme (default: both) |
| `--out=<dir>` | where to write |
| `--scale=N` | device pixel ratio (capture default 2; **compare adopts the capture's**) |
| `--width` / `--height` | viewport in CSS px (capture default 1600×1000; compare adopts the capture's) |
| `--verbose` | stream the Vite dev-server log (capture only) |
| `--app=<dir>` | where to read captures from (compare only) |
| `--mock=<path>` | use this reference file (compare only) |
| `--threshold=N` | per-channel tolerance 0–255 (compare only, default 0 = exact) |

## Reading the output

```
  surface                  theme       diff  overlap   app px        mock px
  agent-sidebar            light    100.00% 100.00%  440×1866      592×1052
  concierge-column         light     63.73%  32.19%  720×1866      644×1116
  settings-dialog          light    no-reference  — the mock has no counterpart for this surface
```

- **diff** — differing pixels over the **union** of the two images. When the sizes differ this
  saturates near 100%, which is the honest reading: a surface of the wrong size is wholly wrong.
- **overlap** — differing pixels within the **shared** region only. This is the number that moves
  as the design converges.

Read both. `diff` says whether the geometry is right at all; `overlap` says how close the shared
part is. Either alone hides half the finding.

Per surface and theme you also get `-mock.png`, `-side-by-side.png` (app left, mock right) and
`-diff.png` (matching pixels as a faint ghost, differing ones magenta), plus `report.json` with the
raw counts.

## How a surface is reached

`surfaces.mjs` is the whole contract. Each entry says how to reach one named view **twice** — once
in the app, once in the mock — so a capture and its reference cannot drift into describing
different states.

```js
{
  name: "agent-sidebar",
  description: "The build column: header, stage group headers, agent rows.",
  app:  { steps: [{ waitFor: "[data-testid=agent-sidebar-column]" }],
          clip: "[data-testid=agent-sidebar-column]" },
  mock: { steps: [{ setAttr: { sel: "#shell", name: "data-wired", value: "off" } }],
          clip: '.pair[data-side="left"] .build' },
}
```

Four step verbs, all retried until they succeed:

| verb | does |
|---|---|
| `{ waitFor: sel }` | wait until the selector matches |
| `{ click: sel }` | click the first match |
| `{ clickText: { sel, t } }` | click the first match whose trimmed text is exactly `t` |
| `{ setAttr: { sel, name, value } }` | set an attribute — how mock states are reached |

`clip: null` means the full viewport. `mock: null` means the mock has no counterpart, and compare
reports **no-reference** rather than scoring against something it isn't.

## Adding a surface

1. Append an entry to `SURFACES` in `surfaces.mjs`. Nothing else needs editing — both scripts
   iterate that array.
2. Prefer an **existing** selector. Most surfaces already have one: the concierge column is
   `section[aria-label="Sparkle concierge"]`, the settings dialog is
   `[role=dialog][aria-label="Settings"]`. Only add a `data-testid` when nothing identifies the
   element (that is why `workspace-shell` exists — MAPPING.md puts `data-wired` on the Workspace
   root and nothing else named it).
3. Add the surface name to the list assertion in `harness.test.mjs`.
4. Run `visual:capture --surfaces=<your-surface>` and check the PNG before trusting a number.

Beware `[data-testid=concierge]`: it exists only in Workspace's unit-test mocks, not in the real
tree.

## How it works, and why

- **`cdp.mjs` — a dependency-free Chrome DevTools Protocol client.** `playwright` is a
  `devDependency` but is not reliably installed (`scripts/screenshot.mjs`, which imports it, dies
  with `ERR_MODULE_NOT_FOUND` in this worktree). Chrome is on the machine and Node ≥22 ships a
  global `WebSocket`, so this needs nothing from npm. Chrome's one-shot `--screenshot=out.png` flag
  was not enough: it cannot open the settings dialog, toggle `data-wired`, or report a bounding
  box.
- **`serve.mjs` — the Vite DEV server, never `vite preview`.** The auth bypass is gated on
  `import.meta.env.DEV`, deliberately false in a build artifact, so a preview would only ever
  photograph the paywall.
- **`png.mjs` — a small PNG codec over `node:zlib`.** ~180 lines instead of `pngjs`/`sharp`, for
  the same reason as above: an instrument that stops working when an install is skipped is not an
  instrument.
- **`src/dev/visualFixtures.ts` — the deterministic roster.** Fixed ids, names, statuses, stages
  and elapsed offsets. Reached with `?visual=1`, and double-gated behind the dev auth bypass so it
  can never seed a shipped bundle or clobber a real session.

### Byte-stability

A diff percentage is only a measurement if the same input gives the same pixels. Pinned here:

- `Date.now()` is frozen (`FROZEN_CLOCK`), so every "3m ago" is constant. Its value must equal
  `FIXTURE_NOW` in `src/dev/visualFixtures.ts` — `visualFixtures.test.ts` asserts that, because a
  silent drift would reintroduce exactly the wall-clock dependence the fixture removes.
- Animations and transitions are zeroed, and the caret is made transparent.
- GPU rasterization, subpixel text positioning and font hinting are off; the colour profile is
  pinned to sRGB.
- Each surface gets a **fresh page, and the previous one is closed**. Surfaces mutate app state (the
  settings surface opens a modal), and leaking that into the next capture is how a baseline becomes
  untrustworthy — but an unclosed page is just as bad in a subtler way: it leaves a fully mounted
  copy of the app running, so the last surface would be photographed while eleven others compete
  for the CPU.
- **Compare renders the mock at the viewport the capture actually used**, read from
  `manifest.json`. Otherwise capturing at `--scale=1` and comparing at the default 2 scores every
  surface at half density against a double-density reference, and the report reads as catastrophic
  design divergence with nothing pointing at the cause.
- The theme is applied **after the app has mounted**, then verified to hold across consecutive
  reads. `useApplyTheme` is the single writer of `<html data-theme>` and runs in an effect, so an
  attribute set before mount is silently overwritten — and a check that reads back its own write
  proves nothing. The real lever is the emulated `prefers-color-scheme`; the attribute is
  belt-and-braces that now fails loudly if the app disagrees.

Two independent runs are expected to produce **byte-identical** PNGs. If they don't, something in
the list above has regressed — that is the first thing to check, before trusting any number.

### Where the reference comes from

`rev4-standalone.html` **is on main** — it landed with the cockpit port — so it is in the working
tree on every branch cut from main, and that is the normal path. `compare.mjs` resolves in this
order:

1. `--mock=<path>` — a PATH, not a ref.
2. `$SPARKLE_VISUAL_MOCK_REF` — a ref. **Outranks the working tree**, because naming a ref is an
   explicit instruction. If that ref does not carry the mock, the run **fails** rather than quietly
   falling back to the tree; otherwise it would report a confident number scored against a revision
   you did not ask for.
3. the working tree.
4. `git show <ref>:<path>` over `sparkle/blueprint-cockpit`, then `main` — a compatibility path for
   a detached or sparse checkout. Nothing depends on that branch still existing.

To score against a revision other than the tree's, set `SPARKLE_VISUAL_MOCK_REF=<ref>`, or extract
it yourself: `git show '<ref>:PRD/sparkle/ui-directions/rev4-standalone.html' > /tmp/mock.html` and
pass `--mock=/tmp/mock.html`.

### Kept capture directories

`visual:verify-stable` **keeps** both capture directories when the two runs disagree or a run
throws — the differing PNGs are the entire reason to run it, and deleting them was the bug
(roborev 54844). It prints the paths and their file counts, and **nothing else removes them**: they
are `visual-stable-a-*` / `visual-stable-b-*` under your temp dir, and repeated local failures
accumulate. Delete them when you are done. A clean run cleans up after itself; `--keep` forces a
keep, `--keep=false` forces a clean on the success path only.

## Settling a pixel question

**A unit test cannot settle a claim about what something LOOKS like.** jsdom never lays out and
never loads the stylesheet, so a green suite is compatible with a visible line, a gap, or a shadow
that nobody asserted on. Reasoning from the source is no better: "I removed the border, therefore
the line is gone" cannot see a line painted by a *different* element, by a background gap, or by a
scroll container's edge. Five rounds of "the seam is fixed" shipped that way before either of these
two tools existed, so reach for a rendered image whenever the report is about appearance.

Both read a PNG — a capture from `visual:capture`, or any screenshot.

### `seam-probe.mjs` — what is actually painted there

Collapses a horizontal scan into **runs** of near-identical colour. A 1px rule between two planes
is unmissable as a short run whose colour is neither neighbour:

```bash
node scripts/visual/seam-probe.mjs shot.png --y=245 --x=700..800
node scripts/visual/seam-probe.mjs shot.png --y=245 --x=700..800 --json
```

```
x  700..745  #0e1b2e  (46px)
x  746..747  #24406a  (2px)   <-- the seam, at scale 2
x  748..800  #101f36  (53px)
```

| flag | meaning |
|---|---|
| `--y=<row>` or `--y=<from..to>` | the row(s) to scan; a range judges each row |
| `--x=<from..to>` | the horizontal band to scan (inclusive both ends) |
| `--tolerance=N` | per-channel tolerance for "same colour" (default 2) |
| `--strict` | see below |
| `--json` | emit the runs and the verdict for a test to assert on |

**Two questions, two rules — pick deliberately.** The default answers the PANEL BOUNDARY question
("is there a rule *between* these two surfaces"), where two runs meeting directly is continuous and
correct. `--strict` answers the JOINT question ("does one plane run through unbroken") by demanding
a **single** run — because a hard colour step straight down the join is two runs meeting, which the
default rule calls continuous. Use `--strict` when the claim is that a surface is uninterrupted.

Width alone does not decide it either: a band counts as a seam if it is narrow **or** if the scan
starts and ends on the same colour, since a band splitting one continuous plane is an interruption
however wide it is. The defect that motivated this was 14 image px across — over any sane rule width
— with byte-identical planes either side.

`--json` is what turns "no seam" into a regression-testable fact rather than a screenshot someone
looked at once.

### `tab-seam-probe.mjs` — the project tab strip, at the zooms the founder reads it at

```bash
pnpm --filter @sparkle/desktop visual:tab-seam
pnpm --filter @sparkle/desktop visual:tab-seam -- --json
pnpm --filter @sparkle/desktop visual:tab-seam -- --scales=0.7,1 --keep
```

Mounts the real `ProjectTabs` over a content plane and answers two questions per zoom, in Chrome:

- **is the strip's rule painted UNDER the active tab** — bead `sparkle-civ4i`, *"the active tab must
  open into the content area like a folder tab."* It reads the rule's colour off an INACTIVE tab's
  own column (so it is not comparing against a token and keeps working across a retint), then
  asserts that colour is absent under the active one. Two vacuity guards sit either side of that:
  the rule must EXIST under the inactive tab, and the active tab's face must not be the bar's own
  surface — otherwise "no rule under the active tab" is satisfied by deleting the rule, or by
  dropping the active state.
- **does clicking a non-active tab activate it** — twice: settled, and *across an expansion*, which
  is the gesture a hand actually makes (the pointer is already resting on a neighbour, that
  neighbour has expanded out of flow over the tab you are aiming at, and you press inside the
  strip's settle delay).

`--scales` is the whole point of the instrument. **70% page zoom is, to the rasteriser, a
`deviceScaleFactor` of 0.7**: a CSS pixel no longer owns a device pixel, so a 1px rule and a 1px
overlap of it round INDEPENDENTLY and need not cancel. A seam that is "fixed" at one scale proves
nothing about the others, so the default measures 0.7, 0.8, 0.9 **and 1** — the last so a failure can
distinguish *breaks when zoomed out* from *broken everywhere*.

Exit **0** measured and clean, **1** a real regression, **2** the probe could not run. A failing
scale writes its PNG to the temp dir and prints the path; `--keep` writes them on the pass path too.

### `quote-surface-probe.mjs` — the concierge blockquote, in both themes

```bash
pnpm --filter @sparkle/desktop visual:quote-surface
pnpm --filter @sparkle/desktop visual:quote-surface --keep --themes=light
```

Two founder reports about one piece of chrome:

- **the copy glyph painted ON the blue quote rule.** This is a float rule no unit test in this repo
  can see: the glyph is `float: left` (`ConciergeMessageRow`), and **a float shortens the LINE BOXES
  beside it, never a following BLOCK's box** — so a `<blockquote>`'s `border-left` is laid at the
  container's left edge, underneath the glyph, while its inline text is pushed clear. jsdom
  implements no floats whatsoever, so both boxes read as zero there.
- **the "Quote in response" chiclet being a capsule.** Read as a computed `border-radius` and bounded
  by the scale's own ceiling (`RADIUS.modal`), not by the exact step the component picked — pinning
  that is `QuoteChiclet.radius.test.tsx`'s job, where changing it is a reviewable one-line decision.

It measures with `getBoundingClientRect` rather than by scanning pixels, because the claim is about
two BOXES rather than about a colour, and it compares them as half-open ranges so boxes that merely
touch pass. It also refuses to pass when the rule has **vanished** — deleting the rule satisfies "no
overlap" perfectly and is not the fix that was asked for.

**Both themes every run.** The rule is `C.tealInk` and the glyph `C.conciergeMuted` at 45% opacity,
so "can you see the collision" has a different answer in each; a fix eyeballed in dark only is a fix
verified in half the product. The geometry assertion is theme-independent by construction, which is
why it is worth running twice — if it ever disagrees between themes, something is theme-dependent
that should not be.

The harness **copies** `ConciergeMessageRow`'s float rather than importing the row (which needs the
whole concierge store graph), so the probe re-reads the row's own source first and exits **2** if the
row has stopped floating the glyph left — a fixture that no longer reproduces the product makes every
number below it meaningless rather than merely suspect.

### `crop.mjs` — make those pixels visible to a human

```bash
node scripts/visual/crop.mjs shot.png --x=680..820 --y=180..320 --zoom=4 --out=seam.png
```

Companion to the probe: that one settles what the pixels **are**, this one lets you look at them.
Magnification is nearest-neighbour on purpose — a smoothed zoom invents intermediate colours, which
is precisely what makes a 1px rule arguable.

**Mind the scale.** Captures are taken at `devicePixelRatio` 2 by default, so a 1 CSS-px rule is
2 image px, and every coordinate and width in both tools is **image px, not CSS px** — divide by the
capture's `--scale` to get back to CSS px. A run of 1–2px is the signature to look for.

## Tests

`harness.test.mjs` covers the PNG codec, the diff arithmetic, the registry and the CLI parsing —
the parts whose silent misbehaviour would produce a confident, wrong number. It runs as part of
`pnpm --filter @sparkle/desktop test`. The Chrome-driving parts are proven by actually running
`visual:capture`.
