import { beforeEach, describe, expect, it } from "vitest";
import {
  hasTurnEndAuthority,
  noteProcessExit,
  processAliveOf,
  resetTurnEndAuthority,
  trackAgent,
} from "./turnEndAuthority";

// `processAliveOf` is the producer engine/goalContinuation's `processAlive` gate had been missing:
// the gate shipped with no source in the repo at all, so the first caller would have compiled without
// it and silently refused every `unmerged` row (roborev 55298). It is exported ALIVE-side rather than
// exited-side because the identical-typed `hasExited` made the obvious wiring compile with the
// opposite meaning (roborev 55338). These tests cover the reader; the rest of this module's behaviour
// is exercised through its consumers.
describe("processAliveOf — the only reader of the death signal", () => {
  beforeEach(() => resetTurnEndAuthority());

  it("is undefined for an agent this window does not drive — NOT 'alive'", () => {
    // The distinction the whole module is built on. `services/agentLiveness` refuses to answer this
    // question for the same reason, and a caller that reads "alive" from silence would type into a
    // terminal it never observed.
    expect(processAliveOf("nobody-drives-me")).toBeUndefined();
  });

  it("is TRUE for a tracked, still-running agent", () => {
    const engine = {};
    trackAgent("a", engine);
    expect(processAliveOf("a")).toBe(true);
  });

  it("is FALSE once the PTY exits", () => {
    const engine = {};
    trackAgent("a", engine);
    noteProcessExit("a", engine);
    expect(processAliveOf("a")).toBe(false);
  });

  it("reads the SAME flag hasTurnEndAuthority folds in — opposite consequence, one source", () => {
    // An exited PTY is the strongest witness that a turn ENDED, and simultaneously the evidence that
    // there is nothing left to type INTO. Two answers from one fact is exactly why this needs its own
    // reader rather than being inferred from the other predicate — note they disagree here by design.
    const engine = {};
    trackAgent("a", engine);
    noteProcessExit("a", engine);
    expect(hasTurnEndAuthority("a")).toBe(true);
    expect(processAliveOf("a")).toBe(false);
  });

  it("a NEW engine taking over the id clears a stale exit", () => {
    // The documented race (roborev 55041): a late pty:exit can land after the old engine's dispose,
    // and without the reset the next session would inherit `exited: true` for a live process — here
    // that would refuse auto-continue for an agent that is running.
    const first = {};
    trackAgent("a", first);
    noteProcessExit("a", first);
    expect(processAliveOf("a")).toBe(false);

    const second = {};
    trackAgent("a", second);
    expect(processAliveOf("a")).toBe(true);
  });
});
