// @vitest-environment jsdom
//
// THE ANSWER-OUTCOME HALF of the blocked-prompt grace window (engine/blockedPromptGrace).
//
// A drawn permission prompt is held out of the founder's needs-you list for up to 30s while an
// automated answerer works, and the hold ends the instant an answerer reports `declined` or
// `unreachable`. `dispatchConciergeAnswer` is the chokepoint every concierge-driven answer passes
// through, so if it reports nothing the ceiling is the ONLY thing that ever surfaces a prompt — a
// refused write and a delivered one look identical for the full thirty seconds.
//
// WHAT THESE ASSERT, and why it is the side effect rather than a precondition: every case reads the
// outcome the ledger actually holds AFTERWARDS. Delete the reporting funnel and every one of them
// reads `undefined` and goes red; hard-code either arm and its pair goes red. Nothing here asserts
// that the dispatch returned a particular path — that was already true before this change.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SuggestionButton } from "./suggestions/types";

vi.mock("../pty", () => {
  class PtyGoneError extends Error {}
  return {
    writePtyChainedStrict: vi.fn(async () => {}),
    submitPrompt: vi.fn(async () => {}),
    PASTE_START: "",
    PASTE_END: "",
    stripPasteMarkers: (s: string) => s,
    PtyGoneError,
  };
});
vi.mock("./terminalScrollback", () => ({ getAgentScrollback: vi.fn(() => "SCREEN") }));
vi.mock("./suggestions/heuristics", () => ({
  detectTerminalPrompts: vi.fn(() => [] as SuggestionButton[]),
}));

import { PtyGoneError, submitPrompt, writePtyChainedStrict } from "../pty";
import { detectTerminalPrompts } from "./suggestions/heuristics";
import {
  abandonPendingSends,
  dispatchConciergeAnswer,
  flushPendingSends,
} from "./conciergeDispatch";
import { queuePendingSend, resetPendingSends } from "./pendingSends";
import { resetPaneReadiness } from "./paneReadiness";
import {
  resetPromptGraceLedgerForTests,
  windowPromptGraceLedger,
  type PromptAnswerOutcome,
} from "../engine/blockedPromptGrace";

const TEST_AUTHORITY = { kind: "suggestion", agentId: "a1" } as const;

const btn = (id: string, label: string, value: string): SuggestionButton => ({
  id,
  label,
  value,
  kind: "terminal",
  source: "heuristic",
});
const YN = [btn("1", "Yes", "y\n"), btn("2", "No", "n\n")];

const asMock = (f: unknown) => f as unknown as ReturnType<typeof vi.fn>;
const setPrompt = (opts: SuggestionButton[]) => asMock(detectTerminalPrompts).mockReturnValue(opts);

/** THE SIDE EFFECT UNDER TEST: what the grace window now believes about this agent's prompt.
 *  `undefined` is the pre-change behaviour — nothing reported at all. */
const reported = (agentId: string): PromptAnswerOutcome | undefined =>
  windowPromptGraceLedger().outcome.get(agentId)?.outcome;

const ptyGone = () => new (PtyGoneError as unknown as new () => Error)();

beforeEach(() => {
  vi.clearAllMocks();
  // WINDOW-level module state. An outcome left behind by one case would silently satisfy the next
  // one's assertion — the exact vacuity this suite exists to avoid.
  resetPromptGraceLedgerForTests();
  resetPendingSends();
  resetPaneReadiness();
  asMock(detectTerminalPrompts).mockReturnValue([]);
  asMock(submitPrompt).mockResolvedValue(undefined);
  asMock(writePtyChainedStrict).mockResolvedValue(undefined);
});

// ── THE PAIR ─────────────────────────────────────────────────────────────────────────────────────
// One call path, two write results. A single-sided test cannot tell wiring from an unconditional
// call: assert only the failing side and `notePromptAnswerOutcome(id, "unreachable")` written
// straight into the function body passes it.
describe("dispatchConciergeAnswer — the picker-answer path reports BOTH ways", () => {
  it("a delivered picker keystroke reports `handled`", async () => {
    setPrompt(YN);
    const r = await dispatchConciergeAnswer("a1", "yes", { authority: TEST_AUTHORITY });
    expect(r.path).toBe("picker-option");
    expect(reported("a1")).toBe("handled");
  });

  it("…and the SAME answer on a dead PTY reports `unreachable`", async () => {
    setPrompt(YN);
    asMock(writePtyChainedStrict).mockRejectedValueOnce(ptyGone());
    const r = await dispatchConciergeAnswer("a1", "yes", { authority: TEST_AUTHORITY });
    expect(r.path).toBe("pty-gone");
    expect(reported("a1")).toBe("unreachable");
  });
});

describe("dispatchConciergeAnswer — refusals surface the prompt at once", () => {
  it("an answer that maps to no option reports `declined`", async () => {
    setPrompt(YN);
    const r = await dispatchConciergeAnswer("a1", "banana", { authority: TEST_AUTHORITY });
    expect(r.path).toBe("ambiguous-picker");
    expect(reported("a1")).toBe("declined");
  });

  it("an ADDRESSED message at a live picker reports `declined`", async () => {
    setPrompt(YN);
    const r = await dispatchConciergeAnswer("a1", "yes", {
      authority: TEST_AUTHORITY,
      neverPickerAnswer: true,
    });
    expect(r.path).toBe("addressed-at-picker");
    expect(reported("a1")).toBe("declined");
  });

  // The two returns taken BEFORE any await — the arms a per-return-site wiring is likeliest to miss,
  // and the reason the funnel wraps the whole body rather than decorating the delivery paths.
  it("an un-authorized dispatch reports `declined`", async () => {
    const r = await dispatchConciergeAnswer("a1", "yes", {
      authority: { kind: "not-a-kind", agentId: "a1" } as never,
    });
    expect(r.path).toBe("unauthorized");
    expect(reported("a1")).toBe("declined");
  });

  it("an empty dispatch reports `declined`", async () => {
    const r = await dispatchConciergeAnswer("a1", "   ", { authority: TEST_AUTHORITY });
    expect(r.path).toBe("empty");
    expect(reported("a1")).toBe("declined");
  });
});

describe("dispatchConciergeAnswer — a delivered free-text prompt reports `handled`", () => {
  it("reports handled, and only for the agent it was aimed at", async () => {
    await dispatchConciergeAnswer("a1", "ship the docs pass", { authority: TEST_AUTHORITY });
    expect(reported("a1")).toBe("handled");
    // Keyed on the RESULT's agentId: a sibling agent's held prompt must not be surfaced by someone
    // else's dispatch.
    expect(reported("a2")).toBeUndefined();
  });
});

// ── THE DEFERRED HALF ────────────────────────────────────────────────────────────────────────────
// A queued send has already reported `handled` ("keep holding"). If it then dies, nothing on the
// direct path can correct that — the caller is long gone — so the flush/abandon emitters are the
// only channel left before the ceiling.
describe("flushPendingSends — the deferred outcome reports BOTH ways", () => {
  const queue = (text: string, at?: number) =>
    queuePendingSend({ agentId: "a1", text, userPrompt: false, humanAuthored: false, ...(at !== undefined ? { at } : {}) });

  it("a queued send that finally lands reports `handled`", async () => {
    queue("later");
    const results = await flushPendingSends("a1");
    expect(results.map((r) => r.path)).toEqual(["free-text"]);
    expect(reported("a1")).toBe("handled");
  });

  it("…and the SAME queued send onto a dead PTY reports `unreachable`", async () => {
    queue("later");
    asMock(submitPrompt).mockRejectedValueOnce(ptyGone());
    const results = await flushPendingSends("a1");
    expect(results.map((r) => r.path)).toEqual(["pty-gone"]);
    expect(reported("a1")).toBe("unreachable");
  });

  it("a hold that aged out reports `unreachable` rather than riding out the ceiling", async () => {
    queue("held too long", 0);
    const results = await flushPendingSends("a1");
    expect(results.map((r) => r.path)).toEqual(["expired"]);
    expect(reported("a1")).toBe("unreachable");
  });
});

describe("abandonPendingSends — a pane that will never come up reports `unreachable`", () => {
  it("reports unreachable for the agent whose holds were voided", () => {
    queuePendingSend({ agentId: "a1", text: "first", userPrompt: false, humanAuthored: false });
    abandonPendingSends("a1");
    expect(reported("a1")).toBe("unreachable");
  });

  it("says nothing when nothing was held (an ordinary unmount is not a failed answer)", () => {
    abandonPendingSends("a1");
    expect(reported("a1")).toBeUndefined();
  });
});
