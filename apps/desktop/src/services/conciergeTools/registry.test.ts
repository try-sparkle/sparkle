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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
// A cloud spawn is a real, BILLING start. The repo probe is stubbed to "no remote" so the cloud
// route can be exercised through the registry without any chance of one being opened — and the
// resulting `cloud-no-repo` refusal is itself the discriminator the forwarding test needs (see it).
vi.mock("../cloudAgents/repoUrl", () => ({ projectRepoUrl: async () => null }));
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
/** A polled head sha, so a merge that DROPS it is distinguishable from one that forwards it. */
const HEAD_OID = "7ac0ffee11112222333344445555666677778888";
/** The repo's open PRs, as the merge path reads them. A module-level handle (rather than an inline
 *  `vi.fn`) so one test can put a mergeable PR in front of `merge_pr` and assert what reaches the
 *  service — the registry's job on that op is to FORWARD arguments, and an empty list refuses at
 *  `pr-not-found` long before anything is forwarded. */
const openPrsMock = vi.fn(async (): Promise<unknown[]> => []);
vi.mock("../openPrs", async (orig) => ({
  ...(await orig<typeof import("../openPrs")>()),
  fetchOpenPrs: (...a: unknown[]) => openPrsMock(...(a as [])),
  mergePr: (...a: unknown[]) => mergePrMock(...(a as [])),
}));
// The two gates `merge_pr` runs after the checks gate. Neither is this file's subject — registry
// tests are about routing and argument forwarding — so both answer "nothing in the way".
vi.mock("../mergeGuard/roborev", async (orig) => ({
  ...(await orig<typeof import("../mergeGuard/roborev")>()),
  fetchRoborevProbe: vi.fn(async () => ({ enabled: false, jobs: null })),
}));
vi.mock("../mergeGuard/prClaims", async (orig) => ({
  ...(await orig<typeof import("../mergeGuard/prClaims")>()),
  fetchPrClaims: vi.fn(async () => []),
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
// Satellite ownership: torn-out is a localStorage-backed read, so drive it explicitly.
const tornOutMock = vi.fn(() => false);
vi.mock("../satelliteWindows", async (orig) => ({
  ...(await orig<typeof import("../satelliteWindows")>()),
  isTornOut: (...a: unknown[]) => tornOutMock(...(a as [])),
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
// The turn state the relay gate reads — set here the way ConciergeHost sets it at dispatch.
import { setConciergeTurnOrigin } from "../conciergeReceipts";
import { configuredToolPolicy } from "./policyBinding";
import {
  approveApproval,
  clearConciergeApprovals,
  pendingApprovals,
  useConciergeApprovals,
} from "../../stores/conciergeApprovals";
import { useSettingsStore } from "../../stores/settingsStore";
import { useAuthStore } from "../../stores/authStore";
import { useCloudAuthStore } from "../../stores/cloudAuthStore";
import { useProjectStore } from "../../stores/projectStore";
import { SPARKLE_AGENT_ID } from "../sparkleAgent";
import { takePendingSends, resetPendingSends } from "../pendingSends";
import {
  BRIEF_DELIVERY_TIMEOUT_MS,
  briefForLaunch,
  hasUndeliveredBrief,
  noteBriefFailed,
  noteBriefLaunched,
  resetAgentBriefs,
} from "../agentBrief";
import { wasProjectVisited, resetVisitedProjects } from "../sessionProjects";
import { assembleBuildSpawn } from "../orchestrationLaunch";
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

// `vi.clearAllMocks()` in the `beforeEach` below clears CALLS, not IMPLEMENTATIONS — a distinction
// this file already documents at the history suite's own `afterEach`, and one that had to be
// rediscovered once per leak. A test that installs an `invoke` implementation and returns without
// restoring it therefore answers every test declared after it, which is inert until the day someone
// adds a test below that happens to invoke the same command and silently gets the wrong fixture.
// Resetting here makes that class of leak impossible rather than each instance remembered: it runs
// even when a test fails early, and it costs nothing, because every test that needs an
// implementation installs its own before it looks.
afterEach(() => {
  invoke.mockImplementation(async () => undefined);
});

beforeEach(() => {
  vi.clearAllMocks();
  // The pending-send queue is module-level state, so a spawn that queued a brief would otherwise
  // leak into the next test's assertions about what was (or was not) queued.
  resetPendingSends();
  resetAgentBriefs();
  // Visited-project tracking is module-level too, and it is half the pane-mount gate — a project
  // marked visited by one test would mask a missing mount guarantee in the next.
  resetVisitedProjects();
  tornOutMock.mockReturnValue(false);
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
  // THE SENTINEL MUST REACH THE HANDLER, NOT THE SCHEMA.
  //
  // `read_picker_options` legitimately returns `fingerprint: ""` for a PRESENT menu whose question
  // could not be read. While `expectFingerprint` was `.min(1)`, echoing that back produced a
  // validation refusal telling the model to do exactly what it had just done, and the
  // `unreadable-picker` refusal that explains the situation was unreachable through the registry.
  // The existing test for it called `selectPickerOption` directly, BELOW the schema, so it passed
  // throughout (roborev 55204). This one goes through `dispatchConciergeTool`.
  it("lets the empty fingerprint through to the handler's own refusal", async () => {
    const r = await dispatchConciergeTool(
      call({
        domain: "terminal",
        op: "select_picker_option",
        args: { agentId: "a1", index: 0, expectFingerprint: "" },
      }),
    );

    // Whatever it refuses with, it must NOT be the schema — the point is that the handler ran.
    expect(refusal(r).code).not.toBe(REGISTRY_CODES.badArgs);
    expect(refusal(r).message).not.toContain("echo back");
  });

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

  /**
   * THE SCHEMA IS THE ONLY GATE BETWEEN AN LLM AND THE VERIFICATION PATH (sparkle-ei7keg).
   *
   * `fleet.inbox_send` now returns `verifyArgs: { agentIds, messageIds }` and tells the caller to
   * hand them straight to `inbox_status` — but `inboxStatusArgs` is `.strict()`, so before
   * `messageIds` was added to it the registry answered `bad-args` and the confirming call was
   * UNREACHABLE through the only door a model has. The unit tests in `fleet.test.ts` call
   * `inboxStatus` directly, BELOW the schema, so they would have stayed green with the feature
   * completely inaccessible — the same shape as the `expectFingerprint` finding above.
   *
   * Asserts the SIDE EFFECT: the filter survives the strict schema and is applied over the
   * `inbox_peek` view before the reply leaves the registry — and, because that is a claim about
   * WHERE the filtering happens, the absence of `messageIds` on the wire is asserted too. Rust is
   * handed `{ agentIds }` alone; narrowing is entirely client-side (`fleet.ts`), so a reader must
   * not be left believing the backend honours the filter.
   *
   * The receipt is NOT hardcoded here. `verifyArgs` (fleet.ts) and `inboxStatusArgs` (registry.ts)
   * are two independent declarations with no type coupling, so spelling the field names out in the
   * test would let a rename break the paste-the-receipt path while this stayed green — the exact
   * vacuous shape this suite exists to catch. Instead the test dispatches a real `inbox_send` and
   * feeds its `verifyArgs` back through the registry VERBATIM.
   */
  it("carries inbox_status's messageIds filter through the schema to the per-message answer", async () => {
    invoke.mockImplementation((async (cmd: string) => {
      if (cmd === "inbox_send") return "m2";
      if (cmd === "inbox_status")
        // Consistent with `status_of` (inbox.rs): a CLAIMED message counts under `delivered` and is
        // excluded from both `pending` and `pendingIds`, and `awaitingAck` is `delivered -
        // acknowledged`. The peek below reports m1 pending and m2 delivered, so these counts must
        // agree with it — a fixture modelling a state the backend cannot emit is the same
        // "shape the wire cannot produce" defect the `ackedAt` note below guards against, and this
        // is the fixture later filtered-status tests will copy.
        return [
          { agentId: "a1", pending: 1, delivered: 1, acknowledged: 0, awaitingAck: 1, pendingIds: ["m1"] },
        ];
      if (cmd === "inbox_peek")
        return [
          {
            agentId: "a1",
            entries: [
              // `ackedAt`/`ackNote` are `null`, not absent: they back a Rust `Option<T>`, which serde
              // emits as a null VALUE. A fixture that omitted them would test a shape the wire cannot
              // produce (AGENTS.md's Rust->TS seam rule).
              { id: "m1", ts: 1, from: "concierge", text: "rebase first", severity: "act", state: "pending", ackedAt: null, ackNote: null },
              { id: "m2", ts: 2, from: "concierge", text: "and then verify", severity: "act", state: "delivered", ackedAt: null, ackNote: null },
            ],
          },
        ];
      return undefined;
    }) as unknown as () => Promise<undefined>);

    // The receipt the concierge is told to paste, taken from a REAL send rather than retyped.
    const sent = await dispatchConciergeTool(
      call({ domain: "fleet", op: "inbox_send", args: { agentId: "a1", text: "and then verify" } }),
    );
    expect(sent.ok).toBe(true);
    const receipt = (sent as { data: { verifyWith: string; verifyArgs: Record<string, unknown> } }).data;
    // The op it names has to be the one we then call; a renamed op would strand the caller.
    expect(receipt.verifyWith).toBe("fleet.inbox_status");

    const r = await dispatchConciergeTool(
      // VERBATIM — whatever `verifyArgs` is called, this is the paste the receipt promises works.
      call({ domain: "fleet", op: "inbox_status", args: receipt.verifyArgs }),
    );

    expect(r.ok).toBe(true);
    const data = (
      r as {
        data: {
          rows: Array<{ entries: Array<{ id: string; state: string }> | null }>;
          queriedIds: string[] | null;
          notFound: string[];
        };
      }
    ).data;
    expect(data.rows[0]!.entries).toEqual([expect.objectContaining({ id: "m2", state: "delivered" })]);
    // The two fields a model actually reads to answer "did it land?".
    expect(data.queriedIds).toEqual(["m2"]);
    expect(data.notFound).toEqual([]);
    // …and the read really went through `inbox_peek`, not a second reader invented here — with the
    // filter NOT on the wire, which is what makes the doc comment above checkable rather than a claim.
    expect(invoke).toHaveBeenCalledWith("inbox_peek", { agentIds: ["a1"] });
    // The implementation installed above is restored by the file-level `afterEach`, so these
    // fixtures cannot answer a later test's `invoke`.
  });

  /**
   * THE ONE LINE THAT MAKES THE CONCIERGE ABLE TO CONFIRM A SEND (`withEntries: true` at the
   * `inbox_status` route) IS OTHERWISE COVERED BY NOTHING.
   *
   * The peek is opt-in — off by default so `fleetWatch`'s ~10s poll does not pay for entries it
   * discards. The concierge route turns it on explicitly. Delete that `true` and every existing
   * test stays green: `fleet.test.ts` calls `inboxStatus` directly and passes its own flag, and the
   * filtered case below implies the peek via `messageIds`. Meanwhile the concierge silently loses
   * the ability to answer "did it land?" — the exact defect this whole change exists to prevent,
   * reintroduced through the seam nothing drives (AGENTS.md's defaulted-seam trap).
   *
   * So this drives the registry with NO `messageIds`, where only the route's own flag can produce a
   * peek, and asserts the SIDE EFFECT: `inbox_peek` was actually invoked.
   */
  it("the concierge route asks for entries even unfiltered, so it can confirm a send", async () => {
    invoke.mockImplementation((async (cmd: string) => {
      if (cmd === "inbox_status")
        return [{ agentId: "a1", pending: 1, delivered: 0, acknowledged: 0, awaitingAck: 0, pendingIds: ["m1"] }];
      if (cmd === "inbox_peek")
        return [
          {
            agentId: "a1",
            entries: [
              { id: "m1", ts: 1, from: "concierge", text: "rebase first", severity: "act", state: "pending", ackedAt: null, ackNote: null },
            ],
          },
        ];
      return undefined;
    }) as unknown as () => Promise<undefined>);

    const r = await dispatchConciergeTool(
      call({ domain: "fleet", op: "inbox_status", args: { agentIds: ["a1"] } }), // no messageIds
    );

    expect(r.ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith("inbox_peek", { agentIds: ["a1"] });
    const data = (r as { data: { rows: Array<{ entries: unknown }>; entriesUnavailable: string | null } }).data;
    expect(data.rows[0]!.entries).toEqual([expect.objectContaining({ id: "m1" })]);
    expect(data.entriesUnavailable).toBeNull();
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

  it("workflow: merge_pr FORWARDS knightwatchOverride to the service, verbatim", async () => {
    const projectId = seedProject("Repo", "/repos/app");
    openPrsMock.mockResolvedValueOnce([
      {
        number: 7,
        title: "feat: a thing",
        headRefName: "sparkle/a-thing",
        url: "https://github.com/o/r/pull/7",
        checks: "passing",
        mergeable: "mergeable",
        mergeStateStatus: "clean",
        headRefOid: HEAD_OID,
      },
    ]);
    const reason = "the probe asks about a file this PR does not touch";
    const r = await dispatchConciergeTool(
      call({
        domain: "workflow",
        op: "merge_pr",
        args: { projectId, number: 7, knightwatchOverride: { reason } },
      }),
    );
    expect(r.ok).toBe(true);
    // THE POINT OF THE TEST: the reason reaches the service. `.strict()` on the args schema means a
    // key it does not declare is a bad-args error, and a declared-but-unforwarded key is a merge
    // that silently drops the founder's sentence — both invisible from the result alone.
    //
    // The FOURTH argument is the polled head the merge decision was gated on, forwarded for the
    // same reason and equally invisible from the result: dropped, the merge lands at whatever the
    // branch points at when `gh` runs rather than the sha this dispatch approved.
    expect(mergePrMock).toHaveBeenCalledWith("/repos/app", 7, reason, HEAD_OID);
  });

  it("workflow: a malformed knightwatchOverride is refused by the DOMAIN, not by the schema", async () => {
    const projectId = seedProject("Repo", "/repos/app");
    openPrsMock.mockResolvedValueOnce([
      {
        number: 7,
        title: "feat: a thing",
        headRefName: "sparkle/a-thing",
        url: "https://github.com/o/r/pull/7",
        checks: "passing",
        mergeable: "mergeable",
        mergeStateStatus: "clean",
      },
    ]);
    const r = await dispatchConciergeTool(
      call({
        domain: "workflow",
        op: "merge_pr",
        args: { projectId, number: 7, knightwatchOverride: { reason: "ok" } },
      }),
    );
    // The domain's code and the domain's sentence — a `bad-args` naming a zod field would tell the
    // model the shape was wrong without telling it the reason is PUBLISHED on the pull request.
    expect(refusal(r).code).toBe("invalid-request");
    expect(refusal(r).message).toMatch(/recorded on the pull request/i);
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
      call({ domain: "terminal", op: "send_to_agent_terminal", args: { agentId, text: "hi", goal: "", notWork: { reason: "authority/normalization fixture, not a work assignment" } } }),
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
    // The refusal must NOT ask the human to come back and say "go ahead". Approving in the column
    // dispatches the call itself now, so inviting a follow-up invites a DUPLICATE run.
    expect(message).toContain("approving it there runs it");
    expect(message).not.toContain("tell me to go ahead");
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

  // -------------------------------------------------------------------------------------------
  // search_history's `scope` — the ONE op whose verdict depends on its ARGUMENTS.
  //
  // Driven through the REAL `configuredToolPolicy` rather than a stub, deliberately. A stub that
  // re-derived the verdict from `evaluateToolPolicy` would be a COPY of the mechanism under test
  // and would stay green if the binding stopped forwarding `q.args` at all — which is precisely
  // the wire this feature hangs on.
  // -------------------------------------------------------------------------------------------
  describe("search_history scope", () => {
    const HITS = [
      {
        id: "build-1",
        kind: "prompt",
        source: "build",
        projectId: "p1",
        agentId: "a1",
        projectName: "P",
        agentName: "a1",
        snippet: "widget",
        createdAt: 0,
      },
      {
        id: "concierge-1",
        kind: "prompt",
        source: "concierge",
        projectId: null,
        agentId: null,
        projectName: null,
        agentName: null,
        snippet: "widget",
        createdAt: 0,
      },
    ];

    const searchCall = (args: Record<string, unknown>) =>
      call({ domain: "workspace", op: "search_history", args });

    beforeEach(() => {
      // The concierge AI gate is a precondition for every tool call; these tests are about the
      // scope rule, not the entitlement, so it is opened explicitly (see aiGate.concierge.test.ts).
      useSettingsStore.setState({
        aiConcierge: true,
        conciergeToolPolicy: {},
        conciergeToolPolicyHydrated: true,
      } as never);
      useAuthStore.setState({
        me: { clerkUserId: "u1", entitled: true, balanceCents: 5_000, tokenVersion: 1 },
        creditFloorCents: 0,
      } as never);
      clearConciergeApprovals();
      // The shared `invoke` mock is declared zero-arg (`vi.fn(async () => undefined)`), so an
      // implementation that reads the command name needs the cast.
      invoke.mockImplementation(((cmd: unknown) =>
        Promise.resolve(cmd === "history_search" ? HITS : undefined)) as never);
    });

    /** The commands `invoke` was actually asked for. Same cast reason as above. */
    const invokedCommands = () => (invoke.mock.calls as unknown as unknown[][]).map((c) => c[0]);

    afterEach(() => {
      // `vi.clearAllMocks()` clears CALLS, not implementations, so an implementation set here would
      // otherwise answer every later suite's `invoke`.
      invoke.mockImplementation(async () => undefined);
      clearConciergeApprovals();
    });

    it("a default-scope search runs silently and returns build hits WITHOUT the concierge row", async () => {
      const r = await dispatchConciergeTool(searchCall({ query: "widget" }), {
        policy: configuredToolPolicy,
      });
      if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
      const ids = (r.data as { id: string }[]).map((h) => h.id);
      // BOTH halves: the concierge row is gone AND the build row survived the same backend read.
      expect(ids).toEqual(["build-1"]);
      // Silently — no card was put in front of the human for an ordinary search.
      expect(pendingApprovals(useConciergeApprovals.getState().entries)).toEqual([]);
    });

    it("an explicit scope 'default' behaves identically to omitting it", async () => {
      const r = await dispatchConciergeTool(searchCall({ query: "widget", scope: "default" }), {
        policy: configuredToolPolicy,
      });
      if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
      expect((r.data as { id: string }[]).map((h) => h.id)).toEqual(["build-1"]);
      expect(pendingApprovals(useConciergeApprovals.getState().entries)).toEqual([]);
    });

    it("scope 'all' is needs-approval — and the search never runs", async () => {
      const r = await dispatchConciergeTool(searchCall({ query: "widget", scope: "all" }), {
        policy: configuredToolPolicy,
      });
      expect(refusal(r).code).toBe(REGISTRY_CODES.needsApproval);
      // The gate is not merely a label: the backend was never asked, so nothing was read.
      expect(invokedCommands()).not.toContain("history_search");
      // …and the human has a card naming what they are being asked about.
      const [card] = pendingApprovals(useConciergeApprovals.getState().entries);
      expect(card).toBeDefined();
      expect(card!.op).toBe("search_history");
      expect(card!.riskClass).toBe("privacy-sensitive");
      expect(card!.args).toContainEqual({ key: "scope", value: "all" });
    });

    it("approving that card lets the SAME call through, concierge row included", async () => {
      // The approval path for this op end to end: refuse → human approves → the replay (same
      // toolCallId, same args, as conciergeApprovalResume performs it) spends the grant and runs.
      const c = searchCall({ query: "widget", scope: "all" });
      expect(refusal(await dispatchConciergeTool(c, { policy: configuredToolPolicy })).code).toBe(
        REGISTRY_CODES.needsApproval,
      );

      approveApproval(TOOL_CALL_ID);

      const r = await dispatchConciergeTool(c, { policy: configuredToolPolicy });
      if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
      expect((r.data as { id: string }[]).map((h) => h.id)).toEqual(["build-1", "concierge-1"]);
    });

    it("refuses a scope the schema does not know, rather than treating it as the wide one", async () => {
      const r = await dispatchConciergeTool(searchCall({ query: "widget", scope: "everything" }), {
        policy: configuredToolPolicy,
      });
      expect(refusal(r).code).toBe(REGISTRY_CODES.badArgs);
      expect(refusal(r).message).toContain("scope");
      expect(invokedCommands()).not.toContain("history_search");
    });
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
      call({ domain: "terminal", op: "send_to_agent_terminal", args: { agentId, text: "carry on", goal: "", notWork: { reason: "authority/normalization fixture, not a work assignment" } } }),
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
      call({ domain: "terminal", op: "send_to_agent_terminal", args: { agentId, text: "ok", goal: "", notWork: { reason: "authority/normalization fixture, not a work assignment" } } }),
      { policy },
    );
    // The two are different facts — a standing policy versus a human answering this prompt — and the
    // audit line has to be able to say which.
    expect(authorityUsed()).toMatchObject({ policy: "approved" });
  });

  // ── THE GOAL GATE ON THE SEND PATH ──────────────────────────────────────────────────────────────
  // `set_agent_goal` was a SEPARATE call and was routinely skipped, so agents were assigned work in
  // prose and left with `goalStateOf === "none"`. These assert the two side effects that matter:
  // nothing reaches the PTY without a stated goal, and a stated goal actually lands on the record.
  it("refuses a send that states no goal — nothing reaches the terminal", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    const r = await dispatchConciergeTool(
      call({
        domain: "terminal",
        op: "send_to_agent_terminal",
        args: { agentId, text: "go fix the parser and land it", goal: "" },
      }),
    );
    expect(refusal(r).code).toBe(REGISTRY_CODES.badArgs);
    // The property: the message never got typed. A refusal that still sent would be worthless.
    expect(dispatchAnswerMock).not.toHaveBeenCalled();
  });

  // ── THE REFUSAL MUST BE FOLLOWABLE ON THE SURFACE THAT EMITTED IT ──────────────────────────────
  // The shared message was written for spawn_worker and relayed verbatim here, so it named the wrong
  // tool and told the caller to pass `goalOverride` — a key sendTerminalArgs.strict() REJECTS. The
  // caller's next attempt earned "Unrecognized key: goalOverride" whose message again said
  // `goalOverride`: a loop with no path to a successful send, and this refusal is the only place the
  // contract is stated (roborev 55826/55836). A `/goal/i` assertion passed against the wrong text.
  it("names THIS tool and THIS surface's override parameter, never spawn_worker's", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    const r = await dispatchConciergeTool(
      call({
        domain: "terminal",
        op: "send_to_agent_terminal",
        args: { agentId, text: "go fix the parser and land it", goal: "" },
      }),
    );
    const { message } = refusal(r);
    expect(message).toContain("send_to_agent_terminal");
    expect(message).toContain("notWork");
    // The two that made it a loop.
    expect(message).not.toContain("goalOverride");
    expect(message).not.toContain("spawn_worker");
  });

  it("the parameter the refusal names is one the schema actually accepts", async () => {
    // The loop-detector. Even a correctly-named remedy is worthless if the schema rejects it, so
    // follow the advice literally and assert the call SUCCEEDS.
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    const refused = await dispatchConciergeTool(
      call({
        domain: "terminal",
        op: "send_to_agent_terminal",
        args: { agentId, text: "just checking in", goal: "" },
      }),
    );
    const named = refusal(refused).message.includes("notWork") ? "notWork" : "";
    expect(named).toBe("notWork");
    // Do exactly what it said.
    const followed = await dispatchConciergeTool(
      call({
        domain: "terminal",
        op: "send_to_agent_terminal",
        args: {
          agentId,
          text: "just checking in",
          goal: "",
          notWork: { reason: "answering a question the agent asked" },
        },
      }),
    );
    expect(followed.ok).toBe(true);
    expect(dispatchAnswerMock).toHaveBeenCalled();
  });

  it("refuses a narrative status report as a goal, so prose cannot pass as a criterion", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    const narrative =
      "The mount is still only half-fixed. What's landed makes the mount visible and correct — the " +
      "concierge floods, the row bolds, Escape unmounts, no stale binding. It does not yet route: " +
      "shellResolve.ts still contains zero references to wired, so a mounted message goes wherever " +
      "the cable-blind auto-router sends it. That's the next piece.";
    const r = await dispatchConciergeTool(
      call({
        domain: "terminal",
        op: "send_to_agent_terminal",
        args: { agentId, text: "carry on", goal: narrative },
      }),
    );
    expect(refusal(r).code).toBe(REGISTRY_CODES.badArgs);
    expect(dispatchAnswerMock).not.toHaveBeenCalled();
  });

  it("records the goal as the AGENT, so a reworded goal cannot refill the retry budget", async () => {
    // The default actor is "human", which builds a fresh goal (totalContinues 0) and releases the
    // stashed debt. Ordinary concierge traffic would then refill MAX_CONTINUES_TOTAL on every
    // reworded goal, the ceiling would never be reached, and the agent would NEVER escalate — the
    // escalation guard would be protecting a state this call site prevented (roborev 55877).
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    const store = useProjectStore.getState();
    store.setAgentGoal(projectId, agentId, "the original criterion holds", undefined, "agent");
    store.noteAgentGoalContinue(projectId, agentId, "mark-1");
    store.noteAgentGoalContinue(projectId, agentId, "mark-2");
    const before = useProjectStore
      .getState()
      .projects.find((p) => p.id === projectId)!
      .agents.find((x) => x.id === agentId)!.goal!;
    expect(before.totalContinues).toBeGreaterThan(0);

    await dispatchConciergeTool(
      call({
        domain: "terminal",
        op: "send_to_agent_terminal",
        args: { agentId, text: "more work", goal: "a reworded but different criterion passes" },
      }),
    );

    const after = useProjectStore
      .getState()
      .projects.find((p) => p.id === projectId)!
      .agents.find((x) => x.id === agentId)!.goal!;
    // The spend is CARRIED, not laundered.
    expect(after.totalContinues).toBeGreaterThanOrEqual(before.totalContinues);
  });

  it("reports goalRecorded:false when the agent is in no project, instead of a bare ok", async () => {
    // services/sparkleAgent documents that __sparkle_self__ is never in any project, so EVERY work
    // send to the Improve Sparkle agent lands in that branch. A bare ok told the caller the goal was
    // recorded when it was not, leaving that agent goalless behind an enforcement reporting success.
    const r = await dispatchConciergeTool(
      call({
        domain: "terminal",
        op: "send_to_agent_terminal",
        args: { agentId: SPARKLE_AGENT_ID, text: "improve yourself", goal: "the lint budget is at zero" },
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.ok && (r.data as { goalRecorded?: boolean }).goalRecorded).toBe(false);
    expect(String((r.ok && (r.data as { goalNote?: string }).goalNote) ?? "")).toMatch(/project/i);
  });

  it("does NOT replace an ESCALATED goal, so a routine send cannot un-escalate an agent", async () => {
    // Recording a goal is a side effect of every work send, and setAgentGoal with CHANGED text runs
    // newGoal — which zeroes the retry counters and drops escalatedAt. An escalated goal is one
    // auto-continue gave up on and handed to the human; a routine send must not take it back off
    // their plate or refill the retry budget (roborev 55826).
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    const store = useProjectStore.getState();
    store.setAgentGoal(projectId, agentId, "the original objective that was escalated");
    store.escalateAgentGoal(projectId, agentId, "auto-continue gave up after 3 restarts", Date.now());
    const before = useProjectStore
      .getState()
      .projects.find((p) => p.id === projectId)!
      .agents.find((x) => x.id === agentId)!.goal!;
    expect(before.escalatedAt).toBeTruthy();

    const r = await dispatchConciergeTool(
      call({
        domain: "terminal",
        op: "send_to_agent_terminal",
        args: { agentId, text: "here is more work", goal: "a completely different criterion passes" },
      }),
    );

    // The send still happens — this is not a refusal, it is a refusal to OVERWRITE.
    expect(r.ok).toBe(true);
    const after = useProjectStore
      .getState()
      .projects.find((p) => p.id === projectId)!
      .agents.find((x) => x.id === agentId)!.goal!;
    expect(after.escalatedAt).toBe(before.escalatedAt);
    expect(after.text).toBe(before.text);
    // And the COPY says WHICH protection this is. The concierge does hold a bounded re-arm lever
    // now, so a note reading "escalated to the human" full stop would send it to a person for
    // something it may be able to clear itself — through the explicit counted op, never by sending
    // more text, which is the invariant the assertions above pin.
    const note = String((r.ok && (r.data as { goalNote?: string }).goalNote) ?? "");
    expect(note).toMatch(/set_agent_escalation/);
    expect(note).toMatch(/never a side effect/i);
  });

  it("does NOT record a goal when the escalation survives only in goalDebt, and says the human must act", async () => {
    // THE ROUTE THE GUARD WAS WIDENED FOR, and the one the test above cannot reach (roborev 55900).
    // The test above stamps `escalatedAt` on the LIVE goal, which the original `existing?.escalatedAt`
    // read already covered — so deleting `?? agent?.goalDebt?.escalatedAt` left the suite green.
    // Here the agent CLEARS its goal first: the record is dropped and the escalation survives only in
    // the `goalDebt` stash, so `agent.goal` is undefined at the guard.
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    const store = useProjectStore.getState();
    store.setAgentGoal(projectId, agentId, "the original objective that was escalated");
    store.escalateAgentGoal(projectId, agentId, "auto-continue gave up after 3 restarts", Date.now());
    store.setAgentGoal(projectId, agentId, "", undefined, "agent"); // the agent clears it
    const cleared = useProjectStore
      .getState()
      .projects.find((p) => p.id === projectId)!
      .agents.find((x) => x.id === agentId)!;
    expect(cleared.goal).toBeUndefined();
    expect(cleared.goalDebt?.escalatedAt).toBeTruthy();

    const r = await dispatchConciergeTool(
      call({
        domain: "terminal",
        op: "send_to_agent_terminal",
        args: { agentId, text: "here is more work", goal: "a completely different criterion passes" },
      }),
    );

    // The SIDE EFFECT: no goal was written, so the escalation was not laundered into a fresh budget.
    expect(r.ok).toBe(true);
    const after = useProjectStore
      .getState()
      .projects.find((p) => p.id === projectId)!
      .agents.find((x) => x.id === agentId)!;
    expect(after.goal).toBeUndefined();
    expect(after.goalDebt?.escalatedAt).toBe(cleared.goalDebt?.escalatedAt);
    expect(r.ok && (r.data as { goalRecorded?: boolean }).goalRecorded).toBe(false);
    // And the COPY must not claim a goal exists — the agent is goalless and stays that way until a
    // person types to it, so the note has to route the caller to the human rather than to a re-send.
    const note = String((r.ok && (r.data as { goalNote?: string }).goalNote) ?? "");
    expect(note).toMatch(/human|person/i);
    expect(note).not.toMatch(/not replaced/i);
  });

  it("explains a not-work send rather than reporting a bare goalRecorded:false", async () => {
    // Under `notWork` the gate returns `goal: null`, so the recording block never runs and the reply
    // used to be a bare `goalRecorded: false` — shaped exactly like the genuine failures minus their
    // explanation. Read by the field's own contract that says "it wasn't recorded", which invites the
    // concierge to restate the objective and re-send text the PTY already has (roborev 55900).
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    const r = await dispatchConciergeTool(
      call({
        domain: "terminal",
        op: "send_to_agent_terminal",
        args: {
          agentId,
          text: "nice work on that one",
          notWork: { reason: "acknowledging a finished handoff; there is nothing to do" },
        },
      }),
    );
    expect(r.ok).toBe(true);
    const note = String((r.ok && (r.data as { goalNote?: string }).goalNote) ?? "");
    expect(note).not.toBe("");
    // Not mistakable for the no-project failure, which is the other reply carrying goalRecorded:false.
    expect(note).not.toMatch(/project/i);
    expect(note).toMatch(/not-work/i);
  });

  it("refuses an omitted goal, not merely an empty one", async () => {
    // Every other send test passes `goal: ""` explicitly, so all of them pass identically whether the
    // schema marks `goal` required or optional — reverting `.optional()` would leave them green
    // (roborev 55836). This one OMITS the key, which is the shape the schema change exists for.
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    const r = await dispatchConciergeTool(
      call({ domain: "terminal", op: "send_to_agent_terminal", args: { agentId, text: "do the thing" } }),
    );
    expect(refusal(r).code).toBe(REGISTRY_CODES.badArgs);
    expect(refusal(r).message).toContain("notWork");
    expect(dispatchAnswerMock).not.toHaveBeenCalled();
  });

  it("records a stated goal on the target agent once the send succeeds", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    const goal = "nested groups parse and parser.test.ts passes";
    const r = await dispatchConciergeTool(
      call({
        domain: "terminal",
        op: "send_to_agent_terminal",
        args: { agentId, text: "please handle the nested-group case", goal },
      }),
    );
    expect(r.ok).toBe(true);
    expect(dispatchAnswerMock).toHaveBeenCalled();
    // The side effect: the criterion is on the RECORD, so something other than the agent can check
    // whether it finished. Born unmet — a goal that arrived "met" would read as already done.
    const agent = useProjectStore
      .getState()
      .projects.find((p) => p.id === projectId)!
      .agents.find((a) => a.id === agentId)!;
    expect(agent.goal?.text).toBe(goal);
    expect(agent.goal?.metAt).toBeUndefined();
  });

  it("a notWork send is delivered and leaves the agent's goal untouched", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    const r = await dispatchConciergeTool(
      call({
        domain: "terminal",
        op: "send_to_agent_terminal",
        args: {
          agentId,
          text: "yes, go ahead",
          goal: "",
          notWork: { reason: "answering a question the agent asked" },
        },
      }),
    );
    expect(r.ok).toBe(true);
    expect(dispatchAnswerMock).toHaveBeenCalled();
    // No goal invented from the reason: an unverifiable send must not look verifiable.
    const agent = useProjectStore
      .getState()
      .projects.find((p) => p.id === projectId)!
      .agents.find((a) => a.id === agentId)!;
    expect(agent.goal).toBeUndefined();
  });

  it("a BLANK toolCallId refuses the write: there is nothing to attribute it to", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    const r = await dispatchConciergeTool({
      domain: "terminal",
      op: "send_to_agent_terminal",
      args: {
        agentId,
        text: "sneak this in",
        // Goal args supplied so this case tests AUTHORITY, not argument validity — arg validation
        // runs first, so an unpatched call would refuse as `bad-args` and never reach the check
        // this test names.
        goal: "",
        notWork: { reason: "authority fixture, not a work assignment" },
      },
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
      call({ domain: "terminal", op: "send_to_agent_terminal", args: { agentId, text: "hi", goal: "", notWork: { reason: "authority/normalization fixture, not a work assignment" } } }),
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
      call({ domain: "terminal", op: "send_to_agent_terminal", args: { agentId, text: "hi", goal: "", notWork: { reason: "authority/normalization fixture, not a work assignment" } } }),
      { policy },
    );
    expect(refusal(r).code).toBe(REGISTRY_CODES.needsApproval);
    expect(dispatchAnswerMock).not.toHaveBeenCalled();
  });

  it("an empty message is refused by the schema, before any authority is built", async () => {
    const projectId = seedProject();
    const agentId = seedBuild(projectId);
    const r = await dispatchConciergeTool(
      call({ domain: "terminal", op: "send_to_agent_terminal", args: { agentId, text: "", goal: "", notWork: { reason: "authority/normalization fixture, not a work assignment" } } }),
    );
    expect(refusal(r).code).toBe(REGISTRY_CODES.badArgs);
    expect(dispatchAnswerMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// 6. The board / approvals domains — the wiring layer, not the domain modules
// ---------------------------------------------------------------------------------------------
//
// board.test.ts and approvals.test.ts cover the modules themselves. What lives ONLY here is what
// the registry adds: the read-side store fallback for `projectId`, the write side's refusal to use
// it, and that an unknown project is refused rather than silently resolved. That gap is not
// hypothetical — a whole class of wiring bug (the settings catalog missing both domains) shipped
// precisely because no test exercised these two domains at this layer.

describe("board — the registry's project resolution", () => {
  /** `bd` is not present in a unit test; drive the Rust edge directly. */
  function beadsReturn(rows: unknown[]): void {
    invoke.mockImplementation((async (cmd: string) => {
      if (cmd === "list_beads") return JSON.stringify(rows);
      if (cmd === "blocked_beads") return JSON.stringify([]);
      return undefined;
    }) as never);
  }

  it("READS fall back to the selected project when projectId is omitted", async () => {
    const projectId = seedProject("Demo", "/tmp/demo");
    useProjectStore.setState({ selectedProjectId: projectId } as never);
    beadsReturn([{ id: "a", title: "one", status: "open" }]);

    const r = await dispatchConciergeTool(call({ domain: "board", op: "list_items", args: {} }));
    expect(r.ok).toBe(true);
    // Resolved through the STORE — the root path is never something the model supplied.
    expect(invoke).toHaveBeenCalledWith("list_beads", { projectPath: "/tmp/demo" });
  });

  it("refuses a read with no projectId and nothing selected, instead of guessing", async () => {
    const r = await dispatchConciergeTool(call({ domain: "board", op: "list_items", args: {} }));
    expect(refusal(r).code).toBe(REGISTRY_CODES.unknownProject);
    expect(refusal(r).message).toMatch(/projectId/);
  });

  it("refuses a projectId no open project holds", async () => {
    seedProject();
    const r = await dispatchConciergeTool(
      call({ domain: "board", op: "list_items", args: { projectId: "nope" } }),
    );
    expect(refusal(r).code).toBe(REGISTRY_CODES.unknownProject);
  });

  // The write side deliberately does NOT inherit the read side's fallback: an approval is
  // fingerprinted over the model's raw args, so a delete approved as `{id}` with no project would
  // be performed against whatever is selected on the retry turn.
  it("WRITES require an explicit projectId — the selected-project fallback does not apply", async () => {
    const projectId = seedProject();
    useProjectStore.setState({ selectedProjectId: projectId } as never);

    for (const [op, args] of [
      ["create_item", { title: "x" }],
      ["update_item", { id: "a", status: "closed" }],
      ["delete_item", { id: "a" }],
    ] as const) {
      const r = await dispatchConciergeTool(call({ domain: "board", op, args }));
      expect(refusal(r).code, op).toBe(REGISTRY_CODES.badArgs);
      expect(refusal(r).message, op).toMatch(/projectId/);
    }
  });

  it("an update that changes nothing is refused rather than reported as a no-op success", async () => {
    const projectId = seedProject();
    const r = await dispatchConciergeTool(
      call({ domain: "board", op: "update_item", args: { projectId, id: "a" } }),
    );
    expect(refusal(r).code).toBe(REGISTRY_CODES.badArgs);
  });

  it("delete_item is ask-tier end to end, and nothing is destroyed without approval", async () => {
    const projectId = seedProject();
    const policy: ConciergeToolPolicy = () => ({ tier: "ask", approvedByUser: false });
    const r = await dispatchConciergeTool(
      call({ domain: "board", op: "delete_item", args: { projectId, id: "a" } }),
      { policy },
    );
    expect(refusal(r).code).toBe(REGISTRY_CODES.needsApproval);
    expect(invoke).not.toHaveBeenCalledWith("delete_bead", expect.anything());
  });
});

describe("approvals — routed and read-only", () => {
  it("routes list_pending_approvals and returns a list", async () => {
    const r = await dispatchConciergeTool(
      call({ domain: "approvals", op: "list_pending_approvals", args: {} }),
    );
    expect(r.ok).toBe(true);
    expect(r.ok && Array.isArray(r.data)).toBe(true);
  });

  it("refuses an approval id it does not hold", async () => {
    const r = await dispatchConciergeTool(
      call({ domain: "approvals", op: "get_approval", args: { id: "ghost" } }),
    );
    expect(refusal(r).code).toBe("unknown-approval");
  });

  it("has no approve/deny op to route", async () => {
    for (const op of ["approve", "approve_approval", "deny_approval"]) {
      const r = await dispatchConciergeTool(call({ domain: "approvals", op, args: { id: "x" } }));
      expect(refusal(r).code, op).toBe(REGISTRY_CODES.unknownOp);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 7. spawn_build_agent settles everything in ONE call (PRD section A)
// ---------------------------------------------------------------------------------------------
//
// The bug this closes: spawning blank and then sending a brief is two operations, and BETWEEN them
// the agent is a briefless row — the state the attention engine reads as "needs you". So the
// workaround for the missing argument manufactured a false red notification every time.

describe("spawn_build_agent — atomic brief, name, model and mode", () => {
  function agentsOf(projectId: string) {
    return useProjectStore.getState().projects.find((p) => p.id === projectId)!.agents;
  }

  /**
   * Dispatch a spawn and PLAY THE PART OF THE AgentPane: once the agent row exists, report the
   * launch that carries its brief (or its failure, when `outcome` says so).
   *
   * This scaffolding exists because `briefed` is now an OBSERVATION rather than an echo of the input.
   * A test that dispatches a briefed spawn and never launches anything gets `unconfirmed` — which is
   * the honest answer, and the whole point. So the pane's half of the handshake has to be acted out
   * here, which also pins the ORDERING: the op does not answer until delivery is settled.
   */
  async function spawnWithPane(
    args: Record<string, unknown>,
    outcome: "launch" | "fail" | "silence" = "launch",
  ) {
    const dispatched = dispatchConciergeTool(
      call({ domain: "lifecycle", op: "spawn_build_agent", args }),
    );
    if (outcome !== "silence") {
      // Yield until the spawn's synchronous half has created the row and attached the brief. Bounded,
      // and a real send never depends on this — it is the test standing in for a mounting pane.
      for (let i = 0; i < 100; i++) {
        const held = useProjectStore
          .getState()
          .projects.flatMap((p) => p.agents)
          .find((a) => a.kind === "build" && hasUndeliveredBrief(a.id));
        if (held) {
          if (outcome === "launch") noteBriefLaunched(held.id);
          else noteBriefFailed(held.id, "claude not found");
          break;
        }
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    return dispatched;
  }

  // ASSERTED ON THE DELIVERY ROUTE AND ITS OBSERVED OUTCOME, NOT THE STORE ROW AND NOT THE INPUT.
  //
  // This test has now failed the same feature twice, in two different ways, and both are worth
  // keeping in mind:
  //
  //   1. It once checked `lastPrompt`/`promptHistory`, which `appendPrompt` sets without writing
  //      anything to the PTY (roborev 55057) — green against an implementation that recorded the
  //      brief and never sent it.
  //   2. It then checked the PENDING-SEND QUEUE, which was a real send path — but the send it
  //      performed delivered the text and LOST THE SUBMIT, every single time. The brief sat at the
  //      agent's prompt with the cursor after it until a human pressed Enter. `briefed: true` was
  //      returned regardless, so five of five concierge spawns in one evening reported success while
  //      leaving the agent dead in the water; the same population came back from a force-quit with
  //      empty activity and no work started.
  //
  // Both versions asserted something UPSTREAM of submission. So this one asserts submission itself:
  // the brief rides claude's argv (which claude submits at startup), the racy queue is empty, and
  // `briefed` flips only once the launch carrying it has been OBSERVED.
  it("delivers the brief as launch argv and reports briefed only once submission is observed", async () => {
    const projectId = seedProject();
    const r = await spawnWithPane({ projectId, prompt: "Fix the parser" });
    expect(r.ok).toBe(true);

    const agentId = agentsOf(projectId).find((a) => a.kind === "build")!.id;
    // NOT queued for a post-ready PTY paste — that route is what lost the submit.
    expect(takePendingSends(agentId).due).toEqual([]);
    // The brief was consumed by a launch, so it cannot be re-sent on a later relaunch.
    expect(hasUndeliveredBrief(agentId)).toBe(false);
    // …and the reply says SUBMITTED, in a field the reader cannot mistake for the input echo.
    const data = r.ok ? (r.data as { briefed: boolean; briefDelivery: string }) : null;
    expect(data?.briefed).toBe(true);
    expect(data?.briefDelivery).toBe("submitted");
  });

  // THE HONEST FAILURE. A spawn that reports success while leaving the agent briefless is worse than
  // one that fails loudly: the concierge told the founder an agent was confirmed-working when it was
  // sitting dead with its brief unsent. So a pane that will never launch the brief must come back as
  // `briefed: false` with something the human can act on — never as silence.
  it("reports an honest failure when the pane will never launch the brief", async () => {
    const projectId = seedProject();
    const r = await spawnWithPane({ projectId, prompt: "Fix the parser" }, "fail");
    // The SPAWN still succeeded — the agent exists — so this is not a refusal. The BRIEF failed, and
    // the payload has to distinguish those two facts rather than collapse them.
    expect(r.ok).toBe(true);
    const data = r.ok
      ? (r.data as { briefed: boolean; briefDelivery: string; briefFailure?: string })
      : null;
    expect(data?.briefed).toBe(false);
    expect(data?.briefDelivery).toBe("launch-failed");
    // THE REMEDY MUST BE AN ACTION THAT WORKS, and must not describe the wrong state. A
    // `launch-failed` means the TERMINAL never started, so the agent is NOT "running with no
    // objective" — an earlier draft of this copy said exactly that, describing a state the agent is
    // not in. "Start again" is the real action, and it works because `noteBriefFailed` retains the
    // brief (asserted in agentBrief.test.ts) — the two have to stay in step or the remedy becomes the
    // instruction that produces a silently briefless agent.
    expect(data?.briefFailure).toMatch(/terminal didn't start/i);
    expect(data?.briefFailure).toMatch(/start again/i);
    expect(data?.briefFailure).toMatch(/still attached/i);
    expect(data?.briefFailure).not.toMatch(/running with no objective/i);
    // And the brief really is still deliverable, so that sentence is true rather than reassuring.
    const agentId = agentsOf(projectId).find((a) => a.kind === "build")!.id;
    expect(hasUndeliveredBrief(agentId)).toBe(true);
  });

  // CLOSING THE AGENT MID-WAIT MUST NOT PRODUCE THE RETRY REMEDY.
  //
  // `spawn_build_agent` now waits up to 20s for delivery, and `projectStore.removeAgent` clears the
  // brief — so a human (or a concierge `close_agent`) closing the just-spawned agent inside that
  // window is a REACHABLE path, and it was the one the copy got wrong. Both outcomes once reported
  // `launch-failed`, so this case answered "its brief is still attached, so Start again on that
  // agent will send it" — naming a control on a row that had just been deleted, about a brief that
  // had just been dropped (roborev 55850). Exactly the remedy-copy trap this change exists to close.
  it("does not offer a retry when the agent was closed before its brief went out", async () => {
    const projectId = seedProject();
    const dispatched = spawnWithPane({ projectId, prompt: "Fix the parser" }, "silence");
    // Close it mid-wait, through the real store path that production uses.
    let agentId: string | undefined;
    for (let i = 0; i < 100; i++) {
      agentId = agentsOf(projectId).find((a) => a.kind === "build")?.id;
      if (agentId) break;
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(agentId, "expected the spawned build agent").toBeTruthy();
    useProjectStore.getState().removeAgent(projectId, agentId!);

    const r = await dispatched;
    expect(r.ok).toBe(true);
    const data = r.ok
      ? (r.data as { briefed: boolean; briefDelivery: string; briefFailure?: string })
      : null;
    expect(data?.briefed).toBe(false);
    expect(data?.briefDelivery).toBe("agent-closed");
    // The remedy must not point at a deleted row or claim the brief survived.
    expect(data?.briefFailure).not.toMatch(/start again/i);
    expect(data?.briefFailure).not.toMatch(/still attached/i);
    expect(data?.briefFailure).toMatch(/closed before/i);
    // And it resolved from the close rather than sitting out the whole bound.
    expect(hasUndeliveredBrief(agentId!)).toBe(false);
    // THE PAYLOAD MUST SAY SO TOO, not just the prose. The reply is read by a model whose rule is to
    // reference an agent as [@Name](sparkle-agent:<id>), so a live-looking handle beside an accurate
    // sentence still yields a pill for a nonexistent agent, or a follow-up op fired at a dead id.
    const payload = r.ok ? (r.data as { agentExists: boolean; provisionalName?: string }) : null;
    expect(payload?.agentExists).toBe(false);
    expect(payload?.provisionalName).toBeUndefined();
  });

  // `removeAgent` is NOT the only path that destroys agent rows — `removeProject` filters the
  // project out and its agents go with it, never calling `removeAgent`. The first cut of
  // `agent-closed` cleared briefs only in `removeAgent` and asserted (wrongly, in a docstring) that
  // it was "the one choke point", so closing a PROJECT mid-wait fell straight back into the failure
  // the state exists to remove: the waiter never settled, the op sat out its whole bound, and it
  // answered "unconfirmed — check that it picked up the task" about an agent AND a project that no
  // longer existed (roborev 55865).
  it("reports agent-closed when the whole PROJECT is closed mid-wait, not unconfirmed", async () => {
    const projectId = seedProject();
    const dispatched = spawnWithPane({ projectId, prompt: "Fix the parser" }, "silence");
    let agentId: string | undefined;
    for (let i = 0; i < 100; i++) {
      agentId = agentsOf(projectId).find((a) => a.kind === "build")?.id;
      if (agentId) break;
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(agentId, "expected the spawned build agent").toBeTruthy();
    useProjectStore.getState().removeProject(projectId);

    const r = await dispatched;
    const data = r.ok
      ? (r.data as { briefDelivery: string; agentExists: boolean; briefFailure?: string })
      : null;
    expect(data?.briefDelivery).toBe("agent-closed");
    expect(data?.agentExists).toBe(false);
    expect(data?.briefFailure).not.toMatch(/start again/i);
    expect(hasUndeliveredBrief(agentId!)).toBe(false);
  });

  // `agentExists` MUST BE OBSERVED, NOT INFERRED FROM THE DELIVERY STATE.
  //
  // It started as `delivery.state !== "agent-closed"`, which is a proxy for the question rather than
  // the answer — and wrong in exactly the case that matters. Any row destruction that does NOT clear
  // the brief (the cross-window tombstone merge is one) leaves the delivery reading `unconfirmed`,
  // so an inferred flag ships `agentExists: true` with a live `provisionalName` for a deleted row:
  // the same live-looking-handle-for-a-dead-id this field exists to prevent, through another door
  // (roborev 55876).
  //
  // So this test deletes the row DIRECTLY — no `removeAgent`, no `removeProject`, nothing that
  // settles the brief — which is precisely the shape of a path nobody has written yet.
  it("observes whether the agent still exists, even when nothing cleared its brief", async () => {
    const projectId = seedProject();
    vi.useFakeTimers();
    let r;
    try {
      const pending = spawnWithPane({ projectId, prompt: "Fix the parser" }, "silence");
      let agentId: string | undefined;
      for (let i = 0; i < 100; i++) {
        agentId = agentsOf(projectId).find((a) => a.kind === "build")?.id;
        if (agentId) break;
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(agentId, "expected the spawned build agent").toBeTruthy();
      // Excise the row without going through any teardown that knows about briefs.
      useProjectStore.setState((s) => ({
        projects: s.projects.map((p) =>
          p.id === projectId ? { ...p, agents: p.agents.filter((a) => a.id !== agentId) } : p,
        ),
      }));
      await vi.advanceTimersByTimeAsync(BRIEF_DELIVERY_TIMEOUT_MS + 1);
      r = await pending;
    } finally {
      vi.useRealTimers();
    }
    const data = r.ok
      ? (r.data as { briefDelivery: string; agentExists: boolean; provisionalName?: string })
      : null;
    // Nothing settled the brief, so the delivery outcome is honestly "unconfirmed"…
    expect(data?.briefDelivery).toBe("unconfirmed");
    // …but the payload must NOT hand back a usable handle for a row that is gone.
    expect(data?.agentExists).toBe(false);
    expect(data?.provisionalName).toBeUndefined();
    // AND THE SENTENCE HAS TO AGREE WITH THE FLAG. `unconfirmed` + `agentExists: false` is exactly
    // this scenario, and keying the copy on the delivery state alone told the human to go inspect an
    // agent that no longer exists — the same remedy-copy defect as "Start again" on a deleted row,
    // relocated into the last unconditional sentence (roborev 55888). The earlier version of this
    // test asserted the flag and never read the prose, so nothing caught it.
    const failure = r.ok ? (r.data as { briefFailure?: string }).briefFailure : undefined;
    expect(failure).not.toMatch(/check that it picked up/i);
    expect(failure).toMatch(/gone/i);
  });

  // Silence is not success. When no launch and no failure arrives, the op says "unconfirmed" — the
  // brief may still go out, so this is explicitly not a failure, but nothing may upgrade it either.
  it("never upgrades an unobserved brief into a success", async () => {
    const projectId = seedProject();
    // Drive the give-up bound with fake timers so the assertion needs no real clock and no sleep.
    vi.useFakeTimers();
    try {
      const pending = spawnWithPane({ projectId, prompt: "Fix the parser" }, "silence");
      await vi.advanceTimersByTimeAsync(BRIEF_DELIVERY_TIMEOUT_MS + 1);
      const r = await pending;
      const data = r.ok ? (r.data as { briefed: boolean; briefDelivery: string }) : null;
      expect(data?.briefed).toBe(false);
      expect(data?.briefDelivery).toBe("unconfirmed");
    } finally {
      vi.useRealTimers();
    }
  });

  // A queued brief is only ever delivered by an AgentPane's ptyReady flush, and Workspace mounts
  // panes solely for visited-or-current projects. spawn_build_agent takes an ARBITRARY projectId, so
  // spawning into a project the user hasn't opened would queue a brief nothing can drain — the queue
  // does not self-age, so it would sit there with no delivery and no expiry, while the reply claimed
  // briefed: true (roborev 55088). The spawn therefore has to make the target current.
  it("makes the target project current, so a pane exists to launch the brief", async () => {
    const alpha = seedProject("Alpha", "/tmp/alpha");
    const beta = seedProject("Beta", "/tmp/beta");
    useProjectStore.setState({ selectedProjectId: alpha } as never);

    // `silence` here on purpose: this test is about NAVIGATION, and the brief must still be sitting
    // attached and un-launched when we look at it. Timers are faked so the op's give-up bound does
    // not hold the test up — nothing about the delivery depends on a duration.
    vi.useFakeTimers();
    let r;
    try {
      const pending = spawnWithPane({ projectId: beta, prompt: "Fix the parser" }, "silence");
      // The navigation is synchronous, so it is already done before the brief-delivery wait.
      expect(useProjectStore.getState().selectedProjectId).toBe(beta);
      expect(wasProjectVisited(beta)).toBe(true);
      const agentId = agentsOf(beta).find((a) => a.kind === "build")!.id;
      // The brief is attached to the LAUNCH, waiting for the pane that this navigation guarantees —
      // it is not sitting in the pending-send queue whose flush lost the submit.
      expect(briefForLaunch(agentId, false)).toBe("Fix the parser");
      expect(takePendingSends(agentId).due).toEqual([]);
      await vi.advanceTimersByTimeAsync(BRIEF_DELIVERY_TIMEOUT_MS + 1);
      r = await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(r.ok).toBe(true);
  });

  // markProjectOpen must be PAIRED with the selection. Selecting a project whose tab is closed
  // leaves the strip with no tab for it and every tab reading aria-selected="false" — and it
  // self-heals the wrong way: the next tab close treats a selection with no tab as stale and yanks
  // the user elsewhere (engine/openProjects.selectionAfterClose). roborev 55095.
  it("opens the target project's tab, never selecting a tabless project", async () => {
    const alpha = seedProject("Alpha", "/tmp/alpha");
    const beta = seedProject("Beta", "/tmp/beta");
    useProjectStore.setState({ selectedProjectId: alpha } as never);
    useUiStore.setState({ openProjectIds: [alpha], pinnedProjectId: null } as never);

    await spawnWithPane({ projectId: beta, prompt: "go" });
    expect(useUiStore.getState().openProjectIds).toContain(beta);
    expect(useProjectStore.getState().selectedProjectId).toBe(beta);
  });

  // A torn-out project can be spawned into from NEITHER window. Main `continue`s on torn-out before
  // the visited-or-current check, and the satellite never learns the agent is open because
  // `openAgentIds` lives in runtimeStore, which crossWindowSync does not wire (only projectStore and
  // dictationStore are). So the agent would exist in no window — no worktree, no PTY — while still
  // holding a capacity slot. Briefed spawns have a second reason: the satellite has its own
  // pendingSends instance, so the brief is drained by nobody. Refused either way (roborev 55102).
  it.each([
    ["briefed", { prompt: "go" }],
    ["unbriefed", {}],
  ])("refuses a %s spawn into a torn-out project, creating nothing", async (_label, extra) => {
    const alpha = seedProject("Alpha", "/tmp/alpha");
    const beta = seedProject("Beta", "/tmp/beta");
    // addProject selects what it creates, so pin the selection explicitly — otherwise Beta is
    // already current and the navigation assertion would pass with the guard doing nothing.
    useProjectStore.setState({ selectedProjectId: alpha } as never);
    tornOutMock.mockReturnValue(true);

    const r = await dispatchConciergeTool(
      call({ domain: "lifecycle", op: "spawn_build_agent", args: { projectId: beta, ...extra } }),
    );
    expect(refusal(r).code).toBe("project-torn-out");
    expect(refusal(r).message).toMatch(/Beta/);
    // No agent, no capacity slot consumed…
    expect(agentsOf(beta).filter((a) => a.kind === "build")).toHaveLength(0);
    // …and main was not navigated onto the re-dock placeholder, away from the user's work.
    expect(useProjectStore.getState().selectedProjectId).toBe(alpha);
    // The remedy must name something the user can actually DO. The satellite renders columns ② + ③
    // only — no tab strip, no "+ New Build Agent" — and its own empty state says "start one from the
    // main Sparkle window". Telling them to start it over there is an instruction that cannot be
    // carried out, and it contradicts copy shipped in that very window (roborev 55102).
    expect(refusal(r).message).toMatch(/re-dock/i);
    expect(refusal(r).message).not.toMatch(/from (that|its) window/i);
  });

  // ORDERING IS THE POINT. The torn-out precondition depends only on the project, and can never be
  // satisfied by freeing slots — so it must be answered before the capacity gate. Reversed, a user
  // at the ceiling is told "close or finish one before starting another", closes a build agent on
  // the concierge's own instruction, retries, and only THEN learns to re-dock: an agent destroyed
  // for nothing, by a remedy pointing at the wrong problem (roborev 55105).
  /**
   * Fill the machine to its ceiling AND PROVE IT.
   *
   * Seeding N agents and trusting the cap to be below N is an unpinned precondition: the ceiling
   * lives in settingsStore, and if it is ever raised past N, `atCapacity` goes false and these
   * ordering tests degenerate into ordinary refusal tests — still green, because the invariant-only
   * refusals fire regardless of gate order. The control spawn below asserts the machine really is
   * full, so a raised ceiling fails HERE with a clear reason instead of silently defanging the
   * ordering assertions (roborev 55110).
   */
  async function fillToCapacity(projectId: string): Promise<void> {
    const store = useProjectStore.getState();
    for (let i = 0; i < 64; i++) store.addAgent(projectId, { kind: "build" });
    const control = await dispatchConciergeTool(
      call({ domain: "lifecycle", op: "spawn_build_agent", args: { projectId } }),
    );
    expect(
      refusal(control).code,
      "precondition: the machine must be at capacity for the ordering assertion to mean anything",
    ).toBe("at-capacity");
  }

  it("answers torn-out BEFORE at-capacity, so no agent is closed for nothing", async () => {
    const alpha = seedProject("Alpha", "/tmp/alpha");
    const beta = seedProject("Beta", "/tmp/beta");
    useProjectStore.setState({ selectedProjectId: alpha } as never);
    await fillToCapacity(alpha);
    // Marked torn-out only AFTER the control spawn, so the control proves capacity rather than
    // tripping the torn-out guard itself.
    tornOutMock.mockReturnValue(true);

    const r = await dispatchConciergeTool(
      call({ domain: "lifecycle", op: "spawn_build_agent", args: { projectId: beta } }),
    );
    expect(refusal(r).code).toBe("project-torn-out");
    // The destructive remedy must NOT be what the user is handed.
    expect(refusal(r).message).not.toMatch(/close or finish/i);
  });

  // Same principle, second precondition: an unknown model depends only on the caller's input and is
  // equally unsatisfiable by freeing slots. Both invariant-only gates belong above the one refusal
  // whose remedy destroys something (roborev 55108).
  it("answers unknown-model BEFORE at-capacity, so no agent is closed for nothing", async () => {
    const projectId = seedProject();
    await fillToCapacity(projectId);

    const r = await dispatchConciergeTool(
      call({
        domain: "lifecycle",
        op: "spawn_build_agent",
        args: { projectId, model: "claude-opus-4" },
      }),
    );
    expect(refusal(r).code).toBe("unknown-model");
    expect(refusal(r).message).not.toMatch(/close or finish/i);
  });

  // The DELIVERY path owns the prompt row, exactly once. Pre-writing it here is the roborev 55057
  // failure: `newAgentAttention.isBriefless` keys off `lastPrompt`/`promptHistory`, so seeding them
  // at spawn makes an agent that never got its brief read as CALM — a falsely-quiet row idling at an
  // empty prompt while the pinned header confidently shows a brief that was never sent. Since the
  // brief now goes out as launch argv, AgentPane records these on the ptyReady path instead.
  it("does not pre-write the prompt row — the delivery path owns that, exactly once", async () => {
    const projectId = seedProject();
    await spawnWithPane({ projectId, prompt: "Fix the parser" });
    const agent = agentsOf(projectId).find((a) => a.kind === "build")!;
    expect(agent.lastPrompt).toBe("");
    expect(agent.promptHistory).toEqual([]);
  });

  it("an omitted brief is a legitimate empty agent, not a half-finished one", async () => {
    const projectId = seedProject();
    const r = await dispatchConciergeTool(
      call({ domain: "lifecycle", op: "spawn_build_agent", args: { projectId } }),
    );
    const agentId = agentsOf(projectId).find((a) => a.kind === "build")!.id;
    expect(takePendingSends(agentId).due).toEqual([]);
    expect(r.ok && (r.data as { briefed: boolean }).briefed).toBe(false);
  });

  // A blank string would create exactly the briefless agent `prompt` exists to prevent, so it is a
  // bad-args refusal rather than being quietly treated as "no prompt".
  it("refuses an empty brief instead of silently spawning blank", async () => {
    const projectId = seedProject();
    const r = await dispatchConciergeTool(
      call({ domain: "lifecycle", op: "spawn_build_agent", args: { projectId, prompt: "" } }),
    );
    expect(refusal(r).code).toBe(REGISTRY_CODES.badArgs);
    expect(agentsOf(projectId).filter((a) => a.kind === "build")).toHaveLength(0);
  });

  it("sets the name at spawn rather than leaving it as a placeholder", async () => {
    const projectId = seedProject();
    await dispatchConciergeTool(
      call({ domain: "lifecycle", op: "spawn_build_agent", args: { projectId, name: "Parser Fix" } }),
    );
    expect(agentsOf(projectId).find((a) => a.kind === "build")!.name).toBe("Parser Fix");
  });

  it("records plan mode on the row, and reports the mode it actually started in", async () => {
    const projectId = seedProject();
    const planned = await dispatchConciergeTool(
      call({ domain: "lifecycle", op: "spawn_build_agent", args: { projectId, mode: "plan" } }),
    );
    expect(planned.ok && (planned.data as { mode: string }).mode).toBe("plan");
    expect(agentsOf(projectId).find((a) => a.kind === "build")!.permissionMode).toBe("plan");
  });

  // "build" is the ordinary mode and is represented by storing NOTHING, so asking for it can never
  // override a permission default the user configured in their own Claude Code settings.
  it("stores no permission mode for an ordinary build spawn", async () => {
    const projectId = seedProject();
    const r = await dispatchConciergeTool(
      call({ domain: "lifecycle", op: "spawn_build_agent", args: { projectId, mode: "build" } }),
    );
    expect(r.ok && (r.data as { mode: string }).mode).toBe("build");
    expect(agentsOf(projectId).find((a) => a.kind === "build")!.permissionMode).toBeUndefined();
  });

  // Routing cheap mechanical work to a small model is the REASON this argument exists, so a silent
  // fallback would bill the user for the opposite of what they asked for, with nothing in the reply
  // to reveal it. Refused BEFORE anything is created, so the store is left untouched.
  it("refuses an unknown model instead of silently using the default", async () => {
    const projectId = seedProject();
    const r = await dispatchConciergeTool(
      call({
        domain: "lifecycle",
        op: "spawn_build_agent",
        args: { projectId, model: "gpt-9-turbo" },
      }),
    );
    expect(refusal(r).code).toBe("unknown-model");
    expect(refusal(r).message).toMatch(/gpt-9-turbo/);
    expect(agentsOf(projectId).filter((a) => a.kind === "build")).toHaveLength(0);
  });

  it("accepts a real model id and puts it on the row", async () => {
    const projectId = seedProject();
    const r = await dispatchConciergeTool(
      call({
        domain: "lifecycle",
        op: "spawn_build_agent",
        args: { projectId, model: "claude-haiku-4-5" },
      }),
    );
    expect(r.ok).toBe(true);
    expect(agentsOf(projectId).find((a) => a.kind === "build")!.model).toBe("claude-haiku-4-5");
  });

  it("settles brief, name, model and mode together in a single call", async () => {
    const projectId = seedProject();
    const r = await spawnWithPane({
      projectId,
      prompt: "Audit the auth flow",
      name: "Auth Audit",
      model: "claude-haiku-4-5",
      mode: "plan",
    });
    expect(r.ok).toBe(true);
    const agent = agentsOf(projectId).find((a) => a.kind === "build")!;
    expect([agent.name, agent.model, agent.permissionMode]).toEqual([
      "Auth Audit",
      "claude-haiku-4-5",
      "plan",
    ]);
    // The brief went out with the launch (argv), so the racy PTY queue is empty and the brief is
    // no longer pending — one call settled all four things.
    expect(takePendingSends(agent.id).due).toEqual([]);
    expect(hasUndeliveredBrief(agent.id)).toBe(false);
    expect(r.ok && (r.data as { briefDelivery: string }).briefDelivery).toBe("submitted");
  });

  // ══ THE CLOUD ROUTE MUST FORWARD `prompt`, AND THIS IS THE ONLY THING THAT SAYS SO ═════════════
  // `spawn_cloud_build_agent` used to pass `{ projectId, runtime: "cloud" }` and nothing else, which
  // was harmless while the op was a guaranteed refusal — lifecycle never read the arguments. It
  // performs a real start now, and a cloud agent's GOAL is its `prompt` (the runner seeds Claude
  // Code with it via stdin as the sandbox comes up; there is no way to send it afterwards). Drop it
  // here and every cloud spawn lands on `cloud-goal-required` however carefully the brief was
  // written — with nothing in any other suite to notice, because lifecycle's own tests call it
  // directly.
  //
  // The assertion is a DISCRIMINATOR, not a mock call-check: with the repo probe stubbed to "no
  // remote", a forwarded prompt gets past the goal gate and stops at `cloud-no-repo`, while a
  // dropped one stops earlier at `cloud-goal-required`. Two different codes, one for each state.
  it("spawn_cloud_build_agent forwards `prompt` — the cloud agent's goal", async () => {
    const projectId = seedProject();
    useAuthStore.setState({
      tokenPresent: true,
      me: { cloudAgentsEnabled: true, entitled: true, balanceCents: 5_000 },
      // The cloud gate re-reads /me before deciding; the real refresh reaches the keychain and
      // would clear what this test just seeded.
      refresh: vi.fn(async () => {}),
    } as never);
    useCloudAuthStore.setState({ method: "byok", loaded: true } as never);

    const withGoal = await dispatchConciergeTool(
      call({
        domain: "lifecycle",
        op: "spawn_cloud_build_agent",
        args: { projectId, prompt: "fix the flaky checkout test" },
      }),
    );
    expect(refusal(withGoal).code).toBe("cloud-no-repo");

    const withoutGoal = await dispatchConciergeTool(
      call({ domain: "lifecycle", op: "spawn_cloud_build_agent", args: { projectId } }),
    );
    expect(refusal(withoutGoal).code).toBe("cloud-goal-required");
  });

  // A refusal with a self-serve fix must keep the fix across the reply boundary: `deepLink` is a
  // structured field on LifecycleRefused and the reply arm has no slot for one, so `fromLifecycle`
  // folds the route into the sentence. Dropping it leaves the concierge saying "you don't have
  // enough credits" with no way to get to Credits — the dead end the dialog's button removes.
  it("a cloud-gate refusal carries the Settings route the user needs, alongside the gate's own words", async () => {
    const projectId = seedProject();
    useAuthStore.setState({
      tokenPresent: true,
      me: { cloudAgentsEnabled: true, entitled: true, balanceCents: 0 },
      refresh: vi.fn(async () => {}),
    } as never);
    useCloudAuthStore.setState({ method: "byok", loaded: true } as never);
    const r = await dispatchConciergeTool(
      call({
        domain: "lifecycle",
        op: "spawn_cloud_build_agent",
        args: { projectId, prompt: "ship it" },
      }),
    );
    const { code, message } = refusal(r);
    expect(code).toBe("cloud-blocked");
    // The gate's sentence, verbatim…
    expect(message).toContain(
      "You don't have enough credits to start a cloud agent. Add credits to continue.",
    );
    // …plus the route, which is what the structured deepLink would otherwise have carried.
    expect(message).toContain("Settings → Credits");
  });

  // The store field is inert unless the launcher reads it, and build agents take a DIFFERENT spawn
  // branch (assembleBuildSpawn) from the generic one. Threading the flag into only the generic
  // branch meant it was never emitted for any agent that could carry it, while the reply still
  // claimed mode "plan" (roborev 55057). Assert the actual launch command, not the row.
  it("plan mode reaches the launched command on the branch build agents actually take", () => {
    const spawn = assembleBuildSpawn({
      claudePath: "/bin/claude",
      resume: false,
      cwd: "/wt",
      persona: "p",
      bridge: { socketPath: "/s.sock", token: "t" },
      paths: { nodePath: "/n", serverPath: "/o.js" },
      permissionMode: "plan",
    });
    expect(spawn.args.join(" ")).toContain("--permission-mode 'plan'");

    const ordinary = assembleBuildSpawn({
      claudePath: "/bin/claude",
      resume: false,
      cwd: "/wt",
      persona: "p",
      bridge: { socketPath: "/s.sock", token: "t" },
      paths: { nodePath: "/n", serverPath: "/o.js" },
    });
    expect(ordinary.args.join(" ")).not.toContain("--permission-mode");
  });
});

// ══ GATE 0 — THE RELAY GATE'S POSITION IS THE WHOLE FIX (bead `sparkle-p9s5q`) ═══════════════════
//
// The founder's second instruction: "nor should it send it to a build agent unless I have mentioned
// that build agent." A relay of his words to an agent he never named must not happen at all.
//
// THIS BLOCK IS ABOUT WHERE THE GATE SITS, not what it decides — ./relayGate.test.ts owns the
// decision. Position is what a reviewer cannot see and what a refactor silently breaks:
// `send_to_agent_terminal` is `disruptive`, so its default decision is `ask`, and the ask-tier
// return fires BEFORE the route handler. A gate inside the handler is therefore never reached on
// the first call — and the approved re-run arrives from a click handler after the turn has ended,
// with the founder's text already dropped, so it fails open. The gate was written in that position
// first and was inert for exactly the population that matters.
describe("the relay gate refuses BEFORE the approval tier", () => {
  const FOUNDER = "You should have better memory now. can you tell me if that's true?";
  const ask: ConciergeToolPolicy = () => ({ tier: "ask", approvedByUser: false });

  afterEach(() => setConciergeTurnOrigin(null));

  const send = (text: string, policy?: ConciergeToolPolicy) =>
    dispatchConciergeTool(
      call({
        domain: "terminal",
        op: "send_to_agent_terminal",
        args: { agentId: "ag-unnamed", text, goal: "", notWork: { reason: "fixture" } },
      }),
      policy ? { policy } : {},
    );

  it("refuses an unaddressed relay instead of raising an approval for it", async () => {
    setConciergeTurnOrigin("bubble-1", { text: FOUNDER, mentionedAgentIds: [] });
    const r = await send(FOUNDER, ask);
    // THE ASSERTION THAT PINS THE ORDER. Under the old placement this read `needs-approval`: the
    // policy answered first and the gate never ran. The human must not be asked to approve a send
    // that is not allowed to happen.
    expect(refusal(r).code).toBe(REGISTRY_CODES.unaddressedRelay);
    expect(refusal(r).code).not.toBe(REGISTRY_CODES.needsApproval);
  });

  it("still refuses on the APPROVED re-run — the path conciergeApprovalResume takes", async () => {
    setConciergeTurnOrigin("bubble-1", { text: FOUNDER, mentionedAgentIds: [] });
    // A FULLY APPROVED decision — bound to this call's own id, so nothing downstream could refuse
    // it for a reason other than the gate. That is what makes this row about the gate.
    const approved: ConciergeToolPolicy = () => ({
      tier: "ask",
      approvedByUser: true,
      approvedForToolCallId: TOOL_CALL_ID,
    });
    expect(refusal(await send(FOUNDER, approved)).code).toBe(REGISTRY_CODES.unaddressedRelay);
  });

  it("lets an ordinary ask-tier send reach the approval gate untouched", async () => {
    // THE POSITIVE CONTROL. Without it the rows above would pass against a build that had simply
    // stopped dispatching this op at all. A brief the concierge composed still asks for approval,
    // exactly as before — the gate narrows one shape, it does not seize the tool.
    setConciergeTurnOrigin("bubble-1", { text: FOUNDER, mentionedAgentIds: [] });
    const r = await send("STOP — you are 42 commits ahead of origin/main", ask);
    expect(refusal(r).code).toBe(REGISTRY_CODES.needsApproval);
  });

  it("lets a relay through to the approval gate when he NAMED the agent", async () => {
    setConciergeTurnOrigin("bubble-1", { text: FOUNDER, mentionedAgentIds: ["ag-unnamed"] });
    expect(refusal(await send(FOUNDER, ask)).code).toBe(REGISTRY_CODES.needsApproval);
  });
});
