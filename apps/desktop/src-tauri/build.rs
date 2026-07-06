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
    // Both MCP server bundles get the same cold-clone-determinism treatment. The orchestrator's
    // real bundle is staged by scripts/copy-mcp-server.mjs (pnpm pre(dev|build)); the control
    // server's real bundle is produced by apps/mcp-control and MUST be staged into
    // resources/mcp-control-server.js by the same/an equivalent copy hook (see TODO below). Both
    // resource paths are gitignored, so these stubs cause no git churn.
    //
    // TODO(sparkle-control staging): resources/mcp-control-server.js has NO copy hook yet. The real
    // artifact must be produced by `apps/mcp-control` (built as `pnpm --filter @sparkle/mcp-control
    // build` → dist/server.js) and copied into apps/desktop/src-tauri/resources/mcp-control-server.js
    // by extending apps/desktop/scripts/copy-mcp-server.mjs (or adding a sibling copy script wired
    // into the same predev/prebuild hooks). That file lives in apps/desktop/scripts which is OUTSIDE
    // this worker's file-ownership, so it could not be wired here. Until that lands, `tauri dev`
    // resolves this fail-loud stub at runtime and `tauri build` would BUNDLE the stub — the copy
    // hook must overwrite it first, exactly like the orchestrator server.
    for (resource_rel, label) in [
        ("resources/mcp-orchestrator-server.js", "mcp-orchestrator-server.js"),
        ("resources/mcp-control-server.js", "mcp-control-server.js"),
    ] {
        let resource = Path::new(resource_rel);
        if !resource.exists() {
            if let Some(parent) = resource.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(
                resource,
                format!(
                    "// placeholder — real {label} bundle is produced by the pnpm pre(dev|build) copy \
                     hook (scripts/copy-mcp-server.mjs and its control-server equivalent)\nprocess.exit(1);\n"
                ),
            );
            // Fail loud in build logs. For `tauri dev` the resource is disk-resolved at runtime, so the
            // copy hook overwrites this stub before use. But `tauri build` EMBEDS bundle.resources at
            // compile time, so if cargo wins the race against the pnpm prebuild hook this stub could be
            // packaged — shipping the fail-loud `process.exit(1)` instead of the real server. Surfacing
            // it here makes a stub-bundled production build visible (the stub also exits non-zero at run).
            println!(
                "cargo:warning={label} was missing; wrote a fail-loud placeholder. \
                 A production `tauri build` must run the pnpm prebuild copy hook first \
                 or it will bundle the stub instead of the real server."
            );
        }
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

    // bnvs (sparkle-bnvs): embed the git SHA of the source this binary was built from so the
    // running app can report which build is live (the orchestration bridge exposes it via the
    // `bridge_info` op and augments list_workers with `runningSha`). The running app embeds the
    // MCP/bridge and does NOT hot-reload, so a fix on main isn't live until an app restart — this
    // SHA is the signal that lets a developer/orchestrator notice the running build is stale.
    // Best-effort: an unavailable git (e.g. a tarball build) yields "unknown" rather than failing.
    let sha = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=SPARKLE_GIT_SHA={sha}");
    // Rebuild when HEAD moves so the embedded SHA stays honest across commits/checkouts.
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    println!("cargo:rerun-if-changed=../../.git/refs/heads");

    tauri_build::build()
}
