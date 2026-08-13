// @vitest-environment jsdom
//
// ══ THE ROW MUST SAY WHICH AGENT IT IS. Bead sparkle-tyter. ═══════════════════════════════════
//
// The founder asked twice for row notices to become icons. The second ask came with a screenshot,
// and the screenshot showed something worse than the density complaint he was making: rows rendering
// as literal collisions —
//
//     "Rate limitedShipped"   "Rate limitedUnsaved"   "Rate limitedSaved"   "Looping Shipped"
//
// On EIGHT visible rows the agent's NAME WAS ENTIRELY ABSENT. The notice text had taken its place.
//
// THE MECHANISM, because it is not the one it looks like. Nothing was painted over anything; there
// is no absolute positioning anywhere in that row. `FittedAgentName`'s span was `flex: 1;
// minWidth: 0` — "take everything from me first" — and the thrash chip beside it was
// `flex: "0 0 auto"` with `whiteSpace: "nowrap"` and a literal label inside it — "I will not give
// up a pixel". Flexbox resolved that exactly as written: the name shrank to ZERO and the notice
// ended up flush against the stage chip that follows it outside the name container. Reading order
// `[name: 0px][thrash "Rate limited"][stage "Shipped"]` renders as `Rate limitedShipped`.
//
// So this file pins the two halves of the fix, and it is deliberately written so that BOTH
// assertions fail against the code as it was:
//
//   1. NO NOTICE RENDERS PROSE. A notice mark carries an icon and at most a count digit. The words
//      live on its hover and in the pills above the composer.
//   2. THE NAME HAS A FLOOR. `AGENT_NAME_MIN_WIDTH_PX`, so whatever chip the next branch adds to
//      that row, the name degrades by ELLIPSIS — which is information — rather than by vanishing.
//
// WHY THERE IS NO PIXEL MEASUREMENT HERE. jsdom has no layout engine: `getBoundingClientRect()`
// returns 0 for everything, so a test claiming to observe "unclipped" would measure nothing and
// pass vacuously (docs/jsdom-test-caveats.md, and the whole reason `stageChipShows` is a pure
// predicate rather than a measurement). What is assertable — and what actually pins the contract —
// is the style SHAPE and the absence of the words. Real geometry belongs in a Chrome-driven test
// following `BannerStack.layout.test.ts`, which must skip when Chromium is absent or it is
// permanently red on CI.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import {
  AgentSidebar,
  stageChipShows,
  STAGE_CHIP_MIN_COLUMN_PX,
  noticeClusterCollapses,
  NOTICE_CLUSTER_MIN_COLUMN_PX,
} from "./AgentSidebar";
import {
  agentNameFloorFor,
  AGENT_NAME_MIN_WIDTH_PX,
  AGENT_NAME_TIGHT_MIN_WIDTH_PX,
  AGENT_NAME_TIGHT_FLOOR_BELOW_PX,
} from "./FittedAgentName";
import { BUILD_COLUMN_DEFAULT_WIDTH } from "../engine/columnResize";
import { THRASH_VERDICT_LABEL } from "./rowAttention";
import { C } from "../theme/colors";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useCableStore, resetCable } from "../stores/cableStore";
import { useBeadsStore } from "../stores/beadsStore";
import { useHelperPrefs } from "../helper/helperPrefs";
import { allBandsVisible } from "../engine/buildSections";
import { noteThrashEvent, resetThrashTracking } from "../engine/agentThrash";
import type { AgentTab, AgentTabStatus, Project } from "../types";
import type { Bead, Board } from "../services/beads";
import type { WorkflowStageId } from "../engine/workflowStage";
import type { BranchStatus, WorkflowState } from "../services/branchStatus";

const EMPTY_BOARD: Board = { backlog: [], blocked: [], inProgress: [], done: [], delivered: [], archived: [] };

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
const OPEN_PR_WS: WorkflowState = { ...BARE_WS, prState: "open", prNumber: 7, pushed: true };

/** Long enough that a zero-floor row would genuinely have squeezed it — the bug was never visible
 *  on two-character names. And deliberately sharing NO substring with any verdict label, so the
 *  "no notice prose on the row" assertion below cannot be satisfied or defeated by the name itself.
 *  ("Looping Agent Alpha" made that test fail against correct code.) */
const AGENT_NAME = "Marmalade Spiral Beta";

/** An UNMET, unexpired goal — the state whose mark is the founder's "blue target". `setAt` is NOW
 *  rather than a literal so the default TTL has not already run out against the row's live clock,
 *  which would make this an `expired` chip and quietly test the wrong state. */
const UNMET_GOAL = {
  text: "land the retry PR",
  setAt: Date.now(),
  ttlMs: 4 * 60 * 60_000,
  continues: 0,
  totalContinues: 0,
} as AgentTab["goal"];

/** A goal auto-continue GAVE UP on — `escalatedAt` is what latches the state. */
const ESCALATED_GOAL_FIXTURE = {
  text: "land the retry PR",
  setAt: Date.now(),
  ttlMs: 4 * 60 * 60_000,
  continues: 3,
  totalContinues: 3,
  escalatedAt: Date.now(),
  escalationReason: "retry ceiling reached",
} as AgentTab["goal"];

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
    // Pinned so auto-naming cannot rewrite the label the assertions look the row up by.
    namePinned: true,
    autoNameBasis: null,
    autoNameVariants: null,
    shellCommand: null,
    ...over,
  };
}

function seed(
  status: Record<string, AgentTabStatus> = {},
  branchStatus: Record<string, BranchStatus> = {},
  workflowState: Record<string, WorkflowState> = {},
  opts: { stage?: WorkflowStageId; feedback?: number } = {},
  over: Partial<AgentTab> = {},
): Project {
  const project: Project = {
    id: "p1",
    name: "Demo",
    rootPath: "/tmp/demo",
    defaultBranch: "main",
    createdAt: new Date(0).toISOString(),
    selectedAgentId: null,
    agents: [mkAgent("a1", AGENT_NAME, over)],
  };
  useProjectStore.setState({ projects: [project] } as never);
  useRuntimeStore.setState({
    status,
    branchStatus,
    workflowState,
    workflowStage: opts.stage ? { a1: opts.stage } : {},
    workflowShipped: {},
    openAgentIds: ["a1"],
    open: vi.fn(),
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  // The FEEDBACK pill counts beads labelled `agent:<id>` straight off the raw list.
  const beads: Bead[] = Array.from({ length: opts.feedback ?? 0 }, (_, i) => ({
    id: `fb-${i}`,
    title: `feedback ${i}`,
    description: "",
    status: "open" as const,
    labels: ["agent:a1"],
    parent: null,
  }));
  useBeadsStore.setState({
    byProject: { p1: { beads, board: EMPTY_BOARD, loadedAt: Date.now() } },
  } as never);
  return project;
}

const rowFor = (name: string) =>
  screen.getByText(name).closest('[data-hint="agent"]') as HTMLElement;

/**
 * Put the agent into the `repeating-command` thrash verdict, whose label is the literal string
 * "Looping" — one of the four readings on the founder's screenshot ("Looping Shipped").
 *
 * `repeating-command` rather than `quota-blocked` purely because it is fixturable from the public
 * hook-event API: the quota verdict needs a live `QuotaBlock` from `engine/engineRegistry`, which
 * a component test cannot seed without a registered StatusEngine. The RENDERING contract under test
 * is per-class, not per-verdict — `agentNotices.test.ts` walks all ten verdicts — so any non-healthy
 * thrash verdict exercises the same path.
 */
function makeLooping(id = "a1") {
  // Three identical submissions with no tool call between them — the observed /compact spiral.
  for (let i = 0; i < 3; i++) {
    noteThrashEvent(id, { event: "UserPromptSubmit", prompt: "/compact", ts: 1_000 + i });
    noteThrashEvent(id, { event: "Stop", ts: 1_100 + i });
  }
}

beforeEach(() => {
  useUiStore.setState({
    collapsedOrchestrators: {},
    activeSpecial: null,
    statusFilter: allBandsVisible(),
    focusedNoticeBySide: { left: null, right: null },
  } as never);
  useHelperPrefs.setState({ enabled: true } as never);
  resetThrashTracking();
  resetCable();
});
afterEach(() => {
  cleanup();
  resetThrashTracking();
  resetCable();
  useBeadsStore.setState({ byProject: {} } as never);
});

describe("a row carrying a notice STILL SAYS WHICH AGENT IT IS", () => {
  it("renders the agent's full name beside the notice, not in place of it", () => {
    // THE HEADLINE ASSERTION OF THE WHOLE BEAD. On the founder's screenshot this name was gone.
    makeLooping();
    render(<AgentSidebar project={seed({ a1: "working" })} />);
    const row = rowFor(AGENT_NAME);
    expect(within(row).getByTestId("row-agent-name").textContent).toBe(AGENT_NAME);
    // And the row does carry a notice — otherwise this passes for the boring reason.
    expect(within(row).getByTestId("row-notice-glyph")).toBeTruthy();
  });

  it("gives the name a NON-ZERO width floor, so no sibling can squeeze it to nothing", () => {
    // The structural half. `minWidth: 0` is what let flexbox take the name to zero; the notice
    // marks being wordless fixes the chips that exist TODAY, and this fixes the ones that don't.
    // FAILS against the pre-change code, where this span was `minWidth: 0`.
    makeLooping();
    render(<AgentSidebar project={seed({ a1: "working" })} />);
    const name = within(rowFor(AGENT_NAME)).getByTestId("row-agent-name");
    expect(AGENT_NAME_MIN_WIDTH_PX).toBeGreaterThan(0);
    expect(name.style.minWidth).toBe(`${AGENT_NAME_MIN_WIDTH_PX}px`);
    // It still truncates rather than growing the row — the degradation is an ellipsis.
    expect(name.style.overflow).toBe("hidden");
  });

  it("renders NO notice prose anywhere on the row — icons and digits only", () => {
    // FAILS against the pre-change code, which rendered the literal "Rate limited" here. This is
    // the assertion the founder's requirement 1 reduces to: "never text; never anything that can
    // occupy the name's space."
    makeLooping();
    render(<AgentSidebar project={seed({ a1: "working" })} />);
    const row = rowFor(AGENT_NAME);
    for (const mark of within(row).getAllByTestId("row-notice-glyph")) {
      // Empty, or a bare count. Never a word.
      expect(mark.textContent ?? "").toMatch(/^\d*$/);
    }
    // Belt and braces: not one of the ten verdict labels appears as visible row text.
    for (const label of Object.values(THRASH_VERDICT_LABEL)) {
      expect(row.textContent).not.toContain(label);
    }
  });

  it("keeps the words reachable WITHOUT mounting — they ride the hover", () => {
    // Requirement 4: "hover or click the row icon reveals the same detail WITHOUT mounting, so a
    // glance is still possible." Moving the words off the row only works if they are still gettable.
    makeLooping();
    render(<AgentSidebar project={seed({ a1: "working" })} />);
    const mark = within(rowFor(AGENT_NAME)).getByTestId("row-notice-glyph");
    expect(mark.getAttribute("title")).toContain("Looping");
    expect(mark.getAttribute("aria-label")).toContain("Looping");
  });

  it("collapses several warnings into ONE mark carrying a count", () => {
    // "If we're gonna have more than one or two showing up on the row, we need to find a different
    // way to handle it." One mark per class is that different way — a mark per verdict would
    // rebuild the same wall of signal in icon form.
    makeLooping();
    render(
      <AgentSidebar
        project={seed(
          { a1: "idle" },
          { a1: { ...CLEAN_BS, ahead: 3, dirty: true } },
          { a1: OPEN_PR_WS },
        )}
      />,
    );
    const marks = within(rowFor(AGENT_NAME)).getAllByTestId("row-notice-glyph");
    expect(marks).toHaveLength(1);
    expect(Number(marks[0]!.getAttribute("data-notice-count"))).toBeGreaterThan(1);
  });

  it("shows no mark at all on an agent with nothing to say", () => {
    // The control. Without it every assertion above could pass on a row that marks everything.
    render(<AgentSidebar project={seed({ a1: "working" })} />);
    expect(within(rowFor(AGENT_NAME)).queryByTestId("row-notice-glyph")).toBeNull();
  });
});

describe("clicking a notice mark mounts the agent and names the pill to open", () => {
  it("patches the cable and records the lead notice", () => {
    // The founder's worked example, generalized: "If I were to click on the mailbox icon on the row
    // then the mailbox could expand on the mounted concierge." Assert the SIDE EFFECTS — the cable
    // moved and the notice id was recorded — not merely that a handler exists.
    makeLooping();
    render(<AgentSidebar project={seed({ a1: "working" })} />);
    expect(useCableStore.getState().wired).toBe("off");

    fireEvent.click(within(rowFor(AGENT_NAME)).getByTestId("row-notice-glyph"));

    expect(useCableStore.getState().wired).not.toBe("off");
    const side = useCableStore.getState().wired as "left" | "right";
    expect(useUiStore.getState().focusedNoticeBySide[side]).toBe("thrash:repeating-command");
  });

  it("makes the GOAL chip clickable too — the blue target that did nothing", () => {
    // ══ THE FOUNDER'S SECOND SCOPE ADDITION (bead sparkle-tyter) ═══════════════════════════════
    // *"When I click, for example, on screenshot and upload split, there is a blue target and I
    // don't know what that blue target is. When I click on the blue target it doesn't do anything.
    // I'm not seeing any sort of notice above the compose window when the concierge is mounted."*
    //
    // The chip was a MARK with no onClick, on the premise that its words stayed recoverable through
    // its hover title and its accessible name. He went straight for a click and recovered nothing.
    // Asked which model to use, he chose MOUNT-then-explain — so this asserts all three side
    // effects, not merely that a handler exists. FAILS against the pre-change chip, which had no
    // click handler at all.
    render(
      <AgentSidebar
        project={seed({ a1: "working" }, {}, {}, {}, { goal: UNMET_GOAL })}
      />,
    );
    const goal = within(rowFor(AGENT_NAME)).getByTestId("row-goal");
    // Operable, and ANNOUNCED as operable — `role="img"` on a control is a control a screen-reader
    // user cannot find.
    expect(goal.getAttribute("role")).toBe("button");
    expect(goal.getAttribute("tabindex")).toBe("0");

    fireEvent.click(goal);

    expect(useCableStore.getState().wired).not.toBe("off");
    const side = useCableStore.getState().wired as "left" | "right";
    // The pill NAMED, not merely "something about this agent" — the composer has to know which of
    // its pills to open, and `goal:unmet` is the one whose explainer says what a blue target is.
    expect(useUiStore.getState().focusedNoticeBySide[side]).toBe("goal:unmet");
  });

  it("inks the ESCALATED goal chip amber, matching the composer's goal pill", () => {
    // roborev 59986. The composer pill's `escalated -> DANGER` case was dropped when escalation
    // moved to the amber `lapsed` tier, and this chip was left red — so one fact read amber on the
    // composer and red here, which is the cross-surface split the branch exists to close, relocated
    // onto the goal notice. GOAL_GLYPH's rule is that the chip and the pill must not diverge for a
    // single state, and nothing pinned this side: reverting GOAL_CHIP_COLOR.escalated to DANGER left
    // the whole suite green, which is why this assertion exists rather than only its pill twin in
    // Concierge/MountedAgentNotices.test.tsx.
    render(
      <AgentSidebar
        project={seed({ a1: "idle" }, {}, {}, {}, { goal: ESCALATED_GOAL_FIXTURE })}
      />,
    );
    const goal = within(rowFor(AGENT_NAME)).getByTestId("row-goal");
    // THE STATE FIRST. `GOAL_CHIP_COLOR.expired` is ALSO amber, so an ink-only assertion would stay
    // green if the fixture ever stopped producing `escalated` — a changed default TTL, a reordering
    // in `goalStateOf`, a dropped `escalatedAt` — and would then be guarding the wrong state
    // entirely (roborev 60001). Its sibling in stallOverlay pins the state for the same reason.
    expect(goal.getAttribute("data-goal-state")).toBe("escalated");
    expect(goal.style.color).toBe(C.amberInk);
  });

  it("still renders the goal as a GLYPH — clickable did not mean wordy", () => {
    // Requirement 4 of the same message: *"Do NOT reintroduce visible text on the row."* Making the
    // chip operable is exactly the kind of change that tempts a label onto it.
    render(
      <AgentSidebar
        project={seed({ a1: "working" }, {}, {}, {}, { goal: UNMET_GOAL })}
      />,
    );
    const goal = within(rowFor(AGENT_NAME)).getByTestId("row-goal");
    expect(goal.textContent ?? "").toBe("");
    // …and the goal's own words are nowhere on the row either.
    expect(rowFor(AGENT_NAME).textContent).not.toContain("land the retry PR");
  });

  it("draws ONE glyph per fact — the goal chip, not a second identical mark beside it", () => {
    // ══ THE BUG THE LAST FIX PRODUCED (roborev 59322) ═════════════════════════════════════════
    // Passing the goal into `agentNotices` so the mark could take the goal's glyph meant the row
    // drew `FiTarget` TWICE for one fact — the goal chip and the notice mark, side by side, against
    // GOAL_CHIP_ICON's own rule that two different facts must not share a shape on one row. The
    // goal chip is that fact's mark here and it is clickable, so the aliased notice is dropped from
    // the marks. FAILS if `withoutSeparatelyDrawn` stops filtering.
    render(
      <AgentSidebar
        project={seed({ a1: "idle" }, { a1: CLEAN_BS }, { a1: BARE_WS }, {}, { goal: UNMET_GOAL })}
      />,
    );
    const row = rowFor(AGENT_NAME);
    // The goal is still marked…
    expect(within(row).getByTestId("row-goal")).toBeTruthy();
    // …and it is NOT marked a second time.
    expect(within(row).queryByTestId("row-notice-glyph")).toBeNull();
  });

  it("still marks a warning that is NOT the goal, beside the goal chip", () => {
    // The control. Without it, dropping every mark whenever a goal exists would pass the test above
    // — and would delete the amber "something is wrong here" reading the warning class carries.
    render(
      <AgentSidebar
        project={seed({ a1: "idle" }, { a1: CLEAN_BS }, { a1: OPEN_PR_WS }, {}, { goal: UNMET_GOAL })}
      />,
    );
    const row = rowFor(AGENT_NAME);
    expect(within(row).getByTestId("row-goal")).toBeTruthy();
    const mark = within(row).getByTestId("row-notice-glyph");
    expect(mark.getAttribute("data-notice-lead")).toBe("stall:open-pr");
    // Amber alert, not the goal's blue target — one fact, one mark, and the right one.
    expect(mark.getAttribute("data-notice-glyph")).toBe("alert");
  });

  it("keeps ONE mark for several warnings on a row that also has a goal — the CONTROL", () => {
    // ══ THE PARITY RULE, IN THE FORM THAT SURVIVED (roborev 59278 → 59322) ════════════════════
    // Round one: the row passed no goal, so it drew an amber triangle where the composer drew a blue
    // target for one notice id — click one shape, land on another. Round two fixed that by giving
    // the row's mark the goal glyph, and produced a row drawing FiTarget twice for one fact, plus an
    // ink table the two surfaces disagreed on.
    //
    // The form that holds: the row does not MARK a fact its goal chip already draws, so its marks
    // can never take a goal glyph — and with no goal glyph there is no second colour table to
    // diverge.
    //
    // ══ THIS ROW IS THE CONTROL, NOT THE GUARD (roborev 59342) ═══════════════════════════════
    // An earlier comment here claimed it asserted the rule "over every mark rather than on one
    // fixture". That was backwards, and it made the test unable to fail: `rowGlyphsFor` collapses
    // the warning class to ONE mark and keeps the loudest glyph, where `alert` outranks `target`
    // and `clock` — so with a dirty tree and an open PR in the fixture the surviving mark is
    // `alert` whether or not the goal notice was filtered. A goal glyph can only reach a mark when
    // the goal cause is the SOLE warning, which is precisely what this fixture is not.
    //
    // What it does prove, and what it is kept for: a row carrying several warnings AND a goal still
    // shows one mark plus one chip — no duplication, nothing swallowed. The rule itself is guarded
    // fixture-independently over every aliased state in `agentNotices.test.ts`.
    render(
      <AgentSidebar
        project={seed(
          { a1: "idle" },
          { a1: { ...CLEAN_BS, ahead: 3, dirty: true } },
          { a1: OPEN_PR_WS },
          {},
          { goal: UNMET_GOAL },
        )}
      />,
    );
    const row = rowFor(AGENT_NAME);
    const marks = within(row).getAllByTestId("row-notice-glyph");
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) {
      expect(["target", "clock", "check"]).not.toContain(mark.getAttribute("data-notice-glyph"));
    }
    // …and the goal is still marked, once, by its own chip.
    expect(within(row).getAllByTestId("row-goal")).toHaveLength(1);
  });

  it("is operable from the keyboard, not pointer-only", () => {
    makeLooping();
    render(<AgentSidebar project={seed({ a1: "working" })} />);
    const mark = within(rowFor(AGENT_NAME)).getByTestId("row-notice-glyph");
    expect(mark.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(mark, { key: "Enter" });
    expect(useCableStore.getState().wired).not.toBe("off");
  });
});

describe("the right-hand slot holds ONE pill, and drops it when the column is tight", () => {
  it("shows FEEDBACK instead of the stage chip when the agent has feedback", () => {
    // The founder: "If an agent has provided feedback then it should say 'feedback' instead of
    // 'shift' or whatever. The feedback label should go where the PR or shift, etc., label goes."
    // ("shift" is dictation for "Shipped".) They used to render side by side.
    render(
      <AgentSidebar
        project={seed({ a1: "idle" }, { a1: CLEAN_BS }, { a1: OPEN_PR_WS }, {
          stage: "pull_request",
          feedback: 3,
        })}
      />,
    );
    const row = rowFor(AGENT_NAME);
    expect(within(row).getByTestId("row-feedback-pill")).toBeTruthy();
    expect(within(row).queryByTestId("row-stage-chip")).toBeNull();
  });

  it("still shows the stage chip when there is no feedback", () => {
    // The control for the case above — without it, deleting the stage chip outright would pass.
    render(
      <AgentSidebar
        project={seed({ a1: "idle" }, { a1: CLEAN_BS }, { a1: OPEN_PR_WS }, {
          stage: "pull_request",
        })}
      />,
    );
    expect(within(rowFor(AGENT_NAME)).getByTestId("row-stage-chip")).toBeTruthy();
  });
});

describe("stageChipShows — the narrow-column rule, as a pure predicate", () => {
  // Pure and exported for the reason `ComposeBox.attachShowsLabels` is: jsdom has no layout engine,
  // so the component measures and this decides. Testing the decision is testable; testing the
  // measurement in jsdom is not.
  it("hides the chip below the threshold", () => {
    expect(stageChipShows(STAGE_CHIP_MIN_COLUMN_PX - 1)).toBe(false);
    expect(stageChipShows(120)).toBe(false);
  });

  it("shows it at or above the threshold", () => {
    expect(stageChipShows(STAGE_CHIP_MIN_COLUMN_PX)).toBe(true);
    expect(stageChipShows(600)).toBe(true);
  });

  it("IS SILENT AT THE WIDTH THE APP ACTUALLY OPENS AT — the name outranks the chip", () => {
    // ══ THIS ASSERTION IS THE REVERSE OF WHAT IT USED TO BE, DELIBERATELY ════════════════════
    // It previously read `expect(stageChipShows(BUILD_COLUMN_DEFAULT_WIDTH)).toBe(true)`, pinning
    // roborev 58758's rule that the threshold must sit BELOW the default width so the chip is not
    // "deleted for every user until they drag the column wider".
    //
    // That rule optimised for the chip, and it was reversed on the founder's own evidence once the
    // row could finally be MEASURED. `scripts/visual/row-narrow-probe.mjs` reads the real column in
    // real Chrome at exactly this width and found the chip alive while the agent's NAME was down to
    // 9 characters — rows reading "Concierge…" / "G." / "F" — and, at that squeeze, the name's own
    // box painting 269px² ON TOP of the chip. His instruction: *"THE NAME WINS. It gets its space
    // first; badges take what is left and truncate or collapse themselves, never the name."*
    //
    // Nothing is lost that was not already on screen: every row under "LOCAL: COMMITTED" says
    // Saved and every row under "REMOTE: MERGED TO MAIN" says Merged, so the chip was the second
    // printing of a fact its own section heading carries three pixels above it — while the name is
    // the one fact nothing else on the row says at all.
    //
    // Still a RELATIONSHIP against the real constants rather than a literal, so it keeps failing if
    // either number moves; only the DIRECTION of the relationship changed.
    expect(stageChipShows(BUILD_COLUMN_DEFAULT_WIDTH)).toBe(false);
    expect(STAGE_CHIP_MIN_COLUMN_PX).toBeGreaterThan(BUILD_COLUMN_DEFAULT_WIDTH);
  });

  // ── THE COLLAPSE ─────────────────────────────────────────────────────────────────────────────
  // The other half of "the name wins": hiding the stage chip alone still left the name at 9
  // characters, because the goal chip and the warning marks are individually tiny and collectively
  // decisive. These pin the DECISION; `scripts/visual/row-narrow-probe.mjs` is what can observe the
  // resulting geometry, since jsdom cannot measure a flex line at all.
  it("collapses the notice cluster on a narrow column, and not on a wide one", () => {
    expect(noticeClusterCollapses(NOTICE_CLUSTER_MIN_COLUMN_PX - 1, 2)).toBe(true);
    expect(noticeClusterCollapses(NOTICE_CLUSTER_MIN_COLUMN_PX, 2)).toBe(false);
    expect(noticeClusterCollapses(600, 5)).toBe(false);
  });

  it("NEVER collapses a single mark — an overflow affordance for one mark is strictly worse", () => {
    // Same width, less meaning, one more click to read it. This is the assertion that stops the
    // collapse from being applied blindly to every narrow row.
    expect(noticeClusterCollapses(NOTICE_CLUSTER_MIN_COLUMN_PX - 1, 1)).toBe(false);
    expect(noticeClusterCollapses(NOTICE_CLUSTER_MIN_COLUMN_PX - 1, 0)).toBe(false);
  });

  // ── THE NAME'S FLOOR ─────────────────────────────────────────────────────────────────────────
  // These exist because the floor SHIPPED keyed to the wrong threshold and nothing could fail.
  // The call site read `stageChipShows(columnWidth) ? wide : tight`, and `stageChipShows(0)` is
  // TRUE while jsdom pins columnWidth at 0 — so every jsdom render took the wide branch, the
  // existing `minWidth` assertion pinned only that branch, and the narrow branch that actually
  // ships was unguarded. Extracting the decision into a pure function is what makes both
  // reachable.
  it("KEEPS THE FULL FLOOR AT THE WIDTH THE APP OPENS AT", () => {
    // THE REGRESSION THIS PINS. The tight floor was gated on the stage chip's 260 while its own
    // docs said 220, so the whole 220-259 band — including BUILD_COLUMN_DEFAULT_WIDTH — got the
    // 16px floor. A row carrying enough badges could then squeeze the name to about one character
    // plus an ellipsis: the "G." / "F" reading AGENT_NAME_MIN_WIDTH_PX exists to prevent, at the
    // one width every user boots into.
    expect(agentNameFloorFor(BUILD_COLUMN_DEFAULT_WIDTH)).toBe(AGENT_NAME_MIN_WIDTH_PX);
    // The whole band, not just its edge — asserted as a RELATIONSHIP so moving either constant
    // re-fails this rather than leaving a literal that silently goes stale.
    expect(AGENT_NAME_TIGHT_FLOOR_BELOW_PX).toBeLessThanOrEqual(BUILD_COLUMN_DEFAULT_WIDTH);
    expect(agentNameFloorFor(STAGE_CHIP_MIN_COLUMN_PX - 1)).toBe(AGENT_NAME_MIN_WIDTH_PX);
  });

  it("drops to the tight floor only BELOW its own threshold, so a warning outranks unreadable letters", () => {
    expect(agentNameFloorFor(AGENT_NAME_TIGHT_FLOOR_BELOW_PX - 1)).toBe(
      AGENT_NAME_TIGHT_MIN_WIDTH_PX,
    );
    expect(agentNameFloorFor(AGENT_NAME_TIGHT_FLOOR_BELOW_PX)).toBe(AGENT_NAME_MIN_WIDTH_PX);
    expect(agentNameFloorFor(120)).toBe(AGENT_NAME_TIGHT_MIN_WIDTH_PX);
  });

  it("treats NOT-YET-MEASURED as the WIDE floor, so booting never flashes a one-character name", () => {
    expect(agentNameFloorFor(0)).toBe(AGENT_NAME_MIN_WIDTH_PX);
  });

  it("treats NOT-YET-MEASURED as wide, so booting does not flicker every row at once (collapse too)", () => {
    // Same convention as `stageChipShows`, and it has to be: booting into the COLLAPSED state and
    // expanding a frame later is a visible flicker on every row in the column at once.
    expect(noticeClusterCollapses(0, 3)).toBe(false);
  });

  it("treats NOT-YET-MEASURED as wide, so booting does not flicker every row at once", () => {
    // 0 is "no ResizeObserver callback has landed", not "a zero-width column". Booting into the
    // hidden state and revealing the chip a frame later is a visible flicker down the whole column.
    expect(stageChipShows(0)).toBe(true);
  });
});
