import { describe, it, expect } from "vitest";
import {
  CLOSE_AGENT_ACTION,
  controlValue,
  parseControlAction,
  closeBuildAgentButton,
} from "./controlButtons";

describe("control button encoding", () => {
  it("round-trips an action through controlValue/parseControlAction", () => {
    expect(parseControlAction(controlValue(CLOSE_AGENT_ACTION))).toBe(CLOSE_AGENT_ACTION);
  });

  it("returns null for a non-control value (ordinary prompt/keystroke)", () => {
    expect(parseControlAction("Rebase main, open a PR.")).toBeNull();
    expect(parseControlAction("y\n")).toBeNull();
  });

  it("builds a well-formed Close Build Agent control button", () => {
    const b = closeBuildAgentButton();
    expect(b.kind).toBe("control");
    expect(b.source).toBe("control");
    expect(b.label).toBe("Close Build Agent");
    expect(parseControlAction(b.value)).toBe(CLOSE_AGENT_ACTION);
  });
});
