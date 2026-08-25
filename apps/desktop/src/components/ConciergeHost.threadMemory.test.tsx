// @vitest-environment jsdom
//
// THE GOAL SUITE: a prior turn's content must be available to the NEXT turn, and every exchange must
// reach the search index.
//
// This is the regression the founder actually hit. The concierge's memory is the resumed Claude Code
// session (`--resume`), and the thread he can SEE is a separate persisted store. When the session is
// lost — the stale-resume self-heal, an account switch, an identity reset, a compaction — the model's
// memory goes to zero while the column still shows the whole conversation, and nothing says so. He
// asked about four earlier requests he could see on screen; the concierge had no memory of any of
// them and did archaeology for each.
//
// So these rows drive the REAL host through two full turns and assert on the SECOND turn's prompt.
// They fail against the code as it was: `buildSnapshot` carried the roster and one message.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

type Concierge = typeof import("../services/concierge");

const h = vi.hoisted(() => ({
  startConciergeTurn: vi.fn(async (_prompt: string): Promise<string | null> => null),
  recordHistory: vi.fn(async (_e: unknown) => {}),
  chatOnce: vi.fn(async () => "summary text"),
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
  // The failure handler reads the failed turn's account via turnAccountFor(e.id); a mock that omits
  // it throws 'No turnAccountFor export' the moment an auth/quota failure reaches that branch. null =
  // 'turn not remembered', which the rotation degrades on.
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
// The history SINK only. `historyStore.record` and the capture service stay real, so this drives the
// production path end to end and only the Tauri round trip is stubbed.
vi.mock("../services/history", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  recordHistory: h.recordHistory,
}));
// The summariser's model call. Left resolving so the fire-and-forget refresh is exercised rather
// than merely skipped; the threshold means it does not actually fire in these short threads.
vi.mock("../services/anthropic", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  chatOnce: h.chatOnce,
}));

import { ConciergeHost } from "./ConciergeHost";
import type { ConciergeFeed } from "../useConciergeFeed";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";
import { useConciergeThreadStore } from "../stores/conciergeThreadStore";
import { useConciergeThreadSummaryStore } from "../stores/conciergeThreadSummaryStore";
import {
  CONTINUITY_RECENT_HEADING,
  CONTINUITY_SUMMARY_HEADING,
} from "../engine/conciergeContinuity";

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
  h.chatOnce.mockClear();
  useConciergeThreadStore.setState({ chat: [] });
  useConciergeThreadSummaryStore.getState().clear();
});
afterEach(() => cleanup());

describe("the concierge begins a turn with the thread it is in", () => {
  it("carries the PREVIOUS exchange — both halves — into the next turn's prompt", async () => {
    render(<ConciergeHost feed={calmFeed()} />);

    await send("remember I asked about the billing migration");
    act(() => h.brain.done?.({ id: "1", text: "Noted — billing migration is on the list." }));
    await settle();

    await send("what did I ask you earlier?");

    expect(h.startConciergeTurn).toHaveBeenCalledTimes(2);
    const second = promptAt(1);
    // What he SAID...
    expect(second).toContain("remember I asked about the billing migration");
    // ...and what he was TOLD. A reply the concierge cannot recall giving is the same failure.
    expect(second).toContain("Noted — billing migration is on the list.");
    expect(second).toContain(CONTINUITY_RECENT_HEADING);
    // ...and the new message is still the last thing in the prompt.
    expect(second.indexOf("what did I ask you earlier?")).toBeGreaterThan(
      second.indexOf("remember I asked about the billing migration"),
    );
  });

  // THE PAIRED NEGATIVE. Without it, the row above would also pass against an implementation that
  // pasted something unconditional into every prompt. This is what proves the block is DERIVED from
  // the thread — and it pins that a first turn is unchanged by this feature.
  it("adds NOTHING to the first turn, which has no thread behind it", async () => {
    render(<ConciergeHost feed={calmFeed()} />);
    await send("first thing I have ever said");
    const first = promptAt(0);
    expect(first).not.toContain(CONTINUITY_RECENT_HEADING);
    expect(first).not.toContain(CONTINUITY_SUMMARY_HEADING);
    expect(first).toContain("first thing I have ever said");
  });

  it("injects the rolling summary when one exists", async () => {
    useConciergeThreadSummaryStore
      .getState()
      .set({ text: "- founder asked for the retry fix; unresolved", throughMessageId: "m0" });
    render(<ConciergeHost feed={calmFeed()} />);
    await send("where are we?");
    const first = promptAt(0);
    expect(first).toContain(CONTINUITY_SUMMARY_HEADING);
    expect(first).toContain("founder asked for the retry fix; unresolved");
  });
});

describe("the conversation reaches the search index", () => {
  it("records BOTH halves of an exchange with the concierge source", async () => {
    render(<ConciergeHost feed={calmFeed()} />);

    await send("index this ask");
    act(() => h.brain.done?.({ id: "1", text: "and index this answer" }));
    await settle();

    const recorded = h.recordHistory.mock.calls.map(
      (c) => c[0] as { kind: string; source: string; text: string },
    );
    const prompt = recorded.find((e) => e.text.includes("index this ask"));
    const response = recorded.find((e) => e.text.includes("and index this answer"));

    // BOTH, asserted together: a test that only checked the prompt would stay green against the
    // pre-existing AgentPane-shaped capture, which records a prompt and never the concierge's reply.
    expect(prompt).toBeTruthy();
    expect(prompt!.source).toBe("concierge");
    expect(prompt!.kind).toBe("prompt");
    expect(response).toBeTruthy();
    expect(response!.source).toBe("concierge");
    expect(response!.kind).toBe("response");
  });

  it("does not re-record the same message twice", async () => {
    render(<ConciergeHost feed={calmFeed()} />);
    await send("say it once");
    act(() => h.brain.done?.({ id: "1", text: "ok" }));
    await settle();
    // Another unrelated store write must not re-drain the whole thread.
    await send("second message");
    const asks = h.recordHistory.mock.calls.filter((c) =>
      (c[0] as { text: string }).text.includes("say it once"),
    );
    expect(asks).toHaveLength(1);
  });
});
