// The page `blocked-row-narrow-probe.mjs` measures. Mounts the REAL `PinnedBlockers` row at a real
// width, with the app's own stylesheet, in a real browser — the only place `text-overflow` and an
// element's actual box overlap exist at all (jsdom has none of them).
//
// `.jsx` rather than `.tsx`, matching every other file in this directory: `tsconfig.json` includes
// only `src`, so a `.tsx` here would be silently outside `pnpm typecheck`.
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import { PinnedBlockers } from "../../src/components/Concierge/PinnedBlockers";
import { AgentPillProvider } from "../../src/components/Concierge/AgentPill";

const params = new URLSearchParams(location.search);
/** The concierge column width to model. The probe drives this; 280 is a plausible default. */
const WIDTH = Number(params.get("w") ?? 280);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";

/** The founder's own screenshot named this agent — reusing it keeps the probe pointed at the exact
 *  case that was reported rather than a synthetic stand-in. */
const LONG_NAME = "Sparkle Preview Agent Eyes";

const ROSTER = [
  { id: "a", name: LONG_NAME, projectId: "p1", projectName: "sparkle", band: "needs_you", canAcceptInput: true },
  { id: "b", name: "Drodio Admin Calendar", projectId: "p2", projectName: "drodio-website", band: "needs_you", canAcceptInput: true },
];

const BLOCKERS = [
  {
    id: "a",
    kind: "nudge",
    agentName: LONG_NAME,
    projectName: "sparkle",
    band: "needs_you",
    text: "Waiting on an approval.",
    actions: [{ id: "approve", label: "Approve", kind: "primary" }],
  },
  {
    id: "b",
    kind: "nudge",
    agentName: "Drodio Admin Calendar",
    projectName: "drodio-website",
    band: "needs_you",
    text: "Waiting on an approval.",
    actions: [{ id: "approve", label: "Approve", kind: "primary" }],
  },
];

/** Records clicks so the probe can prove the row stays a working control at every tier. */
window.__blockedRowClicks = [];
window.__blockedRowActions = [];

function Harness() {
  return (
    <AgentPillProvider value={{ agents: ROSTER, onOpenAgent: () => "revealed" }}>
      {/* The concierge column's content box, at the width under test. `overflow: visible` is
          deliberate — a scroll container would HIDE the very overflow this page exists to catch. */}
      <div
        id="column"
        style={{
          width: `${WIDTH}px`,
          display: "flex",
          flexDirection: "column",
          fontSize: 13,
          background: "var(--c-concierge-surface)",
        }}
      >
        <PinnedBlockers
          blockers={BLOCKERS}
          acknowledged={[]}
          onNudgeClick={(b) => window.__blockedRowClicks.push(b.id)}
          onNudgeAction={(b, actionId) => window.__blockedRowActions.push([b.id, actionId])}
        />
      </div>
    </AgentPillProvider>
  );
}

createRoot(document.getElementById("root")).render(<Harness />);
// Nothing here is async, but the probe waits on this rather than on a selector so it cannot read a
// half-committed tree.
requestAnimationFrame(() => requestAnimationFrame(() => (window.__blockedRowHarnessReady = true)));
