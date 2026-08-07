//! One-shot text inference on the USER'S OWN Claude Code subscription, by shelling out to their
//! already-authenticated `claude` CLI.
//!
//! This is the replacement for `ai::call_anthropic_proxy`. That path POSTed to Sparkle's
//! orchestration `/ai/anthropic` route, which held a vendor Anthropic key and metered credits at
//! 10x. That key ran out of funds on 2026-07-28 and will not be refunded, which killed auto-naming,
//! the followup judge, Chief synthesis and suggestions simultaneously — 99.3% of AI calls failing,
//! silently, for over twelve hours. The decision (see PRD) is to retire the vendor key entirely
//! rather than refund it: every caller here now runs on the user's own subscription, so there is no
//! Sparkle-funded key left to exhaust and no credit to meter.
//!
//! `concierge.rs` already proved the pattern in-repo (`concierge_turn spawn claude_path=…`). This
//! module generalizes it for the small, non-streaming classify/synthesis calls.
//!
//! ## Things that will look wrong until you know why
//!
//! **`--bare` is never passed, and must never be.** It is otherwise the ideal flag — it skips
//! hooks, plugin sync, and auto-memory — but its own help states that under `--bare` auth is
//! strictly `ANTHROPIC_API_KEY` or an apiKeyHelper, and *OAuth and keychain are never read*. It
//! would therefore defeat the entire point of this module, which is to use the subscription login.
//! Verified empirically: `claude -p '…' --bare` with no API key returns "Not logged in". There is a
//! test pinning its absence.
//!
//! **The exit code and `subtype` are both lies.** On an API failure the CLI exits 0 and still
//! reports `"subtype":"success"`; only `is_error` tells the truth. A version of this that trusted
//! either would hand `"Not logged in · Please run /login"` back to `naming.rs` and set it as an
//! agent's name. See `classify_result_json`.
//!
//! **No shell.** Unlike `concierge.rs`/`claude_chat.rs`, which build a `zsh -c 'exec claude …'`
//! string, this spawns the binary directly with an argv vector. These calls do not stream and have
//! no need for a shell, and `route_classify`'s user turn is literally agent-produced terminal
//! output — the most attacker-adjacent string in the app. An argv vector has no quoting layer to
//! get wrong. It also saves one process per call, which matters when 50 agents finish at once.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::process::Command;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// WALL-CLOCK budget for the small classify/label calls (judge, naming, attention, route).
///
/// Semantic change from the `ai::CLASSIFY_READ_TIMEOUT` (30s) it replaces: that was a per-READ
/// socket bound on a pooled HTTPS connection, where 30s of silence meant a dead host. This is total
/// wall clock for forking a node process, booting the CLI, and completing a turn. Measured on a
/// developer machine: ~2.1s warm with `--safe-mode`, ~7.5s cold. 60s is ~8x the cold case, so it
/// only fires on a genuine wedge — not on a machine that is merely busy running 50 agents.
pub(crate) const CLASSIFY_TIMEOUT: Duration = Duration::from_secs(60);

/// WALL-CLOCK budget for the generic chat sink (Chief synthesis, epic decompose, task plans).
/// Its replies are long and slow-but-progressing. `ai::CHAT_READ_TIMEOUT` was 120s PER READ, so
/// reusing 120s as a TOTAL here would be a regression; 180s is the honest equivalent.
///
/// Used by `ai::anthropic_chat`.
pub(crate) const CHAT_TIMEOUT: Duration = Duration::from_secs(180);

/// Per-string cap on what goes into argv. `getconf ARG_MAX` is 1 MiB on macOS; two strings at
/// 128 KiB each leave an order of magnitude of headroom for the flags and the inherited environment.
///
/// BYTES, not chars — `execve`'s limit is a byte limit, and this measured `chars().count()` at
/// first. `route_classify`'s input is agent-produced terminal output, which is dense in multi-byte
/// UTF-8 (box-drawing `─` is 3 bytes, emoji 4), so a prompt that passed a 128 Ki-CHAR check could be
/// 384-512 KiB on the wire and still blow up — as an opaque spawn failure rather than the
/// `ai_prompt_too_large` the callers are written to degrade from.
///
/// Over budget is an `Err`, NEVER a truncation. A clipped prompt yields a *confidently wrong*
/// classification — a judge that never sees the question it was asked to rule on — which is
/// strictly worse than a refusal the caller already knows how to degrade from.
const MAX_PROMPT_BYTES: usize = 128 * 1024;

/// Floor for the post-hoc reply clamp, so a caller with a tiny `max_tokens` still gets a usable
/// answer. `judge.rs` asks for 8 tokens and expects the word "FOLLOWUP"; a clamp derived purely
/// from its budget would cut that to "FOLLO" and silently invert the verdict.
const MIN_REPLY_CHARS: usize = 256;

/// Bytes-per-token used to turn a caller's `max_tokens` into a character clamp. Deliberately
/// generous (a token averages ~4 chars): this is a RUNAWAY GUARD against a model that ignores its
/// instructions entirely, not a budget the normal path is expected to touch.
const CHARS_PER_TOKEN: usize = 6;

/// Cap on concurrent `claude` children, process-wide.
///
/// Each one is a full node process (~150 MB RSS and 1-2s of CPU-bound startup) competing with the
/// user's REAL build agents for the SAME subscription rate limit. Four keeps a finish-burst moving
/// while leaving the overwhelming majority of headroom to the work the user actually cares about.
///
/// Must stay STRICTLY GREATER than `MAX_BACKGROUND`, or background work can occupy every slot and
/// the anti-starvation guarantee below becomes a comment rather than a property. There is a test
/// asserting the inequality, because setting them equal compiles and looks reasonable.
const MAX_CONCURRENT: usize = 4;

/// Cap on concurrent BACKGROUND children, so a judge storm can never take the last slot from a call
/// a human is actually waiting on. This one line is the anti-starvation guarantee, and it has a
/// test named after it.
const MAX_BACKGROUND: usize = 3;

/// How many callers may WAIT for a slot, on top of those holding one.
///
/// The first cut of this module refused instantly when the pool was full, on the reasoning that a
/// queueing semaphore would park an unbounded number of `spawn_blocking` threads and exhaust
/// tokio's pool. The objection was right; the conclusion was not. Refusing instantly meant that in
/// the exact case this design targets — 50 agents finishing at once — ~48 judge calls returned
/// `ai_busy` *without ever reaching the model*, and `turnFollowup.ts` cannot distinguish a refusal
/// from a real "the judge could not run", so it painted a confident RED on every turn ending in a
/// proposal phrase. That is the 2026-07-28 false-alarm bug rebuilt out of a counter instead of a
/// dead key, and it was strictly worse than the proxy path it replaced (which had no client cap).
///
/// A BOUNDED waiting room answers the original objection without recreating the bug: a burst queues
/// and drains instead of being thrown away, while the number of parked blocking threads can never
/// exceed `MAX_CONCURRENT + MAX_WAITERS`. Against tokio's 512-thread blocking pool that is a rounding
/// error. Past the bound we still refuse, so the ceiling is real rather than aspirational.
const MAX_WAITERS: usize = 32;

/// Cap on BACKGROUND waiters, so the waiting room reserves seats the same way the pool reserves
/// slots. Without it the room was a single global counter and the tier split had a hole: under the
/// exact burst this design targets — ~32 judge/naming/attention calls parked for their 30s wait — an
/// interactive caller arriving to a full pool found the room full too and took the instant `ai_busy`
/// refusal, never using its own 5s budget. That is the same "refused for a seat it could have had"
/// failure MAX_WAITERS was introduced to remove, surviving for the one tier a human is blocked on.
const MAX_BACKGROUND_WAITERS: usize = 24;

/// How many seats this tier may occupy. Mirrors `tier_cap` for the pool.
fn tier_waiter_cap(tier: Tier) -> usize {
    match tier {
        Tier::Interactive => MAX_WAITERS,
        Tier::Background => MAX_BACKGROUND_WAITERS,
    }
}

/// How long a caller waits for a slot before giving up, by tier. Background calls have nobody
/// watching, so they can afford to queue behind a burst; an interactive call is behind a spinner and
/// must fail fast enough for the caller to degrade while the user is still looking at it.
const BACKGROUND_WAIT: Duration = Duration::from_secs(30);
const INTERACTIVE_WAIT: Duration = Duration::from_secs(5);

/// Poll interval while waiting. Coarse on purpose: the calls being waited on take ~2-3s, so a finer
/// poll would burn wakeups to shave a time nobody can perceive.
const WAIT_POLL: Duration = Duration::from_millis(50);

/// Entries kept in the reply cache. Each is a short classify reply plus its key, so 512 is a few
/// tens of KB — sized to cover every open agent's last verdict, not to be a general-purpose store.
const CACHE_CAP: usize = 512;

static INFLIGHT: AtomicUsize = AtomicUsize::new(0);
static WAITING: AtomicUsize = AtomicUsize::new(0);
static CACHE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Which pool tier a call draws from. `Interactive` means a human is blocked on this exact reply.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tier {
    Interactive,
    Background,
}

/// One non-streaming text call to the user's `claude` CLI.
///
/// A struct rather than eight positional parameters for the reason `ai::Metering` gave: `model`,
/// `system`, `user` and `purpose` are all `&str` and silently transposable at a call site.
pub(crate) struct OneShot<'a> {
    pub model: &'a str,
    pub system: &'a str,
    pub user: &'a str,
    /// ADVISORY. The CLI exposes no max-output-tokens flag (`--max-budget-usd` is API-key-only), so
    /// this only drives the post-hoc `reply_budget_chars` clamp. It is a runaway guard, NOT a
    /// billing bound — on a subscription there is nothing to bill.
    pub max_tokens: u32,
    /// WALL-CLOCK, not a read timeout. See `CLASSIFY_TIMEOUT`.
    pub timeout: Duration,
    pub tier: Tier,
    /// True iff the same (model, system, user) must yield the same answer. False for the generic
    /// chat sink, where a user's "regenerate" must actually regenerate.
    pub cacheable: bool,
    /// Diagnostic label, the successor to `ai::Metering::purpose`. It no longer reaches a credit
    /// ledger (there is no debit to record); it names the call in the tracing line.
    ///
    /// `&'a str`, not `&'static str`: the chat sink's purpose arrives as a runtime `String` from JS
    /// ("Suggesting next actions" vs "Defining the delivered stage" vs Chief synthesis), and forcing
    /// 'static collapsed all of them to a single literal — throwing away exactly the per-caller
    /// breakdown needed to diagnose call-volume problems. The struct is already lifetime-generic, so
    /// this costs nothing.
    pub purpose: &'a str,
    /// Diagnostic only now — was ledger attribution. Kept so the field is READ, not dead.
    pub project: Option<&'a str>,
}

/// What one run yielded, decided from the parsed JSON ALONE — never from the exit status.
#[derive(Debug, PartialEq, Eq)]
enum CliOutcome {
    Text(String),
    Failed(String),
}

/// One reply, plus THE ONE FACT THE HEALTH DETECTOR NEEDS THAT THE TEXT CANNOT CARRY: did this
/// answer cost a real `claude` child, or was it served from the reply cache?
///
/// `aiServiceHealthStore` accumulates a run of failures and lights an app-shell banner; only a
/// success retires it. Before this existed, the three `cacheable: true` callers (judge, naming,
/// attention) were forbidden from EVER reporting a success, because a cache hit is served before a
/// permit is even acquired and so proves nothing about the CLI's current state — reporting healthy
/// from one would let a wedged CLI hide behind its own stale answers indefinitely. That left
/// `chatOnce` as the sole reporter of recovery, and its only caller is the learned-suggestions
/// tier, which the user can switch off. A user in that configuration could drive the banner up
/// through naming/judge/attention, fix their CLI, and have nothing left that could clear it.
///
/// Distinguishing the two answers that question without weakening it: a hit still reports nothing,
/// a REAL SPAWN reports health, and every caller gets to do it.
#[derive(Debug)]
pub(crate) struct OneShotReply {
    pub text: String,
    /// TRUE iff a `claude` child actually ran and answered for this reply.
    pub spawned: bool,
}

/// Event the frontend listens on to learn that the user's CLI is demonstrably working right now.
///
/// An EVENT rather than a field on each command's reply, deliberately. The alternative was widening
/// four commands' `Ok` types and updating four JS wrappers — which is precisely the shape that
/// broke this detector once already (roborev 54761: wiring only some wrappers left a wedged CLI
/// producing almost no health input at all).
///
/// HONEST SCOPE, corrected after roborev 57507: there is ONE listener and ONE decision (see
/// `finish_cacheable`), but there is a call site per cacheable command, so a NEW `run` caller does
/// still have to route its result through `finish_cacheable` — it does not get this for free.
/// What it cannot do is get the *rule* wrong, because the rule is not written at the call sites.
pub(crate) const AI_SPAWN_OK_EVENT: &str = "ai://spawn-ok";

/// Where a health signal goes.
///
/// A trait purely so THE GATE ITSELF is reachable from a test. The first attempt at this extracted
/// the predicate instead (`should_report_health(spawned) -> bool`), which was the identity function
/// on `bool` — so its test asserted something true by definition and could only fail if someone
/// edited that one line. The decision that actually matters lives in the `if` below, and deleting
/// that `if` reinstates the cache-hit masking bug verbatim (a persistent unanswered prompt hits the
/// cache every tick, so a wedged CLI reports itself healthy forever) while the whole suite stays
/// green. That is the repo's stated #1 shape: an assertion that would have passed before the
/// change. A counting fake makes the `if` a real mutation target. (roborev 57515)
pub(crate) trait HealthSink {
    fn emit_health(&self);
}

impl HealthSink for tauri::AppHandle {
    /// Errors are swallowed: this is an advisory health signal, and a webview that has gone away
    /// must never turn a working AI call into a failed one.
    fn emit_health(&self) {
        use tauri::Emitter as _;
        let _ = self.emit(AI_SPAWN_OK_EVENT, ());
    }
}

/// THE GATE. Report health iff a real child answered — never for a cache hit, which is served
/// before a permit is acquired and proves nothing about the CLI's current state.
pub(crate) fn report_health<S: HealthSink>(sink: &S, spawned: bool) {
    if spawned {
        sink.emit_health();
    }
}

/// Finish a cacheable command: report health if a real child answered, THEN hand back the result.
///
/// THE ORDER IS THE WHOLE POINT, and getting it wrong was roborev 57507. `naming` and `attention`
/// both post-process the reply text (`interpret_reply`, `clean_summary`) and can reject it — a
/// malformed JSON name, an empty summary. Emitting after `?`-propagating that error threw the spawn
/// evidence away, and the resulting JS error falls through `classifyServiceFailure` to `ignore`,
/// which resets the run but does NOT clear `degraded`. So: a user drives the banner to threshold
/// with a wedged CLI, fixes it, naming then answers with prose the parser rejects every time — the
/// CLI is demonstrably healthy, nothing ever emits, and the latched banner survives to the expiry.
/// That is precisely the hole this whole mechanism exists to close.
///
/// A real child that ANSWERED proves the transport works even when what it said was useless to us.
/// The store's own default arm already says so: "the CLI answered something this layer has no
/// opinion about, which is evidence the transport works."
///
/// TWO KNOWN COVERAGE GAPS, both stated rather than papered over. An earlier version of this block
/// named only one of them after the `HealthSink` seam landed, which read as if the seam had closed
/// the other — it did not, it MOVED it.
///
///  1. Nothing asserts that a COMMAND calls this. Deleting the `finish_cacheable` call from
///     `generate_agent_name` / `judge_turn_followup` / `summarize_attention` still compiles green.
///  2. Nothing asserts the `AppHandle` ADAPTER — `<AppHandle as HealthSink>::emit_health` is the
///     only place the signal is really sent, and emptying its body or changing the event string it
///     carries leaves `cargo test --lib` fully green (the gate test counts a FAKE sink), while the
///     frontend listener never fires and a latched banner survives forever with a healthy CLI.
///
/// Both need `tauri::test::mock_app`, i.e. tauri's `test` feature — a dependency change nobody has
/// taken. The cheap half of #2 IS taken: `AI_SPAWN_OK_EVENT` is pinned to its literal on both sides
/// (here and in `aiServiceHealthListener.test.ts`), since that string is a cross-language contract
/// with no shared source and a rename would otherwise drift in silence.
///
/// What IS covered, against a fake sink rather than by assertion-about-an-identity: the gate itself
/// (`report_health` — a spawn emits exactly once, a hit emits zero times) and `(Result, bool)`
/// carrying spawn evidence past a post-processing rejection in `naming::interpret_naming_reply` /
/// `attention_summary::interpret_summary_reply`.
pub(crate) fn finish_cacheable<T>(
    app: &tauri::AppHandle,
    outcome: (Result<T, String>, bool),
) -> Result<T, String> {
    let (result, spawned) = outcome;
    report_health(app, spawned);
    result
}

/// Build the argv for one call. Pure, and every flag below is load-bearing.
///
/// ORDERING CONSTRAINT: `-p <user>` must come FIRST. `--tools`, `--mcp-config` and `--allowedTools`
/// are all variadic (`<tools...>`) in the CLI's argument parser, and a variadic flag immediately
/// followed by a bare positional swallows it. Leading with `-p` makes the prompt an *option
/// argument*, which cannot be captured that way. This is invisible from reading the code, so it has
/// its own test.
fn build_args(model: &str, system: &str, user: &str) -> Vec<String> {
    vec![
        // MUST be first — see the ordering constraint above.
        "-p".to_string(),
        user.to_string(),
        // A single JSON object on stdout. `stream-json` would mean re-implementing concierge's
        // NDJSON drain for no benefit: nothing here streams to a UI.
        "--output-format".to_string(),
        "json".to_string(),
        // Unlike concierge/claude_chat, which deliberately OMIT --model so the session inherits the
        // user's choice, these calls MUST pin it. A user configured on Opus would otherwise burn
        // ~30x their own subscription quota rendering a one-word judge verdict.
        "--model".to_string(),
        model.to_string(),
        // REPLACE the system prompt, not --append-system-prompt (concierge's choice). Measured: with
        // --safe-mode this is the difference between ~2.4k and ~12.2k cache-creation tokens per call.
        "--system-prompt".to_string(),
        system.to_string(),
        // The CLI's help is explicit: `""` disables ALL built-in tools. This is precisely the flag
        // that `concierge.rs:55-68` documents `--allowedTools` is NOT — that one is an allow-list
        // against a still-present tool set, this removes the set. These are pure text calls; a judge
        // has no business reading files.
        "--tools".to_string(),
        String::new(),
        // "Only use MCP servers from --mcp-config, ignoring all other MCP configurations." With no
        // --mcp-config supplied that resolves to the empty set, which closes the exact hole
        // concierge documents — and unlike concierge it needs no temp file, because we have no
        // control-surface token to hand over.
        "--strict-mcp-config".to_string(),
        // Without this, every judge/naming call writes a session JSONL under ~/.claude/projects/.
        // At 50 agents judged per turn that is thousands of junk files, which also pollute the
        // usage-transcript scanner in accounts.rs (it walks that tree under a 20k-file cap).
        "--no-session-persistence".to_string(),
        // Disables CLAUDE.md, skills, plugins, hooks, MCP servers, custom agents and output styles
        // while leaving auth, model selection and built-in tools working normally. Two reasons:
        // the measured 3.7x cost cut, and correctness — a user's PreToolUse/SessionStart hook must
        // not fire on Sparkle's internal classify calls. They never asked for that, and a hook that
        // prompts would hang the call to its deadline.
        "--safe-mode".to_string(),
    ]
}

/// Post-hoc character clamp derived from the caller's advisory `max_tokens`. See `MIN_REPLY_CHARS`
/// for why the floor exists.
fn reply_budget_chars(max_tokens: u32) -> usize {
    (max_tokens as usize)
        .saturating_mul(CHARS_PER_TOKEN)
        .max(MIN_REPLY_CHARS)
}

/// Decide the outcome of one run from its parsed JSON.
///
/// `is_error` is the ONLY truthful success bit. Both of these are real captures from this machine:
///
/// ```text
/// {"is_error":true,"subtype":"success","terminal_reason":"api_error","api_error_status":null,
///  "result":"Not logged in · Please run /login","total_cost_usd":0}
/// {"is_error":true,"subtype":"success","terminal_reason":"api_error","api_error_status":404,
///  "result":"There's an issue with the selected model (not-a-real-model). It may not exist..."}
/// ```
///
/// Note the process exits 0 for both, and `subtype` stays `"success"`. Reading either would return
/// the error prose as if it were the model's answer.
fn classify_result_json(v: &serde_json::Value) -> CliOutcome {
    let result_text = v.get("result").and_then(serde_json::Value::as_str).unwrap_or("");
    let api_error_status = v
        .get("api_error_status")
        .and_then(serde_json::Value::as_u64)
        .and_then(|n| u16::try_from(n).ok());

    if v.get("is_error").and_then(serde_json::Value::as_bool).unwrap_or(false) {
        return CliOutcome::Failed(classify_cli_failure(result_text, api_error_status));
    }
    let trimmed = result_text.trim();
    if trimmed.is_empty() {
        // A blank reply is a failure, not a silent Ok. Mirrors ai.rs's rule that an empty text
        // block never counted as an answer.
        return CliOutcome::Failed("ai_empty_reply".to_string());
    }
    CliOutcome::Text(trimmed.to_string())
}

/// Does this body say the ACCOUNT'S ALLOWANCE IS SPENT — as opposed to the vendor being busy?
///
/// ANCHORED ON THE SENTENCES THE CLI ACTUALLY EMITS, never on a bare word, and that restraint is
/// the whole design. `result_text` is the CLI's error body, which `classify_cli_failure`'s contract
/// says can quote the REQUEST back — and Sparkle's own prompts are agent terminal output, judge
/// inputs and attention screens, which are full of words like "quota". A loose match would be
/// WORSE than the bug it fixes, not merely imprecise: `claude_usage_limit` YIELDS in
/// `classifyServiceFailure`, and a yield RESETS the consecutive-failure run — so prose that keeps
/// recurring would hold a genuine sustained outage permanently below threshold, trading the false
/// positive this fixes for a false NEGATIVE in the exact case the detector exists for. It would
/// also light the non-dismissible ProviderUnavailableBanner with a specific, false claim about the
/// user's account.
///
/// Each phrase here is multi-word and is a fragment of a real message, verified against captures:
/// the subscription window limit, the spend cap (seen verbatim in this machine's own roborev logs
/// as "You've hit your monthly spend limit"), and the API credit balance.
fn is_account_limit(lower: &str) -> bool {
    lower.contains("usage limit reached")
        || lower.contains("limit resets at")
        || lower.contains("spend limit")
        || lower.contains("credit balance is too low")
}

/// Map a failed run to a typed sentinel the JS layer can branch on.
///
/// NEVER echoes the whole `result` body — it can be arbitrarily long and can quote the request back.
/// Same rule `ai::classify_proxy_error` followed for the vendor's response body. `log_outcome` does
/// NOT persist the sentinel this builds either; see `loggable_sentinel`.
///
/// Deliberately absent: `insufficient_credits` (there is no Sparkle balance left to exhaust on this
/// path) and `ai_unreachable`. The latter matters: that sentinel makes the JS layer call
/// `useConnectionStore.applyProbe(false)`, which asserts *this machine has no network* and raises
/// the global offline banner. A local CLI stall under a 50-agent storm is not evidence of that, and
/// flipping the banner from it would make every unrelated feature defer for the wrong reason.
fn classify_cli_failure(result_text: &str, api_error_status: Option<u16>) -> String {
    if let Some(sentinel) = typed_cli_failure(result_text, api_error_status) {
        return sentinel.to_string();
    }
    let detail: String = result_text.chars().take(200).collect();
    if detail.trim().is_empty() {
        "ai request failed".to_string()
    } else {
        format!("ai request failed: {}", detail.trim())
    }
}

/// The RECOGNISING half of `classify_cli_failure`: `Some` when the body names a condition the JS
/// layer has a specific branch for, `None` when it is prose we can only pass through.
///
/// Split out so a caller can ask "was this recognised?" without matching on the prose the other
/// half builds. `spawn_claude`'s no-usable-output path is the caller that needs it: it has its own
/// diagnostic message (the exit code, which the JSON path never has) and wants to keep it EXCEPT
/// when the body actually names a condition. A `starts_with("ai request failed")` test would have
/// worked today and broken silently the first time that prefix changed.
///
/// The arms are unchanged and stay in this one function on purpose. PR #1234 recorded the rule
/// after deleting a second matcher that had grown up beside this one: consumers route through the
/// canonical seam rather than hand-picking arms into a parallel classifier that then drifts.
fn typed_cli_failure(result_text: &str, api_error_status: Option<u16>) -> Option<&'static str> {
    let lower = result_text.to_lowercase();

    // AN ACCOUNT-STATE SENTENCE BEATS A BARE STATUS.
    //
    // This ordering is the fix for 2026-08-02, and the previous ordering — status first, "so we
    // check it before any prose match" — is what caused it. A spent SUBSCRIPTION allowance is
    // delivered as a 429 carrying "Claude usage limit reached", identical in status to the vendor
    // briefly overloading. Reading the status alone collapsed the two, and they are opposites for
    // every consumer downstream:
    //
    //   • `claude_usage_limit` YIELDS in `classifyServiceFailure` — a more specific banner
    //     (ProviderUnavailableBanner) owns it and says the true, actionable thing: the user's own
    //     Claude allowance is spent and resumes when it resets.
    //   • `ai_rate_limited` DEGRADES — it accumulates toward the app-shell AiServiceBanner, whose
    //     copy tells the user Sparkle's AI features are failing.
    //
    // So ~40 minutes of one user's exhausted allowance re-stamped a banner announcing that the
    // PRODUCT was down, while Sparkle's own service was healthy on every probe.
    if is_account_limit(&lower) {
        return Some("claude_usage_limit");
    }

    // Vendor-side overload / transient throttle: no account condition was named above, so a 429/529
    // here really is "try again shortly".
    if matches!(api_error_status, Some(429) | Some(529)) {
        return Some("ai_rate_limited");
    }
    // AN EXPIRED SESSION IS "NOT AUTHENTICATED", NOT A GENERIC SERVICE FAILURE.
    //
    // The three phrases below this comment cover a credential that was never valid or was signed
    // out. They do NOT cover the far more common shape: a session that WAS valid and whose refresh
    // failed. The CLI reports that as "Failed to authenticate: <reason>" — e.g. an OAuth session
    // that expired and could not be refreshed — which matches none of them, so it fell through to
    // the generic `ai request failed: …` arm at the bottom of this function.
    //
    // That is the same mis-bucketing the 2026-08-02 ordering fix above addressed, one condition
    // over, and it is worse here because the state is STICKY: a spent allowance resets on its own,
    // but an unrefreshable session stays broken until a human signs in again. Every automatic
    // caller (suggestions, attention-summary, the judge) keeps firing against it, and each failure
    // DEGRADES — accumulating toward the app-shell AiServiceBanner, whose copy says Sparkle's AI
    // features are failing. So the user is told the product is broken, indefinitely, and never told
    // the one thing that would fix it. `claude_not_authenticated` instead YIELDS to the named-reason
    // banner (`cli_not_authenticated`), which says to sign in.
    //
    // Matched on the failure verb, not on "oauth": the reason clause varies with the credential
    // kind, and it is the "failed to authenticate" prefix that is invariant. "session expired"
    // stands alone for the same reason — a session can expire without that prefix.
    if lower.contains("not logged in")
        || lower.contains("/login")
        || lower.contains("invalid api key")
        || lower.contains("failed to authenticate")
        || lower.contains("session expired")
    {
        return Some("claude_not_authenticated");
    }
    // The status-LESS prose path, unchanged from before this fix. It keeps the loose `quota` /
    // `rate limit` words because with no status to contradict them there is nothing else to go on,
    // and because the arm below it (`ai request failed`) also degrades — so a false match here
    // costs specificity, not a reset of a run that a 429 would otherwise be building.
    if lower.contains("usage limit") || lower.contains("rate limit") || lower.contains("quota") {
        // The subscription analogue of the old `insufficient_credits`: the user still has an
        // account, they have simply spent this window's allowance.
        return Some("claude_usage_limit");
    }
    None
}

/// A held concurrency slot. Releases on drop, including on panic.
struct Permit<'a> {
    counter: &'a AtomicUsize,
}

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::AcqRel);
    }
}

/// How many of the `MAX_CONCURRENT` slots this tier may occupy.
fn tier_cap(tier: Tier) -> usize {
    match tier {
        Tier::Interactive => MAX_CONCURRENT,
        Tier::Background => MAX_BACKGROUND,
    }
}

/// How long a caller of this tier is willing to queue for a slot.
fn tier_wait(tier: Tier) -> Duration {
    match tier {
        Tier::Interactive => INTERACTIVE_WAIT,
        Tier::Background => BACKGROUND_WAIT,
    }
}

/// A seat in the bounded waiting room. Releases on drop.
struct WaitSlot<'a> {
    counter: &'a AtomicUsize,
}

impl Drop for WaitSlot<'_> {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Claim a seat in the waiting room, or None when this tier's share is full. Same CAS discipline as
/// `try_acquire`, and the same reservation rule — see `MAX_BACKGROUND_WAITERS`.
fn enter_waiting_room(waiting: &AtomicUsize, tier: Tier) -> Option<WaitSlot<'_>> {
    let cap = tier_waiter_cap(tier);
    let mut current = waiting.load(Ordering::Acquire);
    loop {
        if current >= cap {
            return None;
        }
        match waiting.compare_exchange_weak(
            current,
            current + 1,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => return Some(WaitSlot { counter: waiting }),
            Err(actual) => current = actual,
        }
    }
}

/// Take a slot, queueing in the bounded waiting room if the pool is full.
///
/// Returns None only when the waiting room is ALSO full, or the wait expired — i.e. genuine
/// sustained overload rather than the ordinary burst that `MAX_WAITERS` exists to absorb. See
/// `MAX_WAITERS` for why refusing instantly was wrong.
fn acquire<'a>(
    counter: &'a AtomicUsize,
    waiting: &AtomicUsize,
    tier: Tier,
    max_wait: Duration,
) -> Option<Permit<'a>> {
    if let Some(p) = try_acquire(counter, tier) {
        return Some(p);
    }
    // Full — take a seat if there is one. Held for the whole wait, so the ceiling on parked
    // blocking threads is MAX_CONCURRENT + MAX_WAITERS and cannot drift.
    let _seat = enter_waiting_room(waiting, tier)?;
    let deadline = std::time::Instant::now() + max_wait;
    loop {
        std::thread::sleep(WAIT_POLL);
        if let Some(p) = try_acquire(counter, tier) {
            return Some(p);
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
    }
}

/// Take a slot, or return None immediately. The non-blocking core that `acquire` polls.
///
/// A COMPARE-AND-SWAP loop, deliberately not `fetch_add`-then-undo: with `fetch_add`, N racing
/// threads all push the counter past the cap before any of them undoes, and during that window a
/// legitimate acquirer is refused for a slot that was never really taken. The CAS never overshoots.
fn try_acquire(counter: &AtomicUsize, tier: Tier) -> Option<Permit<'_>> {
    let cap = tier_cap(tier);
    let mut current = counter.load(Ordering::Acquire);
    loop {
        if current >= cap {
            return None;
        }
        match counter.compare_exchange_weak(
            current,
            current + 1,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => return Some(Permit { counter }),
            Err(actual) => current = actual,
        }
    }
}

struct CacheEntry {
    text: String,
    seq: u64,
}

fn reply_cache() -> &'static Mutex<HashMap<u64, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<u64, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Identity of one exact request.
///
/// MODEL AND SYSTEM ARE IN THE KEY, not just the user message — otherwise a Haiku judge verdict
/// could be served to a Sonnet caller asking a different question about the same text.
///
/// `DefaultHasher` is fine here because this cache is in-memory and lives exactly one process. It
/// is explicitly NOT stable across Rust releases, so this key MUST NEVER be written to disk.
fn request_key(model: &str, system: &str, user: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    model.hash(&mut h);
    system.hash(&mut h);
    user.hash(&mut h);
    h.finish()
}

/// Pure so hit/miss and eviction unit-test without touching the static (mirrors accounts.rs's
/// `usage_cache_lookup`/`usage_cache_store` split).
fn cache_lookup(cache: &mut HashMap<u64, CacheEntry>, key: u64, seq: u64) -> Option<String> {
    let entry = cache.get_mut(&key)?;
    entry.seq = seq; // touch, so eviction is approximately LRU rather than arbitrary
    Some(entry.text.clone())
}

fn cache_store(
    cache: &mut HashMap<u64, CacheEntry>,
    key: u64,
    text: String,
    seq: u64,
    cap: usize,
) {
    if cache.len() >= cap && !cache.contains_key(&key) {
        // Evict the least-recently-touched entry. Linear over `cap` entries on insert only; at 512
        // entries and a handful of calls a minute that is nothing, and it avoids pulling in an LRU
        // crate for one cache.
        if let Some(victim) = cache.iter().min_by_key(|(_, e)| e.seq).map(|(k, _)| *k) {
            cache.remove(&victim);
        }
    }
    cache.insert(key, CacheEntry { text, seq });
}

/// Strip any inherited Anthropic API key from a child's environment.
///
/// Sparkle never sets these itself, but `Command` inherits the parent environment, so running
/// `npm run tauri dev` from a shell that exports `ANTHROPIC_API_KEY` would silently push the CLI off
/// the user's subscription and onto that key — which is the exact unfunded key this whole change
/// exists to stop using. The failure mode is invisible: it works on the developer's machine and
/// bills the wrong account.
///
/// Targeted removal rather than `setup.rs`'s full `env_clear`: that call is reproducing launchd's
/// near-empty environment on purpose, whereas the CLI's subscription OAuth needs `HOME` and honours
/// the user's own `CLAUDE_CONFIG_DIR`. Clearing everything would break the very auth we want.
/// Every inherited variable that can take the CLI off the user's subscription OAuth. A named const
/// so the list is a PINNED CONTRACT the test asserts against, not a spot check that silently stops
/// covering the vars added after it.
///
/// The first version stripped only the two `*_API*` names, which was the obvious half of the
/// problem and not the dangerous half: `ANTHROPIC_AUTH_TOKEN` supplies the `Authorization` header
/// and takes precedence over the keychain login, `ANTHROPIC_BASE_URL` silently redirects every call
/// to a third-party gateway, and the Bedrock/Vertex switches route to an entirely different vendor
/// account. Each produces exactly the failure this scrub exists to prevent — works on the
/// developer's machine, bills the wrong account, leaves no trace.
const ANTHROPIC_ENV_OVERRIDES: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_API",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
];

fn scrub_anthropic_env(cmd: &mut Command) {
    scrub_anthropic_env_for(cmd);
}

/// The same scrub, for any OTHER module that spawns the user's `claude`.
///
/// Exported rather than copied because the list above is a moving target — it started as two names
/// and grew to seven, each addition prompted by a real misroute — and a second copy would silently
/// stop matching on the next addition. `accounts::claude_auth_status` is the current other caller:
/// its probe must ask about the SAME credential the concierge's `claude -p` child uses, and an
/// inherited `ANTHROPIC_API_KEY` there makes a dead OAuth session report healthy (roborev 57985).
pub(crate) fn scrub_anthropic_env_for(cmd: &mut Command) {
    for name in ANTHROPIC_ENV_OVERRIDES {
        cmd.env_remove(name);
    }
}

/// Run one call and return the model's reply text. `Err` on every failure so callers degrade.
pub(crate) fn run(req: OneShot<'_>) -> Result<OneShotReply, String> {
    let claude_path = crate::preflight::cached_claude_path().ok_or_else(|| {
        // Reuses the existing sentinel: the JS layer already maps `ai_unconfigured` to "this is
        // doomed until something changes, defer without burning retry budget", which is exactly
        // right for a machine with no `claude` on PATH.
        "ai_unconfigured".to_string()
    })?;
    // Read off the request before it moves into `run_with`.
    let timeout = req.timeout;
    run_with(req, &|args| spawn_claude(&claude_path, args, timeout))
}

/// The testable core. `spawn` is injected so the parse/permit/cache logic is exercised by the REAL
/// body in tests rather than a reimplementation of it — the same seam reasoning as
/// `concierge::drain_stream`, where a test that declared its own gate would have stayed green after
/// the production gate was deleted.
///
/// `pub(crate)` so the CALLERS' contracts are testable too, not just this module's. Every migrated
/// caller encodes a decision that compiles fine when broken and produces no visible error: judge /
/// naming / attention must be `Background` (flipping one to `Interactive` lets a judge storm take
/// the last slot from a blocked human), the chat sink must be `cacheable: false` (flipping it makes
/// every "regenerate" button a silent no-op), and all of them must pin the model (inheriting a user
/// configured on Opus multiplies their quota cost). Those are pinned by tests in the caller modules,
/// which need this seam to observe the `OneShot` that was built.
///
/// `inflight`/`waiting` are parameters rather than the statics so those tests can own their own
/// pool — the four tests that drive this used to race on the process-wide counter and fail
/// nondeterministically whenever three overlapped.
pub(crate) fn run_with(
    req: OneShot<'_>,
    spawn: &dyn Fn(&[String]) -> Result<String, String>,
) -> Result<OneShotReply, String> {
    run_with_pool(req, spawn, &INFLIGHT, &WAITING)
}

pub(crate) fn run_with_pool(
    req: OneShot<'_>,
    spawn: &dyn Fn(&[String]) -> Result<String, String>,
    inflight: &AtomicUsize,
    waiting: &AtomicUsize,
) -> Result<OneShotReply, String> {
    if req.user.len() > MAX_PROMPT_BYTES || req.system.len() > MAX_PROMPT_BYTES {
        return Err("ai_prompt_too_large".to_string());
    }

    let key = request_key(req.model, req.system, req.user);
    if req.cacheable {
        let seq = CACHE_SEQ.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut cache) = reply_cache().lock() {
            if let Some(hit) = cache_lookup(&mut cache, key, seq) {
                // OBSERVABLE ON PURPOSE. A hit used to log nothing at all, and that silence made
                // the log actively misleading rather than merely incomplete: the only lines present
                // said "completed", so a reader diagnosing 2026-08-02 reasonably concluded the
                // all-zero-token ones were cache hits. They were failures (see `log_outcome`).
                // A hit and a failure are the two things this log most needs to tell apart, because
                // they are the two that spend nothing and look identical from outside.
                tracing::info!(
                    purpose = req.purpose,
                    project = req.project.unwrap_or("-"),
                    "claude one-shot served from cache"
                );
                // `spawned: false` — nothing was asked of the CLI, so this reply is evidence of
                // neither health nor failure. See `OneShotReply`.
                return Ok(OneShotReply { text: hit, spawned: false });
            }
        }
    }

    // Acquired BEFORE the spawn and held across it; `Drop` releases even on panic. Queues in the
    // bounded waiting room rather than refusing on the first full pool — see MAX_WAITERS.
    let _permit = acquire(inflight, waiting, req.tier, tier_wait(req.tier))
        .ok_or_else(|| "ai_busy".to_string())?;

    let args = build_args(req.model, req.system, req.user);
    let raw = spawn(&args)?;

    let json: serde_json::Value = serde_json::from_str(&raw).map_err(|e| {
        // Bounded: stdout could be anything if the CLI changed shape under us.
        let head: String = raw.chars().take(200).collect();
        format!("ai request failed: unparseable CLI output ({e}): {head}")
    })?;

    // CLASSIFY FIRST, THEN LOG. The log line must state what actually happened, and it takes the
    // outcome as an argument so it is not POSSIBLE to call it without knowing — see `log_outcome`.
    let outcome = classify_result_json(&json);
    log_outcome(&json, req.purpose, req.project, &outcome);

    let text = match outcome {
        CliOutcome::Text(t) => t,
        CliOutcome::Failed(sentinel) => return Err(sentinel),
    };

    // Runaway guard only — see CHARS_PER_TOKEN.
    let budget = reply_budget_chars(req.max_tokens);
    let text = if text.chars().count() > budget {
        tracing::warn!(
            purpose = req.purpose,
            budget,
            got = text.chars().count(),
            "one-shot reply exceeded its character budget; clamping"
        );
        text.chars().take(budget).collect()
    } else {
        text
    };

    if req.cacheable {
        // Only `Ok` is stored. A timeout or an auth failure must not stick to a prompt for the rest
        // of the session — the user fixing their login should take effect on the very next call.
        let seq = CACHE_SEQ.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut cache) = reply_cache().lock() {
            cache_store(&mut cache, key, text.clone(), seq, CACHE_CAP);
        }
    }
    // A real child ran and answered — the one thing that proves the user's CLI works right now.
    Ok(OneShotReply { text, spawned: true })
}

/// A bounded, NON-ECHOING discriminator for the log line.
///
/// Every classified case is a fixed typed string, but the fall-through arm of
/// `classify_cli_failure` builds `ai request failed: <first 200 chars of the CLI's result body>` —
/// and that body can quote the REQUEST back (its own doc says so, which is why it never echoes the
/// whole thing). The 200-char clamp bounded what crosses into JS as an error string; it is not
/// consent to PERSIST it. This line lands in the daily rolling file that `support::read_recent_logs`
/// tails and `crash.rs` uploads with consent, and `support::redact_secrets` redacts by SHAPE (keys,
/// bearers, tokens) rather than free-form prose — so a prompt fragment would pass straight through.
///
/// `concierge_lint_log::record_violation` already encodes exactly this rule for exactly this reason
/// (roborev 55693); this follows it. The allow-list is the point: anything not on it collapses to
/// its prefix, so a sentinel shape added later fails CLOSED rather than leaking by default.
fn loggable_sentinel(sentinel: &str) -> &str {
    match sentinel {
        "claude_usage_limit"
        | "claude_not_authenticated"
        | "ai_rate_limited"
        | "ai_timeout"
        | "ai_busy"
        | "ai_empty_reply"
        | "ai_unconfigured"
        | "ai_prompt_too_large"
        | "ai_unreachable" => sentinel,
        _ => "ai request failed",
    }
}

/// Emit what the call cost AND WHETHER IT WORKED, on ONE line.
///
/// This is the successor to `ai::Metering`, and it deliberately does not write a ledger row.
/// Metering's entire documented contract was "the server records these in the credit ledger row's
/// meta"; with no server call there is no row, and debiting Sparkle credits for inference the user
/// funded from their own subscription would be double-charging — the thing this change exists to
/// stop. The observability survives for free because `--output-format json` returns the numbers
/// anyway, and `purpose`/`project` stay READ rather than becoming dead fields.
///
/// `total_cost_usd` is NOTIONAL on a subscription: the user spends quota, not dollars.
///
/// IT TAKES THE OUTCOME, AND THAT PARAMETER IS THE POINT. The previous version was called BEFORE
/// `classify_result_json` and said "claude one-shot completed" unconditionally — so every failed
/// run was logged as a completion, with all-zero usage because a failed payload carries no usage.
/// On 2026-08-02 that produced a log in which 40 minutes of solid `ai_rate_limited` rejections read
/// as a quiet run of successful cache hits, and the incident was diagnosed backwards from it: the
/// conclusion drawn was "the service is fine and recovery is under-fed", when the truth was "every
/// call is failing and saying so". A log that reports failures as successes is worse than no log,
/// because it is trusted. Passing the outcome makes the honest version the only one that compiles.
fn log_outcome(
    json: &serde_json::Value,
    purpose: &str,
    project: Option<&str>,
    outcome: &CliOutcome,
) {
    let usage = json.get("usage");
    let get = |k: &str| usage.and_then(|u| u.get(k)).and_then(serde_json::Value::as_u64);
    let project = project.unwrap_or("-");
    let input_tokens = get("input_tokens").unwrap_or(0);
    let output_tokens = get("output_tokens").unwrap_or(0);
    let cache_read_tokens = get("cache_read_input_tokens").unwrap_or(0);
    let notional_cost_usd = json
        .get("total_cost_usd")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(0.0);
    let duration_ms = json.get("duration_ms").and_then(serde_json::Value::as_u64).unwrap_or(0);
    match outcome {
        CliOutcome::Text(_) => tracing::info!(
            purpose,
            project,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            notional_cost_usd,
            duration_ms,
            "claude one-shot completed"
        ),
        // WARN, not info: a run that spent the user's quota and produced nothing usable is the
        // event someone reading this log at 1am is looking for. `sentinel` is the typed string the
        // JS layer branches on, so the log and the banner can be reconciled without guessing.
        CliOutcome::Failed(sentinel) => tracing::warn!(
            purpose,
            project,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            notional_cost_usd,
            duration_ms,
            // NOT the raw sentinel — its fall-through form carries CLI output. See
            // `loggable_sentinel`; this file's log is support-uploadable.
            sentinel = loggable_sentinel(sentinel),
            "claude one-shot FAILED"
        ),
    }
}

/// Does this stdout carry a RESULT OBJECT we can classify?
///
/// A named function, not an inline expression, so the test drives THIS rather than a copy of it —
/// the first version of that test re-implemented the predicate and would have stayed green if the
/// gate were reverted, which is exactly the shape the repo's mutation-check rule targets.
fn is_usable_result(stdout: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(stdout.trim())
        .ok()
        .is_some_and(|v| v.get("is_error").is_some() || v.get("result").is_some())
}

/// Spawn the CLI and return its raw stdout.
///
/// Uses `worktree::output_with_timeout` — the STRICT form, whose doc names exactly this case:
/// callers that parse the output as a whole value, "where a plausible-looking prefix would be worse
/// than an error". It already gives us `process_group(0)`, `stdin(null)`, concurrent drain threads,
/// a group kill on expiry, and a guaranteed return within `timeout + DRAIN_GRACE`.
///
/// Deliberately NOT concierge's spawn: concierge has no wall-clock bound at all, which is survivable
/// for a user-visible turn they can cancel and is not survivable for a background judge.
fn spawn_claude(claude_path: &str, args: &[String], timeout: Duration) -> Result<String, String> {
    let mut cmd = Command::new(claude_path);
    cmd.args(args);
    scrub_anthropic_env(&mut cmd);
    // Same PATH story as claude_chat/concierge: a Finder-launched .app inherits no shell PATH, so
    // hand the child the login PATH we captured once, with ~/.local/bin prepended (the CLI's
    // `#!/usr/bin/env node` shebang has to resolve).
    cmd.env("PATH", child_path());
    // `--safe-mode` already disables CLAUDE.md discovery, so the working directory is nearly
    // irrelevant here — but it must be somewhere that reliably exists and that we are not writing
    // into. The temp dir needs no AppHandle, which keeps `run()` callable from any of the five
    // migrated modules without plumbing one through.
    cmd.current_dir(std::env::temp_dir());

    let output = crate::worktree::output_with_timeout(cmd, timeout).map_err(|e| {
        if e.contains("timed out") {
            "ai_timeout".to_string()
        } else {
            format!("ai request failed: {e}")
        }
    })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    // THE JSON WINS OVER THE EXIT CODE. This module's header says the exit code and `subtype` are
    // both lies, which is exactly why `classify_result_json` exists — and the first cut of this
    // guard then went and gated on `!status.success()` anyway. Whenever the CLI exits non-zero AND
    // still emits its `{"is_error":true,…}` payload (a plausible drift across versions, and drift is
    // this module's whole premise), that discarded the typed sentinel: a signed-out user or one at
    // their usage limit would have got `ai request failed: claude exited …`, the banner would never
    // have named the actionable cause, and callers would have burned retry budgets on a condition
    // they are built to defer on.
    //
    // So: fall back to the exit status ONLY when stdout carries no parseable result object at all.
    // The exit code stays as diagnostic context in the log, never as the decision.
    // A RESULT OBJECT, not merely "some JSON". Accepting any parseable value was too wide: a
    // wrapper's error envelope, an `--output-format` shape change, or a truncated array gives
    // `null` / `[]` / a bare number, which would pass, discard stderr and the exit code, and reach
    // `classify_result_json` — where a non-object has no `is_error` and no `result`, so it becomes
    // `ai_empty_reply`, which the JS classifier reads as "the CLI answered" and RESETS the failure
    // run. A permanently broken install would go silent, which is exactly what the fallback exists
    // to catch. Removing the exit-code gate was right; widening it this far was not.
    if !is_usable_result(&stdout) {
        // No usable output: a corrupt install, an unresolvable `#!/usr/bin/env node` shebang, an OOM
        // kill, or a flag removed by a CLI upgrade (`--safe-mode`, `--tools` and
        // `--no-session-persistence` are all version-dependent). The reason is on stderr, and
        // reporting the JSON parse error instead would throw the diagnosis away.
        let stderr = String::from_utf8_lossy(&output.stderr);
        // CLASSIFY THE FULL STDERR, CLAMP ONLY WHAT A HUMAN READS. Clamping first meant an echo
        // beginning past char 168 left a residual fragment shorter than one detection window, so
        // the argv-echo guard could not see it while a fragment carrying `usage limit reached`
        // still voted — the exact false positive the guard exists to stop.
        let full = stderr.trim();
        let detail: String = full.chars().take(200).collect();
        let code = output.status.code();
        // CLASSIFY BEFORE LOGGING, and log the SENTINEL — never the raw body. On the shape this
        // path exists for, stderr begins with our own argv, so `detail` is up to 200 characters of
        // the user's terminal. This log is persisted and rides along in consented support and crash
        // uploads, whose redaction removes credentials and paths but deliberately not ordinary
        // free-form text — so quoting it here exports a customer's screen. `loggable_sentinel` is
        // the same filter `log_outcome` uses for exactly this reason.
        let error = unusable_output_error_from(full, &detail, code, args);
        tracing::warn!(
            exit_code = ?code,
            sentinel = %loggable_sentinel(&error),
            "claude one-shot produced no usable output"
        );
        return Err(error);
    }
    Ok(stdout)
}

/// The error for a run that emitted no parseable result object — CLASSIFIED, not merely reported.
///
/// A CLI that dies before writing its result JSON says why on stderr, and this path used to hand
/// that prose straight back as `ai request failed: claude exited …`. `run_with` returns a spawn
/// error as the sentinel verbatim, exactly as it returns `CliOutcome::Failed`, so the two channels
/// are the same wire with only one of them classified.
///
/// That gap has a name. `classify_cli_failure` maps "failed to authenticate" / "session expired" to
/// `claude_not_authenticated`, which YIELDS to the sign-in banner; unclassified prose DEGRADES,
/// accumulating toward the app-shell banner that says Sparkle's AI features are failing. So a
/// credential that broke hard enough to kill the CLI produced the one message that never mentions
/// the only fix, and — because an unrefreshable session is STICKY, unlike an allowance that resets
/// — every automatic caller (suggestions, attention-summary, the judge) kept firing against it and
/// kept being told to retry. PR #1234 made the suggestions loop treat this as terminal and recorded
/// that the residue belonged HERE, in the classifier, rather than in a second matcher per consumer.
///
/// The exit code is the one diagnostic the JSON path does not have, so it is kept for everything
/// the classifier does NOT recognise — a corrupt install, a bad shebang, an OOM kill, a flag
/// removed by a CLI upgrade. Recognition upgrades the message; it never swallows a diagnosis.
///
/// `None` for `api_error_status`: there is no result JSON, so there is no status to read, and
/// inventing one would route a dead CLI into the rate-limit arm.
fn unusable_output_error(detail: &str, code: Option<i32>, args: &[String]) -> String {
    unusable_output_error_from(detail, detail, code, args)
}

/// As `unusable_output_error`, but classifying `full` (the whole stderr) while reporting `shown`
/// (the clamped, human-facing slice). Those are different jobs and clamping before classifying
/// silently weakens the guard — see the call site.
fn unusable_output_error_from(full: &str, shown: &str, code: Option<i32>, args: &[String]) -> String {
    // CLASSIFY THE CLI'S OWN WORDS, NEVER OUR PROMPT QUOTED BACK — and the discriminator is what
    // SURVIVES the strip, not a guess about whether the body "looks like" an argv dump.
    //
    // Two shapes have to come out differently, and they are not distinguishable by inspecting the
    // echo alone:
    //
    //   AN ECHO — an argv dump or usage line quotes our prompt, and the CLI's real diagnosis sits
    //   BESIDE it. Cutting the echo leaves that diagnosis behind, so the stripped body still
    //   classifies, and it is the honest answer.
    //
    //   A CORRELATED COLLISION — the CLI's own one-line diagnosis happens to be a sentence our
    //   prompt also contains, because the same outage produced both. (The fleet is signed out; the
    //   terminal we are summarising says `Failed to authenticate: session expired` and so does our
    //   own stderr.) Cutting it leaves NOTHING classifiable — and that emptiness is the tell. The
    //   shared text was the whole message, so it was the CLI's, and stripping it would erase a TRUE
    //   diagnosis exactly when it is true. That arm is the STICKY one, unfixable by retrying, so
    //   losing it is worse than the false positive the strip exists for.
    //
    // So: prefer the stripped reading; fall back to the unstripped one only when stripping left
    // nothing to read.
    // BOUNDED, not unbounded. Classifying the whole stream was the fix for an echo starting past
    // the 200-char clamp, but `strip_argv_echo` allocates a `String` per starting index per
    // argument — so a CLI that dumps a large stack trace, or replays a big prompt, turns a bounded
    // scan into O(len x 32) allocations over megabytes. This path is hit once per agent summarised
    // and the auth-lapse case fires fleet-wide at once. A few KB holds any plausible echo.
    let (scanned, truncated) = bounded_scan(full);
    let stripped = strip_argv_echo(&scanned, args);
    if let Some(sentinel) = typed_cli_failure(&stripped, None) {
        return sentinel.to_string();
    }
    // THE RESCUE, AND THE TWO THINGS IT REQUIRES.
    //
    // It exists for one shape: the CLI's own one-line diagnosis IS a sentence our prompt also
    // contains, because the same outage produced both. (The fleet is signed out; the terminal we
    // were asked to summarise says `Failed to authenticate: session expired`, and so does our own
    // stderr.) Stripping our argv then removes a TRUE diagnosis, and that arm is STICKY — unfixable
    // by retrying — so losing it is worse than the false positive the strip exists for.
    //
    // 1. THE RESIDUE MUST BE EMPTY. If anything survived the strip, the CLI said something we did
    //    not take from our own argv, and that is what it died of — `error: unknown option
    //    '--safe-mode'` beside an echoed prompt is the CLI's reason, not a collision.
    // 2. THE BODY MUST HAVE BEEN READ WHOLE. Over a truncated scan an empty residue can equally
    //    mean the reason was in the middle we skipped. A one-line collision is never an 8 KB body,
    //    so requiring the full read costs nothing.
    //
    // ACCEPTED LOSS, recorded because it is a real one: a CLI that FRAMES its own auth line
    // (`Error: Failed to authenticate: …\n    at auth (…)`) leaves residue and is no longer
    // rescued — it degrades to the generic message. An earlier revision carried a grammar for that
    // (`Error:`/`[tag]` prefixes, `at …` frames), but every witness for it was a literal invented
    // here, nothing in the wild was observed printing it, and it needed its own exception because
    // one of its arms was actively wrong in this position. If a framed collision is ever OBSERVED,
    // add that shape with a witness taken from the observation — do not reinstate the grammar.
    //
    // There is no kind allowlist either. One existed and inverted both outcomes: it re-admitted
    // `claude_not_authenticated` only — while `aiServiceHealthStore.ts:231` puts that in the SAME
    // `yield` bucket as `claude_usage_limit`, so it is not the safer arm — and it dropped
    // `claude_usage_limit`, which collides identically (the allowance that spent itself is the one
    // the summarised terminal is complaining about) and so lost its named banner to a generic
    // outage. Survivorship alone decides.
    if !truncated && stripped.trim().is_empty() {
        if let Some(sentinel) = typed_cli_failure(&scanned, None) {
            return sentinel.to_string();
        }
    }
    // THE MESSAGE MUST NOT BE OUR OWN PROMPT READ BACK TO THE USER — and must not claim more than
    // it knows.
    //
    // `shown` is the caller's 200-char head clamp, and on the shape this whole guard exists for the
    // head is ARGV: `build_args` puts `-p <user>` first, so a usage dump begins with the prompt.
    // Printing it verbatim hands the reader 200 characters of the terminal they asked us to
    // summarise, prose that can read exactly like an auth lapse. Same failure as the classifier
    // had, one channel over.
    //
    // Three conditions, in order, because each earlier revision of this got one of them wrong:
    //
    //   1. AN ECHO MUST ACTUALLY HAVE BEEN FOUND. `strip_argv_echo` returns its input unchanged
    //      when no argv window matches, so "what is left is only a banner" is true of a genuine
    //      `Usage: claude [options] [command]` that quoted nothing. Announcing an echo there is
    //      false AND suppresses the only text the reader had.
    //   2. THE REASON WE ALREADY HOLD WINS. `stripped` is the argv-stripped scan of the WHOLE
    //      bounded body, so the CLI's own reason may sit just past the 200-char clamp — in hand,
    //      and previously discarded while telling the reader nothing was found.
    //   3. ONLY THEN say the output was our echo, and say it with the count actually scanned
    //      rather than the constant, and as "no recognised sentinel" rather than "no diagnosis" —
    //      the code cannot back the stronger claim.
    let shown_stripped = strip_argv_echo(shown, args);
    let echo_found = shown_stripped != shown;
    let banner_only = |t: &str| t.lines().all(|l| l.trim().is_empty() || is_usage_banner(l));
    // RECOVER ONLY LINES THE STRIP NEVER TOUCHED. `strip_argv_echo` blanks a span only when a FULL
    // 32-char window matches, so any contiguous run of echoed prompt shorter than that survives —
    // and agent terminal output, which is what the prompt is on this path, is full of short lines.
    // Collecting every non-banner line therefore rebuilt a montage of the user's own terminal and
    // printed it as the CLI's error: the exact leak the synthesized message exists to prevent,
    // reintroduced by the recovery meant to improve it.
    //
    // OVER THE STRIPPED LINES, never `scanned`. Reading `scanned` here threw away the protection
    // that was already working: `strip_argv_echo` blanks any >=32-char echoed window WHEREVER it
    // sits, so a line mixing CLI framing with a long echoed run — `  argv: -p <a summarised terminal
    // line>`, exactly the decorated dump this path names as its failure class — arrives with the
    // echo already gone. There is no alignment problem: `stripped.lines()` is filtered on its own,
    // never zipped with `scanned.lines()`, and a blanked span that swallowed newlines only ever
    // merges non-echoed remnants, so the merge cannot leak.
    //
    // EVIDENCE THE LINE IS THE CLI'S, not "the whole line is ours". An earlier filter asked whether
    // the WHOLE trimmed line sat inside an argument, which cannot reach a short echoed run that
    // shares its line with framing — the failure class this path names for itself. A CLI that
    // decorates each echoed line (`  > ls -la`) produces lines too short for the span strip and
    // contained in no argument, so every one was kept and joined into a montage of the user's
    // terminal presented as the CLI's error.
    //
    // Inverted: keep a line only if, after its decoration is peeled, it carries a contiguous run
    // that appears in NO argument. `error: unknown option '--safe-mode'` does; `> psql -c 'x'` does
    // not, because peeling `> ` leaves text that is entirely ours.
    //
    // THE NOVEL RUN MUST SURVIVE DROPPING THE LINE'S FIRST TOKEN, not merely trimming punctuation
    // off its ends. Edge-trimming alone reads two ordinary decoration shapes as the CLI's own words:
    //
    //   TAG-SHAPED — `[stderr] ls -la`, `[12:03:04] kubectl top`. Trimming reaches the `[` but the
    //   novelty is INSIDE the core: the window straddling the tag's own `] ` (`stderr] ls`) is in no
    //   argument, so every echoed line looks novel and the whole montage returns.
    //
    //   TRAILING — a CLI that wraps the block in quotes or suffixes each line (`|`, a continuation
    //   backslash) leaves `  > git push -f"`, whose window `t push -f"` is novel only because the
    //   quote is not in the prompt.
    //
    // ONE dropped token is not enough, and the fix is not a bracket grammar. Double tagging is an
    // ordinary log shape — level plus timestamp, or level plus stream — and
    // `[stderr] [12:03:04] kubectl top` keeps `12:03:04] ` as its novel window past a single drop,
    // so it rejoins the montage. An earlier revision of this comment recorded that as an "accepted
    // loss"; it was the opposite, a live leak described as a degradation, which in this file is the
    // worse error because the comments are the contract later changes argue from.
    //
    // So: PEEL LEADING TOKENS UNTIL THE REMAINDER IS TOO SHORT TO JUDGE, and if ANY remainder along
    // the way is entirely ours, everything before it was decoration and the line is an echo.
    // A CLI's real sentence stays novel however far you peel (`error: unknown option '--safe-mode'`
    // -> `unknown option '--safe-mode` -> `option '--safe-mode`), while an echo reaches a remainder
    // that is verbatim prompt no matter how many tags precede it.
    //
    // The `core` test is the base case and is NOT redundant here: it is what rejects a line whose
    // remainders are all under `NOVEL_RUN` (`  > ls -la`), which the peel loop alone would keep
    // vacuously.
    //
    // ONLY A MULTI-TOKEN REMAINDER MAY CONDEMN THE LINE. Without that clause the loop over-peels and
    // takes the arm's FLAGSHIP case with it: `error: unknown option '--strict-mcp-config'` peels to
    // `strict-mcp-config`, which is a substring of the flag we ourselves passed, so an all-ours
    // remainder read as proof-of-echo drops the one diagnosis this recovery exists to surface (a CLI
    // too old for a flag we send). Same for `--no-session-persistence`, `--system-prompt`,
    // `--output-format`, and for `error: invalid model claude-haiku-4-5`. The decorated fixture
    // could not catch it: `'--safe-mode'` trims to `safe-mode`, NINE characters, one under the
    // threshold, so it breaks out of the loop instead of being judged — the only flag in
    // `build_args` short enough to survive by accident.
    //
    // THE CONDEMNATION IS LINE-ANCHORED: a remainder condemns its line only when it EQUALS a whole
    // line of one of our arguments, decoration trimmed off both sides — never merely because it is a
    // substring of one. That distinction is the whole filter, and it took four wrong answers to
    // find:
    //
    //   An echoed line is, by construction, a COMPLETE line of the summarised terminal. Whatever
    //   tags the CLI puts in front of it, what remains after the tags is exactly one of the lines we
    //   passed — `ls -la`, `kubectl top`, `git push -f`.
    //
    //   A real diagnosis that happens to end in our argv ends in an INTERIOR FRAGMENT of it: a flag
    //   name (`strict-mcp-config`), a model id, or a phrase quoted out of the middle of a line
    //   (`error: unexpected token near 'timed out while'`). None of those is a whole line of the
    //   prompt.
    //
    // Substring membership cannot tell those apart and kept taking the diagnosis with the echo: it
    // dropped `error: timed out` whenever the terminal we were summarising happened to contain the
    // phrase anywhere, and on the long path it dropped any reason quoting a 10-31 char fragment
    // (anything longer is already blanked by the span strip, so that window is precisely what
    // reaches here). Line anchoring costs nothing to state and removes both.
    //
    // THE MULTI-TOKEN REQUIREMENT SURVIVES THE MOVE TO ANCHORING, and briefly did not — which cost a
    // regression worth recording. Deleting it looked safe: it had existed only because `safe-mode` is
    // a SUBSTRING of `--safe-mode`, and no argument has a LINE equal to `safe-mode`. But `args` is
    // mostly single-token elements, and `a.lines()` on a one-line string yields that string, so
    // every element is trivially a whole line: the pinned model id, every flag in its unquoted form,
    // and the value `json` all became condemnations. The quoted forms survived only because trimming
    // the tail eats its `--` while the argument keeps it. The rule the comment states — an echoed
    // line is a command line — is a MULTI-TOKEN claim, so the guard is part of it, not scaffolding.
    //
    // THREE LOSSES:
    //
    //   1. A line whose ENTIRE core is under `NOVEL_RUN` is dropped before the loop runs.
    //   2. An echoed line whose content is NOT verbatim one of our lines survives — the CLI
    //      re-wrapped it, or `bounded_scan` cut through it. Anchoring buys its precision by trusting
    //      that the echo is intact, and a reflowed dump is the case where that is false.
    //   3. A SINGLE-TOKEN echoed line behind a tag survives — `[warn] make`, `[stderr] /usr/bin/x`.
    //      The price of the requirement above, and the cheaper side: it leaks one word the user's
    //      own terminal already showed them, where the other direction deletes the CLI's reason.
    //      `a_single_token_echoed_line_behind_a_tag_is_a_recorded_leak` PINS it, so this stays a
    //      decision rather than an oversight — making that test fail is an improvement.
    //   4. An echoed line whose decoration is SYMMETRIC survives — `[stderr] "kubectl top"`, a wrap
    //      applied per line rather than around the block. A quotation and a symmetric wrap are the
    //      same string, so the rule that saves a quoting diagnosis necessarily lets this through.
    //      Pinned by `a_symmetrically_wrapped_echo_line_is_a_recorded_leak`.
    //
    // The loss that used to be recorded here — a terse reason discarded because its tail appeared
    // somewhere in the prompt — is GONE, and the test that pinned it now asserts the survival. That
    // is the outcome its own comment asked for. Recording an avoidable loss as unavoidable is the
    // expensive error in this file, because the next change argues from this paragraph rather than
    // retrying it: an earlier revision declared "no rule reading only argv membership" could
    // separate the two shapes and that a tag grammar was the only alternative. Line anchoring is
    // such a rule, it needs no grammar, and it was sitting one clause away.
    let novel_run_in = |core: &[char]| {
        core.len() >= NOVEL_RUN
            && (0..=(core.len() - NOVEL_RUN)).any(|i| {
                let run: String = core[i..i + NOVEL_RUN].iter().collect();
                !args.iter().any(|a| a.contains(&run))
            })
    };
    let has_novel_run = |line: &str| {
        let decoration = |c: char| !c.is_alphanumeric();
        let raw = line.trim();
        let core = raw.trim_matches(decoration);
        if !novel_run_in(&core.chars().collect::<Vec<_>>()) {
            return false;
        }
        // COMPARED AGAINST THE ARGUMENT LINE AS WE PASSED IT, and the tail in BOTH forms — as it
        // stands and with its decoration trimmed. Trimming the argument side instead makes
        // `--strict-mcp-config` equal `strict-mcp-config` and condemns the flag diagnosis all over
        // again; not trimming the tail side at all misses `  > psql -c 'x'` when the CLI wrapped the
        // block in quotes. Peeling walks the RAW line for the same reason: taking tokens off the
        // decoration-trimmed core silently eats a trailing quote that the argument line still has.
        let is_whole_argv_line = |t: &str| {
            let bare = t.trim_matches(decoration);
            // MULTI-TOKEN, on the anchored test too. `args` is mostly SINGLE-token elements and
            // `a.lines()` on a one-line string yields the string itself, so without this every
            // element is a "whole line": `error: invalid model claude-haiku-4-5` peels to the model
            // id we pinned, `error: unknown option --strict-mcp-config` (unquoted) peels to the flag
            // itself, `error: unsupported output format json` peels to `json`. Each was condemned,
            // and the quoted forms escaped only because trimming the tail eats its `--` while the
            // argument keeps it — an accident of leading dashes, not a rule. An echoed terminal line
            // is a command line; a bare argv element is not.
            // THE `bare` FALLBACK IS WITHHELD FROM A SYMMETRICALLY QUOTED TAIL. It exists so a
            // quote-wrapped echo still matches when the wrap is ASYMMETRIC — `  > kubectl top"`
            // carries one stray quote the prompt line does not have, which is what a wrap AROUND THE
            // BLOCK leaves on its last line. But the same trimming strips the quotes off a CLI that
            // QUOTES a short line back at us: `error: cannot parse 'ls -la'` peels to `'ls -la'`,
            // trims to a prompt line, and the diagnosis is condemned as echo. Asymmetry tells those
            // apart — decoration is a prefix or a suffix, a quotation closes what it opens — so a
            // tail that opens and closes with the same non-alphanumeric character must match the
            // argument line EXACTLY, quotes and all.
            //
            // THE COST IS LOSS 4, and it is not closable here: a wrap applied PER LINE
            // (`[stderr] "kubectl top"`) is symmetric too, so it takes the same exit and survives.
            // `"kubectl top"` (echo) and `'ls -la'` (diagnosis quoting a line) are the same string
            // shape; no rule at this level can separate them, so the leak is recorded rather than
            // traded for the drop.
            let quoted_both_ends = {
                let mut cs = t.chars();
                match (cs.next(), t.chars().last()) {
                    (Some(a), Some(b)) => a == b && !a.is_alphanumeric() && t.chars().count() > 1,
                    _ => false,
                }
            };
            t.contains(char::is_whitespace)
                && args.iter().any(|a| {
                    a.lines().any(|l| {
                        let l = l.trim();
                        l == t || (!quoted_both_ends && !bare.is_empty() && l == bare)
                    })
                })
        };
        let mut rest = raw;
        while let Some((_, tail)) = rest.split_once(char::is_whitespace) {
            let tail = tail.trim();
            if is_whole_argv_line(tail) {
                return false;
            }
            if tail.trim_matches(decoration).chars().count() < NOVEL_RUN {
                break;
            }
            rest = tail;
        }
        true
    };
    let recovered: String = stripped
        .lines()
        .filter(|l| !l.trim().is_empty() && !is_usage_banner(l) && has_novel_run(l))
        .map(|l| l.trim())
        .collect::<Vec<_>>()
        // JOINED WITH A VISIBLE SEPARATOR, never a bare space. `bounded_scan` puts a newline at the
        // head/tail cut precisely because a head ending "…Claude usage " abutting a tail starting
        // "limit reached…" fabricates a phrase present in neither half — and this recovery spans
        // that cut. Re-gluing it with a space rebuilds the seam and then shows the result to the
        // user as the CLI's own words. Classification is unaffected (that reads `stripped`), but
        // the message is a claim the code cannot back.
        .join(" / ");
    let recovered = recovered
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    if shown.is_empty() {
        format!("ai request failed: claude exited {code:?} with no output")
    } else if echo_found && banner_only(&shown_stripped) {
        if !recovered.is_empty() {
            let clamped: String = recovered.chars().take(200).collect();
            format!("ai request failed: claude exited {code:?}: {clamped}")
        } else {
            format!(
                "ai request failed: claude exited {code:?}; its output was our own invocation \
                 echoed back, and no recognised failure was found in the {} characters scanned",
                scanned.chars().count()
            )
        }
    } else {
        format!("ai request failed: claude exited {code:?}: {shown}")
    }
}

/// The shortest contiguous run that, absent from every argument, marks a line as the CLI's own.
///
/// Shorter than `ARGV_ECHO_WINDOW` on purpose: the span strip already removes anything that long,
/// so what reaches this filter is by definition sub-window. Long enough that a decoration artifact
/// (`> `, a trailing quote) cannot pass for novel content.
const NOVEL_RUN: usize = 10;

/// Is this line the CLI's usage banner — our own invocation read back?
///
/// The ONE shape of framing this file recognises, and the only one it has ever observed. An earlier
/// revision carried a general grammar (`Error:` / `[tag]` prefixes, `at …` stack frames) so a
/// "framed" collision could still be rescued — but nothing in the wild was ever seen printing that,
/// every witness for it was a literal invented here, and it needed its own exception at the rescue
/// anyway. Case-insensitive, and used by BOTH callers: a divergent exact-case copy meant an
/// uppercase `USAGE:` passed the rescue screen and failed the display screen, which replayed 200
/// characters of the user's terminal as the CLI's error.
fn is_usage_banner(line: &str) -> bool {
    line.trim_start().to_lowercase().starts_with("usage:")
}

/// Read BOTH ENDS of stderr, not the head. `build_args` puts `-p <user>` first, so an argv dump
/// begins with the prompt — and a prompt is legal up to `MAX_PROMPT_BYTES` (128 KiB) of agent
/// terminal output, an order of magnitude over the bound. A head-only read therefore discards the
/// CLI's own diagnosis by construction: the echo is at the front, the reason the process died is at
/// the back. Taking the head alone made a long echo classify as our own prompt and a genuine
/// `claude_not_authenticated` printed after it invisible.
///
/// The two halves are joined with a newline so the seam cannot manufacture a phrase that is in
/// neither end.
fn bounded_scan(full: &str) -> (String, bool) {
    let chars: Vec<char> = full.chars().collect();
    if chars.len() <= CLASSIFY_MAX_CHARS {
        return (full.to_string(), false);
    }
    let half = CLASSIFY_MAX_CHARS / 2;
    let head: String = chars[..half].iter().collect();
    let tail: String = chars[chars.len() - half..].iter().collect();
    // THE NEWLINE IS LOAD-BEARING, not formatting. Every phrase `typed_cli_failure` matches is
    // newline-free, so without a separator the splice can fabricate one that is in NEITHER half —
    // a head ending "…Claude usage " abutting a tail starting "limit reached…", which repetitive
    // terminal output makes reachable — and the spliced span matches no argv window, so the strip
    // cannot remove it either.
    (format!("{head}\n{tail}"), true)
}

/// How much of stderr is read for CLASSIFICATION. Large enough for any plausible argv echo, small
/// enough that a megabyte stack trace cannot turn this into a quadratic scan. Distinct from the
/// 200-char clamp on the human-facing message, which is about readability, not safety.
const CLASSIFY_MAX_CHARS: usize = 8192;

/// The shortest run of characters that may be treated as OUR TEXT rather than the CLI's.
///
/// Long enough that ordinary English cannot collide with a prompt by accident (a 32-char window
/// shared verbatim with an argument we just passed is quotation, not coincidence), short enough to
/// catch a usage line that echoes only a clipped fragment. A shorter echo than this is not
/// detectable here and is left to the multi-word anchoring in `is_account_limit`.
const ARGV_ECHO_WINDOW: usize = 32;

/// Blank out any span of `detail` that the CLI quoted back from OUR OWN argv.
///
/// WHY THIS EXISTS AT ALL. `is_account_limit`'s doc states the rule for the JSON path: the error
/// body can quote the REQUEST back, and Sparkle's own prompts are agent terminal output, judge
/// inputs and attention screens — text that genuinely contains "usage limit reached" whenever an
/// agent it is summarising hit one. `a_429_that_merely_quotes_prompt_text_is_still_a_transient`
/// pins that for `result_text`. The stderr channel was assumed exempt because "the prompt travels
/// in argv, not in the CLI's own diagnostics" — but `build_args` passes the prompt AS `-p <user>`,
/// and an argv-parser error, a usage dump or a Node stack trace is exactly the failure that prints
/// argv back at you. That is also the only class of failure that reaches this function, since it
/// runs only when the CLI died before writing any result JSON.
///
/// Inventing a sentinel costs the detector: a false one YIELDS in `classifyServiceFailure`, and a
/// yield RESETS the consecutive-failure run, so a broken install quoting the user's own words would
/// hold a genuine sustained outage below threshold. That is true of EVERY sentinel — an earlier
/// version of this doc claimed the auth arm was the safer one to invent, which
/// `aiServiceHealthStore.ts:231` refutes by putting it in the same `yield` bucket.
///
/// Spans are replaced by a SPACE rather than deleted so a cut cannot glue the two halves of
/// unrelated text into a phrase that matches, and the adjacent real diagnosis survives: a stderr
/// reading `<echoed prompt> Failed to authenticate: session expired` still classifies.
fn strip_argv_echo(detail: &str, args: &[String]) -> String {
    let chars: Vec<char> = detail.chars().collect();
    if chars.len() < ARGV_ECHO_WINDOW {
        return detail.to_string();
    }
    // Only the free-text option arguments can carry a user's words. The flags and their own values
    // (`-p`, `json`, the model id) are ours, are shorter than one window, and matching against them
    // would blank out the CLI's legitimate mention of a flag it rejected.
    let ours: Vec<&String> = args.iter().filter(|a| a.chars().count() >= ARGV_ECHO_WINDOW).collect();
    if ours.is_empty() {
        return detail.to_string();
    }
    let mut echoed = vec![false; chars.len()];
    for start in 0..=(chars.len() - ARGV_ECHO_WINDOW) {
        let window: String = chars[start..start + ARGV_ECHO_WINDOW].iter().collect();
        if ours.iter().any(|a| a.contains(&window)) {
            echoed[start..start + ARGV_ECHO_WINDOW].fill(true);
        }
    }
    let mut out = String::with_capacity(detail.len());
    let mut cut_open = false;
    for (i, c) in chars.iter().enumerate() {
        if echoed[i] {
            if !cut_open {
                out.push(' ');
                cut_open = true;
            }
        } else {
            out.push(*c);
            cut_open = false;
        }
    }
    out
}

fn child_path() -> String {
    let base = crate::claude_chat::cached_login_shell_path();
    match std::env::var_os("HOME") {
        Some(home) => format!("{}/.local/bin:{}", home.to_string_lossy(), base),
        None => base,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MODEL: &str = "claude-haiku-4-5";
    const SYSTEM: &str = "You are a judge.";
    const USER: &str = "TASK: x\n\nFINAL MESSAGE:\ny";

    fn req<'a>(user: &'a str, tier: Tier, cacheable: bool) -> OneShot<'a> {
        OneShot {
            model: MODEL,
            system: SYSTEM,
            user,
            max_tokens: 8,
            timeout: CLASSIFY_TIMEOUT,
            tier,
            cacheable,
            purpose: "test",
            project: None,
        }
    }

    /// Drive the real `run_with` body against a pool this test OWNS. The four tests that exercise
    /// `run_with` used to share the process-wide `INFLIGHT`, so whenever three of them overlapped on
    /// cargo's test threads the third got `ai_busy` and panicked — a real nondeterministic failure,
    /// in exactly the module whose regressions these tests exist to catch.
    fn run_isolated(
        r: OneShot<'_>,
        spawn: &dyn Fn(&[String]) -> Result<String, String>,
    ) -> Result<String, String> {
        run_isolated_reply(r, spawn).map(|reply| reply.text)
    }

    /// As `run_isolated`, but keeps the whole reply so a test can assert on `spawned`.
    fn run_isolated_reply(
        r: OneShot<'_>,
        spawn: &dyn Fn(&[String]) -> Result<String, String>,
    ) -> Result<OneShotReply, String> {
        let inflight = AtomicUsize::new(0);
        let waiting = AtomicUsize::new(0);
        run_with_pool(r, spawn, &inflight, &waiting)
    }

    // Real capture from this machine, trimmed to the fields we read.
    const OK_JSON: &str = r#"{"is_error":false,"subtype":"success","api_error_status":null,
        "result":"DONE","total_cost_usd":0.0072,"duration_ms":2059,
        "usage":{"input_tokens":10,"output_tokens":47,"cache_read_input_tokens":15242}}"#;

    // Real capture: NOT logged in. Note `subtype` is still "success" and the process exited 0.
    const NOT_LOGGED_IN_JSON: &str = r#"{"is_error":true,"subtype":"success",
        "terminal_reason":"api_error","api_error_status":null,
        "result":"Not logged in · Please run /login","total_cost_usd":0}"#;

    // Real capture: bad model id.
    const BAD_MODEL_JSON: &str = r#"{"is_error":true,"subtype":"success",
        "terminal_reason":"api_error","api_error_status":404,
        "result":"There's an issue with the selected model (not-a-real-model). It may not exist."}"#;

    #[test]
    fn build_args_disables_every_customization_surface() {
        let args = build_args(MODEL, SYSTEM, USER);
        for expected in [
            "--output-format",
            "json",
            "--model",
            "--system-prompt",
            "--tools",
            "--strict-mcp-config",
            "--no-session-persistence",
            "--safe-mode",
        ] {
            assert!(args.iter().any(|a| a == expected), "missing {expected}: {args:?}");
        }
        // `--tools ""` is the flag that actually removes the built-in tool set.
        let tools_idx = args.iter().position(|a| a == "--tools").expect("--tools");
        assert_eq!(args[tools_idx + 1], "", "--tools must be given the empty string");

        for forbidden in [
            "--append-system-prompt",
            "--mcp-config",
            "--resume",
            "--allowedTools",
            "--dangerously-skip-permissions",
        ] {
            assert!(!args.iter().any(|a| a == forbidden), "must not pass {forbidden}");
        }
    }

    #[test]
    fn build_args_puts_the_prompt_first_so_a_variadic_flag_cannot_swallow_it() {
        // `--tools`, `--mcp-config` and `--allowedTools` are variadic in the CLI's parser, so a bare
        // positional following one of them is absorbed as another value. Leading with `-p` makes the
        // prompt an option-argument instead. This constraint is invisible from reading build_args,
        // which is exactly why it is pinned here.
        let args = build_args(MODEL, SYSTEM, USER);
        assert_eq!(args[0], "-p");
        assert_eq!(args[1], USER);
    }

    #[test]
    fn bare_flag_is_never_passed_because_it_disables_oauth() {
        // Under `--bare` the CLI reads auth ONLY from ANTHROPIC_API_KEY/apiKeyHelper and never from
        // the OAuth keychain — it would defeat this module's entire purpose. The test name is the
        // documentation.
        let args = build_args(MODEL, SYSTEM, USER);
        assert!(!args.iter().any(|a| a == "--bare"));
    }

    #[test]
    fn classify_result_json_reads_is_error_not_the_exit_code_or_subtype() {
        // Both fixtures carry `"subtype":"success"` and came from a process that exited 0. Anything
        // reading either would hand the error prose back as the model's answer — as an agent's NAME,
        // in naming.rs's case.
        for raw in [NOT_LOGGED_IN_JSON, BAD_MODEL_JSON] {
            let v: serde_json::Value = serde_json::from_str(raw).unwrap();
            assert_eq!(v.get("subtype").unwrap(), "success", "fixture must keep the trap intact");
            match classify_result_json(&v) {
                CliOutcome::Failed(_) => {}
                CliOutcome::Text(t) => panic!("must not treat a failed run as text, got {t:?}"),
            }
        }
    }

    #[test]
    fn classify_result_json_returns_the_result_text_on_success() {
        let v: serde_json::Value = serde_json::from_str(OK_JSON).unwrap();
        assert_eq!(classify_result_json(&v), CliOutcome::Text("DONE".to_string()));
    }

    #[test]
    fn a_dead_cli_that_names_a_broken_credential_gets_the_auth_sentinel_not_prose() {
        // The defect this covers: the CLI dies before writing any result JSON, so the reason is on
        // stderr and the JSON classifier never sees it. `run_with` returns a spawn error as the
        // sentinel verbatim — the same wire `CliOutcome::Failed` uses — so this prose reached every
        // consumer as a RETRYABLE generic failure, on a condition that stays broken until a human
        // signs in. Asserting the sentinel, not the input: the prose form is what shipped before.
        for detail in [
            "Failed to authenticate: OAuth session expired and could not be refreshed",
            "error: Not logged in",
            "Invalid API key provided",
        ] {
            assert_eq!(
                unusable_output_error(detail, Some(1), &[]),
                "claude_not_authenticated",
                "for {detail:?}"
            );
        }
    }

    #[test]
    fn an_unrecognised_death_keeps_its_exit_code_diagnosis() {
        // Recognition upgrades the message; it must never swallow the one diagnostic this path has
        // that the JSON path does not. A bad shebang, a missing dylib and an OOM kill are all
        // unclassifiable, and the exit code plus the stderr line is the whole diagnosis.
        let msg = unusable_output_error("dyld: Library not loaded: libnode.dylib", Some(133), &[]);
        assert!(msg.contains("claude exited"), "lost the exit code: {msg}");
        assert!(msg.contains("133"), "lost the exit status: {msg}");
        assert!(msg.contains("dyld"), "lost the stderr diagnosis: {msg}");

        // A silent death still says so, rather than reporting an empty reason.
        let quiet = unusable_output_error("", Some(9), &[]);
        assert!(quiet.contains("with no output"), "{quiet}");
        assert!(quiet.contains('9'), "{quiet}");
    }

    #[test]
    fn a_spent_allowance_on_stderr_is_a_usage_limit_not_a_generic_failure() {
        // Same wire, the other sticky-vs-transient condition: `claude_usage_limit` YIELDS to the
        // banner that names the user's own allowance, where the generic arm claims the product is
        // down. The loose arm is reachable here because the prompt has been stripped first — see
        // the argv-echo pair below; a CLI diagnostic that survives that cut is the CLI's own.
        assert_eq!(
            unusable_output_error("Claude usage limit reached", Some(1), &[]),
            "claude_usage_limit"
        );
    }

    /// A prompt that genuinely contains an account-state phrase — the realistic shape, not a
    /// contrived one: Sparkle's own calls summarise agent terminals, and an agent that hit its
    /// allowance says so in the text we hand to the CLI.
    const PROMPT_QUOTING_A_LIMIT: &str =
        "Summarise this terminal: [agent-7] Claude usage limit reached - resuming at 5pm.";

    #[test]
    fn an_argv_echo_of_our_own_prompt_never_decides_the_verdict() {
        // THE PAIRED WITNESS. `build_args` passes the prompt as `-p <user>`, and the ONLY failure
        // class that reaches `unusable_output_error` is a CLI that died before writing result JSON
        // — which is exactly the class that prints argv back at you: a parser error, a usage dump,
        // a Node stack trace. So the assumption that stderr cannot quote the request back is false
        // for this path, and a false `claude_usage_limit` is not a cosmetic error: it YIELDS in
        // `classifyServiceFailure`, and a yield RESETS the consecutive-failure run, holding a real
        // sustained outage below threshold while claiming the user's allowance is spent.
        let args = build_args("claude-haiku-4-5", "you are a summariser", PROMPT_QUOTING_A_LIMIT);

        // ECHOED — the phrase is in OUR argv, so it must not vote.
        let echoed =
            format!("error: unknown option '--safe-mode'\nUsage: claude -p {PROMPT_QUOTING_A_LIMIT} --model <model>");
        let verdict = unusable_output_error(&echoed, Some(2), &args);
        assert_ne!(verdict, "claude_usage_limit", "our own prompt decided the verdict: {verdict}");
        assert!(
            verdict.contains("unknown option"),
            "the real diagnosis must survive the strip: {verdict}"
        );

        // NOT ECHOED — the CLI's own words, under the SAME argv. The guard must not deafen this.
        assert_eq!(
            unusable_output_error("Claude usage limit reached|resets 5pm", Some(1), &args),
            "claude_usage_limit",
            "a genuine allowance message must still classify"
        );
    }

    /// A prompt that contains the CLI's own AUTH sentence — the correlated collision, which is the
    /// shape that made an unconditional strip dangerous.
    const PROMPT_QUOTING_AN_AUTH_FAILURE: &str =
        "Summarise this terminal: [agent-3] Failed to authenticate: session expired - stopping.";

    #[test]
    fn an_echo_straddling_the_human_clamp_is_still_stripped() {
        // THE FULL-VS-SHOWN SPLIT, and the fixture has to be built precisely or it proves nothing.
        //
        // The hole: `detail` was clamped to 200 chars BEFORE classifying, so an echo that STRADDLES
        // the clamp left a residual fragment shorter than one 32-char detection window — invisible
        // to the strip — while still carrying the 19-char phrase `usage limit reached`, which is
        // long enough to vote. Clamped-then-classified therefore returns the false sentinel.
        //
        // So the prompt must BEGIN with the voting phrase, and the padding must place exactly a
        // sub-window slice of it inside the clamp. Both facts are asserted below, because a fixture
        // where the clamp simply misses the phrase passes whether or not the bug is present — the
        // first cut of this test did exactly that and its mutation came back green.
        let prompt = "usage limit reached on agent-7; summarise the terminal above for the reader";
        let args = build_args("claude-haiku-4-5", "you are a summariser", prompt);
        let padding = "x".repeat(176);
        let full = format!("{padding}{prompt}");
        let shown: String = full.chars().take(200).collect();

        let inside: String = shown.chars().skip(176).collect();
        assert!(
            inside.chars().count() < ARGV_ECHO_WINDOW,
            "the slice inside the clamp must be too short to detect as an echo, got {}",
            inside.chars().count()
        );
        assert!(
            shown.contains("usage limit reached"),
            "but long enough to carry the voting phrase, or this proves nothing"
        );

        let verdict = unusable_output_error_from(&full, &shown, Some(2), &args);
        assert_ne!(
            verdict, "claude_usage_limit",
            "an echo straddling the clamp still decided the verdict: {verdict}"
        );
    }

    #[test]
    fn a_sentinel_our_prompt_also_contains_is_not_stripped_away() {
        // THE CORRELATED COLLISION, and the reason the strip is survivorship-gated rather than
        // unconditional. When the fleet is signed out, the SAME lapse puts
        // "Failed to authenticate: session expired" in the terminal we are summarising AND in our
        // own CLI's stderr. An unconditional strip blanks it as "ours" and the auth arm goes silent
        // exactly when it is true — and that arm is the STICKY one, unfixable by retrying, so
        // losing it is strictly worse than the false positive the strip was added for.
        //
        // What distinguishes this from an echo is what SURVIVES: here the shared span is the whole
        // message, so cutting it leaves nothing to read, and the honest reading is the original.
        let args = build_args("claude-haiku-4-5", "you are a summariser", PROMPT_QUOTING_AN_AUTH_FAILURE);
        assert_eq!(
            unusable_output_error("Failed to authenticate: session expired", Some(1), &args),
            "claude_not_authenticated",
            "a true diagnosis our prompt happens to quote must survive the strip"
        );
    }

    #[test]
    fn a_diagnosis_after_a_huge_echo_is_still_read() {
        // THE CLASSIFICATION BOUND, which no fixture reached before: the other witnesses are a few
        // hundred chars and can only observe the 200-char HUMAN clamp.
        //
        // `build_args` puts `-p <user>` first and a prompt may be 128 KiB of terminal output, so an
        // argv dump is echo-at-the-front and diagnosis-at-the-back by construction. Reading only the
        // head therefore discarded the reason the process died — and worse, with the whole head
        // being echo the strip blanked all of it, so the fallback classified our own prompt.
        let mut prompt = String::new();
        while prompt.chars().count() < CLASSIFY_MAX_CHARS + 2_000 {
            prompt.push_str("[agent-9] Claude usage limit reached; retrying shortly. ");
        }
        let args = build_args("claude-haiku-4-5", "you are a summariser", &prompt);
        let full = format!("Usage: claude -p {prompt}\nFailed to authenticate: session expired");
        assert!(
            full.chars().count() > CLASSIFY_MAX_CHARS,
            "the fixture must exceed the classification bound, or it proves nothing"
        );

        assert_eq!(
            unusable_output_error_from(&full, &full.chars().take(200).collect::<String>(), Some(1), &args),
            "claude_not_authenticated",
            "a diagnosis printed after a huge echo must still be read"
        );
    }

    #[test]
    fn an_argv_echo_cannot_fake_the_AUTH_arm_either() {
        // THE FALSE POSITIVE ONE ARM OVER, and the case that killed the kind-only gate. A CLI
        // upgrade removes a flag — the failure class this whole path was written for — and the
        // usage dump echoes a prompt that happens to contain an auth sentence. The CLI's own reason
        // (`unknown option`) survives the strip, so it is what died, and an auth phrase living only
        // inside our own text must not overrule it.
        //
        // A false auth sentinel is not the safer trade: `aiServiceHealthStore` puts it in the SAME
        // `yield` bucket as `claude_usage_limit` (so it resets the consecutive-failure run exactly
        // the same way), and it additionally raises a sign-in banner for a failure that signing in
        // cannot fix.
        let args = build_args("claude-haiku-4-5", "you are a summariser", PROMPT_QUOTING_AN_AUTH_FAILURE);
        let dump = format!(
            "error: unknown option '--safe-mode'\nUsage: claude -p {PROMPT_QUOTING_AN_AUTH_FAILURE} --model <model>"
        );
        let verdict = unusable_output_error(&dump, Some(2), &args);
        assert_ne!(
            verdict, "claude_not_authenticated",
            "our own prompt faked an auth lapse: {verdict}"
        );
        assert!(
            verdict.contains("unknown option"),
            "and the CLI's own reason must be what the reader sees: {verdict}"
        );
    }

    #[test]
    fn the_seam_between_the_two_halves_cannot_fabricate_a_phrase() {
        // THE SPLICE, and the fixture has to keep the abutting text OUT of argv or it proves
        // nothing. My first cut made the whole body an echo of the prompt: `strip_argv_echo` then
        // blanked both halves, no phrase could survive the seam either way, and the mutation came
        // back green. The text that meets at the seam must be the CLI's own.
        //
        // Every phrase the classifier matches is newline-free, so the separator is the only thing
        // stopping a head ending "…Claude usage " from abutting a tail starting "limit reached…"
        // and manufacturing a verdict present in NEITHER half.
        let half = CLASSIFY_MAX_CHARS / 2;
        let head_tail = "Claude usage ";
        let tail_head = "limit reached";
        let head: String = "z".repeat(half - head_tail.chars().count()) + head_tail;
        let tail: String = tail_head.to_string() + &"t".repeat(half - tail_head.chars().count());
        let full = format!("{head}{}{tail}", "m".repeat(100));
        assert_eq!(head.chars().count(), half, "the head must land exactly on the cut");
        assert_eq!(tail.chars().count(), half, "and the tail must start exactly at it");

        // An UNRELATED prompt, so nothing at the seam is ours and the strip cannot blank it.
        let args = build_args("claude-haiku-4-5", "you are a summariser", "summarise the terminal output above for the reader");
        assert!(
            !args.iter().any(|a| a.contains("usage limit")),
            "no argument may contain the phrase, or the strip would remove it for the wrong reason"
        );

        assert_ne!(
            unusable_output_error_from(&full, "clipped", Some(2), &args),
            "claude_usage_limit",
            "the head/tail seam fabricated a phrase that is in neither half"
        );
    }

    #[test]
    fn the_no_output_log_names_the_sentinel_and_never_the_raw_stderr() {
        // A SOURCE-SHAPE PIN, and its limits are stated rather than implied. The `tracing::warn!`
        // this guards lives in `spawn_claude`, which needs a real child process — `run_isolated`
        // replaces the spawn entirely, so no behavioural harness in this file can reach that line.
        // The sibling `the_failure_log_never_carries_the_clis_own_result_body` covers the JSON path
        // because that one IS reachable.
        //
        // What it proves: the raw-stderr field cannot come back silently. On this path stderr
        // begins with our own argv, so `detail` is up to 200 characters of the user's terminal, and
        // this log is persisted into consented support and crash uploads whose redaction removes
        // credentials and paths but deliberately not ordinary prose.
        let src = include_str!("claude_oneshot.rs");
        let start = src.find("fn spawn_claude").expect("spawn_claude must exist");
        let end = src[start..].find("\nfn ").map_or(src.len(), |o| start + o);
        let body = &src[start..end];
        assert!(
            body.contains("sentinel = %loggable_sentinel"),
            "the no-output warn must log the classified sentinel"
        );
        // PINNED ON SUBSTANCE, not one spelling. `detail = %detail` was the only banned literal, so
        // `detail = ?detail`, `stderr = %detail`, `head = %full`, or an ADDITIONAL raw field beside
        // the sentinel all reintroduced the leak with this assertion green.
        let warn_start = body.find("tracing::warn!").expect("the no-output warn must exist");
        let warn_end = warn_start + body[warn_start..].find(");").expect("unterminated warn!") ;
        let warn = &body[warn_start..warn_end];
        // BAN THE IDENTIFIER, not a list of sigil spellings. The previous list missed `{detail:?}`
        // — it contains `{detail` but not `{detail}` — which is the shape a future edit is most
        // likely to reach for, because the surrounding messages already write `{code:?}` five
        // times. A `{<id>` prefix covers `{detail}`, `{detail:?}` and `{detail:#?}` at once.
        for id in ["detail", "full", "stderr"] {
            for spelling in [format!("%{id}"), format!("?{id}"), format!("{{{id}")] {
                assert!(
                    !warn.contains(&spelling),
                    "the no-output warn interpolates {spelling} — that is raw stderr, which on this \
                     path is the user's own terminal: {warn}"
                );
            }
        }
    }

    #[test]
    fn a_usage_banner_that_quoted_nothing_is_still_shown_to_the_reader() {
        // "WHAT SURVIVED IS ONLY A BANNER" IS NOT "WE FOUND AN ECHO". `strip_argv_echo` returns its
        // input unchanged when no argv window matches, so a genuine `Usage: claude [options]` —
        // which quoted nothing of ours — satisfied the banner test and got told it was our own
        // invocation echoed back. False, and it suppressed the only text the reader had.
        let args = build_args("claude-haiku-4-5", "you are a summariser", "summarise the terminal output above for the reader");
        let stderr = "Usage: claude [options] [command]";
        let verdict = unusable_output_error(stderr, Some(64), &args);
        assert!(
            verdict.contains("Usage: claude [options]"),
            "a banner that quoted nothing must still reach the reader: {verdict}"
        );
        assert!(
            !verdict.contains("echoed back"),
            "and must not be announced as an echo that never happened: {verdict}"
        );
    }

    #[test]
    fn a_reason_past_the_clamp_is_recovered_rather_than_declared_absent() {
        // THE DIAGNOSIS WE ALREADY HOLD. `stripped` is the argv-stripped scan of the whole bounded
        // body, so the CLI's reason can sit just past the 200-char clamp — in hand, and previously
        // thrown away while telling the reader nothing was found. Inside the scan bound, so this is
        // distinct from the truncated case where the reason genuinely is unreachable.
        let mut prompt = String::new();
        while prompt.chars().count() < 400 {
            prompt.push_str("[agent-8] type /login to continue; the session expired earlier. ");
        }
        let args = build_args("claude-haiku-4-5", "you are a summariser", &prompt);
        let full = format!("Usage: claude -p {prompt}\nerror: unknown option '--safe-mode'");
        let shown: String = full.chars().take(200).collect();
        assert!(full.chars().count() < CLASSIFY_MAX_CHARS, "must fit the scan, or it tests the wrong gate");
        assert!(!shown.contains("unknown option"), "and must NOT fit the clamp, or it proves nothing");

        let verdict = unusable_output_error_from(&full, &shown, Some(2), &args);
        assert!(
            verdict.contains("unknown option '--safe-mode'"),
            "the reason was already read and must reach the reader: {verdict}"
        );
        assert!(
            !verdict.contains("/login"),
            "without replaying the user's terminal: {verdict}"
        );
    }

    #[test]
    fn short_echoed_lines_never_reach_the_reader_through_the_recovery() {
        // THE LEAK THE RECOVERY ITSELF OPENED. `strip_argv_echo` blanks a span only when a full
        // 32-char window matches, so any echoed line SHORTER than that survives the strip — and
        // agent terminal output, which is exactly what the prompt is on this path, is full of short
        // lines. Collecting every surviving non-banner line rebuilt a montage of the user's own
        // terminal and printed it as the CLI's error.
        //
        // The fixture is that shape: a long line to fill the clamp, then short ones the strip
        // cannot reach, and one genuine CLI reason. Only the reason may come back.
        let long_line = "[agent-3] ".to_string() + &"a summarised terminal line long enough to be stripped. ".repeat(6);
        let shorts = "kubectl top\npsql -c 'x'\nvim notes.md\nssh box-2\ngit push -f";
        let prompt = format!("{long_line}\n{shorts}");
        let args = build_args("claude-haiku-4-5", "you are a summariser", &prompt);
        let full = format!("Usage: claude -p {prompt}\nerror: unknown option '--safe-mode'");
        let shown: String = full.chars().take(200).collect();

        let verdict = unusable_output_error_from(&full, &shown, Some(2), &args);
        for leaked in ["kubectl", "psql", "vim notes", "ssh box-2", "git push -f"] {
            assert!(
                !verdict.contains(leaked),
                "a short echoed line reached the reader through the recovery ({leaked}): {verdict}"
            );
        }
        assert!(
            verdict.contains("unknown option '--safe-mode'"),
            "while the CLI's own reason must still come back: {verdict}"
        );
    }

    #[test]
    fn the_recovery_never_re_glues_the_head_tail_seam() {
        // `bounded_scan` separates the halves with a newline because a head ending "…Claude usage "
        // abutting a tail starting "limit reached…" fabricates a phrase in neither half. The
        // recovery spans that cut, so joining its lines with a bare space rebuilt the seam and then
        // showed the result to the user as the CLI's own words.
        //
        // THE FIXTURE HAS TO REACH THE RECOVERY, and an earlier one did not: it passed a `shown` of
        // `"clipped"`, which is under `ARGV_ECHO_WINDOW`, so `strip_argv_echo` returned it unchanged,
        // `echo_found` was false, the function took the plain `{shown}` arm and `recovered` was
        // computed and thrown away. The assertion below then held of a string that could not have
        // contained the phrase under ANY separator — green against the bare-space join it exists to
        // ban. So `shown` is derived the way the call site derives it, from a body whose head really
        // is an argv dump.
        let half = CLASSIFY_MAX_CHARS / 2;
        let mut echo = String::new();
        while echo.chars().count() < half {
            echo.push_str("[agent-9] a summarised terminal line long enough to be stripped. ");
        }
        let args = build_args("claude-haiku-4-5", "you are a summariser", &echo);

        // Head: the usage dump, ending on the CLI's own half-phrase as its own line. Exactly `half`
        // chars, so `bounded_scan` cuts precisely here.
        // Both halves are whole CLI sentences, not bare fragments: `has_novel_run` requires a novel
        // run to survive dropping the line's first token, so a two-word fragment is filtered as
        // decoration and the fixture would test nothing.
        let seam_head = "\nError: Claude usage ";
        let prefix: String = format!("Usage: claude -p {echo}")
            .chars()
            .take(half - seam_head.chars().count())
            .collect();
        let head = format!("{prefix}{seam_head}");
        // Tail: the other half-phrase first, then more echo. Also exactly `half` chars.
        let mut suffix = String::from("limit reached; retry after the reset window\n");
        while suffix.chars().count() < half {
            suffix.push_str(&echo);
        }
        let tail: String = suffix.chars().take(half).collect();
        // A middle that is dropped, which is what makes the scan truncate and the seam exist.
        let full = format!("{head}{}{tail}", "m".repeat(200));
        assert_eq!(head.chars().count(), half, "the head must land exactly on the cut");
        assert_eq!(tail.chars().count(), half, "and so must the tail");

        let shown: String = full.chars().take(200).collect();
        let verdict = unusable_output_error_from(&full, &shown, Some(2), &args);

        // The recovery arm ran — without this the assertion below can pass by not being reached.
        assert!(
            verdict.contains("Claude usage") && verdict.contains("limit reached"),
            "the fixture must reach the recovery and carry BOTH halves: {verdict}"
        );
        assert!(
            !verdict.contains("Claude usage limit reached"),
            "the recovery re-glued the seam into a phrase present in neither half: {verdict}"
        );
    }

    #[test]
    fn a_mixed_line_of_framing_and_echo_does_not_leak_the_echo() {
        // THE DECORATED DUMP — framing and echo on ONE line, which is the shape this path names as
        // its own failure class (`a usage dump or a Node stack trace`). Whole-line membership
        // cannot help here: the line is not wholly inside any argument, so it passes that test and
        // would be emitted raw. Only the span-level strip reaches the echoed run inside it.
        let mut prompt = String::new();
        while prompt.chars().count() < 400 {
            prompt.push_str("[agent-3] a summarised terminal line long enough to be stripped. ");
        }
        let args = build_args("claude-haiku-4-5", "you are a summariser", &prompt);
        let full = format!("Usage: claude -p {prompt}\nerror: unknown option '--safe-mode'\n  argv: -p {prompt}");
        let shown: String = full.chars().take(200).collect();

        let verdict = unusable_output_error_from(&full, &shown, Some(2), &args);
        assert!(
            verdict.contains("unknown option '--safe-mode'"),
            "the CLI's own reason must survive: {verdict}"
        );
        assert!(
            !verdict.contains("summarised terminal line"),
            "a line mixing framing with an echoed run leaked the user's terminal: {verdict}"
        );
    }

    #[test]
    fn a_decorated_echo_block_is_not_montaged_into_the_message() {
        // THE SHAPE BOTH EARLIER FILTERS MISSED. The CLI decorates each echoed line (`  > ls -la`)
        // and wraps the block in quotes, so every line is too SHORT for the span strip and — being
        // prefixed — contained in no argument, which whole-line membership reads as "not ours" and
        // keeps. The result was a montage of the user's terminal presented as the CLI's error.
        //
        // THE ECHO MUST REACH THE READER THROUGH THE RECOVERY, not through the raw `{shown}` arm.
        // A first cut decorated EVERY line, including the long one — so the 200-char clamp still
        // held decorated short lines, `banner_only(shown_stripped)` was false, and the function took
        // the plain `{shown}` arm without ever building `recovered`. It leaked, but through a
        // different gate, and this filter was never exercised. So: an UNDECORATED long echoed run
        // right after the banner (that is what the clamp sees, and it strips to banner-only), with
        // the decorated block past the clamp where only `recovered` can carry it.
        let long_line = "a summarised terminal line long enough that the span strip reaches it on its own".repeat(3);
        // `ls -la` is deliberately UNDER `NOVEL_RUN` (6 chars): the window test cannot reach a tail
        // that short, so it is what pins the short-tail membership check. The fixture used to stand
        // on a one-character accident — `psql -c 'x` is exactly 10 and `git push -f` is 11 — and
        // would have leaked silently had either lost a character.
        let shorts = ["ls -la", "kubectl top", "psql -c 'x'", "vim notes.md", "git push -f"];
        let filler = "cd /tmp && tail -f build.log";
        let prompt = format!("{long_line}\n{filler}\n{}", shorts.join("\n"));
        let args = build_args("claude-haiku-4-5", "you are a summariser", &prompt);
        // FIVE DECORATION SHAPES, not one. Each appears in NO argument, so the span strip cannot
        // reach it and whole-line membership cannot recognise it — but they defeat DIFFERENT parts
        // of the peel, and a fixture carrying only `  > ` cannot tell "peels punctuation at the
        // head" from "recognises decoration":
        //   `  > x`             leading sigil  — edge trimming reaches it
        //   `  > x"`            trailing quote — `t push -f"` is novel purely because the quote is
        //                                        not in the prompt
        //   `[stderr] x`        tag            — novelty is INSIDE the core (`stderr] ls`), which no
        //                                        edge trim can reach; needs a token dropped
        //   `  > x |`           trailing pipe  — as the quote, with a suffix instead of a wrapper
        //   `[stderr] [12:03] x` DOUBLE tag    — survives ONE dropped token (`12:03] kubectl` is
        //                                        novel), so it pins the peel as a LOOP. Level plus
        //                                        timestamp is an ordinary log shape, and this was
        //                                        once mis-recorded in the source as an accepted
        //                                        loss when it was a live leak.
        //   `[stderr] ls -la`   tag + SHORT    — the content is under NOVEL_RUN, so the window test
        //                       content          cannot reach it at all and the loop's short-tail
        //                                        membership check is the only thing that drops it.
        //                                        This is the file's own example of the tag leak, and
        //                                        it was still open while the fixture stood on
        //                                        `psql -c 'x` being exactly 10 characters.
        //
        // THE FIRST DECORATED LINE IS A FILLER, and that is load-bearing rather than padding. The
        // strip's blanked span reaches one window PAST the end of the long echoed run — the prompt
        // ends that run with a newline too, so the window `<31 chars>\n` matches — which swallows the
        // newline and merges the next line into the `Usage:` line. Whatever sits there is therefore
        // dropped as a banner, by a path that has nothing to do with this filter. The first version
        // of this fixture put `[stderr] ls -la` there and pinned nothing: removing the short-tail
        // check entirely left the suite green.
        let decorated = [
            format!("  > {}", filler),
            format!("[stderr] {}", shorts[0]),
            format!("  > {}\"", shorts[1]),
            format!("[stderr] {}", shorts[2]),
            format!("  > {} |", shorts[3]),
            format!("[stderr] [12:03:04] {}", shorts[4]),
        ]
        .join("\n");
        let full = format!("Usage: claude -p {long_line}\n{decorated}\nerror: unknown option '--safe-mode'");
        let shown: String = full.chars().take(200).collect();
        assert!(
            shown.chars().count() == 200 && !shown.contains("unknown option"),
            "the clamp must be pure banner-plus-echo, or the recovery is never reached: {shown}"
        );

        let verdict = unusable_output_error_from(&full, &shown, Some(2), &args);
        assert!(
            verdict.contains("unknown option '--safe-mode'"),
            "the CLI's own reason must survive: {verdict}"
        );
        for leaked in ["kubectl", "psql", "git push -f", "vim notes.md", "ls -la"] {
            assert!(
                !verdict.contains(leaked),
                "a decorated echo line leaked the user's terminal ({leaked}): {verdict}"
            );
        }
    }

    #[test]
    fn a_diagnosis_naming_a_flag_we_passed_is_not_filtered_away_as_echo() {
        // THE FLAGSHIP CASE OF THIS ARM: a CLI too old for a flag we send. The reason names the flag,
        // so the line ENDS in our own argv — and a peel that lets any all-ours remainder condemn the
        // line reads that as proof of echo and discards the one diagnosis worth surfacing.
        // `--safe-mode` cannot catch this: it trims to `safe-mode`, nine chars, one under NOVEL_RUN,
        // so it breaks out of the loop rather than being judged. Every longer flag in `build_args`
        // is exposed, which is why this fixture uses one.
        let long_line = "a summarised terminal line long enough that the span strip reaches it on its own".repeat(3);
        let args = build_args("claude-haiku-4-5", "you are a summariser", &long_line);
        assert!(
            args.iter().any(|a| a == "--strict-mcp-config"),
            "the fixture must name a flag we really pass, or it proves nothing"
        );
        let full = format!("Usage: claude -p {long_line}\nerror: unknown option '--strict-mcp-config'");
        let shown: String = full.chars().take(200).collect();

        let verdict = unusable_output_error_from(&full, &shown, Some(2), &args);
        assert!(
            verdict.contains("unknown option '--strict-mcp-config'"),
            "a diagnosis naming our own flag was filtered away as echo: {verdict}"
        );
        // THE PERMISSIVE DIRECTION NEEDS ITS OWN GUARD. This is the one fixture arguing for KEEPING
        // a line, so without a negative assertion a future loosening that keeps the diagnosis AND
        // rebuilds the montage passes it — the direction that can only fail by leaking would be the
        // one left unchecked.
        assert!(
            !verdict.contains("summarised terminal line"),
            "the echo reached the reader alongside the diagnosis: {verdict}"
        );
    }

    #[test]
    fn a_reason_ending_in_a_BARE_argv_element_still_reaches_the_reader() {
        // THE SINGLE-TOKEN DIRECTION, which nothing pinned while a whitespace guard was briefly
        // deleted. `args` is mostly one-token elements and `a.lines()` on a one-line string yields
        // that string, so each is trivially a "whole line" — the pinned model id, every flag in its
        // UNQUOTED form, and the value `json`. The two existing fixtures both use QUOTED flags and
        // pass by an accident: trimming the tail eats its `--` while the argument keeps it. These
        // cases have no such escape.
        let long_line = "a summarised terminal line long enough that the span strip reaches it on its own".repeat(3);
        let args = build_args("claude-haiku-4-5", "you are a summariser", &long_line);
        for reason in [
            "error: invalid model claude-haiku-4-5",
            "error: unknown option --strict-mcp-config",
            "error: unsupported output format json",
        ] {
            let bare = reason.rsplit(' ').next().unwrap();
            assert!(
                args.iter().any(|a| a == bare),
                "the fixture must end in a REAL argv element, or it proves nothing: {bare}"
            );
            let full = format!("Usage: claude -p {long_line}\n{reason}");
            let shown: String = full.chars().take(200).collect();
            let verdict = unusable_output_error_from(&full, &shown, Some(2), &args);
            assert!(
                verdict.contains(reason),
                "a diagnosis ending in a bare argv element was condemned as echo: {verdict}"
            );
        }
    }

    #[test]
    fn a_diagnosis_QUOTING_a_whole_prompt_line_is_not_condemned() {
        // THE ASYMMETRY RULE. The `bare` fallback exists so a quote-WRAPPED echo still matches
        // (`  > kubectl top"` carries one stray quote the prompt line does not have) — but it also
        // strips the quotes off a CLI that QUOTES a short line back at us, which is not an interior
        // fragment and had been asserted away as impossible. Decoration is a prefix or a suffix; a
        // quotation closes what it opens.
        let long_line = "a summarised terminal line long enough that the span strip reaches it on its own".repeat(3);
        let prompt = format!("{long_line}\nls -la\nkubectl top");
        let args = build_args("claude-haiku-4-5", "you are a summariser", &prompt);
        assert!(
            prompt.lines().any(|l| l.trim() == "ls -la"),
            "the quoted phrase must be a WHOLE prompt line, or the fallback never fires"
        );
        assert!(
            args.iter().any(|a| a.lines().any(|l| l.trim() == "kubectl top")),
            "and the guard's line must be one too, or the rule under test never condemns it"
        );
        // The filler absorbs the strip's span-merge: the prompt ends its long run with a newline
        // too, so the window `<31 chars>\n` matches and the next line is pulled into the `Usage:`
        // line and dropped as a banner. Without it this fixture reds for a reason unrelated to its
        // name — as it did on first run.
        let full = format!(
            "Usage: claude -p {long_line}\n  > cd /tmp\n[stderr] kubectl top\nerror: cannot parse 'ls -la'"
        );
        let shown: String = full.chars().take(200).collect();
        // THE FILLER DEPENDENCY IS ASSERTED, not just described. Declaring it load-bearing in prose
        // is what the previous commit did, and prose does not fail: delete `  > cd /tmp` and the
        // span-merge pulls `[stderr] kubectl top` into the `Usage:` line, where the banner test
        // drops it — the positive assertion still passes, and the negative guard passes BECAUSE the
        // line never reached the filter. Both green, rule never exercised.
        assert!(
            strip_argv_echo(&full, &args)
                .lines()
                .any(|l| l.trim() == "[stderr] kubectl top"),
            "the filler must keep the guard's line out of the merged banner, or both assertions below are vacuous"
        );

        let verdict = unusable_output_error_from(&full, &shown, Some(2), &args);
        assert!(
            verdict.contains("cannot parse 'ls -la'"),
            "a diagnosis quoting a whole prompt line was condemned as echo: {verdict}"
        );
        // THE PERMISSIVE DIRECTION NEEDS ITS OWN GUARD — and this fixture argues for keeping a line
        // by LOOSENING the condemnation path, so it is exactly the one that must fail if the rule
        // stops condemning altogether. The guard has to be aimed at a line only THIS rule can drop:
        // `long_line` is removed by the span strip, and the filler never reaches the filter at all
        // (the merge described above pulls it into the `Usage:` line, where the banner test drops
        // it) — so asserting on either would have been another guard no mutation could red. The
        // `[stderr] kubectl top` line is condemned by the rule under test and nothing else.
        //
        // WHICH MAKES THE FILLER LOAD-BEARING FOR THIS GUARD, not decoration: delete it and the
        // merge eats `[stderr] kubectl top` instead, the rule is never exercised, and BOTH
        // assertions below pass vacuously.
        assert!(
            !verdict.contains("kubectl top"),
            "the echo reached the reader alongside the diagnosis: {verdict}"
        );
        assert!(
            !verdict.contains("summarised terminal line"),
            "and the long echoed run must still be gone: {verdict}"
        );
    }

    #[test]
    fn a_symmetrically_wrapped_echo_line_is_a_recorded_leak() {
        // THIS TEST ASSERTS A LEAK, deliberately — loss 4, and the direct price of the rule that
        // stops a quoting diagnosis being condemned. A wrap applied PER LINE is symmetric, so
        // `"kubectl top"` takes the same exit as `'ls -la'`. The two are the same string shape; no
        // rule at this level can separate them.
        //
        // IF YOU MAKE THIS FAIL, that is an improvement: update the assertion deliberately rather
        // than deleting the test.
        let long_line = "a summarised terminal line long enough that the span strip reaches it on its own".repeat(3);
        let prompt = format!("{long_line}\nkubectl top");
        let args = build_args("claude-haiku-4-5", "you are a summariser", &prompt);
        // WITHOUT THIS PRECONDITION THE LEAK TEST DISARMS ITSELF SILENTLY: if a prompt edit stops
        // `kubectl top` being a standalone line, the line is genuinely novel, `contains` still
        // passes, and the fixture reports green while pinning nothing about the symmetric-quote
        // exit it exists for.
        assert!(
            args.iter().any(|a| a.lines().any(|l| l.trim() == "kubectl top")),
            "the echoed content must be a WHOLE argument line, or the rule never had a chance to condemn"
        );
        let full = format!(
            "Usage: claude -p {long_line}\n  > cd /tmp\n[stderr] \"kubectl top\"\nerror: unknown option '--safe-mode'"
        );
        let shown: String = full.chars().take(200).collect();

        let verdict = unusable_output_error_from(&full, &shown, Some(2), &args);
        assert!(
            verdict.contains("unknown option '--safe-mode'"),
            "the CLI's own reason must still survive: {verdict}"
        );
        assert!(
            verdict.contains("kubectl top"),
            "the recorded leak no longer happens — good; update this assertion on purpose: {verdict}"
        );
    }

    #[test]
    fn a_single_token_echoed_line_behind_a_tag_is_a_recorded_leak() {
        // THIS TEST ASSERTS A LEAK, deliberately — the price of requiring a condemning remainder to
        // be multi-token, which is what stops `error: invalid model claude-haiku-4-5` from being
        // read as echo. Without a fixture the loss is indistinguishable from an oversight, and this
        // file's convention is to pin the ones it accepts.
        //
        // IF YOU MAKE THIS FAIL, that is an improvement: update the assertion deliberately rather
        // than deleting the test.
        let long_line = "a summarised terminal line long enough that the span strip reaches it on its own".repeat(3);
        let prompt = format!("{long_line}\nmake");
        let args = build_args("claude-haiku-4-5", "you are a summariser", &prompt);
        // Same disarm as loss 4's fixture: reflow the prompt and `make` is genuinely novel, so the
        // line survives for a reason unrelated to the guard whose price this test records.
        assert!(
            args.iter().any(|a| a.lines().any(|l| l.trim() == "make")),
            "the echoed content must be a WHOLE argument line, or the rule never had a chance to condemn"
        );
        let full = format!("Usage: claude -p {long_line}\n  > cd /tmp\n[warn] make\nerror: unknown option '--safe-mode'");
        let shown: String = full.chars().take(200).collect();

        let verdict = unusable_output_error_from(&full, &shown, Some(2), &args);
        assert!(
            verdict.contains("unknown option '--safe-mode'"),
            "the CLI's own reason must still survive: {verdict}"
        );
        assert!(
            verdict.contains("make"),
            "the recorded leak no longer happens — good; update this assertion on purpose: {verdict}"
        );
    }

    #[test]
    fn a_short_cli_reason_is_not_filtered_away_as_decoration() {
        // THE OTHER SIDE OF THE PEEL: the recovery arm exists to hand the reader the CLI's own
        // reason, so a terse one must not degrade to "no recognised failure was found".
        //
        // WHAT ACTUALLY SAVES THIS LINE — restated a second time, because the mechanism moved out
        // from under the comment. It is NOT that the loop breaks early (it does not), and it is no
        // longer that the prompt omits the phrase (there is no substring test any more): `timed out`
        // survives because no argument has a LINE equal to it. The sibling below proves the phrase's
        // presence is now irrelevant by asserting survival with a prompt that contains it.
        let long_line = "a summarised terminal line long enough that the span strip reaches it on its own".repeat(3);
        assert!(
            !long_line.lines().any(|l| l.trim() == "timed out"),
            "no argument line may EQUAL the tail, which is the only thing that condemns"
        );
        let args = build_args("claude-haiku-4-5", "you are a summariser", &long_line);
        let full = format!("Usage: claude -p {long_line}\nerror: timed out");
        let shown: String = full.chars().take(200).collect();

        let verdict = unusable_output_error_from(&full, &shown, Some(2), &args);
        assert!(
            verdict.contains("error: timed out"),
            "a terse CLI reason was filtered away as decoration: {verdict}"
        );
        assert!(
            !verdict.contains("summarised terminal line"),
            "and the echo must still not reach the reader: {verdict}"
        );
    }

    #[test]
    fn a_terse_reason_whose_tail_is_inside_a_prompt_line_survives() {
        // THIS TEST USED TO ASSERT A LOSS, and the loss is gone — recorded here because its own
        // comment asked for exactly this: "if you make this pass, that is an improvement; update the
        // assertion deliberately rather than deleting the test."
        //
        // Under substring membership, a reason was discarded whenever the terminal we were
        // summarising happened to contain its trailing phrase anywhere. The source declared that
        // unavoidable — "no rule reading only argv membership" could separate an echoed `ls -la`
        // from a real `timed out`, only a tag grammar could. That was wrong, and the rule was one
        // clause away: an echoed line is a WHOLE line of the prompt, while a reason's tail is an
        // interior fragment of one. Anchoring the comparison to whole lines keeps both.
        //
        // The prompt here is a single unbroken line CONTAINING `timed out`, so substring membership
        // condemns and line anchoring does not. That is the whole difference, isolated.
        let long_line = "curl: operation timed out while summarising the terminal for the reader".repeat(3);
        assert!(
            long_line.contains("timed out") && !long_line.lines().any(|l| l.trim() == "timed out"),
            "the prompt must CONTAIN the tail without having it as a whole line, or nothing is tested"
        );
        let args = build_args("claude-haiku-4-5", "you are a summariser", &long_line);
        let full = format!("Usage: claude -p {long_line}\nerror: timed out");
        let shown: String = full.chars().take(200).collect();

        let verdict = unusable_output_error_from(&full, &shown, Some(2), &args);
        assert!(
            verdict.contains("error: timed out"),
            "a real reason was discarded because its tail appears mid-line in the prompt: {verdict}"
        );
        assert!(
            !verdict.contains("operation timed out while summarising"),
            "and the echo itself must still not reach the reader: {verdict}"
        );
    }

    #[test]
    fn an_uppercase_usage_banner_is_screened_by_both_paths() {
        // ONE PREDICATE, BOTH CALLERS. The rescue screen was case-insensitive and the display
        // screen exact-case, so `USAGE:` passed one and failed the other — and the path that
        // failed is the one that decides what a human reads, which then replayed 200 characters of
        // their own terminal as the CLI's error.
        assert!(is_usage_banner("USAGE: claude -p ..."), "the banner is recognised in any case");
        assert!(is_usage_banner("  usage: claude"), "and after leading whitespace");
        assert!(!is_usage_banner("error: unknown option"), "but a real reason is not a banner");

        let mut prompt = String::new();
        while prompt.chars().count() < 400 {
            prompt.push_str("[agent-2] type /login to continue; the session expired earlier. ");
        }
        let args = build_args("claude-haiku-4-5", "you are a summariser", &prompt);
        let full = format!("USAGE: claude -p {prompt}");
        let shown: String = full.chars().take(200).collect();

        let verdict = unusable_output_error_from(&full, &shown, Some(2), &args);
        assert_ne!(
            verdict, "claude_not_authenticated",
            "an uppercase usage dump faked an auth lapse: {verdict}"
        );
        assert!(
            !verdict.contains("/login"),
            "and it must not replay the user's own terminal: {verdict}"
        );
    }

    #[test]
    fn a_truncated_body_whose_residue_IS_empty_still_refuses_the_rescue() {
        // THE ONLY SHAPE WHERE `!truncated` DECIDES, and until now nothing covered it: the sibling
        // test's residue is a `Usage:` line, so `stripped.trim().is_empty()` refuses on its own and
        // mutating `!truncated` out left every test green.
        //
        // Here the whole body is the prompt — no banner, no framing — so after the strip the
        // residue really is empty, while the body far exceeds the scan bound. That is ordinary: a
        // prompt may be MAX_PROMPT_BYTES (128 KiB), an order of magnitude over it. The middle we
        // never read is where the CLI's reason would be, so an empty residue proves nothing and the
        // rescue must not classify off the user's own terminal.
        let mut prompt = String::new();
        while prompt.chars().count() < CLASSIFY_MAX_CHARS * 2 {
            prompt.push_str("[agent-6] type /login to continue; the session expired earlier. ");
        }
        let args = build_args("claude-haiku-4-5", "you are a summariser", &prompt);

        // THE PRECONDITIONS ARE ASSERTED, not assumed. This fixture pins `!truncated` only while
        // BOTH hold: the body exceeds the scan bound (guaranteed by the loop) and the strip blanks
        // the whole scan so the residue is empty (NOT guaranteed — it depends on `build_args`
        // passing the prompt as one verbatim contiguous argument and on ARGV_ECHO_WINDOW staying
        // small enough to match the repeated sentence). If either drifts, the rescue is refused by
        // the residue check alone, the assertions below still pass, and `!truncated` is silently
        // un-pinned — the exact relocation this test was written to close.
        let (scan, trunc) = bounded_scan(&prompt);
        assert!(trunc, "the fixture must exceed the scan bound, or it tests the wrong gate");
        assert!(
            strip_argv_echo(&scan, &args).trim().is_empty(),
            "the residue must be EMPTY, or the residue check refuses on its own and !truncated \
             decides nothing"
        );

        let verdict = unusable_output_error_from(&prompt, "clipped", Some(2), &args);
        assert_ne!(
            verdict, "claude_not_authenticated",
            "a truncated body with an empty residue was treated as a collision: {verdict}"
        );
        assert_ne!(verdict, "claude_usage_limit", "nor any other sentinel: {verdict}");
    }

    #[test]
    fn a_truncated_scan_is_not_evidence_of_a_collision() {
        // THE TRUNCATION GATE. "Only framing survived" means "the shared span was the whole
        // message" ONLY when the whole message was read. Over a cut body it can equally mean the
        // CLI's reason was in the middle we skipped — so the rescue must not run at all.
        //
        // Built so the residue really is pure framing and the reason really is unreachable: head is
        // `Usage: claude -p ` plus echo, tail is pure echo, and `error: unknown option` sits in the
        // middle. The prompt carries `/login`, which `typed_cli_failure` matches loosely — a
        // summarised Claude Code terminal very often does.
        let mut prompt = String::new();
        while prompt.chars().count() < CLASSIFY_MAX_CHARS {
            prompt.push_str("[agent-4] type /login to continue; the session expired earlier. ");
        }
        let args = build_args("claude-haiku-4-5", "you are a summariser", &prompt);
        let full = format!("Usage: claude -p {prompt}\nerror: unknown option '--safe-mode'\n{prompt}");
        assert!(
            full.chars().count() > CLASSIFY_MAX_CHARS * 2,
            "the reason must be unreachable from BOTH ends, or the gate is not what is tested"
        );

        // `shown` DERIVED THE WAY THE CALL SITE DERIVES IT, not hand-supplied. Feeding the answer
        // in made the old second assertion true of the test and false of production: for this
        // `full` the first 200 chars are pure argv echo, so the reader would have got 200
        // characters of their own summarised terminal.
        let shown: String = full.chars().take(200).collect();
        assert!(
            !shown.contains("unknown option"),
            "the clamp must NOT contain the reason, or this asserts nothing about the real path"
        );

        let verdict = unusable_output_error_from(&full, &shown, Some(2), &args);
        assert_ne!(
            verdict, "claude_not_authenticated",
            "a truncated scan was treated as evidence and our own prompt decided the verdict"
        );
        // The reason is past both the clamp AND the classification bound, so it genuinely cannot
        // reach the reader. The message must say THAT rather than quote our prompt at them.
        assert!(
            !verdict.contains("/login"),
            "the message read our own prompt back to the user: {verdict}"
        );
        assert!(
            verdict.contains("echoed back"),
            "and it must name the echo as the reason there is nothing else: {verdict}"
        );
    }

    #[test]
    fn a_lone_usage_banner_echoing_our_prompt_is_not_a_collision() {
        // THE FALSE SIGN-IN BANNER. A usage dump is the failure shape that prints argv, so when the
        // whole body is `Usage: claude -p <our prompt>` the strip leaves only the banner — and the
        // rescue read that emptiness as "the CLI's own sentence was the shared span". It was not:
        // the CLI said nothing but "you invoked me wrong", and the `/login` deciding the verdict
        // lives only inside the terminal we were asked to summarise. Signing in cannot fix it.
        let args = build_args("claude-haiku-4-5", "you are a summariser", PROMPT_QUOTING_AN_AUTH_FAILURE);
        let dump = format!("Usage: claude -p {PROMPT_QUOTING_AN_AUTH_FAILURE} --model <model>");
        let verdict = unusable_output_error(&dump, Some(2), &args);
        assert_ne!(
            verdict, "claude_not_authenticated",
            "a bare usage banner faked an auth lapse from our own prompt: {verdict}"
        );
        assert!(
            verdict.contains("echoed back"),
            "and the reader must be told the output was our invocation: {verdict}"
        );
    }

    #[test]
    fn the_diagnosis_beside_an_echo_still_classifies() {
        // Spans are blanked, not the whole body discarded — otherwise the fix would trade a false
        // positive for a false negative, and the auth case (STICKY, unfixable by retrying) is the
        // one that matters most to keep. Note the pre-strip ordering: `is_account_limit` runs
        // first, so without the cut this body returns `claude_usage_limit` — the wrong sentinel
        // AND the wrong stickiness.
        let args = build_args("claude-haiku-4-5", "you are a summariser", PROMPT_QUOTING_A_LIMIT);
        let mixed = format!("{PROMPT_QUOTING_A_LIMIT}\nFailed to authenticate: session expired");
        assert_eq!(
            unusable_output_error(&mixed, Some(1), &args),
            "claude_not_authenticated",
            "the CLI's own diagnosis next to an echo must survive"
        );
    }

    #[test]
    fn strip_argv_echo_leaves_short_arguments_alone() {
        // Only free-text arguments are treated as ours. Matching on the flags and their short
        // values (`-p`, `json`, the model id) would blank out the CLI's legitimate complaint about
        // the very flag it rejected — the diagnosis, deleted by the guard meant to protect it.
        let args = build_args("claude-haiku-4-5", "sys", "hi");
        let detail = "error: unknown option '--output-format'; model claude-haiku-4-5 not found";
        assert_eq!(strip_argv_echo(detail, &args), detail);
    }

    #[test]
    fn typed_cli_failure_declines_prose_so_callers_can_tell_recognised_from_not() {
        // The seam's contract: `None` is what lets `unusable_output_error` keep its own message.
        // If this ever answered `Some` for arbitrary prose, every unclassified death would lose its
        // exit code and the test above would be the only thing left saying so.
        assert_eq!(typed_cli_failure("dyld: Library not loaded", None), None);
        assert_eq!(typed_cli_failure("", None), None);
        assert_eq!(
            typed_cli_failure("Failed to authenticate: session expired", None),
            Some("claude_not_authenticated")
        );
    }

    #[test]
    fn classify_cli_failure_maps_not_logged_in_to_the_auth_sentinel() {
        for s in [
            "Not logged in · Please run /login",
            "Please run /login to continue",
            "Invalid API key provided",
        ] {
            assert_eq!(classify_cli_failure(s, None), "claude_not_authenticated", "for {s:?}");
        }
    }

    #[test]
    fn an_unrefreshable_session_is_an_auth_failure_not_a_generic_service_failure() {
        // Observed shape, verbatim from a capture: an OAuth session that expired and whose refresh
        // failed. It names no "/login", is not "not logged in", and is not an "invalid api key", so
        // before this arm existed it fell to the generic `ai request failed: …` bottom arm — which
        // DEGRADES toward the banner claiming Sparkle's AI features are failing, on a condition only
        // the user signing in again can clear. One capture window held over a thousand of these from
        // a single expired session, every one of them mislabelled.
        for s in [
            "Failed to authenticate: OAuth session expired and could not be refreshed",
            "failed to authenticate: token refresh returned 401",
            "Your session expired. Sign in to continue.",
        ] {
            assert_eq!(classify_cli_failure(s, None), "claude_not_authenticated", "for {s:?}");
        }
    }

    #[test]
    fn a_spent_allowance_still_outranks_the_new_auth_phrases() {
        // The auth arm sits BELOW `is_account_limit` on purpose. A message carrying both — the
        // allowance is spent AND the CLI phrased it as an authentication failure — must stay
        // `claude_usage_limit`, or the 2026-08-02 fix is undone from the other direction: the user
        // would be sent to re-authenticate a session that is already fine and would come back to the
        // identical failure. Both sentinels yield, so this costs no banner; it costs the user the
        // correct remedy.
        assert_eq!(
            classify_cli_failure(
                "Failed to authenticate: Claude usage limit reached, limit resets at 4pm",
                None
            ),
            "claude_usage_limit"
        );
    }

    #[test]
    fn classify_cli_failure_maps_rate_limit_and_usage_limit() {
        assert_eq!(classify_cli_failure("overloaded", Some(429)), "ai_rate_limited");
        assert_eq!(classify_cli_failure("overloaded", Some(529)), "ai_rate_limited");
        assert_eq!(
            classify_cli_failure("You have hit your usage limit for this window", None),
            "claude_usage_limit"
        );
    }

    #[test]
    fn a_subscription_usage_limit_is_account_state_even_though_it_arrives_as_a_429() {
        // THE 2026-08-02 BUG. A spent subscription allowance comes back as a 429 carrying
        // usage-limit prose. With the status read first, every one of those was `ai_rate_limited` —
        // which `classifyServiceFailure` counts as a SERVICE failure, so ~40 minutes of the user's
        // own Claude quota being exhausted lit the app-shell "AI-Enhanced features are temporarily
        // unavailable — the AI service is rate-limited" banner and re-stamped it on every retry.
        // Sparkle's own service was healthy throughout; the banner told the user the product was
        // broken because THEIR account was out of allowance.
        //
        // `claude_usage_limit` YIELDS in that classifier and drives ProviderUnavailableBanner
        // instead, which names the real cause and the fact that it resets on its own.
        for prose in [
            "Claude usage limit reached. Your limit resets at 5:00pm.",
            "Claude usage limit reached",
            "You've hit your monthly spend limit · raise it at claude.ai/settings/usage",
            "Your credit balance is too low to access the Anthropic API",
        ] {
            assert_eq!(
                classify_cli_failure(prose, Some(429)),
                "claude_usage_limit",
                "a 429 whose prose names the account allowance is NOT a transient throttle: {prose:?}"
            );
        }
        // …and the genuine transient must be untouched: an overload 429/529 names no account
        // condition, so it stays the retryable sentinel that legitimately feeds the service banner.
        assert_eq!(classify_cli_failure("Overloaded", Some(529)), "ai_rate_limited");
        assert_eq!(classify_cli_failure("rate_limit_error: too many requests", Some(429)), "ai_rate_limited");
    }

    #[test]
    fn a_429_that_merely_quotes_prompt_text_is_still_a_transient() {
        // roborev 57501 (Medium). The account-state check runs BEFORE the status now, and
        // `result_text` can quote the request back — so matching a bare word would let Sparkle's
        // own prompt content decide the classification. That is worse than the bug it fixes:
        // `claude_usage_limit` yields, a yield RESETS the failure run, and recurring prose would
        // hold a genuine sustained outage permanently below threshold. These are the shapes an
        // agent's terminal output, a judge input or an attention screen really can contain.
        for echoed in [
            "Overloaded (request was: 'check the quota logic in pusherFleet.ts')",
            "Overloaded: rate limit handling for the usage limit banner",
            "Overloaded — prompt mentioned quota, spend, and credit balance separately",
        ] {
            assert_eq!(
                classify_cli_failure(echoed, Some(429)),
                "ai_rate_limited",
                "echoed prompt text must not decide the account verdict: {echoed:?}"
            );
        }
    }

    #[test]
    fn the_failure_log_never_carries_the_clis_own_result_body() {
        // roborev 57501 (Medium), and a NEW exposure introduced by logging the sentinel at all.
        // The fall-through sentinel is `ai request failed: <200 chars of the CLI's result body>`,
        // and that body can quote the request back. This line reaches the daily rolling file that
        // support uploads, and redact_secrets works by SHAPE (keys/bearers/tokens), not prose — so
        // a prompt fragment would survive. Asserting on the EMITTED OUTPUT, the way
        // concierge_lint_log does, is the only thing that turns red if the clamp is removed.
        let secret = "Left-Pair-attachment-path-fragment-9f3a";
        let body = format!(r#"{{"is_error":true,"result":"exec failed while handling {secret}"}}"#);
        let logged = captured_logs(|| {
            let err = run_isolated(req("leak-probe", Tier::Background, false), &|_| Ok(body.clone()))
                .unwrap_err();
            // The JS layer still receives the detail — that is a bounded in-memory string, and it
            // is what makes a modal say something useful. Only the PERSISTED copy is clamped.
            assert!(err.contains(secret), "the caller still gets the detail: {err}");
        });
        assert!(!logged.is_empty(), "nothing captured — the harness is broken");
        assert!(
            !logged.contains(secret),
            "the CLI's result body reached the support-uploadable log: {logged}"
        );
        assert!(logged.contains("ai request failed"), "the shape must still be named: {logged}");
    }

    #[test]
    fn loggable_sentinel_passes_typed_values_and_collapses_everything_else() {
        // Both directions, because a version that returned the input unchanged would satisfy the
        // first half alone — and that is exactly the leak.
        for typed in ["claude_usage_limit", "ai_rate_limited", "ai_timeout", "ai_empty_reply"] {
            assert_eq!(loggable_sentinel(typed), typed);
        }
        assert_eq!(loggable_sentinel("ai request failed: claude exited Some(1): /Users/x/secret"), "ai request failed");
        // Fails CLOSED: an unrecognised shape collapses rather than passing through.
        assert_eq!(loggable_sentinel("some_future_sentinel_with_detail: xyz"), "ai request failed");
    }

    #[test]
    fn classify_cli_failure_never_echoes_the_whole_result_body() {
        let huge = "x".repeat(10_000);
        let msg = classify_cli_failure(&huge, None);
        assert!(msg.len() < 300, "bounded, got {} chars", msg.len());
    }

    #[test]
    fn non_object_stdout_falls_back_to_the_exit_status_instead_of_passing_as_a_reply() {
        // `null`, `[]` and a bare number all PARSE. If mere parseability were the gate, each would
        // suppress the stderr diagnosis and end up as `ai_empty_reply` — which the JS service-health
        // classifier treats as evidence the transport works, resetting the very run a broken install
        // needs to accumulate.
        for body in ["null", "[]", "42", "\"a string\"", "{}", "not json", ""] {
            assert!(!is_usable_result(body), "{body} must NOT be accepted as a result object");
        }
        assert!(is_usable_result(OK_JSON), "the real payload must still be accepted");
        assert!(is_usable_result(NOT_LOGGED_IN_JSON), "a failure payload is still classifiable");
    }

    #[test]
    fn empty_result_is_a_failure_not_a_silent_ok() {
        for raw in [r#"{"is_error":false,"result":""}"#, r#"{"is_error":false,"result":"   "}"#] {
            let v: serde_json::Value = serde_json::from_str(raw).unwrap();
            assert_eq!(classify_result_json(&v), CliOutcome::Failed("ai_empty_reply".to_string()));
        }
    }

    // THE CROSS-LANGUAGE PIN. `ANTHROPIC_ENV_OVERRIDES` is the canonical list, but the TypeScript
    // side has to unset the same names before `claude auth login` — otherwise the login writes a
    // credential that `accounts::claude_auth_status` (which scrubs) does not read, and the user
    // loops: sign in, be told to sign in again, with nothing on screen explaining why.
    //
    // WHY THIS TEST AND NOT A TS ONE. The TS suite already asserts its own list per-name, and that
    // proves NOTHING about drift: the names, the constant, and the assertion all live on the TS
    // side, so appending an eighth name HERE fails zero tests over there. A comment claiming
    // otherwise is worse than no check, because it tells the next reader the drift is impossible
    // (roborev 58033). This test is the only thing that actually crosses the boundary — it reads the
    // TS source and fails if a name in the canonical list is missing from it.
    //
    // Reading the file is deliberate. A shared generated artifact would be tidier, but it adds a
    // build step to keep two seven-item lists in sync; a grep-shaped assertion costs nothing and
    // fails loudly at exactly the moment the lists diverge.
    #[test]
    fn every_scrubbed_name_is_also_unset_before_the_typescript_login_spawn() {
        let ts = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/services/claudeSpawn.ts");
        let src = std::fs::read_to_string(&ts)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", ts.display()));
        // Scope to the unset constant, not the whole file: a name merely MENTIONED in a comment
        // elsewhere must not satisfy this.
        let start = src
            .find("const ANTHROPIC_ENV_UNSET")
            .expect("claudeSpawn.ts must define ANTHROPIC_ENV_UNSET — the login-side scrub");
        let block = &src[start..];
        let end = block.find(';').expect("ANTHROPIC_ENV_UNSET must be a terminated declaration");
        let unset = &block[..end];
        // WHOLE TOKENS, NOT SUBSTRINGS — and this is not pedantry, it is the difference between the
        // pin working and being vacuous for one of the seven names. `ANTHROPIC_API` is a PREFIX of
        // `ANTHROPIC_API_KEY`, and both are canonical. With a `contains` check, deleting
        // `ANTHROPIC_API` from the TS list leaves `ANTHROPIC_API_KEY` in the string, so the
        // substring is still found and the test stays green for exactly the drift it exists to
        // catch (roborev 58057).
        //
        // Splitting on non-identifier characters is what makes each name an exact match. The
        // separators in the TS constant are spaces and the trailing `;`, so this yields the seven
        // names plus empty strings, and an empty string never equals a canonical name.
        let unset_names: Vec<&str> = unset
            .split(|c: char| !(c.is_alphanumeric() || c == '_'))
            .collect();
        for name in ANTHROPIC_ENV_OVERRIDES {
            assert!(
                unset_names.contains(name),
                "{name} is scrubbed in Rust but NOT unset before `claude auth login` in \
                 claudeSpawn.ts. Add it to ANTHROPIC_ENV_UNSET (and its test's UNSET_PREFIX), or \
                 the login writes a credential the auth probe does not read."
            );
        }
    }

    #[test]
    fn spawn_env_removes_every_variable_that_could_override_the_subscription() {
        // A dev running `npm run tauri dev` from a shell exporting any of these would silently push
        // the call off their subscription — onto the unfunded key, a third-party gateway, or a
        // different vendor account entirely. Asserted against the whole const so a name added there
        // without being scrubbed fails here.
        let mut cmd = Command::new("/bin/echo");
        scrub_anthropic_env(&mut cmd);
        let removed: Vec<String> = cmd
            .get_envs()
            .filter(|(_, v)| v.is_none())
            .map(|(k, _)| k.to_string_lossy().to_string())
            .collect();
        for name in ANTHROPIC_ENV_OVERRIDES {
            assert!(removed.contains(&name.to_string()), "{name} not scrubbed; got {removed:?}");
        }
        // The ones that actually bit: an auth token and a base-URL redirect are just as effective at
        // taking the CLI off the subscription as the API key, and neither was covered at first.
        assert!(removed.contains(&"ANTHROPIC_AUTH_TOKEN".to_string()));
        assert!(removed.contains(&"ANTHROPIC_BASE_URL".to_string()));
    }

    #[test]
    fn background_can_never_occupy_every_slot() {
        // The anti-starvation guarantee as an arithmetic property, not a comment. Setting these
        // equal compiles and reads fine, and would let a judge storm fill the pool.
        assert!(
            MAX_BACKGROUND < MAX_CONCURRENT,
            "MAX_BACKGROUND ({MAX_BACKGROUND}) must leave a slot for an interactive call \
             (MAX_CONCURRENT {MAX_CONCURRENT})"
        );
    }

    #[test]
    fn a_burst_waits_for_a_slot_instead_of_being_refused() {
        // THE regression this exists for. Refusing instantly meant ~48 of 50 judge calls returned
        // ai_busy without ever reaching the model, and `turnFollowup.ts` cannot tell that from "the
        // judge could not run", so it painted a confident red on every turn ending in a proposal
        // phrase — the 2026-07-28 false-alarm bug rebuilt out of a counter.
        //
        // Asserted as BEHAVIOUR (a blocked caller eventually gets the freed slot), not as counter
        // arithmetic: the first cut of this test checked `waiting` was 1 right after calling
        // `enter_waiting_room(..).is_some()`, which drops the seat as a temporary and proves nothing.
        use std::sync::Arc;
        let inflight = Arc::new(AtomicUsize::new(0));
        let waiting = Arc::new(AtomicUsize::new(0));

        let held: Vec<_> = (0..MAX_BACKGROUND)
            .map(|i| try_acquire(&inflight, Tier::Background).unwrap_or_else(|| panic!("fill {i}")))
            .collect();
        assert!(try_acquire(&inflight, Tier::Background).is_none(), "pool is full");

        let (i2, w2) = (Arc::clone(&inflight), Arc::clone(&waiting));
        // A GENEROUS budget on purpose. The waiter returns the instant a slot frees, so this bound
        // only governs the failure case — and `cargo test` runs these on a machine that may be
        // saturated by the rest of the suite, where a tight budget makes the test flaky rather than
        // strict. (It was: 60s replaced 5s after one spurious CI-style failure under parallel load.)
        let waiter = std::thread::spawn(move || {
            acquire(&i2, &w2, Tier::Background, Duration::from_secs(60)).is_some()
        });

        // Wait until the caller is OBSERVABLY parked rather than sleeping a guessed interval — under
        // load a fixed sleep can elapse before the thread is even scheduled, which is what made the
        // first version of this test intermittent.
        let parked = std::time::Instant::now();
        while waiting.load(Ordering::Acquire) == 0 {
            assert!(parked.elapsed() < Duration::from_secs(30), "waiter never took a seat");
            std::thread::sleep(Duration::from_millis(5));
        }
        drop(held);

        assert!(waiter.join().unwrap(), "a queued caller must get the freed slot, not ai_busy");
        assert_eq!(waiting.load(Ordering::Acquire), 0, "the seat is released on the way out");
    }

    #[test]
    fn the_waiting_room_is_bounded_so_blocking_threads_cannot_grow_without_limit() {
        let waiting = AtomicUsize::new(0);
        let seats: Vec<_> = (0..MAX_WAITERS)
            .map(|_| enter_waiting_room(&waiting, Tier::Interactive).expect("seat"))
            .collect();
        assert!(
            enter_waiting_room(&waiting, Tier::Interactive).is_none(),
            "past MAX_WAITERS we must still refuse"
        );
        drop(seats);
        assert_eq!(waiting.load(Ordering::Acquire), 0, "every seat released on drop");
    }

    #[test]
    fn a_background_saturated_waiting_room_still_seats_an_interactive_caller() {
        // The tier split has to hold for SEATS, not just slots. Without a background waiter cap, the
        // burst this design targets (~32 judge/naming calls parked for 30s) filled the room, and an
        // interactive caller arriving to a full pool took the instant ai_busy refusal without ever
        // using its own wait budget — the exact failure MAX_WAITERS was added to remove, surviving
        // for the one tier a human is blocked on.
        let waiting = AtomicUsize::new(0);
        let _bg: Vec<_> = (0..MAX_BACKGROUND_WAITERS)
            .map(|i| {
                enter_waiting_room(&waiting, Tier::Background).unwrap_or_else(|| panic!("bg {i}"))
            })
            .collect();
        assert!(
            enter_waiting_room(&waiting, Tier::Background).is_none(),
            "background must stop at its own seat cap"
        );
        assert!(
            enter_waiting_room(&waiting, Tier::Interactive).is_some(),
            "an interactive caller must still get a seat"
        );
    }

    #[test]
    fn background_waiters_can_never_fill_the_whole_room() {
        assert!(
            MAX_BACKGROUND_WAITERS < MAX_WAITERS,
            "MAX_BACKGROUND_WAITERS ({MAX_BACKGROUND_WAITERS}) must leave seats for interactive \
             callers (MAX_WAITERS {MAX_WAITERS})"
        );
    }

    #[test]
    fn acquire_gives_up_after_the_wait_expires_rather_than_parking_forever() {
        let inflight = AtomicUsize::new(0);
        let waiting = AtomicUsize::new(0);
        let _held: Vec<_> = (0..MAX_BACKGROUND)
            .map(|_| try_acquire(&inflight, Tier::Background).expect("fill"))
            .collect();
        let started = std::time::Instant::now();
        let got = acquire(&inflight, &waiting, Tier::Background, Duration::from_millis(150));
        assert!(got.is_none(), "a full pool past the deadline must refuse");
        // Bounded, not tight: the property is "it returns", and a strict multiple of the 150ms wait
        // would be measuring the test machine's scheduler rather than this function.
        assert!(started.elapsed() < Duration::from_secs(30), "must not park indefinitely");
        assert_eq!(waiting.load(Ordering::Acquire), 0, "the seat is released on the way out");
    }

    #[test]
    fn a_multibyte_prompt_under_the_char_limit_but_over_the_byte_limit_is_refused() {
        // execve's limit is BYTES. This guard measured chars at first, so terminal output full of
        // box-drawing (3 bytes each) could pass the check and still blow up as an opaque spawn
        // failure instead of the ai_prompt_too_large the callers degrade from.
        let ch = '─'; // 3 bytes
        let n = (MAX_PROMPT_BYTES / 3) + 10; // comfortably over the BYTE budget
        let prompt: String = std::iter::repeat(ch).take(n).collect();
        assert!(prompt.chars().count() < MAX_PROMPT_BYTES, "must be under the CHAR count");
        assert!(prompt.len() > MAX_PROMPT_BYTES, "and over the BYTE budget");
        let err = run_isolated(req(&prompt, Tier::Background, false), &|_| {
            panic!("must not spawn for an oversized prompt")
        })
        .unwrap_err();
        assert_eq!(err, "ai_prompt_too_large");
    }

    #[test]
    fn try_acquire_refuses_past_the_cap_and_releases_on_drop() {
        // Cap-RELATIVE, not a hardcoded count: these constants are tuning knobs, and a test that
        // pins their current values fails as "wrong number" the moment anyone tunes them, which
        // teaches nothing. The PROPERTY is what matters.
        let counter = AtomicUsize::new(0);
        let mut held: Vec<_> = (0..MAX_CONCURRENT)
            .map(|i| try_acquire(&counter, Tier::Interactive).unwrap_or_else(|| panic!("slot {i}")))
            .collect();
        assert!(try_acquire(&counter, Tier::Interactive).is_none(), "must refuse past the cap");
        held.pop();
        assert!(try_acquire(&counter, Tier::Interactive).is_some(), "a freed slot is reusable");
    }

    #[test]
    fn background_tier_always_leaves_a_slot_for_an_interactive_call() {
        // The anti-starvation guarantee: a judge storm must never make a call the user is waiting on
        // queue behind it.
        let counter = AtomicUsize::new(0);
        let _held: Vec<_> = (0..MAX_BACKGROUND)
            .map(|i| try_acquire(&counter, Tier::Background).unwrap_or_else(|| panic!("bg {i}")))
            .collect();
        assert!(
            try_acquire(&counter, Tier::Background).is_none(),
            "background must stop at MAX_BACKGROUND"
        );
        assert!(
            try_acquire(&counter, Tier::Interactive).is_some(),
            "an interactive call must still get a slot past the background cap"
        );
    }

    #[test]
    fn try_acquire_never_overshoots_the_cap_under_contention() {
        // Pins CAS-over-fetch_add: with fetch_add-then-undo the observed in-flight count transiently
        // exceeds the cap and spuriously refuses a legitimate acquirer.
        use std::sync::Arc;
        let counter = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..16 {
            let counter = Arc::clone(&counter);
            let max_seen = Arc::clone(&max_seen);
            handles.push(std::thread::spawn(move || {
                for _ in 0..200 {
                    if let Some(_p) = try_acquire(&counter, Tier::Interactive) {
                        let now = counter.load(Ordering::Acquire);
                        max_seen.fetch_max(now, Ordering::AcqRel);
                    }
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(counter.load(Ordering::Acquire), 0, "every permit released");
        assert!(
            max_seen.load(Ordering::Acquire) <= MAX_CONCURRENT,
            "in-flight peaked at {}, cap is {MAX_CONCURRENT}",
            max_seen.load(Ordering::Acquire)
        );
    }

    #[test]
    fn cache_lookup_misses_when_the_final_message_changed() {
        // THE judge property: re-judge only when the agent's final message actually changed.
        let mut cache = HashMap::new();
        let k1 = request_key(MODEL, SYSTEM, "TASK: x\n\nFINAL MESSAGE:\nfirst");
        let k2 = request_key(MODEL, SYSTEM, "TASK: x\n\nFINAL MESSAGE:\nsecond");
        cache_store(&mut cache, k1, "DONE".into(), 1, CACHE_CAP);
        assert_eq!(cache_lookup(&mut cache, k1, 2), Some("DONE".to_string()));
        assert_eq!(cache_lookup(&mut cache, k2, 3), None, "a changed message must miss");
    }

    #[test]
    fn cache_key_covers_model_and_system_not_just_user() {
        assert_ne!(request_key(MODEL, SYSTEM, USER), request_key("claude-sonnet-4-6", SYSTEM, USER));
        assert_ne!(request_key(MODEL, SYSTEM, USER), request_key(MODEL, "other system", USER));
    }

    #[test]
    fn cache_store_evicts_the_least_recently_used_past_the_cap() {
        let mut cache = HashMap::new();
        let cap = 4;
        for i in 0..cap as u64 {
            cache_store(&mut cache, i, format!("v{i}"), i, cap);
        }
        // Touch key 0 so it is no longer the oldest.
        assert_eq!(cache_lookup(&mut cache, 0, 100), Some("v0".to_string()));
        cache_store(&mut cache, 99, "new".into(), 101, cap);
        assert!(cache.len() <= cap, "stayed within cap");
        assert!(cache.contains_key(&0), "the touched entry survived");
        assert!(cache.contains_key(&99), "the new entry landed");
        assert!(!cache.contains_key(&1), "the least-recently-touched entry was evicted");
    }

    #[test]
    fn reply_budget_chars_bounds_a_runaway_but_never_below_the_floor() {
        // judge.rs asks for 8 tokens and expects the literal word FOLLOWUP; a budget derived purely
        // from that would clamp to "FOLLO" and invert the verdict.
        assert_eq!(reply_budget_chars(8), MIN_REPLY_CHARS);
        assert!(reply_budget_chars(8) > "FOLLOWUP".len());
        assert_eq!(reply_budget_chars(8192), 8192 * CHARS_PER_TOKEN);
    }

    #[test]
    fn prompt_over_the_argv_budget_is_an_error_not_a_truncated_prompt() {
        let huge = "x".repeat(MAX_PROMPT_BYTES + 1);
        let err = run_isolated(req(&huge, Tier::Background, false), &|_| {
            panic!("must not spawn for an oversized prompt")
        })
        .unwrap_err();
        assert_eq!(err, "ai_prompt_too_large");
    }

    #[test]
    fn run_with_parses_a_real_success_payload_end_to_end() {
        let out = run_isolated(req(USER, Tier::Background, false), &|args| {
            assert_eq!(args[0], "-p");
            Ok(OK_JSON.to_string())
        })
        .expect("should succeed");
        assert_eq!(out, "DONE");
    }

    #[test]
    fn run_with_surfaces_the_auth_sentinel_from_a_failed_payload() {
        let err = run_isolated(req(USER, Tier::Background, false), &|_| {
            Ok(NOT_LOGGED_IN_JSON.to_string())
        })
        .unwrap_err();
        assert_eq!(err, "claude_not_authenticated");
    }

    #[test]
    fn run_with_serves_a_second_identical_cacheable_call_without_spawning() {
        // Unique user text so this test owns its cache key regardless of what else ran.
        let user = "cache-probe: only this test uses this exact string";
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let spawn = |_: &[String]| {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(OK_JSON.to_string())
        };
        assert_eq!(run_isolated(req(user, Tier::Background, true), &spawn).unwrap(), "DONE");
        assert_eq!(run_isolated(req(user, Tier::Background, true), &spawn).unwrap(), "DONE");
        assert_eq!(calls.load(Ordering::SeqCst), 1, "second call must be served from cache");
    }

    #[test]
    fn a_cache_hit_reports_no_spawn_while_a_real_call_does() {
        // THE DISTINCTION THAT LETS THE CACHED WRAPPERS REPORT RECOVERY AT ALL. `spawned` is the
        // whole reason judge/naming/attention can now clear a degraded banner: they may report
        // health from a REAL child, and must stay silent on a hit — a hit is served before a permit
        // is even acquired, so a wedged CLI would otherwise hide behind its own stale answers.
        // Both directions, because reporting `true` unconditionally would compile, pass any
        // single-direction test, and reinstate exactly that masking bug.
        let user = "spawned-probe: only this test uses this exact string";
        let spawn = |_: &[String]| Ok(OK_JSON.to_string());

        let first = run_isolated_reply(req(user, Tier::Background, true), &spawn).unwrap();
        assert!(first.spawned, "a cache MISS ran a real child and must say so");

        let second = run_isolated_reply(req(user, Tier::Background, true), &spawn).unwrap();
        assert_eq!(second.text, first.text, "same answer");
        assert!(!second.spawned, "a cache HIT asked the CLI nothing and must not claim health");
    }

    #[test]
    fn the_health_gate_emits_for_a_spawn_and_stays_silent_for_a_cache_hit() {
        // roborev 57507 then 57515. The FIRST version of this test asserted
        // `should_report_health(true) == true` — the identity function on bool, i.e. true by
        // definition, which is the repo's #1 vacuous shape and left the real `if` unpinned. This
        // one drives the gate through a counting sink, so deleting the `if` in `report_health`
        // fails it. That deletion is not hypothetical: it reinstates the cache-hit masking bug the
        // `spawned` flag exists to prevent, where a persistent unanswered prompt hits the cache
        // every tick and a wedged CLI reports itself healthy forever.
        struct Counting(std::cell::Cell<usize>);
        impl HealthSink for Counting {
            fn emit_health(&self) {
                self.0.set(self.0.get() + 1);
            }
        }

        let sink = Counting(std::cell::Cell::new(0));
        report_health(&sink, false);
        assert_eq!(sink.0.get(), 0, "a cache hit asked the CLI nothing and must not report health");
        report_health(&sink, true);
        assert_eq!(sink.0.get(), 1, "a real child that answered must report health exactly once");
    }

    #[test]
    fn the_event_name_is_pinned_because_it_is_a_cross_language_contract() {
        // `AI_SPAWN_OK_EVENT` is matched by a string literal in TS
        // (services/aiServiceHealthListener.ts), with no shared source between the two. A rename on
        // either side is SILENT — the listener simply stops firing and a latched banner survives
        // forever with a healthy CLI. Pinned to the literal on both sides so a rename has to break
        // a test rather than a user's afternoon. This is the cheap half of the untested-adapter gap
        // documented on `finish_cacheable`; the emit itself still needs tauri's `test` feature.
        assert_eq!(AI_SPAWN_OK_EVENT, "ai://spawn-ok");
    }

    #[test]
    fn an_uncacheable_call_always_reports_a_spawn() {
        // The chat sink is `cacheable: false`, so it can never be served from cache — which is why
        // `chatOnce` is allowed to report success from JS with no flag to consult.
        let spawn = |_: &[String]| Ok(OK_JSON.to_string());
        for _ in 0..2 {
            let reply =
                run_isolated_reply(req("uncached-probe", Tier::Background, false), &spawn).unwrap();
            assert!(reply.spawned);
        }
    }

    #[test]
    fn a_failed_call_is_never_cached() {
        let user = "failure-probe: only this test uses this exact string";
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let spawn = |_: &[String]| {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(NOT_LOGGED_IN_JSON.to_string())
        };
        assert!(run_isolated(req(user, Tier::Background, true), &spawn).is_err());
        assert!(run_isolated(req(user, Tier::Background, true), &spawn).is_err());
        // The user fixing their login must take effect on the very next call, not after a restart.
        assert_eq!(calls.load(Ordering::SeqCst), 2, "a failure must not stick to the prompt");
    }

    /// A real capture of the 2026-08-02 shape: the subscription's allowance is spent, so the CLI
    /// exits 0 with `is_error` set, a 429, and no usage numbers at all.
    const USAGE_LIMIT_JSON: &str = r#"{"is_error":true,"subtype":"success",
        "terminal_reason":"api_error","api_error_status":429,
        "result":"Claude usage limit reached. Your limit resets at 5:00pm.",
        "total_cost_usd":0,"duration_ms":427,
        "usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0}}"#;

    /// Run `body` with a subscriber capturing everything, and return what was emitted. Same
    /// `MakeWriter`-over-a-shared-buffer pattern `concierge_lint_log` uses, and for the same reason:
    /// the property under test is what actually reached the log, which nothing else can observe.
    fn captured_logs(body: impl FnOnce()) -> String {
        use std::io::Write;
        use std::sync::{Arc, Mutex};

        #[derive(Clone)]
        struct Shared(Arc<Mutex<Vec<u8>>>);
        impl Write for Shared {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap_or_else(|e| e.into_inner()).extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Shared {
            type Writer = Shared;
            fn make_writer(&'a self) -> Self::Writer {
                self.clone()
            }
        }

        let buf = Arc::new(Mutex::new(Vec::new()));
        let subscriber = tracing_subscriber::fmt()
            .with_writer(Shared(Arc::clone(&buf)))
            .with_ansi(false)
            .with_max_level(tracing::Level::INFO)
            .finish();
        tracing::subscriber::with_default(subscriber, body);
        let guard = buf.lock().unwrap_or_else(|e| e.into_inner());
        let out = String::from_utf8_lossy(&guard).to_string();
        drop(guard);
        out
    }

    #[test]
    fn a_failed_run_is_logged_as_a_failure_not_as_a_completion() {
        // THE ASSERTION THAT GUARDS THE MISLEADING LOG. `log_outcome` used to be called before
        // classification, so this exact payload emitted "claude one-shot completed" with all-zero
        // usage. That line is why 2026-08-02 was diagnosed as "cache hits, service healthy,
        // recovery under-fed" when in fact every call was being rejected. Asserting on the EMITTED
        // OUTPUT is the only thing that turns red if the call is moved back above the classifier.
        let logged = captured_logs(|| {
            let err = run_isolated(req("log-probe-failed", Tier::Background, false), &|_| {
                Ok(USAGE_LIMIT_JSON.to_string())
            })
            .unwrap_err();
            assert_eq!(err, "claude_usage_limit");
        });

        assert!(!logged.is_empty(), "nothing captured — the harness is broken, so this would pass vacuously");
        assert!(
            !logged.contains("claude one-shot completed"),
            "a run that returned an error must NOT be logged as a completion: {logged}"
        );
        assert!(logged.contains("claude one-shot FAILED"), "the failure must be logged: {logged}");
        assert!(
            logged.contains("claude_usage_limit"),
            "the typed sentinel is what reconciles the log with the banner: {logged}"
        );
    }

    #[test]
    fn a_successful_run_is_still_logged_as_a_completion() {
        // The other direction, so the fix above cannot be "log FAILED for everything".
        let logged = captured_logs(|| {
            assert_eq!(
                run_isolated(req("log-probe-ok", Tier::Background, false), &|_| Ok(
                    OK_JSON.to_string()
                ))
                .unwrap(),
                "DONE"
            );
        });
        assert!(logged.contains("claude one-shot completed"), "{logged}");
        assert!(!logged.contains("claude one-shot FAILED"), "{logged}");
    }

    #[test]
    fn a_cache_hit_says_so_instead_of_logging_nothing() {
        // A hit used to be invisible, which is what made "all-zero usage" ambiguous between a hit
        // and a failure — the single ambiguity that misdirected the 2026-08-02 diagnosis. The two
        // spend nothing and look alike from outside, so the log has to name which one happened.
        let user = "log-probe-cache: only this test uses this exact string";
        let logged = captured_logs(|| {
            let spawn = |_: &[String]| Ok(OK_JSON.to_string());
            assert_eq!(run_isolated(req(user, Tier::Background, true), &spawn).unwrap(), "DONE");
            assert_eq!(run_isolated(req(user, Tier::Background, true), &spawn).unwrap(), "DONE");
        });
        assert!(
            logged.contains("claude one-shot served from cache"),
            "the second call was served from cache and must say so: {logged}"
        );
    }

    #[test]
    #[ignore = "spawns the real claude CLI; requires an authenticated subscription (CI has none)"]
    fn live_oneshot_returns_text() {
        let out = run(OneShot {
            model: MODEL,
            system: "You are a test fixture. Reply with exactly one word.",
            user: "Reply with EXACTLY one word: DONE",
            max_tokens: 8,
            timeout: CLASSIFY_TIMEOUT,
            tier: Tier::Interactive,
            cacheable: false,
            purpose: "live-test",
            project: None,
        })
        .expect("live call should succeed");
        assert!(out.text.to_uppercase().contains("DONE"), "got {out:?}");
        assert!(out.spawned, "an uncached live call must report a real spawn");
    }
}

/// The invariant this whole migration exists to establish, enforced against the SOURCE.
///
/// A runtime test cannot express it: the failure mode is a code path nobody exercises — a fallback
/// quietly reinstated "just in case", a dev-convenience env read, a new module copying an old one.
/// That is exactly what happened before, and it stayed invisible because every affected feature
/// degraded silently. So this walks the crate's own sources and asserts that no Anthropic API-key
/// surface remains anywhere in it.
///
/// It lives in its own module (not `mod tests` above) because its subject is the CRATE, not
/// `claude_oneshot` — this file is simply where the replacement transport lives.
#[cfg(test)]
mod no_anthropic_key {
    /// Network shapes that only appear in code addressing Anthropic directly. Quoted where the bare
    /// token would collide with unrelated names (an `x-api-key` substring matched a keychain account
    /// called "builder-index-api-key").
    const FORBIDDEN_NETWORK: &[&str] = &["api.anthropic.com", "\"x-api-key\"", "\"anthropic-version\""];

    /// The env NAMES that carry or redirect Anthropic credentials.
    const KEY_NAMES: &[&str] = &[
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_API\"",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
    ];

    /// Ways a line READS an environment variable. The invariant is about reading a key in order to
    /// USE it — naming one in order to REMOVE it (`env_remove`), to list it for scrubbing, or to
    /// poison it in a test that proves the scrub works, all REINFORCE the invariant.
    ///
    /// This is the second shape of this test. The first matched any mention of a key name outside a
    /// comment, which flagged nine legitimate lines on its first run and then broke again the moment
    /// `auto_send_tuner.rs` landed on main doing its own `env_remove` scrub — eight more false
    /// positives, every one of them code that makes the guarantee STRONGER. A test that fires on the
    /// fix it is protecting is worse than no test: it trains people to weaken it.
    const READ_VERBS: &[&str] = &["env::var", "var_os", "resolve_env_secret", "std::env::var"];

    /// Lines that merely TALK about the removal. Only live code counts.
    fn is_comment(line: &str) -> bool {
        let t = line.trim_start();
        t.starts_with("//") || t.starts_with("*") || t.starts_with("/*")
    }

    /// Does this line READ an Anthropic key (as opposed to naming one to remove or assert absence)?
    fn reads_a_key(line: &str) -> bool {
        KEY_NAMES.iter().any(|k| line.contains(k)) && READ_VERBS.iter().any(|v| line.contains(v))
    }

    #[test]
    fn no_anthropic_api_key_is_reachable_from_this_crate() {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders: Vec<String> = Vec::new();
        let mut scanned = 0usize;

        let mut stack = vec![src.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("read src dir") {
                let path = entry.expect("dir entry").path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                    continue;
                }
                // This module names every forbidden string by construction.
                if path.file_name().and_then(|f| f.to_str()) == Some("claude_oneshot.rs") {
                    continue;
                }
                scanned += 1;
                let body = std::fs::read_to_string(&path).expect("read source");
                let name = path.file_name().unwrap().to_string_lossy().to_string();
                for (i, line) in body.lines().enumerate() {
                    if is_comment(line) {
                        continue;
                    }
                    if reads_a_key(line) {
                        offenders.push(format!("{name}:{}: reads a key: `{}`", i + 1, line.trim()));
                    }
                    for needle in FORBIDDEN_NETWORK {
                        if line.contains(needle) {
                            offenders.push(format!(
                                "{name}:{}: {needle} in `{}`",
                                i + 1,
                                line.trim()
                            ));
                        }
                    }
                }
            }
        }

        // Guard against the test silently passing because it scanned nothing (a moved src dir, a
        // changed manifest layout). Without this, the invariant could evaporate and stay green.
        assert!(scanned > 30, "only scanned {scanned} files — the walk is broken, not the code");
        assert!(
            offenders.is_empty(),
            "an Anthropic API-key path came back. Sparkle's AI features run on the USER'S Claude \
             Code subscription (see claude_oneshot.rs); there is no Sparkle-funded key to fall back \
             to, and a silent fallback is what cost a full day of false alarms on 2026-07-28.\n  {}",
            offenders.join("\n  ")
        );
    }

    #[test]
    fn the_scan_catches_a_read_and_spares_a_scrub() {
        // A negative test that cannot fail is worthless. This pins BOTH directions — the read it
        // must catch, and the removal/absence shapes it must not, which is where the previous two
        // versions of this test went wrong.
        assert!(reads_a_key(r#"let k = std::env::var("ANTHROPIC_API_KEY").unwrap();"#));
        assert!(reads_a_key(r#"resolve_env_secret(&["ANTHROPIC_API_KEY", "ANTHROPIC_API"])"#));

        for spared in [
            r#"cmd.env_remove("ANTHROPIC_API_KEY");"#,
            r#"const KEYS: [&str; 3] = ["ANTHROPIC_API_KEY", "ANTHROPIC_API", "ANTHROPIC_AUTH_TOKEN"];"#,
            r#"std::env::set_var("ANTHROPIC_API_KEY", "sk-poison-key");"#,
            r#"assert!(!plist.contains("ANTHROPIC_API_KEY"));"#,
        ] {
            assert!(!reads_a_key(spared), "must not flag a scrub/assert: {spared}");
        }

        assert!(!is_comment(r#"    let k = std::env::var("ANTHROPIC_API_KEY");"#));
        assert!(is_comment("// ANTHROPIC_API_KEY is deliberately not read here"));
    }
}
