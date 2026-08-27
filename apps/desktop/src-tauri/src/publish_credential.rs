//! The publish destination's bearer token, in the OS keychain (bead `sparkle-131ms.3`).
//!
//! Deliberately the same shape as `chief.rs`'s `chief_pat_secure_*` trio, which is in turn the
//! shape `auth.rs` / `trial_remote.rs` / `builder_index.rs` use: a `keyring::Entry` under the
//! dev-suffixed service name, so a `tauri dev` build never touches the production app's keychain
//! ACL. The `keyring::Entry` API is identical across the macOS (`apple-native`) and Windows
//! (`windows-native`) backends, so none of this needs `cfg` gating.
//!
//! Two properties that are not obvious and are what the tests pin:
//!
//! - **The token never enters `config.toml`.** `[publish]` stores a credential *reference* — the
//!   destination id, from which the keychain account key is derived — and never the secret. A
//!   token in a config file is a token in a backup, in a screen share, and in whatever the user
//!   pastes into a bug report.
//! - **The value is normalized on READ as well as on write.** The token rides in an
//!   `Authorization: Bearer` header; an interior newline is a header-injection primitive and a
//!   leading space malforms the header. Validating only on write means a value stored by an older
//!   build keeps malforming every request forever, with no path to noticing.
//!
//! # Where a token is read from (bead `sparkle-xekz6g`)
//!
//! The keychain is not the only *read* source, because it is unreachable to an agent: agents in
//! this repo are hard-blocked from the macOS `security` CLI, so a keychain-only read path made the
//! documented publishing flow impossible for the very actor that needs to exercise it end to end.
//! There is therefore a **read-only environment-variable fallback**, in this order:
//!
//! 1. the destination's **keychain** item,
//! 2. `SPARKLE_PUBLISH_TOKEN_<DESTINATION_ID>` — the id upper-cased with every non-alphanumeric
//!    character mapped to `_` (see [`env_var_name`]), so two destinations can never collide,
//! 3. `None`.
//!
//! **There is deliberately NO generic `SPARKLE_PUBLISH_TOKEN`.** An earlier draft offered one as a
//! single-destination convenience, and it was a cross-destination credential leak: nothing in this
//! process knows how many destinations are configured — `[publish]` stores them in a **map** that
//! explicitly anticipates several — so a generic variable is offered to EVERY destination that
//! lacks a keychain item. With `drodio` connected via the keychain and the generic variable
//! exported for an agent run, a second `linkedin` destination with no keychain item would be handed
//! **drodio's bearer token**, and the publish client would send it in an `Authorization: Bearer`
//! header to LinkedIn's endpoint: one host's credential delivered to another host, under the wrong
//! identity. That is the same class of failure as the override direction below, in the
//! cross-destination axis. Naming the destination costs one word and closes it
//! (roborev 66497, Medium). `the_generic_variable_is_never_consulted` pins it.
//!
//! **It is a FALLBACK, never an OVERRIDE.** If a keychain entry exists, the environment is not
//! consulted at all, even when both are set. That direction is the half a careless implementation
//! gets wrong, and getting it wrong is a *worse* bug than the one this fixes: an env var that
//! silently shadows the user's real stored credential publishes under the wrong identity with
//! nothing on screen to explain it. `resolve_token_ignores_the_environment_when_the_keychain_has_one`
//! pins it in both directions.
//!
//! Nothing here ever *writes* the environment, and the env path is subject to the same
//! [`normalize_token`] pass as the keychain path — more important there, not less, since a value
//! exported from a shell heredoc is far likelier to carry a trailing newline than a keychain item
//! is. An env value that normalizes away is ABSENT, not an empty token.

/// Whether a string may name a publish destination.
///
/// **This is the single definition of the rule, and it is enforced at BOTH entrances** — here for
/// the Tauri commands, and by `config::apply_publish` for the config file. It lives in this module
/// rather than in `config.rs` because the reason for the rule is a keychain reason: the id is
/// interpolated into an account key, so a permissive rule is what would let a caller name another
/// item's slot.
///
/// Enforcing it only at config-parse time would have been a hole rather than a guarantee: the
/// commands below take a `String` straight from the webview and never pass through the config
/// layer at all, so a caller that never touches `config.toml` would have skipped the check
/// entirely.
pub fn destination_id_is_valid(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// The keychain account key for a destination's token. One item per destination, so adding X or
/// LinkedIn later is additive rather than a migration — the cheap half of "design for the next
/// destination" that the founder asked for.
fn account_key(destination_id: &str) -> String {
    format!("publish-{destination_id}-token")
}

fn entry(destination_id: &str) -> Result<keyring::Entry, String> {
    // Checked HERE, at the point the id becomes a keychain key, rather than trusting whatever
    // called us. Every path to a keychain item goes through this function.
    if !destination_id_is_valid(destination_id) {
        return Err(
            "that destination id is not valid — ids may only contain lowercase letters, digits \
             and dashes"
                .to_string(),
        );
    }
    keyring::Entry::new(
        &crate::dev_identity::keychain_service(),
        &account_key(destination_id),
    )
    .map_err(|e| e.to_string())
}

/// Trim a bearer token and reject anything that cannot ride in an `Authorization: Bearer` header.
///
/// `is_ascii_graphic` is the right predicate rather than "no newlines": it excludes the space and
/// every control character in one test, which is exactly the set RFC 7235's `token68` forbids.
/// Empty maps to `None`. Pure, so the contract is unit-tested without touching the keychain.
fn normalize_token(raw: &str) -> Option<String> {
    let token = raw.trim();
    if token.is_empty() || !token.chars().all(|c| c.is_ascii_graphic()) {
        return None;
    }
    Some(token.to_string())
}

// ── The environment-variable fallback (bead `sparkle-xekz6g`) ─────────────────────────────────
// Read-only, and consulted ONLY when the keychain has nothing — see the precedence in the module
// doc comment. Nothing here touches the OS, so it cannot block; it sits above the keychain banner
// below for that reason.

/// The environment-variable fallback's prefix. It is ONLY ever a prefix: the bare name is not a
/// variable this module reads — see the module doc for why a generic variable is a cross-destination
/// credential leak.
const ENV_TOKEN_PREFIX: &str = "SPARKLE_PUBLISH_TOKEN";

/// The per-destination environment variable name for a destination id.
///
/// Pure and TOTAL: every input maps to a legal POSIX-ish variable name, because the prefix already
/// supplies the leading letter and every id character becomes either an ASCII alphanumeric or `_`.
/// So `drodio.com` derives `SPARKLE_PUBLISH_TOKEN_DRODIO_COM` deterministically even though
/// [`destination_id_is_valid`] would reject that id — the *derivation* is total so it can be
/// unit-tested on its own, and the *lookup* ([`token_from_env_with`]) is what enforces the id rule.
pub(crate) fn env_var_name(destination_id: &str) -> String {
    let mut name = String::with_capacity(ENV_TOKEN_PREFIX.len() + 1 + destination_id.len());
    name.push_str(ENV_TOKEN_PREFIX);
    name.push('_');
    for c in destination_id.chars() {
        if c.is_ascii_alphanumeric() {
            name.push(c.to_ascii_uppercase());
        } else {
            name.push('_');
        }
    }
    name
}

/// Read the environment fallback for a destination — the per-destination variable, and NOTHING
/// else. Read-only: this never sets or unsets anything.
///
/// `lookup` is a parameter rather than a direct `std::env::var` call, for the reason the rest of
/// this crate already refuses to touch the environment in tests (`claude_oneshot.rs`: "process-
/// global and racy under `cargo test`'s threads"). A mutex serializes only the tests in *this*
/// module, while sibling modules mutate `environ` on other threads of the same test binary — a
/// genuine data race on `environ`, which surfaces as a nondeterministic wrong read or a crash
/// rather than a clean failure. With the seam, every precedence / normalization / validity case is
/// driven with no environment mutation at all (roborev 66497, Medium).
///
/// An id the keychain path would refuse is refused here too, and refused **before the lookup runs**
/// — the two entrances must agree on what names a destination, or a caller rejected at the keychain
/// could still be handed a token by the environment.
fn token_from_env_with(
    destination_id: &str,
    lookup: impl Fn(&str) -> Option<String>,
) -> Option<String> {
    if !destination_id_is_valid(destination_id) {
        return None;
    }
    lookup(&env_var_name(destination_id)).and_then(|raw| normalize_token(&raw))
}

// ── The blocking keychain work ────────────────────────────────────────────────────────────────
// Kept as plain sync fns so the Tauri commands below are thin async wrappers. A keychain call can
// block on the OS (an ACL prompt, a locked keychain), and a sync `#[tauri::command]` body runs on
// the MAIN THREAD — freezing the UI and starving the concierge bridge. That is a known repeated
// failure shape in this app, which is why `cmd_timing`'s guard rejects a sync command outright.

/// The keychain half of the read path, split out so [`resolve_token`] can be driven over both
/// answers without a test ever writing to the developer's real keychain.
fn keychain_token(destination_id: &str) -> Option<String> {
    // Guarded: in a DEBUG build this must never raise the macOS confidential-information
    // dialog for the dev-suffixed item this binary no longer owns the ACL of (sparkle-vvwbl).
    let e = entry(destination_id).ok()?;
    let stored = crate::dev_identity::no_prompt(|| e.get_password().ok())?;
    normalize_token(&stored)
}

/// Apply the precedence documented at the top of this module: keychain, then environment.
///
/// `keychain` is a parameter rather than a direct call so a test can drive the ORDER — the
/// property that matters — from both sides. The production value is supplied by [`read_token`],
/// which is the only non-test caller; the PRODUCTION closure below (the one that really reads
/// `std::env::var`) is covered by `the_real_environment_reaches_the_command`, which drives the
/// `publish_token_present` command with a variable actually exported. That test exists precisely
/// because every other test here injects the lookup, and a seam every test injects leaves the
/// production call site covered by nothing — this repo's named "defaulted seam" trap, which an
/// earlier version of this module walked straight into (roborev 66534, Medium).
fn resolve_token_with(
    destination_id: &str,
    keychain: impl FnOnce(&str) -> Option<String>,
    lookup: impl Fn(&str) -> Option<String>,
) -> Option<String> {
    keychain(destination_id).or_else(|| token_from_env_with(destination_id, lookup))
}

fn resolve_token(
    destination_id: &str,
    keychain: impl FnOnce(&str) -> Option<String>,
) -> Option<String> {
    resolve_token_with(destination_id, keychain, |name| std::env::var(name).ok())
}

fn read_token(destination_id: &str) -> Option<String> {
    resolve_token(destination_id, keychain_token)
}

fn write_token(destination_id: &str, token: &str) -> Result<(), String> {
    let Some(token) = normalize_token(token) else {
        return Err(
            "that token is empty or contains spaces/line breaks; check the paste".to_string()
        );
    };
    let e = entry(destination_id)?;
    // Guarded: in a DEBUG build this must never raise the macOS confidential-information
    // dialog for the dev-suffixed item this binary no longer owns the ACL of (sparkle-vvwbl).
    crate::dev_identity::no_prompt(|| e.set_password(&token)).map_err(|e| e.to_string())
}

fn erase_token(destination_id: &str) -> Result<(), String> {
    let entry = entry(destination_id)?;
    // Guarded: in a DEBUG build this must never raise the macOS confidential-information
    // dialog for the dev-suffixed item this binary no longer owns the ACL of (sparkle-vvwbl).
    match crate::dev_identity::no_prompt(|| entry.delete_credential()) {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// A join failure means the runtime is tearing down; there is no useful partial answer, so the
/// write paths report it the same way rather than each inventing a message. The read paths degrade
/// to "no credential", which is the safe direction: it prompts the user to configure rather than
/// letting a publish proceed on an assumption.
const JOIN_FAILED: &str = "the keychain task didn't finish";

/// Read a destination's bearer token, **for Rust callers only**.
///
/// Deliberately NOT a `#[tauri::command]`. The bearer token has no business in the webview: the
/// only consumer is `publish_client` (PR 3), which builds the `Authorization` header in Rust and
/// sends it host-side. The configure pane's one legitimate question — is a token stored? — is
/// answered by [`publish_token_present`] without the secret crossing the boundary.
///
/// `None` when none is stored (nothing configured yet) or when the stored value fails validation,
/// so a caller treats an empty result as "no credential" and surfaces the configure prompt rather
/// than sending a malformed header.
///
/// Reads the keychain first and only then the documented environment fallback — see the module
/// doc comment for the full precedence and for why the environment can never override a stored
/// credential.
#[allow(dead_code)] // First caller lands with the MCP client in PR 3 (`sparkle-131ms.4`).
pub fn token_for_destination(destination_id: &str) -> Option<String> {
    read_token(destination_id)
}

/// WHERE a destination's credential is coming from — not merely whether there is one.
///
/// This exists because "connected" stopped being a single fact when the environment fallback
/// landed (bead `sparkle-xekz6g`, roborev 66497 Medium). `publish_token_clear` deletes the
/// KEYCHAIN item and nothing else — it cannot unset a variable in the user's shell — so a
/// destination whose token comes from the environment stays credentialed across a Disconnect.
/// With only a boolean to render, a pane must then either lie ("disconnected", while every publish
/// still succeeds under the token the user just revoked) or lie the other way. Neither is
/// acceptable for a control whose entire job is revoking access, so the source is made observable
/// and the pane can say *"still supplied by `SPARKLE_PUBLISH_TOKEN_<ID>` — unset it to
/// disconnect"*.
///
/// Serialized in lowercase so the webview's union is `"keychain" | "environment" | "none"`, and
/// TOTAL — there is no `Option` here, so the TS side never has to model `null` versus absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TokenSource {
    /// Stored by the user through Sparkle. `publish_token_clear` removes this one.
    Keychain,
    /// Supplied by `SPARKLE_PUBLISH_TOKEN_<DESTINATION_ID>`. Sparkle CANNOT clear this; only the
    /// person who exported it can.
    Environment,
    /// No usable credential from either source.
    None,
}

/// Resolve the source, over the same two seams `resolve_token_with` uses, in the same order. It
/// must answer with the source of the token that would actually be USED — a second, differently
/// ordered lookup here would drift from the read path and report a source the client never reads.
fn token_source_with(
    destination_id: &str,
    keychain: impl FnOnce(&str) -> Option<String>,
    lookup: impl Fn(&str) -> Option<String>,
) -> TokenSource {
    if keychain(destination_id).is_some() {
        return TokenSource::Keychain;
    }
    if token_from_env_with(destination_id, lookup).is_some() {
        return TokenSource::Environment;
    }
    TokenSource::None
}

fn token_source(destination_id: &str) -> TokenSource {
    token_source_with(destination_id, keychain_token, |name| {
        std::env::var(name).ok()
    })
}

/// Store a destination's bearer token. Rejects an empty / header-invalid value before it reaches
/// the keychain, so a bad paste fails loudly at the moment the user pastes it rather than becoming
/// an opaque 401 on every later publish.
#[tauri::command]
pub async fn publish_token_set(destination_id: String, token: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_token(&destination_id, &token))
        .await
        .unwrap_or_else(|_| Err(JOIN_FAILED.to_string()))
}

/// Delete a destination's bearer token (disconnect). A missing item is the state the caller
/// wanted, so `NoEntry` is success.
///
/// RETURNS THE SOURCE THAT SURVIVES THE CLEAR, which is the whole point of the return type.
/// `Ok(())` used to mean "disconnected", and after the environment fallback landed that was
/// FALSE whenever a variable supplied the token: the keychain item went away, `read_token` kept
/// resolving, and the caller had no way to learn it. `TokenSource::Environment` here means *the
/// destination is still credentialed and Sparkle cannot revoke it* — say so, and name the
/// variable, rather than reporting a disconnection that did not happen.
#[tauri::command]
pub async fn publish_token_clear(destination_id: String) -> Result<TokenSource, String> {
    tauri::async_runtime::spawn_blocking(move || {
        erase_token(&destination_id)?;
        Ok(token_source(&destination_id))
    })
    .await
    .unwrap_or_else(|_| Err(JOIN_FAILED.to_string()))
}

/// Where this destination's credential comes from, for a pane that must render the difference.
/// See [`TokenSource`] — "connected" is not one fact once the environment can supply a token.
#[tauri::command]
pub async fn publish_token_source(destination_id: String) -> TokenSource {
    tauri::async_runtime::spawn_blocking(move || token_source(&destination_id))
        .await
        .unwrap_or(TokenSource::None)
}

/// Whether a destination has a usable token, without returning the secret to the caller.
///
/// The configure pane needs to render "connected / not connected", and that is the whole of what
/// it needs — handing it the token to test for emptiness would put the secret in the webview for
/// no reason. It asks the same question `read_token` answers, so a value that fails validation
/// reads as absent here too, rather than as a connection that then fails at publish time.
///
/// It asks that question through `read_token`, which means it reports `true` when the environment
/// fallback supplies the token. That is deliberate and load-bearing: a pane saying "no credential"
/// while every publish succeeds is a contradiction that costs somebody a debugging session.
#[tauri::command]
pub async fn publish_token_present(destination_id: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || read_token(&destination_id).is_some())
        .await
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::{
        account_key, destination_id_is_valid, entry, env_var_name, normalize_token,
        resolve_token_with, token_from_env_with, token_source_with, TokenSource,
        ENV_TOKEN_PREFIX,
    };

    /// The command boundary takes a `String` straight from the webview and never passes through
    /// the config layer, so validating only at config-parse time would have been a hole. Asserted
    /// on `entry` — the function every keychain path actually goes through — rather than on the
    /// predicate, because a test of the predicate alone would pass even if nothing called it.
    #[test]
    fn a_keychain_entry_cannot_be_opened_with_an_invalid_id() {
        for bad in [
            "",
            "../chief",
            "Drodio",
            "chief pat",
            "drodio/../chief",
            "a-token\nx",
        ] {
            assert!(
                entry(bad).is_err(),
                "{bad:?} must not be able to name a keychain item"
            );
        }
    }

    /// The converse — a legitimate id still opens an entry. Without this, "reject everything"
    /// passes the test above.
    #[test]
    fn a_valid_id_is_accepted_at_the_boundary() {
        assert!(destination_id_is_valid("drodio"));
        assert!(destination_id_is_valid("linked-in-2"));
        assert!(!destination_id_is_valid(&"a".repeat(65)), "bounded length");
    }

    #[test]
    fn derives_a_per_destination_account_key() {
        assert_eq!(account_key("drodio"), "publish-drodio-token");
        // Distinct destinations get distinct items, which is what makes adding a second one
        // additive rather than a migration.
        assert_ne!(account_key("drodio"), account_key("linkedin"));
    }

    /// The keychain service is shared with `chief-pat` and the auth items. A publish key must not
    /// be able to name one of those.
    #[test]
    fn cannot_collide_with_another_sparkle_keychain_item() {
        assert_ne!(account_key("pat"), "chief-pat");
        assert!(account_key("anything").starts_with("publish-"));
    }

    #[test]
    fn trims_and_keeps_a_valid_token() {
        assert_eq!(
            normalize_token("  sk-abc123  ").as_deref(),
            Some("sk-abc123")
        );
    }

    #[test]
    fn rejects_empty_and_whitespace_only() {
        assert_eq!(normalize_token(""), None);
        assert_eq!(normalize_token("   \n\t "), None);
    }

    /// The header-injection case, and the reason validation is not just `trim`. A trailing newline
    /// is removed by the trim; an INTERIOR one is not, and it is the one that matters.
    #[test]
    fn rejects_an_interior_newline() {
        assert_eq!(normalize_token("sk-abc\r\nX-Evil: 1"), None);
        assert_eq!(normalize_token("sk-abc\ndef"), None);
    }

    #[test]
    fn rejects_an_interior_space_and_control_characters() {
        assert_eq!(normalize_token("sk abc"), None);
        assert_eq!(normalize_token("sk-abc\u{7f}"), None);
        assert_eq!(normalize_token("sk-abc\u{0}"), None);
    }

    /// Non-ASCII is a smart-quote or an em-dash from a paste that went through a document. It
    /// cannot ride in the header, and failing here names the cause.
    #[test]
    fn rejects_non_ascii() {
        assert_eq!(normalize_token("sk-abc\u{2014}def"), None);
    }

    /// The converse: real bearer tokens contain punctuation, and rejecting it would break every
    /// token the destination actually issues.
    #[test]
    fn accepts_the_punctuation_real_tokens_contain() {
        for token in ["sk-a.b_c-d~e", "eyJhbGciOi.eyJzdWIiOi.SflKxwRJ", "a+b/c="] {
            assert_eq!(normalize_token(token).as_deref(), Some(token));
        }
    }

    // ── The environment-variable fallback (bead `sparkle-xekz6g`) ─────────────────────────────
    //
    // NO ENVIRONMENT MUTATION BELOW, and that is the point. `std::env::set_var` is process-global
    // and `cargo test` runs one binary's tests on parallel threads, so a mutex here serializes only
    // THIS module while `chief.rs` and `naming.rs` write `environ` on other threads of the same
    // binary. That is a genuine data race, not merely a logical one, and it surfaces as a
    // nondeterministic wrong read or a crash rather than a clean failure (roborev 66497, Medium).
    // Every case below is driven through `token_from_env_with` / `resolve_token_with`, whose
    // `lookup` seam is the same one the production path fills with `std::env::var`.

    /// A fake environment: exactly the pairs a test states, and nothing the developer happens to
    /// have exported. Returning `None` for everything else is what makes these tests independent
    /// of the machine they run on.
    fn fake_env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let owned: Vec<(String, String)> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        move |name: &str| {
            owned
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.clone())
        }
    }

    /// A lookup that must never run, and says so loudly if it does. Asserting "the answer was
    /// None" cannot tell "refused before looking" apart from "looked and found nothing".
    fn forbidden_env(name: &str) -> Option<String> {
        panic!("the environment must not be consulted at all, but `{name}` was read");
    }

    /// (6) The derivation is pure, total, and produces a LEGAL variable name for an id that a
    /// naive `format!` would turn into something no shell can export. `drodio.com` is the
    /// realistic case: a dot is not a legal character in an environment variable name.
    #[test]
    fn derives_a_legal_env_var_name_for_a_realistic_id() {
        assert_eq!(env_var_name("drodio.com"), "SPARKLE_PUBLISH_TOKEN_DRODIO_COM");
        assert_eq!(env_var_name("drodio"), "SPARKLE_PUBLISH_TOKEN_DRODIO");
        assert_eq!(env_var_name("my-site.co.uk"), "SPARKLE_PUBLISH_TOKEN_MY_SITE_CO_UK");
        // Total: every character maps to alphanumeric-or-underscore, so the result is always a
        // legal name even for an id `destination_id_is_valid` would reject.
        for id in ["a b", "üü", "x/y", ""] {
            let name = env_var_name(id);
            assert!(name.starts_with("SPARKLE_PUBLISH_TOKEN_"), "{name}");
            assert!(
                name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
                "{name} is not a legal environment variable name"
            );
        }
    }

    /// (1) THE BUG THIS FIXES. Keychain empty, the destination's own variable exported: the token
    /// is found. Before the fix this returned `None` and the documented publishing path could not
    /// be exercised at all.
    #[test]
    fn keychain_absent_falls_back_to_the_per_destination_env_var() {
        let id = "drodio";
        let env = fake_env(&[(&env_var_name(id), "sk-from-env-123")]);
        assert_eq!(
            resolve_token_with(id, |_| None, env),
            Some("sk-from-env-123".to_string())
        );
    }

    /// (2) FALLBACK, NEVER OVERRIDE — the half a careless implementation gets wrong. Both sources
    /// hold a value; the keychain's must win, because an env var that silently shadows the stored
    /// credential publishes under the wrong identity with nothing on screen to explain it.
    #[test]
    fn resolve_token_ignores_the_environment_when_the_keychain_has_one() {
        let id = "drodio";
        let env = fake_env(&[(&env_var_name(id), "sk-from-env")]);
        assert_eq!(
            resolve_token_with(id, |_| Some("sk-from-keychain".to_string()), env),
            Some("sk-from-keychain".to_string()),
            "the keychain is the primary source; the environment is only a fallback"
        );
    }

    /// (3) The env path runs the SAME normalization as the keychain path. This matters more here,
    /// not less: a value exported from a shell heredoc carries a trailing newline far more often
    /// than a keychain entry does, and an interior newline in an `Authorization` header is a
    /// header-injection primitive.
    #[test]
    fn env_values_are_normalized_exactly_like_keychain_values() {
        let id = "drodio";
        let var = env_var_name(id);
        for raw in ["  sk-abc  ", "sk-abc\n", "\tsk-abc\r\n"] {
            assert_eq!(
                resolve_token_with(id, |_| None, fake_env(&[(&var, raw)])),
                Some("sk-abc".to_string()),
                "{raw:?} should normalize to the same token the keychain path would produce"
            );
        }
        // An INTERIOR newline is not whitespace to be trimmed — it is a malformed token, and the
        // keychain path rejects it outright. The env path must agree.
        assert_eq!(
            resolve_token_with(id, |_| None, fake_env(&[(&var, "sk-abc\ndef")])),
            None
        );
    }

    /// (4) A value that normalizes away is ABSENT, not an empty token. An empty bearer would be
    /// sent as `Authorization: Bearer ` and fail at the destination with a confusing 401.
    #[test]
    fn an_empty_or_whitespace_only_env_value_is_absent() {
        let id = "drodio";
        let var = env_var_name(id);
        for raw in ["", "   ", "\n", "\t \r\n"] {
            assert_eq!(
                resolve_token_with(id, |_| None, fake_env(&[(&var, raw)])),
                None,
                "{raw:?} must read as no credential at all"
            );
        }
    }

    /// (5) THE CROSS-DESTINATION LEAK, pinned. There is no generic `SPARKLE_PUBLISH_TOKEN`: a
    /// destination is handed its OWN variable or nothing. Exporting the bare name for `drodio`
    /// must not hand that bearer to `linkedin`, whose endpoint is a different host entirely.
    #[test]
    fn the_generic_variable_is_never_consulted() {
        let env = fake_env(&[
            (ENV_TOKEN_PREFIX, "sk-drodios-token"),
            ("SPARKLE_PUBLISH_TOKEN_DRODIO", "sk-drodios-token"),
        ]);
        assert_eq!(
            resolve_token_with("linkedin", |_| None, &env),
            None,
            "a destination with no variable of its own gets NO token — never another host's"
        );
        // …and the destination the variable names still resolves, so this is a scoping rule and
        // not a regression of the fallback itself.
        assert_eq!(
            resolve_token_with("drodio", |_| None, &env),
            Some("sk-drodios-token".to_string())
        );
    }

    /// (6b) An id the keychain path refuses is refused here BEFORE the environment is read, so the
    /// two entrances cannot disagree about what names a destination.
    #[test]
    fn an_invalid_destination_id_never_reads_the_environment() {
        for bad in ["../etc", "a b", "", "x/y"] {
            assert!(!destination_id_is_valid(bad), "precondition: {bad:?} is invalid");
            assert_eq!(token_from_env_with(bad, forbidden_env), None);
        }
    }

    /// DISCONNECT MUST NOT CLAIM A DISCONNECTION IT DID NOT PERFORM (roborev 66497, Medium).
    ///
    /// `publish_token_clear` deletes the keychain item and cannot unset a variable in the user's
    /// shell, so with the environment supplying the token the destination stays credentialed. The
    /// old signature returned `Ok(())` for both outcomes, so a pane had no way to tell "revoked"
    /// from "still live under the token you just revoked" — and would have kept publishing.
    ///
    /// Asserted on the SOURCE, which is what a caller renders, over the same seams the read path
    /// uses. All three states, because a rule that only ever answers one of them is not a rule.
    #[test]
    fn the_reported_source_distinguishes_keychain_environment_and_none() {
        let id = "drodio";
        let var = env_var_name(id);

        // Keychain present: the environment is not even consulted, so its value is irrelevant.
        assert_eq!(
            token_source_with(id, |_| Some("sk-stored".to_string()), fake_env(&[(&var, "sk-env")])),
            TokenSource::Keychain
        );

        // THE DISCONNECT CASE. Keychain gone (as `erase_token` leaves it), variable still exported:
        // this MUST NOT read as disconnected.
        assert_eq!(
            token_source_with(id, |_| None, fake_env(&[(&var, "sk-env")])),
            TokenSource::Environment,
            "a destination the environment still credentials is NOT disconnected"
        );

        // Genuinely disconnected.
        assert_eq!(
            token_source_with(id, |_| None, fake_env(&[])),
            TokenSource::None
        );
    }


    /// THE PRODUCTION SEAM — the one call site every other test in this module injects away
    /// (roborev 66534, Medium).
    ///
    /// The previous version of this test asserted a NEGATIVE ("nothing configured reads as no
    /// credential"), which passes for ANY implementation that returns `None` — including one with
    /// the environment fallback deleted outright. That is not coverage, and the commit that
    /// introduced it claimed it was. Six injected tests plus one negative left the production
    /// `std::env::var` closure guarded by nothing.
    ///
    /// So this one drives the real `#[tauri::command]` against the REAL environment, in BOTH
    /// directions, and it is the only test here that writes a variable. That write is bounded:
    /// the id is unique to this test, so the name it derives collides with nothing in this process
    /// — no other test in this module reads or writes it, and the guard restores the prior value
    /// even if an assertion panics.
    #[test]
    fn the_real_environment_reaches_the_command() {
        let id = "xekz6g-prodseam";
        let var = env_var_name(id);
        let _guard = EnvGuard::new(&var);

        // FALSE first, so the true-direction below is a CHANGE rather than a coincidence.
        assert!(
            !tauri::async_runtime::block_on(super::publish_token_present(id.to_string())),
            "precondition: nothing stored and nothing exported for this id"
        );
        assert_eq!(
            tauri::async_runtime::block_on(super::publish_token_source(id.to_string())),
            TokenSource::None
        );

        std::env::set_var(&var, "sk-from-the-real-environment");

        // The command must now report connected — this is what deleting the production closure
        // would break, and what nothing else here would notice.
        assert!(
            tauri::async_runtime::block_on(super::publish_token_present(id.to_string())),
            "the pane must report connected when the real environment supplies the token"
        );
        assert_eq!(
            tauri::async_runtime::block_on(super::publish_token_source(id.to_string())),
            TokenSource::Environment,
            "and it must say WHERE it came from, or Disconnect cannot tell the user the truth"
        );
    }

    /// Restores one variable to whatever it was, even if an assertion panics. Scoped to a single
    /// uniquely-named variable rather than a module-wide lock: the lock was the thing that gave a
    /// false sense of safety, since it serialized only THIS module while siblings write `environ`
    /// on other threads of the same binary.
    struct EnvGuard {
        key: String,
        prev: Option<String>,
    }

    impl EnvGuard {
        fn new(key: &str) -> Self {
            let prev = std::env::var(key).ok();
            std::env::remove_var(key);
            Self { key: key.to_string(), prev }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.prev {
                Some(v) => std::env::set_var(&self.key, v),
                None => std::env::remove_var(&self.key),
            }
        }
    }

    /// PRECEDENCE, asserted asymmetrically — the property `token_source_with`'s doc claims and the
    /// previous version of this test did not pin (roborev 66549, Medium). With both sources
    /// present, "a token resolved" and "a source was reported" hold under EITHER order, so an
    /// inverted lookup passed. Naming which source wins is what makes it a precedence test.
    #[test]
    fn with_both_sources_present_the_keychain_wins_in_the_token_and_in_the_source() {
        let id = "drodio";
        let env = fake_env(&[(&env_var_name(id), "sk-from-env")]);
        assert_eq!(
            resolve_token_with(id, |_| Some("sk-from-keychain".to_string()), &env),
            Some("sk-from-keychain".to_string())
        );
        assert_eq!(
            token_source_with(id, |_| Some("sk-from-keychain".to_string()), &env),
            TokenSource::Keychain,
            "the source must name the token that was actually USED"
        );
    }

    /// The read path and the source must agree in every combination, so a pane cannot render
    /// "connected" off one and a variable name off the other. Iterated over the four real states
    /// explicitly — the previous version destructured its table's env column away (`for (stored,
    /// _)`) and substituted its own pairs, so four rows collapsed to two and the "an unrelated
    /// variable is exported" case never ran at all.
    #[test]
    fn the_source_agrees_with_the_read_path_in_every_combination() {
        let id = "drodio";
        let var = env_var_name(id);
        let unrelated = "SPARKLE_PUBLISH_TOKEN_SOMETHING_ELSE";
        let envs: [Vec<(&str, &str)>; 3] = [
            vec![],
            vec![(var.as_str(), "sk-env")],
            vec![(unrelated, "sk-env")], // exported, but not for THIS destination
        ];
        for stored in [Some("sk-stored"), None] {
            for pairs in &envs {
                let keychain = |_: &str| stored.map(str::to_string);
                let token = resolve_token_with(id, keychain, fake_env(pairs));
                let source = token_source_with(id, keychain, fake_env(pairs));
                assert_eq!(
                    token.is_some(),
                    source != TokenSource::None,
                    "read path and source disagree for stored={stored:?} env={pairs:?}"
                );
            }
        }
    }
}
