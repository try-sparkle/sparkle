// @vitest-environment jsdom
//
// A LINT MARK REACHES A MOUNTED COLUMN, WHICH HAS NO THREAD ROW TO PUT IT IN.
//
// ══ THE HOLE THIS COVERS ════════════════════════════════════════════════════════════════════════
// Display-mounted, `ConciergeColumn` renders `MountedAgentThread` and does NOT render
// `ConciergeThread` at all — that is roborev 57360, and `Concierge/MountedNotice` is the compensation
// the codebase already reached for. The lint mark lives INSIDE a thread row, so it inherits the
// problem by construction: a finding written while the founder is patched into a terminal goes to a
// component that is off screen. Handled the same way the existing code handles it, rather than with a
// second mechanism.
//
// ══ WHY THIS IS ITS OWN FILE ════════════════════════════════════════════════════════════════════
// `useEffectiveWired` is mocked at MODULE scope, so a cable mocked "on" here would mount the column
// for every row in whatever file it sits in — and `ConciergeHost.lint.test.tsx`'s rows all assert on
// the visible thread, which is exactly what a mount takes away. Two states, two files.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  startConciergeTurn: vi.fn(async (_p: string): Promise<string | null> => null),
  routeMessage: vi.fn(async () => ({
    target: "sparkle" as "sparkle" | "agent",
    reason: "test",
    source: "heuristic" as const,
  })),
  runReplyLint: vi.fn((input: { text: string }) => ({
    text: input.text,
    violations: [] as unknown[],
    blocked: false,
  })),
  /** Which side the cable is patched to. "off" = the concierge floats free (unmounted). */
  wired: vi.fn(() => "left" as "off" | "left" | "right"),
  brain: {} as {
    delta?: (e: { id: string; text: string }) => void;
    done?: (e: { id: string; sessionId: string; text: string; toolCalls?: unknown[] }) => void;
  },
}));

vi.mock("../services/openProjectTab", () => ({
  openProjectTab: vi.fn(),
  requestProjectTabFromOtherWindow: vi.fn(),
}));
vi.mock("../services/concierge", () => ({
  startConciergeTurn: h.startConciergeTurn,
  startProactiveConciergeTurn: vi.fn(async () => null),
  isProactiveTurn: () => false,
  onConciergeDelta: (cb: NonNullable<typeof h.brain.delta>) => {
    h.brain.delta = cb;
    return () => {};
  },
  onConciergeDone: (cb: NonNullable<typeof h.brain.done>) => {
    h.brain.done = cb;
    return () => {};
  },
  onConciergeError: () => () => {},
  // The live per-tool status channel — see ConciergeHost.receipts.test.tsx. This mock is total, so
  // an unstubbed subscriber throws at import and takes the whole file with it.
  onConciergeTool: () => () => {},
  onConciergeTurnsAbandoned: () => () => {},
  isSupersededDetail: () => false,
  SUPERSEDED_DETAILS: [],
}));
// Spread the real module, replace one export — the host imports `toLintToolCalls`,
// `reportLintOutcome` and `buildLintCorrectionPrompt` from here too, and a mock that omits them
// leaves each `undefined` at a call site whose try/catch turns the crash into a warning.
vi.mock("../services/conciergeLintRunner", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/conciergeLintRunner")>();
  return { ...real, runReplyLint: h.runReplyLint };
});
vi.mock("../services/conciergeDispatch", () => ({
  dispatchConciergeAnswer: vi.fn(async () => ({ ok: true, path: "free-text" })),
  flushPendingSends: vi.fn(async () => []),
  agentCanAcceptInput: () => true,
  agentCanAcceptPrompt: () => true,
  liveOptionsFor: () => [],
  isTerseAnswer: () => false,
  matchAnswerToOption: () => null,
  answersLivePicker: () => false,
  onDeferredSendOutcome: () => () => {},
}));
vi.mock("../services/conciergeRouter", () => ({ routeMessage: h.routeMessage }));
// THE MOUNT, as one knob — the same seam ConciergeHost.mounted.test.tsx drives, for the same reason:
// `useEffectiveWired` is the host's only reader of the cable.
vi.mock("../hooks/useEffectiveWired", () => ({
  useEffectiveWired: () => h.wired(),
  usePairIsLive: () => false,
}));
vi.mock("../services/terminalViewport", () => ({
  getAgentViewport: () => ({ text: "> \n", alternateBuffer: false }),
  registerViewport: () => () => {},
  resetViewportRegistry: () => {},
}));
vi.mock("../stores/sparklePrefsStore", () => ({
  useSparklePrefsStore: {
    getState: () => ({ setInterruptPreference: vi.fn(), shouldInterrupt: () => true }),
  },
}));
vi.mock("../useConciergeDictation", () => ({
  useConciergeDictation: () => ({ interim: "", toggleMic: vi.fn(), registerInsert: vi.fn() }),
}));
vi.mock("./Concierge/ConciergeSuggestions", () => ({ ConciergeSuggestions: () => null }));
vi.mock("../services/aiGate", () => ({
  useAiFeature: () => true,
  aiFeatureNow: () => false,
  useHasAiCredits: () => true,
  aiEnhancementsEnabled: () => true,
}));

const RUNTIME = {
  status: { ag1: "idle" },
  workflowShipped: {},
  workflowStage: {},
  workflowState: {},
  branchStatus: {},
};
vi.mock("../stores/runtimeStore", () => ({
  useRuntimeStore: Object.assign((sel: (s: typeof RUNTIME) => unknown) => sel(RUNTIME), {
    getState: () => RUNTIME,
  }),
}));

import { ConciergeHost, type ConciergePromptTarget } from "./ConciergeHost";
import type { ConciergeFeed } from "../useConciergeFeed";
import { useProjectStore } from "../stores/projectStore";
import { useConciergeThreadStore } from "../stores/conciergeThreadStore";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";
import { MOUNTED_NOTICE_TESTID } from "./Concierge/MountedNotice";
import { CONCIERGE_THREAD_TESTID } from "../engine/composeBoxHeight";

const COUNTS = { needs_you: 0, running: 0, done: 1 };
const FEED = {
  projects: [
    {
      id: "p1",
      name: "sparkle",
      inScope: true,
      counts: COUNTS,
      scopedCounts: COUNTS,
      agents: [
        {
          id: "ag1",
          name: "Blueprint UI/UX",
          projectId: "p1",
          projectName: "sparkle",
          kind: "build" as const,
          status: "idle",
          statusColor: "#e0533f",
          statusLabel: "Idle",
          band: "done" as const,
          inScope: true,
          muted: false,
          topLevel: true,
        },
      ],
    },
  ],
  counts: COUNTS,
  scopedCounts: COUNTS,
  pinnedProjectId: null,
} as unknown as ConciergeFeed;

const MOUNTED: ConciergePromptTarget = { projectId: "p1", agentId: "ag1", name: "Blueprint UI/UX" };

/** `mountedAgent` needs BOTH a patched cable and a roster row for that agent — the host looks the row
 *  up for the worktree path its transcript is keyed by. Mocking only the cable leaves the column
 *  UNMOUNTED and every assertion here would be evidence about the wrong rendering (roborev 57360). */
function seedMountedRow() {
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "sparkle",
        path: "/tmp/sparkle",
        agents: [{ id: "ag1", name: "Blueprint UI/UX", worktreePath: "/tmp/wt/ag1" }],
      },
    ] as unknown as ReturnType<typeof useProjectStore.getState>["projects"],
  });
}

const PROMISE = "Say go and I'll spawn the worker.";

beforeEach(() => {
  useConciergeThreadStore.setState({ chat: [] });
  enableAiEnhancementsForTests();
  seedMountedRow();
  h.wired.mockReturnValue("left");
  h.runReplyLint.mockImplementation((input) => ({ text: input.text, violations: [], blocked: false }));
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Drive one complete turn against a column in whatever cable state the row set up. */
async function turn(violations: string[]) {
  h.runReplyLint.mockImplementation((input) => ({
    text: input.text,
    violations: violations.map((check) => ({ check, severity: "warn", detail: "offered to act", span: 9, action: "warned" })),
    blocked: false,
  }));
  render(<ConciergeHost feed={FEED} promptTarget={MOUNTED} />);
  await flush();
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "spawn a worker" } });
  fireEvent.click(screen.getByText("Send"));
  await flush();
  await act(async () => {
    h.brain.done?.({ id: "1", sessionId: "s", text: PROMISE, toolCalls: [] });
  });
  await flush();
}

describe("a lint finding is not swallowed by a mounted column", () => {
  it("the column really IS mounted — the precondition, asserted", async () => {
    // Without this the rows below could pass against an unmounted column, where the notice row is
    // the wrong surface entirely. The tell is that `ConciergeThread` is not rendered at all.
    await turn([]);
    expect(screen.queryByTestId(CONCIERGE_THREAD_TESTID)).toBeNull();
  });

  it("says what the linter caught, in the same words the inline mark uses", async () => {
    await turn(["ask-without-action"]);
    await waitFor(() => expect(screen.getByTestId(MOUNTED_NOTICE_TESTID)).toBeTruthy());
    expect(screen.getByTestId(MOUNTED_NOTICE_TESTID).textContent).toContain("Said it would do it");
  });

  it("says NOTHING when the turn was clean — the positive control", async () => {
    // A notice on every finished turn would make the mounted column unusable, and would drown the
    // one thing this row must stay loud for: a terminal refusal.
    await turn([]);
    expect(screen.queryByTestId(MOUNTED_NOTICE_TESTID)).toBeNull();
  });

  it("does NOT raise a notice when the column is unmounted and the thread is visible", async () => {
    // The mirror-image failure the display-mount gate exists for: a banner painted over a column
    // whose thread already carries the mark, saying the same thing twice — and it could not clear,
    // because the clearing effect keys on a mount that never happened.
    h.wired.mockReturnValue("off");
    await turn(["ask-without-action"]);
    expect(screen.getByTestId(CONCIERGE_THREAD_TESTID)).toBeTruthy();
    expect(screen.queryByTestId(MOUNTED_NOTICE_TESTID)).toBeNull();
  });
});
