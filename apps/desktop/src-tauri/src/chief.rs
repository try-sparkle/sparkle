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
