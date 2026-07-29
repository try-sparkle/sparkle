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
import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("../trialMeter", () => ({ trialSendAllowed: () => true, recordTrialSend: vi.fn() }));
vi.mock("../history", () => ({ searchHistory: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "") }));
// The attention screen lives on the runtime store, whose real module drags in beads/chief/branch
// polling. Only one field matters here.
// `getAgentStatus` also builds the open-pane set the way `handleGetState` does (in-memory merged
// with the persisted copy), so the two liveness answers cannot diverge — both helpers are stubbed
// here rather than left undefined.
vi.mock("../../stores/runtimeStore", () => ({
  useRuntimeStore: { getState: vi.fn(() => ({ attentionScreen: {}, status: {} })) },
  mergeOpenAgentIds: (inMemory: string[], persisted: string[]) => [
    ...new Set([...inMemory, ...persisted]),
  ],
  readPersistedOpenAgentIds: vi.fn((): string[] => []),
}));

import { invoke } from "@tauri-apps/api/core";
import { submitPrompt, writePtyChainedStrict } from "../../pty";
import { searchHistory } from "../history";
import { useRuntimeStore, readPersistedOpenAgentIds } from "../../stores/runtimeStore";
import { getAgentScrollback } from "../terminalScrollback";
import { useProjectStore } from "../../stores/projectStore";
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
  noteAgentTranscriptPath,
  readAgentTerminal,
  sendToAgentTerminal,
  type AgentTerminalRead,
  type ReadAgentTerminalOptions,
} from "./terminal";

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
    status: status ? { [AGENT]: status } : {},
  } as never);
}

/** Put a captured ask-screen on the runtime store (tier b). */
function seedAttentionScreen(text: string, status = "waiting") {
  runtimeStateMock.mockReturnValue({
    attentionScreen: { [AGENT]: text },
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
    expect(submitPrompt).toHaveBeenCalledWith(AGENT, "run the tests");
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

  // There is no cloud input path, and inventing one here would be a lie. The dispatcher already
  // owns this refusal, so the send goes through it and comes back with the EXISTING label.
  it("returns the existing honest cloud-agent refusal for a cloud agent", async () => {
    seedAgent("cloud");
    const r = await sendToAgentTerminal(AGENT, "hello", ALLOWED);
    expect(r.ok).toBe(false);
    expect(r.path).toBe("cloud-agent");
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
});

// ---------------------------------------------------------------------------------------------
// The registration SEAM. Wiring these onto the MCP surface is another worker's task; all this
// branch owns is a descriptor another module can pick up without importing behaviour.
// ---------------------------------------------------------------------------------------------

describe("CONCIERGE_TERMINAL_TOOLS — the descriptor seam", () => {
  it("describes the three tools this domain owns", () => {
    expect(CONCIERGE_TERMINAL_TOOLS.map((t) => t.name).sort()).toEqual([
      "read_agent_terminal",
      "send_to_agent_terminal",
      "get_agent_status",
    ].sort());
  });

  it("marks exactly the write tool as a write", () => {
    const writes = CONCIERGE_TERMINAL_TOOLS.filter((t) => t.write).map((t) => t.name);
    expect(writes).toEqual(["send_to_agent_terminal"]);
  });

  it("gives every tool a description worth putting in a context window", () => {
    for (const t of CONCIERGE_TERMINAL_TOOLS) expect(t.description.length).toBeGreaterThan(20);
  });
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
