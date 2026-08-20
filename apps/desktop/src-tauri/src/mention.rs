//! Cross-agent + human @mention channel (bead sparkle-hdlhox).
//!
//! WHAT THIS IS. Two well-known handles — `@improve` (the Improve Sparkle agent) and `@sparkle`
//! (the concierge) — can be @mentioned by each other or by a human (from the compose window). A
//! mention is routed to the target, and the target is WOKEN so its reply is timely. Their two agent
//! namespaces are genuinely disjoint (neither can address the other directly), so this rides ONLY on
//! infrastructure that already exists: the beads store (shared, founder-visible, polled every 5s),
//! the Level-2 inbox (`inbox.rs`), and the existing one-shot `claude -p` / concierge-turn spawn
//! seams. It adds NO server, daemon, or polling process — the only added cost is tokens.
//!
//! FOUR RULES THIS MODULE ENFORCES, each a correctness property rather than a nicety:
//!
//! 1. BEADS IS THE MESSAGE; THE INBOX IS ONLY A DOORBELL. The full message CONTENT lives in a bead
//!    comment on the thread — the one substrate both agents and the founder can read. The inbox
//!    carries only a content-free doorbell ("go read bead X"). The moment content lives only in the
//!    inbox, the founder-visible record diverges from the real conversation, so the inbox never
//!    carries the body. See [`build_doorbell`] (asserts no body) and [`build_content_comment`].
//!
//! 2. SYMMETRIC WAKE — never assume the target is listening. `@improve` is not running between
//!    hourly passes and `@sparkle` is not running between founder turns, so BOTH need an immediate
//!    wake. `@improve` → a scoped one-shot responder is SPAWNED here (Rust). `@sparkle` → the
//!    command emits a wake event the frontend turns into an immediate concierge turn (the concierge
//!    turn is TS-scheduled; Rust cannot resume its session, so the emit is the seam). The doorbell is
//!    the durable delivery; the wake is what makes it timely.
//!
//! 3. DELIVERY IS NOT ACK. `inbox_send` returning `ok` has lied about delivery before (2026-08-14: a
//!    message reported delivered was never seen). So a doorbell is NOT proof of reading. The recipient
//!    posts an ACK bead comment when it actually reads the mention, and the sender treats silence past
//!    a deadline as UNDELIVERED — never as agreement. [`mention_status`] reads the thread and reports
//!    `awaiting_ack` / `acked` / `overdue` from the bead itself, not from the inbox's own ack file.
//!
//! 4. ATTRIBUTION — and the relayGate BLOCK stays a block. `relayGate.ts` BLOCKS a send outright when
//!    it would carry the founder's VERBATIM words to an agent he did not name. This channel does NOT
//!    weaken that to a mere label, and it adds NO path that bypasses it. The rule is structural: a
//!    mention/response between agents is ALWAYS the sending agent's OWN words — the envelope carries
//!    agent-authored content only, attributed to `from`, and is never a vehicle for passing the
//!    founder's verbatim words to an agent he did not address. (A human@compose mention naming
//!    `@improve`/`@sparkle` IS the founder addressing that agent, which relayGate already permits;
//!    agent→agent is the case that must stay paraphrase-only.) The `provenance` marker records that
//!    the body is the sender's own words, so a reader always knows it is agent-authored, not a quote
//!    ([`Provenance`], [`build_content_comment`]).
//!
//! GOVERNANCE. An overruled objection STAYS on the bead, and an initiator who proceeds despite a
//! review STATES on the bead why — so "proceeded anyway" is distinguishable from "never read it".
//! This module cannot enforce prose, but the scoped responder persona ([`build_responder_prompt`])
//! instructs it, and the durable record is the bead thread where it can be audited.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::inbox;

/// The two well-known handles. Lowercase, `@`-stripped.
pub const IMPROVE_HANDLE: &str = "improve";
pub const SPARKLE_HANDLE: &str = "sparkle";

/// The canonical Improve-Sparkle agent id — its inbox id and the id its headless pass drains.
/// MUST match `SPARKLE_CANONICAL_AGENT_ID` in `sparkle_agent.rs` / `sparkle_improve.rs`.
const SPARKLE_CANONICAL_AGENT_ID: &str = "__sparkle_self__";
/// The app-owned Sparkle clone's project id, used to locate the canonical worktree cwd.
const SPARKLE_PROJECT_ID: &str = "sparkle-self";

/// Anti-loop default: how many rounds an `@improve`↔`@sparkle` exchange may run before it is HARD
/// STOPPED. A round is one `mention_send`. Overridable per call and by the `[mention] max_rounds`
/// config knob (the frontend reads config and passes it); this is the floor when neither is given.
pub const DEFAULT_MAX_MENTION_ROUNDS: u32 = 6;

/// Default ACK deadline: how long the sender waits for the recipient's ACK bead comment before
/// [`mention_status`] reports the mention as `overdue` (i.e. treat as UNDELIVERED — retry/surface,
/// never assume delivered). Overridable per call.
pub const DEFAULT_ACK_DEADLINE_MS: i64 = 3 * 60 * 1000;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------------------------
// Identity / addressing
// ---------------------------------------------------------------------------------------------

/// A resolved mention target. The two handles map to two inbox ids and two wake mechanisms.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MentionTarget {
    /// `@improve` — the Improve Sparkle agent. Woken by SPAWNING a scoped responder.
    Improve,
    /// `@sparkle` — the concierge. Woken by emitting a concierge-turn event (frontend-scheduled).
    Sparkle,
}

impl MentionTarget {
    /// The Level-2 inbox id this target drains. `@improve`'s headless pass exports
    /// `SPARKLE_INBOX_AGENT=__sparkle_self__`; `@sparkle`'s turn drains `sparkle:concierge`.
    pub fn inbox_id(self) -> &'static str {
        match self {
            MentionTarget::Improve => SPARKLE_CANONICAL_AGENT_ID,
            // Reuse the concierge's own constant so the two literals cannot drift.
            MentionTarget::Sparkle => crate::concierge_inbox::CONCIERGE_INBOX_ID,
        }
    }

    /// The `@`-less handle string, for rendering.
    pub fn handle(self) -> &'static str {
        match self {
            MentionTarget::Improve => IMPROVE_HANDLE,
            MentionTarget::Sparkle => SPARKLE_HANDLE,
        }
    }
}

/// Resolve one handle string (`"@improve"`, `"improve"`, `"@sparkle"`, `"@concierge"`, any case) to
/// a target, or `None` if it names no known handle. `concierge` is accepted as an alias for
/// `sparkle` because the concierge is addressed both ways in existing copy.
pub fn resolve_handle(raw: &str) -> Option<MentionTarget> {
    let h = raw.trim().trim_start_matches('@').to_ascii_lowercase();
    match h.as_str() {
        IMPROVE_HANDLE => Some(MentionTarget::Improve),
        SPARKLE_HANDLE | "concierge" => Some(MentionTarget::Sparkle),
        _ => None,
    }
}

/// Scan a body of text for `@improve` / `@sparkle` mentions, preserving first-seen order and
/// de-duplicating (a body that names a handle twice wakes it once). Used by the frontend's 5s beads
/// poll to detect mentions inside a NEW bead comment, and to validate a compose-window mention.
///
/// A mention is `@` immediately followed by an ASCII word run; the run is resolved through
/// [`resolve_handle`], so only the two known handles (plus the `concierge` alias) match — a stray
/// `@someone` is ignored rather than mis-routed.
pub fn parse_mentions(text: &str) -> Vec<MentionTarget> {
    let mut out: Vec<MentionTarget> = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'@' {
            let start = i + 1;
            let mut j = start;
            while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_' || bytes[j] == b'-') {
                j += 1;
            }
            if j > start {
                if let Some(t) = resolve_handle(&text[start..j]) {
                    if !out.contains(&t) {
                        out.push(t);
                    }
                }
            }
            i = j.max(start);
        } else {
            i += 1;
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Provenance / attribution (rule 4)
// ---------------------------------------------------------------------------------------------

/// How the body is attributed — ALWAYS the sending agent's own words (this channel never carries the
/// founder's verbatim words agent-to-agent; see the module doc rule 4 and `relayGate.ts`). The two
/// variants only distinguish a direct message from a paraphrase/summary; neither is ever a quote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Provenance {
    /// The sender's OWN message, in its own words, written for the target.
    Own,
    /// The sender's OWN summary/paraphrase of a situation — still the sender's words, never a
    /// verbatim quote of anyone else (the founder included).
    Summary,
}

impl Provenance {
    /// One line stating that the body is the sending agent's own words — so a reader (agent or
    /// founder) always knows it is agent-authored, not a quote of the founder or anyone else.
    fn note(self, from: &str, target: MentionTarget) -> String {
        let t = target.handle();
        match self {
            Provenance::Own => {
                format!("@{from}'s own words, written for @{t} — not a quote of anyone else.")
            }
            Provenance::Summary => format!(
                "@{from}'s own summary for @{t} — the sender's words, NOT a verbatim quote of the \
                 founder or anyone else."
            ),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Message envelope: content comment, doorbell, ACK (rules 1, 3, 4)
// ---------------------------------------------------------------------------------------------

/// The authoritative message — posted as a bead comment on the thread. Carries `from`, the target,
/// the round, and the provenance note, then the body. This is the founder-visible record; the inbox
/// never carries this.
pub fn build_content_comment(
    from: &str,
    target: MentionTarget,
    round: u32,
    max_rounds: u32,
    provenance: Provenance,
    body: &str,
) -> String {
    format!(
        "[@mention → @{t} · from @{from} · round {round}/{max_rounds}]\n\
         provenance: {note}\n\n{body}",
        t = target.handle(),
        note = provenance.note(from, target),
    )
}

/// The DOORBELL — the inbox message. Content-FREE by rule 1: it names the sender, the thread, and the
/// round, and points at the bead. It deliberately does not carry the body; the recipient must read
/// the bead. A test ([`doorbell_carries_no_body`]) pins that the body never leaks in here.
pub fn build_doorbell(from: &str, thread_ref: &str, round: u32, max_rounds: u32) -> String {
    format!(
        "[@mention doorbell · round {round}/{max_rounds}] @{from} mentioned you on bead \
         {thread_ref}. The message is the LATEST comment on that bead — read it there; nothing \
         actionable is in this doorbell. When you have read it, post an ACK comment on \
         {thread_ref} (so the sender knows it arrived), then reply ON THE BEAD."
    )
}

/// The ACK marker a recipient posts once it has READ the mention (rule 3). Round-scoped so a stale
/// ACK from an earlier round cannot satisfy a later one. [`thread_has_ack`] detects it.
pub fn build_ack_comment(handle: &str, round: u32) -> String {
    format!("{} @{handle} — received & read", ack_marker(round))
}

/// The substring [`thread_has_ack`] searches for. Kept as one function so the writer and the reader
/// cannot drift on the marker's exact shape.
fn ack_marker(round: u32) -> String {
    format!("[mention-ack · round {round}]")
}

/// Has the thread been ACKed for this round? Scans the comments for the round-scoped ACK marker.
/// This is the delivery truth the sender trusts — a bead comment the recipient itself wrote — not
/// the inbox's own ack file, which records only that the app injected the doorbell.
pub fn thread_has_ack(comments: &[String], round: u32) -> bool {
    let marker = ack_marker(round);
    comments.iter().any(|c| c.contains(&marker))
}

// ---------------------------------------------------------------------------------------------
// Per-thread round + ack-deadline state (anti-loop, rule 2/3)
// ---------------------------------------------------------------------------------------------

/// Persisted per-thread state: the round counter (anti-loop), whether the exchange has ENDED (cap
/// reached), and the ACK deadline for the latest round.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadState {
    pub round: u32,
    pub ended: bool,
    pub updated_ts: i64,
    /// The round currently awaiting an ACK (0 = none).
    pub awaiting_ack_round: u32,
    /// When the awaiting ACK becomes overdue.
    pub ack_deadline_ts: i64,
}

/// Where per-thread state lives: `<app_data>/inbox/mentions/<thread_ref>.json`. Under the inbox dir
/// (already outside any worktree, so it survives worker spin-down) but in its own subdir so it never
/// collides with an agent id's `<id>.jsonl`.
fn mentions_dir(base: &Path) -> PathBuf {
    inbox::inbox_dir(base).join("mentions")
}

fn state_path(base: &Path, thread_ref: &str) -> PathBuf {
    mentions_dir(base).join(format!("{thread_ref}.json"))
}

/// Reject anything that could escape the mentions dir before it reaches a path join. A bead id
/// (`sparkle-hdlhox`) and a compose thread uuid both pass; `/`, `\`, `..`, NUL do not.
pub fn validate_thread_ref(thread_ref: &str) -> Result<(), String> {
    if thread_ref.is_empty()
        || thread_ref.contains('/')
        || thread_ref.contains('\\')
        || thread_ref.contains("..")
        || thread_ref.contains('\0')
    {
        return Err(format!("mention: invalid thread ref {thread_ref:?}"));
    }
    Ok(())
}

fn read_state(base: &Path, thread_ref: &str) -> ThreadState {
    std::fs::read_to_string(state_path(base, thread_ref))
        .ok()
        .and_then(|raw| serde_json::from_str::<ThreadState>(&raw).ok())
        .unwrap_or_default()
}

fn write_state(base: &Path, thread_ref: &str, st: &ThreadState) -> Result<(), String> {
    let path = state_path(base, thread_ref);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mention state mkdir: {e}"))?;
    }
    let line = serde_json::to_string(st).map_err(|e| format!("mention state encode: {e}"))?;
    std::fs::write(&path, line).map_err(|e| format!("mention state write: {e}"))
}

// ---------------------------------------------------------------------------------------------
// Injectable seams: the thread (beads) store and the responder spawner
// ---------------------------------------------------------------------------------------------

/// The beads-backed thread store, injected so [`route_mention`] and [`status_of`] are unit-testable
/// without a `bd` on PATH. Production impl ([`BdThreadStore`]) delegates to `beads_cmd`.
pub trait ThreadStore {
    /// Post one comment on the thread (the authoritative message, rule 1).
    fn post_comment(&self, thread_ref: &str, text: &str) -> Result<(), String>;
    /// Read the thread's comment bodies (oldest-first), for ACK/round detection (rule 3).
    fn read_comments(&self, thread_ref: &str) -> Result<Vec<String>, String>;
}

/// Production thread store — posts and reads bead comments via the shared `beads_cmd` assembly.
pub struct BdThreadStore {
    pub project_path: String,
}

impl ThreadStore for BdThreadStore {
    fn post_comment(&self, thread_ref: &str, text: &str) -> Result<(), String> {
        crate::beads_cmd::comment_for_mention(&self.project_path, thread_ref, text)
            .map_err(|e| format!("mention: could not post bead comment: {e:?}"))
    }
    fn read_comments(&self, thread_ref: &str) -> Result<Vec<String>, String> {
        crate::beads_cmd::comments_for_mention(&self.project_path, thread_ref)
            .map(|cs| cs.into_iter().map(|c| c.text).collect())
            .map_err(|e| format!("mention: could not read bead comments: {e:?}"))
    }
}

/// The doorbell's inbox message id. See [`doorbell_id::DoorbellId`].
pub use doorbell_id::DoorbellId;

/// A PRIVATE MODULE, and that is the whole mechanism — not decoration.
///
/// A tuple struct's field is private to its MODULE, not its file. `DoorbellId(String)` declared
/// beside `mention_send` therefore left `DoorbellId(thread_for_task.clone())` compiling cleanly at
/// exactly the call site the newtype exists to protect — and that derive-then-wrap form is what a
/// future edit reaching for a "readable" or deterministic id would actually write. Only the
/// transposition form was a type error. Putting the type in its own module makes the field
/// unreachable from `mention_send`, so BOTH forms are compile errors.
mod doorbell_id {
    /// The doorbell's inbox message id — a newtype so no other string can take its place.
    ///
    /// WHY THIS IS A TYPE AND NOT A TEST. `entries_of` — the concierge's only drain path — discards
    /// any record whose id `validate_agent_id` rejects, while `pending` does not. So an id derived
    /// from `thread_ref`, the sender handle, or anything else that can carry `/`, `\`, `..` or NUL
    /// is enqueued, acknowledged to the sender, visible to `pending`, and INVISIBLE to the recipient
    /// that matters: a silent non-delivery. `route_mention` takes thirteen positional arguments,
    /// four of them strings, so that mis-wire was one transposition away — and no test could rule it
    /// out, because a source grep proves only that the mint statement EXISTS and a test that drives
    /// `route_mention` supplies its own id.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct DoorbellId(String);

    impl DoorbellId {
        /// The ONLY way production can make one: a fresh uuid, which `validate_agent_id` always
        /// accepts and which is unique per call — see the uniqueness note on `inbox::enqueue`'s
        /// ack join, where two doorbells sharing an id would let one ACK mark the other delivered.
        pub fn mint() -> Self {
            DoorbellId(crate::inbox::uuid_v4())
        }
        /// Tests may pin a readable id. `#[cfg(test)]`, so no production path can reach it.
        #[cfg(test)]
        pub fn for_test(id: &str) -> Self {
            DoorbellId(id.to_string())
        }
        pub(crate) fn into_inner(self) -> String {
            self.0
        }
    }
}

/// A request to wake `@improve` by spawning a scoped one-shot responder.
#[derive(Debug, Clone, PartialEq)]
pub struct ResponderRequest {
    pub thread_ref: String,
    pub from: String,
    pub round: u32,
    pub max_rounds: u32,
}

/// The outcome of a spawn attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpawnResult {
    /// A responder process was launched.
    Launched,
    /// A responder is already in flight; this doorbell still lands and the running responder (or the
    /// next one / the hourly pass) will read it. Not an error — the message is durable on the bead.
    Busy,
}

/// The wake seam for `@improve`, injected so [`route_mention`] can be tested by asserting the spawn
/// call and its args (the WAKE), rather than only that a handler exists. Removing the `spawn` call
/// from `route_mention` makes [`an_improve_mention_spawns_a_scoped_responder`] fail — the mutation
/// proof of the wake.
pub trait ResponderSpawner {
    fn spawn(&self, req: &ResponderRequest) -> Result<SpawnResult, String>;
}

// ---------------------------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------------------------

/// What one `mention_send` did. Serialized to the frontend.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MentionOutcome {
    pub target: MentionTarget,
    pub round: u32,
    pub max_rounds: u32,
    /// The exchange hit the round cap (or was already ended): nothing was posted, doorbelled, or
    /// woken. The loop is halted.
    pub capped: bool,
    /// True once `capped` has latched the thread ENDED.
    pub ended: bool,
    /// The content comment was posted on the bead (false when `body_on_thread` said it already was,
    /// or when capped).
    pub comment_posted: bool,
    /// A doorbell was enqueued into the target's inbox.
    pub doorbelled: bool,
    /// `@improve` only: a scoped responder was launched (vs. Busy).
    pub spawned: bool,
    /// `@sparkle` only: the caller must emit the concierge wake event (the command does this).
    pub wake_sparkle: bool,
    /// The round awaiting an ACK, and when it goes overdue — the sender's UNDELIVERED signal.
    pub awaiting_ack_round: u32,
    pub ack_deadline_ts: i64,
    /// The doorbell's inbox message id, if one was enqueued.
    pub message_id: Option<String>,
}

/// Route one mention: post the content to the bead (rule 1), doorbell the inbox (content-free),
/// record the ACK deadline (rule 3), and WAKE the target (rule 2) — bounded by the round cap.
///
/// Pure of Tauri: takes the app-data `base`, the two injected seams, and a clock, so the whole
/// deliver→wake→bound flow is unit-testable. The command wrapper resolves `base`, the real seams, and
/// the config-driven cap, then emits the `@sparkle` wake event when `wake_sparkle` is set.
#[allow(clippy::too_many_arguments)]
pub fn route_mention<S: ResponderSpawner, T: ThreadStore>(
    base: &Path,
    target: MentionTarget,
    thread_ref: &str,
    body: &str,
    from: &str,
    provenance: Provenance,
    body_on_thread: bool,
    max_rounds: u32,
    ack_deadline_ms: i64,
    now: i64,
    doorbell_id: DoorbellId,
    spawner: &S,
    threads: &T,
) -> Result<MentionOutcome, String> {
    validate_thread_ref(thread_ref)?;
    if body.trim().is_empty() {
        return Err("mention: refusing to route an empty message".into());
    }
    let from = sanitize_handle_label(from);

    let mut st = read_state(base, thread_ref);

    // ANTI-LOOP (rule 2, the hard stop). A round is one send. Past the cap — or on a thread already
    // ended — nothing is posted, doorbelled, or woken, so the exchange cannot run forever regardless
    // of what either agent tries next. This is enforced HERE, in the one place every send crosses, so
    // it does not depend on the frontend choosing to stop.
    let round = st.round + 1;
    let capped = st.ended || round > max_rounds;
    if capped {
        // Latch ended; record nothing else.
        if !st.ended {
            st.ended = true;
            st.updated_ts = now;
            write_state(base, thread_ref, &st)?;
        }
        return Ok(MentionOutcome {
            target,
            round: st.round,
            max_rounds,
            capped: true,
            ended: true,
            comment_posted: false,
            doorbelled: false,
            spawned: false,
            wake_sparkle: false,
            awaiting_ack_round: st.awaiting_ack_round,
            ack_deadline_ts: st.ack_deadline_ts,
            message_id: None,
        });
    }

    // 1. BEADS IS THE MESSAGE. Post the content (with provenance) on the bead unless the caller says
    //    it is already there (a mention that ORIGINATED as a bead comment the poll detected).
    let mut comment_posted = false;
    if !body_on_thread {
        let content = build_content_comment(&from, target, round, max_rounds, provenance, body);
        threads.post_comment(thread_ref, &content)?;
        comment_posted = true;
    }

    // 2. THE DOORBELL — content-free. Delivery is durable on the bead; this is only the wake signal.
    let doorbell = build_doorbell(&from, thread_ref, round, max_rounds);
    let message_id = inbox::enqueue(
        base,
        target.inbox_id(),
        &doorbell,
        inbox::Severity::Act,
        &from,
        now,
        doorbell_id.into_inner(),
    )?;

    // 3. Record the ACK deadline. `mention_status` reports overdue past this — treat as UNDELIVERED.
    let ack_deadline_ts = now + ack_deadline_ms;
    st.round = round;
    st.ended = false;
    st.updated_ts = now;
    st.awaiting_ack_round = round;
    st.ack_deadline_ts = ack_deadline_ts;
    write_state(base, thread_ref, &st)?;

    // 4. WAKE (rule 2, symmetric). `@improve` is spawned here; `@sparkle` is woken by the command
    //    emitting an event (Rust cannot resume the concierge's session).
    let mut spawned = false;
    let mut wake_sparkle = false;
    match target {
        MentionTarget::Improve => {
            spawned = matches!(
                spawner.spawn(&ResponderRequest {
                    thread_ref: thread_ref.to_string(),
                    from: from.clone(),
                    round,
                    max_rounds,
                })?,
                SpawnResult::Launched
            );
        }
        MentionTarget::Sparkle => {
            wake_sparkle = true;
        }
    }

    Ok(MentionOutcome {
        target,
        round,
        max_rounds,
        capped: false,
        ended: false,
        comment_posted,
        doorbelled: true,
        spawned,
        wake_sparkle,
        awaiting_ack_round: round,
        ack_deadline_ts,
        message_id: Some(message_id),
    })
}

/// Flatten a sender label to one line so it cannot forge structure in the doorbell / content comment.
/// Newlines and control characters become spaces; runs collapse. Mirrors the intent of `inbox.rs`'s
/// `flatten_for_delivery`, applied here because this module builds delivered text of its own.
fn sanitize_handle_label(from: &str) -> String {
    let cleaned: String = from
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let flat = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        "unknown sender".to_string()
    } else {
        flat
    }
}

// ---------------------------------------------------------------------------------------------
// ACK / delivery status (rule 3)
// ---------------------------------------------------------------------------------------------

/// The delivery truth for a thread, read from the BEAD (the recipient's own ACK comment), never from
/// the inbox's ack file. This is what lets a sender tell "seen and dismissed" from "never delivered".
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MentionStatus {
    pub thread_ref: String,
    pub round: u32,
    pub ended: bool,
    /// The round awaiting an ACK (0 = none outstanding).
    pub awaiting_ack_round: u32,
    /// The recipient posted the ACK for the awaited round.
    pub acked: bool,
    /// No ACK, and the deadline has passed — treat as UNDELIVERED (retry / surface).
    pub overdue: bool,
    pub ack_deadline_ts: i64,
}

/// Compute delivery status from persisted thread state + the bead's comments. Pure, so it is tested
/// directly against a comment list rather than a live bead.
pub fn status_of(st: &ThreadState, comments: &[String], now: i64) -> MentionStatus {
    let awaiting = st.awaiting_ack_round;
    let acked = awaiting != 0 && thread_has_ack(comments, awaiting);
    // Overdue only while genuinely awaiting an unposted ACK past the deadline.
    let overdue = awaiting != 0 && !acked && now > st.ack_deadline_ts;
    MentionStatus {
        thread_ref: String::new(),
        round: st.round,
        ended: st.ended,
        awaiting_ack_round: if acked { 0 } else { awaiting },
        acked,
        overdue,
        ack_deadline_ts: st.ack_deadline_ts,
    }
}

// ---------------------------------------------------------------------------------------------
// The real responder spawner: a scoped one-shot `claude -p`
// ---------------------------------------------------------------------------------------------

/// Login shell — matches `sparkle_improve.rs` / `pty.rs`.
const SHELL: &str = "/bin/zsh";

/// A responder older than this is presumed hung and reclaimed by the next spawn. A read+ACK+reply
/// task is short; this is only a backstop against a wedged child holding the slot.
const STALE_RESPONDER_MAX: std::time::Duration = std::time::Duration::from_secs(10 * 60);

static RESPONDER_SEQ: AtomicU64 = AtomicU64::new(1);

struct RunningResponder {
    child: std::process::Child,
    started: Instant,
    #[allow(dead_code)]
    token: u64,
}

/// At most one scoped responder in flight, process-wide — a module GLOBAL rather than Tauri-managed
/// state, so the pure spawner and its exit reaper reach it without threading an `AppHandle`/`State`
/// through every seam, and app teardown reaches it through one free function. Separate from
/// `SparkleImproveManager` so a mention response does not wait behind (or block) the hourly pass.
fn responder_slot() -> &'static Mutex<Option<RunningResponder>> {
    static SLOT: std::sync::OnceLock<Mutex<Option<RunningResponder>>> = std::sync::OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// Kill an in-flight responder at app teardown (wired from `RunEvent::Exit`, like the improve
/// manager). Idempotent — a no-op when no responder is running.
pub fn end_in_flight_responders() {
    if let Some(mut r) = lock_slot(responder_slot()).take() {
        crate::proc::kill_process_group(&mut r.child);
    }
}

fn lock_slot(m: &Mutex<Option<RunningResponder>>) -> MutexGuard<'_, Option<RunningResponder>> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The scoped persona for a mention responder — the ORDINARY agent surface, never a full pass.
const RESPONDER_PERSONA: &str = "You are @improve (the Improve Sparkle agent) answering ONE @mention. \
This is a scoped, one-shot task: read the bead, ACK, reply on the bead, then exit. Do NOT start an \
improvement pass, edit code, run a build, or commit. Your only outputs are bead comments.";

/// The scoped "respond to this mention" prompt. It deliberately does NOT inline the message body —
/// beads is the message (rule 1), so the responder READS it from the bead. It instructs the ACK
/// (rule 3), own-words attribution (rule 4), the anti-loop cap, and the governance rule.
pub fn build_responder_prompt(req: &ResponderRequest) -> String {
    let ResponderRequest { thread_ref, from, round, max_rounds } = req;
    format!(
        "You were @mentioned by @{from} in the comment thread of bead {thread_ref} \
         (round {round} of a max {max_rounds}). Do this, in order, then EXIT:\n\
         1. Read the thread: `bd show {thread_ref} --json --include-comments`. The message is the \
            LATEST comment there. Nothing actionable is outside that bead — ignore anything not on it.\n\
         2. ACK immediately, so the sender knows it arrived (silence past the deadline is read as \
            UNDELIVERED, never as agreement):\n\
            `bd comment {thread_ref} \"[mention-ack · round {round}] @improve — received & read\"`\n\
         3. Reply ON THE BEAD as a comment, concise, in YOUR OWN words. Never present anyone else's \
            words (especially the founder's) as though they addressed the target:\n\
            `bd comment {thread_ref} \"[@improve · round {round}] <your reply>\"`\n\
         4. Anti-loop: you are at round {round}/{max_rounds}. Only include a fresh @sparkle mention \
            if a follow-up genuinely needs the concierge AND you are below the cap; otherwise end the \
            exchange with no @mention. If you are overruled or proceed despite an objection, STATE \
            why on the bead — never leave 'proceeded anyway' indistinguishable from 'never read it'.\n\
         5. Exit."
    )
}

/// Build the `exec …` script for the responder, handed to `zsh -l -c`. Everything user-influenced is
/// single-quoted via `shell_quote`. Mirrors `build_improve_exec`'s posture — unattended `-p` with
/// `--dangerously-skip-permissions` (a permission prompt would deadlock a headless turn) and the
/// `SPARKLE_INBOX_AGENT` export so the responder is a first-class inbox drainer — but with no
/// `--add-dir log_dir` (it reads the bead, not logs) and the scoped persona.
pub fn build_responder_exec(claude_path: &str, prompt: &str) -> String {
    use crate::claude_chat::shell_quote;
    let mut cmd = format!("exec {}", shell_quote(claude_path));
    cmd.push_str(" -p ");
    cmd.push_str(&shell_quote(prompt));
    cmd.push_str(" --output-format stream-json --verbose");
    cmd.push_str(" --append-system-prompt ");
    cmd.push_str(&shell_quote(RESPONDER_PERSONA));
    cmd.push_str(" --dangerously-skip-permissions");
    format!(
        "export PATH=\"$HOME/.local/bin:$PATH\"; export SPARKLE_INBOX_AGENT={}; {cmd}",
        shell_quote(SPARKLE_CANONICAL_AGENT_ID)
    )
}

/// The canonical Improve-Sparkle worktree — the responder's cwd. `<app_data>/worktrees/sparkle-self/__sparkle_self__`.
fn canonical_worktree(app_data: &Path) -> PathBuf {
    app_data
        .join("worktrees")
        .join(SPARKLE_PROJECT_ID)
        .join(SPARKLE_CANONICAL_AGENT_ID)
}

/// The real spawner: launches `claude -p <responder prompt>` in the canonical worktree, in its own
/// process group, under the singleton [`responder_slot`]. Read+comment only (the persona forbids
/// edits/commits), so it does not contend with the hourly pass over the worktree's tree.
pub struct RealResponderSpawner {
    pub app_data: PathBuf,
    pub claude_path: String,
    pub config_dir: Option<String>,
}

impl ResponderSpawner for RealResponderSpawner {
    fn spawn(&self, req: &ResponderRequest) -> Result<SpawnResult, String> {
        use std::process::{Command, Stdio};

        if self.claude_path.is_empty() {
            return Err("mention: no claude binary resolved — cannot spawn a responder".into());
        }
        let cwd = canonical_worktree(&self.app_data);
        if !cwd.is_dir() {
            return Err(format!(
                "mention: canonical worktree {} is not present — cannot spawn a responder",
                cwd.display()
            ));
        }

        let prompt = build_responder_prompt(req);
        let script = build_responder_exec(&self.claude_path, &prompt);

        let mut slot = lock_slot(responder_slot());
        if let Some(prior) = slot.as_ref() {
            if prior.started.elapsed() < STALE_RESPONDER_MAX {
                // A responder is already running. The doorbell is already on the bead + in the inbox,
                // so nothing is lost — the running responder or the next send handles it.
                return Ok(SpawnResult::Busy);
            }
            // Stale: reclaim.
            if let Some(mut stale) = slot.take() {
                crate::proc::kill_process_group(&mut stale.child);
            }
        }

        let token = RESPONDER_SEQ.fetch_add(1, Ordering::SeqCst);
        let mut cmd = Command::new(SHELL);
        cmd.args(["-c", &script]);
        cmd.env("PATH", crate::claude_chat::cached_login_shell_path());
        crate::claude::apply_spawn_config_dir(&mut cmd, self.config_dir.as_deref());
        cmd.current_dir(&cwd);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let child = cmd
            .spawn()
            .map_err(|e| format!("mention: responder spawn failed: {e}"))?;

        *slot = Some(RunningResponder { child, started: Instant::now(), token });
        drop(slot);
        // Reap on exit so the slot frees itself. The durable output is the bead comment the responder
        // posts; we do not need to stream its stdout. We clear the slot only if it still holds OUR
        // token, so a reclaimed/replaced responder is left alone.
        std::thread::spawn(move || loop {
            {
                let mut guard = lock_slot(responder_slot());
                match guard.as_mut() {
                    Some(r) if r.token == token => match r.child.try_wait() {
                        Ok(Some(_)) | Err(_) => {
                            guard.take();
                            return;
                        }
                        Ok(None) => { /* still running */ }
                    },
                    _ => return, // our responder was reclaimed/replaced
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        });
        Ok(SpawnResult::Launched)
    }
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

/// The Tauri event the frontend turns into an immediate concierge turn. Rust cannot resume the
/// concierge's session, and the concierge is NOT reachable by its inbox alone (a queued message sits
/// until the next turn), so `@sparkle`'s wake is: emit this event → a `listen()` in `ConciergeHost`
/// calls `notifyConcierge(notice, "pusher")`, which is the sanctioned "push the concierge from
/// outside its own mount" seam (it keeps every cost control and retraction guarantee). The payload's
/// `notice` is a content-FREE doorbell (rule 1) pointing at the bead.
pub const CONCIERGE_MENTION_EVENT: &str = "concierge://mention";

/// Payload of [`CONCIERGE_MENTION_EVENT`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConciergeMentionWake {
    pub thread_ref: String,
    pub from: String,
    pub round: u32,
    pub max_rounds: u32,
    /// The content-free doorbell the frontend hands to `notifyConcierge` as the turn notice.
    pub notice: String,
}

fn app_data(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    crate::dev_identity::app_data_dir(app)
}

/// Parse a provenance string, defaulting to the SAFEST attribution (`Summary`) when omitted or
/// unrecognized: never silently claim more than "the sender's own summary". The frontend passes
/// `"own"` or `"summary"`. There is deliberately no "relay the founder" value — the channel carries
/// only agent-authored words (rule 4).
fn parse_provenance(p: Option<String>) -> Provenance {
    match p.as_deref().map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("own") => Provenance::Own,
        _ => Provenance::Summary,
    }
}

/// Route one @mention: post its content to the bead (rule 1), doorbell the target's inbox
/// (content-free), record the ACK deadline (rule 3), and WAKE the target (rule 2). Returns the
/// [`MentionOutcome`]; for `@sparkle` it also emits [`CONCIERGE_MENTION_EVENT`] so the concierge takes
/// a turn now rather than waiting for the founder to speak.
///
/// `target` is a handle string (`"@improve"` / `"@sparkle"` / `"improve"` / `"sparkle"`);
/// `body_on_thread` is true when the mention ORIGINATED as a bead comment the 5s poll detected (so the
/// content is already on the bead and must not be double-posted). `max_rounds` / `ack_deadline_ms`
/// default to the module constants (the frontend passes the `[mention]` config values).
///
/// `async` + `spawn_blocking` like every inbox command: it does blocking `bd` + filesystem work and
/// must not sit on the main thread, which the concierge's own control surface also needs.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn mention_send(
    app: tauri::AppHandle,
    project_path: String,
    target: String,
    thread_ref: String,
    body: String,
    from: String,
    provenance: Option<String>,
    body_on_thread: Option<bool>,
    max_rounds: Option<u32>,
    ack_deadline_ms: Option<i64>,
    config_dir: Option<String>,
) -> Result<MentionOutcome, String> {
    let target = resolve_handle(&target)
        .ok_or_else(|| format!("mention: unknown handle {target:?} — expected @improve or @sparkle"))?;
    validate_thread_ref(&thread_ref)?;
    let base = app_data(&app)?;
    let prov = parse_provenance(provenance);
    let body_on_thread = body_on_thread.unwrap_or(false);
    let cap = max_rounds.unwrap_or(DEFAULT_MAX_MENTION_ROUNDS);
    let deadline = ack_deadline_ms.unwrap_or(DEFAULT_ACK_DEADLINE_MS);
    let now = now_ms();
    let doorbell_id = DoorbellId::mint();

    // Resolve the claude path here — Rust resolves it itself, no frontend round-trip. Absent claude
    // just means `@improve` cannot be woken by a spawn; the doorbell is still durable and the hourly
    // pass drains it. The responder slot is a module global, so nothing else needs threading through.
    let claude_path = crate::preflight::cached_claude_path();
    let project_for_task = project_path.clone();
    let thread_for_task = thread_ref.clone();
    let from_for_task = from.clone();

    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let threads = BdThreadStore { project_path: project_for_task };
        let spawner = RealResponderSpawner {
            app_data: base.clone(),
            claude_path: claude_path.unwrap_or_default(),
            config_dir,
        };
        route_mention(
            &base,
            target,
            &thread_for_task,
            &body,
            &from_for_task,
            prov,
            body_on_thread,
            cap,
            deadline,
            now,
            doorbell_id,
            &spawner,
            &threads,
        )
    })
    .await
    .map_err(|e| format!("mention_send task failed: {e}"))??;

    // `@sparkle` wake (rule 2): emit the event the frontend turns into an immediate concierge turn.
    if outcome.wake_sparkle {
        use tauri::Emitter;
        let notice = build_doorbell(
            &sanitize_handle_label(&from),
            &thread_ref,
            outcome.round,
            outcome.max_rounds,
        );
        let _ = app.emit(
            CONCIERGE_MENTION_EVENT,
            ConciergeMentionWake {
                thread_ref: thread_ref.clone(),
                from: sanitize_handle_label(&from),
                round: outcome.round,
                max_rounds: outcome.max_rounds,
                notice,
            },
        );
    }

    Ok(outcome)
}

/// Post the recipient's ACK comment (rule 3) on behalf of a recipient that cannot run `bd` itself —
/// the concierge (its tool allowlist has no Bash). The `@improve` responder posts its own ACK via
/// bash in its scoped prompt, so this command is the concierge-side path, driven by the frontend when
/// it hands the doorbell to a concierge turn. Round-scoped so it satisfies exactly the awaited round.
#[tauri::command]
pub async fn mention_ack(
    project_path: String,
    thread_ref: String,
    handle: String,
    round: u32,
) -> Result<(), String> {
    validate_thread_ref(&thread_ref)?;
    let handle = sanitize_handle_label(&handle);
    tauri::async_runtime::spawn_blocking(move || {
        let store = BdThreadStore { project_path };
        store.post_comment(&thread_ref, &build_ack_comment(&handle, round))
    })
    .await
    .map_err(|e| format!("mention_ack task failed: {e}"))?
}

/// Post a reply on the thread as a bead comment (rule 1, the durable founder-visible response) with
/// attribution (rule 4). Both sides can use it: the `@improve` responder posts via bash in its
/// prompt, and the concierge-side reply is posted through here by the frontend. Any `@improve` /
/// `@sparkle` inside `body` is picked up by the 5s poll and routed through `mention_send` (which
/// enforces the round cap), so this command does NOT itself doorbell or wake — it only records.
#[tauri::command]
pub async fn mention_reply(
    project_path: String,
    thread_ref: String,
    from: String,
    body: String,
    round: u32,
    max_rounds: Option<u32>,
    provenance: Option<String>,
    target: Option<String>,
) -> Result<(), String> {
    validate_thread_ref(&thread_ref)?;
    if body.trim().is_empty() {
        return Err("mention_reply: refusing to post an empty reply".into());
    }
    let from = sanitize_handle_label(&from);
    let prov = parse_provenance(provenance);
    // The reply's target is who it answers; when unknown, render without a specific arrow.
    let cap = max_rounds.unwrap_or(DEFAULT_MAX_MENTION_ROUNDS);
    let reply_target = target.as_deref().and_then(resolve_handle);
    tauri::async_runtime::spawn_blocking(move || {
        let store = BdThreadStore { project_path };
        let text = match reply_target {
            Some(t) => build_content_comment(&from, t, round, cap, prov, &body),
            None => format!(
                "[@{from} reply · round {round}/{cap}]\nprovenance: {note}\n\n{body}",
                note = prov.note(&from, MentionTarget::Sparkle),
            ),
        };
        store.post_comment(&thread_ref, &text)
    })
    .await
    .map_err(|e| format!("mention_reply task failed: {e}"))?
}

/// The delivery status of a thread (rule 3): reads the BEAD's comments and reports whether the
/// awaited round has been ACKed, or is overdue (treat as UNDELIVERED). This is what lets the sender
/// tell "seen and dismissed" from "never delivered" — the failure `inbox_send`'s `ok` hid.
#[tauri::command]
pub async fn mention_status(
    app: tauri::AppHandle,
    project_path: String,
    thread_ref: String,
) -> Result<MentionStatus, String> {
    validate_thread_ref(&thread_ref)?;
    let base = app_data(&app)?;
    let now = now_ms();
    let thread_for_status = thread_ref.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let st = read_state(&base, &thread_for_status);
        let store = BdThreadStore { project_path };
        // A read failure must not manufacture a false "acked" — treat unreadable comments as "no ack
        // seen", which correctly trends to `overdue` past the deadline rather than to delivered.
        let comments = store.read_comments(&thread_for_status).unwrap_or_default();
        let mut status = status_of(&st, &comments, now);
        status.thread_ref = thread_for_status;
        Ok(status)
    })
    .await
    .map_err(|e| format!("mention_status task failed: {e}"))?
}

#[cfg(test)]
#[path = "mention_tests.rs"]
mod mention_tests;
