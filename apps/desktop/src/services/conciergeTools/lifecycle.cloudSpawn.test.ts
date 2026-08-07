// `spawnBuildAgent({ runtime: "cloud" })` — the concierge starting a CLOUD agent
// (design 2026-08-01 §Decision 7, plan §W5.1).
//
// ══ WHAT THESE TESTS ASSERT, AND WHY IT IS NOT `r.ok` ═══════════════════════════════════════════
// This op used to be a blanket refusal, so every assertion about it was an assertion about a return
// value. It performs a real, BILLING start now, which moves the whole burden onto side effects:
//   • a refusal must be provable by `startSession` NEVER HAVING BEEN CALLED — "returned ok:false"
//     says nothing about whether a sandbox was spun up first;
//   • a success must be provable by the goal and repo the server actually received, and by the tab
//     that landed in the store.
// So `cloudApi` is the only double: `createCloudAgent`, `ensureCloudProjectId` and the gate are the
// REAL implementations, which is what makes "the same sequence the dialog runs" a tested claim
// rather than a comment.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../tasks", () => ({ createBeadFull: vi.fn(async () => "bd-new") }));
vi.mock("../closeAgentActions", () => ({
  shipAgent: vi.fn(),
  saveAgent: vi.fn(),
  discardAgentGit: vi.fn(),
  spinDownAgentGit: vi.fn(),
}));
vi.mock("../cloudAgents/terminate", () => ({ terminateIfCloud: vi.fn(async () => {}) }));

// The repo probe shells out to `gh` via Tauri — stubbed, and its NULL arm is a refusal under test.
const projectRepoUrl = vi.fn(async (_root: string): Promise<string | null> => "https://github.com/acme/demo");
vi.mock("../cloudAgents/repoUrl", () => ({ projectRepoUrl: (r: string) => projectRepoUrl(r) }));

// THE ONLY DOUBLE UNDER THE CLOUD SEQUENCE.
const startSession = vi.fn(async (_i: unknown) => ({ sessionId: "sess-1" }));
const listProjects = vi.fn(async () => [] as Array<{ id: string; name: string; chiefProjectId?: string | null }>);
const createProject = vi.fn(async (name: string, _chiefProjectId?: string) => ({ id: "cloud-p1", name }));
const getClaudeAuth = vi.fn(async () => ({ method: "byok" as const }));
vi.mock("../cloudAgents/api", () => ({
  cloudApi: {
    startSession: (i: unknown) => startSession(i),
    listProjects: () => listProjects(),
    createProject: (n: string, c?: string) => createProject(n, c),
    getClaudeAuth: () => getClaudeAuth(),
  },
}));

import { spawnBuildAgent } from "./lifecycle";
import { useAuthStore } from "../../stores/authStore";
import { useCloudAuthStore } from "../../stores/cloudAuthStore";
import { useProjectStore } from "../../stores/projectStore";
import type { Project } from "../../types";

const project: Project = {
  id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
  createdAt: new Date(0).toISOString(), selectedAgentId: null, agents: [],
};

/** Everything the gate needs, all green. Each test that exercises a block turns exactly one off. */
function signedInAndFunded() {
  useAuthStore.setState({
    tokenPresent: true,
    me: { cloudAgentsEnabled: true, entitled: true, balanceCents: 5_000 },
  } as never);
  // `loaded: true` so the gate reads the store rather than probing — the probe itself is asserted
  // in its own test below.
  useCloudAuthStore.setState({ method: "byok", loaded: true } as never);
}

const agentsOf = () =>
  useProjectStore.getState().projects.find((p) => p.id === "p1")?.agents ?? [];

beforeEach(() => {
  vi.clearAllMocks();
  projectRepoUrl.mockResolvedValue("https://github.com/acme/demo");
  startSession.mockResolvedValue({ sessionId: "sess-1" });
  listProjects.mockResolvedValue([]);
  useProjectStore.setState(
    { projects: [structuredClone(project)], selectedProjectId: "p1" } as never,
  );
  signedInAndFunded();
});

describe("a cloud spawn that is allowed to proceed", () => {
  it("starts the session with the concierge's prompt AS THE GOAL and the project's repo", async () => {
    const r = await spawnBuildAgent({
      projectId: "p1",
      runtime: "cloud",
      prompt: "fix the flaky checkout test and open a PR",
    });

    // THE SIDE EFFECT. A cloud agent's goal is delivered by the runner via stdin at start, so the
    // goal reaching `POST /sessions/start` is the entire delivery — there is no later send to check.
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(startSession).toHaveBeenCalledWith({
      projectId: "cloud-p1",
      goal: "fix the flaky checkout test and open a PR",
      repoUrl: "https://github.com/acme/demo",
      baseBranch: "main",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.op).toBe("spawn_cloud_build_agent");
    // The risk class the old refusal already carried, and which now actually gates something.
    expect(r.risk).toBe("costs-money");
  });

  it("materializes the tab with the SERVER session id and runtime cloud", async () => {
    await spawnBuildAgent({ projectId: "p1", runtime: "cloud", prompt: "ship it" });
    // One id for the store, the relay and the phone — the premise every downstream consumer keys on.
    expect(agentsOf().map((a) => [a.id, a.runtime])).toEqual([["sess-1", "cloud"]]);
  });

  it("forwards an explicit name and reports it as NOT provisional", async () => {
    const r = await spawnBuildAgent({
      projectId: "p1", runtime: "cloud", prompt: "ship it", name: "Checkout Fix",
    });
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ name: "Checkout Fix" }));
    if (!r.ok) throw new Error("expected ok");
    expect(r.data).toMatchObject({
      provisionalName: "Checkout Fix",
      nameIsProvisional: false,
      goalDelivery: "accepted-by-server",
      billsWhileRunning: true,
      runtime: "cloud",
    });
  });

  it("omits provisionalName entirely when nothing named it — there is no name to quote yet", async () => {
    const r = await spawnBuildAgent({ projectId: "p1", runtime: "cloud", prompt: "ship it" });
    if (!r.ok) throw new Error("expected ok");
    expect(r.data.provisionalName).toBeUndefined();
    expect(r.data.nameIsProvisional).toBe(true);
  });

  it("probes the server for saved Claude auth when the store is COLD, instead of refusing", async () => {
    // cloudAuthStore is deliberately not persisted, so it is cold on every launch. A human sees the
    // dialog's own probe; a tool call has no such moment, so it probes here — which is how the tool
    // can answer with the specific "add your Claude authentication" guidance rather than a generic
    // server failure.
    useCloudAuthStore.setState({ method: null, loaded: false } as never);
    const r = await spawnBuildAgent({ projectId: "p1", runtime: "cloud", prompt: "ship it" });
    expect(getClaudeAuth).toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it("a probe that returns NO CREDENTIAL refuses with the actionable auth message", async () => {
    // THE BRANCH THE PROBE EXISTS FOR, and the one nothing pinned (roborev 58530): replacing the
    // whole `authConfigured` expression with `true` left every suite green, so the probe could
    // decay into a pure round-trip cost — a user with no credential getting a generic server
    // failure instead of the sentence that tells them what to do. The two probe tests above assert
    // only `ok === true`; the other gate refusals in this file are driven by credits and sign-in.
    useCloudAuthStore.setState({ method: null, loaded: false } as never);
    getClaudeAuth.mockResolvedValueOnce(null as never);

    const r = await spawnBuildAgent({ projectId: "p1", runtime: "cloud", prompt: "ship it" });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("cloud-blocked");
    // VERBATIM, for the same reason as the credits case below: one sentence, not a paraphrase that
    // can drift from what the dialog shows for the identical state.
    expect(r.message).toBe("Add your Claude authentication to run agents in the cloud.");
    expect(r.deepLink).toBe("cloudauth");
    // …and nothing was spent finding that out, which is the whole point of probing first.
    expect(startSession).not.toHaveBeenCalled();
  });

  it("a FAILED probe lets the spawn reach the server, rather than refusing on an answer nobody got", async () => {
    // THE CASE THE `|| !loaded` CLAUSE EXISTS FOR, and the reason the test above cannot see it:
    // there the probe SUCCEEDS, so `method != null` decides and the clause is never the deciding
    // term (roborev 58524). `refresh` deliberately leaves `loaded` false when the GET fails, and
    // that state persists for the rest of the sign-in — so refusing on it would turn one flaky GET
    // into "add your Claude authentication" on every cloud spawn by a fully configured account.
    // Unprobed is UNKNOWN; POST /sessions/start is the definitive refusal.
    useCloudAuthStore.setState({ method: null, loaded: false } as never);
    getClaudeAuth.mockRejectedValueOnce(new Error("offline"));

    const r = await spawnBuildAgent({ projectId: "p1", runtime: "cloud", prompt: "ship it" });

    expect(r.ok).toBe(true);
    expect(startSession).toHaveBeenCalledTimes(1);
  });
});

describe("the three preconditions, each refusing with its OWN reason and starting NOTHING", () => {
  it("the cloud gate: returns the gate's message VERBATIM, with its deep link", async () => {
    useAuthStore.setState({
      tokenPresent: true,
      me: { cloudAgentsEnabled: true, entitled: true, balanceCents: 0 },
    } as never);
    const r = await spawnBuildAgent({ projectId: "p1", runtime: "cloud", prompt: "ship it" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("cloud-blocked");
    // VERBATIM. This is `evaluateCloudGate`'s own sentence — the same one the creation dialog
    // renders for the identical block. A paraphrase here would be a second copy that can drift from
    // the one a user sees for the same state, and the deep link is what makes it actionable.
    expect(r.message).toBe(
      "You don't have enough credits to start a cloud agent. Add credits to continue.",
    );
    expect(r.deepLink).toBe("credits");
    // And nothing was spent finding that out.
    expect(startSession).not.toHaveBeenCalled();
    expect(projectRepoUrl).not.toHaveBeenCalled();
    expect(agentsOf()).toHaveLength(0);
  });

  // THE SAME NUMBER THE DIALOG QUOTES. `cloudCostLine` tells a 50¢ user "You need $1.00 to start";
  // the concierge must refuse on that floor too, or one surface states the price and the other
  // cheerfully starts a run the server rejects. 50¢ clears the client's own 1¢ "obviously empty"
  // fallback, so ONLY the server's `minStartCents` can produce this refusal.
  it("the cloud gate: refuses below the SERVER's start floor, not just an empty wallet", async () => {
    useAuthStore.setState({
      tokenPresent: true,
      me: {
        cloudAgentsEnabled: true,
        entitled: true,
        balanceCents: 50,
        cloudAgentPricing: { centsPerMinute: 0.9, minStartCents: 100 },
      },
    } as never);
    const r = await spawnBuildAgent({ projectId: "p1", runtime: "cloud", prompt: "ship it" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("cloud-blocked");
    expect(r.deepLink).toBe("credits");
    expect(startSession).not.toHaveBeenCalled();
  });

  // …and an older `/me` that carries no floor must not be narrowed on a number we never received.
  it("the cloud gate: allows the same balance when the server stated no floor", async () => {
    useAuthStore.setState({
      tokenPresent: true,
      me: { cloudAgentsEnabled: true, entitled: true, balanceCents: 50 },
    } as never);
    const r = await spawnBuildAgent({ projectId: "p1", runtime: "cloud", prompt: "ship it" });
    expect(r.ok).toBe(true);
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it("the cloud gate: a signed-out user gets the gate's sign-in sentence, not an invented one", async () => {
    useAuthStore.setState({ tokenPresent: false, me: { cloudAgentsEnabled: true } } as never);
    const r = await spawnBuildAgent({ projectId: "p1", runtime: "cloud", prompt: "ship it" });
    if (r.ok) throw new Error("expected refusal");
    expect(r.message).toBe("Sign in to run agents in the cloud.");
    expect(startSession).not.toHaveBeenCalled();
  });

  it("NO PROMPT: refuses rather than inventing a goal, and starts nothing", async () => {
    const r = await spawnBuildAgent({ projectId: "p1", runtime: "cloud" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("cloud-goal-required");
    // THE ASSERTION THAT MATTERS: a sandbox bills per minute, so a spawn that made up a goal would
    // charge the user for work nobody asked for.
    expect(startSession).not.toHaveBeenCalled();
    expect(agentsOf()).toHaveLength(0);
  });

  it("a whitespace-only prompt is no goal either", async () => {
    const r = await spawnBuildAgent({ projectId: "p1", runtime: "cloud", prompt: "   " });
    if (r.ok) throw new Error("expected refusal");
    expect(r.reason).toBe("cloud-goal-required");
    expect(startSession).not.toHaveBeenCalled();
  });

  it("NO GITHUB REMOTE: refuses before the start call, because the sandbox clones the repo", async () => {
    projectRepoUrl.mockResolvedValue(null);
    const r = await spawnBuildAgent({ projectId: "p1", runtime: "cloud", prompt: "ship it" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("cloud-no-repo");
    // Sending a bad URL would surface minutes later as an opaque clone failure — inside a sandbox
    // that has been billing the whole time.
    expect(startSession).not.toHaveBeenCalled();
    expect(agentsOf()).toHaveLength(0);
  });

  it("names a project that isn't open: refuses before anything cloud-side runs", async () => {
    const r = await spawnBuildAgent({ projectId: "nope", runtime: "cloud", prompt: "ship it" });
    if (r.ok) throw new Error("expected refusal");
    expect(r.reason).toBe("no-project");
    expect(startSession).not.toHaveBeenCalled();
    expect(getClaudeAuth).not.toHaveBeenCalled();
  });
});

describe("the server's own refusal is forwarded, not re-worded", () => {
  it("a 402 comes back as action-failed carrying the classifier's message and deep link", async () => {
    startSession.mockRejectedValue(
      Object.assign(new Error("insufficient credits"), {
        status: 402,
        code: "insufficient_credits",
      }),
    );
    const r = await spawnBuildAgent({ projectId: "p1", runtime: "cloud", prompt: "ship it" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("action-failed");
    // The SAME classifier the dialog uses, so one failure gets one set of fixes wherever it lands.
    expect(r.deepLink).toBe("credits");
    expect(r.message.length).toBeGreaterThan(0);
    // The start failed, so no tab may exist for it.
    expect(agentsOf()).toHaveLength(0);
  });

  it("a throw from the project-link step is classified rather than escaping", async () => {
    listProjects.mockRejectedValue(new Error("network down"));
    const r = await spawnBuildAgent({ projectId: "p1", runtime: "cloud", prompt: "ship it" });
    if (r.ok) throw new Error("expected refusal");
    expect(r.reason).toBe("action-failed");
    expect(startSession).not.toHaveBeenCalled();
  });
});
