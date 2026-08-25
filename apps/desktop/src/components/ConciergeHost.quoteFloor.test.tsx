// @vitest-environment jsdom
//
// THE DETERMINISTIC QUOTE FLOOR — every founder-facing reply is RENDERED quoting the message it
// answers, even when the model refuses (bead sparkle-j6jra).
//
// ══ THE FAILURE THIS EXISTS FOR ═════════════════════════════════════════════════════════════════
// `reply-without-quote` blocks a reply that does not open by quoting the founder and re-prompts the
// model ONCE. A re-prompt is still an instruction the model can ignore, and every give-up exit then
// rendered the reply UNQUOTED and marked — which is the founder's standing complaint ("it launches
// into analysis without saying which of my messages it is answering"). This suite drives the REAL
// give-up path through the mounted host and asserts the SIDE EFFECT: the bubble the founder sees now
// opens with a blockquote of his own words, inserted by code, on the model's failure.
//
// NOT VACUOUS: the assertion fails against the old mount and against a build with the enforcement
// removed. Turn off `ensureLeadingFounderQuote` (make it return its input unchanged) and the "give
// up" row goes red, because the held reply never contained the founder's words. The paired "model
// complied" row proves the floor STANDS DOWN when the reply already quotes — the model's own quote is
// preserved and nothing is double-inserted.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { LintResult, Violation } from "../services/conciergeLint";

type DoneEvent = {
  id: string;
  sessionId: string;
  text: string;
  toolCalls?: { name: string; input: string }[];
};

const h = vi.hoisted(() => ({
  startConciergeTurn: vi.fn(async (_p: string): Promise<string | null> => null),
  routeMessage: vi.fn(async () => ({
    target: "sparkle" as const,
    reason: "test",
    source: "heuristic" as const,
  })),
  runReplyLint: vi.fn(),
  reportLintOutcome: vi.fn(),
  getConfig: vi.fn(async () => ({ config: { concierge: { checks: undefined } } })),
  onConfigChanged: vi.fn(async (_cb: (eff: unknown) => void) => () => {}),
  brain: {} as {
    delta?: (e: { id: string; text: string }) => void;
    done?: (e: DoneEvent) => void;
    error?: (e: { id: string; detail: string }) => void;
    reset?: (e: unknown) => void;
  },
}));

vi.mock("../services/openProjectTab", () => ({
  openProjectTab: vi.fn(),
  requestProjectTabFromOtherWindow: vi.fn(),
}));
vi.mock("../services/concierge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/concierge")>();
  return {
    // The failure handler reads the failed turn's account via turnAccountFor(e.id); a mock that omits
    // it throws 'No turnAccountFor export' the moment an auth/quota failure reaches that branch. null =
    // 'turn not remembered', which the rotation degrades on.
    turnAccountFor: () => null,
    SUPERSEDED_DETAILS: real.SUPERSEDED_DETAILS,
    isSupersededDetail: real.isSupersededDetail,
    ConciergeAiDisabledError: real.ConciergeAiDisabledError,
    startConciergeTurn: h.startConciergeTurn,
    startProactiveConciergeTurn: vi.fn(async (): Promise<string | null> => null),
    isProactiveTurn: () => false,
    onConciergeTool: () => () => {},
    onConciergeDelta: (cb: NonNullable<typeof h.brain.delta>) => {
      h.brain.delta = cb;
      return () => {};
    },
    onConciergeDone: (cb: NonNullable<typeof h.brain.done>) => {
      h.brain.done = cb;
      return () => {};
    },
    onConciergeError: (cb: NonNullable<typeof h.brain.error>) => {
      h.brain.error = cb;
      return () => {};
    },
    onConciergeTurnsAbandoned: (cb: NonNullable<typeof h.brain.reset>) => {
      h.brain.reset = cb;
      return () => {};
    },
  };
});
// `runReplyLint` is stubbed (what is under test is the MOUNT's floor, not the checks), but the FLOOR
// itself — `ensureLeadingFounderQuote`, invoked inside the host — is REAL, and so is `answerFields`'
// derivation of which founder message this reply answers. That is the seam this suite guards.
vi.mock("../services/conciergeLintRunner", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/conciergeLintRunner")>();
  return { ...real, runReplyLint: h.runReplyLint, reportLintOutcome: h.reportLintOutcome };
});
vi.mock("../services/config", () => ({ getConfig: h.getConfig, onConfigChanged: h.onConfigChanged }));
vi.mock("../services/conciergeDispatch", () => ({
  dispatchConciergeAnswer: vi.fn(async () => ({ ok: true })),
  flushPendingSends: vi.fn(async () => []),
  agentCanAcceptInput: () => true,
  agentCanAcceptPrompt: () => true,
  liveOptionsFor: () => [],
  isTerseAnswer: () => false,
  matchAnswerToOption: () => null,
  answersLivePicker: () => false,
  onDeferredSendOutcome: () => () => {},
}));
vi.mock("../services/conciergeRouter", () => ({ routeMessage: h.routeMessage }));
vi.mock("./Concierge/ConciergeSuggestions", () => ({ ConciergeSuggestions: () => null }));
vi.mock("../useConciergeDictation", () => ({
  useConciergeDictation: () => ({ interim: "", toggleMic: vi.fn(), registerInsert: vi.fn() }),
}));
vi.mock("../stores/sparklePrefsStore", () => ({
  useSparklePrefsStore: { getState: () => ({ setInterruptPreference: vi.fn() }) },
}));

import { ConciergeHost } from "./ConciergeHost";
import { useConciergeThreadStore } from "../stores/conciergeThreadStore";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";
import type { ConciergeFeed } from "../useConciergeFeed";
import type { StatusBand } from "../engine/buildSections";

const COUNTS: Record<StatusBand, number> = { needs_you: 0, questions: 0, running: 1, done: 0 };

function feed(): ConciergeFeed {
  const agent = {
    id: "ag1",
    name: "CI Hardening",
    projectId: "p1",
    projectName: "sparkle",
    kind: "build" as const,
    status: "working",
    statusColor: "#e0533f",
    statusLabel: "Working",
    band: "running" as StatusBand,
    inScope: true,
    muted: false,
    topLevel: true,
    representedElsewhere: false,
    rolledUpGreen: false,
  };
  return {
    projects: [
      { id: "p1", name: "sparkle", inScope: true, counts: COUNTS, scopedCounts: COUNTS, agents: [agent] },
    ],
    counts: COUNTS,
    scopedCounts: COUNTS,
    pinnedProjectId: null,
  } as unknown as ConciergeFeed;
}

// The founder's triggering message and the reply that ignores it. The reply shares NO content word
// with the message, so any occurrence of the message's words in the rendered reply can only be the
// code-inserted quote — never an accident of the reply's own prose.
const FOUNDER_MSG = "why did the auth PR ship from two branches";
const UNQUOTED_REPLY = "Both changes landed cleanly; nothing is broken.";
const CORRECTION_MARKER = "What has to change:";

function violation(check: string): Violation {
  return { check, severity: "block", action: "warned", span: 0, detail: "no opening quote" };
}
function blocked(text: string, checks = ["reply-without-quote"]): LintResult {
  return { text, violations: checks.map(violation), blocked: true };
}
function clean(text: string): LintResult {
  return { text, violations: [], blocked: false };
}

let issued: string[] = [];

beforeEach(() => {
  useConciergeThreadStore.setState({ chat: [] });
  enableAiEnhancementsForTests();
  issued = [];
  h.runReplyLint.mockImplementation((i: { text: string }) => clean(i.text));
  h.reportLintOutcome.mockImplementation(() => []);
  h.getConfig.mockResolvedValue({ config: { concierge: { checks: undefined } } });
  h.onConfigChanged.mockImplementation(async (_cb: (eff: unknown) => void) => () => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
  h.startConciergeTurn.mockResolvedValue(null);
  h.routeMessage.mockResolvedValue({ target: "sparkle", reason: "test", source: "heuristic" });
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}
async function send(text: string) {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
  fireEvent.click(screen.getByText("Send"));
  await flush();
}
async function done(e: DoneEvent) {
  await act(async () => {
    h.brain.done?.(e);
  });
  await flush();
}
/** The finalized sparkle reply bubble's text, as it sits in the store the thread renders from. */
function replyBubbleText(): string {
  const chat = useConciergeThreadStore.getState().chat;
  const bubble = chat.find((m) => m.kind === "sparkle");
  return bubble && bubble.kind === "sparkle" ? bubble.text : "";
}

describe("the deterministic quote floor — a founder-facing reply always opens quoting him", () => {
  it("PREPENDS the founder's words when the model never quotes them (give-up path)", async () => {
    // reply-without-quote blocks the reply; the correction turn returns no id, so the host gives up
    // and renders the held original — the exact path that used to ship unquoted.
    h.startConciergeTurn.mockResolvedValue(null);
    h.runReplyLint.mockImplementation((i: { text: string }) =>
      i.text === UNQUOTED_REPLY ? blocked(i.text) : clean(i.text),
    );

    render(<ConciergeHost feed={feed()} />);
    await flush();
    await send(FOUNDER_MSG);
    await done({ id: "1", sessionId: "s", text: UNQUOTED_REPLY, toolCalls: [] });

    const rendered = replyBubbleText();
    // THE SIDE EFFECT: the rendered reply now opens with a blockquote of the founder's own words…
    expect(rendered.startsWith(`> ${FOUNDER_MSG}`)).toBe(true);
    // …carrying his ACTUAL triggering message, not a generic label…
    expect(rendered).toContain(FOUNDER_MSG);
    // …and the model's analysis still follows underneath.
    expect(rendered).toContain(UNQUOTED_REPLY);
    // The now-satisfied "didn't open by quoting" mark is not shown on a reply that opens with a quote.
    expect(screen.getByTestId("concierge-thread").textContent ?? "").not.toContain(
      "Didn't open by quoting",
    );
  });

  it("STANDS DOWN when the model's corrected reply already quotes him (no double-insert)", async () => {
    // The correction turn dispatches (its prompt carries the marker) and comes back with a compliant
    // reply that opens with its OWN quote. The floor must leave that untouched.
    const CORRECTED = `> ${FOUNDER_MSG}\n\nThe merge queue reordered them across two branches.`;
    h.startConciergeTurn.mockImplementation(async (p: string) => {
      if (!String(p).includes(CORRECTION_MARKER)) return null;
      const id = String(100 + issued.length);
      issued.push(id);
      return id;
    });
    h.runReplyLint.mockImplementation((i: { text: string }) =>
      i.text === UNQUOTED_REPLY ? blocked(i.text) : clean(i.text),
    );

    render(<ConciergeHost feed={feed()} />);
    await flush();
    await send(FOUNDER_MSG);
    await done({ id: "1", sessionId: "s", text: UNQUOTED_REPLY, toolCalls: [] });
    // The correction turn finishes with a reply the model wrote compliantly.
    const correctionId = issued[0]!;
    expect(correctionId, "a correction turn must have been dispatched").toBeTruthy();
    await done({ id: correctionId, sessionId: "s", text: CORRECTED, toolCalls: [] });

    // The model's own quote stands, and the founder's words appear EXACTLY ONCE — the floor did not
    // prepend a second blockquote line on top of a reply that already quoted.
    const rendered = replyBubbleText();
    expect(rendered).toBe(CORRECTED);
    expect(rendered.match(new RegExp(`> ${FOUNDER_MSG}`, "g")) ?? []).toHaveLength(1);
  });
});
