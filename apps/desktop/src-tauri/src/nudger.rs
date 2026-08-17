//! THE DUMB LAYER THAT SURVIVES A 529 (bead sparkle-a94sr).
//!
//! ── THE FAILURE THIS CLOSES ───────────────────────────────────────────────────────────────────
//! Every unsticking mechanism Sparkle has is itself an LLM, so a provider-wide outage takes out the
//! watchdog and the watched at the same time. On 2026-08-03 that happened: the agent "Mount Tells
//! The Truth" died on an Anthropic 529 after 21 minutes of good work and sat `errored` for hours,
//! because the only thing that could have revived it was also an LLM. The same night, five other
//! agents sat red holding correct answers that had been typed into their prompts and never
//! submitted (sparkle-bhhu1) — each looking like it was waiting on the founder, none of them
//! actually waiting on anything.
//!
//! This module is the layer underneath all of that. It has NO model call on ANY path, it runs on a
//! plain OS thread in the Rust process rather than in the WebView, and its only inputs are the PTY
//! byte stream and the agent status table. It keeps working when every model on earth is returning
//! 529 and when the WebView is wedged.
//!
//! ── WHY IT IS NOT JAVASCRIPT, RESTATED CONCRETELY ─────────────────────────────────────────────
//! `engine/apiRecovery.ts` already ships a deterministic 529 revive ladder, and it is good — but it
//! runs in the WebView, so it shares a failure domain with the renderer, and it only fires on a
//! CLASSIFIED vendor-error banner. This module fires on the absence of output, whatever caused it,
//! from a process that a wedged WebView cannot stop. In ordinary operation apiRecovery gets there
//! first and its output resets this ladder to rung 1 — which is the correct outcome, because it is
//! the more specific mechanism. This one is what remains when it is gone.
//!
//! ── WHERE THE RENDERED SCREEN COMES FROM ──────────────────────────────────────────────────────
//! The safety gate has to read a RENDERED screen (a picker, a password prompt and a `vim` buffer
//! are only distinguishable after the escape sequences have been applied), and before this change
//! Rust had none: the only terminal emulator in the app was xterm.js, in the WebView, behind the
//! exact failure this module exists to survive. So each session now also feeds a headless `vt100`
//! parser here, off the same bytes the reader thread already decodes. That is where both the screen
//! text and the alternate-screen flag come from, and neither requires the frontend to be alive.
//!
//! ── FAIL CLOSED ───────────────────────────────────────────────────────────────────────────────
//! Every unknown is a refusal to write. No session, no screen, an unreadable screen, a screen that
//! might be a picker, a recent write by anybody else — all of them mean "do not type". The cost of
//! a false refusal is one skipped nudge and another look at most ten minutes later. The cost of a
//! false permit is a keystroke into `vim`, a password field, or a picker nobody read.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::nudge_gate::{self, Screen};
use crate::nudge_ladder::{self, Action, AgentState, Observation};

/// How often the thread wakes. Also the resolution of every deadline below, and deliberately equal
/// to `watchdog.rs`'s TICK for the same reason: a fixed cheap tick is easier to reason about than a
/// forest of per-agent timers, and the ladder's shortest rung is 5s, so 1s is ample.
const TICK: Duration = Duration::from_secs(1);

/// Bytes of PTY output retained per agent, and the exact window the change detector hashes. From
/// the bead: "hash the last 4KB of PTY output plus current status".
const TAIL_BYTES: usize = 4096;

/// Fallback VT grid, used ONLY when a caller reports no geometry at all.
///
/// ── THE GRID MIRRORS THE CHILD, IT DOES NOT IMPROVE ON IT ─────────────────────────────────────
/// An earlier version floored this at 120x40 on the theory that a wide grid keeps Claude's prompt
/// box and footer on one row each, since a hard wrap splits a credential prompt's word from its
/// colon and defeats the gate's `…:\s*$` patterns. That reasoning is wrong in a way worth
/// recording, because it is tempting:
///
///   1. It does not work. The CHILD wraps its own output — it renders to the geometry `pty_spawn`
///      gave it — so a thin pane's text arrives here already wrapped. A wider grid cannot unwrap
///      it, and the gate's wrap-tolerant arm exists precisely to cover that case.
///   2. It actively breaks the screen. Claude Code redraws with ABSOLUTE cursor addressing, so a
///      grid of different dimensions than the child believes it has puts content on the wrong rows
///      and renders a garbled screen — which is far worse to gate on than a wrapped one.
///   3. It was void anyway. The frontend resizes on mount, so production re-set the grid to the
///      real pane size within moments and only the test ever saw the floor.
///
/// So: mirror the child exactly, on both `attach` and `resize`.
const DEFAULT_COLS: u16 = 120;
const DEFAULT_ROWS: u16 = 40;

/// If our own tick overran by this much we were not running either — a machine suspend, not a
/// stall. Same discrimination `watchdog.rs` makes, and for the same reason: a laptop asleep for an
/// hour must not wake up and find every agent eight rungs up the ladder.
const SUSPEND_OVERSHOOT_MS: u64 = 5_000;

static STARTED: AtomicBool = AtomicBool::new(false);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ══ THE OBSERVER ════════════════════════════════════════════════════════════════════════════════

/// Per-session observation state, fed by the PTY reader thread.
///
/// Kept OUT of `PtySession` on purpose: `pty.rs` owns process plumbing and its `sessions` map is
/// private, and this is the nudger's data with the nudger's lifetime. `pty.rs` only calls `ingest`,
/// `note_foreign_write` and `resize`.
pub struct PtyObserver {
    /// Last `TAIL_BYTES` of decoded output. A plain `Vec` used as a bounded window — a `VecDeque`
    /// would save a memmove we do at most once per read of at most 4KB, which is not worth the
    /// awkwardness of hashing a split ring.
    tail: Mutex<Vec<u8>>,
    /// The rendered screen. `vt100` applies the escape sequences so the gate can read a picture
    /// rather than a byte stream.
    screen: Mutex<vt100::Parser>,
    /// Epoch ms of the last write by anybody OTHER than this module. See
    /// `nudge_ladder::Observation::since_other_write_ms` for why this exists — it closes the
    /// paste→CR window that JS's `chainPtyOp` serialization guards and a Rust write bypasses.
    last_foreign_write_ms: AtomicU64,
    /// The PTY reader thread is PARKED, so this observer is not being fed.
    ///
    /// ── WHY THIS IS A FAIL-OPEN WITHOUT IT ────────────────────────────────────────────────────
    /// The reader parks on TWO backpressure gates (`wait_while_paused` and `inflight.acquire`) that
    /// sit UPSTREAM of `read()`, so while a session is flow-controlled the child can be producing
    /// output furiously and this observer sees none of it. The tail stops changing — which reads as
    /// SILENCE and climbs the ladder — and the VT grid stops advancing, so the safety gate would be
    /// evaluated against a screen that is minutes out of date. That is the one fail-open this module
    /// says it must never have: the stale screen can show a clean prompt while the live one shows a
    /// picker.
    ///
    /// And it is not hypothetical for the target scenario. A wedged WebView stops sending `pty_ack`,
    /// which is exactly what latches these gates — so the failure this module exists to survive is
    /// also the failure that would blind it.
    reader_parked: AtomicBool,
}

impl PtyObserver {
    fn new(cols: u16, rows: u16) -> Self {
        Self {
            tail: Mutex::new(Vec::with_capacity(TAIL_BYTES)),
            screen: Mutex::new(vt100::Parser::new(rows, cols, 0)),
            last_foreign_write_ms: AtomicU64::new(0),
            reader_parked: AtomicBool::new(false),
        }
    }

    /// Feed decoded output. Called from the PTY reader thread, once per `read()`.
    ///
    /// Poison-tolerant like the rest of the PTY path: a panic in some other thread must never wedge
    /// a reader, and an observation is not worth propagating a failure for.
    pub fn ingest(&self, text: &str) {
        let bytes = text.as_bytes();
        {
            let mut tail = self.tail.lock().unwrap_or_else(|e| e.into_inner());
            if bytes.len() >= TAIL_BYTES {
                tail.clear();
                tail.extend_from_slice(&bytes[bytes.len() - TAIL_BYTES..]);
            } else {
                tail.extend_from_slice(bytes);
                let overflow = tail.len().saturating_sub(TAIL_BYTES);
                if overflow > 0 {
                    tail.drain(..overflow);
                }
            }
        }
        let mut screen = self.screen.lock().unwrap_or_else(|e| e.into_inner());
        screen.process(bytes);
    }

    /// Mark the PTY reader as parked (or running) on its backpressure gates. Called by the reader
    /// thread either side of the two waits.
    pub fn set_reader_parked(&self, parked: bool) {
        self.reader_parked.store(parked, Ordering::Relaxed);
    }

    fn reader_is_parked(&self) -> bool {
        self.reader_parked.load(Ordering::Relaxed)
    }

    /// Record that something other than the nudger wrote to this PTY.
    pub fn note_foreign_write(&self) {
        self.last_foreign_write_ms
            .store(now_ms(), Ordering::Relaxed);
    }

    /// Keep the VT grid in step with the real pane.
    pub fn resize(&self, cols: u16, rows: u16) {
        if cols == 0 || rows == 0 {
            return;
        }
        let mut screen = self.screen.lock().unwrap_or_else(|e| e.into_inner());
        screen.screen_mut().set_size(rows, cols);
    }

    /// Hash of the tail plus the status string — the whole detector, with no content
    /// interpretation. FNV-1a: stable across runs (unlike `DefaultHasher`, which is randomly seeded
    /// per process and would make a logged hash meaningless between restarts), and this is a change
    /// detector, not a security primitive.
    fn hash_with_status(&self, status: &str) -> u64 {
        let tail = self.tail.lock().unwrap_or_else(|e| e.into_inner());
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for b in tail.iter().chain(b"\x00".iter()).chain(status.as_bytes()) {
            h ^= *b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
        h
    }

    /// The rendered screen, as the gate needs it.
    fn render(&self) -> (String, bool) {
        let screen = self.screen.lock().unwrap_or_else(|e| e.into_inner());
        (
            screen.screen().contents(),
            screen.screen().alternate_screen(),
        )
    }

    fn since_foreign_write_ms(&self, now: u64) -> u64 {
        let last = self.last_foreign_write_ms.load(Ordering::Relaxed);
        if last == 0 {
            return u64::MAX;
        }
        now.saturating_sub(last)
    }
}

/// The registry of live observers, keyed by agent id (which IS the PTY session id).
#[derive(Default)]
pub struct Observers(Mutex<HashMap<String, Arc<PtyObserver>>>);

impl Observers {
    /// Start observing a session. Returns the handle the reader thread keeps, so the hot path costs
    /// no map lookup per read.
    pub fn attach(&self, id: &str, cols: u16, rows: u16) -> Arc<PtyObserver> {
        // Mirror the child's geometry; fall back only when none was reported.
        let cols = if cols == 0 { DEFAULT_COLS } else { cols };
        let rows = if rows == 0 { DEFAULT_ROWS } else { rows };
        let observer = Arc::new(PtyObserver::new(cols, rows));
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.to_string(), observer.clone());
        observer
    }

    pub fn detach(&self, id: &str) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    }

    pub fn get(&self, id: &str) -> Option<Arc<PtyObserver>> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
    }

    fn all(&self) -> Vec<(String, Arc<PtyObserver>)> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }
}

// ══ THE FLAGS THE PUSHER CONSUMES ═══════════════════════════════════════════════════════════════

/// A raised flag. Shape C of the bead: an escalation is NOT a write, and this module never
/// addresses a human itself — it records a flag that the pusher/concierge loop (sparkle-4cd0x)
/// reads and acts on.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NudgeFlag {
    pub agent_id: String,
    /// `"concierge"` or `"founder"`.
    pub target: String,
    pub raised_at_ms: u64,
    /// Ticks that reached a nudge rung with no output change — what crossed the threshold.
    pub nudges: u32,
    /// Of those, how many were actually SUBMITTED. `0` with a high `nudges` means we could never
    /// write to this agent at all, which is a different problem for the consumer to solve.
    pub delivered: u32,
    /// Why the last attempt could not write, if it could not. Lets the pusher tell "we nudged six
    /// times and it ignored us" from "its screen is a picker" or "its reader is parked".
    pub blocked_by: Option<String>,
    /// How long the agent had been silent.
    pub silent_secs: u64,
    /// The agent's OWN last one-line answer — `blocked-on-human`, `blocked-on-quota`, … — or `None`
    /// if it never answered.
    ///
    /// DISTINCT FROM `blocked_by`, and the distinction is the whole point: `blocked_by` is why WE
    /// could not type at it (a picker, a parked reader), which is our problem. This is what the
    /// AGENT said is stopping IT, which is the human's problem. A founder-level row that reads
    /// `blocked-on-human` tells the reader what is owed; the same row with only `blocked_by: null`
    /// tells them an agent has been quiet for a while and nothing about why.
    pub reply: Option<String>,
}

/// Live flags, keyed by agent id so a stuck agent contributes one row rather than a stream.
///
/// PULL, not just push. An event alone would be lost across a WebView reload — and the consumer of
/// these flags is a loop whose whole job is to notice things that got lost. So the flags are held
/// here and read with `nudger_flags`; the event is an optimisation on top, not the channel.
#[derive(Default)]
pub struct NudgeFlags(Mutex<HashMap<String, NudgeFlag>>);

impl NudgeFlags {
    fn raise(&self, flag: NudgeFlag) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(flag.agent_id.clone(), flag);
    }
    fn clear(&self, agent_id: &str) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(agent_id);
    }
    fn get(&self, agent_id: &str) -> Option<NudgeFlag> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(agent_id)
            .cloned()
    }
    fn agent_ids(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect()
    }
    fn list(&self) -> Vec<NudgeFlag> {
        let mut out: Vec<NudgeFlag> = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect();
        out.sort_by(|a, b| a.raised_at_ms.cmp(&b.raised_at_ms));
        out
    }
}

// ══ COMMANDS ════════════════════════════════════════════════════════════════════════════════════

/// Every flag currently raised. The pusher loop polls this.
#[tauri::command]
pub fn nudger_flags(flags: State<NudgeFlags>) -> Vec<NudgeFlag> {
    flags.list()
}

/// Drop a flag once the consumer has acted on it.
#[tauri::command]
pub fn nudger_clear_flag(flags: State<NudgeFlags>, agent_id: String) {
    flags.clear(&agent_id);
}

/// DISMISS CLAUDE CODE'S SESSION-LIMIT PICKER — the only machine keystroke this app will ever send
/// at a dialog `write_refusal` refuses, and it is exactly one byte: `nudge_gate::ESCAPE_KEY`.
///
/// ── WHY THE DECISION IS MADE HERE AND NOT BY THE CALLER ──────────────────────────────────────
/// `services/authRecovery.ts` asks; this decides. The TypeScript side has its own matcher and its
/// own reason code, but "the WebView believes this is the session-limit picker" is NOT an input to
/// this function and must never become one. The nudger thread re-derives the verdict from the grid
/// it owns, because the whole reason a Rust twin of the matcher exists is that this layer keeps
/// working when the WebView is wedged — and a wedged WebView's last opinion is exactly the stale
/// evidence that would press a button nobody read.
///
/// So the gate is `nudge_gate::escape_refusal`, which fails CLOSED on every unknown: no viewport,
/// an alternate buffer we cannot attribute to Claude Code, a running turn, a credential prompt, or
/// any screen its own matcher does not positively recognise. `Err` on refusal rather than a silent
/// no-op, so the caller records `escape-failed` instead of claiming an action that did not happen.
///
/// ── WHAT IS SENT ─────────────────────────────────────────────────────────────────────────────
/// `ESCAPE_KEY`, with NO carriage return and NO option digit, ever. The three options on that picker
/// are account-level BILLING decisions — "Switch to usage credits" moves the user onto paid overage
/// and "Switch to Team plan" changes their subscription — so a digit here spends the user's money
/// and a CR confirms whichever option the cursor happens to sit on. `deliver_with` is deliberately
/// NOT used: its job is to type a body and optionally submit it, and submitting is the harm.
#[tauri::command]
pub fn nudger_send_escape<R: Runtime>(
    app: AppHandle<R>,
    observers: State<Observers>,
    agent_id: String,
) -> Result<(), String> {
    let Some(observer) = observers.get(&agent_id) else {
        return Err("no terminal observer for this agent".into());
    };
    send_escape_with(&observer, now_ms(), |data| {
        crate::pty::write_session(&app, &agent_id, data)
    })
}

/// `nudger_send_escape` with the PTY write INJECTED, so "which bytes were written" is assertable.
///
/// Split for the same reason `deliver_with` is: the interesting properties here are which writes do
/// NOT happen, and that the one that does is exactly one byte. Through a real `AppHandle` none of
/// that is observable in a unit test, and an edit swapping the body for `deliver_with(…, submit =
/// true)` — which would CONFIRM whichever billing option the cursor sits on — would keep every test
/// green.
fn send_escape_with<W: FnOnce(&str) -> Result<(), String>>(
    observer: &PtyObserver,
    now: u64,
    write: W,
) -> Result<(), String> {
    // A parked reader means the grid stopped advancing, so nothing read off it is current. Same
    // fail-closed verdict `observe` gives it.
    if observer.reader_is_parked() {
        return Err("screen unreadable (reader parked)".into());
    }
    // THE FOREIGN-WRITE STAND-DOWN, which every other machine write in this crate already respects
    // via `nudge_ladder::step` (roborev 58167). Without it this was the ONE write that could land
    // inside a human's in-flight interaction: the founder sitting at this very picker, deciding
    // between "Stop and wait" and "Switch to usage credits", presses ↓ — a `pty_write` that moves
    // the cursor without changing the screen enough to fail `escape_refusal` — and a recovery
    // attempt cancels the dialog out from under them mid-decision. That is precisely the harm the
    // gate exists to prevent, and the caller already records `escape-failed` on `Err`.
    if observer.since_foreign_write_ms(now) < nudge_ladder::QUIET_AFTER_OTHER_WRITE_MS {
        return Err("recent write by another writer".into());
    }
    let (text, alternate) = observer.render();
    if let Some(refusal) = nudge_gate::escape_refusal(Some(&Screen {
        text: &text,
        alternate,
    })) {
        return Err(format!("refused: {}", refusal.as_str()));
    }
    write(nudge_gate::ESCAPE_KEY)
}

// ══ THE LOOP ════════════════════════════════════════════════════════════════════════════════════

/// Per-agent scheduling state, held only by the thread.
struct Tracked {
    state: AgentState,
    due_at_ms: u64,
    /// When we last actually LOOKED at this agent, so the ladder can be handed the wall clock that
    /// really passed rather than the interval that was scheduled. Rebaselined alongside `due_at_ms`
    /// on a detected suspend — see the loop — because the two facts go stale together.
    last_look_ms: u64,
}

/// Read the agent status table. `None` when this agent is not in it at all.
///
/// The roster is written by the frontend and boots empty, so an ABSENT agent is "unobserved", not
/// "idle" — and critically, a wedged WebView freezes this table at whatever it last said. That is
/// why the ladder treats the SCREEN as authoritative for "is a turn running" (a spinner is on the
/// screen or it is not) and uses this only as a second, corroborating veto. A stale `working` here
/// costs us nothing but a skipped nudge; trusting it as the only signal would disarm the module in
/// exactly the outage it was built for.
/// Built ONCE per tick, not once per agent. `merge` rebuilds and clones the entire roster on every
/// call, so asking it per agent is quadratic in fleet size — and this fleet runs to dozens of
/// agents, on a thread whose whole justification is that it stays cheap and stays alive.
fn status_map<R: Runtime>(app: &AppHandle<R>) -> HashMap<String, AgentFacts> {
    let Some(state) = app.try_state::<crate::roster::RosterState>() else {
        return HashMap::new();
    };
    let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    crate::roster::merge(&guard)
        .into_iter()
        .flat_map(|p| p.agents)
        .map(|a| {
            let facts = AgentFacts {
                goal_met: goal_is_met(a.goal_state.as_deref()),
                status: a.status,
                rollup_dot: a.rollup_dot.as_deref().and_then(nudge_ladder::intern_dot),
                stage: a.workflow_stage.as_deref().and_then(nudge_ladder::intern_stage),
            };
            (a.id, facts)
        })
        .collect()
}

/// The two roster facts one tick needs about one agent.
#[derive(Debug, Clone, Default)]
struct AgentFacts {
    status: String,
    goal_met: bool,
    /// The row's disc once folded workers are counted, and the workflow stage — both already on the
    /// roster slice and both previously DROPPED here. They are what lets the native watcher see the
    /// founder's condition: a row that is not green and not yet merged to main. See
    /// `nudge_ladder::tick_unlanded_clock`.
    rollup_dot: Option<&'static str>,
    stage: Option<&'static str>,
}

/// Is this agent's goal FINISHED? Only the exact tokens count.
///
/// Free function so the tri-state is assertable. `None` is a window that predates the field and
/// "unmet"/"expired"/"escalated"/"none" are all live goals — every one of them must read as NOT
/// finished, because a false "finished" is the only reading here that can silence an agent that
/// still needs help. `engine/agentGoal.ts::GoalState` is the vocabulary; a typo on either side reads
/// as unfinished, which is the safe direction.
///
/// ⚠️ "discharged" IS FINISHED TOO, and leaving it out was a live defect rather than an omission.
/// It is the terminal state `goalExpiry` writes when git PROVED the work landed and the tree is
/// clean — a stronger claim than "met", which the agent asserts about itself. `useRosterPublisher`
/// publishes `goalStateOf` verbatim, so a discharged goal arrived here as an unrecognised token,
/// read as a live goal, and the agent was pinged to "resume your goal" over work git had already
/// confirmed landed: the founder's fourteen-ping screenshot, reproduced on the new state. This is a
/// VALUE enumeration over a string, so TypeScript could not flag it when the state was added.
fn goal_is_met(goal_state: Option<&str>) -> bool {
    matches!(goal_state, Some("met") | Some("discharged"))
}

/// Start the nudger. Idempotent; safe to call more than once.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut tracked: HashMap<String, Tracked> = HashMap::new();
        let started = Instant::now();
        let mut clock = LoopClock::new(now_ms(), started.elapsed().as_millis() as u64);
        loop {
            std::thread::sleep(TICK);
            let now = now_ms();
            let overshoot = clock.suspended_ms(now, started.elapsed().as_millis() as u64);
            if overshoot > SUSPEND_OVERSHOOT_MS {
                // We were frozen alongside everything else, so the silence means nothing. Push
                // every deadline out rather than reading a suspend as eight rungs of stall.
                //
                // THE LOOK CLOCK IS REBASELINED WITH IT, and it has to be: the ladder's clocks are
                // handed `now - last_look_ms`, so leaving this at its pre-suspend value would charge
                // the entire frozen span — hours, potentially — to an agent that was not running for
                // any of it. That is the same misreading the deadline push exists to prevent, one
                // field over, and it defeats it completely: `UNLANDED_STALL_SECS` is half an hour,
                // so a single post-resume look could carry the unlanded clock from zero across the
                // threshold and flag a healthy agent for having been asleep.
                rebaseline_after_suspend(&mut tracked, now);
                tracing::debug!(target: "nudger", overshoot_ms = overshoot, "suspend detected; rebaselined");
                continue;
            }
            tick(&app, &mut tracked, now);
        }
    });
}

/// The loop's own clock, and the ONE thing that can tell a FROZEN MACHINE from a SLOW ITERATION.
///
/// Both look identical on a wall clock: the loop went round and more time had passed than it slept
/// for. Reading that difference alone as a suspend was WRONG IN THE EXPENSIVE DIRECTION (roborev
/// 64304), because `tick` is not bounded — it renders a VT grid per due agent and sleeps
/// `SUBMIT_CR_DELAY` inside `deliver_with` for EVERY nudge it submits — and deadlines are aligned by
/// construction, since agents that start together climb identical rungs and come due in the same
/// tick. A fleet-sized burst therefore pushes one iteration past the threshold on a perfectly awake
/// machine, and the response is not a no-op: the loop `continue`s past every due look and
/// `rebaseline_after_suspend` rewrites the WHOLE roster — discarding elapsed credit for agents that
/// were never frozen and collapsing a 600s or 1800s stand-down schedule to 5s. Worse, it is
/// self-sustaining: a consistently slow tick alternates rebaseline and tick forever, so the clocks
/// under-count real silence while every test stays green.
///
/// A MONOTONIC clock separates them, because it is the one that STOPS during a suspend while the
/// wall clock keeps running. So the suspended time is exactly the wall-clock delta MINUS the
/// monotonic delta: a slow tick advances both equally and yields zero, and a freeze — wherever in
/// the iteration it begins, including inside the `tick` body — yields the whole frozen span. It
/// also catches a forward `SystemTime` step for free, which is the other way `now_ms` can lie.
///
/// Both readings are passed IN rather than taken here, so this is testable with plain integers; the
/// loop is the only caller and it is the part that cannot be reached from a test.
struct LoopClock {
    last_wall_ms: u64,
    last_mono_ms: u64,
}

impl LoopClock {
    fn new(wall_ms: u64, mono_ms: u64) -> Self {
        Self {
            last_wall_ms: wall_ms,
            last_mono_ms: mono_ms,
        }
    }

    /// Milliseconds of this iteration attributable to a SUSPEND: wall clock that passed while the
    /// monotonic clock did not. Zero for any iteration that merely took a long time.
    fn suspended_ms(&mut self, wall_ms: u64, mono_ms: u64) -> u64 {
        let wall = wall_ms.saturating_sub(self.last_wall_ms);
        let mono = mono_ms.saturating_sub(self.last_mono_ms);
        self.last_wall_ms = wall_ms;
        self.last_mono_ms = mono_ms;
        wall.saturating_sub(mono)
    }
}

/// Forget everything the freeze made us believe about time.
///
/// BOTH FIELDS, and the second is not an afterthought. Pushing `due_at_ms` out stops a suspend from
/// reading as eight rungs of stall; rebaselining `last_look_ms` stops it from being CREDITED as
/// elapsed wall clock to the ladder's clocks, which are handed `now - last_look_ms`. Moving only
/// the deadline leaves the whole frozen span — hours, potentially — charged to an agent that was
/// not running for any of it, and `UNLANDED_STALL_SECS` is only half an hour, so one post-resume
/// look could carry that clock from zero across the threshold and flag a perfectly healthy agent.
/// Extracted from the loop so it is reachable by a test at all; the loop itself runs on a thread.
fn rebaseline_after_suspend(tracked: &mut HashMap<String, Tracked>, now: u64) {
    for t in tracked.values_mut() {
        t.due_at_ms = now.saturating_add(nudge_ladder::LADDER_SECS[0] * 1000);
        t.last_look_ms = now;
    }
}

fn tick<R: Runtime>(app: &AppHandle<R>, tracked: &mut HashMap<String, Tracked>, now: u64) {
    let Some(observers) = app.try_state::<Observers>() else {
        return;
    };
    let live = observers.all();

    // Forget agents whose PTY is gone, so a long session does not accumulate dead rows.
    let live_ids: std::collections::HashSet<&str> =
        live.iter().map(|(id, _)| id.as_str()).collect();
    // Drop a flag whose agent's terminal is GONE, alongside its ladder state. `spin_down` and a
    // natural exit both detach the observer, but neither touched the flag — so a founder-level
    // "stuck for 15m" row could outlive the session it described and have the pusher chase a
    // terminal that no longer exists.
    if let Some(flags) = app.try_state::<NudgeFlags>() {
        sweep_dead_flags(&flags, &live_ids);
    }
    tracked.retain(|id, _| live_ids.contains(id.as_str()));

    let statuses = status_map(app);

    for (agent_id, observer) in &live {
        let entry = tracked.entry(agent_id.clone()).or_insert_with(|| Tracked {
            state: AgentState::default(),
            due_at_ms: now,
            last_look_ms: now,
        });
        if now < entry.due_at_ms {
            // NOTHING BETWEEN LOOKS. A repair here was tried and reverted (roborev 59061, High): its
            // only gate was `state.escalated()`, which `nudge_ladder::step` refreshes ONLY on a due
            // look, so on the last rung it is a snapshot up to 600s stale. Running it on the 1s tick
            // made `nudger_clear_flag` a no-op for founder rows — a consumer's clear came back
            // within a second, on recovered agents too, with a fresh `raised_at_ms` that reset the
            // row's age. A channel that reports resolved problems stops being read, which is the
            // failure this module's header names.
            //
            // The founder's rule is still met by `apply_flags`, which raises UNCONDITIONALLY on
            // every flagging look, so a cleared row on a still-wedged agent returns on the next look
            // rather than never. The cost is honest and bounded: up to one rung of latency. Gating a
            // faster repair on OUTPUT rather than on stale ladder state is the real fix and is not
            // attempted here.
            continue;
        }

        // An agent ABSENT from the roster is UNOBSERVED, not idle: the roster is written by the
        // frontend and boots empty, so this is also what a wedged WebView looks like. Reading it as
        // an empty status is deliberate — it removes the roster's veto and leaves the decision to
        // the screen, which is the signal that still works in that case.
        let facts = statuses.get(agent_id);
        let status_str = facts.map(|f| f.status.as_str()).unwrap_or("");
        // An agent missing from the roster has NO goal fact, which reads as unmet — so an unobserved
        // agent keeps the full ladder rather than being silenced by an absence.
        let goal_met = facts.is_some_and(|f| f.goal_met);
        // An agent ABSENT from the roster yields `None` for both, which every rule reads as no
        // evidence — so an unobserved agent is never flagged on this path, only on the ordinary one.
        let rollup_dot = facts.and_then(|f| f.rollup_dot);
        let stage = facts.and_then(|f| f.stage);
        // THE WALL CLOCK THIS LOOK REPRESENTS, measured rather than re-derived from the schedule.
        // The ladder's two clocks both count seconds, and the interval that was SCHEDULED is not
        // the interval that PASSED whenever a stand-down overrode it or a suspend rebaselined it.
        //
        // CAPPED, because a measurement is only as good as the clock behind it and this one has two
        // known ways to be wrong (roborev 64284). The suspend detector above can miss a freeze —
        // it now covers the tick body too, but nothing covers the instant between the two — and
        // `now_ms` is `SystemTime`, so a forward wall-clock step is indistinguishable from time
        // passing. Uncapped, either one dumps the whole gap into both clocks in a single look:
        // `UNLANDED_STALL_SECS` is 1800, so ONE such look takes a healthy agent from zero to a
        // concierge flag, and `silent_secs` is the figure on the founder's row.
        //
        // The bound is what was actually SCHEDULED for this agent, plus the same slack the suspend
        // detector uses. `due_at_ms - last_look_ms` IS that schedule — set from the previous
        // decision's own `next_look_secs` — so this needs nothing out of the ladder's internals, and
        // ordinary jitter (well under the slack) still passes through unrounded. A look can now
        // never credit more than one scheduled interval however badly the clock behaves.
        let scheduled_ms = entry.due_at_ms.saturating_sub(entry.last_look_ms);
        let elapsed_secs = now
            .saturating_sub(entry.last_look_ms)
            .min(scheduled_ms.saturating_add(SUSPEND_OVERSHOOT_MS))
            / 1000;
        entry.last_look_ms = now;
        let obs = observe(
            observer,
            status_str,
            goal_met,
            rollup_dot,
            stage,
            now,
            Some(elapsed_secs),
        );

        let decision = nudge_ladder::step(&mut entry.state, &obs);
        entry.due_at_ms = now.saturating_add(decision.next_look_secs * 1000);

        // INSTRUMENTATION IS NOT OPTIONAL (the bead's words). Every tick decision, every agent,
        // every rung — this is the only way anyone can later answer "does nudging actually work"
        // instead of guessing about the next outage the way we guessed about this one.
        tracing::debug!(
            target: "nudger",
            agent = %agent_id,
            rung = decision.rung,
            hash_changed = decision.hash_changed,
            gate = decision.refusal.unwrap_or("pass"),
            action = action_name(&decision.action),
            status = status_str,
            silent_secs = entry.state.silent_secs(),
            // The three facts that decide whether we type at all now. Without them "why did it stop
            // nudging" is unanswerable from the log, and the answer is exactly what a reader of this
            // module needs — the previous version could not even show that an agent HAD replied.
            goal_met = goal_met,
            reply = entry.state.last_reply().map(|r| r.as_str()).unwrap_or("-"),
            nudges = entry.state.attempts(),
            // The second clock. Without it "why was this row raised" is unanswerable from the log
            // for every agent flagged on the unlanded path rather than the silence path.
            rollup_dot = rollup_dot.unwrap_or("-"),
            stage = stage.unwrap_or("-"),
            unlanded_secs = entry.state.unlanded_secs(),
            "nudger tick"
        );

        let outcome = match &decision.action {
            Action::Observe => None,
            // Bracketed paste is NOT used for the bare Enter: there is nothing to paste, and the
            // whole point is to submit what the agent already typed.
            Action::Enter => Some(deliver(app, observer, agent_id, "\r", false)),
            // EXACTLY the affirmative option byte, with NO carriage return -- `submit: false`.
            // A CR would confirm whichever option the cursor happens to sit on, which on a screen
            // we have mis-identified is the precise harm the gate exists to prevent.
            Action::Answer => Some(deliver(
                app,
                observer,
                agent_id,
                nudge_gate::AFFIRMATIVE_KEY,
                false,
            )),
            Action::Nudge { n } => {
                let text = nudge_ladder::nudge_text(*n, entry.state.silent_secs());
                // Bracketed paste, so a multi-line-aware TUI takes the body as one paste rather
                // than interpreting it line by line.
                Some(deliver(
                    app,
                    observer,
                    agent_id,
                    &format!("\x1b[200~{text}\x1b[201~"),
                    true,
                ))
            }
        };

        if let Some(outcome) = &outcome {
            // The STATE update is what the flag is built from, so it lives in its own testable
            // function rather than inline in this match — an earlier version wired it here and the
            // only test called the setter directly, so deleting the wiring left every test green.
            record_outcome(&mut entry.state, &decision.action, outcome);
            match outcome {
                Ok(Delivery::Submitted) => tracing::info!(
                    target: "nudger",
                    agent = %agent_id,
                    rung = decision.rung,
                    action = action_name(&decision.action),
                    silent_secs = entry.state.silent_secs(),
                    "nudger wrote"
                ),
                // Reported as its OWN action, never as a write: the text is on the prompt but
                // unsent, so logging "nudger wrote" would put a delivery in the record that never
                // happened.
                Ok(Delivery::Withheld) => tracing::warn!(
                    target: "nudger",
                    agent = %agent_id,
                    rung = decision.rung,
                    action = "nudge-withheld",
                    silent_secs = entry.state.silent_secs(),
                    "nudger left its text on the prompt unsent (another writer interleaved)"
                ),
                Err(e) => tracing::warn!(
                    target: "nudger", agent = %agent_id, error = %e, "nudger write failed"
                ),
            }
        }

        if let Some(flags) = app.try_state::<NudgeFlags>() {
            if let Some(flag) = apply_flags(&flags, agent_id, &decision, &entry.state) {
                tracing::warn!(
                    target: "nudger",
                    agent = %agent_id,
                    escalate = flag.target.as_str(),
                    nudges = flag.nudges,
                    silent_secs = flag.silent_secs,
                    "nudger escalated: agent has not moved after repeated nudges"
                );
                let _ = app.emit("nudger://escalation", &flag);
            }
        }
    }
}

/// Fold one delivery outcome back into the agent's state.
///
/// EVERY arm must land somewhere the flag can see, because the flag is what the pusher acts on. A
/// permitted write that did not land leaves `last_blocked = None` from the ladder, so an arm that
/// only logs produces `nudges: 6, delivered: 0, blocked_by: null` — which by `NudgeFlag::blocked_by`'s
/// own contract says "we could never write to this agent", the one thing that is definitely not
/// true. The three cases are genuinely different problems for the consumer:
///
///   * submitted  — it received the nudge and ignored it.
///   * withheld   — the text is on its prompt, one bare Enter from resolving.
///   * write error— its PTY is gone or erroring; nudging harder will never work.
///
/// Free function rather than inline in `tick` so it is assertable: `tick` needs an `AppHandle` and
/// therefore has no test, which is exactly how the previous wiring shipped uncovered.
fn record_outcome(state: &mut AgentState, action: &Action, outcome: &Result<Delivery, String>) {
    match outcome {
        Ok(Delivery::Submitted) => {
            // Count only what actually went out. `attempts` (which drives escalation) is the
            // ladder's; this is the honest denominator for "does nudging work".
            if matches!(action, Action::Nudge { .. }) {
                state.record_delivered();
            }
        }
        Ok(Delivery::Withheld) => state.record_blocked("cr-withheld"),
        Err(_) => state.record_blocked("write-failed"),
    }
}

/// Retire flags whose agent's terminal is GONE — dropping the machine-consumed ones, and KEEPING
/// the ones a human still owes an answer to.
///
/// `spin_down` and a natural exit both detach the observer, but neither touched `NudgeFlags` — so a
/// "stuck for 15m" row could outlive the session it described and have the pusher chase a terminal
/// that no longer exists. Split out of `tick` so it is assertable without an `AppHandle`.
///
/// A DEAD-TERMINAL ROW IS DROPPED, whatever its target. Keeping founder rows and marking them
/// `terminal_gone` was tried and removed (knightwatch, PR #1353): NOTHING read the mark. The
/// TypeScript `NudgeFlag` never mirrored the field and the Pusher does not consume nudger flags at
/// all, so the retained row reached no surface — it bought an extra state, an unbounded table (a
/// detached agent is never ticked again, so only an explicit `nudger_clear_flag` could remove it)
/// and its own tests, in exchange for the owed action still being invisible. Deleting it is the
/// honest answer: this module cannot be the thing that remembers an ask across a dead PTY, and
/// pretending otherwise hid the gap instead of recording it.
fn sweep_dead_flags(flags: &NudgeFlags, live_ids: &std::collections::HashSet<&str>) {
    for id in flags.agent_ids() {
        if !live_ids.contains(id.as_str()) {
            flags.clear(&id);
        }
    }
}

/// Turn one observer plus its roster status into the ladder's `Observation`.
///
/// Split out of `tick` so the REFUSALS are assertable. An earlier test here only exercised the
/// parked-reader setter and getter, which is a precondition, not a side effect — breaking `tick`'s
/// use of it left that test green. This is the seam where "the reader is parked" actually becomes
/// "do not write".
fn observe(
    observer: &PtyObserver,
    status: &str,
    goal_met: bool,
    rollup_dot: Option<&'static str>,
    stage: Option<&'static str>,
    now: u64,
    elapsed_secs: Option<u64>,
) -> Observation {
    let hash = observer.hash_with_status(status);
    let (text, alternate) = observer.render();
    // A parked reader means this screen is NOT being updated, so it may be arbitrarily out of date.
    // Treat it as unreadable rather than as clean — the same fail-closed verdict `write_refusal`
    // gives a screen it cannot see, which is exactly the condition this is.
    // A parked reader means this grid stopped advancing, so NOTHING read off it is current —
    // including the spinner `screen_is_working` looks for. The ladder has to know that, or a frozen
    // "working" claim suppresses escalation forever. See `nudge_ladder::step`.
    let screen_readable = !observer.reader_is_parked();
    let refusal = if !screen_readable {
        Some("reader-parked")
    } else {
        nudge_gate::write_refusal(Some(&Screen {
            text: &text,
            alternate,
        }))
        .map(|r| r.as_str())
    };
    Observation {
        hash,
        elapsed_secs,
        // Either signal saying "working" stands us down. The screen is authoritative and
        // WebView-independent; the roster is the corroborating veto that can go stale.
        working: status == "working" || nudge_gate::screen_is_working(&text),
        refusal,
        screen_readable,
        prompt_has_text: nudge_gate::prompt_line_has_text(&text),
        since_other_write_ms: observer.since_foreign_write_ms(now),
        foreign_write_ms: observer.last_foreign_write_ms.load(Ordering::Relaxed),
        goal_met,
        // THE ANSWER TO THE QUESTION WE ASKED. Read off the same rendered grid the safety gate uses,
        // so it needs neither the frontend nor a model — the two things this module cannot depend
        // on. A parked reader makes the grid stale, and a stale screen must never be read as fresh
        // consent to go quiet, so an unreadable screen yields no reply at all.
        reply: if screen_readable {
            nudge_ladder::parse_reply(&text)
        } else {
            None
        },
        // MAY WE ANSWER THIS PROMPT OURSELVES? The verdict is re-derived here, on the nudger
        // thread, from the grid this module owns -- never taken from the WebView, for the same
        // reason `nudger_send_escape` re-derives its own: a wedged WebView's last opinion is
        // exactly the stale evidence that would press a button nobody read. An unreadable screen
        // is never answerable.
        rollup_dot,
        stage,
        answerable: screen_readable
            && nudge_gate::answer_refusal(Some(&Screen {
                text: &text,
                alternate,
            }))
            .is_none(),
    }
}

/// What actually reached the terminal.
///
/// A withheld carriage return used to return plain `Ok(())`, so the one INFO-level record of the
/// event said "nudger wrote" when nothing had been submitted — in a module whose header calls
/// instrumentation non-optional precisely so "does nudging actually work" is answerable by counts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    /// The body was written and, where asked for, submitted.
    Submitted,
    /// The body is on the prompt but the carriage return was withheld — another writer landed
    /// inside the paste window. A later rung-4-6 bare Enter is what resolves this.
    Withheld,
}

/// The gap between a bracketed paste and the carriage return that submits it.
///
/// NOT an arbitrary sleep, and not something to remove as an optimisation. `pty.ts`'s
/// `deliverSubmit` waits exactly this long between the two writes, and the reason is recorded in
/// this repo the hard way: a paste and a CR delivered as ONE write reach the TUI before it has
/// finished processing the paste, so the text lands on the prompt and the submit is silently LOST.
/// That is the same shape as sparkle-bhhu1 — an agent left holding a message it never sent — which
/// is the failure this whole module exists to clear, so reproducing it here would be self-defeating.
const SUBMIT_CR_DELAY: Duration = Duration::from_millis(60);

/// Write to an agent's terminal, optionally following it with the submitting carriage return.
///
/// ── THE INTERLEAVE CHECK ──────────────────────────────────────────────────────────────────────
/// `pty_write`'s stamp stops the nudger from typing INTO somebody else's paste→CR window. This is
/// the mirror: for the 60ms our own window is open, a JS write can land inside it, because
/// `chainPtyOp` serializes JS writers against each other and knows nothing about this thread. So
/// before sending the CR we re-read the stamp, and if anything wrote in between we DO NOT SUBMIT.
///
/// Not submitting is the graceful failure. The nudge text is left sitting on the prompt, unsent —
/// which is precisely the state a later rung-4-6 bare Enter is built to resolve. The alternative,
/// submitting anyway, would concatenate our text with whatever the other writer was mid-way through
/// sending and enter the result as one prompt.
fn deliver<R: Runtime>(
    app: &AppHandle<R>,
    observer: &PtyObserver,
    agent_id: &str,
    body: &str,
    submit: bool,
) -> Result<Delivery, String> {
    deliver_with(observer, agent_id, body, submit, |data| {
        crate::pty::write_session(app, agent_id, data)
    })
}

/// `deliver` with the PTY write injected, so the decision NOT to submit is assertable.
///
/// Split out for exactly one reason: the interesting behaviour here is a write that does NOT
/// happen, and "the carriage return was withheld" cannot be observed through a real `AppHandle` in
/// a unit test. With the writer as a parameter the test records what was actually sent.
fn deliver_with<W: FnMut(&str) -> Result<(), String>>(
    observer: &PtyObserver,
    agent_id: &str,
    body: &str,
    submit: bool,
    mut write: W,
) -> Result<Delivery, String> {
    let before = observer.last_foreign_write_ms.load(Ordering::Relaxed);
    write(body)?;
    if !submit {
        return Ok(Delivery::Submitted);
    }
    std::thread::sleep(SUBMIT_CR_DELAY);
    if observer.last_foreign_write_ms.load(Ordering::Relaxed) != before {
        tracing::warn!(
            target: "nudger",
            agent = %agent_id,
            "another writer landed inside the paste window; leaving the nudge unsent on the prompt \
             rather than submitting a concatenated line"
        );
        return Ok(Delivery::Withheld);
    }
    write("\r")?;
    Ok(Delivery::Submitted)
}

/// Apply one tick's flag effects, and return a flag that was newly ESCALATED (so the caller can
/// emit its event).
///
/// Takes `&NudgeFlags` rather than an `AppHandle` so both halves — the raise AND the clear-on-
/// recovery — are testable without standing up a Tauri app.
///
/// ── THE ROW'S EXISTENCE AND ITS ESCALATION ARE DIFFERENT QUESTIONS ───────────────────────────
/// This used to read `let target = decision.escalate?;` ABOVE the only `flags.raise`, which tied
/// the two together and lost the row. `escalate` is `Some` only on the tick a target RISES, and
/// escalation is a high-water mark whose top is `Founder` — so once the founder has been flagged,
/// `escalate` is `None` for the rest of the episode, and the episode only ends when the agent
/// produces OUTPUT. `nudger_clear_flag` lets a consumer drop a row "once it has acted on it", and
/// acting does not always unstick the agent (`authRecovery`'s resume can fail — that is what its
/// `progressed` field is for). Compose the two and an agent stuck on a question the founder must
/// answer was silently absent from `nudger_flags()` for the rest of its life, with nothing to
/// report that it had been dropped. That is a row needing action hidden by the surface whose whole
/// job is to raise it.
///
/// So the raise is UNCONDITIONAL on every flagging look — the shape `conflict_watch::apply_flags`
/// already has — and `escalate` decides only what the caller emits.
fn apply_flags(
    flags: &NudgeFlags,
    agent_id: &str,
    decision: &nudge_ladder::Decision,
    state: &AgentState,
) -> Option<NudgeFlag> {
    // An agent that MOVED has resolved its own episode, so any flag raised for it is no longer
    // true. Leaving it up would have the pusher chase an agent that is already working again — and
    // a channel that reports resolved problems stops being read.
    //
    // …UNLESS THE LOOK IS STILL A FLAGGING ONE (roborev 60369, Medium). `hash_changed` stopped
    // meaning "new episode" once a stand-down could survive a reset: an agent that answered
    // `blocked-on-human` and then repainted still carries `flagged`, but the unconditional clear
    // dropped its row and the rebuild below then found no previous row to carry `raised_at_ms` from,
    // so the age restarted at "now" on every repaint. A founder could not tell an agent waiting one
    // minute from one waiting six hours — exactly what roborev 57873 fixed for `conflict_watch`.
    // Clearing only when the look raises NO flag keeps the recovery case (a moving, unflagged agent
    // loses its row) while an ongoing ask keeps its age.
    if decision.hash_changed && decision.flagged.is_none() {
        flags.clear(agent_id);
    }
    let target = decision.flagged?;
    // Carry the ORIGINAL raise time across the refresh, the same correction `conflict_watch` took
    // (roborev 57873): a row whose age restarted every look would tell a reader the agent has been
    // stuck for ten minutes when it has been stuck for six hours.
    //
    // WHICH LOOKS END AN EPISODE, restated because the rule above changed under it (roborev 60386):
    // a FLAGGING look never clears, `hash_changed` or not, so an agent still asking for a person
    // keeps its original timestamp through any number of repaints. Only a NON-flagging
    // `hash_changed` look ends the episode — and that one returns before reaching here — so the
    // next flagging look after it finds nothing to carry and correctly stamps fresh. A row a
    // consumer cleared behaves the same way, for the same reason: nothing left to carry.
    let flag = build_flag(agent_id, target, state, flags.get(agent_id));
    flags.raise(flag.clone());
    decision.escalate.map(|_| flag)
}

/// Build the row for one flagging look. Shared by the per-look refresh and the between-looks
/// repair so the two cannot drift into disagreeing about what a founder-level row says.
fn build_flag(
    agent_id: &str,
    target: nudge_ladder::Escalation,
    state: &AgentState,
    previous: Option<NudgeFlag>,
) -> NudgeFlag {
    NudgeFlag {
        agent_id: agent_id.to_string(),
        target: target.as_str().to_string(),
        raised_at_ms: previous.map(|f| f.raised_at_ms).unwrap_or_else(now_ms),
        nudges: state.attempts(),
        delivered: state.delivered(),
        blocked_by: state.last_blocked().map(str::to_string),
        silent_secs: state.silent_secs(),
        reply: state.last_reply().map(|r| r.as_str().to_string()),
        // Live by construction: this is only built while the agent is still being ticked, which
        // requires a live observer. `sweep_dead_flags` is the one place that sets it.
    }
}

/// Put back a FOUNDER-level row a consumer cleared, without waiting out the current rung.
///
/// ── WHY THE PER-LOOK REFRESH IS NOT ENOUGH ON ITS OWN ────────────────────────────────────────
/// `apply_flags` only runs when an agent is DUE for a look, and the ladder's last rung is 600s. So
/// with the refresh alone, a founder-level row cleared just after a look is invisible for up to ten
/// minutes (plus the consumer's own 30s poll) while the agent is still wedged. Ten minutes is not
/// hours — `conflict_watch`'s equivalent gap is its 7200s rung — but the rule it violates is
/// absolute: a row the founder owes is never hidden, and "for a bounded while" is still hidden.
///
/// This runs on the 1s tick instead, so the window is one tick. It is deliberately NARROW:
///
///   * FOUNDER ONLY. A concierge row is consumed by machinery, which is exactly the consumer that
///     benefits from `nudger_clear_flag` being able to suppress a row it just handled; it keeps its
///     rung-long quiet period. The founder's row is the one the P0 rule is about.
///   * ONLY WHEN THE ROW IS ABSENT. A present row is left alone — refreshing counters every second
///     would rewrite the table 600 times per rung for no new information.
///   * NO EVENT. `nudger://escalation` means a target rose; a restored row did not escalate. The
///     pull (`nudger_flags`) is the channel — the module header is explicit that the event is "an
///     optimisation on top, not the channel" — so the consumer picks this up on its next poll.
///
/// Nothing here can loop forever: the episode reset clears `escalated`, so an agent that produces

fn action_name(action: &Action) -> &'static str {
    match action {
        Action::Observe => "observe",
        Action::Answer => "answer",
        Action::Enter => "enter",
        Action::Nudge { .. } => "nudge",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nudge_gate::{self, Refusal};

    fn observer() -> PtyObserver {
        PtyObserver::new(DEFAULT_COLS, DEFAULT_ROWS)
    }

    /// A SLOW ITERATION IS NOT A SUSPEND, and this is the pair that pins the difference.
    ///
    /// The wall clock alone cannot tell them apart, and reading it alone was wrong in the expensive
    /// direction: `tick` sleeps `SUBMIT_CR_DELAY` per submitted nudge and renders a grid per due
    /// agent, while deadlines are aligned by construction — so a fleet-sized burst pushes one
    /// iteration past the threshold on an awake machine. That is not a harmless false positive.
    /// The loop skips every due look and `rebaseline_after_suspend` rewrites the WHOLE roster,
    /// discarding elapsed credit for agents that were never frozen and collapsing a 1800s
    /// stand-down schedule to 5s — and a consistently slow tick does it forever.
    #[test]
    fn a_slow_tick_is_not_charged_as_a_suspend_but_a_freeze_is() {
        let mut clock = LoopClock::new(1_000, 1_000);

        // An ordinary iteration: one second of sleep, both clocks agree.
        assert_eq!(clock.suspended_ms(2_000, 2_000), 0, "an ordinary iteration is not a suspend");

        // THE REGRESSION CASE. Eight seconds of real work — well past SUSPEND_OVERSHOOT_MS — with
        // the machine awake throughout, so the monotonic clock advanced just as far.
        let slow = clock.suspended_ms(10_000, 10_000);
        assert_eq!(slow, 0, "a slow tick advances BOTH clocks, so none of it is frozen time");
        assert!(
            slow <= SUSPEND_OVERSHOOT_MS,
            "…and so it must never trip the detector (got {slow}ms)"
        );

        // A real six-hour sleep: the wall clock ran, the monotonic clock did not.
        let frozen = clock.suspended_ms(10_000 + 6 * 60 * 60 * 1_000, 11_000);
        assert_eq!(frozen, 6 * 60 * 60 * 1_000 - 1_000, "the frozen span is wall minus monotonic");
        assert!(frozen > SUSPEND_OVERSHOOT_MS, "and it must trip the detector");
    }

    /// The freeze this whole line of work started from: one that begins INSIDE the `tick` body.
    ///
    /// It is invisible to anything that measures only the sleep, and it is the shape that let a
    /// post-resume look credit the entire frozen span as elapsed. Charging the whole iteration
    /// catches it wherever it began — and, unlike the wall-clock-only form, without also charging
    /// an iteration that was merely slow.
    #[test]
    fn a_freeze_that_begins_inside_the_tick_body_is_still_charged() {
        let mut clock = LoopClock::new(0, 0);
        // The sleep was ordinary (1s); the freeze happened afterwards, while `tick` was running.
        // Both facts arrive together at the NEXT sample, which is the point of carrying the clock.
        let frozen = clock.suspended_ms(3_600_000, 1_000);
        assert_eq!(frozen, 3_599_000);
        assert!(frozen > SUSPEND_OVERSHOOT_MS, "a freeze inside the tick body must still be seen");
    }

    /// A forward `SystemTime` step is caught for free — `now_ms` is not monotonic, and a clock that
    /// jumps forward is not time the agent spent silent.
    #[test]
    fn a_forward_wall_clock_step_is_not_credited_as_elapsed() {
        let mut clock = LoopClock::new(1_000, 1_000);
        let stepped = clock.suspended_ms(61_000, 2_000);
        assert_eq!(stepped, 59_000, "the step is wall clock the monotonic clock never saw");
        assert!(stepped > SUSPEND_OVERSHOOT_MS, "so it rebaselines rather than being credited");
    }

    /// A SUSPEND IS NOT ELAPSED TIME — and the deadline is only half of saying so.
    ///
    /// The loop pushes every `due_at_ms` out on a detected freeze so a suspend is not read as eight
    /// rungs of stall. `last_look_ms` has to move with it, because the ladder is handed
    /// `now - last_look_ms` as the wall clock a look represents: leaving it stale charges the entire
    /// frozen span — six hours here — to an agent that was not running for any of it. The unlanded
    /// clock's whole budget is thirty minutes, so that ONE post-resume look would carry a perfectly
    /// healthy agent from zero across the threshold and raise a flag, which is precisely the
    /// misreading the deadline push exists to prevent.
    #[test]
    fn a_suspend_rebaselines_the_look_clock_as_well_as_the_deadline() {
        let woke = 6 * 60 * 60 * 1000;
        let mut tracked: HashMap<String, Tracked> = HashMap::new();
        tracked.insert(
            "agent-1".to_string(),
            Tracked {
                state: AgentState::default(),
                due_at_ms: 1_000,
                last_look_ms: 0,
            },
        );

        rebaseline_after_suspend(&mut tracked, woke);

        let t = &tracked["agent-1"];
        assert_eq!(
            t.due_at_ms,
            woke + nudge_ladder::LADDER_SECS[0] * 1000,
            "the deadline still moves"
        );

        // THE SIDE EFFECT THAT MATTERS: what the very next look reports as its own duration, read
        // exactly the way `tick` computes it.
        let next_look = woke + 5_000;
        let elapsed_secs = next_look.saturating_sub(t.last_look_ms) / 1000;
        assert_eq!(
            elapsed_secs, 5,
            "the first look after a resume represents five seconds, not the whole sleep"
        );
    }

    // ══ THE DETECTOR, OVER A FAKE PTY ═══════════════════════════════════════════════════════════

    /// The whole signal: a PTY that keeps emitting keeps changing its hash; one that stops does
    /// not. No content interpretation is involved in either direction.
    #[test]
    fn a_pty_that_stops_emitting_stops_changing_its_hash() {
        let o = observer();
        o.ingest("working on it\r\n");
        let h1 = o.hash_with_status("idle");

        o.ingest("still working\r\n");
        let h2 = o.hash_with_status("idle");
        assert_ne!(h1, h2, "new output must change the hash");

        // ...and now it dies. Every later look sees the same hash, which is what climbs the ladder.
        let h3 = o.hash_with_status("idle");
        let h4 = o.hash_with_status("idle");
        assert_eq!(h2, h3);
        assert_eq!(h3, h4);
    }

    /// "hash the last 4KB of PTY output PLUS current status" — the status is part of the window, so
    /// an agent whose status flips while its output is frozen still reads as progress.
    #[test]
    fn the_status_is_part_of_the_hash() {
        let o = observer();
        o.ingest("frozen output");
        assert_ne!(
            o.hash_with_status("working"),
            o.hash_with_status("errored"),
            "a status change alone must register as a change"
        );
    }

    #[test]
    fn only_the_last_four_kilobytes_are_hashed() {
        let a = observer();
        let b = observer();
        // Identical recent output, different ancient history. Beyond the window they must agree —
        // otherwise a long-running agent could never produce two equal hashes and would never be
        // seen as stalled at all.
        a.ingest(&"a".repeat(10_000));
        b.ingest(&"b".repeat(10_000));
        let recent = "x".repeat(TAIL_BYTES);
        a.ingest(&recent);
        b.ingest(&recent);
        assert_eq!(a.hash_with_status("idle"), b.hash_with_status("idle"));
    }

    #[test]
    fn the_tail_is_bounded_however_much_arrives() {
        let o = observer();
        for _ in 0..50 {
            o.ingest(&"y".repeat(1000));
        }
        let len = o.tail.lock().unwrap().len();
        assert_eq!(len, TAIL_BYTES, "the tail must not grow without bound");
    }

    /// A single write larger than the window, and a stream of small ones, must leave the same tail —
    /// the two branches of `ingest` are easy to make disagree.
    #[test]
    fn chunking_does_not_change_the_tail() {
        let one_shot = observer();
        let dribbled = observer();
        let payload: String = (0..6000)
            .map(|i| char::from(b'a' + (i % 26) as u8))
            .collect();
        one_shot.ingest(&payload);
        for chunk in payload.as_bytes().chunks(97) {
            dribbled.ingest(std::str::from_utf8(chunk).unwrap());
        }
        assert_eq!(
            one_shot.hash_with_status("idle"),
            dribbled.hash_with_status("idle")
        );
    }

    // ══ THE RENDERED SCREEN ═════════════════════════════════════════════════════════════════════

    /// The reason Rust needed its own VT emulator at all: the gate must read a rendered picture,
    /// and the raw byte stream is not one. Here a cursor-addressed redraw — output that would look
    /// like nonsense as bytes — resolves into the screen the gate then refuses.
    #[test]
    fn escape_sequences_resolve_into_a_screen_the_gate_can_read() {
        let o = observer();
        o.ingest("\x1b[2J\x1b[H");
        o.ingest("Do you want to proceed?\r\n");
        o.ingest("\x1b[1;32m❯ 1. Yes\x1b[0m\r\n");
        o.ingest("  2. No\r\n");

        let (text, alternate) = o.render();
        assert!(!alternate);
        assert!(
            text.contains("❯ 1. Yes"),
            "rendered screen should carry the option, got: {text:?}"
        );
        assert!(
            !text.contains("\x1b["),
            "escape sequences must be APPLIED, not retained"
        );
        assert_eq!(
            nudge_gate::write_refusal(Some(&nudge_gate::Screen {
                text: &text,
                alternate
            })),
            Some(Refusal::AwaitingInput),
            "a live picker must be refused"
        );
    }

    /// The alternate-screen flag, derived from the byte stream rather than from the WebView. This
    /// is the guard that keeps `vim`/`less`/`htop` from ever being typed into, and before this
    /// module it existed only in xterm.js.
    #[test]
    fn the_alternate_screen_flag_comes_from_the_bytes() {
        let o = observer();
        assert!(!o.render().1, "a fresh session is on the normal buffer");

        // DECSET 1049 — what vim/less/htop send on entry.
        o.ingest("\x1b[?1049h");
        o.ingest("~\r\n~\r\n\"src/main.rs\" 3L, 42B");
        let (text, alternate) = o.render();
        assert!(alternate, "1049h must flip the flag");
        assert_eq!(
            nudge_gate::write_refusal(Some(&nudge_gate::Screen {
                text: &text,
                alternate
            })),
            Some(Refusal::AlternateScreen),
            "a full-screen app must never be written into"
        );

        // ...and leaving it restores a writable screen, so the guard is not a one-way latch.
        o.ingest("\x1b[?1049l");
        assert!(!o.render().1, "1049l must clear the flag");
    }

    #[test]
    fn a_running_turn_is_visible_in_the_rendered_screen() {
        let o = observer();
        o.ingest("\x1b[2J\x1b[H✻ Churning… (1m 24s · esc to interrupt)");
        let (text, _) = o.render();
        assert!(
            nudge_gate::screen_is_working(&text),
            "the spinner must be readable without asking the frontend, got: {text:?}"
        );
    }

    /// The founder's own observation, as a regression: an agent sitting on one shell command for
    /// 1m 24s is WORKING, and the module must be able to tell that from the screen alone — because
    /// the roster's `working` can be stale exactly when it matters.
    #[test]
    fn a_long_silent_but_working_agent_is_never_written_to() {
        let o = observer();
        o.ingest("\x1b[2J\x1b[H⏺ Running tests…\r\n\r\n✻ Churning… (1m 24s · esc to interrupt)");
        let (text, alternate) = o.render();
        assert_eq!(
            nudge_gate::write_refusal(Some(&nudge_gate::Screen {
                text: &text,
                alternate
            })),
            Some(Refusal::Working)
        );
    }

    // ══ THE FOREIGN-WRITE STAMP ═════════════════════════════════════════════════════════════════

    #[test]
    fn an_untouched_session_reports_no_foreign_write() {
        let o = observer();
        assert_eq!(
            o.since_foreign_write_ms(now_ms()),
            u64::MAX,
            "never written to must read as infinitely long ago, not as just now"
        );
    }

    #[test]
    fn a_foreign_write_is_stamped_and_ages() {
        let o = observer();
        o.note_foreign_write();
        let now = now_ms();
        assert!(
            o.since_foreign_write_ms(now) < 1_000,
            "a fresh write must read as recent"
        );
        assert!(
            o.since_foreign_write_ms(now + 60_000) >= 60_000,
            "and must age out so the nudger is not muted forever"
        );
    }

    // ══ THE REGISTRY ════════════════════════════════════════════════════════════════════════════

    #[test]
    fn detaching_a_session_stops_it_being_observed() {
        let obs = Observers::default();
        let handle = obs.attach("agent-1", 120, 40);
        handle.ingest("hello");
        assert!(obs.get("agent-1").is_some());
        assert_eq!(obs.all().len(), 1);

        obs.detach("agent-1");
        assert!(
            obs.get("agent-1").is_none(),
            "a dead session must not keep climbing the ladder"
        );
        assert!(obs.all().is_empty());
    }

    /// The grid MIRRORS the child's geometry, on both paths. Claude Code redraws with ABSOLUTE
    /// cursor addressing, so a grid of different dimensions than the child believes it has puts
    /// content on the wrong rows and renders a garbled screen.
    #[test]
    fn the_grid_mirrors_the_childs_geometry_on_attach_and_resize() {
        let obs = Observers::default();
        let handle = obs.attach("agent-1", 40, 10);
        let size = |h: &PtyObserver| h.screen.lock().unwrap().screen().size();
        assert_eq!(
            size(&handle),
            (10, 40),
            "attach must mirror the pane, not floor it"
        );

        // The frontend resizes on mount, so this is the path production actually uses — an earlier
        // version applied its geometry rule only on attach, which made that rule (and its test)
        // void within moments of startup.
        handle.resize(90, 30);
        assert_eq!(size(&handle), (30, 90), "resize must mirror too");
    }

    #[test]
    fn a_session_with_no_reported_geometry_falls_back() {
        let obs = Observers::default();
        let handle = obs.attach("agent-1", 0, 0);
        assert_eq!(
            handle.screen.lock().unwrap().screen().size(),
            (DEFAULT_ROWS, DEFAULT_COLS)
        );
    }

    /// A PROPERTY OF vt100 THAT THE GATE DEPENDS ON, pinned because it is invisible and load-bearing.
    ///
    /// `contents()` REJOINS hard-wrapped continuation rows into one logical line. That is the
    /// opposite of xterm's `translateToString`, which returns one string per BUFFER line and so
    /// splits a long prompt across rows — the width-dependent miss that forced
    /// `dictationTerminalRoute.ts` to grow its wrap-tolerant `screenTail` arm (a credential prompt's
    /// word landing on one row and its colon on the next, defeating every `…:\s*$` pattern).
    ///
    /// Because vt100 rejoins, that failure mode does NOT arise on this side at whatever width the
    /// user has dragged the pane to. If a future vt100 changed this, the gate's credential patterns
    /// would silently start missing, so it is asserted rather than assumed.
    #[test]
    fn the_rendered_screen_rejoins_hard_wrapped_lines() {
        let obs = Observers::default();
        // A credential prompt far longer than the grid is wide.
        let handle = obs.attach("agent-1", 30, 10);
        handle.ingest("Enter the password for someone@example.com at my.1password.com:");
        let (text, alternate) = handle.render();

        assert!(
            text.lines()
                .any(|l| l.contains("password") && l.trim_end().ends_with(':')),
            "the word and its colon must survive on ONE logical line, got: {text:?}"
        );
        assert_eq!(
            nudge_gate::write_refusal(Some(&nudge_gate::Screen {
                text: &text,
                alternate
            })),
            Some(Refusal::CredentialPrompt),
            "a wrapped credential prompt must still be refused at a narrow width"
        );
    }

    /// THE FAIL-OPEN, pinned on the REFUSAL rather than on the flag.
    ///
    /// While the reader is parked on its backpressure gates the observer is fed nothing, so its
    /// screen may be minutes stale — and a wedged WebView stops acking, which is exactly what
    /// latches that park. So the very outage this module exists to survive is the one that would
    /// blind it, and a stale screen showing a clean prompt could be typed into while the live one
    /// shows a picker.
    #[test]
    fn a_parked_reader_refuses_the_write_because_its_screen_is_stale() {
        let o = observer();
        // A screen that is unambiguously SAFE to write to, so the only thing under test is the park.
        o.ingest("\x1b[2J\x1b[H────────────────────────\r\n❯\u{a0}\r\n────────────────────────");
        assert_eq!(
            observe(&o, "idle", false, None, None, now_ms(), None).refusal,
            None,
            "precondition: screen permits"
        );

        o.set_reader_parked(true);
        assert_eq!(
            observe(&o, "idle", false, None, None, now_ms(), None).refusal,
            Some("reader-parked"),
            "a screen that is not being updated must be refused, not trusted"
        );

        // ...and it must clear, or one burst of backpressure mutes the nudger for the session.
        o.set_reader_parked(false);
        assert_eq!(observe(&o, "idle", false, None, None, now_ms(), None).refusal, None);
    }

    /// END TO END, the wedged-mid-turn case: a spinner frozen on a parked reader's grid must not
    /// look like a healthy working agent to the ladder.
    ///
    /// This is the join `observe()` exists to make, and it is where the bug lived — the observer
    /// reported `working: true` (correctly, from what it could see) and the ladder trusted it,
    /// because nothing told the ladder the screen was months stale.
    #[test]
    fn a_spinner_frozen_by_a_parked_reader_still_escalates() {
        let o = observer();
        // The agent was mid-turn when the WebView wedged: spinner up, "esc to interrupt" on screen.
        o.ingest("\x1b[2J\x1b[H✻ Churning… (1m 24s · esc to interrupt)");
        o.set_reader_parked(true);

        let obs = observe(&o, "working", false, None, None, now_ms(), None);
        assert!(obs.working, "the frozen screen and the stale roster both still say working");
        assert!(!obs.screen_readable, "but nothing read off that grid is current");

        let mut state = AgentState::default();
        let decisions: Vec<_> = (0..20).map(|_| nudge_ladder::step(&mut state, &obs)).collect();
        assert!(
            decisions.iter().all(|d| !matches!(d.action, Action::Enter | Action::Nudge { .. })),
            "still never write into a screen we cannot see"
        );
        assert!(
            decisions.iter().any(|d| d.escalate.is_some()),
            "but a human MUST be told — this is the likeliest way into the wedged state"
        );
    }

    /// The other half of the same seam: the roster and the SCREEN are independent working vetoes,
    /// and the screen is the one that still works when the frontend has stopped publishing.
    #[test]
    fn either_the_roster_or_the_screen_can_veto_as_working() {
        let idle = observer();
        idle.ingest("\x1b[2J\x1b[H────────────────────────\r\n❯\u{a0}\r\n────────────────────────");
        assert!(!observe(&idle, "idle", false, None, None, now_ms(), None).working);
        assert!(observe(&idle, "working", false, None, None, now_ms(), None).working, "roster veto");

        let spinning = observer();
        spinning.ingest("\x1b[2J\x1b[H✻ Churning… (1m 24s · esc to interrupt)");
        assert!(
            observe(&spinning, "", false, None, None, now_ms(), None).working,
            "screen veto, with the roster saying nothing at all — the wedged-WebView case"
        );
    }

    // ══ THE ESCAPE WRITE — THE ONLY MACHINE KEYSTROKE AT A BILLING DIALOG ═══════════════════════
    //
    // The labels are assembled at runtime rather than written contiguously, for the same reason the
    // `nudge_gate` suite does it: a test file is a file agents `cat`, diff and review, and a whole
    // label sitting here would stream a live trigger through the reading agent's own classifier.

    /// Feed an observer the real session-limit picker so `escape_refusal` permits the write.
    fn picker_observer() -> PtyObserver {
        let o = observer();
        o.ingest(&format!(
            "What do you want to do?\r\n❯ 1. {}\r\n  2. {}\r\n  3. {}\r\n{}\r\n",
            ["Stop and wait for", "limit to", "reset"].join(" "),
            ["Switch to", "usage", "credits"].join(" "),
            ["Switch to", "Team", "plan"].join(" "),
            "Enter to confirm · Esc to cancel",
        ));
        o
    }

    /// Record what `send_escape_with` actually put on the PTY.
    fn escape_writes(o: &PtyObserver, now: u64) -> (Result<(), String>, Vec<String>) {
        let sent = Mutex::new(Vec::new());
        let r = send_escape_with(o, now, |data| {
            sent.lock().unwrap().push(data.to_string());
            Ok(())
        });
        (r, sent.into_inner().unwrap())
    }

    /// EXACTLY ONE BYTE, AND IT IS `ESC`. Written to fail if the body were ever swapped for
    /// `deliver_with(…, submit = true)`: that sends a paste AND a carriage return, and the CR
    /// confirms whichever billing option the cursor sits on — paid overage, or a plan change.
    #[test]
    fn the_escape_write_is_one_esc_and_nothing_else() {
        let o = picker_observer();
        let (r, sent) = escape_writes(&o, u64::MAX / 2);
        assert!(r.is_ok(), "the picker must permit the write: {r:?}");
        assert_eq!(sent, vec![nudge_gate::ESCAPE_KEY.to_string()]);
        assert_eq!(sent[0].len(), 1, "one byte — no chorded or suffixed key");
        assert!(
            !sent[0].contains('\r') && !sent[0].chars().any(|c| c.is_ascii_digit()),
            "a CR confirms an option and a digit selects one"
        );
    }

    /// A PARKED READER means the grid stopped advancing, so nothing read off it is current.
    #[test]
    fn a_parked_reader_writes_nothing() {
        let o = picker_observer();
        o.set_reader_parked(true);
        let (r, sent) = escape_writes(&o, u64::MAX / 2);
        assert!(r.is_err());
        assert!(sent.is_empty(), "nothing may reach the PTY on a refusal");
    }

    /// THE FOREIGN-WRITE STAND-DOWN. The founder is at this picker deciding between "Stop and wait"
    /// and a billing option, presses ↓ — and a recovery attempt must NOT cancel the dialog out from
    /// under them. Every other machine write in this crate already respects this window.
    #[test]
    fn a_recent_write_by_someone_else_stands_the_escape_down() {
        let o = picker_observer();
        o.note_foreign_write();
        // `note_foreign_write` stamps `now_ms()`, so read the clock the same way the command does.
        let (r, sent) = escape_writes(&o, now_ms());
        assert!(r.is_err(), "a human mid-interaction outranks the machine");
        assert!(sent.is_empty());
        // …and once the window has passed, the same screen is writable again.
        let (r2, sent2) = escape_writes(&o, now_ms() + nudge_ladder::QUIET_AFTER_OTHER_WRITE_MS);
        assert!(r2.is_ok(), "{r2:?}");
        assert_eq!(sent2, vec![nudge_gate::ESCAPE_KEY.to_string()]);
    }

    /// AN ORDINARY PICKER EARNS NOTHING. This is the case where a laxer gate would have a machine
    /// cancel a tool approval a human was mid-answer on.
    #[test]
    fn an_ordinary_picker_is_never_escaped() {
        let o = observer();
        o.ingest("Do you want to proceed?\r\n  1. Yes\r\n❯ 2. No\r\n Esc to cancel · Tab to amend · ctrl+e to explain\r\n");
        let (r, sent) = escape_writes(&o, u64::MAX / 2);
        assert!(r.is_err(), "an ordinary approval dialog must be refused");
        assert!(sent.is_empty());
    }

    // ══ DELIVERY: THE PASTE AND ITS CARRIAGE RETURN ═════════════════════════════════════════════

    use std::sync::atomic::AtomicUsize;

    /// A recording writer. Returns the writes that actually reached the PTY.
    fn record(
        observer: &PtyObserver,
        body: &str,
        submit: bool,
        interlope_after: Option<usize>,
    ) -> (Vec<String>, Delivery) {
        let sent = Mutex::new(Vec::new());
        let calls = AtomicUsize::new(0);
        let r = deliver_with(observer, "agent-1", body, submit, |data| {
            sent.lock().unwrap().push(data.to_string());
            let n = calls.fetch_add(1, Ordering::SeqCst);
            // Simulate another writer landing on this PTY right after our Nth write — the 60ms
            // window during which `chainPtyOp` cannot protect us.
            if interlope_after == Some(n) {
                observer.note_foreign_write();
            }
            Ok(())
        });
        (sent.into_inner().unwrap(), r.expect("delivery must not error"))
    }

    /// A paste and its CR must be TWO writes. Delivered as one, the CR reaches the TUI before it has
    /// finished processing the paste and the submit is silently lost — the exact sparkle-bhhu1 shape
    /// this module exists to clear.
    #[test]
    fn a_nudge_is_pasted_and_then_submitted_separately() {
        let o = observer();
        let (sent, outcome) = record(&o, "\x1b[200~hello\x1b[201~", true, None);
        assert_eq!(
            sent.len(),
            2,
            "paste and CR must not be coalesced into one write"
        );
        assert_eq!(sent[0], "\x1b[200~hello\x1b[201~");
        assert_eq!(sent[1], "\r", "the CR is what submits it");
        assert_eq!(outcome, Delivery::Submitted);
    }

    #[test]
    fn a_bare_enter_is_a_single_write_with_no_paste_framing() {
        let o = observer();
        let (sent, outcome) = record(&o, "\r", false, None);
        assert_eq!(
            sent,
            vec!["\r".to_string()],
            "nothing to paste — just submit what is there"
        );
        assert_eq!(outcome, Delivery::Submitted);
    }

    /// THE INTERLEAVE CHECK. If another writer lands inside our 60ms window, submitting would enter
    /// our text concatenated with whatever they were mid-way through sending. Leaving it unsent is
    /// the graceful failure: a later rung-4-6 bare Enter is exactly the thing that resolves it.
    #[test]
    fn the_carriage_return_is_withheld_if_another_writer_interleaves() {
        let o = observer();
        let (sent, outcome) = record(&o, "\x1b[200~hello\x1b[201~", true, Some(0));
        assert_eq!(sent.len(), 1, "the CR must NOT be sent: {sent:?}");
        assert_eq!(
            sent[0], "\x1b[200~hello\x1b[201~",
            "the text is still left on the prompt"
        );
        // The OUTCOME must say so too. Returning a plain Ok here is what let the caller log
        // "nudger wrote" for a nudge that was never submitted — a delivery in the record that never
        // happened, in a module whose header calls instrumentation non-optional.
        assert_eq!(outcome, Delivery::Withheld);
    }

    // ══ THE FLAGS ═══════════════════════════════════════════════════════════════════════════════

    #[test]
    fn flags_are_one_per_agent_and_clearable() {
        let flags = NudgeFlags::default();
        assert!(flags.list().is_empty());

        let mk = |target: &str, at: u64| NudgeFlag {
            agent_id: "agent-1".into(),
            target: target.into(),
            raised_at_ms: at,
            nudges: 3,
            delivered: 3,
            blocked_by: None,
            silent_secs: 900,
            reply: None,
            };
        flags.raise(mk("concierge", 1));
        flags.raise(mk("founder", 2));
        let listed = flags.list();
        assert_eq!(listed.len(), 1, "one row per agent, not a stream");
        assert_eq!(
            listed[0].target, "founder",
            "the later flag supersedes the earlier"
        );

        flags.clear("agent-1");
        assert!(
            flags.list().is_empty(),
            "the consumer must be able to drop a flag it acted on"
        );
    }

    /// A look that both SITS AT `flagged` and newly escalated to it — the tick a threshold is
    /// crossed. Every later look of the same episode is `refresh` below.
    fn decision(
        escalate: Option<nudge_ladder::Escalation>,
        hash_changed: bool,
    ) -> nudge_ladder::Decision {
        look(escalate, escalate, hash_changed)
    }

    /// A later look at a level already reached: still a flagging look, nothing NEW escalated. This
    /// is every tick of a wedged agent after its first founder flag, and the shape the raise used
    /// to return early on.
    fn refresh(flagged: nudge_ladder::Escalation) -> nudge_ladder::Decision {
        look(Some(flagged), None, false)
    }

    fn look(
        flagged: Option<nudge_ladder::Escalation>,
        escalate: Option<nudge_ladder::Escalation>,
        hash_changed: bool,
    ) -> nudge_ladder::Decision {
        nudge_ladder::Decision {
            action: Action::Observe,
            escalate,
            flagged,
            rung: 8,
            hash_changed,
            refusal: None,
            next_look_secs: 600,
        }
    }

    /// A MACHINE-CONSUMED flag must not outlive the terminal it describes: the concierge has
    /// nothing to do about an agent whose PTY is gone, so chasing it is pure noise.
    #[test]
    fn a_concierge_flag_is_dropped_when_its_terminal_is_gone() {
        let flags = NudgeFlags::default();
        for id in ["alive", "gone"] {
            apply_flags(
                &flags,
                id,
                &decision(Some(nudge_ladder::Escalation::Concierge), false),
                &AgentState::default(),
            );
        }
        assert_eq!(flags.list().len(), 2, "precondition: both flagged");

        let live: std::collections::HashSet<&str> = ["alive"].into_iter().collect();
        sweep_dead_flags(&flags, &live);

        let remaining: Vec<String> = flags.list().into_iter().map(|f| f.agent_id).collect();
        assert_eq!(
            remaining,
            vec!["alive".to_string()],
            "the dead session's flag must go; the live one must stay"
        );
    }

    /// ...and that is true of a FOUNDER row too. Keeping those and marking them `terminal_gone` was
    /// removed because nothing read the mark (knightwatch, PR #1353): no TypeScript mirror, no
    /// Pusher consumer. A retained row reached no surface, could only be removed by an explicit
    /// clear (nothing ticks a detached agent), and so grew without bound. One rule for every target
    /// is the smaller thing that behaves the same where it counts.
    #[test]
    fn a_dead_terminal_drops_a_founder_row_too() {
        let flags = NudgeFlags::default();
        apply_flags(
            &flags,
            "gone",
            &decision(Some(nudge_ladder::Escalation::Founder), false),
            &AgentState::default(),
        );
        assert_eq!(flags.list().len(), 1, "precondition: flagged at founder level");

        sweep_dead_flags(&flags, &std::collections::HashSet::new());

        assert!(flags.list().is_empty(), "a dead PTY takes its row with it, whatever the target");
    }


    // ══ THE TICK ITSELF ═════════════════════════════════════════════════════════════════════════

    /// Drive the real `tick` against a mock Tauri app.
    ///
    /// `tick` is otherwise the ONE function here with no coverage — it needs an `AppHandle` — and it
    /// is where the outcome→state wiring lives, which is why that wiring shipped deletable with
    /// every test still green (roborev 57738). A mock app costs nothing and closes it.
    #[test]
    fn tick_records_a_failed_write_on_the_state_and_escalates() {
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        handle.manage(Observers::default());
        handle.manage(NudgeFlags::default());

        // An observer with a clean, writable screen — so the GATE permits and the only thing that
        // can stop the write is the PTY itself, which does not exist here. That is exactly the
        // production case of a child that exited between the sweep and the write.
        let observer = handle.state::<Observers>().attach("agent-1", 120, 40);
        observer.ingest(
            "\x1b[2J\x1b[H────────────────────────\r\n❯\u{a0}\r\n────────────────────────",
        );

        let mut tracked: HashMap<String, Tracked> = HashMap::new();
        // Walk the ladder far enough to cross the founder threshold. Each call is one "look"; the
        // due-time is advanced by hand so the test does not wait out 600-second rungs.
        let mut now = now_ms();
        for _ in 0..20 {
            tick(&handle, &mut tracked, now);
            now = tracked.get("agent-1").map(|t| t.due_at_ms).unwrap_or(now);
        }

        let state = &tracked.get("agent-1").expect("agent tracked").state;
        assert!(state.attempts() >= 6, "should have climbed to the escalation rungs");
        assert_eq!(state.delivered(), 0, "no write can have succeeded — there is no PTY");
        assert_eq!(
            state.last_blocked(),
            Some("write-failed"),
            "the failed write must be recorded on the state, not merely logged"
        );

        let flags = handle.state::<NudgeFlags>().list();
        assert_eq!(flags.len(), 1, "a stuck agent raises exactly one flag row");
        assert_eq!(flags[0].target, "founder");
        assert_eq!(
            flags[0].blocked_by.as_deref(),
            Some("write-failed"),
            "and the pusher must be told WHY, not handed a null that reads as 'never writable'"
        );
    }

    /// Set up a mock app with one silent, writable agent and walk it through `n` ordinary looks,
    /// each arriving EXACTLY on its deadline. Returns the tracked map and the time of the last look.
    fn ticked_agent<R: tauri::Runtime>(
        handle: &AppHandle<R>,
        n: usize,
    ) -> (HashMap<String, Tracked>, u64) {
        let observer = handle.state::<Observers>().attach("agent-1", 120, 40);
        observer.ingest(
            "\x1b[2J\x1b[H────────────────────────\r\n❯\u{a0}\r\n────────────────────────",
        );
        let mut tracked: HashMap<String, Tracked> = HashMap::new();
        let mut now = now_ms();
        for _ in 0..n {
            tick(handle, &mut tracked, now);
            now = tracked["agent-1"].due_at_ms;
        }
        (tracked, now)
    }

    /// THE WIRING LINE, DRIVEN THROUGH `tick` ITSELF — without this the fix is deletable with the
    /// whole suite green (roborev 64284).
    ///
    /// `Observation::elapsed_secs` is an `Option` whose `None` arm restores the pre-fix,
    /// schedule-derived behaviour, and every ladder test injects the value directly. The two
    /// existing `tick`-driving tests advance `now` to EXACTLY `due_at_ms`, so measured elapsed and
    /// the schedule fallback produce identical numbers and no assertion can tell them apart. This
    /// one makes the look arrive LATE, which is the only shape that separates the two arms.
    #[test]
    fn tick_hands_the_ladder_the_gap_that_passed_not_the_one_it_scheduled() {
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        handle.manage(Observers::default());
        handle.manage(NudgeFlags::default());

        let (mut tracked, _) = ticked_agent(&handle, 3);
        let before = tracked["agent-1"].state.silent_secs();
        let due = tracked["agent-1"].due_at_ms;
        let scheduled_secs = (due - tracked["agent-1"].last_look_ms) / 1000;

        // Four seconds late — inside the detector's slack, so nothing is capped away.
        tick(&handle, &mut tracked, due + 4_000);
        let credited = tracked["agent-1"].state.silent_secs() - before;

        assert_eq!(
            credited,
            scheduled_secs + 4,
            "the clock must credit the wall time that PASSED"
        );
        assert_ne!(
            credited, scheduled_secs,
            "…and that is NOT what the schedule would have said — which is the whole point"
        );
    }

    /// …AND IT IS CAPPED, because a measurement is only as good as the clock behind it.
    ///
    /// The suspend detector can still miss a freeze in the instant between its own sampling and the
    /// look, and `now_ms` is `SystemTime`, so a forward wall-clock step is indistinguishable from
    /// time passing. Uncapped, either one dumps the whole gap into both clocks in ONE look — and
    /// the unlanded budget is only 1800s, so a single such look would take a healthy agent from
    /// zero to a concierge flag while also inflating the `silent_secs` on the founder's row.
    #[test]
    fn an_undetected_freeze_cannot_dump_hours_into_the_clocks() {
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        handle.manage(Observers::default());
        handle.manage(NudgeFlags::default());

        let (mut tracked, _) = ticked_agent(&handle, 3);
        let before = tracked["agent-1"].state.silent_secs();
        let last_look = tracked["agent-1"].last_look_ms;
        let scheduled_secs = (tracked["agent-1"].due_at_ms - last_look) / 1000;

        // Six hours, with the detector none the wiser.
        tick(&handle, &mut tracked, last_look + 6 * 60 * 60 * 1000);
        let credited = tracked["agent-1"].state.silent_secs() - before;

        assert!(
            credited <= scheduled_secs + SUSPEND_OVERSHOOT_MS / 1000,
            "a look may never credit more than one scheduled interval plus the detector's slack \
             (scheduled {scheduled_secs}s, credited {credited}s)"
        );
        assert!(
            credited < 1800,
            "…so one look can never cross UNLANDED_STALL_SECS on its own (credited {credited}s)"
        );
    }

    /// THE CLEARED FLAG THAT NEVER CAME BACK — the founder's rule is "never hide a row that needs
    /// action from me", and this is that row vanishing from the surface whose whole job is to raise it.
    ///
    /// `nudger_clear_flag` lets a consumer drop a row "once it has acted on it", and acting does not
    /// always unstick the agent (`authRecovery`'s resume can fail; its own `progressed` field exists
    /// because it can). Escalation is a HIGH-WATER MARK, so once the founder level is reached
    /// `decision.escalate` is `None` for the rest of the episode, and the episode only ends when the
    /// agent produces OUTPUT — exactly what a wedged agent never does. With the raise sitting below
    /// an early return on `escalate`, the row's EXISTENCE depended on the escalation RISING, so an
    /// agent stuck on a question the founder must answer was silently absent from `nudger_flags()`
    /// for the rest of its life, with nothing to report that it had been dropped.
    ///
    /// Asserted on what `nudger_flags()` RETURNS — `flags.list()` is that command's whole body —
    /// rather than on any internal escalation field.
    #[test]
    fn a_cleared_founder_flag_is_re_raised_while_the_agent_is_still_wedged() {
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        handle.manage(Observers::default());
        handle.manage(NudgeFlags::default());

        // A clean, writable screen, so the only thing keeping this agent silent is that it emits
        // nothing — the ladder climbs on the absence of output, not on a refusal.
        let observer = handle.state::<Observers>().attach("agent-1", 120, 40);
        observer.ingest(
            "\x1b[2J\x1b[H────────────────────────\r\n❯\u{a0}\r\n────────────────────────",
        );

        let mut tracked: HashMap<String, Tracked> = HashMap::new();
        let mut now = now_ms();
        // Each call is one "look"; the due-time is advanced by hand so the test does not wait out
        // 600-second rungs.
        let mut looks = |tracked: &mut HashMap<String, Tracked>, n: usize, now: &mut u64| {
            for _ in 0..n {
                tick(&handle, tracked, *now);
                *now = tracked.get("agent-1").map(|t| t.due_at_ms).unwrap_or(*now);
            }
        };

        looks(&mut tracked, 20, &mut now);
        let flags = handle.state::<NudgeFlags>();
        assert_eq!(flags.list().len(), 1, "precondition: the founder was flagged");
        assert_eq!(flags.list()[0].target, "founder");

        // The consumer acts on the row and drops it — `authRecovery`'s `clearNudgeFlag` path.
        flags.clear("agent-1");
        assert!(
            flags.list().is_empty(),
            "precondition: the consumer's clear took effect"
        );

        // ...and whatever it did DID NOT WORK. The agent still emits nothing, so nothing ends the
        // episode and nothing higher than `founder` is left to escalate to.
        looks(&mut tracked, 3, &mut now);

        let listed = flags.list();
        assert_eq!(
            listed.len(),
            1,
            "a still-wedged agent must not stay absent from nudger_flags() for the rest of its life"
        );
        assert_eq!(listed[0].target, "founder");
        assert!(
            listed[0].silent_secs > 0,
            "and the re-raised row must carry the agent's real silence, not a blank"
        );
    }


    // ══ OUTCOME → STATE → FLAG ══════════════════════════════════════════════════════════════════
    // The chain the pusher actually reads. Asserted end to end, because the previous version wired
    // this inline in `tick` (which has no test, needing an AppHandle) and its only test called the
    // setter directly and asserted the setter had set the field — so deleting the wiring left every
    // test green.

    /// Every arm must land somewhere the FLAG can see. `blocked_by: null` with a high `nudges` is a
    /// specific claim — "we could never write to this agent" — and it must only be made when true.
    #[test]
    fn every_delivery_outcome_reaches_the_flag_distinguishably() {
        let cases: [(Result<Delivery, String>, Option<&str>, u32); 3] = [
            // Submitted: it got the nudge and ignored us. No block reason, and it counts.
            (Ok(Delivery::Submitted), None, 1),
            // Withheld: the text is on its prompt, one bare Enter from resolving.
            (Ok(Delivery::Withheld), Some("cr-withheld"), 0),
            // Errored: its PTY is gone or erroring — nudging harder will never work.
            (Err("no such pty".to_string()), Some("write-failed"), 0),
        ];

        for (outcome, expected_block, expected_delivered) in cases {
            let mut state = AgentState::default();
            // Climb to a nudge rung so the ladder has counted an attempt, exactly as `tick` would.
            let stalled = nudge_ladder::Observation {
                elapsed_secs: None,
                hash: 1,
                working: false,
                refusal: None,
                screen_readable: true,
                prompt_has_text: false,
                since_other_write_ms: u64::MAX,
                foreign_write_ms: 0,
                goal_met: false,
                reply: None,
                answerable: false,
                rollup_dot: None,
                stage: None,
            };
            for _ in 0..7 {
                nudge_ladder::step(&mut state, &stalled);
            }
            assert_eq!(state.attempts(), 1, "precondition: one attempt counted");

            record_outcome(&mut state, &Action::Nudge { n: 1 }, &outcome);
            assert_eq!(state.delivered(), expected_delivered, "delivered for {outcome:?}");

            // ...and out the far end: the FLAG the pusher consumes must carry it.
            let flags = NudgeFlags::default();
            let flag = apply_flags(
                &flags,
                "agent-1",
                &decision(Some(nudge_ladder::Escalation::Concierge), false),
                &state,
            )
            .expect("escalating tick raises a flag");
            assert_eq!(
                flag.blocked_by.as_deref(),
                expected_block,
                "the flag must distinguish {outcome:?} from an unreachable screen"
            );
            assert_eq!(flag.delivered, expected_delivered);
        }
    }

    /// A bare Enter is not a nudge, so it must not move the nudge-delivery counter.
    #[test]
    fn a_bare_enter_is_not_counted_as_a_delivered_nudge() {
        let mut state = AgentState::default();
        record_outcome(&mut state, &Action::Enter, &Ok(Delivery::Submitted));
        assert_eq!(state.delivered(), 0);
    }

    #[test]
    fn an_escalating_tick_raises_the_flag_the_pusher_reads() {
        let flags = NudgeFlags::default();
        let raised = apply_flags(
            &flags,
            "agent-1",
            &decision(Some(nudge_ladder::Escalation::Concierge), false),
            &AgentState::default(),
        );
        assert!(
            raised.is_some(),
            "the caller needs the flag back so it can emit the event"
        );
        assert_eq!(flags.list().len(), 1);
        assert_eq!(flags.list()[0].target, "concierge");
    }

    /// A REPAINT IS NOT A NEW EPISODE — the `apply_flags` half of roborev 60369, which shipped with
    /// NO test of its own (roborev 60386): no existing case passed `hash_changed: true` together
    /// with `flagged: Some(..)`, so deleting the guard left this whole suite green while the
    /// founder-visible symptom — a still-flagging row's age restarting at "now" on every repaint —
    /// was protected by nothing.
    ///
    /// Paired with the recovery case below it, so the two together pin the CAUSE (the look is still
    /// flagging) rather than merely asserting an absence.
    #[test]
    fn a_repaint_of_a_still_flagging_agent_keeps_its_row_and_its_age() {
        let flags = NudgeFlags::default();
        let state = wedged_state(20);
        apply_flags(
            &flags,
            "agent-1",
            &decision(Some(nudge_ladder::Escalation::Founder), false),
            &state,
        );
        let first_raised = flags.list()[0].raised_at_ms;

        // Same reason as `a_refreshed_row_keeps_the_age_it_was_first_raised_with`: without waiting
        // past the clock's resolution a restamping implementation produces an IDENTICAL number and
        // the assertion passes while proving nothing.
        std::thread::sleep(std::time::Duration::from_millis(5));

        // The agent repaints — hash moved — but it is STILL asking for a person.
        apply_flags(
            &flags,
            "agent-1",
            &look(Some(nudge_ladder::Escalation::Founder), None, true),
            &state,
        );
        let rows = flags.list();
        assert_eq!(rows.len(), 1, "a flagging look must never drop the row it is raising");
        assert_eq!(
            rows[0].raised_at_ms, first_raised,
            "and the row must keep the age it was first raised with, or a six-hour wait reads as new"
        );
    }

    /// An agent that MOVED has resolved its own episode, so the flag is no longer true. Leaving it
    /// up has the pusher chase an agent that is already working again — and a channel that reports
    /// resolved problems stops being read.
    ///
    /// The paired opposite of the repaint test above: same `hash_changed: true`, but this look
    /// raises NO flag, which is what makes the clear correct here and wrong there.
    #[test]
    fn output_from_a_flagged_agent_clears_its_flag() {
        let flags = NudgeFlags::default();
        apply_flags(
            &flags,
            "agent-1",
            &decision(Some(nudge_ladder::Escalation::Founder), false),
            &AgentState::default(),
        );
        assert_eq!(flags.list().len(), 1, "precondition: flagged");

        let raised = apply_flags(
            &flags,
            "agent-1",
            &decision(None, true),
            &AgentState::default(),
        );
        assert!(raised.is_none());
        assert!(
            flags.list().is_empty(),
            "the agent moved; the flag must not outlive its truth"
        );
    }

    /// An agent that has been silent for `looks` looks, driven through the REAL ladder so the
    /// escalation state under test is the one production reaches rather than a hand-set field.
    fn wedged_state(looks: usize) -> AgentState {
        let mut state = AgentState::default();
        let stalled = nudge_ladder::Observation {
            elapsed_secs: None,
            hash: 1,
            working: false,
            refusal: None,
            screen_readable: true,
            prompt_has_text: false,
            since_other_write_ms: u64::MAX,
            foreign_write_ms: 0,
            goal_met: false,
            reply: None,
            answerable: false,
            rollup_dot: None,
            stage: None,
        };
        for _ in 0..looks {
            nudge_ladder::step(&mut state, &stalled);
        }
        state
    }

    /// THE COUPLING NOTHING ELSE PINS (roborev 63230, Medium).
    ///
    /// `nudge_ladder` is deliberately dependency-free -- the gate verdict arrives as a `&str` -- so
    /// its `stalled_on_a_prompt` hand-copies two tokens out of `nudge_gate::Refusal::as_str()` with
    /// nothing but this test holding them together. Rename a variant's string and the ladder
    /// silently stops escalating parked agents: no compile error, no red test, and the failure mode
    /// is the exact silent inertness the parked-screen flag exists to remove. THIS module is
    /// where the guard belongs because it is the one that imports both.
    #[test]
    fn the_ladder_and_the_gate_agree_on_the_prompt_tokens() {
        for r in [nudge_gate::Refusal::AwaitingInput, nudge_gate::Refusal::CredentialPrompt] {
            assert!(
                nudge_ladder::stalled_on_a_prompt(r.as_str()),
                "{r:?} names a screen only a human can clear; the ladder must know its token"
            );
        }
        // …and the self-clearing ones must NOT be in the set, or every `less` session raises a row.
        for r in [
            nudge_gate::Refusal::AlternateScreen,
            nudge_gate::Refusal::NoViewport,
            nudge_gate::Refusal::Working,
        ] {
            assert!(
                !nudge_ladder::stalled_on_a_prompt(r.as_str()),
                "{r:?} can clear without a human and must not raise a row on sight"
            );
        }
    }

    /// RE-RAISED IS NOT RE-ESCALATED, and both halves matter.
    ///
    /// The row must come back on the next flagging look after a consumer clears it — otherwise a
    /// still-wedged agent is hidden. But the caller emits `nudger://escalation` from this return
    /// value, so returning `Some` on every look would turn one stuck agent into a stream of
    /// identical notices, which is how a signal stops being read. The high-water mark decides the
    /// EVENT; the flagging level decides the ROW.
    #[test]
    fn a_re_raised_row_is_not_a_second_escalation() {
        let flags = NudgeFlags::default();
        let state = wedged_state(20);

        let first = apply_flags(
            &flags,
            "agent-1",
            &decision(Some(nudge_ladder::Escalation::Founder), false),
            &state,
        );
        assert!(first.is_some(), "the crossing look escalates and returns the flag to emit");

        // The consumer acts and drops the row — and whatever it did did not work.
        flags.clear("agent-1");

        let again = apply_flags(
            &flags,
            "agent-1",
            &refresh(nudge_ladder::Escalation::Founder),
            &state,
        );
        assert!(
            again.is_none(),
            "nothing NEW escalated, so the caller must emit no second escalation event"
        );
        let listed = flags.list();
        assert_eq!(listed.len(), 1, "but the row the founder owes must be back");
        assert_eq!(listed[0].target, "founder");
        assert_eq!(
            listed[0].nudges,
            state.attempts(),
            "and it must carry the agent's real history, not a blank row"
        );
    }

    /// A refreshed row must not restart its own age: a consumer reading `raisedAtMs` would be told
    /// an agent stuck for six hours has been stuck for ten minutes, every ten minutes, forever.
    #[test]
    fn a_refreshed_row_keeps_the_age_it_was_first_raised_with() {
        let flags = NudgeFlags::default();
        let state = wedged_state(20);
        apply_flags(
            &flags,
            "agent-1",
            &decision(Some(nudge_ladder::Escalation::Founder), false),
            &state,
        );
        let first_raised = flags.list()[0].raised_at_ms;

        // THE SLEEP IS THE TEST. `build_flag` reads `raised_at_ms` from `previous` or else stamps
        // `now_ms()`, and both calls otherwise land inside the same millisecond — so a restamping
        // implementation produced an IDENTICAL number and this assertion passed while proving
        // nothing (knightwatch 5203281832#4). Waiting past the clock's resolution is what makes the
        // two branches distinguishable, and therefore what makes a regression able to redden this.
        std::thread::sleep(std::time::Duration::from_millis(5));

        apply_flags(&flags, "agent-1", &refresh(nudge_ladder::Escalation::Founder), &state);
        assert_eq!(
            flags.list()[0].raised_at_ms,
            first_raised,
            "a refresh is the same row, older — not a new row"
        );
        // ...and the wait really did cross a millisecond boundary, so the guard above cannot go
        // vacuous again if the clock or the sleep changes underneath it.
        assert!(
            now_ms() > first_raised,
            "precondition: the clock advanced, so a restamp would have been visible"
        );
    }

    // ══ THE BETWEEN-LOOKS REPAIR ════════════════════════════════════════════════════════════════




    #[test]
    fn an_ordinary_quiet_tick_neither_raises_nor_clears() {
        let flags = NudgeFlags::default();
        apply_flags(
            &flags,
            "agent-1",
            &decision(Some(nudge_ladder::Escalation::Concierge), false),
            &AgentState::default(),
        );
        apply_flags(
            &flags,
            "agent-1",
            &decision(None, false),
            &AgentState::default(),
        );
        assert_eq!(flags.list().len(), 1, "a still-stuck agent keeps its flag");
    }

    // ══ THE GOAL FACT AND THE AGENT'S ANSWER ════════════════════════════════════════════════════

    /// ONLY THE TWO FINISHED STATES READ AS DONE, and this is the one reading in the whole change
    /// that can silence an agent that still needs help — so every other state is asserted explicitly
    /// rather than left to a default. `expired` and `escalated` are the dangerous pair: both have
    /// `metAt` unset and both describe UNFINISHED work, so an implementation that tested "not unmet"
    /// would silence exactly the agents that most need a human.
    ///
    /// `discharged` is the second finished state, and it is asserted here because it was MISSING —
    /// a goal git proved landed read as live and the agent was nudged to resume it. The list is a
    /// value enumeration over a string, so nothing but this test can catch the next such addition.
    #[test]
    fn only_an_explicitly_finished_goal_reads_as_met() {
        assert!(goal_is_met(Some("met")));
        assert!(
            goal_is_met(Some("discharged")),
            "discharged is git's own proof the work landed — a stronger claim than the agent's own"
        );
        for live in ["unmet", "expired", "escalated", "none", "", "Met", "MET", "Discharged"] {
            assert!(!goal_is_met(Some(live)), "{live:?} is not a finished goal");
        }
        assert!(
            !goal_is_met(None),
            "a window that predates the field publishes nothing — absence is never done"
        );
    }

    /// AN UNOBSERVED AGENT KEEPS THE FULL LADDER. An agent missing from the roster has no goal fact
    /// at all, and a wedged WebView is one of the ways an agent goes missing — so if absence read as
    /// "met", the exact failure this module exists to survive would also switch it off.
    #[test]
    fn an_agent_absent_from_the_roster_is_not_treated_as_finished() {
        let statuses: HashMap<String, AgentFacts> = HashMap::new();
        let facts = statuses.get("ghost");
        assert!(!facts.is_some_and(|f: &AgentFacts| f.goal_met));
    }

    /// The founder-facing row must say WHY, in the agent's own words. `blocked_by` cannot answer
    /// this — it records why WE could not type, which on an agent that answered us is `None`, so a
    /// founder row for `blocked-on-human` would otherwise read as "quiet for a while, reason null".
    #[test]
    fn the_flag_carries_the_agents_own_answer() {
        let mut state = AgentState::default();
        let stalled = nudge_ladder::Observation {
            elapsed_secs: None,
            hash: 1,
            working: false,
            refusal: None,
            screen_readable: true,
            prompt_has_text: false,
            since_other_write_ms: u64::MAX,
            foreign_write_ms: 0,
            goal_met: false,
            reply: None,
            answerable: false,
            rollup_dot: None,
            stage: None,
        };
        for _ in 0..7 {
            nudge_ladder::step(&mut state, &stalled);
        }
        // It answers: a person is needed.
        let asking = nudge_ladder::Observation {
            elapsed_secs: None,
            hash: 2,
            reply: Some(nudge_ladder::Reply::Human),
            ..stalled
        };
        let decision = nudge_ladder::step(&mut state, &asking);
        assert_eq!(decision.flagged, Some(nudge_ladder::Escalation::Founder));

        let flags = NudgeFlags::default();
        apply_flags(&flags, "agent-1", &decision, &state);
        let row = flags.get("agent-1").expect("the ask must reach a human's surface");
        assert_eq!(row.reply.as_deref(), Some("blocked-on-human"));
        assert_eq!(row.target, "founder");
        assert_eq!(
            row.blocked_by, None,
            "and `blocked_by` is genuinely empty here — which is exactly why `reply` had to exist"
        );
    }
}
