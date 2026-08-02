// The surface registry — the harness's single contract, read by BOTH capture.mjs and compare.mjs.
//
// A "surface" is one named, reproducible view. Each entry says how to reach that view twice: once
// in the running app (`app`) and once in the approved mock (`mock`). Keeping both halves in one
// record is the point — a capture and its reference cannot drift into describing different states,
// which is how "we compared them and they matched" happened six times without being true.
//
// TO ADD A SURFACE: append one entry here. capture.mjs and compare.mjs both iterate this array, so
// nothing else needs editing. See README.md.

/**
 * Step vocabulary — deliberately four verbs, all expressible as one `evaluate` in the page:
 *   { waitFor }            wait until the selector matches
 *   { click }              click the first match
 *   { clickText: {sel,t} } click the first match whose textContent is exactly `t` (trimmed)
 *   { setAttr: {sel,name,value} }  set an attribute (how MOCK states are reached)
 *   { cable: "off"|"left"|"right" } patch the real cable store (how APP states are reached)
 *
 * A surface may also carry `query`: extra URL parameters appended after `?visual=1`, for state the
 * FIXTURE must seed before mount (the two-pair cockpit) and which therefore cannot come from a step.
 */

/**
 * THE CAPTURE VIEWPORT — part of the registry's contract, not capture.mjs's private business.
 *
 * A surface's steps and its viewport are one description of a state: `?concierge=190` means a very
 * different picture at 1600 than at 900, and the shell CLAMPS a column to what the window can paint,
 * so a width the app happily stores can still photograph narrower than the filename claims. Living
 * here means a test can check that pairing without importing capture.mjs, which pulls in node
 * built-ins and cannot load in a jsdom suite (`Workspace.resize.test.tsx` is where that check runs,
 * because answering it needs the real shell's paint path). capture.mjs re-exports it, so its own
 * `--width` / `--height` defaults are unchanged.
 */
export const DEFAULT_VIEWPORT = { width: 1600, height: 1000 };

/** Everything in the mock page that is scaffolding rather than design, hidden before capture. */
export const MOCK_CHROME_SELECTORS = ["#bar", ".bar", "#cap", ".cap", "#why", ".note"];

export const SURFACES = [
  {
    name: "workspace-unwired",
    description: "The whole shell at rest — concierge unplugged, nothing wired.",
    app: {
      steps: [
        { waitFor: "[data-testid=workspace-shell]" },
        { waitFor: "[data-testid=agent-sidebar-column]" },
        { waitFor: "[data-testid=terminal-stage]" },
        { cable: "off" },
      ],
      clip: null, // full viewport
    },
    mock: {
      steps: [{ setAttr: { sel: "#shell", name: "data-wired", value: "off" } }],
      clip: "#shell",
    },
  },
  {
    name: "workspace-wired-left",
    // TWO PAIRS, and that is why this entry carries a `query`. The fixture seeds ONE project by
    // default, so the left pair had no project, no selected agent, and therefore no side for
    // `useEffectiveWired` to project — this surface photographed the UNWIRED app, byte-identical to
    // `workspace-unwired`, for its whole life. `?pairs=2` seeds the second project; it is opt-in
    // because seeding it always would re-lay-out every OTHER surface and invalidate their baselines.
    query: "pairs=2",
    description: "The live cable seated in the LEFT pair (two-pair cockpit).",
    app: {
      steps: [
        { waitFor: "[data-testid=workspace-shell]" },
        { waitFor: "[data-testid=agent-sidebar-column]" },
        { cable: "left" },
      ],
      clip: null,
    },
    mock: {
      steps: [{ setAttr: { sel: "#shell", name: "data-wired", value: "left" } }],
      clip: "#shell",
    },
  },
  {
    name: "workspace-wired-right",
    description: "The live cable seated in the RIGHT pair.",
    app: {
      steps: [
        { waitFor: "[data-testid=workspace-shell]" },
        { waitFor: "[data-testid=agent-sidebar-column]" },
        { cable: "right" },
      ],
      clip: null,
    },
    mock: {
      steps: [{ setAttr: { sel: "#shell", name: "data-wired", value: "right" } }],
      clip: "#shell",
    },
  },
  {
    name: "agent-sidebar",
    description: "The build column: header, stage group headers, agent rows.",
    app: {
      steps: [{ waitFor: "[data-testid=agent-sidebar-column]" }],
      clip: "[data-testid=agent-sidebar-column]",
    },
    mock: {
      steps: [{ setAttr: { sel: "#shell", name: "data-wired", value: "off" } }],
      clip: '.pair[data-side="left"] .build',
    },
  },
  {
    name: "concierge-column",
    description: "The full-height concierge: header, thread, compose box.",
    app: {
      // ConciergeColumn's root <section> already carries this ARIA label, so no component needed a
      // new hook. (There is no `[data-testid=concierge]` in the real tree — only in Workspace's
      // unit-test mocks, which is a trap worth naming.)
      steps: [{ waitFor: 'section[aria-label="Sparkle concierge"]' }],
      clip: 'section[aria-label="Sparkle concierge"]',
    },
    mock: {
      steps: [{ setAttr: { sel: "#shell", name: "data-wired", value: "off" } }],
      clip: "#assist",
    },
  },
  {
    name: "settings-dialog",
    description: "The settings modal, opened from the ⋯ menu.",
    app: {
      // Opened by CLICKING the real affordances rather than by poking the store, so the capture
      // also proves the path a user takes still works. Both selectors are pre-existing ARIA, so no
      // component needed a new hook.
      steps: [
        { waitFor: 'button[aria-label="Sparkle menu"]' },
        { click: 'button[aria-label="Sparkle menu"]' },
        { waitFor: '[role=menu][aria-label="Sparkle menu"]' },
        { clickText: { sel: "[role=menuitem]", t: "Settings" } },
        { waitFor: '[role=dialog][aria-label="Settings"]' },
      ],
      clip: '[role=dialog][aria-label="Settings"]',
    },
    // rev4 has no settings dialog — its only modal is the pull-request sheet, which is a different
    // surface entirely. Recorded as an explicit null so compare.mjs reports "no reference" rather
    // than silently scoring it against something it isn't.
    mock: null,
  },
  {
    // THE OPEN-PR MENU AT A HOSTILE WIDTH — the state the bug was reported in (bead sparkle-8g4qh)
    // and the one no existing surface could photograph.
    //
    // BOTH query parameters are the point. `prs=1` populates the chip at all: `OpenPrMenu` reads
    // `invoke("project_open_prs")`, the transport shim answers null, and a menu with no PRs renders
    // no badge — so without it this surface is a picture of an empty header. `concierge=190` then
    // squeezes the column to half its default, which is what the founder was looking at.
    //
    // 190px, not the 50px floor: at 50 the column is a sliver with no visible header content to
    // anchor the eye, and the shot stops being readable as evidence. Half the default is a width a
    // user really works at, and the panel is 640px — so the picture answers "does the menu escape
    // its column" at a glance. The floor itself is covered by arithmetic instead, in
    // `panelPlacement`'s unit tests, which is the right tool for an extreme.
    name: "open-pr-menu-narrow",
    query: "prs=1&concierge=190",
    description: "The open-PR merge menu, opened over a HALF-WIDTH concierge column.",
    app: {
      steps: [
        { waitFor: "[data-testid=workspace-shell]" },
        { cable: "off" },
        { waitFor: "[data-testid=open-pr-badge]" },
        { click: "[data-testid=open-pr-badge]" },
        { waitFor: "[data-testid=open-pr-panel]" },
      ],
      // FULL VIEWPORT, deliberately, and it is the only honest clip for this surface. Clipping to
      // the panel would crop away the very thing under test — where the panel sits RELATIVE to the
      // column that spawned it. A shot of the panel alone looks identical whether it is contained
      // or overflowing.
      clip: null,
    },
    // rev4 predates this menu; there is nothing to score it against. Explicitly null so compare.mjs
    // says "no reference" instead of quietly matching it to an unrelated mock.
    mock: null,
  },
];

export const THEMES = ["light", "dark"];

/** Look a surface up by name. Throws with the valid list, which is friendlier than `undefined`. */
export function surfaceByName(name) {
  const s = SURFACES.find((x) => x.name === name);
  if (!s) {
    throw new Error(
      `Unknown surface "${name}". Known surfaces: ${SURFACES.map((x) => x.name).join(", ")}`,
    );
  }
  return s;
}

/**
 * Resolve a `--surfaces=a,b` style filter to surface records. An empty/absent filter means all.
 * Pure, so the CLI parsing is unit-testable without a browser.
 */
export function selectSurfaces(filter) {
  if (!filter) return SURFACES;
  return filter
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(surfaceByName);
}

/** `<surface>-<theme>.png` — the one place the artifact naming convention is defined. */
export function artifactName(surfaceName, theme) {
  return `${surfaceName}-${theme}.png`;
}

/**
 * Turn one step into a JS expression evaluated in the page. Returned as source (not executed) so
 * the same registry drives the app page and the mock page through the same driver.
 */
export function stepToExpression(step) {
  if (step.waitFor) return `document.querySelector(${JSON.stringify(step.waitFor)})`;
  if (step.click) {
    return `(() => { const e = document.querySelector(${JSON.stringify(step.click)});
      if (!e) return false; e.click(); return true; })()`;
  }
  if (step.clickText) {
    const { sel, t } = step.clickText;
    return `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})]
      .find((n) => n.textContent.trim() === ${JSON.stringify(t)});
      if (!e) return false; e.click(); return true; })()`;
  }
  if (step.setAttr) {
    const { sel, name, value } = step.setAttr;
    return `(() => { const e = document.querySelector(${JSON.stringify(sel)});
      if (!e) return false; e.setAttribute(${JSON.stringify(name)}, ${JSON.stringify(value)});
      return true; })()`;
  }
  if (step.cable) {
    // The APP's wired state lives in the cable store, not in the DOM. Setting `data-wired` by hand
    // wired nothing — React owns that attribute — so this drives the store through the dev-only
    // handle visualFixtures installs, and returns false when it is absent so a missing handle fails
    // the step loudly instead of silently capturing the unwired app.
    //
    // ── AND THEN IT VERIFIES, BECAUSE CALLING `patch` IS NOT BEING WIRED ────────────────────────
    // This step used to return `true` the moment the store action had been CALLED. That is a
    // precondition, not the effect: `useEffectiveWired` only projects a side once the far end
    // actually has a selected agent, so `patch("left")` against a fixture with no left-pair project
    // leaves the shell at `data-wired="off"` and the capture photographs the UNWIRED app under a
    // name that says otherwise. `workspace-wired-left` did exactly that — including after the fix
    // whose comment claims it made these surfaces real — and a mounted-row seam went five rounds
    // partly because the one instrument that could have shown it was scoring the wrong state.
    //
    // So the step now succeeds only when the SHELL AGREES. Since steps are retried until they pass,
    // a side that cannot actually be reached fails the run loudly instead of quietly mislabelling a
    // PNG. AGENTS.md: assert the side effect, never the precondition.
    // The requested side IS the value the shell must project — `off` included — so this compares
    // against `step.cable` directly. It was written as a ternary mapping "off" to "off", which is a
    // tautology that reads as though it were translating a value it is not (roborev 57327).
    return `(() => { const f = window.__sparkleCable; if (!f) return false;
      f(${JSON.stringify(step.cable)});
      const shell = document.querySelector("[data-testid=workspace-shell]");
      return shell != null && shell.getAttribute("data-wired") === ${JSON.stringify(step.cable)}; })()`;
  }
  throw new Error(`Unrecognised step: ${JSON.stringify(step)}`);
}
