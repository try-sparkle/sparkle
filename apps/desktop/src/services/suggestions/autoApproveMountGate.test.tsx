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
// Put together: while an agent's terminal is unmounted the auto-approver is BLIND to it. The first
// mount is what makes a pending prompt visible, and the answer is typed into the PTY on that mount.
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
import { resetSuggestionMemory, useSuggestions } from "./useSuggestions";

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
    // Registering the provider WITHOUT this fresh mount is deliberately not the trigger, and an
    // earlier draft of this test asserted that it was and went red: the reading effect's dependency
    // array does not list the registry (it cannot — the registry is a module-level Map, not
    // reactive state), so a bare re-render of a hook that is already up re-runs nothing. That is
    // worth stating because it locates the trigger precisely: it is the MOUNT, not the registration.
    unregister = registerScrollback("a1", () => PROMPT);
    renderHook(() => useSuggestions("a1", true));
    await act(async () => {});

    // …and the keystroke goes into the PTY. This is the write the founder saw as "clicking a pane
    // auto-ran a waiting bash command", and it is why ~half of his clicks were followed within a
    // second by an approval he never read.
    expect(answers()).toBe(1);
  });

  it("does not keep re-answering once mounted and settled", async () => {
    unregister = registerScrollback("a1", () => PROMPT);
    const view = renderHook(() => useSuggestions("a1", true));
    await act(async () => {});
    expect(answers()).toBe(1);

    // Repaints, re-renders and re-fits all happen constantly on a visible pane; none of them is a
    // new decision. Only the FIRST sight of a given screen may type.
    view.rerender();
    await act(async () => {});
    view.rerender();
    await act(async () => {});
    expect(answers()).toBe(1);
  });
});
