//! Guard for the `frame-src` directive the live browser preview depends on.
//!
//! **This module has no runtime code.** It exists so that the one CSP directive the preview needs
//! cannot drift — in either direction — without a test going red. Both directions are real
//! regressions, and neither has a visible symptom:
//!
//! - **Widened** (a remote origin, a bare `http:`, or `frame-src *`) and Sparkle will happily frame
//!   an attacker-controlled page inside its own window. Nothing looks wrong.
//! - **Deleted** and framing falls back to `default-src 'self'`, which silently disables the whole
//!   preview feature in a shipped build while every TypeScript test stays green. Measured, not
//!   assumed — see the Phase 0 table in `docs/live-browser-preview.md`: with the directive absent,
//!   all three probes (including both loopback ones) are REFUSED.
//!
//! The directive is also the preview's **navigation allowlist**, which is the load-bearing part.
//! `frame-src` governs *every* navigation of the frame, not just its initial `src`, so a framed
//! page cannot navigate itself to `file://`, `tauri://`, `asset://` or `ipc://` — those are simply
//! not in the directive. That is a stronger guarantee than a runtime check, because WebKit enforces
//! it on every navigation rather than relying on a call site remembering to.
//!
//! ## Bridge isolation rests on the PORT RESERVATION, not on this directive
//!
//! A cross-origin iframe gets no `__TAURI_INTERNALS__` and cannot reach the parent's globals — but
//! only while the origins actually differ, and **`frame-src` does not guarantee that**. An earlier
//! version of this doc claimed it did. It is false in a dev build:
//!
//! `build.devUrl` is `http://localhost:1420`, so in `tauri dev` the app document's OWN origin is
//! `http://localhost:1420` — which `frame-src http://localhost:*` matches. A preview frame pointed
//! at 1420 would be **same-origin with the host document** and could read
//! `parent.__TAURI_INTERNALS__` directly, defeating bridge isolation entirely.
//!
//! What actually prevents that is the port allocator refusing to hand out 1420 (`preview.rs`).
//! The reservation is the control; this directive is not. `sparkles_own_dev_port_is_reserved`
//! below asserts the reservation itself — an earlier version asserted only that `devUrl` still
//! said 1420, which is a precondition, not the mitigation, and stayed green no matter what the
//! allocator did.
//!
//! Parsed as JSON rather than substring-matched, so a reformat cannot quietly turn the guard into a
//! no-op (the lesson from roborev #686, and the same technique as
//! `audio::hardened_runtime_build_grants_microphone_entitlement`).

/// Ports the preview allocator must never hand out.
///
/// **1420 is Sparkle's own `devUrl`.** Two independent reasons, either of which is disqualifying:
/// Tauri rewrites External URLs matching `devUrl`, and — the serious one — in a dev build the app
/// document's own origin IS `http://localhost:1420`, so a frame there would be same-origin with
/// the host document and could reach `parent.__TAURI_INTERNALS__`. See the module doc.
///
/// Defined HERE rather than in `preview.rs` because the reason is a property of the CSP/origin
/// relationship, and because this module's test is what keeps it honest.
pub const RESERVED_PORTS: &[u16] = &[1420];

/// The exact origins `frame-src` may name. Loopback only, `http` only.
///
/// `localhost` and `127.0.0.1` are BOTH required and are not redundant: Apple's ATS localhost
/// exemption and the IP-literal case are different rules, and a dev server may print either. Both
/// were verified to render in the Phase 0 spike.
///
/// **The IPv6 loopback literal `[::1]` is deliberately ABSENT, and that is a real constraint the
/// URL path must honor.** CSP matches on the URL's host string, not the resolved address, so a dev
/// server whose URL is `http://[::1]:5173/` would be REFUSED here even though `::1` is loopback and
/// both the Rust and TypeScript loopback gates accept it. Two reasons it is not simply added:
/// CSP's `host-source` grammar is hostname-shaped and IPv6-literal support is inconsistent across
/// engines, and an invalid source risks the directive rather than just that entry — which is the
/// silent-death failure this module exists to prevent, so it is not a change to make unmeasured.
///
/// The contract instead, stated as what the code DOES rather than what it should: the supervisor
/// forces `--host 127.0.0.1` where the framework accepts a host flag, and
/// `preview::choose_listener` **REFUSES a bind that is only on the IPv6 loopback**, by name, so the
/// frame is never handed a URL it cannot load. A dual-stack server is accepted on its v4 address.
///
/// There is deliberately NO normalization of `[::1]` to `127.0.0.1`: they are different addresses,
/// and rewriting one to the other would produce a URL pointing at a socket that may not exist. An
/// earlier version of this paragraph claimed a normalizer existed and that discovery already
/// refused v6-only binds; the first was never true and the second only became true when the
/// refusal was added. Adding `http://[::1]:*` here remains a measurable follow-up, not a guess.
#[cfg(test)]
const ALLOWED_FRAME_SRC: &[&str] = &["http://localhost:*", "http://127.0.0.1:*"];

/// The COMPLETE expected token set for every directive except `frame-src` (which has its own
/// exact-set test above).
///
/// Set equality, not a loose-form denylist. An earlier version listed only the tokens that *look*
/// dangerous — `*`, scheme-only, host wildcards, `unsafe-*` — which meant an **exact new remote
/// origin** passed in silence: adding `https://telemetry.evil.example` to `connect-src`, or
/// `https://cdn.evil.example` to `img-src`, produced no failure at all. That is the widening class
/// that actually exfiltrates, and it was invisible while the file claimed to "make every widening
/// NAMED rather than invisible".
///
/// The live policy is ~14 tokens, so pinning it exactly is cheap and any addition — loose or exact
/// — must now be written down here with its reason.
#[cfg(test)]
const EXPECTED_DIRECTIVES: &[(&str, &[&str])] = &[
    // The inherited default everything else narrows.
    ("default-src", &["'self'"]),
    // `ipc:` is Tauri's own IPC scheme and `http://ipc.localhost` its Windows equivalent — the
    // bridge the app cannot function without. The fly.dev pair is the orchestration relay.
    // `https://*.storage.googleapis.com` is a host wildcard under ONE registrable domain: signed
    // GCS URLs are issued per bucket subdomain, so the host cannot be enumerated. It grants
    // `fetch` only, and it is PRE-EXISTING — it was invisible until this test pinned the set.
    (
        "connect-src",
        &[
            "'self'",
            "ipc:",
            "http://ipc.localhost",
            "http://localhost:3001",
            "ws://localhost:3001",
            "https://storage.googleapis.com",
            "https://*.storage.googleapis.com",
        ],
    ),
    // Inline styles are required by the app's own styled components; Google Fonts is a deliberate
    // remote stylesheet.
    ("style-src", &["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"]),
    ("font-src", &["'self'", "https://fonts.gstatic.com"]),
    // `data:` images are how every inline thumbnail and screenshot preview renders.
    ("img-src", &["'self'", "data:"]),
];

#[cfg(test)]
mod tests {
    use super::*;

    /// Read `tauri.conf.json` and return the CSP string.
    fn csp() -> String {
        let dir = env!("CARGO_MANIFEST_DIR");
        let conf: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(format!("{dir}/tauri.conf.json")).expect("read tauri.conf.json"),
        )
        .expect("parse tauri.conf.json");
        conf.pointer("/app/security/csp")
            .and_then(|v| v.as_str())
            .expect("app.security.csp is a string")
            .to_string()
    }

    /// Split a CSP into (directive-name, tokens) pairs.
    fn directives(csp: &str) -> Vec<(String, Vec<String>)> {
        csp.split(';')
            .filter_map(|part| {
                let mut it = part.split_whitespace();
                let name = it.next()?.to_string();
                Some((name, it.map(|s| s.to_string()).collect()))
            })
            .collect()
    }

    /// The preview is disabled in a shipped build if this directive goes missing, and no
    /// TypeScript test can see that — the frame simply never paints. Phase 0 measured it: with
    /// `frame-src` absent, `http://127.0.0.1:5199` is REFUSED along with everything else.
    #[test]
    fn frame_src_is_present_or_the_preview_is_silently_dead() {
        let csp = csp();
        let found = directives(&csp).into_iter().find(|(n, _)| n == "frame-src");
        assert!(
            found.is_some(),
            "app.security.csp has no frame-src directive, so framing falls back to \
             default-src 'self' and the live browser preview cannot render. \
             Expected: frame-src {}. Full CSP: {csp}",
            ALLOWED_FRAME_SRC.join(" "),
        );
    }

    /// The narrowness claim, asserted rather than argued.
    ///
    /// This is the assertion that makes "the directive is an allowlist" load-bearing instead of
    /// circumstantial: Phase 0 showed `http://example.com` refused BY `frame-src` in the same
    /// build that rendered loopback, and this keeps that true.
    #[test]
    fn frame_src_names_loopback_and_nothing_else() {
        let csp = csp();
        let (_, tokens) = directives(&csp)
            .into_iter()
            .find(|(n, _)| n == "frame-src")
            .expect("frame-src present (see the sibling test)");

        let mut got: Vec<&str> = tokens.iter().map(|s| s.as_str()).collect();
        got.sort_unstable();
        let mut want: Vec<&str> = ALLOWED_FRAME_SRC.to_vec();
        want.sort_unstable();
        assert_eq!(
            got, want,
            "frame-src must name loopback origins and nothing else. A remote origin here lets an \
             agent-authored page be framed inside Sparkle's own window, and `*` or a bare `http:` \
             lets ANY page be. Full CSP: {csp}",
        );
    }

    /// A `frame-src` that is narrow means nothing if the rest of the policy has been opened up —
    /// the preview's containment rests on the framed document being cross-origin from Sparkle's
    /// and on Sparkle's own document staying locked down.
    ///
    /// An earlier version checked only that the CSP *starts with* `default-src 'self'` and that no
    /// directive held a bare `*`, which passed `default-src 'self' http:` and
    /// `script-src 'self' 'unsafe-eval'`. Tightening that to a loose-form denylist was still not
    /// enough: an EXACT new remote origin — `https://telemetry.evil.example` in `connect-src` —
    /// looks like nothing on a denylist while being the widening that actually exfiltrates.
    ///
    /// So this asserts SET EQUALITY per directive. Any addition, loose or exact, must be written
    /// into EXPECTED_DIRECTIVES with its reason before this goes green.
    #[test]
    fn the_rest_of_the_policy_is_still_the_strict_one() {
        let csp = csp();
        let live: Vec<(String, Vec<String>)> = directives(&csp)
            // frame-src has its own exact-set test; excluded so the two cannot fight.
            .into_iter()
            .filter(|(n, _)| n != "frame-src")
            .collect();

        let live_names: std::collections::BTreeSet<&str> =
            live.iter().map(|(n, _)| n.as_str()).collect();
        let want_names: std::collections::BTreeSet<&str> =
            EXPECTED_DIRECTIVES.iter().map(|(n, _)| *n).collect();
        assert_eq!(
            live_names, want_names,
            "the CSP's directive SET changed. A new directive is a policy decision and must be \
             recorded in EXPECTED_DIRECTIVES. Full CSP: {csp}",
        );

        for (name, tokens) in &live {
            let want: &[&str] = EXPECTED_DIRECTIVES
                .iter()
                .find(|(d, _)| d == name)
                .map(|(_, t)| *t)
                .expect("directive set already asserted equal");
            let mut got: Vec<&str> = tokens.iter().map(|s| s.as_str()).collect();
            got.sort_unstable();
            let mut expected: Vec<&str> = want.to_vec();
            expected.sort_unstable();
            assert_eq!(
                got, expected,
                "directive `{name}` changed. EVERY source is pinned here, not just the \
                 dangerous-looking ones — an exact remote origin is the widening that actually \
                 exfiltrates and would otherwise pass in silence. Add it to EXPECTED_DIRECTIVES \
                 with its reason if it is deliberate. Full CSP: {csp}",
            );
        }
    }

    /// The mitigation, asserted directly.
    ///
    /// This replaces a test that asserted only that `devUrl` still said 1420 — a PRECONDITION, not
    /// the control. It stayed green no matter what the allocator did, which is the
    /// precondition-not-side-effect shape this repo's testing rules call out by name.
    ///
    /// What makes 1420 disqualifying is not just Tauri's External-URL rewrite: in a dev build the
    /// app document's own origin IS `http://localhost:1420`, so a frame there is SAME-ORIGIN with
    /// the host and can reach `parent.__TAURI_INTERNALS__`. Deleting the reservation must go red.
    #[test]
    fn sparkles_own_dev_port_is_reserved() {
        let dir = env!("CARGO_MANIFEST_DIR");
        let conf: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(format!("{dir}/tauri.conf.json")).expect("read tauri.conf.json"),
        )
        .expect("parse tauri.conf.json");
        let dev_url = conf
            .pointer("/build/devUrl")
            .and_then(|v| v.as_str())
            .unwrap_or_default();

        // Derive the port from devUrl rather than hardcoding it, so a devUrl change cannot leave
        // the reservation silently pointing at the wrong number.
        let dev_port: u16 = dev_url
            .rsplit(':')
            .next()
            .and_then(|p| p.trim_end_matches('/').parse().ok())
            .unwrap_or_else(|| panic!("could not read a port out of devUrl `{dev_url}`"));

        // Drives the SELECTION, not a predicate and not the constant.
        //
        // Two earlier versions were weaker than they read. The first asserted
        // `RESERVED_PORTS.contains(&dev_port)` — self-referential. The second called
        // `is_reserved_port`, which IS `RESERVED_PORTS.contains(&port)`, so it went red under
        // exactly the same single mutation (editing the literal) while its comment claimed to
        // cover "an allocator that ignores the constant". One indirection is not a behaviour test.
        //
        // `first_unreserved` is the CHOOSING function, so this pins its contract against the live
        // `devUrl` — the number nobody can edit by hand without also editing Vite and Tauri.
        //
        // WHAT IT DOES NOT COVER, said plainly so the next reader does not over-trust it: this
        // still drives a helper, not `allocate_port`. That function reaches the reservation through
        // one line (`if let Some(p) = first_unreserved(&seen[seen.len() - 1..])`); deleting that
        // line and returning the bound port directly leaves this assertion green, because
        // `first_unreserved` itself is untouched. `preview.rs`'s `assert!(!is_reserved_port(port))`
        // on a live `allocate_port()` cannot close that either — the kernel essentially never hands
        // out 1420, so it passes whether or not the skip is enforced. Closing it properly means
        // making the allocator's candidate source injectable; filed rather than faked here.
        //
        // The probe is DERIVED from `RESERVED_PORTS`, not `dev_port + 1`. That arithmetic was only
        // correct while the list held exactly one entry: reserving 1421 (the conventional Vite/Tauri
        // HMR port, a plausible hardening) would flip both calls to `None` and fail with messages
        // that actively misdescribe the cause — "the allocator handed it out" when it in fact
        // refused. Deriving the INPUT from the constant is not self-referential; the assertion is
        // still about what `first_unreserved` returns.
        let free = (dev_port.saturating_add(1)..=u16::MAX)
            .find(|p| !RESERVED_PORTS.contains(p))
            .expect("some port above the dev port is unreserved");
        assert_eq!(
            crate::preview::first_unreserved(&[dev_port, free]),
            Some(free),
            "devUrl is `{dev_url}` (port {dev_port}) but the allocator's own selection handed it \
             out. A preview there would be SAME-ORIGIN with the app document in a dev build and \
             could read parent.__TAURI_INTERNALS__.",
        );
        // And it is not simply refusing everything.
        assert_eq!(
            crate::preview::first_unreserved(&[free]),
            Some(free),
            "an unreserved port must still be selectable",
        );

        // And the reservation is only meaningful because frame-src admits that host at all.
        let (_, tokens) = directives(&csp())
            .into_iter()
            .find(|(n, _)| n == "frame-src")
            .expect("frame-src present");
        assert!(
            tokens.iter().any(|t| t.contains("localhost")),
            "frame-src no longer admits localhost, so this reservation may be guarding nothing — \
             re-derive whether the same-origin hazard still exists. Tokens: {tokens:?}",
        );
    }
}
