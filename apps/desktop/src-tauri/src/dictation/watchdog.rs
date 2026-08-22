//! The audio-liveness watchdog's DECISION LAYER — pure, total functions plus the small types they
//! speak in. Extracted from `dictation.rs` as a leaf: nothing here touches a `DictationSession`, an
//! `AppHandle`, or a live device, which is exactly why it is the part that can be unit-tested.
//!
//! The polling LOOP that calls into this still lives in `dictation.rs` (`impl DictationState`),
//! because it reads and writes session state on every tick. Keeping the two apart is the point: the
//! loop is untestable without a real mic, and none of the judgement below needs one.
//!
//! Visibility is `pub(in crate::dictation)` rather than `pub(crate)` on purpose — these items were
//! private to one file before the split, and that keeps the boundary exactly where it was: visible
//! to `dictation` and its descendants, invisible to the rest of the crate.

use crate::audio::{AudioHealth, ZeroSource};

// ── Audio liveness watchdog ────────────────────────────────────────────────────────────────────
//
// The 2026-07-29 incident in one line: capture ran for NINE MINUTES receiving nothing while the UI
// showed an idle waveform, and the user sat there talking to it. Nothing in the app was watching
// whether audio actually arrived — only whether the stream had been *created*. This is that watch.

/// How often to check that audio is still arriving. Cheap (two atomic loads under a short lock),
/// so the interval is set by how long a user should ever spend talking to a dead mic, not by cost.
pub(in crate::dictation) const WATCHDOG_POLL: std::time::Duration = std::time::Duration::from_millis(1000);

/// How long a freshly built capture gets before its silence counts as a fault. Long enough to
/// cover CoreAudio's first-buffer latency and a device reconfiguration, short enough that the user
/// finds out inside one sentence rather than nine minutes.
pub(in crate::dictation) const WATCHDOG_GRACE: std::time::Duration = std::time::Duration::from_secs(4);

/// How many consecutive ticks the mic may be armed-but-uncaptured before that counts as a fault.
/// `reconcile_capture` builds outside the session lock, so a tick can legitimately land in that
/// window; three seconds is far longer than a rebuild and far shorter than a user's patience.
pub(in crate::dictation) const MISSING_CAPTURE_TICKS: u8 = 3;

/// Advance the missing-capture debounce for one tick.
///
/// Returns `(new_tick_count, is_a_fault)`. Pure, so the whole increment/reset matrix is covered by
/// a test — the sampling around it needs a live `AppHandle` and a real audio device, and an earlier
/// version tested only the threshold constant while leaving the logic that actually changed
/// uncovered (roborev 55286).
///
/// `building` is the load-bearing input. `MISSING_CAPTURE_TICKS` alone is a wall-clock guess, and
/// `Capture::start`'s CoreAudio init blocks on the main thread — a thread this file documents as
/// being blocked for seconds elsewhere. Without it, a build that merely takes longer than the
/// threshold is indistinguishable from one that failed, and the user gets a false "couldn't open a
/// microphone". Note it is a BOUNDED belief, computed by [`build_suppresses_watch`] — see there for
/// why an unbounded one silences the watchdog for the rest of the session.
pub(in crate::dictation) fn missing_tick(has_capture: bool, should_be_live: bool, building: bool, ticks: u8) -> (u8, bool) {
    if has_capture || !should_be_live || building {
        return (0, false);
    }
    let ticks = ticks.saturating_add(1);
    (ticks, ticks >= MISSING_CAPTURE_TICKS)
}

/// How long a running `build_capture` may suppress the missing-capture watch. Far above a normal
/// build (CoreAudio init is milliseconds, and even a badly contended main thread is ~seconds) and
/// far below the user's patience.
pub(in crate::dictation) const BUILD_STALL_GRACE: std::time::Duration = std::time::Duration::from_secs(10);

/// Whether a build that started `since` ago should still be believed to be making progress.
///
/// The bound is the point. `build_started_at` is cleared by `install_capture` and by the build's
/// error arm — neither of which a HUNG build ever reaches. Treating "a build is running" as
/// permanently true therefore turned the watchdog off for the rest of the session on an armed
/// session with no capture: exactly the nine-minute silent failure this watchdog exists to end,
/// re-entered through the fix for its false positive (roborev 55300). Past the grace we stop
/// believing the marker and let the tick escalation through.
pub(in crate::dictation) fn build_suppresses_watch(since: Option<std::time::Duration>) -> bool {
    matches!(since, Some(elapsed) if elapsed < BUILD_STALL_GRACE)
}

/// How many raw device samples we must have seen from ONE device — with not a single non-zero one
/// among them — before that device is silent as a matter of evidence rather than of timing.
///
/// 48_000 is one second of audio at the built-in mic's rate. The point is not the duration: it is
/// that this evidence is CUMULATIVE ACROSS CAPTURE REBUILDS, so it is reachable even when no single
/// capture ever survives [`WATCHDOG_GRACE`]. See [`SilenceWatch`] for why that matters.
const SILENCE_EVIDENCE_SAMPLES: u64 = 48_000;

/// Silence evidence for one device, carried ACROSS the captures that observe it.
///
/// ── WHY THIS EXISTS: THE CHURN STARVES THE WATCHDOG ─────────────────────────────────────────────
/// Every latch the watchdog owns is per-CAPTURE — `install_capture` calls `clear_audio_fault` on
/// each install, deliberately, so a rebuild cannot inherit "already reported" and go quiet on a mic
/// that is still dead. That is right in isolation and it has an unguarded converse: if captures are
/// REPLACED faster than one can survive `WATCHDOG_GRACE`, the escalation ladder is reset before it
/// can ever be climbed, and the user is told nothing at all.
///
/// That is not hypothetical. In the 2026-08-05 log the mic churned for six minutes — a stop landing
/// during each model load (`start_dictation aborted: … mic stays muted`) tore the capture down every
/// ~2s, under the 4s grace — so `assess_capture_health` returned `Warming` on nearly every tick and
/// the ONE `Silent` verdict that got through was reset by the next rebuild. Exactly one `Reacquire`
/// was logged in that window and no `Report` ever followed it. The user sat talking to a dead
/// microphone while the app knew, tick after tick, that 219,136 raw samples had arrived and every
/// one of them was zero.
///
/// So the evidence has to outlive the capture that gathered it. The device UID keys it: a real
/// device change is a new question and resets the watch, but a rebuild of the SAME device keeps
/// accumulating. Nothing at the capture-lifecycle sites has to cooperate, which is what keeps this
/// from becoming a fourth latch to forget to clear.
///
/// ── WHY A RUN AND NOT A TOTAL ───────────────────────────────────────────────────────────────────
/// The first version banked lifetime totals and required the total non-zero count to be zero, which
/// made the verdict UNREACHABLE for a mic that worked and then died inside one session: a single
/// voiced sample from ten minutes ago disqualified every second of silence that followed it
/// (knightwatch probe 2 on PR #1344). "Worked, then went silent" is not an exotic case — it is the
/// ordinary shape of a mic that a call app grabs mid-session. So what is carried is the CONSECUTIVE
/// silent run, measured in counter DELTAS: any voiced delta resets it to zero, and everything after
/// that point accumulates again.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(in crate::dictation) struct SilenceWatch {
    /// The device this evidence is about. A different UID means a different question.
    pub(in crate::dictation) uid: String,
    /// The previous reading, so each tick contributes only what is NEW. A fresh `Capture` starts its
    /// counters at zero, so a reading below this one means the capture was rebuilt under us.
    pub(in crate::dictation) prev_raw: u64,
    pub(in crate::dictation) prev_nonzero: u64,
    /// Raw samples seen since the last voiced one — across as many captures as it takes.
    pub(in crate::dictation) silent_run: u64,
}

impl SilenceWatch {
    /// Enough raw audio has passed through this device, with none of it voiced, that "too early to
    /// judge" is no longer an honest reading.
    pub(in crate::dictation) fn is_durably_silent(&self) -> bool {
        self.silent_run >= SILENCE_EVIDENCE_SAMPLES
    }
}

/// Fold one watchdog reading into the running silence evidence for a device.
///
/// Pure, and separated from the tick for the reason every other decision in this module is: the
/// sampling needs a live `AppHandle` and a real audio device, so the only way the fold gets covered
/// is if it can be called without either. Four transitions, all of them load-bearing:
///
///  * **Different device** — a new question. Start over rather than blaming a fresh device for the
///    old one's silence.
///  * **Counter went backwards** — the capture was REBUILT (a `Capture`'s counters start at zero),
///    so the whole of this reading is new. Adding it to the run rather than restarting is the single
///    transition this struct exists for.
///  * **Counter advanced** — same capture: add only the DELTA, or one capture sampled every second
///    would count its own samples once per tick and reach the threshold on timing alone.
///  * **Any voiced delta** — audio is reaching us. The run is over; start it at zero, whatever it
///    had reached. This is what makes a mic that dies mid-session reportable.
///
/// The one imprecision is deliberate and one-directional: a rebuilt capture whose first reading is
/// ≥ the retiring one's last cannot be told from the same capture advancing, so its delta is
/// UNDERSTATED (knightwatch probe 3). That delays a verdict by at most one tick's worth of samples
/// and can never manufacture one, which is the right way for this to be wrong.
pub(in crate::dictation) fn fold_silence_evidence(
    prev: Option<SilenceWatch>,
    uid: &str,
    raw_samples: u64,
    raw_nonzero: u64,
) -> SilenceWatch {
    let (base, d_raw, d_nonzero) = match &prev {
        Some(w) if w.uid == uid && raw_samples >= w.prev_raw && raw_nonzero >= w.prev_nonzero => {
            // Same capture, newer reading.
            (w.silent_run, raw_samples - w.prev_raw, raw_nonzero - w.prev_nonzero)
        }
        Some(w) if w.uid == uid => {
            // A counter that went backwards is a rebuild: this reading is entirely new evidence,
            // and it CONTINUES the run the retiring capture was building.
            (w.silent_run, raw_samples, raw_nonzero)
        }
        // No watch yet, or a different device: this reading is the whole of what we know.
        _ => (0, raw_samples, raw_nonzero),
    };
    SilenceWatch {
        uid: uid.to_string(),
        prev_raw: raw_samples,
        prev_nonzero: raw_nonzero,
        silent_run: if d_nonzero > 0 { 0 } else { base.saturating_add(d_raw) },
    }
}

/// Whether installing a capture may claim the audio fault is OVER.
///
/// Installing one says a stream was built, which is not the same fact as audio arriving through it.
/// The retraction exists for the missing-capture path (roborev 55286), where the rebuild genuinely
/// is the recovery; a device sitting on a standing silent run is the case where it is not, and
/// claiming it there flaps the notice once per rebuild for as long as the churn lasts.
pub(in crate::dictation) fn install_retracts(reported: bool, watch: Option<&SilenceWatch>) -> bool {
    reported && !watch.is_some_and(SilenceWatch::is_durably_silent)
}

/// The report latch's value AFTER an install, given whether that install retracted.
///
/// Named rather than inlined so the test drives the production expression instead of a copy of it —
/// a guard tested against a re-spelled mechanism proves nothing the moment the two drift. The rule:
/// a retraction consumes the latch (the notice is down, so there is nothing left to retract), while
/// a WITHHELD retraction must preserve it, because `Recovered` is gated on `reported` and is the
/// only remaining way the notice can ever come down.
pub(in crate::dictation) fn reported_after_install(reported: bool, retracted: bool) -> bool {
    reported && !retracted
}

/// What the watchdog should do about the current reading.
///
/// Pure (see [`fault_action`]) so the escalation order is unit-tested: we always try to RECOVER
/// before we complain, and we complain exactly once per capture rather than every poll.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::dictation) enum FaultAction {
    /// Nothing to do.
    Idle,
    /// Rebuild the capture — re-enumerates devices and re-binds. Fixes the ordinary case
    /// (a device changed under us) without the user ever seeing an error.
    Reacquire,
    /// Re-acquiring did not help. Tell the user, naming the device.
    Report,
    /// Audio came back after we had reported a fault — retract the notice.
    Recovered,
}

/// Escalation policy for a liveness reading.
///
/// `reacquired` / `reported` are per-capture latches: they reset when a new capture is installed,
/// so each rebuild gets one silent recovery attempt and at most one user-visible message. Without
/// the latches a dead mic would either re-acquire in a tight loop or emit an error every second.
///
/// `muted` is the device's own `kAudioDevicePropertyMute` reading, and it short-circuits the
/// recovery attempt: rebuilding a stream cannot unmute hardware, so re-acquiring a muted device is
/// pure churn that delays telling the user the one thing they need to hear.
///
/// `durably_silent` is [`SilenceWatch::is_durably_silent`] — a consecutive silent RUN for the bound
/// device, folded across capture rebuilds. It makes the `Warming` arm below conditional, and that
/// is the whole of the 2026-08-05 fix: a capture torn down and rebuilt every two seconds is forever
/// "too early to judge" on its own, so a churning mic could never reach a verdict no matter how
/// long the user talked at it. Cumulative evidence is not early.
///
/// WHAT IT DOES NOT PROVE, since the run semantics landed: it does NOT establish that rebuilding
/// has already been tried. A run is reachable by a single capture sitting silent past the grace, so
/// it is evidence of SILENCE, not of exhausted recovery — which is why the `NoFrames | Silent` arm
/// still spends its one free re-acquire regardless of it. Read the note on that arm before widening
/// this flag's reach again.
pub(in crate::dictation) fn fault_action(
    health: AudioHealth,
    muted: bool,
    reacquired: bool,
    reported: bool,
    durably_silent: bool,
) -> FaultAction {
    match health {
        // Too early to judge THIS capture — a just-built stream has not necessarily delivered a
        // buffer yet. But "this capture is young" is not the same as "we know nothing": if the same
        // device has already handed us a second of pure zeros across earlier captures, waiting for
        // one of them to survive the grace is waiting for something the churn prevents.
        AudioHealth::Warming => {
            if durably_silent && !reported {
                FaultAction::Report
            } else {
                FaultAction::Idle
            }
        }
        // Audio is flowing. Retract a previous complaint, but only if we actually made one.
        AudioHealth::Live => {
            if reported {
                FaultAction::Recovered
            } else {
                FaultAction::Idle
            }
        }
        // No frames at all, or frames that are all digital silence. Both mean "not hearing you";
        // both are worth one automatic recovery attempt before bothering the user — UNLESS the
        // device says it is muted, in which case there is nothing to recover and the honest thing
        // is to say so straight away.
        AudioHealth::NoFrames | AudioHealth::Silent => {
            if reported {
                FaultAction::Idle
            } else if muted || reacquired {
                // `durably_silent` DELIBERATELY DOES NOT SHORT-CIRCUIT HERE, and it used to.
                //
                // The justification was that durable evidence proves "rebuilding is exactly what
                // has already been happening", so a further re-acquire is wasted. That premise died
                // with run semantics (knightwatch probe 3): a run is now reachable by ONE capture
                // sitting silent past the grace — 4s is ~192k raw zeros against a 48k threshold —
                // so a device that was voicing minutes ago, then went quiet across an ordinary
                // blur/refocus rebuild, would skip its one free recovery attempt and go straight to
                // accusing the user. Nothing on the `Report` path rebuilds the capture, so that
                // reads as "we told you and then did nothing".
                //
                // This arm has a capture that SURVIVED the grace, which is the ordinary
                // flapping-device case the free re-acquire exists for. The churn case — where the
                // ladder cannot climb at all — is the `Warming` arm above, and that is the only
                // place the cross-capture evidence is load-bearing.
                FaultAction::Report
            } else {
                FaultAction::Reacquire
            }
        }
    }
}

/// What we tell the user when the re-acquire could not rebuild a capture AT ALL, so there is no
/// device to name. Say exactly that rather than inventing one.
///
/// Same remedy rule as [`no_audio_message`]: it must name a control that exists AND works. This arm
/// was missed on the first audit pass and still said "check System Settings → Sound → Input", which
/// cannot rebind Sparkle — capture no longer follows the system default. It is also the one message
/// here that matches no bucket in `dictationCopy`, so it reaches the user verbatim.
const NO_CAPTURE_MESSAGE: &str =
    "Sparkle couldn't open a microphone. Connect one, then pick it in Sparkle's mic menu \
     (hover the mic).";

/// The BUNDLE-REPLACED report: the same digital silence as [`STALE_GRANT_MESSAGE`], with the cause
/// established rather than inferred — /Applications/Sparkle.app was REPLACED under this running
/// process, so macOS invalidated the grant this binary is still caching an `Authorized` answer for.
///
/// ── WHY THIS OUTRANKS THE STALE-GRANT SENTENCE ────────────────────────────────────────────────
/// That sentence ends by sending the user to System Settings → Privacy & Security → Microphone.
/// For a grant invalidated by a bundle swap that pane CANNOT help: Sparkle is already switched on
/// there, and toggling it re-grants the code identity now on disk, not the unlinked binary the user
/// is talking to. The only thing that restores the microphone is relaunching onto the bundle that
/// is actually installed. Bead sparkle-1ueh3: 12 of 12 fault clusters ended in a restart onto a
/// HIGHER version, and across six days there were ZERO successful transcripts after a swap and
/// ZERO "audio is arriving again" recoveries. Nothing short of a relaunch has ever fixed this.
///
/// THREE CONSTRAINTS ON THESE BYTES, each of which has a test:
///
/// 1. NO APOSTROPHE in the pinned opening clause. `the_bundle_replaced_message_matches_the_prefix_
///    the_frontend_pins` reads the TS constant back with `.split('\'').nth(1)`, so a single quote
///    would truncate the pin to a prefix of itself and the cross-language check would pass while
///    the two sides had drifted. Hence "the running copy", never "this process's copy".
/// 2. LEXICALLY DISJOINT from [`STALE_GRANT_MESSAGE`] — it must NOT contain "sending silence
///    instead of audio", which is the noun phrase dictationCopy's `stale-grant` pattern matches.
///    Disjoint means the new bucket cannot be stolen by an ordering change in that PATTERNS list;
///    it does not have to WIN a race it never enters.
/// 3. It must not name System Settings (see above), it must say "Quit Sparkle" (the one remedy that
///    works), and it must carry `{device}` like both of its siblings — the device name is the fact
///    only the backend has, and every other message in this module names it.
const BUNDLE_REPLACED_MESSAGE: &str =
    "Sparkle updated in the background. macOS revoked the microphone for the running copy and is \
     sending silence from \"{device}\". Quit Sparkle and open it again to restore the microphone.";

/// The stale-grant report: macOS is handing this process pure digital silence from a microphone it
/// says we are allowed to use.
///
/// ── THIS IS THE MESSAGE THE 2026-08-05 LOG WAS ASKING FOR ───────────────────────────────────────
/// `watchdog_tick` has re-read TCC at the one moment it is diagnostic and already writes the
/// contradiction to the log: `tcc=Authorized` alongside `zero_source=Os` means the grant is
/// nominally live and the OS is delivering zeros anyway. The module's own comment spelled out what
/// that means — "this process's mic grant is dead; restart Sparkle" — and then said none of it to
/// the user, who instead got the generic branch below telling him another app was holding a
/// microphone that nothing was holding. A remedy that sends someone hunting a fault that does not
/// exist is worse than no remedy (AGENTS.md), so the evidence now picks the sentence.
///
/// Restart FIRST, Privacy pane last, and that order is the finding rather than a preference: the
/// pane will show Sparkle already enabled — the grant is stale, not withheld — so leading with it
/// sends the user to a switch that is already on. Re-launching is what re-establishes the grant.
///
/// ORDERED REMEDIES, NOT AN EXCLUSIVE DIAGNOSIS. `zero_source == Os` says only that the zeros came
/// from the OS rather than from our own downmix, and audio.rs's own note records that a BUSY device
/// reads exactly the same ("a muted or busy device, or the very fault this guard was written for");
/// muted is ruled out by [`is_stale_grant`], held is not. Claiming the grant is dead would therefore
/// be the original defect with the blame moved — a confident wrong cause. So the sentence leads with
/// the free remedy that fixes the case this was written for and keeps the held-device check as the
/// next step instead of denying it (knightwatch probe 1 on PR #1344).
const STALE_GRANT_MESSAGE: &str =
    "macOS is sending silence instead of audio from \"{device}\", even though Sparkle's microphone \
     permission looks granted. Quit Sparkle and open it again — that usually re-establishes the \
     grant. If it comes back, quit anything else that might be holding the mic (a video call or a \
     screen recorder), then switch Sparkle off and on in System Settings → Privacy & Security → \
     Microphone.";

/// Whether this reading is the stale-grant signature rather than an ordinary dead mic.
///
/// All four conditions, because each one rules out a DIFFERENT story that has its own remedy: a
/// muted device needs unmuting, a virtual device needs rebinding, `zero_source` other than `Os`
/// means the zeros are ours or the stream never negotiated, and a TCC status that is NOT
/// `Authorized` is an ordinary denial the permission path already words correctly. What is left is
/// the one combination no other branch explains.
fn is_stale_grant(
    device: &crate::audio::BoundDevice,
    muted: bool,
    zero_source: ZeroSource,
    tcc: crate::mic_permission::MicAuth,
) -> bool {
    !muted
        && !device.is_virtual
        && zero_source == ZeroSource::Os
        && tcc == crate::mic_permission::MicAuth::Authorized
}

/// The whole of what [`FaultAction::Report`] says, for both device states.
pub(in crate::dictation) fn watchdog_report_message(
    device: Option<&crate::audio::BoundDevice>,
    muted: bool,
    zero_source: ZeroSource,
    tcc: crate::mic_permission::MicAuth,
    bundle_replaced: bool,
) -> String {
    match device {
        // A REFINEMENT WITHIN the stale-grant reading, not a fifth condition on it — which is why
        // `is_stale_grant` is unchanged and is re-tested here rather than extended. Keeping the
        // guard whole is what preserves the existing precedence: a MUTED device still falls through
        // to `no_audio_message` and is told it is muted, even mid-update, because unmuting is still
        // the fix and the update story would send that user off to quit an app for nothing.
        Some(d) if bundle_replaced && is_stale_grant(d, muted, zero_source, tcc) => {
            BUNDLE_REPLACED_MESSAGE.replace("{device}", &d.name)
        }
        Some(d) if is_stale_grant(d, muted, zero_source, tcc) => {
            STALE_GRANT_MESSAGE.replace("{device}", &d.name)
        }
        Some(d) => no_audio_message(d, muted),
        None => NO_CAPTURE_MESSAGE.to_string(),
    }
}

/// What one watchdog tick sends to the frontend — as DATA, so the entire mapping is unit-testable.
///
/// EXISTS BECAUSE THE PREVIOUS SHAPE COULD NOT BE TESTED AT ITS SIDE EFFECT. `watchdog_tick` needs
/// an `AppHandle` to emit and an `AppHandle` cannot be built in a unit test, so the emit decisions
/// lived inside a function no test could call. Hoisting `NO_CAPTURE_MESSAGE` into a constant was
/// meant to fix that and did not: the test read the CONSTANT, which is a precondition, not the
/// output — reverting the arm to an inline "check System Settings → Sound → Input" literal left the
/// constant merely unreferenced and the test still green, so the user-visible regression survived
/// the mutation it was written to catch (roborev 55413, and AGENTS.md's "assert the side effect").
///
/// With the decision returned as a value, a test drives the real mapping: which actions speak at
/// all, which event each one sends, and the exact bytes of the payload. What is left at the call
/// site is one `match` that emits the variant it is handed and holds no copy of its own — so the
/// silent-nag and silent-failure regressions (a `Reacquire` that nags the user, a `Report` that
/// says nothing and reproduces the nine-minute silence) are now caught here rather than in
/// production.
#[derive(Debug, PartialEq, Eq)]
pub(in crate::dictation) enum WatchdogEmission {
    /// Say nothing. A re-acquire is a SILENT recovery attempt on purpose — the user should never be
    /// told about a hiccup that fixed itself.
    Silent,
    /// `dictation://error`, carrying exactly this body.
    Error(String),
    /// `dictation://audio-recovered`, which carries no payload — it retracts a notice rather than
    /// adding one.
    Recovered,
}

pub(in crate::dictation) fn watchdog_emission(
    action: FaultAction,
    device: Option<&crate::audio::BoundDevice>,
    muted: bool,
    zero_source: ZeroSource,
    tcc: crate::mic_permission::MicAuth,
    bundle_replaced: bool,
) -> WatchdogEmission {
    match action {
        FaultAction::Idle | FaultAction::Reacquire => WatchdogEmission::Silent,
        FaultAction::Report => WatchdogEmission::Error(watchdog_report_message(
            device,
            muted,
            zero_source,
            tcc,
            bundle_replaced,
        )),
        FaultAction::Recovered => WatchdogEmission::Recovered,
    }
}

/// The user-facing message for a capture that is not hearing anything.
///
/// Naming the device is the whole point: "no audio" sends someone hunting through System Settings,
/// while "no audio from ZoomAudioDevice" tells them instantly that capture landed on a virtual
/// device and roughly which app put it there. The remedy differs for the two cases, so the copy
/// does too — a virtual device is a WRONG-DEVICE problem, a physical one is a taken-over-mic
/// problem, and telling someone to pick a different input when they are already on their built-in
/// mic would be useless advice.
pub(in crate::dictation) fn no_audio_message(device: &crate::audio::BoundDevice, muted: bool) -> String {
    // AGENTS.md: "a remedy message is an instruction the user will follow", so it must name an
    // action that EXISTS — and one that WORKS. An earlier draft said "pick your microphone in the
    // mic menu" while that menu was still a three-option mode pill with no device list (roborev
    // 55277), so it was swung to System Settings → Sound → Input, true on every macOS install.
    //
    // The mic menu now carries a real device picker (`AudioInputPicker`), which changes the answer
    // BACK for the wrong-device case — and not merely as a convenience. This branch deliberately
    // stopped following `kAudioHardwarePropertyDefaultInputDevice`: automatic selection prefers a
    // physical input over the default, and a pinned UID ignores the default outright. So "change
    // your input in System Settings" is now advice that can leave capture on exactly the device the
    // user was just told about — a remedy that does nothing is worse than none. Sparkle's own
    // picker is the control that actually rebinds (`set_audio_input` re-acquires immediately).
    //
    // System Settings stays for MUTE, where it is still the truth: no in-app picker can unmute
    // hardware.
    if muted {
        // The device told us it is muted. Accusing it of being broken — or telling the user to go
        // pick a different microphone — would send them chasing a fault that does not exist.
        return format!(
            "\"{}\" is muted. Unmute it (check the hardware mute switch, or System Settings → \
             Sound → Input) to start dictating.",
            device.name
        );
    }
    if device.is_virtual {
        format!(
            "No audio from \"{}\". That is a virtual audio device, not a microphone — pick your \
             microphone in Sparkle's mic menu (hover the mic) to rebind capture.",
            device.name
        )
    } else {
        format!(
            "No audio from \"{}\". Another app (a screen recorder or virtual audio device) may be \
             holding the microphone. Turn the mic off and on, or pick a different input in \
             Sparkle's mic menu (hover the mic).",
            device.name
        )
    }
}
