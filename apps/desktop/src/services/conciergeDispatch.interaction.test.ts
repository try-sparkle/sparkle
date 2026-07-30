// @vitest-environment jsdom
//
// A DELIVERED USER PROMPT RESETS THAT AGENT'S ELAPSED TIMER — including for an agent with no project.
//
// The sidebar's "running without my interaction" timer reads
// `max(promptHistory.at, interactionStore.lastAt[id])`. A project agent's prompt resets it for free
// via `appendPrompt`. IMPROVE SPARKLE has no AgentTab and belongs to no project, so every side effect
// past the project lookup in `recordPromptSideEffects` is skipped for it — and its own pane-local
// composer used to call `touch()` itself for exactly that reason (roborev 54812).
//
// That composer is gone: Improve Sparkle now mounts the concierge like every other build agent, so
// this module is the only place a prompt to it passes through. Without the touch, the timer climbs
// while the user is actively prompting the agent — the reported bug, relocated by the fix that
// removed the box, which is the AGENTS.md failure this file exists to prevent.
//
// The no-project case is the load-bearing one; it is asserted through the REAL dispatch path (a
// delivered prompt), never by calling `touch` here.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SuggestionButton } from "./suggestions/types";

vi.mock("../pty", () => {
  class PtyGoneError extends Error {}
  return {
    writePtyChainedStrict: vi.fn(async () => {}),
    submitPrompt: vi.fn(async () => {}),
    PtyGoneError,
  };
});
vi.mock("./terminalScrollback", () => ({ getAgentScrollback: vi.fn(() => "SCREEN") }));
vi.mock("./suggestions/heuristics", () => ({
  detectTerminalPrompts: vi.fn(() => [] as SuggestionButton[]),
}));
vi.mock("./agentNaming", () => ({ maybeAutoName: vi.fn() }));
vi.mock("./trialMeter", () => ({
  recordTrialSend: vi.fn(async () => {}),
  trialSendAllowed: vi.fn(() => true),
}));
vi.mock("./aiGate", () => ({ aiFeatureNow: vi.fn(() => false) }));

import { dispatchConciergeAnswer } from "./conciergeDispatch";
import { resetPromptMarkers } from "./terminalMarkers";
import { resetPendingSends } from "./pendingSends";
import { resetPaneReadiness } from "./paneReadiness";
import { useInteractionStore } from "../stores/interactionStore";
import { useProjectStore } from "../stores/projectStore";
import { usePromptHistoryStore } from "../stores/promptHistoryStore";
import type { AgentTab, Project } from "../types";

/** See the note in conciergeDispatch.sideEffects.test.ts — these suites exercise DELIVERY, not the
 *  authorization gate, but `authority` is required and non-defaulted. */
const TEST_AUTHORITY = { kind: "suggestion", agentId: "a1" } as const;

/** The id the Improve Sparkle row and pane share. It is deliberately NOT a project agent. */
const SPARKLE_ID = "__sparkle_self__";

function mkAgent(id: string): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}
const project: Project = {
  id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: null,
  createdAt: new Date(0).toISOString(), selectedAgentId: null, agents: [mkAgent("a1")],
};

beforeEach(() => {
  vi.clearAllMocks();
  resetPromptMarkers();
  resetPendingSends();
  resetPaneReadiness();
  usePromptHistoryStore.setState({ history: [] });
  useInteractionStore.setState({ lastAt: {} } as never);
  useProjectStore.setState({
    projects: [structuredClone(project)],
    selectedProjectId: "p1",
  } as never);
});

describe("dispatchConciergeAnswer — the elapsed timer", () => {
  it("records nothing before a prompt is delivered", () => {
    expect(useInteractionStore.getState().lastAt).toEqual({});
  });

  it("touches an agent that belongs to NO project — the Improve Sparkle case", async () => {
    // The project lookup in recordPromptSideEffects returns early for this id, so anything recorded
    // after it is unreachable. This is the assertion the removed pane composer used to own.
    const res = await dispatchConciergeAnswer(SPARKLE_ID, "review last hour's logs", {
      authority: TEST_AUTHORITY,
      userPrompt: true,
    });

    expect(res.ok).toBe(true);
    expect(useInteractionStore.getState().lastAt[SPARKLE_ID]).toBeTypeOf("number");
  });

  it("records it under the id the row reads, not some other key", async () => {
    // `touch(someOtherId)` would still write to the store and still look like a pass. The sidebar
    // row looks up exactly ONE key.
    await dispatchConciergeAnswer(SPARKLE_ID, "review last hour's logs", {
      authority: TEST_AUTHORITY,
      userPrompt: true,
    });

    expect(Object.keys(useInteractionStore.getState().lastAt)).toEqual([SPARKLE_ID]);
  });

  it("touches a project agent too", async () => {
    // Redundant there (appendPrompt already resets the timer, which takes the max of the two) but it
    // must not be conditional on the project lookup — that conditionality is the bug.
    await dispatchConciergeAnswer("a1", "ship the docs pass", {
      authority: TEST_AUTHORITY,
      userPrompt: true,
    });

    expect(useInteractionStore.getState().lastAt["a1"]).toBeTypeOf("number");
  });

  it("does NOT count a machine-authored relay as the user interacting", async () => {
    // The nudge card's "approve" fallback. The timer answers "how long has this been running without
    // ME?", so a relay Sparkle sent on its own must not answer it — same `userPrompt` scope as the
    // trial debit and the naming pass.
    await dispatchConciergeAnswer(SPARKLE_ID, "approve", { authority: TEST_AUTHORITY });

    expect(useInteractionStore.getState().lastAt[SPARKLE_ID]).toBeUndefined();
  });
});
