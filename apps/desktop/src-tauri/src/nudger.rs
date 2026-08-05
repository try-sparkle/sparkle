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
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
fn status_map<R: Runtime>(app: &AppHandle<R>) -> HashMap<String, String> {
    let Some(state) = app.try_state::<crate::roster::RosterState>() else {
        return HashMap::new();
    };
    let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    crate::roster::merge(&guard)
        .into_iter()
        .flat_map(|p| p.agents)
        .map(|a| (a.id, a.status))
        .collect()
}

/// Start the nudger. Idempotent; safe to call more than once.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut tracked: HashMap<String, Tracked> = HashMap::new();
        loop {
            let before = now_ms();
            std::thread::sleep(TICK);
            let now = now_ms();
            let overshoot = now
                .saturating_sub(before)
                .saturating_sub(TICK.as_millis() as u64);
            if overshoot > SUSPEND_OVERSHOOT_MS {
                // We were frozen alongside everything else, so the silence means nothing. Push
                // every deadline out rather than reading a suspend as eight rungs of stall.
                for t in tracked.values_mut() {
                    t.due_at_ms = now.saturating_add(nudge_ladder::LADDER_SECS[0] * 1000);
                }
                tracing::debug!(target: "nudger", overshoot_ms = overshoot, "suspend detected; rebaselined");
                continue;
            }
            tick(&app, &mut tracked, now);
        }
    });
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
        });
        if now < entry.due_at_ms {
            continue;
        }

        // An agent ABSENT from the roster is UNOBSERVED, not idle: the roster is written by the
        // frontend and boots empty, so this is also what a wedged WebView looks like. Reading it as
        // an empty status is deliberate — it removes the roster's veto and leaves the decision to
        // the screen, which is the signal that still works in that case.
        let status_str = statuses.get(agent_id).map(String::as_str).unwrap_or("");
        let obs = observe(observer, status_str, now);

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
            "nudger tick"
        );

        let outcome = match &decision.action {
            Action::Observe => None,
            // Bracketed paste is NOT used for the bare Enter: there is nothing to paste, and the
            // whole point is to submit what the agent already typed.
            Action::Enter => Some(deliver(app, observer, agent_id, "\r", false)),
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

/// Drop flags whose agent's terminal is GONE.
///
/// `spin_down` and a natural exit both detach the observer, but neither touched `NudgeFlags` — so a
/// founder-level "stuck for 15m" row could outlive the session it described and have the pusher
/// chase a terminal that no longer exists. Split out of `tick` so it is assertable without an
/// `AppHandle`.
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
fn observe(observer: &PtyObserver, status: &str, now: u64) -> Observation {
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
        // Either signal saying "working" stands us down. The screen is authoritative and
        // WebView-independent; the roster is the corroborating veto that can go stale.
        working: status == "working" || nudge_gate::screen_is_working(&text),
        refusal,
        screen_readable,
        prompt_has_text: nudge_gate::prompt_line_has_text(&text),
        since_other_write_ms: observer.since_foreign_write_ms(now),
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

/// Apply one tick's flag effects, and return a flag that was newly raised (so the caller can emit
/// its event).
///
/// Takes `&NudgeFlags` rather than an `AppHandle` so both halves — the raise AND the clear-on-
/// recovery — are testable without standing up a Tauri app.
fn apply_flags(
    flags: &NudgeFlags,
    agent_id: &str,
    decision: &nudge_ladder::Decision,
    state: &AgentState,
) -> Option<NudgeFlag> {
    // An agent that MOVED has resolved its own episode, so any flag raised for it is no longer
    // true. Leaving it up would have the pusher chase an agent that is already working again — and
    // a channel that reports resolved problems stops being read.
    if decision.hash_changed {
        flags.clear(agent_id);
    }
    let target = decision.escalate?;
    let flag = NudgeFlag {
        agent_id: agent_id.to_string(),
        target: target.as_str().to_string(),
        raised_at_ms: now_ms(),
        nudges: state.attempts(),
        delivered: state.delivered(),
        blocked_by: state.last_blocked().map(str::to_string),
        silent_secs: state.silent_secs(),
    };
    flags.raise(flag.clone());
    Some(flag)
}

fn action_name(action: &Action) -> &'static str {
    match action {
        Action::Observe => "observe",
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
            observe(&o, "idle", now_ms()).refusal,
            None,
            "precondition: screen permits"
        );

        o.set_reader_parked(true);
        assert_eq!(
            observe(&o, "idle", now_ms()).refusal,
            Some("reader-parked"),
            "a screen that is not being updated must be refused, not trusted"
        );

        // ...and it must clear, or one burst of backpressure mutes the nudger for the session.
        o.set_reader_parked(false);
        assert_eq!(observe(&o, "idle", now_ms()).refusal, None);
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

        let obs = observe(&o, "working", now_ms());
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
        assert!(!observe(&idle, "idle", now_ms()).working);
        assert!(observe(&idle, "working", now_ms()).working, "roster veto");

        let spinning = observer();
        spinning.ingest("\x1b[2J\x1b[H✻ Churning… (1m 24s · esc to interrupt)");
        assert!(
            observe(&spinning, "", now_ms()).working,
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

    fn decision(
        escalate: Option<nudge_ladder::Escalation>,
        hash_changed: bool,
    ) -> nudge_ladder::Decision {
        nudge_ladder::Decision {
            action: Action::Observe,
            escalate,
            rung: 8,
            hash_changed,
            refusal: None,
            next_look_secs: 600,
        }
    }

    /// A flag must not outlive the terminal it describes.
    #[test]
    fn a_flag_is_dropped_when_its_terminal_is_gone() {
        let flags = NudgeFlags::default();
        for id in ["alive", "gone"] {
            apply_flags(
                &flags,
                id,
                &decision(Some(nudge_ladder::Escalation::Founder), false),
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
                hash: 1,
                working: false,
                refusal: None,
                screen_readable: true,
                prompt_has_text: false,
                since_other_write_ms: u64::MAX,
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

    /// An agent that MOVED has resolved its own episode, so the flag is no longer true. Leaving it
    /// up has the pusher chase an agent that is already working again — and a channel that reports
    /// resolved problems stops being read.
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
}
