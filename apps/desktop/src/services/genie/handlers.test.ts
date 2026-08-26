// Handlers and the action-description switch — bead sparkle-uz87.5.
//
// The router suites drive these through `routeGenieIntent` with the REAL classifier, which is the
// production path and where the end-to-end coverage lives. What that path CANNOT reach is a slot
// bag the classifier would never produce — a `mode: "message"` with nobody named, a status with an
// empty target — and those are exactly the branches a future classifier change will start hitting.
// They are covered here, against the handlers directly.
import { describe, expect, it } from "vitest";
import {
  chatHandler,
  defaultGenieHandlers,
  describeGenieAction,
  dispatchHandler,
  navigateHandler,
  remindHandler,
  statusHandler,
  summarizeHandler,
} from "./handlers";
import type { GenieClassification } from "./classify";
import type { GenieAction, GenieRequest } from "./types";

function input(slots: GenieClassification["slots"], transcript = "spoken words") {
  const request: GenieRequest = { transcript, at: 1_000 };
  const classification: GenieClassification = { intent: "chat", confidence: 0.9, slots };
  return { request, classification, at: 1_000 };
}

describe("describeGenieAction", () => {
  it("gives every action kind its own sentence", () => {
    const cases: ReadonlyArray<[GenieAction, string]> = [
      [{ kind: "search", query: "retry flake" }, 'Searching for "retry flake".'],
      [
        { kind: "remind", what: "rebase", whenText: "tomorrow" },
        "I'll remind you to rebase — tomorrow.",
      ],
      [{ kind: "remind", what: "rebase", whenText: null }, "I'll remind you to rebase."],
      [
        { kind: "summarize", subject: "the fleet", scope: "fleet" },
        "Pulling together a summary of the fleet.",
      ],
      [
        { kind: "navigate", targetKind: "screen", target: "settings" },
        "Opening the settings screen.",
      ],
      [{ kind: "navigate", targetKind: "agent", target: "kraken" }, "Opening agent kraken."],
      [
        { kind: "navigate", targetKind: "project", target: "sparkle" },
        "Opening the sparkle project.",
      ],
      [{ kind: "dispatch-start", brief: "the auth bug" }, "Starting an agent on the auth bug."],
      [
        { kind: "dispatch-message", agent: "kraken", message: "rebase" },
        'Passing that to kraken: "rebase".',
      ],
      [{ kind: "status", scope: "fleet", target: null }, "Checking what the fleet is up to."],
      [{ kind: "status", scope: "agent", target: "kraken" }, "Checking what kraken is up to."],
    ];
    for (const [action, expected] of cases) {
      expect(describeGenieAction(action)).toBe(expected);
    }
    // Every sentence is distinct — a switch case falling through to a neighbour would collapse two
    // of these onto one string and this would catch it.
    expect(new Set(cases.map(([, sentence]) => sentence)).size).toBe(cases.length);
  });
});

describe("handler defaults for slot bags the classifier does not currently produce", () => {
  it("dispatch falls back to starting an agent when 'message' names nobody", async () => {
    const res = await dispatchHandler(input({ mode: "message", message: "rebase" }));
    expect(res).toMatchObject({ action: { kind: "dispatch-start", brief: "" } });
  });

  it("dispatch messages the named agent even with an empty message body", async () => {
    const res = await dispatchHandler(input({ mode: "message", agent: "kraken" }));
    expect(res).toMatchObject({
      action: { kind: "dispatch-message", agent: "kraken", message: "" },
    });
  });

  it("status turns an empty target into null rather than an empty string", async () => {
    const res = await statusHandler(input({ scope: "fleet", target: "" }));
    expect(res).toMatchObject({ action: { kind: "status", target: null } });
  });

  it("remind reports a missing time as null, which the consumer must handle", async () => {
    const res = await remindHandler(input({ what: "rebase" }));
    expect(res).toMatchObject({ action: { kind: "remind", whenText: null } });
  });

  it("navigate defaults an unclassified target to a project", async () => {
    const res = await navigateHandler(input({ target: "sparkle" }));
    expect(res).toMatchObject({ action: { kind: "navigate", targetKind: "project" } });
  });

  it("summarize defaults an unread scope to 'unspecified'", async () => {
    const res = await summarizeHandler(input({ subject: "the week" }));
    expect(res).toMatchObject({ action: { kind: "summarize", scope: "unspecified" } });
  });
});

describe("chatHandler", () => {
  // `GenieHandler` may return a promise, so every call is awaited — including the synchronous ones.
  it("carries NO action — an utterance we did not understand moves nothing", async () => {
    const res = await chatHandler(input({}, "flurgle bimbat"));
    expect(res).not.toHaveProperty("action");
    expect(res.intent).toBe("chat");
  });

  it("echoes what was heard so a misheard word is visible to the user", async () => {
    const res = await chatHandler(input({}, "flurgle bimbat"));
    expect(res.replyText).toContain('"flurgle bimbat"');
  });

  it("says so plainly when nothing was heard at all", async () => {
    const res = await chatHandler(input({}, "   "));
    expect(res.replyText).toBe("I didn't catch that. Say it again?");
  });

  it("reports the classifier's confidence, not one of its own", async () => {
    const request: GenieRequest = { transcript: "hm", at: 0 };
    const classification: GenieClassification = { intent: "search", confidence: 0.35, slots: {} };
    const res = await chatHandler({ request, classification, at: 0 });
    expect(res.confidence).toBe(0.35);
  });
});

describe("defaultGenieHandlers", () => {
  it("routes each intent key to the handler that produces that intent's action", async () => {
    // Not a count of the map's keys — that is a tautology `Record<GenieIntent, …>` already
    // guarantees. This asserts each KEY is wired to the RIGHT handler, which is the thing a
    // copy-paste slip breaks.
    const wiring: ReadonlyArray<[keyof typeof defaultGenieHandlers, string | undefined]> = [
      ["search", "search"],
      ["remind", "remind"],
      ["summarize", "summarize"],
      ["navigate", "navigate"],
      ["dispatch", "dispatch-start"],
      ["status", "status"],
      ["chat", undefined],
    ];
    for (const [key, expectedKind] of wiring) {
      const res = await defaultGenieHandlers[key](input({}));
      expect(res.action?.kind, `handler for "${key}"`).toBe(expectedKind);
    }
  });
});
