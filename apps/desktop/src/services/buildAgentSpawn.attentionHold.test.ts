// @vitest-environment jsdom
//
// "IF MY MOUSE IS ACTIVELY CLICKED INTO A TERMINAL, DON'T MOVE ME TO THE NEW BUILD AGENT."
// — the founder, verbatim, and the whole subject of this file.
//
// This is the SAME two-directions-at-once problem `buildAgentSpawn.background.test.ts` solves, with
// one difference that changes every assertion: a background spawn is one NOBODY asked for, and this
// one the founder DID ask for. So it may not be quieter than it has to be — the agent must still
// start, its project must still be mountable, and the moment his caret is anywhere else the jump
// must happen exactly as it does today.
//
// EVERY HOLD CASE IS PAIRED WITH ITS OPPOSITE. Without the pairs, deleting `landInAgent` from the
// spawn outright passes this entire file, which is the vacuous shape AGENTS.md names as the #1
// fleet-wide finding: the assertions would all be about something being ABSENT, and absence is what
// you get when the feature is gone.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("./tasks", () => ({ createBeadFull: vi.fn(async () => "bd-new") }));

import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";
import { markProjectVisited, resetVisitedProjects, wasProjectVisited } from "./sessionProjects";
import { spawnBuildAgentInProject } from "./buildAgentSpawn";
import { resetAgentBriefs } from "./agentBrief";
import { resetSatellites } from "./satelliteWindows";
import { TERMINAL_SURFACE_ATTR, TERMINAL_AGENT_ATTR } from "../voice/dictationFocus";
import type { Project } from "../types";

function project(name: string, root: string): Project {
  const id = useProjectStore.getState().addProject(name, root);
  return useProjectStore.getState().projects.find((p) => p.id === id)!;
}

function projectById(id: string): Project {
  return useProjectStore.getState().projects.find((p) => p.id === id)!;
}

/** The DOM `Terminal.tsx` actually builds: our marker on the wrapper, xterm's hidden textarea (the
 *  thing that holds the caret) several levels inside it. Focusing that textarea is as close as a
 *  jsdom test gets to "the founder clicked into this terminal and is typing". */
function focusTerminalOf(agentId: string): void {
  const host = document.createElement("div");
  host.setAttribute(TERMINAL_SURFACE_ATTR, "");
  host.setAttribute(TERMINAL_AGENT_ATTR, agentId);
  host.innerHTML = `<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>`;
  document.body.appendChild(host);
  host.querySelector<HTMLTextAreaElement>("textarea")!.focus();
}

/** The MOUNTED CONCIERGE's compose box — a plain textarea, NOT a terminal, which is exactly why it
 *  needs its own case. `text` empty models the app's steady state (focused, nothing typed). */
function focusComposeBox(text: string): void {
  const ta = document.createElement("textarea");
  document.body.appendChild(ta);
  ta.value = text;
  ta.focus();
}

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  useRuntimeStore.setState({ branchStatus: {}, workflowStage: {}, openAgentIds: [] });
  useSettingsStore.setState({
    maxConcurrentWorkers: 8,
    effectiveMaxConcurrentWorkers: 8,
    machineMaxConcurrentWorkers: 8,
    concurrencyBound: "cpu",
    concurrencyBasis: "CPU-bound: 18 cores × 2 agents per core",
  });
  useUiStore.setState({
    activeSpecial: null,
    revealAgentId: null,
    revealAnchorY: null,
    composeFocusSeq: 0,
    openProjectIds: null,
    pairAssignment: {},
    leftProjectId: null,
  });
  resetVisitedProjects();
  resetAgentBriefs();
  resetSatellites();
});

afterEach(() => {
  document.body.innerHTML = "";
});

/**
 * Put the founder somewhere REAL first, so "nothing moved" is a claim with content.
 *
 * Same shape (and same ordering trap) as `buildAgentSpawn.background.test.ts`: both projects exist
 * BEFORE the seeding spawn, because `addProject` selects what it creates — so if Beta were created
 * second, `selectedProjectId` would already be Beta and a held spawn into Beta could leave it
 * "unchanged" while having done nothing at all.
 */
function seedFounderInAlpha(): { a: Project; b: Project; agentId: string } {
  const b = project("Beta", "/tmp/beta");
  const a = project("Alpha", "/tmp/alpha");
  const agentId = spawnBuildAgentInProject(a)!;
  expect(agentId).toBeTruthy();
  expect(useProjectStore.getState().selectedProjectId).toBe(a.id);
  expect(projectById(a.id).selectedAgentId).toBe(agentId);
  // The founder has looked at Beta this session and navigated away. Seeded so the visited set is
  // true for a reason this spawn did not cause.
  markProjectVisited(b.id);
  // The seeding spawn asked to reveal its own row and took the caret; clear both so the assertions
  // below are about THIS spawn rather than about that one.
  useUiStore.setState({ revealAgentId: null, composeFocusSeq: 0 });
  return { a, b, agentId };
}

describe("spawnBuildAgentInProject — the founder's caret is in a terminal", () => {
  it("leaves the selected PROJECT and the selected AGENT exactly where he left them", () => {
    const { a, b, agentId } = seedFounderInAlpha();
    focusTerminalOf(agentId);

    const spawned = spawnBuildAgentInProject(b, { prompt: "go fix the thing", attention: "auto" })!;
    expect(spawned).toBeTruthy();

    // Still looking at Alpha…
    expect(useProjectStore.getState().selectedProjectId).toBe(a.id);
    // …at the agent he was typing in…
    expect(projectById(a.id).selectedAgentId).toBe(agentId);
    // …and Beta's own selection was NOT filled in with the new agent. `select: false` is absolute.
    expect(projectById(b.id).selectedAgentId).not.toBe(spawned);
    // Nothing asked the sidebar to scroll, and nothing pulled the caret into the composer.
    expect(useUiStore.getState().revealAgentId).toBeNull();
    expect(useUiStore.getState().composeFocusSeq).toBe(0);
  });

  it("STILL creates, opens and briefs the agent — held is quiet, never fictional", () => {
    // THE MOST IMPORTANT ASSERTION HERE. `Workspace` renders a pane per OPEN id, that pane drives the
    // PTY launch, and the brief is claude's positional argv at that launch. A guard that suppressed
    // the mount would report success for an agent that never runs.
    const { b, agentId } = seedFounderInAlpha();
    focusTerminalOf(agentId);

    const spawned = spawnBuildAgentInProject(b, { prompt: "go fix the thing", attention: "auto" })!;

    expect(projectById(b.id).agents.map((x) => x.id)).toContain(spawned);
    expect(useRuntimeStore.getState().openAgentIds).toContain(spawned);
    // The OTHER half of Workspace's mount gate. A held spawn WAS asked for, so — unlike a background
    // one — it still writes the visited set rather than refusing.
    expect(wasProjectVisited(b.id)).toBe(true);
  });

  it("does not tear down whatever he was looking at — the Sparkle pane and the Plan board stay up", () => {
    // `landInAgent`'s step 1 drops both. Seeded UP, because the default store is already quiet on
    // these keys and asserting against the default would pass before this change existed.
    const { b, agentId } = seedFounderInAlpha();
    useUiStore.setState({ activeSpecial: "sparkle", workModeBySide: { left: "plan", right: "plan" } });
    focusTerminalOf(agentId);

    spawnBuildAgentInProject(b, { prompt: "go fix the thing", attention: "auto" });

    expect(useUiStore.getState().activeSpecial).toBe("sparkle");
    expect(useUiStore.getState().workModeBySide).toEqual({ left: "plan", right: "plan" });
  });

  // ══ THE CARET IS A SEPARATE GRANT FROM THE VIEW ══════════════════════════════════════════════
  // An EMPTY spawn (no brief) is the one path that pulls the caret into the concierge composer, on
  // the reasoning that "the next thing the user does is type". While he is already typing in a
  // terminal that reasoning is exactly inverted — and it is the loudest form of the steal, because
  // the keyboard moves with no pane change to hint at why. Asserted on the EMPTY path deliberately:
  // the briefed tests above never reach this branch, so a `composeFocusSeq` assertion there proves
  // nothing about it.
  it("does not pull the caret into the composer on an EMPTY spawn while he is in a terminal", () => {
    const { b, agentId } = seedFounderInAlpha();
    focusTerminalOf(agentId);

    spawnBuildAgentInProject(b, { attention: "auto" });

    expect(useUiStore.getState().composeFocusSeq).toBe(0);
  });

  it("PAIRED: an EMPTY spawn with the caret nowhere DOES take it — the pull was not deleted", () => {
    const { b } = seedFounderInAlpha();

    spawnBuildAgentInProject(b, { attention: "auto" });

    expect(useUiStore.getState().composeFocusSeq).toBeGreaterThan(0);
  });

  // ══ THE PAIRED DIRECTION ══════════════════════════════════════════════════════════════════════
  // Delete the landing from the spawn entirely and every assertion above still passes. This is the
  // one that fails, and it is what makes them mean something.
  it("PAIRED: with the caret NOWHERE, the spawn lands him in the new agent exactly as before", () => {
    const { b } = seedFounderInAlpha();
    // No focusTerminalOf — the caret is on <body>, the ordinary state when he clicks a sidebar row.

    const spawned = spawnBuildAgentInProject(b, { prompt: "go fix the thing", attention: "auto" })!;

    expect(useProjectStore.getState().selectedProjectId).toBe(b.id);
    expect(projectById(b.id).selectedAgentId).toBe(spawned);
    expect(useUiStore.getState().revealAgentId).toBe(spawned);
  });

  // ══ TABBING AWAY MID-TURN MUST NOT UNDO THE GUARD ═════════════════════════════════════════════
  // The concrete failure a `hasFocus()` clause reintroduced, caught in review: the founder leaves
  // the caret in a terminal and cmd-tabs to another app while a long concierge turn runs. If an
  // inactive window reported "nothing is held", the spawn would land unhindered and he would tab
  // back into a different pane with his next keystrokes going to the composer — his own complaint,
  // deferred by one window activation rather than prevented. Asserted at the SPAWN, not just on the
  // predicate, because that is the seam a future change would actually break.
  it("still declines while the window is in the BACKGROUND — he tabbed away mid-turn", () => {
    const { a, b, agentId } = seedFounderInAlpha();
    focusTerminalOf(agentId);
    const spy = vi.spyOn(document, "hasFocus").mockReturnValue(false);

    try {
      const spawned = spawnBuildAgentInProject(b, { prompt: "one", attention: "auto" })!;

      expect(useProjectStore.getState().selectedProjectId).toBe(a.id);
      expect(projectById(a.id).selectedAgentId).toBe(agentId);
      expect(projectById(b.id).selectedAgentId).not.toBe(spawned);
      // The caret half matters most here: the promptless path would otherwise pull it into the
      // composer, so he returns to the app already typing somewhere he never put the caret.
      expect(useUiStore.getState().composeFocusSeq).toBe(0);
      // …and it still really started.
      expect(useRuntimeStore.getState().openAgentIds).toContain(spawned);
    } finally {
      spy.mockRestore();
    }
  });

  it("PAIRED: focus in a terminal that BLURS again releases the hold — it is live focus, not a latch", () => {
    const { b, agentId } = seedFounderInAlpha();
    focusTerminalOf(agentId);
    (document.activeElement as HTMLElement).blur();

    const spawned = spawnBuildAgentInProject(b, { attention: "auto" })!;

    expect(projectById(b.id).selectedAgentId).toBe(spawned);
  });
});

// ══ A HUMAN GESTURE IS NEVER DECLINED ══════════════════════════════════════════════════════════
// The guard's entire safety argument is that it declines only jumps the APP starts — an earlier,
// wider terminal-focus veto had to be REVERTED because it declined things the user had just asked
// for. `spawnBuildAgentInProject` is the body of three direct gestures as well as of the concierge
// tool, so the split lives on `attention` (default "user") rather than on the DOM alone.
describe("spawnBuildAgentInProject — a gesture the founder made himself", () => {
  it("lands him in the new agent even with a terminal focused, when no `attention` is declared", () => {
    // "+ New Build Agent" in the sidebar, the Workspace empty-state button, a file drop.
    const { b, agentId } = seedFounderInAlpha();
    focusTerminalOf(agentId);

    const spawned = spawnBuildAgentInProject(b, { prompt: "go fix the thing" })!;

    expect(useProjectStore.getState().selectedProjectId).toBe(b.id);
    expect(projectById(b.id).selectedAgentId).toBe(spawned);
    expect(useUiStore.getState().revealAgentId).toBe(spawned);
  });

  it('is likewise never declined for an explicit `attention: "user"`', () => {
    const { b, agentId } = seedFounderInAlpha();
    focusTerminalOf(agentId);

    const spawned = spawnBuildAgentInProject(b, { attention: "user" })!;

    expect(projectById(b.id).selectedAgentId).toBe(spawned);
    // …and it still takes the caret, which is the half a DROP flow depends on: the dropped paths
    // are queued for "the new agent's composer to drain once it mounts", and that composer only
    // becomes the aim because this landed.
    expect(useUiStore.getState().composeFocusSeq).toBeGreaterThan(0);
  });
});

describe("spawnBuildAgentInProject — the MOUNTED CONCIERGE's compose box", () => {
  it("holds when the box is half-typed — it is a textarea, not a terminal, and he is mid-sentence", () => {
    const { a, b, agentId } = seedFounderInAlpha();
    focusComposeBox("start an agent that fixes the ");

    const spawned = spawnBuildAgentInProject(b, { prompt: "fix the thing", attention: "auto" })!;

    expect(useProjectStore.getState().selectedProjectId).toBe(a.id);
    expect(projectById(a.id).selectedAgentId).toBe(agentId);
    expect(projectById(b.id).selectedAgentId).not.toBe(spawned);
    // Still real.
    expect(useRuntimeStore.getState().openAgentIds).toContain(spawned);
  });

  // PAIRED, and this one is load-bearing rather than symmetric: a focused EMPTY compose box is the
  // app's steady state. Holding on it would mean a spawn asked for through the concierge — the
  // overwhelmingly common case — stopped landing him anywhere at all.
  it("PAIRED: an EMPTY compose box does not hold — the concierge's own spawns still land", () => {
    const { b } = seedFounderInAlpha();
    focusComposeBox("");

    const spawned = spawnBuildAgentInProject(b, { prompt: "fix the thing", attention: "auto" })!;

    expect(useProjectStore.getState().selectedProjectId).toBe(b.id);
    expect(projectById(b.id).selectedAgentId).toBe(spawned);
  });
});

describe("spawnBuildAgentInProject — SEVERAL agents in one concierge turn", () => {
  // The founder: "I sometimes spawn two or three." No batching logic exists and none is needed —
  // the hold is read live at each spawn, and because the first one does not move his caret, the
  // second and third read the same answer. This test is what pins that reasoning to behaviour.
  it("none of three spawns in one turn moves him", () => {
    const { a, b, agentId } = seedFounderInAlpha();
    focusTerminalOf(agentId);

    const ids = [
      spawnBuildAgentInProject(b, { prompt: "one", attention: "auto" })!,
      spawnBuildAgentInProject(b, { prompt: "two", attention: "auto" })!,
      spawnBuildAgentInProject(b, { prompt: "three", attention: "auto" })!,
    ];

    expect(new Set(ids).size).toBe(3);
    expect(useProjectStore.getState().selectedProjectId).toBe(a.id);
    expect(projectById(a.id).selectedAgentId).toBe(agentId);
    for (const id of ids) {
      expect(projectById(b.id).selectedAgentId).not.toBe(id);
      expect(useRuntimeStore.getState().openAgentIds).toContain(id);
    }
    expect(useUiStore.getState().revealAgentId).toBeNull();
  });

  it("PAIRED: with the caret nowhere, three spawns leave him in the LAST one — today's behaviour", () => {
    const { b } = seedFounderInAlpha();

    spawnBuildAgentInProject(b, { prompt: "one", attention: "auto" });
    spawnBuildAgentInProject(b, { prompt: "two", attention: "auto" });
    const last = spawnBuildAgentInProject(b, { prompt: "three", attention: "auto" })!;

    expect(projectById(b.id).selectedAgentId).toBe(last);
  });
});
