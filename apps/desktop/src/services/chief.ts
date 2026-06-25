// Chief (Storytell) API client — used by Brainstorm agents to chat over a project's knowledge.
// Docs: https://storytell.ai. Base API: https://api.storytell.ai. Auth: `X-API-Key: pat_…`.
// Project-scoped calls also send `X-Project-Id: project_…`.
//
// Two transports, one per build mode (see `httpFetch` below):
//   • Dev (vite/tauri dev): web `fetch` hits the same-origin "/chief-api" proxy, which Vite
//     forwards to api.storytell.ai server-side — dodging both CORS and the webview CSP.
//   • Packaged app: there is no proxy, and api.storytell.ai sends no CORS headers, so a webview
//     `fetch` straight to it is blocked (surfacing as a bare "Load failed"). We instead issue the
//     request from Rust via the Tauri HTTP plugin, which bypasses CSP + CORS entirely (bead
//     ). The host is allow-listed in src-tauri/capabilities/default.json.

import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

const BASE = import.meta.env.DEV ? "/chief-api" : "https://api.storytell.ai";

// In dev we keep web `fetch` so the Vite "/chief-api" proxy (and test fetch mocks) stay in play;
// in the packaged app we go through the Tauri HTTP plugin. Same web-standard signature either way.
// Dispatch per-call (not a captured reference) so tests that spy on `globalThis.fetch` after this
// module loads still take effect.
const httpFetch: typeof fetch = (...args) =>
  (import.meta.env.DEV ? fetch : (tauriFetch as typeof fetch))(...args);

/**
 * Ask the Rust backend for a Chief PAT resolved from the environment / `.env.local` at runtime
 * (the `chief_pat` command — mirrors how the Anthropic BYOK key is read). Returns "" when none is
 * configured so the caller can fall back to the connect screen. Never throws.
 */
export async function resolveEnvChiefPat(): Promise<string> {
  try {
    return ((await invoke<string>("chief_pat")) ?? "").trim();
  } catch {
    // No env token (or not running under Tauri) — the user can still paste one.
    return "";
  }
}

export class ChiefError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ChiefError";
  }
}

function headers(pat: string, projectId?: string): Record<string, string> {
  const h: Record<string, string> = {
    "X-API-Key": pat,
    "Content-Type": "application/json",
  };
  if (projectId) h["X-Project-Id"] = projectId;
  return h;
}

async function parseOrThrow(res: Response): Promise<unknown> {
  const text = await res.text();
  let body: unknown = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // non-JSON error body — fall through with the raw text
  }
  if (!res.ok) {
    const msg =
      (body as { error?: { message?: string } } | undefined)?.error?.message ??
      (text || `Chief request failed (${res.status})`);
    throw new ChiefError(msg, res.status);
  }
  return body;
}

export interface ChiefProject {
  project_id: string;
  name: string;
  description?: string;
  default?: boolean;
}

/** Create a Chief project. No X-Project-Id needed — it lands in the caller's org/workspace. */
export async function createProject(
  pat: string,
  name: string,
  description?: string,
): Promise<ChiefProject> {
  const res = await httpFetch(`${BASE}/v1/projects`, {
    method: "POST",
    headers: headers(pat),
    body: JSON.stringify({ name: name.slice(0, 128), description }),
  });
  return (await parseOrThrow(res)) as ChiefProject;
}

/** List the caller's Chief projects (so we can reuse one named after the Sparkle project). */
export async function listProjects(pat: string): Promise<ChiefProject[]> {
  const res = await httpFetch(`${BASE}/v1/projects`, { headers: headers(pat) });
  const body = (await parseOrThrow(res)) as
    | { data?: ChiefProject[]; projects?: ChiefProject[] }
    | ChiefProject[];
  if (Array.isArray(body)) return body;
  return body.data ?? body.projects ?? [];
}

// --- Library assets (3-step upload) -----------------------------------------------------
// POST /v1/assets reserves a record + mints a signed upload URL; PUT the bytes to it; then
// POST /v1/assets/{id}/complete finalizes ingestion. A content-dedup hit comes back from
// step 1 as `already_exists: true` (no URL), in which case there's nothing more to do.

interface CreateAssetResponse {
  asset_id: string;
  already_exists: boolean;
  // Present only when already_exists is false (a fresh upload was reserved).
  upload_url?: string;
  upload_method?: string;
  upload_headers?: Record<string, string>;
  expires_at?: string;
  // Present on a dedup hit instead of the upload fields.
  status?: string;
}

export interface UploadAssetResult {
  assetId: string;
  /** True when Chief already had this exact content — we skipped the PUT + complete. */
  alreadyExists: boolean;
}

/**
 * Upload `content` into `projectId`'s library as an asset named `filename`. Runs the 3-step
 * flow (create → PUT signed url → complete), or short-circuits on a server-side content-dedup
 * hit. The signed PUT targets an absolute storage URL, so it bypasses the `/chief-api` proxy.
 */
export async function uploadAsset(
  pat: string,
  projectId: string,
  filename: string,
  content: string,
  mimeType = "text/markdown",
): Promise<UploadAssetResult> {
  const createRes = await httpFetch(`${BASE}/v1/assets`, {
    method: "POST",
    headers: headers(pat, projectId),
    body: JSON.stringify({ filename, mime_type: mimeType }),
  });
  const created = (await parseOrThrow(createRes)) as CreateAssetResponse;
  // A genuine content-dedup hit: Chief already has these bytes — nothing more to do.
  if (created.already_exists) {
    return { assetId: created.asset_id, alreadyExists: true };
  }
  // A fresh reservation MUST carry an upload URL. Its absence is a malformed response, not a
  // dedup hit — surface it (rather than silently "succeeding") so the bytes aren't dropped and
  // the caller leaves its sync marker un-advanced for retry.
  if (!created.upload_url) {
    throw new ChiefError(`Chief returned no upload url for "${filename}"`);
  }

  // The signed PUT goes to an absolute storage URL (not api.storytell.ai), so it stays on web
  // `fetch`: it's outside the Tauri HTTP scope, and signed storage endpoints generally allow the
  // PUT cross-origin. If commit-doc sync ever shows "Load failed" in the packaged app, this is the
  // line to route through the plugin (and add the storage host to capabilities) — bead .
  const put = await fetch(created.upload_url, {
    method: created.upload_method ?? "PUT",
    headers: created.upload_headers ?? { "Content-Type": mimeType },
    body: content,
  });
  if (!put.ok) {
    throw new ChiefError(`asset upload failed (${put.status})`, put.status);
  }

  const completeRes = await httpFetch(`${BASE}/v1/assets/${created.asset_id}/complete`, {
    method: "POST",
    headers: headers(pat, projectId),
    body: "{}",
  });
  await parseOrThrow(completeRes);
  return { assetId: created.asset_id, alreadyExists: false };
}

export interface StartChatResult {
  chat_id: string;
  message_id: string;
  created_at?: string;
}

/** Start a new chat scoped to `projectId`. Async: returns ids to poll. */
export async function startChat(
  pat: string,
  projectId: string,
  prompt: string,
): Promise<StartChatResult> {
  const res = await httpFetch(`${BASE}/v1/chats`, {
    method: "POST",
    headers: headers(pat, projectId),
    body: JSON.stringify({ prompt }),
  });
  return (await parseOrThrow(res)) as StartChatResult;
}

/** Append a follow-up turn to an existing chat. Async: returns the new message id to poll. */
export async function sendMessage(
  pat: string,
  projectId: string,
  chatId: string,
  prompt: string,
): Promise<{ message_id: string }> {
  const res = await httpFetch(`${BASE}/v1/chats/${chatId}/messages`, {
    method: "POST",
    headers: headers(pat, projectId),
    body: JSON.stringify({ prompt }),
  });
  return (await parseOrThrow(res)) as { message_id: string };
}

interface ChiefMessage {
  message_id: string;
  // While processing, `response` is omitted; its appearance signals completion.
  response?: string;
  prompt?: string;
  status?: string;
}

/** Fetch a single message. `response` is absent until the assistant has produced output. */
export async function getMessage(
  pat: string,
  projectId: string,
  chatId: string,
  messageId: string,
): Promise<ChiefMessage> {
  const res = await httpFetch(`${BASE}/v1/chats/${chatId}/messages/${messageId}`, {
    headers: headers(pat, projectId),
  });
  return (await parseOrThrow(res)) as ChiefMessage;
}

/**
 * Poll a message until its `response` text appears (the documented completion signal), then
 * return it. Gives up after ~`timeoutMs` and throws, so the UI can show a friendly error.
 */
export async function pollForResponse(
  pat: string,
  projectId: string,
  chatId: string,
  messageId: string,
  opts: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const intervalMs = opts.intervalMs ?? 1200;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const start = Date.now();
  for (;;) {
    if (opts.signal?.aborted) throw new ChiefError("cancelled");
    const msg = await getMessage(pat, projectId, chatId, messageId);
    if (typeof msg.response === "string" && msg.response.length > 0) {
      return msg.response;
    }
    if (Date.now() - start > timeoutMs) {
      throw new ChiefError("Chief took too long to respond. Please try again.");
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// Concurrent ensureChiefProject calls for the SAME (pat, name) share one in-flight promise.
// The list-then-create below is non-atomic, so without this two Build agents in the same project
// (both with no linked Chief project yet) could each list, find nothing, and each create — two
// duplicate projects. Keyed by pat+name; cleared when the call settles.
const inflightEnsure = new Map<string, Promise<string>>();

/**
 * Ensure a Chief project exists for this Sparkle project. Reuses a stored mapping, else reuses
 * an existing Chief project with the same name, else creates one. Returns the Chief project id.
 * Safe under concurrency: simultaneous calls for the same project collapse to a single
 * list-then-create (in this process) so agents don't race to create duplicates.
 */
export async function ensureChiefProject(
  pat: string,
  name: string,
  existingId: string | undefined,
): Promise<string> {
  if (existingId) return existingId;
  // Match and create against the SAME (truncated) name Chief will actually store, so a project
  // name >128 chars doesn't make the reuse lookup miss its own previously-created project.
  const stored = name.slice(0, 128);
  const key = `${pat} ${stored}`;
  const pending = inflightEnsure.get(key);
  if (pending) return pending;

  const run = (async () => {
    try {
      const projects = await listProjects(pat);
      const match = projects.find((p) => p.name === stored);
      if (match) return match.project_id;
    } catch {
      // listing is best-effort; fall through to create
    }
    const created = await createProject(pat, stored, `Sparkle project: ${name}`);
    return created.project_id;
  })();
  inflightEnsure.set(key, run);
  try {
    return await run;
  } finally {
    inflightEnsure.delete(key);
  }
}
