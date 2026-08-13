// @vitest-environment jsdom
//
// THE PROMPT IS THE TRIGGER — a permission prompt in an `always` category is answered when it
// APPEARS, not when the founder happens to click the pane.
//
// This is the executable half of the founder's decision of 2026-08-12 (see `autoApproveWatch`'s
// header for the report, the measurement and the decision). Its counterpart,
// `autoApproveMountGate.test.tsx`, holds the OTHER side of the same contract: that the click which
// used to be the trigger no longer answers anything.
//
// ── WHAT THESE ASSERT, AND WHY IT IS THE PTY WRITE ──────────────────────────────────────────────
// Every case here asserts the actual KEYSTROKE reaching the agent's PTY — `writePtyChainedStrict`
// with the option string — rather than that a function was called or a component rendered. The
// whole subject is an irreversible side effect on a pane nobody is looking at, so an assertion about
// anything short of the write would be an assertion about a precondition.
//
// So the only things mocked are the two edges: the PTY itself (there is no terminal in a unit test)
// and the AI feature flag (it reads Tauri config). The classifier, the per-tool MCP policy, the
// effective-rule resolution, the freshness gate, the settle window and the de-dupe set are all the
// real ones, driven through the real store writes a `Terminal` performs.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const writePty = vi.fn((_id: string, _data: string) => Promise.resolve());
vi.mock("../../pty", () => ({
  // CHAINED + STRICT, the same write discipline `approvalsRuntime` has always used: the keystroke
  // carries its own CR, so it must not land inside another writer's paste→CR window (roborev
  // 54369/54375), and a dead PTY must REJECT so "never reached the pane" stays reportable.
  writePtyChainedStrict: (id: string, data: string) => writePty(id, data),
}));

const aiFeatureVisibleNow = vi.fn((_key: string) => true);
vi.mock("../aiGate", () => ({ aiFeatureVisibleNow: (key: string) => aiFeatureVisibleNow(key) }));

import {
  SETTLE_MS,
  onRuntimeChange,
  resetAutoApproveWatchForTests,
  startAutoApproveWatch,
} from "./autoApproveWatch";
import { CAPTURE_MAX_AGE_MS } from "./approvalScreen";
import { resetHandledSignatures } from "./handledSigs";
import { SETTLE_TICK_MS } from "./useSuggestions";
import { registerScrollback } from "../terminalScrollback";
import { useRuntimeStore } from "../../stores/runtimeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useApprovalsStore } from "../../stores/approvalsStore";
import { useProjectStore } from "../../stores/projectStore";
import { resetPromptGraceLedgerForTests } from "../../engine/blockedPromptGrace";
import {
  resetRetractionLedgerForTests,
  windowRetractionLedger,
} from "../../engine/movementRetraction";

const AGENT = "a1";
const FOOTER = "Enter to select · ↑/↓ to navigate · Esc to cancel";

/** A real Claude Code bash permission prompt. `1` is plain Yes. */
function bashPrompt(command: string): string {
  return [
    "Bash command",
    `  ${command}`,
    "Do you want to proceed?",
    "❯ 1. Yes",
    "  2. Yes, and don't ask again for rm commands",
    "  3. No, and tell Claude what to do differently",
    "",
    FOOTER,
  ].join("\n");
}

const PROMPT = bashPrompt("rm -rf build/");

/** A `sparkle_lifecycle` discard — the shape `mcpToolPolicy` vetoes even under `mcp = "always"`. */
const LIFECYCLE_PROMPT = [
  'sparkle-control - sparkle_lifecycle(op: "discard_agent", agentId: "abc")',
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. Yes, and don't ask again",
  "  3. No, and tell Claude what to do differently",
  "",
  FOOTER,
].join("\n");

let unregister: (() => void) | null = null;
let stopWatch: (() => void) | null = null;

/** What `Terminal.onStatusWithCapture` does, in the order it does it: photograph the screen FIRST,
 *  then set the red status. The order is load-bearing in production (the capture expires with the
 *  ask, so it must be written before the status that keeps it) and it is the order the watch sees. */
function agentAsks(screen: string, status: "approval" | "waiting" = "approval"): void {
  useRuntimeStore.getState().setAttentionScreen(AGENT, screen);
  useRuntimeStore.getState().setStatus(AGENT, status);
}

beforeEach(() => {
  vi.useFakeTimers();
  // A fixed wall clock, shared by `setAttentionScreen`'s stamp and the freshness gate that reads it
  // — the two must not be able to drift apart, which is why the clock is faked rather than injected.
  vi.setSystemTime(new Date("2026-08-12T12:00:00Z"));
  writePty.mockClear();
  aiFeatureVisibleNow.mockReturnValue(true);
  resetPromptGraceLedgerForTests();
  resetRetractionLedgerForTests();
  // The de-dupe registry is per-AGENT MODULE state and every case here uses the same agent and the
  // same picker — so without this, case two onwards would take `maybeAutoApprove`'s "already
  // answered this signature" arm, which returns the category and writes NOTHING. That failure is
  // indistinguishable from the feature being broken, and it is what these cases are asserting about.
  resetHandledSignatures();
  resetAutoApproveWatchForTests();
  useRuntimeStore.setState({ status: {}, attentionScreen: {}, attentionScreenAt: {} });
  // No project in context → the effective rule falls back to the global settings mirror. `bash =
  // "always"` is the founder's actual config.
  useProjectStore.setState({ projects: [] });
  useApprovalsStore.setState({ byRoot: {}, resumeByRoot: {} });
  useSettingsStore.setState({ approvals: { bash: "always" }, resumeRule: "ask" });
});

afterEach(() => {
  unregister?.();
  unregister = null;
  stopWatch?.();
  stopWatch = null;
  resetAutoApproveWatchForTests();
  vi.useRealTimers();
});

describe("a prompt is answered when it appears, on a pane nobody has opened", () => {
  // THE CASE THAT FAILS AGAINST THE OLD CODE. Nothing is mounted for this agent — no terminal, so no
  // scrollback provider, and no suggestions hook, because the concierge mounts that only for the
  // SELECTED agent. Before this watch existed the keystroke could not be emitted until the founder
  // clicked, and `autoApproveMountGate.test.tsx` pinned exactly that.
  it("types the plain-Yes keystroke for an agent with NO mounted terminal", () => {
    stopWatch = startAutoApproveWatch();

    agentAsks(PROMPT);
    // Not yet: the screen has to hold still first (a picker paints over several frames).
    expect(writePty).not.toHaveBeenCalled();

    vi.advanceTimersByTime(SETTLE_MS);

    expect(writePty).toHaveBeenCalledTimes(1);
    expect(writePty).toHaveBeenCalledWith(AGENT, "1\n");
  });

  // The population the founder actually measured: the agent's pane IS mounted (its project has been
  // visited, so its Terminal is alive and its scrollback is right there) but it is not the SELECTED
  // agent, so no suggestions hook is reading it. Clicking it is what used to answer the prompt.
  it("types the keystroke for a MOUNTED but unselected agent, off its live scrollback", () => {
    unregister = registerScrollback(AGENT, () => PROMPT);
    stopWatch = startAutoApproveWatch();

    // No capture at all — this agent's screen is being read from the live buffer.
    useRuntimeStore.getState().setStatus(AGENT, "approval");
    vi.advanceTimersByTime(SETTLE_MS);

    expect(writePty).toHaveBeenCalledWith(AGENT, "1\n");
  });

  // The de-dupe set is the guard against an irreversible action, so it is asserted against the
  // noisiest thing the store does: repeated writes while the same picker sits there.
  it("answers a given picker exactly once, however many store ticks arrive", () => {
    unregister = registerScrollback(AGENT, () => PROMPT);
    stopWatch = startAutoApproveWatch();

    useRuntimeStore.getState().setStatus(AGENT, "approval");
    vi.advanceTimersByTime(SETTLE_MS);
    expect(writePty).toHaveBeenCalledTimes(1);

    // Re-capturing the identical screen, and re-asserting the identical status, are both ordinary.
    for (let i = 0; i < 5; i++) {
      useRuntimeStore.getState().setAttentionScreen(AGENT, PROMPT);
      vi.advanceTimersByTime(SETTLE_MS);
    }
    expect(writePty).toHaveBeenCalledTimes(1);
  });
});

describe("staleness — an uncertain screen is never treated as a live prompt", () => {
  // THE MAIN HAZARD (the founder's first constraint). A capture is a photograph, not the present
  // tense: answering off an old one types a digit into whatever replaced the prompt.
  it("refuses a capture older than the age ceiling", () => {
    // The screen was captured, and then a long time passed with nothing moving the status.
    useRuntimeStore.getState().setAttentionScreen(AGENT, PROMPT);
    vi.advanceTimersByTime(CAPTURE_MAX_AGE_MS + 1000);

    stopWatch = startAutoApproveWatch();
    useRuntimeStore.getState().setStatus(AGENT, "approval");
    vi.advanceTimersByTime(SETTLE_MS);

    expect(writePty).not.toHaveBeenCalled();
  });

  // PAIRED with the case above (one test proving absence is ambiguous): same agent, same prompt,
  // same entry point, same status write — only the capture's AGE differs. Without this, "no write"
  // above could be explained by the watch never running at all.
  it("…and answers the same prompt when the capture is fresh", () => {
    useRuntimeStore.getState().setAttentionScreen(AGENT, PROMPT);
    vi.advanceTimersByTime(CAPTURE_MAX_AGE_MS - 5_000);

    stopWatch = startAutoApproveWatch();
    useRuntimeStore.getState().setStatus(AGENT, "approval");
    vi.advanceTimersByTime(SETTLE_MS);

    expect(writePty).toHaveBeenCalledWith(AGENT, "1\n");
  });

  // The second expiry, and the one that covers an agent whose status nobody is writing: the movement
  // ledger has SEEN this agent act since the screen was photographed, so that screen describes a
  // question it has already moved past.
  it("refuses a capture the agent has been seen working since", () => {
    stopWatch = startAutoApproveWatch();
    useRuntimeStore.getState().setAttentionScreen(AGENT, PROMPT);
    const capturedAt = useRuntimeStore.getState().attentionScreenAt[AGENT];
    // Asserted rather than defaulted: `setAttentionScreen` writes the text and the stamp as ONE, so
    // a missing stamp here would mean that pairing broke — and silently defaulting it would turn
    // that regression into a test that still passes for the wrong reason.
    expect(capturedAt).toBeTypeOf("number");
    // A hook work event landed AFTER the capture — the same fact that retracts a frozen red card.
    windowRetractionLedger().movedAt.set(AGENT, (capturedAt ?? 0) + 1);

    useRuntimeStore.getState().setStatus(AGENT, "approval");
    vi.advanceTimersByTime(SETTLE_MS);

    expect(writePty).not.toHaveBeenCalled();
  });

  // A capture with no write time cannot be aged at all. The concierge's read chain judges such a
  // capture episode-relative and SERVES it, which is right for a narration; a write may not. Absent
  // evidence must not become permission.
  it("refuses a capture that carries no write time", () => {
    stopWatch = startAutoApproveWatch();
    // A capture written by a path that did not pair the two maps (or one that predates the stamp).
    useRuntimeStore.setState({ attentionScreen: { [AGENT]: PROMPT }, attentionScreenAt: {} });
    useRuntimeStore.getState().setStatus(AGENT, "approval");
    vi.advanceTimersByTime(SETTLE_MS);

    expect(writePty).not.toHaveBeenCalled();
  });
});

describe("the screen must hold still, and the agent must still be stopped", () => {
  // A terminal paints a picker over several frames. Deciding on the first frame that happens to
  // classify would answer a question whose options are still being drawn.
  it("does not decide on a screen that is still changing", () => {
    let screen = bashPrompt("npm run build");
    unregister = registerScrollback(AGENT, () => screen);
    stopWatch = startAutoApproveWatch();

    useRuntimeStore.getState().setStatus(AGENT, "approval");
    // The screen moves on before the settle window elapses — this one classifies perfectly well, so
    // nothing but the settle rule stops it being answered.
    screen = bashPrompt("rm -rf build/");
    vi.advanceTimersByTime(SETTLE_MS);
    expect(writePty).not.toHaveBeenCalled();

    // Now it holds still, and only now is it answered.
    vi.advanceTimersByTime(SETTLE_MS);
    expect(writePty).toHaveBeenCalledTimes(1);
    expect(writePty).toHaveBeenCalledWith(AGENT, "1\n");
  });

  // THE HISTORY HAZARD. Tier (a) of the read is the xterm SCROLLBACK — up to 300 lines of it — so a
  // picker the human answered by hand seconds ago is still sitting in the tail, still perfectly
  // classifiable, and `handledSigs` has never heard of it (nothing auto-answered it). The status is
  // the only thing that says the agent is still stopped, so it is re-checked at the moment of
  // decision and not merely at the moment of arming.
  //
  // Driven through the exported subscription body rather than the live subscription, deliberately:
  // that is precisely a status write the watch's own subscriber did not process, which is the state
  // this re-check exists for.
  it("does not answer once the agent has left the ask status", () => {
    unregister = registerScrollback(AGENT, () => PROMPT);
    onRuntimeChange({ status: { [AGENT]: "approval" }, attentionScreen: {} });

    // The human answered it in the terminal; the agent is running again, and the prompt it answered
    // is still in the scrollback tail.
    useRuntimeStore.getState().setStatus(AGENT, "working");
    vi.advanceTimersByTime(SETTLE_MS);

    expect(writePty).not.toHaveBeenCalled();
  });

  // PAIRED with the case above: identical setup, identical entry point, and the agent is still at
  // the prompt — so the silence above is attributable to the status re-check and to nothing else.
  it("…and does answer when the agent is still at the prompt", () => {
    unregister = registerScrollback(AGENT, () => PROMPT);
    onRuntimeChange({ status: { [AGENT]: "approval" }, attentionScreen: {} });

    useRuntimeStore.getState().setStatus(AGENT, "approval");
    vi.advanceTimersByTime(SETTLE_MS);

    expect(writePty).toHaveBeenCalledWith(AGENT, "1\n");
  });

  // A STORE THAT TICKS FASTER THAN THE SETTLE WINDOW MUST NOT POSTPONE THE ANSWER FOREVER. An
  // agent's own path into a permission prompt is commonly `waiting` then `approval` (Claude fires a
  // Notification ping before the picker resolves), and each of those is a store write that re-visits
  // this agent while the SAME screen sits there. Re-arming the timer on each visit would push the
  // decision out by a full window every time — with a store that writes often enough, out forever —
  // so an unchanged screen keeps the timer it already has.
  it("does not restart the settle window when a store tick shows the SAME screen", () => {
    unregister = registerScrollback(AGENT, () => PROMPT);
    stopWatch = startAutoApproveWatch();

    useRuntimeStore.getState().setStatus(AGENT, "waiting");
    vi.advanceTimersByTime(SETTLE_MS - 400);
    // A second visit, two thirds of the way through the window, with nothing about the screen
    // changed. The clock that matters is the one that started at the FIRST sight of this screen.
    useRuntimeStore.getState().setStatus(AGENT, "approval");
    vi.advanceTimersByTime(400);

    expect(writePty).toHaveBeenCalledTimes(1);
    expect(writePty).toHaveBeenCalledWith(AGENT, "1\n");
  });

  // A decision armed for an agent that has started RUNNING again is dropped, not merely refused at
  // the deadline. The refusal at the deadline is the correctness guard (see the history hazard
  // above); this is about not holding an armed write over a working agent for a second longer than
  // the store's own news about it.
  it("drops an armed decision the moment the agent goes back to work", () => {
    unregister = registerScrollback(AGENT, () => PROMPT);
    stopWatch = startAutoApproveWatch();

    useRuntimeStore.getState().setStatus(AGENT, "approval");
    expect(vi.getTimerCount()).toBe(1);

    useRuntimeStore.getState().setStatus(AGENT, "working");
    expect(vi.getTimerCount()).toBe(0);
  });

  // `idle`/`done`/`errored` are in the hook's YOUR_TURN set because it offers BUTTONS there. This
  // path types a key, and a finished turn is not holding a picker — whatever is in the tail is
  // history.
  it("does not answer an agent whose turn is over", () => {
    unregister = registerScrollback(AGENT, () => PROMPT);
    stopWatch = startAutoApproveWatch();

    useRuntimeStore.getState().setStatus(AGENT, "idle");
    vi.advanceTimersByTime(SETTLE_MS * 3);

    expect(writePty).not.toHaveBeenCalled();
  });
});

describe("the policy vetoes still stand on the off-pane path", () => {
  // The founder's fourth constraint, and the thing standing between "answer prompts I did not read"
  // and real harm. Widening WHO gets auto-answered must not widen WHAT gets auto-answered.
  it("refuses a lifecycle discard even with mcp = always", () => {
    useSettingsStore.setState({ approvals: { mcp: "always" } });
    unregister = registerScrollback(AGENT, () => LIFECYCLE_PROMPT);
    stopWatch = startAutoApproveWatch();

    useRuntimeStore.getState().setStatus(AGENT, "approval");
    vi.advanceTimersByTime(SETTLE_MS);

    expect(writePty).not.toHaveBeenCalled();
  });

  // The master toggle. Auto-approve being OFF has to mean off everywhere, including here.
  it("writes nothing while the auto-approve toggle is off", () => {
    aiFeatureVisibleNow.mockReturnValue(false);
    unregister = registerScrollback(AGENT, () => PROMPT);
    stopWatch = startAutoApproveWatch();

    useRuntimeStore.getState().setStatus(AGENT, "approval");
    vi.advanceTimersByTime(SETTLE_MS);

    expect(writePty).not.toHaveBeenCalled();
  });

  // A category the human has not opted into is still the human's to answer.
  it("writes nothing when the effective rule is not 'always'", () => {
    useSettingsStore.setState({ approvals: { bash: "never" } });
    unregister = registerScrollback(AGENT, () => PROMPT);
    stopWatch = startAutoApproveWatch();

    useRuntimeStore.getState().setStatus(AGENT, "approval");
    vi.advanceTimersByTime(SETTLE_MS);

    expect(writePty).not.toHaveBeenCalled();
  });
});

// The settle window is a COPY of the hook's, taken rather than imported so that starting the watch
// at boot does not pull the metered suggestions engine into the initial chunk. A copied constant
// drifts; this is what stops it.
it("settles on the same window the mounted hook does", () => {
  expect(SETTLE_MS).toBe(SETTLE_TICK_MS);
});
