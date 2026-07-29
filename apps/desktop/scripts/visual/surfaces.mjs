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
 *   { setAttr: {sel,name,value} }  set an attribute (how mock states are reached)
 */

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
        { setAttr: { sel: "[data-testid=workspace-shell]", name: "data-wired", value: "off" } },
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
    description: "The live cable seated in the LEFT pair.",
    app: {
      steps: [
        { waitFor: "[data-testid=workspace-shell]" },
        { waitFor: "[data-testid=agent-sidebar-column]" },
        { setAttr: { sel: "[data-testid=workspace-shell]", name: "data-wired", value: "left" } },
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
        { setAttr: { sel: "[data-testid=workspace-shell]", name: "data-wired", value: "right" } },
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
  throw new Error(`Unrecognised step: ${JSON.stringify(step)}`);
}
