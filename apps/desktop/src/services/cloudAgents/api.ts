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
//   POST   /sessions/start  { project_id, goal, repo_url, base_branch?, name? } → { session_id }
//   GET    /sessions?project_id=…                                               → { sessions: [...] }
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

export interface StartSessionInput {
  projectId: string;
  goal: string;
  repoUrl: string;
  baseBranch?: string;
  name?: string;
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
