import { describe, expect, it } from "vitest";

import { approvalSubject } from "./approvalSubject";

describe("approvalSubject", () => {
  describe("agent-carrying ops", () => {
    it("names the agent a lifecycle op would act on", () => {
      expect(approvalSubject("lifecycle", "discard_agent", { agentId: "a-1" })).toEqual({
        kind: "agent",
        agentId: "a-1",
      });
    });

    it("names the agent a terminal write would reach", () => {
      expect(
        approvalSubject("terminal", "send_to_agent_terminal", { agentId: "a-9", text: "hi" }),
      ).toEqual({ kind: "agent", agentId: "a-9" });
    });

    it("prefers the agent over a PR number when a call somehow carries both", () => {
      // An agent is the more specific subject: it is the thing that gets acted on, whereas a PR
      // number is a lookup key for the same question. Ordering this the other way would name the
      // PR's owner rather than the agent the call actually touches.
      expect(
        approvalSubject("workflow", "merge_pr", { agentId: "a-2", projectId: "p1", number: 7 }),
      ).toEqual({ kind: "agent", agentId: "a-2" });
    });
  });

  describe("PR-carrying ops", () => {
    it("names the pull request merge_pr would merge", () => {
      expect(approvalSubject("workflow", "merge_pr", { projectId: "p1", number: 2165 })).toEqual({
        kind: "pr",
        projectId: "p1",
        number: 2165,
      });
    });

    it("carries the project id, because the owner lookup needs both", () => {
      // `fetchPrOwner(root, projectId, number)` — a bare number cannot be resolved. Dropping the
      // project here would make every PR subject unresolvable at render time.
      const s = approvalSubject("workflow", "merge_pr", { projectId: "proj-x", number: 4 });
      expect(s).toMatchObject({ projectId: "proj-x" });
    });
  });

  describe("no subject", () => {
    it("returns undefined for an op that names neither", () => {
      expect(approvalSubject("app", "quit_app", {})).toBeUndefined();
    });

    it("returns undefined rather than guessing when the project id is missing", () => {
      // A number with no project cannot be turned into an owner, and inventing a project would
      // point the pill at an agent in the wrong repo.
      expect(approvalSubject("workflow", "merge_pr", { number: 2165 })).toBeUndefined();
    });
  });

  describe("totality — args are whatever the model sent", () => {
    it.each([
      ["undefined", undefined],
      ["null", null],
      ["a string", "nope"],
      ["an array", [1, 2, 3]],
      ["a number", 42],
    ])("returns undefined for %s rather than throwing", (_label, args) => {
      expect(() => approvalSubject("lifecycle", "discard_agent", args)).not.toThrow();
      expect(approvalSubject("lifecycle", "discard_agent", args)).toBeUndefined();
    });

    it.each([
      ["an empty agentId", { agentId: "" }],
      ["a non-string agentId", { agentId: 7 }],
      ["a non-numeric PR number", { projectId: "p1", number: "2165" }],
      ["a non-integer PR number", { projectId: "p1", number: 2.5 }],
      ["a non-positive PR number", { projectId: "p1", number: 0 }],
      ["an empty projectId", { projectId: "", number: 4 }],
    ])("returns undefined for %s", (_label, args) => {
      expect(approvalSubject("workflow", "merge_pr", args)).toBeUndefined();
    });
  });
});
