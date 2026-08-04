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
 *   { mic: {enabled,status?,phase?} } seed the dictation store's OBSERVATIONS (see below)
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
    // ── THE SETTINGS PANE THE FOUNDER ASKED TO HAVE EMPTIED ───────────────────────────────────
    // "We're no longer doing the wake word. This section should be removed." What this photographs
    // is the ABSENCE of the always-listening checkbox, the WAKE WORD field and the STOP WORD field
    // — so it clips the dialog with the Voice pane SELECTED, which the generic `settings-dialog`
    // surface does not do (that one lands on the default category and would show none of this
    // either way, for the wrong reason).
    name: "settings-voice",
    description: "Settings → Voice controls: the microphone picker and the send-tray explainer.",
    app: {
      steps: [
        // ONE CLICK, not a menu. The 3-dot control was a dropdown whose only remaining entry was
        // "Settings", so it was consolidated into a plain button — and the two surfaces that still
        // walked the old menu path (this one and `settings-dialog`) have been failing their
        // `waitFor` ever since, which is why neither had a current baseline.
        { waitFor: 'button[aria-label="Settings"]' },
        { click: 'button[aria-label="Settings"]' },
        { waitFor: '[role=dialog][aria-label="Settings"]' },
        { clickText: { sel: '[role=dialog][aria-label="Settings"] button', t: "Voice controls" } },
        // The PANE'S OWN heading — proof the rail click LANDED, not merely that a dialog is open.
        // Without it a failed click photographs whichever pane happened to be selected and the file
        // is still named "settings-voice". Assert the side effect, never the precondition.
        { waitFor: '[data-testid=settings-voice-pane]' },
      ],
      clip: '[role=dialog][aria-label="Settings"]',
    },
    // rev4 has no settings dialog at all — recorded as an explicit null so compare.mjs reports "no
    // reference" rather than scoring it against something it isn't.
    mock: null,
  },
  {
    // ── THE SEND TRAY, ONE SURFACE PER POSITION ───────────────────────────────────────────────
    // The tray is now the ONLY mic control, so each position's own copy is the thing to look at.
    // The mic step is what makes these meaningful: without it `status` never leaves "idle" in a
    // headless browser and all three would photograph the identical focus-paused state, which is
    // exactly the "three surfaces, one picture" trap workspace-wired-left fell into.
    //
    // Speak: armed AND routing — the state its "Actively listening / Just pause when you're done"
    // caption and composer copy describe.
    name: "send-tray-speak",
    description: "The concierge with the tray on Speak — always-on dictation, live.",
    app: {
      steps: [
        { waitFor: 'section[aria-label="Sparkle concierge"]' },
        { clickText: { sel: 'section[aria-label="Sparkle concierge"] button', t: "Speak" } },
        // THE TRAY ACTUALLY MOVED — the `data-wired` equivalent, and the same lesson: `clickText`
        // returns true the moment `.click()` is called, which is a precondition, not the effect. The
        // copy that distinguishes these three pictures is derived from state the `mic` step SEEDS,
        // so without this a click that lands on a same-text button (or on a pill whose handler
        // declines) still yields a green run and a screenshot showing one mode's caption over a tray
        // parked in another (roborev 57793).
        { waitFor: "[data-testid=send-mode-tray][data-mode=speak]" },
        { mic: { enabled: true, status: "listening", phase: "active" } },
        // …AND THEN A RENDERED READ, for the same reason the tray click gets one. The `mic` step's
        // own comparison happens inside its `setState` — before React commits and before the app's
        // derivation, which rewrites `status` on the arm path — so it can only observe its own
        // write. This waits on what `deriveMicPresentation` actually concluded (roborev 57798).
        { waitFor: "[data-mic-presentation=activeListening]" },
      ],
      clip: 'section[aria-label="Sparkle concierge"]',
    },
    mock: null,
  },
  {
    // Push to talk AT REST: armed, capturing, routing nothing. This is the state the founder was
    // shown wake-word copy in — "Mic paused. Say Hey Sparkle to activate" under a tray reading PUSH
    // TO TALK — so it is the single most important picture in this set.
    name: "send-tray-ptt",
    description: "The concierge with the tray on Push to talk, between holds.",
    app: {
      steps: [
        { waitFor: 'section[aria-label="Sparkle concierge"]' },
        { clickText: { sel: 'section[aria-label="Sparkle concierge"] button', t: "Push to talk" } },
        { waitFor: "[data-testid=send-mode-tray][data-mode=ptt]" },
        { mic: { enabled: true, status: "listening", phase: "passive" } },
        // Push to talk AT REST is `passiveWaiting` — armed and capturing, routing nothing. Naming
        // the exact presentation is what stops this surface passing while showing Speak's picture.
        { waitFor: "[data-mic-presentation=passiveWaiting]" },
      ],
      clip: 'section[aria-label="Sparkle concierge"]',
    },
    mock: null,
  },
  {
    // ── THE LIVE DEEPGRAM PREVIEW, MID-UTTERANCE ──────────────────────────────────────────────
    // The provisional words painted italic at the end of the draft (Concierge/MentionMirror), which
    // is what the founder means by "Deepgram italics". It had NO coverage of any kind — not a
    // visual surface, not a screenshot — because it exists only between a partial arriving and the
    // segment settling, over a live cloud relay. So "the italics are gone" could not be answered by
    // looking at anything; it took a Deepgram probe and a log correlation to even establish which
    // half of the pipe was at fault (bead sparkle-phdw2).
    //
    // The seed is the state a PUSH-TO-TALK HOLD produces, and every field is load-bearing:
    // `phase: "active"` + `voiceSurface: "concierge"` are what `useConciergeDictation` requires
    // before it will pass `interim` down at all, so a surface that seeded the text alone would
    // photograph an empty composer and read as a regression when nothing was broken.
    name: "composer-interim",
    description: "The concierge composer mid-utterance: provisional Deepgram words, italic.",
    app: {
      steps: [
        { waitFor: 'section[aria-label="Sparkle concierge"]' },
        { clickText: { sel: 'section[aria-label="Sparkle concierge"] button', t: "Push to talk" } },
        { waitFor: "[data-testid=send-mode-tray][data-mode=ptt]" },
        {
          mic: {
            enabled: true,
            status: "listening",
            phase: "active",
            voiceSurface: "concierge",
            interim: "these words are still provisional",
          },
        },
        // The ASSERTION, not decoration: the ghost span only exists while the composer is actually
        // painting a preview, so waiting on it is what makes this surface fail loudly if the
        // italics ever stop rendering — rather than quietly capturing an empty box.
        { waitFor: "[data-testid=concierge-interim]" },
        // …AND THEN THE PRESENTATION READ, because every mic surface must end on one (see the
        // registry rule in harness.test.mjs). The two prove different halves and both are wanted:
        // the ghost proves the provisional ink is painted, this proves the mic state the app
        // DERIVED for it is the live one. A held push-to-talk is `activeListening` — same
        // derivation as Speak, since `deriveMicPresentation` reads `phase`, not the tray position —
        // which is exactly what distinguishes this surface from `send-tray-ptt`'s `passiveWaiting`.
        { waitFor: "[data-mic-presentation=activeListening]" },
      ],
      clip: 'section[aria-label="Sparkle concierge"]',
    },
    mock: null,
  },
  {
    // Send: the mic is released. The composer makes no voice promise and falls back to its own
    // "what this box is for" copy — the `captionKind === "none"` branch.
    name: "send-tray-send",
    description: "The concierge with the tray on Send — the microphone is off.",
    app: {
      steps: [
        { waitFor: 'section[aria-label="Sparkle concierge"]' },
        { clickText: { sel: 'section[aria-label="Sparkle concierge"] button', t: "Send" } },
        // LOAD-BEARING HERE ABOVE ALL, because this is the surface where the click provably does
        // nothing: `send` is uiStore's default, so the pill is ALREADY selected and its handler
        // early-returns. The picture is right only by accident of that default, and this is what
        // turns "by accident" into "checked".
        { waitFor: "[data-testid=send-mode-tray][data-mode=send]" },
        { mic: { enabled: false } },
        { waitFor: "[data-mic-presentation=off]" },
      ],
      clip: 'section[aria-label="Sparkle concierge"]',
    },
    mock: null,
  },
  {
    name: "settings-dialog",
    description: "The settings modal, opened from the ⋯ menu.",
    app: {
      // Opened by CLICKING the real affordances rather than by poking the store, so the capture
      // also proves the path a user takes still works. Both selectors are pre-existing ARIA, so no
      // component needed a new hook.
      steps: [
        // See `settings-voice` above: the 3-dot dropdown became a one-click Settings button, and
        // this surface's `waitFor` on the old menu had been timing out ever since.
        { waitFor: 'button[aria-label="Settings"]' },
        { click: 'button[aria-label="Settings"]' },
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
  {
    // ── THE GROUPED MENU, SQUEEZED ──────────────────────────────────────────────────────────────
    //
    // The same hostile width as `open-pr-menu-narrow`, but with TWO repos' PRs in the panel. It is
    // a separate surface rather than a wider fixture on that one because they answer different
    // questions and must be able to fail independently: that one asks "does the panel escape a
    // half-width column", this one asks "does it still escape once the rows carry a repo as well".
    // Grouping adds section headers and pushes every row's own content along, so a panel that was
    // comfortably contained can start clipping at exactly the width where nobody is looking.
    //
    // THREE parameters, each doing something no other can. `prs=1` populates the chip at all (the
    // transport shim answers `project_open_prs` with null otherwise, so there is no badge to click);
    // `projects=2` opens the SECOND PROJECT TAB, which is what makes the menu multi-repo — the
    // fixture answers per root path, so the two projects return different PR lists, one of which
    // deliberately reuses a PR NUMBER from the other; `concierge=190` squeezes the column to half
    // its default, the width the original clipping bug was reported at (bead sparkle-8g4qh).
    name: "open-pr-menu-grouped-narrow",
    query: "prs=1&projects=2&concierge=190",
    description: "The open-PR menu grouped by project, over a HALF-WIDTH concierge column.",
    app: {
      steps: [
        { waitFor: "[data-testid=workspace-shell]" },
        { cable: "off" },
        { waitFor: "[data-testid=open-pr-badge]" },
        { click: "[data-testid=open-pr-badge]" },
        { waitFor: "[data-testid=open-pr-panel]" },
      ],
      // FULL VIEWPORT for the same reason `open-pr-menu-narrow` is: the thing under test is where
      // the panel sits RELATIVE to the column that spawned it, and a shot of the panel alone looks
      // identical whether it is contained or overflowing.
      clip: null,
    },
    // No rev4 reference — the mock predates the menu entirely, let alone a grouped one. Explicitly
    // null so compare.mjs reports "no reference" rather than scoring it against something it isn't.
    mock: null,
  },
  {
    // ── THE GROUPED MENU AT A COMFORTABLE WIDTH ─────────────────────────────────────────────────
    //
    // The narrow shot is evidence about CONTAINMENT (the panel escapes its column); this one is
    // evidence about the CONTENT: that the section headers name their projects, that the two repos'
    // rows read as two groups rather than one run of eight, and that a PR number appearing in both
    // groups still resolves to two distinguishable rows. Judging that off a squeezed capture would
    // confound "the grouping is wrong" with "the column is too narrow to show it", which is exactly
    // the pair a single surface cannot separate.
    //
    // `concierge=360` IS THE APP'S DEFAULT (`CONCIERGE_DEFAULT_WIDTH`), STATED RATHER THAN IMPLIED,
    // and it has to be. This surface first shipped with no `concierge` parameter at all, on the
    // reasoning that writing nothing yields the app's own default — and that is true only of a cold
    // profile. The capture harness drives every surface through ONE browser context, so
    // `sparkle-concierge-width` survives from surface to surface; a surface that writes no width
    // inherits whatever the previously-captured one left there. Running this straight after
    // `open-pr-menu-grouped-narrow` therefore photographed a 190px column under a filename claiming
    // a comfortable one, and the two PNGs came out BYTE-IDENTICAL. Naming the width makes the
    // surface independent of capture order, which is the only property that makes it evidence.
    name: "open-pr-menu-grouped-wide",
    query: "prs=1&projects=2&concierge=360",
    description: "The open-PR menu grouped by project, at the default (360px) concierge width.",
    app: {
      steps: [
        { waitFor: "[data-testid=workspace-shell]" },
        { cable: "off" },
        { waitFor: "[data-testid=open-pr-badge]" },
        { click: "[data-testid=open-pr-badge]" },
        { waitFor: "[data-testid=open-pr-panel]" },
      ],
      clip: null,
    },
    mock: null,
  },
  {
    // ── MERGE RIGHTS + DISMISSALS, EXPANDED (bead sparkle-j881r) ────────────────────────────────
    //
    // Two states no other surface can reach, and both are new ROWS in an already-crowded row — the
    // exact place this menu has regressed twice, and both times it was a photograph that caught it
    // rather than the suite (jsdom lays nothing out, so no assertion here can see a control being
    // squeezed).
    //
    //   • The NO-MERGE-RIGHTS row: green checks, clean merge state, and a DISABLED Merge with the
    //     words "No merge rights" beside the dot. The picture answers the question the unit tests
    //     cannot — whether that longer state word pushes the primary action into truncating.
    //   • The DISMISSED section, EXPANDED. It is collapsed by default, so a capture that only
    //     opened the panel would photograph the summary line and nothing else; the extra click is
    //     what puts the restore affordance in frame.
    //
    // AT THE DEFAULT WIDTH, and stated rather than implied — see `open-pr-menu-grouped-wide` for
    // why an omitted `concierge` inherits the previously-captured surface's width and silently
    // produces a byte-identical PNG under a filename claiming otherwise. The narrow companion
    // below carries the containment half.
    name: "open-pr-menu-dismissed-wide",
    query: "prs=1&projects=2&concierge=360",
    description:
      "The open-PR menu with a no-merge-rights row and the Dismissed section expanded, at the default concierge width.",
    app: {
      steps: [
        { waitFor: "[data-testid=workspace-shell]" },
        { cable: "off" },
        { waitFor: "[data-testid=open-pr-badge]" },
        { click: "[data-testid=open-pr-badge]" },
        { waitFor: "[data-testid=open-pr-panel]" },
        // THE SECOND CLICK IS THE POINT. Without it the Dismissed rows are not in the DOM at all.
        { waitFor: "[data-testid=pr-dismissed-toggle]" },
        { click: "[data-testid=pr-dismissed-toggle]" },
        { waitFor: "[data-testid=pr-dismissed-list]" },
        // THE PANEL SCROLLS. Both new states live at its foot, so without this the capture
        // photographs the top of the list and proves nothing about either of them.
        { scrollTo: "[data-testid=pr-dismissed-list]" },
      ],
      clip: null,
    },
    mock: null,
  },
  {
    // The same content at the HOSTILE width — the containment half, and the one that has actually
    // regressed. 190px (half the default) is the width the original clipping bug was reported at
    // (bead sparkle-8g4qh); the question here is whether a sixth control in the row and a new
    // section at the panel's foot still leave the primary action and the blocking reason unelided.
    name: "open-pr-menu-dismissed-narrow",
    query: "prs=1&projects=2&concierge=190",
    description:
      "The open-PR menu with a no-merge-rights row and the Dismissed section expanded, over a HALF-WIDTH concierge column.",
    app: {
      steps: [
        { waitFor: "[data-testid=workspace-shell]" },
        { cable: "off" },
        { waitFor: "[data-testid=open-pr-badge]" },
        { click: "[data-testid=open-pr-badge]" },
        { waitFor: "[data-testid=open-pr-panel]" },
        { waitFor: "[data-testid=pr-dismissed-toggle]" },
        { click: "[data-testid=pr-dismissed-toggle]" },
        { waitFor: "[data-testid=pr-dismissed-list]" },
        // THE PANEL SCROLLS. Both new states live at its foot, so without this the capture
        // photographs the top of the list and proves nothing about either of them.
        { scrollTo: "[data-testid=pr-dismissed-list]" },
      ],
      clip: null,
    },
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
  if (step.scrollTo) {
    // BRING A SCROLLED-OUT ELEMENT INTO FRAME.
    //
    // A panel with its own `overflow-y: auto` can hold far more than it shows, and a capture of it
    // photographs the TOP of the list regardless of what the surface claims to be evidence about.
    // The open-PR menu is exactly that: `maxHeight: min(420px, 100vh - 80px)`, so the rows at the
    // foot of a two-project list — and the Dismissed section below them — are simply not in the
    // picture, and a surface named for them would score identically whether they render or not.
    //
    // ASSERTS THE SIDE EFFECT, not the call. `scrollIntoView` is synchronous with `behavior:
    // "instant"`, so the element's box is readable immediately afterwards — and this returns true
    // only once that box is actually inside the viewport. A target inside a container that cannot
    // scroll (or one that is display:none) therefore fails the step loudly and the run stops,
    // rather than quietly capturing the unscrolled panel under a filename that says otherwise. That
    // is the same mistake `cable` shipped with and the reason it now verifies the shell.
    return `(() => { const e = document.querySelector(${JSON.stringify(step.scrollTo)});
      if (!e) return false;
      e.scrollIntoView({ behavior: "instant", block: "nearest" });
      const r = e.getBoundingClientRect();
      return r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight; })()`;
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
  if (step.mic) {
    // THE MICROPHONE'S OBSERVATIONS, seeded through the dev-only handle visualFixtures installs.
    //
    // Needed because the live voice states cannot otherwise be photographed at all: `status` only
    // reaches "listening" when a real backend opens a device and downloads a model, neither of which
    // exists in a headless browser — so every mic surface would capture the focus-paused copy no
    // matter which tray position it asked for. This writes only what the app OBSERVES (armed,
    // capturing, routing) and lets the app's own derivation (voice/micPresentation) do the rest, so
    // a capture cannot show a state the real derivation would not produce.
    //
    // It VERIFIES rather than trusting the call, exactly as the `cable` step above had to learn to:
    // the handle returns the resulting snapshot and this compares it against what was asked for, so
    // a missing handle or a rejected write fails the step loudly instead of quietly photographing a
    // mic in whatever state the previous surface left it in.
    const want = step.mic;
    return `(() => { const f = window.__sparkleMic; if (!f) return false;
      const got = f(${JSON.stringify(want)});
      if (!got) return false;
      return got.enabled === ${JSON.stringify(want.enabled)}
        && got.status === ${JSON.stringify(want.status ?? "idle")}
        && (${JSON.stringify(want.phase ?? null)} === null || got.phase === ${JSON.stringify(want.phase ?? null)})
        && (${JSON.stringify(want.interim ?? null)} === null || got.interim === ${JSON.stringify(want.interim ?? null)})
        && (${JSON.stringify(want.voiceSurface ?? null)} === null || got.voiceSurface === ${JSON.stringify(want.voiceSurface ?? null)}); })()`;
  }
  throw new Error(`Unrecognised step: ${JSON.stringify(step)}`);
}
