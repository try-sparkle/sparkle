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
use std::time::Duration;

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
    // Compiled per-call: redaction runs at most once per "open ticket" click, so the cost is
    // irrelevant and we avoid pulling in a lazy-init crate. Each `Regex::new` here is over a
    // static, known-valid pattern, so `.unwrap()` cannot fire in practice — but we fall back to
    // the identity transform on the impossible error rather than panicking on a debug log.
    fn sub(re: &str, rep: &str, s: &str) -> String {
        match regex::Regex::new(re) {
            Ok(r) => r.replace_all(s, rep).into_owned(),
            Err(_) => s.to_string(),
        }
    }

    let mut out = input.to_string();
    // JWTs first (three base64url segments).
    out = sub(r"eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}", REDACTED, &out);
    // `Authorization: <value>` / `Authorization = <value>` — consume an optional AUTH SCHEME word
    // (Bearer / Basic / Digest / Negotiate / …) plus the credential token, but STOP at whitespace so
    // trailing correlation fields on the same line (`… requestId=abc worktree=<uuid>`) are preserved.
    // The scheme is `\w+\s+` (not just `Bearer`) so a non-Bearer scheme's credential can't leak as a
    // separate token. Runs BEFORE the Bearer rule and swallows the whole `<scheme> <token>`.
    out = sub(
        r"(?i)\bAuthorization\b\s*[:=]\s*(?:\w+\s+)?[^\s,]+",
        "Authorization: «redacted»",
        &out,
    );
    // Standalone `Bearer <token>` (keep the scheme word so the log still reads sensibly).
    out = sub(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+", "Bearer «redacted»", &out);
    // Provider secret keys.
    out = sub(r"(?i)sk-[A-Za-z0-9_-]{16,}", REDACTED, &out);
    // Secret assignments: NAME_(API|API_KEY|TOKEN|SECRET|PASSWORD|KEY) = value. Handles bare, quoted,
    // AND JSON shapes — `KEY=v`, `key: "v"`, `"apiKey":"v"` — by allowing optional quotes around the
    // name and an optional opening quote on the value (kept in the capture so it reads sensibly). The
    // value stops at whitespace/quote/comma/brace so we redact just the secret, not the rest of a line.
    out = sub(
        r#"(?i)("?[A-Z0-9_]*(?:API(?:_KEY)?|TOKEN|SECRET|PASSWORD|KEY)"?\s*[:=]\s*"?)[^\s"',}]+"#,
        "$1«redacted»",
        &out,
    );
    // Credentials embedded in a URL userinfo: `scheme://user:secret@host` → keep everything up to and
    // including `user:`, redact the password, keep `@host`. (A URL with no `user:…@` won't match, so
    // ordinary links and `host:port` are untouched.)
    out = sub(
        r"(?i)([a-z][a-z0-9+.-]*://[^\s:/@]+:)[^\s@/]+@",
        "$1«redacted»@",
        &out,
    );
    // Leftover high-entropy blobs (unlabeled tokens with no `key=`/`Bearer`/`sk-` context). A closure
    // decides per-match so we PRESERVE the identifiers a human needs while still catching secret
    // shapes. We redact a dash-free, letters-AND-digits run of 40+ — which covers mixed-case,
    // single-case (`ABCD12…`), and off-length hex tokens — but KEEP:
    //   - dashed forms (UUID worktree/agent ids),
    //   - canonical git-object hashes: exactly 40- or 64-char hex (SHA-1 / SHA-256),
    //   - pure-digit or pure-letter runs (not token-shaped).
    // Base64 tokens containing `+`/`/`/`=` are only partially covered (those chars split the run);
    // in practice such secrets arrive labeled (JWT/Bearer/`sk-`/env), which the rules above catch.
    out = match regex::Regex::new(r"[A-Za-z0-9_-]{40,}") {
        Ok(r) => r
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
            .into_owned(),
        Err(_) => out,
    };
    out
}

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
#[tauri::command]
pub fn read_recent_logs<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let dir = resolve_log_dir(&app)?;

    let mut rotated: Vec<String> = Vec::new();
    let mut has_current = false;
    if let Ok(entries) = std::fs::read_dir(&dir) {
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
#[tauri::command]
pub fn support_chat_send(messages: Vec<ChatMsg>) -> Result<ChatResp, String> {
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
#[tauri::command]
pub fn desktop_create_ticket(payload: CreateTicketPayload) -> Result<CreatedTicket, String> {
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
#[tauri::command]
pub fn desktop_list_tickets() -> Result<Vec<TicketStatus>, String> {
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

    // The GET route returns EVERY ticket (not just the caller's own) when the signed-in user is the
    // super admin (`isAdmin: true`). This banner is the personal "your open tickets" view, so for an
    // admin it would surface the whole support queue with inverted attention semantics (an admin's
    // actionable tickets are `awaiting_support`, not `awaiting_user`). Suppress it for admins — they
    // use the /admin support console instead (design spec §2).
    if v.get("isAdmin").and_then(|a| a.as_bool()).unwrap_or(false) {
        return Ok(Vec::new());
    }
    Ok(parse_tickets(&v))
}

#[cfg(test)]
mod tests {
    use super::*;

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
