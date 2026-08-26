//! TICKET-SYSTEM INTAKE — "paste tickets, fan out" as the front door (bead `.6`).
//!
//! Sparkle's intake today is free-form text: a prompt box, or Brainstorm. For a team that lives in
//! Linear or Jira, the ticket IS the unit of work — its title, its description, its comments, and
//! (the part that is hardest to move by hand) its SCREENSHOTS. This module turns a paste of ticket
//! references into structured work items an agent can be dispatched from.
//!
//! ## This is EXTERNAL-tracker intake. Beads is still the task graph.
//!
//! The boundary matters and is stated in full in `PRD/ticket-system-intake.md`. Beads (`bd`) is
//! Sparkle's own work graph — what is ready, what is blocked, what depends on what — and nothing
//! here replaces it. This module READS an external tracker (and, as one more provider, reads a bead
//! by id) and hands back a normalized [`IntakedTicket`]. Whether that becomes a bead, a worker, or
//! both is a decision made by the caller, not here.
//!
//! ## OPTIONAL BY DESIGN — it must degrade cleanly with nothing configured
//!
//! `[ticket_intake].enabled` ships FALSE, every provider is independently switchable, and the
//! parser — the load-bearing half — needs no credential at all. A user with no Linear key can still
//! paste `ENG-1234` and get a branch name, a commit prefix and a PR title back. Fetching is the
//! part that needs a secret, and a provider with no secret says so in one sentence rather than
//! failing the whole batch.
//!
//! ## AMBIGUITY IS REPORTED, NEVER GUESSED
//!
//! `ENG-1234` is a valid Linear key AND a valid Jira key; nothing in the string distinguishes them.
//! A parser that silently picks one sends the agent to the wrong tracker and reports success. So a
//! bare key resolves to the configured `default_provider` — WITH a note saying that is where the
//! answer came from — and, when no default is configured, is returned as `ambiguous` with the
//! candidate list. The UI's job is to ask; this module's job is never to pretend.
//!
//! ## IMAGES ARE DOWNLOADED IMMEDIATELY, AND FAILURES ARE COUNTED
//!
//! Linear's attachment links expire in about five minutes. A URL stored now and fetched when the
//! agent gets around to it is a dead URL, so [`fetch_one`] downloads every referenced image during
//! the fetch, content-addresses it by SHA-256 and returns the local path. A download that failed is
//! recorded as a row with `ok: false` rather than dropped — "this ticket had 3 images, 1 could not
//! be fetched" is a sentence the UI can say; a silently shortened list is not.
//!
//! ## CREDENTIALS ARE NEVER LOGGED OR SERIALIZED
//!
//! [`Secret`] redacts itself in `Debug` and in `Serialize`. That is not decoration: `SparkleConfig`
//! derives `Serialize` and is handed to the webview, so a bare `String` here would ship the user's
//! Linear API key into the frontend on every config read. `secret_is_redacted_in_debug_and_json`
//! pins it.
//!
//! ## THE IO SEAM
//!
//! Every network call, every subprocess and every 1Password read goes through [`IntakeIo`], so the
//! provider tests need no network and no credentials. [`default_io`] supplies the real one — and it
//! is covered by a test (`default_io_runs_a_real_command`), because a seam every test injects
//! around leaves the line that supplies the REAL client covered by nothing (bead `sparkle-lgbwf`).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Where downloaded attachments land, relative to the project root. Keep in step with
/// `TicketIntakeConfig`'s default in `config.rs`.
pub const DEFAULT_IMAGE_DIR: &str = ".sparkle/ticket-attachments";

/// Default `branch_template`. `{slug}` is empty until a title has been fetched, and the trailing
/// separator is trimmed, so a parse-only run still yields a usable `eng-1234`.
pub const DEFAULT_BRANCH_TEMPLATE: &str = "{key_lower}-{slug}";

/// Default `commit_prefix_template` — the Linear/Jira convention both hand-rolled dispatchers this
/// bead came from used: the key, a colon, then the subject.
pub const DEFAULT_COMMIT_PREFIX_TEMPLATE: &str = "{key}:";

/// Wall-clock bound handed to `scripts/timeout.sh` for a `bd` call. A `bd` call that prints nothing
/// is usually QUEUED behind the shared Dolt store lock rather than wedged, so this is generous.
pub const BD_TIMEOUT_SECS: u64 = 60;

/// Bound on one HTTP call (ticket fetch or image download).
pub const HTTP_TIMEOUT_SECS: u64 = 30;

/// What a redacted [`Secret`] renders as, everywhere. One constant so the `Debug` path and the
/// `Serialize` path cannot drift onto different spellings — a test greps for this.
pub const REDACTED: &str = "<redacted>";

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Secret
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// An API token, or an `op://vault/item/field` reference to one.
///
/// REDACTS ITSELF IN BOTH DIRECTIONS a credential normally escapes by: `Debug` (which is what a
/// `tracing` line or a panic message prints) and `Serialize` (which is what `config_get` hands the
/// webview). The only way to read the real value is [`Secret::expose`], which is deliberately ugly
/// to type and appears in exactly two places: the 1Password resolve and the request-header build.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into().trim().to_string())
    }

    /// The real bytes. Call sites are auditable by grepping for this name.
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Is this an indirection into 1Password rather than the credential itself?
    pub fn is_op_reference(&self) -> bool {
        self.0.starts_with("op://")
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.0.is_empty() {
            write!(f, "Secret(<unset>)")
        } else {
            write!(f, "Secret({REDACTED})")
        }
    }
}

impl Serialize for Secret {
    /// An EMPTY secret serializes as empty, a set one as [`REDACTED`]. The distinction is the
    /// entire point of the field on the wire: the UI must be able to say "no Linear key is
    /// configured" versus "a key is configured, and you cannot read it from here".
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(if self.0.is_empty() { "" } else { REDACTED })
    }
}

impl<'de> Deserialize<'de> for Secret {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Ok(Secret::new(s))
    }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// Which tracker a reference points at.
///
/// `Github` (not `GitHub`) so `rename_all = "snake_case"` emits `github` rather than `git_hub` —
/// the wire string is read by the TypeScript union in `ticketIntakeStore.ts` and by config TOML.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Linear,
    Jira,
    Github,
    Beads,
}

impl Provider {
    /// Human-facing name, for a sentence a person reads. Not `Debug`.
    pub fn label(self) -> &'static str {
        match self {
            Provider::Linear => "Linear",
            Provider::Jira => "Jira",
            Provider::Github => "GitHub",
            Provider::Beads => "beads",
        }
    }

    /// The config/wire spelling. One place, so TOML parsing and serde cannot drift.
    pub fn slug(self) -> &'static str {
        match self {
            Provider::Linear => "linear",
            Provider::Jira => "jira",
            Provider::Github => "github",
            Provider::Beads => "beads",
        }
    }

    pub fn from_slug(s: &str) -> Option<Provider> {
        match s.trim().to_ascii_lowercase().as_str() {
            "linear" => Some(Provider::Linear),
            "jira" => Some(Provider::Jira),
            "github" | "gh" => Some(Provider::Github),
            "beads" | "bd" => Some(Provider::Beads),
            _ => None,
        }
    }
}

/// One parsed reference and everything derivable from it WITHOUT a network call.
///
/// `provider` is `None` exactly when `ambiguous` is true — the shape a bare `ENG-1234` takes when
/// no `default_provider` is configured. It crosses the wire as an explicit `null`, so the
/// TypeScript mirror is `provider?: Provider | null`; see the header of `ticketIntakeStore.ts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketRef {
    /// The exact text that matched, so the UI can show what it read.
    pub raw: String,
    /// `None` when ambiguous — never a guess.
    pub provider: Option<Provider>,
    /// Non-empty only when `ambiguous`: the providers this could be.
    pub candidates: Vec<Provider>,
    pub ambiguous: bool,
    /// The canonical key: `ENG-1234`, `owner/repo#123`, `.6`.
    pub key: String,
    /// The URL it came from, when it came from one.
    pub url: Option<String>,
    pub branch: String,
    pub commit_prefix: String,
    pub pr_title: String,
    /// Why this is ambiguous, or where a non-obvious answer came from (e.g. the configured
    /// default). `None` when there is nothing to explain.
    pub note: Option<String>,
}

/// One image that was referenced by a ticket.
///
/// A FAILED download is a ROW, not an omission. `ok: false` with a reason is what lets the UI say
/// "3 images, 1 could not be fetched"; dropping it would show 2 and claim that was all there was.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntakedImage {
    pub source_url: String,
    /// `None` when the download failed.
    pub local_path: Option<String>,
    pub ok: bool,
    /// `None` when it succeeded.
    pub error: Option<String>,
    pub bytes: u64,
    /// The stored file's media type, e.g. `image/png`, or `application/octet-stream` when it could
    /// not be named.
    ///
    /// THE UI READS THIS BEFORE IT PAINTS AN `<img>`. A ticket can attach a `log.txt` or a PDF, and
    /// rendering one as an image paints a broken glyph on a row marked `ok: true` with a byte count
    /// and no reason — exactly the "a good download is indistinguishable from a dead one" failure
    /// the `data:` URL work exists to close. Empty string when the download failed.
    pub mime: String,
}

/// A ticket, fetched and normalized. The shape every provider collapses to.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntakedTicket {
    pub provider: Provider,
    pub key: String,
    pub title: String,
    pub body: String,
    pub comments: Vec<String>,
    pub images: Vec<IntakedImage>,
    pub branch: String,
    pub commit_prefix: String,
    pub pr_title: String,
    /// `null` when the reference was not a URL and the provider does not synthesize one.
    pub url: Option<String>,
}

/// One image a ticket refers to, before it is downloaded.
///
/// CARRIES THE FILE NAME, and that is not decoration: a Jira attachment is served from
/// `/rest/api/3/attachment/content/10021`, which has NO extension, so a type derived from the URL
/// alone is `application/octet-stream` for every Jira screenshot — and by `mime_for`'s own rule an
/// `<img>` given the wrong type renders nothing. The tracker knows the file as `shot.png`; that is
/// the name to store it under.
#[derive(Debug, Clone, PartialEq)]
pub struct ImageRef {
    pub url: String,
    /// The tracker's own name for the file, when it has one.
    pub file_name: Option<String>,
    /// The tracker's own claim about the type (Jira's `mimeType`), when it makes one.
    ///
    /// IT MAY ONLY DECLINE, NEVER CERTIFY. A claim of `text/plain` is enough to refuse the row
    /// WITHOUT spending a request — the point of asking — but a claim of `image/png` still gets
    /// sniffed, because a claim is not the bytes.
    pub declared_mime: Option<String>,
}

impl ImageRef {
    pub fn bare(url: impl Into<String>) -> Self {
        Self { url: url.into(), file_name: None, declared_mime: None }
    }

    /// Named, but with no type claim — a markdown image, or an attachment whose metadata says
    /// nothing about what it is.
    pub fn named(url: impl Into<String>, file_name: Option<String>) -> Self {
        Self { url: url.into(), file_name, declared_mime: None }
    }

    /// What to call this in a message: the tracker's name for it, else the URL.
    pub fn label(&self) -> String {
        self.file_name.clone().unwrap_or_else(|| self.url.clone())
    }
}

/// What a provider returns before images are downloaded and the naming is derived.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RawTicket {
    pub title: String,
    pub body: String,
    pub comments: Vec<String>,
    pub images: Vec<ImageRef>,
    pub url: Option<String>,
}

/// One reference the batch could not intake, and why.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefFailure {
    pub raw: String,
    pub key: String,
    /// `None` when the reference was ambiguous — there is no provider to name.
    pub provider: Option<Provider>,
    pub error: String,
}

/// A batch intake. PER-REF outcomes, never an all-or-nothing result: one dead Jira ticket must not
/// throw away four Linear ones that fetched fine.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub tickets: Vec<IntakedTicket>,
    pub failures: Vec<RefFailure>,
}

/// One provider's readiness, with NO credential in it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: Provider,
    pub enabled: bool,
    /// Does this provider have what it needs to make a call at all?
    pub configured: bool,
    /// One sentence for a person: what is missing, or how the credential is supplied.
    pub note: String,
}

/// The cheap poll: is intake on, which providers can be used, and where images land.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketIntakeStatus {
    pub enabled: bool,
    /// `null` when no default is configured — which is what makes a bare key ambiguous.
    pub default_provider: Option<Provider>,
    pub providers: Vec<ProviderStatus>,
    pub image_dir: String,
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Settings
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// One provider's settings. Mirrors `config::TicketProviderConfig`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ProviderSettings {
    pub enabled: bool,
    pub base_url: String,
    pub api_key: Secret,
}

/// This module's own settings struct.
///
/// TWO STRUCTS ON PURPOSE, the same seam `verify_gate::GateSettings` uses and for the same reason:
/// this module must be unit-testable without building a whole `SparkleConfig`, and `config.rs` must
/// not depend on the module it configures. `TicketIntakeConfig::to_intake_settings` is the one
/// crossing, so a field added on one side and forgotten on the other fails to compile there.
#[derive(Debug, Clone, PartialEq)]
pub struct IntakeSettings {
    pub enabled: bool,
    pub default_provider: Option<Provider>,
    pub linear: ProviderSettings,
    pub jira: ProviderSettings,
    pub github: ProviderSettings,
    pub beads: ProviderSettings,
    pub branch_template: String,
    pub commit_prefix_template: String,
    pub image_dir: String,
    /// The bead id PREFIXES this project uses, e.g. `["sparkle"]`.
    ///
    /// NOT a config key — discovered from the project's own `.beads/` files by
    /// [`beads_prefixes_for`], because it is a fact about the repo rather than a preference. It
    /// exists because `sparkle-jehei` and `well-known` are the SAME SHAPE, and a parser with no
    /// prefix has to fall back to a conservative rule that misses the plain-letter ids. Knowing
    /// the prefix makes beads recognition exact. See [`is_beads_id`].
    pub beads_prefixes: Vec<String>,
}

impl Default for IntakeSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            default_provider: None,
            linear: ProviderSettings { enabled: true, base_url: String::new(), ..Default::default() },
            jira: ProviderSettings { enabled: true, base_url: String::new(), ..Default::default() },
            // GitHub and beads need no API key — they shell out to `gh` and `bd`, which carry
            // their own auth. So they are usable the moment intake is switched on.
            github: ProviderSettings { enabled: true, ..Default::default() },
            beads: ProviderSettings { enabled: true, ..Default::default() },
            branch_template: DEFAULT_BRANCH_TEMPLATE.to_string(),
            commit_prefix_template: DEFAULT_COMMIT_PREFIX_TEMPLATE.to_string(),
            image_dir: DEFAULT_IMAGE_DIR.to_string(),
            beads_prefixes: Vec::new(),
        }
    }
}

impl IntakeSettings {
    pub fn provider_settings(&self, p: Provider) -> &ProviderSettings {
        match p {
            Provider::Linear => &self.linear,
            Provider::Jira => &self.jira,
            Provider::Github => &self.github,
            Provider::Beads => &self.beads,
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The IO seam
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// Everything that touches the world outside this process.
///
/// One trait rather than three so a test supplies ONE fake and covers the GraphQL call, the `gh`
/// subprocess, the `bd` subprocess, the image download and the 1Password read together.
pub trait IntakeIo: Send + Sync {
    /// `GET url` with headers, expecting text. `Err` carries a sentence a person can read.
    fn http_get(&self, url: &str, headers: &[(String, String)]) -> Result<String, String>;
    /// `POST url` with headers and a JSON body, expecting text.
    fn http_post(
        &self,
        url: &str,
        headers: &[(String, String)],
        body: &str,
    ) -> Result<String, String>;
    /// `GET url` expecting bytes — the image path.
    ///
    /// TAKES HEADERS, and that is not symmetry for its own sake: a tracker's attachment endpoint
    /// wants the SAME credential the ticket fetch just used. Jira Cloud serves an attachment from
    /// `/rest/api/3/attachment/content/<id>`, which answers 401 unauthenticated, and Linear's
    /// asset host is no more public. A byte fetch with no header slot makes every screenshot an
    /// `ok: false` row — the feature's headline capability, failing quietly and by construction.
    fn http_get_bytes(&self, url: &str, headers: &[(String, String)]) -> Result<Vec<u8>, String>;
    /// Run a command, returning stdout. `Err` on a non-zero exit, carrying stderr.
    fn run(&self, program: &str, args: &[String], cwd: Option<&Path>) -> Result<String, String>;
    /// Resolve an `op://vault/item/field` reference through the 1Password CLI.
    fn op_read(&self, reference: &str) -> Result<String, String>;
}

/// The real one.
struct RealIo;

fn ureq_agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(HTTP_TIMEOUT_SECS))
            .build()
    })
}

fn ureq_err(url: &str, e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, _) => format!("{url} answered HTTP {code}"),
        ureq::Error::Transport(t) => format!("could not reach {url}: {t}"),
    }
}

impl IntakeIo for RealIo {
    fn http_get(&self, url: &str, headers: &[(String, String)]) -> Result<String, String> {
        let mut req = ureq_agent().get(url);
        for (k, v) in headers {
            req = req.set(k, v);
        }
        req.call()
            .map_err(|e| ureq_err(url, e))?
            .into_string()
            .map_err(|e| format!("could not read the response from {url}: {e}"))
    }

    fn http_post(
        &self,
        url: &str,
        headers: &[(String, String)],
        body: &str,
    ) -> Result<String, String> {
        let mut req = ureq_agent().post(url);
        for (k, v) in headers {
            req = req.set(k, v);
        }
        req.send_string(body)
            .map_err(|e| ureq_err(url, e))?
            .into_string()
            .map_err(|e| format!("could not read the response from {url}: {e}"))
    }

    fn http_get_bytes(&self, url: &str, headers: &[(String, String)]) -> Result<Vec<u8>, String> {
        let mut req = ureq_agent().get(url);
        for (k, v) in headers {
            req = req.set(k, v);
        }
        let resp = req.call().map_err(|e| ureq_err(url, e))?;
        let mut buf = Vec::new();
        // BOUNDED: a `Content-Length` is a claim, not a fact, so the cap is applied to the READER.
        // One byte over the limit is enough to detect it; `download_images` turns that into a
        // refused row rather than a renderer OOM.
        std::io::Read::read_to_end(
            &mut std::io::Read::take(resp.into_reader(), (MAX_IMAGE_BYTES + 1) as u64),
            &mut buf,
        )
        .map_err(|e| format!("could not download {url}: {e}"))?;
        Ok(buf)
    }

    fn run(&self, program: &str, args: &[String], cwd: Option<&Path>) -> Result<String, String> {
        let mut cmd = std::process::Command::new(program);
        cmd.args(args).stdin(std::process::Stdio::null());
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        let out = cmd.output().map_err(|e| format!("could not run {program}: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let code = out.status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into());
            return Err(format!("{program} exited {code}: {stderr}"));
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }

    fn op_read(&self, reference: &str) -> Result<String, String> {
        // ONE secret path. `onepassword::cached_op_path` is how the rest of the app finds the CLI
        // (a GUI-session PATH does not contain it); a second resolver here would be a second place
        // for "1Password is installed" to be answered differently.
        let op = crate::onepassword::cached_op_path().unwrap_or_else(|| "op".to_string());
        let out = self.run(&op, &["read".to_string(), reference.to_string()], None)?;
        Ok(out.trim().to_string())
    }
}

/// The REAL io. Kept behind a function rather than inlined at each call site so there is exactly
/// one line to cover — see `default_io_runs_a_real_command`.
pub fn default_io() -> Arc<dyn IntakeIo> {
    Arc::new(RealIo)
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Parsing
// ══════════════════════════════════════════════════════════════════════════════════════════════

fn re(src: &'static str, cell: &'static OnceLock<Regex>) -> &'static Regex {
    cell.get_or_init(|| Regex::new(src).expect("ticket_intake regex is a compile-time constant"))
}

macro_rules! lazy_re {
    ($name:ident, $src:expr) => {
        fn $name() -> &'static Regex {
            static CELL: OnceLock<Regex> = OnceLock::new();
            re($src, &CELL)
        }
    };
}

// linear.app/<workspace>/issue/ENG-1234/<slug> — the slug is optional and is IGNORED, because it is
// a rendering of a title that may since have changed.
lazy_re!(re_linear_url, r"(?i)\bhttps?://linear\.app/[^/\s]+/issue/([A-Za-z][A-Za-z0-9_]{0,9}-\d+)");
// Any Jira: the hosted `/browse/KEY-1` form, and the cloud `*.atlassian.net/...KEY-1` form.
lazy_re!(re_jira_browse, r"(?i)\bhttps?://[^/\s]+/browse/([A-Za-z][A-Za-z0-9_]{0,9}-\d+)");
lazy_re!(
    re_jira_cloud,
    r"(?i)\bhttps?://[^/\s]*atlassian\.net/\S*?([A-Za-z][A-Za-z0-9_]{0,9}-\d+)"
);
lazy_re!(
    re_github_url,
    r"(?i)\bhttps?://github\.com/([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+)/(?:issues|pull)/(\d+)"
);
lazy_re!(re_any_url, r"\bhttps?://\S+");
lazy_re!(re_repo_hash, r"\b([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)#(\d+)\b");
lazy_re!(re_hash, r"(?:^|[^\w#])#(\d+)\b");
lazy_re!(re_bare_key, r"\b([A-Za-z][A-Za-z0-9]{0,9})-(\d+)\b");
// A beads id: a lowercase prefix, a dash, and a suffix that contains at least one LETTER — which is
// what keeps it disjoint from a tracker key, whose suffix is digits only. `.6` children included.
lazy_re!(re_beads, r"\b([a-z][a-z0-9_]*-[a-z0-9]*[a-z][a-z0-9]*(?:\.\d+)*)\b");
// Markdown image, and a bare uploads link — the two shapes an image reaches us in.
lazy_re!(re_md_image, r"!\[([^\]]*)\]\(\s*(\S+?)\s*\)");
lazy_re!(re_upload_url, r"\bhttps?://uploads\.linear\.app/\S+");

/// Lowercase, non-alphanumerics to `-`, collapse and trim. Used for the branch slug and to make a
/// key safe inside a branch name.
pub fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut last_dash = true; // leading dashes are trimmed by never emitting one first
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

/// Render a `{key}` / `{key_lower}` / `{slug}` / `{provider}` template.
fn render_template(
    template: &str,
    key: &str,
    slug: &str,
    provider: Option<Provider>,
) -> String {
    template
        .replace("{key_lower}", &key.to_ascii_lowercase())
        .replace("{key}", key)
        .replace("{slug}", slug)
        .replace("{provider}", provider.map(|p| p.slug()).unwrap_or("ticket"))
}

/// The branch name for a key, with an optional title to slug into it.
///
/// The template is rendered and THEN sanitized, so a template that puts a `/` or a `:` in the name
/// cannot produce a branch git will refuse. An empty slug leaves a trailing separator, which the
/// sanitizer trims — which is what makes the parse-only answer (`eng-1234`) usable on its own.
pub fn derive_branch(settings: &IntakeSettings, key: &str, title: Option<&str>) -> String {
    let slug = title.map(|t| truncate_slug(&slugify(t))).unwrap_or_default();
    let rendered = render_template(&settings.branch_template, key, &slug, None);
    let cleaned = slugify(&rendered);
    if cleaned.is_empty() {
        slugify(key)
    } else {
        cleaned
    }
}

/// Cap the title slug so a branch name stays typeable. Cuts on a word boundary.
fn truncate_slug(slug: &str) -> String {
    const MAX: usize = 48;
    if slug.len() <= MAX {
        return slug.to_string();
    }
    let cut = slug[..MAX].rfind('-').unwrap_or(MAX);
    slug[..cut].trim_end_matches('-').to_string()
}

pub fn derive_commit_prefix(settings: &IntakeSettings, key: &str, provider: Option<Provider>) -> String {
    render_template(&settings.commit_prefix_template, key, "", provider).trim().to_string()
}

/// The PR title. With no fetched title this is the prefix alone — deliberately, so nobody is handed
/// an invented subject line.
pub fn derive_pr_title(commit_prefix: &str, title: Option<&str>) -> String {
    match title.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => format!("{commit_prefix} {t}").trim().to_string(),
        None => commit_prefix.trim().to_string(),
    }
}

/// A canonical tracker key: uppercase project, dash, digits. `eng-1234` and `ENG-1234` are the same
/// ticket, and a pasted lowercase key is the common case (people type it into a shell first).
fn canonical_tracker_key(project: &str, number: &str) -> String {
    format!("{}-{}", project.to_ascii_uppercase(), number)
}

struct Match {
    start: usize,
    raw: String,
    provider: Option<Provider>,
    candidates: Vec<Provider>,
    key: String,
    url: Option<String>,
    note: Option<String>,
}

fn overlaps(claimed: &[(usize, usize)], start: usize, end: usize) -> bool {
    claimed.iter().any(|(s, e)| start < *e && *s < end)
}

/// Extract every ticket reference in `text`, in the order they appear, deduplicated.
///
/// TOTAL: text with no reference in it returns an empty list rather than an error. "Nothing here is
/// a ticket" is a real and common answer (a user pastes a paragraph of context), and turning it
/// into a failure would make the paste box refuse ordinary prose.
pub fn parse_refs(text: &str, settings: &IntakeSettings) -> Vec<TicketRef> {
    let mut claimed: Vec<(usize, usize)> = Vec::new();
    let mut found: Vec<Match> = Vec::new();

    // ── URLs FIRST, and the WHOLE url span is claimed, not just the part that matched.
    //
    //    Claiming only the matched part is a real bug, not a nicety: a Linear link carries a title
    //    slug (`…/issue/ENG-1234/fix-the-login-crash`) and a Jira board link carries a query
    //    string, and an unclaimed tail is then re-scanned as prose — where `fix-the` and
    //    `login-crash` look exactly like bead ids. So every URL is claimed whole and CLASSIFIED
    //    from its own text.
    for m in re_any_url().find_iter(text) {
        if overlaps(&claimed, m.start(), m.end()) {
            continue;
        }
        claimed.push((m.start(), m.end()));
        let url = m.as_str();
        let mut push = |provider: Option<Provider>,
                        candidates: Vec<Provider>,
                        key: String,
                        note: Option<String>| {
            found.push(Match {
                start: m.start(),
                raw: url.to_string(),
                provider,
                candidates,
                key,
                url: Some(url.to_string()),
                note,
            });
        };
        if let Some(c) = re_linear_url().captures(url) {
            push(Some(Provider::Linear), Vec::new(), canonical_key_from_capture(&c[1]), None);
        } else if let Some(c) = re_jira_browse().captures(url).or_else(|| re_jira_cloud().captures(url))
        {
            push(Some(Provider::Jira), Vec::new(), canonical_key_from_capture(&c[1]), None);
        } else if let Some(c) = re_github_url().captures(url) {
            push(
                Some(Provider::Github),
                Vec::new(),
                format!("{}/{}#{}", &c[1], &c[2], &c[3]),
                None,
            );
        } else if let Some(c) = re_bare_key().captures(url) {
            // A URL we do not recognize, with a tracker key visible inside it. Report it as
            // AMBIGUOUS with the host named, rather than guessing the provider from an unfamiliar
            // domain or dropping the reference silently. A self-hosted Jira and a proxied Linear
            // both land here, and the honest answer to both is "which of these is it?".
            let key = canonical_tracker_key(&c[1], &c[2]);
            let host = host_of(url).unwrap_or_else(|| "an unfamiliar host".to_string());
            let (provider, candidates, note) = resolve_bare(settings, &key, Some(&host));
            push(provider, candidates, key, note);
        }
        // A URL with no key in it contributes nothing — but its span STAYS claimed, so its path
        // segments are never mistaken for references.
    }

    // ── `owner/repo#123`, then a bare `#123`.
    for c in re_repo_hash().captures_iter(text) {
        let m = c.get(0).unwrap();
        if overlaps(&claimed, m.start(), m.end()) {
            continue;
        }
        claimed.push((m.start(), m.end()));
        found.push(Match {
            start: m.start(),
            raw: m.as_str().to_string(),
            provider: Some(Provider::Github),
            candidates: Vec::new(),
            key: format!("{}#{}", &c[1], &c[2]),
            url: None,
            note: None,
        });
    }
    for c in re_hash().captures_iter(text) {
        let whole = c.get(0).unwrap();
        let num = c.get(1).unwrap();
        if overlaps(&claimed, whole.start(), whole.end()) {
            continue;
        }
        claimed.push((num.start() - 1, num.end()));
        found.push(Match {
            start: num.start() - 1,
            raw: format!("#{}", &c[1]),
            provider: Some(Provider::Github),
            candidates: Vec::new(),
            key: format!("#{}", &c[1]),
            url: None,
            note: None,
        });
    }

    // ── beads ids, then bare tracker keys. beads first because its shape is the more specific one.
    for c in re_beads().captures_iter(text) {
        let m = c.get(0).unwrap();
        if overlaps(&claimed, m.start(), m.end()) {
            continue;
        }
        if !is_beads_id(m.as_str(), &settings.beads_prefixes) {
            continue;
        }
        claimed.push((m.start(), m.end()));
        found.push(Match {
            start: m.start(),
            raw: m.as_str().to_string(),
            provider: Some(Provider::Beads),
            candidates: Vec::new(),
            key: m.as_str().to_string(),
            url: None,
            note: None,
        });
    }
    for c in re_bare_key().captures_iter(text) {
        let m = c.get(0).unwrap();
        if overlaps(&claimed, m.start(), m.end()) {
            continue;
        }
        claimed.push((m.start(), m.end()));
        let key = canonical_tracker_key(&c[1], &c[2]);
        let (provider, candidates, note) = resolve_bare(settings, &key, None);
        found.push(Match {
            start: m.start(),
            raw: m.as_str().to_string(),
            provider,
            candidates,
            key,
            url: None,
            note,
        });
    }

    found.sort_by_key(|m| m.start);

    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for m in found {
        let ident = format!("{}::{}", m.provider.map(|p| p.slug()).unwrap_or("?"), m.key);
        if !seen.insert(ident) {
            continue;
        }
        out.push(finish_ref(settings, m));
    }
    out
}

/// Is `token` a bead id, or an ordinary hyphenated English word?
///
/// THE TWO ARE THE SAME SHAPE — `sparkle-jehei` and `well-known` are both a lowercase word, a dash
/// and another lowercase word — so nothing in the string alone settles it, and a parser that took
/// every match turned `fix-the-login-crash` (the SLUG of a Linear URL) into two tickets. Two rules,
/// in order:
///
///   1. If the project's bead prefixes are known, a matching prefix IS the answer. Exact, no
///      heuristic, and it is the case that matters here because a user pastes ids from the repo
///      they are standing in.
///   2. Otherwise accept only UNMISTAKABLE shapes: a dotted child (`x-bqo.6`) or a suffix carrying
///      a digit (`x-16y6h`). This deliberately MISSES a plain-letter id from an unknown project —
///      the honest trade, because the alternative is that every hyphenated word in a pasted
///      paragraph becomes a ticket card.
pub fn is_beads_id(token: &str, prefixes: &[String]) -> bool {
    let Some((prefix, rest)) = token.split_once('-') else { return false };
    if rest.is_empty() {
        return false;
    }
    if prefixes.iter().any(|p| p.trim().eq_ignore_ascii_case(prefix)) {
        return true;
    }
    let head = rest.split('.').next().unwrap_or(rest);
    if head.len() < 3 {
        return false;
    }
    rest.contains('.') || head.chars().any(|c| c.is_ascii_digit())
}

/// The bead id prefixes this project uses, read from its own `.beads/` files.
///
/// Two sources, in order, because neither is always present: `issue-prefix` in
/// `.beads/config.yaml` (set explicitly, and usually COMMENTED OUT — the common case is that bd
/// auto-detected it), then `dolt_database` in `.beads/metadata.json`, which is what the store was
/// actually created as. An empty answer is normal and is not a failure: [`is_beads_id`] falls back
/// to its conservative shape rule.
pub fn beads_prefixes_for(root: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Ok(text) = std::fs::read_to_string(root.join(".beads").join("config.yaml")) {
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with('#') {
                continue;
            }
            if let Some(rest) = line.strip_prefix("issue-prefix:") {
                let v = rest.trim().trim_matches(['"', '\'']).trim().to_string();
                if !v.is_empty() {
                    out.push(v);
                }
            }
        }
    }
    if let Ok(text) = std::fs::read_to_string(root.join(".beads").join("metadata.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(db) = v.get("dolt_database").and_then(|d| d.as_str()) {
                let db = db.trim();
                if !db.is_empty() && !out.iter().any(|p| p.eq_ignore_ascii_case(db)) {
                    out.push(db.to_string());
                }
            }
        }
    }
    out
}

fn canonical_key_from_capture(raw: &str) -> String {
    match raw.split_once('-') {
        Some((p, n)) => canonical_tracker_key(p, n),
        None => raw.to_ascii_uppercase(),
    }
}

fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let host = rest.split(['/', '?', '#']).next()?;
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// A bare `ENG-1234` is a valid key in BOTH Linear and Jira. This is the one decision in the parser
/// that could be a silent guess, so it never is: the configured default wins WITH a note saying so,
/// and with no default the answer is "ambiguous, here are the candidates".
fn resolve_bare(
    settings: &IntakeSettings,
    key: &str,
    host: Option<&str>,
) -> (Option<Provider>, Vec<Provider>, Option<String>) {
    let candidates: Vec<Provider> = [Provider::Linear, Provider::Jira]
        .into_iter()
        .filter(|p| settings.provider_settings(*p).enabled)
        .collect();
    let where_from = match host {
        Some(h) => format!("{key} appeared in a URL on {h}, which is not a host this build knows"),
        None => format!("{key} is a valid key in more than one tracker"),
    };
    match settings.default_provider {
        Some(p) if candidates.contains(&p) => (
            Some(p),
            Vec::new(),
            Some(format!(
                "{where_from}; read as {} because [ticket_intake].default_provider says so",
                p.label()
            )),
        ),
        _ => {
            // Exactly one candidate left (the other provider is switched off) is not ambiguity —
            // there is nothing to choose between.
            if candidates.len() == 1 {
                let only = candidates[0];
                return (
                    Some(only),
                    Vec::new(),
                    Some(format!("{where_from}; {} is the only one enabled", only.label())),
                );
            }
            (
                None,
                candidates,
                Some(format!("{where_from} and no default_provider is set — pick one")),
            )
        }
    }
}

fn finish_ref(settings: &IntakeSettings, m: Match) -> TicketRef {
    let branch = derive_branch(settings, &m.key, None);
    let commit_prefix = derive_commit_prefix(settings, &m.key, m.provider);
    let pr_title = derive_pr_title(&commit_prefix, None);
    TicketRef {
        raw: m.raw,
        ambiguous: m.provider.is_none(),
        provider: m.provider,
        candidates: m.candidates,
        key: m.key,
        url: m.url,
        branch,
        commit_prefix,
        pr_title,
        note: m.note,
    }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Providers
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// The credential an attachment download may carry, and the ONLY hosts it may be sent to.
///
/// THE HOST LIST IS THE POINT. A ticket body is user content: it can reference an image on any
/// host in the world, and attaching the workspace's API token to `https://evil.example/a.png`
/// would exfiltrate that token to whoever wrote the ticket. So the credential travels only to the
/// provider's own hosts, and every other URL is fetched anonymously — which is the correct
/// behaviour for a public image anyway.
#[derive(Debug, Clone, PartialEq)]
pub struct ImageAuth {
    /// Host suffixes the headers may be sent to, e.g. `["linear.app"]` — matched as the whole host
    /// or as a dot-suffix of it, never as a substring (`notlinear.app` must not match).
    pub host_suffixes: Vec<String>,
    pub headers: Vec<(String, String)>,
}

impl ImageAuth {
    /// The headers to send with `url` — the credential for one of our hosts, nothing for anywhere
    /// else.
    ///
    /// PARSED WITH `url::Url`, THE SAME PARSER THAT SENDS THE REQUEST, and that is the whole
    /// safety property. A hand-rolled "everything after `://` up to the first `/`" disagrees with
    /// WHATWG on a BACKSLASH, which is a path separator for a special scheme: given
    /// `https://evil.example\.linear.app/x.png` the hand-rolled reader answers
    /// `evil.example\.linear.app` (which passes a `.linear.app` suffix test) while the HTTP client
    /// resolves the host as `evil.example` — so the token is attached and then sent to the
    /// attacker. Two parsers disagreeing about one string is the bug; using one parser removes the
    /// class. Image URLs come from ticket bodies, which are user content.
    ///
    /// HTTPS ONLY, for the same reason: `http://uploads.linear.app/x.png` in a ticket body would
    /// put the API token on the wire in cleartext, and a plaintext image is never worth that.
    ///
    /// Total, and fails safe: an unparseable URL, a non-https scheme and a host-less URL all
    /// return no headers.
    pub fn headers_for(&self, url: &str) -> Vec<(String, String)> {
        let Ok(parsed) = url::Url::parse(url) else { return Vec::new() };
        if parsed.scheme() != "https" {
            return Vec::new();
        }
        let Some(host) = parsed.host_str() else { return Vec::new() };
        let host = host.to_ascii_lowercase();
        let ours = self.host_suffixes.iter().any(|s| {
            let s = s.trim().to_ascii_lowercase();
            !s.is_empty() && (host == s || host.ends_with(&format!(".{s}")))
        });
        if ours {
            self.headers.clone()
        } else {
            Vec::new()
        }
    }
}

/// One tracker, behind one trait. Each is independently switchable and independently broken: a
/// provider whose credential is missing refuses ITSELF and says why, and the batch keeps going.
pub trait TicketProvider: Send + Sync {
    /// Resolve this provider's credential ONCE per intake.
    ///
    /// Separate from `fetch` so the ticket call and the attachment downloads share ONE resolution.
    /// It matters for an `op://` value: resolving inside each caller would mean a second 1Password
    /// read (and a second chance for the two halves to disagree about what the credential is).
    /// `Ok(None)` means "this provider needs no credential", which is different from an error.
    fn credential(
        &self,
        _io: &dyn IntakeIo,
        _settings: &IntakeSettings,
    ) -> Result<Option<String>, String> {
        Ok(None)
    }

    fn fetch(
        &self,
        io: &dyn IntakeIo,
        root: &Path,
        settings: &IntakeSettings,
        key: &str,
        cred: Option<&str>,
    ) -> Result<RawTicket, String>;

    /// Which hosts this provider's attachments live on and what they need. `None` when its
    /// attachments are public (or when it has no attachments to fetch at all).
    fn image_auth(&self, _settings: &IntakeSettings, _cred: Option<&str>) -> Option<ImageAuth> {
        None
    }
}

pub fn provider_for(p: Provider) -> Box<dyn TicketProvider> {
    match p {
        Provider::Linear => Box::new(LinearProvider),
        Provider::Jira => Box::new(JiraProvider),
        Provider::Github => Box::new(GithubProvider),
        Provider::Beads => Box::new(BeadsProvider),
    }
}

/// Resolve a configured secret, following an `op://` reference through the 1Password CLI.
fn resolve_secret(io: &dyn IntakeIo, s: &Secret, what: &str) -> Result<String, String> {
    if s.is_empty() {
        return Err(format!("no {what} is configured"));
    }
    if s.is_op_reference() {
        let v = io.op_read(s.expose()).map_err(|e| {
            // NOTE the reference itself is safe to print — it is a POINTER, not the credential —
            // and printing it is the only way a user can tell which item failed to resolve.
            format!("could not read {what} from 1Password ({}): {e}", s.expose())
        })?;
        if v.trim().is_empty() {
            return Err(format!("1Password returned an empty value for {}", s.expose()));
        }
        return Ok(v.trim().to_string());
    }
    Ok(s.expose().to_string())
}

/// Every image a blob of ticket text refers to, deduplicated, in order.
///
/// The markdown ALT TEXT becomes the reference's file name when it looks like one — both Linear and
/// GitHub emit `![image.png](https://…/<uuid>)`, so it is usually the only human-readable name a
/// screenshot has. Nothing depends on it being right (the type is sniffed from the bytes); it is
/// what lets a refused row say WHICH file was refused.
pub fn image_refs_in(text: &str) -> Vec<ImageRef> {
    let mut seen = HashSet::new();
    let mut out: Vec<ImageRef> = Vec::new();
    for c in re_md_image().captures_iter(text) {
        let u = c[2].trim_matches(|c| c == '"' || c == '\'').to_string();
        if !u.starts_with("http") || !seen.insert(u.clone()) {
            continue;
        }
        let alt = c[1].trim();
        let file_name = (alt.contains('.') && !alt.contains('/')).then(|| alt.to_string());
        out.push(ImageRef::named(u, file_name));
    }
    for m in re_upload_url().find_iter(text) {
        let u = m.as_str().trim_end_matches(|c| c == ')' || c == ',' || c == '.').to_string();
        if seen.insert(u.clone()) {
            out.push(ImageRef::bare(u));
        }
    }
    out
}

struct LinearProvider;

/// The Linear GraphQL endpoint. `base_url` overrides it (a proxy, or a test).
const LINEAR_ENDPOINT: &str = "https://api.linear.app/graphql";

const LINEAR_QUERY: &str = r#"query Issue($id: String!) { issue(id: $id) { identifier title description url comments { nodes { body } } attachments { nodes { url title } } } }"#;

/// Linear's asset host. Attachments are served from `uploads.linear.app`, the API from
/// `api.linear.app`; the shared suffix covers both without admitting anything else.
const LINEAR_HOST_SUFFIX: &str = "linear.app";

/// Where Linear serves an UPLOADED file. Narrower than [`LINEAR_HOST_SUFFIX`] on purpose, and the
/// difference is what keeps this feature from making outbound requests to third parties.
///
/// A Linear "attachment" is not a file — it is whatever was LINKED to the issue, and Linear
/// auto-creates one for every linked GitHub PR, Slack thread, Figma file and Sentry issue. That is
/// the common case, not the exotic one. Folding those into the image list would GET a Figma board
/// on the intake path, get HTML back, and paint "3 images, 2 could not be fetched" for a ticket
/// with one screenshot — the same count dishonesty, pointing the other way, plus a request to a
/// host derived from ticket content.
const LINEAR_ASSET_HOST: &str = "uploads.linear.app";

/// Is this URL one Linear serves an uploaded FILE from (as opposed to a link it merely tracks)?
///
/// Parsed with `url::Url` for the reason `ImageAuth::headers_for` documents: a hand-rolled host
/// reader disagrees with the one that sends the request, and here the disagreement would decide
/// whether a third-party URL gets fetched.
pub fn is_linear_asset(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else { return false };
    let Some(host) = parsed.host_str() else { return false };
    let host = host.to_ascii_lowercase();
    host == LINEAR_ASSET_HOST || host.ends_with(&format!(".{LINEAR_ASSET_HOST}"))
}

impl TicketProvider for LinearProvider {

    fn credential(
        &self,
        io: &dyn IntakeIo,
        settings: &IntakeSettings,
    ) -> Result<Option<String>, String> {
        Ok(Some(resolve_secret(io, &settings.linear.api_key, "Linear API key")?))
    }

    fn image_auth(&self, _settings: &IntakeSettings, cred: Option<&str>) -> Option<ImageAuth> {
        let token = cred?;
        Some(ImageAuth {
            host_suffixes: vec![LINEAR_HOST_SUFFIX.to_string()],
            headers: vec![("Authorization".to_string(), token.to_string())],
        })
    }

    fn fetch(
        &self,
        io: &dyn IntakeIo,
        _root: &Path,
        settings: &IntakeSettings,
        key: &str,
        cred: Option<&str>,
    ) -> Result<RawTicket, String> {
        let token = cred
            .map(str::to_string)
            .ok_or_else(|| "no Linear API key is configured".to_string())?;
        let endpoint = if settings.linear.base_url.trim().is_empty() {
            LINEAR_ENDPOINT.to_string()
        } else {
            settings.linear.base_url.trim().trim_end_matches('/').to_string()
        };
        let body = serde_json::json!({
            "query": LINEAR_QUERY,
            "variables": { "id": key },
        })
        .to_string();
        let headers = vec![
            ("Authorization".to_string(), token),
            ("Content-Type".to_string(), "application/json".to_string()),
        ];
        let text = io.http_post(&endpoint, &headers, &body)?;
        parse_linear_response(&text, key)
    }
}

/// Pull a Linear GraphQL reply apart.
///
/// A GraphQL error comes back as HTTP 200 with an `errors` array, so "the request succeeded" says
/// nothing — check `errors` FIRST or an expired token reads as an empty ticket.
pub fn parse_linear_response(text: &str, key: &str) -> Result<RawTicket, String> {
    let v: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| format!("Linear returned something that is not JSON: {e}"))?;
    if let Some(errs) = v.get("errors").and_then(|e| e.as_array()) {
        let first = errs
            .first()
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("unknown error");
        return Err(format!("Linear refused the request for {key}: {first}"));
    }
    let issue = v
        .get("data")
        .and_then(|d| d.get("issue"))
        .filter(|i| !i.is_null())
        .ok_or_else(|| format!("Linear has no issue {key}"))?;
    let title = issue.get("title").and_then(|t| t.as_str()).unwrap_or_default().to_string();
    let body = issue.get("description").and_then(|t| t.as_str()).unwrap_or_default().to_string();
    let comments: Vec<String> = issue
        .get("comments")
        .and_then(|c| c.get("nodes"))
        .and_then(|n| n.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|c| c.get("body").and_then(|b| b.as_str()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let mut images: Vec<ImageRef> = image_refs_in(&body);
    let push = |r: ImageRef, out: &mut Vec<ImageRef>| {
        if !out.iter().any(|e| e.url == r.url) {
            out.push(r);
        }
    };
    for c in &comments {
        for r in image_refs_in(c) {
            push(r, &mut images);
        }
    }
    // ONLY AN UPLOADED FILE. A Linear attachment node is created for every linked GitHub PR, Slack
    // thread, Figma file and Sentry issue, and those are not candidate screenshots — see
    // `LINEAR_ASSET_HOST` for what folding them in would cost.
    if let Some(nodes) = issue.get("attachments").and_then(|a| a.get("nodes")).and_then(|n| n.as_array())
    {
        for n in nodes {
            let Some(u) = n.get("url").and_then(|u| u.as_str()) else { continue };
            if !is_linear_asset(u) {
                continue;
            }
            // Linear names an attachment by its `title` — which `LINEAR_QUERY` asks for, or this
            // read would describe a payload the request can never produce. The bytes still decide
            // the type; the name only decides what a refusal is allowed to call it.
            let file_name = n.get("title").and_then(|t| t.as_str()).map(str::to_string);
            push(ImageRef::named(u, file_name), &mut images);
        }
    }
    Ok(RawTicket {
        title,
        body,
        comments,
        images,
        url: issue.get("url").and_then(|u| u.as_str()).map(str::to_string),
    })
}

struct JiraProvider;

impl TicketProvider for JiraProvider {

    fn credential(
        &self,
        io: &dyn IntakeIo,
        settings: &IntakeSettings,
    ) -> Result<Option<String>, String> {
        Ok(Some(resolve_secret(io, &settings.jira.api_key, "Jira API token")?))
    }

    /// Jira serves an attachment's bytes from the SAME site as the API, and refuses it 401 without
    /// the header — so the site's own host is the one place this credential may travel to.
    fn image_auth(&self, settings: &IntakeSettings, cred: Option<&str>) -> Option<ImageAuth> {
        let token = cred?;
        let host = host_of(settings.jira.base_url.trim())?;
        Some(ImageAuth {
            host_suffixes: vec![host],
            headers: vec![("Authorization".to_string(), jira_auth_header(token))],
        })
    }

    fn fetch(
        &self,
        io: &dyn IntakeIo,
        _root: &Path,
        settings: &IntakeSettings,
        key: &str,
        cred: Option<&str>,
    ) -> Result<RawTicket, String> {
        let base = settings.jira.base_url.trim().trim_end_matches('/');
        if base.is_empty() {
            return Err(
                "no Jira base_url is configured — set [ticket_intake.jira].base_url to your site \
                 (e.g. https://acme.atlassian.net)"
                    .to_string(),
            );
        }
        let token = cred
            .map(str::to_string)
            .ok_or_else(|| "no Jira API token is configured".to_string())?;
        let url = format!("{base}/rest/api/3/issue/{key}?fields=summary,description,comment,attachment");
        let headers = vec![
            ("Authorization".to_string(), jira_auth_header(&token)),
            ("Accept".to_string(), "application/json".to_string()),
        ];
        let text = io.http_get(&url, &headers)?;
        let mut raw = parse_jira_response(&text, key)?;
        raw.url = Some(format!("{base}/browse/{key}"));
        Ok(raw)
    }
}

/// Jira Cloud wants BASIC auth of `email:api-token`; a self-hosted PAT is a bearer token. The
/// colon is the only thing that tells them apart, and getting it wrong is a 401 that reads like a
/// bad credential rather than a bad SCHEME — so decide it here, in one covered place.
pub fn jira_auth_header(token: &str) -> String {
    if token.contains(':') {
        format!("Basic {}", STANDARD.encode(token))
    } else {
        format!("Bearer {token}")
    }
}

/// Pull a Jira REST reply apart.
///
/// `description` is Atlassian Document Format (a JSON tree), not a string, on the v3 API — so a
/// reader that expects a string finds `null` and reports an empty ticket. `adf_text` walks it.
pub fn parse_jira_response(text: &str, key: &str) -> Result<RawTicket, String> {
    let v: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| format!("Jira returned something that is not JSON: {e}"))?;
    if let Some(msgs) = v.get("errorMessages").and_then(|m| m.as_array()) {
        if let Some(first) = msgs.first().and_then(|m| m.as_str()) {
            return Err(format!("Jira refused the request for {key}: {first}"));
        }
    }
    let fields = v.get("fields").ok_or_else(|| format!("Jira has no issue {key}"))?;
    let title = fields.get("summary").and_then(|s| s.as_str()).unwrap_or_default().to_string();
    let description = fields.get("description");
    let body = adf_text(description);
    let comment_bodies: Vec<Option<&serde_json::Value>> = fields
        .get("comment")
        .and_then(|c| c.get("comments"))
        .and_then(|c| c.as_array())
        .map(|a| a.iter().map(|c| c.get("body")).collect())
        .unwrap_or_default();
    let comments: Vec<String> = comment_bodies.iter().map(|b| adf_text(*b)).collect();

    // `id` -> what its bytes are served from AND what the tracker calls the file. The URL is
    // `/rest/api/3/attachment/content/<id>`, extensionless — so the FILENAME is the only thing
    // that can type the download, and without it every Jira screenshot is `application/octet-
    // stream`, which renders nothing.
    let mut by_id: Vec<(String, ImageRef)> = Vec::new();
    if let Some(atts) = fields.get("attachment").and_then(|a| a.as_array()) {
        for a in atts {
            let Some(u) = a.get("content").and_then(|u| u.as_str()) else { continue };
            // `id` is a number on the REST payload and a string inside ADF — compare as text.
            let id = a
                .get("id")
                .map(|i| i.as_str().map(str::to_string).unwrap_or_else(|| i.to_string()))
                .unwrap_or_default();
            let file_name = a.get("filename").and_then(|f| f.as_str()).map(str::to_string);
            // Jira states the type in the attachment metadata. Carried so a `log.txt` can be
            // refused from metadata alone, without a request.
            let declared_mime = a.get("mimeType").and_then(|m| m.as_str()).map(str::to_string);
            by_id.push((id, ImageRef { url: u.to_string(), file_name, declared_mime }));
        }
    }

    let mut image_urls: Vec<ImageRef> = Vec::new();
    let push = |r: ImageRef, out: &mut Vec<ImageRef>| {
        if !r.url.is_empty() && !out.iter().any(|e| e.url == r.url) {
            out.push(r);
        }
    };
    // INLINE FIRST, in document order — that is the order the reader sees them in the ticket.
    let mut ids = adf_media_ids(description);
    for b in &comment_bodies {
        for id in adf_media_ids(*b) {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    for id in &ids {
        if let Some((_, r)) = by_id.iter().find(|(k, _)| k == id) {
            push(r.clone(), &mut image_urls);
        }
    }
    // Then whatever the markdown/external-media pass found in the rendered text…
    for r in image_refs_in(&body) {
        push(r, &mut image_urls);
    }
    for c in &comments {
        for r in image_refs_in(c) {
            push(r, &mut image_urls);
        }
    }
    // …and finally every remaining attachment, so a screenshot that is attached but not embedded
    // still reaches the agent. A `log.txt` or a PDF lands here too and comes back as a refused row
    // naming itself, rather than as a broken thumbnail or as nothing at all.
    for (_, r) in &by_id {
        push(r.clone(), &mut image_urls);
    }
    Ok(RawTicket { title, body, comments, images: image_urls, url: None })
}

/// Flatten an Atlassian Document Format tree (or a plain string) to text.
///
/// THREE SHAPES THE REAL WIRE USES, and getting any of them from a hand-authored fixture instead
/// of a real payload is how a parser ends up testing a case the producer cannot emit
/// (`sparkle-16y6h`):
///
///   * text lives on `{"type":"text","text":"…"}` nodes inside `content`;
///   * a LINK is not a node — it is `marks: [{"type":"link","attrs":{"href":…}}]` ON a text node,
///     so a walker that recurses only into `content` never sees a single href;
///   * an EXTERNAL image is `{"type":"media","attrs":{"type":"external","url":…}}`, but an
///     UPLOADED one is `{"type":"media","attrs":{"type":"file","id":"<uuid>","collection":…}}`
///     with NO url at all — its bytes are reached through the issue's `fields.attachment[]`
///     entry with the same `id`. See [`adf_media_ids`] and `parse_jira_response`.
pub fn adf_text(v: Option<&serde_json::Value>) -> String {
    fn walk(v: &serde_json::Value, out: &mut String) {
        match v {
            serde_json::Value::String(s) => out.push_str(s),
            serde_json::Value::Array(a) => {
                for item in a {
                    walk(item, out);
                }
            }
            serde_json::Value::Object(o) => {
                let attrs = o.get("attrs");
                // An EXTERNAL media node carries its source here. A `file` one does not, and must
                // not be invented — it is resolved from the attachment array instead.
                if let Some(url) = attrs.and_then(|a| a.get("url")).and_then(|u| u.as_str()) {
                    out.push_str(&format!("\n![]({url})\n"));
                }
                if let Some(t) = o.get("text").and_then(|t| t.as_str()) {
                    out.push_str(t);
                }
                // MARKS, not content: a link's href hangs off the text node it decorates.
                if let Some(marks) = o.get("marks").and_then(|m| m.as_array()) {
                    for m in marks {
                        if let Some(href) =
                            m.get("attrs").and_then(|a| a.get("href")).and_then(|h| h.as_str())
                        {
                            out.push_str(&format!(" {href} "));
                        }
                    }
                }
                if let Some(c) = o.get("content") {
                    walk(c, out);
                }
                if o.get("type").and_then(|t| t.as_str()) == Some("paragraph") {
                    out.push('\n');
                }
            }
            _ => {}
        }
    }
    let Some(v) = v else { return String::new() };
    let mut out = String::new();
    walk(v, &mut out);
    out.trim().to_string()
}

/// The attachment ids an ADF tree embeds inline, in document order.
///
/// An uploaded screenshot appears in the description as a `media` node holding only an `id`; its
/// URL lives in the issue's `fields.attachment[]`. Collecting the ids is what lets the inline
/// images come back in the ORDER the ticket shows them, rather than in whatever order the
/// attachment array happens to be in.
pub fn adf_media_ids(v: Option<&serde_json::Value>) -> Vec<String> {
    fn walk(v: &serde_json::Value, out: &mut Vec<String>) {
        match v {
            serde_json::Value::Array(a) => {
                for item in a {
                    walk(item, out);
                }
            }
            serde_json::Value::Object(o) => {
                if o.get("type").and_then(|t| t.as_str()) == Some("media") {
                    if let Some(id) =
                        o.get("attrs").and_then(|a| a.get("id")).and_then(|i| i.as_str())
                    {
                        let id = id.to_string();
                        if !out.contains(&id) {
                            out.push(id);
                        }
                    }
                }
                if let Some(c) = o.get("content") {
                    walk(c, out);
                }
            }
            _ => {}
        }
    }
    let Some(v) = v else { return Vec::new() };
    let mut out = Vec::new();
    walk(v, &mut out);
    out
}

struct GithubProvider;

impl TicketProvider for GithubProvider {

    /// SHELLS OUT TO `gh`, deliberately — no second HTTP client and no second place for GitHub auth
    /// to live. `gh` already holds the user's token in their keychain; re-implementing that here
    /// would mean asking for a token the machine already has.
    fn fetch(
        &self,
        io: &dyn IntakeIo,
        root: &Path,
        _settings: &IntakeSettings,
        key: &str,
        _cred: Option<&str>,
    ) -> Result<RawTicket, String> {
        let args = gh_argv(key)?;
        let text = io.run("gh", &args, Some(root))?;
        parse_gh_response(&text, key)
    }
}

/// The `gh issue view` argv for a key. `#123` runs against the repo in `cwd`; `owner/repo#123`
/// names the repo explicitly.
pub fn gh_argv(key: &str) -> Result<Vec<String>, String> {
    let (repo, number) = match key.split_once('#') {
        Some((r, n)) => (r.trim(), n.trim()),
        None => ("", key.trim()),
    };
    if number.is_empty() || !number.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("{key} is not a GitHub issue number"));
    }
    let mut args = vec!["issue".to_string(), "view".to_string(), number.to_string()];
    if !repo.is_empty() {
        args.push("--repo".to_string());
        args.push(repo.to_string());
    }
    args.push("--json".to_string());
    args.push("title,body,url,comments".to_string());
    Ok(args)
}

pub fn parse_gh_response(text: &str, key: &str) -> Result<RawTicket, String> {
    let v: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| format!("gh returned something that is not JSON for {key}: {e}"))?;
    let title = v.get("title").and_then(|t| t.as_str()).unwrap_or_default().to_string();
    let body = v.get("body").and_then(|t| t.as_str()).unwrap_or_default().to_string();
    let comments: Vec<String> = v
        .get("comments")
        .and_then(|c| c.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|c| c.get("body").and_then(|b| b.as_str()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let mut images: Vec<ImageRef> = image_refs_in(&body);
    for c in &comments {
        for r in image_refs_in(c) {
            if !images.iter().any(|e| e.url == r.url) {
                images.push(r);
            }
        }
    }
    Ok(RawTicket {
        title,
        body,
        comments,
        images,
        url: v.get("url").and_then(|u| u.as_str()).map(str::to_string),
    })
}

struct BeadsProvider;

impl TicketProvider for BeadsProvider {

    fn fetch(
        &self,
        io: &dyn IntakeIo,
        root: &Path,
        _settings: &IntakeSettings,
        key: &str,
        _cred: Option<&str>,
    ) -> Result<RawTicket, String> {
        let (program, args) = bd_argv(root, key);
        let text = io.run(&program, &args, Some(root))?;
        if text.trim().is_empty() {
            // A `bd` call that prints NOTHING is usually queued behind the shared store lock and
            // then killed by the bound — not a missing bead. Saying "not found" here would send
            // the reader to check an id that is fine.
            return Err(format!(
                "bd printed nothing for {key} within {BD_TIMEOUT_SECS}s — the shared beads store \
                 was most likely locked by another agent; try again"
            ));
        }
        Ok(parse_bd_show(&text, key))
    }
}

/// The argv for `bd show <full-id>`, bounded.
///
/// TWO RULES, both of which cost real time when broken:
///   * the id is passed WHOLE. `bd show` matches loosely and silently returns a DIFFERENT bead for
///     a prefix — measured, `bd show ` returned `sparkle-tjb6r`. There is no prefix
///     shortening anywhere in this module.
///   * the call is bounded by `scripts/timeout.sh`, not bare `timeout` (macOS ships no coreutils,
///     so the bare form can die `command not found` and the wrapped command never runs at all).
///     When the script is not in this repo we run `bd` unwrapped rather than inventing a bound.
pub fn bd_argv(root: &Path, full_id: &str) -> (String, Vec<String>) {
    let script = root.join("scripts").join("timeout.sh");
    if script.is_file() {
        (
            script.to_string_lossy().to_string(),
            vec![
                BD_TIMEOUT_SECS.to_string(),
                "bd".to_string(),
                "show".to_string(),
                full_id.to_string(),
            ],
        )
    } else {
        ("bd".to_string(), vec!["show".to_string(), full_id.to_string()])
    }
}

/// `bd show` prints a human report, not JSON. The first line carries the id and the title after the
/// `·`; everything is kept as the body, because a bead's value here is its prose.
pub fn parse_bd_show(text: &str, key: &str) -> RawTicket {
    let first = text.lines().find(|l| !l.trim().is_empty()).unwrap_or_default();
    let title = first
        .split_once('·')
        .map(|(_, rest)| rest)
        .unwrap_or(first)
        .split("  [")
        .next()
        .unwrap_or(first)
        .trim()
        .to_string();
    RawTicket {
        title: if title.is_empty() { key.to_string() } else { title },
        body: text.trim().to_string(),
        comments: Vec::new(),
        images: image_refs_in(text),
        url: None,
    }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Images
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// What the BYTES say this file is: `(mime, extension)`, or `None` when it is not an image we can
/// name.
///
/// SNIFFED, NOT GUESSED FROM THE URL, and the difference is the whole feature working or not.
/// Linear serves an inline screenshot from `https://uploads.linear.app/<uuid>` and GitHub from
/// `https://github.com/user-attachments/assets/<uuid>` — both EXTENSIONLESS. A filter keyed on the
/// extension answers "not an image" for the primary provider's entire screenshot path, and a
/// filter applied BEFORE the fetch drops it so completely that there is no row, no reason and no
/// count: the summary reads "0 images" for a ticket that had three. The bytes are the only thing
/// that actually knows, so the order is fetch, then sniff, then decide.
///
/// The four formats are the four `mime_for` can name. SVG is deliberately absent from both — it is
/// a script-bearing document, not a picture.
pub fn sniff_image_mime(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if bytes.starts_with(PNG) {
        return Some(("image/png", "png"));
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some(("image/jpeg", "jpg"));
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(("image/gif", "gif"));
    }
    // RIFF....WEBP — the four size bytes in between are not part of the signature.
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some(("image/webp", "webp"));
    }
    None
}

/// Does a tracker's type claim actually ASSERT that this file is not an image?
///
/// FALSE FOR THE "I DON'T KNOW" FAMILY, and that distinction is the whole point. Jira takes
/// `mimeType` from the uploading client's `Content-Type`, so a genuine PNG that arrived through a
/// Slack or email bridge, through `curl`, or through an older Jira Server upload path routinely
/// lands as `application/octet-stream`. Treating that as knowledge refuses a real screenshot
/// BEFORE the request, so the bytes never reach the sniff — which is exactly the URL-guessing
/// regression the sniff replaced, coming back through a side door. `text/plain` and
/// `application/pdf` are statements; `application/octet-stream` is a shrug.
///
/// A claim may only ever DECLINE, and only when it is specific. Everything else falls through to
/// fetch-and-sniff, which refuses a non-image honestly, with a named row, from the bytes.
pub fn claim_declines_image(mime: &str) -> bool {
    let m = mime.trim().to_ascii_lowercase();
    // A claim with no type in it is not a claim.
    if m.is_empty() || !m.contains('/') {
        return false;
    }
    if m.starts_with("image/") {
        return false;
    }
    const UNKNOWN: [&str; 4] = [
        "application/octet-stream",
        "binary/octet-stream",
        "application/x-download",
        "application/force-download",
    ];
    !UNKNOWN.contains(&m.as_str())
}

/// Does the tracker's own file name suggest an image?
///
/// Used ONLY as a reason to FETCH, never as a reason to skip — the type still comes from the bytes.
/// A `text/plain` claim on a file called `shot.png` is a contradiction, and a contradiction is
/// resolved by looking, not by believing whichever side was cheaper to read.
fn name_suggests_image(file_name: Option<&str>) -> bool {
    let Some(n) = file_name else { return false };
    let Some((_, ext)) = n.rsplit_once('.') else { return false };
    matches!(ext.to_ascii_lowercase().as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp")
}

/// Cap on ONE downloaded attachment.
///
/// Two places need it and both are unbounded without it: `http_get_bytes` reads the body into
/// memory, and `image_data_url` base64-encodes the whole file across the IPC boundary into a
/// webview. A ticket carrying a large video attachment is otherwise a renderer OOM. Generous
/// enough that a real screenshot — even a Retina full-page capture — is never refused.
pub const MAX_IMAGE_BYTES: usize = 12 * 1024 * 1024;

/// The directory every ticket's attachments live under. Also the CONTAINMENT BOUNDARY for
/// [`image_data_url`] — nothing outside it may be read back through that command.
pub fn attachment_root(root: &Path, settings: &IntakeSettings) -> PathBuf {
    let dir = settings.image_dir.trim();
    if dir.is_empty() {
        root.join(DEFAULT_IMAGE_DIR)
    } else if Path::new(dir).is_absolute() {
        PathBuf::from(dir)
    } else {
        root.join(dir)
    }
}

/// Where ONE ticket's attachments live.
pub fn attachment_dir(root: &Path, settings: &IntakeSettings, key: &str) -> PathBuf {
    attachment_root(root, settings).join(slugify(key))
}

/// The MIME type to label a stored attachment with, from its stored extension.
///
/// A file whose type we cannot name is `application/octet-stream`, never a guessed `image/png`:
/// an `<img>` given the wrong type renders nothing, and an SVG mislabelled as a PNG would be a
/// script-bearing document served under a type that says it is not one.
pub fn mime_for(path: &Path) -> &'static str {
    mime_for_ext(path.extension().and_then(|e| e.to_str()).unwrap_or_default())
}

/// The media type for a bare extension. Shared by [`mime_for`] and the download path, so the type
/// recorded on an [`IntakedImage`] and the one the read-back command emits cannot drift.
pub fn mime_for_ext(ext: &str) -> &'static str {
    match Some(ext.to_ascii_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    }
}

/// Read one stored attachment back as a `data:` URL.
///
/// WHY NOT `file://`. The webview's CSP is `img-src 'self' data:` (`tauri.conf.json`) and no asset
/// protocol is enabled, so a `file://` src renders a broken-image glyph — and it does so on the
/// images that SUCCEEDED, which is the worst possible place to be silent: the panel's
/// failed-download placeholder and its reason are shown only for `ok: false`, so a successful
/// download would look identical to a dead one and carry no explanation. Every other on-disk image
/// in this app is shown as a `data:` URL for exactly this reason.
///
/// CONTAINED to [`attachment_root`], by canonicalized prefix: this command takes a path from the
/// webview, so without the check it is an arbitrary-file-read primitive. SVG is deliberately not
/// in [`mime_for`]'s image list.
pub fn image_data_url(
    root: &Path,
    settings: &IntakeSettings,
    path: &Path,
) -> Result<String, String> {
    let base = attachment_root(root, settings)
        .canonicalize()
        .map_err(|e| format!("no ticket attachments have been downloaded yet: {e}"))?;
    let real = path
        .canonicalize()
        .map_err(|e| format!("could not read {}: {e}", path.to_string_lossy()))?;
    if !real.starts_with(&base) {
        return Err(format!(
            "{} is not inside this project's ticket attachment directory",
            path.to_string_lossy()
        ));
    }
    let size = std::fs::metadata(&real)
        .map_err(|e| format!("could not read {}: {e}", real.to_string_lossy()))?
        .len();
    // Bounded BEFORE the read, not after: base64 of the file crosses the IPC boundary into a
    // webview, so the cap has to stop the allocation rather than discover it.
    if size as usize > MAX_IMAGE_BYTES {
        return Err(format!(
            "{} is larger than the {} MiB attachment cap",
            real.to_string_lossy(),
            MAX_IMAGE_BYTES / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(&real)
        .map_err(|e| format!("could not read {}: {e}", real.to_string_lossy()))?;
    if bytes.is_empty() {
        return Err(format!("{} is empty", real.to_string_lossy()));
    }
    Ok(format!("data:{};base64,{}", mime_for(&real), STANDARD.encode(&bytes)))
}

/// Download every image NOW.
///
/// IMMEDIATELY, not lazily, and that is the whole reason this happens on the fetch path: Linear's
/// attachment links expire in about five minutes, so a URL persisted for later is a dead URL. Every
/// URL produces a row — a failed one with `ok: false` and a reason — so a caller can always say how
/// many there were as well as how many arrived.
pub fn download_images(
    io: &dyn IntakeIo,
    root: &Path,
    settings: &IntakeSettings,
    key: &str,
    refs: &[ImageRef],
    auth: Option<&ImageAuth>,
) -> Vec<IntakedImage> {
    if refs.is_empty() {
        return Vec::new();
    }
    let dir = attachment_dir(root, settings, key);
    let mut out = Vec::new();
    for r in refs {
        let url = &r.url;
        // The credential goes to the PROVIDER'S hosts and nowhere else — a ticket body can
        // reference an image on any host in the world. See `ImageAuth`.
        let headers = auth.map(|a| a.headers_for(url)).unwrap_or_default();
        let failed = |e: String| IntakedImage {
            source_url: url.clone(),
            local_path: None,
            ok: false,
            error: Some(e),
            bytes: 0,
            mime: String::new(),
        };
        // ASK THE METADATA FIRST. Where the tracker says outright that this is a `text/plain` or a
        // `application/pdf`, the row can be refused without spending a request on bytes we would
        // throw away — the count stays honest and nothing is fetched. A claim can only decline: an
        // `image/png` claim still goes through the sniff below, because a claim is not the bytes.
        if let Some(declared) = r.declared_mime.as_deref() {
            if claim_declines_image(declared) && !name_suggests_image(r.file_name.as_deref()) {
                out.push(failed(format!("{} is a {}, not an image", r.label(), declared.trim())));
                continue;
            }
        }
        out.push(match io.http_get_bytes(url, &headers) {
            Ok(bytes) if bytes.len() > MAX_IMAGE_BYTES => failed(format!(
                "{} is larger than the {} MiB attachment cap",
                url,
                MAX_IMAGE_BYTES / (1024 * 1024)
            )),
            Ok(bytes) => match sniff_image_mime(&bytes) {
                // A NON-IMAGE IS A REFUSED ROW, NOT A SILENT DROP. A ticket can attach a log, a
                // PDF or a zip, and an `<img>` pointed at one is a broken glyph on a row marked ok
                // with no reason. But dropping it before the count is just as dishonest in the
                // other direction — "0 images" for a ticket that had three. So it is carried,
                // refused, and named.
                None => failed(format!("{} is not an image", r.label())),
                Some((mime, ext)) => match store_image(&dir, ext, &bytes) {
                    Ok(path) => IntakedImage {
                        source_url: url.clone(),
                        local_path: Some(path),
                        ok: true,
                        error: None,
                        bytes: bytes.len() as u64,
                        mime: mime.to_string(),
                    },
                    Err(e) => failed(e),
                },
            },
            Err(e) => failed(e),
        });
    }
    out
}

/// Content-address and write. Same bytes twice is the same file — a ticket that embeds one
/// screenshot in the description and again in a comment stores it once.
fn store_image(dir: &Path, ext: &str, bytes: &[u8]) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("the download returned an empty body".to_string());
    }
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("could not create {}: {e}", dir.to_string_lossy()))?;
    let digest = Sha256::digest(bytes);
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    let name = format!("{hex}.{ext}");
    let path = dir.join(name);
    if !path.exists() {
        std::fs::write(&path, bytes)
            .map_err(|e| format!("could not write {}: {e}", path.to_string_lossy()))?;
    }
    Ok(path.to_string_lossy().to_string())
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Intake
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// Fetch ONE reference: provider call, then images, then the derived naming.
///
/// An AMBIGUOUS ref is refused here rather than resolved — the parser already decided it could not
/// tell, and a fetch is not a better place to guess.
pub fn fetch_one(
    io: &dyn IntakeIo,
    root: &Path,
    settings: &IntakeSettings,
    r: &TicketRef,
) -> Result<IntakedTicket, String> {
    if !settings.enabled {
        return Err(
            "ticket intake is switched off — set [ticket_intake].enabled = true to use it"
                .to_string(),
        );
    }
    let Some(provider) = r.provider else {
        let names: Vec<&str> = r.candidates.iter().map(|p| p.label()).collect();
        return Err(format!(
            "{} could be {} — choose a provider, or set [ticket_intake].default_provider",
            r.key,
            if names.is_empty() { "more than one tracker".to_string() } else { names.join(" or ") }
        ));
    };
    let ps = settings.provider_settings(provider);
    if !ps.enabled {
        return Err(format!(
            "{} is switched off — set [ticket_intake.{}].enabled = true",
            provider.label(),
            provider.slug()
        ));
    }
    let p = provider_for(provider);
    // ONE resolution, shared by the ticket call and every attachment download — see
    // `TicketProvider::credential`.
    let cred = p.credential(io, settings)?;
    let raw = p.fetch(io, root, settings, &r.key, cred.as_deref())?;
    let auth = p.image_auth(settings, cred.as_deref());
    let images = download_images(io, root, settings, &r.key, &raw.images, auth.as_ref());
    let title = if raw.title.trim().is_empty() { None } else { Some(raw.title.trim()) };
    let branch = derive_branch(settings, &r.key, title);
    let commit_prefix = derive_commit_prefix(settings, &r.key, Some(provider));
    let pr_title = derive_pr_title(&commit_prefix, title);
    Ok(IntakedTicket {
        provider,
        key: r.key.clone(),
        title: raw.title,
        body: raw.body,
        comments: raw.comments,
        images,
        branch,
        commit_prefix,
        pr_title,
        url: raw.url.or_else(|| r.url.clone()),
    })
}

/// Fetch many. PER-REF outcomes: one failure never discards a sibling's result.
pub fn fetch_batch(
    io: &dyn IntakeIo,
    root: &Path,
    settings: &IntakeSettings,
    refs: &[TicketRef],
) -> BatchResult {
    let mut tickets = Vec::new();
    let mut failures = Vec::new();
    for r in refs {
        match fetch_one(io, root, settings, r) {
            Ok(t) => tickets.push(t),
            Err(e) => failures.push(RefFailure {
                raw: r.raw.clone(),
                key: r.key.clone(),
                provider: r.provider,
                error: e,
            }),
        }
    }
    BatchResult { tickets, failures }
}

/// What the UI needs to decide what it may offer. NO CREDENTIAL crosses this boundary — only
/// whether one is present, and how it is supplied.
pub fn status_for(settings: &IntakeSettings) -> TicketIntakeStatus {
    let providers = [Provider::Linear, Provider::Jira, Provider::Github, Provider::Beads]
        .into_iter()
        .map(|p| {
            let ps = settings.provider_settings(p);
            let (configured, note) = match p {
                Provider::Github => (
                    true,
                    "uses the `gh` CLI already signed in on this machine".to_string(),
                ),
                Provider::Beads => (
                    true,
                    "reads the local beads store with `bd show` (full ids only)".to_string(),
                ),
                Provider::Jira if ps.base_url.trim().is_empty() => {
                    (false, "set [ticket_intake.jira].base_url to your site".to_string())
                }
                _ if ps.api_key.is_empty() => (
                    false,
                    format!(
                        "set [ticket_intake.{}].api_key — a token, or an op:// reference",
                        p.slug()
                    ),
                ),
                _ if ps.api_key.is_op_reference() => {
                    (true, "credential resolved from 1Password at fetch time".to_string())
                }
                _ => (true, "credential configured".to_string()),
            };
            ProviderStatus { provider: p, enabled: ps.enabled, configured, note }
        })
        .collect();
    TicketIntakeStatus {
        enabled: settings.enabled,
        default_provider: settings.default_provider,
        providers,
        image_dir: settings.image_dir.clone(),
    }
}

fn settings_for(project_root: &str) -> IntakeSettings {
    let mut settings =
        crate::config::for_project(project_root).config.ticket_intake.to_intake_settings();
    // Discovered from the repo, not configured — see `IntakeSettings::beads_prefixes`. This is the
    // line that makes `` (a plain-letter id) recognizable at all, so it is covered by
    // `beads_prefixes_for_reads_the_projects_own_files`.
    settings.beads_prefixes = beads_prefixes_for(Path::new(project_root));
    settings
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Tauri commands — all async, none on the main thread
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// Parse pasted text into references. No network, no credential — this works with intake switched
/// off, because reading a key out of a paste is useful on its own.
#[tauri::command]
pub async fn ticket_intake_parse(project_root: String, text: String) -> Vec<TicketRef> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = settings_for(&project_root);
        parse_refs(&text, &settings)
    })
    .await
    .unwrap_or_default()
}

/// Fetch a batch of references. `spawn_blocking` unconditionally: this makes network calls and
/// spawns subprocesses, and a synchronous `#[tauri::command]` body runs on the MAIN thread.
#[tauri::command]
pub async fn ticket_intake_fetch(project_root: String, text: String) -> BatchResult {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = settings_for(&project_root);
        let refs = parse_refs(&text, &settings);
        let io = default_io();
        fetch_batch(io.as_ref(), Path::new(&project_root), &settings, &refs)
    })
    .await
    .unwrap_or_else(|e| BatchResult {
        tickets: Vec::new(),
        failures: vec![RefFailure {
            raw: String::new(),
            key: String::new(),
            provider: None,
            error: format!("ticket intake panicked: {e}"),
        }],
    })
}

/// One downloaded screenshot, as a `data:` URL the webview may actually render.
///
/// `spawn_blocking`: this reads a file and base64-encodes it, and a synchronous command body runs
/// on the MAIN thread.
#[tauri::command]
pub async fn ticket_intake_image(project_root: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = settings_for(&project_root);
        image_data_url(Path::new(&project_root), &settings, Path::new(&path))
    })
    .await
    .map_err(|e| format!("reading the attachment panicked: {e}"))?
}

/// Is intake on, and which providers can be used.
#[tauri::command]
pub async fn ticket_intake_status(project_root: String) -> TicketIntakeStatus {
    tauri::async_runtime::spawn_blocking(move || status_for(&settings_for(&project_root)))
        .await
        .unwrap_or_else(|_| TicketIntakeStatus {
            // A status we could not compute must not read as "on and ready".
            enabled: false,
            default_provider: None,
            providers: Vec::new(),
            image_dir: DEFAULT_IMAGE_DIR.to_string(),
        })
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    /// ONE fake for every outside call, so a provider test needs no network, no `gh`, no `bd` and
    /// no credential. Every method records what it was asked for — the tests assert on the ARGV and
    /// the URL, not merely on the return value.
    #[derive(Default)]
    struct FakeIo {
        gets: Mutex<HashMap<String, Result<String, String>>>,
        post: Mutex<Option<Result<String, String>>>,
        bytes: Mutex<HashMap<String, Result<Vec<u8>, String>>>,
        run: Mutex<Option<Result<String, String>>>,
        op: Mutex<Option<Result<String, String>>>,
        calls: Mutex<Vec<String>>,
        /// The headers of the last HTTP call, so a test can prove the resolved credential was
        /// actually used rather than merely resolved.
        headers: Mutex<Vec<(String, String)>>,
        /// The headers of EVERY byte fetch, keyed by url. A single "last call" slot cannot answer
        /// the question that matters for attachments — whether the credential went to OUR host and
        /// to no other one.
        byte_headers: Mutex<Vec<(String, Vec<(String, String)>)>>,
    }

    impl FakeIo {
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
        /// What was sent with the byte fetch of `url`. `None` when it was never fetched.
        fn headers_sent_to(&self, url: &str) -> Option<Vec<(String, String)>> {
            self.byte_headers
                .lock()
                .unwrap()
                .iter()
                .find(|(u, _)| u == url)
                .map(|(_, h)| h.clone())
        }
        fn with_post(self, body: &str) -> Self {
            *self.post.lock().unwrap() = Some(Ok(body.to_string()));
            self
        }
        fn with_get(self, url_fragment: &str, body: &str) -> Self {
            self.gets.lock().unwrap().insert(url_fragment.to_string(), Ok(body.to_string()));
            self
        }
        fn with_run(self, out: &str) -> Self {
            *self.run.lock().unwrap() = Some(Ok(out.to_string()));
            self
        }
        fn with_op(self, value: &str) -> Self {
            *self.op.lock().unwrap() = Some(Ok(value.to_string()));
            self
        }
        fn with_bytes(self, url: &str, bytes: &[u8]) -> Self {
            self.bytes.lock().unwrap().insert(url.to_string(), Ok(bytes.to_vec()));
            self
        }
        fn with_dead_url(self, url: &str, why: &str) -> Self {
            self.bytes.lock().unwrap().insert(url.to_string(), Err(why.to_string()));
            self
        }
    }

    impl IntakeIo for FakeIo {
        fn http_get(&self, url: &str, headers: &[(String, String)]) -> Result<String, String> {
            self.calls.lock().unwrap().push(format!("GET {url}"));
            *self.headers.lock().unwrap() = headers.to_vec();
            let gets = self.gets.lock().unwrap();
            for (frag, reply) in gets.iter() {
                if url.contains(frag.as_str()) {
                    return reply.clone();
                }
            }
            Err(format!("the fake has no GET for {url}"))
        }
        fn http_post(
            &self,
            url: &str,
            headers: &[(String, String)],
            body: &str,
        ) -> Result<String, String> {
            self.calls.lock().unwrap().push(format!("POST {url} {body}"));
            *self.headers.lock().unwrap() = headers.to_vec();
            self.post
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| Err(format!("the fake has no POST for {url}")))
        }
        fn http_get_bytes(&self, url: &str, headers: &[(String, String)]) -> Result<Vec<u8>, String> {
            self.calls.lock().unwrap().push(format!("BYTES {url}"));
            self.byte_headers.lock().unwrap().push((url.to_string(), headers.to_vec()));
            self.bytes
                .lock()
                .unwrap()
                .get(url)
                .cloned()
                .unwrap_or_else(|| Err(format!("the fake has no bytes for {url}")))
        }
        fn run(&self, program: &str, args: &[String], _cwd: Option<&Path>) -> Result<String, String> {
            self.calls.lock().unwrap().push(format!("RUN {program} {}", args.join(" ")));
            self.run
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| Err(format!("the fake has no run for {program}")))
        }
        fn op_read(&self, reference: &str) -> Result<String, String> {
            self.calls.lock().unwrap().push(format!("OP {reference}"));
            self.op
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| Err(format!("the fake has no op read for {reference}")))
        }
    }

    /// The urls of a `RawTicket`'s image refs — most assertions care about order, not file names.
    fn urls(refs: &[ImageRef]) -> Vec<&str> {
        refs.iter().map(|r| r.url.as_str()).collect()
    }

    fn settings() -> IntakeSettings {
        IntakeSettings { enabled: true, ..IntakeSettings::default() }
    }

    /// Settings for a project whose bead prefix IS known — the ordinary case, since a user pastes
    /// ids from the repo they are standing in.
    fn beads_settings() -> IntakeSettings {
        IntakeSettings { beads_prefixes: vec!["sparkle".to_string()], ..settings() }
    }

    // ── the parser ─────────────────────────────────────────────────────────────────────────────

    #[test]
    fn a_bare_key_is_ambiguous_when_no_default_provider_is_set() {
        let refs = parse_refs("ENG-1234", &settings());
        assert_eq!(refs.len(), 1);
        assert!(refs[0].ambiguous, "a bare key is valid in Linear AND Jira");
        assert_eq!(refs[0].provider, None, "ambiguity must never be resolved by guessing");
        assert_eq!(refs[0].candidates, vec![Provider::Linear, Provider::Jira]);
        assert!(
            refs[0].note.as_deref().unwrap_or_default().contains("default_provider"),
            "the note must tell the reader how to resolve it: {:?}",
            refs[0].note
        );
    }

    #[test]
    fn a_configured_default_resolves_a_bare_key_and_says_where_the_answer_came_from() {
        let s = IntakeSettings { default_provider: Some(Provider::Linear), ..settings() };
        let refs = parse_refs("ENG-1234", &s);
        assert_eq!(refs[0].provider, Some(Provider::Linear));
        assert!(!refs[0].ambiguous);
        let note = refs[0].note.clone().expect("a defaulted answer must explain itself");
        assert!(note.contains("default_provider"), "{note}");
        assert!(note.contains("Linear"), "{note}");
    }

    #[test]
    fn one_enabled_tracker_is_not_ambiguity() {
        let mut s = settings();
        s.jira.enabled = false;
        let refs = parse_refs("ENG-1234", &s);
        assert_eq!(refs[0].provider, Some(Provider::Linear));
        assert!(!refs[0].ambiguous);
    }

    #[test]
    fn parses_a_linear_url_with_a_slug() {
        let refs = parse_refs(
            "have a look at https://linear.app/acme/issue/ENG-1234/fix-the-login-crash please",
            &settings(),
        );
        assert_eq!(refs.len(), 1, "the slug must not become a second reference: {refs:?}");
        assert_eq!(refs[0].provider, Some(Provider::Linear));
        assert_eq!(refs[0].key, "ENG-1234");
        assert_eq!(
            refs[0].url.as_deref(),
            Some("https://linear.app/acme/issue/ENG-1234/fix-the-login-crash")
        );
        assert!(!refs[0].ambiguous, "a linear.app URL is not ambiguous");
    }

    #[test]
    fn parses_a_jira_browse_url_and_an_atlassian_cloud_url() {
        let refs = parse_refs(
            "https://acme.atlassian.net/browse/ABC-123 and \
             https://other.atlassian.net/jira/software/projects/XY/boards/1?selectedIssue=XY-9",
            &settings(),
        );
        let keys: Vec<&str> = refs.iter().map(|r| r.key.as_str()).collect();
        assert_eq!(keys, vec!["ABC-123", "XY-9"], "{refs:?}");
        assert!(refs.iter().all(|r| r.provider == Some(Provider::Jira)));
    }

    #[test]
    fn parses_a_github_issue_url_a_repo_hash_and_a_bare_hash() {
        let refs = parse_refs(
            "https://github.com/drodio/sparkle/issues/2278, also try-sparkle/sparkle#7 and #42",
            &settings(),
        );
        let keys: Vec<&str> = refs.iter().map(|r| r.key.as_str()).collect();
        assert_eq!(keys, vec!["drodio/sparkle#2278", "try-sparkle/sparkle#7", "#42"]);
        assert!(refs.iter().all(|r| r.provider == Some(Provider::Github)));
    }

    #[test]
    fn parses_a_beads_id_including_a_child() {
        let refs = parse_refs("blocked on .6 (parent )", &beads_settings());
        let keys: Vec<&str> = refs.iter().map(|r| r.key.as_str()).collect();
        assert_eq!(keys, vec![".6", ""]);
        assert!(refs.iter().all(|r| r.provider == Some(Provider::Beads)));
    }

    #[test]
    fn a_lowercase_key_canonicalizes_to_uppercase() {
        let s = IntakeSettings { default_provider: Some(Provider::Jira), ..settings() };
        let refs = parse_refs("picking up eng-1234 today", &s);
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].key, "ENG-1234", "eng-1234 and ENG-1234 are the same ticket");
        assert_eq!(refs[0].raw, "eng-1234", "the raw text is preserved for the UI");
    }

    #[test]
    fn a_key_inside_a_sentence_is_found() {
        let s = IntakeSettings { default_provider: Some(Provider::Linear), ..settings() };
        let refs = parse_refs("Can you take ENG-77, then hand ENG-78 to Luis?", &s);
        let keys: Vec<&str> = refs.iter().map(|r| r.key.as_str()).collect();
        assert_eq!(keys, vec!["ENG-77", "ENG-78"]);
    }

    #[test]
    fn a_hyphenated_english_word_is_not_a_bead_id() {
        // `sparkle-jehei` and `well-known` are the SAME SHAPE, so nothing in the string settles it
        // and the parser must not take every match — this is the regression that turned a Linear
        // URL's title slug into two tickets.
        let refs = parse_refs(
            "please re-run the check-in flow; it is a well-known long-term fix-the-login problem",
            &beads_settings(),
        );
        assert!(refs.is_empty(), "prose must not become tickets: {refs:?}");
    }

    #[test]
    fn a_known_prefix_makes_a_plain_letter_id_recognizable() {
        // With no prefix known the conservative rule misses it, and that is the stated trade.
        assert!(parse_refs("sparkle-jehei", &settings()).is_empty());
        let refs = parse_refs("sparkle-jehei", &beads_settings());
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].provider, Some(Provider::Beads));
    }

    #[test]
    fn an_unmistakable_shape_is_taken_even_from_an_unknown_project() {
        for id in ["other-16y6h", "other-bqo.6"] {
            let refs = parse_refs(id, &settings());
            assert_eq!(refs.len(), 1, "{id} should be read as a bead id: {refs:?}");
            assert_eq!(refs[0].provider, Some(Provider::Beads));
        }
    }

    #[test]
    fn a_urls_path_is_never_re_scanned_as_prose() {
        // The whole URL span is claimed, not merely the part that matched — an unclaimed slug or
        // query string is scanned as text, where its words look exactly like bead ids.
        let refs = parse_refs(
            "https://linear.app/acme/issue/ENG-1234/fix-the-login-crash \n\
             https://example.com/docs/some-long-page-name",
            &beads_settings(),
        );
        assert_eq!(refs.len(), 1, "{refs:?}");
        assert_eq!(refs[0].key, "ENG-1234");
    }

    #[test]
    fn beads_prefixes_for_reads_the_projects_own_files() {
        let dir = tmp();
        assert!(beads_prefixes_for(dir.path()).is_empty(), "no .beads is not a failure");

        std::fs::create_dir_all(dir.path().join(".beads")).unwrap();
        std::fs::write(
            dir.path().join(".beads/metadata.json"),
            r#"{"backend":"dolt","dolt_database":"sparkle"}"#,
        )
        .unwrap();
        assert_eq!(beads_prefixes_for(dir.path()), vec!["sparkle".to_string()]);

        // A COMMENTED-OUT issue-prefix is the common case and must not be read as a value.
        std::fs::write(
            dir.path().join(".beads/config.yaml"),
            "# issue-prefix: \"commented\"\nissue-prefix: \"acme\"\n",
        )
        .unwrap();
        assert_eq!(
            beads_prefixes_for(dir.path()),
            vec!["acme".to_string(), "sparkle".to_string()]
        );
    }

    #[test]
    fn text_with_no_ticket_in_it_yields_nothing() {
        let refs = parse_refs(
            "The login page is slow on Safari. It takes 3-4 seconds to paint.",
            &settings(),
        );
        assert!(refs.is_empty(), "prose must not be forced into a ticket: {refs:?}");
    }

    #[test]
    fn a_url_does_not_also_report_its_key_as_a_separate_bare_reference() {
        let refs = parse_refs("https://linear.app/acme/issue/ENG-1234/slug", &settings());
        assert_eq!(refs.len(), 1);
        assert!(!refs[0].ambiguous, "the URL already said which tracker it is");
    }

    #[test]
    fn the_same_ticket_pasted_twice_is_one_reference() {
        let s = IntakeSettings { default_provider: Some(Provider::Linear), ..settings() };
        let refs = parse_refs("ENG-1 and again ENG-1", &s);
        assert_eq!(refs.len(), 1);
    }

    #[test]
    fn a_key_in_an_unfamiliar_host_url_is_reported_not_guessed() {
        let refs = parse_refs("https://jira.internal.acme.com/issue/ABC-99", &settings());
        assert_eq!(refs.len(), 1);
        assert!(refs[0].ambiguous, "an unknown host is not evidence of a provider");
        assert_eq!(refs[0].key, "ABC-99");
        let note = refs[0].note.clone().unwrap_or_default();
        assert!(note.contains("jira.internal.acme.com"), "the host must be named: {note}");
    }

    // ── the derivation ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn derives_branch_commit_prefix_and_pr_title_from_a_key_alone() {
        let s = IntakeSettings { default_provider: Some(Provider::Linear), ..settings() };
        let refs = parse_refs("ENG-1234", &s);
        assert_eq!(refs[0].branch, "eng-1234");
        assert_eq!(refs[0].commit_prefix, "ENG-1234:");
        assert_eq!(
            refs[0].pr_title, "ENG-1234:",
            "with no fetched title the PR title is the prefix — never an invented subject"
        );
    }

    #[test]
    fn a_fetched_title_becomes_the_branch_slug_and_the_pr_subject() {
        let s = settings();
        assert_eq!(
            derive_branch(&s, "ENG-1234", Some("Fix the login crash on Safari")),
            "eng-1234-fix-the-login-crash-on-safari"
        );
        assert_eq!(
            derive_pr_title("ENG-1234:", Some("Fix the login crash")),
            "ENG-1234: Fix the login crash"
        );
    }

    #[test]
    fn a_long_title_is_cut_on_a_word_boundary() {
        let s = settings();
        let b = derive_branch(&s, "ENG-1", Some(&"alpha bravo charlie delta echo foxtrot golf hotel india juliet".to_string()));
        assert!(b.len() <= 60, "{b}");
        assert!(!b.ends_with('-'), "{b}");
        assert!(b.starts_with("eng-1-alpha-bravo"), "{b}");
    }

    #[test]
    fn a_beads_key_makes_a_legal_branch_name() {
        let s = settings();
        assert_eq!(derive_branch(&s, ".6", None), "-6");
        assert_eq!(derive_branch(&s, "owner/repo#123", None), "owner-repo-123");
    }

    #[test]
    fn a_custom_template_is_honoured() {
        let s = IntakeSettings {
            branch_template: "tickets/{key_lower}".to_string(),
            commit_prefix_template: "[{key}]".to_string(),
            default_provider: Some(Provider::Jira),
            ..settings()
        };
        let refs = parse_refs("ABC-9", &s);
        assert_eq!(refs[0].branch, "tickets-abc-9");
        assert_eq!(refs[0].commit_prefix, "[ABC-9]");
    }

    // ── the credential ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn a_secret_is_redacted_in_debug_and_in_json() {
        let s = Secret::new("lin_api_SUPERSECRETVALUE");
        assert_eq!(format!("{s:?}"), "Secret(<redacted>)");
        assert!(!format!("{s:?}").contains("SUPERSECRET"));
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(json, "\"<redacted>\"");
        assert!(!json.contains("SUPERSECRET"));
    }

    #[test]
    fn an_unset_secret_is_distinguishable_from_a_set_one_on_the_wire() {
        assert_eq!(serde_json::to_string(&Secret::default()).unwrap(), "\"\"");
        assert_eq!(format!("{:?}", Secret::default()), "Secret(<unset>)");
    }

    #[test]
    fn a_whole_settings_struct_carries_no_credential_into_debug_output() {
        let s = IntakeSettings {
            linear: ProviderSettings {
                enabled: true,
                base_url: String::new(),
                api_key: Secret::new("lin_api_SUPERSECRETVALUE"),
            },
            ..settings()
        };
        let dumped = format!("{s:?}");
        assert!(!dumped.contains("SUPERSECRET"), "a Debug of the settings leaked the key: {dumped}");
        assert!(dumped.contains(REDACTED));
    }

    #[test]
    fn expose_still_returns_the_real_value() {
        assert_eq!(Secret::new(" tok_123 ").expose(), "tok_123");
        assert!(Secret::new("op://Private/Linear/credential").is_op_reference());
        assert!(!Secret::new("tok_123").is_op_reference());
    }

    #[test]
    fn status_reports_readiness_without_any_credential_in_it() {
        let s = IntakeSettings {
            linear: ProviderSettings {
                enabled: true,
                base_url: String::new(),
                api_key: Secret::new("lin_api_SUPERSECRETVALUE"),
            },
            ..settings()
        };
        let st = status_for(&s);
        let json = serde_json::to_string(&st).unwrap();
        assert!(!json.contains("SUPERSECRET"), "{json}");
        let linear = st.providers.iter().find(|p| p.provider == Provider::Linear).unwrap();
        assert!(linear.configured);
        let jira = st.providers.iter().find(|p| p.provider == Provider::Jira).unwrap();
        assert!(!jira.configured, "no base_url means Jira cannot be called");
        assert!(jira.note.contains("base_url"), "{}", jira.note);
    }

    // ── the argv builders ──────────────────────────────────────────────────────────────────────

    #[test]
    fn bd_argv_passes_the_full_id_and_bounds_the_call_with_timeout_sh() {
        let dir = tmp();
        std::fs::create_dir_all(dir.path().join("scripts")).unwrap();
        std::fs::write(dir.path().join("scripts/timeout.sh"), "#!/bin/sh\n").unwrap();
        let (program, args) = bd_argv(dir.path(), ".6");
        assert!(program.ends_with("scripts/timeout.sh"), "{program}");
        assert_eq!(
            args,
            vec![
                BD_TIMEOUT_SECS.to_string(),
                "bd".to_string(),
                "show".to_string(),
                ".6".to_string(),
            ],
            "the id is passed WHOLE — bd show matches a prefix loosely and returns another bead"
        );
    }

    #[test]
    fn bd_argv_falls_back_to_a_bare_bd_when_the_script_is_absent() {
        let dir = tmp();
        let (program, args) = bd_argv(dir.path(), ".6");
        assert_eq!(program, "bd");
        assert_eq!(args, vec!["show".to_string(), ".6".to_string()]);
    }

    #[test]
    fn gh_argv_names_the_repo_only_when_the_key_carries_one() {
        assert_eq!(
            gh_argv("drodio/sparkle#42").unwrap(),
            vec!["issue", "view", "42", "--repo", "drodio/sparkle", "--json", "title,body,url,comments"]
        );
        assert_eq!(
            gh_argv("#42").unwrap(),
            vec!["issue", "view", "42", "--json", "title,body,url,comments"]
        );
        assert!(gh_argv("ENG-1234").is_err());
    }

    // ── the providers ──────────────────────────────────────────────────────────────────────────

    /// A Linear issue as the API serves one. The attachment list carries what Linear actually puts
    /// there: an uploaded file AND the link nodes it auto-creates for a GitHub PR and a Figma file.
    const LINEAR_OK: &str = r#"{"data":{"issue":{
        "identifier":"ENG-1234","title":"Fix the login crash","url":"https://linear.app/acme/issue/ENG-1234",
        "description":"It crashes.\n![shot](https://uploads.linear.app/a.png)",
        "comments":{"nodes":[{"body":"also ![two](https://uploads.linear.app/b.png)"}]},
        "attachments":{"nodes":[
          {"url":"https://uploads.linear.app/c.png","title":"console.png"},
          {"url":"https://github.com/acme/web/pull/412","title":"Fix the login crash"},
          {"url":"https://www.figma.com/file/abc/Login","title":"Login redesign"}]}}}}"#;

    #[test]
    fn a_linear_graphql_error_is_an_error_not_an_empty_ticket() {
        let err = parse_linear_response(
            r#"{"errors":[{"message":"Authentication required"}]}"#,
            "ENG-1",
        )
        .unwrap_err();
        assert!(err.contains("Authentication required"), "{err}");
    }

    #[test]
    fn a_null_issue_is_an_error_not_an_empty_ticket() {
        let err = parse_linear_response(r#"{"data":{"issue":null}}"#, "ENG-1").unwrap_err();
        assert!(err.contains("ENG-1"), "{err}");
    }

    #[test]
    fn linear_collects_images_from_the_description_the_comments_and_the_attachments() {
        let raw = parse_linear_response(LINEAR_OK, "ENG-1234").unwrap();
        assert_eq!(raw.title, "Fix the login crash");
        assert_eq!(raw.comments.len(), 1);
        assert_eq!(
            urls(&raw.images),
            vec![
                "https://uploads.linear.app/a.png",
                "https://uploads.linear.app/b.png",
                "https://uploads.linear.app/c.png",
            ],
            "an image in a COMMENT is as much a screenshot as one in the description"
        );
    }

    /// A Jira Cloud v3 issue, in the shapes the API actually emits:
    ///   * an UPLOADED screenshot is a `media` node carrying only `id`/`collection` — NO url;
    ///   * an EXTERNAL image is a `media` node with `attrs.type = "external"` and a url;
    ///   * a link is a MARK on a text node, not a node;
    ///   * `fields.attachment[].id` is a NUMBER, while the ADF `media` id is a string.
    const JIRA_OK: &str = r#"{"fields":{
        "summary":"Login is slow",
        "description":{"type":"doc","content":[
          {"type":"paragraph","content":[
            {"type":"text","text":"Takes 4s to paint, see "},
            {"type":"text","text":"the trace","marks":[{"type":"link","attrs":{"href":"https://acme.example/trace"}}]}]},
          {"type":"mediaSingle","content":[{"type":"media","attrs":{"type":"file","id":"10021","collection":"contentId-10001","width":800}}]},
          {"type":"mediaSingle","content":[{"type":"media","attrs":{"type":"external","url":"https://cdn.example/outside.png"}}]}]},
        "comment":{"comments":[{"body":{"type":"doc","content":[
          {"type":"paragraph","content":[{"type":"text","text":"Repro on Safari."}]}]}}]},
        "attachment":[
          {"id":10021,"filename":"shot.png","mimeType":"image/png","content":"https://acme.atlassian.net/rest/api/3/attachment/content/10021"},
          {"id":10022,"filename":"log.txt","mimeType":"text/plain","content":"https://acme.atlassian.net/rest/api/3/attachment/content/10022"}]}}"#;

    #[test]
    fn a_linear_LINK_attachment_is_never_fetched_and_is_not_a_row() {
        // Linear auto-creates an attachment node for every linked GitHub PR, Slack thread, Figma
        // file and Sentry issue — the common case. Folding those in would GET a third-party URL
        // derived from ticket content on the intake path, get HTML back, and paint
        // "3 images, 2 could not be fetched" for a ticket with one screenshot.
        let dir = tmp();
        let io = FakeIo::default()
            .with_post(LINEAR_OK)
            .with_bytes("https://uploads.linear.app/a.png", &png())
            .with_bytes("https://uploads.linear.app/b.png", &png())
            .with_bytes("https://uploads.linear.app/c.png", &png());
        let s = linear_settings();
        let refs = parse_refs("ENG-1234", &s);
        let t = fetch_one(&io, dir.path(), &s, &refs[0]).unwrap();
        assert_eq!(t.images.len(), 3, "only the uploads are rows: {:?}", t.images);
        assert!(t.images.iter().all(|i| i.ok));
        for host in ["github.com", "figma.com"] {
            assert!(
                !io.calls().iter().any(|c| c.starts_with("BYTES") && c.contains(host)),
                "a request went out to {host}: {:?}",
                io.calls()
            );
        }
    }

    #[test]
    fn the_linear_query_asks_for_every_field_the_parser_reads() {
        // `title` is read off an attachment node; if the query does not SELECT it, the field is
        // absent from every real response and the read describes a payload this client cannot
        // receive (bead sparkle-16y6h) — invisible to a hand-authored fixture that carries it.
        for field in ["title", "description", "url", "comments", "attachments"] {
            assert!(LINEAR_QUERY.contains(field), "LINEAR_QUERY does not select `{field}`");
        }
        assert!(
            LINEAR_QUERY.contains("attachments { nodes { url title } }"),
            "the attachment selection must carry the fields the parser reads: {LINEAR_QUERY}"
        );
    }

    #[test]
    fn a_refused_linear_upload_is_named_by_its_title_not_its_url() {
        let dir = tmp();
        let io = FakeIo::default()
            .with_post(LINEAR_OK)
            .with_bytes("https://uploads.linear.app/a.png", &png())
            .with_bytes("https://uploads.linear.app/b.png", &png())
            // The uploaded attachment is not actually an image.
            .with_bytes("https://uploads.linear.app/c.png", b"%PDF-1.7");
        let s = linear_settings();
        let refs = parse_refs("ENG-1234", &s);
        let t = fetch_one(&io, dir.path(), &s, &refs[0]).unwrap();
        let refused = t.images.iter().find(|i| !i.ok).expect("a refused row");
        assert_eq!(refused.error.as_deref(), Some("console.png is not an image"));
    }

    #[test]
    fn a_jira_declared_non_image_is_refused_WITHOUT_spending_a_request() {
        // Jira states the type in the attachment metadata, so `log.txt` can be refused from that
        // alone — the count stays honest and no bytes are downloaded to be thrown away.
        let dir = tmp();
        let io = FakeIo::default();
        let images = download_images(
            &io,
            dir.path(),
            &settings(),
            "ABC-1",
            &[ImageRef {
                url: "https://acme.atlassian.net/rest/api/3/attachment/content/10022".into(),
                file_name: Some("log.txt".into()),
                declared_mime: Some("text/plain".into()),
            }],
            None,
        );
        assert_eq!(images.len(), 1);
        assert!(!images[0].ok);
        assert_eq!(images[0].error.as_deref(), Some("log.txt is a text/plain, not an image"));
        assert!(io.calls().is_empty(), "nothing should have been fetched: {:?}", io.calls());
    }

    #[test]
    fn a_declared_image_is_still_SNIFFED_because_a_claim_is_not_the_bytes() {
        let dir = tmp();
        let io = FakeIo::default().with_bytes("https://x/claimed", b"%PDF-1.7");
        let images = download_images(
            &io,
            dir.path(),
            &settings(),
            "ABC-1",
            &[ImageRef {
                url: "https://x/claimed".into(),
                file_name: Some("shot.png".into()),
                declared_mime: Some("image/png".into()),
            }],
            None,
        );
        assert!(!images[0].ok, "a claim must not be able to certify: {images:?}");
        assert_eq!(images[0].error.as_deref(), Some("shot.png is not an image"));
    }

    #[test]
    fn the_jira_parser_carries_the_declared_type() {
        // ASSERTS `declared_mime`, which is the thing this test is named for. Asserting the
        // filename instead was vacuous: it was already true before the field existed, so the key
        // could be misspelled (`mimetype`) and every test would stay green while the "refuse
        // without a request" path was inert for every real ticket.
        let raw = parse_jira_response(JIRA_OK, "ABC-1").unwrap();
        let log = raw
            .images
            .iter()
            .find(|r| r.file_name.as_deref() == Some("log.txt"))
            .expect("the log attachment");
        assert_eq!(log.declared_mime.as_deref(), Some("text/plain"));
        let shot = raw
            .images
            .iter()
            .find(|r| r.file_name.as_deref() == Some("shot.png"))
            .expect("the screenshot attachment");
        assert_eq!(shot.declared_mime.as_deref(), Some("image/png"));
    }

    #[test]
    fn a_jira_fetch_refuses_the_log_without_a_request_and_still_gets_the_screenshot() {
        // The end-to-end pair the parse-side assertion above cannot give on its own.
        let dir = tmp();
        let io = FakeIo::default()
            .with_get("/rest/api/3/issue/ABC-1", JIRA_OK)
            .with_bytes("https://acme.atlassian.net/rest/api/3/attachment/content/10021", &png())
            .with_bytes("https://cdn.example/outside.png", &png());
        let s = IntakeSettings {
            default_provider: Some(Provider::Jira),
            jira: ProviderSettings {
                enabled: true,
                base_url: "https://acme.atlassian.net".to_string(),
                api_key: Secret::new("a@b.com:tok"),
            },
            ..settings()
        };
        let refs = parse_refs("ABC-1", &s);
        let t = fetch_one(&io, dir.path(), &s, &refs[0]).unwrap();
        let log = t.images.iter().find(|i| i.source_url.ends_with("/10022")).expect("the log row");
        assert!(!log.ok);
        assert_eq!(log.error.as_deref(), Some("log.txt is a text/plain, not an image"));
        assert!(
            !io.calls().iter().any(|c| c.starts_with("BYTES") && c.contains("/10022")),
            "the log was fetched anyway: {:?}",
            io.calls()
        );
        let shot = t.images.iter().find(|i| i.source_url.ends_with("/10021")).expect("the shot row");
        assert!(shot.ok, "{shot:?}");
        assert_eq!(shot.mime, "image/png");
    }

    #[test]
    fn an_unknown_type_claim_is_a_shrug_and_must_not_refuse_a_real_screenshot() {
        // Jira's mimeType is whatever the uploading client sent, so a genuine PNG arriving through
        // a Slack/email bridge or curl lands as application/octet-stream. Refusing on that never
        // reads the bytes — the URL-guessing regression the sniff replaced, through a side door.
        let dir = tmp();
        for claim in [
            "application/octet-stream",
            "binary/octet-stream",
            "application/x-download",
            "",
            "garbage",
        ] {
            let io = FakeIo::default().with_bytes("https://x/unknown", &png());
            let images = download_images(
                &io,
                dir.path(),
                &settings(),
                "ABC-1",
                &[ImageRef {
                    url: "https://x/unknown".into(),
                    file_name: None,
                    declared_mime: Some(claim.to_string()),
                }],
                None,
            );
            assert!(images[0].ok, "claim {claim:?} refused a real PNG: {images:?}");
            assert_eq!(images[0].mime, "image/png");
        }
    }

    #[test]
    fn a_claim_that_CONTRADICTS_the_file_name_is_resolved_by_the_bytes() {
        // `text/plain` on a file called shot.png is a contradiction. Believing the cheaper side
        // would refuse a real screenshot; looking costs one request and cannot be wrong.
        let dir = tmp();
        let io = FakeIo::default().with_bytes("https://x/contra", &png());
        let images = download_images(
            &io,
            dir.path(),
            &settings(),
            "ABC-1",
            &[ImageRef {
                url: "https://x/contra".into(),
                file_name: Some("shot.png".into()),
                declared_mime: Some("text/plain".into()),
            }],
            None,
        );
        assert!(images[0].ok, "{images:?}");
        assert_eq!(images[0].mime, "image/png");
    }

    #[test]
    fn only_a_SPECIFIC_non_image_claim_declines() {
        for yes in ["text/plain", "application/pdf", "application/zip", "video/mp4", "TEXT/CSV"] {
            assert!(claim_declines_image(yes), "{yes} should decline");
        }
        for no in [
            "image/png",
            "IMAGE/JPEG",
            "application/octet-stream",
            "binary/octet-stream",
            "application/x-download",
            "application/force-download",
            "",
            "   ",
            "not-a-mime",
        ] {
            assert!(!claim_declines_image(no), "{no} must not decline");
        }
    }

    #[test]
    fn jira_reads_an_adf_description_rather_than_expecting_a_string() {
        let raw = parse_jira_response(JIRA_OK, "ABC-1").unwrap();
        assert_eq!(raw.title, "Login is slow");
        assert!(raw.body.contains("Takes 4s to paint"), "{}", raw.body);
        assert_eq!(raw.comments, vec!["Repro on Safari."]);
    }

    #[test]
    fn an_adf_link_href_is_read_off_the_MARK_not_a_node() {
        // `walk` used to recurse only into `content`, so every link in every Jira ticket was
        // dropped — the href hangs off the text node as a mark.
        let raw = parse_jira_response(JIRA_OK, "ABC-1").unwrap();
        assert!(raw.body.contains("https://acme.example/trace"), "{}", raw.body);
    }

    #[test]
    fn an_uploaded_screenshot_is_resolved_through_the_attachment_array_by_id() {
        // The `media` node for an uploaded image carries NO url — only an id. Reading `attrs.url`
        // there tests a shape the wire cannot produce, and leaves inline Jira screenshots inert.
        let raw = parse_jira_response(JIRA_OK, "ABC-1").unwrap();
        assert_eq!(
            urls(&raw.images),
            vec![
                // inline first, in document order: the embedded upload…
                "https://acme.atlassian.net/rest/api/3/attachment/content/10021",
                // …then the external media node's own url…
                "https://cdn.example/outside.png",
                // …then the attachment that is attached but not embedded.
                "https://acme.atlassian.net/rest/api/3/attachment/content/10022",
            ]
        );
    }

    #[test]
    fn an_inline_media_id_with_no_matching_attachment_is_skipped_not_invented() {
        let body = r#"{"fields":{"summary":"x","description":{"type":"doc","content":[
            {"type":"mediaSingle","content":[{"type":"media","attrs":{"type":"file","id":"9999"}}]}]},
            "attachment":[]}}"#;
        let raw = parse_jira_response(body, "ABC-2").unwrap();
        assert!(raw.images.is_empty(), "{:?}", raw.images);
    }

    #[test]
    fn a_jira_fetch_hits_the_v3_issue_endpoint_with_the_resolved_credential() {
        // The Jira FETCH path had no coverage at all — only its response parser did, so the URL it
        // builds and the header it sends were asserted by nothing.
        let dir = tmp();
        let io = FakeIo::default().with_get("/rest/api/3/issue/ABC-1", JIRA_OK);
        let s = IntakeSettings {
            default_provider: Some(Provider::Jira),
            jira: ProviderSettings {
                enabled: true,
                base_url: "https://acme.atlassian.net/".to_string(),
                api_key: Secret::new("a@b.com:tok"),
            },
            ..settings()
        };
        let refs = parse_refs("ABC-1", &s);
        let t = fetch_one(&io, dir.path(), &s, &refs[0]).unwrap();
        assert_eq!(t.title, "Login is slow");
        assert_eq!(t.url.as_deref(), Some("https://acme.atlassian.net/browse/ABC-1"));
        let call = io.calls().into_iter().find(|c| c.starts_with("GET ")).expect("a GET");
        // The trailing slash on base_url must not produce a double slash.
        assert!(call.contains("https://acme.atlassian.net/rest/api/3/issue/ABC-1?"), "{call}");
        assert!(call.contains("fields=summary,description,comment,attachment"), "{call}");
        let headers = io.headers.lock().unwrap().clone();
        assert!(
            headers
                .iter()
                .any(|(k, v)| k == "Authorization" && *v == jira_auth_header("a@b.com:tok")),
            "{headers:?}"
        );
    }

    #[test]
    fn jira_auth_picks_basic_for_an_email_colon_token_and_bearer_otherwise() {
        assert_eq!(
            jira_auth_header("a@b.com:tok"),
            format!("Basic {}", STANDARD.encode("a@b.com:tok"))
        );
        assert_eq!(jira_auth_header("pat_123"), "Bearer pat_123");
    }

    #[test]
    fn gh_json_becomes_a_ticket() {
        let raw = parse_gh_response(
            r#"{"title":"Crash","body":"see ![s](https://user-images.githubusercontent.com/1.png)",
                "url":"https://github.com/o/r/issues/9","comments":[{"body":"me too"}]}"#,
            "o/r#9",
        )
        .unwrap();
        assert_eq!(raw.title, "Crash");
        assert_eq!(raw.comments, vec!["me too"]);
        assert_eq!(urls(&raw.images), vec!["https://user-images.githubusercontent.com/1.png"]);
        assert_eq!(raw.url.as_deref(), Some("https://github.com/o/r/issues/9"));
    }

    #[test]
    fn bd_show_output_becomes_a_ticket_with_its_title() {
        let raw = parse_bd_show(
            "◐ .6 · Sparkle: optional ticket-system intake   [● P2 · IN_PROGRESS]\n\nDESCRIPTION\n  words\n",
            ".6",
        );
        assert_eq!(raw.title, "Sparkle: optional ticket-system intake");
        assert!(raw.body.contains("DESCRIPTION"));
    }

    // ── images ─────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn a_failed_download_is_a_ROW_not_an_omission() {
        let dir = tmp();
        let io = FakeIo::default()
            .with_bytes("https://x/one.png", &png())
            .with_dead_url("https://x/two.png", "410 Gone");
        let images = download_images(
            &io,
            dir.path(),
            &settings(),
            "ENG-1",
            &[ImageRef::bare("https://x/one.png"), ImageRef::bare("https://x/two.png")],
            None,
        );
        assert_eq!(images.len(), 2, "the UI must be able to say 2 images, 1 could not be fetched");
        assert!(images[0].ok);
        assert!(images[0].local_path.is_some());
        assert!(!images[1].ok);
        assert_eq!(images[1].local_path, None);
        assert!(images[1].error.as_deref().unwrap_or_default().contains("410 Gone"));
    }

    #[test]
    fn downloads_are_content_addressed_so_the_same_screenshot_stores_once() {
        let dir = tmp();
        let io = FakeIo::default()
            .with_bytes("https://x/a.png", &png())
            .with_bytes("https://x/b.png", &png());
        let images = download_images(
            &io,
            dir.path(),
            &settings(),
            "ENG-1",
            &[ImageRef::bare("https://x/a.png"), ImageRef::bare("https://x/b.png")],
            None,
        );
        assert_eq!(images[0].local_path, images[1].local_path, "same bytes, same file");
        let stored = std::fs::read_dir(attachment_dir(dir.path(), &settings(), "ENG-1"))
            .unwrap()
            .count();
        assert_eq!(stored, 1);
        assert_eq!(std::fs::read(images[0].local_path.clone().unwrap()).unwrap(), png());
    }

    #[test]
    fn an_empty_body_is_a_failure_not_a_zero_byte_file() {
        let dir = tmp();
        let io = FakeIo::default().with_bytes("https://x/a.png", b"");
        let images =
            download_images(&io, dir.path(), &settings(), "ENG-1", &[ImageRef::bare("https://x/a.png")], None);
        assert!(!images[0].ok);
        assert!(!attachment_dir(dir.path(), &settings(), "ENG-1").join("").exists());
    }

    /// A minimal file of each type the sniffer must recognize, plus one it must not.
    fn png() -> Vec<u8> {
        [&[0x89u8, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a][..], b"IHDR"].concat()
    }
    fn jpeg() -> Vec<u8> {
        [&[0xffu8, 0xd8, 0xff, 0xe0][..], b"JFIF"].concat()
    }
    fn webp() -> Vec<u8> {
        [&b"RIFF"[..], &[0x1a, 0, 0, 0][..], &b"WEBPVP8 "[..]].concat()
    }

    #[test]
    fn the_type_comes_from_the_BYTES_not_from_the_url() {
        // Linear serves `https://uploads.linear.app/<uuid>` and GitHub
        // `https://github.com/user-attachments/assets/<uuid>` — both extensionless. Anything that
        // reads the type off the URL answers "not an image" for the primary provider's entire
        // screenshot path.
        assert_eq!(sniff_image_mime(&png()), Some(("image/png", "png")));
        assert_eq!(sniff_image_mime(&jpeg()), Some(("image/jpeg", "jpg")));
        assert_eq!(sniff_image_mime(b"GIF89a\x01\x00"), Some(("image/gif", "gif")));
        assert_eq!(sniff_image_mime(&webp()), Some(("image/webp", "webp")));
        assert_eq!(sniff_image_mime(b"plain text, not a picture"), None);
        assert_eq!(sniff_image_mime(b"%PDF-1.7"), None);
        assert_eq!(sniff_image_mime(b""), None);
        // A truncated RIFF is not a WEBP — the check must not index past the end.
        assert_eq!(sniff_image_mime(b"RIFF"), None);
        // SVG is a script-bearing document; it is deliberately not an image here.
        assert_eq!(sniff_image_mime(b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"), None);
    }

    // ── intake ─────────────────────────────────────────────────────────────────────────────────

    fn linear_settings() -> IntakeSettings {
        IntakeSettings {
            default_provider: Some(Provider::Linear),
            linear: ProviderSettings {
                enabled: true,
                base_url: String::new(),
                api_key: Secret::new("lin_api_TOKEN"),
            },
            ..settings()
        }
    }

    #[test]
    fn fetch_one_downloads_the_images_during_the_fetch() {
        let dir = tmp();
        let io = FakeIo::default()
            .with_post(LINEAR_OK)
            .with_bytes("https://uploads.linear.app/a.png", &png())
            .with_bytes("https://uploads.linear.app/b.png", &jpeg())
            .with_dead_url("https://uploads.linear.app/c.png", "403 expired");
        let s = linear_settings();
        let refs = parse_refs("ENG-1234", &s);
        let t = fetch_one(&io, dir.path(), &s, &refs[0]).unwrap();
        assert_eq!(t.images.len(), 3);
        assert_eq!(t.images.iter().filter(|i| i.ok).count(), 2);
        assert_eq!(t.branch, "eng-1234-fix-the-login-crash");
        assert_eq!(t.pr_title, "ENG-1234: Fix the login crash");
        assert!(
            io.calls().iter().any(|c| c.starts_with("BYTES https://uploads.linear.app/a.png")),
            "images must be downloaded on the FETCH — a Linear link is dead in ~5 minutes: {:?}",
            io.calls()
        );
    }

    #[test]
    fn fetch_one_refuses_an_ambiguous_reference_rather_than_picking_a_tracker() {
        let dir = tmp();
        let io = FakeIo::default().with_post(LINEAR_OK);
        let s = IntakeSettings { linear: linear_settings().linear, ..settings() };
        let refs = parse_refs("ENG-1234", &s);
        assert!(refs[0].ambiguous);
        let err = fetch_one(&io, dir.path(), &s, &refs[0]).unwrap_err();
        assert!(err.contains("Linear or Jira"), "{err}");
        assert!(io.calls().is_empty(), "nothing may be called for a ref we could not resolve");
    }

    #[test]
    fn fetch_one_refuses_when_intake_is_switched_off() {
        let dir = tmp();
        let io = FakeIo::default().with_post(LINEAR_OK);
        let s = IntakeSettings { enabled: false, ..linear_settings() };
        let refs = parse_refs("ENG-1234", &s);
        let err = fetch_one(&io, dir.path(), &s, &refs[0]).unwrap_err();
        assert!(err.contains("enabled"), "{err}");
        assert!(io.calls().is_empty());
    }

    #[test]
    fn a_provider_with_no_credential_says_so_instead_of_calling_out() {
        let dir = tmp();
        let io = FakeIo::default();
        let s = IntakeSettings { default_provider: Some(Provider::Linear), ..settings() };
        let refs = parse_refs("ENG-1234", &s);
        let err = fetch_one(&io, dir.path(), &s, &refs[0]).unwrap_err();
        assert!(err.contains("Linear API key"), "{err}");
        assert!(io.calls().is_empty());
    }

    #[test]
    fn a_switched_off_provider_is_refused_by_name() {
        let dir = tmp();
        let io = FakeIo::default().with_run("{}");
        let mut s = settings();
        s.beads.enabled = false;
        let refs = parse_refs(".6", &s);
        let err = fetch_one(&io, dir.path(), &s, &refs[0]).unwrap_err();
        assert!(err.contains("ticket_intake.beads"), "{err}");
        assert!(io.calls().is_empty());
    }

    #[test]
    fn an_op_reference_is_resolved_through_the_one_secret_path_and_actually_sent() {
        let dir = tmp();
        let io = FakeIo::default().with_post(LINEAR_OK).with_op("lin_api_FROM_1PASSWORD");
        let s = IntakeSettings {
            linear: ProviderSettings {
                enabled: true,
                base_url: String::new(),
                api_key: Secret::new("op://Private/Linear/credential"),
            },
            ..linear_settings()
        };
        let refs = parse_refs("ENG-1234", &s);
        fetch_one(&io, dir.path(), &s, &refs[0]).unwrap();
        assert!(
            io.calls().iter().any(|c| c == "OP op://Private/Linear/credential"),
            "{:?}",
            io.calls()
        );
        let headers = io.headers.lock().unwrap().clone();
        assert!(
            headers.iter().any(|(k, v)| k == "Authorization" && v == "lin_api_FROM_1PASSWORD"),
            "the RESOLVED credential must reach the request, not the op:// pointer: {headers:?}"
        );
    }

    #[test]
    fn a_failed_1password_read_names_the_reference_but_never_a_secret() {
        let dir = tmp();
        let io = FakeIo::default().with_post(LINEAR_OK);
        let s = IntakeSettings {
            linear: ProviderSettings {
                enabled: true,
                base_url: String::new(),
                api_key: Secret::new("op://Private/Linear/credential"),
            },
            ..linear_settings()
        };
        let refs = parse_refs("ENG-1234", &s);
        let err = fetch_one(&io, dir.path(), &s, &refs[0]).unwrap_err();
        assert!(err.contains("op://Private/Linear/credential"), "{err}");
    }

    #[test]
    fn a_beads_fetch_that_printed_nothing_reports_the_store_lock_not_a_missing_bead() {
        let dir = tmp();
        let io = FakeIo::default().with_run("   \n");
        let s = settings();
        let refs = parse_refs(".6", &s);
        let err = fetch_one(&io, dir.path(), &s, &refs[0]).unwrap_err();
        assert!(err.contains("locked"), "{err}");
        assert!(!err.contains("not found"), "{err}");
    }

    #[test]
    fn a_batch_reports_per_reference_outcomes_rather_than_failing_whole() {
        let dir = tmp();
        std::fs::create_dir_all(dir.path().join("scripts")).unwrap();
        std::fs::write(dir.path().join("scripts/timeout.sh"), "#!/bin/sh\n").unwrap();
        // ONE run reply, shared: the beads ref succeeds; the Linear ref has no credential and so
        // fails without ever reaching a transport.
        let io = FakeIo::default().with_run("◐ .6 · Ticket intake  [● P2]\nbody\n");
        let s = IntakeSettings { default_provider: Some(Provider::Linear), ..settings() };
        let refs = parse_refs(".6 and ENG-1234", &s);
        assert_eq!(refs.len(), 2);
        let out = fetch_batch(&io, dir.path(), &s, &refs);
        assert_eq!(out.tickets.len(), 1, "{out:?}");
        assert_eq!(out.tickets[0].key, ".6");
        assert_eq!(out.failures.len(), 1);
        assert_eq!(out.failures[0].key, "ENG-1234");
        assert_eq!(out.failures[0].provider, Some(Provider::Linear));
        assert!(out.failures[0].error.contains("Linear API key"));
    }

    #[test]
    fn the_beads_fetch_passes_the_bounded_full_id_argv() {
        let dir = tmp();
        std::fs::create_dir_all(dir.path().join("scripts")).unwrap();
        std::fs::write(dir.path().join("scripts/timeout.sh"), "#!/bin/sh\n").unwrap();
        let io = FakeIo::default().with_run("◐ .6 · Ticket intake  [● P2]\nbody\n");
        let s = settings();
        let refs = parse_refs(".6", &s);
        fetch_one(&io, dir.path(), &s, &refs[0]).unwrap();
        let call = io.calls().into_iter().find(|c| c.starts_with("RUN ")).expect("a run");
        assert!(call.contains("timeout.sh"), "{call}");
        assert!(call.ends_with("bd show .6"), "{call}");
    }

    // ── the attachment credential ──────────────────────────────────────────────────────────────

    #[test]
    fn an_attachment_on_the_providers_host_carries_the_resolved_credential() {
        // A tracker's attachment endpoint wants the SAME credential the ticket fetch used. Without
        // it every screenshot is an `ok: false` row reading "answered HTTP 401" — the feature's
        // headline capability, failing by construction.
        let dir = tmp();
        let io = FakeIo::default()
            .with_post(LINEAR_OK)
            .with_bytes("https://uploads.linear.app/a.png", &png())
            .with_bytes("https://uploads.linear.app/b.png", &png())
            .with_bytes("https://uploads.linear.app/c.png", &png());
        let s = linear_settings();
        let refs = parse_refs("ENG-1234", &s);
        fetch_one(&io, dir.path(), &s, &refs[0]).unwrap();
        let sent = io
            .headers_sent_to("https://uploads.linear.app/a.png")
            .expect("the attachment was fetched");
        assert!(
            sent.iter().any(|(k, v)| k == "Authorization" && v == "lin_api_TOKEN"),
            "the attachment fetch went out unauthenticated: {sent:?}"
        );
    }

    #[test]
    fn a_credential_is_NEVER_sent_to_a_host_outside_the_providers_own() {
        // A ticket body is user content and can name any host in the world. Attaching the
        // workspace token to it would hand that token to whoever wrote the ticket.
        let dir = tmp();
        let body = r#"{"data":{"issue":{"title":"t","description":"![x](https://evil.example/steal.png)",
            "comments":{"nodes":[]},"attachments":{"nodes":[]}}}}"#;
        let io = FakeIo::default()
            .with_post(body)
            .with_bytes("https://evil.example/steal.png", &png());
        let s = linear_settings();
        let refs = parse_refs("ENG-1234", &s);
        fetch_one(&io, dir.path(), &s, &refs[0]).unwrap();
        let sent = io
            .headers_sent_to("https://evil.example/steal.png")
            .expect("the image was still fetched, just anonymously");
        assert!(sent.is_empty(), "a credential leaked to a foreign host: {sent:?}");
    }

    fn linear_auth() -> ImageAuth {
        ImageAuth {
            host_suffixes: vec!["linear.app".to_string()],
            headers: vec![("Authorization".to_string(), "tok".to_string())],
        }
    }

    #[test]
    fn a_host_suffix_matches_a_subdomain_but_never_a_lookalike() {
        let auth = linear_auth();
        assert_eq!(auth.headers_for("https://uploads.linear.app/a.png").len(), 1);
        assert_eq!(auth.headers_for("https://linear.app/a.png").len(), 1);
        assert!(auth.headers_for("https://notlinear.app/a.png").is_empty());
        assert!(auth.headers_for("https://linear.app.evil.example/a.png").is_empty());
        assert!(auth.headers_for("not a url").is_empty());
    }

    #[test]
    fn a_backslash_cannot_smuggle_the_credential_to_another_host() {
        // THE PARSER DIFFERENTIAL. A backslash is a path separator for a special scheme, so the
        // HTTP client reads the host of `https://evil.example\.linear.app/x.png` as
        // `evil.example`. A hand-rolled "up to the first slash" reader answers
        // `evil.example\.linear.app`, which ENDS WITH `.linear.app` — so the check says ours and
        // the request goes to theirs, carrying the token. Image URLs come from ticket bodies.
        let auth = linear_auth();
        for u in [
            "https://evil.example\\.linear.app/steal.png",
            "https://evil.example\\uploads.linear.app/steal.png",
        ] {
            assert!(
                auth.headers_for(u).is_empty(),
                "the credential was attached to {u}, whose real host is evil.example"
            );
        }
        // And the same string really does resolve to the attacker's host under the parser that
        // sends the request — without this the test above could pass for the wrong reason.
        assert_eq!(
            url::Url::parse("https://evil.example\\.linear.app/steal.png").unwrap().host_str(),
            Some("evil.example")
        );
    }

    #[test]
    fn a_credential_never_travels_over_cleartext_http() {
        // `http://uploads.linear.app/x.png` in a ticket body would put the API token on the wire
        // in the clear. No plaintext image is worth that.
        assert!(linear_auth().headers_for("http://uploads.linear.app/a.png").is_empty());
    }

    #[test]
    fn userinfo_does_not_make_a_foreign_host_look_like_ours() {
        assert!(linear_auth().headers_for("https://uploads.linear.app@evil.example/a.png").is_empty());
    }

    #[test]
    fn jira_sends_its_credential_only_to_its_own_site() {
        let s = IntakeSettings {
            jira: ProviderSettings {
                enabled: true,
                base_url: "https://acme.atlassian.net".to_string(),
                api_key: Secret::new("a@b.com:tok"),
            },
            ..settings()
        };
        let auth = JiraProvider.image_auth(&s, Some("a@b.com:tok")).expect("auth");
        let sent = auth.headers_for("https://acme.atlassian.net/rest/api/3/attachment/content/1");
        assert_eq!(sent, vec![("Authorization".to_string(), jira_auth_header("a@b.com:tok"))]);
        assert!(auth.headers_for("https://other.atlassian.net/x.png").is_empty());
    }

    #[test]
    fn github_and_beads_attach_no_credential_to_a_download() {
        assert!(GithubProvider.image_auth(&settings(), None).is_none());
        assert!(BeadsProvider.image_auth(&settings(), None).is_none());
    }

    // ── reading a stored screenshot back ───────────────────────────────────────────────────────

    #[test]
    fn a_stored_screenshot_comes_back_as_a_data_url_never_a_file_path() {
        // The webview's CSP is `img-src 'self' data:` with no asset protocol, so a file:// src
        // renders a broken glyph — on the images that SUCCEEDED, where the panel shows no reason.
        let dir = tmp();
        let io = FakeIo::default().with_bytes("https://x/a.png", &png());
        let images = download_images(
            &io,
            dir.path(),
            &settings(),
            "ENG-1",
            &[ImageRef::bare("https://x/a.png")],
            None,
        );
        let path = images[0].local_path.clone().unwrap();
        let url = image_data_url(dir.path(), &settings(), Path::new(&path)).unwrap();
        assert!(url.starts_with("data:image/png;base64,"), "{url}");
        assert_eq!(STANDARD.decode(url.split(',').nth(1).unwrap()).unwrap(), png());
    }

    #[test]
    fn reading_a_path_OUTSIDE_the_attachment_directory_is_refused() {
        // The path comes from the webview; without the containment check this command is an
        // arbitrary-file-read primitive.
        let dir = tmp();
        std::fs::create_dir_all(attachment_root(dir.path(), &settings())).unwrap();
        let secret = dir.path().join("id_rsa");
        std::fs::write(&secret, b"PRIVATE KEY").unwrap();
        let err = image_data_url(dir.path(), &settings(), &secret).unwrap_err();
        assert!(err.contains("not inside"), "{err}");
        // A traversal that RESOLVES to the real file: `image_dir` is `.sparkle/ticket-attachments`,
        // so escaping to the project root takes two hops. It must be refused on containment, not
        // merely bounce off a missing file — which is what a one-hop `..` would have tested.
        let escape =
            attachment_root(dir.path(), &settings()).join("..").join("..").join("id_rsa");
        assert!(escape.canonicalize().is_ok(), "the escape must point at a file that EXISTS");
        let err = image_data_url(dir.path(), &settings(), &escape).unwrap_err();
        assert!(err.contains("not inside"), "{err}");
    }

    #[test]
    fn a_non_image_attachment_is_a_REFUSED_ROW_that_names_itself() {
        // Two ways to be dishonest about a log.txt, and this is the line between them: handing it
        // to an <img> paints a broken glyph on a row marked ok with no reason, and DROPPING it
        // before the count reports "1 image" for a ticket that referenced three. It is carried,
        // refused, and named.
        let dir = tmp();
        let io = FakeIo::default()
            .with_bytes("https://x/shot.png", &png())
            .with_bytes("https://x/a", b"lines of a log")
            .with_bytes("https://x/report.pdf", b"%PDF-1.7");
        let images = download_images(
            &io,
            dir.path(),
            &settings(),
            "ENG-1",
            &[
                ImageRef::bare("https://x/shot.png"),
                ImageRef::named("https://x/a", Some("log.txt".into())),
                ImageRef::bare("https://x/report.pdf"),
            ],
            None,
        );
        assert_eq!(images.len(), 3, "the count must stay honest: {images:?}");
        assert!(images[0].ok);
        assert_eq!(images[0].mime, "image/png");
        assert!(!images[1].ok);
        assert_eq!(images[1].error.as_deref(), Some("log.txt is not an image"));
        assert!(!images[2].ok);
        assert_eq!(images[2].mime, "");
        // Only the real image is on disk.
        assert_eq!(
            std::fs::read_dir(attachment_dir(dir.path(), &settings(), "ENG-1")).unwrap().count(),
            1
        );
    }

    #[test]
    fn an_EXTENSIONLESS_screenshot_url_still_becomes_a_downloaded_row() {
        // The shape Linear and GitHub actually serve. A filter keyed on the extension answers "not
        // an image" here and — applied before the fetch — leaves no row, no reason and no count.
        let dir = tmp();
        for url in [
            "https://uploads.linear.app/abc-def-123",
            "https://github.com/user-attachments/assets/9f1c-42",
            "https://acme.atlassian.net/rest/api/3/attachment/content/10021",
        ] {
            let io = FakeIo::default().with_bytes(url, &png());
            let images =
                download_images(&io, dir.path(), &settings(), "ENG-1", &[ImageRef::bare(url)], None);
            assert_eq!(images.len(), 1, "{url}: {images:?}");
            assert!(images[0].ok, "{url}: {images:?}");
            assert_eq!(images[0].mime, "image/png", "{url}");
            let stored = images[0].local_path.clone().unwrap();
            assert!(stored.ends_with(".png"), "{url}: {stored}");
            assert!(
                image_data_url(dir.path(), &settings(), Path::new(&stored))
                    .unwrap()
                    .starts_with("data:image/png;base64,"),
                "{url}"
            );
        }
    }

    #[test]
    fn the_jira_parser_carries_the_filename_that_makes_that_possible() {
        let raw = parse_jira_response(JIRA_OK, "ABC-1").unwrap();
        let shot = raw
            .images
            .iter()
            .find(|r| r.url.ends_with("/10021"))
            .expect("the embedded upload");
        assert_eq!(shot.file_name.as_deref(), Some("shot.png"));
        // The log.txt attachment is still CARRIED here — it is dropped at download time, where the
        // extension test lives, so this parser stays a parser.
        assert!(raw.images.iter().any(|r| r.file_name.as_deref() == Some("log.txt")));
    }

    #[test]
    fn an_oversized_attachment_is_a_refused_ROW_not_a_renderer_OOM() {
        let dir = tmp();
        let mut big = png();
        big.resize(MAX_IMAGE_BYTES + 1, b'x');
        let io = FakeIo::default().with_bytes("https://x/huge.png", &big);
        let images = download_images(
            &io,
            dir.path(),
            &settings(),
            "ENG-1",
            &[ImageRef::bare("https://x/huge.png")],
            None,
        );
        assert_eq!(images.len(), 1);
        assert!(!images[0].ok);
        assert!(images[0].error.as_deref().unwrap_or_default().contains("cap"), "{images:?}");
        // Nothing was written — the cap has to stop the store, not just the render.
        assert!(!attachment_dir(dir.path(), &settings(), "ENG-1").exists());
    }

    #[test]
    fn reading_back_an_oversized_file_is_refused_before_the_allocation() {
        let dir = tmp();
        let d = attachment_dir(dir.path(), &settings(), "ENG-1");
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("big.png");
        std::fs::write(&f, vec![b'x'; MAX_IMAGE_BYTES + 1]).unwrap();
        let err = image_data_url(dir.path(), &settings(), &f).unwrap_err();
        assert!(err.contains("cap"), "{err}");
    }

    #[test]
    fn an_unknown_type_is_labelled_octet_stream_never_guessed_as_an_image() {
        assert_eq!(mime_for(Path::new("/a/b.png")), "image/png");
        assert_eq!(mime_for(Path::new("/a/b.JPEG")), "image/jpeg");
        assert_eq!(mime_for(Path::new("/a/b.bin")), "application/octet-stream");
        // SVG is a script-bearing document; it is deliberately not in the image list.
        assert_eq!(mime_for(Path::new("/a/b.svg")), "application/octet-stream");
    }

    // ── the DEFAULT wiring ─────────────────────────────────────────────────────────────────────

    /// The line that supplies the REAL io is otherwise covered by NOTHING — every other test here
    /// injects a fake around it (bead `sparkle-lgbwf`: a defaulted seam every test injects means
    /// the real line can be deleted with the suite still green). This drives it end to end through
    /// a command that needs no network and no credential.
    #[test]
    fn default_io_runs_a_real_command() {
        let io = default_io();
        let out = io.run("/bin/echo", &["ticket-intake".to_string()], None).unwrap();
        assert_eq!(out.trim(), "ticket-intake");
        let err = io.run("/bin/sh", &["-c".to_string(), "exit 3".to_string()], None).unwrap_err();
        assert!(err.contains("exited 3"), "{err}");
    }

    /// And that the real io is what the fetch path reaches for when nobody passes one. A beads ref
    /// against a directory with no `bd` fails at the SUBPROCESS, which is proof the default io was
    /// constructed and used — a stubbed-out default would fail earlier, differently.
    #[test]
    fn the_default_io_is_the_one_the_fetch_path_uses() {
        let dir = tmp();
        let io = default_io();
        let s = settings();
        let refs = parse_refs("sparkle-nosuchbead", &IntakeSettings { beads_prefixes: vec!["sparkle".into()], ..s.clone() });
        let out = fetch_batch(io.as_ref(), dir.path(), &s, &refs);
        assert_eq!(out.tickets.len(), 0);
        assert_eq!(out.failures.len(), 1);
        // Either bd is absent (could not run) or it ran and said nothing / errored. All three are
        // the REAL io talking; none is reachable from a fake.
        let e = &out.failures[0].error;
        assert!(
            e.contains("bd") || e.contains("locked") || e.contains("exited"),
            "expected the real subprocess path to be reached: {e}"
        );
    }
}
