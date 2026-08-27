mod account_ledger;
mod account_usage;
mod accounts;
mod adversarial_review;
mod agent_goal_record;
mod agent_life;
mod ai;
/// The native menu bar. Carries "View → Hide/Show Helper", which is the guaranteed way back for a
/// dismissed helper island — the menu bar is the one surface that cannot itself be hidden.
mod app_menu;
mod overlay_tray;
mod asset_serving;
mod attachments;
mod attention;
mod attention_summary;
mod audio;
mod audio_devices;
mod auth;
mod auto_send_tuner;
/// The durable one-driver-per-PR lease behind auto-dispatch of `/babysit-pr` (bead sparkle-5gxom).
/// NOT `pr_claims` — that is explicitly a courtesy, not a lock. See the module docs.
mod babysit_lease;
/// File-time duplicate detection for the app's own `bd create` paths, and — the part that matters —
/// the ARGV-LEVEL SKIP LIST that keeps it away from the auto-filed beads a fold would corrupt.
/// See `docs/bead-dedupe-contract.md` §6 and the module docs.
mod bead_dup;
mod beads_cmd;
mod epic_prd;
/// Recovering the paths of a drag whose Tauri event carried none — wry reads only the deprecated
/// `NSFilenamesPboardType`, so a modern-only drag source drops silently. See the module docs.
mod drag_paths;
mod drag_watch;
/// Opt-in tokenmaxxing (Builder Index) reporting — default-off, consent-gated (bead sparkle-s3g2.6).
mod builder_index;
mod straude;
// The orchestration bridge is built on a Unix-domain socket (std::os::unix::net), so the real
// implementation is Unix-only. On Windows we compile a stub with the same public surface
// (BridgeManager + the four tauri commands) that reports the feature as unavailable; porting the
// transport to a Windows named pipe / localhost TCP is a Phase-2 follow-up (see the Windows port
// design doc). lib.rs and every caller stay platform-agnostic.
#[cfg(unix)]
mod bridge;
#[cfg(not(unix))]
#[path = "bridge_windows.rs"]
mod bridge;
mod capture_window;
mod chief;
mod claude;
mod claude_chat;
/// Derives the key Claude Code looks folder-trust up under — the main repo root for a linked
/// worktree, NOT the worktree path. See the module header and bead `sparkle-ubee5u`.
mod claude_trust;
/// One-shot text inference on the user's own Claude Code subscription, via their authenticated
/// `claude` CLI. Replaces the server-side `/ai/anthropic` proxy that `ai.rs` used to own.
mod claude_oneshot;
mod cloud;
mod cmd_timing;
mod crash;
mod ipc_ring;
mod ipc_trace;
mod config;
mod connectivity;
mod delivery;
mod demotion;
mod deps_bootstrap;
mod dev_identity;
mod dev_port_preflight;
mod dictation;
mod display_span;
mod drainer;
mod fleet;
mod gh_rest;
mod goal_landed_probe;
mod folder_picker;
mod frontmost;
mod github;
mod history;
mod helper;
mod hooks;
mod humanebench_vendor;
/// The identity-epoch ledger backing `accounts.rs`' identity-keyed ceilings.
mod identity_log;
mod inbox;
mod integration_assistant;
mod judge;
mod key_window;
mod knightwatch;
mod logging;
mod mac_panel;
mod main_thread_bench;
mod main_window;
mod memwatch;
mod mic_permission;
mod model;
mod model_catalog;
mod naming;
mod onepassword;
mod peak_concurrency;
/// Runtime arbitration for parallel agents: machine-wide port LEASES for ports that can move, and
/// named gate LOCKS for the ones that cannot (bead `.5`).
mod port_broker;
mod pr_claims;
mod pr_dismissal;
mod pr_owner;
mod retro_receipt;
mod preflight;
/// The live in-app browser preview's dev-server supervisor.
mod preview;
/// Preview "agent eyes" — headless-browser screenshot + DOM query over an already-open preview.
/// Phase 3 of `docs/live-browser-preview.md`; additive to `preview`, never touches its registry.
mod preview_capture;
/// Guard pinning the loopback `frame-src` the live browser preview depends on, plus the reserved
/// port set that keeps a preview frame from being same-origin with the app document.
mod preview_csp;
mod proc;
mod promotion;
mod project_window;
mod pty;
mod pty_write_watch;
/// The publish destination's CAPABILITY PROBE (bead `sparkle-131ms.5`) — a pure diff of the
/// destination's `tools/list` against the contract Sparkle pins, plus the commands that expose it.
mod publish_capabilities;
/// The publish destination's MCP client — the outbound JSON-RPC calls and the HTTP-200
/// `isError` decoder that keeps a failed publish from reading as a successful one.
mod publish_client;
/// The publish destination's bearer token, in the OS keychain (bead `sparkle-131ms.3`).
mod publish_credential;
/// Publish-destination URL validation — TLS required, loopback exempt, no userinfo.
mod publish_url;
mod redacting_writer;
mod repo_freshness;
/// The background research runner behind "Concierge Agents" (bead `sparkle-s7rfc`) — dispatches a
/// read-only `claude` child and returns before it finishes.
mod research;
mod retention;
mod revival;
mod pipeline_health;
// The false-absence contract (bead `sparkle-gazo4a`): a probe that could not look must never be
// worded as an absence. `pipeline_health` is its first consumer.
mod probe_outcome;
mod review_cmd;
mod roborev_account;
mod roborev_probe;
mod transcribe;
mod screenshot;
mod window_screenshot;
mod setup;
mod socket;
mod sparkle_agent;
mod sparkle_improve;
mod spend;
mod stale_build;
mod steering;
mod teardown_guard;
mod ticket_intake;
mod support;
mod transcript;
mod roster;
mod trial;
mod trial_remote;
mod verify_gate;
mod watchdog;
mod worktree;
mod notes;
mod nudge_gate;
mod nudge_ladder;
mod nudger;
// The mount-independent attention verdict (bead: invisible-green-attention). Same split as
// the nudger above: `observed_attention` is the pure classification + the wire shape, and
// `nudger`'s existing per-second tick is the only thing that owns a screen to classify.
mod observed_attention;
// The deterministic conflicting/stale-PR detector (bead sparkle-zss67). Same two-file split as the
// nudger above and for the same reason: `conflict_ladder` is the pure decision, `conflict_watch`
// owns the thread, the `gh` probe and the flags. Neither makes a model call on any path.
mod conflict_ladder;
mod conflict_watch;
mod concierge;
mod concierge_guidelines;
mod concierge_inbox;
mod mention;
mod concierge_lint_log;
mod webview_drop_gate;
/// Keeps WebKit's `localStorage` SQLite WAL from growing unbounded (`sparkle-i061ug`) by owning the
/// `PRAGMA wal_checkpoint(TRUNCATE)` WebKit failed to complete on its own.
mod webkit_localstorage;

use pty::PtyManager;
use tauri::{Emitter, Manager};

/// Set once the frontend has completed its first `show()` on first paint (see main.tsx). The
/// show-on-ready backstop thread reads this to distinguish "frontend never booted" (show it) from
/// "frontend showed it, then the user hid it to the tray" (leave it hidden). See the setup hook.
static FRONTEND_SHOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Invoked by the frontend right after it reveals the main window on first paint. Marks the
/// show-on-ready handshake complete so the Rust last-resort backstop stands down.
#[tauri::command]
fn notify_frontend_shown() {
    FRONTEND_SHOWN.store(true, std::sync::atomic::Ordering::SeqCst);
}

// ── INSTALL THE STAGED UPDATE AT QUIT, NOT HOURS BEFORE IT (bead sparkle-1ueh3) ─────────────────
//
// `services/updaterService.ts` now DOWNLOADS an update at check time and installs it only when the
// process is about to stop running, because tauri-plugin-updater's macOS install DELETES the bundle
// the live process was launched from (`updater.rs:1255-1302`: rename aside → remove_dir_all →
// rename in → touch). macOS keys a TCC microphone grant to the bundle's signing identity AT ITS
// PATH, so that swap silently and permanently kills the running process's microphone — 43 fault
// events over six days, zero recoveries, every cluster ending in a restart onto a higher version.
// This module is the Rust half of the fix: it holds the exit open long enough for the webview to
// install, then lets the process go.
//
// WHICH QUITS THIS ACTUALLY COVERS — read out of the locked crate sources rather than assumed.
// `RunEvent::ExitRequested` is emitted from exactly TWO sites in tauri-runtime-wry 2.11.3
// (`src/lib.rs:4316` last-window-destroyed, `:4356` `Message::RequestExit` — i.e. `AppHandle::exit`
// and `restart`). The macOS ⌘Q / app-menu Quit reaches NEITHER: muda maps the predefined Quit item
// to `sel!(terminate:)` (muda-0.19.3 `src/platform_impl/macos/mod.rs:994`), and tao's macOS app
// delegate implements only `applicationWillTerminate:` (tao-0.35.3
// `src/platform_impl/macos/app_delegate.rs:131`) — there is no `applicationShouldTerminate:` — so
// that path arrives as `Event::LoopDestroyed` → `RunEvent::Exit`, which is not preventable and is
// far too late to await an async install. —— CHANGE D: `app_menu.rs` therefore REPLACES that
// predefined Quit item on macOS with a custom one whose handler calls `AppHandle::exit`, so ⌘Q
// lands on `Message::RequestExit` like everything else. Its ⌘Q header block is the contract, and it
// also names what still cannot be covered from anywhere (Force Quit, a system logout or restart, the
// Dock icon's own Quit — all `terminate:` or SIGKILL, neither interceptable without an
// `applicationShouldTerminate:` tao does not implement). —— So this covers ⌘Q and the app menu's
// Quit, and the helper island's "Quit Sparkle" (`roster::quit_app` → `AppHandle::exit`).
//
// LAST-WINDOW-DESTROYED IS **NOT** COVERED, and saying it was cost 5 seconds of hung app per quit.
// That `ExitRequested` is emitted from `TaoWindowEvent::Destroyed` (tauri-runtime-wry 2.11.3
// `src/lib.rs:4316`) AFTER the window has left the window map and only once `windows.is_empty()` —
// the webview is already gone, so `app.emit` reaches ZERO listeners and still returns `Ok(())`.
// Nothing ever acked, the `Err` arm never fired, and `prevent_exit()` held a windowless process for
// the whole `ACK_BUDGET_MS` while installing nothing at all. `should_defer_exit` now declines that
// exit outright: closing the last window with an update staged quits immediately and the update is
// DELAYED to the next launch, which is this module's designed failure mode.
//
// AND THAT IS SURVIVABLE, because failing to install is DELAYED, never BROKEN: nothing on disk was
// touched, so the next launch re-checks, re-downloads, and the banner's "Restart now" still works.
// The only cost is one repeated download.
//
// THE WATCHDOG IS TWO-PHASE, AND THAT IS THE WHOLE DESIGN. A single short timer would be WORSE than
// no timer: `install_inner` renames /Applications/Sparkle.app aside, `remove_dir_all`s it, and only
// then renames the new bundle in, so killing the process mid-install can leave the app GONE from
// disk. An unbounded wait, though, is a user who cannot quit their app — a far worse bug than the
// one this fixes. The two states are therefore separated: the webview must ACK quickly (it only has
// to run a listener callback), and the long budget is granted ONLY once it has said an install is
// actually running. Expiring the short phase is safe by construction — nothing has started.
mod updater_quit {
    use std::sync::atomic::{AtomicBool, Ordering};

    /// Emitted to the webview when we have deferred an exit. MUST match `INSTALL_BEFORE_EXIT_EVENT`
    /// in src/services/updaterService.ts — asserted by a test below, not merely by this comment.
    pub const INSTALL_BEFORE_EXIT_EVENT: &str = "updater://install-before-exit";

    /// How long the webview gets to report that it has STARTED installing. It only has to run a
    /// listener callback and one invoke, so this is generous for a live webview and short for a
    /// wedged one — and expiring here cannot corrupt anything, because no install has begun.
    pub const ACK_BUDGET_MS: u64 = 5_000;

    /// How long an install that HAS started gets before we exit regardless. Long on purpose: the
    /// alternative to waiting is killing a process that may be between `remove_dir_all` and the
    /// final rename. Reached only if the install neither resolves nor rejects.
    pub const INSTALL_BUDGET_MS: u64 = 120_000;

    static STAGED: AtomicBool = AtomicBool::new(false);
    static DEFERRED: AtomicBool = AtomicBool::new(false);
    static INSTALL_STARTED: AtomicBool = AtomicBool::new(false);
    /// Set immediately before each of the two SANCTIONED exits — the webview's
    /// `resume_exit_after_update`, and the watchdog's own `handle.exit(0)`. It is what tells the
    /// second-quit hold below "this ExitRequested is the one we asked for", so those two pass
    /// through while a user's second ⌘Q does not.
    static RESUMING: AtomicBool = AtomicBool::new(false);

    /// The webview telling us whether it is holding a downloaded update. With nothing staged we
    /// never prevent an exit, so an ordinary quit pays nothing at all.
    pub fn note_staged(staged: bool) {
        STAGED.store(staged, Ordering::SeqCst);
    }

    /// The webview telling us `Update.install()` is running RIGHT NOW — the signal that promotes
    /// the watchdog from the short ack budget to the long install budget.
    pub fn note_install_started() {
        INSTALL_STARTED.store(true, Ordering::SeqCst);
    }

    pub fn install_started() -> bool {
        INSTALL_STARTED.load(Ordering::SeqCst)
    }

    /// May THIS exit be deferred? True at most ONCE per process, and only while something is
    /// staged. The one-shot is what makes the resume — which re-enters `ExitRequested` by calling
    /// `AppHandle::exit` again — terminate instead of looping forever.
    pub fn claim_exit_deferral() -> bool {
        STAGED.load(Ordering::SeqCst) && !DEFERRED.swap(true, Ordering::SeqCst)
    }

    /// The whole deferral decision, INCLUDING the precondition the one-shot cannot express: there
    /// must still be a webview to receive `INSTALL_BEFORE_EXIT_EVENT`.
    ///
    /// WHY THE WEBVIEW GATE IS LOAD-BEARING, and why it is `&&`-FIRST so a windowless exit does not
    /// burn the one claim: one of the two sites that emit `ExitRequested` in tauri-runtime-wry
    /// 2.11.3 is `src/lib.rs:4316`, reached from `TaoWindowEvent::Destroyed` AFTER the window has
    /// left the window map and only once `windows.is_empty()`. The webview is already GONE there,
    /// so `app.emit(...)` reaches zero listeners and STILL returns `Ok(())` — the `Err` arm never
    /// fires, nothing ever acks, and `prevent_exit()` held a windowless process for the full
    /// `ACK_BUDGET_MS`. Net effect before this gate: closing the last window with an update staged
    /// installed NOTHING and cost 5 seconds of apparently-hung app. Declining to claim there is
    /// "update delayed", which is the failure mode this whole module is designed around.
    pub fn should_defer_exit(has_webview: bool) -> bool {
        has_webview && claim_exit_deferral()
    }

    /// Must THIS exit be held even though the deferral was already claimed?
    ///
    /// THE HAZARD THIS CLOSES. The deferral is one-shot, so before this existed only the FIRST exit
    /// request was ever held. The quit-time install produces no instant result — the window just
    /// sits there for the multi-second bundle swap — so the natural reaction is a second ⌘Q. That
    /// second press reaches the same always-enabled custom Quit item (`app_menu.rs`), gets `false`
    /// from `claim_exit_deferral`, and the process dies while `install_inner` is between its
    /// `remove_dir_all` and its final rename: /Applications/Sparkle.app DELETED. That is strictly
    /// worse than the bug this branch fixes.
    ///
    /// ALL THREE CONJUNCTS ARE SAFETY, NOT BELT-AND-BRACES:
    ///  - `DEFERRED` — hold only when someone is already ON THE HOOK to resume (the webview's
    ///    `resume_exit_after_update`, or the watchdog). Without it a sticky `INSTALL_STARTED` from
    ///    an earlier install could hold an exit that NOTHING would ever release, i.e. an app that
    ///    cannot be quit — the one outcome this module rates worse than a missed update.
    ///  - `INSTALL_STARTED` — before the webview acks, nothing on disk has been touched, so killing
    ///    the process is safe and the user gets their quit. That is the same reasoning as the
    ///    watchdog's short phase.
    ///  - `!RESUMING` — the sanctioned exits must pass. Both set it immediately before exiting.
    ///
    /// RESIDUAL WINDOW, STATED RATHER THAN ASSUMED AWAY: two ⌘Q presses inside the single IPC
    /// round-trip it takes the webview to ack are still not held, because nothing yet distinguishes
    /// them from a wedged webview. That is one round-trip, against the multi-second swap the
    /// finding is actually about.
    pub fn hold_second_exit() -> bool {
        DEFERRED.load(Ordering::SeqCst)
            && INSTALL_STARTED.load(Ordering::SeqCst)
            && !RESUMING.load(Ordering::SeqCst)
    }

    /// Drop every flag back to process-start state. Test-only, and used ONLY to re-enter the
    /// sequence below from a different starting point — a hold that fires with no deferral claimed
    /// is otherwise unreachable in a single process, and it is the conjunct guarding against an
    /// exit nobody would ever release.
    #[cfg(test)]
    pub fn reset_for_test() {
        STAGED.store(false, Ordering::SeqCst);
        DEFERRED.store(false, Ordering::SeqCst);
        INSTALL_STARTED.store(false, Ordering::SeqCst);
        RESUMING.store(false, Ordering::SeqCst);
    }

    /// Mark the exit we are about to make ourselves as sanctioned. Call IMMEDIATELY before the
    /// `exit(0)` it describes — anything between the two is a window in which a real user quit
    /// would be let through mid-install.
    ///
    /// IT IS A ONE-WAY LATCH, so only an exit whose safety is DECIDED may set it, and exactly two
    /// are: the webview's `resume_exit_after_update` (the install is over — that is the message)
    /// and the watchdog's LONG phase (the install had its full budget and never came back). An exit
    /// taken merely because nothing had started yet is NOT decided — see `run_exit_watchdog`.
    pub fn note_resuming() {
        RESUMING.store(true, Ordering::SeqCst);
    }

    /// THE DEFERRAL WATCHDOG'S WHOLE SEQUENCE, with the two effects it cannot own injected.
    ///
    /// WHY IT IS SHAPED LIKE THIS. The safety this module adds is not a property of any one
    /// predicate — it is a property of the ORDER in which these are called, and that ordering was
    /// covered by nothing: deleting a `note_resuming()` left every test in the crate green while a
    /// real quit silently stopped being protected. A `tauri::AppHandle` cannot be constructed in a
    /// unit test, so a closure is where the boundary has to be: `run()` supplies a real sleep and a
    /// real `handle.exit(0)`; the test supplies fakes and asserts the SIDE EFFECTS — did an exit
    /// happen, and would a user's second ⌘Q arriving at that instant have been held?
    ///
    /// PHASE 1 DELIBERATELY SANCTIONS NOTHING, and that is the fix rather than an omission.
    /// It used to call `note_resuming()` before its `exit(0)`, which is a claim it is not entitled
    /// to make: `handle.exit(0)` only POSTS `Message::RequestExit` to the main event loop, while
    /// the webview's ack and its `Update.install()` run on tauri worker threads. An ack landing
    /// just after the 5s boundary — precisely the case phase 1 exists for — means the queued exit
    /// is dispatched with a bundle swap in progress, and the one-way `RESUMING` latch waved it
    /// straight through `hold_second_exit`: /Applications/Sparkle.app deleted between
    /// `install_inner`'s `remove_dir_all` and its final rename, by the very line whose comment
    /// claimed the hold required it.
    ///
    /// No sanction is needed, because `hold_second_exit` requires `INSTALL_STARTED`: while that
    /// stays false this exit cannot be caught, and if it flips in the gap then being caught is
    /// exactly right. So the read-then-act is not made atomic — the transition is REMOVED, which is
    /// strictly stronger than making it atomic would have been.
    ///
    /// AND PHASE 1 DOES NOT RETURN. If the gap above happens, its exit is HELD, and this thread is
    /// the only thing that would ever release it — returning here would leave an app that cannot
    /// quit, the one outcome this module rates worse than a missed update. So it falls through to
    /// the long budget and becomes that releaser. If the exit did go through, the process is gone
    /// and the sleep below never finishes.
    pub fn run_exit_watchdog(sleep_ms: &mut dyn FnMut(u64), exit: &mut dyn FnMut()) {
        // Phase 1 — did the webview even answer? If not, nothing is installing and killing the
        // process is safe.
        sleep_ms(ACK_BUDGET_MS);
        if !install_started() {
            tracing::warn!("the webview never started the staged install; exiting without updating");
            exit();
        }
        // Phase 2 — an install IS running (or started in the gap above, and our exit is being
        // held). Give it room, because exiting between its remove_dir_all and its rename would
        // leave /Applications/Sparkle.app deleted.
        sleep_ms(INSTALL_BUDGET_MS);
        tracing::warn!("the staged install never reported back; exiting anyway");
        note_resuming();
        exit();
    }

    /// The webview reporting it is done with the staged update, as a SEQUENCE rather than two
    /// statements at a call site: sanction, then exit. Same reason as `run_exit_watchdog` — the
    /// order is the safety property, and the `AppHandle` in `resume_exit_after_update` is what kept
    /// it out of every test.
    pub fn resume_now(exit: &mut dyn FnMut()) {
        tracing::info!("webview finished with the staged update; resuming exit");
        // Announce the sanctioned exit BEFORE requesting it: this `exit(0)` re-enters
        // `ExitRequested`, where `hold_second_exit` would otherwise treat it exactly like a user's
        // second ⌘Q and prevent it — an app that can never quit.
        note_resuming();
        exit();
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::cell::{Cell, RefCell};

        /// ONE ORDERED LOG OF BOTH INJECTED EFFECTS, because the property under test is their
        /// INTERLEAVING and separate collectors cannot see it (roborev 67452).
        ///
        /// The first version of these cases recorded sleeps into a `Vec<u64>` and exits into a
        /// `usize`. Nothing then related the two, so hoisting BOTH sleeps to the top of
        /// `run_exit_watchdog` — destroying the two-phase structure altogether — left every
        /// assertion green: `slept[0] == ACK_BUDGET_MS` still held, `exits >= 1` still held, and a
        /// wedged webview would have cost the user 125s of apparently-hung app instead of 5s. The
        /// two-phase shape IS the feature, so the test has to be able to see it.
        #[derive(Debug, PartialEq, Eq)]
        enum Ev {
            Slept(u64),
            Exited,
        }

        /// ONE test drives the whole sequence deliberately, and every new case belongs IN it:
        /// these are process-wide statics and cargo runs tests in parallel threads, so a second
        /// test touching them races this one and both flake. (Measured: adding the second-quit
        /// cases as their own `#[test]` made this one fail on its very first claim.)
        ///
        /// Every assertion is about a SIDE EFFECT of the decision under test — was this exit
        /// deferred, was it held — never about the precondition that set it up.
        #[test]
        fn the_deferral_defers_once_and_a_second_quit_mid_install_is_held() {
            // Nothing staged — an ordinary quit is never deferred, so it costs nothing.
            assert!(!should_defer_exit(true), "an exit with nothing staged must not be deferred");
            // ...and nothing is ever HELD before a deferral was claimed, or a stray sticky flag
            // could leave a user in an app that will not quit.
            assert!(!hold_second_exit(), "with nothing deferred, no exit may ever be held");

            note_staged(true);

            // FINDING 3 — the last-window-destroyed exit arrives with the webview already gone, so
            // it can install nothing. It must decline WITHOUT burning the single claim.
            assert!(
                !should_defer_exit(false),
                "an exit with no webview left cannot install anything, so it must not be deferred"
            );

            // The claim it declined is still there for a real, webview-backed quit.
            assert!(should_defer_exit(true), "the first webview-backed quit is deferred");
            // THE LOOP GUARD. The resume path calls `AppHandle::exit` again, which re-enters
            // ExitRequested; if this answered true a second time the app could never quit.
            assert!(!should_defer_exit(true), "the deferral must be claimable at most once");
            assert!(!claim_exit_deferral());

            // The webview has to say so before the long budget applies — the whole point of the
            // two-phase watchdog is that "webview never answered" is distinguishable from
            // "an install is mid-rename".
            assert!(!install_started(), "nothing has started installing yet");
            // Deferred, but nothing on disk has been touched yet: a second quit here is SAFE to
            // honour, and honouring it is how the user still gets their quit out of a wedged
            // webview. Same reasoning as the watchdog's short phase.
            assert!(
                !hold_second_exit(),
                "before the install starts, killing the process cannot corrupt the bundle"
            );

            // FINDING 1 — the bundle swap is now running. THIS is the second ⌘Q that used to kill
            // the process between `remove_dir_all` and the final rename, leaving
            // /Applications/Sparkle.app deleted.
            note_install_started();
            assert!(install_started());
            assert!(
                hold_second_exit(),
                "a second quit while the bundle swap is running must be prevented"
            );

            // Both sanctioned exits — the webview's `resume_exit_after_update` and the watchdog's
            // own `handle.exit(0)` — announce themselves first, so neither is caught by that hold.
            note_resuming();
            assert!(
                !hold_second_exit(),
                "the sanctioned resume must not be held, or the app could never quit"
            );

            // AN INSTALL FLAG WITH NO DEFERRAL BEHIND IT MUST NEVER HOLD ANYTHING. Nothing is
            // waiting to resume that exit — no webview was asked, no watchdog was started — so
            // holding it is an app that cannot be quit, which this module rates worse than a
            // missed update. Reached only by rewinding the statics, since one process cannot
            // otherwise get here.
            reset_for_test();
            note_install_started();
            assert!(
                !hold_second_exit(),
                "an exit may only be held while something is on the hook to release it"
            );

            // ── THE SEQUENCING, not just the predicates ──────────────────────────────────────
            // Everything above tests what the flags MEAN. Everything below drives the real
            // `run()` sequences through their injected-effect seams, because the property this
            // module actually adds is the ORDER of those calls — and deleting a `note_resuming()`
            // used to leave the entire crate green while a real quit stopped being protected.
            // Every assertion is a side effect: did an exit happen, and would a user's ⌘Q landing
            // at that instant have been HELD or let through?

            // THE SANCTIONED RESUME. The webview says the install is over; that exit must pass, or
            // the app can never be quit.
            reset_for_test();
            note_staged(true);
            assert!(should_defer_exit(true));
            note_install_started();
            assert!(hold_second_exit(), "a user's second ⌘Q mid-swap is held — the setup for the case below");
            let mut resume_exits = 0usize;
            let mut held_at_resume: Option<bool> = None;
            resume_now(&mut || {
                resume_exits += 1;
                held_at_resume = Some(hold_second_exit());
            });
            assert_eq!(resume_exits, 1, "the resume must actually request the exit");
            assert_eq!(
                held_at_resume,
                Some(false),
                "MUTATION: delete `note_resuming()` from `resume_now`. The resume's own exit is then                  caught by `hold_second_exit` and only the 120s phase-2 timeout releases it — an app                  that will not quit, which this module rates worse than a missed update."
            );

            // THE WEBVIEW NEVER ANSWERED. Nothing on disk was touched, so the short phase exits —
            // and it does NOT return, because if the ack lands in the gap (next case) this thread
            // is the only thing that would ever release the exit it just requested.
            reset_for_test();
            note_staged(true);
            assert!(should_defer_exit(true));
            let log = RefCell::new(Vec::<Ev>::new());
            run_exit_watchdog(
                &mut |ms| log.borrow_mut().push(Ev::Slept(ms)),
                &mut || log.borrow_mut().push(Ev::Exited),
            );
            // ONE assertion, and it pins the whole shape: the SHORT budget comes first, the user
            // gets their quit out of a wedged webview at that boundary rather than 125s later, and
            // the thread does not stop there.
            assert_eq!(
                *log.borrow(),
                vec![
                    Ev::Slept(ACK_BUDGET_MS),
                    Ev::Exited,
                    Ev::Slept(INSTALL_BUDGET_MS),
                    Ev::Exited,
                ],
                "MUTATION: hoist both sleeps to the top of `run_exit_watchdog`, so it has no                  two-phase structure at all. A wedged webview then costs the user 125s of an                  apparently-hung app instead of 5s. Separate `slept`/`exits` collectors could not                  see that at all — the ORDER is the property, so the log has to be ordered."
            );

            // THE FINDING (roborev 67425). The short phase decided to abandon because nothing had
            // started — and then the ack lands while its exit is still only a QUEUED
            // `Message::RequestExit` on a contended main loop (the webview's ack and its
            // `Update.install()` run on tauri worker threads; `handle.exit(0)` merely posts). What
            // the main loop must decide when it finally dispatches that request is HOLD.
            reset_for_test();
            note_staged(true);
            assert!(should_defer_exit(true));
            let log = RefCell::new(Vec::<Ev>::new());
            let held_when_the_queued_exit_lands = Cell::new(None::<bool>);
            run_exit_watchdog(
                &mut |ms| log.borrow_mut().push(Ev::Slept(ms)),
                &mut || {
                    let first = {
                        let mut l = log.borrow_mut();
                        l.push(Ev::Exited);
                        l.iter().filter(|e| **e == Ev::Exited).count() == 1
                    };
                    if first {
                        // The install starts between our exit REQUEST and its dispatch.
                        note_install_started();
                        held_when_the_queued_exit_lands.set(Some(hold_second_exit()));
                    }
                },
            );
            assert_eq!(
                held_when_the_queued_exit_lands.get(),
                Some(true),
                "MUTATION: restore the `note_resuming()` the short phase used to call before its                  `exit(0)`. That one-way latch waves the queued exit through mid-swap and the                  process dies between `install_inner`'s remove_dir_all and its final rename —                  /Applications/Sparkle.app DELETED, by the line whose comment claimed the hold                  required it."
            );
            assert_eq!(
                *log.borrow(),
                vec![
                    Ev::Slept(ACK_BUDGET_MS),
                    Ev::Exited,
                    Ev::Slept(INSTALL_BUDGET_MS),
                    Ev::Exited,
                ],
                "MUTATION: restore the `return` after the short phase's exit. That exit is now HELD                  (previous assertion), and this thread is the only thing that would release it —                  returning leaves an app that cannot be quit at all. Asserted as ONE ORDERED LOG                  rather than a sleep list plus an exit count, so that a `run_exit_watchdog` with no                  phase boundary left in it cannot satisfy this."
            );
            assert!(
                !hold_second_exit(),
                "and that second exit passes, or the hold is never released"
            );

            // THE ACK LANDED IN TIME — the paired case for "the webview never answered", and the
            // only one that drives the OTHER side of phase 1's conditional (roborev 67772). Without
            // it the guard itself is unpinned: every case above enters with `install_started()`
            // false, so replacing `if !install_started() { exit(); }` with a bare `exit();` leaves
            // all of them byte-identically green — and the watchdog would then fire an exit request
            // into a LIVE bundle swap at the 5s boundary, which is the whole thing the two-phase
            // split exists to prevent.
            reset_for_test();
            note_staged(true);
            assert!(should_defer_exit(true));
            note_install_started();
            let log = RefCell::new(Vec::<Ev>::new());
            run_exit_watchdog(
                &mut |ms| log.borrow_mut().push(Ev::Slept(ms)),
                &mut || log.borrow_mut().push(Ev::Exited),
            );
            assert_eq!(
                *log.borrow(),
                vec![Ev::Slept(ACK_BUDGET_MS), Ev::Slept(INSTALL_BUDGET_MS), Ev::Exited],
                "MUTATION: drop the `if !install_started()` guard and exit unconditionally. An                  install that acked INSIDE the budget is then killed at the 5s boundary —                  mid-swap, between `install_inner`'s remove_dir_all and its final rename — and                  the only thing left standing is the independent `hold_second_exit` arm."
            );
        }

        /// The one part of the sequence a unit test CANNOT execute: `has_webview` is derived from a
        /// live `tauri::AppHandle`, which cannot be constructed here. So it is pinned against
        /// `lib.rs`'s own bytes instead — honestly weaker than driving it, and named as such rather
        /// than dressed up as coverage.
        ///
        /// It fails on exactly the edit that matters: passing a literal `true` restores the
        /// last-window-destroyed bug (an exit deferred for a webview that is already gone, so the
        /// emit reaches zero listeners, nothing ever acks, and a windowless process hangs for the
        /// whole ack budget installing nothing).
        #[test]
        fn the_exit_arm_asks_whether_a_webview_is_still_there() {
            const LIB_RS: &str = include_str!("lib.rs");
            // EVERY NEEDLE IS ASSEMBLED AT RUNTIME. A test that greps the file it lives in
            // otherwise matches its OWN literal: the positive assertions would be satisfied by
            // this very function and the negative one would be defeated by it — three assertions
            // that cannot fail, in the file about vacuous tests. Split so no assembled needle
            // appears verbatim anywhere in the source.
            let derives_it = format!("let has_webview = !app.{}().is_empty();", "webview_windows");
            let passes_it = format!("updater_quit::should_defer_exit({})", "has_webview");
            let hardcodes_it = format!("updater_quit::should_defer_exit({})", "true");
            assert!(
                LIB_RS.contains(&derives_it),
                "the ExitRequested arm must derive `has_webview` from the live window map"
            );
            assert!(
                LIB_RS.contains(&passes_it),
                "...and pass THAT to should_defer_exit"
            );
            assert!(
                !LIB_RS.contains(&hardcodes_it),
                "a literal `true` there defers exits for a webview that is already gone"
            );
        }

        /// The short phase must stay short and the long phase must stay long — inverting them would
        /// turn the safe branch into the one that can kill a process mid-rename.
        #[test]
        fn the_ack_budget_is_much_shorter_than_the_install_budget() {
            assert!(
                ACK_BUDGET_MS * 4 < INSTALL_BUDGET_MS,
                "the ack budget bounds a webview that never answered (safe to kill); the install \
                 budget bounds a rename that must be allowed to finish"
            );
        }

        /// Same coherence check `app_menu.rs` runs for its menu events: a renamed event or command
        /// is otherwise silent on BOTH sides — Rust defers an exit nobody answers, and the webview
        /// waits for a message that never comes.
        #[test]
        fn the_typescript_updater_uses_the_same_event_and_commands() {
            const UPDATER_TS: &str = include_str!("../../src/services/updaterService.ts");
            assert!(
                UPDATER_TS.contains(INSTALL_BEFORE_EXIT_EVENT),
                "src/services/updaterService.ts must listen for {INSTALL_BEFORE_EXIT_EVENT}"
            );
            for cmd in ["note_staged_update", "note_update_install_started", "resume_exit_after_update"] {
                assert!(
                    UPDATER_TS.contains(cmd),
                    "src/services/updaterService.ts must invoke {cmd} — without it the exit is \
                     deferred and never resumed except by the watchdog"
                );
            }
        }
    }
}

/// The webview reporting whether it is holding a downloaded update. Drives whether an exit is worth
/// deferring at all.
#[tauri::command]
fn note_staged_update(staged: bool) {
    updater_quit::note_staged(staged);
}

/// The webview reporting that `Update.install()` is running now. Promotes the exit watchdog from
/// its short "are you alive?" budget to the long "let the rename finish" one.
#[tauri::command]
fn note_update_install_started() {
    updater_quit::note_install_started();
}

/// The webview reporting that it is done with the staged update — installed, or failed. Either way
/// the exit proceeds; the frontend calls this in a `finally`.
#[tauri::command]
fn resume_exit_after_update(app: tauri::AppHandle) {
    // The sanction-then-exit ORDER lives in `resume_now`, where a test can drive it. This line is
    // only the `AppHandle` binding — the part no unit test can construct.
    updater_quit::resume_now(&mut || app.exit(0));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // BEFORE the event loop, before anything opens a window: the Builder Index dry run. It is a
    // diagnostic, not a feature — it computes exactly the payload the reporter would POST and
    // prints it, WITHOUT a network call, a keychain read, or a state write. That combination is
    // the point: proving Sparkle's collection matches the client it is meant to replace must not
    // require publishing anything, because the leaderboard's primary key makes a published row
    // permanent. See `builder_index::dry_run`.
    if let Some(args) = builder_index::dry_run_args(std::env::args().skip(1)) {
        println!("{}", builder_index::dry_run(&args));
        return;
    }
    // Capture the main thread's identity HERE, on the main thread, before the event loop starts.
    // `cmd_timing` compares against it to report whether a command body actually ran on the main
    // thread rather than inferring it from the macro's source — see that module's header.
    cmd_timing::note_main_thread();
    // Which WebKit `WebContent` processes already existed BEFORE we made one. HERE, before the
    // builder, because the only thing that separates our renderer from the nine other apps' — they
    // all have `ppid=1` and a byte-identical command line — is that ours appears after this line.
    // The watchdog takes the matching "after" snapshot on the webview's first heartbeat, so a hang
    // capture can sample the process the heartbeat actually came from. See watchdog.rs.
    watchdog::note_webcontent_baseline();
    if cmd_timing::init_from_env() {
        tracing::info!(target: "perf", "per-command main-thread timing armed (SPARKLE_CMD_TIMING)");
    }
    // Own WebKit's localStorage WAL checkpoint. HERE, before the Builder opens any window: the first
    // pass runs while nothing has touched the localStorage DB yet, which is the cleanest window for a
    // full TRUNCATE. Left to WebKit's own passive checkpoint the WAL reached 3.65 GB against a 4.4 MB
    // store and kept growing (`sparkle-i061ug`); this thread truncates it now and on an interval so
    // it cannot. Best-effort and off-thread — it never blocks boot, and it is a no-op off macOS.
    webkit_localstorage::spawn_maintenance();
    tauri::Builder::default()
        // The app menu. `app_menu::build` starts from Tauri's platform default and only INSERTS
        // into it — setting any menu here REPLACES the default outright, and a hand-rolled one that
        // forgot the Edit submenu would silently take ⌘X/⌘C/⌘V/⌘A away from the whole app.
        .menu(app_menu::build)
        .on_menu_event(app_menu::on_menu_event)
        // ── OUR `ipc:` PROTOCOL SHADOWS TAURI'S. THIS IS THE APP'S IPC PATH. ──────────────────
        // Tauri registers its own `ipc` handler only `if !registered_scheme_protocols.contains(…)`
        // (tauri-2.11.3 `src/manager/webview.rs:280`), and builder protocols are pushed into that
        // list at `:230` — before the check. So this line, and nothing else, decides which handler
        // every invoke in the app goes through.
        //
        // WHY: Tauri hands the protocol handler a responder that fires at COMMAND COMPLETION for
        // async commands as well as sync ones. `cmd_timing::measure` (still wired below, still
        // useful for main-thread occupancy) cannot see that instant — for the 232 async commands it
        // measures only the dispatch hop. See `ipc_trace`'s header.
        //
        // ALWAYS ON, deliberately: an opt-in probe is disarmed at exactly the moment it is needed.
        // The killswitch is `ipc_trace_set_enabled` — config, not a compile gate.
        .register_asynchronous_uri_scheme_protocol("ipc", ipc_trace::ipc_protocol)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_http::init())
        // Auto-updater (poll signed GitHub Releases manifest + install) and process (relaunch into
        // the staged update). The frontend updaterService drives both; pubkey/endpoints live in
        // tauri.conf.json. See apps/desktop/UPDATER-SETUP.md for the signing-key/CI setup.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Launch-at-login registration for the overlay's opt-in auto-launch (bead sparkle-uz87.9).
        //
        // REGISTERING THE PLUGIN REGISTERS NOTHING WITH THE OS. It only makes `app.autolaunch()`
        // available; the LaunchAgent is written exactly when `overlay_auto_launch_set` is called
        // with `enable: true`, which happens only from an explicit user opt-in flowing through
        // `overlayTray/autoLaunch.ts`. The second argument is the argv to relaunch with and is
        // deliberately `None` — this is not a place to smuggle in a "--autostart" behaviour change.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(PtyManager::default())
        .manage(claude_chat::ClaudeChatManager::default())
        .manage(sparkle_improve::SparkleImproveManager::default())
        .manage(concierge::ConciergeManager::default())
        .manage(dictation::DictationState::default())
        .manage(bridge::BridgeManager::default())
        .manage(bridge::ControlBridgeManager::default())
        .manage(auth::DeepLinkPending::default())
        .manage(auth::PendingSignIn::default())
        .manage(attention::BadgeCounts::default())
        .manage(accounts::AccountsLock::default())
        .manage(trial::TrialLock::default())
        .manage(roster::RosterState::default())
        // The deterministic nudger's per-session observers and its raised flags. Both are managed
        // state rather than module statics so `pty.rs` can reach them from a command signature and
        // so a test can stand one up in isolation.
        .manage(nudger::Observers::default())
        .manage(nudger::NudgeFlags::default())
        // The last attention verdict emitted per agent. Managed for the same reasons: the
        // nudger thread writes it from an `AppHandle`, and the frontend SEEDS from it with
        // `observed_attention` because the event only fires on change.
        .manage(observed_attention::ObservedAttentionState::default())
        // The conflicting/stale-PR detector's raised flags. Managed state for the same reasons the
        // nudger's are: the watcher thread reaches them from an `AppHandle`, the frontend PULLS
        // them with `conflict_flags`, and a test can stand one up in isolation.
        .manage(conflict_watch::ConflictFlags::default())
        // The due-for-resurrection list, republished once a second by `revival::start`. Managed for
        // the same reason the nudger's state is: the timer thread reaches it from an `AppHandle`,
        // and `services/resurrectionRunner` PULLS it with `revival_due` rather than the sweep
        // re-deriving the ledger itself on the main thread.
        .manage(revival::RevivalState::default())
        .manage(frontmost::FrontmostState::default())
        .manage(helper::HelperVitals::default())
        // PR claims live in the Rust process, not a window store, so an agent's "I am landing this
        // myself" is visible from EVERY window — including whichever one answers the concierge.
        .manage(pr_claims::PrClaims::default())
        // Live browser previews this launch owns. Managed state rather than a module static so the
        // supervisor threads reach it from an `AppHandle` and a stop can find the child to signal.
        .manage(preview::PreviewManager::default())
        // Every Focused event feeds TWO consumers, both of which need the same blur coalescing
        // because macOS emits the outgoing window's resignKey BEFORE the incoming window's
        // becomeKey:
        //   - dictation (sparkle-9oz6): Sparkle must not capture audio while the user is looking at
        //     another app, so this releases the OS mic when no Sparkle window is the active OS
        //     window and rebuilds it on return. Coalescing keeps the mic live across an
        //     internal window switch.
        //   - frontmost (spec §4.6): drives the floating helper island's visibility. Coalescing
        //     stops the island flashing on during an internal window switch.
        .on_window_event(|window, event| {
            // A real OS drag-drop is the ONLY trustworthy signal that the user chose a file: the
            // paths come from the window server, not from the webview. Recording them here is what
            // lets `load_attachment` read a file the containment rule would otherwise refuse — a
            // `.txt` dragged from `/private/tmp` used to be accepted by the UI and then silently
            // discarded (bead sparkle-zviq). See attachments.rs' provenance note.
            //
            // Enter and Drop are DIFFERENT claims, and conflating them is a security bug: Enter
            // fires for any drag crossing this window, including one headed for another app, so a
            // durable grant there would let a file merely dragged PAST Sparkle be read for the life
            // of the process. Enter is provisional (cleared on Leave), Drop is consent. Registering
            // on Enter at all is what removes the race with the JS event, which Tauri emits before
            // it runs this listener. See attachments.rs' tier note.
            // EVERY decision — which drag phase grants what, and that a destroyed window drops the
            // hovers it owned — lives in `attachments::note_window_event`. Nothing is decided here,
            // deliberately: as match arms at this call site no test could reach them, and both times
            // a rule lived here it could be silently deleted with the suite still green.
            attachments::note_window_event(window.label(), event);
            if let tauri::WindowEvent::Focused(focused) = event {
                let app = window.app_handle();
                let label = window.label();
                // TWO filters, not one — the consumers ask different questions (frontmost.rs).
                // The routing itself lives in `frontmost::focus_consumers` so it can be unit-tested
                // as a value: the predicates were never the bug, the dispatch was, and a test that
                // hand-feeds `is_typing_window`/`is_app_window` cannot see which one is wired where.
                //
                // Dictation wants "can the caret be in Sparkle", which INCLUDES the capture
                // takeover: it is a deliberately key-accepting panel and CaptureApp mounts
                // useAmbientVoice, so dropping its focus events here left the mic permanently
                // unbuilt and voice narration in the takeover dead on every invocation.
                //
                // The HELPER is filtered from both, and must stay that way (sparkle-9oz6): it is a
                // non-activating panel, so letting it through to dictation would resume microphone
                // capture the moment the user clicked the floating island while working in another
                // app — a worse failure than the island's own.
                // A THIRD consumer, and deliberately not folded into `focus_consumers`: it asks a
                // different question from either of those two. They decide app BEHAVIOUR (release
                // the mic, hide the island); this one only RECORDS, so that an app-wide input
                // freeze can be diagnosed from the log file afterwards (bead sparkle-thm9o). It is
                // the one signal that survives a wedged webview, because the webview is what it
                // exists to check on — see key_window.rs.
                key_window::note_focus(label, *focused);
                let consumers = frontmost::focus_consumers(label);
                if consumers.dictation {
                    app.state::<dictation::DictationState>()
                        .note_focus_event(app, *focused);
                }
                // The island's visibility wants "is a REAL Sparkle window frontmost". The takeover
                // is shown WITHOUT activating the app, so it must not count here.
                if consumers.frontmost {
                    frontmost::note_focus_event(
                        app,
                        &app.state::<frontmost::FrontmostState>(),
                        *focused,
                    );
                }
            }
        })
        .setup(|app| {
            // Stand up unified logging before anything else so startup itself is captured.
            match logging::init(app.handle()) {
                Ok(dir) => tracing::info!(
                    version = %app.package_info().version,
                    log_dir = %dir.display(),
                    "Sparkle starting"
                ),
                // Logging is best-effort: a failure here must not stop the app from booting.
                Err(e) => eprintln!("failed to initialize logging: {e}"),
            }
            // Install crash/panic capture immediately after logging (before any other init) so a
            // panic or fatal signal during startup itself is still captured. The panic hook CHAINS
            // to the existing hook (audio.rs' catch_unwind firewall is unchanged); the native signal
            // handler catches crashes a panic hook can't (e.g. a CoreAudio abort). Always-on and
            // best-effort — it only writes to the user's own disk here; upload is consent-gated in
            // the `flush_crash_reports` command.
            crash::install(app.handle());
            // ── sparkle-1ueh3 (change C) ── EAGERLY copy every bundled resource out of the app
            // bundle into `<app_data>/bin/<build sha>/`, ONCE, before the updater can replace
            // /Applications/Sparkle.app underneath this running process (it polls at launch,
            // hourly, and on every window focus). Every later consumer — the orchestrator and
            // sparkle-control MCP servers, the Claude hook scripts, the roborev git hooks — reads
            // that staged copy, so an old process can never end up running a NEWER build's files.
            // Eager, not lazy: a first resolve happening after a swap would cache the new bundle.
            hooks::init_staged_resources(app.handle());
            // Supply the `prepareForDragOperation:` override wry leaves unimplemented, so a file
            // released over a TERMINAL is delivered at all. Without it AppKit stops the drag after
            // the hover phase for any drop outside a natively-droppable element, which is why the
            // terminal painted its drop affordance and then swallowed the release, silently, from
            // 2026-07-30 until this landed. See webview_drop_gate for the full mechanism.
            webview_drop_gate::install(app.handle());
            // Watch for monitors being plugged/unplugged so a window spanned across displays can be
            // re-fitted instead of stranded at a geometry no remaining display can show.
            display_span::start_display_watch(app.handle().clone());
            // Reconcile research tasks a previous launch left mid-flight. A task that was `queued`
            // or `running` when the app exited keeps that status on disk forever — its control
            // lived only in the old process — so without this the sidebar's `+[n]` is permanently
            // inflated by every interrupted pass and nothing ever drains it (this module opts out
            // of `retention::reap_inbox` deliberately, and cancel needs a human to notice). A deep
            // pass runs up to 15 minutes, so a restart landing inside one is ordinary.
            if let Ok(app_data) = crate::worktree::app_data_dir_pub(app.handle()) {
                let n = research::reconcile_interrupted(&app_data);
                if n > 0 {
                    tracing::info!(count = n, "research: reconciled tasks interrupted by a restart");
                }
            }
            // Reclaim preview dev servers a previous launch left behind. This is the PRIMARY orphan
            // path, not a backstop: managed state leaks on the ordinary Cmd+Q path, so a hard kill
            // leaves the child running with nothing else that would ever stop it. It verifies the
            // full (pid, pgid, start-time) triple before signalling anything — see preview.rs.
            preview::init(app.handle());
            // Auth hand-off: forward an incoming sparkle://auth?code=… deep link to the webview
            // as a "deep-link" event; AuthGate redeems the one-time code (spec §3.1, §8).
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        let s = url.to_string();
                        // Stash it for the cold-launch case (webview listener not yet attached),
                        // then emit for the warm (already-running) case.
                        if let Some(pending) = handle.try_state::<auth::DeepLinkPending>() {
                            // Poison-tolerant: a panic elsewhere must not silently drop the
                            // cold-launch auth code (which would make sign-in impossible).
                            *pending.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(s.clone());
                        }
                        let _ = handle.emit("deep-link", s);
                    }
                });
            }
            // Attribute notifications to Sparkle's bundle id (best-effort; see attention.rs).
            attention::init_application();
            // Watch the main thread from OFF the main thread, so a wedge can be reported while it
            // is still happening. Started early: the stalls worth catching include startup ones,
            // and nothing here depends on the rest of setup succeeding (see watchdog.rs).
            watchdog::start(app.handle());
            // The deterministic non-LLM nudger (sparkle-a94sr). Started next to the watchdog and
            // for the same reason: it is a plain OS thread that must be running before anything
            // it observes, and it depends on nothing else in setup. It makes NO model call on any
            // path, which is the whole point — it is what remains when a provider-wide 529 has
            // taken out every agent, the concierge, and the pusher at once.
            nudger::start(app.handle());
            // The conflicting/stale-PR detector (sparkle-zss67). Same category as the nudger above
            // and started beside it for the same reason: a plain OS thread that makes NO model call
            // on any path, so a provider-wide 529 can never blind us to a PR that has gone DIRTY —
            // and therefore, since GitHub never fires `pull_request` for one, UNTESTED.
            conflict_watch::start(app.handle());
            // SEAL THE PREVIOUS LAUNCH'S UNCLOSED RECORDS, SYNCHRONOUSLY, BEFORE ANYTHING ELSE CAN
            // READ THEM.
            //
            // App restart is the largest single killer of agents in this app — 54 SessionEnd in one
            // minute on 2026-08-06 at 18:20, 49 more at 18:47 — and it is precisely the case in
            // which the WebView gets no chance to write anything down. So the death is not observed,
            // it is INFERRED here: a record still `Live` whose owning epoch is provably dead (a
            // kernel-released `flock`, not a heartbeat) becomes an `AppRestart` death.
            //
            // ON THE MAIN THREAD ON PURPOSE, which is the one place in this file that is the right
            // trade. `seal_stale_at` is documented as needing to run "BEFORE any pane mounts, so a
            // reader sees a settled record instead of racing the sealer", and a background thread
            // cannot promise that — the webview's first `agent_life_open` could land first. The cost
            // is a `read_dir` plus one small JSON parse per agent, against a directory holding one
            // file per agent this machine has ever run; the measured worst case is ~50 files.
            //
            // A record whose epoch is still ALIVE is left completely alone. That is the sleep case
            // (an `flock` is not released by suspend), and getting it wrong would seal a running
            // fleet and hand every live agent to the resurrector at once.
            match dev_identity::app_data_dir(app.handle()) {
                Ok(base) => {
                    let dir = agent_life::life_dir(&base);
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);
                    match agent_life::seal_stale_at(
                        &dir,
                        &base,
                        babysit_lease::process_epoch(),
                        now,
                    ) {
                        Ok(stats) if stats.sealed > 0 => tracing::info!(
                            scanned = stats.scanned,
                            sealed = stats.sealed,
                            still_live = stats.still_live,
                            "agent-life: sealed records orphaned by a previous launch"
                        ),
                        Ok(stats) => tracing::debug!(
                            scanned = stats.scanned,
                            still_live = stats.still_live,
                            "agent-life: nothing to seal"
                        ),
                        Err(e) => tracing::warn!("agent-life seal failed: {e}"),
                    }
                }
                Err(e) => tracing::warn!("agent-life seal skipped (app_data_dir): {e}"),
            }
            // …and only THEN start the thread that reads what the seal just wrote. Same category as
            // the nudger and the conflict watcher above, and started beside them for the same
            // reason: a plain OS thread that makes NO model call on any path. When the wall is
            // fleet-wide every LLM in the app is behind the same account limit, so anything that
            // consults one is dead exactly when recovery is needed.
            revival::start(app.handle());
            // Stand up the local history store (prompts + responses, FTS5) in the app-data dir.
            // A failure here must not stop the app from booting — capture/search just won't work.
            match dev_identity::app_data_dir(app.handle()) {
                Ok(dir) => match history::HistoryDb::new(&dir) {
                    Ok(db) => {
                        app.manage(db);
                    }
                    Err(e) => tracing::error!("history DB init failed: {e}"),
                },
                Err(e) => tracing::error!("app_data_dir for history: {e}"),
            }
            // Reap the per-agent hook-event logs. Nothing ever deleted these, so the directory grew
            // to 606 files / 107 MB. Runs on a background thread: it stats every file in the
            // directory and must not sit in the launch path. Only reaps logs whose agent worktree is
            // GONE (and then only past an age grace); a live agent's log is size-capped, never
            // deleted. Worktrees themselves are never touched — only listed, to learn which agent
            // ids are still live.
            //
            // The same pass also reaps `<app_data>/inbox` (the Level 2 message queue). Its TTL
            // expired messages logically but never removed them, so every agent's Stop hook
            // re-parsed that agent's whole history at every turn boundary, and a spun-down worker's
            // queue lived on with nobody to drain it. Same fail-closed rule: a whole inbox is only
            // deleted when liveness is KNOWN and the agent is not in it.
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let base = match dev_identity::app_data_dir(&handle) {
                        Ok(base) => base,
                        Err(e) => {
                            tracing::warn!("retention: app_data_dir: {e}");
                            return;
                        }
                    };
                    let worktrees = base.join("worktrees");
                    let now = std::time::SystemTime::now();
                    match retention::reap_hook_events(
                        &base.join("hook-events"),
                        &worktrees,
                        retention::HookEventsPolicy::default(),
                        now,
                    ) {
                        Ok(s) if s.deleted > 0 || s.truncated > 0 => tracing::info!(
                            deleted = s.deleted,
                            truncated = s.truncated,
                            mb_freed = s.bytes_freed / (1024 * 1024),
                            "hook-events retention pass complete"
                        ),
                        Ok(_) => tracing::debug!("hook-events retention: nothing to reap"),
                        Err(e) => tracing::warn!("hook-events retention failed: {e}"),
                    }
                    match retention::reap_inbox(
                        &inbox::inbox_dir(&base),
                        &worktrees,
                        retention::InboxPolicy::default(),
                        now,
                    ) {
                        Ok(s) if s.deleted > 0 || s.truncated > 0 => tracing::info!(
                            deleted = s.deleted,
                            compacted = s.truncated,
                            bytes_freed = s.bytes_freed,
                            "inbox retention pass complete"
                        ),
                        Ok(_) => tracing::debug!("inbox retention: nothing to reap"),
                        Err(e) => tracing::warn!("inbox retention failed: {e}"),
                    }
                    // Size-cap the concierge linter's violation log (concierge_lint_log.rs).
                    // TRUNCATE-ONLY, never deleted: it is the count that says whether the linter is
                    // working, and deleting it would read as "nothing left to fix". Rides this
                    // thread rather than getting its own — same stat-a-file work, and it must stay
                    // off the launch path for the same reason.
                    match retention::reap_concierge_lint_log(
                        // Through the module's own resolver, NOT base.join(LINT_LOG_FILE) (roborev
                        // 55779): two independent constructions of one path can silently
                        // diverge, and the failure is invisible — a moved file makes plain_file
                        // return None, the reap returns default stats, and the "under the cap"
                        // debug line reports healthy while the cap has stopped existing.
                        &concierge_lint_log::lint_log_path(&base),
                        retention::ConciergeLintPolicy::default(),
                    ) {
                        Ok(s) if s.truncated > 0 => tracing::info!(
                            kb_freed = s.bytes_freed / 1024,
                            "concierge lint log tail-truncated"
                        ),
                        Ok(_) => tracing::debug!("concierge lint log: under the cap"),
                        Err(e) => tracing::warn!("concierge lint log retention failed: {e}"),
                    }
                });
            }
            // Sweep the concierge's screenshot directory (`<temp>/sparkle-captures.noindex`). THE
            // DETERMINISTIC HALF of that module's retention bound: pruning only inside a capture
            // made retention a side effect of taking ANOTHER capture, so a session that
            // photographed the screen once and then went quiet left the PNG in temp forever — the
            // quiescent case, and the common one. Same background-thread treatment as the
            // hook-events reap above and for the same reason: it stats a directory.
            std::thread::spawn(window_screenshot::sweep_capture_dir);
            // Editable TOML config: load the global config.toml and watch it for live reload.
            // Best-effort — a failure here must not stop the app; the engine falls back to
            // built-in defaults (config::current_effective() returns defaults when never loaded).
            if let Err(e) = config::init_and_watch(app.handle()) {
                tracing::error!("config init/watch failed: {e}");
            }
            // Watch that dictation is actually HEARING something, and that the input device list
            // hasn't shifted under us. On 2026-07-29 a screen recorder's CoreAudio HAL plug-in left
            // capture running for nine minutes with zero frames arriving while the UI showed a
            // normal idle waveform — nothing anywhere checked whether audio existed, only whether
            // the stream had been created. Started unconditionally: it is one sleeping thread, and
            // it no-ops whenever there is no capture to watch.
            dictation::start_audio_watchdog(app.handle().clone());
            // Warm the on-device model NOW rather than on the first hold. Lazily loaded, it cost
            // 2.4-46 s (measured) at exactly the moment a push-to-talk hold needs it, so the hold
            // ended first and the utterance was never recorded — 20 times on 2026-08-09 alone.
            dictation::preload_model_in_background(app.handle().clone());
            // Hidden transparent capture window (menu-bar capture flow). Best-effort:
            // a failure only loses the capture feature, never blocks boot.
            if let Err(e) = capture_window::init_capture_window(app.handle()) {
                tracing::error!("capture window init failed: {e}");
            }
            // The floating helper island (spec §4.1). Fail-soft by contract: the app is entirely
            // usable without it, and the frontend's show path will retry later.
            if let Err(e) = helper::init_helper_window(app.handle()) {
                tracing::error!("helper window init failed: {e}");
            }
            // Global shortcut (default Ctrl+Shift+R, [capture].popover_shortcut in
            // config.toml) toggling the menu-bar popover from anywhere. Fail-soft by
            // contract: an unparseable or already-taken accelerator logs a warning and
            // the app runs without a shortcut — never a panic (spec §1/§9).
            {
                use std::str::FromStr;
                use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
                let accel = config::current_effective().config.capture.popover_shortcut;
                match Shortcut::from_str(accel.trim()) {
                    Ok(shortcut) => {
                        let registered =
                            app.handle().global_shortcut().on_shortcut(shortcut, |app, _, event| {
                                if event.state == ShortcutState::Pressed {
                                    // Ask the island to run the capture flow, so the shortcut and
                                    // the island's own Capture button share ONE code path instead
                                    // of drifting apart.
                                    //
                                    // Deliberately does NOT show the island first. The helper
                                    // webview stays mounted (and subscribed) even when hidden, so
                                    // capture works regardless — and showing it would resurrect a
                                    // helper the user explicitly hid, as well as putting it in the
                                    // shot the capture is about to take.
                                    let _ = app.emit("helper://capture-requested", ());
                                }
                            });
                        if let Err(e) = registered {
                            tracing::warn!(
                                "could not register [capture].popover_shortcut '{accel}' \
                                 (already taken by another app?): {e}"
                            );
                        }
                    }
                    Err(e) => tracing::warn!(
                        "[capture].popover_shortcut '{accel}' is not a valid accelerator, \
                         running without a global shortcut: {e}"
                    ),
                }
            }
            // roborev daemon startup ensure. When the user has opted into roborev ([tools].roborev)
            // AND already passed the one-time consent modal (roborev.consent_prompted), re-run the
            // idempotent install so the launchd daemon is (re)loaded after a reboot — a fresh boot
            // starts LaunchAgents, but this also self-heals a daemon that was booted-out or a binary
            // that moved. Best-effort and OFF the startup path: spawned onto the async runtime so it
            // never blocks boot; any error is swallowed (the onboarding flow surfaces install issues).
            {
                let eff = config::current_effective().config;
                if eff.tools.roborev && eff.roborev.consent_prompted {
                    let handle = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = setup::install_roborev(handle).await {
                            tracing::warn!(error = %e, "startup roborev ensure failed (non-fatal)");
                        }
                    });
                }
            }
            // Backlog-drainer auto-start (retro feature: make a shipped DMG run the drainer with zero
            // human steps). Mirrors the roborev daemon-ensure above: read the machine-wide [drainer]
            // kill-switch at launch and idempotently INSTALL the LaunchAgent supervisor
            // (scripts/backlog-drainer.sh --install) when ON, or UNINSTALL it when OFF so nothing is
            // scheduled and no worker is ever spawned. ON by default. NEVER clones — if the app-owned
            // sparkle-self checkout isn't present yet, the ensure no-ops and a later launch installs.
            // Best-effort and OFF the startup path (spawn_blocking shells out to bash + launchctl);
            // any failure is swallowed and retried next launch. See drainer.rs for the safety rails.
            {
                let enabled = config::current_effective().config.drainer.enabled;
                match dev_identity::app_data_dir(app.handle()) {
                    Ok(app_data) => {
                        tauri::async_runtime::spawn(async move {
                            let repo = drainer::sparkle_repo_root(&app_data);
                            match tauri::async_runtime::spawn_blocking(move || {
                                drainer::ensure_backlog_drainer_at(&repo, enabled)
                            })
                            .await
                            {
                                Ok(Ok(Some(mode))) => {
                                    tracing::info!(mode, enabled, "backlog-drainer: launch ensure ran")
                                }
                                Ok(Ok(None)) => tracing::debug!(
                                    enabled,
                                    "backlog-drainer: sparkle-self clone not present yet; skipped"
                                ),
                                Ok(Err(e)) => tracing::warn!(
                                    error = %e,
                                    enabled,
                                    "backlog-drainer ensure failed (non-fatal)"
                                ),
                                Err(e) => {
                                    tracing::warn!(error = %e, "backlog-drainer ensure task failed")
                                }
                            }
                        });
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "backlog-drainer ensure skipped (app_data_dir)")
                    }
                }
            }
            // Plugin pre-enable install ensure (bead sparkle-s3g2.1). Writing `enabledPlugins` into
            // each worktree does NOT fetch the plugin — Claude Code only loads one that is actually
            // installed — so run the headless, idempotent `claude plugin install` for the default-on
            // plugins. User scope, so the fetch populates the one shared plugin cache every worktree
            // reads. Ledger-gated (it no-ops once they're in), best-effort, and OFF the startup path:
            // spawned onto the async runtime so a slow network never delays boot, and any failure
            // just leaves the plugin out of the ledger for the next launch to retry.
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    // The command already does its own spawn_blocking, so this just awaits it.
                    // `force: None` — startup must keep the per-process retry suppression; only the
                    // user-initiated toggle bypasses it.
                    match hooks::ensure_default_plugins_installed(handle, None).await {
                        Ok(outcomes) => hooks::log_install_outcomes(&outcomes),
                        Err(e) => tracing::warn!(error = %e, "plugin pre-enable ensure failed (non-fatal)"),
                    }
                });
            }
            // Opt-in Builder Index reporter (bead sparkle-s3g2.6). Started unconditionally — the
            // loop itself re-reads `[tools].builder_index` plus the consent/credential gate on
            // every cycle and posts nothing until all of them pass, so a default install spends
            // its life asleep. Spawning it here (rather than on the toggle) means turning the
            // feature on doesn't need an app restart to take effect.
            builder_index::spawn_reporter(app.handle().clone());
            // The second reporting destination. Independent of the Builder Index in every way —
            // its own flag, sign-in and state file — and equally default-OFF: the loop re-reads
            // `[tools].straude` every cycle and skips without a socket until the user opts in.
            straude::spawn_reporter(app.handle().clone());
            // Show-on-ready backstop (bead sparkle-alrm.5, #10). The main window is created hidden
            // ("visible": false) so no blank frame flashes before React paints; the frontend calls
            // show() on first paint (see main.tsx) and then invokes `notify_frontend_shown`. This
            // thread is the last-resort net for the case the frontend NEVER boots (a fatal bundle/JS
            // error): reveal the window anyway after a grace period so a launch can never leave an
            // invisible, unreachable process. We gate on the frontend-shown FLAG, not instantaneous
            // is_visible(): a user can legitimately hide the main window to the tray within the grace
            // period (Workspace close → win.hide()), and keying off visibility would forcibly
            // re-reveal a window they deliberately hid. If the frontend ever completed its show, the
            // flag is set and we stand down.
            if let Some(win) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(8));
                    if !FRONTEND_SHOWN.load(std::sync::atomic::Ordering::SeqCst) {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                });
            }
            // sparkle-i95d: rebind every persisted orchestration bridge at boot so a build agent's
            // live-worker control (spawn_worker / list_workers) survives an app restart, instead of
            // dangling on an orphaned socket until its pane happens to remount. Unix-only (the socket
            // bridge is #[cfg(unix)]); best-effort — a failure just falls back to the prior lazy-
            // rebind-on-prepare() behavior. Reuses each agent's stable token so a still-running MCP
            // client keeps validating after the rebind.
            #[cfg(unix)]
            {
                match worktree::app_data_dir_pub(app.handle()) {
                    Ok(dir) => {
                        let mgr = app.state::<bridge::BridgeManager>();
                        let n = bridge::reconcile_bridges_at(
                            Some(app.handle().clone()),
                            mgr.inner(),
                            &dir,
                        );
                        if n > 0 {
                            tracing::info!(rebound = n, "orchestration bridges reconciled at boot");
                        }
                    }
                    Err(e) => tracing::warn!("bridge reconcile skipped (app_data_dir): {e}"),
                }
            }
            Ok(())
        })
        // Wrapped rather than passed bare so every command's MAIN-THREAD occupancy is measurable.
        // For a sync command the generated body runs inline here, so the time around `handler` IS
        // the UI freeze it caused; for an async one the handler only spawns, so the same probe
        // reads the dispatch hop alone. Inert unless `SPARKLE_CMD_TIMING` is set. See `cmd_timing`.
        .invoke_handler({
            // The type is spelled out at the BINDING, not just at the call: `generate_handler!`
            // expands to a closure whose parameter type is normally inferred from the
            // `invoke_handler` call it is passed to directly, and binding it to a `let` first
            // removes that inference site. Boxing costs one dynamic dispatch per invoke, which
            // Tauri already pays — `invoke_handler` stores it as `Box::new(...)` regardless.
            #[allow(clippy::type_complexity)]
            let handler: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> =
                Box::new(tauri::generate_handler![
            notify_frontend_shown,
            // The install-on-quit hook for the auto-updater (bead sparkle-1ueh3). See the
            // `updater_quit` module above for why the bundle swap must not happen mid-session.
            note_staged_update,
            note_update_install_started,
            resume_exit_after_update,
            // ASYNC on purpose: it is read from the input-freeze trace, so it must not be able to
            // block on the main thread it exists to report on. See key_window.rs.
            key_window::main_window_key_state,
            cmd_timing::cmd_timing_report,
            // The four-point IPC timeline (bead sparkle-i7ryx). `ipc_clock_probe` must stay a
            // do-nothing command: the renderer times it NTP-style to place its own
            // `performance.now()` stamps on Rust's monotonic axis, and any work in it is
            // indistinguishable from transit delay to that estimator.
            ipc_trace::ipc_clock_probe,
            ipc_trace::ipc_trace_dump,
            ipc_trace::ipc_trace_set_enabled,
            fleet::fleet_digest,
            fleet::fleet_read_hook_stream,
            fleet::fleet_read_transcript,
            // Per-worktree steering files (bead .3) — the project's architecture map
            // and standards, seeded into every agent worktree and injected at pre-flight.
            steering::steering_status,
            steering::steering_read,
            steering::steering_write,
            steering::steering_seed_templates,
            steering::steering_preflight_block,
            inbox::inbox_send,
            inbox::inbox_broadcast,
            inbox::inbox_status,
            inbox::inbox_peek,
            inbox::inbox_claim_for_idle,
            adversarial_review::adversarial_review_run,
            adversarial_review::adversarial_review_status,
            adversarial_review::adversarial_review_verdict,
            // "Concierge Agents" (bead sparkle-s7rfc). `research_dispatch` RETURNS BEFORE THE CHILD
            // FINISHES — that non-blocking property is the feature, and research.rs has a test
            // pinning it. The names are the contract with `RESEARCH_COMMANDS` in
            // src/services/research/store.ts. `research_tail` serves the running task's live-output
            // tail to its main-pane view.
            research::research_dispatch,
            research::research_list,
            research::research_get,
            research::research_tail,
            research::research_cancel,
            research::research_mark_read,
            folder_picker::pick_folder,
            folder_picker::pick_files,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_live_sessions,
            pty::pty_live_epoch,
            // The fleet-resurrection mount. The ledger's commands are thin wrappers over the pure
            // `*_at` cores in agent_life.rs; `revival_due` is a read of a list the revival thread
            // has already computed.
            agent_life::agent_life_open,
            agent_life::agent_life_close,
            agent_life::agent_life_note_wall,
            agent_life::agent_life_read,
            agent_life::agent_life_list,
            agent_life::agent_life_claim,
            agent_life::agent_life_release,
            agent_life::agent_life_retire,
            revival::revival_due,
            pty::pty_set_paused,
            pty::pty_ack,
            nudger::nudger_flags,
            nudger::nudger_clear_flag,
            nudger::nudger_send_escape,
            observed_attention::observed_attention,
            conflict_watch::conflict_flags,
            conflict_watch::conflict_clear_flag,
            conflict_watch::conflict_probe_status,
            memwatch::memory_admission,
            memwatch::agent_memory_watchdog,
            // Live browser preview. Every one is `async fn` + spawn_blocking: a plain `fn` runs
            // INLINE on the AppKit main thread and all of these touch the filesystem or a process.
            preview::preview_capability,
            preview::preview_open,
            preview::preview_stop,
            preview::preview_stop_for_agent,
            dev_port_preflight::dev_port_preflight,
            // Runtime port arbitration (bead `.5`). Every one is `async fn` +
            // spawn_blocking, for the same reason the preview commands above are: they all touch
            // the filesystem and one of them attempts a bind per port in the range.
            port_broker::port_broker_acquire,
            port_broker::port_broker_renew,
            port_broker::port_broker_release,
            port_broker::port_broker_status,
            port_broker::gate_lock_acquire,
            port_broker::gate_lock_release,
            port_broker::gate_lock_status,
            preview::preview_status,
            preview::preview_list,
            preview_capture::preview_screenshot,
            preview_capture::preview_query_dom,
            preflight::claude_preflight,
            preflight::claude_version,
            preflight::claude_session_info,
            preflight::claude_session_accounts,
            preflight::concierge_session_info,
            preflight::refresh_preflight,
            preflight::node_preflight,
            preflight::git_preflight,
            preflight::prereqs_preflight,
            preflight::roborev_preflight,
            preflight::lsp_preflight,
            // The verify-before-PR gate (verify_gate.rs, bead .1): run CI's checks
            // locally in the agent's worktree, keep the evidence, render the PR Testing section.
            verify_gate::verify_gate_run,
            verify_gate::verify_gate_status,
            verify_gate::verify_gate_report,
            verify_gate::verify_gate_attach_evidence,
            verify_gate::verify_gate_testing_markdown,
            preflight::project_lsp_preflight,
            ticket_intake::ticket_intake_parse,
            ticket_intake::ticket_intake_fetch,
            ticket_intake::ticket_intake_status,
            ticket_intake::ticket_intake_image,
            // 1Password .env backup/restore — implements src/services/onepassword.ts.
            onepassword::op_preflight,
            onepassword::op_refresh,
            onepassword::op_install,
            onepassword::op_vaults,
            onepassword::env_scan,
            onepassword::op_list_backups,
            onepassword::op_backup,
            onepassword::op_restore,
            onepassword::op_seed_worktree,
            onepassword::env_dirs_exist,
            onepassword::env_seed_from_checkout,
            setup::install_node,
            setup::install_claude_code,
            setup::install_git,
            setup::install_roborev,
            setup::deactivate_roborev,
            setup::roborev_auth_selftest,
            // roborev's review QUEUE, as opposed to its install lifecycle above — the commands
            // behind the concierge's `review` domain. See review_cmd.rs.
            review_cmd::roborev_list_findings,
            review_cmd::roborev_show_finding,
            review_cmd::roborev_close_finding,
            setup::install_lsp_server,
            claude_chat::claude_chat_send,
            claude_chat::claude_chat_cancel,
            sparkle_improve::sparkle_improve_run,
            sparkle_improve::sparkle_improve_cancel,
            sparkle_improve::sparkle_improve_active,
            concierge::concierge_turn,
            concierge::concierge_cancel,
            concierge::concierge_proactive_turn,
            concierge_inbox::concierge_inbox_ack,
            // The cross-agent + human @mention channel (bead sparkle-hdlhox). `mention_send` routes a
            // mention to @improve/@sparkle: it posts the CONTENT to the bead, doorbells the target's
            // inbox (content-free), and WAKES the target — spawning a scoped @improve responder, or
            // emitting `concierge://mention` for a frontend listener to turn into an immediate
            // concierge turn. `mention_status` reads the bead's ACK so silence past a deadline reads
            // as UNDELIVERED. See mention.rs.
            mention::mention_send,
            mention::mention_ack,
            mention::mention_reply,
            mention::mention_status,
            claude::claude_has_session,
            claude::claude_latest_session_id,
            claude::claude_latest_session_path,
            claude::agent_session_title,
            model_catalog::list_claude_models,
            // Multi-display window spanning (Appearance → Window).
            display_span::display_layout,
            display_span::span_window,
            display_span::fit_window_to_current_display,
            display_span::reset_window_size,
            screenshot::capture_screen_region,
            window_screenshot::capture_main_window,
            window_screenshot::capture_main_window_region,
            drag_paths::recover_drag_paths,
            attachments::load_attachment,
            attachments::probe_attachment,
            attachments::copy_image_to_clipboard,
            attachments::copy_file_to,
            attachments::copy_files_to_dir,
            worktree::ensure_project_repo,
            worktree::install_repo_hooks_cmd,
            worktree::remove_repo_hooks_cmd,
            worktree::prewarm_spawn,
            worktree::warm_worktree_pool,
            worktree::create_agent_worktree,
            worktree::park_worktree_on_base,
            worktree::acquire_worktree_lease,
            worktree::release_worktree_lease,
            worktree::create_worker_worktree,
            worktree::remove_agent_worktree,
            worktree::move_project,
            worktree::assert_workspace_integrity,
            worktree::install_worktree_guard,
            deps_bootstrap::bootstrap_worktree_deps,
            hooks::install_agent_hooks,
            hooks::heal_agent_hooks,
            // The durable mirror of an agent's goal, for the SessionStart hook that reads it back to
            // an agent waking with no session context (docs/agent-goal-record.md).
            agent_goal_record::write_agent_goal_record,
            agent_goal_record::list_agent_goal_records,
            agent_goal_record::delete_agent_goal_record,
            // The persistent concurrency + per-agent-memory record (docs/peak-concurrency.md):
            // nothing else in the app writes a peak down, and one that resets on relaunch is
            // worthless. MEASURES ONLY — it changes no ceiling (sparkle-mjmuj).
            peak_concurrency::record_agent_concurrency,
            peak_concurrency::agent_concurrency_peak,
            hooks::ensure_default_plugins_installed,
            hooks::plugin_install_outcomes,
            hooks::read_events_since,
            worktree::project_default_branch,
            worktree::project_repo_key,
            worktree::reconcile_default_branch,
            worktree::agent_branch_status,
            repo_freshness::repo_root_staleness,
            repo_freshness::repo_fresh_read,
            repo_freshness::repo_stale_diagnose,
            repo_freshness::repo_stale_remedy,
            repo_freshness::repo_auto_fast_forward,
            worktree::diff_files,
            worktree::diff_file_text,
            worktree::diff_commits,
            worktree::agent_workflow_state,
            // THE ON-DEMAND LANDING PROBE, used ONLY by `set_agent_goal_met` — never by the roster
            // hot path above, whose window-local reader is deliberately git-free. Registered in the
            // SAME line-edit as the module, because an unregistered command still compiles clean and
            // fails only at invoke time (see the note further down about `generate_handler!`), and a
            // silent rejection here reads as "we could not tell", which is precisely the state that
            // leaves a finished agent unable to close its goal.
            goal_landed_probe::agent_landed_probe,
            worktree::project_agents_status,
            worktree::project_open_pr_count,
            worktree::project_pr_list_url,
            worktree::project_open_prs,
            worktree::pr_owner,
            // The retirement gate's durable "did this agent report back" store (sparkle-0l9xk).
            // Registered in the SAME commit as the module: a missing registration only fails at
            // invoke time, and this one is read on every status poll.
            retro_receipt::retro_receipt_record,
            retro_receipt::retro_receipt_get,
            retro_receipt::retro_receipt_all,
            worktree::merge_pr,
            // The read side of the merge gate `merge_pr` enforces. Registered in the SAME commit as
            // the module: a missing registration only fails at invoke time.
            knightwatch::knightwatch_probe_gate,
            worktree::dismiss_pr,
            worktree::restore_pr,
            worktree::pr_dismissals,
            worktree::land_agent_branch,
            worktree::push_agent_branch,
            worktree::commit_worktree_wip,
            worktree::autosave_worktree_wip,
            worktree::delete_agent_branch,
            worktree::delete_agent_branch_if_merged,
            worktree::open_agent_pr,
            promotion::promotion_preflight,
            promotion::promotion_head_sha,
            promotion::promotion_commit_dirty,
            promotion::promotion_push_branch,
            promotion::promotion_read_transcript,
            // Demotion's two halves. BOTH must be here: a missing registration fails at invoke
            // time, mid-demotion, with a live sandbox billing — the worst place to find out.
            demotion::demotion_land_branch,
            demotion::demotion_write_transcript,
            worktree::markdown_changed_since,
            worktree::refresh_agent_branch,
            worktree::read_worker_result,
            worktree::write_worker_manifest,
            worktree::read_worker_manifest,
            worktree::scan_worker_manifests,
            roborev_probe::roborev_branch_probe,
            roborev_probe::roborev_job_review,
            pipeline_health::pipeline_health_probe,
            pr_claims::pr_claim_set,
            pr_claims::pr_claim_release,
            pr_claims::pr_claims_list,
            // The one-driver-per-PR lease for auto-dispatched `/babysit-pr`. A neighbour of
            // `pr_claims` in the list and nothing else: a claim is a courtesy, this is a lock.
            // Registered in the SAME commit as the module — a missing registration only fails at
            // invoke time, which for a lock means the caller cannot tell "refused" from "absent".
            babysit_lease::babysit_lease_acquire,
            babysit_lease::babysit_lease_heartbeat,
            babysit_lease::babysit_lease_release,
            babysit_lease::babysit_leases,
            sparkle_agent::ensure_sparkle_repo,
            drainer::ensure_backlog_drainer,
            drainer::read_drainer_queue,
            drainer::ack_drainer_queue_file,
            sparkle_agent::reap_secondary_sparkle_worktrees,
            sparkle_agent::sparkle_submit_capability,
            // Per-project concierge tool policy: the frontend's synchronous slug cache is filled
            // from here. Without this registration `repoSlug.ts` resolves every root to null,
            // which reads as FOREIGN and floors merge-class tools at `ask` everywhere.
            sparkle_agent::commands::repo_slug_for_root,
            github::github_status,
            github::github_list_repos,
            github::github_clone_repo,
            github::github_default_project_dir,
            dictation::commands::start_dictation,
            dictation::commands::stop_dictation,
            dictation::commands::start_cloud_stream,
            dictation::commands::stop_cloud_stream,
            dictation::commands::preconnect_cloud_stream,
            dictation::commands::list_audio_inputs,
            dictation::commands::get_audio_input_settings,
            dictation::commands::set_audio_input,
            dictation::commands::set_allow_virtual_input,
            logging::app_version,
            logging::log_dir,
            logging::reveal_logs,
            logging::frontend_log,
            naming::generate_agent_name,
            connectivity::probe_connectivity,
            chief::chief_pat,
            chief::chief_pat_secure_get,
            chief::chief_pat_secure_set,
            chief::chief_pat_secure_clear,
            // The publish destination's bearer token (bead `sparkle-131ms.3`). Same keychain
            // pattern as the Chief PAT above. An UNREGISTERED #[tauri::command] produces zero
            // compile errors and fails only at runtime, which is what
            // scripts/lib/tauri-handler-guard.sh enforces in both directions.
            publish_credential::publish_token_set,
            publish_credential::publish_token_clear,
            publish_credential::publish_token_source,
            publish_credential::publish_token_present,
            // The capability probe and the destination transport (bead `sparkle-131ms.5`). All
            // three are `pub async fn` with the network call in `spawn_blocking`, so no
            // cmd_timing.rs EXEMPT entry is needed and the main thread never blocks on a remote
            // host. The bearer never crosses this boundary — `token_for_destination` is read
            // inside the command and scrubbed out of every error string.
            publish_capabilities::destination_probe,
            publish_capabilities::destination_list_tools,
            publish_capabilities::destination_call_tool,
            bridge::start_orchestration_bridge,
            bridge::stop_orchestration_bridge,
            bridge::orchestration_respond,
            bridge::orchestrator_mcp_paths,
            bridge::start_control_bridge,
            bridge::start_concierge_control_bridge,
            bridge::stop_control_bridge,
            bridge::control_respond,
            bridge::control_mcp_paths,
            notes::append_note,
            notes::create_bead,
            notes::write_prd,
            notes::read_prd,
            notes::copy_capture_asset,
            notes::list_beads,
            notes::blocked_beads,
            notes::ensure_beads_db,
            notes::bead_show,
            notes::create_bead_full,
            notes::bead_dep_add,
            notes::bead_label,
            notes::bead_priority,
            notes::bead_comment,
            notes::delete_bead,
            notes::concierge_memory_remember,
            notes::concierge_memory_recall,
            notes::concierge_memory_forget,
            notes::bead_claim,
            notes::bead_unclaim,
            notes::bead_close,
            // The typed/capped planning surface (services/beadsCommands.ts). Distinct from the
            // notes::* commands above, which stay the board's raw-JSON path — see beads_cmd.rs.
            beads_cmd::beads_query,
            beads_cmd::beads_detail,
            beads_cmd::beads_create,
            beads_cmd::beads_update,
            beads_cmd::beads_close,
            beads_cmd::beads_comment,
            // An epic's PRD path as structured bd metadata rather than prose scraped out of the
            // description (bead `sparkle-xelans.5`). See epic_prd.rs for why this is metadata and
            // not the persisted-store shape `epicGoal` picked.
            epic_prd::set_epic_prd,
            epic_prd::list_epic_prd,
            // Re-parent a SET of beads onto an epic in ONE bd invocation, or off their epic
            // when `parent` is empty (bead sparkle-xelans.2). Same registration hazard as
            // every line here — an unregistered command still compiles clean and fails only
            // at runtime; `scripts/lib/tauri-handler-guard.sh` is the check.
            beads_cmd::beads_reparent,
            // The integration assistant (bead .2): plan a safe merge order across
            // several ready branches, gate each on scripts/pr-checks.sh + roborev, and merge only
            // what the gate calls ready. Registered as ONE contiguous block; an unregistered
            // command still compiles clean and fails only at runtime, which is what
            // `scripts/lib/tauri-handler-guard.sh` exists to catch.
            integration_assistant::integration_plan,
            integration_assistant::integration_gate,
            integration_assistant::integration_merge,
            integration_assistant::integration_status,
            ai::anthropic_chat,
            // The planner's model id, so the second-model advisor pass can resolve a DIFFERENT one
            // rather than hardcoding a copy of it (bead `sparkle-revqiv`).
            ai::planner_chat_model,
            judge::judge_turn_followup,
            // OUT OF BAND: called AFTER an auto-send has already gone, purely to record what Haiku
            // would have graded the utterance. It never gates a send — see auto_send_tuner's header
            // for the measured 15–27s that settles that.
            auto_send_tuner::auto_send_tuner_classify,
            history::history_record,
            history::history_search,
            history::history_prune,
            // The thread scrubber rail's two time-indexed reads (bead sparkle-7m719): the dots for
            // the rail, and the backlog page the thread loads when the rail is dragged past the
            // live 200-message window.
            //
            // DROPPING A LINE HERE IS CAUGHT BY NOTHING AT COMPILE TIME. `generate_handler!` does
            // not call the fn; it invokes a macro emitted beside the definition, so an unregistered
            // command is still a valid `pub fn`, the crate builds with zero errors and zero
            // warnings, and the frontend's `invoke()` fails only at RUNTIME with "command not
            // found". These two were in fact missing for four commits of this branch — every rail
            // query rejected, and both callers turn a rejection into an empty result, which is
            // indistinguishable from "no history". `scripts/lib/tauri-handler-guard.sh` is the
            // check; run it rather than trusting a green build.
            history::history_prompts_in_range,
            history::history_entries_in_range,
            // Defects 3 and 7 of bead sparkle-bjbhw6: the scope menu's TRUE extent ("All —
            // since Aug 12"), and the bucketed density the rail is drawn FROM so it can represent
            // every prompt in range without loading every row into the renderer. Same
            // registration hazard as the two lines above — unregistered still compiles clean.
            history::history_extent,
            history::history_prompt_density,
            transcript::read_transcript_last_assistant,
            // Mounted-agent conversation: bounded backwards paging + incremental tailing of the
            // agent's own Claude Code JSONL transcripts.
            transcript::agent_transcript_page,
            transcript::agent_transcript_tail,
            // The session-filtered resolve for the concierge's tool read (tier d). Distinct from
            // `claude::claude_latest_session_path`, which is the unfiltered LEARN seam — see
            // `agent_own_session_path`'s doc for why they are two commands and not one with a mode.
            transcript::agent_own_session_path,
            // Resolution only — where an agent's hook log lives, so the mounted pane can
            // recover a session binding without reconstructing an app-data path itself.
            hooks::agent_event_log_path,
            spend::spend_report,
            builder_index::builder_index_status,
            builder_index::builder_index_set_identity,
            builder_index::builder_index_forget,
            builder_index::builder_index_report_now,
            straude::straude_status,
            straude::straude_login_begin,
            straude::straude_login_poll,
            straude::straude_consent,
            straude::straude_forget,
            straude::straude_report_now,
            auth::desktop_has_token,
            auth::desktop_bearer_token,
            auth::desktop_pair_code,
            auth::list_paired_devices,
            auth::revoke_paired_device,
            auth::desktop_sign_out,
            auth::desktop_begin_signin,
            auth::desktop_exchange_code,
            auth::desktop_me,
            auth::desktop_consume,
            auth::desktop_refund,
            auth::desktop_redeem_promo,
            auth::desktop_redeem_coupon,
            auth::desktop_topup_checkout,
            auth::desktop_credit_history,
            auth::desktop_auto_topup_get,
            auth::desktop_auto_topup_set,
            auth::desktop_take_pending_deeplink,
            crash::flush_crash_reports,
            support::read_recent_logs,
            support::support_metadata,
            stale_build::stale_build_probe,
            support::support_chat_send,
            support::desktop_create_ticket,
            support::desktop_list_tickets,
            attention::set_window_attention,
            attention::notify_attention,
            watchdog::watchdog_heartbeat,
            attention_summary::summarize_attention,
            accounts::accounts_list,
            accounts::ensure_project_trusted,
            accounts::accounts_add,
            accounts::accounts_set_nickname,
            accounts::accounts_remove,
            accounts::accounts_import_default,
            accounts::accounts_mark_exhausted,
            accounts::accounts_usage,
            accounts::accounts_spend,
            accounts::accounts_identities,
            accounts::accounts_limit_events,
            accounts::accounts_ceilings,
            accounts::claude_signed_in,
            accounts::claude_auth_status,
            account_ledger::accounts_record_spawn,
            account_ledger::accounts_spawn_log,
            account_usage::account_usage_live,
            account_usage::account_set_oauth_token,
            accounts::account_record_oauth_identity,
            trial::trial_status,
            trial::trial_start,
            // The hot path. `trial_increment` (a device-local bump) is deliberately GONE: the
            // counter is server-side now, so there is no JS-callable way to move it locally.
            trial_remote::trial_sync,
            trial_remote::trial_consume,
            config::get_config,
            config::config_file_paths,
            config::set_config_value,
            config::set_config_values,
            config::unset_config_value,
            config::set_project_config_value,
            config::unset_project_config_value,
            config::write_config_text,
            config::reset_config,
            config::read_config_text,
            config::set_stage_definition,
            // The concierge communication guidelines file — same read/write/reveal shape as the
            // config commands above, because it is the same kind of thing: a user-owned file the
            // app both edits in-app and injects at runtime.
            concierge_guidelines::read_concierge_guidelines,
            concierge_guidelines::write_concierge_guidelines,
            concierge_guidelines::append_concierge_guideline,
            concierge_guidelines::concierge_guidelines_path,
            // The reply linter's violation log. METADATA ONLY (never reply text, never the matched
            // span) — the constraint `services/conciergeAudit.ts` established for concierge text on
            // disk. Returns `()`: logging a violation must never be able to fail the reply path.
            concierge_lint_log::concierge_lint_log,
            delivery::collect_delivery_evidence,
            delivery::tag_contains_commit,
            roster::publish_window_roster,
            roster::clear_window_roster,
            roster::get_roster,
            roster::quit_app,
            main_window::show_main_window,
            helper::publish_helper_vitals,
            helper::get_helper_vitals,
            helper::show_helper,
            helper::hide_helper,
            helper::set_helper_bounds,
            // Pushes the island's persisted `enabled` back onto the native View menu's label. The
            // flag lives in localStorage, which Rust cannot read — the webview is the authority.
            app_menu::set_helper_menu_state,
            // The Living Sparkle Overlay's tray presence and launch-at-login (bead sparkle-uz87.9).
            // `overlay_tray_sync` is the ONLY path to a menu-bar icon in this app and it fails
            // closed, so with the gate shut these are reachable and inert.
            overlay_tray::overlay_tray_sync,
            overlay_tray::overlay_tray_gate_open,
            overlay_tray::overlay_auto_launch_set,
            overlay_tray::overlay_auto_launch_is_enabled,
            frontmost::get_frontmost,
            capture_window::show_capture_window,
            capture_window::hide_capture_window,
            capture_window::is_capture_open,
            project_window::open_project_window,
            project_window::set_project_window_bounds,
            project_window::close_project_window
                ]);
            move |invoke| cmd_timing::measure(invoke, &handler)
        })
        .build(tauri::generate_context!())
        .expect("error while building Sparkle")
        .run(|app, event| match event {
            // macOS: clicking the Dock icon when all windows are hidden/closed ("Reopen") must
            // bring a window back — otherwise a last-window "keep agents running" hide is
            // unreachable except via Cmd+Q (see multi-window design, decision #4).
            // `RunEvent::Reopen` is a macOS-only variant (no Dock on Windows/Linux), so the arm is
            // gated — without the cfg it's a hard compile error (E0599) off macOS.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { has_visible_windows, .. } => {
                // IGNORE AppKit's `has_visible_windows` and ask our own windows instead. The helper
                // island and the capture takeover are real NSWindows (non-activating panels), and
                // the island is visible EXACTLY when Sparkle is not frontmost — which is the state
                // the user is in when they click the Dock icon. AppKit therefore reports YES, the
                // guard short-circuited, and the Dock icon did nothing at all once the main window
                // had been hidden. `any_app_window_visible` counts only real app windows.
                if main_window::should_reveal_on_reopen(
                    has_visible_windows,
                    frontmost::any_app_window_visible(app),
                ) {
                    main_window::reveal(app);
                }
            }
            // Stop dictation capture before the process tears down (). RunEvent::Exit
            // fires as the event loop leaves, BEFORE the static-destructor / exit() phase where a
            // still-live CoreAudio callback otherwise raced teardown and aborted ().
            // Dropping the cpal stream here quiesces the audio IOThread first. Idempotent, so a
            // no-active-capture exit is a cheap no-op.
            // Hold the exit open just long enough for the webview to install a DOWNLOADED-but-
            // not-yet-installed update, so the bundle on disk is replaced ~a second before this
            // process stops rather than hours before it (bead sparkle-1ueh3). No-ops unless the
            // frontend has said something is staged. See the `updater_quit` module for which quits
            // reach here — ⌘Q included, via the replacement Quit item app_menu.rs installs — and why
            // the watchdog has two phases.
            tauri::RunEvent::ExitRequested { ref api, .. } => {
                // The webview gate is inside `should_defer_exit`, and it is `&&`-first so a
                // last-window-destroyed exit — which arrives here with the window already out of
                // the map — declines WITHOUT consuming the single claim. See that function.
                let has_webview = !app.webview_windows().is_empty();
                if updater_quit::should_defer_exit(has_webview) {
                    match app.emit(updater_quit::INSTALL_BEFORE_EXIT_EVENT, ()) {
                        Ok(()) => {
                            api.prevent_exit();
                            tracing::info!(
                                "exit deferred so the staged update installs as this process goes away"
                            );
                            let handle = app.clone();
                            std::thread::spawn(move || {
                                // The two-phase sequence lives in `run_exit_watchdog`, which a test
                                // drives with fake effects: the ORDER of its calls IS the safety
                                // property, and it used to be covered by nothing. Supplied here are
                                // only the two things it cannot own.
                                updater_quit::run_exit_watchdog(
                                    &mut |ms| {
                                        std::thread::sleep(std::time::Duration::from_millis(ms))
                                    },
                                    &mut || handle.exit(0),
                                );
                            });
                        }
                        Err(e) => tracing::warn!(
                            "could not ask the webview to install the staged update: {e}"
                        ),
                    }
                } else if updater_quit::hold_second_exit() {
                    // A SECOND quit landed while the bundle swap is running. Dying here can leave
                    // /Applications/Sparkle.app between `remove_dir_all` and the final rename —
                    // i.e. GONE. Hold it; the webview's resume or the watchdog releases it, and
                    // both announce themselves first so they are never caught by this arm.
                    api.prevent_exit();
                    tracing::warn!(
                        "quit requested again while the staged update is installing; holding the \
                         exit until the bundle swap finishes"
                    );
                }
            }
            tauri::RunEvent::Exit => {
                app.state::<dictation::DictationState>().stop_capture();
                // Record + kill any in-flight improve pass here rather than in `Drop`: on macOS
                // this arm fires before `process::exit()`, whereas managed state is leaked (never
                // dropped) on the ordinary Cmd+Q path, so the `app-teardown` log line — and the
                // group kill that stops a detached pass from outliving the app — only actually
                // happen when driven from here. `Drop` remains an idempotent backstop.
                app.state::<sparkle_improve::SparkleImproveManager>().end_in_flight_pass();
                // Same reasoning: a scoped @mention responder is a headless `claude -p` in the
                // canonical worktree; kill it here so it can't outlive the app. The slot is a module
                // global (no managed state), so this is a free call. Idempotent when none is running.
                mention::end_in_flight_responders();
                // Same reasoning, same path: a preview's dev server is a supervised child spawned
                // OUTSIDE a PTY, so nothing else would ever stop it. `Drop` on the manager is the
                // idempotent backstop for the paths that actually drop.
                app.state::<preview::PreviewManager>().stop_all();
                // Leave the per-command main-thread table behind when the probe was armed, so a
                // measurement run does not depend on someone calling `cmd_timing_report` before
                // quitting. No-op when disarmed (the default).
                cmd_timing::log_report_on_exit();
                // LAST CHANCE TO WRITE UNCOMMITTED AGENT WORK DOWN (bead sparkle-upnz, R5 of
                // `PRD/sparkle/restart-work-recovery.md`). The shell-layer `Stop` hook checkpoints
                // an agent's uncommitted work when its TURN ENDS; a quit or restart landing
                // mid-turn takes everything written since that boundary, from every agent at once
                // — and `agent_life.rs` measures app restart as the largest single killer of
                // agents here. This arm is the broader of the two exit arms (the macOS
                // `terminate:` path reaches `Exit` and never `ExitRequested`; see the
                // `updater_quit` header), and it still runs before `process::exit()`.
                //
                // Bounded by ONE shared deadline (`teardown_guard::DEFAULT_BUDGET`) because this is
                // the main thread on the way out: blowing the budget costs coverage, which the
                // module reports, and never a quit that will not finish.
                teardown_guard::run_on_exit(app);
            }
            _ => {}
        });
}
