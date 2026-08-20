//! Destination URL validation for `[publish]` (bead `sparkle-131ms.3`).
//!
//! A publish destination is a network egress target that Sparkle sends a bearer token to. That
//! makes its URL a security boundary, not a formatting preference, so the rules live here as a
//! pure function rather than being spread across the configure UI and the HTTP client — and the
//! client re-runs this at call time, because a hand-edited `config.toml` must not route around
//! whatever the UI checked.
//!
//! Four rules, each written the way it is because the obvious spelling is wrong:
//!
//! 1. **TLS is required**, and a non-`https` scheme is REJECTED BY NAME rather than silently
//!    upgraded. Silently rewriting `http://` to `https://` would mean the value the user reads back
//!    out of their own config is not the value Sparkle uses; and if the upgrade fails, the error
//!    names a URL they never typed.
//! 2. **Loopback is exempt** so a destination can be developed against locally. It is matched on
//!    the parsed [`Host`] enum, NOT on `host_str()`: that accessor returns an IPv6 literal WITH its
//!    brackets (`[::1]`), so a string compare against `"::1"` never matches and a substring compare
//!    matches far too much. `Ipv4Addr::is_loopback` also takes all of `127.0.0.0/8`, not just
//!    `127.0.0.1`, which is what a hand-rolled equality check gets wrong.
//! 3. **Userinfo is rejected** via [`Url::username`]/[`Url::password`], not `contains('@')`. An `@`
//!    is perfectly legal in a path or query (`/api/mcp?to=a@b.com`), so the string test rejects
//!    valid URLs; and a URL can carry a password with an empty username, which a naive check for a
//!    non-empty username misses.
//! 4. **The URL is returned parsed**, so the caller cannot re-parse it differently from the way it
//!    was validated. Validating one string and sending another is the whole class of bug this
//!    signature exists to prevent.

use url::{Host, Url};

/// Validate a configured publish-destination URL and return it parsed.
///
/// `Err` carries a message written for a human reading it in the configure UI: it names the
/// specific rule that failed and, where the distinction matters, what was actually seen.
pub fn validate_destination_url(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("a publish destination needs a URL".to_string());
    }

    let url = Url::parse(trimmed).map_err(|e| format!("that is not a valid URL: {e}"))?;

    // Rule 3 first: userinfo is a credential in a config file, and it should be reported as that
    // rather than being masked by a later complaint about the scheme.
    if !url.username().is_empty() || url.password().is_some() {
        return Err(
            "remove the username/password from the URL — Sparkle sends the destination's token \
             from the OS keychain, and a credential written into config.toml would sit on disk in \
             plaintext"
                .to_string(),
        );
    }

    let host = url
        .host()
        .ok_or_else(|| "that URL has no host — a publish destination must name one".to_string())?;

    // Rule 2: computed BEFORE the scheme check, because a loopback destination is allowed to be
    // plain http and the scheme error must not fire on it.
    let loopback = match &host {
        // Exact and case-insensitive: `LocalHost` is the same name, but `localhost.example.com` is
        // a wholly different (and remote) host that a `starts_with`/`contains` test would let in.
        Host::Domain(d) => d.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(ip) => ip.is_loopback(),
        Host::Ipv6(ip) => ip.is_loopback(),
    };

    if url.scheme() != "https" && !loopback {
        return Err(format!(
            "a publish destination must use https — this one uses {}. Sparkle sends a bearer \
             token to it, and over plain http that token is readable by anything on the network. \
             (http is allowed only for localhost.)",
            url.scheme()
        ));
    }

    // A loopback exemption is for http/https development servers, not for handing an arbitrary
    // scheme to the HTTP client. Without this, `file://localhost/etc/passwd` passes both checks
    // above — it parses, it has no userinfo, and its host is loopback.
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err(format!(
            "a publish destination must be an http(s) URL — this one uses {}",
            url.scheme()
        ));
    }

    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::validate_destination_url;

    /// The real destination. Asserts the parsed URL comes back unchanged, so a future "helpful"
    /// normalization (adding a trailing slash, lowercasing a path) has to be a deliberate edit.
    #[test]
    fn accepts_the_https_destination_unchanged() {
        let url = validate_destination_url("https://drodio.com/api/mcp").expect("https accepted");
        assert_eq!(url.as_str(), "https://drodio.com/api/mcp");
    }

    #[test]
    fn trims_surrounding_whitespace() {
        let url = validate_destination_url("  https://drodio.com/api/mcp\n").expect("accepted");
        assert_eq!(url.as_str(), "https://drodio.com/api/mcp");
    }

    /// The scheme rule, and the load-bearing half of it: the message NAMES the scheme, and nothing
    /// is silently upgraded. A test that only asserted `is_err()` would pass against an
    /// implementation that rewrote the URL to https and then failed for some other reason.
    #[test]
    fn rejects_plain_http_by_name_and_does_not_upgrade_it() {
        let err = validate_destination_url("http://drodio.com/api/mcp")
            .expect_err("plain http must be rejected");
        assert!(err.contains("http"), "the error names the scheme: {err}");
        assert!(
            err.contains("https"),
            "the error says what is required: {err}"
        );
    }

    #[test]
    fn rejects_a_non_http_scheme_even_on_loopback() {
        // The loopback exemption is for local dev servers. Without the second scheme check this
        // parses, carries no userinfo, and has a loopback host — so it would be accepted.
        validate_destination_url("file://localhost/etc/passwd")
            .expect_err("a non-http scheme must be rejected even on loopback");
    }

    /// All three loopback spellings. `[::1]` is the one that catches a `host_str()` implementation:
    /// that accessor returns the literal WITH brackets, so a string compare against "::1" fails.
    #[test]
    fn accepts_every_loopback_form_over_plain_http() {
        for raw in [
            "http://localhost:3000/api/mcp",
            "http://LocalHost:3000/api/mcp",
            "http://127.0.0.1:3000/api/mcp",
            "http://[::1]:3000/api/mcp",
        ] {
            validate_destination_url(raw).unwrap_or_else(|e| panic!("{raw} should be loopback: {e}"));
        }
    }

    /// `127.0.0.0/8` is loopback in its entirety. A hand-rolled `== "127.0.0.1"` check — the
    /// obvious spelling — fails this one.
    #[test]
    fn accepts_the_whole_127_slash_8_range_not_just_127_0_0_1() {
        validate_destination_url("http://127.0.0.2:3000/api/mcp").expect("127.0.0.2 is loopback");
    }

    /// A hostname that merely CONTAINS "localhost" is remote, and must not inherit the exemption.
    #[test]
    fn does_not_treat_a_localhost_lookalike_host_as_loopback() {
        validate_destination_url("http://localhost.evil.example.com/api/mcp")
            .expect_err("a host that only looks like localhost is remote and needs https");
    }

    #[test]
    fn rejects_userinfo() {
        validate_destination_url("https://user:secret@drodio.com/api/mcp")
            .expect_err("userinfo must be rejected");
    }

    /// A password with an EMPTY username. A check for a non-empty username alone misses this, and
    /// it is exactly the shape that smuggles a credential into a config file.
    #[test]
    fn rejects_a_password_with_no_username() {
        validate_destination_url("https://:secret@drodio.com/api/mcp")
            .expect_err("a password with an empty username must still be rejected");
    }

    /// The converse of the userinfo rule, and the reason it is not written as `contains('@')`.
    /// Without this test, the cheap wrong implementation passes every other test in this file.
    #[test]
    fn accepts_a_legal_at_sign_in_the_path_and_query() {
        validate_destination_url("https://drodio.com/api/mcp/@drodio").expect("@ in a path is legal");
        validate_destination_url("https://drodio.com/api/mcp?as=someone@example.com")
            .expect("@ in a query is legal");
    }

    #[test]
    fn rejects_empty_and_unparseable_input() {
        validate_destination_url("").expect_err("empty");
        validate_destination_url("   ").expect_err("whitespace only");
        validate_destination_url("not a url").expect_err("unparseable");
    }

    /// A scheme that carries no authority at all reaches the no-host branch. It must be refused
    /// before anything tries to send a bearer token to it.
    #[test]
    fn rejects_a_url_with_no_host() {
        validate_destination_url("mailto:someone@example.com").expect_err("mailto names no host");
        validate_destination_url("data:text/plain,hello").expect_err("data names no host");
    }

    /// Pins a genuinely surprising WHATWG behaviour, discovered by this suite rather than assumed:
    /// for a SPECIAL scheme the parser collapses an extra slash, so `https:///api/mcp` does not
    /// mean "no host" — it silently becomes host `api`, path `/mcp`.
    ///
    /// It is recorded here because the intuitive reading ("that URL has no host, so it will be
    /// rejected") is wrong, and a typo of this exact shape would otherwise send the user's token to
    /// a host called `api` with no warning. The validator's job is to make sure the result is still
    /// SAFE — https, no userinfo — not to second-guess the parser.
    #[test]
    fn an_extra_slash_is_collapsed_by_the_parser_rather_than_meaning_no_host() {
        let url = validate_destination_url("https:///api/mcp")
            .expect("the parser collapses the slash, so this is a valid https URL");
        assert_eq!(url.host_str(), Some("api"));
        assert_eq!(url.path(), "/mcp");
    }
}
