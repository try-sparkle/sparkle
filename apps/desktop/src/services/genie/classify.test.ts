// Rules classifier — bead sparkle-uz87.5.
//
// PRECEDENCE IS TESTED IN PAIRS, deliberately. Asserting only that "remind me to search for X"
// classifies as `remind` is satisfied by a classifier that has no search rule at all. Each
// precedence case therefore also asserts that the LOSING phrasing, on its own, still wins — so the
// pair pins the ORDER of two live rules rather than the existence of one.
import { describe, expect, it } from "vitest";
import {
  classifyTranscript,
  normalizeTranscript,
  GENIE_CONFIDENCE_CHAT,
  GENIE_CONFIDENCE_STRONG,
  GENIE_CONFIDENCE_WEAK,
  RULES,
} from "./classify";

describe("normalizeTranscript", () => {
  it("drops a leading wake phrase so the rules never carry filler handling", () => {
    expect(normalizeTranscript("Hey Sparkle, search for the retry test")).toBe(
      "search for the retry test",
    );
    expect(normalizeTranscript("Sparkle open the board")).toBe("open the board");
  });

  it("lower-cases, collapses whitespace and strips trailing punctuation", () => {
    expect(normalizeTranscript("  WHAT   is the Fleet   doing?? ")).toBe("what is the fleet doing");
  });

  it("straightens curly quotes so a dictated apostrophe still matches the rules", () => {
    expect(normalizeTranscript("how’s the auth agent going")).toBe(
      "how's the auth agent going",
    );
  });
});

describe("classifyTranscript — slots per category", () => {
  it("search: takes the query after the verb, without the 'for'", () => {
    const c = classifyTranscript("Hey Sparkle, search for the flaky retry test");
    expect(c.intent).toBe("search");
    expect(c.slots.query).toBe("flaky retry test");
    expect(c.confidence).toBe(GENIE_CONFIDENCE_STRONG);
  });

  it("remind: splits the task from the time phrase", () => {
    const c = classifyTranscript("remind me to rebase the auth branch tomorrow");
    expect(c.intent).toBe("remind");
    expect(c.slots.what).toBe("rebase the auth branch");
    expect(c.slots.whenText).toBe("tomorrow");
  });

  it("remind: reports no time phrase rather than inventing one", () => {
    const c = classifyTranscript("remind me to check the release notes");
    expect(c.slots.what).toBe("check the release notes");
    expect(c.slots.whenText).toBeUndefined();
  });

  it("remind: reads the noun form too, and an o'clock time", () => {
    const c = classifyTranscript("set a reminder to check the release at 5pm");
    expect(c.intent).toBe("remind");
    expect(c.slots.what).toBe("check the release");
    expect(c.slots.whenText).toBe("at 5pm");
  });

  it("summarize: keeps the subject and reads the scope word", () => {
    const c = classifyTranscript("recap the auth agent's last hour");
    expect(c.intent).toBe("summarize");
    expect(c.slots.subject).toBe("the auth agent's last hour");
    expect(c.slots.scope).toBe("agent");
  });

  it("navigate: strips the generic kind-noun so the name is left alone", () => {
    const screen = classifyTranscript("open the settings screen");
    expect(screen.intent).toBe("navigate");
    expect(screen.slots.targetKind).toBe("screen");
    expect(screen.slots.target).toBe("settings");

    const project = classifyTranscript("go to the sparkle project");
    expect(project.slots.targetKind).toBe("project");
    expect(project.slots.target).toBe("sparkle");

    const agent = classifyTranscript("open agent kraken");
    expect(agent.slots.targetKind).toBe("agent");
    expect(agent.slots.target).toBe("kraken");
  });

  it("dispatch: 'tell <name> to <task>' fills agent and message", () => {
    const c = classifyTranscript("tell kraken to rebase onto main");
    expect(c.intent).toBe("dispatch");
    expect(c.slots.mode).toBe("message");
    expect(c.slots.agent).toBe("kraken");
    expect(c.slots.message).toBe("rebase onto main");
  });

  it("dispatch: 'start an agent on <brief>' fills the brief and names nobody", () => {
    const c = classifyTranscript("start an agent on the flaky retry test");
    expect(c.slots.mode).toBe("start");
    expect(c.slots.brief).toBe("flaky retry test");
    expect(c.slots.agent).toBeUndefined();
  });

  it("status: a bare 'status' is a complete request and scopes to the fleet", () => {
    const c = classifyTranscript("status");
    expect(c.intent).toBe("status");
    expect(c.slots.scope).toBe("fleet");
    expect(c.slots.target).toBe("");
    expect(c.confidence).toBe(GENIE_CONFIDENCE_STRONG);
  });

  it("status: names the agent from 'the <name> agent', not from the word beside it", () => {
    // Regression: a bare adjacency match reported this agent as "going".
    const c = classifyTranscript("how is the auth agent going");
    expect(c.intent).toBe("status");
    expect(c.slots.scope).toBe("agent");
    expect(c.slots.target).toBe("auth");
  });

  it("status: reads the name after the noun too, and skips the verb beside it", () => {
    // Regression: this shape reported the agent as "is".
    const c = classifyTranscript("what is agent kraken doing");
    expect(c.slots.target).toBe("kraken");
  });

  it("chat: gibberish falls through with the fallback confidence", () => {
    const c = classifyTranscript("flurgle bimbat wozzle");
    expect(c.intent).toBe("chat");
    expect(c.confidence).toBe(GENIE_CONFIDENCE_CHAT);
    expect(c.slots).toEqual({});
  });

  it("chat: an empty transcript is chat, not a crash", () => {
    expect(classifyTranscript("   ").intent).toBe("chat");
  });
});

describe("classifyTranscript — confidence reflects whether the slots are usable", () => {
  it("scores a matched verb with an empty object WEAK, not strong", () => {
    const c = classifyTranscript("search");
    expect(c.intent).toBe("search");
    expect(c.slots.query).toBe("");
    expect(c.confidence).toBe(GENIE_CONFIDENCE_WEAK);
  });

  it("scores the same verb with an object STRONG", () => {
    expect(classifyTranscript("search for the retry test").confidence).toBe(
      GENIE_CONFIDENCE_STRONG,
    );
  });

  it("keeps WEAK strictly below and STRONG strictly above the trust floor's operands", () => {
    expect(GENIE_CONFIDENCE_WEAK).toBeLessThan(GENIE_CONFIDENCE_STRONG);
    expect(GENIE_CONFIDENCE_CHAT).toBeLessThan(GENIE_CONFIDENCE_WEAK);
  });
});

describe("classifyTranscript — precedence between rules that BOTH match", () => {
  it("remind beats search: a commitment outranks the verb inside it", () => {
    expect(classifyTranscript("remind me to search for the flaky test tomorrow").intent).toBe(
      "remind",
    );
    // …and the losing rule is genuinely live on its own.
    expect(classifyTranscript("search for the flaky test").intent).toBe("search");
  });

  it("dispatch beats navigate: the side effect is the ask", () => {
    expect(classifyTranscript("start an agent and open its pane to fix the auth bug").intent).toBe(
      "dispatch",
    );
    expect(classifyTranscript("open its pane").intent).toBe("navigate");
  });

  it("navigate beats search: 'open the search screen' names a destination", () => {
    const c = classifyTranscript("open the search screen");
    expect(c.intent).toBe("navigate");
    expect(c.slots.target).toBe("search");
    expect(classifyTranscript("search the screen for retries").intent).toBe("search");
  });

  it("summarize beats status: the user chose the shape of the output", () => {
    expect(classifyTranscript("summarize what the fleet is doing").intent).toBe("summarize");
    expect(classifyTranscript("what the fleet is doing").intent).toBe("status");
  });

  it("status beats search: 'find out what the fleet is doing' is a status question", () => {
    expect(classifyTranscript("find out what the fleet is doing").intent).toBe("status");
    expect(classifyTranscript("find out where the ledger is written").intent).toBe("search");
  });

  it("RULES is ordered, and that order is the behaviour above", () => {
    expect(RULES.map((r) => r.intent)).toEqual([
      "remind",
      "dispatch",
      "navigate",
      "summarize",
      "status",
      "search",
    ]);
  });
});
