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
    pub fn silent_secs(&self) -> u64 {
        self.silent_secs
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

    // ANY change resets the whole episode. This is the entire detector.
    if changed || previous.is_none() {
        state.hash = Some(obs.hash);
        state.rung = 0;
        state.attempts = 0;
        state.delivered = 0;
        state.last_blocked = None;
        state.escalated = None;
        state.silent_secs = 0;
        return Decision {
            action: Action::Observe,
            escalate: None,
            rung: 1,
            hash_changed: changed,
            // A first look has nothing to refuse — it is the baseline, not a declined write.
            refusal: if changed { None } else { Some("seeding") },
            next_look_secs: LADDER_SECS[0],
        };
    }

    // Unchanged: climb.
    state.silent_secs += LADDER_SECS[state.rung.min(LADDER_SECS.len() - 1)];
    state.rung = (state.rung + 1).min(LADDER_SECS.len() - 1);
    let rung = state.rung;
    let next_look_secs = LADDER_SECS[rung];
    let rung_1based = (rung + 1) as u32;

    let observe = |refusal: &'static str| Decision {
        action: Action::Observe,
        escalate: None,
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
    let escalate = match (target, state.escalated) {
        (Some(t), None) => {
            state.escalated = Some(t);
            Some(t)
        }
        (Some(t), Some(prev)) if t > prev => {
            state.escalated = Some(t);
            Some(t)
        }
        _ => None,
    };

    Decision {
        // The attempt counted either way; whether a BYTE goes out is a separate question.
        action: if blocked.is_some() { Action::Observe } else { Action::Nudge { n } },
        escalate,
        rung: rung_1based,
        hash_changed: false,
        refusal: blocked,
        next_look_secs,
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
        }
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
}
