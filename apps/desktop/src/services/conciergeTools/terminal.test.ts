// The concierge's TERMINAL domain: reading what an agent's terminal says, and typing into it.
//
// Two properties are worth having tests for, and neither is "the happy path works".
//
// READ — the fallback CHAIN, in order, with the source LABELLED. The primary source
// (`getAgentScrollback`) returns null whenever the agent's pane isn't mounted, which on a real
// fleet is most agents most of the time; a read that answered "null" there would make the concierge
// blind to exactly the agents the user isn't already looking at. So the interesting assertions are
// the ones where tier (a) is unavailable and a LATER tier still produces content — plus the label,
// because a screen captured when the agent went red and a snippet out of the FTS store are not
// equally fresh, and a caller that can't tell them apart will misreport a stale screen as "right now".
//
// WRITE — what it REFUSES. The write path is a thin delegation to `dispatchConciergeAnswer` (which
// owns live-picker reclassification, CR framing, trial metering, queueing and the refusal taxonomy),
// so there is little of its own behaviour to test. What is genuinely this module's is the gate: an
// unresolved policy must not produce a write, an agent that can't take input must not produce a
// write, and a cloud agent must come back with the EXISTING honest refusal rather than a new lie.
// Those assertions all check that nothing reached the PTY, not merely that `ok` was false.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The write primitives — mocked so "did this reach the PTY?" is directly observable. Every refusal
// test below asserts against these, because `ok: false` alone would still pass if the text had gone
// out and the result were mislabelled afterwards.
vi.mock("../../pty", () => ({
  writePtyChainedStrict: vi.fn(async () => {}),
  submitPrompt: vi.fn(async () => {}),
  PtyGoneError: class extends Error {},
}));
vi.mock("../terminalScrollback", async (orig) => ({
  ...(await orig<typeof import("../terminalScrollback")>()),
  getAgentScrollback: vi.fn<(id: string) => string | null>(() => null),
}));
// ── THE H2 SEAM (bead sparkle-w11lll) ─────────────────────────────────────────────────────────
// REAL BY DEFAULT — the factory wraps the shipping functions rather than replacing them, so every
// other case in this file, and the dispatcher's own use of them, runs the production predicates.
// The `quit_alternate_screen` H2 regression cases override them for one assertion each: the whole
// question that test asks is "what happens when Claude Code recognition is WRONG", and the only
// honest way to ask it is to make it wrong.
vi.mock("../../engine/claudeCodeScreen", async (orig) => {
  const real = await orig<typeof import("../../engine/claudeCodeScreen")>();
  return {
    ...real,
    isClaudeCodeScreen: vi.fn(real.isClaudeCodeScreen),
    hasClaudeCodeLiveTui: vi.fn(real.hasClaudeCodeLiveTui),
  };
});
vi.mock("../trialMeter", () => ({ trialSendAllowed: () => true, recordTrialSend: vi.fn() }));
vi.mock("../history", () => ({ searchHistory: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "") }));
// The attention screen lives on the runtime store, whose real module drags in beads/chief/branch
// polling. Only one field matters here.
// `getAgentStatus` also builds the open-pane set the way `handleGetState` does (in-memory merged
// with the persisted copy), so the two liveness answers cannot diverge — both helpers are stubbed
// here rather than left undefined.
vi.mock("../../stores/runtimeStore", () => ({
  useRuntimeStore: { getState: vi.fn(() => ({ attentionScreen: {},
    attentionScreenAt: {}, status: {} })) },
  mergeOpenAgentIds: (inMemory: string[], persisted: string[]) => [
    ...new Set([...inMemory, ...persisted]),
  ],
  readPersistedOpenAgentIds: vi.fn((): string[] => []),
}));

import { invoke } from "@tauri-apps/api/core";
import { PtyGoneError, submitPrompt, writePtyChainedStrict } from "../../pty";
import { searchHistory } from "../history";
import { useRuntimeStore, readPersistedOpenAgentIds } from "../../stores/runtimeStore";
import { getAgentScrollback } from "../terminalScrollback";
import { FOOTER_ONLY_SCREEN } from "../../engine/incidentScreens.fixture";
import { isClaudeCodeScreen, hasClaudeCodeLiveTui } from "../../engine/claudeCodeScreen";
import {
  APPROVAL_2_1_220,
  IDLE_AFTER_TURN_2_1_220,
  LESS_ON_A_MARKDOWN_FILE,
  VIM_ON_A_MARKDOWN_FILE,
} from "../../engine/capturedScreens.fixture";
import {
  BASH_PERMISSION_PROMPT,
  PLAN_EXIT_PROMPT,
  PLAN_EXIT_PROMPT_OLD_SHAPE,
} from "../suggestions/planPrompt.fixture";
// The REAL viewport registry, not a mock of it: `quitAlternateScreen` and `dispatchConciergeAnswer`
// both read screens through it, and the complement invariant below is only worth anything if the two
// are looking at the same thing by the same route.
import { registerViewport, resetViewportRegistry } from "../terminalViewport";
// THE REAL PREDICATES, kept so the H2 cases can put them BACK. `vi.clearAllMocks()` in this file's
// top-level `beforeEach` resets call history but KEEPS any implementation a case installed — the
// leak its own comment warns about two mocks up. Without this, the first case that forces Claude
// Code recognition to `false` would leave every later case blind to Claude Code, and the gate-2 test
// would fail pointing nowhere near its cause. (It did, exactly once, before this line existed.)
const REAL_SCREEN =
  await vi.importActual<typeof import("../../engine/claudeCodeScreen")>(
    "../../engine/claudeCodeScreen",
  );
import type { PickerOptionsRead } from "./terminal";
import {
  CONTROL_KEYS,
  CONTROL_KEY_NAMES,
  readPickerOptions,
  selectPickerOption,
  sendControlKey,
} from "./terminal";
import { useProjectStore } from "../../stores/projectStore";
import { useInteractionStore } from "../../stores/interactionStore";
import { NEW_AGENT_GRACE_MS } from "../../engine/newAgentAttention";
// The thrash accumulator is module-level and window-local: fed here so a case can distinguish "no
// hook events seen" (no reading at all) from a real repeating-command verdict.
import { noteThrashEvent, resetThrashTracking } from "../../engine/agentThrash";
import { SPARKLE_AGENT_ID } from "../sparkleAgent";
// THE REAL LATCH, not a mock of it: `improvementPassLatch` is a leaf with `claimPass`/`releasePass`,
// so the pass branch of the Improve-Sparkle write gate is driven through services/sparkleBusy end to
// end rather than by standing in the rule under test.
import { claimPass, releasePass } from "../improvementPassLatch";
import {
  conciergeToolAuthority,
  type ConciergeToolAuthority,
} from "../dispatchAuthority";
import {
  CONCIERGE_TERMINAL_TOOLS,
  HISTORY_MAX_FETCH,
  HISTORY_MAX_HITS,
  TERMINAL_READ_MAX_CHARS,
  TERMINAL_READ_MAX_LINES,
  forgetAgentTranscriptPath,
  getAgentStatus,
  noteAgentSessionId,
  noteAgentTranscriptPath,
  noteAgentTranscriptWorktree,
  readAgentTerminal,
  quitAlternateScreen,
  sendToAgentTerminal,
  type AgentTerminalRead,
  type ReadAgentTerminalOptions,
} from "./terminal";
// Writer (4) from the LEAF registry, not through the re-export above: `conciergeTools/terminal` only
// READS a config dir, and that block's own rule is "only the names that have an importer here".
import { noteAgentConfigDir } from "../agentTranscriptRegistry";

const AGENT = "ag-1";
const scrollbackMock = vi.mocked(getAgentScrollback);
const searchHistoryMock = vi.mocked(searchHistory);
const invokeMock = vi.mocked(invoke);
const runtimeStateMock = vi.mocked(useRuntimeStore.getState);

/** Did tier (d) actually run? `invoke` is shared with the logger's `frontend_log` forwarding, so a
 *  bare not-toHaveBeenCalled would fail on an unrelated debug line rather than on a real read. */
const transcriptReads = () =>
  invokeMock.mock.calls.filter(([cmd]) => cmd === "read_transcript_last_assistant");

/** Seed the project store with one agent. The write path's predicates read the REAL store — this
 *  suite deliberately does not mock `conciergeDispatch`, so `agentCanAcceptInput` and the
 *  `cloud-agent` refusal are the shipping ones rather than a restatement of them. */
function seedAgent(runtime: "local" | "cloud" = "local", status?: string) {
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "sparkle",
        path: "/tmp/p1",
        agents: [{ id: AGENT, name: "Retry logic", runtime } as never],
      } as never,
    ],
  });
  runtimeStateMock.mockReturnValue({
    attentionScreen: {},
    attentionScreenAt: {},
    status: status ? { [AGENT]: status } : {},
  } as never);
}

/**
 * A JUST-SPAWNED agent: it carries a `createdAt` stamp and, unless `over` says otherwise, no brief
 * of any kind. `seedAgent` above deliberately does NOT set `createdAt` — that models a legacy
 * persisted row, whose behaviour must not change — so the two helpers are kept separate rather than
 * one being taught a flag.
 */
function seedFreshAgent(status?: string, over: Record<string, unknown> = {}) {
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "sparkle",
        path: "/tmp/p1",
        agents: [
          {
            id: AGENT,
            name: "Retry logic",
            runtime: "local",
            lastPrompt: "",
            promptHistory: [],
            createdAt: Date.now(),
            ...over,
          } as never,
        ],
      } as never,
    ],
  });
  runtimeStateMock.mockReturnValue({
    attentionScreen: {},
    attentionScreenAt: {},
    status: status ? { [AGENT]: status } : {},
  } as never);
}

/** A fixed "now" for the goal cases, so a goal's remaining time is arithmetic rather than a race. */
const NOW = Date.now();

/** Re-stub the mocked runtime store with EXTRA maps (branch status, workflow stage/state) that
 *  `agentGoalReading.stallEvidenceFor` reads. `seedAgent` only sets status + attentionScreen, which
 *  is the "nothing has been polled" case — this is how a test says something WAS polled. */
function seedRuntime(status: string | undefined, extra: Record<string, unknown>) {
  runtimeStateMock.mockReturnValue({
    attentionScreen: {},
    attentionScreenAt: {},
    status: status ? { [AGENT]: status } : {},
    ...extra,
  } as never);
}

/** Seed the one agent WITH a goal on its record. The goal is written as the persisted shape
 *  (engine/agentGoal.AgentGoal) rather than through the store action, so a case can express a met /
 *  escalated / expired goal directly instead of driving the lifecycle to get there. */
function seedGoalAgent(goal: Record<string, unknown>, status?: string) {
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "sparkle",
        path: "/tmp/p1",
        agents: [
          {
            id: AGENT,
            name: "Retry logic",
            runtime: "local",
            goal: { ttlMs: 4 * 3_600_000, continues: 0, totalContinues: 0, ...goal },
          } as never,
        ],
      } as never,
    ],
  });
  seedRuntime(status, {});
}

/** Put a captured ask-screen on the runtime store (tier b). */
function seedAttentionScreen(text: string, status = "waiting") {
  runtimeStateMock.mockReturnValue({
    attentionScreen: { [AGENT]: text },
    // The stamp travels with the text — see runtimeStore.attentionScreenAt (sparkle-5wbhn).
    attentionScreenAt: { [AGENT]: Date.now() },
    status: { [AGENT]: status },
  } as never);
}

function hit(agentId: string | null, snippet: string, createdAt: number) {
  return {
    id: `h-${createdAt}`,
    kind: "response" as const,
    source: "build" as const,
    projectId: "p1",
    agentId,
    projectName: "sparkle",
    agentName: "Retry logic",
    snippet,
    createdAt,
  };
}

/** An authority that really did pass the policy gate. */
const ALLOWED = conciergeToolAuthority("call-1", { tier: "allow" })!;

beforeEach(() => {
  vi.clearAllMocks();
  scrollbackMock.mockReturnValue(null);
  searchHistoryMock.mockResolvedValue([]);
  invokeMock.mockResolvedValue("");
  // Re-stubbed here, not merely cleared: `vi.clearAllMocks()` resets call HISTORY but keeps any
  // implementation a test installed, so the one test that stubs a persisted open pane would
  // otherwise leave every later test seeing that agent as "other-window" — a leak whose symptom
  // (a liveness assertion failing in an unrelated test) points nowhere near its cause.
  vi.mocked(readPersistedOpenAgentIds).mockReturnValue([]);
  forgetAgentTranscriptPath(AGENT);
  // Module-level and window-local, like the transcript registry above: without this a loop staged
  // by one case would leave every later case reading a thrashing agent.
  resetThrashTracking();
  // THE INTERACTION RECORD IS NOW A LEAK BETWEEN CASES, for the same reason the mock above is
  // re-stubbed rather than cleared. `getAgentStatus` reads `interactionStore.lastAt[agentId]` when it
  // judges whether an agent has ever been BRIEFED, and a delivered prompt now records an interaction
  // (`recordPromptSideEffects` → `touch(agentId)`, added so Improve Sparkle's elapsed timer resets
  // when the concierge prompts it — it has no AgentTab, so the `appendPrompt` path returns early for
  // it). Every dispatch case in this file therefore writes an interaction for AGENT, and the
  // `seedFreshAgent` cases below assert on a *briefless* agent — so without this reset their fixture
  // is falsified by whichever case ran before them, and they fail with "expected 'idle' to be 'new'"
  // pointing nowhere near the cause. This store is a module singleton; vi.clearAllMocks cannot touch
  // it.
  // THE WHOLE MAP, not `forget(AGENT)` (roborev 55737). The leak source writes under whatever id the
  // case dispatched to, and this file also dispatches to SPARKLE_AGENT_ID and a `-win-never-ran`
  // variant. Clearing one key happened to be enough only because `getAgentStatus` gates the
  // interaction read on `agent?.tab` and AGENT is the sole id here with a roster row — a non-local
  // coincidence that any future case seeding a second row would silently break, reproducing exactly
  // the failure this reset exists to prevent. The sibling suite already uses the unconditional form
  // (conciergeDispatch.interaction.test.ts).
  useInteractionStore.setState({ lastAt: {} } as never);
  seedAgent("local");
});

// ---------------------------------------------------------------------------------------------
// READ — the fallback chain
// ---------------------------------------------------------------------------------------------

/** The tiers, in the order the module must try them. */
const TIER_ORDER = ["scrollback", "attention-screen", "history-search", "transcript"] as const;

describe("readAgentTerminal — tier (a), the live scrollback", () => {
  it("prefers the mounted terminal and labels it live", async () => {
    scrollbackMock.mockReturnValue("$ npm test\nall green");
    const r = await readAgentTerminal(AGENT);
    expect(r.source).toBe("scrollback");
    expect(r.freshness).toBe("live");
    expect(r.text).toContain("all green");
  });

  // A hit on tier (a) must not pay for the tiers below it — the FTS search and the transcript read
  // are both IPC round trips, and this function is on the concierge's answer path.
  it("consults no later tier once the live screen answers", async () => {
    scrollbackMock.mockReturnValue("live output");
    noteAgentTranscriptPath(AGENT, "/tmp/t.jsonl");
    await readAgentTerminal(AGENT, { query: "retry" });
    expect(searchHistoryMock).not.toHaveBeenCalled();
    expect(transcriptReads()).toHaveLength(0);
  });

  // A mounted-but-blank terminal is not an answer. Returning "" from tier (a) would strand the
  // read on the freshest-but-emptiest source and never reach the screen that explains the ask.
  it("falls through when the mounted terminal is blank", async () => {
    scrollbackMock.mockReturnValue("   \n\n  ");
    seedAttentionScreen("Do you want to proceed?");
    const r = await readAgentTerminal(AGENT);
    expect(r.source).toBe("attention-screen");
  });
});

describe("readAgentTerminal — tier (b), the captured ask-screen", () => {
  // THE GAP THIS MODULE EXISTS TO CLOSE: no mounted pane, so `getAgentScrollback` is null, and the
  // concierge would otherwise have nothing to say about the agent.
  it("answers from the attention screen when the pane is not mounted", async () => {
    scrollbackMock.mockReturnValue(null);
    seedAttentionScreen("1. Yes  2. No\nProceed with the migration?");
    const r = await readAgentTerminal(AGENT);
    expect(r.source).toBe("attention-screen");
    expect(r.text).toContain("Proceed with the migration?");
  });

  // Freshness is the whole reason the source is reported. A screen captured when the agent went red
  // is not "right now", and a caller that renders it as live will tell the user something false.
  it("labels the captured screen as captured, not live", async () => {
    seedAttentionScreen("Proceed?");
    const r = await readAgentTerminal(AGENT);
    expect(r.freshness).toBe("captured");
  });

  it("says WHY tier (a) was unavailable", async () => {
    seedAttentionScreen("Proceed?");
    const r = await readAgentTerminal(AGENT);
    const a = r.attempts.find((t) => t.source === "scrollback")!;
    expect(a.ok).toBe(false);
    expect(a.why).toMatch(/mounted/i);
  });
});

describe("readAgentTerminal — tier (c), the history FTS store", () => {
  it("answers from history when neither the pane nor an ask-screen is available", async () => {
    searchHistoryMock.mockResolvedValue([hit(AGENT, "ran the <b>retry</b> suite", 1)] as never);
    const r = await readAgentTerminal(AGENT, { query: "retry" });
    expect(r.source).toBe("history-search");
    expect(r.freshness).toBe("historical");
    expect(r.text).toContain("retry");
  });

  // The FTS index is global — it has no per-agent filter — so the module has to do the filtering.
  // Leaking another agent's rows here would have the concierge confidently narrate the wrong agent.
  it("keeps only THIS agent's rows", async () => {
    searchHistoryMock.mockResolvedValue([
      hit("other-agent", "SOMEONE ELSES WORK", 2),
      hit(AGENT, "MY OWN WORK", 1),
      hit(null, "UNATTRIBUTED", 3),
    ] as never);
    const r = await readAgentTerminal(AGENT, { query: "work" });
    expect(r.text).toContain("MY OWN WORK");
    expect(r.text).not.toContain("SOMEONE ELSES WORK");
    expect(r.text).not.toContain("UNATTRIBUTED");
  });

  // roborev 61894-M1. `search_history` makes reading `concierge`-sourced rows — the founder's
  // private conversations with his minder — cost an approval card (`scope: "all"`, see
  // conciergeTools/workspace.ts). THIS tool is `read-only`, i.e. auto-allowed, and reads the raw
  // history service, so without the source filter it is a second door onto the same rows with no
  // card and no scope argument. The concierge row here deliberately carries the TARGET agentId:
  // "the agentId filter already excludes them" is only true while the not-yet-written recording
  // half writes `agentId: null`, and this pins that the tier does not depend on that.
  it("never returns a concierge row, even one stamped with this agent's id", async () => {
    searchHistoryMock.mockResolvedValue([
      { ...hit(AGENT, "PRIVATE MINDER TALK", 2), source: "concierge" },
      hit(AGENT, "MY OWN WORK", 1),
    ] as never);
    const r = await readAgentTerminal(AGENT, { query: "work" });
    // BOTH halves: the private row is gone AND the ordinary one survived the same read, so this
    // cannot pass against a filter that dropped everything.
    expect(r.text).toContain("MY OWN WORK");
    expect(r.text).not.toContain("PRIVATE MINDER TALK");
  });

  // Not a silent skip: the FTS5 table in src-tauri/src/history.rs indexes the `text` column only,
  // so "everything agent X said" is not a query it can answer. The caller has to know that the tier
  // was skipped for a structural reason rather than because the agent had no history.
  it("skips itself with a stated reason when no query was given", async () => {
    const r = await readAgentTerminal(AGENT);
    expect(searchHistoryMock).not.toHaveBeenCalled();
    const c = r.attempts.find((t) => t.source === "history-search")!;
    expect(c.ok).toBe(false);
    expect(c.why).toMatch(/search term|query/i);
  });

  // `historyLimit` is the same class of untrusted input as `maxChars`, and it is worse: it is
  // MULTIPLIED before it reaches SQLite. `historyLimit: 5_000_000` was a 50M-row FTS query running
  // `snippet()` per row on the history connection's mutex — a UI freeze produced by one hallucinated
  // tool argument. So it gets a ceiling of its own, and the over-fetch gets one too.
  it("clamps an oversized historyLimit instead of asking SQLite for 50M rows", async () => {
    searchHistoryMock.mockResolvedValue(
      Array.from({ length: 400 }, (_, i) => hit(AGENT, `row ${i}`, i)) as never,
    );
    const r = await readAgentTerminal(AGENT, { query: "row", historyLimit: 5_000_000 });
    const [, limit] = searchHistoryMock.mock.calls[0]!;
    expect(limit).toBeLessThanOrEqual(HISTORY_MAX_FETCH);
    expect(r.text.split("\n")).toHaveLength(HISTORY_MAX_HITS);
  });

  it("keeps at least one hit for a zero or negative limit", async () => {
    searchHistoryMock.mockResolvedValue([hit(AGENT, "only row", 1)] as never);
    for (const bad of [0, -7]) {
      searchHistoryMock.mockClear();
      const r = await readAgentTerminal(AGENT, { query: "row", historyLimit: bad });
      const [, limit] = searchHistoryMock.mock.calls[0]!;
      expect(limit as number, String(bad)).toBeGreaterThanOrEqual(1);
      expect(r.text, String(bad)).toContain("only row");
    }
  });

  // NaN slid through the old `Math.max(1, …)` untouched and landed in the invoke args. A nonsense
  // limit falls back to the module's default, exactly as a nonsense char budget does.
  it("falls back to the default for a nonsense limit", async () => {
    searchHistoryMock.mockResolvedValue([hit(AGENT, "a row", 1)] as never);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      searchHistoryMock.mockClear();
      await readAgentTerminal(AGENT, { query: "row", historyLimit: bad });
      const [, limit] = searchHistoryMock.mock.calls[0]!;
      expect(Number.isFinite(limit), String(bad)).toBe(true);
      expect(limit as number, String(bad)).toBeLessThanOrEqual(HISTORY_MAX_FETCH);
    }
  });

  it("survives a failing history IPC and keeps falling through", async () => {
    searchHistoryMock.mockRejectedValue(new Error("db locked"));
    noteAgentTranscriptPath(AGENT, "/tmp/t.jsonl");
    invokeMock.mockResolvedValue("the last thing I said");
    const r = await readAgentTerminal(AGENT, { query: "retry" });
    expect(r.source).toBe("transcript");
    expect(r.attempts.find((t) => t.source === "history-search")!.why).toMatch(/db locked/);
  });
});

describe("readAgentTerminal — tier (d), the session transcript", () => {
  it("answers from the transcript when every live source is empty", async () => {
    noteAgentTranscriptPath(AGENT, "/tmp/session.jsonl");
    invokeMock.mockResolvedValue("I finished the migration and opened a PR.");
    const r = await readAgentTerminal(AGENT, { query: "migration" });
    expect(r.source).toBe("transcript");
    expect(r.freshness).toBe("historical");
    expect(r.text).toContain("opened a PR");
    expect(invokeMock).toHaveBeenCalledWith("read_transcript_last_assistant", {
      path: "/tmp/session.jsonl",
    });
  });

  // ARBITRARY FILE READ, closed. `read_transcript_last_assistant` opens whatever absolute path it is
  // handed and this module's output lands in an LLM context window, so a caller-supplied path was an
  // arbitrary-file read with the contents exfiltrated into the model's view — and these options are
  // the surface a tool ARGUMENT SCHEMA gets built from, i.e. the path would have come from the model
  // itself. The registry (`noteAgentTranscriptPath`) is now the only source, and a smuggled path from
  // a JS caller is ignored rather than honoured.
  it("ignores a caller-supplied transcript path — the registry is the only source", async () => {
    noteAgentTranscriptPath(AGENT, "/tmp/registered.jsonl");
    invokeMock.mockResolvedValue("text");
    await readAgentTerminal(AGENT, {
      transcriptPath: "/Users/someone/.claude/projects/other/secret.jsonl",
    } as unknown as ReadAgentTerminalOptions);
    expect(invokeMock).toHaveBeenCalledWith("read_transcript_last_assistant", {
      path: "/tmp/registered.jsonl",
    });
    for (const [, args] of transcriptReads()) {
      expect((args as { path: string }).path).not.toContain("secret.jsonl");
    }
  });

  // With nothing registered, a smuggled path must not become one either: the tier skips itself.
  it("does not let a supplied path stand in for an unregistered agent", async () => {
    const r = await readAgentTerminal(AGENT, {
      transcriptPath: "/etc/passwd",
    } as unknown as ReadAgentTerminalOptions);
    expect(transcriptReads()).toHaveLength(0);
    expect(r.attempts.find((t) => t.source === "transcript")!.why).toMatch(/transcript path/i);
  });

  it("skips itself with a stated reason when no transcript path is known", async () => {
    const r = await readAgentTerminal(AGENT);
    expect(transcriptReads()).toHaveLength(0);
    const d = r.attempts.find((t) => t.source === "transcript")!;
    expect(d.ok).toBe(false);
    expect(d.why).toMatch(/transcript path/i);
  });

  // --- writer (2): resolving from a WORKTREE, constrained by the session binding (roborev 63135) ---
  //
  // A session directory belongs to a WORKTREE, so it holds a file for every `claude` that ever ran
  // there. This resolution used to go through the unfiltered `claude_latest_session_path` and could
  // hand `read_transcript_last_assistant` a stranger's newest file — the same wrong-attribution
  // defect the mounted pane was fixed for, on a surface where it is arguably worse: the pane shows a
  // human something that looks wrong, this quotes it to the concierge as fact.

  /** Answer `agent_own_session_path` with `own`, and blow up if the UNFILTERED command is reached —
   *  a resolve that falls back to it is exactly the defect, and a permissive stub would hide it. */
  function stubResolve(own: string | null, lastAssistant = "MY OWN LAST TURN") {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "agent_own_session_path") return Promise.resolve(own);
      if (cmd === "read_transcript_last_assistant") return Promise.resolve(lastAssistant);
      if (cmd === "claude_latest_session_path") {
        throw new Error("tier (d) must not resolve through the UNFILTERED command");
      }
      return Promise.resolve("");
    });
  }

  it("resolves a registered worktree through the agent's OWN sessions and reads that file", async () => {
    noteAgentTranscriptWorktree(AGENT, "/wt/ag-1");
    noteAgentSessionId(AGENT, "mine-1111");
    noteAgentSessionId(AGENT, "mine-2222");
    stubResolve("/home/u/.claude/projects/-wt-ag-1/mine-2222.jsonl");

    const r = await readAgentTerminal(AGENT);

    // THE SIDE EFFECT: the file that got opened, and the text that came back out of the tier.
    expect(r.source).toBe("transcript");
    expect(r.text).toContain("MY OWN LAST TURN");
    expect(invokeMock).toHaveBeenCalledWith("read_transcript_last_assistant", {
      path: "/home/u/.claude/projects/-wt-ag-1/mine-2222.jsonl",
    });
    // And the resolve was CONSTRAINED — an unbound resolve is the defect even when it happens to
    // land on the right file, because which file it lands on is not something the caller controls.
    // …and it named the ACCOUNT it should look in. `null` is the honest answer for an agent with no
    // account override — Rust falls back to `$HOME/.claude`, which is this agent's real location —
    // and asserting it explicitly is what keeps the payload's shape pinned rather than just its two
    // interesting fields. The row below is the same call for an ACCOUNT-spawned agent.
    expect(invokeMock).toHaveBeenCalledWith("agent_own_session_path", {
      worktreePath: "/wt/ag-1",
      configDir: null,
      sessionIds: ["mine-1111", "mine-2222"],
    });
  });

  // ══ WRITER (4): AND IT LOOKS IN THE RIGHT ACCOUNT'S `projects/` ROOT ═══════════════════════════
  //
  // Sparkle spawns each agent's `claude` with a per-account `CLAUDE_CONFIG_DIR`, so its transcript
  // lives under `<accountConfigDir>/projects/<slug>/`. This resolve omitted it, so Rust looked in
  // `$HOME/.claude/projects/<slug>` — a directory that does not exist for an account-spawned agent —
  // and tier (d) reported "none of its sessions has been written into its worktree yet" about an
  // agent that was writing at that moment. Measured on the founder's machine: 42 of 52 live
  // worktrees with a transcript on disk were unreadable this way.
  //
  // The stub answers ONLY for the account root, so this row can tell "the config dir reached the
  // command" from "the command ignored it" — a permissive stub could not.
  it("resolves through the agent's ACCOUNT config dir when one is registered", async () => {
    const ACCOUNT = "/home/u/Library/Application Support/ai.sparkle.desktop/accounts/c7c0d098";
    noteAgentTranscriptWorktree(AGENT, "/wt/ag-1");
    noteAgentSessionId(AGENT, "mine-1111");
    noteAgentConfigDir(AGENT, ACCOUNT);
    invokeMock.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "agent_own_session_path") {
        const dir = (args as { configDir?: string | null }).configDir ?? null;
        return Promise.resolve(dir === ACCOUNT ? `${ACCOUNT}/projects/-wt-ag-1/mine-1111.jsonl` : null);
      }
      if (cmd === "read_transcript_last_assistant") return Promise.resolve("FROM THE ACCOUNT TREE");
      if (cmd === "claude_latest_session_path") {
        throw new Error("tier (d) must not resolve through the UNFILTERED command");
      }
      return Promise.resolve("");
    });

    const r = await readAgentTerminal(AGENT);

    // THE SIDE EFFECT — the tier produced this agent's words, out of the account's own tree.
    expect(r.source).toBe("transcript");
    expect(r.text).toContain("FROM THE ACCOUNT TREE");
    expect(invokeMock).toHaveBeenCalledWith("agent_own_session_path", {
      worktreePath: "/wt/ag-1",
      configDir: ACCOUNT,
      sessionIds: ["mine-1111"],
    });
  });

  it("skips the tier entirely, at zero IPC, when the worktree is known but the binding is not", async () => {
    noteAgentTranscriptWorktree(AGENT, "/wt/ag-1");
    stubResolve("/home/u/.claude/projects/-wt-ag-1/someone-else.jsonl");

    const r = await readAgentTerminal(AGENT);

    expect(transcriptReads()).toHaveLength(0);
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "agent_own_session_path"),
    ).toEqual([]);
    const d = r.attempts.find((t) => t.source === "transcript")!;
    expect(d.ok).toBe(false);
    // NAMED AS A REFUSAL, not as missing plumbing. This string is read by an LLM that acts on it,
    // and "no transcript path is known" invites the repair of registering one — which would not
    // help and whose obvious next step is to widen the read.
    expect(d.why).toMatch(/sessions aren't known/i);
    // AND IT MUST NOT PROMISE A HOOK EVENT THAT CANNOT ARRIVE (roborev 63248). The string used to
    // end "the binding arrives with its first hook event". Hook-driven binding requires a mounted
    // pane, and an agent with a pane resolves through writer (1) and never reaches this branch — so
    // for every reader of this message the promised event never comes. Asserting only the half
    // above left the false half free to come back; this is the half that changes what the concierge
    // DOES, because a reader told to wait waits forever and then widens the read to compensate.
    expect(d.why).not.toMatch(/hook event/i);
    expect(d.why).toMatch(/not a delay to wait out/i);
  });

  // PAIRED WITH THE CASE ABOVE, and that pairing is the point: identical registration, one session
  // id added. Without it, "nothing was read" has two possible causes — the fail-closed rule, or a
  // tier that is broken for this registration shape — and an absence with two causes proves neither.
  it("reads that same registration once one session id is known", async () => {
    noteAgentTranscriptWorktree(AGENT, "/wt/ag-1");
    noteAgentSessionId(AGENT, "mine-1111");
    stubResolve("/home/u/.claude/projects/-wt-ag-1/mine-1111.jsonl", "NOW IT READS");

    const r = await readAgentTerminal(AGENT);

    expect(r.source).toBe("transcript");
    expect(r.text).toContain("NOW IT READS");
    expect(transcriptReads()).toHaveLength(1);
  });

  it("skips the tier when the agent is bound but has written no session in that worktree yet", async () => {
    noteAgentTranscriptWorktree(AGENT, "/wt/ag-1");
    noteAgentSessionId(AGENT, "mine-1111");
    stubResolve(null);

    const r = await readAgentTerminal(AGENT);

    expect(transcriptReads()).toHaveLength(0);
    const d = r.attempts.find((t) => t.source === "transcript")!;
    expect(d.ok).toBe(false);
    // AND THE REASON MUST NOT INVERT THE AXIS (roborev 63331). This case asserted only `ok === false`
    // while the two states behind this branch — no binding at all, and bound-but-no-file-yet — got
    // ONE sentence between them. This is the transient one: `resolveWorktreeTranscript` calls it
    // "the normal state of a brand-new agent rather than a fault", so telling the reader it is
    // standing is the dangerous direction. It stops re-reading and either reports a healthy new
    // agent as permanently unreadable or widens the read to compensate.
    expect(d.why).not.toMatch(/no session binding is recorded/i);
    expect(d.why).not.toMatch(/not a delay to wait out/i);
    expect(d.why).toMatch(/resolves on its own/i);
  });

  // Writer (1) is strictly better evidence — an exact, session-gated path from Claude's own Stop
  // event — so it must not be demoted by the new binding requirement. An agent with a registered
  // path and NO session binding still reads, which is the state every pre-existing caller is in.
  it("still prefers an exact registered path, and does not require a binding for it", async () => {
    noteAgentTranscriptPath(AGENT, "/tmp/exact.jsonl");
    noteAgentTranscriptWorktree(AGENT, "/wt/ag-1");
    stubResolve("/home/u/.claude/projects/-wt-ag-1/someone-else.jsonl", "EXACT PATH TURN");

    const r = await readAgentTerminal(AGENT);

    expect(r.text).toContain("EXACT PATH TURN");
    expect(invokeMock).toHaveBeenCalledWith("read_transcript_last_assistant", {
      path: "/tmp/exact.jsonl",
    });
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "agent_own_session_path"),
    ).toEqual([]);
  });
});

describe("readAgentTerminal — the chain as a whole", () => {
  // The ORDER is the contract: freshest first. A chain that tried history before the live screen
  // would still "work" on every single-tier test above.
  it("attempts the four tiers in freshness order", async () => {
    const r = await readAgentTerminal(AGENT, { query: "x" });
    expect(r.attempts.map((t) => t.source)).toEqual([...TIER_ORDER]);
  });

  // Never a null, never a throw: the concierge asked a question and has to be able to say something.
  it("reports an honest empty rather than failing when nothing has content", async () => {
    const r = await readAgentTerminal(AGENT);
    expect(r.source).toBe("none");
    expect(r.freshness).toBe("none");
    expect(r.text).toBe("");
    expect(r.attempts.every((t) => !t.ok)).toBe(true);
  });

  it("stops at the first tier with content", async () => {
    seedAttentionScreen("the ask");
    searchHistoryMock.mockResolvedValue([hit(AGENT, "older", 1)] as never);
    const r = await readAgentTerminal(AGENT, { query: "older" });
    expect(r.source).toBe("attention-screen");
    expect(searchHistoryMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// READ — the cap. This lands in an LLM context window; an unbounded blob is a real cost.
// ---------------------------------------------------------------------------------------------

describe("readAgentTerminal — output is bounded and says what it dropped", () => {
  it("caps a runaway screen at the char budget and reports the truncation", async () => {
    scrollbackMock.mockReturnValue("x".repeat(TERMINAL_READ_MAX_CHARS * 3));
    const r = await readAgentTerminal(AGENT);
    expect(r.text.length).toBeLessThanOrEqual(TERMINAL_READ_MAX_CHARS);
    expect(r.truncated).toBe(true);
    expect(r.truncation).toBeTruthy();
    expect(r.truncation).toMatch(/\d/); // it states an amount, not just "truncated"
  });

  // The TAIL, always: a terminal's current question — the thing the concierge is being asked about
  // — sits at the BOTTOM. Keeping the head would drop precisely the useful part.
  it("keeps the tail, because the live question is at the bottom", async () => {
    scrollbackMock.mockReturnValue(`${"o".repeat(TERMINAL_READ_MAX_CHARS * 2)}THE-QUESTION`);
    const r = await readAgentTerminal(AGENT);
    expect(r.text).toContain("THE-QUESTION");
    expect(r.text.startsWith("o")).toBe(false); // an elision marker leads
  });

  it("caps the line count too, and says how many lines went", async () => {
    const lines = Array.from({ length: TERMINAL_READ_MAX_LINES + 40 }, (_, i) => `line ${i}`);
    scrollbackMock.mockReturnValue(lines.join("\n"));
    const r = await readAgentTerminal(AGENT);
    expect(r.truncated).toBe(true);
    expect(r.truncation).toMatch(/line/i);
    expect(r.text).toContain(`line ${lines.length - 1}`);
    expect(r.text).not.toContain("line 0\n");
  });

  it("leaves output at or under the budget untouched and unflagged", async () => {
    scrollbackMock.mockReturnValue("short and sweet");
    const r = await readAgentTerminal(AGENT);
    expect(r.text).toBe("short and sweet");
    expect(r.truncated).toBe(false);
    expect(r.truncation).toBeUndefined();
  });

  it("honours a caller's smaller budget", async () => {
    scrollbackMock.mockReturnValue("y".repeat(5000));
    const r = await readAgentTerminal(AGENT, { maxChars: 200 });
    expect(r.text.length).toBeLessThanOrEqual(200);
    expect(r.truncated).toBe(true);
  });

  // A caller must never be able to ASK for an unbounded blob — the budget is the module's, not the
  // caller's, and a tool-call argument is one model hallucination away from `maxChars: 1e9`.
  it("clamps an oversized request back to the module's own ceiling", async () => {
    scrollbackMock.mockReturnValue("z".repeat(TERMINAL_READ_MAX_CHARS * 4));
    const r = await readAgentTerminal(AGENT, { maxChars: 10_000_000 });
    expect(r.text.length).toBeLessThanOrEqual(TERMINAL_READ_MAX_CHARS);
  });

  // The elision marker is prefixed AFTER the slice, so it has to be paid for out of the same
  // budget — otherwise every truncated read is quietly maxChars + 2, which is exactly the kind of
  // off-by-a-marker that makes a "cap" untrustworthy at the small sizes a caller would pick.
  it("pays for its own elision marker out of the budget", async () => {
    scrollbackMock.mockReturnValue("w".repeat(9000));
    for (const budget of [64, 100, 512, 4000]) {
      const r = await readAgentTerminal(AGENT, { maxChars: budget });
      expect(r.text.length, `budget ${budget}`).toBeLessThanOrEqual(budget);
      expect(r.text.startsWith("…"), `budget ${budget}`).toBe(true);
    }
  });

  // A budget too small to carry a marker plus anything useful isn't honoured either — the cap is a
  // guarantee, and one that can't be met is worse than one that's clamped.
  it("refuses a budget too small to mean anything", async () => {
    scrollbackMock.mockReturnValue("v".repeat(9000));
    const r = await readAgentTerminal(AGENT, { maxChars: 1 });
    expect(r.text.length).toBeGreaterThan(1);
    expect(r.text.length).toBeLessThanOrEqual(TERMINAL_READ_MAX_CHARS);
  });

  it("ignores a nonsense budget rather than producing an empty read", async () => {
    scrollbackMock.mockReturnValue("u".repeat(9000));
    for (const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      const r = await readAgentTerminal(AGENT, { maxChars: bad });
      expect(r.text.length, String(bad)).toBeGreaterThan(0);
      expect(r.text.length, String(bad)).toBeLessThanOrEqual(TERMINAL_READ_MAX_CHARS);
    }
  });

  // Every tier, not just the live one — a 4 MB transcript is the likeliest source of a runaway.
  it("bounds the later tiers too", async () => {
    noteAgentTranscriptPath(AGENT, "/tmp/t.jsonl");
    invokeMock.mockResolvedValue("q".repeat(TERMINAL_READ_MAX_CHARS * 5));
    const r = await readAgentTerminal(AGENT);
    expect(r.source).toBe("transcript");
    expect(r.text.length).toBeLessThanOrEqual(TERMINAL_READ_MAX_CHARS);
    expect(r.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// WRITE
// ---------------------------------------------------------------------------------------------

describe("sendToAgentTerminal — delivery", () => {
  it("delegates a well-authorized send and reports the dispatcher's path", async () => {
    const r = await sendToAgentTerminal(AGENT, "run the tests", ALLOWED);
    expect(r.ok).toBe(true);
    expect(r.path).toBe("free-text");
    // `machine: true` — a `concierge-tool` authority is MACHINE-authored prose. The policy that made
    // the write legal may have come from a human, but nobody typed this, so it must not carry the
    // human-presence signal that clears a quota wall (engine/quotaBlock).
    expect(submitPrompt).toHaveBeenCalledWith(AGENT, "run the tests", { machine: true });
  });

  it("accepts an ask-tier authority once a human approved it", async () => {
    const approved = conciergeToolAuthority("call-9", {
      tier: "ask",
      approvedByUser: true,
      approvedForToolCallId: "call-9",
    })!;
    const r = await sendToAgentTerminal(AGENT, "ship it", approved);
    expect(r.ok).toBe(true);
    expect(submitPrompt).toHaveBeenCalled();
  });

  // The result carries `display`, never the wire payload: `sent` may hold attachment temp paths or
  // a raw `2\r` keystroke frame, and this result is quoted straight back into an LLM context.
  it("reports the displayable text, not the raw wire payload", async () => {
    const r = await sendToAgentTerminal(AGENT, "run the tests", ALLOWED);
    expect(r.display).toBe("run the tests");
    expect(r).not.toHaveProperty("sent");
  });
});

describe("sendToAgentTerminal — refusals, none of which may reach the PTY", () => {
  // The core of the authority constraint. `{policy: "ask"}` is not a representable authority, so
  // this shape can only be built by casting — which is exactly what a JS caller or an object rebuilt
  // off the wire would produce.
  // THE ARM ITSELF IS PART OF THE GATE. `isDispatchAuthority` accepts any arm of the union, and the
  // other six are trivially constructible from data a model controls — `{kind:"suggestion",agentId}`
  // needs nothing but an agent id, which the tool call already supplies. Accepting one here would let
  // the tool surface authorize itself while every policy decision was bypassed, which is precisely
  // the hole the `concierge-tool` arm exists to close. A tool write rides on the tool arm or on
  // nothing. (The TYPE says so too; these have to be cast in, as a JS caller would arrive.)
  it("refuses an authority from any other arm of the union", async () => {
    const otherArms: unknown[] = [
      { kind: "suggestion", agentId: AGENT },
      { kind: "mention", agentId: AGENT },
      { kind: "nudge-approve", agentId: AGENT },
      { kind: "countdown", intentId: "intent-1" },
      { kind: "redirect", receiptId: "you-7" },
      { kind: "approval", proposalId: "prop-1" },
    ];
    for (const arm of otherArms) {
      const label = (arm as { kind: string }).kind;
      const r = await sendToAgentTerminal(
        AGENT,
        "do it anyway",
        arm as ConciergeToolAuthority,
      );
      expect(r.ok, label).toBe(false);
      expect(r.path, label).toBe("unauthorized");
      expect(submitPrompt, label).not.toHaveBeenCalled();
      expect(writePtyChainedStrict, label).not.toHaveBeenCalled();
    }
  });

  it("refuses a send whose policy was never resolved", async () => {
    const unresolved = {
      kind: "concierge-tool",
      toolCallId: "call-2",
      policy: "ask",
    } as unknown as ConciergeToolAuthority;
    const r = await sendToAgentTerminal(AGENT, "do it anyway", unresolved);
    expect(r.ok).toBe(false);
    expect(r.path).toBe("unauthorized");
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(writePtyChainedStrict).not.toHaveBeenCalled();
  });

  it("refuses a send whose policy was denied", async () => {
    const denied = {
      kind: "concierge-tool",
      toolCallId: "call-3",
      policy: "deny",
    } as unknown as ConciergeToolAuthority;
    const r = await sendToAgentTerminal(AGENT, "do it anyway", denied);
    expect(r.path).toBe("unauthorized");
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  // The factory is the only way to MINT one, and it hands back null for a decision that authorized
  // nothing — so the refusal above is a belt on a path the types already close.
  it("cannot even be handed an authority for an unapproved ask", () => {
    expect(conciergeToolAuthority("call-4", { tier: "ask", approvedByUser: false })).toBeNull();
    expect(conciergeToolAuthority("call-4", { tier: "deny" })).toBeNull();
  });

  // A tool-call agentId comes from a model and can be invented. The compose box may aim at an agent
  // the store hasn't caught up with; a TOOL may not.
  it("refuses an agent that cannot accept input, without attempting a write", async () => {
    const r = await sendToAgentTerminal("ghost-agent", "hello", ALLOWED);
    expect(r.ok).toBe(false);
    expect(r.path).toBe("unknown-agent");
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(writePtyChainedStrict).not.toHaveBeenCalled();
  });

  // A cloud send FALLS THROUGH to the dispatcher rather than being refused here, and that is what
  // makes it work now (design 2026-08-01 §Decision 7): the dispatcher relays it to the sandbox's
  // stdin over the relay socket. This suite has no relay socket, so the honest verdict is
  // `cloud-offline` — which is the assertion worth having either way, because what this module
  // must never do is write a cloud send into a LOCAL PTY.
  it("hands a cloud agent to the dispatcher and never touches a local PTY", async () => {
    seedAgent("cloud");
    const r = await sendToAgentTerminal(AGENT, "hello", ALLOWED);
    expect(r.ok).toBe(false);
    expect(r.path).toBe("cloud-offline");
    expect(r.detail.length).toBeGreaterThan(0);
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(writePtyChainedStrict).not.toHaveBeenCalled();
  });

  it("refuses empty text without a round trip to the PTY", async () => {
    const r = await sendToAgentTerminal(AGENT, "   ", ALLOWED);
    expect(r.ok).toBe(false);
    expect(r.path).toBe("empty");
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("gives every refusal a sentence the concierge can relay", async () => {
    const cases = await Promise.all([
      sendToAgentTerminal("ghost-agent", "hi", ALLOWED),
      sendToAgentTerminal(AGENT, "  ", ALLOWED),
    ]);
    for (const r of cases) expect(r.detail.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// STATUS
// ---------------------------------------------------------------------------------------------

describe("getAgentStatus", () => {
  it("reports a local agent as able to accept input", () => {
    seedAgent("local", "working");
    const s = getAgentStatus(AGENT);
    expect(s).toMatchObject({ known: true, status: "working", runtime: "local" });
    expect(s.canAcceptInput).toBe(true);
    expect(s.needsYou).toBe(false);
  });

  it("reports a cloud agent as unable to accept input", () => {
    seedAgent("cloud", "working");
    expect(getAgentStatus(AGENT).canAcceptInput).toBe(false);
  });

  it("reports an unknown agent as unknown rather than guessing", () => {
    const s = getAgentStatus("ghost-agent");
    expect(s.known).toBe(false);
    expect(s.status).toBe("unknown");
    expect(s.runtime).toBe("unknown");
    expect(s.canAcceptInput).toBe(false);
  });

  it("flags the red statuses as needing the human", () => {
    for (const st of ["waiting", "approval", "blocked", "errored"]) {
      seedAgent("local", st);
      expect(getAgentStatus(AGENT).needsYou, st).toBe(true);
    }
    for (const st of ["working", "idle", "done"]) {
      seedAgent("local", st);
      expect(getAgentStatus(AGENT).needsYou, st).toBe(false);
    }
  });

  // An open agent whose status nothing has published yet is "not known to need you", not an error.
  it("survives an agent with no published status", () => {
    seedAgent("local");
    const s = getAgentStatus(AGENT);
    expect(s.known).toBe(true);
    expect(s.status).toBe("unknown");
    expect(s.needsYou).toBe(false);
  });

  // ── The observation gap (the bug the concierge hit) ─────────────────────────────────────────
  //
  // `runtimeStore.status` is window-local. An agent with no entry in it read as `needsYou: false`,
  // which is not a reading — it is the ABSENCE of one, reported in the shape of an answer. Asked
  // agent-by-agent, a concierge got `needsYou: false` from every row and told the human nothing
  // needed them, while the sidebar was painting one of those rows red. `status` was already honest
  // here ("unknown"); the derived boolean was not, and a boolean is what a caller branches on.

  it("marks a status it actually read as observed", () => {
    seedAgent("local", "waiting");
    const s = getAgentStatus(AGENT);
    expect(s.liveness).toBe("local");
    expect(s.observed).toBe(true);
    expect(s.needsYou).toBe(true);
  });

  it("does NOT claim needsYou:false for an agent whose status it never observed", () => {
    seedAgent("local"); // in the store, but nothing has published a status
    const s = getAgentStatus(AGENT);
    expect(s.observed).toBe(false);
    expect(s.liveness).toBe("unknown");
    // The boolean stays false (nothing red was seen) but the report must say, in words a model
    // reads, that this is an unobserved default and not a clean bill of health.
    expect(s.needsYou).toBe(false);
    expect(s.detail).toMatch(/not observ|no .*status/i);
  });

  it("reports an agent open in another window as unobserved rather than calm", () => {
    seedAgent("local");
    runtimeStateMock.mockReturnValue({
      attentionScreen: {},
    attentionScreenAt: {},
      status: {},
      openAgentIds: [AGENT],
    } as never);
    const s = getAgentStatus(AGENT);
    expect(s.liveness).toBe("other-window");
    expect(s.observed).toBe(false);
  });

  // The in-memory openAgentIds copy only re-reads disk on open()/close(), so it goes stale between
  // those events — which is why get_state merges the persisted set on EVERY call. If this surface
  // skipped that merge the two would label the same agent differently at the same moment.
  it("sees an open pane recorded only in the PERSISTED set, exactly as get_state does", () => {
    seedAgent("local");
    vi.mocked(readPersistedOpenAgentIds).mockReturnValue([AGENT]);
    const s = getAgentStatus(AGENT);
    expect(s.liveness).toBe("other-window");
    expect(s.detail).toMatch(/open elsewhere/);
  });

  // The ghost: a roster read (project_agents_status) listed an agent that get_agent_status then
  // reported `known:false` for, because it had been closed in between. Both answers were right at
  // the moment they were given; with nothing but the two booleans to go on it read as the app
  // contradicting itself. The detail sentence is what makes the reconciliation possible.
  it("explains an unknown id instead of leaving two views to look contradictory", () => {
    const s = getAgentStatus("ghost-agent");
    expect(s.known).toBe(false);
    expect(s.observed).toBe(false);
    expect(s.detail).toMatch(/closed|no longer|not open/i);
  });

  it("always gives a detail sentence the concierge can relay verbatim", () => {
    seedAgent("local", "working");
    expect(getAgentStatus(AGENT).detail.length).toBeGreaterThan(0);
    expect(getAgentStatus("ghost-agent").detail.length).toBeGreaterThan(0);
  });

  // ── A freshly spawned, never-briefed agent is NEW, not BLOCKED ──────────────────────────────
  //
  // `needsYou` is derived from the red-COLOUR tier, and `blocked` is in it. An agent you spawned
  // and hadn't briefed yet reached `blocked` 25 seconds later purely on statusEngine's stall timer
  // (BLOCKED_MS) — it had asked nobody anything — so this tool answered `needsYou: true` and a
  // concierge polling the fleet dutifully reported an agent that needed the human. See
  // engine/newAgentAttention.ts. THIS SURFACE MUST AGREE WITH THE SIDEBAR: the whole point of
  // adding a status rather than special-casing a colour is that the row, the banner and this tool
  // cannot disagree about what the agent is.

  it("does NOT report needsYou for a briefless, freshly spawned agent that went `blocked`", () => {
    seedFreshAgent("blocked");
    const s = getAgentStatus(AGENT);
    expect(s.needsYou).toBe(false);
    expect(s.status).toBe("new");
  });

  it("reports the settled `idle` of a never-briefed agent as `new`, not 'done — your turn'", () => {
    seedFreshAgent("idle");
    expect(getAgentStatus(AGENT).status).toBe("new");
    expect(getAgentStatus(AGENT).needsYou).toBe(false);
  });

  it("STILL reports needsYou when that same fresh agent actually asks something", () => {
    // The assertion that guards the change: an ask is evidence, and evidence beats the grace period.
    for (const st of ["waiting", "approval"]) {
      seedFreshAgent(st);
      expect(getAgentStatus(AGENT).needsYou, st).toBe(true);
      expect(getAgentStatus(AGENT).status, st).toBe(st);
    }
  });

  it("STILL reports needsYou for a BRIEFED agent that goes blocked, however new it is", () => {
    seedFreshAgent("blocked", { lastPrompt: "go build the thing" });
    expect(getAgentStatus(AGENT).needsYou).toBe(true);
    expect(getAgentStatus(AGENT).status).toBe("blocked");
  });

  // ══ ROUTE 4: A CONCIERGE-DELIVERED PROMPT IS ALSO A BRIEF (roborev 55737) ══════════════════════
  // The four cases above are briefless via routes 1-3 (no `lastPrompt`, no `promptHistory`) and the
  // one above is briefed via `lastPrompt`, so NONE of them touches the interaction record — replace
  // `getAgentStatus`'s `interactionStore.lastAt[agentId]` argument with `undefined` and every one
  // stays green. The cross-case coupling that used to be the only thing sensitive to it is exactly
  // what the `beforeEach` reset removed, so without this row the reset's own comment describes a
  // mechanism nothing checks. This is the route that matters for Improve Sparkle, which has no
  // AgentTab and is briefed ONLY this way.
  it("treats a concierge-delivered prompt as a brief, so the agent is no longer `new`", () => {
    seedFreshAgent("blocked");
    // The control: identical fixture, no interaction — this is the first case's assertion.
    expect(getAgentStatus(AGENT).status).toBe("new");
    useInteractionStore.getState().touch(AGENT);
    expect(getAgentStatus(AGENT).status).toBe("blocked");
    expect(getAgentStatus(AGENT).needsYou).toBe(true);
  });

  it("holds an unclassifiable red inside the 5-minute backstop, and releases it after", () => {
    seedFreshAgent("errored", { createdAt: Date.now() - 60_000 });
    expect(getAgentStatus(AGENT).needsYou).toBe(false);

    seedFreshAgent("errored", { createdAt: Date.now() - (NEW_AGENT_GRACE_MS + 60_000) });
    expect(getAgentStatus(AGENT).needsYou).toBe(true);
  });

  it("leaves a legacy row with no spawn stamp exactly as it was", () => {
    // No createdAt → age unknown → treated as old. This is what keeps the change from retroactively
    // calming rows that have been red across a restart.
    seedFreshAgent("blocked", { createdAt: undefined });
    expect(getAgentStatus(AGENT).needsYou).toBe(true);
    expect(getAgentStatus(AGENT).status).toBe("blocked");
  });

  // ── GOAL / STALL / THRASH ───────────────────────────────────────────────────────────────────
  //
  // The three readings that tell a GRAY row apart from a finished one. `status` alone cannot: an
  // agent that stopped mid-write on a file and one that shipped its PR both render `idle`, which is
  // how a 153-minute stall stayed invisible. Every assertion below is on what the REPORT carries,
  // never on the engine's arithmetic (that has its own suites next door) — and the absent-field
  // cases matter most: an omitted key here means NOT OBSERVED, and a caller that reads it as calm
  // is the failure this whole surface exists to end.

  describe("goal", () => {
    it("reports an unmet goal's text, state, time left and retry counters", () => {
      seedGoalAgent({ text: "land the PR", setAt: NOW - 60_000, ttlMs: 4 * 3_600_000, continues: 2, totalContinues: 5 }, "idle");
      const s = getAgentStatus(AGENT);
      expect(s.goal).toMatchObject({
        text: "land the PR",
        state: "unmet",
        continues: 2,
        totalContinues: 5,
      });
      expect(s.goal!.remainingMs).toBeGreaterThan(0);
      // Not the raw record: a model must not have to do date arithmetic to learn the state.
      expect(s.goal).not.toHaveProperty("setAt");
    });

    // ABSENT, not a zero-filled record — "it has no goal" is read from the key being missing.
    it("omits the goal entirely for an agent that has none", () => {
      seedAgent("local", "idle");
      const s = getAgentStatus(AGENT);
      expect("goal" in s).toBe(false);
    });

    it("reports a met goal as met", () => {
      seedGoalAgent({ text: "ship it", setAt: NOW - 60_000, metAt: NOW - 1_000 }, "idle");
      expect(getAgentStatus(AGENT).goal!.state).toBe("met");
    });

    it("reports an escalated goal WITH the reason the human now owns", () => {
      seedGoalAgent(
        { text: "fix the flake", setAt: NOW - 60_000, escalatedAt: NOW - 5_000, escalationReason: "Auto-continued 3 times with no progress." },
        "idle",
      );
      const s = getAgentStatus(AGENT);
      expect(s.goal!.state).toBe("escalated");
      expect(s.goal!.escalationReason).toMatch(/no progress/);
    });

    // The TTL is a bound on SPEND, and an expired goal is still unfinished work.
    it("reports a goal past its TTL as expired", () => {
      seedGoalAgent({ text: "keep the build green", setAt: NOW - 5 * 3_600_000, ttlMs: 3_600_000 }, "idle");
      expect(getAgentStatus(AGENT).goal!.state).toBe("expired");
    });
  });

  describe("stall", () => {
    it("calls an idle agent with an unmet goal STALLED, and names the cause", () => {
      seedGoalAgent({ text: "land the PR", setAt: NOW - 60_000 }, "idle");
      const s = getAgentStatus(AGENT);
      expect(s.stall!.verdict).toBe("stalled");
      expect(s.stall!.causes).toContain("unmet-goal");
      expect(s.stall!.detail).toMatch(/land the PR/);
    });

    // "No evidence of work" is not "evidence of no work". With no git state read, the honest answer
    // for a goal-less idle row is `unknown` — and reporting it as `finished` is what would tell the
    // human an agent that stopped mid-task was done.
    it("answers unknown — not finished — for an idle agent whose git state was never read", () => {
      seedAgent("local", "idle");
      const s = getAgentStatus(AGENT);
      expect(s.stall!.verdict).toBe("unknown");
      expect(s.stall!.causes).toEqual([]);
    });

    it("reads uncommitted changes off the branch status as outstanding work", () => {
      seedAgent("local", "idle");
      seedRuntime("idle", { branchStatus: { [AGENT]: { ahead: 0, behind: 0, dirty: true, filesChanged: 3, insertions: 9, deletions: 1 } } });
      expect(getAgentStatus(AGENT).stall!.causes).toContain("uncommitted-changes");
    });

    // A worktree parked on another branch carries ITS dirt, so attributing it here would claim a
    // stall on work this agent never did. Unknown, not a cause — and not a clean bill either.
    it("does NOT attribute a PARKED worktree's dirt to this agent", () => {
      seedAgent("local", "idle");
      seedRuntime("idle", {
        branchStatus: { [AGENT]: { ahead: 0, behind: 0, dirty: true, filesChanged: 3, insertions: 9, deletions: 1, worktreeOnBranch: false } },
      });
      const s = getAgentStatus(AGENT);
      expect(s.stall!.causes).not.toContain("uncommitted-changes");
      expect(s.stall!.verdict).toBe("unknown");
    });

    it("says a working agent is active rather than judging it", () => {
      seedGoalAgent({ text: "land the PR", setAt: NOW - 60_000 }, "working");
      expect(getAgentStatus(AGENT).stall!.verdict).toBe("active");
    });

    // There is no status to judge, so there is no verdict to give. Omitted rather than guessed.
    it("omits the stall reading entirely for an agent with no observed status", () => {
      seedAgent("local");
      expect("stall" in getAgentStatus(AGENT)).toBe(false);
    });

    it("omits the stall reading for an unknown agent id", () => {
      expect("stall" in getAgentStatus("ghost-agent")).toBe(false);
    });
  });

  describe("thrash", () => {
    // THE ONE THAT MUST NOT READ AS HEALTHY. The accumulator is fed by the pane driving the agent,
    // so an agent mounted in another window has NO reading — and `thrashing: false` there would be
    // calm published on no evidence.
    it("omits the thrash reading for an agent this window has never watched", () => {
      seedAgent("local", "idle");
      const s = getAgentStatus(AGENT);
      expect("thrash" in s).toBe(false);
    });

    it("reports a repeated command once the hook stream shows the loop", () => {
      seedAgent("local", "working");
      // Three identical submissions with no tool call in between — the observed /compact spiral.
      for (let i = 0; i < 3; i++) {
        noteThrashEvent(AGENT, { event: "UserPromptSubmit", prompt: "/compact", ts: NOW + i } as never);
        noteThrashEvent(AGENT, { event: "Stop", ts: NOW + i } as never);
      }
      const s = getAgentStatus(AGENT);
      expect(s.thrash!.thrashing).toBe(true);
      expect(s.thrash!.verdict).toBe("repeating-command");
      expect(s.thrash!.repeatedCommand).toMatchObject({ text: "/compact" });
    });

    it("reports a watched, working agent as healthy — the reading is present and calm", () => {
      seedAgent("local", "working");
      noteThrashEvent(AGENT, { event: "UserPromptSubmit", prompt: "build the thing", ts: NOW } as never);
      noteThrashEvent(AGENT, { event: "PreToolUse", tool: "Edit", ts: NOW } as never);
      const s = getAgentStatus(AGENT);
      expect(s.thrash!.thrashing).toBe(false);
      expect(s.thrash!.verdict).toBe("healthy");
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The registration SEAM. Wiring these onto the MCP surface is another worker's task; all this
// branch owns is a descriptor another module can pick up without importing behaviour.
// ---------------------------------------------------------------------------------------------

describe("CONCIERGE_TERMINAL_TOOLS — the descriptor seam", () => {
  it("describes the tools this domain owns", () => {
    expect(CONCIERGE_TERMINAL_TOOLS.map((t) => t.name).sort()).toEqual([
      "read_agent_terminal",
      "read_picker_options",
      "select_picker_option",
      "send_control_key",
      "quit_alternate_screen",
      "send_to_agent_terminal",
      "get_agent_status",
    ].sort());
  });

  // Pressing a menu option WRITES to a PTY, so it is classified as one — the descriptor's `write`
  // flag is what the policy layer derives its risk from, and a press mis-marked read-only would be
  // allowed silently wherever a send would have been asked about.
  it("marks exactly the write tools as writes", () => {
    const writes = CONCIERGE_TERMINAL_TOOLS.filter((t) => t.write).map((t) => t.name).sort();
    expect(writes).toEqual([
      // Four gates narrower than everything else on this list, and still a WRITE: it presses a key
      // into a live process and cannot be un-pressed (bead sparkle-w11lll).
      "quit_alternate_screen",
      "select_picker_option",
      "send_control_key",
      "send_to_agent_terminal",
    ]);
  });

  it("gives every tool a description worth putting in a context window", () => {
    for (const t of CONCIERGE_TERMINAL_TOOLS) expect(t.description.length).toBeGreaterThan(20);
  });

  // The capability is useless if the caller cannot learn the address. `__sparkle_self__` is the one
  // agent id in the app that never appears in `get_state`, so the descriptions are the only place a
  // model can find it — a resolver fix without this reads, from the user's seat, exactly like the
  // bug it fixes.
  //
  // Scoped to the THREE ops the capability is about, not to every terminal op. It was written as
  // "every op" and that was wrong twice over: `read_picker_options` / `select_picker_option` answer
  // a menu that is already on screen — they are not how a caller discovers an agent — so the note
  // would be pure context-window noise there, and the blanket form broke the moment those two
  // landed. Naming the ops keeps the assertion meaningful: dropping the note from any of the three
  // still fails.
  it("tells the caller the Improve Sparkle agent's id, on the ops that reach it", () => {
    const reachOps = ["read_agent_terminal", "get_agent_status", "send_to_agent_terminal"];
    for (const name of reachOps) {
      const t = CONCIERGE_TERMINAL_TOOLS.find((d) => d.name === name);
      expect(t, `${name} must exist to carry the note`).toBeDefined();
      expect(t!.description, name).toContain(SPARKLE_AGENT_ID);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// THE APP'S OWN AGENT
// ---------------------------------------------------------------------------------------------
//
// "Improve Sparkle" is app-owned: it works on Sparkle itself in an app-owned clone, and it is
// deliberately NOT a member of any project's `agents` array. Every predicate in this domain used to
// resolve an agent by scanning that array, so the concierge had no route to it at all — the same
// call reported `{ known: false, observed: true, status: "working" }`, and a send came back
// `unknown-agent`, which is the gate that exists to catch a model-invented id, fired at the one id
// the app itself defines.
describe("the Improve Sparkle agent is addressable", () => {
  /** The Sparkle agent as the app actually presents it: a live runtime status, and NO roster row —
   *  that absence is the whole point, so the store is emptied rather than seeded. */
  function seedSparkle(status = "working") {
    useProjectStore.setState({ projects: [] });
    runtimeStateMock.mockReturnValue({
      attentionScreen: {},
    attentionScreenAt: {},
      status: { [SPARKLE_AGENT_ID]: status },
    } as never);
  }

  it("reports it as known, local and addressable while it is working", () => {
    seedSparkle("working");
    const s = getAgentStatus(SPARKLE_AGENT_ID);
    expect(s.known).toBe(true);
    expect(s.status).toBe("working");
    expect(s.runtime).toBe("local");
    expect(s.canAcceptInput).toBe(true);
  });

  it("names it, and says where it lives, rather than leaving the caller to guess", () => {
    seedSparkle("working");
    expect(getAgentStatus(SPARKLE_AGENT_ID).detail).toContain(SPARKLE_AGENT_ID);
    expect(getAgentStatus(SPARKLE_AGENT_ID).detail).toMatch(/Improve Sparkle/i);
  });

  // THE SIDE EFFECT, not the verdict: before the fix this refused with `unknown-agent` and nothing
  // reached the PTY, so asserting `ok` alone would not distinguish "delivered" from "mislabelled".
  it("delivers a message to it, exactly as it would to a build agent", async () => {
    seedSparkle("working");
    const r = await sendToAgentTerminal(SPARKLE_AGENT_ID, "your outage advice is out of date", ALLOWED);
    expect(r.path).not.toBe("unknown-agent");
    expect(r.ok).toBe(true);
    expect(submitPrompt).toHaveBeenCalledWith(
      SPARKLE_AGENT_ID,
      "your outage advice is out of date",
      { machine: true },
    );
  });

  it("reads its terminal through the same chain, labelling the source", async () => {
    seedSparkle("working");
    scrollbackMock.mockImplementation((id) => (id === SPARKLE_AGENT_ID ? "reviewing logs…" : null));
    const r = await readAgentTerminal(SPARKLE_AGENT_ID);
    expect(r.source).toBe("scrollback");
    expect(r.text).toContain("reviewing logs");
  });

  // Per-window copies (`__sparkle_self__-win-<uuid>`) share the namespace and must resolve too.
  it("resolves a secondary window's copy under the same namespace", () => {
    useProjectStore.setState({ projects: [] });
    const perWindow = `${SPARKLE_AGENT_ID}-win-abc`;
    runtimeStateMock.mockReturnValue({
      attentionScreen: {},
    attentionScreenAt: {},
      status: { [perWindow]: "working" },
    } as never);
    expect(getAgentStatus(perWindow).known).toBe(true);
  });

  // THE CASE ONLY THE SPARKLE ARM COVERS, and therefore the one that pins it. With its pane open in
  // ANOTHER window there is no local status entry, so the generic observed-arm fallback does not
  // reach it — yet this is exactly when the concierge is most likely to be asked about it. It stays
  // addressable, and the report stays honest that the status is a default rather than a reading.
  it("stays addressable when its pane is open in another window", () => {
    useProjectStore.setState({ projects: [] });
    runtimeStateMock.mockReturnValue({ attentionScreen: {},
    attentionScreenAt: {}, status: {} } as never);
    vi.mocked(readPersistedOpenAgentIds).mockReturnValue([SPARKLE_AGENT_ID]);
    const s = getAgentStatus(SPARKLE_AGENT_ID);
    expect(s.known).toBe(true);
    expect(s.canAcceptInput).toBe(true);
    expect(s.liveness).toBe("other-window");
    expect(s.observed).toBe(false);
    expect(s.detail).toMatch(/another window/i);
  });

  // The namespace alone is not enough — an id nothing has ever observed stays unknown, so the
  // `unknown-agent` write gate keeps working for a Sparkle-shaped id that isn't running anywhere.
  it("still refuses a Sparkle-namespace id this window has never seen", async () => {
    useProjectStore.setState({ projects: [] });
    runtimeStateMock.mockReturnValue({ attentionScreen: {},
    attentionScreenAt: {}, status: {} } as never);
    vi.mocked(readPersistedOpenAgentIds).mockReturnValue([]);
    const ghost = `${SPARKLE_AGENT_ID}-win-never-ran`;
    expect(getAgentStatus(ghost).known).toBe(false);
    const r = await sendToAgentTerminal(ghost, "hello", ALLOWED);
    expect(r.path).toBe("unknown-agent");
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  // ── A SEND MUST NOT LAND WHILE A HEADLESS PASS IS WRITING THE WORKTREE ──────────────────────
  //
  // Improve Sparkle has TWO bodies sharing ONE worktree — the interactive pane whose PTY a send
  // targets, and an hourly headless `claude -p` pass — under the app's one-claude-per-worktree
  // invariant. A send mid-pass puts a SECOND claude in a tree the first is committing from.
  //
  // ONLY the pass is a hold. A pane mid-turn is the same claude the write is addressed to, and the
  // test above ("delivers a message to it, exactly as it would to a build agent") seeds exactly that
  // and demands delivery — holding on it would have made this the one agent you cannot type at
  // while it thinks.
  //
  // WHAT EACH CASE ASSERTS IS THE ABSENCE OF THE WRITE, not the presence of a refusal: a test
  // checking only `r.path` would pass against a gate that refused AFTER dispatching, which is the
  // defect that matters here — the damage is the second mutator, not the reply.
  describe("and it is refused while a headless improvement pass is in flight", () => {
    beforeEach(() => {
      seedSparkle("working");
      claimPass();
    });
    afterEach(() => releasePass());

    it("refuses without writing", async () => {
      const r = await sendToAgentTerminal(SPARKLE_AGENT_ID, "status?", ALLOWED);
      expect(r.ok).toBe(false);
      expect(r.path).toBe("sparkle-busy");
      // THE ASSERTION THAT MATTERS.
      expect(submitPrompt).not.toHaveBeenCalled();
    });

    it("says WAIT rather than offering a retry", async () => {
      const r = await sendToAgentTerminal(SPARKLE_AGENT_ID, "status?", ALLOWED);
      expect(r.detail).toEqual(expect.stringContaining("wait"));
      expect(r.detail).not.toMatch(/try again/i);
    });

    it("DELIVERS once the pass ends — the inverse guard", async () => {
      // Without this, a gate hardwired to refuse would satisfy both rows above while making the
      // agent permanently unreachable, which is the opposite of what this work is for.
      releasePass();
      const r = await sendToAgentTerminal(SPARKLE_AGENT_ID, "status?", ALLOWED);
      expect(r.path).toBe("free-text");
      expect(submitPrompt).toHaveBeenCalled();
    });

    it("holds ONLY the app-owned agent — an ordinary build agent is unaffected", async () => {
      // The pass latch is global module state. Without the `isSparkleAgentId` scope, a pass in
      // flight would silently freeze sends to every agent in the app.
      seedAgent("local"); // `seedSparkle` above empties `projects`; put the build agent back
      const r = await sendToAgentTerminal(AGENT, "run the tests", ALLOWED);
      expect(r.path).toBe("free-text");
      expect(submitPrompt).toHaveBeenCalled();
    });
  });
});

// The invariant that made the original report unactionable: one call cannot both say it is reading
// an agent's live status and that no such agent exists. `known: false` is documented as "closed or
// invented" (stop), while `observed: true` says the reading is authoritative (act) — a caller has no
// way to obey both. This is asserted as a PROPERTY over every arm rather than as one more case,
// because the arms are what keep growing.
describe("get_agent_status — known and observed can never disagree", () => {
  const arms: [string, () => string][] = [
    ["a roster agent", () => (seedAgent("local", "working"), AGENT)],
    [
      "the app-owned Sparkle agent",
      () => {
        useProjectStore.setState({ projects: [] });
        runtimeStateMock.mockReturnValue({
          attentionScreen: {},
    attentionScreenAt: {},
          status: { [SPARKLE_AGENT_ID]: "working" },
        } as never);
        return SPARKLE_AGENT_ID;
      },
    ],
    [
      "an agent this window watches but has no row for",
      () => {
        useProjectStore.setState({ projects: [] });
        runtimeStateMock.mockReturnValue({
          attentionScreen: {},
    attentionScreenAt: {},
          status: { "orphan-1": "waiting" },
        } as never);
        return "orphan-1";
      },
    ],
  ];

  for (const [label, seed] of arms) {
    it(`holds for ${label}`, () => {
      const id = seed();
      const s = getAgentStatus(id);
      expect(s.observed, `${label}: expected a live reading`).toBe(true);
      expect(s.known, `${label}: observed but reported as not known`).toBe(true);
    });
  }
});

// A compile-time note as much as a test: the read result is the shape callers destructure.
describe("the read result shape", () => {
  it("always carries agentId, source, freshness, text and attempts", async () => {
    const r: AgentTerminalRead = await readAgentTerminal(AGENT);
    expect(Object.keys(r).sort()).toEqual(
      ["agentId", "attempts", "freshness", "source", "text", "truncated"].sort(),
    );
    expect(r.agentId).toBe(AGENT);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ANSWERING A PICKER
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// The DETECTOR is real (scrollback in, options out) — these ops exist to hand back the options an
// agent is genuinely showing, and a stubbed detector would prove nothing about that. Only the
// scrollback source is mocked, as everywhere else in this suite.
const MENU = ["Select an option:", "  1) Rebase onto main", "  2) Merge main in", "Enter your choice: "].join("\n");
const OTHER_MENU = ["Select an option:", "  1) Delete the branch", "  2) Keep it", "Enter your choice: "].join("\n");

describe("read_picker_options", () => {
  it("returns the live options with the indexes select_picker_option takes", () => {
    scrollbackMock.mockReturnValue(MENU);
    const read = readPickerOptions(AGENT);
    expect(read.present).toBe(true);
    expect(read.options.map((o) => o.index)).toEqual([0, 1]);
    expect(read.fingerprint).not.toBe("");
  });

  // No menu is a NORMAL state, not an error — most of the time an agent is simply working.
  it("reports no menu as an empty list rather than a failure", () => {
    scrollbackMock.mockReturnValue("just some build output\nnothing to answer here");
    expect(readPickerOptions(AGENT)).toMatchObject({ present: false, options: [], fingerprint: "" });
  });

  // THE reason the guard is a fingerprint and not a label. Every numbered menu labels its options
  // "1", "2", … so two entirely different questions are label-identical.
  it("fingerprints the MENU, so different questions with identical labels differ", () => {
    scrollbackMock.mockReturnValue(MENU);
    const a = readPickerOptions(AGENT);
    scrollbackMock.mockReturnValue(OTHER_MENU);
    const b = readPickerOptions(AGENT);

    expect(b.options.map((o) => o.label)).toEqual(a.options.map((o) => o.label)); // same labels…
    expect(b.fingerprint).not.toBe(a.fingerprint); // …different menu
  });

  it("is stable for the same menu read twice", () => {
    scrollbackMock.mockReturnValue(MENU);
    expect(readPickerOptions(AGENT).fingerprint).toBe(readPickerOptions(AGENT).fingerprint);
  });

  // ── WHY IT IS BLIND (bead sparkle-99o9a) ────────────────────────────────────────────────────
  // An empty read used to be one undifferentiated answer, so "this agent is working" and "this
  // agent has a dialog I could not parse" were the same result — which is why the incident needed
  // four hand-observed occurrences before anyone could say what it was. These pin that the three
  // causes are now told apart AT THE PRODUCTION ENTRY POINT, not in the parser alone.
  //
  // WHAT WOULD MAKE THESE VACUOUS: asserting `present === false`, which was already true for every
  // one of them. The assertion is the `blind` value, and each fixture is a DIFFERENT screen.
  describe("says why it is blind", () => {
    it("distinguishes a pane this window cannot see from an agent with no menu", () => {
      scrollbackMock.mockReturnValue(null);
      expect(readPickerOptions(AGENT).blind).toBe("pane-not-mounted");

      scrollbackMock.mockReturnValue("just some build output\nnothing to answer here");
      expect(readPickerOptions(AGENT).blind).toBe("no-menu");
    });

    // THE ARM THAT WAS DELETED (roborev 61832). A numbered plan is indistinguishable from a
    // footerless dialog, and it is far more common — so it must read as `no-menu`, never as
    // "something needs a human". Without this fixture the weak predicate was never exercised
    // against ordinary prose, which is exactly why it shipped.
    it("does not escalate an agent that is merely printing a numbered list", () => {
      scrollbackMock.mockReturnValue(
        ["Here is the plan:", "  1. Read the file", "  2. Patch it", "  3. Run the tests"].join("\n"),
      );
      const read = readPickerOptions(AGENT);
      expect(read.present).toBe(false);
      expect(read.blind).toBe("no-menu");
    });

    // THE approvalDeadEnd SHAPE, pinned on that suite's own fixture so the taxonomy cannot drift
    // from the incident it is supposed to let someone count (roborev 61832).
    it("names the approvalDeadEnd screen as a footer whose options could not be read", () => {
      // THE SHARED fixture, not a copy of its text (roborev 61842): a change to the incident's
      // rendering must fail this suite and approvalDeadEnd's together, or the "cannot drift"
      // claim above is decoration.
      scrollbackMock.mockReturnValue(FOOTER_ONLY_SCREEN);
      expect(readPickerOptions(AGENT).blind).toBe("footer-without-options");
    });

    it("names a footer whose option block did not parse", () => {
      scrollbackMock.mockReturnValue(
        ["I finished the rebase and pushed it.", "Enter to select \u00b7 Tab/Arrow keys to navigate \u00b7 Esc to cancel"].join("\n"),
      );
      const read = readPickerOptions(AGENT);
      expect(read.present).toBe(false);
      expect(read.blind).toBe("footer-without-options");
    });

    // The field is ABSENT on a successful read — a caller must not have to check both.
    it("says nothing when a menu was read", () => {
      scrollbackMock.mockReturnValue(MENU);
      const read = readPickerOptions(AGENT);
      expect(read.present).toBe(true);
      expect(read.blind).toBeUndefined();
    });

    // ── THE DESCRIPTOR IS THE MODEL'S ONLY GUIDE, SO IT MUST MATCH THE UNION (roborev 61842) ──
    // The prose was hand-edited to drop a value, and nothing tied it to `PickerBlindness`: the
    // revert was un-guarded in both directions. A value added to the union would otherwise ship
    // with a description telling the model it does not exist, so an unknown cause reaches the
    // concierge with no guidance on whether it means "relay this to a human".
    //
    // `satisfies Record<…, true>` is what keeps this exhaustive at COMPILE time — adding a member
    // to the union without adding it here is a typecheck error, not a silently-passing test.
    it("describes every blindness cause it can return, and no cause it retired", () => {
      // KEYED OFF THE RETURNED TYPE, not off `PickerBlindness` (roborev 61864). The field the
      // descriptor documents is `PickerOptionsRead["blind"]`, which is WIDER — `pane-not-mounted`
      // is added at the tool layer, not in `heuristics.ts`. Checking the narrower union and then
      // splicing the tool-layer value in as a bare literal left the half that people actually
      // extend unguarded: a second tool-layer cause would typecheck, keep this green, and ship a
      // description telling the model it does not exist.
      const CAUSES = {
        "no-menu": true,
        "footer-without-options": true,
        "pane-not-mounted": true,
      } satisfies Record<NonNullable<PickerOptionsRead["blind"]>, true>;
      // Causes this branch RETIRED — exactly one. `cloud-agent` was in this list and was wrong
      // (roborev 61881): it was never a blindness cause, so the assertion was true before the
      // change and no regression in the thing under test could make it false — the vacuous shape
      // AGENTS.md calls the #1 fleet finding. Worse, it is a LIVE term in a different taxonomy (a
      // dispatch refusal reason, asserted further down this same file), so a legitimate future
      // descriptor edit mentioning cloud agents would have redded this and the maintainer would
      // have deleted an assertion that never guarded anything.
      const RETIRED = ["no-footer"]; // deleted in e34b7e6ce: it could not tell a plan from a dialog
      const descriptor = CONCIERGE_TERMINAL_TOOLS.find((t) => t.name === "read_picker_options");
      const text = descriptor?.description ?? "";

      for (const cause of Object.keys(CAUSES)) {
        expect(text, `descriptor must document \`${cause}\``).toContain(cause);
      }
      for (const gone of RETIRED) {
        expect(text, `descriptor must not still offer \`${gone}\``).not.toContain(gone);
      }
    });

    // REPORTING, NOT PERMISSION. Every blind value still refuses the press.
    it("does not make anything pressable", async () => {
      scrollbackMock.mockReturnValue(
        ["I finished the rebase and pushed it.", "Enter to select \u00b7 Tab/Arrow keys to navigate \u00b7 Esc to cancel"].join("\n"),
      );
      const r = await selectPickerOption(AGENT, 0, "anything", ALLOWED);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("no-picker");
    });
  });
});

describe("select_picker_option", () => {
  it("presses the option through the ordinary authority-gated send", async () => {
    scrollbackMock.mockReturnValue(MENU);
    const read = readPickerOptions(AGENT);

    const r = await selectPickerOption(AGENT, 1, read.fingerprint, ALLOWED);
    expect(r.ok).toBe(true);
    expect(r.label).toBe(read.options[1]!.label);
    // It went out as a REAL write. A picker answer is `kind: "terminal"` — raw PTY bytes — so it
    // lands on writePtyChainedStrict rather than the composer's submitPrompt. Either way it is the
    // ordinary authority-gated path, not a second route to a terminal.
    expect(writePtyChainedStrict).toHaveBeenCalled();
  });

  // THE safety property. Selection presses a button the human never read, so a menu that moved on
  // between the read and the press must refuse rather than answer the new question by accident
  // (the addressed-at-picker precedent, bead sparkle-8bvh).
  it("REFUSES when the menu changed under it, and presses nothing", async () => {
    scrollbackMock.mockReturnValue(MENU);
    const stale = readPickerOptions(AGENT).fingerprint;

    scrollbackMock.mockReturnValue(OTHER_MENU); // the agent moved on to a different question
    const r = await selectPickerOption(AGENT, 0, stale, ALLOWED);

    expect([r.ok, r.reason]).toEqual([false, "changed"]);
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(writePtyChainedStrict).not.toHaveBeenCalled();
  });

  it("refuses an index outside the live list, and says what the range is", async () => {
    scrollbackMock.mockReturnValue(MENU);
    const read = readPickerOptions(AGENT);
    const r = await selectPickerOption(AGENT, 7, read.fingerprint, ALLOWED);
    expect([r.ok, r.reason]).toEqual([false, "out-of-range"]);
    expect(r.detail).toMatch(/0–1/);
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("refuses when there is no menu at all", async () => {
    scrollbackMock.mockReturnValue("no prompt here");
    const r = await selectPickerOption(AGENT, 0, "anything", ALLOWED);
    expect([r.ok, r.reason]).toEqual([false, "no-picker"]);
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  // Pressing an option WRITES to a PTY, so it rides the same authority as any other send — there is
  // no second, weaker route to a terminal.
  it("refuses without a valid authority, and presses nothing", async () => {
    scrollbackMock.mockReturnValue(MENU);
    const read = readPickerOptions(AGENT);
    const r = await selectPickerOption(AGENT, 0, read.fingerprint, null as never);
    expect(r.ok).toBe(false);
    expect(submitPrompt).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CONTROL KEYS
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// Not text. Interrupting a runaway agent is `esc`; without these the concierge could only ever ADD
// to what an agent was doing, never steer or stop it.
describe("send_control_key", () => {
  it("writes the RAW bytes for the key, with no carriage return appended", async () => {
    const r = await sendControlKey(AGENT, "esc", ALLOWED);
    expect(r.ok).toBe(true);
    expect(writePtyChainedStrict).toHaveBeenCalledWith(AGENT, "\x1b");
    // A key is bytes, not a line — it must NOT get submitPrompt's bracketed-paste + CR framing.
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("maps each named key to the sequence a real keyboard sends", async () => {
    for (const [key, bytes] of [
      ["enter", "\r"],
      ["shift+tab", "\x1b[Z"],
      ["ctrl+b", "\x02"],
      ["up", "\x1b[A"],
      ["down", "\x1b[B"],
    ] as const) {
      vi.mocked(writePtyChainedStrict).mockClear();
      await sendControlKey(AGENT, key, ALLOWED);
      expect(writePtyChainedStrict, key).toHaveBeenCalledWith(AGENT, bytes);
    }
  });

  // The safety boundary is the NAMED set: arbitrary escape sequences could rewrite terminal state or
  // spoof a bracketed paste around somebody else's text. Every name maps to something concrete.
  it("exposes only named keys, each with a real sequence", () => {
    expect(CONTROL_KEY_NAMES.length).toBeGreaterThan(0);
    for (const name of CONTROL_KEY_NAMES) {
      expect(typeof CONTROL_KEYS[name]).toBe("string");
      expect(CONTROL_KEYS[name].length).toBeGreaterThan(0);
    }
  });

  // Pressing esc can discard work in flight, so this is not a lesser act than typing and does not
  // get a lesser gate.
  it("refuses without a valid authority, and writes nothing", async () => {
    const r = await sendControlKey(AGENT, "esc", null as never);
    expect([r.ok, r.reason]).toEqual([false, "unauthorized"]);
    expect(writePtyChainedStrict).not.toHaveBeenCalled();
  });

  it("refuses an unknown agent without writing", async () => {
    const r = await sendControlKey("nope", "esc", ALLOWED);
    expect([r.ok, r.reason]).toEqual([false, "unknown-agent"]);
    expect(writePtyChainedStrict).not.toHaveBeenCalled();
  });

  it("refuses a cloud agent, which has no PTY to press a key in", async () => {
    seedAgent("cloud");
    const r = await sendControlKey(AGENT, "esc", ALLOWED);
    expect([r.ok, r.reason]).toEqual([false, "cloud-agent"]);
    expect(writePtyChainedStrict).not.toHaveBeenCalled();
  });

  // A PTY that went away between the check and the write is a race, not a bug — reported as a
  // refusal so the concierge never claims a keypress that did not land. Rejects with the REAL
  // PtyGoneError, because the previous version threw a plain Error and so passed identically whether
  // the catch was narrow or a blanket (roborev 55165).
  it("reports a vanished PTY as a refusal rather than a silent success", async () => {
    vi.mocked(writePtyChainedStrict).mockRejectedValueOnce(new PtyGoneError(AGENT));
    const r = await sendControlKey(AGENT, "esc", ALLOWED);
    expect([r.ok, r.reason]).toEqual([false, "pty-gone"]);
  });

  // …and any OTHER failure must not claim the terminal closed. "The agent's terminal has closed" is
  // a factual claim the human acts on — under this repo's remedy-text rule, saying it after a
  // transient IPC hiccup invites them to close or discard an agent that is alive and fine.
  it("does NOT claim the terminal closed for an unrelated write failure", async () => {
    vi.mocked(writePtyChainedStrict).mockRejectedValueOnce(new Error("ipc hiccup"));
    const r = await sendControlKey(AGENT, "esc", ALLOWED);
    expect([r.ok, r.reason]).toEqual([false, "send-failed"]);
    expect(r.detail).not.toMatch(/terminal has closed/i);
    expect(r.detail).toMatch(/ipc hiccup/);
  });
});

// THE CASE THAT BROKE THE FIRST IMPLEMENTATION (roborev 55163).
//
// Claude Code's Bash-approval dialog renders the SAME three options for every command, and Ink keeps
// drawing BELOW the dialog — so a fingerprint built from the option shape plus a tail slice of the
// scrollback is constant across completely different commands. Reading the prompt for `git status`
// and then pressing "Yes" against `rm -rf build/` would have sailed straight through.
describe("the fingerprint identifies the QUESTION, not the chrome", () => {
  const approval = (command: string, trailingChrome: string[] = []) =>
    [
      "Bash command",
      `  ${command}`,
      "  Remove the build directory",
      "",
      "Do you want to proceed?",
      "\u276f 1. Yes",
      "  2. Yes, and don't ask again for rm commands in this project",
      "  3. No, and tell Claude what to do differently",
      "",
      "Esc to cancel \u00b7 Tab to amend \u00b7 ctrl+e to explain",
      ...trailingChrome,
    ].join("\n");

  it("differs when only the COMMAND differs — identical options, identical footer", () => {
    scrollbackMock.mockReturnValue(approval("git status"));
    const safe = readPickerOptions(AGENT);
    scrollbackMock.mockReturnValue(approval("rm -rf build/"));
    const dangerous = readPickerOptions(AGENT);

    // The options really are byte-identical; the command is the only difference.
    expect(dangerous.options.map((o) => o.label)).toEqual(safe.options.map((o) => o.label));
    expect(dangerous.fingerprint).not.toBe(safe.fingerprint);
  });

  it("REFUSES the press that the old tail-slice fingerprint would have allowed", async () => {
    scrollbackMock.mockReturnValue(approval("git status"));
    const read = readPickerOptions(AGENT);

    scrollbackMock.mockReturnValue(approval("rm -rf build/"));
    const r = await selectPickerOption(AGENT, 0, read.fingerprint, ALLOWED);

    expect([r.ok, r.reason]).toEqual([false, "changed"]);
    expect(writePtyChainedStrict).not.toHaveBeenCalled();
  });

  // The other direction matters just as much: Ink redraws the checklist below the dialog constantly,
  // and a fingerprint that moved with it would refuse a menu that never changed — making the tool
  // useless rather than unsafe.
  it("is STABLE while only the chrome below the dialog changes", () => {
    scrollbackMock.mockReturnValue(approval("git status", ["", "\u2713 wrote tests", "  running suite\u2026"]));
    const a = readPickerOptions(AGENT).fingerprint;
    scrollbackMock.mockReturnValue(
      approval("git status", ["", "\u2713 wrote tests", "\u2713 ran suite", "  opening PR\u2026"]),
    );
    expect(readPickerOptions(AGENT).fingerprint).toBe(a);
  });

  // Arrowing through a menu moves the highlight pointer without changing the question.
  it("is STABLE while only the highlight pointer moves", () => {
    scrollbackMock.mockReturnValue(approval("git status"));
    const a = readPickerOptions(AGENT).fingerprint;
    scrollbackMock.mockReturnValue(
      approval("git status").replace("\u276f 1. Yes", "  1. Yes").replace("  2. Yes,", "\u276f 2. Yes,"),
    );
    expect(readPickerOptions(AGENT).fingerprint).toBe(a);
  });
});

// THE UNGUARDED ROUTE TO THE SAME ACT (roborev 55165).
//
// select_picker_option refuses unless the caller echoes a fingerprint of the menu it read. Without
// this guard, send_control_key("enter") pressed the HIGHLIGHTED option of whatever dialog was on
// screen — nothing read, no fingerprint, no index — and down-then-enter reached any other option.
// Both ops share the `disruptive` tier, so the policy layer could not tell them apart either.
describe("send_control_key cannot be used to answer a picker", () => {
  const MENU2 = ["Select an option:", "  1) Rebase onto main", "  2) Merge main in", "Enter your choice: "].join("\n");

  it.each(["enter", "up", "down", "left", "right"] as const)(
    "refuses %s while a menu is live, and points at the guarded op",
    async (key) => {
      scrollbackMock.mockReturnValue(MENU2);
      const r = await sendControlKey(AGENT, key, ALLOWED);
      expect([r.ok, r.reason]).toEqual([false, "ambiguous-picker"]);
      expect(r.detail).toMatch(/select_picker_option/);
      expect(writePtyChainedStrict).not.toHaveBeenCalled();
    },
  );

  // esc DECLINES rather than answers, and "stop what you're doing" is the most valuable thing this
  // tool does — so it stays allowed even with a menu up. The asymmetry is deliberate.
  it.each(["esc", "ctrl+b"] as const)("still allows %s with a menu on screen", async (key) => {
    scrollbackMock.mockReturnValue(MENU2);
    const r = await sendControlKey(AGENT, key, ALLOWED);
    expect(r.ok).toBe(true);
    expect(writePtyChainedStrict).toHaveBeenCalled();
  });

  it("allows the picker-driving keys normally when NO menu is up", async () => {
    scrollbackMock.mockReturnValue("just build output");
    const r = await sendControlKey(AGENT, "enter", ALLOWED);
    expect(r.ok).toBe(true);
  });
});

// TWO SHAPES THE FIRST FINGERPRINT WAS INERT FOR (roborev 55166).
describe("the fingerprint covers every picker shape, not just numbered menus", () => {
  // A yes/no confirmation has NO option rows at all, and its buttons are the constant pair
  // Approve/Deny — so a fingerprint built from the option shape plus an empty question block was the
  // SAME VALUE for every y/n prompt ever shown. "Delete the production database?" could be answered
  // with a fingerprint taken from "Overwrite config.toml?".
  it("distinguishes two different YES/NO questions", () => {
    scrollbackMock.mockReturnValue("About to run a migration.\nDelete the production database? [y/n] ");
    const danger = readPickerOptions(AGENT);
    scrollbackMock.mockReturnValue("Writing settings.\nOverwrite config.toml? [y/n] ");
    const benign = readPickerOptions(AGENT);

    expect(danger.present && benign.present).toBe(true);
    // The options really are the constant Approve/Deny pair…
    expect(benign.options.map((o) => o.label)).toEqual(danger.options.map((o) => o.label));
    // …so only the question can tell them apart.
    expect(benign.fingerprint).not.toBe(danger.fingerprint);
  });

  it("refuses a press whose y/n question changed underneath", async () => {
    scrollbackMock.mockReturnValue("Delete the production database? [y/n] ");
    const stale = readPickerOptions(AGENT).fingerprint;
    scrollbackMock.mockReturnValue("Overwrite config.toml? [y/n] ");

    const r = await selectPickerOption(AGENT, 0, stale, ALLOWED);
    expect([r.ok, r.reason]).toEqual([false, "changed"]);
    expect(writePtyChainedStrict).not.toHaveBeenCalled();
  });

  // The generic menu heuristic accepts bracket forms — `[1] x`, `(2) x` — which the first
  // option-line pattern rejected. An unmatched menu falls through to the trailing-lines fallback,
  // and that reaches the question only for SHORT menus: with more option rows than the fallback's
  // window, the block is all options and no question, and the options of two different asks are
  // identical. So a long bracket menu is the case where locating the block actually matters.
  it("locates the question above a LONG bracket-form menu", () => {
    const menu = (q: string) =>
      [
        q,
        "  [1] Keep current",
        "  [2] Use incoming",
        "  [3] Keep both",
        "  [4] Open in editor",
        "  [5] Abort the merge",
        "Enter your choice: ",
      ].join("\n");
    scrollbackMock.mockReturnValue(menu("Conflict in auth.ts:"));
    const a = readPickerOptions(AGENT);
    scrollbackMock.mockReturnValue(menu("Conflict in billing.ts:"));
    const b = readPickerOptions(AGENT);

    expect(a.present).toBe(true);
    // Same five options either way — only the question distinguishes the two asks.
    expect(b.options.map((o) => o.label)).toEqual(a.options.map((o) => o.label));
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });
});

// THE GUARD MUST FAIL CLOSED WHEN IT CANNOT SEE (roborev 55168).
//
// liveOptionsFor reads the LIVE xterm buffer, which is null whenever the pane isn't mounted — the
// norm on a real fleet. Gating on it alone failed OPEN on exactly the unattended agents the
// concierge exists to drive: select_picker_option refuses there while the raw keystroke sailed
// through, the inverse of the intended asymmetry.
describe("the control-key picker guard consults the captured screen too", () => {
  const MENU3 = ["Select an option:", "  1) Yes", "  2) No", "Enter your choice: "].join("\n");

  it("refuses enter when the pane is UNMOUNTED but the captured screen shows a menu", async () => {
    scrollbackMock.mockReturnValue(null); // pane not mounted — tier (a) is blind
    seedAttentionScreen(MENU3);

    const r = await sendControlKey(AGENT, "enter", ALLOWED);
    expect([r.ok, r.reason]).toEqual([false, "ambiguous-picker"]);
    expect(writePtyChainedStrict).not.toHaveBeenCalled();
  });

  it("still allows enter when neither source shows a menu", async () => {
    scrollbackMock.mockReturnValue(null);
    seedAttentionScreen("just build output");

    const r = await sendControlKey(AGENT, "enter", ALLOWED);
    expect(r.ok).toBe(true);
  });
});

// THE GUARD MUST NOT OUTLIVE THE MENU (roborev 55170).
//
// attentionScreen is written on the transition into waiting/approval. When these cases were written
// it was cleared only by close()/resetProgress() — nothing dropped it when the agent answered and
// got back to work — so a guard that consults it unconditionally refuses the driving keys forever
// after an agent's FIRST ask, and select_picker_option refuses in the same state: no route at all,
// which is a deadlock rather than a guard.
//
// The capture now ALSO expires when the agent leaves the red tier (sparkle-99o9a,
// runtimeStore.setStatus) — but these cases stay, and they stay driving a HAND-SEEDED store. That is
// the point: this suite mocks the runtime store, so what it pins is that the guard is correct about
// a stale capture it is HANDED, independently of who else is bounding that map. The expiry has its
// own suite (terminal.attentionExpiry.test.ts) driving the real store.
describe("a STALE captured menu does not outlive the pane that can see", () => {
  const MENU3 = ["Select an option:", "  1) Yes", "  2) No", "Enter your choice: "].join("\n");

  it("allows enter when the LIVE screen is readable and clean, even with a stale capture", async () => {
    scrollbackMock.mockReturnValue("Compiling…\nbuild finished"); // mounted, and definitively no menu
    seedAttentionScreen(MENU3, "working"); // answered twenty minutes ago, never cleared

    const r = await sendControlKey(AGENT, "enter", ALLOWED);
    expect(r.ok).toBe(true);
    expect(writePtyChainedStrict).toHaveBeenCalled();
  });

  // …and once it IS blind, a capture only counts while the agent is still asking. A stale capture on
  // an agent that has gone back to work says nothing about now.
  it("ignores the capture for a BLIND pane whose agent is no longer asking", async () => {
    scrollbackMock.mockReturnValue(null);
    seedAttentionScreen(MENU3, "working");

    const r = await sendControlKey(AGENT, "enter", ALLOWED);
    expect(r.ok).toBe(true);
  });
});

// A SINGLE BRACKETED LINE IS NOT A MENU (roborev 55170).
describe("the question block is not anchored on ordinary bracketed output", () => {
  // Bash job control prints "[1] 91234"; footnotes print "[1] https://…". Anchoring on the last
  // single bracket-shaped line built the block around THAT and, once it sat further up than the
  // question-context window reaches down, EXCLUDED the question entirely — so the y/n fallback never
  // fired and two different confirmations hashed to the same value. That is the 55166 collision,
  // reopened for the exact shape the fallback existed to cover.
  it("still distinguishes two y/n questions with a stray job-control line above them", () => {
    const filler = Array.from({ length: 12 }, (_, i) => `  compiled module ${i}`);
    const screen = (q: string) => ["$ make deploy &", "[1] 91234", ...filler, q].join("\n");
    scrollbackMock.mockReturnValue(screen("Delete the production database? [y/n] "));
    const danger = readPickerOptions(AGENT);
    scrollbackMock.mockReturnValue(screen("Overwrite config.toml? [y/n] "));
    const benign = readPickerOptions(AGENT);

    expect(danger.present).toBe(true);
    // Constant Approve/Deny either way — only the question can tell them apart.
    expect(benign.options.map((o) => o.label)).toEqual(danger.options.map((o) => o.label));
    expect(benign.fingerprint).not.toBe(danger.fingerprint);
  });
});

// A MOVING TAIL MUST NOT MOVE THE FINGERPRINT (roborev 55170).
//
// pickerFingerprint's own docblock declares a blind tail slice wrong (55163) because volatile
// content makes the read and the press disagree — permanently, since the tail keeps moving. The y/n
// fallback IS a tail slice, so it has to drop what moves or it reproduces that failure.
describe("a y/n fingerprint survives a progress line ticking underneath", () => {
  it("does not change when only a progress counter advances", () => {
    scrollbackMock.mockReturnValue("Overwrite config.toml? [y/n] \nCloning… 47% (3120/6640)");
    const before = readPickerOptions(AGENT);
    scrollbackMock.mockReturnValue("Overwrite config.toml? [y/n] \nCloning… 61% (4051/6640)");
    const after = readPickerOptions(AGENT);

    expect(before.present).toBe(true);
    expect(after.fingerprint).toBe(before.fingerprint);
  });

  it("so the press is not refused as `changed` by a counter that moved", async () => {
    scrollbackMock.mockReturnValue("Overwrite config.toml? [y/n] \nCloning… 47% (3120/6640)");
    const fp = readPickerOptions(AGENT).fingerprint;
    scrollbackMock.mockReturnValue("Overwrite config.toml? [y/n] \nCloning… 61% (4051/6640)");

    const r = await selectPickerOption(AGENT, 0, fp, ALLOWED);
    expect(r.ok).toBe(true);
  });
});

// THE SAME CLAIM LIVES IN TWO PACKAGES (roborev 55171).
//
// `sparkle_terminal`'s mcp-control description and this array's `send_control_key` descriptor are
// both model-facing copies of the picker-refusal rule, and the commit that caveated one of them
// introduced the UNCAVEATED form into the other. Nothing pinned this side — the only existing
// assertion is `description.length > 20`, which every wording satisfies. `server.test.ts` pins the
// mcp-control string; this pins its twin, so the two cannot diverge again.
describe("the send_control_key descriptor states the refusal honestly", () => {
  const descriptor = () => {
    const d = CONCIERGE_TERMINAL_TOOLS.find((t) => t.name === "send_control_key");
    expect(d).toBeDefined();
    return d!.description;
  };

  it("does not promise the refusal unconditionally", () => {
    const d = descriptor();
    expect(d).toMatch(/EVIDENCE-BASED/);
    expect(d).toMatch(/Never infer safety from it/);
  });

  // THE CONDITION CLAUSE IS THE PART THAT WENT STALE (roborev 55179). Every other assertion here —
  // EVIDENCE-BASED, "Never infer safety" — was satisfied verbatim by the mcp-control wording that
  // still described the guard's PRE-fix union semantics. What distinguishes the two is when the
  // capture counts, so that is what has to be pinned, in both packages.
  it("states the live-first condition, not a union of the two sources", () => {
    const d = descriptor();
    // POSITIVE assertions carry this, mirroring server.test.ts. Resting on an exact-phrase negative
    // is the fail-open-inside-the-catcher shape again: a paraphrase of the union rule slips past a
    // negative while the fail-open clause still matches, and the pin reports success (roborev 55185).
    expect(d).toMatch(/LIVE screen when the app can read it/);
    expect(d).toMatch(/still asking/);
    expect(d).toMatch(/is not currently asking/);
    // Kept as a backstop, not as the load-bearing assertion.
    expect(d).not.toMatch(/or on the screen captured/);
  });

  it("says what the keys it does NOT refuse commit while a dialog is up", () => {
    const d = descriptor();
    expect(d).toMatch(/esc DECLINES/);
    expect(d).toMatch(/shift\+tab changes the permission mode/);
    // The claim this replaced, in any of the forms it has been written in.
    expect(d).not.toMatch(/declining is safe|esc still works/);
  });
});

// THE BLOCK IS THE LIVE DIALOG, AND BOTH HALVES DESCRIBE IT (roborev 55172, 55245, 55258).
//
// Two properties, and the second one is why the first is not enough on its own:
//
//   PARITY — the option shape and the question must describe the SAME block. If they describe
//   different ones the fingerprint is incoherent rather than merely stale, and nothing can catch
//   that. `genericMenuRun` is the single definition, so they cannot diverge.
//
//   AND THE RIGHT BLOCK — parity alone is only safe once the shared rule is correct. Adopting a
//   longest-run rule made both halves describe a numbered PLAN printed above the live menu, which
//   excluded the live question from the hash entirely: two different prompts then matched, and a
//   press that had been refused became allowed. A menu is only a menu when the last line asks a
//   choice, so the live dialog is the run nearest that prompt.
describe("the fingerprint describes the LIVE menu, not a numbered list above it", () => {
  const plan = ["Here's the plan:", "1. Read the config", "2. Patch the parser", "3. Run the suite"];
  const live = (q: string) => [q, "  1) Yes", "  2) No", "Enter your choice: "];

  it("offers the LIVE menu's options, not the longer list's", () => {
    scrollbackMock.mockReturnValue([...plan, ...live("Delete the production database?")].join("\n"));
    const r = readPickerOptions(AGENT);

    // Two options, because the live menu has two — a third would let the caller press "3" into a
    // prompt that does not have it.
    expect(r.options.map((o) => o.label)).toEqual(["1", "2"]);
  });

  it("puts the LIVE question in the fingerprint, so two prompts do not match", () => {
    scrollbackMock.mockReturnValue([...plan, ...live("Delete the production database?")].join("\n"));
    const danger = readPickerOptions(AGENT);
    scrollbackMock.mockReturnValue([...plan, ...live("Overwrite config.toml?")].join("\n"));
    const benign = readPickerOptions(AGENT);

    expect(danger.fingerprint).not.toBe("");
    expect(benign.fingerprint).not.toBe(danger.fingerprint);
  });

  it("refuses the press when the live question changed under an identical list", async () => {
    scrollbackMock.mockReturnValue([...plan, ...live("Delete the production database?")].join("\n"));
    const stale = readPickerOptions(AGENT).fingerprint;
    scrollbackMock.mockReturnValue([...plan, ...live("Overwrite config.toml?")].join("\n"));

    const r = await selectPickerOption(AGENT, 0, stale, ALLOWED);
    expect([r.ok, r.reason]).toEqual([false, "changed"]);
    expect(writePtyChainedStrict).not.toHaveBeenCalled();
  });
});

// THE SAME DEADLOCK, ONE PATH OVER (roborev 55204).
//
// "Ask the parser, don't re-derive" was applied to the Claude Code picker and NOT to the generic
// menu, whose locator kept the stricter adjacency rule — while the detector's generic path collects
// numbers across the whole tail and does not break on intervening lines. So a generic menu with a
// wrapped option row returned options and no block: fingerprint "", every press refused forever.
describe("a GENERIC menu with a described option row is still answerable", () => {
  const menu = (q: string) => [
    q,
    "  1) Use the existing one",
    "     keeps the current schema",
    "  2) Write a new one",
    "Enter your choice: ",
  ];

  it("produces a real fingerprint, not the refusal sentinel", () => {
    scrollbackMock.mockReturnValue(menu("Which migration?").join("\n"));
    const r = readPickerOptions(AGENT);

    expect(r.present).toBe(true);
    expect(r.fingerprint).not.toBe("");
  });

  it("still tells two different questions apart", () => {
    scrollbackMock.mockReturnValue(menu("Which migration for billing?").join("\n"));
    const a = readPickerOptions(AGENT);
    scrollbackMock.mockReturnValue(menu("Which migration for auth?").join("\n"));
    const b = readPickerOptions(AGENT);

    expect(b.fingerprint).not.toBe(a.fingerprint);
  });

  it("lets the press through when the menu has not moved", async () => {
    scrollbackMock.mockReturnValue(menu("Which migration?").join("\n"));
    const fp = readPickerOptions(AGENT).fingerprint;

    const r = await selectPickerOption(AGENT, 0, fp, ALLOWED);
    expect(r.ok).toBe(true);
  });
});

// A FOOTER THE DETECTOR NEVER READ MUST NOT BECOME THE ANCHOR (roborev 55195).
describe("a stale picker beyond the detector's window does not anchor a live generic menu", () => {
  const FOOTER = "Enter to select · ↑/↓ to navigate · Esc to cancel";
  // An answered Claude Code picker ~60 non-empty lines up: outside the 50-line window
  // `parsePickerOptions` reads, so the detector definitively did not use it and fell through to the
  // GENERIC menu path — whose labels are the bare numbers, a global constant. Anchoring on that
  // stale footer hashed the stale dialog's question, so two different live menus collided.
  const stale = ["Pick a strategy:", "  1. Rebase", "  2. Merge", FOOTER];
  const filler = Array.from({ length: 60 }, (_, i) => `  compiled module ${i}`);
  const live = (q: string) => [q, "  1) Yes", "  2) No", "Enter your choice: "];

  it("tells two different live menus apart", () => {
    scrollbackMock.mockReturnValue([...stale, ...filler, ...live("Delete the database?")].join("\n"));
    const danger = readPickerOptions(AGENT);
    scrollbackMock.mockReturnValue([...stale, ...filler, ...live("Overwrite config?")].join("\n"));
    const benign = readPickerOptions(AGENT);

    expect(danger.present).toBe(true);
    expect(benign.options.map((o) => o.label)).toEqual(danger.options.map((o) => o.label));
    expect(benign.fingerprint).not.toBe(danger.fingerprint);
    expect(danger.fingerprint).not.toBe("");
  });
});

// THE CAP MUST DROP THE OPTIONS, NOT THE QUESTION (roborev 55204).
//
// The block runs question-first, option-rows-last, and the OPTIONS are already in the fingerprint's
// other half (the button shape). The question is the only material this half contributes — so
// capping from the END dropped precisely the part that distinguishes one ask from another, and a
// long menu's two different questions collapsed to the same value.
describe("a dialog long enough to hit the block cap", () => {
  const FOOTER = "Enter to select · ↑/↓ to navigate · Esc to cancel";
  // Sized so the block exceeds QUESTION_BLOCK_MAX_LINES: the question sits inside the
  // QUESTION_CONTEXT_LINES window above the rows, then twelve option rows carry it past the cap.
  const screen = (q: string) =>
    [
      "Claude wants your input:",
      q,
      ...Array.from({ length: 8 }, (_, i) => `  context line ${i}`),
      ...Array.from({ length: 12 }, (_, i) => `  ${i + 1}. option ${i + 1}`),
      FOOTER,
    ].join("\n");

  it("still tells two different questions apart", () => {
    scrollbackMock.mockReturnValue(screen("Delete the production database?"));
    const danger = readPickerOptions(AGENT);
    scrollbackMock.mockReturnValue(screen("Overwrite config.toml?"));
    const benign = readPickerOptions(AGENT);

    expect(danger.present).toBe(true);
    // Identical option shape either way — only the question separates them.
    expect(benign.options.map((o) => o.label)).toEqual(danger.options.map((o) => o.label));
    expect(benign.fingerprint).not.toBe(danger.fingerprint);
  });

  it("refuses a press whose question changed under an identical long dialog", async () => {
    scrollbackMock.mockReturnValue(screen("Delete the production database?"));
    const stale = readPickerOptions(AGENT).fingerprint;
    scrollbackMock.mockReturnValue(screen("Overwrite config.toml?"));

    const r = await selectPickerOption(AGENT, 0, stale, ALLOWED);
    expect([r.ok, r.reason]).toEqual([false, "changed"]);
    expect(writePtyChainedStrict).not.toHaveBeenCalled();
  });
});

// A LINE THE DETECTOR SKIPS MUST NOT BREAK THE RUN (roborev 55218).
//
// PICKER_OPTION_LINE accepts forms MENU_LINE rejects — a `>`/`❯` prefix, a `·` delimiter, space
// before the delimiter. A prose line like `> 4. see the migration guide` therefore counted as an
// option hit here while the detector skipped it, which reset the run: no block, empty fingerprint,
// every press refused forever. The adjacency deadlock surviving one regex over.
describe("a numbered line the detector ignores does not deadlock the menu", () => {
  const menu = (q: string) => [
    q,
    "  1) Use the existing one",
    "  > 4. see the migration guide for background",
    "  2) Write a new one",
    "Enter your choice: ",
  ];

  it("still produces a real fingerprint", () => {
    scrollbackMock.mockReturnValue(menu("Which migration?").join("\n"));
    const r = readPickerOptions(AGENT);

    expect(r.present).toBe(true);
    expect(r.fingerprint).not.toBe("");
  });

  it("still tells two different questions apart", () => {
    scrollbackMock.mockReturnValue(menu("Which migration for billing?").join("\n"));
    const a = readPickerOptions(AGENT);
    scrollbackMock.mockReturnValue(menu("Which migration for auth?").join("\n"));
    const b = readPickerOptions(AGENT);

    expect(b.fingerprint).not.toBe(a.fingerprint);
  });

  it("lets the press through", async () => {
    scrollbackMock.mockReturnValue(menu("Which migration?").join("\n"));
    const fp = readPickerOptions(AGENT).fingerprint;

    const r = await selectPickerOption(AGENT, 0, fp, ALLOWED);
    expect(r.ok).toBe(true);
  });
});

// A DEEP DIALOG UNDER A PILE OF CHROME (roborev 55182).
//
// The first window was 24 RAW lines, derived from TAIL_LINES — which governs only the GENERIC menu
// fallback. detectClaudeCodePicker runs first and searches PICKER_WINDOW (50) non-empty lines for
// the footer with PICKER_SPAN (30) above it, so the detector could return options whose rows sat far
// outside the window this looked at. When that happened `optionRun` found nothing and control fell
// into the y/n branch, which hashed the last two lines — the Ink chrome BELOW the dialog. Both
// failure directions follow: the chrome ticks and the press is refused forever, or the chrome is
// settled and two different commands share a fingerprint.
describe("a Bash-approval dialog buried under chrome is still fingerprinted by its question", () => {
  const FOOTER = "Enter to select · ↑/↓ to navigate · Esc to cancel";
  // The option shape is a GLOBAL CONSTANT for this dialog — every Bash approval renders the same
  // three. Only the command distinguishes one from the next.
  const dialog = (command: string) => [
    "Claude wants to run a command:",
    `  ${command}`,
    "",
    "Do you want to proceed?",
    "  1. Yes",
    "  2. Yes, and don't ask again for this command",
    "  3. No, and tell Claude what to do differently",
    FOOTER,
  ];
  // Ink keeps rendering below the dialog: the task checklist, the composer, the hint line.
  const chrome = Array.from({ length: 25 }, (_, i) => `  ☐ task ${i} pending`);

  it("tells two different commands apart", () => {
    scrollbackMock.mockReturnValue([...dialog("git status"), ...chrome].join("\n"));
    const benign = readPickerOptions(AGENT);
    scrollbackMock.mockReturnValue([...dialog("rm -rf build/"), ...chrome].join("\n"));
    const danger = readPickerOptions(AGENT);

    expect(benign.present).toBe(true);
    expect(danger.options.map((o) => o.label)).toEqual(benign.options.map((o) => o.label));
    expect(benign.fingerprint).not.toBe(danger.fingerprint);
    // …and neither is the "cannot fingerprint" sentinel, which would be a refusal rather than a read.
    expect(benign.fingerprint).not.toBe("");
  });

  it("refuses to press Yes on rm -rf with a fingerprint read from git status", async () => {
    scrollbackMock.mockReturnValue([...dialog("git status"), ...chrome].join("\n"));
    const fromBenign = readPickerOptions(AGENT).fingerprint;
    scrollbackMock.mockReturnValue([...dialog("rm -rf build/"), ...chrome].join("\n"));

    const r = await selectPickerOption(AGENT, 0, fromBenign, ALLOWED);
    expect([r.ok, r.reason]).toEqual([false, "changed"]);
    expect(writePtyChainedStrict).not.toHaveBeenCalled();
  });

  // …and it stays stable while only the chrome moves, so the press is not refused forever.
  it("is unchanged when only the chrome below the dialog ticks", () => {
    scrollbackMock.mockReturnValue([...dialog("git status"), ...chrome].join("\n"));
    const before = readPickerOptions(AGENT).fingerprint;
    scrollbackMock.mockReturnValue(
      [...dialog("git status"), ...chrome.map((c) => c.replace("pending", "running"))].join("\n"),
    );
    expect(readPickerOptions(AGENT).fingerprint).toBe(before);
  });
});

// NORMALISE WHAT MOVES; KEEP WHAT DISTINGUISHES (roborev 55172).
//
// Dropping a whole volatile line was worse than the bug it fixed: the patterns match ordinary
// question text, so a question stating a SIZE lost the only content that identified it.
describe("a question that states a size or a percentage is still fingerprinted", () => {
  it("keeps two size-bearing questions apart", () => {
    scrollbackMock.mockReturnValue("Delete 2.3 GB of build artifacts? [y/n] ");
    const a = readPickerOptions(AGENT);
    scrollbackMock.mockReturnValue("Overwrite 1.1 GB dataset? [y/n] ");
    const b = readPickerOptions(AGENT);

    expect(a.present).toBe(true);
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });

  it("but ignores the size CHANGING inside an otherwise identical question", () => {
    scrollbackMock.mockReturnValue("Downloading 2.3 GB — continue? [y/n] ");
    const a = readPickerOptions(AGENT);
    scrollbackMock.mockReturnValue("Downloading 2.9 GB — continue? [y/n] ");
    const b = readPickerOptions(AGENT);

    expect(b.fingerprint).toBe(a.fingerprint);
  });
});

// THE LOCATOR MUST FOLLOW THE DETECTOR'S OWN DECISION (roborev 55182).
//
// A numbered list sitting above a y/n question is a perfectly legal option run. Searching for one
// independently anchors the block on the LIST while the detector returned Approve/Deny — so two
// different y/n questions under the same list hash identically. Same collision as 55166, third route.
describe("a numbered list above a y/n question does not steal the anchor", () => {
  const list = ["Here's what I found:", "  1. auth.ts is stale", "  2. billing.ts is fine"];

  it("still tells two y/n questions apart", () => {
    scrollbackMock.mockReturnValue([...list, "Delete the production database? [y/n] "].join("\n"));
    const danger = readPickerOptions(AGENT);
    scrollbackMock.mockReturnValue([...list, "Overwrite config.toml? [y/n] "].join("\n"));
    const benign = readPickerOptions(AGENT);

    expect(danger.present).toBe(true);
    // The detector returned the constant Approve/Deny pair for both…
    expect(danger.options.map((o) => o.label)).toEqual(["Approve", "Deny"]);
    expect(benign.options.map((o) => o.label)).toEqual(danger.options.map((o) => o.label));
    // …so only the question can separate them, and it does.
    expect(benign.fingerprint).not.toBe(danger.fingerprint);
  });

  it("refuses the press when only the question changed under the same list", async () => {
    scrollbackMock.mockReturnValue([...list, "Delete the production database? [y/n] "].join("\n"));
    const stale = readPickerOptions(AGENT).fingerprint;
    scrollbackMock.mockReturnValue([...list, "Overwrite config.toml? [y/n] "].join("\n"));

    const r = await selectPickerOption(AGENT, 0, stale, ALLOWED);
    expect([r.ok, r.reason]).toEqual([false, "changed"]);
    expect(writePtyChainedStrict).not.toHaveBeenCalled();
  });
});

// CANNOT LOCATE IS NOT THE SAME AS NO QUESTION (roborev 55182).
//
// The sentinel is defence in depth: `liveRegion` and the detector now search the same region by
// construction, so reaching it means they have drifted. Producing a fingerprint over the option
// shape alone would be worse than producing none — for both shapes that get here (numbered menus,
// and the constant Approve/Deny pair) that shape is a global constant.
describe("an unlocatable dialog refuses rather than hashing chrome", () => {
  it("select_picker_option refuses the empty sentinel instead of matching '' to ''", async () => {
    // A live menu, so the op gets past `no-picker`…
    scrollbackMock.mockReturnValue(
      ["Select an option:", "  1) Rebase", "  2) Merge", "Enter your choice: "].join("\n"),
    );
    // …but the caller presents the sentinel, which must never satisfy the guard.
    const r = await selectPickerOption(AGENT, 0, "", ALLOWED);
    expect([r.ok, r.reason]).toEqual([false, "unreadable-picker"]);
    expect(writePtyChainedStrict).not.toHaveBeenCalled();
  });
});

// THE LOCATOR MUST NOT BE STRICTER THAN THE PARSER THAT PRODUCED ITS INPUT (roborev 55195).
describe("a picker whose option rows are separated by description lines", () => {
  const FOOTER = "Enter to select · ↑/↓ to navigate · Esc to cancel";
  // `parsePickerOptions` deliberately SKIPS lines between option rows — its own comment says
  // "Most wrapped description lines don't match PICKER_OPTION and are skipped". A strict adjacency
  // rule rejected them, so the detector returned options while the locator returned nothing, the
  // fingerprint became the "" sentinel, and every press refused FOREVER. That is the deadlock the
  // module's own docblock calls out, and it fires on any soft-wrapped label — routine in a narrow
  // pane.
  const dialog = (q: string) => [
    q,
    "❯ 1. Use the existing migration",
    "     keeps the current schema",
    "  2. Write a new one",
    "     regenerates from the models",
    FOOTER,
  ];

  it("is still answerable — the fingerprint is not the refusal sentinel", () => {
    scrollbackMock.mockReturnValue(dialog("Migration strategy for billing?").join("\n"));
    const r = readPickerOptions(AGENT);

    expect(r.present).toBe(true);
    expect(r.fingerprint).not.toBe("");
  });

  it("still tells two different questions apart", () => {
    scrollbackMock.mockReturnValue(dialog("Migration strategy for billing?").join("\n"));
    const a = readPickerOptions(AGENT);
    scrollbackMock.mockReturnValue(dialog("Migration strategy for auth?").join("\n"));
    const b = readPickerOptions(AGENT);

    expect(b.fingerprint).not.toBe(a.fingerprint);
  });

  it("lets the press through when the menu has not moved", async () => {
    scrollbackMock.mockReturnValue(dialog("Migration strategy for billing?").join("\n"));
    const fp = readPickerOptions(AGENT).fingerprint;

    const r = await selectPickerOption(AGENT, 0, fp, ALLOWED);
    expect(r.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// QUITTING AN ALTERNATE SCREEN (bead sparkle-w11lll)
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// Two agents were found WEDGED on an alternate screen with every automated route shut: the
// dispatcher refuses all text there, the goal auto-resume burns its retry budget taking that same
// refusal, and `q` — the one key that quits a pager — was not in `send_control_key`'s vocabulary.
//
// THE DIAGNOSIS IS UNSETTLED, and these tests exist because of that. Both wedged screens showed a
// viewport on `$CLAUDE_CONFIG_DIR/plans/*.md`, and no pager is invoked anywhere in this repo. So
// either a real `less` was open (H1), or it was CLAUDE CODE'S OWN plan surface and
// `isClaudeCodeScreen` failed to recognise it (H2). An escape hatch gated only on
// `!isClaudeCodeScreen` would, under H2, press `q` into a Claude Code plan dialog.
//
// Every assertion below is on the SIDE EFFECT — the bytes that reached the PTY, or did not. A test
// that only checked `ok: false` would pass against an implementation that wrote `q` and then
// mislabelled the result, which is the exact failure this op must not have.
describe("quit_alternate_screen", () => {
  const Q = "\x71";
  const CTRL_C = "\x03";

  /** Install a viewport for AGENT. Returns a setter so a case can change what the NEXT read sees —
   *  which is how the escalation cases model "q worked" vs "q did nothing". */
  function mountScreen(text: string, alternateBuffer: boolean) {
    let cur = { text, alternateBuffer };
    registerViewport(AGENT, () => cur);
    return (next: Partial<typeof cur>) => {
      cur = { ...cur, ...next };
    };
  }

  /** The bytes this op actually put on the wire, in order. Nothing else in these cases writes, so an
   *  empty array is a real "wrote nothing" rather than a filtered view of one. */
  const written = () => vi.mocked(writePtyChainedStrict).mock.calls.map(([, bytes]) => bytes);

  /** A plan dialog whose option block has scrolled UP while the agent kept printing beneath it.
   *
   *  THE GATE-4 SCREEN, and a realistic one: it is what the incident's own description — a scrolling
   *  viewport over a plan file — looks like. `isClaudeCodeScreen` and `hasClaudeCodeLiveTui` are both
   *  FALSE on it (no composer box, no grid-terminating footer) and `screenOffersAnswer` is FALSE too
   *  (the footer has genuine new output below it). So gates 1-3 all pass and ONLY the plan predicate
   *  stands between this screen and a `q` — no stubbing required to isolate it. */
  const scrolledPast = (dialog: string) =>
    [
      dialog,
      "Reading terminal.ts",
      "Read 1637 lines of it, then patched the registry.",
      "The descriptor prose is hand written, so it took a while.",
      "Then I wired the policy risk map.",
      "Then the activity line and the receipt classifier.",
      "Then the mcp-control op list.",
      "Then the hand written server description.",
      "Then I ran the typechecker.",
      "It came back clean on the first pass.",
      "Now writing the tests.",
      "",
    ].join("\n");

  const PLAN_EXIT_SCROLLED_PAST = scrolledPast(PLAN_EXIT_PROMPT);
  const PLAN_OLD_SHAPE_SCROLLED_PAST = scrolledPast(PLAN_EXIT_PROMPT_OLD_SHAPE);

  beforeEach(() => {
    seedAgent();
    resetViewportRegistry();
    vi.mocked(isClaudeCodeScreen).mockImplementation(REAL_SCREEN.isClaudeCodeScreen);
    vi.mocked(hasClaudeCodeLiveTui).mockImplementation(REAL_SCREEN.hasClaudeCodeLiveTui);
  });
  afterEach(() => resetViewportRegistry());

  // ── 1. THE SCREEN THIS OP EXISTS FOR ────────────────────────────────────────────────────────
  it("presses q on a real pager, and only q when the pager quits", async () => {
    const set = mountScreen(LESS_ON_A_MARKDOWN_FILE, true);
    vi.mocked(writePtyChainedStrict).mockImplementation(async () => {
      // `less` leaves the alternate buffer the moment it sees q. Modelling that here is what makes
      // the ctrl+c assertion below meaningful rather than a coincidence of ordering.
      set({ alternateBuffer: false, text: "$ " });
    });
    const r = await quitAlternateScreen(AGENT, ALLOWED);
    expect(written()).toEqual([Q]);
    expect([r.ok, r.cleared, r.sent]).toEqual([true, true, ["q"]]);
    // A key is bytes, not a line — it must never get submitPrompt's bracketed-paste + CR framing.
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  // ── 2. A CLAUDE CODE PERMISSION DIALOG — NOTHING WRITTEN ────────────────────────────────────
  it("writes NOTHING into a Claude Code permission dialog", async () => {
    mountScreen(APPROVAL_2_1_220, true);
    const r = await quitAlternateScreen(AGENT, ALLOWED);
    expect(written()).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.sent).toEqual([]);
  });

  // …AND STILL NOTHING WHEN CLAUDE CODE RECOGNITION IS TOTALLY BROKEN. This is the H2 shape applied
  // to a permission prompt: both recognition predicates are forced FALSE, so gate 2 is gone
  // entirely, and the refusal has to come from `screenOffersAnswer` — a dialog offers a choice, a
  // pager does not. Asserting the REASON as well as the bytes is what makes this test isolate gate
  // 3: without it, a future change that leaned back on gate 2 would keep it green.
  it("writes nothing into a permission dialog even with isClaudeCodeScreen totally wrong", async () => {
    vi.mocked(isClaudeCodeScreen).mockReturnValue(false);
    vi.mocked(hasClaudeCodeLiveTui).mockReturnValue(false);
    mountScreen(APPROVAL_2_1_220, true);
    const r = await quitAlternateScreen(AGENT, ALLOWED);
    expect(written()).toEqual([]);
    expect(r.reason).toBe("offers-an-answer");
  });

  // ── 3. THE PLAN SURFACE — THE MOST IMPORTANT CASE IN THIS UNIT ──────────────────────────────
  it("writes NOTHING into Claude Code's plan-exit dialog", async () => {
    mountScreen(PLAN_EXIT_PROMPT, true);
    const r = await quitAlternateScreen(AGENT, ALLOWED);
    expect(written()).toEqual([]);
    expect(r.ok).toBe(false);
  });

  // THE H2 REGRESSION TEST. If `isClaudeCodeScreen` had recognised the wedged screens, the write
  // would never have been refused as `alternate-screen` in the first place — so under H2 the
  // predicate is WRONG on exactly the screen this op is pointed at. Both recognition predicates are
  // forced false here, which is a stronger break than H2 requires, and `q` must STILL not go out.
  it("writes nothing into a plan dialog when Claude Code recognition returns FALSE (H2)", async () => {
    vi.mocked(isClaudeCodeScreen).mockReturnValue(false);
    vi.mocked(hasClaudeCodeLiveTui).mockReturnValue(false);
    mountScreen(PLAN_EXIT_PROMPT, true);
    const r = await quitAlternateScreen(AGENT, ALLOWED);
    expect(written()).toEqual([]);
    expect(r.ok).toBe(false);
    // Gate 3 caught it, with gate 2 removed — which is the property the whole design rests on.
    expect(r.reason).toBe("offers-an-answer");
  });

  // GATE 4 STANDING ALONE, with NO stub at all. On these two screens gates 1-3 genuinely pass —
  // Claude Code recognition is false because the dialog no longer terminates the grid, and
  // `screenOffersAnswer` is false because there is real output below the footer. The only thing
  // holding a `q` back is the plan predicate.
  it.each([
    ["the current plan-exit shape", PLAN_EXIT_SCROLLED_PAST],
    ["the older keep-planning shape", PLAN_OLD_SHAPE_SCROLLED_PAST],
  ])("writes nothing on a plan dialog that has scrolled past — %s", async (_name, screen) => {
    mountScreen(screen, true);
    const r = await quitAlternateScreen(AGENT, ALLOWED);
    expect(written()).toEqual([]);
    expect(r.reason).toBe("plan-mode-surface");
  });

  // ── 4. GATE 1 ALONE — the buffer-mode bit ───────────────────────────────────────────────────
  // The pager TEXT with the buffer bit false. Every other gate passes, so this case can only be
  // green because the buffer check refused: Claude Code draws its prompt and its dialogs on the
  // NORMAL buffer, which is why gate 1 alone already excludes all of them.
  it("writes nothing when the terminal is on the NORMAL buffer, pager text or not", async () => {
    mountScreen(LESS_ON_A_MARKDOWN_FILE, false);
    const r = await quitAlternateScreen(AGENT, ALLOWED);
    expect(written()).toEqual([]);
    expect(r.reason).toBe("normal-buffer");
  });

  // ── 5. GATE 2 ALONE — a screen isClaudeCodeScreen accepts ───────────────────────────────────
  // An idle Claude Code pane after a turn: it offers no choice and is no plan surface, so gates 3
  // and 4 both pass on it. Only the recognition predicate refuses. (It is also the measured shape
  // behind the founder's rule that Claude Code can hold the alternate buffer at a bare idle prompt —
  // which is why this op must refuse it rather than "helpfully" quitting it.)
  it("writes nothing on a screen Claude Code owns, even though it offers no answer", async () => {
    mountScreen(IDLE_AFTER_TURN_2_1_220, true);
    const r = await quitAlternateScreen(AGENT, ALLOWED);
    expect(written()).toEqual([]);
    expect(r.reason).toBe("claude-code-screen");
  });

  // ── 6. ESCALATION, BOTH DIRECTIONS ──────────────────────────────────────────────────────────
  it("escalates to ctrl+c when q leaves the terminal on the alternate buffer", async () => {
    // `vim` ignores q. Nothing changes between reads, which is exactly the wedged case.
    mountScreen(VIM_ON_A_MARKDOWN_FILE, true);
    const r = await quitAlternateScreen(AGENT, ALLOWED);
    expect(written()).toEqual([Q, CTRL_C]);
    // AND IT DOES NOT CLAIM SUCCESS. Both keys went out and the screen never cleared; saying so is
    // the useful answer, and looping would be the useless one.
    expect([r.ok, r.cleared, r.reason]).toEqual([false, false, "still-alternate"]);
  });

  it("does NOT send ctrl+c once q has cleared the alternate screen", async () => {
    const set = mountScreen(LESS_ON_A_MARKDOWN_FILE, true);
    vi.mocked(writePtyChainedStrict).mockImplementationOnce(async () => {
      set({ alternateBuffer: false, text: "$ " });
    });
    await quitAlternateScreen(AGENT, ALLOWED);
    expect(written()).toEqual([Q]);
    expect(written()).not.toContain(CTRL_C);
  });

  // A SCREEN THAT CHANGED UNDER US IS RE-GATED, NOT ESCALATED INTO. If the pager exits straight
  // into a Claude Code dialog that itself holds the alternate buffer, escalating on the verdict from
  // BEFORE the q would put ctrl+c into that dialog — the H2 mistake, one step later.
  it("re-runs every gate against a FRESH snapshot before escalating", async () => {
    const set = mountScreen(LESS_ON_A_MARKDOWN_FILE, true);
    vi.mocked(writePtyChainedStrict).mockImplementationOnce(async () => {
      set({ text: APPROVAL_2_1_220 });
    });
    const r = await quitAlternateScreen(AGENT, ALLOWED);
    expect(written()).toEqual([Q]);
    expect(written()).not.toContain(CTRL_C);
    expect(r.reason).toBe("claude-code-screen");
  });

  // ── THE SHARED GATES, which this op does not get a lesser version of ────────────────────────
  it("refuses without a valid authority, and writes nothing", async () => {
    mountScreen(LESS_ON_A_MARKDOWN_FILE, true);
    const r = await quitAlternateScreen(AGENT, null as never);
    expect([r.ok, r.reason]).toEqual([false, "unauthorized"]);
    expect(written()).toEqual([]);
  });

  it("refuses an unknown agent, and a cloud agent, without writing", async () => {
    mountScreen(LESS_ON_A_MARKDOWN_FILE, true);
    expect((await quitAlternateScreen("nope", ALLOWED)).reason).toBe("unknown-agent");
    seedAgent("cloud");
    expect((await quitAlternateScreen(AGENT, ALLOWED)).reason).toBe("cloud-agent");
    expect(written()).toEqual([]);
  });

  // BLIND IS A REFUSAL, never an empty screen — `getAgentViewport`'s own rule. A write decided on no
  // evidence is the shape this whole module exists to avoid.
  it("refuses when this window cannot see the terminal at all", async () => {
    const r = await quitAlternateScreen(AGENT, ALLOWED);
    expect(written()).toEqual([]);
    expect(r.reason).toBe("pane-not-mounted");
  });

  // Only a real PtyGoneError may claim the terminal closed — that sentence is an instruction a human
  // acts on, and a transient IPC failure must not send them to discard a live agent.
  it("reports a vanished PTY as a refusal, and an IPC hiccup as something else", async () => {
    mountScreen(LESS_ON_A_MARKDOWN_FILE, true);
    vi.mocked(writePtyChainedStrict).mockRejectedValueOnce(new PtyGoneError(AGENT));
    expect((await quitAlternateScreen(AGENT, ALLOWED)).reason).toBe("pty-gone");
    vi.mocked(writePtyChainedStrict).mockRejectedValueOnce(new Error("ipc hiccup"));
    const r = await quitAlternateScreen(AGENT, ALLOWED);
    expect(r.reason).toBe("send-failed");
    expect(r.detail).not.toMatch(/terminal has closed/i);
  });

  // ── 7. THE COMPLEMENT INVARIANT ─────────────────────────────────────────────────────────────
  //
  // THE PROPERTY THE WHOLE DESIGN RESTS ON, stated as one sweep: the set of screens where this op
  // may write is a strict SUBSET of the set where `dispatchConciergeAnswer` already refuses ALL text
  // with `alternate-screen`. It can never write where a text write is permitted.
  //
  // Driven through the REAL dispatcher (this suite does not mock `conciergeDispatch`) and the REAL
  // viewport registry, so the two verdicts come from the same screen by the same route. Asserting it
  // per-fixture rather than once means a future fixture that breaks the invariant fails HERE, on the
  // property, instead of silently widening what the op may press into.
  it.each([
    ["a less session", LESS_ON_A_MARKDOWN_FILE],
    ["a vim session", VIM_ON_A_MARKDOWN_FILE],
    ["a permission dialog", APPROVAL_2_1_220],
    ["a bash permission prompt", BASH_PERMISSION_PROMPT],
    ["the plan-exit dialog", PLAN_EXIT_PROMPT],
    ["a plan dialog scrolled past", PLAN_EXIT_SCROLLED_PAST],
    ["an idle Claude Code pane", IDLE_AFTER_TURN_2_1_220],
  ])("may write only where a text send is already refused as alternate-screen — %s", async (_n, screen) => {
    mountScreen(screen, true);
    const quit = await quitAlternateScreen(AGENT, ALLOWED);
    const quitWrote = quit.sent.length > 0;

    vi.mocked(writePtyChainedStrict).mockClear();
    resetViewportRegistry();
    mountScreen(screen, true);
    const send = await sendToAgentTerminal(AGENT, "carry on", ALLOWED);

    if (quitWrote) {
      expect(send.path, `${_n}: quit wrote, so a text send MUST be refused`).toBe("alternate-screen");
    }
    // THE CONTRAPOSITIVE, which is the arm that actually bites. Wherever the dispatcher PERMITTED
    // text — the idle Claude Code pane holding the alternate buffer is exactly that screen — this op
    // must have pressed nothing at all. Asserting only the first arm would leave a widened gate
    // green, because a gate that writes everywhere still satisfies "if it wrote, the send was
    // refused" on the fixtures where the send happens to be refused anyway.
    if (send.path !== "alternate-screen") {
      expect(quit.sent, `${_n}: a text send is permitted here, so quit must press NOTHING`).toEqual([]);
    }
    // Subset, not equality, and deliberately so: the dispatcher refuses `vim` too, and this op does
    // write there. The invariant is one-directional.
  });
});
