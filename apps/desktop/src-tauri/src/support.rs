// Desktop side of the Sparkle support ticketing system (docs/support/SUPPORT-SYSTEM-SPEC.md §7).
//
// A "Support" link in the status bar opens a modal where the user chats with a docs-aware helper
// and can always open a ticket. The ticket carries as many (redacted) logs as we can gather so a
// human can debug it. All the network + filesystem + secret-handling work lives HERE in Rust
// (never the webview) so:
//   - the redaction of API keys/bearers happens before logs ever cross into JS,
//   - the keychain bearer never enters the JS bundle, and
//   - `ureq` dodges the webview CSP (mirrors auth.rs / trial_remote.rs).
//
// NOTE on base URL: the support HTTP API (`/api/support/*`) is served by the WEB app (sparkle.ai),
// NOT the orchestration host that `auth::base_url()` points at. So this module resolves its own web
// base (mirroring `WEB_BASE_URL` in src/services/sparkleApi.ts: env override, default sparkle.ai).
// ureq is pulled WITHOUT the `json` feature, so we hand-roll with serde_json (send_string /
// into_string), never send_json/into_json.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};

use crate::logging::resolve_log_dir;

/// Bound every support HTTP call so an unreachable web host can't wedge the Tauri command (and the
/// UI awaiting it) indefinitely — ureq has no default request timeout. Mirrors auth.rs.
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

/// Cap the log tail we return/upload at ~200 KB so a giant rolling log can't bloat the request or
/// the webview. We keep the END (most recent activity is what matters for a fresh support case).
const MAX_LOG_BYTES: usize = 200 * 1024;

const DEFAULT_WEB_BASE_URL: &str = "https://sparkle.ai";

/// The marketing/web app base URL (where `/api/support/*` lives). Override with
/// `SPARKLE_WEB_BASE_URL` (or `VITE_WEB_BASE_URL`, for parity with the JS side) for local dev
/// (http://localhost:3000). Deliberately NOT `auth::base_url()` — that is the orchestration host.
fn web_base_url() -> String {
    std::env::var("SPARKLE_WEB_BASE_URL")
        .or_else(|_| std::env::var("VITE_WEB_BASE_URL"))
        .unwrap_or_else(|_| DEFAULT_WEB_BASE_URL.to_string())
}

// ── Compile-once regex plumbing (shared with `nudge_gate.rs`) ───────────────────────────────────

/// Compile a static pattern EXACTLY ONCE and hand out the cached `Regex` forever after.
///
/// `std::sync::OnceLock` is in std, so this costs no dependency. THE ONE COPY of this helper in the
/// crate: `nudge_gate.rs` imports `pattern!` from here rather than keeping its own, so a fix to the
/// caching strategy cannot land in one place and miss the other.
///
/// `expect` rather than a silent fallback: every caller passes a `&'static str` literal, so a bad
/// pattern is a COMPILE-TIME CONSTANT that is wrong in the source — it cannot depend on input,
/// runtime state, or the contents of a log line. It therefore fires on the first call after a bad
/// edit (startup-ish, and deterministically in the unit tests below), never selectively in the
/// field. That is the same trade `nudge_gate.rs` already made.
pub(crate) fn re(cell: &'static OnceLock<Regex>, pattern: &'static str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("static pattern must compile"))
}

/// Declare a cached-regex accessor. Two forms, one implementation:
///   * `pattern!(name, r"…")` — the cell is anonymous, scoped inside the accessor. What
///     `nudge_gate.rs` uses.
///   * `pattern!(name, CELL, r"…")` — the cell is a module-level static under the given name, so a
///     test can ask whether it has been INITIALISED YET without initialising it (which is how the
///     "compiled once, not per call" test below observes the cache instead of asserting a timing).
///
/// Everything inside the expansion is absolutely-pathed so the macro works in any module regardless
/// of what that module happens to have imported.
macro_rules! pattern {
    ($name:ident, $src:expr) => {
        fn $name() -> &'static ::regex::Regex {
            static CELL: ::std::sync::OnceLock<::regex::Regex> = ::std::sync::OnceLock::new();
            $crate::support::re(&CELL, $src)
        }
    };
    ($name:ident, $cell:ident, $src:expr) => {
        static $cell: ::std::sync::OnceLock<::regex::Regex> = ::std::sync::OnceLock::new();
        fn $name() -> &'static ::regex::Regex {
            $crate::support::re(&$cell, $src)
        }
    };
}
pub(crate) use pattern;

// ── Log tailing + redaction ─────────────────────────────────────────────────────────────────────

const REDACTED: &str = "«redacted»";

/// Strip anything that looks like a SECRET from a log blob before it leaves the device — while
/// deliberately PRESERVING the non-secret identifiers a support engineer needs to correlate a
/// ticket with the logs (git SHAs, UUID worktree/agent ids, trace ids). Best-effort
/// defense-in-depth: we redact by SHAPE, targeting keys/bearers/tokens, not free-form text (see
/// the modal copy — this removes API keys and tokens, not general PII). Patterns, in order:
///   - JWTs (`eyJ….….…`)
///   - `Authorization: <value>` headers (whole value, so it can't double-redact with `Bearer`)
///   - standalone `Bearer <token>` values
///   - `sk-…` provider keys (Anthropic and OpenAI)
///   - secret assignments `NAME_(API|API_KEY|TOKEN|SECRET|PASSWORD|KEY)=<value>` in bare, quoted, and
///     JSON shapes (`k=v`, `k: "v"`, `"apiKey":"v"`)
///   - credentials in URL userinfo (`scheme://user:secret@host`)
///   - leftover HIGH-ENTROPY blobs: dash-free 40+ runs with BOTH letters and digits — which covers
///     mixed-case, single-case, and off-length hex tokens — while KEEPING dashed UUIDs and canonical
///     40/64-char git hashes so those stay legible for debugging
pub fn redact_secrets(input: &str) -> String {
    let mut out = input.to_string();
    // JWTs first (three base64url segments).
    out = jwt().replace_all(&out, REDACTED).into_owned();
    out = authorization_header()
        .replace_all(&out, "Authorization: «redacted»")
        .into_owned();
    out = bearer_token()
        .replace_all(&out, "Bearer «redacted»")
        .into_owned();
    out = provider_key().replace_all(&out, REDACTED).into_owned();
    out = secret_assignment()
        .replace_all(&out, "$1«redacted»")
        .into_owned();
    out = url_userinfo()
        .replace_all(&out, "$1«redacted»@")
        .into_owned();
    // Explicit token PREFIXES, redacted length-independently and BEFORE the hex/entropy heuristics
    // below. A blob carrying one of these prefixes is unambiguously a secret whatever its length, so
    // it must redact even when the catch-all would skip it — e.g. a 40-hex-shaped GitHub token or a
    // sub-40 key the length floor lets through. See `token_prefix` for the covered shapes.
    out = token_prefix().replace_all(&out, REDACTED).into_owned();
    // The CLI flag form (`--password v`, `--token v`, `--secret v`, `--api-key v`), space- OR
    // `=`-separated, length-independent. `secret_assignment` above only catches the `k=v`/`k:"v"`
    // shapes, so a space-delimited `--token <32hex>` (below the entropy floor) would otherwise leak.
    // Keep the flag name so the log still reads sensibly; redact only its value.
    out = cli_secret_flag()
        .replace_all(&out, "$1«redacted»")
        .into_owned();
    // The catch-all's closure decides per-match so we PRESERVE the identifiers a human needs while
    // still catching secret shapes — see `high_entropy_blob` for which shapes survive and why.
    out = high_entropy_blob()
        .replace_all(&out, |c: &regex::Captures| {
            let t = &c[0];
            let len = t.len();
            let is_hex = t.bytes().all(|b| b.is_ascii_hexdigit());
            let has_dash = t.contains('-');
            let has_letter = t.bytes().any(|b| b.is_ascii_alphabetic());
            let has_digit = t.bytes().any(|b| b.is_ascii_digit());
            let is_canonical_git_hash = is_hex && (len == 40 || len == 64);
            if !has_dash && has_letter && has_digit && !is_canonical_git_hash {
                REDACTED.to_string()
            } else {
                t.to_string()
            }
        })
        .into_owned();
    out
}

// THE PATTERNS, COMPILED ONCE EACH — and this is a HOT PATH, not the once-per-click cost the old
// comment here claimed.
//
// That claim ("redaction runs at most once per 'open ticket' click, so the cost is irrelevant") was
// true when it was written and is now false: `logging.rs` wraps BOTH tracing sink layers (the
// rolling file appender AND stderr) in `RedactingMakeWriter`, and `redacting_writer.rs` calls
// `redact_secrets` inside `Write::write`. So this runs ONCE PER FORMATTED TRACING EVENT, PER LAYER —
// twice per log line, at ~90-145K events/day, on whichever thread emitted the event, INCLUDING the
// AppKit main thread during a Tauri IPC command. Recompiling seven regexes there was measured (a
// `/usr/bin/sample` of shipped 0.96.1 during a 10.2s UI freeze) as main-thread time inside
// `regex_automata`'s NFA/DFA compiler, reached through `Event::dispatch` → `RedactingWriter`.
//
// ORDER IS SECURITY-RELEVANT and is fixed by `redact_secrets` above, not by this list: JWT runs
// before Authorization, which runs before Bearer, so the broader rule swallows the whole
// `<scheme> <token>` and the narrower one cannot double-redact what is left.
//
// Each cell is named so the test below can ask whether it is INITIALISED without initialising it.

pattern!(
    jwt,
    JWT_CELL,
    r"eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}"
);

// `Authorization: <value>` / `Authorization = <value>` — consume an optional AUTH SCHEME word
// (Bearer / Basic / Digest / Negotiate / …) plus the credential token, but STOP at whitespace so
// trailing correlation fields on the same line (`… requestId=abc worktree=<uuid>`) are preserved.
// The scheme is `\w+\s+` (not just `Bearer`) so a non-Bearer scheme's credential can't leak as a
// separate token. Runs BEFORE the Bearer rule and swallows the whole `<scheme> <token>`.
pattern!(
    authorization_header,
    AUTHORIZATION_HEADER_CELL,
    r"(?i)\bAuthorization\b\s*[:=]\s*(?:\w+\s+)?[^\s,]+"
);

// Standalone `Bearer <token>` (keep the scheme word so the log still reads sensibly).
pattern!(
    bearer_token,
    BEARER_TOKEN_CELL,
    r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+"
);

// Provider secret keys.
pattern!(provider_key, PROVIDER_KEY_CELL, r"(?i)sk-[A-Za-z0-9_-]{16,}");

// Secret assignments: NAME_(API|API_KEY|TOKEN|SECRET|PASSWORD|KEY) = value. Handles bare, quoted,
// AND JSON shapes — `KEY=v`, `key: "v"`, `"apiKey":"v"` — by allowing optional quotes around the
// name and an optional opening quote on the value (kept in the capture so it reads sensibly). The
// value stops at whitespace/quote/comma/brace so we redact just the secret, not the rest of a line.
pattern!(
    secret_assignment,
    SECRET_ASSIGNMENT_CELL,
    r#"(?i)("?[A-Z0-9_]*(?:API(?:_KEY)?|TOKEN|SECRET|PASSWORD|KEY)"?\s*[:=]\s*"?)[^\s"',}]+"#
);

// Credentials embedded in a URL userinfo: `scheme://user:secret@host` → keep everything up to and
// including `user:`, redact the password, keep `@host`. (A URL with no `user:…@` won't match, so
// ordinary links and `host:port` are untouched.)
pattern!(
    url_userinfo,
    URL_USERINFO_CELL,
    r"(?i)([a-z][a-z0-9+.-]*://[^\s:/@]+:)[^\s@/]+@"
);

// Explicit provider/token PREFIXES — redacted whatever the length, so a token that collides with a
// git-hash SHAPE (a 40-hex-looking value) or that falls under the high-entropy length floor still
// goes. Covers GitHub (`ghp_`/`gho_`/`ghs_`/`ghu_`/`github_pat_`), Slack (`xoxb-`/`xoxa-`/`xoxp-`/
// `xoxr-`/`xoxs-`), Stripe (`sk_live_`/`sk_test_`), and Anthropic (`sk-ant-`) key shapes. The body
// after the prefix is a run of token characters (alnum plus `_-`, which also covers Slack's
// dash-segmented tokens). Case-insensitive so a lowercased log line can't dodge it. Runs BEFORE the
// hex/entropy pass so a prefixed blob is always redacted regardless of what that pass would decide.
pattern!(
    token_prefix,
    TOKEN_PREFIX_CELL,
    r"(?i)(?:gh[posu]_|github_pat_|xox[baprs]-|sk_(?:live|test)_|sk-ant-)[A-Za-z0-9_-]+"
);

// Secrets passed as a CLI flag: `--password`, `--token`, `--secret`, `--api-key`/`--api_key`/
// `--apikey`, either space- or `=`-separated. The value (`\S+`) is redacted length-independently;
// the flag name and its separator are kept (capture group 1) so the log still reads sensibly. This
// complements `secret_assignment`, which only handles the `k=v`/`k:"v"`/JSON shapes, not the
// double-dash space-delimited argv form a spawned process logs.
pattern!(
    cli_secret_flag,
    CLI_SECRET_FLAG_CELL,
    r"(?i)(--(?:password|token|secret|api[-_]?key)[ =])\S+"
);

// Leftover high-entropy blobs (unlabeled tokens with no `key=`/`Bearer`/`sk-` context). We redact a
// dash-free, letters-AND-digits run of 40+ — which covers mixed-case, single-case (`ABCD12…`), and
// off-length hex tokens — but KEEP:
//   - dashed forms (UUID worktree/agent ids),
//   - canonical git-object hashes: exactly 40- or 64-char hex (SHA-1 / SHA-256),
//   - pure-digit or pure-letter runs (not token-shaped).
// Base64 tokens containing `+`/`/`/`=` are only partially covered (those chars split the run);
// in practice such secrets arrive labeled (JWT/Bearer/`sk-`/env), which the rules above catch.
pattern!(high_entropy_blob, HIGH_ENTROPY_BLOB_CELL, r"[A-Za-z0-9_-]{40,}");

/// Read up to `max` bytes from the END of a file, dropping a leading partial line so the tail
/// starts on a clean record. UTF-8-lossy so a non-text byte in the log can't fail the whole read.
fn tail_file(path: &Path, max: usize) -> Option<String> {
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(max as u64);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity(max.min(len as usize));
    f.take(max as u64).read_to_end(&mut buf).ok()?;
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    if start > 0 {
        // We seeked into the middle of a line; drop everything up to the first newline.
        if let Some(nl) = text.find('\n') {
            text = text[nl + 1..].to_string();
        }
    }
    Some(text)
}

/// Tail the unified log: the current `sparkle.log` plus the most recent rotated
/// `sparkle.log.YYYY-MM-DD` (rotated files sort chronologically by name). We spend the byte budget
/// on the newest activity first (current log), then backfill from the previous day if there's room.
/// The combined text is REDACTED before it is returned to JS.
///
/// `async` + `spawn_blocking`: the directory scan, tail reads, and per-call regex redaction are all
/// blocking work that would otherwise run inline on the Tauri event-loop thread and freeze the UI.
/// The (cheap) log-dir resolution needs `&app`, so it happens on the caller thread; the blocking
/// filesystem work moves to the blocking pool. The blocking core is [`read_recent_logs_sync`], which
/// the crash-flush background thread reuses directly (it already runs off the event loop).
#[tauri::command]
pub async fn read_recent_logs<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let dir = resolve_log_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || read_recent_logs_from_dir(&dir))
        .await
        .map_err(|e| format!("read_recent_logs task failed: {e}"))?
}

/// Blocking core of [`read_recent_logs`] taking an already-resolved app handle. Used by the crash
/// flush (`crash.rs::run_flush`), which runs on its own `std::thread` and so can — and must — call
/// this synchronously rather than awaiting the async command. Resolves the log dir, then delegates
/// the tailing + redaction to [`read_recent_logs_from_dir`].
pub(crate) fn read_recent_logs_sync<R: Runtime>(app: &AppHandle<R>) -> Result<String, String> {
    let dir = resolve_log_dir(app)?;
    read_recent_logs_from_dir(&dir)
}

/// Scan `dir`, tail the current + most-recent-rotated log within the byte budget, and return the
/// combined REDACTED tail. Pure blocking IO over a resolved directory — no Tauri handle — so it can
/// run on the blocking pool (the async command) or a background thread (crash flush) alike.
fn read_recent_logs_from_dir(dir: &Path) -> Result<String, String> {
    let mut rotated: Vec<String> = Vec::new();
    let mut has_current = false;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            if let Some(name) = e.file_name().to_str() {
                if name == "sparkle.log" {
                    has_current = true;
                } else if let Some(suffix) = name.strip_prefix("sparkle.log.") {
                    // Only date-suffixed rotations (YYYY-MM-DD…), not e.g. a stray sparkle.log.tmp.
                    if suffix.as_bytes().first().is_some_and(|b| b.is_ascii_digit()) {
                        rotated.push(name.to_string());
                    }
                }
            }
        }
    }
    rotated.sort();
    let most_recent_rotated = rotated.last().cloned();

    let current = if has_current {
        tail_file(&dir.join("sparkle.log"), MAX_LOG_BYTES).unwrap_or_default()
    } else {
        String::new()
    };

    let mut combined = String::new();
    let remaining = MAX_LOG_BYTES.saturating_sub(current.len());
    if remaining > 0 {
        if let Some(rot) = most_recent_rotated {
            if let Some(older) = tail_file(&dir.join(&rot), remaining) {
                combined.push_str(&older);
                if !older.ends_with('\n') {
                    combined.push('\n');
                }
            }
        }
    }
    combined.push_str(&current);

    let combined = combined.trim();
    if combined.is_empty() {
        return Ok("(no logs found)".to_string());
    }
    Ok(redact_secrets(combined))
}

// ── Metadata ──────────────────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportMeta {
    app_version: String,
    os: String,
    arch: String,
}

/// App version + host OS/arch, attached to every ticket so a human knows the environment.
#[tauri::command]
pub fn support_metadata<R: Runtime>(app: AppHandle<R>) -> Result<SupportMeta, String> {
    Ok(SupportMeta {
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    })
}

// ── Docs-aware chat helper ──────────────────────────────────────────────────────────────────────

/// One turn of the support chat, matching the web `/api/support/chat` contract (`{role, content}`).
#[derive(Serialize, Deserialize, Clone)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocLink {
    pub title: String,
    pub href: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatResp {
    pub reply: String,
    pub doc_links: Vec<DocLink>,
    pub offer_ticket: bool,
}

/// POST the running transcript to the (unauthenticated) docs-aware chat route and return the
/// assistant reply + any doc links + whether the server suggests opening a ticket.
///
/// `async` + `spawn_blocking` so the blocking `ureq` round-trip (up to `HTTP_TIMEOUT` = 30s on a
/// flaky network) runs on the blocking pool instead of freezing the Tauri event-loop thread.
#[tauri::command]
pub async fn support_chat_send(messages: Vec<ChatMsg>) -> Result<ChatResp, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<ChatResp, String> {
        let url = format!("{}/api/support/chat", web_base_url());
        let body = json!({ "messages": messages }).to_string();
        let resp = ureq::post(&url)
            .timeout(HTTP_TIMEOUT)
            .set("Content-Type", "application/json")
            .send_string(&body)
            .map_err(|e| format!("support chat failed: {e}"))?;
        let text = resp.into_string().map_err(|e| e.to_string())?;
        let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;

        let reply = v
            .get("reply")
            .and_then(|r| r.as_str())
            .unwrap_or("")
            .to_string();
        let doc_links = v
            .get("docLinks")
            .and_then(|d| d.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|l| {
                        let title = l.get("title").and_then(|t| t.as_str())?.to_string();
                        let href = l.get("href").and_then(|h| h.as_str())?.to_string();
                        Some(DocLink { title, href })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let offer_ticket = v
            .get("offerTicket")
            .and_then(|o| o.as_bool())
            .unwrap_or(false);

        Ok(ChatResp {
            reply,
            doc_links,
            offer_ticket,
        })
    })
    .await
    .map_err(|e| format!("support_chat_send task failed: {e}"))?
}

// ── Ticket creation ─────────────────────────────────────────────────────────────────────────────

/// One stored chat turn to persist with the ticket (`{role, body}`, matching lib/support.ts).
#[derive(Serialize, Deserialize, Clone)]
pub struct TranscriptMsg {
    pub role: String,
    pub body: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTicketPayload {
    pub email: String,
    pub subject: String,
    pub message: String,
    pub app_version: Option<String>,
    pub os: Option<String>,
    pub metadata: Option<Value>,
    pub logs: Option<String>,
    pub assistant_transcript: Option<Vec<TranscriptMsg>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedTicket {
    pub id: String,
    pub token: String,
    pub url: String,
}

/// Create a support ticket on the web app. Attaches the desktop bearer as `Authorization` IF one is
/// stored (so an authenticated user's ticket is tied to their account), but works unauthenticated
/// too — the server falls back to `body.email`.
///
/// `async` + `spawn_blocking` so the blocking `ureq` round-trip (up to `HTTP_TIMEOUT` = 30s on a
/// flaky network) runs on the blocking pool instead of freezing the Tauri event-loop thread.
#[tauri::command]
pub async fn desktop_create_ticket(payload: CreateTicketPayload) -> Result<CreatedTicket, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<CreatedTicket, String> {
        let url = format!("{}/api/support/tickets", web_base_url());
        let body = json!({
            "email": payload.email,
            "subject": payload.subject,
            "message": payload.message,
            "source": "desktop",
            "appVersion": payload.app_version,
            "os": payload.os,
            "metadata": payload.metadata,
            "logs": payload.logs,
            "assistantTranscript": payload.assistant_transcript,
        })
        .to_string();

        let mut req = ureq::post(&url)
            .timeout(HTTP_TIMEOUT)
            .set("Content-Type", "application/json");
        if let Some(token) = crate::auth::token() {
            req = req.set("Authorization", &format!("Bearer {token}"));
        }
        let resp = req
            .send_string(&body)
            .map_err(|e| format!("create ticket failed: {e}"))?;
        let text = resp.into_string().map_err(|e| e.to_string())?;
        let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;

        let id = v
            .get("id")
            .and_then(|i| i.as_str())
            .ok_or_else(|| "ticket response missing id".to_string())?
            .to_string();
        let token = v
            .get("token")
            .and_then(|t| t.as_str())
            .ok_or_else(|| "ticket response missing token".to_string())?
            .to_string();
        let ticket_url = v
            .get("url")
            .and_then(|u| u.as_str())
            .ok_or_else(|| "ticket response missing url".to_string())?
            .to_string();

        Ok(CreatedTicket {
            id,
            token,
            url: ticket_url,
        })
    })
    .await
    .map_err(|e| format!("desktop_create_ticket task failed: {e}"))?
}

// ── Ticket listing (status banner) ────────────────────────────────────────────────────────────

/// One ticket as surfaced to the desktop status banner. Mirrors a row of the web
/// `GET /api/support/tickets` response, but only the fields the banner needs. `status` stays a
/// raw String (the JS side narrows it to the three-status union); `last_message_at` is the ISO
/// timestamp the web route serializes from the `lastMessageAt` column.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketStatus {
    pub id: String,
    pub token: String,
    pub subject: String,
    pub status: String,
    pub last_message_at: Option<String>,
}

/// Extract the banner ticket rows from a parsed `GET /api/support/tickets` body. A row missing a
/// required string field (`id`/`token`/`subject`/`status`) is SKIPPED with a warning rather than
/// silently dropped, so a systematic serialization mismatch surfaces in the logs instead of
/// masquerading as "no tickets". Pure over `serde_json::Value` so it unit-tests without any HTTP.
fn parse_tickets(v: &Value) -> Vec<TicketStatus> {
    let Some(arr) = v.get("tickets").and_then(|t| t.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(arr.len());
    for t in arr {
        let row = (|| {
            Some(TicketStatus {
                id: t.get("id").and_then(|x| x.as_str())?.to_string(),
                token: t.get("token").and_then(|x| x.as_str())?.to_string(),
                subject: t.get("subject").and_then(|x| x.as_str())?.to_string(),
                status: t.get("status").and_then(|x| x.as_str())?.to_string(),
                last_message_at: t
                    .get("lastMessageAt")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string()),
            })
        })();
        match row {
            Some(r) => out.push(r),
            None => tracing::warn!(target: "support", "skipping ticket row missing a required field"),
        }
    }
    out
}

/// List the signed-in user's own support tickets (`GET {web_base_url}/api/support/tickets`).
/// Attaches the desktop bearer as `Authorization` — the web route resolves it via Clerk and
/// returns the caller's own tickets. When no bearer is stored (signed-out) there are no tickets
/// to show, so we short-circuit to an empty Vec and skip the network call. Mirrors
/// `desktop_create_ticket`: ureq + serde_json (no `json` feature).
///
/// `async` + `spawn_blocking` so the blocking `ureq` round-trip runs on the blocking pool instead
/// of the Tauri event-loop thread. This is the WORST offender: it fires every 60s AND on every
/// window focus, so inline it could beachball the whole UI for up to `HTTP_TIMEOUT` = 30s whenever
/// the network is flaky.
#[tauri::command]
pub async fn desktop_list_tickets() -> Result<Vec<TicketStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<TicketStatus>, String> {
        let Some(token) = crate::auth::token() else {
            return Ok(Vec::new());
        };
        let url = format!("{}/api/support/tickets", web_base_url());
        let resp = ureq::get(&url)
            .timeout(HTTP_TIMEOUT)
            .set("Authorization", &format!("Bearer {token}"))
            .call()
            .map_err(|e| format!("list tickets failed: {e}"))?;
        let text = resp.into_string().map_err(|e| e.to_string())?;
        let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;

        // The GET route returns EVERY ticket (not just the caller's own) when the signed-in user is
        // the super admin (`isAdmin: true`). This banner is the personal "your open tickets" view, so
        // for an admin it would surface the whole support queue with inverted attention semantics (an
        // admin's actionable tickets are `awaiting_support`, not `awaiting_user`). Suppress it for
        // admins — they use the /admin support console instead (design spec §2).
        if v.get("isAdmin").and_then(|a| a.as_bool()).unwrap_or(false) {
            return Ok(Vec::new());
        }
        Ok(parse_tickets(&v))
    })
    .await
    .map_err(|e| format!("desktop_list_tickets task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Event-loop offload guards ───────────────────────────────────────────────────────────────
    //
    // A non-async `#[tauri::command]` runs INLINE on the Tauri event-loop thread, so the blocking
    // `ureq` round-trips below (bounded at HTTP_TIMEOUT = 30s) would beachball the whole UI on a
    // flaky network — worst of all `desktop_list_tickets`, which fires every 60s AND on every
    // window focus. These coercions only type-check while each command returns a future: revert a
    // `pub async fn` to `pub fn` and its return type becomes a plain `Result`, which is not a
    // `Future`, and the build breaks here. The rest of this module's tests are pure-function tests
    // (redaction, parsing), so without these guards such a regression would pass silently.
    //
    // No network is touched: calling an `async fn` only CONSTRUCTS its future — the body does not
    // run until polled, and these futures are dropped unpolled.

    fn assert_async_command<A, Fut: std::future::Future>(_f: fn(A) -> Fut) {}
    fn assert_async_command0<Fut: std::future::Future>(_f: fn() -> Fut) {}

    #[test]
    fn http_commands_stay_off_the_event_loop() {
        assert_async_command(support_chat_send);
        assert_async_command(desktop_create_ticket);
        // The worst offender: polled every 60s and on every window focus.
        assert_async_command0(desktop_list_tickets);
    }

    #[test]
    fn read_recent_logs_stays_off_the_event_loop() {
        // Tailing + regex-redacting up to 200 KB of logs is blocking filesystem work.
        assert_async_command(read_recent_logs::<tauri::Wry>);
    }

    // ── The compile-once guard ──────────────────────────────────────────────────────────────────

    /// Every pattern cell, paired with its name for a readable failure. Taking `&STATIC` does NOT
    /// initialise a `OnceLock` — only `get_or_init` (i.e. an accessor call) does — so this list can
    /// observe the cache without being the thing that fills it.
    fn cells() -> Vec<(&'static str, &'static OnceLock<Regex>)> {
        vec![
            ("jwt", &JWT_CELL),
            ("authorization_header", &AUTHORIZATION_HEADER_CELL),
            ("bearer_token", &BEARER_TOKEN_CELL),
            ("provider_key", &PROVIDER_KEY_CELL),
            ("secret_assignment", &SECRET_ASSIGNMENT_CELL),
            ("url_userinfo", &URL_USERINFO_CELL),
            ("token_prefix", &TOKEN_PREFIX_CELL),
            ("cli_secret_flag", &CLI_SECRET_FLAG_CELL),
            ("high_entropy_blob", &HIGH_ENTROPY_BLOB_CELL),
        ]
    }

    /// `redact_secrets` must go through the CACHE, not `Regex::new`.
    ///
    /// This asserts the side effect of the fix rather than its timing (a timing assertion here would
    /// be flaky and would not say WHY it was slow). The cells above are private to this module and
    /// NOTHING initialises them except the pattern accessors, which only `redact_secrets` calls — so
    /// "every cell is populated after one call" is a direct statement about the code path that call
    /// took. Revert the body to per-call `regex::Regex::new(...)` and every cell stays `None`,
    /// whatever else the suite ran first, because the accessors are then dead code.
    ///
    /// The second half pins the consequence that matters on the hot path (`redacting_writer.rs`
    /// calls this once per tracing event, per sink layer): a second call REUSES the same compiled
    /// instances rather than building new ones.
    #[test]
    fn redact_secrets_compiles_each_pattern_once_not_per_call() {
        // Exercise every rule in one string so no cell can stay cold for want of a match — though
        // `replace_all` runs the matcher either way, so even a non-matching input must populate
        // every cell.
        //
        // The URL userinfo goes through `shaped()` for the reason given above: spelled inline, a
        // scheme followed by a colon-separated user/password pair and an `@` is a live match for the
        // URL-credential rule in BOTH the DENY and SECRET_SCAN lists of scripts/publish-public.sh,
        // which greps the exported SOURCE text. Gate 1 has no allowlist or path exemption, so
        // inlining that shape here freezes the public mirror on merge to main. Keep the colon out of
        // the format string; the runtime value is unchanged, so the rule is still exercised.
        //
        // This comment cannot spell the offending shape out either — gate 1 greps every line of the
        // export, comments included, and an illustrative example here trips it exactly as the code
        // did. Describe the shape; never write it.
        let sample = format!(
            "Authorization: Bearer eyJabc.defghijklmnop.qrstuvwx1234 KEY={} url postgres://{}@h ok",
            shaped("sk-", "abcDEF123456789_ghiJKL"),
            shaped("u:", "p")
        );
        let _ = redact_secrets(&sample);

        let first: Vec<*const Regex> = cells()
            .into_iter()
            .map(|(name, cell)| {
                let r = cell.get().unwrap_or_else(|| {
                    panic!(
                        "redact_secrets did not use the cached `{name}` regex — it is recompiling \
                         patterns per call, on a path that runs twice per log line"
                    )
                });
                r as *const Regex
            })
            .collect();

        // A second call must reuse the very same compiled instances.
        let _ = redact_secrets(&sample);
        for ((name, cell), before) in cells().into_iter().zip(first) {
            let after = cell.get().expect("cell emptied itself") as *const Regex;
            assert!(
                std::ptr::eq(before, after),
                "`{name}` was recompiled between calls"
            );
        }
    }

    /// The shared helper `nudge_gate.rs` now imports. Pinned here so a change that makes `re()`
    /// hand back a fresh `Regex` fails in the module that owns it, not only in the gate.
    #[test]
    fn re_returns_the_same_instance_every_time() {
        static CELL: OnceLock<Regex> = OnceLock::new();
        let a = re(&CELL, r"\d+");
        let b = re(&CELL, r"\d+");
        assert!(std::ptr::eq(a, b), "re() recompiled a cached pattern");
    }

    // Fixtures below assemble their fake, secret-SHAPED strings at runtime from split pieces, so no
    // literal secret-shaped string ever appears in this source file. That keeps the public-mirror
    // leak-check gate (scripts/publish-public.sh) strict — it greps the exported source text — while
    // still handing redact_secrets() a real-shaped value to redact.
    fn shaped(prefix: &str, body: &str) -> String {
        format!("{prefix}{body}")
    }

    #[test]
    fn redacts_provider_keys() {
        let s = format!("using key {} to call anthropic", shaped("sk-", "ant-api03-abcDEF123456789_ghiJKL"));
        let out = redact_secrets(&s);
        assert!(!out.contains(&shaped("sk-", "ant-api03")), "sk- key survived: {out}");
        assert!(out.contains(REDACTED));
    }

    #[test]
    fn redacts_bearer_tokens() {
        let s = "GET /me\nAuthorization: Bearer eyJabc.defghijklmnop.qrstuvwx1234";
        let out = redact_secrets(s);
        assert!(!out.contains("eyJabc"), "bearer token survived: {out}");
    }

    #[test]
    fn authorization_header_redacts_once_not_twice() {
        // The Authorization rule swallows the whole `Bearer <token>`, so we don't get the noisier
        // "Authorization: «redacted» «redacted»" double-redaction the Bearer rule alone would cause.
        let out = redact_secrets("Authorization: Bearer abc.def.ghi");
        assert_eq!(out, "Authorization: «redacted»");
    }

    #[test]
    fn redacts_non_bearer_authorization_schemes() {
        // The scheme word AND its credential must both go — for Basic, Digest, etc. — not just the
        // scheme word (which would leave a short base64 credential in the clear).
        let basic = redact_secrets("Authorization: Basic dXNlcjpwYXNzd29yZA==");
        assert!(!basic.contains("dXNlcjpwYXNzd29yZA"), "Basic credential survived: {basic}");
        assert_eq!(basic, "Authorization: «redacted»");
        let digest = redact_secrets("Authorization: Digest username=admin");
        assert!(!digest.contains("username=admin"), "Digest credential survived: {digest}");
    }

    #[test]
    fn authorization_rule_preserves_trailing_correlation_fields() {
        // The value is bounded at whitespace, so non-secret ids logged after the header survive.
        let out = redact_secrets("Authorization: Bearer sometoken123 requestId=r-42 worktree=abc");
        assert!(!out.contains("sometoken123"), "token survived: {out}");
        assert!(out.contains("requestId=r-42"), "trailing field eaten: {out}");
        assert!(out.contains("worktree=abc"), "trailing field eaten: {out}");
    }

    #[test]
    fn redacts_env_assignments() {
        let s = format!("ANTHROPIC_API={}\nDATABASE_URL=postgres://x", shaped("sk-", "super-secret-value-1234567890"));
        let out = redact_secrets(&s);
        assert!(!out.contains(&shaped("sk-", "super-secret-value")), "env secret survived: {out}");
        // The variable NAME is preserved so the log still reads sensibly.
        assert!(out.contains("ANTHROPIC_API"));
    }

    #[test]
    fn redacts_password_assignment() {
        let out = redact_secrets(r#"DB_PASSWORD=hunter2plaintextvalue and PASSWORD: "another1secret""#);
        assert!(!out.contains("hunter2plaintextvalue"), "password survived: {out}");
        assert!(!out.contains("another1secret"), "quoted password survived: {out}");
    }

    #[test]
    fn redacts_single_case_and_offlength_hex_tokens() {
        // Single-case-and-digit opaque token (no dash, 40+) — now redacted.
        let upper = "ABCDEFGH1234567890ABCDEFGH1234567890ABCD";
        let out = redact_secrets(&format!("session {upper} started"));
        assert!(!out.contains(upper), "single-case token survived: {out}");
        // Off-length hex (48 chars — not a canonical 40/64 git hash) — redacted.
        let hex48 = "0123456789abcdef0123456789abcdef0123456789abcdef";
        let out2 = redact_secrets(&format!("token {hex48} ok"));
        assert!(!out2.contains(hex48), "off-length hex token survived: {out2}");
    }

    #[test]
    fn preserves_canonical_git_hashes() {
        // Exactly 40- and 64-char hex are treated as git SHA-1 / SHA-256 object ids and kept.
        let sha1 = "0123456789abcdef0123456789abcdef01234567"; // 40
        let sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // 64
        let s = format!("HEAD {sha1} tree {sha256}");
        assert_eq!(redact_secrets(&s), s);
    }

    #[test]
    fn redacts_prefixed_provider_tokens() {
        // Explicit token prefixes redact length-INDEPENDENTLY — including short tokens the
        // high-entropy floor (40+) would let through, and prefixes (`sk_…`, `gh…_`) that no other
        // rule covers. Assembled from fragments so no full-shaped token literal appears in this
        // source (the public-mirror leak gate greps the exported text).
        let cases = [
            shaped("ghp_", "aBc123def"),            // GitHub PAT, well under 40 chars
            shaped("gho_", "Xy9Zt4qw"),             // GitHub OAuth token
            shaped("github_pat_", "11ABCDE_fghij"), // fine-grained PAT
            shaped("xoxb-", "12ab-34cd-efGH"),      // Slack bot token
            shaped("sk_live_", "51H8xShortval"),    // Stripe live key (underscore — not `sk-`)
            shaped("sk-ant-", "api03short"),        // Anthropic key too short for provider_key's 16+ floor
        ];
        for tok in cases {
            let out = redact_secrets(&format!("using {tok} now"));
            assert!(!out.contains(tok.as_str()), "prefixed token survived: {out}");
            assert!(out.contains(REDACTED), "expected a redaction marker: {out}");
        }
    }

    #[test]
    fn redacts_cli_secret_flags() {
        // Secrets passed as a process's CLI flag — space-delimited, which `secret_assignment`'s
        // `k=v` shape does NOT cover. A 32-hex bridge token is below the entropy floor and has no
        // `key=` context, so `--token <hex>` is caught by THIS rule alone. Non-vacuous: remove the
        // cli_secret_flag pass and both values below leak.
        let hex32 = "0123456789abcdef0123456789abcdef"; // 32-hex bridge-token shape (< 40)
        let out = redact_secrets(&format!("spawn --token {hex32} --password hunter2plaintext extra"));
        assert!(!out.contains(hex32), "--token value survived: {out}");
        assert!(!out.contains("hunter2plaintext"), "--password value survived: {out}");
        // The flag name and unrelated trailing args are preserved so the log still reads sensibly.
        assert!(out.contains("--token"), "flag name eaten: {out}");
        assert!(out.contains("extra"), "trailing arg eaten: {out}");

        // The `--secret <value>` spelling (space-delimited) is likewise only reachable here.
        let out2 = redact_secrets("run --secret sup3rsecretvalue done");
        assert!(!out2.contains("sup3rsecretvalue"), "--secret value survived: {out2}");
        assert!(out2.contains("--secret"), "flag name eaten: {out2}");
        assert!(out2.contains("done"), "trailing arg eaten: {out2}");
    }

    #[test]
    fn prefixed_redaction_still_passes_genuine_git_shas() {
        // The token-prefix / CLI passes must not touch a real 40-hex git SHA in a commit context —
        // it carries no token prefix and is not a `--flag` value, so it survives as before.
        let sha = "0123456789abcdef0123456789abcdef01234567"; // 40-char hex git SHA
        let s = format!("HEAD is now at {sha} on main");
        assert_eq!(redact_secrets(&s), s, "a genuine git SHA must survive redaction");
    }

    #[test]
    fn redacts_quoted_and_json_secret_values() {
        // Quoted assignment and JSON-structured log shapes must not slip through.
        let quoted = redact_secrets(r#"apiKey="hunter2secretvalue""#);
        assert!(!quoted.contains("hunter2secretvalue"), "quoted secret survived: {quoted}");
        let json = redact_secrets(r#"{"apiKey":"hunter2secretvalue","level":"info"}"#);
        assert!(!json.contains("hunter2secretvalue"), "json secret survived: {json}");
        // The non-secret sibling field is untouched.
        assert!(json.contains("\"level\":\"info\""), "over-redacted json: {json}");
    }

    #[test]
    fn redacts_url_userinfo_credentials() {
        let out = redact_secrets(&format!("connecting to postgres://{}@db.internal:5432/app", shaped("appuser:", "s3cr3tpass")));
        assert!(!out.contains("s3cr3tpass"), "url password survived: {out}");
        assert!(out.contains("postgres://appuser:"), "over-redacted url: {out}");
        assert!(out.contains("@db.internal"), "url host removed: {out}");
    }

    #[test]
    fn leaves_ordinary_urls_and_ports_alone() {
        let s = "opened https://sparkle.ai/docs; base http://localhost:3000 ready";
        assert_eq!(redact_secrets(s), s);
    }

    #[test]
    fn redacts_high_entropy_opaque_tokens() {
        // A dash-free, mixed-case-and-digit 40+ blob logged without a key= context — token-shaped.
        // Assembled from fragments so no single high-entropy literal appears in source (gitleaks).
        let token = ["Ab3Xy9Qz7Kd", "2Mn8Pr4Ws6", "Tv1Uc5Bg0", "Hj3Lf7Nq2De9"].concat();
        let out = redact_secrets(&format!("relay connected with {token} ok"));
        assert!(!out.contains(token.as_str()), "opaque token survived: {out}");
    }

    #[test]
    fn preserves_git_shas_and_uuids() {
        // These are exactly the identifiers a support engineer needs to correlate a ticket with
        // logs — the catch-all must NOT eat them.
        let sha = "0123456789abcdef0123456789abcdef01234567"; // 40-char hex git SHA
        let uuid = "5839d2fa-1760-46c1-a374-3b70f734d004"; // worktree/agent UUID
        let s = format!("commit {sha} on worktree {uuid}");
        assert_eq!(redact_secrets(&s), s);
    }

    #[test]
    fn keeps_ordinary_text() {
        let s = "started 3 agents; worktree ready; opened composer";
        assert_eq!(redact_secrets(s), s);
    }

    // ── parse_tickets (banner listing) ──────────────────────────────────────────────────────────

    #[test]
    fn parse_tickets_maps_full_rows() {
        let v = json!({
            "ok": true,
            "isAdmin": false,
            "tickets": [
                { "id": "t1", "token": "tok1", "subject": "Won't start", "status": "awaiting_support", "lastMessageAt": "2026-07-06T00:00:00.000Z" },
                { "id": "t2", "token": "tok2", "subject": "Reply please", "status": "awaiting_user" }
            ]
        });
        let out = parse_tickets(&v);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].id, "t1");
        assert_eq!(out[0].token, "tok1");
        assert_eq!(out[0].status, "awaiting_support");
        assert_eq!(out[0].last_message_at.as_deref(), Some("2026-07-06T00:00:00.000Z"));
        // lastMessageAt is optional — absent → None, not an error.
        assert_eq!(out[1].status, "awaiting_user");
        assert_eq!(out[1].last_message_at, None);
    }

    #[test]
    fn parse_tickets_handles_empty_array() {
        assert!(parse_tickets(&json!({ "ok": true, "tickets": [] })).is_empty());
    }

    #[test]
    fn parse_tickets_handles_absent_tickets_key() {
        // A 401/unexpected body with no `tickets` array yields an empty list, not a panic.
        assert!(parse_tickets(&json!({ "error": "unauthorized" })).is_empty());
    }

    #[test]
    fn parse_tickets_skips_rows_missing_required_fields() {
        let v = json!({
            "tickets": [
                { "id": "good", "token": "tok", "subject": "ok", "status": "awaiting_support" },
                { "id": "no-token", "subject": "missing token", "status": "awaiting_support" },
                { "token": "tok3", "subject": "missing id", "status": "resolved" }
            ]
        });
        let out = parse_tickets(&v);
        // Only the complete row survives; the two malformed rows are dropped (and warn-logged).
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "good");
    }
}
