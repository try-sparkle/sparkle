import { describe, it, expect, vi, afterEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  ensureChiefProject,
  uploadAsset,
  resolveEnvChiefPat,
  listAssets,
  listAllAssets,
  deleteAsset,
  wipeChiefLibrary,
  startChat,
  sendMessage,
  createMemory,
  listMemories,
  ensureSkill,
  attachLabel,
} from "./chief";

// A minimal Response stand-in for the bits chief.ts reads (ok/status/text).
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

afterEach(() => vi.restoreAllMocks());

describe("ensureChiefProject — truncated-name reuse/create", () => {
  it("reuses an existing project matched against the 128-char-truncated name", async () => {
    const longName = "X".repeat(200);
    const stored = longName.slice(0, 128);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/v1/projects") && method === "GET") {
          return jsonResponse([{ project_id: "project_existing", name: stored }]);
        }
        throw new Error(`unexpected ${method} ${url}`); // createProject must NOT be called
      });

    const id = await ensureChiefProject("pat_test", longName, undefined);
    expect(id).toBe("project_existing");
    // Exactly one call (the list); no create.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("creates with the truncated name when no match exists", async () => {
    const longName = "Y".repeat(200);
    const stored = longName.slice(0, 128);
    let createdName: string | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/v1/projects") && method === "GET") {
          return jsonResponse([]); // no existing projects -> miss
        }
        if (url.endsWith("/v1/projects") && method === "POST") {
          createdName = JSON.parse(String(init?.body)).name;
          return jsonResponse({ project_id: "project_new", name: createdName }, true, 201);
        }
        throw new Error(`unexpected ${method} ${url}`);
      },
    );

    const id = await ensureChiefProject("pat_test", longName, undefined);
    expect(id).toBe("project_new");
    expect(createdName).toBe(stored); // created with the same truncated value it would match on
  });

  it("dedupes concurrent calls so two agents in one project can't create duplicates", async () => {
    let creates = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/v1/projects") && method === "GET") {
          // Latency so BOTH list calls return (finding nothing) before either create lands —
          // the exact interleaving that produced two duplicate Chief projects.
          await new Promise((r) => setTimeout(r, 5));
          return jsonResponse([]);
        }
        if (url.endsWith("/v1/projects") && method === "POST") {
          creates += 1;
          return jsonResponse({ project_id: "project_new", name: "Proj" }, true, 201);
        }
        throw new Error(`unexpected ${method} ${url}`);
      },
    );

    const [a, b] = await Promise.all([
      ensureChiefProject("pat_test", "Proj", undefined),
      ensureChiefProject("pat_test", "Proj", undefined),
    ]);

    expect(a).toBe("project_new");
    expect(b).toBe("project_new");
    expect(creates).toBe(1); // one create despite two concurrent callers
  });

  it("short-circuits to an already-known project id without any fetch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const id = await ensureChiefProject("pat_test", "Anything", "project_known");
    expect(id).toBe("project_known");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("resolveEnvChiefPat — runtime PAT from the Rust backend", () => {
  afterEach(() => invoke.mockReset());

  it("invokes the chief_pat command and returns the trimmed token", async () => {
    invoke.mockResolvedValue("  pat_env  ");
    expect(await resolveEnvChiefPat()).toBe("pat_env");
    expect(invoke).toHaveBeenCalledWith("chief_pat");
  });

  it("returns empty string when the command rejects (no env token / not under Tauri)", async () => {
    invoke.mockRejectedValue(new Error("no Chief PAT"));
    expect(await resolveEnvChiefPat()).toBe("");
  });
});

describe("uploadAsset — 3-step Chief asset upload", () => {
  it("creates the asset, PUTs the bytes to the signed url, then completes it", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown; headers?: unknown }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push({ url, method, body: init?.body, headers: init?.headers });
        if (url.endsWith("/v1/assets") && method === "POST") {
          return jsonResponse(
            {
              asset_id: "asset_abc",
              already_exists: false,
              upload_url: "https://storage.example.com/signed?sig=1",
              upload_method: "PUT",
              upload_headers: { "Content-Type": "text/markdown" },
              expires_at: "2026-06-24T00:00:00Z",
            },
            true,
            201,
          );
        }
        if (url.startsWith("https://storage.example.com/") && method === "PUT") {
          return jsonResponse({}, true, 200);
        }
        if (url.endsWith("/v1/assets/asset_abc/complete") && method === "POST") {
          return jsonResponse({ asset_id: "asset_abc", status: "ingesting" });
        }
        throw new Error(`unexpected ${method} ${url}`);
      },
    );

    const res = await uploadAsset("pat_test", "project_x", "PRD/main.md @ abc1234", "# hello");

    expect(res).toEqual({ assetId: "asset_abc", alreadyExists: false });
    expect(calls).toHaveLength(3);
    // Step 1: create with the filename + markdown mime; project-scoped.
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/v1/assets");
    expect(JSON.parse(String(calls[0]?.body))).toMatchObject({
      filename: "PRD/main.md @ abc1234",
      mime_type: "text/markdown",
    });
    // Step 2: PUT the raw content to the signed url returned by step 1.
    expect(calls[1]?.url).toBe("https://storage.example.com/signed?sig=1");
    expect(calls[1]?.method).toBe("PUT");
    expect(calls[1]?.body).toBe("# hello");
    // Step 3: complete.
    expect(calls[2]?.url).toContain("/v1/assets/asset_abc/complete");
    expect(calls[2]?.method).toBe("POST");
  });

  it("short-circuits on a content-dedup hit (already_exists) — no PUT, no complete", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/v1/assets") && method === "POST") {
          return jsonResponse({ asset_id: "asset_dup", already_exists: true, status: "ready" });
        }
        throw new Error(`unexpected ${method} ${url}`);
      },
    );

    const res = await uploadAsset("pat_test", "project_x", "PRD/main.md @ abc1234", "# hello");

    expect(res).toEqual({ assetId: "asset_dup", alreadyExists: true });
    expect(fetchMock).toHaveBeenCalledTimes(1); // create only
  });

  it("throws (not silently succeeds) when a fresh asset comes back without an upload url", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/v1/assets") && method === "POST") {
          // Not a dedup hit, but the server omitted upload_url — a malformed response.
          return jsonResponse({ asset_id: "asset_bad", already_exists: false }, true, 201);
        }
        throw new Error(`unexpected ${method} ${url}`);
      },
    );

    await expect(
      uploadAsset("pat_test", "project_x", "PRD/main.md @ abc1234", "# hello"),
    ).rejects.toThrow(/upload url/i);
  });
});

describe("listAssets / listAllAssets / deleteAsset", () => {
  it("lists one page, mapping data[] to assets and surfacing the cursor", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/v1/assets") && method === "GET") {
        return jsonResponse({
          data: [{ asset_id: "asset_1", filename: "PRD/a.md", status: "ready" }],
          has_more: true,
          last_id: "asset_1",
        });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    const page = await listAssets("pat_test", "project_x", { limit: 25 });
    expect(page.assets).toEqual([{ asset_id: "asset_1", filename: "PRD/a.md", status: "ready" }]);
    expect(page.hasMore).toBe(true);
    expect(page.lastId).toBe("asset_1");
  });

  it("paginates listAllAssets until has_more is false", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("after_id=asset_1")) {
        return jsonResponse({ data: [{ asset_id: "asset_2", filename: "PRD/b.md" }], has_more: false });
      }
      return jsonResponse({ data: [{ asset_id: "asset_1", filename: "PRD/a.md" }], has_more: true, last_id: "asset_1" });
    });

    const all = await listAllAssets("pat_test", "project_x");
    expect(all.map((a) => a.asset_id)).toEqual(["asset_1", "asset_2"]);
    expect(urls[1]).toContain("after_id=asset_1");
  });

  it("deletes an asset by id (treats 204 as success)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method });
      return { ok: true, status: 204, text: async () => "" } as unknown as Response;
    });

    await expect(deleteAsset("pat_test", "project_x", "asset_9")).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toContain("/v1/assets/asset_9");
  });
});

describe("wipeChiefLibrary", () => {
  it("lists every asset and deletes each, returning the count", async () => {
    const deleted: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/v1/assets") && method === "GET") {
        return jsonResponse({
          data: [
            { asset_id: "asset_1", filename: "PRD/a.md" },
            { asset_id: "asset_2", filename: "PRD/b.md" },
          ],
          has_more: false,
        });
      }
      if (method === "DELETE") {
        deleted.push(url.split("/v1/assets/")[1] ?? "");
        return { ok: true, status: 204, text: async () => "" } as unknown as Response;
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    const n = await wipeChiefLibrary("pat_test", "project_x");
    expect(n).toBe(2);
    expect(deleted).toEqual(["asset_1", "asset_2"]);
  });

  it("returns 0 and issues no DELETE when the library is empty", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/v1/assets") && method === "GET") {
        return jsonResponse({ data: [], has_more: false });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    const n = await wipeChiefLibrary("pat_test", "project_x");
    expect(n).toBe(0);
  });

  it("rejects when a mid-loop deleteAsset call fails", async () => {
    let deleteCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/v1/assets") && method === "GET") {
        return jsonResponse({
          data: [
            { asset_id: "asset_1", filename: "PRD/a.md" },
            { asset_id: "asset_2", filename: "PRD/b.md" },
          ],
          has_more: false,
        });
      }
      if (method === "DELETE") {
        deleteCount += 1;
        if (deleteCount === 1) {
          return { ok: true, status: 204, text: async () => "" } as unknown as Response;
        }
        return { ok: false, status: 500, text: async () => "server error" } as unknown as Response;
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    await expect(wipeChiefLibrary("pat_test", "project_x")).rejects.toThrow("server error");
    expect(deleteCount).toBe(2); // loop reached the failing asset before throwing
  });
});

describe("startChat / sendMessage — per-turn ChatOptions serialization", () => {
  it("maps ChatOptions to snake_case body fields and omits undefined ones", async () => {
    let body: Record<string, unknown> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/v1/chats") && method === "POST") {
        body = JSON.parse(String(init?.body));
        return jsonResponse({ chat_id: "chat_1", message_id: "msg_1" }, true, 201);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    const res = await startChat("pat_test", "project_x", "hi", {
      intelligence: "expert",
      publicData: true,
      skills: ["Reviewer"],
      scope: { asset_ids: ["asset_1"] },
      // provider intentionally omitted -> must NOT appear in the body
    });

    expect(res).toEqual({ chat_id: "chat_1", message_id: "msg_1" });
    expect(body).toEqual({
      prompt: "hi",
      intelligence: "expert",
      public_data: true,
      skills: ["Reviewer"],
      scope: { asset_ids: ["asset_1"] },
    });
    expect("provider" in body).toBe(false); // undefined option dropped, not sent as null
    expect("publicData" in body).toBe(false); // camelCase key never leaks through
  });

  it("sends just { prompt } when no options are passed (existing callers unaffected)", async () => {
    let body: Record<string, unknown> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/v1/chats") && method === "POST") {
        body = JSON.parse(String(init?.body));
        return jsonResponse({ chat_id: "chat_1", message_id: "msg_1" }, true, 201);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    await startChat("pat_test", "project_x", "hello");
    expect(body).toEqual({ prompt: "hello" });
  });

  it("sendMessage merges options into the follow-up turn body", async () => {
    let url = "";
    let body: Record<string, unknown> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/v1/chats/chat_1/messages") && method === "POST") {
        body = JSON.parse(String(init?.body));
        return jsonResponse({ message_id: "msg_2" });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    const res = await sendMessage("pat_test", "project_x", "chat_1", "again", {
      provider: "anthropic",
    });
    expect(res).toEqual({ message_id: "msg_2" });
    expect(url).toContain("/v1/chats/chat_1/messages");
    expect(body).toEqual({ prompt: "again", provider: "anthropic" });
  });
});

describe("createMemory / listMemories", () => {
  it("posts content/category/importance and returns the created memory", async () => {
    let body: Record<string, unknown> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/v1/memories") && method === "POST") {
        body = JSON.parse(String(init?.body));
        return jsonResponse(
          { memory_id: "mem_1", content: "likes terse answers", category: "preference" },
          true,
          201,
        );
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    const mem = await createMemory("pat_test", "project_x", {
      content: "likes terse answers",
      category: "preference",
      importance: 3,
    });
    expect(mem).toMatchObject({ memory_id: "mem_1", category: "preference" });
    expect(body).toEqual({
      content: "likes terse answers",
      category: "preference",
      importance: 3,
    });
  });

  it("lists memories tolerating the {memories} envelope", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/v1/memories") && method === "GET") {
        return jsonResponse({ memories: [{ memory_id: "mem_1", content: "x" }] });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    const mems = await listMemories("pat_test", "project_x");
    expect(mems).toEqual([{ memory_id: "mem_1", content: "x" }]);
  });
});

describe("ensureSkill — reuse-by-name / create-when-missing", () => {
  it("returns the existing skill name without creating when one matches", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/v1/skills") && method === "GET") {
        return jsonResponse({ data: [{ skill_id: "sk_1", name: "Reviewer" }] });
      }
      throw new Error(`unexpected ${method} ${url}`); // create must NOT be called
    });

    const name = await ensureSkill("pat_test", "project_x", "Reviewer", "be strict");
    expect(name).toBe("Reviewer");
    expect(fetchMock).toHaveBeenCalledTimes(1); // list only, no create
  });

  it("creates the skill and returns its name when no match exists", async () => {
    let createBody: Record<string, unknown> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/v1/skills") && method === "GET") {
        return jsonResponse({ data: [] }); // miss
      }
      if (url.endsWith("/v1/skills") && method === "POST") {
        createBody = JSON.parse(String(init?.body));
        return jsonResponse({ skill_id: "sk_new", name: createBody.name }, true, 201);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    const name = await ensureSkill("pat_test", "project_x", "Summarizer", "be brief", "skill");
    expect(name).toBe("Summarizer");
    expect(createBody).toEqual({
      name: "Summarizer",
      instructions: "be brief",
      category: "skill",
    });
  });
});

describe("attachLabel", () => {
  it("POSTs { name } to the asset's labels endpoint and treats 2xx as success", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method, body: init?.body });
      return { ok: true, status: 204, text: async () => "" } as unknown as Response;
    });

    await expect(
      attachLabel("pat_test", "project_x", "asset_9", "needs-review"),
    ).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/v1/assets/asset_9/labels");
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ name: "needs-review" });
  });
});
