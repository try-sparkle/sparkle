// @vitest-environment jsdom
// THE BLOCKED PILL CLEARS ITSELF WHEN ITS AGENT RESUMES — nobody has to press the [x].
//
// THE REPORT (founder, 2026-08-05, bead sparkle-7ba9e, with a screenshot). The pill above the
// composer read "● BLOCKED: @<agent> in <project>" with a manual [x], about an agent that was
// working. His words: "If you are showing me the blocked issue but then I go take care of it in the
// terminal, then the blocked pill should go away once the agent starts moving again. I shouldn't
// need to clear it manually."
//
// WHY `ConciergeHost.retraction.test.tsx` DID NOT ALREADY COVER THIS, and why this is a second file
// rather than more cases in that one. That suite retracts a card by handing the column a feed whose
// STATUS has changed (waiting → working), and it passes — the card genuinely is derived. The bug is
// one layer beneath it: for an agent this window does not host, the status NEVER changes, because
// `components/AgentPane` is the only writer of `runtimeStore.status` and panes mount lazily per
// project (`Workspace.tsx`). So these cases hold the status FROZEN at its red — the real-world
// condition — and prove the pill clears anyway, on artifact evidence. A test that moved the status
// would be testing the other file's mechanism and would pass without this fix.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ dismissAlert: vi.fn() }));

vi.mock("../services/openProjectTab", () => ({
  openProjectTab: vi.fn(),
  requestProjectTabFromOtherWindow: vi.fn(),
}));
vi.mock("../services/concierge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/concierge")>();
  return {
    SUPERSEDED_DETAILS: real.SUPERSEDED_DETAILS,
    isSupersededDetail: real.isSupersededDetail,
    startConciergeTurn: vi.fn(async () => null),
    onConciergeTool: () => () => {},
    onConciergeDelta: () => () => {},
    onConciergeDone: () => () => {},
    onConciergeError: () => () => {},
    onConciergeTurnsAbandoned: () => () => {},
  };
});
vi.mock("../services/conciergeDispatch", () => ({
  dispatchConciergeAnswer: vi.fn(async () => ({ ok: true })),
  flushPendingSends: vi.fn(async () => []),
  agentCanAcceptInput: vi.fn(() => true),
  agentCanAcceptPrompt: vi.fn(() => true),
  liveOptionsFor: vi.fn(() => []),
  isTerseAnswer: vi.fn(() => false),
  matchAnswerToOption: vi.fn(() => null),
  onDeferredSendOutcome: () => () => {},
}));
vi.mock("../services/conciergeRouter", () => ({
  routeMessage: vi.fn(async () => ({
    target: "sparkle" as const,
    reason: "test",
    source: "heuristic" as const,
  })),
}));
vi.mock("./Concierge/ConciergeSuggestions", () => ({ ConciergeSuggestions: () => null }));
vi.mock("../useConciergeDictation", () => ({
  useConciergeDictation: () => ({ interim: "", toggleMic: vi.fn(), registerInsert: vi.fn() }),
}));

import { ConciergeHost } from "./ConciergeHost";
import { useUiStore } from "../stores/uiStore";
import { buildConciergeFeed } from "../services/conciergeFeed";
import { useProjectStore } from "../stores/projectStore";
import { NUDGE_CARD_TESTID } from "./Concierge/NudgeCard";
import { emptyLedger, type MovementEvidence, type RetractionLedger } from "../engine/movementRetraction";
import type { AgentTab, AgentTabStatus, Project } from "../types";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";

beforeEach(enableAiEnhancementsForTests);

const tab = (id: string, over: Partial<AgentTab> = {}): AgentTab =>
  ({
    id,
    name: id,
    kind: "build",
    parentId: null,
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "",
    promptHistory: [],
    namePinned: false,
    ...over,
  }) as AgentTab;

const projectOf = (id: string, name: string, agents: AgentTab[]): Project =>
  ({
    id,
    name,
    rootPath: `/${id}`,
    defaultBranch: "main",
    createdAt: "",
    agents,
    selectedAgentId: null,
  }) as Project;

const openIds = (projects: Project[]) => projects.flatMap((p) => p.agents.map((a) => a.id));

const T0 = 1_700_000_000_000;

/** One feed tick. `redSince` is the SAME ledger across calls — that is what makes a sequence of
 *  these a timeline rather than three unrelated renders. */
const tickAt = (
  projects: Project[],
  status: Record<string, AgentTabStatus>,
  nowMs: number,
  retraction: RetractionLedger,
  agentMovement: Record<string, MovementEvidence> = {},
) =>
  buildConciergeFeed({
    projects,
    status,
    openAgentIds: openIds(projects),
    nowMs,
    retraction,
    agentMovement,
  });

/** Which agent each pill on screen is ABOUT — read off the card's own data attribute rather than by
 *  matching prose, so these cases survive the card's copy being redesigned. */
const cardAgentIds = (): string[] =>
  screen.queryAllByTestId(NUDGE_CARD_TESTID).map((el) => el.getAttribute("data-agent-id")!);

/** The agent's own Claude Code session — the one its hook events carry. */
const MAIN = "sess-main";

const acted = (event: string, atMs: number, sessionId: string | null = MAIN): MovementEvidence => ({
  lastEvent: event,
  lastEventMs: atMs,
  sessionId,
});

beforeEach(() => {
  useUiStore.getState().showAllStatusBands();
  useUiStore.setState({ collapsedOrchestrators: {} });
  h.dismissAlert.mockClear();
  useProjectStore.setState({ dismissAlert: h.dismissAlert });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the BLOCKED pill retracts on evidence of movement, with no dismissal", () => {
  // THE FOUNDER'S CASE, END TO END. The status stays `blocked` throughout — it is frozen, exactly as
  // it is for an agent whose project has no mounted pane — and the pill still goes, because the
  // agent's own hook log shows it ran a tool after the block was raised.
  it("clears once the agent runs a tool after the block, without anyone pressing [x]", () => {
    const p = projectOf("p1", "drodio-website", [tab("publisher")]);
    const ledger = emptyLedger();
    const frozen: Record<string, AgentTabStatus> = { publisher: "blocked" };

    const { rerender } = render(
      <ConciergeHost
        feed={tickAt([p], frozen, T0, ledger, { publisher: acted("Notification", T0 - 1_000) })}
      />,
    );
    expect(cardAgentIds()).toEqual(["publisher"]);

    // The founder answers in the terminal; the agent picks up and runs a tool.
    rerender(
      <ConciergeHost
        feed={tickAt([p], frozen, T0 + 300_000, ledger, {
          publisher: acted("PostToolUse", T0 + 290_000),
        })}
      />,
    );

    expect(cardAgentIds()).toEqual([]);
    // THE POINT OF THE WHOLE BEAD: it went by itself. Nothing acknowledged it.
    expect(h.dismissAlert).not.toHaveBeenCalled();
  });

  // ── THE FULL SEQUENCE, WHICH IS WHERE A SNAPSHOT READ FAILS ─────────────────────────────────
  //
  // `fleet.rs` reports only the LAST hook event of any kind, so the work event that proves the agent
  // resumed is overwritten by the `Stop` that ends its turn. Reading the snapshot each tick brought
  // the pill BACK at that point — the reported bug restored a minute later, and permanently, since
  // the status is frozen. The evidence is accumulated as a high-water mark instead, and this walks
  // the founder's whole interaction to prove it.
  it("stays gone after the agent finishes its turn and Stop overwrites the work event", () => {
    const p = projectOf("p1", "drodio-website", [tab("publisher")]);
    const ledger = emptyLedger();
    const frozen: Record<string, AgentTabStatus> = { publisher: "blocked" };

    const { rerender } = render(
      <ConciergeHost
        feed={tickAt([p], frozen, T0, ledger, { publisher: acted("Notification", T0 - 1_000) })}
      />,
    );
    expect(cardAgentIds()).toEqual(["publisher"]);

    // He answers; the agent starts a turn.
    rerender(
      <ConciergeHost
        feed={tickAt([p], frozen, T0 + 10_000, ledger, {
          publisher: acted("UserPromptSubmit", T0 + 5_000),
        })}
      />,
    );
    expect(cardAgentIds()).toEqual([]);

    // It works for a while.
    rerender(
      <ConciergeHost
        feed={tickAt([p], frozen, T0 + 40_000, ledger, {
          publisher: acted("PostToolUse", T0 + 35_000),
        })}
      />,
    );
    expect(cardAgentIds()).toEqual([]);

    // The turn ends — `Stop` is now the last event, and there is no work event in the snapshot.
    rerender(
      <ConciergeHost
        feed={tickAt([p], frozen, T0 + 70_000, ledger, {
          publisher: acted("Stop", T0 + 65_000),
        })}
      />,
    );
    expect(cardAgentIds()).toEqual([]);

    // And a later tick where the agent is absent from the digest entirely — silence is not evidence
    // against what was already seen.
    rerender(<ConciergeHost feed={tickAt([p], frozen, T0 + 100_000, ledger)} />);
    expect(cardAgentIds()).toEqual([]);
    expect(h.dismissAlert).not.toHaveBeenCalled();
  });

  // His own gesture, named exactly: answering in the terminal IS a `UserPromptSubmit`.
  it("clears when the founder's own answer is the movement", () => {
    const p = projectOf("p1", "drodio-website", [tab("publisher")]);
    const ledger = emptyLedger();
    const frozen: Record<string, AgentTabStatus> = { publisher: "blocked" };

    const { rerender } = render(
      <ConciergeHost
        feed={tickAt([p], frozen, T0, ledger, { publisher: acted("Notification", T0 - 1_000) })}
      />,
    );
    expect(cardAgentIds()).toEqual(["publisher"]);

    rerender(
      <ConciergeHost
        feed={tickAt([p], frozen, T0 + 60_000, ledger, {
          publisher: acted("UserPromptSubmit", T0 + 50_000),
        })}
      />,
    );
    expect(cardAgentIds()).toEqual([]);
  });

  // ── THE REFUSALS. These matter more than the cases above. ────────────────────────────────────
  //
  // Retracting a pill that should have stood SILENCES A LIVE QUESTION, which is a worse failure than
  // the stale pill this fixes. Each of these is a way that could happen.

  // A blocked agent that has done nothing keeps its pill. The obvious case, stated so a future
  // change that retracts on freshness alone fails here.
  it("does NOT clear while the agent has no movement to show", () => {
    const p = projectOf("p1", "drodio-website", [tab("publisher")]);
    const ledger = emptyLedger();
    const frozen: Record<string, AgentTabStatus> = { publisher: "blocked" };

    const { rerender } = render(<ConciergeHost feed={tickAt([p], frozen, T0, ledger)} />);
    rerender(<ConciergeHost feed={tickAt([p], frozen, T0 + 600_000, ledger)} />);
    expect(cardAgentIds()).toEqual(["publisher"]);
  });

  // THE ONE THAT WOULD HAVE BROKEN THE APP. An agent that asks a question has just been running, so
  // its last tool call is only seconds old. A retraction keyed on "moved recently" would read that
  // as movement and silence a real ask. Ordering against the RAISE is what saves it.
  it("does NOT clear on the tool call the agent made just BEFORE it went red", () => {
    const p = projectOf("p1", "sparkle-desktop", [tab("asker")]);
    const ledger = emptyLedger();
    const asking: Record<string, AgentTabStatus> = { asker: "waiting" };

    const { rerender } = render(
      <ConciergeHost
        feed={tickAt([p], asking, T0, ledger, { asker: acted("PostToolUse", T0 - 2_000) })}
      />,
    );
    expect(cardAgentIds()).toEqual(["asker"]);

    rerender(
      <ConciergeHost
        feed={tickAt([p], asking, T0 + 30_000, ledger, {
          asker: acted("PostToolUse", T0 - 2_000),
        })}
      />,
    );
    expect(cardAgentIds()).toEqual(["asker"]);
  });

  // Claude fires a `Notification` idle ping roughly a minute into any unanswered wait. It is the
  // sound of the question NOT being answered, so it must never read as the agent moving past it —
  // otherwise every genuine ask would erase itself on a timer.
  it("does NOT clear on the idle Notification ping of an unanswered question", () => {
    const p = projectOf("p1", "sparkle-desktop", [tab("asker")]);
    const ledger = emptyLedger();
    const asking: Record<string, AgentTabStatus> = { asker: "waiting" };

    const { rerender } = render(<ConciergeHost feed={tickAt([p], asking, T0, ledger)} />);
    expect(cardAgentIds()).toEqual(["asker"]);

    rerender(
      <ConciergeHost
        feed={tickAt([p], asking, T0 + 65_000, ledger, {
          asker: acted("Notification", T0 + 60_000),
        })}
      />,
    );
    expect(cardAgentIds()).toEqual(["asker"]);
  });

  // A red that recurs must be able to raise itself again: the second block is a NEW episode, and the
  // movement that ended the FIRST one must not retract it on sight. Without the ledger dropping the
  // epoch when the agent leaves red, this agent could never be reported blocked again.
  it("raises a SECOND block even though older movement is still on record", () => {
    const p = projectOf("p1", "drodio-website", [tab("publisher")]);
    const ledger = emptyLedger();
    const moved = { publisher: acted("PostToolUse", T0 + 10_000) };

    // Blocked, then cleared by the movement at T0+10s.
    const { rerender } = render(
      <ConciergeHost
        feed={tickAt([p], { publisher: "blocked" }, T0, ledger, {
          publisher: acted("Notification", T0 - 1_000),
        })}
      />,
    );
    rerender(
      <ConciergeHost feed={tickAt([p], { publisher: "blocked" }, T0 + 20_000, ledger, moved)} />,
    );
    expect(cardAgentIds()).toEqual([]);

    // The agent genuinely works, then blocks again — with no NEWER movement than before.
    rerender(
      <ConciergeHost feed={tickAt([p], { publisher: "working" }, T0 + 30_000, ledger, moved)} />,
    );
    rerender(
      <ConciergeHost feed={tickAt([p], { publisher: "blocked" }, T0 + 40_000, ledger, moved)} />,
    );
    expect(cardAgentIds()).toEqual(["publisher"]);
  });

  // ── THE PROBE'S CASE: THE PILL MUST NOT GO OUT ON THE EVENT THAT RAISED IT ──────────────────
  //
  // `hookEvents` maps an `AskUserQuestion` PreToolUse to `waiting` and an `ExitPlanMode` one to
  // `approval` — those tools fire their PreToolUse and then Claude SITS THERE, with no Stop and no
  // Notification to follow. `fleet.rs` reduces a tick to the LAST event only and carries no tool
  // name for it, so a burst of tool calls that ends on a picker arrives here as one bare
  // `PreToolUse` — and counting that as movement retracted the pill at the exact moment the agent
  // was waiting on the human. The whole feature inverted, silently, in its worst case.
  it("does NOT clear on the AskUserQuestion PreToolUse that IS the block", () => {
    const p = projectOf("p1", "sparkle-desktop", [tab("asker")]);
    const ledger = emptyLedger();
    const asking: Record<string, AgentTabStatus> = { asker: "waiting" };

    const { rerender } = render(
      <ConciergeHost
        feed={tickAt([p], asking, T0, ledger, { asker: acted("Notification", T0 - 1_000) })}
      />,
    );
    expect(cardAgentIds()).toEqual(["asker"]);

    // The agent worked between ticks and ended on a picker. All this window is handed is the
    // PreToolUse — which is the agent asking, not the agent moving on.
    rerender(
      <ConciergeHost
        feed={tickAt([p], asking, T0 + 10_000, ledger, {
          asker: acted("PreToolUse", T0 + 8_000),
        })}
      />,
    );

    expect(cardAgentIds()).toEqual(["asker"]);
    expect(h.dismissAlert).not.toHaveBeenCalled();
  });

  // THE OTHER HALF OF THE SAME BYPASS. The hook log is keyed by WORKTREE, so every background
  // one-shot `claude` run there writes its own SessionStart→…→SessionEnd into the same file — which
  // is why `hookEvents.HookStatusEngine` carries a session lock at all. Its `PostToolUse` is
  // indistinguishable from the agent's own by NAME, and believing it retracts a red on work this
  // agent never did.
  it("does NOT clear on a background one-shot's tool call in the same worktree", () => {
    const p = projectOf("p1", "sparkle-desktop", [tab("asker")]);
    const ledger = emptyLedger();
    const asking: Record<string, AgentTabStatus> = { asker: "waiting" };

    const { rerender } = render(
      <ConciergeHost
        feed={tickAt([p], asking, T0, ledger, { asker: acted("Notification", T0 - 1_000) })}
      />,
    );
    expect(cardAgentIds()).toEqual(["asker"]);

    rerender(
      <ConciergeHost
        feed={tickAt([p], asking, T0 + 10_000, ledger, {
          asker: acted("PostToolUse", T0 + 8_000, "sess-oneshot"),
        })}
      />,
    );

    expect(cardAgentIds()).toEqual(["asker"]);
    expect(h.dismissAlert).not.toHaveBeenCalled();

    // And the agent's OWN work still clears it — the gate scopes the evidence, it does not disable
    // the feature. Without this the case above would pass just as well against a broken retraction.
    rerender(
      <ConciergeHost
        feed={tickAt([p], asking, T0 + 20_000, ledger, {
          asker: acted("PostToolUse", T0 + 18_000),
        })}
      />,
    );
    expect(cardAgentIds()).toEqual([]);
  });

  // A red whose beginning was never observed is not retractable on a guess — evidence, not
  // inference, the same default agentStall and fleetVerdict take.
  it("does NOT clear a red it never saw begin", () => {
    const p = projectOf("p1", "drodio-website", [tab("publisher")]);
    render(
      <ConciergeHost
        feed={buildConciergeFeed({
          projects: [p],
          status: { publisher: "blocked" },
          openAgentIds: openIds([p]),
          agentMovement: { publisher: acted("PostToolUse", T0 + 10_000) },
          // no retraction ledger at all — nothing knows when this red started
        })}
      />,
    );
    expect(cardAgentIds()).toEqual(["publisher"]);
  });
});
