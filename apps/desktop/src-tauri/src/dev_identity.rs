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
use std::sync::Mutex;

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

// ── A DEBUG build must never put an OS password modal on the user's screen ─────────────────────
//
// The `-dev-<checkout>` service above keeps a dev build off the PRODUCTION item's ACL. It does not
// keep the DEV item from growing an ACL of its own. macOS binds a keychain item's ACL to the binary
// that created it, and every `cargo build` emits a NEW adhoc-signed binary — so the second run of
// any checkout is already a stranger to the item the first run wrote, and the data read pops
// "ai.sparkle.desktop-dev-… wants to use your confidential information" (sparkle-vvwbl). Nobody can
// answer that on an unattended machine, and "Always Allow" cannot stick: the next rebuild is a
// different binary again, so the prompt returns every single time.
//
// So in a DEBUG build a keychain call is not allowed to ASK. User interaction is suppressed for the
// duration of the call, which makes macOS answer with a status instead of raising the dialog — and
// that status, like every other read failure, folds to ABSENT. A dev build that cannot decrypt its
// own stale item reads as SIGNED OUT, which is the fail-closed direction: the user gets the sign-in
// affordance rather than a modal.
//
// RELEASE is untouched. The notarized app IS on its item's ACL, and suppressing interaction there
// would silence a dialog the shipped app is entitled to raise.

/// Whether a keychain call from THIS build may raise the macOS authorization dialog. Release: yes.
/// Debug: no. Exposed so the decision is readable (and assertable) rather than an inline `cfg!`.
pub fn keychain_may_prompt() -> bool {
    !is_dev()
}

/// RAII: while this value is alive, macOS keychain functions that would display a user interface
/// are not allowed to. Dropping it restores the process default.
///
/// An INERT guard suppresses nothing — that covers the non-macOS case (there is no dialog to
/// suppress), a suppression call that itself failed, and the test double.
pub(crate) struct NoPromptGuard {
    #[cfg(target_os = "macos")]
    _lock: Option<security_framework::os::macos::keychain::KeychainUserInteractionLock>,
    /// Test-only liveness flag, cleared when this guard drops. It is what lets a test prove the
    /// guard is still ALIVE while the keychain call runs — the failure mode being a `let _ =
    /// suppress()` that drops the guard before the call and re-enables the dialog, leaving every
    /// other assertion here green while the app prompts exactly as it did before.
    #[cfg(test)]
    alive: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
}

impl NoPromptGuard {
    /// A guard that suppresses nothing.
    pub(crate) fn inert() -> Self {
        Self {
            #[cfg(target_os = "macos")]
            _lock: None,
            #[cfg(test)]
            alive: None,
        }
    }

    /// A test double that reports its own lifetime through `flag`: `true` while alive.
    #[cfg(test)]
    fn watched(flag: std::sync::Arc<std::sync::atomic::AtomicBool>) -> Self {
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
        Self {
            #[cfg(target_os = "macos")]
            _lock: None,
            alive: Some(flag),
        }
    }
}

#[cfg(test)]
impl Drop for NoPromptGuard {
    fn drop(&mut self) {
        if let Some(flag) = &self.alive {
            flag.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }
}

/// Engage keychain user-interaction suppression for as long as the returned guard lives.
#[cfg(target_os = "macos")]
fn suppress_keychain_prompts() -> NoPromptGuard {
    use security_framework::os::macos::keychain::SecKeychain;
    // A failure to suppress is NOT fatal — it degrades to the old behaviour for this one call
    // rather than skipping the keychain entirely, which would log the dev build out spuriously.
    NoPromptGuard {
        _lock: SecKeychain::disable_user_interaction().ok(),
        #[cfg(test)]
        alive: None,
    }
}

/// Nothing to suppress off macOS: the confidential-information dialog is a macOS phenomenon.
#[cfg(not(target_os = "macos"))]
fn suppress_keychain_prompts() -> NoPromptGuard {
    NoPromptGuard::inert()
}

/// Serializes Sparkle's OWN guarded keychain calls. Interaction suppression is a PROCESS-WIDE flag
/// and the guard restores it on drop, so two overlapping guards would have the inner drop re-enable
/// the dialog while the outer call is still in flight — precisely the window this exists to close.
/// Held only around a single keychain call.
static KEYCHAIN_PROMPT_LOCK: Mutex<()> = Mutex::new(());

/// Run `call` with the dialog suppressed when `is_dev`. The impure half (`suppress`) is injected so
/// a test can assert WHICH path was taken without a keychain.
fn guarded_keychain_call<T>(
    is_dev: bool,
    suppress: impl FnOnce() -> NoPromptGuard,
    call: impl FnOnce() -> T,
) -> T {
    let _serialize = KEYCHAIN_PROMPT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // Bound to a named local: `let _ = suppress()` would drop the guard IMMEDIATELY and re-enable
    // the dialog before `call` ever runs, which is the silent way to make all of this inert.
    let _no_prompt = if is_dev { Some(suppress()) } else { None };
    call()
}

/// Run one keychain call from THIS build without ever raising an OS dialog in a debug build.
///
/// Wrap the keychain call ITSELF — not the `keyring::Entry::new` that precedes it, which performs
/// no keychain IO — so the suppressed window stays as narrow as the process-wide flag allows.
pub(crate) fn no_prompt<T>(call: impl FnOnce() -> T) -> T {
    guarded_keychain_call(is_dev(), suppress_keychain_prompts, call)
}

/// Fold a keychain READ outcome into "the secret, or SIGNED OUT". Pure.
///
/// Every failure becomes `None`, and that is the fix rather than laziness. `NoEntry` is the
/// ordinary signed-out case; an authorization failure is the debug-build ACL mismatch, and the only
/// way to "handle" it other than treating it as absent is to ask the user — which is the defect.
/// A dev build that cannot decrypt its own stale item genuinely HAS no usable credential, so
/// signed-out is not merely the safe answer, it is the true one.
fn read_outcome_to_secret(read: Result<String, keyring::Error>) -> Option<String> {
    match read {
        Ok(t) if !t.is_empty() => Some(t),
        _ => None,
    }
}

/// [`read_keychain_secret`] with both impure seams injected.
fn read_keychain_secret_with(
    is_dev: bool,
    suppress: impl FnOnce() -> NoPromptGuard,
    read: impl FnOnce() -> Result<String, keyring::Error>,
) -> Option<String> {
    read_outcome_to_secret(guarded_keychain_call(is_dev, suppress, read))
}

/// Read one secret out of THIS build's keychain item (`keychain_service()` + `user`).
/// `None` means SIGNED OUT — see [`read_outcome_to_secret`] for why an ACL denial lands there too.
pub(crate) fn read_keychain_secret(user: &str) -> Option<String> {
    let service = keychain_service();
    read_keychain_secret_with(is_dev(), suppress_keychain_prompts, || {
        keyring::Entry::new(&service, user)?.get_password()
    })
}

/// [`write_keychain_secret`] with its two keychain ops injected.
///
/// The retry is DEBUG-ONLY and is the write-side twin of folding a denied read to absent: the item
/// may have been written by an EARLIER adhoc-signed binary whose ACL this one does not match, so the
/// write is refused (it cannot prompt). A dev credential is disposable, so the recovery is to drop
/// the stale item and write a fresh one THIS binary owns. Release never takes this path — a failure
/// there is reported verbatim, exactly as before.
fn write_keychain_secret_with(
    is_dev: bool,
    mut write: impl FnMut() -> Result<(), keyring::Error>,
    delete: impl FnOnce() -> Result<(), keyring::Error>,
) -> Result<(), String> {
    let Err(first) = write() else {
        return Ok(());
    };
    if !is_dev {
        return Err(first.to_string());
    }
    match delete() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => {
            return Err(format!(
                "{first} (and the stale dev keychain item could not be removed: {e})"
            ))
        }
    }
    write().map_err(|e| e.to_string())
}

/// Store a secret in THIS build's keychain item, never raising a dialog in a debug build.
pub(crate) fn write_keychain_secret(user: &str, secret: &str) -> Result<(), String> {
    let service = keychain_service();
    write_keychain_secret_with(
        is_dev(),
        || no_prompt(|| keyring::Entry::new(&service, user)?.set_password(secret)),
        || no_prompt(|| keyring::Entry::new(&service, user)?.delete_credential()),
    )
}

/// Delete THIS build's keychain item, never raising a dialog in a debug build. `Ok(())` when
/// nothing was stored — "already gone" is the outcome the caller wanted.
pub(crate) fn delete_keychain_secret(user: &str) -> Result<(), String> {
    let service = keychain_service();
    match no_prompt(|| keyring::Entry::new(&service, user)?.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
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

    // ── No OS dialog from a DEBUG build (sparkle-vvwbl) ───────────────────────────────────────
    //
    // The defect these pin is not a wrong VALUE, it is a MODAL: a rebuilt adhoc-signed dev binary
    // is no longer on its own dev keychain item's ACL, so the data read asks the user for their
    // login password. Every test below therefore asserts the side effect — the guard that stops
    // macOS asking was actually engaged AND still held while the call ran — alongside the answer.

    use std::cell::Cell;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    /// What macOS reports for the ACL mismatch once the dialog is suppressed: the item is there,
    /// this binary is not on its ACL, and there is no interaction available to change that.
    /// `keyring` funnels every unrecognised `OSStatus` into `PlatformFailure`, so that is the
    /// shape the read path actually sees.
    fn acl_denial() -> keyring::Error {
        keyring::Error::PlatformFailure(Box::new(std::io::Error::other(
            "SecKeychain error: User interaction is not allowed. (-25308)",
        )))
    }

    /// Records what the guarded read did: whether suppression was engaged at all, and whether the
    /// guard was still alive at the moment the keychain call ran.
    struct PromptWatch {
        engaged: Cell<bool>,
        alive_during_call: Arc<AtomicBool>,
    }

    impl PromptWatch {
        fn new() -> Self {
            Self { engaged: Cell::new(false), alive_during_call: Arc::new(AtomicBool::new(false)) }
        }
        fn suppress(&self) -> NoPromptGuard {
            self.engaged.set(true);
            NoPromptGuard::watched(Arc::clone(&self.alive_during_call))
        }
        /// True only if the dialog was suppressed AND still suppressed when the call happened.
        fn never_prompted(&self, observed_alive: bool) -> bool {
            self.engaged.get() && observed_alive
        }
    }

    /// THE bug. An ACL-mismatched dev item must read as SIGNED OUT, with macOS never asked.
    #[test]
    fn a_debug_build_reads_an_acl_denial_as_signed_out_without_asking_the_user() {
        let w = PromptWatch::new();
        let observed = Cell::new(false);
        let got = read_keychain_secret_with(
            true,
            || w.suppress(),
            || {
                observed.set(w.alive_during_call.load(Ordering::SeqCst));
                Err(acl_denial())
            },
        );
        assert_eq!(got, None, "an ACL-denied dev item must read as signed out");
        assert!(
            w.never_prompted(observed.get()),
            "the debug build let macOS raise its confidential-information dialog \
             (engaged={}, still suppressed during the read={})",
            w.engaged.get(),
            observed.get()
        );
    }

    /// The fold is the point: "nothing stored" and "you may not have it" are ONE answer, so no
    /// caller can grow a branch that tries to recover the denial by asking the user.
    #[test]
    fn a_denial_and_an_absent_item_give_the_identical_signed_out_answer() {
        let denied = read_outcome_to_secret(Err(acl_denial()));
        let absent = read_outcome_to_secret(Err(keyring::Error::NoEntry));
        assert_eq!(denied, absent);
        assert_eq!(denied, None);
        // An empty stored value is signed out too — the shape auth.rs relied on before this moved.
        assert_eq!(read_outcome_to_secret(Ok(String::new())), None);
    }

    /// Suppression must not cost the happy path: a dev build whose item this binary DOES own still
    /// gets its token. Without this, "never prompts" would be satisfiable by never reading.
    #[test]
    fn suppression_still_returns_a_readable_secret() {
        let w = PromptWatch::new();
        let observed = Cell::new(false);
        let got = read_keychain_secret_with(
            true,
            || w.suppress(),
            || {
                observed.set(w.alive_during_call.load(Ordering::SeqCst));
                Ok("desk-token".to_string())
            },
        );
        assert_eq!(got, Some("desk-token".to_string()));
        assert!(w.never_prompted(observed.get()), "the happy path lost its suppression guard");
    }

    /// RELEASE is untouched: the notarized app is on its own item's ACL, and suppressing there
    /// would silence a dialog the shipped app is entitled to raise.
    #[test]
    fn a_release_build_does_not_suppress_at_all() {
        let w = PromptWatch::new();
        let got = read_keychain_secret_with(false, || w.suppress(), || Ok("prod-token".to_string()));
        assert_eq!(got, Some("prod-token".to_string()));
        assert!(!w.engaged.get(), "a release build must not disable keychain user interaction");
    }

    /// The guard must outlive the call. Pinned separately from the read so the ordering property
    /// is named: dropping it early re-enables the dialog and re-opens the bug in full.
    #[test]
    fn the_guard_is_still_held_when_the_keychain_call_runs() {
        let w = PromptWatch::new();
        let alive = guarded_keychain_call(true, || w.suppress(), || w.alive_during_call.load(Ordering::SeqCst));
        assert!(alive, "suppression was released before the keychain call ran");
        // …and released afterwards, so the rest of the app is not left permanently mute.
        assert!(!w.alive_during_call.load(Ordering::SeqCst), "suppression outlived the call");
    }

    /// Write side of the same ACL mismatch: a dev sign-in must not hang on a modal either. The
    /// stale item is a throwaway dev credential, so the recovery is to replace it.
    #[test]
    fn a_denied_dev_write_replaces_the_stale_item_instead_of_prompting() {
        let writes = Cell::new(0);
        let deletes = Cell::new(0);
        let r = write_keychain_secret_with(
            true,
            || {
                writes.set(writes.get() + 1);
                if writes.get() == 1 {
                    Err(acl_denial())
                } else {
                    Ok(())
                }
            },
            || {
                deletes.set(deletes.get() + 1);
                Ok(())
            },
        );
        assert!(r.is_ok(), "a dev write should self-heal past a stale item's ACL: {r:?}");
        assert_eq!(deletes.get(), 1, "the stale dev item was never dropped");
        assert_eq!(writes.get(), 2, "the secret was never re-written after the item was replaced");
    }

    /// A release write failure is reported verbatim and never silently deletes the user's item —
    /// the recovery above is disposable-dev-credential reasoning and does not transfer.
    #[test]
    fn a_release_write_failure_is_reported_and_deletes_nothing() {
        let deletes = Cell::new(0);
        let r = write_keychain_secret_with(
            false,
            || Err(acl_denial()),
            || {
                deletes.set(deletes.get() + 1);
                Ok(())
            },
        );
        assert!(r.is_err(), "a release write failure must surface");
        assert_eq!(deletes.get(), 0, "a release build deleted the production keychain item");
    }

    /// If the stale item cannot be dropped either, fail — do not loop, and do not fall through to
    /// a path that could ask the user.
    #[test]
    fn a_dev_write_whose_cleanup_fails_gives_up() {
        let writes = Cell::new(0);
        let r = write_keychain_secret_with(
            true,
            || {
                writes.set(writes.get() + 1);
                Err(acl_denial())
            },
            || Err(acl_denial()),
        );
        assert!(r.is_err());
        assert_eq!(writes.get(), 1, "the write was retried after cleanup failed");
    }

    /// Debug builds are exactly the builds that must not prompt — the same single axis the rest of
    /// this module keys on, asserted on the decision rather than on `cfg!` at the call site.
    #[test]
    fn only_a_release_build_may_prompt() {
        assert_eq!(keychain_may_prompt(), !is_dev());
        // Tests compile with debug_assertions on, so this build is a dev build.
        assert!(!keychain_may_prompt(), "a debug build claimed it may raise a keychain dialog");
    }
}
