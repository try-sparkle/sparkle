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
//
// Every Chief request is bounded by a per-request timeout. Without one, a single stalled poll (a
// dead socket that opens but never sends bytes) wedges `pollForResponse` forever: its inter-request
// wall-clock check only runs BETWEEN requests, so a hung `getMessage` fetch never lets the loop
// reach it — the exact defect that left "Make a Plan" stuck on "Making a plan…" with no way out.
// We inject an AbortController-driven timeout (NOT `AbortSignal.timeout`, which the macOS 11
// WKWebView floor lacks) whenever the caller hasn't wired its own signal.
const REQUEST_TIMEOUT_MS = 45_000;
const httpFetch: typeof fetch = (input, init) => {
  const base = import.meta.env.DEV ? fetch : (tauriFetch as typeof fetch);
  if (init?.signal) return base(input, init); // caller owns cancellation — don't double up
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return base(input, { ...init, signal: controller.signal })
    .catch((e) => {
      // Our own timeout fired — surface it as a friendly ChiefError, not a raw DOMException.
      if (controller.signal.aborted) throw new ChiefError("Chief request timed out. Please try again.", 408);
      throw e;
    })
    .finally(() => clearTimeout(timer));
};

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
    // Storytell error bodies vary: sometimes `{ error: { message } }`, sometimes a top-level
    // `{ humane, code, statusCode }` envelope, and — for some validation failures — an opaque
    // `{ code: "", statusCode: 400 }` with NO human text at all. Prefer any real message; a parsed
    // JSON error envelope with no usable field must NEVER leak back as raw JSON (that's how
    // `{"code":"","statusCode":400}` ended up verbatim in a chat bubble). Only fall back to the raw
    // text when the body wasn't JSON to begin with; otherwise a bare status line is the floor.
    const b = body as
      | { error?: { message?: string }; humane?: string; message?: string; code?: string }
      | undefined;
    const fromEnvelope =
      b?.error?.message || b?.humane || b?.message || (b?.code ? `Chief error: ${b.code}` : "");
    // A bare-string JSON body (`"quota exceeded"`) IS a real message — keep it. Only a parsed JSON
    // *object* with no usable field falls through to the status line; raw non-JSON text is preserved.
    const fallback =
      typeof body === "string" && body.trim()
        ? body
        : body === undefined && text
        ? text
        : `Chief request failed (${res.status})`;
    throw new ChiefError(fromEnvelope || fallback, res.status);
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

/**
 * Hex-encoded MD5 of `s`'s UTF-8 bytes (RFC 1321). Sent as the `md5` field on the create-asset
 * call so Chief can dedup by content at reservation time: when the project already holds bytes
 * with this digest, it returns the existing asset (`already_exists: true`) instead of minting a
 * fresh upload — the server-side gate that stops identical markdown from being re-ingested even
 * when our local ledger (chiefSync) has been reset. Hand-rolled because Web Crypto has no MD5.
 */
export function md5Hex(s: string): string {
  const msg = new TextEncoder().encode(s); // hash the UTF-8 bytes, matching what we PUT as the body
  const len = msg.length;

  // Pad to a multiple of 64 bytes: a single 0x80, zeros, then the 64-bit little-endian bit length.
  const total = (((len + 8) >>> 6) + 1) << 6;
  const bytes = new Uint8Array(total);
  bytes.set(msg);
  bytes[len] = 0x80;
  const bitLen = len * 8;
  const lo = bitLen >>> 0;
  const hi = Math.floor(bitLen / 0x100000000) >>> 0; // high word matters only for >512MB inputs
  const lenOff = total - 8;
  for (let i = 0; i < 4; i++) bytes[lenOff + i] = (lo >>> (i * 8)) & 0xff;
  for (let i = 0; i < 4; i++) bytes[lenOff + 4 + i] = (hi >>> (i * 8)) & 0xff;

  // Per-round sine-derived constants and left-rotate amounts.
  const K = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ];
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Int32Array(16);

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      // Indices are in-bounds by construction; `!` silences noUncheckedIndexedAccess in this hot loop.
      M[i] = bytes[j]! | (bytes[j + 1]! << 8) | (bytes[j + 2]! << 16) | (bytes[j + 3]! << 24);
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
      else { F = C ^ (B | ~D); g = (7 * i) & 15; }
      F = (F + A + K[i]! + M[g]!) | 0;
      A = D; D = C; C = B;
      const sh = S[(i >>> 4) * 4 + (i & 3)]!;
      B = (B + ((F << sh) | (F >>> (32 - sh)))) | 0;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  const hexLE = (n: number) => {
    let h = "";
    for (let i = 0; i < 4; i++) h += (((n >>> (i * 8)) & 0xff).toString(16).padStart(2, "0"));
    return h;
  };
  return hexLE(a0) + hexLE(b0) + hexLE(c0) + hexLE(d0);
}

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
 *
 * A dedup hit is only trusted after verifying the matched asset actually holds bytes: Chief's
 * md5 registry also matches reservations whose upload never happened (stuck at AWAITING_UPLOAD
 * with a 1-byte placeholder — see `assetLooksStuck`), and trusting one of those drops this
 * content forever. A stuck match is deleted to free its md5, then the create is retried.
 */
export async function uploadAsset(
  pat: string,
  projectId: string,
  filename: string,
  content: string,
  mimeType = "text/markdown",
): Promise<UploadAssetResult> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const createRes = await httpFetch(`${BASE}/v1/assets`, {
      method: "POST",
      headers: headers(pat, projectId),
      // `md5` lets Chief return the existing asset for content it already holds, instead of minting a
      // fresh upload URL — a server-side gate against re-ingesting identical markdown (bead sparkle).
      body: JSON.stringify({ filename, mime_type: mimeType, md5: md5Hex(content) }),
    });
    const created = (await parseOrThrow(createRes)) as CreateAssetResponse;
    if (created.already_exists) {
      // Content of ≤1 byte legitimately matches a 1-byte asset — verification can't tell it
      // from a stuck reservation and would delete/re-create it on every sync. Trust the dedup.
      if (new TextEncoder().encode(content).length <= 1) {
        return { assetId: created.asset_id, alreadyExists: true };
      }
      let existing: ChiefAsset | null = null;
      try {
        existing = await getAsset(pat, projectId, created.asset_id);
      } catch {
        // Can't verify — trust the dedup (the historical behavior) rather than fail the sync.
      }
      // Only a stuck reservation old enough that no other agent can still be mid-upload gets
      // reclaimed; a fresh one (or one with no created_at to judge by) is trusted — if it IS
      // stuck, the hourly re-sync reclaims it once it ages past the threshold.
      const reclaimable =
        existing &&
        assetLooksStuck(existing) &&
        existing.created_at &&
        Date.parse(existing.created_at) < Date.now() - STUCK_RESERVATION_MIN_AGE_MS;
      if (!reclaimable) {
        // A genuine content-dedup hit: Chief already has these bytes — nothing more to do.
        return { assetId: created.asset_id, alreadyExists: true };
      }
      // The match is an empty reservation. Delete it so the md5 registry lets go of it, then
      // re-create to mint a real upload URL. Best-effort: a concurrent sweep may have deleted
      // it already — the retried create sorts it out either way.
      try {
        await deleteAsset(pat, projectId, created.asset_id);
      } catch {
        // fall through to the retry
      }
      continue;
    }
    // A fresh reservation MUST carry an upload URL. Its absence is a malformed response, not a
    // dedup hit — surface it (rather than silently "succeeding") so the bytes aren't dropped and
    // the caller leaves its sync marker un-advanced for retry.
    if (!created.upload_url) {
      throw new ChiefError(`Chief returned no upload url for "${filename}"`);
    }

    // The signed PUT goes to an absolute storage URL (Google Cloud Storage, not api.storytell.ai).
    // It must ride `httpFetch`: in the packaged app the webview CSP's connect-src doesn't include
    // the storage host, so a web `fetch` dies with a bare "TypeError: Load failed" — the failure
    // that stranded every PRD at AWAITING_UPLOAD (bead ). The Rust transport bypasses
    // CSP + CORS; the storage host is allow-listed in src-tauri/capabilities/default.json.
    const put = await httpFetch(created.upload_url, {
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
  throw new ChiefError(
    `asset "${filename}" kept deduping to a stuck (never-uploaded) reservation after ${maxAttempts} attempts`,
  );
}

export interface ChiefAsset {
  asset_id: string;
  filename: string;
  status?: string;
  size_in_bytes?: number;
  created_at?: string;
}

/**
 * True when an asset is a reservation whose bytes never arrived: the create step ran but the
 * signed-URL PUT didn't, leaving it at AWAITING_UPLOAD forever (this API reports that as
 * status "ingesting" with a 1-byte placeholder size, indistinguishable from real ingestion by
 * status alone). Only a positively observed placeholder counts — a missing size means
 * "unknown", never "stuck", so we never delete an asset we can't see clearly.
 */
export function assetLooksStuck(a: ChiefAsset): boolean {
  return typeof a.size_in_bytes === "number" && a.size_in_bytes <= 1 && a.status !== "ready";
}

/** A stuck reservation younger than this may be another agent's upload still in flight — leave
 *  it alone (deleting it would fail their `complete`). Older ones are junk from failed runs. */
export const STUCK_RESERVATION_MIN_AGE_MS = 60 * 60 * 1000;

/** One asset's metadata (status + size). Used to tell a real dedup hit from a stuck reservation. */
export async function getAsset(pat: string, projectId: string, assetId: string): Promise<ChiefAsset> {
  const res = await httpFetch(`${BASE}/v1/assets/${assetId}`, { headers: headers(pat, projectId) });
  return (await parseOrThrow(res)) as ChiefAsset;
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
  // Best-effort failure detail a terminal-status message MIGHT carry (Chief's schema is
  // undocumented here, so these are optional and read defensively). Surfacing whichever is present
  // lets quota/credit language reach `isChiefQuotaError` on the status path, not just the HTTP path.
  error?: string;
  humane?: string;
  reason?: string;
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

// Message `status` values that mean the turn FAILED and will never produce a `response`. Chief's
// status vocabulary isn't documented, so this is a deliberately CONSERVATIVE known-failure set:
// anything not listed here (incl. any in-progress or unknown status) is treated as "still working"
// and keeps polling. Detecting these lets us surface a real failure IMMEDIATELY instead of masking
// it as the generic 90s "took too long" timeout — the defect where an out-of-credits / server-side
// error degraded into a misleading timeout because the poll only ever looked at `response`.
const CHIEF_TERMINAL_FAILURE_STATUSES = new Set([
  "failed",
  "error",
  "errored",
  "cancelled",
  "canceled",
  "rejected",
  "denied",
  "aborted",
]);

/** True when a message `status` is a KNOWN terminal-failure state (case/space-insensitive). Unknown
 *  or in-progress statuses return false so the poll never aborts a turn that's still working. */
export function isTerminalChiefFailureStatus(status: string | undefined): boolean {
  return !!status && CHIEF_TERMINAL_FAILURE_STATUSES.has(status.trim().toLowerCase());
}

/**
 * Whether a thrown Chief error looks like a credit/quota/usage-limit condition — an HTTP 402
 * (payment required) or 429 (rate limited), or a body whose text says as much (e.g. Storytell's
 * bare `"quota exceeded"`). Lets the UI say "out of credits / usage limit" plainly instead of
 * leaking a raw status line. Only a `ChiefError` can carry the status code we key on.
 */
export function isChiefQuotaError(e: unknown): boolean {
  if (!(e instanceof ChiefError)) return false;
  if (e.status === 402 || e.status === 429) return true;
  return /quota|out of credit|insufficient|usage limit|rate limit|too many requests|billing|payment required/i.test(
    e.message,
  );
}

/**
 * Poll a message until its `response` text appears (the documented completion signal), then
 * return it. Three exits: the response (success), a KNOWN terminal-failure `status` (throw the
 * real reason immediately — see {@link isTerminalChiefFailureStatus}), or the `timeoutMs` wall.
 * An HTTP error from `getMessage` (e.g. a 402/429 quota) already propagates out as a `ChiefError`.
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
    // A self-diagnosed terminal failure: stop waiting and surface the real reason now, rather than
    // spinning out the full timeout and reporting a misleading "took too long". Fold in any failure
    // detail the message carries so quota/credit language still reaches `isChiefQuotaError` — the
    // status path shouldn't be blind to "out of credits" the way it would be with a bare status.
    if (isTerminalChiefFailureStatus(msg.status)) {
      const detail = (msg.error ?? msg.humane ?? msg.reason ?? "").trim();
      throw new ChiefError(
        detail
          ? `Chief couldn't finish this response (status: ${msg.status}): ${detail}`
          : `Chief couldn't finish this response (status: ${msg.status}).`,
      );
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
  const key = `${pat}\u0000${stored}`;
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

/** Create a skill. `name` + `instructions` are required; category passes through.
 *
 *  Two server-side validation traps this call has to satisfy, both of which historically surfaced
 *  as bare 400s that silently broke every persona/voice spin-up:
 *   1. `scope` MUST be one of Chief's accepted values — sending it unset (or null) trips
 *      `publicapi.skills.create`'s `scope.invalid: scope must be one of: project, user`. We default
 *      to `"project"` when the caller doesn't specify one (the right home for a per-project persona)
 *      so the POST always carries a valid scope.
 *   2. The skill body field is `content`, NOT `instructions`. Storytell once accepted `instructions`;
 *      it now ignores it, so a body with `instructions` and no `content` fails an opaque
 *      `{"code":"","statusCode":400}` (empty code, no `humane`). We map our `instructions` param onto
 *      `content` on the wire. (Verified against api.storytell.ai: `content` → 201, `instructions` → 400.)
 */
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
      // The wire field is `content` (see the note above) — our `instructions` param maps onto it. We
      // ALSO keep sending `instructions` (the old field name) so an older/alternate Storytell build
      // that still keys off it won't hard-break; the current API just ignores the extra field.
      content: skill.instructions,
      instructions: skill.instructions,
      category: skill.category,
      scope: skill.scope ?? "project",
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
 * with in-flight dedup so simultaneous callers don't race to create duplicates. `scope` is
 * threaded into the create so callers can pin a persona to the project (vs. the user); when
 * omitted, `createSkill` defaults it to `"project"`.
 */
export async function ensureSkill(
  pat: string,
  projectId: string,
  name: string,
  instructions: string,
  category?: "skill" | "persona",
  scope?: "project" | "user",
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
    const created = await createSkill(pat, projectId, { name, instructions, category, scope });
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
