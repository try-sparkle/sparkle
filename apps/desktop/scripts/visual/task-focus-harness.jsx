// The page `task-focus-probe.mjs` drives. It mounts the REAL `BeadPillHost` — not a stubbed
// context — so clicking "in column" runs the SHIPPED `viewInColumn` against the SHIPPED stores, in
// a real browser, with real event dispatch.
//
// ── WHY THIS EXISTS BESIDE THE UNIT TESTS ───────────────────────────────────────────────────────
// `BeadPill.openEpic.test.tsx` already drives the same host and asserts the same store keys, and it
// is the faster instrument. What it CANNOT do is prove the control is reachable by a human: jsdom
// has no layout, so a link that is present in the DOM but zero-sized, clipped by an overflow, or
// covered by a sibling passes every one of those rows. This page renders at a real concierge width
// with the real stylesheet and clicks by hit-testing the element's own box, so "the founder can
// press it" is the thing being tested rather than assumed.
//
// ── THE ASSERTION IS ABOUT THE TWO RUNGS, WHICH IS WHAT MAKES IT WORTH A PAGE ───────────────────
// Both links look identical and both narrow the column. What separates them is WHICH STORE KEY the
// click writes, and the founder's constraint is stated in those terms: opening a TASK must not
// disturb the epic, *"without closing the open epic card"* — the epics column decides that from
// `epicFocusBySide` alone. So the probe opens an epic, then opens a task, and checks the epic key
// SURVIVED while the column narrowed to the task.
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import { ConciergeThread } from "../../src/components/Concierge/ConciergeThread";
import { BeadPillHost } from "../../src/components/Concierge/BeadPill";
import { useBeadsStore } from "../../src/stores/beadsStore";
import { useProjectStore } from "../../src/stores/projectStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { focusedBeadIdForSide, useUiStore } from "../../src/stores/uiStore";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
const WIDTH = Number(params.get("w") ?? 380);

function bead(over) {
  return {
    title: "A bead",
    description: "Short, so both cards fit the viewport without scrolling.",
    status: "open",
    type: "task",
    priority: 1,
    labels: [],
    parent: null,
    commentCount: 0,
    ...over,
  };
}

// An epic and one of its CHILDREN — the exact pair the founder's sentence is about.
const EPIC = bead({
  id: "sparkle-epic1",
  type: "epic",
  status: "in_progress",
  title: "EPIC: the build column can be narrowed",
});
const TASK = bead({
  id: "sparkle-task1",
  parent: "sparkle-epic1",
  status: "in_progress",
  title: "Rotate the auth-failure retry",
});
const BEADS = [EPIC, TASK];

// THE POLLER IS STUBBED, not disabled: `startPolling` shells out to `bd` through a Tauri bridge this
// page does not have, and a rejected call would leave the host unresolved. Stubbing the two actions
// says "don't poll" while leaving beads ON, so the REAL resolution path still runs — the same thing
// the unit tests do, for the same reason.
useBeadsStore.setState({ startPolling: () => {}, stopPolling: () => {} });
useBeadsStore.setState({
  byProject: { p1: { beads: BEADS, board: {}, loadedAt: 1 } },
});
useProjectStore.setState({
  projects: [{ id: "p1", name: "sparkle", rootPath: "/tmp/sparkle", agents: [] }],
  selectedProjectId: "p1",
});
useSettingsStore.setState({ beadsEnabled: true, beadCardsExpanded: true, beadCardsExpandedMax: 10 });
// A KNOWN STARTING POINT, so the probe's "the epic key survived" reading cannot be satisfied by a
// value that was already there when the page loaded.
useUiStore.setState({
  epicFocusBySide: { left: null, right: null },
  beadFocusBySide: { left: null, right: null },
  workModeBySide: { left: "build", right: "plan" },
});

// What the probe reads back. Exposed as a FUNCTION rather than the store object, so the page decides
// what "the answer" is and the probe cannot accidentally assert on an internal shape.
window.__focusState = () => ({
  epic: useUiStore.getState().epicFocusBySide.right,
  bead: useUiStore.getState().beadFocusBySide.right,
  effective: focusedBeadIdForSide(useUiStore.getState(), "right"),
  workMode: useUiStore.getState().workModeBySide.right,
});

const MESSAGES = [
  {
    id: "m1",
    kind: "sparkle",
    text: `The epic is sparkle-epic1 and the task under it is sparkle-task1.`,
  },
];

function Harness() {
  return (
    <BeadPillHost>
      <div
        id="column"
        style={{ width: `${WIDTH}px`, background: "var(--c-concierge-surface)", padding: "10px 0" }}
      >
        <ConciergeThread
          messages={MESSAGES}
          typing={false}
          turnFloor={-1}
          statuses={{}}
          onNudgeClick={() => {}}
          onNudgeAction={() => {}}
        />
      </div>
    </BeadPillHost>
  );
}

createRoot(document.getElementById("root")).render(<Harness />);
requestAnimationFrame(() => requestAnimationFrame(() => (window.__taskFocusHarnessReady = true)));
