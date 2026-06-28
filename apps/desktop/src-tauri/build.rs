use std::path::Path;

fn main() {
    // Cold-clone determinism: tauri-build validates every `bundle.resources` entry exists at
    // COMPILE time, and the Tauri CLI runs cargo in PARALLEL with `beforeDevCommand`/`predev`.
    // So on a fresh clone the `predev`/`prebuild` copy hook (which builds + copies the real
    // 716KB server.js) may not have finished — or even started — when build.rs runs, and the
    // resource validation would fail. Ensure a placeholder exists so the validation always
    // passes. The real artifact is produced by `node scripts/copy-mcp-server.mjs` (run by the
    // pnpm pre(dev|build) hooks) and overwrites this stub before the app is actually used. The
    // path is gitignored, so the stub causes no git churn.
    // KNOWN, ACCEPTED TOCTOU: the exists()-check and the write() below are not atomic, so in
    // principle the parallel copy hook could finish writing the real 716KB artifact in the window
    // between them and have it clobbered by the stub. The window is microseconds wide and the copy
    // hook (which first runs a ~700ms tsup build) in practice completes long after build.rs's
    // instantaneous check+write, so a clobber would require the hook to land in that exact gap. If
    // it ever did, the stub fails loud (process.exit(1) at runtime + the cargo:warning below), so
    // the failure is detectable rather than silent — not worth a partial size-threshold guard that
    // still wouldn't close the gap.
    let resource = Path::new("resources/mcp-orchestrator-server.js");
    if !resource.exists() {
        if let Some(parent) = resource.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(
            resource,
            "// placeholder — real mcp-orchestrator bundle is produced by \
             scripts/copy-mcp-server.mjs (pnpm pre(dev|build) hook)\nprocess.exit(1);\n",
        );
        // Fail loud in build logs. For `tauri dev` the resource is disk-resolved at runtime, so the
        // copy hook overwrites this stub before use. But `tauri build` EMBEDS bundle.resources at
        // compile time, so if cargo wins the race against the pnpm prebuild hook this stub could be
        // packaged — shipping the fail-loud `process.exit(1)` instead of the 716KB server. Surfacing
        // it here makes a stub-bundled production build visible (the stub also exits non-zero at run).
        println!(
            "cargo:warning=mcp-orchestrator-server.js was missing; wrote a fail-loud placeholder. \
             A production `tauri build` must run `pnpm prebuild` (scripts/copy-mcp-server.mjs) first \
             or it will bundle the stub instead of the real server."
        );
    }

    // macOS only: compile the tiny ObjC category that forces Notification Center banners to
    // present even when Sparkle is frontmost (see objc/force_present.m). Gate on the TARGET os
    // (build.rs itself runs on the host) so a non-macOS target build skips it cleanly.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=objc/force_present.m");
        // The NSUserNotification deprecation warning is silenced in-file via a #pragma in
        // force_present.m (survives independent of these build flags), so no -Wno flag here.
        cc::Build::new()
            .file("objc/force_present.m")
            .flag("-fobjc-arc")
            .compile("sparkle_notify_present");
        // Foundation is already linked transitively, but make the category's dependency explicit.
        println!("cargo:rustc-link-lib=framework=Foundation");
    }

    tauri_build::build()
}
