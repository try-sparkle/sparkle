// @vitest-environment jsdom
//
// THE THREE GRAYS MUST NOT LOOK ALIKE.
//
// Idle-and-done, idle-and-stalled and thrashing all rendered the same gray row, and that identity
// IS the bug this suite guards: a 153-minute stall was indistinguishable, on screen, from an agent
// that had shipped its PR. The verdicts are decided by engine/agentStall, engine/agentThrash and
// engine/agentGoal — all separately tested. What is asserted HERE is the RENDERED OUTPUT: that a
// stalled row shows an affordance naming what is outstanding, that a finished row shows none, that
// a thrashing row shows its own verdict, and — the one most easily lost — that an `unknown` row
// shows NOTHING at all.
//
// Every assertion is on the row's DOM, not on an input to it. Asserting that the store holds an
// open PR would pass against the code as it was before this change and prove nothing; asserting
// that the text "PR unmerged" appears inside that agent's row would not.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_STATUS, C, DANGER } from "../theme/colors";
import { alertControlKind } from "../engine/alertDismissal";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
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
import { useHelperPrefs } from "../helper/helperPrefs";
import { allBandsVisible } from "../engine/buildSections";
import { noteThrashEvent, resetThrashTracking } from "../engine/agentThrash";
import { escalateGoal, newGoal } from "../engine/agentGoal";
import type { AgentGoal } from "../engine/agentGoal";
import type { AgentTab, AgentTabStatus, Project } from "../types";
import type { BranchStatus, WorkflowState } from "../services/branchStatus";

const CLEAN_BS: BranchStatus = {
  ahead: 0,
  behind: 0,
  dirty: false,
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
  worktreeOnBranch: true,
};

const BARE_WS: WorkflowState = {
  inLocalMain: false,
  inOriginMain: false,
  inParent: false,
  aheadOfBase: 0,
  prState: null,
  prNumber: null,
  prUrl: null,
};

/** Committed-and-pushed with an open PR nobody merged — the canonical stall, and the single most
 *  common gray row on a real fleet. */
const OPEN_PR_WS: WorkflowState = { ...BARE_WS, prState: "open", prNumber: 7, pushed: true };
/** Probed, merged, nothing left — the only shape that licenses "genuinely done". */
const MERGED_WS: WorkflowState = { ...BARE_WS, prState: "merged", inOriginMain: true };

function mkAgent(id: string, name: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id,
    name,
    kind: "build",
    parentId: null,
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "",
    promptHistory: [],
    // Pinned so auto-naming can never rewrite the label the assertions look rows up by.
    namePinned: true,
    autoNameBasis: null,
    autoNameVariants: null,
    shellCommand: null,
    ...over,
  };
}

interface Seed {
  status?: Record<string, AgentTabStatus>;
  branchStatus?: Record<string, BranchStatus>;
  workflowState?: Record<string, WorkflowState>;
  goals?: Record<string, AgentGoal>;
}

/** One agent per row-shape under test, so a single render exercises all of them side by side —
 *  which is the actual claim: these rows must not look alike. */
function seed({ status = {}, branchStatus = {}, workflowState = {}, goals = {} }: Seed): Project {
  const names: Array<[string, string]> = [
    ["stalled", "Stalled One"],
    ["finished", "Finished One"],
    ["unknown", "Unknown One"],
    ["busy", "Busy One"],
  ];
  const project: Project = {
    id: "p1",
    name: "Demo",
    rootPath: "/tmp/demo",
    defaultBranch: "main",
    createdAt: new Date(0).toISOString(),
    selectedAgentId: null,
    agents: names.map(([id, name]) =>
      goals[id] ? mkAgent(id, name, { goal: goals[id] }) : mkAgent(id, name),
    ),
  };
  useProjectStore.setState({ projects: [project] } as never);
  useRuntimeStore.setState({
    status,
    branchStatus,
    workflowState,
    workflowStage: {},
    workflowShipped: {},
    openAgentIds: names.map(([id]) => id),
    open: vi.fn(),
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return project;
}

const rowFor = (name: string) =>
  screen.getByText(name).closest('[data-hint="agent"]') as HTMLElement;

beforeEach(() => {
  useUiStore.setState({
    collapsedOrchestrators: {},
    activeSpecial: null,
    statusFilter: allBandsVisible(),
  } as never);
  useHelperPrefs.setState({ enabled: true } as never);
  // The thrash registry is module-local and survives between tests; a leaked accumulator would let
  // one test's compaction spiral paint another test's row.
  resetThrashTracking();
});
afterEach(() => {
  cleanup();
  resetThrashTracking();
});

describe("a STALLED row says what is outstanding", () => {
  it("names the cause on the row and carries the full sentence as its tooltip", () => {
    render(
      <AgentSidebar
        project={seed({
          status: { stalled: "idle" },
          branchStatus: { stalled: { ...CLEAN_BS, ahead: 3 } },
          workflowState: { stalled: OPEN_PR_WS },
        })}
      />,
    );
    const chip = within(rowFor("Stalled One")).getByTestId("row-stall");
    // The VISIBLE reading is the outstanding work — "stalled" alone would send the reader off to
    // investigate, and the investigation is the expensive part.
    expect(chip.textContent).toContain("PR unmerged");
    // ONE clause, no "+N" tail: an open PR and unlanded commits are the same fact, and agentStall
    // folds the second into the first rather than saying it twice (roborev 55298/55379). This test
    // asserted "+1" while that duplicate was still being reported.
    expect(chip.textContent).not.toContain("+");
    // The word itself survives in the accessible name.
    expect(chip.getAttribute("aria-label")).toBe("Stalled — PR unmerged");
    // And the engine's own sentence is the tooltip, naming every cause and refusing to promise a
    // resume would fix it.
    expect(chip.getAttribute("title")).toContain("it has an open PR that nobody merged");
    expect(chip.getAttribute("title")).toContain("Nothing is coming to finish this on its own");
  });

  it("shows uncommitted work as its own named cause", () => {
    render(
      <AgentSidebar
        project={seed({
          status: { stalled: "idle" },
          branchStatus: { stalled: { ...CLEAN_BS, dirty: true } },
          workflowState: { stalled: MERGED_WS },
        })}
      />,
    );
    const chip = within(rowFor("Stalled One")).getByTestId("row-stall");
    expect(chip.textContent).toContain("uncommitted changes");
    // Exactly one cause → no "+N" tail to mislead the reader into hovering for more.
    expect(chip.textContent).not.toContain("+");
  });

  it("takes the CAUTION ink, never a second red alarm", () => {
    render(
      <AgentSidebar
        project={seed({
          status: { stalled: "idle" },
          branchStatus: { stalled: { ...CLEAN_BS, dirty: true } },
          workflowState: { stalled: MERGED_WS },
        })}
      />,
    );
    expect(within(rowFor("Stalled One")).getByTestId("row-stall").style.color).toBe(C.amberInk);
  });
});

describe("GRAY IS A TERMINAL STATE — the founder's rule, end to end through the real sidebar", () => {
  // "a worker should basically never be gray and local uncommitted. It should always be either
  // working or blocked. So gray really should kind of only ever exist at the bottom, when things
  // have been shipped to production." Plus: stuck should be RED, not gray.
  //
  // The engine decides this in engine/stallEscalation (unit-tested there). What is asserted HERE is
  // that the composition in `effectiveStatus` actually reaches the rendered row — every finding on
  // that module was invisible precisely because nothing composed it.
  function renderStalled() {
    render(
      <AgentSidebar
        project={seed({
          status: { stalled: "idle" },
          branchStatus: { stalled: { ...CLEAN_BS, dirty: true } },
          workflowState: { stalled: MERGED_WS },
          goals: { stalled: newGoal("land the never-idle work", Date.now()) },
        })}
      />,
    );
    return rowFor("Stalled One");
  }

  it("a row with an unmet goal and a dirty tree does NOT render gray", () => {
    const row = renderStalled();
    // Asserted on the DISC, which is the one thing on the row that carries status — the column's
    // rule is that status never inks the row's TEXT, so reading the name's colour would prove
    // nothing. Its tooltip is the status label and its background is the tier colour, so one lookup
    // checks both halves of the claim.
    // The dot's tooltip IS the status label, so finding it by the `blocked` label is the assertion:
    // a gray row would carry "Done — your turn" here and this lookup would throw. Compared against
    // the finished row's dot rather than a hex literal, because jsdom normalises colours to rgb().
    expect(within(row).getByTitle(AGENT_STATUS.blocked.label)).toBeTruthy();
  });

  it("still says WHAT is outstanding once it has gone red", () => {
    // THE INTEGRATION TRAP. The row derives its stall report from its own status, and `stallReport`
    // answers `active` for the whole red tier — so composing the escalation naively deleted the chip
    // at exactly the moment the row turned red: colour with no cause. `calmSt` exists for this.
    const chip = within(renderStalled()).getByTestId("row-stall");
    expect(chip.textContent).toContain("goal unmet");
  });

  it("the whole ACKNOWLEDGE cycle works through the real sidebar", () => {
    // The property that separates this from the undismissable red `unmerged` that had to be rolled
    // back on 2026-07-26 — asserted end to end rather than as a claim about the string "blocked",
    // which is what an earlier version of this test did and which was true before the module existed
    // (roborev 55423/55434).
    // A row whose CALM BAND IS `unmerged` — committed work, nothing landed. That distinction is the
    // whole point: `withDismissedAlerts` already maps a dismissed `blocked` to `idle` on its own, so a
    // fixture whose band is `idle` cannot tell the undo pass working from the undo pass missing. (It
    // could not: this test passed against a mutation that deleted the pass entirely until the fixture
    // changed.) With the pass, the row comes back "Needs merge"; without it, `idle` — losing the label,
    // the ordering band, and the evidence that the branch exists.
    render(
      <AgentSidebar
        project={seed({
          status: { stalled: "idle" },
          branchStatus: { stalled: { ...CLEAN_BS, ahead: 3 } },
          workflowState: { stalled: BARE_WS },
          goals: { stalled: newGoal("land the never-idle work", Date.now()) },
        })}
      />,
    );
    const id = "stalled";
    const project = () => useProjectStore.getState().projects[0]!;
    const alertOf = () => project().agents.find((a) => a.id === id)?.alert;

    // 1. The episode recorder ran over the ESCALATED map, so the row's record is a `blocked` episode
    //    and the row therefore OFFERS a Dismiss control. Fed the raw map it would have seen `idle`,
    //    recorded nothing, and `alertControlKind` would return null — a red nobody can calm.
    expect(alertOf()?.lastRed).toBe("blocked");
    expect(alertControlKind(alertOf(), "blocked")).toBe("dismiss");

    // 2. Acknowledge it the way the row's control does, and re-render.
    useProjectStore.getState().dismissAlert(project().id, id, "blocked");
    cleanup();
    render(<AgentSidebar project={project()} />);

    // 3. The row is calm again — and back in ITS OWN band, not collapsed to `idle`, so it keeps
    //    "Needs merge". ACKNOWLEDGING IS NOT RESOLVING: the chip naming the outstanding work is still
    //    there, so the row still does not read as finished.
    const after = rowFor("Stalled One");
    expect(within(after).queryByTitle(AGENT_STATUS.blocked.label)).toBeNull();
    expect(within(after).getByTitle(AGENT_STATUS.unmerged.label)).toBeTruthy();
    expect(within(after).getByTestId("row-stall")).toBeTruthy();
    // 4. …and Re-enable is offered, so the dismissal is undoable from the UI.
    expect(alertControlKind(alertOf(), "blocked")).toBe("reenable");
  });

  it("leaves a genuinely finished row gray — gray still means something", () => {
    // The control that stops the three above from passing for the wrong reason. If everything went
    // red, the colour would carry no information — the 27-of-51 failure the de-redding was about.
    render(
      <AgentSidebar
        project={seed({
          status: { finished: "idle" },
          branchStatus: { finished: CLEAN_BS },
          workflowState: { finished: MERGED_WS },
        })}
      />,
    );
    // Nothing escalated it: no red-tier label anywhere in the row. Asserted as an absence because
    // the dot's own label can be overridden by the worker-rollup, which is a different question.
    expect(within(rowFor("Finished One")).queryByTitle(AGENT_STATUS.blocked.label)).toBeNull();
  });
});

describe("a FINISHED row shows no stall affordance", () => {
  it("renders no chip for an agent with a clean tree and a merged PR", () => {
    render(
      <AgentSidebar
        project={seed({
          status: { finished: "idle" },
          branchStatus: { finished: CLEAN_BS },
          workflowState: { finished: MERGED_WS },
        })}
      />,
    );
    expect(within(rowFor("Finished One")).queryByTestId("row-stall")).toBeNull();
  });
});

describe("an UNKNOWN row raises nothing — a stall we never looked for is not a stall", () => {
  it("renders no chip when the agent's git state was never polled", () => {
    // No branchStatus, no workflowState: every input is `undefined`, so the verdict is `unknown`.
    // Painting this row would be an alarm built on missing data, which is what trains a human to
    // stop trusting the signal.
    render(<AgentSidebar project={seed({ status: { unknown: "idle" } })} />);
    expect(within(rowFor("Unknown One")).queryByTestId("row-stall")).toBeNull();
  });

  it("still renders no chip when only SOME evidence is in and none of it is a cause", () => {
    render(
      <AgentSidebar
        project={seed({
          status: { unknown: "idle" },
          // Polled and clean — but the PR was never probed (prState null is ambiguous), so we
          // cannot claim `finished` OR `stalled`.
          branchStatus: { unknown: CLEAN_BS },
        })}
      />,
    );
    expect(within(rowFor("Unknown One")).queryByTestId("row-stall")).toBeNull();
  });
});

describe("the RED tier gets no second alarm", () => {
  it("leaves a waiting row's dirty tree unbadged — it is already loud", () => {
    render(
      <AgentSidebar
        project={seed({
          status: { busy: "waiting" },
          branchStatus: { busy: { ...CLEAN_BS, dirty: true, ahead: 2 } },
          workflowState: { busy: OPEN_PR_WS },
        })}
      />,
    );
    expect(within(rowFor("Busy One")).queryByTestId("row-stall")).toBeNull();
  });

  it("a DISMISSED waiting row gets no stall chip either", () => {
    // roborev 55335. The row's chip used to be derived from `effectiveStatus`, which is the
    // DISMISSAL-ADJUSTED map: `withDismissedAlerts` rewrites a suppressed `waiting` to `idle`,
    // `isQuiet` then accepts it, and the row the human had just silenced grew a fresh amber
    // "Stalled — …" chip with the Re-enable button beside it. The sentence was false as well: an
    // agent sitting at a prompt is alive and proceeds the moment the human answers, but the detail
    // read "Nothing is coming to finish this on its own." The chip now reads `calmSt` — the
    // pre-dismissal, pre-escalation status — so the true taxonomy decides, which is what
    // agentStall's own exclusion note reasons about.
    const project = seed({
      status: { busy: "waiting" },
      branchStatus: { busy: { ...CLEAN_BS, dirty: true, ahead: 2 } },
      workflowState: { busy: OPEN_PR_WS },
    });
    // Dismiss the alarm the way the row's own control does: record the episode, then acknowledge it.
    const store = useProjectStore.getState();
    store.advanceAlerts(project.id, { busy: "waiting" });
    store.dismissAlert(project.id, "busy", "waiting");
    render(<AgentSidebar project={useProjectStore.getState().projects[0]!} />);

    // ASSERT THE DISMISSAL LANDED FIRST (roborev 55456). The load-bearing part of this test is the
    // setup, and it was unasserted: if `dismissAlert` became a no-op — an id/seq/signature change, a
    // `dismissedRecord` tweak — the row would simply stay red `waiting`, which ALSO renders no
    // `row-stall` chip (the red tier gets no second alarm), and the absence below would still hold.
    // At that point this test is byte-equivalent to its neighbour above and guards `calmSt` not at all.
    const row = rowFor("Busy One");
    const alertOf = () =>
      useProjectStore.getState().projects[0]!.agents.find((a) => a.id === "busy")?.alert;
    expect(within(row).queryByTitle(AGENT_STATUS.waiting.label)).toBeNull();
    expect(alertControlKind(alertOf(), "waiting")).toBe("reenable");

    // …and only now is the absence meaningful: the row is calm, so `isQuiet` accepts it, and the chip
    // is suppressed by `calmSt` reading the PRE-dismissal `waiting` rather than the rewritten `idle`.
    expect(within(row).queryByTestId("row-stall")).toBeNull();
  });
});

describe("a THRASHING row shows its own verdict", () => {
  it("reports CONTEXT PRESSURE — the cause — on an agent that reads as working", () => {
    const project = seed({ status: { busy: "working" } });
    // Timestamps must be RELATIVE TO NOW: the row samples the registry against its own live clock,
    // and `COMPACT_WINDOW_MS` measures a RATE, so epoch-zero-ish stamps age out before they are
    // read and the row would (correctly) report nothing.
    const t = Date.now();
    // Two compactions inside the window: the first did not buy it room. This is the signal the
    // brief asks to surface BEFORE it degenerates into a /compact loop.
    noteThrashEvent("busy", { event: "PreCompact", ts: t - 60_000 });
    noteThrashEvent("busy", { event: "PreCompact", ts: t - 5_000 });
    render(<AgentSidebar project={project} />);
    const chip = within(rowFor("Busy One")).getByTestId("row-thrash");
    expect(chip.textContent).toContain("Context exhausted");
    expect(chip.getAttribute("title")).toContain("running out of usable context");
  });

  it("reports a repeated command as LOOPING", () => {
    const project = seed({ status: { busy: "working" } });
    // Three identical submissions with no tool call between them — the observed /compact spiral.
    for (let i = 0; i < 3; i++) {
      noteThrashEvent("busy", { event: "UserPromptSubmit", prompt: "/compact", ts: 1_000 + i });
      noteThrashEvent("busy", { event: "Stop", ts: 1_100 + i });
    }
    render(<AgentSidebar project={project} />);
    const chip = within(rowFor("Busy One")).getByTestId("row-thrash");
    expect(chip.textContent).toContain("Looping");
    expect(chip.getAttribute("title")).toContain("It is looping, not working");
  });

  it("shows nothing for an agent this window has never seen a hook event for", () => {
    // `thrashReportFor` returns undefined there, and undefined must NOT render as healthy OR as an
    // alarm — it means "not observed".
    render(<AgentSidebar project={seed({ status: { busy: "working" } })} />);
    expect(within(rowFor("Busy One")).queryByTestId("row-thrash")).toBeNull();
  });

  it("shows nothing for an agent whose turns are running tools", () => {
    const project = seed({ status: { busy: "working" } });
    noteThrashEvent("busy", { event: "UserPromptSubmit", prompt: "keep going", ts: 1_000 });
    noteThrashEvent("busy", { event: "PreToolUse", tool: "Edit", ts: 1_010 });
    noteThrashEvent("busy", { event: "Stop", ts: 1_020 });
    render(<AgentSidebar project={project} />);
    expect(within(rowFor("Busy One")).queryByTestId("row-thrash")).toBeNull();
  });
});

describe("the GOAL is visible, and an ESCALATED one is unmistakable", () => {
  const NOW = Date.now();

  it("puts an escalated goal on the row in the danger ink, even while the agent is working", () => {
    // The stall surface stays quiet for a `working` agent (verdict `active`), so without this the
    // single most important fact about the row would be invisible until it went idle.
    render(
      <AgentSidebar
        project={seed({
          status: { busy: "working" },
          goals: {
            busy: escalateGoal(newGoal("land PR #42", NOW), NOW, "20 continues, no progress"),
          },
        })}
      />,
    );
    const chip = within(rowFor("Busy One")).getByTestId("row-goal-escalated");
    expect(chip.textContent).toContain("Goal escalated");
    expect(chip.style.color).toBe(DANGER);
    expect(chip.getAttribute("title")).toContain("land PR #42");
    expect(chip.getAttribute("title")).toContain("auto-continue gave up — 20 continues, no progress");
  });

  it("leaves a healthy ACTIVE goal off the column — it is not an alarm", () => {
    render(
      <AgentSidebar
        project={seed({ status: { busy: "working" }, goals: { busy: newGoal("ship it", NOW) } })}
      />,
    );
    expect(within(rowFor("Busy One")).queryByTestId("row-goal-escalated")).toBeNull();
  });

  it("reports an escalated goal as a STALL CAUSE once the agent goes quiet", () => {
    render(
      <AgentSidebar
        project={seed({
          status: { stalled: "idle" },
          branchStatus: { stalled: CLEAN_BS },
          workflowState: { stalled: MERGED_WS },
          goals: {
            stalled: escalateGoal(newGoal("land PR #42", NOW), NOW, "the build never went green"),
          },
        })}
      />,
    );
    const chip = within(rowFor("Stalled One")).getByTestId("row-stall");
    expect(chip.textContent).toContain("auto-continue gave up");
    // Escalation is categorically different from "needs merging eventually": nothing is coming for
    // this row at all, so it takes DANGER rather than the caution ink every other cause gets.
    expect(chip.style.color).toBe(DANGER);
  });
});
