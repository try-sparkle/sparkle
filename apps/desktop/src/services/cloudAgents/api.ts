// Desktop REST client for the cloud-agents orchestration API (Service B, W5). Unlike sparkleApi.ts
// (which routes every call through a Rust Tauri command because the bearer never enters JS), the
// relay already needs the bearer in JS (relayClient.ts reads `desktop_bearer_token` to register the
// Socket.IO host), so these REST calls follow the SAME pattern: read the token, `fetch` directly.
// The webview CSP allowlists http://localhost:3001 for connect-src, so the browser
// fetch is permitted without a Rust round-trip — keeping this worker's surface entirely in desktop TS
// (no Rust changes for the wire).
//
// Everything IO is behind an injected {@link CloudApiDeps} so tests drive it with a fake fetch and a
// fake token — no network, and the secret-never-echoed guarantee is asserted on the request bodies.
//
// Wire contracts (pinned in the plan; snake_case on the wire, camelCase in JS):
//   POST   /sessions/start  { project_id, goal, repo_url, base_branch?, name?, promotion? }
//                                                                                → { session_id }
//   GET    /sessions?project_id=…                                               → { sessions: [...] }
//   POST   /sessions/:id/handoff                                                 → HandoffResult
//   GET    /sessions/:id/head                                                    → { head_sha }
//   GET    /claude-auth                                                          → { method } | null
//   PUT    /claude-auth     { method, secret }                                   → 200
//   DELETE /claude-auth                                                          → 200

import { invoke } from "@tauri-apps/api/core";
import type { CloudSessionSummary } from "./reconcile";

/** Claude-auth method saved server-side. The SECRET is never returned — only which method is set. */
export type ClaudeAuthMethod = "byok" | "subscription";
export interface ClaudeAuthInfo {
  method: ClaudeAuthMethod;
}

/**
 * Present ONLY when this start is a PROMOTION of an already-running local agent
 * (services/agentPromotion) — absent for a normal born-in-the-cloud start.
 *
 * Its presence changes the runner's behaviour, so it is never a harmless extra: the sandbox clones
 * and STAYS ON `branch` instead of cutting `sparkle/cloud-<id8>`, the server adopts `sessionId` as
 * the session row's id (so the desktop tab keeps its identity — spec Decision 3), and Claude comes
 * up IDLE with no initial prompt, which is what closes the two-Claudes-on-one-branch window.
 */
export interface StartPromotion {
  /** The promoted agent's EXISTING desktop tab id. The server adopts it (409 `session_id_taken`
   *  if it's already in use) and echoes it back. */
  sessionId: string;
  /** The already-pushed branch the sandbox checks out and stays on. */
  branch: string;
  /** The transferred Claude Code session. ABSENT ⇒ no conversation travels and the cloud agent
   *  starts from a handoff briefing instead (spec Decision 2). */
  transcript?: { sessionId: string; jsonl: string };
}

/**
 * What `POST /sessions/:id/handoff` reports (plan W1.4). The DEMOTION mirror of {@link StartPromotion}:
 * the sandbox commits whatever is dirty, pushes the session's own branch, and reads back a bounded
 * tail of its Claude transcript.
 *
 * `pushedSha` is load-bearing beyond "what landed on origin": it is the BASELINE the desktop's cut
 * guard compares the sandbox's HEAD against immediately before `DELETE /sessions/:id`
 * (services/agentDemotion/demote.ts). A HEAD read taken any earlier would bake a commit made inside
 * the copy window into the baseline and wave through exactly the loss the guard exists to catch —
 * which is why the sha travels with the handoff rather than being re-derived by the caller.
 */
export interface SessionHandoff {
  /** The branch the runner pushed — read from the SESSION ROW, never from the sandbox's HEAD. */
  branch: string;
  /** The sha now on `origin/<branch>`. Never empty (a handoff that cannot name it is a failure). */
  pushedSha: string;
  /** The sandbox's Claude conversation, whole JSONL records only. `null` when it did not travel —
   *  which is NOT a failure (spec Decision 4): demotion proceeds and the local agent is briefed. */
  transcript: { sessionId: string; jsonl: string; truncated: boolean; bytes: number } | null;
  /** Why the transcript did not travel; `null` when it did. Reported, not hidden. */
  transcriptError: string | null;
}

export interface StartSessionInput {
  projectId: string;
  goal: string;
  repoUrl: string;
  baseBranch?: string;
  name?: string;
  /** See {@link StartPromotion}. Omitted for every non-promotion start. */
  promotion?: StartPromotion;
}

/** A start failure carries the parsed server signal so the UI's classifyStartError can act on it. */
export class CloudApiError extends Error {
  constructor(
    public status: number,
    public code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "CloudApiError";
  }
}

export interface CloudApiDeps {
  baseUrl: string;
  /** Resolve the desktop bearer token (null when signed out). */
  getToken: () => Promise<string | null>;
  fetch: typeof fetch;
}

// Same base URL + override as relayClient's RELAY_URL (single source: the orchestration origin). The
// CSP only allowlists the prod origin, so a VITE override is dev-only.
export const ORCHESTRATION_URL =
  (import.meta.env?.VITE_ORCHESTRATION_URL as string | undefined) ??
  "http://localhost:3001";

const defaultDeps: CloudApiDeps = {
  baseUrl: ORCHESTRATION_URL,
  getToken: () => invoke<string | null>("desktop_bearer_token").catch(() => null),
  fetch: (...args) => fetch(...args),
};

async function authHeaders(deps: CloudApiDeps): Promise<Record<string, string>> {
  const token = await deps.getToken();
  if (!token) throw new CloudApiError(401, "signed_out", "Not signed in");
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

/** Read a Response; on non-2xx throw a CloudApiError carrying the server's stable code + message. */
async function ensureOk(res: Response): Promise<Response> {
  if (res.ok) return res;
  let code: string | null = null;
  let message = `Request failed (${res.status})`;
  try {
    const body = (await res.clone().json()) as { code?: unknown; error?: unknown; message?: unknown };
    if (typeof body.code === "string") code = body.code;
    else if (typeof body.error === "string") code = body.error;
    if (typeof body.message === "string") message = body.message;
    else if (typeof body.error === "string") message = body.error;
  } catch {
    // Non-JSON error body — keep the status-based message.
  }
  throw new CloudApiError(res.status, code, message);
}

export function makeCloudApi(deps: CloudApiDeps = defaultDeps) {
  const url = (path: string) => `${deps.baseUrl}${path}`;

  return {
    /** Start a cloud agent. Resolves the server-issued session id (which becomes the AgentTab id).
     *  Throws {@link CloudApiError} on any failure (feature disabled, no auth, out of credits, …). */
    async startSession(input: StartSessionInput): Promise<{ sessionId: string }> {
      const res = await ensureOk(
        await deps.fetch(url("/sessions/start"), {
          method: "POST",
          headers: await authHeaders(deps),
          body: JSON.stringify({
            project_id: input.projectId,
            goal: input.goal,
            repo_url: input.repoUrl,
            ...(input.baseBranch ? { base_branch: input.baseBranch } : {}),
            ...(input.name ? { name: input.name } : {}),
            // snake_cased on the wire like every field above it, INCLUDING the nested transcript —
            // the server reads `promotion.session_id` / `transcript.session_id`, and a camelCase
            // key there would be dropped by the route's schema, silently downgrading a promotion
            // into an ordinary start that cuts its own branch and loses the conversation.
            ...(input.promotion
              ? {
                  promotion: {
                    session_id: input.promotion.sessionId,
                    branch: input.promotion.branch,
                    ...(input.promotion.transcript
                      ? {
                          transcript: {
                            session_id: input.promotion.transcript.sessionId,
                            jsonl: input.promotion.transcript.jsonl,
                          },
                        }
                      : {}),
                  },
                }
              : {}),
          }),
        }),
      );
      const body = (await res.json()) as { session_id?: unknown };
      if (typeof body.session_id !== "string" || body.session_id.length === 0) {
        throw new CloudApiError(502, "bad_response", "Server did not return a session id");
      }
      return { sessionId: body.session_id };
    },

    /** The caller's ORCHESTRATION-side projects. A cloud session is keyed to a server project row
     *  (`/sessions/start` 404s on an id the caller doesn't own), and the desktop's own project ids
     *  are locally minted — so the cloud flow resolves the server row through here. */
    async listProjects(): Promise<Array<{ id: string; name: string; chiefProjectId: string | null }>> {
      const res = await ensureOk(
        await deps.fetch(url("/projects"), { method: "GET", headers: await authHeaders(deps) }),
      );
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) return [];
      return body
        .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
        // Same boundary rule as listSessions: a genuine non-empty STRING id only — never a coerced
        // one, which would become a bogus project_id on every later start call.
        .filter((p): p is Record<string, unknown> & { id: string } => typeof p.id === "string" && p.id.length > 0)
        .map((p) => ({
          id: p.id,
          name: typeof p.name === "string" ? p.name : "",
          chiefProjectId:
            typeof p.chiefProjectId === "string" && p.chiefProjectId.length > 0
              ? p.chiefProjectId
              : null,
        }));
    },

    /** Create an orchestration-side project row and return its id. */
    async createProject(name: string, chiefProjectId?: string): Promise<{ id: string }> {
      const res = await ensureOk(
        await deps.fetch(url("/projects"), {
          method: "POST",
          headers: await authHeaders(deps),
          // chiefProjectId = the LOCAL project id: the stable binding key projectLink matches on,
          // so two local projects that happen to share a display name never share a server row.
          body: JSON.stringify(chiefProjectId ? { name, chiefProjectId } : { name }),
        }),
      );
      const body = (await res.json()) as { id?: unknown };
      if (typeof body.id !== "string" || body.id.length === 0) {
        throw new CloudApiError(502, "bad_response", "Server did not return a project id");
      }
      return { id: body.id };
    },

    /** List the caller's cloud sessions for a project (startup re-attach source). */
    async listSessions(projectId: string): Promise<CloudSessionSummary[]> {
      const res = await ensureOk(
        await deps.fetch(url(`/sessions?project_id=${encodeURIComponent(projectId)}`), {
          method: "GET",
          headers: await authHeaders(deps),
        }),
      );
      const body = (await res.json()) as { sessions?: unknown };
      if (!Array.isArray(body.sessions)) return [];
      return body.sessions
        .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
        // Require a real, non-empty STRING id at the boundary. `String(s.id)` would coerce a
        // non-string id ({} → "[object Object]", 42 → "42") into a bogus-but-non-empty tab id that
        // reconcile/addAgent would happily key on; only a genuine string id may pass. reconcile
        // guards emptiness too — belt & braces.
        .filter((s): s is Record<string, unknown> & { id: string } => typeof s.id === "string" && s.id.length > 0)
        .map((s) => ({
          id: s.id,
          status: typeof s.status === "string" ? s.status : "",
          name: typeof s.name === "string" ? s.name : null,
          goal: typeof s.goal === "string" ? s.goal : null,
        }));
    },

    /**
     * Prepare a running cloud session for DEMOTION: commit + push the session's branch, then read
     * back a bounded tail of its Claude transcript (plan W1.4/W1.6).
     *
     * READ-BUT-MUTATING: it writes to the user's repository. It is therefore never speculative —
     * only the demotion machine calls it, after the user has confirmed a dialog that says so.
     *
     * Throws {@link CloudApiError} on 409 `session_not_live` (a redeploy moved the session, or it
     * already ended) and 502 `push_failed`. A transcript problem is NOT a throw: it comes back as
     * `transcript: null` + `transcriptError`, because losing the conversation must not cost the
     * user their work (spec Decision 4).
     */
    async sessionHandoff(sessionId: string): Promise<SessionHandoff> {
      const res = await ensureOk(
        await deps.fetch(url(`/sessions/${encodeURIComponent(sessionId)}/handoff`), {
          method: "POST",
          headers: await authHeaders(deps),
        }),
      );
      const body = (await res.json()) as Record<string, unknown>;
      const branch = body?.branch;
      const pushedSha = body?.pushed_sha ?? body?.pushedSha;
      // Both are REQUIRED. An empty/absent `pushed_sha` would flow straight into the cut guard as
      // the baseline, where it can only ever compare unequal — turning a working demotion into a
      // permanent "the sandbox moved" refusal that no retry clears. Fail here, where the message
      // names the real problem, rather than there, where it names a fiction.
      if (typeof branch !== "string" || branch.length === 0) {
        throw new CloudApiError(502, "bad_response", "Handoff did not name the session's branch");
      }
      if (typeof pushedSha !== "string" || pushedSha.length === 0) {
        throw new CloudApiError(502, "bad_response", "Handoff did not report a pushed commit");
      }
      const t = body?.transcript;
      const rawTranscript = t && typeof t === "object" ? (t as Record<string, unknown>) : null;
      const tSessionId = rawTranscript?.session_id ?? rawTranscript?.sessionId;
      const tJsonl = rawTranscript?.jsonl;
      // A transcript we cannot key by session id cannot be resumed, and one with no records is
      // nothing to write — both are "it did not travel", which is a supported outcome, not an error.
      const transcript =
        typeof tSessionId === "string" &&
        tSessionId.length > 0 &&
        typeof tJsonl === "string" &&
        tJsonl.length > 0
          ? {
              sessionId: tSessionId,
              jsonl: tJsonl,
              truncated: rawTranscript?.truncated === true,
              bytes: typeof rawTranscript?.bytes === "number" ? rawTranscript.bytes : tJsonl.length,
            }
          : null;
      const err = body?.transcript_error ?? body?.transcriptError;
      return {
        branch,
        pushedSha,
        transcript,
        transcriptError:
          typeof err === "string" && err.length > 0
            ? err
            : // The server said nothing, yet nothing usable arrived. Say so rather than reporting
              // `transcriptError: null`, which the UI reads as "the conversation came across".
              transcript === null
              ? "the server returned no usable transcript"
              : null,
      };
    },

    /** The sandbox's CURRENT `git rev-parse HEAD` (plan W1.5). The cut guard's live reading —
     *  compared against the handoff's `pushedSha`, never against an earlier head. */
    async sessionHead(sessionId: string): Promise<string> {
      const res = await ensureOk(
        await deps.fetch(url(`/sessions/${encodeURIComponent(sessionId)}/head`), {
          method: "GET",
          headers: await authHeaders(deps),
        }),
      );
      const body = (await res.json()) as Record<string, unknown>;
      const head = body?.head_sha ?? body?.headSha;
      // An unreadable head must REJECT, never resolve to "". An empty string compares unequal to the
      // pushed sha and would read as "the sandbox moved" — a refusal that blames the user's agent
      // for a response-parsing failure.
      if (typeof head !== "string" || head.length === 0) {
        throw new CloudApiError(502, "bad_response", "Server did not report the sandbox's HEAD");
      }
      return head;
    },

    /** Current Claude-auth method for the caller, or null when none is saved. The secret is NEVER
     *  returned by the server — only the method. */
    async getClaudeAuth(): Promise<ClaudeAuthInfo | null> {
      const res = await deps.fetch(url("/claude-auth"), {
        method: "GET",
        headers: await authHeaders(deps),
      });
      if (res.status === 404) return null; // some servers 404 a missing record
      await ensureOk(res);
      const body = (await res.json().catch(() => null)) as { method?: unknown } | null;
      const method = body?.method;
      if (method === "byok" || method === "subscription") return { method };
      return null; // 200 with null / {} → not configured
    },

    /** Save a Claude credential. `secret` is sent in the request body ONLY and must never be logged
     *  or echoed anywhere (the caller's UI clears it after a successful save). */
    async putClaudeAuth(method: ClaudeAuthMethod, secret: string): Promise<void> {
      await ensureOk(
        await deps.fetch(url("/claude-auth"), {
          method: "PUT",
          headers: await authHeaders(deps),
          body: JSON.stringify({ method, secret }),
        }),
      );
    },

    /** Delete the caller's stored Claude credential. */
    async deleteClaudeAuth(): Promise<void> {
      await ensureOk(
        await deps.fetch(url("/claude-auth"), {
          method: "DELETE",
          headers: await authHeaders(deps),
        }),
      );
    },
  };
}

/** The real, Rust-token-backed client the app uses. Tests build their own via makeCloudApi(fake). */
export const cloudApi = makeCloudApi();
export type CloudApi = ReturnType<typeof makeCloudApi>;
