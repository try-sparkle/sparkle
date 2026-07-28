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
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pty", () => ({
  writePtyChainedStrict: vi.fn(async () => {}),
  submitPrompt: vi.fn(async () => {}),
  PtyGoneError: class extends Error {},
}));
vi.mock("./terminalScrollback", () => ({ getAgentScrollback: () => "" }));
vi.mock("./trialMeter", () => ({
  trialSendAllowed: () => true,
  recordTrialSend: vi.fn(),
}));

import { agentCanAcceptInput, dispatchConciergeAnswer } from "./conciergeDispatch";
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

describe("the dispatcher's refusal — only on evidence", () => {
  it("refuses a cloud agent with its own path", async () => {
    seed("cloud");
    const r = await dispatchConciergeAnswer("known", "hello", { authority: TEST_AUTHORITY, userPrompt: true });
    expect(r).toMatchObject({ ok: false, path: "cloud-agent" });
  });

  // The asymmetry, asserted directly: an unknown agent is NOT called a cloud agent, even though
  // agentCanAcceptInput says false for it. A collapsed predicate would fail here.
  it("does NOT call an unknown agent a cloud agent", async () => {
    seed("local");
    expect(agentCanAcceptInput("ghost")).toBe(false); // router declines…
    const r = await dispatchConciergeAnswer("ghost", "hello", { authority: TEST_AUTHORITY, userPrompt: true });
    expect(r.path).not.toBe("cloud-agent"); // …but the dispatcher does not misreport why
  });
});
