// The page `tab-column-probe.mjs` measures: a REAL `Pair` shape — one tab strip above a
// `[build, terminal]` column row — so "the active tab is shaded like the column beneath it" becomes
// a question about resolved colours in a real engine.
//
// ── WHY A BROWSER IS REQUIRED FOR THIS ONE ─────────────────────────────────────────────────────
//
// `ProjectTabs.columnFill.test.tsx` already pins the rule in jsdom, and it is not redundant with
// this — but there is exactly one link in the chain it CANNOT check, and that link is load-bearing.
// The component paints the active tab with `getComputedStyle(column).backgroundColor`. Both real
// columns declare their background as a CSS custom property (`C.deepForest` / `C.forest` are
// `var(--c-deep-forest)` / `var(--c-forest)`), and jsdom does not resolve custom properties — so
// the unit test has to hand its fixture columns concrete hex instead.
//
// If a real engine ever answered `""` or an unresolved `var(...)` there, the component would read
// no colour, fall back to `C.forest`, and the founder's bug would be back with every unit test
// still green. That is the specific failure this page exists to make impossible: here the columns
// carry the SAME `var()` the app ships, so a passing probe proves the resolution actually happens.
//
// `.jsx` rather than `.tsx`: `tsconfig.json` includes only `src`, so a `.tsx` here would sit
// outside `pnpm typecheck` and look covered when it is not. Everything under scripts/visual is
// plain JS for that reason.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import { ProjectTabs } from "../../src/components/ProjectTabs";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";

/** The pair's width, and how much of it the build column takes. The rest is the terminal, so the
 *  strip above spans BOTH and the later tabs genuinely sit over the terminal — which is the whole
 *  configuration under test. The probe does not depend on these numbers: it reads the real rects
 *  and works out which column each tab is over. */
const WIDTH = Number(params.get("w") ?? 900);
const BUILD_W = Number(params.get("build") ?? 300);

const PROJECTS = [
  { id: "p1", name: "alpha-one" },
  { id: "p2", name: "beta-two" },
  { id: "p3", name: "gamma-three" },
  { id: "p4", name: "delta-four" },
  { id: "p5", name: "epsilon-five" },
];

function Harness() {
  const [selected, setSelected] = useState(params.get("active") ?? "p1");
  return (
    // `data-pair` is what scopes the tab's column lookup to this pair — see engine/pairColumns.
    <div data-pair style={{ display: "flex", flexDirection: "column", width: `${WIDTH}px` }}>
      <div>
        <ProjectTabs
          projects={PROJECTS}
          selectedProjectId={selected}
          pinnedProjectId={null}
          countsByProject={{}}
          onSelect={setSelected}
          onTogglePin={() => {}}
          onClose={() => {}}
        />
      </div>
      {/* The two planes, declared exactly as the shell declares them: the build column in
          `--c-deep-forest` (AgentSidebar) and the terminal stage in `--c-forest` (Workspace). The
          `var()` is the point — see the header. */}
      <div style={{ display: "flex", height: "160px" }}>
        <div
          data-pair-column="build"
          data-testid="build-col"
          style={{ width: `${BUILD_W}px`, background: "var(--c-deep-forest)" }}
        />
        <div
          data-pair-column="terminal"
          data-testid="term-col"
          style={{ flex: 1, background: "var(--c-forest)" }}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Harness />);

// The probe waits on this rather than a fixed sleep: React commits a frame after mount, and the
// strip's column-fill read is a LAYOUT effect that runs after that.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    window.__tabColumnHarnessReady = true;
  });
});
