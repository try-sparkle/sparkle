// The page `tab-seam-probe.mjs` photographs. Mounts the REAL `ProjectTabs` over a CONTENT PLANE, so
// "the active tab opens into the content area like a folder tab" (bead sparkle-civ4i) becomes a
// question about pixels rather than about source.
//
// `.jsx` rather than `.tsx` on purpose: `tsconfig.json` includes only `src`, so a `.tsx` here would
// be silently outside `pnpm typecheck` and look covered when it is not. Everything under
// scripts/visual is plain JS for the same reason.
//
// ── WHY THE PLANE BELOW IS `--c-forest` ────────────────────────────────────────────────────────
//
// It is the token the ACTIVE TAB'S OWN BODY paints (`C.forest` in ProjectTabs.tsx). A folder tab is
// a tab whose face and the page beneath it are ONE surface, so modelling the content area with the
// same token is what makes the claim falsifiable: if nothing separates them, a vertical scan down
// through the active tab is a single run, and any rule that survives shows up as a band between two
// identical colours — the shape `seam-probe.mjs` was written to catch.
//
// The plane is NOT a claim about what the cockpit renders under the strip (that is the build column
// and the terminal stage, which have their own planes). The probe's primary verdict does not depend
// on it: it reads the rule's colour off an INACTIVE tab's own column and then asserts that colour is
// absent under the active one, which holds whatever is underneath.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import { ProjectTabs } from "../../src/components/ProjectTabs";

const params = new URLSearchParams(location.search);
/** The strip width to model. The probe drives this. Narrow enough that six long names crowd. */
const WIDTH = Number(params.get("w") ?? 620);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";

/**
 * Six LONG names and no badges.
 *
 * Long, because the strip has to be genuinely CROWDED for the hover expansion to do anything: a tab
 * whose name already fits expands to the width it already has, and the click-across-an-expansion
 * case below would then be measuring a gesture that cannot go wrong. `tab-click-harness.jsx` uses
 * the same six for the same reason.
 *
 * No badges, unlike that harness, and that is the one place they differ. This probe reads a VERTICAL
 * COLUMN of pixels, and every badge is another non-background colour that can land in it and make
 * the runs ambiguous — where the click probe only ever reads commit counts.
 */
const PROJECTS = [
  { id: "p1", name: "sparkle-desktop", rootPath: "/w/sparkle-desktop" },
  { id: "p2", name: "foundry-web", rootPath: "/w/foundry-web" },
  { id: "p3", name: "trystero-relay", rootPath: "/w/trystero-relay" },
  { id: "p4", name: "atlas-infra", rootPath: "/w/atlas-infra" },
  { id: "p5", name: "beacon-mobile", rootPath: "/w/beacon-mobile" },
  { id: "p6", name: "cinder-docs", rootPath: "/w/cinder-docs" },
];

/** The initially active tab. Not the first, so a scan of `p1` is a real inactive-tab reading rather
 *  than the edge case of the strip's leading tab. */
const INITIAL = "p2";

function Harness() {
  const [selected, setSelected] = useState(INITIAL);
  // Published so the probe can assert a click on a NON-ACTIVE tab actually landed.
  window.__selected = selected;
  return (
    <div id="page" style={{ width: `${WIDTH}px` }}>
      <ProjectTabs
        projects={PROJECTS}
        selectedProjectId={selected}
        pinnedProjectId={null}
        countsByProject={{}}
        onSelect={setSelected}
        onTogglePin={() => {}}
        onClose={() => {}}
        onAddProject={() => {}}
      />
      {/* THE CONTENT AREA the active tab is supposed to open into. Tall enough that a scan can run
          well past the bar's bottom edge and still land on plain plane. */}
      <div
        id="content"
        data-testid="seam-content"
        style={{ height: "160px", background: "var(--c-forest)" }}
      />
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
