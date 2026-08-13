// @vitest-environment jsdom
//
// THE MOUNT IS THE TRIGGER — a permission prompt raised while you were looking elsewhere is
// auto-answered at the moment you LOOK AT IT, not at the moment it appeared.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────────
// The founder reported it as a P0 in these words: *"clicking an agent pane auto-runs a waiting bash
// command — a click may be silently answering permission prompts."* The question he asked first was
// whether that is a real PTY write or a repaint-only artefact. It is a real write, and this file is
// the executable half of the answer.
//
// Measured from one day of production logs before this test was written: of 325 pane switches, 96
// were followed within ONE SECOND by an auto-approve keystroke (~24x the rate expected from the
// day's base rate of such writes) and 151 within two seconds — so roughly half of every click, and
// ~49% of all 310 auto-approve decisions that day, landed in the window right after a click. The
// nudger's own writes showed no such enrichment (1.2x), which is what rules out "the app is just
// busy after a switch" as the explanation.
//
// ── THE MECHANISM, WHICH IS A GATE AND NOT A RACE ───────────────────────────────────────────────
// `services/terminalScrollback` says it outright: the in-memory xterm buffer is "the only history
// that exists", and a provider is registered only "while the agent's terminal is mounted"
// (`Terminal.tsx` registers on mount, unregisters on unmount). `useSuggestions` reads through it and
// bails on `if (!scrollback) return;` WITHOUT committing `lastHash` — deliberately, so the hash is
// still fresh whenever content does show up.
//
// Put together: while an agent's terminal is unmounted the auto-approver is BLIND to it. Making the
// provider available is what makes a pending prompt readable, and the answer follows.
//
// ── TWO ROUTES REACH THE KEYSTROKE, AND AN EARLIER VERSION OF THIS FILE NAMED ONLY ONE ───────────
// This header used to conclude "it is the MOUNT, not the registration", on the strength of a draft
// case that registered the provider under an already-mounted hook and went red. That conclusion was
// WRONG, and the way it was wrong is worth keeping, because it is the failure mode this whole file
// is about: the draft went red only because these tests run on REAL timers and finish in
// milliseconds, so `useSuggestions`' settle watcher — a `setInterval` at `SETTLE_TICK_MS` (1200ms,
// `useSuggestions.ts:961`) that calls `getAgentScrollback` on every tick — never got to run. That is
// a property of the harness, not of the code (roborev 63111).
//
// Both routes are pinned below:
//   1. MOUNT with a provider already available — the compute effect reads it on its first pass.
//   2. REGISTRATION under a hook that is already mounted — the settle watcher sees the provider on
//      its next tick, settles after two identical hashes, finds `h !== lastHash.current` (still
//      null, because the `!scrollback` bail never committed it) and bumps `retryTick`.
// Route 2 needs no click at all once a pane is open, and a reader who believed the old conclusion
// would go looking for a fix in mount ordering and never find it.
//
// ── WHY THE REST OF THIS DIRECTORY CANNOT CATCH IT ──────────────────────────────────────────────
// Every sibling suite does `vi.mock("../terminalScrollback", () => ({ getAgentScrollback: () => … }))`
// — a stub that returns content unconditionally, i.e. a world where the terminal is ALWAYS mounted.
// That is a reasonable thing to stub when you are testing the de-dupe guard, but it means the gate
// itself is invisible to all of them: they cannot distinguish "answered because a prompt appeared"
// from "answered because a pane was mounted", because in their world the two always coincide.
// SO THIS FILE DELIBERATELY DOES NOT MOCK THAT MODULE. It drives the real registry, which is the
// only way the unmounted state is representable at all.
//
// ── WHAT THIS PINS, AND WHAT IT DOES NOT ────────────────────────────────────────────────────────
// It pins the CAUSAL CLAIM ONLY — that mounting, with no new output and no change of turn, is
// sufficient to emit the keystroke. It takes NO position on whether that is desirable: the founder
// has not yet decided whether an unread prompt should be auto-answerable on sight. If that policy
// changes, the second test here is the one that should go red first, and its expectation should be
// changed with the new decision recorded — do not delete it, and see the note in
// `Concierge/MountedAgentThread.tsx` on why a superseded contract comment is a lock rather than
// documentation.
//
// Related prior art, both narrower halves of this same surface: roborev 53074 (a remount re-answered
// an ALREADY-answered prompt — fixed by making `handledSigs` per-agent module state) and roborev
// 53159 (the de-dupe set outliving a turn suppressed a genuinely new prompt). Both are about the
// SECOND answer. This is about the FIRST one.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ maybeAutoApprove: vi.fn() }));

vi.mock("./approvalsRuntime", () => ({
  maybeAutoApprove: h.maybeAutoApprove,
  maybeAutoResume: vi.fn(() => null),
  useSyncProjectApprovals: () => {},
}));
vi.mock("./engine", () => ({
  computeSuggestions: vi.fn(async () => ({ agentId: "a1", buttons: [] })),
}));
vi.mock("../../stores/runtimeStore", () => {
  // Every agent reads as "approval" (i.e. it is your turn, a prompt is up) — this file is about
  // WHEN the answer is emitted, not about how the status is resolved.
  const state = {
    status: new Proxy({}, { get: () => "approval" }) as Record<string, string>,
    workflowShipped: {},
    workflowStage: {},
    workflowState: {},
    branchStatus: {},
  };
  return {
    useRuntimeStore: Object.assign((sel: (s: unknown) => unknown) => sel(state), {
      getState: () => state,
    }),
  };
});

// NOT MOCKED, on purpose (see the header): this is the module that holds the gate.
import { registerScrollback } from "../terminalScrollback";
import { SETTLE_TICK_MS, resetSuggestionMemory, useSuggestions } from "./useSuggestions";

/** The screen a real permission prompt presents. */
const PROMPT = "Do you want to proceed?\n1. Yes\n2. No";

/** Stand-in for the real guard: answers once per distinct screen, recording into the handed set. */
function answerOncePerScreen(_agentId: string, scrollback: string, handled: Set<string>) {
  const sig = `sig:${scrollback}`;
  if (handled.has(sig)) return null;
  handled.add(sig);
  return "bash" as const;
}

/** How many times the approver actually decided to type something. */
const answers = () => h.maybeAutoApprove.mock.results.filter((r) => r.value).length;

let unregister: (() => void) | null = null;

beforeEach(() => {
  resetSuggestionMemory();
  h.maybeAutoApprove.mockReset();
  h.maybeAutoApprove.mockImplementation(answerOncePerScreen);
});
afterEach(() => {
  unregister?.();
  unregister = null;
  cleanup();
});

describe("the auto-approve keystroke is gated on the terminal being mounted", () => {
  it("does not answer a pending prompt while the agent's terminal is unmounted", async () => {
    // The agent is sitting at a permission prompt RIGHT NOW — it is its turn, per the runtime store
    // above — but nobody has opened its pane, so no scrollback provider is registered for it.
    renderHook(() => useSuggestions("a1", true));
    await act(async () => {});

    // Nothing is typed, because nothing can even READ the prompt. This is the state the founder's
    // agents sit in whenever he is looking at a different pane.
    expect(answers()).toBe(0);
  });

  it("answers on MOUNT ALONE — no new output, no change of turn, just the pane being opened", async () => {
    // The pane is CLOSED. Nothing is registered and nothing is mounted for this agent, so the
    // pending prompt is unreadable and unanswerable.
    const closed = renderHook(() => useSuggestions("a1", true));
    await act(async () => {});
    expect(answers()).toBe(0);
    closed.unmount();

    // THE CLICK, modelled as the app actually performs it: opening a pane mounts `Terminal` (which
    // registers the scrollback provider) AND the suggestions row together. Note what does NOT
    // change across this line — the prompt is the same prompt, already on screen, unchanged; no PTY
    // output has arrived; the agent's status has not moved. The pane opening is the whole of it.
    //
    // ROUTE 1: the compute effect reads the provider on its first pass after mounting.
    unregister = registerScrollback("a1", () => PROMPT);
    renderHook(() => useSuggestions("a1", true));
    await act(async () => {});

    // …and the keystroke goes into the PTY. This is the write the founder saw as "clicking a pane
    // auto-ran a waiting bash command", and it is why ~half of his clicks were followed within a
    // second by an approval he never read.
    expect(answers()).toBe(1);
  });

  it("ROUTE 2: answers with NO remount at all, once the settle watcher's interval runs", async () => {
    // The distinction this case exists for: the hook stays mounted THROUGHOUT. Nothing re-mounts,
    // nothing re-renders with new props. The only event is a provider becoming available, which is
    // what happens when a terminal registers beside an already-open suggestions row.
    vi.useFakeTimers();
    try {
      renderHook(() => useSuggestions("a1", true));
      await act(async () => {});
      expect(answers()).toBe(0); // blind: no provider yet

      unregister = registerScrollback("a1", () => PROMPT);

      // The watcher needs two identical hashes to call the screen settled, so one tick is not
      // enough — this is why a real-timer test that finishes in milliseconds sees nothing and can
      // be misread as proof that this route does not exist.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SETTLE_TICK_MS * 3);
      });

      expect(answers()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// NOT TESTED HERE, DELIBERATELY: that a settled screen is never answered twice.
//
// A case for it lived here and could not fail (roborev 63111). It re-rendered with no new props,
// and the reading effect's deps are all stable across that, so `maybeAutoApprove` was never
// re-invoked whether or not the de-dupe guard worked; independently, the stand-in below de-dupes on
// its own set, so the count would have stayed at 1 even if the effect HAD re-run. Deleting
// `handledSigs` outright left it green — the vacuous shape AGENTS.md names.
//
// It cannot be repaired in this file either: `maybeAutoApprove` is mocked here, so the real
// de-dupe lives in code this suite does not execute. `handledSigs.remount.test.tsx` drives that
// contract against the real signature set (roborev 53074 / 53159) and is where it belongs.
