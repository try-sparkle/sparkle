// @vitest-environment jsdom
//
// THE CLICK IS NOT THE TRIGGER ANY MORE — opening an agent's pane must not be what answers a
// permission prompt that has been sitting on its screen.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────────
// The founder reported it as a P0 in these words: *"clicking an agent pane auto-runs a waiting bash
// command — a click may be silently answering permission prompts."* The question he asked first was
// whether that is a real PTY write or a repaint-only artefact. It is a real write, and this file was
// written to be the executable half of that answer.
//
// Measured from one day of production logs before it was written: of 325 pane switches, 96 were
// followed within ONE SECOND by an auto-approve keystroke (~24x the rate expected from the day's
// base rate of such writes) and 151 within two seconds — so roughly half of every click, and ~49% of
// all 310 auto-approve decisions that day, landed in the window right after a click. The nudger's
// own writes showed no such enrichment (1.2x), which is what rules out "the app is just busy after a
// switch" as the explanation.
//
// ── THE MECHANISM, WHICH WAS A GATE AND NOT A RACE ──────────────────────────────────────────────
// Auto-approve has only ever run inside `useSuggestions`, and the concierge mounts that hook for the
// SELECTED agent only (`Concierge/ConciergeSuggestions`, keyed by agent id). Every other agent had
// nobody reading it — including agents whose terminal was mounted and whose scrollback was sitting
// right there. Selecting an agent mounted the hook, the hook read a prompt that had been on screen
// for minutes, and answered it. The click was not racing the answer; it WAS the answer's trigger.
//
// ── THE DECISION THAT SUPERSEDED THE ORIGINAL VERSION OF THIS FILE ──────────────────────────────
// The first version of this file pinned the gate as it stood and took no position on whether it was
// desirable, because the founder had not yet decided whether an unread prompt should be
// auto-answerable on sight. It said the second test should go red first if that policy changed, and
// that its expectation should be REVISED rather than deleted.
//
// HE DECIDED ON 2026-08-12, explicitly over a dwell-timer and over leaving it alone, in these terms:
// let the auto-approver see agents whose pane is NOT open, so a prompt in an `always` category is
// answered the moment it appears, decoupled from the click entirely. He accepted the widened blast
// radius — the app now writes to PTYs he is not watching — on the strength of four constraints:
// staleness must fail closed, nothing may be double-answered, the chained write path is unchanged,
// and the per-tool MCP veto keeps applying. `services/suggestions/autoApproveWatch` is the mechanism
// and its header carries those four in full.
//
// So the expectations below are revised to the new contract, and the revision is the point of the
// file rather than a footnote to it. What it pins now is the OTHER HALF of that decision — that the
// click, having been the trigger, is no longer one. `autoApproveWatch.test.ts` pins the first half
// (a prompt is answered when it appears). Neither is sufficient alone: a watch that answers is not a
// fix if the subsequent click answers a second time, which is precisely the failure roborev 53074
// was about, reached by a different road.
//
// ── WHAT THESE ASSERT ───────────────────────────────────────────────────────────────────────────
// The actual keystroke reaching the PTY. An assertion that a function was called, or that a
// component rendered, would be an assertion about a precondition — and this whole subject is an
// irreversible side effect. So `approvalsRuntime` is NOT mocked here (the original version of this
// file mocked it, which was adequate for a claim about WHEN the decision is taken and is not
// adequate for a claim about what reaches the pane); only the two real edges are — the PTY and the
// AI feature flag.
//
// SO THIS FILE DELIBERATELY DOES NOT MOCK `../terminalScrollback` EITHER, which every sibling suite
// does (`getAgentScrollback: () => …`, a stub returning content unconditionally, i.e. a world where
// the terminal is ALWAYS mounted). That stub is reasonable when you are testing the de-dupe guard,
// but it makes the mount state unrepresentable, and the mount state is the entire subject here.
//
// Related prior art, both narrower halves of this same surface: roborev 53074 (a remount re-answered
// an ALREADY-answered prompt — fixed by making `handledSigs` per-agent module state) and roborev
// 53159 (the de-dupe set outliving a turn suppressed a genuinely new prompt).
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writePty = vi.fn((_id: string, _data: string) => Promise.resolve());
vi.mock("../../pty", () => ({
  writePtyChainedStrict: (id: string, data: string) => writePty(id, data),
}));

const aiFeatureVisibleNow = vi.fn((_key: string) => true);
vi.mock("../aiGate", () => ({
  aiFeatureVisibleNow: (key: string) => aiFeatureVisibleNow(key),
  // The hook's own gate for the LEARNED tier — off, so no metered path is reachable from here.
  useAiFeature: () => false,
}));
vi.mock("./engine", () => ({
  computeSuggestions: vi.fn(async () => ({ agentId: "a1", buttons: [] })),
  SuggestionOfflineError: class extends Error {},
}));

// NOT MOCKED, on purpose (see the header): the scrollback registry holds the mount state, and
// `approvalsRuntime` holds the decision and the write.
import { registerScrollback } from "../terminalScrollback";
import { startAutoApproveWatch, resetAutoApproveWatchForTests, SETTLE_MS } from "./autoApproveWatch";
import { resetSuggestionMemory, useSuggestions } from "./useSuggestions";
import { useRuntimeStore } from "../../stores/runtimeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useApprovalsStore } from "../../stores/approvalsStore";
import { useProjectStore } from "../../stores/projectStore";
import { resetPromptGraceLedgerForTests } from "../../engine/blockedPromptGrace";
import { resetRetractionLedgerForTests } from "../../engine/movementRetraction";

const AGENT = "a1";

/** The screen a real permission prompt presents. `1` is plain Yes. */
const PROMPT = [
  "Bash command",
  "  rm -rf build/",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. Yes, and don't ask again for rm commands",
  "  3. No, and tell Claude what to do differently",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");

/** How many keystrokes actually reached the PTY. */
const keystrokes = () => writePty.mock.calls.length;

/**
 * Give the mounted hook every chance to type.
 *
 * BOTH HALVES ARE NEEDED, and a bare timer advance is the trap. The hook's settle watcher runs on
 * TIMERS, but its auto-approve arm hangs off the `.then` of `computeSuggestions` — a MICROTASK — so
 * advancing the clock synchronously returns before the decision has been taken. Every assertion in
 * this file is of the form "nothing more was typed", and that assertion is worthless if the code
 * that would have typed never got to run. Three rounds because the watcher wants two consecutive
 * identical hashes before it calls a screen settled.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    // Sequential by construction: each round is a tick, and a tick must complete before the next.
    await act(async () => {
      vi.advanceTimersByTime(SETTLE_MS);
    });
  }
}

let unregister: (() => void) | null = null;
let stopWatch: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-12T12:00:00Z"));
  writePty.mockClear();
  aiFeatureVisibleNow.mockReturnValue(true);
  resetSuggestionMemory();
  resetPromptGraceLedgerForTests();
  resetRetractionLedgerForTests();
  resetAutoApproveWatchForTests();
  useRuntimeStore.setState({ status: {}, attentionScreen: {}, attentionScreenAt: {} });
  useProjectStore.setState({ projects: [] });
  useApprovalsStore.setState({ byRoot: {}, resumeByRoot: {} });
  // The founder's actual config: bash auto-approves.
  useSettingsStore.setState({ approvals: { bash: "always" }, resumeRule: "ask" });
});
afterEach(() => {
  unregister?.();
  unregister = null;
  stopWatch?.();
  stopWatch = null;
  resetAutoApproveWatchForTests();
  cleanup();
  vi.useRealTimers();
});

describe("opening a pane is no longer what answers a pending permission prompt", () => {
  it("answers while the pane is CLOSED, and the click that follows types nothing", async () => {
    stopWatch = startAutoApproveWatch();

    // The agent stops to ask, with nobody looking at it. This is what `Terminal.onStatusWithCapture`
    // does — photograph the screen, then set the red status — for an agent whose pane is mounted but
    // not selected, which is the population the founder measured.
    useRuntimeStore.getState().setAttentionScreen(AGENT, PROMPT);
    useRuntimeStore.getState().setStatus(AGENT, "approval");
    vi.advanceTimersByTime(SETTLE_MS);

    // The prompt is answered here — before any click, with no hook mounted for this agent at all.
    expect(keystrokes()).toBe(1);
    expect(writePty).toHaveBeenCalledWith(AGENT, "1\n");

    // NOW THE CLICK, modelled as the app performs it: opening the pane mounts `Terminal` (which
    // registers the scrollback provider) and the suggestions row together, and the same prompt is
    // still the newest thing in the buffer.
    unregister = registerScrollback(AGENT, () => PROMPT);
    renderHook(() => useSuggestions(AGENT, true));
    await settle();

    // …and NOTHING more is typed. This is the founder's P0: the click used to be the trigger, and
    // the ~49% of auto-approve decisions that landed within a second of a pane switch were this
    // write happening here instead of above.
    expect(keystrokes()).toBe(1);
  });

  it("still SHOWS the pane that its prompt was auto-approved", async () => {
    // The other half of not double-answering: suppressing the second keystroke must not also
    // suppress the note. `maybeAutoApprove` returns the category from its "already handled this
    // signature" arm precisely so the pane can say what happened to a prompt it never displayed —
    // if that arm returned null instead, the pane would fall back to showing raw buttons for a
    // question that has already been answered.
    stopWatch = startAutoApproveWatch();
    useRuntimeStore.getState().setAttentionScreen(AGENT, PROMPT);
    useRuntimeStore.getState().setStatus(AGENT, "approval");
    vi.advanceTimersByTime(SETTLE_MS);
    expect(keystrokes()).toBe(1);

    unregister = registerScrollback(AGENT, () => PROMPT);
    const view = renderHook(() => useSuggestions(AGENT, true));
    await settle();

    expect(view.result.current.autoApproved).toBe("bash");
    expect(keystrokes()).toBe(1);
  });

  it("the mounted hook remains an answerer of LAST RESORT, not the trigger", async () => {
    // The causal finding this file was originally written to record is still true and still worth
    // holding: mounting alone — no new output, no change of turn, just the pane being opened — is
    // sufficient to emit the keystroke. What changed on 2026-08-12 is that it is no longer how the
    // app normally answers, because the watch gets there first. It stays as a fallback for the
    // screens the watch declines to judge (an unstamped capture, a status it does not recognise as
    // an ask), where a human is looking at a live terminal and the read is unambiguous.
    //
    // NO WATCH IS STARTED HERE, which is what makes that fallback the thing under test.
    useRuntimeStore.getState().setStatus(AGENT, "approval");
    unregister = registerScrollback(AGENT, () => PROMPT);
    renderHook(() => useSuggestions(AGENT, true));
    await settle();

    expect(keystrokes()).toBe(1);
    expect(writePty).toHaveBeenCalledWith(AGENT, "1\n");
  });
});

// ══ NOT TESTED HERE, DELIBERATELY: that a settled screen is never answered twice ═════════════════
//
// A case named "does not keep re-answering once mounted and settled" stood here and could not fail
// (roborev 63111). It re-rendered with no new props, and every dep of the reading effect is stable
// across that, so the approver was never re-invoked whether or not the de-dupe guard worked — delete
// `handledSigs` outright and it stayed green. That is the vacuous shape AGENTS.md names.
//
// IT WAS REMOVED ON MAIN AND CAME BACK IN THIS MERGE, which is the part worth recording. This branch
// was cut before that removal landed, so it carried its own copy forward and git resolved the file
// in its favour — a deletion is invisible to a side that never saw it, and nothing about the merge
// looked wrong. If you are about to re-add a "a re-render doesn't re-answer" case here, this
// paragraph is why you should not: the assertion cannot tell a working guard from an effect that
// never ran.
//
// The contract itself is real, and is covered where it can actually fail:
// `handledSigs.remount.test.tsx` drives it against the real signature set (roborev 53074 / 53159).
//
// ══ AND ON THE SETTLE WATCHER, which outlived the behaviour change ═══════════════════════════════
//
// `useSuggestions` also polls `getAgentScrollback` on a `setInterval` at `SETTLE_TICK_MS` (1200ms —
// grep the symbol, it has moved), settling after two identical hashes. That path is why an earlier
// version of this file was wrong to conclude "the MOUNT, not the registration" was the trigger:
// registration alone answered within ~2.4s. Now that `autoApproveWatch.ts` decides off captured
// screens instead, that route is no longer the founder-visible one — but the trap that hid it is
// exactly the kind that comes back, so read the next paragraph as the reason this file is shaped the
// way it is rather than as a caveat about it.
//
// THE TRAP: an interval-driven path is silently unexercised when the clock never advances, so a case
// that "proves" such a path does not fire may only be proving that no time passed. Every assertion
// here is of the form "nothing MORE was typed", which is precisely the shape that trap makes
// worthless.
//
// THE DISCHARGE, and do not undo it: this file runs on FAKE timers — `beforeEach` calls
// `vi.useFakeTimers()` and pins the clock, `afterEach` restores real ones — and the `settle()` helper
// above advances that clock deliberately, three rounds of `SETTLE_MS`, wrapping each in `act` so the
// microtask arm gets to run too. That is what makes "nothing more was typed" a real claim. An earlier
// revision of this note still described the file as running on real timers, which had by then become
// the opposite of the truth; a note that narrates a superseded state is the LOCK failure AGENTS.md
// warns about, so if you change the timer discipline, change this paragraph in the same commit.
