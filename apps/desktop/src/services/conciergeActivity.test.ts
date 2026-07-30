// @vitest-environment jsdom
//
// The recorder behind the thinking indicator. What matters here is that the record is a faithful
// report of a call the app dispatched — the right subject, the right tense, and NOTHING when the
// subject cannot be named.
import { beforeEach, describe, expect, it } from "vitest";

import { useProjectStore } from "../stores/projectStore";
import { conciergeActivityLine } from "../engine/conciergeActivityLine";
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

// ── A SPAWN LEARNS ITS SUBJECT FROM ITS REPLY ───────────────────────────────────────────────────
//
// The one op whose subject does not exist when the call starts: the call is what creates the agent.
// Its id is in the reply and nowhere else, so without this the column could only ever say "Started a
// new agent" — a line with no identity, which is the failure that started this work.
describe("noteConciergeToolCall — a spawn names the agent it created", () => {
  it("starts nameless and resolves to the new agent once the reply lands", () => {
    const { projectId } = seedAgent();
    const spawned = useProjectStore.getState().addAgent(projectId, { kind: "build" })!;
    const name = useProjectStore
      .getState()
      .projects.find((p) => p.id === projectId)!
      .agents.find((a) => a.id === spawned)!.name;

    // The ARGUMENTS carry only the project — there is no agent yet to name.
    const settle = noteConciergeToolCall("lifecycle", "spawn_build_agent", { projectId });
    expect(latest()).toMatchObject({ outcome: "running", agentId: null });

    settle(true, { agentId: spawned, projectId, provisionalName: name });
    expect(latest()).toMatchObject({ outcome: "done", subject: name, agentId: spawned });
  });

  // A refused spawn created nothing. Reading an id off a refusal's payload would have the column
  // pointing at an agent that does not exist — so no id is taken, and the rendered line names
  // nobody. (The recorded `subject` is still the PROJECT the args named; the spawn's present-tense
  // phrase has no slot, so it is never spoken. Asserted through the line rather than the record, so
  // this pins what the human actually reads.)
  it("names nobody when the spawn was refused", () => {
    const { projectId, agentId } = seedAgent();
    const settle = noteConciergeToolCall("lifecycle", "spawn_build_agent", { projectId });
    settle(false, { agentId });
    expect(latest()).toMatchObject({ outcome: "refused", agentId: null });
    const line = conciergeActivityLine(latest()!);
    expect(line?.text).toBe("Tried starting a new agent");
    expect(line?.agentRef).toBeUndefined();
  });

  // ══ THE "Started web" REGRESSION (roborev 55373) ══════════════════════════════════════════════
  // A spawn's ARGUMENTS are `{ projectId }`, which resolves to the PROJECT. The past tense is
  // "Started %s". So when the settle only overwrote the subject on a successful lookup, a spawn
  // whose new agent was already gone fell through to that leftover subject and rendered
  // "Started web" — naming the project as though it were the agent just created.
  //
  // THE PROJECT MUST RESOLVE for this to be a real test. The case that shipped green settled against
  // an EMPTY store, so the project lookup failed too and the line degraded for the wrong reason.
  // Here the project genuinely exists and only the agent is missing — the actual shape.
  it("names no agent, not the PROJECT, when a successful spawn's agent cannot be resolved", () => {
    const { projectId } = seedAgent("web");
    expect(useProjectStore.getState().projects.find((p) => p.id === projectId)?.name).toBe("web");
    const settle = noteConciergeToolCall("lifecycle", "spawn_build_agent", { projectId });
    // The args-derived subject IS the project at this point — that is the trap.
    expect(latest()?.subject).toBe("web");

    settle(true, { agentId: "closed-before-the-reply-landed", projectId });
    expect(latest()).toMatchObject({ outcome: "done", subject: null, agentId: null });
    expect(conciergeActivityLine(latest()!)?.text).toBe("Started a new agent");
  });

  // THE RULE THAT KEEPS A REPLY FROM RE-POINTING A SENTENCE. Ops that already knew their subject
  // from their arguments keep it, even when their reply echoes a different agent — otherwise a
  // handler's payload could silently rewrite what the line claims the concierge did.
  it("never lets any OTHER op's reply change the subject its arguments named", () => {
    const { agentId, name } = seedAgent();
    const other = useProjectStore.getState().addAgent(
      useProjectStore.getState().projects[0]!.id,
      { kind: "build" },
    )!;
    const settle = noteConciergeToolCall("lifecycle", "close_agent", { agentId });
    settle(true, { agentId: other });
    expect(latest()).toMatchObject({ subject: name, agentId });
  });

  // The id rides with the NAME or not at all. An id whose agent is no longer in the store is the
  // closed-or-discarded case, and the founder's rule for it is explicit: never a dead link, and
  // never a guess at a different agent.
  it("carries no agent id when the lookup failed, so nothing can draw a dead pill", () => {
    noteConciergeToolCall("terminal", "read_agent_terminal", { agentId: "gone" });
    expect(latest()).toMatchObject({ subject: null, agentId: null });
  });

  it("carries the id alongside the name for an agent that does resolve", () => {
    const { agentId, name } = seedAgent();
    noteConciergeToolCall("terminal", "read_agent_terminal", { agentId });
    expect(latest()).toMatchObject({ subject: name, agentId });
  });

  // Projects and PRs fill the same sentence slot and are emphatically not agents. A pill built from
  // a project id would open an agent that does not exist — or, worse, one that does.
  it("never carries an agent id for a project or a PR subject", () => {
    const { projectId } = seedAgent();
    noteConciergeToolCall("workspace", "select_project", { projectId });
    expect(latest()?.agentId).toBeNull();
    noteConciergeToolCall("workflow", "merge_pr", { number: 753 });
    expect(latest()?.agentId).toBeNull();
  });
});
