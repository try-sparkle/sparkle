// @vitest-environment jsdom
//
// THE WIRING: a real streamed reply comes back stamped with the messages it is answering.
//
// The rule lives in Concierge/replyAnchors (unit-tested there) and the rendering in
// Concierge/ConciergeThread.anchors.test.tsx. NEITHER of those proves the host actually calls it —
// and a rule nothing invokes is precisely the failure mode this repo keeps finding (the proactive
// channel shipped with its trigger, transport and staleness rule all tested and NOTHING mounted).
// So these cases drive the concierge transport the way the app does — deltas and a `done` — and
// assert on the bubble that comes out.
import { act, cleanup, render, screen } from "@testing-library/react";
import { useAuthStore } from "../stores/authStore";
import { useSettingsStore } from "../stores/settingsStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  proactiveIds: new Set<string>(),
  delta: null as ((e: { id: string; text: string }) => void) | null,
  done: null as ((e: { id: string; sessionId: string; text: string }) => void) | null,
}));

vi.mock("../services/concierge", () => ({
  // The LIVE tool channel. A no-op unsubscribe, exactly like its siblings: these suites are about
  // the host's other wiring, and a mock that simply OMITS an export the host calls does not
  // degrade — vitest throws on the missing property and every case in the file dies at mount.
  onConciergeTool: () => () => {},
  onConciergeDelta: (cb: (e: { id: string; text: string }) => void) => {
    h.delta = cb;
    return () => {
      h.delta = null;
    };
  },
  onConciergeDone: (cb: (e: { id: string; sessionId: string; text: string }) => void) => {
    h.done = cb;
    return () => {
      h.done = null;
    };
  },
  onConciergeError: () => () => {},
  onConciergeTurnsAbandoned: () => () => {},
  startConciergeTurn: vi.fn(() => Promise.resolve("1")),
  startProactiveConciergeTurn: vi.fn(() => Promise.resolve(null)),
  isProactiveTurn: (id: string) => h.proactiveIds.has(id),
  isSupersededDetail: (d: string) => d.includes("superseded") || d.includes("cancelled"),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("../services/openProjectTab", () => ({ openProjectTab: vi.fn() }));

// Same signed-in stub the sibling host suites use: something in this tree drives authStore.refresh(),
// which clears `me` and swaps the thread for the AI-enhancements lock. This suite is about anchoring,
// not entitlement.
const SIGNED_IN_ME = { clerkUserId: "u1", entitled: true, balanceCents: 5_000, tokenVersion: 1 };
vi.mock("../services/sparkleApi", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  hasToken: () => Promise.resolve(true),
  fetchMe: () => Promise.resolve(SIGNED_IN_ME),
}));

import { ConciergeHost } from "./ConciergeHost";
import { useConciergeThreadStore } from "../stores/conciergeThreadStore";
import { ANSWERED_MARKER_TESTID, REPLY_ANCHOR_TESTID } from "./Concierge/ReplyAnchorViews";
import type { ConciergeMessage } from "./Concierge/types";
import type { ConciergeFeed } from "../useConciergeFeed";

const feed = {
  projects: [],
  counts: { needs_you: 0, running: 0, done: 0 },
  scopedCounts: { needs_you: 0, running: 0, done: 0 },
  pinnedProjectId: null,
} as unknown as ConciergeFeed;

/** The founder's burst: several messages sent while a turn was in flight, none answered yet. */
function seedBurst(): void {
  const chat: ConciergeMessage[] = [
    { id: "you-1", kind: "you", text: "can you check the retry logic", receipt: { target: "sparkle" } },
    { id: "you-2", kind: "you", text: "also the timeout", receipt: { target: "sparkle" } },
  ];
  useConciergeThreadStore.getState().setChat(chat);
}

/** The bubble the brain streamed, as the store holds it. */
function replyBubble(id = "brain-1") {
  const m = useConciergeThreadStore.getState().chat.find((x) => x.id === id);
  return m?.kind === "sparkle" ? m : undefined;
}

beforeEach(() => {
  useSettingsStore.setState({ aiConcierge: true });
  useAuthStore.setState({ me: SIGNED_IN_ME, creditFloorCents: 0 } as never);
  h.proactiveIds.clear();
  h.delta = null;
  h.done = null;
  useConciergeThreadStore.getState().clearChat();
});
afterEach(() => cleanup());

describe("a streamed reply arrives knowing what it answers", () => {
  it("anchors every message the brain still owed an answer on", () => {
    seedBurst();
    render(<ConciergeHost feed={feed} />);
    act(() => h.delta?.({ id: "1", text: "Both are fine." }));

    expect(replyBubble()?.answers).toEqual([
      { id: "you-1", quote: "can you check the retry logic" },
      { id: "you-2", quote: "also the timeout" },
    ]);
    // The reply says what it is answering AS SOON AS IT STARTS — the stub reads off the message
    // itself, so a reader watching the answer arrive can already see which question it belongs to.
    expect(screen.getAllByTestId(REPLY_ANCHOR_TESTID)).toHaveLength(2);
    // …but his own messages are NOT marked answered yet, because this turn may still die. An
    // unsettled bubble is a claim in progress, not a delivery (see replyAnchors.answeredByIndex).
    expect(screen.queryAllByTestId(ANSWERED_MARKER_TESTID)).toHaveLength(0);

    // The turn finishes, and only now does "Answered below" appear — which is what the word means.
    act(() => h.done?.({ id: "1", sessionId: "s", text: "Both are fine." }));
    expect(screen.getAllByTestId(ANSWERED_MARKER_TESTID)).toHaveLength(2);
  });

  it("keeps the anchors when `done` overwrites the streamed text", () => {
    // The final upsert replaces the bubble's text wholesale (the lint pass rewrites it). A stamp that
    // did not survive that would be invisible in every real conversation and visible in none of the
    // delta-only tests.
    seedBurst();
    render(<ConciergeHost feed={feed} />);
    act(() => h.delta?.({ id: "1", text: "Both" }));
    act(() => h.done?.({ id: "1", sessionId: "s", text: "Both are fine, and CI is green." }));

    expect(replyBubble()?.text).toBe("Both are fine, and CI is green.");
    expect(replyBubble()?.answers?.map((a) => a.id)).toEqual(["you-1", "you-2"]);
  });

  it("anchors a reply that never streamed a delta, only a done", () => {
    seedBurst();
    render(<ConciergeHost feed={feed} />);
    act(() => h.done?.({ id: "1", sessionId: "s", text: "Both fine." }));
    expect(replyBubble()?.answers?.map((a) => a.id)).toEqual(["you-1", "you-2"]);
  });

  it("does NOT claim a message the previous FINISHED reply already answered", () => {
    useConciergeThreadStore.getState().setChat([
      { id: "you-1", kind: "you", text: "old question", receipt: { target: "sparkle" } },
      { id: "brain-0", kind: "sparkle", text: "old answer", settled: true },
      { id: "you-2", kind: "you", text: "new question", receipt: { target: "sparkle" } },
    ]);
    render(<ConciergeHost feed={feed} />);
    act(() => h.delta?.({ id: "1", text: "Sure." }));
    expect(replyBubble()?.answers?.map((a) => a.id)).toEqual(["you-2"]);
  });

  it("records that a turn FINISHED, which is what makes the line above decidable", () => {
    // "A left-aligned bubble exists" and "the brain finished answering" are different facts. Three
    // things render as one bubble — a real answer, an app status line, and a turn killed mid-stream —
    // and only this flag tells them apart.
    seedBurst();
    render(<ConciergeHost feed={feed} />);
    act(() => h.delta?.({ id: "1", text: "Both fine." }));
    expect(replyBubble()?.settled).toBeUndefined();
    act(() => h.done?.({ id: "1", sessionId: "s", text: "Both fine." }));
    expect(replyBubble()?.settled).toBe(true);
  });

  it("marks a turn finished even when `done` carries no text of its own", () => {
    // The final upsert is skipped for a textless `done` — which is exactly a turn whose deltas already
    // said everything, i.e. the case where a flag set inside that upsert would never be set at all.
    seedBurst();
    render(<ConciergeHost feed={feed} />);
    act(() => h.delta?.({ id: "1", text: "Both fine." }));
    act(() => h.done?.({ id: "1", sessionId: "s", text: "" }));
    expect(replyBubble()?.settled).toBe(true);
    expect(replyBubble()?.text).toBe("Both fine.");
  });

  it("is not ended by the app's own status line — a receipt is not an answer", () => {
    // The founder interleaves an agent-bound message into a burst, and `deliver` posts "Sent to
    // Kraken Auth." as an ordinary sparkle bubble (ConciergeHost.postSparkle does this in 25 places).
    // Reading it as the previous reply makes the brain's answer anchor NOTHING — the affordance
    // failing in exactly the interleaved case it was built for.
    useConciergeThreadStore.getState().setChat([
      { id: "you-1", kind: "you", text: "how's CI", receipt: { target: "sparkle" } },
      {
        id: "you-2",
        kind: "you",
        text: "@Kraken run the tests",
        receipt: { target: "agent", agentName: "Kraken Auth" },
      },
      { id: "sparkle-1", kind: "sparkle", text: "Sent to Kraken Auth." },
    ]);
    render(<ConciergeHost feed={feed} />);
    act(() => h.delta?.({ id: "1", text: "CI is green." }));
    expect(replyBubble()?.answers?.map((a) => a.id)).toEqual(["you-1"]);
  });

  it("re-answers a burst the first turn died mid-stream on, and points the marker at the LIVE reply", () => {
    // THE MOTIVATING CASE, end to end. Turn 1 streams nine characters; the founder's next message
    // kills it (askSparkle leaves that fragment alone on purpose); turn 2 answers both. The fragment
    // must neither end the burst nor keep the marker it was stamped with.
    useConciergeThreadStore
      .getState()
      .setChat([{ id: "you-1", kind: "you", text: "how's CI", receipt: { target: "sparkle" } }]);
    render(<ConciergeHost feed={feed} />);
    act(() => h.delta?.({ id: "1", text: "Let me ch" }));
    expect(replyBubble("brain-1")?.answers?.map((a) => a.id)).toEqual(["you-1"]);

    // …the second message lands, killing turn 1, and turn 2 answers the pair.
    act(() => {
      useConciergeThreadStore
        .getState()
        .setChat((prev) => [
          ...prev,
          { id: "you-2", kind: "you", text: "and the timeout", receipt: { target: "sparkle" } },
        ]);
    });
    act(() => h.delta?.({ id: "2", text: "CI is green and the timeout is 3s." }));
    act(() => h.done?.({ id: "2", sessionId: "s", text: "CI is green and the timeout is 3s." }));

    expect(replyBubble("brain-2")?.answers?.map((a) => a.id)).toEqual(["you-1", "you-2"]);
    // The marker under his first message points at the REAL answer, not at the dead fragment.
    const marker = screen
      .getAllByTestId(ANSWERED_MARKER_TESTID)
      .find((el) => el.closest("[data-message-id]")?.getAttribute("data-message-id") === "you-1");
    expect(marker?.getAttribute("data-reply-id")).toBe("brain-2");
  });

  it("leaves a PUSH anchoring nothing — nobody asked it anything", () => {
    h.proactiveIds.add("9");
    seedBurst();
    render(<ConciergeHost feed={feed} />);
    act(() => h.delta?.({ id: "9", text: "Heads up, CI went red." }));

    expect(replyBubble("brain-9")?.proactive).toBe(true);
    expect(replyBubble("brain-9")?.answers).toBeUndefined();
    expect(screen.queryByTestId(REPLY_ANCHOR_TESTID)).toBeNull();
    expect(screen.queryByTestId(ANSWERED_MARKER_TESTID)).toBeNull();
  });

  it("leaves a reply with nothing outstanding unanchored", () => {
    render(<ConciergeHost feed={feed} />);
    act(() => h.delta?.({ id: "1", text: "Morning." }));
    expect(replyBubble()?.answers).toBeUndefined();
  });

  it("does not claim a message that went into an agent's terminal", () => {
    // The brain never saw it; a stub over the reply would send him to an answer that says nothing
    // about it — the same class of false statement as the "never answered" line this replaces.
    useConciergeThreadStore.getState().setChat([
      {
        id: "you-1",
        kind: "you",
        text: "run the tests",
        receipt: { target: "agent", agentName: "Kraken Auth" },
      },
      { id: "you-2", kind: "you", text: "what did that do", receipt: { target: "sparkle" } },
    ]);
    render(<ConciergeHost feed={feed} />);
    act(() => h.delta?.({ id: "1", text: "It ran the suite." }));
    expect(replyBubble()?.answers?.map((a) => a.id)).toEqual(["you-2"]);
  });
});
