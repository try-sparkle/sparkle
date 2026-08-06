// @vitest-environment jsdom
//
// ══ THE GUARANTEE A COLLAPSED PILL MUST NEVER BREAK ═════════════════════════════════════════════
//
// A user's message is rendered several ways, and this suite exists because ONE of them is a live
// Claude Code PTY. ./Concierge/agentRefs' header keeps the count and states the hazard; this is the
// executable half of it. Collapsing a paste into a pill is a DISPLAY decision about the bubble. If it
// ever shortened the payload, the agent would silently receive less than the founder typed — a
// failure with no symptom on screen at all: the transcript would look right, the pill would open, and
// the agent would simply have been briefed on half a diff.
//
// So every row below asserts BOTH halves of the same send at once:
//   1. the bubble does NOT contain the paste (it is a pill), and
//   2. the string handed to the destination IS the paste, byte for byte, canary and edges included.
// Asserting either alone is what would let this regress. A suite that only checked the pill would
// stay green through the exact truncation it is meant to prevent.
//
// WHY THROUGH THE HOST rather than by calling `send` directly: the split is created in the compose
// box (which knows where a block starts) and consumed in the bubble, and the payload is built between
// them. A row that hand-built the `CollapsedSend` would be testing its own fixture past the seam that
// can actually break.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  openProjectTab: vi.fn(),
  startConciergeTurn: vi.fn(async (_prompt: string): Promise<string | null> => null),
  // The parameters are NAMED even though the body ignores them: `mock.calls[0][1]` is the string
  // this whole file is about, and an argument-less spy types that index as `never`.
  dispatch: vi.fn(
    async (
      _agentId: string,
      _text: string,
      _opts?: unknown,
    ): Promise<{ ok: boolean; path?: string }> => ({ ok: true }),
  ),
  route: vi.fn(async () => ({
    target: "sparkle" as "sparkle" | "agent",
    reason: "test",
    source: "heuristic" as const,
  })),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("../services/openProjectTab", () => ({
  openProjectTab: h.openProjectTab,
  requestProjectTabFromOtherWindow: vi.fn(),
}));
// Spread the real module and replace what this suite drives — vitest throws on ACCESS to an export a
// factory omits, so a hand-listed partial mock breaks the moment the host imports anything else.
vi.mock("../services/concierge", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    startConciergeTurn: h.startConciergeTurn,
    onConciergeTool: () => () => {},
    onConciergeDelta: () => () => {},
    onConciergeDone: () => () => {},
    onConciergeError: () => () => {},
    onConciergeTurnsAbandoned: () => () => {},
  };
});
vi.mock("../services/conciergeDispatch", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    dispatchConciergeAnswer: h.dispatch,
    flushPendingSends: vi.fn(async () => []),
    onDeferredSendOutcome: () => () => {},
  };
});
// A KNOB, not a subject: these rows are about which rendering reaches which destination, not about
// how the routing decision is made (services/conciergeRouter.test.ts owns that).
vi.mock("../services/conciergeRouter", () => ({ routeMessage: h.route }));
vi.mock("./Concierge/ConciergeSuggestions", () => ({ ConciergeSuggestions: () => null }));
// Mocked in every host suite: the host imports the dictation hook unconditionally, so the real one
// would run on every simulated send and couple these rows to the mic pipeline.
vi.mock("../useConciergeDictation", () => ({
  useConciergeDictation: () => ({ interim: "", toggleMic: vi.fn(), registerInsert: vi.fn() }),
}));

import { ConciergeHost } from "./ConciergeHost";
import { useConciergeThreadStore } from "../stores/conciergeThreadStore";
import type { ConciergeFeed } from "../useConciergeFeed";
import { armedIntents, clearAllIntents, fireIntent } from "../services/dispatchIntent";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";

/** A line buried DEEP in the paste. Only the full text can contain it, which is what makes both
 *  halves of every row below facts rather than impressions. */
const CANARY = "line-19-nobody-should-read-this-in-the-transcript";

/** The paste. Over the collapse threshold on lines, and with BOTH edges load-bearing — a four-space
 *  indent on line one and a trailing newline — because a trim on the way to the PTY is exactly the
 *  silent corruption this file is here to catch, and only the edges can see it. */
const PASTE = `${[
  "    diff --git a/src/app.ts b/src/app.ts",
  "  -  const a = 1;",
  "  +  const a = 2;",
  "",
  ...Array.from({ length: 13 }, (_, i) => `  context line ${i + 1}`),
  CANARY,
  "\tif (a) return;",
].join("\n")}\n`;

const TYPED = "what is wrong here?";
/** What the compose box composes, and therefore exactly what every non-bubble rendering must carry:
 *  the block's full text, then a blank line, then the typed words. */
const BODY = `${PASTE}\n\n${TYPED}`;

const target = { projectId: "p1", agentId: "ag1", name: "CI Hardening" };

function feed(): ConciergeFeed {
  const counts = { needs_you: 1, questions: 0, running: 0, done: 0 };
  const agent = {
    id: "ag1",
    name: "CI Hardening",
    projectId: "p1",
    projectName: "sparkle",
    kind: "build" as const,
    status: "approval",
    statusColor: "#e0533f",
    statusLabel: "Approve?",
    band: "needs_you" as const,
    inScope: true,
    muted: false,
    topLevel: true,
    representedElsewhere: false,
  };
  return {
    projects: [
      { id: "p1", name: "sparkle", inScope: true, counts, scopedCounts: counts, agents: [agent] },
    ],
    counts,
    scopedCounts: counts,
    pinnedProjectId: null,
  } as unknown as ConciergeFeed;
}

const mount = () => render(<ConciergeHost feed={feed()} promptTarget={target} />);
const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const threadEl = () => screen.getByTestId("concierge-thread");
const pills = () => within(threadEl()).queryAllByTestId("composer-text-pill");

/** Paste into the compose box the way the browser does. jsdom does not run the default action, so
 *  the native insert is performed here only when the handler declined to prevent it — which also
 *  makes the return value a report of whether the box intercepted the paste. */
function paste(text: string): { prevented: boolean } {
  const ta = box();
  const e = new Event("paste", { bubbles: true, cancelable: true }) as Event & {
    clipboardData: { getData: (t: string) => string };
  };
  e.clipboardData = { getData: (t: string) => (t === "text/plain" ? text : "") };
  act(() => {
    ta.dispatchEvent(e);
  });
  if (!e.defaultPrevented) fireEvent.change(ta, { target: { value: ta.value + text } });
  return { prevented: e.defaultPrevented };
}

const type = (text: string) => fireEvent.change(box(), { target: { value: text } });

/** An agent-bound send ARMS a cancellable intent and only the uncancelled expiry delivers, so a
 *  suite asserting what reached the PTY has to pass through that gate. Fired directly rather than by
 *  advancing timers, so this file keeps real timers. */
async function elapseCountdowns() {
  const pending = armedIntents();
  if (pending.length === 0) return;
  await act(async () => {
    for (const i of pending) fireIntent(i.id);
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

const clickSend = async () => {
  await act(async () => {
    fireEvent.click(screen.getByText("Send"));
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
  await elapseCountdowns();
};

const routeToAgent = () =>
  h.route.mockResolvedValue({ target: "agent", reason: "test", source: "heuristic" });

beforeEach(() => {
  // The column locks thread and composer whenever the AI gate is shut, and a fresh test's default is
  // the locked anonymous trial. Stated rather than inherited.
  enableAiEnhancementsForTests();
  // The thread store is MODULE-level and persisted, so a row would otherwise read the previous
  // row's bubbles.
  useConciergeThreadStore.getState().clearChat();
  vi.clearAllMocks();
  h.dispatch.mockResolvedValue({ ok: true, path: "free-text" });
  h.route.mockResolvedValue({ target: "sparkle", reason: "test", source: "heuristic" });
  h.startConciergeTurn.mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  // A module-level armed intent would otherwise leak into the next row.
  clearAllIntents();
});

describe("ConciergeHost — a pasted block reaches the PTY WHOLE and the bubble as a pill", () => {
  it("hands the agent's terminal every byte, while the bubble shows a pill", async () => {
    mount();
    expect(paste(PASTE).prevented).toBe(true);
    type(TYPED);
    routeToAgent();
    await clickSend();

    // ── 1. THE WIRE. The full body, byte for byte. ───────────────────────────────────────────────
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    const sent = h.dispatch.mock.calls[0]![1];
    expect(sent).toBe(BODY);
    // Said separately, because `toBe` above would fail identically for a dozen unrelated reasons and
    // these are the three specific corruptions collapsing could introduce.
    expect(sent).toContain(CANARY);
    expect(sent.startsWith("    diff --git")).toBe(true); // the indent is content, not whitespace
    expect(sent).toContain(`${PASTE}\n\n`); // the trailing newline survived the join

    // ── 2. THE BUBBLE. A pill, and the question still readable next to it. ───────────────────────
    expect(threadEl().textContent).not.toContain(CANARY);
    expect(pills()).toHaveLength(1);
    expect(within(threadEl()).getByTestId("you-bubble").textContent).toContain(TYPED);
  });

  it("hands the BRAIN every byte too — the other destination, same guarantee", async () => {
    // The default route. The brain is not a PTY, but it is the destination almost every message
    // takes, and a bubble-shaped truncation would reach it by the identical path.
    mount();
    paste(PASTE);
    type(TYPED);
    await clickSend();

    const prompts = h.startConciergeTurn.mock.calls.map((c) => String(c[0]));
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.some((p) => p.includes(CANARY))).toBe(true);
    expect(prompts.some((p) => p.includes(BODY))).toBe(true);
    expect(threadEl().textContent).not.toContain(CANARY);
    expect(pills()).toHaveLength(1);
  });

  it("sends a paste-only message whole, and draws it as a pill with no words", async () => {
    // A box holding one pill and nothing typed is a valid send (`canSend` counts a staged block), and
    // it is the case where `text` on the bubble is the empty string — the shape most likely to lose
    // its content on the way out.
    mount();
    paste(PASTE);
    routeToAgent();
    await clickSend();

    expect(h.dispatch.mock.calls[0]![1]).toBe(PASTE);
    expect(pills()).toHaveLength(1);
    expect(threadEl().textContent).not.toContain(CANARY);
  });

  it("puts the WHOLE paste behind the bubble's pill — openable, verbatim, after the round trip", async () => {
    // The end of the loop: the block the compose box staged survived the send, the host, the store
    // and the transcript, and still opens as the exact bytes that were pasted. Without this a pill
    // could be drawn from a truncated copy and every other row here would still pass.
    mount();
    paste(PASTE);
    type(TYPED);
    routeToAgent();
    await clickSend();

    fireEvent.click(pills()[0]!);
    expect(screen.getByTestId("text-pill-full-text").textContent).toBe(PASTE);
  });

  it("leaves a SHORT message exactly as it was — no pill, words in the bubble", async () => {
    // The no-regression half. Under the threshold the paste is never intercepted at all, so the
    // bubble is the plain one it has always been.
    mount();
    expect(paste("just a couple\nof lines").prevented).toBe(false);
    routeToAgent();
    await clickSend();

    expect(h.dispatch.mock.calls[0]![1]).toBe("just a couple\nof lines");
    expect(pills()).toHaveLength(0);
    expect(threadEl().textContent).toContain("just a couple");
  });
});
