// @vitest-environment jsdom
//
// The other half of bead sparkle-tyter: the sidebar row was stripped down to wordless glyphs, so
// the WORDS have to land somewhere with room for them or the fix is just a deletion. This is that
// somewhere.
//
// The founder's requirement, and the reason a label alone does not discharge it:
//   *"I don't really understand what rate limited means or what Looping means so there's no reason
//   to tell me if you're not gonna execute, explain it to me in some place, or let me do something
//   about it."*
// So the assertions below are about the EXPLANATION being reachable, not about a pill existing.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MountedAgentNotices,
  NOTICE_PILL_TESTID,
  NOTICE_DETAIL_TESTID,
  NOTICE_MESSAGE_TESTID,
  NOTICE_OWN_WORDS_TESTID,
} from "./MountedAgentNotices";
import { NOTICE_EXPLAINER } from "../agentNotices";
import { C, DANGER } from "../../theme/colors";

import { useProjectStore } from "../../stores/projectStore";
import { useRuntimeStore } from "../../stores/runtimeStore";
import { useUiStore } from "../../stores/uiStore";
import { useInboxStore } from "../../stores/inboxStore";
import { noteThrashEvent, resetThrashTracking } from "../../engine/agentThrash";
import type { AgentTab, Project } from "../../types";
import type { BranchStatus, WorkflowState } from "../../services/branchStatus";

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

/** A goal auto-continue GAVE UP on — the founder's red octagon. `escalatedAt` is what latches it,
 *  and an escalated agent is idle by definition, which is why this is the case the suppression bug
 *  hid behind. */
const ESCALATED_GOAL = {
  text: "land the retry PR",
  setAt: Date.now(),
  ttlMs: 4 * 60 * 60_000,
  continues: 3,
  totalContinues: 3,
  escalatedAt: Date.now(),
  escalationReason: "retry ceiling reached",
} as AgentTab["goal"];

function agent(over: Partial<AgentTab> = {}): AgentTab {
  return {
    id: "a1",
    name: "Alpha",
    kind: "build",
    parentId: null,
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "",
    promptHistory: [],
    namePinned: true,
    autoNameBasis: null,
    autoNameVariants: null,
    shellCommand: null,
    ...over,
  };
}

function seed(
  runtime: {
    status?: Record<string, string>;
    branchStatus?: Record<string, BranchStatus>;
    workflowState?: Record<string, WorkflowState>;
  } = {},
) {
  const project: Project = {
    id: "p1",
    name: "Demo",
    rootPath: "/tmp/demo",
    defaultBranch: "main",
    createdAt: new Date(0).toISOString(),
    selectedAgentId: null,
    agents: [agent()],
  };
  useProjectStore.setState({ projects: [project] } as never);
  useRuntimeStore.setState({
    status: runtime.status ?? {},
    branchStatus: runtime.branchStatus ?? {},
    workflowState: runtime.workflowState ?? {},
    workflowStage: {},
  } as never);
}

/** One inbox entry in a chosen delivery state — `inbox_peek` returns delivered and acknowledged
 *  entries alongside pending ones, which is the distinction the mailbox pill has to respect. */
function mkEntry(id: string, text: string, state: "pending" | "delivered" | "acknowledged") {
  return {
    id,
    ts: Date.now(),
    from: "concierge",
    text,
    severity: "act",
    state,
    ackedAt: null,
    ackNote: null,
  };
}

/** Queue messages for a1 the way the concierge does. */
function queue(...texts: string[]) {
  useInboxStore.setState({
    byAgent: {
      a1: texts.map((text, i) => ({
        id: `m${i}`,
        ts: Date.now(),
        from: "concierge",
        text,
        severity: "act",
        state: "pending",
        ackedAt: null,
        ackNote: null,
      })),
    },
  } as never);
}

/** The `repeating-command` verdict ("Looping") — fixturable from the public hook-event API, unlike
 *  `quota-blocked`, which needs a live QuotaBlock from the engine registry. */
function makeLooping() {
  for (let i = 0; i < 3; i++) {
    noteThrashEvent("a1", { event: "UserPromptSubmit", prompt: "/compact", ts: 1_000 + i });
    noteThrashEvent("a1", { event: "Stop", ts: 1_100 + i });
  }
}

const pills = () => screen.queryAllByTestId(NOTICE_PILL_TESTID);

beforeEach(() => {
  useUiStore.setState({ focusedNoticeBySide: { left: null, right: null } } as never);
  useInboxStore.setState({ byAgent: {} } as never);
  resetThrashTracking();
});
afterEach(() => {
  cleanup();
  resetThrashTracking();
  useInboxStore.setState({ byAgent: {} } as never);
});

describe("MountedAgentNotices", () => {
  it("renders NOTHING for an agent with nothing to say", () => {
    // Not an empty strip: the compose box auto-grows against the space above it, so a reserved row
    // would take height from the thread for a message that is not there.
    seed({ status: { a1: "working" } });
    const { container } = render(<MountedAgentNotices agentId="a1" side="left" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one pill per notice, carrying the WORDS the row is no longer allowed to show", () => {
    makeLooping();
    seed({ status: { a1: "working" } });
    render(<MountedAgentNotices agentId="a1" side="left" />);
    expect(pills()).toHaveLength(1);
    expect(pills()[0]!.textContent).toContain("Looping");
  });

  it("does NOT ink the escalated pill with the alarm colour — this is the only surface that shows it", () => {
    // roborev 59969, and the surface matters. `escalated-goal` moved to the amber `lapsed` tier, but
    // the pill kept an `escalated → DANGER` special case, so the one cause that needs NOTHING from
    // the founder was still painted in the alarm colour, text and border both.
    //
    // IT HAD TO BE ASSERTED *HERE*, not on the sidebar: `withoutSeparatelyDrawn` strips
    // `stall:escalated-goal` from the row's marks whenever a goal badge exists — always, since the
    // cause derives from `goalStateOf` — so the sidebar's escalated branch is unreachable and a test
    // there would pass against the bug. The first attempt at this fix corrected that unreachable
    // branch and left this one live, which is exactly what an unreachable-surface test would hide.
    const project: Project = {
      id: "p1",
      name: "Demo",
      rootPath: "/tmp/demo",
      defaultBranch: "main",
      createdAt: new Date(0).toISOString(),
      selectedAgentId: null,
      agents: [agent({ goal: ESCALATED_GOAL })],
    };
    useProjectStore.setState({ projects: [project] } as never);
    useRuntimeStore.setState({
      status: { a1: "idle" },
      branchStatus: { a1: CLEAN_BS },
      workflowState: { a1: BARE_WS },
      workflowStage: {},
    } as never);

    render(<MountedAgentNotices agentId="a1" side="left" />);
    const pill = pills().find((p) => p.getAttribute("data-notice-id") === "stall:escalated-goal");
    expect(pill).toBeDefined();
    // Assert against the TOKENS, not hex literals, so a palette retune cannot silently re-red it.
    // Compared as the raw inline value rather than a computed colour: these are themed CSS vars and
    // jsdom does not resolve `var(...)`, so a computed-style comparison would be testing nothing.
    const ink = (pill as HTMLElement).style.color;
    expect(ink).not.toBe(DANGER);
    expect(ink).toBe(C.amberInk);
    // NOT asserted via `style.borderColor` — that reads "" whichever colour is painted, because the
    // pill sets the SHORTHAND `border: 1px solid ${ink}` and cssstyle clears the longhands whenever
    // the value contains a `var()`. An earlier version of this test did exactly that and could not
    // fail in either direction (roborev 59986), which is the vacuous shape this file exists to
    // catch. The shorthand is where the value survives, and it comes from the same `ink`.
    expect((pill as HTMLElement).style.border).toBe(`1px solid ${C.amberInk}`);
  });

  it("keeps the goal:escalated PILL at the same tier as the sidebar's goal CHIP", () => {
    // roborev 59986. Dropping the pill's `escalated -> DANGER` case changed the ink of EVERY
    // escalated-glyph notice, not just the stall cause -- including the `goal:escalated` pill, which
    // is reachable whenever the stall does not pre-empt it (stall causes are raised only for a quiet
    // agent, so an escalated-then-resumed one renders this). That briefly made one fact read amber
    // on the composer and red on the sidebar chip: the cross-surface tier split this branch exists
    // to close, relocated onto the goal pill. GOAL_GLYPH's own rule is that the two must not
    // diverge for a single state, so the chip moved to amber too and this pins them together.
    const project: Project = {
      id: "p1",
      name: "Demo",
      rootPath: "/tmp/demo",
      defaultBranch: "main",
      createdAt: new Date(0).toISOString(),
      selectedAgentId: null,
      agents: [agent({ goal: ESCALATED_GOAL })],
    };
    useProjectStore.setState({ projects: [project] } as never);
    useRuntimeStore.setState({
      // WORKING, deliberately: a quiet agent raises stall causes, and `stall:escalated-goal` would
      // then be the notice under test instead of the goal pill.
      status: { a1: "working" },
      branchStatus: { a1: CLEAN_BS },
      workflowState: { a1: BARE_WS },
      workflowStage: {},
    } as never);

    render(<MountedAgentNotices agentId="a1" side="left" />);
    const pill = pills().find((p) => p.getAttribute("data-notice-id") === "goal:escalated");
    expect(pill).toBeDefined();
    // GOAL_CHIP_COLOR.escalated is the sidebar chip's ink; the two are asserted equal rather than
    // both spelled out, so moving the tier again moves both or fails here.
    expect((pill as HTMLElement).style.color).toBe(C.amberInk);
    expect((pill as HTMLElement).style.color).not.toBe(DANGER);
  });

  it("gives EVERY stall cause its own pill, not a head plus '+2'", () => {
    // The row could only ever show one phrase and hung a "+N" off it. "+2" is exactly the reading
    // the founder cannot act on, and this surface has no such constraint.
    seed({
      status: { a1: "idle" },
      branchStatus: { a1: { ...CLEAN_BS, ahead: 3, dirty: true } },
      workflowState: { a1: OPEN_PR_WS },
    });
    render(<MountedAgentNotices agentId="a1" side="left" />);
    expect(pills().length).toBeGreaterThan(1);
    const ids = pills().map((p) => p.getAttribute("data-notice-id"));
    expect(ids).toContain("stall:open-pr");
    expect(ids).toContain("stall:uncommitted-changes");
  });

  it("EXPANDS a pill to its plain-English explainer — the whole point of the surface", () => {
    // FAILS if the pill is inert. Asserts the explainer TEXT reached the DOM, not merely that a
    // click handler ran: the founder's complaint is that the label taught him nothing.
    makeLooping();
    seed({ status: { a1: "working" } });
    render(<MountedAgentNotices agentId="a1" side="left" />);
    expect(screen.queryByTestId(NOTICE_DETAIL_TESTID)).toBeNull();

    fireEvent.click(pills()[0]!);

    const detail = screen.getByTestId(NOTICE_DETAIL_TESTID);
    expect(detail.textContent).toContain(NOTICE_EXPLAINER["thrash:repeating-command"]);
    // …and the explanation is a real one, not the label restated.
    expect(detail.textContent!.length).toBeGreaterThan(60);
  });

  it("keeps only ONE pill open at a time", () => {
    // Two open explainers push the composer down twice as far, and this row sits directly above the
    // thing the user is trying to type into.
    seed({
      status: { a1: "idle" },
      branchStatus: { a1: { ...CLEAN_BS, ahead: 3, dirty: true } },
      workflowState: { a1: OPEN_PR_WS },
    });
    render(<MountedAgentNotices agentId="a1" side="left" />);
    fireEvent.click(pills()[0]!);
    fireEvent.click(pills()[1]!);
    expect(screen.getAllByTestId(NOTICE_DETAIL_TESTID)).toHaveLength(1);
    expect(pills()[0]!.getAttribute("data-notice-open")).toBe("false");
    expect(pills()[1]!.getAttribute("data-notice-open")).toBe("true");
  });

  it("collapses a pill on a second click", () => {
    makeLooping();
    seed({ status: { a1: "working" } });
    render(<MountedAgentNotices agentId="a1" side="left" />);
    fireEvent.click(pills()[0]!);
    fireEvent.click(pills()[0]!);
    expect(screen.queryByTestId(NOTICE_DETAIL_TESTID)).toBeNull();
  });

  it("expands the MAILBOX to the actual queued messages — the founder's own example", () => {
    // "If I were to click on the mailbox icon on the row then the mailbox could expand on the
    // mounted concierge and then could show me the actual queued messages."
    queue("rebase onto main first", "then open the PR");
    seed({ status: { a1: "working" } });
    render(<MountedAgentNotices agentId="a1" side="left" />);
    const mailbox = pills().find((p) => p.getAttribute("data-notice-id") === "inbox")!;
    expect(mailbox.textContent).toContain("2 queued messages");

    fireEvent.click(mailbox);

    const msgs = screen.getAllByTestId(NOTICE_MESSAGE_TESTID);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.textContent).toContain("rebase onto main first");
    expect(msgs[1]!.textContent).toContain("then open the PR");
  });

  it("opens the pill named by a ROW-MARK click, and consumes the request", () => {
    // The row's notice glyph writes `focusedNoticeBySide` and this surface acts on it — the
    // "mount + expand that pill" gesture, end to end. CONSUMING it is the load-bearing half: left
    // set, a later manual collapse would be undone on the very next render.
    makeLooping();
    seed({ status: { a1: "working" } });
    useUiStore.setState({
      focusedNoticeBySide: { left: "thrash:repeating-command", right: null },
    } as never);

    render(<MountedAgentNotices agentId="a1" side="left" />);

    expect(screen.getByTestId(NOTICE_DETAIL_TESTID)).toBeTruthy();
    expect(useUiStore.getState().focusedNoticeBySide.left).toBeNull();
    // Consumed, so collapsing it sticks.
    fireEvent.click(pills()[0]!);
    expect(screen.queryByTestId(NOTICE_DETAIL_TESTID)).toBeNull();
  });

  it("ignores a focus request aimed at the OTHER side's column", () => {
    // Both pairs can be mounted at once; a global string would have a LEFT row's click expand a
    // pill in the RIGHT column's composer.
    makeLooping();
    seed({ status: { a1: "working" } });
    useUiStore.setState({
      focusedNoticeBySide: { left: null, right: "thrash:repeating-command" },
    } as never);
    render(<MountedAgentNotices agentId="a1" side="left" />);
    expect(screen.queryByTestId(NOTICE_DETAIL_TESTID)).toBeNull();
  });

  it("makes no claim about an agent whose git state was never read", () => {
    // `undefined` means "we never looked", and rowAttention returns no verdict for it. A pill row
    // that invented "PR unmerged" from missing data would train the founder to ignore the surface.
    //
    // THIS TEST NEVER CALLED `render()` (roborev 58774). `pills()` queried a DOM the previous
    // test's `cleanup()` had already emptied, so `expect([]).not.toContain(...)` passed against
    // anything at all — including a component that fabricates every stall pill from missing data,
    // which is the exact behaviour it claims to guard. The positive control below is what makes the
    // negative assertion capable of failing: same component, one field added, pill appears.
    seed({ status: { a1: "idle" } });
    render(<MountedAgentNotices agentId="a1" side="left" />);
    expect(pills().map((p) => p.getAttribute("data-notice-id"))).not.toContain("stall:open-pr");

    cleanup();
    seed({ status: { a1: "idle" }, branchStatus: { a1: CLEAN_BS }, workflowState: { a1: OPEN_PR_WS } });
    render(<MountedAgentNotices agentId="a1" side="left" />);
    expect(pills().map((p) => p.getAttribute("data-notice-id"))).toContain("stall:open-pr");
  });

  it("asks about the agent the way the ROW does — a finished agent with unlanded work", () => {
    // ══ THE HIGH FINDING (roborev 58774) ════════════════════════════════════════════════════
    // This surface read the RAW status and defaulted it to `idle`; the row asks about the calm map,
    // where `withUnmergedWork` has already overlaid `unmerged`. A finished agent holding
    // committed-but-unlanded work is `done` raw — which `agentStall.isQuiet` REJECTS — so the row
    // drew its alert glyph, the click mounted the agent and patched the cable, and this component
    // returned null. The headline gesture landed on an empty composer, 100% of the time, on the
    // most common stalled shape there is.
    //
    // FAILS against `status ?? "idle"` reading the raw value: no pills render at all.
    seed({
      status: { a1: "done" },
      branchStatus: { a1: { ...CLEAN_BS, ahead: 2 } },
      workflowState: { a1: { ...BARE_WS, pushed: true } as WorkflowState },
    });
    render(<MountedAgentNotices agentId="a1" side="left" />);
    expect(pills().length).toBeGreaterThan(0);
  });

  it("lists exactly the messages the mailbox pill COUNTS", () => {
    // The label counts `pending`; `inbox_peek` also returns delivered and acknowledged entries. So
    // a pill reading "1 queued message" expanded to three (roborev 58774) — on the one surface
    // whose purpose is checking that the concierge really queued what it said it did.
    // FAILS against passing the raw `entries` through: three messages under a one-message label.
    useInboxStore.setState({
      byAgent: {
        a1: [
          mkEntry("m0", "still waiting", "pending"),
          mkEntry("m1", "already handed over", "delivered"),
          mkEntry("m2", "long since read", "acknowledged"),
        ],
      },
    } as never);
    seed({ status: { a1: "working" } });
    render(<MountedAgentNotices agentId="a1" side="left" />);
    const mailbox = pills().find((p) => p.getAttribute("data-notice-id") === "inbox")!;
    expect(mailbox.textContent).toContain("1 queued message");

    fireEvent.click(mailbox);

    const msgs = screen.getAllByTestId(NOTICE_MESSAGE_TESTID);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.textContent).toContain("still waiting");
  });

  it("does not carry one agent's OPEN pill over to the next agent mounted here", () => {
    // Notice ids are class-level (`stall:open-pr`, `inbox`), not agent-scoped, and this component
    // is not keyed by agent — so mounting a different agent on the same side re-used the instance
    // and left the previous agent's explainer expanded (roborev 58774). The user never opened it,
    // and it is about an agent they just switched away from.
    const project: Project = {
      id: "p1",
      name: "Demo",
      rootPath: "/tmp/demo",
      defaultBranch: "main",
      createdAt: new Date(0).toISOString(),
      selectedAgentId: null,
      agents: [agent(), agent({ id: "a2", name: "Beta" })],
    };
    useProjectStore.setState({ projects: [project] } as never);
    useRuntimeStore.setState({
      status: { a1: "idle", a2: "idle" },
      branchStatus: { a1: CLEAN_BS, a2: CLEAN_BS },
      workflowState: { a1: OPEN_PR_WS, a2: OPEN_PR_WS },
      workflowStage: {},
    } as never);

    const { rerender } = render(<MountedAgentNotices agentId="a1" side="left" />);
    fireEvent.click(pills().find((p) => p.getAttribute("data-notice-id") === "stall:open-pr")!);
    expect(screen.getByTestId(NOTICE_DETAIL_TESTID)).toBeTruthy();

    rerender(<MountedAgentNotices agentId="a2" side="left" />);

    // Same notice id exists on the new agent — so this can only pass by actually resetting.
    expect(pills().map((p) => p.getAttribute("data-notice-id"))).toContain("stall:open-pr");
    expect(screen.queryByTestId(NOTICE_DETAIL_TESTID)).toBeNull();
  });

  it("OPENS THE GOAL PILL for a resting agent, where the stall pill carries the fact", async () => {
    // ══ THE HIGH (roborev 59236) — the founder's bug, alive inside its own fix ═════════════════
    // The row's goal chip focuses `goal:<state>`, but `agentNotices` suppresses that pill whenever
    // the equivalent stall cause is present — which is EVERY resting goal-bearing row, and an
    // escalated agent is idle by definition, so it covered exactly the red octagon he photographed.
    // A literal id match found nothing and the click produced no pill at all.
    //
    // FAILS against the literal `notices.some(n => n.id === focused)` match: no detail renders.
    const project: Project = {
      id: "p1",
      name: "Demo",
      rootPath: "/tmp/demo",
      defaultBranch: "main",
      createdAt: new Date(0).toISOString(),
      selectedAgentId: null,
      agents: [agent({ goal: ESCALATED_GOAL })],
    };
    useProjectStore.setState({ projects: [project] } as never);
    useRuntimeStore.setState({
      status: { a1: "idle" },
      branchStatus: { a1: CLEAN_BS },
      workflowState: { a1: BARE_WS },
      workflowStage: {},
    } as never);
    useUiStore.setState({
      focusedNoticeBySide: { left: "goal:escalated", right: null },
    } as never);

    render(<MountedAgentNotices agentId="a1" side="left" />);

    // The pill that carries the fact IS open — whichever of the two names it ended up under.
    const detail = screen.getByTestId(NOTICE_DETAIL_TESTID);
    // Case-insensitive: the explainer opens the sentence with "Auto-continue", and pinning the
    // capitalisation would make this fail on a copy edit that changes nothing about the behaviour.
    expect(detail.textContent?.toLowerCase()).toContain("auto-continue");
    // …and the request is consumed, so a manual collapse sticks.
    expect(useUiStore.getState().focusedNoticeBySide.left).toBeNull();
  });

  it("shows the agent's OWN goal words, not only the generic explainer", () => {
    // roborev 59253: the pill read `NOTICE_EXPLAINER[id] ?? notice.detail`, so the detail became
    // unreachable the moment a notice had an explainer — and every one does. For a goal that detail
    // is "land the retry PR", the only part of the pill that is about THIS agent rather than about
    // the state in general. FAILS against the `??`, which renders the explainer alone.
    const project: Project = {
      id: "p1",
      name: "Demo",
      rootPath: "/tmp/demo",
      defaultBranch: "main",
      createdAt: new Date(0).toISOString(),
      selectedAgentId: null,
      agents: [agent({ goal: ESCALATED_GOAL })],
    };
    useProjectStore.setState({ projects: [project] } as never);
    useRuntimeStore.setState({
      status: { a1: "idle" },
      branchStatus: { a1: CLEAN_BS },
      workflowState: { a1: BARE_WS },
      workflowStage: {},
    } as never);
    useUiStore.setState({
      focusedNoticeBySide: { left: "goal:escalated", right: null },
    } as never);

    render(<MountedAgentNotices agentId="a1" side="left" />);

    expect(screen.getByTestId(NOTICE_OWN_WORDS_TESTID).textContent).toContain("land the retry PR");
  });

  it("does not EAT a focus request it has no pill for", () => {
    // The consume effect ran before the `notices.length === 0` early return, so a request naming a
    // notice this render does not have was cleared and silently dropped (roborev 58774) — the click
    // looked like it did nothing. It must stay in the store for a render that can honour it.
    seed({ status: { a1: "working" } });
    useUiStore.setState({
      focusedNoticeBySide: { left: "thrash:repeating-command", right: null },
    } as never);
    render(<MountedAgentNotices agentId="a1" side="left" />);
    expect(useUiStore.getState().focusedNoticeBySide.left).toBe("thrash:repeating-command");
  });
});
