//! THE RESEARCH RUNNER — "Concierge Agents" (bead `sparkle-s7rfc`).
//!
//! A research task is a question the founder (or the concierge on his behalf) asks about a repo,
//! answered by a READ-ONLY `claude` child that runs in the background and files its findings to
//! disk. The Rust half is this file; the TypeScript half is `src/services/research/{types,store}.ts`
//! and the two agree through ONE shared fixture (`fixtures/researchTasks.sample.json`) that both
//! suites parse — see `the_shared_fixture_round_trips` below and `types.test.ts` beside it.
//!
//! ══ THE FEATURE IS THAT `research_dispatch` RETURNS BEFORE THE CHILD FINISHES ══════════════════
//!
//! Everything else in this module is support for that one property. The concierge dispatches a
//! long research pass and answers the founder's next sentence immediately; the finding lands
//! later, on disk, and is folded into a subsequent turn. A version of this that awaited the child
//! would be INDISTINGUISHABLE at the call site — same signature, same returned task — and would
//! reintroduce exactly the blocking the feature replaces. So it is pinned by a test that runs
//! `dispatch` on a worker thread and fails (rather than hangs) if it has not returned inside a
//! short bound: `dispatch_returns_while_the_child_is_still_running`.
//!
//! ══ EVERY `Option` FIELD SERIALISES AS AN EXPLICIT `null` ══════════════════════════════════════
//!
//! [`ResearchTask`] deliberately carries NO `skip_serializing_if` on any field. serde's derive emits
//! the key with a `null` value for `Option::None` and omits it only under that attribute; the TS
//! parser is written against `T | null`, which does not include `undefined`. AGENTS.md records this
//! exact defect shipping once: an all-or-nothing parse that rejects one field discards the WHOLE
//! payload and falls back to "we did not look" — permanently inert, for everyone, with nothing
//! logged, because `None` is what the common case sends. `an_option_none_serialises_as_null_not_an_absent_key`
//! asserts the key is present.
//!
//! ══ THE STORE IS `<app_data>/research/<id>.json`, NOT `<app_data>/inbox/` ══════════════════════
//!
//! Deliberately its own directory. [`crate::retention::reap_inbox`] parses every `<id>.jsonl` under
//! `inbox/` as an AGENT id and deletes the ones with no live worktree — every research record would
//! read as an orphaned agent and be reaped.
//!
//! Writes follow inbox.rs's READ-BACK-BEFORE-OK rule (bead `sparkle-bbghz`): a successful write
//! proves the bytes left this process, not that the record is READABLE. `dispatch` returns an id to
//! a caller that will later look the task up by it, so "written" is the wrong thing to promise.
//!
//! ══ ITS OWN POOL, NOT `claude_oneshot`'s ══════════════════════════════════════════════════════
//!
//! Same RAII permit / bounded-waiting-room shape, separate counters. `claude_oneshot`'s pool is
//! MAX_CONCURRENT=4 / MAX_BACKGROUND=3 tuned for 2-60s classify calls; one long-running research
//! child holding a background permit there would starve agent auto-naming and the followup judge for
//! the whole pass. The founder asked for NO CAP on dispatch, and that is what this delivers: a
//! dispatch is NEVER refused. Over the pool bound the BACKGROUND runner queues in a bounded waiting
//! room and drains; only at the far edge of that room does a task fail, and it says so honestly
//! rather than silently vanishing.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE CONTRACT — mirrors `src/services/research/types.ts` exactly
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/// Where a task is in its life. A CLOSED union, and the three terminal states are deliberately
/// distinct: "the CLI reported an error", "the human killed it" and "it ran out of wall clock" are
/// different facts to the concierge deciding whether to re-ask.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResearchStatus {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

impl ResearchStatus {
    /// A task in one of these will never change again.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Cancelled)
    }
}

/// The two tiers. KEPT as a wire contract with the TS side (the shared fixture exercises both), but
/// they no longer differ in model or wall clock — the founder collapsed cheap/deep into one capable,
/// unthrottled tier. See [`RESEARCH_MODEL`] and [`RESEARCH_TIMEOUT`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResearchDepth {
    Quick,
    Deep,
}

/// The model EVERY research child runs on — ONE capable tier, not a cheap/deep split.
///
/// The founder asked for dispatched agents "as capable as the concierge" and added "I don't know
/// that we need cheap or deep," so both depths now pin the SAME Opus-class model. The `Quick`/`Deep`
/// enum stays (it is a wire contract with the TS side — see the shared fixture), but the tier no
/// longer buys a smaller model, only a label.
///
/// PINNED rather than inherited: the concierge omits `--model` so its interactive session follows
/// the user's Claude Code default, but a background research child has no session to inherit from,
/// and the argv builder + its ordering test both require a concrete `--model` value. `claude-opus-5`
/// is the Opus-5-class id the rest of this repo already dispatches (concierge default included), so
/// this pins capability parity with the concierge without depending on the CLI's ambient default.
const RESEARCH_MODEL: &str = "claude-opus-5";

/// Wall-clock BACKSTOP for one child — a safety ceiling, deliberately NOT a throttle.
///
/// The founder's instruction was "remove the time limits completely — it takes as long as it
/// takes." So this replaces the old 3-minute/15-minute walls with a ceiling so high nothing
/// legitimate reaches it (a real research pass finishes in minutes). Its ONLY job is to guarantee a
/// genuinely wedged `node` eventually releases its pool permit instead of leaking it forever — an
/// unbounded wait would let one hung child pin a slot for the life of the process.
///
/// CANCELLATION IS UNAFFECTED. `research_cancel` flips the flag the child-watch loop polls every
/// `CHILD_POLL`, so a task is killable the instant the founder asks — long, long before this ceiling
/// — and killing the process group still reaps the whole tree. This lifts the *automatic* wall, not
/// the ability to cancel.
const RESEARCH_TIMEOUT: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// The ONLY model ids a caller may ask a research child to run on.
///
/// ══ WHY AN ALLOWLIST AND NOT A PASSTHROUGH ═════════════════════════════════════════════════════
///
/// `ai.rs` already clamps `max_tokens` because "an unclamped budget from a compromised renderer
/// would be a costly-output amplifier". A free-form `--model` string is the SAME hazard class with
/// a sharper edge: the prices differ by an order of magnitude (`spend.rs` lists Fable at $10/$50
/// per Mtok against Opus 5's $5/$25), so a renderer that could name any string could point every
/// research and advisor child at the dearest row in the table — or at a model id that does not
/// exist, which the CLI reports as a task-level failure minutes later rather than as a rejected
/// argument.
///
/// So the override is CLOSED, not validated-by-shape. An unknown id is refused at dispatch, before
/// a task record is written, and the caller is told which ids exist. Mirrors the curated list in
/// `services/models.ts` (the frontend's source of truth, since `model_catalog.rs` deliberately
/// returns an empty vec) plus `claude-opus-5`, which this module already pins as its own default.
pub const RESEARCH_MODEL_ALLOWLIST: &[&str] = &[
    "claude-opus-5",
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-sonnet-5",
    "claude-haiku-4-5",
];

/// Resolve the model one child runs on: the caller's override when it is on the allowlist, else the
/// depth's own pinned model. `None` and a blank string both mean "no override" — a blank is what an
/// options object carrying an unset field serializes to, and treating it as an unknown id would
/// refuse dispatches nobody asked to override.
///
/// Returns `Err` for a NON-BLANK id that is not allow-listed, rather than silently falling back to
/// the default. A silent fallback is the failure this repo keeps paying for: the caller would get a
/// task that ran, answered, and was attributed to a model it never used — and for the advisor pass
/// specifically, "it ran on the model I asked for" is the whole premise (a fallback to the planner's
/// own tier turns second-model review back into self-review with nothing reporting it).
pub(crate) fn resolve_research_model(
    depth: ResearchDepth,
    model_override: Option<&str>,
) -> Result<String, String> {
    let requested = model_override.map(str::trim).filter(|m| !m.is_empty());
    let Some(m) = requested else {
        return Ok(depth.model().to_string());
    };
    if RESEARCH_MODEL_ALLOWLIST.contains(&m) {
        return Ok(m.to_string());
    }
    Err(format!(
        "research: {m} is not a model this app may dispatch. Allowed: {}",
        RESEARCH_MODEL_ALLOWLIST.join(", ")
    ))
}

impl ResearchDepth {
    /// Both depths run the same capable model now — see [`RESEARCH_MODEL`].
    pub fn model(self) -> &'static str {
        let _ = self;
        RESEARCH_MODEL
    }

    /// Both depths share the huge safety backstop, not an artificial wall — see [`RESEARCH_TIMEOUT`].
    pub fn timeout(self) -> Duration {
        let _ = self;
        RESEARCH_TIMEOUT
    }
}

/// One research task, exactly as it sits at `<app_data>/research/<id>.json` and exactly as the TS
/// `ResearchTask` interface reads it.
///
/// NO `skip_serializing_if` ANYWHERE, on purpose — see the module header. Adding one to any field
/// below breaks the TS parser silently and `an_option_none_serialises_as_null_not_an_absent_key`
/// is what stops it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchTask {
    /// Minted by the runner, never supplied by the model or the frontend.
    pub id: String,
    /// The question as dispatched, verbatim.
    pub question: String,
    pub depth: ResearchDepth,
    /// `null` when the dispatch named no project — a real state, not an error.
    pub project_id: Option<String>,
    /// Absolute path the child runs in.
    pub project_root: String,
    pub status: ResearchStatus,
    /// Epoch ms, set at dispatch — before any process exists.
    pub created_at: i64,
    /// When a pool permit was acquired and the child actually spawned. `null` while queued.
    pub started_at: Option<i64>,
    /// When it reached a terminal state. `null` until then.
    pub finished_at: Option<i64>,
    /// The findings, NOT truncated. `null` unless `status == Done`.
    pub findings: Option<String>,
    /// Why it failed, fit to show a human. `null` unless `status == Failed`.
    pub error: Option<String>,
    /// THE CLAIM. Epoch ms when this result was folded into a concierge turn that RESOLVED.
    pub read_at: Option<i64>,
}

impl ResearchTask {
    /// Is this result waiting to be told to the concierge? `done` only — mirrors `isUnread` in
    /// types.ts, which is the authority the drain uses.
    pub fn is_unread(&self) -> bool {
        self.status == ResearchStatus::Done && self.read_at.is_none() && self.findings.is_some()
    }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE STORE
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/// `<app_data>/research` — NOT `<app_data>/inbox`. See the module header for why that matters.
pub fn research_dir(app_data: &Path) -> PathBuf {
    app_data.join("research")
}

fn task_path(app_data: &Path, id: &str) -> PathBuf {
    research_dir(app_data).join(format!("{id}.json"))
}

/// The sidecar carrying the child's LIVE TAIL while it runs — a capped, human-readable log the
/// running task's main-pane view polls (bead sparkle-s7rfc). Deliberately a SEPARATE file from the
/// task JSON: the tail is rewritten continuously as events stream in, and routing that through the
/// task record's write-then-rename-then-read-back contract would be both wasteful and a way to
/// corrupt the record the whole feature depends on. `.tail` is not `.json`, so `list_tasks` (which
/// filters to `.json`) never sees it.
fn tail_path(app_data: &Path, id: &str) -> PathBuf {
    research_dir(app_data).join(format!("{id}.tail"))
}

/// Read the live tail for a task, or an empty string when there is none (never dispatched by this
/// install, already finished — `finish` removes the sidecar — or the id is malformed). Empty is the
/// honest "nothing to show yet", which is exactly what the pane renders as an absence.
pub fn read_tail(app_data: &Path, id: &str) -> String {
    if valid_task_id(id).is_err() {
        return String::new();
    }
    std::fs::read_to_string(tail_path(app_data, id)).unwrap_or_default()
}

/// Ids reach this module from the frontend (`research_get`, `research_cancel`, `research_mark_read`)
/// and are joined into a path, so they are validated as a FILE NAME COMPONENT before any I/O.
///
/// Same charset `worktree::validate_id` enforces for agent/project ids, and for the same reason: an
/// id containing `/` or `..` escapes the research dir.
fn valid_task_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        return Err("invalid research task id: must be 1-128 chars".to_string());
    }
    if !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("invalid research task id: only [A-Za-z0-9_-] allowed".to_string());
    }
    Ok(())
}

/// Mint a task id. `rsh_` prefix so a stray file in the directory is identifiable, then the
/// creation time and 64 bits of randomness so two dispatches in the same millisecond cannot collide.
fn mint_id(now: i64) -> String {
    format!("rsh_{now:013}_{:016x}", rand::random::<u64>())
}

/// Persist a task, and REFUSE TO ACKNOWLEDGE IT UNTIL IT READS BACK (bead `sparkle-bbghz`).
///
/// WHY A SUCCESSFUL WRITE IS NOT ENOUGH EVIDENCE. `write` returning `Ok` proves the bytes left this
/// process. It does not prove they are readable as a RECORD, and the gap between those two facts is
/// the whole defect the bead names: a truncated write on a full disk, or a partial file left by a
/// crash between `write` and `rename`, is written successfully and then does not exist as far as
/// `read_task` is concerned. `dispatch` hands its caller an id that the caller will look up later,
/// so "visible to the reader" is the thing to promise, and it is what is asserted here.
///
/// Deliberately re-read through `read_task` — the exact path and parser every consumer uses —
/// rather than a cheaper stat or byte compare. A check that agreed with the WRITER instead of with
/// the READER would re-open the same hole one layer down.
fn write_task(app_data: &Path, task: &ResearchTask) -> Result<(), String> {
    valid_task_id(&task.id)?;
    let dir = research_dir(app_data);
    std::fs::create_dir_all(&dir).map_err(|e| format!("research: cannot create {dir:?}: {e}"))?;

    let body = serde_json::to_vec_pretty(task)
        .map_err(|e| format!("research: cannot serialise {}: {e}", task.id))?;

    // Write-then-rename so a reader never observes a half-written record. The temp name carries the
    // `.tmp` suffix that `list_tasks` filters out, so an abandoned temp is inert rather than a task
    // that parses as garbage.
    let final_path = task_path(app_data, &task.id);
    let tmp_path = dir.join(format!("{}.json.tmp", task.id));
    std::fs::write(&tmp_path, &body)
        .map_err(|e| format!("research: cannot write {tmp_path:?}: {e}"))?;
    std::fs::rename(&tmp_path, &final_path)
        .map_err(|e| format!("research: cannot commit {final_path:?}: {e}"))?;

    match read_task(app_data, &task.id) {
        Some(back) if &back == task => Ok(()),
        Some(_) => Err(format!(
            "research: wrote task {} but read back a DIFFERENT record — treating this as a \
             FAILED write rather than acknowledging a task whose stored state is not the one \
             this process decided on",
            task.id
        )),
        None => Err(format!(
            "research: wrote task {} but could not read it back — treating this as a FAILED \
             write rather than returning an id for a task that does not exist",
            task.id
        )),
    }
}

/// Read one task. `None` for an id that does not exist OR whose record is unparseable — both mean
/// "there is no readable task here", which is what every caller acts on.
pub fn read_task(app_data: &Path, id: &str) -> Option<ResearchTask> {
    if valid_task_id(id).is_err() {
        return None;
    }
    let bytes = std::fs::read(task_path(app_data, id)).ok()?;
    serde_json::from_slice::<ResearchTask>(&bytes).ok()
}

/// Every readable task, NEWEST FIRST (the order the row and the detail list both want).
///
/// A malformed record is SKIPPED rather than failing the listing: one corrupt file must not hide
/// every other task from the row.
pub fn list_tasks(app_data: &Path) -> Vec<ResearchTask> {
    let Ok(entries) = std::fs::read_dir(research_dir(app_data)) else {
        // No research dir yet — nothing dispatched. Not an error.
        return Vec::new();
    };
    let mut out: Vec<ResearchTask> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| std::fs::read(e.path()).ok())
        .filter_map(|b| serde_json::from_slice::<ResearchTask>(&b).ok())
        .collect();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out
}

/// Update a task through a closure, REFUSING TO OVERWRITE A TERMINAL RECORD.
///
/// This is the whole cancel/finish race resolution, in one place rather than at each call site. The
/// runner thread and `research_cancel` both write the same file: cancel flips the control flag and
/// stamps `Cancelled`, and the runner — which may be milliseconds behind — then tries to stamp
/// `Failed` for the child it just killed. Reading the current record first and keeping it when it
/// is already terminal makes the FIRST terminal write win, so a task the founder cancelled never
/// re-renders as a broken one.
///
/// Returns the record as it now stands on disk (mutated, or the terminal one that was kept).
fn update_task(
    app_data: &Path,
    id: &str,
    mutate: impl FnOnce(&mut ResearchTask),
) -> Result<ResearchTask, String> {
    update_task_where(app_data, id, |t| !t.status.is_terminal(), mutate)
}

/// [`update_task`] with the write rule supplied, for the ONE caller that has a stronger claim than
/// "first terminal write wins" — see [`finish`] and [`RECONCILED_ERROR`].
fn update_task_where(
    app_data: &Path,
    id: &str,
    may_write: impl FnOnce(&ResearchTask) -> bool,
    mutate: impl FnOnce(&mut ResearchTask),
) -> Result<ResearchTask, String> {
    let mut task = read_task(app_data, id)
        .ok_or_else(|| format!("research: no task with id {id}"))?;
    if !may_write(&task) {
        return Ok(task);
    }
    mutate(&mut task);
    write_task(app_data, &task)?;
    Ok(task)
}

/// The error a reconcile pass stamps on a record it believes a process exit orphaned.
///
/// It is a CONST rather than a literal because [`finish`] has to recognise it: a reconcile verdict
/// is a GUESS about a process that is not here to ask, and the runner coming home with a real
/// outcome is the ground truth that must be allowed to overwrite it — see [`reconcile_interrupted`].
const RECONCILED_ERROR: &str = "Interrupted when Sparkle restarted.";

/// Was this record terminated by a reconcile GUESS rather than by something that actually observed
/// the child? Only such a record may be overwritten by a late `finish`.
fn is_a_reconcile_guess(t: &ResearchTask) -> bool {
    t.status == ResearchStatus::Failed && t.error.as_deref() == Some(RECONCILED_ERROR)
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE POOL — its own counters, never `claude_oneshot`'s
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/// Concurrent research children. SIXTEEN — the founder uncorked this pool: the concierge fans ~20
/// questions out at once and expects most of them running in parallel, not draining two at a time.
/// Each child is still a full node process doing tool-heavy work against the same subscription rate
/// limit, so this is a real load; the trade is deliberate and is the whole point of this change. A
/// burst past 16 does not fail — it queues in the bounded waiting room below.
///
/// Tunable by intent: raise or lower this ONE constant to change the parallelism. (It is not a
/// `.sparkle/config.toml` value because that layer is per-project-overridable policy — freshness,
/// review, approvals — and dispatch parallelism is a global runtime property of this machine, not a
/// per-repo rule; a plain constant is the honest home for it.)
const MAX_CONCURRENT_RESEARCH: usize = 16;

/// How many dispatched tasks may WAIT for a permit on top of those holding one.
///
/// Generous on purpose. The founder asked for NO CAP, and this is the honest engineering of that:
/// `dispatch` itself is never refused, and a task only fails at the FAR EDGE of this room — which
/// at 64 deep means someone has 66 research passes outstanding, a state worth being told about
/// rather than absorbing silently.
const MAX_RESEARCH_WAITERS: usize = 64;

/// How long a queued task waits for a permit before giving up. An hour: nobody is watching a
/// research pass, and the alternative to waiting is throwing the question away.
const RESEARCH_WAIT: Duration = Duration::from_secs(60 * 60);

/// Poll interval while waiting for a permit. Coarse — the calls being waited on take minutes.
const WAIT_POLL: Duration = Duration::from_millis(200);

/// Poll interval while watching a running child.
const CHILD_POLL: Duration = Duration::from_millis(150);

static RESEARCH_INFLIGHT: AtomicUsize = AtomicUsize::new(0);
static RESEARCH_WAITING: AtomicUsize = AtomicUsize::new(0);

/// A held research slot. Releases on drop, including on panic.
///
/// `Debug` is required by the pool tests: they assert a refusal with `expect_err`, whose bound is on
/// the OK type, so a `Result<Permit, _>` cannot be unwrapped for its error without it.
#[derive(Debug)]
struct Permit<'a> {
    counter: &'a AtomicUsize,
}

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::AcqRel);
    }
}

/// A seat in the bounded waiting room. Releases on drop.
struct Seat<'a> {
    counter: &'a AtomicUsize,
}

impl Drop for Seat<'_> {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::AcqRel);
    }
}

/// The counters and bounds one pool is made of.
///
/// A struct rather than four constants read directly so a test can drive the REAL acquire logic
/// over a tiny pool (cap 1, room 1) instead of having to build 66 threads to reach the far edge.
/// The production pool is [`research_pool`].
struct Pool<'a> {
    inflight: &'a AtomicUsize,
    waiting: &'a AtomicUsize,
    cap: usize,
    room: usize,
}

/// THE research pool. Its counters are this module's own statics — see the module header for why
/// sharing `claude_oneshot`'s would starve agent naming and the followup judge for a whole pass.
fn research_pool() -> Pool<'static> {
    Pool {
        inflight: &RESEARCH_INFLIGHT,
        waiting: &RESEARCH_WAITING,
        cap: MAX_CONCURRENT_RESEARCH,
        room: MAX_RESEARCH_WAITERS,
    }
}

/// Take a slot, or `None` immediately.
///
/// A COMPARE-AND-SWAP loop, deliberately not `fetch_add`-then-undo: with `fetch_add`, N racing
/// threads all push the counter past the cap before any of them undoes, and during that window a
/// legitimate acquirer is refused for a slot that was never really taken.
fn try_take(counter: &AtomicUsize, cap: usize) -> Option<Permit<'_>> {
    let mut current = counter.load(Ordering::Acquire);
    loop {
        if current >= cap {
            return None;
        }
        match counter.compare_exchange_weak(current, current + 1, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => return Some(Permit { counter }),
            Err(actual) => current = actual,
        }
    }
}

/// Claim a seat in the waiting room, or `None` when it is full. Same CAS discipline as `try_take`.
fn enter_room(counter: &AtomicUsize, room: usize) -> Option<Seat<'_>> {
    let mut current = counter.load(Ordering::Acquire);
    loop {
        if current >= room {
            return None;
        }
        match counter.compare_exchange_weak(current, current + 1, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => return Some(Seat { counter }),
            Err(actual) => current = actual,
        }
    }
}

/// What refusing a task at the far edge of the waiting room tells the founder. A SENTENCE, not a
/// sentinel: it lands in `ResearchTask::error` and is rendered in the row.
fn room_full_error(room: usize) -> String {
    format!(
        "Not started — {room} research passes are already queued ahead of this one. \
         Cancel some, or ask again once they drain."
    )
}

/// Take a slot, queueing in the bounded waiting room if the pool is full.
///
/// `Err` carries the honest reason, which becomes the task's `error`. Only two ways to get one: the
/// waiting room is full, or the wait expired.
fn acquire<'a>(pool: &Pool<'a>, max_wait: Duration, cancelled: &AtomicBool) -> Result<Permit<'a>, String> {
    if let Some(p) = try_take(pool.inflight, pool.cap) {
        return Ok(p);
    }
    // Full — take a seat if there is one. Held for the whole wait, so the ceiling on parked threads
    // is cap + room and cannot drift.
    let _seat = enter_room(pool.waiting, pool.room).ok_or_else(|| room_full_error(pool.room))?;
    let deadline = Instant::now() + max_wait;
    loop {
        std::thread::sleep(WAIT_POLL);
        // A task cancelled while queued must stop queueing. Without this it would hold a seat for
        // the full hour and then run a question the founder already killed.
        if cancelled.load(Ordering::Acquire) {
            return Err("cancelled while queued".to_string());
        }
        if let Some(p) = try_take(pool.inflight, pool.cap) {
            return Ok(p);
        }
        if Instant::now() >= deadline {
            return Err(
                "Not started — waited an hour for a research slot and never got one.".to_string()
            );
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE CHILD — argv, classification, cancellation
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/// The research persona, appended to (never replacing) the user's own system prompt.
///
/// `--append-system-prompt`, unlike `claude_oneshot`'s `--system-prompt`: this child needs its
/// normal tool-use instincts intact to actually read a repo. What it must NOT do is act, and the
/// last two paragraphs are belt to the `--tools` braces — a model told only by a flag
/// that it cannot write will spend its budget trying.
const RESEARCH_PERSONA: &str = "\
You are a READ-ONLY research assistant answering one question about this repository. \
Investigate with the tools you have — read files, grep, run read-only shell commands, search the \
web — and then report what you FOUND.

Rules:
- NEVER modify anything. Do not edit or create files, do not commit, do not push, do not run any \
command that changes state (no git write commands, no package installs, no service calls that \
mutate). If answering would require a change, say so instead of making it.
- Report evidence, not impressions. Cite the file paths, line numbers, commands and outputs that \
support each claim, so the reader can check you.
- Say plainly when you could not determine something. An honest \"I could not find X, here is \
where I looked\" is worth more than a confident guess, and a guess presented as a finding is the \
one outcome that makes this feature harmful.
- Answer in prose the reader can skim: the answer first, then the evidence. No preamble about what \
you are about to do.";

/// The allow-list of tools a research child may use. NOTE the deliberate difference from
/// `claude_oneshot`, which passes `--tools ""` to remove ALL built-in tools: that is right for a
/// pure-text judge and fatal here — a research pass that cannot read a file cannot research.
/// ══ `--tools` IS THE ONLY FLAG THAT RESTRICTS ANYTHING. MEASURED, NOT ASSUMED. ═════════════════
///
/// This module previously passed `--allowedTools` + `--disallowedTools` and documented them as the
/// safety boundary. They are not. Probed against the installed CLI (Claude Code, 2026-08), headless
/// `-p`, four runs:
///
///   1. `--allowedTools "Read,Grep,Glob"` + `--disallowedTools "Edit,Write,NotebookEdit"` +
///      `--dangerously-skip-permissions`  → the child ran `echo … > file` via Bash. WROTE.
///   2. the same WITHOUT `--dangerously-skip-permissions`                → WROTE.
///   3. the same with `Bash` added to `--disallowedTools`                 → WROTE.
///   4. `--tools "Read,Grep,Glob"`                                        → "I don't have a shell
///      execution tool available to me." NOT WRITTEN.
///
/// So `--allowedTools` is a PRE-APPROVAL list, not a restriction — an absent tool is not removed,
/// and `--disallowedTools` did not hold either. `concierge.rs` already records this for MCP tools
/// ("⚠️ THIS FLAG DOES NOT GATE MCP TOOLS"); it is true of built-ins in `-p` too. Only `--tools`
/// replaces the set, which is exactly what `claude_oneshot` relies on with `--tools ""`.
///
/// ══ AND SCOPED ENTRIES ARE SILENTLY DROPPED ════════════════════════════════════════════════════
///
/// A fifth probe passed `--tools "Read,Grep,Glob,Bash(git log:*)"` and the child reported having NO
/// shell at all — the scoped form is not understood here and the entry vanishes rather than
/// erroring. So `Bash(git log:*)` is not available as a middle ground: it is a full shell or none,
/// and a version of this that "scoped" the shell would have shipped a research agent that silently
/// could not run a single command.
///
/// THE FOUNDER CHOSE THE SHELL, with the trade stated plainly: the child needs `git log`/`blame`,
/// log parsing and measurement, and none of that is reachable without one. So `Bash` is in the set,
/// unrestricted, and this comment says so rather than implying a scoping that does not exist. The
/// containment that IS real: the set below is closed (no Edit, no Write, no NotebookEdit), the
/// child is bounded by wall clock, and every task is visible and cancellable in the sidebar row.
const RESEARCH_TOOL_SET: &str = "Read,Grep,Glob,Bash,WebFetch,WebSearch";

/// Build the argv for one research child. Pure, and every flag is load-bearing.
///
/// ORDERING CONSTRAINT: `-p <question>` MUST come first. `--allowedTools`, `--disallowedTools` and
/// `--mcp-config` are variadic (`<tools...>`) in the CLI's parser, and a variadic flag immediately
/// followed by a bare positional swallows it (`claude_oneshot.rs:305`). Leading with `-p` makes the
/// question an OPTION ARGUMENT, which cannot be captured that way. Invisible from reading the code,
/// so it has its own test.
fn build_research_args(question: &str, model: &str, persona: &str) -> Vec<String> {
    vec![
        // MUST be first — see the ordering constraint above.
        "-p".to_string(),
        question.to_string(),
        // NDJSON EVENTS ON STDOUT, ONE PER LINE, so the runner can surface a LIVE TAIL of the child's
        // work while it runs (bead sparkle-s7rfc; founder 2026-08-17: "show me a bit of the research
        // as it happens", not just a timer). The single-object `json` format buffered everything to
        // the end and streamed nothing; `stream-json` emits `system`/`assistant`/`user`/`result`
        // events incrementally. The FINAL `result` event carries the same top-level `is_error` /
        // `result` fields the old single object did, so `classify_result` reads it UNCHANGED — see
        // `CliSpawner::run`, which returns that final event's line as the outcome.
        "--output-format".to_string(),
        "stream-json".to_string(),
        // REQUIRED by the CLI whenever `-p` is paired with `--output-format stream-json`: without it
        // the CLI refuses to stream and errors out. It does not add token-level deltas on its own
        // (that would be `--include-partial-messages`, deliberately NOT passed — message/tool-call
        // granularity keeps the tail bounded and readable).
        "--verbose".to_string(),
        // One capable model for both tiers — see RESEARCH_MODEL.
        "--model".to_string(),
        model.to_string(),
        // APPEND, not replace: the child needs its normal tool-use behaviour.
        "--append-system-prompt".to_string(),
        persona.to_string(),
        // THE tool boundary — see RESEARCH_TOOL_SET. `--allowedTools`/`--disallowedTools` are
        // deliberately NOT passed: both were measured inert here, and passing a flag that looks
        // like a gate but is not is worse than passing nothing.
        "--tools".to_string(),
        RESEARCH_TOOL_SET.to_string(),
        // Nobody is at a keyboard to answer a permission prompt, and a prompt would hang the child
        // to its deadline. Safe here only BECAUSE of the two tool flags above.
        "--dangerously-skip-permissions".to_string(),
        // "Only use MCP servers from --mcp-config, ignoring all other MCP configurations." With no
        // --mcp-config supplied that resolves to the empty set.
        "--strict-mcp-config".to_string(),
        // Without this every research pass writes a session JSONL under ~/.claude/projects/, which
        // also pollutes the usage-transcript scanner in accounts.rs.
        "--no-session-persistence".to_string(),
    ]
}

/// What one child run yielded, decided from the parsed JSON ALONE.
#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    Findings(String),
    Failed(String),
}

/// Decide the outcome of one run from its parsed JSON.
///
/// THE EXIT CODE AND `subtype` BOTH LIE — `is_error` is the only truthful bit. Both of these are
/// real captures, and the process exits 0 for both while `subtype` stays `"success"`:
///
/// ```text
/// {"is_error":true,"subtype":"success","terminal_reason":"api_error","api_error_status":null,
///  "result":"Not logged in · Please run /login","total_cost_usd":0}
/// {"is_error":true,"subtype":"success","terminal_reason":"api_error","api_error_status":404,
///  "result":"There's an issue with the selected model (not-a-real-model)..."}
/// ```
///
/// A runner that trusted either would file "Not logged in · Please run /login" as a research
/// FINDING — shown to the founder as the answer to his question, and folded into a concierge turn
/// as fact. That is why this mirrors `claude_oneshot::classify_result_json` rather than reading
/// `status.success()`.
fn classify_result(v: &serde_json::Value) -> Outcome {
    let result_text = v.get("result").and_then(serde_json::Value::as_str).unwrap_or("");
    if v.get("is_error").and_then(serde_json::Value::as_bool).unwrap_or(false) {
        return Outcome::Failed(cli_failure_message(result_text));
    }
    let trimmed = result_text.trim();
    if trimmed.is_empty() {
        // A blank reply is a failure, not a silent success with no findings.
        return Outcome::Failed(
            "The research run finished but returned nothing.".to_string()
        );
    }
    Outcome::Findings(trimmed.to_string())
}

/// Turn the CLI's error body into a sentence fit to show a human.
///
/// BOUNDED — never echoes the whole `result`, which can be arbitrarily long and can quote the
/// REQUEST back (and the request here is the founder's question). Same restraint
/// `claude_oneshot::classify_cli_failure` documents.
fn cli_failure_message(result_text: &str) -> String {
    let lower = result_text.to_lowercase();
    // The two conditions worth naming, because each has a specific action and neither is "retry".
    if lower.contains("not logged in")
        || lower.contains("/login")
        || lower.contains("invalid api key")
        || lower.contains("failed to authenticate")
        || lower.contains("session expired")
    {
        return "The research run could not start — the Claude CLI is not signed in.".to_string();
    }
    if lower.contains("usage limit reached")
        || lower.contains("limit resets at")
        || lower.contains("spend limit")
        || lower.contains("credit balance is too low")
    {
        return "The research run stopped — this account's Claude allowance is spent.".to_string();
    }
    let detail: String = result_text.chars().take(200).collect();
    if detail.trim().is_empty() {
        "The research run ended without producing findings — the CLI reported an error before it \
         finished."
            .to_string()
    } else {
        format!("The research run failed: {}", detail.trim())
    }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE LIVE TAIL — turning stream-json events into a small, bounded, human-readable log
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// `stream-json` emits one JSON event per line as the child works. `CliSpawner::run` folds each event
// into a rolling tail (last {TAIL_MAX_LINES} lines, hard-capped at {TAIL_MAX_CHARS} chars) that the
// running task's main-pane view polls on the existing research cadence. Two caps and the poll are
// the whole reason this cannot "become a big problem": the file never grows, and nobody reads it
// faster than every few seconds. All three helpers below are PURE so they are unit-tested without a
// real `claude` — the one thing this environment cannot spawn.

/// Keep the tail short enough to read at a glance and small enough to reread every poll.
const TAIL_MAX_LINES: usize = 40;
/// One event's line, truncated so a single huge assistant block cannot dominate the window.
const TAIL_LINE_MAX_CHARS: usize = 200;
/// A hard ceiling on the rendered file regardless of line count — belt to the line cap's suspenders.
const TAIL_MAX_CHARS: usize = 6_000;

/// Is this the terminal `result` event — the one carrying the final `is_error` / `result` that
/// `classify_result` consumes? `type == "result"` is the stream-json marker; the field-presence
/// fallback keeps working if the CLI ever drops the `type` tag, and is the same shape the old
/// single-object `json` format produced.
fn is_result_event(v: &serde_json::Value) -> bool {
    if v.get("type").and_then(serde_json::Value::as_str) == Some("result") {
        return true;
    }
    v.get("is_error").is_some() || v.get("result").is_some()
}

/// One brief, human-readable representation of a tool call, for the tail — `→ Bash: git log` /
/// `→ Read src/x.rs`. Never echoes a whole tool input (a `Bash` command or a file body can be long
/// and can quote the question back), so it takes the single most identifying value and truncates.
fn tool_use_line(name: &str, input: &serde_json::Value) -> String {
    // The field that best identifies each research tool's target, in preference order.
    let detail = ["command", "file_path", "path", "pattern", "query", "url", "prompt"]
        .iter()
        .find_map(|k| input.get(*k).and_then(serde_json::Value::as_str))
        .unwrap_or("");
    let detail = detail.trim();
    if detail.is_empty() {
        format!("→ {name}")
    } else {
        format!("→ {name}: {detail}")
    }
}

/// The readable lines one stream-json event contributes to the tail — empty for events that carry
/// nothing worth showing (`system`/`init`, tool RESULTS, the final `result`). Only ASSISTANT events
/// speak: the model's own in-progress text and the tool calls it makes, which together are exactly
/// "what the research agent is doing right now". A tool RESULT is deliberately skipped — it is where
/// a whole file's contents (or the question, echoed back) would leak in unbounded.
fn extract_tail_lines(v: &serde_json::Value) -> Vec<String> {
    if v.get("type").and_then(serde_json::Value::as_str) != Some("assistant") {
        return Vec::new();
    }
    let Some(content) = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array())
    else {
        return Vec::new();
    };
    let mut lines = Vec::new();
    for block in content {
        match block.get("type").and_then(serde_json::Value::as_str) {
            Some("text") => {
                if let Some(t) = block.get("text").and_then(serde_json::Value::as_str) {
                    // Collapse to one line so a multi-paragraph block stays one tail entry (and one
                    // truncation), rather than blowing the line budget by itself.
                    let one = t.split_whitespace().collect::<Vec<_>>().join(" ");
                    if !one.is_empty() {
                        lines.push(one);
                    }
                }
            }
            Some("tool_use") => {
                let name = block.get("name").and_then(serde_json::Value::as_str).unwrap_or("tool");
                let empty = serde_json::Value::Null;
                lines.push(tool_use_line(name, block.get("input").unwrap_or(&empty)));
            }
            _ => {}
        }
    }
    lines
}

/// Append one line to the rolling tail buffer: trimmed, char-safely truncated, empties dropped, and
/// the oldest lines evicted once the buffer exceeds {TAIL_MAX_LINES}. `char`-based truncation (not
/// byte slicing) so a multi-byte boundary can never panic.
fn push_tail_line(buf: &mut std::collections::VecDeque<String>, line: &str) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    let truncated: String = line.chars().take(TAIL_LINE_MAX_CHARS).collect();
    buf.push_back(truncated);
    while buf.len() > TAIL_MAX_LINES {
        buf.pop_front();
    }
}

/// Render the buffer to the string written to the sidecar: newest-last (reading order), hard-capped
/// at {TAIL_MAX_CHARS} by keeping the MOST RECENT characters — a tail shows the end, and the end is
/// what the founder is watching for.
fn render_tail(buf: &std::collections::VecDeque<String>) -> String {
    let joined = buf.iter().cloned().collect::<Vec<_>>().join("\n");
    let len = joined.chars().count();
    if len <= TAIL_MAX_CHARS {
        joined
    } else {
        joined.chars().skip(len - TAIL_MAX_CHARS).collect()
    }
}

/// The message a task carries when it hit the wall-clock BACKSTOP (see [`RESEARCH_TIMEOUT`]) — a
/// rare safety stop, not the old automatic wall. Rendered in the largest sensible unit so a
/// multi-day ceiling does not read as an absurd minute count.
fn timeout_message(timeout: Duration) -> String {
    let secs = timeout.as_secs();
    let span = if secs >= 24 * 60 * 60 {
        format!("{}-day", secs / (24 * 60 * 60))
    } else if secs >= 60 * 60 {
        format!("{}-hour", secs / (60 * 60))
    } else {
        format!("{}-minute", secs / 60)
    };
    format!("The research run hit its {span} safety limit and was stopped.")
}

/// The cancellation + child handle for ONE running task.
///
/// `research_cancel` reaches the child through this; the spawner reaches the cancel flag through
/// it. One object rather than two so a cancel can never flip a flag whose child nobody holds.
pub(crate) struct Control {
    cancelled: AtomicBool,
    child: Mutex<Option<std::process::Child>>,
}

impl Control {
    fn new() -> Self {
        Self { cancelled: AtomicBool::new(false), child: Mutex::new(None) }
    }

    /// Has the founder killed this task? Polled by the spawner between waits.
    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    /// Flip the flag AND kill the child if one is already running. Both, in that order: a spawner
    /// that is between `spawn` and `hold` sees the flag; one that is already waiting gets the kill.
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.kill_child();
    }

    /// Hand the running child to the control so a cancel can reach it.
    pub(crate) fn hold(&self, child: std::process::Child) {
        if let Ok(mut slot) = self.child.lock() {
            *slot = Some(child);
        }
    }

    /// Has the child exited? `Some(true)` exited, `Some(false)` still running, `None` no child.
    pub(crate) fn child_exited(&self) -> Option<bool> {
        let mut slot = self.child.lock().ok()?;
        let child = slot.as_mut()?;
        match child.try_wait() {
            Ok(Some(_)) => Some(true),
            Ok(None) => Some(false),
            // Cannot tell — treat as exited so the runner stops polling a child it can never reap.
            Err(_) => Some(true),
        }
    }

    /// SIGKILL the child's whole process group and reap it. Idempotent.
    pub(crate) fn kill_child(&self) {
        if let Ok(mut slot) = self.child.lock() {
            if let Some(child) = slot.as_mut() {
                crate::proc::kill_process_group(child);
            }
        }
    }

    /// Drop the child handle once it has been reaped, closing our end of its pipes.
    pub(crate) fn release_child(&self) {
        if let Ok(mut slot) = self.child.lock() {
            *slot = None;
        }
    }
}

/// Every task with a live runner thread, keyed by task id. Entries are removed when the runner
/// reaches a terminal state, so this is "what is actually running", not a history.
fn live_controls() -> &'static Mutex<std::collections::HashMap<String, Arc<Control>>> {
    static LIVE: OnceLock<Mutex<std::collections::HashMap<String, Arc<Control>>>> = OnceLock::new();
    LIVE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// What a spawner is asked to run.
pub(crate) struct SpawnRequest {
    pub question: String,
    pub depth: ResearchDepth,
    /// The model this child runs on, ALREADY RESOLVED and validated by
    /// [`resolve_research_model`] — never a raw caller string. Carried here rather than derived
    /// from `depth` at spawn time so the allowlist check happens once, at dispatch, before a task
    /// record exists; a child cannot be started on an id that was never checked.
    pub model: String,
    pub project_root: PathBuf,
    /// Where to write the capped LIVE TAIL of the child's output as it runs, or `None` to write no
    /// tail (every test spawner passes `None`). A sidecar `<id>.tail` beside the task JSON — NOT a
    /// field on the task record, so the streaming write path never touches the carefully-guarded
    /// `<id>.json` write-then-rename and the `ResearchTask` contract is unchanged. `research_tail`
    /// reads it; `finish` removes it once the task is terminal.
    pub tail_path: Option<PathBuf>,
}

/// THE SEAM. `run` blocks until the child ends, is cancelled, or the deadline passes, and returns
/// the child's raw stdout.
///
/// A trait rather than a defaulted closure parameter, and the production implementation is reached
/// through [`Runner::production`] — the one line that supplies it. AGENTS.md records the failure
/// mode of the alternative: a `deps = realThing` default that every test overrides leaves the
/// production call site covered by nothing, so deleting it keeps the suite green. `runner_kind` is
/// what makes that line load-bearing; `production_wires_the_real_spawner` asserts it.
pub(crate) trait ResearchSpawner: Send + Sync + 'static {
    fn run(&self, req: &SpawnRequest, ctl: &Control) -> Result<String, String>;
    /// Names this implementation, so a test can assert which one production wires up.
    fn kind(&self) -> &'static str;
}

/// The sentinel a spawner returns when it stopped because the task was cancelled. Distinguished
/// from a failure so a cancelled task never renders as a broken one.
pub(crate) const CANCELLED_SENTINEL: &str = "research_cancelled";

/// The sentinel for a run that hit its wall clock.
pub(crate) const TIMEOUT_SENTINEL: &str = "research_timeout";

/// The real spawner: the user's `claude` CLI, as an ARGV VECTOR through no shell.
pub(crate) struct CliSpawner;

impl ResearchSpawner for CliSpawner {
    fn kind(&self) -> &'static str {
        "cli"
    }

    fn run(&self, req: &SpawnRequest, ctl: &Control) -> Result<String, String> {
        use std::io::{BufRead, Read};
        use std::process::{Command, Stdio};

        let claude_path = crate::preflight::cached_claude_path()
            .ok_or_else(|| "No `claude` CLI was found on this machine.".to_string())?;
        let args = build_research_args(&req.question, &req.model, RESEARCH_PERSONA);

        let mut cmd = Command::new(&claude_path);
        cmd.args(&args);
        // The child must ask the SAME credential the concierge's child uses; an inherited
        // ANTHROPIC_API_KEY silently bills a different account (roborev 57985). Sparkle's own
        // secret-bearing vars go too — a research child running `Bash` has no business with them.
        crate::claude_oneshot::scrub_anthropic_env_for(&mut cmd);
        for name in crate::claude_oneshot::secret_env_names_now() {
            cmd.env_remove(name);
        }
        // A Finder-launched .app inherits no shell PATH, so hand the child the login PATH with
        // ~/.local/bin prepended (the CLI's `#!/usr/bin/env node` shebang has to resolve).
        cmd.env("PATH", child_path());
        // THE PROJECT ROOT, unlike claude_oneshot's temp dir: this child's whole job is to read
        // this repo, and `--append-system-prompt` leaves CLAUDE.md discovery on.
        cmd.current_dir(&req.project_root);
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Its own process group, so a cancel or a timeout kills the whole tree rather than a
            // `node` that has already forked. REQUIRED by `proc::kill_process_group`.
            cmd.process_group(0);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("The research run could not start `claude`: {e}"))?;

        // Drain both pipes concurrently. A child that fills a pipe buffer while we are not reading
        // deadlocks, and a research pass produces far more output than a judge does.
        //
        // STDOUT IS NOW READ LINE BY LINE, not slurped: with `--output-format stream-json` each line
        // is one event, and folding it as it arrives is what makes the live tail live. The thread
        // does three things per line — fold it into the rolling tail and write the capped sidecar,
        // and remember the last line that IS the terminal `result` event. It returns that final
        // line, which is the single JSON object the outcome pipeline below parses exactly as it
        // parsed the old `json` format's whole stdout. If the child is killed (cancel/timeout) or
        // dies before emitting a result, it returns `None`, and the `usable` fallback takes over.
        let out = child.stdout.take();
        let mut err = child.stderr.take();
        let tail_path = req.tail_path.clone();
        let out_thread = std::thread::spawn(move || -> Option<String> {
            let Some(h) = out else { return None };
            let mut reader = std::io::BufReader::new(h);
            let mut tail: std::collections::VecDeque<String> = std::collections::VecDeque::new();
            let mut final_line: Option<String> = None;
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break, // EOF: the pipe closed (child exited or was killed).
                    Ok(_) => {}
                    Err(_) => break,
                }
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(event) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                    // A non-JSON line is not fatal — stream-json can interleave stray output; skip it
                    // rather than aborting the whole read and losing the tail so far.
                    continue;
                };
                if is_result_event(&event) {
                    // The outcome, kept verbatim so `classify_result` sees the same object shape.
                    final_line = Some(trimmed.to_string());
                    continue; // The result event is not itself tail content.
                }
                let mut changed = false;
                for l in extract_tail_lines(&event) {
                    push_tail_line(&mut tail, &l);
                    changed = true;
                }
                if changed {
                    if let Some(tp) = tail_path.as_ref() {
                        // Best-effort: a failed tail write must never affect the run. The file is
                        // capped, so this rewrite is cheap even on a chatty stream.
                        let _ = std::fs::write(tp, render_tail(&tail));
                    }
                }
            }
            final_line
        });
        let err_thread = std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(h) = err.as_mut() {
                let _ = h.read_to_end(&mut buf);
            }
            buf
        });

        ctl.hold(child);
        // CHECK THE FLAG ONCE MORE AFTER HANDING THE CHILD OVER. A cancel that landed between
        // `spawn` and `hold` set the flag while `kill_child` had nothing to kill, so without this
        // the child would run to completion and its findings would be filed for a task the founder
        // already stopped.
        if ctl.is_cancelled() {
            ctl.kill_child();
        }

        let deadline = Instant::now() + req.depth.timeout();
        let mut verdict: Result<(), String> = Ok(());
        loop {
            match ctl.child_exited() {
                Some(true) | None => break,
                Some(false) => {}
            }
            if ctl.is_cancelled() {
                ctl.kill_child();
                verdict = Err(CANCELLED_SENTINEL.to_string());
                break;
            }
            if Instant::now() >= deadline {
                ctl.kill_child();
                verdict = Err(TIMEOUT_SENTINEL.to_string());
                break;
            }
            std::thread::sleep(CHILD_POLL);
        }

        // Release the handle so the pipes close and the drain threads can finish.
        ctl.release_child();
        // The final `result` event's line — the one object the outcome pipeline parses. `None` when
        // the child was killed or died before emitting one; the `usable` check then falls to stderr.
        let final_line = out_thread.join().unwrap_or_default();
        let stderr = err_thread.join().unwrap_or_default();
        verdict?;

        let stdout = final_line.unwrap_or_default();
        // A RESULT OBJECT, not merely "some JSON" — a wrapper's error envelope or a truncated array
        // parses fine and then has no `is_error` and no `result`, which would read as "the CLI
        // answered with nothing". Falling back to stderr here keeps the real diagnosis.
        let usable = serde_json::from_str::<serde_json::Value>(stdout.trim())
            .ok()
            .is_some_and(|v| v.get("is_error").is_some() || v.get("result").is_some());
        if !usable {
            let detail: String = String::from_utf8_lossy(&stderr).trim().chars().take(200).collect();
            // The sentinel, never the raw body: stderr on this path can begin with our own argv,
            // i.e. up to 200 characters of the founder's question, and this log is persisted and
            // rides along in consented support uploads.
            tracing::warn!("research child produced no usable output");
            return Err(if detail.is_empty() {
                "The research run produced no usable output.".to_string()
            } else {
                format!("The research run produced no usable output: {detail}")
            });
        }
        Ok(stdout)
    }
}

/// PATH for the child. Same story as claude_chat/concierge — see `CliSpawner::run`.
fn child_path() -> String {
    let base = crate::claude_chat::cached_login_shell_path();
    match std::env::var_os("HOME") {
        Some(home) => format!("{}/.local/bin:{}", home.to_string_lossy(), base),
        None => base,
    }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE RUNNER
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/// Everything the five operations depend on that a test needs to control.
///
/// ONE injectable object rather than a defaulted parameter per seam, and the clock lives here
/// alongside the spawner deliberately: AGENTS.md records that controlling only one of two coupled
/// values leaves the pair indistinguishable and the test passes either way.
pub(crate) struct Runner {
    pub app_data: PathBuf,
    pub spawner: Arc<dyn ResearchSpawner>,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

/// Epoch ms.
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Runner {
    /// The production wiring. This ONE line is what supplies the real CLI spawner, and
    /// `production_wires_the_real_spawner` is what keeps it from being deleted silently.
    pub(crate) fn production(app_data: PathBuf) -> Self {
        Self { app_data, spawner: Arc::new(CliSpawner), now: Arc::new(now_ms) }
    }
}

/// START A RESEARCH TASK, AND RETURN BEFORE THE CHILD FINISHES.
///
/// The order is the contract: mint → persist (read back) → register → spawn the runner thread →
/// return a `queued` task. Persisting BEFORE spawning means a task that exists is always findable;
/// spawning on a thread means the caller is never behind the child.
///
/// `Err` only for the things that make the task unstartable and unrecorded — an empty question, or
/// a store that cannot read its own write. Pool pressure is NOT one of them: a dispatch is never
/// refused (see `MAX_RESEARCH_WAITERS`), it queues.
pub(crate) fn dispatch_with(
    runner: Arc<Runner>,
    question: &str,
    project_id: Option<String>,
    project_root: PathBuf,
    depth: ResearchDepth,
    model_override: Option<&str>,
) -> Result<ResearchTask, String> {
    let question = question.trim();
    if question.is_empty() {
        return Err("research: a research task needs a question".to_string());
    }
    // BEFORE the task record is written, so a refused model leaves nothing behind to reconcile —
    // the same ordering the empty-question guard above uses, and for the same reason.
    let model = resolve_research_model(depth, model_override)?;

    let created_at = (runner.now)();
    let task = ResearchTask {
        id: mint_id(created_at),
        question: question.to_string(),
        depth,
        project_id,
        project_root: project_root.to_string_lossy().to_string(),
        status: ResearchStatus::Queued,
        created_at,
        started_at: None,
        finished_at: None,
        findings: None,
        error: None,
        read_at: None,
    };
    write_task(&runner.app_data, &task)?;

    let ctl = Arc::new(Control::new());
    if let Ok(mut live) = live_controls().lock() {
        live.insert(task.id.clone(), Arc::clone(&ctl));
    }

    // A REAL OS THREAD, not a tokio task. The work is blocking start to finish (a pool wait of up
    // to an hour, then a child that runs as long as the pass takes), and parking a tokio worker would
    // starve every other command.
    let bg = Arc::clone(&runner);
    let id = task.id.clone();
    let req = SpawnRequest {
        question: task.question.clone(),
        depth,
        model,
        project_root,
        tail_path: Some(tail_path(&runner.app_data, &task.id)),
    };
    std::thread::spawn(move || {
        run_to_completion(&bg, &id, req, &ctl);
        if let Ok(mut live) = live_controls().lock() {
            live.remove(&id);
        }
    });

    Ok(task)
}

/// The background half: wait for a permit, run the child, record the terminal state.
///
/// Never returns anything — every outcome is written to the task's record, which is the only thing
/// any reader consults.
fn run_to_completion(runner: &Runner, id: &str, req: SpawnRequest, ctl: &Control) {
    let pool = research_pool();
    let permit = match acquire(&pool, RESEARCH_WAIT, &ctl.cancelled) {
        Ok(p) => p,
        Err(reason) => {
            if ctl.is_cancelled() {
                finish(runner, id, ResearchStatus::Cancelled, None, None);
            } else {
                finish(runner, id, ResearchStatus::Failed, None, Some(reason));
            }
            return;
        }
    };

    if ctl.is_cancelled() {
        finish(runner, id, ResearchStatus::Cancelled, None, None);
        return;
    }

    // Mark running BEFORE the spawn, so `startedAt` means "a permit was acquired and the child is
    // being started" rather than "the child answered".
    let started_at = (runner.now)();
    let marked = update_task(&runner.app_data, id, |t| {
        t.status = ResearchStatus::Running;
        t.started_at = Some(started_at);
    });
    match marked {
        // Already terminal — cancelled out from under us between dispatch and here. Nothing to run.
        Ok(t) if t.status != ResearchStatus::Running => return,
        Ok(_) => {}
        Err(e) => {
            tracing::warn!(error = %e, "research: could not mark task running");
            return;
        }
    }

    let outcome = runner.spawner.run(&req, ctl);
    // The permit is released here rather than at the end of the function so a slow terminal WRITE
    // never holds a slot a queued task could be using.
    drop(permit);

    match outcome {
        Ok(raw) => match serde_json::from_str::<serde_json::Value>(raw.trim()) {
            Ok(v) => match classify_result(&v) {
                Outcome::Findings(text) => {
                    finish(runner, id, ResearchStatus::Done, Some(text), None)
                }
                Outcome::Failed(msg) => finish(runner, id, ResearchStatus::Failed, None, Some(msg)),
            },
            Err(_) => finish(
                runner,
                id,
                ResearchStatus::Failed,
                None,
                Some("The research run returned output this app could not read.".to_string()),
            ),
        },
        Err(e) if e == CANCELLED_SENTINEL || ctl.is_cancelled() => {
            finish(runner, id, ResearchStatus::Cancelled, None, None)
        }
        Err(e) if e == TIMEOUT_SENTINEL => finish(
            runner,
            id,
            ResearchStatus::Failed,
            None,
            Some(timeout_message(req.depth.timeout())),
        ),
        Err(e) => finish(runner, id, ResearchStatus::Failed, None, Some(e)),
    }
}

/// Stamp a terminal state. First terminal write wins — a cancel that beat the runner home stands,
/// and the runner does not relabel it as a failure.
///
/// ══ WITH ONE EXCEPTION: A RECONCILE GUESS YIELDS TO AN OBSERVED OUTCOME ═════════════════════════
///
/// `reconcile_interrupted` decides a task is orphaned from a PROCESS-LOCAL map, so its verdict is a
/// guess about work it cannot see. If that guess is wrong — a second app instance reconciling the
/// first instance's genuinely-running tasks (roborev 61731) — then under a plain first-write-wins
/// rule the real runner's `finish` is silently DROPPED and a completed 15-minute Opus pass is lost
/// permanently, with only a `tracing::warn` behind it.
///
/// So `finish` may overwrite exactly one kind of terminal record: one carrying [`RECONCILED_ERROR`].
/// This does not weaken the cancel race — `Cancelled` is not that record, and a real `Failed` from
/// an observed child is not either. The failure mode it trades INTO is a row that flips back from
/// "interrupted" to its true outcome, which is a correction the founder wants to see; the one it
/// trades OUT of is findings that no longer exist anywhere.
fn finish(
    runner: &Runner,
    id: &str,
    status: ResearchStatus,
    findings: Option<String>,
    error: Option<String>,
) {
    let at = (runner.now)();
    let may_write = |t: &ResearchTask| !t.status.is_terminal() || is_a_reconcile_guess(t);
    if let Err(e) = update_task_where(&runner.app_data, id, may_write, |t| {
        t.status = status;
        t.finished_at = Some(at);
        t.findings = findings;
        t.error = error;
    }) {
        // Nothing further to do — the record is the only channel, and it is unreachable.
        tracing::warn!(error = %e, "research: could not record a terminal state");
    }
    // Drop the live-tail sidecar: a terminal task's pane shows its findings/error, not the tail, so
    // the file has done its job and must not accumulate one-per-task forever. Best-effort — a task
    // record with no sidecar reads as "no tail", which is correct for a finished task. It runs even
    // when the write above yielded to a first-terminal-write-wins guard, because the sidecar is
    // stale regardless of which terminal record won.
    let _ = std::fs::remove_file(tail_path(&runner.app_data, id));
}

/// Reconcile records left non-terminal by a process exit. Call once at startup.
///
/// ══ WITHOUT THIS, AN INTERRUPTED PASS INFLATES THE ROW FOREVER ══════════════════════════════════
///
/// A task that is `queued` or `running` when the app quits — or crashes, or is killed — keeps that
/// status ON DISK permanently. Its `Control` lived only in the process-local `live_controls()` map,
/// so no thread will ever call `finish` for it, and `list_tasks` keeps returning it. The TS side
/// counts `queued|running` for the row's `+[n]`, so every interrupted pass permanently inflates the
/// badge, and nothing drains it: this module deliberately opts out of `retention::reap_inbox`, and
/// `research_cancel` is the only other exit — which needs the founder to notice and click.
///
/// This is the COMMON case, not an edge one: a pass now runs as long as it needs (the automatic wall
/// was lifted), so a restart landing inside one is ordinary.
///
/// ══ AND ITS VERDICT IS A GUESS, WHICH IS WHY `finish` MAY OVERTURN IT ═══════════════════════════
///
/// `live_controls()` is PROCESS-LOCAL, so "no live control" means "not dispatched by *this*
/// process" — the same thing as "nothing is working on it" only while this is the sole process
/// reading that `app_data`. Nothing here enforces that: there is no single-instance guard, and a
/// second launch or an updater relaunch that overlaps the outgoing process would have this pass
/// fail the OTHER instance's genuinely-running tasks (roborev 61731).
///
/// Proving the owning process dead needs a cross-process lease this module does not have. What it
/// has instead is a rule that makes being wrong RECOVERABLE rather than destructive: the record is
/// stamped with [`RECONCILED_ERROR`], and [`finish`] is allowed to overwrite exactly that. So a
/// wrongly-reconciled task whose runner is still alive gets its real findings when the child comes
/// home, instead of having them dropped by the first-terminal-write-wins rule and lost for good.
pub fn reconcile_interrupted(app_data: &Path) -> usize {
    let live = live_controls();
    let mut reconciled = 0usize;
    for task in list_tasks(app_data) {
        if task.status.is_terminal() {
            continue;
        }
        // FAIL CLOSED on a poisoned map. This branch is the one that protects live work, so an
        // answer we could not read must mean "leave it alone", never "nothing is working on it".
        let has_control = live
            .lock()
            .map(|m| m.contains_key(&task.id))
            .unwrap_or(true);
        if has_control {
            continue;
        }
        let done = update_task(app_data, &task.id, |t| {
            t.status = ResearchStatus::Failed;
            t.finished_at = Some(now_ms());
            t.error = Some(RECONCILED_ERROR.to_string());
        });
        if done.is_ok() {
            reconciled += 1;
        }
    }
    reconciled
}

/// Cancel a task. Idempotent, and safe for a task that is queued, running, or already finished.
///
/// Kills the child's whole process group through [`Control`] and stamps `Cancelled` HERE rather
/// than leaving it to the runner thread: the founder pressed a button and the row must change now,
/// not whenever a child notices its pipes closed.
pub(crate) fn cancel_task(runner: &Runner, task_id: &str) -> Result<ResearchTask, String> {
    valid_task_id(task_id)?;
    let existing = read_task(&runner.app_data, task_id)
        .ok_or_else(|| format!("research: no task with id {task_id}"))?;
    if existing.status.is_terminal() {
        // Already done/failed/cancelled — return it unchanged rather than rewriting history.
        return Ok(existing);
    }

    let ctl = live_controls().lock().ok().and_then(|live| live.get(task_id).cloned());
    if let Some(ctl) = ctl {
        ctl.cancel();
    }

    let at = (runner.now)();
    update_task(&runner.app_data, task_id, |t| {
        t.status = ResearchStatus::Cancelled;
        t.finished_at = Some(at);
        // Deliberately no `error`: a task the founder killed is not a broken one, and types.ts is
        // explicit that `error` is populated only for `failed`.
        t.error = None;
    })
}

/// THE CLAIM. Stamp `readAt` on tasks whose findings have been delivered to a resolved turn.
///
/// FIRST CLAIM WINS — a task that already carries a `readAt` is left alone. Re-stamping would move
/// the timestamp every turn and destroy the only evidence of when the founder was actually told.
///
/// Every id is attempted before any error is reported, so one bad id cannot silently drop the
/// claims that would have succeeded — which would make those findings re-tell forever.
pub(crate) fn mark_read(runner: &Runner, task_ids: &[String], at: i64) -> Result<(), String> {
    let mut failures: Vec<String> = Vec::new();
    for id in task_ids {
        if let Err(e) = valid_task_id(id) {
            failures.push(e);
            continue;
        }
        let Some(task) = read_task(&runner.app_data, id) else {
            failures.push(format!("no task with id {id}"));
            continue;
        };
        if task.read_at.is_some() {
            continue;
        }
        let mut claimed = task;
        claimed.read_at = Some(at);
        if let Err(e) = write_task(&runner.app_data, &claimed) {
            failures.push(e);
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!("research: could not claim {} task(s): {}", failures.len(), failures.join("; ")))
    }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE TAURI COMMANDS — names pinned by `RESEARCH_COMMANDS` in src/services/research/store.ts
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/// Resolve the directory the child runs in.
///
/// `project_root` is supplied by the caller when it knows one — the frontend owns the project list,
/// and Rust has no id→path map. When it does not, the app's own working directory is the honest
/// fallback: a real absolute path the task records and the detail view can show, rather than a
/// guess dressed up as a resolution.
/// Where the child runs — and a MISSING root is a hard error, never a guess.
///
/// ══ THE FALLBACK THAT SHIPPED HERE WAS THE BUG ══════════════════════════════════════════════════
///
/// This used to fall back to `current_dir()` (then `temp_dir()`). For a packaged Tauri app the
/// process cwd is not a repo at all, so every research task dispatched without a root would have
/// run somewhere arbitrary and reported findings about the wrong tree — or about nothing. It would
/// not have looked broken: the child runs, answers, and the answer is confidently wrong, which is
/// the worst failure a research tool has.
///
/// And it was reachable. The TS caller was not sending a root at all (the registry validated the
/// project id and then dropped its `rootPath`), so `None` was the COMMON case, not the edge. That is
/// the parallel-build seam AGENTS.md warns about — both halves green, merge clean, feature broken —
/// caught at integration by reading the two sides against each other rather than by any test.
///
/// Erroring is the right half of the fix; the caller now sends the root. A guessed directory cannot
/// be told apart from a correct one by anything downstream, so there is nothing to degrade to.
fn resolve_root(project_root: Option<String>) -> Result<PathBuf, String> {
    let Some(root) = project_root else {
        return Err(
            "I don't know which project to research — no project root was supplied.".to_string()
        );
    };
    let p = PathBuf::from(&root);
    // ABSOLUTE ONLY. A relative path is resolved by the OS against the PROCESS cwd, which is the
    // very thing the removed fallback got wrong — `is_dir()` would happily accept `src` or `.` and
    // the child would run somewhere nobody named. The root is produced app-side from the project
    // store, so a relative one means something upstream is broken; saying so beats researching an
    // arbitrary directory and reporting the findings as if they were about the project.
    if !p.is_absolute() {
        return Err(format!("A project root must be an absolute path, got: {root}"));
    }
    if !p.is_dir() {
        return Err(format!("That project root is not a directory: {root}"));
    }
    Ok(p)
}

/// ASYNC on purpose, like every command in this module: a sync `#[tauri::command]` body runs on the
/// MAIN thread, and this one touches the filesystem.
#[tauri::command]
pub async fn research_dispatch(
    app: tauri::AppHandle,
    question: String,
    project_id: Option<String>,
    depth: ResearchDepth,
    project_root: Option<String>,
    // OPTIONAL model override, checked against `RESEARCH_MODEL_ALLOWLIST`. Absent (the ordinary
    // case, and every pre-existing caller) means the depth's pinned model. The second-model advisor
    // pass is what needs it: its whole premise is running on a model DIFFERENT from the planner's,
    // which it cannot do while every child is pinned to one id. A `///` here is a compile error —
    // doc comments are not permitted on function parameters.
    model: Option<String>,
) -> Result<ResearchTask, String> {
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    let runner = Arc::new(Runner::production(app_data));
    dispatch_with(
        runner,
        &question,
        project_id,
        resolve_root(project_root)?,
        depth,
        model.as_deref(),
    )
}

#[tauri::command]
pub async fn research_list(app: tauri::AppHandle) -> Result<Vec<ResearchTask>, String> {
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    Ok(list_tasks(&app_data))
}

#[tauri::command]
pub async fn research_get(
    app: tauri::AppHandle,
    task_id: String,
) -> Result<Option<ResearchTask>, String> {
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    Ok(read_task(&app_data, &task_id))
}

/// The LIVE TAIL for one running task — a capped, human-readable log of what the child is doing
/// right now (bead sparkle-s7rfc). Empty string when there is nothing to show (never dispatched
/// here, or already finished — `finish` removes the sidecar). Polled by the running task's main-pane
/// view on the existing research cadence; never pushed, so it cannot outrun the reader.
#[tauri::command]
pub async fn research_tail(app: tauri::AppHandle, task_id: String) -> Result<String, String> {
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    Ok(read_tail(&app_data, &task_id))
}

#[tauri::command]
pub async fn research_cancel(
    app: tauri::AppHandle,
    task_id: String,
) -> Result<ResearchTask, String> {
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    cancel_task(&Runner::production(app_data), &task_id)
}

#[tauri::command]
pub async fn research_mark_read(
    app: tauri::AppHandle,
    task_ids: Vec<String>,
    at: i64,
) -> Result<(), String> {
    let app_data = crate::worktree::app_data_dir_pub(&app)?;
    mark_read(&Runner::production(app_data), &task_ids, at)
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    /// The fixture BOTH suites parse. Resolved from `CARGO_MANIFEST_DIR` rather than the process
    /// CWD so the test is not silently reading a different file under a different runner.
    const FIXTURE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/services/research/fixtures/researchTasks.sample.json"
    );

    fn fixture_json() -> serde_json::Value {
        let bytes = std::fs::read(FIXTURE).expect("the shared fixture must be readable");
        serde_json::from_slice(&bytes).expect("the shared fixture must be valid JSON")
    }

    /// SERIALIZES THE TESTS THAT CONSUME REAL POOL PERMITS.
    ///
    /// `run_to_completion` always takes from the process-global research pool, whose cap is 2, and
    /// `cargo test` runs this file's tests IN PARALLEL IN ONE BINARY. Two tests that each latch a
    /// child therefore saturate the pool, and a third waiting on `wait_until` expires against a
    /// bound that has nothing to do with what it is testing — a red that names the wrong thing and
    /// comes and goes with scheduling (roborev 61696). It reproduces: this file passes under
    /// `--test-threads=1` and fails under the default.
    ///
    /// A guard rather than an injected pool because the pool borrows `'static` counters; making it
    /// injectable means owning them behind an `Arc`, which is a real refactor of production code to
    /// fix a test-harness problem. Tests that take permits are genuinely not independent, and saying
    /// so in one place is the honest encoding of that.
    ///
    /// ══ WHICH TESTS TAKE IT, AND WHY THAT RULE IS IN SOURCE ═════════════════════════════════════
    ///
    /// THE CRITERION IS SYNTACTIC, ON PURPOSE: a test takes this guard if it calls the production
    /// dispatch entry point (`dispatch_with` / `run_to_completion`) or reads the production pool
    /// (`research_pool()`). It is deliberately WIDER than "actually takes a permit" — a couple of
    /// dispatch tests fail before any permit is acquired — because the narrow rule cannot be checked
    /// mechanically and the wide one can. `every_test_that_touches_the_global_pool_takes_the_guard`
    /// scans this module's own source and reds when a new test breaks it, which is the whole point:
    /// the failure this repairs is INTERMITTENT, so a convention policed only by a doc comment is
    /// policed by nothing (roborev 61741). A test built on a LOCAL `Pool { … }` over its own
    /// counters touches no shared state and must NOT take it — that is why
    /// `a_task_cancelled_while_queued_stops_waiting` and its two siblings are bare.
    ///
    /// `lock()` is deliberately unwrapped through a poison: a panicking test must not silently
    /// convert every sibling into a second failure.
    static POOL_GUARD: Mutex<()> = Mutex::new(());

    fn pool_guard() -> std::sync::MutexGuard<'static, ()> {
        POOL_GUARD.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn a_task(id: &str) -> ResearchTask {
        ResearchTask {
            id: id.to_string(),
            question: "why?".to_string(),
            depth: ResearchDepth::Quick,
            project_id: None,
            project_root: "/tmp".to_string(),
            status: ResearchStatus::Queued,
            created_at: 1_754_700_000_000,
            started_at: None,
            finished_at: None,
            findings: None,
            error: None,
            read_at: None,
        }
    }

    /// A clock that never moves, so a test asserting a timestamp asserts a value rather than
    /// "something was written".
    fn fixed_clock(at: i64) -> Arc<dyn Fn() -> i64 + Send + Sync> {
        Arc::new(move || at)
    }

    // ── THE SEAM GUARD ───────────────────────────────────────────────────────────────────────────

    /// THE Rust↔TS SEAM GUARD. Its TypeScript twin is `types.test.ts`, and they read THE SAME FILE
    /// — that is the whole point: a field the Rust struct renames or drops fails here, and a field
    /// the TS interface renames or drops fails there, so the two halves cannot drift apart quietly
    /// the way AGENTS.md records them doing once before.
    ///
    /// Round-trips through `serde_json::Value`, not through a string compare: the assertion is
    /// about KEYS AND VALUES (including which keys are present at all), not about whitespace or
    /// key order, and a string compare would fail for reasons that say nothing about the contract.
    #[test]
    fn the_shared_fixture_round_trips() {
        let original = fixture_json();
        let arr = original.as_array().expect("the fixture is an array of tasks");
        assert!(!arr.is_empty(), "an empty fixture would make this test vacuous");

        for item in arr {
            let task: ResearchTask = serde_json::from_value(item.clone()).unwrap_or_else(|e| {
                panic!("the Rust struct must accept every fixture task: {e}\n{item:#}")
            });
            let back = serde_json::to_value(&task).expect("a task must re-serialise");
            assert_eq!(
                &back, item,
                "re-serialising {} must reproduce the fixture byte-for-key",
                task.id
            );
        }
    }

    /// The fixture must exercise every status and both depths, or the round-trip above silently
    /// stops covering the ones it omits. An EXACT match, not a subset: a new status is a failing
    /// test until the fixture gains a case for it. Mirrors the same pair of assertions in
    /// `types.test.ts`.
    #[test]
    fn the_fixture_exercises_every_status_and_both_depths() {
        let tasks: Vec<ResearchTask> =
            serde_json::from_value(fixture_json()).expect("the fixture must deserialize");

        let mut statuses: Vec<String> = tasks
            .iter()
            .map(|t| serde_json::to_value(t.status).unwrap().as_str().unwrap().to_string())
            .collect();
        statuses.sort();
        statuses.dedup();
        assert_eq!(statuses, ["cancelled", "done", "failed", "queued", "running"]);

        let mut depths: Vec<String> = tasks
            .iter()
            .map(|t| serde_json::to_value(t.depth).unwrap().as_str().unwrap().to_string())
            .collect();
        depths.sort();
        depths.dedup();
        assert_eq!(depths, ["deep", "quick"]);
    }

    /// THE DEFECT AGENTS.md RECORDS SHIPPING ONCE. serde emits the key with a `null` value for
    /// `Option::None`; it omits the key ONLY under `skip_serializing_if`. The TS parser is written
    /// against `T | null`, which does not include `undefined`, and an all-or-nothing parse that
    /// rejects one field discards the WHOLE payload — permanently inert, for everyone, nothing
    /// logged, because `None` is what the common case sends.
    ///
    /// Asserts KEY PRESENCE explicitly, not that the value is falsy: "present and null" versus
    /// "absent" is exactly the distinction that broke last time and the one a laxer assertion
    /// cannot see. Adding `skip_serializing_if` to any field below turns this red.
    #[test]
    fn an_option_none_serialises_as_null_not_an_absent_key() {
        let v = serde_json::to_value(a_task("rsh_none")).unwrap();
        let obj = v.as_object().expect("a task serialises to an object");

        for field in ["projectId", "startedAt", "finishedAt", "findings", "error", "readAt"] {
            assert!(
                obj.contains_key(field),
                "`{field}` must be PRESENT for Option::None, not omitted — an absent key makes the \
                 TS parser reject the whole payload silently"
            );
            assert_eq!(obj[field], serde_json::Value::Null, "`{field}` must be null");
        }
        // …and the non-optional fields are camelCase too, so the rename applies to the whole struct.
        for field in ["id", "question", "depth", "projectRoot", "status", "createdAt"] {
            assert!(obj.contains_key(field), "`{field}` must serialise as camelCase");
        }
    }

    // ── THE NON-BLOCKING PROPERTY ────────────────────────────────────────────────────────────────

    /// A spawner that does not finish until it is released. `entered` says the child started;
    /// `release` lets it end.
    struct LatchedSpawner {
        entered: Arc<AtomicBool>,
        release: Arc<AtomicBool>,
        finished: Arc<AtomicBool>,
    }

    impl ResearchSpawner for LatchedSpawner {
        fn kind(&self) -> &'static str {
            "latched"
        }
        fn run(&self, _req: &SpawnRequest, ctl: &Control) -> Result<String, String> {
            self.entered.store(true, Ordering::Release);
            while !self.release.load(Ordering::Acquire) && !ctl.is_cancelled() {
                std::thread::sleep(Duration::from_millis(5));
            }
            self.finished.store(true, Ordering::Release);
            if ctl.is_cancelled() {
                return Err(CANCELLED_SENTINEL.to_string());
            }
            Ok(r#"{"is_error":false,"result":"the answer"}"#.to_string())
        }
    }

    fn wait_until(f: impl Fn() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if f() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        false
    }

    /// THE FEATURE, PINNED. `research_dispatch` must return while the child is still running.
    ///
    /// Run on a WORKER THREAD with a bounded `recv_timeout` rather than called inline, and that
    /// shape is the point: a `dispatch` mutated to await its child would HANG here, and a hanging
    /// test is not a red one — it is a killed run with no signal. Waiting on a channel converts the
    /// same defect into an ordinary assertion failure that names what went wrong.
    ///
    /// MUTATION VERIFIED: replacing the `std::thread::spawn(...)` in `dispatch_with` with an inline
    /// `run_to_completion(...)` call makes this test fail on the `recv_timeout` assertion below
    /// (reported in the commit message) rather than passing quietly.
    #[test]
    fn dispatch_returns_while_the_child_is_still_running() {
        let _pool = pool_guard();
        let dir = tempfile::tempdir().unwrap();
        let entered = Arc::new(AtomicBool::new(false));
        let release = Arc::new(AtomicBool::new(false));
        let finished = Arc::new(AtomicBool::new(false));
        let runner = Arc::new(Runner {
            app_data: dir.path().to_path_buf(),
            spawner: Arc::new(LatchedSpawner {
                entered: Arc::clone(&entered),
                release: Arc::clone(&release),
                finished: Arc::clone(&finished),
            }),
            now: fixed_clock(1_000),
        });

        let (tx, rx) = mpsc::channel();
        let r = Arc::clone(&runner);
        std::thread::spawn(move || {
            let out = dispatch_with(
                r,
                "what changed?",
                Some("proj_sparkle".to_string()),
                PathBuf::from("/tmp"),
                ResearchDepth::Deep,
                None,
            );
            let _ = tx.send(out);
        });

        // THE ASSERTION. Two seconds against a child that will not finish until this test says so:
        // an awaiting dispatch cannot satisfy it.
        let dispatched = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("dispatch must RETURN before the child finishes — it did not")
            .expect("dispatch must succeed");

        assert!(
            !dispatched.status.is_terminal(),
            "dispatch must hand back a live task, got {:?}",
            dispatched.status
        );
        assert_eq!(dispatched.findings, None, "a task that just started has no findings");

        // …and the child really is still live: it entered, and it has not finished.
        assert!(wait_until(|| entered.load(Ordering::Acquire)), "the child must have started");
        assert!(
            !finished.load(Ordering::Acquire),
            "the child must still be running while dispatch has already returned"
        );

        // The task is on disk and findable by the id dispatch handed back.
        let stored = read_task(dir.path(), &dispatched.id).expect("the task must be persisted");
        assert!(!stored.status.is_terminal());

        // Release and let the runner finish, so the thread does not outlive the temp dir.
        release.store(true, Ordering::Release);
        assert!(
            wait_until(|| read_task(dir.path(), &dispatched.id)
                .is_some_and(|t| t.status == ResearchStatus::Done)),
            "the released child's findings must be filed"
        );
        let done = read_task(dir.path(), &dispatched.id).unwrap();
        assert_eq!(done.findings.as_deref(), Some("the answer"));
        assert_eq!(done.started_at, Some(1_000), "startedAt is stamped when the permit is taken");
        assert_eq!(done.finished_at, Some(1_000));
    }

    // ── THE STORE ────────────────────────────────────────────────────────────────────────────────

    /// The read-back rule (bead `sparkle-bbghz`): never acknowledge a write that is not READABLE.
    ///
    /// Driven by making the record unreadable in the one way a caller can arrange deterministically
    /// — the research dir is a FILE, so the write itself cannot land. The assertion is on the
    /// promise (`Err`), not on the mechanism.
    #[test]
    fn a_write_that_cannot_be_read_back_is_reported_as_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        // Occupy `<app_data>/research` with a regular file so no record can be written under it.
        std::fs::write(research_dir(dir.path()), b"not a directory").unwrap();

        let err = write_task(dir.path(), &a_task("rsh_unwritable"))
            .expect_err("a write that cannot be read back must FAIL");
        assert!(err.contains("research:"), "the error must name this subsystem: {err}");
        assert!(
            read_task(dir.path(), "rsh_unwritable").is_none(),
            "and no record may be readable afterwards"
        );
    }

    /// A dispatch whose record cannot be persisted must FAIL rather than hand back an id for a task
    /// that does not exist — and it must not leave a child running for it either.
    #[test]
    fn dispatch_fails_when_the_task_cannot_be_persisted() {
        let _pool = pool_guard();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(research_dir(dir.path()), b"not a directory").unwrap();
        let entered = Arc::new(AtomicBool::new(false));
        let runner = Arc::new(Runner {
            app_data: dir.path().to_path_buf(),
            spawner: Arc::new(LatchedSpawner {
                entered: Arc::clone(&entered),
                release: Arc::new(AtomicBool::new(true)),
                finished: Arc::new(AtomicBool::new(false)),
            }),
            now: fixed_clock(7),
        });

        dispatch_with(runner, "q", None, PathBuf::from("/tmp"), ResearchDepth::Quick, None)
            .expect_err("dispatch must fail when the store cannot read its own write");
        std::thread::sleep(Duration::from_millis(50));
        assert!(
            !entered.load(Ordering::Acquire),
            "no child may be spawned for a task that was never recorded"
        );
    }

    #[test]
    fn a_task_id_that_would_escape_the_research_dir_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        for bad in ["../escape", "a/b", "", "with space", "dot.dot"] {
            assert!(valid_task_id(bad).is_err(), "{bad:?} must be refused");
            assert!(read_task(dir.path(), bad).is_none(), "{bad:?} must read as nothing");
        }
        assert!(valid_task_id("rsh_0001_deadbeef").is_ok());
    }

    #[test]
    fn listing_is_newest_first_and_skips_unreadable_records() {
        let dir = tempfile::tempdir().unwrap();
        for (id, created) in [("rsh_old", 100_i64), ("rsh_new", 300), ("rsh_mid", 200)] {
            let mut t = a_task(id);
            t.created_at = created;
            write_task(dir.path(), &t).unwrap();
        }
        // A corrupt record and a stray temp file must not hide the rest.
        std::fs::write(research_dir(dir.path()).join("rsh_broken.json"), b"{oops").unwrap();
        std::fs::write(research_dir(dir.path()).join("rsh_partial.json.tmp"), b"{}").unwrap();

        let ids: Vec<String> = list_tasks(dir.path()).into_iter().map(|t| t.id).collect();
        assert_eq!(ids, ["rsh_new", "rsh_mid", "rsh_old"]);
    }

    #[test]
    fn listing_an_app_data_with_no_research_dir_is_empty_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(list_tasks(dir.path()).is_empty());
    }

    /// The store is `<app_data>/research`, NEVER `<app_data>/inbox` — `retention::reap_inbox`
    /// parses every `<id>.jsonl` under `inbox/` as an AGENT id and deletes the ones with no live
    /// worktree, which would reap every research record.
    #[test]
    fn records_live_outside_the_inbox_where_retention_would_reap_them() {
        let dir = tempfile::tempdir().unwrap();
        write_task(dir.path(), &a_task("rsh_kept")).unwrap();
        assert_eq!(research_dir(dir.path()), dir.path().join("research"));
        assert!(
            !dir.path().join("inbox").exists(),
            "a research write must never create anything under inbox/"
        );
    }

    // ── CANCEL ───────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn cancel_stops_a_running_task_and_records_it_as_cancelled_not_failed() {
        let _pool = pool_guard();
        let dir = tempfile::tempdir().unwrap();
        let entered = Arc::new(AtomicBool::new(false));
        let runner = Arc::new(Runner {
            app_data: dir.path().to_path_buf(),
            spawner: Arc::new(LatchedSpawner {
                entered: Arc::clone(&entered),
                release: Arc::new(AtomicBool::new(false)),
                finished: Arc::new(AtomicBool::new(false)),
            }),
            now: fixed_clock(4_242),
        });

        let task = dispatch_with(
            Arc::clone(&runner),
            "trace every caller",
            None,
            PathBuf::from("/tmp"),
            ResearchDepth::Quick,
            None,
        )
        .unwrap();
        assert!(wait_until(|| entered.load(Ordering::Acquire)), "the child must be running");

        let cancelled = cancel_task(&runner, &task.id).expect("cancel must succeed");
        assert_eq!(cancelled.status, ResearchStatus::Cancelled);
        assert_eq!(cancelled.finished_at, Some(4_242));
        assert_eq!(cancelled.error, None, "a cancelled task is not a broken one");

        // THE RACE. The runner thread comes home moments later and must NOT relabel this as failed
        // — the first terminal write wins.
        assert!(
            wait_until(|| !live_controls().lock().unwrap().contains_key(&task.id)),
            "the runner thread must finish"
        );
        let settled = read_task(dir.path(), &task.id).unwrap();
        assert_eq!(
            settled.status,
            ResearchStatus::Cancelled,
            "the runner must not overwrite a cancellation with a failure"
        );
        assert_eq!(settled.findings, None);
    }

    #[test]
    fn cancelling_a_finished_task_returns_it_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let runner = Runner {
            app_data: dir.path().to_path_buf(),
            spawner: Arc::new(CliSpawner),
            now: fixed_clock(99),
        };
        let mut done = a_task("rsh_done");
        done.status = ResearchStatus::Done;
        done.finished_at = Some(50);
        done.findings = Some("already answered".to_string());
        write_task(dir.path(), &done).unwrap();

        let out = cancel_task(&runner, "rsh_done").unwrap();
        assert_eq!(out, done, "a finished task must come back untouched");
    }

    #[test]
    fn cancelling_an_unknown_task_is_an_error_not_a_silent_ok() {
        let dir = tempfile::tempdir().unwrap();
        let runner = Runner {
            app_data: dir.path().to_path_buf(),
            spawner: Arc::new(CliSpawner),
            now: fixed_clock(1),
        };
        assert!(cancel_task(&runner, "rsh_missing").is_err());
    }

    // ── THE CLAIM ────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn mark_read_stamps_only_unclaimed_tasks_and_never_re_stamps() {
        let dir = tempfile::tempdir().unwrap();
        let runner = Runner {
            app_data: dir.path().to_path_buf(),
            spawner: Arc::new(CliSpawner),
            now: fixed_clock(0),
        };

        let mut fresh = a_task("rsh_fresh");
        fresh.status = ResearchStatus::Done;
        fresh.findings = Some("f".to_string());
        write_task(dir.path(), &fresh).unwrap();

        let mut claimed = a_task("rsh_claimed");
        claimed.status = ResearchStatus::Done;
        claimed.findings = Some("f".to_string());
        claimed.read_at = Some(111);
        write_task(dir.path(), &claimed).unwrap();

        mark_read(&runner, &["rsh_fresh".into(), "rsh_claimed".into()], 999).unwrap();

        assert_eq!(read_task(dir.path(), "rsh_fresh").unwrap().read_at, Some(999));
        assert_eq!(
            read_task(dir.path(), "rsh_claimed").unwrap().read_at,
            Some(111),
            "the FIRST claim wins — re-stamping destroys the only record of when he was told"
        );
    }

    /// A claim stamps `readAt` on a TERMINAL record, so it must not route through `update_task`
    /// (which keeps terminal records unchanged). Pinned because the natural refactor is to reuse it.
    #[test]
    fn a_claim_reaches_a_done_task_even_though_done_is_terminal() {
        let dir = tempfile::tempdir().unwrap();
        let runner = Runner {
            app_data: dir.path().to_path_buf(),
            spawner: Arc::new(CliSpawner),
            now: fixed_clock(0),
        };
        let mut done = a_task("rsh_terminal");
        done.status = ResearchStatus::Done;
        done.findings = Some("f".to_string());
        write_task(dir.path(), &done).unwrap();
        assert!(done.status.is_terminal(), "the premise: done IS terminal");

        mark_read(&runner, &["rsh_terminal".into()], 555).unwrap();
        assert_eq!(read_task(dir.path(), "rsh_terminal").unwrap().read_at, Some(555));
    }

    /// One bad id must not silently drop the claims that would have succeeded — those findings
    /// would then be re-told on every turn forever.
    #[test]
    fn mark_read_claims_every_good_id_and_still_reports_the_bad_one() {
        let dir = tempfile::tempdir().unwrap();
        let runner = Runner {
            app_data: dir.path().to_path_buf(),
            spawner: Arc::new(CliSpawner),
            now: fixed_clock(0),
        };
        let mut good = a_task("rsh_good");
        good.status = ResearchStatus::Done;
        good.findings = Some("f".to_string());
        write_task(dir.path(), &good).unwrap();

        let err = mark_read(&runner, &["rsh_missing".into(), "rsh_good".into()], 42)
            .expect_err("an unknown id must be reported");
        assert!(err.contains("rsh_missing"), "{err}");
        assert_eq!(
            read_task(dir.path(), "rsh_good").unwrap().read_at,
            Some(42),
            "the good id must still have been claimed"
        );
    }

    #[test]
    fn is_unread_is_done_only() {
        let mut t = a_task("rsh_u");
        t.status = ResearchStatus::Done;
        t.findings = Some("f".to_string());
        assert!(t.is_unread());
        t.read_at = Some(1);
        assert!(!t.is_unread(), "a claimed task is read");
        t.read_at = None;
        t.status = ResearchStatus::Failed;
        assert!(!t.is_unread(), "a failure is not a finding");
        t.status = ResearchStatus::Cancelled;
        assert!(!t.is_unread(), "a task he killed is never re-narrated");
    }

    // ── THE POOL ─────────────────────────────────────────────────────────────────────────────────

    /// POOL ISOLATION, BEHAVIOURAL HALF: research's counters are this module's own statics, so
    /// saturating the research pool moves ONLY them.
    ///
    /// Driven over the production pool (`research_pool()`), not a copy — a test built on a
    /// hand-made `Pool` would keep passing if the production one were rewired.
    #[test]
    fn the_research_pool_uses_its_own_counters() {
        let _pool = pool_guard();
        let pool = research_pool();
        assert!(
            std::ptr::eq(pool.inflight, &RESEARCH_INFLIGHT),
            "the production pool must count in this module's own inflight counter"
        );
        assert!(std::ptr::eq(pool.waiting, &RESEARCH_WAITING));
        assert_eq!(pool.cap, MAX_CONCURRENT_RESEARCH);
        assert_eq!(pool.room, MAX_RESEARCH_WAITERS);

        // Taking a research permit moves the research counter and nothing else.
        let before = RESEARCH_INFLIGHT.load(Ordering::Acquire);
        let p = try_take(pool.inflight, pool.cap + before + 1).expect("a permit must be available");
        assert_eq!(RESEARCH_INFLIGHT.load(Ordering::Acquire), before + 1);
        drop(p);
        assert_eq!(RESEARCH_INFLIGHT.load(Ordering::Acquire), before);
    }

    /// THE POOL IS UNCORKED. The founder raised the cap so ~16 research children run at once instead
    /// of draining two at a time. Read off the PRODUCTION pool (`research_pool()`), not the raw
    /// constant, so it proves the value the acquire path actually enforces — a revert to the old
    /// throttle of 2 reds here.
    #[test]
    fn the_dispatch_pool_runs_many_children_in_parallel() {
        let _pool = pool_guard();
        assert!(
            research_pool().cap >= 16,
            "the concierge fans ~20 questions out and expects ~16 running at once, got a cap of {}",
            research_pool().cap
        );
    }

    /// POOL ISOLATION, STRUCTURAL HALF — and this is the one that catches the regression that
    /// matters. The behavioural test above cannot see a rewiring onto `claude_oneshot`'s pool,
    /// because `claude_oneshot::INFLIGHT` is private and there is nothing to read it with. The way
    /// that rewiring would actually be written is a call to `claude_oneshot::run*` (whose
    /// `run_with_pool` takes counters), so this asserts on the source that no such call exists.
    ///
    /// A 15-minute research child holding one of that pool's three background permits starves
    /// agent auto-naming and the followup judge for fifteen minutes, and nothing else in the app
    /// would report it — the judge would simply return `ai_busy` and `turnFollowup.ts` cannot tell
    /// a refusal from a real failure.
    #[test]
    fn research_never_borrows_the_claude_oneshot_pool() {
        let whole = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/research.rs"))
            .expect("this module's own source must be readable");
        // SCAN THE IMPLEMENTATION ONLY, NOT THIS TEST.
        //
        // The first version scanned the whole file — including the `forbidden` list three lines
        // below, which contains every one of those strings verbatim. So the guard was unsatisfiable
        // by construction: it failed on its own source and could never have gone green, whatever
        // the implementation did. A guard that cannot pass is as useless as one that cannot fail.
        let src = whole
            .split_once("#[cfg(test)]")
            .map(|(impl_src, _)| impl_src)
            .expect("this module must have a #[cfg(test)] block for the scan to be bounded");
        // The env scrub helpers are fine to share; the POOL is not.
        for forbidden in
            ["claude_oneshot::run(", "claude_oneshot::run_with", "claude_oneshot::INFLIGHT"]
        {
            assert!(
                !src.contains(forbidden),
                "research must not route through `{forbidden}` — that pool is tuned for 2-60s \
                 calls and a 15-minute research child would hold one of its permits the whole time"
            );
        }
        assert!(
            src.contains("static RESEARCH_INFLIGHT"),
            "…and it must keep counters of its own"
        );
    }

    /// THE POOL GUARD IS ENFORCED IN SOURCE, NOT IN A DOC COMMENT.
    ///
    /// The defect `POOL_GUARD` repairs is INTERMITTENT — two permit-holding tests racing a third —
    /// so its own regression test would otherwise be "it happened to pass," and the membership rule
    /// would live only in prose. The next test to call `dispatch_with` (a store test, a claim test —
    /// nothing that looks like a pool test) would reintroduce the saturation silently, and the red
    /// would land on an unrelated test's `wait_until` bound (roborev 61741).
    ///
    /// So the rule is checked mechanically, in the same source-scanning idiom as
    /// `research_never_borrows_the_claude_oneshot_pool` above. Two things make the scan honest:
    /// comment lines are stripped, so a doc comment that MENTIONS a pool call cannot pass as one;
    /// and this test excludes ITSELF by name, because the needles below appear verbatim in its own
    /// body — the same self-satisfying trap its sibling records having shipped once.
    #[test]
    fn every_test_that_touches_the_global_pool_takes_the_guard() {
        const SELF: &str = "every_test_that_touches_the_global_pool_takes_the_guard";
        let whole = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/research.rs"))
            .expect("this module's own source must be readable");
        let (_, tests_src) = whole
            .split_once("#[cfg(test)]")
            .expect("this module must have a #[cfg(test)] block for the scan to be bounded");

        let mut checked = 0usize;
        for chunk in tests_src.split("#[test]").skip(1) {
            let name = chunk
                .lines()
                .find_map(|l| l.trim().strip_prefix("fn ").and_then(|r| r.split('(').next()))
                .unwrap_or("<unnamed>");
            if name == SELF {
                continue;
            }
            // Strip every comment line: a `///` paragraph that names a pool call is prose, not a
            // call, and counting it would make this scan report tests it cannot really see.
            let body = chunk
                .lines()
                .filter(|l| !l.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n");
            if !["dispatch_with(", "run_to_completion(", "research_pool()"]
                .iter()
                .any(|needle| body.contains(needle))
            {
                continue;
            }
            checked += 1;
            assert!(
                body.contains("pool_guard()"),
                "`{name}` reaches the process-global research pool but does not take \
                 `pool_guard()`. Two such tests running in parallel saturate the cap-2 pool and a \
                 THIRD then fails on a bound that has nothing to do with what it tests — a red that \
                 names the wrong test and comes and goes with scheduling."
            );
        }
        // …and the scan must actually have found them. A rename that made every needle miss would
        // otherwise leave this test green while checking nothing at all.
        assert!(
            checked >= 5,
            "the scan must reach the pool-touching tests; it found only {checked}"
        );
    }

    /// The waiting room absorbs a burst and only refuses at its FAR EDGE — the honest engineering
    /// of "no cap". Driven over the real `acquire` with a tiny pool so the far edge is reachable.
    #[test]
    fn over_the_pool_bound_a_task_queues_and_only_the_far_edge_refuses() {
        let inflight = AtomicUsize::new(0);
        let waiting = AtomicUsize::new(0);
        let pool = Pool { inflight: &inflight, waiting: &waiting, cap: 1, room: 1 };
        let never = AtomicBool::new(false);

        let held = acquire(&pool, Duration::from_millis(10), &never).expect("the first gets a slot");
        // The second QUEUES (it takes the only seat) and then times out rather than being refused
        // instantly — the seat is what proves it queued.
        let second = acquire(&pool, Duration::from_millis(300), &never);
        assert!(second.is_err(), "the pool is full, so it cannot have got a slot");
        let msg = second.err().unwrap();
        assert!(msg.contains("waited"), "a queued task that expires says so: {msg}");

        // With the room occupied, the far edge refuses IMMEDIATELY and says why.
        let _seat = enter_room(&waiting, 1).expect("occupy the only seat");
        let started = Instant::now();
        let refused = acquire(&pool, Duration::from_secs(30), &never)
            .expect_err("the far edge of the waiting room must refuse");
        assert!(started.elapsed() < Duration::from_secs(5), "the refusal must be immediate");
        assert!(refused.contains("already queued"), "and it must be honest: {refused}");
        drop(held);
    }

    /// A permit is released on drop, so a queued task actually gets the freed slot.
    #[test]
    fn a_released_permit_is_handed_to_a_waiting_task() {
        let inflight = AtomicUsize::new(0);
        let waiting = AtomicUsize::new(0);
        let never = AtomicBool::new(false);
        {
            let pool = Pool { inflight: &inflight, waiting: &waiting, cap: 1, room: 4 };
            let _held = acquire(&pool, Duration::from_millis(10), &never).unwrap();
            assert_eq!(inflight.load(Ordering::Acquire), 1);
        }
        assert_eq!(inflight.load(Ordering::Acquire), 0, "drop must release the slot");
        let pool = Pool { inflight: &inflight, waiting: &waiting, cap: 1, room: 4 };
        assert!(acquire(&pool, Duration::from_millis(10), &never).is_ok());
    }

    /// A task cancelled while QUEUED must stop queueing rather than hold a seat for an hour and
    /// then run a question the founder already killed.
    #[test]
    fn a_task_cancelled_while_queued_stops_waiting() {
        // NO `pool_guard()`: this drives `acquire` over a LOCAL pool and never touches
        // `RESEARCH_INFLIGHT`/`RESEARCH_WAITING`, so it is independent of every other test. Taking
        // the guard here would teach the next reader the wrong rule — see POOL_GUARD's own doc.
        let inflight = AtomicUsize::new(1);
        let waiting = AtomicUsize::new(0);
        let pool = Pool { inflight: &inflight, waiting: &waiting, cap: 1, room: 4 };
        let cancelled = AtomicBool::new(true);
        let err = acquire(&pool, Duration::from_secs(30), &cancelled)
            .expect_err("a cancelled task must not keep queueing");
        assert!(err.contains("cancelled"), "{err}");
    }

    // ── THE CHILD ────────────────────────────────────────────────────────────────────────────────

    /// `-p <question>` MUST be first: `--allowedTools` / `--disallowedTools` are variadic in the
    /// CLI's parser and a variadic flag immediately followed by a bare positional swallows it.
    #[test]
    fn the_question_leads_the_argv_so_a_variadic_flag_cannot_swallow_it() {
        let args = build_research_args("what changed?", "m", "persona");
        assert_eq!(args[0], "-p");
        assert_eq!(args[1], "what changed?");
        // …and nothing bare follows a variadic flag.
        for (i, a) in args.iter().enumerate() {
            if a == "--allowedTools" || a == "--disallowedTools" {
                assert!(
                    args.get(i + 1).is_some_and(|n| !n.starts_with("--")),
                    "{a} must be followed by its value"
                );
            }
        }
    }

    /// The tool flags are the whole safety story, and `--tools ""` — which `claude_oneshot` uses —
    /// would be FATAL here: it removes ALL built-in tools, so a research pass could not read a file.
    #[test]
    fn the_tool_set_is_closed_and_uses_the_flag_that_actually_restricts() {
        let args = build_research_args("q", "m", "p");
        let at = |flag: &str| {
            args.iter().position(|a| a == flag).map(|i| args[i + 1].clone())
        };
        assert_eq!(at("--tools").as_deref(), Some(RESEARCH_TOOL_SET));

        // THE FLAGS THAT LOOK LIKE A GATE AND ARE NOT. Both were measured inert in headless `-p`
        // (see RESEARCH_TOOL_SET for the five probes): bash ran even with `Bash` explicitly in
        // `--disallowedTools`. Passing them would restrict nothing while reading, to the next
        // person, as the safety boundary — which is exactly how the previous version of this file
        // came to document a guarantee it did not provide.
        for inert in ["--allowedTools", "--disallowedTools"] {
            assert!(
                !args.iter().any(|a| a == inert),
                "{inert} does not restrict anything in `-p` — passing it only misleads"
            );
        }

        // ══ THE ASSERTION THAT CARRIES THE NAME OF THIS TEST ════════════════════════════════════
        //
        // The previous version compared the two flags to string literals and stopped. That passed
        // while `Bash` was granted UNSCOPED next to `--dangerously-skip-permissions` in the
        // founder's live repo — so the test asserted the flags were "what they are", and its name
        // ("can read but cannot write") stated a guarantee the argv did not provide. A vacuous test
        // for the single property that matters most (roborev 61696).
        //
        // A bare `Bash` token is the whole risk: with it, `--disallowedTools Edit,Write` is
        // decorative (`bash -c 'echo > file'`, `git push`, `rm` all route around it). Every shell
        // entry must therefore be scoped as `Bash(cmd:*)`.
        // THE SET IS CLOSED, and these two absences are the containment that is actually real.
        // A scoped `Bash(git log:*)` is NOT available as a middle ground — `--tools` drops the
        // scoped form silently, leaving no shell at all — so the honest guarantee is "no write
        // tools", not "a restricted shell".
        let set = at("--tools").expect("--tools must be passed");
        for forbidden in ["Edit", "Write", "NotebookEdit"] {
            assert!(
                !set.split(',').any(|t| t == forbidden),
                "{forbidden} must not be in the research tool set"
            );
        }
        assert!(
            set.split(',').any(|t| t == "Bash"),
            "the shell is what makes git archaeology possible, and it cannot be scoped here"
        );
        assert!(
            !set.contains("Bash("),
            "a scoped Bash entry is silently DROPPED by --tools, leaving the child with no shell"
        );
        // `--tools` is passed, and its VALUE is what matters: an empty string would remove every
        // built-in tool (what `claude_oneshot` wants for a pure-text judge, and fatal for a runner
        // whose job is to read).
        assert!(
            !set.is_empty(),
            "`--tools \"\"` removes ALL built-in tools — fatal for a runner whose job is to read"
        );
        // APPEND, not replace: the child needs its normal tool-use behaviour intact.
        assert!(args.iter().any(|a| a == "--append-system-prompt"));
        assert!(!args.iter().any(|a| a == "--system-prompt"));
        for flag in [
            "--output-format",
            "--model",
            "--dangerously-skip-permissions",
            "--strict-mcp-config",
            "--no-session-persistence",
        ] {
            assert!(args.iter().any(|a| a == flag), "{flag} must be present");
        }
        // THE LIVE-TAIL CONTRACT: the child must STREAM its work, not buffer it to a single object.
        // `--output-format stream-json` is what emits one event per line as it goes, and `--verbose`
        // is what the CLI requires before it will stream under `-p`. A revert to the old buffered
        // `json` (or dropping `--verbose`) silently kills the live tail — nothing else would notice —
        // so it is pinned here as a VALUE, not just a flag presence.
        let fmt = at("--output-format").expect("--output-format must be passed");
        assert_eq!(fmt, "stream-json", "the runner must stream events for the live tail");
        assert!(
            args.iter().any(|a| a == "--verbose"),
            "--verbose is REQUIRED by the CLI to stream under -p; without it the child refuses"
        );
    }

    /// The terminal `result` event is recognised by its `type`, and by the field-presence fallback —
    /// both must hold, because `CliSpawner::run` returns exactly that line for `classify_result`.
    #[test]
    fn is_result_event_matches_the_terminal_object_only() {
        let result = serde_json::json!({"type":"result","is_error":false,"result":"done"});
        let assistant = serde_json::json!({"type":"assistant","message":{"content":[]}});
        let system = serde_json::json!({"type":"system","subtype":"init"});
        // The old single-object `json` shape had no `type` — the fallback must still call it a result.
        let legacy = serde_json::json!({"is_error":true,"result":"oops"});
        assert!(is_result_event(&result));
        assert!(is_result_event(&legacy));
        assert!(!is_result_event(&assistant));
        assert!(!is_result_event(&system));
    }

    /// An assistant event yields its text (collapsed to one line) and a brief line per tool call;
    /// non-assistant events yield nothing, so a whole file's contents (a tool RESULT) never leaks in.
    // ── THE MODEL OVERRIDE (bead `sparkle-revqiv`) ───────────────────────────────────────────────

    /// An ABSENT override runs the depth's pinned model — the behaviour every pre-existing caller
    /// has, asserted so adding the parameter cannot have moved the default.
    #[test]
    fn no_override_keeps_the_pinned_model() {
        assert_eq!(
            resolve_research_model(ResearchDepth::Quick, None).unwrap(),
            RESEARCH_MODEL
        );
        assert_eq!(
            resolve_research_model(ResearchDepth::Deep, None).unwrap(),
            RESEARCH_MODEL
        );
        // A BLANK string is "no override", not an unknown id: an options object with an unset
        // field serializes to exactly this, and refusing it would break dispatches nobody
        // overrode.
        assert_eq!(
            resolve_research_model(ResearchDepth::Quick, Some("   ")).unwrap(),
            RESEARCH_MODEL
        );
    }

    /// An allow-listed override is HONOURED — and the id asserted is one that is NOT the default,
    /// so this cannot pass against a resolver that ignores its argument entirely.
    #[test]
    fn an_allowlisted_override_is_honoured_and_differs_from_the_default() {
        let picked = resolve_research_model(ResearchDepth::Quick, Some("claude-sonnet-5")).unwrap();
        assert_eq!(picked, "claude-sonnet-5");
        assert_ne!(
            picked, RESEARCH_MODEL,
            "the assertion is vacuous unless the override differs from the pinned default"
        );
    }

    /// An UNKNOWN id is REFUSED, never silently downgraded to the default.
    ///
    /// The silent-fallback shape is what makes this worth a test: a caller would get a task that
    /// ran and answered, attributed to a model it never used. For the advisor pass that is not
    /// cosmetic — a fallback onto the planner's own tier turns second-model review back into
    /// self-review, with nothing anywhere reporting that it had.
    #[test]
    fn an_unknown_model_is_refused_rather_than_defaulted() {
        let err = resolve_research_model(ResearchDepth::Quick, Some("gpt-4o"))
            .expect_err("an off-list id must not resolve");
        assert!(err.contains("gpt-4o"), "the refusal must name what was asked for: {err}");
        assert!(
            err.contains("claude-opus-5"),
            "and must name what IS allowed, so the caller can correct itself: {err}"
        );
        // The planner's own model is deliberately NOT on the list either — see ai.rs CHAT_MODEL.
        assert!(
            resolve_research_model(ResearchDepth::Quick, Some(crate::ai::CHAT_MODEL)).is_err(),
            "the planner's chat model must not be dispatchable as a research/advisor child"
        );
    }

    /// A refused model leaves NOTHING BEHIND — the check runs before the task record is written.
    #[test]
    fn a_refused_model_records_no_task() {
        let _pool = pool_guard();
        let dir = tempfile::tempdir().unwrap();
        let runner = Arc::new(Runner {
            app_data: dir.path().to_path_buf(),
            spawner: Arc::new(CliSpawner),
            now: fixed_clock(0),
        });
        assert!(dispatch_with(
            runner,
            "a real question",
            None,
            PathBuf::from("/tmp"),
            ResearchDepth::Quick,
            Some("not-a-model"),
        )
        .is_err());
        assert!(
            list_tasks(dir.path()).is_empty(),
            "a task must not exist for a dispatch that was refused"
        );
    }

    /// THE SIDE EFFECT, not the resolver: the override must reach the CHILD'S ARGV.
    ///
    /// `resolve_research_model` returning the right string proves nothing about what is executed —
    /// the value has to travel through `SpawnRequest.model` into `build_research_args`. This
    /// asserts the pair, which is what a `req.depth.model()` regression at the spawn site would
    /// break while every resolver test above stayed green.
    #[test]
    fn the_resolved_model_reaches_the_child_argv() {
        let model = resolve_research_model(ResearchDepth::Quick, Some("claude-haiku-4-5")).unwrap();
        let req = SpawnRequest {
            question: "q".to_string(),
            depth: ResearchDepth::Quick,
            model: model.clone(),
            project_root: PathBuf::from("/tmp"),
            tail_path: None,
        };
        let args = build_research_args(&req.question, &req.model, RESEARCH_PERSONA);
        let at = args.iter().position(|a| a == "--model").expect("--model must be passed");
        assert_eq!(args[at + 1], "claude-haiku-4-5");
        assert_ne!(
            args[at + 1], RESEARCH_MODEL,
            "vacuous unless the argv carries the OVERRIDE rather than the pinned default"
        );
    }

    #[test]
    fn extract_tail_lines_speaks_only_for_assistant_events() {
        let ev = serde_json::json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "text", "text": "Looking at\nthe commit history" },
                { "type": "tool_use", "name": "Bash", "input": { "command": "git log --oneline" } },
                { "type": "tool_use", "name": "Read", "input": { "file_path": "src/x.rs" } },
            ]},
        });
        let lines = extract_tail_lines(&ev);
        assert_eq!(
            lines,
            vec![
                "Looking at the commit history".to_string(),
                "→ Bash: git log --oneline".to_string(),
                "→ Read: src/x.rs".to_string(),
            ]
        );
        // A tool RESULT (a `user` event) is where a file body / the echoed question would leak — it
        // must contribute NOTHING to the tail.
        let tool_result = serde_json::json!({
            "type": "user",
            "message": { "content": [
                { "type": "tool_result", "content": "the entire contents of a large file" }
            ]},
        });
        assert!(extract_tail_lines(&tool_result).is_empty());
    }

    /// The rolling buffer keeps only the last TAIL_MAX_LINES, truncates a giant line, and renders
    /// newest-last within the char ceiling — the two caps that keep the sidecar from ever growing.
    #[test]
    fn the_tail_is_bounded_in_lines_chars_and_line_length() {
        let mut buf = std::collections::VecDeque::new();
        for i in 0..(TAIL_MAX_LINES + 25) {
            push_tail_line(&mut buf, &format!("line {i}"));
        }
        assert_eq!(buf.len(), TAIL_MAX_LINES, "the oldest lines must be evicted");
        // Newest is retained, oldest is gone.
        assert_eq!(buf.back().unwrap(), &format!("line {}", TAIL_MAX_LINES + 24));
        assert_eq!(buf.front().unwrap(), &format!("line {}", 25));

        // A single over-long line is truncated char-safely (no panic on a multi-byte boundary).
        let mut one = std::collections::VecDeque::new();
        push_tail_line(&mut one, &"é".repeat(TAIL_LINE_MAX_CHARS + 500));
        assert_eq!(one.back().unwrap().chars().count(), TAIL_LINE_MAX_CHARS);

        // Empty / whitespace lines are dropped, never stored.
        let mut skip = std::collections::VecDeque::new();
        push_tail_line(&mut skip, "   ");
        assert!(skip.is_empty());

        // render caps total chars by keeping the MOST RECENT ones. 40 lines × 200 chars ≈ 8k > 6k,
        // so the render must clip — and it clips the FRONT, keeping the tail's end.
        let mut big = std::collections::VecDeque::new();
        for _ in 0..TAIL_MAX_LINES {
            push_tail_line(&mut big, &"x".repeat(TAIL_LINE_MAX_CHARS));
        }
        push_tail_line(&mut big, "THE-NEWEST-LINE");
        let rendered = render_tail(&big);
        assert!(rendered.chars().count() <= TAIL_MAX_CHARS, "the render must obey the char ceiling");
        assert!(rendered.ends_with("THE-NEWEST-LINE"), "the render keeps the most recent output");
    }

    /// ONE capable, unthrottled tier. The founder collapsed cheap/deep: both depths now run the same
    /// Opus-class model with no artificial wall. This asserts the values the child is actually
    /// LAUNCHED with — the model in its argv and the deadline it runs under — via the same `model()`
    /// / `timeout()` the spawner calls, so a revert to the old sonnet/opus tiering or the 3/15-minute
    /// walls reds here.
    #[test]
    fn both_depths_run_the_same_capable_model_with_no_artificial_wall() {
        // Both tiers pin the SAME capable model — cheap/deep collapsed.
        assert_eq!(ResearchDepth::Quick.model(), RESEARCH_MODEL);
        assert_eq!(ResearchDepth::Deep.model(), RESEARCH_MODEL);
        assert_eq!(
            ResearchDepth::Quick.model(),
            ResearchDepth::Deep.model(),
            "the tiers no longer buy different models — both are as capable as the concierge"
        );
        assert!(
            RESEARCH_MODEL.starts_with("claude-opus-"),
            "the dispatched child must be Opus-class, got {RESEARCH_MODEL}"
        );
        // …and the model reaches the argv the CLI is actually launched with.
        let args = build_research_args("q", ResearchDepth::Quick.model(), "p");
        let model_at = args.iter().position(|a| a == "--model").map(|i| args[i + 1].clone());
        assert_eq!(model_at.as_deref(), Some(RESEARCH_MODEL), "--model must carry the pinned id");

        // The automatic time wall is GONE. Neither depth is bounded by the old 3/15-minute throttle;
        // what remains is only a multi-day safety backstop.
        assert_eq!(ResearchDepth::Quick.timeout(), RESEARCH_TIMEOUT);
        assert_eq!(ResearchDepth::Deep.timeout(), RESEARCH_TIMEOUT);
        assert!(
            ResearchDepth::Deep.timeout() >= Duration::from_secs(24 * 60 * 60),
            "the wall is lifted — a research pass runs as long as it takes, not a 15-minute cap"
        );
    }

    /// THE EXIT CODE AND `subtype` BOTH LIE — only `is_error` tells the truth. These are real
    /// captures: the process exits 0 and `subtype` stays `"success"` for both.
    #[test]
    fn only_is_error_decides_the_outcome() {
        let not_logged_in: serde_json::Value = serde_json::from_str(
            r#"{"is_error":true,"subtype":"success","terminal_reason":"api_error",
                "api_error_status":null,"result":"Not logged in · Please run /login"}"#,
        )
        .unwrap();
        match classify_result(&not_logged_in) {
            Outcome::Failed(msg) => assert!(
                msg.contains("not signed in"),
                "a signed-out CLI must be reported as such, not filed as a finding: {msg}"
            ),
            Outcome::Findings(f) => {
                panic!("`subtype: success` must not make this a finding — got {f:?}")
            }
        }

        let real = serde_json::json!({"is_error": false, "subtype": "success", "result": "  the answer  "});
        assert_eq!(classify_result(&real), Outcome::Findings("the answer".to_string()));

        let blank = serde_json::json!({"is_error": false, "result": "   "});
        assert!(matches!(classify_result(&blank), Outcome::Failed(_)), "a blank reply is a failure");
    }

    /// The failure message must never echo the whole `result` body — it can quote the REQUEST back,
    /// and the request here is the founder's question.
    #[test]
    fn a_failure_message_is_bounded_and_never_echoes_the_whole_body() {
        let huge = "x".repeat(5_000);
        let msg = cli_failure_message(&huge);
        assert!(msg.len() < 300, "the message must be bounded, got {} chars", msg.len());

        assert!(cli_failure_message("Claude usage limit reached").contains("allowance is spent"));
        assert!(cli_failure_message("").contains("without producing findings"));
    }

    /// A run that reported an error must land as `failed` WITH a message and no findings — not as
    /// `done` with the error prose as its answer.
    #[test]
    fn a_cli_error_is_filed_as_a_failure_not_as_findings() {
        let _pool = pool_guard();
        struct ErrorSpawner;
        impl ResearchSpawner for ErrorSpawner {
            fn kind(&self) -> &'static str {
                "error"
            }
            fn run(&self, _r: &SpawnRequest, _c: &Control) -> Result<String, String> {
                Ok(r#"{"is_error":true,"subtype":"success","result":"Not logged in · Please run /login"}"#
                    .to_string())
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let runner = Arc::new(Runner {
            app_data: dir.path().to_path_buf(),
            spawner: Arc::new(ErrorSpawner),
            now: fixed_clock(8_000),
        });
        let task =
            dispatch_with(runner, "q", None, PathBuf::from("/tmp"), ResearchDepth::Quick, None)
                .unwrap();

        assert!(
            wait_until(|| read_task(dir.path(), &task.id)
                .is_some_and(|t| t.status.is_terminal())),
            "the runner must reach a terminal state"
        );
        let settled = read_task(dir.path(), &task.id).unwrap();
        assert_eq!(settled.status, ResearchStatus::Failed);
        assert_eq!(settled.findings, None, "error prose must never be filed as a finding");
        assert!(settled.error.is_some_and(|e| e.contains("not signed in")));
    }

    /// The production wiring line is load-bearing: delete or change it and this reds. Without this
    /// the only path that supplies the REAL spawner would be covered by nothing, because every
    /// other test injects its own (AGENTS.md's defaulted-seam trap).
    #[test]
    fn production_wires_the_real_spawner() {
        let r = Runner::production(PathBuf::from("/tmp"));
        assert_eq!(r.spawner.kind(), "cli");
        assert_eq!(r.app_data, PathBuf::from("/tmp"));
        // …and its clock is a real one, not a frozen test stub.
        assert!((r.now)() > 1_700_000_000_000, "production must use a real epoch-ms clock");
    }

    /// The five command names are a cross-language contract with `RESEARCH_COMMANDS` in store.ts,
    /// and a typo in an `invoke` string is a runtime failure with no compile-time signal. Pinned
    /// against the TS file itself so a rename on either side fails here.
    #[test]
    fn the_five_command_names_match_the_typescript_contract() {
        let store = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/services/research/store.ts"
        ))
        .expect("store.ts must be readable");
        for name in [
            "research_dispatch",
            "research_list",
            "research_get",
            "research_cancel",
            "research_mark_read",
        ] {
            assert!(
                store.contains(&format!("\"{name}\"")),
                "store.ts must still name the `{name}` command"
            );
        }
    }

    #[test]
    fn a_dispatch_with_no_question_is_refused() {
        let _pool = pool_guard();
        let dir = tempfile::tempdir().unwrap();
        let runner = Arc::new(Runner {
            app_data: dir.path().to_path_buf(),
            spawner: Arc::new(CliSpawner),
            now: fixed_clock(0),
        });
        assert!(dispatch_with(runner, "   ", None, PathBuf::from("/tmp"), ResearchDepth::Quick, None)
            .is_err());
        assert!(list_tasks(dir.path()).is_empty(), "and nothing may be recorded");
    }

    /// A resolvable root is used; ANYTHING ELSE IS AN ERROR — never a guessed directory.
    ///
    /// The previous version of this test asserted the opposite (that a bad root "falls back to a
    /// real directory"), which is why the fallback survived review: the test documented the bug as
    /// the intended behaviour. A research child pointed at an arbitrary directory does not fail
    /// visibly — it answers, confidently, about the wrong tree.
    #[test]
    fn the_project_root_must_be_supplied_and_real() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve_root(Some(dir.path().to_string_lossy().to_string())).unwrap(),
            dir.path()
        );

        // A path that does not exist is refused rather than swapped for the cwd.
        let bad = resolve_root(Some("/definitely/not/a/real/path".to_string()));
        assert!(bad.is_err(), "a non-existent root must be an error, not a fallback");

        // And an ABSENT root is refused too — this was the common case in production, because the
        // TS caller was not sending one at all.
        assert!(resolve_root(None).is_err(), "a missing root must be an error, not the cwd");

        // A RELATIVE path is refused rather than resolved against the process cwd — the same
        // failure the removed fallback had, arriving through a path that `is_dir()` accepts.
        assert!(
            resolve_root(Some("src".to_string())).is_err(),
            "a relative root must be refused, not resolved against the process cwd"
        );
        assert!(resolve_root(Some(".".to_string())).is_err());
    }
    /// A record left `running` by a process exit must be TERMINAL after a reconcile pass — otherwise
    /// the sidebar's `+[n]` counts it forever and nothing ever drains it.
    #[test]
    fn a_task_interrupted_by_a_restart_is_reconciled_to_failed() {
        let dir = tempfile::tempdir().unwrap();
        let mut t = a_task("rsh_interrupted");
        t.status = ResearchStatus::Running;
        t.started_at = Some(1);
        t.finished_at = None;
        write_task(dir.path(), &t).expect("seed");

        // Nothing holds a control for it — this is exactly the post-restart state.
        let n = reconcile_interrupted(dir.path());
        assert_eq!(n, 1, "the interrupted task must be reconciled");

        let after = read_task(dir.path(), "rsh_interrupted").expect("still on disk");
        assert!(after.status.is_terminal(), "it must not stay live forever");
        assert_eq!(after.status, ResearchStatus::Failed);
        assert!(after.finished_at.is_some(), "a terminal task has a finish time");
        assert!(after.error.unwrap().contains("restarted"));
    }

    /// The `queued` half of the contract — a task that never got a permit before the exit.
    #[test]
    fn a_task_still_queued_at_the_exit_is_reconciled_too() {
        let dir = tempfile::tempdir().unwrap();
        let mut t = a_task("rsh_queued");
        t.status = ResearchStatus::Queued;
        t.started_at = None;
        write_task(dir.path(), &t).expect("seed");

        assert_eq!(reconcile_interrupted(dir.path()), 1, "`queued` is non-terminal too");
        let after = read_task(dir.path(), "rsh_queued").expect("still on disk");
        assert_eq!(after.status, ResearchStatus::Failed);
    }

    /// THE BRANCH THAT PROTECTS LIVE WORK. A record whose `Control` is in `live_controls()` is being
    /// worked on RIGHT NOW, and reconciling it would stamp a terminal state over a running pass.
    ///
    /// Nothing exercised this before (roborev 61731): both reconcile tests reached the no-control
    /// path, so the skip could be deleted or inverted with the suite green — and `reconcile_interrupted`
    /// is `pub`, with "call once at startup" stated only in a doc comment. The first caller to run it
    /// mid-session would have failed every in-flight task.
    #[test]
    fn a_task_with_a_live_control_is_never_reconciled() {
        let dir = tempfile::tempdir().unwrap();
        let mut t = a_task("rsh_live");
        t.status = ResearchStatus::Running;
        t.started_at = Some(1);
        write_task(dir.path(), &t).expect("seed");

        live_controls().lock().unwrap().insert("rsh_live".to_string(), Arc::new(Control::new()));
        let n = reconcile_interrupted(dir.path());
        // Remove BEFORE asserting, so a failure cannot leak this entry into a sibling test.
        live_controls().lock().unwrap().remove("rsh_live");

        assert_eq!(n, 0, "a task something is working on must not be reconciled");
        let after = read_task(dir.path(), "rsh_live").expect("still on disk");
        assert_eq!(after.status, ResearchStatus::Running, "it must still be live");
        assert_eq!(after.error, None);
    }

    /// A RECONCILE VERDICT IS A GUESS, AND AN OBSERVED OUTCOME OVERTURNS IT.
    ///
    /// The liveness test is process-local, so a second app instance can reconcile the first's
    /// genuinely-running tasks. Under a plain first-terminal-write-wins rule the real runner's
    /// `finish` was then silently dropped and a completed 15-minute pass was lost permanently
    /// (roborev 61731). The findings must land instead.
    #[test]
    fn a_late_finish_overturns_a_reconcile_guess_but_never_a_cancellation() {
        let dir = tempfile::tempdir().unwrap();
        let runner = Runner {
            app_data: dir.path().to_path_buf(),
            spawner: Arc::new(CliSpawner),
            now: fixed_clock(500),
        };

        // Reconciled by a pass that could not see the runner…
        let mut guessed = a_task("rsh_guessed");
        guessed.status = ResearchStatus::Running;
        write_task(dir.path(), &guessed).expect("seed");
        assert_eq!(reconcile_interrupted(dir.path()), 1);
        assert_eq!(
            read_task(dir.path(), "rsh_guessed").unwrap().error.as_deref(),
            Some(RECONCILED_ERROR),
            "the guess must be stamped with the sentinel `finish` recognises"
        );

        // …and the child comes home with the real answer.
        finish(&runner, "rsh_guessed", ResearchStatus::Done, Some("the answer".into()), None);
        let settled = read_task(dir.path(), "rsh_guessed").unwrap();
        assert_eq!(settled.status, ResearchStatus::Done, "the observed outcome must win");
        assert_eq!(settled.findings.as_deref(), Some("the answer"));
        assert_eq!(settled.error, None, "and the guess's error must be cleared");

        // THE BOUNDARY. A cancellation is NOT a guess — something observed it, the founder pressed
        // the button — so the same late `finish` must leave it exactly as it is.
        let mut killed = a_task("rsh_killed");
        killed.status = ResearchStatus::Cancelled;
        killed.finished_at = Some(9);
        write_task(dir.path(), &killed).expect("seed");
        finish(&runner, "rsh_killed", ResearchStatus::Done, Some("too late".into()), None);
        let after = read_task(dir.path(), "rsh_killed").unwrap();
        assert_eq!(after.status, ResearchStatus::Cancelled, "a cancel still wins the race");
        assert_eq!(after.findings, None);
        assert_eq!(after.finished_at, Some(9), "…and is not re-stamped");
    }

    /// …and a task that is ALREADY terminal is left alone, so a reconcile pass cannot rewrite the
    /// findings of work that really completed.
    #[test]
    fn reconciling_does_not_touch_a_task_that_already_finished() {
        let dir = tempfile::tempdir().unwrap();
        let mut t = a_task("rsh_done");
        t.status = ResearchStatus::Done;
        t.findings = Some("the answer".to_string());
        write_task(dir.path(), &t).expect("seed");

        assert_eq!(reconcile_interrupted(dir.path()), 0);
        let after = read_task(dir.path(), "rsh_done").expect("still on disk");
        assert_eq!(after.status, ResearchStatus::Done);
        assert_eq!(after.findings.as_deref(), Some("the answer"));
    }

}
