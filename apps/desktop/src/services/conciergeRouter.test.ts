// The router decides where every UNADDRESSED compose-box send goes now that the user no longer
// picks. There is exactly one answer, and this suite's job is to make that unmissable: `routeMessage`
// returns `sparkle` for every input. See PRD/sparkle/concierge-auto-routing.md §2 and the module
// header.
//
// WHAT CHANGED, AND WHY THESE ROWS READ AS INVERTED: this file used to assert that a terse message
// sent while the on-screen agent was in `waiting`/`approval` routed to the AGENT. That branch caused
// real damage — the user was answering the CONCIERGE's own design questions in the concierge compose
// box while a build agent's pane happened to be on screen, and their answers were typed into that
// agent's terminal. They noticed only because the concierge's replies stopped making sense.
//
// So the rows were INVERTED rather than deleted, deliberately. Same inputs, opposite expectation:
// the exact scenarios that used to reach a PTY are now pinned to `sparkle`, which is what makes the
// regression un-reintroducible. A deleted test would have left the branch free to come back.
//
// The other suite that survives is the tier-2 removal's: the router makes NO call at all — no model,
// and now no terminal read either.
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// The dispatch layer is where the removed branch got the agent's on-screen options from. Mocked so
// the "reads no terminal" row below can assert the absence of that read as a SIDE EFFECT rather than
// as a claim about the import list.
vi.mock("./conciergeDispatch", () => ({
  liveOptionsFor: vi.fn(() => []),
  isTerseAnswer: vi.fn(() => true),
}));

import { invoke } from "@tauri-apps/api/core";
import { liveOptionsFor } from "./conciergeDispatch";
import { looksLikeFleetTalk, routeMessage, type RouteContext } from "./conciergeRouter";
import type { AgentTabStatus } from "../types";

/** An agent blocked on a question, i.e. in the "answer this now" attention set. */
const blocked: RouteContext = {
  agent: { id: "a1", name: "Kraken Auth", status: "approval", canAcceptInput: true },
};
/** An agent that is running and asking nothing. */
const working: RouteContext = {
  agent: { id: "a1", name: "Kraken Auth", status: "working", canAcceptInput: true },
};

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

  // The two tier-1 guards must stay DISTINGUISHABLE. Both answer `sparkle`, so the only thing that
  // can tell a reader (or a support transcript) which one fired is the reason string — and
  // `canAcceptInput` exists now solely to pick between them.
  it("records WHICH tier-1 guard fired, since both answer the same", async () => {
    const none = await routeMessage("add retry logic", { agent: null });
    const cloud = await routeMessage("add retry logic", {
      agent: { id: "a1", name: "Cloud Runner", status: "working", canAcceptInput: false },
    });
    expect(none.reason).not.toBe(cloud.reason);
  });
});

// ── THE REPORTED BUG ────────────────────────────────────────────────────────────────────────────
// The user answers the CONCIERGE's question in the concierge compose box. A build agent happens to
// be the pane on screen, and it happens to be mid-prompt. Nothing in that sentence is a decision to
// write into a terminal — and with auto-send armed, "happens to be on screen" plus a countdown means
// dictated speech reaching a PTY with no deliberate act at all.
describe("REGRESSION: a live ask never captures an unaddressed message", () => {
  it("sends a terse answer to Sparkle when the on-screen agent is WAITING and nothing is @-named", async () => {
    const waiting: RouteContext = {
      agent: { id: "a1", name: "CI Hardening", status: "waiting", canAcceptInput: true },
    };
    const d = await routeMessage("yes", waiting);
    expect(d.target).toBe("sparkle");
  });

  // Inverted wholesale from the old "routes %j to the agent when it is blocked on a question" row —
  // every string that used to reach a terminal, pinned to the recoverable side.
  it.each(["y", "yes", "no", "go ahead", "approve", "2", "Yes", "ok", "do it", "sure"])(
    "routes %j to Sparkle even though the agent is blocked on a question",
    async (text) => {
      const d = await routeMessage(text, blocked);
      expect(d.target).toBe("sparkle");
    },
  );

  // An idle agent was never a keystroke target; it still isn't.
  it("does NOT treat a bare yes as a keystroke when the agent isn't blocked", async () => {
    const d = await routeMessage("yes", working);
    expect(d.target).toBe("sparkle");
  });

  // Inverted from "routes the same answer straight to the PTY when the agent is genuinely asking".
  // That contrast is the one the fix removes: `approval` and `errored` now read the same, because
  // neither is a statement by the USER about where their words should go.
  it.each<AgentTabStatus>(["waiting", "approval", "errored", "working", "idle"])(
    "gives the same verdict whatever the agent's status is (%s)",
    async (status) => {
      const d = await routeMessage("2", {
        agent: { id: "a1", name: "Kraken Auth", status, canAcceptInput: true },
      });
      expect(d.target).toBe("sparkle");
    },
  );

  // The status field is still CARRIED (see RouteAgent.status) — so this pins that carrying it and
  // acting on it are different things.
  it("ignores the status field even when it is the only thing that differs", async () => {
    const asking = await routeMessage("yes", blocked);
    const not = await routeMessage("yes", working);
    expect(asking.target).toBe(not.target);
    expect(asking.target).toBe("sparkle");
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
    const d = await routeMessage(text, working);
    expect(d).toMatchObject({ target: "sparkle", source: "heuristic" });
  });

  // Conservative by design: merely CONTAINING a fleet word is not fleet talk. It used to go to the
  // classifier; it now takes the reversible fallback, which lands in the same place.
  it("does not claim a merely-fleet-flavoured instruction as fleet talk", async () => {
    expect(looksLikeFleetTalk("add a status endpoint to the API")).toBe(false);
    const d = await routeMessage("add a status endpoint to the API", working);
    expect(d).toMatchObject({ target: "sparkle", source: "fallback" });
  });
});

// An errored agent is STALLED, not asking. Nothing here changed verdict — but the REASON did: these
// used to pass because `errored` was excluded from the live-ask set, and they now pass because there
// is no live-ask set to be excluded from.
describe("an errored agent is not asking a question", () => {
  const errored: RouteContext = {
    agent: { id: "a1", name: "Kraken Auth", status: "errored", canAcceptInput: true },
  };

  it.each(["ok", "yes", "do it", "2", "Yes", "No"])(
    "sends %j to Sparkle rather than into a maybe-stale picker",
    async (text) => {
      const d = await routeMessage(text, errored);
      expect(d.target).toBe("sparkle");
    },
  );

  it("does not route a free-text instruction to an errored agent's picker", async () => {
    const d = await routeMessage("rewrite the auth middleware", errored);
    expect(d.target).toBe("sparkle");
  });
});

// `canAcceptInput` is no longer the gate that stands between a message and a PTY — nothing here can
// produce one — but it is still required, and these rows keep the strongest form of the old
// behaviour: the flag being false can never be overridden by anything about the text.
describe("canAcceptInput is a required field, and false always means Sparkle", () => {
  it("refuses to route at an agent whose flag is false", async () => {
    const d = await routeMessage("add retry logic", {
      agent: { id: "a1", name: "Cloud", status: "waiting", canAcceptInput: false },
    });
    expect(d.target).toBe("sparkle");
  });

  // Even the strongest signal the old tier 1 recognised — a bare answer to a live ask.
  it("refuses even a picker answer when the agent can't take input", async () => {
    const d = await routeMessage("yes", {
      agent: { id: "a1", name: "Cloud", status: "approval", canAcceptInput: false },
    });
    expect(d.target).toBe("sparkle");
  });
});

describe("the router is purely local — no model call, and no terminal read", () => {
  // The tier-2 removal's property: there is no classify to fail, time out, or return garbage,
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
      await routeMessage(text, blocked);
      await routeMessage(text, working);
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  // The same property for the branch removed here. The old router read the agent's live screen
  // (`liveOptionsFor`) to decide whether the text answered a picker; asserting the READ is gone is
  // stronger than asserting the verdict, because it fails even if some future branch consults the
  // terminal and then happens to conclude `sparkle` anyway.
  it("never reads the agent's terminal", async () => {
    vi.mocked(liveOptionsFor).mockClear();
    for (const text of ["yes", "2", "no", "approve", "add a test for the redirect case"]) {
      await routeMessage(text, blocked);
    }
    expect(liveOptionsFor).not.toHaveBeenCalled();
  });

  it("sends an unplaceable message to Sparkle, the undoable direction", async () => {
    const d = await routeMessage("add a test for the redirect case", working);
    expect(d).toMatchObject({ target: "sparkle", source: "fallback" });
  });

  // THE TRIPWIRE. Every other row in this file is an instance of it: whatever the text, whatever the
  // status, whatever is on screen, this function does not produce `agent`. The only thing that may
  // aim a message at a live PTY is the user naming the agent, and that decision is built by
  // ConciergeHost from `mentionAim` before this module is ever called.
  it("NEVER returns target: agent, for any combination of text and status", async () => {
    const statuses: (AgentTabStatus | undefined)[] = [
      "waiting",
      "approval",
      "errored",
      "working",
      "idle",
      undefined,
    ];
    const texts = ["yes", "y", "2", "no", "ok", "approve", "", "42", "ambiguous text", "boom"];
    for (const status of statuses) {
      for (const text of texts) {
        const d = await routeMessage(text, {
          agent: { id: "a1", name: "Kraken Auth", status, canAcceptInput: true },
        });
        expect(d.target, `${String(status)} / ${JSON.stringify(text)}`).toBe("sparkle");
      }
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
});
