import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StatusEngine } from "./statusEngine";
import type { AgentTabStatus } from "../types";

// Drives the engine and records the latest status, so each test can assert transitions.
function makeEngine() {
  const statuses: AgentTabStatus[] = [];
  const engine = new StatusEngine({
    agentId: "test",
    onStatus: (s) => statuses.push(s),
  });
  return { engine, statuses, last: () => statuses[statuses.length - 1] };
}

describe("StatusEngine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts working and stays working while output flows", () => {
    const { engine, last } = makeEngine();
    expect(last()).toBe("working");
    engine.ingest("compiling module A\n");
    expect(last()).toBe("working");
  });

  it("goes idle after a quiet period, then blocked after a long stall", () => {
    const { engine, last } = makeEngine();
    engine.ingest("doing work\n");
    vi.advanceTimersByTime(2500);
    expect(last()).toBe("idle");
    // blocked must still be reachable after idle (the bug roborev caught).
    vi.advanceTimersByTime(25000);
    expect(last()).toBe("blocked");
  });

  it("shows waiting when the agent asks a plain question", () => {
    const { engine, last } = makeEngine();
    engine.ingest("Do you want to proceed? (y/n)\n");
    expect(last()).toBe("waiting");
  });

  it("shows approval when a risky action precedes the prompt", () => {
    const { engine, last } = makeEngine();
    engine.ingest("$ git push origin main\n");
    engine.ingest("Do you want to proceed?\n");
    expect(last()).toBe("approval");
  });

  it("ends done on a clean exit", () => {
    const { engine, last } = makeEngine();
    engine.ingest("All tasks complete.\n");
    engine.exit();
    expect(last()).toBe("done");
  });

  it("ends errored when an error is the last thing before exit", () => {
    const { engine, last } = makeEngine();
    engine.ingest("Error: cannot find module 'foo'\n");
    engine.exit();
    expect(last()).toBe("errored");
  });

  it("does NOT mislabel a recovered session as errored", () => {
    const { engine, last } = makeEngine();
    engine.ingest("Error: transient network blip\n");
    // Agent recovers and calmly waits for the user — error flag should clear.
    engine.ingest("Do you want to proceed?\n");
    engine.exit();
    expect(last()).toBe("done");
  });

  it("does not treat a conversational 'Error:' mid-sentence as an error", () => {
    const { engine, last } = makeEngine();
    engine.ingest("I found the bug: the Error: prefix was matched too broadly.\n");
    engine.exit();
    expect(last()).toBe("done");
  });
});
