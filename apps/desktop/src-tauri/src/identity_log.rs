//! The identity-epoch ledger: WHEN each Anthropic `accountUuid` was observed behind each Claude
//! config directory.
//!
//! ## Why this exists
//!
//! Learned rate-limit ceilings (`accounts::ceiling_for_account`) are measured from the transcripts
//! under a config dir. Those transcripts carry **no account marker** — sampled `.jsonl` records
//! expose only `sessionId`/`type`/`leafUuid`/`mode`, and grepping one for `accountUuid`/`userId`
//! returns nothing. So once a user signs a *different* Anthropic account into the same directory,
//! the history commingles and **cannot be re-partitioned after the fact**. On the machine that
//! motivated this, `~/.claude/projects` held 3,656 project dirs accumulated across every identity
//! that directory has ever hosted.
//!
//! The one signal that IS recoverable is temporal: if we write down which uuid we saw behind a dir
//! and when, a later read can tell that the identity changed at time `T` and refuse to learn from
//! anything older. That is all this ledger does. It is not a usage store and it is not
//! authoritative about anything — the `.claude.json` files are. It only remembers *when*.
//!
//! ## Shape
//!
//! `<app_data>/account-identity-log.json` — a map from the account's `config_dir` **verbatim** (so
//! the empty string, the default account's "export no `CLAUDE_CONFIG_DIR`" sentinel, is a real key;
//! see `accounts::Account::config_dir`) to an ordered list of epochs, oldest first:
//!
//! ```json
//! { "": [ { "accountUuid": "c70bea4e-…", "firstSeenAt": 1785800000, "lastSeenAt": 1785886200 } ] }
//! ```
//!
//! Times are epoch **seconds**, matching every other epoch in `accounts.rs`.
//!
//! ## Never fatal
//!
//! Identity DISPLAY must not depend on this file. A missing, unreadable, or corrupt ledger reads as
//! an empty map, and a failed write is swallowed by the caller — the worst case is that a takeover
//! boundary is forgotten and a ceiling is learned across it, which is the pre-ledger behaviour.
//! Erroring instead would mean a corrupt cache file could blank the account list.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// One continuous stretch during which a single `accountUuid` was observed behind a config dir.
///
/// A stretch is opened by an observation whose uuid differs from the previous one and closed only
/// by the next such observation, so `last_seen_at` is "the newest moment we confirmed this uuid",
/// not "the moment it stopped".
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IdentityEpoch {
    pub account_uuid: String,
    pub first_seen_at: i64,
    pub last_seen_at: i64,
}

/// config dir → its epochs, oldest first. `BTreeMap` for a deterministic on-disk key order (so a
/// no-op rewrite is byte-identical and diffs stay readable).
pub type IdentityLog = BTreeMap<String, Vec<IdentityEpoch>>;

/// Cap on epochs retained per directory, oldest dropped first.
///
/// A directory whose identity genuinely alternates (two accounts sharing one dir) would otherwise
/// append forever. 64 covers far more churn than the 30-day ceiling window can use, and the entries
/// that matter for a boundary are always the newest ones.
const MAX_EPOCHS_PER_DIR: usize = 64;

/// How stale `last_seen_at` must be before a same-uuid observation is worth a disk write.
///
/// The identity read runs on a UI poll, so persisting every bump would rewrite this file every few
/// seconds forever to move one integer. A *new* epoch always persists immediately — that is the
/// event the ceiling reset depends on; only the heartbeat is debounced.
const BUMP_WRITE_INTERVAL: i64 = 5 * 60;

/// How far AHEAD of `now` a recorded `last_seen_at` may sit and still be believed.
///
/// The forward clamp below must be BOUNDED or it turns a one-off forward clock excursion into a
/// permanent ceiling loss. Nothing can stop a bad value being written in the first place — a machine
/// booting with a dead RTC or restored from a stale VM snapshot genuinely reports that time, and
/// `now` is all we have — so the recovery has to live on the read side. Without a bound, one boot
/// reading 2030 stamps every later epoch for that directory at 2030 forever: `takeover_at` returns
/// a far-future boundary, `episode_floor` discards every episode, and the account is pinned to
/// `ceiling: None` with no self-healing path short of deleting this file.
///
/// A day is far beyond any real NTP correction (seconds to minutes) and far short of the year-scale
/// jumps a broken clock produces, so it separates the two cleanly. Past it we treat the stored value
/// as poisoned and fall back to `now` — which can leave one out-of-order pair, a cost worth paying
/// since `takeover_at`'s `rposition`/`idx == 0` and the drop-oldest cap are both POSITIONAL and
/// degrade gracefully, whereas the alternative degrades permanently.
const MAX_FUTURE_SKEW: i64 = 24 * 60 * 60;

/// `<app_data>/account-identity-log.json`.
pub fn identity_log_path(app_data: &Path) -> PathBuf {
    app_data.join("account-identity-log.json")
}

/// Process-wide lock serializing this file's read-modify-write, mirroring `accounts::AccountsLock`.
///
/// A `static` rather than Tauri-managed state on purpose: every caller does its work inside
/// `tauri::async_runtime::spawn_blocking`, whose closure must be `Send + 'static`, and a
/// `MutexGuard` borrowed from managed state is neither. The lock therefore has to be reachable from
/// inside the blocking closure, which is what a static gives us. It guards a different file than
/// `accounts.json`, so it needs no ordering relationship with `AccountsLock`.
fn log_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

/// Acquire the ledger lock, recovering from poisoning (a panicking prior holder must not
/// permanently disable identity recording).
fn guard() -> std::sync::MutexGuard<'static, ()> {
    log_lock().lock().unwrap_or_else(|e| e.into_inner())
}

/// Read the ledger. Absent, unreadable, or unparseable all yield an EMPTY map — see the module
/// header: nothing user-facing may fail because this file is damaged.
pub fn read_log_at(path: &Path) -> IdentityLog {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Write the ledger atomically: serialize to a sibling temp in the SAME directory, then `rename`
/// over the target. Identical to `accounts::write_accounts_at` and for the same reason — a crash or
/// full disk mid-write must leave the previous valid file, never a truncated one, because a
/// truncated file loses every takeover boundary we have recorded.
pub fn write_log_at(path: &Path, log: &IdentityLog) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir app data dir: {e}"))?;
    }
    let json = serde_json::to_vec_pretty(log).map_err(|e| format!("serialize identity log: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &json).map_err(|e| format!("write identity log tmp: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp); // best-effort cleanup of the orphan temp
        format!("rename identity log into place: {e}")
    })
}

/// Fold one observation into `log` in memory. Returns whether the result is worth persisting.
///
/// * same uuid as the newest epoch → bump `last_seen_at`; worth a write only once it has drifted by
///   [`BUMP_WRITE_INTERVAL`].
/// * different uuid (or no epochs yet) → open a new epoch; ALWAYS worth a write.
///
/// **The list stays monotonic under a backward clock**, and the two branches handle that
/// differently on purpose. `now` comes from the wall clock on a UI poll, so an NTP correction, an
/// unset RTC at boot, or a user changing the date can hand us a time earlier than what is already
/// recorded.
///
/// The handling is in two stages, and the FIRST runs before either branch:
///
/// 1. [`repair_implausible_future_tail`] clamps every trailing epoch sitting more than
///    [`MAX_FUTURE_SKEW`] ahead of `now` back down. It runs unconditionally, on every observation,
///    because poison can land on the CURRENT epoch — a uuid change observed during a dead-RTC boot
///    stamps a far-future boundary, and a repair that only fired on the NEXT takeover would never
///    reach it: the same-uuid branch below returns early on `now <= last_seen_at`, so nothing would
///    ever revise it and the account would be pinned to `ceiling: None` forever. Running it up front
///    means the first sane poll after the clock is corrected heals the directory. It walks the whole
///    trailing RUN, not just the last entry, so ordering holds at any depth.
/// 2. Then, with nothing left implausibly ahead:
///    * Same uuid, `now` not newer: ignore it. There is nothing to learn from a rewind, and
///      rewinding `last_seen_at` would only lose the heartbeat. (A repair in stage 1 still persists.)
///    * Same uuid, `now` newer: bump `last_seen_at`.
///    * Different uuid: never dropped — dropping would discard the takeover boundary entirely, and a
///      takeover that goes unrecorded is the failure this module exists to prevent, since the ceiling
///      is then learned straight across it. The new epoch is CLAMPED forward to the predecessor's
///      `last_seen_at` when that is still ahead (ordinary skew, now bounded by stage 1). Clamping
///      forward only ever discards more pre-boundary history, which is the safe direction.
///
/// Ordering is not cosmetic: `takeover_at`'s `rposition`/`idx == 0` logic and the drop-oldest cap
/// both assume oldest-first, and a skewed-early boundary gets filtered out by the caller's 30-day
/// window, silently restoring the pre-ledger behaviour.
///
/// **Residual, stated rather than papered over:** if `now` itself is the bad value and the clock is
/// later corrected, the recorded boundary sits earlier than the truth, and a large enough error puts
/// it outside the caller's learn window — where it is indistinguishable from a takeover that really
/// did happen months ago. That is accepted because the alternative (an unbounded clamp) converts the
/// same one-off event into a PERMANENT loss, and because the read side cannot tell the two apart:
/// a boundary outside the window legitimately means "the whole window belongs to the current
/// identity", which is the common case and must keep learning normally.
/// Clamp every epoch at the TAIL whose `last_seen_at` sits more than [`MAX_FUTURE_SKEW`] ahead of
/// `now` back down to `now`. Returns whether anything changed (i.e. whether a write is owed).
///
/// Walks the trailing RUN rather than only the last entry: a bad clock can stamp several
/// observations before it is corrected, and repairing one of them would leave the list out of
/// oldest-first order, which is the invariant `takeover_at` and the drop-oldest cap both rest on.
/// It stops at the first entry that is not implausibly ahead, so ordinary history is never touched.
///
/// In the backward-`now` reading of the ambiguity this pulls down a boundary that was recorded
/// correctly. That is the deliberate cost of having no way to tell the two apart: an ordered list
/// with a possibly-early boundary keeps working, whereas an unordered one — or a far-future one —
/// breaks the read side permanently.
fn repair_implausible_future_tail(entries: &mut [IdentityEpoch], now: i64) -> bool {
    let mut repaired = false;
    for e in entries.iter_mut().rev() {
        if e.last_seen_at.saturating_sub(now) <= MAX_FUTURE_SKEW {
            break;
        }
        e.last_seen_at = now;
        e.first_seen_at = e.first_seen_at.min(now);
        repaired = true;
    }
    repaired
}
///
/// ## A LADDER CLIMB IS NOT A TAKEOVER
///
/// `key` is `accounts::identity_key`: the `accountUuid` when the login records one, else
/// `email:<addr>`. That ladder is **not stable over time for one account** — a login predating the
/// `accountUuid` field reports the email form, and the moment Claude Code refreshes that profile
/// and the field appears, the key changes for the *same person, same account, no fork*.
///
/// Treating that as a new epoch would be the exact "invent a fork between what may be one account"
/// failure `accounts::identities_differ` exists to prevent, just displaced from the comparison path
/// (across sides) to the ledger path (across time). It is not cosmetic: `takeover_at` would return
/// `now`, `episode_floor` would discard every episode, the ceiling would go `Some(_) → None`, and
/// the near-cap banner would stay dead until weeks of fresh limit episodes accumulate or the
/// boundary ages out of the 30-day window.
///
/// So `email_key` (always the `email:<addr>` form of the SAME identity) is passed alongside, and a
/// stored epoch keyed by that email form is **rewritten in place** when the uuid appears.
///
/// The reverse — a uuid epoch followed by an email-form observation — stays a takeover. It means
/// `accountUuid` vanished from an existing login, which Claude Code does not do; the stored epoch
/// carries no email to match against, and guessing "same account" from a directory alone is the
/// unsafe direction. A spurious cut only under-fires the banner, which is the failure §5 chose.
pub fn apply_observation(
    log: &mut IdentityLog,
    config_dir: &str,
    account_uuid: &str,
    email_key: &str,
    now: i64,
) -> bool {
    let entries = log.entry(config_dir.to_string()).or_default();
    // STAGE 1 — before anything else, and on every observation. See the doc above for why this
    // cannot be deferred to the next takeover.
    let repaired = repair_implausible_future_tail(entries, now);
    // STAGE 1.5 — the ladder climb, checked BEFORE the takeover branch: this login already has an
    // epoch, filed under its email because it had no uuid to file under then. Same account, so
    // continue it rather than opening a new one. Runs AFTER the repair so a poisoned `last_seen_at`
    // cannot make the rewritten epoch tower over whatever follows.
    if account_uuid != email_key {
        if let Some(last) = entries.last_mut() {
            if last.account_uuid == email_key {
                last.account_uuid = account_uuid.to_string();
                if now > last.last_seen_at {
                    last.last_seen_at = now;
                }
                return true;
            }
        }
    }
    match entries.last_mut() {
        Some(last) if last.account_uuid == account_uuid => {
            if now <= last.last_seen_at {
                // Nothing to bump — but a stage-1 repair still has to reach disk, or the poison
                // survives every future poll.
                return repaired;
            }
            let worth_persisting = now - last.last_seen_at >= BUMP_WRITE_INTERVAL;
            last.last_seen_at = now;
            worth_persisting || repaired
        }
        _ => {
            // Clamped forward when the predecessor is still ahead. After stage 1 that gap is at
            // most MAX_FUTURE_SKEW — ordinary skew — so this can no longer inherit a poisoned
            // timestamp. Never a bare `now` next to a larger predecessor: that is the out-of-order
            // write the ordering invariant exists to prevent.
            let at = entries.last().map_or(now, |last| now.max(last.last_seen_at));
            entries.push(IdentityEpoch {
                account_uuid: account_uuid.to_string(),
                first_seen_at: at,
                last_seen_at: at,
            });
            if entries.len() > MAX_EPOCHS_PER_DIR {
                entries.drain(0..entries.len() - MAX_EPOCHS_PER_DIR);
            }
            true
        }
    }
}

/// Forget everything recorded for one config dir. Returns whether anything was removed.
///
/// The ledger is append-only per directory, so without this a REMOVED account leaves its absolute
/// config-dir path and every identity that ever held it — emails and account uuids — sitting in
/// `<app_data>/account-identity-log.json` forever, long after the account row and its directory are
/// gone (knightwatch probe 3). Production only ever reads the CURRENT identity's latest takeover
/// boundary, so nothing needs that history once the account is unregistered; keeping it is
/// retention with no purpose and no boundary.
///
/// Best-effort like every other write here: a failure is swallowed, because failing an account
/// removal because a cache file could not be rewritten would be the worse outcome.
pub fn forget_config_dir_at(path: &Path, config_dir: &str) {
    let _g = guard();
    let mut log = read_log_at(path);
    if log.remove(config_dir).is_none() {
        return; // nothing recorded for it — no write, so no needless churn
    }
    if let Err(e) = write_log_at(path, &log) {
        eprintln!("[identity_log] prune failed (account removal unaffected): {e}");
    }
}

/// Record a batch of `(config_dir, account uuid)` observations and return the UPDATED ledger.
///
/// One read-modify-write for the whole account set (the identity read resolves them all together),
/// under [`log_lock`]. Accounts whose uuid is `None` — no `.claude.json`, an older login predating
/// the field — contribute nothing: an unattributable read must not be recorded as a takeover, which
/// would reset a ceiling for no reason.
///
/// **Never fails.** A write error is swallowed and the in-memory map is returned anyway, so the
/// caller's identity display is unaffected; the only loss is that this observation is not durable.
pub fn record_observations(
    path: &Path,
    observations: &[(String, Option<(String, String)>)],
    now: i64,
) -> IdentityLog {
    let _g = guard();
    let mut log = read_log_at(path);
    let mut dirty = false;
    for (config_dir, observed) in observations {
        // `(identity key, email form of the same identity)` — the second is what lets a login whose
        // `accountUuid` only just appeared continue its existing epoch instead of opening a new one.
        // See [`apply_observation`]'s "A LADDER CLIMB IS NOT A TAKEOVER".
        if let Some((key, email_key)) = observed {
            dirty |= apply_observation(&mut log, config_dir, key, email_key, now);
        }
    }
    if dirty {
        if let Err(e) = write_log_at(path, &log) {
            // Deliberately not propagated: identity display must not depend on this file.
            eprintln!("[identity_log] write failed (identity display unaffected): {e}");
        }
    }
    log
}

/// When `account_uuid` TOOK OVER `config_dir`, i.e. the start of its current epoch — but only when a
/// *different* identity was recorded there before it.
///
/// `None` when the dir is unknown, when the uuid has never been seen there, or when its epoch is the
/// FIRST one on record. That last case is the important one: the ledger only starts accumulating the
/// moment this code ships, so the first observation of a directory is not evidence that anything
/// changed. Treating it as a takeover would blank every learned ceiling on upgrade.
pub fn takeover_at(log: &IdentityLog, config_dir: &str, account_uuid: &str) -> Option<i64> {
    let entries = log.get(config_dir)?;
    let idx = entries.iter().rposition(|e| e.account_uuid == account_uuid)?;
    if idx == 0 {
        return None;
    }
    Some(entries[idx].first_seen_at)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 4-arg shim for the tests written BEFORE the ladder existed. Each uuid gets its own distinct
    /// email form, so none of them can imply a ladder climb and every one keeps asserting exactly
    /// what it asserted before. Tests that exercise the climb call `apply_observation` directly.
    fn observe(log: &mut IdentityLog, dir: &str, uuid: &str, now: i64) -> bool {
        apply_observation(log, dir, uuid, &format!("email:{uuid}@test.invalid"), now)
    }

    #[test]
    fn forgetting_a_config_dir_removes_its_identity_history_and_leaves_the_rest() {
        // knightwatch probe 3: a removed account used to leave its absolute path and every
        // email/uuid that ever held it in this file forever, with nothing that reads them.
        let dir = std::env::temp_dir().join(format!("idlog-forget-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("account-identity-log.json");
        let _ = std::fs::remove_file(&path);

        let mut log = IdentityLog::new();
        observe(&mut log, "/gone", "uuid-gone", 1_000);
        observe(&mut log, "/kept", "uuid-kept", 1_000);
        write_log_at(&path, &log).unwrap();

        forget_config_dir_at(&path, "/gone");

        let after = read_log_at(&path);
        assert!(!after.contains_key("/gone"), "the removed dir's history is gone");
        assert!(after.contains_key("/kept"), "and every other dir is untouched");
        // The identity itself must not survive anywhere in the file.
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("uuid-gone"), "no residue of the removed account's identity");
        assert!(raw.contains("uuid-kept"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_login_gaining_an_account_uuid_continues_its_epoch_instead_of_faking_a_takeover() {
        // THE LADDER CLIMB. A login predating the `accountUuid` field is filed under `email:<addr>`.
        // When Claude Code later refreshes that profile and the field appears, `identity_key`
        // changes for the SAME person, SAME account, no fork. Opening a new epoch there would make
        // `takeover_at` return `now`, `episode_floor` discard every episode, and the ceiling go
        // `Some(_) -> None` — the "invent a fork between what may be one account" failure, moved
        // from the comparison path onto the ledger path.
        let mut log = IdentityLog::new();
        let email = "email:old@example.com";

        // Seen first with no uuid at all: filed under the email form.
        assert!(apply_observation(&mut log, "/d", email, email, 1_000));
        assert_eq!(log["/d"].len(), 1);

        // Now the same login reports a uuid it never reported before.
        assert!(apply_observation(&mut log, "/d", "uuid-new", email, 9_000));

        assert_eq!(log["/d"].len(), 1, "a ladder climb is a CONTINUATION, not a second epoch");
        assert_eq!(log["/d"][0].account_uuid, "uuid-new", "the epoch is rekeyed in place");
        assert_eq!(log["/d"][0].first_seen_at, 1_000, "and keeps its original start");
        assert_eq!(log["/d"][0].last_seen_at, 9_000);
        assert_eq!(
            takeover_at(&log, "/d", "uuid-new"),
            None,
            "so no takeover is reported and no ceiling is cut"
        );
    }

    #[test]
    fn a_genuinely_different_login_after_an_email_keyed_one_is_still_a_takeover() {
        // The guard above must stay NARROW: it may only continue an epoch when the incoming
        // identity is the same one, matched by its email form. A different account signing into the
        // same dir is a real takeover and must still cut.
        let mut log = IdentityLog::new();
        assert!(apply_observation(&mut log, "/d", "email:old@example.com", "email:old@example.com", 1_000));
        assert!(apply_observation(&mut log, "/d", "uuid-other", "email:someone-else@example.com", 9_000));

        assert_eq!(log["/d"].len(), 2, "a different login opens a new epoch");
        assert_eq!(takeover_at(&log, "/d", "uuid-other"), Some(9_000));
    }

    fn unique_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sparkle-idlog-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn same_uuid_bumps_last_seen_without_opening_a_second_epoch() {
        let mut log = IdentityLog::new();
        assert!(observe(&mut log, "/d", "uuid-a", 1_000), "first sighting persists");
        // Same identity, later: ONE epoch, its tail moved. A second epoch here would fabricate a
        // takeover boundary and blank the account's ceiling for no reason.
        observe(&mut log, "/d", "uuid-a", 1_000 + BUMP_WRITE_INTERVAL);
        assert_eq!(log["/d"].len(), 1);
        assert_eq!(log["/d"][0].first_seen_at, 1_000);
        assert_eq!(log["/d"][0].last_seen_at, 1_000 + BUMP_WRITE_INTERVAL);

        // A DIFFERENT uuid opens a second epoch and leaves the first one's window intact.
        assert!(observe(&mut log, "/d", "uuid-b", 9_000));
        assert_eq!(log["/d"].len(), 2);
        assert_eq!(log["/d"][0].last_seen_at, 1_000 + BUMP_WRITE_INTERVAL);
        assert_eq!(log["/d"][1].account_uuid, "uuid-b");
        assert_eq!(log["/d"][1].first_seen_at, 9_000);
    }

    #[test]
    fn a_same_uuid_heartbeat_is_debounced_but_a_new_epoch_never_is() {
        let mut log = IdentityLog::new();
        observe(&mut log, "/d", "uuid-a", 1_000);
        // A poll a few seconds later still updates memory but is NOT worth a disk write — this file
        // is read on a UI poll, so persisting every heartbeat rewrites it forever to move one int.
        assert!(!observe(&mut log, "/d", "uuid-a", 1_010));
        assert_eq!(log["/d"][0].last_seen_at, 1_010);
        // Past the debounce it is. The drift is measured against the epoch as it currently stands,
        // so in this in-memory chain that is 1_010; through `record_observations`, which re-reads
        // the file each call, it is whatever last reached disk.
        assert!(observe(&mut log, "/d", "uuid-a", 1_010 + BUMP_WRITE_INTERVAL));
        // An identity CHANGE is never debounced: the ceiling reset depends on this being durable.
        assert!(observe(&mut log, "/d", "uuid-b", 1_010 + BUMP_WRITE_INTERVAL + 1));
    }

    #[test]
    fn an_out_of_order_observation_never_rewinds_last_seen() {
        let mut log = IdentityLog::new();
        observe(&mut log, "/d", "uuid-a", 5_000);
        assert!(!observe(&mut log, "/d", "uuid-a", 4_000));
        assert_eq!(log["/d"][0].last_seen_at, 5_000, "clock skew must not rewind the epoch");
        assert_eq!(log["/d"].len(), 1);
    }

    #[test]
    fn a_backward_clock_still_records_a_takeover_and_keeps_the_list_ordered() {
        // A takeover observed with a BACKWARD `now` (NTP correction, unset RTC at boot, a user
        // changing the date). Dropping it would lose the boundary entirely and the ceiling would be
        // learned straight across it; recording it out of order would break the oldest-first
        // ordering that `takeover_at`'s `idx == 0` test and the drop-oldest cap both assume, and the
        // skewed-early boundary would then be filtered out by the caller's 30-day window — the same
        // silent failure by another route. So it is CLAMPED forward instead.
        let mut log = IdentityLog::new();
        observe(&mut log, "/d", "uuid-a", 5_000);
        assert!(observe(&mut log, "/d", "uuid-b", 1_000), "the takeover is still recorded");
        assert_eq!(log["/d"].len(), 2);
        assert_eq!(log["/d"][1].first_seen_at, 5_000, "clamped forward, not written as 1_000");
        assert_eq!(log["/d"][1].last_seen_at, 5_000);
        assert!(
            log["/d"][1].first_seen_at >= log["/d"][0].last_seen_at,
            "the list must stay oldest-first"
        );
        // And the boundary the ceiling reset keys on is the clamped time, not the skewed one.
        assert_eq!(takeover_at(&log, "/d", "uuid-b"), Some(5_000));
        // A later, sane observation of the new identity still bumps normally.
        observe(&mut log, "/d", "uuid-b", 5_000 + BUMP_WRITE_INTERVAL);
        assert_eq!(log["/d"].len(), 2);
        assert_eq!(log["/d"][1].last_seen_at, 5_000 + BUMP_WRITE_INTERVAL);
    }

    #[test]
    fn the_default_accounts_empty_config_dir_is_a_real_key() {
        // The default account stores "" meaning "export no CLAUDE_CONFIG_DIR" — a value, not a
        // missing one. It must get its own epoch list, distinct from any real path.
        let mut log = IdentityLog::new();
        observe(&mut log, "", "uuid-home", 1_000);
        observe(&mut log, "/data/accounts/x", "uuid-named", 1_000);
        assert_eq!(log[""][0].account_uuid, "uuid-home");
        assert_eq!(log["/data/accounts/x"][0].account_uuid, "uuid-named");
        // And it survives a JSON round trip as the empty key.
        let json = serde_json::to_string(&log).unwrap();
        assert!(json.contains(r#""":["#), "empty-string key must serialize: {json}");
        let back: IdentityLog = serde_json::from_str(&json).unwrap();
        assert_eq!(back, log);
    }

    #[test]
    fn takeover_is_none_for_a_first_sighting_and_some_after_a_change() {
        let mut log = IdentityLog::new();
        observe(&mut log, "/d", "uuid-a", 1_000);
        // First epoch on record → NOT a takeover. The ledger starts empty on upgrade, so treating
        // this as one would blank every learned ceiling the first time the app runs.
        assert_eq!(takeover_at(&log, "/d", "uuid-a"), None);
        assert_eq!(takeover_at(&log, "/d", "uuid-unknown"), None);
        assert_eq!(takeover_at(&log, "/nowhere", "uuid-a"), None);

        observe(&mut log, "/d", "uuid-b", 9_000);
        assert_eq!(takeover_at(&log, "/d", "uuid-b"), Some(9_000));
        // The displaced identity's epoch is still first, so it still reports no takeover.
        assert_eq!(takeover_at(&log, "/d", "uuid-a"), None);

        // A → B → A: the boundary is the LATEST time A took over, not its original arrival.
        observe(&mut log, "/d", "uuid-a", 20_000);
        assert_eq!(takeover_at(&log, "/d", "uuid-a"), Some(20_000));
    }

    #[test]
    fn a_poisoned_far_future_timestamp_does_not_propagate_forever() {
        // The forward clamp must be BOUNDED. A machine that boots once with a dead RTC (or is
        // restored from a stale VM snapshot) genuinely reports a future time, and the same-uuid
        // branch records it — nothing can prevent that, since `now` is all we have. What must not
        // happen is that value stamping every LATER epoch for the directory: an unbounded clamp
        // pins the account to `ceiling: None` forever, because `episode_floor = t + WINDOW_5H`
        // discards every episode against a far-future boundary.
        let sane = 1_700_000_000;
        let poisoned = sane + 10 * 365 * 24 * 60 * 60; // ~2030 on a 2023 clock
        let mut log = IdentityLog::new();
        observe(&mut log, "/d", "uuid-a", sane);
        observe(&mut log, "/d", "uuid-a", poisoned);
        assert_eq!(log["/d"][0].last_seen_at, poisoned, "the bad clock's value did get recorded");

        // The clock recovers, and a real takeover happens. The boundary must be NOW, not 2030 —
        // AND the list must still be oldest-first, which means the poisoned predecessor is repaired
        // DOWN rather than left towering over the epoch that follows it.
        observe(&mut log, "/d", "uuid-b", sane + 60);
        assert_eq!(
            log["/d"][1].first_seen_at,
            sane + 60,
            "beyond MAX_FUTURE_SKEW the stored value is poisoned, not authoritative"
        );
        assert_eq!(takeover_at(&log, "/d", "uuid-b"), Some(sane + 60));
        assert_eq!(log["/d"][0].last_seen_at, sane + 60, "the poison is repaired, not just ignored");
        assert!(
            log["/d"][0].last_seen_at <= log["/d"][1].first_seen_at,
            "bounding the clamp must not cost the ordering the clamp existed to keep"
        );
        assert!(log["/d"][0].first_seen_at <= log["/d"][0].last_seen_at);

        // A clamp INSIDE the tolerance still applies — ordinary skew is not treated as poison.
        let mut log = IdentityLog::new();
        observe(&mut log, "/d", "uuid-a", sane);
        observe(&mut log, "/d", "uuid-a", sane + MAX_FUTURE_SKEW - 60);
        observe(&mut log, "/d", "uuid-b", sane);
        assert_eq!(
            log["/d"][1].first_seen_at,
            sane + MAX_FUTURE_SKEW - 60,
            "a plausible skew is still clamped forward"
        );
    }

    /// Assert the whole list is oldest-first and internally consistent.
    fn assert_ordered(entries: &[IdentityEpoch]) {
        for e in entries {
            assert!(e.first_seen_at <= e.last_seen_at, "epoch inverted: {e:?}");
        }
        for pair in entries.windows(2) {
            assert!(
                pair[0].last_seen_at <= pair[1].first_seen_at,
                "list must stay oldest-first: {pair:?}"
            );
        }
    }

    #[test]
    fn a_poisoned_boundary_on_the_current_epoch_self_heals_on_the_next_sane_poll() {
        // The harmful shape: a real uuid change observed DURING a dead-RTC boot, so the far-future
        // stamp lands on the current epoch's `first_seen_at` — a boundary `takeover_at` actually
        // returns (unlike a first epoch, where idx == 0 makes it None). A repair that only fired on
        // the NEXT takeover would never reach it: the same-uuid branch returns early on
        // `now <= last_seen_at`, so every later poll is a no-op and the account stays pinned to
        // `ceiling: None` forever. Healing must happen on the first sane poll instead.
        let sane = 1_700_000_000;
        let poisoned = sane + 10 * 365 * 24 * 60 * 60;
        let mut log = IdentityLog::new();
        observe(&mut log, "/d", "uuid-a", sane);
        observe(&mut log, "/d", "uuid-b", poisoned);
        assert_eq!(takeover_at(&log, "/d", "uuid-b"), Some(poisoned), "the bad boundary is real");

        // The clock is corrected. A plain heartbeat of the SAME uuid — no takeover — must heal it,
        // and must report that a write is owed or the repair never reaches disk.
        assert!(
            observe(&mut log, "/d", "uuid-b", sane + 60),
            "a repair must be persisted, not just applied in memory"
        );
        assert_eq!(
            takeover_at(&log, "/d", "uuid-b"),
            Some(sane + 60),
            "the boundary is no longer in the future"
        );
        assert_eq!(log["/d"].len(), 2, "healing must not fabricate an epoch");
        assert_ordered(&log["/d"]);
    }

    #[test]
    fn the_repair_reaches_every_poisoned_epoch_not_just_the_last() {
        // A bad clock can stamp several observations before anyone corrects it. Repairing only the
        // last would leave the list out of oldest-first order, which is the invariant takeover_at
        // and the drop-oldest cap both rest on.
        let sane = 1_700_000_000;
        let poisoned = sane + 10 * 365 * 24 * 60 * 60;
        let mut log = IdentityLog::new();
        observe(&mut log, "/d", "uuid-a", sane);
        observe(&mut log, "/d", "uuid-b", poisoned);
        observe(&mut log, "/d", "uuid-c", poisoned + 1000);
        observe(&mut log, "/d", "uuid-d", sane + 60);
        assert_eq!(log["/d"].len(), 4);
        assert_ordered(&log["/d"]);
        // The sane epoch that preceded the bad boot is untouched — ordinary history is never pulled
        // down, only the implausible tail.
        assert_eq!(log["/d"][0].first_seen_at, sane);
        assert_eq!(takeover_at(&log, "/d", "uuid-d"), Some(sane + 60));
    }

    #[test]
    fn a_large_backward_jump_across_a_takeover_still_leaves_an_ordered_list() {
        // Bounding the forward clamp must not re-open the far-PAST hole the bound was added on top
        // of. A backward jump larger than MAX_FUTURE_SKEW is the ambiguous case — "the stored value
        // is poisoned" and "`now` is skewed backward" look identical — so rather than stamping the
        // new epoch at a `now` that sits BELOW its predecessor (an out-of-order list, which breaks
        // the oldest-first assumption takeover_at and the cap both rest on), the predecessor is
        // repaired down.
        let sane = 1_700_000_000;
        let mut log = IdentityLog::new();
        // TWO prior epochs, not one: with a single predecessor a one-deep repair looks correct and
        // the ordering assertion below would pass without proving anything about depth.
        observe(&mut log, "/d", "uuid-a", sane - 1000);
        observe(&mut log, "/d", "uuid-b", sane);
        // The clock falls back by a week, and the identity changes in the same observation.
        let jumped = sane - 7 * 24 * 60 * 60;
        assert!(observe(&mut log, "/d", "uuid-c", jumped), "the takeover is recorded");
        assert_eq!(log["/d"].len(), 3);
        assert_ordered(&log["/d"]);
        // The boundary exists and is readable — it is NOT silently discarded, which is the failure
        // that would let a ceiling be learned straight across a real identity change.
        assert_eq!(takeover_at(&log, "/d", "uuid-c"), Some(jumped));
    }

    #[test]
    fn epochs_are_capped_keeping_the_newest() {
        let mut log = IdentityLog::new();
        for i in 0..(MAX_EPOCHS_PER_DIR as i64 + 10) {
            // Alternating identities — the pathological "two accounts share one dir" case.
            let uuid = if i % 2 == 0 { "uuid-a" } else { "uuid-b" };
            observe(&mut log, "/d", uuid, 1_000 + i);
        }
        assert_eq!(log["/d"].len(), MAX_EPOCHS_PER_DIR, "unbounded growth is the bug");
        let last = log["/d"].last().unwrap();
        assert_eq!(last.first_seen_at, 1_000 + MAX_EPOCHS_PER_DIR as i64 + 9, "newest retained");
    }

    #[test]
    fn record_observations_persists_and_reads_back() {
        let base = unique_dir("record");
        let path = identity_log_path(&base);
        // Absent file → empty, never an error.
        assert_eq!(read_log_at(&path), IdentityLog::new());

        let log = record_observations(
            &path,
            &[("".to_string(), Some(("uuid-home".to_string(), "email:uuid-home@test.invalid".to_string()))), ("/x".to_string(), None)],
            1_000,
        );
        assert_eq!(log[""][0].account_uuid, "uuid-home");
        // A `None` uuid contributes NOTHING: an unattributable read must not look like a takeover.
        assert!(!log.contains_key("/x"));
        assert_eq!(read_log_at(&path), log, "the returned map is what landed on disk");

        // A later different uuid behind the same dir opens an epoch AND persists immediately.
        let log = record_observations(&path, &[("".to_string(), Some(("uuid-two".to_string(), "email:uuid-two@test.invalid".to_string())))], 9_000);
        assert_eq!(log[""].len(), 2);
        assert_eq!(read_log_at(&path)[""].len(), 2);
        assert_eq!(takeover_at(&read_log_at(&path), "", "uuid-two"), Some(9_000));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn write_is_atomic_and_leaves_valid_file_with_no_temp() {
        // Mirrors accounts::write_is_atomic_and_leaves_valid_file_with_no_temp — a truncated ledger
        // loses every takeover boundary, so the temp+rename is load-bearing.
        let base = unique_dir("atomic");
        let path = identity_log_path(&base);
        let mut log = IdentityLog::new();
        observe(&mut log, "/d", "uuid-a", 1_000);
        write_log_at(&path, &log).unwrap();
        assert_eq!(read_log_at(&path), log);
        assert!(
            !path.with_extension("json.tmp").exists(),
            "temp file must be renamed away, not left behind"
        );

        // Overwrite (rename-over-existing) likewise yields a complete, parseable file.
        observe(&mut log, "/d", "uuid-b", 9_000);
        write_log_at(&path, &log).unwrap();
        assert_eq!(read_log_at(&path), log);
        assert!(!path.with_extension("json.tmp").exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_corrupt_ledger_reads_as_empty_rather_than_failing() {
        // Identity display must never break because this derived file is damaged.
        let base = unique_dir("corrupt");
        let path = identity_log_path(&base);
        std::fs::write(&path, b"{not json at all").unwrap();
        assert_eq!(read_log_at(&path), IdentityLog::new());
        // And recording over it recovers rather than erroring.
        let log = record_observations(&path, &[("/d".to_string(), Some(("uuid-a".to_string(), "email:uuid-a@test.invalid".to_string())))], 1_000);
        assert_eq!(log["/d"].len(), 1);
        assert_eq!(read_log_at(&path)["/d"].len(), 1);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn epoch_serializes_camel_case_keys() {
        let v = serde_json::to_value(IdentityEpoch {
            account_uuid: "c70bea4e".into(),
            first_seen_at: 1_785_800_000,
            last_seen_at: 1_785_886_200,
        })
        .unwrap();
        assert_eq!(v.get("accountUuid").unwrap(), "c70bea4e");
        assert!(v.get("firstSeenAt").is_some() && v.get("lastSeenAt").is_some());
        assert!(v.get("account_uuid").is_none(), "snake_case must not reach disk");
    }
}
