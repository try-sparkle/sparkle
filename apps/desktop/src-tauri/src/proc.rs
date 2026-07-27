//! Shared child-process primitives: killing a whole process TREE, and joining the threads that
//! drain its pipes without ever blocking forever.
//!
//! Why this module exists: four call sites had grown byte-identical copies of the same
//! `unsafe libc::kill(-pid, SIGKILL)` helper (`sparkle_improve`, `concierge`, `worktree`, `setup`),
//! one of them already commented as "local copy of sparkle_improve.rs's kill_pass_group". A future
//! change to the kill policy — SIGTERM-then-SIGKILL, guarding `pgid == 0`, logging the errno — would
//! have had to land in four places, which is how the copies silently diverge.

use std::process::Child;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Kill `child` AND every process it spawned, then reap it.
///
/// `Child::kill` reaches only the DIRECT child. A grandchild it forked (a `git clone` under
/// `claude plugin install`, an npm helper, a test runner under a headless pass) survives, keeps the
/// inherited stdout/stderr write ends open, and can go on mutating a worktree we believe is idle.
///
/// On unix this signals the whole process GROUP, which requires the child to have been spawned with
/// `process_group(0)`. **Callers that do not set that are signalling OUR OWN group**, so every
/// caller of this function must set it at spawn. The direct `kill` afterwards is the fallback for
/// the non-unix path and for the (never-expected) case the group signal failed.
pub fn kill_process_group(child: &mut Child) {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        // Negative pid = the whole process group (set via process_group(0) at spawn).
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Wait up to `grace` for every handle to finish. Returns true when they ALL did.
///
/// The return value is the point: a `false` means at least one pipe is still held open by something
/// we couldn't reach, so whatever the caller collected is INCOMPLETE and it must say so rather than
/// hand a plausible-looking partial answer to a parser. Abandoned threads are detached, not leaked
/// forever — each ends as soon as the last write end of its pipe closes.
pub fn await_threads(handles: &[&JoinHandle<()>], grace: Duration) -> bool {
    let deadline = Instant::now() + grace;
    loop {
        if handles.iter().all(|h| h.is_finished()) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn await_threads_reports_completion_and_gives_up_at_the_grace() {
        let done = std::thread::spawn(|| {});
        // Poll until it's actually finished so the "all done" case isn't a race.
        assert!(await_threads(&[&done], Duration::from_secs(5)));

        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let blocked = std::thread::spawn(move || {
            let _ = rx.recv();
        });
        let started = Instant::now();
        assert!(
            !await_threads(&[&blocked], Duration::from_millis(120)),
            "a thread still running at the grace must report INCOMPLETE, not silently pass"
        );
        assert!(started.elapsed() >= Duration::from_millis(100), "it must actually wait");
        assert!(started.elapsed() < Duration::from_secs(2), "…and not much longer");
        drop(tx);
        let _ = blocked.join();
    }
}
