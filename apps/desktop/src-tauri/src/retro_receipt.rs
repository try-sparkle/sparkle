//! THE RETIREMENT RECEIPT STORE — the durable answer to "did this agent complete the retro step?"
//!
//! ── WHY A FILE, AND NOT A FIELD ON THE AGENT ────────────────────────────────────────────────────
//! `AgentTab` has no `retired`, `archived` or `closedAt` field: a close is a HARD DELETE from a
//! `localStorage` blob plus a 30-day tombstone. So a receipt kept on the row would be gone at
//! exactly the moment anyone asks about it — the founder confirming a retirement, or a later pass
//! auditing which agents never reported. It has to outlive the thing it describes.
//!
//! ── MODELLED ON `pr_owner.rs`, DELIBERATELY ─────────────────────────────────────────────────────
//! Same app-data directory, same nested-by-project shape, same process-wide lock around every
//! read-modify-write, same "a missing or corrupt file degrades to EMPTY" rule. That last one is the
//! fail-safe direction here for the same reason it is there: losing a receipt makes an agent read
//! as "has not reported" — the honest answer, and the one that asks rather than assumes. Serving a
//! half-parsed receipt would make it read as settled, which is the failure this whole feature
//! exists to close.
//!
//! ── THE SHAPE IS FROZEN IN TYPESCRIPT ───────────────────────────────────────────────────────────
//! `apps/desktop/src/engine/retroReceiptTypes.ts` is authoritative. Every struct here is
//! `rename_all = "camelCase"` and every optional field is `skip_serializing_if = "Option::is_none"`
//! so an absent field is ABSENT rather than `null` — the TS side distinguishes them, and its
//! `retroSettled` was already burned once by a `null` that arrived where `undefined` was expected
//! (roborev 58719). Do not add a field on one side without the other.
//!
//! ── STATE IS NOT VALIDATED AGAINST AN ENUM ON PURPOSE ───────────────────────────────────────────
//! `state`, `source` and `reason_code` are `String`, not Rust enums. This process only STORES what
//! the TS layer decided; the vocabulary lives in one place (`NO_RETRO_REASONS`) and the muster check
//! that polices it is `engine/retroMuster`. A second Rust enum would be a second copy of a closed
//! vocabulary, and a receipt written by a newer frontend would fail to deserialize here and be
//! silently dropped — which reads downstream as "this agent never reported".

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// On-disk shape version. Bump only alongside a migration, and alongside
/// `RETRO_RECEIPT_STORE_VERSION` in retroReceiptTypes.ts.
pub const STORE_VERSION: u32 = 1;

/// One agent's completed retro step. Mirrors `RetroReceipt` in retroReceiptTypes.ts field-for-field.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RetroReceipt {
    /// `captured` | `excused` | `overridden`. See the module header for why this is not an enum.
    pub state: String,
    /// Epoch ms.
    pub at: i64,
    /// `pr-marker` | `result-json` | `agent-declared` | `human-override` | `concierge-override`.
    ///
    /// `human-override` and `concierge-override` share the `overridden` state and differ ONLY here:
    /// one gap was accepted by a person, the other by the concierge on the founder's standing
    /// authorization. Preserving this string verbatim is what keeps the second from reading as the
    /// first — see the module header for why nothing in this file validates it against an enum.
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_number: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tldr: Option<String>,
    /// ZERO IS MEANINGFUL — a frictionless retro is a COMPLETE one, and conflating `Some(0)` with
    /// `None` is the exact conflation this store was built to end.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pain_point_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_text: Option<String>,
    /// Display only, never a gate — see the TS field's doc comment.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_evidence: Option<String>,
}

/// The whole durable store. Nested by project id rather than flattened under a composite key, for
/// `pr_owner`'s two reasons: the file stays readable by a human debugging a wrong pill, and no
/// separator character can be smuggled in through an id.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(default)]
pub struct RetroReceiptStore {
    pub version: u32,
    /// projectId → agentId → receipt.
    pub receipts: BTreeMap<String, BTreeMap<String, RetroReceipt>>,
}

impl Default for RetroReceiptStore {
    fn default() -> Self {
        Self { version: STORE_VERSION, receipts: BTreeMap::new() }
    }
}

/// `<app_data>/retro-receipts.json`, alongside `pr_owner`'s `pr-owners.json`.
pub fn store_path(app_data: &Path) -> PathBuf {
    app_data.join("retro-receipts.json")
}

/// Serializes every read-modify-write. Process-wide, exactly like `pr_owner`'s: several writers
/// exist (the PR poll parsing a marker, a worker's result.json, an agent declaring a reason, a human
/// override) and they can fire concurrently. A lost update here means an agent's completed step
/// silently reads as missing, which re-pings an agent that already complied.
fn store_lock() -> &'static Mutex<()> {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Read the store. A missing, unreadable or corrupt file degrades to EMPTY — see the module header
/// for why that is the fail-safe direction.
pub fn load_store(app_data: &Path) -> RetroReceiptStore {
    std::fs::read_to_string(store_path(app_data))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Replace the store ATOMICALLY: temp file in the SAME directory, fsync, then `rename`.
///
/// This was a plain `std::fs::write`, which truncates the real file and then streams into it — so a
/// crash, or a second Sparkle window writing at the same moment, could leave a half-written or
/// interleaved store on disk (knightwatch probe 5). That matters more here than for most caches:
/// `load_store` degrades a corrupt file to EMPTY, which is the fail-closed direction, but empty
/// reads as "nobody has reported" for EVERY agent — one torn write silently erases the whole
/// feedback record.
///
/// The fsync earns its place alongside the rename. `rename` is atomic, so a crash can never expose a
/// half-written file under the real name; without the fsync a crash after the rename could leave the
/// new name pointing at unflushed (zero-length) content on some filesystems. Together the store is
/// always either the old JSON or the new JSON. Same shape as `babysit_lease::save_store` — copied
/// deliberately rather than invented, so the two durability stories cannot drift.
fn save_store(app_data: &Path, store: &RetroReceiptStore) -> Result<(), String> {
    use std::io::Write as _;
    std::fs::create_dir_all(app_data).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    let final_path = store_path(app_data);
    // Unique per process AND per call: a dev build and a release build can point at the same dir, and
    // a leftover temp must never be mistaken for another writer's in-flight file.
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = app_data.join(format!(".retro-receipts.{}.{seq}.tmp", std::process::id()));
    let write = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, &final_path)
    })();
    if let Err(e) = write {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "retro receipt store write failed at {}: {e}",
            final_path.display()
        ));
    }
    Ok(())
}

/// Is this id safe to use as a JSON object key and a store lookup?
///
/// The same character class `pr_owner::is_agent_id` enforces, and for the same reason: ids reach
/// this store from a PR body marker and from a shell env var, neither of which is trusted input.
fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Record (or replace) one agent's receipt.
///
/// LAST WRITE WINS, deliberately. The realistic sequence is a weaker source arriving first — an
/// agent declaring `nothing-to-report` — and the PR marker landing afterwards with the real retro.
/// Keeping the first would pin the agent to the thinner record forever. There is no ordering
/// guarantee to exploit here and no timestamp comparison worth the complexity: every state in the
/// vocabulary means the step is complete, so overwriting never turns a settled agent unsettled.
pub fn record_at(
    app_data: &Path,
    project_id: &str,
    agent_id: &str,
    receipt: RetroReceipt,
) -> Result<(), String> {
    if !is_safe_id(project_id) || !is_safe_id(agent_id) {
        return Err("retro_receipt: refusing a malformed project or agent id".into());
    }
    let _guard = store_lock().lock().map_err(|e| e.to_string())?;
    let mut store = load_store(app_data);
    store.version = STORE_VERSION;
    store
        .receipts
        .entry(project_id.to_string())
        .or_default()
        .insert(agent_id.to_string(), receipt);
    save_store(app_data, &store)
}

/// One agent's receipt, or `None` when the step has not been completed.
///
/// `None` crosses to TypeScript as JSON `null` (there is no `undefined` on the wire), which is
/// precisely why `retroSettled` there checks `!= null` rather than `!== undefined` — see
/// roborev 58719. Do not "helpfully" substitute a default receipt here: an absent receipt is the
/// signal, and manufacturing one would report every silent agent as having reported.
pub fn get_at(app_data: &Path, project_id: &str, agent_id: &str) -> Option<RetroReceipt> {
    load_store(app_data)
        .receipts
        .get(project_id)
        .and_then(|m| m.get(agent_id))
        .cloned()
}

/// Every receipt for a project, as `agentId → receipt`. One call per project rather than one per
/// row: the build column asks this for the whole list on every status poll.
pub fn all_at(app_data: &Path, project_id: &str) -> BTreeMap<String, RetroReceipt> {
    load_store(app_data).receipts.get(project_id).cloned().unwrap_or_default()
}

// ── Tauri commands ──────────────────────────────────────────────────────────────────────────
//
// All `async` + `spawn_blocking`. A sync `#[tauri::command]` body runs on the MAIN thread, where a
// file read starves the concierge bridge and — if it ever took a contended lock — can freeze the
// whole UI. The app-data-dir resolution needs `&app` so it stays on the caller thread; only the
// blocking file work moves to the pool.

#[tauri::command]
pub async fn retro_receipt_record(
    app: AppHandle,
    project_id: String,
    agent_id: String,
    receipt: RetroReceipt,
) -> Result<(), String> {
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        record_at(&app_data, &project_id, &agent_id, receipt)
    })
    .await
    .map_err(|e| format!("retro_receipt_record task failed: {e}"))?
}

#[tauri::command]
pub async fn retro_receipt_get(
    app: AppHandle,
    project_id: String,
    agent_id: String,
) -> Result<Option<RetroReceipt>, String> {
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    tauri::async_runtime::spawn_blocking(move || get_at(&app_data, &project_id, &agent_id))
        .await
        .map_err(|e| format!("retro_receipt_get task failed: {e}"))
}

#[tauri::command]
pub async fn retro_receipt_all(
    app: AppHandle,
    project_id: String,
) -> Result<BTreeMap<String, RetroReceipt>, String> {
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    tauri::async_runtime::spawn_blocking(move || all_at(&app_data, &project_id))
        .await
        .map_err(|e| format!("retro_receipt_all task failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    /// The atomic-write contract (knightwatch probe 5): no temp file survives a successful write,
    /// and the store on disk is the NEW content — never a truncated file under the real name.
    #[test]
    fn a_write_leaves_no_temp_behind_and_the_store_is_whole() {
        let d = tmp();
        record_at(d.path(), "p1", "a1", captured()).expect("record");
        record_at(d.path(), "p1", "a2", captured()).expect("record");

        let strays: Vec<_> = std::fs::read_dir(d.path())
            .expect("read_dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(strays.is_empty(), "temp files left behind: {strays:?}");

        // Whole, and both writes present — a torn write would surface here as a parse failure
        // degrading to the default (empty) store.
        let store = load_store(d.path());
        let by_agent = store.receipts.get("p1").expect("project present");
        assert_eq!(by_agent.len(), 2);
    }

    fn captured() -> RetroReceipt {
        RetroReceipt {
            state: "captured".into(),
            at: 1_700_000_000_000,
            source: "pr-marker".into(),
            pr_number: Some(1234),
            tldr: Some("Did the thing".into()),
            pain_point_count: Some(0),
            reason_code: None,
            reason_text: None,
            branch_evidence: None,
        }
    }

    /// The machine-authored counterpart to `human-override`: same `overridden` state, written by the
    /// concierge rather than by a person.
    fn concierge_override() -> RetroReceipt {
        RetroReceipt {
            state: "overridden".into(),
            at: 1_700_000_000_001,
            source: "concierge-override".into(),
            pr_number: None,
            tldr: None,
            pain_point_count: None,
            reason_code: Some("other".into()),
            reason_text: Some("Retired with no retro anywhere; no receipt and no feedback beads.".into()),
            branch_evidence: Some("0 ahead, clean".into()),
        }
    }

    #[test]
    fn round_trips_a_receipt_through_the_file() {
        let d = tmp();
        record_at(d.path(), "p1", "a1", captured()).unwrap();
        assert_eq!(get_at(d.path(), "p1", "a1"), Some(captured()));
    }

    #[test]
    fn round_trips_a_concierge_override_with_its_source_intact() {
        // `state` alone cannot tell a concierge-written gap mark from a human-written one — `source`
        // is the ONLY thing that does. So the bit worth pinning is not that the receipt survives but
        // that this exact string does, byte for byte, out to disk and back. Anything that normalized
        // or defaulted it would silently attribute a machine's decision to a person, permanently.
        let d = tmp();
        record_at(d.path(), "p1", "a1", concierge_override()).unwrap();
        assert_eq!(get_at(d.path(), "p1", "a1"), Some(concierge_override()));

        let text = std::fs::read_to_string(store_path(d.path())).unwrap();
        assert!(text.contains("\"source\": \"concierge-override\""), "got: {text}");
        assert!(!text.contains("human-override"), "attributed to a person: {text}");
        // camelCase across the wire, and the optional fields this variant actually carries are
        // present rather than skipped — `branchEvidence` is what the dialog shows beside the mark.
        assert!(text.contains("\"branchEvidence\": \"0 ahead, clean\""), "got: {text}");
        assert!(!text.contains("branch_evidence"), "snake_case leaked: {text}");

        let got = get_at(d.path(), "p1", "a1").expect("receipt present");
        assert_eq!(got.state, "overridden");
        assert_eq!(got.source, "concierge-override");
    }

    #[test]
    fn a_concierge_override_deserializes_from_the_camel_case_wire_shape() {
        // The other direction of the frozen contract: a receipt authored by the TypeScript writer
        // (`recordRetroConciergeOverride`) arrives as camelCase JSON. A receipt this side failed to
        // deserialize would be dropped, and a dropped receipt reads downstream as "never reported".
        let wire = r#"{
            "state": "overridden",
            "at": 1700000000001,
            "source": "concierge-override",
            "reasonCode": "other",
            "reasonText": "Retired with no retro anywhere; no receipt and no feedback beads.",
            "branchEvidence": "0 ahead, clean"
        }"#;
        let parsed: RetroReceipt = serde_json::from_str(wire).expect("deserialize");
        assert_eq!(parsed, concierge_override());
    }

    #[test]
    fn an_absent_receipt_is_none_and_is_never_manufactured() {
        // The signal the whole gate rests on. A default-filled receipt here would report every
        // agent that never spoke as having completed the step.
        let d = tmp();
        assert_eq!(get_at(d.path(), "p1", "nobody"), None);
        record_at(d.path(), "p1", "a1", captured()).unwrap();
        assert_eq!(get_at(d.path(), "p1", "other"), None);
        assert_eq!(get_at(d.path(), "other-project", "a1"), None);
    }

    #[test]
    fn a_zero_pain_point_count_survives_the_round_trip_as_zero() {
        // `skip_serializing_if = "Option::is_none"` must not be allowed to swallow `Some(0)`.
        // Conflating "reported no friction" with "never reported" is the original bug.
        let d = tmp();
        record_at(d.path(), "p1", "a1", captured()).unwrap();
        let text = std::fs::read_to_string(store_path(d.path())).unwrap();
        assert!(text.contains("\"painPointCount\": 0"), "got: {text}");
        assert_eq!(get_at(d.path(), "p1", "a1").unwrap().pain_point_count, Some(0));
    }

    #[test]
    fn absent_optionals_are_absent_rather_than_null() {
        // The TS side distinguishes a missing key from an explicit null, and was burned once by a
        // null arriving where undefined was expected (roborev 58719).
        let d = tmp();
        record_at(d.path(), "p1", "a1", captured()).unwrap();
        let text = std::fs::read_to_string(store_path(d.path())).unwrap();
        assert!(!text.contains("null"), "no field should serialize as null; got: {text}");
        assert!(!text.contains("reasonCode"));
    }

    #[test]
    fn serializes_in_camel_case_to_match_the_typescript_contract() {
        let d = tmp();
        record_at(d.path(), "p1", "a1", captured()).unwrap();
        let text = std::fs::read_to_string(store_path(d.path())).unwrap();
        for key in ["prNumber", "painPointCount"] {
            assert!(text.contains(key), "missing {key} in {text}");
        }
        for snake in ["pr_number", "pain_point_count", "reason_code", "branch_evidence"] {
            assert!(!text.contains(snake), "snake_case leaked: {snake}");
        }
    }

    #[test]
    fn a_corrupt_store_degrades_to_empty_rather_than_to_a_settled_reading() {
        // Fail-safe direction: losing receipts makes agents read as "has not reported", which asks.
        // A half-parsed store that read as settled would retire agents that never spoke.
        let d = tmp();
        std::fs::create_dir_all(d.path()).unwrap();
        std::fs::write(store_path(d.path()), "{ this is not json").unwrap();
        assert_eq!(load_store(d.path()), RetroReceiptStore::default());
        assert_eq!(get_at(d.path(), "p1", "a1"), None);
    }

    #[test]
    fn a_later_write_replaces_an_earlier_one() {
        // Last-write-wins is deliberate: a thin `agent-declared` excuse must not outrank the real
        // retro that arrives with the PR marker afterwards.
        let d = tmp();
        let excuse = RetroReceipt {
            state: "excused".into(),
            source: "agent-declared".into(),
            reason_code: Some("nothing-to-report".into()),
            pr_number: None,
            tldr: None,
            pain_point_count: None,
            reason_text: Some("Nothing came of this branch at all.".into()),
            branch_evidence: None,
            at: 1,
        };
        record_at(d.path(), "p1", "a1", excuse).unwrap();
        record_at(d.path(), "p1", "a1", captured()).unwrap();
        assert_eq!(get_at(d.path(), "p1", "a1"), Some(captured()));
    }

    #[test]
    fn refuses_a_malformed_id_instead_of_writing_it_as_a_key() {
        // Ids reach this store from a PR body marker and a shell env var — neither is trusted.
        let d = tmp();
        for bad in ["", "has space", "../escape", "a/b", &"x".repeat(129)] {
            assert!(record_at(d.path(), "p1", bad, captured()).is_err(), "accepted {bad:?}");
            assert!(record_at(d.path(), bad, "a1", captured()).is_err(), "accepted {bad:?}");
        }
        assert_eq!(load_store(d.path()), RetroReceiptStore::default());
    }

    #[test]
    fn all_at_returns_every_agent_in_the_project_and_nothing_from_others() {
        let d = tmp();
        record_at(d.path(), "p1", "a1", captured()).unwrap();
        record_at(d.path(), "p1", "a2", captured()).unwrap();
        record_at(d.path(), "p2", "a3", captured()).unwrap();
        let got = all_at(d.path(), "p1");
        assert_eq!(got.keys().collect::<Vec<_>>(), vec!["a1", "a2"]);
        assert!(all_at(d.path(), "p3").is_empty());
    }

    #[test]
    fn stamps_the_store_version() {
        let d = tmp();
        record_at(d.path(), "p1", "a1", captured()).unwrap();
        assert_eq!(load_store(d.path()).version, STORE_VERSION);
    }
}
