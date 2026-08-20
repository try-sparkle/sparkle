//! The RECIPIENT half of cross-agent messaging for the concierge (bead sparkle-179b2s, Phase A2).
//!
//! The concierge is NOT a worktree agent: it has no PTY and no `Stop` hook, so neither of the two
//! existing inbox delivery paths can reach it. `sparkle-hook.mjs` drains a worktree agent's queue at
//! its turn boundary and `fleetWatch` delivers over an idle agent's PTY — the concierge has neither
//! surface. So its inbox is drained on the TS side at turn assembly instead (see
//! `services/conciergeInbox.ts`): the pending messages are read READ-ONLY through `inbox_peek` and
//! injected into the turn prompt.
//!
//! WHY THIS COMMAND EXISTS. After injecting, those messages must be ACKED so the next turn does not
//! re-inject them — the exact-once guard for the concierge is the ack file, because there is no
//! `O_EXCL` claim race for a single-reader turn (`entries_of` treats an ack as `Acknowledged`, which
//! the TS drain filters out). But the concierge's own `claude -p` runs with a reads+search+web tool
//! allowlist — NO `Bash`, no writes (see `concierge.rs`) — so it cannot append the ack itself the way
//! a worktree agent does with `printf >> acks`. And the renderer has no filesystem plugin. So the
//! ack has to be written by the app, through this command.
//!
//! Deliberately NARROW: it acks the concierge's own inbox only. The agent id is a compile-time
//! constant, never caller-supplied, so there is no traversal surface to validate — the id cannot be
//! anything but `sparkle:concierge`. It reuses `inbox::acks_path` and `inbox::InboxAck` so the line
//! it writes is byte-for-byte the shape `inbox.rs`'s readers already parse; it does not touch
//! `inbox.rs`.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::AppHandle;

use crate::inbox::{acks_path, InboxAck};

/// The concierge's inbox id. Mirrors `CONCIERGE_ACCOUNT_KEY` on the TS side
/// (`services/accountSelection.ts`) and passes `inbox::validate_agent_id` — a colon is allowed.
pub const CONCIERGE_INBOX_ID: &str = "sparkle:concierge";

/// Milliseconds since the epoch. Mirrors `inbox::now_ms` (private there), kept in step by the
/// `ack_line_shape_matches_inbox_ack` test below asserting the field names round-trip.
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Append one ack line per id to the concierge's acks file.
///
/// Extracted from the command so it is testable without an `AppHandle` — the command is the one
/// line that resolves app-data, everything with behaviour lives here. Best-effort per id: a single
/// failed append is logged and the rest still land, because a lost ack only costs ONE extra
/// re-injection next turn (the message stays visible), never a lost message.
///
/// Heals a torn tail the same way `inbox::append_jsonl` does: if the previous append died before its
/// newline, `O_APPEND` would fuse the next record onto the partial one and `read_jsonl` would skip
/// the fused line — silently dropping this ack. Writing the missing newline first keeps the damage
/// to at most one record.
fn ack_ids(base: &Path, agent_id: &str, ids: &[String], now: i64) -> Result<(), String> {
    use std::io::Write;

    let path = acks_path(base, agent_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("concierge ack mkdir: {e}"))?;
    }

    // Heal a torn tail before appending — see the doc comment above.
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > 0 {
        let ends_clean = std::fs::read(&path)
            .map(|b| b.last().copied() == Some(b'\n'))
            .unwrap_or(true);
        if !ends_clean {
            if let Ok(mut f) = std::fs::OpenOptions::new().append(true).open(&path) {
                let _ = f.write_all(b"\n");
            }
        }
    }

    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("concierge ack open: {e}"))?;

    for id in ids {
        let ack = InboxAck {
            id: id.clone(),
            ts: now,
            // The app read the message, injected it, and is confirming that in one motion — the same
            // "read" note a worktree agent's `printf` writes.
            note: Some("read".to_string()),
        };
        match serde_json::to_string(&ack) {
            Ok(line) => {
                if let Err(e) = writeln!(f, "{line}") {
                    tracing::warn!("concierge ack write for {id}: {e}");
                }
            }
            Err(e) => tracing::warn!("concierge ack encode for {id}: {e}"),
        }
    }
    Ok(())
}

/// Acknowledge one or more concierge inbox messages by id.
///
/// Called by `services/conciergeInbox.ts` after it injects the pending messages into a turn prompt.
/// `async` + `spawn_blocking` to match every other inbox command: the write is small, but it must
/// not sit on the main thread, which the concierge's own control surface also needs.
#[tauri::command]
pub async fn concierge_inbox_ack(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    let base = crate::dev_identity::app_data_dir(&app)?;
    let now = now_ms();
    tauri::async_runtime::spawn_blocking(move || ack_ids(&base, CONCIERGE_INBOX_ID, &ids, now))
        .await
        .map_err(|e| format!("concierge_inbox_ack task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sparkle-concierge-inbox-{tag}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The line this writes must be exactly the `InboxAck` shape `inbox.rs` reads back — id, ts, and
    /// a "read" note — or `entries_of` would never flip the message to `acknowledged` and the TS
    /// drain would re-inject it forever.
    #[test]
    fn ack_line_shape_matches_inbox_ack() {
        let base = tmp("shape");
        ack_ids(&base, CONCIERGE_INBOX_ID, &["m1".to_string()], 1_700).unwrap();

        let raw = std::fs::read_to_string(acks_path(&base, CONCIERGE_INBOX_ID)).unwrap();
        let line = raw.lines().next().expect("one ack line");
        let ack: InboxAck = serde_json::from_str(line).expect("parses as InboxAck");
        assert_eq!(ack.id, "m1");
        assert_eq!(ack.ts, 1_700);
        assert_eq!(ack.note.as_deref(), Some("read"));
    }

    /// Two ids acked in one call produce two records, both readable — the batch a single turn drains.
    #[test]
    fn acks_every_id_in_the_batch() {
        let base = tmp("batch");
        ack_ids(
            &base,
            CONCIERGE_INBOX_ID,
            &["a".to_string(), "b".to_string()],
            2_000,
        )
        .unwrap();

        let raw = std::fs::read_to_string(acks_path(&base, CONCIERGE_INBOX_ID)).unwrap();
        let ids: Vec<String> = raw
            .lines()
            .filter_map(|l| serde_json::from_str::<InboxAck>(l).ok())
            .map(|a| a.id)
            .collect();
        assert_eq!(ids, vec!["a".to_string(), "b".to_string()]);
    }

    /// A second call APPENDS rather than truncating: acks from an earlier turn must survive so a
    /// message acked last turn is never re-offered.
    #[test]
    fn a_later_ack_keeps_the_earlier_one() {
        let base = tmp("append");
        ack_ids(&base, CONCIERGE_INBOX_ID, &["first".to_string()], 10).unwrap();
        ack_ids(&base, CONCIERGE_INBOX_ID, &["second".to_string()], 20).unwrap();

        let raw = std::fs::read_to_string(acks_path(&base, CONCIERGE_INBOX_ID)).unwrap();
        let ids: Vec<String> = raw
            .lines()
            .filter_map(|l| serde_json::from_str::<InboxAck>(l).ok())
            .map(|a| a.id)
            .collect();
        assert_eq!(ids, vec!["first".to_string(), "second".to_string()]);
    }

    /// A torn tail (a previous append that died before its newline) is healed, not spread: the fused
    /// `{torn}{fresh}` line `read_jsonl` would skip is separated so the fresh ack survives.
    #[test]
    fn heals_a_torn_tail_before_appending() {
        let base = tmp("torn");
        let path = acks_path(&base, CONCIERGE_INBOX_ID);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // A partial line with NO trailing newline, as a killed append would leave.
        std::fs::write(&path, "{\"id\":\"partial\",\"ts\":1").unwrap();

        ack_ids(&base, CONCIERGE_INBOX_ID, &["fresh".to_string()], 30).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        // The fresh ack parses on its own line rather than being fused onto the torn one.
        let fresh = raw
            .lines()
            .filter_map(|l| serde_json::from_str::<InboxAck>(l).ok())
            .find(|a| a.id == "fresh");
        assert!(fresh.is_some(), "fresh ack survived the torn tail");
    }
}
