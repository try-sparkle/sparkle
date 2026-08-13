//! Claude-account rotation for the roborev review daemon.
//!
//! # Why this exists
//!
//! roborev reviews by exec'ing the `claude` CLI from a launchd LaunchAgent
//! (`co.plow.roborev-daemon`) whose environment is stripped to `PATH`. Its `claude` child therefore
//! inherits `$HOME/.claude` — ONE account — for every review, forever. When that account hits a
//! Claude subscription wall, every review dies: 1,020 of 3,013 failed jobs in `~/.roborev/reviews.db`
//! are the quota/credential family, and **none was ever recovered**.
//!
//! roborev's own failover cannot save us. It has the machinery (`isQuotaError`, `cooldownAgent`,
//! `failing over from %s to %s (quota)`) but it has never fired once in 63,000+ jobs, because
//! `isQuotaError` matches only API-shaped tokens (`insufficient_quota`, `429`, …) and Claude Code's
//! SUBSCRIPTION wall text ("You've hit your session limit · resets 2am") appears nowhere in the
//! binary. The wall is misclassified as transient, so the job burns 3 retries in ~11 seconds against
//! a wall that resets in 1.5 hours, then fails permanently. roborev is a sha256-pinned binary from
//! another org — we cannot patch it, and it exposes no flag, env var, or config key for account
//! selection.
//!
//! # The mechanism
//!
//! A `claude` **shim** on the daemon's PATH. It selects a healthy account, exports
//! `CLAUDE_CONFIG_DIR`, and execs the real `claude`. That sidesteps roborev entirely: no roborev
//! change, no daemon restart, and rotation granularity is *per review job* rather than per daemon
//! lifetime. `CLAUDE_CONFIG_DIR` is already Sparkle's whole account mechanism (see [`crate::accounts`]).
//!
//! Verified empirically before this was built, in the exact stripped daemon environment
//! (`env -i HOME=… USER=… PATH=…`): a NON-default account authenticates fine (so the per-account
//! keychain item — service `"Claude Code-credentials-" + sha256(dir)[:8]`, see
//! [`crate::account_usage`] — is readable from that context), and `claude -p` writes its transcript
//! under `$CLAUDE_CONFIG_DIR/projects/<slug>/`. That second fact is what closes the loop for free:
//! `accounts_limit_events` detects walls by scanning those JSONL files for a structured
//! `error: "rate_limit"` envelope — **by file, not by process** — so a roborev wall marks that
//! account `exhausted_until` and the next job's shim routes around it, with no new detection code.
//!
//! # Policy (the founder's call, 2026-08-13)
//!
//! roborev shares the account pool with the interactive fleet but ranks **lowest priority**: it
//! picks the account with the most headroom, and if only ONE healthy account is left it **stands
//! down** rather than competing for it. Reviews degrade before the founder's own work does. A
//! stood-down job fails fast and honestly instead of burning the last account; re-running it is a
//! separate concern (see the reaper).
//!
//! # Split of responsibility
//!
//! Policy lives here, in Rust, where it is unit-tested. The shim is ~20 lines of POSIX `sh` that
//! does nothing but compare epochs and `exec` — deliberately dependency-free (no `jq`), so it stays
//! correct when Sparkle is closed and the candidate list is stale.

use crate::accounts::Account;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Marker line meaning "do not run a review at all" — written when fewer than two accounts are
/// healthy, so roborev never competes for the founder's last one. The shim exits non-zero on it.
pub const STANDDOWN: &str = "STANDDOWN";

/// Header written at the top of the candidate file. Purely informational; the shim skips `#` lines.
const CANDIDATES_HEADER: &str =
    "# sparkle roborev claude-account candidates v1 — <exhaustedUntilEpochSecs>\\t<configDir>";

/// Below this many healthy accounts, roborev stands down (see the policy note above). Two, not one:
/// at exactly one healthy account, using it IS taking the founder's last one.
const MIN_HEALTHY_TO_RUN: usize = 2;

/// A ranked account the shim may select. `dir` empty means the default account — "export no
/// `CLAUDE_CONFIG_DIR` at all", the same sentinel [`crate::accounts::Account::config_dir`] uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub dir: String,
    /// Epoch seconds this account is exhausted until; `0` = healthy.
    pub exhausted_until: i64,
}

/// Is this account usable right now? `exhausted_until` in the future means walled.
///
/// Mirrors `accounts::effective_exhaustion`'s `e > now` future-filter, so an expired exhaustion
/// clears on its own rather than benching an account forever.
fn is_healthy(a: &Account, now: i64) -> bool {
    !a.exhausted_until.is_some_and(|e| e > now)
}

/// Rank the accounts roborev may use, best headroom first.
///
/// `headroom` maps account id → fraction of its ceiling already consumed (0.0 = untouched,
/// 1.0 = at the ceiling), as computed by the existing per-account usage model. An account missing
/// from the map is treated as `0.5` — neutral, so an unknown never sorts as either the best or the
/// worst choice on no evidence.
///
/// Returns EMPTY when fewer than [`MIN_HEALTHY_TO_RUN`] accounts are healthy: that is the
/// stand-down case, and the caller writes [`STANDDOWN`] rather than a list.
///
/// Pure — `now` is injected, so this is unit-testable without a clock.
pub fn rank_candidates(accounts: &[Account], headroom: &HashMap<String, f64>, now: i64) -> Vec<Candidate> {
    let mut healthy: Vec<&Account> = accounts.iter().filter(|a| is_healthy(a, now)).collect();
    if healthy.len() < MIN_HEALTHY_TO_RUN {
        return Vec::new();
    }
    // Most headroom first = least consumed first. Tie-break by id so the order is deterministic:
    // an unstable ranking would make the shim pick a different account run to run for no reason.
    healthy.sort_by(|a, b| {
        let ua = headroom.get(&a.id).copied().unwrap_or(0.5);
        let ub = headroom.get(&b.id).copied().unwrap_or(0.5);
        ua.partial_cmp(&ub)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.id.cmp(&b.id))
    });
    healthy
        .into_iter()
        .map(|a| Candidate {
            dir: a.config_dir.clone(),
            exhausted_until: a.exhausted_until.unwrap_or(0).max(0),
        })
        .collect()
}

/// Serialize candidates to the line format the shim parses.
///
/// One candidate per line, `<exhaustedUntil>\t<configDir>`, ranked best first. An EMPTY list
/// serializes to [`STANDDOWN`] — never to an empty file, which the shim could not distinguish from
/// a truncated write.
///
/// A `dir` containing a tab or newline would corrupt the format, so such an account is SKIPPED
/// rather than written: a config dir is a path Sparkle itself created (`<app_data>/accounts/<id>`),
/// so this cannot happen in practice, but a silently-misparsed line would send reviews to the wrong
/// account. Pure — unit-tested.
pub fn render_candidates(candidates: &[Candidate]) -> String {
    let usable: Vec<&Candidate> = candidates
        .iter()
        .filter(|c| !c.dir.contains('\t') && !c.dir.contains('\n'))
        .collect();
    if usable.is_empty() {
        return format!("{CANDIDATES_HEADER}\n{STANDDOWN}\n");
    }
    let mut out = String::from(CANDIDATES_HEADER);
    out.push('\n');
    for c in usable {
        out.push_str(&format!("{}\t{}\n", c.exhausted_until, c.dir));
    }
    out
}

/// The directory holding the account-selecting `claude` shim.
///
/// DELIBERATELY NOT `~/.roborev-shim`. That directory belongs to a different, retired mechanism —
/// an installer-provided shim that injected `ANTHROPIC_API_KEY` and set `CLAUDE_CODE_SIMPLE=1`,
/// forcing strict API-key auth against an unfunded key so every review died on "Credit balance is
/// too low". `setup.rs` still bans that directory from the daemon PATH by name, and that ban stays
/// valid: this shim selects a SUBSCRIPTION account and must never inject a key. Keeping the two
/// paths distinct makes them impossible to confuse.
pub fn shim_dir(home: &Path) -> PathBuf {
    home.join(".sparkle/roborev-claude")
}

/// Path of the shim executable itself. Named `claude` because that is what roborev looks up on PATH
/// (`claude_code_cmd = 'claude'`).
pub fn shim_path(home: &Path) -> PathBuf {
    shim_dir(home).join("claude")
}

/// Path of the ranked candidate list the shim reads.
pub fn candidates_path(home: &Path) -> PathBuf {
    shim_dir(home).join("candidates")
}

/// The shim source, shared verbatim with the shell suite.
///
/// The script lives in its own file rather than inline here specifically so
/// `scripts/tests/roborev-claude-shim.test.sh` executes THE SAME BYTES this function installs. A
/// copy in the test would be the classic two-halves-both-green seam: the Rust suite and the shell
/// suite would each pass against their own drifting version of a script neither actually ships.
const SHIM_TEMPLATE: &str = include_str!("../resources/roborev/claude-account-shim.sh");

/// Generate the shim script by substituting the template's two placeholders.
///
/// Both paths are baked in ABSOLUTE at install time rather than resolved from a runtime `$HOME`,
/// because the daemon environment is stripped and `exec`ing via PATH would re-enter this shim.
///
/// Invariants, each asserted by a unit test:
/// - it NEVER sets `ANTHROPIC_API_KEY` or `CLAUDE_CODE_SIMPLE` (the retired shim's bug);
/// - it **fails open** — an unreadable/absent list, or any parse failure, execs the real `claude`
///   with no `CLAUDE_CONFIG_DIR`, i.e. exactly today's behavior. A broken shim must never be worse
///   than no shim;
/// - it skips a candidate whose directory does not exist, so a removed account degrades to the next
///   one instead of failing the review;
/// - [`STANDDOWN`] exits non-zero WITHOUT exec'ing, so roborev never reaches the founder's last
///   healthy account.
///
/// Pure — unit-tested.
pub fn shim_script(real_claude: &str, candidates_file: &str) -> String {
    SHIM_TEMPLATE
        .replace("@REAL_CLAUDE@", real_claude)
        .replace("@CANDIDATES@", candidates_file)
}

/// Turn raw per-account 5h token tallies into the 0..1 "fraction consumed" [`rank_candidates`]
/// expects.
///
/// Normalized against the BUSIEST account rather than an absolute ceiling, because the learned
/// ceiling is per-identity and not available here — and ranking only needs the ORDER, not a
/// calibrated percentage. Normalizing also keeps the `0.5`-for-unknown default meaningful: raw token
/// counts would make every unknown account sort ahead of every known one, since 0.5 is below any
/// real tally.
///
/// All-zero tallies (a fresh install) map to 0.0 for everyone, so ranking falls back to the
/// deterministic id tie-break rather than dividing by zero. Pure — unit-tested.
pub fn headroom_from_tokens(tallies: &[(String, u64)]) -> HashMap<String, f64> {
    let max = tallies.iter().map(|(_, t)| *t).max().unwrap_or(0);
    if max == 0 {
        return tallies.iter().map(|(id, _)| (id.clone(), 0.0)).collect();
    }
    tallies
        .iter()
        .map(|(id, t)| (id.clone(), *t as f64 / max as f64))
        .collect()
}

/// Write `contents` to `path` atomically (temp file + rename), with `mode`.
///
/// Atomic because the roborev daemon reads these files CONCURRENTLY with Sparkle writing them —
/// there is no lock between a launchd agent and the app. A partial read of the candidate list would
/// silently route a review to the wrong account, or to none.
/// `mode` is a Unix permission bitmask and is ignored on other platforms — the module is compiled
/// everywhere (lib.rs declares it unconditionally) even though the roborev daemon it serves is
/// macOS-only, so the unix-only import has to be gated or the Windows compile check breaks.
fn write_atomic(path: &Path, contents: &str, mode: u32) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{path:?} has no parent directory"))?;
    std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {parent:?}: {e}"))?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, contents).map_err(|e| format!("writing {tmp:?} failed: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(mode))
            .map_err(|e| format!("chmod {tmp:?} failed: {e}"))?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    std::fs::rename(&tmp, path).map_err(|e| format!("installing {path:?} failed: {e}"))
}

/// Install (or refresh) the account-selecting shim. Idempotent — safe to call on every app launch.
///
/// `real_claude` must be the ABSOLUTE path to the genuine `claude` binary. Resolving it via PATH at
/// run time would re-enter this shim, which is itself named `claude`.
pub fn install_shim(home: &Path, real_claude: &str) -> Result<(), String> {
    if real_claude.trim().is_empty() {
        return Err("refusing to install the roborev shim without an absolute claude path".into());
    }
    write_atomic(&shim_path(home), &shim_script(real_claude, &candidates_path(home).to_string_lossy()), 0o755)
}

/// Recompute and publish the ranked candidate list the shim reads.
///
/// Call this whenever the account picture changes — most importantly from `accounts_mark_exhausted`,
/// which is where an observed wall is recorded. That is what closes the loop: a roborev review walls
/// an account, `accounts_limit_events` records it, this rewrites the list, and the NEXT review job's
/// shim picks a different account. Writing 0600: a candidate list names the user's account paths.
pub fn publish_candidates(
    home: &Path,
    accounts: &[Account],
    headroom: &HashMap<String, f64>,
    now: i64,
) -> Result<(), String> {
    let ranked = rank_candidates(accounts, headroom, now);
    write_atomic(&candidates_path(home), &render_candidates(&ranked), 0o600)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acct(id: &str, dir: &str, exhausted: Option<i64>) -> Account {
        Account {
            id: id.to_string(),
            nickname: id.to_string(),
            config_dir: dir.to_string(),
            is_default: false,
            created_at: 0,
            exhausted_until: exhausted,
            exhausted_identity: None,
        }
    }

    const NOW: i64 = 1_000_000;

    /// THE CORE ROTATION ASSERTION: a walled account is not offered, and a healthy sibling is.
    /// Paired — the same input with A healthy must offer A — because "B was chosen" alone cannot
    /// distinguish real rotation from a ranker that always returns B.
    #[test]
    fn a_walled_account_is_dropped_and_a_healthy_sibling_is_offered() {
        let walled = vec![
            acct("a", "/dir/a", Some(NOW + 5_000)),
            acct("b", "/dir/b", None),
            acct("c", "/dir/c", None),
        ];
        let dirs: Vec<String> = rank_candidates(&walled, &HashMap::new(), NOW)
            .into_iter()
            .map(|c| c.dir)
            .collect();
        assert!(!dirs.contains(&"/dir/a".to_string()), "walled account offered: {dirs:?}");
        assert!(dirs.contains(&"/dir/b".to_string()), "healthy account missing: {dirs:?}");

        // Paired case: A healthy → A is offered. Proves the exclusion is caused by the wall.
        let healthy = vec![
            acct("a", "/dir/a", None),
            acct("b", "/dir/b", None),
            acct("c", "/dir/c", None),
        ];
        let dirs: Vec<String> = rank_candidates(&healthy, &HashMap::new(), NOW)
            .into_iter()
            .map(|c| c.dir)
            .collect();
        assert!(dirs.contains(&"/dir/a".to_string()), "healthy A must be offered: {dirs:?}");
    }

    /// An exhaustion in the PAST is expired and must not bench the account — mirrors
    /// `effective_exhaustion`'s `e > now` filter.
    #[test]
    fn an_expired_exhaustion_does_not_bench_an_account() {
        let accounts = vec![
            acct("a", "/dir/a", Some(NOW - 1)),
            acct("b", "/dir/b", None),
        ];
        let dirs: Vec<String> = rank_candidates(&accounts, &HashMap::new(), NOW)
            .into_iter()
            .map(|c| c.dir)
            .collect();
        assert!(dirs.contains(&"/dir/a".to_string()), "expired exhaustion still benched: {dirs:?}");
    }

    /// The founder's deference rule: at exactly one healthy account, roborev stands down.
    #[test]
    fn roborev_stands_down_rather_than_taking_the_last_healthy_account() {
        let accounts = vec![
            acct("a", "/dir/a", Some(NOW + 5_000)),
            acct("b", "/dir/b", Some(NOW + 5_000)),
            acct("c", "/dir/c", None),
        ];
        assert!(
            rank_candidates(&accounts, &HashMap::new(), NOW).is_empty(),
            "must stand down at one healthy account"
        );
        // Two healthy → allowed to run. Pairs the rule so the test can't pass by always standing down.
        let accounts = vec![
            acct("a", "/dir/a", Some(NOW + 5_000)),
            acct("b", "/dir/b", None),
            acct("c", "/dir/c", None),
        ];
        assert_eq!(rank_candidates(&accounts, &HashMap::new(), NOW).len(), 2);
    }

    #[test]
    fn most_headroom_ranks_first_and_ties_are_deterministic() {
        let accounts = vec![
            acct("a", "/dir/a", None),
            acct("b", "/dir/b", None),
            acct("c", "/dir/c", None),
        ];
        let headroom = HashMap::from([
            ("a".to_string(), 0.9_f64),
            ("b".to_string(), 0.1_f64),
            ("c".to_string(), 0.5_f64),
        ]);
        let dirs: Vec<String> = rank_candidates(&accounts, &headroom, NOW)
            .into_iter()
            .map(|c| c.dir)
            .collect();
        assert_eq!(dirs, vec!["/dir/b", "/dir/c", "/dir/a"], "must rank least-consumed first");

        // Unknown usage sorts neutrally (0.5), never as the best choice on no evidence.
        let only_known = HashMap::from([("a".to_string(), 0.9_f64)]);
        let dirs: Vec<String> = rank_candidates(&accounts, &only_known, NOW)
            .into_iter()
            .map(|c| c.dir)
            .collect();
        assert_eq!(dirs, vec!["/dir/b", "/dir/c", "/dir/a"]);
    }

    #[test]
    fn headroom_normalizes_so_unknown_accounts_stay_neutral() {
        let h = headroom_from_tokens(&[("a".into(), 100), ("b".into(), 50), ("c".into(), 0)]);
        assert_eq!(h["a"], 1.0);
        assert_eq!(h["b"], 0.5);
        assert_eq!(h["c"], 0.0);
        // Raw counts would put every unknown (0.5) ahead of every known account; normalized, the
        // neutral default sits genuinely in the middle. Assert the ORDER that falls out.
        let accounts = vec![
            acct("a", "/dir/a", None), // busiest
            acct("b", "/dir/b", None), // half
            acct("d", "/dir/d", None), // unknown -> 0.5, must tie with b and lose on id
        ];
        let dirs: Vec<String> = rank_candidates(&accounts, &h, NOW).into_iter().map(|c| c.dir).collect();
        assert_eq!(dirs, vec!["/dir/b", "/dir/d", "/dir/a"]);
    }

    #[test]
    fn all_zero_tallies_do_not_divide_by_zero() {
        let h = headroom_from_tokens(&[("a".into(), 0), ("b".into(), 0)]);
        assert_eq!(h["a"], 0.0);
        assert_eq!(h["b"], 0.0);
    }

    #[test]
    fn an_empty_ranking_renders_standdown_not_an_empty_file() {
        let rendered = render_candidates(&[]);
        assert!(rendered.contains(STANDDOWN));
        assert!(!rendered.trim().is_empty());
    }

    #[test]
    fn rendering_round_trips_the_default_account_sentinel() {
        // Empty dir is a REAL value ("export nothing"), not a missing one — it must survive.
        let rendered = render_candidates(&[Candidate { dir: String::new(), exhausted_until: 0 }]);
        assert!(rendered.contains("\n0\t\n"), "default sentinel lost: {rendered:?}");
        assert!(!rendered.contains(STANDDOWN));
    }

    #[test]
    fn a_dir_containing_the_field_separator_is_skipped_not_misparsed() {
        let rendered = render_candidates(&[
            Candidate { dir: "/bad\tdir".to_string(), exhausted_until: 0 },
            Candidate { dir: "/good".to_string(), exhausted_until: 0 },
        ]);
        assert!(!rendered.contains("/bad"), "tab-bearing dir must be skipped: {rendered:?}");
        assert!(rendered.contains("/good"));
    }

    /// The retired shim's bug, pinned so it cannot come back.
    #[test]
    fn the_shim_never_injects_an_api_key() {
        let s = shim_script("/bin/claude", "/tmp/cands");
        assert!(!s.contains("ANTHROPIC_API_KEY=") , "shim must never set an API key");
        assert!(!s.contains("CLAUDE_CODE_SIMPLE=1"), "shim must never force strict key auth");
    }

    /// A leftover `@PLACEHOLDER@` would install a shim that execs a file literally named
    /// `@REAL_CLAUDE@` — every review would die with "not found". Cheap to assert, silent to miss.
    #[test]
    fn substitution_leaves_no_placeholder_behind() {
        let s = shim_script("/bin/claude", "/tmp/cands");
        assert!(!s.contains("@REAL_CLAUDE@"), "unsubstituted real-claude placeholder");
        assert!(!s.contains("@CANDIDATES@"), "unsubstituted candidates placeholder");
    }

    /// The shell suite executes the SAME template file. If it is ever renamed or removed, this fails
    /// at compile time via `include_str!` — but the token contract is asserted here so a template
    /// edit that drops a placeholder is caught by the Rust suite too, not only the shell one.
    #[test]
    fn the_shared_template_still_carries_both_substitution_tokens() {
        assert!(SHIM_TEMPLATE.contains("@REAL_CLAUDE@"));
        assert!(SHIM_TEMPLATE.contains("@CANDIDATES@"));
        assert!(SHIM_TEMPLATE.starts_with("#!/bin/sh"));
    }

    #[test]
    fn the_shim_execs_the_real_claude_by_absolute_path() {
        let s = shim_script("/abs/claude", "/tmp/cands");
        // Via PATH it would re-enter itself: the shim IS named `claude`.
        assert!(s.contains("REAL_CLAUDE='/abs/claude'"));
        assert!(s.contains(r#"exec "$REAL_CLAUDE" "$@""#));
    }

    #[test]
    fn shim_and_candidate_paths_agree_on_one_directory() {
        let home = Path::new("/Users/ada");
        assert_eq!(shim_path(home).parent().unwrap(), shim_dir(home));
        assert_eq!(candidates_path(home).parent().unwrap(), shim_dir(home));
        // Must NOT reuse the retired API-key shim's directory, which setup.rs bans by name.
        assert!(!shim_dir(home).to_string_lossy().contains(".roborev-shim"));
    }
}
