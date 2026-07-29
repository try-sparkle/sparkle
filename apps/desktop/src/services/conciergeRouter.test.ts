// The router decides where every compose-box send goes now that the user no longer picks. The
// tests that matter most are the ASYMMETRY ones: anything the heuristics cannot place must resolve
// to `sparkle`, because that is the direction the user can undo. A wrong chat answer costs one
// click on the receipt's redirect; a paragraph typed into a live PTY cannot be pulled back. See
// PRD/sparkle/concierge-auto-routing.md §2.
//
// WHAT CHANGED: the tier-2 suites that used to live here (the classifier, its 4s deadline, its
// error taxonomy, the invoke seam, and `contextLine`'s token bounding) were deleted along with
// tier 2 itself, when the AI backend moved onto the user's own Claude Code subscription. A
// `claude -p` classify measures ~5.8s wall clock against a 4s deadline that exists because this
// sits on the critical path of pressing Enter, so it could only ever have timed out — becoming
// "always Sparkle" while still spending the user's quota on an abandoned process.
//
// Those suites are replaced by one stronger property, asserted at the bottom: the router makes NO
// call at all. Every "the classifier must not be reached" test collapses into that, and it cannot
// be satisfied by a classify that merely happens to fail.
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  looksLikeAnswer,
  looksLikeFleetTalk,
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

describe("tier 1 — no agent to prompt", () => {
  it("routes to Sparkle when nothing is in view", async () => {
    const d = await routeMessage("add retry logic", { agent: null });
    expect(d).toMatchObject({ target: "sparkle", source: "heuristic" });
  });

  // A cloud agent has no local PTY — dispatchConciergeAnswer refuses it outright, so routing there
  // is a guaranteed failure the user reads as an error.
  it("treats an agent that can't take input as nothing in view", async () => {
    const d = await routeMessage("add retry logic", {
      agent: { id: "a1", name: "Cloud Runner", status: "working", canAcceptInput: false },
    });
    expect(d).toMatchObject({ target: "sparkle", source: "heuristic" });
  });
});

describe("tier 1 — answering the question on screen", () => {
  it.each(["y", "yes", "no", "go ahead", "approve", "2", "Yes"])(
    "routes %j to the agent when it is blocked on a question",
    async (text) => {
      const d = await routeMessage(text, blocked, { liveOptions: yesNoOptions });
      expect(d).toMatchObject({ target: "agent", source: "heuristic" });
    },
  );

  // An idle agent is not asking anything, so a bare "yes" to it is conversation, not a keystroke.
  it("does NOT treat a bare yes as a keystroke when the agent isn't blocked", async () => {
    const d = await routeMessage("yes", working, { liveOptions: yesNoOptions });
    expect(d.target).toBe("sparkle");
  });

  // A real instruction that merely opens with a yes-word is not an answer (roborev 46311's lesson,
  // inherited via isTerseAnswer).
  it("does not mistake an instruction for a terse answer", async () => {
    const d = await routeMessage("yes-but-use-the-other-endpoint instead", blocked, {
      liveOptions: yesNoOptions,
    });
    expect(d.target).toBe("sparkle");
  });

  it("survives a terminal read that throws (an unreadable screen is not a failed send)", async () => {
    const d = await routeMessage("yes", blocked, {
      liveOptions: () => {
        throw new Error("pty gone");
      },
    });
    // Still routed by the BARE_ANSWER rule, which needs no options.
    expect(d.target).toBe("agent");
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
  ])("routes %j to Sparkle as a heuristic match", async (text) => {
    const d = await routeMessage(text, working, { liveOptions: noOptions });
    expect(d).toMatchObject({ target: "sparkle", source: "heuristic" });
  });

  // Conservative by design: merely CONTAINING a fleet word is not fleet talk. It used to go to the
  // classifier; it now takes the reversible fallback, which lands in the same place.
  it("does not claim a merely-fleet-flavoured instruction as fleet talk", async () => {
    expect(looksLikeFleetTalk("add a status endpoint to the API")).toBe(false);
    const d = await routeMessage("add a status endpoint to the API", working, {
      liveOptions: noOptions,
    });
    expect(d).toMatchObject({ target: "sparkle", source: "fallback" });
  });
});

// An errored agent is STALLED, not asking. There is nothing on screen for a bare "ok" to answer,
// so treating it as a keystroke would be a free-text PTY write in the irreversible direction.
describe("an errored agent is not asking a question", () => {
  const errored: RouteContext = {
    agent: { id: "a1", name: "Kraken Auth", status: "errored", canAcceptInput: true },
  };

  it.each(["ok", "yes", "do it"])(
    "sends %j to Sparkle when NOTHING is on screen to answer",
    async (text) => {
      const d = await routeMessage(text, errored, { liveOptions: noOptions });
      expect(d.target).toBe("sparkle");
    },
  );

  // Even WITH options detected on screen. `errored` is screen-derived, so the process is often
  // still running, and the option detector scans a 50-line window — an agent that ANSWERED a
  // picker and then printed an error trace still matches. Typing "2" there would answer a prompt
  // nobody is asking, on a live terminal (roborev 53104).
  it.each(["2", "Yes", "No"])(
    "still refuses to write %j into a maybe-stale picker",
    async (text) => {
      const d = await routeMessage(text, errored, { liveOptions: yesNoOptions });
      expect(d.target).toBe("sparkle");
    },
  );

  // A non-answer is still a non-answer, options or not.
  it("does not route a free-text instruction to an errored agent's picker", async () => {
    const d = await routeMessage("rewrite the auth middleware", errored, {
      liveOptions: yesNoOptions,
    });
    expect(d.target).toBe("sparkle");
  });

  // The contrast that makes the rule legible: the SAME text on a live ask goes straight through.
  it("routes the same answer straight to the PTY when the agent is genuinely asking", async () => {
    const d = await routeMessage("2", blocked, { liveOptions: yesNoOptions });
    expect(d).toMatchObject({ target: "agent", source: "heuristic" });
  });
});

// The gate must fail CLOSED: as an optional field its absence recreated the exact bug it was added
// to fix (roborev 53060). TypeScript now requires it; this pins the runtime behaviour too.
describe("canAcceptInput is a required, fail-closed gate", () => {
  it("refuses to route at an agent whose flag is false", async () => {
    const d = await routeMessage(
      "add retry logic",
      { agent: { id: "a1", name: "Cloud", status: "waiting", canAcceptInput: false } },
      { liveOptions: yesNoOptions },
    );
    expect(d.target).toBe("sparkle");
  });

  // Even the strongest tier-1 agent signal — a bare answer to a live ask — must not override it.
  it("refuses even a picker answer when the agent can't take input", async () => {
    const d = await routeMessage(
      "yes",
      { agent: { id: "a1", name: "Cloud", status: "approval", canAcceptInput: false } },
      { liveOptions: yesNoOptions },
    );
    expect(d.target).toBe("sparkle");
  });
});

describe("no model call — the router is now purely local", () => {
  // The strongest form of the tier-2 removal, and the property all the deleted "must not be
  // reached" tests were circling: there is no classify to fail, time out, or return garbage,
  // because there is no call. Unlike a stubbed classifier that throws, this cannot pass while the
  // call is still being made.
  it("never invokes Tauri, whatever the message looks like", async () => {
    vi.mocked(invoke).mockClear();
    for (const text of [
      "add a test for the redirect case", // the ambiguous middle tier 2 used to own
      "y",
      "what's going on",
      "refactor the auth module and then push",
    ]) {
      await routeMessage(text, blocked, { liveOptions: noOptions });
      await routeMessage(text, working, { liveOptions: yesNoOptions });
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("sends an unplaceable message to Sparkle, the undoable direction", async () => {
    // Not a heuristic match on either side: no live ask to answer, no fleet talk. Before, this was
    // tier 2's whole job; now it takes the reversible fallback rather than typing into a live PTY.
    const d = await routeMessage("add a test for the redirect case", working, {
      liveOptions: noOptions,
    });
    expect(d).toMatchObject({ target: "sparkle", source: "fallback" });
  });

  // The tripwire, preserved from the deleted asymmetry suite: NOTHING reaches the PTY except an
  // explicit tier-1 match. There is no longer any code path that could decide otherwise.
  it("NEVER routes to the agent without a tier-1 heuristic match", async () => {
    for (const text of ["ambiguous text", "", "42", "maybe agent maybe sparkle", "boom"]) {
      const d = await routeMessage(text, working, { liveOptions: noOptions });
      expect(d.target).toBe("sparkle");
    }
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
