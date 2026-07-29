//! Haiku as an OUT-OF-BAND TUNER for the auto-send rail (PRD §4e) — never in the loop.
//!
//! # Heuristics decide every send. This decides nothing.
//!
//! `voice/confidence.ts` picks the tier for EVERY auto-send, on the frontend, in microseconds. This
//! module runs AFTERWARDS, fire-and-forget, and records what Haiku WOULD have said next to what the
//! heuristic said and what the user actually did. Its output tunes the heuristic between releases;
//! it never gates a send.
//!
//! That is settled, not a preference. Measured on this machine, a headless `claude -p` Haiku call
//! takes **15–27 seconds of wall clock**, of which ~6–7s is irreducible Node/CLI boot before the
//! request is even issued — against a countdown of 1–10 seconds. There is no in-loop option over
//! this transport at any budget, and `--resume` does not help: it reuses CONTEXT, not the process,
//! so every call pays boot again.
//!
//! # Why this transport rather than the metered proxy
//!
//! `judge.rs` / `naming.rs` / `route_classify.rs` all go through `ai::call_anthropic_proxy`, which
//! bills the user's Sparkle credits. This is a TUNING instrument that may run after every utterance,
//! so billing it to credits would make a diagnostic cost the user money. Shelling out to the user's
//! own `claude` binary bills their Claude subscription instead — the same ToS-compliant path
//! `pty.rs` and `claude_chat.rs` use.
//!
//! KNOWN AND ACCEPTED: a subscription call writes no `Metering` ledger row, so this spend does not
//! appear in Credits. That is the trade. Do NOT migrate the three metered classifiers onto this
//! transport on the strength of it — they are user-visible features with latency budgets this
//! transport cannot meet.
//!
//! # The two things that are easy to get wrong here
//!
//! **ENV.** `Command` inherits the parent environment. Sparkle never injects `ANTHROPIC_API_KEY`,
//! but a developer running `npm run tauri dev` from a shell that exports one would silently bill a
//! dead API key instead of the user's subscription — and the whole point of this path is the
//! subscription. So the env is CLEARED down to `HOME`/`PATH`/`USER` (copied from
//! `setup.rs::roborev_auth_selftest_blocking`, which does it for the mirror-image reason), and all
//! three key variables are additionally `env_remove`d so the intent is stated rather than implied.
//! `HOME` is MANDATORY: it is how `claude` finds the OAuth login in `~/.claude`.
//!
//! **`--bare` IS THE WRONG MODE.** It sets `CLAUDE_CODE_SIMPLE=1`, which forces auth strictly from
//! `ANTHROPIC_API_KEY`/apiKeyHelper and never OAuth. Never pass it here.
//!
//! Everything about this path fails SILENTLY. No `claude` binary, a timeout, malformed JSON, a
//! non-zero exit — all return `None`. A tuning instrument that could surface an error would be a
//! tuning instrument that can interrupt a send.

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use crate::preflight::cached_claude_path;

/// Haiku 4.5 — the cheapest current model, and a four-way classification needs nothing more.
/// (claude-api skill: the bare alias is complete, no date suffix.)
const TUNER_MODEL: &str = "claude-haiku-4-5";

/// Wall-clock ceiling for one classify.
///
/// The CLI has NO timeout flag, so this is imposed here by killing the child (the same shape as
/// `claude_chat.rs`'s supersede logic). 45s against a measured 15–27s: generous enough that an
/// ordinary slow call still yields data, tight enough that a wedged child cannot accumulate.
const TUNER_TIMEOUT: Duration = Duration::from_secs(45);

/// Longest transcript we will classify. A tuning sample does not need a paragraph, and an unbounded
/// one is an unbounded argv.
const MAX_TRANSCRIPT_CHARS: usize = 600;

/// What the classifier is asked to decide. Deliberately the SAME four names
/// `voice/confidence.ts` uses, so the two verdicts are directly comparable without a mapping table
/// that could drift.
const SYSTEM_PROMPT: &str = "You judge whether a spoken utterance sounds FINISHED — whether the \
speaker has completed their thought and is waiting, or is still mid-sentence. You are given one \
transcript of dictated speech. Reply with EXACTLY ONE word, one of: HIGH, NORMAL, LOW, VERYLOW.\n\
HIGH — a clean, complete sentence: terminal punctuation, or a fully formed question. The speaker is \
plainly done.\n\
NORMAL — a short complete instruction with no punctuation either way (\"ship it\", \"run the \
tests\"). Nothing says finished, nothing says unfinished.\n\
LOW — probably finished but the tail hesitates: trailing filler (\"um\", \"uh\", \"like\"), or a \
long utterance with no terminal punctuation anywhere.\n\
VERYLOW — demonstrably mid-clause: a trailing conjunction, preposition, determiner or auxiliary \
(\"and\", \"to\", \"the\", \"is\"), or a question that opened and never closed.\n\
Output only that one word — no punctuation, no explanation.";

/// An empty MCP config, passed so the classify cannot reach any tool server.
///
/// `--mcp-config "{}"` is REJECTED by the CLI — it must carry the `mcpServers` key. Verified
/// against the installed binary; a bare `{}` fails the call outright and this path would then be
/// silently dead rather than silently cheap.
const EMPTY_MCP_CONFIG: &str = r#"{"mcpServers":{}}"#;

/// The classifier's verdict, in the SAME vocabulary as `voice/confidence.ts`.
#[derive(Debug, PartialEq, Eq, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TunerTier {
    High,
    Normal,
    Low,
    VeryLow,
}

/// Parse the model's one word into a tier.
///
/// Tolerant of case, surrounding whitespace and trailing punctuation, because a one-word prompt is
/// still a language model and "VERYLOW." is the same answer as "verylow". ANYTHING else is `None` —
/// a tuning record that guessed at an unparseable answer would be worse than no record, since the
/// whole point is comparing what Haiku actually said against the heuristic.
pub(crate) fn parse_tier(raw: &str) -> Option<TunerTier> {
    let word: String = raw
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_uppercase();
    match word.as_str() {
        "HIGH" => Some(TunerTier::High),
        "NORMAL" => Some(TunerTier::Normal),
        "LOW" => Some(TunerTier::Low),
        "VERYLOW" => Some(TunerTier::VeryLow),
        _ => None,
    }
}

/// Pull the answer out of `claude -p --output-format json`.
///
/// The envelope is the CLI's own, NOT an Anthropic Messages response: `.result` is a PLAIN STRING,
/// not a `content[]` block array, so `ai::extract_text` does not apply here and must not be reached
/// for. Both guards are load-bearing — `is_error: true` and `subtype != "success"` each mark an
/// envelope whose `.result` is an error message, and taking that as a verdict would silently record
/// "the CLI is broken" as a confidence tier.
pub(crate) fn extract_result(json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    if v.get("is_error").and_then(serde_json::Value::as_bool).unwrap_or(false) {
        return None;
    }
    if v.get("subtype").and_then(|s| s.as_str()) != Some("success") {
        return None;
    }
    v.get("result").and_then(|r| r.as_str()).map(str::to_string)
}

/// Build the classify command. Split out from the run so the ENV POSTURE — the part that decides
/// which account gets billed — is unit-testable without spawning anything.
///
/// Args go DIRECTLY to `Command`, never through `zsh -c` + shell quoting. The streaming sites shell
/// out to get a login shell's PATH for `exec`; a one-shot with an absolute binary path needs none of
/// that, and skipping it removes the entire quoting surface — which matters when one of the
/// arguments is arbitrary transcribed speech.
pub(crate) fn build_classify_command(
    claude_path: &str,
    transcript: &str,
    home: &PathBuf,
    cwd: &PathBuf,
) -> Command {
    let mut cmd = Command::new(claude_path);
    cmd.args([
        // `-p`/`--print` is a BOOLEAN flag; the prompt is a POSITIONAL argument. So the transcript
        // reaches the CLI's option parser as an ordinary argv word, and a `--` terminator is what
        // stops it being read as one: any utterance whose first token begins with `-` would
        // otherwise parse as a flag — unknown, so the call errors and this path goes silently dead,
        // or recognised, so it silently changes the invocation.
        //
        // Passing args directly rather than through a shell removes the QUOTING surface; it does
        // nothing about the OPTION-PARSING surface. The header used to claim the former covered
        // both. It does not, and this is the other half.
        "-p",
        "--model",
        TUNER_MODEL,
        "--output-format",
        "json",
        "--system-prompt",
        SYSTEM_PROMPT,
        // No tools at all: this is a text classification and nothing it could reach would help.
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        EMPTY_MCP_CONFIG,
        // No settings files, no session on disk, no slash commands — a classify must leave nothing
        // behind and inherit nothing that could change its answer between two identical calls.
        "--setting-sources",
        "",
        "--no-session-persistence",
        "--disable-slash-commands",
        // EVERYTHING AFTER THIS IS POSITIONAL. Must stay last, immediately before the transcript.
        "--",
        transcript,
    ]);

    apply_classify_env(&mut cmd, home);

    // A NEUTRAL directory, never the agent worktree: running in a project root would load that
    // project's CLAUDE.md, AGENTS.md and settings into a classification about a spoken sentence.
    cmd.current_dir(cwd);
    cmd
}

/// THE ENV POSTURE — the part that decides which account gets billed.
///
/// Its own function so the test can apply it to a command that PRINTS its environment and assert on
/// what the child actually receives. `Command::get_envs()` cannot see this: it reports explicit
/// sets only and has no getter for the `env_clear` flag, so an assertion built on it would pass
/// against a version that had dropped the clear entirely — testing the code's spelling rather than
/// its effect.
///
/// Copied from `setup.rs::roborev_auth_selftest_blocking`, which does the same thing for the
/// mirror-image reason. See the module header: `Command` INHERITS the parent env, so a dev shell
/// exporting `ANTHROPIC_API_KEY` would bill a dead key instead of the user's subscription — the one
/// thing this path exists to use.
pub(crate) fn apply_classify_env(cmd: &mut Command, home: &PathBuf) {
    cmd.env_clear();
    cmd.env("HOME", home); // MANDATORY — how `claude` finds the OAuth login in ~/.claude
    if let Some(path) = std::env::var_os("PATH") {
        cmd.env("PATH", path);
    }
    if let Some(user) = std::env::var_os("USER") {
        cmd.env("USER", user);
    }
    // Redundant after env_clear() and deliberately kept: it states the intent at the point someone
    // would edit it, so a future "let's inherit a couple more vars" cannot quietly re-admit a key.
    cmd.env_remove("ANTHROPIC_API_KEY");
    cmd.env_remove("ANTHROPIC_API");
    cmd.env_remove("ANTHROPIC_AUTH_TOKEN");
}

/// Classify one utterance. Blocking; callers run it OFF the send path (see the module header).
///
/// Returns `None` for every failure — no binary, no HOME, a timeout, a non-success envelope, an
/// unparseable word. Nothing here is worth surfacing: the send already happened.
#[cfg(all(unix, target_os = "macos"))]
pub(crate) fn classify_blocking(app: &tauri::AppHandle, transcript: &str) -> Option<TunerTier> {
    let text = transcript.trim();
    if text.is_empty() {
        return None;
    }
    let clipped: String = text.chars().take(MAX_TRANSCRIPT_CHARS).collect();

    // Absent binary → skip SILENTLY. Not a warning: `claude` not being installed is an ordinary
    // state of a Sparkle install, and this path must never look like a problem.
    let claude_path = cached_claude_path()?;
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    // App data, not the worktree — see build_classify_command.
    let cwd = crate::worktree::app_data_dir_pub(app).ok()?;

    let cmd = build_classify_command(&claude_path, &clipped, &home, &cwd);
    // The CLI has no timeout flag, so the watchdog + kill lives here. `output_with_timeout` kills
    // the child's whole process group on expiry, which matters for a Node CLI that spawns helpers.
    let out = crate::worktree::output_with_timeout(cmd, TUNER_TIMEOUT).ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    parse_tier(&extract_result(&stdout)?)
}

#[cfg(not(all(unix, target_os = "macos")))]
pub(crate) fn classify_blocking(_app: &tauri::AppHandle, _transcript: &str) -> Option<TunerTier> {
    None
}

/// Fire-and-forget: what an auto-send would have been graded by Haiku.
///
/// The frontend calls this AFTER the send has already gone. It returns the tier (or null) whenever
/// the classify completes; the caller pairs it with the heuristic's tier and what the user did next
/// and writes the comparison to the LOCAL log only (`logger.ts`), never to PostHog — the transcript
/// is in it (see PRD §4f).
#[tauri::command]
pub async fn auto_send_tuner_classify(
    app: tauri::AppHandle,
    transcript: String,
) -> Result<Option<TunerTier>, String> {
    tauri::async_runtime::spawn_blocking(move || classify_blocking(&app, &transcript))
        .await
        // Even a panicked task is not worth an error to the caller: this is a diagnostic and the
        // send is long gone.
        .or(Ok(None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_tier_the_heuristic_uses() {
        // The SAME four names as voice/confidence.ts, so the two verdicts compare without a mapping
        // table that could drift out of step with either side.
        assert_eq!(parse_tier("HIGH"), Some(TunerTier::High));
        assert_eq!(parse_tier("NORMAL"), Some(TunerTier::Normal));
        assert_eq!(parse_tier("LOW"), Some(TunerTier::Low));
        assert_eq!(parse_tier("VERYLOW"), Some(TunerTier::VeryLow));
    }

    #[test]
    fn tolerates_the_shapes_a_one_word_prompt_actually_returns() {
        assert_eq!(parse_tier("  verylow\n"), Some(TunerTier::VeryLow));
        assert_eq!(parse_tier("High."), Some(TunerTier::High));
        assert_eq!(parse_tier("very low"), Some(TunerTier::VeryLow));
    }

    #[test]
    fn refuses_to_guess_at_an_unparseable_answer() {
        // A record that guessed would be worse than no record: the entire value of this path is
        // comparing what Haiku ACTUALLY said against the heuristic.
        assert_eq!(parse_tier(""), None);
        assert_eq!(parse_tier("I think the speaker is done"), None);
        assert_eq!(parse_tier("MEDIUM"), None);
        assert_eq!(parse_tier("42"), None);
    }

    #[test]
    fn extracts_the_cli_envelopes_plain_result_string() {
        // `.result` is a PLAIN STRING — the CLI's own envelope, not an Anthropic Messages response
        // with content[] blocks — so ai::extract_text does not apply here.
        let json = r#"{"type":"result","subtype":"success","is_error":false,
            "result":"VERYLOW","session_id":"abc","duration_ms":18234}"#;
        assert_eq!(extract_result(json).as_deref(), Some("VERYLOW"));
    }

    #[test]
    fn refuses_an_error_envelope_whose_result_is_an_error_message() {
        // Both guards are load-bearing: taking `.result` off a failed envelope would silently
        // record "the CLI is broken" as a confidence tier.
        assert_eq!(
            extract_result(r#"{"subtype":"success","is_error":true,"result":"boom"}"#),
            None
        );
        assert_eq!(
            extract_result(r#"{"subtype":"error_during_execution","is_error":false,"result":"x"}"#),
            None
        );
        assert_eq!(extract_result("not json"), None);
        assert_eq!(extract_result("{}"), None);
    }

    /// THE ENV TEST. This is the one that keeps the spend on the user's subscription.
    ///
    /// `Command` inherits the parent env, so a dev shell exporting `ANTHROPIC_API_KEY` (or the
    /// desktop's own `ANTHROPIC_API` — see the BYOK note in the repo's memories) would make
    /// `claude` authenticate from a likely-dead API key instead of the OAuth login: silently, and
    /// in the exact opposite of the intended mode. `HOME` is what makes OAuth findable at all.
    ///
    /// Asserted by SPAWNING, against `/usr/bin/env`, with the poison variables set in this very
    /// process. `Command::get_envs()` cannot answer this — it reports explicit sets only and
    /// exposes no `env_clear` flag, so an assertion built on it would pass against a version that
    /// had dropped the clear and gone back to inheriting.
    /// Restores the three key vars to whatever they were, ON ANY EXIT — including a panicking
    /// assertion, which is the case the old inline cleanup missed.
    ///
    /// Following `chief.rs`, which snapshots and restores rather than blindly removing. The old
    /// version unconditionally REMOVED all three afterwards, and `ANTHROPIC_API` is this repo's
    /// real BYOK variable (it may genuinely be exported in a dev shell) — so a later test in the
    /// same binary that resolves it, e.g. `model_catalog.rs` → `naming::resolve_env_secret`, saw a
    /// different environment depending on test order. And on a failed assertion the cleanup never
    /// ran at all, leaving `ANTHROPIC_API=sk-poison-api` set for the rest of the binary.
    struct EnvRestore(Vec<(&'static str, Option<std::ffi::OsString>)>);

    impl EnvRestore {
        fn capture(keys: &[&'static str]) -> Self {
            Self(keys.iter().map(|k| (*k, std::env::var_os(k))).collect())
        }
    }

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            for (k, v) in &self.0 {
                // SAFETY: same process-global caveat as the set below; this only puts back what
                // was there.
                unsafe {
                    match v {
                        Some(val) => std::env::set_var(k, val),
                        None => std::env::remove_var(k),
                    }
                }
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_classify_child_strips_every_key_var_and_keeps_home() {
        const KEYS: [&str; 3] = ["ANTHROPIC_API_KEY", "ANTHROPIC_API", "ANTHROPIC_AUTH_TOKEN"];
        let _restore = EnvRestore::capture(&KEYS);

        // SAFETY: these are process-global, but this test spawns a child and reads only its env —
        // it never asserts on the parent's, so a concurrent test observing them is unaffected.
        // `_restore` puts the originals back even if an assertion below panics.
        unsafe {
            std::env::set_var("ANTHROPIC_API_KEY", "sk-poison-key");
            std::env::set_var("ANTHROPIC_API", "sk-poison-api");
            std::env::set_var("ANTHROPIC_AUTH_TOKEN", "poison-token");
        }

        let mut cmd = Command::new("/usr/bin/env");
        apply_classify_env(&mut cmd, &PathBuf::from("/Users/test-home"));
        let out = cmd.output().expect("/usr/bin/env should run");
        let env_dump = String::from_utf8_lossy(&out.stdout);

        for key in ["ANTHROPIC_API_KEY", "ANTHROPIC_API", "ANTHROPIC_AUTH_TOKEN"] {
            assert!(
                !env_dump.lines().any(|l| l.starts_with(&format!("{key}="))),
                "{key} reached the classify child — it would bill the wrong account.\n{env_dump}"
            );
        }
        // No poison VALUE survives under any name either (belt and braces against a rename).
        assert!(!env_dump.contains("poison"), "a key value leaked through:\n{env_dump}");
        // HOME is MANDATORY — it is how `claude` finds ~/.claude and therefore the subscription.
        assert!(
            env_dump.lines().any(|l| l == "HOME=/Users/test-home"),
            "HOME must be set, or `claude` cannot find the OAuth login:\n{env_dump}"
        );

        // …AND NOTHING ELSE. This is what pins `env_clear` specifically: the three `env_remove`
        // calls above would keep the previous assertions green on their own, so without this a
        // dropped `env_clear` would go unnoticed and the child would inherit the parent's whole
        // environment — every future key-shaped variable included.
        let names: Vec<&str> = env_dump
            .lines()
            .filter_map(|l| l.split_once('=').map(|(k, _)| k))
            .collect();
        for name in &names {
            assert!(
                matches!(*name, "HOME" | "PATH" | "USER"),
                "the classify child inherited `{name}`; only HOME/PATH/USER may reach it:\n{env_dump}"
            );
        }

        // No manual cleanup — `_restore` handles it, including on a panicking assertion above.
    }

    #[test]
    fn the_classify_runs_in_a_neutral_dir_and_never_shells_out() {
        let cmd = build_classify_command(
            "/usr/local/bin/claude",
            "ship it",
            &PathBuf::from("/Users/test"),
            &PathBuf::from("/tmp/appdata"),
        );
        // Directly on `claude`, NOT `/bin/zsh -c '…'`. A one-shot with an absolute path needs no
        // login shell, and skipping it removes the whole quoting surface — which matters when one
        // argument is arbitrary transcribed speech.
        assert_eq!(cmd.get_program(), std::ffi::OsStr::new("/usr/local/bin/claude"));
        // NOT the agent worktree: a project root would load its CLAUDE.md/AGENTS.md/settings into
        // a classification about a spoken sentence.
        assert_eq!(cmd.get_current_dir(), Some(std::path::Path::new("/tmp/appdata")));
    }

    #[test]
    fn the_flags_pin_the_auth_mode_and_the_mcp_shape() {
        let cmd = build_classify_command(
            "/usr/local/bin/claude",
            "fix the header and",
            &PathBuf::from("/Users/test"),
            &PathBuf::from("/tmp/appdata"),
        );
        let args: Vec<String> =
            cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();

        // NEVER --bare: it sets CLAUDE_CODE_SIMPLE=1 and forces auth strictly from
        // ANTHROPIC_API_KEY/apiKeyHelper, never OAuth — exactly the wrong mode for this path.
        assert!(!args.iter().any(|a| a == "--bare"), "--bare would defeat the subscription auth");
        // `--mcp-config "{}"` is REJECTED by the CLI; it must carry the mcpServers key, or the
        // call fails outright and this path is silently dead rather than silently cheap.
        assert!(args.iter().any(|a| a == EMPTY_MCP_CONFIG));
        assert!(!args.iter().any(|a| a == "{}"));
        // Cheapest model, and the transcript reaches the child as ONE argv entry — never
        // interpolated into a shell string.
        assert!(args.iter().any(|a| a == TUNER_MODEL));
        assert!(args.iter().any(|a| a == "fix the header and"));
        assert!(args.iter().any(|a| a == "--no-session-persistence"));
        assert!(args.iter().any(|a| a == "--strict-mcp-config"));
        // THE TERMINATOR, immediately before the transcript. `-p` is a boolean flag and the prompt
        // is positional, so without this an utterance starting with "-" parses as an option.
        let dashdash = args.iter().position(|a| a == "--").expect("`--` must be passed");
        assert_eq!(
            args.get(dashdash + 1).map(String::as_str),
            Some("fix the header and"),
            "the transcript must be the argv word straight after `--`"
        );
    }

    #[test]
    fn the_prompt_asks_for_exactly_the_heuristics_four_names() {
        for tier in ["HIGH", "NORMAL", "LOW", "VERYLOW"] {
            assert!(SYSTEM_PROMPT.contains(tier), "{tier} must be offered to the classifier");
        }
    }
}
