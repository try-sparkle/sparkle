// Honest classification of a FAILED POST /sessions/start (Service B, W5). The definitive gate is
// server-side — start verifies auth, affordability, and the CLOUD_AGENTS_ENABLED flag and returns
// an error we must surface faithfully rather than swallow (spec §Gating: "surface the server's
// error from the start call honestly"). This maps the server's HTTP status + optional stable error
// `code` to a recovery bucket the creation UI can act on (deep-link to the right Settings section),
// degrading to a plain retry when the body is opaque. Pure + unit-tested.

import type { CategoryId } from "../../stores/uiStore";

/** Recovery buckets for a start failure. Covers the client-side {@link CloudBlockReason} set plus a
 *  `generic` fallback, an `offline` transport bucket, and `service_unavailable` — which has NO
 *  client-side twin, because it is the one thing only the server can tell us. */
export type StartErrorReason =
  /** The server refused with 403 `cloud_agents_disabled`: the ops kill switch is down. This is an
   *  OUTAGE, not an entitlement — it used to be called `feature_disabled` and said "not available on
   *  your account yet", which was a claim about the caller's account for a switch that is global. */
  | "service_unavailable"
  | "signed_out"
  | "no_auth"
  | "insufficient_credits"
  | "offline"
  /** The start SUCCEEDED server-side but no tab materialized here (project closed mid-flight).
   *  Distinct from `generic` so the UI never offers a plain "try again" that would double-start
   *  a billable session (roborev 46278). */
  | "started_untracked"
  | "generic";

/** The structured error the start call may carry ({@link parseStartError} tolerates partials). */
export interface StartErrorLike {
  /** HTTP status, when known. */
  status?: number | null;
  /** Stable machine code from the server body (e.g. "cloud_agents_disabled"), when present. */
  code?: string | null;
  /** Human message from the server body, surfaced verbatim when we have nothing better. */
  message?: string | null;
}

export interface StartGuidance {
  reason: StartErrorReason;
  /** User-facing message. Never leaks raw internal/stack text. */
  message: string;
  /** Settings section to deep-link to for a self-serve fix, when applicable. */
  deepLink?: CategoryId;
  /** True when the fix is to sign in. */
  needsSignIn?: boolean;
}

// Code fragments the server uses (matched case-insensitively as substrings so a namespaced code
// like "cloud_agents_disabled" or "billing.insufficient_credits" still classifies).
const CODE_HINTS: Array<{ frag: string; reason: StartErrorReason }> = [
  { frag: "cloud_agents_disabled", reason: "service_unavailable" },
  { frag: "feature_disabled", reason: "service_unavailable" },
  { frag: "not_enabled", reason: "service_unavailable" },
  { frag: "no_claude_auth", reason: "no_auth" },
  { frag: "claude_auth", reason: "no_auth" },
  { frag: "missing_auth", reason: "no_auth" },
  { frag: "insufficient_credits", reason: "insufficient_credits" },
  { frag: "out_of_credits", reason: "insufficient_credits" },
  // An OLDER server still refuses an unpaid account with `not_entitled`. Cloud no longer requires a
  // paid account, so there is no `no_paid_account` bucket to route this to — and "add credits" is
  // both the right advice and the right deep link for anyone who could still receive it, since a
  // top-up is what clears `paid_at` on that server too.
  { frag: "not_entitled", reason: "insufficient_credits" },
  { frag: "paid_account", reason: "insufficient_credits" },
  { frag: "payment_required", reason: "insufficient_credits" },
];

// Transport-failure phrases for the offline bucket. This is applied ONLY when there is no HTTP
// status (see classifyStartError) — a genuine transport failure (fetch rejects, DNS/TLS) never
// carries a server status, whereas a 500 whose prose happens to mention "could not connect" or
// "timed out" DOES, and must stay `generic`. Gating on the missing status is what prevents the
// over-match, so the phrase list itself can stay generous.
// Includes the phrases the ACTUAL runtimes emit on a transport failure: Chromium "failed to fetch",
// undici/Node "fetch failed", macOS WKWebView (the Tauri webview) "load failed", Firefox/undici
// "NetworkError" (matched via "network ?error"). These only apply when there is no HTTP status.
// `\bload failed\b` is anchored so it matches WKWebView's "Load failed" but NOT "upload failed" /
// "download failed" / "payload failed" (no word boundary before "load" in those).
const OFFLINE_TEXT =
  /failed to fetch|fetch failed|\bload failed\b|network ?error|connection refused|connection reset|could not connect|unable to connect|unreachable|timed out|timeout|econnrefused|enotfound|\boffline\b/;

/** Best-effort structured parse of whatever `start` rejected with (Error, JSON string, or object). */
export function parseStartError(raw: unknown): StartErrorLike {
  if (raw && typeof raw === "object") {
    // Read status/code off ANY object, INCLUDING Error subclasses — CloudApiError is an Error that
    // carries {status, code}. The "no HTTP status ⇒ transport failure" gate below is load-bearing,
    // so it MUST be enforced here: a forwarded CloudApiError(500, …) must keep its status rather than
    // decaying to a message-only shape and falling through to the offline heuristic.
    const o = raw as Record<string, unknown>;
    const status = typeof o.status === "number" ? o.status : null;
    const code = typeof o.code === "string" ? o.code : null;
    // NORMALIZE the message here, at the single boundary every caller goes through: trim the ends
    // and collapse interior runs of whitespace/newlines to one space, then treat an
    // emptied-by-trimming message as absent (null). Without this, an Error whose message is a
    // padded/multi-line server line ("  sandbox failed \n  retrying ") would be surfaced verbatim
    // in the UI, and a whitespace-only message would pass the `length > 0` check in guidanceFor and
    // render as a blank error. Both are the same defect — an un-normalized string reaching the UI.
    const rawMessage = typeof o.message === "string" ? o.message : null;
    const message = rawMessage == null ? null : normalizeMessage(rawMessage);
    // Only when we learned nothing structured AND the message is itself a JSON envelope (some errors
    // wrap the server body in `.message`) do we recurse into it.
    if (status == null && code == null && message && message.startsWith("{")) {
      try {
        // Parse the RAW text, not the collapsed one — collapsing runs of whitespace inside a JSON
        // string literal would alter the nested message we're about to read.
        return parseStartError(JSON.parse(rawMessage!));
      } catch {
        /* keep the message-only shape */
      }
    }
    return { status, code, message };
  }
  const s = (typeof raw === "string" ? raw : "").trim();
  if (s.startsWith("{")) {
    try {
      return parseStartError(JSON.parse(s));
    } catch {
      /* fall through to a message-only shape */
    }
  }
  return { message: normalizeMessage(s) };
}

/** Trim a human message and collapse interior whitespace runs (including newlines) to a single
 *  space; a message that is empty after trimming is `null` (absent), never "". */
function normalizeMessage(s: string): string | null {
  const collapsed = s.trim().replace(/\s+/g, " ");
  return collapsed.length > 0 ? collapsed : null;
}

/**
 * Classify a start failure into actionable guidance. Prefers the stable `code`, then the HTTP
 * status, then message heuristics; falls back to a plain retryable `generic`.
 */
export function classifyStartError(raw: unknown): StartGuidance {
  const e = parseStartError(raw);
  const code = (e.code ?? "").toLowerCase();
  const text = (e.message ?? "").toLowerCase();

  // Match fragments ONLY against the machine `code` — a free-text message can legitimately contain a
  // snake_case substring ("could not connect the repository", a message quoting "payment_required")
  // and must not override the more-reliable HTTP status. Free-text is used only for the offline
  // heuristic below, and only with explicit transport phrases.
  const byCode = CODE_HINTS.find((h) => code.includes(h.frag));
  const reason: StartErrorReason =
    byCode?.reason ??
    (e.status === 401
      ? "signed_out"
      : e.status === 402
        ? "insufficient_credits"
        : e.status === 403
          ? "service_unavailable"
          : // Offline only when there is NO status — a real transport failure (fetch rejects) carries
            // none, while any server response (incl. a 500 mentioning "timed out"/"connect") does and
            // stays generic. `!e.status` also treats a `status: 0` (some wrappers use it for network
            // failures) as "no status".
            !e.status && OFFLINE_TEXT.test(text)
            ? "offline"
            : "generic");

  // A MACHINE CODE IS NOT USER COPY. When a route answers `{ error: "<code>" }` and nothing else,
  // `ensureOk` folds that one string into BOTH `code` and `message` — so the generic branch's
  // "surface the server's own message" rule would render a bare snake_case token as the user's
  // error line. `413 { error: "transcript_too_large" }` is the live example: a user who sent no
  // transcript at all would read "transcript_too_large" and be told their conversation was too big
  // (roborev 57566). Dropping the override here sends those to the reason's own written sentence,
  // which is what the `code`-shaped body was always classified into anyway.
  const prose = e.message != null && e.message.toLowerCase() !== code ? e.message : undefined;
  return guidanceFor(reason, prose, e.status);
}

/**
 * True when a failed start is the server refusing the body for its SIZE — the one trigger for
 * promotion's single transcript retry (plan contract A + D; bead `sparkle-nit44`).
 *
 * The trigger is **status 413 OR the code**, and it must accept either, because the two halves cover
 * different failures and the code-only half misses the case that matters most:
 *
 *   • `code` — the route's own answer, `413 { error: "transcript_too_large" }`, which `ensureOk`
 *     folds into `CloudApiError.code`. This is the deliberate, validated rejection.
 *   • `status` alone — Fastify's `bodyLimit` aborts the request with `FST_ERR_CTP_BODY_TOO_LARGE`
 *     (and a proxy in front of it may send a bare 413 with no JSON at all), so the LARGEST
 *     transcripts — precisely the ones the retry exists for — never carry our code.
 *
 * Deliberately NOT a {@link StartErrorReason}: the only caller that can act on it is `promote.ts`,
 * the only caller that ever sends a transcript. `createCloudAgent` sends none, so a 413 there is an
 * oversized something-else and must keep classifying as `generic` rather than telling a user their
 * conversation was too large when no conversation was sent.
 *
 * Matched against the machine `code` only, never free text — same rule as `CODE_HINTS`, and for the
 * same reason: a 500 whose prose quotes the code must not make a promotion silently drop the user's
 * conversation. Substring, so a namespaced code still fires.
 */
export function isTranscriptTooLarge(raw: unknown): boolean {
  const e = parseStartError(raw);
  return e.status === 413 || (e.code ?? "").toLowerCase().includes("transcript_too_large");
}

/**
 * The one copy of the started-but-untracked guidance. Built here (not inline at the call site) so
 * the sentence the user reads and the `reason` the dialog disables its Start button on can never
 * drift apart (roborev 46881). NON-retryable by construction: the session is running server-side,
 * so "try again" would start — and bill — a second one.
 */
export function startedUntrackedGuidance(): StartGuidance {
  return {
    reason: "started_untracked",
    message:
      "The cloud agent started, but this project is no longer open here — reopen the project to attach to it. (Don't start it again; it's already running.)",
  };
}

function guidanceFor(
  reason: StartErrorReason,
  serverMessage?: string,
  status?: number | null,
): StartGuidance {
  switch (reason) {
    // No deep link, and that is correct HERE in a way it never was for the old account-level
    // message: the kill switch is ours, so there is genuinely nothing in Settings for the user to
    // change. Waiting is the real remedy, so the copy says so rather than pointing somewhere useless.
    case "service_unavailable":
      return { reason, message: "Cloud agents are temporarily unavailable. Try again shortly." };
    case "signed_out":
      return {
        reason,
        message: "Your session expired. Sign in again to run agents in the cloud.",
        needsSignIn: true,
      };
    case "no_auth":
      return {
        reason,
        message: "Add your Claude authentication to run agents in the cloud.",
        deepLink: "cloudauth",
      };
    case "insufficient_credits":
      return {
        reason,
        message: "You're out of credits to run a cloud agent. Add credits to continue.",
        deepLink: "credits",
      };
    case "offline":
      return {
        reason,
        message: "You appear to be offline. Check your connection and try again.",
      };
    case "started_untracked":
      // No `serverMessage` override: this reason is CLIENT-minted only (create.ts, when the store
      // refuses the tab) — no server code or status maps to it, so there is never a server message
      // to prefer. If that ever changes, take the override here (roborev 46918).
      return startedUntrackedGuidance();
    case "generic":
    default:
      // Surface the server's own message when it's short + safe; else a plain retry line. A 413
      // gets its own line first: it is the one status whose bodies are routinely code-only (see the
      // note in classifyStartError), and "try again" is actively wrong advice for a request that
      // will be the same size next time. Kept deliberately neutral about WHAT was too large —
      // `createCloudAgent` sends no transcript, so naming the conversation here would be a guess.
      return {
        reason: "generic",
        message:
          serverMessage && serverMessage.length > 0 && serverMessage.length <= 200
            ? serverMessage
            : status === 413
              ? "That request was too large for the cloud service."
              : "Couldn't start the cloud agent — try again.",
      };
  }
}
