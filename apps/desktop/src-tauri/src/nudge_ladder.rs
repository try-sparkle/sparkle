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
const ESCALATE_CONCIERGE_AFTER: u32 = 3;

/// Nudges with no output change before the founder is flagged. The nudger never addresses a human
/// itself — it raises a flag that the pusher/concierge loop (sparkle-4cd0x) consumes.
const ESCALATE_FOUNDER_AFTER: u32 = 6;

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

/// How long to wait between looks once an agent has told us it is out of quota.
///
/// Quota is the one blocker where re-asking is actively counterproductive: the reply costs a turn
/// against the very budget that is exhausted. Half an hour is the shortest interval that is not
/// simply the top rung again, and a quota window that reopens sooner will be caught by the agent's
/// own output resetting the episode long before this elapses.
const QUOTA_BACKOFF_SECS: u64 = 1800;

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
}

/// The wire tokens, longest-first so a prefix can never shadow a longer match.
const REPLY_TOKENS: [(&str, Reply); 5] = [
    ("blocked-on-another-agent", Reply::AnotherAgent),
    ("blocked-on-human", Reply::Human),
    ("blocked-on-quota", Reply::Quota),
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
}

impl Standdown {
    fn of(reply: Reply) -> Standdown {
        match reply {
            Reply::NotBlocked => Standdown::Done,
            Reply::Human => Standdown::AwaitHuman,
            Reply::Quota => Standdown::Quota,
            Reply::Ci | Reply::AnotherAgent => Standdown::External,
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
    let previous = state.hash;
    let changed = previous.is_some_and(|h| h != obs.hash);

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
        let conversation = changed && state.attempts > 0 && obs.reply.is_some();
        state.hash = Some(obs.hash);
        state.rung = 0;
        state.silent_secs = 0;
        if !conversation {
            state.attempts = 0;
            state.delivered = 0;
            state.last_blocked = None;
            state.escalated = None;
            state.standdown = None;
            state.last_reply = None;
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

    // Unchanged: climb.
    state.silent_secs += LADDER_SECS[state.rung.min(LADDER_SECS.len() - 1)];
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
    let target = if n >= ESCALATE_FOUNDER_AFTER {
        Some(Escalation::Founder)
    } else if n >= ESCALATE_CONCIERGE_AFTER {
        Some(Escalation::Concierge)
    } else {
        None
    };
    // `>` not `>=`: re-raising the same flag every rung would turn one stuck agent into a stream of
    // identical notices, which is how a signal stops being read.
    let escalate = raise(state, target);

    Decision {
        // The attempt counted either way; whether a BYTE goes out is a separate question.
        action: if blocked.is_some() { Action::Observe } else { Action::Nudge { n } },
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
    if obs.goal_met {
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
pub fn nudge_text(n: u32, silent_secs: u64) -> String {
    format!(
        "[sparkle-nudge #{n} · no output for {}] Automated ping, not a new task. Resume your \
         goal. If you are blocked, reply with ONE line: blocked-on-human | blocked-on-ci | \
         blocked-on-another-agent | blocked-on-quota | not-blocked — plus what you need.",
        human_duration(silent_secs)
    )
}

/// The last clause of `nudge_text`, and the boundary between OUR QUESTION and THEIR ANSWER.
///
/// This anchor is not decoration — it is the whole reason a naive parse is wrong. The nudge string
/// itself LISTS all five reply tokens, so any search over the raw screen matches our own question
/// and reads it as the agent's answer, every single time, on an agent that has said nothing at all.
/// That would silence a genuinely stalled agent, which is the one outcome forbidden here.
const NUDGE_TAIL: &str = "plus what you need.";

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

    // The LAST token in the answer region wins: an agent that corrects itself ("not-blocked —
    // actually blocked-on-ci") means the correction, and a scrolled-back older answer sits earlier.
    REPLY_TOKENS
        .iter()
        .filter_map(|(token, reply)| flat[answer_from..].rfind(token).map(|i| (i, *reply)))
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
        assert_eq!(s.attempts(), 0, "a moving agent has no nudge history");
        assert_eq!(s.silent_secs(), 0);
    }

    /// The change detector is the WHOLE detector. A one-byte difference in the hashed window is a
    /// reset; there is no content interpretation anywhere.
    #[test]
    fn a_reset_clears_an_escalation_too() {
        let mut s = AgentState::default();
        run(&mut s, &stalled(), 20);
        assert!(s.attempts() >= ESCALATE_FOUNDER_AFTER, "precondition: escalated");

        step(&mut s, &Observation { hash: 0xfeed, ..stalled() });
        // Climb again and assert the concierge flag is raised afresh rather than suppressed by the
        // previous episode's high-water mark.
        let d = run(&mut s, &Observation { hash: 0xfeed, ..stalled() }, 9);
        let raised: Vec<Escalation> = d.iter().filter_map(|d| d.escalate).collect();
        assert_eq!(raised, vec![Escalation::Concierge]);
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
             goal. If you are blocked, reply with ONE line: blocked-on-human | blocked-on-ci | \
             blocked-on-another-agent | blocked-on-quota | not-blocked — plus what you need."
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
    fn three_nudges_flag_the_concierge_and_six_flag_the_founder() {
        let mut s = AgentState::default();
        let decisions = run(&mut s, &stalled(), 20);

        let raised: Vec<(u32, Escalation)> =
            decisions.iter().filter_map(|d| d.escalate.map(|e| (d.rung, e))).collect();
        assert_eq!(
            raised,
            vec![(8, Escalation::Concierge), (8, Escalation::Founder)],
            "one concierge flag at the 3rd nudge, one founder flag at the 6th, and nothing else"
        );

        // Pin WHICH nudge each flag rode along with, so a change to the ladder that moved the
        // thresholds could not pass this test by coincidence of rung numbering.
        let concierge_at = decisions.iter().position(|d| d.escalate == Some(Escalation::Concierge));
        let founder_at = decisions.iter().position(|d| d.escalate == Some(Escalation::Founder));
        assert_eq!(decisions[concierge_at.unwrap()].action, Action::Nudge { n: 3 });
        assert_eq!(decisions[founder_at.unwrap()].action, Action::Nudge { n: 6 });
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

        let d = step(&mut s, &Observation { hash: 0xfeed, ..stalled() });
        assert!(d.hash_changed);
        assert_eq!(d.flagged, None, "a moving agent's look is not a flagging look");
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

        // Moving, with no answer to any nudge — the agent simply got back to work.
        let working_again = Observation { hash: 0x1077, reply: None, ..stalled() };
        step(&mut s, &working_again);
        assert_eq!(s.attempts(), 0, "unprovoked output earns a clean slate");
        assert_eq!(s.escalated(), None);
        assert_eq!(s.standdown(), None);
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

    /// A stand-down is NOT released by the passage of time or by the agent's own idle redraws —
    /// only by somebody actually giving it work. Otherwise the fourteen-ping loop returns with a
    /// longer period, which is not a fix.
    #[test]
    fn a_stand_down_survives_everything_except_new_work() {
        let mut s = AgentState::default();
        run(&mut s, &stalled(), 7);
        let answered = Observation { hash: 0x11aa, reply: Some(Reply::NotBlocked), ..stalled() };
        step(&mut s, &answered);

        // Idle redraws: the hash keeps moving, nobody typed. A spinner is not a new assignment.
        for i in 0..12u64 {
            let redraw = Observation { hash: 0x2000 + i, ..answered };
            let d = step(&mut s, &redraw);
            assert_eq!(d.action, Action::Observe, "redraw {i} must not revive the pinging");
        }
        assert_eq!(s.standdown(), Some(Standdown::Done));
    }
}
