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

export interface ChiefAsset {
  asset_id: string;
  filename: string;
  status?: string;
}

/** One page of the project's library. `data` is the documented array; `assets` accepted as a
 *  fallback alias. Cursor lives in `last_id` + `has_more`. */
export async function listAssets(
  pat: string,
  projectId: string,
  opts: { afterId?: string; limit?: number } = {},
): Promise<{ assets: ChiefAsset[]; hasMore: boolean; lastId?: string }> {
  const params = new URLSearchParams();
  params.set("limit", String(opts.limit ?? 100));
  if (opts.afterId) params.set("after_id", opts.afterId);
  const res = await httpFetch(`${BASE}/v1/assets?${params.toString()}`, {
    headers: headers(pat, projectId),
  });
  const body = (await parseOrThrow(res)) as {
    data?: ChiefAsset[];
    assets?: ChiefAsset[];
    has_more?: boolean;
    last_id?: string;
  };
  return { assets: body.data ?? body.assets ?? [], hasMore: Boolean(body.has_more), lastId: body.last_id };
}

/** Every asset in the project, following the cursor to the end. */
export async function listAllAssets(pat: string, projectId: string): Promise<ChiefAsset[]> {
  const all: ChiefAsset[] = [];
  let afterId: string | undefined;
  const maxPages = 10_000; // safety bound against infinite loops (non-advancing cursor)
  for (let page = 0; page < maxPages; page++) {
    const result = await listAssets(pat, projectId, { afterId, limit: 100 });
    all.push(...result.assets);
    // No more data: stop
    if (!result.hasMore) return all;
    // has_more=true but no cursor: malformed response, error rather than silently truncate
    if (!result.lastId) {
      throw new ChiefError("Chief returned has_more=true but no last_id cursor");
    }
    // Non-advancing cursor: safety net to prevent infinite loops
    if (result.lastId === afterId) {
      throw new ChiefError(`Chief cursor did not advance (stuck at ${afterId})`);
    }
    afterId = result.lastId;
  }
  throw new ChiefError(`listAllAssets exceeded ${maxPages} pages (possible infinite loop)`);
}

/** Soft-delete an asset by id. 2xx (incl. 204 No Content) is success. */
export async function deleteAsset(pat: string, projectId: string, assetId: string): Promise<void> {
  const res = await httpFetch(`${BASE}/v1/assets/${assetId}`, {
    method: "DELETE",
    headers: headers(pat, projectId),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ChiefError(text || `asset delete failed (${res.status})`, res.status);
  }
}

/** One-time cleanup: delete EVERY asset in a Chief project (used to clear the legacy per-commit
 *  flood before the current-state sync takes over). Returns the number deleted. */
export async function wipeChiefLibrary(pat: string, chiefProjectId: string): Promise<number> {
  const assets = await listAllAssets(pat, chiefProjectId);
  let deleted = 0;
  for (const a of assets) {
    await deleteAsset(pat, chiefProjectId, a.asset_id);
    deleted += 1;
  }
  return deleted;
}

export interface StartChatResult {
  chat_id: string;
  message_id: string;
  created_at?: string;
}

/** Restrict a chat turn's retrieval to specific library entities (any subset; omitted = whole
 *  project). All ids are sent through verbatim under their snake_case keys. */
export interface ChiefScope {
  asset_ids?: string[];
  label_ids?: string[];
  concept_ids?: string[];
  project_ids?: string[];
  view_ids?: string[];
  chat_ids?: string[];
}

/** Per-turn knobs for `startChat` / `sendMessage`. All optional; omitted fields are left off the
 *  request body entirely (Chief applies its own defaults) rather than sent as null. `skills` are
 *  skill NAMES (see `ensureSkill`). */
export interface ChatOptions {
  intelligence?: "auto" | "fast" | "expert" | "research";
  provider?: "automatic" | "anthropic" | "openai" | "google";
  publicData?: boolean;
  skills?: string[];
  scope?: ChiefScope;
}

/** Map our camelCase `ChatOptions` onto Chief's snake_case body fields, dropping anything
 *  undefined so we never transmit explicit nulls (which Chief would treat differently from
 *  "unset"). Returned object is spread into the request body alongside `prompt`. */
function mapChatOptions(opts?: ChatOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (!opts) return body;
  if (opts.intelligence !== undefined) body.intelligence = opts.intelligence;
  if (opts.provider !== undefined) body.provider = opts.provider;
  if (opts.publicData !== undefined) body.public_data = opts.publicData;
  if (opts.skills !== undefined) body.skills = opts.skills;
  if (opts.scope !== undefined) body.scope = opts.scope;
  return body;
}

/** Start a new chat scoped to `projectId`. Async: returns ids to poll. `opts` carries optional
 *  per-turn knobs (intelligence/provider/public data/skills/scope). */
export async function startChat(
  pat: string,
  projectId: string,
  prompt: string,
  opts?: ChatOptions,
): Promise<StartChatResult> {
  const res = await httpFetch(`${BASE}/v1/chats`, {
    method: "POST",
    headers: headers(pat, projectId),
    body: JSON.stringify({ prompt, ...mapChatOptions(opts) }),
  });
  return (await parseOrThrow(res)) as StartChatResult;
}

/** Append a follow-up turn to an existing chat. Async: returns the new message id to poll.
 *  `opts` carries the same optional per-turn knobs as `startChat`. */
export async function sendMessage(
  pat: string,
  projectId: string,
  chatId: string,
  prompt: string,
  opts?: ChatOptions,
): Promise<{ message_id: string }> {
  const res = await httpFetch(`${BASE}/v1/chats/${chatId}/messages`, {
    method: "POST",
    headers: headers(pat, projectId),
    body: JSON.stringify({ prompt, ...mapChatOptions(opts) }),
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

// --- Memories (project-scoped long-term facts) ------------------------------------------
// POST/GET /v1/memories, scoped by X-Project-Id. A memory is a durable note Chief carries into
// future chats (identity/preferences/facts/etc.), separate from library assets.

/** What a memory is "about" — drives how Chief weighs/recalls it. */
export type MemoryCategory = "identity" | "preference" | "fact" | "context" | "instruction";

export interface ChiefMemory {
  memory_id?: string;
  content: string;
  category?: MemoryCategory;
  /** Relative weight (server-defined scale); higher = recalled more eagerly. */
  importance?: number;
}

/** Create a project-scoped memory. `content` is required; category/importance are optional. */
export async function createMemory(
  pat: string,
  projectId: string,
  mem: { content: string; category?: MemoryCategory; importance?: number },
): Promise<ChiefMemory> {
  const res = await httpFetch(`${BASE}/v1/memories`, {
    method: "POST",
    headers: headers(pat, projectId),
    body: JSON.stringify({
      content: mem.content,
      category: mem.category,
      importance: mem.importance,
    }),
  });
  return (await parseOrThrow(res)) as ChiefMemory;
}

/** List the project's memories. Tolerates `{data}` / `{memories}` / a bare array, like
 *  `listProjects`. */
export async function listMemories(pat: string, projectId: string): Promise<ChiefMemory[]> {
  const res = await httpFetch(`${BASE}/v1/memories`, { headers: headers(pat, projectId) });
  const body = (await parseOrThrow(res)) as
    | { data?: ChiefMemory[]; memories?: ChiefMemory[] }
    | ChiefMemory[];
  if (Array.isArray(body)) return body;
  return body.data ?? body.memories ?? [];
}

// --- Skills (reusable instructions / personas) ------------------------------------------
// POST/GET /v1/skills. A skill bundles instructions Chief can apply to a chat turn (referenced
// by NAME in `ChatOptions.skills`). `category` distinguishes a task skill from a persona;
// `scope` whether it lives on the project or the user.

export interface ChiefSkill {
  skill_id?: string;
  name: string;
  instructions?: string;
  category?: "skill" | "persona";
  scope?: "project" | "user";
}

/** Create a skill. `name` + `instructions` are required; category/scope default server-side. */
export async function createSkill(
  pat: string,
  projectId: string,
  skill: {
    name: string;
    instructions: string;
    category?: "skill" | "persona";
    scope?: "project" | "user";
  },
): Promise<ChiefSkill> {
  const res = await httpFetch(`${BASE}/v1/skills`, {
    method: "POST",
    headers: headers(pat, projectId),
    body: JSON.stringify({
      name: skill.name,
      instructions: skill.instructions,
      category: skill.category,
      scope: skill.scope,
    }),
  });
  return (await parseOrThrow(res)) as ChiefSkill;
}

/** List the project's skills. Tolerates `{data}` / `{skills}` / a bare array, like
 *  `listProjects`. */
export async function listSkills(pat: string, projectId: string): Promise<ChiefSkill[]> {
  const res = await httpFetch(`${BASE}/v1/skills`, { headers: headers(pat, projectId) });
  const body = (await parseOrThrow(res)) as
    | { data?: ChiefSkill[]; skills?: ChiefSkill[] }
    | ChiefSkill[];
  if (Array.isArray(body)) return body;
  return body.data ?? body.skills ?? [];
}

// Concurrent ensureSkill calls for the SAME (pat, projectId, name) share one in-flight promise —
// same race as ensureChiefProject: the list-then-create is non-atomic, so two callers could each
// list, miss, and create a duplicate skill. Keyed by pat+projectId+name; cleared when settled.
const inflightEnsureSkill = new Map<string, Promise<string>>();

/**
 * Ensure a skill named `name` exists in the project, returning the NAME to feed into
 * `ChatOptions.skills` (chat references skills by name, not id). Reuses an existing skill with
 * the same name, else creates it. Mirrors `ensureChiefProject`: best-effort list-then-create
 * with in-flight dedup so simultaneous callers don't race to create duplicates.
 */
export async function ensureSkill(
  pat: string,
  projectId: string,
  name: string,
  instructions: string,
  category?: "skill" | "persona",
): Promise<string> {
  const key = `${pat} ${projectId} ${name}`;
  const pending = inflightEnsureSkill.get(key);
  if (pending) return pending;

  const run = (async () => {
    try {
      const skills = await listSkills(pat, projectId);
      const match = skills.find((s) => s.name === name);
      if (match) return match.name;
    } catch {
      // listing is best-effort; fall through to create
    }
    const created = await createSkill(pat, projectId, { name, instructions, category });
    return created.name ?? name;
  })();
  inflightEnsureSkill.set(key, run);
  try {
    return await run;
  } finally {
    inflightEnsureSkill.delete(key);
  }
}

// --- Labels (taxonomy tags on assets) ---------------------------------------------------
// POST /v1/labels mints a label; POST /v1/assets/{id}/labels attaches one by name (auto-creating
// it if absent), so attach is idempotent and the only call most callers need.

/** Attach label `name` to an asset, creating the label if it doesn't yet exist. Idempotent:
 *  re-attaching the same name is a no-op server-side. Any 2xx (incl. 204) is success. */
export async function attachLabel(
  pat: string,
  projectId: string,
  assetId: string,
  name: string,
): Promise<void> {
  const res = await httpFetch(`${BASE}/v1/assets/${assetId}/labels`, {
    method: "POST",
    headers: headers(pat, projectId),
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ChiefError(text || `label attach failed (${res.status})`, res.status);
  }
}

/** Explicitly create a label (when you need its id/styling up front, rather than the auto-create
 *  that `attachLabel` triggers). Optional `color`/`icon` style it in the Chief UI. */
export async function createLabel(
  pat: string,
  projectId: string,
  name: string,
  opts: { color?: string; icon?: string } = {},
): Promise<{ label_id?: string; name: string }> {
  const res = await httpFetch(`${BASE}/v1/labels`, {
    method: "POST",
    headers: headers(pat, projectId),
    body: JSON.stringify({ name, color: opts.color, icon: opts.icon }),
  });
  return (await parseOrThrow(res)) as { label_id?: string; name: string };
}
