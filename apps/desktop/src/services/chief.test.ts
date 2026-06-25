import { describe, it, expect, vi, afterEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { ensureChiefProject, uploadAsset, resolveEnvChiefPat } from "./chief";

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
