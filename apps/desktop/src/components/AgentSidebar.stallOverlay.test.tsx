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
import { DEFAULT_GOAL_TTL_MS, escalateGoal, markGoalMet, newGoal } from "../engine/agentGoal";
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
    const row = rowFor("Stalled One");
    const mark = within(row).getByTestId("row-notice-glyph");
    // ══ THE WORDS MOVED, THE FACT DID NOT (bead sparkle-tyter) ═══════════════════════════════
    // This used to assert `chip.textContent` contained "PR unmerged" — i.e. that the row rendered
    // the phrase. That is exactly the shape that broke the column: a nowrap, non-shrinking text
    // chip beside a name written to give up all its width first, which flexbox resolved by
    // shrinking the NAME to zero. The row now carries a wordless mark and the phrase lives on its
    // hover, so the assertion follows the words rather than being deleted with them.
    expect(mark.getAttribute("title")).toContain("PR unmerged");
    // ONE clause, no "+N" tail: an open PR and unlanded commits are the same fact, and agentStall
    // folds the second into the first rather than saying it twice (roborev 55298/55379).
    expect(mark.getAttribute("title")).not.toContain("+");
    // The count says how many, so a single cause must not wear one.
    expect(mark.getAttribute("data-notice-count")).toBe("1");
    // The word "stalled" no longer appears anywhere — the mark's accessible name is the class and
    // its members, which is what a reader who cannot see the glyph needs.
    expect(mark.getAttribute("aria-label")).toBe("1 warning: PR unmerged");
    // AND THE NEW INVARIANT, which is the whole contract: nothing on this row renders the phrase
    // as visible text. The old assertion above would now pass on a row that still had the bug if
    // it only checked the tooltip, so this is the half that pins the fix.
    expect(row.textContent).not.toContain("PR unmerged");
    // The engine's full sentence still rides along — on the CARD's chip, which has room for it.
    // (The collapsed mark's title is the label list; `row-stall` is card-only now.)
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
    const row = rowFor("Stalled One");
    const mark = within(row).getByTestId("row-notice-glyph");
    // The cause is named on the HOVER now, not in the row's text — see the note above.
    expect(mark.getAttribute("title")).toContain("uncommitted changes");
    expect(mark.getAttribute("data-notice-count")).toBe("1");
    expect(row.textContent).not.toContain("uncommitted changes");
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
    // Amber, not danger — the row's dot is the alarm channel and a stall must not open a second
    // one. The ink moved to the mark with the words.
    expect(
      within(rowFor("Stalled One")).getByTestId("row-notice-glyph").style.color,
    ).toBe(C.amberInk);
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
    // The trap this guards is unchanged — the row must still SAY what is outstanding after it turns
    // red — but the goal cause moved off the notice mark (roborev 59322): the goal chip already
    // draws that fact and is clickable, so marking it twice put two identical glyphs on one row.
    // Both halves asserted here, because "the cause is named somewhere" is the actual property.
    const row = within(renderStalled());
    const goal = row.getByTestId("row-goal");
    expect(goal.getAttribute("data-goal-state")).toBe("unmet");
    expect(goal.getAttribute("aria-label")).toContain("Goal");
    // …and the OTHER outstanding cause (the dirty tree) still gets its own mark, so a red row is
    // never left with colour and no cause.
    const mark = row.getByTestId("row-notice-glyph");
    expect(mark.getAttribute("title")).toContain("uncommitted changes");
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
    expect(within(after).getByTestId("row-notice-glyph")).toBeTruthy();
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
    expect(within(rowFor("Finished One")).queryByTestId("row-notice-glyph")).toBeNull();
  });
});

describe("an UNKNOWN row raises nothing — a stall we never looked for is not a stall", () => {
  it("renders no chip when the agent's git state was never polled", () => {
    // No branchStatus, no workflowState: every input is `undefined`, so the verdict is `unknown`.
    // Painting this row would be an alarm built on missing data, which is what trains a human to
    // stop trusting the signal.
    render(<AgentSidebar project={seed({ status: { unknown: "idle" } })} />);
    expect(within(rowFor("Unknown One")).queryByTestId("row-notice-glyph")).toBeNull();
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
    expect(within(rowFor("Unknown One")).queryByTestId("row-notice-glyph")).toBeNull();
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
    expect(within(rowFor("Busy One")).queryByTestId("row-notice-glyph")).toBeNull();
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
    expect(within(row).queryByTestId("row-notice-glyph")).toBeNull();
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
    // The verdict is named on the mark's HOVER now, never as row text (bead sparkle-tyter).
    const row = rowFor("Busy One");
    const mark = within(row).getByTestId("row-notice-glyph");
    expect(mark.getAttribute("title")).toContain("Context exhausted");
    expect(row.textContent).not.toContain("Context exhausted");
  });

  it("reports a repeated command as LOOPING", () => {
    const project = seed({ status: { busy: "working" } });
    // Three identical submissions with no tool call between them — the observed /compact spiral.
    for (let i = 0; i < 3; i++) {
      noteThrashEvent("busy", { event: "UserPromptSubmit", prompt: "/compact", ts: 1_000 + i });
      noteThrashEvent("busy", { event: "Stop", ts: 1_100 + i });
    }
    render(<AgentSidebar project={project} />);
    // "Looping" was one of the four words the founder photographed colliding with the agent name
    // ("Looping Shipped"). It must not be row text under any circumstances now.
    const row = rowFor("Busy One");
    const mark = within(row).getByTestId("row-notice-glyph");
    expect(mark.getAttribute("title")).toContain("Looping");
    expect(row.textContent).not.toContain("Looping");
  });

  it("shows nothing for an agent this window has never seen a hook event for", () => {
    // `thrashReportFor` returns undefined there, and undefined must NOT render as healthy OR as an
    // alarm — it means "not observed".
    render(<AgentSidebar project={seed({ status: { busy: "working" } })} />);
    expect(within(rowFor("Busy One")).queryByTestId("row-notice-glyph")).toBeNull();
  });

  it("shows nothing for an agent whose turns are running tools", () => {
    const project = seed({ status: { busy: "working" } });
    noteThrashEvent("busy", { event: "UserPromptSubmit", prompt: "keep going", ts: 1_000 });
    noteThrashEvent("busy", { event: "PreToolUse", tool: "Edit", ts: 1_010 });
    noteThrashEvent("busy", { event: "Stop", ts: 1_020 });
    render(<AgentSidebar project={project} />);
    expect(within(rowFor("Busy One")).queryByTestId("row-notice-glyph")).toBeNull();
  });
});

// EVERY GOAL STATE IS ON THE ROW — bead sparkle-6kz9q.
//
// This suite used to assert the OPPOSITE of the first four tests below: that a healthy active goal
// was deliberately kept OFF the column. That rule made a goal-bearing row pixel-identical to a
// goal-less one, so a founder looking at 41 agents that all carried goals saw no evidence of a
// single one and concluded the goals were not real. The column was the bug, not the data.
//
// What is asserted here is the RENDERED row, never the store: that a `row-goal` element EXISTS for
// each of the four states (false for three of them before this change — that is the whole point),
// that it carries the state machine-readably rather than only as a colour, and that the state is
// spoken in words for a reader who does not get the colour.
describe("EVERY goal state is visible on the row, and an ESCALATED one is still the loudest", () => {
  const NOW = Date.now();
  /** 3h20m plus MOST of a minute. `formatRemaining` FLOORS to the minute, so a goal set at `t` with
   *  this TTL reads "3h 20m left" for any render in `[t, t + 55s]` — after that it ticks down to
   *  "3h 19m" and an exact-string assertion would flake.
   *
   *  55s is the whole budget, and it is spent from the moment the goal is CREATED — so the clock for
   *  a test asserting the minute reading must be sampled inside that test, immediately before the
   *  render, NOT in this describe body. The body runs at COLLECTION time, before all 23 tests in the
   *  file, six describes of which each render a full sidebar into jsdom; on a loaded parallel run
   *  that gap alone can exceed the window, and the test would go red for a reason that has nothing
   *  to do with the code under test. */
  const TTL_3H20M = 3 * 60 * 60_000 + 20 * 60_000 + 55_000;

  it("marks a healthy ACTIVE goal on the row — icon only, state named for a screen reader", () => {
    // THE COMMON CASE, and the one that was invisible. No visible words: the row is tight and 41
    // rows each carrying "active · 3h 20m left" would undo the strip-down the column exists for.
    const now = Date.now(); // see TTL_3H20M — sampled HERE, not in the describe body.
    render(
      <AgentSidebar
        project={seed({
          status: { busy: "working" },
          goals: { busy: newGoal("ship it", now, TTL_3H20M) },
        })}
      />,
    );
    const chip = within(rowFor("Busy One")).getByTestId("row-goal");
    expect(chip.getAttribute("data-goal-state")).toBe("unmet");
    // Colour is not a channel every reader has, so the state is NAMED — and the chip has no visible
    // text at all here, so without this a screen reader would reach an empty span. Asserted through
    // the ACCESSIBLE NAME, not just the attribute: an `aria-label` on an element with no role is
    // not reliably announced, so this is what proves the label is actually exposed.
    //
    // `button`, NOT `img` as this read before (bead sparkle-tyter). The founder's second scope
    // addition made the goal chip CLICKABLE — *"when I click on the blue target it doesn't do
    // anything"* — and an operable control announced as an image is one a screen-reader user cannot
    // find. The property this row actually guards is unchanged and still checked: the mark carries
    // its state in its accessible name rather than in visible text.
    expect(
      within(rowFor("Busy One")).getByRole("button", { name: "Goal active, 3h 20m left — ship it" }),
    ).toBe(chip);
    expect(chip.getAttribute("aria-label")).toBe("Goal active, 3h 20m left — ship it");
    expect(chip.style.color).toBe(C.accentInk);
    // The words themselves stay one hover away rather than on the row.
    expect(chip.textContent).not.toContain("Goal");
    // The goal sentence is still exactly what it was; the title now ALSO says the chip is
    // clickable (bead sparkle-tyter). That suffix is not decoration — the founder's complaint was
    // that he clicked this mark and got silence, so the affordance has to be discoverable from the
    // one surface that was already carrying its words.
    expect(chip.getAttribute("title")).toContain("Goal: ship it — active · 3h 20m left");
    expect(chip.getAttribute("title")).toContain("click");
  });

  it("marks a MET goal on the row in the success ink", () => {
    render(
      <AgentSidebar
        project={seed({
          status: { busy: "working" },
          goals: { busy: markGoalMet(newGoal("ship it", NOW), NOW) },
        })}
      />,
    );
    const chip = within(rowFor("Busy One")).getByTestId("row-goal");
    expect(chip.getAttribute("data-goal-state")).toBe("met");
    expect(chip.getAttribute("aria-label")).toBe("Goal met — ship it");
    expect(chip.style.color).toBe(C.successInk);
    expect(chip.textContent).not.toContain("Goal");
  });

  it("tells all four states apart by the GLYPH, not by colour alone", () => {
    // WCAG 1.4.1, and the founder's own bar — he asked to see "which have met it, which have let one
    // expire" while SCANNING. Every state is icon-only now, so if the mark were one constant shape
    // in four inks then hue would be the ENTIRE visible difference, and a viewer who does not
    // separate red, amber and green would be back to the bug this change fixes. A distinct glyph
    // costs the row no width at all, so there is no reason to spend the accessibility instead.
    const marks = new Map<string, string>();
    for (const [state, goal] of [
      ["unmet", newGoal("ship it", NOW)],
      ["met", markGoalMet(newGoal("ship it", NOW), NOW)],
      ["expired", newGoal("ship it", NOW - DEFAULT_GOAL_TTL_MS - 60_000)],
      ["escalated", escalateGoal(newGoal("ship it", NOW), NOW, "no progress")],
    ] as const) {
      const { unmount } = render(
        <AgentSidebar project={seed({ status: { busy: "working" }, goals: { busy: goal } })} />,
      );
      const chip = within(rowFor("Busy One")).getByTestId("row-goal");
      expect(chip.getAttribute("data-goal-state")).toBe(state);
      // No words in any state, so the rendered MARK is the whole visible difference — and colour
      // lives in `style`, never in the markup captured here.
      expect(chip.textContent).toBe("");
      marks.set(state, chip.innerHTML);
      unmount();
    }
    // FOUR DISTINCT glyphs, not merely "met differs from unmet": collapsing any pair back to one
    // shape is what re-creates the colour-only channel, and it can happen to any pair.
    expect(new Set(marks.values()).size).toBe(marks.size);
  });

  it("marks an EXPIRED goal in amber — it is unfinished work, not a success", () => {
    render(
      <AgentSidebar
        project={seed({
          status: { busy: "working" },
          // Set far enough in the past that the default TTL has already run out at render time.
          goals: { busy: newGoal("ship it", NOW - DEFAULT_GOAL_TTL_MS - 60_000) },
        })}
      />,
    );
    const chip = within(rowFor("Busy One")).getByTestId("row-goal");
    expect(chip.getAttribute("data-goal-state")).toBe("expired");
    // "never met" is spoken, so the row cannot be mistaken for a finished one.
    expect(chip.getAttribute("aria-label")).toBe("Goal expired, never met — ship it");
    // No visible words in any state — the mark carries it. See GOAL_CHIP_COLOR's header.
    expect(chip.textContent).toBe("");
    expect(chip.getAttribute("aria-label")).toContain("Goal expired, never met");
    // Amber, NOT danger: second loudest. Escalation keeps the top of the row to itself.
    expect(chip.style.color).toBe(C.amberInk);
    expect(chip.style.color).not.toBe(DANGER);
  });

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
    const chip = within(rowFor("Busy One")).getByTestId("row-goal");
    expect(chip.getAttribute("data-goal-state")).toBe("escalated");
    expect(chip.textContent).toBe("");
    expect(chip.getAttribute("aria-label")).toBe("Goal escalated — land PR #42");
    expect(chip.style.color).toBe(DANGER);
    // STILL the loudest of the four, and with no words to bold that has to be carried by the MARK:
    // the biggest icon in the set, and the only DANGER ink.
    expect(chip.querySelector("svg")?.getAttribute("width")).toBe("12");
    expect(chip.getAttribute("title")).toContain("land PR #42");
    expect(chip.getAttribute("title")).toContain("auto-continue gave up — 20 continues, no progress");
  });

  // THE MARK NEVER SHRINKS, AND IT NEVER GROWS WORDS.
  //
  // Both halves were learned by photographing the row, and neither is observable in jsdom, which has
  // no layout engine — so what is asserted is the CONTRACT that decides them. An earlier cut gave
  // `escalated` and `expired` visible text; at a 440px column that rendered `◎ ⚠ aι` and
  // `◎ Goa ⚠ work`, two chips clipped past legibility. The row has one worded slot and the stall
  // chip owns it.
  it("renders every goal state as an icon-only mark that cannot shrink away", () => {
    for (const [state, goal] of [
      ["unmet", newGoal("ship it", NOW)],
      ["met", markGoalMet(newGoal("ship it", NOW), NOW)],
      ["expired", newGoal("ship it", NOW - DEFAULT_GOAL_TTL_MS - 60_000)],
      ["escalated", escalateGoal(newGoal("ship it", NOW), NOW, "no progress")],
    ] as const) {
      const { unmount } = render(
        <AgentSidebar project={seed({ status: { busy: "working" }, goals: { busy: goal } })} />,
      );
      const chip = within(rowFor("Busy One")).getByTestId("row-goal");
      expect(chip.getAttribute("data-goal-state")).toBe(state);
      // No visible text in ANY state — that is the rule the photograph established.
      expect(chip.textContent).toBe("");
      // …and the mark itself is unshrinkable: the icon IS the whole chip, so a shrink factor would
      // clip the one thing bead sparkle-6kz9q exists to make visible, to save ~13px.
      expect(chip.style.flex).toBe("0 0 auto");
      // ESCALATED IS EXCEPTIONAL, AND BOTH SIDES OF THAT COMPARISON ARE PINNED. Asserting only
      // escalated's 12 would leave "every other state shares one size" unguarded — raising the
      // other three to 12, or collapsing the distinction to a single constant, would stay green
      // while destroying the only size signal escalated has (roborev 57417).
      expect(chip.querySelector("svg")?.getAttribute("width")).toBe(
        state === "escalated" ? "12" : "10",
      );
      unmount();
    }
  });

  it("shows NOTHING for an agent with no goal — the control for all four above", () => {
    // Without this, a chip that rendered unconditionally would satisfy every assertion above while
    // destroying the only thing the founder asked for: telling a goal-less agent from a goal-bearing
    // one at a glance.
    render(<AgentSidebar project={seed({ status: { busy: "working" } })} />);
    expect(within(rowFor("Busy One")).queryByTestId("row-goal")).toBeNull();
  });

  it("still spends the row's WORDED slot on the stall chip, not on the goal", () => {
    // The division of labour that makes both fit: the mark says WHICH GOAL STATE (colour, size),
    // the stall chip says WHAT IS OUTSTANDING (words). An escalated goal is also a stall cause, so
    // a quiet escalated row shows both — and that is affordable precisely because only one of them
    // has text. When this suite asserted worded goal chips instead, these two collided on screen.
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
    const row = within(rowFor("Stalled One"));
    const goal = row.getByTestId("row-goal");
    expect(goal.getAttribute("data-goal-state")).toBe("escalated");
    expect(goal.textContent).toBe("");
    // Escalation is categorically different from "needs merging eventually": nothing is coming for
    // this row at all, so the mark takes DANGER rather than the caution ink every other cause gets.
    expect(goal.style.color).toBe(DANGER);
    // ONE MARK FOR THIS FACT, and it is the chip (roborev 59322). The escalated goal used to draw a
    // notice mark as well; that put two DANGER-inked glyphs side by side saying one thing, so the
    // aliased notice is now dropped from the row's marks. The chip is clickable and carries the
    // words on its hover and in its accessible name, which is what this row was really asserting.
    expect(goal.getAttribute("aria-label")).toContain("Goal escalated");
    expect(goal.getAttribute("title")).toContain("auto-continue gave up");
    // No second mark for the same fact — the escalated cause is the ONLY outstanding one here.
    expect(row.queryByTestId("row-notice-glyph")).toBeNull();
    // Digits only, never words — the invariant this whole bead exists to establish.
    expect(goal.textContent).toBe("");
  });
});
