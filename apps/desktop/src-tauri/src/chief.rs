// Resolve the Chief (Storytell) Personal Access Token from the environment so the Think
// agent works without the user pasting a token. Read at runtime in Rust — never baked into the
// JS bundle or the shipped binary — so a distributed build on someone else's machine simply
// finds no token and the UI falls back to the connect screen.
//
// The user named theirs `CHIEF_API` in `.env.local`; `VITE_CHIEF_PAT` is also accepted. The
// actual resolution order (env vars → walked-up `.env.local` → `$HOME/Projects/sparkle/.env.local`)
// is shared with the Anthropic key lookup via `naming::resolve_env_secret`.

/// The Chief PAT resolved from the environment, or Err when none is configured (the frontend
/// treats Err as "no env token" and shows the connect screen).
#[tauri::command]
pub fn chief_pat() -> Result<String, String> {
    crate::naming::resolve_env_secret(&["CHIEF_API", "VITE_CHIEF_PAT"])
        .ok_or_else(|| "no Chief PAT (set CHIEF_API or add it to .env.local)".to_string())
}


#[cfg(test)]
mod tests {
    use super::chief_pat;

    /// `chief_pat` accepts BOTH documented env names and prefers `CHIEF_API` over the
    /// `VITE_CHIEF_PAT` fallback. We drive it entirely through PROCESS env vars, which
    /// `resolve_env_secret` consults FIRST (before any `.env.local` on disk), so the test stays
    /// deterministic even on a dev machine that has a real `CHIEF_API` in
    /// `~/Projects/sparkle/.env.local` — that file is never reached here. (The no-token Err path is
    /// intentionally left untested: it can't be forced without deleting the developer's real
    /// dotenv.) One serial test, not several parallel ones, because it mutates two shared,
    /// non-unique env vars.
    #[test]
    fn chief_pat_resolves_both_env_names_by_priority() {
        // Snapshot + clear so we restore the developer's real environment on the way out.
        let prev_api = std::env::var("CHIEF_API").ok();
        let prev_vite = std::env::var("VITE_CHIEF_PAT").ok();
        std::env::remove_var("CHIEF_API");
        std::env::remove_var("VITE_CHIEF_PAT");

        // Primary name wins.
        std::env::set_var("CHIEF_API", "pat_primary");
        assert_eq!(chief_pat(), Ok("pat_primary".to_string()));

        // With the primary absent, the VITE_ fallback is honored.
        std::env::remove_var("CHIEF_API");
        std::env::set_var("VITE_CHIEF_PAT", "pat_fallback");
        assert_eq!(chief_pat(), Ok("pat_fallback".to_string()));

        // Primary takes priority even when both are present.
        std::env::set_var("CHIEF_API", "pat_primary");
        assert_eq!(chief_pat(), Ok("pat_primary".to_string()));

        std::env::remove_var("CHIEF_API");
        std::env::remove_var("VITE_CHIEF_PAT");

        // Restore whatever the developer's environment had.
        if let Some(v) = prev_api {
            std::env::set_var("CHIEF_API", v);
        }
        if let Some(v) = prev_vite {
            std::env::set_var("VITE_CHIEF_PAT", v);
        }
    }
}
