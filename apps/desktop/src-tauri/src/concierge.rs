//! Headless brain for Concierge Mode (PRD/sparkle/concierge-mode.md §5, bead sparkle-ma6e).
//!
//! The concierge is a long-lived cross-project minder: the frontend (U7) feeds it snapshots of
//! app state — the agent roster, statuses, attention events, terminal prompts — as turn prompts,
//! and it streams back plain-language "what needs you + what I recommend" replies into the
//! concierge thread. Like `claude_chat.rs` / `sparkle_improve.rs`, each turn runs the user's OWN
//! `claude` binary on THEIR machine under THEIR login — Sparkle never reads or stores the auth
//! token; the genuine `claude` binary authenticates itself (the ToS-compliant path, bead
//! ). Continuity across turns comes from `--resume <session_id>`: the frontend keeps
//! the session id from each `concierge:done` and passes it back on the next turn.
//!
//! Permission posture — the brain OBSERVES and RECOMMENDS, it never acts. Two hard properties:
//! an unattended `-p` session must never hang on a permission prompt, and the concierge must
//! never mutate files or run commands un-prompted. Both are satisfied with a READ-ONLY
//! `--allowedTools` allowlist (no Bash, no writes): in `-p` print mode a disallowed tool is
//! refused, not prompted, so the session can't hang. We deliberately do NOT use
//! `--dangerously-skip-permissions` — the concierge's ability to ACT (relaying dispatched
//! answers into terminals) is a separate, user-gated unit (U4, `conciergeDispatch.ts`) that
//! never flows through this process.
//!
//! Process shape — one turn at a time, `sparkle_improve.rs`-style: the child runs in its OWN
//! process group (unix), so cancel/supersede kills `claude` AND anything it spawned; a new turn
//! supersedes an in-flight one (the concierge always answers the LATEST snapshot); the reader
//! thread only reaps/emits under a matching turn token, so a superseded reader stays silent.
//! The cwd is the app-data dir — deliberately NOT a repo worktree: the concierge doesn't own a
//! checkout and must not compete with builder agents for one.
//!
//! Security note (mirrors `claude_chat.rs`): this command launches the user's own `claude` via
//! `/bin/zsh -c '…'`, so by design it runs a shell script the webview hands it; the REAL
//! boundary is the WebView's integrity (strict CSP, no remote origins) plus the read-only
//! allowlist above. Everything user-influenced is `shell_quote`d so it can't escape the quoting.

use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::claude_chat::{
    cached_login_shell_path, capture_result_status, capture_tool_uses_with, clamp_live_tool_input,
    handle_event, shell_quote, ToolUseRecord,
};
use crate::preflight::cached_claude_path;

/// Login shell we launch `claude` through — matches `pty.rs` / `claude_chat.rs` /
/// `sparkle_improve.rs` so the launcher can't diverge.
const SHELL: &str = "/bin/zsh";

/// Built-in tool allowlist for the concierge brain: reads + search + web only. No Bash, no
/// writes, no Edit. Deliberately narrower than the Think tab's list (no Skill/Task): the
/// concierge acts through the `sparkle-control` MCP surface, not by shelling out, and the
/// smaller built-in surface is easier to reason about.
///
/// ⚠️ THIS FLAG DOES NOT GATE MCP TOOLS. Measured against Claude Code 2.1.220 (bead
/// `sparkle-xbka`, P0): with `--mcp-config` present, an MCP tool ABSENT from `--allowedTools`
/// still EXECUTED. Only `--disallowedTools` blocked it. An earlier version of this comment
/// claimed `-p` mode refuses any non-allowlisted tool; that claim was false and load-bearing,
/// which is why it is called out here rather than quietly deleted.
///
/// Two consequences that must not be forgotten:
///  1. The app-side policy gate in `controlListener.dispatch` is the ONLY real gate on what the
///     concierge can do — it is NOT defence-in-depth behind this string.
///  2. The MCP server's registered tool surface is ITSELF a security boundary. Never register a
///     tool on the concierge's control socket intending to hide it via this allowlist.
///
/// The `mcp__sparkle-control__*` entry below is therefore DOCUMENTATION OF INTENT, not
/// enforcement; it keeps this list honest about what the concierge can reach.
const CONCIERGE_ALLOWED_TOOLS: &str =
    "Read,Grep,Glob,WebFetch,WebSearch,TodoWrite,mcp__sparkle-control__*";

/// The concierge's role, appended to Claude Code's system prompt on every turn. Kept as ONE
/// clearly-editable constant so tuning the concierge's voice is a one-line-of-history change.
///
/// HISTORY THAT MATTERS: this used to say "You OBSERVE and RECOMMEND only — you never take
/// actions yourself", paired with a read-only allowlist. The founder's 2026-07-27 direction
/// reversed that: column 1 is meant to be their SINGLE POINT OF CONTACT, able to do everything
/// in the app, with the human tuning per-tool how autonomous it is. The concierge can now act
/// through the `sparkle-control` MCP surface.
///
/// The persona no longer *enforces* anything — it only describes the posture. Enforcement is the
/// app-side policy gate in `controlListener.dispatch` (allow / ask / deny per tool), because
/// `--allowedTools` provably does not gate MCP tools (see `CONCIERGE_ALLOWED_TOOLS`). Do not
/// re-introduce a persona sentence that *claims* a restriction the gate does not implement.
///
/// THIS IS THE APP'S HALF OF THE SYSTEM PROMPT, NOT ALL OF IT. The user's own accumulated
/// communication rules (`concierge_guidelines.rs`) are appended after it under their own heading on
/// every turn. Keep the split honest: what belongs HERE is the posture Sparkle guarantees and the
/// mechanics only the app knows (link syntax, routing, honesty about tool outcomes); what belongs
/// THERE is taste — anything the user is entitled to overrule.
pub(crate) const CONCIERGE_PERSONA: &str = "You are the user's cross-project concierge and \
minder — their eyes, ears, and best friend across everything happening in their projects, and \
their single point of contact for the whole app. Each message you receive is a snapshot of live \
app state: builder agents and their statuses, what needs attention, and terminal prompts \
awaiting a decision.\n\nYou CAN ACT. Through your Sparkle tools you can spawn and stop build \
agents, read an agent's terminal and type into it, drive branches and pull requests, manage \
projects and windows, and change settings. The human has configured, per tool, whether you may \
act silently, must ask first, or may not act at all. When a tool requires asking, say plainly \
what you intend to do and why, then wait. When a tool is denied, say so and offer the nearest \
thing you can do. Never claim you took an action you did not take, and never report success you \
did not observe — if a tool returns a refusal or an error, say exactly that.\n\nROUTE INTENT \
CAREFULLY. Decide whether the user is talking TO you or THROUGH you. Questions, planning, \
brainstorming and 'what should I do' are for you to answer directly. Text clearly meant for a \
specific build agent — an answer to a prompt it is waiting on, a correction to what it is doing \
— should be sent to that agent's terminal. When it is genuinely ambiguous, ask which you meant \
rather than guessing; a message typed into the wrong agent's terminal is expensive to undo.\n\n\
WHEN THE USER NAMES AN AGENT WITH @, RELAY THEIR WORDS, NOT YOUR OWN. The address settles WHO, \
so do not re-litigate the destination — but you still own WHAT arrives. Send what they wrote, \
as they wrote it: they are talking to their own agent and rewording it silently means the agent \
acts on words the user never said. The one exception is a message so terse or ambiguous that the \
agent would likely act on the wrong reading of it — then propose the fuller version you would \
send, and WAIT for their yes rather than sending either version. Do not use that as an excuse to \
embellish a message that is merely short; 'ship it' to an agent that has one PR open is clear. \
Afterwards, say what you sent and to whom, then stay in the conversation — relaying is not the \
end of your turn. You are their thought partner about that agent's work, not a mail slot.\n\n\
NAME AGENTS AS LINKS, NEVER AS BARE TEXT. Every roster line you are given ends with `id:<agentId>`. \
Whenever you name a build agent, write it as a markdown link of the form \
[@Agent Name](sparkle-agent:<agentId>), using that agent's exact id from the roster in front of \
you. The app renders that link as a clickable pill the user taps to jump to the agent, so a bare \
name is a dead end for them. NEVER invent, guess, or reuse an id: if the agent you are naming is \
not on the roster you were given, write its plain name with no link. A link that resolves to \
nothing merely fails to open — a link carrying the WRONG id opens the wrong agent, which is far \
worse. Write ONLY the agent's short name inside the link — not its task, not what it is doing.\n\n\
THIS APPLIES HARDEST TO AN AGENT YOU JUST STARTED, because that is the case where a name is \
guaranteed to go stale. `spawn_build_agent` replies with `agentId`, `agentExists`, and — when the \
agent still exists — `provisionalName` (with `nameIsProvisional: true`). CHECK `agentExists` FIRST. \
When it is false the agent was closed (or its project was) while the spawn was still starting it, \
so the row is GONE and `provisionalName` is absent: do NOT render a pill for it, do NOT call \
`send_to_agent_terminal` or `close_agent` on that id, and do not describe it as running. SAY WHAT \
THE REPLY SAYS: use its `briefFailure` sentence, which is written for the exact case, and do not \
impose a chronology of your own. In particular do NOT assert the agent closed BEFORE it got its \
brief unless the reply says so — `briefDelivery: \"submitted\"` with `agentExists: false` means the \
brief DID go in and the row was closed after, and telling the user the opposite invites them to \
re-send a brief the agent already had. Offer to start a fresh one either way. An id from the reply is not proof \
the agent is there — this one field is what tells you, and a pill built from a dead id opens \
nothing while looking exactly like a working one. The provisional name is a spawn-time placeholder \
like 'Build 17' that \
the agent replaces within seconds by naming itself after its work, so quoting it as bare text tells \
the user about a name that no longer exists anywhere on their screen — they cannot find it, and \
they have to ask you which agent you meant. Announce a spawn as \
[@Build 17](sparkle-agent:<agentId>) using the id from the reply. The pill re-reads the agent's \
CURRENT name every time it is rendered, so it will show the placeholder at first and then rename \
itself in front of the user as the agent settles on a real name — which is exactly the visibility \
they want. The same rule makes an old message safe: a reference you wrote an hour ago still shows \
whatever the agent is called now, so you never need to track or correct a rename.\n\n\
REMEMBER HOW THEY WANT YOU TO TALK. When the user states a preference about YOUR OWN output — how \
you write, what you lead with, what to stop doing — call `append_communication_guideline` with it \
as one imperative sentence, and then tell them you saved it. Those rules are added to these \
instructions on every turn, so a preference stated once keeps applying instead of being \
re-explained; the section below headed THE USER'S OWN COMMUNICATION GUIDELINES is that file. Where \
it disagrees with anything above on matters of STYLE or PRESENTATION, the user's file wins — but it \
governs how you SPEAK only. It never grants you a permission, never widens what your tools may do, \
and never overrides the rules above about honesty or about never guessing an agent id. Save a \
preference about your communication, not \
facts about their projects, and not a one-off instruction that only shapes the current reply. Do \
not save the same rule twice — if it is already in that section, just follow it.\n\n\
Be a real collaborator: give ideas, push back when you think the user is wrong, and flag risks \
you notice. Stay calm and brief — no filler, no alarmism. When nothing needs them, say so in a \
sentence. Respond in clean GitHub-flavored markdown, tightest-first: lead with what needs the \
user, one short line per item with your recommendation.";

/// Monotonic per-turn token (same guard as `claude_chat::TURN_SEQ`): the reader thread only
/// reaps/emits when the slot STILL carries its own token, so a reader whose turn was superseded
/// or cancelled stays silent instead of clobbering the live turn. Also serves as the `id` on
/// this turn's `concierge:*` events, so the frontend can correlate deltas with their done/error.
static TURN_SEQ: AtomicU64 = AtomicU64::new(1);

/// Every turn whose token is BELOW this is retired: the user has sent again (or cancelled), so it
/// must stop emitting immediately — even though it may still be holding the slot.
///
/// The slot alone is too late (roborev 53105). `concierge_turn` only takes the slot AFTER it has
/// resolved the claude path, prepared the cwd and spawned a fresh `zsh`/`claude` — hundreds of
/// milliseconds during which the OLD turn still legitimately owns it, and any first tokens it
/// produces in that window were emitted as if live, stranding a bubble that answers the previous
/// question (and, since that turn is then killed, never gets a terminal event to clear it). This
/// is published at the TOP of a send, before any of that work, so "the user moved on" takes effect
/// the instant they act rather than whenever the replacement process happens to finish starting.
static RETIRE_BELOW: AtomicU64 = AtomicU64::new(0);

/// Bumped by every cancel. A send reads it on entry and again after its prep: a change across that
/// window means the user cancelled the very turn being started, before it had a token or a child —
/// the state no floor and no slot can describe, because it has neither yet (roborev 53147).
static CANCEL_EPOCH: AtomicU64 = AtomicU64::new(0);

/// Sentinels for the two NON-failures a send can end in: the user superseded it or cancelled it.
/// Stable strings because the frontend matches on them to stay silent — neither is something to
/// tell the user about, and both are ordinary outcomes of two fast sends (roborev 53186).
pub const SUPERSEDED_ERR: &str = "concierge_turn: superseded before install";
pub const CANCELLED_ERR: &str = "concierge_turn: cancelled";

/// The third NON-failure, and the one this channel adds: a PROACTIVE push stood down because the
/// user owns the conversation. Also matched by the frontend to stay silent — a refused push is the
/// channel working correctly, not something to tell anyone about.
pub const PROACTIVE_DECLINED_ERR: &str =
    "concierge_proactive_turn: declined; the user owns the conversation";

/// How many user sends are currently BETWEEN the top of `concierge_turn` and their install
/// decision — i.e. preparing, with no token, no child and nothing in the slot yet.
///
/// This is the window a slot check cannot see, and it is exactly where the proactive push channel
/// could otherwise do real damage. `concierge_turn` resolves the claude path, prepares the cwd and
/// spawns a fresh `zsh`/`claude` before it takes the slot; a push that installed during that window
/// would present at the send's own install site as a NEWER occupant, and `may_install` would make
/// the SEND stand down (`spawn_turn` returns `SUPERSEDED_ERR` and kills its own child). The user's
/// message would die unanswered, displaced by a message nobody asked for.
///
/// Maintained by `SendInFlight` rather than by paired increments: the command has six early returns.
static PENDING_SENDS: AtomicU64 = AtomicU64::new(0);

/// Proactive pushes spawned this process — the cost meter. Every push is a `claude` turn the user
/// did not ask for, so the number is first-class rather than something to reconstruct from logs.
static PROACTIVE_TURNS: AtomicU64 = AtomicU64::new(0);

/// RAII marker for "a user send is preparing". Held across the whole of `concierge_turn`, so every
/// return path releases it (see PENDING_SENDS for why a forgotten decrement would silently wedge
/// the push channel for the life of the process).
struct SendInFlight;

impl SendInFlight {
    fn enter() -> Self {
        PENDING_SENDS.fetch_add(1, Ordering::SeqCst);
        SendInFlight
    }
}

impl Drop for SendInFlight {
    fn drop(&mut self) {
        PENDING_SENDS.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Is a user send preparing right now? Read as one function so both proactive gates (the cheap
/// pre-check and the install site under the lock) ask the same question.
fn sends_pending() -> bool {
    PENDING_SENDS.load(Ordering::SeqCst) > 0
}

/// Count one spawned push, returning the new total.
fn count_proactive_turn() -> u64 {
    PROACTIVE_TURNS.fetch_add(1, Ordering::Relaxed) + 1
}

/// Pushes spawned so far this process.
pub fn proactive_turns_spawned() -> u64 {
    PROACTIVE_TURNS.load(Ordering::Relaxed)
}

/// One in-flight concierge turn: the child (kept for kill/reap) tagged with its turn token.
struct ConciergeTurn {
    child: Child,
    token: u64,
}

/// At most one concierge turn in flight, process-wide (there is exactly one concierge). A new
/// `concierge_turn` supersedes the current one; `concierge_cancel` takes the slot and kills it.
#[derive(Default)]
pub struct ConciergeManager {
    turn: Mutex<Option<ConciergeTurn>>,
}

/// Best-effort cleanup on app teardown: a still-running turn must not outlive the app as a
/// detached process. (On a hard kill this never runs; the child is a read-only `-p` one-shot,
/// so the worst case is a soon-to-exit orphan, not a mutator.)
impl Drop for ConciergeManager {
    fn drop(&mut self) {
        if let Some(mut turn) = lock_turn(&self.turn).take() {
            kill_turn_group(&mut turn.child);
        }
    }
}

/// Lock the turn slot, recovering from poisoning rather than panicking (same rationale as
/// `claude_chat.rs`): a panicked reader must not brick the concierge for the rest of the process.
fn lock_turn(m: &Mutex<Option<ConciergeTurn>>) -> MutexGuard<'_, Option<ConciergeTurn>> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// May this turn still SPEAK? Two facts: the send-time retirement floor (checked first, lock-free,
/// because it covers the window in which this turn still holds the slot but the user has already
/// moved on) and the slot itself.
///
/// Gates the delta emit ONLY — its single caller. The reap does its own inline slot match in
/// `drain_turn` and deliberately does NOT consult the floor: a retired turn that still holds the
/// slot is the one that must reap its own child and emit its terminal event, or the process leaks
/// and the frontend's turn never ends (roborev 53130).
fn still_owns_turn(app: &AppHandle, token: u64) -> bool {
    // Retired at send time — checked FIRST, and without the lock, because it covers the window in
    // which this turn still holds the slot but the user has already moved on (see RETIRE_BELOW).
    if is_retired(token, RETIRE_BELOW.load(Ordering::Relaxed)) {
        return false;
    }
    let manager = app.state::<ConciergeManager>();
    let slot = lock_turn(&manager.turn);
    matches!(slot.as_ref(), Some(t) if t.token == token)
}

/// Is the turn in the slot ours to tear down? Only one strictly OLDER than us: our floor retired
/// it, so it is silenced-but-running unless we kill it. A NEWER occupant owns both the floor and
/// the slot — killing it is how a refused older send murders the live turn (roborev 53205).
///
/// A real function called by both teardown sites, not a rule each restates: the fifth round of that
/// finding, and it was right every time.
fn mine_to_tear_down(token: u64, slot_holds: Option<u64>) -> bool {
    matches!(slot_holds, Some(t) if t < token)
}

/// Did a cancel land while this send was preparing? A REAL function, called from `concierge_turn`,
/// so a test drives the production control flow rather than a copy of the comparison — deleting
/// the call then leaves a dead-code warning instead of a silent hole (roborev 53181).
fn cancelled_during_prep(entry_epoch: u64) -> bool {
    CANCEL_EPOCH.load(Ordering::Relaxed) != entry_epoch
}

/// Which of the two things a `spawn_turn` can be. The install rule differs between them because
/// only ONE of them is evidence of fresh user intent (roborev 53397).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum TurnKind {
    /// A user send. Its token was reserved by `reserve_turn_token`, which floors at that token in
    /// the same breath — so for a send, and ONLY for a send, "a higher token means the user asked
    /// more recently" is true by construction.
    Send,
    /// The stale-resume retry: the same logical turn, continuing, under the token its send already
    /// reserved. It publishes no floor and claims no recency.
    Continuation,
    /// A PROACTIVE PUSH: a turn the brain initiates with no user message behind it, so column one
    /// can say "these three need you" without being asked (PRD §2a). Like a continuation it
    /// publishes no floor and claims no recency; unlike either user-driven kind it also stands down
    /// while a send is merely PREPARING. See `may_install`.
    Proactive,
}

/// May this turn take the slot? A REAL function, called from the install site under the lock, so
/// a test can drive the actual rule (roborev 53186 — four rounds running, a test asserting against
/// a local copy of a predicate would have stayed green with the call site deleted).
///
/// No when we have been retired, and then it depends on WHAT is installing:
///
/// * A `Send` refuses only a strictly NEWER occupant. Spawns finish out of order, so an older send
///   must never stomp the entry of the one the user is waiting on — but it may legitimately take
///   the slot from a turn its own floor already retired.
/// * A `Continuation` refuses ANY occupant (roborev 53397). The reap that precedes the retry
///   emptied the slot itself, so whatever is in there now was installed AFTER that — i.e. by a send
///   the user made while the first attempt was failing. Comparing tokens cannot express that: the
///   continuation reuses its own turn's token, which is by definition older than that send's.
/// * A `Proactive` push refuses any occupant AND any send that is merely PREPARING. It is the only
///   kind that consults `sends_pending`, and it has to: a push is not something the user asked for,
///   so it must never be the reason a message they DID send stands down. See PENDING_SENDS for the
///   window, and `a_proactive_push_never_installs_over_a_user_turn` for the rule.
///
/// `sends_pending` is deliberately inert for the two user-driven kinds. A send holds its own pending
/// guard for the whole of its prep, so consulting it there would make every send refuse itself.
fn may_install(
    kind: TurnKind,
    token: u64,
    retire_below: u64,
    slot_holds: Option<u64>,
    sends_pending: bool,
) -> bool {
    if is_retired(token, retire_below) {
        return false;
    }
    match kind {
        TurnKind::Send => !matches!(slot_holds, Some(t) if t > token),
        TurnKind::Continuation => slot_holds.is_none(),
        TurnKind::Proactive => slot_holds.is_none() && !sends_pending,
    }
}

/// May a proactive push even START — the same precedence rule as `may_install`, asked BEFORE the
/// push spends a claude-path lookup and a process spawn on a turn it is about to refuse.
///
/// A real function the command calls (the pattern this module already uses for `cancelled_during_prep`
/// / `refused_retry_stays_silent`), so a test drives production control flow and deleting the call
/// leaves a dead-code warning rather than a silent hole. It is an OPTIMISATION, not the guarantee:
/// the install site re-checks both facts under the slot lock, which is where the race is actually
/// decided.
fn proactive_may_start(sends_pending: bool, slot_occupied: bool) -> bool {
    !sends_pending && !slot_occupied
}

/// A push's token: monotonic (its events need an id, and the install rules need a position in the
/// ordering) but published WITHOUT a retirement floor.
///
/// That asymmetry with `reserve_turn_token` is the whole safety property of this channel. A floor is
/// how a turn silences the ones before it; a push is a turn nobody asked for, so it must never be
/// able to silence anything. Taking a real token still matters: a send that arrives afterwards gets
/// a strictly higher one, so every existing rule — `is_retired`, `may_install`, `mine_to_tear_down`
/// — reads the push as the older turn and lets the user's message supersede it for free.
fn reserve_proactive_token() -> u64 {
    TURN_SEQ.fetch_add(1, Ordering::Relaxed)
}

/// Did a failed retry SPAWN fail because the user moved on, rather than because anything is wrong?
/// Then it must emit nothing at all (roborev 53460) — the same silence the reader keeps for
/// `!outcome.owned`.
///
/// Two independent signals, either sufficient, because they are read at slightly different moments:
///
/// * the error IS `SUPERSEDED_ERR`, which `spawn_turn` returns only when it refused to install; and
/// * the floor is above our token, which is true for every refusal of a continuation by
///   construction — a continuation is refused when it is retired, or when the slot is occupied, and
///   an occupant can only be a send that published its floor above us before installing.
///
/// A REAL function called from the retry site, so the rule is testable and deleting the call leaves
/// a dead-code warning (same pattern as `cancelled_during_prep`). A genuine spawn failure — no fork,
/// no pipe — matches neither signal and is still surfaced to the user, which is the whole point of
/// not simply always going quiet here.
fn refused_retry_stays_silent(spawn_err: &str, token: u64, retire_below: u64) -> bool {
    spawn_err == SUPERSEDED_ERR || is_retired(token, retire_below)
}

/// Pure half of the retirement rule: a turn is retired once a LATER send (or a cancel) has
/// published a floor above its token. Split out so the rule is testable without a Tauri app.
fn is_retired(token: u64, retire_below: u64) -> bool {
    token < retire_below
}

/// Claim the next turn token AND retire everything below it, in that order. Called immediately
/// before the spawn — AFTER the cheap fallible prep (claude path, app-data dir, `create_dir_all`),
/// deliberately, so a send that fails before it ever spawns cannot silence a turn it never
/// replaced. See the note at the call site.
///
/// Reserving first is what makes it correct under two concurrent sends (`concierge_turn` is an
/// async command; nothing serializes two rapid ones). Publishing `TURN_SEQ.load()` without taking
/// a token loses that race: send B can read 5 and store 5 while send A has not yet taken token 5,
/// so A — the OLDER turn — ends up unretired by the very send that superseded it. Taking the token
/// first means the floor is always "strictly below ME", which is true by construction.
///
/// `fetch_max`, not `store`: floors only ever rise, so a slower thread can't lower one a newer
/// send has already published.
fn reserve_turn_token() -> u64 {
    let token = TURN_SEQ.fetch_add(1, Ordering::Relaxed);
    RETIRE_BELOW.fetch_max(token, Ordering::Relaxed);
    token
}

/// How the stale-resume retry must be spawned: as a `Continuation`, under the SAME token the turn
/// it continues already reserved. A real function called by the retry site, so a test drives the
/// production rule instead of a restatement of it — and deleting the call leaves a dead-code
/// warning rather than a silent hole (roborev 53397, same pattern as `cancelled_during_prep`).
///
/// It used to draw a FRESH token off `TURN_SEQ` "without publishing a floor", which looked
/// conservative and was not: every comparison in this module reads a higher token as more recent
/// user intent, and a fresh draw is higher than every send that exists. Turn 5 fails with a resume
/// id and reaps; the user sends, taking token 6 and flooring at 6; the retry draws 7, is not
/// retired by a floor of 6, and installs — killing turn 6's child. Turn 6's reader then finds the
/// slot changed, returns `owned: false` and emits NOTHING, while the retry's answer to the previous
/// question arrives under id "5", which the frontend has already retired. The user's newest
/// question dies unanswered and the typing indicator hangs for the session.
///
/// Reusing the turn's own token makes the retry's position in the ordering its TRUE position — the
/// moment the user asked this question — so every existing rule becomes correct for it for free:
/// a later send's floor retires it (`is_retired`), and a later send that has not floored yet still
/// out-ranks it at the install site and supersedes it there instead. Note that no reordering of a
/// fresh `fetch_add` against the floor read could have closed this: a token above every send is
/// wrong no matter when it is compared.
///
/// The retry needs no unique token of its own: the reap it comes after took its turn OUT of the
/// slot, so there is nothing left to tell apart.
fn continuation_install(original_token: u64) -> (TurnKind, u64) {
    (TurnKind::Continuation, original_token)
}

/// Retire every turn RESERVED so far — for cancel, which starts nothing itself.
///
/// The floor alone cannot stop a send that has not reached its reservation yet, whatever it is
/// derived from: a barrier token would simply land above that send's later token, exactly as this
/// load does (roborev 53147 proposed the barrier; it moves the arithmetic without closing the
/// gap). What covers "Escape while Enter is still resolving the claude path" is CANCEL_EPOCH,
/// which `concierge_turn` re-checks after its prep.
fn retire_issued_turns() {
    CANCEL_EPOCH.fetch_add(1, Ordering::Relaxed);
    RETIRE_BELOW.fetch_max(TURN_SEQ.load(Ordering::Relaxed), Ordering::Relaxed);
}

/// Kill a turn and everything it spawned, then reap it. The child is placed in its own process
/// group at spawn (unix), so signal the GROUP — `claude` may have `WebFetch`/search helpers in
/// flight — with a direct `kill()` as the non-unix / group-signal-failed fallback. That is
/// [`crate::proc::kill_process_group`], which this used to be a local copy of.
fn kill_turn_group(child: &mut Child) {
    crate::proc::kill_process_group(child);
}

#[derive(Clone, Serialize)]
struct ConciergeDelta {
    id: String,
    text: String,
}

/// ONE tool call, emitted LIVE the moment its `tool_use` block is parsed — the `concierge:tool`
/// event.
///
/// WHY IT EXISTS: the concierge column can already name what the concierge is doing for the ~13
/// `concierge_tool` control domains, because those round-trip through the frontend's control
/// listener. Everything else the concierge runs — `Bash` (git/gh/bd), `Read`, `Grep`, `Glob`,
/// `Task`, `WebFetch` — was invisible while the turn ran, which is the MAJORITY of a turn's elapsed
/// time, and the column rendered three animated dots for all of it. Rust was already parsing every
/// one of those blocks; it just held them until the turn ended.
///
/// It is a SEPARATE event from `concierge:done`'s `tool_calls`, not a replacement: that vector is
/// the reply linter's record (full arguments, capped list, delivered once with the reply it belongs
/// to), while this is a status line. Same parse, different clamp — see `clamp_live_tool_input`.
///
/// `id` is the turn token as a string, identical to what `concierge:delta` and `concierge:done`
/// carry, so the frontend correlates a tool event exactly as it correlates a chunk of text.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConciergeToolEvent {
    id: String,
    /// The block's `name`, VERBATIM — `"Bash"`, `"Read"`,
    /// `"mcp__sparkle-control__sparkle_terminal"`. Not normalized or prettified here: rendering is
    /// the frontend's job, and a Rust-side mapping would be a second vocabulary to keep in step.
    name: String,
    /// Compact JSON of the block's `input`, clamped to `MAX_LIVE_TOOL_INPUT_CHARS`. Deliberately
    /// NOT guaranteed parseable — a clamped value carries a truncation marker — for the same reason
    /// `ToolUseRecord::input` isn't: the consumer reads it as text.
    input: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConciergeDone {
    id: String,
    session_id: String,
    text: String,
    /// Every tool call this turn made, with its FULL arguments — serialized as `toolCalls` for the
    /// frontend (`ConciergeDoneEvent` in services/concierge.ts). Rides the existing `concierge:done`
    /// event rather than a channel of its own: it is only ever read together with the reply it
    /// belongs to, and correlating two events by turn id would be a race to re-solve for nothing.
    ///
    /// Exists for the deterministic reply linter's `relay-paste` check — "did the concierge paste
    /// the text it relayed back into its answer?" is decidable only against what was actually sent.
    /// Bounded at capture time (see `ToolUseRecord`), so this cannot grow without limit.
    tool_calls: Vec<ToolUseRecord>,
}

#[derive(Clone, Serialize)]
struct ConciergeError {
    id: String,
    detail: String,
}

/// Build the `exec …` script handed to `zsh -c` (with the cached login PATH injected by the
/// caller). Mirrors `claude_chat::build_claude_exec`: everything user-influenced is
/// single-quoted via `shell_quote`; `--model` is intentionally OMITTED so the session inherits
/// the user's configured Claude Code model; `--resume` continues the concierge's one ongoing
/// session when the frontend passes the id back.
fn build_concierge_exec(
    claude_path: &str,
    prompt: &str,
    resume_session_id: Option<&str>,
    // Path to the 0600 file holding the `mcpServers` JSON for this turn (see
    // `write_concierge_mcp_config`). None = no control surface; the concierge degrades to
    // observe-only rather than failing the turn.
    mcp_config_path: Option<&std::path::Path>,
    // The user's accumulated communication guidelines, already rendered as a delimited block by
    // `concierge_guidelines::injection_block` (empty string when the file is blank or absent-and-
    // -blank). Passed IN rather than read here so this stays a pure, testable string builder.
    guidelines_block: &str,
) -> String {
    let mut cmd = format!("exec {}", shell_quote(claude_path));
    cmd.push_str(" -p ");
    cmd.push_str(&shell_quote(prompt));
    cmd.push_str(" --output-format stream-json --verbose --include-partial-messages");
    cmd.push_str(" --append-system-prompt ");
    // ONE argument: Sparkle's persona, then the user's own guidelines file under its own heading.
    //
    // WHY EXPLICIT INJECTION AND NOT A `CLAUDE.md` IN THE CWD — this is the "simplification"
    // someone will propose, and it is a downgrade. The concierge's cwd IS the app-data dir, so a
    // `CLAUDE.md` dropped there WOULD be auto-discovered by Claude Code and would appear to work.
    // But then: the behaviour depends on the CLI's project-discovery rules (which are the CLI's to
    // change, not ours), nothing in this repo says the file is load-bearing, and none of it can be
    // unit-tested — the tests below, which prove the empty-file case injects no dangling heading
    // and that hostile content stays inside one quoted argument, would all have to become
    // integration tests against a real `claude`. Injecting it ourselves keeps the contract in our
    // code and under test. Do not "simplify" this to a dropped file.
    let mut system_prompt = String::from(CONCIERGE_PERSONA);
    system_prompt.push_str(guidelines_block);
    // Quoted as a SINGLE argument, which is what makes user-authored guidelines safe here: the file
    // is edited by hand and appended to by the model, so it is untrusted text reaching a command
    // line. `shell_quote` is applied to the whole concatenation, so quotes and metacharacters in it
    // cannot escape into the shell (proved by `build_exec_quotes_hostile_guidelines`).
    cmd.push_str(&shell_quote(&system_prompt));
    cmd.push_str(" --allowedTools ");
    cmd.push_str(&shell_quote(CONCIERGE_ALLOWED_TOOLS));
    if let Some(path) = mcp_config_path {
        // A PATH, never inline JSON: the config carries the concierge bridge token, and an
        // inline `--mcp-config {…}` puts that token in argv where any same-user process can
        // read it via `ps aux` (roborev 54164, finding 2 — the exact adversary named there is
        // "a worker with shell access"). The file is written 0600 by the caller.
        cmd.push_str(" --mcp-config ");
        cmd.push_str(&shell_quote(&path.to_string_lossy()));
        // Load ONLY our server: without this, the user's own ~/.claude.json MCP servers are
        // also loaded into the concierge, silently widening a surface we reason about as closed.
        cmd.push_str(" --strict-mcp-config");
    }
    if let Some(sid) = resume_session_id {
        if !sid.is_empty() {
            cmd.push_str(" --resume ");
            cmd.push_str(&shell_quote(sid));
        }
    }
    format!("export PATH=\"$HOME/.local/bin:$PATH\"; {cmd}")
}

/// Serialize the concierge's `mcpServers` map. Pure so the shape is unit-testable without an
/// AppHandle, a live bridge, or a filesystem.
///
/// Mirrors `claudeSpawn.ts`'s `controlMcpServers`, with TWO deliberate differences.
///
/// 1. No `SPARKLE_AGENT_ID`. An agent's control identity is a claimed env var the server stamps
///    onto each request; the concierge's is STRUCTURAL — the Rust listener stamps
///    `CONCIERGE_CALLER_AGENT_ID` on everything arriving on this socket, whatever the client sends.
///    Passing an id here would be inert at best and misleading at worst.
///
/// 2. `SPARKLE_CONTROL_NO_SELF=1`, which is the POSITIVE marker for "this caller has no agent row
///    of its own". The MCP server uses it to decide whether the per-agent tools may advertise a
///    self-default (`rename_agent` with no `targetAgentId` = "me"). It must be a marker rather than
///    an inference from `SPARKLE_AGENT_ID` being empty, because ABSENCE HERE DOES NOT MEAN ABSENCE
///    IN THE CHILD: this `env` map is merged onto the inherited environment, the concierge is
///    spawned through `Command::new(SHELL)` with the app's full environment, and Claude Code passes
///    its own environment through to stdio MCP children. Launch the app from an agent's PTY — the
///    repo's own dev workflow, where `claudeSpawn.ts` has already exported `SPARKLE_AGENT_ID` — and
///    the concierge's control child would inherit a non-empty id, conclude it was an agent, and go
///    back to promising a self-default the app refuses with `target_required`. (roborev 54546.)
fn concierge_mcp_config_json(
    node_path: &str,
    server_path: &str,
    socket_path: &str,
    token: &str,
) -> String {
    serde_json::json!({
        "mcpServers": {
            "sparkle-control": {
                "command": node_path,
                "args": [server_path],
                "env": {
                    "SPARKLE_CONTROL_SOCKET": socket_path,
                    "SPARKLE_CONTROL_TOKEN": token,
                    // Also blanks any INHERITED id, so the server sees an empty string even if the
                    // marker were ever dropped — belt and braces on the same fact.
                    "SPARKLE_AGENT_ID": "",
                    "SPARKLE_CONTROL_NO_SELF": "1",
                },
            }
        }
    })
    .to_string()
}

/// Write `json` to a 0600 file and return its path.
///
/// WHY A FILE, NOT ARGV: the JSON embeds the concierge bridge token, and possession of that token
/// grants the privileged control tier. `--mcp-config '{"..."}'` inline would place it in argv,
/// readable by any same-user process via `ps aux` — and "a worker with shell access" is precisely
/// the adversary the concierge socket's threat model names (roborev 54164, finding 2).
///
/// RESIDUAL EXPOSURE, stated honestly rather than papered over: 0600 stops *other users*, not the
/// same user. A process running as this user can still read the file, and the child's own env is
/// readable to it too. On macOS one user's processes are not isolated from each other, so this
/// narrows the window (no argv broadcast, no shell history) without making the token unforgeable.
/// Closing it properly needs peer verification at accept time (`LOCAL_PEERPID` against the pid we
/// spawned); that is tracked as follow-up, and until it lands the guarantee is "not casually
/// visible", NOT "unobtainable".
#[cfg(unix)]
fn write_concierge_mcp_config(
    dir: &std::path::Path,
    json: &str,
    // Unique per turn. A FIXED name would be shared and truncated by two overlapping turns — a
    // superseded turn's child may not have lazily spawned its MCP server yet, and would then read a
    // half-written file (roborev 54226, finding 4).
    turn_token: u64,
) -> Result<std::path::PathBuf, String> {
    use std::io::Write as _;

    std::fs::create_dir_all(dir).map_err(|e| format!("concierge mcp config dir: {e}"))?;
    let path = dir.join(format!("concierge-mcp-{turn_token}.json"));
    prune_stale_mcp_configs(dir, &path);

    // Create with 0600 FROM THE START via OpenOptions.mode — writing then chmod-ing would leave a
    // window in which the token sits in a world-readable file.
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        opts.mode(0o600);
    }
    let mut f = opts
        .open(&path)
        .map_err(|e| format!("concierge mcp config open: {e}"))?;
    f.write_all(json.as_bytes())
        .map_err(|e| format!("concierge mcp config write: {e}"))?;

    // An existing file keeps its old mode through OpenOptions, so re-assert it explicitly.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(path)
}

/// Delete concierge MCP configs left behind by earlier turns.
///
/// Each file holds a live-ish bridge token, so leaving them to accumulate turns a per-turn exposure
/// into an unbounded one that outlives the app session (roborev 54226, finding 4). The child reads
/// its config once at startup and we cannot observe that moment from here, so files are aged out
/// rather than unlinked immediately — a minute is far longer than the read takes and far shorter
/// than "forever".
///
/// Best-effort by design: a failure to prune must never fail a turn, so every error is swallowed.
///
/// TWO THINGS THIS GETS RIGHT, both learned the hard way (roborev 54255):
///
/// 1. The prefix is `concierge-mcp`, NOT `concierge-mcp-`. Earlier builds wrote a FIXED
///    `concierge-mcp.json` (no trailing hyphen). Matching only the hyphenated per-turn form would
///    have left the one token-bearing file this function exists to clean up sitting there forever
///    on every machine that ran a prior build.
///
/// 2. `MAX_AGE` is 30 minutes, not the 60 seconds it started as. This prune runs BEFORE the new
///    child is spawned and before the slot decides whether to install it, so anything it deletes
///    may still belong to a LIVE turn — and concierge turns routinely run longer than a minute. A
///    turn refused install (superseded) would prune, then kill only its own child, leaving an
///    older still-running turn with its config gone: precisely the read that would then fail,
///    silently degrading a live turn to observe-only. 30 minutes is far longer than any real turn
///    and still bounds the exposure to something finite. The file for THIS turn is skipped
///    outright, since we are about to write it.
#[cfg(unix)]
fn prune_stale_mcp_configs(dir: &std::path::Path, keep: &std::path::Path) {
    const MAX_AGE: std::time::Duration = std::time::Duration::from_secs(30 * 60);
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("concierge-mcp") || !name.ends_with(".json") {
            continue;
        }
        if entry.path() == keep {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|m| m.elapsed().map(|age| age > MAX_AGE).unwrap_or(false))
            .unwrap_or(false);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Resolve the concierge's control-MCP config for this turn: start (or reuse) the concierge
/// bridge, resolve node + the bundled server, write the 0600 config, hand back its path.
///
/// Returns `None` — never an error — when any piece is unavailable (node missing, server not
/// bundled, bridge won't bind). A concierge that can still SEE and ADVISE is far better than a
/// turn that fails outright, so a missing control surface degrades to the old observe-only
/// posture and logs why.
/// WINDOWS: there is no control surface to hand the concierge, so the turn runs observe-only.
///
/// The concierge's control bridge is a UNIX-DOMAIN SOCKET, and `lib.rs` already swaps the whole
/// `bridge` module for `bridge_windows.rs` on this target — a stub whose every entry point returns
/// "not yet supported on Windows (Phase-2 follow-up)". Referencing the Unix-only surface from this
/// file broke the Windows build (4 compile errors) while macOS stayed green, because nothing here
/// was platform-gated even though everything it calls is.
///
/// Degrading to `None` is the SAME path a missing node / unbundled server / unbindable socket
/// already takes, so the concierge still sees and advises; it simply cannot act. When the bridge
/// gains a Windows transport (named pipe or localhost TCP), delete this arm — the rest of the file
/// is already platform-agnostic.
#[cfg(not(unix))]
fn resolve_concierge_mcp_config(_app: &AppHandle, _turn_token: u64) -> Option<std::path::PathBuf> {
    tracing::info!("concierge control surface unavailable on this platform; observe-only turn");
    None
}

#[cfg(unix)]
fn resolve_concierge_mcp_config(app: &AppHandle, turn_token: u64) -> Option<std::path::PathBuf> {
    let manager = app.try_state::<crate::bridge::ControlBridgeManager>()?;
    let (sock, token) = match crate::bridge::start_concierge_control_bridge_at(
        Some(app.clone()),
        &manager,
    ) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(error = %e, "concierge control bridge unavailable; observe-only turn");
            return None;
        }
    };
    let paths = match crate::bridge::control_mcp_paths(app.clone()) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(error = %e, "concierge control MCP unavailable; observe-only turn");
            return None;
        }
    };
    let json = concierge_mcp_config_json(
        &paths.node_path,
        &paths.server_path,
        &sock.to_string_lossy(),
        &token,
    );
    let dir = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("concierge");
    match write_concierge_mcp_config(&dir, &json, turn_token) {
        Ok(p) => Some(p),
        Err(e) => {
            tracing::warn!(error = %e, "concierge mcp config not written; observe-only turn");
            None
        }
    }
}

/// Decide whether a FAILED turn should be retried once WITHOUT `--resume` (same self-heal as
/// `claude_chat.rs`): a stale `--resume <sid>` is the #1 real-world cause of a non-zero exit
/// with empty stderr, and the concierge resumes on EVERY turn after the first. Pure for tests.
fn should_retry_without_resume(ok: bool, resume_session_id: Option<&str>) -> bool {
    !ok && matches!(resume_session_id, Some(sid) if !sid.is_empty())
}

/// Build the `concierge:error` detail for a failed turn. Same priority order as
/// `claude_chat::build_error_message` / `sparkle_improve::failure_message` (both private to
/// their modules), so a failure reads the same wherever it surfaces:
///  1. the child's own stderr when non-empty;
///  2. claude's OWN error text lifted off the failed `result` event by `capture_result_status`
///     (a stale resume, a usage limit, an auth/API error, …);
///  3. a synthesized phrase from the exit code + any non-`"success"` subtype / `is_error` flag.
/// Pure so the precedence is unit-testable without spawning a real turn.
fn failure_detail(
    stderr: &str,
    exit_code: Option<i32>,
    result_subtype: Option<&str>,
    is_error: bool,
    error_detail: Option<&str>,
) -> String {
    let stderr = stderr.trim();
    if !stderr.is_empty() {
        return stderr.to_string();
    }
    if let Some(detail) = error_detail.map(str::trim).filter(|s| !s.is_empty()) {
        return detail.to_string();
    }
    let mut m = match exit_code {
        Some(code) => format!("claude exited (code {code}) with no output"),
        None => "claude exited (killed by signal) with no output".to_string(),
    };
    if let Some(st) = result_subtype {
        m.push_str(&format!("; result subtype '{st}'"));
    } else if is_error {
        m.push_str("; stream reported an error result");
    }
    m
}

/// Structured outcome of ONE headless `claude` run (stdout read to EOF, child reaped). `owned`
/// is false when the slot no longer held our token by EOF (superseded or cancelled): the
/// teardown was initiated elsewhere, so the caller must stay silent and not retry.
struct TurnOutcome {
    owned: bool,
    ok: bool,
    exit_code: Option<i32>,
    session_id: String,
    text: String,
    stderr: String,
    result_subtype: Option<String>,
    is_error: bool,
    error_detail: Option<String>,
    /// What this turn actually SENT — every `tool_use` block's name + full arguments. Empty on the
    /// un-owned path, mirroring `text`: a turn nobody is waiting on reports nothing.
    tool_calls: Vec<ToolUseRecord>,
}

/// Assemble the `Command` for one concierge turn — everything up to (but not including) `.spawn()`.
///
/// Split out of [`spawn_turn`] so the child's ENVIRONMENT is assertable without launching a real
/// `claude`: `Command::get_envs()` reports exactly what the child would receive. That is the only
/// way to test the account binding as a side effect rather than as an intention — the fix here is
/// precisely one `env` entry, and a test that checked the script string instead would have passed
/// against the broken code, since `CLAUDE_CONFIG_DIR` was never in the script either.
fn build_turn_command(script: &str, cwd: &std::path::Path, config_dir: Option<&str>) -> Command {
    let mut cmd = Command::new(SHELL);
    // NON-login shell: the login PATH is resolved once and injected (see
    // `cached_login_shell_path`), so no per-turn dotfile-sourcing latency.
    cmd.args(["-c", script]);
    cmd.env("PATH", cached_login_shell_path());
    // The chosen account, on the CHILD only. Without this the concierge inherited Sparkle's own
    // (usually absent) `CLAUDE_CONFIG_DIR` and so always ran as `$HOME/.claude`, which is why
    // authenticating a different account elsewhere never moved it off an exhausted login.
    crate::claude::apply_spawn_config_dir(&mut cmd, config_dir);
    cmd.current_dir(cwd);
    // No stdin: `-p` is one-shot, and a null stdin guarantees nothing can block on input.
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    // Own process group, so cancel/supersede can take out claude AND its children in one signal.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd
}

/// Spawn one concierge `claude` child and install it in the singleton slot under a fresh token,
/// superseding (killing, whole group) any in-flight turn — the concierge always answers the
/// LATEST snapshot; a reply to a stale one is noise. Returns the child's pipes + token. Never
/// logs the built script (it embeds the prompt, which carries app state).
fn spawn_turn(
    app: &AppHandle,
    prompt: &str,
    cwd: &std::path::Path,
    claude_path: &str,
    resume_session_id: Option<&str>,
    // The Claude account this turn runs under, as that account's `CLAUDE_CONFIG_DIR`. Chosen by the
    // frontend with the SAME `pickAccount` the build-agent spawn uses (services/accountSelection),
    // and applied to the child only. `None`/empty = no override — see `apply_spawn_config_dir`.
    config_dir: Option<&str>,
    // A user send, or the stale-resume retry continuing one — they install under different rules
    // (see may_install / continuation_install).
    kind: TurnKind,
    // Reserved by the CALLER before any of this work began (see reserve_turn_token) — minting it
    // here would mean the previous turn stays live until the new child finishes spawning.
    token: u64,
) -> Result<(std::process::ChildStdout, std::process::ChildStderr, u64), String> {
    let mcp_config = resolve_concierge_mcp_config(app, token);
    // EVERY TURN, by construction. Both entry points — the user's send (`concierge_turn`) and the
    // unprompted push (`concierge_proactive_turn`) — funnel through this one function, so reading
    // the guidelines here means neither path can drift out of step with the other. Read fresh each
    // turn rather than cached at startup, so a hand-edit to the file takes effect on the next turn
    // with no restart (the same live-edit property the config file has).
    let guidelines = crate::concierge_guidelines::injection_for_app(app);
    let script = build_concierge_exec(
        claude_path,
        prompt,
        resume_session_id,
        mcp_config.as_deref(),
        &guidelines,
    );
    tracing::info!(
        %claude_path, cwd = %cwd.display(),
        resume = resume_session_id.map(|s| !s.is_empty()).unwrap_or(false),
        control_surface = mcp_config.is_some(),
        // The account this turn runs under. Logged as a BOOLEAN, not the path: the dir name is
        // account-identifying, and the fact worth having in the log is whether the turn was pinned
        // to a chosen account at all — "false" here is the signature of the bug this threading
        // fixes (every turn silently on `$HOME/.claude`).
        account_pinned = crate::claude::spawn_env_config_dir(config_dir).is_some(),
        "concierge_turn spawn"
    );

    let mut cmd = build_turn_command(&script, cwd, config_dir);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("concierge_turn: spawn failed: {e}"))?;
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            // Never expected with Stdio::piped(), but the just-spawned child must not be left
            // running with no cancel handle.
            kill_turn_group(&mut child);
            return Err("concierge_turn: child has no stdout".into());
        }
    };
    let stderr = match child.stderr.take() {
        Some(s) => s,
        None => {
            kill_turn_group(&mut child);
            return Err("concierge_turn: child has no stderr".into());
        }
    };

    // Install CONDITIONALLY, under the same lock (roborev 53165). Two sends race on separate
    // spawn_blocking threads and the spawns can finish out of order, so an unconditional replace
    // lets an OLDER turn stomp the newer one's entry — killing the child the user is actually
    // waiting on. The floor already stops that turn from speaking; without this it could still take
    // the slot, leaving the live turn dead with no `done` and the typing indicator hung forever.
    //
    // Refuse when this turn is retired, or when the slot holds a turn `kind` says is not ours to
    // replace, and take our own just-spawned child down with us. That makes "who owns the slot"
    // agree with "who owns the floor" by construction — for the stale-resume retry too, which is
    // held to the stricter "any occupant wins" rule because its token predates that occupant by
    // construction (roborev 53397).
    // Held in an Option so the child can be moved into the slot under the lock, and is still ours
    // to kill if we refuse — a `slot.replace` in one branch would conditionally move it and leave
    // the refuse path with a running, unreferenced `claude`.
    let mut ours = Some(child);
    let superseded = {
        let manager = app.state::<ConciergeManager>();
        let mut slot = lock_turn(&manager.turn);
        let allowed = may_install(
            kind,
            token,
            RETIRE_BELOW.load(Ordering::Relaxed),
            slot.as_ref().map(|t| t.token),
            // Read UNDER THE LOCK, so "no send is preparing" and "the slot is free" are decided as
            // one fact. A push that checked them separately could see an empty slot, then have a
            // send enter its prep, then install — the very window PENDING_SENDS exists to close.
            sends_pending(),
        );
        // Total, not `expect` (roborev 53186): a panic here would fire while holding the turn
        // mutex, and `Child::drop` neither signals nor reaps — the failure mode of the assertion
        // would be exactly the orphaned process group this Option exists to prevent.
        match (allowed, ours.take()) {
            (true, Some(child)) => slot.replace(ConciergeTurn { child, token }),
            (_, kept) => {
                ours = kept;
                None
            }
        }
    };
    if let Some(mut orphan) = ours {
        // We never installed: the turn we just spawned is already superseded. Take it down rather
        // than leaving an unreferenced claude running with no cancel handle.
        tracing::info!(token, "concierge_turn: superseded before install; killing the new child");
        kill_turn_group(&mut orphan);
        return Err(SUPERSEDED_ERR.into());
    }
    if let Some(mut old) = superseded {
        tracing::info!("concierge_turn superseded an in-flight turn; killing the old child (group)");
        kill_turn_group(&mut old.child);
    }
    Ok((stdout, stderr, token))
}

/// Drain a child's stderr on its own thread so a full stderr pipe can't deadlock the child.
fn drain_stderr(stderr: std::process::ChildStderr) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut s = String::new();
        use std::io::Read;
        let _ = std::io::BufReader::new(stderr).read_to_string(&mut s);
        s
    })
}

/// Run one already-spawned turn to completion on the CURRENT thread: parse the NDJSON stdout to
/// EOF (emitting `concierge:delta` per text chunk via the shared `handle_event` parser), then —
/// ONLY if the slot still holds OUR token — reap the child and return the outcome. Factored out
/// of `concierge_turn` so the stale-resume retry can run it a second time.
///
/// THE DELTA EMIT IS GATED TOO (roborev 53088/53105), not just the reap. It used to be
/// unconditional, so a superseded reader kept flushing whatever stdout it had already buffered
/// under its own id, interleaved with the turn that replaced it — and the frontend cannot sort
/// that out after the fact, because those deltas are emitted before `concierge_turn` returns and
/// Tauri gives no ordering guarantee between events and an invoke response. The gate is
/// `still_owns_turn`, which answers "does the user still want this?" from two facts: the
/// send-time retirement floor (RETIRE_BELOW — set BEFORE the replacement child is spawned, which
/// is the window a slot-only check misses) and the slot itself.
fn run_reader(
    app: &AppHandle,
    id: &str,
    token: u64,
    stdout: std::process::ChildStdout,
    stderr_handle: std::thread::JoinHandle<String>,
) -> TurnOutcome {
    drain_turn(app, id, stdout, stderr_handle, token, &|| still_owns_turn(app, token))
}

/// What one turn's stdout yielded, minus anything that needs an app handle.
struct DrainedStream {
    session_id: String,
    final_text: String,
    /// The streamed chunks, concatenated — the fallback text when no `result` carried a final.
    acc: String,
    result_subtype: Option<String>,
    is_error: bool,
    error_detail: Option<String>,
    /// The turn's `tool_use` payloads, in the order the stream carried them (see
    /// `claude_chat::capture_tool_uses`). Captured from the SAME parse the deltas come from, so it
    /// is turn-correlated by construction — no id to match up, no second store to keep in step.
    tool_calls: Vec<ToolUseRecord>,
}

/// Parse a turn's NDJSON stdout to EOF, emitting each text chunk through `emit` — but ONLY while
/// `owns` says this turn is still the one the user is waiting on.
///
/// No AppHandle, so the gate is drivable in a test against the REAL loop (roborev 53105): the
/// previous test declared its own `false` and asserted that `if false {}` skips, which would have
/// stayed green with the production gate deleted.
///
/// The gate is checked once per LINE and LATCHED. Ownership is one-way — a superseded turn never
/// becomes live again — so after the first `false` there is nothing to re-ask, and the check is
/// per line rather than per chunk because `--include-partial-messages` makes a chunk roughly a
/// token while the check contends with the UI thread for the manager's mutex on every send.
/// Parsing continues either way, so `session_id`/`final_text` stay coherent for the caller's
/// ownership check.
///
/// `emit_tool` rides the SAME gate as `emit`, for the same reason: a `concierge:tool` for a turn
/// the user already replaced would paint the column with a status line belonging to a dead turn —
/// the tool-call analogue of the orphan bubble the delta gate exists to prevent.
fn drain_stream(
    stdout: impl std::io::Read,
    owns: &dyn Fn() -> bool,
    retired: &dyn Fn() -> bool,
    emit: &mut dyn FnMut(&str),
    emit_tool: &mut dyn FnMut(&str, &str),
) -> DrainedStream {
    use std::io::BufRead;
    let mut reader = std::io::BufReader::new(stdout);
    let mut session_id = String::new();
    let mut final_text = String::new();
    let mut acc = String::new();
    let mut result_subtype: Option<String> = None;
    let mut is_error = false;
    let mut error_detail: Option<String> = None;
    let mut tool_calls: Vec<ToolUseRecord> = Vec::new();
    let mut line: Vec<u8> = Vec::new();
    let mut live = true;
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) => break, // EOF
            Ok(_) => {
                let text = String::from_utf8_lossy(&line);
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if live {
                    live = owns();
                }
                if let Ok(ev) = serde_json::from_str::<Value>(trimmed) {
                    handle_event(&ev, &mut session_id, &mut final_text, &mut acc, &mut |txt| {
                        // Two checks, deliberately: the per-line one above takes the manager's
                        // mutex and is hoisted out of the hot path, while this one is a relaxed
                        // atomic load — cheap enough to run per chunk, and it closes the window in
                        // which a send lands DURING this line's JSON parse (roborev 53130). One
                        // admitted chunk is the whole failure mode: a delta for a never-before-seen
                        // id paints a bubble that then never receives a terminal event.
                        if !live || retired() {
                            return;
                        }
                        emit(txt);
                    });
                    capture_result_status(&ev, &mut result_subtype, &mut is_error, &mut error_detail);
                    // What this turn SENT, alongside what it said. Captured UNGATED, exactly like
                    // the parse above and for the same reason: the gate governs EMISSION — what a
                    // superseded turn is allowed to say to the user — not bookkeeping. Nothing here
                    // emits, calls back, or touches the manager's mutex, so it cannot change when or
                    // whether a delta goes out. A turn that loses ownership discards these at the
                    // reap (the `owned: false` outcome carries an empty vec), so the records only
                    // ever reach the frontend attached to the reply they belong to.
                    //
                    // The LIVE emit hanging off this same traversal IS gated, and by the same two
                    // checks the delta emit uses above — the hoisted per-line `live` and the
                    // per-chunk `retired()` — because it is an emission, not bookkeeping. Both are
                    // load-bearing here for exactly the reasons stated above (roborev 53130): a
                    // superseded turn must not narrate itself into the live turn's column.
                    //
                    // One traversal, two consumers: `capture_tool_uses_with` walks the blocks once
                    // and drives both, so the live status line can never disagree with the record
                    // the `done` payload carries about what this turn called.
                    capture_tool_uses_with(&ev, &mut tool_calls, &mut |name, input| {
                        if !live || retired() {
                            return;
                        }
                        // EMITTED HERE, IN STREAM POSITION — never collected and flushed after the
                        // loop. Buffering is the whole bug this feature exists to fix: holding the
                        // tool calls until EOF is exactly what `concierge:done` already did, and it
                        // delivers every status line at the one moment there is no longer anything
                        // to report. The interleaving test asserts each tool event's position
                        // RELATIVE to the deltas around it precisely because a count-based
                        // assertion passes against the batched version.
                        emit_tool(name, &clamp_live_tool_input(input.to_string()));
                    });
                } else {
                    tracing::debug!("concierge: skipped non-JSON stdout line");
                }
            }
            Err(_) => break,
        }
    }
    DrainedStream { session_id, final_text, acc, result_subtype, is_error, error_detail, tool_calls }
}

/// The drain loop, with the ownership gate INJECTED so it can be driven in a test — the previous
/// version's test asserted a locally-declared `false` and would have stayed green with the gate
/// deleted, which is the one regression it existed to prevent (roborev 53105).
fn drain_turn(
    app: &AppHandle,
    id: &str,
    stdout: impl std::io::Read,
    stderr_handle: std::thread::JoinHandle<String>,
    token: u64,
    owns: &dyn Fn() -> bool,
) -> TurnOutcome {
    let drained = drain_stream(
        stdout,
        owns,
        &|| is_retired(token, RETIRE_BELOW.load(Ordering::Relaxed)),
        &mut |txt| {
            let _ = app.emit(
                "concierge:delta",
                ConciergeDelta { id: id.to_string(), text: txt.to_string() },
            );
        },
        // LIVE, once per tool call, under the same turn id as the deltas around it. Every caller of
        // `drain_turn` gets this — the user send AND the proactive push, which share this transport
        // on purpose (see `concierge_proactive_turn`): whatever the delta does, the tool event does.
        &mut |name, input| {
            let _ = app.emit(
                "concierge:tool",
                ConciergeToolEvent {
                    id: id.to_string(),
                    name: name.to_string(),
                    input: input.to_string(),
                },
            );
        },
    );
    let DrainedStream {
        session_id,
        final_text,
        acc,
        result_subtype,
        is_error,
        error_detail,
        tool_calls,
    } = drained;

    // Reap — but only if the slot still holds OUR turn (token match). A cancel or a newer turn
    // took the slot first (and killed/reaped the child); the frontend initiated that teardown,
    // so we stay silent and leave the live turn's entry untouched.
    let child = {
        let manager = app.state::<ConciergeManager>();
        let mut slot = lock_turn(&manager.turn);
        match slot.as_ref() {
            Some(t) if t.token == token => slot.take().map(|t| t.child),
            _ => None,
        }
    };
    let Some(mut child) = child else {
        let _ = stderr_handle.join();
        return TurnOutcome {
            owned: false,
            ok: false,
            exit_code: None,
            session_id,
            text: String::new(),
            stderr: String::new(),
            result_subtype,
            is_error,
            error_detail,
            // Nobody is waiting on this turn: it emits no `done`, so it reports no calls either.
            tool_calls: Vec::new(),
        };
    };
    let status = child.wait();
    let ok = matches!(&status, Ok(s) if s.success());
    let exit_code = status.ok().and_then(|s| s.code());
    // Prefer the clean final `result` text; fall back to the accumulated deltas.
    let text = if !final_text.is_empty() { final_text } else { acc };
    let stderr = stderr_handle.join().unwrap_or_default();
    TurnOutcome {
        owned: true,
        ok,
        exit_code,
        session_id,
        text,
        stderr,
        result_subtype,
        is_error,
        error_detail,
        tool_calls,
    }
}

/// Emit the terminal event for a decided (owned) turn: `concierge:done` on success or
/// `concierge:error` (with a specific detail) on failure.
///
/// `elapsed` is the wall time since the child was spawned — see the `info!` below for why it is
/// logged on BOTH arms.
fn emit_outcome(app: &AppHandle, id: &str, outcome: TurnOutcome, elapsed: std::time::Duration) {
    let elapsed_ms = elapsed.as_millis();
    if outcome.ok {
        if outcome.text.trim().is_empty() {
            tracing::debug!(id = %id, "concierge: successful turn produced no assistant text");
        }
        // HOW LONG A TURN ACTUALLY TAKES — the one thing these logs could not answer.
        //
        // The success path used to log NOTHING, so of 378 turns on 2026-07-29 only the 15 that
        // FAILED left any terminal line at all. Turn duration had to be reconstructed by censoring
        // on the supersede marker (a turn was still running iff the next spawn logged one), which
        // yields a distribution but no individual timings — and the liveness thresholds in
        // engine/conciergeLiveness are set from exactly that number. One line per turn means the
        // next person to argue about those thresholds can measure instead of infer.
        //
        // No prompt and no reply text, only the duration and the id: the built script embeds the
        // prompt and is never logged, and that rule is not relaxed here.
        tracing::info!(id = %id, elapsed_ms, "concierge turn ok");
        let _ = app.emit(
            "concierge:done",
            ConciergeDone {
                id: id.to_string(),
                session_id: outcome.session_id,
                text: outcome.text,
                tool_calls: outcome.tool_calls,
            },
        );
    } else {
        let detail = failure_detail(
            &outcome.stderr,
            outcome.exit_code,
            outcome.result_subtype.as_deref(),
            outcome.is_error,
            outcome.error_detail.as_deref(),
        );
        // The detail is claude's error reason / exit code — no prompt, no secret — safe to log
        // (the built script, which embeds the prompt, is never logged).
        tracing::warn!(id = %id, exit_code = ?outcome.exit_code, elapsed_ms, "concierge turn failed: {detail}");
        let _ = app.emit("concierge:error", ConciergeError { id: id.to_string(), detail });
    }
}

/// Run one concierge turn: the user's own headless `claude` over the snapshot in `prompt`,
/// continuing the concierge session when `resume_session_id` is passed. Returns immediately;
/// the child and its reader run on background threads. Streams arrive as Tauri events keyed by
/// the turn's `id` (the monotonic turn token as a string): `concierge:delta { id, text }`,
/// `concierge:tool { id, name, input }` once per tool call as it is parsed (the live status line —
/// see `ConciergeToolEvent`), `concierge:done { id, sessionId, text, toolCalls }` on success (keep
/// `sessionId` and pass it back as `resume_session_id` next turn), `concierge:error { id, detail }`
/// on failure.
///
/// A new turn SUPERSEDES an in-flight one (killed, whole group) — the concierge always answers
/// the latest snapshot. Stale-session self-heal: a failed turn that carried a resume id is
/// re-run ONCE without `--resume` (fresh session), mirroring `claude_chat_send`.
///
/// `async` + `spawn_blocking` (same as `claude_chat_send`): the spawn and — critically — the
/// kill+wait of a superseded child run OFF the Tauri main thread, so a rapid re-send can't
/// freeze the UI.
///
/// RETURNS the turn's id (the monotonic token as a string) — the same id every `concierge:*` event
/// for this turn carries, so the frontend can correlate a delta with its own done/error.
///
/// It is NOT the straggler guard (roborev 53105). It cannot be: an invoke response has no ordering
/// guarantee against the event channel, so it can lose to deltas already in flight. Retirement is
/// enforced at the source instead, by `reserve_turn_token()` below — the floor is this sender's
/// OWN token, published after the cheap fallible prep and before the spawn, so every earlier turn
/// is retired before the replacement child exists and `drain_stream`'s gate sees it. (Not
/// `retire_issued_turns`, which is the cancel path; and not "the instant the user sends" — the
/// prep runs first, deliberately, so a send that fails before spawning cannot silence a turn it
/// never replaced. roborev 53165.) The id is defence in depth on top.
#[tauri::command]
pub async fn concierge_turn(
    app: AppHandle,
    prompt: String,
    resume_session_id: Option<String>,
    // The chosen account's `CLAUDE_CONFIG_DIR` (Tauri maps JS `configDir` → this `config_dir`).
    // The frontend resolves it with the same `pickAccount` the build-agent spawn uses, so one
    // account selection now covers build agents, Improve Sparkle AND the concierge. Optional so an
    // older frontend — or a build with no accounts configured — still spawns exactly as before.
    config_dir: Option<String>,
) -> Result<String, String> {
    if prompt.trim().is_empty() {
        return Err("concierge_turn: prompt must be non-empty".into());
    }
    // "A user send is preparing" — visible to the proactive push channel for the whole of this
    // command, including every early return (see PENDING_SENDS). Held until this function returns,
    // by which point the send has either taken the slot (where the slot check covers it) or failed.
    let _send_in_flight = SendInFlight::enter();
    // Read BEFORE the prep below; re-read after it. A cancel in between is aimed at this send.
    let cancel_epoch = CANCEL_EPOCH.load(Ordering::Relaxed);
    let claude_path = cached_claude_path()
        .ok_or_else(|| "concierge_turn: claude binary not found (is Claude Code installed?)".to_string())?;
    // The concierge runs in the app-data dir — NOT a repo worktree (it observes; it doesn't own
    // a checkout). The dir is created by the app at startup, but ensure it exists so a fresh
    // install can't fail the spawn on a missing cwd.
    let cwd = crate::dev_identity::app_data_dir(&app).map_err(|e| format!("concierge_turn: {e}"))?;
    std::fs::create_dir_all(&cwd).map_err(|e| format!("concierge_turn: app data dir unavailable: {e}"))?;

    // Reserve + retire HERE: after the fallible prep, immediately before the spawn.
    //
    // Not at the top of the command (roborev 53130): the path lookup, the app-data dir and
    // `create_dir_all` can all fail, and retirement is not rolled back — so a send that never
    // spawned would leave the previous turn permanently silenced but still RUNNING (nothing killed
    // it, since `spawn_turn` never ran), burning a claude process while its reply stopped
    // mid-sentence and the typing indicator hung for the session. Those steps are cheap; the
    // process spawn below is the window that actually matters, and it is still fully covered.
    // Reserve FIRST, then check (roborev 53181). Checking first leaves a gap exactly one
    // instruction wide: cancel can bump the epoch after our read and floor at `TURN_SEQ` before
    // our `fetch_add`, so the floor lands ON the token we then take, `is_retired` is false, the
    // slot is empty so cancel killed nothing — and the turn spawns as if Escape was never pressed.
    // With the reservation first, every cancel falls on one side by construction: it either bumps
    // the epoch before our read (refused here) or loads TURN_SEQ after our fetch_add, flooring
    // above us so the install guard refuses.
    let token = reserve_turn_token();
    if cancelled_during_prep(cancel_epoch) {
        tracing::info!("concierge_turn: cancelled before spawn; not starting the turn");
        // The floor has risen by now, so the previous turn is retired: same teardown as any other
        // post-reservation failure, and same rule — only a turn older than ours.
        let ours_to_kill = {
            let manager = app.state::<ConciergeManager>();
            let mut slot = lock_turn(&manager.turn);
            if mine_to_tear_down(token, slot.as_ref().map(|t| t.token)) {
                slot.take()
            } else {
                None
            }
        };
        if let Some(mut turn) = ours_to_kill {
            kill_turn_group(&mut turn.child);
        }
        return Err(CANCELLED_ERR.into());
    }
    let blk_app = app.clone();
    let blk_prompt = prompt.clone();
    let blk_resume = resume_session_id.clone();
    let blk_cwd = cwd.clone();
    let blk_claude = claude_path.clone();
    let blk_config_dir = config_dir.clone();
    let spawned = tauri::async_runtime::spawn_blocking(move || {
        spawn_turn(
            &blk_app,
            &blk_prompt,
            &blk_cwd,
            &blk_claude,
            blk_resume.as_deref(),
            blk_config_dir.as_deref(),
            TurnKind::Send,
            token,
        )
    })
    .await
    .map_err(|e| format!("concierge_turn task failed: {e}"))
    .and_then(|r| r);
    // ANY failure after the floor was published (the spawn itself, a missing pipe, a join error)
    // leaves the previous turn retired — muted by the gate — but still RUNNING, because
    // `slot.replace` never happened: a claude process burning on, its reply stopped mid-sentence,
    // and its `done` dropped by the frontend's own send-time floor, so the typing indicator hangs
    // for the session (roborev 53165). A `fetch_max` floor cannot be rolled back, so teardown is
    // the only coherent direction: make "the previous turn is dead" true.
    let (stdout, stderr, token) = match spawned {
        Ok(v) => v,
        Err(e) => {
            // ONLY a turn strictly older than ours (roborev 53186). "Take whatever is in the slot"
            // kills the LIVE turn on the most likely path into here: A refuses to install because
            // B already owns the floor and the slot, and then this teardown pulls B out and kills
            // it — the newest question dying unanswered with no terminal event, which is the whole
            // failure this guard exists to prevent. A newer occupant is not ours to clean up: it
            // owns both the floor and the slot, so there is nothing of ours left behind.
            let ours_to_kill = {
                let manager = app.state::<ConciergeManager>();
                let mut slot = lock_turn(&manager.turn);
                if mine_to_tear_down(token, slot.as_ref().map(|t| t.token)) {
                    slot.take()
                } else {
                    None
                }
            };
            if let Some(mut turn) = ours_to_kill {
                tracing::info!(
                    "concierge_turn failed after retiring the previous turn; killing it rather \
                     than leaving it silenced and running"
                );
                kill_turn_group(&mut turn.child);
            }
            return Err(e);
        }
    };

    let started_id = token.to_string();
    let read_app = app.clone();
    // The clock the `elapsed_ms` fields report against. Taken here rather than inside the thread so
    // it covers the spawn itself, which is part of what the user waits for — and a RETRY is
    // deliberately measured from this same point, because the wait it reports is the one the human
    // actually sat through, not the second attempt's alone.
    let started_at = std::time::Instant::now();
    std::thread::spawn(move || {
        let id = token.to_string();
        let stderr_handle = drain_stderr(stderr);
        let outcome = run_reader(&read_app, &id, token, stdout, stderr_handle);
        // Superseded / cancelled mid-turn: the frontend already tore down. Stay silent, no retry.
        if !outcome.owned {
            return;
        }

        // A retry is a self-heal for a turn the user is still waiting on. If they have moved on,
        // it must not run at all: `spawn_turn` would take the slot from — and kill — the live turn
        // (roborev 53147). The reap above consults the slot only, so `owned` can still be true here
        // for a turn the floor has already retired.
        //
        // The floor is tested against OUR OWN token, and that is now the whole of it (roborev
        // 53397): the retry runs under this turn's token rather than a fresh one, so there is no
        // second, higher token to reason about and no reserve-versus-read gap to order. Whatever
        // the floor says here, the install site is the backstop — see `continuation_install`.
        let retired = is_retired(token, RETIRE_BELOW.load(Ordering::Relaxed));
        if retired {
            tracing::info!(id = %id, "concierge: turn was superseded; not retrying the stale resume");
        }
        if !retired && should_retry_without_resume(outcome.ok, resume_session_id.as_deref()) {
            tracing::info!(
                id = %id,
                "concierge_turn: turn failed with a resume session id; retrying once without --resume"
            );
            let (kind2, token2) = continuation_install(token);
            // SAME account as the attempt that failed. The retry exists to drop a `--resume` the
            // config dir no longer holds, and switching accounts is now one of the ways that
            // happens: the session id belongs to the PREVIOUS account's transcript tree, so the
            // first attempt fails and this retry starts a fresh session — which must be created
            // under the account the user is actually on, not under whatever the child would
            // inherit. Passing `config_dir` here is what makes an account switch self-heal into a
            // fresh concierge conversation on the new account instead of a dead turn.
            match spawn_turn(
                &read_app,
                &prompt,
                &cwd,
                &claude_path,
                None,
                config_dir.as_deref(),
                kind2,
                token2,
            ) {
                Ok((stdout2, stderr2, installed)) => {
                    let stderr_handle2 = drain_stderr(stderr2);
                    // Emit the retry under the ORIGINAL `id`: the self-heal is a transparent
                    // continuation of the same logical turn, so the original id always receives a
                    // terminal event (no bubble left permanently in-progress if the first run
                    // streamed a delta before failing), and the `done` carries the full final text.
                    // The ownership token is the same one — id and token now agree, which is the
                    // point of `continuation_install`.
                    let retry = run_reader(&read_app, &id, installed, stdout2, stderr_handle2);
                    if !retry.owned {
                        return;
                    }
                    emit_outcome(&read_app, &id, retry, started_at.elapsed());
                }
                Err(e) => {
                    // REFUSED at the install site, rather than broken: stay silent, exactly as the
                    // reader does for `!outcome.owned` (roborev 53460). The stricter continuation
                    // rule makes this outcome newly reachable, and emitting here re-opens roborev
                    // 53186 from the other side: a `concierge:error` for a turn the user has moved
                    // past, carrying the internal sentinel as its detail. The frontend silences that
                    // sentinel only in `startConciergeTurn`'s invoke-rejection catch — an error
                    // EVENT with the same detail is not filtered — and its one remaining defence,
                    // `supersededTurn`, does not cover this id: the send-time floor only retires ids
                    // an event has been SEEN for, and a turn that failed before streaming anything
                    // has none, so the id rides on the newer send's invoke response, which an event
                    // can beat. The visible result would be "I couldn't reach my brain just now"
                    // plus a setTyping(false) over the turn that IS streaming.
                    if refused_retry_stays_silent(&e, token, RETIRE_BELOW.load(Ordering::Relaxed)) {
                        tracing::info!(
                            id = %id,
                            "concierge: the retry was refused; a newer turn owns the conversation"
                        );
                        return;
                    }
                    // Genuinely couldn't spawn the retry (no fork, no pipe) and the user is still
                    // waiting: surface the original failure, folding the spawn error in only when
                    // the first run gave us nothing better to show.
                    let mut original = outcome;
                    if original.stderr.trim().is_empty() && original.error_detail.is_none() {
                        original.stderr = e;
                    }
                    emit_outcome(&read_app, &id, original, started_at.elapsed());
                }
            }
        } else {
            emit_outcome(&read_app, &id, outcome, started_at.elapsed());
        }
    });

    Ok(started_id)
}

/// Run one PROACTIVE turn: the brain authors a thread message the user did not ask for.
///
/// This is the push path PRD §2a records as the blocking gap — "the brain has no channel to author
/// a proactive thread message" — so aggregation could not belong to the brain as written. The
/// trigger and the rate limiting live on the frontend (`services/conciergeProactive.ts`, which fires
/// only on a CHANGE in a small digest of significant state, debounced, floored by a minimum interval
/// and capped per hour); this command is the transport.
///
/// SAME TRANSPORT, deliberately. It emits `concierge:delta` / `concierge:done` / `concierge:error`
/// under the same monotonic turn token as a send, so the frontend correlates a push exactly as it
/// correlates a reply, and there is no second event channel to keep in step.
///
/// PRECEDENCE — THE USER'S OWN MESSAGE ALWAYS WINS, in three places:
///
///  1. It publishes no retirement floor (`reserve_proactive_token`), so it can never silence a turn
///     the user is waiting on.
///  2. It refuses to start, and refuses to install, while ANY turn holds the slot or any send is
///     merely preparing (`proactive_may_start` / `may_install`). Both facts, and the second is read
///     under the slot lock.
///  3. A send that arrives afterwards takes a strictly higher token, so it retires this push at the
///     floor and supersedes it at the install site — the push's reader then finds the slot changed
///     and stays silent, exactly like any superseded turn.
///
/// It also does NOT retry a stale `--resume` (unlike a send). A push is speculative; re-spawning it
/// would double its cost to rescue a message nobody asked for. The next USER turn self-heals the
/// session through the existing path.
#[tauri::command]
pub async fn concierge_proactive_turn(
    app: AppHandle,
    prompt: String,
    resume_session_id: Option<String>,
    // Same account binding as a user send — a push costs the same subscription. See `concierge_turn`.
    config_dir: Option<String>,
) -> Result<String, String> {
    if prompt.trim().is_empty() {
        return Err("concierge_proactive_turn: prompt must be non-empty".into());
    }
    // The cheap pre-check: don't spend a path lookup and a process spawn on a turn we are about to
    // refuse. The install site re-checks under the lock — that is where the race is decided.
    let slot_occupied = {
        let manager = app.state::<ConciergeManager>();
        let occupied = lock_turn(&manager.turn).is_some();
        occupied
    };
    if !proactive_may_start(sends_pending(), slot_occupied) {
        tracing::debug!("concierge_proactive_turn: declined; the user owns the conversation");
        return Err(PROACTIVE_DECLINED_ERR.into());
    }
    let claude_path = cached_claude_path().ok_or_else(|| {
        "concierge_proactive_turn: claude binary not found (is Claude Code installed?)".to_string()
    })?;
    let cwd = crate::dev_identity::app_data_dir(&app)
        .map_err(|e| format!("concierge_proactive_turn: {e}"))?;
    std::fs::create_dir_all(&cwd)
        .map_err(|e| format!("concierge_proactive_turn: app data dir unavailable: {e}"))?;

    // A token, but NO floor — see reserve_proactive_token.
    let token = reserve_proactive_token();
    let blk_app = app.clone();
    let blk_prompt = prompt;
    let blk_resume = resume_session_id;
    let blk_config_dir = config_dir;
    let spawned = tauri::async_runtime::spawn_blocking(move || {
        spawn_turn(
            &blk_app,
            &blk_prompt,
            &cwd,
            &claude_path,
            blk_resume.as_deref(),
            blk_config_dir.as_deref(),
            TurnKind::Proactive,
            token,
        )
    })
    .await
    .map_err(|e| format!("concierge_proactive_turn task failed: {e}"))
    .and_then(|r| r);

    // NO TEARDOWN on failure, and that is the point of the asymmetry with `concierge_turn`. That
    // path kills the previous turn because its own floor already silenced it, so leaving it running
    // would burn a claude process nobody can hear. A push retires nothing, so there is never
    // anything of ours left behind — and "take whatever is in the slot" here would be the push
    // killing the user's live turn, the one thing this channel must never do.
    let (stdout, stderr, token) = match spawned {
        Ok(v) => v,
        // `spawn_turn` reports a refused install as SUPERSEDED_ERR; for a push that is not a
        // supersession at all, it is the stand-down. Report it as such so the log and the frontend
        // read the same story (both strings are silenced on the frontend either way).
        Err(e) if e == SUPERSEDED_ERR => return Err(PROACTIVE_DECLINED_ERR.into()),
        Err(e) => return Err(e),
    };

    let total = count_proactive_turn();
    // The COST METER. One line per push, no prompt in it (the prompt carries app state, and the
    // built script is never logged) — enough to answer "how many turns did the concierge take on
    // its own initiative today?" without instrumenting anything else.
    tracing::info!(token, total, "concierge proactive turn spawned");

    let started_id = token.to_string();
    let read_app = app.clone();
    let started_at = std::time::Instant::now();
    std::thread::spawn(move || {
        let id = token.to_string();
        let stderr_handle = drain_stderr(stderr);
        let outcome = run_reader(&read_app, &id, token, stdout, stderr_handle);
        // Superseded by the user, or cancelled: stay silent. No retry — see the doc above.
        if !outcome.owned {
            return;
        }
        emit_outcome(&read_app, &id, outcome, started_at.elapsed());
    });

    Ok(started_id)
}

/// Cancel the in-flight concierge turn — the whole process group, so nothing it spawned keeps
/// running. A no-op if none is in flight. The reader thread finds the slot token changed (entry
/// gone) on EOF and stays silent, so no late done/error races the cancel.
#[tauri::command]
pub fn concierge_cancel(manager: State<ConciergeManager>) -> Result<(), String> {
    // Same floor as a send: a cancelled turn must go quiet immediately, not merely lose the slot.
    retire_issued_turns();
    let turn = lock_turn(&manager.turn).take();
    if let Some(mut turn) = turn {
        tracing::info!("concierge_cancel: killing in-flight turn (group)");
        kill_turn_group(&mut turn.child);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `build_concierge_exec` with no guidelines block — the shape every pre-existing test asserted
    /// before the guidelines file existed. A helper rather than a repeated `""` so the tests below
    /// keep reading as statements about the flags, not about this feature.
    fn exec(
        claude_path: &str,
        prompt: &str,
        resume: Option<&str>,
        mcp: Option<&std::path::Path>,
    ) -> String {
        build_concierge_exec(claude_path, prompt, resume, mcp, "")
    }

    #[test]
    fn build_exec_is_streamed_and_has_no_shell_escape_hatch() {
        let script = exec("/usr/local/bin/claude", "snapshot", None, None);
        assert!(script.contains("export PATH=\"$HOME/.local/bin:$PATH\";"));
        assert!(script.contains("exec '/usr/local/bin/claude'"));
        assert!(script.contains("-p 'snapshot'"));
        assert!(script.contains("--output-format stream-json --verbose --include-partial-messages"));
        // The persona rides along on every turn.
        assert!(script.contains("--append-system-prompt "));
        assert!(script.contains("cross-project concierge"));
        // The concierge acts through MCP, never by shelling out: no Bash/Edit/Write on the
        // BUILT-IN list, and no permission-skip. NB this allowlist does not gate MCP tools at
        // all (see CONCIERGE_ALLOWED_TOOLS) — the real gate is controlListener.dispatch.
        assert!(!script.contains("--dangerously-skip-permissions"));
        for tool in ["Bash", "Edit", "Write", "NotebookEdit"] {
            assert!(
                !CONCIERGE_ALLOWED_TOOLS.split(',').any(|t| t == tool),
                "mutating built-in tool {tool} must not be allowlisted"
            );
        }
        // Inherit the user's configured model; fresh session when no resume id.
        assert!(!script.contains("--model"));
        assert!(!script.contains("--resume"));
        // No control surface passed => no --mcp-config at all (observe-only degradation).
        assert!(!script.contains("--mcp-config"));
        assert!(!script.contains("--strict-mcp-config"));
    }

    #[test]
    fn build_exec_passes_the_mcp_config_as_a_path_never_inline_json() {
        let p = std::path::Path::new("/tmp/sparkle/concierge/concierge-mcp.json");
        let script = exec("/bin/claude", "hi", None, Some(p));
        assert!(script.contains("--mcp-config '/tmp/sparkle/concierge/concierge-mcp.json'"));
        // Only our server is loaded — the user's own MCP servers must not ride along.
        assert!(script.contains("--strict-mcp-config"));
        // The bridge TOKEN must never reach argv: no inline JSON on the command line.
        assert!(!script.contains("mcpServers"));
        assert!(!script.contains("SPARKLE_CONTROL_TOKEN"));
    }

    #[test]
    fn build_exec_appends_resume_when_session_id_present() {
        let script = exec("/bin/claude", "hi", Some("sess-42"), None);
        assert!(script.contains("--resume 'sess-42'"));
        // An empty session id is treated as no resume (fresh turn).
        let none = exec("/bin/claude", "hi", Some(""), None);
        assert!(!none.contains("--resume"));
    }

    #[test]
    fn build_exec_quotes_a_hostile_prompt() {
        // A snapshot that tries to close the quote and inject a command stays a single quoted
        // argument — the injected text can't escape into the shell.
        let script = exec("/bin/claude", "'; rm -rf /; echo '", None, None);
        assert!(script.contains(r"-p ''\''; rm -rf /; echo '\'''"));
    }

    #[test]
    fn build_exec_quotes_a_hostile_mcp_config_path() {
        // The path is app-derived, not user-supplied — but it is still quoted, so a directory
        // name containing a quote can't break out of the argument.
        let p = std::path::Path::new("/tmp/a'; rm -rf /; echo '/concierge-mcp.json");
        let script = exec("/bin/claude", "hi", None, Some(p));
        assert!(script.contains(r"--mcp-config '/tmp/a'\''; rm -rf /; echo '\''/concierge-mcp.json'"));
    }

    #[test]
    fn build_exec_injects_the_guidelines_after_the_persona() {
        // The user's rules must reach the model, and must arrive AFTER Sparkle's own persona —
        // later text is what the model treats as the more specific instruction, and these rules
        // exist precisely to override the house default.
        let block = "\n\n--- THE USER'S OWN COMMUNICATION GUIDELINES ---\n- Lead with what needs me.";
        let script = build_concierge_exec("/bin/claude", "hi", None, None, block);
        assert!(script.contains("Lead with what needs me."));
        let persona_at = script.find("You CAN ACT").expect("persona is in the script");
        let rules_at = script.find("Lead with what needs me.").expect("guidelines are in the script");
        assert!(persona_at < rules_at, "guidelines must follow the persona, not precede it");
        // ONE argument: nothing may sit between the persona and the rules except the block itself.
        assert!(script[persona_at..rules_at].find("--allowedTools").is_none());
    }

    #[test]
    fn build_exec_injects_nothing_extra_for_an_empty_guidelines_block() {
        // A user who empties the file gets the stock concierge back — not a dangling "here are the
        // user's rules" heading with nothing under it, which would invite the model to invent some.
        // `injection_block` returns "" for a blank file; this is the other half of that contract.
        let with = build_concierge_exec("/bin/claude", "hi", None, None, "");
        // NOT compared against `exec(...)`, which is literally `build_concierge_exec(…, "")` — that
        // assertion was a tautology and could not fail for ANY implementation (roborev 54860).
        // Compared against a NON-empty block instead, so the two cases must actually differ.
        let with_rules = build_concierge_exec(
            "/bin/claude",
            "hi",
            None,
            None,
            &crate::concierge_guidelines::injection_block("- be terse"),
        );
        assert_ne!(with, with_rules);
        assert!(with_rules.contains("be terse"));
        assert_eq!(with_rules.matches("OWN COMMUNICATION GUIDELINES").count(), 2);
        // The heading itself cannot be asserted absent here: the PERSONA names it, to tell the
        // model which section holds the user's rules and that it overrides the house voice. What
        // must be absent is a SECOND occurrence — the injected block's own heading.
        //
        // Matched WITHOUT the apostrophe in "USER'S", deliberately. This is the finished script, so
        // every `'` has already been rewritten to `'\''` by `shell_quote`; searching for the human
        // spelling finds nothing and the assertion passes for the wrong reason.
        assert_eq!(with.matches("OWN COMMUNICATION GUIDELINES").count(), 1);
        assert!(crate::concierge_guidelines::injection_block("   \n  ").is_empty());
    }

    /// The `CLAUDE_CONFIG_DIR` a built turn command would hand its child, or None if it sets none.
    fn child_config_dir(cmd: &Command) -> Option<std::ffi::OsString> {
        cmd.get_envs()
            .find(|(k, _)| *k == std::ffi::OsStr::new("CLAUDE_CONFIG_DIR"))
            .and_then(|(_, v)| v)
            .map(|v| v.to_os_string())
    }

    /// THE PHASE-0 BUG, concierge half. This spawn set `PATH` and nothing else, so every turn ran
    /// as `$HOME/.claude` — the `isDefault` account — and no amount of authenticating elsewhere
    /// could move it. That is what produced 15 consecutive `You've hit your monthly spend limit` /
    /// `You've hit your session limit` turn failures against an account the human had already
    /// stopped using.
    ///
    /// Asserted on the CHILD ENVIRONMENT rather than the script, because that is where the fix
    /// lives: `CLAUDE_CONFIG_DIR` is not in the script text either before or after, so a
    /// string-matching test would pass against the broken code and prove nothing.
    #[test]
    fn the_turn_child_runs_under_the_chosen_account() {
        let cmd = build_turn_command("exec claude -p x", std::path::Path::new("/tmp"), Some("/accounts/cd34"));
        assert_eq!(
            child_config_dir(&cmd).as_deref(),
            Some(std::ffi::OsStr::new("/accounts/cd34")),
            "the concierge must run under the account the user selected, not $HOME/.claude"
        );
    }

    /// "No override" must mean SET NOTHING, not set empty — the default account records
    /// `config_dir: ""` to mean exactly that (accounts.rs), and an empty value would make Claude
    /// Code resolve a RELATIVE `projects/` against the cwd rather than falling back to
    /// `$HOME/.claude`. Same rule `claude::resolve_session_config_dir` enforces on the read side.
    #[test]
    fn no_account_and_the_empty_default_both_leave_the_child_inheriting() {
        for absent in [None, Some("")] {
            let cmd = build_turn_command("exec claude -p x", std::path::Path::new("/tmp"), absent);
            assert_eq!(
                child_config_dir(&cmd),
                None,
                "config_dir {absent:?} must set no CLAUDE_CONFIG_DIR at all"
            );
        }
    }

    /// The argument list of the first `<name>(` call appearing in `src`, exclusive of the outer
    /// parens and balanced across nested calls. Every failure to find one PANICS rather than
    /// degrading to a wider slice — a source-scanning assertion that silently widens its window is
    /// how such a test goes vacuous, and this one guards a single argument in a call whose
    /// formatting is expected to change.
    fn call_args<'a>(src: &'a str, name: &str) -> &'a str {
        let open = src
            .find(&format!("{name}("))
            .unwrap_or_else(|| panic!("expected a `{name}(` call in the given source"))
            + name.len()
            + 1;
        let mut depth = 1usize;
        for (i, c) in src[open..].char_indices() {
            match c {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        return &src[open..open + i];
                    }
                }
                _ => {}
            }
        }
        panic!("unbalanced parentheses after `{name}(` — the call never closes");
    }

    /// The account must survive the STALE-RESUME RETRY, and this is the case an account switch
    /// actually lands on: the stored session id belongs to the previous account's transcript tree,
    /// so `--resume` fails and the retry re-spawns without it. If that retry dropped the account,
    /// the self-heal would quietly recreate the conversation back on `$HOME/.claude` — re-opening
    /// the bug on the exact path a switch takes.
    ///
    /// Pinned in source because the retry runs inside a spawned reader thread holding an
    /// `AppHandle`, which the sibling `Command::get_envs()` tests cannot reach. The window is
    /// extracted by BALANCED PARENS from the retry's own `spawn_turn(` call, and every step
    /// panics on a miss: an earlier version sliced to a literal `"{\n                Ok("` with
    /// `unwrap_or(len)`, so any reindentation would have widened the window to the rest of the
    /// file — which contains both `blk_config_dir.as_deref()` and this assertion's own literal, and
    /// would therefore have passed even with the argument reverted to `None`.
    #[test]
    fn the_stale_resume_retry_keeps_the_account() {
        let src = include_str!("concierge.rs");
        let retry = src
            .split("let (kind2, token2) = continuation_install(token);")
            .nth(1)
            .expect("the stale-resume retry must still spawn a continuation");
        let args = call_args(retry, "spawn_turn");
        assert!(
            args.contains("config_dir.as_deref()"),
            "the retry must re-spawn under the SAME account; passing None here would recreate the \
             concierge session on $HOME/.claude after every account switch. Saw args: {args}"
        );
    }

    /// The scanner the test above depends on must itself be right — a `call_args` that returned too
    /// much would restore exactly the vacuousness it was written to remove.
    #[test]
    fn call_args_stops_at_the_matching_paren_and_spans_nested_calls() {
        assert_eq!(call_args("f(a, g(b, c), d) then h(x)", "f"), "a, g(b, c), d");
        assert_eq!(call_args("let v = spawn_turn(\n  a,\n  b.as_deref(),\n);", "spawn_turn"), "\n  a,\n  b.as_deref(),\n");
    }

    #[test]
    fn build_exec_quotes_hostile_guidelines() {
        // THE REASON THIS TEST EXISTS. The guidelines file is hand-edited by the user AND appended
        // to by the model, then concatenated onto the persona and handed to a shell — so it is
        // untrusted text reaching a command line every single turn. `shell_quote` wraps the whole
        // concatenation, so a rule that tries to close the quote and run a command stays inert data
        // inside one argument.
        let hostile = "\n- be nice'; rm -rf /; echo '";
        let script = build_concierge_exec("/bin/claude", "hi", None, None, hostile);
        assert!(script.contains(r"be nice'\''; rm -rf /; echo '\''"));
        // The UN-escaped form must never appear — that is the string a broken quote would leave the
        // shell holding. `assert!(script.contains(" --allowedTools "))` used to stand here and was
        // unconditionally true: the builder always pushes that flag, quoting held or not, so it
        // proved nothing (roborev 54860) — the very defect this test file was added to fix.
        assert!(!script.contains("be nice'; rm -rf /"));
        // NO QUOTE-PARITY CHECK HERE. It reads like a good structural invariant and is not one:
        // `shell_quote` renders each embedded `'` as the four-character `'\''`, which contributes
        // THREE quotes — so a correctly-escaped script routinely has an odd total. The assertion
        // failed against known-good output, which is the useful kind of wrong to find in a test.
    }

    #[test]
    fn persona_states_the_agent_pill_contract() {
        // The founder's ask: an agent the concierge names is a clickable pill, never bare text.
        // The renderer resolves `sparkle-agent:<id>` links; this is the half that makes the model
        // emit them, and it is only sound because every roster line carries an id (the TS guard for
        // that is engine/conciergeRosterLine.test.ts).
        assert!(CONCIERGE_PERSONA.contains("sparkle-agent:"));
        assert!(CONCIERGE_PERSONA.contains("id:<agentId>"));
        // A WRONG id opens the wrong agent, which is worse than no link at all — so the refusal to
        // guess is part of the contract, not advice.
        assert!(CONCIERGE_PERSONA.contains("NEVER invent, guess, or reuse an id"));
        // The pill shows the agent's SHORT NAME and nothing else — a standing rule in the user's
        // communication guidelines that kept being broken because the model was working from name
        // strings rather than ids.
        assert!(CONCIERGE_PERSONA.contains("not its task, not what it is doing"));
    }

    #[test]
    fn persona_names_the_spawn_reply_fields_it_tells_the_model_to_use() {
        // ══ A CROSS-LANGUAGE CONTRACT, ASSERTED BECAUSE NOTHING ELSE COULD CATCH IT ══════════════
        // The spawn's reply is built in TypeScript (services/conciergeTools/lifecycle.ts) and read
        // by a model following THIS string. Rename the field there and nothing fails: the persona
        // keeps naming a key that no longer exists, and the model — told to use a field it cannot
        // find — falls back to whatever prose it can, which is exactly the "Build 17" failure this
        // work exists to end. There is no type system spanning the two, so this is the seam.
        assert!(CONCIERGE_PERSONA.contains("provisionalName"));
        assert!(CONCIERGE_PERSONA.contains("nameIsProvisional"));
        // `agentExists` is the field that says the spawned row is GONE (closed, or its project was,
        // while it was still starting). It exists ONLY to be read by the model following this
        // string, so a payload change that never reaches the persona is inert: the model would keep
        // rendering a pill from a dead id — which opens nothing while looking exactly like a working
        // one — and keep firing follow-up ops at it. Same seam as the two above, same reason.
        assert!(CONCIERGE_PERSONA.contains("agentExists"));
    // Same seam, same reason: the persona now tells the model to USE these two keys instead of
    // imposing its own chronology, and both are produced in TypeScript (conciergeTools/lifecycle.ts)
    // with no type system spanning the two languages. Rename either there and the persona keeps
    // naming a key that no longer exists — and the documented fallback is the model re-inventing the
    // chronology, which is the exact defect naming them was meant to close.
    assert!(CONCIERGE_PERSONA.contains("briefFailure"));
    assert!(CONCIERGE_PERSONA.contains("briefDelivery"));
        // …and the RULE, not just the field name: knowing the flag exists is useless without being
        // told what false means and what not to do about it.
        assert!(CONCIERGE_PERSONA.contains("do NOT render a pill"));
        // …and the REASON, not just the field name. A placeholder quoted as identity is stale within
        // seconds, so the instruction has to say what to do instead: reference the id.
        assert!(CONCIERGE_PERSONA.contains("spawn_build_agent"));
        assert!(CONCIERGE_PERSONA.contains("sparkle-agent:<agentId>"));
    }

    #[test]
    fn persona_tells_the_model_to_record_communication_preferences() {
        // The GROWTH MECHANISM. The guidelines file is only durable if something writes to it, and
        // the founder chose auto-append: the concierge saves the rule and says that it did, with no
        // approval step. Without this instruction the tool exists and is never called, and the file
        // only ever grows by hand — which is the thing the feature exists to stop.
        assert!(CONCIERGE_PERSONA.contains("append_communication_guideline"));
        // ══ THE PRECEDENCE CLAIM IS SCOPED, AND THE SCOPE IS A SECURITY BOUNDARY (roborev 54896) ══
        // This asserted the unqualified "OVERRIDES anything above it", which contradicted
        // INJECTION_HEADING in the SAME system prompt ("on matters of STYLE or PRESENTATION … it
        // governs how you SPEAK only"). Unqualified, the persona itself tells the model that a line
        // in a user-editable file — appendable by a tool reachable from untrusted terminal text —
        // outranks "NEVER invent, guess, or reuse an id" and the honesty-about-outcomes contract.
        // The two strings must agree, and the narrower one is the correct one.
        assert!(CONCIERGE_PERSONA.contains("STYLE or PRESENTATION"));
        assert!(CONCIERGE_PERSONA.contains("never guessing an agent id"));
        assert!(
            !CONCIERGE_PERSONA.contains("OVERRIDES anything above it"),
            "the unqualified precedence claim is the security regression this pins"
        );
        // The heading named here must be the one `injection_block` actually writes, or the persona
        // is pointing the model at a section that does not exist.
        assert!(CONCIERGE_PERSONA.contains("THE USER'S OWN COMMUNICATION GUIDELINES"));
        assert!(crate::concierge_guidelines::injection_block("- a rule")
            .contains("THE USER'S OWN COMMUNICATION GUIDELINES"));
    }

    #[test]
    fn persona_states_the_act_capable_contract() {
        // The persona USED to promise "never take actions yourself". The founder's 2026-07-27
        // direction reversed that, so this tripwire now guards the opposite regression: if
        // someone reinstates an observe-only sentence, the control surface below is a lie.
        assert!(!CONCIERGE_PERSONA.contains("never take actions yourself"));
        assert!(!CONCIERGE_PERSONA.contains("OBSERVE and RECOMMEND"));
        assert!(CONCIERGE_PERSONA.contains("You CAN ACT"));
        // The two behaviours the founder asked for by name.
        assert!(CONCIERGE_PERSONA.contains("ROUTE INTENT"));
        assert!(CONCIERGE_PERSONA.contains("act silently, must ask first, or may not act at all"));
        // Honesty about outcomes is part of the contract, not a nicety.
        assert!(CONCIERGE_PERSONA.contains("never report success you did not observe"));
        // The @-mention relay policy the founder chose: verbatim by default, propose-and-wait only
        // when the message would likely be MISREAD, and stay in the conversation afterwards. Each
        // clause is a separate founder decision, so each gets its own tripwire — a rewrite that
        // drops one is the regression, and it would otherwise be invisible (the persona is prose
        // handed to a model, so nothing else can fail when a rule quietly goes missing).
        assert!(CONCIERGE_PERSONA.contains("RELAY THEIR WORDS, NOT YOUR OWN"));
        assert!(CONCIERGE_PERSONA.contains("WAIT for their yes"));
        assert!(CONCIERGE_PERSONA.contains("not a mail slot"));
    }

    #[test]
    fn mcp_config_json_wires_the_socket_and_claims_no_agent_id() {
        let json = concierge_mcp_config_json("/usr/bin/node", "/app/server.js", "/tmp/c.sock", "tok");
        let v: Value = serde_json::from_str(&json).unwrap();
        let srv = &v["mcpServers"]["sparkle-control"];
        assert_eq!(srv["command"], "/usr/bin/node");
        assert_eq!(srv["args"][0], "/app/server.js");
        assert_eq!(srv["env"]["SPARKLE_CONTROL_SOCKET"], "/tmp/c.sock");
        assert_eq!(srv["env"]["SPARKLE_CONTROL_TOKEN"], "tok");
        // Identity is STRUCTURAL (stamped by the Rust listener from the socket), never claimed by
        // the client — so no usable SPARKLE_AGENT_ID, unlike a build agent's control config. It is
        // set EMPTY rather than omitted: omitting it leaves whatever the app inherited from the
        // shell that launched it, and an agent's PTY exports one.
        assert_eq!(srv["env"]["SPARKLE_AGENT_ID"], "");
    }

    // The MCP server decides whether to advertise a self-default ("omit targetAgentId to rename
    // YOURSELF") from this marker. Asserting on the POSITIVE marker rather than on the absence of
    // an id is the whole point: absence in this map is not absence in the child process.
    #[test]
    fn mcp_config_json_marks_the_concierge_as_having_no_agent_row_of_its_own() {
        let json = concierge_mcp_config_json("/usr/bin/node", "/app/server.js", "/tmp/c.sock", "tok");
        let v: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(
            v["mcpServers"]["sparkle-control"]["env"]["SPARKLE_CONTROL_NO_SELF"], "1",
            "without this the per-agent tools promise a self-default the app refuses"
        );
    }

    #[cfg(unix)]
    #[test]
    fn mcp_config_file_is_written_0600() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = std::env::temp_dir().join(format!("sparkle-conc-cfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = write_concierge_mcp_config(&dir, "{\"mcpServers\":{}}", 7).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "the file holds the bridge token; it must not be group/world readable");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"mcpServers\":{}}");

        // Rewriting an EXISTING file must not silently inherit a loosened mode.
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644));
        let again = write_concierge_mcp_config(&dir, "{\"mcpServers\":{\"x\":1}}", 7).unwrap();
        let mode2 = std::fs::metadata(&again).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode2, 0o600, "a pre-existing loose mode must be re-tightened");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn prune_never_deletes_a_still_live_turns_config() {
        // roborev 54255, finding 2. The prune runs before the child spawns and before the slot
        // decides whether to install it, so a too-eager age threshold silently degrades a live
        // turn to observe-only. Turns routinely run longer than a minute.
        let dir = std::env::temp_dir().join(format!("sparkle-conc-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // An older turn, still running, five minutes in.
        let live = dir.join("concierge-mcp-1.json");
        std::fs::write(&live, "{\"live\":true}").unwrap();
        let five_min_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(300);
        let f = std::fs::File::options().write(true).open(&live).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(five_min_ago)).unwrap();

        // A newer turn writes its own config; the older one must survive intact.
        write_concierge_mcp_config(&dir, "{}", 2).unwrap();
        assert!(live.exists(), "a 5-minute-old turn is still plausibly live and must not be pruned");
        assert_eq!(std::fs::read_to_string(&live).unwrap(), "{\"live\":true}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn each_turn_gets_its_own_config_file() {
        // Two overlapping turns must not share one path: a superseded turn's child may not have
        // spawned its MCP server yet, and a fixed name would let the newer turn truncate the file
        // out from under it (roborev 54226, finding 4).
        let dir = std::env::temp_dir().join(format!("sparkle-conc-uniq-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let a = write_concierge_mcp_config(&dir, "{\"a\":1}", 1).unwrap();
        let b = write_concierge_mcp_config(&dir, "{\"b\":2}", 2).unwrap();
        assert_ne!(a, b, "each turn writes its own file");
        // Both are still intact — neither clobbered the other.
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "{\"a\":1}");
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "{\"b\":2}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn stale_configs_are_pruned_but_fresh_ones_survive() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = std::env::temp_dir().join(format!("sparkle-conc-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // An aged token file, the LEGACY fixed-name file earlier builds wrote, and an unrelated
        // file that must be left alone.
        let old = dir.join("concierge-mcp-1.json");
        std::fs::write(&old, "{}").unwrap();
        let legacy = dir.join("concierge-mcp.json");
        std::fs::write(&legacy, "{}").unwrap();
        let bystander = dir.join("something-else.json");
        std::fs::write(&bystander, "{}").unwrap();
        // Backdate both with std (no extra dependency just to age a file in a test).
        let two_hours_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(7200);
        let times = std::fs::FileTimes::new().set_modified(two_hours_ago);
        for p in [&old, &legacy, &bystander] {
            let f = std::fs::File::options().write(true).open(p).unwrap();
            f.set_times(times).unwrap();
        }

        let fresh = write_concierge_mcp_config(&dir, "{}", 99).unwrap();
        assert!(fresh.exists(), "the file just written must survive its own prune");
        assert!(!old.exists(), "an aged concierge config must be pruned");
        // The file the whole prune exists to clean up: earlier builds wrote this fixed name, so a
        // `concierge-mcp-` prefix would have missed it forever (roborev 54255, finding 1).
        assert!(!legacy.exists(), "the LEGACY fixed-name config must be pruned too");
        assert!(bystander.exists(), "prune must only touch concierge-mcp*.json");
        let mode = std::fs::metadata(&fresh).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn should_retry_only_on_failure_with_a_resume_id() {
        assert!(should_retry_without_resume(false, Some("sess-42")));
        assert!(!should_retry_without_resume(false, None));
        assert!(!should_retry_without_resume(false, Some("")));
        assert!(!should_retry_without_resume(true, Some("sess-42")));
    }

    #[test]
    fn failure_detail_prefers_stderr_then_claude_detail_then_synthesizes() {
        // Non-empty stderr wins verbatim (trimmed), even over claude's detail.
        let m = failure_detail("  boom  ", Some(1), None, true, Some("detail"));
        assert_eq!(m, "boom");

        // Empty stderr + claude's own reason => surface the reason.
        let m = failure_detail("", Some(1), None, true, Some("Claude usage limit reached"));
        assert_eq!(m, "Claude usage limit reached");

        // Nothing to quote => synthesize from the exit code + subtype…
        let m = failure_detail("", Some(1), Some("error_max_turns"), true, None);
        assert!(m.contains("claude exited (code 1) with no output"), "got: {m}");
        assert!(m.contains("result subtype 'error_max_turns'"), "got: {m}");

        // …or the is_error hint, and phrase a signal kill as such.
        let m = failure_detail("", None, None, true, None);
        assert!(m.contains("killed by signal"), "got: {m}");
        assert!(m.contains("stream reported an error result"), "got: {m}");

        // A blank detail is ignored — fall through to the synthesized message.
        let m = failure_detail("", Some(1), None, false, Some("   "));
        assert_eq!(m, "claude exited (code 1) with no output");
    }

    /// The comparison itself (the relationship between the floor and a real reservation is covered
    /// by the two tests below, which drive the actual functions).
    #[test]
    fn a_send_retires_every_turn_issued_before_it() {
        // Tokens 5 and 6 are in flight; the user sends again and that send takes token 7.
        assert!(is_retired(5, 7));
        assert!(is_retired(6, 7));
        // Its own floor must not retire it…
        assert!(!is_retired(7, 7));
        // …nor anything after it.
        assert!(!is_retired(8, 7));
        // Nothing is retired before the first send.
        assert!(!is_retired(1, 0));
    }

    /// The turn statics are process globals and cargo runs tests in parallel, so every test that
    /// touches TURN_SEQ / RETIRE_BELOW takes this first (roborev 53147).
    static TEST_SEQ_LOCK: Mutex<()> = Mutex::new(());

    /// Reserve-THEN-publish, monotonic, and driving the REAL functions — a local re-implementation
    /// would stay green with `reserve_turn_token` reverted or its call deleted, which is the whole
    /// regression (roborev 53147; the same criticism accepted one level down last round).
    #[test]
    fn two_concurrent_sends_still_retire_the_older_one() {
        let _guard = TEST_SEQ_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Interleaved worst case: both sends reserve before either has spawned anything.
        let a = reserve_turn_token();
        let b = reserve_turn_token();
        assert!(a < b);
        let floor = RETIRE_BELOW.load(Ordering::Relaxed);
        assert!(is_retired(a, floor), "the send that arrived first must be retired by the second");
        assert!(!is_retired(b, floor), "the newest send is the live one");

        // A continuation (the stale-resume retry) claims NO token of its own — it reuses the one its
        // turn was sent under — so it can neither silence nor outrank a turn the user sent while
        // the first attempt was failing (roborev 53397).
        let seq_before = TURN_SEQ.load(Ordering::Relaxed);
        let (kind, cont) = continuation_install(a);
        assert_eq!((kind, cont), (TurnKind::Continuation, a));
        assert_eq!(TURN_SEQ.load(Ordering::Relaxed), seq_before, "a continuation takes no token");
        assert_eq!(RETIRE_BELOW.load(Ordering::Relaxed), floor, "a continuation publishes no floor");
        assert!(!is_retired(b, RETIRE_BELOW.load(Ordering::Relaxed)));
    }

    /// A send that fails AFTER publishing its floor tears down only what IT retired. Killing
    /// "whatever is in the slot" takes out the live turn on the most likely path in — an older
    /// send refusing to install because a newer one already owns the floor and the slot
    /// (roborev 53186).
    #[test]
    fn a_failed_send_kills_only_a_turn_older_than_itself() {
        // The REAL function both teardown sites call (roborev 53205).
        // The previous turn, which our floor retired: ours to take down.
        assert!(mine_to_tear_down(6, Some(5)));
        // A NEWER turn owns both the floor and the slot — killing it is how a refused older send
        // murders the turn the user is waiting on.
        assert!(!mine_to_tear_down(5, Some(6)));
        // Nothing installed at all.
        assert!(!mine_to_tear_down(5, None));
        // Our own entry can't be there: we failed before installing.
        assert!(!mine_to_tear_down(5, Some(5)));
    }

    /// The two sentinels are matched by the FRONTEND (apps/desktop/src/services/concierge.ts,
    /// `SUPERSEDED_DETAILS`) to keep a superseded or cancelled send silent. Nothing else ties the
    /// two languages together, so reword either side and the frontend quietly stops matching —
    /// fast second sends go back to posting "I couldn't reach my brain just now" and clearing the
    /// typing indicator for the turn that is still streaming (roborev 53205).
    ///
    /// This test pins the RUST side. The TS side is pinned by its own literal assertion — the
    /// `it("pins the sentinel literals Rust emits, …")` case in concierge.test.ts — NOT by the fact
    /// that its other tests import the constant (roborev 53392): importing it and feeding it back
    /// into its own matcher is tautological and stays green through any reword. The two mirrored
    /// literal assertions are the whole guard, so neither may be deleted as "duplication".
    #[test]
    fn the_silent_outcome_sentinels_are_the_strings_the_frontend_matches() {
        assert_eq!(SUPERSEDED_ERR, "concierge_turn: superseded before install");
        assert_eq!(CANCELLED_ERR, "concierge_turn: cancelled");
    }

    /// The REAL drain loop, gate injected: emissions stop the moment ownership is lost, MID-STREAM,
    /// and the parse keeps running so the reap sees a coherent turn. The constant-closure tests
    /// below cannot cover this — hoisting the per-line check out of the loop leaves them green
    /// while a superseded reader flushes the rest of its buffer (roborev 53181; I deleted this test
    /// by writing the cancel cases over it and did not notice, which is exactly its point).
    #[test]
    fn the_drain_goes_quiet_the_moment_ownership_is_lost() {
        let ndjson = concat!(
            r#"{"type":"system","subtype":"init","session_id":"sess-Q"}"#, "\n",
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"live "}}}"#, "\n",
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"and retired"}}}"#, "\n",
            r#"{"type":"result","subtype":"success","session_id":"sess-Q","result":"live and retired"}"#, "\n",
        );
        // Ownership is lost after the reader has already asked twice — mid-stream, as a send lands
        // while the previous turn is talking.
        let asks = AtomicU64::new(0);
        let owns = || asks.fetch_add(1, Ordering::Relaxed) < 2;
        let mut seen: Vec<String> = Vec::new();

        let out =
            drain_stream(ndjson.as_bytes(), &owns, &|| false, &mut |t| seen.push(t.to_string()), &mut |_, _| {});

        assert_eq!(seen, vec!["live "], "everything after the supersede must be silent");
        // Parsing continued regardless, so the reap's ownership check sees a coherent turn.
        assert_eq!(out.session_id, "sess-Q");
        assert_eq!(out.final_text, "live and retired");
        // Latched: once lost, the gate stops taking the manager's mutex (4 lines, 3 asks).
        assert_eq!(asks.load(Ordering::Relaxed), 3);
    }

    /// Cancel while a send is still PREPARING — the state neither the floor nor the slot can
    /// describe, because that send has neither a token nor a child yet. Drives the REAL
    /// `cancelled_during_prep` the command calls (roborev 53147/53181).
    #[test]
    fn a_cancel_during_the_prep_stops_the_send_that_had_not_started() {
        let _guard = TEST_SEQ_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // What concierge_turn reads on entry, before the claude-path lookup and the cwd prep.
        let on_entry = CANCEL_EPOCH.load(Ordering::Relaxed);
        assert!(!cancelled_during_prep(on_entry), "an uneventful send proceeds");

        retire_issued_turns(); // Escape, while that prep is in flight
        assert!(
            cancelled_during_prep(on_entry),
            "a cancel must be visible to a send that has not reached its reservation",
        );

        // A send that starts AFTER the cancel is unaffected by it.
        let fresh = CANCEL_EPOCH.load(Ordering::Relaxed);
        let _ = reserve_turn_token();
        assert!(!cancelled_during_prep(fresh));
    }

    /// The install decision — the rule that keeps "who owns the slot" agreeing with "who owns the
    /// floor". Two sends race on separate threads and their spawns can finish out of order, so an
    /// unconditional replace lets an OLDER turn stomp the newer one's entry and kill the child the
    /// user is waiting on (roborev 53165).
    #[test]
    fn an_older_or_retired_turn_never_takes_the_slot() {
        // The REAL function the install site calls (roborev 53186) — a local copy would have
        // stayed green with that call deleted.
        // The live turn installs over an older entry.
        assert!(may_install(TurnKind::Send, 6, 6, Some(5), true));
        // …but the older one, spawning a moment later, must NOT stomp it.
        assert!(!may_install(TurnKind::Send, 5, 6, Some(6), true));
        // Retired even with an empty slot (the floor moved while we were spawning).
        assert!(!may_install(TurnKind::Send, 5, 6, None, true));
        // First turn of the session.
        assert!(may_install(TurnKind::Send, 1, 0, None, true));
        // Equal tokens cannot happen (each reservation is unique), but re-installing over yourself
        // is not a supersession either way.
        assert!(may_install(TurnKind::Send, 7, 7, Some(7), true));
    }

    /// The stale-resume retry installs under a STRICTER rule than a send: any occupant at all wins
    /// (roborev 53397). Token order cannot stand in for it — the continuation's token predates that
    /// occupant by construction, and the fresh token the retry used to draw was numerically ABOVE
    /// every send in existence, which is how it came to kill a live turn.
    #[test]
    fn a_continuation_never_installs_over_an_occupied_slot() {
        // The reap that precedes the retry emptied the slot itself, so this is the normal case.
        assert!(may_install(TurnKind::Continuation, 5, 5, None, false));

        // A send landed while the first attempt was failing and has already installed. The retry
        // must stand down — killing turn 6's child strands the user's newest question, which gets
        // no terminal event at all, while the retry answers the PREVIOUS one under a retired id.
        assert!(!may_install(TurnKind::Continuation, 5, 6, Some(6), false));

        // THE REGRESSION ITSELF: the old code drew a fresh token for the retry, so it presented at
        // the install site numerically ABOVE the live send it was about to stomp — and a
        // send-shaped rule ("refuse only a strictly newer occupant") waves that straight through.
        // Both halves of the fix are needed for this line: the kind-aware rule, and a token that no
        // longer outranks a send.
        assert!(!may_install(TurnKind::Continuation, 7, 6, Some(6), false));
        // Same shape with the slot older still — a continuation is never anyone's cleanup crew.
        assert!(!may_install(TurnKind::Continuation, 7, 0, Some(1), false));

        // A send in the same position DOES install: it owns the floor, and the occupant is a turn
        // its own floor retired. The two rules genuinely differ, so neither can be dropped.
        assert!(may_install(TurnKind::Send, 7, 7, Some(6), true));

        // The floor still comes first, whatever the kind.
        assert!(!may_install(TurnKind::Continuation, 5, 6, None, false));
    }

    /// A retry REFUSED at the install site emits nothing — the silence the reader keeps for
    /// `!outcome.owned`. The stricter continuation rule above makes this reachable, and emitting
    /// would re-open roborev 53186 from the other side: a user-facing "I couldn't reach my brain
    /// just now" (sometimes carrying the internal sentinel verbatim) plus a typing reset, over the
    /// newer turn that IS streaming (roborev 53460).
    #[test]
    fn a_retry_refused_at_the_install_site_says_nothing() {
        // Refused: the sentinel says so outright…
        assert!(refused_retry_stays_silent(SUPERSEDED_ERR, 5, 5));
        // …and the floor says so independently, which is what covers a send that landed between the
        // refusal and this check.
        assert!(refused_retry_stays_silent("spawn failed: EAGAIN", 5, 6));

        // A GENUINE spawn failure with the user still waiting must still be surfaced — going quiet
        // unconditionally here would leave the bubble in-progress forever with no terminal event.
        assert!(!refused_retry_stays_silent("concierge_turn: spawn failed: EAGAIN", 5, 5));
        assert!(!refused_retry_stays_silent("concierge_turn: child has no stdout", 5, 5));

        // Not a substring match: only the sentinel itself, so a stderr string that happens to quote
        // it does not silence a real failure.
        assert!(!refused_retry_stays_silent(&format!("wrapped: {SUPERSEDED_ERR}"), 5, 5));
    }

    /// Cancel still retires everything already RESERVED — the turns that do have a token, whether
    /// or not their child has spawned.
    #[test]
    fn cancel_retires_every_reserved_turn() {
        let _guard = TEST_SEQ_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let live = reserve_turn_token();
        assert!(!is_retired(live, RETIRE_BELOW.load(Ordering::Relaxed)));
        retire_issued_turns();
        assert!(is_retired(live, RETIRE_BELOW.load(Ordering::Relaxed)));
    }

    /// The per-CHUNK floor check: a send that lands during a line's parse still silences that
    /// line's chunks. The per-line check is hoisted for the mutex, so this is the half that closes
    /// the parse-width window — and one admitted chunk is the whole failure mode, since a delta for
    /// a never-before-seen id paints a bubble that never gets a terminal event (roborev 53130).
    #[test]
    fn a_send_landing_mid_parse_still_silences_that_line() {
        let ndjson = concat!(
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"too late"}}}"#, "\n",
        );
        let mut seen: Vec<String> = Vec::new();
        // Owns the slot (the replacement child has not spawned yet) but the floor has already risen.
        let out = drain_stream(ndjson.as_bytes(), &|| true, &|| true, &mut |t| seen.push(t.to_string()), &mut |_, _| {});
        assert!(seen.is_empty(), "a retired turn must not emit even while it holds the slot: {seen:?}");
        assert_eq!(out.acc, "too late", "…and the parse still ran");
    }

    /// The floor and the token come from the SAME reservation — the relationship the previous test
    /// only asserted in a comment (roborev 53130). Exercises the real statics.
    #[test]
    fn a_reserved_token_is_live_and_retires_the_one_before_it() {
        let _guard = TEST_SEQ_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let first = reserve_turn_token();
        assert!(!is_retired(first, RETIRE_BELOW.load(Ordering::Relaxed)), "a send's own token is live");
        let second = reserve_turn_token();
        assert!(second > first);
        let floor = RETIRE_BELOW.load(Ordering::Relaxed);
        assert!(is_retired(first, floor), "the newer send retires the older turn immediately");
        assert!(!is_retired(second, floor));
        // `first` failed with a stale resume id and retries. The continuation runs under `first`'s
        // OWN token, so `second`'s floor retires it — the retry of a question the user has moved on
        // from does not run (roborev 53397). A fresh token here would have landed ABOVE `second` and
        // sailed through this very check.
        let (kind, cont) = continuation_install(first);
        assert_eq!(kind, TurnKind::Continuation);
        assert_eq!(cont, first, "a continuation reuses its turn's token; it does not mint one");
        assert!(cont < second);
        assert_eq!(RETIRE_BELOW.load(Ordering::Relaxed), floor, "a continuation publishes no floor");
        assert!(is_retired(cont, floor), "a send after the failure retires the retry");
        assert!(!is_retired(second, RETIRE_BELOW.load(Ordering::Relaxed)));
    }

    /// A reader that has ALREADY lost the slot when the drain starts says nothing at all.
    #[test]
    fn a_reader_that_never_owned_the_turn_emits_nothing() {
        let ndjson = concat!(
            r#"{"type":"system","subtype":"init","session_id":"sess-OLD"}"#, "\n",
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"the dead turn's buffered output"}}}"#, "\n",
        );
        let mut seen: Vec<String> = Vec::new();
        let out = drain_stream(ndjson.as_bytes(), &|| false, &|| false, &mut |t| seen.push(t.to_string()), &mut |_, _| {});
        assert!(seen.is_empty(), "a superseded reader must not emit: {seen:?}");
        assert_eq!(out.session_id, "sess-OLD");
        assert_eq!(out.acc, "the dead turn's buffered output");
    }

    /// THE FACT THE REPLY LINTER DECIDES ON: what the turn SENT, captured from the same drain that
    /// produced what it SAID. Driven through the REAL `drain_stream` against literal NDJSON, so a
    /// capture call deleted from the loop fails here — the point of driving the loop rather than
    /// calling `capture_tool_uses` directly.
    ///
    /// `relay-paste` blocks a reply that pastes back the full text the concierge relayed to a build
    /// agent, so the argument text has to survive VERBATIM and in full. `conciergeAudit.ts` cannot
    /// answer this: it truncates argument values at 220 characters, well under any relayed message.
    #[test]
    fn the_drain_captures_the_tool_calls_a_turn_actually_made() {
        // A relayed message longer than conciergeAudit's 220-char argument cap — the exact case
        // that store cannot answer, and the reason this capture exists.
        let relayed = "Rebase onto fresh origin/main before you verify: this branch is 95 commits \
behind and you will spend the round chasing a red that is not yours. Then run the full suite, not \
just the nearest test, because you are touching shared code.";
        assert!(relayed.len() > 220, "the fixture must exceed conciergeAudit's arg cap");
        let ndjson = format!(
            concat!(
                r#"{{"type":"system","subtype":"init","session_id":"sess-T"}}"#, "\n",
                r#"{{"type":"stream_event","event":{{"type":"content_block_delta","delta":{{"type":"text_delta","text":"Relayed it. "}}}}}}"#, "\n",
                r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"ok"}},{{"type":"tool_use","id":"toolu_1","name":"mcp__sparkle-control__sparkle_terminal","input":{{"action":"send","agentId":"a1","text":{msg}}}}}]}}}}"#, "\n",
                r#"{{"type":"stream_event","event":{{"type":"content_block_delta","delta":{{"type":"text_delta","text":"Rebase note sent."}}}}}}"#, "\n",
                r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","id":"toolu_2","name":"mcp__sparkle-control__set_agent_goal","input":{{"goal":"land the rebase"}}}}]}}}}"#, "\n",
                r#"{{"type":"result","subtype":"success","session_id":"sess-T","result":"Relayed it. Rebase note sent."}}"#, "\n",
            ),
            msg = serde_json::to_string(relayed).unwrap(),
        );

        let mut seen: Vec<String> = Vec::new();
        let out = drain_stream(ndjson.as_bytes(), &|| true, &|| false, &mut |t| seen.push(t.to_string()), &mut |_, _| {});

        // BOTH survive the same pass: the streamed text is unchanged by the capture…
        assert_eq!(seen, vec!["Relayed it. ", "Rebase note sent."]);
        assert_eq!(out.final_text, "Relayed it. Rebase note sent.");
        // …and the tool calls carry their names in stream order…
        let names: Vec<&str> = out.tool_calls.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["mcp__sparkle-control__sparkle_terminal", "mcp__sparkle-control__set_agent_goal"],
        );
        // …with the relayed message intact, which is what the check compares the reply against.
        assert!(
            out.tool_calls[0].input.contains(relayed),
            "the relayed text must survive whole: {}",
            out.tool_calls[0].input,
        );
        assert!(out.tool_calls[1].input.contains("land the rebase"));
    }

    /// A turn that called nothing yields an EMPTY vec, not an error and not a missing field — the
    /// common case (the concierge answers a question), and the linter must be able to tell "no
    /// calls" from "calls we failed to capture".
    #[test]
    fn a_turn_with_no_tool_calls_yields_an_empty_list() {
        let ndjson = concat!(
            r#"{"type":"system","subtype":"init","session_id":"sess-N"}"#, "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"All quiet."}]}}"#, "\n",
            r#"{"type":"result","subtype":"success","session_id":"sess-N","result":"All quiet."}"#, "\n",
        );
        let out = drain_stream(ndjson.as_bytes(), &|| true, &|| false, &mut |_| {}, &mut |_, _| {});
        assert!(out.tool_calls.is_empty(), "a text-only turn captures nothing: {:?}", out.tool_calls);
        assert_eq!(out.final_text, "All quiet.");
    }

    /// A malformed `tool_use` block must not panic and must not cost the REST of the stream — the
    /// shapes here are the CLI's to change, and losing a reply over an unexpected block would be a
    /// far worse failure than losing a lint input.
    #[test]
    fn a_malformed_tool_use_block_does_not_stop_the_parse() {
        let ndjson = concat!(
            // No name; content isn't even an array on the next one; then a good call and a normal
            // delta + result AFTER the damage.
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","input":{"a":1}}]}}"#, "\n",
            r#"{"type":"assistant","message":{"content":"not-an-array"}}"#, "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/x.rs"}}]}}"#, "\n",
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"still here"}}}"#, "\n",
            r#"{"type":"result","subtype":"success","session_id":"sess-M","result":"still here"}"#, "\n",
        );
        let mut seen: Vec<String> = Vec::new();
        let out = drain_stream(ndjson.as_bytes(), &|| true, &|| false, &mut |t| seen.push(t.to_string()), &mut |_, _| {});

        let names: Vec<&str> = out.tool_calls.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["Read"], "only the well-formed block is recorded");
        assert!(out.tool_calls[0].input.contains("/x.rs"));
        // Everything downstream of the malformed lines still parsed and still emitted.
        assert_eq!(seen, vec!["still here"]);
        assert_eq!(out.session_id, "sess-M");
        assert_eq!(out.final_text, "still here");
    }

    /// The ownership gate is about EMISSION, not bookkeeping: a retired turn still says nothing,
    /// and the capture added alongside the parse does not smuggle its output past that gate — the
    /// records are dropped at the reap, so they never reach a `done` (there isn't one).
    #[test]
    fn a_retired_turn_still_emits_nothing_though_the_parse_captures() {
        let ndjson = concat!(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"echo dead"}}]}}"#, "\n",
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"the dead turn's output"}}}"#, "\n",
        );
        let mut seen: Vec<String> = Vec::new();
        let out = drain_stream(ndjson.as_bytes(), &|| false, &|| false, &mut |t| seen.push(t.to_string()), &mut |_, _| {});
        assert!(seen.is_empty(), "a superseded reader must not emit: {seen:?}");
        // The parse ran (that is the pre-existing contract), so the capture ran with it…
        assert_eq!(out.acc, "the dead turn's output");
        assert_eq!(out.tool_calls.len(), 1);
        // …and what keeps it from ever leaving is `drain_turn`'s un-owned path, which returns
        // before any emit and hands back an outcome carrying an empty vec. That path needs a live
        // AppHandle, so it is not driven here; what IS pinned here is that the capture itself adds
        // no emission — `seen` is still empty with tool_use blocks in the stream.
    }

    /// The captured records reach the emitted payload as `toolCalls` — the wire contract the
    /// frontend's `ConciergeDoneEvent` declares. Serializing the REAL struct is the only thing that
    /// proves the camelCase rename applies to the new field; a field-presence check would not.
    #[test]
    fn the_done_payload_carries_the_tool_calls_as_camel_case() {
        let ndjson = concat!(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"gh pr merge 864 --merge"}}]}}"#, "\n",
            r#"{"type":"result","subtype":"success","session_id":"sess-D","result":"Merged it."}"#, "\n",
        );
        let out = drain_stream(ndjson.as_bytes(), &|| true, &|| false, &mut |_| {}, &mut |_, _| {});
        // The exact construction `emit_outcome` performs on the success arm.
        let done = ConciergeDone {
            id: "42".into(),
            session_id: out.session_id,
            text: out.final_text,
            tool_calls: out.tool_calls,
        };
        let json = serde_json::to_value(&done).unwrap();
        assert_eq!(json["sessionId"], "sess-D");
        let calls = json["toolCalls"].as_array().expect("toolCalls must be an array on the payload");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["name"], "Bash");
        assert!(
            calls[0]["input"].as_str().unwrap().contains("gh pr merge 864 --merge"),
            "the argument text must reach the frontend: {:?}",
            calls[0]["input"],
        );
    }

    /// Drive `drain_stream` and log deltas and tool events into ONE ordered list, tagged, so the
    /// relative ORDER of the two channels is assertable. Two separate vectors could not express
    /// "the Bash call arrived between these two sentences", which is the whole feature.
    fn drain_logging_both(
        ndjson: &str,
        owns: &dyn Fn() -> bool,
        retired: &dyn Fn() -> bool,
    ) -> (Vec<String>, DrainedStream) {
        let log = std::cell::RefCell::new(Vec::<String>::new());
        let out = drain_stream(
            ndjson.as_bytes(),
            owns,
            retired,
            &mut |t| log.borrow_mut().push(format!("delta:{t}")),
            &mut |name, input| log.borrow_mut().push(format!("tool:{name}:{input}")),
        );
        (log.into_inner(), out)
    }

    /// THE FEATURE: tool calls reach the frontend WHILE the turn is running, in stream position —
    /// not batched onto `concierge:done` at the end, which is what they did before and why the
    /// concierge column animated three dots through the majority of a turn.
    ///
    /// The assertion is a single interleaved sequence, deliberately. A test that counted the tool
    /// events, or checked them in their own vector, would pass unchanged against an implementation
    /// that collected them and flushed after the loop — i.e. against the bug. Only the position of
    /// each `tool:` entry RELATIVE to the `delta:` entries around it distinguishes live from
    /// batched.
    #[test]
    fn live_tool_events_arrive_interleaved_with_the_deltas_around_them() {
        let ndjson = concat!(
            r#"{"type":"system","subtype":"init","session_id":"sess-L"}"#, "\n",
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Checking. "}}}"#, "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"git log --oneline -3"}}]}}"#, "\n",
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Reading it. "}}}"#, "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"one sec"},{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"/a/b.rs"}}]}}"#, "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t3","name":"mcp__sparkle-control__sparkle_terminal","input":{"action":"send"}}]}}"#, "\n",
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Done."}}}"#, "\n",
            r#"{"type":"result","subtype":"success","session_id":"sess-L","result":"Checking. Reading it. Done."}"#, "\n",
        );

        let (log, out) = drain_logging_both(ndjson, &|| true, &|| false);

        assert_eq!(
            log,
            vec![
                "delta:Checking. ".to_string(),
                r#"tool:Bash:{"command":"git log --oneline -3"}"#.to_string(),
                "delta:Reading it. ".to_string(),
                r#"tool:Read:{"file_path":"/a/b.rs"}"#.to_string(),
                r#"tool:mcp__sparkle-control__sparkle_terminal:{"action":"send"}"#.to_string(),
                "delta:Done.".to_string(),
            ],
            "tool events must land BETWEEN the deltas they ran between, not after all of them",
        );
        // Belt and braces on the thing the vector above encodes: the first tool event preceded the
        // LAST delta. A batched implementation cannot satisfy this, whatever its ordering within
        // each channel.
        let first_tool = log.iter().position(|e| e.starts_with("tool:")).expect("a tool event");
        let last_delta = log.iter().rposition(|e| e.starts_with("delta:")).expect("a delta");
        assert!(first_tool < last_delta, "the first tool call must be reported mid-turn: {log:?}");

        // ONE parse: the live events and the `done` records name the same calls in the same order.
        let recorded: Vec<&str> = out.tool_calls.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(
            recorded,
            vec!["Bash", "Read", "mcp__sparkle-control__sparkle_terminal"],
            "the batched record and the live stream must not disagree about what was called",
        );
        assert_eq!(out.final_text, "Checking. Reading it. Done.");
    }

    /// The per-LINE ownership gate covers the tool event exactly as it covers the delta: a send
    /// that lands mid-stream silences the REST of the superseded turn's tool calls. Without this,
    /// a dead turn keeps writing "Bash: …" into the column of the turn that replaced it — the
    /// tool-call form of the orphan bubble the delta gate exists to prevent (roborev 53088/53105).
    ///
    /// The capture keeps running throughout, which is the pre-existing contract: the gate governs
    /// EMISSION, not bookkeeping.
    #[test]
    fn a_supersede_mid_stream_stops_the_tool_events_but_not_the_capture() {
        let ndjson = concat!(
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"live "}}}"#, "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"echo live"}}]}}"#, "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/dead.rs"}}]}}"#, "\n",
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"dead"}}}"#, "\n",
        );
        // Ownership is lost after the reader has asked twice — the third line onward is silent.
        let asks = AtomicU64::new(0);
        let owns = || asks.fetch_add(1, Ordering::Relaxed) < 2;

        let (log, out) = drain_logging_both(ndjson, &owns, &|| false);

        assert_eq!(
            log,
            vec![
                "delta:live ".to_string(),
                r#"tool:Bash:{"command":"echo live"}"#.to_string(),
            ],
            "everything after the supersede must be silent, tool events included: {log:?}",
        );
        // …and the parse ran to EOF regardless, so the reap still sees a coherent turn.
        let recorded: Vec<&str> = out.tool_calls.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(recorded, vec!["Bash", "Read"], "capture is ungated: {recorded:?}");
        assert_eq!(out.acc, "live dead");
    }

    /// A reader that never owned the turn emits NO tool events at all, and a turn the FLOOR has
    /// retired emits none either even while it still holds the slot. Both checks are load-bearing
    /// on the delta path (roborev 53130) and both are re-asserted here, because a tool emit wired
    /// past either one paints a status line for a turn the user already replaced.
    #[test]
    fn a_retired_or_unowned_turn_emits_zero_tool_events_though_the_parse_captures() {
        let ndjson = concat!(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"echo dead"}}]}}"#, "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Grep","input":{"pattern":"x"}}]}}"#, "\n",
        );

        // Superseded at the slot.
        let (log, out) = drain_logging_both(ndjson, &|| false, &|| false);
        assert!(log.is_empty(), "a superseded reader must announce nothing: {log:?}");
        assert_eq!(out.tool_calls.len(), 2, "…while the capture still recorded both calls");

        // Retired at the floor, slot still ours — the window a slot-only check misses.
        let (log, out) = drain_logging_both(ndjson, &|| true, &|| true);
        assert!(log.is_empty(), "a retired turn must announce nothing: {log:?}");
        assert_eq!(out.tool_calls.len(), 2);
    }

    /// The live payload is clamped MUCH smaller than the `done` record (512 vs 16_384) because it
    /// ships per call, live, into a ~360px column. The clamp must cut on a CHARACTER boundary —
    /// this input is all multi-byte, so a byte slice would panic here rather than fail quietly.
    #[test]
    fn the_live_tool_input_clamp_lands_on_a_character_boundary() {
        use crate::claude_chat::MAX_LIVE_TOOL_INPUT_CHARS;
        // 4-byte emoji, 3-byte CJK, 2-byte Latin — every boundary width, well past the clamp.
        let wide = "🚀漢é".repeat(MAX_LIVE_TOOL_INPUT_CHARS);
        let ndjson = format!(
            r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","name":"Bash","input":{{"command":{cmd}}}}}]}}}}"#,
            cmd = serde_json::to_string(&wide).unwrap(),
        ) + "\n";

        let (log, out) = drain_logging_both(&ndjson, &|| true, &|| false);

        assert_eq!(log.len(), 1, "one call, one event: {log:?}");
        let emitted = log[0].strip_prefix("tool:Bash:").expect("the tagged prefix");
        // The clamp fired, and the prefix it kept is EXACTLY the first N characters of the full
        // compact JSON — the property a byte-boundary cut would violate (or panic attempting).
        let full = &out.tool_calls[0].input;
        assert!(
            emitted.chars().count() > MAX_LIVE_TOOL_INPUT_CHARS,
            "a truncation marker is appended, so the clamped value is slightly longer than the cap",
        );
        assert!(
            emitted.chars().count() < MAX_LIVE_TOOL_INPUT_CHARS + 32,
            "…but only by the marker: {}",
            emitted.chars().count(),
        );
        let kept: String = emitted.chars().take(MAX_LIVE_TOOL_INPUT_CHARS).collect();
        let expected: String = full.chars().take(MAX_LIVE_TOOL_INPUT_CHARS).collect();
        assert_eq!(kept, expected, "the kept prefix must be the first N CHARACTERS of the input");
        assert!(emitted.ends_with("[truncated]"), "a clamped value is marked: {emitted}");
    }

    /// THE REGRESSION THAT WOULD BE SILENT: the small live clamp must not reach the `concierge:done`
    /// payload, whose full-length arguments the reply linter (`conciergeLint/checks/askWithoutAction`
    /// and `relay-paste`) decides on. 512 characters is far below the verbatim overlap those checks
    /// look for, so a leaked clamp would not break a test that only counted records — it would just
    /// quietly stop the lint from ever matching.
    #[test]
    fn the_small_live_clamp_does_not_leak_into_the_done_payload() {
        use crate::claude_chat::{MAX_LIVE_TOOL_INPUT_CHARS, MAX_TOOL_USE_INPUT_CHARS};
        // Comfortably past the LIVE clamp and comfortably under the payload one, so the two paths
        // must disagree about this exact value.
        let relayed = "R".repeat(MAX_LIVE_TOOL_INPUT_CHARS * 4);
        assert!(relayed.chars().count() < MAX_TOOL_USE_INPUT_CHARS, "fixture stays under the big cap");
        let ndjson = format!(
            concat!(
                r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","name":"mcp__sparkle-control__sparkle_terminal","input":{{"text":{msg}}}}}]}}}}"#, "\n",
                r#"{{"type":"result","subtype":"success","session_id":"sess-C","result":"Relayed."}}"#, "\n",
            ),
            msg = serde_json::to_string(&relayed).unwrap(),
        );

        let (log, out) = drain_logging_both(&ndjson, &|| true, &|| false);

        // The LIVE event is clamped…
        let emitted = log[0].split_once(':').unwrap().1;
        assert!(
            !emitted.contains(&relayed),
            "the live event must not ship the full argument text",
        );
        // …and the `done` payload, built exactly as `emit_outcome` builds it, still is NOT.
        let done = ConciergeDone {
            id: "7".into(),
            session_id: out.session_id,
            text: out.final_text,
            tool_calls: out.tool_calls,
        };
        let json = serde_json::to_value(&done).unwrap();
        let payload_input = json["toolCalls"][0]["input"].as_str().expect("input on the payload");
        assert!(
            payload_input.contains(&relayed),
            "the done payload must still carry the FULL argument text (len {})",
            payload_input.chars().count(),
        );
    }

    /// A malformed `tool_use` block costs neither a panic nor the REST of the stream — the same
    /// contract the capture has always had, now extended to the live channel. The shapes here are
    /// the CLI's to change, and going quiet for the rest of a turn would be a far worse failure
    /// than dropping one status line.
    #[test]
    fn a_malformed_tool_use_block_emits_nothing_and_does_not_stop_later_events() {
        let ndjson = concat!(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","input":{"a":1}}]}}"#, "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"   ","input":{"a":2}}]}}"#, "\n",
            r#"{"type":"assistant","message":{"content":"not-an-array"}}"#, "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}"#, "\n",
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"still here"}}}"#, "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"bd ready"}}]}}"#, "\n",
            r#"{"type":"result","subtype":"success","session_id":"sess-B","result":"still here"}"#, "\n",
        );

        let (log, out) = drain_logging_both(ndjson, &|| true, &|| false);

        assert_eq!(
            log,
            vec![
                // A block with no `input` at all still names a real call; `{}` is its arguments.
                "tool:Read:{}".to_string(),
                "delta:still here".to_string(),
                r#"tool:Bash:{"command":"bd ready"}"#.to_string(),
            ],
            "the nameless / non-array blocks are skipped and everything after them still fires: {log:?}",
        );
        let recorded: Vec<&str> = out.tool_calls.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(recorded, vec!["Read", "Bash"], "and the capture agrees with the live stream");
        assert_eq!(out.final_text, "still here");
    }

    /// THE FROZEN WIRE CONTRACT. The TypeScript listener is written against exactly these three
    /// keys; serializing the REAL struct is the only thing that proves the rename attribute applies
    /// and that no field was added or renamed underneath it.
    #[test]
    fn the_live_tool_event_serializes_as_id_name_input() {
        let ev = ConciergeToolEvent {
            id: "42".into(),
            name: "Bash".into(),
            input: r#"{"command":"git status"}"#.into(),
        };
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(json["id"], "42");
        assert_eq!(json["name"], "Bash");
        assert_eq!(json["input"], r#"{"command":"git status"}"#);
        let obj = json.as_object().expect("an object");
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["id", "input", "name"], "no extra or renamed fields on the wire");
    }

    /// THE PRECEDENCE RULE OF THE PROACTIVE PUSH CHANNEL: the user's own message always wins.
    ///
    /// A push is a turn nobody asked for, so it is never allowed to cost the user anything. It
    /// refuses the slot whenever ANYTHING else holds it — a live send, a stale-resume continuation,
    /// even another push — and, separately, whenever a send is merely PREPARING (see
    /// `SendInFlight` / `sends_pending`), which is the window no slot check can see: `concierge_turn`
    /// spends hundreds of milliseconds resolving the claude path and spawning `zsh` before it takes
    /// the slot, and a push that installed in that window would be found by the send's own
    /// `may_install` as a NEWER occupant — so the SEND would stand down and the user's message would
    /// die unanswered. That is the exact failure this channel must never introduce.
    #[test]
    fn a_proactive_push_never_installs_over_a_user_turn() {
        // The normal case: nothing in flight, no send preparing.
        assert!(may_install(TurnKind::Proactive, 5, 0, None, false));

        // A send is PREPARING — no token, no child, nothing in the slot yet, and the push must
        // still stand down. A slot-only rule waves this straight through (see the doc above).
        assert!(!may_install(TurnKind::Proactive, 5, 0, None, true));

        // Anything at all in the slot refuses the push, whether older or newer than it. A push
        // claims no recency, so token order says nothing about whether it may replace an occupant.
        assert!(!may_install(TurnKind::Proactive, 9, 0, Some(3), false));
        assert!(!may_install(TurnKind::Proactive, 3, 0, Some(9), false));

        // A floor published by a later send retires the push like any other turn.
        assert!(!may_install(TurnKind::Proactive, 5, 6, None, false));

        // …and `sends_pending` is deliberately inert for the two USER-driven kinds: a send holds
        // its own pending guard for the whole of its prep, so consulting it there would make every
        // send refuse itself.
        assert!(may_install(TurnKind::Send, 6, 6, Some(5), true));
        assert!(may_install(TurnKind::Continuation, 5, 5, None, true));
    }

    /// The same rule at the CHEAP pre-check, before a push spends a claude-path lookup and a
    /// process spawn on a turn it is about to refuse. A real function the command calls, so the
    /// test drives production control flow rather than a restatement of it (the pattern the whole
    /// module already uses — see `cancelled_during_prep`).
    #[test]
    fn a_proactive_push_does_not_even_start_while_the_user_owns_the_turn() {
        assert!(proactive_may_start(false, false));
        assert!(!proactive_may_start(true, false), "a send is preparing");
        assert!(!proactive_may_start(false, true), "a turn is in flight");
        assert!(!proactive_may_start(true, true));
    }

    /// `SendInFlight` is what makes "a send is preparing" observable, and it must be a GUARD rather
    /// than a pair of manual increments: `concierge_turn` has six early-return paths, and one that
    /// forgot to decrement would wedge the push channel silently for the life of the process — a
    /// feature that simply stops working, with no error anywhere.
    #[test]
    fn a_send_is_observable_while_it_prepares_and_only_while_it_prepares() {
        let _guard = TEST_SEQ_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let before = PENDING_SENDS.load(Ordering::SeqCst);
        {
            let _send = SendInFlight::enter();
            assert_eq!(PENDING_SENDS.load(Ordering::SeqCst), before + 1);
            assert!(!proactive_may_start(sends_pending(), false), "the push stands down");
        }
        assert_eq!(PENDING_SENDS.load(Ordering::SeqCst), before, "the guard released on drop");
    }

    /// A push takes a token (its events need an id, and the install rules need a position in the
    /// ordering) but publishes NO retirement floor — the one property that keeps it from ever
    /// silencing a turn the user is waiting on. Same shape as `continuation_install`'s guarantee,
    /// and asserted against the real statics for the same reason.
    #[test]
    fn a_proactive_push_publishes_no_floor() {
        let _guard = TEST_SEQ_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let send = reserve_turn_token();
        let floor = RETIRE_BELOW.load(Ordering::Relaxed);
        assert!(!is_retired(send, floor));

        let push = reserve_proactive_token();
        assert!(push > send, "a push still takes a monotonic token");
        assert_eq!(
            RETIRE_BELOW.load(Ordering::Relaxed),
            floor,
            "a push must never retire the turn the user is waiting on",
        );
        assert!(!is_retired(send, RETIRE_BELOW.load(Ordering::Relaxed)));

        // And a send that arrives AFTER the push outranks it at both gates: its floor retires the
        // push, and it may take the slot from it.
        let later = reserve_turn_token();
        let floor = RETIRE_BELOW.load(Ordering::Relaxed);
        assert!(is_retired(push, floor), "the user's newer message retires the push");
        assert!(may_install(TurnKind::Send, later, floor, Some(push), true));
    }

    /// The declined sentinel is matched by the frontend (services/concierge.ts) to stay SILENT: a
    /// refused push is not an error the user should ever see — it means the channel did its job and
    /// got out of the user's way. Mirrors `the_silent_outcome_sentinels_are_the_strings_the_frontend_matches`;
    /// the TS side pins the same literal, and neither half may be deleted as duplication.
    #[test]
    fn the_declined_push_sentinel_is_the_string_the_frontend_matches() {
        assert_eq!(
            PROACTIVE_DECLINED_ERR,
            "concierge_proactive_turn: declined; the user owns the conversation",
        );
    }

    /// Every push costs money, so the count is a first-class number rather than something to infer
    /// from logs later.
    #[test]
    fn proactive_pushes_are_counted() {
        let _guard = TEST_SEQ_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let before = proactive_turns_spawned();
        count_proactive_turn();
        count_proactive_turn();
        assert_eq!(proactive_turns_spawned(), before + 2);
    }

    /// The shared parser (`claude_chat::handle_event`) drives this module's delta emission and
    /// session capture; assert the wiring assumptions hold for the event shapes the concierge
    /// reader feeds it (init → deltas → result), including the failed-result path feeding
    /// `failure_detail`.
    #[test]
    fn reader_seam_captures_session_deltas_and_failure_reason() {
        let mut session_id = String::new();
        let mut final_text = String::new();
        let mut acc = String::new();
        let mut deltas: Vec<String> = Vec::new();
        let events = [
            serde_json::json!({ "type": "system", "subtype": "init", "session_id": "sess-C" }),
            serde_json::json!({
                "type": "stream_event",
                "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": "All quiet." } }
            }),
            serde_json::json!({ "type": "result", "subtype": "success", "session_id": "sess-C", "result": "All quiet." }),
        ];
        for ev in &events {
            handle_event(ev, &mut session_id, &mut final_text, &mut acc, &mut |t| {
                deltas.push(t.to_string());
            });
        }
        assert_eq!(session_id, "sess-C");
        assert_eq!(deltas, vec!["All quiet."]);
        assert_eq!(final_text, "All quiet.");

        // A failed result's own error text reaches the emitted detail, not a generic fallback.
        let ev = serde_json::json!({
            "type": "result", "subtype": "error_during_execution", "is_error": true,
            "errors": ["Error: --resume requires a valid session ID or session title."],
        });
        let (mut subtype, mut is_error, mut detail) = (None, false, None);
        capture_result_status(&ev, &mut subtype, &mut is_error, &mut detail);
        let m = failure_detail("", Some(1), subtype.as_deref(), is_error, detail.as_deref());
        assert_eq!(m, "Error: --resume requires a valid session ID or session title.");
    }
}
