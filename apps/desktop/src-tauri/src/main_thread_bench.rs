//! The before/after measurement behind the `sparkle-rfhu5` conversions.
//!
//! ── WHAT THIS MEASURES, AND WHY THE NUMBER IS THE RIGHT ONE ───────────────────────────────────
//! A synchronous `#[tauri::command]` body runs INLINE on the AppKit main thread (tauri-macros
//! `command/wrapper.rs` sends a plain `fn` to `body_blocking`; confirmed live by the `sample(1)`
//! dumps in `~/Library/Logs/ai.sparkle.desktop/hangs/`, whose main-thread stacks carry
//! `tauri::ipc::protocol::get → Webview::on_message`). So for a sync command:
//!
//!     main-thread block per call  ==  wall time of the body
//!
//! That identity is what makes this harness a measurement of UI freeze rather than a microbenchmark
//! of some unrelated function. After a command is moved to `async` + `spawn_blocking`, the main
//! thread retains only the prelude (argument validation + the submit), which is what the "after"
//! column measures — so the two columns are the same quantity before and after the change, not two
//! different quantities compared by analogy.
//!
//! ── WHY IT IS `#[ignore]` ─────────────────────────────────────────────────────────────────────
//! It reads real devices, spawns real subprocesses, and touches the real log tree, so its numbers
//! are machine- and moment-specific — an assertion on them would be a flake generator. It is a
//! reporting instrument, run deliberately:
//!
//!     cargo test --lib main_thread_bench -- --ignored --nocapture
//!
//! The regression guard that DOES run in CI is `cmd_timing::main_thread_guard`, which asserts the
//! conversions are still in place. This file proves they were worth making; that one keeps them.

#![cfg(test)]

use std::time::{Duration, Instant};

/// Run `f` `n` times and return (median, max). Median rather than mean: one page-in or one
/// scheduler preemption should not set the headline number, and the tail is reported separately
/// anyway — the max is the freeze a user actually notices.
fn timed<T>(n: usize, mut f: impl FnMut() -> T) -> (Duration, Duration) {
    let mut samples: Vec<Duration> = Vec::with_capacity(n);
    for _ in 0..n {
        let t0 = Instant::now();
        let out = f();
        samples.push(t0.elapsed());
        // Keep the result alive so the optimizer cannot delete the work being measured.
        std::hint::black_box(&out);
    }
    samples.sort();
    (samples[samples.len() / 2], *samples.last().expect("n > 0"))
}

fn us(d: Duration) -> u128 {
    d.as_micros()
}

fn row(name: &str, calls: &str, before: (Duration, Duration), after: (Duration, Duration)) {
    println!(
        "| `{name}` | {calls} | {} | {} | {} | {} |",
        us(before.0),
        us(before.1),
        us(after.0),
        us(after.1)
    );
}

/// The cost the main thread now pays for a converted command: validate + hand to the blocking pool.
///
/// Uses `tauri::async_runtime::spawn_blocking` — the exact call the conversions make — rather than a
/// hand-built runtime. It lazily initializes the same global Tokio runtime the app uses
/// (`RUNTIME.get_or_init(default_runtime)`), so this is the real submit path, not a stand-in.
fn submit_cost(n: usize) -> (Duration, Duration) {
    // Warm the lazy runtime first: its one-time construction is not a per-call cost and would
    // otherwise land entirely in the first sample and distort the max.
    let _ = tauri::async_runtime::spawn_blocking(|| 0u8);
    timed(n, || {
        // The main thread's whole remaining involvement: create the task and hand it over. We do
        // NOT await here — awaiting would measure end-to-end latency, which is not main-thread
        // occupancy and would flatter the "before" column by comparison.
        let h = tauri::async_runtime::spawn_blocking(|| std::hint::black_box(1u8));
        std::mem::drop(h);
    })
}

#[test]
#[ignore = "measurement harness: real devices/subprocesses/filesystem; run explicitly"]
fn measure_main_thread_offload() {
    let after = submit_cost(200);

    println!("\n## Main-thread block time per call — before vs after\n");
    println!("Machine: {} {}", std::env::consts::OS, std::env::consts::ARCH);
    println!(
        "\n| command | what drives it | before p50 (µs) | before max (µs) | after p50 (µs) | after max (µs) |"
    );
    println!("|---|---|---|---|---|---|");

    // ── 1. list_audio_inputs — CoreAudio HAL enumeration ──────────────────────────────────────
    let before = timed(10, crate::audio_devices::list_input_devices);
    row("list_audio_inputs", "settings pane open", before, after);

    // ── 2. stale_build_probe — two subprocess fork/exec+wait pairs ─────────────────────────────
    // Measured through the same two commands the real `probe()` shells out to. `probe()` itself
    // needs an AppHandle, which does not exist outside a running app; these ARE its blocking half.
    #[cfg(target_os = "macos")]
    {
        let before = timed(10, || {
            let _ = std::process::Command::new("/usr/bin/defaults")
                .args(["read", "/Applications/Sparkle.app/Contents/Info.plist", "CFBundleShortVersionString"])
                .output();
            let pid = std::process::id().to_string();
            let _ = std::process::Command::new("/bin/ps").args(["-o", "etimes=", "-p", &pid]).output();
        });
        row("stale_build_probe", "hourly timer + every refocus", before, after);
    }

    // ── 3. read_events_since — the 500ms-per-pane poll ─────────────────────────────────────────
    // Against a synthesized log of a realistic size rather than the user's own tree, so the number
    // is reproducible and no private content is read.
    let dir = std::env::temp_dir().join(format!("-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let log = dir.join("agent.jsonl");
    {
        use std::io::Write as _;
        let mut f = std::fs::File::create(&log).expect("create bench log");
        for i in 0..5_000 {
            let _ = writeln!(f, "{{\"seq\":{i},\"event\":\"PostToolUse\",\"tool\":\"Bash\"}}");
        }
    }
    let log_s = log.to_string_lossy().into_owned();
    let before = timed(20, || {
        crate::hooks::read_events_since_confined(&dir, &log_s, 0, false)
    });
    row("read_events_since", "every 500ms PER agent pane", before, after);

    // ── 4. history_* — SQLite WAL + FTS5 ───────────────────────────────────────────────────────
    let hdir = dir.join("h");
    let _ = std::fs::create_dir_all(&hdir);
    if let Ok(db) = crate::history::HistoryDb::new(&hdir) {
        let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
        // Seed a corpus so search/prune have something realistic to chew on.
        let mut seq = 0u64;
        let mut mk = |seq: u64| crate::history::EntryInput {
            id: format!("bench-{seq}"),
            kind: "prompt".into(),
            source: "build".into(),
            project_id: Some("p".into()),
            agent_id: Some("a".into()),
            project_name: Some("sparkle".into()),
            agent_name: Some("bench".into()),
            text: format!(
                "entry {seq} main thread command offload measurement corpus with enough words to \
                 exercise the fts5 tokenizer rather than a toy string"
            ),
            created_at: 1_700_000_000_000 + seq as i64,
        };
        for i in 0..2_000u64 {
            let _ = crate::history::record_into(&conn, &mk(i));
        }
        seq = 10_000;
        let before = timed(50, || {
            seq += 1;
            crate::history::record_into(&conn, &mk(seq))
        });
        row("history_record", "every prompt + response", before, after);

        let before = timed(20, || crate::history::search_in(&conn, "tokenizer", 50));
        row("history_search", "user search", before, after);

        // Prune is measured on a populated table: the expensive case is the first run on a
        // long-lived install, not the steady-state no-op.
        let before = timed(1, || crate::history::prune_in(&conn, Some(1_700_000_001_000)));
        row("history_prune", "setInterval from main.tsx", before, after);
    }

    let _ = std::fs::remove_dir_all(&dir);

    println!(
        "\n`after` is the same for every row because the main thread's remaining work is identical \
         — validate arguments, hand the closure to the blocking pool — regardless of what the body \
         then does off-thread.\n"
    );
}
