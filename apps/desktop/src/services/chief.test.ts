import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";

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
  createSkill,
  ensureSkill,
  attachLabel,
  md5Hex,
  pollForResponse,
  isTerminalChiefFailureStatus,
  isChiefQuotaError,
  ChiefError,
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

describe("md5Hex — content digest for Chief's server-side dedup", () => {
  // Definitive oracle: Node's own MD5 over the same UTF-8 bytes our impl hashes.
  const ref = (s: string) => createHash("md5").update(Buffer.from(s, "utf8")).digest("hex");

  it("matches the canonical RFC 1321 test vectors", () => {
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex("a")).toBe("0cc175b9c0f1b6a831c399e269772661");
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5Hex("message digest")).toBe("f96b697d7cb7938d525a2f31aaf161d0");
    expect(md5Hex("The quick brown fox jumps over the lazy dog")).toBe(
      "9e107d9d372bb6826bd81d3542a419d6",
    );
  });

  it("hashes UTF-8 bytes (multibyte chars), agreeing with Node crypto", () => {
    for (const s of ["é", "€ é 你好 🚀", "naïve café", "\u0000￿"]) {
      expect(md5Hex(s)).toBe(ref(s));
    }
  });

  it("handles inputs across the 64-byte block boundary (padding edge cases)", () => {
    for (const n of [54, 55, 56, 57, 63, 64, 65, 119, 120, 1000]) {
      const s = "x".repeat(n);
      expect(md5Hex(s)).toBe(ref(s));
    }
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
      md5: md5Hex("# hello"), // content digest drives Chief's server-side dedup
    });
    // Step 2: PUT the raw content to the signed url returned by step 1.
    expect(calls[1]?.url).toBe("https://storage.example.com/signed?sig=1");
    expect(calls[1]?.method).toBe("PUT");
    expect(calls[1]?.body).toBe("# hello");
    // Step 3: complete.
    expect(calls[2]?.url).toContain("/v1/assets/asset_abc/complete");
    expect(calls[2]?.method).toBe("POST");
  });

  it("short-circuits on a content-dedup hit (already_exists) after verifying the asset holds bytes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/v1/assets") && method === "POST") {
          return jsonResponse({ asset_id: "asset_dup", already_exists: true, status: "ready" });
        }
        if (url.endsWith("/v1/assets/asset_dup") && method === "GET") {
          return jsonResponse({ asset_id: "asset_dup", status: "ready", size_in_bytes: 42 });
        }
        throw new Error(`unexpected ${method} ${url}`);
      },
    );

    const res = await uploadAsset("pat_test", "project_x", "PRD/main.md @ abc1234", "# hello");

    expect(res).toEqual({ assetId: "asset_dup", alreadyExists: true });
    expect(fetchMock).toHaveBeenCalledTimes(2); // create + verification GET, no PUT/complete
  });

  it("deletes a stuck dedup match (1-byte reservation) and retries with a fresh upload", async () => {
    // Chief's md5 registry matches reservations whose bytes never arrived (they sit at
    // AWAITING_UPLOAD with a 1-byte placeholder). Trusting one silently drops the content.
    const calls: Array<{ url: string; method: string }> = [];
    let creates = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push({ url, method });
        if (url.endsWith("/v1/assets") && method === "POST") {
          creates++;
          if (creates === 1) {
            return jsonResponse({ asset_id: "asset_stuck", already_exists: true, status: "ingesting" });
          }
          return jsonResponse(
            {
              asset_id: "asset_fresh",
              already_exists: false,
              upload_url: "https://storage.example.com/signed?sig=2",
              upload_method: "PUT",
              upload_headers: { "Content-Type": "text/markdown" },
            },
            true,
            201,
          );
        }
        if (url.endsWith("/v1/assets/asset_stuck") && method === "GET") {
          return jsonResponse({
            asset_id: "asset_stuck",
            status: "ingesting",
            size_in_bytes: 1,
            created_at: "2020-01-01T00:00:00Z", // old enough that no upload can still be in flight
          });
        }
        if (url.endsWith("/v1/assets/asset_stuck") && method === "DELETE") {
          return jsonResponse({}, true, 204);
        }
        if (url.startsWith("https://storage.example.com/") && method === "PUT") {
          return jsonResponse({}, true, 200);
        }
        if (url.endsWith("/v1/assets/asset_fresh/complete") && method === "POST") {
          return jsonResponse({ asset_id: "asset_fresh", status: "ingesting" });
        }
        throw new Error(`unexpected ${method} ${url}`);
      },
    );

    const res = await uploadAsset("pat_test", "project_x", "PRD/main.md @ abc1234", "# hello");

    expect(res).toEqual({ assetId: "asset_fresh", alreadyExists: false });
    const sequence = calls.map((c) => `${c.method} ${c.url.replace(/^.*\/v1/, "/v1").replace(/\?.*$/, "")}`);
    expect(sequence).toEqual([
      "POST /v1/assets",
      "GET /v1/assets/asset_stuck",
      "DELETE /v1/assets/asset_stuck",
      "POST /v1/assets",
      "PUT https://storage.example.com/signed",
      "POST /v1/assets/asset_fresh/complete",
    ]);
  });

  it("trusts the dedup hit when the verification GET itself fails", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/v1/assets") && method === "POST") {
          return jsonResponse({ asset_id: "asset_dup", already_exists: true });
        }
        if (url.endsWith("/v1/assets/asset_dup") && method === "GET") {
          return jsonResponse({ error: "boom" }, false, 500);
        }
        throw new Error(`unexpected ${method} ${url}`);
      },
    );

    const res = await uploadAsset("pat_test", "project_x", "PRD/main.md @ abc1234", "# hello");

    expect(res).toEqual({ assetId: "asset_dup", alreadyExists: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws (not an infinite loop) when every retry dedups to a stuck reservation", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/v1/assets") && method === "POST") {
          return jsonResponse({ asset_id: "asset_stuck", already_exists: true });
        }
        if (url.endsWith("/v1/assets/asset_stuck") && method === "GET") {
          return jsonResponse({
            asset_id: "asset_stuck",
            status: "ingesting",
            size_in_bytes: 1,
            created_at: "2020-01-01T00:00:00Z",
          });
        }
        if (url.endsWith("/v1/assets/asset_stuck") && method === "DELETE") {
          return jsonResponse({}, true, 204);
        }
        throw new Error(`unexpected ${method} ${url}`);
      },
    );

    await expect(
      uploadAsset("pat_test", "project_x", "PRD/main.md @ abc1234", "# hello"),
    ).rejects.toThrow(/stuck|reservation|attempts/i);
  });

  it("trusts a FRESH stuck-looking match — it may be another agent's upload still in flight", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push(method);
        if (url.endsWith("/v1/assets") && method === "POST") {
          return jsonResponse({ asset_id: "asset_inflight", already_exists: true });
        }
        if (url.endsWith("/v1/assets/asset_inflight") && method === "GET") {
          return jsonResponse({
            asset_id: "asset_inflight",
            status: "ingesting",
            size_in_bytes: 1,
            created_at: new Date().toISOString(), // seconds old — could be mid-PUT right now
          });
        }
        throw new Error(`unexpected ${method} ${url}`);
      },
    );

    const res = await uploadAsset("pat_test", "project_x", "PRD/main.md @ abc1234", "# hello");

    expect(res).toEqual({ assetId: "asset_inflight", alreadyExists: true });
    expect(calls).toEqual(["POST", "GET"]); // no DELETE
  });

  it("still retries the create when deleting the stuck reservation fails (already swept)", async () => {
    let creates = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/v1/assets") && method === "POST") {
          creates++;
          if (creates === 1) {
            return jsonResponse({ asset_id: "asset_stuck", already_exists: true });
          }
          return jsonResponse(
            {
              asset_id: "asset_fresh",
              already_exists: false,
              upload_url: "https://storage.example.com/signed?sig=3",
            },
            true,
            201,
          );
        }
        if (url.endsWith("/v1/assets/asset_stuck") && method === "GET") {
          return jsonResponse({
            asset_id: "asset_stuck",
            status: "ingesting",
            size_in_bytes: 1,
            created_at: "2020-01-01T00:00:00Z",
          });
        }
        if (url.endsWith("/v1/assets/asset_stuck") && method === "DELETE") {
          return jsonResponse({ error: "not found" }, false, 404); // concurrent sweep beat us to it
        }
        if (url.startsWith("https://storage.example.com/") && method === "PUT") {
          return jsonResponse({}, true, 200);
        }
        if (url.endsWith("/v1/assets/asset_fresh/complete") && method === "POST") {
          return jsonResponse({ asset_id: "asset_fresh", status: "ingesting" });
        }
        throw new Error(`unexpected ${method} ${url}`);
      },
    );

    const res = await uploadAsset("pat_test", "project_x", "PRD/main.md @ abc1234", "# hello");
    expect(res).toEqual({ assetId: "asset_fresh", alreadyExists: false });
  });

  it("trusts a dedup hit for ≤1-byte content without verification (indistinguishable from a placeholder)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/v1/assets") && method === "POST") {
          return jsonResponse({ asset_id: "asset_tiny", already_exists: true });
        }
        throw new Error(`unexpected ${method} ${url}`);
      },
    );

    const res = await uploadAsset("pat_test", "project_x", "PRD/empty.md", "x");

    expect(res).toEqual({ assetId: "asset_tiny", alreadyExists: true });
    expect(fetchMock).toHaveBeenCalledTimes(1); // create only — no GET, no DELETE
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

describe("createSkill — scope defaulting (the expert-voice spin-up fix)", () => {
  it("defaults scope to 'project' when the caller doesn't pass one", async () => {
    let body: Record<string, unknown> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/v1/skills") && method === "POST") {
        body = JSON.parse(String(init?.body));
        return jsonResponse({ skill_id: "sk_new", name: body.name }, true, 201);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    await createSkill("pat_test", "project_x", {
      name: "Architect",
      instructions: "think in systems",
      category: "persona",
    });
    // Without a valid scope Chief returns `scope.invalid` — the bug that broke every voice. The
    // default must land a concrete "project" in the body, never an omitted/undefined scope. The skill
    // body must carry `content` (the field the current API reads); `instructions` is ALSO sent for
    // resilience against version skew (the current API ignores the extra field).
    expect(body).toEqual({
      name: "Architect",
      content: "think in systems",
      instructions: "think in systems",
      category: "persona",
      scope: "project",
    });
  });

  it("honors an explicit scope when the caller passes one", async () => {
    let body: Record<string, unknown> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/v1/skills") && method === "POST") {
        body = JSON.parse(String(init?.body));
        return jsonResponse({ skill_id: "sk_new", name: body.name }, true, 201);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    await createSkill("pat_test", "project_x", {
      name: "Architect",
      instructions: "think in systems",
      category: "persona",
      scope: "user",
    });
    expect(body.scope).toBe("user");
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
    // No scope passed → createSkill defaults it to "project" so the POST stays valid; the body goes
    // out as `content` (the field the current API reads) plus `instructions` for version-skew safety.
    expect(createBody).toEqual({
      name: "Summarizer",
      content: "be brief",
      instructions: "be brief",
      category: "skill",
      scope: "project",
    });
  });

  it("threads an explicit scope through to createSkill", async () => {
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

    const name = await ensureSkill(
      "pat_test",
      "project_x",
      "Architect",
      "think in systems",
      "persona",
      "project",
    );
    expect(name).toBe("Architect");
    expect(createBody).toEqual({
      name: "Architect",
      content: "think in systems",
      instructions: "think in systems",
      category: "persona",
      scope: "project",
    });
  });

  it("surfaces a friendly error — never the raw JSON — on an opaque validation 400", async () => {
    // Storytell's opaque failure shape: no `error.message`, no `humane`, an empty `code`. The old
    // parseOrThrow dumped this JSON verbatim into a chat bubble (`{"code":"","statusCode":400}`).
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/v1/skills") && method === "POST") {
        return jsonResponse({ code: "", statusCode: 400 }, false, 400);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    await expect(
      createSkill("pat_test", "project_x", { name: "Architect", instructions: "x", scope: "project" }),
    ).rejects.toMatchObject({ name: "ChiefError", status: 400, message: "Chief request failed (400)" });
  });

  it("prefers Storytell's `humane` message when present", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/v1/skills") && method === "POST") {
        return jsonResponse(
          { code: "publicapi.skills.create.scope.invalid", humane: "scope must be one of: project, user.", statusCode: 400 },
          false,
          400,
        );
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    await expect(
      createSkill("pat_test", "project_x", { name: "Architect", instructions: "x" }),
    ).rejects.toMatchObject({ message: "scope must be one of: project, user." });
  });

  it("keeps a bare-string JSON error body as the message", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/v1/skills") && method === "POST") {
        return jsonResponse("quota exceeded", false, 429); // a JSON *string* body, not an object
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    await expect(
      createSkill("pat_test", "project_x", { name: "Architect", instructions: "x" }),
    ).rejects.toMatchObject({ message: "quota exceeded", status: 429 });
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

describe("isTerminalChiefFailureStatus — conservative known-failure set", () => {
  it("returns true for known terminal-failure statuses (case/space-insensitive)", () => {
    for (const s of ["failed", "ERROR", " errored ", "cancelled", "Canceled", "rejected", "denied", "aborted"]) {
      expect(isTerminalChiefFailureStatus(s), `for: ${JSON.stringify(s)}`).toBe(true);
    }
  });

  it("returns false for in-progress / unknown / empty statuses (never abort a working turn)", () => {
    for (const s of [undefined, "", "processing", "pending", "running", "queued", "complete", "ready", "weird"]) {
      expect(isTerminalChiefFailureStatus(s), `for: ${JSON.stringify(s)}`).toBe(false);
    }
  });
});

describe("isChiefQuotaError — credit/quota/limit detection", () => {
  it("flags HTTP 402 and 429 ChiefErrors", () => {
    expect(isChiefQuotaError(new ChiefError("payment required", 402))).toBe(true);
    expect(isChiefQuotaError(new ChiefError("quota exceeded", 429))).toBe(true);
  });

  it("flags credit/quota/limit language regardless of status", () => {
    for (const m of ["quota exceeded", "insufficient credits", "usage limit reached", "rate limit hit", "out of credits"]) {
      expect(isChiefQuotaError(new ChiefError(m, 400)), `for: ${m}`).toBe(true);
    }
  });

  it("does not flag an ordinary ChiefError or a non-ChiefError", () => {
    expect(isChiefQuotaError(new ChiefError("Chief took too long to respond. Please try again."))).toBe(false);
    expect(isChiefQuotaError(new Error("quota exceeded"))).toBe(false);
    expect(isChiefQuotaError("quota exceeded")).toBe(false);
  });
});

describe("pollForResponse — status-aware failure detection", () => {
  it("returns the response as soon as it appears", async () => {
    const bodies = [
      { message_id: "m1", status: "processing" },
      { message_id: "m1", status: "complete", response: "Here is the answer." },
    ];
    let i = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => jsonResponse(bodies[Math.min(i++, bodies.length - 1)]),
    );
    await expect(
      pollForResponse("pat", "project_x", "chat_1", "m1", { intervalMs: 1 }),
    ).resolves.toBe("Here is the answer.");
  });

  it("throws the real reason immediately on a terminal-failure status (no timeout wait)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => jsonResponse({ message_id: "m1", status: "failed" }),
    );
    // A tiny timeout proves we DON'T wait it out: the status short-circuits first.
    await expect(
      pollForResponse("pat", "project_x", "chat_1", "m1", { intervalMs: 1, timeoutMs: 10_000 }),
    ).rejects.toThrow(/couldn't finish this response.*status: failed/i);
  });

  it("folds a failure-detail field into the thrown error so quota detection still fires on the status path", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => jsonResponse({ message_id: "m1", status: "failed", error: "quota exceeded" }),
    );
    const err = await pollForResponse("pat", "project_x", "chat_1", "m1", { intervalMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(ChiefError);
    // Without folding the detail in, isChiefQuotaError would miss a credit/quota condition here.
    expect(isChiefQuotaError(err)).toBe(true);
  });

  it("keeps polling through in-progress statuses until the timeout, then reports the timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => jsonResponse({ message_id: "m1", status: "processing" }),
    );
    await expect(
      pollForResponse("pat", "project_x", "chat_1", "m1", { intervalMs: 1, timeoutMs: 5 }),
    ).rejects.toThrow(/took too long/i);
  });

  it("propagates an HTTP quota error from getMessage as a quota ChiefError", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => jsonResponse("quota exceeded", false, 429),
    );
    const err = await pollForResponse("pat", "project_x", "chat_1", "m1", { intervalMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(ChiefError);
    expect(isChiefQuotaError(err)).toBe(true);
  });
});
