// @vitest-environment jsdom
//
// THE IMPROVE SPARKLE ROW IS A BUILD ROW THAT HAPPENS TO BE PINNED.
//
// It had drifted into a special case: a larger disc, its own left inset, its own font size, a
// sweeping gradient progress bar along its bottom, a divider rule above it, a bordered teal consent
// pill — and, worst, its own status logic. That last one is why the rest of it matters: a row with a
// private derivation does not inherit fixes. It rendered GREEN while the Improvement Agent sat on an
// unanswered four-option picker, because the approval detection that turns build rows red ran
// through a pipeline this row was not on.
//
// So the assertions below are almost all COMPARATIVE. They render a real build row and the pinned
// row in the same sidebar and demand the two agree — on the box, the disc, the type, the badges and
// the status color. A one-sided change (a constant tweaked in AgentRow, a value hardcoded here)
// fails, which is the property a table of expected literals would not have.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_STATUS } from "@sparkle/ui";
import { C } from "../theme/colors";
import { asRgb, dotInk } from "./statusDotTestUtils";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./HistorySearch", () => ({
  HistorySearch: () => null,
  relativeTime: () => "",
  renderSnippet: () => null,
}));
vi.mock("../services/branchStatus", () => ({
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
}));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useInteractionStore } from "../stores/interactionStore";
import { useHelperPrefs } from "../helper/helperPrefs";
import { allBandsVisible } from "../engine/buildSections";
import { SPARKLE_AGENT_ID } from "../services/sparkleAgent";
import type { AgentTab, AgentTabStatus, Project } from "../types";

function mkAgent(id: string, name: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, ...over,
  };
}

/** One plain build agent ("Alpha") to compare the pinned row against, plus whatever `extra` agents
 *  a test needs. `namePinned` so auto-naming can't rewrite the label the lookups use. */
function seed(status: Record<string, AgentTabStatus> = {}, extra: AgentTab[] = []): Project {
  const agents = [mkAgent("a1", "Alpha"), ...extra];
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId: null,
    agents,
  };
  useProjectStore.setState({ projects: [project] } as never);
  useRuntimeStore.setState({
    branchStatus: {}, workflowStage: {}, status,
    openAgentIds: agents.map((a) => a.id),
    open: vi.fn(),
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return project;
}

const buildRow = () =>
  screen.getByText("Alpha").closest('[data-hint="agent"]') as HTMLElement;
const sparkleRow = () =>
  screen.getByText("Improve Sparkle").closest('[data-hint="improve"]') as HTMLElement;
/** The status disc. It is the first `span[title]` in either row — the leading slot's only child. */
const discIn = (row: HTMLElement) => row.querySelector<HTMLElement>("span[title]")!;
/** The disc's fixed-width slot — the disc is CENTERED in it, so the slot's width is what fixes the
 *  disc's left edge. Reached from the disc rather than by position: the build row wraps its strip in
 *  a visibility toggle (for the hover card), so the two rows' slots are at different depths. */
const discSlotIn = (row: HTMLElement) => discIn(row).parentElement as HTMLElement;

beforeEach(() => {
  useUiStore.setState({
    collapsedOrchestrators: {},
    activeSpecial: null,
    statusFilter: allBandsVisible(),
  } as never);
  useHelperPrefs.setState({ enabled: true } as never);
  useSettingsStore.setState({ sparkleImprovementConsent: "always" } as never);
  useInteractionStore.setState({ lastAt: {} } as never);
});
afterEach(cleanup);

// ── 1. What was REMOVED ────────────────────────────────────────────────────────────────────────
describe("Improve Sparkle row — the decorations are gone", () => {
  // The bar swept a cyan→blue gradient across the row's bottom edge whenever the agent worked. It
  // was the only permanently-animating thing in a column whose whole design is "quiet list", and it
  // reported nothing the green disc doesn't.
  it("renders no progress bar, working or otherwise", () => {
    render(<AgentSidebar project={seed({ [SPARKLE_AGENT_ID]: "working" })} />);
    expect(sparkleRow().querySelector(".sparkle-build")).toBeNull();
    // The bar was the row's only role="img"; the same query is how the build rows pin theirs away.
    expect(sparkleRow().querySelector('[role="img"]')).toBeNull();
  });

  it("renders no progress bar when the agent is idle either", () => {
    render(<AgentSidebar project={seed({ [SPARKLE_AGENT_ID]: "idle" })} />);
    expect(sparkleRow().querySelector('[role="img"]')).toBeNull();
  });

  // The divider was the only horizontal rule in the column. Position already says the row is
  // separate; the rule said it again in a vocabulary nothing else uses.
  it("draws no divider rule above itself", () => {
    render(<AgentSidebar project={seed()} />);
    expect(sparkleRow().style.borderTop).toBe("");
  });

  // The consent chip was a 10px letter-spaced capsule with a teal border — the only bordered chip
  // in the column. It is now the `+N` badge's twin: same ink, same size, no box.
  it("strips the border and the special-case type off the consent badge", () => {
    render(<AgentSidebar project={seed()} />);
    const badge = screen.getByText("Always");
    expect(badge.style.border).toBe("");
    expect(badge.style.borderRadius).toBe("");
    expect(badge.style.color).toBe(C.muted);
    expect(badge.style.fontSize).toBe("12px");
  });
});

// ── 2. The ANATOMY, measured against a real build row ──────────────────────────────────────────
describe("Improve Sparkle row — anatomy matches a build row", () => {
  it("gives its disc the same diameter", () => {
    render(<AgentSidebar project={seed()} />);
    const a = discIn(buildRow());
    const b = discIn(sparkleRow());
    expect(b.style.width).toBe(a.style.width);
    expect(b.style.height).toBe(a.style.height);
    // Guard: identical-but-empty would pass the two lines above.
    expect(b.style.width).toBe("12px");
  });

  // Left justification is three numbers stacked: the list's horizontal padding (which this row
  // supplies as a margin, since it is pinned OUTSIDE that container), the row's own padding, and
  // the centered disc slot. All three have to agree, so all three are asserted.
  it("lands its disc on the same vertical line as every build row's", () => {
    render(<AgentSidebar project={seed()} />);
    const list = screen.getByTestId("agent-list-scroll");
    expect(sparkleRow().style.marginLeft).toBe(list.style.paddingLeft);
    expect(sparkleRow().style.padding).toBe(buildRow().style.padding);
    expect(discSlotIn(sparkleRow()).style.width).toBe(discSlotIn(buildRow()).style.width);
    // …and the build row is not itself indented, so "same inset" really is "same line".
    expect(buildRow().style.marginLeft).toBe("0px");
  });

  it("sets its title at the same size and weight", () => {
    render(<AgentSidebar project={seed()} />);
    const title = screen.getByText("Improve Sparkle");
    const other = screen.getByText("Alpha");
    expect(title.style.fontSize).toBe(other.style.fontSize);
    expect(title.style.fontWeight).toBe(other.style.fontWeight);
  });

  // Color lives in the disc, on every row in the column. This row's title used to be status-inked,
  // which made it the one place the rule didn't hold.
  it("takes the neutral title ink, whatever its status", () => {
    render(<AgentSidebar project={seed({ [SPARKLE_AGENT_ID]: "approval", a1: "idle" })} />);
    expect(screen.getByText("Improve Sparkle").style.color).toBe(
      screen.getByText("Alpha").style.color,
    );
  });
});

// ── 2b. The SELECTED-STATE GEOMETRY, also measured against a real build row ────────────────────
//
// This is the one piece of the row's anatomy that stayed two hardcoded copies for a commit: the
// active radius was the literal "6px 0 0 6px" in both components and the fillet pair was
// copy-pasted verbatim, pinned only by a literal assertion against the sparkle row alone. Changing
// AgentRow's active geometry would then have left this row on the old shape with every test green —
// exactly the silent one-sided drift the rest of this work exists to remove (roborev 54812). Both
// now render from ACTIVE_ROW_RADIUS / <ActiveFillets />, and these compare the two rows directly.
//
// TWO RENDERS, not one: `isActive` is `!activeSpecial && selectedAgentId === a.id`, so a build row
// and the pinned row can never be selected simultaneously. Each is captured while it is the
// selected row, then compared.
describe("Improve Sparkle row — selected-state geometry matches a build row", () => {
  const filletPaint = (row: HTMLElement) =>
    Array.from(row.querySelectorAll<HTMLElement>('[aria-hidden][style*="radial-gradient"]')).map(
      (f) => f.style.background,
    );

  /** Render with the pinned row selected; return its box + fillets. */
  function whenSparkleSelected() {
    useUiStore.setState({ activeSpecial: "sparkle", statusFilter: allBandsVisible() } as never);
    render(<AgentSidebar project={seed()} />);
    const row = sparkleRow();
    const out = { radius: row.style.borderRadius, fillets: filletPaint(row) };
    cleanup();
    return out;
  }

  /** Render with the build row selected; return the same two things. */
  function whenBuildSelected() {
    useUiStore.setState({ activeSpecial: null, statusFilter: allBandsVisible() } as never);
    const project = { ...seed(), selectedAgentId: "a1" };
    useProjectStore.setState({ projects: [project] } as never);
    render(<AgentSidebar project={project} />);
    const row = buildRow();
    const out = { radius: row.style.borderRadius, fillets: filletPaint(row) };
    cleanup();
    return out;
  }

  it("squares the same corner, at the same radius", () => {
    const a = whenBuildSelected();
    const b = whenSparkleSelected();
    expect(b.radius).toBe(a.radius);
    // Guard: two empty strings would satisfy the line above.
    expect(b.radius).toContain("0");
  });

  it("draws the same two fillets, with the same paint", () => {
    const a = whenBuildSelected();
    const b = whenSparkleSelected();
    expect(a.fillets).toHaveLength(2);
    expect(b.fillets).toEqual(a.fillets);
    // Guard: the gradients must actually be there, not two empty backgrounds that trivially match.
    for (const paint of b.fillets) expect(paint).toContain("radial-gradient");
  });
});

// ── 3. The ELAPSED TIMER ───────────────────────────────────────────────────────────────────────
//
// SEMANTIC, verified against the build rows rather than assumed: it is time since the USER last
// INTERACTED with that agent (a composer Send or a terminal keystroke — stores/interactionStore),
// NOT time since spawn and NOT time since last viewed. It is `undefined` until the first
// interaction, so an always-on agent nobody has talked to shows no timer at all rather than an
// ever-growing number. That is why these tests seed interactionStore for BOTH rows identically.
describe("Improve Sparkle row — the elapsed timer", () => {
  // THE CLOCK IS FROZEN, and it has to be. `useRowClock` samples `Date.now()` again inside its
  // useState initializer during render, and `formatElapsed` floors to whole seconds — so a
  // `since = Date.now() - 13_000` computed before `render()` flips the expectation to "14s" the
  // moment ~1000ms of drift lands between the two calls. A full AgentSidebar render in jsdom plus
  // its state settles can cross that on a contended CI shard. Anchoring to a fixed base makes the
  // assertion exact instead of timing-dependent (roborev 54812).
  const NOW = new Date("2026-07-29T12:00:00Z").getTime();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows nothing before the user has interacted", () => {
    render(<AgentSidebar project={seed()} />);
    expect(sparkleRow().textContent).not.toMatch(/\d+s/);
  });

  it("counts from the user's last interaction, in the same slot and format as a build row", () => {
    const since = NOW - 13_000;
    useInteractionStore.setState({ lastAt: { [SPARKLE_AGENT_ID]: since, a1: since } } as never);
    render(<AgentSidebar project={seed()} />);

    expect(sparkleRow().textContent).toContain("13s");
    expect(buildRow().textContent).toContain("13s");
    // SAME SLOT: the timer leads the row, ahead of the title, in both.
    const idxOfTimer = (row: HTMLElement) => (row.textContent ?? "").indexOf("13s");
    const idxOfTitle = (row: HTMLElement, name: string) => (row.textContent ?? "").indexOf(name);
    expect(idxOfTimer(sparkleRow())).toBeLessThan(idxOfTitle(sparkleRow(), "Improve Sparkle"));
    expect(idxOfTimer(buildRow())).toBeLessThan(idxOfTitle(buildRow(), "Alpha"));
  });

  it("uses the same one-decimal minute format the build rows use", () => {
    const since = NOW - 5.7 * 60_000;
    useInteractionStore.setState({ lastAt: { [SPARKLE_AGENT_ID]: since, a1: since } } as never);
    render(<AgentSidebar project={seed()} />);
    expect(sparkleRow().textContent).toContain("5.7m");
    expect(buildRow().textContent).toContain("5.7m");
  });
});

// ── 4. The BADGES ──────────────────────────────────────────────────────────────────────────────
describe("Improve Sparkle row — the +N badge", () => {
  // The improvement pass runs a single agent today, so this is the shape rather than the current
  // reality — wired to the same `kind: "worker"` + `parentId` rule the build column uses, so a
  // future subtree gets the badge (and the rolled-up disc, below) with nothing else to remember.
  const withWorkers = (status: Record<string, AgentTabStatus> = {}) =>
    seed(status, [
      mkAgent("sw1", "Sparkle Worker 1", { kind: "worker", parentId: SPARKLE_AGENT_ID }),
      mkAgent("sw2", "Sparkle Worker 2", { kind: "worker", parentId: SPARKLE_AGENT_ID }),
    ]);

  it("shows +N when it has workers", () => {
    render(<AgentSidebar project={withWorkers()} />);
    expect(sparkleRow().textContent).toContain("+2");
  });

  it("shows no badge when it has none", () => {
    render(<AgentSidebar project={seed()} />);
    expect(sparkleRow().textContent).not.toContain("+");
  });

  it("styles it exactly like a collapsed orchestrator's badge", () => {
    const project = seed({}, [
      mkAgent("w1", "Alpha Worker", { kind: "worker", parentId: "a1" }),
      mkAgent("sw1", "Sparkle Worker", { kind: "worker", parentId: SPARKLE_AGENT_ID }),
    ]);
    render(<AgentSidebar project={project} />);
    const [onBuild, onSparkle] = screen.getAllByText("+1");
    expect(onSparkle!.style.color).toBe(onBuild!.style.color);
    expect(onSparkle!.style.fontSize).toBe(onBuild!.style.fontSize);
  });

  // "a row affordance, not a special-case pill": the consent word is the same class of fact as
  // "+2 workers" and sits in the same slot, so it takes the same treatment.
  it("gives the consent badge the +N badge's ink and size", () => {
    const project = seed({}, [
      mkAgent("w1", "Alpha Worker", { kind: "worker", parentId: "a1" }),
    ]);
    render(<AgentSidebar project={project} />);
    const plusN = screen.getByText("+1");
    const consent = screen.getByText("Always");
    expect(consent.style.color).toBe(plusN.style.color);
    expect(consent.style.fontSize).toBe(plusN.style.fontSize);
    expect(consent.style.lineHeight).toBe(plusN.style.lineHeight);
  });

  it("still reports the consent mode it is actually in", () => {
    useSettingsStore.setState({ sparkleImprovementConsent: "never" } as never);
    render(<AgentSidebar project={seed()} />);
    expect(sparkleRow().textContent).toContain("Off");
  });
});

// ── 5. POSITION ────────────────────────────────────────────────────────────────────────────────
describe("Improve Sparkle row — pinned at the very bottom", () => {
  it("sits outside the scrolling list, after it", () => {
    render(<AgentSidebar project={seed()} />);
    const list = screen.getByTestId("agent-list-scroll");
    expect(list.contains(sparkleRow())).toBe(false);
    // DOCUMENT_POSITION_FOLLOWING: the row comes after the list in tree order, i.e. below it.
    expect(list.compareDocumentPosition(sparkleRow()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("sits below the create rows", () => {
    render(<AgentSidebar project={seed()} />);
    const newAgent = screen.getByText("+ Local Agent");
    expect(
      newAgent.compareDocumentPosition(sparkleRow()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // It is not a treeitem in any stage group, and it has no header of its own — the two ways a row
  // could accidentally join the ladder.
  it("joins no stage group and takes no header", () => {
    render(<AgentSidebar project={seed()} />);
    expect(sparkleRow().closest('[role="tree"]')).toBeNull();
    expect(sparkleRow().closest('[role="group"]')).toBeNull();
  });

  // Pinned means pinned: no project, no list, still there.
  it("renders with no project open at all", () => {
    useProjectStore.setState({ projects: [] } as never);
    useRuntimeStore.setState({ status: {}, openAgentIds: [], branchStatus: {}, workflowStage: {} } as never);
    render(<AgentSidebar project={null} />);
    expect(sparkleRow()).toBeTruthy();
  });
});

// ── 6. STATUS — ONE PIPELINE ───────────────────────────────────────────────────────────────────
//
// The requirement that matters most, and the one the rest of the row's history argues for: not
// "similar colors" but the SAME derivation. Each case below paints a build agent and the pinned row
// with the identical status and demands an identical disc, so a change to the pipeline that lands
// on one and not the other is a failure rather than a drift nobody notices for a release.
describe("Improve Sparkle row — status comes from the build rows' pipeline", () => {
  const bothAt = (s: AgentTabStatus) => seed({ a1: s, [SPARKLE_AGENT_ID]: s });

  // THE LIVE CASE FROM THE BUG REPORT: the Improvement Agent sitting on a four-option picker
  // renders `approval`, and the row must be RED. It rendered green, because it derived its own
  // status. Sharing the pipeline is what makes the approval-detection fix reach this row too.
  it("turns RED when a picker is on screen (approval), like every build row", () => {
    render(<AgentSidebar project={bothAt("approval")} />);
    expect(dotInk(discIn(sparkleRow()))).toBe(asRgb(AGENT_STATUS.approval.color));
    expect(dotInk(discIn(sparkleRow()))).toBe(dotInk(discIn(buildRow())));
  });

  it("turns RED on the other needs-you statuses too", () => {
    for (const s of ["waiting", "blocked", "errored"] as const) {
      render(<AgentSidebar project={bothAt(s)} />);
      expect(dotInk(discIn(sparkleRow()))).toBe(dotInk(discIn(buildRow())));
      cleanup();
    }
  });

  it("is GREEN while running", () => {
    render(<AgentSidebar project={bothAt("working")} />);
    expect(dotInk(discIn(sparkleRow()))).toBe(asRgb(AGENT_STATUS.working.color));
    expect(dotInk(discIn(sparkleRow()))).toBe(dotInk(discIn(buildRow())));
  });

  it("is GRAY when paused", () => {
    render(<AgentSidebar project={bothAt("idle")} />);
    expect(dotInk(discIn(sparkleRow()))).toBe(asRgb(AGENT_STATUS.idle.color));
    expect(dotInk(discIn(sparkleRow()))).toBe(dotInk(discIn(buildRow())));
  });

  // Before it ever spawns there is no live status for the id; "stopped" is the same fallback a
  // build row takes, and it must not throw or render an undefined color.
  it("falls back to stopped before the agent has ever run", () => {
    render(<AgentSidebar project={seed()} />);
    expect(dotInk(discIn(sparkleRow()))).toBe(asRgb(AGENT_STATUS.stopped.color));
  });

  // Proof the ROLLUP is genuinely consulted, not just the row's own status: this is the same
  // engine/workerRollup path an orchestrator's disc takes, and a calm head with a red worker is
  // exactly the case a per-row derivation gets wrong.
  it("rolls up a red worker onto the pinned row, and says so on hover", () => {
    const project = seed({ [SPARKLE_AGENT_ID]: "idle", sw1: "waiting" }, [
      mkAgent("sw1", "Sparkle Worker", { kind: "worker", parentId: SPARKLE_AGENT_ID }),
    ]);
    render(<AgentSidebar project={project} />);
    expect(dotInk(discIn(sparkleRow()))).toBe(asRgb(AGENT_STATUS.waiting.color));
    expect(discIn(sparkleRow()).getAttribute("title")).toBe("Workers need you");
  });
});

// ── 7. THE FILTER CHIPS ────────────────────────────────────────────────────────────────────────
//
// A red row that the red chip cannot count is the same defect as a collapsed worker that doesn't
// count: the header tally is what people read INSTEAD of scanning, so a 0 there means "nothing
// wants you" and has to be true.
describe("Improve Sparkle row — its state reaches the filter chips", () => {
  const chipText = (band: string) =>
    screen.getByTestId(`status-chip-${band}`).textContent ?? "";

  it("increments the red chip when it needs you", () => {
    render(<AgentSidebar project={seed({ a1: "idle", [SPARKLE_AGENT_ID]: "approval" })} />);
    expect(chipText("needs_you")).toContain("1");
  });

  it("increments the green chip while it runs", () => {
    render(<AgentSidebar project={seed({ a1: "idle", [SPARKLE_AGENT_ID]: "working" })} />);
    expect(chipText("running")).toContain("1");
    expect(chipText("needs_you")).toContain("0");
  });

  it("counts under Done when it is calm — alongside the project's own calm rows", () => {
    render(<AgentSidebar project={seed({ a1: "idle", [SPARKLE_AGENT_ID]: "idle" })} />);
    expect(chipText("done")).toContain("2");
  });

  // It is COUNTED but never HIDDEN. Every other row a chip hides comes back when the chip does;
  // this row is the only way into the improvement agent and is pinned precisely so it is always
  // reachable, so the filter must not be able to remove it.
  it("stays on screen even when its own band is filtered out", () => {
    useUiStore.setState({
      collapsedOrchestrators: {},
      activeSpecial: null,
      statusFilter: { needs_you: true, questions: true, running: false, done: false },
    } as never);
    render(<AgentSidebar project={seed({ a1: "idle", [SPARKLE_AGENT_ID]: "idle" })} />);
    expect(screen.queryByText("Alpha")).toBeNull(); // the project row IS filtered away…
    expect(sparkleRow()).toBeTruthy(); // …and the pinned row is not
  });

  // The counts feed the empty-state logic too. Folding the pinned row into that number would make
  // a project with no agents claim its rows were "hidden by the status filter".
  it("does not make an agent-less project report a phantom filter", () => {
    const project: Project = {
      id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
      createdAt: new Date(0).toISOString(), selectedAgentId: null, agents: [],
    };
    useProjectStore.setState({ projects: [project] } as never);
    useRuntimeStore.setState({
      branchStatus: {}, workflowStage: {}, status: { [SPARKLE_AGENT_ID]: "idle" },
      openAgentIds: [], open: vi.fn(), pollBranchStatus: vi.fn(() => Promise.resolve()),
    } as never);
    render(<AgentSidebar project={project} />);
    expect(screen.queryByText(/hidden by the status filter/i)).toBeNull();
    expect(screen.getByText(/No Build agents yet/i)).toBeTruthy();
  });
});
