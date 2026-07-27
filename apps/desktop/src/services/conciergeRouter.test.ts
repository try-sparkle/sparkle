// The router decides where every compose-box send goes now that the user no longer picks. The
// tests that matter most are the ASYMMETRY ones: tier 2 failing, returning garbage, or hanging
// must all resolve to `sparkle`, because that is the direction the user can undo. See
// PRD/sparkle/concierge-auto-routing.md §2.
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  contextLine,
  failureReason,
  invokeClassify,
  looksLikeAnswer,
  looksLikeFleetTalk,
  parseVerdict,
  routeMessage,
  type RouteContext,
} from "./conciergeRouter";
import type { SuggestionButton } from "./suggestions/types";

const opt = (label: string, value: string): SuggestionButton => ({
  id: label,
  label,
  value,
  kind: "terminal",
  source: "heuristic",
});

const YES_NO = [opt("Yes", "y\n"), opt("No", "n\n")];

/** An agent blocked on a question, i.e. in the "answer this now" attention set. */
const blocked: RouteContext = {
  agent: { id: "a1", name: "Kraken Auth", status: "approval", canAcceptInput: true },
};
/** An agent that is running and asking nothing. */
const working: RouteContext = {
  agent: { id: "a1", name: "Kraken Auth", status: "working", canAcceptInput: true },
};

const noOptions = () => [];
const yesNoOptions = () => YES_NO;
/** A classifier that must never be reached.
 *
 *  A bare `throw` here is NOT enough: routeMessage catches everything from tier 2, so a test that
 *  only asserted `target` would pass even though the classifier WAS called. Every use is paired
 *  with `expect(...).not.toHaveBeenCalled()`, which is the assertion that actually holds. */
const unreachable = () =>
  vi.fn(() => {
    throw new Error("classifier should not have been called");
  });

describe("tier 1 — no agent to prompt", () => {
  it("routes to Sparkle when nothing is in view, without classifying", async () => {
    const classify = unreachable();
    const d = await routeMessage("add retry logic", { agent: null }, { classify });
    expect(d).toMatchObject({ target: "sparkle", source: "heuristic" });
    expect(classify).not.toHaveBeenCalled();
  });

  // A cloud agent has no local PTY — dispatchConciergeAnswer refuses it outright, so routing there
  // is a guaranteed failure the user reads as an error.
  it("treats an agent that can't take input as nothing in view", async () => {
    const classify = unreachable();
    const d = await routeMessage(
      "add retry logic",
      { agent: { id: "a1", name: "Cloud Runner", status: "working", canAcceptInput: false } },
      { classify },
    );
    expect(d).toMatchObject({ target: "sparkle", source: "heuristic" });
    expect(classify).not.toHaveBeenCalled();
  });
});

describe("tier 1 — answering the question on screen", () => {
  it.each(["y", "yes", "no", "go ahead", "approve", "2", "Yes"])(
    "routes %j to the agent when it is blocked on a question",
    async (text) => {
      const classify = unreachable();
      const d = await routeMessage(text, blocked, { liveOptions: yesNoOptions, classify });
      expect(d).toMatchObject({ target: "agent", source: "heuristic" });
      expect(classify).not.toHaveBeenCalled();
    },
  );

  // An idle agent is not asking anything, so a bare "yes" to it is conversation, not a keystroke.
  it("does NOT treat a bare yes as a keystroke when the agent isn't blocked", async () => {
    const classify = vi.fn(async () => "sparkle");
    await routeMessage("yes", working, { liveOptions: yesNoOptions, classify });
    expect(classify).toHaveBeenCalledTimes(1);
  });

  // A real instruction that merely opens with a yes-word is not an answer (roborev 46311's lesson,
  // inherited via isTerseAnswer).
  it("does not mistake an instruction for a terse answer", async () => {
    const classify = vi.fn(async () => "agent");
    await routeMessage("yes-but-use-the-other-endpoint instead", blocked, {
      liveOptions: yesNoOptions,
      classify,
    });
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it("survives a terminal read that throws (an unreadable screen is not a failed send)", async () => {
    const classify = unreachable();
    const d = await routeMessage("yes", blocked, {
      liveOptions: () => {
        throw new Error("pty gone");
      },
      classify,
    });
    // Still routed by the BARE_ANSWER rule, which needs no options.
    expect(d.target).toBe("agent");
    expect(classify).not.toHaveBeenCalled();
  });
});

describe("tier 1 — fleet talk", () => {
  it.each([
    "what's going on?",
    "what should I do next",
    "which agents are stuck",
    "how many projects need me",
    "how much have I spent today",
    "status",
    "hey sparkle, summarize",
    "anything need me?",
  ])("routes %j to Sparkle without classifying", async (text) => {
    const classify = unreachable();
    const d = await routeMessage(text, working, { liveOptions: noOptions, classify });
    expect(d).toMatchObject({ target: "sparkle", source: "heuristic" });
    expect(classify).not.toHaveBeenCalled();
  });

  // Conservative by design: merely CONTAINING a fleet word is not fleet talk, it goes to the model.
  it("sends a merely-fleet-flavoured instruction to the classifier instead of guessing", async () => {
    const classify = vi.fn(async () => "agent");
    const d = await routeMessage("add a status endpoint to the API", working, {
      liveOptions: noOptions,
      classify,
    });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(d).toMatchObject({ target: "agent", source: "classified" });
  });
});

describe("tier 2 — the classifier", () => {
  it("gets the agent's name and what it is asking, so it can judge in context", async () => {
    const classify = vi.fn(async (_text: string, _context: string) => "agent");
    await routeMessage("do the thing", blocked, { liveOptions: yesNoOptions, classify });
    const context = classify.mock.calls[0]![1];
    expect(context).toContain("Kraken Auth");
    expect(context).toContain("approval");
    expect(context).toContain("Yes / No");
  });

  it("honours a clear verdict either way", async () => {
    const toAgent = await routeMessage("refactor the parser", working, {
      liveOptions: noOptions,
      classify: async () => "agent",
    });
    expect(toAgent).toMatchObject({ target: "agent", source: "classified" });
    const toSparkle = await routeMessage("is this a good idea", working, {
      liveOptions: noOptions,
      classify: async () => "sparkle",
    });
    expect(toSparkle).toMatchObject({ target: "sparkle", source: "classified" });
  });
});

describe("parseVerdict", () => {
  it("reads a bare verdict", () => {
    expect(parseVerdict("agent")).toBe("agent");
    expect(parseVerdict("sparkle")).toBe("sparkle");
  });

  it("tolerates a chatty model", () => {
    expect(parseVerdict("This is work for the AGENT.\n")).toBe("agent");
    expect(parseVerdict('```\nsparkle\n```')).toBe("sparkle");
  });

  // An answer naming both is not an answer. Deciding it by regex order would silently turn a
  // confused model into a confident misroute.
  it("refuses an ambiguous reply rather than picking by regex order", () => {
    expect(parseVerdict("agent or sparkle, hard to say")).toBeNull();
    expect(parseVerdict("")).toBeNull();
    expect(parseVerdict("I'm not sure")).toBeNull();
  });

  // `/\bsparkle|\bchat\b/` grouped as `(\bsparkle)|(\bchat\b)`, so the trailing boundary applied
  // only to "chat" and inflected forms matched a bare verdict they shouldn't.
  it("requires a word boundary on BOTH sparkle and chat", () => {
    expect(parseVerdict("sparkles")).toBeNull();
    expect(parseVerdict("sparkled")).toBeNull();
    expect(parseVerdict("chatty")).toBeNull();
  });
});

// ── The asymmetry. These are the point of the whole module. ───────────────────────────────────
describe("fallback — always the recoverable direction", () => {
  it("falls back to Sparkle when the classifier throws", async () => {
    const d = await routeMessage("something ambiguous", working, {
      liveOptions: noOptions,
      classify: async () => {
        throw new Error("offline");
      },
    });
    expect(d).toMatchObject({ target: "sparkle", source: "fallback" });
  });

  it("falls back to Sparkle when the classifier returns garbage", async () => {
    const d = await routeMessage("something ambiguous", working, {
      liveOptions: noOptions,
      classify: async () => "¯\\_(ツ)_/¯",
    });
    expect(d).toMatchObject({ target: "sparkle", source: "fallback" });
  });

  it("falls back to Sparkle on an ambiguous verdict", async () => {
    const d = await routeMessage("something ambiguous", working, {
      liveOptions: noOptions,
      classify: async () => "could be the agent, could be sparkle",
    });
    expect(d).toMatchObject({ target: "sparkle", source: "fallback" });
  });

  // The tripwire: no failure mode of tier 2 may ever produce a PTY write.
  it("NEVER falls back to the agent, whatever the classifier does", async () => {
    const badClassifiers = [
      async () => {
        throw new Error("boom");
      },
      async () => "",
      async () => "maybe agent maybe sparkle",
      async () => "42",
    ];
    for (const classify of badClassifiers) {
      const d = await routeMessage("ambiguous text", working, {
        liveOptions: noOptions,
        classify,
      });
      expect(d.target).toBe("sparkle");
    }
  });
});

// An errored agent is STALLED, not asking. There is nothing on screen for a bare "ok" to answer,
// so treating it as a keystroke would be a free-text PTY write in the irreversible direction.
describe("an errored agent is not asking a question", () => {
  const errored: RouteContext = {
    agent: { id: "a1", name: "Kraken Auth", status: "errored", canAcceptInput: true },
  };

  it.each(["ok", "yes", "do it"])(
    "sends %j to the classifier when NOTHING is on screen to answer",
    async (text) => {
      const classify = vi.fn(async () => "sparkle");
      const d = await routeMessage(text, errored, { liveOptions: noOptions, classify });
      expect(classify).toHaveBeenCalledTimes(1);
      expect(d.target).toBe("sparkle");
    },
  );

  // Even WITH options detected on screen. `errored` is screen-derived, so the process is often
  // still running, and the option detector scans a 50-line window — an agent that ANSWERED a
  // picker and then printed an error trace still matches. Typing "2" there would answer a prompt
  // nobody is asking, on a live terminal. One classify is the cheap, reversible alternative
  // (roborev 53104).
  it.each(["2", "Yes", "No"])(
    "still classifies %j rather than writing it into a maybe-stale picker",
    async (text) => {
      const classify = vi.fn(async () => "sparkle");
      const d = await routeMessage(text, errored, { liveOptions: yesNoOptions, classify });
      expect(classify).toHaveBeenCalledTimes(1);
      expect(d.target).toBe("sparkle");
    },
  );

  // A non-answer is still a non-answer, options or not.
  it("does not route a free-text instruction to an errored agent's picker", async () => {
    const classify = vi.fn(async () => "sparkle");
    await routeMessage("rewrite the auth middleware", errored, {
      liveOptions: yesNoOptions,
      classify,
    });
    expect(classify).toHaveBeenCalledTimes(1);
  });

  // The contrast that makes the rule legible: the SAME text on a live ask goes straight through.
  it("routes the same answer straight to the PTY when the agent is genuinely asking", async () => {
    const classify = unreachable();
    const d = await routeMessage("2", blocked, { liveOptions: yesNoOptions, classify });
    expect(d).toMatchObject({ target: "agent", source: "heuristic" });
    expect(classify).not.toHaveBeenCalled();
  });
});

// The gate must fail CLOSED: as an optional field its absence recreated the exact bug it was added
// to fix (roborev 53060). TypeScript now requires it; this pins the runtime behaviour too.
describe("canAcceptInput is a required, fail-closed gate", () => {
  it("refuses to route at an agent whose flag is false", async () => {
    const classify = unreachable();
    const d = await routeMessage(
      "add retry logic",
      { agent: { id: "a1", name: "Cloud", status: "waiting", canAcceptInput: false } },
      { liveOptions: yesNoOptions, classify },
    );
    expect(d.target).toBe("sparkle");
    expect(classify).not.toHaveBeenCalled();
  });

  // Even the strongest tier-1 agent signal — a bare answer to a live ask — must not override it.
  it("refuses even a picker answer when the agent can't take input", async () => {
    const d = await routeMessage(
      "yes",
      { agent: { id: "a1", name: "Cloud", status: "approval", canAcceptInput: false } },
      { liveOptions: yesNoOptions, classify: unreachable() },
    );
    expect(d.target).toBe("sparkle");
  });
});

describe("tier 2 — the deadline", () => {
  it("stops waiting on a hung classifier and falls back to Sparkle", async () => {
    const d = await routeMessage(
      "something ambiguous",
      working,
      { liveOptions: noOptions, classify: () => new Promise<string>(() => {}), deadlineMs: 20 },
    );
    expect(d).toMatchObject({ target: "sparkle", source: "fallback" });
    expect(d.reason).toMatch(/too long/i);
  });

  it("still honours a classifier that answers inside the deadline", async () => {
    const d = await routeMessage("something ambiguous", working, {
      liveOptions: noOptions,
      classify: () => new Promise<string>((r) => setTimeout(() => r("agent"), 5)),
      deadlineMs: 200,
    });
    expect(d).toMatchObject({ target: "agent", source: "classified" });
  });
});

// A swallowed failure is invisible twice: the user gets a chat answer with no hint routing failed,
// and being out of credits looks identical to being offline.
describe("failureReason — a misroute leaves a trace of why", () => {
  it("names the out-of-credits case", () => {
    expect(failureReason("insufficient_credits:0")).toMatch(/credits/i);
  });
  it("names the offline case", () => {
    expect(failureReason("ai_unreachable")).toMatch(/offline/i);
  });

  // Signed-out is persistent and user-fixable; calling it "offline" mislabels it as transient.
  it("distinguishes signed-out from offline", () => {
    expect(failureReason("not signed in")).toMatch(/signed in/i);
    expect(failureReason("not signed in")).not.toMatch(/offline/i);
  });

  // The IPC layer wraps errors, so an anchored match lost the class entirely.
  it("recognises out-of-credits even when the IPC layer has wrapped it", () => {
    expect(failureReason("invoke failed: insufficient_credits:0")).toMatch(/credits/i);
  });
  it("names the timeout case", () => {
    expect(failureReason("deadline")).toMatch(/too long/i);
  });
  it("still says something for an unrecognised failure", () => {
    expect(failureReason("weird")).toMatch(/couldn't tell/i);
  });
});

// A rename on either side of the IPC boundary would otherwise fail silently at runtime and route
// to `sparkle` forever — indistinguishable from the intended fallback.
describe("the default tier-2 seam", () => {
  it("invokes route_classify with a text/context payload", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValueOnce("agent");
    await invokeClassify("hello", "ctx");
    expect(invoke).toHaveBeenCalledWith("route_classify", { text: "hello", context: "ctx" });
  });
});

describe("contextLine — bounded before it reaches a metered call", () => {
  it("caps the number of on-screen options", () => {
    const many = Array.from({ length: 40 }, (_, i) => opt(`Option ${i}`, `${i}\n`));
    const line = contextLine({ id: "a", name: "N", status: "waiting", canAcceptInput: true }, many);
    expect(line).toContain("Option 0");
    expect(line).not.toContain("Option 39");
  });

  it("caps a single very long label and a very long agent name", () => {
    const line = contextLine(
      { id: "a", name: "N".repeat(500), status: "waiting", canAcceptInput: true },
      [opt("L".repeat(500), "x")],
    );
    expect(line.length).toBeLessThan(400);
  });
});

describe("pure predicates", () => {
  it("looksLikeFleetTalk is anchored, not a substring search", () => {
    expect(looksLikeFleetTalk("what's going on")).toBe(true);
    expect(looksLikeFleetTalk("make the error message say what's going on")).toBe(false);
  });

  // The spend pattern used to be the one unanchored entry, so this instruction went to Sparkle.
  it("anchors the spend pattern like every other one", () => {
    expect(looksLikeFleetTalk("how much have I spent")).toBe(true);
    expect(looksLikeFleetTalk("make the error message say how much the retry will cost")).toBe(
      false,
    );
  });

  it("looksLikeAnswer accepts bare answers with no options on screen", () => {
    expect(looksLikeAnswer("yes", [])).toBe(true);
    expect(looksLikeAnswer("ok.", [])).toBe(true);
    expect(looksLikeAnswer("rewrite the auth middleware", [])).toBe(false);
  });

  it("looksLikeAnswer defers to the dispatch matcher for on-screen options", () => {
    expect(looksLikeAnswer("2", YES_NO)).toBe(true);
    expect(looksLikeAnswer("No", YES_NO)).toBe(true);
  });
});
