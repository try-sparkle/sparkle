//! Durable "not now" for a pull request the open-PR menu should stop offering.
//!
//! WHY THIS EXISTS (bead sparkle-j881r). The PR chiclet went fleet-wide, so it counts pull requests
//! across every open project tab — including repos the user can open PRs into but has no write
//! access to. The menu offered a Merge button that ends in `GraphQL: <user> does not have the
//! correct permissions to execute MergePullRequest`, and nothing made it stop asking. Every refresh
//! re-offered it. A list whose entire promise is "these are ready" teaches you to ignore it the
//! moment one row on it can never be acted on.
//!
//! The FIRST answer to that is the merge-rights pre-check in `worktree::probe_viewer_permission` —
//! a button that cannot work should not be drawn, and the permission is knowable before the click.
//! This module is the SECOND answer, for everything a pre-check cannot see: a PR that is stale,
//! superseded, or simply abandoned, where nothing about it is wrong except that the user is done
//! looking at it.
//!
//! ── WHAT IS STORED, AND WHY IT IS A FINGERPRINT RATHER THAN A FLAG ──────────────────────────
//!
//! A dismissal means **"not now"**, never "never". So a record is not a boolean; it is a snapshot
//! of the three facts that made the PR uninteresting at the moment it was dismissed:
//!
//!   * `head_ref_oid` — the head commit. A push changes it, and a pushed PR is a different
//!     proposition from the one that was waved away.
//!   * `tone` — the readiness verdict then ("ready" | "waiting" | "blocked").
//!   * `viewer_can_merge` — whether the user had merge rights then.
//!
//! The REVIVAL RULE that reads those lives in the frontend (`services/prDismissals.ts`), pure and
//! unit-tested, because it is a judgement about a live probe rather than a property of the file.
//! This module deliberately holds no opinion about when a dismissal expires: it stores what was
//! true, and the caller decides whether it still is. Splitting it the other way would put the rule
//! behind an IPC boundary and a `gh` call, where it could not be tested cheaply.
//!
//! ── FAIL-SAFE DIRECTION ─────────────────────────────────────────────────────────────────────
//!
//! A corrupt or unreadable store degrades to EMPTY, which shows MORE than the user asked for rather
//! than less. That is the right direction on this surface: the failure mode of a lost dismissal is
//! a row reappearing (annoying, and re-dismissable in one click), while the failure mode of a
//! phantom dismissal is a mergeable pull request that is invisible and uncounted, with nothing on
//! screen to explain its absence. The founder has been bitten by invisible state repeatedly; this
//! module may never add to it, which is also why every dismissal is listed back to the UI and can
//! be restored.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// One dismissed pull request, as it was when the user dismissed it.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PrDismissal {
    pub number: u64,
    /// The head commit at dismissal time. Empty when the probe did not supply one (an older Rust
    /// build), which the revival rule treats as "cannot compare" rather than as "unchanged".
    pub head_ref_oid: String,
    /// The readiness tone at dismissal time: "ready" | "waiting" | "blocked". Stored as the string
    /// the frontend already speaks so no mapping table has to agree across the IPC boundary.
    pub tone: String,
    /// Whether the user could merge in this repo at dismissal time. A `false` here is what makes
    /// "you have since been granted write access" a revival: see the frontend rule.
    pub viewer_can_merge: bool,
    /// Epoch seconds — rendered in the Dismissed list so a stale dismissal can be recognised.
    pub dismissed_at: i64,
}

/// The whole durable set. Nested by project id rather than flattened under a composite key, for the
/// same two reasons `pr_owner`'s store is: the file stays readable by a human debugging a missing
/// row, and no separator character can be smuggled in through an id.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(default)]
pub struct PrDismissalStore {
    /// projectId → PR number (as a string, since JSON object keys are strings) → dismissal.
    pub projects: BTreeMap<String, BTreeMap<String, PrDismissal>>,
}

/// Epoch seconds, or 0 if the clock is before the epoch (which nothing here depends on).
fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

// ── pure store operations ───────────────────────────────────────────────────────────────────

/// Record a dismissal. Returns whether anything changed, so the caller can skip the write.
///
/// A repeat dismissal of the same PR OVERWRITES the fingerprint rather than being ignored. That is
/// the case where a revived PR is dismissed again: the new snapshot is what the next revival has to
/// be judged against, and keeping the old one would make the row bounce back immediately.
pub fn dismiss(
    store: &mut PrDismissalStore,
    project_id: &str,
    number: u64,
    head_ref_oid: &str,
    tone: &str,
    viewer_can_merge: bool,
    now: i64,
) -> bool {
    if project_id.is_empty() || number == 0 {
        return false;
    }
    let rec = PrDismissal {
        number,
        head_ref_oid: head_ref_oid.to_string(),
        tone: tone.to_string(),
        viewer_can_merge,
        dismissed_at: now,
    };
    let slot = store.projects.entry(project_id.to_string()).or_default();
    let key = number.to_string();
    if slot.get(&key) == Some(&rec) {
        return false;
    }
    slot.insert(key, rec);
    true
}

/// Undo a dismissal — the user's "put it back", and also what the revival rule calls when the
/// reason for the dismissal has gone away. Returns whether anything was actually removed.
///
/// Prunes the project's map when it empties, so restoring the last dismissal leaves no husk behind
/// for a human reading the file to mistake for a still-dismissed project.
pub fn restore(store: &mut PrDismissalStore, project_id: &str, number: u64) -> bool {
    let Some(slot) = store.projects.get_mut(project_id) else {
        return false;
    };
    let removed = slot.remove(&number.to_string()).is_some();
    if slot.is_empty() {
        store.projects.remove(project_id);
    }
    removed
}

/// Drop dismissals for PRs that are no longer open — given the numbers a SUCCESSFUL probe returned.
///
/// A dismissed PR that is later merged or closed vanishes from `gh pr list`, and its record would
/// otherwise sit in this file forever, growing the store without bound and cluttering the Dismissed
/// list with pull requests that no longer exist.
///
/// THE CALLER MUST ONLY PASS A COMPLETE, SUCCESSFUL LIST. On a failed probe every dismissal would
/// look closed and the whole set would be erased — the exact confident-zero-from-a-machine-that-
/// failed-to-look mistake the surrounding null-vs-zero discipline exists to prevent. The command
/// wrapper below enforces that by taking the open numbers explicitly rather than probing here.
pub fn prune_to_open(
    store: &mut PrDismissalStore,
    project_id: &str,
    open_numbers: &[u64],
) -> bool {
    let Some(slot) = store.projects.get_mut(project_id) else {
        return false;
    };
    let before = slot.len();
    slot.retain(|k, _| k.parse::<u64>().is_ok_and(|n| open_numbers.contains(&n)));
    let changed = slot.len() != before;
    if slot.is_empty() {
        store.projects.remove(project_id);
    }
    changed
}

/// Every dismissal in `project_id`, in PR-number order. Empty when the project has none.
pub fn list(store: &PrDismissalStore, project_id: &str) -> Vec<PrDismissal> {
    let mut out: Vec<PrDismissal> =
        store.projects.get(project_id).map(|m| m.values().cloned().collect()).unwrap_or_default();
    out.sort_by_key(|d| d.number);
    out
}

// ── file-backed store ───────────────────────────────────────────────────────────────────────

/// `<app_data>/pr-dismissals.json`.
pub fn store_path(app_data: &Path) -> PathBuf {
    app_data.join("pr-dismissals.json")
}

/// Serializes every read-modify-write, exactly as `pr_owner`'s does and for the same reason: the
/// 3-minute PR poll (one probe per open project tab, concurrently) and a user's click both
/// read-modify-write this file, and a lost update here means a dismissal that silently did nothing.
fn store_lock() -> &'static Mutex<()> {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Read the store. A missing, unreadable or corrupt file degrades to EMPTY — see the module header
/// for why that direction is the safe one here.
pub fn load_store(app_data: &Path) -> PrDismissalStore {
    std::fs::read_to_string(store_path(app_data))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_store(app_data: &Path, store: &PrDismissalStore) -> Result<(), String> {
    std::fs::create_dir_all(app_data).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(store_path(app_data), text).map_err(|e| e.to_string())
}

/// Dismiss `number` in `project_id`, and hand back the project's whole dismissal set so the caller
/// never has to re-read to stay in step.
pub fn dismiss_pr(
    app_data: &Path,
    project_id: &str,
    number: u64,
    head_ref_oid: &str,
    tone: &str,
    viewer_can_merge: bool,
) -> Result<Vec<PrDismissal>, String> {
    let _g = store_lock().lock().map_err(|e| e.to_string())?;
    let mut store = load_store(app_data);
    if dismiss(&mut store, project_id, number, head_ref_oid, tone, viewer_can_merge, now_secs()) {
        save_store(app_data, &store)?;
    }
    Ok(list(&store, project_id))
}

/// Un-dismiss `number` — the user's Restore, and the revival path.
pub fn restore_pr(
    app_data: &Path,
    project_id: &str,
    number: u64,
) -> Result<Vec<PrDismissal>, String> {
    let _g = store_lock().lock().map_err(|e| e.to_string())?;
    let mut store = load_store(app_data);
    if restore(&mut store, project_id, number) {
        save_store(app_data, &store)?;
    }
    Ok(list(&store, project_id))
}

/// The dismissals for `project_id`, optionally pruned to the PRs a successful probe found open.
///
/// `open_numbers: None` means "we did not get a complete open list" and skips the prune entirely,
/// which is the fail-safe reading — see [`prune_to_open`].
pub fn dismissals_for(
    app_data: &Path,
    project_id: &str,
    open_numbers: Option<&[u64]>,
) -> Result<Vec<PrDismissal>, String> {
    let _g = store_lock().lock().map_err(|e| e.to_string())?;
    let mut store = load_store(app_data);
    if let Some(open) = open_numbers {
        if prune_to_open(&mut store, project_id, open) {
            save_store(app_data, &store)?;
        }
    }
    Ok(list(&store, project_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(store: &PrDismissalStore, project: &str, n: u64) -> Option<PrDismissal> {
        store.projects.get(project).and_then(|m| m.get(&n.to_string())).cloned()
    }

    #[test]
    fn dismiss_records_the_fingerprint_not_just_a_flag() {
        let mut s = PrDismissalStore::default();
        assert!(dismiss(&mut s, "p1", 39, "abc123", "ready", false, 1_700_000_000));
        let got = rec(&s, "p1", 39).expect("recorded");
        assert_eq!(got.number, 39);
        assert_eq!(got.head_ref_oid, "abc123");
        assert_eq!(got.tone, "ready");
        assert!(!got.viewer_can_merge);
        assert_eq!(got.dismissed_at, 1_700_000_000);
    }

    #[test]
    fn re_dismissing_overwrites_the_fingerprint_so_the_row_does_not_bounce_back() {
        // The revived-then-dismissed-again case. Keeping the FIRST snapshot would make the next
        // revival check compare against a head commit that has already changed, so the row would
        // reappear on the very next poll.
        let mut s = PrDismissalStore::default();
        dismiss(&mut s, "p1", 39, "old", "blocked", false, 1);
        assert!(dismiss(&mut s, "p1", 39, "new", "ready", false, 2));
        let got = rec(&s, "p1", 39).expect("recorded");
        assert_eq!(got.head_ref_oid, "new");
        assert_eq!(got.tone, "ready");
        assert_eq!(got.dismissed_at, 2);
    }

    #[test]
    fn an_identical_re_dismissal_reports_no_change_so_the_caller_can_skip_the_write() {
        let mut s = PrDismissalStore::default();
        assert!(dismiss(&mut s, "p1", 39, "abc", "ready", false, 5));
        assert!(!dismiss(&mut s, "p1", 39, "abc", "ready", false, 5));
    }

    #[test]
    fn dismiss_refuses_an_empty_project_or_a_zero_number() {
        let mut s = PrDismissalStore::default();
        assert!(!dismiss(&mut s, "", 39, "abc", "ready", false, 1));
        assert!(!dismiss(&mut s, "p1", 0, "abc", "ready", false, 1));
        assert!(s.projects.is_empty());
    }

    #[test]
    fn dismissals_are_scoped_per_project_because_pr_numbers_collide_across_repos() {
        // Every repo numbers its PRs from 1, so a fleet-wide list routinely holds two different
        // pull requests both called #39. Dismissing one may never hide the other.
        let mut s = PrDismissalStore::default();
        dismiss(&mut s, "p1", 39, "a", "ready", false, 1);
        assert!(rec(&s, "p1", 39).is_some());
        assert!(rec(&s, "p2", 39).is_none());
        assert_eq!(list(&s, "p2"), vec![]);
    }

    #[test]
    fn restore_removes_the_record_and_leaves_no_empty_project_husk() {
        let mut s = PrDismissalStore::default();
        dismiss(&mut s, "p1", 39, "a", "ready", false, 1);
        assert!(restore(&mut s, "p1", 39));
        assert!(s.projects.is_empty(), "an emptied project map must be removed, not left behind");
        assert!(!restore(&mut s, "p1", 39), "restoring twice reports nothing changed");
        assert!(!restore(&mut s, "nope", 1));
    }

    #[test]
    fn prune_drops_dismissals_for_prs_that_are_no_longer_open() {
        let mut s = PrDismissalStore::default();
        dismiss(&mut s, "p1", 39, "a", "ready", false, 1);
        dismiss(&mut s, "p1", 40, "b", "ready", false, 1);
        assert!(prune_to_open(&mut s, "p1", &[40]));
        assert!(rec(&s, "p1", 39).is_none(), "#39 closed upstream — its dismissal goes with it");
        assert!(rec(&s, "p1", 40).is_some(), "#40 is still open and still dismissed");
    }

    #[test]
    fn prune_with_nothing_open_clears_the_project_entirely() {
        let mut s = PrDismissalStore::default();
        dismiss(&mut s, "p1", 39, "a", "ready", false, 1);
        assert!(prune_to_open(&mut s, "p1", &[]));
        assert!(s.projects.is_empty());
    }

    #[test]
    fn prune_reports_no_change_when_every_dismissal_is_still_open() {
        let mut s = PrDismissalStore::default();
        dismiss(&mut s, "p1", 39, "a", "ready", false, 1);
        assert!(!prune_to_open(&mut s, "p1", &[39, 40, 41]));
        assert!(rec(&s, "p1", 39).is_some());
    }

    #[test]
    fn list_is_ordered_by_number_so_the_dismissed_section_does_not_reshuffle() {
        let mut s = PrDismissalStore::default();
        dismiss(&mut s, "p1", 40, "b", "ready", false, 1);
        dismiss(&mut s, "p1", 7, "a", "ready", false, 1);
        dismiss(&mut s, "p1", 39, "c", "ready", false, 1);
        assert_eq!(list(&s, "p1").iter().map(|d| d.number).collect::<Vec<_>>(), vec![7, 39, 40]);
    }

    #[test]
    fn the_file_round_trips_so_a_dismissal_survives_a_restart() {
        let d = tempfile::tempdir().unwrap();
        let got = dismiss_pr(d.path(), "p1", 39, "abc123", "ready", false).unwrap();
        assert_eq!(got.len(), 1);
        // A FRESH read from disk — the point of the test is that nothing is held in memory.
        let reloaded = load_store(d.path());
        assert_eq!(rec(&reloaded, "p1", 39).unwrap().head_ref_oid, "abc123");
        let after = restore_pr(d.path(), "p1", 39).unwrap();
        assert!(after.is_empty());
        assert!(load_store(d.path()).projects.is_empty());
    }

    #[test]
    fn a_corrupt_store_degrades_to_empty_rather_than_hiding_pull_requests() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(store_path(d.path()), "{ not json").unwrap();
        assert_eq!(load_store(d.path()), PrDismissalStore::default());
        assert_eq!(dismissals_for(d.path(), "p1", None).unwrap(), vec![]);
    }

    #[test]
    fn dismissals_for_prunes_only_when_it_is_given_a_complete_open_list() {
        let d = tempfile::tempdir().unwrap();
        dismiss_pr(d.path(), "p1", 39, "a", "ready", false).unwrap();
        // A FAILED probe passes None, and must never be read as "nothing is open" — that would
        // erase every dismissal the moment `gh` hiccuped.
        assert_eq!(dismissals_for(d.path(), "p1", None).unwrap().len(), 1);
        // A successful probe that no longer lists #39 does prune it.
        assert_eq!(dismissals_for(d.path(), "p1", Some(&[])).unwrap().len(), 0);
    }
}
