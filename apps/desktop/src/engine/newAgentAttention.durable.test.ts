// Route 5, and the restart it exists for (roborev 54771).
//
// The hole: route 4's evidence lives in `interactionStore`, which is in-memory only, while the
// `createdAt` gate it defends is persisted with the agent record. So an agent briefed ONLY by
// terminal keystrokes came back from a relaunch briefless by every route — and because the
// `blocked` → `new` mapping is deliberately not time-limited, a genuinely wedged agent then rendered
// calm gray indefinitely. That is this module's own bug, reintroduced on the one path its header
// promises to protect, biting exactly when the user reopens the app to look for reds.
import { describe, expect, it } from "vitest";

import { calmNewAgent, isBriefless, type BriefableAgent } from "./newAgentAttention";

const T0 = 1_700_000_000_000;
/** Well past NEW_AGENT_GRACE_MS, so nothing here is the backstop doing the work. */
const LATER = T0 + 60 * 60_000;

/** What a hand-driven agent looks like after a relaunch: prompt fields still empty, `createdAt`
 *  restored from disk, and the in-memory interaction map gone. */
const rehydrated = (over: Partial<BriefableAgent> = {}): BriefableAgent => ({
  id: "a1",
  lastPrompt: "",
  promptHistory: [],
  createdAt: T0,
  ...over,
});

describe("route 5 — a terminal brief survives the relaunch that loses route 4", () => {
  it("REGRESSION: without a durable stamp, a rehydrated hand-driven agent reads briefless", () => {
    // Pinned so the test below is provably testing something. `interactedAt` is undefined because
    // the store that held it did not persist.
    expect(isBriefless(rehydrated(), undefined)).toBe(true);
  });

  it("…and with the stamp it is briefed, so its `blocked` stays RED", () => {
    const a = rehydrated({ terminalBriefedAt: T0 + 5_000 });
    expect(isBriefless(a, undefined)).toBe(false);
    // The actual user-visible claim: reopen the app, the agent is wedged, and it looks wedged.
    expect(calmNewAgent("blocked", a, LATER)).toBe("blocked");
    expect(calmNewAgent("errored", a, LATER)).toBe("errored");
  });

  it("still calms a genuinely never-briefed agent — the stamp must not calm everything", () => {
    expect(calmNewAgent("blocked", rehydrated(), LATER)).toBe("new");
  });

  it("treats a zero/absent stamp as no evidence, like every other route", () => {
    expect(isBriefless(rehydrated({ terminalBriefedAt: 0 }), undefined)).toBe(true);
    expect(isBriefless(rehydrated({ terminalBriefedAt: undefined }), undefined)).toBe(true);
  });

  it("agrees with the live route while the session is still running", () => {
    // Both routes present, same answer — route 5 is the durable twin of route 4, not a rival.
    expect(isBriefless(rehydrated(), T0 + 5_000)).toBe(false);
    expect(isBriefless(rehydrated({ terminalBriefedAt: T0 + 5_000 }), T0 + 5_000)).toBe(false);
  });

  it("does not disturb the other four routes", () => {
    expect(isBriefless(rehydrated({ lastPrompt: "go" }), undefined)).toBe(false);
    expect(isBriefless(rehydrated({ task: "do the thing" }), undefined)).toBe(false);
    expect(isBriefless(rehydrated({ shellCommand: "pnpm test" }), undefined)).toBe(false);
    expect(isBriefless(rehydrated({ promptHistory: [{}] }), undefined)).toBe(false);
  });

  it("a real ask still goes red for either kind of agent, briefed or not", () => {
    expect(calmNewAgent("waiting", rehydrated(), T0 + 1_000)).toBe("waiting");
    expect(calmNewAgent("approval", rehydrated({ terminalBriefedAt: T0 }), T0 + 1_000)).toBe(
      "approval",
    );
  });
});
