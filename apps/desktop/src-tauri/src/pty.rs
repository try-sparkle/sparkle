//! Local PTY host (§2 Rust backend). Runs the user's OWN Claude Code (or any command)
//! in a pseudo-terminal on THEIR machine under THEIR login. Sparkle is a
//! terminal-emulator UI on top — it never reads or stores the auth token; the genuine
//! `claude` binary authenticates itself, exactly as in any terminal/IDE. This is the
//! ToS-compliant way to let people use their Claude Max subscription: local, real binary, no token extraction.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

struct PtySession {
    /// The child's stdin writer, behind its OWN lock so a (potentially blocking) `pty_write` locks
    /// only this session — never the global `sessions` map. A big paste into a stalled child would
    /// otherwise freeze spawn/write/resize/kill for EVERY terminal (sparkle-4orh). `MasterPty`'s
    /// writer is `!Clone`, so it lives here in an `Arc<Mutex<..>>` that `pty_write` clones out under
    /// a brief global-lock hold, then writes with only this handle locked.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Read-backpressure gate (): while paused, the reader thread stops read()ing the
    /// master so the kernel PTY buffer fills and the child's own write() blocks — end-to-end
    /// backpressure driven by the frontend's flow controller (see `pty_set_paused`).
    pause: Arc<PauseState>,
    /// IPC emit credit gate: bounds the bytes emitted-but-not-yet-acked by the frontend, so the
    /// (unbounded) Tauri IPC queue can't grow without limit. See `InflightState` / `pty_ack`.
    inflight: Arc<InflightState>,
    /// The child's pid, captured at spawn — the ROOT of the agent's process tree. The memory
    /// watchdog (`memwatch::agent_footprints`) walks descendants from here, because an agent is
    /// ~2 processes (peak 5), so watching this pid alone would undercount its RSS by about half.
    /// `None` when the platform did not report one; such a session is skipped rather than reported
    /// at zero, since "no pid" is not the same fact as "using no memory".
    pid: Option<u32>,
    /// WHICH LIFE OF THIS AGENT THIS PTY IS. Process-globally unique and minted per spawn (see
    /// [`next_pty_epoch`]), so the `pty:exit` this session eventually emits can be told apart from
    /// the one its PREDECESSOR emits — which is the whole point, because the session id is the
    /// AGENT id and is therefore identical across a restart.
    ///
    /// Without it, a restart is indistinguishable from a death at the frontend. `sessions.insert`
    /// replaces silently (see [`PtyManager::session_ids`]), so a re-spawn leaves the old reader
    /// thread alive and still owing one `pty:exit`. That event arrives AFTER the new binding has
    /// subscribed, on a global channel keyed only by agent id, and the new terminal reads it as its
    /// OWN death — painting "Agent exited — Start again" over an agent that was just successfully
    /// revived, where it sits until the resumed `claude` happens to emit a byte (a `--resume`
    /// transcript redraw takes seconds; an idle resumed agent may emit nothing for minutes).
    /// That is a death notice with no retraction path, and it is what this field closes.
    epoch: u64,
    /// The `CLAUDE_CONFIG_DIR` this PTY was launched under, decoded at spawn time out of the
    /// `zsh -c '<script>'` body by [`config_dir_from_args`] — i.e. WHICH CLAUDE MAX ACCOUNT this
    /// agent is running as.
    ///
    /// This is the ONLY place the Rust side learns that. Account selection happens entirely in
    /// TypeScript (`accountSelection.ts` → `claudeSpawn.ts`) and the roster slice
    /// (`roster.rs::RosterAgentSlice`) carries no account field, so a native-side flag — "this
    /// agent's screen says `Login expired · Please run /login`" — would otherwise have no way to
    /// tell the founder WHICH of several pinned config dirs to re-authenticate.
    ///
    /// THREE-STATE, deliberately — see [`SpawnAccount`]. `Default` (no export at all) and
    /// `Unknown` (an export we could not decode) are OPPOSITE answers to "which login should a
    /// human go fix", and collapsing them into one `None` is how a fail-closed refusal came out the
    /// far end as a confidently named wrong account (roborev 65537).
    config_dir: SpawnAccount,
}

/// "No PTY has spawned." Never minted by [`next_pty_epoch`] (which starts at 1), so it can never
/// collide with a real life — which is what makes it safe as a placeholder and as the answer
/// `live_epoch` gives for an id with no session.
const NO_EPOCH: u64 = 0;

/// Mint the next PTY epoch. Process-global and strictly increasing, so no two PTYs — for the same
/// agent or different ones, in this app run — ever share one. Starts at 1: [`NO_EPOCH`] is left free
/// as a "no PTY has spawned yet" sentinel for callers that need one.
///
/// CALL IT FROM [`PtyManager::insert_session`], not from the top of a spawn: the ORDER in which
/// epochs are minted only means something if it matches the order sessions land in the map.
fn next_pty_epoch() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// The literal `claudeSpawn.ts` writes into the spawn script when an account was chosen. Matched as
/// a whole, `export` included — and only at the very START of the arg, because the agent's own
/// prompt travels inside this same script string and can quote the identical line. See
/// [`find_config_dir_export`] for why anchoring rather than searching is what keeps a prompt from
/// naming a login the spawn never used.
const CONFIG_DIR_EXPORT: &str = "export CLAUDE_CONFIG_DIR=";

/// Which Claude Max account a spawn was launched under, decoded out of its raw spawn arguments.
///
/// WHY IT IS PARSED RATHER THAN PASSED. Account selection lives entirely in TypeScript
/// (`accountSelection.ts` → `claudeSpawn.ts`) and nothing hands the answer to Rust: the roster
/// slice carries no account field. But the fact already crosses the boundary, as text.
/// `buildClaudeExec` (and `buildClaudeLoginExec`) prepend
///
/// ```text
/// export CLAUDE_CONFIG_DIR='/Users/x/.claude-accounts/work'; export PATH="$HOME/.local/bin:$PATH"; exec …
/// ```
///
/// and that whole script arrives at `pty_spawn` as ONE entry in `args` — the `zsh -c '<script>'`
/// body. Reading it back here is what lets a native-side "login expired" flag NAME the login a
/// human has to re-authenticate, on a machine running several accounts pinned to separate dirs.
///
/// FAIL CLOSED. Every ambiguous input answers `None`, because this value ends up in front of the
/// founder as an account to go fix: naming the WRONG login is strictly worse than naming none. So
/// `None` for an absent export, an empty value, and — deliberately — an unterminated quote, where a
/// half-parsed path would be a plausible-looking string pointing at the wrong account.
///
/// THE FIRST OCCURRENCE DECIDES, INCLUDING WHEN IT FAILS TO PARSE. `zsh` itself would let a later
/// `export` win, but this app emits exactly one, so a second means something unexpected is going
/// on; we answer from the first and never search past it. Falling through to a later occurrence
/// would turn a malformed script into a confident wrong answer, which is the one outcome the
/// fail-closed rule above exists to prevent.
///
/// Quoting understood: single-quoted (including `shellQuote`'s `'\''` embedded-apostrophe escape,
/// decoded back to a literal `'`), double-quoted, and a bare word terminated by `;` or whitespace.
///
/// Pure and total — it runs on the spawn path and must never panic, whatever the frontend sends.
pub(crate) fn config_dir_from_args(args: &[String]) -> Option<String> {
    match spawn_account_from_args(args) {
        SpawnAccount::Dir(dir) => Some(dir),
        SpawnAccount::Default | SpawnAccount::Unknown => None,
    }
}

/// WHICH ACCOUNT a spawn was launched under — the THREE-STATE answer.
///
/// ── WHY `Option<String>` WAS NOT ENOUGH (roborev 65537, Medium) ───────────────────────────────
/// `config_dir_from_args` collapses two facts that must not be collapsed: "the script exported no
/// `CLAUDE_CONFIG_DIR`, so this is the imported DEFAULT account" and "there was an export and we
/// could not decode it, so we do not KNOW the account". Both came back `None`, and the consumer
/// (`nudger::account_label_from`) renders `None` as the default account BY NAME whenever one is
/// registered.
///
/// So every fail-closed refusal in this parser — an unterminated quote, an empty value, an export
/// that is not where we require it — arrived at the founder as a confident, named, WRONG login.
/// That is the precise harm the refusals exist to prevent, reintroduced one layer down. Anchoring
/// the match made it worse rather than better: it moved MORE inputs into the refusing branch, and
/// every one of them landed in "the default account" instead of "unknown".
///
/// `Unknown` is therefore a first-class answer, and the consumer must render it as "could not
/// identify", never as a login anybody should go re-authenticate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SpawnAccount {
    /// No `export CLAUDE_CONFIG_DIR=` anywhere in the prelude — the imported default account. An
    /// ordinary, POSITIVE answer.
    Default,
    /// An export was present and could not be decoded. The account is genuinely unknown; naming
    /// anything here would be a guess.
    Unknown,
    /// The decoded config dir.
    Dir(String),
}

/// Decode [`SpawnAccount`] out of raw spawn arguments. Pure and total.
pub(crate) fn spawn_account_from_args(args: &[String]) -> SpawnAccount {
    let Some((arg, at)) = args.iter().find_map(|a| find_config_dir_export(a).map(|i| (a, i)))
    else {
        return SpawnAccount::Default;
    };
    // `CONFIG_DIR_EXPORT` is pure ASCII, so `at + len` is always a char boundary.
    match decode_export_value(&arg[at + CONFIG_DIR_EXPORT.len()..]) {
        Some(dir) => SpawnAccount::Dir(dir),
        None => SpawnAccount::Unknown,
    }
}

/// Byte offset of `export CLAUDE_CONFIG_DIR=` when it is the very FIRST thing in `arg`, else `None`.
///
/// ── WHY IT IS ANCHORED AND NOT SEARCHED (roborev 65501, Medium) ───────────────────────────────
/// A scan for the literal anywhere in the arg is unsafe HERE in a way it would not be elsewhere,
/// because the agent's own PROMPT is inside this same string: `pty_spawn` receives one `zsh -c`
/// script whose tail embeds the persona and task text. So a task that merely QUOTES a shell line —
///
/// ```text
/// … run: export CLAUDE_CONFIG_DIR=/tmp/x && claude …
/// ```
///
/// is matched by any word-boundary rule, since inside the script it genuinely does start a word.
/// On the common single-account spawn (no real export at all) that prose is then the ONLY match,
/// and the founder's row would name `/tmp/x` as the login to go re-authenticate: a confidently
/// WRONG account, which is the exact outcome every other rule in this parser fails closed to avoid.
/// Being wrong here is worse than being silent, because a wrong name is acted on.
///
/// ── AND WHY THE BOUNDARY IS `exec `, NOT BYTE 0 (roborev 65537, Medium) ──────────────────────
/// A first fix required the export to be the very first thing in the script. That is TRUE of
/// `buildClaudeExec` and `buildClaudeLoginExec` today — but it made this parser's correctness rest
/// on a TypeScript ordering invariant that nothing pinned. Move `beadsReadonlyExport`, the inbox
/// export, or a future `cd …` ahead of the config export and BOTH suites stay green while the
/// account label silently dies — and, per [`SpawnAccount`], "dies" used to mean "names the default
/// account" rather than "says nothing". A cross-language invariant that only a comment enforces is
/// the seam shape `AGENTS.md` warns about.
///
/// So the dependency is removed rather than documented. The real structural fact is not *first* but
/// *before the command*: every producer emits `…exports…; exec <claude> … '<prompt>'`, and the
/// agent's prompt — the only adversarial text in the string — is an ARGUMENT to the exec'd command,
/// so it always lies after `exec`. Searching only the prelude is therefore immune to prompt text
/// AND indifferent to how the exports are ordered among themselves.
///
/// With no `exec ` in the arg there is no prelude to bound, so it falls back to requiring byte 0 —
/// the strict rule, applied only where the permissive one has nothing to anchor against.
fn find_config_dir_export(arg: &str) -> Option<usize> {
    let prelude_end = find_exec_word(arg).unwrap_or(0);
    if prelude_end == 0 {
        return arg.starts_with(CONFIG_DIR_EXPORT).then_some(0);
    }
    let bytes = arg.as_bytes();
    let mut from = 0usize;
    while let Some(rel) = arg[from..prelude_end].find(CONFIG_DIR_EXPORT) {
        let at = from + rel;
        // Still a shell WORD, so `noexport CLAUDE_CONFIG_DIR=…` is not a selection.
        let starts_word = at == 0
            || matches!(
                bytes[at - 1],
                b' ' | b'\t' | b'\n' | b'\r' | b';' | b'&' | b'|' | b'(' | b'{'
            );
        if starts_word {
            return Some(at);
        }
        // The needle is ASCII, so `at + 1` is a char boundary — safe to re-slice from.
        from = at + 1;
    }
    None
}

/// Byte offset of the first `exec` that stands as its own shell WORD, i.e. the start of the command
/// the prelude is setting up. `None` when the arg has none.
///
/// Word-bounded on BOTH sides so neither `noexec ` nor `execute ` is mistaken for it — a false
/// `exec` here would shrink the prelude and lose a real export, and a missed one would widen the
/// search region back over the prompt.
///
/// ── AND QUOTED TEXT IS SKIPPED, FOR THE SAME REASON THE WHOLE PARSER FAILS CLOSED ────────────
/// A bare `exec` inside a quoted VALUE (`export NOTE='foo exec bar'`) is not the command word — it
/// is data. Counting it would truncate the prelude before a real `CLAUDE_CONFIG_DIR` export, which
/// reports [`SpawnAccount::Default`]: a POSITIVE claim that this agent runs on the default account,
/// made on the strength of an export we simply failed to look at. That is the same
/// confident-wrong-login shape as rendering `Unknown` as the default, so it gets the same
/// treatment rather than a comment noting it is unlikely.
///
/// Quote tracking is deliberately shell-shaped and minimal: inside `'…'` nothing escapes (the
/// `'\''` idiom is *close, literal, reopen*, which this sees as two separate quoted runs — the
/// right reading), and inside `"…"` a backslash escapes the next character.
fn find_exec_word(arg: &str) -> Option<usize> {
    let bytes = arg.as_bytes();
    let is_sep = |c: u8| matches!(c, b' ' | b'\t' | b'\n' | b'\r' | b';' | b'&' | b'|' | b'(' | b'{');
    let mut i = 0usize;
    let mut quote: Option<u8> = None;
    while i < bytes.len() {
        let c = bytes[i];
        match quote {
            Some(q) => {
                if q == b'"' && c == b'\\' {
                    i += 2;
                    continue;
                }
                if c == q {
                    quote = None;
                }
            }
            None => {
                if c == b'\'' || c == b'"' {
                    quote = Some(c);
                } else if bytes[i..].starts_with(b"exec") {
                    let before_ok = i == 0 || is_sep(bytes[i - 1]);
                    let after_ok = bytes.get(i + 4).is_some_and(|c| is_sep(*c));
                    if before_ok && after_ok {
                        return Some(i);
                    }
                }
            }
        }
        i += 1;
    }
    None
}

/// Decode everything after the `=` of one `export CLAUDE_CONFIG_DIR=` into the literal path it
/// denotes. `None` on an empty or undecodable value (see [`config_dir_from_args`] on failing closed).
fn decode_export_value(rest: &str) -> Option<String> {
    let mut chars = rest.chars();
    let value = match chars.next() {
        Some('\'') => decode_single_quoted(chars.as_str())?,
        Some('"') => decode_double_quoted(chars.as_str())?,
        // Bare word: ends at the first `;` or whitespace, which also covers `export FOO=` with
        // nothing after it (an empty take_while → rejected as empty just below).
        _ => rest.chars().take_while(|c| *c != ';' && !c.is_whitespace()).collect(),
    };
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// Body of a single-quoted shell word (everything AFTER the opening `'`), decoded up to its closing
/// quote. Handles the one escape a single-quoted word can carry — `shellQuote`'s `'\''`, which is
/// *close quote, literal apostrophe, reopen quote* — by emitting a literal `'` and staying inside.
/// `None` when no closing quote is ever reached.
fn decode_single_quoted(body: &str) -> Option<String> {
    let mut out = String::new();
    let mut rest = body;
    loop {
        let i = rest.find('\'')?; // unterminated → fail closed
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        match after.strip_prefix("\\''") {
            // `'\''` — an embedded apostrophe; the word continues.
            Some(tail) => {
                out.push('\'');
                rest = tail;
            }
            // A plain `'` — the word ends here.
            None => return Some(out),
        }
    }
}

/// Body of a double-quoted shell word (everything AFTER the opening `"`), decoded up to its closing
/// quote. Inside double quotes a backslash escapes only `"`, `\`, `$` and a backtick; before anything
/// else it is an ordinary character and is kept. `None` when no closing quote is ever reached.
fn decode_double_quoted(body: &str) -> Option<String> {
    let mut out = String::new();
    let mut chars = body.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(out),
            '\\' => match chars.next() {
                Some(n @ ('"' | '\\' | '$' | '`')) => out.push(n),
                Some(n) => {
                    out.push('\\');
                    out.push(n);
                }
                // A trailing backslash — the word never closed.
                None => return None,
            },
            _ => out.push(c),
        }
    }
    None
}

/// Cooperative pause gate shared between a session's reader thread and `pty_set_paused`. The reader
/// parks on the condvar while `paused` is true (no busy-wait); `set(false)` wakes it. Poison-tolerant
/// like the rest of this module so a panic elsewhere can't wedge a reader forever.
struct PauseState {
    paused: Mutex<bool>,
    cvar: Condvar,
}

impl PauseState {
    fn new() -> Self {
        Self { paused: Mutex::new(false), cvar: Condvar::new() }
    }
    /// Block the calling (reader) thread while paused; returns immediately when not paused.
    fn wait_while_paused(&self) {
        let mut paused = self.paused.lock().unwrap_or_else(|e| e.into_inner());
        while *paused {
            paused = self.cvar.wait(paused).unwrap_or_else(|e| e.into_inner());
        }
    }
    /// Set the paused flag and wake the reader (a resume must unpark it; a pause notify is harmless).
    fn set(&self, value: bool) {
        let mut paused = self.paused.lock().unwrap_or_else(|e| e.into_inner());
        *paused = value;
        self.cvar.notify_all();
    }
}

// ── IPC emit credit gate ──────────────────────────────────────────────────────────────────────
//
// `PauseState` above is driven by the FRONTEND's view of its xterm parse backlog — but that view is
// structurally blind to the thing it was written to bound. `flow.onEnqueue` runs inside the
// `pty:output` handler, i.e. only AFTER the main thread has already dequeued and deserialized the
// IPC message. tao's event channel is a `crossbeam::channel::unbounded()`, so when the MAIN THREAD
// is the bottleneck, messages pile up in that queue while the frontend's `pending` counter stays
// low — the brake never engages, exactly when it is needed. And it could not help if it did:
// `pty_set_paused` is itself an `invoke`, so the pause command queues BEHIND the flood it is trying
// to stop.
//
// The fix is producer-side credit. Every emitted chunk CHARGES its byte count here; the frontend
// releases it with `pty_ack` once xterm has parsed the chunk. Past the high-water mark the flusher
// and the reader PARK — they never drop or truncate, because `pty:output` is a byte stream where
// loss or reordering corrupts the terminal (the same reason `PauseState` chose backpressure over
// truncation). Parking the reader stops read()ing the master, the kernel PTY buffer fills, and the
// child blocks on its own write(): genuine end-to-end backpressure.
//
// This also makes the existing pause machinery meaningful again — with the producer self-limited,
// the main thread is no longer starved, so a `pty_set_paused`/`pty_ack` invoke is serviced promptly
// instead of queueing behind megabytes of pending output.

/// Per-PTY ceiling on emitted-but-un-acked bytes.
///
/// Sizing: this is the AGGREGATE memory knob — worst case is (agents × this), and each byte is
/// amplified on the way through IPC because the payload is JSON-escaped (an ANSI 0x1B becomes the
/// 6-byte ``, and Claude Code's TUI is escape-dense). At 256 KiB, 20 concurrent agents cap
/// out around 5 MiB of un-acked chunk text — a few tens of MiB after escaping — versus the multi-GiB
/// footprint the unbounded queue produced. It is deliberately far BELOW the frontend's
/// `FLOW_HIGH_WATER_BYTES` (2 MiB per terminal, 40 MiB aggregate at 20 agents), because the IPC
/// queue is the more expensive place to hold bytes and the cheaper place to stop them.
///
/// Floor: it is 4 × `PTY_FLUSH_SIZE_THRESHOLD`, so ~4 max-size chunks stay in flight. At the 12 ms
/// flush interval that is ~21 MB/s of headroom — several times the ~5 MB/s a single PTY can produce
/// — so ordinary streaming never touches the gate and throughput is unaffected.
const PTY_INFLIGHT_HIGH_WATER_BYTES: usize = 256 * 1024;

/// How long a producer waits for acks before assuming the consumer is gone. Only a safety valve:
/// a live terminal acks within a frame, and terminal teardown kills the PTY (which `close()`s this
/// gate). Without it, a webview that died without killing its PTY would park the flusher forever.
const PTY_INFLIGHT_STALL: Duration = Duration::from_secs(3);

/// Outcome of parking on the credit gate — distinguished so the caller can log the abnormal cases.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Credit {
    /// Under the limit (immediately, or after an ack released capacity).
    Ready,
    /// The gate was closed (EOF / kill) — proceed unconditionally so teardown can't wedge.
    Closed,
    /// No acks arrived within the stall window; outstanding credit was forgiven so the producer
    /// makes progress instead of blocking forever.
    Stalled,
}

#[derive(Default)]
struct InflightInner {
    bytes: usize,
    closed: bool,
}

/// Credit gate shared between a session's reader + flusher threads (producers) and `pty_ack`
/// (consumer). Poison-tolerant like the rest of this module.
struct InflightState {
    inner: Mutex<InflightInner>,
    cvar: Condvar,
}

impl InflightState {
    fn new() -> Self {
        Self { inner: Mutex::new(InflightInner::default()), cvar: Condvar::new() }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, InflightInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Charge bytes about to be emitted. Called immediately before `emit`, so the counter is never
    /// behind what is actually in the IPC queue.
    fn charge(&self, bytes: usize) {
        let mut g = self.lock();
        g.bytes = g.bytes.saturating_add(bytes);
    }

    /// Release bytes the frontend has finished parsing (`pty_ack`). Saturating so a duplicate or
    /// late ack from a tearing-down terminal can't underflow the counter.
    fn ack(&self, bytes: usize) {
        let mut g = self.lock();
        g.bytes = g.bytes.saturating_sub(bytes);
        drop(g);
        self.cvar.notify_all();
    }

    /// Permanently release every parked producer (EOF / `pty_kill`). Idempotent. After this, the
    /// final drain emits whatever remains without gating, so no trailing output is lost.
    fn close(&self) {
        let mut g = self.lock();
        g.closed = true;
        drop(g);
        self.cvar.notify_all();
    }

    // Observers for the gate's internal counters. Test-only: the production paths act on the
    // Credit returned by `acquire`, never on a sampled reading of the state, so shipping these
    // would be dead code in the binary.
    #[cfg(test)]
    fn is_closed(&self) -> bool {
        self.lock().closed
    }

    #[cfg(test)]
    fn inflight_bytes(&self) -> usize {
        self.lock().bytes
    }

    /// Park the calling producer while un-acked bytes are at or above `limit`. Returns as soon as
    /// an ack drops below it, immediately if closed, or — as a liveness backstop — after `stall`
    /// with the outstanding credit forgiven.
    fn acquire(&self, limit: usize, stall: Duration) -> Credit {
        let g = self.lock();
        if g.closed {
            return Credit::Closed;
        }
        if g.bytes < limit {
            return Credit::Ready;
        }
        let (mut g, res) = self
            .cvar
            .wait_timeout_while(g, stall, |s| !s.closed && s.bytes >= limit)
            .unwrap_or_else(|e| e.into_inner());
        if g.closed {
            return Credit::Closed;
        }
        if res.timed_out() && g.bytes >= limit {
            // Consumer presumed gone (or acks lost). Forgive the outstanding credit rather than
            // wedge: the producer then trickles at ~one chunk per stall window. Nothing is dropped.
            g.bytes = 0;
            // Wake any CO-PARKED producer. Zeroing `bytes` falsifies their wait predicate, but a
            // predicate that became false without a notify is never re-checked — the reader and
            // flusher can both be parked here, and whichever times out first would otherwise leave
            // the other to burn its own full stall window before noticing the credit it was
            // waiting for is already free.
            self.cvar.notify_all();
            return Credit::Stalled;
        }
        Credit::Ready
    }
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
    /// Spawns that have started their child but not yet reached the `sessions` map — the window in
    /// which the child is running yet `take_and_signal_session` finds no row (bead sparkle-82vey). An entry is
    /// created by [`PtyManager::begin_spawn`] at the top of `pty_spawn` and consumed by
    /// [`PtyManager::insert_session`]; its `bool` is set true by [`PtyManager::mark_spawn_cancelled`]
    /// when a kill arrives during that window. BOTH the mark and the consume happen while the
    /// `sessions` lock is held (order: `sessions` → `pending_spawns`, never the reverse), so a kill
    /// can never be reported successful and then have its spawn insert the child anyway. A kill for
    /// an id with no in-flight spawn finds no entry and is a no-op here, so a later restart of the
    /// same id is never cancelled by a stale flag.
    pending_spawns: Mutex<HashMap<String, bool>>,
}

/// What a reader thread's reap found under its id — see [`PtyManager::reap`].
///
/// Only ONE of these means "leave everything else alone". The other two are both "this teardown is
/// mine to finish", and collapsing them into a bool is what breaks the ordinary kill path: gate a
/// per-id cleanup on "did I remove a row" and it stops running whenever `pty_kill` got there first,
/// which is every deliberate stop.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Reap {
    /// Our session was in the map and we took it out — the natural-exit path.
    RemovedOurs,
    /// Nothing under this id. `pty_kill` removes the session itself before the reader wakes on EOF,
    /// so this is the ordinary deliberate-stop teardown, NOT an anomaly: the id is unowned and the
    /// rest of this reader's cleanup must still run.
    AlreadyGone,
    /// A DIFFERENT life owns this id now — an overlapping spawn replaced us while we were reading.
    /// Touch nothing: the session, its observer and its terminal all belong to a live PTY.
    OwnedByOther,
}

impl PtyManager {
    /// Insert a session under `id`, MINTING ITS EPOCH WHILE THE MAP IS LOCKED, and return that epoch.
    ///
    /// The mint and the insert are one critical section on purpose, and the reason is subtle enough
    /// to be worth stating: `pty_spawn` cannot mint at its top and still claim anything about which
    /// session survived. Mint order there is INVOKE order, while insert order is
    /// blocking-completion order — `validate_spawn` + `openpty` + `spawn_command` run on a thread
    /// pool, and two concurrent spawns of one id can finish in either order. The lower epoch could
    /// therefore be the one left in the map.
    ///
    /// That is not a cosmetic skew. `sessions.insert` REPLACES silently, so the loser's reader thread
    /// stays alive and still owes a `pty:exit`, while every other verb (`write`/`resize`/`kill`) is
    /// keyed by id alone and acts on whatever is in the map. A frontend that bound to the highest
    /// epoch would then accept the ORPHAN's death and ignore the death of the PTY the user is
    /// actually typing into — the same misattribution the epoch exists to close, inverted.
    ///
    /// Minting here makes "the highest epoch minted for an id IS the session in the map" an
    /// invariant rather than an assumption, because nothing can interleave between the two.
    /// The other half of that invariant is [`PtyManager::remove_if_epoch`]: an id-keyed REMOVAL
    /// would let a loser's reader thread delete the winner it never knew replaced it.
    /// Register that a spawn for `id` is in flight, BEFORE its child is started. Pairs with
    /// [`insert_session`], which consumes the entry, and with [`mark_spawn_cancelled`], which a
    /// racing kill uses to cancel it. Called at the very top of `pty_spawn` so the whole
    /// child-start → map-insert window is covered (bead sparkle-82vey). Overwrites any prior entry
    /// for the id (a superseded concurrent spawn): whichever spawn reaches `insert_session` last
    /// consumes it, matching the map's existing silent-replace semantics.
    fn begin_spawn(&self, id: &str) {
        self.pending_spawns
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.to_string(), false);
    }

    /// A kill arrived for an id with no live session — flag its in-flight spawn (if any) so
    /// [`insert_session`] refuses to insert the child. MUST be called while the `sessions` lock is
    /// held (it is, from `take_and_signal_session`'s no-row branch), so this cannot interleave with the
    /// check-and-insert in `insert_session`. A no-op when no spawn is in flight.
    fn mark_spawn_cancelled(&self, id: &str) {
        if let Some(c) = self
            .pending_spawns
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(id)
        {
            *c = true;
        }
    }

    /// Returns the minted epoch on success, or [`NO_EPOCH`] when a kill cancelled this spawn while
    /// it was setting up off-thread — the caller (`pty_spawn`) then kills the child it started. The
    /// sentinel doubles cleanly: a cancelled spawn established no PTY, which is exactly what
    /// `NO_EPOCH` means everywhere else, and `next_pty_epoch` never mints it, so a real insert can
    /// never be mistaken for a cancel.
    fn insert_session(&self, id: String, mut session: PtySession) -> u64 {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        // Consume this spawn's pending entry under the SAME `sessions` lock that `take_and_signal_session`
        // holds when it marks a cancel — so "was I killed while spawning?" and "insert the child"
        // are one atomic step. If the entry is cancelled, a kill already reported success against
        // this id; inserting now would resurrect the child it believed dead (bead sparkle-82vey).
        let cancelled = matches!(
            self.pending_spawns
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id),
            Some(true)
        );
        if cancelled {
            return NO_EPOCH;
        }
        let epoch = next_pty_epoch();
        session.epoch = epoch;
        // KILL WHATEVER THIS REPLACED. `insert` hands back the displaced session, and dropping it
        // on the floor does NOT stop its child: the map is the only handle any verb has, so a
        // replaced child keeps running with nothing able to reach it — still holding whatever it
        // held (bead sparkle-osgvl: an orphan kept an OAuth callback port bound and completed a
        // login into the wrong config dir long after its terminal was gone).
        //
        // The epoch invariant is what makes this safe rather than a second race: the orphan's
        // reader wakes on EOF and asks to reap, and [`PtyManager::remove_if_epoch`] refuses it
        // because the id is now owned by the higher epoch we just minted. So the orphan tears
        // itself down and emits its own `pty:exit`, which the frontend already filters by epoch.
        let displaced = sessions.insert(id, session);
        // Same order as `take_and_signal_session`, and for the same reasons: drop the map lock
        // before the kill, then un-park the reader (`pause`) and open the credit gate (`inflight`)
        // so a session parked on either one can observe the EOF and run its teardown at all.
        drop(sessions);
        if let Some(mut orphan) = displaced {
            orphan.pause.set(false);
            orphan.inflight.close();
            let _ = orphan.killer.kill();
        }
        epoch
    }

    /// A reader thread's reap: drop this id's session IF this reader still owns it.
    ///
    /// THE TEARDOWN TWIN OF [`PtyManager::insert_session`], and needed for the same reason. A reader
    /// thread outlives the insert that replaced its session: after an overlapping spawn the loser is
    /// gone from the map but its thread is alive and will reach its own teardown, typically SOONER
    /// than the winner (a command that fails fast exits immediately). An id-keyed `remove` there
    /// deletes the WINNER — a live PTY — so `pty_write`/`pty_resize`/`pty_kill` start answering
    /// "no such pty" for a terminal the user is typing into, with no `pty:exit` to explain it, since
    /// the loser's exit carries the lower epoch and the frontend filters it out by design.
    ///
    /// THREE ANSWERS, NOT TWO, and the third is why: "nothing is here" and "someone else is here"
    /// are opposite instructions to the caller, and a bool that merges them gets the common path
    /// wrong. `pty_kill` removes the session by id BEFORE the reader wakes on EOF, so the ordinary
    /// deliberate-kill teardown finds an empty slot — and it is still that reader's job to finish
    /// tearing down (see [`Reap::AlreadyGone`]).
    ///
    /// Poison-tolerant, like every other lock here: a panic while another thread held it must not
    /// wedge spawn/write/resize/kill app-wide, and the recovered guard still points at a valid map.
    fn reap(&self, id: &str, epoch: u64) -> Reap {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        match sessions.get(id) {
            Some(s) if s.epoch == epoch => {
                sessions.remove(id);
                Reap::RemovedOurs
            }
            Some(_) => Reap::OwnedByOther,
            None => Reap::AlreadyGone,
        }
    }

    /// The epoch of the session live under `id`, or `0` (the never-minted sentinel) when there is
    /// none. This is the ONE read of `PtySession::epoch`: the reader thread stamps its own copy on
    /// `pty:exit` rather than looking the session up, precisely because by then the map may already
    /// hold the successor — so the stored field exists to answer this question, from outside, about
    /// the life that is live RIGHT NOW.
    pub fn live_epoch(&self, id: &str) -> u64 {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .map(|s| s.epoch)
            .unwrap_or(NO_EPOCH)
    }

    /// `(session id, root pid)` for every live session that reported a pid.
    ///
    /// The session id IS the agent id (`pty:output:<agentId>`), so the memory watchdog needs no
    /// mapping table that could drift. Sessions without a pid are SKIPPED rather than emitted with
    /// a placeholder: a footprint of zero would read as "this agent uses no memory", which is a
    /// different claim from "we could not measure it".
    pub fn session_pids(&self) -> Vec<(String, u32)> {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter_map(|(id, s)| s.pid.map(|pid| (id.clone(), pid)))
            .collect()
    }

    /// The `CLAUDE_CONFIG_DIR` the session under `id` was SPAWNED with — i.e. which Claude Max
    /// account that agent is running as. Recorded at spawn time by [`config_dir_from_args`], which
    /// decodes it out of the spawn script; see [`PtySession::config_dir`].
    ///
    /// This exists so a native-side flag can be ACTIONABLE. "An agent's screen says `Login expired ·
    /// Please run /login`" is not something a human can fix on a machine running several accounts
    /// pinned to separate config dirs — "re-authenticate THIS account" is.
    ///
    /// `None` IS AMBIGUOUS, AND THE RETURN VALUE ALONE CANNOT DISAMBIGUATE IT. It means EITHER:
    ///
    /// 1. there IS a live session and it was launched with no explicit `CLAUDE_CONFIG_DIR` — the
    ///    imported default account, the ordinary case for anyone who never set up multiple
    ///    accounts; OR
    /// 2. there is NO session under this id at all — never spawned, already exited, or an id whose
    ///    life was replaced by a newer one (see [`PtyManager::insert_session`]).
    ///
    /// A caller that reads `None` as "definitely the default account" WILL NAME THE WRONG LOGIN
    /// every time it is really case 2: it would tell the founder to re-authenticate the default
    /// account over a failure that had nothing to do with it, which is exactly the wrong-account
    /// outcome the parser fails closed to avoid. If you need the two apart, pair this with a
    /// liveness check — [`PtyManager::live_epoch`] answers [`NO_EPOCH`] for an unknown id — and
    /// treat "no session" as *we don't know*, never as a named account.
    ///
    /// Takes the sessions lock briefly and clones, exactly like [`PtyManager::live_epoch`] and
    /// [`PtyManager::session_pids`]: the global lock is never held across anything that can block.
    pub fn spawn_config_dir(&self, id: &str) -> Option<String> {
        match self.spawn_account(id) {
            Some(SpawnAccount::Dir(dir)) => Some(dir),
            _ => None,
        }
    }

    /// WHICH ACCOUNT this agent's PTY was launched under, without collapsing the three answers.
    ///
    /// `None` = no session under this id. `Some(SpawnAccount::Default)` = the imported default
    /// account, a positive answer. `Some(SpawnAccount::Unknown)` = there WAS an export and it could
    /// not be decoded, so the account is genuinely unidentified and a caller must say so rather
    /// than name anything (roborev 65537 — the collapsed form rendered every refusal as the default
    /// account by name, which is the confident wrong answer this parser fails closed to avoid).
    pub fn spawn_account(&self, id: &str) -> Option<SpawnAccount> {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .map(|s| s.config_dir.clone())
    }

    /// EVERY live session id — the process-global answer to "is this agent already running".
    ///
    /// The session id IS the agent id, so this needs no mapping table that could drift. It is the
    /// sibling of [`session_pids`] and it differs in the one way that matters here: a session with
    /// NO pid yet is REPORTED, not skipped.
    ///
    /// That asymmetry is the whole reason this is a separate method rather than a `.map` over the
    /// other. `session_pids` feeds the memory watchdog, which cannot measure a footprint it has no
    /// pid for, so skipping is right there. This one feeds the resurrection guard, where a pid-less
    /// session is the MOST dangerous entry in the map: it is a spawn in flight. `pty_spawn` inserts
    /// by `sessions.insert`, which REPLACES silently, so a second spawn for the same id drops the
    /// first `PtySession` on the floor — its child keeps running, keeps holding its worktree, keeps
    /// burning tokens, and is invisible to every surface in the app because nothing holds a handle
    /// to it any more. Filtering on `pid.is_some()` here would open exactly that window.
    pub fn session_ids(&self) -> Vec<String> {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect()
    }
}

#[derive(Clone, Serialize)]
struct PtyOutput {
    id: String,
    chunk: String,
    /// UTF-8 byte length of `chunk` — the credit the frontend must echo back via `pty_ack` once
    /// xterm has parsed it. Sent explicitly rather than recomputed frontend-side because JS string
    /// `.length` counts UTF-16 code units; any drift would slowly leak (or over-release) credit.
    bytes: usize,
}

#[derive(Clone, Serialize)]
struct PtyEnd {
    id: String,
    /// The epoch of the PTY that ACTUALLY exited — see `PtySession::epoch`. `pty:exit` is a global
    /// channel keyed only by agent id, and the id survives a restart, so without this a listener
    /// cannot tell "my PTY died" from "the PTY I replaced finally finished dying". Non-optional on
    /// purpose: every exit is emitted by a reader thread that owns exactly one session, so there is
    /// always an answer, and an `Option` here would cross the wire as `null` and hand the frontend
    /// an "unknown epoch" case with no correct handling.
    epoch: u64,
}

/// Binaries `pty_spawn` is permitted to launch, by basename (defense-in-depth allowlist).
///
/// Today EVERY real spawn is `/bin/zsh` (the `SHELL` constant in claudeSpawn.ts): the user's
/// `claude`/`node`/`git` ride as arguments inside `/bin/zsh -l -c 'exec …'`, never as `command`.
/// The remaining names are the tool binaries the app resolves in preflight.rs (`known_*_paths`)
/// and could plausibly be spawned directly by a future path. A compromised webview that tries to
/// launch some OTHER absolute binary — `/usr/bin/osascript`, `/usr/bin/curl`, `/bin/rm`, a
/// downloaded payload — no longer gets a free arbitrary-exec primitive out of `pty_spawn`.
const ALLOWED_SPAWN_BASENAMES: &[&str] =
    &["zsh", "bash", "sh", "node", "git", "claude", "roborev"];

/// Defense-in-depth checks before spawning — NOT the primary security boundary.
///
/// `pty_spawn` exists to launch the user's own `claude` via `/bin/zsh -lc '…'`, so by design it
/// runs whatever shell script the webview hands it. The REAL boundary is the WebView's integrity:
/// a strict CSP with no remote origins and no `unsafe-eval` (see tauri.conf.json), plus a frontend
/// that never renders agent/file output as executable HTML. These checks are a SECOND layer that
/// stops the obvious misuses and catch bugs:
///  - `command` must be a non-empty ABSOLUTE path (no `$PATH`-relative name resolution) whose
///    basename is in `ALLOWED_SPAWN_BASENAMES`, or which lives under the app's managed dir.
///  - Containment is enforced on EVERY spawn — there is no "cwd is null so skip the check" hole.
///    A provided `cwd` must resolve INSIDE `<app_data>/worktrees`; a null `cwd` (the pre-worktree
///    `claude login` flows) is NOT left to inherit the app's arbitrary process cwd — it falls back
///    to the managed `<app_data>` dir, a trusted, contained location.
///
/// Returns the canonicalized cwd the caller must spawn into (never the original string), closing a
/// check-vs-use symlink-swap window.
fn validate_spawn(app: &AppHandle, command: &str, cwd: Option<&str>) -> Result<PathBuf, String> {
    let app_data = crate::dev_identity::app_data_dir(app).map_err(|e| format!("pty_spawn: {e}"))?;
    // The managed dir is the null-cwd fallback and the "binary under a managed dir" root, so it
    // must exist and canonicalize. Tauri creates app-data lazily; ensure it before we depend on it.
    let _ = std::fs::create_dir_all(&app_data);
    let worktrees = app_data.join("worktrees");
    validate_spawn_inner(&worktrees, &app_data, command, cwd)
}

/// Pure, AppHandle-free core of `validate_spawn` (so it can be unit-tested). `worktrees_base` is
/// `<app_data>/worktrees`; `managed_base` is `<app_data>` — used both as the null-cwd fallback and
/// as the root under which a bundled binary may be spawned. Always returns the validated cwd to
/// spawn into (there is no longer an "unconstrained / inherited cwd" outcome).
fn validate_spawn_inner(
    worktrees_base: &Path,
    managed_base: &Path,
    command: &str,
    cwd: Option<&str>,
) -> Result<PathBuf, String> {
    let cmd_path = Path::new(command);
    if command.is_empty() || !cmd_path.is_absolute() {
        return Err("pty_spawn: command must be a non-empty absolute path".into());
    }
    // Binary allowlist: an allowlisted basename, OR a binary that lives under the app's managed
    // dir. The basename check is lexical (it does not require the binary to exist), so the common
    // `/bin/zsh` path never touches the filesystem here.
    let basename_ok = cmd_path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|b| ALLOWED_SPAWN_BASENAMES.contains(&b))
        .unwrap_or(false);
    if !basename_ok {
        // Canonicalize both sides so a symlinked binary can't dodge the containment compare; fall
        // back to a lexical prefix check only when a side can't be resolved.
        let under_managed = match (cmd_path.canonicalize(), managed_base.canonicalize()) {
            (Ok(real_cmd), Ok(real_base)) => real_cmd.starts_with(&real_base),
            _ => cmd_path.starts_with(managed_base),
        };
        if !under_managed {
            // NAME THE BINARY. The refusal reaches the user verbatim (Terminal's spawn-failed
            // overlay renders this string), and "not an allowed binary" without saying WHICH one
            // is indistinguishable from every other launch failure. See the containment refusal
            // below for the full reasoning.
            return Err(format!(
                "pty_spawn: command is not an allowed binary: {command}"
            ));
        }
    }
    // Null cwd (the pre-worktree login flows): fall back to the managed app-data dir rather than
    // inheriting the app's process cwd, so EVERY spawn runs in a validated, contained directory.
    let Some(cwd) = cwd else {
        return managed_base
            .canonicalize()
            .map_err(|e| format!("pty_spawn: managed dir unavailable: {e}"));
    };
    // Canonicalize BOTH sides fully (resolving macOS /var→/private/var, ~/Library, a symlinked
    // `worktrees`, and any `../` in the supplied cwd) so the containment compare is between two
    // real paths. If the worktrees base can't be resolved (e.g. it doesn't exist yet) we reject
    // rather than compare against a half-resolved path — fail-closed, and any legitimate cwd
    // implies the base already exists.
    let base = worktrees_base
        .canonicalize()
        .map_err(|e| format!("pty_spawn: worktrees dir unavailable: {e}"))?;
    let real = std::fs::canonicalize(cwd)
        .map_err(|e| format!("pty_spawn: invalid cwd: {e}: {cwd}"))?;
    if !real.starts_with(&base) {
        // NAME BOTH SIDES OF THE COMPARE. This refusal is 100% reproducible for a given cwd — a
        // retry can never clear it — and it is rendered to the user verbatim by Terminal's
        // spawn-failed overlay, so it is the ONLY thing standing between "the button is broken"
        // and a diagnosis. Without the two paths it says a boundary was crossed but not by what,
        // which is what made sparkle-mahbf (an `<app_data>/accounts/<id>` cwd, a SIBLING of
        // `worktrees`) read as a mystery rather than an obvious one-line mismatch.
        //
        // The leading phrase is unchanged and load-bearing: `logger.ts` (BENIGN_REJECTION_SIGNATURES)
        // and `terminalOverlay.ts` substring-match it, so detail may only ever be APPENDED.
        return Err(format!(
            "pty_spawn: cwd is outside the managed worktrees directory: {} is not under {}",
            real.display(),
            base.display()
        ));
    }
    Ok(real)
}

/// Returned (as the `Err` string) when a write/resize/kill targets a PTY that has
/// already exited — a benign race the frontend expects. `ignorePtyGone` in
/// `apps/desktop/src/pty.ts` substring-matches this exact text to swallow the
/// rejection, so keep the two in sync if you ever rephrase it.
const NO_SUCH_PTY: &str = "no such pty";

// ── Thin-column backstop ────────────────────────────────────────────────────────────────────
// The "compressed terminal" bug: a PTY opened with an implausibly small size makes the child CLI
// (claude's TUI) hard-wrap its output into a thin column, and because the wraps are baked into the
// emitted bytes, no later resize can un-wrap them — the pane stays compressed until a full redraw.
// The frontend (terminalSize.ts `spawnSize`) is the PRIMARY guard, refusing to send a size from an
// unmeasured/collapsed pane. These constants + clamps are the LAST-LINE backstop at the one
// boundary every size must cross (openpty / resize), so NO path — a frontend regression, the
// orchestrator/login-modal mounts, or future code — can ever open a thin-column PTY. The warn logs
// make the (otherwise invisible) leak diagnosable: if one fires, the frontend guard was bypassed.
// Keep MIN_* in sync with MIN_PLAUSIBLE_COLS/ROWS in terminalSize.ts; the spawn fallback matches
// SPAWN_FALLBACK_* there (and pty.ts).
const MIN_PTY_COLS: u16 = 20;
const MIN_PTY_ROWS: u16 = 5;
const SPAWN_FALLBACK_COLS: u16 = 120;
const SPAWN_FALLBACK_ROWS: u16 = 30;

// ── pty:output coalescing ─────────────────────────────────────────────────────────────────────
// The reader thread used to emit a `pty:output` Tauri event on EVERY read() (and once per decoded
// sub-slice). During a burst — `claude --resume` redrawing a large transcript, or any full-screen
// TUI repaint — that fires hundreds-to-thousands of tiny events/sec, each paying a full IPC
// crossing + JSON serialization, and the frontend runs term.write + engine.ingest + watchRateLimit
// synchronously per event. Instead we accumulate decoded text in a shared buffer and let a
// dedicated flusher thread emit far fewer, larger events: it waits for the first byte (so idle
// costs nothing), then coalesces a short window before emitting. Ordering is preserved (a single
// buffer, appended in read order, drained in order) and a final flush on EOF/close guarantees no
// trailing output is lost (see the flusher + reader join below).
//
// FLUSH_INTERVAL is the coalescing window: short enough that interactive typing echo stays
// imperceptible, long enough that a repaint burst collapses into a handful of events. SIZE_THRESHOLD
// bounds how much a sustained flood accumulates before an early flush, so per-event size (and the
// buffer's peak memory) stay bounded rather than growing for the whole interval.
const PTY_FLUSH_INTERVAL_MS: u64 = 12;
const PTY_FLUSH_SIZE_THRESHOLD: usize = 64 * 1024;

/// Shared buffer between the PTY reader thread (producer) and the flusher thread (consumer).
/// `done` is set once by the reader on EOF/close to trigger the flusher's final flush + exit.
#[derive(Default)]
struct FlushBuf {
    text: String,
    done: bool,
}

/// Per-agent `pty:output` channel. Emitting app-wide made every chunk fan out to EVERY terminal's
/// listener — N producers × N listeners, with N-1 of them filtering the payload straight back out
/// after Tauri had already materialized it. A per-id event name means only the owning terminal's
/// listener is ever invoked.
fn output_event(id: &str) -> String {
    format!("pty:output:{id}")
}

/// The flusher thread's body, split out so the flood/ordering contract is unit-testable without a
/// Tauri `AppHandle`. Drains `shared` into coalesced chunks and hands each to `emit` — but only
/// after `inflight` grants credit, so the un-acked IPC backlog stays bounded.
///
/// Ordering and completeness are the load-bearing properties: a single buffer is drained
/// front-to-back and the gate only ever DELAYS an emit, never skips or truncates one. On `done` it
/// drains whatever remains and returns (the gate is closed by then, so the final drain can't park).
fn run_flusher(
    shared: &(Mutex<FlushBuf>, Condvar),
    inflight: &InflightState,
    id: &str,
    limit: usize,
    mut emit: impl FnMut(String, usize),
) {
    let (lock, cvar) = shared;
    loop {
        let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        // Block until there's something to flush or the stream ended (no busy-wait while idle).
        while guard.text.is_empty() && !guard.done {
            guard = cvar.wait(guard).unwrap_or_else(|e| e.into_inner());
        }
        // We have data (or we're done). If more may still arrive, give the reader a brief
        // window to pile a burst into the same buffer — but return early if the stream ends or
        // the buffer hits the size cap, so a flood flushes promptly and bounds per-event size.
        if !guard.done && guard.text.len() < PTY_FLUSH_SIZE_THRESHOLD {
            let (g, _timed_out) = cvar
                .wait_timeout_while(
                    guard,
                    Duration::from_millis(PTY_FLUSH_INTERVAL_MS),
                    |b| !b.done && b.text.len() < PTY_FLUSH_SIZE_THRESHOLD,
                )
                .unwrap_or_else(|e| e.into_inner());
            guard = g;
        }
        let chunk = std::mem::take(&mut guard.text);
        let done = guard.done;
        // Release the buffer lock BEFORE parking on the credit gate, so the reader can keep
        // appending (and, more importantly, so it can set `done` / the gate can be closed).
        drop(guard);
        if !chunk.is_empty() {
            if inflight.acquire(limit, PTY_INFLIGHT_STALL) == Credit::Stalled {
                tracing::warn!(
                    %id,
                    inflight_limit = limit,
                    "pty:output acks stalled — frontend not draining; forgiving credit to keep the stream alive"
                );
            }
            // Charge BEFORE emitting so the counter is never behind the IPC queue. `bytes` is the
            // authoritative count the frontend echoes back in `pty_ack` — it must not recompute
            // the length itself (JS string length is UTF-16 units, this is UTF-8 bytes).
            let bytes = chunk.len();
            inflight.charge(bytes);
            emit(chunk, bytes);
        }
        if done {
            break;
        }
    }
}

/// SPAWN backstop: an implausibly small requested size is replaced WHOLESALE with the comfortable
/// default (a CLI started at 120×30 reflows cleanly once the real visible size is synced on
/// reveal). Returns the size to actually open the PTY with.
fn guard_spawn_size(id: &str, cols: u16, rows: u16) -> (u16, u16) {
    if cols < MIN_PTY_COLS || rows < MIN_PTY_ROWS {
        tracing::warn!(
            %id, requested_cols = cols, requested_rows = rows,
            "pty_spawn size implausibly small (frontend guard bypassed?) — using {SPAWN_FALLBACK_COLS}x{SPAWN_FALLBACK_ROWS} to avoid thin-column wrap"
        );
        return (SPAWN_FALLBACK_COLS, SPAWN_FALLBACK_ROWS);
    }
    (cols, rows)
}

/// RESIZE backstop: never shrink a live PTY below the plausible floor (that would re-introduce the
/// thin-column wrap on an already-running CLI). Floors each dimension rather than substituting a
/// default, so a genuine resize to a slightly-small pane is honored as closely as is safe.
fn guard_resize_size(id: &str, cols: u16, rows: u16) -> (u16, u16) {
    let c = cols.max(MIN_PTY_COLS);
    let r = rows.max(MIN_PTY_ROWS);
    if c != cols || r != rows {
        // debug, not warn: resize is the high-frequency path (a window/drag resize fires many
        // events), and a sub-floor resize is far less catastrophic than a sub-floor SPAWN (the
        // running CLI reflows on the next plausible resize). debug keeps it diagnosable under the
        // default `sparkle_lib=debug` filter without warn-level spam. The spawn warn stays the
        // high-signal "frontend guard bypassed" alarm.
        tracing::debug!(
            %id, requested_cols = cols, requested_rows = rows, clamped_cols = c, clamped_rows = r,
            "pty_resize size below floor — clamped to avoid thin-column wrap"
        );
    }
    (c, r)
}

/// Build the `NODE_OPTIONS` value for an agent's PTY child, merging our per-agent V8 heap cap into
/// whatever the user already has. Returns None when nothing should be set.
///
/// Why this exists (sparkle-01xv / sparkle-asz5): V8's default old-space ceiling is ~4 GiB, so a
/// runaway agent grows until the KERNEL intervenes. On 2026-07-20 that was 24 `claude` subprocesses
/// at ~4 GiB each — 99 GiB — and jetsam killed `securityd_system`/`trustd`, forcing a reboot. An
/// explicit `--max-old-space-size` gives each agent a ceiling we choose instead of one Node picks.
///
/// Merge rules, in order:
///   - `heap_mb == 0` → opt-out: return None and leave the child's inherited env untouched.
///   - the user already pinned a heap size → their value wins verbatim (a deliberate choice, and
///     appending a second flag would just be confusing).
///   - otherwise → append our flag after theirs, so their `--require` shims / source maps / proxy
///     settings all survive. NODE_OPTIONS is a flag string, not a path list: last flag wins, so
///     appending is also what makes ours authoritative when nothing conflicts.
fn node_options_with_cap(existing: Option<&str>, heap_mb: u32) -> Option<String> {
    if heap_mb == 0 {
        return None;
    }
    let existing = existing.unwrap_or("").trim();
    if existing.is_empty() {
        return Some(format!("--max-old-space-size={heap_mb}"));
    }
    // Node accepts both `-` and `_` spellings, with `=` or a space before the value.
    let normalized = existing.replace('_', "-");
    // Match per TOKEN, not by substring. `contains` also fires on unrelated tokens that merely
    // EMBED the flag name — `--require ./max-old-space-size-helper.js`, or a hypothetical
    // `--max-old-space-size-foo` — and reads them as "the user already set a heap limit", silently
    // suppressing the cap. Suppressing it is the one outcome this whole feature exists to prevent
    // (sparkle-01xv: 24 uncapped agents summing 99 GiB), so the test must be exact.
    let user_set_heap_flag = normalized.split_whitespace().any(|tok| {
        // Both spellings Node accepts: `--max-old-space-size=4096` and `--max-old-space-size 4096`.
        tok == "--max-old-space-size" || tok.starts_with("--max-old-space-size=")
    });
    if user_set_heap_flag {
        return Some(existing.to_string());
    }
    Some(format!("{existing} --max-old-space-size={heap_mb}"))
}

/// Apply the per-agent heap cap to a command about to be spawned in a PTY. `inherited` is the
/// user's own `NODE_OPTIONS` (from our process env, which the child inherits).
fn apply_heap_cap(cmd: &mut CommandBuilder, inherited: Option<String>, heap_mb: u32) {
    if let Some(v) = node_options_with_cap(inherited.as_deref(), heap_mb) {
        cmd.env("NODE_OPTIONS", v);
    }
}

/// The `SPARKLE_TEST_MAX_WORKERS` value to set on an agent's PTY child, or None to leave it alone.
///
/// Bounds the vitest worker fan-out ONE agent may create so N concurrent agents each running their
/// suite can't oversubscribe the cores (`config::agent_test_worker_cap`). Two ways this yields None,
/// both meaning "do not touch the child's env":
///   - `user_already_set` — the user exported `SPARKLE_TEST_MAX_WORKERS` themselves (it is the
///     documented escape hatch in `vitest.pool.mjs`); their choice wins verbatim, exactly as
///     `node_options_with_cap` defers to a user-pinned heap flag.
///   - `cap` is None — the machine-wide division is already at or above the pool's own default, or
///     the core count was unmeasurable, so the pool keeps the value it would have picked anyway.
fn test_worker_env_value(user_already_set: bool, cap: Option<u32>) -> Option<String> {
    if user_already_set {
        return None;
    }
    cap.map(|c| c.to_string())
}

/// Set the per-agent vitest worker cap on `cmd` when one applies. Split from the spawn body so the
/// "respect the user's value / inject ours" decision is unit-testable without a real PTY.
fn apply_test_worker_cap(cmd: &mut CommandBuilder, user_already_set: bool, cap: Option<u32>) {
    if let Some(v) = test_worker_env_value(user_already_set, cap) {
        cmd.env("SPARKLE_TEST_MAX_WORKERS", v);
    }
}

/// What a reader thread does about its observer once it knows [`Reap`]'s verdict.
///
/// TWO LINES, EXTRACTED SO THEY CAN BE TESTED — and that is the whole point, not tidiness. The bug
/// this closes lived HERE, in the mapping from verdict to action, while every test targeted `reap`'s
/// return value; the suite stayed green through a gate that skipped the detach on the commonest
/// path. Inline, this decision is reachable only from a thread inside a real `pty_spawn`, so nothing
/// could assert it. Behind this function, three unit tests pin all three verdicts.
///
/// Stop observing, or a long-lived app accumulates one 4KB tail and one VT grid per agent that has
/// ever run. The nudger also keys its ladder state off the live observer set (`nudger::tick` reads
/// `observers.all()`), so an observer left attached to a dead PTY keeps its ladder climbing and
/// eventually escalates a terminal that no longer exists.
///
/// Gated on NOT BEING SOMEONE ELSE'S, not on "did I remove a row". `pty_kill` removes the session by
/// id before the reader wakes on EOF, so on every deliberate stop the reap finds an empty slot — and
/// gating on the removal skips the detach exactly there, on the commonest teardown path there is.
fn finish_teardown(observers: &crate::nudger::Observers, id: &str, reap: Reap) {
    if reap != Reap::OwnedByOther {
        observers.detach(id);
    }
}

/// The `Send` pieces `pty_spawn`'s blocking setup hands back to the async side: the session to
/// insert into the manager, plus the child's output reader and the child itself (each reaped on
/// its own thread).
type SpawnedPty = (PtySession, Box<dyn Read + Send>, Box<dyn Child + Send + Sync>);

/// Insert `session` under `id` (minting its epoch under the sessions lock) and attach the nudger
/// observer ONLY when the insert won the race. Returns `None` when a racing `pty_kill` cancelled the
/// spawn — [`PtyManager::insert_session`] returned [`NO_EPOCH`] — and CRUCIALLY, on that path NO
/// observer is attached, so a cancelled spawn can never strand one. `nudger::Observers::attach`
/// records `id` in the observer map and only `detach` removes it (dropping the returned handle does
/// NOT), and the nudger climbs its ladder off the live observer set (`observers.all()` in
/// `nudger::tick`), so an observer left on a killed PTY would escalate a terminal that never ran
/// (roborev 62075, HIGH). Keeping the insert and the conditional attach together here makes
/// "cancelled ⇒ no observer" a single invariant a unit test can drive with a `PtyManager` and an
/// `Observers` directly — `pty_spawn` itself needs a live `AppHandle` a test cannot build.
///
/// SCOPE — what this does and does NOT guarantee (roborev 62108): the attach runs AFTER
/// `insert_session` releases the sessions lock, not under it. So only the CANCEL-path invariant
/// above is closed. Two windows remain, both pre-existing (the prior attach-then-insert order
/// admitted a symmetric interleaving) and both requiring two concurrent spawns of one id — which
/// only the frontend restart path produces, since it does not yet sequence `killPty` before
/// `spawnPty`: (1) a brief live-but-unobserved gap between the insert and the attach (a `pty_resize`
/// landing there loses geometry until the next resize); (2) a stale-attach clobber where a loser
/// spawn's late `attach` displaces the winner's observer, leaving the nudger judging a live agent
/// off a blank screen. The durable fix is to attach under the sessions lock (or make the observer
/// map epoch-aware so a lower-epoch attach cannot replace a higher-epoch entry) — that is the same
/// causal-ordering redesign tracked in `sparkle-b6fdg`, deliberately out of scope for this HIGH fix.
fn insert_or_cancel(
    manager: &PtyManager,
    observers: &crate::nudger::Observers,
    id: &str,
    session: PtySession,
    cols: u16,
    rows: u16,
) -> Option<(u64, Arc<crate::nudger::PtyObserver>)> {
    let epoch = manager.insert_session(id.to_string(), session);
    if epoch == NO_EPOCH {
        return None;
    }
    let observer = observers.attach(id, cols, rows);
    Some((epoch, observer))
}

/// Spawn `command` in a PTY. Output streams to the frontend via the `pty:output`
/// event; `pty:exit` fires when the process ends.
// too_many_arguments: each arg is a distinct field of the frontend's invoke payload; bundling
// them into a struct would only move the count into a struct literal at the one call site.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<u64, String> {
    // WHICH LIFE OF THIS AGENT THIS IS is minted LATER, by `insert_session`, under the same lock as
    // the insert — NOT here. Minting at the top reads naturally and is wrong: the setup below runs
    // on a thread pool, so mint order would be INVOKE order while insert order is completion order,
    // and two concurrent spawns of one id can finish in either. The map could then hold the LOWER
    // epoch, and the frontend's "highest epoch is the surviving session" rule would bind to a
    // session that was silently replaced. See `PtyManager::insert_session`.
    //
    // Log the command and arg COUNT at info. The full args carry the built `zsh -c '…'` script,
    // which embeds the user's prompt/persona (and could in principle carry a secret passed as a
    // flag), so they're NEVER written to the shared daily log by default — even though our default
    // filter is `sparkle_lib=debug`. Gate the full-args line behind an explicit opt-in env var so
    // a developer can still get it when actively debugging spawn issues.
    tracing::info!(%id, %command, arg_count = args.len(), cwd = ?cwd, cols, rows, "pty_spawn");
    if std::env::var_os("SPARKLE_LOG_PTY_ARGS").is_some() {
        tracing::debug!(%id, args = ?args, "pty_spawn args (may contain prompt text)");
    }
    // Backstop against the thin-column bug (see guard_spawn_size): never open a PTY at an
    // implausibly small size, whatever the frontend sent.
    let (cols, rows) = guard_spawn_size(&id, cols, rows);

    // Run the blocking work — cwd canonicalize (validate_spawn), openpty, and spawn_command — OFF
    // the main thread (mirrors `create_agent_worktree`). `pty_spawn` fires on nearly every
    // agent/terminal open, so doing this synchronously on the UI thread spins the beachball. We
    // return the session pieces (+ reader/child) and finish the cheap wiring (map insert, thread
    // spawns) back on the async side.
    let spawn_app = app.clone();
    // Register this spawn as in-flight BEFORE its child starts, so a `pty_kill` that lands while we
    // set up off-thread can cancel it rather than succeed against an empty map and orphan the child
    // (bead sparkle-82vey). Consumed by `insert_session` below.
    app.state::<PtyManager>().begin_spawn(&id);
    // Read the configured per-agent heap cap once, on this side of the thread hop.
    let heap_mb = crate::config::current_effective().config.workers.agent_heap_mb;
    // And the per-agent vitest worker cap (a lock + core-count read), computed here so the blocking
    // half only touches the command. `None` when the machine-wide division doesn't narrow below the
    // pool's own default — see config::agent_test_worker_cap.
    let test_worker_cap = crate::config::agent_test_worker_cap_env();
    // Whether the user pinned the override themselves (their choice wins) — read on this side too.
    let test_worker_user_set = std::env::var_os("SPARKLE_TEST_MAX_WORKERS").is_some();
    let (session, reader, child) = tauri::async_runtime::spawn_blocking(
        move || -> Result<SpawnedPty, String> {
            let validated_cwd = validate_spawn(&spawn_app, &command, cwd.as_deref())?;
            let pty_system = native_pty_system();
            let pair = pty_system
                .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
                .map_err(|e| e.to_string())?;

            let mut cmd = CommandBuilder::new(&command);
            cmd.args(&args);
            // A GUI-launched .app inherits no shell environment, so without these the child
            // (claude's TUI) sees a "dumb" terminal and disables ALL ANSI color — every line
            // renders in the default foreground (near-white). Declare a real color terminal so
            // TUIs emit their normal palette. (env() overrides on top of the inherited env.)
            cmd.env("TERM", "xterm-256color");
            cmd.env("COLORTERM", "truecolor");
            // DO NOT HAND THE AGENT SPARKLE'S SECRETS (security audit 2026-08-08, H2).
            //
            // `CommandBuilder` inherits the FULL parent environment by default, and this child is an
            // autonomous agent running with `--dangerously-skip-permissions` that auto-approves its
            // own tool calls. So every secret in Sparkle.app's process environment was flowing
            // straight into it. That is not hypothetical: this repo's working tree carries
            // `.env.local`, `apps/orchestration/.env` and `apps/web/.env.local` holding GitHub PATs
            // with repo write, Stripe and Clerk secret keys, production Postgres credentials and R2
            // tokens — and if Sparkle is launched from a shell that sourced any of them, they were
            // inherited here.
            //
            // The list is shared with `claude_oneshot`'s existing ANTHROPIC_* scrub rather than
            // copied, so the two cannot drift — that scrub already existed on a NEIGHBOURING path,
            // which is what made the omission here a gap rather than an oversight.
            for name in crate::claude_oneshot::secret_env_names_now() {
                cmd.env_remove(&name);
            }
            // Bound the child's V8 heap so a runaway agent can't run itself up to Node's ~4 GiB
            // default ceiling (sparkle-01xv). Merges with — never clobbers — a NODE_OPTIONS the
            // user already set; see node_options_with_cap.
            apply_heap_cap(&mut cmd, std::env::var("NODE_OPTIONS").ok(), heap_mb);
            // Bound how many vitest workers this agent's test runs may fan out to, so N concurrent
            // agents each running the suite can't oversubscribe the cores (the process/CPU storm
            // behind the swap-thrash incident). Never clobbers a value the user set themselves.
            apply_test_worker_cap(&mut cmd, test_worker_user_set, test_worker_cap);
            // Spawn into the *validated, canonicalized* cwd (not the original string), so a symlink
            // swap between check and use can't redirect the working dir outside the worktrees tree.
            // Every spawn now has a validated cwd (a provided one is worktree-contained; a null one
            // fell back to the managed app-data dir) — no spawn inherits the app's process cwd.
            cmd.cwd(validated_cwd);

            let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
            let killer = child.clone_killer();
            // Capture the pid BEFORE the child can be reaped: `process_id()` stops answering once
            // the child is waited on, and the watchdog needs the tree root for the session's life.
            let pid = child.process_id();
            // Drop the slave so the master sees EOF when the child exits.
            drop(pair.slave);

            // The child is already running. If wiring up its reader/writer fails here, nothing
            // downstream will reap it (no session is inserted, no reaper thread is spawned), so it
            // would orphan/zombie. Kill + wait it on these error paths before bubbling the error up.
            let reader = match pair.master.try_clone_reader() {
                Ok(r) => r,
                Err(e) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(e.to_string());
                }
            };
            let writer = match pair.master.take_writer() {
                Ok(w) => w,
                Err(e) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(e.to_string());
                }
            };

            Ok((
                PtySession {
                    writer: Arc::new(Mutex::new(writer)),
                    master: pair.master,
                    killer,
                    pause: Arc::new(PauseState::new()),
                    inflight: Arc::new(InflightState::new()),
                    pid,
                    // Placeholder — the real epoch is stamped by `insert_session`, under the lock
                    // that inserts this session. `0` is the never-minted sentinel, so a session that
                    // somehow reached the map without going through that path would read as "no PTY
                    // has spawned" rather than impersonating a real life.
                    epoch: NO_EPOCH,
                    // WHICH ACCOUNT this PTY runs as, read back out of the spawn script — the only
                    // point at which Rust can learn it (see `config_dir_from_args`). Decoded HERE,
                    // while `args` is still in hand: the script is not retained anywhere, so a
                    // later caller has nothing left to parse.
                    config_dir: spawn_account_from_args(&args),
                },
                reader,
                child,
            ))
        },
    )
    .await
    .map_err(|e| format!("pty_spawn task failed: {e}"))??;

    let mut reader = reader;
    let mut child = child;

    // Share the session's pause + credit gates with its reader/flusher threads before the session
    // moves into the map.
    let read_pause = session.pause.clone();
    let inflight = session.inflight.clone();
    let read_inflight = inflight.clone();
    // Insert under the sessions lock and attach the nudger observer ONLY if the insert won the race
    // — see `insert_or_cancel`, which keeps the two together so "a cancelled spawn attaches no
    // observer" is a single unit-testable invariant rather than a source-order accident here. The
    // epoch is minted under the same lock as the insert, which is what makes "the highest epoch
    // minted for an id is the session that survived" TRUE rather than merely likely (the frontend's
    // overlap rule depends on it).
    let manager = app.state::<PtyManager>();
    let observers = app.state::<crate::nudger::Observers>();
    let Some((epoch, observer)) =
        insert_or_cancel(manager.inner(), observers.inner(), &id, session, cols, rows)
    else {
        // A `pty_kill` for this id landed while we were setting up off-thread and already reported
        // success. Honour it: kill and reap the child we just started so it does not keep running
        // against the worktree, and wire up nothing — no reader/flusher/reaper threads, and (because
        // `insert_or_cancel` never attached one on the cancel path) no observer. `reader` and every
        // clone above drop on return (bead sparkle-82vey).
        let _ = child.kill();
        let _ = child.wait();
        return Err("pty_spawn: cancelled by a kill that raced the spawn".to_string());
    };
    let read_observer = observer.clone();

    // Reap the child so it doesn't zombie.
    std::thread::spawn(move || {
        let _ = child.wait();
    });

    // Reader thread → shared buffer; a flusher thread coalesces + emits `pty:output`. Buffer partial
    // multi-byte UTF-8 across chunk boundaries (Claude Code's TUI emits box-drawing/emoji).
    let shared = Arc::new((Mutex::new(FlushBuf::default()), Condvar::new()));

    // Flusher thread: drain the shared buffer into coalesced `pty:output` events. Ordering is
    // preserved because it's a single buffer drained front-to-back. It waits for the first byte
    // (idle costs nothing), then coalesces up to PTY_FLUSH_INTERVAL_MS — or flushes early once the
    // buffer reaches PTY_FLUSH_SIZE_THRESHOLD — before emitting. On `done` it drains whatever remains
    // and exits, so trailing output on EOF/close is never dropped.
    let flush_app = app.clone();
    let flush_id = id.clone();
    let flush_shared = shared.clone();
    let flush_inflight = inflight.clone();
    let flusher = std::thread::spawn(move || {
        let event = output_event(&flush_id);
        run_flusher(
            &flush_shared,
            &flush_inflight,
            &flush_id,
            PTY_INFLIGHT_HIGH_WATER_BYTES,
            |chunk, bytes| {
                let _ = flush_app.emit(&event, PtyOutput { id: flush_id.clone(), chunk, bytes });
            },
        );
    });

    let read_app = app.clone();
    let read_id = id.clone();
    let read_shared = shared;
    std::thread::spawn(move || {
        let (lock, cvar) = &*read_shared;
        let mut pending: Vec<u8> = Vec::new();
        let mut buf = [0u8; 4096];
        // Append this read()'s decoded text to the shared buffer and wake the flusher.
        let push = |out: String| {
            if out.is_empty() {
                return;
            }
            // Observe BEFORE the flusher handoff, not inside `run_flusher`: the flusher can park on
            // the credit gate for up to PTY_INFLIGHT_STALL (3s) while the frontend is behind on
            // acks, so a tail fed there would lag under exactly the load that makes an agent look
            // stalled. Here it is fed once per read(), on the same schedule as the bytes arriving.
            read_observer.ingest(&out);
            let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
            guard.text.push_str(&out);
            cvar.notify_one();
        };
        'read: loop {
            // Backpressure: block here while the frontend has paused us (its xterm write buffer is
            // above the high-water mark). Not read()ing lets the kernel PTY buffer fill so the child
            // blocks on its next write — bounding memory end-to-end (). Returns instantly
            // when not paused, so interactive output is unaffected.
            //
            // Tell the nudger's observer we are about to park. BOTH gates here sit UPSTREAM of
            // read(), so while either holds, the observer is fed nothing: its tail stops changing
            // (which reads as the agent going silent) and its VT grid stops advancing (so the
            // safety gate would judge a stale screen). A wedged WebView stops acking and latches
            // exactly these gates, so without this flag the nudger goes blind in the very outage it
            // exists to survive. See `PtyObserver::reader_parked`.
            read_observer.set_reader_parked(true);
            read_pause.wait_while_paused();
            // Second gate, same principle but driven by the PRODUCER's own accounting rather than
            // the frontend's: park while the frontend is behind on acks. Without this the flusher's
            // credit gate would merely relocate the backlog into `FlushBuf` (an unbounded String on
            // this side) instead of bounding it. Gating the READ is what makes the backpressure
            // end-to-end: the kernel PTY buffer fills and the child blocks on its next write().
            read_inflight.acquire(PTY_INFLIGHT_HIGH_WATER_BYTES, PTY_INFLIGHT_STALL);
            // Both gates cleared: the observer is being fed again, so its screen is live.
            read_observer.set_reader_parked(false);
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    // Drain every decodable byte into `out`. Keep valid text, SKIP genuinely
                    // invalid sequences (replacement char) so we never stall, and keep an
                    // incomplete trailing multibyte for the next read. Coalesce this read's output
                    // into one shared-buffer append (one lock/notify per read, not per sub-slice).
                    let mut out = String::new();
                    loop {
                        match std::str::from_utf8(&pending) {
                            Ok(s) => {
                                if !s.is_empty() {
                                    out.push_str(s);
                                    pending.clear();
                                }
                                break;
                            }
                            Err(e) => {
                                let valid = e.valid_up_to();
                                match e.error_len() {
                                    // Invalid bytes: keep valid prefix + U+FFFD, consume them.
                                    Some(bad) => {
                                        out.push_str(
                                            &String::from_utf8_lossy(&pending[..valid + bad]),
                                        );
                                        pending.drain(..valid + bad);
                                    }
                                    // Incomplete tail: keep valid prefix, hold the rest.
                                    None => {
                                        if valid > 0 {
                                            out.push_str(
                                                &String::from_utf8_lossy(&pending[..valid]),
                                            );
                                            pending.drain(..valid);
                                        }
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    push(out);
                }
                Err(_) => break 'read,
            }
        }
        // Signal EOF/close so the flusher drains any remaining buffer, then WAIT for it: this
        // guarantees the final `pty:output` is emitted before `pty:exit` below, so no trailing
        // output is lost or reordered past the exit event.
        {
            let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
            guard.done = true;
            cvar.notify_one();
        }
        // Release the credit gate BEFORE joining: if the flusher (or this thread) were parked
        // waiting on acks that will never come — the terminal is unmounting, so nobody is left to
        // ack — the join below would hang and the session would never be reaped. Closing lets the
        // final drain emit unconditionally, which is also what guarantees no trailing output is
        // lost on EOF.
        read_inflight.close();
        let _ = flusher.join();
        // Reap the session on natural exit (pty_kill also removes it) — but ONLY IF THE MAP STILL
        // HOLDS THIS LIFE. An id-keyed remove here is the teardown twin of an id-keyed insert: after
        // an overlapping spawn, the loser's session was silently replaced while its reader thread
        // stayed alive, so this line would delete the WINNER — a session whose PTY is running and
        // whose terminal the user is typing into. `pty_write`/`resize`/`kill` would then answer
        // "no such pty" for a live PTY, with no `pty:exit` to explain it (the loser's exit carries
        // the lower epoch and is filtered out by design), and `live_epoch` would drop to NO_EPOCH
        // while a higher-epoch session runs, so an observer's floor would admit a stale exit.
        let reap = read_app.state::<PtyManager>().reap(&read_id, epoch);
        finish_teardown(&read_app.state::<crate::nudger::Observers>(), &read_id, reap);
        // Stamped with THIS session's epoch, not with whatever is currently in the map under this
        // id. By the time a replaced reader gets here the map may already hold its SUCCESSOR, and
        // reporting the successor's epoch would be worse than reporting none: the new terminal would
        // accept its predecessor's death as its own, which is the exact misreading the epoch exists
        // to prevent.
        let _ = read_app.emit("pty:exit", PtyEnd { id: read_id.clone(), epoch });
    });

    Ok(epoch)
}

/// Clone out a session's per-session writer handle under a BRIEF hold of the global `sessions` lock,
/// so the caller does the (potentially blocking) write with only that handle locked — never the
/// global map. This is the core of sparkle-4orh; split out so the lock discipline is unit-testable.
fn acquire_writer(
    sessions: &Mutex<HashMap<String, PtySession>>,
    id: &str,
) -> Result<Arc<Mutex<Box<dyn Write + Send>>>, String> {
    let guard = sessions.lock().unwrap_or_else(|e| e.into_inner());
    Ok(guard.get(id).ok_or(NO_SUCH_PTY)?.writer.clone())
}

/// Write to a PTY's stdin — e.g. an approval decision ("y\n" / "n\n") or user input.
#[tauri::command]
pub fn pty_write(
    manager: State<PtyManager>,
    observers: State<crate::nudger::Observers>,
    id: String,
    data: String,
) -> Result<(), String> {
    // Tell the nudger somebody else is typing here, BEFORE the write rather than after: the stamp
    // must already be in place while the bytes are in flight, or a nudger tick landing between the
    // write and the stamp would see a quiet terminal and add its own keystroke.
    //
    // This is what closes a hazard that has no analogue on the JS side. Every JS write goes through
    // `chainPtyOp` (pty.ts), which serializes a bracketed paste and its trailing carriage return as
    // ONE operation; a Rust write bypasses that chain entirely, so a byte landing inside another
    // writer's 60ms paste→CR window would append to — and then SUBMIT — a prompt the user never
    // sent (roborev 54369/54375). The nudger stands down for 5s after this stamp.
    if let Some(observer) = observers.get(&id) {
        observer.note_foreign_write();
    }
    // Take this session's OWN writer handle, releasing the global `sessions` lock BEFORE the write.
    // A large paste into a stalled child then blocks only this writer, leaving spawn/write/resize/
    // kill for every other terminal responsive (sparkle-4orh).
    let writer = acquire_writer(&manager.sessions, &id)?;
    let mut writer = writer.lock().unwrap_or_else(|e| e.into_inner());
    writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Write to a PTY's stdin from INSIDE Rust, without the `note_foreign_write` stamp `pty_write`
/// applies.
///
/// The nudger is the only caller and the omission is the point: this write is the nudger's own, so
/// stamping it would make the module stand itself down. Everything else about the path is identical
/// — same `acquire_writer`, same lock discipline (sparkle-4orh), same `NO_SUCH_PTY` error, which the
/// frontend substring-matches, so it must keep its exact wording.
pub fn write_session<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
    data: &str,
) -> Result<(), String> {
    let manager = app.try_state::<PtyManager>().ok_or(NO_SUCH_PTY)?;
    let writer = acquire_writer(&manager.sessions, id)?;
    let mut writer = writer.lock().unwrap_or_else(|e| e.into_inner());
    writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Pause or resume the PTY reader for flow control (). The frontend calls this when its
/// xterm write backlog crosses the high/low-water marks. Only touches this session's pause gate, so
/// it never blocks other terminals. Benign "no such pty" race is swallowed frontend-side.
#[tauri::command]
pub fn pty_set_paused(manager: State<PtyManager>, id: String, paused: bool) -> Result<(), String> {
    let sessions = manager.sessions.lock().unwrap_or_else(|e| e.into_inner());
    let session = sessions.get(&id).ok_or(NO_SUCH_PTY)?;
    session.pause.set(paused);
    Ok(())
}

/// Release `bytes` of IPC emit credit for a PTY — the frontend calls this once xterm has PARSED a
/// `pty:output` chunk, echoing back the `bytes` field the chunk arrived with. This is the consumer
/// half of the credit gate that bounds the otherwise-unbounded Tauri IPC queue (see
/// `InflightState`). Fire-and-forget frontend-side; the benign "no such pty" teardown race is
/// swallowed there like the other PTY ops.
#[tauri::command]
pub fn pty_ack(manager: State<PtyManager>, id: String, bytes: usize) -> Result<(), String> {
    let sessions = manager.sessions.lock().unwrap_or_else(|e| e.into_inner());
    let session = sessions.get(&id).ok_or(NO_SUCH_PTY)?;
    session.inflight.ack(bytes);
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    manager: State<PtyManager>,
    observers: State<crate::nudger::Observers>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // Backstop against the thin-column bug (see guard_resize_size): never shrink a live PTY below
    // the plausible floor, whatever the frontend sent.
    let (cols, rows) = guard_resize_size(&id, cols, rows);
    // Keep the nudger's VT grid the same shape as the real one. Width is not cosmetic here: a
    // prompt longer than the grid hard-wraps onto its own rendered row, which splits the word from
    // its colon and silently stops the gate's credential patterns matching — the width-dependent
    // miss `dictationTerminalRoute.ts` had to grow a wrap-tolerant arm for.
    if let Some(observer) = observers.get(&id) {
        observer.resize(cols, rows);
    }
    let sessions = manager.sessions.lock().unwrap_or_else(|e| e.into_inner());
    let session = sessions.get(&id).ok_or(NO_SUCH_PTY)?;
    session
        .master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Mark a deliberately-killed agent so the session reaper cannot resurrect it.
///
/// ── WHY THIS IS IN RUST, INSIDE `pty_kill` (roborev 61714) ────────────────────────────────────
/// It was briefly done in `pty.ts`, as an `await` before the `pty_kill` invoke. That is a real
/// regression and the reason is timing, not correctness: `SatelliteApp`'s teardown depends on
/// `pty_kill` being DISPATCHED SYNCHRONOUSLY from the unmount — its `CLOSE_SETTLE_MS` (250ms) is a
/// budget for ONE round-trip before the webview is `destroy()`ed, and `Terminal`'s cleanup is
/// `void`-ed so nothing awaits it. Putting an invoke in front means the continuation carrying
/// `pty_kill` is torn down with the JS context if the first call has not resolved — and the PTY is
/// then never killed at all, which is precisely the orphaned-child case that budget exists to
/// prevent. One command, dispatched once, with the order guaranteed on this side instead.
///
/// ── WHY `Dead` AND NOT `Retired` (roborev 61714) ──────────────────────────────────────────────
/// `Retired` carries more meaning than "do not resurrect": `derive` maps it to
/// `ReaperVerdict::Reapable` UNCONDITIONALLY, with none of the `PROTECTION_MAX` grace `Dead` gets.
/// But "stop the agents when I close this window" is explicitly not "delete them" — the records and
/// tabs are meant to survive — and the promotion cutover kills the LOCAL pty for an agent that is
/// still alive in the cloud on that same worktree. Marking either `Reapable` would hand a worktree
/// holding uncommitted work to any future reaper.
///
/// ── AND WHY THE CAUSE IS `HumanStopped`, NOT `Unknown` (2026-08-13) ───────────────────────────
/// It was `Unknown`, under a comment here claiming it "needs no new vocabulary" because `deathTypes`
/// documents `unknown` as "a human clicking stop produces exactly this observation". The
/// observation matched; the CONCLUSION was backwards. Writing a stop as `Unknown` is what forced
/// `is_resurrectable` to refuse the entire class — an ordinary crash is `Unknown`/`PtyExit` too —
/// so protecting this one path made every unexplained death permanently unrecoverable (25 of 76
/// records on the founder's install). The stop now has its own cause and its own evidence, so it is
/// still never resurrected, `Unknown` recovers, and both keep the ordinary protection window.
///
/// ONLY a `Live` record is touched, so this can never downgrade a richer verdict a window already
/// observed (a met goal, a wall, a transport banner). Failure is swallowed: a ledger write is an
/// affordance, and it must never keep alive a process the user asked to be gone.
///
/// ── OFF THE MAIN THREAD (roborev 61770) ───────────────────────────────────────────────────────
/// The mechanism itself is `agent_life::mark_stopped_at`, so a test can drive it; this only resolves
/// the directory. It must NOT run on the main thread: `close_at` writes a temp file, `fsync`s it and
/// renames, and `windowClose.stopOpenProjectAgents` / `ProjectModal` fire one `pty_kill` PER AGENT.
/// Serialized in front of the AppKit event loop that is a read + an fsync each, inside the very
/// 250ms `CLOSE_SETTLE_MS` budget this design exists to protect, on the same thread the concierge
/// bridge needs — the round-trip regression coming back through another channel.
fn mark_stopped_before_kill(app: &AppHandle, id: &str, stopped_by: Option<&str>) {
    let Ok(base) = crate::dev_identity::app_data_dir(app) else { return };
    let dir = crate::agent_life::life_dir(&base);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    if let Err(e) = crate::agent_life::mark_stopped_at(&dir, id, now, stopped_by) {
        // WARN, not debug: a stop that failed to record is a stop the resurrector may undo.
        tracing::warn!(target: "pty", %id, error = %e, "could not mark a deliberate stop");
    }
}

/// How long teardown will hold the PTY open waiting for Claude Code's `SessionEnd` hook to append
/// its line. A CEILING, not a cost: the ordinary case returns as soon as the line lands (a node
/// start plus an `appendFileSync`, typically well under 300ms), and an agent with no hook log at
/// all skips the wait entirely.
///
/// Sized against the thing it must not break — the QUIT sweep. Do not read the ceiling as rare:
/// an agent whose Claude Code child has already exited still HAS a hook log, so
/// `session_end_drain_target` returns `Some` and the drain waits out the full deadline for a line
/// that will never come. Only an agent with no log at all takes the fast path.
///
/// That made the per-agent cost multiply on quit, because `windowClose::stopOpenProjectAgents`
/// awaited one `pty_kill` per agent IN SEQUENCE — 20 agents × 750ms is 15s of hung window with the
/// close prompt already dismissed (roborev 62743). That sweep now runs its kills concurrently, and
/// `kills the agents CONCURRENTLY…` in `windowClose.test.ts` pins it.
///
/// The cost model that survives, stated exactly, because this constant is what someone consults
/// before changing it (roborev 62786): the quit costs about one deadline **PER PROJECT**, not one
/// overall. `killAllOpenAgents` still awaits `stopOpenProjectAgents` per project IN SEQUENCE —
/// deliberately, so a slow PTY kill can't race a later runtime write — and one window hosts every
/// project as a tab. So this multiplies by the number of projects holding open agents (5 projects
/// ≈ 3.75s), and raising it multiplies by P. Nothing pins that cross-project factor; only the
/// within-project concurrency is tested.
const SESSION_END_DRAIN: Duration = Duration::from_millis(750);
/// Poll interval for [`await_session_end_flush`]. Short, because the whole point is to release the
/// PTY as soon as the line is there; each poll is a seek plus a read of the bytes appended since.
const SESSION_END_DRAIN_POLL: Duration = Duration::from_millis(15);

/// The marker `sparkle-hook.mjs` writes for a session's last event. Matched as a substring of the
/// appended bytes rather than parsed: the emitter writes one compact JSON object per line with no
/// spaces around the colon (`resources/sparkle-hook.mjs`), and `engine/sparkleHook.test.ts`
/// round-trips that exact shape, so the substring is pinned from both ends.
const SESSION_END_MARKER: &str = "\"event\":\"SessionEnd\"";

/// Has a `SessionEnd` line been appended to `log` PAST `from_offset`?
///
/// `from_offset` is the length of the log captured BEFORE the signal, and it is the whole
/// correctness of this: an agent's log is APPEND-ONLY ACROSS LIVES (`<app_data>/hook-events/
/// <agentId>.jsonl` is keyed by agent, not by session), so every restart leaves its predecessor's
/// `SessionEnd` behind. Scanning the whole file would find one of those instantly and the drain
/// would be a no-op that always reports success — the vacuous shape this function exists to avoid.
///
/// A partial trailing line is deliberately tolerated. `appendFileSync` of a sub-`PIPE_BUF` line is
/// atomic in practice, but a torn read costs only one more 15ms poll, whereas requiring a trailing
/// newline would spin out the whole deadline on the last line of a file that never gets another.
fn session_end_flushed(log: &Path, from_offset: u64) -> bool {
    use std::io::{Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(log) else { return false };
    if f.seek(SeekFrom::Start(from_offset)).is_err() {
        return false;
    }
    let mut tail = String::new();
    // Lossy on purpose: the marker is ASCII, so a truncated multi-byte read can never fabricate or
    // destroy a match, and refusing to look at non-UTF8 bytes would just stall the drain.
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return false;
    }
    tail.push_str(&String::from_utf8_lossy(&buf));
    tail.contains(SESSION_END_MARKER)
}

/// Block until a `SessionEnd` line lands past `from_offset`, or `deadline` elapses. Returns whether
/// the line arrived.
///
/// BOUNDED BY CONSTRUCTION: a hook that never runs (no `node` on PATH, a settings file Claude never
/// read, a child already gone) costs exactly `deadline` and then teardown proceeds. Losing the line
/// is the status quo; hanging teardown on it would be worse than the defect.
fn await_session_end_flush(log: &Path, from_offset: u64, deadline: Duration, poll: Duration) -> bool {
    let start = std::time::Instant::now();
    loop {
        if session_end_flushed(log, from_offset) {
            return true;
        }
        if start.elapsed() >= deadline {
            return false;
        }
        std::thread::sleep(poll.min(deadline.saturating_sub(start.elapsed())));
    }
}

/// Where this agent's hook line will land, and how long the log is RIGHT NOW.
///
/// Resolved BEFORE the signal so the offset cannot include the very line we are about to wait for.
/// `None` when there is no hook log to drain — a sign-in PTY, a cloud agent, an agent whose hooks
/// never installed — and a `None` skips the wait rather than spending the deadline on it.
fn session_end_drain_target(app: &AppHandle, id: &str) -> Option<(PathBuf, u64)> {
    let log = crate::hooks::event_log_path(app, id).ok()?;
    let len = std::fs::metadata(&log).ok()?.len();
    Some((log, len))
}

/// What a drain ended up doing — enough to log the interesting case and nothing more.
#[derive(Debug, PartialEq, Eq)]
enum Drain {
    /// No hook log to wait on, so the PTY was released immediately.
    NothingToDrain,
    /// The `SessionEnd` line landed; the PTY was held until it did.
    Flushed,
    /// The deadline elapsed first. The line is lost — the status quo — but teardown proceeds.
    TimedOut,
}

/// Hold the PTY open until this session's `SessionEnd` line is on disk, then release it.
///
/// TAKES THE SESSION BY VALUE, which is the entire mechanism: dropping [`PtySession`] runs
/// `UnixMasterWriter::drop`, which writes `\n` + termios `VEOF` into the pty — an **EOF on the
/// child's stdin** that hurries Claude Code out, and with it the `SessionEnd` hook still writing.
/// (It is NOT a hangup: the reader thread holds a dup of the master, so SIGHUP does not reach the
/// foreground group until that dup closes too — see [`pty_kill`] for the full chain.) Because the
/// value is moved in here and dropped at the end of this body, "release the PTY after the flush" is
/// a fact about ownership that no caller can reverse, rather than a comment about ordering.
///
/// Split out of [`pty_kill`] so it is DRIVABLE: `pty_kill` is a `#[tauri::command]` taking an
/// `AppHandle`, so a test cannot call it, and a test that instead re-performed take → wait → drop
/// in its own body would be asserting an order it created itself — green even with the wait deleted
/// from the command. This function is the whole of what `pty_kill` does after the signal, so
/// driving it drives the real path.
fn drain_then_release(
    session: PtySession,
    target: Option<(PathBuf, u64)>,
    deadline: Duration,
    poll: Duration,
) -> Drain {
    // Named binding, not `_`: `let _ = session` would drop it HERE, at the top, reopening the exact
    // race this exists to close. It lives until the end of the body.
    let _session = session;
    let Some((log, from)) = target else {
        return Drain::NothingToDrain;
    };
    if await_session_end_flush(&log, from, deadline, poll) {
        Drain::Flushed
    } else {
        Drain::TimedOut
    }
}

/// Kill a PTY the user deliberately stopped.
///
/// `async` + `spawn_blocking` because the body does ledger I/O — see `mark_stopped_before_kill`.
/// That does NOT weaken the guarantee the frontend depends on: `killPty` still issues exactly ONE
/// invoke, dispatched synchronously from the unmount, and both halves stay inside this one command,
/// so the mark-then-kill order holds without a second round-trip. It is strictly better than doing
/// the work in JS, because once dispatched this runs in the Rust process and a webview torn down
/// mid-flight cannot cancel it.
///
/// ── THE SIGNAL AND THE RELEASE ARE TWO SEPARATE MOMENTS (bead sparkle-8hrqe) ──────────────────
/// `killer.kill()` is portable-pty's `ProcessSignaller`, which on unix is `libc::kill(pid, SIGHUP)`
/// — a request to shut down, not a `SIGKILL`. Claude Code answers it by running its `SessionEnd`
/// hook, which spawns `node resources/sparkle-hook.mjs` to append one line to the agent's event
/// log. The old shape signalled and released in the same breath, and raced its own hook.
///
/// WHAT THE RELEASE ACTUALLY DOES, precisely — the obvious story is wrong, and a wrong mechanism is
/// how a future maintainer "optimises" this hold away (roborev 62743). Dropping [`PtySession`] does
/// NOT hang up the slave's foreground process group, because it does not close the master: both
/// `try_clone_reader` and `take_writer` **dup** the master fd (portable-pty 0.8.1
/// `src/unix.rs:314`/`:321`), and the reader thread holds one of those dups for as long as it runs.
/// SIGHUP reaches the foreground group only on the LAST close.
///
/// What the drop does do is run `UnixMasterWriter::drop` (`unix.rs:351`), which writes `\n` plus the
/// termios `VEOF` byte into the pty — it feeds the foreground child an **EOF on its stdin**. That is
/// what hurries Claude Code out. And once Claude Code exits, the slave closes, the reader thread
/// sees EOF and drops ITS dup, and only then does the master's last fd close and SIGHUP reach
/// whatever is still in the foreground group — a `node` hook that has not finished writing.
///
/// So the release does not kill the hook directly; it STARTS the chain that does. Deferring the drop
/// defers that EOF, which is the fix. (Note `writer` is an `Arc<Mutex<..>>` that `pty_write` clones
/// out briefly, so the EOF fires on the last reference, not necessarily on this drop.)
///
/// Measured on the founder's machine: 6,665 `SessionStart` lines against 6,286 `SessionEnd` — 379
/// sessions (5.7%) that ended with no line, across 228 of 441 logs. A missing line is not cosmetic:
/// `engine/deathRecord` reads `session-end-hook` as the evidence that an agent ended on purpose,
/// and without it the death falls back to `pty-exit`/`unknown`.
///
/// So: capture the log length, mark, signal, then hold the session — the EOF not yet sent — until
/// the line lands or [`SESSION_END_DRAIN`] elapses, and only then drop it. The drop is moved INTO
/// the blocking hop, which is what makes "release the PTY after the flush" a fact about ownership
/// rather than a comment about ordering.
#[tauri::command]
pub async fn pty_kill(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    id: String,
    // WHICH CALL SITE asked for this. Optional on the wire so an older front-end still works, and
    // absent means UNKNOWN rather than "a human did it" — see `agent_life::Death::stopped_by`.
    stopped_by: Option<String>,
) -> Result<(), String> {
    tracing::info!(%id, stopped_by = stopped_by.as_deref().unwrap_or("<unknown>"), "pty_kill");
    // Resolved BEFORE anything else touches the log, so the offset is a floor under our own signal.
    let target = session_end_drain_target(&app, &id);
    // BEFORE the kill, so there is no window in which the session is gone and the record still
    // reads `Live` — the exact state `reap_dead_sessions_at` seals as `process-gone`.
    //
    // Only the LEDGER write goes off-thread — it is the only part that touches the disk. The kill
    // itself is a mutex plus a signal, so it finishes back here (mirrors `pty_spawn`, which does its
    // blocking openpty/spawn off-thread and the cheap map wiring on the async side). Awaiting the
    // hop before the kill is what keeps the order.
    let mark_app = app.clone();
    let mark_id = id.clone();
    let mark_reason = stopped_by.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        mark_stopped_before_kill(&mark_app, &mark_id, mark_reason.as_deref());
    })
    .await;
    // Signal on the async side (a mutex plus a signal, as before); the WAIT and the release go to a
    // blocking thread, because the session is moved there and dropped there.
    if let Some(session) = take_and_signal_session(&manager, &id) {
        let _ = tauri::async_runtime::spawn_blocking(move || {
            if drain_then_release(session, target, SESSION_END_DRAIN, SESSION_END_DRAIN_POLL)
                == Drain::TimedOut
            {
                // DEBUG, not warn: a drained-out session is the ordinary shape for an agent whose
                // hooks were never installed, and this fires once per such teardown.
                tracing::debug!(target: "pty", %id, "no SessionEnd line before the drain deadline");
            }
        })
        .await;
    }
    Ok(())
}

/// Take the session out of the map and signal its child — the whole of `pty_kill`'s effect on a
/// live PTY EXCEPT closing the master, which is what dropping the returned [`PtySession`] does.
///
/// Extracted so it can be DRIVEN by a test rather than hand-simulated in one. It replaced a
/// `kill_session` that did both halves in one breath; that wrapper is gone rather than kept for its
/// callers, because once `pty_kill` stopped calling it the only code left calling it was tests —
/// a function whose sole exerciser is the suite guarding it proves nothing about production.
///
/// The REMOVAL BY ID is what makes `Reap::AlreadyGone` the ordinary case: the session leaves the
/// map HERE, and the reader thread that later wakes on its child's EOF finds nothing under its id.
/// A test that reproduces that by reaching into the map itself asserts a precondition it created —
/// it stays green if this function stops removing by id at all. Driving this reds that.
///
/// Handing the session BACK is the other half of the point, and it is a fact about ownership rather
/// than a comment about ordering: while the caller holds the value, the writer's `Drop` has not run,
/// so the EOF that hurries Claude Code out has not been written into the pty and a `SessionEnd` hook
/// still has time to finish. [`drain_then_release`] uses that window; a caller with no hook line to
/// wait for just drops it.
///
/// What no synchronous caller can observe is the order of the three statements BELOW against each
/// other — by the time this returns, all of them have run. `kill_resumes_a_reader_parked_on_the_
/// pause_gate_and_closes_the_credit_gate` pins that the resume and the close HAPPEN (deleting
/// either reds it); the interleaving against `killer.kill()` is pinned by nothing, and claiming
/// otherwise in a comment is how the last vacuous test here got written.
///
/// Returns `None` when there was no live session to take.
fn take_and_signal_session(manager: &PtyManager, id: &str) -> Option<PtySession> {
    let mut sessions = manager.sessions.lock().unwrap_or_else(|e| e.into_inner());
    let Some(mut session) = sessions.remove(id) else {
        // No live session — but a spawn may be mid-flight, with its child already running and not
        // yet in the map (bead sparkle-82vey). Flag it WHILE STILL HOLDING the `sessions` lock, so
        // `insert_session` (which takes the same lock) cannot slip the child in after we return
        // "killed". A no-op when nothing is spawning.
        manager.mark_spawn_cancelled(id);
        return None;
    };
    // Release the map lock before the kill itself — the original brief-hold shape — now that the
    // removal (or cancel-mark) is done.
    drop(sessions);
    // If the reader is parked (paused) it won't observe the kill's EOF and would never run its
    // teardown (reap + pty:exit). Resume it first so it wakes, reads EOF, and cleans up.
    session.pause.set(false);
    // Same hazard, second gate: a reader or flusher parked waiting for acks will get none once
    // the terminal is gone. Close the credit gate so both proceed, drain, and tear down.
    session.inflight.close();
    let _ = session.killer.kill();
    Some(session)
}

/// Every agent id with a live PTY session in THIS process.
///
/// The process-global backstop for the resurrection path. `decideResurrection` already requires
/// `processAlive === false`, and `services/goalContinuationRunner`'s ownership election already stops
/// two WINDOWS acting on one agent — but both of those are window-local evidence, and the PTY host
/// is app-global: `pty_spawn` from any webview reaches any agent id. This is the one reading that
/// cannot be wrong about it.
///
/// Sync deliberately, like its `pty_ack`/`pty_resize` siblings: the body is a mutex lock and a clone
/// of a short `Vec<String>`, with no I/O of any kind, so there is nothing to move off the main
/// thread. The commands that must be `async` are the ones that touch the disk.
#[tauri::command]
pub fn pty_live_sessions(manager: State<PtyManager>) -> Vec<String> {
    manager.session_ids()
}

/// The epoch of the PTY currently live under `id`, or `0` when none is — the sentinel
/// [`next_pty_epoch`] reserves and never mints.
///
/// A LOWER BOUND for an OBSERVER, and that is the only thing it is for. A caller that is about to
/// cause a re-spawn and then wait for the new PTY cannot identify the life it is waiting for (the
/// epoch does not exist yet), but it CAN identify every life that already exists — and since epochs
/// strictly increase, "exited with an epoch greater than the one live when I started watching" is
/// exactly "the life I am waiting for died". Without that floor the observer accepts the death of
/// the PREDECESSOR its own spawn is tearing down, which is the misreading the epoch exists to close,
/// merely relocated into the waiter (`agentDemotion/live.ts`).
///
/// `0` on an unknown id is deliberately not an error: "nothing is live" is a real, useful answer —
/// it means every exit that follows belongs to a life spawned after the caller started watching.
///
/// Sync for the same reason as `pty_live_sessions`: a mutex lock and a `u64` copy, no I/O.
#[tauri::command]
pub fn pty_live_epoch(id: String, manager: State<PtyManager>) -> u64 {
    manager.live_epoch(&id)
}

#[cfg(test)]
mod epoch_tests {
    use super::{next_pty_epoch, PtyEnd};

    // THE ONE PROPERTY THE WHOLE MECHANISM RESTS ON: two PTYs never share an epoch. The session id
    // IS the agent id, so a restart reuses it; the epoch is the only thing that separates a
    // terminal's own death from its predecessor's, and an epoch handed out twice would let exactly
    // the misreading this exists to prevent back in for the pair that collided.
    #[test]
    fn epochs_are_unique_and_increasing() {
        let a = next_pty_epoch();
        let b = next_pty_epoch();
        let c = next_pty_epoch();
        assert!(a < b && b < c, "epochs must strictly increase, got {a} {b} {c}");
    }

    // Concurrent spawns are the realistic case — the resurrection runner brings a cohort back at
    // once, and `pty_spawn` mints before any lock is taken. A counter that raced would hand two
    // simultaneously-revived agents the same epoch.
    #[test]
    fn concurrent_minting_never_collides() {
        const THREADS: usize = 8;
        const PER_THREAD: usize = 250;
        let handles: Vec<_> = (0..THREADS)
            .map(|_| std::thread::spawn(|| (0..PER_THREAD).map(|_| next_pty_epoch()).collect::<Vec<_>>()))
            .collect();
        let mut all: Vec<u64> = handles.into_iter().flat_map(|h| h.join().expect("thread")).collect();
        let minted = all.len();
        all.sort_unstable();
        all.dedup();
        assert_eq!(all.len(), minted, "every minted epoch must be distinct");
    }

    // 0 is reserved as the "no PTY has spawned yet" sentinel, so a real spawn must never mint it —
    // otherwise a transport that has not spawned would match a real exit.
    #[test]
    fn zero_is_never_minted() {
        assert!(next_pty_epoch() > 0);
    }

    // The exit event must actually CARRY the epoch over the wire. Serialized here rather than
    // asserted on the struct because the frontend reads JSON: a field that stopped being emitted
    // (a rename, a `skip_serializing_if`) would leave the TS filter comparing against `undefined`
    // and silently forwarding every exit again — the original bug, with the Rust side still green.
    #[test]
    fn exit_payload_serializes_its_epoch() {
        let json = serde_json::to_string(&PtyEnd { id: "agent-7".into(), epoch: 42 })
            .expect("PtyEnd must serialize");
        assert!(json.contains("\"epoch\":42"), "epoch missing from {json}");
        assert!(json.contains("\"id\":\"agent-7\""), "id missing from {json}");
    }
}

#[cfg(test)]
mod tests {
    use super::{
        acquire_writer, apply_heap_cap, apply_test_worker_cap, config_dir_from_args, spawn_account_from_args, SpawnAccount,
        guard_resize_size, guard_spawn_size,
        insert_or_cancel,
        next_pty_epoch,
        node_options_with_cap, run_flusher, test_worker_env_value, validate_spawn_inner, Credit, FlushBuf, InflightState,
        finish_teardown, PauseState, PtyManager, PtyEnd, PtySession, Reap,
        await_session_end_flush, drain_then_release, session_end_flushed, take_and_signal_session,
        Drain,
        MIN_PTY_COLS,
        MIN_PTY_ROWS, NO_EPOCH,
        PTY_INFLIGHT_HIGH_WATER_BYTES, SPAWN_FALLBACK_COLS, SPAWN_FALLBACK_ROWS,
    };
    use portable_pty::CommandBuilder;
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::Duration;

    static SEQ: AtomicU32 = AtomicU32::new(0);

    /// A panic while the `sessions` mutex is held poisons it. The poison-tolerant locks
    /// (`unwrap_or_else(|e| e.into_inner())`) must recover the guard so later PTY operations keep
    /// working rather than panicking forever and wedging every terminal app-wide.
    #[test]
    fn sessions_lock_recovers_after_poison() {
        let manager = std::sync::Arc::new(PtyManager::default());
        // Poison the mutex: panic while holding the lock on a separate thread.
        let m = manager.clone();
        let _ = std::thread::spawn(move || {
            let _guard = m.sessions.lock().unwrap();
            panic!("poison the sessions mutex");
        })
        .join();
        assert!(manager.sessions.is_poisoned(), "mutex should be poisoned by the panic");
        // reap() goes through the poison-tolerant lock and must not panic. Asserted on the ACTUAL
        // production reap path (every reader thread ends here), not on a helper only tests call —
        // a poison-tolerance test aimed at an unused function guards nothing.
        assert_eq!(manager.reap("nonexistent", 1), Reap::AlreadyGone);
        // And the recovered guard still points at a usable HashMap.
        let len = manager.sessions.lock().unwrap_or_else(|e| e.into_inner()).len();
        assert_eq!(len, 0);
    }

    // ── per-agent V8 heap cap (sparkle-01xv / sparkle-asz5) ───────────────────────────────
    // On 2026-07-20 the kernel JetsamEvent reports showed 24 `claude` subprocesses each grown to
    // ~4 GiB — V8's DEFAULT heap ceiling — summing to 99 GiB and killing the machine. Every agent
    // PTY child now spawns with an explicit `--max-old-space-size`, so a runaway agent hits OUR
    // ceiling long before it hits Node's.

    #[test]
    fn node_options_sets_the_cap_when_the_user_has_none() {
        assert_eq!(node_options_with_cap(None, 3072).as_deref(), Some("--max-old-space-size=3072"));
        // An empty inherited value is the same as absent (no leading space in the result).
        assert_eq!(node_options_with_cap(Some(""), 3072).as_deref(), Some("--max-old-space-size=3072"));
        assert_eq!(
            node_options_with_cap(Some("   "), 3072).as_deref(),
            Some("--max-old-space-size=3072")
        );
    }

    #[test]
    fn node_options_appends_to_a_users_existing_value_instead_of_clobbering_it() {
        // The user's flags MUST survive — NODE_OPTIONS is commonly used for --require shims,
        // --enable-source-maps, proxy certs, etc. Clobbering it would silently break their setup.
        let got = node_options_with_cap(Some("--enable-source-maps"), 3072);
        assert_eq!(got.as_deref(), Some("--enable-source-maps --max-old-space-size=3072"));
    }

    #[test]
    fn node_options_lets_an_explicit_user_heap_size_win() {
        // If the user already pinned a heap size, that's a deliberate choice — leave it alone
        // rather than appending a second (conflicting) flag.
        let got = node_options_with_cap(Some("--max-old-space-size=8192"), 3072);
        assert_eq!(got.as_deref(), Some("--max-old-space-size=8192"));
        // ...including the `=`-less and mid-string spellings.
        let got = node_options_with_cap(Some("--enable-source-maps --max-old-space-size 8192"), 3072);
        assert_eq!(got.as_deref(), Some("--enable-source-maps --max-old-space-size 8192"));
        let got = node_options_with_cap(Some("--max_old_space_size=8192"), 3072);
        assert_eq!(got.as_deref(), Some("--max_old_space_size=8192"));
    }

    /// roborev 40812. The check was `contains("--max-old-space-size")`, which also fires on an
    /// unrelated token that merely EMBEDS the flag name. Reading that as "the user already set a
    /// heap limit" suppresses the cap entirely — the one outcome sparkle-01xv exists to prevent
    /// (24 uncapped agents summing 99 GiB). The match must be per token.
    #[test]
    fn node_options_is_not_fooled_by_a_token_that_merely_embeds_the_flag_name() {
        // A require path that happens to contain the flag name. The cap MUST still be appended.
        let got = node_options_with_cap(Some("--require ./max-old-space-size-helper.js"), 3072);
        assert_eq!(
            got.as_deref(),
            Some("--require ./max-old-space-size-helper.js --max-old-space-size=3072"),
            "an embedded occurrence is not the user setting the flag"
        );

        // A longer flag that merely starts with the same characters.
        let got = node_options_with_cap(Some("--max-old-space-size-foo=1"), 3072);
        assert_eq!(
            got.as_deref(),
            Some("--max-old-space-size-foo=1 --max-old-space-size=3072"),
            "a different flag sharing the prefix is not the user setting the flag"
        );

        // And the real thing is still honoured — the fix must not overshoot into ignoring the user.
        let got = node_options_with_cap(Some("--require ./x.js --max-old-space-size=8192"), 3072);
        assert_eq!(got.as_deref(), Some("--require ./x.js --max-old-space-size=8192"));
    }

    #[test]
    fn node_options_is_left_alone_when_the_cap_is_disabled() {
        // agent_heap_mb = 0 is the documented escape hatch: no cap, and no NODE_OPTIONS churn.
        assert_eq!(node_options_with_cap(None, 0), None);
        assert_eq!(node_options_with_cap(Some("--enable-source-maps"), 0), None);
    }

    #[test]
    fn apply_heap_cap_sets_node_options_on_the_spawned_command() {
        let mut cmd = CommandBuilder::new("/bin/echo");
        apply_heap_cap(&mut cmd, None, 3072);
        assert_eq!(
            cmd.get_env("NODE_OPTIONS").and_then(|v| v.to_str()),
            Some("--max-old-space-size=3072")
        );
    }

    #[test]
    fn apply_heap_cap_merges_the_inherited_value_onto_the_spawned_command() {
        let mut cmd = CommandBuilder::new("/bin/echo");
        apply_heap_cap(&mut cmd, Some("--enable-source-maps".into()), 3072);
        assert_eq!(
            cmd.get_env("NODE_OPTIONS").and_then(|v| v.to_str()),
            Some("--enable-source-maps --max-old-space-size=3072")
        );
    }

    #[test]
    fn apply_heap_cap_touches_nothing_when_disabled() {
        let mut cmd = CommandBuilder::new("/bin/echo");
        // Compare against what the builder reported BEFORE the call rather than against `None`.
        // `CommandBuilder` inherits the process environment, and `get_env` surfaces the inherited
        // value — so asserting `None` really asserts "NODE_OPTIONS is unset in whoever ran the
        // tests". That holds on CI and fails for anyone running the suite inside a Sparkle agent,
        // because Sparkle sets NODE_OPTIONS=--max-old-space-size=… on its agents: this very
        // feature. The intent here is "touches nothing", and before/after states exactly that,
        // whatever the ambient env happens to be.
        let before = cmd.get_env("NODE_OPTIONS").map(|v| v.to_owned());
        apply_heap_cap(&mut cmd, Some("--enable-source-maps".into()), 0);
        assert_eq!(
            cmd.get_env("NODE_OPTIONS").map(|v| v.to_owned()),
            before,
            "a disabled cap must leave NODE_OPTIONS exactly as inherited"
        );
    }

    // ── per-agent vitest worker cap ───────────────────────────────────────────────────────
    #[test]
    fn test_worker_env_value_injects_the_cap_when_the_user_has_not() {
        // The narrowing case: no user override, a computed cap → inject its string form.
        assert_eq!(test_worker_env_value(false, Some(1)), Some("1".to_string()));
        assert_eq!(test_worker_env_value(false, Some(4)), Some("4".to_string()));
    }

    #[test]
    fn test_worker_env_value_defers_to_a_user_override() {
        // The user exported SPARKLE_TEST_MAX_WORKERS themselves — their choice wins, so we set
        // nothing regardless of what the machine-wide division would have picked.
        assert_eq!(test_worker_env_value(true, Some(1)), None);
        assert_eq!(test_worker_env_value(true, None), None);
    }

    #[test]
    fn test_worker_env_value_is_none_when_nothing_narrows() {
        // No cap to apply (division at/above the pool default, or cores unmeasurable) → leave the
        // pool's own default in charge.
        assert_eq!(test_worker_env_value(false, None), None);
    }

    #[test]
    fn apply_test_worker_cap_sets_the_override_on_the_spawned_command() {
        // env() overrides any inherited value, so this is robust even when the suite itself runs
        // inside a Sparkle agent that already has SPARKLE_TEST_MAX_WORKERS set.
        let mut cmd = CommandBuilder::new("/bin/echo");
        apply_test_worker_cap(&mut cmd, false, Some(2));
        assert_eq!(
            cmd.get_env("SPARKLE_TEST_MAX_WORKERS").and_then(|v| v.to_str()),
            Some("2"),
            "a computed cap must reach the child as SPARKLE_TEST_MAX_WORKERS"
        );
    }

    #[test]
    fn apply_test_worker_cap_touches_nothing_when_the_user_set_it() {
        // Before/after rather than asserting None: the builder inherits the process env, so an
        // ambient SPARKLE_TEST_MAX_WORKERS (a Sparkle agent running these tests) would otherwise
        // make a "None" assertion depend on who launched the suite. The intent is "touches nothing".
        let mut cmd = CommandBuilder::new("/bin/echo");
        let before = cmd.get_env("SPARKLE_TEST_MAX_WORKERS").map(|v| v.to_owned());
        apply_test_worker_cap(&mut cmd, true, Some(1));
        assert_eq!(
            cmd.get_env("SPARKLE_TEST_MAX_WORKERS").map(|v| v.to_owned()),
            before,
            "a user override must leave SPARKLE_TEST_MAX_WORKERS exactly as inherited"
        );
    }

    // ── thin-column backstop ──────────────────────────────────────────────────────────────
    #[test]
    fn spawn_size_passes_a_plausible_size_through() {
        assert_eq!(guard_spawn_size("a", 132, 44), (132, 44));
        // Exactly at the floor is plausible.
        assert_eq!(guard_spawn_size("a", MIN_PTY_COLS, MIN_PTY_ROWS), (MIN_PTY_COLS, MIN_PTY_ROWS));
    }

    #[test]
    fn spawn_size_replaces_a_thin_size_with_the_fallback() {
        // The exact sizes seen in the wild (cols=11/12, rows=5/7) that produced the compressed
        // terminal: a too-small COLS or too-small ROWS each trigger the wholesale fallback.
        assert_eq!(guard_spawn_size("a", 11, 5), (SPAWN_FALLBACK_COLS, SPAWN_FALLBACK_ROWS));
        assert_eq!(guard_spawn_size("a", 12, 7), (SPAWN_FALLBACK_COLS, SPAWN_FALLBACK_ROWS));
        assert_eq!(guard_spawn_size("a", 200, 2), (SPAWN_FALLBACK_COLS, SPAWN_FALLBACK_ROWS));
        assert_eq!(guard_spawn_size("a", 0, 0), (SPAWN_FALLBACK_COLS, SPAWN_FALLBACK_ROWS));
    }

    #[test]
    fn resize_size_floors_each_dimension_without_resetting() {
        // A plausible resize is honored exactly.
        assert_eq!(guard_resize_size("a", 100, 40), (100, 40));
        // A thin resize is floored per-dimension (NOT reset to a default), so a genuine
        // resize to a slightly-small pane is honored as closely as is safe.
        assert_eq!(guard_resize_size("a", 11, 40), (MIN_PTY_COLS, 40));
        assert_eq!(guard_resize_size("a", 100, 2), (100, MIN_PTY_ROWS));
        assert_eq!(guard_resize_size("a", 11, 5), (MIN_PTY_COLS, MIN_PTY_ROWS));
    }

    /// The thin-column floor + spawn fallback are duplicated in the frontend guard
    /// (terminalSize.ts) and kept in sync only by a comment. If the two layers drift, a thin
    /// size can slip through one of them — the exact failure this backstop exists to prevent.
    /// This test reads terminalSize.ts and fails if the values diverge (roborev 17540).
    #[test]
    fn backstop_constants_match_the_frontend_guard() {
        // cargo test runs with CWD = the crate dir (apps/desktop/src-tauri).
        let ts = std::fs::read_to_string("../src/components/terminalSize.ts")
            .expect("read terminalSize.ts");
        // Pull `export const NAME = <int>;` out of the TS source.
        let val = |name: &str| -> u16 {
            let pat = format!("{name} = ");
            let after = ts.split(&pat).nth(1).unwrap_or_else(|| panic!("{name} not found in terminalSize.ts"));
            after
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse()
                .unwrap_or_else(|_| panic!("{name} is not an integer in terminalSize.ts"))
        };
        assert_eq!(val("MIN_PLAUSIBLE_COLS"), MIN_PTY_COLS, "cols floor drifted from terminalSize.ts");
        assert_eq!(val("MIN_PLAUSIBLE_ROWS"), MIN_PTY_ROWS, "rows floor drifted from terminalSize.ts");
        assert_eq!(val("SPAWN_FALLBACK_COLS"), SPAWN_FALLBACK_COLS, "spawn-fallback cols drifted");
        assert_eq!(val("SPAWN_FALLBACK_ROWS"), SPAWN_FALLBACK_ROWS, "spawn-fallback rows drifted");
    }

    /// Create a unique `<tmp>/-test-<pid>-<n>` with a real `worktrees/proj/agent`
    /// inside, and return the `worktrees` base.
    fn worktrees_base() -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("-test-{}-{}", std::process::id(), n));
        let _ = fs::remove_dir_all(&root);
        let base = root.join("worktrees");
        fs::create_dir_all(base.join("proj").join("agent")).unwrap();
        base
    }

    /// `managed_base` is `<app_data>` — the parent of the `<app_data>/worktrees` base returned by
    /// `worktrees_base()`. It exists (the helper created it), so it canonicalizes.
    fn managed_of(worktrees: &std::path::Path) -> PathBuf {
        worktrees.parent().unwrap().to_path_buf()
    }

    #[test]
    fn rejects_relative_or_empty_command() {
        let base = worktrees_base();
        let managed = managed_of(&base);
        assert!(validate_spawn_inner(&base, &managed, "", None).is_err());
        assert!(validate_spawn_inner(&base, &managed, "bin/zsh", None).is_err());
        // An absolute allowlisted binary passes the command check even if it doesn't exist (we only
        // require absoluteness + an allowlisted basename, not existence — the legit cmd is /bin/zsh).
        assert!(validate_spawn_inner(&base, &managed, "/bin/zsh", None).is_ok());
    }

    #[test]
    fn null_cwd_falls_back_to_the_managed_dir() {
        // A null cwd (the pre-worktree login flows) no longer skips the containment check: it
        // resolves to the managed app-data dir so the spawn still runs in a validated location.
        let base = worktrees_base();
        let managed = managed_of(&base);
        let got = validate_spawn_inner(&base, &managed, "/bin/zsh", None).unwrap();
        assert_eq!(got, managed.canonicalize().unwrap());
    }

    #[test]
    fn accepts_cwd_inside_worktrees() {
        let base = worktrees_base();
        let managed = managed_of(&base);
        let cwd = base.join("proj").join("agent");
        let got =
            validate_spawn_inner(&base, &managed, "/bin/zsh", Some(cwd.to_str().unwrap())).unwrap();
        assert_eq!(got, cwd.canonicalize().unwrap());
    }

    #[test]
    fn rejects_cwd_outside_worktrees() {
        let base = worktrees_base();
        let managed = managed_of(&base);
        let outside = std::env::temp_dir();
        assert!(
            validate_spawn_inner(&base, &managed, "/bin/zsh", Some(outside.to_str().unwrap()))
                .is_err()
        );
    }

    /// AN ACCOUNT CONFIG DIR IS NOT A LEGAL cwd — this is the mechanism behind sparkle-mahbf.
    ///
    /// `<app_data>/accounts/<id>` is a SIBLING of `<app_data>/worktrees`, not a child, so handing it
    /// to `pty_spawn` as the cwd is refused every single time. The embedded `claude auth login` did
    /// exactly that, which is why "Add account" could never open a login pane and its "Start again"
    /// re-ran an identically doomed spawn. The frontend fix is to pass NO cwd (the account is
    /// targeted by `CLAUDE_CONFIG_DIR`); this test pins the constraint that makes that the only
    /// correct answer, so nobody "helpfully" restores the cwd later.
    #[test]
    fn rejects_an_account_config_dir_as_cwd() {
        let base = worktrees_base();
        let managed = managed_of(&base);
        let account_dir = managed.join("accounts").join("602064ad688be368");
        std::fs::create_dir_all(&account_dir).unwrap();
        let err = validate_spawn_inner(&base, &managed, "/bin/zsh", account_dir.to_str())
            .expect_err("an account config dir must not be accepted as a spawn cwd");
        assert!(
            err.contains("outside the managed worktrees directory"),
            "expected the containment refusal, got: {err}"
        );
        // …and the sanctioned alternative — no cwd at all — is accepted, landing in the managed dir.
        assert_eq!(
            validate_spawn_inner(&base, &managed, "/bin/zsh", None).unwrap(),
            managed.canonicalize().unwrap()
        );
    }

    /// A REFUSAL MUST NAME WHAT IT REFUSED — the second half of sparkle-s7wu6.
    ///
    /// PR #1635 made Terminal render this string instead of dropping it into `console.debug`, so
    /// it is now the user-visible explanation for a permanently doomed spawn. A message that says
    /// a boundary was crossed without naming either side leaves the reader exactly where the
    /// swallowed log did. These assert the offending VALUE is present, not merely the phrase —
    /// each one is red against the pre-change messages.
    #[test]
    fn containment_refusal_names_the_cwd_and_the_base() {
        let base = worktrees_base();
        let managed = managed_of(&base);
        let account_dir = managed.join("accounts").join("602064ad688be368");
        std::fs::create_dir_all(&account_dir).unwrap();
        let err = validate_spawn_inner(&base, &managed, "/bin/zsh", account_dir.to_str())
            .expect_err("an account config dir must not be accepted as a spawn cwd");
        // The phrase every substring-matching frontend consumer keys on survives ahead of the detail.
        assert!(
            err.contains("outside the managed worktrees directory"),
            "the matched prefix must not move: {err}"
        );
        let real_account = account_dir.canonicalize().unwrap();
        assert!(
            err.contains(&real_account.display().to_string()),
            "the refusal must name the rejected cwd: {err}"
        );
        assert!(
            err.contains(&base.canonicalize().unwrap().display().to_string()),
            "the refusal must name the boundary it compared against: {err}"
        );
    }

    #[test]
    fn unresolvable_cwd_refusal_names_the_path() {
        let base = worktrees_base();
        let managed = managed_of(&base);
        // A worktree that was pruned out from under a restart — the common runtime shape of this
        // failure, and the one whose bare "No such file or directory (os error 2)" says nothing.
        let gone = base.join("proj").join("deleted-agent");
        let err = validate_spawn_inner(&base, &managed, "/bin/zsh", gone.to_str())
            .expect_err("a nonexistent cwd must be refused");
        assert!(err.contains("invalid cwd"), "expected the canonicalize refusal, got: {err}");
        assert!(
            err.contains(&gone.display().to_string()),
            "the refusal must name the path that could not be resolved: {err}"
        );
    }

    #[test]
    fn binary_refusal_names_the_command() {
        let base = worktrees_base();
        let managed = managed_of(&base);
        let cwd = base.join("proj").join("agent");
        let err = validate_spawn_inner(&base, &managed, "/usr/bin/osascript", cwd.to_str())
            .expect_err("a disallowed binary must be refused");
        assert!(
            err.contains("/usr/bin/osascript"),
            "the refusal must name the binary it rejected: {err}"
        );
    }

    #[test]
    fn rejects_dotdot_escape_cwd() {
        let base = worktrees_base();
        let managed = managed_of(&base);
        // <base>/proj/agent/../../.. climbs above the worktrees base.
        let escape = base.join("proj").join("agent").join("..").join("..").join("..");
        assert!(
            validate_spawn_inner(&base, &managed, "/bin/zsh", Some(escape.to_str().unwrap()))
                .is_err()
        );
    }

    #[test]
    fn rejects_sibling_prefix_dir() {
        // A string-prefix compare would wrongly admit `<app_data>/worktrees-evil`; component-wise
        // starts_with must reject it. This test pins that behavior.
        let base = worktrees_base();
        let managed = managed_of(&base);
        let sibling = base.with_file_name("worktrees-evil");
        fs::create_dir_all(&sibling).unwrap();
        assert!(
            validate_spawn_inner(&base, &managed, "/bin/zsh", Some(sibling.to_str().unwrap()))
                .is_err()
        );
    }

    #[test]
    fn rejects_a_disallowed_binary() {
        // A compromised webview can't turn pty_spawn into an arbitrary-exec primitive by naming
        // some other absolute binary — even with a perfectly valid, worktree-contained cwd.
        let base = worktrees_base();
        let managed = managed_of(&base);
        let cwd = base.join("proj").join("agent");
        let cwd_s = cwd.to_str().unwrap();
        for evil in ["/usr/bin/osascript", "/usr/bin/curl", "/bin/rm", "/usr/bin/python3"] {
            assert!(
                validate_spawn_inner(&base, &managed, evil, Some(cwd_s)).is_err(),
                "{evil} must be rejected by the binary allowlist"
            );
        }
    }

    #[test]
    fn accepts_allowlisted_binary_basenames() {
        // Every basename the app legitimately spawns (or resolves in preflight) passes, wherever it
        // lives — the check is lexical on the basename, not on the binary existing at that path.
        let base = worktrees_base();
        let managed = managed_of(&base);
        let cwd = base.join("proj").join("agent");
        let cwd_s = cwd.to_str().unwrap();
        for ok in [
            "/bin/zsh",
            "/bin/bash",
            "/opt/homebrew/bin/node",
            "/usr/local/bin/git",
            "/Users/x/.local/bin/claude",
        ] {
            assert!(
                validate_spawn_inner(&base, &managed, ok, Some(cwd_s)).is_ok(),
                "{ok} should pass the binary allowlist"
            );
        }
    }

    #[test]
    fn accepts_a_binary_under_the_managed_dir() {
        // A binary the app bundles/manages under <app_data> is allowed even if its basename isn't
        // in the allowlist — it lives inside a trusted root.
        let base = worktrees_base();
        let managed = managed_of(&base);
        let bin_dir = managed.join("bin");
        fs::create_dir_all(&bin_dir).unwrap();
        let helper = bin_dir.join("sparkle-helper");
        fs::write(&helper, b"#!/bin/sh\n").unwrap();
        let cwd = base.join("proj").join("agent");
        assert!(
            validate_spawn_inner(&base, &managed, helper.to_str().unwrap(), Some(cwd.to_str().unwrap()))
                .is_ok()
        );
        // ...but a same-named binary OUTSIDE the managed dir is still rejected.
        let outside = std::env::temp_dir().join("sparkle-helper-not-managed");
        fs::write(&outside, b"#!/bin/sh\n").unwrap();
        assert!(
            validate_spawn_inner(&base, &managed, outside.to_str().unwrap(), Some(cwd.to_str().unwrap()))
                .is_err()
        );
    }

    // ── sparkle-0bye: the memory watchdog's view of live sessions ─────────────────────────────

    // ── which account a PTY was launched under (config_dir_from_args / spawn_config_dir) ───────
    //
    // These decode the ONE fact the Rust side has no other way to learn: which Claude Max account
    // an agent runs as. It is consumed by a founder-facing flag that says "re-authenticate THIS
    // login", so the failure that matters is not "no answer" — it is a CONFIDENT WRONG answer.
    // Hence the fail-closed cases below are asserted as deliberate behaviour, not as edge cases.

    /// The realistic shape: `buildClaudeExec` with an account chosen, arriving as the `zsh -l -c`
    /// body. The whole script is ONE arg, so the parser has to find the export inside it.
    #[test]
    fn config_dir_from_a_real_build_claude_exec_script_is_the_account_path() {
        let script = r#"export CLAUDE_CONFIG_DIR='/Users/agent/.claude-accounts/work'; export PATH="$HOME/.local/bin:$PATH"; exec '/Users/agent/.local/bin/claude' --dangerously-skip-permissions --model 'claude-opus-5' -- 'go build the thing'"#;
        let args = vec!["-l".to_string(), "-c".to_string(), script.to_string()];
        assert_eq!(
            config_dir_from_args(&args).as_deref(),
            Some("/Users/agent/.claude-accounts/work"),
            "the account path must come back WITHOUT its shell quoting — it is compared against \
             on-disk config dirs, not re-fed to a shell"
        );
    }

    /// A path with an apostrophe, written exactly the way `shellQuote` writes it: `'\''` is
    /// close-quote / literal-apostrophe / reopen-quote. Decoding it naively stops at the first
    /// inner quote and yields a TRUNCATED path — which is the wrong-account failure mode, since a
    /// truncated path is still a plausible-looking string a flag would happily show a human.
    #[test]
    fn a_config_dir_containing_an_apostrophe_decodes_back_to_the_literal_character() {
        let script = r#"export CLAUDE_CONFIG_DIR='/Users/x/O'\''Brien/.claude'; export PATH="$HOME/.local/bin:$PATH"; exec '/usr/bin/claude'"#;
        let args = vec!["-l".to_string(), "-c".to_string(), script.to_string()];
        assert_eq!(
            config_dir_from_args(&args).as_deref(),
            Some("/Users/x/O'Brien/.claude"),
            "shellQuote's '\\'' escape must decode back to one literal apostrophe, not truncate \
             the path at it"
        );
    }

    /// No export at all — the imported DEFAULT account. This is an ordinary, correct answer, not a
    /// parse failure: `buildClaudeExec` omits the export entirely when no account was chosen.
    #[test]
    fn a_spawn_with_no_config_dir_export_reports_no_explicit_account() {
        let script = r#"export PATH="$HOME/.local/bin:$PATH"; exec '/Users/agent/.local/bin/claude' --dangerously-skip-permissions"#;
        let args = vec!["-l".to_string(), "-c".to_string(), script.to_string()];
        assert_eq!(
            config_dir_from_args(&args),
            None,
            "no export means the default account — there is no path to report"
        );
    }

    /// `export CLAUDE_CONFIG_DIR=''` is not an account named "". An empty path would name a
    /// directory that cannot exist, so it must read the same as "no explicit dir".
    #[test]
    fn an_empty_config_dir_export_is_no_account_not_an_empty_path() {
        let args = vec![
            "-c".to_string(),
            r#"export CLAUDE_CONFIG_DIR=''; export PATH="$HOME/.local/bin:$PATH"; exec '/usr/bin/claude'"#
                .to_string(),
        ];
        assert_eq!(config_dir_from_args(&args), None, "an empty value names no account");

        let bare = vec!["-c".to_string(), "export CLAUDE_CONFIG_DIR=; exec claude".to_string()];
        assert_eq!(
            config_dir_from_args(&bare),
            None,
            "an unquoted export with nothing after the `=` names no account either"
        );
    }

    /// An unterminated quote answers `None` ON PURPOSE. The tempting alternative — take everything
    /// to the end of the string — yields a path that LOOKS like an answer, and this value is shown
    /// to a human as the login to go re-authenticate. Naming the wrong account is worse than
    /// naming none, so the parser fails closed.
    #[test]
    fn an_unterminated_quote_fails_closed_rather_than_naming_a_truncated_path() {
        let single =
            vec!["-c".to_string(), "export CLAUDE_CONFIG_DIR='/Users/x/.claude".to_string()];
        assert_eq!(
            config_dir_from_args(&single),
            None,
            "FAIL CLOSED IS DELIBERATE: an unterminated single quote must not yield a \
             best-effort path — a half-parsed path names the WRONG login, which is worse than \
             naming none"
        );

        let double =
            vec!["-c".to_string(), r#"export CLAUDE_CONFIG_DIR="/Users/x/.claude"#.to_string()];
        assert_eq!(
            config_dir_from_args(&double),
            None,
            "FAIL CLOSED IS DELIBERATE: the same rule holds for an unterminated double quote"
        );
    }

    /// `buildClaudeLoginExec`'s shape — the config export followed by the ANTHROPIC unset block.
    /// This is the spawn where the account matters MOST: it is the one that performs the sign-in,
    /// so a flag naming the wrong dir sends the founder to re-authenticate the wrong account.
    #[test]
    fn a_login_spawn_script_reports_the_account_it_is_signing_into() {
        let script = r#"export CLAUDE_CONFIG_DIR='/Users/agent/.claude-accounts/second'; unset ANTHROPIC_API_KEY ANTHROPIC_API ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_CUSTOM_HEADERS CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX; export PATH="$HOME/.local/bin:$PATH"; exec '/Users/agent/.local/bin/claude' auth login"#;
        let args = vec!["-l".to_string(), "-c".to_string(), script.to_string()];
        assert_eq!(
            config_dir_from_args(&args).as_deref(),
            Some("/Users/agent/.claude-accounts/second"),
            "the unset block sits between the export and the exec — it must not confuse the scan"
        );
    }

    /// The variable NAME appearing in prose is not a selection. Spawn args carry the user's prompt
    /// and persona text, so a message that merely talks about `CLAUDE_CONFIG_DIR` is a normal
    /// thing to see — and reading it as an account would attribute an agent to a login at random.
    #[test]
    fn an_arg_that_merely_mentions_the_variable_in_prose_is_not_a_selection() {
        let args = vec![
            "-l".to_string(),
            "-c".to_string(),
            r#"export PATH="$HOME/.local/bin:$PATH"; exec '/usr/bin/claude' -- 'Check whether CLAUDE_CONFIG_DIR is set correctly, and echo $CLAUDE_CONFIG_DIR if so'"#
                .to_string(),
        ];
        assert_eq!(
            config_dir_from_args(&args),
            None,
            "only a real `export CLAUDE_CONFIG_DIR=` counts — a mention in prompt text does not"
        );

        let glued = vec!["-c".to_string(), "noexport CLAUDE_CONFIG_DIR=/tmp/x; exec claude".to_string()];
        assert_eq!(
            config_dir_from_args(&glued),
            None,
            "the export must start a shell word, not be glued to the end of another token"
        );
    }

    /// "NO EXPORT" AND "AN EXPORT WE COULD NOT READ" ARE DIFFERENT ANSWERS (roborev 65537, Medium).
    ///
    /// Collapsed into one `None`, every fail-closed refusal in this parser reached the founder as
    /// the DEFAULT ACCOUNT BY NAME — a confident wrong login, which is the precise harm the
    /// refusals exist to prevent. The three-state result is what lets the consumer say "could not
    /// identify" instead of guessing.
    #[test]
    fn an_undecodable_export_is_unknown_and_never_reads_as_the_default_account() {
        assert_eq!(
            spawn_account_from_args(&[
                "-c".to_string(),
                r#"export PATH="$HOME/.local/bin:$PATH"; exec '/usr/bin/claude'"#.to_string(),
            ]),
            SpawnAccount::Default,
            "no export at all IS the imported default — a positive answer, not a failure"
        );

        for (label, script) in [
            ("an unterminated quote", "export CLAUDE_CONFIG_DIR='/never/closed"),
            ("an empty value", "export CLAUDE_CONFIG_DIR=''; exec claude"),
            ("the needle with nothing after it", "export CLAUDE_CONFIG_DIR="),
        ] {
            assert_eq!(
                spawn_account_from_args(&["-c".to_string(), script.to_string()]),
                SpawnAccount::Unknown,
                "{label}: an export we cannot decode means the account is UNKNOWN — reporting it \
                 as the default would name a login the spawn never used"
            );
        }

        assert_eq!(
            spawn_account_from_args(&[
                "-c".to_string(),
                "export CLAUDE_CONFIG_DIR='/a/work'; exec claude".to_string(),
            ]),
            SpawnAccount::Dir("/a/work".to_string()),
            "and a decodable one still answers the dir, so the three-state form did not cost the \
             ordinary answer"
        );
    }

    /// THE PARSER MUST NOT DEPEND ON AN UNPINNED TYPESCRIPT ORDERING (roborev 65537, Medium).
    ///
    /// A first fix required the export to be the script's very FIRST token. That is true of
    /// `buildClaudeExec` today, but it made this parser's correctness rest on a cross-language
    /// invariant nothing enforced: move `BD_READONLY`, the inbox export, or a future `cd …` ahead
    /// of it and BOTH suites stay green while the account label silently dies.
    ///
    /// The boundary is `exec` instead, which is structural rather than incidental: the exports set
    /// the command up, and the agent's PROMPT — the only adversarial text in the string — is an
    /// argument TO that command, so it always lies after `exec`.
    #[test]
    fn the_export_is_found_anywhere_in_the_prelude_but_never_after_exec() {
        let reordered = vec![
            "-c".to_string(),
            r#"export BD_READONLY=1; export SPARKLE_INBOX_AGENT='a-1'; export CLAUDE_CONFIG_DIR='/a/work'; export PATH="$HOME/.local/bin:$PATH"; exec '/usr/bin/claude' -- 'hi'"#
                .to_string(),
        ];
        assert_eq!(
            config_dir_from_args(&reordered).as_deref(),
            Some("/a/work"),
            "an export that is not FIRST but is still in the prelude must be found — otherwise a \
             harmless reorder in claudeSpawn.ts silently unnames the login"
        );

        let only_after_exec = vec![
            "-c".to_string(),
            r#"export PATH="$HOME/.local/bin:$PATH"; exec '/usr/bin/claude' -- 'run: export CLAUDE_CONFIG_DIR=/tmp/attacker && claude'"#
                .to_string(),
        ];
        assert_eq!(
            spawn_account_from_args(&only_after_exec),
            SpawnAccount::Default,
            "everything after `exec` is the command's ARGUMENTS, prompt included — never a \
             selection, and not even an `Unknown`, because no export was really attempted"
        );

        // `noexec`/`execute` must not be mistaken for the boundary: a false `exec` shrinks the
        // prelude and loses a real export; a missed one widens the search back over the prompt.
        let decoy = vec![
            "-c".to_string(),
            "export NOTE='noexec execute'; export CLAUDE_CONFIG_DIR='/a/work'; exec claude"
                .to_string(),
        ];
        assert_eq!(
            config_dir_from_args(&decoy).as_deref(),
            Some("/a/work"),
            "`noexec` and `execute` are not the exec word"
        );

        // A BARE `exec` inside a quoted VALUE is data, not the command word. Counting it would cut
        // the prelude short, miss the real export, and report Default — a positive claim that this
        // agent runs on the default account, made because we failed to look. Same
        // confident-wrong-login shape the three-state result exists to stop.
        let exec_inside_a_value = vec![
            "-c".to_string(),
            "export NOTE='run exec later'; export CLAUDE_CONFIG_DIR='/a/work'; exec claude"
                .to_string(),
        ];
        assert_eq!(
            config_dir_from_args(&exec_inside_a_value).as_deref(),
            Some("/a/work"),
            "a quoted `exec` must not truncate the prelude and silently lose the real export"
        );

        // …and the double-quoted form, where a backslash escapes the next character.
        let exec_inside_a_double_quoted_value = vec![
            "-c".to_string(),
            r#"export NOTE="run exec \" later"; export CLAUDE_CONFIG_DIR='/a/work'; exec claude"#
                .to_string(),
        ];
        assert_eq!(
            config_dir_from_args(&exec_inside_a_double_quoted_value).as_deref(),
            Some("/a/work"),
            "double-quoted values are skipped too, escapes included"
        );
    }

    /// THE AGENT'S OWN PROMPT CANNOT NAME A LOGIN (roborev 65501, Medium).
    ///
    /// The prompt travels INSIDE the same `zsh -c` script string as the exports, so a task that
    /// quotes a shell line genuinely does start a shell word — a word-boundary rule matches it. On
    /// the common single-account spawn there is no real export at all, so that prose would be the
    /// ONLY match and the founder's row would name a login the spawn never used. A wrong name is
    /// worse than no name, because a wrong name is acted on.
    ///
    /// The paired positive is the point: a REAL export in the same script still wins, so anchoring
    /// bought safety without costing the answer. Without that half this test would pass against a
    /// parser that had simply stopped working.
    #[test]
    fn a_config_dir_export_quoted_inside_the_prompt_never_names_an_account() {
        let prose_only = vec![
            "-c".to_string(),
            r#"export PATH="$HOME/.local/bin:$PATH"; exec '/usr/bin/claude' -- 'To reproduce, run: export CLAUDE_CONFIG_DIR=/tmp/attacker && claude -p hi'"#
                .to_string(),
        ];
        assert_eq!(
            config_dir_from_args(&prose_only),
            None,
            "a full export quoted in the TASK TEXT must not be read as this spawn's account — \
             that is the confidently-wrong login the whole parser fails closed to avoid"
        );

        let real_export_plus_prose = vec![
            "-c".to_string(),
            r#"export CLAUDE_CONFIG_DIR='/Users/x/.claude-accounts/work'; export PATH="$HOME/.local/bin:$PATH"; exec '/usr/bin/claude' -- 'To reproduce, run: export CLAUDE_CONFIG_DIR=/tmp/attacker && claude -p hi'"#
                .to_string(),
        ];
        assert_eq!(
            config_dir_from_args(&real_export_plus_prose).as_deref(),
            Some("/Users/x/.claude-accounts/work"),
            "and the REAL export still decides, so anchoring did not just break the parser"
        );
    }

    /// Double-quoted and bare values are accepted too — nothing in `claudeSpawn.ts` emits them
    /// today, but a hand-built or future spawn script is not a reason to lose the account.
    #[test]
    fn double_quoted_and_bare_config_dir_values_are_both_decoded() {
        let quoted = vec![
            "-c".to_string(),
            r#"export CLAUDE_CONFIG_DIR="/Users/x/.claude-accounts/a b"; exec claude"#.to_string(),
        ];
        assert_eq!(
            config_dir_from_args(&quoted).as_deref(),
            Some("/Users/x/.claude-accounts/a b"),
            "a double-quoted value keeps its spaces and drops its quotes"
        );

        let bare = vec![
            "-c".to_string(),
            "export CLAUDE_CONFIG_DIR=/Users/x/.claude; exec claude".to_string(),
        ];
        assert_eq!(
            config_dir_from_args(&bare).as_deref(),
            Some("/Users/x/.claude"),
            "a bare value ends at the `;` — the rest of the script is not part of the path"
        );

        let bare_space = vec![
            "-c".to_string(),
            "export CLAUDE_CONFIG_DIR=/Users/x/.claude exec claude".to_string(),
        ];
        assert_eq!(
            config_dir_from_args(&bare_space).as_deref(),
            Some("/Users/x/.claude"),
            "a bare value ends at whitespace too"
        );
    }

    /// The FIRST occurrence decides, across args and within one arg — and it decides even when it
    /// is the malformed one. Falling through to a later, parseable export would turn a script we
    /// do not understand into a confident answer, which is the outcome fail-closed exists to stop.
    #[test]
    fn the_first_config_dir_export_wins_even_when_it_is_the_unparseable_one() {
        let two_args = vec![
            "export CLAUDE_CONFIG_DIR='/first/.claude'; exec a".to_string(),
            "export CLAUDE_CONFIG_DIR='/second/.claude'; exec b".to_string(),
        ];
        assert_eq!(
            config_dir_from_args(&two_args).as_deref(),
            Some("/first/.claude"),
            "the earlier arg's export is the answer"
        );

        let one_arg = vec![
            "-c".to_string(),
            "export CLAUDE_CONFIG_DIR='/first/.claude'; export CLAUDE_CONFIG_DIR='/second/.claude'; exec a"
                .to_string(),
        ];
        assert_eq!(
            config_dir_from_args(&one_arg).as_deref(),
            Some("/first/.claude"),
            "within one script the first export is the answer"
        );

        // A genuinely unterminated first export (its quote never closes, in its own arg) followed
        // by a perfectly good one. Falling through would answer /second with total confidence.
        let broken_first = vec![
            "export CLAUDE_CONFIG_DIR='/unterminated".to_string(),
            "export CLAUDE_CONFIG_DIR='/second/.claude'; exec b".to_string(),
        ];
        assert_eq!(
            config_dir_from_args(&broken_first),
            None,
            "a malformed FIRST export must not fall through to a later one and name /second — \
             that would be exactly the confident wrong answer we fail closed to avoid"
        );

        // Worth pinning because it LOOKS unterminated and is not: zsh closes that first quote with
        // the one that opens `/second`, making the whole middle one single-quoted word. We read it
        // the same way the shell would rather than guessing at the author's intent.
        let quote_swallows_the_next_export = vec![
            "-c".to_string(),
            "export CLAUDE_CONFIG_DIR='/a; export CLAUDE_CONFIG_DIR='/second/.claude'".to_string(),
        ];
        assert_eq!(
            config_dir_from_args(&quote_swallows_the_next_export).as_deref(),
            Some("/a; export CLAUDE_CONFIG_DIR="),
            "the first quote is closed by the second export's opening quote — shell semantics, \
             not a fall-through to /second"
        );
    }

    /// This runs on the spawn path, on whatever the frontend sent. It must be total: no panic, no
    /// slice-on-a-char-boundary crash, for empty args, bare needles, or multi-byte paths.
    #[test]
    fn the_config_dir_parser_never_panics_on_degenerate_or_multibyte_input() {
        assert_eq!(config_dir_from_args(&[]), None, "no args at all");
        assert_eq!(config_dir_from_args(&["".to_string()]), None, "an empty arg");
        assert_eq!(
            config_dir_from_args(&["export CLAUDE_CONFIG_DIR=".to_string()]),
            None,
            "the needle with nothing after it"
        );
        assert_eq!(
            config_dir_from_args(&["export CLAUDE_CONFIG_DIR='/Users/x/日本/.claude'; exec c"
                .to_string()])
            .as_deref(),
            Some("/Users/x/日本/.claude"),
            "multi-byte text inside the value must not break the byte-index slicing"
        );
        assert_eq!(
            config_dir_from_args(&["日本語 export CLAUDE_CONFIG_DIR='/Users/x/日本/.claude'; exec c"
                .to_string()])
            .as_deref(),
            Some("/Users/x/日本/.claude"),
            "…and multi-byte text BEFORE it must not break the byte indexing either: the export is \
             still in the prelude (before `exec`), so it is still the real signal"
        );
        assert_eq!(
            config_dir_from_args(&["日本語CLAUDE_CONFIG_DIR=x".to_string()]),
            None,
            "a multi-byte character immediately before a non-export mention must not panic"
        );
    }

    /// The reader half. `spawn_config_dir` must hand back what the session recorded — and its
    /// `None` must be understood as AMBIGUOUS: it is the same answer for "this session is on the
    /// default account" and "there is no such session". A caller that reads it as the former will
    /// name the wrong login every time it is really the latter, which is why the doc comment says
    /// so and why both halves are pinned here.
    #[test]
    fn spawn_config_dir_reports_the_recorded_account_and_is_ambiguous_when_it_reports_none() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        let sys = native_pty_system();
        let Ok(pair) =
            sys.openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        else {
            return; // no PTY in this environment — skip
        };
        let Ok(mut child) = pair.slave.spawn_command(CommandBuilder::new("/bin/cat")) else {
            return;
        };
        let killer = child.clone_killer();
        let pid = child.process_id();
        let writer = pair.master.take_writer().expect("take_writer");
        let mgr = PtyManager::default();

        // Insert the way production does — through `insert_session`, carrying the field the spawn
        // decoded, so this exercises the same path `pty_spawn` uses rather than a hand-built map.
        let epoch = mgr.insert_session(
            "agent-on-work-account".to_string(),
            PtySession {
                writer: Arc::new(Mutex::new(writer)),
                master: pair.master,
                killer,
                pause: Arc::new(PauseState::new()),
                inflight: Arc::new(InflightState::new()),
                pid,
                epoch: NO_EPOCH,
                config_dir: spawn_account_from_args(&[
                    "-c".to_string(),
                    r#"export CLAUDE_CONFIG_DIR='/Users/agent/.claude-accounts/work'; export PATH="$HOME/.local/bin:$PATH"; exec '/usr/bin/claude'"#
                        .to_string(),
                ]),
            },
        );
        assert!(epoch > NO_EPOCH, "the session must actually have been inserted");

        assert_eq!(
            mgr.spawn_config_dir("agent-on-work-account").as_deref(),
            Some("/Users/agent/.claude-accounts/work"),
            "the account decoded at spawn must survive into the map and come back out"
        );

        // Case 2 of the documented ambiguity: no session under this id.
        assert_eq!(
            mgr.spawn_config_dir("agent-that-never-spawned"),
            None,
            "an unknown id answers None — and a caller must NOT read that as 'the default \
             account'; `live_epoch` is what separates 'no session' from 'no explicit dir'"
        );
        assert_eq!(
            mgr.live_epoch("agent-that-never-spawned"),
            NO_EPOCH,
            "…which is the check that disambiguates it"
        );

        // Case 1 of the ambiguity: a LIVE session with no explicit dir gives the identical answer.
        let sys2 = native_pty_system();
        let Ok(pair2) =
            sys2.openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        else {
            return;
        };
        let Ok(mut child2) = pair2.slave.spawn_command(CommandBuilder::new("/bin/cat")) else {
            return;
        };
        let killer2 = child2.clone_killer();
        let pid2 = child2.process_id();
        let writer2 = pair2.master.take_writer().expect("take_writer");
        mgr.insert_session(
            "agent-on-default-account".to_string(),
            PtySession {
                writer: Arc::new(Mutex::new(writer2)),
                master: pair2.master,
                killer: killer2,
                pause: Arc::new(PauseState::new()),
                inflight: Arc::new(InflightState::new()),
                pid: pid2,
                epoch: NO_EPOCH,
                config_dir: spawn_account_from_args(&[
                    "-c".to_string(),
                    r#"export PATH="$HOME/.local/bin:$PATH"; exec '/usr/bin/claude'"#.to_string(),
                ]),
            },
        );
        assert_eq!(
            mgr.spawn_config_dir("agent-on-default-account"),
            None,
            "a live default-account session answers None too — SAME value as the unknown id above"
        );
        assert!(
            mgr.live_epoch("agent-on-default-account") > NO_EPOCH,
            "…and only liveness tells the two Nones apart, which is the whole doc-comment caveat"
        );

        let _ = child.kill();
        let _ = child.wait();
        let _ = child2.kill();
        let _ = child2.wait();
    }

    /// `session_pids` must report the REAL spawned pid, keyed by session id, for every session that
    /// has one — and skip the ones that don't. `memwatch::agent_footprints` walks the process tree
    /// from these roots, so a wrong or missing pid silently makes an agent invisible to the
    /// watchdog (it would report 0 bytes, which reads as "healthy" rather than "unmeasured").
    #[test]
    fn session_pids_reports_the_spawned_pid_and_skips_sessions_without_one() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        let sys = native_pty_system();
        let Ok(pair) =
            sys.openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        else {
            return; // no PTY in this environment — skip
        };
        let Ok(mut child) = pair.slave.spawn_command(CommandBuilder::new("/bin/cat")) else {
            return;
        };
        let killer = child.clone_killer();
        let pid = child.process_id();
        assert!(pid.is_some(), "portable_pty must report a pid for a live child");
        let writer = pair.master.take_writer().expect("take_writer");
        let mgr = PtyManager::default();
        mgr.sessions.lock().unwrap().insert(
            "agent-with-pid".to_string(),
            PtySession {
                writer: Arc::new(Mutex::new(writer)),
                master: pair.master,
                killer,
                pause: Arc::new(PauseState::new()),
                inflight: Arc::new(InflightState::new()),
                pid,
                epoch: next_pty_epoch(),
                config_dir: SpawnAccount::Default,
            },
        );

        let pids = mgr.session_pids();
        assert_eq!(pids.len(), 1, "one session with a pid → one entry: {pids:?}");
        assert_eq!(pids[0].0, "agent-with-pid", "keyed by session id, which IS the agent id");
        assert_eq!(
            pids[0].1,
            pid.unwrap(),
            "the pid reported must be the one the child actually got"
        );

        // A session whose platform gave no pid is SKIPPED, not emitted as 0 — pid 0 would make the
        // watchdog walk the wrong tree (or none) while looking like a successful measurement.
        let removed = mgr.sessions.lock().unwrap().remove("agent-with-pid");
        if let Some(mut s) = removed {
            s.pid = None;
            mgr.sessions.lock().unwrap().insert("agent-no-pid".to_string(), s);
        }
        assert!(
            mgr.session_pids().is_empty(),
            "a session without a pid contributes no entry at all"
        );

        let removed = mgr.sessions.lock().unwrap_or_else(|e| e.into_inner()).remove("agent-no-pid");
        if let Some(mut s) = removed {
            let _ = s.killer.kill();
            let _ = child.wait();
        }
    }

    /// A REPLACED SESSION'S CHILD MUST DIE, not merely leave the map.
    ///
    /// The map is the ONLY handle `pty_write`/`pty_resize`/`pty_kill` have, so a child that is
    /// silently replaced is not just untracked — it is unreachable, and it keeps every resource it
    /// held. The measured case is an OAuth callback port: a signin PTY spawned under an id that
    /// omitted the account scope replaced its predecessor, which stayed bound to the port and
    /// completed the login into the wrong config dir (bead sparkle-osgvl).
    ///
    /// Asserted on the CHILD's exit status, not on the map: "the id now holds the winner" was
    /// already true before this fix and proves nothing about the orphan.
    #[test]
    fn replacing_a_session_kills_the_child_it_displaced() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        let sys = native_pty_system();
        let size = PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };
        // `cat` holds its PTY open forever, so it exits only if something kills it.
        let mut made = Vec::new();
        for _ in 0..2 {
            let Ok(pair) = sys.openpty(size) else { return };
            let Ok(child) = pair.slave.spawn_command(CommandBuilder::new("/bin/cat")) else {
                return;
            };
            let killer = child.clone_killer();
            let Ok(writer) = pair.master.take_writer() else { return };
            made.push((
                PtySession {
                    writer: Arc::new(Mutex::new(writer)),
                    master: pair.master,
                    killer,
                    pause: Arc::new(PauseState::new()),
                    inflight: Arc::new(InflightState::new()),
                    pid: None,
                    epoch: NO_EPOCH,
                    config_dir: SpawnAccount::Default,
                },
                child,
            ));
        }
        let mgr = PtyManager::default();
        let mut children = Vec::new();
        for (session, child) in made {
            // A paused, credit-exhausted predecessor is the hard case: both gates have to be
            // released or its reader could never observe the kill.
            session.pause.set(true);
            mgr.insert_session("agent-displaced".to_string(), session);
            children.push(child);
        }

        // Poll rather than `wait()`: without the kill the orphan lives forever, and a test that
        // FAILS is worth more than one that hangs the suite.
        let orphan = &mut children[0];
        let mut exited = false;
        for _ in 0..100 {
            if matches!(orphan.try_wait(), Ok(Some(_))) {
                exited = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = orphan.kill();
        let _ = children[1].kill();
        for child in children.iter_mut() {
            let _ = child.wait();
        }
        assert!(
            exited,
            "the session replaced under this id left its child running: nothing can reach it \
             again, and it still holds every resource it had (ports, locks, fds)"
        );
    }

    /// A LOSER'S REAPER MUST NOT DELETE THE WINNER.
    ///
    /// The overlapping-spawn case, end to end on the manager alone, which is where it can be pinned
    /// deterministically. Two spawns land under one id; `sessions.insert` replaces silently, so the
    /// loser is gone from the map while its reader thread is still alive and still owes a teardown —
    /// and that teardown typically runs FIRST, because a command that fails fast exits immediately.
    ///
    /// With an id-keyed `remove` there, the live session disappears from the map: `pty_write` /
    /// `pty_resize` / `pty_kill` answer "no such pty" for a PTY the user is typing into, no
    /// `pty:exit` explains it (the loser's exit carries the lower epoch and is filtered out by
    /// design), and `live_epoch` reads NO_EPOCH while a higher-epoch session runs — so an observer
    /// floor sampled after that admits a stale exit. Every consequence the epoch exists to prevent,
    /// relocated past the insert.
    #[test]
    fn a_replaced_session_reaping_leaves_the_live_one_alone() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        let sys = native_pty_system();
        let size = PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };
        // Two real sessions under ONE id — the shape an overlapping spawn leaves behind.
        let mut made = Vec::new();
        for _ in 0..2 {
            let Ok(pair) = sys.openpty(size) else { return };
            let Ok(child) = pair.slave.spawn_command(CommandBuilder::new("/bin/cat")) else {
                return;
            };
            let killer = child.clone_killer();
            let Ok(writer) = pair.master.take_writer() else { return };
            made.push((
                PtySession {
                    writer: Arc::new(Mutex::new(writer)),
                    master: pair.master,
                    killer,
                    pause: Arc::new(PauseState::new()),
                    inflight: Arc::new(InflightState::new()),
                    pid: None,
                    epoch: NO_EPOCH,
                    config_dir: SpawnAccount::Default,
                },
                child,
            ));
        }
        let mgr = PtyManager::default();
        let mut children = Vec::new();
        let mut epochs = Vec::new();
        for (session, child) in made {
            epochs.push(mgr.insert_session("agent-overlap".to_string(), session));
            children.push(child);
        }
        let (loser, winner) = (epochs[0], epochs[1]);
        assert!(winner > loser, "the later insert must carry the higher epoch");

        // The LOSER's reader thread reaches its teardown first and asks to reap.
        assert_eq!(
            mgr.reap("agent-overlap", loser),
            Reap::OwnedByOther,
            "a replaced session must not be able to remove the id it no longer owns"
        );
        assert_eq!(
            mgr.live_epoch("agent-overlap"),
            winner,
            "the live session must survive its predecessor's reaper"
        );
        assert_eq!(
            mgr.session_ids(),
            vec!["agent-overlap".to_string()],
            "and must still be visible to the resurrection guard"
        );

        // …and the winner's own reaper still works, or sessions would leak forever.
        assert_eq!(
            mgr.reap("agent-overlap", winner),
            Reap::RemovedOurs,
            "the session that owns the id must still be removable by its own reader"
        );
        assert_eq!(mgr.live_epoch("agent-overlap"), NO_EPOCH, "and the id is then free");

        for mut child in children {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// THE KILL ORDERING, simulated the way it actually happens: a session is live, `pty_kill`
    /// removes it BY ID, and only then does its own reader thread wake on EOF and reap.
    ///
    /// Written as its own test against a freshly inserted session rather than reusing an id an
    /// earlier assertion already emptied — an empty map answers `AlreadyGone` for reasons that have
    /// nothing to do with a kill, so reusing it would re-test the trivial case while claiming to
    /// cover this one.
    #[test]
    fn a_session_killed_by_id_still_reads_as_unowned_to_its_own_reader() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        let sys = native_pty_system();
        let size = PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };
        let Ok(pair) = sys.openpty(size) else { return };
        let Ok(mut child) = pair.slave.spawn_command(CommandBuilder::new("/bin/cat")) else {
            return;
        };
        let killer = child.clone_killer();
        let Ok(writer) = pair.master.take_writer() else { return };
        let mgr = PtyManager::default();
        let epoch = mgr.insert_session(
            "agent-killed".to_string(),
            PtySession {
                writer: Arc::new(Mutex::new(writer)),
                master: pair.master,
                killer,
                pause: Arc::new(PauseState::new()),
                inflight: Arc::new(InflightState::new()),
                pid: None,
                epoch: NO_EPOCH,
                config_dir: SpawnAccount::Default,
            },
        );

        // THE REAL KILL, not a hand-rolled stand-in for it. Reaching into the map here would assert
        // a precondition this test created: `reap` reads nothing but `sessions.get(id)`, so a
        // manually emptied map is byte-for-byte a map that never held the id, and the assertion
        // below would collapse into the `nonexistent` case another test already owns. Driving
        // `take_and_signal_session` is what makes ONE regression red: the kill ceasing to remove by id (a
        // `get_mut` in place of the `remove`) leaves the session under its own epoch, so the reap
        // below answers `RemovedOurs`. It does NOT pin the removal against `killer.kill()` — this
        // caller is synchronous, so both have run by the time `reap` is asked, and swapping the two
        // statements inside `take_and_signal_session` stays green here. Only a reader racing a live kill could
        // see that, and nothing in this suite does.
        assert!(take_and_signal_session(&mgr, "agent-killed").is_some(), "control: the session was live before the kill");

        // The reader wakes on EOF and reaps with ITS OWN epoch. Nothing owns the id, so this is
        // still its teardown to finish — not someone else's session to leave alone.
        assert_eq!(
            mgr.reap("agent-killed", epoch),
            Reap::AlreadyGone,
            "a session removed by pty_kill leaves its id UNOWNED; reading that as OwnedByOther \
             skips the reader's remaining teardown on every deliberate stop"
        );

        let _ = child.kill();
        let _ = child.wait();
    }

    /// THE GATE ITSELF — the two lines the previous fix actually changed, and the ones nothing
    /// covered. Reverting `finish_teardown` to `reap == RemovedOurs` (literally the pre-fix
    /// behavior) left the whole `pty::` suite green, because every assertion targeted `reap`'s
    /// return value rather than what the caller DOES with it. These three cases red under that
    /// exact mutation.
    #[test]
    fn finish_teardown_detaches_unless_the_id_belongs_to_someone_else() {
        use crate::nudger::Observers;

        // RemovedOurs — the natural-exit path: our session was in the map and we took it out.
        let observers = Observers::default();
        observers.attach("agent-a", 80, 24);
        finish_teardown(&observers, "agent-a", Reap::RemovedOurs);
        assert!(observers.get("agent-a").is_none(), "a natural exit must stop observing");

        // AlreadyGone — pty_kill got there first. STILL OURS to finish tearing down: this is the
        // case the boolean gate got wrong, and it is the commonest teardown there is.
        let observers = Observers::default();
        observers.attach("agent-b", 80, 24);
        finish_teardown(&observers, "agent-b", Reap::AlreadyGone);
        assert!(
            observers.get("agent-b").is_none(),
            "a killed agent must stop being observed, or nudger::tick keeps it in `live` forever \
             and escalates a terminal that no longer exists"
        );

        // OwnedByOther — an overlapping spawn replaced us. The observer belongs to a LIVE PTY.
        let observers = Observers::default();
        observers.attach("agent-c", 80, 24);
        finish_teardown(&observers, "agent-c", Reap::OwnedByOther);
        assert!(
            observers.get("agent-c").is_some(),
            "a replaced reader must not detach the observer of the live session that replaced it"
        );
    }

    /// `session_ids` must report a session that has NO pid — the exact entry `session_pids` skips.
    ///
    /// This is the whole point of the second method, and it is asserted here rather than left to
    /// read as a duplicate: a pid-less session is a spawn IN FLIGHT, which is the most dangerous
    /// state the resurrection guard can be blind to. `sessions.insert` REPLACES silently, so if this
    /// reported empty the runner would admit an agent that is already booting, the second spawn
    /// would drop the first `PtySession`, and its child would keep running with nothing holding a
    /// handle to it — still burning tokens, still holding its worktree, invisible everywhere.
    ///
    /// Written as an inverted pair against `session_pids` on the SAME manager, so it cannot pass by
    /// the fixture being empty: one method must answer 0 while the other answers 1.
    #[test]
    fn session_ids_reports_a_pid_less_session_that_session_pids_skips() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        let sys = native_pty_system();
        let Ok(pair) =
            sys.openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        else {
            return; // no PTY in this environment — skip
        };
        let Ok(mut child) = pair.slave.spawn_command(CommandBuilder::new("/bin/cat")) else {
            return;
        };
        let killer = child.clone_killer();
        let writer = pair.master.take_writer().expect("take_writer");
        let mgr = PtyManager::default();
        // Through `insert_session`, the way production does — the epoch is stamped by the insert, so
        // a session constructed with the `NO_EPOCH` placeholder comes out of the map carrying a real
        // life. Inserting by hand here would let the placeholder survive and hide that.
        let inserted = mgr.insert_session(
            "agent-mid-spawn".to_string(),
            PtySession {
                writer: Arc::new(Mutex::new(writer)),
                master: pair.master,
                killer,
                pause: Arc::new(PauseState::new()),
                inflight: Arc::new(InflightState::new()),
                // No pid yet — a spawn that has not finished reporting one.
                pid: None,
                epoch: NO_EPOCH,
                config_dir: SpawnAccount::Default,
            },
        );
        assert!(inserted > NO_EPOCH, "insert_session must stamp a real epoch, not the sentinel");

        assert!(
            mgr.session_pids().is_empty(),
            "control: session_pids skips a pid-less session, so a 1 below is this method's doing"
        );
        assert_eq!(
            mgr.session_ids(),
            vec!["agent-mid-spawn".to_string()],
            "a live session with no pid is still a live session"
        );

        // The observer's FLOOR. It must report the epoch of the session that is live RIGHT NOW, and
        // must answer 0 — never a live session's epoch — for an id with nothing under it: a waiter
        // told the wrong floor either ignores the death it is waiting for or accepts a predecessor's.
        let live = mgr.sessions.lock().unwrap().get("agent-mid-spawn").map(|s| s.epoch).unwrap();
        assert_eq!(
            mgr.live_epoch("agent-mid-spawn"),
            live,
            "live_epoch must report the epoch of the session actually in the map"
        );
        // THE EPOCH THE INSERT RETURNED IS THE EPOCH THE MAP HOLDS. `pty_spawn` returns this value to
        // the frontend, which binds its exit filter to it, so a stamp that did not reach the session
        // would bind the terminal to a life the PTY host never recorded.
        assert_eq!(
            inserted, live,
            "the epoch insert_session returns must be the one it stored under that id"
        );
        assert_eq!(
            mgr.live_epoch("no-such-agent"),
            0,
            "an id with no session reads as the never-minted sentinel, not as some other session"
        );

        let removed = mgr.sessions.lock().unwrap_or_else(|e| e.into_inner()).remove("agent-mid-spawn");
        if let Some(mut s) = removed {
            let _ = s.killer.kill();
            let _ = child.wait();
        }
    }

    // ── sparkle-4orh: per-session write lock ──────────────────────────────────────────────────
    /// Holding a session's per-session writer lock (as `pty_write` does across a blocking write)
    /// must NOT keep the global `sessions` map locked — otherwise a big paste into a stalled child
    /// would freeze spawn/write/resize/kill for every other terminal. Uses a real PTY + `/bin/cat`
    /// so it exercises the actual `PtySession` / `acquire_writer` path; skips if no PTY is available.
    #[test]
    fn per_session_writer_lock_frees_the_global_map() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        let sys = native_pty_system();
        let Ok(pair) =
            sys.openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        else {
            return; // no PTY in this environment — skip
        };
        let Ok(mut child) = pair.slave.spawn_command(CommandBuilder::new("/bin/cat")) else {
            return;
        };
        let killer = child.clone_killer();
        let pid = child.process_id();
        let writer = pair.master.take_writer().expect("take_writer");
        let session = PtySession {
            writer: Arc::new(Mutex::new(writer)),
            master: pair.master,
            killer,
            pause: Arc::new(PauseState::new()),
            inflight: Arc::new(InflightState::new()),
            pid,
            epoch: next_pty_epoch(),
            config_dir: SpawnAccount::Default,
        };
        let sessions: Mutex<HashMap<String, PtySession>> = Mutex::new(HashMap::new());
        sessions.lock().unwrap().insert("a".to_string(), session);

        // Simulate an in-flight blocking write: hold THIS session's writer lock.
        let handle = acquire_writer(&sessions, "a").expect("writer handle");
        let held = handle.lock().unwrap_or_else(|e| e.into_inner());

        // The global map must still be immediately lockable — the whole point of sparkle-4orh.
        assert!(
            sessions.try_lock().is_ok(),
            "global sessions lock must be free while a session's writer is held"
        );
        // A missing session still reports NO_SUCH_PTY through the same helper.
        assert!(acquire_writer(&sessions, "missing").is_err());

        drop(held);
        let removed = sessions.lock().unwrap_or_else(|e| e.into_inner()).remove("a");
        if let Some(mut s) = removed {
            let _ = s.killer.kill();
            let _ = child.wait();
        }
    }

    // ── : read-backpressure pause gate ─────────────────────────────────────────────
    /// A parked reader stays parked while paused and proceeds the instant it's resumed — the
    /// mechanism `pty_set_paused` / `pty_kill` rely on.
    #[test]
    fn pause_state_blocks_while_paused_and_wakes_on_resume() {
        let ps = Arc::new(PauseState::new());
        ps.set(true);
        let woke = Arc::new(AtomicBool::new(false));
        let ps2 = ps.clone();
        let woke2 = woke.clone();
        let h = std::thread::spawn(move || {
            ps2.wait_while_paused();
            woke2.store(true, Ordering::SeqCst);
        });
        // Let the thread park on the condvar; it must not have proceeded past the pause.
        std::thread::sleep(Duration::from_millis(50));
        assert!(!woke.load(Ordering::SeqCst), "reader must stay parked while paused");
        ps.set(false); // resume
        h.join().unwrap();
        assert!(woke.load(Ordering::SeqCst), "reader must proceed after resume");
    }

    /// When not paused, `wait_while_paused` returns immediately (interactive output is unaffected).
    #[test]
    fn pause_state_does_not_block_when_not_paused() {
        let ps = PauseState::new();
        ps.wait_while_paused(); // returns at once
        ps.set(true);
        ps.set(false);
        ps.wait_while_paused(); // still returns at once after a resume
    }

    // ── .4: live PTY boundary (output bytes → exit) ────────────────────────────────
    /// One real integration test at the PTY boundary. It spawns an actual pseudo-terminal running a
    /// deterministic, always-available command (`/bin/echo`) via the SAME `portable_pty` primitives
    /// `pty_spawn` uses (openpty → spawn_command → drop slave → clone master reader → reap child),
    /// then drives the exact read loop the reader thread runs:
    ///   - `pty:output` boundary: the bytes read off the master carry the child\'s stdout marker.
    ///   - `pty:exit`   boundary: the master reader reaches EOF (`Ok(0)`) once the child exits, and
    ///     the child is reapable — the two conditions that make `pty_spawn` emit `pty:exit`.
    /// Robust/non-flaky: the marker is fixed, the command exits on its own, and the master read runs
    /// on a worker thread so the assertion is bounded by a `recv_timeout` (never an open-ended hang).
    /// Gated to skip only if the environment can\'t open a PTY at all (e.g. a locked-down sandbox);
    /// on macOS/Linux CI a PTY is available, so it runs for real.
    #[test]
    fn pty_boundary_delivers_output_bytes_then_exits() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::Read;
        use std::sync::mpsc;

        const MARKER: &str = "pty-boundary-probe-ova4";

        let sys = native_pty_system();
        let Ok(pair) =
            sys.openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        else {
            eprintln!("no PTY available — skipping pty_boundary_delivers_output_bytes_then_exits");
            return;
        };

        // Deterministic, universally-present command that prints a fixed marker and exits 0.
        let mut cmd = CommandBuilder::new("/bin/echo");
        cmd.arg(MARKER);
        let Ok(mut child) = pair.slave.spawn_command(cmd) else {
            eprintln!("spawn failed — skipping pty_boundary_delivers_output_bytes_then_exits");
            return;
        };
        // Drop the slave so the master sees EOF once the child exits — exactly as `pty_spawn` does.
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("clone master reader");

        // Read the master to EOF on a worker thread (mirrors the reader thread\'s `Ok(0) => break`),
        // so the test can bound the wait and never hang if EOF somehow never arrives.
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut out: Vec<u8> = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,                              // EOF → child exited (pty:exit)
                    Ok(n) => out.extend_from_slice(&buf[..n]),   // bytes → pty:output
                    Err(_) => break, // some backends surface EOF as an error; treat it as end-of-stream
                }
            }
            let _ = tx.send(out);
        });

        // pty:output boundary — the emitted stream must carry the child\'s stdout bytes.
        let out = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("master reader must reach EOF within 10s (pty:exit boundary)");
        let text = String::from_utf8_lossy(&out);
        assert!(
            text.contains(MARKER),
            "pty:output must carry the child\'s bytes; got {text:?}"
        );

        // pty:exit boundary — the process ended and is reapable (what the reaper thread relies on).
        let status = child.wait().expect("child must be reapable at exit");
        assert!(status.success(), "/bin/echo must exit 0; got {status:?}");
    }

    /// `pty_kill` on a PAUSED session must resume it, or the reader stays parked on the pause gate,
    /// never observes the child's EOF, and never runs its teardown (reap + `pty:exit`) — the agent
    /// is dead and the app still shows it live (). Same hazard on the credit gate: a
    /// producer parked waiting for acks gets none once the terminal is gone.
    ///
    /// DRIVEN, not restaged. This used to build its own `PauseState`, park a thread on it and call
    /// `pause.set(false)` itself under the comment "exactly what pty_kill does" — which made it a
    /// test of `PauseState`, green even with `session.pause.set(false)` deleted from the kill
    /// outright. `take_and_signal_session` is callable now, so the real path is what runs and that deletion
    /// reds it. Both gates are asserted, since nothing else covers the `inflight.close()`.
    #[test]
    fn kill_resumes_a_reader_parked_on_the_pause_gate_and_closes_the_credit_gate() {
        use portable_pty::{native_pty_system, PtySize};
        let sys = native_pty_system();
        let size = PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };
        let Ok(pair) = sys.openpty(size) else { return };
        let Ok(mut child) = pair.slave.spawn_command(CommandBuilder::new("/bin/cat")) else {
            return;
        };
        let killer = child.clone_killer();
        let Ok(writer) = pair.master.take_writer() else { return };

        let pause = Arc::new(PauseState::new());
        let inflight = Arc::new(InflightState::new());
        pause.set(true); // the state a kill has to rescue: paused, with a reader about to park
        let mgr = PtyManager::default();
        mgr.insert_session(
            "agent-paused".to_string(),
            PtySession {
                writer: Arc::new(Mutex::new(writer)),
                master: pair.master,
                killer,
                pause: pause.clone(),
                inflight: inflight.clone(),
                pid: None,
                epoch: NO_EPOCH,
                config_dir: SpawnAccount::Default,
            },
        );

        let woke = Arc::new(AtomicBool::new(false));
        let (p2, w2) = (pause.clone(), woke.clone());
        let reader = std::thread::spawn(move || {
            p2.wait_while_paused(); // the real reader parks here before each read()
            w2.store(true, Ordering::SeqCst);
        });
        std::thread::sleep(Duration::from_millis(30));
        assert!(!woke.load(Ordering::SeqCst), "control: a paused reader stays parked until the kill");
        assert!(!inflight.is_closed(), "control: the credit gate is open until the kill closes it");

        assert!(take_and_signal_session(&mgr, "agent-paused").is_some(), "control: the session was live before the kill");

        // Bounded wait, not a `join`: the regression this guards against is a thread that NEVER
        // wakes, and joining it would HANG the suite instead of failing it.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !woke.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            woke.load(Ordering::SeqCst),
            "the kill must resume the pause gate; a reader left parked never reads the child's EOF, \
             so its teardown — reap and pty:exit — never runs and the agent reads live forever"
        );
        assert!(
            inflight.is_closed(),
            "the kill must close the credit gate; a producer parked on it is waiting for acks a \
             dead terminal can no longer send"
        );

        let _ = reader.join();
        let _ = child.kill();
        let _ = child.wait();
    }

    // ── SessionEnd drain: the signal and the release are two separate moments ─────────────────
    //
    // `killer.kill()` is SIGHUP, so Claude Code answers it by running its `SessionEnd` hook —
    // `node sparkle-hook.mjs`, appending one line to the agent's event log. Dropping `PtySession`
    // runs `UnixMasterWriter::drop`, which writes `\n` + `VEOF` into the pty — an EOF on the
    // child's stdin that hurries Claude Code out, taking the still-writing hook with it. (It is
    // NOT a hangup; the reader thread's dup of the master keeps SIGHUP off the foreground group
    // until it too closes. See `pty_kill` for the full chain.) Signalling and releasing in one
    // breath therefore races the hook: 379 of 6,665 sessions on the founder's machine (5.7%,
    // across 228 of 441 logs) ended with no line, which costs `engine/deathRecord` the
    // `session-end-hook` evidence for a deliberate stop.

    /// A scratch hook-event log, named per-process + per-tag so concurrent tests never collide.
    fn drain_log_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("-drain-{}-{tag}.jsonl", std::process::id()))
    }

    /// One emitter line, in the exact shape `resources/sparkle-hook.mjs` writes.
    fn hook_line(event: &str) -> String {
        format!("{{\"ts\":1,\"event\":\"{event}\",\"session_id\":\"s\"}}\n")
    }

    /// THE FIX. Teardown must hold the PTY open until the hook's line is on disk.
    ///
    /// Driven through `drain_then_release` — the WHOLE of what `pty_kill` does after the signal —
    /// with a live `openpty` session taken out of a real manager by `take_and_signal_session`. That
    /// matters: a test that re-performed take → wait → drop in its own body would be asserting an
    /// order it created itself, and would stay green with the wait deleted from the command. Here
    /// the ordering under test belongs to the production function.
    ///
    /// Three assertions that can fail, all behavioural. It must report `Flushed` (not
    /// `TimedOut`/`NothingToDrain`); it must not return BEFORE the line lands (it waited); and it
    /// must not sit out the deadline AFTER it lands (it released promptly). Deleting the wait reds
    /// the first two; replacing it with an unconditional sleep reds the third.
    #[test]
    fn teardown_holds_the_pty_open_until_the_session_end_line_is_flushed() {
        use portable_pty::{native_pty_system, PtySize};
        use std::io::Write as _;
        let sys = native_pty_system();
        let size = PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };
        let Ok(pair) = sys.openpty(size) else { return };
        let Ok(mut child) = pair.slave.spawn_command(CommandBuilder::new("/bin/cat")) else {
            return;
        };
        let killer = child.clone_killer();
        let Ok(writer) = pair.master.take_writer() else { return };

        // The log already carries a PREVIOUS life's SessionEnd — the ordinary case, since the log
        // is keyed by agent and appended across restarts.
        let log = drain_log_path("holds-open");
        let _ = std::fs::remove_file(&log);
        std::fs::write(&log, hook_line("SessionEnd")).expect("seed the log");
        let from = std::fs::metadata(&log).expect("log length").len();

        let mgr = PtyManager::default();
        mgr.insert_session(
            "agent-drain".to_string(),
            PtySession {
                writer: Arc::new(Mutex::new(writer)),
                master: pair.master,
                killer,
                pause: Arc::new(PauseState::new()),
                inflight: Arc::new(InflightState::new()),
                pid: None,
                epoch: NO_EPOCH,
                config_dir: SpawnAccount::Default,
            },
        );

        // Stands in for the hook: it lands its line a beat AFTER the signal, which is exactly the
        // window the old shape sent the writer's EOF in.
        const HOOK_DELAY: Duration = Duration::from_millis(120);
        let log_w = log.clone();
        let hook = std::thread::spawn(move || {
            std::thread::sleep(HOOK_DELAY);
            let mut f = std::fs::OpenOptions::new().append(true).open(&log_w).expect("append");
            f.write_all(hook_line("SessionEnd").as_bytes()).expect("write the hook line");
        });

        let started = std::time::Instant::now();
        let session =
            take_and_signal_session(&mgr, "agent-drain").expect("the session was live before the kill");
        assert!(
            !mgr.session_ids().contains(&"agent-drain".to_string()),
            "control: the row leaves the map at the signal, not at the release"
        );
        // The production function owns the session from here: it holds the master open, waits, and
        // drops it — the release happens INSIDE this call, after the line lands.
        let outcome = drain_then_release(
            session,
            Some((log.clone(), from)),
            Duration::from_secs(5),
            Duration::from_millis(15),
        );
        let waited = started.elapsed();
        let _ = hook.join();

        assert_eq!(
            outcome,
            Drain::Flushed,
            "teardown must observe the SessionEnd line the signal provoked; without it \
             engine/deathRecord loses the `session-end-hook` evidence for a deliberate stop"
        );
        assert!(
            waited >= HOOK_DELAY,
            "teardown must WAIT for the line — it returned in {waited:?}, before the hook could \
             have written at {HOOK_DELAY:?}, so the PTY was released mid-flush"
        );
        assert!(
            waited < Duration::from_secs(2),
            "teardown must release as soon as the line lands, not sit out the deadline; took {waited:?}"
        );

        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_file(&log);
    }

    /// The offset guard, and the reason the drain is not vacuous.
    ///
    /// The event log is APPEND-ONLY ACROSS LIVES — `<app_data>/hook-events/<agentId>.jsonl` is keyed
    /// by agent, not by session — so every restart leaves its predecessor's `SessionEnd` in the
    /// file. A drain that scanned the whole log would match one of those on its first poll and
    /// report success without ever waiting for THIS session's line. Ignoring `from_offset` reds this.
    #[test]
    fn a_session_end_from_a_previous_life_does_not_satisfy_the_drain() {
        let log = drain_log_path("stale");
        let _ = std::fs::remove_file(&log);
        std::fs::write(&log, hook_line("SessionEnd")).expect("seed a previous life's line");
        let from = std::fs::metadata(&log).expect("log length").len();

        let started = std::time::Instant::now();
        let flushed =
            await_session_end_flush(&log, from, Duration::from_millis(150), Duration::from_millis(15));
        let waited = started.elapsed();

        assert!(
            !flushed,
            "a SessionEnd below the captured offset belongs to a PREVIOUS session; accepting it \
             makes the drain a no-op that always reports success"
        );
        assert!(
            waited >= Duration::from_millis(150),
            "the drain must actually wait out its deadline rather than short-circuit on the stale \
             line; returned in {waited:?}"
        );
        let _ = std::fs::remove_file(&log);
    }

    /// BOUNDED. A hook that never runs — no `node`, hooks never installed, child already gone —
    /// must cost the deadline and no more. Losing the line is the status quo; hanging teardown on
    /// it would be worse than the defect this drain exists to fix.
    #[test]
    fn the_drain_is_bounded_when_no_hook_line_ever_lands() {
        let log = drain_log_path("bounded");
        let _ = std::fs::remove_file(&log);
        std::fs::write(&log, hook_line("SessionStart")).expect("seed a log with no SessionEnd");
        let from = 0; // even scanning the WHOLE file, there is no SessionEnd to find

        let started = std::time::Instant::now();
        let flushed =
            await_session_end_flush(&log, from, Duration::from_millis(120), Duration::from_millis(15));
        let waited = started.elapsed();

        assert!(!flushed, "no SessionEnd was ever written, so the drain cannot report one");
        assert!(
            waited >= Duration::from_millis(120) && waited < Duration::from_secs(3),
            "the drain must end AT its deadline; took {waited:?}"
        );
        let _ = std::fs::remove_file(&log);
    }

    /// A missing log is "nothing to drain", not "wait 750ms". Sign-in PTYs and agents whose hooks
    /// never installed have no event log at all, and they are torn down on the same path — making
    /// them pay the deadline would put 750ms into every one of those teardowns for no line.
    #[test]
    fn an_agent_with_no_hook_log_has_nothing_to_drain() {
        use portable_pty::{native_pty_system, PtySize};
        let missing = drain_log_path("absent");
        let _ = std::fs::remove_file(&missing);
        assert!(std::fs::metadata(&missing).is_err(), "control: the log really is absent");
        assert!(
            !session_end_flushed(&missing, 0),
            "a log that does not exist cannot hold a flushed line"
        );

        // `session_end_drain_target` resolves to None for this shape (no metadata to read), and a
        // None must SKIP the wait rather than spend the deadline on it. Driven with a real session
        // so the release path is the production one.
        let sys = native_pty_system();
        let size = PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };
        let Ok(pair) = sys.openpty(size) else { return };
        let Ok(mut child) = pair.slave.spawn_command(CommandBuilder::new("/bin/cat")) else {
            return;
        };
        let killer = child.clone_killer();
        let Ok(writer) = pair.master.take_writer() else { return };
        let session = PtySession {
            writer: Arc::new(Mutex::new(writer)),
            master: pair.master,
            killer,
            pause: Arc::new(PauseState::new()),
            inflight: Arc::new(InflightState::new()),
            pid: None,
            epoch: NO_EPOCH,
            config_dir: SpawnAccount::Default,
        };

        let started = std::time::Instant::now();
        let outcome =
            drain_then_release(session, None, Duration::from_secs(5), Duration::from_millis(15));
        let waited = started.elapsed();

        assert_eq!(
            outcome,
            Drain::NothingToDrain,
            "an agent with no hook log has no line to wait for"
        );
        assert!(
            waited < Duration::from_millis(500),
            "a sign-in PTY or a hook-less agent must not pay the drain deadline; took {waited:?}"
        );

        let _ = child.kill();
        let _ = child.wait();
    }

    /// The seam itself: taking a session removes the row and hands the PTY BACK, so the caller —
    /// not this function — decides when the writer's EOF is sent. An unknown id yields nothing to hold.
    #[test]
    fn taking_a_session_removes_the_row_and_hands_the_pty_to_the_caller() {
        use portable_pty::{native_pty_system, PtySize};
        let sys = native_pty_system();
        let size = PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };
        let Ok(pair) = sys.openpty(size) else { return };
        let Ok(mut child) = pair.slave.spawn_command(CommandBuilder::new("/bin/cat")) else {
            return;
        };
        let killer = child.clone_killer();
        let Ok(writer) = pair.master.take_writer() else { return };
        let mgr = PtyManager::default();
        mgr.insert_session(
            "agent-taken".to_string(),
            PtySession {
                writer: Arc::new(Mutex::new(writer)),
                master: pair.master,
                killer,
                pause: Arc::new(PauseState::new()),
                inflight: Arc::new(InflightState::new()),
                pid: None,
                epoch: NO_EPOCH,
                config_dir: SpawnAccount::Default,
            },
        );

        assert!(
            take_and_signal_session(&mgr, "agent-unknown").is_none(),
            "an id with no live session hands back nothing to hold"
        );
        let held = take_and_signal_session(&mgr, "agent-taken");
        assert!(held.is_some(), "a live session is handed back so the caller can drain before release");
        assert!(
            !mgr.session_ids().contains(&"agent-taken".to_string()),
            "the row must leave the map at the signal — a second kill must not find it"
        );
        assert!(
            take_and_signal_session(&mgr, "agent-taken").is_none(),
            "the take is once-only; a racing second teardown gets nothing"
        );
        drop(held);

        let _ = child.kill();
        let _ = child.wait();
    }

    /// `pty_kill`'s own body, sliced by its braces. Mirrors `agent_life.rs`'s `fn_body`, which
    /// guards the mark-before-kill ordering in this same function.
    fn pty_kill_body(src: &str) -> String {
        let after = src
            .split("pub async fn pty_kill")
            .nth(1)
            .expect("`pty_kill` not found — renamed, or no longer async");
        let start = after.find('{').expect("pty_kill has no body");
        let mut depth = 0usize;
        for (i, ch) in after[start..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return after[start..=start + i].to_string();
                    }
                }
                _ => {}
            }
        }
        panic!("unbalanced braces after `pty_kill`");
    }

    /// THE WIRING, which no runtime test in this file can reach (roborev 62743).
    ///
    /// `pty_kill` is a `#[tauri::command]` taking an `AppHandle`, so every test above drives the
    /// helpers instead. That leaves two defects invisible — the defaulted-seam shape AGENTS.md
    /// flags as `sparkle-lgbwf`, where the one line supplying the real values is covered by nothing:
    ///
    /// 1. Reverting the command body to signal-and-release — deleting `drain_then_release` outright
    ///    — leaves every drain test green, because they call the helper directly. The `agent_life`
    ///    ordering guard stays green too: it is deliberately anchored on `take_and_signal_session(`.
    /// 2. Moving `session_end_drain_target(` to AFTER the signal captures an offset that can already
    ///    include this session's own `SessionEnd` line, turning every drain into a full timeout for
    ///    a line it will never recognise. That is "the whole correctness" of the offset, and no
    ///    runtime test observes where the capture happens.
    ///
    /// Source-text, therefore, and cheap. Both properties are ORDER, not presence, which is what a
    /// `contains` check would miss.
    #[test]
    fn pty_kill_captures_the_drain_offset_before_it_signals_and_drains_before_it_releases() {
        let body = pty_kill_body(include_str!("pty.rs"));
        // Self-check, same idiom as `agent_life.rs`: if the slice ever swallowed a helper's own
        // DEFINITION, the `find`s below would match that instead of `pty_kill`'s call and the
        // ordering assertion could not fail.
        for def in ["fn session_end_drain_target", "fn take_and_signal_session", "fn drain_then_release"] {
            assert!(
                !body.contains(def),
                "the slice swallowed `{def}`'s DEFINITION, so the assertions below would measure \
                 the definition rather than pty_kill's call — re-scope it"
            );
        }

        let capture = body.find("session_end_drain_target(").expect(
            "`pty_kill` no longer captures the hook-log offset before signalling, so the drain has \
             no floor and a previous life's SessionEnd satisfies it instantly",
        );
        let signal = body.find("take_and_signal_session(").expect(
            "`pty_kill` no longer takes the session, so there is nothing held open to drain against",
        );
        assert!(
            capture < signal,
            "the drain offset must be captured BEFORE the signal — captured after, it can already \
             include this session's own SessionEnd line, and every drain becomes a full timeout"
        );
        assert!(
            body.contains("drain_then_release("),
            "`pty_kill` no longer drains before releasing the PTY, so the SessionEnd hook races the \
             writer's EOF again — every test above stays green, because they drive the helper directly"
        );
    }

    // ── IPC emit credit gate (inflight backpressure) ──────────────────────────────────────────
    //
    // The pause gate above can only ever measure the frontend's xterm PARSE backlog, because
    // `flow.onEnqueue` runs inside the pty:output handler — i.e. AFTER the main thread already
    // dequeued the IPC message. The IPC queue itself (tao's unbounded crossbeam channel) is
    // structurally invisible to it, so a main-thread-bound app piles up messages while `pending`
    // stays low and the brake never engages. `InflightState` closes that hole on the PRODUCER
    // side: bytes are charged when emitted and released only when the frontend acks them, so the
    // un-acked IPC queue is bounded by construction.

    /// Charging the gate past the limit must PARK the producer (never drop / truncate), and an
    /// ack must release it. This is the core credit contract.
    #[test]
    fn inflight_gate_parks_the_producer_past_the_limit_and_releases_on_ack() {
        let gate = Arc::new(InflightState::new());
        gate.charge(1000);
        // Below the limit → the producer proceeds immediately.
        assert_eq!(gate.acquire(2000, Duration::from_secs(5)), Credit::Ready);

        gate.charge(1500); // 2500 un-acked, over a 2000 limit
        let g2 = gate.clone();
        let passed = Arc::new(AtomicBool::new(false));
        let p2 = passed.clone();
        let h = std::thread::spawn(move || {
            let c = g2.acquire(2000, Duration::from_secs(10));
            p2.store(true, Ordering::SeqCst);
            c
        });
        std::thread::sleep(Duration::from_millis(60));
        assert!(!passed.load(Ordering::SeqCst), "producer must park while over the credit limit");

        gate.ack(600); // 1900 < 2000 → release
        assert_eq!(h.join().unwrap(), Credit::Ready);
        assert_eq!(gate.inflight_bytes(), 1900);
    }

    /// Acks must clamp at zero — a duplicate/late ack from a tearing-down terminal must not make
    /// the counter wrap (usize underflow would panic in debug and wedge the gate in release).
    #[test]
    fn inflight_ack_clamps_at_zero() {
        let gate = InflightState::new();
        gate.charge(100);
        gate.ack(9999);
        assert_eq!(gate.inflight_bytes(), 0);
    }

    /// Teardown liveness: a producer parked on the gate must be released by `close()` — otherwise
    /// the reader/flusher would never observe EOF and `flusher.join()` would hang forever.
    #[test]
    fn inflight_gate_releases_parked_producers_on_close() {
        let gate = Arc::new(InflightState::new());
        gate.charge(10_000);
        let g2 = gate.clone();
        let h = std::thread::spawn(move || g2.acquire(1000, Duration::from_secs(30)));
        std::thread::sleep(Duration::from_millis(40));
        gate.close();
        assert_eq!(h.join().unwrap(), Credit::Closed);
        // And every LATER acquire returns instantly, so the final EOF drain can't block.
        assert_eq!(gate.acquire(1, Duration::from_secs(30)), Credit::Closed);
    }

    /// Safety valve: if the frontend stops acking entirely (a webview that died without killing
    /// the PTY, or lost ack invokes), the producer must not wedge forever. After the stall window
    /// it forgives the outstanding credit and proceeds — throttled to roughly one chunk per
    /// window rather than blocked, and still dropping nothing.
    #[test]
    fn inflight_gate_forgives_credit_after_a_stall_rather_than_wedging() {
        let gate = InflightState::new();
        gate.charge(10_000);
        let t0 = std::time::Instant::now();
        assert_eq!(gate.acquire(1000, Duration::from_millis(80)), Credit::Stalled);
        assert!(t0.elapsed() >= Duration::from_millis(70), "must actually wait out the window");
        assert_eq!(gate.inflight_bytes(), 0, "stalled credit is forgiven so the producer proceeds");
    }

    /// THE critical correctness property: under a sustained flood the credit gate must throttle
    /// the flusher without DROPPING or REORDERING a single byte. Drives the real `run_flusher`
    /// against a fake emitter plus a consumer thread that acks, and asserts the concatenation of
    /// everything emitted is byte-identical to everything the producer pushed, in order.
    #[test]
    fn flusher_preserves_order_and_completeness_under_a_sustained_flood() {
        let shared = Arc::new((Mutex::new(FlushBuf::default()), Condvar::new()));
        let gate = Arc::new(InflightState::new());
        let emitted: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        // Peak un-acked bytes observed by the emitter — proves the gate actually bounded the queue.
        let peak = Arc::new(AtomicUsize::new(0));

        let limit = 4096usize;
        let f_shared = shared.clone();
        let f_gate = gate.clone();
        let f_emitted = emitted.clone();
        let f_peak = peak.clone();
        let flusher = std::thread::spawn(move || {
            run_flusher(&f_shared, &f_gate, "test", limit, |chunk, bytes| {
                f_peak.fetch_max(bytes, Ordering::Relaxed);
                f_emitted.lock().unwrap().push(chunk);
            });
        });

        // Consumer ("frontend"): drain credit slowly so the producer is genuinely forced to park.
        let c_gate = gate.clone();
        let c_emitted = emitted.clone();
        let consumer = std::thread::spawn(move || {
            let mut acked = 0usize;
            for _ in 0..2000 {
                let total: usize = {
                    let e = c_emitted.lock().unwrap();
                    e.iter().map(|s| s.len()).sum()
                };
                if total > acked {
                    c_gate.ack(total - acked);
                    acked = total;
                }
                std::thread::sleep(Duration::from_millis(1));
                if c_gate.is_closed() && total == acked {
                    break;
                }
            }
        });

        // Producer: a deterministic, self-describing stream so any reorder/loss is detectable.
        let mut expected = String::new();
        let (lock, cvar) = &*shared;
        for i in 0..400 {
            let piece = format!("<{i}:{}>", "x".repeat(200));
            expected.push_str(&piece);
            let mut g = lock.lock().unwrap_or_else(|e| e.into_inner());
            g.text.push_str(&piece);
            cvar.notify_one();
        }
        {
            let mut g = lock.lock().unwrap_or_else(|e| e.into_inner());
            g.done = true;
            cvar.notify_one();
        }
        // EOF must release any parked producer so the final drain completes (see close()).
        gate.close();
        flusher.join().unwrap();
        let _ = consumer.join();

        let got = emitted.lock().unwrap().concat();
        assert_eq!(got.len(), expected.len(), "no bytes may be dropped under flood");
        assert_eq!(got, expected, "bytes must arrive complete and in order");
        assert!(peak.load(Ordering::Relaxed) > 0, "the flusher must have emitted something");
    }

    /// The per-PTY credit limit is the aggregate memory knob: with N terminals the worst-case
    /// un-acked IPC backlog is N × this. Pin it so a careless bump can't quietly reintroduce the
    /// multi-GiB footprint (20 agents × 256 KiB ≈ 5 MiB of chunk text before JSON escaping).
    #[test]
    // clippy flags both assertions as having a constant value, which is precisely the intent: this
    // test exists to FAIL TO COMPILE-TIME-HOLD if someone edits the constants out of their safe
    // relationship. There is no runtime input to vary — the constants are the subject.
    #[allow(clippy::assertions_on_constants)]
    fn inflight_high_water_stays_small_enough_to_aggregate_safely() {
        assert!(
            PTY_INFLIGHT_HIGH_WATER_BYTES >= super::PTY_FLUSH_SIZE_THRESHOLD * 2,
            "must allow at least a couple of max-size chunks in flight or throughput suffers"
        );
        assert!(
            PTY_INFLIGHT_HIGH_WATER_BYTES <= 512 * 1024,
            "per-PTY credit must stay small — it multiplies by the agent count"
        );
    }

    /// The spawn/kill race (bead sparkle-82vey): a `pty_kill` that lands after the child has started
    /// but before its session reaches the map must CANCEL the spawn, not succeed against an empty map
    /// and leave the child running unowned. Also pins the two shapes a naive fix breaks: an
    /// un-raced spawn still inserts, and a stale kill for an idle id does not cancel a later restart.
    #[test]
    fn a_kill_racing_an_in_flight_spawn_cancels_it_rather_than_orphaning() {
        use portable_pty::{native_pty_system, Child, CommandBuilder, PtySize};
        // Build a real PtySession backed by a trivial child. `None` when the environment has no pty
        // (some CI sandboxes) — the test then skips rather than failing on infrastructure.
        let mk = || -> Option<(PtySession, Box<dyn Child + Send + Sync>)> {
            let sys = native_pty_system();
            let size = PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };
            let pair = sys.openpty(size).ok()?;
            let child = pair.slave.spawn_command(CommandBuilder::new("/bin/cat")).ok()?;
            let killer = child.clone_killer();
            let writer = pair.master.take_writer().ok()?;
            Some((
                PtySession {
                    writer: Arc::new(Mutex::new(writer)),
                    master: pair.master,
                    killer,
                    pause: Arc::new(PauseState::new()),
                    inflight: Arc::new(InflightState::new()),
                    pid: None,
                    epoch: NO_EPOCH,
                    config_dir: SpawnAccount::Default,
                },
                child,
            ))
        };

        let mgr = PtyManager::default();
        let mut cleanup: Vec<Box<dyn Child + Send + Sync>> = Vec::new();

        // ── THE FIX: a kill during the spawn window cancels the insert ───────────────────────────
        let Some((session, mut raced_child)) = mk() else { return };
        mgr.begin_spawn("agent-race");
        // The kill lands while the child runs but the session is not yet in the map.
        assert!(
            !take_and_signal_session(&mgr, "agent-race").is_some(),
            "no live session yet, so take_and_signal_session returns None"
        );
        // The spawn now reaches insert_session — it must REFUSE (NO_EPOCH), so `pty_spawn` kills the
        // child it holds instead of leaving it orphaned against the worktree.
        assert_eq!(
            mgr.insert_session("agent-race".to_string(), session),
            NO_EPOCH,
            "a spawn cancelled mid-flight must not insert"
        );
        assert!(
            !mgr.session_ids().contains(&"agent-race".to_string()),
            "a cancelled spawn leaves no row — nothing to orphan"
        );
        let _ = raced_child.kill();
        let _ = raced_child.wait();

        // ── NON-VACUOUS: with no racing kill, the same path inserts normally ─────────────────────
        let Some((session, child)) = mk() else { return };
        mgr.begin_spawn("agent-clean");
        assert!(
            mgr.insert_session("agent-clean".to_string(), session) > NO_EPOCH,
            "an un-raced spawn mints a real epoch and inserts"
        );
        assert!(mgr.session_ids().contains(&"agent-clean".to_string()));
        cleanup.push(child);

        // ── SCOPING: a kill for an idle id (no session, no spawn) must not cancel a later restart ─
        assert!(
            !take_and_signal_session(&mgr, "agent-restart").is_some(),
            "nothing live and nothing spawning — a plain no-op"
        );
        let Some((session, child)) = mk() else { return };
        mgr.begin_spawn("agent-restart");
        assert!(
            mgr.insert_session("agent-restart".to_string(), session) > NO_EPOCH,
            "a stale kill must not cancel a later restart of the same id"
        );
        cleanup.push(child);

        for mut c in cleanup {
            let _ = c.kill();
            let _ = c.wait();
        }
    }

    /// GUARD for the roborev-62075 HIGH via the SIDE EFFECT, not a source-order proxy: after a spawn
    /// that a racing `pty_kill` cancelled, `Observers` must hold NO entry for the id — a stranded
    /// observer keeps the nudger's ladder climbing against an agent that never ran. This drives
    /// `insert_or_cancel` (the extracted insert + conditional-attach) directly with a `PtyManager`
    /// and an `Observers`, so the production decision is exercised without a live `AppHandle`. The
    /// paired winning case pins the converse (a spawn that wins the race DOES attach its observer),
    /// so the assertion cannot pass by a broken helper that attaches nothing in every case.
    #[test]
    fn a_cancelled_insert_attaches_no_observer_while_a_winning_one_does() {
        use portable_pty::{native_pty_system, Child, CommandBuilder, PtySize};
        // Build a real PtySession backed by a trivial child. `None` when the environment has no pty
        // (some CI sandboxes) — the test then skips visibly rather than passing vacuously.
        let mk = || -> Option<(PtySession, Box<dyn Child + Send + Sync>)> {
            let sys = native_pty_system();
            let size = PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };
            let pair = sys.openpty(size).ok()?;
            let child = pair.slave.spawn_command(CommandBuilder::new("/bin/cat")).ok()?;
            let killer = child.clone_killer();
            let writer = pair.master.take_writer().ok()?;
            Some((
                PtySession {
                    writer: Arc::new(Mutex::new(writer)),
                    master: pair.master,
                    killer,
                    pause: Arc::new(PauseState::new()),
                    inflight: Arc::new(InflightState::new()),
                    pid: None,
                    epoch: NO_EPOCH,
                    config_dir: SpawnAccount::Default,
                },
                child,
            ))
        };

        let mgr = PtyManager::default();
        let observers = crate::nudger::Observers::default();
        let mut cleanup: Vec<Box<dyn Child + Send + Sync>> = Vec::new();

        // ── CANCELLED: a kill marked this in-flight spawn, so insert_or_cancel refuses to insert AND
        //    attaches no observer. ──────────────────────────────────────────────────────────────────
        let Some((session, child)) = mk() else {
            eprintln!("SKIP a_cancelled_insert_…: no pty available in this environment");
            return;
        };
        cleanup.push(child);
        mgr.begin_spawn("agent-cancelled");
        assert!(
            !take_and_signal_session(&mgr, "agent-cancelled").is_some(),
            "no live session yet, so take_and_signal_session returns None — but it marks the in-flight spawn"
        );
        let cancelled = insert_or_cancel(&mgr, &observers, "agent-cancelled", session, 80, 24);
        assert!(cancelled.is_none(), "a cancelled spawn must not insert (epoch == NO_EPOCH)");
        assert!(
            observers.get("agent-cancelled").is_none(),
            "THE SIDE EFFECT: a cancelled spawn must attach NO observer, or the nudger escalates a \
             terminal that never ran (roborev 62075, HIGH)"
        );

        // ── WINNING: no kill, so insert_or_cancel inserts AND attaches the observer. Without this
        //    case the assertion above would also pass on a broken helper that attaches nothing ever. ─
        let Some((session, child)) = mk() else {
            eprintln!("SKIP a_cancelled_insert_… (winning half): no pty available");
            for mut c in cleanup {
                let _ = c.kill();
                let _ = c.wait();
            }
            return;
        };
        cleanup.push(child);
        mgr.begin_spawn("agent-winning");
        let (epoch, _observer) = insert_or_cancel(&mgr, &observers, "agent-winning", session, 80, 24)
            .expect("an un-raced spawn must insert");
        assert!(epoch > NO_EPOCH, "a winning insert mints a real epoch");
        assert!(
            observers.get("agent-winning").is_some(),
            "a winning spawn attaches its observer so the nudger can read the live screen"
        );

        for mut c in cleanup {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}
