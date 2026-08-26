// End-to-end through the REAL production entry point — bead sparkle-uz87.5.
//
// WHY THIS FILE EXISTS SEPARATELY FROM router.test.ts. That file injects a handler map into every
// call, which is what makes routing testable — and is also exactly how this repo has lost features
// before: when EVERY test supplies its own map, the line `deps.handlers ?? defaultGenieHandlers` is
// covered by nothing, so deleting it leaves a green suite behind a genie that routes to nothing.
// The same is true of `deps.classify ?? classifyTranscript` and `deps.now ?? Date.now`.
//
// So NOTHING is injected below. `routeGenieIntent(request)` is called with a single argument — the
// literal call sparkle-uz87.7 will make — and each case asserts the ACTION PAYLOAD, which only the
// real handler for that intent can produce. A router wired to a stub, or to the wrong handler,
// cannot satisfy these.
//
// The bead's acceptance criterion is "a unit test suite covering at least six distinct intent
// categories". All SEVEN are below, each through this path.
import { describe, expect, it } from "vitest";
import { routeGenieIntent } from "./router";
import type { GenieRequest } from "./types";

/** A request captured "just now", so the real `Date.now` default reads it as fresh. */
function spoken(transcript: string): GenieRequest {
  return { transcript, at: Date.now() };
}

describe("routeGenieIntent — seven categories, real classifier, real handlers, no injection", () => {
  it("1/7 search", async () => {
    const res = await routeGenieIntent(spoken("Hey Sparkle, search for the flaky retry test"));
    expect(res.intent).toBe("search");
    expect(res.action).toEqual({ kind: "search", query: "flaky retry test" });
    expect(res.replyText).toBe('Searching for "flaky retry test".');
    expect(res.confidence).toBe(0.9);
  });

  it("2/7 remind", async () => {
    const res = await routeGenieIntent(spoken("remind me to rebase the auth branch tomorrow"));
    expect(res.intent).toBe("remind");
    expect(res.action).toEqual({
      kind: "remind",
      what: "rebase the auth branch",
      whenText: "tomorrow",
    });
    expect(res.replyText).toBe("I'll remind you to rebase the auth branch — tomorrow.");
  });

  it("3/7 summarize", async () => {
    const res = await routeGenieIntent(spoken("recap the auth agent's last hour"));
    expect(res.intent).toBe("summarize");
    expect(res.action).toEqual({
      kind: "summarize",
      subject: "the auth agent's last hour",
      scope: "agent",
    });
    expect(res.replyText).toBe("Pulling together a summary of the auth agent's last hour.");
  });

  it("4/7 navigate", async () => {
    const res = await routeGenieIntent(spoken("open the settings screen"));
    expect(res.intent).toBe("navigate");
    expect(res.action).toEqual({ kind: "navigate", targetKind: "screen", target: "settings" });
    expect(res.replyText).toBe("Opening the settings screen.");
  });

  it("5/7 dispatch — messaging a named agent", async () => {
    const res = await routeGenieIntent(spoken("tell kraken to rebase onto main"));
    expect(res.intent).toBe("dispatch");
    expect(res.action).toEqual({
      kind: "dispatch-message",
      agent: "kraken",
      message: "rebase onto main",
    });
    expect(res.replyText).toBe('Passing that to kraken: "rebase onto main".');
  });

  it("5/7 dispatch — starting a new one", async () => {
    const res = await routeGenieIntent(spoken("start an agent on the flaky retry test"));
    expect(res.intent).toBe("dispatch");
    expect(res.action).toEqual({ kind: "dispatch-start", brief: "flaky retry test" });
    expect(res.replyText).toBe("Starting an agent on flaky retry test.");
  });

  it("6/7 status", async () => {
    const res = await routeGenieIntent(spoken("what are the agents up to"));
    expect(res.intent).toBe("status");
    expect(res.action).toEqual({ kind: "status", scope: "fleet", target: null });
    expect(res.replyText).toBe("Checking what the fleet is up to.");
  });

  it("7/7 chat — the fallback, and it moves NOTHING", async () => {
    const res = await routeGenieIntent(spoken("flurgle bimbat wozzle"));
    expect(res.intent).toBe("chat");
    expect(res.action).toBeUndefined();
    expect(res.replyText).toContain('I heard "flurgle bimbat wozzle"');
    expect(res.confidence).toBe(0.2);
  });

  it("a verb with nothing after it lands in chat and takes no action", async () => {
    const res = await routeGenieIntent(spoken("search"));
    expect(res.intent).toBe("chat");
    expect(res.action).toBeUndefined();
    // The LOW score is still reported — this is the "gave up" chat, not the confident one.
    expect(res.confidence).toBe(0.35);
  });

  it("precedence holds end-to-end, not just inside the classifier", async () => {
    const both = await routeGenieIntent(spoken("remind me to search for the flaky test tomorrow"));
    expect(both.intent).toBe("remind");
    expect(both.action).toMatchObject({ kind: "remind", what: "search for the flaky test" });
    // Paired: the losing rule is live on its own, so the case above is about ORDER.
    const alone = await routeGenieIntent(spoken("search for the flaky test"));
    expect(alone.action).toEqual({ kind: "search", query: "flaky test" });
  });

  it("returns a response for every one of the seven intents — none is unreachable", async () => {
    const seen = new Set<string>();
    for (const transcript of [
      "search for the retry flake",
      "remind me to rebase tomorrow",
      "summarize the last hour",
      "open the settings screen",
      "tell kraken to rebase onto main",
      "what are the agents up to",
      "flurgle bimbat wozzle",
    ]) {
      seen.add((await routeGenieIntent(spoken(transcript))).intent);
    }
    expect([...seen].sort()).toEqual([
      "chat",
      "dispatch",
      "navigate",
      "remind",
      "search",
      "status",
      "summarize",
    ]);
  });
});
