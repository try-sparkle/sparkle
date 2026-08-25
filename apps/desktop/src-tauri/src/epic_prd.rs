// epic_prd — an epic's PRD path, written to and read from bd METADATA rather than scraped out of
// the bead's prose description (bead `sparkle-xelans.5`).
//
// ── WHY METADATA, AND WHY THIS IS *NOT* THE STORAGE `epicGoal` PICKED ─────────────────────────
// `engine/epicGoal.ts` stores an epic's GOAL on `Project.epicGoals` in the desktop's persisted
// store, explicitly not on the bead, and its header gives the reason: there is no bd write path for
// a description, and manufacturing one would mean rewriting a shared Dolt store that has no diff
// and no revert — the wrong trade for a display field.
//
// NEITHER HALF OF THAT REASONING SURVIVES FOR THE PRD PATH, which is why this is a different
// answer to a question that only looks like the same one:
//
//   1. THERE IS A WRITE PATH, and it is first-class rather than manufactured: `bd update <id>
//      --set-metadata prd=<path>` (verified against bd 1.2.2). It is a structured key/value on the
//      bead, not a rewrite of any prose a human wrote, so it cannot clobber someone's wording.
//   2. THE READER IS NOT THE APP. A goal is a display field for the founder's screen; the PRD
//      back-link exists so a FUTURE AGENT — a fresh `bd show <epic>` in some other worktree, weeks
//      later — can find the plan. The founder's ask was exactly that: "retrievable later by future
//      agents trying to understand what the epic is about." A path in this app's local persisted
//      store is invisible to every one of those readers, so storing it there would answer the
//      display question and miss the ask.
//   3. IT COSTS NO EXTRA READ. `metadata` is already on the wire of the bulk `bd list … --json`
//      call the board polls, so a structured PRD path is carried by a query that already runs.
//
// Two commands, deliberately narrow — this module writes and reads ONE metadata key and nothing
// else. A general "set any metadata on any bead" command is a bigger blast radius than the ask
// needs, and a shared Dolt store is the wrong place to hand out a generic write.
use serde::{Deserialize, Serialize};

use crate::beads_cmd::{
    bd_ack_for_epic_prd, bd_stdout_for_epic_prd, blocking_for_epic_prd, require_id_for_epic_prd,
    BeadsError, BeadsErrorKind, NO_EXTRA_ENV,
};

/// THE metadata key. One constant, mirrored by `EPIC_PRD_METADATA_KEY` in
/// `apps/desktop/src/services/epicPrd.ts` — a second spelling on either side would write a key
/// nothing reads, silently, which is precisely the failure this bead exists to end.
pub const EPIC_PRD_KEY: &str = "prd";

/// One epic's structured PRD back-link, as `list_epic_prd` reports it.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EpicPrdEntry {
    pub id: String,
    /// The repo-relative PRD path, exactly as it was written (paths may contain spaces).
    pub prd: String,
}

/// Assemble the argv for the WRITE. Pure, so the flag form is unit-testable without invoking bd.
///
/// `--set-metadata=prd=<path>` uses the `=` form ON PURPOSE. `--set-metadata` is a pflag
/// `stringArray`, so the separate-token form consumes the next argv token whatever it is; binding
/// the value inside a single token means no path can ever be re-read as an option. Verified against
/// bd 1.2.2, including a path containing a space.
fn build_set_prd_args(id: &str, prd_path: &str) -> Vec<String> {
    vec!["update".into(), id.to_string(), format!("--set-metadata={EPIC_PRD_KEY}={prd_path}")]
}

/// Assemble the argv for the READ. Pure.
///
/// `--has-metadata-key prd` is what keeps this cheap: it returns ONLY the beads that carry a PRD
/// back-link, not the whole store. Measured against this repo at 9,802 beads it answers in ~3.6s,
/// where an unfiltered `bd list --limit 0 --json` is a multi-megabyte read that can take ~45s under
/// fleet load. `--status all` is required — `bd list` excludes closed beads by default, and a
/// closed epic's PRD is still the record of what it was about.
fn build_list_prd_args() -> Vec<String> {
    vec![
        "list".into(),
        "--status".into(),
        "all".into(),
        "--has-metadata-key".into(),
        EPIC_PRD_KEY.to_string(),
        "--limit".into(),
        "0".into(),
        "--json".into(),
    ]
}

/// Reject a PRD path bd could not carry back intact, BEFORE shelling out.
///
/// Empty is a delete dressed as a write — `--unset-metadata` is the honest way to clear a key, and
/// this command deliberately does not offer it. A newline would make the value unreadable in every
/// surface that prints a bead one line at a time. Everything else — spaces very much included —
/// is legal: `write_prd` allows them and real PRD filenames use them.
fn check_prd_path(prd_path: &str) -> Result<(), BeadsError> {
    if prd_path.trim().is_empty() {
        return Err(BeadsError::new(
            BeadsErrorKind::InvalidInput,
            "PRD path must not be empty (use bd's --unset-metadata to clear the key)",
        ));
    }
    if prd_path.contains('\n') || prd_path.contains('\r') {
        return Err(BeadsError::new(
            BeadsErrorKind::InvalidInput,
            "PRD path must not contain a newline",
        ));
    }
    Ok(())
}

/// Pull `[{id, metadata:{prd}}]` out of `bd list --json` stdout.
///
/// TOLERANT, in the same shape as every other bd reader here: a row without an id, without a
/// metadata bag, or whose `prd` is not a non-empty string is SKIPPED rather than failing the whole
/// read. One malformed row must not cost every other epic its PRD link.
fn parse_prd_rows(stdout: &str) -> Result<Vec<EpicPrdEntry>, BeadsError> {
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim()).map_err(|e| {
        BeadsError::new(BeadsErrorKind::BdFailed, format!("bd list JSON was unreadable: {e}"))
    })?;
    let rows = parsed.as_array().ok_or_else(|| {
        BeadsError::new(BeadsErrorKind::BdFailed, "bd list did not return a JSON array")
    })?;
    let mut out = Vec::new();
    for row in rows {
        let Some(id) = row.get("id").and_then(serde_json::Value::as_str).filter(|s| !s.is_empty())
        else {
            continue;
        };
        let Some(prd) = row
            .get("metadata")
            .and_then(|m| m.get(EPIC_PRD_KEY))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        out.push(EpicPrdEntry { id: id.to_string(), prd: prd.to_string() });
    }
    Ok(out)
}

fn set_epic_prd_inner(project_path: &str, id: &str, prd_path: &str) -> Result<(), BeadsError> {
    require_id_for_epic_prd(id)?;
    check_prd_path(prd_path)?;
    bd_ack_for_epic_prd(project_path, &build_set_prd_args(id, prd_path), NO_EXTRA_ENV)
}

fn list_epic_prd_inner(project_path: &str) -> Result<Vec<EpicPrdEntry>, BeadsError> {
    parse_prd_rows(&bd_stdout_for_epic_prd(project_path, &build_list_prd_args(), NO_EXTRA_ENV)?)
}

// ── Commands ──────────────────────────────────────────────────────────────────────────────────

/// Record an epic's PRD path as structured `prd` metadata on the bead. IDEMPOTENT — bd overwrites
/// the key, so re-recording the same path is a no-op write rather than a second value.
#[tauri::command]
pub async fn set_epic_prd(
    project_path: String,
    id: String,
    prd_path: String,
) -> Result<(), BeadsError> {
    blocking_for_epic_prd(move || set_epic_prd_inner(&project_path, &id, &prd_path)).await
}

/// Every bead in this project that carries a `prd` metadata key, as `{id, prd}` pairs.
#[tauri::command]
pub async fn list_epic_prd(project_path: String) -> Result<Vec<EpicPrdEntry>, BeadsError> {
    blocking_for_epic_prd(move || list_epic_prd_inner(&project_path)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_argv_binds_the_value_inside_one_token_and_keeps_spaces() {
        assert_eq!(
            build_set_prd_args("", "PRD/my plan.md"),
            vec!["update", "", "--set-metadata=prd=PRD/my plan.md"]
        );
    }

    #[test]
    fn read_argv_asks_for_closed_beads_and_filters_on_the_key() {
        let args = build_list_prd_args();
        assert_eq!(
            args,
            vec!["list", "--status", "all", "--has-metadata-key", "prd", "--limit", "0", "--json"]
        );
    }

    #[test]
    fn a_flag_like_id_or_an_empty_path_is_rejected_before_bd_runs() {
        // `/tmp` is never reached: both guards return before anything is spawned.
        assert!(set_epic_prd_inner("/tmp", "--force", "PRD/x.md").is_err());
        assert!(set_epic_prd_inner("/tmp", "", "   ").is_err());
        assert!(set_epic_prd_inner("/tmp", "", "PRD/a\nb.md").is_err());
    }

    /// bd 1.2.2's real shape, captured from `bd list --status all --has-metadata-key prd --json`
    /// against this repo, plus the three malformed rows the parser must SKIP rather than throw on.
    const FIXTURE: &str = r#"[
      {"id":"sparkle-w0ez86","title":"one","status":"closed","metadata":{"prd":"PRD/eq form.md"}},
      {"id":"sparkle-nometa","title":"two","status":"open"},
      {"id":"sparkle-empty","title":"three","status":"open","metadata":{"prd":"  "}},
      {"title":"no id","status":"open","metadata":{"prd":"PRD/orphan.md"}},
      {"id":"sparkle-good2","title":"four","status":"open","metadata":{"prd":"PRD/b.md","team":"x"}}
    ]"#;

    #[test]
    fn parser_keeps_the_good_rows_and_skips_the_malformed_ones() {
        let rows = parse_prd_rows(FIXTURE).expect("fixture parses");
        assert_eq!(
            rows,
            vec![
                EpicPrdEntry { id: "sparkle-w0ez86".into(), prd: "PRD/eq form.md".into() },
                EpicPrdEntry { id: "sparkle-good2".into(), prd: "PRD/b.md".into() },
            ]
        );
    }

    #[test]
    fn unreadable_stdout_is_an_error_rather_than_an_empty_index() {
        // An empty index would read as "no epic has a PRD" and silently retire every back-link.
        assert!(parse_prd_rows("not json").is_err());
        assert!(parse_prd_rows(r#"{"id":"x"}"#).is_err());
        assert_eq!(parse_prd_rows("[]").expect("empty array is legal"), vec![]);
    }
}
