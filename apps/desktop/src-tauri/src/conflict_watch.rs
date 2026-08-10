//! THE DRIVER FOR THE CONFLICT LADDER — the thread, the `gh` probe, and the flags (bead
//! sparkle-zss67).
//!
//! ── WHAT IT WATCHES FOR, AND WHY NOBODY WAS ───────────────────────────────────────────────────
//! Nothing in Sparkle watched for merge conflicts. A PR went DIRTY and simply sat there. Measured
//! at the time of writing: five open PRs sat roughly 220 commits behind `main`, each carrying
//! exactly ONE commit of work.
//!
//! And a conflicting PR is worse than a stale one in a way the PR list cannot show:
//! A CONFLICTING PR NEVER FIRES GitHub's `pull_request` EVENT, SO IT GETS NO CI AT ALL. Its checks
//! are ABSENT, not red. So it renders exactly like a PR nobody has gotten to yet, while actually
//! being untestable until someone rebases it. `ConflictFlag::untested` carries "conflicting — AND
//! THEREFORE UNTESTED" as ONE fact, because a reader who has to join those two findings themselves
//! generally does not.
//!
//! ── NO MODEL ON ANY PATH ──────────────────────────────────────────────────────────────────────
//! `mergeStateStatus == DIRTY` is a string comparison and commits-behind is an integer comparison.
//! There is no judgement in either and no prose to parse, so this module makes NO model call
//! anywhere — a provider-wide 529 must never be able to blind us to conflicts. That is exactly why
//! the deterministic nudger kept working through the outage that killed everything else, and this
//! is built to sit in the same category: a plain OS thread in the Rust process, two subprocesses,
//! and arithmetic.
//!
//! ── FAIL CLOSED ───────────────────────────────────────────────────────────────────────────────
//! A `gh` that is missing, unauthenticated, offline or slow yields `Err`, never an empty list. An
//! unreadable repo does NOT clear anybody's flag and does NOT prune anybody's state; its already
//! tracked PRs keep climbing the ladder with a `blocked_by` reason attached, so "this PR is
//! conflicting" and "we cannot tell what this PR is" stay distinguishable all the way out to the
//! consumer. The one thing this module must never say is "no conflicts" because it could not look.
//!
//! ── SHAPE ─────────────────────────────────────────────────────────────────────────────────────
//! Deliberately `nudger.rs`'s shape, field for field: a pure ladder next door, one fixed cheap
//! TICK plus per-PR `due_at_ms` (never a forest of timers), a suspend rebaseline, a prune of state
//! for things that no longer exist, and flags that are PULLED by command with an event as an
//! optimisation on top. One pattern, not two.

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::conflict_ladder::{self, Action, Escalation, Observation, PrState};

/// How often the thread wakes. Also the resolution of every deadline below.
///
/// Twenty seconds, not the nudger's one: the ladder's SHORTEST rung is 120s, so a finer tick would
/// buy nothing and this thread's wake is not free (it takes a lock and compares deadlines). The
/// `gh` call itself happens only when a PR is actually DUE — a tick that finds nothing due costs
/// two integer comparisons and goes back to sleep. NOTHING here polls GitHub every second.
const TICK: Duration = Duration::from_secs(20);

/// How long a sweep may take before we call the repo unreadable. Mirrors `worktree.rs`'s
/// `NETWORK_TIMEOUT` reasoning: on a partition a `gh` child otherwise hangs for the OS default
/// (~75s+ TCP timeout), and a stuck child on a repeating timer piles up.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// Row cap on the open-PR list — and, far more importantly, the number a SATURATED read is detected
/// at (see [`read_is_saturated`]).
///
/// This probe is the ONE in the app that lists EVERY author's open PRs, not just `@me`'s, so it is
/// the most likely to fill its window. It sat at 100 with no truncation signal, which is the worst
/// combination available: a PR past the hundredth was never entered into the ladder at all, so a
/// conflicting-and-therefore-untested PR could sit there forever without ever being escalated to
/// the founder — and, because [`prune_tracked`] treated a full page as an authoritative list, an
/// already-tracked PR that fell off the end was silently FORGOTTEN and its raised flag swept
/// (bead sparkle-qogah: "we should never hide a row that needs action from me").
///
/// THE NUMBER IS NOT THE FIX. 300 is headroom (this repo runs ~13 open PRs today), and any constant
/// is eventually wrong; the durable part is that reaching it is now *disclosed* rather than rounded
/// off. `gh` pages internally at 100 rows a request and stops as soon as a page comes back short,
/// so raising the ceiling costs nothing at all on a repo below it — only a repo that would
/// otherwise be silently truncated pays for the extra pages, which is exactly the trade to make.
const PROBE_LIMIT: u32 = 300;

/// Ceiling on how long we go without LISTING, so a brand-new PR is discovered even while every
/// tracked PR is parked on the two-hour rung.
///
/// Equal to the ladder's floor by construction: a PR cannot be looked at more often than
/// `LADDER_SECS[0]` anyway, so this adds no `gh` traffic in the case where anything is due.
const DISCOVERY_SECS: u64 = conflict_ladder::LADDER_SECS[0];

/// If our own tick overran by this much we were not running either — a machine suspend, not a
/// stall. Same discrimination `nudger.rs` and `watchdog.rs` make, and for the same reason: A LAPTOP
/// ASLEEP FOR AN HOUR MUST NOT WAKE TO FIND EVERY PR SIX RUNGS UP. The silence during a suspend
/// means nothing, because nobody could have rebased anything either.
const SUSPEND_OVERSHOOT_MS: u64 = 5_000;

static STARTED: AtomicBool = AtomicBool::new(false);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ══ THE FLAG — THE FROZEN CONTRACT ══════════════════════════════════════════════════════════════

/// A raised flag. This module never addresses a human itself — it records a flag that the
/// pusher/concierge loop reads and acts on.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFlag {
    pub pr: u64,
    /// WHICH PROJECT this PR belongs to — the same id [`Repo`] and `pr_owner` resolve against.
    ///
    /// A PR NUMBER ALONE IS NOT AN IDENTITY. Two sibling projects both have a `#12`, so a consumer
    /// handed `pr: 12` could not tell which repo to verify it against, and had to ask every open
    /// repo and accept whichever answered — a weaker answer than the producer already held. The
    /// producer knew the project all along; it simply never said so (bead `sparkle-f0brd`).
    ///
    /// Note what this does NOT yet fix: [`ConflictFlags`] is still keyed by PR number alone, so a
    /// cross-project collision is still resolved by SKIPPING the loser rather than by tracking
    /// both. That skip is announced (see [`CollisionDigest`]). Stating the repo on the wire is the
    /// half a consumer needs first — it makes every row verifiable — and it is the prerequisite for
    /// re-keying the map on `(project, pr)`, which is the other half.
    pub project_id: String,
    pub branch: String,
    /// The RECORDED owner. None means UNRESOLVED, never "no agent".
    pub owner_agent_id: Option<String>,
    /// "conflicting" (mergeStateStatus == DIRTY) or "stale" (mergeable but far behind main).
    pub kind: String,
    pub commits_behind: u64,
    /// TRUE when kind == "conflicting": GitHub never fired pull_request, so CI is ABSENT, not red.
    /// This is the field that carries "conflicting AND THEREFORE UNTESTED" as one fact.
    ///
    /// Also true when the PR could not be READ — `false` is the positive claim "its checks really
    /// ran", which is not ours to make about a reading we could not take. `evidence` tells the two
    /// apart.
    pub untested: bool,
    /// HOW we know `untested`. The COMPLETE value set, which an exhaustive switch on the other side
    /// of the boundary may rely on (roborev 57927 caught a fifth value shipping undocumented):
    ///
    ///   * `"no-checks-ran"`    — conflicting, and no check run exists at all. Directly observed.
    ///   * `"checks-are-stale"` — conflicting, with checks that ran before the conflict arose.
    ///   * `"last-known"`       — the verdict was INHERITED from an earlier look on the SAME head,
    ///     because GitHub was still recomputing mergeability. Recent and real, but not read now.
    ///   * `"last-known-unconfirmed"` — inherited AND declined: the same-head verdict is on this row
    ///     (so `kind`/`untested` below came from a real recent reading), but the recompute outlasted
    ///     its budget or the value was one we do not understand. `blocked_by` says which.
    ///   * `"unknown"`          — NOTHING is known about this commit: no reading now, and no
    ///     same-head verdict to fall back on. The strongest of the three.
    ///   * `"n/a"`              — not conflicting, so the question does not arise.
    ///
    /// Anything other than the first two and `"n/a"` means the row is not a first-hand reading.
    /// DO NOT treat `"last-known-unconfirmed"` as unreadable-and-ignorable: those rows carry a real,
    /// recent conflict verdict, and one unrecognised `mergeStateStatus` puts the entire fleet in
    /// that state at once (roborev 57937).
    ///
    /// Added because the escape hatch this module documented did not cross the boundary
    /// (roborev 57881). `kind` cannot grow an `"unreadable"` value without breaking a consumer that
    /// has never seen one, so the doc told readers to consult `conflict_ladder::untested_evidence`
    /// instead — which a frontend reading serialized JSON cannot call. It reached exactly one
    /// `tracing::debug!` line. This is that value, on the channel the module calls THE channel.
    ///
    /// WHICH VALUES TO BRANCH ON. This sentence used to name `"unknown"` alone, which stopped being
    /// true the moment the inherited states were split out of it — and a consumer following it read
    /// `"last-known"` and `"last-known-unconfirmed"` rows as current first-hand readings. For an
    /// unrecognised `mergeStateStatus` that is every tracked PR at once, i.e. exactly the fleet-wide
    /// misread the split was made to prevent, re-opened from the other end (roborev 57946). The rule
    /// is three-way, not two-way:
    ///   * FIRST-HAND now — `"no-checks-ran"`, `"checks-are-stale"`, `"n/a"`.
    ///   * A REAL VERDICT, not read this look — `"last-known"`, `"last-known-unconfirmed"`. Act on
    ///     it; say it is not current. Never silently drop it.
    ///   * NO CONFIRMABLE VERDICT for this commit — `"unknown"`.
    ///
    /// `"unknown"` DOES NOT MEAN THE ROW IS EMPTY, and reading it that way is a bug this contract
    /// has already produced once. Two different situations wear it, and only the first has nothing
    /// behind it:
    ///   * we have never had a verdict for this PR at all; or
    ///   * the repo could not be READ this look, so `kind`/`untested` here are inherited from a
    ///     real earlier reading and may belong to a head that has since moved. `blocked_by` is set,
    ///     and `blind_facts` clears the carry precisely so this case cannot masquerade as the
    ///     stronger `"last-known-unconfirmed"` (roborev 57946, 57969).
    ///
    /// So a consumer must NOT grey out or drop an `"unknown"` row: during a `gh` outage that
    /// suppresses a genuine, recent, still-standing conflict for the whole outage — the exact
    /// failure `"last-known-unconfirmed"` was added to prevent. Say the reading is not current;
    /// keep acting on the conflict. `"unknown"` licenses "we cannot vouch for this verdict", never
    /// "there is no verdict".
    pub evidence: String,
    /// "agent" | "concierge" | "founder"
    pub target: String,
    /// When this flag was FIRST raised for the current episode.
    ///
    /// The row is rewritten on every flagging look so its rung and age stay honest, but this field
    /// is carried forward across those rewrites (roborev 57873). Stamping it afresh each look would
    /// have made it mean "when we last looked", so a consumer computing the flag's age from it
    /// would read ~0 for a conflict that had sat for two days — the exact staleness the refresh
    /// exists to prevent, relocated into a different field. It is also `list()`'s sort key, which a
    /// churning value would make unstable.
    pub raised_at_ms: u64,
    pub rung: usize,
    pub unresolved_secs: u64,
    /// Why we could not read this PR, if we could not. Distinguishes "it is conflicting" from
    /// "we cannot tell". Mirrors nudge_ladder's last_blocked.
    ///
    /// ── WHEN THIS IS `Some`, `kind`/`untested`/`commits_behind` ARE A PAST READING ─────────────
    /// They are never fabricated — a PR is only ever tracked after a SUCCESSFUL read, so they are
    /// the last state `gh` actually reported, not defaults. But they are not CURRENT. A consumer
    /// that renders `kind`/`untested` without checking this field will state a stale reading as a
    /// present fact, so: read this first, and treat a `Some` as "the label below is what we last
    /// saw, and we cannot re-check it right now".
    pub blocked_by: Option<String>,
}

/// Whether the last sweep could READ anything, for a consumer that has an EMPTY flag list and needs
/// to know which kind of empty it is (roborev 57873).
///
/// This closes the one hole the per-PR fail-closed path cannot: it only keeps ALREADY-TRACKED PRs
/// climbing, and a `gh` that is absent or unauthenticated from process start means nothing is ever
/// tracked. [`conflict_flags`] would then return `[]` forever, which reads as "no conflicts" — the
/// one thing this module's header says it must never say. A `tracing::warn!` is not the channel;
/// this is.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeStatus {
    /// Have we EVER completed a sweep? `false` means an empty flag list says nothing at all.
    pub ever_probed: bool,
    /// Repos found under `<app_data>/worktrees` on the last sweep.
    pub repos: usize,
    /// Repos the last sweep could not read. Non-zero means `conflict_flags` is INCOMPLETE.
    pub unreadable: usize,
    /// Why the last unreadable repo could not be read.
    pub last_error: Option<String>,
    /// When a sweep last read EVERY discovered repo. `0` means never.
    pub last_full_read_ms: u64,
}

fn probe_status() -> &'static Mutex<ProbeStatus> {
    static STATUS: std::sync::OnceLock<Mutex<ProbeStatus>> = std::sync::OnceLock::new();
    STATUS.get_or_init(|| Mutex::new(ProbeStatus::default()))
}

/// Record one sweep's readability. Split out of `tick` so it is assertable without an `AppHandle` —
/// the cold-start case this exists for is precisely the one `tick` cannot be driven into in a test.
fn record_probe(repos: usize, unreadable: usize, last_error: Option<&str>, now: u64) {
    let mut s = probe_status().lock().unwrap_or_else(|e| e.into_inner());
    s.ever_probed = true;
    s.repos = repos;
    s.unreadable = unreadable;
    s.last_error = last_error.map(str::to_string);
    if unreadable == 0 {
        s.last_full_read_ms = now;
    }
}

/// Live flags, keyed by PR NUMBER so one stuck PR is one row rather than a stream.
///
/// PULL, not just push. An event alone would be lost across a WebView reload — and the consumer of
/// these flags is a loop whose whole job is to notice things that got lost. So the flags are held
/// here and read with [`conflict_flags`]; the event is an optimisation on top, not the channel.
#[derive(Default)]
pub struct ConflictFlags(Mutex<HashMap<u64, ConflictFlag>>);

impl ConflictFlags {
    fn raise(&self, flag: ConflictFlag) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(flag.pr, flag);
    }
    fn clear(&self, pr: u64) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(&pr);
    }
    fn numbers(&self) -> Vec<u64> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .copied()
            .collect()
    }
    /// When this PR's flag was first raised, if it is currently flagged. Read back so a refresh can
    /// carry the original time forward rather than restamping it — see [`ConflictFlag::raised_at_ms`].
    fn raised_at(&self, pr: u64) -> Option<u64> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&pr)
            .map(|f| f.raised_at_ms)
    }
    fn list(&self) -> Vec<ConflictFlag> {
        let mut out: Vec<ConflictFlag> = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect();
        out.sort_by(|a, b| a.raised_at_ms.cmp(&b.raised_at_ms).then(a.pr.cmp(&b.pr)));
        out
    }
}

/// The payload for `conflict://detected` — the CURRENT FULL SET, identical to what
/// [`conflict_flags`] returns.
///
/// A THIN WRAPPER OVER `list()`, AND THAT IS THE POINT. The emit used to send the one flag that had
/// just escalated, which is a delta, and the consumer parses the event with the same all-or-nothing
/// array parser it uses for the poll. A bare object is not an array, so EVERY event was dropped with
/// "payload unreadable; keeping the last reading" — the listener has never once updated the store
/// since it was written. The poll masked it: the store still caught up on the ten-minute floor, so
/// the only symptom was latency the event exists to remove, plus a warn line per escalation.
///
/// The full set is the shape the consumer's contract asks for, and it is deliberately not a delta:
/// a delta would need a merge rule on the TypeScript side, and that rule would be a second opinion
/// about state this module already holds authoritatively.
///
/// Named rather than inlined so the wire shape is assertable without an `AppHandle` — the emit
/// itself cannot be driven in a unit test, which is how the mismatch survived.
fn detected_payload(flags: &ConflictFlags) -> Vec<ConflictFlag> {
    flags.list()
}

// ══ COMMANDS ════════════════════════════════════════════════════════════════════════════════════

/// Every conflict flag currently raised. The consumer polls this.
#[tauri::command]
pub fn conflict_flags(flags: State<ConflictFlags>) -> Vec<ConflictFlag> {
    flags.list()
}

/// Drop a flag once the consumer has acted on it.
#[tauri::command]
pub fn conflict_clear_flag(flags: State<ConflictFlags>, pr: u64) {
    flags.clear(pr);
}

/// Whether [`conflict_flags`] is COMPLETE. Read this before treating an empty list as "no
/// conflicts" — see [`ProbeStatus`].
#[tauri::command]
pub fn conflict_probe_status() -> ProbeStatus {
    probe_status().lock().unwrap_or_else(|e| e.into_inner()).clone()
}

// ══ WHAT `gh` TELLS US ══════════════════════════════════════════════════════════════════════════

/// The raw facts about one open PR. Everything the ladder and the flag are built from — kept as a
/// plain record so the whole decode is unit-tested without a network or a `gh` binary.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PrFacts {
    pub number: u64,
    /// WHICH PROJECT this PR was read from. Empty from [`decode_pr_facts`] and by construction —
    /// a `gh pr list` row says nothing about the repo it was listed from, so the sweep stamps it
    /// with [`stamp_project`] the moment a read is attributed to a [`Repo`].
    ///
    /// It exists because a PR NUMBER is not an identity across repos: two sibling projects both
    /// have a `#12`. Everything downstream — the flag row, and eventually the keying of
    /// [`ConflictFlags`] itself — needs the pair, and this is where the repo half enters.
    pub project_id: String,
    pub title: String,
    pub branch: String,
    pub head_oid: String,
    /// The base ref's tip. Used ONLY to compute [`commits_behind`] — deliberately NOT part of the
    /// episode identity, because it advances every time anything lands on `main`. See
    /// [`identity_hash`].
    pub base_oid: String,
    /// GitHub's `mergeStateStatus`, lowercased. Part of the identity hash, so a PR that stops
    /// being DIRTY is a NEW situation and its episode resets.
    pub merge_state: String,
    pub is_draft: bool,
    /// `mergeStateStatus == DIRTY`. The whole conflict detector, in one string comparison.
    pub is_dirty: bool,
    /// Does ANY check run exist for this PR at all? See [`ConflictFlag::untested`].
    pub has_ci: bool,
    /// Commits on the base that this PR's head does not contain. `0` when it could not be computed
    /// locally — see [`commits_behind`], which is deliberately allowed to fail without taking the
    /// conflict verdict down with it.
    pub commits_behind: u64,
    pub url: String,
    /// How many CONSECUTIVE looks have inherited this verdict rather than reading it. `0` on a
    /// first-hand reading. Bounded by [`MAX_CARRIED_LOOKS`]; disclosed on the flag as
    /// `evidence: "last-known"`. Deliberately not part of [`identity_hash`].
    pub carried_looks: u32,
}

/// One repo's open-PR read: the facts, PLUS whether the read filled its window.
///
/// The two travel together on purpose. A `Vec<PrFacts>` alone cannot express "and there may be
/// more", so every caller that received one was structurally unable to tell a complete list from a
/// truncated one — and each of them then treated the list as complete, because that is the only
/// thing a bare vec lets you do.
#[derive(Debug, Clone, PartialEq)]
struct Probed {
    prs: Vec<PrFacts>,
    /// The list came back at least [`PROBE_LIMIT`] rows long, so a PR past the cap is ABSENT from
    /// `prs` and we cannot know whether it exists. Never read as "those PRs are gone": see
    /// [`prune_tracked`], where reading it that way deleted state and swept raised flags.
    saturated: bool,
}

/// Did the read come back with its window FULL?
///
/// Same reasoning, and deliberately the same shape, as `knightwatch::read_is_saturated` and
/// `roborev_probe::window_saturated`: `gh pr list --limit N` returns the newest N rows with no
/// truncation signal whatsoever, so a count that reaches the cap is the one ambiguous reading —
/// either the repo really has exactly that many open PRs, or it has more and the remainder fell off
/// the end unannounced. That ambiguity resolves to NOT-AUTHORITATIVE, which here means "do not
/// prune anybody and keep the ones you know about climbing".
///
/// `>=` rather than `==` because a cap is a CEILING: a future `gh` that over-returns by a row must
/// not read as an authoritative answer just because it missed the equality.
fn read_is_saturated(raw_rows: usize, limit: u32) -> bool {
    raw_rows >= limit as usize
}

/// One JSON row → facts, or `None` for a row with no PR number (nothing to flag or link, so drop
/// just that row rather than failing the whole sweep).
fn decode_pr_facts(r: &Value) -> Option<PrFacts> {
    let number = r.get("number").and_then(Value::as_u64)?;
    let s = |k: &str| r.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let merge_state = normalize_merge_state(&s("mergeStateStatus"));
    Some(PrFacts {
        number,
        // A gh row cannot know which repo it was listed from. `stamp_project` fills it in.
        project_id: String::new(),
        title: s("title"),
        branch: s("headRefName"),
        head_oid: s("headRefOid"),
        base_oid: s("baseRefOid"),
        is_dirty: merge_state == "dirty",
        merge_state,
        is_draft: r.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        // An ABSENT rollup and an EMPTY one both mean "no check run exists", which is the
        // observation that confirms an untested conflict.
        has_ci: r
            .get("statusCheckRollup")
            .and_then(Value::as_array)
            .is_some_and(|a| !a.is_empty()),
        commits_behind: 0,
        url: s("url"),
        // A freshly decoded row is always first-hand; the carry is the driver's doing.
        carried_looks: 0,
    })
}

/// Attribute a repo's read to that repo. PURE, and separated from the sweep for the usual reason:
/// the sweep needs `gh`, so anything only reachable inside it is untestable and drifts.
///
/// Applied to the WHOLE read at the point the rows are attributed to a [`Repo`], rather than at the
/// one call site that happens to need it, so every path that carries facts onward — the tracked
/// entry, [`blind_facts`], the flag — inherits the identity instead of each having to remember to
/// re-attach it.
fn stamp_project(prs: Vec<PrFacts>, project_id: &str) -> Vec<PrFacts> {
    prs.into_iter()
        .map(|f| PrFacts { project_id: project_id.to_string(), ..f })
        .collect()
}

/// Pure decoder: `gh pr list --json …` → facts.
///
/// Unparsable output yields `None` (unknown), NEVER an empty list — the same null-vs-zero
/// discipline `worktree::decode_open_prs` keeps, and here it is the difference between "this repo
/// has no conflicts" and "we could not read this repo".
fn decode_open_prs(stdout: &str) -> Option<Vec<PrFacts>> {
    let rows = serde_json::from_str::<Vec<Value>>(stdout).ok()?;
    Some(rows.iter().filter_map(decode_pr_facts).collect())
}

/// Turn a completed `gh pr list` into a read. PURE, and extracted for exactly one reason: the
/// saturation decision would otherwise live inside [`probe_open_prs`] next to a subprocess spawn,
/// where no unit test can reach it — and a mutation that treated a full window as authoritative
/// would stay GREEN, which is the vacuous-test failure this repo tracks as its #1 finding. The
/// spawn is now a shell around this.
///
/// Saturation is judged on the RAW row count, before the numberless-row filter above: the cap `gh`
/// applied was to the rows it sent, so a dropped row still proves the window was full. Judging it
/// on the filtered count would let one malformed row read a full page as authoritative — the exact
/// inversion of the failure this guards against. Same call `roborev_probe` makes.
fn probe_from_stdout(stdout: &str, limit: u32) -> Option<Probed> {
    let rows = serde_json::from_str::<Vec<Value>>(stdout).ok()?;
    Some(Probed {
        saturated: read_is_saturated(rows.len(), limit),
        prs: rows.iter().filter_map(decode_pr_facts).collect(),
    })
}

/// GitHub's `mergeStateStatus`, lowercased, with everything it does not define folded to
/// [`MERGE_STATE_UNKNOWN`].
///
/// The empty/unrecognised case is not defensive padding — it is the routine one. GitHub computes
/// mergeability ASYNCHRONOUSLY and invalidates it on every push to the base, so a query taken while
/// that job is running returns `UNKNOWN`. `worktree.rs`'s `normalize_mergeable` says the same thing
/// in its own words ("UNKNOWN is routine rather than rare"). See [`carry_unknown_forward`].
fn normalize_merge_state(raw: &str) -> String {
    match raw.to_ascii_uppercase().as_str() {
        "CLEAN" => "clean".into(),
        "DIRTY" => "dirty".into(),
        "UNSTABLE" => "unstable".into(),
        "BLOCKED" => "blocked".into(),
        "BEHIND" => "behind".into(),
        "DRAFT" => "draft".into(),
        "HAS_HOOKS" => "has_hooks".into(),
        // GitHub is still deciding. An ABSENT field is read the same way: no value is no verdict.
        "UNKNOWN" | "" => MERGE_STATE_UNKNOWN.into(),
        // A value we do not understand is NOT the same thing, and conflating the two was a silent
        // trap (roborev 57915): "still deciding" means carry the last verdict forward INDEFINITELY,
        // so a renamed or newly-added `mergeStateStatus` would freeze every PR's verdict at
        // whatever was last read — identity pinned, `changed` never firing, a raised flag unable
        // to auto-retract, and a PR that goes conflicting afterwards never detected. Silently.
        // So it gets its own sentinel, it is LOUD, and it fails closed rather than being trusted.
        other => {
            tracing::warn!(
                target: "conflict_watch",
                merge_state = other,
                "unrecognised mergeStateStatus from gh; treating this PR as unreadable rather than \
                 as 'GitHub is still deciding' — a new or renamed value must not freeze a verdict"
            );
            MERGE_STATE_UNRECOGNIZED.into()
        }
    }
}

/// The state that means "GitHub has not finished deciding", NOT a state of the PR.
pub const MERGE_STATE_UNKNOWN: &str = "unknown";

/// A `mergeStateStatus` this build does not know. Distinct from [`MERGE_STATE_UNKNOWN`] on purpose —
/// see [`normalize_merge_state`].
pub const MERGE_STATE_UNRECOGNIZED: &str = "unrecognized";

/// How many CONSECUTIVE looks may inherit a verdict before we admit we are guessing.
///
/// Counted in DUE LOOKS, not in wall-clock (roborev 57927 corrected the doc that said otherwise).
/// At the ladder's 120s floor three consecutive carries is six minutes — a recompute that should
/// have taken one. On an episode already parked at the two-hour rung the same three looks span six
/// HOURS, and that is fine: this bound exists to stop a verdict being carried INDEFINITELY, not to
/// be a timer. Past it the honest answer is "we cannot tell", and the flag says so — while keeping
/// the inherited verdict on the row, so the identity does not move. See [`carry_unknown_forward`].
const MAX_CARRIED_LOOKS: u32 = 3;

/// AN `UNKNOWN` MERGE STATE IS NO NEW INFORMATION — carry the last real verdict forward.
///
/// ── THE SECOND DOOR INTO THE RESET BUG (roborev 57881) ────────────────────────────────────────
/// Dropping `base_oid` from the identity hash closed only ONE of the two ways a base move ends an
/// episode. The surviving component is the merge state, and a push to `main` invalidates every open
/// PR's mergeability — so the very same landing still walked a conflicting PR's identity through
/// `dirty → unknown → dirty`, and each of those two flips did exactly what `base_oid` used to do:
/// rung 0, `attempts` 0, `escalated` cleared, and the raised row retracted.
///
/// It was worse than the base-oid version, because while the state read `unknown` the decoded
/// `is_dirty` was `false`, so a genuinely conflicting PR under the staleness threshold was ALSO
/// vetoed as `"mergeable"` and accumulated nothing at all.
///
/// So an `unknown` reading is treated as what it is: the absence of a reading. The head oid is kept
/// CURRENT (a real push must still reset the episode) while the verdict is inherited from the last
/// look that had one.
///
/// The one case with nothing to inherit — a PR seen for the first time mid-recompute — is a genuine
/// "we know nothing", and returns a refusal so it fails closed rather than being vetoed as fine. In
/// practice it resolves long before the first flagging rung seven minutes later.
fn carry_unknown_forward(fresh: &mut PrFacts, previous: Option<&PrFacts>) -> Option<&'static str> {
    let undecided = fresh.merge_state == MERGE_STATE_UNKNOWN;
    let unrecognized = fresh.merge_state == MERGE_STATE_UNRECOGNIZED;
    if !undecided && !unrecognized {
        fresh.carried_looks = 0;
        return None;
    }
    let inheritable = previous.filter(|p| {
        // ── THE VERDICT BELONGS TO A COMMIT, NOT TO A PR (roborev 57915) ──────────────────────
        // Matching on the PR alone copies a verdict taken against head A onto head B — and that is
        // the MOST COMMON real sequence, not an edge case: the agent is told its PR conflicts, it
        // merges `main` in and pushes, and a push to the head is exactly what makes GitHub return
        // UNKNOWN on the next look. The driver then writes the inherited verdict back, identity
        // stabilises at (head B, "dirty"), and a fresh episode accumulates against the very commit
        // that FIXED the conflict — reporting `conflicting` + `untested` for a resolved PR.
        p.head_oid == fresh.head_oid
            && p.merge_state != MERGE_STATE_UNKNOWN
            && p.merge_state != MERGE_STATE_UNRECOGNIZED
    });

    let Some(p) = inheritable else {
        // Nothing to inherit: a NEW head, or a PR first seen without a verdict. The identity really
        // is new here, so letting it move (and reset the episode) is correct — and since we know
        // nothing about this commit, fail closed.
        return Some(if unrecognized { "merge-state-unrecognized" } else { "mergeability-unknown" });
    };

    // ── INHERIT FIRST, REFUSE SECOND — AND THE ORDER IS THE WHOLE FIX (roborev 57927) ──────────
    // The verdict is copied onto the row EVEN WHEN we go on to refuse below. That looks redundant
    // and is not: `merge_state` is half the identity hash, so returning a refusal over a row still
    // carrying the sentinel would move the identity on an UNCHANGED head — `step` would reset the
    // episode and `apply_flags` would clear the row. That is the exact reset/retraction the last
    // three commits closed, re-entered through the refusal path built to preserve the flag: a
    // founder-level flag on a still-conflicting PR retracted at the 4th unknown look, re-climbing
    // hours to get back, and returning labelled `"stale"` because the un-inherited row reads
    // `is_dirty: false`. For an unrecognised value it would have done that to EVERY tracked PR in
    // one sweep.
    //
    // `Look::Blind` follows the same rule for IDENTITY — it reuses the stored merge-state so the
    // episode does not reset — but deliberately NOT for `carried_looks`, which it zeroes. A carry
    // means "we reached GitHub and it was still recomputing"; a blind look reached nothing, so it
    // has no same-head claim to inherit and must degrade to `unknown` (roborev 57946).
    //
    // The identity must be stable whenever the head is stable, and `refusal` — not the identity —
    // is where uncertainty belongs.
    fresh.merge_state = p.merge_state.clone();
    fresh.is_dirty = p.is_dirty;
    fresh.carried_looks = p.carried_looks + 1;

    if unrecognized {
        return Some("merge-state-unrecognized");
    }
    if fresh.carried_looks > MAX_CARRIED_LOOKS {
        return Some("mergeability-unknown");
    }
    // NOT a refusal: we have a real, recent verdict for THIS COMMIT and only GitHub's recomputation
    // is in flight. Calling it one would escalate every healthy PR in the fleet every time anything
    // landed on `main`. The flag still discloses that the reading is inherited rather than
    // first-hand — see `Observation::carried`.
    None
}

/// Identity of one conflict: FNV-1a over `(head_oid, merge_state)`.
///
/// A change to either ends the episode, and those are the only two things that can end one: the
/// author pushes a rebase (head moves), or GitHub recomputes the PR as no longer dirty (state
/// moves).
///
/// ── `base_oid` IS DELIBERATELY EXCLUDED (roborev 57856) ───────────────────────────────────────
/// Adding it is the obvious third component and it would have destroyed this module. `baseRefOid`
/// is `main`'s head, which on this repo advances many times an hour — while reaching the first flag
/// takes 7 minutes of unbroken episode, the concierge ~52 minutes and the founder ~6 hours. Every
/// landing on `main` would have reset every open PR to rung 0 and auto-retracted its flag, so the
/// detector would have been most thoroughly defeated during exactly the busy periods that produce
/// conflicts. A base move does not RESOLVE a conflict — it AGGRAVATES one, and if it aggravates it
/// into a different state then `merge_state` says so.
///
/// FNV-1a rather than `DefaultHasher` for the same reason `nudger.rs` gives: `DefaultHasher` is
/// randomly seeded per process, so a logged hash would be meaningless across restarts. This is a
/// change detector, not a security primitive.
fn identity_hash(f: &PrFacts) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in f
        .head_oid
        .as_bytes()
        .iter()
        .chain(b"\x00")
        .chain(f.merge_state.as_bytes())
    {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Facts → the ladder's `Observation`. `refusal` is `Some` only when the PR could not be READ, in
/// which case the facts are the LAST KNOWN ones and every "it is fine" field in them is stale.
fn observation(f: &PrFacts, refusal: Option<&'static str>) -> Observation {
    Observation {
        hash: identity_hash(f),
        is_dirty: f.is_dirty,
        commits_behind: f.commits_behind,
        has_ci: f.has_ci,
        is_draft: f.is_draft,
        carried: f.carried_looks > 0,
        refusal,
    }
}

/// One tick's flag effects for one PR, returning a flag that was newly ESCALATED (so the caller can
/// emit its event).
///
/// Takes `&ConflictFlags` rather than an `AppHandle` so every half — the raise, the per-look
/// refresh AND the auto-retraction — is testable without standing up a Tauri app.
///
/// The refresh is the one deliberate difference from `nudger::apply_flags`, and it matters here in
/// a way it does not there: a conflict flag can legitimately sit for hours, and a row whose
/// `unresolved_secs` froze at the moment of its last ESCALATION would tell a reader the conflict is
/// 20 minutes old when it is two days old. So the row is rewritten on every flagging look, while
/// the EVENT still fires only when the target actually rises.
fn apply_flags(
    flags: &ConflictFlags,
    facts: &PrFacts,
    owner_agent_id: Option<String>,
    decision: &conflict_ladder::Decision,
    state: &PrState,
) -> Option<ConflictFlag> {
    // A PR whose identity CHANGED has resolved (or replaced) its own episode, so any flag raised
    // for it is no longer true. This is what auto-retracts the flag the moment a PR stops being
    // DIRTY: `merge_state` is part of the identity hash. Leaving the row up would have the consumer
    // chase a conflict somebody already fixed — and a channel that reports resolved problems stops
    // being read.
    if decision.changed {
        flags.clear(facts.number);
    }
    if !matches!(decision.action, Action::Flag { .. }) {
        return None;
    }
    // Carry the ORIGINAL raise time across the refresh (roborev 57873). `changed` already cleared
    // any previous row above, so a new episode correctly gets a new timestamp.
    let flag = build_flag(facts, owner_agent_id, decision, state, flags.raised_at(facts.number));
    flags.raise(flag.clone());
    decision.escalate.map(|_| flag)
}

/// Build the flag row for one flagging look. Pure, so the FIELDS the consumer reads — above all
/// `untested` — are asserted directly rather than inferred from the enum they were derived from.
///
/// `decision.refusal` is threaded into the derivation rather than passing `None` (roborev 57873):
/// the label below is a LAST-SUCCESSFUL-READ value whenever it is `Some`, and building the
/// observation with `refusal: None` made that indistinguishable in the code from a fresh reading.
/// It is the same value that lands in `blocked_by`, which is the field the contract designates for
/// telling the consumer the label is not current.
fn build_flag(
    facts: &PrFacts,
    owner_agent_id: Option<String>,
    decision: &conflict_ladder::Decision,
    state: &PrState,
    raised_at_ms: Option<u64>,
) -> ConflictFlag {
    let obs = observation(facts, decision.refusal);
    ConflictFlag {
        pr: facts.number,
        // Carried from the facts rather than passed in beside them, so a row can never be built
        // with a number from one project and an identity from another.
        project_id: facts.project_id.clone(),
        branch: facts.branch.clone(),
        // NEVER a guess. `None` here means UNRESOLVED — a flag naming the WRONG agent is strictly
        // worse than one naming none, because the reader cannot tell until they have lost their
        // place. See `pr_owner`'s module header.
        owner_agent_id,
        kind: conflict_ladder::kind(&obs).to_string(),
        commits_behind: facts.commits_behind,
        untested: conflict_ladder::untested(&obs),
        evidence: conflict_ladder::untested_evidence(&obs).to_string(),
        target: state
            .escalated()
            .unwrap_or(Escalation::Agent)
            .as_str()
            .to_string(),
        raised_at_ms: raised_at_ms.unwrap_or_else(now_ms),
        rung: decision.rung,
        unresolved_secs: state.unresolved_secs(),
        blocked_by: state.last_blocked().map(str::to_string),
    }
}

/// Drop flags for PRs that no longer exist (merged, closed).
///
/// Only ever called with the numbers from a sweep that SUCCEEDED — absence from an unreadable
/// listing is not evidence that a PR is gone, and clearing on it would be the "no conflicts because
/// we could not look" failure wearing a different hat.
fn sweep_closed_flags(flags: &ConflictFlags, live: &HashSet<u64>) {
    for pr in flags.numbers() {
        if !live.contains(&pr) {
            flags.clear(pr);
        }
    }
}

// ══ TALKING TO `gh` AND `git` ═══════════════════════════════════════════════════════════════════

/// A repo this module can ask `gh` about: an agent worktree, plus the project it belongs to.
///
/// Discovery goes through the worktrees Sparkle itself created (`<app_data>/worktrees/<project
/// id>/<agent id>`) rather than through the frontend's project list, and that is deliberate: this
/// thread must keep working when the WebView is wedged, so it cannot depend on anything the
/// frontend publishes. A linked worktree shares its repo's remotes and object store, so `gh` and
/// `git` answer there exactly as they would in the main checkout — and the directory name hands us
/// the `project_id` that `pr_owner` resolves against, for free.
#[derive(Debug, Clone, PartialEq)]
struct Repo {
    project_id: String,
    /// EVERY live worktree for this project, sorted — not just the first (roborev 57873).
    ///
    /// One directory is enough to answer, but the FIRST one can be individually broken: a `.git`
    /// file pointing at a gitdir that has since been pruned, or a checkout `gh` cannot resolve a
    /// remote from. With a single candidate that fault reads as "this project is unreadable"
    /// permanently — so every one of its tracked PRs climbs to the founder over an environment
    /// problem, and no new PR is ever discovered. [`probe_repo`] falls through to the next.
    dirs: Vec<PathBuf>,
}

/// Every live worktree per project, in a stable (sorted) order.
///
/// Sorted so that the duplicate-PR-number tie-break in [`tick`] and the fallback order in
/// [`probe_repo`] are deterministic rather than dependent on directory iteration order.
fn discover_repos(app_data: &Path) -> Vec<Repo> {
    let base = app_data.join("worktrees");
    let Ok(projects) = std::fs::read_dir(&base) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = projects
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    ids.sort();
    ids.iter()
        .filter_map(|project_id| {
            let mut dirs: Vec<PathBuf> = std::fs::read_dir(base.join(project_id))
                .ok()?
                .flatten()
                // `.git` is a FILE in a linked worktree, so its presence is the cheap proof this
                // directory is still a live worktree and not a leftover husk `git worktree prune`
                // has already disowned.
                .filter(|e| e.path().join(".git").exists())
                .map(|e| e.path())
                .collect();
            dirs.sort();
            (!dirs.is_empty()).then(|| Repo {
                project_id: project_id.clone(),
                dirs,
            })
        })
        .collect()
}

/// Ask a project's worktrees for its open PRs, taking the first that ANSWERS.
///
/// Only a probe that fails in EVERY worktree declares the project unreadable, so one broken
/// checkout cannot blind a project permanently (roborev 57873). The `probe` is a parameter so the
/// fallback — the interesting behaviour, and the one that needs a broken directory to exercise — is
/// assertable without a `gh` binary.
/// Returns the worktree that answered alongside the PRs, because the caller needs a working
/// directory for the local `git rev-list` that computes commits-behind.
fn probe_repo<P>(repo: &Repo, mut probe: P) -> Result<(PathBuf, Probed), &'static str>
where
    P: FnMut(&Path) -> Result<Probed, &'static str>,
{
    let mut last = "no-worktree";
    for dir in &repo.dirs {
        match probe(dir) {
            Ok(prs) => return Ok((dir.clone(), prs)),
            Err(reason) => last = reason,
        }
    }
    Err(last)
}

/// Every open PR in `dir`'s repo, plus whether the list was TRUNCATED at [`PROBE_LIMIT`].
///
/// `Err(reason)` — never an empty list — when `gh` is absent, unauthenticated, offline, or slow.
/// The reason travels all the way to `ConflictFlag::blocked_by`, so a consumer can tell a real
/// conflict from a repo we could not read.
fn probe_open_prs(dir: &Path) -> Result<Probed, &'static str> {
    let mut cmd = Command::new(crate::preflight::gh_program());
    cmd.arg("pr")
        .args([
            "list",
            "--state",
            "open",
            "--limit",
            &PROBE_LIMIT.to_string(),
            "--json",
            // `statusCheckRollup` is the ONLY source for `has_ci`, which is what turns "this PR is
            // untested" from an inference into an observation — see `ConflictFlag::untested`.
            "number,title,headRefName,headRefOid,baseRefOid,mergeable,mergeStateStatus,isDraft,url,statusCheckRollup",
        ])
        .current_dir(dir)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1");
    apply_noninteractive(&mut cmd);
    let output = crate::worktree::output_with_timeout(cmd, PROBE_TIMEOUT)
        .map_err(|_| "gh-unavailable")?;
    if !output.status.success() {
        // gh's own exit codes do not distinguish "not logged in" from "no remote", and the stderr
        // text is prose we would have to parse. One honest reason beats a guessed taxonomy.
        return Err("gh-failed");
    }
    probe_from_stdout(&String::from_utf8_lossy(&output.stdout), PROBE_LIMIT).ok_or("gh-unreadable")
}

/// Force `gh`/`git` to fail fast rather than block on an interactive credential or host-key prompt.
/// A hung child on a repeating timer is how a background thread stops being a background thread.
fn apply_noninteractive(cmd: &mut Command) {
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_ASKPASS", "true");
    cmd.env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes");
}

/// Commits on the base that this PR's head does not contain, computed LOCALLY.
///
/// `baseRefOid` is the base branch's tip as GitHub currently sees it, so `<head>..<base>` is
/// exactly commits-behind — no branch-name assumption (this repo's default is `main`, but nothing
/// here needs to know that) and no per-PR API call. One `gh api .../compare` per PR would be a
/// hundred network round-trips per sweep for a number that only enriches the flag.
///
/// `None` when it could not be computed — most often because the head commit of somebody else's
/// branch has never been fetched into this clone. That is a KNOWN limitation and a deliberate
/// trade: it can suppress the secondary "stale" kind for such a PR, but it CANNOT suppress the
/// conflicting verdict, which comes from `gh` alone. The caller logs the miss rather than silently
/// reporting `0`.
fn commits_behind(dir: &Path, f: &PrFacts) -> Option<u64> {
    let cwd = dir.to_str()?;
    if !is_safe_oid(&f.head_oid) {
        return None;
    }
    let count = |range: &str| {
        crate::worktree::git(cwd, &["rev-list", "--count", range])
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
    };
    if is_safe_oid(&f.base_oid) {
        if let Some(n) = count(&format!("{}..{}", f.head_oid, f.base_oid)) {
            return Some(n);
        }
    }
    // The base oid is not in this clone (a very fresh push to the base, say) but the remote-tracking
    // ref usually is. Second-best, not a different answer: `origin/HEAD` follows whatever the remote
    // calls its default branch.
    count(&format!("{}..origin/HEAD", f.head_oid))
}

/// A 7–64 character hex string, which is the only shape a git object id takes.
///
/// These come from GitHub's JSON and go straight into a `git` argument. Nothing here should ever be
/// anything else, so anything else is refused at the boundary rather than passed through and
/// discovered later — the same rule `worktree::validate_ref` applies to branch names.
fn is_safe_oid(oid: &str) -> bool {
    (7..=64).contains(&oid.len()) && oid.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Which agent owns this PR, from the DURABLE mapping. `None` means UNRESOLVED, never "no agent".
///
/// The PR BODY is deliberately not fetched here (it is not in the field list above, and 100 bodies
/// per sweep is a lot of payload for a background thread). Nothing is lost: `worktree.rs`'s PR-list
/// probe already reads the body marker and BACKFILLS it into the durable store, so by the time this
/// runs that source has normally already been frozen into the PR table.
fn resolve_owner(app_data: &Path, project_id: &str, f: &PrFacts) -> Option<String> {
    crate::pr_owner::resolve_and_backfill(
        app_data,
        project_id,
        &[(f.number, f.branch.clone(), String::new())],
    )
    .pop()
    .flatten()
    .map(|o| o.agent_id)
}

// ══ THE LOOP ════════════════════════════════════════════════════════════════════════════════════

/// Per-PR scheduling state, held only by the thread.
struct Tracked {
    state: PrState,
    due_at_ms: u64,
    /// Which project's repo this PR came from, so an unreadable sweep knows whose PRs to keep
    /// climbing blind.
    project_id: String,
    /// The last facts we could actually READ. Reused verbatim when a sweep fails, so a blind look
    /// does not reset the episode by inventing a different identity hash.
    facts: PrFacts,
}

/// The thread's whole memory.
#[derive(Default)]
struct Watch {
    tracked: HashMap<u64, Tracked>,
    /// Earliest moment it is worth shelling out to `gh` again.
    next_scan_at_ms: u64,
    /// Identity of the LAST cross-project PR-number collision set we announced, so a steady state
    /// is announced once instead of once per PR per sweep. `None` = no collisions last sweep, which
    /// is what makes a recurrence after a clean sweep announce itself again.
    last_collision_fp: Option<u64>,
}

/// How many `project#pr` pairs a collision announcement names before it elides the rest.
const COLLISION_SAMPLE: usize = 8;

/// One sweep's cross-project PR-number collisions, collapsed into ONE line.
///
/// The collision itself is deliberate and documented at the call site: [`ConflictFlags`] is keyed by
/// PR NUMBER alone, so two projects' `#12` cannot both be tracked and the loser is skipped. That is
/// a real degradation and it must stay visible — but it is also a STEADY state, re-derived
/// identically on every sweep, and it used to be announced once per colliding PR per sweep. On a
/// machine with a dozen sibling projects that is ~9 warnings every 20s: measured at 26,587 lines
/// across two days, ~88% of all WARN volume, which buries every other signal in the log (including
/// the unreadable-repo arm right below it, and the crash and hang traces the log exists for).
/// Drowning a degradation notice in copies of itself is indistinguishable from not reporting it.
struct CollisionDigest {
    /// How many PRs were skipped this sweep.
    total: usize,
    /// How many distinct projects lost at least one PR to a collision.
    projects: usize,
    /// Stable identity of the collision SET — equal iff the same projects lost the same PRs, so an
    /// unchanged set is not re-announced and a CHANGED one always is.
    fingerprint: u64,
    /// Sorted, bounded `project#pr` sample, so the line still names names.
    sample: String,
}

/// Collapse this sweep's collisions into one announcement, or `None` if there were none.
fn collision_digest(collisions: &[(String, u64)]) -> Option<CollisionDigest> {
    if collisions.is_empty() {
        return None;
    }
    // Sort so the fingerprint is a property of the SET, not of the order `discover_repos` happened
    // to return the projects in — otherwise a reordered but identical set re-announces itself.
    let mut pairs: Vec<(&str, u64)> = collisions.iter().map(|(p, n)| (p.as_str(), *n)).collect();
    pairs.sort_unstable();
    pairs.dedup();

    let mut projects: Vec<&str> = pairs.iter().map(|(p, _)| *p).collect();
    projects.dedup();

    let mut hasher = DefaultHasher::new();
    pairs.hash(&mut hasher);

    let mut sample = pairs
        .iter()
        .take(COLLISION_SAMPLE)
        .map(|(p, n)| format!("{p}#{n}"))
        .collect::<Vec<_>>()
        .join(", ");
    if pairs.len() > COLLISION_SAMPLE {
        sample.push_str(&format!(", …+{}", pairs.len() - COLLISION_SAMPLE));
    }

    Some(CollisionDigest {
        total: pairs.len(),
        projects: projects.len(),
        fingerprint: hasher.finish(),
        sample,
    })
}

/// One PR's turn this tick.
enum Look {
    /// Read cleanly. Carries the project id and the worktree that answered, so a look that turns
    /// out to be DUE can compute commits-behind there.
    Read(String, PathBuf, PrFacts),
    /// Its repo could not be read; climb on the last known facts with the reason attached.
    Blind(u64, &'static str),
}

/// The facts a BLIND look reuses: the last known ones, but with no carry to claim.
///
/// `carried_looks` is what makes `evidence` read `last-known-unconfirmed` — "a real same-head
/// verdict is on this row, we just could not confirm the head is still that head". A blind look did
/// not reach the repo AT ALL, so it has no such claim and must degrade to the strongest disclaimer,
/// `unknown` (roborev 57946).
///
/// Left alone the counter is sticky: only a first-hand reading zeroes it, and the blind path never
/// reaches `carry_unknown_forward` nor writes its facts back. So ONE earlier carry made every later
/// unreadable-repo look report the WEAKER state forever — the same read-failure/recompute-in-flight
/// conflation this module exists to keep apart, entered from the other side.
///
/// It is a named function rather than two lines inside `tick` ONLY so it can be tested: `tick` takes
/// an `AppHandle` and has no test, and a fix that lives there is a fix no assertion can reach — the
/// trap `nudger.rs` records, where deleting the wiring left every test green. Everything else about
/// the row, the merge-state identity above all, is deliberately preserved: zeroing the carry must
/// not restart the episode.
fn blind_facts(stored: &PrFacts) -> PrFacts {
    PrFacts { carried_looks: 0, ..stored.clone() }
}

/// Forget tracked PRs that a READABLE project no longer lists — and only those.
///
/// The predicate is keyed on the project that was actually PROBED, not on `all_readable`
/// (roborev 57873). A project whose worktrees are all removed — routine once its agents finish —
/// simply drops out of `discover_repos`, so a global "everything was readable" flag stays true
/// while that project's PRs are absent from `seen`, and the naive prune silently deletes their
/// state AND their raised flags. "We cannot look at this repo any more" is the one thing this
/// module refuses to read as "the PR was merged", so a project we did not probe keeps everything.
///
/// Why a blind look is happening when the repo itself was perfectly readable: the LIST was
/// truncated. Travels to `ConflictFlag::blocked_by`, so the row says which of the two it is rather
/// than implying `gh` was down.
const SATURATED_REASON: &str = "gh-list-saturated";

/// Which of a project's TRACKED PRs a saturated list failed to mention — the ones that must keep
/// climbing rather than quietly stop being looked at.
///
/// Sorted, so the looks a sweep produces are deterministic rather than dependent on `HashMap`
/// iteration order. A named function only so it is ASSERTABLE: `tick` takes an `AppHandle` and has
/// no test, and this repo has already recorded a case where a fix that lived there left every test
/// green (see `blind_facts`).
fn saturated_blind_fill(
    tracked: &HashMap<u64, Tracked>,
    project_id: &str,
    seen: &HashSet<u64>,
) -> Vec<u64> {
    let mut out: Vec<u64> = tracked
        .iter()
        .filter(|(pr, t)| t.project_id == project_id && !seen.contains(*pr))
        .map(|(pr, _)| *pr)
        .collect();
    out.sort_unstable();
    out
}

/// A SATURATED list is not evidence of absence either, and it used to be treated as exactly that
/// (bead sparkle-qogah). `gh pr list --limit N` truncates silently, so a repo with more open PRs
/// than the cap returns a full page whose tail is simply missing — and every PR in that tail is
/// absent from `seen`. The naive predicate then deleted their ladder state AND, via the
/// `sweep_closed_flags` call that keys off what survived this prune, their already-RAISED conflict
/// flags. A conflicting-and-untested PR the founder owes a rebase would vanish from the surface
/// because a page was full. "The window filled up" is no more a merge than "we cannot look".
///
/// Free function so it is assertable without an `AppHandle`.
fn prune_tracked(
    tracked: &mut HashMap<u64, Tracked>,
    probed_ok: &HashSet<String>,
    seen: &HashSet<u64>,
    saturated: &HashSet<String>,
) {
    tracked.retain(|pr, t| {
        !probed_ok.contains(&t.project_id)
            || saturated.contains(&t.project_id)
            || seen.contains(pr)
    });
}

/// Start the conflict watcher. Idempotent; safe to call more than once.
///
/// A plain `std::thread::spawn`, not a tokio task, for the reason `nudger.rs` gives: this must keep
/// running independently of the async runtime and of the WebView, and it spends its life asleep.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut watch = Watch::default();
        loop {
            let before = now_ms();
            std::thread::sleep(TICK);
            let now = now_ms();
            let overshoot = now
                .saturating_sub(before)
                .saturating_sub(TICK.as_millis() as u64);
            if overshoot > SUSPEND_OVERSHOOT_MS {
                // We were frozen alongside everything else, so the elapsed time means nothing —
                // nobody could have rebased anything either. Push every deadline out rather than
                // reading a suspend as six rungs of neglect.
                for t in watch.tracked.values_mut() {
                    t.due_at_ms = now.saturating_add(conflict_ladder::LADDER_SECS[0] * 1000);
                }
                watch.next_scan_at_ms = now.saturating_add(conflict_ladder::LADDER_SECS[0] * 1000);
                tracing::debug!(
                    target: "conflict_watch",
                    overshoot_ms = overshoot,
                    "suspend detected; rebaselined"
                );
                continue;
            }
            tick(&app, &mut watch, now);
        }
    });
}

fn tick<R: Runtime>(app: &AppHandle<R>, watch: &mut Watch, now: u64) {
    // ONE fixed cheap tick plus per-PR deadlines. A tick with nothing due costs two integer
    // comparisons — the `gh` call happens only when something is actually due, or when the
    // discovery ceiling has elapsed and a brand-new PR might exist.
    if now < watch.next_scan_at_ms {
        return;
    }
    let Ok(app_data) = crate::dev_identity::app_data_dir(app) else {
        // No app-data dir means no worktrees to find; try again on the ordinary cadence.
        watch.next_scan_at_ms = now.saturating_add(DISCOVERY_SECS * 1000);
        return;
    };

    let repos = discover_repos(&app_data);
    let mut looks: Vec<Look> = Vec::new();
    let mut seen: HashSet<u64> = HashSet::new();
    // Projects whose PR listing we actually READ this sweep. Only these may prune — see
    // `prune_tracked`.
    let mut probed_ok: HashSet<String> = HashSet::new();
    // …of which THESE came back with a full window, so their listing is not the whole truth and
    // nothing may be pruned on the strength of it.
    let mut saturated: HashSet<String> = HashSet::new();
    let mut unreadable = 0usize;
    let mut last_error: Option<&'static str> = None;
    // `(project, pr)` for every PR this sweep skipped because another project claimed the number.
    let mut collisions: Vec<(String, u64)> = Vec::new();

    for repo in &repos {
        match probe_repo(repo, probe_open_prs) {
            Ok((dir, probed)) => {
                probed_ok.insert(repo.project_id.clone());
                let was_saturated = probed.saturated;
                // Attribute the whole read to this repo BEFORE anything downstream copies it, so
                // the identity rides along on every path a row can take from here.
                for f in stamp_project(probed.prs, &repo.project_id) {
                    // The flag contract is keyed by PR NUMBER alone, so two projects' #12 would
                    // collide. First project (sorted) wins and the collision is LOGGED rather than
                    // silently merged — a visible degradation beats cross-project cross-talk.
                    if !seen.insert(f.number) {
                        // Announced ONCE per distinct collision set, after the loop — see
                        // `CollisionDigest` for why this is not a per-PR warning.
                        collisions.push((repo.project_id.clone(), f.number));
                        continue;
                    }
                    // NOTE: commits-behind is deliberately NOT computed here. It costs a `git`
                    // subprocess per PR, and at 100 PRs on a 120s cadence that is thousands of
                    // spawns an hour for a number that only enriches a flag most of them will never
                    // raise (roborev 57873). It is computed below, for DUE looks only.
                    looks.push(Look::Read(repo.project_id.clone(), dir.clone(), f));
                }
                if was_saturated {
                    saturated.insert(repo.project_id.clone());
                    tracing::warn!(
                        target: "conflict_watch",
                        project = %repo.project_id,
                        limit = PROBE_LIMIT,
                        "this repo's open-PR list FILLED its window, so a PR past the cap is \
                         missing from this sweep entirely; nothing is pruned and every tracked PR \
                         the list omitted keeps climbing blind"
                    );
                    // FAIL CLOSED, exactly as the unreadable arm does: a tracked PR the truncated
                    // page left out is not a merged PR. Without this it would simply stop being
                    // looked at — retained by `prune_tracked` but never escalated again, which for
                    // a conflicting PR the founder owes a rebase is indistinguishable from hiding
                    // it (bead sparkle-qogah).
                    for pr in saturated_blind_fill(&watch.tracked, &repo.project_id, &seen) {
                        seen.insert(pr);
                        looks.push(Look::Blind(pr, SATURATED_REASON));
                    }
                }
            }
            Err(reason) => {
                unreadable += 1;
                last_error = Some(reason);
                tracing::warn!(
                    target: "conflict_watch",
                    project = %repo.project_id,
                    worktrees = repo.dirs.len(),
                    reason,
                    "could not read this repo's PRs in ANY of its worktrees; its tracked PRs keep \
                     climbing rather than being reported clean"
                );
                // FAIL CLOSED: keep climbing on the last known facts. Reporting nothing here would
                // read as "no conflicts", which is the one thing this module must never say.
                for (pr, t) in watch.tracked.iter() {
                    if t.project_id == repo.project_id {
                        seen.insert(*pr);
                        looks.push(Look::Blind(*pr, reason));
                    }
                }
            }
        }
    }
    // Announce the sweep's collisions ONCE, and only when the set actually changed. A steady state
    // stays discoverable at debug level; a NEW or CHANGED collision is always a warning.
    match collision_digest(&collisions) {
        Some(d) => {
            if watch.last_collision_fp == Some(d.fingerprint) {
                tracing::debug!(
                    target: "conflict_watch",
                    prs = d.total,
                    projects = d.projects,
                    "PR-number collisions unchanged since the last announcement"
                );
            } else {
                tracing::warn!(
                    target: "conflict_watch",
                    prs = d.total,
                    projects = d.projects,
                    sample = %d.sample,
                    "PR numbers claimed by another project this sweep; these PRs are NOT being \
                     watched for conflicts. Announced once per distinct collision set."
                );
            }
            watch.last_collision_fp = Some(d.fingerprint);
        }
        // Cleared: the next collision, even an identical one, is news again.
        None => watch.last_collision_fp = None,
    }

    // Record readability even when NOTHING is tracked — the cold-start case, where the per-PR
    // fail-closed path above has nothing to act on and `conflict_flags` would otherwise return an
    // empty list that reads as "no conflicts". See `ProbeStatus`.
    record_probe(repos.len(), unreadable, last_error, now);

    prune_tracked(&mut watch.tracked, &probed_ok, &seen, &saturated);
    if let Some(flags) = app.try_state::<ConflictFlags>() {
        // Sweep against what SURVIVED the prune, so a flag is only ever dropped when its PR was
        // dropped — never because its project went unreadable or its worktrees were removed.
        let live: HashSet<u64> = watch.tracked.keys().copied().collect();
        sweep_closed_flags(&flags, &live);
    }

    for look in looks {
        let (pr, project_id, dir, mut facts, mut refusal) = match look {
            Look::Read(project_id, dir, f) => (f.number, project_id, Some(dir), f, None),
            Look::Blind(pr, reason) => {
                let Some(t) = watch.tracked.get(&pr) else { continue };
                (pr, t.project_id.clone(), None, blind_facts(&t.facts), Some(reason))
            }
        };
        // GitHub is still recomputing this PR's mergeability — no new information, so inherit the
        // last real verdict rather than letting the churn reset the episode. See
        // `carry_unknown_forward`; this is the second door into the reset bug.
        if refusal.is_none() {
            refusal = carry_unknown_forward(
                &mut facts,
                watch.tracked.get(&pr).map(|t| &t.facts),
            );
        }

        let entry = watch.tracked.entry(pr).or_insert_with(|| Tracked {
            state: PrState::default(),
            due_at_ms: now,
            project_id: project_id.clone(),
            facts: facts.clone(),
        });
        if now < entry.due_at_ms {
            continue;
        }
        // DUE, so the drift is now worth a subprocess. On a blind look there is nothing to ask, and
        // the last known value rides along on the facts we are reusing.
        if let Some(dir) = &dir {
            match commits_behind(dir, &facts) {
                Some(n) => facts.commits_behind = n,
                None => tracing::debug!(
                    target: "conflict_watch",
                    pr,
                    "commits-behind unreadable locally; the conflict verdict is unaffected"
                ),
            }
        }
        if refusal.is_none() {
            entry.facts = facts.clone();
            entry.project_id = project_id.clone();
        }

        let obs = observation(&facts, refusal);
        let decision = conflict_ladder::step(&mut entry.state, &obs);
        entry.due_at_ms = now.saturating_add(decision.next_look_secs * 1000);

        // INSTRUMENTATION IS NOT OPTIONAL. Without a per-look record nobody can later answer
        // "did anybody act on these flags", and the next time five PRs rot we would be guessing.
        tracing::debug!(
            target: "conflict_watch",
            pr,
            rung = decision.rung,
            changed = decision.changed,
            gate = decision.refusal.unwrap_or("pass"),
            kind = conflict_ladder::kind(&obs),
            untested = conflict_ladder::untested(&obs),
            evidence = conflict_ladder::untested_evidence(&obs),
            behind = facts.commits_behind,
            attempts = entry.state.attempts(),
            unresolved_secs = entry.state.unresolved_secs(),
            "conflict watch look"
        );

        let Some(flags) = app.try_state::<ConflictFlags>() else {
            continue;
        };
        // Resolving ownership touches the durable store, so only do it for a look that will
        // actually produce a row.
        let owner = matches!(decision.action, Action::Flag { .. })
            .then(|| resolve_owner(&app_data, &project_id, &facts))
            .flatten();
        if let Some(flag) = apply_flags(&flags, &facts, owner, &decision, &entry.state) {
            tracing::warn!(
                target: "conflict_watch",
                pr = flag.pr,
                kind = flag.kind.as_str(),
                untested = flag.untested,
                behind = flag.commits_behind,
                target_role = flag.target.as_str(),
                owner = flag.owner_agent_id.as_deref().unwrap_or("unresolved"),
                blocked_by = flag.blocked_by.as_deref().unwrap_or("none"),
                "conflict watch escalated"
            );
            // The FULL SET, not `flag` — see [`detected_payload`]. `flag` is still what the warn
            // line above reports, because "which PR just escalated" is the useful thing to log; it
            // is not the useful thing to send, because the consumer replaces its whole reading.
            let _ = app.emit("conflict://detected", detected_payload(&flags));
        }
    }

    // Next scan: the earliest per-PR deadline, capped so a brand-new PR is still discovered while
    // everything tracked is parked on the two-hour rung.
    let earliest_due = watch.tracked.values().map(|t| t.due_at_ms).min();
    let discovery = now.saturating_add(DISCOVERY_SECS * 1000);
    watch.next_scan_at_ms = earliest_due.map_or(discovery, |d| d.min(discovery));
}

#[cfg(test)]
mod tests {
    use super::*;
    use conflict_ladder::Observation;

    fn collisions(pairs: &[(&str, u64)]) -> Vec<(String, u64)> {
        pairs.iter().map(|(p, n)| ((*p).to_string(), *n)).collect()
    }

    #[test]
    fn no_collisions_produces_no_announcement() {
        assert!(collision_digest(&[]).is_none());
    }

    #[test]
    fn digest_counts_prs_and_distinct_projects() {
        let d = collision_digest(&collisions(&[("alpha", 12), ("alpha", 13), ("beta", 12)]))
            .expect("collisions present");
        assert_eq!(d.total, 3, "every skipped PR is counted");
        assert_eq!(d.projects, 2, "distinct projects, not rows");
    }

    /// The whole point: the same collision set re-derived next sweep must fingerprint EQUAL, so it
    /// is announced once rather than once per PR per sweep.
    #[test]
    fn identical_set_fingerprints_equal_regardless_of_order() {
        let a = collision_digest(&collisions(&[("alpha", 12), ("beta", 30), ("alpha", 13)]))
            .expect("collisions present");
        // `discover_repos` gives no order guarantee, so an identical set may arrive permuted.
        let b = collision_digest(&collisions(&[("beta", 30), ("alpha", 13), ("alpha", 12)]))
            .expect("collisions present");
        assert_eq!(a.fingerprint, b.fingerprint);
    }

    /// …and the other half: a set that CHANGED must never be silently swallowed by the dedupe.
    #[test]
    fn changed_set_fingerprints_differently() {
        let base = collision_digest(&collisions(&[("alpha", 12)])).expect("collisions present");

        let added = collision_digest(&collisions(&[("alpha", 12), ("alpha", 13)]))
            .expect("collisions present");
        assert_ne!(base.fingerprint, added.fingerprint, "a NEW skipped PR is news");

        let other_pr = collision_digest(&collisions(&[("alpha", 13)])).expect("collisions present");
        assert_ne!(base.fingerprint, other_pr.fingerprint, "a different PR is news");

        // Same PR number, different loser project — the cross-project case this module is about.
        let other_project =
            collision_digest(&collisions(&[("beta", 12)])).expect("collisions present");
        assert_ne!(
            base.fingerprint, other_project.fingerprint,
            "a different project losing the same number is news"
        );
    }

    /// A duplicate row is the same fact twice, not a second collision.
    #[test]
    fn repeated_pair_is_counted_once() {
        let d = collision_digest(&collisions(&[("alpha", 12), ("alpha", 12)]))
            .expect("collisions present");
        assert_eq!(d.total, 1);
        assert_eq!(d.sample, "alpha#12");
    }

    #[test]
    fn sample_names_names_and_is_bounded() {
        let many: Vec<(String, u64)> = (0..COLLISION_SAMPLE as u64 + 5)
            .map(|n| ("alpha".to_string(), 100 + n))
            .collect();
        let d = collision_digest(&many).expect("collisions present");

        assert_eq!(d.total, COLLISION_SAMPLE + 5);
        assert!(d.sample.starts_with("alpha#100, alpha#101"), "sample: {}", d.sample);
        assert!(d.sample.ends_with("…+5"), "the elision states how many it dropped: {}", d.sample);
        assert_eq!(
            d.sample.matches("alpha#").count(),
            COLLISION_SAMPLE,
            "the line must stay one readable line, not all {} pairs",
            d.total
        );
    }

    /// A PR that went DIRTY and stayed there, with no checks at all — the shape the bead describes.
    fn conflicting_facts() -> PrFacts {
        PrFacts {
            number: 1091,
            project_id: "project-alpha".into(),
            title: "Collapse the backlog notice".into(),
            branch: "sparkle/jsdom-test-caveats".into(),
            head_oid: "a1b2c3d4e5f60718".into(),
            base_oid: "0f1e2d3c4b5a6978".into(),
            merge_state: "dirty".into(),
            is_draft: false,
            is_dirty: true,
            has_ci: false,
            commits_behind: 220,
            url: "https://github.com/o/r/pull/1091".into(),
            carried_looks: 0,
        }
    }

    /// Walk the ladder to the Nth flagging look and hand back the state and decision, so a flag can
    /// be built from real ladder output rather than from a hand-made state whose fields already say
    /// what the assertion is about.
    fn climb(obs: &Observation, looks: usize) -> (PrState, conflict_ladder::Decision) {
        let mut s = PrState::default();
        let mut d = conflict_ladder::step(&mut s, obs);
        for _ in 1..looks {
            d = conflict_ladder::step(&mut s, obs);
        }
        (s, d)
    }

    // ══ THE DECODER ═════════════════════════════════════════════════════════════════════════════

    #[test]
    fn garbage_from_gh_reads_as_unknown_and_never_as_no_conflicts() {
        // The null-vs-zero discipline, which here is the difference between "this repo is clean"
        // and "we could not read this repo".
        assert_eq!(decode_open_prs(""), None);
        assert_eq!(decode_open_prs("not json"), None);
        assert_eq!(decode_open_prs(r#"{"message":"Bad credentials"}"#), None);
        // A known-empty array IS an answer.
        assert_eq!(decode_open_prs("[]"), Some(vec![]));
    }

    #[test]
    fn the_decoder_reads_dirty_draft_and_the_absence_of_checks() {
        let json = r#"[
          {"number":1,"title":"a","headRefName":"sparkle/one","headRefOid":"aaaa111",
           "baseRefOid":"bbbb222","mergeStateStatus":"DIRTY","isDraft":false,
           "url":"u1","statusCheckRollup":[]},
          {"number":2,"title":"b","headRefName":"sparkle/two","headRefOid":"cccc333",
           "baseRefOid":"bbbb222","mergeStateStatus":"CLEAN","isDraft":true,
           "url":"u2","statusCheckRollup":[{"conclusion":"SUCCESS"}]},
          {"title":"no number"}
        ]"#;
        let rows = decode_open_prs(json).expect("valid array");
        assert_eq!(rows.len(), 2, "the numberless row is dropped, the rest survive");

        assert!(rows[0].is_dirty, "DIRTY is the whole conflict detector");
        assert_eq!(rows[0].merge_state, "dirty", "lowercased, like worktree.rs's");
        assert!(!rows[0].has_ci, "an EMPTY rollup means no check run exists");
        assert!(!rows[0].is_draft);

        assert!(!rows[1].is_dirty);
        assert!(rows[1].is_draft);
        assert!(rows[1].has_ci);
        assert_eq!(rows[1].branch, "sparkle/two");
    }

    /// An ABSENT rollup key is the same observation as an empty one, and must not read as "checks
    /// exist" — that would downgrade a confirmed untested conflict to an inferred one.
    #[test]
    fn a_missing_rollup_key_reads_as_no_checks() {
        let rows = decode_open_prs(r#"[{"number":9,"mergeStateStatus":"DIRTY"}]"#).unwrap();
        assert!(!rows[0].has_ci);
    }

    // ══ EPISODE IDENTITY ════════════════════════════════════════════════════════════════════════

    /// The head oid and the merge state ARE the identity; the base oid is NOT (roborev 57856).
    #[test]
    fn the_identity_hash_moves_with_head_and_merge_state_but_never_with_the_base() {
        let base = conflicting_facts();
        let h = identity_hash(&base);
        assert_eq!(h, identity_hash(&conflicting_facts()), "stable for identical facts");
        assert_ne!(
            h,
            identity_hash(&PrFacts { head_oid: "999abcd".into(), ..base.clone() }),
            "the author pushing must end the episode"
        );
        assert_ne!(
            h,
            identity_hash(&PrFacts { merge_state: "clean".into(), is_dirty: false, ..base.clone() }),
            "a PR that stops being DIRTY must read as a NEW situation"
        );
        // THE ONE THAT WOULD HAVE DESTROYED THE MODULE. `baseRefOid` is `main`'s head; it advances
        // many times an hour here, while the founder rung is ~6 hours of unbroken episode away. If
        // it were identity, every landing on `main` would reset every open PR AND retract its flag.
        assert_eq!(
            h,
            identity_hash(&PrFacts { base_oid: "999abcd".into(), ..base.clone() }),
            "a base move AGGRAVATES a conflict; it must not reset the episode"
        );
        // Same for anything else that is not identity, or every unrelated edit would reset.
        assert_eq!(h, identity_hash(&PrFacts { title: "renamed".into(), commits_behind: 9, ..base }));
    }

    /// `UNKNOWN` IS THE ABSENCE OF A READING, NOT A STATE OF THE PR (roborev 57881).
    ///
    /// GitHub computes mergeability asynchronously and invalidates it on every push to the base, so
    /// a query taken mid-recompute returns `UNKNOWN`. With that folded into the identity, the very
    /// same landing on `main` that dropping `base_oid` set out to make harmless still walked a
    /// conflicting PR through `dirty → unknown → dirty` — two resets, two retracted flags.
    #[test]
    fn an_unknown_merge_state_inherits_the_last_real_verdict() {
        let known = conflicting_facts();
        // Mid-recompute: GitHub says nothing, so `is_dirty` decodes false — which is ALSO what
        // would have vetoed a genuinely conflicting PR as "mergeable".
        let mut recomputing = PrFacts {
            merge_state: MERGE_STATE_UNKNOWN.into(),
            is_dirty: false,
            ..conflicting_facts()
        };
        assert_ne!(
            identity_hash(&known),
            identity_hash(&recomputing),
            "precondition: taken at face value this IS a different identity"
        );

        let refusal = carry_unknown_forward(&mut recomputing, Some(&known));
        assert_eq!(refusal, None, "we have a real recent verdict; this is not a refusal");
        assert!(recomputing.is_dirty, "the last real verdict is inherited");
        assert_eq!(
            identity_hash(&recomputing),
            identity_hash(&known),
            "so the episode's identity does not move, and nothing is reset or retracted"
        );

        // A REAL push takes the refusal arm, NOT the inheritance (roborev 57915). This is the most
        // common real sequence, not an edge case: the agent is told its PR conflicts, merges `main`
        // in and pushes — and a push to the head is exactly what makes GitHub return UNKNOWN next
        // look. Copying head A's `dirty` onto head B accumulates a fresh conflicting episode
        // against the very commit that FIXED the conflict.
        let mut pushed = PrFacts {
            merge_state: MERGE_STATE_UNKNOWN.into(),
            is_dirty: false,
            head_oid: "fedcba9".into(),
            ..conflicting_facts()
        };
        assert_eq!(
            carry_unknown_forward(&mut pushed, Some(&known)),
            Some("mergeability-unknown"),
            "a new head has no verdict of its own — that is 'we know nothing', so fail closed"
        );
        assert!(!pushed.is_dirty, "and the OLD head's conflict must NOT be copied onto the new one");
        assert_ne!(identity_hash(&pushed), identity_hash(&known), "an author push must still reset");

        // Nothing to inherit — a PR seen for the first time mid-recompute. That IS "we know
        // nothing", so it fails closed rather than being vetoed as fine.
        let mut first_sight =
            PrFacts { merge_state: MERGE_STATE_UNKNOWN.into(), is_dirty: false, ..conflicting_facts() };
        assert_eq!(
            carry_unknown_forward(&mut first_sight, None),
            Some("mergeability-unknown")
        );
        // ...and an earlier unknown is not a verdict to inherit either.
        let mut again =
            PrFacts { merge_state: MERGE_STATE_UNKNOWN.into(), is_dirty: false, ..conflicting_facts() };
        assert_eq!(
            carry_unknown_forward(&mut again, Some(&first_sight)),
            Some("mergeability-unknown")
        );
    }

    /// A VERDICT IS NOT CARRIED FOREVER (roborev 57915). GitHub's recompute takes seconds and our
    /// floor between looks is 120s, so past the cap the honest answer is "we cannot tell".
    #[test]
    fn a_carried_verdict_is_bounded_and_then_fails_closed() {
        let mut previous = conflicting_facts();
        assert_eq!(previous.carried_looks, 0, "precondition: read first-hand");

        for i in 1..=MAX_CARRIED_LOOKS {
            let mut fresh = PrFacts {
                merge_state: MERGE_STATE_UNKNOWN.into(),
                is_dirty: false,
                ..conflicting_facts()
            };
            assert_eq!(carry_unknown_forward(&mut fresh, Some(&previous)), None, "carry {i}");
            assert_eq!(fresh.carried_looks, i, "each consecutive carry is counted");
            assert!(fresh.is_dirty);
            previous = fresh;
        }

        // One carry past the cap: still no verdict, so stop pretending we have one — but the row
        // must KEEP the inherited verdict, or the refusal itself moves the identity (roborev 57927).
        let mut too_far = PrFacts {
            merge_state: MERGE_STATE_UNKNOWN.into(),
            is_dirty: false,
            ..conflicting_facts()
        };
        assert_eq!(
            carry_unknown_forward(&mut too_far, Some(&previous)),
            Some("mergeability-unknown"),
            "a recompute that has outlasted {MAX_CARRIED_LOOKS} looks is not a recompute any more"
        );
        assert!(too_far.is_dirty, "the verdict stays on the row even though we refuse");
        assert_eq!(
            identity_hash(&too_far),
            identity_hash(&conflicting_facts()),
            "so the head is unchanged AND the identity is unchanged: nothing resets, nothing retracts"
        );

        // ...and one real reading resets the budget, so a busy `main` cannot exhaust it for good.
        let mut read = conflicting_facts();
        read.carried_looks = 99;
        assert_eq!(carry_unknown_forward(&mut read, Some(&previous)), None);
        assert_eq!(read.carried_looks, 0, "a first-hand reading clears the carry counter");
    }

    /// A CARRIED VERDICT MUST NOT BE PRESENTED AS FIRST-HAND (roborev 57915).
    ///
    /// `"no-checks-ran"` is documented as "directly observed; the fully-confirmed case", and the
    /// carry path deliberately emits no refusal (a recompute is not a failure to read) — so without
    /// its own disclosure an inherited verdict was indistinguishable from a fresh one on the very
    /// channel added to disclose that difference.
    #[test]
    fn a_carried_verdict_says_so_on_the_flag() {
        let known = conflicting_facts();
        let mut carried = PrFacts {
            merge_state: MERGE_STATE_UNKNOWN.into(),
            is_dirty: false,
            ..conflicting_facts()
        };
        assert_eq!(carry_unknown_forward(&mut carried, Some(&known)), None);

        let (state, decision) = climb(&observation(&carried, None), 3);
        let flag = build_flag(&carried, None, &decision, &state, None);
        assert_eq!(flag.kind, "conflicting", "the inherited verdict is still acted on");
        assert!(flag.untested);
        assert_eq!(flag.evidence, "last-known", "but it is NOT claimed as first-hand");
        assert_eq!(flag.blocked_by, None, "and it is not a refusal — nothing extra escalates");

        // THE CONTROL: the same verdict read first-hand DOES claim direct observation.
        let (s2, d2) = climb(&observation(&known, None), 3);
        assert_eq!(build_flag(&known, None, &d2, &s2, None).evidence, "no-checks-ran");
    }

    /// A `mergeStateStatus` WE DO NOT UNDERSTAND IS NOT "GITHUB IS STILL DECIDING" (roborev 57915).
    ///
    /// Conflating them meant a renamed or newly-added value would freeze every PR's verdict at
    /// whatever was last read — identity pinned, `changed` never firing, a raised flag unable to
    /// auto-retract — completely silently.
    #[test]
    fn an_unrecognised_merge_state_fails_closed_instead_of_freezing_a_verdict() {
        assert_eq!(normalize_merge_state("SOMETHING_GITHUB_ADDED"), MERGE_STATE_UNRECOGNIZED);
        let known = conflicting_facts();
        let mut weird = PrFacts {
            merge_state: MERGE_STATE_UNRECOGNIZED.into(),
            is_dirty: false,
            ..conflicting_facts()
        };
        assert_eq!(
            carry_unknown_forward(&mut weird, Some(&known)),
            Some("merge-state-unrecognized"),
            "we do not understand the reading, so we do not get to keep the old one"
        );
        // ...but the row still KEEPS the last verdict, so the refusal does not move the identity
        // (roborev 57927). Otherwise ONE renamed GitHub value would clear the whole fleet's flags
        // in a single sweep and re-raise them all mislabelled as "stale".
        assert!(weird.is_dirty, "the last verdict stays on the row");
        assert_eq!(
            identity_hash(&weird),
            identity_hash(&known),
            "same head, same identity — the uncertainty lives in `refusal`, not in the identity"
        );

        // A new HEAD with an unrecognised state has nothing to inherit, and there the identity
        // SHOULD move: it is a genuinely new situation.
        let mut weird_new_head = PrFacts {
            merge_state: MERGE_STATE_UNRECOGNIZED.into(),
            is_dirty: false,
            head_oid: "fedcba9".into(),
            ..conflicting_facts()
        };
        assert_eq!(
            carry_unknown_forward(&mut weird_new_head, Some(&known)),
            Some("merge-state-unrecognized")
        );
        assert!(!weird_new_head.is_dirty, "nothing to inherit for a commit we have never judged");
        assert_ne!(identity_hash(&weird_new_head), identity_hash(&known));
    }

    /// THE REFUSAL MUST NOT RETRACT THE FLAG IT EXISTS TO PRESERVE (roborev 57927).
    ///
    /// Driven end to end through `step` + `apply_flags`, because that is where the damage happened
    /// and the isolated `carry_unknown_forward` tests could not see it: a refusal returned over a
    /// row still carrying the sentinel moves the identity on an UNCHANGED head, so `step` resets
    /// the episode and `apply_flags` clears the row — a founder-level flag on a still-conflicting
    /// PR retracted at the 4th unknown look, re-climbing hours to get back, and returning labelled
    /// `"stale"`. For an unrecognised value it would do that to every tracked PR at once.
    #[test]
    fn exhausting_the_carry_never_retracts_a_standing_flag() {
        for sentinel in [MERGE_STATE_UNKNOWN, MERGE_STATE_UNRECOGNIZED] {
            let flags = ConflictFlags::default();
            let mut state = PrState::default();
            let mut previous = conflicting_facts();

            // Climb to a standing founder-level flag on a first-hand `dirty` reading.
            for _ in 0..9 {
                let d = conflict_ladder::step(&mut state, &observation(&previous, None));
                apply_flags(&flags, &previous, None, &d, &state);
            }
            assert_eq!(flags.list().len(), 1, "{sentinel}: precondition: flagged");
            assert_eq!(flags.list()[0].target, "founder", "{sentinel}: precondition");
            let raised_at = flags.list()[0].raised_at_ms;

            // Now GitHub goes quiet on the SAME head, well past the carry cap.
            for i in 0..(MAX_CARRIED_LOOKS + 4) {
                let mut fresh =
                    PrFacts { merge_state: sentinel.into(), is_dirty: false, ..conflicting_facts() };
                let refusal = carry_unknown_forward(&mut fresh, Some(&previous));
                let d = conflict_ladder::step(&mut state, &observation(&fresh, refusal));
                assert!(!d.changed, "{sentinel} look {i}: an unchanged head must not reset");
                apply_flags(&flags, &fresh, None, &d, &state);
                // Only a look we still TRUST is written back, exactly as the driver does.
                if refusal.is_none() {
                    previous = fresh;
                }
            }

            let row = flags.list();
            assert_eq!(row.len(), 1, "{sentinel}: the flag must still be standing");
            assert_eq!(row[0].target, "founder", "{sentinel}: and must not have re-climbed");
            assert_eq!(row[0].raised_at_ms, raised_at, "{sentinel}: same episode, same raise time");
            assert_eq!(
                row[0].kind, "conflicting",
                "{sentinel}: and must not be relabelled 'stale' off an un-inherited row"
            );
            assert!(row[0].untested);
            // The row says it is an INHERITED verdict we could not confirm — not "we know nothing
            // about this commit", which is what `"unknown"` means and what a consumer would grey
            // out (roborev 57937).
            assert_eq!(
                row[0].evidence, "last-known-unconfirmed",
                "{sentinel}: a refused-but-inherited row is its own state"
            );
            let expected_block = if sentinel == MERGE_STATE_UNRECOGNIZED {
                "merge-state-unrecognized"
            } else {
                "mergeability-unknown"
            };
            assert_eq!(
                row[0].blocked_by.as_deref(),
                Some(expected_block),
                "{sentinel}: and WHY we could not confirm it"
            );
        }
    }

    /// The decoder must produce the sentinel the logic above keys on, for every shape GitHub can
    /// hand back mid-recompute.
    #[test]
    fn every_undecided_merge_state_normalizes_to_the_unknown_sentinel() {
        assert_eq!(normalize_merge_state("DIRTY"), "dirty");
        assert_eq!(normalize_merge_state("CLEAN"), "clean");
        assert_eq!(normalize_merge_state("UNSTABLE"), "unstable");
        for undecided in ["UNKNOWN", ""] {
            assert_eq!(normalize_merge_state(undecided), MERGE_STATE_UNKNOWN, "{undecided}");
        }
        // A value we do not understand gets its OWN sentinel — it is not "still deciding", and
        // treating it as such would freeze a verdict forever (roborev 57915).
        assert_eq!(normalize_merge_state("SOMETHING_NEW"), MERGE_STATE_UNRECOGNIZED);
        // ...and through the real decoder, where a missing key is the same as an explicit UNKNOWN.
        let rows = decode_open_prs(
            r#"[{"number":1,"mergeStateStatus":"UNKNOWN"},{"number":2}]"#,
        )
        .unwrap();
        assert_eq!(rows[0].merge_state, MERGE_STATE_UNKNOWN);
        assert_eq!(rows[1].merge_state, MERGE_STATE_UNKNOWN);
        assert!(!rows[0].is_dirty, "and UNKNOWN is never mistaken for a conflict");
    }

    /// END TO END: the churn a base move really produces. Twelve looks, every one of them landing
    /// mid-recompute on alternate ticks, and the episode must survive all of it.
    #[test]
    fn a_pr_survives_the_dirty_unknown_dirty_churn_of_a_busy_main() {
        let flags = ConflictFlags::default();
        let mut state = PrState::default();
        let mut escalations = Vec::new();
        let known = conflicting_facts();
        let mut previous = known.clone();

        for i in 0..12u64 {
            // Every other look catches GitHub mid-recompute, exactly as a push to `main` causes.
            let mut facts = if i % 2 == 1 {
                PrFacts {
                    merge_state: MERGE_STATE_UNKNOWN.into(),
                    is_dirty: false,
                    base_oid: format!("{:07x}", 0xbee_f000 + i),
                    ..known.clone()
                }
            } else {
                PrFacts { base_oid: format!("{:07x}", 0xbee_f000 + i), ..known.clone() }
            };
            let refusal = carry_unknown_forward(&mut facts, Some(&previous));
            assert_eq!(refusal, None, "look {i}: a recompute is not a refusal");
            previous = facts.clone();

            let d = conflict_ladder::step(&mut state, &observation(&facts, refusal));
            assert!(!d.changed, "look {i}: the recompute must not reset the episode");
            if let Some(f) = apply_flags(&flags, &facts, None, &d, &state) {
                escalations.push(f.target);
            }
        }

        assert_eq!(escalations, vec!["agent", "concierge", "founder"]);
        let rows = flags.list();
        assert_eq!(rows.len(), 1, "one flag, still standing — not retracted six times over");
        assert_eq!(rows[0].kind, "conflicting", "and never mislabelled as merely stale");
        assert!(rows[0].untested);
    }

    /// END TO END, and the case the bug would actually have hit: `main` advances on EVERY look
    /// while the PR stays DIRTY. The episode must survive it and still reach the founder, and the
    /// flag must still be standing at the end.
    #[test]
    fn a_pr_stays_flagged_while_main_advances_underneath_it() {
        let flags = ConflictFlags::default();
        let mut state = PrState::default();
        let mut escalations = Vec::new();
        let mut facts = conflicting_facts();

        for i in 0..12u64 {
            // Somebody lands on `main`: the base moves, and the PR gets further behind.
            facts.base_oid = format!("{:07x}", 0xbee_f000 + i);
            facts.commits_behind += 3;
            let d = conflict_ladder::step(&mut state, &observation(&facts, None));
            assert!(!d.changed, "look {i}: a base move must not reset the episode");
            if let Some(f) = apply_flags(&flags, &facts, None, &d, &state) {
                escalations.push(f.target);
            }
        }

        assert_eq!(escalations, vec!["agent", "concierge", "founder"]);
        let rows = flags.list();
        assert_eq!(rows.len(), 1, "the flag must still be standing, not retracted 12 times over");
        assert_eq!(rows[0].target, "founder");
        assert_eq!(rows[0].commits_behind, 220 + 12 * 3, "and it reports the CURRENT drift");
    }

    /// THE EVENT PAYLOAD IS A JSON ARRAY, because the consumer parses it with an all-or-nothing
    /// array parser and drops anything else on the floor.
    ///
    /// This asserts the SERIALIZED shape rather than the Rust type: `Vec<ConflictFlag>` is an array
    /// by construction, so a test over the Rust value would pass against the bug it is here to
    /// catch. The regression was `emit(..., &flag)` — one flag, serializing to a JSON object — and
    /// the only place that difference is observable is after serde.
    #[test]
    fn the_detected_event_payload_serializes_as_an_array() {
        let flags = ConflictFlags::default();
        let facts = conflicting_facts();
        let (state, decision) = climb(&observation(&facts, None), 3);
        assert!(apply_flags(&flags, &facts, None, &decision, &state).is_some(), "a flag stands");

        let json = serde_json::to_value(detected_payload(&flags)).expect("payload serializes");
        let rows = json.as_array().expect("a JSON OBJECT here is the bug: the consumer needs an array");
        assert_eq!(rows.len(), 1, "the full set, which is the one standing flag");
        assert_eq!(rows[0]["pr"], facts.number, "and the entry is the flag, not a wrapper around it");
        // The per-entry field names are pinned by `the_flag_serializes_with_the_contract_field_names`;
        // what is asserted HERE is only the container, which is what the emit got wrong.
    }

    /// A SECOND standing flag must ride along on an escalation for the FIRST one.
    ///
    /// The delta this replaced could not do that: it sent only the PR that had just escalated. The
    /// consumer REPLACES its whole reading rather than merging, so under a delta every event would
    /// have told it that every other conflicting PR had resolved. Whole-set semantics are what make
    /// replace-don't-merge correct over there.
    #[test]
    fn the_payload_carries_every_standing_flag_not_just_the_one_that_escalated() {
        let flags = ConflictFlags::default();
        let first = conflicting_facts();
        let second = PrFacts { number: first.number + 1, ..conflicting_facts() };

        for facts in [&second, &first] {
            let (state, decision) = climb(&observation(facts, None), 3);
            apply_flags(&flags, facts, None, &decision, &state);
        }

        let prs: Vec<u64> = detected_payload(&flags).iter().map(|f| f.pr).collect();
        assert_eq!(prs.len(), 2, "both standing flags travel on every emit");
        assert!(prs.contains(&first.number) && prs.contains(&second.number));
    }

    /// The three oid-shaped fields go straight into a `git` argument.
    #[test]
    fn only_hex_object_ids_reach_a_git_argument() {
        assert!(is_safe_oid("a1b2c3d"));
        assert!(is_safe_oid(&"a".repeat(40)));
        assert!(!is_safe_oid("a1b2c3"), "too short to be an oid");
        assert!(!is_safe_oid(&"a".repeat(65)));
        assert!(!is_safe_oid("--upload-pack=evil"));
        assert!(!is_safe_oid("HEAD~1"));
        assert!(!is_safe_oid("a1b2c3d;rm -rf /"));
        assert!(!is_safe_oid(""));
    }

    // ══ THE FLAG'S FIELDS ═══════════════════════════════════════════════════════════════════════

    /// THE HEADLINE FACT, asserted on the FIELD the consumer actually reads — not on the enum it
    /// was derived from. A conflicting PR is untested because GitHub never fired `pull_request`; a
    /// merely-stale one still merges, so its checks really ran.
    #[test]
    fn untested_is_true_on_the_flag_exactly_when_the_kind_is_conflicting() {
        let dirty = conflicting_facts();
        let (state, decision) = climb(&observation(&dirty, None), 3);
        let flag = build_flag(&dirty, None, &decision, &state, None);
        assert_eq!(flag.kind, "conflicting");
        assert!(flag.untested, "conflicting AND THEREFORE UNTESTED, as one fact");
        assert_eq!(flag.commits_behind, 220);

        let stale = PrFacts {
            merge_state: "clean".into(),
            is_dirty: false,
            has_ci: true,
            ..conflicting_facts()
        };
        let (state, decision) = climb(&observation(&stale, None), 3);
        let flag = build_flag(&stale, None, &decision, &state, None);
        assert_eq!(flag.kind, "stale");
        assert!(!flag.untested, "a stale PR merges, so it ran, so its green is real");
    }

    /// `owner_agent_id: None` means UNRESOLVED. Nothing here may invent one — a flag naming the
    /// wrong agent is strictly worse than one naming none, and the five PRs this bead is about are
    /// all on DESCRIPTIVE branches that carry no id to parse.
    #[test]
    fn an_unresolved_owner_stays_null_and_the_branch_is_not_mined_for_one() {
        let facts = conflicting_facts();
        assert!(
            crate::pr_owner::agent_id_from_branch(&facts.branch).is_none(),
            "precondition: this branch carries no agent id at all"
        );
        let (state, decision) = climb(&observation(&facts, None), 3);
        let flag = build_flag(&facts, None, &decision, &state, None);
        assert_eq!(flag.owner_agent_id, None);
        assert_eq!(flag.branch, "sparkle/jsdom-test-caveats");
    }

    /// The flag's target follows the ladder's escalation, and the flag reports the CURRENT rung and
    /// age rather than whatever they were at the last escalation.
    #[test]
    fn the_flag_reports_the_current_target_rung_and_age() {
        let facts = conflicting_facts();
        let obs = observation(&facts, None);

        let (state, decision) = climb(&obs, 3);
        let first = build_flag(&facts, None, &decision, &state, None);
        assert_eq!(first.target, "agent", "the OWNER is told first");
        assert_eq!(first.rung, 3);
        assert_eq!(first.unresolved_secs, 420);

        let (state, decision) = climb(&obs, 5);
        let later = build_flag(&facts, None, &decision, &state, None);
        assert_eq!(later.target, "concierge");
        assert_eq!(later.rung, 5);
        assert!(later.unresolved_secs > first.unresolved_secs, "the age must keep moving");
    }

    /// A BLIND LOOK AFTER A CARRY IS STILL BLIND (roborev 57946).
    ///
    /// `carried_looks` is sticky by construction — only a first-hand reading zeroes it — and the
    /// blind path reuses the stored facts. So without an explicit reset, ONE earlier carry made
    /// every later unreadable-repo look serialize `last-known-unconfirmed`: "a real same-head
    /// verdict exists, we just could not confirm the head." That claim is false when we could not
    /// read the repo at all, and it is the weaker disclaimer, so a consumer acts on a verdict
    /// nothing vouches for.
    ///
    /// The existing blind-look test above misses this by construction: its fixture has
    /// `carried_looks == 0`, so it pins the strong case and never the weak one.
    #[test]
    fn a_blind_look_after_a_carry_still_reports_unknown() {
        let carried = PrFacts { carried_looks: 2, ..conflicting_facts() };

        // THE CONTROL, and it is what stops this being vacuous: reusing the stored facts VERBATIM —
        // what the blind path did before — yields the weaker value. Without this half, the
        // assertion below passes against a `blind_facts` that does nothing at all.
        assert_eq!(
            conflict_ladder::untested_evidence(&observation(&carried, Some("gh-failed"))),
            "last-known-unconfirmed",
            "control: the stored facts still carry a same-head claim"
        );

        // THE SIDE EFFECT: the derivation the blind path actually calls.
        let blind = blind_facts(&carried);
        assert_eq!(
            conflict_ladder::untested_evidence(&observation(&blind, Some("gh-failed"))),
            "unknown",
            "a look that read nothing must degrade to the strongest disclaimer"
        );

        // And the identity is UNCHANGED — the episode must not restart just because we zeroed the
        // carry, or this fix re-opens the retraction bug it sits next to.
        assert_eq!(
            identity_hash(&blind),
            identity_hash(&carried),
            "zeroing the carry must not move the episode identity"
        );

        // `"unknown"` MUST NOT MEAN "empty row" (roborev 57969). The verdict is still inherited and
        // still reaches somebody — a consumer that greys out `unknown` rows would suppress a real,
        // still-standing conflict for the whole duration of a `gh` outage, which is precisely what
        // `"last-known-unconfirmed"` was introduced to prevent. Pin the pair together so the doc's
        // licence ("we cannot vouch for this verdict", never "there is no verdict") stays true of
        // what the row actually carries.
        let (state, decision) = climb(&observation(&blind, Some("gh-failed")), 3);
        let flag = build_flag(&blind, None, &decision, &state, None);
        assert_eq!(flag.evidence, "unknown");
        assert_eq!(flag.kind, "conflicting", "the inherited verdict is still on the row");
        assert!(flag.untested, "and it is still untested — we could not vouch for it");
        assert_eq!(flag.blocked_by.as_deref(), Some("gh-failed"), "with the reason attached");
        assert_eq!(flag.target, "agent", "and it still reaches somebody");
    }

    /// `blocked_by` is what separates "it is conflicting" from "we cannot tell what it is".
    #[test]
    fn a_repo_we_could_not_read_says_so_on_the_flag() {
        // The facts are the LAST KNOWN ones and every "fine" field in them is stale — which is
        // exactly the case that must not read as clean.
        let facts = PrFacts { merge_state: "clean".into(), is_dirty: false, ..conflicting_facts() };
        let (state, decision) = climb(&observation(&facts, Some("gh-failed")), 3);
        let flag = build_flag(&facts, None, &decision, &state, None);
        assert_eq!(flag.blocked_by.as_deref(), Some("gh-failed"));
        assert_eq!(flag.target, "agent", "and it still reaches somebody");

        // THE REFUSAL MUST REACH THE FLAG'S OWN DERIVATION (roborev 57873).
        //
        // `kind` stays the last thing `gh` actually said — it is a frozen contract and inventing an
        // "unreadable" value would break a consumer that has never seen one. `untested` is where
        // the uncertainty has to land, because `false` there is not neutral: it is the positive
        // claim "this PR's checks really ran", which is precisely what we cannot say.
        assert_eq!(flag.kind, "stale", "the last thing gh actually said about it");
        assert!(
            flag.untested,
            "we could not read it, so we cannot vouch that it was tested — fail closed"
        );
        // And the uncertainty CROSSES THE BOUNDARY (roborev 57881). The escape hatch this module
        // documented used to be a Rust function no frontend could call, reaching exactly one debug
        // log line; `evidence` is that value on the serialized channel.
        assert_eq!(flag.evidence, "unknown");

        // THE CONTROL. The SAME facts read cleanly answer the other way, so the assertion above is
        // about the refusal reaching `build_flag` and not about some other field of the fixture.
        // (Without this pair, dropping the refusal on the floor inside `build_flag` left every
        // assertion here green — the vacuous-test trap, hit while fixing a finding about it.)
        let (clean_state, clean_decision) = climb(&observation(&facts, None), 3);
        let clean = build_flag(&facts, None, &clean_decision, &clean_state, None);
        assert_eq!(clean.kind, "stale");
        assert!(!clean.untested, "a PR we DID read, and which merges, really was tested");
        assert_eq!(clean.blocked_by, None);
    }

    /// `raised_at_ms` MUST NOT MOVE ACROSS A REFRESH (roborev 57873).
    ///
    /// The row is deliberately rewritten every flagging look. Restamping this field along with it
    /// made it mean "when we last looked", so a consumer computing the flag's age from it read ~0
    /// for a conflict that had sat for two days — the exact staleness the refresh exists to
    /// prevent, moved into a different field. It is also `list()`'s sort key.
    #[test]
    fn the_raise_time_survives_a_refresh_but_not_a_new_episode() {
        let flags = ConflictFlags::default();
        let facts = conflicting_facts();
        let obs = observation(&facts, None);
        let mut state = PrState::default();
        for _ in 0..3 {
            let d = conflict_ladder::step(&mut state, &obs);
            apply_flags(&flags, &facts, None, &d, &state);
        }
        let first = flags.list()[0].raised_at_ms;
        assert!(first > 0);

        // Many more refreshes, each of which rewrites the row.
        for _ in 0..10 {
            let d = conflict_ladder::step(&mut state, &obs);
            apply_flags(&flags, &facts, None, &d, &state);
        }
        let row = flags.list().remove(0);
        assert_eq!(row.raised_at_ms, first, "the raise time is the ORIGINAL one");
        assert!(row.rung > 3, "while the rung really did move: {}", row.rung);
        assert!(row.unresolved_secs > 420, "and so did the age");

        // A NEW episode gets a new timestamp, because `changed` clears the row first.
        let fixed = PrFacts { merge_state: "clean".into(), is_dirty: false, ..conflicting_facts() };
        let d = conflict_ladder::step(&mut state, &observation(&fixed, None));
        apply_flags(&flags, &fixed, None, &d, &state);
        assert!(flags.list().is_empty(), "resolved, so retracted — nothing to carry forward");
        assert_eq!(flags.raised_at(facts.number), None);
    }

    // ══ RAISING, REFRESHING AND RETRACTING ══════════════════════════════════════════════════════

    #[test]
    fn flags_are_one_row_per_pr_and_clearable() {
        let flags = ConflictFlags::default();
        assert!(flags.list().is_empty());

        let facts = conflicting_facts();
        let obs = observation(&facts, None);
        let mut state = PrState::default();
        for _ in 0..8 {
            let d = conflict_ladder::step(&mut state, &obs);
            apply_flags(&flags, &facts, None, &d, &state);
        }
        let listed = flags.list();
        assert_eq!(listed.len(), 1, "one row per PR, not a stream");
        assert_eq!(listed[0].pr, 1091);

        flags.clear(1091);
        assert!(flags.list().is_empty(), "the consumer must be able to drop a row it acted on");
    }

    /// THE AUTO-RETRACTION. A PR that becomes MERGEABLE changes its identity hash, which resets the
    /// episode — and the flag must not outlive its truth.
    #[test]
    fn a_pr_that_becomes_mergeable_auto_retracts_its_flag() {
        let flags = ConflictFlags::default();
        let dirty = conflicting_facts();
        let obs = observation(&dirty, None);
        let mut state = PrState::default();
        for _ in 0..6 {
            let d = conflict_ladder::step(&mut state, &obs);
            apply_flags(&flags, &dirty, None, &d, &state);
        }
        assert_eq!(flags.list().len(), 1, "precondition: flagged");

        // Somebody rebased it. Same PR, same branch — only the merge state (and, in reality, the
        // head oid) moved.
        let fixed = PrFacts {
            merge_state: "clean".into(),
            is_dirty: false,
            head_oid: "deadbeefcafe".into(),
            ..conflicting_facts()
        };
        let d = conflict_ladder::step(&mut state, &observation(&fixed, None));
        assert!(d.changed, "precondition: the identity moved");
        let raised = apply_flags(&flags, &fixed, None, &d, &state);

        assert!(raised.is_none());
        assert!(
            flags.list().is_empty(),
            "a resolved conflict must not leave a row behind — a channel that reports fixed \
             problems stops being read"
        );
    }

    /// A flag ROW is refreshed every flagging look (so its age stays honest) but an EVENT fires
    /// only when the target actually rises. Both counts are pinned exactly.
    #[test]
    fn the_row_refreshes_every_look_but_only_three_events_ever_fire() {
        let flags = ConflictFlags::default();
        let facts = conflicting_facts();
        let obs = observation(&facts, None);
        let mut state = PrState::default();

        let mut events = 0usize;
        let mut ages: Vec<u64> = Vec::new();
        for _ in 0..30 {
            let d = conflict_ladder::step(&mut state, &obs);
            if apply_flags(&flags, &facts, None, &d, &state).is_some() {
                events += 1;
            }
            if let Some(row) = flags.list().first() {
                ages.push(row.unresolved_secs);
            }
        }

        assert_eq!(events, 3, "agent, concierge, founder — and nothing else, however long it sits");
        assert_eq!(flags.list().len(), 1, "still one row");
        assert_eq!(flags.list()[0].target, "founder");
        // The row's age must be the LATEST, not frozen at the last escalation — the whole reason
        // the row is rewritten rather than only raised.
        assert_eq!(flags.list()[0].unresolved_secs, state.unresolved_secs());
        assert!(
            ages.windows(2).all(|w| w[1] >= w[0]) && ages.last() > ages.first(),
            "the reported age must climb, not stick: {ages:?}"
        );
    }

    /// A merged or closed PR's row must go — but ONLY on a sweep we could actually read.
    #[test]
    fn a_closed_prs_flag_is_swept_but_only_against_a_readable_sweep() {
        let flags = ConflictFlags::default();
        for pr in [10u64, 11] {
            let facts = PrFacts { number: pr, ..conflicting_facts() };
            let obs = observation(&facts, None);
            let mut state = PrState::default();
            for _ in 0..3 {
                let d = conflict_ladder::step(&mut state, &obs);
                apply_flags(&flags, &facts, None, &d, &state);
            }
        }
        assert_eq!(flags.list().len(), 2, "precondition: both flagged");

        sweep_closed_flags(&flags, &HashSet::from([10u64]));
        let remaining: Vec<u64> = flags.list().into_iter().map(|f| f.pr).collect();
        assert_eq!(remaining, vec![10], "the closed PR's row goes; the open one stays");
    }

    // ══ DISCOVERY ═══════════════════════════════════════════════════════════════════════════════

    /// Repos are found through the worktrees Sparkle itself created, so this thread depends on
    /// nothing the (possibly wedged) WebView publishes.
    #[test]
    fn repos_are_discovered_from_the_worktree_layout_and_husks_are_skipped() {
        let d = tempfile::tempdir().unwrap();
        let base = d.path().join("worktrees");
        // A live worktree: `.git` is a FILE in a linked worktree.
        std::fs::create_dir_all(base.join("proj-a").join("agent-1")).unwrap();
        std::fs::write(base.join("proj-a").join("agent-1").join(".git"), "gitdir: ...").unwrap();
        // A husk `git worktree prune` has already disowned — no `.git` left.
        std::fs::create_dir_all(base.join("proj-b").join("agent-2")).unwrap();

        let repos = discover_repos(d.path());
        assert_eq!(repos.len(), 1, "the husk must not be probed: {repos:?}");
        assert_eq!(repos[0].project_id, "proj-a");
        assert_eq!(repos[0].dirs, vec![base.join("proj-a").join("agent-1")]);
    }

    /// ONE BROKEN WORKTREE MUST NOT BLIND A PROJECT (roborev 57873).
    ///
    /// The first sorted directory can be individually broken — a `.git` pointing at a pruned
    /// gitdir, a checkout `gh` cannot resolve a remote from. Taking only that one made the whole
    /// project read as unreadable forever: every tracked PR climbs to the founder over an
    /// environment fault, and no new PR is ever discovered.
    #[test]
    fn a_broken_first_worktree_falls_through_to_the_next() {
        let repo = Repo {
            project_id: "proj-a".into(),
            dirs: vec!["/a/broken".into(), "/a/works".into()],
        };
        let mut asked: Vec<String> = Vec::new();
        let got = probe_repo(&repo, |dir| {
            asked.push(dir.to_string_lossy().to_string());
            if dir.ends_with("broken") {
                Err("gh-failed")
            } else {
                Ok(Probed { prs: vec![conflicting_facts()], saturated: false })
            }
        });
        let (dir, probed) = got.expect("the second worktree answered");
        assert_eq!(dir, PathBuf::from("/a/works"), "and the caller learns WHICH one answered");
        assert_eq!(probed.prs.len(), 1);
        assert_eq!(asked, vec!["/a/broken", "/a/works"], "in sorted order, first-answer-wins");

        // Only a probe that fails EVERYWHERE declares the project unreadable — and it reports the
        // last real reason, not a generic one.
        assert_eq!(probe_repo(&repo, |_| Err("gh-unavailable")), Err("gh-unavailable"));
    }

    // ══ THE PRUNE ═══════════════════════════════════════════════════════════════════════════════

    /// A PROJECT WE DID NOT PROBE KEEPS EVERYTHING (roborev 57873).
    ///
    /// A project whose worktrees are all removed — routine once its agents finish — drops out of
    /// `discover_repos` entirely. Keying the prune on a global "everything discovered was readable"
    /// flag therefore silently deleted that project's ladder state AND its raised flags, treating a
    /// worktree cleanup as evidence its PRs had merged. It is the same fail-open the unreadable-`gh`
    /// path exists to prevent, entered through a door that path does not cover.
    #[test]
    fn a_project_that_vanishes_between_sweeps_keeps_its_tracked_prs() {
        let mut tracked: HashMap<u64, Tracked> = HashMap::new();
        for (pr, project) in [(1u64, "alive"), (2, "alive"), (3, "vanished")] {
            tracked.insert(
                pr,
                Tracked {
                    state: PrState::default(),
                    due_at_ms: 0,
                    project_id: project.into(),
                    facts: PrFacts { number: pr, ..conflicting_facts() },
                },
            );
        }

        // This sweep probed only `alive`, which still lists #1. `vanished` was never discovered.
        prune_tracked(
            &mut tracked,
            &HashSet::from(["alive".to_string()]),
            &HashSet::from([1u64]),
            &HashSet::new(),
        );

        let mut left: Vec<u64> = tracked.keys().copied().collect();
        left.sort();
        assert_eq!(
            left,
            vec![1, 3],
            "#2 really is gone from a repo we READ; #3's project was never probed, so we know \
             nothing about it and must not delete it"
        );
    }

    // ══ LIST SATURATION (bead sparkle-qogah) ════════════════════════════════════════════════════
    //
    // "We should never hide a row that needs action from me." This is the ONE probe in the app that
    // lists every author's open PRs, so it is the likeliest to fill its window — and a conflicting
    // PR is untestable until someone rebases it, which makes it work the founder owes.

    /// A `gh pr list` reply carrying `n` open PRs, each DIRTY, numbered from `first`.
    fn dirty_rows(first: u64, n: u64) -> String {
        let rows: Vec<String> = (first..first + n)
            .map(|i| {
                format!(
                    r#"{{"number":{i},"title":"t","headRefName":"b{i}","headRefOid":"aaaaaaa{i}",
                        "baseRefOid":"bbbbbbb{i}","mergeStateStatus":"DIRTY","url":"u{i}"}}"#
                )
            })
            .collect();
        format!("[{}]", rows.join(","))
    }

    /// A read that FILLS its window is not an authoritative list, and the caller has to be able to
    /// tell. Asserts the value `probe_open_prs`'s caller receives, not an internal boolean.
    #[test]
    fn a_full_window_is_reported_saturated_and_a_short_one_authoritative() {
        // Exactly at the cap: ambiguous by construction — either that is every open PR, or more
        // fell off the end unannounced. It must resolve to NOT-AUTHORITATIVE.
        let full = probe_from_stdout(&dirty_rows(1, 4), 4).expect("decodes");
        assert_eq!(full.prs.len(), 4, "the rows still come through");
        assert!(full.saturated, "a full window cannot be presented as the whole truth");

        // One short of the cap proves pagination ended: the list IS complete, and hedging it would
        // make every ordinary sweep claim it might be missing something.
        let short = probe_from_stdout(&dirty_rows(1, 3), 4).expect("decodes");
        assert!(!short.saturated);

        // Over the cap is saturated too — a ceiling is a ceiling, so this must not slip through an
        // equality check.
        assert!(probe_from_stdout(&dirty_rows(1, 5), 4).expect("decodes").saturated);

        // An empty list can never be saturated, so the quiet case gains no hedge.
        let empty = probe_from_stdout("[]", 4).expect("decodes");
        assert!(!empty.saturated && empty.prs.is_empty());

        // And garbage is still UNKNOWN, never a saturated empty list — the null-vs-zero discipline
        // this module opens with is unaffected.
        assert_eq!(probe_from_stdout("not json", 4), None);
    }

    /// Saturation is judged on the RAW rows `gh` sent, before the numberless-row filter. Judging it
    /// after would let ONE malformed row make a truncated page read as complete — the exact
    /// inversion of the failure this guards.
    #[test]
    fn a_dropped_row_does_not_make_a_full_window_look_authoritative() {
        let stdout = r#"[{"title":"no number"},{"number":7,"mergeStateStatus":"DIRTY"}]"#;
        let probed = probe_from_stdout(stdout, 2).expect("decodes");
        assert_eq!(probed.prs.len(), 1, "the numberless row is dropped, as before");
        assert!(
            probed.saturated,
            "gh's cap applied to what it SENT, so a dropped row is still proof the window was full"
        );
    }

    /// THE DEFECT WITH REAL CONSEQUENCES: a saturated list must not be read as evidence that the
    /// PRs it omitted went away.
    ///
    /// `prune_tracked` drops a tracked PR the moment a project it READ fails to list it, and
    /// `tick` then feeds what survived to `sweep_closed_flags` — so a full page silently deleted the
    /// ladder state AND the already-raised conflict flag of every PR past the cap. That is an
    /// actionable row disappearing because a page was full, which is precisely what bead
    /// sparkle-qogah exists to eliminate.
    #[test]
    fn a_saturated_sweep_does_not_forget_the_prs_its_page_could_not_hold() {
        let mut tracked: HashMap<u64, Tracked> = HashMap::new();
        for (pr, project) in [(1u64, "busy"), (2, "busy"), (3, "quiet")] {
            tracked.insert(
                pr,
                Tracked {
                    state: PrState::default(),
                    due_at_ms: 0,
                    project_id: project.into(),
                    facts: PrFacts { number: pr, ..conflicting_facts() },
                },
            );
        }

        // Both projects were READ. `busy` filled its window and listed only #1 — #2 fell off the end.
        // `quiet` answered completely and no longer lists #3, which really did close.
        prune_tracked(
            &mut tracked,
            &HashSet::from(["busy".to_string(), "quiet".to_string()]),
            &HashSet::from([1u64]),
            &HashSet::from(["busy".to_string()]),
        );

        let mut left: Vec<u64> = tracked.keys().copied().collect();
        left.sort();
        assert_eq!(
            left,
            vec![1, 2],
            "#2 is missing only because the page was FULL, which is no more a merge than 'we could \
             not look'; #3 is genuinely absent from a complete list and correctly forgotten"
        );
    }

    /// RETAINING IS NOT ENOUGH — a retained PR nobody looks at is a PR that never escalates again.
    ///
    /// The tail of a saturated list is absent from `seen`, so without this it would keep its state
    /// and simply stop being examined: no rung, no flag, no nudge. For a conflicting PR the founder
    /// owes a rebase, "tracked but never looked at again" and "hidden" are the same thing to him.
    #[test]
    fn the_tail_of_a_saturated_list_keeps_climbing_blind() {
        let mut tracked: HashMap<u64, Tracked> = HashMap::new();
        for (pr, project) in [(11u64, "busy"), (12, "busy"), (13, "busy"), (99, "other")] {
            tracked.insert(
                pr,
                Tracked {
                    state: PrState::default(),
                    due_at_ms: 0,
                    project_id: project.into(),
                    facts: PrFacts { number: pr, ..conflicting_facts() },
                },
            );
        }

        // The truncated page mentioned #12 only.
        let fill = saturated_blind_fill(&tracked, "busy", &HashSet::from([12u64]));
        assert_eq!(
            fill,
            vec![11, 13],
            "every tracked PR of the saturated project that the page omitted — sorted, so the \
             looks a sweep produces don't depend on HashMap order"
        );
        assert!(
            !fill.contains(&99),
            "another project's PRs are not this project's problem"
        );

        // A COMPLETE page mentioning everything produces no blind looks at all, so this cannot
        // become a source of permanent unresolvable churn on a healthy repo.
        assert!(saturated_blind_fill(
            &tracked,
            "busy",
            &HashSet::from([11u64, 12, 13])
        )
        .is_empty());
    }

    /// The reason a blind look carries reaches the founder on the row as `blocked_by`, so a
    /// truncated LIST must not present itself as `gh` being down — they call for different actions
    /// (one is "your repo has more PRs than the cap", the other "fix your auth").
    #[test]
    fn a_saturated_blind_look_names_truncation_rather_than_a_broken_gh() {
        let facts = conflicting_facts();
        let (state, decision) = climb(&observation(&facts, Some(SATURATED_REASON)), 3);
        let flag = build_flag(&facts, None, &decision, &state, None);
        assert_eq!(
            flag.blocked_by.as_deref(),
            Some("gh-list-saturated"),
            "'your repo has more PRs than the cap' and 'fix your gh auth' call for different \
             actions, so the row must not conflate them"
        );
        assert_eq!(flag.kind, "conflicting", "the inherited verdict is still on the row");
        assert_eq!(flag.target, "agent", "and it still reaches somebody");
    }

    /// The cap is now read from one constant on the argv, so a future edit cannot move the query's
    /// limit without moving the number saturation is detected at. A literal in the argv is exactly
    /// how the two drifted apart before.
    /// SCANS ONLY THE NON-TEST HALF OF THE FILE, and that is load-bearing rather than tidiness.
    /// The first version of this test read the whole of `include_str!` — including itself — so the
    /// literal it searched for was present *because the assertion quoted it*, and the test failed
    /// against correct source. The positive half was worse: `src.contains("&PROBE_LIMIT…")` is
    /// satisfied by the assertion's own text, so it could never fail no matter what the argv said.
    /// Self-reading source scans are vacuous in one direction and self-defeating in the other;
    /// cutting the test module off leaves a needle that only real code can satisfy.
    #[test]
    fn the_probe_asks_for_exactly_the_limit_saturation_is_judged_against() {
        let whole = include_str!("conflict_watch.rs");
        let code = whole
            .split_once("#[cfg(test)]")
            .expect("the test module marker anchors this scan")
            .0;
        assert!(
            code.contains("&PROBE_LIMIT.to_string(),"),
            "the --limit argument must be PROBE_LIMIT itself, not a literal beside it"
        );
        // Any bare numeric literal on the argv is the drift this guards: the query's ceiling and the
        // number saturation is judged against must be ONE constant, or a future edit moves one and
        // silently truncates without disclosing it.
        let limit_arg_is_literal = code
            .split(r#""--limit","#)
            .skip(1)
            .any(|rest| rest.trim_start().starts_with('"'));
        assert!(
            !limit_arg_is_literal,
            "a hard-coded number is back on the argv beside --limit"
        );
    }

    // ══ THE COLD START ══════════════════════════════════════════════════════════════════════════

    /// AN EMPTY FLAG LIST MUST BE DISTINGUISHABLE FROM "WE COULD NOT LOOK" (roborev 57873).
    ///
    /// The per-PR fail-closed path only keeps ALREADY-TRACKED PRs climbing. A `gh` that is absent
    /// or unauthenticated from process start means nothing is ever tracked, so no blind look is
    /// ever produced and `conflict_flags` returns `[]` forever — which a consumer reads as "no
    /// conflicts", the one thing this module's header says it must never say. A `tracing::warn!` is
    /// not the channel.
    #[test]
    fn a_cold_start_against_an_unreadable_gh_is_visible_not_silent() {
        // Before anything has run at all, an empty list means nothing whatsoever. (The status is
        // process-wide, like the thread that writes it, so this test owns it and resets it first.)
        *probe_status().lock().unwrap() = ProbeStatus::default();
        assert!(!conflict_probe_status().ever_probed);

        // A sweep that found one repo and could not read it.
        record_probe(1, 1, Some("gh-unavailable"), 111);
        let st = conflict_probe_status();
        assert!(st.ever_probed);
        assert_eq!(st.unreadable, 1, "the empty flag list is INCOMPLETE, and says so");
        assert_eq!(st.last_error.as_deref(), Some("gh-unavailable"));
        assert_eq!(st.last_full_read_ms, 0, "nothing was ever fully read");

        // ...and a clean sweep clears it, so one outage does not mute the signal forever.
        record_probe(1, 0, None, 222);
        let st = conflict_probe_status();
        assert_eq!(st.unreadable, 0);
        assert_eq!(st.last_error, None);
        assert_eq!(st.last_full_read_ms, 222, "an empty list NOW genuinely means no conflicts");
    }

    #[test]
    fn no_worktrees_at_all_is_an_empty_list_not_a_panic() {
        let d = tempfile::tempdir().unwrap();
        assert!(discover_repos(d.path()).is_empty());
    }

    // ══ STRUCTURAL GUARDS ═══════════════════════════════════════════════════════════════════════

    /// A Finder/Dock-launched app doesn't inherit the login-shell PATH, so spawning `gh` by its
    /// bare name can't find a homebrew install — and because this caller SWALLOWS the failure into
    /// a fail-closed refusal, the miss would read as "we can never read any PR" forever. Mirrors
    /// `worktree.rs`'s guard of the same name, which exists because that gap was introduced twice.
    #[test]
    fn conflict_watch_spawns_gh_through_gh_program() {
        let needle = format!("Command::new(\"{}\")", "gh"); // built at runtime so this can't match itself
        let src = include_str!("conflict_watch.rs");
        assert!(
            !src.contains(&needle),
            "spawn gh via crate::preflight::gh_program(), not the bare name"
        );
    }

    /// A decoded row carries NO project, and the stamp is what supplies it.
    ///
    /// Both halves are asserted together on purpose: "the decoder leaves it empty" is the
    /// precondition, and a test of it alone would pass against a build where the stamp does
    /// nothing. The pair pins the actual effect — after stamping, every row names the repo.
    #[test]
    fn stamping_a_read_attributes_every_row_to_its_project() {
        let raw = decode_open_prs(
            r#"[{"number":12,"headRefName":"a","mergeStateStatus":"DIRTY"},
                {"number":13,"headRefName":"b","mergeStateStatus":"CLEAN"}]"#,
        )
        .expect("decodes");
        assert!(
            raw.iter().all(|f| f.project_id.is_empty()),
            "a gh row cannot know its repo; anything else means the decoder is guessing"
        );

        let stamped = stamp_project(raw, "project-beta");
        assert_eq!(stamped.len(), 2, "stamping drops nothing");
        assert!(stamped.iter().all(|f| f.project_id == "project-beta"));
        // The rest of the row is untouched — the stamp attributes, it does not rewrite.
        assert_eq!(stamped[0].number, 12);
        assert_eq!(stamped[1].branch, "b");
    }

    /// The row a consumer receives names the repo, so `#12` is verifiable against ONE project
    /// instead of being asked of every open repo (bead `sparkle-f0brd`).
    #[test]
    fn the_flag_carries_the_project_its_pr_was_read_from() {
        let flags = ConflictFlags::default();
        let facts = PrFacts { project_id: "project-gamma".into(), ..conflicting_facts() };
        let (state, decision) = climb(&observation(&facts, None), 3);
        assert!(apply_flags(&flags, &facts, None, &decision, &state).is_some(), "a flag stands");

        let rows = flags.list();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].project_id, "project-gamma",
            "a flag whose repo is unstated sends the consumer asking every project"
        );
        assert_eq!(rows[0].pr, facts.number, "and it is still the same PR");
    }

    /// The flag is a FROZEN contract with its consumer, and it crosses the boundary as camelCase
    /// JSON. A rename on this side is invisible in Rust and silently blanks a field over there.
    #[test]
    fn the_flag_serializes_with_the_contract_field_names() {
        let facts = conflicting_facts();
        let (state, decision) = climb(&observation(&facts, None), 3);
        let json = serde_json::to_value(build_flag(
            &facts,
            Some("agent-7".into()),
            &decision,
            &state,
            None,
        ))
        .unwrap();
        for key in [
            "pr",
            "projectId",
            "branch",
            "ownerAgentId",
            "kind",
            "commitsBehind",
            "untested",
            "evidence",
            "target",
            "raisedAtMs",
            "rung",
            "unresolvedSecs",
            "blockedBy",
        ] {
            assert!(json.get(key).is_some(), "the contract field {key} is missing from {json}");
        }
        assert_eq!(json["ownerAgentId"], "agent-7");
        assert_eq!(json["untested"], true);
        assert_eq!(json["evidence"], "no-checks-ran");
        // Pin the COMPLETE value set the contract documents, exhaustively over THE FOUR FIELDS
        // `untested_evidence` reads today — not over all of `Observation` (roborev 57937, 57946).
        //
        // The version before this was captioned "so a fifth value cannot ship undocumented again"
        // and could not detect that: it asserted five inputs mapped to five strings, so a sixth arm
        // shipped with every assertion green — which is how `"last-known"` arrived. Sweeping all 16
        // combinations of the four booleans closes that for arms keyed on THOSE fields.
        //
        // It does NOT close the next one along: an arm reading `is_draft`, or any field added
        // later, still ships green because those are pinned at `base`. Rather than overstate the
        // caption again — this file's history is assertions believed to close a hole they did not
        // reach — the destructure below makes field growth a COMPILE error, so whoever adds a field
        // is forced here to decide whether the sweep must widen.
        let base = observation(&conflicting_facts(), None);
        {
            let Observation {
                hash: _,
                is_dirty: _,
                commits_behind: _,
                has_ci: _,
                is_draft: _,
                carried: _,
                refusal: _,
            } = base.clone();
            // Adding a field breaks this destructure. If `untested_evidence` reads it, widen the
            // sweep below to 2^n; if it does not, add it here with a `_` and say so.
        }
        let mut seen: Vec<String> = (0..16)
            .map(|bits| {
                conflict_ladder::untested_evidence(&Observation {
                    refusal: (bits & 1 != 0).then_some("gh-failed"),
                    carried: bits & 2 != 0,
                    is_dirty: bits & 4 != 0,
                    has_ci: bits & 8 != 0,
                    ..base.clone()
                })
                .to_string()
            })
            .collect();
        seen.sort();
        seen.dedup();
        assert_eq!(
            seen,
            vec![
                "checks-are-stale",
                "last-known",
                "last-known-unconfirmed",
                "n/a",
                "no-checks-ran",
                "unknown",
            ],
            "every value `evidence` can take must be one the field's own doc enumerates"
        );
    }
}
