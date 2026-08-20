// Generic Claude chat command for the Sparkle Chief interview/synthesis flows.
//
// `anthropic_chat` now runs on the USER'S OWN Claude Code subscription via `claude_oneshot` (their
// authenticated `claude` CLI). It previously POSTed to the orchestration `/ai/anthropic` route,
// where the SERVER held a vendor key and metered credits at 10x — that key ran out of funds on
// 2026-07-28 and took auto-naming, the judge, Chief synthesis and suggestions down together. The
// decision was to retire the vendor key rather than refund it, so there is no Sparkle-funded key
// left to exhaust and no credit to meter on this path.
//
// The proxy client that used to live here — `call_anthropic_proxy`, `build_proxy_body`, `Metering`,
// `extract_text`, `classify_proxy_error`, `vendor_status`, `classify_transport_kind` and their
// loopback test harness — is GONE, along with the last caller (`route_classify`). This module is
// now a thin command over `claude_oneshot`; there is no HTTP in it at all, which is why the ureq
// note that used to sit here went with it.
//
// MODEL NOTE: the chat sink uses Sonnet 4.6; the tiny classify calls (naming/judge/attention) stay
// on Haiku 4.5 in their own modules. Pinning the model matters more now than it did under the
// proxy: these run on the user's own quota, so inheriting a user configured on Opus would multiply
// their cost several-fold for no gain.

/// Sonnet 4.6 — the generic-chat model (brainstorm / AI-composer / ThinkPanel task-planning).
/// Bare alias, no date suffix. Pinned rather than inherited: this runs on the user's own
/// subscription, so a user configured on Opus would multiply their own cost for no gain.
///
/// PUBLIC, and that is the point rather than an accident of visibility (bead `sparkle-revqiv`).
/// The second-model advisor pass resolves its own model as "a model DIFFERENT from the planner's",
/// and that rule is unimplementable while the planner's model is a private constant: the advisor
/// would have to hardcode `"claude-sonnet-4-6"` a second time, which is exactly the drift this
/// const exists to prevent — change the planner here and a hardcoded copy elsewhere would silently
/// start permitting the advisor to run on the SAME model, i.e. self-review wearing a second name.
/// `planner_chat_model` below is the one read path; nothing may re-declare the value.
pub const CHAT_MODEL: &str = "claude-sonnet-4-6";

/// The planner's effective model id, for a caller that must pick a DIFFERENT one.
///
/// A command rather than a duplicated string on the TypeScript side — see [`CHAT_MODEL`]. It reads
/// a compile-time constant and touches nothing, so it is cheap enough to call per pass and cannot
/// fail; `Result` is not used because there is no failure to report and a fallible signature would
/// invite a caller to invent a default, which is the one thing that must not happen here (a wrong
/// guess re-enables self-review).
///
/// ASYNC, like every command in this crate, and NOT added to `cmd_timing`'s `EXEMPT` list even
/// though its body is a single `to_string()`. The guard's rule (bead `sparkle-rfhu5`) is about the
/// SHAPE, not about this body's cost: a sync `#[tauri::command]` runs inline on the AppKit main
/// thread, and exempting one because it is cheap today invites the next edit to add work to it with
/// nothing to catch that. There is no blocking work here to hand to `spawn_blocking`, so `async`
/// alone is the whole fix.
#[tauri::command]
pub async fn planner_chat_model() -> String {
    CHAT_MODEL.to_string()
}

/// Default token budget when the caller passes 0, so a forgotten/zero `max_tokens` still yields a
/// usable reply rather than the API rejecting a zero budget.
const DEFAULT_MAX_TOKENS: u32 = 1024;

/// Upper bound on `max_tokens`. An unclamped budget from a compromised renderer would be a
/// costly-output amplifier — now against the user's own subscription quota rather than a Sparkle
/// meter. 8192 covers the interview/synthesis replies this drives with headroom.
const MAX_MAX_TOKENS: u32 = 8192;

/// Resolve the effective token budget: 0 (forgotten/unset) → default; otherwise the request,
/// clamped to `MAX_MAX_TOKENS`.
fn clamp_max_tokens(requested: u32) -> u32 {
    match requested {
        0 => DEFAULT_MAX_TOKENS,
        n => n.min(MAX_MAX_TOKENS),
    }
}

/// One-shot Claude chat: send `system` + `user`, return the model's reply text. Runs on the USER'S
/// OWN Claude Code subscription via `claude_oneshot` (their authenticated `claude` CLI). Returns Err
/// on any failure (no CLI, not signed into Claude Code, timeout, busy, empty result) so the caller
/// can degrade.
///
/// Note what is NO LONGER here: the Sparkle bearer read, the "not signed in" precondition, and the
/// `insufficient_credits` path. There is no Sparkle-side balance to exhaust on this route, so that
/// typed error can no longer be produced.
#[tauri::command]
pub async fn anthropic_chat(
    system: String,
    user: String,
    max_tokens: u32,
    // Short human description of WHY this call was made (e.g. "Suggesting next actions"). It used to
    // be forwarded to the server for the credit ledger; with no server call it is diagnostic only,
    // and lands on claude_oneshot's tracing line. Back-compat: a missing key → None.
    purpose: Option<String>,
    // Display name of the PROJECT this call belongs to. Diagnostic only now, same reason.
    project: Option<String>,
    // Whether this call is AUTOMATIC (fired by the app on a timer/state change) rather than one a
    // human is sitting behind. It selects the concurrency tier, and getting it wrong starves the
    // other kind — see the tier comment below. Back-compat: a missing key → None → interactive.
    background: Option<bool>,
) -> Result<String, String> {
    let user = user.trim().to_string();
    if user.is_empty() {
        return Err("empty user message".into());
    }
    // 0 → default; otherwise clamp. This no longer bounds metered spend (there is none) — it bounds
    // the reply-truncation budget in claude_oneshot, and still stops a compromised renderer asking
    // for an unbounded reply.
    let max_tokens = clamp_max_tokens(max_tokens);

    // Spawning the CLI and waiting out its wall clock is blocking work — keep it off the async
    // runtime's worker threads, exactly as the proxy call it replaced did.
    // No `finish_cacheable`/`report_health` here, and no AppHandle: this sink is `cacheable: false`,
    // so every reply is a real spawn by construction and `chatOnce` already reports the success from
    // JS on return. (Naming the surviving symbols on purpose — this is the one comment explaining
    // why this caller opts out of the health mechanism, so it has to stay greppable from it.)
    tauri::async_runtime::spawn_blocking(move || {
        crate::claude_oneshot::run(chat_request(
            &system,
            &user,
            max_tokens,
            purpose.as_deref(),
            project.as_deref(),
            background.unwrap_or(false),
        ))
        .map(|reply| reply.text)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Build the chat request. Split out from the command so the decisions encoded here are TESTABLE —
/// each compiles fine when wrong and produces no visible error at runtime.
fn chat_request<'a>(
    system: &'a str,
    user: &'a str,
    max_tokens: u32,
    purpose: Option<&'a str>,
    project: Option<&'a str>,
    background: bool,
) -> crate::claude_oneshot::OneShot<'a> {
    crate::claude_oneshot::OneShot {
        model: CHAT_MODEL,
        system,
        user,
        max_tokens,
        timeout: crate::claude_oneshot::CHAT_TIMEOUT,
        // Chosen by the CALLER, not fixed here. An earlier cut hardcoded `Interactive` on the
        // reasoning that "every caller of this sink is a user-initiated flow behind a spinner".
        // That is false of its HIGHEST-VOLUME caller: suggestions/engine.ts fires automatically on
        // every settled state, per agent. Pinning those to Interactive put automatic traffic into
        // the pool reserved for blocked humans, so a handful of concurrent suggestion computes could
        // leave a user pressing Send in Define Done with no slot — exactly the starvation the tier
        // split exists to prevent, rebuilt inside the Interactive tier.
        tier: if background {
            crate::claude_oneshot::Tier::Background
        } else {
            crate::claude_oneshot::Tier::Interactive
        },
        // NOT cached, deliberately. This is the generic chat sink for brainstorm/composer flows
        // where a user's "regenerate" must actually regenerate; serving a cached reply would make
        // that button a silent no-op.
        cacheable: false,
        // The caller's own description ("Suggesting next actions", "Defining the delivered stage",
        // Chief synthesis…). That breakdown is exactly what diagnosing call-volume needs, and an
        // earlier cut threw it away by forcing a `&'static str` literal here.
        purpose: purpose.unwrap_or("chat"),
        project,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_chat_sink_never_caches_and_follows_the_callers_tier() {
        // cacheable:true compiles and leaves the suite green while turning every "regenerate" button
        // into a silent no-op — the documented reason the flag is false.
        let req = chat_request("sys", "usr", 1024, None, None, false);
        assert!(!req.cacheable, "the chat sink must never serve a cached reply");
        assert_eq!(req.tier, crate::claude_oneshot::Tier::Interactive);
        assert_eq!(req.model, "claude-sonnet-4-6");

        // An AUTO-fired caller (suggestions) must land in the background tier, or it competes with
        // blocked humans for the small interactive pool.
        let bg = chat_request("sys", "usr", 512, Some("Suggesting next actions"), None, true);
        assert_eq!(bg.tier, crate::claude_oneshot::Tier::Background);
    }

    #[test]
    fn the_callers_purpose_survives_to_the_log_line() {
        // An earlier cut forced a &'static str here and collapsed every caller to the literal
        // "chat", throwing away the per-caller breakdown that diagnosing call volume depends on.
        let req = chat_request("sys", "usr", 512, Some("Suggesting next actions"), None, true);
        assert_eq!(req.purpose, "Suggesting next actions");
        let bare = chat_request("sys", "usr", 512, None, None, false);
        assert_eq!(bare.purpose, "chat", "a caller that names no purpose still labels the route");
    }

    #[test]
    fn clamp_max_tokens_defaults_zero_and_caps_large() {
        assert_eq!(clamp_max_tokens(0), DEFAULT_MAX_TOKENS); // forgotten/unset → default
        assert_eq!(clamp_max_tokens(512), 512); // in-range request passes through
        assert_eq!(clamp_max_tokens(MAX_MAX_TOKENS), MAX_MAX_TOKENS);
        assert_eq!(clamp_max_tokens(u32::MAX), MAX_MAX_TOKENS); // hostile budget is capped
    }

    #[test]
    fn chat_model_is_sonnet_restored_from_haiku_downgrade() {
        // Guards the sparkle-8k3v restoration: the generic chat sink runs on Sonnet 4.6 again (the
        // server now meters Sonnet), not the temporary Haiku downgrade. Bare alias, no date suffix.
        assert_eq!(CHAT_MODEL, "claude-sonnet-4-6");
    }
}
