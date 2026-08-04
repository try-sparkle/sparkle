import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AgentKind, AgentTab, Project } from "../types";
import type { AgentTabStatus } from "@sparkle/ui";
import { BLOCKER_ASK, MAX_SILENCE_MS } from "@sparkle/core";

// Re-query talks to PTY agents via submitPrompt. Mock it so the dispatcher's
// routing/filtering is what's under test.
const submitPrompt = vi.fn();
vi.mock("../pty", () => ({
  submitPrompt: (...a: unknown[]) => submitPrompt(...a),
  // A stand-in for the real PtyGoneError: requery.ts does `e instanceof PtyGoneError`, and the
  // tests below construct one to reject with, so both sides must share THIS class (the mocked one).
  PtyGoneError: class PtyGoneError extends Error {
    constructor(readonly id: string) {
      super(`no such pty: ${id}`);
      this.name = "PtyGoneError";
    }
  },
}));
// Silence the failure log so a deliberately-rejecting agent doesn't print to the test output.
const getAgentScrollback = vi.fn<(id: string) => string | null>(() => null);
vi.mock("./terminalScrollback", () => ({
  getAgentScrollback: (id: string) => getAgentScrollback(id),
}));
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  requeryOpenAgents,
  _resetRequeryMemoryForTests,
  shouldRequery,
  claimReconnectRequery,
  requeryOnReconnect,
  REQUERY_PROMPT,
  REQUERY_CLAIM_KEY,
  REQUERY_CLAIM_WINDOW_MS,
} from "./requery";
import type { KV } from "./windowRegistry";
import { PtyGoneError } from "../pty";
import { log } from "../logger";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";

function agent(id: string, kind: AgentKind): AgentTab {
  return {
    id,
    name: id,
    kind,
    parentId: null,
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "",
    promptHistory: [],
    namePinned: false,
    autoNameBasis: null,
    autoNameVariants: null,
    shellCommand: null,
  };
}

function seed(agents: AgentTab[], open: string[], status: Record<string, AgentTabStatus>) {
  const project: Project = {
    id: "p1",
    name: "P1",
    rootPath: "/p1",
    defaultBranch: "main",
    createdAt: "",
    agents,
    selectedAgentId: null,
  };
  useProjectStore.setState({ projects: [project], selectedProjectId: "p1" });
  useRuntimeStore.setState({ openAgentIds: open, status });
}

beforeEach(() => {
  _resetRequeryMemoryForTests();
  submitPrompt.mockReset();
  getAgentScrollback.mockReset();
  getAgentScrollback.mockReturnValue(null);
  vi.mocked(log.error).mockClear();
  vi.mocked(log.debug).mockClear();
});

describe("requeryOpenAgents — PTY (build/worker) agents", () => {
  it("sends the status prompt to an idle build agent", async () => {
    seed([agent("b1", "build")], ["b1"], { b1: "idle" });
    await requeryOpenAgents();
    expect(submitPrompt).toHaveBeenCalledWith("b1", REQUERY_PROMPT, { machine: true });
  });

  it("skips a build agent that is actively working (don't interrupt mid-task)", async () => {
    seed([agent("b1", "build")], ["b1"], { b1: "working" });
    await requeryOpenAgents();
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("skips a 'waiting' agent so we don't answer its on-screen prompt with status text", async () => {
    seed([agent("b1", "build")], ["b1"], { b1: "waiting" });
    await requeryOpenAgents();
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("skips an 'approval' agent — never auto-confirm a pending dangerous action", async () => {
    seed([agent("b1", "build")], ["b1"], { b1: "approval" });
    await requeryOpenAgents();
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("skips agents that are not open", async () => {
    seed([agent("b1", "build")], [], { b1: "idle" });
    await requeryOpenAgents();
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("re-queries worker agents too, not just build agents", async () => {
    seed([agent("w1", "worker")], ["w1"], { w1: "idle" });
    await requeryOpenAgents();
    expect(submitPrompt).toHaveBeenCalledWith("w1", REQUERY_PROMPT, { machine: true });
  });

  it("keeps re-querying the rest when one agent's PTY write fails", async () => {
    seed(
      [agent("b1", "build"), agent("b2", "build")],
      ["b1", "b2"],
      { b1: "idle", b2: "idle" },
    );
    // b1's PTY is gone (e.g. exited) and rejects; b2 must still be re-queried.
    submitPrompt.mockRejectedValueOnce(new Error("pty dead"));
    await expect(requeryOpenAgents()).resolves.toBeUndefined();
    expect(submitPrompt).toHaveBeenCalledWith("b2", REQUERY_PROMPT, { machine: true });
  });
});

describe("requeryOpenAgents — a PtyGoneError is TERMINAL, not a per-reconnect ERROR (sparkle-rsx4)", () => {
  it("marks the agent stopped and does NOT re-query it on a later reconnect pass", async () => {
    // A "done" pane whose underlying process has already exited: its PTY is gone, so the write
    // rejects with PtyGoneError.
    seed([agent("b1", "build")], ["b1"], { b1: "done" });
    submitPrompt.mockRejectedValueOnce(new PtyGoneError("b1"));

    await requeryOpenAgents(); // first reconnect: the PTY is discovered gone
    expect(submitPrompt).toHaveBeenCalledTimes(1);

    // SIDE EFFECT under test: the agent is now marked `stopped` (terminal, not a red error)...
    expect(useRuntimeStore.getState().status.b1).toBe("stopped");

    // ...so a SECOND reconnect must NOT fire another re-query into the dead PTY. Asserting the
    // absence of the second call is what proves the loop actually stops for this agent — the whole
    // point of treating PtyGoneError as terminal (mutation: drop the setStatus and this call fires).
    submitPrompt.mockClear();
    await requeryOpenAgents();
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("logs a PtyGoneError at DEBUG, never ERROR (it is an expected lifecycle race)", async () => {
    seed([agent("b1", "build")], ["b1"], { b1: "done" });
    submitPrompt.mockRejectedValueOnce(new PtyGoneError("b1"));
    await requeryOpenAgents();
    expect(log.error).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalled();
  });

  it("still logs a NON-PtyGone write failure at ERROR (a real failure is not silenced)", async () => {
    seed([agent("b1", "build")], ["b1"], { b1: "idle" });
    submitPrompt.mockRejectedValueOnce(new Error("something genuinely broke"));
    await requeryOpenAgents();
    expect(log.error).toHaveBeenCalled();
    // A generic failure is NOT terminal — the agent keeps its live status, not demoted to stopped.
    expect(useRuntimeStore.getState().status.b1).toBe("idle");
  });

  it("CANCELS a not-yet-sent re-query for an agent torn down mid-pass", async () => {
    // Two open, idle agents. While b1's re-query is in flight (submitPrompt awaits), b2's pane is
    // torn down — window close / worktree removal / spin-down all route through runtimeStore.close(),
    // which drops b2 from openAgentIds. b2's not-yet-sent re-query MUST be cancelled, not fired into
    // the torn-down PTY. Asserting b2 is never called is the side effect; it only holds because the
    // loop re-reads liveness per agent instead of trusting a top-of-pass snapshot (mutation: read the
    // snapshot and b2 gets a re-query).
    seed([agent("b1", "build"), agent("b2", "build")], ["b1", "b2"], { b1: "idle", b2: "idle" });
    submitPrompt.mockImplementationOnce(async () => {
      useRuntimeStore.getState().close("b2");
    });

    await requeryOpenAgents();

    expect(submitPrompt).toHaveBeenCalledWith("b1", REQUERY_PROMPT, { machine: true });
    expect(submitPrompt).not.toHaveBeenCalledWith("b2", REQUERY_PROMPT);
    expect(submitPrompt).toHaveBeenCalledTimes(1);
  });
});

/** Stands in for the localStorage every webview window shares. */
function sharedStore(): KV {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

describe("claimReconnectRequery — one re-query per reconnect, machine-wide", () => {
  it("lets the first caller through", () => {
    expect(claimReconnectRequery(1_000, sharedStore())).toBe(true);
  });

  it("suppresses the other windows recovering from the same reconnect", () => {
    const shared = sharedStore(); // four windows, one machine, one link coming back
    const claims = [0, 60, 90, 800].map((offset) => claimReconnectRequery(1_000 + offset, shared));
    expect(claims).toEqual([true, false, false, false]);
  });

  it("suppresses a flapping link re-crossing the edge inside the window", () => {
    const shared = sharedStore();
    claimReconnectRequery(1_000, shared);
    expect(claimReconnectRequery(1_000 + REQUERY_CLAIM_WINDOW_MS - 1, shared)).toBe(false);
  });

  it("re-queries again once the window has elapsed (a genuinely separate outage)", () => {
    const shared = sharedStore();
    claimReconnectRequery(1_000, shared);
    expect(claimReconnectRequery(1_000 + REQUERY_CLAIM_WINDOW_MS, shared)).toBe(true);
  });

  it("reclaims a stamp from the future so a backwards clock can't wedge re-query off", () => {
    const shared = sharedStore();
    shared.setItem(REQUERY_CLAIM_KEY, String(1_000 + REQUERY_CLAIM_WINDOW_MS - 1));
    expect(claimReconnectRequery(1_000, shared)).toBe(false); // inside the window: still one event
    shared.setItem(REQUERY_CLAIM_KEY, String(5_000_000)); // way ahead — stale, not a live claim
    expect(claimReconnectRequery(1_000, shared)).toBe(true);
  });

  it("reclaims past a garbled value rather than treating it as a live claim", () => {
    const shared = sharedStore();
    shared.setItem(REQUERY_CLAIM_KEY, "not-a-timestamp");
    expect(claimReconnectRequery(1_000, shared)).toBe(true);
  });

  it("falls back to re-querying when the shared storage throws", () => {
    const broken: KV = {
      getItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: () => {},
    };
    expect(claimReconnectRequery(1_000, broken)).toBe(true);
  });
});

describe("requeryOnReconnect — the claim actually gates the prompting", () => {
  it("prompts the open agents when it wins the claim", async () => {
    seed([agent("b1", "build")], ["b1"], { b1: "idle" });
    await requeryOnReconnect(1_000, sharedStore());
    expect(submitPrompt).toHaveBeenCalledWith("b1", REQUERY_PROMPT, { machine: true });
  });

  it("sends nothing at all when another window already claimed the reconnect", async () => {
    seed([agent("b1", "build")], ["b1"], { b1: "idle" });
    const shared = sharedStore();
    await requeryOnReconnect(1_000, shared); // the window that won
    submitPrompt.mockClear();
    await requeryOnReconnect(1_060, shared); // a sibling window, same reconnect
    expect(submitPrompt).not.toHaveBeenCalled();
  });
});

describe("shouldRequery — only the offline→online edge fires", () => {
  it("fires when going from offline to online", () => {
    expect(shouldRequery(false, true)).toBe(true);
  });
  it("does not fire while staying online", () => {
    expect(shouldRequery(true, true)).toBe(false);
  });
  it("does not fire when going offline", () => {
    expect(shouldRequery(true, false)).toBe(false);
  });
  it("does not fire while staying offline", () => {
    expect(shouldRequery(false, false)).toBe(false);
  });
});

describe("what the agent actually receives (sparkle-4cd0x)", () => {
  // EVERY OTHER TEST IN THIS FILE USES `REQUERY_PROMPT` SYMBOLICALLY, so all of them passed against
  // the wording that caused the bug: "can you give me a brief status update on where things stand?"
  // — which four agents answered with a narrative before stopping, several asking a question back.
  //
  // ONE ASSERTION, NOT SIX (roborev 57702). `REQUERY_PROMPT` is a re-export of `BLOCKER_ASK`, so
  // pinning its wording here would re-test `@sparkle/core`'s constant at a second site;
  // `pusherBlocker.test.ts` already pins the content — that it names merging, forbids asking back,
  // carries the fenced block, and contains no digits that could trip the citation gate — at the
  // definition site where a change to it is actually made. What is requery's OWN behaviour, and what
  // no other file can catch, is that this path still sends THAT text rather than reintroducing a
  // status-report prompt of its own.
  it("sends the shared blocker ask, not a status-report prompt of its own", () => {
    expect(REQUERY_PROMPT).toBe(BLOCKER_ASK);
  });
});

describe("the ask is composed, and sometimes it is silence (sparkle-4cd0x)", () => {
  /** Seed one open, idle build agent with a goal state and a branch reading. */
  function seedAgent(over: {
    goalMetAt?: number;
    ahead?: number;
    behind?: number;
    dirty?: boolean;
    status?: AgentTabStatus;
  }) {
    const a = agent("b1", "build");
    if (over.goalMetAt !== undefined) {
      a.goal = {
        text: "land it",
        setAt: 0,
        ttlMs: 3_600_000,
        continues: 0,
        totalContinues: 0,
        metAt: over.goalMetAt,
      };
    }
    seed([a], ["b1"], { b1: over.status ?? "idle" });
    useRuntimeStore.setState({
      branchStatus: {
        b1: {
          ahead: over.ahead ?? 0,
          behind: over.behind ?? 0,
          dirty: over.dirty ?? false,
          filesChanged: 0,
          insertions: 0,
          deletions: 0,
          worktreeOnBranch: true,
        },
      },
    } as never);
  }

  it("ASKS NOTHING the second time, when the agent is finished and nothing has moved", async () => {
    // THE WASTE CASE, end to end. The founder's example: an agent that had already reported
    // done-and-landed, asked anyway, spending a full turn to say "same as last check".
    //
    // The agent's OWN "not-blocked" report is required, not just our inference that it looks
    // finished — see the corroboration rule in `buildAsk` arm 1.
    getAgentScrollback.mockReturnValue(
      "```sparkle-blocker\nblocked: not-blocked\nnext: merged\n```",
    );
    seedAgent({ goalMetAt: 1, ahead: 0, dirty: false });

    await requeryOpenAgents(); // first pass has no prior picture, so it asks once
    expect(submitPrompt).toHaveBeenCalledTimes(1);

    submitPrompt.mockClear();
    await requeryOpenAgents(); // nothing changed, and it looked finished
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("asks again as soon as something actually moves, and leads with it", async () => {
    getAgentScrollback.mockReturnValue(
      "```sparkle-blocker\nblocked: not-blocked\nnext: merged\n```",
    );
    seedAgent({ goalMetAt: 1, ahead: 0, dirty: false });
    await requeryOpenAgents();
    submitPrompt.mockClear();

    seedAgent({ goalMetAt: 1, ahead: 0, dirty: false, behind: 3 }); // main moved under it
    await requeryOpenAgents();

    expect(submitPrompt).toHaveBeenCalledTimes(1);
    const [, sent] = submitPrompt.mock.calls[0]!;
    expect(sent).toContain("main has moved since you last looked");
  });

  it("keeps asking an UNFINISHED agent even when nothing changed", async () => {
    // Silence is only ever correct for the terminal case. An agent holding unlanded work is exactly
    // the one worth asking, and going quiet on it would be the founder's own complaint inverted.
    seedAgent({ ahead: 4, dirty: true });
    await requeryOpenAgents();
    submitPrompt.mockClear();
    await requeryOpenAgents();
    expect(submitPrompt).toHaveBeenCalledTimes(1);
  });

  it("asks an agent whose branch we cannot see — an unknown reading is never 'finished'", async () => {
    // Fail-closed toward asking: the cost of a wrong 'terminal' is an agent that is genuinely stuck
    // and never spoken to again, which is far worse than one wasted turn.
    //
    // EVERY OTHER REASON TO ASK IS REMOVED FIRST, so the branch reading is the only thing left
    // holding the suppression open (roborev 57707). A met goal, and a corroborating "not-blocked"
    // report, and a prior ask — without all three, `buildAsk` declines to go silent for a reason
    // that has nothing to do with the branch, and mutating `ahead === 0 && dirty === false` leaves
    // this green. It did, on the first attempt.
    getAgentScrollback.mockReturnValue(
      "```sparkle-blocker\nblocked: not-blocked\nnext: merged\n```",
    );
    const a = agent("b1", "build");
    a.goal = { text: "land it", setAt: 0, ttlMs: 3_600_000, continues: 0, totalContinues: 0, metAt: 1 };
    seed([a], ["b1"], { b1: "idle" });
    useRuntimeStore.setState({ branchStatus: {} } as never);

    await requeryOpenAgents(); // first contact: always asks, and stamps the silence clock
    submitPrompt.mockClear();

    // Second pass: corroborated, recent, goal met — and the branch is UNREADABLE. That alone must
    // keep it being asked, because an unknown reading is not evidence of a finished agent.
    await requeryOpenAgents();
    expect(submitPrompt).toHaveBeenCalledTimes(1);
  });
});

describe("reading the agent's previous answer back (roborev 57707)", () => {
  const blockedReply =
    "I looked at the failing job.\n\n```sparkle-blocker\nblocked: blocked-on-ci\n" +
    "next: waiting for the lint shard\n```\n";

  it("names the blocker the agent itself reported, instead of asking generically", async () => {
    // The feature the change leads with — "reads the agent's previous answer back out of its
    // terminal" — and it was reachable only in unit tests until this mock existed: no provider is
    // registered without a mounted Terminal, so `getAgentScrollback` returned null for every case
    // and arm 2 was never exercised through the production path.
    getAgentScrollback.mockReturnValue(blockedReply);
    seed([agent("b1", "build")], ["b1"], { b1: "idle" });

    await requeryOpenAgents();

    expect(getAgentScrollback).toHaveBeenCalledWith("b1");
    const [, sent] = submitPrompt.mock.calls[0]!;
    expect(sent).toContain("blocked-on-ci");
    expect(sent).toContain("waiting for the lint shard");
    expect(sent).not.toContain("What is BLOCKING you from merging");
  });

  it("falls back to the canned ask when there is no readable scrollback", async () => {
    getAgentScrollback.mockReturnValue(null);
    seed([agent("b1", "build")], ["b1"], { b1: "idle" });
    await requeryOpenAgents();
    expect(submitPrompt).toHaveBeenCalledWith("b1", BLOCKER_ASK, { machine: true });
  });

  it("BREAKS THE SILENCE after an hour, even on an agent that looked finished", async () => {
    // The bound that stops a wrong `terminal` being permanent. A 529-killed agent presents exactly
    // as finished — met goal, clean branch, nothing ever moving again — so without this it would
    // never be spoken to again.
    getAgentScrollback.mockReturnValue(
      "```sparkle-blocker\nblocked: not-blocked\nnext: merged\n```",
    );
    const a = agent("b1", "build");
    a.goal = { text: "land it", setAt: 0, ttlMs: 3_600_000, continues: 0, totalContinues: 0, metAt: 1 };
    seed([a], ["b1"], { b1: "idle" });
    useRuntimeStore.setState({
      branchStatus: {
        b1: { ahead: 0, behind: 0, dirty: false, filesChanged: 0, insertions: 0, deletions: 0, worktreeOnBranch: true },
      },
    } as never);

    const realNow = Date.now;
    try {
      let clock = 1_000_000;
      Date.now = () => clock; // installed BEFORE the first ask, so every stamp shares this clock

      await requeryOpenAgents();
      expect(submitPrompt).toHaveBeenCalledTimes(1); // first contact always asks

      submitPrompt.mockClear();
      await requeryOpenAgents();
      expect(submitPrompt).not.toHaveBeenCalled(); // corroborated + recent -> silent

      clock += MAX_SILENCE_MS;
      await requeryOpenAgents();
      expect(submitPrompt).toHaveBeenCalledTimes(1); // ...and the silence lapses
    } finally {
      Date.now = realNow;
    }
  });
});
