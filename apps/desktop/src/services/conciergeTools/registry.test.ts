// @vitest-environment jsdom
//
// The concierge tool DISPATCH SPINE. These tests exercise the registry against the REAL four
// domains — only the side-effecting edges below are mocked — because the thing worth proving is
// that the registry does not weaken a guard the domains already have.
//
// Five properties, in the order they matter:
//
//   1. TOTALITY. Every call returns a reply. An unknown domain/op is `unknown-op`, never a throw and
//      never a silent success; an exception anywhere below is `internal-error`.
//   2. COVERAGE. Every op each domain publishes is routed — asserted at RUNTIME as well as by the
//      `Record<DomainOp, Handler>` typecheck, because a Record only catches the mistake at the
//      boundary of this module and only when someone runs tsc.
//   3. ARGUMENTS ARE A SECURITY BOUNDARY. They arrive as untyped JSON a model wrote. A missing
//      field, a wrong type, an unrecognised extra field and a non-object all refuse with `bad-args`
//      NAMING the field.
//   4. THE CONFIRMATION GATES SURVIVE THE TRIP. remove_project / relocate_project / quit_app /
//      discard_agent must still refuse without confirmation — and the assertions check that the
//      underlying destructive call never happened, not merely that `ok` was false.
//   5. THE PTY WRITE IS AUTHORITY-GATED. The only authority the terminal domain ever sees is one
//      `conciergeToolAuthority` built from the wire's toolCallId and the policy decision.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async () => undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...(a as [])) }));

// bd is not available in a unit test; the spawn path fires a best-effort `bd create`.
vi.mock("../tasks", () => ({ createBeadFull: vi.fn(async () => "bd-new") }));

// ── lifecycle's git/bead side effects ───────────────────────────────────────────────────────────
const discardGitMock = vi.fn(async () => {});
const shipWorkMock = vi.fn(async () => {});
const saveWorkMock = vi.fn(async () => {});
const spinDownGitMock = vi.fn(async () => {});
vi.mock("../closeAgentActions", () => ({
  shipAgent: (...a: unknown[]) => shipWorkMock(...(a as [])),
  saveAgent: (...a: unknown[]) => saveWorkMock(...(a as [])),
  discardAgentGit: (...a: unknown[]) => discardGitMock(...(a as [])),
  spinDownAgentGit: (...a: unknown[]) => spinDownGitMock(...(a as [])),
}));
vi.mock("../closeBuildAgent", () => ({ closeBuildAgent: vi.fn(async () => {}) }));
vi.mock("../cloudAgents/terminate", () => ({ terminateIfCloud: vi.fn(async () => {}) }));
vi.mock("../workerSpawn", async (orig) => ({
  ...(await orig<typeof import("../workerSpawn")>()),
  spinDownWorker: vi.fn(async () => {}),
}));

// ── workflow's git edges ────────────────────────────────────────────────────────────────────────
const branchStatusMock = vi.fn(async () => ({
  ahead: 0,
  behind: 0,
  dirty: false,
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
  worktreeOnBranch: true,
}));
const pushMock = vi.fn(async () => "pushed" as const);
vi.mock("../branchStatus", () => ({
  refreshAgentBranch: vi.fn(async () => ({ ok: true, ahead: 0, behind: 0 })),
  landAgentBranch: vi.fn(async () => ({ ok: true, target: "main", mergeSha: "abc" })),
  pushAgentBranch: (...a: unknown[]) => pushMock(...(a as [])),
  openAgentPr: vi.fn(async () => "https://example.test/pr/1"),
  deleteAgentBranch: vi.fn(async () => {}),
  deleteAgentBranchIfMerged: vi.fn(async () => {}),
  agentBranchStatus: (...a: unknown[]) => branchStatusMock(...(a as [])),
  agentWorkflowState: vi.fn(async () => ({
    inLocalMain: false,
    inOriginMain: false,
    landed: false,
    aheadOfBase: 2,
    shipped: false,
  })),
  projectAgentsStatus: vi.fn(async () => []),
}));
const mergePrMock = vi.fn(async () => {});
vi.mock("../openPrs", async (orig) => ({
  ...(await orig<typeof import("../openPrs")>()),
  fetchOpenPrs: vi.fn(async () => []),
  mergePr: (...a: unknown[]) => mergePrMock(...(a as [])),
}));

// ── terminal's write edge. The single most important mock here: every refusal test asserts against
//    it, because `ok: false` alone would still pass if the text had gone out. ────────────────────
const dispatchAnswerMock = vi.fn(
  async (agentId: string, text: string, _opts?: { authority?: unknown; userPrompt?: boolean }) => ({
    ok: true,
    agentId,
    path: "free-text" as const,
    display: text,
  }),
);
vi.mock("../conciergeDispatch", async (orig) => ({
  ...(await orig<typeof import("../conciergeDispatch")>()),
  agentCanAcceptInput: vi.fn(() => true),
  dispatchConciergeAnswer: (...a: unknown[]) =>
    dispatchAnswerMock(...(a as [string, string, undefined])),
}));
vi.mock("../terminalScrollback", async (orig) => ({
  ...(await orig<typeof import("../terminalScrollback")>()),
  getAgentScrollback: vi.fn(() => "the agent is asking something"),
}));

// ── workspace's native edges ────────────────────────────────────────────────────────────────────
const moveProjectFolderMock = vi.fn(async () => {});
vi.mock("../worktree", async (orig) => ({
  ...(await orig<typeof import("../worktree")>()),
  ensureProjectRepo: vi.fn(async () => {}),
  moveProjectFolder: (...a: unknown[]) => moveProjectFolderMock(...(a as [])),
}));
const quitAppNativeMock = vi.fn(() => {});
vi.mock("../attention", async (orig) => ({
  ...(await orig<typeof import("../attention")>()),
  quitApp: () => quitAppNativeMock(),
}));
vi.mock("../helper", async (orig) => ({
  ...(await orig<typeof import("../helper")>()),
  showMainWindow: vi.fn(() => {}),
  setHelperBounds: vi.fn(() => {}),
}));

import {
  CONCIERGE_TOOL_DOMAINS,
  CONCIERGE_TOOL_OPS,
  REGISTRY_CODES,
  dispatchConciergeTool,
  permissiveToolPolicy,
  type ConciergeToolCall,
  type ConciergeToolPolicy,
  type ConciergeToolReply,
  type ToolPolicyQuery,
} from "./registry";
import { DISCARD_CONFIRM_TOKEN } from "./lifecycle";
import { useProjectStore } from "../../stores/projectStore";
import { useRuntimeStore } from "../../stores/runtimeStore";
import { useUiStore } from "../../stores/uiStore";
import type { DispatchAuthority } from "../dispatchAuthority";

const TOOL_CALL_ID = "tc-0001";

function call(over: Partial<ConciergeToolCall>): ConciergeToolCall {
  return { domain: "workspace", op: "list_projects", args: {}, toolCallId: TOOL_CALL_ID, ...over };
}

/** Narrow to the refusal arm with a readable failure when it is unexpectedly `ok`. */
function refusal(r: ConciergeToolReply): { code: string; message: string } {
  if (r.ok) throw new Error(`expected a refusal, got ok with data ${JSON.stringify(r.data)}`);
  return { code: r.code, message: r.message };
}

function seedProject(name = "Demo", root = "/tmp/demo"): string {
  return useProjectStore.getState().addProject(name, root);
}

function seedBuild(projectId: string): string {
  const store = useProjectStore.getState();
  const id = store.addAgent(projectId, { kind: "build" })!;
  store.setAgentWorktree(projectId, id, `/wt/${id}`, `sparkle/agent-${id}`);
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
  useRuntimeStore.setState({
    status: {},
    openAgentIds: [],
    branchStatus: {},
    workflowStage: {},
    attentionScreen: {},
  } as never);
  useUiStore.setState({ openProjectIds: [], pinnedProjectId: null } as never);
});

// ---------------------------------------------------------------------------------------------
// 1. Totality
// ---------------------------------------------------------------------------------------------

describe("dispatchConciergeTool — totality", () => {
  it("refuses an unknown DOMAIN with unknown-op, echoing what was asked for", async () => {
    const r = await dispatchConciergeTool(call({ domain: "filesystem", op: "rm_rf" }));
    expect(r.ok).toBe(false);
    expect(refusal(r).code).toBe(REGISTRY_CODES.unknownOp);
    expect(r.domain).toBe("filesystem");
    expect(r.op).toBe("rm_rf");
    // The message has to be actionable: a model that guessed a domain needs the real list.
    expect(refusal(r).message).toContain("workspace");
  });

  it("refuses an unknown OP inside a known domain, listing that domain's ops", async () => {
    const r = await dispatchConciergeTool(call({ domain: "lifecycle", op: "delete_everything" }));
    expect(refusal(r).code).toBe(REGISTRY_CODES.unknownOp);
    expect(refusal(r).message).toContain("spawn_build_agent");
  });

  // A model can send anything. None of it may reach a route table as a lookup key, and none of it
  // may throw: on the other end of this call is a bridge round-trip whose failure mode is a HANG.
  it.each([
    ["a non-string domain", { domain: 42 as unknown as string }],
    ["a non-string op", { op: null as unknown as string }],
    ["a prototype-pollution key", { domain: "lifecycle", op: "__proto__" }],
    ["a Object.prototype method name", { domain: "workspace", op: "toString" }],
  ])("refuses %s with unknown-op rather than throwing", async (_label, over) => {
    const r = await dispatchConciergeTool(call(over));
    expect(refusal(r).code).toBe(REGISTRY_CODES.unknownOp);
  });

  it("turns an unexpected exception into internal-error instead of rejecting", async () => {
    const spy = vi.spyOn(useProjectStore, "getState").mockImplementationOnce(() => {
      throw new Error("store exploded");
    });
    const r = await dispatchConciergeTool(call({ domain: "workspace", op: "list_projects" }));
    expect(refusal(r).code).toBe(REGISTRY_CODES.internalError);
    expect(refusal(r).message).toContain("store exploded");
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Coverage
// ---------------------------------------------------------------------------------------------

describe("dispatchConciergeTool — coverage", () => {
  // The typecheck (Record<DomainOp, Handler>) is the real guarantee; this is the runtime half, and
  // it is what catches a domain whose op list and route table were both edited but inconsistently.
  it("routes every op every domain publishes — none answers unknown-op", async () => {
    const unrouted: string[] = [];
    for (const domain of CONCIERGE_TOOL_DOMAINS) {
      for (const op of CONCIERGE_TOOL_OPS[domain]) {
        // Empty args: most ops refuse with bad-args, which is fine — we are asserting the ROUTE
        // exists, and the store is empty so nothing here has anything to act on.
        const r = await dispatchConciergeTool(call({ domain, op, args: {} }));
        if (!r.ok && r.code === REGISTRY_CODES.unknownOp) unrouted.push(`${domain}.${op}`);
      }
    }
    expect(unrouted).toEqual([]);
  });

  it("publishes an op list per domain that is non-empty and free of duplicates", () => {
    for (const domain of CONCIERGE_TOOL_DOMAINS) {
      const ops = CONCIERGE_TOOL_OPS[domain];
      expect(ops.length).toBeGreaterThan(0);
      expect(new Set(ops).size).toBe(ops.length);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Argument validation
// ---------------------------------------------------------------------------------------------

describe("dispatchConciergeTool — argument validation", () => {
  it("names the MISSING field", async () => {
    const r = await dispatchConciergeTool(call({ domain: "lifecycle", op: "preview_close", args: {} }));
    expect(refusal(r).code).toBe(REGISTRY_CODES.badArgs);
    expect(refusal(r).message).toContain("agentId");
  });

  it("names a field of the WRONG TYPE", async () => {
    const r = await dispatchConciergeTool(
      call({ domain: "lifecycle", op: "preview_close", args: { agentId: 42 } }),
    );
    expect(refusal(r).code).toBe(REGISTRY_CODES.badArgs);
    expect(refusal(r).message).toContain("agentId");
  });

  it("refuses an UNRECOGNISED field rather than silently dropping it", async () => {
    const r = await dispatchConciergeTool(
      call({
        domain: "lifecycle",
        op: "preview_close",
        args: { agentId: "a1", andAlsoDeleteEverything: true },
      }),
    );
    expect(refusal(r).code).toBe(REGISTRY_CODES.badArgs);
    expect(refusal(r).message).toContain("andAlsoDeleteEverything");
  });

  it("refuses args that are not an object at all", async () => {
    const r = await dispatchConciergeTool(
      call({ domain: "lifecycle", op: "preview_close", args: "a1" }),
    );
    expect(refusal(r).code).toBe(REGISTRY_CODES.badArgs);
  });

  it("treats absent args as {} so an arg-less op is callable", async () => {
    const r = await dispatchConciergeTool(
      call({ domain: "workspace", op: "list_projects", args: undefined }),
    );
    expect(r.ok).toBe(true);
  });

  it("refuses a non-integer PR number instead of forwarding it to gh", async () => {
    const projectId = seedProject();
    const r = await dispatchConciergeTool(
      call({ domain: "workflow", op: "pr_checks_status", args: { projectId, number: 1.5 } }),
    );
    expect(refusal(r).code).toBe(REGISTRY_CODES.badArgs);
    expect(refusal(r).message).toContain("number");
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Normalization — four result conventions, one reply
// ---------------------------------------------------------------------------------------------

describe("dispatchConciergeTool — normalization", () => {
  it("lifecycle: an ok result becomes { ok, data } carrying the domain's payload", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    const r = await dispatchConciergeTool(
      call({ domain: "lifecycle", op: "preview_close", args: { agentId } }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.domain).toBe("lifecycle");
    expect(r.op).toBe("preview_close");
    // The whole ClosePreview survives the trip, nested discard preview included — the reply's
    // `data` is the domain's payload, not a summary of it.
    expect(r.data).toMatchObject({
      agentId,
      projectId,
      discardPreview: { agentId, irreversible: true },
    });
  });

  it("lifecycle: a refusal FORWARDS the domain's own machine-readable reason as the code", async () => {
    const r = await dispatchConciergeTool(
      call({ domain: "lifecycle", op: "preview_close", args: { agentId: "nope" } }),
    );
    // Not a generic error — "unknown-agent" is lifecycle's own vocabulary, and a caller that could
    // branch on it before must still be able to.
    expect(refusal(r).code).toBe("unknown-agent");
  });

  it("workspace: an ok result unwraps `value` (workspace's success field is not `data`)", async () => {
    seedProject("One", "/tmp/one");
    const r = await dispatchConciergeTool(call({ domain: "workspace", op: "list_projects" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Array.isArray(r.data)).toBe(true);
    expect((r.data as Array<{ name: string }>)[0]!.name).toBe("One");
  });

  it("workspace: a refusal forwards its reason", async () => {
    const r = await dispatchConciergeTool(
      call({ domain: "workspace", op: "select_project", args: { projectId: "ghost" } }),
    );
    expect(refusal(r).code).toBe("unknown-project");
  });

  it("workflow: resolves the repo context from the STORE, never from the caller", async () => {
    const projectId = seedProject("Repo", "/repos/app");
    const agentId = seedBuild(projectId);
    const r = await dispatchConciergeTool(
      call({ domain: "workflow", op: "agent_branch_status", args: { agentId } }),
    );
    expect(r.ok).toBe(true);
    // The root handed to the service is the PROJECT's rootPath — the model never supplied one and
    // has no way to supply one.
    expect(branchStatusMock).toHaveBeenCalledWith("/repos/app", projectId, agentId, "");
  });

  it("workflow: an agent id nothing recognises refuses with unknown-agent, touching no git", async () => {
    const r = await dispatchConciergeTool(
      call({ domain: "workflow", op: "push_agent_branch", args: { agentId: "invented" } }),
    );
    expect(refusal(r).code).toBe(REGISTRY_CODES.unknownAgent);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("workflow: a domain refusal keeps its WorkflowFailureCode", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    // No baseBranch was ever set on this agent, so a rebase has no target — workflow's own
    // "no-target" refusal, reached before any git call.
    const r = await dispatchConciergeTool(
      call({ domain: "workflow", op: "refresh_agent_branch", args: { agentId } }),
    );
    expect(refusal(r).code).toBe("no-target");
  });

  it("workflow: merge_pr's squash/auto refusals come from the DOMAIN, not from the schema", async () => {
    const projectId = seedProject();
    const r = await dispatchConciergeTool(
      call({ domain: "workflow", op: "merge_pr", args: { projectId, number: 7, method: "squash" } }),
    );
    // invalid-request is mergePrTool's code; the message is the one that explains WHY (ancestry),
    // which a bad-args error naming a field would have thrown away.
    expect(refusal(r).code).toBe("invalid-request");
    expect(refusal(r).message).toContain("MERGE COMMIT");
    expect(mergePrMock).not.toHaveBeenCalled();
  });

  it("terminal: a read always succeeds and reports its source", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    const r = await dispatchConciergeTool(
      call({ domain: "terminal", op: "read_agent_terminal", args: { agentId } }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ agentId, source: "scrollback", freshness: "live" });
  });

  it("terminal: a refused send forwards the dispatcher's path as the code", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    dispatchAnswerMock.mockResolvedValueOnce({
      ok: false,
      agentId,
      path: "ambiguous-picker" as never,
      display: "",
    });
    const r = await dispatchConciergeTool(
      call({ domain: "terminal", op: "send_to_agent_terminal", args: { agentId, text: "hi" } }),
    );
    expect(refusal(r).code).toBe("ambiguous-picker");
  });
});

// ---------------------------------------------------------------------------------------------
// 5. The confirmation gates
// ---------------------------------------------------------------------------------------------

describe("dispatchConciergeTool — destructive ops still require confirmation", () => {
  it("remove_project without confirm refuses AND leaves the project in place", async () => {
    const projectId = seedProject();
    const r = await dispatchConciergeTool(
      call({ domain: "workspace", op: "remove_project", args: { projectId } }),
    );
    expect(refusal(r).code).toBe("confirmation-required");
    expect(useProjectStore.getState().projects.map((p) => p.id)).toContain(projectId);
  });

  it("remove_project with confirm: true goes through", async () => {
    const projectId = seedProject();
    const r = await dispatchConciergeTool(
      call({ domain: "workspace", op: "remove_project", args: { projectId, confirm: true } }),
    );
    expect(r.ok).toBe(true);
    expect(useProjectStore.getState().projects.map((p) => p.id)).not.toContain(projectId);
  });

  // A truthy-but-not-true confirm is exactly the shape a mis-parsed model argument takes. It must
  // not spend as consent.
  it.each([["yes"], [1], [{}], [null]])(
    "remove_project refuses a non-boolean confirm (%s) rather than coercing it",
    async (confirm) => {
      const projectId = seedProject();
      const r = await dispatchConciergeTool(
        call({ domain: "workspace", op: "remove_project", args: { projectId, confirm } }),
      );
      expect(r.ok).toBe(false);
      expect(useProjectStore.getState().projects.map((p) => p.id)).toContain(projectId);
    },
  );

  it("relocate_project without confirm refuses AND never moves the folder", async () => {
    const projectId = seedProject("Demo", "/tmp/demo");
    const r = await dispatchConciergeTool(
      call({
        domain: "workspace",
        op: "relocate_project",
        args: { projectId, newPath: "/tmp/elsewhere" },
      }),
    );
    expect(refusal(r).code).toBe("confirmation-required");
    expect(moveProjectFolderMock).not.toHaveBeenCalled();
  });

  it("quit_app without confirm refuses AND never quits", async () => {
    const r = await dispatchConciergeTool(call({ domain: "workspace", op: "quit_app", args: {} }));
    expect(refusal(r).code).toBe("confirmation-required");
    expect(quitAppNativeMock).not.toHaveBeenCalled();
  });

  it("discard_agent with NO intent refuses AND never reaches the git delete", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    const r = await dispatchConciergeTool(
      call({ domain: "lifecycle", op: "discard_agent", args: { agentId } }),
    );
    // lifecycle's own gate produced this — the registry forwarded the intent (absent) rather than
    // pre-validating it into a bad-args error, so the message is the one that says what to send.
    expect(refusal(r).code).toBe("intent-required");
    expect(refusal(r).message).toContain(DISCARD_CONFIRM_TOKEN);
    expect(discardGitMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a boolean instead of the token", { confirm: true, agentId: "SELF" }],
    ["the wrong token", { confirm: "yes", agentId: "SELF" }],
    ["no agent id", { confirm: DISCARD_CONFIRM_TOKEN }],
  ])("discard_agent refuses %s, and nothing is deleted", async (_label, intent) => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    const filled = { ...intent, ...("agentId" in intent ? { agentId } : {}) };
    const r = await dispatchConciergeTool(
      call({ domain: "lifecycle", op: "discard_agent", args: { agentId, intent: filled } }),
    );
    expect(r.ok).toBe(false);
    expect(discardGitMock).not.toHaveBeenCalled();
  });

  it("discard_agent refuses an intent naming a DIFFERENT agent", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    const other = seedBuild(projectId);
    const r = await dispatchConciergeTool(
      call({
        domain: "lifecycle",
        op: "discard_agent",
        args: { agentId, intent: { confirm: DISCARD_CONFIRM_TOKEN, agentId: other } },
      }),
    );
    expect(refusal(r).code).toBe("intent-mismatch");
    expect(discardGitMock).not.toHaveBeenCalled();
  });

  it("discard_agent with a well-formed, agent-matched intent DOES run", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    const r = await dispatchConciergeTool(
      call({
        domain: "lifecycle",
        op: "discard_agent",
        args: { agentId, intent: { confirm: DISCARD_CONFIRM_TOKEN, agentId } },
      }),
    );
    expect(r.ok).toBe(true);
    expect(discardGitMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------------
// 6. The policy seam
// ---------------------------------------------------------------------------------------------

describe("dispatchConciergeTool — the policy seam", () => {
  it("defaults to permissiveToolPolicy, which is allow-everything and says so", () => {
    expect(
      permissiveToolPolicy({
        domain: "workspace",
        op: "quit_app",
        write: true,
        toolCallId: "x",
        args: {},
      }),
    ).toEqual({ tier: "allow" });
  });

  it("is consulted with the domain, the op, the toolCallId, the args and the domain's own write flag", async () => {
    const seen: ToolPolicyQuery[] = [];
    const policy: ConciergeToolPolicy = (q) => {
      seen.push(q);
      return { tier: "allow" };
    };
    seedProject();
    await dispatchConciergeTool(call({ domain: "workspace", op: "list_projects" }), { policy });
    await dispatchConciergeTool(
      call({ domain: "workspace", op: "quit_app", args: { confirm: true } }),
      { policy },
    );
    expect(seen[0]).toEqual({
      domain: "workspace",
      op: "list_projects",
      write: false,
      toolCallId: TOOL_CALL_ID,
      args: {},
    });
    expect(seen[1]).toMatchObject({ op: "quit_app", write: true });
    // The RAW args, forwarded verbatim and unparsed — an ask-tier policy needs them to scope one
    // human approval to one specific call ("approve this quit", not "may always quit").
    expect(seen[1]!.args).toEqual({ confirm: true });
  });

  it("classifies the read-only ops of every domain as write: false", async () => {
    const seen = new Map<string, boolean>();
    const policy: ConciergeToolPolicy = (q) => {
      seen.set(`${q.domain}.${q.op}`, q.write);
      return { tier: "deny", reason: "measuring only" };
    };
    const reads: Array<[string, string]> = [
      ["lifecycle", "preview_close"],
      ["lifecycle", "preview_discard"],
      ["terminal", "read_agent_terminal"],
      ["terminal", "get_agent_status"],
      ["workflow", "agent_branch_status"],
      ["workspace", "list_projects"],
    ];
    const writes: Array<[string, string]> = [
      ["lifecycle", "discard_agent"],
      ["terminal", "send_to_agent_terminal"],
      ["workflow", "merge_pr"],
      ["workspace", "remove_project"],
    ];
    for (const [domain, op] of [...reads, ...writes]) {
      await dispatchConciergeTool(call({ domain, op, args: {} }), { policy });
    }
    for (const [domain, op] of reads) expect(seen.get(`${domain}.${op}`)).toBe(false);
    for (const [domain, op] of writes) expect(seen.get(`${domain}.${op}`)).toBe(true);
  });

  it("a DENY refuses before the op runs — and before the arguments are even validated", async () => {
    const projectId = seedProject();
    const policy: ConciergeToolPolicy = () => ({ tier: "deny", reason: "the human said no" });
    const r = await dispatchConciergeTool(
      // Deliberately malformed args: a denial must read as a denial, not leak which arguments it
      // would have wanted.
      call({ domain: "workspace", op: "remove_project", args: { nonsense: true } }),
      { policy },
    );
    expect(refusal(r).code).toBe(REGISTRY_CODES.denied);
    expect(refusal(r).message).toContain("the human said no");
    expect(useProjectStore.getState().projects.map((p) => p.id)).toContain(projectId);
  });

  it("an ASK nobody has approved is needs-approval, not a run", async () => {
    const projectId = seedProject();
    const policy: ConciergeToolPolicy = () => ({ tier: "ask", approvedByUser: false });
    const r = await dispatchConciergeTool(
      call({ domain: "workspace", op: "remove_project", args: { projectId, confirm: true } }),
      { policy },
    );
    expect(refusal(r).code).toBe(REGISTRY_CODES.needsApproval);
    expect(useProjectStore.getState().projects.map((p) => p.id)).toContain(projectId);
    // HONEST AND ACTIONABLE. The old copy said only "needs your go-ahead", which promised a prompt
    // that did not exist and named no way to change the setting — so the model's only recourse was
    // to keep re-calling a tool that could never succeed. It must now say what is pending, how to
    // retry, and exactly which config key turns the asking off.
    const message = refusal(r).message;
    expect(message).toContain("approval request in your Sparkle column");
    expect(message).toContain("tell me to go ahead");
    expect(message).toContain("concierge.tools.remove_project");
    expect(message).toContain("Settings → Concierge tools");
  });

  it("says so honestly when there is no tool-call id to hang an approval on", async () => {
    const projectId = seedProject();
    const policy: ConciergeToolPolicy = () => ({ tier: "ask", approvedByUser: false });
    const r = await dispatchConciergeTool(
      call({
        domain: "workspace",
        op: "remove_project",
        args: { projectId, confirm: true },
        toolCallId: "",
      }),
      { policy },
    );
    expect(refusal(r).code).toBe(REGISTRY_CODES.needsApproval);
    // Never claim a prompt was raised when none could be — the ledger refuses a blank id.
    expect(refusal(r).message).toContain("no tool-call id");
    expect(refusal(r).message).toContain("concierge.tools.remove_project");
  });

  it("an ASK the user approved runs", async () => {
    const projectId = seedProject();
    const policy: ConciergeToolPolicy = (q) => ({
      tier: "ask",
      approvedByUser: true,
      // An approval is now bound to ONE call id, so it cannot be replayed for another.
      approvedForToolCallId: q.toolCallId,
    });
    const r = await dispatchConciergeTool(
      call({ domain: "workspace", op: "remove_project", args: { projectId, confirm: true } }),
      { policy },
    );
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// 7. The PTY write authority
// ---------------------------------------------------------------------------------------------

describe("dispatchConciergeTool — terminal writes carry a constructed authority", () => {
  /** The authority the dispatcher was actually handed. */
  function authorityUsed(): DispatchAuthority {
    const lastCall = dispatchAnswerMock.mock.calls.at(-1);
    if (!lastCall) throw new Error("the dispatcher was never called");
    const opts = lastCall[2] as { authority?: DispatchAuthority } | undefined;
    if (!opts?.authority) throw new Error("the dispatcher was called with no authority at all");
    return opts.authority;
  }

  it("an allow-tier policy produces a concierge-tool authority carrying the WIRE's toolCallId", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    const r = await dispatchConciergeTool(
      call({ domain: "terminal", op: "send_to_agent_terminal", args: { agentId, text: "carry on" } }),
    );
    expect(r.ok).toBe(true);
    expect(authorityUsed()).toEqual({
      kind: "concierge-tool",
      toolCallId: TOOL_CALL_ID,
      policy: "allow",
    });
  });

  it("an approved ask-tier policy is recorded as `approved`, not as `allow`", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    const policy: ConciergeToolPolicy = (q) => ({
      tier: "ask",
      approvedByUser: true,
      // An approval is now bound to ONE call id, so it cannot be replayed for another.
      approvedForToolCallId: q.toolCallId,
    });
    await dispatchConciergeTool(
      call({ domain: "terminal", op: "send_to_agent_terminal", args: { agentId, text: "ok" } }),
      { policy },
    );
    // The two are different facts — a standing policy versus a human answering this prompt — and the
    // audit line has to be able to say which.
    expect(authorityUsed()).toMatchObject({ policy: "approved" });
  });

  it("a BLANK toolCallId refuses the write: there is nothing to attribute it to", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    const r = await dispatchConciergeTool({
      domain: "terminal",
      op: "send_to_agent_terminal",
      args: { agentId, text: "sneak this in" },
      toolCallId: "   ",
    });
    expect(refusal(r).code).toBe(REGISTRY_CODES.unauthorized);
    expect(dispatchAnswerMock).not.toHaveBeenCalled();
  });

  it("a DENIED tool never reaches the terminal at all", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    const policy: ConciergeToolPolicy = () => ({ tier: "deny", reason: "not that agent" });
    const r = await dispatchConciergeTool(
      call({ domain: "terminal", op: "send_to_agent_terminal", args: { agentId, text: "hi" } }),
      { policy },
    );
    expect(refusal(r).code).toBe(REGISTRY_CODES.denied);
    expect(dispatchAnswerMock).not.toHaveBeenCalled();
  });

  it("an UNAPPROVED ask never reaches the terminal either", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    const policy: ConciergeToolPolicy = () => ({ tier: "ask", approvedByUser: false });
    const r = await dispatchConciergeTool(
      call({ domain: "terminal", op: "send_to_agent_terminal", args: { agentId, text: "hi" } }),
      { policy },
    );
    expect(refusal(r).code).toBe(REGISTRY_CODES.needsApproval);
    expect(dispatchAnswerMock).not.toHaveBeenCalled();
  });

  it("an empty message is refused by the schema, before any authority is built", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    const r = await dispatchConciergeTool(
      call({ domain: "terminal", op: "send_to_agent_terminal", args: { agentId, text: "" } }),
    );
    expect(refusal(r).code).toBe(REGISTRY_CODES.badArgs);
    expect(dispatchAnswerMock).not.toHaveBeenCalled();
  });
});
