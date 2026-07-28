// What a clicked recommended-action actually DOES, per kind. Shared by the two surfaces that show
// the row (the AgentPane Composer and the concierge column), and until now untested — which mattered
// more than it looks, because the three behaviours below are exactly the ones a plausible-sounding
// "make the concierge box honest" change would break.
//
// The concierge box is cross-project and its compose path is TEXT into `dispatchConciergeAnswer`.
// From that premise two rules follow, and both are WRONG for this codebase:
//
//   • "drop kind:'control' buttons, because this box's only channel into an agent is text, so a
//     control button would be silently dead." It is not dead: `applySuggestion` executes control
//     buttons ITSELF, as an app action (closeBuildAgent), touching no PTY. Dropping them would
//     REMOVE a working "Close Build Agent" from the concierge.
//   • "send a terminal button's LABEL ('Yes', '2') rather than its raw keystroke ('2\n'), because
//     that is what reads correctly in the thread and what the picker matcher works on." The matcher
//     is never involved: terminal buttons go straight to the PTY via `writePtyChainedStrict`, which is what a
//     raw-mode Ink picker actually needs. Routing the label through the text path instead would
//     hand a live picker a string to re-match — strictly more ways to mis-select. The readable
//     label is already what gets recorded for history (see the `recordPickerTurn` row below), which
//     is the concern that rule was really reaching for.
//
// These rows pin the behaviours, so a future pass that re-derives those rules from the premise
// fails here instead of shipping.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  writePtyChainedStrict: vi.fn(async () => {}),
  PtyGoneError: class PtyGoneError extends Error {},
  closeBuildAgent: vi.fn(async () => {}),
  recordEvent: vi.fn(),
  appendPrompt: vi.fn(() => "p1"),
}));

vi.mock("../../pty", () => ({
  writePtyChainedStrict: h.writePtyChainedStrict,
  PtyGoneError: h.PtyGoneError,
}));
vi.mock("../closeBuildAgent", () => ({ closeBuildAgent: h.closeBuildAgent }));
vi.mock("../terminalScrollback", () => ({ getAgentScrollback: () => "some screen" }));
vi.mock("../../stores/suggestionStore", () => ({
  useSuggestionStore: { getState: () => ({ recordEvent: h.recordEvent }) },
}));
vi.mock("../../stores/projectStore", () => ({
  useProjectStore: {
    getState: () => ({
      projects: [{ id: "proj1", agents: [{ id: "ag1" }] }],
      appendPrompt: h.appendPrompt,
    }),
  },
}));

import { applySuggestion } from "./applySuggestion";
import { closeBuildAgentButton } from "./controlButtons";
import type { SuggestionButton } from "./types";

const terminalBtn: SuggestionButton = {
  id: "heur:2 · Yes",
  label: "2 · Yes",
  value: "2\n",
  kind: "terminal",
  source: "heuristic",
};
const promptBtn: SuggestionButton = {
  id: "cta:land",
  label: "Land to Main",
  value: "Land this to main.",
  kind: "prompt",
  source: "control",
};

beforeEach(() => {
  h.writePtyChainedStrict.mockClear();
  h.closeBuildAgent.mockClear();
  h.recordEvent.mockClear();
  h.appendPrompt.mockClear();
});

describe("applySuggestion — control kind", () => {
  it("runs the APP action itself; it is not a dead button in a text-only host", () => {
    const deliverPrompt = vi.fn();
    return applySuggestion("ag1", closeBuildAgentButton(), { deliverPrompt }).then((did) => {
      expect(did).toBe(true);
      expect(h.closeBuildAgent).toHaveBeenCalledWith("ag1");
      // No PTY write and no text delivery — that is WHY it works in a host whose only message
      // channel is text.
      expect(h.writePtyChainedStrict).not.toHaveBeenCalled();
      expect(deliverPrompt).not.toHaveBeenCalled();
    });
  });

  // Not PTY-gated: it touches nothing in the terminal, so a dead terminal is irrelevant to it.
  it("is NOT vetoed by the dead-PTY gate", async () => {
    await applySuggestion("ag1", closeBuildAgentButton(), {
      deliverPrompt: vi.fn(),
      disabled: true,
    });
    expect(h.closeBuildAgent).toHaveBeenCalled();
  });

  it("records no learning event (it is an app action, not a learnable answer)", async () => {
    await applySuggestion("ag1", closeBuildAgentButton(), { deliverPrompt: vi.fn() });
    expect(h.recordEvent).not.toHaveBeenCalled();
  });
});

describe("applySuggestion — terminal kind", () => {
  // The RAW keystroke, not the label: a raw-mode Ink picker accepts the option's own value, and
  // nothing re-matches it. This is the row that fails if someone substitutes `b.label`.
  it("writes the raw keystroke to the PTY, never the label", async () => {
    await applySuggestion("ag1", terminalBtn, { deliverPrompt: vi.fn() });
    expect(h.writePtyChainedStrict).toHaveBeenCalledWith("ag1", "2\n");
    expect(h.writePtyChainedStrict).not.toHaveBeenCalledWith("ag1", "2 · Yes");
  });

  it("throws on a dead PTY — no turn, no learning, and NOT the veto value", async () => {
    // Everything after the write CLAIMS it landed: the picker turn advances the naming ladder's
    // promptCount, the learning event trains the re-ranker, and `true` tells the host to clear the
    // row the user would have retried from. It must THROW rather than return `false`, because
    // `false` means "the host vetoed this" — which hosts answer by staying quiet, since they
    // already know why. Returning it here made the click a silent dead button (roborev 54409).
    h.writePtyChainedStrict.mockRejectedValueOnce(new h.PtyGoneError("ag1"));
    await expect(
      applySuggestion("ag1", terminalBtn, { deliverPrompt: vi.fn() }),
    ).rejects.toBeInstanceOf(h.PtyGoneError);
    expect(h.appendPrompt).not.toHaveBeenCalled();
    expect(h.recordEvent).not.toHaveBeenCalled();
  });

  // …while the READABLE label is what reaches history. The "send the label" rule was reaching for
  // this concern, and it is already satisfied without touching the keystroke.
  it("records the readable LABEL as the history turn, not the keystroke", async () => {
    await applySuggestion("ag1", terminalBtn, { deliverPrompt: vi.fn() });
    expect(h.appendPrompt).toHaveBeenCalledWith("proj1", "ag1", "2 · Yes", "picker");
  });

  it("never goes through the host's text delivery path", async () => {
    const deliverPrompt = vi.fn();
    await applySuggestion("ag1", terminalBtn, { deliverPrompt });
    expect(deliverPrompt).not.toHaveBeenCalled();
  });

  it("is vetoed by the dead-PTY gate — a keystroke into nothing is not a click that did something", async () => {
    const did = await applySuggestion("ag1", terminalBtn, {
      deliverPrompt: vi.fn(),
      disabled: true,
    });
    expect(did).toBe(false);
    expect(h.writePtyChainedStrict).not.toHaveBeenCalled();
    expect(h.recordEvent).not.toHaveBeenCalled();
  });

  it("runs beforeTerminalWrite while the prompt is still on screen", async () => {
    const order: string[] = [];
    h.writePtyChainedStrict.mockImplementationOnce(async () => {
      order.push("write");
    });
    await applySuggestion("ag1", terminalBtn, {
      deliverPrompt: vi.fn(),
      beforeTerminalWrite: () => order.push("before"),
    });
    expect(order).toEqual(["before", "write"]);
  });

  it("records a learning event so the re-ranker sees the answer", async () => {
    await applySuggestion("ag1", terminalBtn, { deliverPrompt: vi.fn() });
    expect(h.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ label: "2 · Yes", value: "2\n", kind: "terminal" }),
    );
  });
});

describe("applySuggestion — prompt kind", () => {
  it("hands the full prose to the host's own delivery, never the PTY", async () => {
    const deliverPrompt = vi.fn(async () => true);
    const did = await applySuggestion("ag1", promptBtn, { deliverPrompt });
    expect(did).toBe(true);
    expect(deliverPrompt).toHaveBeenCalledWith("Land this to main.");
    expect(h.writePtyChainedStrict).not.toHaveBeenCalled();
  });

  // A veto means NOTHING happened — so teaching the re-ranker from it would poison the history with
  // an action the user never took, and clearing the row would take away the button they pressed.
  it("a vetoed delivery records nothing and reports the click as a no-op", async () => {
    const did = await applySuggestion("ag1", promptBtn, {
      deliverPrompt: vi.fn(async () => false),
    });
    expect(did).toBe(false);
    expect(h.recordEvent).not.toHaveBeenCalled();
  });

  // Anything that is not an explicit `false` counts as delivered — the chat path returns void.
  it("treats a void return as delivered", async () => {
    const did = await applySuggestion("ag1", promptBtn, { deliverPrompt: vi.fn(() => undefined) });
    expect(did).toBe(true);
    expect(h.recordEvent).toHaveBeenCalled();
  });
});
