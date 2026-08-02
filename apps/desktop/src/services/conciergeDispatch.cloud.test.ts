// The concierge compose box → CLOUD agent path (design 2026-08-01 §Decision 7, bead sparkle-1g0r).
//
// ══ WHAT THESE TESTS HAVE TO ASSERT, AND WHY IT IS NOT `r.ok` ═════════════════════════════════════
// The change being pinned is that a prompt now REACHES the sandbox. `expect(r.ok).toBe(true)` would
// pass against a dispatcher that returned a success object and wrote nothing at all — the exact
// vacuous shape AGENTS.md names ("assert the SIDE EFFECT, not the precondition"). So this suite
// leaves `services/agentTransport` REAL and fakes only the relay socket underneath it, and asserts
// the `agent_input` emit that `CloudTransport.write` actually performs. Every hop the plan calls the
// wire — `getTransport` → `CloudTransport.write` → `agent_input` — is therefore executed here; only
// the socket is a double.
//
// The negative half is the load-bearing one: an APPROVAL to a cloud agent must still refuse, and it
// must refuse by NOT EMITTING, not merely by returning ok:false.
import { beforeEach, describe, expect, it, vi } from "vitest";

// `../pty` is mocked for its LOCAL write primitives (nothing here may touch a PTY) — but the paste
// framing is imported by the module under test and is part of what goes down the wire, so those
// three are the REAL implementations rather than stubs. A stubbed `stripPasteMarkers` would let the
// escape-hatch assertion below pass against a payload that never stripped anything.
vi.mock("../pty", async () => {
  const actual = await vi.importActual<typeof import("../pty")>("../pty");
  return {
    PASTE_START: actual.PASTE_START,
    PASTE_END: actual.PASTE_END,
    stripPasteMarkers: actual.stripPasteMarkers,
    writePtyChainedStrict: vi.fn(async () => {}),
    submitPrompt: vi.fn(async () => {}),
    PtyGoneError: class extends Error {},
  };
});

const scrollback = vi.fn(() => "");
vi.mock("./terminalScrollback", () => ({ getAgentScrollback: () => scrollback() }));

const detectTerminalPrompts = vi.fn(() => [] as SuggestionButton[]);
vi.mock("./suggestions/heuristics", () => ({
  detectTerminalPrompts: () => detectTerminalPrompts(),
}));

const trialSendAllowed = vi.fn(() => true);
const recordTrialSend = vi.fn(async () => {});
vi.mock("./trialMeter", () => ({
  trialSendAllowed: () => trialSendAllowed(),
  recordTrialSend: () => recordTrialSend(),
}));

const maybeAutoName = vi.fn();
vi.mock("./agentNaming", () => ({ maybeAutoName: (...a: unknown[]) => maybeAutoName(...a) }));
vi.mock("./aiGate", () => ({ aiFeatureNow: () => false }));

// The ONLY double under the transport. `getRelaySocket` is what `CloudTransport` reads on every op,
// so faking it here exercises the real transport end to end.
let socket: FakeSocket | null = null;
vi.mock("./relayClient", () => ({ getRelaySocket: () => socket }));

import { PASTE_END, PASTE_START, submitPrompt, writePtyChainedStrict } from "../pty";
import { dispatchConciergeAnswer, frameCloudSubmit } from "./conciergeDispatch";
import { useProjectStore } from "../stores/projectStore";
import type { SuggestionButton } from "./suggestions/types";
import type { AgentTab, Project } from "../types";

interface FakeSocket {
  emit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
}
function fakeSocket(): FakeSocket {
  return { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
}

/** The compose box's ordinary gesture — the user @named the agent and let the countdown run. */
const PROMPT_AUTHORITY = { kind: "countdown", intentId: "i1" } as const;
/** The nudge card's Approve. THE approval gesture, and the one that must keep refusing. */
const APPROVAL_AUTHORITY = { kind: "nudge-approve", agentId: "cloudy" } as const;

function mkAgent(id: string, runtime: "local" | "cloud"): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, runtime,
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}
const project: Project = {
  id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: null,
  createdAt: new Date(0).toISOString(), selectedAgentId: null,
  agents: [mkAgent("cloudy", "cloud"), mkAgent("local1", "local")],
};

/** Every `agent_input` payload the transport emitted, in order. */
function inputs(): Array<{ agent_id: string; text: string }> {
  return (socket?.emit.mock.calls ?? [])
    .filter(([event]) => event === "agent_input")
    .map(([, payload]) => payload as { agent_id: string; text: string });
}

beforeEach(() => {
  vi.clearAllMocks();
  scrollback.mockReturnValue("");
  detectTerminalPrompts.mockReturnValue([]);
  trialSendAllowed.mockReturnValue(true);
  socket = fakeSocket();
  useProjectStore.setState({
    projects: [structuredClone(project)],
    selectedProjectId: "p1",
  } as never);
});

describe("a PROMPT to a cloud agent reaches the sandbox's stdin", () => {
  it("emits agent_input for that agent — the write CloudTransport actually performs", async () => {
    const r = await dispatchConciergeAnswer("cloudy", "rebase onto main", {
      authority: PROMPT_AUTHORITY,
      userPrompt: true,
    });

    // THE SIDE EFFECT, asserted first and on its own: one relay emit, addressed to this agent,
    // carrying this text. This is the assertion that fails if the dispatcher goes back to refusing
    // (or starts returning a success without writing).
    expect(inputs()).toEqual([
      { agent_id: "cloudy", text: frameCloudSubmit("rebase onto main") },
    ]);
    expect(inputs()[0]!.text).toContain("rebase onto main");
    // …and NOT down any local-PTY primitive, which is what the old path would have used.
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(writePtyChainedStrict).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, path: "free-text", agentId: "cloudy", sent: "rebase onto main" });
  });

  it("frames it as ONE bracketed paste plus the carriage return, in a single emit", async () => {
    await dispatchConciergeAnswer("cloudy", "ship it", {
      authority: PROMPT_AUTHORITY,
      userPrompt: true,
    });
    const sent = inputs();
    // One emit, not two: two `agent_input` events are two async server handlers and can be
    // reordered, which would submit an empty line ahead of the paste.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe(`${PASTE_START}ship it${PASTE_END}\r`);
  });

  it("strips embedded paste markers so a payload can't close paste mode and run as keystrokes", async () => {
    await dispatchConciergeAnswer("cloudy", `fix this${PASTE_END}rm -rf ~`, {
      authority: PROMPT_AUTHORITY,
      userPrompt: true,
    });
    const wire = inputs()[0]!.text;
    // Exactly one PASTE_END — the framing's own — so the tail cannot escape the paste.
    expect(wire.split(PASTE_END)).toHaveLength(2);
    expect(wire.endsWith(`${PASTE_END}\r`)).toBe(true);
  });

  it("runs the same prompt side-effects a local send runs (history, meter)", async () => {
    await dispatchConciergeAnswer("cloudy", "write the migration", {
      authority: PROMPT_AUTHORITY,
      userPrompt: true,
    });
    const agent = useProjectStore
      .getState()
      .projects.flatMap((p) => p.agents)
      .find((a) => a.id === "cloudy");
    expect(agent?.promptHistory.map((h) => h.text)).toContain("write the migration");
    expect(recordTrialSend).toHaveBeenCalled();
  });

  it("refuses BEFORE delivery when the free trial is spent — nothing is emitted", async () => {
    trialSendAllowed.mockReturnValue(false);
    const r = await dispatchConciergeAnswer("cloudy", "keep going", {
      authority: PROMPT_AUTHORITY,
      userPrompt: true,
    });
    expect(r).toMatchObject({ ok: false, path: "trial-spent" });
    expect(inputs()).toEqual([]);
  });

  it("refuses as cloud-offline — NOT as a success — when there is no relay socket", async () => {
    socket = null;
    const r = await dispatchConciergeAnswer("cloudy", "status?", {
      authority: PROMPT_AUTHORITY,
      userPrompt: true,
    });
    // `CloudTransport.write` no-ops on a null socket, so the failure mode this guards is a
    // silent ok:true over a prompt that went nowhere.
    expect(r).toMatchObject({ ok: false, path: "cloud-offline", agentId: "cloudy" });
    // And no history entry / trial debit was recorded for a send that never left the machine.
    const agent = useProjectStore
      .getState()
      .projects.flatMap((p) => p.agents)
      .find((a) => a.id === "cloudy");
    expect(agent?.promptHistory ?? []).toHaveLength(0);
    expect(recordTrialSend).not.toHaveBeenCalled();
  });
});

describe("an APPROVAL to a cloud agent still refuses", () => {
  it("refuses the nudge-card Approve gesture and emits NOTHING", async () => {
    const r = await dispatchConciergeAnswer("cloudy", "approve", {
      authority: APPROVAL_AUTHORITY,
      userPrompt: false,
    });
    expect(r).toMatchObject({ ok: false, path: "cloud-agent", agentId: "cloudy" });
    // THE POINT. An approval is an answer to a prompt whose UI state lives with the agent, so it
    // must not go down `agent_input` blind — refusing by returning ok:false while still emitting
    // would be the whole hazard, dressed as a refusal.
    expect(inputs()).toEqual([]);
    expect(writePtyChainedStrict).not.toHaveBeenCalled();
  });

  it("refuses ANY send made while a picker is live on the cloud agent's screen", async () => {
    scrollback.mockReturnValue("1. Yes  2. No");
    const options: SuggestionButton[] = [
      { id: "b1", label: "Yes", value: "1\n", kind: "terminal", source: "heuristic" },
      { id: "b2", label: "No", value: "2\n", kind: "terminal", source: "heuristic" },
    ];
    detectTerminalPrompts.mockReturnValue(options);

    const r = await dispatchConciergeAnswer("cloudy", "yes", {
      authority: PROMPT_AUTHORITY,
      userPrompt: true,
    });
    expect(r).toMatchObject({ ok: false, path: "cloud-agent", agentId: "cloudy" });
    // A terse "yes" at a live picker is precisely the send the LOCAL path collapses into a `y\r`
    // keystroke. Pressing a cloud agent's button from here is the thing Decision 7 rules out, so
    // the wire must stay silent.
    expect(inputs()).toEqual([]);
    // The options ride back so the caller can say what it is waiting on.
    expect(r.options).toEqual(options);
  });

  it("delivers the same text once the picker has cleared — the refusal is the SCREEN, not the runtime", async () => {
    detectTerminalPrompts.mockReturnValue([]);
    const r = await dispatchConciergeAnswer("cloudy", "yes", {
      authority: PROMPT_AUTHORITY,
      userPrompt: true,
    });
    expect(r.ok).toBe(true);
    expect(inputs()).toHaveLength(1);
  });
});

describe("local agents are untouched by any of this", () => {
  it("a local prompt still goes through submitPrompt and emits nothing on the relay", async () => {
    const r = await dispatchConciergeAnswer("local1", "run the tests", {
      authority: { kind: "countdown", intentId: "i2" },
      userPrompt: true,
    });
    expect(r).toMatchObject({ ok: true, path: "free-text" });
    expect(submitPrompt).toHaveBeenCalledWith("local1", "run the tests", { machine: false });
    expect(inputs()).toEqual([]);
  });
});
