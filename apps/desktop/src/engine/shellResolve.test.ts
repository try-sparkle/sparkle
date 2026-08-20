// resolvePromptTarget decides which agent the concierge compose box may prompt directly.
//
// The cloud case is still the load-bearing one, but it flipped (design 2026-08-01 §Decision 7).
// It used to return null with "Cloud agents take prompts in the terminal for now", because dispatch
// wrote only through submitPrompt/writePty and a cloud agent has no local PTY — so a target here
// would have swallowed the prompt into a pty-gone dead end. `dispatchConciergeAnswer` now routes a
// cloud PROMPT through `getTransport` to the sandbox's stdin, so a cloud tab IS a promptable target
// and the old refusal copy would be advice to work around a feature that works. What a cloud agent
// still cannot take is an ANSWER to a prompt on its own screen, and that refusal lives at the
// dispatcher — which reads the screen — not in this resolver, which cannot see one.
import { describe, expect, it } from "vitest";

import {
  decidePromptTarget,
  resolveMountedTarget,
  resolvePinnedProjectId,
  resolvePromptTarget,
  type MountedAgentFacts,
} from "./shellResolve";
import type { AgentTab, Project, Runtime } from "../types";

function mkAgent(runtime: Runtime, id = "a1"): AgentTab {
  return {
    id,
    name: `Agent ${id}`,
    kind: "build",
    parentId: null,
    runtime,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "",
    promptHistory: [],
    namePinned: false,
    autoNameBasis: null,
    autoNameVariants: null,
    shellCommand: null,
  };
}

function mkProject(agents: AgentTab[]): Project {
  return {
    id: "p1",
    name: "Demo",
    rootPath: "/tmp/demo",
    defaultBranch: null,
    createdAt: new Date(0).toISOString(),
    selectedAgentId: null,
    agents,
  };
}

describe("resolvePromptTarget", () => {
  it("targets a local agent by id", () => {
    const t = resolvePromptTarget(mkProject([mkAgent("local")]), "a1");
    expect(t).toEqual({ projectId: "p1", agentId: "a1", name: expect.any(String) });
  });

  it("returns a TARGET for a cloud agent — the box can prompt one now", () => {
    // The assertion that fails if the early return comes back: dispatch relays a cloud prompt to
    // the sandbox's stdin (services/conciergeDispatch.cloud.test.ts pins the emit), so refusing the
    // target here would disable a working path and tell the user to go and type in the terminal.
    expect(resolvePromptTarget(mkProject([mkAgent("cloud")]), "a1")).toEqual({
      projectId: "p1",
      agentId: "a1",
      name: expect.any(String),
    });
  });

  it("returns null when the selection names a missing agent, project, or nothing", () => {
    expect(resolvePromptTarget(mkProject([mkAgent("local")]), "ghost")).toBeNull();
    expect(resolvePromptTarget(null, "a1")).toBeNull();
    expect(resolvePromptTarget(mkProject([mkAgent("local")]), null)).toBeNull();
  });
});

describe("resolvePinnedProjectId", () => {
  it("keeps a pin that names a live project and drops a dangling one", () => {
    const p = mkProject([]);
    expect(resolvePinnedProjectId([p], "p1")).toBe("p1");
    expect(resolvePinnedProjectId([p], "gone")).toBeNull();
    expect(resolvePinnedProjectId([p], null)).toBeNull();
  });
});

describe("decidePromptTarget", () => {
  // One decision carries both halves, so a refusal cannot ship without the copy that explains it
  // (roborev 49295/52649) — a second `return null` in a separate resolver would have left the
  // toggle saying "select an agent" about an agent the user can see is selected.
  it("has NO refusal for a cloud selection — there is nothing left to explain", () => {
    const d = decidePromptTarget(mkProject([mkAgent("cloud")]), "a1");
    expect(d.target).toMatchObject({ agentId: "a1" });
    // Specifically NOT the old "Cloud agents take prompts in the terminal for now": a refusal
    // string is an instruction (AGENTS.md), and this one would now instruct the user around a path
    // that delivers. A stale copy left behind here would still have passed a `target === null`
    // assertion, so the copy is asserted absent rather than merely the target present.
    expect(d.refusal).toBeUndefined();
  });

  it("has no refusal when the target resolved", () => {
    const d = decidePromptTarget(mkProject([mkAgent("local")]), "a1");
    expect(d.target).toMatchObject({ agentId: "a1" });
    expect(d.refusal).toBeUndefined();
  });

  it("has no refusal when nothing is selected at all — the default copy is right there", () => {
    expect(decidePromptTarget(mkProject([mkAgent("local")]), null).refusal).toBeUndefined();
    expect(decidePromptTarget(mkProject([mkAgent("local")]), "ghost").refusal).toBeUndefined();
    expect(decidePromptTarget(null, "a1").refusal).toBeUndefined();
  });

  // ══ THE `special` ARM HAD NO COVERAGE AT ALL, AND THAT IS PART OF WHY IT KEPT BITING ══════════
  // It is the Improve-Sparkle pane's target, and it is the load-bearing half of the founder's
  // reproduction B (bead sparkle-9gsjqm): it WINS over the roster path, so merely revealing that pane
  // replaced the compose box's target — and, while the routing mount was derived from this value, the
  // mount with it. Pinned here as data so the precedence is a stated rule rather than an accident of
  // a `if (special)` sitting at the top of the function.
  const SPARKLE_SPECIAL = { projectId: "", agentId: "__sparkle_self__", name: "Sparkle" };

  it("takes the SPECIAL surface's target over the roster's, even with a live selection", () => {
    const d = decidePromptTarget(mkProject([mkAgent("local")]), "a1", SPARKLE_SPECIAL);
    expect(d.target).toEqual(SPARKLE_SPECIAL);
    expect(d.refusal).toBeUndefined();
  });

  it("takes the SPECIAL surface's target with no project and no selection at all", () => {
    // The state the Improve-Sparkle pane is actually in for a user with zero build agents — the case
    // bead sparkle-0rf5 added the arm for. A roster lookup can never resolve this agent.
    expect(decidePromptTarget(null, null, SPARKLE_SPECIAL).target).toEqual(SPARKLE_SPECIAL);
  });

  it("falls back to the roster the moment the special surface is gone", () => {
    // `null`/`undefined` are the two shapes `Workspace`'s `sparkleTarget` memo produces when
    // `activeSpecial !== "sparkle"`, and both must return the SELECTION rather than nothing —
    // otherwise navigating away from that pane zeroes the compose box.
    const p = mkProject([mkAgent("local")]);
    expect(decidePromptTarget(p, "a1", null).target).toMatchObject({ agentId: "a1" });
    expect(decidePromptTarget(p, "a1", undefined).target).toMatchObject({ agentId: "a1" });
  });

  it("resolvePromptTarget is the same decision, target half only", () => {
    // A REFUSING case, so this pins "same decision" rather than "both happen to resolve": a
    // torn-apart pair would agree on a null target for a missing agent by coincidence.
    const p = mkProject([mkAgent("local")]);
    expect(resolvePromptTarget(p, "ghost")).toBe(decidePromptTarget(p, "ghost").target);
    expect(resolvePromptTarget(p, "a1")).toEqual(decidePromptTarget(p, "a1").target);
  });
});

// ══ WHERE A MOUNTED SEND GOES ═══════════════════════════════════════════════════════════════════
// The founder's recurring P0 (bead sparkle-9gsjqm): text typed into a mounted build-agent pane
// silently became a concierge message. The routing mount used to be the DRAWING projection ANDed
// with `decidePromptTarget`'s answer — three surface predicates and a liveness read between his
// mounting gesture and where his words went. This function is what removes them: the mount is the
// cable's own pin, and nothing else.
describe("resolveMountedTarget", () => {
  const SPARKLE_ID = "__sparkle_self__";
  /** This window's two ways of naming a far end, exactly as ConciergeHost supplies them: the roster
   *  row, and the app-owned agent that deliberately has none (services/knownAgents). */
  const lookup = (id: string): MountedAgentFacts | undefined => {
    if (id === "a1") return { name: "Blueprint UI/UX", projectId: "p1" };
    if (id === SPARKLE_ID) return { name: "Sparkle", projectId: "" };
    return undefined;
  };

  it("routes at the PINNED agent, whichever side the cable is patched into", () => {
    expect(resolveMountedTarget({ wired: "left", agentId: "a1" }, lookup)).toEqual({
      kind: "mounted",
      target: { projectId: "p1", agentId: "a1", name: "Blueprint UI/UX" },
    });
    expect(resolveMountedTarget({ wired: "right", agentId: "a1" }, lookup)).toEqual({
      kind: "mounted",
      target: { projectId: "p1", agentId: "a1", name: "Blueprint UI/UX" },
    });
  });

  it("resolves the app-owned Sparkle agent, which is never a roster row", () => {
    // The mount `decidePromptTarget` can only reach through its `special` arm — and therefore only
    // while that pane is the visible surface. Here it resolves from the PIN, so navigating the right
    // column away cannot evaporate it (the founder's reproduction A).
    expect(resolveMountedTarget({ wired: "right", agentId: SPARKLE_ID }, lookup)).toEqual({
      kind: "mounted",
      target: { projectId: "", agentId: SPARKLE_ID, name: "Sparkle" },
    });
  });

  // ══ THE PRECEDENCE THAT FIXES REPRODUCTION B ══════════════════════════════════════════════════
  // `decidePromptTarget`'s special arm wins over the roster — pinned three cases up — and while the
  // mount was derived from THAT value, revealing the Improve-Sparkle pane re-aimed a mounted build
  // agent at `__sparkle_self__`. This function cannot be told about a visible pane at all, which is
  // the fix: the two resolvers are handed the SAME state below and disagree, deliberately.
  it("a visible special surface cannot move a pinned cable", () => {
    const cable = { wired: "right", agentId: "a1" } as const;
    const shown = decidePromptTarget(mkProject([mkAgent("local", "a1")]), "a1", {
      projectId: "",
      agentId: SPARKLE_ID,
      name: "Sparkle",
    });
    // What the compose box is aimed at while that pane is up…
    expect(shown.target).toMatchObject({ agentId: SPARKLE_ID });
    // …and where a MOUNTED send goes anyway. A pane becoming visible is not a mounting gesture.
    expect(resolveMountedTarget(cable, lookup)).toEqual({
      kind: "mounted",
      target: { projectId: "p1", agentId: "a1", name: "Blueprint UI/UX" },
    });
  });

  it("an unpatched cable is not a mount, whatever it still holds", () => {
    expect(resolveMountedTarget({ wired: "off", agentId: null }, lookup)).toEqual({ kind: "none" });
    // Both halves are tested, even though `unbindCable` clears them together: a caller can hand this
    // a pair it built itself, and "off with a stale pin" must never route anywhere.
    expect(resolveMountedTarget({ wired: "off", agentId: "a1" }, lookup)).toEqual({ kind: "none" });
    // Patched with no pin at all — the dev visual fixtures drive the cable this way.
    expect(resolveMountedTarget({ wired: "left", agentId: null }, lookup)).toEqual({ kind: "none" });
  });

  // ══ THE ARM THAT MUST NOT COLLAPSE INTO `none` ════════════════════════════════════════════════
  // Flattening this to "nothing is mounted" is the defect: `classifyComposerRoute` would then answer
  // `via: "default"` and the founder's words would become a concierge turn with no refusal and no
  // notice. It is reported as its own kind so the caller has to decide what to say about it.
  it("reports a pin this window cannot name as UNRESOLVABLE, never as unmounted", () => {
    const r = resolveMountedTarget({ wired: "left", agentId: "ghost" }, lookup);
    expect(r).toEqual({ kind: "unresolvable", agentId: "ghost" });
    // Stated as an inequality too, because that is the substitution the bug actually made.
    expect(r).not.toEqual({ kind: "none" });
  });
});
