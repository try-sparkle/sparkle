// apps/desktop/src-tauri/src/notes.rs
//! Lightweight "save selection" sinks for the terminal selection popup:
//! append a note to the project's NOTES.md, or create a beads issue via the `bd` CLI.
//! Both run against the user-chosen project root (not the hidden worktree).

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::process::Command;

/// Append a timestamped note to `<project_path>/NOTES.md`, creating the file if needed.
/// The timestamp is supplied by the frontend (ISO 8601) to avoid pulling a date crate.
#[tauri::command]
pub fn append_note(project_path: String, text: String, timestamp: String) -> Result<(), String> {
    let path = Path::new(&project_path).join("NOTES.md");
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    write!(f, "\n\n## {timestamp}\n{text}\n").map_err(|e| format!("write NOTES.md: {e}"))?;
    Ok(())
}

/// Create a beads issue in `project_path` via `bd create`. Runs through a login shell so the
/// GUI app inherits the user's PATH (where `bd` lives). Title/body are passed as positional
/// args ($1/$2) and the project path as $3 — never interpolated into the script — so they
/// can't break out of the command. The script pins its own cwd (`cd "$3"`) to guard against
/// `.zshrc`/`.zprofile` startup `cd` calls overriding the inherited working directory.
/// Returns bd's raw `--json` stdout (the created issue, or an `{"error": …}` object).
#[tauri::command]
pub fn create_bead(project_path: String, title: String, body: String) -> Result<String, String> {
    let output = Command::new("/bin/zsh")
        .arg("-l")
        .arg("-c")
        .arg(r#"cd "$3" && bd create "$1" -d "$2" --json"#)
        .arg("sparkle")    // $0
        .arg(&title)       // $1
        .arg(&body)        // $2
        .arg(&project_path) // $3
        .output()
        .map_err(|e| format!("failed to run bd: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    select_bd_result(output.status.success(), &stdout, &stderr)
}

/// Decide what to return from `create_bead` given bd's process result. Extracted as a pure
/// function so the (otherwise shell-dependent) branch ordering is unit-testable.
///
/// bd emits a JSON object on both success and (caught) error. The frontend parses that JSON
/// (success -> id, caught error -> `{"error": …}`), so whenever stdout looks like bd's JSON
/// payload we return it regardless of exit status — even if bd also wrote a warning to stderr
/// on a non-zero exit. Only when stdout is NOT bd's JSON (shell error, missing `bd`, crash) do
/// we surface stderr (or stdout) as a raw error string for the frontend to display.
fn select_bd_result(success: bool, stdout: &str, stderr: &str) -> Result<String, String> {
    if stdout.starts_with('{') {
        return Ok(stdout.to_string());
    }
    if success {
        if stdout.is_empty() {
            return Err("bd produced no output".into());
        }
        // Clean exit but non-JSON stdout — pass it through; the frontend reports it verbatim.
        return Ok(stdout.to_string());
    }
    if !stderr.is_empty() {
        return Err(stderr.to_string());
    }
    if !stdout.is_empty() {
        return Err(stdout.to_string());
    }
    Err("bd produced no output".into())
}

/// Result handling for bd READ commands (`bd list`/`bd show --json`) whose stdout is a JSON
/// array/object the frontend parses directly. Unlike `select_bd_result` (which extracts an id),
/// this returns bd's full stdout verbatim on success.
fn select_bd_raw(success: bool, stdout: &str, stderr: &str) -> Result<String, String> {
    if success {
        if stdout.is_empty() {
            return Err("bd produced no output".into());
        }
        return Ok(stdout.to_string());
    }
    // Failure: prefer bd's structured JSON error if it emitted one, else stderr, else stdout.
    if stdout.starts_with('{') {
        return Ok(stdout.to_string());
    }
    if !stderr.is_empty() {
        return Err(stderr.to_string());
    }
    if !stdout.is_empty() {
        return Err(stdout.to_string());
    }
    Err("bd produced no output".into())
}

/// Result handling for bd MUTATION commands (`dep add`, `label add/remove`) whose stdout may be
/// empty on success and is not necessarily JSON. Returns "ok" for a silent success so the caller
/// always gets a non-empty confirmation string.
fn select_bd_action(success: bool, stdout: &str, stderr: &str) -> Result<String, String> {
    if success {
        return Ok(if stdout.is_empty() { "ok".to_string() } else { stdout.to_string() });
    }
    if stdout.starts_with('{') {
        return Ok(stdout.to_string());
    }
    if !stderr.is_empty() {
        return Err(stderr.to_string());
    }
    if !stdout.is_empty() {
        return Err(stdout.to_string());
    }
    Err("bd produced no output".into())
}

/// Write a markdown doc into the project's `PRD/` directory. `filename` MUST be a bare filename:
/// reject anything containing a path separator, a `..` traversal, or an absolute path, so a caller
/// can never escape `PRD/` and clobber arbitrary files. Creates `PRD/` if needed and returns the
/// repo-relative path (`PRD/<filename>`) on success.
#[tauri::command]
pub fn write_prd(project_path: String, filename: String, content: String) -> Result<String, String> {
    if filename.is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
        || Path::new(&filename).is_absolute()
    {
        return Err(format!("invalid filename (must be a bare filename): {filename}"));
    }
    let prd_dir = Path::new(&project_path).join("PRD");
    std::fs::create_dir_all(&prd_dir).map_err(|e| format!("create {}: {e}", prd_dir.display()))?;
    let path = prd_dir.join(&filename);
    std::fs::write(&path, content.as_bytes()).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(format!("PRD/{filename}"))
}

/// List all beads in `project_path` via `bd list --json`. Returns bd's raw JSON stdout (a JSON
/// array) for the frontend to parse. Runs through a login shell so the GUI app inherits the
/// user's PATH (where `bd` lives); the project path is a positional arg, never interpolated.
#[tauri::command]
pub fn list_beads(project_path: String) -> Result<String, String> {
    let output = Command::new("/bin/zsh")
        .arg("-l")
        .arg("-c")
        .arg(r#"cd "$1" && bd list --json"#)
        .arg("sparkle")     // $0
        .arg(&project_path) // $1
        .output()
        .map_err(|e| format!("failed to run bd: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    select_bd_raw(output.status.success(), &stdout, &stderr)
}

/// Show a single bead via `bd show "$1" --json`. Returns bd's raw JSON stdout. `id` is a
/// positional arg ($1), never interpolated into the script.
#[tauri::command]
pub fn bead_show(project_path: String, id: String) -> Result<String, String> {
    let output = Command::new("/bin/zsh")
        .arg("-l")
        .arg("-c")
        .arg(r#"cd "$2" && bd show "$1" --json"#)
        .arg("sparkle")     // $0
        .arg(&id)           // $1
        .arg(&project_path) // $2
        .output()
        .map_err(|e| format!("failed to run bd: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    select_bd_raw(output.status.success(), &stdout, &stderr)
}

/// Assemble the `bd create` shell script and the positional args it references. Every value
/// (project path, title, body, type, parent, deps, labels) is passed as a positional parameter
/// ($1..) so it is NEVER interpolated into the script — injection-safe, matching `create_bead`.
/// Optional flags (`--parent`/`--deps`/`-l`) are appended ONLY when their value is non-empty, and
/// only then is the value pushed as a positional arg, keeping the $-indices contiguous. Returns
/// `(script, args)` where `args[0]` maps to `$1` (so the caller passes `$0` separately).
/// Pure (no I/O) so the assembly is unit-testable without invoking bd.
fn build_create_bead_command(
    project_path: &str,
    title: &str,
    body: &str,
    issue_type: &str,
    parent: &str,
    deps: &str,
    labels: &str,
) -> (String, Vec<String>) {
    let issue_type = if issue_type.trim().is_empty() { "task" } else { issue_type };
    // $1=project_path, $2=title, $3=body, $4=issue_type; optional flags consume $5.. in order.
    let mut args: Vec<String> = vec![
        project_path.to_string(),
        title.to_string(),
        body.to_string(),
        issue_type.to_string(),
    ];
    let mut script = String::from(r#"cd "$1" && bd create "$2" -d "$3" -t "$4""#);
    let mut next = 5;
    if !parent.trim().is_empty() {
        script.push_str(&format!(r#" --parent "${next}""#));
        args.push(parent.to_string());
        next += 1;
    }
    if !deps.trim().is_empty() {
        script.push_str(&format!(r#" --deps "${next}""#));
        args.push(deps.to_string());
        next += 1;
    }
    if !labels.trim().is_empty() {
        script.push_str(&format!(r#" -l "${next}""#));
        args.push(labels.to_string());
    }
    script.push_str(" --json");
    (script, args)
}

/// Create a fully-specified bead: title + body, with an issue type (default "task") and optional
/// parent, dependencies, and labels. See `build_create_bead_command` for the injection-safe arg
/// assembly. Returns bd's `--json` payload via `select_bd_result` (id on success, `{"error":…}`
/// on a caught bd error).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_bead_full(
    project_path: String,
    title: String,
    body: String,
    issue_type: String,
    parent: String,
    deps: String,
    labels: String,
) -> Result<String, String> {
    let (script, args) =
        build_create_bead_command(&project_path, &title, &body, &issue_type, &parent, &deps, &labels);
    let mut cmd = Command::new("/bin/zsh");
    cmd.arg("-l").arg("-c").arg(&script).arg("sparkle"); // $0
    for a in &args {
        cmd.arg(a);
    }
    let output = cmd.output().map_err(|e| format!("failed to run bd: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    select_bd_result(output.status.success(), &stdout, &stderr)
}

/// Add a dependency: `bd dep add "$1" "$2"` — `blocked_id` depends on (is blocked by) `blocker_id`.
/// Both ids are positional args, never interpolated.
#[tauri::command]
pub fn bead_dep_add(
    project_path: String,
    blocked_id: String,
    blocker_id: String,
) -> Result<String, String> {
    let output = Command::new("/bin/zsh")
        .arg("-l")
        .arg("-c")
        .arg(r#"cd "$3" && bd dep add "$1" "$2""#)
        .arg("sparkle")     // $0
        .arg(&blocked_id)   // $1
        .arg(&blocker_id)   // $2
        .arg(&project_path) // $3
        .output()
        .map_err(|e| format!("failed to run bd: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    select_bd_action(output.status.success(), &stdout, &stderr)
}

/// Claim a bead — mark it in_progress. `bd update <id> --claim`. Idempotent server-side, so the
/// app can fire it on every entry into a "building" stage without churn.
#[tauri::command]
pub fn bead_claim(project_path: String, id: String) -> Result<String, String> {
    let output = Command::new("/bin/zsh")
        .arg("-l")
        .arg("-c")
        .arg(r#"cd "$2" && bd update "$1" --claim"#)
        .arg("sparkle") // $0
        .arg(&id) // $1
        .arg(&project_path) // $2
        .output()
        .map_err(|e| format!("failed to run bd: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    select_bd_action(output.status.success(), &stdout, &stderr)
}

/// Close a bead (mark done). `bd close <id>`. Idempotent server-side.
#[tauri::command]
pub fn bead_close(project_path: String, id: String) -> Result<String, String> {
    let output = Command::new("/bin/zsh")
        .arg("-l")
        .arg("-c")
        .arg(r#"cd "$2" && bd close "$1""#)
        .arg("sparkle") // $0
        .arg(&id) // $1
        .arg(&project_path) // $2
        .output()
        .map_err(|e| format!("failed to run bd: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    select_bd_action(output.status.success(), &stdout, &stderr)
}

/// Add or remove a label on a bead: `bd label add|remove "$2" "$3"`. `action` is validated to be
/// exactly "add" or "remove"; id and label are positional args, never interpolated.
#[tauri::command]
pub fn bead_label(
    project_path: String,
    action: String,
    id: String,
    label: String,
) -> Result<String, String> {
    if action != "add" && action != "remove" {
        return Err(format!("invalid label action: {action} (expected \"add\" or \"remove\")"));
    }
    let output = Command::new("/bin/zsh")
        .arg("-l")
        .arg("-c")
        .arg(r#"cd "$4" && bd label "$1" "$2" "$3""#)
        .arg("sparkle")     // $0
        .arg(&action)       // $1
        .arg(&id)           // $2
        .arg(&label)        // $3
        .arg(&project_path) // $4
        .output()
        .map_err(|e| format!("failed to run bd: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    select_bd_action(output.status.success(), &stdout, &stderr)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_note_creates_and_appends() {
        let dir = std::env::temp_dir().join(format!("sparkle_notes_{}", std::process::id()));
        // Start clean: a prior aborted run could leave a stale NOTES.md that breaks the count.
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.to_string_lossy().to_string();

        append_note(p.clone(), "first".into(), "2026-06-24T00:00:00Z".into()).unwrap();
        append_note(p.clone(), "second".into(), "2026-06-24T00:01:00Z".into()).unwrap();

        let body = std::fs::read_to_string(Path::new(&p).join("NOTES.md")).unwrap();
        assert!(body.contains("## 2026-06-24T00:00:00Z"));
        assert!(body.contains("first"));
        assert!(body.contains("second"));
        // Two appends → two heading markers.
        assert_eq!(body.matches("## ").count(), 2);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn select_bd_result_prefers_json_stdout_even_on_nonzero_exit() {
        // bd exited non-zero but emitted its caught-error JSON on stdout AND a warning on stderr:
        // the JSON must win so the frontend can surface the structured `error` message.
        let r = select_bd_result(
            false,
            r#"{"error":"database not initialized"}"#,
            "warning: deprecated flag",
        );
        assert_eq!(r, Ok(r#"{"error":"database not initialized"}"#.to_string()));
    }

    #[test]
    fn select_bd_result_returns_json_on_success() {
        let r = select_bd_result(true, r#"{"id":"tt-4qs"}"#, "");
        assert_eq!(r, Ok(r#"{"id":"tt-4qs"}"#.to_string()));
    }

    #[test]
    fn select_bd_result_surfaces_stderr_when_stdout_is_not_json() {
        // Shell failure (missing `bd`, bad cd): non-JSON stdout, real stderr -> Err(stderr).
        let r = select_bd_result(false, "", "zsh: command not found: bd");
        assert_eq!(r, Err("zsh: command not found: bd".to_string()));
    }

    #[test]
    fn select_bd_result_errors_when_no_output() {
        assert_eq!(select_bd_result(true, "", ""), Err("bd produced no output".to_string()));
        assert_eq!(select_bd_result(false, "", ""), Err("bd produced no output".to_string()));
    }

    #[test]
    fn select_bd_raw_passes_through_json_array_on_success() {
        // `bd list --json` emits a JSON array (starts with '['), not '{' — it must pass through
        // verbatim rather than being treated as an error.
        let r = select_bd_raw(true, r#"[{"id":"sparkle-x"}]"#, "");
        assert_eq!(r, Ok(r#"[{"id":"sparkle-x"}]"#.to_string()));
    }

    #[test]
    fn select_bd_raw_surfaces_failure_and_empty() {
        assert_eq!(
            select_bd_raw(false, "", "zsh: command not found: bd"),
            Err("zsh: command not found: bd".to_string())
        );
        assert_eq!(select_bd_raw(true, "", ""), Err("bd produced no output".to_string()));
        // A caught bd error on failure (JSON on stdout) is passed through, not errored.
        assert_eq!(
            select_bd_raw(false, r#"{"error":"no such issue"}"#, ""),
            Ok(r#"{"error":"no such issue"}"#.to_string())
        );
    }

    #[test]
    fn select_bd_action_reports_ok_on_silent_success() {
        assert_eq!(select_bd_action(true, "", ""), Ok("ok".to_string()));
        assert_eq!(select_bd_action(true, "added dep", ""), Ok("added dep".to_string()));
        assert_eq!(
            select_bd_action(false, "", "no such issue"),
            Err("no such issue".to_string())
        );
    }

    #[test]
    fn write_prd_rejects_unsafe_filenames() {
        let dir = std::env::temp_dir().join(format!("sparkle_prd_reject_{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.to_string_lossy().to_string();

        for bad in ["../escape.md", "sub/dir.md", "a\\b.md", "..", "/etc/passwd", ""] {
            let r = write_prd(p.clone(), bad.to_string(), "x".into());
            assert!(r.is_err(), "expected rejection for {bad:?}, got {r:?}");
        }
        // None of the rejected writes should have created a PRD dir/file outside intent.
        assert!(!dir.join("PRD").join("escape.md").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_prd_writes_and_returns_relative_path() {
        let dir = std::env::temp_dir().join(format!("sparkle_prd_write_{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.to_string_lossy().to_string();

        let rel = write_prd(p.clone(), "branch.md".into(), "# hello\n".into()).unwrap();
        assert_eq!(rel, "PRD/branch.md");
        let written = std::fs::read_to_string(Path::new(&p).join("PRD").join("branch.md")).unwrap();
        assert_eq!(written, "# hello\n");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn build_create_bead_command_minimal_uses_defaults() {
        // Empty type defaults to "task"; no optional flags appended; only 4 positional args.
        let (script, args) =
            build_create_bead_command("/proj", "My Title", "body text", "", "", "", "");
        assert_eq!(script, r#"cd "$1" && bd create "$2" -d "$3" -t "$4" --json"#);
        assert_eq!(args, vec!["/proj", "My Title", "body text", "task"]);
    }

    #[test]
    fn build_create_bead_command_all_fields_are_positional_and_contiguous() {
        let (script, args) = build_create_bead_command(
            "/proj",
            "Title",
            "Body",
            "bug",
            "sparkle-parent",
            "blocks:sparkle-x,sparkle-y",
            "ui,backend",
        );
        // Flags reference $5/$6/$7 in append order (parent, deps, labels); values never inlined.
        assert_eq!(
            script,
            r#"cd "$1" && bd create "$2" -d "$3" -t "$4" --parent "$5" --deps "$6" -l "$7" --json"#
        );
        assert_eq!(
            args,
            vec![
                "/proj",
                "Title",
                "Body",
                "bug",
                "sparkle-parent",
                "blocks:sparkle-x,sparkle-y",
                "ui,backend",
            ]
        );
    }

    #[test]
    fn build_create_bead_command_skips_omitted_optionals_keeping_indices_contiguous() {
        // Only labels provided: it must land on $5 (not $7) since parent/deps were skipped.
        let (script, args) =
            build_create_bead_command("/proj", "T", "B", "task", "", "", "docs");
        assert_eq!(
            script,
            r#"cd "$1" && bd create "$2" -d "$3" -t "$4" -l "$5" --json"#
        );
        assert_eq!(args, vec!["/proj", "T", "B", "task", "docs"]);
    }

    #[test]
    fn bead_label_rejects_invalid_action() {
        let r = bead_label("/proj".into(), "delete".into(), "sparkle-x".into(), "ui".into());
        assert!(r.is_err());
    }
}
