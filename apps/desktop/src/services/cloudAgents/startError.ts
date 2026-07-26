// Honest classification of a FAILED POST /sessions/start (Service B, W5). The definitive gate is
// server-side — start verifies auth, affordability, and the CLOUD_AGENTS_ENABLED flag and returns
// an error we must surface faithfully rather than swallow (spec §Gating: "surface the server's
// error from the start call honestly"). This maps the server's HTTP status + optional stable error
// `code` to a recovery bucket the creation UI can act on (deep-link to the right Settings section),
// degrading to a plain retry when the body is opaque. Pure + unit-tested.

import type { CategoryId } from "../../stores/uiStore";

/** Recovery buckets for a start failure. Mirrors the client-side {@link CloudBlockReason} set plus
 *  a `generic` fallback and an `offline` transport bucket. */
export type StartErrorReason =
  | "feature_disabled"
  | "signed_out"
  | "no_paid_account"
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
  { frag: "cloud_agents_disabled", reason: "feature_disabled" },
  { frag: "feature_disabled", reason: "feature_disabled" },
  { frag: "not_enabled", reason: "feature_disabled" },
  { frag: "no_claude_auth", reason: "no_auth" },
  { frag: "claude_auth", reason: "no_auth" },
  { frag: "missing_auth", reason: "no_auth" },
  { frag: "insufficient_credits", reason: "insufficient_credits" },
  { frag: "out_of_credits", reason: "insufficient_credits" },
  { frag: "not_entitled", reason: "no_paid_account" },
  { frag: "paid_account", reason: "no_paid_account" },
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
          ? "feature_disabled"
          : // Offline only when there is NO status — a real transport failure (fetch rejects) carries
            // none, while any server response (incl. a 500 mentioning "timed out"/"connect") does and
            // stays generic. `!e.status` also treats a `status: 0` (some wrappers use it for network
            // failures) as "no status".
            !e.status && OFFLINE_TEXT.test(text)
            ? "offline"
            : "generic");

  return guidanceFor(reason, e.message ?? undefined);
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

function guidanceFor(reason: StartErrorReason, serverMessage?: string): StartGuidance {
  switch (reason) {
    case "feature_disabled":
      return { reason, message: "Cloud agents aren't available on your account yet." };
    case "signed_out":
      return {
        reason,
        message: "Your session expired. Sign in again to run agents in the cloud.",
        needsSignIn: true,
      };
    case "no_paid_account":
      return {
        reason,
        message: "Cloud agents require a paid account. Upgrade to continue.",
        deepLink: "credits",
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
      // Surface the server's own message when it's short + safe; else a plain retry line.
      return {
        reason: "generic",
        message:
          serverMessage && serverMessage.length > 0 && serverMessage.length <= 200
            ? serverMessage
            : "Couldn't start the cloud agent — try again.",
      };
  }
}
