// The page `tab-crowded-probe.mjs` measures. Mounts the REAL `ProjectTabs` at a real strip width,
// with the app's own stylesheet, in a real browser — the only place flex shrinking, `min-width`
// floors, `text-overflow` and an element's actual left edge exist at all (jsdom has none of them).
//
// `.jsx` rather than `.tsx` on purpose: `tsconfig.json` includes only `src`, so a `.tsx` here would
// be silently outside `pnpm typecheck` and look covered when it is not. Everything under
// scripts/visual is plain JS for the same reason.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import { ProjectTabs } from "../../src/components/ProjectTabs";

const params = new URLSearchParams(location.search);
/** The strip width to model. The probe drives this. */
const WIDTH = Number(params.get("w") ?? 520);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";

/**
 * Six projects with real-length folder names — the founder's own bar, which is where the report
 * came from. Names this long are the point: at 520px the strip cannot show six of them, so the
 * layout is genuinely under the pressure that produced "fo..." and "t..".
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

/**
 * THE BADGES FROM THE SCREENSHOT, and they are not decoration here.
 *
 * Every badge is `flex: none`, so they are exactly what starves the label — a tab carrying ⚠155 and
 * an always-visible × is the one that lost its name entirely. Measuring a bare strip with no badges
 * would be measuring a layout the founder never has.
 */
const COUNTS = { p2: band(50), p3: band(35), p4: band(7) };
const STALENESS = {
  p1: { behind: 155, base: "origin/main" },
  p2: { behind: 50, base: "origin/main" },
  p3: { behind: 35, base: "origin/main" },
};

function Harness() {
  // The SELECTED tab is the one that showed no name at all in the report, so it has to be a real
  // selection driven through the component's own prop rather than a hard-coded id.
  const [selected, setSelected] = useState("p1");
  return (
    <div id="strip" style={{ width: `${WIDTH}px` }}>
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
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Harness />);

// The probe waits on this rather than a fixed sleep: React commits a frame after mount, and the
// natural-width measurement the floor depends on is a LAYOUT effect that runs after that.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    window.__tabHarnessReady = true;
  });
});
