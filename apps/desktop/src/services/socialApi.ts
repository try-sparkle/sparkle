// socialApi — the desktop's typed client for the Social Coding REST surface. Design:
// docs/superpowers/specs/2026-08-05-social-coding-design.md §6.6 (the endpoint list), §5 (what a
// response may and may not contain).
//
// SHAPE, and why it is this one. Like `services/supportApi`, every call is a one-line wrapper over
// a single transport helper, so the whole module is mockable at the module boundary and the pure
// parts unit-test with no network. Unlike supportApi there is no Rust command behind it: these are
// ordinary authed REST calls to the orchestration service, so the transport is `fetch` plus the
// desktop bearer, exactly as `agentTransport.deleteCloudSession` does it.
//
// THE SERVER IS BEING BUILT IN PARALLEL. Nothing here may assume an endpoint exists yet: an
// unrouted path answers 404 and surfaces as an ordinary {@link SocialApiError} with `status: 404`,
// which is the same thing a genuinely-absent user produces and is handled identically by callers.
// So this module compiles, type-checks and unit-tests against a server that has none of these
// routes, and the day they land nothing here changes.
//
// WHAT THIS CLIENT MAY HOLD. The response types below carry exactly the four public fields §5
// permits (`socialId`, `username`, `displayName`, `online`) plus edge facts about the VIEWER'S
// relationship. There is deliberately no `clerkUserId` field anywhere in this file — it is the
// partition key of every user-scoped table and may never leave the server, and a type that cannot
// express it is a type that cannot leak it. If a server response ever carries one, the fix is on the
// server; do not add a field here to receive it.

import { invoke } from "@tauri-apps/api/core";

import type { Visibility } from "../engine/social";

const ORCHESTRATION_URL =
  (import.meta.env?.VITE_ORCHESTRATION_URL as string | undefined) ??
  "http://localhost:3001";

/** How long any one social request may take. Bounded for the same reason the cloud-session DELETE
 *  is: a captive portal or a black-holed connection would otherwise hang a UI affordance until the
 *  platform's TCP timeout. */
export const SOCIAL_REQUEST_TIMEOUT_MS = 15_000;

/**
 * A non-2xx response, carrying the HTTP status AND the server's machine-readable `error` code.
 *
 * Both, because the UI branches on both and they are not interchangeable: `PUT /account/username`
 * answers `400` for four different reasons (`invalid_format`, `reserved`, `impersonation`) and the
 * remedy text differs per code, while `409` (taken) and `429` (rename_too_soon) are distinguished by
 * status alone. Callers must never infer the code from the status or vice versa.
 */
export class SocialApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message?: string,
  ) {
    super(message ?? `social request failed: ${status}${code ? ` (${code})` : ""}`);
    this.name = "SocialApiError";
  }
}

/** A transport-level failure — offline, DNS, TLS, an abort on the timeout above. Distinct from
 *  {@link SocialApiError} because "the server said no" and "the server was never reached" lead to
 *  different UI: only the second is worth a retry affordance. */
export class SocialNetworkError extends Error {
  constructor(readonly cause?: unknown) {
    super("social request could not reach the server");
    this.name = "SocialNetworkError";
  }
}

/** Everything the transport needs, injected so the unit tests can drive it without Tauri or a
 *  network. Production uses the defaults. */
export interface SocialApiDeps {
  fetch: typeof fetch;
  /** The desktop bearer, or null when signed out. */
  getToken: () => Promise<string | null>;
  baseUrl: string;
}

const defaultDeps: SocialApiDeps = {
  fetch: (...args) => fetch(...args),
  getToken: () => invoke<string | null>("desktop_bearer_token").catch(() => null),
  baseUrl: ORCHESTRATION_URL,
};

let deps: SocialApiDeps = defaultDeps;

/** Swap the transport. Tests only — production never calls this. Returns a restore function so a
 *  test cannot leak its stub into the next file. */
export function __setSocialApiDeps(next: Partial<SocialApiDeps>): () => void {
  const previous = deps;
  deps = { ...deps, ...next };
  return () => {
    deps = previous;
  };
}

/**
 * The ONE request path. Every endpoint below is a one-liner over this, so the bearer, the timeout,
 * the error mapping and the JSON handling exist exactly once.
 *
 * `AbortController` + `setTimeout`, NOT `AbortSignal.timeout` — the macOS 11 WKWebView floor
 * (tauri.conf.json `minimumSystemVersion`) lacks it, and there it throws while BUILDING the init
 * object, so the request would never be sent at all (the same hazard `agentTransport` and
 * `services/chief` both carry a note about).
 *
 * THE TIMER COVERS THE BODY, NOT JUST THE HEADERS, and that is the whole reason `clearTimeout` sits
 * in an OUTER `finally` rather than beside the `fetch`. `fetch` resolves the moment response headers
 * arrive; the body is a second, separately-stallable phase. A server or captive portal that answers
 * `200` and then never sends the body would otherwise hang forever — precisely the failure
 * {@link SOCIAL_REQUEST_TIMEOUT_MS} exists to prevent, reintroduced one line below the comment
 * promising it could not happen.
 */
async function request<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const token = await deps.getToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOCIAL_REQUEST_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await deps.fetch(`${deps.baseUrl}${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (e) {
      throw new SocialNetworkError(e);
    }
    if (!res.ok) {
      // The error body is best-effort and this path NEVER throws a transport error, for ANY reason:
      // a missing code, an HTML body from a route that does not exist yet, or a body that stalls
      // until the abort all yield `null` and keep the status. The status is the more valuable of the
      // two — callers branch on it (409 taken, 429 rename_too_soon, the four 400 codes) — and the
      // server demonstrably answered, so reporting "could not reach the server" for a response we
      // are holding would be a lie. Hence `signal: undefined`: the abort discrimination that the
      // success path needs is exactly wrong here.
      const payload = await readJson<{ error?: string; code?: string }>(res, undefined);
      throw new SocialApiError(res.status, payload?.error ?? payload?.code ?? null);
    }
    return (await readJson<T>(res, controller.signal)) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse a body, tolerating one failure and refusing to tolerate the other.
 *
 * A body that is not JSON is EXPECTED and yields `null` — an unrouted path serves the framework's
 * HTML while the server half is still being built, and a `204` has no body at all.
 *
 * A body that never ARRIVED is a transport failure and must NOT be flattened to `null`: doing so
 * would return "the server answered with nothing" for a request that timed out mid-body, which is
 * the same lie the header-only timer told. `signal.aborted` is the discriminator — the only way to
 * tell a malformed body from an absent one, since both surface as a rejected `res.json()`.
 *
 * `signal` is OPTIONAL, and omitting it opts out of that second behaviour entirely. Exactly one
 * caller does: the `!res.ok` path, which already holds a status worth more than the distinction —
 * see the comment there.
 */
async function readJson<T>(res: Response, signal?: AbortSignal): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch (e) {
    if (signal?.aborted) throw new SocialNetworkError(e);
    return null;
  }
}

// ── Response shapes (§5: four public fields, plus viewer-derived edge facts) ─────────────────────

/** The sealed public projection. `online` is ALWAYS present — a viewer not entitled to liveness
 *  sees `false`, never an omitted key, because an absent field is itself a signal (§5). */
export interface PublicProfile {
  socialId: string;
  username: string;
  displayName: string | null;
  online: boolean;
}

/** The signed-in user's OWN identity, as `GET /account/profile` answers it. It carries a
 *  `visibility` where {@link PublicProfile} carries an `online`, and that asymmetry is the point:
 *  visibility is the viewer's durable INTENT (§6.3), theirs to read and set and nobody else's to
 *  see, while liveness is a fact about a socket this app already holds open. There is no
 *  `clerkUserId` here for the same reason there is none anywhere else in this file. */
export interface MyProfileResponse {
  socialId: string;
  username: string;
  displayName: string | null;
  visibility: Visibility;
}

/** The exact-lookup response: the projection plus the edge. */
export interface UserLookup extends PublicProfile {
  relationship: string;
}

export interface DirectoryPage {
  users: PublicProfile[];
  nextCursor: string | null;
}

export interface ConnectionRow {
  id: string;
  socialId: string;
  username: string;
  displayName: string | null;
}

export interface ConnectionsResponse {
  accepted: ConnectionRow[];
  incoming: ConnectionRow[];
  outgoing: ConnectionRow[];
}

export interface ConversationRow {
  id: string;
  /**
   * `dm` for a person, `support` for the Sparkle Support Agent thread (design §7).
   *
   * THIS IS THE RECONCILIATION DISCRIMINATOR (open question 15) and the server has always emitted
   * it; the client simply did not model it. See {@link ConversationPartition} for why modelling it
   * is not enough on its own.
   */
  kind: "dm" | "support";
  socialId: string;
  state: "requested" | "active" | "left";
  unread: number;
  lastSeq: number;
}

/**
 * The caller's conversations, SPLIT — never a flat list.
 *
 * ── WHY THIS IS A PARTITION AND NOT A `kind` FIELD PLUS A CONVENTION ────────────────────────────
 * Sparkle already ships a support surface: `support_tickets` in apps/web, the docs-aware chat at
 * `/api/support/chat`, `services/supportApi.ts`, and `SupportTicketRow` pinned in the builder
 * column. Design §7 and open question 15 are explicit that the Sparkle Support Agent and that row
 * "must be one thing, not two shipped side by side" — and the way two get shipped is not a
 * decision anybody makes, it is a `.map()` over a list that happened to contain a support
 * conversation.
 *
 * So the support thread is not FILTERED OUT of the chat list here; it is never IN a list a chat
 * row can be built from. A future author of the chat row cannot forget the filter, because there
 * is no filter to forget. That is the difference between a convention and a mechanism, and only
 * the mechanism survives a fresh context.
 *
 * `SupportTicketRow` owns the one support slot. See PRD/social-coding-support-agent-seam.md for
 * the full decision and for the migration path that lets that row later render `support` instead
 * of `listMyTickets()` — in the same slot, without ever doubling.
 */
export interface ConversationPartition {
  /** Person-to-person threads. A chat row is built from THIS and from nothing else. */
  chats: ConversationRow[];
  /**
   * The caller's Sparkle Support Agent thread, or null before their first username claim (the
   * server seeds it on that claim, not at signup). Consumed by the ONE support slot.
   */
  support: ConversationRow | null;
}

/**
 * Split a raw `GET /social/conversations` payload. Exported for tests and for a future caller that
 * already holds the rows; every network caller should use {@link getConversations}.
 *
 * MORE THAN ONE support row is not representable in the result — the server's `dm_key` unique index
 * makes it impossible, and if that ever failed, silently rendering two support rows is precisely
 * the outcome this whole seam exists to prevent. The FIRST is kept and the rest are dropped from
 * both halves: putting an extra one in `chats` would ship the second surface by the back door.
 */
export function partitionConversations(
  rows: readonly ConversationRow[],
): ConversationPartition {
  const chats: ConversationRow[] = [];
  let support: ConversationRow | null = null;
  for (const row of rows) {
    if (row.kind === "support") {
      support ??= row;
      continue;
    }
    chats.push(row);
  }
  return { chats, support };
}

/** One block of a message. v1 accepts only `text` and the server rejects every other kind — the
 *  seam is declared now so a `call`/`image` block later needs no migration (§6.1). */
export interface TextBlock {
  kind: "text";
  text: string;
}

export interface MessageRow {
  id: string;
  conversationId: string;
  seq: number;
  /** A USERNAME, never a clerk id (§6.5). */
  from: string;
  blocks: TextBlock[];
  /** The server's flattening of `blocks`, so a client can preview without understanding block
   *  kinds. Never sent BY the client — the server writes it, or the preview, the report evidence
   *  and the message stop matching. */
  body: string;
  createdAt: string;
}

// ── Account (§6.6) ──────────────────────────────────────────────────────────────────────────────

/** Claim or rename a username. 400 invalid_format|reserved|impersonation · 409 taken ·
 *  429 rename_too_soon — all as a {@link SocialApiError}. The client-side
 *  `validateUsernameFormat` check is advisory and never suppresses what this returns. */
export function putUsername(username: string): Promise<PublicProfile> {
  return request<PublicProfile>("PUT", "/account/username", { username });
}

export function putVisibility(visibility: Visibility): Promise<{ visibility: Visibility }> {
  return request("PUT", "/account/visibility", { visibility });
}

/** The signed-in user's OWN social identity — the one profile read that returns a `visibility`,
 *  because that field is the viewer's own durable intent (§6.3) and is never part of anybody else's
 *  public projection (§5).
 *
 *  **404 is a normal answer, not a failure**: it is what the caller gets before they have claimed a
 *  username, and it is also what every path here answers while `SOCIAL_ENABLED` is off (§6.7). Both
 *  mean "no social identity to show", and callers treat them identically — see `services/socialSync`,
 *  which goes quiet on either rather than retrying a route that is not there. */
export function getMyProfile(): Promise<MyProfileResponse> {
  return request<MyProfileResponse>("GET", "/account/profile");
}

// ── Directory and lookup (§6.6) ─────────────────────────────────────────────────────────────────

/** Page the public directory. Page size is capped at 50 server-side; the cursor is opaque and is
 *  keyed on `username_key`, so do not construct or parse one here. */
export function getDirectory(opts: { cursor?: string; limit?: number } = {}): Promise<DirectoryPage> {
  const q = new URLSearchParams();
  if (opts.cursor) q.set("cursor", opts.cursor);
  if (opts.limit != null) q.set("limit", String(opts.limit));
  const qs = q.toString();
  return request<DirectoryPage>("GET", `/social/directory${qs ? `?${qs}` : ""}`);
}

/**
 * Exact-username lookup. **404 is not an error condition to log loudly** — it is the deliberate
 * no-existence-oracle answer for a nonexistent user, an `unavailable` one, a held-but-unclaimed
 * history name, a service account, and anyone blocking the caller, all indistinguishable on purpose
 * (§6.6). Callers render "no such user" for all of them.
 */
export function getUser(username: string): Promise<UserLookup> {
  return request<UserLookup>("GET", `/social/users/${encodeURIComponent(username)}`);
}

// ── Connections (§6.6) ──────────────────────────────────────────────────────────────────────────

/** Send a connection request. Answers 202 ALWAYS — including when the target does not exist or has
 *  blocked you — so the response tells you nothing about them. Do not branch on it. */
export function postConnection(username: string): Promise<void> {
  return request<void>("POST", "/social/connections", { username });
}

export function getConnections(): Promise<ConnectionsResponse> {
  return request<ConnectionsResponse>("GET", "/social/connections");
}

export function acceptConnection(id: string): Promise<void> {
  return request<void>("POST", `/social/connections/${encodeURIComponent(id)}/accept`);
}

export function declineConnection(id: string): Promise<void> {
  return request<void>("POST", `/social/connections/${encodeURIComponent(id)}/decline`);
}

export function deleteConnection(id: string): Promise<void> {
  return request<void>("DELETE", `/social/connections/${encodeURIComponent(id)}`);
}

// ── Block and report (§6.6) ─────────────────────────────────────────────────────────────────────

/** Block someone. Works on a STRANGER — that is the primary case under an open directory — and the
 *  server creates the pair row on demand rather than requiring a prior relationship. */
export function postBlock(username: string): Promise<void> {
  return request<void>("POST", "/social/blocks", { username });
}

export function deleteBlock(username: string): Promise<void> {
  return request<void>("DELETE", `/social/blocks/${encodeURIComponent(username)}`);
}

export function postReport(report: {
  username: string;
  reason: string;
  note?: string;
  conversationId?: string;
  messageId?: string;
}): Promise<void> {
  return request<void>("POST", "/social/reports", report);
}

// ── Conversations and messages (§6.6) ───────────────────────────────────────────────────────────

/**
 * The caller's conversations, ALREADY SPLIT. There is deliberately no accessor that returns the
 * flat list — see {@link ConversationPartition} for why that is the point rather than an
 * inconvenience.
 */
export async function getConversations(): Promise<ConversationPartition> {
  // NOT DESTRUCTURED. `readJson` returns `null` for any body that is not JSON — a 204, an
  // empty-bodied 200, a captive portal or proxy serving HTML — and `request` casts that `null`
  // straight to `T`. Destructuring it throws a raw `TypeError`, which is neither `SocialApiError`
  // nor `SocialNetworkError`: the two types every caller of this module branches on. The old flat
  // signature returned the value through untouched and could not throw here, so the destructure
  // would have been a NEW crash path on the first thing the app asks for. (roborev 69154.)
  const payload = await request<{ conversations?: ConversationRow[] } | null>(
    "GET",
    "/social/conversations",
  );
  // A payload from a server that predates `kind` yields `undefined`, which is not `"support"`, so
  // every row lands in `chats` — the old behaviour exactly. Failing open here is correct: the
  // support row cannot appear before the server that emits `kind` is deployed.
  return partitionConversations(payload?.conversations ?? []);
}

/** Create-or-get the DM with `username`. **This is the only way to obtain a conversation id for
 *  someone you have no thread with**, and it is the choke point where the server runs `canMessage`:
 *  a stranger gets one whose recipient participant is `requested` (the tray), a connection gets one
 *  `active`, a blocked sender gets 403 with no row created. Idempotent via the `dm_key` index. */
export function createConversation(username: string): Promise<{ id: string; state: string }> {
  return request("POST", "/social/conversations", { username });
}

export function getMessages(
  conversationId: string,
  opts: { afterSeq?: number; beforeSeq?: number; limit?: number } = {},
): Promise<{ messages: MessageRow[] }> {
  const q = new URLSearchParams();
  if (opts.afterSeq != null) q.set("after_seq", String(opts.afterSeq));
  if (opts.beforeSeq != null) q.set("before_seq", String(opts.beforeSeq));
  if (opts.limit != null) q.set("limit", String(opts.limit));
  const qs = q.toString();
  return request(
    "GET",
    `/social/conversations/${encodeURIComponent(conversationId)}/messages${qs ? `?${qs}` : ""}`,
  );
}

/**
 * Send a message. Takes **`blocks`, not `body`** — the server flattens blocks into `body` and
 * stores both, and a client-supplied `body` is rejected (§6.6). `clientMsgId` is the dedupe key: it
 * is unique per conversation server-side, so a timeout-retry with the SAME id is a no-op that
 * returns the original row rather than a duplicate message.
 */
export function sendMessage(
  conversationId: string,
  msg: { clientMsgId: string; blocks: TextBlock[] },
): Promise<{ id: string; seq: number; createdAt: string }> {
  return request("POST", `/social/conversations/${encodeURIComponent(conversationId)}/messages`, {
    client_msg_id: msg.clientMsgId,
    blocks: msg.blocks,
  });
}

/** Accept a message request — the D3 tray's affirmative. */
export function acceptConversation(conversationId: string): Promise<void> {
  return request<void>("POST", `/social/conversations/${encodeURIComponent(conversationId)}/accept`);
}

export function markRead(conversationId: string, seq: number): Promise<void> {
  return request<void>("POST", `/social/conversations/${encodeURIComponent(conversationId)}/read`, {
    seq,
  });
}

/** Flatten blocks to the plain-text preview the way the server does. Pure, and here so a client
 *  showing an optimistic echo of its own just-sent message renders the SAME string the server will
 *  send back — not a second, subtly different flattening. */
export function flattenBlocks(blocks: readonly TextBlock[]): string {
  return blocks.map((b) => b.text).join("\n");
}
