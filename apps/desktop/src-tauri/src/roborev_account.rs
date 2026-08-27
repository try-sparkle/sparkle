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
//! roborev shares the NON-default account pool with the interactive fleet but ranks **lowest
//! priority**: it picks the account with the most headroom, and if fewer than two healthy fleet
//! accounts are left it **stands down** rather than competing. Reviews degrade before the founder's
//! own work does. A stood-down job fails fast and honestly instead of burning the last account;
//! re-running it is a separate concern (see the reaper).
//!
//! The one login it NEVER touches is the interactive session's own — the DEFAULT account
//! (`$HOME/.claude`, the empty-`config_dir` sentinel). That account is what a plain interactive
//! `claude`, the founder's terminal, and this shim's fail-open path all run as, so routing a review
//! onto it is the exact shared-quota collision that starves reviews when the fleet is busy
//! (sparkle-yqr5hb / sparkle-ksftv0 / sparkle-l218hb: 11-of-11 re-enqueued reviews died on a session
//! limit within minutes). [`is_interactive_reserved`] drops it from the candidate list before
//! ranking — the enforcement of the founder's deference rule, not a reversal of the shared-pool
//! decision.
//!
//! # Split of responsibility
//!
//! Policy lives here, in Rust, where it is unit-tested. The shim is ~20 lines of POSIX `sh` that
//! does nothing but compare epochs and `exec` — deliberately dependency-free (no `jq`), so it stays
//! correct when Sparkle is closed and the candidate list is stale.

use crate::accounts::Account;
use std::collections::{HashMap, HashSet};
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

/// Is this account the interactive session's own login, which roborev must NEVER route a review
/// onto? The DEFAULT account — `is_default`, or the empty-`config_dir` sentinel that means
/// "export no `CLAUDE_CONFIG_DIR` at all" (`$HOME/.claude`) — is the exact account a plain
/// interactive `claude` runs as, that the founder's own terminal session uses, and that the shim's
/// fail-open path falls back to. Ranking it as a review candidate is the shared-quota collision the
/// review daemon exists to avoid: a busy fleet walls that login, every review routes onto it, and
/// 11-of-11 re-enqueued reviews die on a session limit within minutes (sparkle-yqr5hb /
/// sparkle-ksftv0 / sparkle-l218hb).
///
/// Reserving it is the ENFORCEMENT of the founder's 2026-08-13 rule ("reviews degrade before the
/// founder's own work does"), not a reversal of it: roborev still shares the NON-default fleet pool
/// and still ranks lowest within it — it just never competes for the one login the interactive
/// session cannot do without. The empty-dir sentinel and a literal `$HOME/.claude` are both caught,
/// because both resolve to the same interactive login (see [`crate::accounts::Account::config_dir`]).
fn is_interactive_reserved(a: &Account) -> bool {
    a.is_default || a.config_dir.is_empty()
}

/// Is this account usable right now? `exhausted_until` in the future means walled.
///
/// Mirrors `accounts::effective_exhaustion`'s `e > now` future-filter, so an expired exhaustion
/// clears on its own rather than benching an account forever.
///
/// This reads the raw `exhausted_until` field by design — this module stays pure and does no
/// filesystem/identity resolution (the shim it serves must work when Sparkle is closed). The
/// IDENTITY-AWARE correction — benching every sibling dir of a walled login, not just the dir that
/// hit the wall — is applied UPSTREAM in `accounts::republish_roborev_candidates`, which writes the
/// identity-aware epoch onto `exhausted_until` before calling [`publish_candidates`]. So a caller who
/// hands `rank_candidates` accounts straight off disk gets per-dir behaviour; the production path
/// gets identity-aware behaviour (sparkle-xsr6o). Do not reintroduce a per-dir read here on the
/// assumption the field is already identity-corrected — verify the caller corrected it.
fn is_healthy(a: &Account, now: i64) -> bool {
    !a.exhausted_until.is_some_and(|e| e > now)
}

/// Does this roborev job's output show that the account's OAuth session is DEAD — signed in, but its
/// stored token can no longer be refreshed, so every `claude` invocation under it fails at auth time?
///
/// This is the AUTH analogue of a quota wall. A quota wall is recorded as `exhausted_until` (from a
/// structured `error: "rate_limit"` transcript record) and [`is_healthy`] already routes around it.
/// An auth-expired account has NO rate-limit record and a perfectly readable keychain credential, so
/// nothing benched it — and because an unauthenticated account has consumed zero tokens it scores as
/// the account with the MOST headroom, so roborev kept picking the one account guaranteed to fail.
///
/// Kept deliberately NARROW and DISJOINT from the quota family: matching quota text here would
/// double-handle a wall the exhausted_until path already owns, and matching an arbitrary error would
/// bench the whole pool on a failure that is identical on every account (a bad flag, a crash) rather
/// than specific to this login. Only the OAuth refresh-failure / re-login signatures.
///
/// Matches by lowercasing the INPUT and testing each [`AUTH_EXPIRY_PHRASES`] entry verbatim, so those
/// phrases MUST be lowercase (enforced by `every_auth_phrase_survives_the_scan_prefilter`).
pub fn is_auth_expired(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    AUTH_EXPIRY_PHRASES.iter().any(|p| t.contains(p))
}

/// The OAuth refresh-failure phrases [`is_auth_expired`] matches, all lowercase. Exposed as a shared
/// const so the accounts.rs scan prefilter can be TESTED to cover every one: the prefilter is a
/// second correctness gate (a line it drops is never parsed), so a phrase here that carries none of
/// the prefilter's tokens would silently disable detection for that shape. The coupling test reds the
/// suite instead. If you add a phrase, keep it lowercase (the matcher can't match an uppercase entry)
/// and make sure the prefilter tokens (`oauth`/`login`/`refreshed`) still subsume it.
pub const AUTH_EXPIRY_PHRASES: &[&str] = &[
    "oauth session expired",
    "oauth token has expired",
    "oauth token expired",
    "could not be refreshed",
    "session could not be refreshed",
    "please run /login",
    "please run `claude login`",
    "please run claude login",
];

/// Is this failure text Claude Code's SUBSCRIPTION session wall — "You've hit your session limit"?
///
/// DISJOINT from [`is_auth_expired`] by construction, and the disjointness is pinned in both
/// directions by tests: an auth expiry is a DEAD login that only a human re-signing in can clear,
/// while a session wall is a LIVE login with a known reset instant that clears on its own. The two
/// call for opposite remedies, so a classifier that conflated them would rotate away from a healthy
/// account (or wait out a login that is never coming back).
///
/// WHY IT IS NOT ENOUGH TO ASK THE EXISTING QUOTA PATH: the module header above records that the
/// API-shaped quota tokens (`insufficient_quota`, `429`, a structured `rate_limit` record) never
/// match this text, so a subscription wall is invisible to every quota consumer. This is the
/// narrowest thing that makes it visible — a pure predicate over the failure text, with no policy.
///
/// Matches by lowercasing the INPUT and testing each [`SESSION_WALL_PHRASES`] entry verbatim, so
/// those phrases MUST be lowercase.
pub fn is_session_wall(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    SESSION_WALL_PHRASES.iter().any(|p| t.contains(p))
}

/// The subscription session-wall phrases [`is_session_wall`] matches, all lowercase.
///
/// Deliberately keyed on the SESSION wall only, not on every usage limit. The wording carries a
/// reset instant ("· resets 7:20am") which the phrases do NOT include, because that suffix is
/// locale- and clock-dependent and matching it would make detection fail exactly when the message
/// is most informative.
pub const SESSION_WALL_PHRASES: &[&str] = &[
    "hit your session limit",
    "session limit reached",
];

/// Did this failure come from the API being TRANSIENTLY OVERLOADED — a 529 — rather than from
/// anything about the account, the session, or the request?
///
/// This is the third member of the family, and it is the one whose remedy runs OPPOSITE to the
/// others. An auth expiry is fatal to the account; a session wall is fatal until its reset instant;
/// an overload is fatal to NOTHING. The server was busy for a moment, so the same account, the same
/// session and the same prompt are all still good — the only thing that was wrong was the timing.
///
/// It therefore has to be distinguishable, because the generic non-auth remedy is LOSSY: it retries
/// without `--resume`, on the theory that a stale resume id is the usual cause of an unexplained
/// failure. Applied to an overload that theory is simply false, and acting on it discards a healthy
/// conversation to work around a problem the conversation never had.
///
/// DISJOINT from [`is_auth_expired`] and [`is_session_wall`] by construction, and the disjointness
/// is pinned by a test — all three are matched against the same two text sources, so a phrase that
/// landed in two families would make the remedy depend on classification order.
///
/// Matches by lowercasing the INPUT and testing each [`OVERLOAD_PHRASES`] entry verbatim, so the
/// table stays greppable and case never enters the caller's problem.
pub fn is_overloaded(text: &str) -> bool {
    let t = text.to_lowercase();
    OVERLOAD_PHRASES.iter().any(|p| t.contains(p))
}

/// The transient-overload phrases [`is_overloaded`] matches, all lowercase.
///
/// `"529"` is deliberately carried WITH its surrounding words rather than bare. A bare `"529"`
/// would match any transcript that merely contains those three digits — an elapsed_ms, a token
/// count, a line number — and a false overload classification is not harmless: it would keep a
/// genuinely stale `--resume` instead of dropping it, turning this fix into the very bug it
/// replaces for some unrelated failure.
pub const OVERLOAD_PHRASES: &[&str] = &[
    "529 overloaded",
    "overloaded_error",
    "error: overloaded",
];

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
    rank_candidates_excluding_auth_dead(accounts, headroom, &HashSet::new(), now)
}

/// [`rank_candidates`], additionally dropping accounts whose config dir is in `auth_dead` — the
/// OAuth-expired accounts observed by [`is_auth_expired`] on a prior job's output.
///
/// SAFETY — the founder's last-account rule, mirrored for auth. An auth-dead account is NOT a usable
/// reserve, so excluding it composes with the [`MIN_HEALTHY_TO_RUN`] stand-down rather than
/// bypassing it: if dropping the auth-dead accounts leaves fewer than [`MIN_HEALTHY_TO_RUN`] USABLE
/// accounts, roborev stands down exactly as it would on quota — running on the one remaining login IS
/// taking the founder's last usable one. The ONE exception is fail-open: if EVERY healthy account is
/// auth-dead the detector might be wrong (a false positive would otherwise strand ALL reviews), so
/// the un-pruned ranking is kept and the shim is left to try. The exclusion EXPIRES rather than being
/// permanent: the scan only reads auth errors within `AUTH_EXPIRY_LOOKBACK`, so once the error ages
/// past that window the account is retried (and re-benched if it fails again). A shared account also
/// clears immediately if the interactive fleet completes a run under it (a newer usage-bearing turn).
/// A bare `claude login` writes NO session turn, and a roborev-only account is not exec'd while
/// excluded, so for THAT account the lookback expiry is the healing path — see
/// [`crate::accounts::republish_roborev_candidates`].
pub fn rank_candidates_excluding_auth_dead(
    accounts: &[Account],
    headroom: &HashMap<String, f64>,
    auth_dead: &HashSet<String>,
    now: i64,
) -> Vec<Candidate> {
    // Reserve the interactive/default login BEFORE anything else looks at the pool: a review must
    // never be routed onto the account the interactive session runs as, and this composes with —
    // rather than bypasses — the last-account stand-down below, which now applies to the NON-default
    // fleet pool. See [`is_interactive_reserved`].
    let mut healthy: Vec<&Account> = accounts
        .iter()
        .filter(|a| !is_interactive_reserved(a))
        .filter(|a| is_healthy(a, now))
        .collect();
    if healthy.len() < MIN_HEALTHY_TO_RUN {
        return Vec::new();
    }
    if !auth_dead.is_empty() {
        let alive: Vec<&Account> = healthy
            .iter()
            .copied()
            .filter(|a| !auth_dead.contains(&a.config_dir))
            .collect();
        if alive.is_empty() {
            // Every healthy account is auth-dead: fail open, keep the un-pruned list (the detector
            // could be wrong, and a hard stop of all reviews is the worse error).
        } else if alive.len() < MIN_HEALTHY_TO_RUN {
            // Exclusion drops us below the run threshold: stand down, same as the quota case — one
            // usable login left means using it takes the founder's last usable account.
            return Vec::new();
        } else {
            healthy = alive;
        }
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
    publish_candidates_excluding_auth_dead(home, accounts, headroom, &HashSet::new(), now)
}

/// [`publish_candidates`], additionally excluding the OAuth-expired accounts in `auth_dead` from the
/// ranking. This is the write half of the reactive auth-benching loop: an observed OAuth-expiry
/// failure (detected by [`is_auth_expired`] over an account's transcripts) lands here as an excluded
/// config dir, so the NEXT review job's shim reads a candidate list the dead login is absent from.
pub fn publish_candidates_excluding_auth_dead(
    home: &Path,
    accounts: &[Account],
    headroom: &HashMap<String, f64>,
    auth_dead: &HashSet<String>,
    now: i64,
) -> Result<(), String> {
    let ranked = rank_candidates_excluding_auth_dead(accounts, headroom, auth_dead, now);
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

    /// A default account with a non-empty, literal `$HOME/.claude`-style config dir.
    fn acct_default(id: &str, dir: &str) -> Account {
        let mut a = acct(id, dir, None);
        a.is_default = true;
        a
    }

    /// THE ISOLATION ASSERTION: the interactive/default login is NEVER offered as a review
    /// candidate, and its non-default fleet siblings ARE. This is the shared-quota collision the
    /// review daemon exists to avoid (sparkle-yqr5hb / sparkle-ksftv0 / sparkle-l218hb) — a review
    /// must not run on the account the interactive session runs as.
    ///
    /// Mutation-provable: delete the `!is_interactive_reserved` filter in the ranker and the default
    /// dir reappears in the list — i.e. the daemon FALLS BACK TO SHARING the interactive session, and
    /// this goes red. Paired with the SAME account as non-default being offered, so the exclusion is
    /// proven to be caused by the default flag, not by a ranker that would have dropped it anyway.
    #[test]
    fn the_interactive_default_account_is_never_a_review_candidate() {
        // Default account carries a literal, non-empty `$HOME/.claude` (the pre-migration shape) so
        // this cannot pass merely because the dir is empty — it must be the `is_default` flag.
        let accounts = vec![
            acct_default("home", "/home/.claude"),
            acct("a", "/dir/a", None),
            acct("b", "/dir/b", None),
        ];
        let dirs: Vec<String> = rank_candidates(&accounts, &HashMap::new(), NOW)
            .into_iter()
            .map(|c| c.dir)
            .collect();
        assert!(!dirs.contains(&"/home/.claude".to_string()), "interactive default offered: {dirs:?}");
        assert!(dirs.contains(&"/dir/a".to_string()), "fleet sibling A missing: {dirs:?}");
        assert!(dirs.contains(&"/dir/b".to_string()), "fleet sibling B missing: {dirs:?}");

        // The empty-`config_dir` sentinel is the SAME interactive login by another spelling, and is
        // likewise reserved even when it is not flagged `is_default`.
        let sentinel = vec![
            acct("home", "", None),
            acct("a", "/dir/a", None),
            acct("b", "/dir/b", None),
        ];
        let dirs: Vec<String> = rank_candidates(&sentinel, &HashMap::new(), NOW)
            .into_iter()
            .map(|c| c.dir)
            .collect();
        assert!(!dirs.iter().any(|d| d.is_empty()), "default sentinel offered: {dirs:?}");
        assert_eq!(dirs, vec!["/dir/a".to_string(), "/dir/b".to_string()], "only fleet accounts: {dirs:?}");

        // PAIRED: the SAME `/home/.claude` dir, but NON-default, IS offered — proving the drop above
        // is caused by the interactive-reservation, not by the ranker excluding that dir regardless.
        let non_default = vec![
            acct("home", "/home/.claude", None),
            acct("a", "/dir/a", None),
            acct("b", "/dir/b", None),
        ];
        let dirs: Vec<String> = rank_candidates(&non_default, &HashMap::new(), NOW)
            .into_iter()
            .map(|c| c.dir)
            .collect();
        assert!(dirs.contains(&"/home/.claude".to_string()), "non-default /home/.claude must be offered: {dirs:?}");
    }

    /// The reservation COMPOSES with the founder's last-account stand-down, applied to the NON-default
    /// fleet pool: a default account plus ONE healthy fleet account leaves only one usable review
    /// login, so roborev stands down rather than publishing it. Paired with default + TWO fleet
    /// accounts, which DOES run — so the test cannot pass by always standing down.
    #[test]
    fn reserving_the_default_composes_with_the_last_account_standdown() {
        // default + 1 fleet -> 1 usable review account -> STAND DOWN. The default is NOT counted as
        // review headroom, so this is one usable login, not two.
        let one_fleet = vec![
            acct_default("home", "/home/.claude"),
            acct("a", "/dir/a", None),
        ];
        assert!(
            rank_candidates(&one_fleet, &HashMap::new(), NOW).is_empty(),
            "default + one fleet account must stand down (the default is reserved, not a candidate)"
        );

        // default + 2 fleet -> 2 usable review accounts -> runs, on the fleet accounts only.
        let two_fleet = vec![
            acct_default("home", "/home/.claude"),
            acct("a", "/dir/a", None),
            acct("b", "/dir/b", None),
        ];
        let dirs: Vec<String> = rank_candidates(&two_fleet, &HashMap::new(), NOW)
            .into_iter()
            .map(|c| c.dir)
            .collect();
        assert_eq!(dirs, vec!["/dir/a".to_string(), "/dir/b".to_string()], "must run on the fleet pool only: {dirs:?}");
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

    // ── BUG 2: auth-expiry detection + reactive exclusion ────────────────────────────────────────

    /// THE AUTH ROTATION ASSERTION: an OAuth-expired account is not offered, and a healthy sibling
    /// is. Paired with "the same account NOT flagged is offered" so the exclusion is proven to be
    /// CAUSED by the auth-dead flag, not by a ranker that would have dropped it anyway.
    #[test]
    fn an_auth_dead_account_is_dropped_and_a_healthy_sibling_is_offered() {
        // All three quota-healthy (no exhausted_until), so the only reason A could vanish is the
        // auth-dead flag — this is the case the old ranker got wrong: A scores BEST (zero usage,
        // most headroom) yet is the dead login.
        let accounts = vec![
            acct("a", "/dir/a", None),
            acct("b", "/dir/b", None),
            acct("c", "/dir/c", None),
        ];
        let auth_dead: HashSet<String> = ["/dir/a".to_string()].into_iter().collect();
        let dirs: Vec<String> =
            rank_candidates_excluding_auth_dead(&accounts, &HashMap::new(), &auth_dead, NOW)
                .into_iter()
                .map(|c| c.dir)
                .collect();
        assert!(!dirs.contains(&"/dir/a".to_string()), "auth-dead account offered: {dirs:?}");
        assert!(dirs.contains(&"/dir/b".to_string()), "healthy sibling missing: {dirs:?}");

        // Paired: with NOTHING flagged, A IS offered. Proves the drop is caused by the flag.
        let dirs: Vec<String> =
            rank_candidates_excluding_auth_dead(&accounts, &HashMap::new(), &HashSet::new(), NOW)
                .into_iter()
                .map(|c| c.dir)
                .collect();
        assert!(dirs.contains(&"/dir/a".to_string()), "unflagged A must be offered: {dirs:?}");
    }

    /// PAIRED NEGATIVE — a QUOTA wall still benches (the auth path must not regress the quota path).
    /// The auth-dead set is empty here; A is excluded purely by its future `exhausted_until`.
    #[test]
    fn a_quota_wall_still_benches_even_with_auth_exclusion_in_play() {
        let accounts = vec![
            acct("a", "/dir/a", Some(NOW + 5_000)),
            acct("b", "/dir/b", None),
            acct("c", "/dir/c", None),
        ];
        let dirs: Vec<String> =
            rank_candidates_excluding_auth_dead(&accounts, &HashMap::new(), &HashSet::new(), NOW)
                .into_iter()
                .map(|c| c.dir)
                .collect();
        assert!(!dirs.contains(&"/dir/a".to_string()), "quota wall no longer benches: {dirs:?}");
        assert!(dirs.contains(&"/dir/b".to_string()));
    }

    /// SAFETY fail-open — when EVERY healthy account is auth-dead, exclusion would empty the list; the
    /// guard keeps the un-pruned ranking instead of hard-stopping all reviews (the detector could be
    /// wrong, and the exclusion self-heals on the next re-login/republish).
    #[test]
    fn auth_exclusion_fails_open_when_every_account_is_auth_dead() {
        let accounts = vec![
            acct("a", "/dir/a", None),
            acct("b", "/dir/b", None),
            acct("c", "/dir/c", None),
        ];
        let all_dead: HashSet<String> =
            ["/dir/a".to_string(), "/dir/b".to_string(), "/dir/c".to_string()].into_iter().collect();
        let dirs: Vec<String> =
            rank_candidates_excluding_auth_dead(&accounts, &HashMap::new(), &all_dead, NOW)
                .into_iter()
                .map(|c| c.dir)
                .collect();
        assert_eq!(dirs.len(), 3, "must not strand roborev when all are auth-dead: {dirs:?}");
    }

    /// THE STAND-DOWN COMPOSITION (reviewer's case): with TWO quota-healthy accounts, one auth-dead,
    /// only ONE login is usable — so roborev must STAND DOWN, not publish a one-candidate list that
    /// takes the founder's last usable account. Paired with a 3-account case where a real alternative
    /// remains, which DOES publish the survivors — so the test can't pass by always standing down.
    #[test]
    fn auth_exclusion_stands_down_when_it_leaves_only_one_usable_login() {
        // 2 quota-healthy, 1 auth-dead -> 1 usable -> STAND DOWN.
        let two = vec![acct("a", "/dir/a", None), acct("b", "/dir/b", None)];
        let a_dead: HashSet<String> = ["/dir/a".to_string()].into_iter().collect();
        assert!(
            rank_candidates_excluding_auth_dead(&two, &HashMap::new(), &a_dead, NOW).is_empty(),
            "one usable login left must stand down, not publish a single candidate"
        );

        // 3 quota-healthy, 1 auth-dead -> 2 usable -> publish the two survivors.
        let three = vec![
            acct("a", "/dir/a", None),
            acct("b", "/dir/b", None),
            acct("c", "/dir/c", None),
        ];
        let dirs: Vec<String> =
            rank_candidates_excluding_auth_dead(&three, &HashMap::new(), &a_dead, NOW)
                .into_iter()
                .map(|c| c.dir)
                .collect();
        assert_eq!(dirs, vec!["/dir/b".to_string(), "/dir/c".to_string()], "survivors must publish: {dirs:?}");
    }

    /// The stand-down rule is unchanged by auth exclusion: at one quota-healthy account roborev still
    /// stands down BEFORE the auth filter can even run.
    #[test]
    fn auth_exclusion_does_not_bypass_the_standdown_guard() {
        let accounts = vec![
            acct("a", "/dir/a", Some(NOW + 5_000)),
            acct("b", "/dir/b", None),
        ];
        let dead: HashSet<String> = ["/dir/c".to_string()].into_iter().collect();
        assert!(
            rank_candidates_excluding_auth_dead(&accounts, &HashMap::new(), &dead, NOW).is_empty(),
            "must still stand down at one healthy account"
        );
    }

    /// The detector fires on the OAuth refresh-failure family and NOTHING else — the paired negatives
    /// are the point: a quota wall (owned by the exhausted_until path) and an ordinary error (a bad
    /// flag, a crash — identical on every account) must NOT be read as auth-death, or the whole pool
    /// would be benched on a failure re-login cannot fix.
    #[test]
    fn is_auth_expired_matches_only_the_oauth_refresh_family() {
        assert!(is_auth_expired("Error: OAuth session expired · please run /login"));
        assert!(is_auth_expired("Your OAuth token has expired and could not be refreshed"));
        assert!(is_auth_expired("credential could not be refreshed"));
        assert!(is_auth_expired("Please run `claude login` to continue")); // backtick form
        // Case-insensitive.
        assert!(is_auth_expired("OAUTH SESSION EXPIRED"));

        // Paired negatives — the quota family and generic errors are NOT auth-death.
        assert!(!is_auth_expired("You've hit your session limit · resets 2am"));
        assert!(!is_auth_expired("Credit balance is too low"));
        assert!(!is_auth_expired("error: unknown flag --nope"));
        assert!(!is_auth_expired("Connection reset by peer"));
        assert!(!is_auth_expired(""));
    }

    /// The subscription session wall — the text the module header records as matching NO existing
    /// quota classifier, which is why it "never fired once in 63,000+ jobs".
    #[test]
    fn is_overloaded_matches_the_transient_529_family_and_stays_disjoint() {
        // The measured line, verbatim in shape.
        assert!(is_overloaded(
            "API Error: 529 Overloaded. This is a server-side issue, usually temporary"
        ));
        assert!(is_overloaded("{\"type\":\"overloaded_error\"}"));
        assert!(is_overloaded("Error: Overloaded"));
        assert!(is_overloaded("api error: 529 OVERLOADED")); // case-insensitive

        // DISJOINTNESS — the load-bearing half. All three classifiers read the same two text
        // sources, so a phrase landing in two families would make the remedy depend on the order
        // they happen to be checked in.
        assert!(!is_overloaded("OAuth session expired and could not be refreshed"));
        assert!(!is_overloaded("You've hit your session limit · resets 2am"));
        assert!(!is_auth_expired("API Error: 529 Overloaded"));
        assert!(!is_session_wall("API Error: 529 Overloaded"));

        // A BARE 529 must not match: those three digits appear in elapsed_ms, token counts and line
        // numbers, and a false overload keeps a genuinely stale --resume instead of dropping it.
        assert!(!is_overloaded("elapsed_ms=529"));
        assert!(!is_overloaded("transcript line 529: unexpected token"));
        assert!(!is_overloaded("error: unknown flag --nope"));
        assert!(!is_overloaded(""));
    }

    #[test]
    fn is_session_wall_matches_the_subscription_wall_and_nothing_else() {
        assert!(is_session_wall("You've hit your session limit · resets 2am"));
        assert!(is_session_wall("You've hit your session limit · resets 7:20am (America/Los_Angeles)"));
        assert!(is_session_wall("session limit reached, resets 4pm"));
        // Case-insensitive, like every classifier in this module.
        assert!(is_session_wall("YOU'VE HIT YOUR SESSION LIMIT"));

        // Paired negatives. Auth death is the one that MUST stay disjoint: it is the other classifier
        // reading these same two sources, and their remedies are opposites.
        assert!(!is_session_wall("OAuth session expired and could not be refreshed"));
        assert!(!is_session_wall("please run /login"));
        assert!(!is_session_wall("Credit balance is too low"));
        assert!(!is_session_wall("error: unknown flag --nope"));
        assert!(!is_session_wall(""));
    }

    /// Every phrase must be lowercase or the matcher — which lowercases only the INPUT — can never
    /// match it. Same invariant `AUTH_EXPIRY_PHRASES` carries, asserted the same way.
    #[test]
    fn every_session_wall_phrase_is_lowercase() {
        for p in SESSION_WALL_PHRASES {
            assert_eq!(*p, p.to_ascii_lowercase(), "phrase must be lowercase: {p:?}");
        }
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
