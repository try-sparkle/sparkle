// The assertions here are written against the ONE fact this design rests on: Chief reads
// `X-Project-Id` PER REQUEST, not per session. So every project assertion is taken on the
// **tools/call** POST — a test that only inspected the initialize request would pass against a
// (wrong) session-bound implementation, which is precisely the bug the design avoids
// (AGENTS.md, "Tests must assert the SIDE EFFECT").

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import { fetch as tauriHttpFetch } from "@tauri-apps/plugin-http";
import { createChiefMcpClient, parseMcpFrames, redact, ChiefMcpError } from "./chiefMcp";

// AN UNDERSCORE EARLY IN THE TAIL, ON PURPOSE — do not "tidy" this into a run of letters and
// digits. The public-mirror gate (`scripts/publish-public.sh`) denies `pat_[A-Za-z0-9]{10}`, i.e.
// ten CONSECUTIVE alphanumerics after the prefix, and a fixture that matched it froze the mirror:
// the publish hard-aborts, so this fake token would have blocked every export until someone
// noticed. `redact()` uses a deliberately wider pattern — `\bpat_[A-Za-z0-9._-]{6,}` — so a tail
// broken up by underscores is still fully PAT-shaped to the code under test. That gap is what lets
// the fixture be realistic to `redact` and invisible to the secret scanner at the same time.
const PAT = "pat_do_not_leak_this_is_a_test_fixture_1234567890";

/** One recorded request, in the shape the assertions read. */
interface Sent {
  headers: Record<string, string>;
  body: { id?: number; method?: string; params?: { name?: string; arguments?: unknown } };
}

/** Minimal Response stand-in: only `ok`/`status`/`headers.get`/`text()` are read. */
function sse(frames: unknown[], opts: { status?: number; sessionId?: string } = {}): Response {
  const status = opts.status ?? 200;
  const body = frames.map((f) => `event: message\ndata: ${JSON.stringify(f)}\n`).join("\n");
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === "mcp-session-id" ? (opts.sessionId ?? null) : null) },
    text: async () => body,
  } as unknown as Response;
}

/** A fetch double that records every request and answers from a scripted queue. */
function harness(script: Array<(sent: Sent) => Response>) {
  const sent: Sent[] = [];
  let n = 0;
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const rec: Sent = {
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")),
    };
    sent.push(rec);
    const step = script[Math.min(n++, script.length - 1)];
    if (!step) throw new Error("harness script exhausted");
    return step(rec);
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

/** The handshake pair: initialize (carries the session header) then the notification (202, empty). */
function handshake(sessionId: string) {
  return [
    (s: Sent) => sse([{ jsonrpc: "2.0", id: s.body.id, result: { protocolVersion: "2025-06-18" } }], { sessionId }),
    () => sse([], { status: 202 }),
  ];
}

/** A well-formed tools/call answer, text-is-just-a-count + the real payload in structuredContent. */
function toolOk(text: string, structured: unknown) {
  return (s: Sent) =>
    sse([
      { jsonrpc: "2.0", id: 999, result: { content: [{ type: "text", text: "unrelated frame" }] } },
      {
        jsonrpc: "2.0",
        id: s.body.id,
        result: { content: [{ type: "text", text }], structuredContent: structured },
      },
    ]);
}

const client = (script: Array<(s: Sent) => Response>) => {
  const h = harness(script);
  return {
    ...h,
    c: createChiefMcpClient({ fetchImpl: h.fetchImpl, resolvePat: async () => PAT, url: "/chief-mcp/mcp" }),
    /** The requests that are tools/call POSTs — never the handshake. */
    calls: () => h.sent.filter((s) => s.body.method === "tools/call"),
    inits: () => h.sent.filter((s) => s.body.method === "initialize"),
  };
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs(); // the transport pair at the bottom stubs `import.meta.env.DEV`
});

describe("X-Project-Id is stamped PER REQUEST on tools/call", () => {
  it("puts the requested project on the tools/call POST (not merely on initialize)", async () => {
    const h = client([...handshake("sess-1"), toolOk("3 chat(s) returned", { data: [{ chat_id: "c1" }] })]);
    await h.c.callTool("project_p1", "list_chats", { limit: 3 });

    const call = h.calls()[0]!;
    expect(call).toBeDefined();
    expect(call.headers["X-Project-Id"]).toBe("project_p1");
    expect(call.body.params?.name).toBe("list_chats");
    // …and the handshake carries NO project: the session must remember nothing.
    expect(h.inits()[0]!.headers["X-Project-Id"]).toBeUndefined();
  });

  it("sends DIFFERENT project headers on two calls over the SAME cached session", async () => {
    const h = client([
      ...handshake("sess-1"),
      toolOk("p1", { data: ["p1"] }),
      toolOk("p2", { data: ["p2"] }),
      toolOk("p1 again", { data: ["p1"] }),
    ]);
    await h.c.callTool("project_p1", "list_assets", {});
    await h.c.callTool("project_p2", "list_assets", {});
    await h.c.callTool("project_p1", "list_assets", {});

    expect(h.calls().map((s) => s.headers["X-Project-Id"])).toEqual([
      "project_p1",
      "project_p2",
      "project_p1",
    ]);
    // One handshake for three calls, and every call carried the same session id.
    expect(h.inits()).toHaveLength(1);
    expect(new Set(h.calls().map((s) => s.headers["Mcp-Session-Id"]))).toEqual(new Set(["sess-1"]));
  });

  it("omits the header entirely for a null project — list_projects takes none", async () => {
    const h = client([
      ...handshake("sess-1"),
      toolOk("348 project(s) returned", {
        data: [
          { project_id: "project_p1", name: "Founder Festival", description: "d", default: true },
          { project_id: "project_p2", name: "Scoring Rubric" },
          { bogus: true },
        ],
      }),
    ]);
    const projects = await h.c.listProjects();

    const call = h.calls()[0]!;
    expect(call.body.params?.name).toBe("list_projects");
    expect("X-Project-Id" in call.headers).toBe(false);
    // The prose said "348 project(s) returned" — the rows come from structuredContent, never it.
    expect(projects).toEqual([
      { project_id: "project_p1", name: "Founder Festival", description: "d", default: true },
      { project_id: "project_p2", name: "Scoring Rubric", description: undefined, default: undefined },
    ]);
  });
});

// AN EMPTY CATALOG IS THE MOST EXPENSIVE THING THIS MODULE CAN RETURN. The registry caches it for
// five minutes and every scope decision becomes "no Chief project matches…" — which the user reads
// as "my 348 projects are gone" — with nothing logged and no way to tell it from an empty account.
// So shape drift must FAIL, and each case below is paired with the one payload it differs from in a
// single respect, so neither assertion can be satisfied by the setup alone.
describe("shape drift fails LOUDLY rather than yielding an empty catalog", () => {
  const listProjectsReturning = (structured: unknown) =>
    client([...handshake("sess-1"), toolOk("348 project(s) returned", structured)]);

  it("RENAMED row fields throw, naming the keys that were actually there", async () => {
    const h = listProjectsReturning({ data: [{ id: "project_p1", title: "Founder Festival" }] });
    const err = await h.c.listProjects().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChiefMcpError);
    expect((err as Error).message).toContain("id, title");
    expect((err as Error).message).toContain("1 row(s)");
  });

  it("…while the SAME payload under Chief's real field names still resolves", async () => {
    const h = listProjectsReturning({ data: [{ project_id: "project_p1", name: "Founder Festival" }] });
    expect(await h.c.listProjects()).toEqual([
      { project_id: "project_p1", name: "Founder Festival", description: undefined, default: undefined },
    ]);
  });

  it("an array under an UNEXPECTED key throws, naming the keys present", async () => {
    const h = listProjectsReturning({ records: [{ project_id: "project_p1", name: "Founder Festival" }] });
    const err = await h.c.listProjects().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChiefMcpError);
    expect((err as Error).message).toContain("keys seen: records");
  });

  it("…while the same array under a key we DO know resolves", async () => {
    const h = listProjectsReturning({ results: [{ project_id: "project_p1", name: "Founder Festival" }] });
    expect((await h.c.listProjects()).map((p) => p.project_id)).toEqual(["project_p1"]);
  });

  // THE MIRROR-IMAGE BUG is a client that refuses to work at all for an account with no projects, so
  // the three shapes an empty answer can legitimately take are pinned as hard as the drift is. The
  // `null` case is the serde one AGENTS.md names: `Option::None` crosses the wire as a PRESENT key
  // holding `null`, never as an absent key.
  it("a genuinely EMPTY account is an empty catalog, not an error — `[]`, `null`, or metadata only", async () => {
    for (const payload of [
      { data: [] },
      { data: null },
      { has_more: false, total: 0 },
      // A `None` beside an auxiliary empty `Vec`. An EMPTY array proves nothing arrived anywhere, so
      // treating it as drift would refuse to serve this account — the same outage in a new hat.
      { data: null, warnings: [] },
      { result: { data: [] } },
    ]) {
      const h = listProjectsReturning(payload);
      expect(await h.c.listProjects()).toEqual([]);
    }
  });

  // …paired with the identical nesting carrying ROWS. An added wrapper level is the likeliest drift
  // there is for a list endpoint, and a top-level-only scan returns `[]` for it — the silent empty
  // catalog, for the most probable shape.
  it("rows nested under an added WRAPPER level throw, naming where they were found", async () => {
    const h = listProjectsReturning({
      result: { data: [{ project_id: "project_p1", name: "Founder Festival" }] },
    });
    const err = await h.c.listProjects().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChiefMcpError);
    expect((err as Error).message).toContain("rows appear to be at `result.data`");
  });

  it("a KNOWN key holding a non-null non-array is drift and throws", async () => {
    const h = listProjectsReturning({ data: { page: 1, rows: "?" } });
    const err = await h.c.listProjects().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChiefMcpError);
    expect((err as Error).message).toContain("keys seen: data");
  });

  it("a PARTIAL drop is warned about but not fatal — one bad row must not blind the catalog", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = listProjectsReturning({
      data: [{ project_id: "project_p1", name: "Founder Festival" }, { bogus: true }],
    });
    expect((await h.c.listProjects()).map((p) => p.project_id)).toEqual(["project_p1"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dropped 1 of 2"));
  });
});

describe("SSE parsing", () => {
  it("takes the frame matching the request id out of a multi-frame body", async () => {
    const h = client([...handshake("sess-1"), toolOk("3 chat(s) returned (has_more true)", { data: [1, 2, 3] })]);
    const res = await h.c.callTool("project_p1", "list_chats", {});

    expect(res.text).toBe("3 chat(s) returned (has_more true)");
    expect(res.data).toEqual({ data: [1, 2, 3] });
    expect(res.isError).toBeUndefined();
  });

  it("parses `data: `-prefixed lines and ignores keep-alives and non-JSON noise", () => {
    const body = [": keep-alive", "event: message", 'data: {"jsonrpc":"2.0","id":7,"result":{}}', "", "data: not-json", 'data: {"id":8}'].join("\n");
    expect(parseMcpFrames(body)).toEqual([{ jsonrpc: "2.0", id: 7, result: {} }, { id: 8 }]);
  });

  it("accepts a plain JSON body too (streamable HTTP may answer either way)", () => {
    expect(parseMcpFrames('{"jsonrpc":"2.0","id":1,"result":{}}')).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
    ]);
  });

  it("surfaces a JSON-RPC error member as isError rather than a silent empty result", async () => {
    const h = client([
      ...handshake("sess-1"),
      (s: Sent) => sse([{ jsonrpc: "2.0", id: s.body.id, error: { code: -32602, message: "unknown tool" } }]),
    ]);
    const res = await h.c.callTool("project_p1", "nope", {});
    expect(res).toEqual({ text: "unknown tool", isError: true });
  });

  it("carries result.isError through", async () => {
    const h = client([
      ...handshake("sess-1"),
      (s: Sent) =>
        sse([{ jsonrpc: "2.0", id: s.body.id, result: { content: [{ type: "text", text: "boom" }], isError: true } }]),
    ]);
    expect(await h.c.callTool("project_p1", "x", {})).toMatchObject({ text: "boom", isError: true });
  });
});

describe("session re-initialization", () => {
  it("re-initializes EXACTLY once on a 404 and retries with the NEW session id", async () => {
    const h = client([
      ...handshake("sess-old"),
      () => sse([], { status: 404 }), // the session expired under an idle concierge
      ...handshake("sess-new"),
      toolOk("ok", { data: ["fresh"] }),
    ]);
    const res = await h.c.callTool("project_p7", "list_assets", {});

    expect(res.data).toEqual({ data: ["fresh"] });
    expect(h.inits()).toHaveLength(2); // exactly ONE re-init
    const calls = h.calls();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers["Mcp-Session-Id"]).toBe("sess-old");
    expect(calls[1]!.headers["Mcp-Session-Id"]).toBe("sess-new"); // the retry uses the NEW id…
    expect(calls[1]!.headers["X-Project-Id"]).toBe("project_p7"); // …and still carries the project
  });

  // THE PAIR BELOW IS THE WHOLE POINT of the narrowed `isSessionInvalid`, and the two cases differ in
  // ONE thing: whether the error names the TRANSPORT session (`Mcp-Session-Id`) or merely contains
  // the word "session". They carry the same JSON-RPC code deliberately — a code test would collapse
  // them back together, which is why no code is treated as authoritative.

  it("re-initializes on a JSON-RPC error naming the TRANSPORT session", async () => {
    const h = client([
      ...handshake("sess-old"),
      (s: Sent) =>
        sse([
          { jsonrpc: "2.0", id: s.body.id, error: { code: -32001, message: "Mcp-Session-Id not found" } },
        ]),
      ...handshake("sess-new"),
      toolOk("ok", { data: [] }),
    ]);
    await h.c.callTool("project_p1", "list_assets", {});
    expect(h.inits()).toHaveLength(2);
    expect(h.calls()[1]!.headers["Mcp-Session-Id"]).toBe("sess-new");
  });

  it("a TOOL error about a CHIEF session is NOT session death — it is returned, and nothing is re-sent", async () => {
    const h = client([
      ...handshake("sess-1"),
      (s: Sent) => sse([{ jsonrpc: "2.0", id: s.body.id, error: { code: -32001, message: "Session not found" } }]),
    ]);
    // `get_session` takes a Chief chat session id; "Session not found" is the upstream answer about
    // THAT argument. Treating it as transport death threw away a healthy MCP session, re-sent the
    // call (not safe — this client carries uploads and chat messages), and then replaced this
    // actionable sentence with a transport message.
    const res = await h.c.callTool("project_p1", "get_session", { session_id: "chat_9" });
    expect(res).toEqual({ text: "Session not found", isError: true });
    expect(h.inits()).toHaveLength(1);
    expect(h.calls()).toHaveLength(1);
  });

  it("only the frame answering THIS request is consulted — a session error for another id is ignored", async () => {
    const h = client([
      ...handshake("sess-1"),
      (s: Sent) =>
        sse([
          // An unrelated server frame riding the same SSE body. It is not our answer, so it cannot
          // be evidence about our session.
          { jsonrpc: "2.0", id: 999, error: { code: -32001, message: "Mcp-Session-Id expired" } },
          { jsonrpc: "2.0", id: s.body.id, result: { content: [{ type: "text", text: "ok" }] } },
        ]),
    ]);
    expect(await h.c.callTool("project_p1", "list_assets", {})).toMatchObject({ text: "ok" });
    expect(h.inits()).toHaveLength(1);
    expect(h.calls()).toHaveLength(1);
  });

  // …but a frame answering NO request is where a TRANSPORT error actually lives: the server rejected
  // the envelope, so it has no request id to echo. This pair differs only in whether that id-less
  // frame names the transport session header.

  it("an id-less 400 naming the transport session header DOES re-initialize", async () => {
    const h = client([
      ...handshake("sess-old"),
      () =>
        sse(
          [
            {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32600, message: "Bad Request: Mcp-Session-Id header is invalid" },
            },
          ],
          { status: 400 },
        ),
      ...handshake("sess-new"),
      toolOk("ok", { data: [] }),
    ]);
    // Consulting only our own id drops this frame, and then NOTHING clears `sessionId` — every later
    // Chief call fails permanently until the app restarts.
    await h.c.callTool("project_p1", "list_assets", {});
    expect(h.inits()).toHaveLength(2);
    expect(h.calls()[1]!.headers["Mcp-Session-Id"]).toBe("sess-new");
  });

  it("an id-less error that only says 'session' does NOT re-initialize", async () => {
    const h = client([
      ...handshake("sess-1"),
      () => sse([{ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found" } }], { status: 400 }),
    ]);
    const err = await h.c.callTool("project_p1", "get_session", { session_id: "chat_9" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChiefMcpError);
    expect((err as Error).message).toContain("Session not found"); // the upstream text, not a transport one
    expect(h.inits()).toHaveLength(1);
    expect(h.calls()).toHaveLength(1);
  });

  it("the give-up path surfaces the UPSTREAM text, not just a transport message", async () => {
    const dead = (s: Sent) =>
      sse([
        {
          jsonrpc: "2.0",
          id: s.body.id,
          error: { code: -32001, message: "Mcp-Session-Id rejected: this token lacks the mcp scope" },
        },
      ]);
    const h = client([...handshake("s1"), dead, ...handshake("s2"), dead, ...handshake("s3"), toolOk("never", {})]);
    const err = await h.c.callTool("project_p1", "list_assets", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChiefMcpError);
    // The one sentence a human can act on must survive: "could not be re-established" names nothing.
    expect((err as Error).message).toContain("this token lacks the mcp scope");
    // …and it must be the PARSED error member, not the raw SSE body dumped in wholesale. Falling
    // back to `out.body` happens to contain the same sentence, so without this the message could
    // regress to unreadable JSON-RPC envelope noise and the assertion above would still pass.
    expect((err as Error).message).not.toContain("jsonrpc");
    expect(h.inits()).toHaveLength(2);
    expect(h.calls()).toHaveLength(2);
  });

  it("gives up after ONE retry rather than spinning", async () => {
    const h = client([
      ...handshake("s1"),
      () => sse([], { status: 404 }),
      ...handshake("s2"),
      () => sse([], { status: 404 }),
      ...handshake("s3"),
      toolOk("never reached", {}),
    ]);
    await expect(h.c.callTool("project_p1", "list_assets", {})).rejects.toBeInstanceOf(ChiefMcpError);
    expect(h.inits()).toHaveLength(2);
    expect(h.calls()).toHaveLength(2);
  });

  it("performs the handshake once for concurrent first calls", async () => {
    const h = client([...handshake("sess-1"), toolOk("a", {}), toolOk("b", {})]);
    await Promise.all([h.c.callTool("p1", "t", {}), h.c.callTool("p2", "t", {})]);
    expect(h.inits()).toHaveLength(1);
  });
});

describe("the PAT never escapes in a message", () => {
  it("scrubs a token echoed back in an upstream error body", async () => {
    const h = client([
      ...handshake("sess-1"),
      () =>
        ({
          ok: false,
          status: 400,
          headers: { get: () => null },
          text: async () => `{"error":"bad key ${PAT} for X-API-Key"}`,
        }) as unknown as Response,
    ]);
    const err = await h.c.callTool("project_p1", "list_assets", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChiefMcpError);
    const msg = (err as Error).message;
    expect(msg).not.toContain(PAT);
    expect(msg).not.toMatch(/pat_/);
    expect(msg).toContain("400"); // still legible: the status survives the scrub
  });

  it("scrubs a token echoed in a transport failure", async () => {
    const h = harness([
      ...handshake("sess-1"),
      () => {
        throw new Error(`Load failed for X-API-Key ${PAT}`);
      },
    ]);
    const c = createChiefMcpClient({ fetchImpl: h.fetchImpl, resolvePat: async () => PAT });
    const err = await c.callTool("project_p1", "list_assets", {}).catch((e: unknown) => e);
    expect((err as Error).message).not.toContain(PAT);
    expect((err as Error).message).toContain("Load failed");
  });

  it("redact() removes the held token and anything else PAT-shaped", () => {
    // `pat_other_token_value` is the SECOND token — the one we are not holding — so it exercises
    // the pattern half of redact() rather than the held-token half. Underscored for the same
    // publish-gate reason as `PAT` above.
    expect(redact(`a ${PAT} b pat_other_token_value c`, PAT)).toBe("a «redacted» b «redacted» c");
  });

  // The two halves of redact() are INDEPENDENT and this is the one that proves it: a token that is
  // not `pat_`-shaped (an env-supplied or rotated credential) is invisible to the pattern half, so
  // only the "scrub the token we are actually holding" half can catch it. Without this case the
  // held-token scrub can be deleted and every other PAT assertion here still passes.
  it("scrubs a held token that does NOT look like a Chief PAT", async () => {
    const odd = "sk-live-A1B2C3-not-pat-shaped";
    const h = harness([
      ...handshake("sess-1"),
      () =>
        ({
          ok: false,
          status: 401,
          headers: { get: () => null },
          text: async () => `{"error":"rejected key ${odd}"}`,
        }) as unknown as Response,
    ]);
    const c = createChiefMcpClient({ fetchImpl: h.fetchImpl, resolvePat: async () => odd });
    const err = await c.callTool("project_p1", "list_assets", {}).catch((e: unknown) => e);
    expect((err as Error).message).not.toContain(odd);
    expect((err as Error).message).toContain("401");
  });

  it("refuses with a legible message when no token is configured, and never calls out", async () => {
    const h = harness([...handshake("sess-1")]);
    const c = createChiefMcpClient({ fetchImpl: h.fetchImpl, resolvePat: async () => "" });
    await expect(c.callTool(null, "list_projects", {})).rejects.toThrow(/No Chief token/);
    expect(h.sent).toHaveLength(0);
  });
});

describe("request shape", () => {
  it("sends the auth key, the SSE-capable Accept, and the negotiated protocol version", async () => {
    const h = client([...handshake("sess-1"), toolOk("ok", {})]);
    await h.c.callTool("project_p1", "list_assets", {});
    const call = h.calls()[0]!;
    expect(call.headers["X-API-Key"]).toBe(PAT);
    expect(call.headers["Accept"]).toBe("application/json, text/event-stream");
    expect(call.headers["MCP-Protocol-Version"]).toBe("2025-06-18");
    expect(h.inits()[0]!.body.params).toMatchObject({ protocolVersion: "2025-06-18" });
  });

  it("sends notifications/initialized with the session header and NO id", async () => {
    const h = client([...handshake("sess-1"), toolOk("ok", {})]);
    await h.c.callTool("project_p1", "list_assets", {});
    const note = h.sent.find((s) => s.body.method === "notifications/initialized");
    expect(note).toBeDefined();
    expect(note!.body.id).toBeUndefined();
    expect(note!.headers["Mcp-Session-Id"]).toBe("sess-1");
  });

  it("fails legibly when the handshake returns no session id", async () => {
    const h = harness([() => sse([{ jsonrpc: "2.0", id: 1, result: {} }])]); // no Mcp-Session-Id header
    const c = createChiefMcpClient({ fetchImpl: h.fetchImpl, resolvePat: async () => PAT });
    await expect(c.callTool("p1", "t", {})).rejects.toThrow(/no session id/i);
  });
});

// EVERY OTHER TEST IN THIS FILE INJECTS `fetchImpl`, so without these two the production transport
// choice is covered by nothing: delete the `tauriFetch` branch and the whole file stays green while
// Chief is entirely dead in the packaged app (a bare "Load failed", per the module header). These
// two omit `fetchImpl` and drive the real default — the defaulted-seam shape of bead
// `sparkle-lgbwf`. They are a PAIR: same setup, differing only in `import.meta.env.DEV`.
describe("the production transport is chosen per call, from DEV", () => {
  it("DEV dispatches through the web `fetch` (the vite proxy path), not the Tauri plugin", async () => {
    vi.stubEnv("DEV", true);
    const h = harness([...handshake("sess-1"), toolOk("ok", { data: [1] })]);
    const webFetch = vi.spyOn(globalThis, "fetch").mockImplementation(h.fetchImpl);
    const c = createChiefMcpClient({ resolvePat: async () => PAT, url: "/chief-mcp/mcp" });

    expect(await c.callTool("project_p1", "list_assets", {})).toMatchObject({ text: "ok" });
    expect(webFetch).toHaveBeenCalled();
    expect(vi.mocked(tauriHttpFetch)).not.toHaveBeenCalled();
  });

  it("PACKAGED dispatches through the Tauri HTTP plugin — mcp.storytell.ai sends no CORS headers", async () => {
    vi.stubEnv("DEV", false);
    const h = harness([...handshake("sess-1"), toolOk("ok", { data: [1] })]);
    const webFetch = vi.spyOn(globalThis, "fetch").mockImplementation(h.fetchImpl);
    vi.mocked(tauriHttpFetch).mockImplementation(h.fetchImpl as never);
    const c = createChiefMcpClient({ resolvePat: async () => PAT, url: "https://mcp.storytell.ai/mcp" });

    expect(await c.callTool("project_p1", "list_assets", {})).toMatchObject({ text: "ok" });
    expect(vi.mocked(tauriHttpFetch)).toHaveBeenCalled();
    expect(webFetch).not.toHaveBeenCalled(); // a webview fetch here is blocked by CSP/CORS
  });
});
