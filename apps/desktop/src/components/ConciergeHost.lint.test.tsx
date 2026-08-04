// @vitest-environment jsdom
//
// THE LINTER IS ACTUALLY MOUNTED.
//
// `services/conciergeLint/` shipped complete and tested with 150 green assertions and NO CALLER.
// Every one of those tests exercised `lintReply` directly, so the suite proved the checks worked
// while the app ran none of them — a linter that never runs is indistinguishable from no linter, and
// worse, because the green suite reads as a guarantee.
//
// This file is the assertion none of those 150 could make: the reply the human sees went THROUGH the
// linter. It drives the real `concierge:done` handler and asserts on what lands in the thread, so it
// fails if the call at the mount point is removed — which is the exact regression that shipped.
//
// The runner is stubbed on purpose. What is under test here is the WIRE (is it called, with the
// turn's text and tool calls, and is its output what renders), not the checks — those have their own
// suites. Stubbing it to return a recognisably rewritten string is what makes "the output is
// rendered" a real assertion rather than a tautology on an unchanged reply.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  startConciergeTurn: vi.fn(async (_p: string): Promise<string | null> => null),
  routeMessage: vi.fn(async () => ({
    target: "sparkle" as const,
    reason: "test",
    source: "heuristic" as const,
  })),
  runReplyLint: vi.fn(
    (input: {
      text: string;
      turnId: string;
      toolCalls?: { name: string; input: string }[];
      prevReply?: string | null;
      // Typed loosely on purpose: this file asserts the policy REACHED the linter, and narrowing it
      // to `LintPolicy` here would make the accessor test read its own expectation back.
      policy: { enabled: boolean; checks: Record<string, { enabled: boolean; severity: string }> };
    }) => ({ text: input.text, violations: [] as unknown[], blocked: false }),
  ),
  getConfig: vi.fn(async () => ({ config: { concierge: { checks: undefined } } })),
  // HOISTED and restored in beforeEach for the reason the sibling suites record: `vi.resetAllMocks()`
  // strips a mock's IMPLEMENTATION, so an inline `vi.fn(async () => () => {})` here returns
  // `undefined` from the second row onward. The host awaits this to unsubscribe, so an un-restored
  // mock throws in the unmount path and takes `cleanup()` with it — leaving the previous row's
  // component mounted and every later assertion reading a thread that is not the one under test.
  onConfigChanged: vi.fn(async (_cb: (eff: unknown) => void) => () => {}),
  brain: {} as {
    delta?: (e: { id: string; text: string }) => void;
    done?: (e: {
      id: string;
      sessionId: string;
      text: string;
      toolCalls?: { name: string; input: string }[];
    }) => void;
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
    startConciergeTurn: h.startConciergeTurn,
    startProactiveConciergeTurn: vi.fn(async (): Promise<string | null> => null),
    isProactiveTurn: () => false,
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
// The REAL policy mapper — the config→policy half must not be stubbed out of the path it exists to
// serve, or this file would pass with the mapper broken.
vi.mock("../services/conciergeLintRunner", () => ({ runReplyLint: h.runReplyLint }));
vi.mock("../services/config", () => ({
  getConfig: h.getConfig,
  onConfigChanged: h.onConfigChanged,
}));
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
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";
import type { ConciergeFeed } from "../useConciergeFeed";
import type { StatusBand } from "../engine/buildSections";

const COUNTS: Record<StatusBand, number> = { needs_you: 0, running: 1, done: 0 };

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

beforeEach(() => {
  enableAiEnhancementsForTests();
  h.runReplyLint.mockImplementation((input) => ({
    text: input.text,
    violations: [],
    blocked: false,
  }));
  h.getConfig.mockResolvedValue({ config: { concierge: { checks: undefined } } });
  h.onConfigChanged.mockImplementation(async (_cb: (eff: unknown) => void) => () => {});
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  h.startConciergeTurn.mockResolvedValue(null);
  h.routeMessage.mockResolvedValue({ target: "sparkle", reason: "test", source: "heuristic" });
});

async function flush() {
  await act(async () => {
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

/** Drive one complete turn and hand back what the thread shows. */
async function turn(
  done: { id: string; sessionId: string; text: string; toolCalls?: { name: string; input: string }[] },
) {
  render(<ConciergeHost feed={feed()} />);
  await flush();
  await send("what's the fleet doing?");
  await act(async () => {
    h.brain.done?.(done);
  });
  await flush();
}

describe("the concierge reply linter is mounted", () => {
  it("routes the finished reply THROUGH the linter", async () => {
    await turn({ id: "1", sessionId: "s", text: "Rebased and pushed.", toolCalls: [] });
    expect(h.runReplyLint).toHaveBeenCalled();
    expect(h.runReplyLint.mock.calls[0]![0]).toMatchObject({
      text: "Rebased and pushed.",
      turnId: "1",
    });
  });

  it("renders the LINTER'S text, not the model's", async () => {
    // The assertion that fails if the mount is deleted: the call's return value has to be what the
    // human reads, or an autofix would be computed and thrown away.
    h.runReplyLint.mockImplementation(() => ({
      text: "REWRITTEN BY THE LINTER",
      violations: [],
      blocked: false,
    }));
    await turn({ id: "1", sessionId: "s", text: "the model's original words", toolCalls: [] });
    expect(threadText()).toContain("REWRITTEN BY THE LINTER");
    expect(threadText()).not.toContain("the model's original words");
  });

  it("announces the LINTER'S text to the aria-live region, not the model's", async () => {
    // For a screen-reader user the announcement IS the delivery, not the "mid-stream glimpse" the
    // mount's comment accepts — they never see the visual bubble, so if the announcement carried the
    // model's raw words the linter would not exist for them at all.
    //
    // It already carries the linted text, and NOT by accident worth leaving untested: `announce`
    // is fed `brainTextRef.current[e.id]`, and the replace-upsert one line earlier overwrites that
    // ref with exactly what was rendered. So the property holds through a two-step coupling that
    // nothing else states — which is why it is pinned here rather than assumed. Mutating the mount
    // to render `e.text` breaks this row too.
    h.runReplyLint.mockImplementation(() => ({
      text: "REWRITTEN BY THE LINTER",
      violations: [],
      blocked: false,
    }));
    render(<ConciergeHost feed={feed()} />);
    await flush();
    await send("what's the fleet doing?");
    await act(async () => {
      h.brain.delta?.({ id: "1", text: "the model's original words" });
    });
    await act(async () => {
      h.brain.done?.({ id: "1", sessionId: "s", text: "the model's original words", toolCalls: [] });
    });
    await flush();
    const live = screen.getByTestId("concierge-announcer");
    expect(live.textContent).toContain("REWRITTEN BY THE LINTER");
    expect(live.textContent).not.toContain("the model's original words");
  });

  // ══ THE CONFIG → POLICY WIRE ═══════════════════════════════════════════════════════════════════
  // `eff?.config?.concierge?.checks` is a hand-written accessor across the Rust/TS boundary, and it
  // is the single point that decides whether the linter runs AT ALL. Misspell it and `toLintPolicy`
  // receives `undefined`, resolves to DISABLED_POLICY, `lintReply` returns at its master-switch
  // guard — and every other test in this file still passes, because they all resolve `checks` to
  // `undefined` anyway. The linter would be inert again, which is the exact failure this branch
  // exists to end (roborev 56003). These two rows are the ones that would notice.
  const LIVE_CHECKS = {
    enabled: true,
    log: true,
    log_matches: false,
    checks: { "hedge-words": { enabled: true, severity: "warn", autofix: false, words: "should" } },
  };

  it("reads [concierge.checks] out of the config payload and hands it to the linter", async () => {
    h.getConfig.mockResolvedValue({ config: { concierge: { checks: LIVE_CHECKS } } } as never);
    await turn({ id: "1", sessionId: "s", text: "Rebased.", toolCalls: [] });
    const policy = h.runReplyLint.mock.calls[0]![0].policy;
    expect(policy.enabled, "the master switch must survive the accessor").toBe(true);
    expect(policy.checks["hedge-words"]).toMatchObject({ enabled: true, severity: "warn" });
  });

  it("picks up a config-changed payload for the NEXT turn", async () => {
    // The hot-reload half. Editing a severity must take effect without a restart, and nothing else
    // drives the `onConfigChanged` → `apply` path.
    let listener: ((eff: unknown) => void) | undefined;
    h.onConfigChanged.mockImplementation(async (cb: (eff: unknown) => void) => {
      listener = cb;
      return () => {};
    });
    render(<ConciergeHost feed={feed()} />);
    await flush();
    await act(async () => {
      listener?.({ config: { concierge: { checks: LIVE_CHECKS } } });
    });
    await send("what's the fleet doing?");
    await act(async () => {
      h.brain.done?.({ id: "1", sessionId: "s", text: "Rebased.", toolCalls: [] });
    });
    await flush();
    expect(h.runReplyLint.mock.calls.at(-1)![0].policy.checks["hedge-words"]).toBeTruthy();
  });

  it("warns instead of leaking a rejection when the config subscription fails", async () => {
    // Pins the shape that turned all four CI coverage shards red with a fully green suite. The
    // catch-only-in-cleanup version warns NOTHING at this point (its handler has not run), so this
    // assertion distinguishes the two. Worth guarding by name: the failure surfaces as a bare
    // non-zero exit attributable to no test, and App.tsx and approvalsRuntime.ts both still use the
    // unlisten-promise-in-cleanup shape a consistency refactor could drag this back toward.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.onConfigChanged.mockRejectedValue(new Error("no tauri"));
    render(<ConciergeHost feed={feed()} />);
    await flush();
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("config-changed subscribe failed")),
      "the rejection must be handled where it is produced, not in a cleanup that may never run",
    ).toBe(true);
    warn.mockRestore();
  });

  it("warns and still renders the turn when getConfig fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.getConfig.mockRejectedValue(new Error("no tauri"));
    await turn({ id: "1", sessionId: "s", text: "Rebased and pushed.", toolCalls: [] });
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("getConfig failed")),
      "an unreadable config must be reported, not guessed at",
    ).toBe(true);
    // The reply is the product: a config we could not read leaves the linter disabled, never
    // costs the user their turn.
    expect(threadText()).toContain("Rebased and pushed.");
    warn.mockRestore();
  });

  // NOT TESTED, deliberately and with the reason stated: the effect also tolerates `onConfigChanged`
  // returning a NON-PROMISE (an `await undefined` where a promise chain would throw "Cannot read
  // properties of undefined (reading 'then')"). That arm was measured to be UNOBSERVABLE from here —
  // under the promise-chain form the synchronous throw inside the effect produces no thrown render,
  // no `console.error`, and no failing assertion, so a test written for it passes against both
  // shapes. A guard that cannot fail is the vacuous test this repo calls its #1 finding, so there
  // is a note here instead of one. The two rejection rows above ARE observable and do fail against
  // the shape they replaced.

  it("hands the turn's tool calls to the linter", async () => {
    // `ask-without-action` and `relay-paste` decide on the turn's calls, not on the text alone, so a
    // mount that dropped them would leave those checks structurally unable to fire.
    const toolCalls = [{ name: "sparkle_fleet", input: '{"scope":"all"}' }];
    await turn({ id: "3", sessionId: "s", text: "Swept the fleet.", toolCalls });
    expect(h.runReplyLint.mock.calls[0]![0]).toMatchObject({ toolCalls });
  });

  it("gives the linter the PREVIOUS reply, and only after the current one is linted", async () => {
    // `restated-state` compares against the previous reply. Recording it before linting would have
    // each reply compared against ITSELF, which never reports and reads as "the check never fires".
    render(<ConciergeHost feed={feed()} />);
    await flush();
    await send("first");
    await act(async () => {
      h.brain.done?.({ id: "1", sessionId: "s", text: "First answer.", toolCalls: [] });
    });
    await flush();
    expect(h.runReplyLint.mock.calls[0]![0].prevReply ?? null).toBeNull();

    await send("second");
    await act(async () => {
      h.brain.done?.({ id: "2", sessionId: "s", text: "Second answer.", toolCalls: [] });
    });
    await flush();
    const second = h.runReplyLint.mock.calls.at(-1)![0];
    expect(second.text).toBe("Second answer.");
    expect(second.prevReply).toBe("First answer.");
  });

  it("renders the reply unlinted rather than losing it when the linter returns nothing usable", async () => {
    // Belt to `runReplyLint`'s own braces. The reply is the product; the linter is never allowed to
    // cost the user one.
    h.runReplyLint.mockImplementation(() => undefined as never);
    await turn({ id: "1", sessionId: "s", text: "Still has to be readable.", toolCalls: [] });
    expect(threadText()).toContain("Still has to be readable.");
  });
});
