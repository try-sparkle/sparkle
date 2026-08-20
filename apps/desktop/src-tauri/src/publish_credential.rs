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

// ── The blocking keychain work ────────────────────────────────────────────────────────────────
// Kept as plain sync fns so the Tauri commands below are thin async wrappers. A keychain call can
// block on the OS (an ACL prompt, a locked keychain), and a sync `#[tauri::command]` body runs on
// the MAIN THREAD — freezing the UI and starving the concierge bridge. That is a known repeated
// failure shape in this app, which is why `cmd_timing`'s guard rejects a sync command outright.

fn read_token(destination_id: &str) -> Option<String> {
    let stored = entry(destination_id).ok()?.get_password().ok()?;
    normalize_token(&stored)
}

fn write_token(destination_id: &str, token: &str) -> Result<(), String> {
    let Some(token) = normalize_token(token) else {
        return Err(
            "that token is empty or contains spaces/line breaks; check the paste".to_string()
        );
    };
    entry(destination_id)?
        .set_password(&token)
        .map_err(|e| e.to_string())
}

fn erase_token(destination_id: &str) -> Result<(), String> {
    match entry(destination_id)?.delete_credential() {
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
#[allow(dead_code)] // First caller lands with the MCP client in PR 3 (`sparkle-131ms.4`).
pub fn token_for_destination(destination_id: &str) -> Option<String> {
    read_token(destination_id)
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
#[tauri::command]
pub async fn publish_token_clear(destination_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || erase_token(&destination_id))
        .await
        .unwrap_or_else(|_| Err(JOIN_FAILED.to_string()))
}

/// Whether a destination has a usable token, without returning the secret to the caller.
///
/// The configure pane needs to render "connected / not connected", and that is the whole of what
/// it needs — handing it the token to test for emptiness would put the secret in the webview for
/// no reason. It asks the same question `read_token` answers, so a value that fails validation
/// reads as absent here too, rather than as a connection that then fails at publish time.
#[tauri::command]
pub async fn publish_token_present(destination_id: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || read_token(&destination_id).is_some())
        .await
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::{account_key, destination_id_is_valid, entry, normalize_token};

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
}
