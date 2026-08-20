//! Durable PR → agent ownership, so every pull request can be resolved back to the agent that
//! opened it — REGARDLESS of what its branch is called.
//!
//! WHY THIS EXISTS. The concierge is required to name a PR's owning agent as a clickable pill
//! rather than cite a bare `#806`; the user runs dozens of agents at once and a number identifies
//! nothing. That resolution used to be done by PARSING THE BRANCH NAME — `sparkle/agent-<id>` —
//! which fails for exactly the PRs most worth clicking into. `sparkle/left-pair` (#806),
//! `sparkle/router-skip-doomed-classify` (#802) and `sparkle/ignore-agent-scratch-worktrees` (#779)
//! carry no id anywhere, so the concierge could only say "owner unresolved".
//!
//! Branch-name parsing is the wrong foundation even where it works: it punishes descriptive branch
//! names (which make better git history and should be ENCOURAGED), it breaks on rename, and it
//! cannot express a PR an agent authored onto someone else's branch. The association is a FACT to
//! be RECORDED at the moment it is created, not a string to be re-derived later.
//!
//! WHAT IS RECORDED, and in what order it is trusted:
//!
//!   1. **`created`** — [`record_pr_created`], written by `open_agent_pr` the instant `gh pr create`
//!      returns a URL. First-hand knowledge; nothing overwrites it.
//!   2. **`pr-body`** — a machine-readable marker ([`pr_body_marker`]) embedded in the PR body at
//!      creation. This is the only channel that survives a lost store, a reinstall, or another
//!      MACHINE looking at the same PR — GitHub holds it, not us.
//!   3. **`worktree-branch`** — [`observe_branch`], written whenever the app sees an agent's
//!      worktree checked out on a branch. This is what rescues a PR an agent opened by running
//!      `gh pr create` in its own shell, which never passes through `open_agent_pr` at all.
//!   4. **`branch-name`** — the legacy `sparkle/agent-<id>` convention. Still honoured (the app
//!      MINTS those names, so the id in them is recorded-by-construction, not a guess), and used
//!      to BACKFILL the store once for PRs that predate everything above.
//!
//! NULL STAYS HONEST. Every path here returns `None` rather than a best guess. A pill carrying the
//! WRONG agent id opens the wrong agent — strictly worse than no pill, because the user cannot
//! tell the difference until they have lost their place. Two consequences fall out of that rule:
//! a branch seen under two different agents is marked [`BranchOwner::ambiguous`] and stops
//! resolving entirely, and a body marker whose `project` disagrees with the project being asked
//! about is discarded rather than trusted across projects.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// The branch prefix this app mints for an agent's own branch. Parsing it is the LAST resort in
/// [`resolve_owner`], kept only because it is the one signal that exists for PRs opened before the
/// store did.
pub const AGENT_BRANCH_PREFIX: &str = "sparkle/agent-";

/// How an ownership answer was arrived at, surfaced alongside every answer so a caller (and the
/// concierge) can say how confident the mapping is instead of implying they are all equal.
pub const SOURCE_CREATED: &str = "created";
pub const SOURCE_PR_BODY: &str = "pr-body";
pub const SOURCE_WORKTREE_BRANCH: &str = "worktree-branch";
pub const SOURCE_BRANCH_NAME: &str = "branch-name";

/// Trust ranking of the sources above. A stronger source may UPGRADE a weaker stored record; a
/// weaker one never downgrades a stronger one. Without this, a routine list-and-backfill pass
/// could overwrite the first-hand `created` fact with a branch-name inference the moment someone
/// renamed a branch.
fn source_rank(source: &str) -> u8 {
    match source {
        SOURCE_CREATED => 4,
        SOURCE_PR_BODY => 3,
        SOURCE_WORKTREE_BRANCH => 2,
        SOURCE_BRANCH_NAME => 1,
        _ => 0,
    }
}

// ── persisted shape ─────────────────────────────────────────────────────────────────────────

/// One PR's recorded owner.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PrOwner {
    pub agent_id: String,
    /// The head branch as it was at record time. Informational — deliberately NOT what resolution
    /// keys on, since the whole point is to survive a rename.
    pub branch: String,
    /// One of the `SOURCE_*` constants.
    pub source: String,
    /// Epoch seconds.
    pub recorded_at: i64,
}

/// One branch's observed owning agent.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct BranchOwner {
    pub agent_id: String,
    /// Two DIFFERENT agents have been seen checked out on this branch, so it can no longer identify
    /// one. Sticky on purpose: an ambiguous branch resolves to nothing forever rather than to
    /// whichever agent was observed most recently. A branch legitimately handed from one agent to
    /// another is thereby lost as a signal — the honest outcome, since the PR could belong to either.
    pub ambiguous: bool,
    pub recorded_at: i64,
}

/// The whole durable mapping. Nested by project id rather than flattened under a composite key so
/// the file stays readable by a human debugging a mis-pointed pill, and so no separator character
/// can be smuggled in through an id.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(default)]
pub struct PrOwnerStore {
    /// projectId → PR number (as a string, since JSON object keys are strings) → owner.
    pub prs: BTreeMap<String, BTreeMap<String, PrOwner>>,
    /// projectId → branch → owner.
    pub branches: BTreeMap<String, BTreeMap<String, BranchOwner>>,
}

/// An answer, with its provenance attached.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedOwner {
    pub agent_id: String,
    pub source: String,
}

// ── pure helpers ────────────────────────────────────────────────────────────────────────────

/// Epoch seconds, or 0 if the clock is before the epoch (which nothing here depends on).
fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Agent ids as this app mints them: the same `[A-Za-z0-9_-]{1,128}` shape `worktree::validate_id`
/// enforces before an id is ever joined onto a path. Applied to anything read back out of a branch
/// name or a PR body so a hand-edited body can't inject a value that later reaches a path or a git
/// argument.
fn is_agent_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The agent id embedded in a legacy `sparkle/agent-<id>` branch name, or `None`.
///
/// This is a CONVENTION the app itself minted, not an inference about an arbitrary branch — but it
/// is still the weakest source, because a human can create such a branch by hand and a rename
/// destroys it. Anything that isn't exactly the prefix followed by a well-formed id yields `None`.
pub fn agent_id_from_branch(branch: &str) -> Option<String> {
    let rest = branch.trim().strip_prefix(AGENT_BRANCH_PREFIX)?;
    is_agent_id(rest).then(|| rest.to_string())
}

/// The marker appended to a PR body at creation — the copy of the mapping that lives on GitHub
/// rather than on this machine.
///
/// An HTML comment so it is invisible in the rendered PR, and a fixed `key=value` shape so parsing
/// needs no regex engine. Kept on ONE line: the parser reads to end-of-line, so a multi-line marker
/// would silently truncate.
pub fn pr_body_marker(agent_id: &str, project_id: &str) -> String {
    format!("<!-- sparkle:pr-owner agent={agent_id} project={project_id} -->")
}

/// `(agent_id, project_id)` from the first well-formed [`pr_body_marker`] in `body`.
///
/// Tolerant of what GitHub does to a body in transit (CRLF, surrounding prose, a body that has been
/// edited and the marker moved) but strict about the payload: both ids must satisfy [`is_agent_id`],
/// so a malformed or truncated marker reads as absent rather than as a bogus owner.
pub fn parse_pr_body_marker(body: &str) -> Option<(String, String)> {
    const OPEN: &str = "<!-- sparkle:pr-owner ";
    let mut rest = body;
    while let Some(at) = rest.find(OPEN) {
        let after = &rest[at + OPEN.len()..];
        // Bound the scan to this line AND to the comment's own terminator, so a marker whose `-->`
        // is missing can't swallow the rest of the body as its field list.
        let line_end = after.find('\n').unwrap_or(after.len());
        let close = after.find("-->").unwrap_or(after.len());
        let fields = &after[..line_end.min(close)];
        let mut agent = None;
        let mut project = None;
        for tok in fields.split_whitespace() {
            if let Some(v) = tok.strip_prefix("agent=") {
                agent = Some(v);
            } else if let Some(v) = tok.strip_prefix("project=") {
                project = Some(v);
            }
        }
        if let (Some(a), Some(p)) = (agent, project) {
            if is_agent_id(a) && is_agent_id(p) {
                return Some((a.to_string(), p.to_string()));
            }
        }
        rest = &rest[at + OPEN.len()..];
    }
    None
}

/// The PR number in a `gh pr create` URL (`https://github.com/owner/repo/pull/806`).
///
/// `gh` prints the URL and nothing else on success, but it is still parsed defensively: a build
/// that starts printing a banner, or an enterprise host with a path prefix, must degrade to "we
/// couldn't record it" rather than to a WRONG number — a mis-numbered record is precisely the
/// wrong-pill failure this module exists to prevent. Takes the segment after the LAST `/pull/`
/// so a repo named `pull` in the path can't win.
pub fn pr_number_from_url(url: &str) -> Option<u64> {
    let after = url.trim().rsplit_once("/pull/")?.1;
    let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u64>().ok().filter(|n| *n > 0)
}

// ── pure store operations ───────────────────────────────────────────────────────────────────

/// Look a PR's owner up, newest-and-strongest signal first. Returns `None` — never a guess — when
/// nothing identifies the agent.
///
/// `body` may be empty when the caller didn't fetch it; that simply skips the marker step rather
/// than changing the answer's meaning.
pub fn resolve_owner(
    store: &PrOwnerStore,
    project_id: &str,
    number: u64,
    head_ref: &str,
    body: &str,
) -> Option<ResolvedOwner> {
    // 1. Recorded against the PR itself.
    if let Some(rec) = store.prs.get(project_id).and_then(|m| m.get(&number.to_string())) {
        if is_agent_id(&rec.agent_id) {
            return Some(ResolvedOwner { agent_id: rec.agent_id.clone(), source: rec.source.clone() });
        }
    }
    // 2. The marker GitHub is holding for us. Cross-project markers are DISCARDED rather than
    //    trusted: the caller asked "who owns this PR in project X", and an agent id from some other
    //    project would resolve to an agent the user cannot open from here.
    if let Some((agent, proj)) = parse_pr_body_marker(body) {
        if proj == project_id {
            return Some(ResolvedOwner { agent_id: agent, source: SOURCE_PR_BODY.into() });
        }
    }
    // 3. A branch we have watched an agent's worktree sit on.
    if let Some(rec) = store.branches.get(project_id).and_then(|m| m.get(head_ref)) {
        if !rec.ambiguous && is_agent_id(&rec.agent_id) {
            return Some(ResolvedOwner {
                agent_id: rec.agent_id.clone(),
                source: SOURCE_WORKTREE_BRANCH.into(),
            });
        }
    }
    // 4. The legacy convention.
    agent_id_from_branch(head_ref)
        .map(|agent_id| ResolvedOwner { agent_id, source: SOURCE_BRANCH_NAME.into() })
}

/// Upsert a PR→agent record. Returns whether the store actually CHANGED, so callers on hot paths
/// can skip the write (see [`observe_branch`]).
///
/// A record is only replaced by one of equal-or-greater [`source_rank`]. That is what stops a
/// periodic list-and-backfill from demoting the first-hand `created` fact to a branch-name
/// inference after someone renames a branch.
pub fn record_pr(
    store: &mut PrOwnerStore,
    project_id: &str,
    number: u64,
    agent_id: &str,
    branch: &str,
    source: &str,
    now: i64,
) -> bool {
    if !is_agent_id(agent_id) || !is_agent_id(project_id) {
        return false;
    }
    let key = number.to_string();
    let slot = store.prs.entry(project_id.to_string()).or_default();
    if let Some(existing) = slot.get(&key) {
        if source_rank(&existing.source) > source_rank(source) {
            return false;
        }
        if existing.agent_id == agent_id && existing.source == source && existing.branch == branch {
            return false;
        }
    }
    slot.insert(
        key,
        PrOwner {
            agent_id: agent_id.to_string(),
            branch: branch.to_string(),
            source: source.to_string(),
            recorded_at: now,
        },
    );
    true
}

/// Note that `agent_id`'s worktree was seen checked out on `branch`. Returns whether the store
/// changed.
///
/// Re-observing the SAME agent on the same branch is a no-op (not even a timestamp refresh) —
/// this runs on the per-agent status poll, and rewriting the file every tick would be pure churn.
/// Observing a DIFFERENT agent latches [`BranchOwner::ambiguous`], after which the branch never
/// resolves again.
pub fn record_branch(
    store: &mut PrOwnerStore,
    project_id: &str,
    branch: &str,
    agent_id: &str,
    now: i64,
) -> bool {
    if !is_agent_id(agent_id) || !is_agent_id(project_id) || branch.trim().is_empty() {
        return false;
    }
    let slot = store.branches.entry(project_id.to_string()).or_default();
    match slot.get_mut(branch) {
        Some(existing) if existing.ambiguous => false,
        Some(existing) if existing.agent_id == agent_id => false,
        Some(existing) => {
            existing.ambiguous = true;
            existing.recorded_at = now;
            true
        }
        None => {
            slot.insert(
                branch.to_string(),
                BranchOwner { agent_id: agent_id.to_string(), ambiguous: false, recorded_at: now },
            );
            true
        }
    }
}

// ── file-backed store ───────────────────────────────────────────────────────────────────────

/// `<app_data>/pr-owners.json`.
pub fn store_path(app_data: &Path) -> PathBuf {
    app_data.join("pr-owners.json")
}

/// Serializes every read-modify-write. Re-reading before writing narrows the race but does not
/// close it: the status poll (many agents, concurrently) and a PR-creation both read-modify-write
/// this file, and a lost update here means a PR silently has no owner. Process-wide, like
/// `builder_index`'s — there is one app-data dir per process and the lock is held for two syscalls.
fn store_lock() -> &'static Mutex<()> {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Read the store. A missing, unreadable or corrupt file degrades to EMPTY, which is the fail-safe
/// direction here: we lose mappings (every PR reads as "owner unknown", the honest answer) rather
/// than serving stale or half-parsed ones.
pub fn load_store(app_data: &Path) -> PrOwnerStore {
    std::fs::read_to_string(store_path(app_data))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_store(app_data: &Path, store: &PrOwnerStore) -> Result<(), String> {
    std::fs::create_dir_all(app_data).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(store_path(app_data), text).map_err(|e| e.to_string())
}

/// Record a PR the app just opened. Best-effort: a failed write costs a resolvable owner, never the
/// PR, so it is logged by the caller rather than propagated.
pub fn record_pr_created(
    app_data: &Path,
    project_id: &str,
    number: u64,
    agent_id: &str,
    branch: &str,
) -> Result<(), String> {
    let _g = store_lock().lock().map_err(|e| e.to_string())?;
    let mut store = load_store(app_data);
    if record_pr(&mut store, project_id, number, agent_id, branch, SOURCE_CREATED, now_secs()) {
        save_store(app_data, &store)?;
    }
    Ok(())
}

/// Note an agent's worktree sitting on `branch`. Writes only when something changed.
pub fn observe_branch(
    app_data: &Path,
    project_id: &str,
    branch: &str,
    agent_id: &str,
) -> Result<(), String> {
    let _ = claim_then_observe(app_data, project_id, branch, agent_id);
    Ok(())
}

/// What the branch→agent table says about a branch, BEFORE this poll's own observation is folded
/// in. Three-valued, and the middle value is the only one that is evidence of anything.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BranchClaim {
    /// A pre-existing, unambiguous row naming THIS agent.
    Mine,
    /// A pre-existing, unambiguous row naming a DIFFERENT agent. The only positive evidence that a
    /// branch is somebody else's, and the only thing a caller may refuse on.
    Other,
    /// No row at all, or the store could not be read. "We do not know" — never to be treated as
    /// `Other`. An `ambiguous` row is NOT unknown: it still names its first owner. See
    /// [`claim_then_observe`].
    Unknown,
}

/// Answer "whose branch is this?" from what the table ALREADY held, then fold in this poll's own
/// observation. The ORDER is the whole point.
///
/// WHY READ FIRST (bead `sparkle-pgkbn4`, roborev 65176). The obvious shape — record, then read
/// back — is circular: `record_branch` inserts on a first sighting, so reading afterwards returns
/// the row this very call just wrote and every unseen branch resolves to `Mine` on the first poll.
/// That is not evidence, it is an echo. Reading first makes a first sighting honestly `Unknown`,
/// and reserves a verdict for a mapping some EARLIER poll established.
///
/// WHY THE ROW'S NAME BEATS ITS `ambiguous` FLAG. The latch is permanent and has no repair path, and
/// it was designed for PR ownership, where an unknown owner renders as a MISSING PILL. On the status
/// path an unknown renders as a confidently wrong stage — an agent whose minted ref is the empty one
/// left by a `checkout -b` rename goes straight back to `branch_ever_committed → Some(false)` →
/// `building_unsaved` → "Local: Nothing Yet", on committed, shipped work. But treating the latch as
/// `Unknown` is the opposite mistake, and it erases the only refusal this design has. `agent_id`
/// SURVIVES the latch, so reading the NAME serves both sides: first owner `Mine`, everyone else
/// `Other`.
///
/// `Unknown` is therefore only ever "there is no row at all" or "we could not read the store", and
/// it ADOPTS, because the two error directions are not symmetric: adopting the wrong branch shows
/// numbers that are wrong, but the row now NAMES the branch they were measured on, so a human can
/// see it; refusing the right one shows "nothing here", which looks exactly like an agent that never
/// started. Prefer the diagnosable failure.
///
/// The observation is best-effort: a persist failure costs a future resolvable owner, never this
/// reading — the answer was already computed from the loaded store before any write was attempted.
pub fn claim_then_observe(
    app_data: &Path,
    project_id: &str,
    branch: &str,
    agent_id: &str,
) -> BranchClaim {
    // A poisoned lock is a CAN'T-READ, so it answers `Unknown`. Mapping it to `Other` would turn a
    // process-permanent lock failure into a fleet-wide "Nothing Yet" that has nothing to do with
    // ownership.
    let Ok(_g) = store_lock().lock() else {
        tracing::warn!(%branch, %agent_id, "branch ownership lock poisoned; claim unknown");
        return BranchClaim::Unknown;
    };
    let mut store = load_store(app_data);
    // READ THE NAME, NOT THE LATCH. `record_branch` never rewrites `agent_id` once it sets
    // `ambiguous`, so an ambiguous row still records WHO WAS THERE FIRST — and that one field
    // answers both sides at once:
    //   * the original owner keeps `Mine`, so a branch something else touched once does not strand
    //     the agent whose work it is at "Local: Nothing Yet";
    //   * the intruder keeps `Other`, DURABLY.
    // Collapsing `ambiguous` to `Unknown` (as this did for one commit) made the single refusal
    // SELF-ERASING: the very call that returned `Other` also latched the row, so the next poll read
    // `Unknown`, adopted, and thirty seconds later a never-started agent was reporting another
    // branch's ahead/behind and uncommitted files as its own — permanently, since the latch never
    // clears (roborev 65183). A guard that works for exactly one tick is not a guard.
    let claim = match store.branches.get(project_id).and_then(|m| m.get(branch)) {
        Some(o) if o.agent_id == agent_id => BranchClaim::Mine,
        Some(_) => BranchClaim::Other,
        None => BranchClaim::Unknown,
    };
    if record_branch(&mut store, project_id, branch, agent_id, now_secs()) {
        if let Err(e) = save_store(app_data, &store) {
            tracing::warn!(%branch, %agent_id, error = %e, "could not persist branch ownership");
        }
    }
    claim
}

/// Whether a resolution is a STABLE FACT worth freezing into the PR table, or a LIVE READING that
/// must be re-derived every time.
///
/// `created` and `pr-body` are fixed the moment the PR is opened, and `branch-name` is a pure
/// function of a string — none of them can be contradicted later, so recording them is what makes a
/// legacy PR survive its branch being renamed or deleted.
///
/// `worktree-branch` is the exception, and freezing it was a real defect (roborev 55253). It is an
/// OBSERVATION, and `record_branch` can later latch the branch `ambiguous` when a second agent is
/// seen on it. Once a PR row exists, `resolve_owner`'s step 1 returns it unconditionally — so a
/// backfilled observation would keep naming the first agent forever, silently outliving the very
/// ambiguity check that exists to stop us picking one of two candidates. Left un-frozen, it is
/// re-read from the branch table on every call and stops resolving the instant the branch does.
/// Nothing is lost by not recording it: the branch table is itself durable.
fn is_stable_enough_to_record(source: &str) -> bool {
    source != SOURCE_WORKTREE_BRANCH
}

/// Resolve a batch of PRs and BACKFILL whatever the store didn't already know, in one
/// load/save cycle.
///
/// The backfill is what turns the legacy `sparkle/agent-<uuid>` convention into a durable record:
/// once written, that PR keeps resolving even after its branch is renamed or deleted. Input is
/// `(number, head_ref, body)` per PR; output is aligned index-for-index with it. See
/// [`is_stable_enough_to_record`] for the one source that is deliberately NOT frozen here.
pub fn resolve_and_backfill(
    app_data: &Path,
    project_id: &str,
    prs: &[(u64, String, String)],
) -> Vec<Option<ResolvedOwner>> {
    let guard = store_lock().lock();
    let mut store = load_store(app_data);
    let now = now_secs();
    let mut dirty = false;
    let out: Vec<Option<ResolvedOwner>> = prs
        .iter()
        .map(|(number, head_ref, body)| {
            let found = resolve_owner(&store, project_id, *number, head_ref, body);
            if let Some(r) = &found {
                if is_stable_enough_to_record(&r.source) {
                    dirty |= record_pr(
                        &mut store,
                        project_id,
                        *number,
                        &r.agent_id,
                        head_ref,
                        &r.source,
                        now,
                    );
                }
            }
            found
        })
        .collect();
    if dirty {
        // A failed write only costs the backfill; the answers above are already correct.
        let _ = save_store(app_data, &store);
    }
    drop(guard);
    out
}

/// What [`pr_owner`] hands back. Always a full answer — an unknown owner is `agent_id: None` WITH a
/// `reason`, because "I could not find out" and "it has no agent" must not look the same to a
/// caller deciding whether to render a pill.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrOwnerAnswer {
    pub number: u64,
    pub agent_id: Option<String>,
    /// Which `SOURCE_*` produced the answer; `None` when `agent_id` is `None`.
    pub source: Option<String>,
    /// The head branch the answer was resolved against, when known.
    pub branch: Option<String>,
    /// Why there is no `agent_id`; `None` when there is one.
    pub reason: Option<String>,
}

/// Resolve one PR by number, consulting the store first and falling back to what the store knows
/// about branches. `head_ref`/`body` are supplied by the caller (which owns the `gh` probe), and
/// may be empty when the PR could not be read — in which case only a pre-existing record can answer.
pub fn answer_for(
    app_data: &Path,
    project_id: &str,
    number: u64,
    head_ref: &str,
    body: &str,
) -> PrOwnerAnswer {
    let resolved = resolve_and_backfill(
        app_data,
        project_id,
        &[(number, head_ref.to_string(), body.to_string())],
    )
    .pop()
    .flatten();
    match resolved {
        Some(r) => PrOwnerAnswer {
            number,
            agent_id: Some(r.agent_id),
            source: Some(r.source),
            branch: (!head_ref.is_empty()).then(|| head_ref.to_string()),
            reason: None,
        },
        None => PrOwnerAnswer {
            number,
            agent_id: None,
            source: None,
            branch: (!head_ref.is_empty()).then(|| head_ref.to_string()),
            reason: Some(if head_ref.is_empty() {
                "No ownership record for this PR, and its head branch could not be read. This is \"unknown\", not \"no agent\" — do not guess an owner.".into()
            } else {
                format!(
                    "No ownership record for PR #{number}: it was not opened through Sparkle, its body carries no owner marker, no agent worktree has been seen on `{head_ref}`, and the branch name embeds no agent id. This is \"unknown\", not \"no agent\" — do not guess an owner."
                )
            }),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    /// The TS side re-ranks these sources, and a stale copy there is SILENT — it picks the wrong
    /// owning agent rather than failing.
    ///
    /// `services/fleetPrs.ts` folds two project tabs that are one repository into one section, and
    /// both tabs can answer "who owns #1433". Only the entry an agent lives in holds the
    /// authoritative `created` record; `branch-name` is the one source that ignores the project id
    /// entirely, so EVERY tab produces it. Without the ranking the weak guess wins by arriving
    /// first, and the panel offers a pill that opens the wrong agent — which the reader cannot tell
    /// from a right one. Same discipline as `the_js_side_mirrors_the_same_open_pr_row_cap`: pinned
    /// by a test rather than by a comment, because a comment cannot fail.
    #[test]
    fn the_js_side_mirrors_the_same_owner_source_ranks() {
        let ts = include_str!("../../src/services/fleetPrs.ts");
        for source in [
            SOURCE_CREATED,
            SOURCE_PR_BODY,
            SOURCE_WORKTREE_BRANCH,
            SOURCE_BRANCH_NAME,
        ] {
            let rank = source_rank(source);
            // Both spellings an object literal can use for these keys — `created` is a bare
            // identifier, the hyphenated ones must be quoted.
            let bare = format!("{source}: {rank},");
            let quoted = format!("\"{source}\": {rank},");
            assert!(
                ts.contains(&bare) || ts.contains(&quoted),
                "services/fleetPrs.ts must rank `{source}` at {rank} — its OWNER_SOURCE_RANK has \
                 drifted from source_rank, so folding two tabs on one repo would pick the owner \
                 by arrival order and can name the wrong agent"
            );
        }
    }

    #[test]
    fn agent_id_from_branch_reads_only_the_minted_convention() {
        assert_eq!(
            agent_id_from_branch("sparkle/agent-83cd7718-aa5a-46ca-8227-6732a3a26bc5").as_deref(),
            Some("83cd7718-aa5a-46ca-8227-6732a3a26bc5")
        );
        // The branches this whole module exists for carry nothing to parse.
        assert_eq!(agent_id_from_branch("sparkle/left-pair"), None);
        assert_eq!(agent_id_from_branch("sparkle/router-skip-doomed-classify"), None);
        assert_eq!(agent_id_from_branch("main"), None);
        // A bare prefix, or one followed by something that is not an id shape, is not an answer.
        assert_eq!(agent_id_from_branch("sparkle/agent-"), None);
        assert_eq!(agent_id_from_branch("sparkle/agent-../../etc/passwd"), None);
    }

    #[test]
    fn body_marker_round_trips_and_rejects_malformed_payloads() {
        let m = pr_body_marker("agent-1", "proj-9");
        assert_eq!(parse_pr_body_marker(&m), Some(("agent-1".into(), "proj-9".into())));
        // Surrounded by prose, with CRLF line endings, as GitHub will hand it back.
        let body = format!("Opened by Sparkle.\r\n\r\n{m}\r\n\r\nmore text");
        assert_eq!(parse_pr_body_marker(&body), Some(("agent-1".into(), "proj-9".into())));
        // Missing half the payload, a hand-mangled id, and no marker at all all read as ABSENT —
        // never as a partial owner.
        assert_eq!(parse_pr_body_marker("<!-- sparkle:pr-owner agent=a -->"), None);
        assert_eq!(parse_pr_body_marker("<!-- sparkle:pr-owner agent=a/../b project=p -->"), None);
        assert_eq!(parse_pr_body_marker("no marker here"), None);
        // An unterminated marker must not swallow the following line as its field list.
        assert_eq!(parse_pr_body_marker("<!-- sparkle:pr-owner agent=a\nproject=p -->"), None);
    }

    #[test]
    fn pr_number_from_url_takes_the_last_pull_segment_or_nothing() {
        assert_eq!(pr_number_from_url("https://github.com/o/r/pull/806"), Some(806));
        assert_eq!(pr_number_from_url("https://github.com/o/r/pull/806\n"), Some(806));
        // A repo literally named `pull` must not win over the real segment.
        assert_eq!(pr_number_from_url("https://github.com/o/pull/pull/12"), Some(12));
        // Anything we cannot read confidently is None — a wrong number is worse than no record.
        assert_eq!(pr_number_from_url("https://github.com/o/r/pull/abc"), None);
        assert_eq!(pr_number_from_url("https://github.com/o/r/pull/0"), None);
        assert_eq!(pr_number_from_url("not a url"), None);
    }

    #[test]
    fn a_descriptive_branch_name_still_resolves_from_the_created_record() {
        // THE HEADLINE CASE: a PR on `sparkle/left-pair` — no agent id anywhere in the branch —
        // resolves because the mapping was RECORDED, not inferred.
        let d = tmp();
        assert_eq!(resolve_owner(&PrOwnerStore::default(), "p1", 806, "sparkle/left-pair", ""), None);
        record_pr_created(d.path(), "p1", 806, "agent-cockpit", "sparkle/left-pair").unwrap();
        let store = load_store(d.path());
        let got = resolve_owner(&store, "p1", 806, "sparkle/left-pair", "").unwrap();
        assert_eq!(got, ResolvedOwner { agent_id: "agent-cockpit".into(), source: SOURCE_CREATED.into() });
        // …and it keeps resolving after the branch is RENAMED or deleted, because resolution never
        // keys on the branch.
        let after_rename = resolve_owner(&store, "p1", 806, "sparkle/renamed-entirely", "").unwrap();
        assert_eq!(after_rename.agent_id, "agent-cockpit");
    }

    #[test]
    fn a_pr_opened_from_an_agents_own_shell_resolves_via_its_worktree_branch() {
        // `gh pr create` run inside a worker never touches `open_agent_pr`, so nothing is recorded
        // against the PR — the branch OBSERVATION is what rescues it.
        let d = tmp();
        observe_branch(d.path(), "p1", "sparkle/left-pair", "agent-cockpit").unwrap();
        let got = resolve_owner(&load_store(d.path()), "p1", 806, "sparkle/left-pair", "").unwrap();
        assert_eq!(got.agent_id, "agent-cockpit");
        assert_eq!(got.source, SOURCE_WORKTREE_BRANCH);
    }

    #[test]
    fn a_branch_seen_under_two_agents_stops_resolving_rather_than_picking_one() {
        let d = tmp();
        observe_branch(d.path(), "p1", "shared", "agent-a").unwrap();
        observe_branch(d.path(), "p1", "shared", "agent-b").unwrap();
        assert_eq!(resolve_owner(&load_store(d.path()), "p1", 1, "shared", ""), None);
        // Sticky: seeing the first agent again does not un-poison it.
        observe_branch(d.path(), "p1", "shared", "agent-a").unwrap();
        assert_eq!(resolve_owner(&load_store(d.path()), "p1", 1, "shared", ""), None);
    }

    #[test]
    fn the_ambiguity_latch_survives_a_backfill_of_the_observed_branch() {
        // roborev 55253. The test above asserts the BRANCH table directly and so never went through
        // the backfill — which is where the invariant actually broke. Recording a `worktree-branch`
        // resolution into the PR table would make `resolve_owner`'s step 1 answer unconditionally,
        // and the PR would keep naming agent A long after the branch stopped identifying anyone.
        //
        // The scenario, end to end: A's worktree is seen on `shared/feature`; B opens PR #10 from it
        // with `gh pr create` in its own shell (no `created` record, no body marker); a list refresh
        // resolves and backfills; then B's worktree is seen on the same branch.
        let d = tmp();
        observe_branch(d.path(), "p1", "shared/feature", "agent-a").unwrap();
        let out = resolve_and_backfill(d.path(), "p1", &[(10, "shared/feature".into(), String::new())]);
        assert_eq!(out[0].as_ref().unwrap().agent_id, "agent-a");
        assert_eq!(out[0].as_ref().unwrap().source, SOURCE_WORKTREE_BRANCH);
        // The observation must NOT have been frozen into the PR table.
        assert!(
            load_store(d.path()).prs.get("p1").map_or(true, |m| !m.contains_key("10")),
            "a worktree observation must stay live, not become a durable PR record",
        );
        observe_branch(d.path(), "p1", "shared/feature", "agent-b").unwrap();
        assert_eq!(
            resolve_and_backfill(d.path(), "p1", &[(10, "shared/feature".into(), String::new())])[0],
            None,
            "once the branch is ambiguous the PR must stop resolving, not keep its stale answer",
        );
    }

    #[test]
    fn a_stable_source_is_still_frozen_so_a_legacy_pr_survives_its_branch() {
        // The flip side of the test above: not-recording is scoped to the ONE volatile source. A
        // body marker and the legacy branch-name convention are fixed facts, and freezing them is
        // what makes those PRs outlive a rename — so a blanket "never backfill" would be a
        // regression, not a safer version of this fix.
        let d = tmp();
        let body = pr_body_marker("agent-x", "p1");
        resolve_and_backfill(
            d.path(),
            "p1",
            &[(11, "any/branch".into(), body), (12, "sparkle/agent-legacy".into(), String::new())],
        );
        let store = load_store(d.path());
        assert_eq!(resolve_owner(&store, "p1", 11, "", "").unwrap().agent_id, "agent-x");
        assert_eq!(resolve_owner(&store, "p1", 12, "", "").unwrap().agent_id, "legacy");
    }

    #[test]
    fn re_observing_the_same_agent_does_not_rewrite_the_file() {
        // The status poll calls this every 30s per agent; a rewrite per tick would be pure churn.
        let d = tmp();
        observe_branch(d.path(), "p1", "b", "agent-a").unwrap();
        let before = std::fs::metadata(store_path(d.path())).unwrap().modified().unwrap();
        let mut store = load_store(d.path());
        assert!(!record_branch(&mut store, "p1", "b", "agent-a", now_secs() + 500));
        observe_branch(d.path(), "p1", "b", "agent-a").unwrap();
        assert_eq!(std::fs::metadata(store_path(d.path())).unwrap().modified().unwrap(), before);
    }

    #[test]
    fn the_body_marker_answers_on_a_machine_with_an_empty_store() {
        let store = PrOwnerStore::default();
        let body = format!("Opened by Sparkle.\n\n{}", pr_body_marker("agent-x", "p1"));
        let got = resolve_owner(&store, "p1", 42, "sparkle/anything", &body).unwrap();
        assert_eq!(got, ResolvedOwner { agent_id: "agent-x".into(), source: SOURCE_PR_BODY.into() });
        // A marker belonging to a DIFFERENT project is discarded, not borrowed — the caller could
        // not open that agent from here, so a pill would point somewhere useless.
        assert_eq!(resolve_owner(&store, "p2", 42, "sparkle/anything", &body), None);
    }

    #[test]
    fn backfill_makes_a_legacy_uuid_branch_pr_durable() {
        let d = tmp();
        let branch = "sparkle/agent-9e48bf5c-02fb-499b-9bc7-d24034577799".to_string();
        let out = resolve_and_backfill(d.path(), "p1", &[(804, branch.clone(), String::new())]);
        assert_eq!(out[0].as_ref().unwrap().source, SOURCE_BRANCH_NAME);
        // Recorded — so the SAME PR now resolves with the branch gone entirely.
        let store = load_store(d.path());
        assert_eq!(
            resolve_owner(&store, "p1", 804, "", "").unwrap().agent_id,
            "9e48bf5c-02fb-499b-9bc7-d24034577799"
        );
    }

    #[test]
    fn a_weaker_source_never_overwrites_a_stronger_recorded_owner() {
        // A branch rename that happens to LOOK like another agent's must not steal a PR whose owner
        // we recorded first-hand at creation.
        let d = tmp();
        record_pr_created(d.path(), "p1", 5, "true-owner", "sparkle/left-pair").unwrap();
        resolve_and_backfill(d.path(), "p1", &[(5, "sparkle/agent-impostor".into(), String::new())]);
        let got = resolve_owner(&load_store(d.path()), "p1", 5, "sparkle/agent-impostor", "").unwrap();
        assert_eq!(got.agent_id, "true-owner");
        assert_eq!(got.source, SOURCE_CREATED);
    }

    #[test]
    fn an_unresolvable_pr_answers_null_with_a_reason_never_a_guess() {
        let d = tmp();
        let a = answer_for(d.path(), "p1", 806, "sparkle/left-pair", "");
        assert_eq!(a.agent_id, None);
        assert_eq!(a.source, None);
        assert_eq!(a.branch.as_deref(), Some("sparkle/left-pair"));
        assert!(a.reason.unwrap().contains("do not guess"));
    }

    #[test]
    fn a_corrupt_store_degrades_to_empty_rather_than_to_stale_owners() {
        let d = tmp();
        std::fs::write(store_path(d.path()), "{ not json").unwrap();
        assert_eq!(load_store(d.path()), PrOwnerStore::default());
        // …and is still writable afterwards, so one bad write doesn't wedge ownership forever.
        record_pr_created(d.path(), "p1", 1, "a", "b").unwrap();
        assert_eq!(resolve_owner(&load_store(d.path()), "p1", 1, "b", "").unwrap().agent_id, "a");
    }

    #[test]
    fn ids_that_could_escape_a_path_or_a_git_arg_are_refused_at_the_boundary() {
        let mut store = PrOwnerStore::default();
        assert!(!record_pr(&mut store, "p1", 1, "../../etc", "b", SOURCE_CREATED, 0));
        assert!(!record_pr(&mut store, "p1", 1, "", "b", SOURCE_CREATED, 0));
        assert!(!record_branch(&mut store, "p1", "b", "a b", 0));
        assert!(!record_branch(&mut store, "p1", "  ", "agent", 0));
        assert_eq!(store, PrOwnerStore::default());
    }
}
