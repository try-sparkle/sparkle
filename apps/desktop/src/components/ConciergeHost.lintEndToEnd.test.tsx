// @vitest-environment jsdom
//
// END TO END, WITH NOTHING IN THE LINTER PATH STUBBED.
//
// `ConciergeHost.lint.test.tsx` mocks `services/conciergeLintRunner`, which is right for what that
// file tests (the WIRE: is the linter called, with what, and is its output rendered) and wrong for
// the question that actually matters here: does a passive reply arriving on the real event path
// produce a real violation?
//
// Every layer between the config and the counter is live in this file — `toLintPolicy`,
// `runReplyLint`, `lintReply`, the check registry, `askWithoutAction`, and the metrics store. The
// ONLY things stubbed are the process boundary (`@tauri-apps/api/core`'s `invoke`, so the JSONL sink
// can be observed instead of writing to disk) and `services/config` (so the policy is a fixture
// rather than the developer's own config.toml). If any link in that chain is broken — a misspelled
// accessor, a policy row that never reaches the check, a check id the counter has no column for —
// these rows fail, and they are the only rows in the suite that would.
//
// `ask-without-action` is the check under test because it is the one the founder named: the reply
// that reports accurately and then asks permission instead of acting. It is also the only check
// whose verdict depends on the TURN and not just the text, so proving it end to end proves the
// tool-call plumbing that no text-only check would exercise.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  startConciergeTurn: vi.fn(async (_p: string): Promise<string | null> => null),
  routeMessage: vi.fn(async () => ({
    target: "sparkle" as const,
    reason: "test",
    source: "heuristic" as const,
  })),
  /** Every `invoke` the app makes. The lint log is picked out of it by command name. */
  invoked: [] as { cmd: string; args: unknown }[],
  /** HOISTED so `beforeEach` can restore it: `vi.resetAllMocks()` strips the implementation, and an
   *  `invoke` that returns `undefined` makes the runner's `.catch` throw — which it then swallows,
   *  so the log assertions would silently see nothing from the second row onward. */
  invoke: vi.fn(async (_cmd: string, _args: unknown): Promise<unknown> => undefined),
  getConfig: vi.fn(async () => ({ config: { concierge: { checks: undefined } } }) as unknown),
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

// The process boundary, and the ONLY reason it is here: `concierge_lint_log` would otherwise reject
// (no Tauri) and the runner would swallow it, leaving the disk half of the feature unobservable.
// Capturing it turns "a record was written" into an assertion.
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
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
    // The LIVE tool channel. A no-op unsubscribe, exactly like its siblings: these suites are about
    // the host's other wiring, and a mock that simply OMITS an export the host calls does not
    // degrade — vitest throws on the missing property and every case in the file dies at mount.
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
// NOTE what is NOT mocked: services/conciergeLintRunner, services/conciergeLintPolicy, and
// services/conciergeLint/*. That is the entire point of this file.
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
import { useConciergeLintMetrics } from "../stores/conciergeLintMetrics";
import { LINT_LOG_COMMAND } from "../services/conciergeLintRunner";
import type { ConciergeFeed } from "../useConciergeFeed";
import type { StatusBand } from "../engine/buildSections";

/** The SHIPPED shape of `[concierge.checks]`, as Rust serializes it — snake_case `log_matches` and
 *  all. Written out rather than imported from the Rust defaults so a change to those defaults does
 *  not silently change what this file proves. */
const CHECKS_PAYLOAD = {
  enabled: true,
  log: true,
  log_matches: false,
  checks: {
    "ask-without-action": { enabled: true, severity: "warn", autofix: false },
  },
};

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
      {
        id: "p1",
        name: "sparkle",
        inScope: true,
        counts: COUNTS,
        scopedCounts: COUNTS,
        agents: [agent],
      },
    ],
    counts: COUNTS,
    scopedCounts: COUNTS,
    pinnedProjectId: null,
  } as unknown as ConciergeFeed;
}

beforeEach(() => {
  enableAiEnhancementsForTests();
  h.invoked = [];
  h.invoke.mockImplementation(async (cmd: string, args: unknown) => {
    h.invoked.push({ cmd, args });
    return undefined;
  });
  useConciergeLintMetrics.getState().reset();
  h.getConfig.mockResolvedValue({ config: { concierge: { checks: CHECKS_PAYLOAD } } });
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

/** What the user types when a case does not care what was asked. */
const ASKED = "what's the fleet doing?";

/** Drive one whole turn through the real event path. */
async function turn(
  text: string,
  toolCalls: { name: string; input: string }[],
  userText: string = ASKED,
) {
  render(<ConciergeHost feed={feed()} />);
  await flush();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: userText } });
  fireEvent.click(screen.getByText("Send"));
  await flush();
  await act(async () => {
    h.brain.done?.({ id: "1", sessionId: "s", text, toolCalls });
  });
  await flush();
}

/** The lint-log records this turn produced, newest last. */
function loggedViolations(): Record<string, unknown>[] {
  return h.invoked
    .filter((c) => c.cmd === LINT_LOG_COMMAND)
    .map((c) => (c.args as { violation: Record<string, unknown> }).violation);
}

describe("ask-without-action, end to end through the real mount", () => {
  it("COUNTS a violation when the reply offers to act and the turn acted on nothing", async () => {
    // The founder's exact complaint, driven through every real layer: report accurately, then ask
    // permission instead of acting. No tool call at all this turn.
    await turn("The branch is 92 commits behind. Want me to rebase it?", []);

    const { checks, actions } = useConciergeLintMetrics.getState();
    expect(
      checks["ask-without-action"],
      "a passive reply must reach the counter through config → policy → mount → check",
    ).toBeGreaterThan(0);
    expect(actions.warned).toBeGreaterThan(0);
  });

  it("WRITES that violation to the lint log, metadata only", async () => {
    await turn("The branch is 92 commits behind. Want me to rebase it?", []);

    const logged = loggedViolations();
    expect(logged.length).toBeGreaterThan(0);
    const v = logged.find((l) => l.check === "ask-without-action");
    expect(v, "the violation must reach the durable sink, not just the session counter").toBeTruthy();
    expect(v).toMatchObject({ check: "ask-without-action", severity: "warn", turn: "1" });
    // The privacy claim, asserted on the real payload rather than on a hand-built one: the record
    // carries a character COUNT and never the words.
    expect(JSON.stringify(v)).not.toContain("rebase");
    expect(JSON.stringify(v)).not.toContain("Want me to");
  });

  // ══ THE `tookAction` HALF, WHICH IS THE REASON THIS CHECK WAS PICKED ══════════════════════════
  // These three rows share ONE offer — "Want me to merge #864 too?" — and differ only in the turn.
  // That is deliberate, and the first draft got it wrong in a way worth recording: it used "Want me
  // to open the PR too?", and `open_agent_pr` is `outward-facing`, i.e. in EXEMPT_RISK_CLASSES. The
  // check declined for the exemption, not for the tool call, so the row would have passed identically
  // with `toolCalls: []` — it could not fail for the reason it claimed (roborev 56079).
  //
  // `merge_pr` is `mutates-main`, which is deliberately NOT exempt ("Merging is NOT exempt" in the
  // shipped config), so the ONLY thing that can silence this offer is the action. Holding the text
  // fixed across all three makes the tool call provably load-bearing.
  //
  // THE TOOL CALLS BELOW USE THE REAL WIRE SHAPE, and that is the whole point of doing this end to
  // end (roborev 56084). `ConciergeToolCall.name` comes verbatim from Claude Code's `tool_use`
  // blocks, so it is `mcp__sparkle-control__sparkle_<domain>` with the operation in `input.op` —
  // never the bare catalog op id. An earlier draft of these rows passed `merge_pr` directly, which
  // no runtime ever emits: it proved the classification worked on input the production path cannot
  // produce, while every real call missed the lookup and fell through to acting-by-default. That is
  // what `catalogNameFor` now normalizes, and these rows are what would catch its removal.
  const MERGE_OFFER = "Rebased it onto main. Want me to merge #864 too?";

  it("FIRES on that offer when the turn did nothing", async () => {
    await turn(MERGE_OFFER, []);
    expect(
      useConciergeLintMetrics.getState().checks["ask-without-action"],
      "a non-exempt offer with no action is the failure this check exists for",
    ).toBeGreaterThan(0);
  });

  it("stays SILENT on the SAME offer when the turn made a state-changing call", async () => {
    // `merge_pr` is a REAL name in the tool catalog. The first draft used `sparkle_lifecycle`, which
    // is not, so it resolved no risk class and reached `isActing`'s unrecognized-counts-as-acting
    // fallback — exercising the fallback while claiming to exercise the classification.
    await turn(MERGE_OFFER, [
      { name: "mcp__sparkle-control__sparkle_workflow", input: '{"op":"merge_pr","number":864}' },
    ]);
    expect(
      useConciergeLintMetrics.getState().checks["ask-without-action"],
      "a turn that DID something must not be flagged for offering the next step",
    ).toBe(0);
    expect(loggedViolations()).toEqual([]);
  });

  it("still FIRES when the turn's only call was READ-ONLY", async () => {
    // The half the unrecognized fallback can never cover: a classified, non-acting tool. Reading a
    // branch's status is not acting on it, so the offer is still the failure. This row is the one
    // that proves the catalog lookup happens at all — with an empty RISK_BY_TOOL every tool would
    // read as acting and this would go silent.
    await turn(MERGE_OFFER, [
      {
        name: "mcp__sparkle-control__sparkle_workflow",
        input: '{"op":"agent_branch_status","agentId":"ag1"}',
      },
    ]);
    expect(
      useConciergeLintMetrics.getState().checks["ask-without-action"],
      "read-only is not action — the offer still went unacted on",
    ).toBeGreaterThan(0);
  });

  it("FIRES after a PREVIEW op — the flow the tool itself prescribes", async () => {
    // The canonical investigate-then-ask turn, and the one that would silence the check through a
    // second door (roborev 56093). `preview_close` is classified `routine` — the APPROVAL
    // vocabulary's "may proceed unasked" — but it changes nothing, and the shipped
    // `sparkle_lifecycle` description tells the concierge to use it BEFORE `close_agent`. Reading
    // `routine` as "acted" would score this turn as having acted and return at the guard.
    await turn("The worktree is clean and the branch is landed. Want me to close it?", [
      {
        name: "mcp__sparkle-control__sparkle_lifecycle",
        input: '{"op":"preview_close","agentId":"ag1"}',
      },
    ]);
    expect(
      useConciergeLintMetrics.getState().checks["ask-without-action"],
      "previewing is investigating, not acting — the offer still went unacted on",
    ).toBeGreaterThan(0);
  });

  it("stays SILENT on a genuinely EXEMPT question, even with no action", async () => {
    // The other direction of the exemption, and the one whose failure is a false positive on a
    // BLOCKING check — the costly error this module's header names. Publishing a release is
    // `outward-facing`, so asking first is correct and the check must stand down even though the
    // turn did nothing. Without a row here, drift in EXEMPT_RISK_CLASSES or in the catalog's
    // classification of `ship_agent` would leave every other row in this file green (roborev 56084).
    await turn("The tag is ready and CI is green. Want me to publish the release?", []);
    expect(
      useConciergeLintMetrics.getState().checks["ask-without-action"],
      "asking before an irreversible, outward-facing action is legitimate",
    ).toBe(0);
  });

  it("does not fire on an actionless reply that offers nothing", async () => {
    // `toolCalls: []` ON PURPOSE. Passing a tool call here would short-circuit `tookAction` before
    // any text was examined, so a check that flagged EVERY actionless reply would still pass — and
    // nothing else in this file covers the no-offer text path.
    await turn("Rebased and pushed. CI is green.", []);
    expect(useConciergeLintMetrics.getState().checks["ask-without-action"]).toBe(0);
  });

  it("runs NOTHING when the config disables the linter — the master switch is real", async () => {
    // Proves the config is actually consulted at the mount rather than the checks running
    // unconditionally, which would look identical on every row above.
    h.getConfig.mockResolvedValue({
      config: { concierge: { checks: { ...CHECKS_PAYLOAD, enabled: false } } },
    });
    await turn("The branch is 92 commits behind. Want me to rebase it?", []);

    expect(useConciergeLintMetrics.getState().checks["ask-without-action"]).toBe(0);
    expect(loggedViolations()).toEqual([]);
  });

  it("runs NOTHING when the check's own row is off", async () => {
    h.getConfig.mockResolvedValue({
      config: {
        concierge: {
          checks: {
            ...CHECKS_PAYLOAD,
            checks: { "ask-without-action": { enabled: true, severity: "off", autofix: false } },
          },
        },
      },
    });
    await turn("The branch is 92 commits behind. Want me to rebase it?", []);
    expect(useConciergeLintMetrics.getState().checks["ask-without-action"]).toBe(0);
  });
});

// ══ THE SEAM `reply-without-quote` HANGS ON, WHICH NO UNIT TEST CAN REACH ═══════════════════════
// The check is a pure function of `ctx.founderMessages`, and its own suite supplies that array
// directly — so every row over there passes even if `ConciergeHost` never computes it. That is the
// defaulted-seam shape this repo has a standing warning about: delete the one line in the mount that
// calls `answerFields(chatRef.current, e.id)` and the check's whole suite stays green while the
// feature is dead, because an absent answer set makes the check stand down by design.
//
// These two rows are the only thing in the tree that would go red. They drive the REAL send path, so
// the message under test is a genuine `you` bubble that `pendingAnchors` has to find, and they share
// one user message and differ only in whether the reply opens by quoting it.
describe("reply-without-quote, end to end through the real mount", () => {
  const QUOTE_ON = {
    ...CHECKS_PAYLOAD,
    // `warn`, not the shipped `block`: the block path is `ConciergeHost.lintBlock.test.tsx`'s
    // subject, and holding the reply here would put a correction turn between the violation and the
    // counter that these rows are reading.
    checks: { "reply-without-quote": { enabled: true, severity: "warn", autofix: false } },
  };

  beforeEach(() => {
    h.getConfig.mockResolvedValue({ config: { concierge: { checks: QUOTE_ON } } });
  });

  it("FIRES when the reply does not open by quoting the message it is answering", async () => {
    await turn("The fleet is quiet — three agents idle, nothing red.", [], "how is the fleet doing?");
    expect(
      useConciergeLintMetrics.getState().checks["reply-without-quote"],
      "the mount must hand the check the message this reply answers; with an empty answer set the " +
        "check stands down and this reads zero",
    ).toBeGreaterThan(0);
  });

  it("stays SILENT when it opens with a blockquote of that same message", async () => {
    await turn(
      "> how is the fleet doing\n\nQuiet — three agents idle, nothing red.",
      [],
      "how is the fleet doing?",
    );
    expect(
      useConciergeLintMetrics.getState().checks["reply-without-quote"],
      "a reply that opens by quoting him is the compliant form and must not be flagged",
    ).toBe(0);
    expect(loggedViolations()).toEqual([]);
  });
});
