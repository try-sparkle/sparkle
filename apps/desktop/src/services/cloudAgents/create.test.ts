import { describe, it, expect, vi } from "vitest";
import { createCloudAgent, type CreateCloudAgentDeps } from "./create";
import { CloudApiError } from "./api";
import type { AddAgentOpts } from "../../stores/projectStore";

function deps(startSession: CreateCloudAgentDeps["api"]["startSession"]) {
  const addAgent = vi.fn((_p: string, opts: AddAgentOpts): string | null => opts.id ?? "generated");
  const selectAgent = vi.fn();
  const open = vi.fn();
  return { d: { api: { startSession }, addAgent, selectAgent, open }, addAgent, selectAgent, open };
}

describe("createCloudAgent", () => {
  it("creates the tab with id = server session id, runtime cloud, then selects + opens it", async () => {
    const { d, addAgent, selectAgent, open } = deps(async () => ({ sessionId: "sess-xyz" }));
    const res = await createCloudAgent(
      { projectId: "p1", goal: "do it", repoUrl: "https://github.com/a/b", name: "Cloud A" },
      d,
    );
    expect(res).toEqual({ ok: true, id: "sess-xyz" });
    expect(addAgent).toHaveBeenCalledWith("p1", {
      id: "sess-xyz",
      kind: "build",
      runtime: "cloud",
      name: "Cloud A",
    });
    expect(selectAgent).toHaveBeenCalledWith("p1", "sess-xyz");
    expect(open).toHaveBeenCalledWith("sess-xyz");
  });

  it("omits name when not supplied (leaves the tab open to auto-naming)", async () => {
    const { d, addAgent } = deps(async () => ({ sessionId: "s" }));
    await createCloudAgent({ projectId: "p", goal: "g", repoUrl: "r" }, d);
    expect(addAgent).toHaveBeenCalledWith("p", { id: "s", kind: "build", runtime: "cloud" });
  });

  it("passes the start input straight through to the API", async () => {
    const startSession = vi.fn(async () => ({ sessionId: "s" }));
    const { d } = deps(startSession);
    await createCloudAgent(
      { projectId: "p", goal: "g", repoUrl: "r", baseBranch: "dev", name: "N" },
      d,
    );
    expect(startSession).toHaveBeenCalledWith({
      projectId: "p",
      goal: "g",
      repoUrl: "r",
      baseBranch: "dev",
      name: "N",
    });
  });

  it("on a feature-disabled start error returns guidance and creates NO tab", async () => {
    const { d, addAgent } = deps(async () => {
      throw new CloudApiError(403, "cloud_agents_disabled", "off");
    });
    const res = await createCloudAgent({ projectId: "p", goal: "g", repoUrl: "r" }, d);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.guidance.reason).toBe("feature_disabled");
    expect(addAgent).not.toHaveBeenCalled();
  });

  it("on out-of-credits returns credits deep-link guidance", async () => {
    const { d } = deps(async () => {
      throw new CloudApiError(402, null, "no money");
    });
    const res = await createCloudAgent({ projectId: "p", goal: "g", repoUrl: "r" }, d);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.guidance.reason).toBe("insufficient_credits");
      expect(res.guidance.deepLink).toBe("credits");
    }
  });

  it("on a missing-auth error returns cloudauth deep-link guidance", async () => {
    const { d } = deps(async () => {
      throw new CloudApiError(400, "no_claude_auth", "add a key");
    });
    const res = await createCloudAgent({ projectId: "p", goal: "g", repoUrl: "r" }, d);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.guidance.deepLink).toBe("cloudauth");
  });

  it("classifies a non-CloudApiError (transport failure) too", async () => {
    const { d, addAgent } = deps(async () => {
      throw new Error("Failed to fetch");
    });
    const res = await createCloudAgent({ projectId: "p", goal: "g", repoUrl: "r" }, d);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.guidance.reason).toBe("offline");
    expect(addAgent).not.toHaveBeenCalled();
  });

  it("when the store refuses the insert (project gone) it neither selects nor opens a phantom tab", async () => {
    const { d, selectAgent, open } = deps(async () => ({ sessionId: "sess-orphan" }));
    d.addAgent = vi.fn(() => null); // projectStore.addAgent's unknown-project return
    const res = await createCloudAgent({ projectId: "gone", goal: "g", repoUrl: "r" }, d);
    expect(res.ok).toBe(false);
    // …and it says the session IS running (it is — the start call succeeded), not that it failed.
    if (!res.ok) expect(res.guidance.message).toMatch(/started/i);
    expect(selectAgent).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  // The reason is the machine-readable half of that honesty: the dialog disables its Start button
  // on it, so a mis-classified `generic` here would re-offer a retry that bills a SECOND sandbox.
  it("reports the refused insert as started_untracked and hands back the orphaned session id", async () => {
    const { d } = deps(async () => ({ sessionId: "sess-orphan" }));
    d.addAgent = vi.fn(() => null);
    const res = await createCloudAgent({ projectId: "gone", goal: "g", repoUrl: "r" }, d);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.guidance.reason).toBe("started_untracked");
      expect(res.orphanedSessionId).toBe("sess-orphan");
      // Never a deep-link/sign-in nudge — nothing the user configures would have prevented this.
      expect(res.guidance.deepLink).toBeUndefined();
      expect(res.guidance.needsSignIn).toBeUndefined();
    }
  });

  it("a SUCCESSFUL create carries no orphaned session id", async () => {
    const { d } = deps(async () => ({ sessionId: "sess-ok" }));
    const res = await createCloudAgent({ projectId: "p", goal: "g", repoUrl: "r" }, d);
    expect(res).toEqual({ ok: true, id: "sess-ok" });
  });
});
