// The hand-off between a terminal drop and the compose box that will carry it.
import { beforeEach, describe, expect, it } from "vitest";
import { useTerminalDropStore } from "./terminalDropStore";

beforeEach(() => useTerminalDropStore.setState({ queue: [] }));

describe("terminalDropStore", () => {
  it("starts empty and drains to nothing", () => {
    expect(useTerminalDropStore.getState().queue).toEqual([]);
    expect(useTerminalDropStore.getState().drain()).toEqual([]);
  });

  it("queues a batch with the agent it was dropped on", () => {
    useTerminalDropStore.getState().enqueue("a", ["/tmp/x.png"]);
    expect(useTerminalDropStore.getState().queue).toEqual([
      { agentId: "a", paths: ["/tmp/x.png"] },
    ]);
  });

  it("keeps successive batches rather than overwriting", () => {
    // A drop that lands before the compose box has picked up an earlier one must not erase it.
    useTerminalDropStore.getState().enqueue("a", ["/tmp/x.png"]);
    useTerminalDropStore.getState().enqueue("b", ["/tmp/y.log"]);
    expect(useTerminalDropStore.getState().drain()).toEqual([
      { agentId: "a", paths: ["/tmp/x.png"] },
      { agentId: "b", paths: ["/tmp/y.log"] },
    ]);
  });

  it("drain clears, so a second drain delivers nothing twice", () => {
    useTerminalDropStore.getState().enqueue("a", ["/tmp/x.png"]);
    expect(useTerminalDropStore.getState().drain()).toHaveLength(1);
    expect(useTerminalDropStore.getState().drain()).toEqual([]);
    expect(useTerminalDropStore.getState().queue).toEqual([]);
  });

  it("ignores an empty path list, so subscribers are never woken for nothing", () => {
    let writes = 0;
    const stop = useTerminalDropStore.subscribe(() => writes++);
    useTerminalDropStore.getState().enqueue("a", []);
    stop();
    expect(writes).toBe(0);
    expect(useTerminalDropStore.getState().queue).toEqual([]);
  });
});
