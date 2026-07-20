//! "Pull a project from GitHub" — the Rust/Tauri unit (design: docs/superpowers/specs/
//! 2026-07-09-github-pull-project-design.md, "Contract — Rust tauri commands (Unit C)").
//!
//! Three orchestration-backed reads/writes plus a secure clone:
//!   - `github_status`     → GET  /github/status      (is a GitHub account connected?)
//!   - `github_list_repos` → GET  /github/repos       (searchable, paginated repo list)
//!   - `github_clone_repo` → POST /github/clone-token  then `git clone` the repo
//!   - `github_default_project_dir` → `~/Sparkle` (the destination default)
//!
//! The orchestration calls reuse the existing bearer plumbing in `auth.rs`
//! (`bearer_token()` / `base_url()`); like the rest of this crate, ureq is pulled WITHOUT the
//! `json` feature, so request/response JSON is handled by hand with serde_json (send_string /
//! into_string). The clone models `sparkle_agent.rs`: `Command::new("git")` +
//! `apply_noninteractive()` + `tauri::async_runtime::spawn_blocking` for the (slow, blocking)
//! subprocess so the UI never freezes.
//!
//! SECURITY: the short-lived GitHub clone token never enters the remote URL (it would persist in
//! `.git/config`); it rides a one-shot `http.<host>.extraheader` instead, and both the raw token
//! and its base64 form are scrubbed from every surfaced error string.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::auth::{base_url, bearer_token};

/// Bound every orchestration call so a black-holed host can't freeze the calling thread — ureq has
/// no default request timeout. Mirrors auth.rs's HTTP_TIMEOUT.
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

/// Mirror sparkle_agent.rs / worktree.rs's non-interactive git env so a clone can never hang the UI
/// on a credential or host-key prompt. Auth for private repos is supplied out-of-band via the
/// one-shot `http.<host>.extraheader`, so a *further* interactive prompt only ever means "failed" —
/// fail fast rather than block forever waiting on a human who isn't there.
fn apply_noninteractive(cmd: &mut Command) {
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_ASKPASS", "true");
    cmd.env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes");
}

/// The stored desktop bearer, or a stable "not signed in" error. Every command needs it to reach
/// orchestration on the user's behalf.
fn bearer() -> Result<String, String> {
    bearer_token().ok_or_else(|| "not signed in".to_string())
}

// ---------------------------------------------------------------------------------------------
// github_status
// ---------------------------------------------------------------------------------------------

/// Is a GitHub account connected for this user, and if so under what login. `connected:false`
/// (with `login:null`) is a NORMAL state, not an error — the frontend renders a "Sign in with
/// GitHub" CTA for it.
#[derive(Serialize, Deserialize)]
pub struct GithubStatus {
    connected: bool,
    #[serde(default)]
    login: Option<String>,
}

/// GET orchestration `/github/status`. A `409 github_not_connected` (defensive — the contract says
/// this route returns a 200 `connected:false` rather than erroring) is normalized to the
/// not-connected state so the UI never sees a spurious failure.
///
/// `async` + `spawn_blocking`: ureq is synchronous and bounded by a 15s timeout, so a black-holed
/// host would otherwise pin a tokio worker thread for the whole timeout. Offload the blocking call.
#[tauri::command]
pub async fn github_status() -> Result<GithubStatus, String> {
    tauri::async_runtime::spawn_blocking(github_status_blocking)
        .await
        .map_err(|e| format!("status task failed to run: {e}"))?
}

fn github_status_blocking() -> Result<GithubStatus, String> {
    let token = bearer()?;
    let url = format!("{}/github/status", base_url());
    match ureq::get(&url)
        .timeout(HTTP_TIMEOUT)
        .set("Authorization", &format!("Bearer {token}"))
        .call()
    {
        Ok(resp) => {
            let text = resp.into_string().map_err(|e| e.to_string())?;
            serde_json::from_str(&text).map_err(|e| e.to_string())
        }
        Err(ureq::Error::Status(409, _)) => Ok(GithubStatus {
            connected: false,
            login: None,
        }),
        Err(e) => Err(format!("github status failed: {e}")),
    }
}

// ---------------------------------------------------------------------------------------------
// github_list_repos
// ---------------------------------------------------------------------------------------------

/// One repository row. `#[serde(rename_all = "camelCase")]` makes deserialization match the
/// orchestration response (`fullName`, `cloneUrl`, …) AND serialization hand the JS side the same
/// camelCase keys — so the two sides never drift.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    full_name: String,
    private: bool,
    #[serde(default)]
    description: Option<String>,
    default_branch: String,
    clone_url: String,
    pushed_at: String,
}

/// A page of repos plus whether another page exists (`hasMore` on the wire).
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoPage {
    repos: Vec<Repo>,
    has_more: bool,
}

/// Percent-encode a query value for the `?query=` param — anything outside the URL-unreserved set
/// is escaped byte-wise, matching auth.rs's `history_path` cursor handling.
fn encode_query(q: &str) -> String {
    let mut out = String::with_capacity(q.len());
    for b in q.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Build the `/github/repos` path+query (page always present; query omitted when empty). Pure +
/// unit-tested so the escaping can't silently regress.
fn repos_path(query: Option<&str>, page: u32) -> String {
    let mut path = format!("/github/repos?page={page}");
    if let Some(q) = query {
        if !q.is_empty() {
            path.push_str("&query=");
            path.push_str(&encode_query(q));
        }
    }
    path
}

/// GET orchestration `/github/repos`. `409 github_not_connected` becomes a stable
/// `github_not_connected` string the frontend can match to re-show the connect CTA. Blocking HTTP is
/// offloaded via `spawn_blocking` (see `github_status`).
#[tauri::command]
pub async fn github_list_repos(query: Option<String>, page: u32) -> Result<RepoPage, String> {
    tauri::async_runtime::spawn_blocking(move || github_list_repos_blocking(query, page))
        .await
        .map_err(|e| format!("repos task failed to run: {e}"))?
}

fn github_list_repos_blocking(query: Option<String>, page: u32) -> Result<RepoPage, String> {
    let token = bearer()?;
    let url = format!("{}{}", base_url(), repos_path(query.as_deref(), page));
    match ureq::get(&url)
        .timeout(HTTP_TIMEOUT)
        .set("Authorization", &format!("Bearer {token}"))
        .call()
    {
        Ok(resp) => {
            let text = resp.into_string().map_err(|e| e.to_string())?;
            serde_json::from_str(&text).map_err(|e| e.to_string())
        }
        Err(ureq::Error::Status(409, _)) => Err("github_not_connected".to_string()),
        Err(e) => Err(format!("github repos failed: {e}")),
    }
}

// ---------------------------------------------------------------------------------------------
// github_clone_repo
// ---------------------------------------------------------------------------------------------

/// Validate a clone destination: must be an absolute path, and if it already exists it must be an
/// empty directory (`git clone` accepts an existing empty dir but refuses a populated one). Returns
/// the path on success. Pure w.r.t. its own logic (only reads the filesystem) → hermetically
/// testable with a tempdir.
fn validate_dest(dest: &str) -> Result<PathBuf, String> {
    let path = Path::new(dest);
    if !path.is_absolute() {
        return Err("destination_not_absolute".to_string());
    }
    if path.exists() {
        if !path.is_dir() {
            // A regular file (or anything non-dir) at the target is "not empty" for our purposes.
            return Err("destination_not_empty".to_string());
        }
        let mut entries =
            std::fs::read_dir(path).map_err(|e| format!("couldn't read destination: {e}"))?;
        if entries.next().is_some() {
            return Err("destination_not_empty".to_string());
        }
    }
    Ok(path.to_path_buf())
}

/// Is the system `git` runnable? (`git --version` succeeds.) A fresh Mac without Xcode Command Line
/// Tools has no `git`; the frontend maps `git_missing` to the "Install Xcode CLT" prompt.
fn git_available() -> bool {
    Command::new(crate::preflight::git_program())
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Derive `owner/repo` from a clone URL. Handles `https://github.com/owner/repo.git`,
/// a trailing slash, and the scp-like `git@github.com:owner/repo.git` form by taking the last two
/// non-empty path segments after stripping the scheme/host and any `.git` suffix.
fn repo_full_name_from_clone_url(clone_url: &str) -> Result<String, String> {
    let s = clone_url.trim();
    let s = s.strip_suffix(".git").unwrap_or(s);
    // Strip scheme + host, leaving the path.
    let path = if let Some(idx) = s.find("://") {
        let after = &s[idx + 3..]; // "github.com/owner/repo"
        match after.find('/') {
            Some(p) => &after[p + 1..],
            None => return Err("invalid_clone_url".to_string()),
        }
    } else if let Some(idx) = s.find(':') {
        // scp-like: git@github.com:owner/repo
        &s[idx + 1..]
    } else {
        s
    };
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() < 2 {
        return Err("invalid_clone_url".to_string());
    }
    Ok(format!(
        "{}/{}",
        parts[parts.len() - 2],
        parts[parts.len() - 1]
    ))
}

/// We only support cloning from github.com over https: the repo list only ever yields such URLs, and
/// the auth header is scoped to `https://github.com/`. Reject anything else (an enterprise host, or
/// the scp-like `git@github.com:` form) rather than either cloning a private repo without the header
/// (a silent auth failure) or, for a different host, sending the token where it doesn't belong.
fn ensure_supported_clone_url(clone_url: &str) -> Result<(), String> {
    if clone_url.trim().starts_with("https://github.com/") {
        Ok(())
    } else {
        Err("unsupported_clone_url".to_string())
    }
}

/// Scrub the clone token (and its base64 form) from any string we might surface to the user or logs.
/// The token rides an HTTP header, so a verbose git failure could otherwise echo it back.
fn redact_secret(s: &str, token: &str, token_b64: &str) -> String {
    let mut out = s.to_string();
    if !token.is_empty() {
        out = out.replace(token, "<redacted>");
    }
    if !token_b64.is_empty() {
        out = out.replace(token_b64, "<redacted>");
    }
    out
}

/// The last `n` non-empty lines of a (possibly long) stderr blob, joined — a compact, human-useful
/// tail for an error message.
fn tail_lines(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().filter(|l| !l.trim().is_empty()).collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

/// Blocking clone worker (run inside `spawn_blocking`): create the destination's parent, then
/// `git clone --progress <url> <dest>` with the auth header injected via git's env-based config
/// (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0`, git ≥ 2.31) rather than a `-c` argv
/// — so the token appears neither on the command line (`ps`/`/proc`) nor in the remote URL (which
/// would persist it in `.git/config`). On failure the token-redacted stderr tail is returned.
fn run_clone(clone_url: &str, dest: &str, token: &str) -> Result<String, String> {
    let dest_path = Path::new(dest);
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("couldn't create destination parent: {e}"))?;
    }

    // Basic auth: base64("x-access-token:<token>"). GitHub accepts the OAuth token as the password
    // with the literal username "x-access-token".
    let token_b64 = STANDARD.encode(format!("x-access-token:{token}").as_bytes());
    let header = format!("Authorization: Basic {token_b64}");

    let mut cmd = Command::new(crate::preflight::git_program());
    cmd.args(["clone", "--progress"]).arg(clone_url).arg(dest);
    apply_noninteractive(&mut cmd);
    // Feed the auth header via git's env-based config rather than `-c ...=<header>` on the command
    // line: argv is world-readable via `ps`/`/proc/<pid>/cmdline`, so a `-c` arg would expose the
    // (short-lived) token to any local process for the duration of the clone. `GIT_CONFIG_COUNT` +
    // KEY/VALUE pairs inject the same one-shot config with the secret confined to the child's env.
    cmd.env("GIT_CONFIG_COUNT", "1");
    cmd.env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader");
    cmd.env("GIT_CONFIG_VALUE_0", &header);

    let out = cmd
        .output()
        .map_err(|e| format!("failed to run git clone: {e}"))?;
    if out.status.success() {
        // dest was validated absolute; return it verbatim.
        return Ok(dest.to_string());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let tail = tail_lines(&stderr, 20);
    Err(redact_secret(&tail, token, &token_b64))
}

/// POST orchestration `/github/clone-token { repoFullName }` → the short-lived GitHub token to clone
/// with. `409 github_not_connected` becomes a stable string; the token is NEVER logged.
fn fetch_clone_token(repo_full_name: &str) -> Result<String, String> {
    let token = bearer()?;
    let url = format!("{}/github/clone-token", base_url());
    let body = json!({ "repoFullName": repo_full_name }).to_string();
    match ureq::post(&url)
        .timeout(HTTP_TIMEOUT)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json")
        .send_string(&body)
    {
        Ok(resp) => {
            let text = resp.into_string().map_err(|e| e.to_string())?;
            let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            v.get("token")
                .and_then(|t| t.as_str())
                .map(|s| s.to_string())
                .ok_or_else(|| "clone-token response missing token".to_string())
        }
        Err(ureq::Error::Status(409, _)) => Err("github_not_connected".to_string()),
        Err(e) => Err(format!("clone-token failed: {e}")),
    }
}

/// Clone a GitHub repo into a new (empty/absent) destination directory. Steps (per the Unit C
/// contract): validate dest → ensure `git` → fetch a short-lived clone token → `git clone` with the
/// token in a one-shot header (never the URL) inside `spawn_blocking`. Returns the absolute dest on
/// success; on failure the token-redacted stderr tail.
///
/// `async` + `spawn_blocking`: the clone is a multi-second network op that must not run on the main
/// thread (it would freeze the window). The cheap, synchronous checks (`validate_dest`,
/// `ensure_supported_clone_url`, `git_available`) run first so a bad dest or unsupported URL fails
/// immediately; the token fetch (blocking HTTP) then runs INSIDE `spawn_blocking`, just before the
/// clone, so it never pins a tokio worker thread either.
#[tauri::command]
pub async fn github_clone_repo(clone_url: String, dest: String) -> Result<String, String> {
    // Trim once at the entry so the host guard, name derivation, and the actual clone all operate on
    // the exact same value (no chance of whitespace passing the guard but reaching `git clone` raw).
    let clone_url = clone_url.trim().to_string();
    // 1. dest validation (absolute, empty-or-absent) — cheap, fail fast.
    validate_dest(&dest)?;
    // 2. only https://github.com/ clone URLs are supported (the auth header is scoped to that host).
    ensure_supported_clone_url(&clone_url)?;
    // 3. git availability — the frontend maps `git_missing` to the Xcode CLT prompt.
    if !git_available() {
        return Err("git_missing".to_string());
    }
    // 4. derive owner/repo, then fetch the token AND clone off the main thread. Both the token fetch
    //    (blocking HTTP) and the clone (multi-second subprocess) run inside spawn_blocking so neither
    //    freezes the window nor pins a tokio worker thread.
    let repo_full_name = repo_full_name_from_clone_url(&clone_url)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let token = fetch_clone_token(&repo_full_name)?;
        run_clone(&clone_url, &dest, &token)
    })
    .await
    .map_err(|e| format!("clone task failed to run: {e}"))?;
    result.inspect_err(|e| tracing::warn!(error = %e, "github_clone_repo failed"))
}

// ---------------------------------------------------------------------------------------------
// github_default_project_dir
// ---------------------------------------------------------------------------------------------

/// The default clone destination root: `~/Sparkle`, created if missing. (`<repo>` is appended by
/// the frontend.) Mirrors how the rest of the crate resolves HOME (`std::env::var_os("HOME")`)
/// rather than pulling in a directories crate.
#[tauri::command]
pub fn github_default_project_dir() -> Result<String, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "no home directory".to_string())?;
    let dir = Path::new(&home).join("Sparkle");
    std::fs::create_dir_all(&dir).map_err(|e| format!("couldn't create ~/Sparkle: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- dest validation -----------------------------------------------------------------------

    #[test]
    fn validate_dest_requires_absolute_path() {
        let err = validate_dest("relative/path").unwrap_err();
        assert_eq!(err, "destination_not_absolute");
    }

    #[test]
    fn validate_dest_accepts_absent_absolute_path() {
        let base = tempfile::tempdir().unwrap();
        let dest = base.path().join("brand-new-repo");
        // The final dir does not exist yet — git will create it. This must be allowed.
        let ok = validate_dest(dest.to_str().unwrap()).unwrap();
        assert_eq!(ok, dest);
    }

    #[test]
    fn validate_dest_accepts_existing_empty_dir() {
        let base = tempfile::tempdir().unwrap();
        let dest = base.path().join("empty");
        std::fs::create_dir(&dest).unwrap();
        assert!(validate_dest(dest.to_str().unwrap()).is_ok());
    }

    #[test]
    fn validate_dest_rejects_non_empty_dir() {
        let base = tempfile::tempdir().unwrap();
        let dest = base.path().join("full");
        std::fs::create_dir(&dest).unwrap();
        std::fs::write(dest.join("a.txt"), b"x").unwrap();
        let err = validate_dest(dest.to_str().unwrap()).unwrap_err();
        assert_eq!(err, "destination_not_empty");
    }

    #[test]
    fn validate_dest_rejects_existing_file() {
        let base = tempfile::tempdir().unwrap();
        let dest = base.path().join("afile");
        std::fs::write(&dest, b"x").unwrap();
        let err = validate_dest(dest.to_str().unwrap()).unwrap_err();
        assert_eq!(err, "destination_not_empty");
    }

    // -- token redaction -----------------------------------------------------------------------

    #[test]
    fn redact_secret_scrubs_token_and_its_base64_form() {
        // Simulate the exact surfaces a leak could ride: the raw token AND the base64 header value.
        let token = "gho_supersecrettoken1234567890";
        let token_b64 = STANDARD.encode(format!("x-access-token:{token}").as_bytes());
        let leaky = format!(
            "fatal: unable to access 'https://github.com/o/r.git/': tried Authorization: Basic {token_b64} \
             and also the raw {token} somehow"
        );
        let cleaned = redact_secret(&leaky, token, &token_b64);
        assert!(!cleaned.contains(token), "raw token must not survive redaction");
        assert!(
            !cleaned.contains(&token_b64),
            "base64 token must not survive redaction"
        );
        assert!(cleaned.contains("<redacted>"));
    }

    #[test]
    fn run_clone_error_never_leaks_the_token() {
        // End-to-end proof through the real clone path: a bogus clone URL makes `git clone` fail,
        // and the returned Err (its stderr tail) must contain neither the token nor its base64 form.
        // Skip if git isn't installed on the CI box (nothing to exercise then).
        if !git_available() {
            return;
        }
        let token = "gho_endtoendsecrettoken0987654321";
        let token_b64 = STANDARD.encode(format!("x-access-token:{token}").as_bytes());
        let base = tempfile::tempdir().unwrap();
        let dest = base.path().join("wont-clone");
        // Hermetic: a `file://` path to a non-existent repo makes `git clone` fail fast with no
        // network or DNS (the http auth header is simply unused). We only care that the error path
        // redacts the token, not how the clone failed.
        let missing = base.path().join("no-such-repo.git");
        let err = run_clone(
            &format!("file://{}", missing.to_str().unwrap()),
            dest.to_str().unwrap(),
            token,
        )
        .unwrap_err();
        assert!(!err.contains(token), "token leaked into clone error: {err}");
        assert!(
            !err.contains(&token_b64),
            "base64 token leaked into clone error: {err}"
        );
    }

    // -- clone-url → owner/repo ----------------------------------------------------------------

    #[test]
    fn repo_full_name_parses_https_clone_url() {
        assert_eq!(
            repo_full_name_from_clone_url("https://github.com/octocat/hello.git").unwrap(),
            "octocat/hello"
        );
    }

    #[test]
    fn repo_full_name_parses_without_git_suffix_or_trailing_slash() {
        assert_eq!(
            repo_full_name_from_clone_url("https://github.com/octocat/hello").unwrap(),
            "octocat/hello"
        );
        assert_eq!(
            repo_full_name_from_clone_url("https://github.com/octocat/hello/").unwrap(),
            "octocat/hello"
        );
    }

    #[test]
    fn repo_full_name_parses_scp_like_url() {
        assert_eq!(
            repo_full_name_from_clone_url("git@github.com:octocat/hello.git").unwrap(),
            "octocat/hello"
        );
    }

    #[test]
    fn repo_full_name_rejects_urls_without_owner_and_repo() {
        assert!(repo_full_name_from_clone_url("https://github.com/only-owner").is_err());
        assert!(repo_full_name_from_clone_url("https://github.com/").is_err());
    }

    // -- clone-url host guard ------------------------------------------------------------------

    #[test]
    fn ensure_supported_clone_url_accepts_only_https_github() {
        assert!(ensure_supported_clone_url("https://github.com/octocat/hello.git").is_ok());
        // scp-like, enterprise host, or plain http are all rejected.
        assert!(ensure_supported_clone_url("git@github.com:octocat/hello.git").is_err());
        assert!(ensure_supported_clone_url("https://ghe.example.com/o/r.git").is_err());
        assert!(ensure_supported_clone_url("http://github.com/o/r.git").is_err());
    }

    // -- response deserialization (camelCase drift guard) --------------------------------------

    #[test]
    fn repo_page_deserializes_camelcase_payload() {
        // Locks the on-the-wire contract with Unit B: if either side renames a field, this fails.
        let payload = r#"{"repos":[{"fullName":"octocat/hello","private":true,"description":null,
            "defaultBranch":"main","cloneUrl":"https://github.com/octocat/hello.git",
            "pushedAt":"2026-07-01T12:00:00Z"}],"hasMore":true}"#;
        let page: RepoPage = serde_json::from_str(payload).unwrap();
        assert!(page.has_more);
        assert_eq!(page.repos.len(), 1);
        let r = &page.repos[0];
        assert_eq!(r.full_name, "octocat/hello");
        assert!(r.private);
        assert!(r.description.is_none());
        assert_eq!(r.default_branch, "main");
        assert_eq!(r.clone_url, "https://github.com/octocat/hello.git");
        assert_eq!(r.pushed_at, "2026-07-01T12:00:00Z");
    }

    #[test]
    fn github_status_deserializes_camelcase_payload() {
        let s: GithubStatus =
            serde_json::from_str(r#"{"connected":true,"login":"octocat"}"#).unwrap();
        assert!(s.connected);
        assert_eq!(s.login.as_deref(), Some("octocat"));
        // login omitted → connected:false, login:None (the normal "not connected" shape).
        let s2: GithubStatus = serde_json::from_str(r#"{"connected":false}"#).unwrap();
        assert!(!s2.connected);
        assert!(s2.login.is_none());
    }

    // -- repos path builder --------------------------------------------------------------------

    #[test]
    fn repos_path_omits_query_when_absent_or_empty() {
        assert_eq!(repos_path(None, 1), "/github/repos?page=1");
        assert_eq!(repos_path(Some(""), 2), "/github/repos?page=2");
    }

    #[test]
    fn repos_path_percent_encodes_query() {
        assert_eq!(
            repos_path(Some("my repo/foo"), 1),
            "/github/repos?page=1&query=my%20repo%2Ffoo"
        );
    }

    // -- tail_lines ----------------------------------------------------------------------------

    #[test]
    fn tail_lines_keeps_last_n_nonblank_lines() {
        let blob = "a\n\nb\nc\n\nd\n";
        assert_eq!(tail_lines(blob, 2), "c\nd");
        assert_eq!(tail_lines(blob, 10), "a\nb\nc\nd");
    }
}
