//! PER-WORKTREE STEERING FILES — the project's "where" and "how", pushed into every agent at birth.
//!
//! Two documents per project, and the split is the whole idea:
//!
//!   * `architecture.md` — the WHERE. Service/package ownership, which directory holds what, which
//!     module is the one true home for a concern.
//!   * `standards.md` — the HOW. Conventions, the EXACT test/lint/format commands, commit and PR
//!     style, the things a reviewer will send the work back for.
//!
//! ## Why this is PUSHED and not pulled
//!
//! Chief's knowledge sync answers a question an agent thought to ask. That is the wrong shape for a
//! guardrail: an agent that does not know the repo has a rule does not know to ask for it, and the
//! rule it breaks is discovered by a reviewer hours later. Steering is therefore injected as a HARD
//! CONSTRAINT at pre-flight (`render_preflight_block`) and copied onto disk in the agent's own
//! worktree (`seed_into_worktree`) before it has run a single command. The two mechanisms are
//! complementary and this one deliberately does not replace the other — see
//! `PRD/per-worktree-steering-files.md`.
//!
//! ## Three layers, highest wins, every one optional
//!
//! | layer     | location                                  | who owns it                       |
//! |-----------|-------------------------------------------|-----------------------------------|
//! | `local`   | `<repo>/.sparkle/steering.local/`         | this machine, this checkout       |
//! | `project` | `<repo>/.sparkle/steering/`               | the repo (the canonical location) |
//! | `global`  | `<app_data>/steering/`                    | every project on this machine     |
//!
//! Resolution is PER FILE, not per directory: `architecture.md` may come from the project while
//! `standards.md` comes from the global layer. Each resolved file reports the layer that supplied
//! it so the UI (and the injected block itself) can say where a rule came from — "the reviewer will
//! reject this" is a much weaker instruction than "the reviewer will reject this, and the rule
//! lives in a file you can go read".
//!
//! ## Fail CLOSED on an unreadable layer
//!
//! An unreadable higher layer is NOT the same as an absent one, and collapsing the two is the
//! failure this module is written against. If `.sparkle/steering/standards.md` exists but cannot be
//! read (permissions, a half-written file, invalid UTF-8), silently falling through to the global
//! template would hand the agent the WRONG rules while every surface reported success. So a probe
//! that is neither "found" nor "not found" stops the search for that file and is reported as
//! `error` — the UI says "could not read", the injected block says so too, and nobody mistakes the
//! fallback for the answer.
//!
//! ## Nothing here overwrites a file that already exists
//!
//! A user's edits ARE the feature. `seed_templates` writes a template only where no file is
//! present, and `seed_into_worktree` skips any name the worktree already carries — which is also
//! what keeps a freshly cut worktree from being born dirty.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The steering directory's name under `.sparkle/` (project layer) and under the app-data dir
/// (global layer). One constant so the two cannot drift onto different spellings.
pub const STEERING_DIR: &str = "steering";

/// The LOCAL override directory, beside the project one. A separate directory rather than a
/// suffixed file so a repo that chooses to track `.sparkle/steering/` (Sparkle's own `.gitignore`
/// seeding ignores `.sparkle/*`, so it is ignored by default) can keep the override untracked with
/// a single ignore line.
pub const LOCAL_STEERING_DIR: &str = "steering.local";

/// Which layer supplied a file. Ordered lowest-precedence first, which is also the order
/// [`SteeringLayer::SEARCH_ORDER`] reverses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SteeringLayer {
    Global,
    Project,
    Local,
}

impl SteeringLayer {
    /// Highest precedence FIRST — the order [`resolve`] probes in, so the first hit wins.
    pub const SEARCH_ORDER: [SteeringLayer; 3] =
        [SteeringLayer::Local, SteeringLayer::Project, SteeringLayer::Global];

    /// Human-facing name, used in the UI and inside the injected block. Not `Debug` — this string
    /// is read by a person deciding which file to go and edit.
    pub fn label(self) -> &'static str {
        match self {
            SteeringLayer::Global => "global",
            SteeringLayer::Project => "project",
            SteeringLayer::Local => "local override",
        }
    }
}

/// One steering document, resolved across the layers.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedFile {
    /// The bare filename, e.g. `architecture.md`.
    pub name: String,
    /// The layer that supplied `content`, or `None` when the file is absent from every layer (and
    /// also when the search stopped on an `error` — an unreadable layer supplies nothing).
    pub layer: Option<SteeringLayer>,
    /// Absolute path of the file that supplied `content`, or of the one that could not be read.
    pub path: Option<String>,
    pub content: Option<String>,
    /// FAIL-CLOSED marker: a layer that exists but could not be read. When this is set the search
    /// stopped there and no lower layer was consulted, so `content` is `None` even if a lower layer
    /// has the file — see the module doc.
    pub error: Option<String>,
}

impl ResolvedFile {
    /// Is there content to show an agent? Absent AND unreadable both answer false.
    pub fn has_content(&self) -> bool {
        self.content.as_ref().is_some_and(|c| !c.trim().is_empty())
    }
}

/// Every configured steering file, resolved, plus where each layer lives so the UI can offer
/// "create it here".
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    /// `[steering].enabled` — carried so every surface reads one answer rather than re-deriving it.
    pub enabled: bool,
    pub files: Vec<ResolvedFile>,
    pub global_dir: String,
    pub project_dir: String,
    pub local_dir: String,
}

/// The directory holding one layer's steering files.
pub fn layer_dir(layer: SteeringLayer, project_root: &str, app_data: &Path) -> PathBuf {
    match layer {
        SteeringLayer::Global => app_data.join(STEERING_DIR),
        SteeringLayer::Project => Path::new(project_root).join(".sparkle").join(STEERING_DIR),
        SteeringLayer::Local => Path::new(project_root).join(".sparkle").join(LOCAL_STEERING_DIR),
    }
}

/// Is `name` a plain filename we are willing to join onto a layer directory?
///
/// The names come from `[steering].files`, which a cloned repo can set — so this is a path-traversal
/// boundary, not tidiness. `../../.ssh/id_ed25519` as a "steering file" would otherwise be read from
/// disk and pasted verbatim into an agent's opening context.
pub fn is_safe_name(name: &str) -> bool {
    let n = name.trim();
    if n.is_empty() || n == "." || n == ".." {
        return false;
    }
    if n.contains('/') || n.contains('\\') || n.contains('\0') {
        return false;
    }
    // A Windows drive-relative or ADS spelling (`C:foo`, `a:b`) never names a steering doc.
    !n.contains(':')
}

/// What one layer had to say about one file.
enum Probe {
    /// The file is not there. Keep searching the lower layers.
    Missing,
    Found(String),
    /// The file is there (or the directory is) and we could not read it. STOPS the search.
    Unreadable(String),
}

fn probe(dir: &Path, name: &str) -> (PathBuf, Probe) {
    let path = dir.join(name);
    match std::fs::read_to_string(&path) {
        Ok(s) => (path, Probe::Found(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (path, Probe::Missing),
        Err(e) => (path, Probe::Unreadable(e.to_string())),
    }
}

/// Resolve every name in `files` across the three layers, highest first.
///
/// Total: an unusable name, an absent file and an unreadable one all produce a row, because the UI
/// lists the configured set and a name that simply vanished from that list is indistinguishable
/// from one nobody configured.
pub fn resolve(project_root: &str, app_data: &Path, enabled: bool, files: &[String]) -> Resolved {
    let mut out = Vec::new();
    for name in files {
        let name = name.trim().to_string();
        if !is_safe_name(&name) {
            out.push(ResolvedFile {
                name: name.clone(),
                layer: None,
                path: None,
                content: None,
                error: Some(format!(
                    "'{name}' is not a plain file name; [steering].files entries must be bare \
                     names like architecture.md"
                )),
            });
            continue;
        }
        let mut row = ResolvedFile {
            name: name.clone(),
            layer: None,
            path: None,
            content: None,
            error: None,
        };
        for layer in SteeringLayer::SEARCH_ORDER {
            let dir = layer_dir(layer, project_root, app_data);
            let (path, p) = probe(&dir, &name);
            match p {
                Probe::Missing => continue,
                Probe::Found(content) => {
                    row.layer = Some(layer);
                    row.path = Some(path.to_string_lossy().to_string());
                    row.content = Some(content);
                    break;
                }
                // FAIL CLOSED. A lower layer's answer would be the WRONG rules presented as the
                // right ones, so the search stops here and says so.
                Probe::Unreadable(e) => {
                    row.path = Some(path.to_string_lossy().to_string());
                    row.error = Some(format!(
                        "could not read the {} steering file at {}: {e}",
                        layer.label(),
                        path.to_string_lossy()
                    ));
                    break;
                }
            }
        }
        out.push(row);
    }
    Resolved {
        enabled,
        files: out,
        global_dir: layer_dir(SteeringLayer::Global, project_root, app_data)
            .to_string_lossy()
            .to_string(),
        project_dir: layer_dir(SteeringLayer::Project, project_root, app_data)
            .to_string_lossy()
            .to_string(),
        local_dir: layer_dir(SteeringLayer::Local, project_root, app_data)
            .to_string_lossy()
            .to_string(),
    }
}

// ============================== the injected block ==============================

/// Opening fence of the pre-flight block. A literal, so a test can pin the thing the agent sees.
pub const BLOCK_HEADER: &str = "<<< SPARKLE STEERING — HARD CONSTRAINTS >>>";
/// Closing fence.
pub const BLOCK_FOOTER: &str = "<<< END SPARKLE STEERING >>>";
/// Appended when the block was cut to fit `max_inject_bytes`. Explicit by design: content that
/// silently disappears reads as content that was never there, and an agent cannot ask about a rule
/// it does not know was dropped.
pub const TRUNCATION_MARKER: &str = "[… STEERING TRUNCATED to fit the injection budget — read the \
                                     full files in .sparkle/steering/ before you rely on this …]";

/// The HARD-CONSTRAINT text injected into a new agent's context at pre-flight.
///
/// Pure: no disk, no config, no clock. Returns the EMPTY string when there is nothing to say —
/// steering disabled, no files configured, or every file absent — so the caller can concatenate
/// unconditionally without having to decide whether a block exists.
///
/// `max_bytes` is a cap on the WHOLE returned string, fences included, and it is honoured exactly:
/// a block that would exceed it is cut at a char boundary and the cut is announced with
/// [`TRUNCATION_MARKER`]. A `max_bytes` too small to hold even the fences and the marker yields the
/// empty string rather than a mutilated fence — half a hard constraint is worse than none.
pub fn render_preflight_block(resolved: &Resolved, max_bytes: usize) -> String {
    if !resolved.enabled {
        return String::new();
    }
    let usable: Vec<&ResolvedFile> =
        resolved.files.iter().filter(|f| f.has_content() || f.error.is_some()).collect();
    if usable.is_empty() {
        return String::new();
    }

    let mut body = String::new();
    body.push_str(BLOCK_HEADER);
    body.push_str(
        "\nThese are this project's steering documents. Treat them as HARD CONSTRAINTS on the work \
         you are about to do: they outrank your own conventions and any habit from another repo. \
         Each section names the layer it came from, so you can go and read the file itself.\n",
    );
    for f in &usable {
        match (&f.error, &f.content) {
            (Some(e), _) => {
                // The unreadable case is told to the agent rather than hidden: "there is a rule
                // here and nobody can read it" is actionable; a silent gap is not.
                body.push_str(&format!("\n── {} — UNAVAILABLE ──\n{e}\n", f.name));
            }
            (None, Some(c)) => {
                let layer = f.layer.map(|l| l.label()).unwrap_or("unknown");
                body.push_str(&format!("\n── {} ({}) ──\n{}\n", f.name, layer, c.trim_end()));
            }
            (None, None) => {}
        }
    }
    body.push_str("\n");
    body.push_str(BLOCK_FOOTER);
    body.push('\n');

    if body.len() <= max_bytes {
        return body;
    }
    truncate_block(&body, max_bytes)
}

/// Cut `body` to `max_bytes` while keeping it a well-formed block: the header stays, the marker and
/// the footer are appended, and the cut lands on a char boundary.
fn truncate_block(body: &str, max_bytes: usize) -> String {
    let tail = format!("\n{TRUNCATION_MARKER}\n{BLOCK_FOOTER}\n");
    // The smallest honest block is header + tail. Below that there is no room to say anything true.
    let floor = BLOCK_HEADER.len() + tail.len();
    if max_bytes < floor {
        return String::new();
    }
    let keep = max_bytes - tail.len();
    let mut cut = keep.min(body.len());
    while cut > 0 && !body.is_char_boundary(cut) {
        cut -= 1;
    }
    let mut out = String::with_capacity(max_bytes);
    out.push_str(&body[..cut]);
    out.push_str(&tail);
    out
}

// ============================== templates + seeding ==============================

/// The template shipped for `architecture.md` on first use.
pub const ARCHITECTURE_TEMPLATE: &str = r#"# Architecture — where the code lives

> Seeded by Sparkle. EDIT THIS. It is injected into every agent's context as a hard constraint,
> so an inaccurate line here is worse than an absent one. Delete any heading you do not need.

## Map

| area | path | owns |
|---|---|---|
| <app / service> | `<path>` | <what this and only this is responsible for> |

## The one true home for a concern

- <concern> lives in `<path>`. Do not add a second copy elsewhere.
- <shared type / constant> is defined in `<path>` and imported; never re-declared.

## Boundaries that must not be crossed

- `<layer A>` must not import from `<layer B>`.
- <what talks to the database / the network / the filesystem, and what must go through it>.

## Where NEW code goes

- A new <feature> starts as `<path>/<name>` plus its test beside it.
- A new <shared helper> goes in `<path>`, not in the caller.

## Things that look like they belong together and do not

- <trap a newcomer falls into, and the reason>
"#;

/// The template shipped for `standards.md` on first use.
pub const STANDARDS_TEMPLATE: &str = r#"# Standards — how work is done here

> Seeded by Sparkle. EDIT THIS. It is injected into every agent's context as a hard constraint.
> The commands below are the ones an agent will actually run, so keep them exact and current.

## Commands (exact — an agent will run these verbatim)

```
test:    <e.g. pnpm test>
lint:    <e.g. pnpm lint>
types:   <e.g. pnpm typecheck>
format:  <e.g. pnpm format>
build:   <e.g. pnpm build>
```

Definition of done: the commands above are GREEN. A red suite is not done.

## Code conventions

- <naming, file layout, error handling, logging>
- <what is banned, and why — this is the half people get wrong>

## Tests

- <framework, where tests live, what a test must assert>
- A test must assert the SIDE EFFECT of the change, not a precondition that was already true.

## Commits and PRs

- Commit style: <e.g. imperative subject, <=72 chars, body explains why>
- Branch naming: <...>
- PR body must contain: <...>
- Never commit: <secrets, generated files, scratch>

## Review will send it back for

- <the recurring reasons work is rejected here>
"#;

/// The template for one configured name, or `None` when we ship no opinion about that name.
pub fn template_for(name: &str) -> Option<&'static str> {
    match name.trim() {
        "architecture.md" => Some(ARCHITECTURE_TEMPLATE),
        "standards.md" => Some(STANDARDS_TEMPLATE),
        _ => None,
    }
}

/// What a seed run actually did. Returned rather than logged-and-forgotten so a test can assert the
/// SIDE EFFECT and a caller can report it.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedReport {
    /// Names written.
    pub created: Vec<String>,
    /// Names left alone because the destination already had them.
    pub skipped_existing: Vec<String>,
    /// Names we had nothing to write for (no content in any layer, or no template).
    pub skipped_empty: Vec<String>,
    /// Non-fatal failures. Seeding NEVER blocks the operation it hangs off.
    pub errors: Vec<String>,
}

/// Write the shipped templates into the PROJECT layer for any configured name that has no file in
/// any layer yet. Never overwrites: a name already present anywhere is left exactly as it is.
pub fn seed_templates(resolved: &Resolved) -> SeedReport {
    let mut report = SeedReport::default();
    let dir = PathBuf::from(&resolved.project_dir);
    for f in &resolved.files {
        if f.error.is_some() {
            // An unreadable layer is not an absent one — writing a template on top of a file we
            // merely failed to read would destroy the very content we could not see.
            report.errors.push(f.error.clone().unwrap_or_default());
            continue;
        }
        if f.content.is_some() {
            report.skipped_existing.push(f.name.clone());
            continue;
        }
        let Some(tpl) = template_for(&f.name) else {
            report.skipped_empty.push(f.name.clone());
            continue;
        };
        if !is_safe_name(&f.name) {
            report.skipped_empty.push(f.name.clone());
            continue;
        }
        if let Err(e) = std::fs::create_dir_all(&dir) {
            report.errors.push(format!("could not create {}: {e}", dir.to_string_lossy()));
            continue;
        }
        let path = dir.join(&f.name);
        match std::fs::write(&path, tpl) {
            Ok(()) => report.created.push(f.name.clone()),
            Err(e) => report.errors.push(format!("could not write {}: {e}", path.to_string_lossy())),
        }
    }
    report
}

/// Copy the RESOLVED steering files into `worktree`'s own `.sparkle/steering/`, so an agent sees
/// them on disk from birth rather than having to be told they exist.
///
/// Never overwrites. That is what stops a freshly cut worktree from being born dirty: a repo that
/// tracks `.sparkle/steering/` already has the file checked out, and this leaves it alone. (Sparkle
/// seeds `.sparkle/*` into a project's `.gitignore`, so in the common case nothing here is tracked
/// and nothing here shows up in `git status` either.)
pub fn seed_resolved_into(resolved: &Resolved, worktree: &Path) -> SeedReport {
    let mut report = SeedReport::default();
    let dir = worktree.join(".sparkle").join(STEERING_DIR);
    for f in &resolved.files {
        if let Some(e) = &f.error {
            report.errors.push(e.clone());
            continue;
        }
        if !f.has_content() || !is_safe_name(&f.name) {
            report.skipped_empty.push(f.name.clone());
            continue;
        }
        let path = dir.join(&f.name);
        if path.exists() {
            report.skipped_existing.push(f.name.clone());
            continue;
        }
        if let Err(e) = std::fs::create_dir_all(&dir) {
            report.errors.push(format!("could not create {}: {e}", dir.to_string_lossy()));
            continue;
        }
        match std::fs::write(&path, f.content.clone().unwrap_or_default()) {
            Ok(()) => report.created.push(f.name.clone()),
            Err(e) => report.errors.push(format!("could not write {}: {e}", path.to_string_lossy())),
        }
    }
    report
}

// ============================== config-bound entry points ==============================

/// Resolve using this project's EFFECTIVE `[steering]` config. The seam every command and the
/// worktree path share, so none of them re-derives the layer list or the enabled flag.
pub fn resolve_for_project(project_root: &str, app_data: &Path) -> Resolved {
    let cfg = crate::config::for_project(project_root).config.steering;
    resolve(project_root, app_data, cfg.enabled, &cfg.files)
}

/// SEED ONE FRESHLY CREATED WORKTREE. Called from the worktree-creation path.
///
/// NON-FATAL BY CONSTRUCTION — the return value is a report, never a `Result`, because there is no
/// failure here that should stop an agent from opening. A steering file that did not make it onto
/// disk costs the agent a hint; a worktree that failed to create costs it everything.
pub fn seed_into_worktree(project_root: &str, worktree_path: &str, app_data: &Path) -> SeedReport {
    let cfg = crate::config::for_project(project_root).config.steering;
    if !cfg.enabled || !cfg.seed_on_worktree_create {
        return SeedReport::default();
    }
    let resolved = resolve(project_root, app_data, cfg.enabled, &cfg.files);
    let report = seed_resolved_into(&resolved, Path::new(worktree_path));
    if !report.created.is_empty() {
        tracing::info!(
            worktree = %worktree_path,
            created = ?report.created,
            "seeded steering files into a new worktree"
        );
    }
    for e in &report.errors {
        tracing::warn!(worktree = %worktree_path, error = %e, "steering seed failed (non-fatal)");
    }
    report
}

/// The pre-flight block for this project, honouring `[steering].inject_at_preflight` and
/// `max_inject_bytes`. Empty string when steering is off or has nothing to say.
pub fn preflight_block_for_project(project_root: &str, app_data: &Path) -> String {
    let cfg = crate::config::for_project(project_root).config.steering;
    if !cfg.enabled || !cfg.inject_at_preflight {
        return String::new();
    }
    let resolved = resolve(project_root, app_data, cfg.enabled, &cfg.files);
    render_preflight_block(&resolved, cfg.max_inject_bytes as usize)
}

// ============================== tauri commands ==============================

fn app_data(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    crate::dev_identity::app_data_dir(app)
}

/// Every configured steering file, which layer supplied it, and where the layers live.
#[tauri::command]
pub async fn steering_status(app: tauri::AppHandle, root: String) -> Result<Resolved, String> {
    let dir = app_data(&app)?;
    tauri::async_runtime::spawn_blocking(move || resolve_for_project(&root, &dir))
        .await
        .map_err(|e| format!("steering_status task failed: {e}"))
}

/// One file's resolved content. Errors when `name` is not part of the configured set — the editor
/// must not become a general file reader keyed by a string from the frontend.
#[tauri::command]
pub async fn steering_read(
    app: tauri::AppHandle,
    root: String,
    name: String,
) -> Result<ResolvedFile, String> {
    let dir = app_data(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = resolve_for_project(&root, &dir);
        resolved
            .files
            .into_iter()
            .find(|f| f.name == name.trim())
            .ok_or_else(|| format!("'{name}' is not a configured steering file"))
    })
    .await
    .map_err(|e| format!("steering_read task failed: {e}"))?
}

/// Write one steering file into a layer. `layer` is `project` or `local` — the global layer is a
/// machine-wide default edited outside a project, and letting a project view write it would let one
/// repo's editor change every other project's fallback.
#[tauri::command]
pub async fn steering_write(
    root: String,
    name: String,
    content: String,
    layer: SteeringLayer,
) -> Result<String, String> {
    if !is_safe_name(&name) {
        return Err(format!("'{name}' is not a plain steering file name"));
    }
    if layer == SteeringLayer::Global {
        return Err(
            "the global steering layer is a machine-wide default and is not editable from a \
             project; edit the files in the global steering folder directly"
                .into(),
        );
    }
    tauri::async_runtime::spawn_blocking(move || {
        // `layer_dir` never reads app_data for these two layers, so the empty path is inert here.
        let dir = layer_dir(layer, &root, Path::new(""));
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("could not create {}: {e}", dir.to_string_lossy()))?;
        let path = dir.join(name.trim());
        std::fs::write(&path, content)
            .map_err(|e| format!("could not write {}: {e}", path.to_string_lossy()))?;
        Ok(path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("steering_write task failed: {e}"))?
}

/// Write the shipped templates for any configured file that does not exist in any layer yet.
#[tauri::command]
pub async fn steering_seed_templates(
    app: tauri::AppHandle,
    root: String,
) -> Result<SeedReport, String> {
    let dir = app_data(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = resolve_for_project(&root, &dir);
        seed_templates(&resolved)
    })
    .await
    .map_err(|e| format!("steering_seed_templates task failed: {e}"))
}

/// The HARD-CONSTRAINT text an agent spawned in this project should be born with.
#[tauri::command]
pub async fn steering_preflight_block(
    app: tauri::AppHandle,
    root: String,
) -> Result<String, String> {
    let dir = app_data(&app)?;
    tauri::async_runtime::spawn_blocking(move || preflight_block_for_project(&root, &dir))
        .await
        .map_err(|e| format!("steering_preflight_block task failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, body: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(name), body).unwrap();
    }

    fn files() -> Vec<String> {
        vec!["architecture.md".into(), "standards.md".into()]
    }

    // ---- resolution order ---------------------------------------------------------------

    #[test]
    fn local_beats_project_beats_global_per_file() {
        let repo = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let root = repo.path().to_string_lossy().to_string();

        write(&app_data.path().join(STEERING_DIR), "architecture.md", "GLOBAL ARCH");
        write(&app_data.path().join(STEERING_DIR), "standards.md", "GLOBAL STD");
        write(&repo.path().join(".sparkle").join(STEERING_DIR), "architecture.md", "PROJECT ARCH");
        write(
            &repo.path().join(".sparkle").join(LOCAL_STEERING_DIR),
            "architecture.md",
            "LOCAL ARCH",
        );

        let r = resolve(&root, app_data.path(), true, &files());
        let arch = &r.files[0];
        let std_ = &r.files[1];
        // THE SIDE EFFECT: which CONTENT won, not merely that a row exists.
        assert_eq!(arch.content.as_deref(), Some("LOCAL ARCH"));
        assert_eq!(arch.layer, Some(SteeringLayer::Local));
        // Resolution is PER FILE: standards.md fell all the way through to global while
        // architecture.md stopped at local.
        assert_eq!(std_.content.as_deref(), Some("GLOBAL STD"));
        assert_eq!(std_.layer, Some(SteeringLayer::Global));
    }

    #[test]
    fn project_wins_when_there_is_no_local_override() {
        let repo = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let root = repo.path().to_string_lossy().to_string();
        write(&app_data.path().join(STEERING_DIR), "standards.md", "GLOBAL STD");
        write(&repo.path().join(".sparkle").join(STEERING_DIR), "standards.md", "PROJECT STD");

        let r = resolve(&root, app_data.path(), true, &["standards.md".to_string()]);
        assert_eq!(r.files[0].content.as_deref(), Some("PROJECT STD"));
        assert_eq!(r.files[0].layer, Some(SteeringLayer::Project));
    }

    #[test]
    fn a_file_absent_everywhere_is_a_row_with_no_layer_and_no_error() {
        let repo = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let r = resolve(&repo.path().to_string_lossy(), app_data.path(), true, &files());
        assert_eq!(r.files.len(), 2);
        assert!(r.files.iter().all(|f| f.layer.is_none() && f.error.is_none() && f.content.is_none()));
        assert!(r.files.iter().all(|f| f.error.is_none()));
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_higher_layer_fails_closed_and_does_not_fall_through() {
        use std::os::unix::fs::PermissionsExt;
        let repo = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let root = repo.path().to_string_lossy().to_string();

        // A perfectly good global answer sits BELOW the broken project file. Falling through to it
        // is precisely the silent-wrong-rules failure this asserts against.
        write(&app_data.path().join(STEERING_DIR), "standards.md", "GLOBAL STD");
        let pdir = repo.path().join(".sparkle").join(STEERING_DIR);
        write(&pdir, "standards.md", "PROJECT STD");
        let path = pdir.join("standards.md");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();

        let r = resolve(&root, app_data.path(), true, &["standards.md".to_string()]);
        let f = &r.files[0];
        // Root can read a 0o000 file, so skip rather than assert a false thing when tests run as
        // root (CI containers often do).
        if f.content.as_deref() == Some("PROJECT STD") {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            return;
        }
        assert!(f.error.is_some(), "an unreadable layer must be reported: {f:?}");
        assert!(r.files.iter().any(|f| f.error.is_some()));
        assert_eq!(
            f.content, None,
            "the lower layer's content must NOT be served in place of the unreadable one"
        );
        assert_eq!(f.layer, None);
        assert!(
            f.error.as_deref().unwrap().contains("could not read"),
            "the message must say we could not read it: {f:?}"
        );
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    }

    #[test]
    fn a_traversing_file_name_is_refused_rather_than_read() {
        let repo = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        // The secret sits exactly where `../secret.md` from the project layer would land.
        std::fs::create_dir_all(repo.path().join(".sparkle")).unwrap();
        std::fs::write(repo.path().join(".sparkle").join("secret.md"), "TOP SECRET").unwrap();

        let r = resolve(
            &repo.path().to_string_lossy(),
            app_data.path(),
            true,
            &["../secret.md".to_string()],
        );
        assert_eq!(r.files[0].content, None, "traversal must not read the file");
        assert!(r.files[0].error.is_some());
        assert!(!is_safe_name("../secret.md"));
        assert!(!is_safe_name("a/b.md"));
        assert!(is_safe_name("architecture.md"));
    }

    // ---- the injected block -------------------------------------------------------------

    fn resolved_with(pairs: &[(&str, &str, SteeringLayer)]) -> Resolved {
        Resolved {
            enabled: true,
            files: pairs
                .iter()
                .map(|(n, c, l)| ResolvedFile {
                    name: (*n).into(),
                    layer: Some(*l),
                    path: Some(format!("/tmp/{n}")),
                    content: Some((*c).into()),
                    error: None,
                })
                .collect(),
            global_dir: "/g".into(),
            project_dir: "/p".into(),
            local_dir: "/l".into(),
        }
    }

    #[test]
    fn the_block_carries_the_content_and_names_the_layer() {
        let r = resolved_with(&[("standards.md", "RUN pnpm verify", SteeringLayer::Project)]);
        let b = render_preflight_block(&r, 10_000);
        assert!(b.starts_with(BLOCK_HEADER), "{b}");
        assert!(b.contains("RUN pnpm verify"), "{b}");
        assert!(b.contains("standards.md (project)"), "the layer must be named: {b}");
        assert!(b.trim_end().ends_with(BLOCK_FOOTER), "{b}");
        assert!(!b.contains(TRUNCATION_MARKER));
    }

    #[test]
    fn a_disabled_or_empty_resolution_injects_nothing_at_all() {
        let mut r = resolved_with(&[("standards.md", "X", SteeringLayer::Project)]);
        r.enabled = false;
        assert_eq!(render_preflight_block(&r, 10_000), "");

        let empty = Resolved {
            enabled: true,
            files: vec![ResolvedFile {
                name: "standards.md".into(),
                layer: None,
                path: None,
                content: None,
                error: None,
            }],
            global_dir: "/g".into(),
            project_dir: "/p".into(),
            local_dir: "/l".into(),
        };
        assert_eq!(render_preflight_block(&empty, 10_000), "");
    }

    #[test]
    fn oversized_steering_is_truncated_with_an_explicit_marker_and_stays_under_the_cap() {
        let big = "x".repeat(50_000);
        let r = resolved_with(&[("standards.md", &big, SteeringLayer::Local)]);
        let cap = 2_000;
        let b = render_preflight_block(&r, cap);
        assert!(b.len() <= cap, "block was {} bytes, cap {cap}", b.len());
        assert!(b.contains(TRUNCATION_MARKER), "truncation must be ANNOUNCED: {b}");
        assert!(b.starts_with(BLOCK_HEADER));
        assert!(b.trim_end().ends_with(BLOCK_FOOTER));
        // And it really did carry some of the content rather than only fences.
        assert!(b.contains("xxxxxxxxxx"));
    }

    #[test]
    fn truncation_never_splits_a_multibyte_char() {
        // '—' is 3 bytes; a naive byte slice panics or produces invalid UTF-8.
        let big = "—".repeat(20_000);
        let r = resolved_with(&[("standards.md", &big, SteeringLayer::Local)]);
        for cap in [1_000usize, 1_001, 1_002, 1_003] {
            let b = render_preflight_block(&r, cap);
            assert!(b.len() <= cap);
            assert!(b.contains(TRUNCATION_MARKER));
        }
    }

    #[test]
    fn a_cap_too_small_for_an_honest_block_yields_nothing() {
        let r = resolved_with(&[("standards.md", &"x".repeat(1000), SteeringLayer::Local)]);
        assert_eq!(render_preflight_block(&r, 10), "");
    }

    #[test]
    fn an_unreadable_file_is_announced_in_the_block_rather_than_omitted() {
        let r = Resolved {
            enabled: true,
            files: vec![ResolvedFile {
                name: "standards.md".into(),
                layer: None,
                path: Some("/p/standards.md".into()),
                content: None,
                error: Some("could not read the project steering file at /p/standards.md".into()),
            }],
            global_dir: "/g".into(),
            project_dir: "/p".into(),
            local_dir: "/l".into(),
        };
        let b = render_preflight_block(&r, 10_000);
        assert!(b.contains("UNAVAILABLE"), "{b}");
        assert!(b.contains("could not read"), "{b}");
    }

    // ---- seeding ------------------------------------------------------------------------

    #[test]
    fn templates_are_written_only_where_nothing_exists() {
        let repo = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let root = repo.path().to_string_lossy().to_string();
        write(&repo.path().join(".sparkle").join(STEERING_DIR), "standards.md", "MINE");

        let r = resolve(&root, app_data.path(), true, &files());
        let report = seed_templates(&r);
        assert_eq!(report.created, vec!["architecture.md".to_string()]);
        assert_eq!(report.skipped_existing, vec!["standards.md".to_string()]);
        // THE SIDE EFFECT on disk: the new one exists, the user's own is byte-for-byte intact.
        let dir = repo.path().join(".sparkle").join(STEERING_DIR);
        assert!(std::fs::read_to_string(dir.join("architecture.md")).unwrap().contains("# Architecture"));
        assert_eq!(std::fs::read_to_string(dir.join("standards.md")).unwrap(), "MINE");
    }

    #[test]
    fn seeding_a_worktree_copies_the_resolved_content_and_never_overwrites() {
        let repo = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let wt = tempfile::tempdir().unwrap();
        let root = repo.path().to_string_lossy().to_string();
        write(&app_data.path().join(STEERING_DIR), "architecture.md", "GLOBAL ARCH");
        write(&repo.path().join(".sparkle").join(STEERING_DIR), "standards.md", "PROJECT STD");
        // The worktree already carries one of them (a repo that tracks the directory).
        write(&wt.path().join(".sparkle").join(STEERING_DIR), "standards.md", "ALREADY HERE");

        let r = resolve(&root, app_data.path(), true, &files());
        let report = seed_resolved_into(&r, wt.path());

        let dir = wt.path().join(".sparkle").join(STEERING_DIR);
        assert_eq!(
            std::fs::read_to_string(dir.join("architecture.md")).unwrap(),
            "GLOBAL ARCH",
            "the resolved layer's content is what lands in the worktree"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("standards.md")).unwrap(),
            "ALREADY HERE",
            "an existing file is never overwritten — that is what keeps the worktree clean"
        );
        assert_eq!(report.created, vec!["architecture.md".to_string()]);
        assert_eq!(report.skipped_existing, vec!["standards.md".to_string()]);
    }

    // ---- the DEFAULT wiring: config actually governs these ------------------------------
    //
    // Every test above hands `enabled`/`files` in by hand, which leaves the lines that read them
    // OFF the resolved config covered by nothing. These drive the real `[steering]` read.

    #[test]
    fn seed_into_worktree_is_inert_until_the_project_opts_in() {
        let repo = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let wt = tempfile::tempdir().unwrap();
        let root = repo.path().to_string_lossy().to_string();
        write(&app_data.path().join(STEERING_DIR), "architecture.md", "GLOBAL ARCH");

        // No `[steering]` anywhere: enabled defaults to false, so nothing is written.
        std::fs::create_dir_all(repo.path().join(".sparkle")).unwrap();
        std::fs::write(repo.path().join(".sparkle").join("config.toml"), "[workflow]\n").unwrap();
        let off = seed_into_worktree(&root, &wt.path().to_string_lossy(), app_data.path());
        assert_eq!(off, SeedReport::default(), "steering is opt-in: {off:?}");
        assert!(!wt.path().join(".sparkle").join(STEERING_DIR).join("architecture.md").exists());

        // Now the project opts in — same call, same disk, opposite outcome.
        std::fs::write(
            repo.path().join(".sparkle").join("config.toml"),
            "[steering]\nenabled = true\n",
        )
        .unwrap();
        let on = seed_into_worktree(&root, &wt.path().to_string_lossy(), app_data.path());
        assert_eq!(on.created, vec!["architecture.md".to_string()], "{on:?}");
        assert_eq!(
            std::fs::read_to_string(
                wt.path().join(".sparkle").join(STEERING_DIR).join("architecture.md")
            )
            .unwrap(),
            "GLOBAL ARCH"
        );
    }

    #[test]
    fn seed_on_worktree_create_false_stops_the_seed_while_steering_stays_on() {
        let repo = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let wt = tempfile::tempdir().unwrap();
        let root = repo.path().to_string_lossy().to_string();
        write(&app_data.path().join(STEERING_DIR), "architecture.md", "GLOBAL ARCH");
        std::fs::create_dir_all(repo.path().join(".sparkle")).unwrap();
        std::fs::write(
            repo.path().join(".sparkle").join("config.toml"),
            "[steering]\nenabled = true\nseed_on_worktree_create = false\n",
        )
        .unwrap();

        assert_eq!(
            seed_into_worktree(&root, &wt.path().to_string_lossy(), app_data.path()),
            SeedReport::default()
        );
        // …and the PAIRED half: the injection is still live, so this proves the seed switch is what
        // stopped it rather than steering being off altogether.
        assert!(preflight_block_for_project(&root, app_data.path()).contains("GLOBAL ARCH"));
    }

    #[test]
    fn preflight_block_for_project_reads_enabled_files_and_the_byte_cap_off_config() {
        let repo = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let root = repo.path().to_string_lossy().to_string();
        write(&app_data.path().join(STEERING_DIR), "house.md", &"y".repeat(9_000));
        std::fs::create_dir_all(repo.path().join(".sparkle")).unwrap();

        // A custom `files` list — proves the configured names, not a hardcoded pair, are read.
        std::fs::write(
            repo.path().join(".sparkle").join("config.toml"),
            "[steering]\nenabled = true\nfiles = [\"house.md\"]\n",
        )
        .unwrap();
        let b = preflight_block_for_project(&root, app_data.path());
        assert!(b.contains("house.md (global)"), "{b}");

        // …and the cap really bites, off config.
        std::fs::write(
            repo.path().join(".sparkle").join("config.toml"),
            "[steering]\nenabled = true\nfiles = [\"house.md\"]\nmax_inject_bytes = 900\n",
        )
        .unwrap();
        let capped = preflight_block_for_project(&root, app_data.path());
        assert!(capped.len() <= 900, "{}", capped.len());
        assert!(capped.contains(TRUNCATION_MARKER));

        // …and `inject_at_preflight = false` silences it without touching `enabled`.
        std::fs::write(
            repo.path().join(".sparkle").join("config.toml"),
            "[steering]\nenabled = true\nfiles = [\"house.md\"]\ninject_at_preflight = false\n",
        )
        .unwrap();
        assert_eq!(preflight_block_for_project(&root, app_data.path()), "");
    }
}
