// @vitest-environment jsdom
//
// THE FOUNDER'S EXACT CASE: an ordinary, session-bound BUILD AGENT, mounted, whose terminal is
// visibly live — and whose concierge column said "No conversation with <name> yet."
//
// ══ THE MEASURED CAUSE ═════════════════════════════════════════════════════════════════════════
// Sparkle spawns each agent's `claude` with a per-account `CLAUDE_CONFIG_DIR` (Multi Claude Max),
// exported onto the CHILD only, so Claude writes the transcript under
// `<accountConfigDir>/projects/<slug>/<session>.jsonl`. The mounted READ never carried that
// directory: `useAgentTranscript`'s `configDir` was a parameter NO caller ever supplied, so
// `agent_transcript_page` went out with `configDir: null`, Rust fell back to
// `$HOME/.claude/projects/<slug>` — which does not exist for an account-spawned agent — and
// `own_session_files` returned zero entries AND a null tail anchor.
//
// Replayed against the founder's real disk: his failing agent IS session-bound, its only config dir
// is one account, and it had 0 reachable records before the fix and 480 after. Across his machine,
// 42 of 52 live worktrees with a transcript on disk read EMPTY and became readable.
//
// ══ WHY THIS SUITE EXISTS BESIDE THE HOOK'S OWN ════════════════════════════════════════════════
// The hook suite pins the invoke PAYLOAD; this one pins what the founder actually looks at. Nothing
// between the registry and the rendered turn is stubbed: the REAL cable store is patched exactly as
// `AgentRow` patches it, the REAL `projectStore` supplies the worktree, and the host's own
// `useAgentTranscript(mountedAgentId, mountedWorktreePath)` call — which needed NO change, because
// the config dir is now read from the registry rather than passed in — is the one under test.
//
// ══ HOW THESE ROWS AVOID BEING VACUOUS ═════════════════════════════════════════════════════════
// `invoke` answers the page ONLY for a read that named the account root; a read that named anything
// else gets the empty page + null tail Rust really produces. So a build that ignores the config dir
// renders MOUNTED_EMPTY_TESTID and every positive assertion below fails. Asserting "the column has
// content" would not do it — the empty state is content too.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  useHasAiCredits: vi.fn(() => true),
  aiEnhancementsEnabled: vi.fn(() => true),
  ConciergeAiDisabledError: class ConciergeAiDisabledError extends Error {},
  openProjectTab: vi.fn(),
  startConciergeTurn: vi.fn(async (_p: string): Promise<string | null> => null),
  dispatchConciergeAnswer: vi.fn(async () => ({ ok: true, path: "free-text" })),
  routeMessage: vi.fn(async () => ({
    target: "sparkle" as const,
    reason: "test",
    source: "heuristic" as const,
  })),
  viewport: vi.fn((_agentId: string) => CLEAN as null | { text: string; alternateBuffer: boolean }),
  /** The transcript fixture, swapped per row. Hoisted so the `invoke` mock can reach it. */
  invoke: vi.fn(),
}));

const CLEAN = { text: "> \n", alternateBuffer: false };

// ══ THE ONE MOCK THIS SUITE ADDS OVER ITS SIBLINGS ═════════════════════════════════════════════
// The unmocked `invoke` REJECTS under jsdom (it reads `window.__TAURI_INTERNALS__`), and every
// caller in this host is written against that. So the default here REJECTS too — same control flow,
// same catch blocks — and only the four transcript commands are answered. Resolving `undefined`
// wholesale is what `src/test-setup.ts` documents as having broken unrelated callers.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => h.invoke(...a),
}));
vi.mock("../services/openProjectTab", () => ({
  openProjectTab: h.openProjectTab,
  requestProjectTabFromOtherWindow: vi.fn(),
}));
vi.mock("../services/concierge", () => ({
  // The failure handler reads the failed turn's account via turnAccountFor(e.id); a mock that omits
  // it throws 'No turnAccountFor export' the moment an auth/quota failure reaches that branch. null =
  // 'turn not remembered', which the rotation degrades on.
  turnAccountFor: () => null,
  startConciergeTurn: h.startConciergeTurn,
  ConciergeAiDisabledError: h.ConciergeAiDisabledError,
  startProactiveConciergeTurn: vi.fn(async () => null),
  isProactiveTurn: () => false,
  onConciergeTool: () => () => {},
  onConciergeDelta: () => () => {},
  onConciergeDone: () => () => {},
  onConciergeError: () => () => {},
  onConciergeTurnsAbandoned: () => () => {},
  isSupersededDetail: () => false,
  SUPERSEDED_DETAILS: [],
}));
vi.mock("../services/conciergeDispatch", () => ({
  dispatchConciergeAnswer: h.dispatchConciergeAnswer,
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
vi.mock("../services/terminalViewport", () => ({
  getAgentViewport: (id: string) => h.viewport(id),
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
  useHasAiCredits: h.useHasAiCredits,
  aiEnhancementsEnabled: h.aiEnhancementsEnabled,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));

const RUNTIME = {
  status: { ag1: "working" },
  workflowShipped: {},
  workflowStage: {},
  workflowState: {},
  branchStatus: {},
};
vi.mock("../stores/runtimeStore", () => ({
  useRuntimeStore: Object.assign((sel: (s: typeof RUNTIME) => unknown) => sel(RUNTIME), {
    getState: () => RUNTIME,
  }),
  mergeOpenAgentIds: vi.fn((inMemory: string[], persisted: string[]) => [
    ...new Set([...inMemory, ...persisted]),
  ]),
  readPersistedOpenAgentIds: vi.fn((): string[] => []),
}));

import { ConciergeHost } from "./ConciergeHost";
import type { ConciergeFeed } from "../useConciergeFeed";
import { clearAllIntents } from "../services/dispatchIntent";
import { setConciergeChat } from "../stores/conciergeThreadStore";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";
import { useSettingsStore } from "../stores/settingsStore";
import { useProjectStore } from "../stores/projectStore";
import { useCableStore, resetCable } from "../stores/cableStore";
import { useUiStore } from "../stores/uiStore";
import { useMountedThreadStore } from "../stores/mountedThreadStore";
import { TAURI_UNAVAILABLE_IN_TEST } from "../services/tauriUnavailableSignature";
import {
  forgetAgentTranscriptPath,
  noteAgentConfigDir,
  noteAgentSessionId,
} from "../services/agentTranscriptRegistry";
import {
  MOUNTED_AGENT_TESTID,
  MOUNTED_EMPTY_TESTID,
  MOUNTED_HUMAN_TESTID,
} from "./Concierge/MountedAgentThread";

const AGENT = "ag1";
const AGENT_NAME = "Kraken Auth";
const WORKTREE = "/home/u/wt/ag-1";
/** The agent's ONLY account, as `accountSelection` hands it to the spawn. */
const ACCOUNT = "/home/u/Library/Application Support/ai.sparkle.desktop/accounts/c7c0d098f53f98d7";
const FILE = `${ACCOUNT}/projects/-home-u-wt-ag-1/sess-ag1.jsonl`;

/** Strings that exist ONLY in this agent's transcript. Their presence is what a working build gets
 *  and a broken one cannot fake — the empty state renders neither. */
const HIS_WORDS = "add a test for the retry path";
const ITS_WORDS = "Added retry.test.ts covering the 429 backoff";

function entry(kind: "human" | "agent", id: string, text: string, ts: string) {
  return {
    kind,
    id,
    text,
    timestamp: ts,
    sessionId: "sess-ag1",
    ...(kind === "human" ? { promptSource: "typed" } : {}),
    raw: "{}",
    cursor: { file: FILE, line: 0 },
  };
}

const TURNS = [
  entry("human", "h1", HIS_WORDS, "2026-08-20T14:02:00.000Z"),
  entry("agent", "g1", ITS_WORDS, "2026-08-20T14:02:40.000Z"),
];

/**
 * Rust's `session_dir` + `own_session_files`, faithfully enough for this question: the records live
 * under ONE account root, and a read that names any other root finds the directory absent and
 * answers an empty page with NO tail anchor — exactly what the founder's build did.
 *
 * Everything else rejects, which is what an unmocked `invoke` does under jsdom.
 */
function accountDisk(root: string | null) {
  h.invoke.mockImplementation(async (cmd: string, args?: unknown) => {
    const dir = (args as { configDir?: string | null } | undefined)?.configDir ?? null;
    if (cmd === "agent_transcript_page") {
      return dir === root
        ? {
            entries: TURNS,
            next: null,
            hasMore: false,
            sessionsScanned: 1,
            filesOpened: 1,
            tailFile: FILE,
            tailByte: 900,
          }
        : {
            entries: [],
            next: null,
            hasMore: false,
            sessionsScanned: 0,
            filesOpened: 0,
            tailFile: null,
            tailByte: 0,
          };
    }
    if (cmd === "agent_transcript_tail") {
      return dir === root
        ? { entries: [], file: FILE, nextByte: 900 }
        : { entries: [], file: null, nextByte: 0 };
    }
    // EVERY OTHER COMMAND FAILS EXACTLY AS AN UNMOCKED `invoke` DOES, message included. The host
    // pulls a dozen Tauri-backed things in as a side effect of mounting, each with its own catch and
    // its own log line; reusing the real signature keeps `test-setup.ts`'s console filter effective,
    // so this suite adds no console traffic to the worker→main RPC channel (bead sparkle-yzcjc).
    throw new TypeError(TAURI_UNAVAILABLE_IN_TEST);
  });
}

const COUNTS = { needs_you: 0, questions: 0, running: 1, done: 0 };
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
          id: AGENT,
          name: AGENT_NAME,
          projectId: "p1",
          projectName: "sparkle",
          kind: "build" as const,
          status: "working",
          statusColor: "#37b26c",
          statusLabel: "Working",
          band: "running" as const,
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

/** The REAL roster the mount resolves its name and worktree through. */
function seedRoster() {
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "sparkle",
        path: "/home/u/sparkle",
        agents: [{ id: AGENT, name: AGENT_NAME, worktreePath: WORKTREE }],
      },
    ] as unknown as ReturnType<typeof useProjectStore.getState>["projects"],
  });
}

/** THE MOUNTING GESTURE, spelled exactly as `AgentRow`/`AgentSidebar` spell it. */
function mountCableAt(agentId: string) {
  act(() => {
    useCableStore.getState().patch("left", agentId);
  });
}

beforeEach(() => {
  h.useHasAiCredits.mockReturnValue(true);
  h.aiEnhancementsEnabled.mockReturnValue(true);
  h.invoke.mockReset();
  h.viewport.mockReset();
  h.viewport.mockReturnValue(CLEAN);
  useSettingsStore.setState({ aiConcierge: true } as never);
  enableAiEnhancementsForTests();
  setConciergeChat(() => []);
  useMountedThreadStore.setState({ threads: {} });
  resetCable();
  useUiStore.setState({ activeSpecial: null } as never);
  localStorage.clear();
  forgetAgentTranscriptPath(AGENT);
  seedRoster();
});
afterEach(() => {
  clearAllIntents();
  cleanup();
  vi.clearAllMocks();
  useProjectStore.setState({ projects: [] });
  useMountedThreadStore.setState({ threads: {} });
  resetCable();
  forgetAgentTranscriptPath(AGENT);
  localStorage.clear();
  useUiStore.setState({ activeSpecial: null } as never);
});

describe("mounted build agent — its transcript lives under an ACCOUNT config dir", () => {
  // THE HEADLINE ROW. Everything is exactly as it is on the founder's machine: an ordinary build
  // agent, session-bound from its own hook stream, spawned under an account, mounted. On the broken
  // build this renders MOUNTED_EMPTY_TESTID reading "No conversation with Kraken Auth yet."
  it("renders its turns instead of `No conversation with <name> yet.`", async () => {
    noteAgentSessionId(AGENT, "sess-ag1");
    noteAgentConfigDir(AGENT, ACCOUNT);
    accountDisk(ACCOUNT);

    render(<ConciergeHost feed={FEED} promptTarget={null} />);
    mountCableAt(AGENT);

    // THE POSITIVE HALF — his words and the agent's, on the surface he is looking at.
    await waitFor(() => {
      expect(screen.getByTestId(MOUNTED_HUMAN_TESTID).textContent).toContain(HIS_WORDS);
    });
    expect(screen.getByTestId(MOUNTED_AGENT_TESTID).textContent).toContain(ITS_WORDS);
    // AND THE NEGATIVE — the exact element the founder screenshotted is gone. Without this, a build
    // that rendered the turns AND the empty notice would still pass.
    expect(screen.queryByTestId(MOUNTED_EMPTY_TESTID)).toBeNull();
    // The read named the account. Pinned here too, because "the turns are on screen" would also be
    // satisfied by a build that widened the read to every session file in the directory — which is
    // the wrong-attribution defect, not a fix.
    const call = h.invoke.mock.calls.find(([c]) => c === "agent_transcript_page");
    expect(call![1]).toMatchObject({
      worktreePath: WORKTREE,
      configDir: ACCOUNT,
      sessionIds: ["sess-ag1"],
    });
  });

  // THE PAIRED CONTROL. Identical in every respect except that no account is recorded, so the read
  // goes out with `configDir: null` and Rust's `$HOME/.claude` fallback is where the file is. This
  // is the state every pre-account agent is in, and the fix must not have made it worse.
  it("still reads an agent with no account override, through the default root", async () => {
    noteAgentSessionId(AGENT, "sess-ag1");
    accountDisk(null);

    render(<ConciergeHost feed={FEED} promptTarget={null} />);
    mountCableAt(AGENT);

    await waitFor(() => {
      expect(screen.getByTestId(MOUNTED_HUMAN_TESTID).textContent).toContain(HIS_WORDS);
    });
    expect(screen.queryByTestId(MOUNTED_EMPTY_TESTID)).toBeNull();
  });

  // ══ THE FAIL-CLOSED GATE, ON THE SURFACE IT PROTECTS ══════════════════════════════════════════
  //
  // THIS ROW MUST GO RED IF ANYONE EVER DELETES `useAgentTranscript`'s `if (!sessionIds)` GATE, or
  // widens the read to "every session file in the agent's worktree directory". Measured: one agent's
  // OWN worktree directory holds 136 session files, of which only 39 are attested by its agent-gated
  // hook log — 97 are FOREIGN. `services/hookWatcher`'s own header says why: the per-agent log is
  // keyed by worktree, so it accumulates every past `claude` run plus every background one-shot. So
  // neither the directory nor the raw hook log is agent-authoritative, and widening would render a
  // stranger's conversation under this agent's name — far worse than an empty pane, and the exact
  // bug commit c46aae5cd added the gate to fix.
  //
  // The account is registered here, so the ONLY thing missing is the session binding.
  it("renders the empty state and issues NO read for an agent whose sessions are unknown", async () => {
    noteAgentConfigDir(AGENT, ACCOUNT);
    accountDisk(ACCOUNT);

    render(<ConciergeHost feed={FEED} promptTarget={null} />);
    mountCableAt(AGENT);

    await waitFor(() => {
      expect(screen.getByTestId(MOUNTED_EMPTY_TESTID)).toBeTruthy();
    });
    expect(screen.getByTestId(MOUNTED_EMPTY_TESTID).textContent).toContain(
      `No conversation with ${AGENT_NAME} yet.`,
    );
    // ZERO IPC — an unidentified agent costs no reads at all, not a discarded result.
    expect(h.invoke.mock.calls.filter(([c]) => c === "agent_transcript_page")).toEqual([]);
    // …and the stranger's words never reach the DOM by any other route.
    expect(screen.queryByText(HIS_WORDS)).toBeNull();
    expect(screen.queryByText(ITS_WORDS)).toBeNull();
  });
});
