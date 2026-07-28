// @vitest-environment jsdom
//
// The composer's prompt side-effects, re-homed (bead sparkle-qd80 / CM-U7). Removing the
// terminal-adjacent composer must not lose what it did around a send: record the prompt
// (appendPrompt), drop the jump-to-prompt terminal marker (markPrompt), auto-name from the work
// (maybeAutoName), feed the ghost-text history and debit one free-trial prompt. They now run on the
// concierge dispatch path — and only for a genuine USER prompt (`{ authority: TEST_AUTHORITY, userPrompt: true }`), so the
// nudge card's machine-authored "approve" fallback can't rename an agent or spend a trial prompt.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SuggestionButton } from "./suggestions/types";

vi.mock("../pty", () => {
  class PtyGoneError extends Error {}
  return { writePty: vi.fn(async () => {}), submitPrompt: vi.fn(async () => {}), PtyGoneError };
});
vi.mock("./terminalScrollback", () => ({ getAgentScrollback: vi.fn(() => "SCREEN") }));
vi.mock("./suggestions/heuristics", () => ({
  detectTerminalPrompts: vi.fn(() => [] as SuggestionButton[]),
}));

const maybeAutoName = vi.fn();
vi.mock("./agentNaming", () => ({ maybeAutoName: (...a: unknown[]) => maybeAutoName(...a) }));

const recordTrialSend = vi.fn(async () => {});
const trialSendAllowed = vi.fn(() => true);
vi.mock("./trialMeter", () => ({
  recordTrialSend: () => recordTrialSend(),
  trialSendAllowed: () => trialSendAllowed(),
}));

const aiFeatureNow = vi.fn((_key?: string) => true);
vi.mock("./aiGate", () => ({ aiFeatureNow: (k: string) => aiFeatureNow(k) }));

import { submitPrompt, writePty } from "../pty";
import { detectTerminalPrompts } from "./suggestions/heuristics";
import {
  abandonPendingSends,
  dispatchConciergeAnswer,
  flushPendingSends,
  isTerseAnswer,
  onDeferredSendOutcome,
} from "./conciergeDispatch";
import { registerPromptMarker, resetPromptMarkers } from "./terminalMarkers";
import { pendingSendCount, queuePendingSend, resetPendingSends, MAX_PER_AGENT } from "./pendingSends";
import { resetPaneReadiness, setPaneFailed, setPaneReady } from "./paneReadiness";
import { useProjectStore } from "../stores/projectStore";
import { usePromptHistoryStore } from "../stores/promptHistoryStore";
import type { AgentTab, Project } from "../types";

/** Any valid authority. These suites predate the dispatch authority gate and exercise DELIVERY,
 *  not authorization — the gate itself is covered by dispatchAuthority.test.ts and
 *  conciergeDispatch.gate.test.ts. `authority` is required and non-defaulted (see
 *  services/dispatchAuthority), so every call has to name one. */
const TEST_AUTHORITY = { kind: "suggestion", agentId: "a1" } as const;

function mkAgent(id: string): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,  };
}
const project: Project = {
  id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: null,
  createdAt: new Date(0).toISOString(), selectedAgentId: null, agents: [mkAgent("a1")],
};

const promptsOf = (agentId: string) =>
  useProjectStore.getState().projects.flatMap((p) => p.agents).find((a) => a.id === agentId)
    ?.promptHistory ?? [];

beforeEach(() => {
  vi.clearAllMocks();
  aiFeatureNow.mockReturnValue(true);
  trialSendAllowed.mockReturnValue(true);
  (detectTerminalPrompts as unknown as ReturnType<typeof vi.fn>).mockReturnValue([]);
  resetPromptMarkers();
  resetPendingSends();
  resetPaneReadiness();
  usePromptHistoryStore.setState({ history: [] });
  useProjectStore.setState({ projects: [structuredClone(project)], selectedProjectId: "p1" } as never);
});

describe("dispatchConciergeAnswer — re-homed composer side-effects", () => {
  // The cloud-agent refusal (this branch called it "cloud-unsupported", main "cloud-agent" — the
  // same guard, converged independently) lives in the "cloud agents have no local PTY" describe at
  // the bottom of this file: ONE copy, the strongest of the three that the merge left behind, which
  // also pins that the screen is never read and nothing is charged (roborev 51593/51594).
  it("records the delivered prompt in the agent's history", async () => {
    await dispatchConciergeAnswer("a1", "ship the docs pass", { authority: TEST_AUTHORITY, userPrompt: true });
    const history = promptsOf("a1");
    expect(history.map((h) => h.text)).toContain("ship the docs pass");
    expect(useProjectStore.getState().projects[0]!.agents[0]!.lastPrompt).toBe("ship the docs pass");
  });

  it("drops a terminal marker under the recorded prompt's id (jump-to-prompt keeps working)", async () => {
    const mark = vi.fn();
    registerPromptMarker("a1", mark);
    await dispatchConciergeAnswer("a1", "ship the docs pass", { authority: TEST_AUTHORITY, userPrompt: true });
    const recorded = promptsOf("a1").at(-1);
    expect(recorded).toBeTruthy();
    expect(mark).toHaveBeenCalledWith(recorded!.id);
  });

  it("auto-names from the prompt when the autoRename feature is on", async () => {
    await dispatchConciergeAnswer("a1", "  ship the docs pass  ", { authority: TEST_AUTHORITY, userPrompt: true });
    expect(maybeAutoName).toHaveBeenCalledWith("p1", "a1", "ship the docs pass");
  });

  it("does NOT auto-name when the autoRename feature is off", async () => {
    aiFeatureNow.mockReturnValue(false);
    await dispatchConciergeAnswer("a1", "ship the docs pass", { authority: TEST_AUTHORITY, userPrompt: true });
    expect(maybeAutoName).not.toHaveBeenCalled();
    // …but the prompt is still recorded — naming is the only thing the flag gates.
    expect(promptsOf("a1").map((h) => h.text)).toContain("ship the docs pass");
  });

  it("debits exactly one free-trial prompt per delivered prompt", async () => {
    await dispatchConciergeAnswer("a1", "one", { authority: TEST_AUTHORITY, userPrompt: true });
    expect(recordTrialSend).toHaveBeenCalledTimes(1);
  });

  it("records a PICKER answer as source \"picker\" — no marker, no meter, no naming", async () => {
    // The composer did `appendPrompt(..., "picker")` and components/promptHistory.ts's contract is
    // "hidden from every DISPLAY surface, still counted by the naming ladder's promptCount".
    // Recording nothing at all would silently change the auto-naming cadence.
    (detectTerminalPrompts as unknown as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "1", label: "Yes", value: "y\n", kind: "terminal", source: "heuristic" },
      { id: "2", label: "No", value: "n\n", kind: "terminal", source: "heuristic" },
    ]);
    const mark = vi.fn();
    registerPromptMarker("a1", mark);
    const r = await dispatchConciergeAnswer("a1", "yes", { authority: TEST_AUTHORITY, userPrompt: true });
    expect(r.path).toBe("picker-option");
    const history = promptsOf("a1");
    expect(history).toHaveLength(1);
    expect(history[0]!.source).toBe("picker");
    expect(history[0]!.text).toBe("Yes");
    expect(mark).not.toHaveBeenCalled();
    expect(recordTrialSend).not.toHaveBeenCalled();
    expect(maybeAutoName).not.toHaveBeenCalled();
  });

  it("keeps picker answers out of the DISPLAY surfaces (composerPrompts filters them)", async () => {
    await dispatchConciergeAnswer("a1", "the real request", { authority: TEST_AUTHORITY, userPrompt: true });
    (detectTerminalPrompts as unknown as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "1", label: "Unlisted — direct link only", value: "1\n", kind: "terminal", source: "heuristic" },
    ]);
    await dispatchConciergeAnswer("a1", "1", { authority: TEST_AUTHORITY, userPrompt: true });
    const { composerPrompts } = await import("../components/promptHistory");
    expect(promptsOf("a1")).toHaveLength(2);
    expect(composerPrompts(promptsOf("a1")).map((e) => e.text)).toEqual(["the real request"]);
  });

  it("records nothing when the send FAILED (a dead PTY is never charged or logged)", async () => {
    const { PtyGoneError } = await import("../pty");
    (submitPrompt as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new (PtyGoneError as unknown as new () => Error)(),
    );
    const r = await dispatchConciergeAnswer("a1", "never lands", { authority: TEST_AUTHORITY, userPrompt: true });
    expect(r.ok).toBe(false);
    expect(r.path).toBe("pty-gone");
    expect(promptsOf("a1")).toHaveLength(0);
    expect(recordTrialSend).not.toHaveBeenCalled();
    expect(maybeAutoName).not.toHaveBeenCalled();
  });

  it("still delivers when the agent has no mounted terminal to mark (best-effort marker)", async () => {
    const r = await dispatchConciergeAnswer("a1", "no pane mounted", { authority: TEST_AUTHORITY, userPrompt: true });
    expect(r.ok).toBe(true);
    expect(promptsOf("a1").map((h) => h.text)).toContain("no pane mounted");
  });

  it("still delivers for an agent that belongs to no known project", async () => {
    const r = await dispatchConciergeAnswer("orphan", "hello", { authority: TEST_AUTHORITY, userPrompt: true });
    expect(r.ok).toBe(true);
    expect(maybeAutoName).not.toHaveBeenCalled();
  });

  it("feeds the ghost-text prompt history with the trimmed text", async () => {
    await dispatchConciergeAnswer("a1", "  wire the webhook  ", { authority: TEST_AUTHORITY, userPrompt: true });
    expect(usePromptHistoryStore.getState().history).toEqual(["wire the webhook"]);
    // …and the recorded history entry is trimmed too, so the pinned header and the naming basis
    // read the same string.
    expect(promptsOf("a1").at(-1)!.text).toBe("wire the webhook");
  });
});

describe("dispatchConciergeAnswer — side-effects are OPT-IN (the nudge Approve fallback)", () => {
  it("delivers machine-authored free text with NO history, meter, marker or rename", async () => {
    const mark = vi.fn();
    registerPromptMarker("a1", mark);
    // This is the Approve fallback: the picker scrolled off, so "approve" goes as free text.
    const r = await dispatchConciergeAnswer("a1", "approve", { authority: TEST_AUTHORITY });
    expect(r.ok).toBe(true);
    expect(r.path).toBe("free-text");
    expect(submitPrompt).toHaveBeenCalledWith("a1", "approve");
    expect(promptsOf("a1")).toHaveLength(0);
    expect(mark).not.toHaveBeenCalled();
    expect(recordTrialSend).not.toHaveBeenCalled();
    expect(maybeAutoName).not.toHaveBeenCalled();
    expect(usePromptHistoryStore.getState().history).toEqual([]);
  });

  it("an explicit userPrompt: false is the same as omitting it", async () => {
    await dispatchConciergeAnswer("a1", "approve", { authority: TEST_AUTHORITY, userPrompt: false });
    expect(promptsOf("a1")).toHaveLength(0);
    expect(recordTrialSend).not.toHaveBeenCalled();
  });
});

describe("dispatchConciergeAnswer — the free-trial PRE-SEND gate", () => {
  it("refuses BEFORE delivery when the server says the trial is spent", async () => {
    trialSendAllowed.mockReturnValue(false);
    const r = await dispatchConciergeAnswer("a1", "one more thing", { authority: TEST_AUTHORITY, userPrompt: true });
    expect(r.ok).toBe(false);
    expect(r.path).toBe("trial-spent");
    expect(submitPrompt).not.toHaveBeenCalled();
    // Refused, so nothing is debited and nothing is recorded.
    expect(recordTrialSend).not.toHaveBeenCalled();
    expect(promptsOf("a1")).toHaveLength(0);
  });

  it("does NOT gate a MACHINE relay — an uncharged send is not a paywall surface", async () => {
    // The debit is scoped to userPrompt, so the gate is too: blocking a keystroke we deliberately
    // never charge would paywall the nudge Approve button for no revenue.
    trialSendAllowed.mockReturnValue(false);
    const r = await dispatchConciergeAnswer("a1", "approve", { authority: TEST_AUTHORITY });
    expect(r.ok).toBe(true);
    expect(r.path).toBe("free-text");
  });

  it("does NOT gate a picker ANSWER (answering a live prompt isn't a new send)", async () => {
    trialSendAllowed.mockReturnValue(false);
    (detectTerminalPrompts as unknown as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "1", label: "Yes", value: "y\n", kind: "terminal", source: "heuristic" },
    ]);
    const r = await dispatchConciergeAnswer("a1", "yes", { authority: TEST_AUTHORITY, userPrompt: true });
    expect(r.ok).toBe(true);
    expect(r.path).toBe("picker-option");
  });
});

describe("dispatchConciergeAnswer — queueing a prompt for a PTY that isn't up yet", () => {
  async function rejectPtyGoneOnce() {
    const { PtyGoneError } = await import("../pty");
    (submitPrompt as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new (PtyGoneError as unknown as new () => Error)(),
    );
  }

  it("queues (not drops) a prompt for an agent whose pane is mounting", async () => {
    setPaneReady("a1", false); // the pane is mounted, its PTY hasn't come up yet
    await rejectPtyGoneOnce();
    const r = await dispatchConciergeAnswer("a1", "start on the docs", { authority: TEST_AUTHORITY, userPrompt: true });
    expect(r.ok).toBe(true);
    expect(r.path).toBe("queued");
    expect(pendingSendCount("a1")).toBe(1);
    // Nothing is charged or recorded until it actually lands.
    expect(recordTrialSend).not.toHaveBeenCalled();
    expect(promptsOf("a1")).toHaveLength(0);
  });

  it("NEVER queues for a pane that already gave up — fails truthfully instead (roborev 46924)", async () => {
    // The abandon effect covers holds that existed when the pane failed; this covers the prompt
    // sent AFTER it settled into error/no-claude. Queuing here would promise a delivery that
    // nothing will ever flush — the dangle the failed state exists to prevent.
    setPaneFailed("a1");
    await rejectPtyGoneOnce();
    const r = await dispatchConciergeAnswer("a1", "start on the docs", { authority: TEST_AUTHORITY, userPrompt: true });
    expect(r.ok).toBe(false);
    expect(r.path).toBe("agent-failed"); // its own path: the remedy is Retry, not "start it again"
    expect(pendingSendCount("a1")).toBe(0);
  });

  it("MID-FLIGHT failure: pane flips to failed during the await → agent-failed, nothing queued (roborev 47226)", async () => {
    // The race the post-await re-read exists for: `starting` when the user hits Send, prepare()
    // fails while submitPrompt is in flight. The stale `wasStarting` alone would queue onto a
    // pane whose flush will never run.
    setPaneReady("a1", false);
    const { PtyGoneError } = await import("../pty");
    (submitPrompt as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      setPaneFailed("a1"); // prepare() gave up while the send was in flight
      throw new (PtyGoneError as unknown as new () => Error)();
    });
    const r = await dispatchConciergeAnswer("a1", "start on the docs", { authority: TEST_AUTHORITY, userPrompt: true });
    expect(r.ok).toBe(false);
    expect(r.path).toBe("agent-failed");
    expect(pendingSendCount("a1")).toBe(0);
  });

  it("MID-FLIGHT unmount: pane unregisters during the await → pty-gone, nothing queued", async () => {
    setPaneReady("a1", false);
    const { PtyGoneError } = await import("../pty");
    const { unregisterPane } = await import("./paneReadiness");
    (submitPrompt as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      unregisterPane("a1"); // the pane closed for good while the send was in flight
      throw new (PtyGoneError as unknown as new () => Error)();
    });
    const r = await dispatchConciergeAnswer("a1", "start on the docs", { authority: TEST_AUTHORITY, userPrompt: true });
    expect(r.ok).toBe(false);
    expect(r.path).toBe("pty-gone");
    expect(pendingSendCount("a1")).toBe(0);
  });

  it("a Retry that republishes readiness makes the same prompt queue again", async () => {
    setPaneFailed("a1");
    setPaneReady("a1", false); // Retry re-entered the prepare flow: mounting again
    await rejectPtyGoneOnce();
    const r = await dispatchConciergeAnswer("a1", "start on the docs", { authority: TEST_AUTHORITY, userPrompt: true });
    expect(r.path).toBe("queued");
    expect(pendingSendCount("a1")).toBe(1);
  });

  it("flushes the queue once the pane reports ready, with the side-effects it was queued with", async () => {
    setPaneReady("a1", false); // the pane is mounted, its PTY hasn't come up yet
    await rejectPtyGoneOnce();
    await dispatchConciergeAnswer("a1", "start on the docs", { authority: TEST_AUTHORITY, userPrompt: true });
    const results = await flushPendingSends("a1");
    expect(results.map((r) => r.path)).toEqual(["free-text"]);
    expect(submitPrompt).toHaveBeenLastCalledWith("a1", "start on the docs");
    expect(promptsOf("a1").map((h) => h.text)).toContain("start on the docs");
    expect(recordTrialSend).toHaveBeenCalledTimes(1);
    expect(pendingSendCount("a1")).toBe(0);
  });

  it("refuses with 'queue-full' — not 'pty-gone' — once the hold queue is at its cap", async () => {
    setPaneReady("a1", false);
    for (let i = 0; i < MAX_PER_AGENT; i++) {
      await rejectPtyGoneOnce();
      expect((await dispatchConciergeAnswer("a1", `hold ${i}`, { authority: TEST_AUTHORITY, userPrompt: true })).path).toBe("queued");
    }
    await rejectPtyGoneOnce();
    const r = await dispatchConciergeAnswer("a1", "one too many", { authority: TEST_AUTHORITY, userPrompt: true });
    // Its OWN outcome: "the terminal has closed — start it again" would point the user at an
    // agent that is starting perfectly well (roborev 46280).
    expect(r.ok).toBe(false);
    expect(r.path).toBe("queue-full");
    // The refused prompt is not held — the queue is exactly what it was before the attempt.
    expect(pendingSendCount("a1")).toBe(MAX_PER_AGENT);
  });

  it("refuses a MACHINE-authored relay the same way at the cap (the queue isn't userPrompt-gated)", async () => {
    setPaneReady("a1", false);
    for (let i = 0; i < MAX_PER_AGENT; i++) {
      await rejectPtyGoneOnce();
      await dispatchConciergeAnswer("a1", `hold ${i}`, { authority: TEST_AUTHORITY, userPrompt: true });
    }
    await rejectPtyGoneOnce();
    // The nudge card's "approve" fallback: not a user prompt, but it still competes for the hold
    // queue, so it must get the same honest refusal.
    const r = await dispatchConciergeAnswer("a1", "approve", { authority: { kind: "nudge-approve", agentId: "a1" }, userPrompt: false });
    expect(r.ok).toBe(false);
    expect(r.path).toBe("queue-full");
    expect(pendingSendCount("a1")).toBe(MAX_PER_AGENT);
  });

  it("HOLDS a machine-authored relay below the cap (what the Approve card's 'as soon as it's ready' promises)", async () => {
    setPaneReady("a1", false);
    await rejectPtyGoneOnce();
    const r = await dispatchConciergeAnswer("a1", "approve", { authority: { kind: "nudge-approve", agentId: "a1" }, userPrompt: false });
    expect(r.ok).toBe(true);
    expect(r.path).toBe("queued");
    expect(pendingSendCount("a1")).toBe(1);
    // Held, but still not a prompt: no history entry, no trial debit.
    expect(promptsOf("a1")).toHaveLength(0);
    expect(recordTrialSend).not.toHaveBeenCalled();
    // …and DELIVERY is where the suppression actually has to hold: the flush re-applies the
    // side-effects decision the entry was queued with, so a relay that waited out a boot must
    // still not enter the history, debit the trial, or become the agent's name.
    expect((await flushPendingSends("a1")).map((x) => x.path)).toEqual(["free-text"]);
    // The COUNT is what separates "delivered uncharged" from "silently dropped": every
    // suppression assertion below is negative and a dropped entry would satisfy them all.
    expect(submitPrompt).toHaveBeenCalledTimes(2); // the rejected attempt, then the flush
    expect(submitPrompt).toHaveBeenLastCalledWith("a1", "approve");
    expect(promptsOf("a1")).toHaveLength(0);
    expect(recordTrialSend).not.toHaveBeenCalled();
    expect(maybeAutoName).not.toHaveBeenCalled();
  });

  it("still reports pty-gone for an agent with no pane at all", async () => {
    await rejectPtyGoneOnce();
    const r = await dispatchConciergeAnswer("a1", "nobody home", { authority: TEST_AUTHORITY, userPrompt: true });
    expect(r.ok).toBe(false);
    expect(r.path).toBe("pty-gone");
    expect(pendingSendCount("a1")).toBe(0);
  });

  it("flushing with nothing queued is a no-op", async () => {
    expect(await flushPendingSends("a1")).toEqual([]);
    expect(submitPrompt).not.toHaveBeenCalled();
  });
});


describe("dispatchConciergeAnswer — a user PROMPT is not a picker answer", () => {
  const yesNo = [
    { id: "1", label: "Yes", value: "y\n", kind: "terminal", source: "heuristic" },
    { id: "2", label: "No", value: "n\n", kind: "terminal", source: "heuristic" },
  ];

  beforeEach(() => {
    (detectTerminalPrompts as unknown as ReturnType<typeof vi.fn>).mockReturnValue(yesNo);
  });

  it("refuses (with the options) rather than collapsing a sentence onto one keystroke", async () => {
    // "yes, but rename the flag first" starts with a yes-word; taking the y-keystroke would throw
    // the rest of the user's instruction away and answer the picker with something they didn't say.
    const r = await dispatchConciergeAnswer("a1", "yes, but rename the flag first", { authority: TEST_AUTHORITY, userPrompt: true });
    expect(r.ok).toBe(false);
    expect(r.path).toBe("ambiguous-picker");
    expect(r.options).toHaveLength(2);
    expect(writePty).not.toHaveBeenCalled();
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("still takes a terse user answer — a single word", async () => {
    const r = await dispatchConciergeAnswer("a1", "yes", { authority: TEST_AUTHORITY, userPrompt: true });
    expect(r.path).toBe("picker-option");
  });

  it("still takes a bare option number and an exact multi-word label", async () => {
    expect((await dispatchConciergeAnswer("a1", "2", { authority: TEST_AUTHORITY, userPrompt: true })).path).toBe("picker-option");
    (detectTerminalPrompts as unknown as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "1", label: "Unlisted — direct link only", value: "1\n", kind: "terminal", source: "heuristic" },
    ]);
    const r = await dispatchConciergeAnswer("a1", "Unlisted — direct link only", { authority: TEST_AUTHORITY, userPrompt: true });
    expect(r.path).toBe("picker-option");
  });

  it("leaves the MACHINE relay path alone (one word, always terse)", async () => {
    const r = await dispatchConciergeAnswer("a1", "approve", { authority: TEST_AUTHORITY });
    expect(r.path).toBe("picker-option");
  });

  it("records NOTHING for a machine picker answer (it isn't a user turn)", async () => {
    // An appendPrompt(..., "picker") entry counts toward the naming ladder's promptCount, so a bot
    // approval would consume the first-turn deferral a self-reporting agent relies on.
    await dispatchConciergeAnswer("a1", "approve", { authority: TEST_AUTHORITY });
    expect(promptsOf("a1")).toHaveLength(0);
  });
});

describe("isTerseAnswer", () => {
  const opts = [
    { id: "1", label: "Unlisted — direct link only", value: "1\n", kind: "terminal" as const, source: "heuristic" as const },
  ];

  it("accepts a bare number, a yes/no phrase, and an exact label", () => {
    expect(isTerseAnswer("2", opts)).toBe(true);
    expect(isTerseAnswer("2.", opts)).toBe(true);
    expect(isTerseAnswer("approve", opts)).toBe(true);
    expect(isTerseAnswer("yes!", opts)).toBe(true);
    expect(isTerseAnswer("Unlisted — direct link only", opts)).toBe(true);
  });

  it("accepts the MULTI-WORD members of the yes/no families (roborev 46311)", () => {
    // The rule is family membership, not a whitespace count — these are answers, not instructions.
    for (const yes of ["go ahead", "yes please", "sure thing", "please do", "sounds good"]) {
      expect(isTerseAnswer(yes, opts), yes).toBe(true);
    }
    for (const no of ["no thanks", "no thank you", "not now", "do not"]) {
      expect(isTerseAnswer(no, opts), no).toBe(true);
    }
  });

  it("accepts a trailing question mark — 'ok?' is a confirmation (roborev 46485-L)", () => {
    expect(isTerseAnswer("ok?", opts)).toBe(true);
    expect(isTerseAnswer("yes?", opts)).toBe(true);
  });

  it("rejects anything multi-word that isn't an exact label", () => {
    expect(isTerseAnswer("yes, but rename the flag first", opts)).toBe(false);
    expect(isTerseAnswer("no — use the other approach", opts)).toBe(false);
    expect(isTerseAnswer("do it after rebasing", opts)).toBe(false);
  });

  it("rejects a single word that merely STARTS with a yes-word (roborev 46311)", () => {
    // The old rule was "no whitespace ⇒ terse", which took a hyphenated token whole.
    expect(isTerseAnswer("yes-but-the-other-one", opts)).toBe(false);
    expect(isTerseAnswer("approve-later", opts)).toBe(false);
    // …and a bare word from outside both families is not an answer a picker can take verbatim.
    expect(isTerseAnswer("typescript", opts)).toBe(false);
  });

  it("rejects empty/whitespace", () => {
    expect(isTerseAnswer("   ", opts)).toBe(false);
  });
});

describe("dispatchConciergeAnswer / flushPendingSends — the queue is honest", () => {
  async function rejectPtyGoneOnce() {
    const { PtyGoneError } = await import("../pty");
    (submitPrompt as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new (PtyGoneError as unknown as new () => Error)(),
    );
  }

  it("does NOT queue for a pane whose PTY came up and then EXITED", async () => {
    // `ready` means the PTY got as far as running. A failure after that is a dead process, and
    // nothing will restart it on its own — holding the prompt would promise a delivery that never
    // comes (the pane's flush only fires on a ready TRANSITION).
    setPaneReady("a1", true);
    await rejectPtyGoneOnce();
    const r = await dispatchConciergeAnswer("a1", "too late", { authority: TEST_AUTHORITY, userPrompt: true });
    expect(r.ok).toBe(false);
    expect(r.path).toBe("pty-gone");
    expect(pendingSendCount("a1")).toBe(0);
  });

  it("drains immediately when the pane went ready WHILE the send was in flight", async () => {
    setPaneReady("a1", false);
    const { PtyGoneError } = await import("../pty");
    (submitPrompt as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      // The pane's own flush effect has already run (against an empty queue) by the time this
      // rejection lands — without the post-queue re-check, the entry would sit until the TTL.
      setPaneReady("a1", true);
      throw new (PtyGoneError as unknown as new () => Error)();
    });
    const r = await dispatchConciergeAnswer("a1", "beat the race", { authority: TEST_AUTHORITY, userPrompt: true });
    expect(r.path).toBe("queued");
    await Promise.resolve();
    await Promise.resolve();
    expect(pendingSendCount("a1")).toBe(0);
    expect(submitPrompt).toHaveBeenLastCalledWith("a1", "beat the race");
  });

  it("broadcasts a delivered queued prompt so the concierge can reconcile its promise", async () => {
    setPaneReady("a1", false);
    await rejectPtyGoneOnce();
    await dispatchConciergeAnswer("a1", "later", { authority: TEST_AUTHORITY, userPrompt: true });
    const seen: string[] = [];
    const off = onDeferredSendOutcome((r) => seen.push(`${r.path}:${String(r.ok)}`));
    await flushPendingSends("a1");
    off();
    expect(seen).toEqual(["free-text:true"]);
  });

  it("broadcasts an EXPIRED hold instead of silently dropping a promised prompt", async () => {
    setPaneReady("a1", false);
    await rejectPtyGoneOnce();
    await dispatchConciergeAnswer("a1", "held too long", { authority: TEST_AUTHORITY, userPrompt: true });
    // Age the entry past the TTL by re-queueing it with an old timestamp.
    resetPendingSends();
    queuePendingSend({ agentId: "a1", text: "held too long", userPrompt: true, at: 0 });
    const seen: { path: string; sent?: string }[] = [];
    const off = onDeferredSendOutcome((r) => seen.push({ path: r.path, sent: r.sent }));
    const results = await flushPendingSends("a1");
    off();
    expect(results.map((r) => r.path)).toEqual(["expired"]);
    expect(seen).toEqual([{ path: "expired", sent: "held too long" }]);
    expect(submitPrompt).toHaveBeenCalledTimes(1); // only the original, failed attempt
  });

  it("reports a hold the QUEUE-TIME prune drops, before the send that displaced it", async () => {
    // The other way a held prompt can disappear: not on flush, but when the next queue call prunes
    // it as stale. That path emitted nothing at all (roborev 53015) — a promise silently broken,
    // and a permanent slot desync for anything the caller pairs with each queued send. Ordering
    // matters too: the dropped entry's outcome must precede the new send's own.
    resetPendingSends();
    queuePendingSend({
      agentId: "a1",
      text: "'/tmp/shot.png' look",
      display: "look · 1 image",
      userPrompt: true,
      at: 0,
    });
    const seen: { path: string; display?: string }[] = [];
    const off = onDeferredSendOutcome((r) => seen.push({ path: r.path, display: r.display }));

    setPaneReady("a1", false);
    await rejectPtyGoneOnce();
    const r = await dispatchConciergeAnswer("a1", "the newer one", { authority: TEST_AUTHORITY, userPrompt: true });
    off();

    expect(r.path).toBe("queued");
    // The safe rendering survives the drop — the thread quotes `display`, never the payload.
    expect(seen).toEqual([{ path: "expired", display: "look · 1 image" }]);
    expect(pendingSendCount("a1")).toBe(1); // only the new hold remains
  });

  it("a listener that throws can't break a delivery that already landed", async () => {
    setPaneReady("a1", false);
    await rejectPtyGoneOnce();
    await dispatchConciergeAnswer("a1", "resilient", { authority: TEST_AUTHORITY, userPrompt: true });
    const off = onDeferredSendOutcome(() => {
      throw new Error("boom");
    });
    const results = await flushPendingSends("a1");
    off();
    expect(results.map((r) => r.ok)).toEqual([true]);
  });
});

describe("abandonPendingSends — a hold the PTY will never satisfy (roborev 46485-M)", () => {
  it("reports every held entry as `abandoned` and empties the queue", async () => {
    setPaneReady("a1", false);
    queuePendingSend({ agentId: "a1", text: "first", userPrompt: true });
    queuePendingSend({ agentId: "a1", text: "second", userPrompt: true });
    const seen: Array<{ path: string; sent?: string; ok: boolean }> = [];
    const off = onDeferredSendOutcome((r) => seen.push({ path: r.path, sent: r.sent, ok: r.ok }));
    abandonPendingSends("a1");
    off();
    expect(seen).toEqual([
      { path: "abandoned", sent: "first", ok: false },
      { path: "abandoned", sent: "second", ok: false },
    ]);
    expect(pendingSendCount("a1")).toBe(0);
  });

  it("is a no-op when nothing is held (an ordinary pane unmount says nothing)", () => {
    const seen: string[] = [];
    const off = onDeferredSendOutcome((r) => seen.push(r.path));
    abandonPendingSends("never-queued");
    off();
    expect(seen).toEqual([]);
  });

  it("touches only the named agent's queue", () => {
    queuePendingSend({ agentId: "a1", text: "mine", userPrompt: true });
    queuePendingSend({ agentId: "a2", text: "yours", userPrompt: true });
    abandonPendingSends("a1");
    expect(pendingSendCount("a1")).toBe(0);
    expect(pendingSendCount("a2")).toBe(1);
  });
});

describe("cloud agents have no local PTY (roborev 46916)", () => {
  it("refused up front — ok:false, no write, no keystroke, no screen read, no debit", async () => {
    const { useProjectStore } = await import("../stores/projectStore");
    const base = useProjectStore.getState().projects[0]!;
    useProjectStore.setState({
      projects: [
        ...useProjectStore.getState().projects,
        { ...base, id: "p-cloud", agents: [{ ...base.agents[0]!, id: "cloudy", runtime: "cloud" as const }] },
      ],
    });
    const r = await dispatchConciergeAnswer("cloudy", "yes", { authority: TEST_AUTHORITY, userPrompt: true });
    expect(r.ok).toBe(false);
    expect(r.path).toBe("cloud-agent");
    // The refusal short-circuits BEFORE the screen is even read: no PTY write, no keystroke,
    // no picker detection — there is no terminal to detect against — and nothing is charged.
    expect(writePty).not.toHaveBeenCalled();
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(detectTerminalPrompts).not.toHaveBeenCalled();
    expect(recordTrialSend).not.toHaveBeenCalled();
    // …and the STORE-mutating side-effects are skipped too. The runtime check sits above the
    // composer block; a regression that moved it below `appendPrompt`/`maybeAutoName` would still
    // pass every assertion above, so pin the two effects that would survive it.
    //
    // POSITIVE CONTROL first: `promptsOf` returns `?? []`, so an empty result also means "no such
    // agent" — without this the length check would pass just as happily if the fixture never
    // landed in the store, pinning nothing at all (roborev 52972).
    expect(
      useProjectStore.getState().projects.flatMap((p) => p.agents).some((a) => a.id === "cloudy"),
    ).toBe(true);
    expect(promptsOf("cloudy")).toHaveLength(0);
    expect(maybeAutoName).not.toHaveBeenCalled();
  });
});
