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

// ── User-entered PAT: OS keychain secure store (bead ) ──────────────────────────────
// A PAT the user pastes is a long-lived secret and belongs in the OS keychain, NOT in the webview's
// localStorage (where it sat in plaintext for the MVP). The three `chief_pat_secure_*` commands
// below back that value with the same `keyring` item pattern auth.rs / trial_remote.rs /
// builder_index.rs use, so it lives in the macOS Keychain / Windows Credential Manager and never
// persists in the JS bundle's storage. The frontend migrates any legacy localStorage PAT into here
// once, then reads keychain-first (services/chief.ts `resolveAndMigrateChiefPat`).

const KEYCHAIN_USER: &str = "chief-pat";

/// The keychain item for the user-entered Chief PAT. Dev-suffixed service name in debug builds
/// (see dev_identity) so a `tauri dev` build never touches the production app's keychain ACL,
/// mirroring auth.rs / trial_remote.rs / builder_index.rs. The `keyring::Entry` API is identical
/// across the macOS (`apple-native`) and Windows (`windows-native`) backends, so this needs no
/// `cfg` gating (see the note in Cargo.toml).
fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(&crate::dev_identity::keychain_service(), KEYCHAIN_USER)
        .map_err(|e| e.to_string())
}

/// Trim a PAT and reject anything that can't ride in an `X-API-Key` header (Chief sends the PAT as
/// that header, see services/chief.ts). A stray newline or non-ASCII byte from a bad paste would
/// otherwise malform every request; catch it at the boundary. Empty maps to `None`. Pure, so the
/// contract is unit-tested without touching the keychain (mirrors builder_index's validate).
fn normalize_pat(raw: &str) -> Option<String> {
    let pat = raw.trim();
    if pat.is_empty() || !pat.chars().all(|c| c.is_ascii_graphic()) {
        return None;
    }
    Some(pat.to_string())
}

// ── The blocking keychain work ────────────────────────────────────────────────────────────────
// A `#[tauri::command]` declared as a plain `fn` runs its body INLINE on the AppKit main thread
// (see `cmd_timing`'s module note), and a keychain call is a synchronous XPC round trip to
// securityd that can additionally block on an ACL prompt or a locked keychain. These three had no
// cache of any kind, so EVERY call paid it on the main thread. Keep the keychain halves as plain
// sync fns and let the commands below be thin `spawn_blocking` wrappers, mirroring
// `publish_credential.rs` (bead sparkle-dkxuf6).

/// A joined task that never produced an answer. Distinct from "no PAT stored": a caller that
/// treated the two alike would report a disconnection that did not happen.
const JOIN_FAILED: &str = "the keychain task didn't finish";

/// The keychain half of the read path. Validated on READ as well as write — see the command's doc.
fn keychain_pat() -> Option<String> {
    // Guarded: in a DEBUG build this must never raise the macOS confidential-information
    // dialog for the dev-suffixed item this binary no longer owns the ACL of (sparkle-vvwbl).
    let e = entry().ok()?;
    let stored = crate::dev_identity::no_prompt(|| e.get_password().ok())?;
    normalize_pat(&stored)
}

/// The keychain half of the write path. Validation happens here rather than in the command so a
/// bad paste is rejected by the same function the tests drive.
fn store_pat(pat: &str) -> Result<(), String> {
    let Some(pat) = normalize_pat(pat) else {
        return Err("that PAT is empty or contains spaces/line breaks; check the paste".to_string());
    };
    let e = entry()?;
    // Guarded: in a DEBUG build this must never raise the macOS confidential-information
    // dialog for the dev-suffixed item this binary no longer owns the ACL of (sparkle-vvwbl).
    crate::dev_identity::no_prompt(|| e.set_password(&pat)).map_err(|e| e.to_string())
}

/// The keychain half of the disconnect path. `NoEntry` is the state the caller wanted.
fn erase_pat() -> Result<(), String> {
    let entry = entry()?;
    // Guarded: in a DEBUG build this must never raise the macOS confidential-information
    // dialog for the dev-suffixed item this binary no longer owns the ACL of (sparkle-vvwbl).
    match crate::dev_identity::no_prompt(|| entry.delete_credential()) {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Read the user-entered Chief PAT from the OS keychain. `None` when none is stored (fresh install
/// or signed-out) or when the stored value fails validation, so the frontend treats an empty result
/// as "nothing in the secure store" and falls back to the env / build PAT. Validated on READ as
/// well as write so a value written by an older build with an interior newline can't malform the
/// header forever (mirrors builder_index).
#[tauri::command]
pub async fn chief_pat_secure_get() -> Option<String> {
    tauri::async_runtime::spawn_blocking(keychain_pat).await.unwrap_or(None)
}

/// Store the user-entered Chief PAT in the OS keychain. Rejects an empty / header-invalid value
/// before it reaches the keychain so a bad paste fails loudly rather than turning into a confusing
/// transport error on every later request.
#[tauri::command]
pub async fn chief_pat_secure_set(pat: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || store_pat(&pat))
        .await
        .unwrap_or_else(|_| Err(JOIN_FAILED.to_string()))
}

/// Delete the user-entered Chief PAT from the OS keychain (disconnect). A missing item is the state
/// the caller wanted, so `NoEntry` is success.
///
/// A join failure is an ERROR, never `Ok`: the delete lives in the task that did not finish, so
/// reporting success would show "disconnected" over a PAT that is still stored.
#[tauri::command]
pub async fn chief_pat_secure_clear() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(erase_pat)
        .await
        .unwrap_or_else(|_| Err(JOIN_FAILED.to_string()))
}

#[cfg(test)]
mod secure_store_tests {
    use super::normalize_pat;

    #[test]
    fn trims_and_keeps_a_valid_pat() {
        assert_eq!(normalize_pat("  pat_abc123  "), Some("pat_abc123".to_string()));
        assert_eq!(normalize_pat("pat_abc123"), Some("pat_abc123".to_string()));
    }

    #[test]
    fn rejects_empty_or_blank() {
        assert_eq!(normalize_pat(""), None);
        assert_eq!(normalize_pat("    "), None);
    }

    #[test]
    fn rejects_interior_whitespace_and_newlines() {
        // A PAT is used verbatim as an X-API-Key header; a space or newline from a bad paste is
        // rejected outright rather than malforming the request.
        assert_eq!(normalize_pat("pat_a b"), None);
        assert_eq!(normalize_pat("pat_a\nb"), None);
    }
}
