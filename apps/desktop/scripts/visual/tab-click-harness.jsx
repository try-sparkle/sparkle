// The page `tab-click-probe.mjs` measures. Mounts the REAL `ProjectTabs` with the app's own
// stylesheet in a real browser and counts every React commit its subtree takes, so a click can be
// priced in commits rather than in impressions.
//
// `.jsx` rather than `.tsx` on purpose: `tsconfig.json` includes only `src`, so a `.tsx` here would
// be silently outside `pnpm typecheck` and look covered when it is not. Everything under
// scripts/visual is plain JS for the same reason.
import { Profiler, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import { ProjectTabs } from "../../src/components/ProjectTabs";

const params = new URLSearchParams(location.search);
/** The strip width to model. The probe drives this. */
const WIDTH = Number(params.get("w") ?? 520);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";

/**
 * The founder's own bar — the same six long-named projects `tab-crowded-harness.jsx` uses, and for
 * the same reason: the report comes from a strip under real crowding pressure, where the hover
 * expansion, the min-width floor and the badges are all live. A bare two-tab strip would not
 * exercise the code paths under suspicion.
 */
const PROJECTS = [
  { id: "p1", name: "sparkle-desktop", rootPath: "/w/sparkle-desktop" },
  { id: "p2", name: "foundry-web", rootPath: "/w/foundry-web" },
  { id: "p3", name: "trystero-relay", rootPath: "/w/trystero-relay" },
  { id: "p4", name: "atlas-infra", rootPath: "/w/atlas-infra" },
  { id: "p5", name: "beacon-mobile", rootPath: "/w/beacon-mobile" },
  { id: "p6", name: "cinder-docs", rootPath: "/w/cinder-docs" },
];

function band(n) {
  return { needs_you: n, questions: 0, running: 0, done: 0 };
}
const COUNTS = { p2: band(50), p3: band(35), p4: band(7) };
const STALENESS = {
  p1: { behind: 155, base: "origin/main" },
  p2: { behind: 50, base: "origin/main" },
  p3: { behind: 35, base: "origin/main" },
};

/**
 * THE COMMIT LOG. Every entry is one commit in which the strip's subtree rendered, stamped with the
 * time so the probe can separate the commits a click causes IMMEDIATELY from the ones that keep
 * arriving after it — a tail of late commits is what "blinks a lot of times" looks like in data.
 */
window.__commits = [];

/**
 * WHEN EACH INPUT ACTUALLY ARRIVED, stamped in the page.
 *
 * The probe splits a gesture's commits into the first frame and the tail using the FIRST COMMIT as
 * the origin, because a timestamp taken around its CDP round-trips would measure the transport
 * rather than the strip. That leaves one real thing unmeasured — how long the gesture took to
 * respond at all — and these stamps are how it comes back without the transport, with a DIFFERENT
 * pair of endpoints per gesture:
 *
 *   click   `firstCommit - __lastPressT`   — any commit at all is a response to the press.
 *   hover   `__expandedT - __firstMoveT`   — not a commit: the hover's job is the EXPANSION, and
 *                                            grading an arbitrary early commit as though it were
 *                                            the expansion is a defect this file has already had.
 *
 * THE PRESS, not the release, is the click's origin. Measuring from the RELEASE goes negative the
 * moment anything commits on the PRESS — a regression this strip has had (focus re-settling an
 * expansion the pointer had already opened) — and a negative latency is exactly the kind of number
 * a check waves through.
 *
 * There is deliberately NO `pointerup` stamp and NO last-`pointermove` stamp. Both existed and both
 * are gone: the release origin for the reason above, and the last-move origin because it is
 * contaminated by the CDP round-trip between the two moves `movePointer` sends (the settle timer is
 * armed by the first). Leaving them here as unread globals would be an invitation — the next check
 * wanting a move timestamp would reach for the plausible `__lastMoveT` and silently re-acquire a
 * defect this file spent two review rounds removing (roborev 62866).
 *
 * Capture phase, so a handler calling `stopPropagation` cannot hide an input from them.
 */
window.__lastPressT = null;
window.addEventListener(
  "pointerdown",
  () => {
    window.__lastPressT = performance.now();
  },
  true,
);

/**
 * THE FIRST move since the last reset — which is the one the hover latency has to be measured from.
 *
 * The strip arms its settle timer on the ENTER transition, and `scheduleSettle` refuses to re-arm
 * while one is in flight ("one timer runs from the first transition"). The probe sends two moves a
 * pixel apart, so the second changes nothing about when the expansion lands — measuring from it
 * would subtract the CDP round-trip between the two, which is the transport contamination these
 * stamps exist to keep out, and would bias the number toward passing by an unbounded amount.
 */
window.__firstMoveT = null;
window.addEventListener(
  "pointermove",
  () => {
    if (window.__firstMoveT === null) window.__firstMoveT = performance.now();
  },
  true,
);

/** Clear the commit log AND the input stamps together: a stamp left over from the previous phase
 *  would be measured against this phase's first commit and report a latency from nothing. */
window.__resetCommits = () => {
  window.__commits = [];
  window.__lastPressT = null;
  window.__firstMoveT = null;
  window.__expandedT = null;
  // WAS A TAB ALREADY EXPANDED WHEN THIS PHASE BEGAN? The click phase deliberately starts with the
  // pointer parked on an expanded tab, so without this the next commit would re-stamp `__expandedT`
  // and the value would silently mean "the first commit of this phase" — which is the exact
  // quantity the expansion stamp exists to stop measuring (roborev 62855).
  window.__expandedAtReset = !!document.querySelector('[data-expanded="true"]');
};

/**
 * WHEN THE EXPANSION ACTUALLY APPEARED — the event the hover latency is about.
 *
 * Stamped from the `Profiler`'s `onRender`, which runs during the commit phase, so the DOM already
 * carries `data-expanded` by the time this reads it. Measuring the first commit OF ANY KIND instead
 * would only be the expansion's latency by assumption: any unrelated early commit (a chrome
 * re-measure, badge churn, a future hover affordance rendered before the settle fires) would be
 * graded as though it were the expansion, and the probe's floor would tell the reader its origin
 * was wrong — the one cause it definitely would not be.
 */
window.__expandedT = null;
window.__expandedAtReset = false;
function stampExpansion() {
  const expanded = !!document.querySelector('[data-expanded="true"]');
  // THE false->true TRANSITION, not the first observation of `true`. A phase that begins with a tab
  // already expanded (the click phase does, by design) has to see it go away before an expansion
  // can be said to have "appeared" — otherwise the name is true only in phases that happen to start
  // collapsed, which is a meaning that holds by assumption rather than by construction.
  if (window.__expandedAtReset) {
    if (!expanded) window.__expandedAtReset = false;
    return;
  }
  if (window.__expandedT === null && expanded) window.__expandedT = performance.now();
}

function Harness() {
  const [selected, setSelected] = useState("p1");
  // Published so the probe can assert the click actually LANDED, not merely that it was cheap. A
  // fast click that selects nothing is the other half of the founder's report.
  window.__selected = selected;
  return (
    <div id="strip" style={{ width: `${WIDTH}px` }}>
      <Profiler
        id="strip"
        onRender={(_id, phase, actualDuration) => {
          window.__commits.push({ t: performance.now(), phase, ms: actualDuration });
          stampExpansion();
        }}
      >
        <ProjectTabs
          projects={PROJECTS}
          selectedProjectId={selected}
          pinnedProjectId={null}
          countsByProject={COUNTS}
          stalenessByProject={STALENESS}
          onSelect={setSelected}
          onTogglePin={() => {}}
          onClose={() => {}}
          onAddProject={() => {}}
        />
      </Profiler>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Harness />);

// The probe waits on this rather than a fixed sleep: React commits a frame after mount, and the
// strip's natural-width measurement is a LAYOUT effect that runs after that.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    window.__tabHarnessReady = true;
  });
});
