import { describe, it, expect, vi, afterEach } from "vitest";
import { ensureChiefProject } from "./chief";

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

  it("short-circuits to an already-known project id without any fetch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const id = await ensureChiefProject("pat_test", "Anything", "project_known");
    expect(id).toBe("project_known");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
