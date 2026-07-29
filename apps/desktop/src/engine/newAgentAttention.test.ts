// A freshly spawned agent that has never been briefed is NEW, not BLOCKED.
//
// The bug this pins: spawn an agent, give it no brief, and 25 seconds later the legacy stall timer
// in statusEngine (BLOCKED_MS) escalates it to `blocked` — a RED status — so the row goes red and
// the fleet raises "Needs you" for an agent that has never asked anybody anything. `blocked` and
// "the human is on the hook" were the same colour, so an idle, unbriefed agent was indistinguishable
// from one holding a question.
//
// The assertions that matter most here are the NEGATIVE ones — a real ask must still go red
// immediately. Every de-escalation below is gated on the agent being briefless, so an agent that has
// been given work keeps the entire pre-existing taxonomy untouched.
import { describe, it, expect } from "vitest";
import {
  NEW_AGENT_GRACE_MS,
  isBriefless,
  calmNewAgent,
  withNewAgentCalm,
} from "./newAgentAttention";
import { isRedStatus } from "../services/windowStatus";
import { AGENT_STATUS } from "@sparkle/ui";
import type { AgentTabStatus } from "../types";

const SPAWN = 1_000_000;
/** Inside the 5-minute backstop window. */
const FRESH = SPAWN + 60_000;
/** Well outside it. */
const OLD = SPAWN + NEW_AGENT_GRACE_MS + 60_000;

/** A just-spawned agent with no brief of any kind. */
const briefless = (over: Record<string, unknown> = {}) => ({
  id: "a",
  lastPrompt: "",
  promptHistory: [],
  createdAt: SPAWN,
  ...over,
});

describe("the `new` status itself", () => {
  it("is GRAY — the same neutral tier as idle/done/stopped, never the red tier", () => {
    expect(AGENT_STATUS.new.color).toBe(AGENT_STATUS.idle.color);
    expect(AGENT_STATUS.new.color).not.toBe(AGENT_STATUS.waiting.color);
  });

  it("is NOT in the red-colour tier, so no surface that keys off isRedStatus can paint it red", () => {
    expect(isRedStatus("new")).toBe(false);
    // Sanity: the predicate still recognises the genuine reds.
    expect(isRedStatus("waiting")).toBe(true);
    expect(isRedStatus("blocked")).toBe(true);
  });
});

describe("isBriefless", () => {
  it("is true for an agent with no prompt, no history and no task", () => {
    expect(isBriefless(briefless())).toBe(true);
  });

  it("is FALSE once the human has submitted anything", () => {
    expect(isBriefless(briefless({ lastPrompt: "go build the thing" }))).toBe(false);
    expect(isBriefless(briefless({ promptHistory: [{ id: "p" }] }))).toBe(false);
  });

  it("is FALSE for a worker carrying an assigned task — the task IS its brief", () => {
    expect(isBriefless(briefless({ task: "fix the parser" }))).toBe(false);
  });

  it("treats whitespace-only text as no brief at all", () => {
    expect(isBriefless(briefless({ lastPrompt: "   \n " }))).toBe(true);
  });

  // ── The three routes a brief can arrive by that the store's prompt fields do NOT record ────────
  // Each of these was a real hole (roborev 54696). They matter more than the happy path, because
  // misreading a working agent as briefless permanently rewrites the `blocked` red that means
  // "this wedged, go unstick it" into a gray "New — not briefed".

  it("is FALSE for a shell tab — the COMMAND is its brief", () => {
    // `runAsCommand` spawns a "shell" agent with only a name + shellCommand: no prompt, no history,
    // no task. Every Run-as-command tab would otherwise be briefless by construction, so a one-shot
    // command that fails in its first 5 minutes — the common case — would have its red swallowed.
    expect(isBriefless(briefless({ kind: "shell", shellCommand: "pnpm test" }))).toBe(false);
  });

  it("is FALSE once the user has typed into the terminal directly", () => {
    // Terminal.tsx's onData forwards keystrokes straight to the PTY and only touches the interaction
    // store — it never calls appendPrompt. An agent driven entirely by hand in the pane therefore
    // has empty prompt fields forever, and (because the blocked→new mapping is deliberately not
    // time-limited) would be classified briefless forever.
    expect(isBriefless(briefless(), SPAWN + 5_000)).toBe(false);
  });

  it("still reads briefless when the interaction stamp is absent or zero", () => {
    expect(isBriefless(briefless(), undefined)).toBe(true);
    expect(isBriefless(briefless(), 0)).toBe(true);
  });
});

describe("calmNewAgent — an agent driven by hand keeps its red", () => {
  it("leaves `blocked` red for an agent the user has typed into", () => {
    // The important direction: this agent IS doing work, so a stall is genuinely the user's problem.
    expect(calmNewAgent("blocked", briefless(), OLD, SPAWN + 5_000)).toBe("blocked");
  });

  it("leaves an errored shell tab red even inside the grace window", () => {
    const shell = briefless({ kind: "shell", shellCommand: "pnpm test" });
    expect(calmNewAgent("errored", shell, FRESH)).toBe("errored");
  });

  it("still calms a genuinely untouched agent (the interaction stamp is absent)", () => {
    expect(calmNewAgent("blocked", briefless(), FRESH)).toBe("new");
  });
});

describe("calmNewAgent — a briefless agent is NEW, not blocked", () => {
  it("maps the stall-timer `blocked` to `new` (the reported bug)", () => {
    expect(calmNewAgent("blocked", briefless(), FRESH)).toBe("new");
  });

  it("keeps it `new` long after the grace window — it still has never been briefed", () => {
    // `blocked` means "went quiet", and an agent with nothing to do is quiet BY DEFINITION. Age
    // never turns that into a question, so this de-escalation is not time-limited.
    expect(calmNewAgent("blocked", briefless(), OLD)).toBe("new");
  });

  it("maps the settled `idle` to `new` — it never finished a turn, it never had one", () => {
    // `idle` is labelled "Done — your turn" and pings by default. Both are false for an agent that
    // was never given a turn to finish.
    expect(calmNewAgent("idle", briefless(), FRESH)).toBe("new");
  });

  it("leaves a briefless agent that is genuinely WORKING green", () => {
    expect(calmNewAgent("working", briefless(), FRESH)).toBe("working");
  });
});

describe("calmNewAgent — a real question still goes red IMMEDIATELY (no regression)", () => {
  // This is the assertion that guards the whole change. The backstop must never swallow an ask.
  it("leaves `waiting` red even on a brand-new briefless agent", () => {
    expect(calmNewAgent("waiting", briefless(), SPAWN + 1)).toBe("waiting");
  });

  it("leaves `approval` red even on a brand-new briefless agent", () => {
    expect(calmNewAgent("approval", briefless(), SPAWN + 1)).toBe("approval");
  });

  it("leaves EVERY status untouched once the agent has been briefed", () => {
    const briefed = briefless({ lastPrompt: "do the thing" });
    const all = Object.keys(AGENT_STATUS) as AgentTabStatus[];
    for (const st of all) expect(calmNewAgent(st, briefed, FRESH), st).toBe(st);
  });

  it("leaves a briefed agent's `blocked` red — a stalled agent with work IS your problem", () => {
    expect(calmNewAgent("blocked", briefless({ task: "ship it" }), OLD)).toBe("blocked");
  });
});

describe("calmNewAgent — the 5-minute backstop", () => {
  it("suppresses an unclassifiable red (errored) inside the grace window", () => {
    expect(calmNewAgent("errored", briefless(), FRESH)).toBe("new");
  });

  it("lets that same red through once the grace window has passed", () => {
    // The backstop is a FALLBACK for states the machine cannot classify, not a permanent mute.
    expect(calmNewAgent("errored", briefless(), OLD)).toBe("errored");
  });

  it("uses a half-open boundary: red at exactly +5m, calm one ms before", () => {
    expect(calmNewAgent("errored", briefless(), SPAWN + NEW_AGENT_GRACE_MS - 1)).toBe("new");
    expect(calmNewAgent("errored", briefless(), SPAWN + NEW_AGENT_GRACE_MS)).toBe("errored");
  });

  it("does nothing for an agent with no spawn stamp — freshness cannot be established", () => {
    // Legacy persisted rows carry no createdAt. "Unknown age" must read as OLD, so this change can
    // never retroactively calm a row that has been red across a restart.
    const legacy = briefless({ createdAt: undefined });
    expect(calmNewAgent("errored", legacy, FRESH)).toBe("errored");
    expect(calmNewAgent("blocked", legacy, FRESH)).toBe("blocked");
  });

  it("leaves an unobserved (undefined) status undefined rather than inventing `new`", () => {
    expect(calmNewAgent(undefined, briefless(), FRESH)).toBeUndefined();
  });
});

describe("withNewAgentCalm — the map overlay", () => {
  it("calms only the briefless rows and leaves the rest of the map alone", () => {
    const agents = [
      briefless({ id: "fresh" }),
      briefless({ id: "briefed", lastPrompt: "build it" }),
      briefless({ id: "asking" }),
    ];
    const status: Record<string, AgentTabStatus> = {
      fresh: "blocked",
      briefed: "blocked",
      asking: "waiting",
    };
    expect(withNewAgentCalm(agents, status, FRESH)).toEqual({
      fresh: "new",
      briefed: "blocked",
      asking: "waiting",
    });
  });

  it("reads the interaction map, so a hand-driven row keeps its red", () => {
    const agents = [briefless({ id: "typed" }), briefless({ id: "untouched" })];
    const status: Record<string, AgentTabStatus> = { typed: "blocked", untouched: "blocked" };
    expect(withNewAgentCalm(agents, status, FRESH, { typed: SPAWN + 5_000 })).toEqual({
      typed: "blocked",
      untouched: "new",
    });
  });

  it("returns the SAME reference when nothing is calmed (no render churn)", () => {
    const agents = [briefless({ id: "briefed", lastPrompt: "x" })];
    const status: Record<string, AgentTabStatus> = { briefed: "blocked" };
    expect(withNewAgentCalm(agents, status, FRESH)).toBe(status);
  });

  it("never mutates the input map", () => {
    const agents = [briefless({ id: "fresh" })];
    const status: Record<string, AgentTabStatus> = { fresh: "blocked" };
    withNewAgentCalm(agents, status, FRESH);
    expect(status.fresh).toBe("blocked");
  });

  it("ignores an agent the status map has never heard of", () => {
    const status: Record<string, AgentTabStatus> = {};
    const out = withNewAgentCalm([briefless({ id: "ghost" })], status, FRESH);
    expect(out).toBe(status);
    expect(out.ghost).toBeUndefined();
  });
});
