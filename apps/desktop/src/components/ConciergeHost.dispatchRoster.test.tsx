// @vitest-environment jsdom
//
// THE REGRESSION THIS WHOLE FEATURE EXISTS TO PREVENT, reconstructed.
//
// On 2026-08-22 the founder asked the concierge about making preview cards inline in chat. It
// answered as if it had never heard of the work and dispatched fresh research — EIGHT MINUTES after
// it had itself spawned an agent ("Sparkle Preview Card Inline") to do exactly that.
//
// A persona rule telling it to check its memory is what had ALREADY failed, so the only fix that can
// hold is the answer being in front of it. That is what these rows assert, and they assert the SIDE
// EFFECT: the composed prompt the real host hands to `startConciergeTurn` actually CONTAINS the open
// delegation. Deleting the fold-in in `ConciergeHost.dispatchTurn` turns every row here red.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RecalledDispatch } from "../services/dispatchRecall";

type Concierge = typeof import("../services/concierge");

const h = vi.hoisted(() => ({
  startConciergeTurn: vi.fn(async (_prompt: string): Promise<string | null> => null),
  recordHistory: vi.fn(async (_e: unknown) => {}),
  openDispatches: vi.fn(async (_limit?: number): Promise<unknown[]> => []),
  brain: {} as {
    delta?: (e: { id: string; text: string }) => void;
    done?: (e: { id: string; text: string }) => void;
    error?: (e: { id: string; detail: string }) => void;
    tool?: (e: { id: string; name: string; input: string }) => void;
  },
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("../services/openProjectTab", () => ({
  openProjectTab: vi.fn(),
  requestProjectTabFromOtherWindow: vi.fn(),
}));
vi.mock("../services/concierge", async (importOriginal) => ({
  turnAccountFor: () => null,
  SUPERSEDED_DETAILS: (await importOriginal<Concierge>()).SUPERSEDED_DETAILS,
  isSupersededDetail: (await importOriginal<Concierge>()).isSupersededDetail,
  startConciergeTurn: h.startConciergeTurn,
  startProactiveConciergeTurn: vi.fn(async (): Promise<string | null> => null),
  isProactiveTurn: () => false,
  ConciergeAiDisabledError: class ConciergeAiDisabledError extends Error {},
  onConciergeTool: (cb: (e: { id: string; name: string; input: string }) => void) => {
    h.brain.tool = cb;
    return () => {};
  },
  onConciergeDelta: (cb: (e: { id: string; text: string }) => void) => {
    h.brain.delta = cb;
    return () => {};
  },
  onConciergeDone: (cb: (e: { id: string; text: string }) => void) => {
    h.brain.done = cb;
    return () => {};
  },
  onConciergeError: (cb: (e: { id: string; detail: string }) => void) => {
    h.brain.error = cb;
    return () => {};
  },
  onConciergeTurnsAbandoned: () => () => {},
}));
vi.mock("../services/conciergeDispatch", () => ({
  dispatchConciergeAnswer: vi.fn(async () => ({ ok: true })),
  flushPendingSends: vi.fn(async () => []),
  agentCanAcceptInput: vi.fn(() => true),
  agentCanAcceptPrompt: vi.fn(() => true),
  liveOptionsFor: vi.fn(() => []),
  isTerseAnswer: vi.fn(() => false),
  matchAnswerToOption: vi.fn(() => null),
  answersLivePicker: () => false,
  onDeferredSendOutcome: () => () => {},
}));
vi.mock("../services/conciergeRouter", () => ({
  routeMessage: vi.fn(async () => ({ target: "sparkle", reason: "test", source: "heuristic" })),
}));
vi.mock("../services/history", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  recordHistory: h.recordHistory,
}));
// THE LEDGER READ — the only thing stubbed about the roster path. `buildDispatchPreamble`,
// `withDispatchPreamble` and the host's own composition all stay real, so this drives the production
// fold-in end to end and only the SQLite round trip is replaced.
vi.mock("../services/dispatchRecall", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  openDispatches: h.openDispatches,
}));

import { ConciergeHost } from "./ConciergeHost";
import type { ConciergeFeed } from "../useConciergeFeed";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";
import { useConciergeThreadStore } from "../stores/conciergeThreadStore";
import { DISPATCH_PREAMBLE_HEADER, MAX_DISPATCH_LINES } from "../stores/conciergeDispatchStore";

const MIN = 60_000;

const calmFeed = (): ConciergeFeed => {
  const counts = { needs_you: 0, questions: 0, running: 0, done: 0 };
  return {
    projects: [
      { id: "p1", name: "sparkle", inScope: true, counts, scopedCounts: counts, agents: [] },
    ],
    counts,
    scopedCounts: counts,
    pinnedProjectId: null,
  } as unknown as ConciergeFeed;
};

function dispatch(over: Partial<RecalledDispatch> = {}): RecalledDispatch {
  const dispatchedAtMs = over.dispatchedAtMs ?? Date.now() - 8 * MIN;
  return {
    targetId: "8f590b78",
    channel: "build",
    name: "Sparkle Preview Card Inline",
    nameAtDispatch: "Sparkle Preview Card Inline",
    renamedSince: false,
    projectId: "p1",
    projectName: "sparkle",
    dispatchedAtMs,
    ageMs: Date.now() - dispatchedAtMs,
    ask: "make the preview cards inline in chat, one-third width",
    brief: "Investigate rendering preview cards inline at one-third width in the concierge column.",
    briefTruncated: false,
    beads: [],
    mode: "build",
    by: "concierge",
    status: "working",
    addressable: true,
    ...over,
  };
}

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

async function send(text: string) {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
  fireEvent.click(screen.getByText("Send"));
  await settle();
}

const promptAt = (n: number): string => h.startConciergeTurn.mock.calls[n]![0];

beforeEach(() => {
  enableAiEnhancementsForTests();
  h.startConciergeTurn.mockClear();
  h.recordHistory.mockClear();
  h.openDispatches.mockReset();
  h.openDispatches.mockResolvedValue([]);
  useConciergeThreadStore.setState({ chat: [] });
});
afterEach(() => cleanup());

describe("the concierge cannot ask about work it already dispatched", () => {
  it("carries an EIGHT-MINUTE-OLD delegation about preview cards into the very prompt that asks about them", async () => {
    h.openDispatches.mockResolvedValue([dispatch()]);
    render(<ConciergeHost feed={calmFeed()} />);

    await send("can we make the preview cards inline in chat?");

    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
    const prompt = promptAt(0);
    // THE SIDE EFFECT. Not "the ledger has a row" — the delegation's own subject, the live agent
    // name and the handle needed to go check on it are all in the string the model reads.
    expect(prompt).toContain("make the preview cards inline in chat, one-third width");
    expect(prompt).toContain("Sparkle Preview Card Inline");
    expect(prompt).toContain("8f590b78");
    expect(prompt).toContain("8m ago");
    // ...introduced as the section the persona names, and ahead of his question rather than under it.
    expect(prompt).toContain(DISPATCH_PREAMBLE_HEADER);
    expect(prompt.indexOf(DISPATCH_PREAMBLE_HEADER)).toBeLessThan(
      prompt.indexOf("can we make the preview cards inline in chat?"),
    );
  });

  it("shows the LIVE name of a renamed agent, and still names the one it was dispatched under", async () => {
    h.openDispatches.mockResolvedValue([
      dispatch({ name: "Preview Cards Inline", nameAtDispatch: "Build 17", renamedSince: true }),
    ]);
    render(<ConciergeHost feed={calmFeed()} />);
    await send("what happened to the preview card work?");

    const prompt = promptAt(0);
    // "Build 17 is not the name of the agent right now … that doesn't mean anything to me because I
    // can't see it." The name he can see leads; the historical one is the aside.
    expect(prompt.indexOf("Preview Cards Inline")).toBeLessThan(prompt.indexOf("Build 17"));
    expect(prompt).toContain("Build 17");
  });

  it("orders by RECENCY, not alphabetically — three delegations whose orders are opposite", async () => {
    const now = Date.now();
    h.openDispatches.mockResolvedValue([
      dispatch({ targetId: "z-id", name: "Zulu", ask: "zulu subject", dispatchedAtMs: now - 2 * MIN }),
      dispatch({ targetId: "m-id", name: "Mike", ask: "mike subject", dispatchedAtMs: now - 200 * MIN }),
      dispatch({ targetId: "a-id", name: "Alpha", ask: "alpha subject", dispatchedAtMs: now - 900 * MIN }),
    ]);
    render(<ConciergeHost feed={calmFeed()} />);
    await send("what have you got running?");

    const prompt = promptAt(0);
    expect(prompt.indexOf("zulu subject")).toBeLessThan(prompt.indexOf("mike subject"));
    expect(prompt.indexOf("mike subject")).toBeLessThan(prompt.indexOf("alpha subject"));
  });

  it("SAYS how many it did not show — a clipped roster must never read as a complete one", async () => {
    const now = Date.now();
    h.openDispatches.mockResolvedValue(
      Array.from({ length: MAX_DISPATCH_LINES + 4 }, (_v, i) =>
        dispatch({
          targetId: `id-${i}`,
          name: `Agent ${i}`,
          ask: `subject ${i}`,
          dispatchedAtMs: now - i * MIN,
        }),
      ),
    );
    render(<ConciergeHost feed={calmFeed()} />);
    await send("anything else running?");

    expect(promptAt(0)).toContain("and 4 more open delegation(s) not shown");
  });

  // THE PAIRED NEGATIVE. Without it the rows above would also pass against an implementation that
  // pasted something unconditional into every prompt — and it pins the rule that costs the most to
  // get wrong: a standing empty section on every turn teaches the model the section is noise.
  it("adds NOTHING when there is nothing open", async () => {
    h.openDispatches.mockResolvedValue([]);
    render(<ConciergeHost feed={calmFeed()} />);
    await send("morning");

    const prompt = promptAt(0);
    expect(prompt).not.toContain(DISPATCH_PREAMBLE_HEADER);
    expect(prompt).toContain("morning");
  });

  it("still sends the turn when the ledger cannot be read", async () => {
    h.openDispatches.mockRejectedValue(new Error("history.db is locked"));
    render(<ConciergeHost feed={calmFeed()} />);
    await send("hello?");

    // The degraded answer is "no section", never "no turn" — the roster must not be able to cost the
    // founder his message.
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
    expect(promptAt(0)).toContain("hello?");
    expect(promptAt(0)).not.toContain(DISPATCH_PREAMBLE_HEADER);
  });

  it("REREADS the ledger on every turn — a roster stamped once is the bug this feature fixes", async () => {
    h.openDispatches.mockResolvedValue([]);
    render(<ConciergeHost feed={calmFeed()} />);
    await send("first message, nothing running yet");
    act(() => h.brain.done?.({ id: "1", text: "ok" }));
    await settle();

    // ...and NOW the concierge spawns something. A cache refreshed off the turn path would still be
    // holding the empty roster on the very next message, which is the measured failure exactly.
    h.openDispatches.mockResolvedValue([dispatch()]);
    await send("can we make the preview cards inline in chat?");

    expect(h.startConciergeTurn).toHaveBeenCalledTimes(2);
    expect(promptAt(0)).not.toContain(DISPATCH_PREAMBLE_HEADER);
    expect(promptAt(1)).toContain("make the preview cards inline in chat, one-third width");
  });
});
