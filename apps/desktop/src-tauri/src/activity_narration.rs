// activity_narration (bead ) — turn an agent's OWN last turn into one plain-language
// sentence saying what is being built, so the "what I'm doing" line stops being a thing the agent
// has to REMEMBER to write.
//
// THE BUG THIS EXISTS FOR. `AgentTab.activity` is written only by the agent itself, through the
// sparkle-control `set_agent_activity` MCP op, at phase boundaries it chooses. That makes the line
// unreliable in a specific and measured way: it is not usually WRONG, it is ABANDONED. An agent
// narrates "Wiring the control listener", then works for three more hours without calling the op
// again, and the sidebar still says it is wiring the control listener. `engine/activityFreshness`
// (bead sparkle-s8y5t6) already fixed the READING half of that — every line carries its age and is
// rendered as a past quote once stale — but a correctly-labelled three-hour-old line is still not
// an answer to "what is this agent doing". The remaining half is to stop depending on the agent
// remembering, and that is what this module is.
//
// WHY THE LAST ASSISTANT TURN IS THE RIGHT INPUT. Three candidates existed. The TERMINAL SCREEN is
// what `attention_summary` reads, and it is exactly the TUI screen-scraping bead  was
// closed to eliminate. The HOOK EVENT LOG is structured and cheap, but `sparkle-hook.mjs`'s
// `normalize()` records only the tool NAME — a narration built from it can say no more than "Edit,
// Edit, Bash, Read", which is not what is being BUILT. The last assistant turn is already read at
// every Stop, by `transcript::read_transcript_last_assistant`, for history capture — so this costs
// no new capture, opens no new privacy surface, and is the one source that contains the agent's own
// account of what it just did.
//
// EVIDENCE, NOT SELF-REPORT — and the distinction is narrow, so it is worth being exact about.
// This is still the agent's own words; what changes is that the agent no longer chooses WHEN to
// speak. A Stop fires at every turn boundary whether or not the agent thought to narrate, so the
// line cannot be left behind by an agent that simply stopped updating it. It can still be wrong
// about what it did — nothing here makes an agent honest — but it can no longer be STALE while the
// agent keeps working, which is the failure that made the field unusable.
//
// Like naming.rs / judge.rs / attention_summary.rs this asks the cheapest Claude model (Haiku 4.5)
// and lives in Rust rather than the webview, and it runs on the USER'S OWN Claude Code subscription
// via `claude_oneshot`. Degrades gracefully: no CLI, not signed in, busy, timeout, parse or empty
// all return Err, and the caller simply leaves the existing line alone — so the feature is a no-op
// rather than a blank or a lie.

use crate::claude_oneshot::{run, OneShot, OneShotReply, Tier, CLASSIFY_TIMEOUT};
use crate::oneshot_text::{clean_one_line, tail};

/// Cheapest current Claude model — one short sentence needs nothing more. (claude-api skill:
/// claude-haiku-4-5 is $1/$5 per MTok; the bare alias is complete, no date suffix.) Pinning it is
/// load-bearing now that this runs on the user's own subscription: this fires on EVERY turn of
/// EVERY agent, so inheriting a user configured on Opus would burn ~30x their quota rendering a
/// sidebar line — far worse here than for a once-per-ask notification body.
const NARRATION_MODEL: &str = "claude-haiku-4-5";

/// A single short phrase out (≤ ~12 words), so a tiny budget is plenty.
const NARRATION_MAX_TOKENS: u32 = 40;

/// Bound the input so a long turn cannot amplify the user's subscription spend. The agent's account
/// of what it just did sits at the END of its turn, so we keep the TAIL.
const TURN_TAIL_CHARS: usize = 2000;

/// Hard cap on the returned line (chars). The activity slot is one muted line on a card, and this
/// also defends against a model that ignores the word limit.
const NARRATION_CAP_CHARS: usize = 100;

const SYSTEM_PROMPT: &str = "You write ONE short line for a non-technical person, saying what a \
coding agent is BUILDING or WORKING ON right now. You are given the tail of the agent's most \
recent turn.\n\
Write at most 12 words. Name the SUBSTANCE of the work — the feature, screen, or problem — not the \
mechanics of how it is being done. Prefer a present participle ('Wiring the login screen', \
'Tracking down a crash on export'). Plain words a non-programmer understands: say 'the login \
screen', not 'the OAuth callback handler'; say 'making saving faster', not 'optimizing the write \
path'.\n\
If the turn says the agent is WAITING on the person, blocked, or asking a question, say THAT \
instead ('Waiting on your answer about pricing') — a person reading a list of agents needs to see \
who is stuck.\n\
Output ONLY that one line — no quotes, no preamble, no label, no markdown, no trailing period.\n\
Examples:\n\
Wiring the login screen\n\
Tracking down a crash when exporting a PDF\n\
Waiting on your answer about which payment provider\n\
Writing tests for the new invoice list";

/// Narrate what an agent is building, from the tail of its last assistant turn. Returns the cleaned
/// one-line narration. Returns Err on any failure (no CLI, empty input/result, timeout, parse) so
/// the caller leaves the current activity line untouched.
#[tauri::command]
pub async fn narrate_activity(
    // INJECTED BY TAURI — the JS call signature is unchanged. It carries the health signal for a
    // real spawn back to `aiServiceHealthStore`; see `claude_oneshot::AI_SPAWN_OK_EVENT`.
    app: tauri::AppHandle,
    turn: String,
    // Display name of the project whose agent this is. Diagnostic only.
    project: Option<String>,
    // The account config dir this call should run under, or None to inherit the ambient default
    // account. See `claude_oneshot::OneShot::config_dir`.
    config_dir: Option<String>,
) -> Result<String, String> {
    let turn = tail(&turn, TURN_TAIL_CHARS);
    // Nothing to narrate. The caller pre-filters, but a direct/empty call must not spend a turn of
    // the user's quota to summarize nothing.
    if turn.is_empty() {
        return Err("empty turn".into());
    }

    // Spawning the CLI and waiting out its wall clock is blocking work — keep it off the async
    // runtime's worker threads, exactly as `summarize_attention` does.
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        call_narrate(&turn, project.as_deref(), config_dir.as_deref())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?;
    crate::claude_oneshot::finish_cacheable(&app, outcome)
}

/// Build the request. Split out so the encoded decisions are testable — each compiles fine when
/// wrong and produces no visible error. See the tests.
fn narration_request<'a>(turn: &'a str, project: Option<&'a str>) -> OneShot<'a> {
    OneShot {
        model: NARRATION_MODEL,
        system: SYSTEM_PROMPT,
        user: turn,
        max_tokens: NARRATION_MAX_TOKENS,
        timeout: CLASSIFY_TIMEOUT,
        // Background: the row already renders whatever line it has (or none), so nothing the user
        // is looking at is blocked on this landing.
        tier: Tier::Background,
        // The narration is a pure function of the turn tail. A duplicate Stop for the same turn —
        // which the Stop path already sees — must not re-spend a turn of the user's quota.
        cacheable: true,
        purpose: "activity-narration",
        project,
        // Set per-call by `call_narrate` from the JS failover selector; the builder defaults to the
        // ambient account.
        config_dir: None,
    }
}

/// Returns the cleaned line AND whether a real `claude` child produced it.
///
/// The pair is `(Result, bool)` rather than `Result<(..), ..>` ON PURPOSE: the spawn evidence must
/// survive an EMPTY-narration rejection, exactly as in `attention_summary` (roborev 57507). A child
/// that RAN and answered proves the transport works even when what it said was useless to us, and
/// throwing that away leaves a latched "degraded" banner up over a demonstrably healthy CLI.
fn call_narrate(
    turn: &str,
    project: Option<&str>,
    config_dir: Option<&str>,
) -> (Result<String, String>, bool) {
    let mut req = narration_request(turn, project);
    req.config_dir = config_dir;
    match run(req) {
        // The run itself failed — no health to report; the JS wrapper records the failure instead.
        Err(e) => (Err(e), false),
        Ok(reply) => interpret_narration_reply(reply),
    }
}

/// Split out from `call_narrate` so the "spawn evidence outlives an unusable reply" rule is
/// testable without a `claude` CLI.
fn interpret_narration_reply(reply: OneShotReply) -> (Result<String, String>, bool) {
    let spawned = reply.spawned;
    let cleaned = clean_one_line(&reply.text, NARRATION_CAP_CHARS);
    if cleaned.is_empty() {
        return (Err("narrate returned empty text".into()), spawned);
    }
    (Ok(cleaned), spawned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn narration_runs_in_the_background_tier_and_caches_on_the_cheap_model() {
        // Each of these compiles fine when wrong and produces no visible error, which is why they
        // are pinned rather than trusted. The MODEL especially: this fires on every turn of every
        // agent, so an inherited Opus would be a ~30x quota multiplier on a sidebar line.
        let req = narration_request("Added the login form and wired it to the API.", None);
        assert_eq!(req.model, "claude-haiku-4-5");
        assert_eq!(req.tier, crate::claude_oneshot::Tier::Background);
        assert!(req.cacheable, "a duplicate Stop for one turn must not re-spend quota");
        assert_eq!(req.purpose, "activity-narration");
    }

    #[test]
    fn narration_bounds_its_input_so_a_long_turn_cannot_amplify_spend() {
        // The guard is the TAIL: an agent's account of what it did is at the end of the turn, and
        // an unbounded input is billed per token on the user's own subscription.
        let giant = format!("{}Finished the invoice list.", "noise ".repeat(2000));
        let t = tail(&giant, TURN_TAIL_CHARS);
        assert!(t.ends_with("Finished the invoice list."));
        assert!(t.chars().count() <= TURN_TAIL_CHARS);
    }

    #[test]
    fn a_real_spawn_still_reports_health_when_the_reply_is_unusable() {
        // roborev 57507, same shape as attention_summary: the empty-reply arm must not discard the
        // evidence that a child actually ran, or a healthy CLI keeps a latched degraded banner up.
        let (result, spawned) =
            interpret_narration_reply(OneShotReply { text: "   \n  ".into(), spawned: true });
        assert!(result.is_err(), "an empty narration is still rejected as a reply");
        assert!(spawned, "but the spawn evidence must survive the rejection");

        // A cache hit must still report nothing, or the guard is gone.
        let (_, cached) = interpret_narration_reply(OneShotReply {
            text: "Wiring the login screen".into(),
            spawned: false,
        });
        assert!(!cached);
    }

    #[test]
    fn a_usable_reply_is_cleaned_to_one_capped_line() {
        let (result, _) = interpret_narration_reply(OneShotReply {
            text: "  Wiring the\n  login screen  ".into(),
            spawned: true,
        });
        assert_eq!(result.unwrap(), "Wiring the login screen");

        let (long, _) = interpret_narration_reply(OneShotReply {
            text: "word ".repeat(60),
            spawned: true,
        });
        assert!(long.unwrap().chars().count() <= NARRATION_CAP_CHARS);
    }

    #[test]
    fn the_prompt_asks_for_plain_language_and_surfaces_a_blocked_agent() {
        // The prompt is the whole feature — a narration that reads like a commit message fails the
        // bead's own premise (the audience is explicitly non-technical), and an agent that is stuck
        // is the single most important thing a list of agents can show. Both are load-bearing
        // instructions that no other test can observe, so they are pinned here.
        assert!(SYSTEM_PROMPT.contains("non-technical"));
        assert!(SYSTEM_PROMPT.contains("Waiting on your answer"));
        assert!(SYSTEM_PROMPT.contains("12 words"));
    }
}
