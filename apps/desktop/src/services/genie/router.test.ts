// Router mechanics — bead sparkle-uz87.5. Fakes here; the REAL handler map is exercised end-to-end
// in router.realHandlers.test.ts, which exists precisely so this file's fakes cannot hide the line
// that supplies the real one.
//
// Every guard below is asserted through a SIDE EFFECT (which handler ran, with what) rather than
// through copy alone, and the two absence-assertions — "no handler ran" — are each written as a
// PAIR with the same setup one tick fresher, so "nothing happened" pins the guard rather than a
// broken fixture.
import { describe, expect, it, vi } from "vitest";
import { routeGenieIntent, GENIE_CONFIDENCE_FLOOR, GENIE_STALE_MS } from "./router";
import type { GenieHandlerInput, GenieHandlerMap } from "./handlers";
import type { GenieClassification } from "./classify";
import type { GenieIntent, GenieRequest } from "./types";

const NOW = 1_700_000_000_000;

/** A full map whose every entry records the input it was called with. */
function recordingMap() {
  const calls: Array<{ intent: GenieIntent; input: GenieHandlerInput }> = [];
  const make = (intent: GenieIntent) => (input: GenieHandlerInput) => {
    calls.push({ intent, input });
    return { intent, replyText: `handled:${intent}`, confidence: input.classification.confidence };
  };
  const handlers: GenieHandlerMap = {
    search: make("search"),
    remind: make("remind"),
    summarize: make("summarize"),
    navigate: make("navigate"),
    dispatch: make("dispatch"),
    status: make("status"),
    chat: make("chat"),
  };
  return { handlers, calls };
}

function req(transcript: string, at = NOW): GenieRequest {
  return { transcript, at };
}

describe("routeGenieIntent — the classified intent picks the handler", () => {
  it.each([
    ["search for the retry flake", "search"],
    ["remind me to rebase tomorrow", "remind"],
    ["summarize the last hour", "summarize"],
    ["open the settings screen", "navigate"],
    ["tell kraken to rebase onto main", "dispatch"],
    ["what are the agents up to", "status"],
    ["flurgle bimbat wozzle", "chat"],
  ])("%s -> %s handler runs, and only it", async (transcript, expected) => {
    const { handlers, calls } = recordingMap();
    const res = await routeGenieIntent(req(transcript), { handlers, now: () => NOW });

    expect(res.intent).toBe(expected);
    expect(res.replyText).toBe(`handled:${expected}`);
    expect(calls.map((c) => c.intent)).toEqual([expected]);
  });

  it("hands the handler the whole classification, slots included", async () => {
    const { handlers, calls } = recordingMap();
    await routeGenieIntent(req("tell kraken to rebase onto main"), { handlers, now: () => NOW });
    expect(calls[0]?.input.classification.slots).toMatchObject({
      mode: "message",
      agent: "kraken",
      message: "rebase onto main",
    });
  });

  it("uses an injected classifier when one is given", async () => {
    const { handlers, calls } = recordingMap();
    const classification: GenieClassification = {
      intent: "summarize",
      confidence: 0.99,
      slots: { subject: "injected" },
    };
    const classify = vi.fn(() => classification);
    const res = await routeGenieIntent(req("this text says search, loudly"), {
      handlers,
      classify,
      now: () => NOW,
    });
    expect(classify).toHaveBeenCalledWith("this text says search, loudly");
    expect(res.intent).toBe("summarize");
    expect(calls.map((c) => c.intent)).toEqual(["summarize"]);
  });
});

describe("routeGenieIntent — low confidence falls back to chat", () => {
  const weak: GenieClassification = { intent: "search", confidence: 0.35, slots: { query: "" } };

  it("routes a below-floor classification to chat and NOT to its own handler", async () => {
    const { handlers, calls } = recordingMap();
    const res = await routeGenieIntent(req("search"), {
      handlers,
      classify: () => weak,
      now: () => NOW,
    });
    expect(res.intent).toBe("chat");
    expect(calls.map((c) => c.intent)).toEqual(["chat"]);
  });

  it("still reports the LOW score, so 'gave up' is distinguishable from 'confidently chat'", async () => {
    const { handlers } = recordingMap();
    const res = await routeGenieIntent(req("search"), {
      handlers,
      classify: () => weak,
      now: () => NOW,
    });
    expect(res.confidence).toBe(0.35);
  });

  it("trusts a classification sitting exactly ON the floor — the comparison is strict", async () => {
    const { handlers, calls } = recordingMap();
    const onFloor: GenieClassification = {
      intent: "search",
      confidence: GENIE_CONFIDENCE_FLOOR,
      slots: { query: "x" },
    };
    const res = await routeGenieIntent(req("search for x"), {
      handlers,
      classify: () => onFloor,
      now: () => NOW,
    });
    expect(res.intent).toBe("search");
    expect(calls.map((c) => c.intent)).toEqual(["search"]);
  });
});

describe("routeGenieIntent — a throwing handler cannot escape", () => {
  function throwingMap(mode: "sync" | "async"): GenieHandlerMap {
    const { handlers } = recordingMap();
    const boom = () => {
      if (mode === "sync") throw new Error("handler exploded");
      return Promise.reject(new Error("handler exploded"));
    };
    return { ...handlers, search: boom };
  }

  it.each(["sync", "async"] as const)("catches a %s failure and answers safely", async (mode) => {
    const res = await routeGenieIntent(req("search for the retry flake"), {
      handlers: throwingMap(mode),
      now: () => NOW,
    });
    expect(res.replyText).toBe(
      "Something went wrong handling that. Nothing changed — want to try again?",
    );
    // The intent survives so the caller can say what was ATTEMPTED…
    expect(res.intent).toBe("search");
    // …and the action does NOT, because nothing happened.
    expect(res.action).toBeUndefined();
  });

  it("leaves a sibling intent unaffected — the catch is per-request, not a latch", async () => {
    const handlers = throwingMap("sync");
    await routeGenieIntent(req("search for the retry flake"), { handlers, now: () => NOW });
    const res = await routeGenieIntent(req("what are the agents up to"), {
      handlers,
      now: () => NOW,
    });
    expect(res.replyText).toBe("handled:status");
  });
});

describe("routeGenieIntent — a stale utterance takes no action", () => {
  it("runs the handler when the request is fresh, and runs NOTHING once it is stale", async () => {
    const fresh = recordingMap();
    const freshRes = await routeGenieIntent(req("tell kraken to rebase onto main", NOW), {
      handlers: fresh.handlers,
      now: () => NOW + 1_000,
    });
    expect(freshRes.intent).toBe("dispatch");
    expect(fresh.calls).toHaveLength(1);

    // Same transcript, same handlers, same everything — only the clock moved.
    const stale = recordingMap();
    const staleRes = await routeGenieIntent(req("tell kraken to rebase onto main", NOW), {
      handlers: stale.handlers,
      now: () => NOW + GENIE_STALE_MS + 1,
    });
    expect(staleRes.intent).toBe("chat");
    expect(staleRes.action).toBeUndefined();
    expect(staleRes.replyText).toBe(
      "That was a while ago, so I didn't act on it. Say it again and I will.",
    );
    expect(stale.calls).toHaveLength(0);
  });

  it("treats an age of exactly GENIE_STALE_MS as fresh", async () => {
    const { handlers, calls } = recordingMap();
    const res = await routeGenieIntent(req("what are the agents up to", NOW), {
      handlers,
      now: () => NOW + GENIE_STALE_MS,
    });
    expect(res.intent).toBe("status");
    expect(calls).toHaveLength(1);
  });

  it("reads a backwards clock as fresh, never as enormously stale", async () => {
    // A capture stamped in the FUTURE by clock jitter must not be refused. The skew is deliberately
    // LARGER than GENIE_STALE_MS: with a smaller one this passes even against `Math.abs(now - at)`,
    // which is the actual mistake here (a magnitude, not an age) — measured, that mutant survived
    // a 5s skew and only reds against this one. Plain subtraction goes negative, and negative is
    // younger than any limit.
    const { handlers, calls } = recordingMap();
    const res = await routeGenieIntent(req("what are the agents up to", NOW + GENIE_STALE_MS + 5_000), {
      handlers,
      now: () => NOW,
    });
    expect(res.intent).toBe("status");
    expect(calls).toHaveLength(1);
  });

  it("still reports the classifier's confidence when it refuses", async () => {
    const { handlers } = recordingMap();
    const res = await routeGenieIntent(req("search for the retry flake", NOW), {
      handlers,
      now: () => NOW + GENIE_STALE_MS + 1,
    });
    expect(res.confidence).toBe(0.9);
  });
});

describe("routeGenieIntent — the injected clock", () => {
  it("is the ONE clock the handler sees", async () => {
    const { handlers, calls } = recordingMap();
    await routeGenieIntent(req("what are the agents up to", NOW), {
      handlers,
      now: () => NOW + 250,
    });
    expect(calls[0]?.input.at).toBe(NOW + 250);
  });

  it("defaults to Date.now when none is injected", async () => {
    // No `now` in deps. If the `?? Date.now` default were removed, `now()` would throw before any
    // handler ran and this would fail — which is the point of asserting the handler DID run.
    const { handlers, calls } = recordingMap();
    const res = await routeGenieIntent(req("what are the agents up to", Date.now()), { handlers });
    expect(res.intent).toBe("status");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input.at).toBeGreaterThan(0);
  });
});
