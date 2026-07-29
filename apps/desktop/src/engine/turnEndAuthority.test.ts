import { beforeEach, describe, expect, it } from "vitest";
import {
  hasExited,
  hasTurnEndAuthority,
  noteProcessExit,
  resetTurnEndAuthority,
  trackAgent,
} from "./turnEndAuthority";

// `hasExited` is the producer engine/goalContinuation's `processAlive` gate had been missing: the
// gate shipped with no source in the repo at all, so the first caller would have compiled without it
// and silently refused every `unmerged` row (roborev 55298). These tests cover the reader; the rest
// of this module's behaviour is exercised through its consumers.
describe("hasExited — the only reader of the death signal", () => {
  beforeEach(() => resetTurnEndAuthority());

  it("is undefined for an agent this window does not drive — NOT 'alive'", () => {
    // The distinction the whole module is built on. `services/agentLiveness` refuses to answer this
    // question for the same reason, and a caller that reads "alive" from silence would type into a
    // terminal it never observed.
    expect(hasExited("nobody-drives-me")).toBeUndefined();
  });

  it("is false for a tracked, still-running agent", () => {
    const engine = {};
    trackAgent("a", engine);
    expect(hasExited("a")).toBe(false);
  });

  it("is true once the PTY exits", () => {
    const engine = {};
    trackAgent("a", engine);
    noteProcessExit("a", engine);
    expect(hasExited("a")).toBe(true);
  });

  it("reads the SAME flag hasTurnEndAuthority folds in — opposite consequence, one source", () => {
    // An exited PTY is the strongest witness that a turn ended, AND the evidence there is nothing
    // left to type into. Two answers from one fact is exactly why this needs its own reader rather
    // than being inferred from the other predicate.
    const engine = {};
    trackAgent("a", engine);
    noteProcessExit("a", engine);
    expect(hasTurnEndAuthority("a")).toBe(true);
    expect(hasExited("a")).toBe(true);
  });

  it("a NEW engine taking over the id clears a stale exit", () => {
    // The documented race (roborev 55041): a late pty:exit can land after the old engine's dispose,
    // and without the reset the next session would inherit `exited: true` for a live process — here
    // that would refuse auto-continue for an agent that is running.
    const first = {};
    trackAgent("a", first);
    noteProcessExit("a", first);
    expect(hasExited("a")).toBe(true);

    const second = {};
    trackAgent("a", second);
    expect(hasExited("a")).toBe(false);
  });
});
