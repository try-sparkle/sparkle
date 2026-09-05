// THE HONEST ACK, AS THE MODEL RECEIVES IT (bead sparkle-1cu3j).
//
// `dispatchConciergeAnswer` is where the fact lives (see conciergeDispatch.submittedAck.test.ts);
// this file pins that `sendToAgentTerminal` — the body behind the model-facing
// `send_to_agent_terminal` tool — actually CARRIES it out. A truth computed at the chokepoint and
// dropped one layer up would leave the caller exactly as misinformed as before, and nothing else
// in the suite would notice: `ok` and `detail` are unchanged on both paths.
//
// The dispatcher is mocked here on purpose. What is under test is the propagation, so the
// interesting inputs are the two dispatcher verdicts that share `ok: true` and differ on delivery.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  dispatchConciergeAnswer: vi.fn(),
  agentCanAcceptInput: vi.fn(() => true),
  findAgent: vi.fn((): { id: string; runtime: string } | undefined => ({
    id: "a1",
    runtime: "local",
  })),
}));

vi.mock("../conciergeDispatch", async (orig) => {
  const real = await orig<typeof import("../conciergeDispatch")>();
  return {
    ...real,
    // REAL `wasSubmitted` — it is the thing whose answer is being propagated, so stubbing it would
    // make this a test of the mock.
    dispatchConciergeAnswer: h.dispatchConciergeAnswer,
    agentCanAcceptInput: h.agentCanAcceptInput,
    liveOptionsFor: vi.fn(() => []),
  };
});
vi.mock("../knownAgents", async (orig) => ({
  ...(await orig<typeof import("../knownAgents")>()),
  findKnownAgent: h.findAgent,
}));
vi.mock("../sparkleBusy", () => ({ sparkleBusyNow: vi.fn(() => null) }));
vi.mock("../../pty", () => ({
  // `resizePty` is reached through `services/forceRedraw`, which `conciergeTools/terminal`
  // now imports for its pre-send frame repair. A factory mock REPLACES the module, so an
  // omitted export is a hard load error for the whole suite, not a missing stub.
  resizePty: vi.fn(async () => {}),
  writePtyChainedStrict: vi.fn(async () => {}),
  PtyGoneError: class extends Error {},
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "") }));
vi.mock("../history", () => ({ searchHistory: vi.fn(async () => []) }));
vi.mock("../../stores/runtimeStore", () => ({
  useRuntimeStore: {
    getState: vi.fn(() => ({ attentionScreen: {}, attentionScreenAt: {}, status: {} })),
  },
  mergeOpenAgentIds: (a: string[], b: string[]) => [...new Set([...a, ...b])],
  readPersistedOpenAgentIds: vi.fn((): string[] => []),
}));

import { sendToAgentTerminal } from "./terminal";
import { conciergeToolAuthority } from "../dispatchAuthority";

const AGENT = "a1";
/** The REAL constructor, from a real allow-tier decision — the tool arm is validated at runtime, so
 *  a hand-built object literal is refused as `unauthorized` and every case below would test the
 *  authority gate instead of the ack. */
const AUTH = conciergeToolAuthority("tc-1", { tier: "allow" } as never)!;

beforeEach(() => {
  h.agentCanAcceptInput.mockReturnValue(true);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("send_to_agent_terminal's ack carries whether the message was submitted", () => {
  // THE BEAD'S CASE. `ok: true` on a queued send is not a delivery, and this is the shape a caller
  // now has to read to tell the two apart.
  it("a queued send is ok but NOT submitted", async () => {
    h.dispatchConciergeAnswer.mockResolvedValue({
      ok: true,
      path: "queued",
      agentId: AGENT,
      sent: "ship it",
      display: "ship it",
    });
    const r = await sendToAgentTerminal(AGENT, "ship it", AUTH);
    expect(r.ok).toBe(true);
    expect(r.submitted).toBe(false);
    // The sentence the model reads has always said this; nothing about it changes. The point is
    // that the FLAG now agrees with it, so a caller does not have to parse prose to find out.
    expect(r.detail).toContain("isn't up yet");
  });

  it("a delivered send is ok AND submitted", async () => {
    h.dispatchConciergeAnswer.mockResolvedValue({
      ok: true,
      path: "free-text",
      agentId: AGENT,
      sent: "ship it",
      display: "ship it",
    });
    const r = await sendToAgentTerminal(AGENT, "ship it", AUTH);
    expect(r.ok).toBe(true);
    expect(r.submitted).toBe(true);
  });

  // A refusal the dispatcher makes.
  it("a refused send is neither", async () => {
    h.dispatchConciergeAnswer.mockResolvedValue({
      ok: false,
      path: "blocked-prompt",
      agentId: AGENT,
    });
    const r = await sendToAgentTerminal(AGENT, "ship it", AUTH);
    expect(r.ok).toBe(false);
    expect(r.submitted).toBe(false);
  });

  // A refusal THIS layer makes on its own behalf, which never reaches the dispatcher at all — so it
  // is a separate source of the field and a separate chance to leave it out.
  it("a refusal made before the dispatcher is never submitted, and never wrote", async () => {
    h.agentCanAcceptInput.mockReturnValue(false);
    h.findAgent.mockReturnValue(undefined);
    const r = await sendToAgentTerminal("who?", "ship it", AUTH);
    expect(r.ok).toBe(false);
    expect(r.submitted).toBe(false);
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
  });
});
