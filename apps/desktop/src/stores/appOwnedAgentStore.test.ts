import { beforeEach, describe, expect, it } from "vitest";
import { useAppOwnedAgentStore } from "./appOwnedAgentStore";

const ID = "__sparkle_self__";

describe("appOwnedAgentStore", () => {
  beforeEach(() => {
    useAppOwnedAgentStore.setState({ goalById: {}, activityById: {} });
  });

  it("stores and clears an activity line by agent id", () => {
    useAppOwnedAgentStore.getState().setActivity(ID, "wiring the control listener");
    expect(useAppOwnedAgentStore.getState().activityById[ID]).toBe("wiring the control listener");
    // Empty CLEARS rather than storing a blank — so the read-back falls back to the computed line.
    useAppOwnedAgentStore.getState().setActivity(ID, "");
    expect(useAppOwnedAgentStore.getState().activityById[ID]).toBeUndefined();
  });

  it("stores a goal as unmet, then marks it met", () => {
    useAppOwnedAgentStore.getState().setGoal(ID, "land the write-path PR");
    expect(useAppOwnedAgentStore.getState().goalById[ID]).toEqual({
      text: "land the write-path PR",
      met: false,
    });
    useAppOwnedAgentStore.getState().setGoalMet(ID, true);
    expect(useAppOwnedAgentStore.getState().goalById[ID]).toEqual({
      text: "land the write-path PR",
      met: true,
    });
  });

  it("a fresh goal resets met back to false", () => {
    useAppOwnedAgentStore.getState().setGoal(ID, "first");
    useAppOwnedAgentStore.getState().setGoalMet(ID, true);
    useAppOwnedAgentStore.getState().setGoal(ID, "second");
    expect(useAppOwnedAgentStore.getState().goalById[ID]).toEqual({ text: "second", met: false });
  });

  it("empty goal text CLEARS the goal", () => {
    useAppOwnedAgentStore.getState().setGoal(ID, "temp");
    useAppOwnedAgentStore.getState().setGoal(ID, "");
    expect(useAppOwnedAgentStore.getState().goalById[ID]).toBeUndefined();
  });

  it("marking met with NO goal set is a no-op — you cannot finish nothing", () => {
    // This is the invariant the handler reports as `changed: false`: setGoalMet must not invent a
    // goal, or a bare set_agent_goal_met would fabricate a finished objective on the roster.
    useAppOwnedAgentStore.getState().setGoalMet(ID, true);
    expect(useAppOwnedAgentStore.getState().goalById[ID]).toBeUndefined();
  });
});
