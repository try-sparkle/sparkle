import { describe, it, expect, beforeEach } from "vitest";
import { useRuntimeStore } from "./runtimeStore";

// The NEUTRAL MIDDLE STATE between "needs you" (red) and "done" (gray).
//
// With the followup judge unavailable — the expected condition until AI enhancement moves onto the
// user's own `claude` CLI — a finished turn that looks like an ask can no longer be coloured in
// either direction honestly. Painting it red is the false-alarm storm this branch exists to kill;
// painting it gray silently drops a real "Want me to land it?". So the row carries a muted marker
// meaning "we couldn't tell", and these tests pin its lifecycle: it must appear only on an
// unjudgeable ask, and must not outlive the turn it describes.
const reset = () => useRuntimeStore.setState({ unjudgedAsk: {} });

describe("unjudgedAsk", () => {
  beforeEach(reset);

  it("marks an agent whose finished turn could not be judged", () => {
    useRuntimeStore.getState().setUnjudgedAsk("a1", "strong");
    expect(useRuntimeStore.getState().unjudgedAsk.a1).toBe("strong");
  });

  it("clears when a new turn opens — the last turn's ask is moot once the user speaks", () => {
    useRuntimeStore.getState().setUnjudgedAsk("a1", "strong");
    useRuntimeStore.getState().clearUnjudgedAsk("a1");
    expect(useRuntimeStore.getState().unjudgedAsk.a1).toBeUndefined();
    expect("a1" in useRuntimeStore.getState().unjudgedAsk).toBe(false);
  });

  it("is per-agent — clearing one row never touches another", () => {
    useRuntimeStore.getState().setUnjudgedAsk("a1", "strong");
    useRuntimeStore.getState().setUnjudgedAsk("a2", "weak");
    useRuntimeStore.getState().clearUnjudgedAsk("a1");
    expect(useRuntimeStore.getState().unjudgedAsk.a2).toBe("weak");
  });

  it("re-marking with the SAME signal does not churn the map identity", () => {
    // The sidebar subscribes to this map; a redundant write would re-render every row for nothing.
    // Same guard, same reason as setStatus (sparkle-f2uz).
    useRuntimeStore.getState().setUnjudgedAsk("a1", "strong");
    const before = useRuntimeStore.getState().unjudgedAsk;
    useRuntimeStore.getState().setUnjudgedAsk("a1", "strong");
    expect(useRuntimeStore.getState().unjudgedAsk).toBe(before);
  });

  it("does NOT survive the agent being closed", () => {
    // roborev 54814. Every sibling live-only map is stripped in close(); this one was not, so a
    // closed agent kept a muted marker claiming an unanswered question about a turn that is gone.
    useRuntimeStore.setState({ unjudgedAsk: { a1: "strong" } });
    useRuntimeStore.getState().close("a1");
    expect(useRuntimeStore.getState().unjudgedAsk.a1).toBeUndefined();
  });

  it("does NOT ride along into a reused agent slot", () => {
    // resetProgress is the worse case: everything else is wiped for the NEW run while the previous
    // occupant's marker stays, so a fresh agent inherits a stranger's unanswered question.
    useRuntimeStore.setState({ unjudgedAsk: { a1: "weak" } });
    useRuntimeStore.getState().resetProgress("a1");
    expect(useRuntimeStore.getState().unjudgedAsk.a1).toBeUndefined();
  });

  it("clearing an unmarked agent is a no-op, not a new map", () => {
    const before = useRuntimeStore.getState().unjudgedAsk;
    useRuntimeStore.getState().clearUnjudgedAsk("nobody");
    expect(useRuntimeStore.getState().unjudgedAsk).toBe(before);
  });
});
