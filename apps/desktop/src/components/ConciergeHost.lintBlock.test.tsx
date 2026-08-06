// @vitest-environment jsdom
//
// THE BLOCK PATH — A `severity = "block"` FINDING RE-PROMPTS THE CONCIERGE, ONCE (bead sparkle-ugohl).
//
// ══ THE GAP THIS CLOSES ═════════════════════════════════════════════════════════════════════════
// `lintReply` computed `LintResult.blocked` and NO caller read it. `ConciergeHost` consumed `.text`
// and `.violations` and dropped the flag, so every `severity = "block"` in the shipped config was
// inert: `config.rs` documented `ask-without-action` as "re-prompts the concierge once for a
// corrected reply" while nothing re-prompted, and `conciergeLintRegistry.test.ts` pinned the gap
// open with a test that refused to let any check ship at `"block"`.
//
// ══ WHAT EVERY ROW HERE ASSERTS, AND WHY IT IS NOT VACUOUS ══════════════════════════════════════
// AGENTS.md names the vacuous test as this repo's #1 fleet-wide finding: an assertion that was
// already true before the change. Every row below asserts a SIDE EFFECT that did not exist at all
// until this branch — a second `startConciergeTurn` call, a rendered correction replacing a reply,
// an action stamped through `reportLintOutcome` — and each fails against the old mount, where the
// violating reply simply rendered and exactly one turn was ever dispatched per question.
//
// The runner is stubbed for the same reason the sibling lint suites stub it: what is under test is
// the MOUNT's block path, not the checks. `buildLintCorrectionPrompt` and `toLintToolCalls` are
// deliberately REAL (via `importOriginal`), so the prompt this file asserts on is the prompt the app
// would actually send.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { LintAction } from "../stores/conciergeLintMetrics";
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
// `buildLintCorrectionPrompt` and `toLintToolCalls` stay REAL. The prompt is a deliverable of this
// change — "the correction names WHICH checks fired and what the compliant form is" — so a stub
// would let this file assert its own fixture back and pass with the prompt builder deleted.
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
import { LINT_MARK_TESTID } from "./Concierge/LintMark";
import { HELD_REPLY_TESTID } from "./Concierge/ConciergeMessageRow";
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

/** The reply that fires the headline blocking check, and the reply a correction should produce. */
const OFFER = "Say go and I'll spawn the worker.";
const CORRECTED = "Spawned the worker on the CI branch.";

function violation(check: string, severity: "block" | "warn" = "block"): Violation {
  return { check, severity, action: "warned", span: 12, detail: "offered to act" };
}

function blocked(text: string, checks = ["ask-without-action"]): LintResult {
  return { text, violations: checks.map((c) => violation(c)), blocked: true };
}

function clean(text: string): LintResult {
  return { text, violations: [], blocked: false };
}

/** The id of each CORRECTION turn, in order. Keyed off the prompt rather than off call position:
 *  a user send and a correction both go through `startConciergeTurn`, and an earlier version of this
 *  fixture handed a later row the user's dispatch token by counting calls — which made the retry
 *  ceiling assertion pass for the wrong reason (removing the ledger guard did not break it). */
let issued: string[] = [];

/** The correction prompt's own heading, and the only reliable way to tell the two dispatch kinds
 *  apart from outside the host. */
const CORRECTION_MARKER = "What has to change:";

beforeEach(() => {
  useConciergeThreadStore.setState({ chat: [] });
  enableAiEnhancementsForTests();
  issued = [];
  // The USER's turn resolves null, exactly as the sibling suites' mock does — the host only uses a
  // returned id to lower `retireThroughRef`. A CORRECTION's id is load-bearing (it is how its
  // events are recognised), so it gets a real token, numbered well above any turn id these rows
  // drive so the supersede arithmetic behaves as it would in the app.
  h.startConciergeTurn.mockImplementation(async (p: string) => {
    if (!String(p).includes(CORRECTION_MARKER)) return null;
    const id = String(100 + issued.length);
    issued.push(id);
    return id;
  });
  h.runReplyLint.mockImplementation((input: { text: string }) => clean(input.text));
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

function threadText(): string {
  return screen.getByTestId("concierge-thread").textContent ?? "";
}

async function done(e: DoneEvent) {
  await act(async () => {
    h.brain.done?.(e);
  });
  await flush();
}

/** Mount, send one question, and let turn `1` finish. Returns the correction turn's id, or null
 *  when no correction was dispatched. */
async function askAndAnswer(text: string, toolCalls: { name: string; input: string }[] = []) {
  render(<ConciergeHost feed={feed()} />);
  await flush();
  await send("what's the fleet doing?");
  await done({ id: "1", sessionId: "s", text, toolCalls });
  return issued[0] ?? null;
}

/** Every prompt handed to `startConciergeTurn` that is a linter correction. Keyed on the builder's
 *  own heading rather than on call order, so it stays true if dispatch ever changes shape. */
function correctionPrompts(): string[] {
  return h.startConciergeTurn.mock.calls
    .map((c) => String(c[0] ?? ""))
    .filter((p) => p.includes(CORRECTION_MARKER));
}

/** The actions `reportLintOutcome` was asked to stamp, in order. This IS the side effect that
 *  requirement 6 is about — the checks hardcode `"warned"` and only the mount may upgrade it. */
function stampedActions(): LintAction[] {
  return h.reportLintOutcome.mock.calls.map((c) => (c[0] as { action: LintAction }).action);
}

describe("the linter's block path — a blocked reply is re-prompted, once", () => {
  it("HOLDS a blocked reply instead of rendering it, and dispatches a correction turn", async () => {
    // The assertion the old mount fails on both halves: it rendered `OFFER` immediately and never
    // dispatched a second turn for anything.
    h.runReplyLint.mockImplementation((i: { text: string }) => blocked(i.text));
    const correctionId = await askAndAnswer(OFFER);

    expect(threadText(), "the violating reply must not reach the thread").not.toContain(OFFER);
    expect(correctionId, "a correction turn must have been dispatched").toBeTruthy();
    expect(correctionPrompts()).toHaveLength(1);
  });

  it("names WHICH check fired and the compliant form, and carries no reply prose", async () => {
    // The prompt is metadata-only by the same standing decision that makes `Violation.span` a
    // character count: no part of the reply may travel with the finding.
    h.runReplyLint.mockImplementation((i: { text: string }) => blocked(i.text, ["ask-without-action", "hedge-words"]));
    await askAndAnswer(OFFER);

    const prompt = correctionPrompts()[0]!;
    expect(prompt, "the blocking check's compliant form").toContain("do not ask permission for something you can just do");
    expect(prompt, "the second check that fired").toContain("You hedged");
    expect(prompt, "the reply's own words must not travel with the finding").not.toContain(OFFER);
    expect(prompt).not.toContain("offered to act");
  });

  it("renders the CORRECTED reply and stamps the held violations \"revised\"", async () => {
    h.runReplyLint.mockImplementation((i: { text: string }) =>
      i.text === OFFER ? blocked(i.text) : clean(i.text),
    );
    const correctionId = await askAndAnswer(OFFER);
    await done({ id: correctionId!, sessionId: "s", text: CORRECTED, toolCalls: [] });

    expect(threadText()).toContain(CORRECTED);
    expect(threadText()).not.toContain(OFFER);
    // A clean correction leaves nothing to mark.
    expect(screen.queryByTestId(LINT_MARK_TESTID)).toBeNull();
    // THE UPGRADE. Every check hardcodes `"warned"`; only a component that actually performed a
    // revision may claim one, and this is the call that claims it.
    expect(stampedActions()).toEqual(["revised"]);
    expect(h.reportLintOutcome.mock.calls[0]![0]).toMatchObject({
      turnId: "1",
      violations: [expect.objectContaining({ check: "ask-without-action" })],
    });
  });

  it("renders a retry that is ALSO blocked, MARKED and stamped \"rendered_marked\" — and stops", async () => {
    const RETRY = "I could spawn it if you want.";
    h.runReplyLint.mockImplementation((i: { text: string }) => blocked(i.text));
    const correctionId = await askAndAnswer(OFFER);
    await done({ id: correctionId!, sessionId: "s", text: RETRY, toolCalls: [] });

    expect(threadText(), "the retry is what the user sees").toContain(RETRY);
    expect(threadText()).not.toContain(OFFER);
    expect(screen.getByTestId(LINT_MARK_TESTID).textContent).toContain("Said it would do it");
    // NO THIRD TURN. An unbounded re-prompt loop is the worst failure this change could ship.
    expect(correctionPrompts(), "exactly one correction, ever").toHaveLength(1);
    // The held reply WAS replaced, so it is honestly `revised`; the retry itself was rendered marked.
    expect(stampedActions()).toEqual(["revised", "rendered_marked"]);
    expect(h.reportLintOutcome.mock.calls.at(-1)![0]).toMatchObject({ turnId: correctionId! });
  });

  it("renders the HELD ORIGINAL, marked, when the correction turn ERRORS", async () => {
    // The never-lose-a-reply guarantee. `services/conciergeLint`'s header: "a linter that can
    // destroy one is worse than no linter."
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.runReplyLint.mockImplementation((i: { text: string }) => blocked(i.text));
    const correctionId = await askAndAnswer(OFFER);
    await act(async () => {
      h.brain.error?.({ id: correctionId!, detail: "boom" });
    });
    await flush();

    expect(threadText(), "the reply the user waited for is never lost").toContain(OFFER);
    expect(screen.getByTestId(LINT_MARK_TESTID)).toBeTruthy();
    expect(stampedActions()).toEqual(["rendered_marked"]);
    // A correction's failure is plumbing, not an answer the user did not get: no failure bubble.
    expect(threadText()).not.toContain("boom");
    warn.mockRestore();
  });

  it("renders the HELD ORIGINAL when the correction turn never produces a terminal event", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    h.runReplyLint.mockImplementation((i: { text: string }) => blocked(i.text));
    render(<ConciergeHost feed={feed()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "what's the fleet doing?" } });
    fireEvent.click(screen.getByText("Send"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      h.brain.done?.({ id: "1", sessionId: "s", text: OFFER, toolCalls: [] });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(threadText(), "held while the correction could still arrive").not.toContain(OFFER);

    // The backstop, and the ONLY thing that renders this reply.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(threadText()).toContain(OFFER);
    expect(stampedActions()).toEqual(["rendered_marked"]);
    warn.mockRestore();
  });

  it("renders the HELD ORIGINAL when the concierge's turns are abandoned", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.runReplyLint.mockImplementation((i: { text: string }) => blocked(i.text));
    await askAndAnswer(OFFER);
    // THE PRECONDITION, ASSERTED. Without it this row passes against a mount that never holds at
    // all — the reply would already be in the thread and `reset` would change nothing.
    expect(threadText(), "held before the abandon").not.toContain(OFFER);
    expect(correctionPrompts()).toHaveLength(1);
    await act(async () => {
      h.brain.reset?.({});
    });
    await flush();

    expect(threadText()).toContain(OFFER);
    expect(stampedActions()).toEqual(["rendered_marked"]);
    warn.mockRestore();
  });

  it("renders the HELD ORIGINAL immediately when the user sends again", async () => {
    // `concierge.rs` kills the evicted child, so the correction is about to die with no terminal
    // event. Waiting out the backstop would leave the answer missing for a minute and a half.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.runReplyLint.mockImplementation((i: { text: string }) => blocked(i.text));
    await askAndAnswer(OFFER);
    expect(threadText()).not.toContain(OFFER);

    await send("actually, never mind");
    expect(threadText()).toContain(OFFER);
    expect(stampedActions()).toEqual(["rendered_marked"]);
    warn.mockRestore();
  });

  it("BLANKS the held row in place — the row survives, carrying a placeholder", async () => {
    // ══ THIS IS THE GUARD ON blank-in-place vs splice (roborev 58971, High) ════════════════════
    // Taking the bubble off screen by SPLICING it out meant `upsert` could not find it on settle,
    // and its not-found branch APPENDS — so the held reply could come back at the BOTTOM of the
    // thread, below anything that landed during the up-to-90s hold, where an answer reads as the
    // reply to a later question. Blanking in place keeps the index, so settle finds the row.
    //
    // MEASURED, NOT ASSUMED: roborev's concrete scenario was "the user sends again", and that one
    // does NOT reproduce — `settleHold` runs before the new `you` bubble is painted, so the order
    // comes out right even when splicing. A first version of this suite asserted the ordering
    // through that path and PASSED against the spliced code, i.e. it was vacuous; it was deleted
    // rather than shipped. The mechanism is still worth guarding — `postSparkle` receipts, ledger
    // nags and feed notices can all land mid-hold — so the assertion is on the mechanism that
    // actually differs: under splice there is no row at all, so no placeholder, and this fails.
    //
    // The row also has to SAY something: an empty bubble reads as a turn that produced nothing,
    // which is the one thing the block path must never look like. And it must NOT echo the finding —
    // the violating sentence is precisely what must not be on screen.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.runReplyLint.mockImplementation((i: { text: string }) => blocked(i.text));
    render(<ConciergeHost feed={feed()} />);
    await flush();
    await send("what's the fleet doing?");
    // THE PRECONDITION, and it is the whole point: the placeholder replaces a row that EXISTS.
    // A turn whose deltas never painted has no bubble to blank, and correctly gets no placeholder —
    // `askAndAnswer` drives `done` alone, which is why this row streams first.
    await act(async () => {
      h.brain.delta?.({ id: "1", text: OFFER });
    });
    await flush();
    await done({ id: "1", sessionId: "s", text: OFFER, toolCalls: [] });
    expect(screen.getByTestId(HELD_REPLY_TESTID)).toBeTruthy();
    expect(threadText()).not.toContain(OFFER);

    // …and the placeholder is GONE once the winning text lands, rather than outliving the rewrite.
    await act(async () => {
      h.brain.error?.({ id: issued[0]!, detail: "boom" });
    });
    await flush();
    expect(screen.queryByTestId(HELD_REPLY_TESTID)).toBeNull();
    expect(threadText()).toContain(OFFER);
    warn.mockRestore();
  });

  it("SILENCES a correction id that resolves after its hold already settled", async () => {
    // ══ THE NULL WINDOW (roborev 58971, Medium) ════════════════════════════════════════════════
    // `correctionTurnId` is null between dispatching and the invoke resolving, and give-up can only
    // silence an id it has. A hold that settles inside that window — the backstop firing on a slow
    // invoke is the ordinary way — used to DISCARD the late id, leaving the correction turn
    // unrecognised by `isCorrectionTurn` (ref cleared), absent from the silenced set, and not
    // superseded (it is the newest id the stream has seen). Its `done` then rendered a SECOND answer
    // to a prompt the user never sent.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.runReplyLint.mockImplementation((i: { text: string }) => blocked(i.text));
    // Hold the dispatch open so the hold can settle before the id is ever assigned.
    let releaseId: (id: string) => void = () => {};
    h.startConciergeTurn.mockImplementationOnce(() => Promise.resolve("1")).mockImplementationOnce(
      () => new Promise<string>((res) => (releaseId = res)),
    );
    render(<ConciergeHost feed={feed()} />);
    await flush();
    await send("what's the fleet doing?");
    await done({ id: "1", sessionId: "s", text: OFFER, toolCalls: [] });

    // The hold gives up while the correction's id is still unknown.
    await send("never mind");
    expect(threadText(), "the original is rendered").toContain(OFFER);
    const before = threadText();

    // NOW the id lands, and the abandoned correction reports a full reply.
    await act(async () => {
      releaseId("99");
    });
    await flush();
    await done({ id: "99", sessionId: "s", text: "a second answer nobody asked for", toolCalls: [] });
    expect(
      threadText(),
      "an abandoned correction must not render an answer to a prompt the user never sent",
    ).not.toContain("a second answer nobody asked for");
    expect(threadText()).toEqual(before);
    warn.mockRestore();
  });

  it("does NOT hold when a user message is already queued behind the turn", async () => {
    // The drain at the end of this handler dispatches that queued turn, and the backend kills the
    // correction child — a paid turn spent to reach the same rendered original.
    h.runReplyLint.mockImplementation((i: { text: string }) => blocked(i.text));
    render(<ConciergeHost feed={feed()} />);
    await flush();
    await send("first question");
    await send("second question while the first is running");
    await done({ id: "1", sessionId: "s", text: OFFER, toolCalls: [] });

    expect(correctionPrompts(), "no correction while someone is waiting").toHaveLength(0);
    expect(threadText(), "the blocked reply renders rather than being held").toContain(OFFER);
    expect(screen.getByTestId(LINT_MARK_TESTID)).toBeTruthy();
    // Still counted — a deferred violation that nothing reports is worse than a miscounted one.
    expect(stampedActions()).toEqual(["rendered_marked"]);
  });

  it("the retry ceiling holds across several blocked replies: ONE correction per original", async () => {
    // The loop guard, exercised rather than asserted structurally. Two questions, every reply and
    // every correction blocked: four terminal events, and exactly two corrections.
    h.runReplyLint.mockImplementation((i: { text: string }) => blocked(i.text));
    render(<ConciergeHost feed={feed()} />);
    await flush();

    await send("first");
    await done({ id: "1", sessionId: "s", text: `${OFFER} (one)`, toolCalls: [] });
    const first = issued[0]!;
    await done({ id: first, sessionId: "s", text: `${OFFER} (one-retry)`, toolCalls: [] });

    await send("second");
    await done({ id: "10", sessionId: "s", text: `${OFFER} (two)`, toolCalls: [] });
    const second = issued[1]!;
    await done({ id: second, sessionId: "s", text: `${OFFER} (two-retry)`, toolCalls: [] });

    expect(correctionPrompts(), "one correction per original, never two").toHaveLength(2);
    // And a re-delivered `done` for an original that already spent its retry starts nothing.
    await done({ id: "10", sessionId: "s", text: `${OFFER} (two)`, toolCalls: [] });
    expect(correctionPrompts()).toHaveLength(2);
  });

  it("renders the held original when the correction turn fails to START", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.runReplyLint.mockImplementation((i: { text: string }) => blocked(i.text));
    h.startConciergeTurn.mockImplementation(async (p: string) => {
      if (!String(p).includes(CORRECTION_MARKER)) return null;
      throw new Error("AI enhancements are off");
    });
    render(<ConciergeHost feed={feed()} />);
    await flush();
    await send("what's the fleet doing?");
    await done({ id: "1", sessionId: "s", text: OFFER, toolCalls: [] });

    // A correction WAS attempted — without this the row passes against a mount that never tries,
    // where the reply renders for the ordinary reason and nothing was ever held.
    expect(correctionPrompts()).toHaveLength(1);
    expect(threadText()).toContain(OFFER);
    expect(screen.getByTestId(LINT_MARK_TESTID)).toBeTruthy();
    expect(stampedActions()).toEqual(["rendered_marked"]);
    warn.mockRestore();
  });

  it("renders the held original when the correction comes back EMPTY", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.runReplyLint.mockImplementation((i: { text: string }) => blocked(i.text));
    const correctionId = await askAndAnswer(OFFER);
    expect(threadText(), "held before the empty correction lands").not.toContain(OFFER);
    expect(correctionId).toBeTruthy();
    await done({ id: correctionId!, sessionId: "s", text: "", toolCalls: [] });

    expect(threadText(), "an empty bubble is not a correction").toContain(OFFER);
    expect(stampedActions()).toEqual(["rendered_marked"]);
    warn.mockRestore();
  });

  it("leaves a NON-blocked reply byte-identical, with no extra turn and no outcome report", async () => {
    // The positive control. Without it every row above passes against a host that holds and
    // re-prompts EVERY reply, which would double the cost of the concierge.
    await askAndAnswer("Rebased and pushed.");
    expect(threadText()).toContain("Rebased and pushed.");
    expect(correctionPrompts()).toHaveLength(0);
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
    expect(h.reportLintOutcome, "a clean reply reports nothing through the block path").not.toHaveBeenCalled();
    expect(screen.queryByTestId(LINT_MARK_TESTID)).toBeNull();
  });

  it("takes the ALREADY-PAINTED reply OFF SCREEN while it is held", async () => {
    // ══ THE ROW THE OTHER FOURTEEN COULD NOT SEE (roborev 58805) ═══════════════════════════════
    // Deltas paint live into the same bubble the `done` handler replaces, so in the real app a
    // reply is FULLY RENDERED by the time it is judged blocked. Declining to re-render is therefore
    // not the same as not rendering, and a hold that only declines leaves the violating text up for
    // the whole correction turn — up to the 90s backstop — which is exactly what `"block"` exists
    // to prevent: the founder reads "Say go and I'll spawn the worker", answers `go`, and acts on a
    // sentence the linter is in the middle of rejecting.
    //
    // Every other row drives `done` alone, so `not.toContain(OFFER)` passes there on a thread that
    // was never painted. This one paints it first, which is what makes the assertion mean anything.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.runReplyLint.mockImplementation((i: { text: string }) => blocked(i.text));
    render(<ConciergeHost feed={feed()} />);
    await flush();
    await send("what's the fleet doing?");
    await act(async () => {
      h.brain.delta?.({ id: "1", text: OFFER });
    });
    await flush();
    expect(threadText(), "the precondition: the reply really was on screen").toContain(OFFER);

    await done({ id: "1", sessionId: "s", text: OFFER, toolCalls: [] });
    expect(threadText(), "and the hold takes it back off").not.toContain(OFFER);

    // …and it is not lost: the give-up path puts it back, marked.
    await act(async () => {
      h.brain.error?.({ id: issued[0]!, detail: "boom" });
    });
    await flush();
    expect(threadText()).toContain(OFFER);
    expect(screen.getByTestId(LINT_MARK_TESTID)).toBeTruthy();
    warn.mockRestore();
  });

  it("SILENCES a correction turn its hold already gave up on", async () => {
    // `isCorrectionTurn` reads `lintHoldRef`, and giving up clears it — so from that moment the
    // still-alive correction stops being recognised and falls through to the ordinary path.
    // `supersededTurn` cannot save it either: it is the newest id the stream has seen. Unsilenced,
    // its deltas paint a new bubble and its `done` renders a SECOND answer, to a prompt the user
    // never sent, under the reply that replaced it (roborev 58805).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.runReplyLint.mockImplementation((i: { text: string }) => blocked(i.text));
    const correctionId = await askAndAnswer(OFFER);
    await act(async () => {
      h.brain.reset?.({});
    });
    await flush();
    expect(threadText(), "the give-up rendered the held original").toContain(OFFER);

    const LATE = "a corrected reply that arrived far too late";
    await act(async () => {
      h.brain.delta?.({ id: correctionId!, text: LATE });
    });
    await flush();
    await done({ id: correctionId!, sessionId: "s", text: LATE, toolCalls: [] });

    expect(threadText(), "the abandoned correction reaches nothing").not.toContain(LATE);
    expect(screen.getAllByTestId(LINT_MARK_TESTID), "still exactly one reply").toHaveLength(1);
    warn.mockRestore();
  });

  it("a STALE hold's rejected dispatch does not tear down the next hold", async () => {
    // `giveUpOnCorrection` reads the LIVE ref, so an unscoped continuation settles whichever hold
    // is current now. Hold A's dispatch rejects long after A was settled by a new send; without the
    // identity check it renders hold B's original and strands B's correction — B's one retry spent
    // on A's failure (roborev 58805).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.runReplyLint.mockImplementation((i: { text: string }) => blocked(i.text));
    let rejectA: ((e: Error) => void) | undefined;
    h.startConciergeTurn.mockImplementation(async (p: string) => {
      if (!String(p).includes(CORRECTION_MARKER)) return null;
      const id = String(100 + issued.length);
      issued.push(id);
      // A's dispatch never settles until this row says so; B's resolves normally.
      if (issued.length === 1) return new Promise<string>((_ok, no) => { rejectA = no; });
      return id;
    });

    render(<ConciergeHost feed={feed()} />);
    await flush();
    await send("first");
    await done({ id: "1", sessionId: "s", text: `${OFFER} (A)`, toolCalls: [] });
    // A new send settles hold A. B is then held by the next blocked reply.
    await send("second");
    await done({ id: "10", sessionId: "s", text: `${OFFER} (B)`, toolCalls: [] });
    expect(correctionPrompts(), "A and B each dispatched one").toHaveLength(2);
    expect(threadText(), "B is held").not.toContain(`${OFFER} (B)`);

    rejectA?.(new Error("A's dispatch finally rejected"));
    await flush();
    expect(threadText(), "A's stale rejection must not settle B").not.toContain(`${OFFER} (B)`);

    // And B's own correction still lands, which is the thing the stale give-up would have stranded.
    await done({ id: issued[1]!, sessionId: "s", text: CORRECTED, toolCalls: [] });
    expect(threadText()).toContain(CORRECTED);
    warn.mockRestore();
  });

  it("a correction turn's deltas paint NO bubble of their own", async () => {
    // A second bubble growing under the reply it is replacing, for a turn the user never sent, is
    // worse than the brief glimpse of an unlinted reply the mount already accepts.
    h.runReplyLint.mockImplementation((i: { text: string }) =>
      i.text.includes("spawn") ? blocked(i.text) : clean(i.text),
    );
    const correctionId = await askAndAnswer(OFFER);
    await act(async () => {
      h.brain.delta?.({ id: correctionId!, text: "half a corrected " });
    });
    await flush();
    expect(threadText()).not.toContain("half a corrected");

    // …and that accumulated text is still what renders when `done` carries none of its own.
    await done({ id: correctionId!, sessionId: "s", text: "", toolCalls: [] });
    expect(threadText()).toContain("half a corrected");
  });
});
