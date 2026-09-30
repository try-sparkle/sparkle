//! Which of these beads does a LANDED commit already name? (bead `sparkle-5wjy5a`)
//!
//! The epic sweep judged "nobody is building this epic" from child-bead timestamps alone, and never
//! asked whether the remaining children were already fixed. Measured: it relaunched an orchestrator
//! against an epic whose six open children had all been fixed by two PRs that merged the same
//! morning, spending the epic's one automatic restart on a plan with nothing left in it.
//!
//! THIS DOES NOT RE-IMPLEMENT THE TRAILER SCAN. `scripts/bead-landed-check.sh` is the one reader of
//! "a `Refs:`/`Fixes:` trailer on an ancestor of the default branch names this bead", with its own
//! suite for prefixes, dotted trailers, docs-only commits and shallow clones. This runs it and keeps
//! only its `LANDED` rows. A second parser here would be a second opinion, which this repo ranks as
//! worse than none.
//!
//! READ-ONLY, and narrow in what it claims:
//!   * `--no-fetch`: the sweep runs every ten minutes on projects nobody is looking at, and a
//!     network round trip per epic is not worth it. An unrefreshed ref can only HIDE a landing, so a
//!     `LANDED` row is still true; only absence would need the fetch, and absence is never used.
//!   * `--no-bd`: the ids come from the board the sweep already read, and `bd` is the contended
//!     single-writer store.
//!   * `DOCS-ONLY` and `IN FLIGHT` rows are NOT landed. Only the strongest verdict counts.
//!   * Any exit outside the script's verdict space, a signal, a timeout or a missing script is an
//!     `Err`, which the TS caller maps to "could not tell" — and that leaves the sweep deciding
//!     exactly as it did before this existed.
use std::path::Path;
use std::process::Command;
use std::time::Duration;

const SCRIPT: &str = "scripts/bead-landed-check.sh";
/// Bounds the script's own 180s `git log` with room to spare; the sweep awaits this per epic.
const TIMEOUT: Duration = Duration::from_secs(120);
/// `bead-landed-check.sh`'s verdict space. 2 (usage) and anything else are not verdicts.
const VERDICT_CODES: [i32; 5] = [0, 3, 10, 11, 12];

fn plausible_bead_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('-')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_'))
}

/// The ids on `LANDED` rows, restricted to the ids that were asked about and de-duplicated in
/// first-seen order.
pub(crate) fn parse_landed_ids(stdout: &str, asked: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in stdout.lines() {
        let mut fields = line.split_whitespace();
        if fields.next() != Some("LANDED") {
            continue;
        }
        if let Some(id) = fields.next() {
            if asked.iter().any(|a| a == id) && !out.iter().any(|o| o == id) {
                out.push(id.to_string());
            }
        }
    }
    out
}

pub(crate) fn landed_bead_ids_in(root: &str, ids: &[String]) -> Result<Vec<String>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    if let Some(bad) = ids.iter().find(|id| !plausible_bead_id(id)) {
        return Err(format!("not a bead id: {bad}"));
    }
    let script = Path::new(root).join(SCRIPT);
    if !script.exists() {
        return Err(format!("{SCRIPT} is not present in this repo, so landedness could not be read"));
    }
    let mut cmd = Command::new("bash");
    cmd.arg(&script)
        .args(["--no-fetch", "--no-bd", "--quiet"])
        .args(ids)
        .current_dir(root);
    crate::claude_oneshot::apply_noninteractive(&mut cmd);
    let out = crate::worktree::output_with_timeout(cmd, TIMEOUT)
        .map_err(|e| format!("{SCRIPT} could not be run: {e}"))?;
    let code = out
        .status
        .code()
        .ok_or_else(|| format!("{SCRIPT} was killed by a signal, so it produced no verdict"))?;
    if !VERDICT_CODES.contains(&code) {
        return Err(format!("{SCRIPT} exited {code}, which is not one of its verdicts"));
    }
    Ok(parse_landed_ids(&String::from_utf8_lossy(&out.stdout), ids))
}

/// The subset of `ids` that a landed commit names. `Err` means "could not tell", never "none".
#[tauri::command]
pub async fn bead_landed_ids(root: String, ids: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || landed_bead_ids_in(&root, &ids))
        .await
        .map_err(|e| format!("bead landed probe failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    // The row shapes below are the script's own printf formats, copied from bead-landed-check.sh.
    const SAMPLE: &str = "\
LANDED     sparkle-aaa1      landed on origin/main: 4e77aa129abc  confirm: git merge-base --is-ancestor 4e77 origin/main  [against origin/main]
IN FLIGHT  sparkle-bbb2      named by 1234abcd, not an ancestor
DOCS-ONLY  sparkle-ccc3      only a docs commit names it
CLEAR      sparkle-ddd4      no commit names this bead in a Refs:/Fixes: trailer  [against origin/main]
LANDED     sparkle-aaa1      a second landing commit
LANDED     sparkle-zzz9      an id nobody asked about
";

    #[test]
    fn keeps_only_landed_rows_for_asked_ids() {
        let asked = ids(&["sparkle-aaa1", "sparkle-bbb2", "sparkle-ccc3", "sparkle-ddd4"]);
        assert_eq!(parse_landed_ids(SAMPLE, &asked), ids(&["sparkle-aaa1"]));
    }

    #[test]
    fn in_flight_and_docs_only_are_not_landed() {
        // Only the strongest verdict counts. A weaker one would stop a restart for work that has not
        // shipped, which is the opposite failure.
        let asked = ids(&["sparkle-bbb2", "sparkle-ccc3"]);
        assert!(parse_landed_ids(SAMPLE, &asked).is_empty());
    }

    #[test]
    fn an_id_is_matched_exactly_never_as_a_prefix() {
        assert!(parse_landed_ids(SAMPLE, &ids(&[""])).is_empty());
        assert!(parse_landed_ids("LANDED     sparkle-aaa1x  …", &ids(&["sparkle-aaa1"])).is_empty());
    }

    #[test]
    fn no_ids_asks_nothing_and_a_bad_id_is_refused() {
        assert_eq!(landed_bead_ids_in("/nonexistent", &[]), Ok(Vec::new()));
        assert!(landed_bead_ids_in("/nonexistent", &ids(&["--apply"])).is_err());
        assert!(landed_bead_ids_in("/nonexistent", &ids(&["a b"])).is_err());
    }

    #[test]
    fn a_missing_script_is_an_error_not_an_empty_answer() {
        let r = landed_bead_ids_in("/nonexistent-root-for-bead-landed", &ids(&["sparkle-aaa1"]));
        assert!(r.is_err(), "absence of the script must read as could-not-tell, got {r:?}");
    }

    #[test]
    fn the_command_stays_registered_in_the_invoke_handler() {
        let lib_rs = include_str!("lib.rs");
        assert!(lib_rs.contains("bead_landed::bead_landed_ids"));
        assert!(lib_rs.contains("mod bead_landed;"));
    }
}
