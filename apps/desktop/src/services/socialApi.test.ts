import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  __setSocialApiDeps,
  SocialApiError,
  SocialNetworkError,
  SOCIAL_REQUEST_TIMEOUT_MS,
  putUsername,
  putVisibility,
  getDirectory,
  getUser,
  postConnection,
  acceptConnection,
  createConversation,
  sendMessage,
  getMessages,
  markRead,
  flattenBlocks,
} from "./socialApi";

/** A minimal Response stand-in. jsdom has fetch types but no server; every assertion below is about
 *  the REQUEST we emit and the ERROR we raise, never about a real socket. */
function jsonRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** A non-JSON body — what an unrouted path answers while the server half is still being built. */
function htmlRes(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
let restore: () => void;

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonRes(200, {}));
  restore = __setSocialApiDeps({
    fetch: fetchMock as unknown as typeof fetch,
    getToken: async () => "tok-123",
    baseUrl: "https://api.test",
  });
});

afterEach(() => restore());

/** The (url, init) pair of the Nth call. */
const call = (n = 0) => ({
  url: fetchMock.mock.calls[n]![0] as string,
  init: fetchMock.mock.calls[n]![1] as RequestInit,
});

describe("socialApi — transport", () => {
  it("attaches the desktop bearer", async () => {
    await putVisibility("public");
    expect(call().init.headers).toMatchObject({ Authorization: "Bearer tok-123" });
  });

  it("omits Authorization entirely when signed out, rather than sending 'Bearer null'", async () => {
    restore();
    restore = __setSocialApiDeps({
      fetch: fetchMock as unknown as typeof fetch,
      getToken: async () => null,
      baseUrl: "https://api.test",
    });
    await putVisibility("public");
    expect(call().init.headers).not.toHaveProperty("Authorization");
  });

  it("sends no content-type and no body on a GET", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { users: [], nextCursor: null }));
    await getDirectory();
    expect(call().init.body).toBeUndefined();
    expect(call().init.headers).not.toHaveProperty("content-type");
  });

  it("carries an abort signal, so a black-holed connection cannot hang the UI forever", async () => {
    await putVisibility("public");
    expect(call().init.signal).toBeInstanceOf(AbortSignal);
  });

  it("raises SocialApiError carrying BOTH the status and the server's error code", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(409, { error: "taken" }));
    const err = await putUsername("drodio").catch((e) => e);
    expect(err).toBeInstanceOf(SocialApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe("taken");
  });

  it("distinguishes the four 400 reasons by CODE, since the status alone cannot", async () => {
    for (const code of ["invalid_format", "reserved", "impersonation"]) {
      fetchMock.mockResolvedValueOnce(jsonRes(400, { error: code }));
      const err = await putUsername("x").catch((e) => e);
      expect(err.status).toBe(400);
      expect(err.code).toBe(code);
    }
  });

  it("survives an endpoint that does not exist yet: a non-JSON 404 keeps the status, code null", async () => {
    // The server half is being built in parallel; an unrouted path is served by the framework and
    // is not JSON. Losing the status because the body was HTML would be strictly worse.
    fetchMock.mockResolvedValueOnce(htmlRes(404));
    const err = await getUser("nobody").catch((e) => e);
    expect(err).toBeInstanceOf(SocialApiError);
    expect(err.status).toBe(404);
    expect(err.code).toBeNull();
  });

  it("raises SocialNetworkError — not SocialApiError — when the server was never reached", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const err = await getUser("ada").catch((e) => e);
    expect(err).toBeInstanceOf(SocialNetworkError);
    expect(err).not.toBeInstanceOf(SocialApiError);
  });

  it("the timeout covers the BODY, not just the headers", async () => {
    // `fetch` resolves when response HEADERS arrive; the body is a second, separately-stallable
    // phase. A server that answers 200 and then never sends a body must still time out — clearing
    // the timer beside the fetch would leave this hanging forever, which is exactly the failure
    // SOCIAL_REQUEST_TIMEOUT_MS claims to prevent.
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      fetchMock.mockImplementationOnce(((_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return Promise.resolve({
          ok: true,
          status: 200,
          // A body that never arrives — until the abort lands on it.
          json: () =>
            new Promise((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(new Error("aborted")));
            }),
        } as unknown as Response);
      }) as unknown as typeof fetch);

      const settled = getUser("ada").then(
        () => "resolved",
        (e) => e,
      );
      // Let the fetch promise resolve (headers in) before the clock moves.
      await vi.advanceTimersByTimeAsync(0);
      expect(signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(SOCIAL_REQUEST_TIMEOUT_MS + 1);
      expect(signal?.aborted).toBe(true);

      // And the stalled body surfaces as a TRANSPORT failure, not as a null body the caller would
      // read as "the server answered with nothing".
      const err = await settled;
      expect(err).toBeInstanceOf(SocialNetworkError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an ERROR response whose body stalls keeps its STATUS — it does not become a transport error", async () => {
    // A 409 the server demonstrably sent must not be reported as "could not reach the server"
    // merely because its body never finished: callers branch on 409 taken / 429 rename_too_soon /
    // the four 400 codes, and a generic network error strands all of them.
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      fetchMock.mockImplementationOnce(((_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return Promise.resolve({
          ok: false,
          status: 409,
          json: () =>
            new Promise((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(new Error("aborted")));
            }),
        } as unknown as Response);
      }) as unknown as typeof fetch);

      const settled = putUsername("drodio").then(
        () => "resolved",
        (e) => e,
      );
      await vi.advanceTimersByTimeAsync(SOCIAL_REQUEST_TIMEOUT_MS + 1);
      const err = await settled;
      expect(err).toBeInstanceOf(SocialApiError);
      expect(err).not.toBeInstanceOf(SocialNetworkError);
      expect(err.status).toBe(409);
      expect(err.code).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a malformed body is still tolerated as null when nothing was aborted", async () => {
    // The counterpart to the case above: the abort check must not turn every unparseable body into
    // a network error, or the unrouted-404 path below stops working.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 204,
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    } as unknown as Response);
    await expect(postConnection("ada")).resolves.toBeNull();
  });
});

describe("socialApi — endpoints", () => {
  it("PUT /account/username sends the raw username", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { socialId: "s1", username: "DRodio", displayName: null, online: true }));
    const got = await putUsername("DRodio");
    expect(call().url).toBe("https://api.test/account/username");
    expect(call().init.method).toBe("PUT");
    expect(JSON.parse(call().init.body as string)).toEqual({ username: "DRodio" });
    expect(got.username).toBe("DRodio");
  });

  it("GET /social/directory omits the query string when unparameterized", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { users: [], nextCursor: null }));
    await getDirectory();
    expect(call().url).toBe("https://api.test/social/directory");
  });

  it("GET /social/directory passes cursor and limit through", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { users: [], nextCursor: null }));
    await getDirectory({ cursor: "a b", limit: 50 });
    expect(call().url).toBe("https://api.test/social/directory?cursor=a+b&limit=50");
  });

  it("percent-encodes a username into the path", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, {}));
    await getUser("a/b");
    expect(call().url).toBe("https://api.test/social/users/a%2Fb");
  });

  it("percent-encodes an id into a connection sub-path", async () => {
    await acceptConnection("c/1");
    expect(call().url).toBe("https://api.test/social/connections/c%2F1/accept");
  });

  it("POST /social/connections addresses by username, never by an internal id", async () => {
    await postConnection("ada");
    expect(JSON.parse(call().init.body as string)).toEqual({ username: "ada" });
  });

  it("POST /social/conversations is create-or-get, keyed on the username", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { id: "conv1", state: "requested" }));
    const got = await createConversation("ada");
    expect(call().url).toBe("https://api.test/social/conversations");
    expect(got).toEqual({ id: "conv1", state: "requested" });
  });

  it("sendMessage posts BLOCKS and the dedupe key — and never a client-supplied body", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(201, { id: "m1", seq: 7, createdAt: "t" }));
    await sendMessage("conv1", { clientMsgId: "cid-1", blocks: [{ kind: "text", text: "hi" }] });
    const sent = JSON.parse(call().init.body as string);
    expect(sent).toEqual({ client_msg_id: "cid-1", blocks: [{ kind: "text", text: "hi" }] });
    // The server flattens blocks -> body; a client-supplied body is rejected (§6.6), so we must
    // not send one even accidentally.
    expect(sent).not.toHaveProperty("body");
  });

  it("getMessages maps its options onto the snake_case query the server takes", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { messages: [] }));
    await getMessages("conv1", { afterSeq: 4, limit: 20 });
    expect(call().url).toBe("https://api.test/social/conversations/conv1/messages?after_seq=4&limit=20");
  });

  it("getMessages sends after_seq=0 rather than dropping it — 0 is a real cursor", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { messages: [] }));
    await getMessages("conv1", { afterSeq: 0 });
    expect(call().url).toContain("after_seq=0");
  });

  it("markRead posts the seq", async () => {
    await markRead("conv1", 12);
    expect(JSON.parse(call().init.body as string)).toEqual({ seq: 12 });
  });
});

describe("socialApi — flattenBlocks", () => {
  it("joins block text with newlines, matching the server's canonical flattening", () => {
    expect(flattenBlocks([{ kind: "text", text: "a" }, { kind: "text", text: "b" }])).toBe("a\nb");
    expect(flattenBlocks([])).toBe("");
  });
});
