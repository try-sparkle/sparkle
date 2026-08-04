//! Level 2 of the concierge fleet-awareness ladder: a durable, per-agent message inbox that is
//! cheap, asynchronous and NON-INTERRUPTING.
//!
//! WHY A QUEUE AT ALL. The only way to reach an agent today is
//! `send_to_agent_terminal`, which writes straight into the PTY. That costs the agent a full turn
//! and — worse — can END the turn it was in the middle of, discarding work in progress. It is the
//! right tool for "stop, you are about to commit something wrong" and the wrong tool for "main has
//! moved, rebase before you verify". Having only the interrupting channel means every message is
//! sent at maximum cost, or not sent at all.
//!
//! THE DELIVERY RULE. A queued message is drained at the agent's NEXT NATURAL TURN BOUNDARY, never
//! mid-task. Claude Code already runs a `Stop` hook in every agent worktree (registered by
//! `hooks.rs`), and `Stop` fires exactly at that boundary — so delivery costs nothing extra and
//! lands when the agent is between pieces of work rather than inside one.
//!
//! THE CASE THAT RULE MISSES, AND THE SECOND PATH. An agent that is ALREADY IDLE has had its last
//! `Stop` and will not emit another until someone gives it work. A message queued after that point
//! would sit undelivered forever. So there are two delivery paths:
//!
//!   1. `Stop` hook — the agent was working, reaches a boundary, drains the inbox itself.
//!   2. App-side, when Level 0 observes the agent is idle — a PTY write is non-interrupting *by
//!      construction* when there is no turn to interrupt.
//!
//! Both paths race, and both must never deliver the same message twice. That is what `claim()`
//! below is for: an `O_EXCL` file create is atomic across processes, so exactly one path wins per
//! message id, and the loser silently skips. This is also the loop guard for the hook — it claims
//! BEFORE it asks Claude to continue, so the next `Stop` finds nothing to claim and does not block
//! again.
//!
//! WHAT "ACKNOWLEDGED" HONESTLY MEANS. Three states were asked for — delivered, acknowledged,
//! acted-on. Two of them are observable and one is not:
//!
//! * `delivered` — a claim file exists. A fact.
//! * `acknowledged` — the agent appended a line to its ack log. A fact.
//! * `acted-on` — NOT OBSERVABLE, and this module does not pretend otherwise. Whether an agent
//!   actually rebased because it was told to is not decidable from an ack; the honest proxy is the
//!   Level 0 digest showing the branch move, which is a separate question asked of separate
//!   evidence. Inventing a third state that is really "acknowledged, and we hope" would make the
//!   queue lie.
//!
//! Acks are DELIVERY CONFIRMATION, never liveness. An unacknowledged message means the agent is not
//! reaching turn boundaries — which Level 0 has already shown, for free, without the queue.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// Max messages held per agent. Beyond this a send is refused rather than silently dropping the
/// oldest: a concierge that believes it delivered something it did not is worse than one told no.
pub(crate) const MAX_PER_AGENT: usize = 50;

/// How long an undelivered message stays worth delivering. A "main has moved, rebase" message is
/// actively misleading a day later, and this queue is durable precisely so it survives restarts —
/// which means without a TTL it would also survive into irrelevance.
///
/// This expires a message LOGICALLY; the bytes are removed by `retention::reap_inbox`, which
/// derives its compaction age from this constant so the two can never drift into a window where a
/// record is still deliverable but already reaped.
pub(crate) const MAX_AGE_MS: i64 = 12 * 60 * 60 * 1000;

/// Why the message was sent. Drives nothing automatic — it is there so the injected text can tell
/// the agent whether this needs action before it continues, or is context it should simply hold.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    /// Context. Read it, carry on.
    Fyi,
    /// Something to do before continuing — a rebase, a settled decision, a file another agent owns.
    Act,
}

/// One queued message.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InboxMessage {
    pub id: String,
    pub ts: i64,
    /// Who sent it. `concierge` today; recorded so a future sender is distinguishable.
    pub from: String,
    pub text: String,
    pub severity: Severity,
}

/// One acknowledgement, appended by the agent itself.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InboxAck {
    /// The message id being acknowledged.
    pub id: String,
    pub ts: i64,
    /// Optional free text from the agent — what it did, or why it is not doing it.
    #[serde(default)]
    pub note: Option<String>,
}

/// What the concierge can see about one agent's inbox.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InboxStatus {
    pub agent_id: String,
    /// Queued and not yet claimed by either delivery path.
    pub pending: u32,
    /// Claimed by a delivery path — the agent has been shown the text.
    pub delivered: u32,
    /// The agent wrote an ack line.
    pub acknowledged: u32,
    /// Delivered but not acknowledged. A non-zero value here alongside a `silent` Level 0 verdict is
    /// the signature of an agent that is not reaching turn boundaries.
    pub awaiting_ack: u32,
    /// Ids still pending, so a caller can name them rather than only count them.
    pub pending_ids: Vec<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

/// Reject anything that is not a plain id before it reaches a path join.
fn validate_agent_id(agent_id: &str) -> Result<(), String> {
    if agent_id.is_empty()
        || agent_id.contains('/')
        || agent_id.contains('\\')
        || agent_id.contains("..")
        || agent_id.contains('\0')
    {
        return Err(format!("inbox: invalid agent id {agent_id:?}"));
    }
    Ok(())
}

/// Validate every id in a batch, rejecting the WHOLE call on the first bad one.
///
/// All-or-nothing on purpose: returning partial results for a batch containing a traversal-shaped id
/// would tell the caller its probe was partly accepted, which is a worse answer than a refusal.
fn validate_all(agent_ids: &[String]) -> Result<(), String> {
    for id in agent_ids {
        validate_agent_id(id)?;
    }
    Ok(())
}

/// Returns `true` if `agent_id` must not be allowed to reach a path join — the caller then fails
/// closed (empty/zero), having read nothing.
///
/// This exists because validating at the COMMAND is a guarantee one deleted line wide. `inbox_status`
/// rightly refuses a bad batch loudly and before the thread hop, so a crafted id never occupies a
/// blocking-pool slot — but `status_of` and `pending` are `pub`, take a bare `&str`, and build paths
/// from it. Anything that reads "redundant, the command already checks" during a refactor or a merge
/// resolution silently reopens a traversal, with the whole suite still green. Defence at the sink is
/// what survives that, and it extends the guarantee to callers that were never routed through a
/// command at all.
///
/// Silent rather than `Result` on purpose: these two are infallible by design (an agent with no inbox
/// legitimately reports all-zero, which is why `status_of` does not return `Result` today), and the
/// only entry point taking untrusted input already answers loudly. `validate_agent_id` rejects only
/// shapes no real agent id has — empty, `/`, `\`, `..`, NUL — so the quiet path is unreachable for a
/// well-formed caller. The `warn` is what makes it diagnosable rather than merely safe.
fn refuse_escape(what: &str, agent_id: &str) -> bool {
    match validate_agent_id(agent_id) {
        Ok(()) => false,
        Err(e) => {
            tracing::warn!(sink = what, "inbox: refusing id that would escape the inbox dir: {e}");
            true
        }
    }
}

/// `<app_data>/inbox` — deliberately OUTSIDE the worktree.
///
/// `spin_down_worker` deletes a worker's worktree, so an inbox stored at `<worktree>/.sparkle/`
/// would be destroyed along with the evidence of whether its messages were ever read. Keeping it in
/// app-data means the record outlives the agent, which is the same reasoning that already puts the
/// hook-event logs there.
pub fn inbox_dir(app_data: &Path) -> PathBuf {
    app_data.join("inbox")
}

pub fn messages_path(app_data: &Path, agent_id: &str) -> PathBuf {
    inbox_dir(app_data).join(format!("{agent_id}.jsonl"))
}

pub fn acks_path(app_data: &Path, agent_id: &str) -> PathBuf {
    inbox_dir(app_data).join(format!("{agent_id}.acks.jsonl"))
}

pub fn claims_dir(app_data: &Path, agent_id: &str) -> PathBuf {
    inbox_dir(app_data).join("claims").join(agent_id)
}

/// Atomically claim a message for delivery. Returns `true` if THIS caller won.
///
/// `create_new` maps to `O_CREAT | O_EXCL`, which the kernel guarantees is atomic — so when the
/// `Stop` hook (a separate node process) and the app race to deliver the same message, exactly one
/// of them gets `true` and the other gets `false`. Nothing else in this module needs a lock.
///
/// The MESSAGE id gets the same sink-side check the AGENT id gets — see [`refuse_escape`], whose
/// argument applies here unchanged. `claims.join(id)` is a path join over a value this module does
/// not mint: ids arrive by parsing the messages JSONL, and `read_jsonl` will happily hand back a
/// record whose `id` is `../../../../something`. Every other path join in this module is guarded and
/// this pair was not, so a record like that reached the filesystem OUTSIDE the claims dir — creating
/// a file there via `create_new`, and probing for one via `is_claimed`. Fails closed: an id that
/// cannot be a claim file name is never claimed and so is never delivered.
pub fn claim(claims: &Path, id: &str) -> bool {
    if refuse_escape("claim", id) {
        return false;
    }
    if std::fs::create_dir_all(claims).is_err() {
        return false;
    }
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(claims.join(id))
        .is_ok()
}

/// Fails closed as ALREADY CLAIMED for an id that would escape the claims dir.
///
/// `true` is the safe answer for two of the three callers. `pending` filters claimed messages out,
/// so such a record drops out of the delivery set instead of being offered to a claimant that
/// `claim` would then refuse anyway — the two functions agree about the same record rather than
/// looping over one they disagree on. `retention::reap_inbox` treats claimed as reapable, which is
/// also right: nothing will ever deliver it.
///
/// The third caller, `status_of`, is the one this answer does NOT suit — `true` there would count
/// the record as `delivered` and strand `awaiting_ack` at >= 1 forever. It therefore skips such a
/// record before asking, rather than reinterpreting this boolean; see the comment at that call.
pub fn is_claimed(claims: &Path, id: &str) -> bool {
    if refuse_escape("is_claimed", id) {
        return true;
    }
    claims.join(id).exists()
}

/// Parse a JSONL file into records, skipping malformed lines.
///
/// Skipping rather than failing is deliberate and matches the hook emitter's own contract: a torn
/// or partial line means a bad write, not a reason to make the whole inbox unreadable.
fn read_jsonl<T: for<'de> Deserialize<'de>>(path: &Path) -> Vec<T> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return vec![];
    };
    raw.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter_map(|l| serde_json::from_str::<T>(l).ok())
        .collect()
}

/// The `id` and `ts` of one JSONL inbox record — the two fields `InboxMessage` and `InboxAck`
/// share, so one parser serves both files.
///
/// Exposed for `retention::reap_inbox`, which compacts these files by age and must read each
/// RECORD's own timestamp rather than the file's mtime: a single append refreshes the mtime of
/// every record in the file, so mtime cannot tell a stale record from a fresh one. Returns `None`
/// for a line that is not a well-formed record, which the reaper treats as "cannot judge, keep" —
/// the same skip-don't-fail contract `read_jsonl` already applies to torn writes.
pub(crate) fn record_id_and_ts(line: &str) -> Option<(String, i64)> {
    #[derive(Deserialize)]
    struct IdTs {
        id: String,
        ts: i64,
    }
    serde_json::from_str::<IdTs>(line).ok().map(|r| (r.id, r.ts))
}

/// Append one JSON line. O_APPEND keeps concurrent writes line-atomic, which is what lets the agent
/// (writing acks) and the app (writing messages) share a directory without a lock.
fn append_jsonl<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("inbox mkdir: {e}"))?;
    }
    let line = serde_json::to_string(value).map_err(|e| format!("inbox encode: {e}"))?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("inbox open: {e}"))?;
    // HEAL A TORN TAIL BEFORE APPENDING (sparkle-bbghz). The comment below explains how a pair of
    // writes can interleave into one malformed line; this is that same corruption arriving from the
    // OTHER direction, and it is the one that persists.
    //
    // If a previous append died between its bytes and the process (a crash, a full disk, a killed
    // app), the file ends WITHOUT a newline. `O_APPEND` then places the next record's first byte
    // immediately after the partial one, producing `{torn}{fresh}\n` — a single line that
    // `read_jsonl` skips by contract. So the new message is lost, and `enqueue` still returns
    // `Ok(id)`: the caller is handed a message id, which is exactly the evidence it would use to
    // believe the send happened. That is the silent drop the concierge hit — ok:true with a distinct
    // messageId for five sends, `pending: 0` on three of them.
    //
    // It is also self-perpetuating without this: the tail stays torn, so EVERY later append to that
    // agent is swallowed the same way, and the corruption is per-agent, which is why three of five
    // agents dropped and two did not.
    //
    // Writing the missing newline separates the damage instead of spreading it. A partial line that
    // was in fact complete JSON is recovered outright; one that was genuinely truncated stays a
    // single skipped record rather than eating its successor. Best-effort: a metadata read that
    // fails is not a reason to refuse the send, because `verify_queued` below is the check that
    // actually gates the acknowledgement.
    if std::fs::metadata(path).map(|m| m.len()).unwrap_or(0) > 0 {
        let ends_clean = std::fs::read(path)
            .map(|b| b.last().copied() == Some(b'\n'))
            .unwrap_or(true);
        if !ends_clean {
            f.write_all(b"\n").map_err(|e| format!("inbox heal: {e}"))?;
        }
    }
    // ONE `write` syscall, newline included — this is a correctness requirement, not a style choice.
    //
    // `O_APPEND` makes an individual `write` atomic with respect to the file offset, but it says
    // nothing about a PAIR of writes. `writeln!` issues two (`write_fmt` calls `write_str` once per
    // format piece: the JSON, then the `"\n"`) on an unbuffered `File`, so two concurrent appends to
    // the same agent could interleave as `{a}{b}\n\n` — one malformed line that `read_jsonl` silently
    // skips, losing BOTH messages while both callers were told `Ok(id)`. That is exactly the outcome
    // this module's header calls worse than a refusal: a concierge that believes it delivered
    // something it did not.
    //
    // Concurrency here is new: until the commands became `async` + `spawn_blocking`, every app-side
    // append was serialized by the main thread, so the single-syscall requirement did not bite. It
    // does now, and the agent's own `Stop` hook has always appended acks from a separate process.
    f.write_all(format!("{line}\n").as_bytes()).map_err(|e| format!("inbox write: {e}"))
}

/// Messages still worth delivering: not expired, not already claimed.
pub fn pending(app_data: &Path, agent_id: &str, now: i64) -> Vec<InboxMessage> {
    if refuse_escape("pending", agent_id) {
        return Vec::new();
    }
    let claims = claims_dir(app_data, agent_id);
    read_jsonl::<InboxMessage>(&messages_path(app_data, agent_id))
        .into_iter()
        .filter(|m| now.saturating_sub(m.ts) <= MAX_AGE_MS)
        .filter(|m| !is_claimed(&claims, &m.id))
        .collect()
}

/// Queue a message. Returns its id.
///
/// Refuses rather than evicts when full: see `MAX_PER_AGENT`.
pub fn enqueue(
    app_data: &Path,
    agent_id: &str,
    text: &str,
    severity: Severity,
    from: &str,
    now: i64,
    id: String,
) -> Result<String, String> {
    validate_agent_id(agent_id)?;
    let text = text.trim();
    if text.is_empty() {
        return Err("inbox: refusing to queue an empty message".into());
    }
    if pending(app_data, agent_id, now).len() >= MAX_PER_AGENT {
        return Err(format!(
            "inbox: {agent_id} already has {MAX_PER_AGENT} undelivered messages; \
             it is not draining them — check its Level 0 verdict before sending more"
        ));
    }
    let msg = InboxMessage {
        id: id.clone(),
        ts: now,
        from: from.to_string(),
        text: text.to_string(),
        severity,
    };
    append_jsonl(&messages_path(app_data, agent_id), &msg)?;

    // READ BACK BEFORE ACKNOWLEDGING (sparkle-bbghz). This is the rule the bug asked for in one
    // line: *"inbox_send must not return ok unless the message is actually persisted to that
    // agent's inbox."*
    //
    // WHY A SUCCESSFUL WRITE IS NOT ENOUGH EVIDENCE. `append_jsonl` returning `Ok` proves the bytes
    // left this process. It does not prove they are READABLE as a record, and the gap between those
    // two facts is the entire defect: `read_jsonl` skips malformed lines by contract, so a line that
    // merged with a torn predecessor, or was truncated by a full disk, is written successfully and
    // then does not exist as far as `pending` and `status_of` are concerned. Every downstream loop
    // reads through those two functions, so "written" is the wrong thing to promise — "visible to
    // the reader" is the thing callers actually depend on, and it is what is asserted here.
    //
    // Deliberately re-read through `read_jsonl` at `messages_path`, the exact path and parser
    // `status_of` uses, rather than a cheaper stat or a byte search. A check that agreed with the
    // writer instead of with the reader would re-open the same hole one layer down.
    //
    // COST: one extra read of a file this function has already read once for the capacity check, so
    // it is warm. A send is a rare event — the Pusher is bounded to four per agent per hour — and a
    // silent drop costs a whole cycle of a watchdog reporting agents it never reached.
    let readable = read_jsonl::<InboxMessage>(&messages_path(app_data, agent_id))
        .iter()
        .any(|m| m.id == id);
    if !readable {
        return Err(format!(
            "inbox: wrote message {id} to {agent_id}'s queue but could not read it back — \
             treating this send as FAILED rather than returning an id for a message that \
             does not exist"
        ));
    }

    Ok(id)
}

/// Delivery/ack counts for one agent.
///
/// Fails CLOSED on an id that would escape the inbox dir — see [`refuse_escape`]. The loud refusal
/// belongs to `inbox_status`, which rejects the whole batch before the thread hop; this is the
/// backstop that keeps the guarantee if that line is ever removed, and that covers any future caller
/// of this `pub` fn which never had one.
pub fn status_of(app_data: &Path, agent_id: &str, now: i64) -> InboxStatus {
    if refuse_escape("status_of", agent_id) {
        return InboxStatus {
            agent_id: agent_id.to_string(),
            pending: 0,
            delivered: 0,
            acknowledged: 0,
            awaiting_ack: 0,
            pending_ids: Vec::new(),
        };
    }
    let claims = claims_dir(app_data, agent_id);
    let msgs = read_jsonl::<InboxMessage>(&messages_path(app_data, agent_id));
    let acks = read_jsonl::<InboxAck>(&acks_path(app_data, agent_id));
    let acked: std::collections::HashSet<&str> = acks.iter().map(|a| a.id.as_str()).collect();

    let mut pending_ids = Vec::new();
    let (mut pending_n, mut delivered, mut acknowledged) = (0u32, 0u32, 0u32);
    for m in &msgs {
        // A record whose id cannot be a claim file name is counted in NO column.
        //
        // `is_claimed` fails closed to `true` for such an id, which is right for `pending` (the
        // record drops out of the delivery set) and wrong here: `true` would land it in `delivered`,
        // and `awaiting_ack` is `delivered - acknowledged`, so it would sit at >= 1 for the life of
        // the record — the expiry check below is only reached on the `else`, and no ack can ever
        // arrive for a message that is undeliverable by construction. That is a permanent phantom
        // "this agent is not reaching turn boundaries" signal to the concierge, which is the exact
        // failure shape `retention` documents as unacceptable. Skipping is the honest answer: the
        // record is not pending, and it was never delivered.
        if refuse_escape("status_of record", &m.id) {
            continue;
        }
        let expired = now.saturating_sub(m.ts) > MAX_AGE_MS;
        let claimed = is_claimed(&claims, &m.id);
        if acked.contains(m.id.as_str()) {
            acknowledged += 1;
        }
        if claimed {
            delivered += 1;
        } else if !expired {
            pending_n += 1;
            pending_ids.push(m.id.clone());
        }
    }
    InboxStatus {
        agent_id: agent_id.to_string(),
        pending: pending_n,
        delivered,
        acknowledged,
        // Saturating: an ack for a message whose claim file was reaped must not underflow.
        awaiting_ack: delivered.saturating_sub(acknowledged),
        pending_ids,
    }
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    crate::dev_identity::app_data_dir(app)
}

/// Queue one message for one agent. Non-interrupting: the agent sees it at its next turn boundary.
///
/// EVERY COMMAND IN THIS SECTION IS `async` + `spawn_blocking`, AND THAT IS LOAD-BEARING — it is what
/// keeps the concierge's own control surface alive while this path runs.
///
/// The rule is `hooks.rs`'s: a sync `#[tauri::command]` runs on the MAIN THREAD. The consequence is
/// specific to this module rather than general tidiness, because of who calls it and who else needs
/// that thread:
///
/// - `services/fleetWatch.ts` polls on a ~10s timer and calls `inbox_status` for every idle candidate,
///   then `inbox_claim_for_idle` per delivery. So this is not an occasional user-initiated command; it
///   is a recurring background beat.
/// - Every one of these does real blocking filesystem work — `status_of` and `pending` read each
///   agent's whole `<id>.jsonl` and `<id>.acks.jsonl`, and `claim` does a `create_dir_all` plus one
///   `O_EXCL` open per message. At 64 agents that is a lot of syscalls per beat.
/// - `concierge_tool` — every control read and write the concierge makes — is a FRONTEND ROUND-TRIP
///   (`bridge.rs`): the bridge emits `control:request` and blocks until the React layer answers, which
///   it can only do while the main thread's event loop is turning.
///
/// Sync commands here therefore put a recurring, unbounded-by-design disk workload directly in front
/// of the concierge's ability to read or write ANY agent terminal, and the symptom is
/// `bridge request timeout: concierge_tool` — the control surface going dark exactly when a human is
/// trying to find out what went wrong. A stuck or slow inbox read must never be able to do that: the
/// control surface has to survive one stuck thread. Do not make these synchronous again.
#[tauri::command]
pub async fn inbox_send(
    app: AppHandle,
    agent_id: String,
    text: String,
    severity: Option<Severity>,
) -> Result<String, String> {
    let base = app_data(&app)?;
    let sev = severity.unwrap_or(Severity::Fyi);
    tauri::async_runtime::spawn_blocking(move || {
        enqueue(&base, &agent_id, &text, sev, "concierge", now_ms(), uuid_v4())
    })
    .await
    .map_err(|e| format!("inbox_send task failed: {e}"))?
}

/// Queue the same message for many agents. Returns per-agent outcome — a partial failure names the
/// agents it failed for rather than failing the whole broadcast, so one full inbox cannot silently
/// prevent the other 63 deliveries.
/// `async` + `spawn_blocking` for the reason given on [`inbox_send`]. This one is the worst case of
/// the four: a fleet-wide broadcast does one `enqueue` — read, append, fsync-ish — PER AGENT in a
/// single call, so at 64 agents a synchronous version parks the main thread for the whole fan-out and
/// the concierge cannot read or write any terminal until it finishes.
#[tauri::command]
pub async fn inbox_broadcast(
    app: AppHandle,
    agent_ids: Vec<String>,
    text: String,
    severity: Option<Severity>,
) -> Result<Vec<BroadcastOutcome>, String> {
    let base = app_data(&app)?;
    let sev = severity.unwrap_or(Severity::Fyi);
    let now = now_ms();
    tauri::async_runtime::spawn_blocking(move || {
        agent_ids
            .into_iter()
            .map(|agent_id| match enqueue(&base, &agent_id, &text, sev, "concierge", now, uuid_v4()) {
                Ok(id) => BroadcastOutcome { agent_id, message_id: Some(id), error: None },
                Err(e) => BroadcastOutcome { agent_id, message_id: None, error: Some(e) },
            })
            .collect()
    })
    .await
    .map_err(|e| format!("inbox_broadcast task failed: {e}"))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastOutcome {
    pub agent_id: String,
    pub message_id: Option<String>,
    pub error: Option<String>,
}

/// Delivery and ack state for the named agents.
///
/// `async` + `spawn_blocking` for the reason given on [`inbox_send`]. This is the one `fleetWatch`
/// calls on EVERY tick, so it is the command most likely to be holding the main thread when the
/// concierge needs it — and `status_of` reads two whole files per agent to build its counts.
#[tauri::command]
pub async fn inbox_status(
    app: AppHandle,
    agent_ids: Vec<String>,
) -> Result<Vec<InboxStatus>, String> {
    // Validate BEFORE the thread hop, the invariant the rest of this module states. This was the one
    // command not covered: `inbox_send`/`inbox_broadcast` validate inside `enqueue`, and
    // `inbox_claim_for_idle` validates explicitly, but `status_of` reaches `messages_path`/`acks_path`/
    // `claims_dir` with the id unchecked. These ids arrive as concierge TOOL ARGUMENTS — LLM-controlled,
    // not trusted UI state — so a traversal-shaped id like `../../../../etc/hosts` resolved outside the
    // inbox dir and the returned counts made it a probe for any `*.jsonl` file's existence and shape.
    validate_all(&agent_ids)?;
    let base = app_data(&app)?;
    let now = now_ms();
    tauri::async_runtime::spawn_blocking(move || {
        agent_ids.iter().map(|id| status_of(&base, id, now)).collect()
    })
    .await
    .map_err(|e| format!("inbox_status task failed: {e}"))
}

/// Messages the app-side idle path should deliver, and the claim it must win first.
///
/// Returns only messages this call successfully CLAIMED, so the caller may deliver every message it
/// gets back without re-checking. A message the `Stop` hook claimed first simply is not returned.
/// `async` + `spawn_blocking` for the reason given on [`inbox_send`]. `validate_agent_id` runs BEFORE
/// the thread hop, matching `fleet_read_hook_stream`: a crafted id is rejected without ever occupying
/// a blocking-pool slot.
#[tauri::command]
pub async fn inbox_claim_for_idle(
    app: AppHandle,
    agent_id: String,
) -> Result<Vec<InboxMessage>, String> {
    validate_agent_id(&agent_id)?;
    let base = app_data(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let claims = claims_dir(&base, &agent_id);
        pending(&base, &agent_id, now_ms())
            .into_iter()
            .filter(|m| claim(&claims, &m.id))
            .collect()
    })
    .await
    .map_err(|e| format!("inbox_claim_for_idle task failed: {e}"))
}

/// Minimal RFC-4122-shaped v4 uuid. Avoids adding a dependency for the one place we mint ids.
fn uuid_v4() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut bytes = [0u8; 16];
    for chunk in bytes.chunks_mut(8) {
        // RandomState is seeded per-process from the OS; hashing a fresh nanosecond keeps
        // successive calls distinct.
        let mut h = RandomState::new().build_hasher();
        h.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        let v = h.finish().to_ne_bytes();
        chunk.copy_from_slice(&v[..chunk.len()]);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let h = |r: &[u8]| r.iter().map(|b| format!("{b:02x}")).collect::<String>();
    format!(
        "{}-{}-{}-{}-{}",
        h(&bytes[0..4]),
        h(&bytes[4..6]),
        h(&bytes[6..8]),
        h(&bytes[8..10]),
        h(&bytes[10..16])
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sparkle-inbox-{tag}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn send(base: &Path, agent: &str, text: &str, now: i64, id: &str) -> Result<String, String> {
        enqueue(base, agent, text, Severity::Fyi, "concierge", now, id.to_string())
    }

    #[test]
    fn a_queued_message_is_pending_until_claimed_then_delivered() {
        let base = tmp("lifecycle");
        send(&base, "a1", "main has moved, rebase before verifying", 1_000, "m1").unwrap();

        let s = status_of(&base, "a1", 1_000);
        assert_eq!((s.pending, s.delivered, s.acknowledged), (1, 0, 0));
        assert_eq!(s.pending_ids, vec!["m1".to_string()]);

        assert!(claim(&claims_dir(&base, "a1"), "m1"));
        let s = status_of(&base, "a1", 1_000);
        assert_eq!(
            (s.pending, s.delivered, s.acknowledged, s.awaiting_ack),
            (0, 1, 0, 1),
            "claiming moves it from pending to delivered and starts awaiting an ack"
        );

        append_jsonl(&acks_path(&base, "a1"), &InboxAck { id: "m1".into(), ts: 1_100, note: None })
            .unwrap();
        let s = status_of(&base, "a1", 1_000);
        assert_eq!((s.delivered, s.acknowledged, s.awaiting_ack), (1, 1, 0));

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn a_torn_tail_does_not_swallow_the_next_message(){
        // THE SILENT DROP, REPRODUCED (sparkle-bbghz). A previous append that died between its bytes
        // and the process leaves the file without a trailing newline. `O_APPEND` then writes the
        // next record flush against it, `read_jsonl` sees one malformed line and skips it by
        // contract, and BOTH records are gone — while `enqueue` hands back a message id.
        //
        // Asserts the SIDE EFFECT (the message is readable afterwards), not the precondition: before
        // the heal, `status_of` reported pending 0 here with `send` having returned `Ok("m2")`,
        // which is exactly what the concierge saw on three of five agents.
        let base = tmp("torn-tail");
        let path = messages_path(&base, "a1");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"id":"m1","ts":1000,"from":"concierge","text":"first","severity":"fyi"}"#,
        )
        .unwrap();

        let id = send(&base, "a1", "second", 1_000, "m2").expect("the send is accepted");
        assert_eq!(id, "m2");

        let s = status_of(&base, "a1", 1_000);
        assert!(
            s.pending_ids.contains(&"m2".to_string()),
            "the appended message must be READABLE, not merged into the torn line: {:?}",
            s.pending_ids
        );
        assert_eq!(
            s.pending, 2,
            "healing the tail also recovers the partial record that was only missing its newline"
        );

        std::fs::remove_dir_all(&base).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_write_that_cannot_be_read_back_is_reported_as_a_failure_not_as_an_id() {
        // The rule sparkle-bbghz asked for: never return ok for a message that does not exist.
        //
        // `/dev/null` is the deterministic form of "the write succeeded and the record is not
        // there" — `write_all` returns `Ok`, and every reader (`pending`, `status_of`, the Stop
        // hook) sees an empty queue. Before the read-back this returned `Ok("m1")`, handing the
        // caller the one piece of evidence it uses to believe a send happened.
        let base = tmp("unreadable");
        let path = messages_path(&base, "a1");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink("/dev/null", &path).unwrap();

        let err = send(&base, "a1", "into the void", 1_000, "m1")
            .expect_err("a send whose message cannot be read back must FAIL");
        assert!(err.contains("read it back"), "the failure must say why: {err}");

        assert_eq!(
            status_of(&base, "a1", 1_000).pending,
            0,
            "and the queue really is empty — the refusal is telling the truth"
        );

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn only_one_claimant_wins_so_the_two_delivery_paths_cannot_double_send() {
        // This is the whole reason claims exist: the Stop hook and the app-side idle path race.
        let base = tmp("claim-race");
        let claims = claims_dir(&base, "a1");
        assert!(claim(&claims, "m1"), "first claimant wins");
        assert!(!claim(&claims, "m1"), "second claimant must lose");
        assert!(!claim(&claims, "m1"), "and stay losing");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn a_claimed_message_is_no_longer_pending_which_is_the_hook_loop_guard() {
        // The Stop hook claims BEFORE it asks Claude to continue. If claiming did not remove the
        // message from `pending`, the next Stop would block again, forever.
        let base = tmp("loop-guard");
        send(&base, "a1", "hello", 1_000, "m1").unwrap();
        assert_eq!(pending(&base, "a1", 1_000).len(), 1);
        claim(&claims_dir(&base, "a1"), "m1");
        assert!(pending(&base, "a1", 1_000).is_empty(), "a second Stop must find nothing to do");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn idle_claim_returns_only_what_it_won() {
        let base = tmp("idle-claim");
        send(&base, "a1", "one", 1_000, "m1").unwrap();
        send(&base, "a1", "two", 1_000, "m2").unwrap();
        // The hook got there first for m1.
        claim(&claims_dir(&base, "a1"), "m1");

        let claims = claims_dir(&base, "a1");
        let won: Vec<InboxMessage> = pending(&base, "a1", 1_000)
            .into_iter()
            .filter(|m| claim(&claims, &m.id))
            .collect();
        assert_eq!(won.len(), 1);
        assert_eq!(won[0].id, "m2", "must not re-deliver the hook's message");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn an_expired_message_stops_being_pending() {
        let base = tmp("ttl");
        send(&base, "a1", "stale news", 1_000, "m1").unwrap();
        assert_eq!(pending(&base, "a1", 1_000).len(), 1);
        assert!(
            pending(&base, "a1", 1_000 + MAX_AGE_MS + 1).is_empty(),
            "a rebase instruction is actively misleading a day later"
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn a_full_inbox_refuses_rather_than_dropping_the_oldest() {
        // A concierge that believes it delivered something it did not is worse than one told no.
        let base = tmp("full");
        for i in 0..MAX_PER_AGENT {
            send(&base, "a1", "msg", 1_000, &format!("m{i}")).unwrap();
        }
        let err = send(&base, "a1", "one too many", 1_000, "overflow").unwrap_err();
        assert!(err.contains("not draining"), "got: {err}");
        // And the refusal did not corrupt what was already queued.
        assert_eq!(pending(&base, "a1", 1_000).len(), MAX_PER_AGENT);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn empty_and_whitespace_messages_are_refused() {
        let base = tmp("empty");
        assert!(send(&base, "a1", "", 1_000, "m1").is_err());
        assert!(send(&base, "a1", "   \n ", 1_000, "m2").is_err());
        assert!(pending(&base, "a1", 1_000).is_empty());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn a_malicious_agent_id_cannot_escape_the_inbox_dir() {
        let base = tmp("traversal");
        for bad in ["../escape", "..", "a/b", "a\\b", "", "a\0b"] {
            assert!(send(&base, bad, "x", 1_000, "m").is_err(), "{bad:?} must be refused");
        }
        // Nothing was written outside the inbox dir by any of them.
        assert!(!base.join("escape.jsonl").exists());
        // And a legitimate id still works, so the guard is not simply refusing everything.
        assert!(send(&base, "a1", "x", 1_000, "m").is_ok());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn malformed_lines_are_skipped_without_making_the_inbox_unreadable() {
        let base = tmp("malformed");
        send(&base, "a1", "good", 1_000, "m1").unwrap();
        // A torn write, as a crash mid-append would leave.
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(messages_path(&base, "a1"))
            .unwrap();
        writeln!(f, "{{\"id\":\"broken\",").unwrap();
        drop(f);
        send(&base, "a1", "also good", 1_000, "m2").unwrap();

        let p = pending(&base, "a1", 1_000);
        assert_eq!(p.len(), 2, "the torn line is skipped, the good ones survive");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn status_of_an_agent_with_no_inbox_is_all_zero_not_an_error() {
        let base = tmp("absent");
        let s = status_of(&base, "never-messaged", 1_000);
        assert_eq!((s.pending, s.delivered, s.acknowledged, s.awaiting_ack), (0, 0, 0, 0));
        assert!(s.pending_ids.is_empty());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn awaiting_ack_never_underflows() {
        // An ack whose claim file was reaped would otherwise wrap a u32.
        let base = tmp("underflow");
        send(&base, "a1", "x", 1_000, "m1").unwrap();
        append_jsonl(&acks_path(&base, "a1"), &InboxAck { id: "m1".into(), ts: 1_100, note: None })
            .unwrap();
        let s = status_of(&base, "a1", 1_000);
        assert_eq!(s.acknowledged, 1);
        assert_eq!(s.awaiting_ack, 0, "must saturate, not wrap");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn the_inbox_lives_outside_the_worktree_so_it_survives_spin_down() {
        // spin_down_worker deletes the worktree; an inbox under .sparkle/ would go with it, taking
        // the record of whether the message was ever read.
        let base = Path::new("/app-data");
        assert_eq!(messages_path(base, "a1"), Path::new("/app-data/inbox/a1.jsonl"));
        assert!(!messages_path(base, "a1").to_string_lossy().contains("worktrees"));
    }

    #[test]
    fn uuids_are_distinct_and_well_shaped() {
        let a = uuid_v4();
        let b = uuid_v4();
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
        assert_eq!(a.chars().filter(|c| *c == '-').count(), 4);
        assert_eq!(&a[14..15], "4", "version nibble");
        assert!(matches!(&a[19..20], "8" | "9" | "a" | "b"), "variant nibble: {}", &a[19..20]);
    }

    #[test]
    fn severity_round_trips_as_lowercase_on_the_wire() {
        let m = InboxMessage {
            id: "m1".into(),
            ts: 1,
            from: "concierge".into(),
            text: "x".into(),
            severity: Severity::Act,
        };
        let json = serde_json::to_string(&m).unwrap();
        assert!(json.contains(r#""severity":"act""#), "got: {json}");
        assert_eq!(serde_json::from_str::<InboxMessage>(&json).unwrap(), m);
    }

    /// The BATCH half of the traversal guard: `inbox_status` must refuse a whole batch, not serve the good
    /// ids and drop the bad one, and must do it before the thread hop so a crafted id never occupies a
    /// blocking-pool slot.
    ///
    /// Scoped deliberately: this covers all-or-nothing batch semantics ONLY. It exercises `validate_all`
    /// in isolation, and `validate_all` is a loop over the pre-existing `validate_agent_id` — so on its
    /// own it would pass against the code as it stood BEFORE the traversal was closed, which proves
    /// nothing about the traversal. The test that proves the traversal is shut is
    /// `the_read_sinks_refuse_a_traversal_id_and_read_nothing_outside_the_inbox_dir`, which asserts the
    /// side effect (no file outside the inbox dir is read) instead of the validator.
    #[test]
    fn a_status_batch_containing_a_traversal_id_is_refused_whole() {
        // The positive control comes first: a legitimate batch must still pass, or this test would also
        // pass against a helper that refuses everything.
        assert!(validate_all(&["agent-1".to_string(), "agent-2".to_string()]).is_ok());

        for bad in ["../../../../etc/hosts", "a/b", "..", "", "x\0y"] {
            let batch = vec!["agent-1".to_string(), bad.to_string()];
            assert!(
                validate_all(&batch).is_err(),
                "a batch containing {bad:?} must be refused whole, not partly served"
            );
        }
    }

    /// The claim sinks take the MESSAGE id — the one path join in this module that was unguarded —
    /// and must not touch the filesystem outside the claims dir.
    ///
    /// Asserts the side effect, not the validator: the test names the exact file an unguarded
    /// `claim` creates (`<claims>/../escaped`) and asserts it does not appear. Removing either
    /// `refuse_escape` makes that file exist and flips the assertion, so this cannot pass on the
    /// pre-fix code. The message id is untrusted for the same reason the agent id is — it is parsed
    /// back out of the JSONL by `read_jsonl`, which imposes no shape on the `id` field — so the
    /// fixture plants such a record and drives it through `pending`, the real caller.
    #[test]
    fn the_claim_sinks_refuse_a_traversal_message_id_and_write_nothing_outside_the_claims_dir() {
        let base = tmp("claim-escape");
        let claims = claims_dir(&base, "a1");
        std::fs::create_dir_all(&claims).unwrap();
        let escaped = claims.join("..").join("escaped");

        assert!(!claim(&claims, "../escaped"), "a traversal-shaped id must not be claimable");
        assert!(
            !escaped.exists(),
            "claim wrote {} — a message id reached a path join outside the claims dir",
            escaped.display()
        );
        assert!(
            is_claimed(&claims, "../escaped"),
            "a traversal-shaped id must read as already-claimed so it is never delivered"
        );

        // Positive control: the guard is what refuses above, not a broken fixture — a well-formed id
        // claims once, creates its marker INSIDE the claims dir, and then reads as claimed.
        assert!(claim(&claims, "m1"), "a well-formed id must still claim");
        assert!(claims.join("m1").exists());
        assert!(is_claimed(&claims, "m1"));
        assert!(!claim(&claims, "m1"), "the second claimant must still lose");

        // And through the real caller: a planted record whose id would escape is not offered for
        // delivery, while a normal record beside it still is.
        let line = |id: &str| {
            serde_json::to_string(&InboxMessage {
                id: id.into(),
                ts: 1_000,
                from: "concierge".into(),
                text: "x".into(),
                severity: Severity::Fyi,
            })
            .unwrap()
        };
        std::fs::write(messages_path(&base, "a2"), format!("{}\n{}\n", line("../escaped2"), line("ok1")))
            .unwrap();
        let ids: Vec<String> = pending(&base, "a2", 1_000).into_iter().map(|m| m.id).collect();
        assert_eq!(ids, vec!["ok1".to_string()], "a traversal-shaped record must not be pending");
        assert!(
            !claims_dir(&base, "a2").join("..").join("escaped2").exists(),
            "no claim marker may be created outside the claims dir"
        );

        // And it must be counted in NO column. `is_claimed` fails closed to true, so a `status_of`
        // that asked it directly would report the record as delivered and leave `awaiting_ack` at 1
        // forever — a permanent "not reaching turn boundaries" signal for a message that is
        // undeliverable by construction. One legitimate record beside it still counts as pending, so
        // a `status_of` that skipped everything would not pass either.
        let s = status_of(&base, "a2", 1_000);
        assert_eq!(
            (s.pending, s.delivered, s.awaiting_ack),
            (1, 0, 0),
            "a traversal-shaped record must be neither pending nor delivered"
        );
        assert_eq!(s.pending_ids, vec!["ok1".to_string()]);
    }

    /// The SINK half, and the one that actually proves the traversal is shut: a read sink handed a
    /// traversal-shaped id must read NOTHING outside the inbox dir.
    ///
    /// Asserts the side effect, not the validator. The fixture plants a real, well-formed message at
    /// exactly the path an UNGUARDED `status_of`/`pending` resolves to — one directory above the inbox
    /// — so deleting either guard makes this test report the planted record instead of zero. That is
    /// the property the command-layer check cannot carry on its own: it is one deletable line, and
    /// both sinks are `pub` fns taking a bare `&str`.
    #[test]
    fn the_read_sinks_refuse_a_traversal_id_and_read_nothing_outside_the_inbox_dir() {
        let base = tmp("escape");
        let escaping = "../evil";
        std::fs::create_dir_all(inbox_dir(&base)).unwrap();

        let record = serde_json::to_string(&InboxMessage {
            id: "leaked".into(),
            ts: 1_000,
            from: "somewhere-else".into(),
            text: "a record from outside the inbox".into(),
            severity: Severity::Fyi,
        })
        .unwrap();

        // The plant lands where an unguarded read would look: `<base>/inbox/../evil.jsonl`.
        let planted = messages_path(&base, escaping);
        std::fs::write(&planted, format!("{record}\n")).unwrap();
        assert_eq!(
            planted.parent().unwrap().canonicalize().unwrap(),
            base.canonicalize().unwrap(),
            "the fixture must sit OUTSIDE the inbox dir or this test proves nothing"
        );

        // Positive control: those same bytes ARE readable through a legitimate id, so the zeros below
        // are the guard refusing — not an unreadable fixture or a record that fails to parse.
        std::fs::write(messages_path(&base, "a1"), format!("{record}\n")).unwrap();
        assert_eq!(status_of(&base, "a1", 1_000).pending, 1, "fixture must be readable via a valid id");
        assert_eq!(pending(&base, "a1", 1_000).len(), 1);

        let s = status_of(&base, escaping, 1_000);
        assert_eq!(
            (s.pending, s.delivered, s.acknowledged, s.awaiting_ack),
            (0, 0, 0, 0),
            "status_of read {} — the counts are a probe for any *.jsonl on disk",
            planted.display()
        );
        assert!(s.pending_ids.is_empty(), "leaked ids out of {}", planted.display());
        assert!(
            pending(&base, escaping, 1_000).is_empty(),
            "pending read {}",
            planted.display()
        );

        std::fs::remove_dir_all(&base).ok();
    }

    /// Scan Rust source for `#[tauri::command]` fns, returning `(total_commands, sync_signatures)`.
    ///
    /// Extracted so the guard and its anti-vacuity test exercise the SAME code. A previous version
    /// re-implemented the loop inside the negative test, which meant the two could drift and the
    /// negative test would keep passing while the real guard rotted — proving nothing about the guard
    /// actually in use.
    fn tauri_commands_in(src: &str) -> (usize, Vec<String>) {
        let lines: Vec<&str> = src.lines().collect();
        let mut total = 0usize;
        let mut sync = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            // `starts_with`, not equality: `#[tauri::command(async)]`, `#[tauri::command(rename_all =
            // "snake_case")]` and friends are all commands, and an exact-match matcher would skip them
            // and pass having matched nothing.
            if !line.trim().starts_with("#[tauri::command") {
                continue;
            }
            let Some(sig) = lines[i..].iter().find(|l| l.contains("fn ")) else {
                continue;
            };
            total += 1;
            if !sig.contains("async fn") {
                sync.push(sig.trim().to_string());
            }
        }
        (total, sync)
    }

    /// EVERY `#[tauri::command]` in this module must be `pub async fn`, because a sync Tauri command
    /// runs on the MAIN THREAD and `concierge_tool` — every control read and write the concierge makes
    /// — is a frontend round-trip that needs that thread's event loop to answer. `services/fleetWatch`
    /// drives `inbox_status`/`inbox_claim_for_idle` on a ~10s beat, so a synchronous command here puts
    /// recurring blocking disk I/O directly in front of the concierge's ability to see or talk to any
    /// agent. The observed symptom of that starvation is `bridge request timeout: concierge_tool`.
    ///
    /// Asserted against this file's own SOURCE because there is no runtime handle to check: the defect
    /// is a missing `async` keyword, invisible to every behavioural test, and it was the actual shape
    /// of the original bug (all four commands shipped sync).
    #[test]
    fn every_tauri_command_here_runs_off_the_main_thread() {
        let (total, sync_cmds) = tauri_commands_in(include_str!("inbox.rs"));
        // POSITIVE assertion first, so "the matcher found nothing" FAILS instead of passing silently.
        // Without it, renaming the attribute, moving these commands to a submodule, or writing the
        // attribute inline with the fn would all turn this guard into a no-op that stays green — the
        // "assertion already true before the change" shape that is this repo's #1 finding.
        assert!(
            total >= 4,
            "expected at least the 4 inbox commands (send/broadcast/status/claim_for_idle), found \
             {total} — the scanner matched nothing, so this guard is not guarding anything"
        );
        assert!(
            sync_cmds.is_empty(),
            "these inbox commands are synchronous, so they run on the main thread and can starve \
             the concierge control bridge (bridge request timeout: concierge_tool). Make them \
             `pub async fn` + `tauri::async_runtime::spawn_blocking`: {sync_cmds:#?}"
        );
    }

    /// The guard is only meaningful if its scanner can actually SEE a sync command. This feeds the REAL
    /// scanner the shape it must reject, so a green guard means "all async" rather than "matched
    /// nothing". Also pins the attribute-with-arguments form, which an exact-match matcher missed.
    #[test]
    fn the_async_guard_would_notice_a_sync_command() {
        let sample = "#[tauri::command]\npub fn inbox_regressed(app: AppHandle) -> Result<(), String> {\n";
        let (total, sync) = tauri_commands_in(sample);
        assert_eq!(total, 1, "scanner must see the command");
        assert_eq!(sync.len(), 1, "scanner must flag it as sync: {sync:?}");

        // An async command with attribute ARGUMENTS is still a command, and must not be flagged.
        let ok = "#[tauri::command(rename_all = \"snake_case\")]\npub async fn fine(app: AppHandle) {\n";
        let (total_ok, sync_ok) = tauri_commands_in(ok);
        assert_eq!(total_ok, 1, "attribute with args must still be counted");
        assert!(sync_ok.is_empty(), "async command must not be flagged: {sync_ok:?}");
    }

    /// The concurrency this module only gained when its commands became `async` + `spawn_blocking`:
    /// before that, every app-side append was serialized by the main thread. N threads enqueue for the
    /// SAME agent and every message must come back whole.
    ///
    /// This is the test that fails against a `writeln!`-based append: two writes per record under
    /// `O_APPEND` interleave as `{a}{b}\n\n`, `read_jsonl` skips the malformed line, and BOTH messages
    /// vanish while both callers were told `Ok(id)`.
    #[test]
    fn concurrent_enqueues_for_one_agent_all_survive_intact() {
        let tmp = std::env::temp_dir().join(format!("sparkle-inbox-conc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        const N: usize = 24;
        let now = now_ms();
        std::thread::scope(|scope| {
            for i in 0..N {
                let base = tmp.clone();
                scope.spawn(move || {
                    // Distinct bodies and ids so a lost or merged record is identifiable, not masked
                    // by every message looking alike.
                    let text = format!("message-{i}-{}", "x".repeat(i * 7));
                    enqueue(&base, "agent-1", &text, Severity::Fyi, "concierge", now, format!("m{i}"))
                        .expect("enqueue");
                });
            }
        });

        let got = pending(&tmp, "agent-1", now);
        assert_eq!(got.len(), N, "every concurrent enqueue must survive as its own record");
        let mut ids: Vec<&str> = got.iter().map(|m| m.id.as_str()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), N, "no id may be lost or duplicated");
        for m in &got {
            assert!(m.text.starts_with("message-"), "record body was corrupted: {:?}", m.text);
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
