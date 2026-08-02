// The two "can this agent take a message?" predicates, and the ASYMMETRY between them.
//
// They look like duplicates and are not. `isCloudAgent` is the dispatcher asking "must I REFUSE
// this?" and only refuses on evidence — an agent the store doesn't know about may still have a live
// PTY (a store/window sync gap, an agent mounted before its project row lands), and calling that
// "cloud-agent" would misreport why a send failed. `agentCanAcceptInput` is the router asking
// "should I aim an IRREVERSIBLE write here?" and declines without evidence, because "not found"
// usually means the project was unloaded.
//
// Neither behaviour had a test, so collapsing them back into one predicate — the exact mistake this
// split corrects — would have left every suite green (roborev 53104).
//
// A THIRD predicate joined them with the cloud prompt path (design 2026-08-01 §Decision 7), and the
// same collapse risk applies to it. `agentCanAcceptPrompt` answers "can I send it a MESSAGE" and is
// TRUE for a cloud agent; `agentCanAcceptInput` answers "is there a local PTY to write raw bytes
// to" and stays FALSE for one, because its other callers (`sendControlKey`, dictation, the
// API-recovery ping) would otherwise aim `writePtyChainedStrict` at a PTY that does not exist.
import { beforeEach, describe, expect, it, vi } from "vitest";

// The paste framing is REAL (the cloud path builds its wire payload from it); only the local write
// primitives are stubbed.
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
vi.mock("./terminalScrollback", () => ({ getAgentScrollback: () => "" }));
vi.mock("./trialMeter", () => ({
  trialSendAllowed: () => true,
  recordTrialSend: vi.fn(),
}));

import {
  agentCanAcceptInput,
  agentCanAcceptPrompt,
  dispatchConciergeAnswer,
} from "./conciergeDispatch";
import { useProjectStore } from "../stores/projectStore";

/** Any valid authority. These suites predate the dispatch authority gate and exercise DELIVERY,
 *  not authorization — the gate itself is covered by dispatchAuthority.test.ts and
 *  conciergeDispatch.gate.test.ts. `authority` is required and non-defaulted (see
 *  services/dispatchAuthority), so every call has to name one. */
const TEST_AUTHORITY = { kind: "suggestion", agentId: "a1" } as const;

/** Seed the project store with one agent of the given runtime. */
function seed(runtime: "local" | "cloud") {
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "sparkle",
        path: "/tmp/p1",
        agents: [{ id: "known", name: "Known", runtime } as never],
      } as never,
    ],
  });
}

beforeEach(() => {
  useProjectStore.setState({ projects: [] });
});

describe("agentCanAcceptInput — the router's gate, fails CLOSED", () => {
  it("is true for a local agent the store knows", () => {
    seed("local");
    expect(agentCanAcceptInput("known")).toBe(true);
  });

  it("is false for a cloud agent", () => {
    seed("cloud");
    expect(agentCanAcceptInput("known")).toBe(false);
  });

  // The whole point of the split. "Not found" is when delivery is LEAST likely to work.
  it("is false for an agent the store has never heard of", () => {
    seed("local");
    expect(agentCanAcceptInput("ghost")).toBe(false);
  });
});

describe("agentCanAcceptPrompt — the MESSAGE question, and it does not collapse into the other", () => {
  it("is true for a cloud agent, where agentCanAcceptInput is false", () => {
    seed("cloud");
    // Both halves in one test on purpose: the failure mode being guarded is the two predicates
    // being merged back together, which no single-sided assertion detects.
    expect(agentCanAcceptPrompt("known")).toBe(true);
    expect(agentCanAcceptInput("known")).toBe(false);
  });

  it("is true for a local agent (both agree)", () => {
    seed("local");
    expect(agentCanAcceptPrompt("known")).toBe(true);
    expect(agentCanAcceptInput("known")).toBe(true);
  });

  it("fails closed on an agent the store has never heard of", () => {
    seed("local");
    expect(agentCanAcceptPrompt("ghost")).toBe(false);
  });
});

describe("the dispatcher's refusal — only on evidence", () => {
  it("refuses an APPROVAL to a cloud agent with the cloud-agent path", async () => {
    seed("cloud");
    // The nudge card's Approve. A prompt to the same agent is DELIVERED (see
    // conciergeDispatch.cloud.test.ts); it is the answer-shaped gesture that keeps refusing.
    const r = await dispatchConciergeAnswer("known", "approve", {
      authority: { kind: "nudge-approve", agentId: "known" },
      userPrompt: false,
    });
    expect(r).toMatchObject({ ok: false, path: "cloud-agent" });
  });

  // The asymmetry, asserted directly: an unknown agent is NOT called a cloud agent, even though
  // agentCanAcceptInput says false for it. A collapsed predicate would fail here.
  it("does NOT call an unknown agent a cloud agent", async () => {
    seed("local");
    expect(agentCanAcceptInput("ghost")).toBe(false); // router declines…
    const r = await dispatchConciergeAnswer("ghost", "hello", { authority: TEST_AUTHORITY, userPrompt: true });
    expect(r.path).not.toBe("cloud-agent"); // …but the dispatcher does not misreport why
    expect(r.path).not.toBe("cloud-offline"); // nor with the OTHER cloud-shaped reason
  });
});
