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

    /// The single `[dependencies]` line declaring the `tauri` crate itself — NOT `tauri-build`,
    /// `tauri-plugin-*`, or a `[target.…]` entry. Matched by the exact `tauri = {` prefix on a
    /// trimmed line, so `tauri-plugin-dialog = …` and friends cannot satisfy it.
    fn tauri_dependency_line(manifest: &str) -> &str {
        manifest
            .lines()
            .map(str::trim)
            .find(|l| l.starts_with("tauri = {") || l.starts_with("tauri = \""))
            .expect("Cargo.toml must declare the `tauri` dependency")
    }

    #[test]
    fn the_tauri_dependency_disables_asset_compression() {
        let line = tauri_dependency_line(MANIFEST);

        // The default feature set includes `compression`; the only way to drop one default member is
        // to opt out of the defaults and re-list the rest. Without this, `compression` is ON however
        // the feature list reads.
        assert!(
            line.contains("default-features = false"),
            "the `tauri` dependency must set `default-features = false` — otherwise the default \
             `compression` feature is active and every embedded-asset fetch brotli-decompresses on \
             the main thread. Line was:\n  {line}"
        );

        // Belt: even with defaults off, nothing may add `compression` back explicitly.
        assert!(
            !line.contains("compression"),
            "the `tauri` dependency must NOT enable the `compression` feature — it reintroduces \
             per-request main-thread brotli decompression of embedded assets. Line was:\n  {line}"
        );

        // The renderer is a default feature too; dropping it with the defaults would silently break
        // every webview. Asserting it is kept pins the INTENT ("defaults minus compression") rather
        // than merely "some feature was removed", and proves the opt-out did not throw out wry.
        assert!(
            line.contains("\"wry\""),
            "the `tauri` dependency must keep the `wry` feature after opting out of defaults — \
             without it there is no webview at all. Line was:\n  {line}"
        );
    }
}
