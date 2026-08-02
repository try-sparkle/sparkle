// The two demotion calls added to the cloud API (plan W3). In their own file rather than appended
// to api.test.ts so the demotion unit stays a disjoint set of files from every other worker's.

import { describe, it, expect } from "vitest";
import { makeCloudApi, CloudApiError, type CloudApiDeps } from "./api";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

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

const FULL = {
  branch: "sparkle/agent-42",
  pushed_sha: "1111111111111111111111111111111111111111",
  transcript: { session_id: "claude-sess-9", jsonl: '{"a":1}\n', truncated: true, bytes: 9 },
  transcript_error: null,
};

describe("cloud api — sessionHandoff", () => {
  it("POSTs to the session's handoff route and camel-cases the wire body", async () => {
    const { api, calls } = harness(() => ({ json: FULL }));
    const out = await api.sessionHandoff("sess-1");
    expect(calls[0]!.url).toBe("https://orch.test/sessions/sess-1/handoff");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.authorization).toBe("Bearer tok-123");
    expect(out).toEqual({
      branch: "sparkle/agent-42",
      pushedSha: "1111111111111111111111111111111111111111",
      transcript: {
        sessionId: "claude-sess-9",
        jsonl: '{"a":1}\n',
        truncated: true,
        bytes: 9,
      },
      transcriptError: null,
    });
  });

  it("URL-encodes the session id", async () => {
    const { api, calls } = harness(() => ({ json: FULL }));
    await api.sessionHandoff("a/b?c");
    expect(calls[0]!.url).toBe("https://orch.test/sessions/a%2Fb%3Fc/handoff");
  });

  it("THROWS rather than returning an empty pushed sha", async () => {
    // An empty baseline reaches the cut guard, where it can only ever compare unequal — turning
    // every demotion into a permanent "the sandbox moved" refusal that names the wrong cause.
    const { api } = harness(() => ({ json: { ...FULL, pushed_sha: "" } }));
    await expect(api.sessionHandoff("s")).rejects.toMatchObject({
      name: "CloudApiError",
      code: "bad_response",
    });
    const missing = harness(() => ({ json: { branch: "b" } }));
    await expect(missing.api.sessionHandoff("s")).rejects.toBeInstanceOf(CloudApiError);
  });

  it("THROWS when the handoff names no branch", async () => {
    const { api } = harness(() => ({ json: { pushed_sha: "abc" } }));
    await expect(api.sessionHandoff("s")).rejects.toMatchObject({ code: "bad_response" });
  });

  it("reports a transcript that did not travel as null + the server's reason", async () => {
    const { api } = harness(() => ({
      json: { branch: "b", pushed_sha: "abc", transcript: null, transcript_error: "no jsonl found" },
    }));
    const out = await api.sessionHandoff("s");
    expect(out.transcript).toBeNull();
    expect(out.transcriptError).toBe("no jsonl found");
  });

  it("never reports a null transcript as a SUCCESSFUL transfer, even when the server says nothing", async () => {
    // `transcript: null, transcriptError: null` would read to the UI as "the conversation came
    // across" while the local agent has no memory at all.
    const { api } = harness(() => ({ json: { branch: "b", pushed_sha: "abc" } }));
    const out = await api.sessionHandoff("s");
    expect(out.transcript).toBeNull();
    expect(out.transcriptError).toBeTruthy();
  });

  it("treats an unusable transcript as one that did not travel, rather than passing it on", async () => {
    // No session id ⇒ nothing to `claude --resume`; no jsonl ⇒ nothing to write. Both are "it did
    // not travel", which demotion survives — passing a half-object downstream is what does not.
    const noId = harness(() => ({
      json: { branch: "b", pushed_sha: "abc", transcript: { jsonl: "{}" } },
    }));
    expect((await noId.api.sessionHandoff("s")).transcript).toBeNull();

    const noJsonl = harness(() => ({
      json: { branch: "b", pushed_sha: "abc", transcript: { session_id: "x", jsonl: "" } },
    }));
    expect((await noJsonl.api.sessionHandoff("s")).transcript).toBeNull();
  });

  it("accepts camelCase from the wire too, and defaults truncated/bytes safely", async () => {
    const { api } = harness(() => ({
      json: {
        branch: "b",
        pushedSha: "abc",
        transcript: { sessionId: "x", jsonl: "{}\n" },
        transcriptError: null,
      },
    }));
    const out = await api.sessionHandoff("s");
    expect(out.pushedSha).toBe("abc");
    expect(out.transcript).toEqual({ sessionId: "x", jsonl: "{}\n", truncated: false, bytes: 3 });
  });

  it("surfaces 409 session_not_live and 502 push_failed with their stable codes", async () => {
    const gone = harness(() => ({ status: 409, json: { error: "session_not_live" } }));
    await expect(gone.api.sessionHandoff("s")).rejects.toMatchObject({
      status: 409,
      code: "session_not_live",
    });
    const push = harness(() => ({
      status: 502,
      json: { error: "push_failed", message: "no upstream" },
    }));
    await expect(push.api.sessionHandoff("s")).rejects.toMatchObject({
      status: 502,
      code: "push_failed",
      message: "no upstream",
    });
  });

  it("refuses to call the server at all when signed out", async () => {
    const { api, calls } = harness(() => ({ json: FULL }), { token: null });
    await expect(api.sessionHandoff("s")).rejects.toMatchObject({ code: "signed_out" });
    expect(calls).toEqual([]);
  });
});

describe("cloud api — sessionHead", () => {
  it("GETs the session's head route and returns the sha", async () => {
    const { api, calls } = harness(() => ({ json: { head_sha: "deadbeef" } }));
    expect(await api.sessionHead("sess-1")).toBe("deadbeef");
    expect(calls[0]!.url).toBe("https://orch.test/sessions/sess-1/head");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers.authorization).toBe("Bearer tok-123");
  });

  it("accepts camelCase from the wire", async () => {
    const { api } = harness(() => ({ json: { headSha: "abc" } }));
    expect(await api.sessionHead("s")).toBe("abc");
  });

  it("THROWS rather than resolving an empty head", async () => {
    // "" compares unequal to the pushed sha, so returning it would blame the user's agent for a
    // response-parsing failure — "your agent committed again" when it did nothing of the kind.
    const empty = harness(() => ({ json: { head_sha: "" } }));
    await expect(empty.api.sessionHead("s")).rejects.toMatchObject({ code: "bad_response" });
    const absent = harness(() => ({ json: {} }));
    await expect(absent.api.sessionHead("s")).rejects.toBeInstanceOf(CloudApiError);
    const wrongType = harness(() => ({ json: { head_sha: 42 } }));
    await expect(wrongType.api.sessionHead("s")).rejects.toBeInstanceOf(CloudApiError);
  });

  it("surfaces 409 session_not_live", async () => {
    const { api } = harness(() => ({ status: 409, json: { error: "session_not_live" } }));
    await expect(api.sessionHead("s")).rejects.toMatchObject({
      status: 409,
      code: "session_not_live",
    });
  });
});
