// @vitest-environment jsdom
//
// The recorder behind the thinking indicator. What matters here is that the record is a faithful
// report of a call the app dispatched — the right subject, the right tense, and NOTHING when the
// subject cannot be named.
import { beforeEach, describe, expect, it } from "vitest";

import { useProjectStore } from "../stores/projectStore";
import {
  _resetConciergeActivityForTests,
  noteConciergeToolCall,
  useConciergeActivityStore,
} from "./conciergeActivity";

function latest() {
  return useConciergeActivityStore.getState().latest;
}

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
  _resetConciergeActivityForTests();
});

function seedAgent(projectName = "Demo"): { projectId: string; agentId: string; name: string } {
  const projectId = useProjectStore.getState().addProject(projectName, `/tmp/${projectName}`);
  const agentId = useProjectStore.getState().addAgent(projectId, { kind: "build" })!;
  const name = useProjectStore
    .getState()
    .projects.find((p) => p.id === projectId)!
    .agents.find((a) => a.id === agentId)!.name;
  return { projectId, agentId, name };
}

describe("noteConciergeToolCall", () => {
  it("records the call as in-flight, then settles it", () => {
    const settle = noteConciergeToolCall("terminal", "read_agent_terminal", {});
    expect(latest()).toMatchObject({ domain: "terminal", op: "read_agent_terminal", outcome: "running" });
    settle(true);
    expect(latest()?.outcome).toBe("done");
  });

  // The reply's own `ok` is what the caller must pass. A denial, an unapproved ask-tier tool and a
  // bad-args refusal all resolve normally, so a settle that assumed success reported them as done.
  it("settles a refused call as refused, not as done", () => {
    const settle = noteConciergeToolCall("workflow", "merge_pr", { number: 753 });
    settle(false);
    expect(latest()?.outcome).toBe("refused");
  });

  it("resolves an agent id to the name the human sees", () => {
    const { agentId, name } = seedAgent();
    noteConciergeToolCall("terminal", "read_agent_terminal", { agentId });
    expect(latest()?.subject).toBe(name);
  });

  it("resolves a project id to its name, and a PR to its number", () => {
    const { projectId } = seedAgent("Kraken");
    noteConciergeToolCall("workspace", "select_project", { projectId });
    expect(latest()?.subject).toBe("Kraken");
    noteConciergeToolCall("workflow", "merge_pr", { projectId, number: 753 });
    expect(latest()?.subject).toBe("PR #753");
  });

  // The normal shape of a close: the agent is gone from the store by the time its own reply lands.
  // Null is what the indicator turns into an indefinite phrase; a stale name would be a lie and the
  // raw id would be noise.
  it("records a null subject for an agent no project holds", () => {
    noteConciergeToolCall("lifecycle", "close_agent", { agentId: "ghost" });
    expect(latest()?.subject).toBeNull();
  });

  // The one lie this must not tell: a slow call settling AFTER a newer one started must not flip
  // the newer line's tense to the past while it is still running.
  it("does not settle a line a newer call has already replaced", () => {
    const settleFirst = noteConciergeToolCall("terminal", "read_agent_terminal", {});
    noteConciergeToolCall("workflow", "merge_pr", { number: 1 });
    settleFirst(true);
    expect(latest()).toMatchObject({ op: "merge_pr", outcome: "running" });
  });

  it("hands out a strictly increasing seq so a consumer can date a line", () => {
    noteConciergeToolCall("workspace", "list_projects", {});
    const first = latest()!.seq;
    noteConciergeToolCall("workspace", "list_projects", {});
    expect(latest()!.seq).toBeGreaterThan(first);
  });

  // Settling is idempotent because the caller settles in a `finally` and the surrounding code may
  // grow another exit path; a second call must not resurrect or re-stamp anything.
  it("tolerates being settled twice", () => {
    const settle = noteConciergeToolCall("workspace", "list_projects", {});
    settle(true);
    const after = latest();
    settle(false);
    expect(latest()).toBe(after);
  });
});
