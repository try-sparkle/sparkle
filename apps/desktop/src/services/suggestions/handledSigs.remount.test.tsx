// @vitest-environment jsdom
//
// The auto-approve de-dupe guard must survive a REMOUNT.
//
// `handledSigs` records which picker instances have already been auto-answered, so a re-rendered or
// re-settled scrollback can't re-send the keystroke. It used to be a component ref, which was fine
// while one hook instance lived for the app's lifetime. The concierge now mounts the suggestions
// row keyed by agent id (so per-agent hook state can't leak ACROSS agents), and that turned the ref
// into a bug in the other direction: tabbing to another agent and back remounted the hook with an
// empty set, so the same permission prompt still on screen was auto-approved a SECOND time — an
// extra irreversible keystroke into a live PTY (roborev 53074).
//
// The state is per-AGENT module state now. This test pins that: same agent, same screen, fresh
// mount → the guard still knows the prompt was answered.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  maybeAutoApprove: vi.fn(),
  scrollback: "",
}));

vi.mock("./approvalsRuntime", () => ({
  maybeAutoApprove: h.maybeAutoApprove,
  maybeAutoResume: vi.fn(() => null),
  maybeAutoPlan: vi.fn(() => null),
  // The FOURTH answerer. A mock that omits it makes the hook call `undefined(...)`, so leaving it
  // out does not fail as "trust is unwired" — it fails as every de-dupe case in this file throwing.
  maybeAutoTrust: vi.fn(() => null),
  useSyncProjectApprovals: () => {},
}));
vi.mock("../terminalScrollback", () => ({ getAgentScrollback: () => h.scrollback }));
vi.mock("./engine", () => ({ computeSuggestions: vi.fn(async () => ({ agentId: "a1", buttons: [] })) }));
vi.mock("../../stores/runtimeStore", () => {
  // Every agent reads as "approval" — the tests here are about the de-dupe guard's scope, not
  // about status resolution, and hardcoding one id silently made the per-agent case a no-op.
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

import {
  onRuntimeStatusChange,
  resetSuggestionMemory,
  useSuggestions,
} from "./useSuggestions";

/** Stand-in for the real guard: answers once per signature, recording into the set it is handed. */
function answerOncePerScreen(_agentId: string, scrollback: string, handled: Set<string>) {
  const sig = `sig:${scrollback}`;
  if (handled.has(sig)) return null;
  handled.add(sig);
  return "bash" as const;
}

beforeEach(() => {
  resetSuggestionMemory();
  h.scrollback = "Do you want to proceed?\n1. Yes\n2. No";
  h.maybeAutoApprove.mockReset();
  h.maybeAutoApprove.mockImplementation(answerOncePerScreen);
});
afterEach(() => cleanup());

describe("auto-approve de-dupe across remounts", () => {
  it("does not re-answer the same on-screen prompt after the hook remounts", async () => {
    const first = renderHook(() => useSuggestions("a1", true));
    await act(async () => {});
    const answeredOnFirstMount = h.maybeAutoApprove.mock.results.filter((r) => r.value).length;
    expect(answeredOnFirstMount).toBe(1);

    // Tab away and back: the concierge's keyed row unmounts and remounts this hook.
    first.unmount();
    renderHook(() => useSuggestions("a1", true));
    await act(async () => {});

    const answeredTotal = h.maybeAutoApprove.mock.results.filter((r) => r.value).length;
    expect(answeredTotal).toBe(1); // still ONE keystroke, not two
  });

  it("keeps the guard separate per agent", async () => {
    renderHook(() => useSuggestions("a1", true));
    await act(async () => {});
    cleanup();
    // A DIFFERENT agent showing an identical prompt is a different prompt; it must be answered.
    renderHook(() => useSuggestions("a2", true));
    await act(async () => {});
    expect(h.maybeAutoApprove.mock.results.filter((r) => r.value).length).toBe(2);
  });
});

// The stuck-agent path (roborev 53159). The de-dupe set outlives the component, but the only thing
// that used to CLEAR it lived in a mounted effect — so an agent that finished its turn while the
// user was looking at a different agent never got cleared. On return, its next real prompt (same
// option set → same signature) was suppressed as "already handled": nothing typed, pills hidden,
// "Auto-approved …" shown, and the agent blocked indefinitely. Returning to a blocked agent is the
// normal way users re-enter one, so this is the common path.
describe("the de-dupe set clears without a mounted component", () => {
  it("clears on the your-turn → working flip for an agent nobody is looking at", async () => {
    // A1 answers a prompt while mounted.
    const first = renderHook(() => useSuggestions("a1", true));
    await act(async () => {});
    expect(h.maybeAutoApprove.mock.results.filter((r) => r.value).length).toBe(1);
    first.unmount(); // the user switches to another agent

    // A1 finishes its turn OFF SCREEN. Nothing is mounted for it.
    act(() => onRuntimeStatusChange({ a1: "working" }));

    // A1 hits a NEW prompt with the same option set, and the user comes back.
    renderHook(() => useSuggestions("a1", true));
    await act(async () => {});
    // Answered again — a genuinely distinct prompt must not be suppressed by a stale signature.
    expect(h.maybeAutoApprove.mock.results.filter((r) => r.value).length).toBe(2);
  });

  it("does NOT clear while the agent stays in your-turn", async () => {
    renderHook(() => useSuggestions("a1", true));
    await act(async () => {});
    act(() => onRuntimeStatusChange({ a1: "approval" })); // still asking
    cleanup();
    renderHook(() => useSuggestions("a1", true));
    await act(async () => {});
    // Same screen, same turn — still one keystroke.
    expect(h.maybeAutoApprove.mock.results.filter((r) => r.value).length).toBe(1);
  });
});
