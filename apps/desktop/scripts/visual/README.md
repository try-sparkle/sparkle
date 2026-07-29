# The visual fidelity harness

Photographs the running app and scores it against the approved mock
(`PRD/sparkle/ui-directions/rev4-standalone.html`), so structural fidelity is **demonstrated**
rather than asserted. `MAPPING.md`'s Verification section is what this closes.

It is a **measuring instrument**. It does not change any component's styling, and neither should
work that uses it — capture, read the number, fix the design, capture again.

## Run it

```bash
pnpm --filter @sparkle/desktop visual:capture   # app  → visual-out/app/
pnpm --filter @sparkle/desktop visual:compare   # mock → visual-out/compare/ + the diff table
pnpm --filter @sparkle/desktop visual           # both, in order
```

Output lands in `apps/desktop/visual-out/` (git-ignored). `visual:compare` reads the PNGs
`visual:capture` wrote, so run capture first.

Useful flags (both scripts):

| flag | meaning |
|---|---|
| `--surfaces=a,b` | only these surfaces (default: all) |
| `--theme=dark` | only this theme (default: both) |
| `--out=<dir>` | where to write |
| `--scale=N` | device pixel ratio (default 2) |
| `--width` / `--height` | viewport in CSS px (default 1600×1000) |
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
- Each surface gets a **fresh page**: surfaces mutate app state (the settings surface opens a
  modal), and leaking that into the next capture is how a baseline becomes untrustworthy.

### Where the reference comes from

`rev4-standalone.html` has **not landed on main**. `compare.mjs` looks in `--mock`, then the
working tree, then `git show <ref>:<path>` over candidate refs
(`$SPARKLE_VISUAL_MOCK_REF`, `sparkle/blueprint-cockpit`, `main`). Once the mock lands, the working
tree always wins and the fallback goes quiet on its own.

## Tests

`harness.test.mjs` covers the PNG codec, the diff arithmetic, the registry and the CLI parsing —
the parts whose silent misbehaviour would produce a confident, wrong number. It runs as part of
`pnpm --filter @sparkle/desktop test`. The Chrome-driving parts are proven by actually running
`visual:capture`.
