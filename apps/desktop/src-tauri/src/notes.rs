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
}
