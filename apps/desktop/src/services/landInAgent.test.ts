// @vitest-environment jsdom
//
// landInAgent is the ONE answer to "the user asked for this agent — put it in front of them", and
// the reason it exists is that the four call sites had drifted into four different partial answers.
// These tests pin all four steps together, against the REAL stores, so a future edit that drops one
// of them fails here rather than in the app.
import { describe, it, expect, beforeEach } from "vitest";
import { landInAgent } from "./landInAgent";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";

function seed(): { pid: string; a: string; b: string } {
  const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
  const a = useProjectStore.getState().addAgent(pid, { kind: "build" })!;
  const b = useProjectStore.getState().addAgent(pid, { kind: "build" })!;
  return { pid, a, b };
}

const selectionIn = (pid: string) =>
  useProjectStore.getState().projects.find((p) => p.id === pid)?.selectedAgentId;

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  useUiStore.setState({ activeSpecial: null, revealAgentId: null });
});

describe("landInAgent", () => {
  it("selects, opens, and reveals the agent", () => {
    const { pid, a, b } = seed();
    // `b` was selected by its own creation; land on `a` so the assertion can't pass by accident.
    expect(selectionIn(pid)).toBe(b);

    landInAgent(pid, a);

    expect(selectionIn(pid)).toBe(a);
    expect(useRuntimeStore.getState().openAgentIds).toContain(a);
    expect(useUiStore.getState().revealAgentId).toBe(a);
  });

  // THE bug this whole change is about. Selecting an agent while the Plan board owns the pane
  // changes nothing on screen — the board keeps rendering. sendToBuild is reached by clicking
  // "Start"/"Build It" ON the board, so this is not an edge case there, it is the only case.
  it("leaves the Plan board — otherwise the pane never switches and the selection is invisible", () => {
    const { pid, a } = seed();
    useUiStore.setState({ activeSpecial: "board" });

    landInAgent(pid, a);

    expect(useUiStore.getState().activeSpecial).toBeNull();
  });

  it("leaves the Improve-Sparkle pane for the same reason", () => {
    const { pid, a } = seed();
    useUiStore.setState({ activeSpecial: "sparkle" });

    landInAgent(pid, a);

    expect(useUiStore.getState().activeSpecial).toBeNull();
  });

  // The reveal request is a one-shot token consumed by the matching AgentRow, not a latch. Landing
  // twice must re-arm it, or the second hand-off silently does nothing (see uiStore.clearRevealAgent).
  it("re-arms the reveal after a row has consumed it", () => {
    const { pid, a, b } = seed();

    landInAgent(pid, a);
    useUiStore.getState().clearRevealAgent(a); // the row scrolled itself into view
    expect(useUiStore.getState().revealAgentId).toBeNull();

    landInAgent(pid, b);
    expect(useUiStore.getState().revealAgentId).toBe(b);
  });

  // It does NOT take the caret. That is a separate claim with a narrower contract (uiStore's
  // requestComposeFocus doc: "EVERY caller of this is the user asking for the caret"), and only
  // some callers have earned it — useSpawnBuildAgent has (empty agent, you're about to type),
  // sendToBuild has not (it arrives with a seeded prompt). Folding it in here would hand the caret
  // to the concierge box on every board hand-off.
  it("does NOT steal the caret — that is the call site's decision", () => {
    const { pid, a } = seed();
    const before = useUiStore.getState().composeFocusSeq;

    landInAgent(pid, a);

    expect(useUiStore.getState().composeFocusSeq).toBe(before);
  });
});
