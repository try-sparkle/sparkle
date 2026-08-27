// AN ACK THAT MEANS DELIVERY (bead sparkle-1cu3j, filed six times).
//
// THE DEFECT. `ok` was being read as "the message reached the agent", and on one path it does not
// mean that: a send aimed at an agent whose PTY is still coming up returns `ok: true` with
// `path: "queued"` having written NOTHING. The text is parked in `services/pendingSends` until the
// pane reports ready, and the flush that eventually delivers it settles on `onDeferredSendOutcome`
// — a channel a tool caller never subscribes to. So the caller is told it succeeded, cannot tell
// otherwise without reading the pane, and a caller that retries on failure never retries.
//
// WHAT THESE ASSERT IS THE SIDE EFFECT, not the label. The queued case pins that no carriage return
// reached the PTY while `ok` was true — which is the fact `submitted` now reports — and the
// delivered case pins the opposite, so a version of `wasSubmitted` that simply returned `false`
// everywhere (or `r.ok`) fails one of the two.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SuggestionButton } from "./suggestions/types";

const h = vi.hoisted(() => ({
  paneState: vi.fn(() => "ready" as string),
  submitPrompt: vi.fn(async (_id: string, _text: string) => {}),
  writePtyChainedStrict: vi.fn(async (_id: string, _data: string) => {}),
}));

vi.mock("../pty", () => {
  class PtyGoneError extends Error {}
  return {
    writePtyChainedStrict: h.writePtyChainedStrict,
    submitPrompt: h.submitPrompt,
    PtyGoneError,
  };
});
vi.mock("./terminalScrollback", () => ({ getAgentScrollback: vi.fn(() => "SCREEN") }));
vi.mock("./suggestions/heuristics", () => ({
  detectTerminalPrompts: vi.fn(() => [] as SuggestionButton[]),
}));
vi.mock("./terminalViewport", () => ({ getAgentViewport: vi.fn(() => null) }));
vi.mock("./terminalMarkers", () => ({ markAgentPrompt: vi.fn() }));
vi.mock("./agentNaming", () => ({ maybeAutoName: vi.fn(async () => {}) }));
vi.mock("./trialMeter", () => ({
  recordTrialSend: vi.fn(async () => {}),
  trialSendAllowed: vi.fn(() => true),
}));
vi.mock("./aiGate", () => ({ aiFeatureNow: vi.fn(() => true) }));
vi.mock("./paneReadiness", () => ({ paneState: h.paneState }));
vi.mock("../stores/projectStore", () => ({
  useProjectStore: {
    getState: () => ({
      projects: [{ id: "p1", agents: [{ id: "a1", runtime: "local" }] }],
      appendPrompt: vi.fn(() => "prompt-1"),
    }),
  },
}));
vi.mock("../stores/promptHistoryStore", () => ({
  usePromptHistoryStore: { getState: () => ({ record: vi.fn() }) },
}));

import { PtyGoneError } from "../pty";
import { dispatchConciergeAnswer, wasSubmitted } from "./conciergeDispatch";
import { resetPendingSends } from "./pendingSends";

const AGENT = "a1";
const OPTS = { authority: { kind: "suggestion", agentId: AGENT } as const, userPrompt: true };

beforeEach(() => {
  resetPendingSends();
  h.paneState.mockReturnValue("ready");
  h.submitPrompt.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.clearAllMocks();
  resetPendingSends();
});

describe("a queued send is accepted but NOT delivered", () => {
  /** The agent is open, its PTY is not up yet: `paneState` says `starting` and the write rejects. */
  function ptyStillComingUp(): void {
    h.paneState.mockReturnValue("starting");
    h.submitPrompt.mockRejectedValue(new PtyGoneError("no such pty"));
  }

  it("reports ok, and `submitted: false` — nothing has been typed and entered", async () => {
    ptyStillComingUp();
    const r = await dispatchConciergeAnswer(AGENT, "rebase onto main and open the PR", OPTS);
    expect(r.ok).toBe(true);
    expect(r.path).toBe("queued");
    // THE HONEST HALF. Before this existed, `ok: true` was the whole answer a caller got.
    expect(wasSubmitted(r)).toBe(false);
  });

  // THE SIDE EFFECT ITSELF, asserted separately from the label so a result that merely SAYS
  // `submitted: false` while having written the text cannot pass. `submitPrompt` is the only
  // primitive that appends the carriage return (pty.deliverSubmit), and its rejection is what says
  // the paste never landed either.
  it("wrote no carriage return to the PTY", async () => {
    ptyStillComingUp();
    await dispatchConciergeAnswer(AGENT, "rebase onto main and open the PR", OPTS);
    expect(h.submitPrompt).toHaveBeenCalledTimes(1);
    await expect(h.submitPrompt.mock.results[0]?.value).rejects.toBeInstanceOf(PtyGoneError);
    // And the raw-keystroke primitive — the other way bytes reach a PTY — was never used at all.
    expect(h.writePtyChainedStrict).not.toHaveBeenCalled();
  });
});

describe("a delivered send says so", () => {
  it("free text reports `submitted: true`, and the submit actually ran", async () => {
    const r = await dispatchConciergeAnswer(AGENT, "rebase onto main and open the PR", OPTS);
    expect(r.ok).toBe(true);
    expect(r.path).toBe("free-text");
    expect(wasSubmitted(r)).toBe(true);
    // `submitPrompt`, not `pasteIntoPty`: the first writes the bracketed paste AND the `\r` that
    // enters it; the second deliberately stops at the paste. The bead's remedy is that the ack must
    // correspond to the first, and this is where that correspondence is pinned.
    expect(h.submitPrompt).toHaveBeenCalledWith(
      AGENT,
      "rebase onto main and open the PR",
      expect.objectContaining({ machine: expect.any(Boolean) }),
    );
  });

  // A REFUSAL IS NEVER SUBMITTED, whatever else it says. Asked through the same function so the
  // exhaustive switch is exercised rather than trusted.
  it("never claims a refusal was submitted", () => {
    for (const path of ["pty-gone", "alternate-screen", "blocked-prompt", "queue-full"] as const) {
      expect(wasSubmitted({ ok: false, path })).toBe(false);
    }
  });

  // …AND `ok` IS NOT A PROXY FOR IT. This is the case that goes red if `wasSubmitted` is ever
  // "simplified" to `r.ok`, which is exactly the equivalence the bead was filed about.
  it("is not the same question as `ok`", () => {
    expect(wasSubmitted({ ok: true, path: "queued" })).toBe(false);
    expect(wasSubmitted({ ok: true, path: "free-text" })).toBe(true);
  });
});
