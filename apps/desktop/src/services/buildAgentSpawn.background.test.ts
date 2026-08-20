// A SPAWN THE HUMAN DID NOT ASK FOR MUST NOT TAKE THEIR SCREEN — AND MUST STILL ACTUALLY START.
//
// Those two halves pull in opposite directions, which is the whole reason this file exists.
// `spawnBuildAgentInProject` lands the human in the new agent (markProjectOpen →
// selectProjectOnItsSide → markProjectVisited → landInAgent, plus requestComposeFocus on the empty
// path). That is exactly right for the "+ New Build Agent" button and exactly wrong for an
// automatic sweep, which fires on a timer and would yank the founder's view mid-task.
//
// But the naive fix — skip all of it — is worse than the bug. `Workspace` mounts a pane per project
// that is visited-or-current × the agents in the runtime OPEN set (its `live` memo), the pane mount
// is what drives the PTY launch, and the opening brief is claude's positional argv AT THAT LAUNCH
// (services/agentBrief). Drop the mount and the agent is created and briefed on paper, never runs,
// and every caller downstream reports success.
//
// So the assertions come in BOTH directions, and the foreground test at the bottom is not padding:
// without it, deleting the landing outright passes every background test in this file.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./tasks", () => ({ createBeadFull: vi.fn(async () => "bd-new") }));

import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";
import { markProjectVisited, resetVisitedProjects, wasProjectVisited } from "./sessionProjects";
import { localAgentCapacity } from "./agentCapacity";
import { spawnBuildAgentInProject } from "./buildAgentSpawn";
import { briefForLaunch, briefRecord, hasUndeliveredBrief, resetAgentBriefs } from "./agentBrief";
import { claimSatellite, isTornOut, resetSatellites } from "./satelliteWindows";
import type { Project } from "../types";

function project(name: string, root: string): Project {
  const id = useProjectStore.getState().addProject(name, root);
  return useProjectStore.getState().projects.find((p) => p.id === id)!;
}

function projectById(id: string): Project {
  return useProjectStore.getState().projects.find((p) => p.id === id)!;
}

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  useRuntimeStore.setState({ branchStatus: {}, workflowStage: {}, openAgentIds: [] });
  useSettingsStore.setState({
    maxConcurrentWorkers: 3,
    effectiveMaxConcurrentWorkers: 3,
    machineMaxConcurrentWorkers: 3,
    concurrencyBound: "cpu",
    concurrencyBasis: "CPU-bound: 18 cores × 2 agents per core",
  });
  // The attention surfaces this file asserts on. Reset explicitly — `setState` MERGES, so a value
  // left standing by an earlier test makes these assertions depend on declaration order.
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

/** The Plan board + Improve-Sparkle pane, both UP. `landInAgent`'s step 1 is what tears them down,
 *  and the default store is already quiet on both keys — so a "nothing moved" assertion against the
 *  default would pass before this change existed and prove nothing (roborev 58263). */
function seedBoardAndSparklePane(): void {
  useUiStore.setState({
    activeSpecial: "sparkle",
    workModeBySide: { left: "plan", right: "plan" },
  });
}

/**
 * Put the user somewhere REAL first, so "nothing moved" is a claim with content.
 *
 * An assertion against an empty/undefined selection would have passed before the background flag
 * existed and would prove nothing (AGENTS.md's #1 fleet-wide finding). So this seeds an actual prior
 * selection: a foreground spawn in project A — the human's own "+ New Build Agent" click — which is
 * the exact state a later background spawn into B must leave untouched.
 *
 * ORDER MATTERS AND IS NOT COSMETIC. Both projects are created BEFORE the seeding spawn, because
 * `addProject` selects the project it creates: creating B second (the obvious way to write this)
 * would move `selectedProjectId` to B on its own, so a background spawn into B could then leave the
 * selection "unchanged" while having done nothing at all. Creating B first and landing on A after
 * means B is somewhere the user has demonstrably navigated AWAY from, and re-selecting it is a move
 * the assertion can see.
 */
function seedHumanSelection(): { a: Project; b: Project; agentId: string } {
  const b = project("Beta", "/tmp/beta");
  const a = project("Alpha", "/tmp/alpha");
  const agentId = spawnBuildAgentInProject(a)!;
  expect(agentId).toBeTruthy();
  expect(useProjectStore.getState().selectedProjectId).toBe(a.id);
  expect(projectById(a.id).selectedAgentId).toBe(agentId);
  // THE HUMAN HAS LOOKED AT B THIS SESSION, then navigated away to A. Seeded explicitly because a
  // background spawn now REFUSES a project that was never on screen (knightwatch #1251 probe 1): it
  // may not write the human-only visited set to manufacture its own mount eligibility, so the set
  // has to be true for a reason the spawn did not cause. B stays the project the user is NOT looking
  // at, which is what every "nothing moved" assertion below depends on.
  markProjectVisited(b.id);
  return { a, b, agentId };
}

describe("spawnBuildAgentInProject({ background: true }) — spawn without hijacking the screen", () => {
  it("leaves the selected PROJECT and the selected AGENT exactly where the human left them", () => {
    const { a, b, agentId } = seedHumanSelection();
    const composeBefore = useUiStore.getState().composeFocusSeq;

    const bg = spawnBuildAgentInProject(b, { background: true })!;
    expect(bg).toBeTruthy();

    // The window is still looking at A…
    expect(useProjectStore.getState().selectedProjectId).toBe(a.id);
    expect(useUiStore.getState().leftProjectId).toBeNull();
    // …at the agent the human was in…
    expect(projectById(a.id).selectedAgentId).toBe(agentId);
    // …and B's own selection was not filled in either. `select: false` is ABSOLUTE: a null selection
    // is a deliberate state, not a hole for a machine-created agent to backfill (AddAgentOpts.select).
    expect(projectById(b.id).selectedAgentId).not.toBe(bg);
    // Nothing asked the sidebar to scroll to a row nobody requested. Note the standing request is
    // the SEEDED one (the human's own spawn asked to reveal its agent), not null — asserting null
    // here would have been asserting that the seed never happened.
    expect(useUiStore.getState().revealAgentId).toBe(agentId);
    expect(useUiStore.getState().revealAgentId).not.toBe(bg);
    // And the caret stayed wherever the human had it (test 4's subject, pinned here too because a
    // background spawn with no prompt is the case that used to take it unconditionally).
    expect(useUiStore.getState().composeFocusSeq).toBe(composeBefore);
  });

  it("STILL puts the new agent in the open set — the pane mounts, so the launch happens", () => {
    // THE MOST IMPORTANT ASSERTION IN THIS FILE. `Workspace` renders a pane per OPEN id, not per
    // selection, and that pane is what drives the PTY launch. A "background" spawn that skipped
    // `runtime.open` would create a briefed agent that never starts while reporting success.
    const { b } = seedHumanSelection();
    const bg = spawnBuildAgentInProject(b, { background: true })!;

    expect(useRuntimeStore.getState().openAgentIds).toContain(bg);
    // The OTHER half of Workspace's mount gate is per PROJECT, and it is satisfied by the SEED (the
    // human looked at B), never by this spawn — see the refusal tests below, which are what pin that
    // direction. Asserted here only so "the pane will mount" is stated in full at the one place that
    // claims it.
    expect(wasProjectVisited(b.id)).toBe(true);
    // The row exists in B, not in A.
    expect(projectById(b.id).agents.map((x) => x.id)).toContain(bg);
  });

  // ── knightwatch #1251 probe 1: the visited set is NOT ours to write ──────────────────────────
  //
  // `services/sessionProjects` only ever GROWS within a session and feeds TWO consumers: Workspace's
  // pane mount AND the roster publisher. Its header says the leak it exists to close is "never-opened
  // projects (and their prompt snippets) into the tray and the phone relay". A background spawn that
  // marked a project visited would publish that project to the tray and the phone for the rest of the
  // session, and closing the agent would never take it back.
  it("REFUSES a project the human has not looked at, instead of marking it visited to force a mount", () => {
    seedHumanSelection();
    const c = project("Gamma", "/tmp/gamma");
    // Gamma is in the store but has never been on screen — exactly the case a background dispatcher
    // pointed at an arbitrary projectId hits.
    expect(wasProjectVisited(c.id)).toBe(false);

    const bg = spawnBuildAgentInProject(c, { background: true, prompt: "babysit #1234" });

    expect(bg).toBeNull();
    // THE SIDE EFFECT THAT MATTERS: the leak did not happen. Without the refusal this reads `true`,
    // and Gamma's prompt snippets would ride the next roster push to the phone.
    expect(wasProjectVisited(c.id)).toBe(false);
    // Refused BEFORE anything was created, matching the capacity and torn-out gates.
    expect(projectById(c.id).agents).toHaveLength(0);
    expect(useRuntimeStore.getState().openAgentIds).toHaveLength(1);
  });

  it("does not re-open a tab the human deliberately closed", () => {
    const { b } = seedHumanSelection();
    // The human closed B's tab; the open-tab set is explicit rather than null (null means "all").
    useUiStore.setState({ openProjectIds: [] });

    const bg = spawnBuildAgentInProject(b, { background: true })!;
    expect(bg).toBeTruthy();

    // knightwatch #1251 probe 3: `markProjectOpen` is foreground-only now. It changes the contents of
    // the tab strip, which is a visible change to a window the human owns, made for a spawn they
    // never asked for. Reading `[]` here is the whole assertion — before the fix this held B's id.
    expect(useUiStore.getState().openProjectIds).toEqual([]);
  });

  // THE PAIRED DIRECTION (roborev 58424). Without it, `markProjectOpen` could be DELETED outright
  // and the whole suite — including the test above — would stay green, because "background skips it"
  // and "nobody calls it at all" are indistinguishable from the background side. That is the exact
  // regression roborev 55095 is cited for two lines from the call site: a selection whose tab is
  // closed leaves every tab reading aria-selected="false", and it self-heals the WRONG way on the
  // next tab close.
  it("FOREGROUND still opens the tab — the narrowing did not delete markProjectOpen", () => {
    const { b } = seedHumanSelection();
    useUiStore.setState({ openProjectIds: [] });

    const fg = spawnBuildAgentInProject(b)!;
    expect(fg).toBeTruthy();

    expect(useUiStore.getState().openProjectIds).toContain(b.id);
  });

  it("still attaches the brief for the launch argv", () => {
    const BRIEF = "Answer the unanswered review probes on PR #1234.";
    const { b } = seedHumanSelection();
    const bg = spawnBuildAgentInProject(b, { background: true, prompt: BRIEF })!;

    expect(hasUndeliveredBrief(bg)).toBe(true);
    expect(briefForLaunch(bg, false)).toBe(BRIEF);
    // The whole point of the brief surviving: it rides the launch of the pane the open-set entry
    // above guarantees.
    expect(useRuntimeStore.getState().openAgentIds).toContain(bg);
  });

  it("marks the background brief MACHINE-authored, and leaves the foreground one unmarked", () => {
    // BOTH CANDIDATES MOUNTED IN ONE TEST, on purpose. Asserting only the background half would pass
    // against a change that marks EVERY spawn machine-authored — which would silently stop billing
    // the "+ New Build Agent" and concierge spawns that are supposed to bill. The pair is what pins
    // the rule; one direction alone is half the evidence.
    //
    // What the mark buys, at the other end of the chain: `recordPromptSideEffects` keys the free-
    // trial debit, the ghost-text corpus and auto-naming on the record's PRESENCE, so an unmarked
    // babysit brief billed a prompt for a timer-driven dispatch nobody made and taught the corpus a
    // generated brief. No `promptId` either way — nothing was written to the store here, so the
    // delivery path must still append the row.
    const { b } = seedHumanSelection();

    const bg = spawnBuildAgentInProject(b, { background: true, prompt: "Babysit PR #1234." })!;
    const fg = spawnBuildAgentInProject(b, { prompt: "Investigate the dead pill." })!;

    expect(briefRecord(bg)).toEqual({ humanAuthored: false });
    expect(briefRecord(fg)).toBeUndefined();
  });

  it("does not request compose focus, on the EMPTY path that normally earns it", () => {
    // The unbriefed spawn is the one that takes the caret today ("the next thing the user does is
    // type"). A background sweep is not the user asking, so this is the path where the flag has to
    // bite — asserting it on the briefed path instead would have passed before the change.
    const { b } = seedHumanSelection();
    const before = useUiStore.getState().composeFocusSeq;
    spawnBuildAgentInProject(b, { background: true });
    expect(useUiStore.getState().composeFocusSeq).toBe(before);
  });

  it("leaves the Plan board and the Improve-Sparkle pane standing", () => {
    // `landInAgent` STEP 1 is `setActiveSpecial(null)` + `setWorkMode(side, "build")`, and it is the
    // most VISIBLE thing it does: it drops the Improve-Sparkle pane and kicks the human off the Plan
    // board. Restoring the selection afterwards would not undo that, so it needs its own assertion.
    const { b } = seedHumanSelection();
    seedBoardAndSparklePane();
    const bg = spawnBuildAgentInProject(b, { background: true })!;
    expect(bg).toBeTruthy();

    expect(useUiStore.getState().activeSpecial).toBe("sparkle");
    expect(useUiStore.getState().workModeBySide).toEqual({ left: "plan", right: "plan" });
  });

  it("refuses a TORN-OUT project outright, instead of reporting a spawn that can never launch", () => {
    // This window cannot mount a pane for a torn-out project at all — `Workspace`'s `live` memo
    // `continue`s on `tornOut` BEFORE the visited check — and the satellite that owns those panes
    // has its own module instances, so it never sees this window's open-set write or its brief.
    // Foreground is closed one level up (lifecycle.spawnBuildAgent's `project-torn-out`); a
    // background dispatcher has no such caller and no human to notice the silence.
    const { b } = seedHumanSelection();
    claimSatellite(b.id);
    expect(isTornOut(b.id)).toBe(true); // the seed actually took — not a no-op assertion below
    const agentsBefore = projectById(b.id).agents.length;
    const openBefore = [...useRuntimeStore.getState().openAgentIds];

    expect(spawnBuildAgentInProject(b, { background: true })).toBeNull();
    // NOTHING created, and nothing briefed: the whole point of refusing before `addAgent`.
    expect(projectById(b.id).agents).toHaveLength(agentsBefore);
    expect(useRuntimeStore.getState().openAgentIds).toEqual(openBefore);
  });

  it("is still refused at the machine agent ceiling, and creates nothing", () => {
    // A background dispatcher must never outrun the cap the human's own button respects.
    const p = project("Alpha", "/tmp/alpha");
    for (let i = 0; i < 3; i++) expect(spawnBuildAgentInProject(p)).toBeTruthy();
    expect(localAgentCapacity().atCapacity).toBe(true);
    const before = projectById(p.id).agents.length;
    const openBefore = [...useRuntimeStore.getState().openAgentIds];

    expect(spawnBuildAgentInProject(p, { background: true })).toBeNull();
    expect(projectById(p.id).agents).toHaveLength(before);
    expect(useRuntimeStore.getState().openAgentIds).toEqual(openBefore);
  });
});

describe("spawnBuildAgentInProject() — the FOREGROUND default is unchanged", () => {
  // THE REGRESSION GUARD. Without this, deleting the landing entirely — for every caller, not just
  // the background one — passes every assertion above. It is what makes the change a NARROWING.
  it("moves the selection and asks for the reveal, exactly as the '+ New Build Agent' button does", () => {
    const { a, b, agentId } = seedHumanSelection();
    const composeBefore = useUiStore.getState().composeFocusSeq;

    const fg = spawnBuildAgentInProject(b)!;
    expect(fg).toBeTruthy();

    // The user is now looking at B, in the agent they just asked for.
    expect(useProjectStore.getState().selectedProjectId).toBe(b.id);
    expect(projectById(b.id).selectedAgentId).toBe(fg);
    // …and the sidebar was asked to scroll that row on screen.
    expect(useUiStore.getState().revealAgentId).toBe(fg);
    // …and the empty spawn took the caret, because the next thing the user does is type.
    expect(useUiStore.getState().composeFocusSeq).toBe(composeBefore + 1);
    // A's selection is the thing that MOVED — the mirror image of the background case, which is what
    // makes "unchanged" over there a real observation rather than a property of a quiet store.
    expect(useProjectStore.getState().selectedProjectId).not.toBe(a.id);
    expect(projectById(a.id).selectedAgentId).toBe(agentId); // per-project, so A keeps its own row
    // The foreground path opens the pane too — the halves this change separates, still together.
    expect(useRuntimeStore.getState().openAgentIds).toContain(fg);
  });

  it("still clears the Improve-Sparkle pane and the board on the side that OWNS the project", () => {
    // The mirror of the background case above, and the guard against step 1 being deleted for every
    // caller: `landInAgent`'s first step exists because selecting an agent while the board or the
    // Sparkle pane is up changes NOTHING on screen — whichever is up owns the pane.
    const { b } = seedHumanSelection();
    seedBoardAndSparklePane();
    spawnBuildAgentInProject(b);

    expect(useUiStore.getState().activeSpecial).toBeNull();
    // Side-aware: B is unassigned, so `sideOf` reads "right". The LEFT column's board is not this
    // hand-off's to close, and asserting the whole map is what pins that half too.
    expect(useUiStore.getState().workModeBySide).toEqual({ left: "plan", right: "build" });
  });

  it("omitting the flag is the same as background: false — no call site has to opt out", () => {
    const { b } = seedHumanSelection();
    const fg = spawnBuildAgentInProject(b, { background: false, name: "Explicit" })!;
    expect(useProjectStore.getState().selectedProjectId).toBe(b.id);
    expect(projectById(b.id).selectedAgentId).toBe(fg);
    expect(useUiStore.getState().revealAgentId).toBe(fg);
  });
});
