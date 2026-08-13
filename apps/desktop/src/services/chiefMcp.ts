// THE WIRE for Chief's MCP server — the only module in the app that speaks JSON-RPC to
// `https://mcp.storytell.ai/mcp` (bead `sparkle-8rr0c`). It implements the `ChiefClient` seam frozen in
// `chiefScope.ts` and nothing else: every access-control decision is taken BEFORE a call reaches
// here, so this file is transport, not policy.
//
// THE ONE FACT THE WHOLE DESIGN RESTS ON: `X-Project-Id` IS READ PER REQUEST, NOT PER SESSION.
// Probed live 2026-08-12 against the real server, three ways:
//   • initialize with P1, then `tools/call` with NO project header  → HTTP 400
//     `tenancy.middleware.missing_project_header` (so the session remembers nothing);
//   • initialize with P1, then call carrying P2's header            → P2's data;
//   • one session alternating P1 → P2 → P1                          → three correctly different
//     results.
// The bead's premise was the opposite (a project fixed at server-registration time, forcing N
// registrations or a wrapper per project). It is wrong, and the consequence is the good one: ONE
// session serves all 348 projects, and the session stores no project at all. So `callTool` stamps
// the header on the tools/call request itself and never on the handshake — a session-bound
// implementation would pass a test that only inspected the initialize request, which is exactly why
// `chiefMcp.test.ts` asserts on the tools/call POST specifically.
//
// TRANSPORT, mirroring `chief.ts` (read its header comment — the reasoning is identical and was
// paid for once already, in bead ``):
//   • Dev: web `fetch` against the same-origin `/chief-mcp` proxy (vite.config.ts), dodging CORS
//     and the webview CSP.
//   • Packaged: `fetch` from the Tauri HTTP plugin, because mcp.storytell.ai sends no CORS headers and
//     a webview fetch is blocked — surfacing as a bare "Load failed" with no other clue. The host is
//     allow-listed in src-tauri/capabilities/default.json.
//   • Dispatched PER CALL, never captured at module load, so a test spying on `globalThis.fetch`
//     after importing this module still takes effect.
//   • Bounded by an AbortController + setTimeout. NOT `AbortSignal.timeout` — the macOS 11 WKWebView
//     floor lacks it.
//
// RESPONSES ARE SSE. Streamable HTTP answers a POST with `text/event-stream` frames: lines beginning
// `data: ` whose payload is the JSON-RPC object, and a single response may carry several frames. We
// take the frame whose `id` matches the request we sent — never "the last one", which is how a
// notification ack or an unrelated server message gets mistaken for your answer.
//
// AND THE TEXT IS USUALLY JUST A COUNT. A real `list_chats` result reads
// `{"content":[{"type":"text","text":"3 chat(s) returned (has_more true)"}],"structuredContent":{…}}`
// — the prose is a summary, the payload is in `structuredContent`. It lands verbatim in
// `ChiefToolResult.data`; nothing anywhere may parse the prose.
//
// THE PAT NEVER LEAVES THIS MODULE IN A MESSAGE. Every error string is passed through `redact()`
// before it is thrown, because an upstream error body that echoes the token would otherwise reach a
// chat bubble, a log line, or a bead.

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { getStoredChiefPat, resolveEnvChiefPat } from "./chief";
import { useSettingsStore, effectiveChiefPat } from "../stores/settingsStore";
import type { ChiefClient, ChiefProject, ChiefToolResult } from "./chiefScope";

/** Same-origin in dev (vite proxies it), direct in the packaged app (Tauri HTTP plugin). */
const MCP_URL = import.meta.env.DEV ? "/chief-mcp/mcp" : "https://mcp.storytell.ai/mcp";

/** The protocol version the live server negotiated on 2026-08-12. */
export const CHIEF_MCP_PROTOCOL_VERSION = "2025-06-18";

const REQUEST_TIMEOUT_MS = 45_000;

export class ChiefMcpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ChiefMcpError";
  }
}

/** Everything this client touches that a test may want to replace. Injected as ONE object so the
 *  production values are supplied here, in the factory default, rather than written inline at each
 *  call site — the shape that leaves the real path untested by construction (bead `sparkle-lgbwf`). */
export interface ChiefMcpDeps {
  /** Resolve the PAT. Defaults to the app's existing keychain-first order; adds NO new storage. */
  resolvePat?: () => Promise<string>;
  /** Override the HTTP transport wholesale. Left unset, we dispatch per call (see header). */
  fetchImpl?: typeof fetch;
  url?: string;
  timeoutMs?: number;
}

/**
 * The PAT, in the app's existing order: OS keychain → legacy localStorage → runtime env. This
 * re-uses `settingsStore.effectiveChiefPat` (the same call `runtimeStore` makes) and falls back to
 * asking Rust directly when the store has not been seeded yet — a concierge can outlive, or start
 * before, the launch-time seeding in App.tsx. No new storage is introduced anywhere.
 */
export async function resolveChiefPat(): Promise<string> {
  try {
    const s = useSettingsStore.getState();
    const fromStore = effectiveChiefPat(s.keychainChiefPat, s.chiefPat, s.runtimeChiefPat);
    if (fromStore) return fromStore;
  } catch {
    // Store unavailable (non-Tauri harness) — fall through to the direct reads.
  }
  const keychain = await getStoredChiefPat();
  if (keychain) return keychain;
  return await resolveEnvChiefPat();
}

/** Redact a secret from a message. Also strips anything that LOOKS like a Chief PAT, so a token
 *  other than the one we hold (an echoed header from a proxy, say) cannot ride out either. */
export function redact(message: string, pat: string): string {
  let out = message;
  const token = pat.trim();
  if (token) out = out.split(token).join("«redacted»");
  return out.replace(/\bpat_[A-Za-z0-9._-]{6,}/g, "«redacted»");
}

interface JsonRpcFrame {
  jsonrpc?: string;
  id?: number | string | null;
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
    isError?: boolean;
  };
  error?: { code?: number; message?: string; data?: unknown };
}

/**
 * Parse a streamable-HTTP body into JSON-RPC frames.
 *
 * Two shapes reach us and both are legal: an SSE stream (`data: {…}` lines, possibly several
 * frames, possibly interleaved with `event:`/`id:`/comment lines) and a plain JSON body. A single
 * malformed frame is skipped rather than failing the whole read — the frame we want may well be the
 * next one.
 */
export function parseMcpFrames(body: string): JsonRpcFrame[] {
  const text = body.trim();
  if (!text) return [];
  const frames: JsonRpcFrame[] = [];
  if (/^data:/m.test(text)) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        frames.push(JSON.parse(payload) as JsonRpcFrame);
      } catch {
        // Not our frame — an SSE keep-alive or a split chunk. Keep reading.
      }
    }
    return frames;
  }
  try {
    const parsed = JSON.parse(text) as JsonRpcFrame | JsonRpcFrame[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/** The frame answering request `id`. Never "the last frame" — see the header. */
function frameFor(frames: JsonRpcFrame[], id: number): JsonRpcFrame | undefined {
  return frames.find((f) => f.id === id);
}

/**
 * Does this response mean "the TRANSPORT session is gone"? A 404 is the documented signal for an
 * expired / unknown `Mcp-Session-Id`. A long-lived concierge sits idle for hours, so getting this
 * wrong breaks it after the first expiry and never before — the worst possible time to find out.
 *
 * WHY IT IS DELIBERATELY NARROW, and this is the whole point of the function. "session" is also a
 * FIRST-CLASS CHIEF RESOURCE — `get_session`, `delete_session`, chat sessions. The old heuristic
 * scanned every frame for the word "session" next to "not found / expired / invalid", which cannot
 * tell `Mcp-Session-Id expired` (ours, retryable) from `Session not found` for the session ARGUMENT
 * the model just passed (theirs, emphatically not). Getting that backwards costs three things at
 * once: a healthy MCP session is thrown away, the tool call is RE-SENT — and this client carries
 * write verbs (uploads, chat messages), so a retry is not free — and the second identical upstream
 * error is then replaced by a "could not re-establish the session" message that hides the real,
 * actionable one.
 *
 * So a JSON-RPC error counts only when it names the transport session HEADER itself. NO error CODE
 * is treated as authoritative: Chief answers a missing chat session with `-32001`, the same generic
 * server-error code an MCP server would plausibly use for an expired transport session, so a code
 * test would re-open the exact hole this narrowing closes.
 *
 * WHICH FRAMES ARE EVIDENCE, and this is the half that is easy to over-narrow. Two kinds, no others:
 * the frame answering THIS request, and any frame answering NO request (`id: null` or absent). The
 * second is not a loophole — it is where transport errors actually live. A server that rejects the
 * session header rejects the ENVELOPE, so it has no request to answer and replies
 * `{"id":null,"error":{"message":"Bad Request: Mcp-Session-Id header is invalid"}}`, typically with
 * 400 rather than 404. Consulting only our own id drops that on the floor: no re-init, `sessionId`
 * never cleared, and every later Chief call fails permanently until the app restarts — the precise
 * "breaks after the first expiry and never before" outcome this function exists to avoid. Reading
 * id-less frames is safe for the same reason the narrowing is: a Chief TOOL error always echoes the
 * request id it answers, so an id-less frame can never be one. A frame answering some OTHER id is
 * still ignored — it is somebody else's answer.
 *
 * (The old `status === 400 && /mcp-session-id/` arm is subsumed: the header test above does not
 * depend on the status, so a 400 naming the header matches on its own.)
 */
function isSessionInvalid(status: number, frames: JsonRpcFrame[], id: number): boolean {
  if (status === 404) return true;
  const said = [frameFor(frames, id), ...frames.filter((f) => f.id == null)]
    .map((f) => f?.error?.message ?? "")
    .join(" ");
  return /mcp[-\s]?session[-\s]?id/i.test(said);
}

/** The upstream error text for THIS request, if the server sent one — what a give-up path must show
 *  the user instead of a transport message it can do nothing about. */
function upstreamError(frames: JsonRpcFrame[], id: number): string {
  return frameFor(frames, id)?.error?.message ?? frames.find((f) => f.error)?.error?.message ?? "";
}

/**
 * `structuredContent` is Chief's real payload; the array can arrive bare or under `data`/`items`.
 *
 * A PAYLOAD WE CANNOT FIND IS AN ERROR, NOT AN EMPTY LIST. Returning `[]` from a shape we failed to
 * recognise is the silent-drift failure AGENTS.md describes for the Rust `Option` seam: the registry
 * caches the empty catalog for five minutes and every scope decision becomes "no Chief project
 * matches…", which reads to the user as "your 348 projects are gone" — with nothing logged and no
 * way to tell it from a genuinely empty account. So a non-empty object with no array under any known
 * key throws, NAMING the keys that were actually there.
 *
 * IT THROWS ONLY ON DRIFT IT CAN DEMONSTRATE, and the boundary matters as much as the throw: the
 * mirror-image bug is a client that refuses to work at all for an account that simply has no
 * projects. `{"data": null}` is exactly what a serde `Option::None` puts on the wire (AGENTS.md's
 * note on this seam) and `{"has_more": false, "total": 0}` is an ordinary metadata-only answer —
 * both are `[]`, not errors. The evidence that rows really did arrive somewhere we did not look is a
 * NON-EMPTY array. An EMPTY one proves nothing: `{"data": null, "warnings": []}` is a `None` beside
 * an auxiliary `Vec`, and refusing to serve that account would be the same outage in a new hat.
 *
 * THE SEARCH IS RECURSIVE, because the likeliest drift for a list endpoint is an added WRAPPER
 * level: `{"result": {"data": […348 rows…]}}`. A top-level-only scan finds no array, no known key,
 * nothing of the wrong type — and returns `[]`, i.e. exactly the silent empty catalog this whole
 * function exists to prevent, for the most probable drift there is. Depth is bounded because the
 * scan is diagnostic, not a parser: we refuse to guess WHICH array is the rows, we only prove one is
 * there and name where.
 */
const ROW_ARRAY_KEYS = ["data", "items", "results", "projects"] as const;
const DRIFT_SCAN_MAX_DEPTH = 4;

/** Dotted path to the first NON-EMPTY array anywhere under `value`, or `null` if there is none. */
function findNonEmptyArray(value: unknown, path: string[] = []): string | null {
  if (path.length >= DRIFT_SCAN_MAX_DEPTH) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(v)) {
      if (v.length > 0) return [...path, key].join(".");
      continue; // an empty array is metadata, not evidence
    }
    const nested = findNonEmptyArray(v, [...path, key]);
    if (nested) return nested;
  }
  return null;
}

function asArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const rec = data as Record<string, unknown>;
    for (const key of ROW_ARRAY_KEYS) {
      if (Array.isArray(rec[key])) return rec[key] as unknown[];
    }
    const strayArrayPath = findNonEmptyArray(rec);
    const wrongTypeUnderKnownKey = ROW_ARRAY_KEYS.filter(
      (k) => k in rec && rec[k] != null && !Array.isArray(rec[k]),
    );
    if (strayArrayPath || wrongTypeUnderKnownKey.length > 0) {
      throw new ChiefMcpError(
        `Chief returned rows in an unrecognised shape (keys seen: ${Object.keys(rec).join(", ")}` +
          (strayArrayPath ? `; rows appear to be at \`${strayArrayPath}\`` : "") +
          `). Chief's response shape may have changed; treating this as an empty catalog would ` +
          `silently hide every project.`,
      );
    }
  }
  return [];
}

export function createChiefMcpClient(deps: ChiefMcpDeps = {}): ChiefClient {
  const url = deps.url ?? MCP_URL;
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const resolvePat = deps.resolvePat ?? resolveChiefPat;

  let sessionId: string | null = null;
  let handshake: Promise<string> | null = null;
  let nextId = 1;
  /** The PAT last used, kept ONLY so `redact` can scrub it out of an error message. */
  let lastPat = "";

  // Per-call dispatch (see header): a captured `fetch` would defeat a test that spies on
  // `globalThis.fetch` after this module is imported. BOTH branches are driven by tests that omit
  // `fetchImpl` (`vi.stubEnv("DEV", …)` in chiefMcp.test.ts) — without those, deleting the
  // `tauriFetch` branch leaves every test green while Chief is entirely dead in the packaged app,
  // which is the defaulted-seam shape of bead `sparkle-lgbwf`.
  const send = async (init: RequestInit & { headers: Record<string, string> }): Promise<Response> => {
    const base =
      deps.fetchImpl ??
      (import.meta.env.DEV
        ? // Called as a METHOD on `globalThis`, never detached. This module is ESM, so it is strict:
          // `const f = globalThis.fetch; f(url)` reaches the browser with `this === undefined` and
          // dies as "Illegal invocation" — a dev-only break that no injected-transport test can see.
          ((input: RequestInfo | URL, req?: RequestInit) => globalThis.fetch(input, req))
        : (tauriFetch as typeof fetch));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await base(url, { ...init, signal: controller.signal });
    } catch (e) {
      if (controller.signal.aborted) {
        throw new ChiefMcpError("Chief MCP request timed out. Please try again.", 408);
      }
      throw new ChiefMcpError(redact(e instanceof Error ? e.message : String(e), lastPat));
    } finally {
      clearTimeout(timer);
    }
  };

  const baseHeaders = (pat: string): Record<string, string> => ({
    "X-API-Key": pat,
    "Content-Type": "application/json",
    // Streamable HTTP may answer either way, and a server that sees only one of these can refuse.
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": CHIEF_MCP_PROTOCOL_VERSION,
  });

  /** initialize → read `Mcp-Session-Id` → `notifications/initialized`. Cached; concurrent callers
   *  share the one in-flight handshake rather than racing two sessions into existence. */
  const openSession = async (): Promise<string> => {
    if (sessionId) return sessionId;
    if (handshake) return handshake;
    handshake = (async () => {
      const pat = (await resolvePat()).trim();
      lastPat = pat;
      if (!pat) {
        throw new ChiefMcpError(
          "No Chief token is configured. Connect Chief in Settings before using Chief tools.",
        );
      }
      const id = nextId++;
      const res = await send({
        method: "POST",
        headers: baseHeaders(pat),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: {
            protocolVersion: CHIEF_MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "sparkle-desktop", version: "1" },
          },
        }),
      });
      const body = await res.text();
      const frames = parseMcpFrames(body);
      if (!res.ok) {
        throw new ChiefMcpError(
          redact(
            `Chief MCP handshake failed (${res.status})` +
              (frames[0]?.error?.message ? `: ${frames[0].error.message}` : body ? `: ${body}` : ""),
            pat,
          ),
          res.status,
        );
      }
      const err = frameFor(frames, id)?.error;
      if (err) throw new ChiefMcpError(redact(`Chief MCP handshake failed: ${err.message ?? ""}`, pat));
      const sid = res.headers?.get?.("Mcp-Session-Id") ?? res.headers?.get?.("mcp-session-id") ?? null;
      if (!sid) {
        throw new ChiefMcpError("Chief MCP handshake returned no session id.");
      }
      // A NOTIFICATION: no `id`, and the server answers 202 with no frame. Sending it is part of the
      // protocol, but a failure here must not sink an otherwise-good session.
      try {
        await send({
          method: "POST",
          headers: { ...baseHeaders(pat), "Mcp-Session-Id": sid },
          body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        });
      } catch {
        // best-effort
      }
      sessionId = sid;
      return sid;
    })();
    try {
      return await handshake;
    } finally {
      handshake = null;
    }
  };

  /** One tools/call attempt against the CURRENT session. Returns the raw status + frames so the
   *  caller can decide whether the session died and a single retry is warranted. */
  const attempt = async (
    sid: string,
    projectId: string | null,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ status: number; frames: JsonRpcFrame[]; body: string; id: number }> => {
    const pat = lastPat;
    const id = nextId++;
    const headers: Record<string, string> = { ...baseHeaders(pat), "Mcp-Session-Id": sid };
    // THE header, stamped per REQUEST. `null` is only for the handful of tools that take no project
    // (`list_projects` above all), and for those the header must be ABSENT — not empty.
    if (projectId) headers["X-Project-Id"] = projectId;
    const res = await send({
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: tool, arguments: args ?? {} },
      }),
    });
    const body = await res.text();
    return { status: res.status, frames: parseMcpFrames(body), body, id };
  };

  const callTool = async (
    projectId: string | null,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ChiefToolResult> => {
    let sid = await openSession();
    let out = await attempt(sid, projectId, tool, args);

    if (isSessionInvalid(out.status, out.frames, out.id)) {
      // EXACTLY ONE transparent re-init, then give up. A concierge idles for hours and the session
      // expires under it; without this the first call after an idle stretch fails permanently, and
      // with an unbounded retry a genuinely broken token spins.
      sessionId = null;
      sid = await openSession();
      out = await attempt(sid, projectId, tool, args);
      if (isSessionInvalid(out.status, out.frames, out.id)) {
        // THE UPSTREAM TEXT LEADS. Substituting our own transport wording here is how the one
        // actionable sentence the server sent gets lost — the user and the model are both left with
        // "could not be re-established", which names nothing they can do.
        const said = upstreamError(out.frames, out.id) || out.body;
        throw new ChiefMcpError(
          redact(
            `Chief \`${tool}\` failed${said ? `: ${said}` : ""} (the MCP session could not be re-established).`,
            lastPat,
          ),
          out.status,
        );
      }
    }

    if (out.status < 200 || out.status >= 300) {
      const said = out.frames.find((f) => f.error)?.error?.message ?? out.body;
      throw new ChiefMcpError(
        redact(`Chief \`${tool}\` failed (${out.status})${said ? `: ${said}` : ""}`, lastPat),
        out.status,
      );
    }

    const frame = frameFor(out.frames, out.id);
    if (!frame) {
      throw new ChiefMcpError(redact(`Chief \`${tool}\` returned no response frame.`, lastPat));
    }
    if (frame.error) {
      // A protocol-level refusal is legible and belongs in front of the model, not thrown past it.
      return {
        text: redact(frame.error.message ?? `Chief \`${tool}\` failed.`, lastPat),
        isError: true,
      };
    }
    const result = frame.result ?? {};
    const text = (result.content ?? [])
      .filter((c) => (c.type ?? "text") === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n");
    return {
      text: redact(text, lastPat),
      data: result.structuredContent,
      isError: result.isError === true ? true : undefined,
    };
  };

  return {
    callTool,
    /** No project header — verified: `list_projects` takes no arguments and no project, and it is
     *  the ONE call that must work before any project is known. */
    async listProjects(): Promise<ChiefProject[]> {
      const res = await callTool(null, "list_projects", {});
      if (res.isError) throw new ChiefMcpError(res.text);
      const raw = asArray(res.data);
      const rows = raw
        .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
        .filter((p) => typeof p.project_id === "string" && typeof p.name === "string")
        .map((p) => ({
          project_id: p.project_id as string,
          name: p.name as string,
          description: typeof p.description === "string" ? p.description : undefined,
          default: p.default === true ? true : undefined,
        }));
      // ROWS ARRIVED AND EVERY ONE WAS DROPPED — that is field drift (`project_id` → `id`, say), not
      // an empty account, and the two must never be reported the same way. See `asArray` above for
      // why an empty catalog is the most expensive thing this module can return.
      if (raw.length > 0 && rows.length === 0) {
        const keys = Object.keys(
          (raw.find((p) => !!p && typeof p === "object") ?? {}) as Record<string, unknown>,
        );
        throw new ChiefMcpError(
          `Chief \`list_projects\` returned ${raw.length} row(s), none carrying the expected \`project_id\` + \`name\` fields` +
            (keys.length ? ` (keys seen: ${keys.join(", ")})` : "") +
            `. Chief's response shape may have changed.`,
        );
      }
      // A PARTIAL drop is not fatal — one malformed row among 348 must not blind the whole catalog —
      // but it is the leading edge of the same drift, so it is never silent.
      if (rows.length < raw.length) {
        console.warn(
          `[chiefMcp] list_projects: dropped ${raw.length - rows.length} of ${raw.length} row(s) missing \`project_id\`/\`name\`.`,
        );
      }
      return rows;
    },
  };
}
