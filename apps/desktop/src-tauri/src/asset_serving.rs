//! No runtime code — a build-configuration guard for a runtime performance property the Rust type
//! system cannot see.
//!
//! Tauri serves the embedded frontend through a custom URL-scheme handler that runs SYNCHRONOUSLY on
//! the macOS main thread (`WebURLSchemeHandlerCocoa::platformStartTask`, observed dominating the main
//! thread during a drag in a live `sample`). With Tauri's default `compression` feature ON, every one
//! of those fetches calls `tauri_utils::assets::EmbeddedAssets::get`, whose
//! `#[cfg(feature = "compression")]` body runs `brotli::BrotliDecompress` into a freshly allocated
//! `Vec` — with NO cache, so a re-render storm that refetches the same assets pays a fresh
//! main-thread decompression each time. With the feature OFF, `get` returns a zero-copy
//! `Cow::Borrowed` slice and the compile-time codegen (`generate_context!`, gated by the SAME feature
//! through `tauri-macros` → `tauri-codegen`) embeds the bytes raw, so embed and serve stay consistent.
//!
//! The hazard is that this is a Cargo *feature*, invisible to the compiler and to every other test:
//! a `tauri` bump, or anyone re-adding `default-features`, silently restores the default and the
//! main-thread decompression returns with no signal. This is the exact shape the notify.m source
//! guard (PR #931) was written for — a which-thread/which-feature hazard no type can encode — so it
//! gets the same treatment: a source guard over the manifest that fails the build if compression
//! comes back.

#[cfg(test)]
mod tests {
    /// This crate's manifest, embedded at COMPILE time — the `include_str!` source-guard trick
    /// `project_window.rs` uses for its capability file, pointed at Cargo.toml.
    const MANIFEST: &str = include_str!("../Cargo.toml");

    /// EVERY declaration of the `tauri` crate itself, paired with the `[section]` it lives under —
    /// NOT `tauri-build` or `tauri-plugin-*`. Matched by the exact `tauri = {` prefix on a trimmed
    /// line, so `tauri-plugin-dialog = …` and friends cannot satisfy it.
    ///
    /// EVERY, not the first: returning only the first match was a real hole, not a theoretical one.
    /// A `[dev-dependencies]` entry added one screen below the production one sat entirely outside
    /// the guard, and since Cargo unifies dev-dependency features whenever a test target is built,
    /// it silently turned `compression` back on for every `cargo test` while the shipped binary kept
    /// it off (roborev 57742).
    ///
    /// WITH ITS SECTION, because the two assertions below need different scopes and position cannot
    /// supply either. `compression` must be off EVERYWHERE (a test build that enables it is exactly
    /// the bug above), whereas the renderer must be on the entry that ships. Selecting the latter by
    /// index, or by counting entries that carry it, both get this wrong in the direction that
    /// matters — see `the_tauri_dependency_disables_asset_compression`.
    fn tauri_dependency_entries(manifest: &str) -> Vec<(String, &str)> {
        let mut section = String::new();
        let mut entries = Vec::new();
        for line in manifest.lines().map(str::trim) {
            if line.starts_with('[') && line.ends_with(']') {
                section = line.trim_matches(['[', ']']).to_string();
            } else if line.starts_with("tauri = {") || line.starts_with("tauri = \"") {
                entries.push((section.clone(), line));
            }
        }
        assert!(!entries.is_empty(), "Cargo.toml must declare the `tauri` dependency");
        entries
    }

    /// Entries that must not exist: any `tauri` declaration that leaves `compression` on.
    ///
    /// TAKES THE MANIFEST, NOT THE ENTRY LIST, and that is the whole durability of it. When this
    /// took `&[(String, &str)]`, the SCOPE was the argument — decided independently at each call
    /// site — so narrowing the real caller to shipping entries only survived every test: the
    /// synthetic test passed its own full list and was untouched, and the real manifest's dev entry
    /// already complied. The roborev 57742 bug was readmitted with everything green, and the
    /// comment claiming otherwise was worse than no comment, since the next reader takes it as
    /// covered. Selecting the entries INSIDE the predicate is what makes the scope unforgeable.
    fn compression_offenders(manifest: &str) -> Vec<(String, &str)> {
        tauri_dependency_entries(manifest)
            .into_iter()
            .filter(|(_, l)| !l.contains("default-features = false") || l.contains("compression"))
            .collect()
    }

    /// Does the SHIPPED build carry the renderer?
    ///
    /// Requires an unconditional `[dependencies]` entry that names `wry`. Deliberately NOT a
    /// cleverer rule, and the history of this one assertion is why — three richer versions were
    /// each wrong on a manifest they were meant to accept or reject:
    ///
    ///   * `lines[0]` assumed position established "the production entry". Index 0 moves the moment
    ///     anything is declared above `[dependencies]`.
    ///   * counting entries carrying `wry` assumed features unify across all entries. They do not
    ///     for a release build — `cargo build --release` never compiles `[dev-dependencies]` — so a
    ///     production entry that LOST `wry` while a dev entry gained it read as compliant.
    ///   * a union over everything that ships, then `all` over it, assumed target blocks are
    ///     mutually exclusive per platform. They are NOT: this crate declares both
    ///     `cfg(target_os = "macos")` and `cfg(unix)`, and BOTH apply on macOS. Cargo unions the
    ///     features of every block whose `cfg` matches, so `any` fails quiet (one platform's block
    ///     satisfying the check for all) and `all` fails LOUD on the perfectly valid shape of
    ///     factoring shared features into `cfg(unix)` and platform-specific ones beside it.
    ///
    /// Judging the third case correctly needs a `cfg`-expression evaluator mapping each block to the
    /// platforms it applies to — real machinery, inside a test, to guard one feature flag. So this
    /// asks the narrower question it can actually answer. The cost is that restructuring to a purely
    /// platform-scoped `tauri` declaration fails here; that is the intended trade, because such a
    /// change should come back to this guard deliberately rather than be silently mis-judged in
    /// either direction.
    fn a_shipping_entry_has_the_renderer(manifest: &str) -> bool {
        tauri_dependency_entries(manifest)
            .iter()
            .any(|(section, line)| section == "dependencies" && line.contains("\"wry\""))
    }

    /// THE HELPER'S OWN REPAIR, PINNED.
    ///
    /// The behavioural fix was filter-all rather than find-first, and nothing tested it: the only
    /// caller reads the REAL manifest, which is now clean, so reverting the helper to `.find(...)`
    /// left the guard green. A hand-revert check at the time is not durable — the next person to
    /// touch this file gets no signal. A synthetic manifest pins the behaviour independently of
    /// whatever the real one currently says.
    #[test]
    fn every_tauri_entry_is_found_with_its_section() {
        const SYNTHETIC: &str = r#"
[dependencies]
tauri = { version = "2", default-features = false, features = ["wry"] }
tauri-plugin-dialog = "2"

[target.'cfg(target_os = "macos")'.dependencies]
tauri = { version = "2", default-features = false, features = ["macos-private-api"] }

[build-dependencies]
tauri-build = { version = "2" }

[dev-dependencies]
tempfile = "3"
tauri = { version = "2", features = ["test"] }
"#;
        let entries = tauri_dependency_entries(SYNTHETIC);
        assert_eq!(entries.len(), 3, "every entry must be seen, not just the first: {entries:?}");

        // `tauri-plugin-*` and `tauri-build` must not be mistaken for the crate itself.
        assert!(entries.iter().all(|(_, l)| !l.contains("tauri-plugin")));
        assert!(entries.iter().all(|(_, l)| !l.contains("tauri-build")));

        // THE SECTIONS THEMSELVES, in order. `entries.len()` is section-blind, so on its own it
        // cannot see a section mis-attributed to the wrong header — and the `[target.…]` shape is
        // the one no other assertion in this file observes: skipping that header in the loop above
        // would file the macOS entry under `dependencies`, leaving the count at 3, the dev entry
        // present, `compression_offenders` at exactly one hit, and both real-manifest assertions
        // untouched. Naming the sections is what makes that mutation red.
        //
        // It also states what the two rules actually need, which is NOT the same thing for each:
        // `compression_offenders` reads only the LINE, so it covers the dev entry by virtue of the
        // entry existing at all; the renderer rule selects on the SECTION STRING, so what excludes
        // the dev entry is that its section is not `dependencies`.
        assert_eq!(
            entries.iter().map(|(s, _)| s.as_str()).collect::<Vec<_>>(),
            vec![
                "dependencies",
                "target.'cfg(target_os = \"macos\")'.dependencies",
                "dev-dependencies",
            ],
            "each entry must carry the section it was declared under: {entries:?}"
        );

        // Through the SHARED predicate, so narrowing the real call site (e.g. to shipping entries
        // only) turns THIS red — the failure mode roborev 57748 identified, where each test
        // computed its own copy and only the helpers were pinned.
        let offenders = compression_offenders(SYNTHETIC);
        assert_eq!(offenders.len(), 1, "the dev entry is the violation: {entries:?}");
        assert_eq!(offenders[0].0, "dev-dependencies");
    }

    /// THE BELT CLAUSE, PINNED SEPARATELY.
    ///
    /// `compression_offenders` is two clauses ORed: defaults left on, or `compression` named
    /// explicitly. Every other fixture only ever exercises the first, because an entry that
    /// re-enables the feature by name still carries `default-features = false` and is therefore
    /// already an offender by the other clause. So deleting `|| l.contains("compression")` left the
    /// whole suite green while removing the exact detection this module exists for: a manifest
    /// reading `default-features = false, features = ["wry", "compression"]` opts out of the
    /// defaults, opts `compression` back IN, and restores per-request main-thread brotli
    /// decompression — with the guard reporting clean (roborev 57771).
    ///
    /// A separate fixture rather than a fourth `SYNTHETIC` entry, so the ordered section list above
    /// keeps testing entry attribution and this keeps testing the predicate.
    #[test]
    fn re_enabling_compression_by_name_is_an_offender_even_with_defaults_off() {
        const COMPRESSION_RE_ENABLED: &str = r#"
[dependencies]
tauri = { version = "2", default-features = false, features = ["wry", "compression"] }
"#;
        let offenders = compression_offenders(COMPRESSION_RE_ENABLED);
        assert_eq!(
            offenders.len(),
            1,
            "naming `compression` re-enables it despite the opt-out: {offenders:?}"
        );
        assert_eq!(offenders[0].0, "dependencies");

        // ...and the same entry WITHOUT that feature is clean, so the assertion above is about the
        // `compression` token and not about the rest of the line.
        const CLEAN: &str = r#"
[dependencies]
tauri = { version = "2", default-features = false, features = ["wry"] }
"#;
        assert!(compression_offenders(CLEAN).is_empty());
    }

    /// A renderer on a NON-shipping entry must not satisfy the guard.
    ///
    /// This is the asymmetry that makes section-tracking necessary rather than merely tidier.
    /// Counting entries that carry `"wry"` reads this manifest as compliant — one entry has it — but
    /// `cargo build --release` never compiles `[dev-dependencies]`, so the shipped binary has no
    /// webview runtime at all. Dev-dependency features unify only when a TEST target is built, which
    /// is precisely why the shipped and tested feature sets can diverge here.
    #[test]
    fn a_renderer_on_a_dev_entry_does_not_count_as_shipping_one() {
        const RENDERER_IN_THE_WRONG_SECTION: &str = r#"
[dependencies]
tauri = { version = "2", default-features = false, features = ["dynamic-acl"] }

[dev-dependencies]
tauri = { version = "2", default-features = false, features = ["wry", "test"] }
"#;
        assert!(
            !a_shipping_entry_has_the_renderer(RENDERER_IN_THE_WRONG_SECTION),
            "the renderer is only on a dev entry, so nothing that ships carries it"
        );
        // ...whereas a bare count over all entries would wrongly read this as compliant.
        let entries = tauri_dependency_entries(RENDERER_IN_THE_WRONG_SECTION);
        assert_eq!(entries.iter().filter(|(_, l)| l.contains("\"wry\"")).count(), 1);
    }

    /// A renderer that is only ever declared per-platform does not satisfy this guard.
    ///
    /// Deliberate and documented (see `a_shipping_entry_has_the_renderer`): judging that shape
    /// correctly needs a `cfg`-expression evaluator, because target blocks are NOT mutually
    /// exclusive — this crate has both `cfg(target_os = "macos")` and `cfg(unix)`, and both apply on
    /// macOS. Rather than guess in either direction, the guard asks the narrower question, so
    /// restructuring the manifest that way has to come back here on purpose.
    #[test]
    fn a_renderer_declared_only_per_platform_does_not_satisfy_the_guard() {
        const ONLY_TARGET_BLOCKS: &str = r#"
[target.'cfg(target_os = "macos")'.dependencies]
tauri = { version = "2", default-features = false, features = ["wry"] }

[target.'cfg(windows)'.dependencies]
tauri = { version = "2", default-features = false, features = ["wry"] }
"#;
        assert!(!a_shipping_entry_has_the_renderer(ONLY_TARGET_BLOCKS));
    }

    #[test]
    fn the_tauri_dependency_disables_asset_compression() {
        let entries = tauri_dependency_entries(MANIFEST);
        let render = |es: &[(String, &str)]| {
            es.iter().map(|(s, l)| format!("[{s}] {l}")).collect::<Vec<_>>().join("\n  ")
        };

        // `compression` must be off on EVERY entry, including non-shipping ones: a
        // `[dev-dependencies]` entry with defaults on turns it back on for every `cargo test`
        // (dev-dependency features unify into the crate whenever a test target is built), so the
        // suite stops exercising the feature set that ships. That is what roborev 57742 caught.
        //
        // The default feature set includes `compression`, and the only way to drop one default
        // member is to opt out of the defaults and re-list the rest — so `default-features = false`
        // is the check, with an explicit `compression` as the belt.
        let offenders = compression_offenders(MANIFEST);
        assert!(
            offenders.is_empty(),
            "every `tauri` entry must set `default-features = false` and must not re-enable \
             `compression` — it makes every embedded-asset fetch brotli-decompress on the main \
             thread. Offending entries:\n  {}",
            render(&offenders)
        );

        // The renderer is a default feature too; dropping it with the defaults would silently break
        // every webview. Asserting it is kept pins the INTENT ("defaults minus compression") rather
        // than merely "some feature was removed", and proves the opt-out did not throw out wry.
        //
        // Three earlier versions of this assertion got its SCOPE wrong, each in a way that was green
        // on the manifest of the day:
        //   * `lines[0]` assumed position established "the production entry". It does not;
        //     `[dependencies]` does, and index 0 moves the moment anything is declared above it.
        //   * counting entries carrying `"wry"` assumed features unify across all entries. They do
        //     NOT for a release build — `cargo build --release` never compiles `[dev-dependencies]`
        //     — so a production entry that LOST `wry` while a dev entry gained it read as compliant.
        //   * the union of everything that ships ignored that a `[target.…]` block is
        //     platform-conditional, so `wry` in the windows-only block passed while macOS and Linux
        //     shipped with no webview runtime.
        assert!(
            a_shipping_entry_has_the_renderer(MANIFEST),
            "the unconditional `[dependencies]` entry must carry the `wry` feature — without it \
             the built app has no webview at all.\n\
             A `[dev-dependencies]` entry carrying it does NOT satisfy this: `cargo build \
             --release` never compiles dev-dependencies.\n\
             A purely platform-scoped `tauri` declaration is REJECTED here, deliberately rather \
             than silently accepted — judging it needs a cfg-expression evaluator (target blocks \
             overlap; this crate has both `cfg(target_os = \"macos\")` and `cfg(unix)`). If that \
             restructuring is what you intend, update `a_shipping_entry_has_the_renderer` as part \
             of it.\n\
             Entries were:\n  {}",
            render(&entries)
        );
    }
}
