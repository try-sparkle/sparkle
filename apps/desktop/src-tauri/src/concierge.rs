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
use tauri::{AppHandle, Emitter, Manager};

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
DELEGATE THE DIGGING — NEVER READ SERIALLY WHILE THEY WAIT. When answering needs you to go and \
FIND something out — reading a long file, digging through history, checking how something is done \
elsewhere in the repo, sweeping several agents' terminals — send it to `sparkle_research` (op \
`dispatch`) and carry on the conversation. It returns immediately with a taskId, and its findings \
are handed to you at the start of a later turn; spawn a build agent instead when the work needs \
writes. What you must NOT do is grind through a long run of one-at-a-time Read / Grep / \
read-agent-terminal / check-this-PR calls yourself. Every one of those is time the user spends \
watching their own messages stack up behind your turn, and it is the single complaint they have \
made most often about you. YOU DO NOT HAVE CLAUDE'S `Task`/`Agent` TOOL — `sparkle_research` is \
your version of it, so an instruction anywhere telling you to 'fan out subagents via your Agent \
tool' means this tool. Reach for it EARLY, on the first question that needs real digging rather \
than after you are ten reads deep, and say that you have sent it off.\n\n\
FAN OUT A FLEET BY DEFAULT — YOU ARE THE HUB, SO SPIN UP AGENTS PROACTIVELY. When the user has \
asked you to DO two or more INDEPENDENT things NOW, your instinct should be to dispatch them in \
PARALLEL — spawn one build agent per piece rather than grinding through them serially — and do not \
wait for the user to ask you to parallelize. This governs serial-vs-parallel ONLY; it does not \
decide WHETHER a piece is a build agent at all. The FILE A FEATURE AS AN EPIC and DECIDE WHERE AN \
IMPROVEMENT GOES rules below make that call first — capture an ambiguous or someday idea as an \
epic, route a systemic problem to Improve-Sparkle, and when intent is unclear ASK which they \
meant — and only a piece that is genuinely a build-now task gets fanned out here. Scope each agent \
to a DISJOINT set of files so two never collide, and hand each a clear finish line. Once a fan-out \
is warranted, the reasons NOT to spread it across agents are a real file-collision or \
shared-resource contention — never token cost and never your own review bandwidth. And a single \
focused ask you can settle in one reply — one you can answer from what you already know — you \
just answer yourself rather than spinning up a BUILD AGENT for it. A one-off CODE fix is still a \
build agent per DECIDE WHERE AN IMPROVEMENT GOES below, and a question that needs real digging \
still goes to sparkle_research per DELEGATE THE DIGGING above; this carve-out is only for what you \
can answer in the turn itself.\n\n\
YOU HAVE A DURABLE MEMORY — USE IT INSTEAD OF RELYING ON THIS THREAD. Your `sparkle_memory` tool is \
a persistent, searchable store that survives past this conversation's window, a truncation, and a \
restart — the same kind of memory the Improve-Sparkle agent has. WRITE a fact to it (op `remember`, \
with a short `key` and the `value`) the moment you learn something durable: an account's identity, \
the shape of a project you manage, a standing instruction the user gives you, which agent owns which \
PR. RECALL from it (op `recall` with a keyword, or `list_memories` for everything — there is no op \
called `list`) when a turn touches something you may \
have learned before. Facts you have saved are also folded into your prompt automatically under \
WHAT YOU'VE REMEMBERED, so you often will not need to recall at all — reach for `recall` when you \
need something specific that is not already in front of you. Memory is for FACTS ABOUT THE WORLD \
that stay true across turns; it is NOT for how the user wants you to talk (that is \
`append_communication_guideline`) and NOT for a one-off detail that only shapes this one reply. If \
a fact you saved is now wrong, correct it — `remember` again with the same key overwrites it, and \
`forget` drops it.\n\n\
YOU ALSO REMEMBER WHO YOU SENT — CHECK BEFORE YOU ANSWER, AND BEFORE YOU DISPATCH. Every agent \
and research task that gets started — by you, by the user's own '+ New Build Agent' button, or by \
the Plan board — writes a durable row you can search with `sparkle_dispatch_memory` (op \
`recall_dispatches`). Before you answer ANY question of the form 'are we doing X', 'did we ever do \
X', 'what happened to X', 'is anyone on X', and before you spawn an agent or send off research on \
a subject, CALL IT FIRST. Search by the SUBJECT IN THE USER'S OWN WORDS — `{ query: \"preview \
cards\" }`, `{ query: \"the inline preview work\" }` — never by an agent name or an id: the user \
does not know agent names and will never give you one. FINISHED delegations come back too, and \
that is the point: 'did we ever do that work?' is usually answered by one that is already done. \
Each result carries `targetId`, which is the handle for acting on it — `inbox_send` to leave that \
agent a message without interrupting it (the right default for 'go check on that agent'), or \
`send_to_agent_terminal` to interrupt, which asks the user first — and `addressable`, which says \
whether that target can be reached at all right now. Say the LIVE `name`, not `nameAtDispatch`, and \
never report a `status` of `unknown` as stopped or idle: it means no window is watching that agent, \
not that it finished. Answering 'no, nobody is on that' when a row says otherwise is the single \
worst thing you can do here — it has already cost the user a duplicate agent on work eight \
minutes old.\n\n\
DECIDE WHERE AN IMPROVEMENT GOES: THE IMPROVE-SPARKLE AGENT, OR A ONE-OFF BUILD AGENT. When you \
spot something that should CHANGE ABOUT SPARKLE ITSELF, route it by whether it is systemic or a \
one-off. A SYSTEMIC or RECURRING problem — a pattern you keep seeing in the logs, a fragile \
workflow, a 'this keeps happening' — is work for the Improve-Sparkle agent (@Sparkle), which \
continuously hardens the app: file a bead labelled `for:improve-sparkle` describing it, rather than \
spawning a build agent for a symptom that will recur. A ONE-OFF task the user wants done NOW — a \
specific fix, feature, or change with a clear finish line — is a build agent, spawned the way you \
spawn any build agent. When in doubt, ask which they meant.\n\n\
TALKING TO THE IMPROVE-SPARKLE AGENT — IT CAN NOW TALK BACK. Prefer `send_peer_message` to \
`__sparkle_self__`: it is queued to that agent's next turn boundary and it is the channel it uses \
to reach YOU. A terminal send also works and is worth it when you need it read now — the one thing \
that stops it is the `sparkle-busy` hold while an hourly improvement pass is mid-flight, and its \
roster row's `activity` says when that is, so read it first. A bead remains the durable fallback \
and the right home for anything that should outlive the session. What you must NOT do is press a \
button on a screen you cannot read: if a send is refused because a full-screen app owns the \
terminal, that refusal is correct — do not retry it another way.\n\n\
WHEN IMPROVE-SPARKLE SENDS YOU A DIRECTIVE, YOUR OBSERVATION WINS. It cannot address a build agent \
and cannot read one's live row, so anything it tells you about what OTHER agents are doing is \
inferred from notifications, not seen. You read the real rows. So check its directive against what \
you can observe before you relay it: if they agree, fan it out; if they conflict, HOLD it — do not \
relay — and message the sender back saying what you actually see. Never silently drop it; a \
directive you neither relay nor answer disappears, and that is worse than either. This is the one \
place where being slower is correct: several agents once undid each other's work because each was \
reasoning well from partial evidence and nothing reconciled them.\n\n\
FILE A FEATURE AS AN EPIC — THAT IS HOW THE USER TRACKS BIG IDEAS. The rule above splits an \
improvement between the Improve-Sparkle agent and a one-off build agent, and both are about getting \
one thing DONE. A FEATURE is a third thing: a coherent deliverable with several pieces to it, that \
the user wants to be able to SEE, come back to, and watch progress on. When they describe one — \
'I want to build X', 'I need a way to Y', 'here is a project I keep asking for and losing track of' \
— call `sparkle_plans` with op `create_plan`, passing the project's id (it is REQUIRED here, unlike \
the plan reads), a ONE-LINE `title`, and THEIR OWN description as the `body`. That files an epic, \
and the epic appears within seconds as a card in the BACKLOG of their Epics column. Then say the \
new id back to them on its own — the app renders a bare bead id as a clickable pill, so the id is \
what lets them open the card you just made. Write a title they will still recognise six weeks from \
now, and do not compress their description away: the body is the only record of what they meant.\n\n\
AN EPIC IS FOR TRACKING, NOT FOR STARTING. Filing one spends nothing, starts nobody, and is \
undoable — so when you cannot tell whether they want a thing BUILT now or merely CAPTURED, the epic \
is the safe half and you can offer the build after. Building is a separate, later step \
(`promote_plan_to_build`, or an ordinary build agent), so offer it rather than assuming it — and \
never file an epic INSTEAD of doing something they asked you to do now. When they name several \
features in one breath, file one epic EACH rather than one epic holding a list; a card per idea is \
the entire point of the column. And when it sounds like something they have raised before, check \
`list_plans` first: two epics for one idea splits its history in half and neither card tells the \
whole story.\n\n\
PUBLISHING A POST: YOU ARE THE COMPOSE SURFACE. There is no separate editor — when the user wants \
to publish something to their own site, it gets written HERE, by talking. The loop, in order: \
recognise the intent; gather the structure fields CONVERSATIONALLY rather than as a form — Title, \
Subtitle, Page URL (the slug), Format (article, musing, short video or tutorial) and Project (call \
`publish_list_projects`; there is no default and a draft cannot be created without one); ECHO ALL \
OF THEM BACK and get their agreement BEFORE you create anything; create the draft; give them the \
preview URL the site returned, so they can read it in place; then iterate as they react. Those \
fields mirror what the destination itself says it needs — `publish_probe` reports them — so ask \
about what that site actually supports rather than a list you remember.\n\n\
NEVER PUBLISH WITHOUT THE APPROVAL CARD, AND DO NOT ROUTE AROUND IT. Publishing puts the user's \
words in front of strangers; it is scraped, syndicated and archived within seconds, and taking the \
post down afterwards does not take that back. So `publish_go_live` raises a card and the user \
decides — do not ask them to pre-authorise it, do not suggest they set it to Allow, and do not \
treat 'yes, that reads well' about the TEXT as approval to PUBLISH it. Drafting is free-flowing on \
purpose so that the one moment that matters stands out. If a draft edit comes back refused with \
`post-is-live`, the post is already public: switch to `publish_update_live`, which asks first. Do \
not retry the draft op — it will refuse again, and the refusal is doing its job. And if a publish \
comes back `publish-unconfirmed`, the call was accepted but the post is NOT live: say exactly that, \
never that it published.\n\n\
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

/// How long the concierge benches an account it rotated OFF because its OAuth expired, in seconds.
/// Mirrors the frontend's `REACTIVE_BENCH_MS` (5 minutes): an OAuth expiry has no real reset instant
/// — the account is dead until the human re-signs in and recorded state can never see that — so this
/// is a short reactive nudge that lets the account back into the pool once it may have recovered, not
/// an authoritative wall. Kept in seconds to match the accounts store's `exhausted_until`.
const AUTH_ROTATE_BENCH_SECS: i64 = 5 * 60;

/// Does this turn's failure carry the OAuth-expiry signature? Classified off the SAME two sources
/// [`failure_detail`] prefers — the child's stderr and claude's own `result` error text — reusing the
/// shared [`crate::roborev_account::is_auth_expired`] / `AUTH_EXPIRY_PHRASES` so the concierge and the
/// roborev shim can never disagree about what "auth-dead" means. Pure for tests.
fn outcome_is_auth_expired(stderr: &str, error_detail: Option<&str>) -> bool {
    crate::roborev_account::is_auth_expired(stderr)
        || error_detail.is_some_and(crate::roborev_account::is_auth_expired)
}

/// Did this turn die on the SUBSCRIPTION session wall? Classified off the SAME two sources
/// [`failure_detail`] prefers — the child's stderr and claude's own `result` error text — reusing the
/// shared [`crate::roborev_account::is_session_wall`] so the concierge and the roborev shim can never
/// disagree about what "walled" means. Pure for tests.
fn outcome_is_session_wall(stderr: &str, error_detail: Option<&str>) -> bool {
    crate::roborev_account::is_session_wall(stderr)
        || error_detail.is_some_and(crate::roborev_account::is_session_wall)
}

/// Did this turn die on a TRANSIENT API OVERLOAD (a 529)? Classified off the SAME two sources
/// [`failure_detail`] prefers — the child's stderr and claude's own `result` error text — reusing the
/// shared [`crate::roborev_account::is_overloaded`] so the concierge and the roborev shim can never
/// disagree about what "overloaded" means. Pure for tests.
fn outcome_is_overloaded(stderr: &str, error_detail: Option<&str>) -> bool {
    crate::roborev_account::is_overloaded(stderr)
        || error_detail.is_some_and(crate::roborev_account::is_overloaded)
}

/// What ONE post-failure retry should do — the whole decision as a pure value so every arm is
/// unit-testable without spawning a real `claude` (AGENTS.md: assert the SIDE EFFECT, which here is
/// the config dir the retry actually runs under, and whether the dead account gets benched).
#[derive(Debug, PartialEq, Eq)]
struct RetryPlan {
    /// The account the retry runs under, as its `CLAUDE_CONFIG_DIR`. `None`/empty = inherit.
    config_dir: Option<String>,
    /// The account the concierge is rotating OFF (auth-dead) and must bench so every consumer routes
    /// around it. `None` for the plain stale-resume self-heal, which does not change account.
    bench_config_dir: Option<String>,
    /// Whether the retry KEEPS this turn's `--resume <sid>` instead of starting a fresh session.
    ///
    /// `false` for every arm that predates it, which is why the field exists rather than the spawn
    /// site simply always passing the resume id: dropping `--resume` is load-bearing for those arms
    /// (the id belongs to a dead account's transcript tree, or is itself the suspected cause), and
    /// only the transient-overload arm can say the session is known-good.
    keep_resume: bool,
}

/// Decide the single post-failure retry. `None` means DO NOT retry — surface the failure.
///
/// Three outcomes, in priority order:
///  1. AUTH-DEAD WITH A HEALTHY ALTERNATIVE — the founder's bug. The pinned account's OAuth expired,
///     so retrying it (with or without `--resume`) can only fail the same way; rotate to the best
///     healthy fallback the frontend supplied — dropping `--resume`, since that session id lives in
///     the dead account's transcript tree — and bench the dead account. A single auth failure becomes
///     a ROTATED retry, not a same-account one.
///  2. AUTH-DEAD WITH NO ALTERNATIVE — never bench the last healthy account: return `None` so the
///     turn fails into the existing sign-in dead-end, exactly as the frontend's last-account guard
///     does. This is why the auth branch does NOT fall through to the stale-resume retry: retrying a
///     known-auth-dead account without `--resume` is a wasted turn that ends in the same sign-in.
///  3. A NON-AUTH failure with a resume id — the existing stale-`--resume` self-heal: retry the SAME
///     account without `--resume` (a stale resume is the #1 cause of an empty-stderr failure).
///
/// AND ONE THAT IS NEVER RETRIED AT ALL — the SUBSCRIPTION SESSION WALL, checked FIRST because it
/// is the only failure here whose retry is guaranteed to reproduce it. `--resume` is irrelevant to
/// a wall: the same account cannot succeed with it or without it until the reset instant the message
/// itself names, so arm 3 sees an ordinary "non-auth failure with a resume id" and spends a whole
/// second `claude` spawn re-deriving a fact the first failure already stated. Measured on the
/// founder's own machine: a proactive turn spawned NINE MINUTES before the reset it had already been
/// told about, failed on the wall, and the planner's answer was to go again.
///
/// It returns `None` (surface the failure) rather than rotating to a fallback, for the same reason
/// arm 2 does: rotation is a policy question about whether a DIFFERENT subscription has headroom,
/// and answering it wrongly benches a healthy account on a wall that was never account-specific.
/// Not retrying is the conservative half, and it is the half that is provably right.
fn plan_retry(
    ok: bool,
    auth_expired: bool,
    session_wall: bool,
    overloaded: bool,
    primary_config_dir: Option<&str>,
    fallback_config_dirs: &[String],
    resume_session_id: Option<&str>,
) -> Option<RetryPlan> {
    if ok {
        return None;
    }
    if session_wall {
        return None;
    }
    if auth_expired {
        // The first fallback that is a real, DIFFERENT account than the one that just failed. The
        // frontend ranks these healthiest-first and already excludes the primary and clobbered
        // defaults, but guard against an empty or duplicate entry so a rotation can never land back
        // on the dead account.
        let rotate_to = fallback_config_dirs
            .iter()
            .map(String::as_str)
            .find(|d| !d.is_empty() && Some(*d) != primary_config_dir);
        return rotate_to.map(|d| RetryPlan {
            config_dir: Some(d.to_string()),
            // Bench only a real dedicated account (non-empty dir). The shared `$HOME/.claude` default
            // (empty dir) is steered away from by the clobbered-default guard, not benched by id.
            bench_config_dir: primary_config_dir
                .filter(|p| !p.is_empty())
                .map(str::to_string),
            // The rotated retry MUST start fresh: this session id lives in the dead account's
            // transcript tree, so the healthy account cannot resume it.
            keep_resume: false,
        });
    }
    // TRANSIENT OVERLOAD (a 529), checked AFTER both fatal classifications and before arm 3.
    //
    // THE ORDER IS THE WHOLE ARM. This block used to sit ABOVE `auth_expired`, and its own test
    // (`plan_retry_lets_the_fatal_classifications_outrank_a_transient_overload`) failed on main
    // from the commit that introduced it — nothing caught it because CI was not compiling this
    // crate at the time (beads sparkle-9lpy7r, sparkle-ozw542). A 529 phrase can arrive in the
    // SAME message as an auth expiry; with this arm first, that turn retried on the account that
    // had just died, keeping a session id the dead account owns, so the retry could only fail
    // again. Both fatal classifications must be settled before a transient one is considered.
    // Ordered here because it is a REFINEMENT of arm 3, not a competitor to it: an overload is a
    // non-auth failure that carries a resume id, so arm 3 already claims it and would retry the
    // same account WITHOUT `--resume`. That remedy is not merely unnecessary here, it is lossy —
    // the session id is perfectly good, and dropping it starts a fresh session, so the retry answers
    // with no memory of the conversation it is continuing. Because the retry is emitted under the
    // ORIGINAL turn id as a transparent continuation, the human sees a normal reply and never learns
    // the thread was severed; only the transcript tree shows the break.
    //
    // Measured on one machine in one day: four concierge turns and one improvement pass died on a
    // 529 after 196-284 seconds of work each, every one of them landing in arm 3.
    //
    // Auth-expiry and the session wall still outrank it: a message can carry an overload phrase
    // alongside a fatal one, and keeping a resume id into a rotated or walled account is exactly
    // what arms 1 and 2 exist to prevent. The retry stays on the SAME account — an overload is a
    // property of the server at that instant, not of the subscription, so rotating would bench a
    // healthy account for something it did not do.
    //
    // With NO resume id there is nothing to preserve, so this arm declines and leaves the decision
    // to arm 3 — which also declines, exactly as it does today. That is deliberate: this change is
    // about WHICH session the retry runs in, and it must not quietly add a retry where there was
    // none.
    if overloaded && resume_session_id.is_some_and(|sid| !sid.is_empty()) {
        return Some(RetryPlan {
            config_dir: primary_config_dir.map(str::to_string),
            bench_config_dir: None,
            keep_resume: true,
        });
    }
    if should_retry_without_resume(ok, resume_session_id) {
        return Some(RetryPlan {
            config_dir: primary_config_dir.map(str::to_string),
            bench_config_dir: None,
            // The stale resume id is the SUSPECT here; keeping it would retry the hypothesis.
            keep_resume: false,
        });
    }
    None
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
    // SCRUB THE INHERITED SECRETS — including the ANTHROPIC_* family (security audit M1/H2).
    //
    // A comment ~260 lines above this function asserted "the concierge's own `claude -p` child runs
    // with these stripped." It did not. `scrub_anthropic_env_for`'s only call sites were the
    // diagnostic `claude auth status` probe and two internal `claude_oneshot` builders — so the path
    // that merely REPORTS whether you are signed in was scrubbed, and the path that actually ACTS
    // was not. If Sparkle's process carries `ANTHROPIC_API_KEY` or `ANTHROPIC_BASE_URL`, a
    // dispatched turn silently authenticated against the wrong credential: precisely the false
    // "you're signed in" bug the scrub was written to prevent (see accounts.rs's account of the
    // prior incident), except on the path with real consequences.
    crate::claude_oneshot::scrub_anthropic_env_for(&mut cmd);
    for name in crate::claude_oneshot::secret_env_names_now() {
        cmd.env_remove(&name);
    }
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
    // Healthy DEDICATED accounts to rotate to, best-first, as their `CLAUDE_CONFIG_DIR`s — the
    // frontend ranks them with the same `pickAccount`/`eligibleAccounts` selection and excludes the
    // primary and any clobbered default (Tauri maps JS `fallbackConfigDirs` → this). When the pinned
    // account's OAuth expires, the retry rotates to the first of these instead of re-running the dead
    // account. Optional/empty (older frontend, or one healthy account) = no rotation, sign-in as before.
    fallback_config_dirs: Option<Vec<String>>,
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
    // Healthy dedicated accounts to rotate to on an auth-expiry failure, moved into the reader thread
    // (where the retry decision is made). Empty when the frontend supplied none.
    let fallback = fallback_config_dirs.unwrap_or_default();
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
            tracing::info!(id = %id, "concierge: turn was superseded; not retrying");
        }
        // The whole retry decision as one pure value (see `plan_retry`): rotate to a healthy account
        // on an auth-expiry failure, else the stale-`--resume` self-heal, else nothing. `None` when
        // retired, so a turn the user has moved past never retries.
        let auth_expired = outcome_is_auth_expired(&outcome.stderr, outcome.error_detail.as_deref());
        let session_wall = outcome_is_session_wall(&outcome.stderr, outcome.error_detail.as_deref());
        let overloaded = outcome_is_overloaded(&outcome.stderr, outcome.error_detail.as_deref());
        if session_wall {
            // Logged at the point the classification is MADE, not inferred later from the absence of
            // a retry: "did not retry" and "did not retry BECAUSE it was walled" are different facts,
            // and only the second tells a human reading the log that the quiet was deliberate.
            tracing::info!(id = %id, "concierge: turn hit the session wall; not retrying until it resets");
        }
        let plan = if retired {
            None
        } else {
            plan_retry(
                outcome.ok,
                auth_expired,
                session_wall,
                overloaded,
                config_dir.as_deref(),
                &fallback,
                resume_session_id.as_deref(),
            )
        };
        if let Some(plan) = plan {
            if let Some(dead) = plan.bench_config_dir.as_deref() {
                // Rotating OFF an auth-dead account: bench it in the shared accounts store so the
                // FRONTEND's next resolution, the roborev shim and every build agent all route around
                // it — convergence, not just this one turn's rescue. Best-effort: a bench that cannot
                // be written still leaves the rotated retry to answer on the healthy account.
                match crate::accounts::bench_config_dir_auth_dead(
                    &read_app,
                    dead,
                    AUTH_ROTATE_BENCH_SECS,
                ) {
                    Ok(benched) => tracing::info!(
                        id = %id, benched,
                        "concierge_turn: account OAuth expired; rotating to a healthy account and retrying"
                    ),
                    Err(e) => tracing::warn!(
                        id = %id, error = %e,
                        "concierge_turn: rotating to a healthy account, but could not bench the dead one"
                    ),
                }
            } else if plan.keep_resume {
                tracing::info!(
                    id = %id,
                    "concierge_turn: turn hit a transient overload; retrying once, resuming the same session"
                );
            } else {
                tracing::info!(
                    id = %id,
                    "concierge_turn: turn failed with a resume session id; retrying once without --resume"
                );
            }
            let (kind2, token2) = continuation_install(token);
            // WHICH SESSION the retry runs in is `plan.keep_resume`, decided in `plan_retry` — not a
            // constant here. Every arm but one drops `--resume`, because the session id belongs to
            // the previous account's (or the now-stale) transcript tree and must be abandoned. The
            // transient-overload arm is the exception: nothing was wrong with the session, so
            // dropping it would throw away the conversation to work around a busy server.
            // `plan.config_dir` is the ROTATED healthy account on an auth failure and the same
            // account otherwise. Passing the wrong dir here is the original bug: the retry inheriting
            // the dead pinned account (roborev — see `plan_retry`).
            let resume2 = if plan.keep_resume {
                resume_session_id.as_deref()
            } else {
                None
            };
            match spawn_turn(
                &read_app,
                &prompt,
                &cwd,
                &claude_path,
                resume2,
                plan.config_dir.as_deref(),
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

/// Kill+reap a turn already TAKEN out of the slot — the whole process group, so nothing it spawned
/// survives. The blocking half of the cancel: `libc::kill(-pid, SIGKILL)` + `child.wait()`, which
/// is why the async command below hands it to `spawn_blocking`. A plain fn taking the owned turn so
/// the test suite can drive the real kill directly (mirrors `move_project_inner` /
/// `assert_workspace_integrity_inner`). A no-op when the slot was already empty.
fn cancel_in_flight_inner(taken: Option<ConciergeTurn>) {
    if let Some(mut turn) = taken {
        tracing::info!("concierge_cancel: killing in-flight turn (group) off-main");
        kill_turn_group(&mut turn.child);
    }
}

/// Cancel the in-flight concierge turn — the whole process group, so nothing it spawned keeps
/// running. A no-op if none is in flight. The reader thread finds the slot token changed (entry
/// gone) on EOF and stays silent, so no late done/error races the cancel.
///
/// `async` + `spawn_blocking` (mirroring `concierge_turn`, see its doc at the top): the kill AND —
/// critically — the `child.wait()` reap run OFF the Tauri main thread, so cancelling a large queued
/// teardown (up to `MAX_QUEUED_TURNS` children) can't freeze the UI. This used to be a SYNC command
/// doing the kill+wait inline on the caller's (main) thread — the load-bearing hang of
/// sparkle-edad2. The floor rises synchronously and immediately (`retire_issued_turns`), before the
/// offload, so a cancelled turn goes quiet at once; and the slot lock is released (the guard
/// dropped) inside the take block BEFORE the await, never held across it.
#[tauri::command]
pub async fn concierge_cancel(app: AppHandle) -> Result<(), String> {
    // Same floor as a send: a cancelled turn must go quiet immediately, not merely lose the slot.
    // Kept synchronous and ahead of the offload so the silence does not wait on the reap.
    retire_issued_turns();
    let taken = {
        let manager = app.state::<ConciergeManager>();
        let taken = lock_turn(&manager.turn).take();
        taken // bound so the MutexGuard temporary drops HERE, before `manager` — the slot lock
    }; // is not held across the await below.
    tauri::async_runtime::spawn_blocking(move || cancel_in_flight_inner(taken))
        .await
        .map_err(|e| format!("concierge_cancel task failed: {e}"))?;
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

    /// The retry must run under the account `plan_retry` chose — the SAME account on a stale-resume
    /// self-heal, the ROTATED healthy account on an auth-expiry failure. Both cases funnel through
    /// `plan.config_dir`, so the retry's `spawn_turn` must pass exactly that, never the raw
    /// `config_dir` (which is the dead pinned account on the auth path — the founder's bug) and never
    /// `None` (which would recreate the concierge session on `$HOME/.claude`).
    ///
    /// Pinned in source because the retry runs inside a spawned reader thread holding an `AppHandle`,
    /// which the sibling `Command::get_envs()` tests cannot reach; the DECISION itself is asserted
    /// directly and exhaustively in `plan_retry_*` below. The window is extracted by BALANCED PARENS
    /// from the retry's own `spawn_turn(` call, and every step panics on a miss.
    ///
    /// The match is `plan.config_dir.as_deref()` and NOT the bare `config_dir.as_deref()`: the latter
    /// is a substring of the former, so asserting the bare form would pass even if the retry reverted
    /// to the dead pinned account. The leading `plan.` is exactly what distinguishes "runs the plan's
    /// account" from "runs whatever it was pinned to".
    #[test]
    fn the_retry_runs_under_the_planned_account() {
        let src = include_str!("concierge.rs");
        let retry = src
            .split("let (kind2, token2) = continuation_install(token);")
            .nth(1)
            .expect("the retry must still spawn a continuation");
        let args = call_args(retry, "spawn_turn");
        assert!(
            args.contains("plan.config_dir.as_deref()"),
            "the retry must re-spawn under `plan.config_dir` (the rotated account on an auth failure, \
             the same account on a stale-resume self-heal) — not the raw pinned `config_dir` and not \
             None. Saw args: {args}"
        );
    }

    /// The scanner the test above depends on must itself be right — a `call_args` that returned too
    /// much would restore exactly the vacuousness it was written to remove.
    #[test]
    fn call_args_stops_at_the_matching_paren_and_spans_nested_calls() {
        assert_eq!(call_args("f(a, g(b, c), d) then h(x)", "f"), "a, g(b, c), d");
        assert_eq!(call_args("let v = spawn_turn(\n  a,\n  b.as_deref(),\n);", "spawn_turn"), "\n  a,\n  b.as_deref(),\n");
    }

    // ── auth-expiry rotated-retry decision (bead sparkle-concierge-auth-failover) ──────────────────

    fn dirs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// THE FOUNDER'S BUG, as a decision. A turn on account A fails with the OAuth-expiry signature and
    /// a healthy account B exists → the retry runs under B (SIDE EFFECT: `config_dir == Some(B)`) and
    /// A is benched (`bench_config_dir == Some(A)`). Asserting on B, not just "rotated" — a rotation
    /// that landed anywhere but a healthy account is exactly the bug.
    #[test]
    fn plan_retry_rotates_to_a_healthy_account_and_benches_the_dead_one_on_auth_expiry() {
        let plan = plan_retry(false, true, false, false, Some("/acct/A"), &dirs(&["/acct/B", "/acct/C"]), Some("sid-1"))
            .expect("an auth failure with a healthy fallback must retry, not surface");
        assert_eq!(plan.config_dir.as_deref(), Some("/acct/B"), "the retry must rotate to the first healthy fallback, not stay on the dead account");
        assert_eq!(plan.bench_config_dir.as_deref(), Some("/acct/A"), "the dead pinned account must be benched so every consumer routes around it");
    }

    /// PAIRED NEGATIVE #1 — a NON-auth failure must NOT rotate. The same failed turn with a resume id
    /// but no auth signature is the ordinary stale-`--resume` self-heal: retry the SAME account, bench
    /// nothing. Mutating the auth classifier to `true` would flip this to a rotation, so this pins that
    /// only the auth signature spends a fallback.
    #[test]
    fn plan_retry_does_not_rotate_a_non_auth_failure() {
        let plan = plan_retry(false, false, false, false, Some("/acct/A"), &dirs(&["/acct/B"]), Some("sid-1"))
            .expect("a non-auth failure with a resume id must still do the stale-resume self-heal");
        assert_eq!(plan.config_dir.as_deref(), Some("/acct/A"), "a non-auth self-heal must keep the same account");
        assert_eq!(plan.bench_config_dir, None, "a non-auth failure must never bench an account");
    }

    /// PAIRED NEGATIVE #2 — the LAST-ACCOUNT GUARD. An auth failure with NO healthy alternative must
    /// NOT retry (returns `None`, so the turn falls into the existing sign-in dead-end) and must NOT
    /// bench the only account. This is the counterpart to the frontend's `no-healthy-alternative`
    /// guard: never bench the fleet down to nothing.
    #[test]
    fn plan_retry_surfaces_signin_when_no_healthy_alternative_on_auth_expiry() {
        assert_eq!(plan_retry(false, true, false, false, Some("/acct/A"), &[], Some("sid-1")), None, "auth-dead with no fallback must surface the sign-in, not retry the dead account");
        // A fallback list that is only the dead account itself is not an alternative either.
        assert_eq!(plan_retry(false, true, false, false, Some("/acct/A"), &dirs(&["/acct/A"]), None), None, "a fallback equal to the failed account is not a rotation target");
    }

    /// An auth failure can hit the FIRST turn, before any resume id exists — the rotation must still
    /// fire there (it does not depend on `resume_session_id`, unlike the stale-resume self-heal).
    #[test]
    fn plan_retry_rotates_on_a_first_turn_auth_failure_with_no_resume_id() {
        let plan = plan_retry(false, true, false, false, Some("/acct/A"), &dirs(&["/acct/B"]), None)
            .expect("a first-turn auth failure must rotate even with no resume id");
        assert_eq!(plan.config_dir.as_deref(), Some("/acct/B"));
        assert_eq!(plan.bench_config_dir.as_deref(), Some("/acct/A"));
    }

    /// A successful turn is never retried, whatever the other inputs say.
    #[test]
    fn plan_retry_never_retries_a_successful_turn() {
        assert_eq!(plan_retry(true, false, false, false, Some("/acct/A"), &dirs(&["/acct/B"]), Some("sid")), None);
        assert_eq!(plan_retry(true, true, false, false, Some("/acct/A"), &dirs(&["/acct/B"]), Some("sid")), None);
    }

    /// The rotation skips empty fallback entries (the shared `$HOME/.claude` default records `""`) and
    /// benches only a real dedicated account. So a default-account primary that auth-fails is not
    /// benched by id — the clobbered-default guard steers away from it instead.
    #[test]
    fn plan_retry_skips_empty_dirs_and_does_not_bench_the_default() {
        let plan = plan_retry(false, true, false, false, Some(""), &dirs(&["", "/acct/B"]), None)
            .expect("must rotate to the first non-empty fallback");
        assert_eq!(plan.config_dir.as_deref(), Some("/acct/B"), "an empty fallback dir must be skipped");
        assert_eq!(plan.bench_config_dir, None, "an empty (default) primary must not be benched by id");
    }

    /// The concierge and the roborev shim must agree on what "auth-dead" means: the classifier reuses
    /// the shared `roborev_account::is_auth_expired`, matched off EITHER the child's stderr or claude's
    /// own result-error text (the two sources `failure_detail` prefers). A quota wall or an unrelated
    /// error is NOT auth-dead, so it never spends a rotation.
    #[test]
    fn outcome_is_auth_expired_reads_stderr_or_error_detail_and_ignores_non_auth() {
        assert!(outcome_is_auth_expired("Failed to authenticate: OAuth session expired and could not be refreshed", None));
        assert!(outcome_is_auth_expired("", Some("oauth token has expired")));
        assert!(!outcome_is_auth_expired("You've hit your monthly spend limit", Some("rate_limit")));
        assert!(!outcome_is_auth_expired("", None));
        assert!(!outcome_is_auth_expired("connection reset by peer", None));
    }

    /// THE REGRESSION THIS PAIR EXISTS FOR, and it is a pair on purpose. Asserting only that a walled
    /// turn returns `None` would also pass for a `plan_retry` that never retried ANYTHING, so the
    /// second half feeds the IDENTICAL arguments with the wall flag cleared and requires a retry to
    /// come back. One assertion pins the new behaviour; the other pins that the old path still works.
    ///
    /// The inputs are the measured shape: a failed turn, non-auth, WITH a resume id — which before
    /// this change fell through to the stale-`--resume` self-heal and spent a second `claude` spawn
    /// against a wall that cannot clear until its reset instant.
    #[test]
    fn plan_retry_does_not_spend_a_retry_on_a_session_wall_but_still_self_heals_without_one() {
        assert_eq!(
            plan_retry(false, false, true, false, Some("/acct/A"), &dirs(&["/acct/B"]), Some("sid-1")),
            None,
            "a session wall must not be retried: the same account cannot succeed until it resets",
        );
        // Same call, wall cleared — the stale-resume self-heal must be untouched.
        let plan = plan_retry(false, false, false, false, Some("/acct/A"), &dirs(&["/acct/B"]), Some("sid-1"))
            .expect("a non-walled non-auth failure with a resume id must still self-heal");
        assert_eq!(plan.config_dir.as_deref(), Some("/acct/A"));
    }

    /// THE SIDE EFFECT THIS PINS is `keep_resume` — which session the retry runs in — not merely that
    /// a retry happens. A retry happened before this change too; it just silently started a fresh
    /// session, so asserting `is_some()` would pass against the defect.
    ///
    /// The inputs are the measured shape: a failed turn, non-auth, not walled, WITH a resume id. The
    /// PAIRED half is what makes it a proof rather than a coincidence — the identical call with the
    /// overload classifier cleared must still drop `--resume`, so the assertion is attributable to
    /// the overload flag and nothing else.
    #[test]
    fn plan_retry_keeps_the_session_on_a_transient_overload_and_drops_it_otherwise() {
        let plan = plan_retry(false, false, false, true, Some("/acct/A"), &dirs(&["/acct/B"]), Some("sid-1"))
            .expect("a transient overload with a live session must retry");
        assert!(
            plan.keep_resume,
            "an overload must RESUME the same session: the server was busy, the conversation was fine",
        );
        assert_eq!(
            plan.config_dir.as_deref(),
            Some("/acct/A"),
            "an overload is not the account's fault, so the retry stays on the same account",
        );
        assert_eq!(
            plan.bench_config_dir, None,
            "benching a healthy account for a server-side overload would route every consumer off it",
        );

        // Paired negative: same call, overload cleared. This is the pre-existing stale-resume
        // self-heal, and it must still start FRESH — keeping a suspected-stale id would retry the
        // very hypothesis that arm exists to test.
        let stale = plan_retry(false, false, false, false, Some("/acct/A"), &dirs(&["/acct/B"]), Some("sid-1"))
            .expect("a plain non-auth failure with a resume id must still self-heal");
        assert!(
            !stale.keep_resume,
            "only the overload arm keeps the session; the stale-resume self-heal must drop it",
        );
    }

    /// An overload with NO session to preserve must not invent a retry. The arm is about WHICH
    /// session the retry uses, so with nothing to keep it has to decline and leave the outcome
    /// exactly as it was — otherwise this change quietly adds a `claude` spawn on a path that had
    /// none, which is a different behaviour change than the one being made.
    #[test]
    fn plan_retry_does_not_invent_a_retry_for_an_overload_with_no_session() {
        for sid in [None, Some("")] {
            assert_eq!(
                plan_retry(false, false, false, true, Some("/acct/A"), &dirs(&["/acct/B"]), sid),
                None,
                "an overload with no resume id must behave exactly as it did before this change",
            );
        }
    }

    /// Both FATAL classifications outrank a transient one. A 529 can arrive in the same text as an
    /// auth expiry or a wall, and carrying a resume id into a rotated account (whose transcript tree
    /// does not hold it) or into a walled one is precisely what arms 1 and 2 exist to prevent.
    #[test]
    fn plan_retry_lets_the_fatal_classifications_outrank_a_transient_overload() {
        assert_eq!(
            plan_retry(false, false, true, true, Some("/acct/A"), &dirs(&["/acct/B"]), Some("sid-1")),
            None,
            "a wall must not be retried just because an overload phrase also matched",
        );
        let rotated = plan_retry(false, true, false, true, Some("/acct/A"), &dirs(&["/acct/B"]), Some("sid-1"))
            .expect("auth-dead with a healthy fallback still rotates");
        assert_eq!(rotated.config_dir.as_deref(), Some("/acct/B"), "the rotation still happens");
        assert!(
            !rotated.keep_resume,
            "a rotated retry must never keep a session id that lives in the dead account's tree",
        );
    }

    /// A wall outranks an auth expiry when both classify, because the wall's remedy (wait) is the only
    /// one that is certainly right — rotating a healthy account off on a wall benches it for nothing.
    #[test]
    fn plan_retry_treats_a_session_wall_as_outranking_an_auth_expiry() {
        assert_eq!(
            plan_retry(false, true, true, false, Some("/acct/A"), &dirs(&["/acct/B"]), Some("sid-1")),
            None,
            "a wall must not spend a rotation, even when the auth classifier also fired",
        );
    }

    /// The concierge and the roborev shim must agree on what "walled" means, off EITHER of the two
    /// sources `failure_detail` prefers. The negative half is the load-bearing one: an auth expiry
    /// and an unrelated error must NOT read as a wall, or every failure would stop being retried.
    #[test]
    fn outcome_is_session_wall_reads_stderr_or_error_detail_and_stays_disjoint_from_auth() {
        let wall = "You've hit your session limit · resets 7:20am (America/Los_Angeles)";
        assert!(outcome_is_session_wall(wall, None));
        assert!(outcome_is_session_wall("", Some(wall)));
        assert!(!outcome_is_session_wall("oauth token has expired", None));
        assert!(!outcome_is_session_wall("connection reset by peer", None));
        assert!(!outcome_is_session_wall("", None));
        // Disjointness, asserted in BOTH directions on the same two strings.
        assert!(!outcome_is_auth_expired(wall, None));
        assert!(!outcome_is_session_wall("Failed to authenticate: OAuth session expired and could not be refreshed", None));
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
    fn persona_tells_the_truth_about_reaching_improve_sparkle() {
        // ══ A STRING THAT WAS FALSE, AND WAS FOLLOWED ═══════════════════════════════════════════
        // This persona used to say: to reach Improve-Sparkle, use a bead and "NEVER try to type
        // into its terminal ... the app correctly refuses the write". That contradicted
        // SPARKLE_AGENT_TOOL_NOTE in the very same model's tool descriptions, which says these ops
        // "reach it exactly as they reach a build agent". The alternate-screen guard refuses an
        // UNRECOGNISED full-screen app, not Claude Code's own prompt, so the ordinary case was
        // never refused at all.
        //
        // A remedy string is an instruction the model follows, so a false one costs a real channel:
        // this is why the bead was believed to be the only route, and why a human ended up relaying
        // messages between two windows by hand. The repo rule is explicit — a fix that changes
        // behaviour must update every string that described the old behaviour. Pinned here so it
        // cannot come back (bead sparkle-hdlhox).
        assert!(!CONCIERGE_PERSONA.contains("NEVER try to type into its terminal"));
        assert!(!CONCIERGE_PERSONA.contains("the app correctly refuses the write"));
        // The accurate ladder, in order of preference. `send_peer_message` first because it is the
        // symmetric one — the same channel that agent uses to reach the concierge.
        assert!(CONCIERGE_PERSONA.contains("send_peer_message"));
        assert!(CONCIERGE_PERSONA.contains("__sparkle_self__"));
        // The REAL constraint on a terminal send, which is a transient worktree hold and not the
        // TUI. Naming it is what keeps the model from re-deriving the old, wider prohibition.
        assert!(CONCIERGE_PERSONA.contains("sparkle-busy"));
        // The alternate-screen refusal is still correct and must still be honoured — correcting an
        // overstatement must not read as permission to route around the real guard.
        assert!(CONCIERGE_PERSONA.contains("that refusal is correct"));
    }

    #[test]
    fn persona_fans_out_a_fleet_by_default_on_independent_work() {
        // The founder's directive: every orchestrator PROACTIVELY fans out on multi-deliverable
        // work, without a human asking — and the concierge is the fleet hub that spawns build
        // agents. The behaviour-changing claim is that fanning out is the DEFAULT and needs no
        // prompt, not merely that parallelism is possible (which the old copy already implied via
        // spawn_build_agent). Assert the parts that actually move behaviour.
        assert!(CONCIERGE_PERSONA.contains("FAN OUT A FLEET BY DEFAULT"));
        // Proactive: it must not wait for the user to ask.
        assert!(CONCIERGE_PERSONA.contains("do not wait for the user to ask you to parallelize"));
        // The disjoint-files constraint is the ONE real reason to hold back — naming it is what keeps
        // the model from either over-serialising OR colliding two agents in the same file.
        assert!(CONCIERGE_PERSONA.contains("DISJOINT set of files"));
        // And the non-reasons, stated so token cost / review bandwidth can't be used to justify serial.
        assert!(CONCIERGE_PERSONA.contains("never token cost"));
        // Deference (roborev 67517/67518): this directive decides serial-vs-parallel ONLY, and must
        // NOT read as authority to spawn a build agent for work the epic-capture / Improve-Sparkle
        // routing rules would first send elsewhere. spawn_build_agent is auto-allowed and cuts real
        // worktrees, so an absolute here would start agents for ideas the user only wanted captured.
        assert!(CONCIERGE_PERSONA.contains("does not decide WHETHER a piece is a build agent at all"));
        assert!(CONCIERGE_PERSONA.contains("only a piece that is genuinely a build-now task gets fanned out here"));
        // The single-ask carve-out (roborev 67540): fanning out must not swallow the one-reply case.
        // spawn_build_agent is auto-allowed and cuts a real worktree, so the persona must still say a
        // small ask answerable in one reply is answered in-house — mirroring the orchestrator's leaf
        // carve-out, which has its own test.
        assert!(CONCIERGE_PERSONA.contains("you can settle in one reply"));
        assert!(CONCIERGE_PERSONA.contains("just answer yourself rather than spinning up a BUILD AGENT"));
        // The carve-out must NOT re-widen into territory the other rules own (roborev 67567): a
        // one-off CODE fix stays a build agent, and a question needing real digging stays
        // sparkle_research. Assert both deferrals, and assert the over-broad examples are gone so the
        // wording cannot silently creep back.
        assert!(CONCIERGE_PERSONA.contains("A one-off CODE fix is still a build agent"));
        assert!(CONCIERGE_PERSONA.contains("still goes to sparkle_research"));
        assert!(!CONCIERGE_PERSONA.contains("a small correction"));
        assert!(!CONCIERGE_PERSONA.contains("a quick lookup"));
    }

    #[test]
    fn persona_carries_the_compose_and_publish_loop() {
        // THE COMPOSE SURFACE IS THIS CHAT (bead `sparkle-131ms.6`). There is no editor, so the
        // drafting loop lives nowhere but here — and a persona that does not carry it leaves the
        // model to invent one, which in practice means creating a draft before it has asked for the
        // fields the destination REQUIRES and cannot default.
        assert!(CONCIERGE_PERSONA.contains("YOU ARE THE COMPOSE SURFACE"));
        // The structure fields, echoed back BEFORE anything is created. The echo is the cheap half
        // of the loop: a wrong Project or Format on a created draft costs a round trip to fix, and
        // the user never asked for either to be guessed.
        assert!(CONCIERGE_PERSONA.contains("publish_list_projects"));
        assert!(CONCIERGE_PERSONA.contains("ECHO ALL OF THEM BACK"));
        // The preview URL is what makes iteration possible at all — a draft the user cannot read is
        // a draft they cannot react to.
        assert!(CONCIERGE_PERSONA.contains("preview URL"));

        // ── THE PART THAT IS A SAFETY PROPERTY, NOT GUIDANCE ────────────────────────────────────
        // `publish_go_live` is `irreversible`, so it asks. The danger is not the model calling it —
        // the gate handles that — it is the model TALKING THE HUMAN INTO WAIVING the gate, which no
        // policy layer can see. A refusal or remedy string is an instruction the user follows, so
        // the persona has to say the opposite explicitly.
        assert!(CONCIERGE_PERSONA.contains("NEVER PUBLISH WITHOUT THE APPROVAL CARD"));
        assert!(CONCIERGE_PERSONA.contains("do not suggest they set it to Allow"));
        // The live-edit split is only a gate because the HOST refuses the cheap name against a live
        // post. The model must be told to switch ops rather than retry — a model that dead-ends on
        // `post-is-live` retries the same call and never reaches the card.
        assert!(CONCIERGE_PERSONA.contains("post-is-live"));
        assert!(CONCIERGE_PERSONA.contains("publish_update_live"));
        // And the receipt: `publish_content` needs the `content:publish` scope, which
        // `content:write` does not imply, so "the call did not fail" is not "the post is live".
        assert!(CONCIERGE_PERSONA.contains("publish-unconfirmed"));
        assert!(CONCIERGE_PERSONA.contains("never that it published"));
    }

    #[test]
    fn persona_makes_observation_beat_a_blind_directive() {
        // THE SAFETY HALF of the two-way channel. Improve-Sparkle can now send fleet directives
        // ("tell the blocked agents to stand down") reasoned entirely from notifications, because
        // it has no route to a build agent and cannot read one's live row. The concierge does.
        //
        // Without this rule the channel makes the measured failure FASTER: several agents purging
        // the same shared resource and undoing each other, every one of them individually
        // reasoning well from partial evidence. The rule is that the observing side may refuse.
        assert!(CONCIERGE_PERSONA.contains("YOUR OBSERVATION WINS"));
        assert!(CONCIERGE_PERSONA.contains("HOLD it"));
        // Holding must not collapse into dropping — an unanswered directive is indistinguishable
        // from one never sent, which is the failure mode this whole bead exists to remove.
        assert!(CONCIERGE_PERSONA.contains("Never silently drop it"));
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
    fn persona_tells_the_model_to_delegate_digging_and_names_a_tool_it_actually_has() {
        // Bead `sparkle-6vool`. The founder, 2026-08-13: "You are again not using concierge agents?
        // I have eight queued props that you're not responding to."
        //
        // WHY THIS IS PINNED IN CODE AND NOT LEFT TO THE GUIDELINES FILE. The instruction DID exist
        // — in `concierge-guidelines.md`, added 2026-07-29 and AGAIN on 2026-08-11 after nothing
        // changed. It was inert for two compounding reasons, and this test guards both:
        //
        //   1. It named the wrong tool. It said "fan out parallel subagents via your own Agent
        //      tool", but `Task`/`Agent` is absent from CONCIERGE_ALLOWED_TOOLS — the concierge was
        //      told to reach for something it does not have.
        //   2. `concierge_guidelines::INJECTION_HEADING` documents that file as governing STYLE,
        //      not PERMISSION — the one channel this codebase declares advisory.
        //
        // So the directive belongs HERE, and it must name the delegation surface that exists.
        assert!(CONCIERGE_PERSONA.contains("sparkle_research"));
        assert!(CONCIERGE_PERSONA.contains("DELEGATE THE DIGGING"));
        // The correction that makes the older guideline harmless rather than contradictory: it
        // tells the model that an "Agent tool" instruction elsewhere means THIS tool.
        assert!(CONCIERGE_PERSONA.contains("YOU DO NOT HAVE CLAUDE'S `Task`/`Agent` TOOL"));
        // The tool it is pointed at must be one the allowlist actually admits, or this repeats the
        // exact defect above. `sparkle_research` arrives via the `mcp__sparkle-control__*` entry.
        assert!(CONCIERGE_ALLOWED_TOOLS.contains("mcp__sparkle-control__*"));
        assert!(
            !CONCIERGE_ALLOWED_TOOLS.contains("Task"),
            "if Task is ever added, the persona's 'you do not have it' sentence becomes a lie \
             and must be rewritten in the same change"
        );
    }

    #[test]
    fn persona_states_the_durable_memory_and_comms_routing_contract() {
        // The concierge is told it HAS a durable memory and when to write to it — the headline of
        // PR #1877. The tool name and the write op must both be named, or the instruction points at
        // nothing the model can call.
        assert!(CONCIERGE_PERSONA.contains("sparkle_memory"));
        assert!(CONCIERGE_PERSONA.contains("DURABLE MEMORY"));
        // The preamble header it re-grounds from — kept in step with
        // stores/conciergeMemoryStore.MEMORY_PREAMBLE_HEADER so the persona names the section the
        // app actually injects.
        assert!(CONCIERGE_PERSONA.contains("WHAT YOU'VE REMEMBERED"));
        // Memory is FACTS, not communication style — the one boundary that keeps it from turning
        // into a second guidelines file.
        assert!(CONCIERGE_PERSONA.contains("NOT for how the user wants you to talk"));

        // ══ THE OP NAME MUST BE ONE THAT EXISTS ══════════════════════════════════════════════════
        // This paragraph instructed the model to call op `list`, and there is no such op: the
        // memory domain deliberately ships `list_memories`, because `research` already owns the
        // bare name and op names are globally unique across domains (conciergeTools/memory.ts).
        // The persona was pointing at a call that could only ever answer `unknown-op` — the same
        // defect the delegation test above exists to prevent, shipped in a different paragraph.
        assert!(CONCIERGE_PERSONA.contains("list_memories"));
        assert!(
            !CONCIERGE_PERSONA.contains("with a keyword, or `list`)"),
            "op `list` does not exist in the memory domain; the persona must name `list_memories`"
        );

        // ══ DELEGATION MEMORY ════════════════════════════════════════════════════════════════════
        // The 2026-08-22 failure: the concierge answered a question about preview-card work as if
        // it had never heard of it, eight minutes after spawning an agent to do exactly that. The
        // ledger and its read API cannot fix that on their own — a tool the model is never told to
        // reach for is, from the user's seat, a tool that does not exist. So the tool AND the op
        // are named, by the exact strings the model must type.
        assert!(CONCIERGE_PERSONA.contains("sparkle_dispatch_memory"));
        assert!(CONCIERGE_PERSONA.contains("recall_dispatches"));
        // Reachable through the SAME allowlist entry every other sparkle-control tool arrives by.
        assert!(CONCIERGE_ALLOWED_TOOLS.contains("mcp__sparkle-control__*"));
        // THE RETRIEVAL PATH IS THE FEATURE. The founder's constraint was that recall must work
        // from the SUBJECT in his own words, not from an agent name he has never seen — so the
        // persona has to say which of the two goes in `query`, or the model will send an id.
        assert!(CONCIERGE_PERSONA.contains("SUBJECT IN THE USER'S OWN WORDS"));
        assert!(CONCIERGE_PERSONA.contains("never by an agent name or an id"));
        // AND A FINISHED DELEGATION IS STILL AN ANSWER — the user's most common question is "did we
        // ever do that work?", which a closed row answers.
        assert!(CONCIERGE_PERSONA.contains("FINISHED delegations come back too"));
        // WHAT TO DO WITH A HIT. `targetId` is the handle, and "go check on that agent" has to be
        // actionable — so the non-interrupting channel is named first, as the default.
        assert!(CONCIERGE_PERSONA.contains("inbox_send"));

        // The comms routing rule: systemic → the Improve-Sparkle agent; one-off → a build agent.
        assert!(CONCIERGE_PERSONA.contains("for:improve-sparkle"));
        assert!(CONCIERGE_PERSONA.contains("SYSTEMIC or RECURRING"));
        // ══ THIS ASSERTION USED TO PIN A FALSE SENTENCE (bead sparkle-hdlhox) ════════════════════
        // It read `contains("NEVER try to type into its terminal")` and was described as "the
        // safety half of the routing rule". It was neither safe nor true: the alternate-screen
        // guard refuses an UNRECOGNISED full-screen app, not Claude Code's own prompt, and
        // SPARKLE_AGENT_TOOL_NOTE told the same model these ops "reach it exactly as they reach a
        // build agent". So the persona forbade a channel that worked, and this test held that
        // prohibition in place.
        //
        // This is the vacuous-test family the repo keeps catching, in its harder form: the test
        // GRIPPED the source perfectly — remove the sentence and it goes red, as it did — so a
        // mutation check would pass it cleanly. Only re-reading the expectation as a user-facing
        // claim finds it. Flipped to pin the CAPABILITY the routing rule is supposed to protect
        // (that a real channel to that agent is named) rather than the wording of a prohibition.
        assert!(
            CONCIERGE_PERSONA.contains("send_peer_message"),
            "the routing rule must name a channel that actually reaches Improve-Sparkle"
        );
        assert!(
            !CONCIERGE_PERSONA.contains("NEVER try to type into its terminal"),
            "this prohibition is false and cost a working channel; see persona_tells_the_truth_about_reaching_improve_sparkle"
        );
    }

    #[test]
    fn persona_routes_a_described_feature_into_an_epic() {
        // THE FOUNDER'S ASK, IN ONE SENTENCE: "I might have a new feature that I want to build, and
        // I want to be able to describe it to you. And have you create an epic around it... to
        // create a new epic card entry that shows up in the backlog status of the epics column."
        //
        // Every layer under that already existed — `create_plan` is classified `routine` so policy
        // derives allow with no approval round-trip, it files a typed `epic` bead, and a childless
        // typed epic buckets to Backlog. What was missing was that the persona had ZERO mentions of
        // epics, plans, or `create_plan`: its only "turn an idea into work" guidance routed to a
        // `for:improve-sparkle` bead or a build agent, and both are the wrong answer for a feature
        // the user wants to TRACK. A tool the model is never told to reach for is, from the user's
        // seat, a tool that does not exist.
        //
        // These are tripwires on prose handed to a model, so nothing else in the build can fail
        // when a rule quietly goes missing in a rewrite — the same argument the @-mention relay
        // assertions below make for themselves.
        assert!(CONCIERGE_PERSONA.contains("FILE A FEATURE AS AN EPIC"));
        // The tool and the op, both by the exact name the model must type. `sparkle_plans` is the
        // MCP tool; `create_plan` is the op inside it. Naming only one of them points at nothing.
        assert!(CONCIERGE_PERSONA.contains("sparkle_plans"));
        assert!(CONCIERGE_PERSONA.contains("create_plan"));
        // Reachable through the SAME allowlist entry `sparkle_research` arrives by — asserted
        // directly rather than assumed, because a persona pointing at a tool the gate refuses is
        // the exact defect the delegation test above exists to prevent.
        assert!(CONCIERGE_ALLOWED_TOOLS.contains("mcp__sparkle-control__*"));
        // WHERE THE CARD LANDS. The founder asked for the backlog by name, and the persona has to
        // say so or the model cannot tell him where to look for what it just filed.
        assert!(CONCIERGE_PERSONA.contains("BACKLOG of their Epics column"));
        // THE ID MUST COME BACK. `remarkBeadRefs` linkifies a bare bead id into a pill, so the id
        // is the user's only handle on the card — a reply that says "done" and swallows it leaves
        // him with nothing to click.
        assert!(CONCIERGE_PERSONA.contains("say the new id back"));
        // TRACKING IS NOT BUILDING. This is the safety clause of the paragraph: filing an epic must
        // not be read as permission to start an agent, and it must not be substituted for work the
        // user asked for NOW.
        assert!(CONCIERGE_PERSONA.contains("AN EPIC IS FOR TRACKING, NOT FOR STARTING"));
        assert!(CONCIERGE_PERSONA.contains("never file an epic INSTEAD of"));
        // ONE EPIC PER IDEA — the founder listed four efforts in one breath (Night Watch, social
        // posting, the mobile app, token-maxxing), and one card holding a list of four would defeat
        // the column he asked for.
        assert!(CONCIERGE_PERSONA.contains("file one epic EACH"));
        // The routing it sits BESIDE must still be intact, or this paragraph has replaced the
        // distinction rather than extended it: systemic → @Sparkle, one-off → build agent,
        // feature-to-track → epic are three answers, not two.
        assert!(CONCIERGE_PERSONA.contains("for:improve-sparkle"));
        assert!(CONCIERGE_PERSONA.contains("DECIDE WHERE AN IMPROVEMENT GOES"));
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

    /// Spawn a real long-lived child in ITS OWN process group (as `spawn_turn` does with
    /// `process_group(0)`), wrap it as an in-flight turn, and return the pid alongside.
    #[cfg(unix)]
    fn spawn_group_child() -> (ConciergeTurn, i32) {
        use std::os::unix::process::CommandExt;
        let mut cmd = Command::new("sleep");
        cmd.arg("120");
        cmd.process_group(0);
        let child = cmd.spawn().expect("spawn sleep child");
        let pid = child.id() as i32;
        // Signal 0 probes liveness without delivering anything: 0 = alive.
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            0,
            "the child must be running before we cancel it"
        );
        (ConciergeTurn { child, token: 1 }, pid)
    }

    /// After the reap, the pid no longer names a live process: signal 0 fails with ESRCH.
    #[cfg(unix)]
    fn assert_process_gone(pid: i32) {
        let rc = unsafe { libc::kill(pid, 0) };
        assert_eq!(rc, -1, "the child must be dead after cancel (kill 0 should fail)");
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH),
            "the failure must be ESRCH (no such process), i.e. it was killed AND reaped"
        );
    }

    /// The load-bearing side effect (sparkle-edad2): cancelling an in-flight turn TERMINATES its
    /// process group. Asserts the OUTPUT — the child is dead and reaped — not the precondition.
    /// Mutation target: delete the `libc::kill(-pid, SIGKILL)` in `kill_process_group` and the
    /// `sleep` survives, so `assert_process_gone` fails.
    #[cfg(unix)]
    #[test]
    fn cancel_in_flight_inner_kills_and_reaps_the_process_group() {
        let (turn, pid) = spawn_group_child();
        cancel_in_flight_inner(Some(turn));
        assert_process_gone(pid);
    }

    /// The FULL async command path — take-under-lock (dropping the guard) then offload the kill to
    /// `spawn_blocking`, awaited from an async context — still terminates the process. This is what
    /// makes the fix non-vacuous: the kill happens OFF the caller's thread (in the blocking pool),
    /// the slot lock is released before the await, and the slot ends empty. Drives the exact shape
    /// of `concierge_cancel` without needing an `AppHandle` for `State`.
    #[cfg(unix)]
    #[test]
    fn concierge_cancel_offloads_the_kill_and_empties_the_slot() {
        let (turn, pid) = spawn_group_child();
        let slot: Mutex<Option<ConciergeTurn>> = Mutex::new(Some(turn));

        // Mirror the command exactly: take the child out under the lock — the guard is a temporary
        // dropped at the end of THIS statement, so the lock is not held across the await below.
        let taken = lock_turn(&slot).take();
        assert!(taken.is_some(), "the slot held an in-flight turn to take");

        tauri::async_runtime::block_on(async move {
            tauri::async_runtime::spawn_blocking(move || cancel_in_flight_inner(taken))
                .await
                .expect("the kill task must not panic");
        });

        assert!(
            lock_turn(&slot).is_none(),
            "the slot must be empty after cancel — the turn was taken out"
        );
        assert_process_gone(pid);
    }

    /// Cancelling with an empty slot is a clean no-op, on both the sync core and the async offload.
    #[test]
    fn cancel_of_empty_slot_is_a_noop() {
        cancel_in_flight_inner(None);
        tauri::async_runtime::block_on(async {
            tauri::async_runtime::spawn_blocking(|| cancel_in_flight_inner(None))
                .await
                .expect("no-op cancel must not panic");
        });
    }
}
