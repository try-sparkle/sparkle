//! Dev-vs-production identity isolation.
//!
//! DEBUG builds of the app (every `cargo build` / `tauri dev` build — what agents run to verify
//! changes) are adhoc/linker-signed yet share the bundle identifier `ai.sparkle.desktop` with the
//! installed, Developer-ID-signed production app. Without isolation a throwaway dev build reads and
//! writes the PRODUCTION app-data dir, log dir, and keychain item — corrupting live workspace state
//! and popping a macOS keychain prompt (the signed app owns the keychain ACL; the adhoc binary does
//! not match it, so macOS asks the user to authorize "ai.sparkle.desktop").
//!
//! Fix: in DEBUG builds ONLY, suffix the app-data dir, log dir, and keychain service with
//! `-dev-<checkout>`, so dev runs get their own isolated identity. The RELEASE notarized DMG
//! (`debug_assertions` off) is byte-for-byte unchanged.
//!
//! `<checkout>` is why the suffix is not just `-dev`. Debug-vs-release is ONE axis, and it does not
//! separate two dev builds from each other: several agents verify in `tauri dev` builds cut from
//! different checkouts in the same window, and with a single shared `-dev` identity the second one
//! to start reads and writes the first one's app-data dir, log dir and keychain item — including the
//! app-owned worktrees and orchestration state under app-data. Deriving the token from
//! `CARGO_MANIFEST_DIR` (baked in at COMPILE time, so it names the checkout the binary was built
//! from, not the CWD it happens to be launched with) gives each checkout its own sibling identity
//! while staying stable across every rebuild of that same checkout.
//!
//! Escape hatch: set `SPARKLE_DEV_IDENTITY` to pin the token explicitly — e.g. two checkouts that
//! *should* share dev state, or a dev build that must reuse an existing `-dev-<token>` dir.
//!
//! Intentionally left SHARED between dev and release (harmless in dev, and per-build churn buys no
//! isolation): the notification bundle id (`attention.rs`) and the `ai.sparkle.desktop.auth`
//! deep-link URL scheme (`Info.plist`). Neither touches persistent state.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

/// Base (production) identity — the keychain service and the final path component of the app-data
/// and log dirs all share this value in release builds.
const BASE_IDENTITY: &str = "ai.sparkle.desktop";

/// True in DEBUG builds (`cargo build` / `tauri dev`), false in the RELEASE notarized DMG. The
/// single axis separating a throwaway dev build from the shipped app.
#[inline]
pub fn is_dev() -> bool {
    cfg!(debug_assertions)
}

/// The checkout this binary was BUILT from. `CARGO_MANIFEST_DIR` is expanded by rustc at compile
/// time, so it is a property of the build, not of however the binary is later launched.
const BUILD_CHECKOUT: &str = env!("CARGO_MANIFEST_DIR");

/// Env var pinning the dev token explicitly, for the two cases the derived token gets wrong:
/// checkouts that should deliberately share dev state, and reusing an existing `-dev-<token>` dir.
const DEV_IDENTITY_ENV: &str = "SPARKLE_DEV_IDENTITY";

/// FNV-1a over `s`, folded to 8 lowercase hex chars. Pure and dependency-free — this is a *labelling*
/// hash, never a security one: it only has to be stable across rebuilds of one checkout and to differ
/// between checkouts, which are the two properties the tests pin.
fn short_hash(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{:08x}", (h ^ (h >> 32)) as u32)
}

/// Keep only chars that are safe in a path component and a keychain service name, lowercased, capped
/// at 24 — an operator-supplied override lands in a filesystem path, so it cannot carry `/` or `..`.
/// Returns `None` when nothing usable survives, so a junk override falls back to the derived token
/// rather than collapsing every checkout onto one empty-token identity.
fn sanitize_token(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(24)
        .collect::<String>()
        .to_ascii_lowercase();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// The per-checkout token: the sanitized `SPARKLE_DEV_IDENTITY` override when one is usable, else a
/// short hash of the checkout the binary was built from. Pure — callers pass both inputs.
fn checkout_token(build_checkout: &str, override_env: Option<&str>) -> String {
    override_env
        .and_then(sanitize_token)
        .unwrap_or_else(|| short_hash(build_checkout))
}

/// Append the `-dev-<checkout>` suffix to `base` when `is_dev`, else return it unchanged. Pure.
fn apply_dev_suffix(base: &str, is_dev: bool, token: &str) -> String {
    if is_dev {
        format!("{base}-dev-{token}")
    } else {
        base.to_string()
    }
}

/// Suffix ONLY the final component of `path` (the identity segment), leaving the parent untouched:
/// `~/Library/Application Support/ai.sparkle.desktop` -> `.../ai.sparkle.desktop-dev-<token>`. If the
/// path has no final component or it is non-UTF8, it is returned unchanged (nothing safe to rename).
fn apply_dev_suffix_path(path: &Path, is_dev: bool, token: &str) -> PathBuf {
    if !is_dev {
        return path.to_path_buf();
    }
    match path.file_name().and_then(|n| n.to_str()) {
        Some(name) => {
            let renamed = format!("{name}-dev-{token}");
            match path.parent() {
                Some(parent) => parent.join(renamed),
                None => PathBuf::from(renamed),
            }
        }
        None => path.to_path_buf(),
    }
}

/// This build's per-checkout token. The single place the impure inputs (the baked-in checkout path
/// and the env override) are read, so every identity below is suffixed identically.
fn this_build_token() -> String {
    checkout_token(BUILD_CHECKOUT, std::env::var(DEV_IDENTITY_ENV).ok().as_deref())
}

/// Apply THIS build's identity suffix to an app-data-shaped path that was derived without an
/// `AppHandle` (see `builder_index::default_app_data_dir`). Exists so those callers cannot hand-roll
/// the suffix: a second copy of the format string silently stops matching the moment this one gains
/// a component, and the caller then reads a directory the app never writes.
pub fn dev_suffixed_path(path: &Path) -> PathBuf {
    apply_dev_suffix_path(path, is_dev(), &this_build_token())
}

/// The macOS keychain service name for THIS build: `ai.sparkle.desktop` (release) or
/// `ai.sparkle.desktop-dev-<checkout>` (debug). Both `auth.rs` and `trial_remote.rs` route through
/// this so a dev build never touches the production keychain item's ACL (no confidential-info
/// prompt) — nor another checkout's dev item.
pub fn keychain_service() -> String {
    apply_dev_suffix(BASE_IDENTITY, is_dev(), &this_build_token())
}

/// Sparkle's per-user app-data dir for THIS build. Release: the Tauri default
/// (`~/Library/Application Support/ai.sparkle.desktop`). Debug: the `-dev` sibling, so dev runs get
/// their own isolated worktrees / orchestration state / history and never mutate production.
pub fn app_data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| format!("no app data dir: {e}"))?;
    Ok(apply_dev_suffix_path(&base, is_dev(), &this_build_token()))
}

/// Sparkle's per-user log dir for THIS build (`~/Library/Logs/ai.sparkle.desktop[-dev]`). Debug
/// builds log to the `-dev` sibling so they don't pollute the production log the user reads.
pub fn app_log_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let base = app.path().app_log_dir().map_err(|e| format!("no app log dir: {e}"))?;
    Ok(apply_dev_suffix_path(&base, is_dev(), &this_build_token()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOK: &str = "abcd1234";

    #[test]
    fn suffix_str_only_in_dev() {
        assert_eq!(apply_dev_suffix("ai.sparkle.desktop", false, TOK), "ai.sparkle.desktop");
        assert_eq!(
            apply_dev_suffix("ai.sparkle.desktop", true, TOK),
            "ai.sparkle.desktop-dev-abcd1234"
        );
    }

    #[test]
    fn suffix_path_touches_only_final_component() {
        let p = Path::new("/Users/x/Library/Application Support/ai.sparkle.desktop");
        assert_eq!(apply_dev_suffix_path(p, false, TOK), p.to_path_buf());
        assert_eq!(
            apply_dev_suffix_path(p, true, TOK),
            PathBuf::from("/Users/x/Library/Application Support/ai.sparkle.desktop-dev-abcd1234")
        );
    }

    #[test]
    fn suffix_path_log_dir_sibling() {
        let p = Path::new("/Users/x/Library/Logs/ai.sparkle.desktop");
        assert_eq!(
            apply_dev_suffix_path(p, true, TOK),
            PathBuf::from("/Users/x/Library/Logs/ai.sparkle.desktop-dev-abcd1234")
        );
    }

    #[test]
    fn suffix_path_noop_on_root() {
        assert_eq!(apply_dev_suffix_path(Path::new("/"), true, TOK), PathBuf::from("/"));
    }

    /// The whole point of the per-checkout token: two dev builds cut from different checkouts must
    /// not land on one identity. Asserted on the derived token, not on the inputs.
    #[test]
    fn distinct_checkouts_get_distinct_tokens() {
        let a = checkout_token("/Users/x/code/sparkle", None);
        let b = checkout_token("/Users/x/worktrees/sparkle-self/__sparkle_self__", None);
        assert_ne!(a, b, "two checkouts collapsed onto one dev identity");
        // And the token must actually reach the identity, not merely exist.
        assert_ne!(
            apply_dev_suffix(BASE_IDENTITY, true, &a),
            apply_dev_suffix(BASE_IDENTITY, true, &b)
        );
    }

    /// Stability is the other half: rebuilding the SAME checkout must not orphan its dev state.
    #[test]
    fn same_checkout_is_stable_across_rebuilds() {
        let p = "/Users/x/code/sparkle/apps/desktop/src-tauri";
        assert_eq!(checkout_token(p, None), checkout_token(p, None));
        assert_eq!(checkout_token(p, None).len(), 8);
        assert!(checkout_token(p, None).chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn override_pins_the_token_and_is_sanitized() {
        assert_eq!(checkout_token("/any", Some("shared")), "shared");
        // The token lands in a filesystem path, so separators and traversal must not survive.
        let t = checkout_token("/any", Some("../../etc/passwd"));
        assert!(!t.contains('/') && !t.contains('.'), "override leaked a path separator: {t}");
    }

    /// A junk override must NOT produce an empty token — that would collapse every checkout back
    /// onto one shared `ai.sparkle.desktop-dev-` identity, the exact bug this module removes.
    #[test]
    fn unusable_override_falls_back_to_the_derived_token() {
        let derived = checkout_token("/Users/x/code/sparkle", None);
        for junk in ["", "   ", "///", "..."] {
            assert_eq!(checkout_token("/Users/x/code/sparkle", Some(junk)), derived);
        }
    }

    /// Drives the real production entry point (no injected seam), so deleting the token from
    /// `this_build_token` — or hardcoding it — fails here rather than staying green.
    #[test]
    fn keychain_service_carries_this_checkouts_token() {
        // Tests compile with debug_assertions on, so this build's service is the dev-suffixed one.
        let svc = keychain_service();
        let prefix = format!("{BASE_IDENTITY}-dev-");
        let token = svc
            .strip_prefix(&prefix)
            .unwrap_or_else(|| panic!("expected `{prefix}<token>`, got `{svc}`"));
        assert!(!token.is_empty(), "dev identity has an empty checkout token: {svc}");
        assert_eq!(token, this_build_token(), "identity token is not this build's");
    }

    /// The dirs must share the keychain's token — three identities drifting apart would isolate
    /// nothing and would be invisible to any test that checked only one of them.
    #[test]
    fn all_three_identities_share_one_token() {
        let tok = this_build_token();
        let data = Path::new("/Users/x/Library/Application Support/ai.sparkle.desktop");
        let logs = Path::new("/Users/x/Library/Logs/ai.sparkle.desktop");
        assert!(apply_dev_suffix_path(data, true, &tok).ends_with(format!("ai.sparkle.desktop-dev-{tok}")));
        assert!(apply_dev_suffix_path(logs, true, &tok).ends_with(format!("ai.sparkle.desktop-dev-{tok}")));
        assert!(keychain_service().ends_with(&tok));
    }
}
