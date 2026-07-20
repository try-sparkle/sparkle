//! macOS microphone authorization (TCC) — the runtime grant, which is NOT the same thing as the
//! entitlement.
//!
//! Why this module exists. `audio.rs` opens the mic through cpal/CoreAudio, and for a user who
//! DENIED the microphone prompt every one of those calls SUCCEEDS: `default_input_device()` returns
//! a device (device enumeration is not gated by TCC), `default_input_config()` is Ok,
//! `build_input_stream` is Ok, and `stream.play()` is Ok. CoreAudio then delivers buffers of
//! ZEROS, forever. So `Capture::start` reports success, no `dictation://error` is ever emitted,
//! `rms_level` stays 0.0, the VAD never fires, and the app sits waiting for a wake word it can
//! never hear. The mic is dead and nothing anywhere says so. The only way to know is to ask TCC
//! directly, which is what this module does.
//!
//! Note what this is NOT: `Info.plist`'s NSMicrophoneUsageDescription (the prompt STRING) and the
//! `com.apple.security.device.audio-input` entitlement are both already correct and shipped —
//! `audio.rs`'s `hardened_runtime_build_grants_microphone_entitlement` test guards the latter.
//! Those two get you the RIGHT to ask. This module is about the ANSWER.
//!
//! The four states, and why two of them are not one:
//!   - NotDetermined: never asked. The OS will show the prompt on `requestAccess`. Sending this
//!     user to System Settings is a real trap — Sparkle has no entry in the Microphone pane yet,
//!     so there is literally nothing there for them to switch on.
//!   - Denied / Restricted: asked and refused, or forbidden by policy (Screen Time / MDM). The OS
//!     will NEVER prompt again — `requestAccess` returns false immediately without any UI. System
//!     Settings is the ONLY remedy, so it must be what we say.
//!   - Authorized: proceed, and do nothing else (see `decide`).
//!
//! `decide` is the whole policy, kept pure and platform-free so it can be tested exhaustively —
//! the real TCC status can't be faked in a unit test, so the decision is isolated from the query.
#![allow(dead_code)] // the non-macOS build reaches only part of this surface

/// The TCC authorization state for the microphone. Mirrors AVFoundation's `AVAuthorizationStatus`
/// (0…3), but as our own type so the pure `decide` below carries no platform dependency.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicAuth {
    NotDetermined,
    Restricted,
    Denied,
    Authorized,
}

/// What to DO about a given `MicAuth`. The whole point of the split: `Request` and `Blocked` are
/// different remedies and confusing them is the UX trap this module is here to avoid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicGate {
    /// Authorized — arm the mic exactly as before. No prompt, no state change, no extra work.
    Proceed,
    /// NotDetermined — trigger the OS prompt. Do NOT send the user to System Settings.
    Request,
    /// Denied/Restricted — the OS will never prompt again; surface this error, which the frontend's
    /// `classifyVoiceError` routes to its `permission` bucket (System Settings remedy).
    Blocked(&'static str),
}

// The error strings that reach `dictation://error`.
//
// These are CONTRACT, not prose: `voice/dictationCopy.ts`'s `classifyVoiceError` only routes a
// string to its `permission` bucket when it matches a MIC CONTEXT (microphone/mic/audio/…) AND a
// DENIAL (permission/denied/not authoriz/privacy/tcc/…) — deliberately both, so a bare
// "Permission denied (os error 13)" from a failed model-dir write can't send the user off to
// fiddle with microphone privacy. Each string below therefore names the microphone AND the denial
// explicitly, and must avoid the earlier-matching buckets' words ("no microphone" would hit
// no-device; "download"/"connection"/"tls" would hit download; "GB free" would hit disk-space).
// `dictationCopy.test.ts` pins each of these verbatim — change one here, change it there.

/// The user said No to the prompt (or had already). The OS will not ask again.
pub const DENIED_ERROR: &str =
    "Microphone access denied: macOS privacy settings are blocking Sparkle's microphone (TCC).";

/// Screen Time / MDM / parental controls forbid mic capture. Says "not authorized" rather than
/// "restricted" because the classifier's DENIAL set has no word for "restricted" — and widening
/// that set to add one would weaken the guard that keeps unrelated denials out of this bucket.
pub const RESTRICTED_ERROR: &str =
    "Microphone access restricted: Sparkle is not authorized to use the microphone \
     — a device policy (Screen Time or MDM) blocks it.";

/// We prompted and gave up waiting for an answer (see `request_access_blocking`'s timeout).
///
/// Unlike the two above, this one deliberately does NOT reach the `permission` bucket, and the
/// wording is what keeps it out (no denial word — "prompt"/"unanswered" are in neither the DENIAL
/// set nor any earlier bucket, so it falls through to `unknown`, which shows this text verbatim).
/// That is the correct destination: the status here is still NotDetermined, so the Privacy pane
/// has no Sparkle entry to switch on — sending them there is the very trap this module exists to
/// avoid, and it would be a dead end. The real remedy is to click the mic again, which re-prompts,
/// so the text says exactly that (roborev 37736).
pub const NOT_ANSWERED_ERROR: &str =
    "The microphone prompt went unanswered. Click the mic to try again.";

/// The entire policy, pure and exhaustive. Kept free of any platform call so the mapping can be
/// unit-tested for every state (the real TCC status cannot be faked in a test).
pub fn decide(status: MicAuth) -> MicGate {
    match status {
        MicAuth::Authorized => MicGate::Proceed,
        MicAuth::NotDetermined => MicGate::Request,
        MicAuth::Denied => MicGate::Blocked(DENIED_ERROR),
        MicAuth::Restricted => MicGate::Blocked(RESTRICTED_ERROR),
    }
}

// ---------------------------------------------------------------------------
// Platform query
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod platform {
    use super::MicAuth;
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};

    /// Read TCC's current answer. Cheap (a process-local cached read — no IPC, no UI) and callable
    /// from any thread, which is why the Authorized fast path below costs the founder nothing.
    pub fn status() -> MicAuth {
        // SAFETY: `AVMediaTypeAudio` is an immortal framework string constant, and
        // `authorizationStatusForMediaType:` is a thread-safe class method that only reads state.
        let raw = unsafe {
            let Some(media_type) = AVMediaTypeAudio else {
                // AVFoundation didn't load. Don't invent a denial out of a framework problem —
                // fall through to cpal, which will report its own (real) error if it fails.
                // Logged because this fallback lands the user back in exactly the silent-dead-mic
                // behavior this module exists to end, so it must at least be diagnosable from a log
                // rather than indistinguishable from a genuine grant (roborev 37736).
                tracing::warn!(
                    target: "dictation",
                    "AVMediaTypeAudio unavailable — cannot read the microphone's TCC status; \
                     proceeding as if authorized (a denied mic will capture silence undetected)",
                );
                return MicAuth::Authorized;
            };
            AVCaptureDevice::authorizationStatusForMediaType(media_type)
        };
        match raw {
            AVAuthorizationStatus::NotDetermined => MicAuth::NotDetermined,
            AVAuthorizationStatus::Restricted => MicAuth::Restricted,
            AVAuthorizationStatus::Denied => MicAuth::Denied,
            AVAuthorizationStatus::Authorized => MicAuth::Authorized,
            // A status Apple adds later. Treating an unknown as Denied would brick the mic on a
            // future macOS; treat it as "let cpal try" instead — that is the pre-existing behavior.
            // Logged with the raw value for the same reason as above: if a future macOS renumbers
            // or extends this enum, this line is the only thing that will say so.
            other => {
                tracing::warn!(
                    target: "dictation",
                    "unrecognized AVAuthorizationStatus {:?} — proceeding as if authorized",
                    other,
                );
                MicAuth::Authorized
            }
        }
    }

    /// Trigger the OS prompt and BLOCK until the user answers.
    ///
    /// THREADING — the load-bearing part. `requestAccessForMediaType:completionHandler:` returns
    /// immediately and invokes the handler later on an ARBITRARY dispatch queue, while the prompt
    /// itself is presented by the OS on the main run loop. So this function must never run on the
    /// main thread: blocking there would stall the very run loop that has to draw the prompt the
    /// block is waiting on — a self-deadlock where the app hangs with no dialog ever appearing.
    /// The only caller is `dictation.rs`'s arm path, from inside `tauri::async_runtime::
    /// spawn_blocking` (the same convention its model load already uses), so the main thread stays
    /// free to present the dialog and the event loop keeps running while the user reads it.
    ///
    /// The channel is the rendezvous: the handler thread sends, this thread receives. `Sender` is
    /// `Send`, so it is safe to hand to a block invoked from a queue we don't control.
    pub fn request_access_blocking() {
        use block2::RcBlock;
        use std::sync::mpsc;
        use std::time::Duration;

        let (tx, rx) = mpsc::channel::<()>();
        // The handler is called exactly once, but the block type is `Fn`, so `send`'s `&self` (and
        // a dropped receiver's `Err`, if we timed out first) both have to be tolerated — hence the
        // ignored result rather than an unwrap that would panic on a queue we don't own.
        let handler = RcBlock::new(move |_granted: objc2::runtime::Bool| {
            let _ = tx.send(());
        });
        // SAFETY: immortal framework string constant + a block that outlives the call (RcBlock is
        // retained by AVFoundation for the duration of the request).
        unsafe {
            let Some(media_type) = AVMediaTypeAudio else { return };
            AVCaptureDevice::requestAccessForMediaType_completionHandler(media_type, &handler);
        }
        // Bounded so a prompt left sitting behind another window can't pin this blocking-pool
        // thread for the life of the process. On timeout we simply stop waiting — the caller
        // re-reads the REAL status rather than trusting anything about this wait, so a slow user is
        // never mistaken for a denial (the status is still NotDetermined, and the next mic click
        // prompts again).
        let _ = rx.recv_timeout(Duration::from_secs(120));
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::MicAuth;

    /// Windows/Linux have no TCC gate on this path: the mic either opens or cpal returns a real
    /// error, which the existing error plumbing already surfaces honestly. Reporting Authorized
    /// keeps `ensure_access_blocking` a no-op here, so the arm path is byte-for-byte what it was
    /// before this module existed (the feat/windows-port branch must not grow a phantom prompt).
    pub fn status() -> MicAuth {
        MicAuth::Authorized
    }

    /// Unreachable: `status()` above never returns NotDetermined, so `decide` never asks to
    /// Request. Present only so `ensure_access_blocking` compiles as one cross-platform body.
    pub fn request_access_blocking() {}
}

/// The current TCC microphone status. Always `Authorized` off macOS (see the stub above).
pub fn status() -> MicAuth {
    platform::status()
}

/// The full gate: read the status, act on it, and answer whether the mic may be armed.
///
/// BLOCKING — it can sit on the OS permission prompt for as long as the user takes to read it.
/// Callers MUST be off the main thread (`dictation.rs` calls it inside `spawn_blocking`); see
/// `platform::request_access_blocking` for why blocking the main thread here self-deadlocks.
///
/// `Ok(())` means armed-as-before. `Err` is a string `classifyVoiceError` routes to `permission`.
pub fn ensure_access_blocking() -> Result<(), String> {
    match decide(status()) {
        // The founder/warm path: one cached status read, then out. No prompt, no error, no wait.
        MicGate::Proceed => Ok(()),
        MicGate::Blocked(msg) => Err(msg.to_string()),
        MicGate::Request => {
            platform::request_access_blocking();
            // Re-read TCC rather than trusting the handler's `granted` bool. Same source of truth
            // the OS will actually enforce, and it stays correct when we timed out waiting (where
            // there IS no bool). Re-running `decide` also means the NotDetermined→Denied
            // transition a "Don't Allow" click just caused yields the normal DENIED_ERROR.
            match decide(status()) {
                MicGate::Proceed => Ok(()),
                MicGate::Blocked(msg) => Err(msg.to_string()),
                // Still NotDetermined: nobody answered within the timeout.
                MicGate::Request => Err(NOT_ANSWERED_ERROR.to_string()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The decision table, exhaustively. This is the part that can be tested — the real TCC status
    /// is process/OS state a unit test cannot fake, which is exactly why the policy is a pure
    /// function of an enum rather than something tangled into the AVFoundation call.
    #[test]
    fn decide_maps_every_status_to_its_only_correct_remedy() {
        assert_eq!(decide(MicAuth::Authorized), MicGate::Proceed);
        assert_eq!(decide(MicAuth::NotDetermined), MicGate::Request);
        assert_eq!(decide(MicAuth::Denied), MicGate::Blocked(DENIED_ERROR));
        assert_eq!(decide(MicAuth::Restricted), MicGate::Blocked(RESTRICTED_ERROR));
    }

    /// The UX trap this module exists to avoid, pinned as a test. A NotDetermined user must be
    /// PROMPTED — never sent to System Settings, where the Microphone pane has no Sparkle entry to
    /// switch on yet. And a Denied/Restricted user must NEVER be "prompted": the OS answers
    /// `requestAccess` instantly with false and shows no UI, so a request-based remedy would look
    /// to them exactly like the silent dead mic we're fixing.
    #[test]
    fn not_determined_prompts_while_denied_and_restricted_do_not() {
        assert_eq!(
            decide(MicAuth::NotDetermined),
            MicGate::Request,
            "NotDetermined must trigger the OS prompt — System Settings would show no Sparkle entry",
        );
        for refused in [MicAuth::Denied, MicAuth::Restricted] {
            assert!(
                matches!(decide(refused), MicGate::Blocked(_)),
                "{refused:?} can never be re-prompted by the OS — the remedy must be System Settings",
            );
        }
    }

    /// Do not regress the founder/warm path: an Authorized user must get the plain go-ahead, with
    /// nothing added — no prompt, no error, no wait. `Proceed` carries no payload precisely so
    /// there is nothing here to flash on screen.
    #[test]
    fn authorized_proceeds_with_no_prompt_and_no_error() {
        assert_eq!(decide(MicAuth::Authorized), MicGate::Proceed);
        assert!(!matches!(decide(MicAuth::Authorized), MicGate::Request));
        assert!(!matches!(decide(MicAuth::Authorized), MicGate::Blocked(_)));
    }

    /// On every non-macOS target the gate must be an inert no-op — the feat/windows-port branch
    /// arms the mic exactly as it did before this module existed.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn non_macos_gate_is_a_noop() {
        assert_eq!(status(), MicAuth::Authorized);
        assert_eq!(ensure_access_blocking(), Ok(()));
    }

    /// The Rust half of the cross-language contract with `voice/dictationCopy.ts`. That
    /// classifier's `permission` bucket needs BOTH a mic context AND a denial word, and it checks
    /// the no-device / format / disk-space / download buckets FIRST — so a string of ours that
    /// happened to contain "no microphone" or "download" would be silently misrouted, and the user
    /// would get a remedy for a problem they don't have. This mirrors those regexes over our
    /// actual constants. `dictationCopy.test.ts` pins the same strings from the TypeScript side;
    /// this test is what catches a reword made here without looking there.
    #[test]
    fn every_error_string_satisfies_the_frontend_permission_classifier() {
        // NOT_ANSWERED_ERROR is deliberately excluded — see the test below it.
        for msg in [DENIED_ERROR, RESTRICTED_ERROR] {
            let s = msg.to_lowercase();
            // MIC_CONTEXT ∧ DENIAL — both halves, per the classifier's deliberate guard.
            assert!(
                s.contains("microphone") || s.contains("audio"),
                "missing the mic CONTEXT half — would fall through to `unknown`: {msg}",
            );
            assert!(
                s.contains("permission")
                    || s.contains("denied")
                    || s.contains("not authoriz")
                    || s.contains("privacy")
                    || s.contains("tcc"),
                "missing the DENIAL half — would fall through to `unknown`: {msg}",
            );
            // The buckets that are checked BEFORE permission and would therefore win.
            for earlier in [
                "no microphone",
                "no input device",
                "no such device",
                "device not available",
                "sample format",
                "no space left",
                "gb free",
                "download",
                "network",
                "connection",
                "timeout",
                "certificate",
            ] {
                assert!(
                    !s.contains(earlier),
                    "{msg:?} contains {earlier:?}, which an EARLIER classifier bucket matches — \
                     it would be misrouted away from `permission`",
                );
            }
        }
    }

    /// Weld the two languages together (roborev 37804 / 37848).
    ///
    /// The other tests here check each string's PROPERTIES, and the frontend checks its own COPY of
    /// each string — so until this test, nothing actually connected the two. Reword a constant
    /// below and both suites would keep passing independently while the frontend quietly asserted
    /// against a string the backend no longer sends: it would still be pinning routing for text
    /// that exists nowhere, and the property tests would still be happy. Every guard green, the
    /// contract broken, nothing saying so.
    ///
    /// So: read the frontend's copy and require our constants to literally appear in it. Reading a
    /// sibling file from `CARGO_MANIFEST_DIR` to enforce a cross-file invariant is this crate's
    /// established move — `audio.rs`'s `hardened_runtime_build_grants_microphone_entitlement` does
    /// exactly this against tauri.conf.json and entitlements.plist, and for the same reason (the
    /// failure it guards is silent). No build step, no generated fixture, no new dependency; the
    /// coupling it creates is precisely the one that already exists in fact.
    ///
    /// It reads backendVoiceErrors.ts specifically because that is the frontend's ONE copy of these
    /// strings — every frontend test imports from there rather than holding its own literal, so
    /// this single file is the whole TS side of the contract.
    #[test]
    fn the_frontend_test_pins_these_exact_strings() {
        let dir = env!("CARGO_MANIFEST_DIR");
        let path = format!("{dir}/../src/voice/backendVoiceErrors.ts");
        let ts = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {path}: {e}"));
        for msg in [DENIED_ERROR, RESTRICTED_ERROR, NOT_ANSWERED_ERROR] {
            assert!(
                ts.contains(msg),
                "src/voice/backendVoiceErrors.ts does not contain this string verbatim:\n  {msg:?}\n\
                 The frontend tests import from that file to prove classifyVoiceError routes this \
                 error correctly. If you reworded the constant, reword it there in the same commit \
                 (and re-check the routing — the `permission` bucket needs a mic context AND a \
                 denial, and the no-device / format / disk-space / download buckets match FIRST).",
            );
        }
    }

    /// The timeout string must NOT reach `permission` (roborev 37736). Its status is still
    /// NotDetermined, so the `permission` remedy — "open System Settings → Privacy & Security →
    /// Microphone" — is a DEAD END for this user: there is no Sparkle entry in that pane to switch
    /// on until the OS has actually recorded an answer. Falling through to `unknown` (which renders
    /// the string verbatim) is what lets it say the one thing that does work: click the mic again,
    /// which re-prompts. Keeping the denial words out of it is the whole mechanism, so pin it.
    #[test]
    fn the_unanswered_prompt_does_not_send_a_not_determined_user_to_system_settings() {
        let s = NOT_ANSWERED_ERROR.to_lowercase();
        for denial in ["permission", "denied", "deny", "not authoriz", "unauthoriz", "privacy", "tcc"] {
            assert!(
                !s.contains(denial),
                "NOT_ANSWERED_ERROR contains {denial:?}, so classifyVoiceError routes it to \
                 `permission` — which would point a still-NotDetermined user at a System Settings \
                 pane that has no Sparkle entry to toggle: {NOT_ANSWERED_ERROR:?}",
            );
        }
        // …and it still has to name the remedy that DOES work.
        assert!(
            s.contains("try again") || s.contains("click the mic"),
            "it must tell the user to re-trigger the prompt: {NOT_ANSWERED_ERROR:?}",
        );
    }
}
