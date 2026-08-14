//! THE LADDER — when to look, when to type, and when to give up and flag a human.
//!
//! Pure: data in, decision out. The clock, the hash, the gate verdict and the write history all
//! arrive as parameters, so every rule below is tested as arithmetic rather than by waiting out a
//! real ten-minute rung. That is the same shape `apiRecovery.ts` chose for the same reason, and it
//! is why the tests at the bottom of this file can replay tonight's outage in microseconds.
//!
//! ── THE CORRECTION THAT MAKES THIS SAFE ───────────────────────────────────────────────────────
//! The founder's original proposal was to PING on an expanding interval. The accepted design pings
//! on a much later rung than it LOOKS, and the distinction is the whole safety story: an agent can
//! legitimately emit nothing for well over a minute while a shell command runs — the founder has
//! watched one sit at 1m 24s — and typing into that interrupts real work and corrupts the command
//! line. So the ladder governs how often we LOOK. Writing starts at rung 4 and never before.
//!
//!   rungs 1-3   5s, 10s, 20s      OBSERVE ONLY. No byte is ever written. This is the baseline.
//!   rungs 4-6   30s, 60s, 120s    A BARE ENTER, and only onto a prompt that already has text.
//!   rungs 7-8+  300s, 600s, 600s… THE FIXED NUDGE STRING, then escalation.
//!
//! ── WHY A BARE ENTER IS THE HIGH-VALUE RUNG ───────────────────────────────────────────────────
//! It costs zero tokens and it clears an entire observed failure class. On the night this was
//! specified, FIVE agents sat red holding correct answers that had been typed into their prompt and
//! never submitted (sparkle-bhhu1). Each looked like it was waiting on the founder. None was. An
//! Enter on a non-empty prompt with no picker on screen resolves every one of them.
//!
//! And it is ONLY sent onto a NON-EMPTY prompt. A bare Enter into an empty prompt is, in the bead's
//! words, "a no-op at best and confirms a dialog at worst" — the dialog case being the one that
//! costs something, because confirming a picker nobody read is exactly the harm the gate exists to
//! prevent.
//!
//! ── THE LADDER LISTENS (2026-08-07) ───────────────────────────────────────────────────────────
//! Everything above is about WHEN TO TYPE. The other half — added after the founder screenshotted
//! one agent taking ~14 consecutive pings, every one labelled `#1`, every one answered
//! `not-blocked — complete; goal marked met, nothing left to resume.` — is about WHEN TO STOP.
//!
//! THE COST IS THE POINT. A nudge is not a notification; it is a FULL AGENT TURN, with context
//! loaded, a model called and a reply generated. Fourteen of those on one agent, across a fleet of
//! dozens, draws down the same account quota every interactive agent is sharing — and the day
//! before that screenshot the account hit a usage wall that cost roughly ten hours of fleet time.
//! Pinging an agent that has already said it is done is not merely untidy; it is a direct
//! contributor to that wall.
//!
//! Three defects produced the loop, and they are separable:
//!
//!   1. `goal_met` WAS NOT READ. The agent said the goal was met, the store agreed, and the ladder
//!      typed "Resume your goal" anyway. There is nothing to resume.
//!   2. THE ANSWER WAS NOT READ. The nudge has always ended by demanding one line from a fixed
//!      vocabulary, and nothing on any path parsed it. `parse_reply` closes that, and `Standdown`
//!      acts on it: `blocked-on-human` flags the founder at the FIRST answer instead of re-typing,
//!      `blocked-on-quota` backs off to `QUOTA_BACKOFF_SECS`.
//!   3. THE COUNTER RESET ON ITS OWN FOOTSTEPS. This is the subtle one, and it is why `#1` repeated
//!      rather than climbing. A nudge is typed into the PTY, so it ECHOES, and the answer it demands
//!      is more output still — all of which moves the 4KB tail hash that the episode reset keys on.
//!      The `4m 5s` in every ping is the proof: 5+10+20+30+60+120 = 245s is exactly the climb from
//!      rung 1. So a hash change caused by the agent ANSWERING us now restarts only the silence
//!      clock and leaves the nudge history standing (see `conversation` in `step`), while output we
//!      did NOT provoke is still a full reset — a working agent earns a clean slate.
//!
//! ── AND THE RULE THAT BOUNDS ALL OF IT ────────────────────────────────────────────────────────
//! NONE OF THIS MAY MAKE A STALLED AGENT QUIET. Sparkle's standing rule is that a row the founder
//! owes is never hidden, so every mechanism above is one-sided: it stops the TYPING and never the
//! TELLING. `GIVE_UP_AFTER` stops writing but keeps `flagged` at the level reached. `blocked-on-
//! human` is LOUDER than the behaviour it replaced, not quieter. `parse_reply` fails closed toward
//! nudging. An agent that is stuck and NOT reporting `not-blocked` is treated exactly as before.

/// How long to wait before LOOKING again, per rung. The last entry repeats forever.
///
/// Wall-clock seconds, from the bead verbatim. Do not "tune" these without the founder: the shape
/// is deliberate — dense early so a genuinely wedged agent is caught within a minute, sparse later
/// so a long-running-but-healthy agent is left alone and a permanently dead one costs one look
/// every ten minutes for the life of the process.
pub const LADDER_SECS: [u64; 8] = [5, 10, 20, 30, 60, 120, 300, 600];

/// Rungs (0-indexed) below this NEVER write. Covers 5s, 10s and 20s.
const FIRST_WRITING_RUNG: usize = 3;

/// Rung (0-indexed) from which the fixed nudge string is sent instead of a bare Enter. Index 6 is
/// the 300s rung — "from 5 minutes", per the bead.
const FIRST_NUDGE_RUNG: usize = 6;

/// Nudges with no output change before the concierge is flagged.
const ESCALATE_CONCIERGE_AFTER: u32 = 2;

/// Nudges with no output change before the founder is flagged. The nudger never addresses a human
/// itself — it raises a flag that the pusher/concierge loop (sparkle-4cd0x) consumes.
const ESCALATE_FOUNDER_AFTER: u32 = 4;

/// Nudges after which the ladder STOPS WRITING for the rest of the episode — the terminal rung.
///
/// ── WHY A LADDER MUST END ─────────────────────────────────────────────────────────────────────
/// Without this the top rung repeats forever: an agent nobody can unstick is re-typed at every 600s
/// for the life of the process, and every one of those is a FULL AGENT TURN — context loaded, model
/// called, reply generated. Past the founder flag there is nothing left for another identical ping
/// to achieve that the flag has not already achieved; the row is on a human's surface and the only
/// thing more nudging adds is token burn against the same account quota the fleet is drawing on.
///
/// It does NOT go quiet: `flagged` stays at whatever level was reached, so `apply_flags` keeps
/// raising the row on every look. Sparkle's standing rule is that a row a human owes is never
/// hidden — this stops the TYPING, not the TELLING.
const GIVE_UP_AFTER: u32 = 8;

/// Consecutive looks of UNPROVOKED output before the nudge history is wiped.
///
/// -- WHY ONE CHANGED LOOK IS NOT EVIDENCE OF A WORKING AGENT ----------------------------------
/// This is the founder's `#1`-forever symptom, and the reason the first repair did not finish the
/// job. `wrote_last_look` correctly attributes the ECHO of our own nudge -- but it covers exactly
/// ONE look, and the climb from a nudge back to the next nudge rung is SEVEN (5+10+20+30+60+120 =
/// 245s, the `4m 5s` in every screenshotted ping). That leaves six looks in which any single hash
/// change wipes `attempts` back to zero, so the next ping is `#1` again, forever.
///
/// A live pane moves in all six of them for reasons that are not the agent working: Claude Code
/// repaints its footer and its context-remaining counter, and the hash covers the roster STATUS as
/// well as the PTY tail, so an agent blinking out of the roster (a WebView reload, a republish gap)
/// changes it with no output at all. So the ladder pinged indefinitely, never escalated, and no
/// human was ever told -- which is exactly the fleet sitting idle for hours.
///
/// A working agent emits on CONSECUTIVE looks; an idle repaint emits once and goes quiet again. So
/// the reset keys on a run of activity rather than on a single sample. Three is the smallest run
/// that a redraw split across two looks cannot fake, and the cost of erring high is one preserved
/// episode on an agent that has to be silent another 245s before it is nudged at all.
const LIVE_LOOKS_TO_RESET: u32 = 3;

/// How long to wait between looks once an agent has told us it is out of quota.
///
/// Quota is the one blocker where re-asking is actively counterproductive: the reply costs a turn
/// against the very budget that is exhausted. Half an hour is the shortest interval that is not
/// simply the top rung again, and a quota window that reopens sooner will be caught by the agent's
/// own output resetting the episode long before this elapses.
const QUOTA_BACKOFF_SECS: u64 = 1800;

/// The workflow stages, in order, as `engine/workflowStage.ts` defines them.
///
/// -- WHY THE NATIVE SIDE NEEDS THESE AT ALL ----------------------------------------------------
/// Everything else in this module measures ONE thing: whether the terminal produced bytes. That
/// misses the failure the founder named -- "a row that is not green and is not at least merged to
/// main is a problem" -- because a row can be gray with unlanded work while its pane keeps
/// repainting, and a repaint resets the silence clock. Such an agent is invisible to the ladder no
/// matter how long it sits there.
///
/// The web layer already reasons about this (`engine/workflowStage.ts::hasUnmergedCommittedWork`,
/// `engine/unmergedAttention.ts`), but it is a WEB-LAYER overlay -- and the web layer is exactly
/// what freezes in the failure this watcher exists to survive. So the two halves never met: the
/// component that knows "gray and owes work" cannot act when it matters, and the component that
/// can act could not see it. These two facts already arrive on the roster slice the nudger reads;
/// they were simply being dropped.
pub const WORKFLOW_STAGES: [&str; 10] = [
    "thought",
    "specd",
    "planned",
    "building_unsaved",
    "building_saved",
    "pushed",
    "pull_request",
    "merged_local",
    "merged",
    "shipped",
];

/// Rank of a stage in `WORKFLOW_STAGES`. `None` for an unknown or absent stage, which is treated
/// as NO EVIDENCE everywhere below -- never as stage zero, which would read an unknown string as
/// "has made no progress at all" and flag a healthy agent.
pub fn stage_rank(stage: &str) -> Option<usize> {
    WORKFLOW_STAGES.iter().position(|s| *s == stage)
}

/// Intern a roster stage string to its `'static` form, or `None` if we do not know it.
///
/// The roster hands us owned `String`s, and this module's `Observation` is rebuilt for every agent
/// on every look — on a thread whose whole justification is staying cheap on a fleet of dozens. So
/// the known vocabulary is matched by identity rather than cloned, and an UNKNOWN stage becomes
/// `None`, which every rule below reads as no evidence rather than as stage zero.
pub fn intern_stage(stage: &str) -> Option<&'static str> {
    WORKFLOW_STAGES.iter().copied().find(|s| *s == stage)
}

/// The row discs `rollup_dot` can carry — the Rust twin of `workerRollup.ts::RollupDot`.
///
/// `blue` (the `questions` band) is in here, and its absence was a HOLE rather than an omission:
/// a dot missing from this list interns to `None`, which every rule below reads as no evidence, so
/// an agent asking a question while holding unlanded work — not green, and exactly the founder's
/// condition — could never be seen on this path at all. `dot_vocabulary_matches_the_frontend` pins
/// the list against the TypeScript union so the next dot added there cannot go silently missing
/// here; nothing pinned it before, which is why `blue` did.
pub const ROLLUP_DOTS: [&str; 5] = ["green", "gray", "red", "orange", "blue"];

/// Intern a roster dot to its `'static` form. `None` for anything else — including the empty string
/// a window that cannot compute the rollup publishes.
pub fn intern_dot(dot: &str) -> Option<&'static str> {
    ROLLUP_DOTS.into_iter().find(|d| *d == dot)
}

/// Does this stage mean "there IS committed work that has not landed on ORIGIN main yet"?
///
/// The Rust twin of `workflowStage.ts::hasUnmergedCommittedWork`: true across the committed-but-
/// unlanded band, `building_saved` through `merged_local`, and false below it (nothing committed)
/// and at or above `merged`. `merged_local` still counts as unlanded because the workflow lands via
/// a PR to origin, so local-only work still needs a human to get it the rest of the way.
///
/// An unknown stage is `false` -- no evidence, so no flag. `stage_vocabulary_matches_the_frontend`
/// pins this list against the TypeScript source, which is the only thing stopping the two from
/// drifting into disagreeing about the same agent at the same moment.
pub fn holds_unlanded_work(stage: &str) -> bool {
    match (stage_rank(stage), stage_rank("building_saved"), stage_rank("merged")) {
        (Some(idx), Some(lo), Some(hi)) => idx >= lo && idx < hi,
        _ => false,
    }
}

/// How long a NOT-GREEN row holding unlanded work may go without its stage advancing before the
/// concierge is told, in seconds.
///
/// -- WHY THIS CLOCK IS SLOW, AND WHY IT IS SEPARATE FROM THE SILENCE CLOCK ---------------------
/// It does NOT reset on output, which is the entire point: the agent this catches is the one whose
/// pane is busy while nothing lands. Since terminal activity cannot clear it, only real progress
/// can, it has to be generous enough that ordinary work never trips it -- an agent can legitimately
/// read code, run a long suite, or think for a long stretch without the stage moving. Thirty
/// minutes of a non-green row holding unlanded work with no stage advance is not a busy agent; it
/// is a row a human should look at.
///
/// It raises the CONCIERGE, never the founder directly, for the same reason: this is the weakest
/// evidence in the module, resting on two frontend-written facts, so it earns the lower level.
const UNLANDED_STALL_SECS: u64 = 1800;

/// The one-line answers the nudge asks for, and the ONLY vocabulary this module accepts.
///
/// ── THE DEFECT THIS TYPE EXISTS TO CLOSE ──────────────────────────────────────────────────────
/// `nudge_text` has always ENDED with a demand for exactly one of these tokens, and until now
/// nothing on any path read the answer. The fleet retro named the shape — "the ladder asks a
/// question it does not listen for the answer to" — and the founder's 2026-08-07 screenshot is what
/// it costs: one agent answered `not-blocked` FOURTEEN consecutive times and was re-pinged after
/// every one, each ping a full agent turn.
///
/// Keeping the enum in the same file as `nudge_text` is deliberate: the question and the answer are
/// one contract, and `every_token_the_nudge_offers_parses_back` asserts they cannot drift apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reply {
    NotBlocked,
    Human,
    Ci,
    AnotherAgent,
    Quota,
    /// The agent has NO task assigned — finished, or spawned without one. It cannot be blocked on a
    /// human, because there is nothing for a person to unblock. Routes to the concierge, never the
    /// founder (bead `sparkle-dfy3d`).
    NoTask,
    /// The agent has exhausted its context window. The remedy is to succeed it or hand its goal to a
    /// successor — a concierge action, not a founder page (bead `sparkle-umtx1`).
    OutOfContext,
}

/// The wire tokens, longest-first so a prefix can never shadow a longer match.
const REPLY_TOKENS: [(&str, Reply); 7] = [
    ("blocked-on-another-agent", Reply::AnotherAgent),
    ("no-task-assigned", Reply::NoTask),
    ("blocked-on-human", Reply::Human),
    ("blocked-on-quota", Reply::Quota),
    ("out-of-context", Reply::OutOfContext),
    ("blocked-on-ci", Reply::Ci),
    ("not-blocked", Reply::NotBlocked),
];

impl Reply {
    pub fn as_str(self) -> &'static str {
        match self {
            Reply::NotBlocked => "not-blocked",
            Reply::Human => "blocked-on-human",
            Reply::Ci => "blocked-on-ci",
            Reply::AnotherAgent => "blocked-on-another-agent",
            Reply::Quota => "blocked-on-quota",
            Reply::NoTask => "no-task-assigned",
            Reply::OutOfContext => "out-of-context",
        }
    }
}

/// What the ladder does with itself once it knows the agent is not merely silent.
///
/// A stand-down is NOT silence toward humans — every variant below records the flag level it still
/// raises. It governs only whether we TYPE at the agent again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Standdown {
    /// Nothing left to resume: the goal is met, or the agent said `not-blocked`. No writes, no
    /// flag — an agent that is finished is not a row anybody owes.
    Done,
    /// `blocked-on-human`. Re-typing cannot move this; only a person can. Writes stop and the
    /// FOUNDER is flagged at once rather than after another five ignored pings.
    AwaitHuman,
    /// `blocked-on-quota`. Back off hard — the answer to a ping costs a turn against the exhausted
    /// budget itself. Flagged to the concierge, which is the layer that can act on a quota wall.
    Quota,
    /// `blocked-on-ci` / `blocked-on-another-agent`. The agent is waiting on something real and
    /// external, so keep the ladder running — but at the top rung only, and let the counter climb
    /// to the terminal rung so this ends.
    External,
    /// `no-task-assigned`. A finished or freshly-spawned agent that has NO task cannot be blocked on
    /// a human — there is nothing for a person to unblock, so a `blocked-on-human` row that paints
    /// red and pages the FOUNDER is a false alarm (bead `sparkle-dfy3d`). Writes stop and the
    /// CONCIERGE — the layer that can stand the agent down or hand it work — is flagged, never the
    /// founder.
    NoTask,
    /// `out-of-context`. The agent has run out of context window. That is not a human blocker
    /// either: the remedy is to succeed it or hand its goal to a successor, which is the CONCIERGE's
    /// job (bead `sparkle-umtx1`). Writes stop and the concierge is flagged with a machine-readable
    /// `out-of-context` reason the layer above can act on — never the founder.
    OutOfContext,
}

impl Standdown {
    fn of(reply: Reply) -> Standdown {
        match reply {
            Reply::NotBlocked => Standdown::Done,
            Reply::Human => Standdown::AwaitHuman,
            Reply::Quota => Standdown::Quota,
            Reply::Ci | Reply::AnotherAgent => Standdown::External,
            Reply::NoTask => Standdown::NoTask,
            Reply::OutOfContext => Standdown::OutOfContext,
        }
    }

    /// The flag level this stand-down sits at, for as long as it holds.
    fn flag(self) -> Option<Escalation> {
        match self {
            Standdown::Done => None,
            Standdown::AwaitHuman => Some(Escalation::Founder),
            Standdown::Quota => Some(Escalation::Concierge),
            // External keeps whatever the ordinary escalation counter has reached; it does not
            // assert a level of its own.
            Standdown::External => None,
            // A task-less or out-of-context agent is a concierge matter, never a founder page — the
            // founder is the red alarm, and neither of these needs a person. `Some(Concierge)` also
            // marks both VISIBLE, so `effective_standdown`'s invisible-expiry (keyed on
            // `flag().is_none()`) leaves their rows standing until the concierge acts.
            Standdown::NoTask | Standdown::OutOfContext => Some(Escalation::Concierge),
        }
    }

    /// Does this stand-down forbid writing entirely?
    fn silences_writes(self) -> bool {
        !matches!(self, Standdown::External)
    }

    fn reason(self) -> &'static str {
        match self {
            Standdown::Done => "nothing-to-resume",
            Standdown::AwaitHuman => "blocked-on-human",
            Standdown::Quota => "blocked-on-quota",
            Standdown::External => "blocked-externally",
            Standdown::NoTask => "no-task-assigned",
            Standdown::OutOfContext => "out-of-context",
        }
    }
}

/// The marker every nudge line starts with, and the anchor `parse_reply` searches from.
const NUDGE_MARKER: &str = "[sparkle-nudge #";

/// Who a raised flag is for. NOT a write, and never delivered by this module.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Escalation {
    Concierge,
    Founder,
}

impl Escalation {
    pub fn as_str(self) -> &'static str {
        match self {
            Escalation::Concierge => "concierge",
            Escalation::Founder => "founder",
        }
    }
}

/// What the nudger decided to do to one agent on one tick.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Look again later. Carries why nothing was written, for the log.
    Observe,
    /// Press Enter. Rungs 4-6, non-empty prompt only.
    Enter,
    /// Answer an ordinary permission prompt whose command is on the gate's allowlist, by
    /// selecting the affirmative option. NOT free text, and never a carriage return -- see
    /// `nudge_gate::answer_refusal`, which is the only thing that may authorise this.
    Answer,
    /// Type the fixed nudge string. Rung 7+.
    Nudge {
        /// 1-based counter, shown in the message so scrollback carries the history.
        n: u32,
    },
}

/// Everything the ladder needs to know about one agent at one instant.
#[derive(Debug, Clone)]
pub struct Observation {
    /// Hash of the last 4KB of PTY output plus the current status. THE detector — no content
    /// interpretation whatsoever.
    pub hash: u64,
    /// `true` when the agent's status is `working`, however that was determined.
    pub working: bool,
    /// `None` when the safety gate permits a write; `Some(reason)` when it refuses.
    pub refusal: Option<&'static str>,
    /// Could the agent's screen actually be READ this tick?
    ///
    /// When it could not, `working` below is not evidence of anything — see `step`.
    pub screen_readable: bool,
    /// Is there text sitting on the prompt line, typed and never submitted?
    pub prompt_has_text: bool,
    /// Milliseconds since anything else wrote to this PTY.
    ///
    /// This is the guard against a hazard that has no analogue on the JS side: every JS write goes
    /// through `chainPtyOp` (pty.ts), which serializes a paste and its trailing carriage return as
    /// ONE operation. A Rust write bypasses that chain entirely, so a byte landing inside another
    /// writer's 60ms paste→CR window would append to and then SUBMIT a prompt the user never sent
    /// (roborev 54369/54375). Standing down for a couple of seconds after any other write closes
    /// that window without needing to re-plumb the JS protocol.
    pub since_other_write_ms: u64,
    /// Epoch ms of the last write by anybody other than this module — the ABSOLUTE form of the
    /// field above, and a different question with a different answer.
    ///
    /// `since_other_write_ms` asks "did somebody type in the last few seconds", which is a safety
    /// interlock. This asks "has anybody typed SINCE we stood down", which is how a stand-down
    /// ends. The delta cannot answer it: the ladder's top rung is 600s, so a founder handing an
    /// agent new work is invisible to a 5-second window on all but one look in a hundred and twenty.
    pub foreign_write_ms: u64,
    /// The agent's goal is MET — it has said, through `set_agent_goal_met`, that the thing it was
    /// sent to do is done.
    ///
    /// ── WHY A FRONTEND-WRITTEN FACT IS TRUSTED HERE ───────────────────────────────────────────
    /// Every other roster-derived signal in this module is treated as suspect, because the roster
    /// is written by a WebView that may be wedged. This one is safe in a way `working` is not, and
    /// the asymmetry is worth stating: a stale `working` suppresses a nudge an agent NEEDS, whereas
    /// a stale `goal_met` suppresses a nudge for an agent that already reported having nothing left
    /// to do. "Resume your goal" said to an agent whose goal is met is not a recovery — it is a
    /// full agent turn spent to be told, again, that there is nothing to resume.
    pub goal_met: bool,
    /// The agent's own one-line answer to the most recent nudge, per `parse_reply`. `None` when it
    /// has not answered, or when the screen cannot be read unambiguously.
    pub reply: Option<Reply>,
    /// The wall clock that has actually passed since the previous look at this agent, in seconds.
    ///
    /// BOTH CLOCKS IN THIS MODULE MEASURE TIME, so they must be GIVEN time rather than allowed to
    /// re-derive it from the schedule. Two independent things break that derivation, and neither is
    /// visible from in here:
    ///   * the stand-down paths override `next_look_secs` (quota backs off to half an hour) while
    ///     leaving the rung where it stood, so a rung-derived interval under-credits by up to 100×;
    ///   * `nudger` REBASELINES every deadline on a detected machine suspend, precisely because the
    ///     silence across a freeze means nothing — so the interval that was scheduled is not the
    ///     interval that was observed, and crediting the schedule would charge the whole frozen span
    ///     to an agent that was never running.
    ///
    /// `None` means the caller did not measure it, and the clocks then fall back to the schedule.
    /// That is the ladder's own unit tests, which drive synthetic looks with no wall clock at all —
    /// production always measures.
    pub elapsed_secs: Option<u64>,
    /// This agent's ROW DISC once the workers folded under it are counted — `rollup_dot` on the
    /// roster slice. `None` when the window could not say, which is NOT the same as gray.
    ///
    /// Frontend-written, like `working` and `goal_met`. Trusted here ONLY to raise a flag and never
    /// to suppress one, which is the asymmetry that makes a stale value safe: erring toward telling
    /// a human is the one direction this module is allowed to err in.
    pub rollup_dot: Option<&'static str>,
    /// This agent's workflow stage, per `engine/workflowStage.ts`. `None` when absent or unknown —
    /// treated as NO EVIDENCE, never as "has made no progress".
    pub stage: Option<&'static str>,
    /// The screen is an ordinary permission prompt whose command the gate's ALLOWLIST covers, so
    /// the affirmative option may be selected without a human reading it.
    ///
    /// Computed by `nudger::observe` from `nudge_gate::answer_refusal`, which fails closed on every
    /// unknown -- an unreadable command, a chained command, a credential prompt, the billing
    /// picker. This module never decides safety itself; it only decides WHEN to act on the verdict.
    pub answerable: bool,
}

/// The nudger's memory of one agent, between ticks.
#[derive(Debug, Clone, Default)]
pub struct AgentState {
    /// Last observed hash. `None` before the first look — the seeding tick, which never writes.
    hash: Option<u64>,
    /// Current rung, 0-indexed into `LADDER_SECS`, saturating at the last entry.
    rung: usize,
    /// Ticks that reached a nudge rung in this episode, WHETHER OR NOT a byte went out.
    ///
    /// This drives escalation, and the distinction from `delivered` is the point: an agent whose
    /// screen we can never write to is exactly the one a human most needs told about, so a refusal
    /// must still accumulate toward the flag.
    attempts: u32,
    /// Nudges whose text was actually SUBMITTED. Reported, never used to decide anything — the
    /// caller records it after the write, because only the caller knows whether the carriage return
    /// survived the interleave check.
    delivered: u32,
    /// Why the last attempt did not write, if it did not. Travels on the flag so the pusher can
    /// tell "we nudged six times and it ignored us" from "we could not read its screen at all".
    last_blocked: Option<&'static str>,
    /// Highest flag already raised in this episode, so it is raised once and not every tick.
    escalated: Option<Escalation>,
    /// How long this agent has been unchanged, in seconds — carried for the nudge string.
    silent_secs: u64,
    /// The stand-down the agent's own last answer put us in, if any. Latched, because the answer is
    /// a fact about the agent that outlives the look that read it.
    standdown: Option<Standdown>,
    /// The answer that produced `standdown`, kept for the log and the flag.
    last_reply: Option<Reply>,
    /// `foreign_write_ms` as it stood when `standdown` was latched.
    ///
    /// This is the entire "unless new work arrives" clause. A stand-down says the agent has nothing
    /// to resume; the moment somebody hands it something to resume, that stops being true. Any
    /// INCREASE here is that moment — a founder typing, an orchestrator delivering a task — and it
    /// releases the latch. Comparing absolute stamps rather than a recency window means the release
    /// cannot be missed by looking at the wrong second.
    standdown_at_foreign_write: u64,
    /// `foreign_write_ms` as it stood the first look we saw this agent's goal reported MET.
    ///
    /// `goal_met` is re-derived every look rather than latched, so the stand-down release above
    /// cannot reach it — and `goalStateOf` returns "met" FOREVER once `metAt` is set, until somebody
    /// constructs a whole new goal object. A founder typing a new task into a finished agent's
    /// terminal does not do that. Without this stamp such an agent is exempt from the ladder for the
    /// rest of its life: never written to, and `Done` raises no flag either, so it is silent in both
    /// directions — the exact outcome this module's header forbids, reached by the most ordinary
    /// flow there is.
    goal_met_at_write: Option<u64>,
    /// Somebody has typed at this agent SINCE its goal was reported met, so the met claim no longer
    /// describes the work in front of it. Latched: the goal state cannot un-supersede itself,
    /// because it has no way to notice the new work either.
    goal_met_superseded: bool,
    /// Did THIS module type at the agent on the previous look?
    ///
    /// ── WHY THE REPLY CANNOT ANSWER "WHOSE OUTPUT WAS THAT" ───────────────────────────────────
    /// The nudge is typed into the PTY, so it ECHOES — and the echo lands whether or not the agent
    /// ever answers. Keying the conversation reset on a parsed reply therefore closed the loop only
    /// for agents that answer in the exact vocabulary: one that replies in prose, or whose answer
    /// scrolled off, or that emits nothing but a redrawn spinner, still took the full-reset path and
    /// still climbed back to `#1` forever. That is the founder's original symptom, surviving for
    /// everyone who did not answer by the book.
    ///
    /// Our own write is provoked BY CONSTRUCTION, which is the property the reply was only ever a
    /// proxy for. Cleared at the top of every look, so it means "the look immediately before this
    /// one" and never leaks further.
    wrote_last_look: bool,
    /// Seconds a NOT-GREEN row holding unlanded work has gone without its stage advancing.
    ///
    /// A SECOND CLOCK, deliberately independent of `silent_secs`: output does not clear it, because
    /// the agent it exists to catch is the one whose pane is busy while nothing lands.
    unlanded_secs: u64,
    /// The best stage rank seen this episode, so an ADVANCE can be told from a repeat. High-water,
    /// so a roster blink that drops the stage cannot read as regress and re-arm the clock.
    ///
    /// Cleared whenever the unlanded condition stops holding, which is what makes "this episode"
    /// true — see `tick_unlanded_clock`. Retaining it across a merge boundary made the second and
    /// every later unit of work on a branch unable to clear its own clock.
    stage_high_water: Option<usize>,
    /// The `next_look_secs` the PREVIOUS decision scheduled — i.e. how much wall clock the look now
    /// running actually represents.
    ///
    /// The unlanded clock needs the interval that ELAPSED, and the rung does not answer that: the
    /// stand-down paths override `next_look_secs` (quota backs off to 30 minutes, external waits a
    /// full last rung) while leaving the rung where it was. `None` on the very first look, which is
    /// credited the opening rung.
    last_scheduled_secs: Option<u64>,
    /// Looks spent parked on a screen only a human can clear, for that path's escalation ladder.
    ///
    /// Deliberately NOT `attempts`, which means "nudges we tried to send" and is both the
    /// `GIVE_UP_AFTER` budget and the `nudges:` figure a human reads off the flag. Charging silent
    /// observations to that counter spent the give-up budget on an agent that was never nudged.
    parked_looks: u32,
    /// Consecutive looks of UNPROVOKED output, for `LIVE_LOOKS_TO_RESET`.
    ///
    /// The counter that tells a WORKING agent from a REPAINTING one. Our own echo zeroes it (it is
    /// not the agent living) and so does any quiet look, so it only ever reports a genuine run.
    live_looks: u32,
}

impl AgentState {
    pub fn rung(&self) -> usize {
        self.rung
    }
    /// Ticks that reached a nudge rung — what escalation counts.
    pub fn attempts(&self) -> u32 {
        self.attempts
    }
    /// Nudges actually submitted.
    pub fn delivered(&self) -> u32 {
        self.delivered
    }
    /// Record that a nudge's text was submitted. Called by the driver after the write succeeds.
    pub fn record_delivered(&mut self) {
        self.delivered += 1;
    }
    /// Record that a write the GATE permitted did not actually land, and why.
    ///
    /// Without this the flag read `nudges: 6, delivered: 0, blocked_by: null`, which by
    /// `blocked_by`'s own contract means "we could never write to this agent" — when in fact the
    /// nudges may be sitting on the prompt one bare Enter from resolving, or the PTY write may be
    /// erroring out. Those are materially different problems for the consumer, and reporting the
    /// wrong one is the same conflation the `delivered` counter exists to remove.
    ///
    /// Takes the reason rather than hard-coding one, because there is more than one way for a
    /// permitted write not to land and every arm must be distinguishable.
    pub fn record_blocked(&mut self, reason: &'static str) {
        self.last_blocked = Some(reason);
    }
    /// Why the last attempt could not write.
    pub fn last_blocked(&self) -> Option<&'static str> {
        self.last_blocked
    }
    /// The highest flag level reached in this episode, or `None` before any threshold.
    ///
    /// Read by the driver BETWEEN looks, where there is no `Decision` to consult: the ladder's top
    /// rung is 600s, so a row a consumer cleared would otherwise be invisible for ten minutes even
    /// with the per-look refresh in place. Cleared by the episode reset, like everything else here.
    pub fn escalated(&self) -> Option<Escalation> {
        self.escalated
    }
    /// Looks charged to the parked-screen path, for tests that must prove an episode did NOT take
    /// it — the counter is the only thing that distinguishes the two paths at the same rung.
    #[cfg(test)]
    pub fn parked_looks_for_test(&self) -> u32 {
        self.parked_looks
    }
    /// Seconds this row has been not-green, holding unlanded work, with no stage advance.
    pub fn unlanded_secs(&self) -> u64 {
        self.unlanded_secs
    }
    pub fn silent_secs(&self) -> u64 {
        self.silent_secs
    }
    /// The stand-down currently in force, if the agent's own answer put us in one.
    pub fn standdown(&self) -> Option<Standdown> {
        self.standdown
    }
    /// The agent's last parsed answer, for the log and the flag.
    pub fn last_reply(&self) -> Option<Reply> {
        self.last_reply
    }
}

/// One tick's full decision — this doubles as the log record, which is why it carries the inputs
/// that produced it as well as the outcome. The bead is explicit that instrumentation is not
/// optional: without it nobody can answer "does nudging actually work", and we would guess about
/// the next outage the way we guessed about this one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub action: Action,
    /// A flag newly raised on THIS tick. `None` on every other tick, including later ticks of an
    /// episode that has already escalated.
    pub escalate: Option<Escalation>,
    /// The flag level this look SITS AT, whatever was newly raised — `Some` on every look at or
    /// above a threshold, for the whole rest of the episode.
    ///
    /// ── WHY THIS IS A SEPARATE FIELD FROM `escalate` ──────────────────────────────────────────
    /// Escalation is a HIGH-WATER MARK: `escalate` is `Some` only on the tick a target RISES, and
    /// once the founder level is reached there is nothing higher, so it is `None` forever after.
    /// That makes it the right signal for "emit an escalation event" and the WRONG signal for
    /// "this agent has a row a human owes". `nudger::apply_flags` used `escalate` for both, and a
    /// consumer that cleared a founder flag on an agent the clear did not unstick deleted that row
    /// permanently — the episode only ends when the agent produces output, which is exactly what a
    /// wedged agent never does.
    ///
    /// So: `escalate` decides whether the row ESCALATES, `flagged` decides whether it EXISTS. Same
    /// split `conflict_ladder` gets for free from `Action::Flag`, which this ladder has no
    /// equivalent of because its flagging looks can carry any of three actions.
    pub flagged: Option<Escalation>,
    /// 1-based rung, for humans reading the log.
    pub rung: u32,
    pub hash_changed: bool,
    /// Why no byte was written. `None` when one was.
    pub refusal: Option<&'static str>,
    /// How long to wait before looking at this agent again.
    pub next_look_secs: u64,
}

/// How long after any other write to this PTY the nudger stays silent.
///
/// Two orders of magnitude above the 60ms paste→CR gap it is protecting, and comfortably above the
/// jitter of a loaded machine, while still far below the 30s earliest write rung — so in the case
/// this module exists for (nothing has happened for minutes) it never applies at all.
pub const QUIET_AFTER_OTHER_WRITE_MS: u64 = 5_000;

/// THE DECISION. Advances `state` and returns what to do.
///
/// Ordering note: the rung advances on every unchanged look, INCLUDING looks where the gate refused
/// and looks in the observe-only band. That is deliberate — the ladder measures how long the agent
/// has been silent, not how many times we managed to type at it. An agent parked behind a picker
/// for ten minutes should reach the escalation rungs and get a human's attention, which is exactly
/// what a picker nobody is answering deserves.
pub fn step(state: &mut AgentState, obs: &Observation) -> Decision {
    // TICKED FIRST, and OUTSIDE the ladder, because it must survive every early return below and
    // must NOT be cleared by output. See `UNLANDED_STALL_SECS`.
    let rose = tick_unlanded_clock(state, obs);
    let mut decision = step_inner(state, obs);

    // The row EXISTS for as long as the condition holds, and ESCALATES only on the look it crossed
    // — the same split `flagged` / `escalate` keep everywhere else in this module. Folded in here
    // rather than at each of the seven return sites inside `step_inner`, so a path added later
    // cannot silently forget it.
    if state.unlanded_secs >= UNLANDED_STALL_SECS {
        decision.flagged = decision.flagged.max(Some(Escalation::Concierge));
    }
    decision.escalate = decision.escalate.max(rose);
    // Recorded LAST, and read by `tick_unlanded_clock` at the top of the NEXT look, so that clock
    // credits the interval that was really scheduled rather than one re-derived from the rung.
    // Every return site inside `step_inner` funnels through here, so a path added later cannot
    // forget it — the same reason the flag above is folded in at this level.
    state.last_scheduled_secs = Some(decision.next_look_secs);
    decision
}

/// Advance the unlanded-work clock, returning a target only when it just crossed the threshold.
///
/// THE CONDITION IS THE FOUNDER'S, VERBATIM: a row that is not green and is not at least merged to
/// main is a problem. The only thing added here is a TIME BOUND, because that condition is the
/// ordinary state of every agent mid-task — it is being STUCK in it that matters, not being in it.
///
/// Cleared by real progress and by nothing else: the stage advancing, the row going green, or the
/// work landing. Output does NOT clear it, which is what makes it catch the agent the silence clock
/// cannot see — the one whose pane keeps repainting while nothing lands.
fn tick_unlanded_clock(state: &mut AgentState, obs: &Observation) -> Option<Escalation> {
    // ── ABSENCE IS NOT EVIDENCE, IN EITHER DIRECTION ──────────────────────────────────────────
    // `None` is NOT gray, and it is not green either. A window that could not tell us the disc or
    // the stage has said NOTHING about this agent, so the look neither raises the flag nor clears
    // one: the clock HOLDS and we return before touching it.
    //
    // Zeroing here was the bug, and it bit in precisely the outage this clock exists for: a
    // reloading or wedged WebView drops agents out of the published roster, so a single undescribed
    // look discarded a nearly-full clock and the accrual could never finish. It also contradicted
    // this field's own stated contract — frontend facts are trusted to RAISE a flag and never to
    // SUPPRESS one — which is the asymmetry that makes a stale value safe to read at all.
    let (Some(dot), Some(stage)) = (obs.rollup_dot, obs.stage) else {
        return None;
    };

    // An ADVANCE is real progress. High-water, so a roster blink that lowers the stage reads as
    // "no news" rather than as a regression that re-arms the clock.
    if let Some(rank) = stage_rank(stage) {
        if state.stage_high_water.is_none_or(|best| rank > best) {
            state.stage_high_water = Some(rank);
            state.unlanded_secs = 0;
        }
    }

    // Every dot in the vocabulary except `green` is the founder's condition, so this is written as
    // "known, and not green" rather than as a list — a dot added to `ROLLUP_DOTS` then counts here
    // by construction instead of silently interning to `None` and disappearing, which is exactly
    // how `blue` was lost.
    let not_green = dot != "green";
    let unlanded = holds_unlanded_work(stage);
    if !not_green || !unlanded {
        state.unlanded_secs = 0;
        // …AND THE HIGH-WATER GOES WITH IT, because the frontend stage deliberately REGRESSES.
        // `workflowStage.ts::deriveLiveStage` drops a branch from `merged` back to `building_saved`
        // when the agent keeps committing after its PR lands — the ordinary "merge, keep working"
        // cycle. A high-water retained across that boundary can never be beaten again by the second
        // cycle's own `building_saved`→`merged_local`, so real progress stopped clearing the clock
        // and a normally-moving agent was escalated 30 minutes into every unit of work after its
        // first. Cleared only HERE, on positive evidence of health, so a blink — which arrives as
        // absence and is held above — still cannot re-arm anything.
        state.stage_high_water = None;
        return None;
    }

    // MEASURED time first, and it is the only fully correct answer — see `Observation::elapsed_secs`
    // for the two ways the schedule and the observation come apart. The scheduled interval is the
    // fallback for a caller that did not measure (the ladder's own unit tests), and it is still
    // strictly better than the rung it replaced: the stand-down paths override `next_look_secs`
    // while leaving the rung alone, so a rung-derived interval under-credited an agent that answered
    // `blocked-on-quota` by up to 100× and `UNLANDED_STALL_SECS` was not the bound it claims.
    let elapsed = obs.elapsed_secs.or(state.last_scheduled_secs).unwrap_or(LADDER_SECS[0]);
    let before = state.unlanded_secs;
    state.unlanded_secs = state.unlanded_secs.saturating_add(elapsed);

    // Only on the look it CROSSES, so one stuck row is one notice rather than a stream.
    if before < UNLANDED_STALL_SECS && state.unlanded_secs >= UNLANDED_STALL_SECS {
        return raise(state, Some(Escalation::Concierge));
    }
    None
}

fn step_inner(state: &mut AgentState, obs: &Observation) -> Decision {
    let previous = state.hash;
    let changed = previous.is_some_and(|h| h != obs.hash);
    // Consumed immediately, so it can only ever mean "the look before this one".
    let we_wrote_last_look = std::mem::take(&mut state.wrote_last_look);

    // ── A MET GOAL GOES STALE WHEN SOMEBODY TYPES ─────────────────────────────────────────────
    // `goal_met` is not latched — it is re-read every look — so the release below cannot reach it,
    // and `goalStateOf` keeps answering "met" forever once `metAt` is set. Stamp the write clock at
    // the first met look; any LATER foreign write means the agent has been handed something the met
    // claim knows nothing about, and the claim stops being a reason to stay quiet.
    //
    // ── AND THE SUPERSESSION IS STICKY (roborev 60338, Medium) ────────────────────────────────
    // An earlier revision cleared both fields on any look where `goal_met` read false. That is not
    // the rare event it sounds like: `nudger.rs` computes `goal_met` from the roster, and an agent
    // ABSENT from the roster reads as unmet — which is exactly what a frontend reload, a republish
    // gap or a wedged WebView produces. One such look reset the stamp, the next met look re-stamped
    // it against the NEW write clock, and the lifetime exemption was back, permanently, with `Done`
    // raising no flag. A transient roster blink must not be able to do that.
    //
    // The cost of stickiness is the honest one: an agent that is superseded and then legitimately
    // finishes NEW work will keep being watched, because nothing on this observation distinguishes
    // "a new goal was met" from "the old met claim is still being reported". That errs toward
    // nudging, which is the only direction this module is allowed to err in — and the agent can
    // still quiet itself for free by answering `not-blocked`.
    if obs.goal_met {
        match state.goal_met_at_write {
            None => state.goal_met_at_write = Some(obs.foreign_write_ms),
            Some(at) if obs.foreign_write_ms > at => state.goal_met_superseded = true,
            _ => {}
        }
    }

    // ── NEW WORK RELEASES A STAND-DOWN ────────────────────────────────────────────────────────
    // "It has nothing to resume" stops being true the moment somebody gives it something to
    // resume. A foreign write is that moment — the founder typing, the orchestrator delivering a
    // task — and it puts the agent back under the ordinary ladder with a clean history.
    if state.standdown.is_some() && obs.foreign_write_ms > state.standdown_at_foreign_write {
        state.standdown = None;
        state.last_reply = None;
        state.attempts = 0;
        state.delivered = 0;
        state.escalated = None;
        state.last_blocked = None;
    }

    // ── THE AGENT'S OWN ANSWER ────────────────────────────────────────────────────────────────
    // Absorbed on EVERY look, not only on the one where the hash moved: the reply sits on the
    // rendered screen from the moment it is typed, so any later look reads the same fact, and a
    // slow answer is caught rather than missed by one tick.
    //
    // Gated on `attempts > 0` — a conversation we actually started. After a full reset the previous
    // exchange can still be in scrollback, and an answer to a nudge from an hour ago is not consent
    // to stay quiet now. `parse_reply` reinforces this from the other side by only ever reading the
    // region after the LATEST nudge.
    if state.attempts > 0 {
        if let Some(reply) = obs.reply {
            if state.last_reply != Some(reply) {
                state.last_reply = Some(reply);
                state.standdown = Some(Standdown::of(reply));
                state.standdown_at_foreign_write = obs.foreign_write_ms;
            }
        }
    }

    // ANY change resets the SILENCE clock. This is still the entire detector.
    if changed || previous.is_none() {
        // ── WHOSE OUTPUT WAS THAT? ────────────────────────────────────────────────────────────
        // THE BUG THE FOUNDER SCREENSHOTTED, in one condition. A nudge is not a passive read: it
        // is typed into the PTY, it echoes, and the one-line answer it demands is more output
        // still. So the exchange WE START moves the hash — and treating that as "the agent got
        // back to work" reset the counter to zero every single cycle. Fourteen consecutive pings
        // all labelled `#1`, all reporting the same `4m 5s` (which is exactly 5+10+20+30+60+120,
        // the climb from rung 1), each one a full agent turn, on an agent that had already said it
        // was done. A ladder whose rung resets on its own footsteps is a loop, not a ladder.
        //
        // So an answered nudge advances the conversation instead of erasing it: the silence clock
        // restarts (the agent did emit), but the nudge history, the escalation high-water mark and
        // the stand-down all survive. Output we did NOT provoke is still a full reset — that is a
        // genuinely working agent and it earns a clean slate.
        //
        // KEYED ON OUR OWN WRITE, NOT ON A PARSED REPLY (roborev 60323, High). The echo lands
        // whether or not the agent answers in the vocabulary, so keying on the reply left the loop
        // wide open for anyone who answered in prose, whose answer had scrolled off, or who emitted
        // nothing but a redrawn spinner — all of them still reset to `#1` forever. Our own write is
        // provoked by construction; the reply was only ever a proxy for that, and a lossy one.
        //
        // It holds for exactly ONE look, so a nudge that genuinely revives an agent costs at most a
        // single preserved look before the next unprovoked change wipes the slate.
        let conversation = changed && state.attempts > 0 && we_wrote_last_look;
        state.hash = Some(obs.hash);
        state.rung = 0;

        // -- AND ONE CHANGED LOOK IS NOT A WORKING AGENT ---------------------------------------
        // The `conversation` rule above attributes our own ECHO, and it is correct as far as it
        // goes -- but it reaches exactly ONE look, while the climb back to the next nudge rung is
        // SEVEN. Six looks were therefore left in which any single hash change wiped the episode,
        // and a live pane supplies one for free: a footer redraw, a context-remaining counter, or
        // the roster STATUS that is hashed alongside the PTY tail flipping as an agent blinks out
        // of a reloading WebView. The result was the founder's screenshot -- every ping `#1`, no
        // threshold ever reached, no human ever told, a fleet pinged for hours.
        //
        // So the wipe keys on a RUN of activity. A working agent emits on consecutive looks; a
        // repaint emits once and goes quiet. Our own echo ends the run rather than extending it,
        // because output we provoked is not evidence of anything. See `LIVE_LOOKS_TO_RESET`.
        let live_run = if conversation || !changed {
            state.live_looks = 0;
            false
        } else {
            state.live_looks = state.live_looks.saturating_add(1);
            state.live_looks >= LIVE_LOOKS_TO_RESET
        };

        if !conversation {
            // ── AND THE REPLY LATCH GOES TOO (roborev 60338, High) ────────────────────────────
            // A previous revision kept the stand-down here, reasoning that clearing it would let an
            // idle redraw revive the pinging on an agent that had said it was done. That reasoning
            // was WRONG, and the mistake is worth recording because it is seductive: a FINISHED
            // agent is held quiet by `obs.goal_met` inside `effective_standdown`, which is re-read
            // every look and owes nothing to this latch. So clearing here cannot revive pinging of
            // a finished agent — it was never what kept one quiet.
            //
            // What keeping it DID do was hand `not-blocked` — the commonest token, and the one in
            // the founder's screenshot — the power to silence an agent for the rest of its session:
            // `Done` both refuses to write AND reports no flag, so an agent that answered at minute
            // 5, worked on, and wedged at minute 40 was invisible in both directions with no way
            // back except a human typing at it. That is precisely the forbidden outcome the
            // goal-met supersession above exists to close, re-entered through the reply door.
            //
            // An unprovoked reset is by definition output we did not ask for. The agent is alive
            // and doing something; whatever it told us minutes ago about being idle has expired.
            //
            // ── ONLY `Done`, AND THE NARROWNESS IS THE POINT (roborev 60353, High) ────────────
            // A first attempt wiped EVERY stand-down here, which was far too broad. `AwaitHuman`
            // and `Quota` raise FLAGS — they are visible by construction, so they never had the
            // silent-in-both-directions problem that justified this expiry. Clearing them destroyed
            // the very row they exist to put up: an agent answers `blocked-on-human`, the founder
            // is flagged, the rung resets to 0 so the NEXT look is five seconds later, and any
            // further output — the "exact command or permission" explanation we just asked it for, a footer
            // repaint, the tail of the same turn — deleted the answer. `apply_flags` then cleared
            // the row and had no `flagged` to re-raise it from, and the reply could not even be
            // re-absorbed because absorption is gated on `attempts > 0`, which this block zeroes.
            // The founder row for an agent explicitly asking for a person lasted one look.
            //
            // ── KEYED ON "RAISES NO FLAG", NOT ON ONE VARIANT (roborev 60369, Medium) ────────
            // The narrowing above was first written as `== Some(Done)`, which quietly swept
            // `External` (`blocked-on-ci` / `blocked-on-another-agent`) into an exemption the
            // justification never covered: `External::flag()` is `None`, so it is invisible too, and
            // its only remaining release was a foreign write — which the thing that actually ends a
            // CI wait does not produce. An agent that answered `blocked-on-ci`, saw CI finish,
            // worked for an hour and then wedged stayed pinned to the 600s cadence, so its first
            // ping arrived about an hour into the silence while the flag reported "4m".
            //
            // So the real predicate is VISIBILITY, not identity: a stand-down that raises a flag is
            // seen by a human whatever we do, and keeps the foreign-write release; one that raises
            // none must not be able to hide an agent, so it expires the moment the agent speaks.
            // Written this way a variant added later gets the right behaviour by construction.
            let invisible = state.standdown.is_some_and(|s| s.flag().is_none());
            if invisible {
                state.standdown = None;
                state.last_reply = None;
            }

            // ── AND THE EPISODE HISTORY SURVIVES A SURVIVING STAND-DOWN (roborev 60369, Medium) ─
            // Zeroing these unconditionally made `apply_flags` rewrite the founder's row on every
            // unprovoked repaint: it clears the row on `hash_changed`, then rebuilds it from a now
            // absent previous row, so `raised_at_ms` restarted at "now" and the counters read
            // `nudges: 0, silent_secs: 0`. A founder could not tell an agent waiting one minute
            // from one waiting six hours — the very defect roborev 57873 fixed for `conflict_watch`
            // — and clearing `escalated` also re-armed `raise`, re-emitting `nudger://escalation`
            // every repaint. An agent still standing down has not started a new episode.
            //
            // GATED ON THE RUN, unlike the stand-down expiry above it, and the asymmetry is the
            // safety rule rather than an oversight. Expiring a stand-down errs toward NUDGING, so
            // a single repaint may do it. Wiping the episode errs toward SILENCE -- it discards
            // the history that reaches a human -- so it takes real evidence the agent is alive.
            if live_run && state.standdown.is_none() {
                state.attempts = 0;
                state.parked_looks = 0;
                state.delivered = 0;
                state.last_blocked = None;
                state.escalated = None;
            }
        }

        // The silence clock restarts only when no stand-down survived. While one holds, this is what
        // the founder's row reports, and there the useful number is how long the agent has been
        // waiting on the thing it named — not how long since its last repaint. Restarting it every
        // repaint is what made a six-hour block read as brand new.
        if state.standdown.is_none() {
            state.silent_secs = 0;
        }

        let stand = effective_standdown(state, obs);
        let flagged = standdown_level(stand, state.escalated);
        let escalate = raise(state, flagged);
        return Decision {
            action: Action::Observe,
            escalate,
            // The episode just reset, so there is normally no level to be at — the consumer clears
            // its row on `hash_changed` anyway. A stand-down is the exception: an agent that just
            // answered `blocked-on-human` needs its row back on this very look, not in ten minutes.
            flagged,
            rung: 1,
            hash_changed: changed,
            // A first look has nothing to refuse — it is the baseline, not a declined write.
            refusal: match (stand, changed) {
                (Some(s), _) => Some(s.reason()),
                (None, true) => None,
                (None, false) => Some("seeding"),
            },
            next_look_secs: LADDER_SECS[0],
        };
    }

    // Unchanged: climb. A quiet look ends any run of activity -- `LIVE_LOOKS_TO_RESET` counts
    // CONSECUTIVE emitting looks, so an intermittent flicker never accumulates into one.
    state.live_looks = 0;
    // MEASURED, for the same reason the unlanded clock is — and this one is the number a HUMAN
    // reads. `silent_secs` reaches the founder's row through `NudgeFlag`, and it is the "no output
    // for D" clause of the nudge itself; while a stand-down holds it is explicitly *the* figure the
    // row reports. Re-deriving it from the rung meant an agent that answered `blocked-on-quota` was
    // looked at every half hour and credited five seconds a look, so the row under-reported a real
    // wait by up to 100× to the one audience that cannot check it.
    state.silent_secs += obs
        .elapsed_secs
        .unwrap_or(LADDER_SECS[state.rung.min(LADDER_SECS.len() - 1)]);
    state.rung = (state.rung + 1).min(LADDER_SECS.len() - 1);
    let rung = state.rung;
    let rung_1based = (rung + 1) as u32;
    let stand = effective_standdown(state, obs);
    // An agent waiting on CI or on another agent is not stuck, it is QUEUED — so it stays on the
    // ladder (something has to notice if the wait never ends) but never at the dense early rungs.
    let next_look_secs = match stand {
        Some(Standdown::External) => LADDER_SECS[LADDER_SECS.len() - 1],
        _ => LADDER_SECS[rung],
    };

    // ── THE STAND-DOWN GATE ───────────────────────────────────────────────────────────────────
    // The agent has told us, or the goal state has told us, that another identical ping cannot
    // help. Stop TYPING — and keep TELLING, at whatever level the situation warrants.
    if let Some(stand) = stand {
        if stand.silences_writes() {
            let flagged = standdown_level(Some(stand), state.escalated);
            let escalate = raise(state, flagged);
            return Decision {
                action: Action::Observe,
                escalate,
                flagged,
                rung: rung_1based,
                hash_changed: false,
                refusal: Some(stand.reason()),
                next_look_secs: match stand {
                    // Asking an agent that is out of quota to answer a ping spends a turn against
                    // the exact budget that is exhausted. Back all the way off.
                    Standdown::Quota => QUOTA_BACKOFF_SECS,
                    _ => next_look_secs,
                },
            };
        }
    }

    // ── THE TERMINAL RUNG ─────────────────────────────────────────────────────────────────────
    // Past here the founder has already been flagged and N identical pings have been ignored. The
    // row stays up — `flagged` carries the level reached, so `apply_flags` keeps raising it — but
    // the typing stops, because the only thing ping N+1 reliably produces is another billed turn.
    if state.attempts >= GIVE_UP_AFTER {
        return Decision {
            action: Action::Observe,
            escalate: None,
            flagged: state.escalated,
            rung: rung_1based,
            hash_changed: false,
            refusal: Some("gave-up"),
            next_look_secs,
        };
    }

    let observe = |refusal: &'static str| Decision {
        action: Action::Observe,
        escalate: None,
        // NOT a flagging look. Every path that reaches here either sits below a nudge rung or was
        // declined by `counts_as_attempt` — i.e. the ladder judged this agent to be FINE (a running
        // turn, or somebody else having just typed), which is precisely what must not hold a row up.
        flagged: None,
        rung: rung_1based,
        hash_changed: false,
        refusal: Some(refusal),
        next_look_secs,
    };

    // Rungs 1-3 never write, whatever the screen says.
    if rung < FIRST_WRITING_RUNG {
        return observe("observe-only-rung");
    }

    // Why we may not write, if we may not. Collected rather than returned early, because on the
    // nudge rungs a refusal must still be able to ESCALATE — see below.
    //
    // Gate 1 is restated here as well as in the screen gate: never interrupt a running turn. The
    // screen gate reads the SCREEN for a spinner; this reads the agent status table. Either saying
    // "working" is enough to stand down, because the two can disagree — the status table is written
    // by the frontend and goes stale exactly when the frontend wedges, which is the case this whole
    // module exists to survive.
    // AN UNREADABLE SCREEN OUTRANKS A `working` CLAIM, and this ordering is the whole finding.
    //
    // `working` comes from two sources that BOTH freeze when the WebView wedges: the roster status
    // is frontend-written (a stale "working" simply persists), and the screen spinner is read from
    // the observer's grid, which stops advancing the instant the PTY reader parks. So an agent that
    // was mid-turn — spinner on screen, "esc to interrupt" — when the reader parked reports
    // `working: true` FOREVER.
    //
    // Evaluating `working` first therefore returned "status-working" on every tick, which is one of
    // the two reasons excluded from counting as an attempt, so `attempts` stayed 0 and no flag was
    // ever raised. That is the same silent inertness the attempt counter was introduced to close —
    // and it applied to the MOST LIKELY way of entering the wedged state. A `working` claim we
    // cannot re-verify is not evidence; an unreadable screen is.
    let blocked: Option<&'static str> = if !obs.screen_readable {
        obs.refusal.or(Some("screen-unreadable"))
    } else if obs.working {
        Some("status-working")
    } else if obs.since_other_write_ms < QUIET_AFTER_OTHER_WRITE_MS {
        Some("recent-other-write")
    } else {
        obs.refusal
    };

    // -- A PROMPT WE ARE ALLOWED TO ANSWER, WE ANSWER --------------------------------------------
    // Ahead of the escalation below, because clearing it ourselves is strictly better than telling
    // a human about it: on the reported night dozens of these were hand-cleared one at a time.
    // The authority is entirely `nudge_gate::answer_refusal` (allowlisted read-only command, an
    // ordinary proceed-prompt, no credential prompt, not the billing picker); this only decides
    // that we have waited long enough -- a writing rung, so a human has had ~30s to answer first,
    // and the foreign-write stand-down is already satisfied by `blocked` being `awaiting-input`.
    if obs.answerable && blocked == Some("awaiting-input") {
        state.wrote_last_look = true;
        return Decision {
            action: Action::Answer,
            escalate: None,
            flagged: state.escalated,
            rung: rung_1based,
            hash_changed: false,
            refusal: None,
            next_look_secs,
        };
    }

    // -- A SCREEN ONLY A HUMAN CAN CLEAR: STOP NUDGING AND TELL SOMEBODY --------------------------
    // The gate refuses to type at these by construction, so every rung from here is a guaranteed
    // no-op and waiting them out is dead time a human spends not knowing. WHEN it fires is
    // per-token — see `parked_flag_rung`, which is where the reasoning lives.
    //
    // `!obs.answerable` is belt-and-braces: an answerable prompt has already returned above.
    // Stated explicitly so the two rules cannot drift into flagging a screen we can clear.
    if !obs.answerable {
        if let Some(reason) = blocked.filter(|r| parked_flag_rung(r).is_some_and(|at| rung >= at)) {
            // ITS OWN COUNTER, never `attempts` (roborev 63230, Medium). `attempts` means "nudges
            // we tried to send": it drives `GIVE_UP_AFTER` and is reported to a human as
            // `nudges:`. Charging silent observations to it made a parked agent burn the whole
            // give-up budget in 8 looks — so a screen that later became writable could never be
            // nudged again — while the row read `nudges: 8, delivered: 0` for an agent that was
            // never nudged once.
            state.parked_looks = state.parked_looks.saturating_add(1);
            state.last_blocked = Some(reason);
            // The HIGHER of "a human, now" and whatever the parked count has earned. This raises
            // the FLOOR; it must never become a ceiling that pins a permanently parked agent at
            // the concierge level for the rest of its life.
            let target = ordinary_target(state.parked_looks).max(Some(Escalation::Concierge));
            let escalate = raise(state, target);
            return Decision {
                action: Action::Observe,
                escalate,
                flagged: state.escalated,
                rung: rung_1based,
                hash_changed: false,
                refusal: Some(reason),
                next_look_secs,
            };
        }
    }

    if rung < FIRST_NUDGE_RUNG {
        // Shape A — the bare Enter, and ONLY onto a prompt that already holds text.
        if let Some(reason) = blocked {
            return observe(reason);
        }
        if !obs.prompt_has_text {
            return observe("prompt-empty");
        }
        return Decision {
            action: Action::Enter,
            escalate: None,
            // Rungs 4-6 are below the first escalation threshold by construction.
            flagged: None,
            rung: rung_1based,
            hash_changed: false,
            refusal: None,
            next_look_secs,
        };
    }

    // ── SHAPE B / SHAPE C — AND THE SPLIT BETWEEN THEM ────────────────────────────────────────
    // A REFUSED tick still counts as an attempt, so a refusal can still escalate. Returning early
    // here (as an earlier version did) meant an agent we could never write to could never raise a
    // flag either: it climbed to the top rung and stayed there, silent, with only a `debug!` line
    // below the default log level to show for it. That is worst in exactly the scenario this module
    // documents itself as existing for — a wedged WebView latches the PTY reader parked, which
    // refuses every tick forever — so one inertness bug would have been traded for a quieter one.
    // It also contradicted this function's own promise that "an agent parked behind a picker for
    // ten minutes should reach the escalation rungs and get a human's attention".
    //
    // TWO refusals are excluded, because they mean the agent is FINE rather than stuck: a running
    // turn, and somebody else having just typed. Escalating those would page a human about an agent
    // that is working.
    let counts_as_attempt = !matches!(blocked, Some("status-working") | Some("recent-other-write"));
    if !counts_as_attempt {
        return observe(blocked.unwrap_or("blocked"));
    }

    state.attempts += 1;
    let n = state.attempts;
    state.last_blocked = blocked;

    // Shape C — escalate. Not a write, and raised once per threshold crossed.
    let target = ordinary_target(n);
    // `>` not `>=`: re-raising the same flag every rung would turn one stuck agent into a stream of
    // identical notices, which is how a signal stops being read.
    let escalate = raise(state, target);

    // The attempt counted either way; whether a BYTE goes out is a separate question — and only a
    // byte can echo, so only a byte makes the next hash change OURS.
    let action = if blocked.is_some() { Action::Observe } else { Action::Nudge { n } };
    state.wrote_last_look = matches!(action, Action::Nudge { .. });

    Decision {
        action,
        escalate,
        // `target`, NOT `escalate`: the level this look sits at, which stays `Some` for the rest of
        // the episode once a threshold is crossed. This is what keeps the row EXISTING after the
        // high-water mark stops rising — see the field's doc comment.
        flagged: target,
        rung: rung_1based,
        hash_changed: false,
        refusal: blocked,
        next_look_secs,
    }
}

/// The flag level `n` counted attempts has earned, on the ordinary thresholds.
///
/// Factored out because the PARKED-SCREEN path must LAYER ON TOP of it rather than replace it.
/// Forcing a flat `Concierge` there capped a permanently parked agent at the concierge level
/// forever -- an agent sitting on a permission prompt all night would never have reached the
/// founder, which is the opposite of what flagging a parked screen is for.
///
/// (It was written as "the instant-escalation path" when such a path existed. Nothing escalates
/// instantly now: both parked tokens flag at `FIRST_NUDGE_RUNG` -- see `parked_flag_rung`.)
fn ordinary_target(n: u32) -> Option<Escalation> {
    if n >= ESCALATE_FOUNDER_AFTER {
        Some(Escalation::Founder)
    } else if n >= ESCALATE_CONCIERGE_AFTER {
        Some(Escalation::Concierge)
    } else {
        None
    }
}

/// Refusals that describe a screen only a HUMAN can clear, so more nudging cannot help.
///
/// -- WHY THESE ARE FLAGGED INSTEAD OF NUDGED ---------------------------------------------------
/// The ordinary ladder assumes a nudge might work: it types, waits, types again, and tells a human
/// only once several identical pings have been ignored. That assumption is FALSE for these
/// screens. An agent parked on a permission prompt or a credential prompt is not slow and is not
/// ignoring us -- the gate refuses to type at all (a paste-then-CR at a live picker presses a
/// button nobody read), so the ladder is guaranteed to write nothing on every remaining rung.
/// Spending those rungs is dead time a human spends not knowing.
///
/// So on these screens the first nudge is REPLACED BY A FLAG rather than sent. WHEN that happens
/// is `parked_flag_rung`, which is also where the reasoning for the timing lives -- this predicate
/// only answers "is this that kind of screen".
///
/// This is the shape of the outage this path exists for: on the reported night the fleet sat on
/// ordinary "Do you want to proceed?" prompts and onboarding screens for HOURS.
///
/// -- THE TOKENS ARE `nudge_gate::Refusal::as_str()` --------------------------------------------
/// Compared as strings because this module is deliberately pure -- the gate verdict arrives as a
/// parameter and this file imports nothing from `nudge_gate`. That is a real coupling risk, so
/// `nudger.rs` (which imports both) carries
/// `the_ladder_and_the_gate_agree_on_the_prompt_tokens`, asserting these tokens still match the
/// enum. That test was CLAIMED here before it existed (roborev 63230, Medium) -- a
/// documented-but-absent guard is worse than none, because the next reader trusts it.
///
/// `alternate-screen` and `no-viewport` are deliberately EXCLUDED: a full-screen app is exited and
/// an unreadable grid recovers, so both can clear without a human and neither justifies a flag.
pub(crate) fn stalled_on_a_prompt(reason: &str) -> bool {
    parked_flag_rung(reason).is_some()
}

/// The earliest rung at which a human-only screen is flagged. `None` = not one of them.
///
/// -- WHY THE SAME RUNG FOR BOTH, AND WHY IT IS NOT THE FIRST WRITING RUNG ----------------------
/// Because NEITHER recogniser is precise enough to earn a faster one. Both tokens are produced by
/// whole-screen matchers, so both can fire on a screen that is not the thing they name:
///
///   * `awaiting-input` collapses any `question_opener` / `menu_line` match in the live region,
///     including an agent's own rhetorical "Should I ...?" that it clears on its next turn.
///   * `credential-prompt` has TWO arms, and naming only the first is how a reader concludes "no
///     line ending `password:`, so no `credential-prompt`" -- which is false (roborev 63327):
///       - `write_block_password_colon`, `(?im)`-anchored PER LINE over the WHOLE screen rather
///         than the tail. Any visible line ending `password:` / `passphrase:` matches -- a diff of
///         this repo's own credential code, a scrolled-up `gh auth` transcript, the agent's prose.
///       - a WRAP-TOLERANT arm over the last `CREDENTIAL_TAIL_ROWS` non-blank rows: any
///         `credential_word` (`pass(word|phrase|code)`, `username`, `token`, `otp`, `verification
///         code`, `2fa`, `pin`) anywhere in that region, and the region ending in `:`. So an
///         ordinary `Refreshing token:` or `Set your PIN:` produces the token too.
///     And `write_refusal` tests credentials at gate 4, AHEAD of `screen_awaits_input` at gate 3,
///     so such a screen is reported as `credential-prompt`.
///
/// An earlier revision gave `credential-prompt` the first WRITING rung, reasoning that a password
/// field has no self-clearing variant (roborev 63247). True of a real password field -- but the
/// TOKEN is not that, and the effect was the inverse of the intent: the coarser recogniser got the
/// FASTER path, so a perfectly healthy agent with a stray `password:` line in scrollback raised a
/// concierge row at ~35s (roborev 63273).
///
/// THE COST OF THE UNIFORM RUNG IS STATED HONESTLY: a genuine password prompt now waits ~245s
/// rather than ~35s. That is the right trade while the recogniser is whole-screen -- a false page
/// on a healthy agent is how a signal stops being read, which this module's header treats as the
/// failure that matters.
///
/// THE REVISIT CONDITION IS "NARROW **BOTH** ARMS", and stating it as one was itself a trap
/// (roborev 63327). The wrap-tolerant arm is ALREADY tail-scoped, so narrowing
/// `write_block_password_colon` alone changes nothing about it -- and anyone who then restores the
/// faster rung on the strength of "the matcher is tail-scoped now" reintroduces the exact ~35s
/// false page this constant exists to remove, through the arm they did not touch. A faster rung is
/// earned only when NEITHER arm can fire on a screen that is not a live credential prompt.
fn parked_flag_rung(reason: &str) -> Option<usize> {
    match reason {
        "credential-prompt" | "awaiting-input" => Some(FIRST_NUDGE_RUNG),
        _ => None,
    }
}

/// Advance the escalation high-water mark, returning a target only when it actually ROSE.
///
/// Factored out because three call sites now need it — the reset branch, the stand-down gate and
/// the ordinary nudge path — and three hand-rolled copies of a high-water mark is three chances for
/// one of them to re-raise the same flag every look, which is how a signal stops being read.
fn raise(state: &mut AgentState, target: Option<Escalation>) -> Option<Escalation> {
    match (target, state.escalated) {
        (Some(t), None) => {
            state.escalated = Some(t);
            Some(t)
        }
        (Some(t), Some(prev)) if t > prev => {
            state.escalated = Some(t);
            Some(t)
        }
        _ => None,
    }
}

/// Which stand-down actually applies, folding the goal state in with the agent's own answer.
///
/// ── AN EXPLICIT ASK FOR A PERSON OUTRANKS A MET GOAL ──────────────────────────────────────────
/// The ordering is the safety rule, not a preference. `goal_met` silences the row entirely, so if
/// it won here an agent that answered `blocked-on-human` while its goal happened to read met would
/// have the row a human owes deleted by a stale frontend fact. The two should not co-occur — but
/// "should not" is not a guarantee, and the failure is asymmetric: the wrong way round loses a
/// human's row silently, this way round costs one visible flag that a human can dismiss.
fn effective_standdown(state: &AgentState, obs: &Observation) -> Option<Standdown> {
    if state.standdown == Some(Standdown::AwaitHuman) {
        return Some(Standdown::AwaitHuman);
    }
    // `goal_met_superseded` is the "unless new work arrives" clause for the GOAL, and it has to be
    // separate from the reply's because the two facts decay differently: a reply is a latch we own
    // and can clear, whereas `goal_met` is recomputed upstream every look and will keep saying "met"
    // about a goal the agent finished hours before the work now in front of it.
    if obs.goal_met && !state.goal_met_superseded {
        return Some(Standdown::Done);
    }
    state.standdown
}

/// The flag level a stand-down sits at, never dropping below what the episode already reached.
///
/// `Done` is the one that genuinely clears: an agent that is FINISHED is not a row anybody owes,
/// and leaving a founder flag up on it is exactly the "channel that reports resolved problems"
/// this module's header warns stops being read. Every other variant takes the higher of its own
/// level and the high-water mark, because a row must never silently downgrade — telling the
/// founder that somebody else has it is worse than saying nothing.
fn standdown_level(stand: Option<Standdown>, escalated: Option<Escalation>) -> Option<Escalation> {
    match stand {
        Some(Standdown::Done) => None,
        Some(s) => s.flag().max(escalated),
        None => escalated,
    }
}

/// THE nudge string. One variant, fixed text, no generation — so it is testable and cannot drift.
///
/// Every clause earns its place:
///   * `[sparkle-nudge #N · no output for D]` — a counter and a duration, so a human reading
///     scrollback sees the history rather than one mysterious line.
///   * "Automated ping, not a new task" — self-identifies, so the agent does not read it as the
///     founder speaking and does not treat it as a change of assignment.
///   * "Resume your goal" — the instruction, and it is idempotent: safe to receive twenty times.
///   * The typed reply vocabulary — the SAME small set the pusher loop (sparkle-4cd0x) parses, so a
///     blocked agent's answer is machine-readable by the layer above instead of dying in a terminal.
///     Two of the tokens are NOT blockers and route to the concierge rather than the founder:
///     `no-task-assigned` (a finished/task-less agent — nothing for a person to unblock,
///     bead `sparkle-dfy3d`) and `out-of-context` (context exhausted — succeed it or hand off to a
///     successor, bead `sparkle-umtx1`). Neither paints the founder's red row.
///   * "the exact command or permission you need" — the token says WHO is owed; this says WHAT.
///     Asking for "what you need" got prose that named no action, so the row reached a human with
///     nothing on it to act on: one agent sat blocked on a privileged command for two days without
///     ever stating the command, and its branch fell far enough behind to become a revert risk
///     rather than a fix (bead `sparkle-afi6u`). A `blocked-on-human` row a human cannot act on
///     without a round trip is the expensive half of blocking, and the round trip is what costs
///     days — so the first answer has to carry the command.
pub fn nudge_text(n: u32, silent_secs: u64) -> String {
    format!(
        "[sparkle-nudge #{n} · no output for {}] Automated ping, not a new task. Resume your \
         goal. Reply with ONE line: blocked-on-human | blocked-on-ci | blocked-on-another-agent | \
         blocked-on-quota | not-blocked | no-task-assigned | out-of-context — plus the exact \
         command or permission you need.",
        human_duration(silent_secs)
    )
}

/// The last clause of `nudge_text`, and the boundary between OUR QUESTION and THEIR ANSWER.
///
/// This anchor is not decoration — it is the whole reason a naive parse is wrong. The nudge string
/// itself LISTS all five reply tokens, so any search over the raw screen matches our own question
/// and reads it as the agent's answer, every single time, on an agent that has said nothing at all.
/// That would silence a genuinely stalled agent, which is the one outcome forbidden here.
const NUDGE_TAIL: &str = "plus the exact command or permission you need.";

/// How much of the screen after the question can be the ANSWER, in whitespace-stripped chars.
///
/// The nudge asks for one line, immediately. This is roughly three terminal rows once the spaces
/// are gone — ample for a wrapped one-liner plus a bullet, and far short of the rest of a screen
/// that might be showing a diff of this file or the agent quoting its instructions back.
const REPLY_WINDOW_CHARS: usize = 240;

/// Read the agent's one-line answer to the MOST RECENT nudge, if it has given one.
///
/// ── FAIL CLOSED, AND WHICH DIRECTION THAT IS ──────────────────────────────────────────────────
/// `None` means "no answer I can be sure of", and every uncertain path returns it: no nudge on
/// screen, a nudge whose text is cut off by scrollback, no token after the question. `None` leaves
/// the ordinary ladder running, so an unparseable screen keeps getting nudged. That is deliberately
/// the noisy direction — a false NEGATIVE costs one more ping, a false POSITIVE goes quiet on an
/// agent that never spoke, and Sparkle's standing rule is that a stalled agent is never hidden.
///
/// ── WHY WHITESPACE IS STRIPPED ────────────────────────────────────────────────────────────────
/// This reads a RENDERED VT grid, so the terminal has already hard-wrapped both the nudge and the
/// reply at the pane width — and the wrap lands wherever the column happens to fall, which can be
/// the middle of `not-blocked`. Comparing whitespace-free forms makes the match independent of the
/// pane geometry, which is exactly what the module's header says the grid must not be trusted for.
pub fn parse_reply(screen: &str) -> Option<Reply> {
    let flat: String = screen.chars().filter(|c| !c.is_whitespace()).collect();
    let marker: String = NUDGE_MARKER.chars().filter(|c| !c.is_whitespace()).collect();
    let tail: String = NUDGE_TAIL.chars().filter(|c| !c.is_whitespace()).collect();

    // Where the most recent nudge starts…
    let marker_at = flat.rfind(&marker)?;
    // …and where its text ends. Anything before this is OUR question, and must never be read as an
    // answer. A missing tail means the nudge is truncated, so the boundary is unknown: give up.
    let answer_from = flat[marker_at..].find(&tail).map(|i| marker_at + i + tail.len())?;

    // ── AND THE REGION IS BOUNDED (roborev 60323, Medium) ─────────────────────────────────────
    // "Everything after the question to the end of the screen" is far too generous. The tokens are
    // ordinary words that show up in ordinary output — an agent quoting the instruction back, a
    // `git diff` of THIS VERY FILE (which contains the marker, the tail and all five tokens), a
    // prompt that happens to mention being blocked. Absorbing any of those latches a stand-down and
    // stops the typing on an agent that never answered: the false-positive direction this function
    // is not allowed to fail in.
    //
    // The nudge asks for ONE LINE, immediately. A wrapped one-liner is comfortably inside this
    // window and a stray token further down the screen is outside it.
    // Taken in CHARS, not bytes: `·` and `—` are three bytes each, so a byte slice would land
    // mid-codepoint and panic.
    let region = &flat[answer_from..];
    let window: String = region.chars().take(REPLY_WINDOW_CHARS).collect();

    // The LAST token in the window wins: an agent that corrects itself ("not-blocked — actually
    // blocked-on-ci") means the correction.
    REPLY_TOKENS
        .iter()
        .filter_map(|(token, reply)| window.rfind(token).map(|i| (i, *reply)))
        .max_by_key(|(i, _)| *i)
        .map(|(_, reply)| reply)
}

/// Compact, stable duration rendering: `45s`, `2m 5s`, `1h 3m`. Stable matters — this string goes
/// into the terminal, and a format that drifts makes scrollback un-greppable.
fn human_duration(secs: u64) -> String {
    if secs < 60 {
        return format!("{secs}s");
    }
    if secs < 3600 {
        let (m, s) = (secs / 60, secs % 60);
        return if s == 0 { format!("{m}m") } else { format!("{m}m {s}s") };
    }
    let (h, m) = (secs / 3600, (secs % 3600) / 60);
    if m == 0 {
        format!("{h}h")
    } else {
        format!("{h}h {m}m")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stalled agent: same hash forever, nothing on screen to refuse, prompt empty, no other
    /// writer. The default subject of every test below; each one changes exactly what it is about.
    fn stalled() -> Observation {
        Observation {
            hash: 0xdead_beef,
            working: false,
            refusal: None,
            screen_readable: true,
            prompt_has_text: false,
            since_other_write_ms: u64::MAX,
            foreign_write_ms: 0,
            goal_met: false,
            reply: None,
            answerable: false,
            elapsed_secs: None,
            rollup_dot: None,
            stage: None,
        }
    }

    /// A screen holding nudge #N and, optionally, the agent's one-line answer under it. Built from
    /// `nudge_text` rather than a hand-written string so a test can never assert against a question
    /// the module does not actually ask — the vacuity this repo's #1 finding is about.
    fn screen_after_nudge(n: u32, answer: Option<&str>) -> String {
        let mut s = format!("● doing some work\n{}\n", nudge_text(n, 245));
        if let Some(a) = answer {
            s.push_str(&format!("● {a}\n"));
        }
        s
    }

    /// Run `n` looks and collect what was decided each time.
    fn run(state: &mut AgentState, obs: &Observation, n: usize) -> Vec<Decision> {
        (0..n).map(|_| step(state, obs)).collect()
    }

    // ══ THE DETECTOR ════════════════════════════════════════════════════════════════════════════

    #[test]
    fn a_pty_that_stops_emitting_climbs_the_whole_ladder() {
        let mut s = AgentState::default();
        let decisions = run(&mut s, &stalled(), 12);

        // Rung 1 is the seeding look — it has no previous hash to compare against.
        assert_eq!(decisions[0].rung, 1);
        assert_eq!(decisions[0].refusal, Some("seeding"));

        // Then one rung per unchanged look, saturating at the last entry rather than running off
        // the end. The bead's ladder verbatim: 5, 10, 20, 30, 60, 120, 300, 600, then 600 forever.
        let rungs: Vec<u32> = decisions.iter().map(|d| d.rung).collect();
        assert_eq!(rungs, vec![1, 2, 3, 4, 5, 6, 7, 8, 8, 8, 8, 8]);

        let waits: Vec<u64> = decisions.iter().map(|d| d.next_look_secs).collect();
        assert_eq!(waits, vec![5, 10, 20, 30, 60, 120, 300, 600, 600, 600, 600, 600]);
    }

    #[test]
    fn any_output_change_resets_the_ladder_to_rung_one() {
        let mut s = AgentState::default();
        run(&mut s, &stalled(), 8);
        assert_eq!(s.rung(), 7, "precondition: parked at the top of the ladder");

        let moved = Observation { hash: 0x1234, ..stalled() };
        let d = step(&mut s, &moved);

        assert!(d.hash_changed);
        assert_eq!(d.rung, 1);
        assert_eq!(d.next_look_secs, 5);
        assert_eq!(d.action, Action::Observe);
        assert_eq!(s.silent_secs(), 0);

        // The nudge history needs one more look to clear, and that is deliberate rather than sloppy:
        // the 8 looks above END on a nudge, so the FIRST change after them is our own echo and is
        // ours by construction (see `our_own_echo_does_not_reset_the_counter_when_the_agent_never_
        // answers`). The second change, with no write of ours in between, is the agent.
        assert_eq!(s.attempts(), 2, "the echo of our own last nudge is not the agent moving");
        // And clearing it takes a RUN of output, not one more sample: a live pane repaints without
        // the agent doing anything, and treating one repaint as "back to work" is what pinned the
        // counter at `#1` forever. See `LIVE_LOOKS_TO_RESET`.
        for h in 0x5678..(0x5678 + LIVE_LOOKS_TO_RESET as u64) {
            step(&mut s, &Observation { hash: h, ..stalled() });
        }
        assert_eq!(s.attempts(), 0, "a moving agent has no nudge history");
    }

    /// The change detector is the WHOLE detector. A one-byte difference in the hashed window is a
    /// reset; there is no content interpretation anywhere.
    #[test]
    fn a_reset_clears_an_escalation_too() {
        let mut s = AgentState::default();
        run(&mut s, &stalled(), 20);
        assert!(s.attempts() >= ESCALATE_FOUNDER_AFTER, "precondition: escalated");

        // A RUN of unprovoked output, which is what a recovered agent actually produces.
        let mut h = 0xfeed_u64;
        for _ in 0..LIVE_LOOKS_TO_RESET {
            step(&mut s, &Observation { hash: h, ..stalled() });
            h += 1;
        }
        assert_eq!(s.escalated(), None, "a recovered agent's high-water mark is cleared");

        // Climb again and assert the concierge flag is raised afresh rather than suppressed by the
        // previous episode's high-water mark.
        let d = run(&mut s, &Observation { hash: h - 1, ..stalled() }, 9);
        let raised: Vec<Escalation> = d.iter().filter_map(|d| d.escalate).collect();
        assert_eq!(
            raised.first(),
            Some(&Escalation::Concierge),
            "the ladder must be able to flag from scratch again: {raised:?}"
        );
    }

    // ══ OBSERVE-ONLY RUNGS ══════════════════════════════════════════════════════════════════════

    /// The correction the founder accepted, pinned. An agent legitimately produces no output for
    /// well over a minute while a shell command runs, so the early rungs must never write — even
    /// when every other condition would permit it.
    #[test]
    fn the_first_three_rungs_never_write_even_with_text_waiting() {
        let mut s = AgentState::default();
        let ready = Observation { prompt_has_text: true, ..stalled() };
        let decisions = run(&mut s, &ready, 3);

        for d in &decisions {
            assert_eq!(d.action, Action::Observe, "rung {} must not write", d.rung);
        }
        assert_eq!(decisions[1].refusal, Some("observe-only-rung"));
        assert_eq!(decisions[2].refusal, Some("observe-only-rung"));

        // ...and the very next look, rung 4, does write. Without this the assertion above would
        // pass against a module that never writes at all.
        let d = step(&mut s, &ready);
        assert_eq!(d.rung, 4);
        assert_eq!(d.action, Action::Enter);
    }

    // ══ SHAPE A — THE BARE ENTER ════════════════════════════════════════════════════════════════

    #[test]
    fn an_enter_fires_on_a_non_empty_prompt_at_rungs_four_through_six() {
        let mut s = AgentState::default();
        let ready = Observation { prompt_has_text: true, ..stalled() };
        let decisions = run(&mut s, &ready, 6);

        assert_eq!(decisions[3].action, Action::Enter, "rung 4");
        assert_eq!(decisions[4].action, Action::Enter, "rung 5");
        assert_eq!(decisions[5].action, Action::Enter, "rung 6");
        for d in &decisions[3..6] {
            assert_eq!(d.refusal, None, "a write records no refusal");
        }
    }

    /// "If the prompt is EMPTY, send nothing — a bare Enter into an empty prompt is a no-op at best
    /// and confirms a dialog at worst."
    #[test]
    fn nothing_fires_on_an_empty_prompt() {
        let mut s = AgentState::default();
        let decisions = run(&mut s, &stalled(), 6);
        for d in &decisions[3..6] {
            assert_eq!(d.action, Action::Observe, "rung {} must stay silent", d.rung);
            assert_eq!(d.refusal, Some("prompt-empty"));
        }
    }

    // ══ THE VETOES ══════════════════════════════════════════════════════════════════════════════

    #[test]
    fn nothing_fires_while_working() {
        let mut s = AgentState::default();
        let busy = Observation { working: true, prompt_has_text: true, ..stalled() };
        // Far past every writing rung, including the nudge rungs.
        for d in run(&mut s, &busy, 10) {
            assert_eq!(d.action, Action::Observe, "rung {} wrote into a running turn", d.rung);
        }
        assert_eq!(s.attempts(), 0);
    }

    #[test]
    fn nothing_fires_when_the_screen_gate_refuses() {
        // A picker and a vim buffer reach this layer as an opaque refusal string — the ladder does
        // not re-derive them, it just declines and records the reason for the log.
        for reason in ["awaiting-input", "alternate-screen", "credential-prompt", "no-viewport"] {
            let mut s = AgentState::default();
            let blocked =
                Observation { refusal: Some(reason), prompt_has_text: true, ..stalled() };
            for d in run(&mut s, &blocked, 10) {
                assert_eq!(d.action, Action::Observe, "wrote despite {reason}");
                if d.rung >= 4 {
                    assert_eq!(d.refusal, Some(reason));
                }
            }
            assert_eq!(s.delivered(), 0, "a refused screen never delivers a nudge");
        }
    }

    /// A PERSISTENT REFUSAL MUST STILL REACH A HUMAN — the bug this replaced.
    ///
    /// An earlier version returned early on any refusal, BEFORE the escalation block, so an agent we
    /// could never write to could never raise a flag either: it climbed to the top rung and stayed
    /// there, silent, with only a `debug!` line below the default log level. Worst in exactly the
    /// scenario this module exists for — a wedged WebView latches the PTY reader parked, which
    /// refuses every tick forever — so the module would have been completely inert AND silent.
    #[test]
    fn an_agent_we_can_never_write_to_still_escalates() {
        for reason in ["reader-parked", "awaiting-input", "no-viewport"] {
            let mut s = AgentState::default();
            let blocked = Observation { refusal: Some(reason), ..stalled() };
            let decisions = run(&mut s, &blocked, 20);

            assert!(
                decisions.iter().all(|d| d.action == Action::Observe),
                "{reason}: must never write"
            );
            let raised: Vec<Escalation> = decisions.iter().filter_map(|d| d.escalate).collect();
            assert_eq!(
                raised,
                vec![Escalation::Concierge, Escalation::Founder],
                "{reason}: a human must still be told about an agent we cannot reach"
            );
            assert_eq!(s.delivered(), 0, "{reason}: and nothing was actually delivered");
            assert_eq!(
                s.last_blocked(),
                Some(reason),
                "{reason}: the flag must carry WHY, so the consumer can tell it from being ignored"
            );
        }
    }

    /// THE `working` VETO MUST NOT SURVIVE AN UNREADABLE SCREEN — and this is the likeliest way in.
    ///
    /// `working` is derived from two sources that BOTH freeze when the WebView wedges: the roster
    /// status is frontend-written (a stale "working" just persists) and the screen spinner is read
    /// off a grid that stops advancing the moment the PTY reader parks. So an agent that was
    /// mid-turn — spinner up, "esc to interrupt" on screen — when the reader parked reports
    /// `working: true` forever, and an earlier version let that suppress the attempt on every tick:
    /// no writes, no flag, nothing. The same silent inertness, entered the most likely way.
    ///
    /// The previous escalation tests could not catch it because every fixture set `working: false`.
    #[test]
    fn a_frozen_working_claim_cannot_suppress_escalation() {
        let mut s = AgentState::default();
        let wedged_mid_turn = Observation {
            // Both signals still assert "working" — and both are stale by construction.
            working: true,
            screen_readable: false,
            refusal: Some("reader-parked"),
            ..stalled()
        };
        let decisions = run(&mut s, &wedged_mid_turn, 20);

        assert!(decisions.iter().all(|d| d.action == Action::Observe), "must never write");
        let raised: Vec<Escalation> = decisions.iter().filter_map(|d| d.escalate).collect();
        assert_eq!(
            raised,
            vec![Escalation::Concierge, Escalation::Founder],
            "a `working` claim we cannot re-verify is not evidence; the human must still be told"
        );
        assert_eq!(s.last_blocked(), Some("reader-parked"), "and the flag must carry why");
    }

    /// An unreadable screen with NO refusal string still blocks and still escalates — the reason is
    /// the unreadability itself, not whatever the gate happened to say.
    #[test]
    fn an_unreadable_screen_blocks_even_without_a_refusal_reason() {
        let mut s = AgentState::default();
        let blind = Observation { screen_readable: false, prompt_has_text: true, ..stalled() };
        let decisions = run(&mut s, &blind, 20);
        assert!(decisions.iter().all(|d| d.action == Action::Observe));
        assert_eq!(s.last_blocked(), Some("screen-unreadable"));
        assert!(decisions.iter().any(|d| d.escalate == Some(Escalation::Founder)));
    }

    /// The two refusals that mean the agent is FINE rather than stuck must NOT escalate — paging a
    /// human about a working agent is how a channel stops being read.
    #[test]
    fn a_working_or_just_typed_agent_never_escalates() {
        // Both fixtures keep `screen_readable: true` (from `stalled()`), which is the whole
        // precondition: a `working` claim only earns the veto while we can still re-verify it.
        for obs in [
            Observation { working: true, ..stalled() },
            Observation { since_other_write_ms: 0, ..stalled() },
        ] {
            let mut s = AgentState::default();
            let decisions = run(&mut s, &obs, 25);
            assert!(
                decisions.iter().all(|d| d.escalate.is_none()),
                "an agent that is working or was just typed into must not raise a flag"
            );
            assert_eq!(s.attempts(), 0);
        }
    }

    /// `delivered` is the honest denominator for "does nudging work" and is recorded by the driver,
    /// never inferred by the ladder.
    #[test]
    fn attempts_and_deliveries_are_counted_separately() {
        let mut s = AgentState::default();
        run(&mut s, &stalled(), 9);
        assert_eq!(s.attempts(), 3, "three ticks reached a nudge rung");
        assert_eq!(s.delivered(), 0, "but the driver has not reported any as submitted");

        s.record_delivered();
        assert_eq!(s.delivered(), 1);
        assert_eq!(s.attempts(), 3, "recording a delivery must not move the escalation counter");
    }

    /// The hazard with no JS analogue: a Rust write bypasses `chainPtyOp`'s serialization, so a
    /// byte landing inside another writer's 60ms paste→CR window would submit a prompt nobody sent.
    #[test]
    fn nothing_fires_just_after_somebody_else_wrote() {
        let mut s = AgentState::default();
        let just_typed = Observation {
            prompt_has_text: true,
            since_other_write_ms: QUIET_AFTER_OTHER_WRITE_MS - 1,
            ..stalled()
        };
        for d in run(&mut s, &just_typed, 6) {
            assert_eq!(d.action, Action::Observe);
        }
        assert_eq!(
            run(&mut s, &just_typed, 1)[0].refusal,
            Some("recent-other-write")
        );

        // Once the window has passed, the same state writes — so the assertion above is about the
        // window and not about some other veto.
        let settled =
            Observation { since_other_write_ms: QUIET_AFTER_OTHER_WRITE_MS, ..just_typed };
        assert!(matches!(step(&mut s, &settled).action, Action::Nudge { .. }));
    }

    // ══ SHAPE B — THE NUDGE ═════════════════════════════════════════════════════════════════════

    #[test]
    fn the_nudge_string_starts_at_rung_seven() {
        let mut s = AgentState::default();
        let decisions = run(&mut s, &stalled(), 8);
        assert_eq!(decisions[5].action, Action::Observe, "rung 6 is still Enter territory");
        assert_eq!(decisions[6].action, Action::Nudge { n: 1 }, "rung 7 = 300s = 5 minutes");
        assert_eq!(decisions[7].action, Action::Nudge { n: 2 });
    }

    /// A nudge is sent even when the prompt is empty — unlike the bare Enter. The Enter needs
    /// something to submit; the nudge IS the something.
    #[test]
    fn the_nudge_does_not_require_text_on_the_prompt() {
        let mut s = AgentState::default();
        let decisions = run(&mut s, &stalled(), 7);
        assert!(!stalled().prompt_has_text);
        assert_eq!(decisions[6].action, Action::Nudge { n: 1 });
    }

    #[test]
    fn the_nudge_text_is_one_fixed_variant() {
        let text = nudge_text(3, 900);
        assert_eq!(
            text,
            "[sparkle-nudge #3 · no output for 15m] Automated ping, not a new task. Resume your \
             goal. Reply with ONE line: blocked-on-human | blocked-on-ci | blocked-on-another-agent | \
             blocked-on-quota | not-blocked | no-task-assigned | out-of-context — plus the exact \
             command or permission you need."
        );
    }

    /// THE ANCHOR MUST STAY A SUFFIX OF THE QUESTION, and this is the one drift that fails SILENTLY.
    ///
    /// `parse_reply` locates the question/answer boundary by finding `NUDGE_TAIL` inside the nudge.
    /// Reword the nudge's last clause without moving the anchor and that `find` returns `None` on
    /// every screen forever — so every blocked agent's answer goes unheard while the ladder keeps
    /// pinging, and nothing anywhere reports an error. Pinning the suffix relationship (not the
    /// literal text) lets the copy keep evolving while the parser stays wired to it.
    #[test]
    fn the_parse_anchor_is_the_last_clause_of_the_question() {
        let text = nudge_text(7, 60);
        assert!(
            text.ends_with(NUDGE_TAIL),
            "NUDGE_TAIL must be the literal tail of nudge_text, else parse_reply finds no boundary"
        );
    }

    /// The reply vocabulary is the contract with the pusher loop (sparkle-4cd0x), which parses
    /// these tokens rather than re-reading prose with a model. Changing one silently breaks that.
    #[test]
    fn the_nudge_offers_the_vocabulary_the_pusher_parses() {
        let text = nudge_text(1, 60);
        for token in [
            "blocked-on-human",
            "blocked-on-ci",
            "blocked-on-another-agent",
            "blocked-on-quota",
            "not-blocked",
            "no-task-assigned",
            "out-of-context",
        ] {
            assert!(text.contains(token), "nudge must offer {token}");
        }
        assert!(text.contains("Automated ping, not a new task"), "must self-identify as automated");
    }

    #[test]
    fn durations_render_compactly() {
        assert_eq!(human_duration(45), "45s");
        assert_eq!(human_duration(60), "1m");
        assert_eq!(human_duration(125), "2m 5s");
        assert_eq!(human_duration(3600), "1h");
        assert_eq!(human_duration(3780), "1h 3m");
    }

    /// The duration in the message is the agent's REAL silence, accumulated from the rungs already
    /// waited — not a constant and not the current rung.
    #[test]
    fn the_nudge_reports_the_accumulated_silence() {
        let mut s = AgentState::default();
        run(&mut s, &stalled(), 7);
        // Waited 5 + 10 + 20 + 30 + 60 + 120 = 245s to reach the first nudge at rung 7.
        assert_eq!(s.silent_secs(), 245);
        assert!(nudge_text(1, s.silent_secs()).contains("no output for 4m 5s"));
    }

    // ══ SHAPE C — ESCALATION ════════════════════════════════════════════════════════════════════

    #[test]
    fn two_nudges_flag_the_concierge_and_four_flag_the_founder() {
        let mut s = AgentState::default();
        let decisions = run(&mut s, &stalled(), 20);

        let raised: Vec<(u32, Escalation)> =
            decisions.iter().filter_map(|d| d.escalate.map(|e| (d.rung, e))).collect();
        assert_eq!(
            raised,
            vec![(8, Escalation::Concierge), (8, Escalation::Founder)],
            "one concierge flag at the 2nd nudge, one founder flag at the 4th, and nothing else"
        );

        // Pin WHICH nudge each flag rode along with, so a change to the ladder that moved the
        // thresholds could not pass this test by coincidence of rung numbering.
        let concierge_at = decisions.iter().position(|d| d.escalate == Some(Escalation::Concierge));
        let founder_at = decisions.iter().position(|d| d.escalate == Some(Escalation::Founder));
        // Literals, NOT the constants the implementation reads: a test that re-derives the
        // threshold from the same const it is guarding cannot notice the const moving.
        assert_eq!(decisions[concierge_at.unwrap()].action, Action::Nudge { n: 2 });
        assert_eq!(decisions[founder_at.unwrap()].action, Action::Nudge { n: 4 });
    }

    /// A flag is raised ONCE. Re-raising every rung would turn one stuck agent into a stream of
    /// identical notices, which is how a signal stops being read.
    #[test]
    fn a_flag_is_not_re_raised_every_rung() {
        let mut s = AgentState::default();
        let decisions = run(&mut s, &stalled(), 40);
        assert_eq!(
            decisions.iter().filter(|d| d.escalate.is_some()).count(),
            2,
            "exactly two flags for one episode, however long it runs"
        );
    }

    /// ESCALATING ONCE AND EXISTING THROUGHOUT ARE DIFFERENT FACTS, and conflating them is what let
    /// a founder-level row vanish for the rest of an agent's life. `escalate` fires twice in an
    /// episode however long it runs (above); `flagged` must hold from the first threshold on,
    /// because that is what tells the driver the row still belongs on the surface.
    #[test]
    fn every_look_past_a_threshold_stays_flagged_though_only_two_escalate() {
        let mut s = AgentState::default();
        let decisions = run(&mut s, &stalled(), 40);

        let first_flagged = decisions
            .iter()
            .position(|d| d.flagged.is_some())
            .expect("a stalled agent must reach a flagging level");
        assert_eq!(
            decisions[first_flagged].escalate,
            Some(Escalation::Concierge),
            "the first flagging look is also the first escalation"
        );
        assert!(
            decisions[first_flagged..].iter().all(|d| d.flagged.is_some()),
            "once flagged, every later look of the episode is still a flagging look"
        );
        assert!(
            decisions.iter().filter(|d| d.flagged.is_some()).count() > 2,
            "otherwise this passes against a `flagged` that merely copies `escalate`"
        );

        // ...and the level only ever RISES within an episode. A row that silently downgraded from
        // founder to concierge would tell the founder somebody else has it.
        let levels: Vec<Escalation> = decisions.iter().filter_map(|d| d.flagged).collect();
        assert!(levels.windows(2).all(|w| w[1] >= w[0]), "level must not drop: {levels:?}");
        assert_eq!(*levels.last().unwrap(), Escalation::Founder);
    }

    /// The episode reset clears the LEVEL too, not just the escalation high-water mark — otherwise
    /// a recovered agent's row would be re-raised forever by the driver's between-looks repair.
    #[test]
    fn output_clears_the_flag_level_and_the_state_that_drives_the_repair() {
        let mut s = AgentState::default();
        run(&mut s, &stalled(), 20);
        assert_eq!(s.escalated(), Some(Escalation::Founder), "precondition: escalated");

        // A RUN of output, which is what recovery looks like. One repaint deliberately does NOT
        // clear the row: an agent that merely redraws is still stuck, and a row a human owes is
        // never hidden.
        let mut d = None;
        for h in 0xfeed..(0xfeed + LIVE_LOOKS_TO_RESET as u64) {
            d = Some(step(&mut s, &Observation { hash: h, ..stalled() }));
        }
        let d = d.unwrap();
        assert!(d.hash_changed);
        assert_eq!(d.flagged, None, "a recovered agent's look is not a flagging look");
        assert_eq!(s.escalated(), None, "and nothing is left to re-raise it from");
    }

    /// Escalation is NOT a write. The module never addresses a human itself — it records a flag the
    /// pusher/concierge loop consumes.
    #[test]
    fn escalation_never_produces_its_own_message() {
        let mut s = AgentState::default();
        for d in run(&mut s, &stalled(), 40) {
            if d.escalate.is_some() {
                assert!(
                    matches!(d.action, Action::Nudge { .. }),
                    "an escalating tick carries the ordinary nudge, never a human-addressed message"
                );
            }
        }
    }

    // ══ TONIGHT ═════════════════════════════════════════════════════════════════════════════════

    /// The two failures that motivated the bead, replayed end to end.
    #[test]
    fn tonights_failures_are_covered() {
        // 1. Five agents holding a typed-but-unsent answer (sparkle-bhhu1). The prompt has text and
        //    nothing is on screen to refuse: an Enter at rung 4, thirty seconds in, at zero cost.
        let mut held = AgentState::default();
        let holding = Observation { prompt_has_text: true, ..stalled() };
        let d = run(&mut held, &holding, 4);
        assert_eq!(d[3].action, Action::Enter);
        assert_eq!(d.iter().map(|d| d.next_look_secs).take(4).sum::<u64>(), 65);

        // 2. "Mount Tells The Truth" — died on a 529, sat errored for hours with nothing on the
        //    prompt. No Enter (nothing to submit), a nudge at 5 minutes, the concierge flagged, and
        //    then the founder — rather than silence until a human happened to look.
        let mut dead = AgentState::default();
        let decisions = run(&mut dead, &stalled(), 13);
        assert!(decisions.iter().all(|d| d.action != Action::Enter));
        assert_eq!(decisions[6].action, Action::Nudge { n: 1 });
        assert!(decisions.iter().any(|d| d.escalate == Some(Escalation::Concierge)));
        assert!(decisions.iter().any(|d| d.escalate == Some(Escalation::Founder)));
    }

    // ══ READING THE ANSWER ══════════════════════════════════════════════════════════════════════

    /// THE TRAP THAT MAKES A NAIVE PARSER WORSE THAN NONE.
    ///
    /// `nudge_text` ENDS by listing all five reply tokens, so a parser that searches the raw screen
    /// finds every one of them on an agent that has answered nothing — and reads our own question
    /// as consent to stop nudging. That would silence a genuinely stalled agent, the one outcome
    /// this module forbids. Asserted first because every other parser test would pass without it.
    #[test]
    fn the_nudges_own_question_is_never_read_as_an_answer() {
        let unanswered = screen_after_nudge(1, None);
        for token in ["blocked-on-human", "blocked-on-quota", "not-blocked"] {
            assert!(unanswered.contains(token), "precondition: the question really does list {token}");
        }
        assert_eq!(
            parse_reply(&unanswered),
            None,
            "the question lists every token; only text AFTER it can be an answer"
        );
    }

    /// THE QUESTION AND THE ANSWER ARE ONE CONTRACT. Built from `nudge_text` itself, so a token
    /// renamed on one side and not the other fails here rather than going quietly unparsed for
    /// months — which is exactly how "the ladder asks a question it does not listen for the answer
    /// to" survived as long as it did.
    #[test]
    fn every_token_the_nudge_offers_parses_back() {
        for (token, expected) in REPLY_TOKENS {
            assert!(
                nudge_text(1, 60).contains(token),
                "{token} is parsed but never offered — the vocabulary has drifted"
            );
            assert_eq!(
                parse_reply(&screen_after_nudge(1, Some(token))),
                Some(expected),
                "the agent answered {token} and the ladder did not hear it"
            );
        }
    }

    /// The founder's screenshot verbatim — the exact line the agent sent fourteen times.
    #[test]
    fn the_answer_from_the_screenshot_parses() {
        let screen =
            screen_after_nudge(1, Some("not-blocked — complete; goal marked met, nothing left to resume."));
        assert_eq!(parse_reply(&screen), Some(Reply::NotBlocked));
    }

    /// This reads a RENDERED grid, so the terminal has already hard-wrapped at the pane width — and
    /// the wrap lands wherever the column falls, including the middle of the token.
    #[test]
    fn a_reply_wrapped_by_the_terminal_still_parses() {
        let screen = format!("{}\n● not-bl\nocked — done here.\n", nudge_text(2, 245));
        assert_eq!(parse_reply(&screen), Some(Reply::NotBlocked));
    }

    /// An agent that corrects itself means the correction.
    #[test]
    fn the_last_answer_wins() {
        let screen = format!("{}\n● not-blocked — wait, actually blocked-on-ci\n", nudge_text(1, 60));
        assert_eq!(parse_reply(&screen), Some(Reply::Ci));
    }

    /// FAIL CLOSED, AND THE CLOSED DIRECTION IS THE NOISY ONE. Every unreadable shape yields `None`,
    /// which leaves the ordinary ladder running — a false negative costs one more ping, a false
    /// positive goes quiet on an agent that never spoke.
    #[test]
    fn an_unreadable_screen_yields_no_answer() {
        // No nudge on screen at all: a bare token in ordinary output is not an answer to anything.
        assert_eq!(parse_reply("● I am not-blocked by the way\n"), None);
        // A nudge whose text is cut off by scrollback: the question/answer boundary is unknown.
        let truncated = "[sparkle-nudge #4 · no output for 10m] Automated ping, not a\n● not-blocked\n";
        assert_eq!(parse_reply(truncated), None);
        assert_eq!(parse_reply(""), None);
    }

    // ══ THE FOURTEEN-PING LOOP ══════════════════════════════════════════════════════════════════

    /// THE FOUNDER'S BUG, END TO END (screenshot 2026-08-07 16:28).
    ///
    /// An agent whose goal is MET answers `not-blocked`, and was pinged again anyway — fourteen
    /// consecutive times, every one labelled `#1`, every one reporting the same `4m 5s`, every one a
    /// FULL AGENT TURN with context loaded and a model called. The `#1` and the `4m 5s` are the
    /// tell: 5+10+20+30+60+120 = 245s is the climb from rung 1, so the ladder was resetting to the
    /// bottom every cycle — on the echo of its own nudge and the answer it had itself demanded.
    ///
    /// Both halves are asserted, because either alone would let it recur: no further WRITE, and the
    /// counter not silently restarting underneath.
    #[test]
    fn a_met_goal_and_a_not_blocked_reply_end_the_pinging() {
        let mut s = AgentState::default();
        let first = run(&mut s, &stalled(), 7);
        assert_eq!(first[6].action, Action::Nudge { n: 1 }, "precondition: it did get one ping");

        // The nudge lands. The agent answers and marks its goal met — and BOTH the echo of our own
        // text and the answer itself move the hash, which is what used to reset everything.
        let answered = Observation {
            hash: 0x0a11,
            goal_met: true,
            reply: parse_reply(&screen_after_nudge(
                1,
                Some("not-blocked — complete; goal marked met, nothing left to resume."),
            )),
            ..stalled()
        };
        assert_eq!(answered.reply, Some(Reply::NotBlocked), "fixture must carry a real answer");

        // Forty more looks — far past the fourteen the founder watched.
        let after = run(&mut s, &answered, 40);
        assert!(
            after.iter().all(|d| d.action == Action::Observe),
            "a finished agent must never be typed at again: {:?}",
            after.iter().find(|d| d.action != Action::Observe)
        );
        assert_eq!(s.delivered(), 0, "and nothing more went out");
        assert!(
            after.iter().all(|d| d.flagged.is_none()),
            "an agent that is DONE is not a row anybody owes"
        );
        assert_eq!(
            after.last().unwrap().refusal,
            Some("nothing-to-resume"),
            "and the log says why, so this is diagnosable without a screenshot"
        );
    }

    /// The two suppressors are INDEPENDENT — the founder asked for either to be sufficient, and a
    /// fix that only worked when both held would still have re-pinged half the fleet.
    #[test]
    fn either_a_met_goal_or_a_not_blocked_reply_is_enough_on_its_own() {
        // (a) Goal met, agent never answered anything.
        let mut goal_only = AgentState::default();
        let d = run(&mut goal_only, &Observation { goal_met: true, ..stalled() }, 30);
        assert!(d.iter().all(|d| d.action == Action::Observe), "a met goal alone must silence writes");
        assert!(d.iter().all(|d| d.flagged.is_none()));

        // (b) Answered `not-blocked`, goal NOT met — a met goal is not required to believe the agent.
        let mut reply_only = AgentState::default();
        run(&mut reply_only, &stalled(), 7);
        let answered =
            Observation { hash: 0x0b22, goal_met: false, reply: Some(Reply::NotBlocked), ..stalled() };
        let d = run(&mut reply_only, &answered, 30);
        assert!(
            d.iter().all(|d| d.action == Action::Observe),
            "`not-blocked` alone must silence writes"
        );
    }

    // ══ THE OTHER DIRECTION — NEVER HIDE AN AGENT THAT NEEDS SOMEBODY ═══════════════════════════

    /// SPARKLE'S STANDING RULE, PINNED. An agent that is stuck and NOT reporting `not-blocked` must
    /// still be nudged and must still reach a human. This is the assertion that stops the fix above
    /// from being "make the nudger quiet", and it is deliberately the same fixture as the loop test
    /// with only the answer and the goal removed.
    #[test]
    fn a_stalled_agent_that_says_nothing_is_still_nudged_and_still_escalates() {
        let mut s = AgentState::default();
        let d = run(&mut s, &stalled(), 20);

        let nudges: Vec<u32> = d
            .iter()
            .filter_map(|d| match d.action {
                Action::Nudge { n } => Some(n),
                _ => None,
            })
            .collect();
        assert!(!nudges.is_empty(), "silence with no answer must still be nudged");
        assert_eq!(nudges[0], 1);
        let raised: Vec<Escalation> = d.iter().filter_map(|d| d.escalate).collect();
        assert_eq!(
            raised,
            vec![Escalation::Concierge, Escalation::Founder],
            "and a human must still be told"
        );
    }

    /// `blocked-on-human` RAISES SOMETHING A HUMAN SEES RATHER THAN RE-PINGING. Re-typing cannot
    /// move a blocker only a person can clear, so the ping is wasted and the flag is the point —
    /// and it comes at the FIRST answer rather than after another five ignored turns.
    #[test]
    fn blocked_on_human_flags_the_founder_at_once_and_stops_typing() {
        let mut s = AgentState::default();
        run(&mut s, &stalled(), 7);
        let asking = Observation { hash: 0x0c33, reply: Some(Reply::Human), ..stalled() };

        let d = run(&mut s, &asking, 20);
        assert!(d.iter().all(|x| x.action == Action::Observe), "a human blocker is not typed at");
        assert_eq!(
            d[0].escalate,
            Some(Escalation::Founder),
            "the founder is flagged on the look that reads the answer, not five nudges later"
        );
        assert!(
            d.iter().all(|x| x.flagged == Some(Escalation::Founder)),
            "and the row STAYS up for as long as the ask does"
        );
        assert_eq!(d.last().unwrap().refusal, Some("blocked-on-human"));
    }

    /// A MET GOAL MUST NOT DELETE A ROW A HUMAN OWES. The two should not co-occur, but `goal_met` is
    /// a frontend-written fact that can be stale, and the failure is asymmetric: if it won here, a
    /// stale "met" would silently swallow an explicit request for a person.
    #[test]
    fn an_ask_for_a_human_outranks_a_met_goal() {
        let mut s = AgentState::default();
        run(&mut s, &stalled(), 7);
        let both =
            Observation { hash: 0x0d44, goal_met: true, reply: Some(Reply::Human), ..stalled() };
        let d = run(&mut s, &both, 10);
        assert!(
            d.iter().all(|x| x.flagged == Some(Escalation::Founder)),
            "an explicit ask for a person survives a met goal"
        );
    }

    /// `blocked-on-quota` BACKS OFF HARD. Answering a ping costs a turn against the exact budget
    /// that is exhausted, so the interval jumps well past the ladder's own top rung — and the
    /// concierge, which is the layer that can act on a quota wall, is told.
    #[test]
    fn blocked_on_quota_backs_off_hard_and_tells_the_concierge() {
        let mut s = AgentState::default();
        run(&mut s, &stalled(), 7);
        let broke = Observation { hash: 0x0e55, reply: Some(Reply::Quota), ..stalled() };

        let d = run(&mut s, &broke, 10);
        assert!(d.iter().all(|x| x.action == Action::Observe), "never ping an agent that is out of quota");
        assert_eq!(d[0].escalate, Some(Escalation::Concierge));
        let waits: Vec<u64> = d[1..].iter().map(|x| x.next_look_secs).collect();
        assert!(
            waits.iter().all(|w| *w == QUOTA_BACKOFF_SECS),
            "the backoff must exceed the ladder's own top rung, not merely reach it: {waits:?}"
        );
        assert!(QUOTA_BACKOFF_SECS > LADDER_SECS[LADDER_SECS.len() - 1]);
    }

    /// A TASK-LESS AGENT IS A CONCIERGE MATTER, NOT A FOUNDER PAGE (bead `sparkle-dfy3d`).
    ///
    /// A finished / task-less agent answering the pusher nudge could previously only reach for
    /// `blocked-on-human`, which routed to `AwaitHuman` → the FOUNDER and painted the red row: an
    /// alarm for a person to unblock a task that does not exist. `no-task-assigned` routes to the
    /// CONCIERGE instead — still flagged, so the agent is never hidden, but never the founder and
    /// never red. The paired positive proves the founder page was NARROWED, not removed: a genuinely
    /// blocked agent WITH a task still reaches the founder.
    #[test]
    fn a_task_less_agent_routes_to_the_concierge_never_the_founder() {
        let mut s = AgentState::default();
        run(&mut s, &stalled(), 7);
        let no_task = Observation { hash: 0x1a01, reply: Some(Reply::NoTask), ..stalled() };

        let d = run(&mut s, &no_task, 12);
        assert_eq!(
            d[0].escalate,
            Some(Escalation::Concierge),
            "a task-less agent is raised to the concierge on the look that reads the answer",
        );
        assert!(
            d.iter().all(|x| x.flagged == Some(Escalation::Concierge)),
            "the row must sit at concierge for as long as the stand-down holds: {:?}",
            d.iter().map(|x| x.flagged).collect::<Vec<_>>(),
        );
        // THE ANTI-RED ASSERTION: the founder is the red alarm, and a task-less agent must never
        // raise it. This is the exact defect `sparkle-dfy3d` names.
        assert!(
            d.iter().all(|x| x.flagged != Some(Escalation::Founder)),
            "a task-less agent must NEVER page the founder — nothing needs a human",
        );
        assert!(
            d.iter().all(|x| x.action == Action::Observe),
            "and it is not typed at — another ping cannot conjure a task to resume",
        );
        assert_eq!(d.last().unwrap().refusal, Some("no-task-assigned"));

        // PAIRED POSITIVE — a real human blocker WITH a task still reaches the founder.
        let mut blocked = AgentState::default();
        run(&mut blocked, &stalled(), 7);
        let asking = Observation { hash: 0x1a02, reply: Some(Reply::Human), ..stalled() };
        let b = run(&mut blocked, &asking, 12);
        assert_eq!(
            b[0].escalate,
            Some(Escalation::Founder),
            "the change must not touch a genuinely blocked agent: it still pages the founder",
        );
        assert!(b.iter().all(|x| x.flagged == Some(Escalation::Founder)));
    }

    /// AN OUT-OF-CONTEXT AGENT IS SUCCEEDED / HANDED OFF, NOT ESCALATED TO A HUMAN (bead
    /// `sparkle-umtx1`).
    ///
    /// Running out of context is not a human blocker: the remedy is to succeed the agent or hand its
    /// goal to a successor, which is the concierge's job — not a founder page. `out-of-context`
    /// routes to the concierge with a machine-readable `out-of-context` reason the layer above reads
    /// to auto-succeed or spawn a successor, and it never reaches the founder. (The successor
    /// hand-off itself lives above this module; here we pin the ROUTING away from the founder.)
    #[test]
    fn an_out_of_context_agent_is_handed_off_never_escalated_to_the_founder() {
        let mut s = AgentState::default();
        run(&mut s, &stalled(), 7);
        let ooc = Observation { hash: 0x1b01, reply: Some(Reply::OutOfContext), ..stalled() };

        let d = run(&mut s, &ooc, 12);
        assert_eq!(
            d[0].escalate,
            Some(Escalation::Concierge),
            "out-of-context routes to the concierge — the layer that can succeed it or spawn a successor",
        );
        assert!(
            d.iter().all(|x| x.flagged == Some(Escalation::Concierge)),
            "the hand-off row sits at concierge: {:?}",
            d.iter().map(|x| x.flagged).collect::<Vec<_>>(),
        );
        assert!(
            d.iter().all(|x| x.flagged != Some(Escalation::Founder)),
            "an out-of-context agent must NEVER be escalated to the founder",
        );
        assert!(
            d.iter().all(|x| x.action == Action::Observe),
            "and it is not pinged — a ping cannot manufacture more context",
        );
        // The machine-readable hand-off signal the successor layer keys on.
        assert_eq!(d.last().unwrap().refusal, Some("out-of-context"));

        // PAIRED POSITIVE — a real human blocker WITH a task still reaches the founder.
        let mut blocked = AgentState::default();
        run(&mut blocked, &stalled(), 7);
        let asking = Observation { hash: 0x1b02, reply: Some(Reply::Human), ..stalled() };
        let b = run(&mut blocked, &asking, 12);
        assert_eq!(
            b[0].escalate,
            Some(Escalation::Founder),
            "a genuinely blocked agent is untouched: it still pages the founder",
        );
        assert!(b.iter().all(|x| x.flagged == Some(Escalation::Founder)));
    }

    // ══ THE LADDER ACTUALLY ADVANCES ════════════════════════════════════════════════════════════

    /// `#2` MUST DIFFER FROM `#1`. The founder counted fourteen pings all labelled `#1`: a ladder
    /// that cannot count cannot escalate, cannot back off and cannot give up — it is a loop wearing
    /// a ladder's name. An answered nudge now advances the conversation instead of erasing it.
    #[test]
    fn the_counter_advances_across_an_answered_nudge() {
        let mut s = AgentState::default();
        let first = run(&mut s, &stalled(), 7);
        assert_eq!(first[6].action, Action::Nudge { n: 1 });

        // An answer that does NOT silence the ladder, so the next ping is observable.
        let waiting = Observation { hash: 0x0f66, reply: Some(Reply::Ci), ..stalled() };
        let d = run(&mut s, &waiting, 10);

        let next = d.iter().find_map(|x| match x.action {
            Action::Nudge { n } => Some(n),
            _ => None,
        });
        assert_eq!(next, Some(2), "the ping after an answered #1 is #2, not #1 again");
    }

    /// Output the ladder did NOT provoke is still a clean slate — a genuinely working agent must not
    /// inherit the nudge history of the episode before it. This is the boundary of the rule above,
    /// and without it "the counter survives" would quietly become "the counter never resets".
    #[test]
    fn unprovoked_output_still_resets_the_whole_episode() {
        let mut s = AgentState::default();
        run(&mut s, &stalled(), 12);
        assert!(s.attempts() >= 3, "precondition: a real nudge history");

        // Moving, with no answer to any nudge — the agent simply got back to work. The first change
        // is our last nudge's echo; the RUN after it is the agent itself. It takes a run rather
        // than a single sample because a live pane repaints on its own — see `LIVE_LOOKS_TO_RESET`.
        step(&mut s, &Observation { hash: 0x1077, reply: None, ..stalled() });
        for h in 0x1078..(0x1078 + LIVE_LOOKS_TO_RESET as u64) {
            step(&mut s, &Observation { hash: h, reply: None, ..stalled() });
        }
        assert_eq!(s.attempts(), 0, "unprovoked output earns a clean slate");
        assert_eq!(s.escalated(), None);
        assert_eq!(s.standdown(), None, "and it never stood down in the first place");
    }

    /// THE TERMINAL RUNG. Past `GIVE_UP_AFTER` identical ignored pings there is nothing another one
    /// can achieve that the founder flag has not — so the TYPING stops while the TELLING does not.
    #[test]
    fn the_ladder_gives_up_typing_but_never_gives_up_telling() {
        let mut s = AgentState::default();
        let d = run(&mut s, &stalled(), 40);

        let nudges: Vec<u32> = d
            .iter()
            .filter_map(|x| match x.action {
                Action::Nudge { n } => Some(n),
                _ => None,
            })
            .collect();
        assert_eq!(
            nudges,
            (1..=GIVE_UP_AFTER).collect::<Vec<u32>>(),
            "exactly {GIVE_UP_AFTER} pings, however long the agent stays wedged"
        );

        let tail = &d[d.len() - 10..];
        assert!(tail.iter().all(|x| x.refusal == Some("gave-up")));
        assert!(
            tail.iter().all(|x| x.flagged == Some(Escalation::Founder)),
            "the row a human owes is NEVER hidden — giving up on typing is not giving up on telling"
        );
    }

    // ══ "UNLESS NEW WORK ARRIVES" ═══════════════════════════════════════════════════════════════

    /// A stand-down says "there is nothing to resume". Handing the agent something to resume ends
    /// that, and a foreign write is exactly that event. Without this the fix would be permanent: an
    /// agent that once said `not-blocked` could never be nudged again for the life of its session.
    #[test]
    fn new_work_releases_a_stand_down() {
        let mut s = AgentState::default();
        run(&mut s, &stalled(), 7);
        let answered = Observation { hash: 0x1188, reply: Some(Reply::NotBlocked), ..stalled() };
        run(&mut s, &answered, 12);
        assert_eq!(s.standdown(), Some(Standdown::Done), "precondition: stood down");

        // The founder types a new task into the terminal. `foreign_write_ms` is an ABSOLUTE stamp,
        // so this is caught however long ago in the look cycle it happened.
        let new_work = Observation { hash: 0x1199, foreign_write_ms: 42, ..answered };
        step(&mut s, &new_work);
        assert_eq!(s.standdown(), None, "new work puts the agent back under the ordinary ladder");
        assert_eq!(s.attempts(), 0, "with a clean history");

        // ...and it really does nudge again if the new work then stalls.
        let stalled_again = Observation { hash: 0x1199, foreign_write_ms: 42, ..stalled() };
        let d = run(&mut s, &stalled_again, 8);
        assert_eq!(
            d.iter().find_map(|x| match x.action {
                Action::Nudge { n } => Some(n),
                _ => None,
            }),
            Some(1),
            "a stand-down must not outlive the work that justified it"
        );
    }

    // ══ THE ECHO, WHICH IS THE PART THE FIRST FIX MISSED ════════════════════════════════════════

    /// THE REALISTIC SEQUENCE, and the one every other loop test here fails to model.
    ///
    /// Those tests hold `hash` CONSTANT across looks, which cannot happen to an agent we are typing
    /// at: the nudge is written into the PTY and ECHOES, so the hash moves after every single ping
    /// whether or not the agent ever answers. Keying the conversation reset on a parsed reply
    /// therefore left the founder's `#1`-forever loop fully intact for every agent that does not
    /// answer in the exact vocabulary — prose, a scrolled-off answer, or nothing but a redrawn
    /// spinner. `attempts` never got past 1, so the concierge flag, the founder flag and the
    /// terminal rung were all unreachable (roborev 60323).
    ///
    /// Here the hash changes on the look after each nudge and the agent NEVER answers.
    #[test]
    fn our_own_echo_does_not_reset_the_counter_when_the_agent_never_answers() {
        let mut s = AgentState::default();
        let mut hash = 0xdead_beef_u64;
        let mut pings: Vec<u32> = Vec::new();
        let mut flagged_at_end = None;

        for _ in 0..60 {
            let obs = Observation { hash, reply: None, ..stalled() };
            let d = step(&mut s, &obs);
            flagged_at_end = d.flagged;
            if let Action::Nudge { n } = d.action {
                pings.push(n);
                // The ping lands and echoes into the terminal — the hash moves, with no reply.
                hash = hash.wrapping_add(1);
            }
        }

        assert_eq!(
            pings,
            (1..=GIVE_UP_AFTER).collect::<Vec<u32>>(),
            "the counter must climb through the echo, not restart at #1 on every one"
        );
        assert_eq!(
            s.escalated(),
            Some(Escalation::Founder),
            "and the escalation thresholds must actually be reachable"
        );
        assert_eq!(flagged_at_end, Some(Escalation::Founder), "the row stays up afterwards");
    }

    /// THE TWO ATTRIBUTION RULES, at their exact boundary. Our own echo is ours (rule one), and a
    /// LONE unprovoked change is still not the agent working (rule two) — only a run is. Rule two
    /// is what the first repair was missing: it covered one look, while the climb back to a nudge
    /// rung is seven, so six looks were left in which a single repaint wiped the episode.
    ///
    /// The upper bound matters as much as the lower one: without the run eventually clearing, "our
    /// write makes the next change ours" would creep into "the counter never resets once we have
    /// nudged", and a recovered agent would inherit a dead episode's history forever.
    #[test]
    fn the_echo_is_ours_and_a_lone_repaint_is_not_the_agent() {
        let mut s = AgentState::default();
        run(&mut s, &stalled(), 7); // …ending in nudge #1
        assert_eq!(s.attempts(), 1);

        // Look 1 after the nudge: the echo. Provoked — history survives.
        step(&mut s, &Observation { hash: 0x2001, reply: None, ..stalled() });
        assert_eq!(s.attempts(), 1, "the echo is ours");

        // Look 2: one repaint, with no write of ours in between. Still not a working agent.
        step(&mut s, &Observation { hash: 0x2002, reply: None, ..stalled() });
        assert_eq!(s.attempts(), 1, "a single repaint is not the agent getting back to work");

        // …but a sustained run of it is, and the slate clears.
        for h in 0x2003..(0x2003 + LIVE_LOOKS_TO_RESET as u64) {
            step(&mut s, &Observation { hash: h, reply: None, ..stalled() });
        }
        assert_eq!(s.attempts(), 0, "sustained unprovoked output is a clean slate");
    }

    /// THE FOUNDER'S SYMPTOM, REPLAYED (the counter stuck at `#1` forever).
    ///
    /// A live Claude Code pane is never perfectly still: a footer redraw, a context-remaining
    /// counter, a roster status flip (which is hashed alongside the PTY tail) all move the hash
    /// without the agent doing anything. The re-climb from a nudge back to the next nudge rung is
    /// SEVEN looks — so a provoked window one look wide leaves six looks in which one stray repaint
    /// wipes the whole episode. Every nudge is then a first nudge, forever, and no threshold is ever
    /// reachable: the fleet is pinged indefinitely and no human is ever told.
    #[test]
    fn one_stray_repaint_per_climb_must_not_restart_the_counter_at_one() {
        let mut s = AgentState::default();
        let mut hash = 0xdead_beef_u64;
        let mut pings: Vec<u32> = Vec::new();
        let mut looks_since_ping = 0u32;

        for _ in 0..120 {
            let d = step(&mut s, &Observation { hash, reply: None, ..stalled() });
            if let Action::Nudge { n } = d.action {
                pings.push(n);
                // Our own ping echoes into the PTY.
                hash = hash.wrapping_add(1);
                looks_since_ping = 0;
            } else {
                looks_since_ping += 1;
                // ONE idle repaint partway through the re-climb. Not the agent working — it emits
                // nothing on the look before or the look after.
                if looks_since_ping == 3 {
                    hash = hash.wrapping_add(1);
                }
            }
        }

        assert_eq!(
            pings,
            (1..=GIVE_UP_AFTER).collect::<Vec<u32>>(),
            "an idle repaint is not the agent getting back to work"
        );
        assert_eq!(
            s.escalated(),
            Some(Escalation::Founder),
            "and a human must still be reachable through the repaints"
        );
    }

    /// And the streak must be CONSECUTIVE: a quiet look in the middle is not a working agent.
    #[test]
    fn an_interrupted_streak_does_not_wipe_the_episode() {
        let mut s = AgentState::default();
        run(&mut s, &stalled(), 12);
        let before = s.attempts();
        assert!(before >= 3, "precondition: a real nudge history");

        // Change, change, QUIET, change, change — never `LIVE_LOOKS_TO_RESET` in a row.
        let mut h = 0x3000;
        for i in 0..8 {
            if i % 3 == 2 {
                step(&mut s, &Observation { hash: h, reply: None, ..stalled() });
            } else {
                h += 1;
                step(&mut s, &Observation { hash: h, reply: None, ..stalled() });
            }
        }
        assert!(s.attempts() > 0, "an intermittent flicker is not a working agent");
    }

    // ══ A SCREEN ONLY A HUMAN CAN CLEAR ═════════════════════════════════════════════════════════

    /// TONIGHT'S OUTAGE, in one test. Agents sat on ordinary "Do you want to proceed?" prompts for
    /// HOURS. The gate refuses to type at such a screen (correctly — a paste-then-CR presses a
    /// button nobody read), so every remaining rung was guaranteed to write nothing; waiting out
    /// four of them before telling a human is four rungs of nobody knowing.
    #[test]
    fn a_prompt_only_a_human_can_clear_replaces_its_first_nudge_with_a_flag() {
        let mut s = AgentState::default();
        let parked = Observation { refusal: Some("awaiting-input"), ..stalled() };
        let decisions = run(&mut s, &parked, 12);

        let first = decisions
            .iter()
            .position(|d| d.escalate.is_some())
            .expect("a parked agent must reach a human");
        // The first rung the ladder would otherwise have NUDGED at — the flag REPLACES that
        // nudge instead of waiting several more out. Deliberately NOT the first writing rung:
        // `awaiting-input` is a coarse token that also covers an agent's own transient question,
        // and flagging that after ~35s is a false page (roborev 63230, Medium).
        assert_eq!(decisions[first].rung, (FIRST_NUDGE_RUNG + 1) as u32);
        assert_eq!(decisions[first].escalate, Some(Escalation::Concierge));
        assert_eq!(decisions[first].refusal, Some("awaiting-input"));

        // It never types at the prompt, on any rung.
        assert!(
            decisions.iter().all(|d| d.action == Action::Observe),
            "nothing may be typed at a live prompt"
        );
        // And the row stays up for the rest of the episode rather than being a one-shot event.
        assert!(
            decisions[first..].iter().all(|d| d.flagged.is_some()),
            "the row must persist once raised"
        );
        // THE COUNTERS STAY HONEST (roborev 63230, Medium). `attempts` means "nudges we tried to
        // send" — it is both the `GIVE_UP_AFTER` budget and the `nudges:` figure a human reads off
        // the flag. Charging silent observations to it burned the whole give-up budget in 8 looks,
        // so a screen that later became writable could never be nudged again, and the row read
        // `nudges: 8, delivered: 0` for an agent that was never nudged once.
        assert_eq!(s.attempts(), 0, "no nudge was attempted, so none may be reported");
        assert_eq!(s.delivered(), 0);

        // No LEVEL is ever re-raised, however long it sits there — one event per level, strictly
        // ascending. (Not "one event total": a permanently parked agent must still climb from the
        // concierge to the founder, which `a_permanently_parked_agent_still_reaches_the_founder`
        // pins. Asserting a flat 1 here is what a capped ceiling would have looked like.)
        let raised: Vec<Escalation> = decisions.iter().filter_map(|d| d.escalate).collect();
        assert!(
            raised.windows(2).all(|w| w[1] > w[0]),
            "each escalation must be a genuine RISE: {raised:?}"
        );
    }

    /// INSTANT ESCALATION RAISES THE FLOOR, NOT A CEILING.
    ///
    /// The first cut forced a flat `Concierge` on every parked look, which `raise` then refused to
    /// advance — so an agent sitting on a permission prompt all night would have stopped at the
    /// concierge and NEVER reached the founder. That is the exact inversion of what this path is
    /// for: it exists to tell a human sooner, not to cap how loudly they are told.
    #[test]
    fn a_permanently_parked_agent_still_reaches_the_founder() {
        let mut s = AgentState::default();
        let parked = Observation { refusal: Some("awaiting-input"), ..stalled() };
        let raised: Vec<Escalation> =
            run(&mut s, &parked, 20).iter().filter_map(|d| d.escalate).collect();
        assert_eq!(
            raised,
            vec![Escalation::Concierge, Escalation::Founder],
            "the concierge at once, and the founder once it has been ignored long enough"
        );
    }

    /// A credential prompt is the same class — and the more dangerous one, since it echoes nothing.
    /// It flags at the SAME rung as `awaiting-input`: its recogniser is whole-screen too, so a
    /// stray `password:` line in scrollback produces this token on a perfectly healthy agent
    /// (roborev 63273). See `parked_flag_rung` for why that rules out a faster rung.
    ///
    /// THE RUNG IS PINNED EXACTLY (roborev 63247, Medium). Asserting merely "escalates somewhere in
    /// 12 looks" was VACUOUS: the ordinary path reaches the concierge at rung 8 anyway and, being
    /// blocked, never types either — so both assertions held with `credential-prompt` removed from
    /// the set entirely, and the rule this test exists to guard was pinned by nothing.
    #[test]
    fn a_credential_prompt_is_flagged_when_it_survives_to_the_nudge_rung() {
        let mut s = AgentState::default();
        let parked = Observation { refusal: Some("credential-prompt"), ..stalled() };
        let decisions = run(&mut s, &parked, 12);

        let first = decisions.iter().position(|d| d.escalate.is_some()).expect("must reach a human");
        assert_eq!(
            decisions[first].rung,
            (FIRST_NUDGE_RUNG + 1) as u32,
            "the flag REPLACES the first nudge — earlier would false-page on a scrollback match"
        );
        assert_eq!(decisions[first].escalate, Some(Escalation::Concierge));
        assert!(decisions.iter().all(|d| d.action == Action::Observe));
    }

    /// THE CONTROL, and it is what stops the rule above from being "escalate on everything".
    ///
    /// Without this the test above passes against a ladder that flags every agent on rung 4 — which
    /// would page a human about every ordinary stall and, per this module's own header, is how a
    /// signal stops being read. An ordinary silent agent must still climb and still be NUDGED first.
    #[test]
    fn an_ordinary_stall_still_climbs_and_is_nudged_before_anyone_is_told() {
        let mut s = AgentState::default();
        let decisions = run(&mut s, &stalled(), 12);

        let first_escalation = decisions.iter().position(|d| d.escalate.is_some()).unwrap();
        let first_nudge = decisions.iter().position(|d| matches!(d.action, Action::Nudge { .. }));
        assert!(
            first_nudge.unwrap() < first_escalation,
            "an ordinary stall is nudged before it is escalated"
        );
        assert!(
            decisions[first_escalation].rung > (FIRST_WRITING_RUNG + 1) as u32,
            "and it is NOT escalated on the first writing rung"
        );
    }

    /// A refusal that CAN clear without a human keeps the ordinary ladder. A full-screen app gets
    /// exited and an unreadable grid recovers, so neither earns a flag on its first look —
    /// otherwise every agent that ran `less` for a minute would raise a row.
    ///
    /// THE RUNG IS PINNED EXACTLY (roborev 63247, Medium). `> FIRST_WRITING_RUNG + 1` was vacuous
    /// once the instant path moved to rung 7: BOTH boundaries satisfied it, so adding
    /// `alternate-screen` to the human-only set left this test green. The ordinary path's second
    /// counted attempt — `FIRST_NUDGE_RUNG + 2` — is the number that actually distinguishes them.
    #[test]
    fn a_self_clearing_refusal_keeps_the_ordinary_ladder() {
        for reason in ["alternate-screen", "no-viewport"] {
            let mut s = AgentState::default();
            let d = run(&mut s, &Observation { refusal: Some(reason), ..stalled() }, 12);
            let first = d.iter().position(|x| x.escalate.is_some()).unwrap();
            assert_eq!(
                d[first].rung,
                (FIRST_NUDGE_RUNG + 2) as u32,
                "{reason} can clear without a human, so it must climb the ORDINARY ladder"
            );
            assert_eq!(s.parked_looks_for_test(), 0, "{reason} is not a parked-screen episode");
        }
    }

    /// CLEARING IT OURSELVES BEATS TELLING SOMEBODY ABOUT IT. On the reported night dozens of
    /// ordinary permission prompts were hand-cleared one at a time; an allowlisted read-only
    /// command is exactly what the ladder should be able to answer without waking anyone.
    #[test]
    fn an_answerable_prompt_is_answered_rather_than_escalated() {
        let mut s = AgentState::default();
        let answerable =
            Observation { refusal: Some("awaiting-input"), answerable: true, ..stalled() };
        let decisions = run(&mut s, &answerable, 12);

        let first_answer = decisions
            .iter()
            .position(|d| d.action == Action::Answer)
            .expect("an allowlisted prompt must be answered");
        // The earliest look at which the ladder is allowed to write at all — a human has had the
        // whole observe-only band to answer it first.
        assert_eq!(decisions[first_answer].rung, (FIRST_WRITING_RUNG + 1) as u32);
        // …and nobody is woken for a prompt we just cleared.
        assert!(
            decisions[..=first_answer].iter().all(|d| d.escalate.is_none()),
            "answering must not also raise a flag"
        );
        // It NEVER types free text at the prompt — the answer is the only thing that goes out.
        assert!(
            decisions.iter().all(|d| !matches!(d.action, Action::Nudge { .. } | Action::Enter)),
            "only the affirmative option may be sent at a live prompt"
        );
    }

    /// THE CONTROL. The same screen, the same rung, `answerable: false` — the ladder must fall
    /// through to telling a human instead. Without this the test above passes against a ladder that
    /// answers EVERY prompt, which is the failure the allowlist exists to prevent.
    #[test]
    fn a_prompt_the_gate_will_not_answer_is_escalated_instead() {
        let mut s = AgentState::default();
        let refused =
            Observation { refusal: Some("awaiting-input"), answerable: false, ..stalled() };
        let decisions = run(&mut s, &refused, 12);

        assert!(
            decisions.iter().all(|d| d.action != Action::Answer),
            "a command the gate did not allow must never be answered"
        );
        assert!(
            decisions.iter().any(|d| d.escalate == Some(Escalation::Concierge)),
            "and a human must be told instead"
        );
    }

    // ══ A ROW THAT IS NOT GREEN AND NOT YET MERGED ══════════════════════════════════════════════

    /// An agent whose row is gray with unlanded work, WHOSE PANE KEEPS REPAINTING.
    ///
    /// This is the case the silence clock structurally cannot see: every repaint resets the rung,
    /// so the ordinary ladder never climbs, never nudges, and never escalates — the agent is
    /// invisible for as long as it likes. It is also the founder's stated condition: "if a row is
    /// not green and it's not at least merged to main, we have a problem."
    #[test]
    fn a_busy_looking_row_with_unlanded_work_is_still_escalated() {
        let mut s = AgentState::default();
        let mut hash = 0u64;
        let mut raised = None;
        let mut looks = 0;

        // The pane repaints on EVERY look, so the silence clock is pinned at zero throughout.
        while raised.is_none() && looks < 4000 {
            hash += 1;
            let d = step(
                &mut s,
                &Observation {
                    hash,
                    rollup_dot: Some("gray"),
                    stage: Some("building_saved"),
                    ..stalled()
                },
            );
            raised = d.escalate;
            looks += 1;
        }

        assert_eq!(raised, Some(Escalation::Concierge), "a stuck-but-busy row must reach a human");
        assert_eq!(s.silent_secs(), 0, "premise: the silence clock never ran — it repainted every look");
        assert!(s.unlanded_secs() >= UNLANDED_STALL_SECS);
    }

    /// THE CONTROL, and it is what stops the rule above from being "escalate on everything".
    ///
    /// The same repainting row, the same duration — but the work has LANDED. Nothing is owed, so
    /// nobody is told. Without this the test above passes against a clock that ignores the stage.
    #[test]
    fn a_merged_row_is_never_escalated_however_long_it_sits() {
        let mut s = AgentState::default();
        let mut hash = 0u64;
        for _ in 0..4000 {
            hash += 1;
            let d = step(
                &mut s,
                &Observation {
                    hash,
                    rollup_dot: Some("gray"),
                    stage: Some("merged"),
                    ..stalled()
                },
            );
            assert_eq!(d.escalate, None, "merged work owes nobody anything");
        }
        assert_eq!(s.unlanded_secs(), 0);
    }

    /// …and a GREEN row is left alone too, whatever its stage. Green means work is running under it.
    #[test]
    fn a_green_row_is_never_escalated_on_this_path() {
        let mut s = AgentState::default();
        let mut hash = 0u64;
        for _ in 0..4000 {
            hash += 1;
            let d = step(
                &mut s,
                &Observation {
                    hash,
                    rollup_dot: Some("green"),
                    stage: Some("building_saved"),
                    ..stalled()
                },
            );
            assert_eq!(d.escalate, None, "a green row is not a problem");
        }
    }

    /// PROGRESS CLEARS IT, and only progress does. An agent that keeps ADVANCING through the stages
    /// is working, however long the whole journey takes.
    #[test]
    fn a_stage_that_keeps_advancing_never_trips_the_clock() {
        let mut s = AgentState::default();
        let mut hash = 0u64;
        // Walk the unlanded band, spending a long stretch on each rung — but always moving.
        for stage in ["building_saved", "pushed", "pull_request", "merged_local"] {
            for _ in 0..40 {
                hash += 1;
                let d = step(
                    &mut s,
                    &Observation { hash, rollup_dot: Some("gray"), stage: Some(stage), ..stalled() },
                );
                assert_eq!(d.escalate, None, "an advancing agent is not stuck (at {stage})");
            }
        }
    }

    /// ABSENCE IS NOT EVIDENCE. A window that cannot report the disc or the stage must not have its
    /// silence read as "gray" or as "nothing committed" — that would flag every agent a wedged or
    /// out-of-date window cannot describe, which is most of them in exactly the outage this module
    /// exists for.
    #[test]
    fn an_unreported_row_is_never_escalated_on_this_path() {
        for (dot, stage) in [(None, None), (None, Some("building_saved")), (Some("gray"), None)] {
            let mut s = AgentState::default();
            let mut hash = 0u64;
            for _ in 0..4000 {
                hash += 1;
                let d = step(
                    &mut s,
                    &Observation { hash, rollup_dot: dot, stage, ..stalled() },
                );
                assert_eq!(d.escalate, None, "absent evidence must not flag: {dot:?}/{stage:?}");
            }
        }
    }

    /// …BUT ABSENCE MUST NOT CLEAR ONE EITHER, which is the other half of that contract and the
    /// half that was missing. The reset branch could not tell "positive evidence of health" from
    /// "the roster did not describe this agent", so one undescribed look discarded the whole
    /// accrued clock — in exactly the outage this watcher exists for, where a reloading WebView
    /// drops agents out of the published roster for a look or two at a time. The test above only
    /// ever covered PERMANENTLY absent facts, so a gap mid-accrual went unseen.
    #[test]
    fn a_look_the_roster_cannot_describe_holds_the_clock_rather_than_clearing_it() {
        let mut s = AgentState::default();
        let mut hash = 0u64;
        for _ in 0..3 {
            hash += 1;
            step(
                &mut s,
                &Observation {
                    hash,
                    rollup_dot: Some("gray"),
                    stage: Some("building_saved"),
                    ..stalled()
                },
            );
        }
        let held = s.unlanded_secs();
        assert!(held > 0 && held < UNLANDED_STALL_SECS, "premise: partway up, not yet crossed");

        // The window reloads and stops describing this agent at all.
        for _ in 0..5 {
            hash += 1;
            let d = step(
                &mut s,
                &Observation { hash, rollup_dot: None, stage: None, ..stalled() },
            );
            assert_eq!(d.escalate, None, "an undescribed look still raises nothing");
        }
        assert_eq!(s.unlanded_secs(), held, "a look that says nothing must not clear the clock");
    }

    /// BLUE IS NOT GREEN. `RollupDot` carries a fifth disc for the `questions` band, and it was
    /// missing from the interned vocabulary — so an agent ASKING A QUESTION while holding unlanded
    /// work interned to `None` and was read as no evidence, on a path whose entire subject is rows
    /// that are not green. Worse than inert: a transient blue look also took the reset branch and
    /// zeroed an already-accrued clock, so a row flickering gray↔blue never accumulated at all.
    #[test]
    fn a_blue_row_holding_unlanded_work_is_still_escalated() {
        assert_eq!(intern_dot("blue"), Some("blue"), "premise: blue is in the vocabulary");

        let mut s = AgentState::default();
        let mut hash = 0u64;
        let mut raised = None;
        let mut looks = 0;
        while raised.is_none() && looks < 4000 {
            hash += 1;
            let d = step(
                &mut s,
                &Observation {
                    hash,
                    rollup_dot: Some("blue"),
                    stage: Some("building_saved"),
                    ..stalled()
                },
            );
            raised = d.escalate;
            looks += 1;
        }
        assert_eq!(
            raised,
            Some(Escalation::Concierge),
            "a row parked on a question with unlanded work is the founder's condition too"
        );
    }

    /// THE SECOND UNIT OF WORK. `deriveLiveStage` deliberately REGRESSES a branch from `merged`
    /// back to `building_saved` when the agent keeps committing after its PR lands — the ordinary
    /// "merge, keep working" cycle. A high-water rank retained across that boundary can never be
    /// beaten again by the second cycle's own `building_saved`→`merged_local`, so real progress
    /// stopped clearing the clock and a normally-moving agent was escalated 30 minutes into every
    /// unit of work after its first. `a_stage_that_keeps_advancing_never_trips_the_clock` starts
    /// from a default state and so cannot see this.
    #[test]
    fn a_second_unit_of_work_on_the_same_branch_still_clears_its_own_clock() {
        let mut s = AgentState::default();
        let mut hash = 0u64;

        // CYCLE ONE: walk the whole band and land it.
        for stage in ["building_saved", "pushed", "pull_request", "merged_local", "merged"] {
            for _ in 0..40 {
                hash += 1;
                step(
                    &mut s,
                    &Observation {
                        hash,
                        rollup_dot: Some("gray"),
                        stage: Some(stage),
                        ..stalled()
                    },
                );
            }
        }
        assert_eq!(s.unlanded_secs(), 0, "premise: landing the work cleared the clock");

        // The agent commits again, so the row drops back into the unlanded band. Measure a third
        // of the budget against THIS machine rather than hard-coding a look count, so the test
        // cannot rot when the ladder's intervals change.
        let mut per_stage = 0usize;
        while s.unlanded_secs().saturating_mul(3) < UNLANDED_STALL_SECS {
            hash += 1;
            let d = step(
                &mut s,
                &Observation {
                    hash,
                    rollup_dot: Some("gray"),
                    stage: Some("building_saved"),
                    ..stalled()
                },
            );
            assert_eq!(d.escalate, None, "a fresh unit of work is not a stall");
            per_stage += 1;
            assert!(per_stage < 10_000, "the clock must run at all on a regressed stage");
        }

        // Three more stages, each the same stretch. Every one is an ADVANCE, so every one must
        // restart the clock — which it cannot do while cycle one's high-water is still standing.
        for stage in ["pushed", "pull_request", "merged_local"] {
            for _ in 0..per_stage {
                hash += 1;
                let d = step(
                    &mut s,
                    &Observation {
                        hash,
                        rollup_dot: Some("gray"),
                        stage: Some(stage),
                        ..stalled()
                    },
                );
                assert_eq!(d.escalate, None, "advancing again is progress (at {stage})");
            }
        }
        assert!(
            s.unlanded_secs() < UNLANDED_STALL_SECS,
            "only the last stage's own stretch should be on the clock"
        );
    }

    /// THE CLOCK MEASURES WALL TIME, so it must credit the interval that was actually SCHEDULED.
    /// Re-deriving it from the rung was wrong for the two paths that override `next_look_secs`:
    /// `blocked-on-quota` backs off to half an hour and `blocked-on-ci` to a full last rung, both
    /// while leaving the rung where it stood. An agent that answered `blocked-on-quota` while
    /// holding unlanded work — a prime target for this rule, not an edge case — therefore accrued
    /// up to 100× slower than real time, and `UNLANDED_STALL_SECS` was not the bound it claims.
    #[test]
    fn a_quota_stand_down_credits_the_interval_it_actually_scheduled() {
        let mut s = AgentState::default();
        let broke = Observation {
            hash: 0x0e55,
            rollup_dot: Some("gray"),
            stage: Some("building_saved"),
            reply: Some(Reply::Quota),
            ..stalled()
        };
        // Settle onto the stand-down: the reply latches, and the schedule backs all the way off.
        let mut settled = 0;
        loop {
            let d = step(&mut s, &broke);
            settled += 1;
            if d.next_look_secs == QUOTA_BACKOFF_SECS {
                break;
            }
            assert!(settled < 20, "premise: quota must back all the way off, whatever the rung says");
        }

        // So the look AFTER it represents half an hour of wall clock, not this rung's few seconds.
        let before = s.unlanded_secs();
        step(&mut s, &broke);
        let credited = s.unlanded_secs() - before;
        assert!(
            credited >= QUOTA_BACKOFF_SECS,
            "a look scheduled 30 minutes out must credit 30 minutes, not the rung (credited {credited})"
        );
    }

    /// MEASURED TIME BEATS THE SCHEDULE, for BOTH clocks.
    ///
    /// The schedule is only ever an estimate of what will elapse, and two things break it: a
    /// stand-down overrides `next_look_secs` without moving the rung, and `nudger` rebaselines every
    /// deadline across a machine suspend precisely because the frozen span must not be read as
    /// elapsed. So when the caller has actually measured the interval, that measurement governs —
    /// and `silent_secs` needs it as much as `unlanded_secs` does, because it is the figure a HUMAN
    /// reads off the row and out of the nudge text.
    #[test]
    fn a_measured_interval_governs_both_clocks() {
        let mut s = AgentState::default();
        let obs = Observation {
            elapsed_secs: Some(900),
            rollup_dot: Some("gray"),
            stage: Some("building_saved"),
            ..stalled()
        };
        step(&mut s, &obs); // the baseline look
        step(&mut s, &obs);
        let (silent, unlanded) = (s.silent_secs(), s.unlanded_secs());

        step(&mut s, &obs);
        assert_eq!(
            s.silent_secs() - silent,
            900,
            "the silence clock must credit the measured quarter hour, not the rung"
        );
        assert_eq!(
            s.unlanded_secs() - unlanded,
            900,
            "and so must the unlanded clock — it is the same wall clock"
        );
    }

    /// The unlanded band, pinned against `workflowStage.ts::hasUnmergedCommittedWork`: committed
    /// but not on ORIGIN main. `merged_local` counts as unlanded — the workflow lands via a PR to
    /// origin, so local-only work still needs a human to finish it.
    #[test]
    fn the_unlanded_band_matches_the_frontend() {
        for stage in ["building_saved", "pushed", "pull_request", "merged_local"] {
            assert!(holds_unlanded_work(stage), "{stage} is committed but not on origin main");
        }
        for stage in ["thought", "specd", "planned", "building_unsaved", "merged", "shipped"] {
            assert!(!holds_unlanded_work(stage), "{stage} owes nothing");
        }
        // An unknown stage is NO EVIDENCE, never stage zero.
        assert!(!holds_unlanded_work("who-knows"));
        assert_eq!(stage_rank("who-knows"), None);
        assert_eq!(intern_stage("who-knows"), None);
        assert_eq!(intern_dot(""), None, "a window that cannot compute the rollup says nothing");
    }

    /// The vocabulary itself, in order, against the TypeScript source it mirrors. A stage inserted
    /// on one side and not the other silently moves the unlanded band.
    ///
    /// SET-AND-ORDER EQUALITY, not containment. The one-directional form this replaces could only
    /// see a stage deleted from the frontend; a stage ADDED there was invisible to it — and that is
    /// the drift that actually costs something, because a new stage inside the committed-but-
    /// unlanded band is published by the roster, interns to `None` here, and is read as no evidence.
    /// The feature would then stop flagging exactly the agents that stage describes, with the guard
    /// still green — the vacuity this repo's #1 finding is about.
    #[test]
    fn stage_vocabulary_matches_the_frontend() {
        let ts = std::fs::read_to_string("../src/engine/workflowStage.ts")
            .expect("engine/workflowStage.ts must be readable from the crate root");
        // Scoped to the array, so an `id:` field elsewhere in the file cannot join the vocabulary.
        let body = ts
            .split_once("export const WORKFLOW_STAGES")
            .expect("workflowStage.ts must declare WORKFLOW_STAGES")
            .1
            .split_once("] as const;")
            .expect("the WORKFLOW_STAGES array must be terminated by `] as const;`")
            .0;
        let from_ts: Vec<&str> = body
            .match_indices("id: \"")
            .map(|(i, m)| {
                let rest = &body[i + m.len()..];
                &rest[..rest.find('"').expect("an unterminated stage id")]
            })
            .collect();
        assert_eq!(
            WORKFLOW_STAGES.to_vec(),
            from_ts,
            "the stage vocabulary must match workflowStage.ts exactly and in the same order — the \
             unlanded band is arithmetic over that order"
        );
    }

    /// …and the same guard for the row DISCS, which had none at all. That is why `blue` was missing
    /// from `ROLLUP_DOTS` for the whole life of this feature: nothing tied the Rust list to the
    /// TypeScript union, and a dot missing here interns to `None`, which every rule reads as no
    /// evidence. Order does not matter for the discs (no arithmetic rests on it), membership does.
    #[test]
    fn dot_vocabulary_matches_the_frontend() {
        let ts = std::fs::read_to_string("../src/engine/workerRollup.ts")
            .expect("engine/workerRollup.ts must be readable from the crate root");
        let union = ts
            .split_once("export type RollupDot =")
            .expect("workerRollup.ts must declare RollupDot")
            .1
            .split_once(';')
            .expect("the RollupDot union must be terminated")
            .0;
        let mut from_ts: Vec<&str> =
            union.split('|').map(|s| s.trim().trim_matches('"')).filter(|s| !s.is_empty()).collect();
        from_ts.sort_unstable();
        let mut ours: Vec<&str> = ROLLUP_DOTS.to_vec();
        ours.sort_unstable();
        assert_eq!(
            ours, from_ts,
            "ROLLUP_DOTS must be exactly workerRollup.ts::RollupDot — a disc missing here is a row \
             this watcher can never see"
        );
    }

    // ══ A MET GOAL IS NOT A LIFETIME EXEMPTION ══════════════════════════════════════════════════

    /// THE SILENT-FOREVER HOLE (roborev 60323, High).
    ///
    /// `goal_met` is re-derived every look rather than latched, so the stand-down release could not
    /// reach it — and `goalStateOf` answers "met" FOREVER once `metAt` is set, until a whole new
    /// goal object is constructed. A founder typing a new task into a finished agent's terminal
    /// does not do that. So the agent was exempt from the ladder for the rest of its life: never
    /// written to, and `Done` raises no flag either, so silent in BOTH directions — precisely what
    /// this module's header forbids, via the most ordinary flow there is.
    #[test]
    fn a_met_goal_stops_excusing_an_agent_once_somebody_types_at_it() {
        let mut s = AgentState::default();
        let finished = Observation { goal_met: true, foreign_write_ms: 100, ..stalled() };
        let quiet = run(&mut s, &finished, 20);
        assert!(quiet.iter().all(|d| d.action == Action::Observe), "precondition: stood down");

        // The founder types a new task. The goal object is untouched, so `goal_met` STAYS true —
        // which is exactly why the stamp, and not the flag itself, has to be the test.
        let new_work = Observation { hash: 0x3001, goal_met: true, foreign_write_ms: 200, ..stalled() };
        step(&mut s, &new_work);

        let after = run(&mut s, &Observation { hash: 0x3001, ..new_work }, 12);
        assert!(
            after.iter().any(|d| matches!(d.action, Action::Nudge { .. })),
            "an agent handed new work must be watched again, however its stale goal still reads"
        );
    }

    /// …and the exemption is not handed back by the next look. Once superseded it stays superseded,
    /// because the goal state has no way to notice the new work either.
    #[test]
    fn a_superseded_goal_does_not_un_supersede_itself() {
        let mut s = AgentState::default();
        run(&mut s, &Observation { goal_met: true, foreign_write_ms: 100, ..stalled() }, 10);
        step(&mut s, &Observation { hash: 0x4001, goal_met: true, foreign_write_ms: 200, ..stalled() });

        // Many later looks, no further writes — the write stamp stops moving.
        let d = run(&mut s, &Observation { hash: 0x4001, goal_met: true, foreign_write_ms: 200, ..stalled() }, 20);
        assert!(
            d.iter().any(|x| matches!(x.action, Action::Nudge { .. })),
            "a stale met claim must not quietly re-exempt the agent once the work has moved on"
        );
    }

    // ══ THE ANSWER REGION IS BOUNDED ════════════════════════════════════════════════════════════

    /// A TOKEN IS NOT AN ANSWER JUST BECAUSE IT IS ON SCREEN (roborev 60323, Medium).
    ///
    /// The region used to run to the end of the screen, so any later appearance of a token was
    /// absorbed as the agent's reply — including, deliciously, a `git diff` of THIS FILE, which
    /// contains the marker, the tail and all five tokens. That latches a stand-down and stops the
    /// typing on an agent that never answered.
    #[test]
    fn a_token_far_below_a_real_answer_is_not_read_as_one() {
        let filler = "● working on the parser and reading some code\n".repeat(12);
        let screen = format!("{}\n{}\n● not-blocked\n", nudge_text(1, 245), filler);
        assert_eq!(
            parse_reply(&screen),
            None,
            "a token beyond the reply window is incidental output, not an answer"
        );

        // The same token, in the position a real answer occupies, IS read — so the assertion above
        // is about the WINDOW and not about the parser having quietly stopped working.
        let answered = format!("{}\n● not-blocked\n{}", nudge_text(1, 245), filler);
        assert_eq!(parse_reply(&answered), Some(Reply::NotBlocked));
    }

    /// A stand-down holds while the agent stays SILENT — the situation it exists for.
    ///
    /// THE HASH IS HELD STEADY, and that is the whole point of the rewrite (roborev 60338, Medium).
    /// The previous version fed a DIFFERENT hash on every iteration and asserted `Observe`, which
    /// cannot fail: a changed look returns `Observe` with the rung reset to 0 whatever the
    /// stand-down says, so the ladder never reached a nudge rung and the claim in the test's own
    /// name went untested.
    #[test]
    fn a_stand_down_holds_while_the_agent_stays_silent() {
        let mut s = AgentState::default();
        run(&mut s, &stalled(), 7);
        let answered = Observation { hash: 0x11aa, reply: Some(Reply::NotBlocked), ..stalled() };
        step(&mut s, &answered);
        assert_eq!(s.standdown(), Some(Standdown::Done), "precondition: stood down");

        let d = run(&mut s, &answered, 20);
        assert!(
            d.iter().any(|x| x.rung as usize > FIRST_NUDGE_RUNG),
            "precondition: the ladder must actually reach a nudge rung, or this proves nothing"
        );
        assert!(d.iter().all(|x| x.action == Action::Observe), "and still never types");
    }

    /// …AND IT EXPIRES ON UNPROVOKED OUTPUT (roborev 60338, High).
    ///
    /// Latching it until a human typed gave `not-blocked` — the commonest token, and the one in the
    /// founder's screenshot — the power to silence an agent for the rest of its session. `Done`
    /// both refuses to write and reports NO flag, so an agent that answered at minute 5, worked on,
    /// and wedged at minute 40 was invisible in both directions. An answer minutes old does not
    /// describe an agent that is currently producing output.
    ///
    /// This does NOT revive pinging of a finished agent: that one is held quiet by `obs.goal_met`,
    /// which is re-read every look and owes nothing to this latch.
    #[test]
    fn unprovoked_output_expires_a_reply_stand_down() {
        let mut s = AgentState::default();
        run(&mut s, &stalled(), 7);
        step(&mut s, &Observation { hash: 0x11aa, reply: Some(Reply::NotBlocked), ..stalled() });
        assert_eq!(s.standdown(), Some(Standdown::Done), "precondition: stood down");

        // It gets back to work on its own: no reply, and nobody typed at it.
        step(&mut s, &Observation { hash: 0x11ab, reply: None, ..stalled() });
        assert_eq!(s.standdown(), None, "a stale answer must not outlive the idleness it described");

        // …and it is genuinely watched again — hold the hash steady and it reaches a nudge.
        let d = run(&mut s, &Observation { hash: 0x11ab, reply: None, ..stalled() }, 10);
        assert!(
            d.iter().any(|x| matches!(x.action, Action::Nudge { .. })),
            "an agent that answered once must not be exempt for the rest of its session"
        );
    }

    /// …AND THE EXPIRY IS NARROW (roborev 60353, High). A stand-down that RAISES A FLAG is visible
    /// by construction, so it never had the silent-in-both-directions problem the expiry exists to
    /// close — and expiring it deletes the row it was put up for. The rung resets to 0 on the look
    /// that reads the answer, so the next look is five seconds later: the "exact command or
    /// permission" explanation the nudge itself asked for was enough to destroy a founder row.
    ///
    /// Every other test of these two answers holds the hash CONSTANT after the reply, which is why
    /// none of them could see it.
    #[test]
    fn unprovoked_output_does_not_expire_a_stand_down_that_holds_a_flag() {
        for (reply, level) in
            [(Reply::Human, Escalation::Founder), (Reply::Quota, Escalation::Concierge)]
        {
            let mut s = AgentState::default();
            run(&mut s, &stalled(), 7);
            let answered = Observation { hash: 0x7001, reply: Some(reply), ..stalled() };
            let d = step(&mut s, &answered);
            assert_eq!(d.flagged, Some(level), "{reply:?}: precondition — the row went up");

            // The agent keeps talking: the explanation we asked it for, a repaint, the same turn's
            // tail. Unprovoked, so this is the path that used to wipe everything.
            let d = step(&mut s, &Observation { hash: 0x7002, reply: None, ..stalled() });
            assert_eq!(
                d.flagged,
                Some(level),
                "{reply:?}: the row must not vanish because the agent said more"
            );
            assert_eq!(s.standdown(), Some(Standdown::of(reply)), "{reply:?}: still stood down");

            // …and it is still not typed at, over a full climb past the nudge rung.
            let later = run(&mut s, &Observation { hash: 0x7002, reply: None, ..stalled() }, 14);
            assert!(
                later.iter().all(|x| x.action == Action::Observe),
                "{reply:?}: re-pinging is exactly what this stand-down forbids"
            );
            assert!(
                later.iter().all(|x| x.flagged == Some(level)),
                "{reply:?}: and the row stays up the whole time"
            );
        }
    }

    /// AN INVISIBLE STAND-DOWN EXPIRES TOO, EVEN THOUGH IT IS NOT `Done` (roborev 60369, Medium).
    ///
    /// `External` (`blocked-on-ci` / `blocked-on-another-agent`) raises NO flag, so it hides an
    /// agent exactly the way `Done` does — but the first narrowing keyed on the `Done` variant by
    /// name and swept it into the exemption. Its only release was a foreign write, and the thing
    /// that ends a CI wait does not type into a PTY. So an agent that answered `blocked-on-ci`, saw
    /// CI finish, worked for an hour and then wedged stayed pinned to the 600s cadence: its first
    /// ping arrived about an hour into the silence, with the flag reporting minutes.
    #[test]
    fn an_unflagged_stand_down_expires_on_unprovoked_output_whatever_its_variant() {
        for reply in [Reply::Ci, Reply::AnotherAgent, Reply::NotBlocked] {
            assert_eq!(Standdown::of(reply).flag(), None, "{reply:?}: precondition — invisible");

            let mut s = AgentState::default();
            run(&mut s, &stalled(), 7);
            step(&mut s, &Observation { hash: 0x8001, reply: Some(reply), ..stalled() });
            assert_eq!(s.standdown(), Some(Standdown::of(reply)), "{reply:?}: stood down");

            // It gets back to work on its own — the CI wait ended, nobody typed.
            step(&mut s, &Observation { hash: 0x8002, reply: None, ..stalled() });
            assert_eq!(s.standdown(), None, "{reply:?}: an invisible stand-down cannot outlive this");

            // …and it is back on the ORDINARY cadence, not pinned to the top rung.
            let d = run(&mut s, &Observation { hash: 0x8002, reply: None, ..stalled() }, 8);
            let first = d.iter().position(|x| matches!(x.action, Action::Nudge { .. }));
            assert_eq!(first, Some(5), "{reply:?}: first ping on the normal rungs, not an hour late");
            // THE DISCRIMINATOR: a latched `External` pins every look to the 600s top rung, so this
            // sequence is what separates "back on the ladder" from "waiting an hour to say anything".
            assert_eq!(
                d[..=5].iter().map(|x| x.next_look_secs).collect::<Vec<u64>>(),
                vec![10, 20, 30, 60, 120, 300],
                "{reply:?}: the dense early rungs are back"
            );
        }
    }

    /// A SURVIVING STAND-DOWN IS NOT A NEW EPISODE (roborev 60369, Medium).
    ///
    /// The reset zeroed the counters and the escalation high-water mark unconditionally, so every
    /// unprovoked repaint of an agent stood down on `blocked-on-human` rewrote the founder's row as
    /// `nudges: 0, silent_secs: 0` and re-armed `raise`, re-emitting an escalation event each time.
    /// A row that resets its own age cannot tell a one-minute wait from a six-hour one.
    #[test]
    fn a_repaint_does_not_restart_a_surviving_stand_downs_history() {
        let mut s = AgentState::default();
        run(&mut s, &stalled(), 9);
        let before_attempts = s.attempts();
        assert!(before_attempts >= 3, "precondition: a real nudge history");

        let d = step(&mut s, &Observation { hash: 0x9001, reply: Some(Reply::Human), ..stalled() });
        assert_eq!(d.flagged, Some(Escalation::Founder), "precondition: the row went up");
        let secs_at_answer = s.silent_secs();

        // Repaint after repaint, unprovoked. None of them is a new episode.
        for i in 0..6u64 {
            let d = step(&mut s, &Observation { hash: 0x9100 + i, reply: None, ..stalled() });
            assert_eq!(d.escalate, None, "repaint {i} must not re-emit an escalation event");
            assert_eq!(d.flagged, Some(Escalation::Founder), "repaint {i}: row still up");
        }
        assert_eq!(s.attempts(), before_attempts, "the nudge count must not regress to zero");
        assert_eq!(s.escalated(), Some(Escalation::Founder), "nor the high-water mark");
        assert!(
            s.silent_secs() >= secs_at_answer,
            "and the age must not restart: {} < {secs_at_answer}",
            s.silent_secs()
        );
    }

    /// …but a genuinely recovered agent — no stand-down — still gets the clean slate.
    #[test]
    fn a_recovered_agent_still_starts_a_fresh_episode() {
        let mut s = AgentState::default();
        run(&mut s, &stalled(), 9);
        assert!(s.attempts() >= 3);

        // The echo, then a RUN of the agent's own output. It takes a run rather than one sample
        // because a live pane repaints on its own — see `LIVE_LOOKS_TO_RESET`.
        step(&mut s, &Observation { hash: 0x9201, reply: None, ..stalled() });
        for h in 0x9202..(0x9202 + LIVE_LOOKS_TO_RESET as u64) {
            step(&mut s, &Observation { hash: h, reply: None, ..stalled() });
        }
        assert_eq!(s.attempts(), 0, "no stand-down means the episode really did end");
        assert_eq!(s.escalated(), None);
        assert_eq!(s.silent_secs(), 0, "and the silence clock restarts");
    }

    /// …but a FINISHED agent stays quiet through the same sequence, which is what makes the rule
    /// above safe rather than merely noisy. Same steps, `goal_met: true`.
    #[test]
    fn expiring_the_reply_latch_does_not_revive_pinging_of_a_finished_agent() {
        let mut s = AgentState::default();
        let done = Observation { goal_met: true, ..stalled() };
        run(&mut s, &done, 7);
        step(&mut s, &Observation { hash: 0x12aa, reply: Some(Reply::NotBlocked), ..done });
        step(&mut s, &Observation { hash: 0x12ab, reply: None, ..done });

        let d = run(&mut s, &Observation { hash: 0x12ab, reply: None, ..done }, 20);
        assert!(
            d.iter().all(|x| x.action == Action::Observe),
            "a met goal holds the agent quiet on its own, latch or no latch"
        );
    }

    /// A TRANSIENT ROSTER BLINK MUST NOT RE-EXEMPT A SUPERSEDED AGENT (roborev 60338, Medium).
    ///
    /// `goal_met` is computed from the roster, and an agent ABSENT from the roster reads as unmet —
    /// which is exactly what a frontend reload, a republish gap or a wedged WebView produces. One
    /// such look used to clear the supersession, and the next met look re-stamped it against the
    /// new write clock, restoring the lifetime exemption permanently and silently.
    #[test]
    fn a_roster_blink_does_not_re_exempt_a_superseded_goal() {
        let mut s = AgentState::default();
        run(&mut s, &Observation { goal_met: true, foreign_write_ms: 100, ..stalled() }, 10);
        // New work arrives — superseded.
        step(&mut s, &Observation { hash: 0x6001, goal_met: true, foreign_write_ms: 200, ..stalled() });
        // ONE look where the agent is missing from the roster, so `goal_met` reads false.
        step(&mut s, &Observation { hash: 0x6002, goal_met: false, foreign_write_ms: 200, ..stalled() });

        // Back on the roster, still met, same write clock — the exemption must NOT return.
        let back = Observation { hash: 0x6002, goal_met: true, foreign_write_ms: 200, ..stalled() };
        let d = run(&mut s, &back, 12);
        assert!(
            d.iter().any(|x| matches!(x.action, Action::Nudge { .. })),
            "a one-look roster blink must not hand back a lifetime exemption"
        );
    }
}
