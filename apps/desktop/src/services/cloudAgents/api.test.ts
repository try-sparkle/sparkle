import { describe, it, expect } from "vitest";
import { makeCloudApi, CloudApiError, type CloudApiDeps } from "./api";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Build a cloud API whose fetch returns a scripted response and records every request. */
function harness(
  respond: (rec: Recorded) => { status?: number; json?: unknown; text?: string },
  opts: { token?: string | null } = {},
) {
  const calls: Recorded[] = [];
  const deps: CloudApiDeps = {
    baseUrl: "https://orch.test",
    getToken: async () => (opts.token === undefined ? "tok-123" : opts.token),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const rec: Recorded = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: (init?.headers as Record<string, string>) ?? {},
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      };
      calls.push(rec);
      const r = respond(rec);
      const payload = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : "");
      return new Response(payload, { status: r.status ?? 200 });
    }) as unknown as typeof fetch,
  };
  return { api: makeCloudApi(deps), calls };
}

describe("cloud api — startSession", () => {
  it("sends the snake_case wire body and returns the server session id", async () => {
    const { api, calls } = harness(() => ({ json: { session_id: "sess-abc" } }));
    const out = await api.startSession({
      projectId: "proj-1",
      goal: "build the thing",
      repoUrl: "https://github.com/acme/repo",
      baseBranch: "main",
      name: "My cloud agent",
    });
    expect(out).toEqual({ sessionId: "sess-abc" });
    expect(calls[0]!.url).toBe("https://orch.test/sessions/start");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.authorization).toBe("Bearer tok-123");
    expect(calls[0]!.body).toEqual({
      project_id: "proj-1",
      goal: "build the thing",
      repo_url: "https://github.com/acme/repo",
      base_branch: "main",
      name: "My cloud agent",
    });
  });

  it("omits optional fields when not provided", async () => {
    const { api, calls } = harness(() => ({ json: { session_id: "s" } }));
    await api.startSession({ projectId: "p", goal: "g", repoUrl: "r" });
    expect(calls[0]!.body).toEqual({ project_id: "p", goal: "g", repo_url: "r" });
  });

  it("throws a CloudApiError carrying the server status + stable code (feature disabled)", async () => {
    const { api } = harness(() => ({
      status: 403,
      json: { code: "cloud_agents_disabled", message: "feature off" },
    }));
    await expect(
      api.startSession({ projectId: "p", goal: "g", repoUrl: "r" }),
    ).rejects.toMatchObject({ name: "CloudApiError", status: 403, code: "cloud_agents_disabled" });
  });

  it("throws when the server returns no session id", async () => {
    const { api } = harness(() => ({ json: {} }));
    await expect(api.startSession({ projectId: "p", goal: "g", repoUrl: "r" })).rejects.toBeInstanceOf(
      CloudApiError,
    );
  });

  it("throws signed_out (401) before any fetch when there is no token", async () => {
    const { api, calls } = harness(() => ({ json: {} }), { token: null });
    await expect(api.startSession({ projectId: "p", goal: "g", repoUrl: "r" })).rejects.toMatchObject({
      status: 401,
      code: "signed_out",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("cloud api — listSessions", () => {
  it("requests the project-scoped list and normalizes rows", async () => {
    const { api, calls } = harness(() => ({
      json: {
        sessions: [
          { id: "s1", status: "active", name: "A", goal: "g" },
          { id: "s2", status: "complete" },
          "garbage",
        ],
      },
    }));
    const out = await api.listSessions("proj 1");
    expect(calls[0]!.url).toBe("https://orch.test/sessions?project_id=proj%201");
    expect(out).toEqual([
      { id: "s1", status: "active", name: "A", goal: "g" },
      { id: "s2", status: "complete", name: null, goal: null },
    ]);
  });

  it("drops rows without a real string id (empty, missing, or non-string) — never a bogus tab id", async () => {
    const { api } = harness(() => ({
      json: {
        sessions: [
          { status: "active" }, //          missing id
          { id: "", status: "active" }, //  empty id
          { id: 42, status: "active" }, //  numeric id → would coerce to "42"
          { id: {}, status: "active" }, //  object id → would coerce to "[object Object]"
          { id: "ok", status: "active" }, // the only valid row
        ],
      },
    }));
    const out = await api.listSessions("p");
    expect(out.map((s) => s.id)).toEqual(["ok"]);
  });

  it("coerces a non-string status to '' (which reconcile then treats as terminal)", async () => {
    const { api } = harness(() => ({
      json: { sessions: [{ id: "x", status: 1 }] },
    }));
    const out = await api.listSessions("p");
    expect(out).toEqual([{ id: "x", status: "", name: null, goal: null }]);
  });

  it("returns [] when the body has no sessions array", async () => {
    const { api } = harness(() => ({ json: {} }));
    expect(await api.listSessions("p")).toEqual([]);
  });
});

// The chiefProjectId round-trip IS the project-binding key projectLink resolves on, so both
// directions are pinned here: sent on create, and read back (non-empty string or null) on list.
describe("cloud api — projects", () => {
  it("createProject sends the local id as chiefProjectId, and omits the key when absent", async () => {
    const { api, calls } = harness(() => ({ json: { id: "srv-1" } }));
    await expect(api.createProject("Demo", "local-1")).resolves.toEqual({ id: "srv-1" });
    expect(calls[0]!.url).toBe("https://orch.test/projects");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ name: "Demo", chiefProjectId: "local-1" });

    const bare = harness(() => ({ json: { id: "srv-2" } }));
    await bare.api.createProject("Demo");
    expect(bare.calls[0]!.body).toEqual({ name: "Demo" });
  });

  it("createProject rejects a response with no usable id", async () => {
    const { api } = harness(() => ({ json: { id: "" } }));
    await expect(api.createProject("Demo")).rejects.toBeInstanceOf(CloudApiError);
  });

  it("listProjects normalizes chiefProjectId to a non-empty string or null", async () => {
    const { api } = harness(() => ({
      json: [
        { id: "a", name: "A", chiefProjectId: "local-a" },
        { id: "b", name: "B" }, // absent
        { id: "c", name: "C", chiefProjectId: "" }, // empty → null, never a "" claim
        { id: "d", name: "D", chiefProjectId: 42 }, // non-string → null, never coerced
      ],
    }));
    expect(await api.listProjects()).toEqual([
      { id: "a", name: "A", chiefProjectId: "local-a" },
      { id: "b", name: "B", chiefProjectId: null },
      { id: "c", name: "C", chiefProjectId: null },
      { id: "d", name: "D", chiefProjectId: null },
    ]);
  });

  it("listProjects drops rows without a genuine string id, and tolerates a non-array body", async () => {
    const { api } = harness(() => ({ json: [{ id: 7, name: "coerced" }, { name: "no id" }, null] }));
    expect(await api.listProjects()).toEqual([]);
    expect(await harness(() => ({ json: {} })).api.listProjects()).toEqual([]);
  });
});

describe("cloud api — claude auth", () => {
  it("GET returns the method when configured", async () => {
    const { api } = harness(() => ({ json: { method: "byok" } }));
    expect(await api.getClaudeAuth()).toEqual({ method: "byok" });
  });

  it("GET returns null on 404 and on a 200 with null body", async () => {
    expect(await harness(() => ({ status: 404 })).api.getClaudeAuth()).toBeNull();
    expect(await harness(() => ({ json: null })).api.getClaudeAuth()).toBeNull();
  });

  it("GET never surfaces a secret even if the server erroneously included one", async () => {
    // Defense in depth: the returned object only ever exposes `method`, never a secret field.
    const { api } = harness(() => ({ json: { method: "subscription", secret: "sk-LEAK" } }));
    const info = await api.getClaudeAuth();
    expect(info).toEqual({ method: "subscription" });
    expect(JSON.stringify(info)).not.toContain("sk-LEAK");
  });

  it("PUT sends { method, secret } in the request body and resolves void", async () => {
    const { api, calls } = harness(() => ({ status: 200 }));
    await expect(api.putClaudeAuth("byok", "sk-ant-xyz")).resolves.toBeUndefined();
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.body).toEqual({ method: "byok", secret: "sk-ant-xyz" });
  });

  it("PUT surfaces a server rejection (e.g. subscription disabled) as a CloudApiError", async () => {
    const { api } = harness(() => ({
      status: 403,
      json: { code: "subscription_auth_disabled", message: "not allowed" },
    }));
    await expect(api.putClaudeAuth("subscription", "tok")).rejects.toMatchObject({
      status: 403,
      code: "subscription_auth_disabled",
    });
  });

  it("DELETE issues a DELETE and resolves void", async () => {
    const { api, calls } = harness(() => ({ status: 200 }));
    await expect(api.deleteClaudeAuth()).resolves.toBeUndefined();
    expect(calls[0]!.method).toBe("DELETE");
  });
});

// The `promotion` field turns an ordinary start into the adoption of an already-running local
// agent. Every assertion below is about the WIRE SHAPE, because that is where it can go wrong
// silently: the route's schema drops unknown keys, so a camelCase `sessionId` would not error — it
// would downgrade the promotion into a normal start that cuts its own branch and loses the
// conversation, and the desktop would never hear about it.
describe("cloud api — startSession promotion field", () => {
  const base = {
    projectId: "proj-1",
    goal: "continue",
    repoUrl: "https://github.com/acme/repo",
  };

  it("snake_cases the promotion object AND its nested transcript", async () => {
    const { api, calls } = harness(() => ({ json: { session_id: "tab-1" } }));
    await api.startSession({
      ...base,
      promotion: {
        sessionId: "tab-1",
        branch: "sparkle/agent-42",
        transcript: { sessionId: "claude-sess-9", jsonl: '{"a":1}\n{"b":2}' },
      },
    });
    expect(calls[0]!.body).toEqual({
      project_id: "proj-1",
      goal: "continue",
      repo_url: "https://github.com/acme/repo",
      promotion: {
        session_id: "tab-1",
        branch: "sparkle/agent-42",
        transcript: { session_id: "claude-sess-9", jsonl: '{"a":1}\n{"b":2}' },
      },
    });
    const raw = JSON.stringify(calls[0]!.body);
    expect(raw).not.toContain("sessionId");
  });

  it("omits `transcript` entirely when no conversation travels", async () => {
    const { api, calls } = harness(() => ({ json: { session_id: "tab-1" } }));
    await api.startSession({
      ...base,
      promotion: { sessionId: "tab-1", branch: "sparkle/agent-42" },
    });
    const body = calls[0]!.body as { promotion: Record<string, unknown> };
    expect(body.promotion).toEqual({ session_id: "tab-1", branch: "sparkle/agent-42" });
    expect("transcript" in body.promotion).toBe(false);
  });

  it("sends NO promotion key at all for an ordinary born-in-the-cloud start", async () => {
    const { api, calls } = harness(() => ({ json: { session_id: "s" } }));
    await api.startSession(base);
    expect(calls[0]!.body).not.toHaveProperty("promotion");
  });
});
