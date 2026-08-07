// @vitest-environment jsdom
//
// The three answers this predicate can give, each of which a focus guard acts on differently. The
// component-level pin for what the app then DOES with them is
// `components/Concierge/ComposeBox.focusSteal.test.tsx`.
import { afterEach, describe, expect, it } from "vitest";
import { terminalHoldsUnsentInput } from "./terminalMidCommand";
import { useTerminalOverlayStore } from "../stores/terminalOverlayStore";
import { TERMINAL_AGENT_ATTR, TERMINAL_SURFACE_ATTR } from "../voice/dictationFocus";

const AGENT = "agent-1";
let planted: HTMLElement[] = [];

afterEach(() => {
  planted.forEach((n) => n.remove());
  planted = [];
  useTerminalOverlayStore.setState({ drafts: {} });
});

/** The key sink inside the wrapper `Terminal.tsx` renders — both attributes on one element, as there. */
function terminalSink(agentId: string | null): HTMLTextAreaElement {
  const host = document.createElement("div");
  host.setAttribute(TERMINAL_SURFACE_ATTR, "");
  if (agentId) host.setAttribute(TERMINAL_AGENT_ATTR, agentId);
  const ta = document.createElement("textarea");
  ta.className = "xterm-helper-textarea";
  host.appendChild(ta);
  document.body.appendChild(host);
  planted.push(host);
  return ta;
}

describe("terminalHoldsUnsentInput", () => {
  it("is true when the focused terminal's CLI prompt holds an unsubmitted line", () => {
    const sink = terminalSink(AGENT);
    useTerminalOverlayStore.getState().setDraft(AGENT, true);

    expect(terminalHoldsUnsentInput(sink)).toBe(true);
  });

  it("is FALSE at an empty prompt — a terminal holding the caret is not evidence of anything", () => {
    // The whole point of the store term. In a terminal-first shell this is the resting state, so a
    // predicate that answered `true` here would decline every legitimate compose-focus pull.
    const sink = terminalSink(AGENT);

    expect(terminalHoldsUnsentInput(sink)).toBe(false);
  });

  it("reads the draft of the terminal it was HANDED, not of some other agent's", () => {
    const sink = terminalSink(AGENT);
    useTerminalOverlayStore.getState().setDraft("a-different-agent", true);

    expect(terminalHoldsUnsentInput(sink)).toBe(false);
  });

  it("is true for a terminal it cannot name (fail-safe)", () => {
    // Matched by xterm's classes but carrying no agent id — nothing to look a draft up by. Answering
    // "idle" there would take the caret on no evidence at all.
    const bare = document.createElement("textarea");
    bare.className = "xterm-helper-textarea";
    document.body.appendChild(bare);
    planted.push(bare);

    expect(terminalHoldsUnsentInput(bare)).toBe(true);
  });

  it("is false for anything that is not a terminal, whatever it holds", () => {
    // Ordinary editables are the OTHER term's business (`isTypingInProgress`); this one must not
    // answer for them, or the two terms would double up and a text field would veto twice.
    const input = document.createElement("input");
    input.value = "renaming this";
    document.body.appendChild(input);
    planted.push(input);
    useTerminalOverlayStore.getState().setDraft(AGENT, true);

    expect(terminalHoldsUnsentInput(input)).toBe(false);
    expect(terminalHoldsUnsentInput(null)).toBe(false);
    expect(terminalHoldsUnsentInput(undefined)).toBe(false);
  });
});
