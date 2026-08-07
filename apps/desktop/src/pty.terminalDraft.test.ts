// @vitest-environment jsdom
//
// THE WRITER GAP, pinned from both ends (roborev 59689).
//
// `terminalOverlayStore.drafts[agentId]` answers "does this agent's CLI prompt hold an unsubmitted
// line". Its scanner-side writer is xterm's `onData`, which sees ONLY what the user types — so every
// write this app makes to the same input line is invisible to it, and the flag desyncs in both
// directions. Each direction reproduces one of the two bugs the compose-focus veto already went
// through:
//
//   • a paste that is never published reads as an IDLE terminal, so the caret is pulled out of a
//     prompt holding words the dictation sink just typed into it — sparkle-d2ec's own symptom;
//   • a submit that is never published leaves a stale `true`, so every compose-focus pull with the
//     caret in that terminal is declined for as long as it lasts — the roborev 59610 High.
//
// So these assert through `terminalHoldsUnsentInput` — the predicate the veto actually calls — and
// not merely that a store key changed. The store is the seam; the VETO is the behaviour.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { pasteIntoPty, submitPrompt, PtyGoneError } from "./pty";
import { useTerminalOverlayStore } from "./stores/terminalOverlayStore";
import { terminalHoldsUnsentInput } from "./services/terminalMidCommand";
import { TERMINAL_AGENT_ATTR, TERMINAL_SURFACE_ATTR } from "./voice/dictationFocus";

const AGENT = "a1";
let planted: HTMLElement[] = [];

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  useTerminalOverlayStore.setState({ drafts: {} });
});

afterEach(() => {
  planted.forEach((n) => n.remove());
  planted = [];
  useTerminalOverlayStore.setState({ drafts: {} });
});

/** The key sink inside the wrapper `Terminal.tsx` renders for this agent. */
function sinkFor(agentId: string): HTMLTextAreaElement {
  const host = document.createElement("div");
  host.setAttribute(TERMINAL_SURFACE_ATTR, "");
  host.setAttribute(TERMINAL_AGENT_ATTR, agentId);
  const ta = document.createElement("textarea");
  ta.className = "xterm-helper-textarea";
  host.appendChild(ta);
  document.body.appendChild(host);
  planted.push(host);
  return ta;
}

describe("pasteIntoPty publishes the line it just filled", () => {
  it("makes the focus veto see unsent input — the dictation sink types without submitting", async () => {
    const sink = sinkFor(AGENT);
    expect(terminalHoldsUnsentInput(sink)).toBe(false); // precondition: an idle prompt

    await pasteIntoPty(AGENT, "deploy the thing");

    expect(terminalHoldsUnsentInput(sink)).toBe(true);
  });

  it("claims nothing for a whitespace-only paste", async () => {
    // `hasPendingInput` counts a non-whitespace line, so a blank paste is not a pending line either.
    const sink = sinkFor(AGENT);

    await pasteIntoPty(AGENT, "   \n");

    expect(terminalHoldsUnsentInput(sink)).toBe(false);
  });

  it("claims nothing when the paste never landed", async () => {
    // A dead PTY rejects. Publishing before the write would assert a prompt state that no process
    // ever received — the flag has to follow the write, not the intent.
    const sink = sinkFor(AGENT);
    invoke.mockRejectedValueOnce(new Error("no such pty"));

    await expect(pasteIntoPty(AGENT, "deploy the thing")).rejects.toBeInstanceOf(PtyGoneError);

    expect(terminalHoldsUnsentInput(sink)).toBe(false);
  });

  it("does not answer for a DIFFERENT agent's terminal", async () => {
    const other = sinkFor("a2");

    await pasteIntoPty(AGENT, "deploy the thing");

    expect(terminalHoldsUnsentInput(other)).toBe(false);
  });
});

describe("a programmatic submit publishes the line it just emptied", () => {
  it("releases the veto after the carriage return", async () => {
    // The stale-`true` direction: the user had half a command typed (so the scanner recorded a
    // pending line), then a concierge send submitted the whole line. The prompt is empty now — but
    // the scanner never saw the CR, so without this the flag stays true until the terminal unmounts
    // and the capture-window handoff can never deliver the caret to the draft it staged.
    const sink = sinkFor(AGENT);
    useTerminalOverlayStore.getState().setDraft(AGENT, true);
    expect(terminalHoldsUnsentInput(sink)).toBe(true);

    vi.useFakeTimers();
    try {
      const p = submitPrompt(AGENT, "ship it", { machine: false });
      await vi.runAllTimersAsync();
      await p;
    } finally {
      vi.useRealTimers();
    }

    expect(terminalHoldsUnsentInput(sink)).toBe(false);
  });

  it("leaves the flag alone when the PTY died before the carriage return", async () => {
    // Nothing was submitted, so the user's pending line is still pending. Clearing on intent rather
    // than on the CR would hand the caret away from a prompt that still holds their text.
    const sink = sinkFor(AGENT);
    useTerminalOverlayStore.getState().setDraft(AGENT, true);
    invoke.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("no such pty"));

    vi.useFakeTimers();
    try {
      const p = submitPrompt(AGENT, "ship it", { machine: false });
      const assertion = expect(p).rejects.toBeInstanceOf(PtyGoneError);
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }

    expect(terminalHoldsUnsentInput(sink)).toBe(true);
  });
});
