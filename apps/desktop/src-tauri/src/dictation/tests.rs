    // `State` comes straight from tauri: the commands that take it now live in `dictation::commands`,
    // so `dictation.rs` itself no longer imports it for this module to borrow through `super`.
    use tauri::State;
    // The watchdog's pure decision layer moved to `dictation::watchdog`; these are the same items,
    // at their new path.
    use super::frame_policy::{
        capture_should_be_live, dispatch_closed_segments, frame_on_device_speech, frame_speaking,
        plan_capture, plan_capture_for, segment_cloud_latch, should_emit_blur, CapturePlan,
    };
    use super::events::{
        segment_fingerprint, should_log_interim, INTERIM_LOG_EVERY, next_interim_index,
        reset_interim_log_sampling,
    };
    use super::watchdog::{FaultAction, fault_action, no_audio_message,
        fold_silence_evidence, install_retracts, reported_after_install, watchdog_report_message,
        missing_tick, build_suppresses_watch, BUILD_STALL_GRACE, MISSING_CAPTURE_TICKS, watchdog_emission, WatchdogEmission,
    };
    use super::{AppHandle, AudioHealth, ZeroSource, DictationSession,
        begin_start_decision, choose_engine, cloud_reuse, park_cloud_for_blur, discard_needs_reissue, note_build_failed, note_fresh_arm,
        apply_decode_plan, plan_decode_emit, DecodeEmitPlan, DecodeEmitSink, DecodeOutcome,
        should_install_cloud, should_keep_warm_on_stop, park_or_take_on_stop, park_target_active,
        classify_capture_fate, CaptureFate, capture_missed_payload, MissedStage,
        should_resume_on_focus, should_standby_on_blur, start_after_load, stop_is_noop, unpark_cloud_for_focus, BeginStart,
        CloudReuse, DeepgramSession, DictationState, Engine, Installed, ReconcileStep, StartAfterLoad,
        raced_stream_disposition, RacedStream, late_report_for, LateReport, park_raced_stream, install_live_stream, CloudAudioSender,
        CloudStreamOutcome,
        park_preconnected_stream, preconnect_landing, preconnect_plan, take_speculative_stream,
        PreconnectLanding, PreconnectPlan,
        PRECONNECT_COOLDOWN,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use super::{
        run_decode_loop, DecodeWorker, DECODE_ABORT_GRACE, DECODE_ABORT_POLL,
        DECODE_DRAIN_BUDGET, DECODE_JOIN_TIMEOUT,
    };
    use std::sync::mpsc::{channel, sync_channel};
    use std::time::{Duration, Instant};

    /// THE IPC CONTRACT, PINNED WHERE IT ACTUALLY LIVES.
    ///
    /// `CloudStreamOutcome` crosses into TypeScript as a serde-serialized string, and the frontend's
    /// `CloudStreamOutcome` union (dictationEngineStore.ts) lists those exact ten tokens. Nothing
    /// asserted them: the natural candidate, `cloud::refusal_tokens_are_pinned`, covers
    /// `RelayRefusal::as_str()` — a value that only ever reaches a `tracing` field and NEVER the
    /// wire. So renaming a variant here, or dropping `#[serde(rename_all = "snake_case")]`, would
    /// ship a token the union does not contain while every Rust test stayed green.
    ///
    /// This asserts the SERIALIZED form, not the variant names, because serde's output is the thing
    /// the frontend parses. A test that compared `format!("{:?}")` would pass through exactly the
    /// change it exists to catch.
    ///
    /// WHAT THIS DOES AND DOES NOT GUARANTEE — stated precisely, because two earlier versions of
    /// this comment overstated it and roborev caught both (60337, 60349).
    ///
    /// GUARANTEED by the compiler: a new `CloudStreamOutcome` variant cannot be added without
    /// NAMING its expected wire token, because `expected_token`'s match has no `_` arm. That is the
    /// property worth having — the token is the thing dictationEngineStore.ts parses, and the
    /// prompt to write it here is also the prompt to add it to the TS union.
    ///
    /// NOT guaranteed: that the new variant is EXERCISED. `all` is hand-maintained, and Rust has no
    /// way to enumerate an enum's variants without a derive (`strum::EnumIter`), which is not a
    /// dependency here. Two previous attempts to fake that tie were both vacuous — `all.len() == 10`
    /// compares a compile-time constant to itself, and a `covered: [bool; VARIANT_COUNT]` array is
    /// only ever written for variants already in `all`, so the omission it advertised catching
    /// passed green. An accurate comment beats a guard that reports the opposite of its coverage.
    #[test]
    fn outcome_wire_tokens_are_pinned() {
        // No `_` arm: adding a variant fails to COMPILE until its token is written here.
        fn expected_token(o: CloudStreamOutcome) -> &'static str {
            match o {
                CloudStreamOutcome::Opened => "opened",
                CloudStreamOutcome::Resumed => "resumed",
                CloudStreamOutcome::AlreadyRouting => "already_routing",
                CloudStreamOutcome::Raced => "raced",
                CloudStreamOutcome::SignedOut => "signed_out",
                CloudStreamOutcome::Unauthorized => "unauthorized",
                CloudStreamOutcome::NotEntitled => "not_entitled",
                CloudStreamOutcome::InsufficientCredits => "insufficient_credits",
                CloudStreamOutcome::RelayUnconfigured => "relay_unconfigured",
                CloudStreamOutcome::TooManyStreams => "too_many_streams",
                CloudStreamOutcome::Unreachable => "unreachable",
            }
        }

        // HAND-MAINTAINED, and the doc comment above says so rather than pretending otherwise.
        let all = [
            CloudStreamOutcome::Opened,
            CloudStreamOutcome::Resumed,
            CloudStreamOutcome::AlreadyRouting,
            CloudStreamOutcome::Raced,
            CloudStreamOutcome::SignedOut,
            CloudStreamOutcome::Unauthorized,
            CloudStreamOutcome::NotEntitled,
            CloudStreamOutcome::InsufficientCredits,
            CloudStreamOutcome::RelayUnconfigured,
            CloudStreamOutcome::TooManyStreams,
            CloudStreamOutcome::Unreachable,
        ];

        let mut seen = std::collections::HashSet::new();
        for outcome in all {
            let wire = serde_json::to_string(&outcome).expect("outcome serializes");
            assert_eq!(
                wire,
                format!("\"{}\"", expected_token(outcome)),
                "wire token for {outcome:?} must match the frontend's CloudStreamOutcome union",
            );
            // Two variants sharing a token would make the frontend unable to tell them apart, which
            // is the whole thing this enum replaced a bool to avoid.
            assert!(seen.insert(wire.clone()), "duplicate wire token {wire} for {outcome:?}");
        }
    }

    /// THE PRE-CONNECT VOCABULARY OVERLAPS THE METERING ONE, AND THREE COMMENTS DEPEND ON THAT FACT.
    ///
    /// `preconnect_cloud_stream` answers its own `PreconnectOutcome` rather than a
    /// `CloudStreamOutcome`, and for a long time three doc blocks explained the safety of that by
    /// saying the metering seam cannot READ a pre-connect's answer. It can. `Raced` and `SignedOut`
    /// serialize to `raced` and `signed_out`, both of which are members of the frontend's
    /// `CloudStreamOutcome` union and both of which `classifyCloudOutcome` has a live case for. The
    /// TYPE is what stops you (`classifyCloudOutcome` takes a `CloudStreamOutcome`, so handing it
    /// one of these does not compile); the STRING would sail straight through.
    ///
    /// So the real guarantee is that the CALL SITE DISCARDS the answer — `useDictation.ts` invokes
    /// with a bare `.catch(() => {})` and no `.then`. This test exists to keep that reasoning
    /// honest: it asserts the overlap is exactly the two tokens the comments name.
    ///
    /// WHAT A FAILURE MEANS — it is a prompt to re-read three comments, not automatically a bug:
    ///   * the set GREW — a pre-connect can now impersonate one more metering outcome, so check
    ///     that nothing has started reading this command's result;
    ///   * the set SHRANK — the comments now overstate the danger and should be corrected, the same
    ///     way they were corrected when they understated it.
    /// Either way the fix is to update `PreconnectOutcome`'s doc, `preconnect_cloud_stream`'s doc,
    /// and the `useDictation.ts` call-site comment together with this list.
    ///
    /// Exhaustive by compiler for the same reason as the test above: `preconnect_token`'s match has
    /// no `_` arm, so a new variant cannot be added without naming its wire token here — which is
    /// also the moment to ask whether that token collides with a metering one.
    #[test]
    fn a_preconnect_answer_can_impersonate_exactly_two_metering_outcomes() {
        use super::commands::PreconnectOutcome as P;

        // No `_` arm: adding a variant fails to COMPILE until its token is written here.
        fn preconnect_token(o: P) -> &'static str {
            match o {
                P::Connected => "connected",
                P::Released => "released",
                P::Idle => "idle",
                P::Busy => "busy",
                P::Raced => "raced",
                P::SignedOut => "signed_out",
                P::Unavailable => "unavailable",
            }
        }

        // HAND-MAINTAINED, exactly as `outcome_wire_tokens_are_pinned`'s list is, and for the same
        // reason its doc gives: Rust cannot enumerate an enum's variants without a derive this
        // crate does not depend on, and a faked tie is worse than an accurate comment.
        let all = [P::Connected, P::Released, P::Idle, P::Busy, P::Raced, P::SignedOut, P::Unavailable];

        // Assert the SERIALIZED form, not the variant name — serde's output is what crosses the IPC
        // boundary, and a `format!("{:?}")` comparison would pass through a lost `rename_all`.
        for outcome in all {
            let wire = serde_json::to_string(&outcome).expect("preconnect outcome serializes");
            assert_eq!(
                wire,
                format!("\"{}\"", preconnect_token(outcome)),
                "wire token for {outcome:?} must match what the frontend would receive",
            );
        }

        // The metering vocabulary, taken from the enum itself rather than restated, so this cannot
        // drift out of step with the test above.
        let metering: std::collections::HashSet<String> = [
            CloudStreamOutcome::Opened,
            CloudStreamOutcome::Resumed,
            CloudStreamOutcome::AlreadyRouting,
            CloudStreamOutcome::Raced,
            CloudStreamOutcome::SignedOut,
            CloudStreamOutcome::Unauthorized,
            CloudStreamOutcome::NotEntitled,
            CloudStreamOutcome::InsufficientCredits,
            CloudStreamOutcome::RelayUnconfigured,
            CloudStreamOutcome::TooManyStreams,
            CloudStreamOutcome::Unreachable,
        ]
        .into_iter()
        .map(|o| serde_json::to_string(&o).expect("outcome serializes"))
        .collect();

        let mut shared: Vec<String> = all
            .into_iter()
            .map(|o| serde_json::to_string(&o).expect("preconnect outcome serializes"))
            .filter(|w| metering.contains(w))
            .collect();
        shared.sort();

        assert_eq!(
            shared,
            vec!["\"raced\"".to_string(), "\"signed_out\"".to_string()],
            "the pre-connect/metering token overlap changed — re-read PreconnectOutcome's doc, \
             preconnect_cloud_stream's doc, and the useDictation.ts call-site comment, all three of \
             which explain the metering guarantee in terms of this exact set",
        );
    }

    /// Every relay refusal must reach a DISTINCT outcome, or naming the cause buys nothing. The
    /// three no-answer variants deliberately converge on `Unreachable` — that is the one collapse
    /// the design asks for, so it is asserted rather than left to inspection.
    ///
    /// Also exhaustive by compiler, for the same reason as the token test above: the `match` has no
    /// `_` arm, so a new `RelayRefusal` cannot be added without a deliberate decision about whether
    /// it gets its own outcome or joins the no-answer collapse.
    #[test]
    fn each_refusal_maps_to_its_own_outcome() {
        use crate::cloud::RelayRefusal as R;

        // NAMED vs COLLAPSED, decided here rather than inferred from the mapping under test — a
        // classification written by reading `From` would agree with any mapping, including a wrong
        // one. `true` = the user is told something specific; `false` = we could not tell.
        //
        // EVERY USE OF IT CROSSES TO `From`. An earlier version also asserted `is_named(x)` against
        // its own literal definition, which cannot fail whatever the mapping does (roborev 60337);
        // those self-assertions are gone. The exhaustive match (no `_` arm) still forces a new
        // `RelayRefusal` to be classified deliberately, and every case below tests the CODE.
        fn is_named(r: R) -> bool {
            match r {
                R::Unauthorized | R::NotEntitled | R::InsufficientCredits | R::Unconfigured => true,
                // NAMED. The relay counted this account's own streams to produce the 429, so it is
                // demonstrably reachable and healthy — collapsing it onto `Unreachable` would report
                // a working service as an outage, which is the failure this whole enum exists to
                // prevent.
                R::TooManyStreams => true,
                R::Http(_) | R::Unreachable | R::Local => false,
            }
        }
        // `Http(418)` is here and not only in the collapse loop below, so "an arbitrary unexpected
        // status collapses onto Unreachable" is actually asserted rather than merely listed.
        for r in [
            R::Unauthorized,
            R::NotEntitled,
            R::InsufficientCredits,
            R::Unconfigured,
            R::TooManyStreams,
            R::Http(500),
            R::Http(418),
            R::Unreachable,
            R::Local,
        ] {
            let outcome = CloudStreamOutcome::from(r);
            if is_named(r) {
                assert_ne!(
                    outcome,
                    CloudStreamOutcome::Unreachable,
                    "{r:?} is a named refusal and must not collapse onto Unreachable",
                );
            } else {
                assert_eq!(
                    outcome,
                    CloudStreamOutcome::Unreachable,
                    "{r:?} carries no answer to name, so it must collapse onto Unreachable",
                );
            }
        }

        assert_eq!(CloudStreamOutcome::from(R::Unauthorized), CloudStreamOutcome::Unauthorized);
        assert_eq!(CloudStreamOutcome::from(R::NotEntitled), CloudStreamOutcome::NotEntitled);
        assert_eq!(
            CloudStreamOutcome::from(R::InsufficientCredits),
            CloudStreamOutcome::InsufficientCredits,
        );
        assert_eq!(
            CloudStreamOutcome::from(R::Unconfigured),
            CloudStreamOutcome::RelayUnconfigured,
        );
        assert_eq!(
            CloudStreamOutcome::from(R::TooManyStreams),
            CloudStreamOutcome::TooManyStreams,
        );

        let named = [
            CloudStreamOutcome::from(R::Unauthorized),
            CloudStreamOutcome::from(R::NotEntitled),
            CloudStreamOutcome::from(R::InsufficientCredits),
            CloudStreamOutcome::from(R::Unconfigured),
            CloudStreamOutcome::from(R::TooManyStreams),
        ];
        for (i, a) in named.iter().enumerate() {
            for (j, b) in named.iter().enumerate() {
                if i != j {
                    assert_ne!(a, b, "refusals {i} and {j} must not collapse onto one outcome");
                }
            }
        }

        // No HTTP answer reached us — there is nothing to name, so all three are `Unreachable` and
        // the frontend keeps corroborating rather than accusing the relay of something specific.
        for r in [R::Http(500), R::Unreachable, R::Local] {
            assert_eq!(CloudStreamOutcome::from(r), CloudStreamOutcome::Unreachable);
        }
    }

    /// THE REGRESSION TEST for "auto-send never arms on the on-device path".
    ///
    /// Before this rule existed, a closed VAD segment emitted its transcript and NOTHING else —
    /// `dictation://speech-end` came only from the Deepgram relay. So the moment the cloud stream
    /// closed (or was never opened), speech kept flowing into the composer while the auto-send
    /// clock, which only `speechEndSeq` starts, sat unarmed forever: no countdown bar, no send.
    /// Observed in a real user's log as six unbroken minutes of `emit partial source="accept"`
    /// with zero auto-send evaluations, ending the instant `source="deepgram"` came back.
    ///
    /// The assertion is the SIDE EFFECT — that a decoded segment plans a speech-end at all — not
    /// the precondition that a decode happened. Nothing about the old code could satisfy it.
    #[test]
    fn a_decoded_segment_emits_its_transcript_and_then_a_speech_end() {
        // Every capture mode must agree that a closed segment ended an utterance, so the on-device
        // engine reports it exactly like Deepgram's endpointing does on the cloud path.
        assert_eq!(
            plan_decode_emit(DecodeOutcome::Decoded("ship it".into())),
            DecodeEmitPlan::PartialThenSpeechEnd("ship it".into()),
            "a closed VAD segment with words in it is the on-device engine saying the speaker \
             stopped — it must emit the speech-end, or auto-send never arms off the cloud path",
        );
        // Ordering is carried by the variant, not by luck: the transcript lands FIRST so the rail
        // recomputes its confidence threshold from THIS sentence, not the previous one. If the two
        // emits are ever split apart, this variant is what has to change.
        match plan_decode_emit(DecodeOutcome::Decoded("ship it".into())) {
            DecodeEmitPlan::PartialThenSpeechEnd(text) => assert_eq!(text, "ship it"),
            other => panic!("a decoded segment must plan partial-then-speech-end, got {other:?}"),
        }
    }

    #[test]
    fn no_emit_plan_can_carry_a_transcript_without_its_boundary() {
        // THE COUPLING, asserted over the TYPE rather than over one more input — which is the only
        // form of this test that can fail (roborev 55455). A second `plan_decode_emit(Decoded(..))`
        // row would just restate the row above it with a different string, and could not catch the
        // suppression's likeliest return (re-reading the shared flag inside the worker loop), because
        // the worker's emit path needs an `AppHandle` and has no test by construction.
        //
        // What this pins is the claim `PartialThenSpeechEnd`'s doc actually makes: separating the two
        // emits requires EDITING THIS TYPE. Adding a `PartialOnly`-shaped variant — one that carries
        // words but no boundary — fails the sweep below, which is the tripwire that matters, since
        // that is exactly how the suppression was expressed the first time and what silently broke
        // the hands-free flow ("Hey Sparkle, deploy the staging branch" closing as two segments, the
        // second draining after the relay opened, its transcript landing and its arm discarded with
        // no successor: the relay carries only silence and the on-device engine is no longer fed).
        for plan in [
            DecodeEmitPlan::PartialThenSpeechEnd("deploy the staging branch".into()),
            DecodeEmitPlan::Nothing,
            DecodeEmitPlan::WarnPanicked,
        ] {
            let carries_transcript = matches!(plan, DecodeEmitPlan::PartialThenSpeechEnd(_));
            // Today the two are the same variant, so this reads as a tautology — that IS the
            // invariant. It stops being one the moment someone adds a variant with a transcript and
            // no speech-end, and then this arm is what refuses to compile or match.
            let carries_boundary = match plan {
                DecodeEmitPlan::PartialThenSpeechEnd(_) => true,
                DecodeEmitPlan::Nothing | DecodeEmitPlan::WarnPanicked => false,
            };
            assert_eq!(
                carries_transcript, carries_boundary,
                "a plan that emits words must emit their utterance boundary too — a dropped \
                 boundary has no successor once the cloud owns the stream",
            );
        }
    }

    #[test]
    fn a_wordless_or_panicked_segment_stays_completely_silent() {
        // The VAD closes segments on coughs, doors and keyboards too. Those put NO text in the
        // composer, so arming a countdown would start a send over whatever was already there —
        // including text the user typed and never spoke. Noise must not be able to press send.
        assert_eq!(
            plan_decode_emit(DecodeOutcome::Decoded(String::new())),
            DecodeEmitPlan::Nothing,
            "an empty decode changed nothing in the composer, so it ended no utterance",
        );
        assert_eq!(
            plan_decode_emit(DecodeOutcome::Decoded("   \n\t ".into())),
            DecodeEmitPlan::Nothing,
            "whitespace-only is the same non-event as empty",
        );
        // A panicked decode DROPS words the user did say, so arming here would count down over a
        // knowingly incomplete sentence. Warn, emit nothing, let the next segment arm.
        assert_eq!(
            plan_decode_emit(DecodeOutcome::Panicked),
            DecodeEmitPlan::WarnPanicked,
            "a dropped segment must not arm a send over the words it just lost",
        );
    }

    /// Records the emits in the order they happen, so the WIRING is asserted rather than described.
    #[derive(Default)]
    struct RecordingSink(Vec<String>);

    impl DecodeEmitSink for RecordingSink {
        fn partial(&mut self, text: String) {
            self.0.push(format!("partial:{text}"));
        }
        fn speech_end(&mut self) {
            self.0.push("speech-end".into());
        }
        fn warn_panicked(&mut self) {
            self.0.push("warn".into());
        }
    }

    fn emits_for(outcome: DecodeOutcome) -> Vec<String> {
        let mut sink = RecordingSink::default();
        apply_decode_plan(plan_decode_emit(outcome), &mut sink);
        sink.0
    }

    /// THE WIRING TEST (roborev 55496). The two tests above pin the DECISION; this pins that the
    /// decision is actually carried out. Before `DecodeEmitSink` existed, the dispatch lived inside a
    /// spawned thread holding an `AppHandle`, so deleting the speech-end emit restored the original
    /// bug — auto-send never arming off the cloud path — with the whole suite still green.
    #[test]
    fn a_decoded_segment_actually_emits_the_transcript_and_then_the_speech_end() {
        // Both emits, in this order. Order is load-bearing, not cosmetic: the rail recomputes its
        // confidence threshold from the transcript, so a speech-end arriving first would arm the
        // countdown against the PREVIOUS sentence's duration.
        assert_eq!(
            emits_for(DecodeOutcome::Decoded("ship it".into())),
            vec!["partial:ship it", "speech-end"],
            "a closed VAD segment must emit its transcript and THEN the speech-end that arms the rail",
        );
    }

    #[test]
    fn a_wordless_or_panicked_segment_emits_nothing_onto_the_bus() {
        // Noise must not be able to press send, so these paths must reach the bus with NOTHING —
        // not merely plan to. A stray partial here would re-type text; a stray speech-end would arm
        // a countdown over whatever the user had typed and never spoken.
        assert!(
            emits_for(DecodeOutcome::Decoded(String::new())).is_empty(),
            "an empty decode must put nothing on the bus",
        );
        assert!(
            emits_for(DecodeOutcome::Decoded("  \n\t ".into())).is_empty(),
            "whitespace-only is the same non-event as empty",
        );
        // A panic logs and does NOT emit — in particular it must not emit a speech-end over the
        // words it just lost.
        assert_eq!(
            emits_for(DecodeOutcome::Panicked),
            vec!["warn"],
            "a recovered panic warns and emits nothing else",
        );
    }

    // ---- decode-worker teardown: the app-wide deadlock (spindump, 0.65.0 pid 27419) ----------
    //
    // WHAT HUNG: the main thread sat at 6705 of 6705 samples blocked on the session Mutex in
    // `set_focused`. The thread holding that mutex was in `drop_glue<DecodeWorker>` -> `pthread_join`.
    // The `parakeet-decode` thread it was joining was parked in `recv` -> `semaphore_wait_trap` —
    // i.e. the channel was still CONNECTED, because the Sender lives inside the cpal callback closure
    // and had not been freed. Every teardown path called that join "bounded"; none of them were.
    //
    // Each test below wraps its wait in an explicit deadline. That is deliberate: against the code
    // as it was, these do not merely fail, they HANG — which is exactly the property under test, and
    // a hanging CI job is a far worse signal than a failing assertion.

    /// A suppression flag that is never set — for the loops under test that are not exercising
    /// the detach path. Emits stay enabled, which is the production default.
    fn never() -> AtomicBool {
        AtomicBool::new(false)
    }

    /// Run `body` on a scratch thread and fail if it has not finished within `limit`.
    /// Returns nothing on success; panics with `what` on timeout, so a regression is a red test
    /// rather than a wedged test binary.
    fn within(limit: Duration, what: &str, body: impl FnOnce() + Send + 'static) {
        let (done_tx, done_rx) = channel::<()>();
        std::thread::spawn(move || {
            body();
            let _ = done_tx.send(());
        });
        assert!(
            done_rx.recv_timeout(limit).is_ok(),
            "{what} did not finish within {limit:?} — this is the deadlock, not a slow machine",
        );
    }

    // THE REGRESSION TEST FOR THE HANG. The Sender is deliberately held alive for the whole test:
    // that is the exact condition the spindump caught, and the condition every "the channel is
    // already closed by the time we get here" comment wrongly assumed away. Against the previous
    // `for samples in rx` loop this never returns.
    #[test]
    fn an_aborted_worker_exits_even_though_the_channel_never_closes() {
        let (tx, rx) = sync_channel::<Vec<f32>>(4);
        let abort = Arc::new(AtomicBool::new(false));
        let abort_loop = abort.clone();
        // Set the abort BEFORE the loop starts waiting, so this asserts the exit itself rather than
        // racing the signal in.
        abort.store(true, Ordering::Release);
        within(Duration::from_secs(5), "an aborted decode loop", move || {
            run_decode_loop(&rx, &abort_loop, &never(), |_| panic!("must not decode after abort"), |_: ()| {});
        });
        drop(tx); // held across the whole wait above — the point of the test
    }

    // The same thing with the abort arriving LATE, while the loop is already blocked in its wait.
    // This is the live case: `abort()` is called by a teardown on another thread against a worker
    // that is sitting idle on a still-open channel.
    #[test]
    fn an_abort_that_lands_while_the_worker_waits_is_still_observed() {
        let (tx, rx) = sync_channel::<Vec<f32>>(4);
        let abort = Arc::new(AtomicBool::new(false));
        let abort_loop = abort.clone();
        let (done_tx, done_rx) = channel::<()>();
        let loop_thread = std::thread::spawn(move || {
            run_decode_loop(&rx, &abort_loop, &never(), |_| panic!("no segments were sent"), |_: ()| {});
            let _ = done_tx.send(());
        });
        // Let the loop actually reach its wait, so this asserts that a LATE abort is observed —
        // the live case, where a teardown aborts a worker that is already parked.
        std::thread::sleep(DECODE_ABORT_POLL * 2);
        assert!(
            done_rx.try_recv().is_err(),
            "the loop exited before it was aborted — the test is not exercising what it claims"
        );
        abort.store(true, Ordering::Release);
        assert!(
            done_rx.recv_timeout(Duration::from_secs(5)).is_ok(),
            "a decode loop parked on a still-open channel never observed its abort — this is the \
             deadlock: the Sender lives in the cpal callback closure and may never be freed"
        );
        loop_thread.join().expect("loop thread");
        drop(tx); // held alive for the whole test on purpose
    }

    // The BEHAVIOUR THAT MUST NOT REGRESS while fixing the above. `stop_dictation` drops the worker
    // WITHOUT aborting, relying on it draining every queued segment (emitting their partials) before
    // it exits, so they land before the closing `final`. Exiting eagerly on close would silently
    // drop the tail of a user's dictation.
    #[test]
    fn a_worker_that_was_not_aborted_drains_every_queued_segment_before_exiting() {
        let (tx, rx) = sync_channel::<Vec<f32>>(8);
        let abort = Arc::new(AtomicBool::new(false));
        for i in 0..5 {
            tx.send(vec![i as f32]).expect("queue a segment");
        }
        drop(tx); // close the channel: an ordinary drain-to-close teardown
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen_loop = seen.clone();
        within(Duration::from_secs(5), "a draining decode loop", move || {
            run_decode_loop(&rx, &abort, &never(), |s: Vec<f32>| s[0], |v| seen_loop.lock().unwrap().push(v));
        });
        assert_eq!(
            *seen.lock().unwrap(),
            vec![0.0, 1.0, 2.0, 3.0, 4.0],
            "a non-aborted worker must decode the whole backlog, in order, before exiting"
        );
    }

    // THE BACKSTOP. Even with an exit signal, a worker wedged inside a decode (or an FFI call that
    // never returns) must not take the caller down with it. Dropping a `DecodeWorker` whose thread
    // will never exit has to return on the deadline and DETACH, because on most teardown paths the
    // caller is — or is blocking — the main thread.
    #[test]
    fn dropping_a_worker_that_never_exits_gives_up_instead_of_blocking_forever() {
        let _serial = super::DETACH_TESTS.lock().unwrap_or_else(|p| p.into_inner());
        let wedged = Arc::new(AtomicBool::new(true));
        let wedged_thread = wedged.clone();
        let (_exited_tx, exited) = channel::<()>();
        // A thread that ignores every signal — it holds `_exited_tx` nowhere, so `exited` stays
        // connected (never "exited") for as long as this test keeps `_exited_tx` alive.
        let handle = std::thread::spawn(move || {
            while wedged_thread.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        let worker = DecodeWorker {
            handle: Some(handle),
            abort: Arc::new(AtomicBool::new(false)),
            emits_are_unsafe: Arc::new(AtomicBool::new(false)),
            exited,
        };
        let started = Instant::now();
        within(Duration::from_secs(20), "dropping a wedged worker", move || drop(worker));
        let waited = started.elapsed();
        assert!(
            waited >= DECODE_JOIN_TIMEOUT,
            "it must actually WAIT the deadline ({DECODE_JOIN_TIMEOUT:?}) for an orderly exit, not \
             detach immediately — it gave up after {waited:?}",
        );
        assert!(
            waited < DECODE_JOIN_TIMEOUT * 4,
            "it must give up NEAR the deadline, not block on the thread — waited {waited:?}",
        );
        wedged.store(false, Ordering::Release); // let the detached thread go
    }

    // A worker that exits promptly must still be joined promptly — the deadline is a ceiling, not a
    // delay. Without this, "wait 2s then detach" would pass the test above while making every
    // ordinary window-blur teardown two seconds slower.
    #[test]
    fn dropping_a_worker_that_exits_promptly_does_not_wait_out_the_deadline() {
        let (tx, rx) = sync_channel::<Vec<f32>>(1);
        let abort = Arc::new(AtomicBool::new(false));
        let abort_worker = abort.clone();
        let (exited_tx, exited) = channel::<()>();
        let handle = std::thread::spawn(move || {
            let _exited_tx = exited_tx;
            run_decode_loop(&rx, &abort_worker, &never(), |_| {}, |()| {});
        });
        let worker = DecodeWorker { handle: Some(handle), abort, emits_are_unsafe: Arc::new(AtomicBool::new(false)), exited };
        worker.abort();
        let started = Instant::now();
        within(Duration::from_secs(10), "dropping an exiting worker", move || drop(worker));
        assert!(
            started.elapsed() < DECODE_JOIN_TIMEOUT,
            "an orderly exit must not be charged the full deadline (took {:?})",
            started.elapsed(),
        );
        drop(tx);
    }

    // THE TEST FOR THE FREEZE ITSELF (bead sparkle-7sfdx). Everything above proves the worker can
    // exit; this proves the SESSION LOCK IS NOT HELD while we wait for it, which is the property
    // that actually froze the UI. The turnstile chain in the spindump was:
    //     main (set_focused+56)  --waits-->  blur thread (set_focused+740, drop_glue -> join)
    //                            --waits-->  parakeet-decode (recv, no turnstile owner)
    // so any teardown that waits under the lock stalls every other taker of that mutex — the
    // main-thread focus handler and the audio watchdog both take it.
    //
    // The worker here is deliberately WEDGED (it ignores abort), which forces the teardown to spend
    // the full `DECODE_JOIN_TIMEOUT` before detaching. That makes the assertion deterministic rather
    // than a timing race: the lock must be acquirable by another thread *during* that window.
    // Against the previous code — `sess.decode_worker = None` inside the guard's scope — the lock
    // stays held for the whole (there, unbounded) wait and this cannot pass.
    //
    // `stop_capture` is the subject because it takes no `AppHandle`, so it is reachable from a unit
    // test; it shares the exact teardown shape with `reconcile_locked`, which the same change fixed.
    #[test]
    fn a_teardown_does_not_hold_the_session_lock_while_waiting_for_the_decode_worker() {
        let _serial = super::DETACH_TESTS.lock().unwrap_or_else(|p| p.into_inner());
        let wedged = Arc::new(AtomicBool::new(true));
        let wedged_thread = wedged.clone();
        let (_exited_tx, exited) = channel::<()>();
        let handle = std::thread::spawn(move || {
            while wedged_thread.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        let state = DictationState::default();
        state.0.lock().unwrap().decode_worker =
            Some(DecodeWorker { handle: Some(handle), abort: Arc::new(AtomicBool::new(false)), emits_are_unsafe: Arc::new(AtomicBool::new(false)), exited });

        // A second handle on the SAME session. `Arc<Mutex<DictationSession>>` is not `Send` by
        // itself (the session holds a !Send cpal Stream); `DictationState` is, via its `unsafe impl`
        // — so cross-thread sharing goes through that, exactly as the production code does.
        let session = DictationState(state.0.clone(), state.1.clone());
        let (tearing_down_tx, tearing_down_rx) = channel::<()>();
        let teardown = std::thread::spawn(move || {
            let _ = tearing_down_tx.send(());
            state.stop_capture(); // takes the lock, takes the worker, drops it AFTER releasing
        });
        tearing_down_rx.recv_timeout(Duration::from_secs(5)).expect("teardown started");
        // Give it time to be unambiguously inside the worker wait, while still leaving most of the
        // deadline ahead of us — so a pass means "the lock was free mid-wait", not "we got in first".
        std::thread::sleep(DECODE_ABORT_POLL * 3);

        let (locked_tx, locked_rx) = channel::<()>();
        std::thread::spawn(move || {
            // Rebind so the closure captures the whole `DictationState` (which is `Send` via its
            // `unsafe impl`) rather than precise-capturing the inner `Arc<Mutex<…>>`, which is not.
            let session = session;
            let _guard = session.0.lock().unwrap_or_else(|p| p.into_inner());
            let _ = locked_tx.send(());
        });
        assert!(
            locked_rx.recv_timeout(DECODE_JOIN_TIMEOUT / 2).is_ok(),
            "the session lock was still held while the teardown waited on the decode worker — this \
             is the v0.65.0 hard-freeze: the main thread's focus handler takes this same mutex"
        );

        wedged.store(false, Ordering::Release);
        teardown.join().expect("teardown thread");
    }

    // THE `stop_dictation` SHAPE (roborev 55754, High). Every other teardown aborts first; this one
    // deliberately does not, because it wants the worker to drain its queued partials before the
    // closing `dictation://final`. That is safe only while the channel closes — the exact premise
    // this change proves false. So the un-aborted drop must ALSO terminate the worker when the
    // `Sender` is still alive, or "mic off" leaks a live thread on every cycle: one that keeps
    // waking, holds the transcriber and `AppHandle`, and can still emit a partial after the final.
    //
    // The drop-observer is the point. Asserting only that `drop` RETURNED would pass against a bare
    // detach, which is precisely the defect: the caller is unblocked while the thread runs forever.
    #[test]
    fn dropping_an_un_aborted_worker_over_a_live_sender_still_terminates_the_thread() {
        let _serial = super::DETACH_TESTS.lock().unwrap_or_else(|p| p.into_inner());
        let (tx, rx) = sync_channel::<Vec<f32>>(4);
        let abort = Arc::new(AtomicBool::new(false));
        let abort_worker = abort.clone();
        let (exited_tx, exited) = channel::<()>();
        // Moved into the worker: while the thread runs it holds a strong ref, so the count falling
        // back to 1 is positive evidence the thread actually RETURNED, not merely was detached.
        let alive = Arc::new(());
        let alive_worker = alive.clone();
        let handle = std::thread::spawn(move || {
            let _exited_tx = exited_tx;
            let _alive = alive_worker;
            run_decode_loop(&rx, &abort_worker, &never(), |_: Vec<f32>| {}, |()| {});
        });
        let worker = DecodeWorker { handle: Some(handle), abort, emits_are_unsafe: Arc::new(AtomicBool::new(false)), exited };

        let started = Instant::now();
        // NOTE: no `worker.abort()` — this is the stop_dictation path.
        within(Duration::from_secs(20), "dropping an un-aborted worker", move || drop(worker));
        let waited = started.elapsed();

        assert!(
            waited >= DECODE_DRAIN_BUDGET,
            "the drain must get its full budget before we abort it — gave up after {waited:?}"
        );
        // The bound the CODE actually guarantees: the drain elapses in full, then up to a grace.
        // Asserting strictly under the ceiling made this fail on a busy runner for a worker that
        // behaved exactly as designed; the ceiling arithmetic is pinned deterministically by
        // `the_teardown_budget_is_carved_up_not_added_to` instead (roborev 55803).
        assert!(
            waited < DECODE_JOIN_TIMEOUT + DECODE_ABORT_GRACE,
            "the drop must return within the guaranteed bound, not block on the thread ({waited:?})"
        );
        assert_eq!(
            Arc::strong_count(&alive),
            1,
            "the decode thread is STILL RUNNING after teardown returned — a detached worker keeps \
             waking, holds the transcriber and AppHandle, and can emit a partial after the final"
        );
        drop(tx); // the Sender was alive for the entire teardown — the whole point
    }

    // The budget is a CEILING that the abort-then-grace split must not inflate. The caller is the
    // main thread and the leaked-Sender case hits this deadline on EVERY teardown, so a grace
    // ADDED to the timeout (rather than carved out of it) would be a routine 25% longer stall.
    #[test]
    fn the_teardown_budget_is_carved_up_not_added_to() {
        assert_eq!(
            DECODE_DRAIN_BUDGET + DECODE_ABORT_GRACE,
            DECODE_JOIN_TIMEOUT,
            "the drain budget and the abort grace must SUM to the ceiling, not exceed it"
        );
        assert!(
            DECODE_ABORT_GRACE >= DECODE_ABORT_POLL * 2,
            "the grace must cover at least a couple of poll ticks or an idling worker gets detached"
        );
    }

    // A worker aborted while it is INSIDE a decode must emit nothing when that decode returns.
    // `abort` bounds the loop, which is not the same as bounding an in-flight segment — and the
    // detach path is reached precisely when the worker is stuck in `on_segment`. Without the
    // between-decode-and-emit check, the transcript lands after `dictation://final`, re-populating
    // the composer and re-arming auto-send over speech the user already finished (roborev 55788).
    /// Drive one segment through `run_decode_loop` with the decode held open, flip whichever flags
    /// the caller asks for while it is blocked, then release it. Returns what reached `emit`.
    ///
    /// Shared by the pair below because the ONLY difference that matters is which flag was set —
    /// writing it twice invites the two from drifting into testing different things.
    fn emits_after_teardown_flags(set_abort: bool, set_unsafe: bool) -> Vec<f32> {
        let (tx, rx) = sync_channel::<Vec<f32>>(4);
        let abort = Arc::new(AtomicBool::new(false));
        let unsafe_flag = Arc::new(AtomicBool::new(false));
        let (abort_loop, unsafe_loop) = (abort.clone(), unsafe_flag.clone());
        let emitted = Arc::new(Mutex::new(Vec::<f32>::new()));
        let emitted_worker = emitted.clone();
        let (in_decode_tx, in_decode_rx) = channel::<()>();
        let (release_tx, release_rx) = channel::<()>();
        // The loop's exit is what we wait on, NOT `join()` — see the bounded wait below.
        let (exited_tx, exited_rx) = channel::<()>();

        let worker = std::thread::spawn(move || {
            run_decode_loop(
                &rx,
                &abort_loop,
                &unsafe_loop,
                // Stands in for `Decoder::transcribe`: announce we are inside the decode, then
                // block until released — i.e. this decode outlives the teardown.
                move |samples: Vec<f32>| {
                    let _ = in_decode_tx.send(());
                    let _ = release_rx.recv();
                    samples[0]
                },
                move |v| emitted_worker.lock().unwrap().push(v),
            );
            let _ = exited_tx.send(());
        });

        tx.send(vec![42.0]).expect("queue a segment");
        in_decode_rx.recv_timeout(Duration::from_secs(5)).expect("worker reached the decode");
        if set_abort {
            abort.store(true, Ordering::Release);
        }
        if set_unsafe {
            unsafe_flag.store(true, Ordering::Release);
        }
        let _ = release_tx.send(()); // the decode now returns
        // Wait on the loop's EXIT with a deadline rather than `join()`. Either flag must terminate
        // the loop, and `tx` is deliberately still alive here (as in production), so a regression
        // that leaves the loop spinning would block a bare `join()` forever — a hung test, which
        // CI reports as a six-hour timeout with no failing assertion rather than as this bug.
        // Verified: reverting the emit guard to `abort` wedged this helper for 50 minutes.
        exited_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("run_decode_loop never exited after teardown flags were set");
        worker.join().expect("worker thread"); // now known to be done; cannot block
        drop(tx); // the Sender stayed alive throughout, as in production
        let out = emitted.lock().unwrap().clone();
        out
    }

    // THE REGRESSION THIS PAIR EXISTS FOR (roborev 55803). A previous revision suppressed the emit
    // whenever `abort` was set, which conflated "teardown began" with "the final is already out".
    // They are not the same moment: `stop_dictation` stores `abort`, waits up to the grace, and only
    // then emits `dictation://final`. So a ≤8 s segment whose transcribe merely outran the 1.5 s
    // drain budget — squarely inside `DECODE_JOIN_TIMEOUT`'s own stated worst case — had its
    // transcript thrown away, losing the user's last sentence on a path that used to emit it fine.
    #[test]
    fn a_decode_finishing_during_the_abort_grace_still_emits_before_the_final() {
        assert_eq!(
            emits_after_teardown_flags(true, false),
            vec![42.0],
            "a decode that finished after abort but before teardown returned must still emit — it \
             lands ahead of dictation://final, and dropping it silently eats the last sentence"
        );
    }

    // The other side: once we have DETACHED, teardown has returned and the final may already be
    // out, so this worker's emit would append a stale fragment to a finished transcript and re-arm
    // auto-send. That is one of the TWO moments suppression is correct (the other being `abort()`,
    // whose callers are discarding the backlog); both set the flag, the drain escalation does not.
    #[test]
    fn a_decode_finishing_after_the_worker_was_detached_does_not_emit() {
        let _serial = super::DETACH_TESTS.lock().unwrap_or_else(|p| p.into_inner());
        assert!(
            emits_after_teardown_flags(false, true).is_empty(),
            "a detached worker emitted past teardown — that fragment lands after dictation://final"
        );
    }

    // THE MIRROR IMAGE, and the one the whole fix rests on (roborev 56026). `Drop` writes `abort`
    // twice for different reasons: the drain escalation (teardown has NOT returned — a decode
    // finishing in the grace still lands ahead of dictation://final, so it MUST emit) and the detach
    // (teardown HAS returned, so it must not). Only the second sets `emits_are_unsafe`.
    //
    // Nothing covered that asymmetry end to end: the grace test sets `abort` by hand and never runs
    // `Drop`, and the un-aborted-worker test wires the loop to `&never()` with a *different* Arc, so
    // it cannot observe the store at all. Adding the suppression to the escalation branch would
    // reinstate the eaten-last-sentence bug with the entire suite green.
    //
    // This is `stop_dictation`'s exact shape: never calls `abort()`, the Sender stays alive (the
    // leaked-Sender case), so the drain budget expires, `Drop` escalates, and the held-open decode
    // is released during the grace. It must still reach `emit`.
    #[test]
    fn a_drain_escalation_still_lets_the_in_flight_decode_emit() {
        let _serial = super::DETACH_TESTS.lock().unwrap_or_else(|p| p.into_inner());
        let (tx, rx) = sync_channel::<Vec<f32>>(4);
        let abort = Arc::new(AtomicBool::new(false));
        let emits_are_unsafe = Arc::new(AtomicBool::new(false));
        let (abort_loop, unsafe_loop) = (abort.clone(), emits_are_unsafe.clone());
        let emitted = Arc::new(Mutex::new(Vec::<f32>::new()));
        let emitted_worker = emitted.clone();
        let (in_decode_tx, in_decode_rx) = channel::<()>();
        let (release_tx, release_rx) = channel::<()>();
        let (exited_tx, exited) = channel::<()>();

        let handle = std::thread::spawn(move || {
            let _exited_tx = exited_tx;
            run_decode_loop(
                &rx,
                &abort_loop,
                &unsafe_loop,
                move |samples: Vec<f32>| {
                    let _ = in_decode_tx.send(());
                    let _ = release_rx.recv();
                    samples[0]
                },
                move |v| emitted_worker.lock().unwrap().push(v),
            );
        });
        // Same Arcs as the loop, so the test observes what `Drop` actually stores.
        let worker =
            DecodeWorker { handle: Some(handle), abort: abort.clone(), emits_are_unsafe, exited };

        tx.send(vec![42.0]).expect("queue a segment");
        in_decode_rx.recv_timeout(Duration::from_secs(5)).expect("worker reached the decode");

        // Teardown on another thread: it blocks for the drain budget, then escalates. NO `abort()`.
        let teardown = std::thread::spawn(move || drop(worker));

        // Wait for the escalation itself rather than a wall-clock guess: `abort` going true IS the
        // escalation, and it happens exactly once the drain budget expires.
        let escalated = Instant::now();
        while !abort.load(Ordering::Acquire) {
            assert!(
                escalated.elapsed() < DECODE_JOIN_TIMEOUT * 4,
                "Drop never escalated to an abort — the drain budget should have expired by now"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        // We are now inside DECODE_ABORT_GRACE. Release the decode; it must still emit.
        let _ = release_tx.send(());
        within(Duration::from_secs(20), "the escalated teardown", move || {
            teardown.join().expect("teardown thread");
        });

        assert_eq!(
            *emitted.lock().unwrap(),
            vec![42.0],
            "the drain escalation suppressed an emit that was still IN ORDER — it lands ahead of \
             dictation://final, and dropping it silently eats the user's last sentence"
        );
        drop(tx);
    }

    // THE OTHER HALF OF THE SPLIT (roborev 56014). Separating the two signals fixed
    // `stop_dictation`, but every OTHER teardown calls `abort()` precisely to throw the backlog
    // away — app-exit quiesce, window blur, mute pause, capture reacquire. On those paths an
    // in-flight decode that returns inside the drain budget must stay silent: emitting would send
    // `dictation://partial` + `dictation://speech-end`, arming the auto-send countdown over a mic
    // the user just muted. Drives the real `abort()` + real `Drop`, and asserts the side effect.
    #[test]
    fn a_worker_aborted_to_abandon_its_backlog_emits_nothing_for_the_in_flight_segment() {
        let _serial = super::DETACH_TESTS.lock().unwrap_or_else(|p| p.into_inner());
        let (tx, rx) = sync_channel::<Vec<f32>>(4);
        let abort = Arc::new(AtomicBool::new(false));
        let emits_are_unsafe = Arc::new(AtomicBool::new(false));
        let (abort_loop, unsafe_loop) = (abort.clone(), emits_are_unsafe.clone());
        let emitted = Arc::new(Mutex::new(Vec::<f32>::new()));
        let emitted_worker = emitted.clone();
        let (in_decode_tx, in_decode_rx) = channel::<()>();
        let (release_tx, release_rx) = channel::<()>();
        let (exited_tx, exited) = channel::<()>();

        let handle = std::thread::spawn(move || {
            let _exited_tx = exited_tx;
            run_decode_loop(
                &rx,
                &abort_loop,
                &unsafe_loop,
                move |samples: Vec<f32>| {
                    let _ = in_decode_tx.send(());
                    let _ = release_rx.recv();
                    samples[0]
                },
                move |v| emitted_worker.lock().unwrap().push(v),
            );
        });
        let worker = DecodeWorker { handle: Some(handle), abort, emits_are_unsafe, exited };

        tx.send(vec![42.0]).expect("queue a segment");
        in_decode_rx.recv_timeout(Duration::from_secs(5)).expect("worker reached the decode");

        // Exactly what stop_capture / the Teardown plans do: abandon the backlog, then drop.
        worker.abort();
        let _ = release_tx.send(()); // the decode returns well inside the drain budget
        within(Duration::from_secs(20), "dropping an aborted worker", move || drop(worker));

        assert!(
            emitted.lock().unwrap().is_empty(),
            "a worker aborted to ABANDON its backlog emitted its in-flight segment anyway — that \
             arms the auto-send countdown over speech the user abandoned by muting or tabbing away"
        );
        drop(tx);
    }

    // The pair above sets the flags BY HAND, so together they only prove `run_decode_loop` honours
    // them. Nothing proved the other half: that teardown actually SETS the suppression when it
    // detaches. Deleting that one store left every test green while the real detach path stayed
    // broken — so drive the whole thing end to end, through the real `Drop`, with a real wedged
    // `run_decode_loop`, and assert the SIDE EFFECT: the released decode emits nothing.
    #[test]
    fn a_real_teardown_that_detaches_silences_the_worker_it_left_running() {
        let _serial = super::DETACH_TESTS.lock().unwrap_or_else(|p| p.into_inner());
        let (tx, rx) = sync_channel::<Vec<f32>>(4);
        let abort = Arc::new(AtomicBool::new(false));
        let emits_are_unsafe = Arc::new(AtomicBool::new(false));
        let (abort_loop, unsafe_loop) = (abort.clone(), emits_are_unsafe.clone());
        let emitted = Arc::new(Mutex::new(Vec::<f32>::new()));
        let emitted_worker = emitted.clone();
        let (in_decode_tx, in_decode_rx) = channel::<()>();
        let (release_tx, release_rx) = channel::<()>();
        let (exited_tx, exited) = channel::<()>(); // the worker's own signal, owned by DecodeWorker
        let (done_tx, done_rx) = channel::<()>(); // our separate "the loop returned" signal

        let handle = std::thread::spawn(move || {
            let _exited_tx = exited_tx; // dropped when the body returns == the exit signal
            run_decode_loop(
                &rx,
                &abort_loop,
                &unsafe_loop,
                // Wedged inside the decode: it ignores `abort` entirely, which is exactly the
                // condition that forces teardown to detach instead of joining.
                move |samples: Vec<f32>| {
                    let _ = in_decode_tx.send(());
                    let _ = release_rx.recv();
                    samples[0]
                },
                move |v| emitted_worker.lock().unwrap().push(v),
            );
            let _ = done_tx.send(());
        });
        let worker = DecodeWorker { handle: Some(handle), abort, emits_are_unsafe, exited };

        tx.send(vec![42.0]).expect("queue a segment");
        in_decode_rx.recv_timeout(Duration::from_secs(5)).expect("worker reached the decode");

        // Real teardown. The worker is wedged, so this must run the full budget + grace and detach.
        within(Duration::from_secs(20), "tearing down a wedged worker", move || drop(worker));

        // Teardown has RETURNED — dictation://final is out. Now let the decode finish.
        let _ = release_tx.send(());
        done_rx.recv_timeout(Duration::from_secs(5)).expect("the detached worker exited");
        assert!(
            emitted.lock().unwrap().is_empty(),
            "teardown detached this worker and returned, then the worker emitted anyway — that \
             fragment lands after dictation://final, re-populating the composer and re-arming \
             auto-send over speech the user already finished"
        );
        drop(tx);
    }

    /// THE CACHE'S ONE SHARP EDGE (knightwatch 5198234927#1). `DECODER_CACHE` hands every arm the
    /// SAME `Arc<Decoder>`, and `Decoder::transcribe` holds the recognizer mutex for the whole FFI
    /// decode. A worker teardown had to DETACH is wedged by definition — plausibly inside that very
    /// decode — so it keeps that mutex. Before the cache that cost one parked thread holding its own
    /// per-arm recognizer; with it, every later arm's worker blocks on `recognizer.lock()`, its
    /// queue fills, and the callback drops segments: the mic goes deaf for the life of the process.
    ///
    /// BOTH directions are asserted here, in ONE test on purpose: the counter is process-global, so
    /// two tests reading it would race each other. The negative half is the load-bearing one —
    /// retiring on an ORDINARY teardown would re-run the ONNX init on every push-to-talk release,
    /// which IS the founder-blocking regression this PR exists to remove.
    #[test]
    fn only_a_detaching_teardown_retires_the_cached_decoder() {
        let _serial = super::DETACH_TESTS.lock().unwrap_or_else(|p| p.into_inner());
        use std::sync::atomic::Ordering as AtomicOrdering;
        let retires = || super::DECODERS_RETIRED.load(AtomicOrdering::Acquire);

        // ── The ordinary teardown: the worker observes the abort and exits, so `Drop` joins it.
        let before_ordinary = retires();
        let (tx, rx) = sync_channel::<Vec<f32>>(4);
        let abort = Arc::new(AtomicBool::new(false));
        let abort_worker = abort.clone();
        let (exited_tx, exited) = channel::<()>();
        let handle = std::thread::spawn(move || {
            let _exited_tx = exited_tx;
            run_decode_loop(&rx, &abort_worker, &never(), |_: Vec<f32>| {}, |()| {});
        });
        let worker = DecodeWorker {
            handle: Some(handle),
            abort,
            emits_are_unsafe: Arc::new(AtomicBool::new(false)),
            exited,
        };
        worker.abort();
        within(Duration::from_secs(20), "dropping a healthy worker", move || drop(worker));
        assert_eq!(
            retires(),
            before_ordinary,
            "a teardown that JOINED its worker retired the cached decoder anyway — that makes every \
             push-to-talk release pay for another ONNX init, which is exactly the multi-second \
             window the release lands in, and the mic goes deaf again",
        );
        drop(tx);

        // ── The detach: a worker wedged inside the decode, so `Drop` gives up and leaves it running
        // while it still holds the recognizer mutex the cached decoder is made of.
        let (tx, rx) = sync_channel::<Vec<f32>>(4);
        let abort = Arc::new(AtomicBool::new(false));
        let abort_loop = abort.clone();
        let (in_decode_tx, in_decode_rx) = channel::<()>();
        let (release_tx, release_rx) = channel::<()>();
        let (exited_tx, exited) = channel::<()>();
        let handle = std::thread::spawn(move || {
            let _exited_tx = exited_tx;
            run_decode_loop(
                &rx,
                &abort_loop,
                &never(),
                move |samples: Vec<f32>| {
                    let _ = in_decode_tx.send(());
                    let _ = release_rx.recv(); // wedged: it ignores the abort, forcing the detach
                    samples[0]
                },
                |_| {},
            );
        });
        let worker = DecodeWorker {
            handle: Some(handle),
            abort,
            emits_are_unsafe: Arc::new(AtomicBool::new(false)),
            exited,
        };
        tx.send(vec![42.0]).expect("queue a segment");
        in_decode_rx.recv_timeout(Duration::from_secs(5)).expect("worker reached the decode");

        within(Duration::from_secs(20), "tearing down a wedged worker", move || drop(worker));

        assert_eq!(
            retires(),
            before_ordinary + 1,
            "teardown detached a worker that may still be inside Decoder::transcribe and left the \
             cached decoder installed — every later arm now blocks on that recognizer mutex, so \
             dictation is silently deaf for the rest of the process",
        );
        let _ = release_tx.send(());
        drop(tx);
    }

    // The drain is best-effort within `DECODE_DRAIN_BUDGET`; past it the backlog is DISCARDED. That
    // is a deliberate trade (the caller is the main thread), so pin it: what was emitted must be a
    // PREFIX of the queue — in order, truncated — never reordered and never complete-by-accident.
    // The pre-existing drain test uses a no-op `on_segment`, so it cannot tell these apart.
    // The drain is best-effort within `DECODE_DRAIN_BUDGET`; past it the backlog is DISCARDED. That
    // is a deliberate trade (the caller is the main thread), so pin it: what was emitted must be a
    // PREFIX of the queue — in order, truncated — never reordered and never complete-by-accident.
    //
    // Handshake-driven, with NO sleeps. An earlier revision slept 150ms and hoped two 60ms decodes
    // had landed, which is a wall-clock race that fails on a loaded runner and reads like an
    // inherited flake on an untouched path (roborev 55803).
    #[test]
    fn a_drain_that_outruns_its_budget_is_truncated_to_a_prefix_not_reordered() {
        let (tx, rx) = sync_channel::<Vec<f32>>(8);
        let abort = Arc::new(AtomicBool::new(false));
        let abort_loop = abort.clone();
        let seen = Arc::new(Mutex::new(Vec::<f32>::new()));
        let seen_worker = seen.clone();
        // Strict per-segment handshake: the decode announces itself and then waits to be released.
        // Nothing here is timed, so the point at which the abort lands is exact rather than hoped.
        let (ready_tx, ready_rx) = channel::<f32>();
        let (go_tx, go_rx) = channel::<()>();
        for i in 0..6 {
            tx.send(vec![i as f32]).expect("queue a segment");
        }
        let worker = std::thread::spawn(move || {
            run_decode_loop(
                &rx,
                &abort_loop,
                &never(),
                move |s: Vec<f32>| {
                    let _ = ready_tx.send(s[0]);
                    let _ = go_rx.recv();
                    s[0]
                },
                move |v| seen_worker.lock().unwrap().push(v),
            );
        });

        // Let two segments through, observed rather than timed.
        for expected in [0.0, 1.0] {
            let got = ready_rx.recv_timeout(Duration::from_secs(5)).expect("a decode started");
            assert_eq!(got, expected, "the drain must decode in queue order");
            go_tx.send(()).expect("release the decode");
        }
        // The third is now in-flight. Abort while it decodes — exactly what the drain budget's
        // expiry does — then release it. It still emits (it lands before the final; see
        // `a_decode_finishing_during_the_abort_grace_still_emits_before_the_final`), and the loop
        // then exits at the top with three segments never decoded at all.
        let got = ready_rx.recv_timeout(Duration::from_secs(5)).expect("the third decode started");
        assert_eq!(got, 2.0);
        abort.store(true, Ordering::Release);
        go_tx.send(()).expect("release the in-flight decode");
        worker.join().expect("worker thread");

        // The handshake makes this EXACT, so assert the exact value rather than a prefix property.
        // `seen.len() < 6` plus `seen == full[..seen.len()]` reads like a strong pair but both hold
        // for an empty `seen` (`0 < 6`, `[] == []`) — so a loop that emitted nothing at all would
        // have passed a test whose whole contract is "a prefix, never complete-by-accident"
        // (roborev 56014). Segments 0-2 decode and emit; 3-5 are never dequeued.
        let seen = seen.lock().unwrap().clone();
        assert_eq!(
            seen,
            vec![0.0, 1.0, 2.0],
            "the drain must emit an in-order PREFIX and then stop: the two released segments plus \
             the in-flight one that finished during the grace, with 3-5 abandoned unread"
        );
        drop(tx);
    }

    // ---- audio liveness watchdog ----------------------------------------------------------
    // Guards the 2026-07-29 incident: capture ran for nine minutes receiving nothing while the UI
    // showed an idle waveform and the user talked to a dead mic.

    #[test]
    fn a_capture_that_hears_nothing_is_re_acquired_before_the_user_is_bothered() {
        // Escalation order matters. Most device changes are recoverable by rebinding, and a user
        // who never sees an error is better served than one who sees an error they must act on.
        // So: silent recovery FIRST, complain only if that failed.
        for health in [AudioHealth::NoFrames, AudioHealth::Silent] {
            assert_eq!(
                fault_action(health, false, false, false, false),
                FaultAction::Reacquire,
                "{health:?} must first try to recover silently"
            );
            assert_eq!(
                fault_action(health, false, true, false, false),
                FaultAction::Report,
                "{health:?} that survived a re-acquire must reach the user"
            );
        }
    }

    #[test]
    fn the_user_is_told_once_per_capture_not_once_per_poll() {
        // The watchdog ticks every second. Without the `reported` latch a dead mic would emit an
        // error 540 times over the nine minutes this bug actually lasted.
        assert_eq!(fault_action(AudioHealth::Silent, false, true, true, false), FaultAction::Idle);
        assert_eq!(fault_action(AudioHealth::NoFrames, false, true, true, false), FaultAction::Idle);
    }

    #[test]
    fn a_permanently_dead_device_does_not_re_acquire_forever() {
        // The failure mode of a naive retry loop: rebuild, still dead, rebuild… never surfacing.
        // Once we have spent the one free attempt, the next verdict must escalate, not retry.
        assert_ne!(fault_action(AudioHealth::Silent, false, true, false, false), FaultAction::Reacquire);
    }

    #[test]
    fn recovery_is_announced_only_if_something_was_announced_first() {
        // Retracting a notice nobody saw would clear an UNRELATED error the user does need — the
        // frontend keys its "audio is back" handling off this event.
        assert_eq!(fault_action(AudioHealth::Live, false, true, true, false), FaultAction::Recovered);
        assert_eq!(
            fault_action(AudioHealth::Live, false, true, false, false),
            FaultAction::Idle,
            "healthy audio with no complaint outstanding must not emit a retraction"
        );
    }

    #[test]
    fn a_warming_capture_is_never_condemned_or_recovered() {
        // Before the grace window expires we have no evidence either way; acting on it would emit
        // a spurious fault on every single rebuild. Still true — but only for a capture we have no
        // OTHER evidence about, which is what the `false` in the last position now says. The
        // companion case (evidence carried over from earlier captures) is the test below.
        for (reacquired, reported) in [(false, false), (true, false), (true, true)] {
            assert_eq!(
                fault_action(AudioHealth::Warming, false, reacquired, reported, false),
                FaultAction::Idle
            );
        }
    }

    /// THE 2026-08-05 SILENCE, AT THE DECISION THAT SWALLOWED IT.
    ///
    /// A stop landing during each model load tore the capture down every ~2s — under the 4s grace —
    /// so `assess_capture_health` answered `Warming` on nearly every tick and the escalation ladder
    /// was reset by the next rebuild before it could be climbed. Six minutes, one `Reacquire`, no
    /// `Report`, and a founder talking to a dead microphone.
    ///
    /// The assertion is on the OUTPUT (a Report is produced) rather than on the input flag, so it
    /// fails if the `Warming` arm ever goes back to an unconditional `Idle`.
    #[test]
    fn cross_capture_silence_evidence_breaks_through_the_warming_gate() {
        // The exact shape of the churn: a young capture, no per-capture latch spent, and nothing
        // yet reported — the state every one of those six minutes' ticks was in.
        assert_eq!(
            fault_action(AudioHealth::Warming, false, false, false, true),
            FaultAction::Report,
            "a capture too young to judge, on a device already proven silent, must still speak up"
        );
        // Once said, it is not said again — the churn would otherwise emit an error every second.
        assert_eq!(
            fault_action(AudioHealth::Warming, false, false, true, true),
            FaultAction::Idle,
            "the report latch still holds under durable silence"
        );
        // And durable evidence must not invent a fault on a HEALTHY capture.
        assert_eq!(
            fault_action(AudioHealth::Live, false, false, false, true),
            FaultAction::Idle
        );
    }

    /// THE STALE-GRANT REPORT NAMES A CAUSE, AND IT IS NOT THE GENERIC ONE.
    ///
    /// The 2026-08-05 reading — built-in mic, not muted, not virtual, `zero_source=Os`,
    /// `tcc=Authorized` — used to produce "Another app … may be holding the microphone", sending the
    /// founder to hunt a screen recorder that did not exist. Asserted through `watchdog_emission`
    /// (the real dispatch path) rather than the message helper, so a Report that stopped consulting
    /// the evidence would fail here.
    #[test]
    fn os_silence_on_an_authorized_grant_is_reported_as_a_permission_fault() {
        let physical = crate::audio::BoundDevice {
            name: "MacBook Pro Microphone".into(),
            uid: Some("BuiltInMicrophoneDevice".into()),
            is_virtual: false,
            was_default: true,
        };
        let WatchdogEmission::Error(msg) = watchdog_emission(
            FaultAction::Report,
            Some(&physical),
            false,
            ZeroSource::Os,
            crate::mic_permission::MicAuth::Authorized,
            false,
        ) else {
            panic!("a Report must speak");
        };
        assert!(msg.contains("MacBook Pro Microphone"), "the device is still named: {msg}");
        assert!(
            msg.to_lowercase().contains("permission"),
            "the cause the log already knew must reach the user: {msg}"
        );
        assert!(
            msg.contains("Quit Sparkle"),
            "the remedy that actually re-establishes the grant must be named: {msg}"
        );
        // ORDER, not absence. `zero_source=Os` covers a held device too (audio.rs says so), so
        // denying that possibility would be a confident wrong cause — the original defect with the
        // blame moved. What must hold is that the free remedy that fixes the observed case leads,
        // and the held-device check follows it (knightwatch probe 1).
        let restart = msg.find("Quit Sparkle").expect("the relaunch remedy must be present: {msg}");
        let held = msg.find("holding the mic").expect("the held-device check must survive: {msg}");
        assert!(restart < held, "relaunch must be offered BEFORE hunting another app: {msg}");
        assert!(
            !msg.contains("Another app (a screen recorder"),
            "must not fall back to the generic no-audio sentence, which leads with the wrong cause: \
             {msg}"
        );

        // THE DISCRIMINATOR. Same silence, but our own downmix ate it (`SelfInflicted`) — that is a
        // Sparkle bug, not a grant problem, and must keep the generic wording rather than sending
        // the user to quit and relaunch over a fault relaunching cannot fix.
        let WatchdogEmission::Error(ours) = watchdog_emission(
            FaultAction::Report,
            Some(&physical),
            false,
            ZeroSource::SelfInflicted,
            crate::mic_permission::MicAuth::Authorized,
            false,
        ) else {
            panic!("a Report must speak");
        };
        assert!(
            !ours.contains("Quit Sparkle"),
            "only the OS-sourced zeros earn the restart remedy: {ours}"
        );

        // A muted device keeps its own message: unmuting is the fix, and it outranks the grant story.
        let WatchdogEmission::Error(muted) = watchdog_emission(
            FaultAction::Report,
            Some(&physical),
            true,
            ZeroSource::Os,
            crate::mic_permission::MicAuth::Authorized,
            false,
        ) else {
            panic!("a Report must speak");
        };
        assert!(muted.contains("is muted"), "a muted device is still named as muted: {muted}");
    }

    /// THE BUNDLE-REPLACED REPORT, AND ITS PAIR — one bit apart, driven through the real dispatch.
    ///
    /// A test that only proves ABSENCE is ambiguous (AGENTS.md): "no System Settings in the copy"
    /// passes just as well for a build that lost the stale-grant sentence entirely, or that never
    /// consults `bundle_replaced` and always emits the new one. So all three readings are asserted
    /// from the SAME setup, and no single mutation can satisfy them together:
    ///
    ///   bundle_replaced = true   → the update copy, which must NOT send anyone to System Settings
    ///   bundle_replaced = false  → the OLD stale-grant copy, System Settings and all
    ///   muted = true, replaced   → still the muted copy, because unmuting is still the fix
    ///
    /// The third is the precedence guard. `is_stale_grant` is deliberately UNCHANGED by this
    /// feature — the swap is a refinement WITHIN it — so a muted device must keep outranking the
    /// update story even in the middle of an update. Wiring `bundle_replaced` ahead of the mute
    /// check would pass both of the first two and fail here.
    #[test]
    fn a_bundle_swapped_under_the_process_changes_the_remedy_but_not_the_precedence() {
        let physical = crate::audio::BoundDevice {
            name: "MacBook Pro Microphone".into(),
            uid: Some("BuiltInMicrophoneDevice".into()),
            is_virtual: false,
            was_default: true,
        };
        let report = |muted: bool, bundle_replaced: bool| {
            let WatchdogEmission::Error(msg) = watchdog_emission(
                FaultAction::Report,
                Some(&physical),
                muted,
                ZeroSource::Os,
                crate::mic_permission::MicAuth::Authorized,
                bundle_replaced,
            ) else {
                panic!("a Report must speak");
            };
            msg
        };

        // 1. THE SWAP. /Applications/Sparkle.app was replaced under us, so the grant is dead for
        //    code-identity reasons the Privacy pane cannot undo — the pane shows Sparkle already
        //    switched on, and toggling it re-grants the bundle on disk, not the binary talking.
        let replaced = report(false, true);
        assert!(
            replaced.contains("updated in the background"),
            "the swap must be NAMED as the cause; it is the whole point of the new bucket: {replaced}"
        );
        assert!(
            replaced.contains("Quit Sparkle"),
            "relaunching is the ONLY remedy that has ever fixed this (sparkle-1ueh3): {replaced}"
        );
        assert!(
            !replaced.contains("System Settings"),
            "a grant killed by a bundle swap cannot be repaired from a Privacy pane; sending the \
             user there is the dead end this change exists to remove: {replaced}"
        );
        assert!(
            replaced.contains("MacBook Pro Microphone"),
            "the device name is the fact only the backend has, and every sibling carries it: {replaced}"
        );
        // Lexically disjoint from its sibling ON PURPOSE, so the frontend bucket cannot be stolen
        // by an ordering change in dictationCopy's PATTERNS list.
        assert!(
            !replaced.contains("sending silence instead of audio"),
            "must not carry the stale-grant noun phrase the other bucket matches on: {replaced}"
        );

        // 2. THE SAME READING WITHOUT THE SWAP still gets the old sentence, System Settings and all.
        //    Its remedies are correctly ordered for a grant that went stale for some OTHER reason,
        //    and deleting them to make (1) pass would be a regression this asserts against.
        let not_replaced = report(false, false);
        assert!(
            not_replaced.contains("System Settings → Privacy & Security → Microphone"),
            "the stale-grant copy keeps its full remedy ladder when nothing was swapped: {not_replaced}"
        );
        assert!(
            !not_replaced.contains("updated in the background"),
            "with no swap on disk we must not claim one; that is a confident wrong cause: {not_replaced}"
        );

        // 3. PRECEDENCE. Muted outranks both grant stories — mid-update or not.
        let muted = report(true, true);
        assert!(
            muted.contains("is muted"),
            "unmuting is still the fix; the update story must not displace it: {muted}"
        );
        assert!(
            !muted.contains("updated in the background"),
            "a muted device must not be told to quit and reopen: {muted}"
        );
    }

    /// The same cross-language pin as its stale-grant twin below, for the NEW prefix. Cloned in the
    /// SAME commit that adds the constant, because the frontend routes this message by its opening
    /// clause too — and without this the new bucket could drift wordlessly into `unknown`, which
    /// renders the raw backend string and quietly loses the tailored remedy.
    #[test]
    fn the_bundle_replaced_message_matches_the_prefix_the_frontend_pins() {
        let pinned = std::fs::read_to_string("../src/voice/backendVoiceErrors.ts")
            .expect("read the frontend contract file");
        // SINGLE-quoted in the TS for the same reason as its siblings: the literal ends in a bare
        // `"` and this naive split has to survive it. The corollary is that the literal must
        // contain NO APOSTROPHE — one would truncate `want` to a prefix of the prefix and this
        // assertion would pass while the two sides had actually drifted.
        let want = pinned
            .split("BACKEND_BUNDLE_REPLACED_PREFIX =")
            .nth(1)
            .and_then(|s| s.split('\'').nth(1))
            .expect("BACKEND_BUNDLE_REPLACED_PREFIX literal (single-quoted)");
        let device = crate::audio::BoundDevice {
            name: "MacBook Pro Microphone".into(),
            uid: Some("BuiltInMicrophoneDevice".into()),
            is_virtual: false,
            was_default: true,
        };
        let msg = watchdog_report_message(
            Some(&device),
            false,
            ZeroSource::Os,
            crate::mic_permission::MicAuth::Authorized,
            true,
        );
        assert!(
            msg.starts_with(&want),
            "backend message and frontend pin have drifted:\n  backend: {msg}\n  pinned:  {want}"
        );
    }

    /// The cross-language pin the `BACKEND_NO_AUDIO_PREFIX` comment asked for and never got ("HALF A
    /// PIN, deliberately noted as such"). The frontend routes this message by its opening clause, so
    /// a reword here silently drops the user into the `permission` bucket — whose remedy points at a
    /// switch that is already on in exactly this state.
    #[test]
    fn the_stale_grant_message_matches_the_prefix_the_frontend_pins() {
        let pinned = std::fs::read_to_string("../src/voice/backendVoiceErrors.ts")
            .expect("read the frontend contract file");
        // The literal is SINGLE-quoted in the TS (like BACKEND_NO_AUDIO_PREFIX beside it) precisely
        // so it can contain a bare `"` and be read back with a naive split. A double-quoted literal
        // would need `\"` inside it, and this parse would stop at the backslash — which is exactly
        // what it did on the first run, so the failure mode is not hypothetical.
        let want = pinned
            .split("BACKEND_STALE_GRANT_PREFIX =")
            .nth(1)
            .and_then(|s| s.split('\'').nth(1))
            .expect("BACKEND_STALE_GRANT_PREFIX literal (single-quoted)");
        let device = crate::audio::BoundDevice {
            name: "MacBook Pro Microphone".into(),
            uid: Some("BuiltInMicrophoneDevice".into()),
            is_virtual: false,
            was_default: true,
        };
        let msg = watchdog_report_message(
            Some(&device),
            false,
            ZeroSource::Os,
            crate::mic_permission::MicAuth::Authorized,
            false,
        );
        assert!(
            msg.starts_with(&want),
            "backend message and frontend pin have drifted:\n  backend: {msg}\n  pinned:  {want}"
        );
    }

    /// THE FOLD, at the transition it exists for: a capture REPLACED mid-silence.
    ///
    /// Asserts the accumulated run, not the struct's shape — a fold that dropped the retiring
    /// capture's samples would leave the run at the new capture's count and never reach the
    /// threshold, which is the production bug in miniature.
    #[test]
    fn silence_evidence_survives_the_capture_being_rebuilt_under_it() {
        // A capture that saw 30k silent samples and then died — on its own, under the threshold.
        let first = fold_silence_evidence(None, "BuiltInMicrophoneDevice", 30_000, 0);
        assert!(!first.is_durably_silent(), "one short capture is not yet evidence");

        // Rebuild: the fresh Capture's counter restarts near zero. THIS is the transition — a naive
        // implementation reads it as "samples went down" and either resets or double-counts.
        let second = fold_silence_evidence(Some(first), "BuiltInMicrophoneDevice", 5_000, 0);
        assert_eq!(second.silent_run, 35_000, "the retiring capture's samples must be kept");
        assert!(!second.is_durably_silent());

        // Same capture, later tick: add only the DELTA, or one capture sampled every second would
        // count its own samples once per tick and cross the threshold on timing alone.
        let same = fold_silence_evidence(Some(second), "BuiltInMicrophoneDevice", 20_000, 0);
        assert_eq!(same.silent_run, 50_000, "a newer reading contributes its delta, not its total");
        assert!(
            same.is_durably_silent(),
            "30k + 20k of unbroken zeros from one device is a verdict, however it was split"
        );
    }

    #[test]
    fn silence_evidence_resets_on_a_different_device_and_on_any_voiced_sample() {
        let silent = fold_silence_evidence(None, "BuiltInMicrophoneDevice", 60_000, 0);
        assert!(silent.is_durably_silent());

        // A DIFFERENT device is a different question — it must not inherit the old one's verdict.
        let other = fold_silence_evidence(Some(silent.clone()), "USBMicrophone", 1_000, 0);
        assert_eq!(other.silent_run, 1_000, "a device change starts the evidence over");
        assert!(!other.is_durably_silent());

        // A voiced sample in THIS tick's delta ends the run: the device is reaching us now, so the
        // zeros behind it describe a state that is over.
        let voiced = fold_silence_evidence(Some(silent), "BuiltInMicrophoneDevice", 70_000, 1);
        assert!(
            !voiced.is_durably_silent(),
            "one non-zero sample means audio is reaching us; that is not a silent device"
        );
        assert_eq!(voiced.silent_run, 0, "the run restarts from the voiced sample, not from zero-ish");
    }

    /// A MIC THAT WORKED AND THEN DIED — the case a lifetime total could never report.
    ///
    /// The first version of this struct required the total non-zero count to be zero, so one voiced
    /// sample from earlier in the session disqualified every second of silence that followed it
    /// (knightwatch probe 2). That is the ordinary shape of a mic another app grabs mid-session, and
    /// it is precisely when the user is talking and being heard by nobody.
    #[test]
    fn a_device_that_voiced_earlier_can_still_be_judged_silent_later() {
        // Working: audio flowing, the run stays at zero however many samples arrive.
        let mut w = fold_silence_evidence(None, "BuiltInMicrophoneDevice", 100_000, 40_000);
        w = fold_silence_evidence(Some(w), "BuiltInMicrophoneDevice", 150_000, 60_000);
        assert!(!w.is_durably_silent(), "a voiced device is not silent");

        // Then it dies: every later delta is pure zeros, and only those deltas count.
        w = fold_silence_evidence(Some(w), "BuiltInMicrophoneDevice", 190_000, 60_000);
        assert_eq!(w.silent_run, 40_000, "only the silence SINCE the last voiced sample counts");
        assert!(!w.is_durably_silent(), "40k is still under the threshold");
        w = fold_silence_evidence(Some(w), "BuiltInMicrophoneDevice", 240_000, 60_000);
        assert!(
            w.is_durably_silent(),
            "a mic that stopped delivering mid-session must become reportable, not be excused by \
             audio it delivered ten minutes ago"
        );
    }

    /// The one imprecision, pinned in the direction it is allowed to be wrong: a rebuild whose fresh
    /// counter is ABOVE the retiring one's last reading cannot be distinguished from the same
    /// capture advancing, so its delta is understated (knightwatch probe 3). Understating delays a
    /// verdict; overstating would invent one, and only the second is a bug the user can see.
    #[test]
    fn an_indistinguishable_rebuild_undercounts_and_never_overcounts() {
        let first = fold_silence_evidence(None, "BuiltInMicrophoneDevice", 30_000, 0);
        // The replacement's own count (40k) exceeds the retiring capture's last (30k), so this reads
        // as the same capture advancing. TRUE evidence is 30k + 40k = 70k; we credit 40k.
        let after = fold_silence_evidence(Some(first), "BuiltInMicrophoneDevice", 40_000, 0);
        assert_eq!(after.silent_run, 40_000, "the delta, not the sum — an UNDER-count by design");
        assert!(
            after.silent_run <= 70_000,
            "the fold must never credit more silence than the device actually produced"
        );
    }

    /// A REBUILD IS NOT EVIDENCE OF AUDIO.
    ///
    /// `install_capture` retracts a standing notice so the missing-capture path can recover (roborev
    /// 55286). Under the churn this PR is about, that same retraction fires once per rebuild — so
    /// the user would watch the warning appear and vanish every couple of seconds while the mic
    /// stayed dead. Real recovery is unaffected: it comes from the watchdog's `Recovered` arm, which
    /// has seen a voiced sample.
    #[test]
    fn installing_a_capture_does_not_retract_a_notice_the_evidence_still_supports() {
        let silent = fold_silence_evidence(None, "BuiltInMicrophoneDevice", 60_000, 0);
        assert!(silent.is_durably_silent(), "fixture must actually be durably silent");
        assert!(
            !install_retracts(true, Some(&silent)),
            "a rebuild on a provably silent device must not claim the fault is over"
        );
        // The path the retraction exists for is untouched: no evidence of silence, so a rebuild is
        // still the only recovery signal the missing-capture case ever gets.
        assert!(install_retracts(true, None), "the missing-capture retraction must still fire");
        let voiced = fold_silence_evidence(None, "BuiltInMicrophoneDevice", 60_000, 10);
        assert!(install_retracts(true, Some(&voiced)));
        // And nothing is retracted when nothing was ever reported.
        assert!(!install_retracts(false, None));
    }

    /// Durable evidence spends no second recovery attempt: rebuilding is precisely what has already
    /// been happening, so another grace period of silence helps nobody.
    #[test]
    fn a_durably_silent_device_still_gets_its_one_free_re_acquire() {
        // THE SHORT-CIRCUIT WAS REMOVED, and this is the test that used to assert it (knightwatch
        // probe 3). A run is reachable by ONE capture sitting silent past the 4s grace — ~192k raw
        // zeros against a 48k threshold — so a device that voiced minutes ago and then went quiet
        // across an ordinary blur/refocus rebuild would have skipped recovery entirely and gone
        // straight to accusing the user, with nothing on the Report path to rebind it.
        assert_eq!(
            fault_action(AudioHealth::Silent, false, false, false, true),
            FaultAction::Reacquire,
            "durable silence is evidence of SILENCE, not of exhausted recovery"
        );
        // Unchanged: without the evidence, same answer. The two now agree by construction, which is
        // the point — this arm's behaviour no longer depends on the cross-capture flag at all.
        assert_eq!(
            fault_action(AudioHealth::Silent, false, false, false, false),
            FaultAction::Reacquire
        );
        // The genuine short-circuits are untouched: a muted device, and a spent re-acquire.
        assert_eq!(
            fault_action(AudioHealth::Silent, true, false, false, true),
            FaultAction::Report
        );
        assert_eq!(
            fault_action(AudioHealth::Silent, false, true, false, true),
            FaultAction::Report
        );
    }

    /// A WITHHELD RETRACTION MUST NOT ALSO REMOVE THE ROUTE BACK DOWN.
    ///
    /// `install_retracts` correctly refuses to claim recovery on a provably silent device, but the
    /// install then cleared `audio_reported` anyway — and `Recovered` is gated on exactly that
    /// latch. So if the REBUILD was what fixed the mic (the remedy the copy tells the user to try),
    /// the voiced tick found `reported == false` and returned `Idle`: no all-clear, ever, and the
    /// sticky frontend error stood over a working microphone.
    ///
    /// Composed through the production helpers rather than re-spelling the expression, so the two
    /// cannot drift; asserts the OUTPUT (`Recovered` fires) rather than the latch's value.
    #[test]
    fn a_withheld_retraction_keeps_the_latch_that_real_recovery_needs() {
        let silent = fold_silence_evidence(None, "BuiltInMicrophoneDevice", 60_000, 0);
        assert!(silent.is_durably_silent(), "fixture must actually be durably silent");

        let retract = install_retracts(true, Some(&silent));
        assert!(!retract, "a rebuild on a provably silent device claims nothing");
        let reported = reported_after_install(true, retract);
        assert!(reported, "the withheld retraction must PRESERVE the report latch");

        // The rebuild turns out to have fixed it: the next tick sees audio. That must retract.
        assert_eq!(
            fault_action(AudioHealth::Live, false, false, reported, false),
            FaultAction::Recovered,
            "recovery-by-rebuild must still be able to bring the notice down"
        );

        // And a retraction that DID fire consumes the latch, so it cannot fire twice.
        let voiced = fold_silence_evidence(None, "BuiltInMicrophoneDevice", 60_000, 10);
        let retract = install_retracts(true, Some(&voiced));
        assert!(retract);
        assert!(!reported_after_install(true, retract), "a fired retraction consumes the latch");
    }

    #[test]
    fn the_no_audio_message_names_the_device_and_matches_the_remedy_to_it() {
        // Naming the device is what makes the notice actionable — "no audio" sends someone hunting
        // through System Settings. And the remedy must FIT: telling a user on their built-in mic to
        // "pick your microphone" is useless advice, while telling a user stuck on a loopback that
        // another app took the mic misdiagnoses it. See AGENTS.md on remedy strings being code.
        let virt = crate::audio::BoundDevice {
            name: "ZoomAudioDevice".into(),
            uid: Some("zoom.us.zoomaudiodevice.001".into()),
            is_virtual: true,
            was_default: true,
        };
        let msg = no_audio_message(&virt, false);
        assert!(msg.contains("ZoomAudioDevice"), "must name the device: {msg}");
        assert!(
            msg.contains("not a microphone"),
            "a virtual device is a WRONG-DEVICE problem, and the copy must say so: {msg}"
        );

        let physical = crate::audio::BoundDevice {
            name: "MacBook Pro Microphone".into(),
            uid: Some("BuiltInMicrophoneDevice".into()),
            is_virtual: false,
            was_default: true,
        };
        let msg = no_audio_message(&physical, false);
        assert!(msg.contains("MacBook Pro Microphone"), "must name the device: {msg}");
        assert!(
            !msg.contains("not a microphone"),
            "a real mic must NOT be described as the wrong kind of device: {msg}"
        );
    }

    #[test]
    fn an_in_flight_build_is_never_mistaken_for_a_failed_one() {
        // roborev 55286. MISSING_CAPTURE_TICKS alone is a wall-clock guess, and Capture::start's
        // CoreAudio init blocks on the MAIN thread — which this file documents as being blocked for
        // seconds elsewhere. A build that is merely slow must not produce "Sparkle couldn't open a
        // microphone". The marker is what distinguishes them, so no number of ticks may escalate
        // while a build is genuinely running.
        let mut ticks = 0;
        for _ in 0..(MISSING_CAPTURE_TICKS as u16 * 4) {
            let (next, fault) = missing_tick(false, true, true, ticks);
            assert!(!fault, "a build in flight must never escalate while it is still plausible");
            ticks = next;
        }
        assert_eq!(ticks, 0, "ticks must not accumulate behind an in-flight build");
    }

    #[test]
    fn a_segment_that_straddles_the_cloud_switch_is_never_typed_twice() {
        // roborev 55300. Deepgram transcribes and TYPES as it goes, so any audio that reached the
        // relay must never also be decoded on-device — the user would see the tail of their own
        // sentence a second time. The segment, not the frame, is the unit that matters.

        // The straddle: opens on the cloud path, the relay drops mid-utterance (cloud_active goes
        // false), the segment closes on-device a few frames later.
        let (l, drop_now) = segment_cloud_latch(false, true, false); // opening frame, cloud live
        assert!(l && !drop_now, "still open — nothing to decide yet");
        let (l, drop_now) = segment_cloud_latch(l, false, false); // the relay just died
        assert!(l && !drop_now, "the latch must SURVIVE the flip; the audio still went to the relay");
        let (next, drop_now) = segment_cloud_latch(l, false, true); // segment closes on-device
        assert!(drop_now, "the relay already typed this — decoding it on-device types it twice");
        assert!(!next, "and the NEXT segment starts clean: it is genuinely ours to transcribe");

        // The ordinary on-device utterance is untouched — this must not eat normal dictation.
        let (l, drop_now) = segment_cloud_latch(false, false, false);
        assert!(!l && !drop_now);
        assert_eq!(segment_cloud_latch(l, false, true), (false, false), "decode it, as always");

        // And a segment wholly inside a cloud stream is the relay's too (it is discarded without
        // ever being copied, but the latch must agree, or the first on-device segment after the
        // stream ends would be judged by a stale `false`).
        let (l, _) = segment_cloud_latch(false, true, false);
        assert_eq!(segment_cloud_latch(l, true, true), (true, true));
    }

    #[test]
    fn a_segment_the_decoder_refused_leaves_the_pre_roll_holding_the_audio() {
        // roborev (Medium), the counterpart to the double-transcription guard. The ring may forget
        // audio an engine CLAIMED — but offering a segment to the decoder is not a claim, because
        // `try_send` is lossy by design (`DECODE_QUEUE_CAP` full → dropped; disconnected → silent).
        // Clearing on the OFFER lost the words from both engines at once, on exactly the slow
        // machine where the ring is what saves them.
        // THE ORDER IS WHAT IS UNDER TEST, so this drives the real `dispatch_closed_segments`
        // against a real `sync_channel` rather than re-implementing the sequence by hand. Moving
        // the clear back above the send loop reds the first two cases (roborev, Medium: an earlier
        // version of this test extracted only the predicate, and that revert stayed green).
        let frame = vec![0.5f32; 160];
        let seg = || vec![vec![0.25f32; 800]];

        // 1. THE QUEUE IS FULL — the segment is dropped, so nobody has this audio and the ring must
        //    still be holding it for the relay.
        let (tx, _rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(1);
        tx.try_send(vec![0.0; 8]).expect("prefill the one slot");
        let mut pre = crate::audio::PreRoll::new(crate::audio::PREROLL_SAMPLES);
        pre.note(&frame, false);
        assert_eq!(dispatch_closed_segments(&tx, seg(), &mut pre), 0, "a full queue accepts nothing");
        assert_eq!(
            pre.note(&frame, true).len(),
            2,
            "the refused segment's audio must survive in the ring — clearing on the OFFER leaves it \
             transcribed by NOTHING: dropped by the decoder and gone from the relay's pre-roll"
        );

        // 2. THE WORKER IS GONE (teardown) — same reasoning, silent path.
        let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(4);
        drop(rx);
        let mut pre = crate::audio::PreRoll::new(crate::audio::PREROLL_SAMPLES);
        pre.note(&frame, false);
        assert_eq!(dispatch_closed_segments(&tx, seg(), &mut pre), 0, "a dead channel accepts nothing");
        assert_eq!(pre.note(&frame, true).len(), 2, "a disconnected decoder is not a claim either");

        // 3. THE DECODER TOOK IT — it will be typed into the composer, so the ring MUST forget it or
        //    Deepgram transcribes the same words a second time.
        let (tx, _rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(4);
        let mut pre = crate::audio::PreRoll::new(crate::audio::PREROLL_SAMPLES);
        pre.note(&frame, false);
        assert_eq!(dispatch_closed_segments(&tx, seg(), &mut pre), 1, "the channel had room");
        assert_eq!(
            pre.note(&frame, true).len(),
            1,
            "only the current frame: re-sending the decoded span duplicates text the user can see"
        );

        // 4. A PARTIAL acceptance still claims the ring — several segments can close on one frame,
        //    and the ring is not per-segment, so any acceptance means some of it is spoken for.
        let (tx, _rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(1);
        let mut pre = crate::audio::PreRoll::new(crate::audio::PREROLL_SAMPLES);
        pre.note(&frame, false);
        let two = vec![vec![0.25f32; 800], vec![0.3f32; 800]];
        assert_eq!(dispatch_closed_segments(&tx, two, &mut pre), 1, "one fit, one did not");
        assert_eq!(pre.note(&frame, true).len(), 1, "partial acceptance still clears");
    }

    #[test]
    fn a_build_that_hangs_stops_being_believed_instead_of_silencing_the_watch_forever() {
        // roborev 55300. `build_started_at` is cleared by install_capture and by the build's error
        // arm — neither of which a HUNG build ever reaches. An unbounded "a build is running"
        // therefore turns the liveness watch OFF for the rest of the session on an armed session
        // with no capture: the nine-minute silence, re-entered through the fix for the false
        // positive. So the belief has to expire.
        use std::time::Duration;
        assert!(!build_suppresses_watch(None), "no build running → nothing to suppress");
        assert!(
            build_suppresses_watch(Some(Duration::ZERO)),
            "a build that just started is plausible"
        );
        assert!(
            build_suppresses_watch(Some(BUILD_STALL_GRACE - Duration::from_millis(1))),
            "still inside the grace → still believed"
        );
        assert!(
            !build_suppresses_watch(Some(BUILD_STALL_GRACE)),
            "AT the grace we stop believing it — a hung build must not silence the watch"
        );
        assert!(
            !build_suppresses_watch(Some(BUILD_STALL_GRACE * 60)),
            "and a marker left set for minutes certainly must not"
        );
        // And once disbelieved, the ordinary escalation runs: the user hears about it.
        let (_, fault) = missing_tick(false, true, false, MISSING_CAPTURE_TICKS - 1);
        assert!(fault, "a stale in-flight marker must fall through to the escalation");
    }

    #[test]
    fn an_armed_mic_with_no_capture_escalates_once_the_build_is_no_longer_running() {
        // The failure this path exists for: a re-acquire whose build ERRORED leaves no capture and
        // no build in flight. That must reach the user rather than returning Idle forever.
        let mut ticks = 0;
        for _ in 1..MISSING_CAPTURE_TICKS {
            let (next, fault) = missing_tick(false, true, false, ticks);
            assert!(!fault, "must debounce briefly before accusing anything");
            ticks = next;
        }
        let (ticks, fault) = missing_tick(false, true, false, ticks);
        assert_eq!(ticks, MISSING_CAPTURE_TICKS);
        assert!(fault, "an armed mic with no capture and no build running must reach the user");
    }

    #[test]
    fn the_missing_capture_counter_resets_whenever_there_is_nothing_wrong() {
        // Both non-fault cases, so a stale count can't carry into a later, unrelated window.
        assert_eq!(missing_tick(true, true, false, 7), (0, false), "capture present → reset");
        assert_eq!(missing_tick(false, false, false, 7), (0, false), "muted/unfocused → reset");
    }

    #[test]
    fn clearing_an_audio_fault_clears_every_latch_not_just_the_reported_one() {
        // roborev 55286 called the previous version of this test VACUOUS and was right: it asserted
        // `fault_action` outcomes that the commit never changed, so it passed against the old code.
        // This asserts the actual SIDE EFFECT — the session state the Recovered arm mutates.
        //
        // It matters because leaving `audio_reacquired` set makes the NEXT fault skip the silent
        // recovery attempt and go straight to complaining, inverting "recover before you complain"
        // exactly in the flapping-device case where a rebind is the fix.
        let mut sess = DictationSession {
            audio_reported: true,
            audio_reacquired: true,
            audio_missing_ticks: 9,
            // …and the failed-build retry budget, which lives here for the same "per-capture latch"
            // reason (roborev 60387). Both install paths reach this function, so pinning it here is
            // what stops the refund being a deletable line at each call site — without it the budget
            // silently becomes per-PROCESS and every later arm loses its re-issue.
            build_failure_reissued: true,
            ..Default::default()
        };
        sess.clear_audio_fault();
        assert!(!sess.audio_reported, "the user-visible notice must be retractable again");
        assert!(!sess.audio_reacquired, "the next fault must get its own recovery attempt");
        assert_eq!(sess.audio_missing_ticks, 0, "a stale count must not survive a recovery");
        assert!(
            !sess.build_failure_reissued,
            "a capture that installed refunds the one-shot failed-build retry — otherwise one \
             failure early in the process costs every later arm its re-issue"
        );
    }

    #[test]
    fn the_remedy_copy_names_an_action_that_actually_exists() {
        // AGENTS.md: a remedy message is an instruction the user will follow, so it must name a
        // control that EXISTS and that WORKS. Both halves have bitten this string. It once sent
        // users to "the mic menu" when that menu was a three-option mode pill with no device list
        // (roborev 55277), so it was swung to System Settings.
        //
        // The picker now lives in that menu — and System Settings became the WRONG answer for the
        // wrong-device case in the same stroke, because this branch stopped following the system
        // default: automatic selection prefers a physical input over it, and a pinned UID ignores
        // it. Telling someone to change the OS default can therefore leave capture on the exact
        // device the message just complained about. A remedy that does nothing is worse than none.
        let virt = crate::audio::BoundDevice {
            name: "ZoomAudioDevice".into(),
            uid: None,
            is_virtual: true,
            was_default: true,
        };
        let physical = crate::audio::BoundDevice {
            name: "MacBook Pro Microphone".into(),
            uid: None,
            is_virtual: false,
            was_default: true,
        };
        for msg in [no_audio_message(&virt, false), no_audio_message(&physical, false)] {
            assert!(
                msg.contains("mic menu"),
                "the wrong-device remedy must point at the picker that actually rebinds: {msg}"
            );
            assert!(
                !msg.contains("System Settings"),
                "changing the OS default no longer changes what Sparkle binds to: {msg}"
            );
        }
        // MUTE is the exception, and stays: no in-app picker can unmute hardware.
        let muted = no_audio_message(&physical, true);
        assert!(muted.contains("System Settings"), "unmuting is genuinely an OS control: {muted}");
    }

    #[test]
    fn the_no_device_bound_report_names_the_picker_too() {
        // roborev 55360: the audit stopped one arm short. When the re-acquire cannot rebuild a
        // capture at all there is no device to name, and THAT message still said "check System
        // Settings → Sound → Input" — advice that provably cannot rebind Sparkle, on the very path
        // where nothing could be opened. It is also the one string that matches no bucket in
        // dictationCopy (`no-audio` needs "no audio from", `no-device` needs a literal "no
        // microphone"), so it falls through to `unknown` and is shown to the user VERBATIM.
        //
        // THROUGH `watchdog_emission`, which IS the tick's user-visible output — not through
        // `NO_CAPTURE_MESSAGE`, which is what this test used to read (roborev 55413). Asserting the
        // constant proved nothing: it is a precondition, not an output, so reverting the emitting
        // arm to an inline "System Settings → Sound → Input" literal left the constant merely
        // unreferenced and this test still green while the regression shipped.
        let WatchdogEmission::Error(msg) = watchdog_emission(FaultAction::Report, None, false, ZeroSource::NotApplicable, crate::mic_permission::MicAuth::Authorized, false)
        else {
            panic!("a Report with no device bound must still TELL the user something");
        };
        assert!(
            msg.contains("mic menu"),
            "the no-device report must point at the picker that can actually rebind: {msg}"
        );
        assert!(
            !msg.contains("System Settings"),
            "changing the OS default cannot rebind Sparkle: {msg}"
        );

        // The other device state, through the same entry point: when a device IS bound the report
        // must NAME it. Picking the wrong branch is silent — both are plausible English.
        let bound = crate::audio::BoundDevice {
            name: "ZoomAudioDevice".into(),
            uid: None,
            is_virtual: true,
            was_default: true,
        };
        let WatchdogEmission::Error(named) =
            watchdog_emission(FaultAction::Report, Some(&bound), false, ZeroSource::NotApplicable, crate::mic_permission::MicAuth::Authorized, false)
        else {
            panic!("a Report with a device bound must tell the user something");
        };
        assert!(
            named.contains("ZoomAudioDevice"),
            "a bound device must be NAMED — that fact is the whole value of the report: {named}"
        );
    }

    #[test]
    fn only_a_REPORT_speaks_to_the_user_and_a_RECOVERY_retracts() {
        // The half the old constant-reading test could not see at all: WHICH actions produce output.
        // Both directions here are shipped regressions in miniature — a Report that goes silent is
        // the nine-minute dead-mic incident, and a Reacquire that speaks nags the user about a
        // hiccup that fixed itself, training them to ignore the one notice that matters.
        let quiet = [FaultAction::Idle, FaultAction::Reacquire];
        for action in quiet {
            assert_eq!(
                watchdog_emission(action, None, false, ZeroSource::NotApplicable, crate::mic_permission::MicAuth::Authorized, false),
                WatchdogEmission::Silent,
                "{action:?} is a silent internal step; the user must not be told about it"
            );
        }
        assert!(
            matches!(
                watchdog_emission(FaultAction::Report, None, false, ZeroSource::NotApplicable, crate::mic_permission::MicAuth::Authorized, false),
                WatchdogEmission::Error(_)
            ),
            "a Report is the ONLY thing that surfaces a fault — going quiet here is the incident"
        );
        assert_eq!(
            watchdog_emission(FaultAction::Recovered, None, false, ZeroSource::NotApplicable, crate::mic_permission::MicAuth::Authorized, false),
            WatchdogEmission::Recovered,
            "recovery must RETRACT the notice; sending an error here would leave it up forever"
        );
    }

    #[test]
    fn the_on_device_speech_level_is_the_vad_and_is_false_whenever_the_cloud_owns_the_audio() {
        // THE COUNTDOWN'S CANCEL. `dictation://speech-end` arms the auto-send clock on BOTH paths
        // now; on the cloud path `dictation://interim` cancels it, and this is the on-device
        // equivalent — without it, resumed speech could not stop a clock that a mid-thought pause
        // had started, and auto-send could fire mid-sentence.
        assert!(
            frame_on_device_speech(false, true),
            "on-device + VAD detecting speech → the user is talking; a countdown must not run",
        );
        assert!(
            !frame_on_device_speech(false, false),
            "on-device + VAD silent → not talking; a speech-end may arm the clock",
        );
        // THE HALF THAT MAKES IT SAFE TO SHIP. On the cloud path the cancel belongs to
        // `dictation://interim`, which is what actually tracks Deepgram's view of the utterance.
        // A local VAD flag routed into the same suspend-the-countdown role would fight it — and the
        // VAD is not even reliable there, since the audio is being consumed by the relay. So this
        // signal is INERT whenever the cloud owns the audio, whatever the VAD happens to say.
        assert!(
            !frame_on_device_speech(true, true),
            "cloud owns the audio → this signal is inert, even with the VAD flag set",
        );
        assert!(!frame_on_device_speech(true, false), "cloud owns the audio → inert");
        // …and it is NOT the same function as the waveform's, which is the whole point: while the
        // relay has the audio and the user IS speaking, the meter must move (`frame_speaking` true)
        // while the on-device cancel stays silent and lets `interim` do that job. That divergence is
        // the reason two functions exist; if they ever coincide everywhere, one of them is dead code.
        //
        // NOTE the operand: this used to compare at (cloud=true, vad=false) because `frame_speaking`
        // then returned `cloud_active || vad_detected` and was true for the whole stream. The
        // 2026-07-29 dead-mic fix made it honest (a still meter now means the engine hears nothing),
        // so the two agree there and the ONLY point they still diverge is with the VAD detecting.
        assert!(
            frame_speaking(true, true) != frame_on_device_speech(true, true),
            "with the relay streaming live speech the meter must move while the cancel stays inert",
        );
    }

    #[test]
    fn a_muted_microphone_is_named_as_muted_not_accused_of_being_broken() {
        // roborev 55275. A hardware mute switch (Jabra/Poly), kAudioDevicePropertyMute, and several
        // Bluetooth/USB drivers all deliver EXACT 0.0 — same signature as the dead virtual device.
        // Without this split the watchdog tells a user their microphone is dead every time they
        // mute it themselves, and points them at a remedy for a fault that does not exist.
        let device = crate::audio::BoundDevice {
            name: "Jabra Evolve2".into(),
            uid: Some("Jabra_UID".into()),
            is_virtual: false,
            was_default: true,
        };
        let msg = no_audio_message(&device, true);
        assert!(msg.contains("Jabra Evolve2"), "must name the device: {msg}");
        assert!(msg.contains("muted"), "must say it is MUTED: {msg}");
        assert!(
            !msg.contains("holding the microphone"),
            "a muted mic must not be blamed on another app stealing it: {msg}"
        );
    }

    #[test]
    fn a_muted_device_is_reported_immediately_instead_of_being_re_acquired() {
        // Rebuilding a stream cannot unmute hardware, so the recovery attempt is pure churn that
        // only delays the one message the user needs. Same inputs as the un-muted case below, so
        // the ONLY difference is the mute flag — which is what proves the flag does the work.
        assert_eq!(
            fault_action(AudioHealth::Silent, true, false, false, false),
            FaultAction::Report,
            "a muted device must skip the pointless re-acquire"
        );
        assert_eq!(
            fault_action(AudioHealth::Silent, false, false, false, false),
            FaultAction::Reacquire,
            "an un-muted device still gets its silent recovery attempt first"
        );
        // Still exactly once, muted or not.
        assert_eq!(fault_action(AudioHealth::Silent, true, false, true, false), FaultAction::Idle);
    }

    #[test]
    fn the_waveform_moves_only_on_real_speech_on_both_paths() {
        // On-device path: the waveform's speaking signal is exactly the VAD flag, so the meter
        // freezes the instant the VAD stops hearing speech.
        assert!(!frame_speaking(false, false), "on-device + VAD silent → not speaking");
        assert!(frame_speaking(false, true), "on-device + VAD speech → speaking");
        // Cloud path — THE FIX. This used to return `cloud_active || vad_detected`, so the meter
        // animated for the entire life of a cloud stream whether or not anyone was speaking. That
        // is not merely distracting, it is DISHONEST: on 2026-07-29 a user talked for nine minutes
        // at a microphone delivering digital silence, reassured by a waveform that was moving for
        // reasons unrelated to their voice. A still waveform is now a glance-level symptom.
        assert!(
            !frame_speaking(true, false),
            "cloud + VAD silent → STILL; a moving meter must mean the engine hears speech"
        );
        assert!(frame_speaking(true, true), "cloud + VAD speech → speaking");
        // The capture callback is what makes that assertion meaningful: it now feeds the VAD on the
        // cloud path too (discarding the segments, since Deepgram does the transcribing), so
        // `vad_detected` carries real information there instead of being a moot `false`.
    }

    #[test]
    fn capture_is_live_only_when_armed_and_focused() {
        // The mic captures only when the user hasn't muted (armed) AND a Sparkle window is the
        // active OS window (focused). Tabbing to another app drops `focused` and releases the mic.
        // `hold_recent: false` throughout — this pins the behaviour with the warm window CLOSED, so
        // the pre-existing matrix is unchanged by the third term (bead sparkle-0pto3).
        assert!(capture_should_be_live(true, true, false), "armed + focused → live");
        assert!(!capture_should_be_live(true, false, false), "armed but unfocused → released");
        assert!(!capture_should_be_live(false, true, false), "muted, even if focused → off");
        assert!(!capture_should_be_live(false, false, false), "muted + unfocused → off");
    }

    #[test]
    fn a_recently_released_hold_keeps_the_microphone_warm_while_sparkle_is_focused() {
        // ── WHY THE THIRD TERM EXISTS (bead sparkle-0pto3) ────────────────────────────────────────
        // Push to talk RESTS at `setOff()` (`MicButton`'s own comment), i.e. `armed = false`, so
        // every release tore the CoreAudio capture down and every keydown rebuilt it. `Capture::start`
        // measures 160-990 ms against the founder's measured holds of 76-567 ms on 2026-08-09 — the
        // mic was still opening when he let go, five times in a row, and nothing was sampled.
        //
        // Between two holds the state is exactly (armed=false, focused=true). That row USED to be
        // "off", which is the defect; with the warm window open it must stay live.
        assert!(
            capture_should_be_live(false, true, true),
            "between holds the mic must stay warm, or the next short hold pays CoreAudio's start \
             cost again and samples nothing"
        );
    }

    #[test]
    fn a_warm_microphone_is_still_released_the_moment_sparkle_loses_focus() {
        // THE PRIVACY INVARIANT, and the reason `focused` is the OUTER term rather than a third
        // alternative. Warming the capture must not weaken "Sparkle never captures while you are
        // looking at another app" — the guarantee `capture_should_be_live`'s doc has always made.
        //
        // PAIRED with the test above (AGENTS.md: a single test proving presence is ambiguous). One
        // shows the warm window turning a dead row live; this shows it CANNOT turn the unfocused
        // rows live, which is what stops the fix from becoming an always-on microphone.
        assert!(
            !capture_should_be_live(false, false, true),
            "unfocused + warm must still release the OS mic"
        );
        assert!(
            !capture_should_be_live(true, false, true),
            "even an ARMED warm mic is released when Sparkle is not the active app"
        );
    }

    // ── THE BOOLEAN THE PRODUCTION PATH ACTUALLY COMPUTES ────────────────────────────────────────
    // The three cases above pin the pure `capture_should_be_live` with HAND-PASSED booleans, so the
    // one place `hold_recent` is really derived — `DictationSession::capture_warm_now()` — was
    // untested by construction (roborev 62000). That is the guard-vacuity shape `sparkle-lgbwf`
    // records: mutating the reader to `warm_capture_until.is_some()`, or deleting the comparison
    // outright, left every one of those tests green because none of them ever calls it. `tests` is a
    // child module of `dictation`, so it can set the private field.
    //
    // THE TWO TESTS BELOW DO NOT CATCH `>=`, and this comment used to claim they did (roborev
    // 63699). An elapsed stamp (`now - 1s`) and a future one (`now + 30s`) read the same under
    // either operator; `until == now` is the ONLY input that separates them, and it was unreachable
    // while `capture_warm_now` sampled the clock inside itself. So the strict-`>` property — the one
    // its doc argues hardest for, because the failure direction to avoid is a microphone warm
    // forever — was the single behaviour left unpinned, under a comment saying it was covered.
    // `capture_warm_now_at(now)` is the seam that makes the boundary constructible; the third test
    // is the one that uses it, and it is the only one that does. The two here keep calling the real
    // `capture_warm_now()`, so the delegation is not a defaulted seam every test injects past.

    #[test]
    fn capture_warm_now_is_false_with_no_stamp_and_stays_false_once_the_window_elapses() {
        let mut sess = DictationSession::default();
        // The state the tree is permanently in today: nothing writes `warm_capture_until`, so this
        // is the case that decides live behaviour — and it must read as the OLD two-term rule.
        assert!(
            !sess.capture_warm_now(),
            "an unstamped session is not warm — this is the resting state and the shipped one"
        );
        sess.warm_capture_until = Some(Instant::now() - Duration::from_secs(1));
        assert!(
            !sess.capture_warm_now(),
            "an ELAPSED stamp must read cold, or the mic is warm forever after one hold"
        );
    }

    #[test]
    fn capture_warm_now_is_true_only_while_the_stamp_is_still_in_the_future() {
        // THE PAIRED CASE: the test above alone passes against a `capture_warm_now` hard-wired to
        // `false`, which would silently delete the feature the moment a writer lands.
        let mut sess = DictationSession::default();
        sess.warm_capture_until = Some(Instant::now() + Duration::from_secs(30));
        assert!(sess.capture_warm_now(), "an unexpired stamp is warm");
        // And it feeds the term it exists for: (armed=false, focused=true) — the state BETWEEN two
        // push-to-talk holds — goes live only because of this reader.
        assert!(
            capture_should_be_live(false, true, sess.capture_warm_now()),
            "the warm reader must be what turns the between-holds row live"
        );
    }

    #[test]
    fn capture_warm_now_reads_cold_at_the_exact_expiry_instant() {
        // THE OPERATOR ITSELF, which the two tests above cannot see (roborev 63699): an elapsed
        // stamp and a future stamp read identically under `>` and under `>=`, so only `until == now`
        // tells them apart. Injecting the clock is what makes that instant constructible at all.
        let mut sess = DictationSession::default();
        let t = Instant::now();
        sess.warm_capture_until = Some(t);
        assert!(
            !sess.capture_warm_now_at(t),
            "a stamp that has JUST expired must read cold — `until > now`, never `>=`; the failure \
             direction to avoid on a live microphone is one extra tick of warm, not one too few"
        );
        // PAIRED, one nanosecond the other side of the same boundary: without this the assertion
        // above also passes against a reader hard-wired to `false`, which would delete the warm
        // window entirely rather than tighten it.
        assert!(
            sess.capture_warm_now_at(t - Duration::from_nanos(1)),
            "one nanosecond BEFORE the stamp is still inside the window"
        );
    }

    #[test]
    fn plan_capture_builds_when_live_and_absent_and_tears_down_when_dead_and_present() {
        // The capture transition reconcile must make, factored out so it can be DECIDED under the
        // session lock and then ACTED ON outside it — the structural fix for the sparkle-sfxu launch
        // deadlock, where Capture::start ran while the lock was held. Build only when the mic should
        // be live and isn't yet; tear down only when it shouldn't be but still is; nothing otherwise.
        assert_eq!(plan_capture(true, false), CapturePlan::Build, "should be live, none yet → build");
        assert_eq!(plan_capture(false, true), CapturePlan::Teardown, "shouldn't be live, still is → tear down");
        assert_eq!(plan_capture(true, true), CapturePlan::Idle, "already live → nothing");
        assert_eq!(plan_capture(false, false), CapturePlan::Idle, "already off → nothing");
    }

    #[test]
    fn one_start_dictation_builds_exactly_one_capture() {
        // ── THE REGRESSION THIS PINS ────────────────────────────────────────────────────────────
        // `sess.capture` is only written by `install_capture`, which runs AFTER the off-lock
        // `build_capture` (~78 ms of CoreAudio init). Two reconciles inside that window both saw
        // `has_capture == false` and both planned Build, so one start produced two captures on the
        // same device — measured 0.17 ms apart on every steady-state cycle in
        // sparkle.log.2026-08-06, 202 `build_capture` against 180 `start_dictation` in a day.
        //
        // THE LOAD-BEARING ASSERTION is the third argument being `true`. Against main this case
        // returns Build (main has no third argument at all — it cannot express "not yet, but
        // coming"), and the second capture it authorises is the one thrown away by
        // `install_capture` and mislabelled a "stop/blur race" 153 times.
        assert_eq!(
            plan_capture_for(true, false, true),
            CapturePlan::Idle,
            "a build already in flight must not authorise a SECOND one — this is the double-build"
        );
        // …and the same inputs WITHOUT a build in flight must still build, or the fix would have
        // simply switched the microphone off. This is the pair that makes the assertion above mean
        // "deduplicated" rather than "disabled".
        assert_eq!(
            plan_capture_for(true, false, false),
            CapturePlan::Build,
            "no capture and nothing being built → still build, exactly as before"
        );

        // A TEARDOWN MUST STILL FIRE while a build is in flight. Folding the marker into the
        // `has_capture` term is what preserves this: a blur or stop landing mid-build has to be able
        // to release the mic, and `plan_capture(false, true)` is the only edge that does it. Had the
        // marker instead been used to suppress reconciling altogether, a stop during the build window
        // would leave a capture nobody ever tore down — a strictly worse bug than the one being fixed.
        assert_eq!(
            plan_capture_for(false, false, true),
            CapturePlan::Teardown,
            // WORDED PRECISELY (roborev 59586): the teardown DECISION is preserved here; the actual
            // release happens later, in install_capture's `still_current` discard. Claiming this
            // line releases the mic would describe something the code does not do.
            "a stop/blur during the build window must still plan a teardown"
        );
        assert_eq!(
            plan_capture_for(false, true, true),
            CapturePlan::Teardown,
            "an installed capture plus one in flight still tears down"
        );

        // The remaining matrix is unchanged from `plan_capture`, which the test above pins.
        assert_eq!(plan_capture_for(true, true, false), CapturePlan::Idle, "already live → nothing");
        assert_eq!(plan_capture_for(false, false, false), CapturePlan::Idle, "already off → nothing");
    }

    #[test]
    fn an_invalidated_build_re_issues_the_reconcile_it_was_suppressing() {
        // ── THE DEAD-MICROPHONE WINDOW THE DEDUP WOULD OTHERWISE OPEN (roborev 59586/60351) ──────
        // `plan_capture_for` counts an in-flight build as an existing capture, so a reconcile that
        // arrives while one is running is DROPPED, not queued. Nothing re-runs it if that build is
        // then invalidated — and there are two ways for that to happen (discarded on install after a
        // ptr_eq mismatch, or an outright build failure). Left unhandled the session sits
        // armed && focused with no capture and nothing pending, recovering only via the watchdog's
        // missing_tick escalation ~3 s later: a strictly worse bug than the redundant capture the
        // dedup removes.
        assert!(
            discard_needs_reissue(true, false),
            "still wants a capture and has none — re-issue, or the mic stays dead until the watchdog"
        );

        // The two that must NOT re-issue. Without this pair the assertion above is satisfied by a
        // call site that re-issues unconditionally — which would rebuild the mic straight after the
        // stop that asked for it to go away, and would spin against a competing build.
        assert!(
            !discard_needs_reissue(false, false),
            "a stop/blur legitimately wants no capture; re-issuing would fight the user"
        );
        assert!(
            !discard_needs_reissue(true, true),
            "a competing build already installed one — re-issuing would start the double-build again"
        );
        assert!(!discard_needs_reissue(false, true));
    }

    #[test]
    fn a_fresh_arm_starts_a_new_generation_and_a_refunded_retry_budget() {
        // The OTHER refund, and the reason it is a function (roborev 60387). Inline in
        // `start_dictation` — which needs an AppHandle and a 482 MB model, so it is not driveable
        // here — the line was invisible to the suite: delete it and the budget becomes per-PROCESS,
        // so one failed build early in the app's life costs EVERY later arm its re-issue and leaves
        // ~3 s of dead mic on every hold, with nothing in the log to say why.
        let mut sess = DictationSession {
            armed: false,
            build_failure_reissued: true,
            ..Default::default()
        };
        let old_cloud = sess.cloud.clone();
        let old_tx = sess.cloud_tx.clone();

        note_fresh_arm(&mut sess);

        assert!(sess.armed, "the arm is what this transition is");
        assert!(
            !sess.build_failure_reissued,
            "a NEW attempt must not inherit a budget the previous one spent"
        );
        // The generation really rotated: `start_cloud_stream`'s ptr_eq/epoch guards key off these
        // identities, so reusing an Arc would let a stream that raced the prior stop install itself
        // against this arm.
        assert!(!Arc::ptr_eq(&old_cloud, &sess.cloud), "a fresh arm gets a fresh cloud generation");
        assert!(!Arc::ptr_eq(&old_tx, &sess.cloud_tx), "the sender slot mirrors it, or a stale sender survives");
        assert_eq!(sess.cloud_epoch.load(Ordering::SeqCst), 0, "the epoch restarts with the generation");
        assert!(!sess.cloud_active.load(Ordering::Relaxed), "nothing is routing yet on a fresh arm");
    }

    #[test]
    fn a_failed_build_re_issues_once_and_then_leaves_it_to_the_watchdog() {
        // ── THE BOUND, ON A REAL SESSION (roborev 60384) ────────────────────────────────────────
        // The truth table above cannot see this: `discard_needs_reissue` is a two-term boolean that
        // is true for as long as the session wants a capture, and the FAILED-build call site clears
        // `build_started_at` BEFORE asking it. So the re-issued reconcile plans a fresh Build every
        // lap, and a device that fails for its own reasons (no input device, revoked TCC grant,
        // held elsewhere) recursed reconcile → build → Err → reconcile until the stack ran out,
        // emitting a `dictation://error` per lap. `note_build_failed` owns the whole decision so the
        // clear, the want-a-capture test and the one-shot budget are pinned together here.
        let state = DictationState::default();
        {
            let mut sess = state.0.lock().unwrap();
            sess.armed = true;
            sess.focused = true;
            sess.build_started_at = Some(std::time::Instant::now());
            assert!(
                note_build_failed(&mut sess),
                "a failure while the session still wants a capture re-issues — this is the stale-T1 \
                 case, where the retry usually succeeds because the failure belonged to the attempt \
                 the stop superseded"
            );
            assert!(
                sess.build_started_at.is_none(),
                "the in-flight marker must be cleared, or the watchdog keeps believing a build is \
                 running and never escalates"
            );

            // THE ASSERTION THAT GOES RED IF THE BOUND IS REMOVED. A second consecutive failure —
            // same session, nothing installed in between — is the persistently-failing device, and
            // it must fall through to the watchdog rather than recurse.
            sess.build_started_at = Some(std::time::Instant::now());
            assert!(
                !note_build_failed(&mut sess),
                "the one-shot budget is spent: a second consecutive failure must NOT re-issue"
            );
            assert!(sess.build_started_at.is_none(), "the marker is still cleared on the bounded lap");
        }

        // A capture that installs refunds the budget, so the NEXT stale-attempt failure still gets
        // its retry — driven through the REAL refunder rather than by writing the field, which is
        // what makes this an assertion about the wiring (roborev 60387). `install_capture` and
        // `reconcile_locked` both reach `clear_audio_fault` on their install path; neither is
        // driveable here (a real Capture / AppHandle / 482 MB model), so this is the closest seam to
        // the call sites that a test can hold.
        {
            let mut sess = state.0.lock().unwrap();
            sess.clear_audio_fault();
            sess.build_started_at = Some(std::time::Instant::now());
            assert!(note_build_failed(&mut sess), "a refunded budget re-issues again");
        }

        // A stop/blur wants no capture: no re-issue, AND the budget is not consumed by the refusal —
        // otherwise a blur landing on a failed build would silently eat the next arm's one retry.
        let stopped = DictationState::default();
        {
            let mut sess = stopped.0.lock().unwrap();
            sess.armed = false;
            sess.focused = true;
            sess.build_started_at = Some(std::time::Instant::now());
            assert!(!note_build_failed(&mut sess), "nothing wants a capture → nothing to re-issue");
            assert!(
                !sess.build_failure_reissued,
                "declining because the session wants no capture must not spend the retry budget"
            );
            assert!(sess.build_started_at.is_none(), "the marker is cleared on every failure path");
        }
    }

    #[test]
    fn take_reconcile_step_honours_the_in_flight_build_marker() {
        // ── PINS THE CALL SITE, NOT JUST THE PREDICATE (roborev 59586) ──────────────────────────
        // The previous tests exercised `plan_capture_for` in isolation, so reverting BOTH call sites
        // — i.e. deleting the whole fix — left them green. The justification for that ("the Build arm
        // cannot be driven in CI") holds only for the BUILD arm; it is not true of the new argument
        // in general. With `armed = false` and the marker set, `plan_capture_for` returns Teardown
        // where `plan_capture` returned Idle, and that difference is observable on a real
        // DictationState with no audio device and no 482 MB model.
        let state = DictationState::default();
        {
            let mut sess = state.0.lock().unwrap();
            sess.armed = false;
            sess.build_started_at = Some(std::time::Instant::now());
        }
        let g = state.1.load(std::sync::atomic::Ordering::SeqCst);
        assert!(
            matches!(state.take_reconcile_step(false, g), ReconcileStep::Teardown { .. }),
            "an in-flight build must be visible to the reconcile decision at the CALL SITE — this \
             is the assertion that goes red if plan_capture_for is reverted to plan_capture"
        );

        // The converse: no marker, same inputs → Idle. Without this pair the assertion above could
        // be satisfied by a call site that always tears down.
        let clean = DictationState::default();
        {
            let mut sess = clean.0.lock().unwrap();
            sess.armed = false;
            sess.build_started_at = None;
        }
        let g = clean.1.load(std::sync::atomic::Ordering::SeqCst);
        assert!(
            matches!(clean.take_reconcile_step(false, g), ReconcileStep::Idle),
            "nothing installed and nothing in flight → nothing to do"
        );

        // `reconcile_locked` (the focus-edge twin) is now a pure decider too — it no longer takes an
        // AppHandle and no longer builds/tears down inline — so its Idle/Teardown decisions ARE
        // driveable here; see `reconcile_locked_decides_the_step_without_building_inline`.
    }

    #[test]
    fn reconcile_locked_decides_the_step_without_building_inline() {
        // THE FOCUS-EDGE UI-FREEZE FIX. `set_focused` (a window-focus event, on the MAIN thread)
        // used to build the capture INLINE inside `reconcile_locked`, under the session lock —
        // `Capture::start` → `AudioOutputUnitStart`, which blocks on CoreAudio's HAL IO thread and
        // can stall for seconds if the HAL wedges. `reconcile_locked` now only DECIDES, returning a
        // `ReconcileStep` the caller acts on off-lock and (for a build) off the main thread.
        //
        // This pins that call site the way `take_reconcile_step_honours_the_in_flight_build_marker`
        // pins the worker path: an in-flight-build marker with nothing that wants a capture must be
        // seen as a Teardown decision — returned as data, not performed under the lock. It would go
        // red if `reconcile_locked` reverted to returning `CaptureLeftovers`/building inline.
        let state = DictationState::default();
        {
            let mut sess = state.0.lock().unwrap();
            sess.armed = false;
            sess.focused = false;
            sess.build_started_at = Some(std::time::Instant::now());
            assert!(
                matches!(
                    DictationState::reconcile_locked(&mut sess),
                    ReconcileStep::Teardown { capture: None, worker: None }
                ),
                "an in-flight build with nothing wanting a capture must be DECIDED as a Teardown, \
                 not built/torn down inline on the caller (main) thread"
            );
        }

        // The converse, so the assertion above can't be satisfied by a call site that always tears
        // down: nothing installed, nothing in flight, nothing wanted → Idle.
        let clean = DictationState::default();
        {
            let mut sess = clean.0.lock().unwrap();
            sess.armed = false;
            sess.focused = false;
            sess.build_started_at = None;
            assert!(
                matches!(DictationState::reconcile_locked(&mut sess), ReconcileStep::Idle),
                "nothing installed and nothing in flight → nothing to do"
            );
        }

        // Armed + focused enters the `CapturePlan::Build` arm; with no transcriber resident (no
        // 482 MB model in CI) it falls to the belt-and-suspenders `None => Idle`. It still exercises
        // the Build arm's decision path returning WITHOUT calling `Capture::start`, which is the
        // whole point — a real transcriber would yield `ReconcileStep::Build` for the caller to run
        // off-main, never an inline CoreAudio call.
        let armed = DictationState::default();
        {
            let mut sess = armed.0.lock().unwrap();
            sess.armed = true;
            sess.focused = true;
            assert!(
                matches!(DictationState::reconcile_locked(&mut sess), ReconcileStep::Idle),
                "the Build arm with no resident transcriber decides Idle without building"
            );
        }
    }

    #[test]
    fn a_hung_build_stops_suppressing_rebuilds_once_it_is_past_its_grace() {
        // The dedup above is only safe because the in-flight marker EXPIRES. `build_started_at` is
        // cleared on every path a build normally leaves by (install, discard, and the error arm in
        // `reconcile_capture`), so only a HUNG build can leave it standing — and a marker believed
        // forever would refuse to ever rebuild, which is exactly the nine-minute silent failure
        // roborev 55300 documents. This asserts the dedup rides that same bound rather than a second
        // one that could drift away from it.
        assert!(
            !build_suppresses_watch(Some(BUILD_STALL_GRACE)),
            "a build stuck past its grace must stop counting as in-flight, or the mic never rebuilds"
        );
        assert_eq!(
            plan_capture_for(true, false, build_suppresses_watch(Some(BUILD_STALL_GRACE))),
            CapturePlan::Build,
            "past the grace the reconcile must be free to build again"
        );
        assert!(
            build_suppresses_watch(Some(std::time::Duration::from_millis(78))),
            "a normal ~78ms build IS in flight — this is the window the double-build lived in"
        );
        assert!(
            !build_suppresses_watch(None),
            "no build recorded → nothing in flight"
        );
    }

    #[test]
    fn take_reconcile_step_releases_the_session_lock_before_the_caller_acts() {
        // The heart of the sparkle-sfxu fix. The v0.28.0 launch deadlock was start_dictation (on an
        // async-runtime worker) holding the session Mutex across is_focused() / Capture::start, both
        // of which block on the MAIN thread — which was itself blocked on this SAME Mutex in the
        // WindowEvent::Focused handler. reconcile_capture now decides the transition under the lock
        // (take_reconcile_step) and RELEASES it before the main-thread-dependent build/teardown.
        // Assert on the real DictationState that the lock is free the instant the step returns — the
        // exact property whose absence froze the app on launch (100% of stack samples on the mutex).
        //
        // COVERAGE NOTE: the terminal Build (Some transcriber) and Teardown branches extract owned
        // `Capture`/`ParakeetTdt`, which have no portable constructor — `Capture::start` needs a real
        // audio device and `ParakeetTdt::new` a 482MB model, absent in CI. That is exactly why the
        // capture DECISION lives in the pure `plan_capture` (matrix-tested above), and the lock
        // release is guaranteed by the guard's scope for EVERY branch. We still drive both reachable
        // arms — the default (Idle) and the armed path that enters the `CapturePlan::Build` match arm
        // — and assert the lock is free after each, so a future edit that holds the guard past the
        // decision fails here regardless of which branch it takes.
        let idle = DictationState::default();
        let g = idle.1.load(std::sync::atomic::Ordering::SeqCst);
        assert!(matches!(idle.take_reconcile_step(true, g), ReconcileStep::Idle), "unarmed → nothing to do");
        assert!(idle.0.try_lock().is_ok(), "Idle branch must release the session lock");

        // Armed + focused enters the `CapturePlan::Build` arm; with no transcriber resident it falls
        // to the belt-and-suspenders `None => Idle`, but it has exercised the Build arm's lock-scoped
        // extraction and must likewise return with the lock free.
        let armed = DictationState::default();
        armed.0.lock().unwrap().armed = true;
        let g = armed.1.load(std::sync::atomic::Ordering::SeqCst);
        let _ = armed.take_reconcile_step(true, g);
        assert!(
            armed.0.try_lock().is_ok(),
            "take_reconcile_step must not hold the session lock when it returns — the build/teardown \
             that follows blocks on the main thread and would deadlock against the focus handler"
        );
    }

    #[test]
    fn take_reconcile_step_does_not_clobber_a_focus_event_that_raced_the_off_lock_sample() {
        use std::sync::atomic::Ordering;
        // sparkle-sfxu review round 2. The worker samples focus OFF the lock (is_focused blocks on
        // the main thread), so a real Focused event can land — authoritatively writing sess.focused
        // via set_focused AND bumping the focus generation — after the sample but before
        // take_reconcile_step re-takes the lock. The worker's now-stale sample must NOT overwrite that
        // fresher value; if it did, the mic could go live while the window is actually unfocused,
        // defeating the sparkle-9oz6 gate (mic never captures while you're in another app).
        let state = DictationState::default();
        state.0.lock().unwrap().armed = true;
        // The worker read the generation here, then sampled focus = true (a window was focused then).
        let sampled_gen = state.1.load(Ordering::SeqCst);
        // ...but before the worker re-takes the lock, a blur lands: set_focused writes the
        // authoritative focused = false and note_focus_event bumps the generation.
        state.1.fetch_add(1, Ordering::SeqCst);
        state.0.lock().unwrap().focused = false;
        // The worker now finishes reconcile with its STALE sample (focus = true, gen = sampled_gen).
        let step = state.take_reconcile_step(true, sampled_gen);
        assert!(
            !state.0.lock().unwrap().focused,
            "a focus event that raced the off-lock sample must win — the stale sample must not clobber it"
        );
        assert!(
            matches!(step, ReconcileStep::Idle),
            "with focus authoritatively false, the reconcile must plan no capture build"
        );
    }

    #[test]
    fn take_reconcile_step_seeds_focus_from_the_sample_when_no_event_raced_it() {
        use std::sync::atomic::Ordering;
        // The other half of the guard: when NO focus event has spoken (generation unchanged), the
        // off-lock sample is still the right seed — the arm-time path where the window is already
        // focused and no Focused event will fire, so the mic must come up from the sample alone.
        let state = DictationState::default();
        state.0.lock().unwrap().armed = true;
        let gen = state.1.load(Ordering::SeqCst);
        let _ = state.take_reconcile_step(true, gen);
        assert!(state.0.lock().unwrap().focused, "unraced sample seeds focus so the mic can arm on mount");
    }

    #[test]
    fn no_blocking_audio_call_is_reachable_from_the_main_thread_focus_path() {
        // ── THE FOCUS-EDGE FREEZE, STATED AS A REACHABILITY RULE (sparkle-p3tu8r) ───────────────
        // `reconcile_locked_decides_the_step_without_building_inline` pins the DECISION. This pins
        // that no later edit puts the ACTION back on the run loop, which is the regression that
        // actually costs a user their app: the founder's spindump caught the main thread parked
        // inside `Capture::start` (`HALB_IOThread::_WaitForState` -> `__psynch_mutexwait`,
        // `AudioUnitSetProperty` -> `mach_msg2_trap`, `list_input_devices` ->
        // `AudioObjectGetPropertyData`) with 175 of 322 threads queued behind it in
        // `callOnMainRunLoopAndWait`. Every one of those is a Tauri IPC reply, and the concierge's
        // MCP bridge waits on the same run loop, so ONE focus gain froze the UI and blacked out the
        // concierge together — self-recovering only because nothing involved times out.
        //
        // WHY A SOURCE SCAN AND NOT A BEHAVIOURAL TEST. The property is REACHABILITY, and the thing
        // to be unreachable cannot be executed in CI at all: `Capture::start` needs a real audio
        // device and the Build arm needs a resident `ParakeetTdt` (482 MB of model). That is
        // precisely why the inline build survived on this path for so long — nothing could run it,
        // so nothing could catch it. Its sibling test says as much in its own closing note.
        //
        // ── THE LEAF NAMES ALONE ARE NOT ENOUGH ────────────────────────────────────────────────
        // The likeliest re-introduction is not a re-inlined `build_capture`; it is a plausible
        // one-liner. An inline `self.reconcile_capture(app)` or `self.build_and_install(..)` in
        // `set_focused` blocks the run loop for the SAME 160-990 ms (phase 1 posts to the main
        // thread, phase 3 is `Capture::start`) while containing none of the leaf names. So the
        // transitive entry points are banned by name too, each carrying its opening paren.
        const SRC: &str = include_str!("../dictation.rs");
        const BANNED: &[&str] = &[
            // The leaves the spindump named.
            "build_capture(",
            "Capture::start",
            "list_input_devices",
            // Everything that reaches them synchronously.
            "build_and_install(",
            "reconcile_capture(",
            "reacquire_capture(",
        ];

        /// The CODE of one `impl` method: from its signature to the first line that is exactly
        /// `    }`, which closes a 4-space-indented method and nothing nested inside it.
        ///
        /// Comments are stripped, because this file argues at length in prose about exactly these
        /// names — a scan that could not tell an explanation from a call site would either fire on
        /// the explanation or force the explanation to be written around it. A trailing comment is
        /// cut at `" // "` rather than `"//"` so a string literal like `"dictation://focus"`
        /// survives intact.
        fn code_of(src: &str, signature: &str) -> String {
            assert_eq!(
                src.matches(signature).count(),
                1,
                "`{signature}` must appear exactly once, or this test is reading the wrong function"
            );
            let from = &src[src.find(signature).unwrap()..];
            let mut out = String::new();
            for line in from.lines() {
                let code = match line.find(" // ") {
                    Some(i) => &line[..i],
                    None => line,
                };
                if !code.trim_start().starts_with("//") {
                    out.push_str(code);
                    out.push('\n');
                }
                if line == "    }" {
                    return out;
                }
            }
            panic!("no closing `    }}` found for `{signature}`");
        }

        /// Split a method into (INSIDE every spawned closure, OUTSIDE all of them).
        ///
        /// A spawned closure is allowed to block — that is the entire point of spawning it — so
        /// judging its body by the calling thread's rule would flag the fix as the bug. Everything
        /// else in the method is main-thread code.
        ///
        /// CONTAINMENT, NOT ORDER. Truncating at the first `std::thread::` was the obvious version
        /// and it is wrong in the direction that matters: it leaves everything AFTER the spawn
        /// unscanned, which is still the main thread. `spawn(..); self.build_and_install(..)` blocks
        /// the run loop for the same 160-990 ms, and an "is it after the spawn?" test is not merely
        /// blind to it — it is SATISFIED by it. So the closure body is brace-matched out and the
        /// pre-spawn prefix and post-closure suffix are scanned together.
        ///
        /// The code is comment-stripped before it gets here, so a depth counter over `{`/`}` is
        /// sound; a brace inside a string literal in one of these closures would break it, and would
        /// do so LOUDLY (a failing test to investigate), never by quietly exempting more.
        fn split_spawned_closures(code: &str) -> (String, String) {
            let (mut inside, mut outside) = (String::new(), String::new());
            let mut rest = code;
            while let Some(i) = rest.find("std::thread::spawn(") {
                let after = &rest[i..];
                // DO NOT SEARCH FOR THE BRACE — REQUIRE IT, at a fixed offset.
                //
                // Every searching version of this line has been wrong, and each was wrong about a
                // DIFFERENT shape. An unbounded `find('{')` latched onto the next unrelated block
                // when the closure was brace-less. Bounding the window to the first `;` fixed that
                // only for a spawn in STATEMENT position: as a match-arm tail or any other
                // expression position, a brace-less spawn is comma- or block-terminated, so the
                // first `;` is again inside a later block and the window spans it. Both failures
                // are the same failure — exempting a block that is not the closure — and both are
                // QUIET, which is the one direction this function must never fail in.
                //
                // So the shape is asserted rather than located. The brace is at a known offset in
                // `HEADER` or this is not a form the splitter understands, and it says so. There is
                // no window left to be wrong about, and no third shape to be surprised by.
                const HEADER: &str = "std::thread::spawn(move || {";
                assert!(
                    after.starts_with(HEADER),
                    "`std::thread::spawn` in a form this guard does not understand (expected \
                     `{HEADER}`). It refuses to judge rather than guess which block is the closure \
                     — guessing wrong exempts main-thread code from the ban list silently. Give the \
                     closure a braced `move ||` body, or teach this splitter the new form."
                );
                let open = HEADER.len() - 1;
                let bytes = after.as_bytes();
                let mut depth = 0usize;
                let mut close = None;
                for (k, b) in bytes.iter().enumerate().skip(open) {
                    match b {
                        b'{' => depth += 1,
                        b'}' => {
                            depth -= 1;
                            if depth == 0 {
                                close = Some(k);
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                let Some(close) = close else { break };
                // Up to the closure's opening brace is still the calling thread (the `spawn(` call
                // itself, and everything before it).
                outside.push_str(&rest[..i + open]);
                inside.push_str(&after[open..=close]);
                rest = &after[close + 1..];
            }
            outside.push_str(rest);
            (inside, outside)
        }

        // `WindowEvent::Focused` (lib.rs) -> `note_focus_event` -> `set_focused` ->
        // `reconcile_locked`, all on the AppKit main thread.
        for signature in [
            "fn reconcile_locked(sess:",
            "pub fn set_focused(",
            "pub fn note_focus_event(",
        ] {
            let code = code_of(SRC, signature);
            let (_inside, on_main) = split_spawned_closures(&code);
            for banned in BANNED {
                assert!(
                    !on_main.contains(banned),
                    "`{signature}` runs on the AppKit main thread and must not call `{banned}` — \
                     that is the 160-990 ms CoreAudio block that froze the UI and the concierge \
                     bridge together (sparkle-p3tu8r). Spawn it, as the Build arm already does."
                );
            }
        }

        // ...and the positive half. Without it every assertion above is satisfied by a
        // `set_focused` that simply never builds at all — which is a permanently dead microphone,
        // the opposite failure and just as user-visible.
        //
        // Asserted as CONTAINMENT (the build is inside the spawned closure), never as ordering. A
        // byte-offset "after the spawn" comparison cannot tell "handed to the worker" from "called
        // once the worker was started", and the second of those is the bug.
        let (inside, _outside) = split_spawned_closures(&code_of(SRC, "pub fn set_focused("));
        assert!(
            inside.contains("build_and_install("),
            "the focus-gain build must run INSIDE the spawned closure — it is absent from every \
             spawned body, so either the hand-off was deleted (a permanently dead mic on focus \
             gain) or it was moved back onto the main thread"
        );
    }

    #[test]
    fn blur_parks_a_live_cloud_session_and_leaves_everything_else_alone() {
        // The blur path used to drop the capture and say nothing to the cloud session, so the socket
        // idled — unpaused, no CloseStream, no warm timer — until the relay's upstream idle-close
        // severed it. A refocus moments later then paid a full TLS+WS handshake (run inline on the
        // IPC/event-loop thread) that the 8s warm standby already existed to avoid: 114 sub-8s
        // reconnects in a single observed session. Park iff there is something live to park.
        assert!(should_standby_on_blur(true, true), "live + active → park in warm standby");
        // Not active: the session is already parked (a deliberate stop got there first) or was never
        // routed to cloud. Re-pausing would restart the warm timer and hold the socket longer.
        assert!(!should_standby_on_blur(false, true), "already inactive → nothing to park");
        // Dead worker: the socket is gone; pause() would be a send into a closed channel.
        assert!(!should_standby_on_blur(true, false), "dead session → nothing to park");
        assert!(!should_standby_on_blur(false, false), "inactive and dead → nothing to park");
    }

    #[test]
    fn a_stop_that_follows_the_blur_park_leaves_the_socket_warm() {
        // The regression this closes. On blur, TWO things run in order: the Rust reconcile teardown
        // parks the socket (clearing cloud_active), and THEN the frontend's blur handler invokes
        // stop_cloud_stream. Judging solely by `was_active` meant that second step read a flag the
        // first step had just cleared, took the keep-warm branch away, and closed the socket ~100ms
        // after parking it — so warm standby never survived a blur and every refocus paid a fresh
        // handshake, which is what the standby was added to prevent.
        assert!(
            should_keep_warm_on_stop(false, true, true),
            "already parked by the blur path → keep the warm socket, don't close it"
        );
        // Unchanged: a deliberate stop of a live, actively-routing stream still parks.
        assert!(should_keep_warm_on_stop(true, true, false), "live + active → park");
        // Still closed — an installed session that never routed and was never parked has NO warm
        // timer running behind it, so keeping it would leave a socket idling until the relay's
        // upstream idle-close. That is the post-handshake race window, and it must still tear down.
        assert!(
            !should_keep_warm_on_stop(false, true, false),
            "alive but neither active nor parked → close it; nothing is holding a warm timer"
        );
        // Dead worker (warm expiry / socket death): nothing to keep, the caller finishes the corpse.
        assert!(!should_keep_warm_on_stop(false, false, true), "dead → close, even if it was parked");
        assert!(!should_keep_warm_on_stop(true, false, false), "dead → close");
    }

    #[test]
    fn refocus_resumes_only_a_session_that_is_still_warm() {
        // The other half: a refocus inside the warm window resumes on the SAME connection.
        assert!(should_resume_on_focus(false, true), "parked + still alive → resume, no handshake");
        // Expired while we were away. This is the load-bearing case: warm standby closed the socket
        // and the worker exited, so resuming would flip cloud_active back on with nothing behind it
        // and route the capture callback at a dead session instead of on-device. Leave it for the
        // frontend's cloud-ended cleanup, which then opens a fresh stream as it does today.
        assert!(!should_resume_on_focus(false, false), "expired session → do NOT revive");
        // Already active — a focus gain with no preceding park (e.g. window-to-window). Resuming a
        // non-paused worker is a no-op, but asserting it keeps park/unpark strictly symmetric.
        assert!(!should_resume_on_focus(true, true), "never parked → nothing to resume");
        assert!(!should_resume_on_focus(true, false), "active but dead → not ours to revive");
    }

    #[test]
    fn park_and_unpark_are_inverses_on_a_live_session() {
        // Park then unpark must return the routing flag to where it started, or a blur/refocus pair
        // would silently strand dictation on-device (or worse, mark cloud active with no socket).
        for alive in [true, false] {
            let active_after_park = !should_standby_on_blur(true, alive);
            assert_eq!(
                should_resume_on_focus(active_after_park, alive),
                alive,
                "a live session must round-trip active→parked→active; a dead one must stay parked"
            );
        }
    }

    #[test]
    fn park_and_unpark_are_noops_for_an_on_device_session() {
        // The empty-slot branch: pure on-device dictation has no cloud session, and a blur/refocus
        // must not touch the routing flag on its way past. Reachable without a mock because the slot
        // is just an Option — the live-session ordering is covered by the predicates above, since
        // faking a DeepgramSession would mean a trait abstraction this one call site doesn't earn.
        let cloud: Mutex<Option<DeepgramSession>> = Mutex::new(None);

        for initial in [false, true] {
            let flag = AtomicBool::new(initial);
            park_cloud_for_blur(&cloud, &flag);
            assert_eq!(flag.load(Ordering::Relaxed), initial, "blur must not touch an empty slot");
            unpark_cloud_for_focus(&cloud, &flag);
            assert_eq!(flag.load(Ordering::Relaxed), initial, "refocus must not touch an empty slot");
        }
    }

    #[test]
    fn park_and_unpark_recover_from_a_poisoned_cloud_lock() {
        // Poison tolerance is load-bearing here (): a panicked frame must never wedge
        // dictation, so these run on the focus path and must not propagate a poisoned lock.
        let cloud: Arc<Mutex<Option<DeepgramSession>>> = Arc::new(Mutex::new(None));
        let poisoner = Arc::clone(&cloud);
        let _ = std::thread::spawn(move || {
            let _g = poisoner.lock().unwrap();
            panic!("poison the cloud slot");
        })
        .join();
        assert!(cloud.is_poisoned(), "precondition: the slot is poisoned");

        let flag = AtomicBool::new(false);
        park_cloud_for_blur(&cloud, &flag);
        unpark_cloud_for_focus(&cloud, &flag);
    }

    #[test]
    fn deferred_blur_commits_only_when_current_and_still_unfocused() {
        // Real tab-away: this blur is still the latest event and a re-poll finds nothing focused.
        assert!(should_emit_blur(5, 5, false), "current + unfocused → release the mic");
        // Window-to-window switch: the new window's becomeKey bumped the generation past ours, so
        // our older deferred blur must bow out (don't tear down the now-focused window's dictation).
        assert!(!should_emit_blur(5, 6, false), "superseded by a newer focus event → skip");
        // A window is focused again by the time we re-poll → skip even if not superseded.
        assert!(!should_emit_blur(5, 5, true), "something regained focus → skip");
        assert!(!should_emit_blur(5, 7, true), "superseded AND refocused → skip");
    }

    #[test]
    fn a_focus_gain_supersedes_a_pending_deferred_blur() {
        use std::sync::atomic::{AtomicU64, Ordering};
        // Mirror note_focus_event's generation protocol without threads/timers, to lock in the
        // invariant that a window-to-window switch never releases the mic: a LOSS captures
        // my_gen = ++gen; a subsequent GAIN bumps gen again. The deferred blur then sees itself
        // superseded (my_gen != latest) and bows out — even though its own re-poll found nothing
        // focused. (Guards against a future refactor that drops the `+ 1` or forgets to bump on gain.)
        let gen = AtomicU64::new(0);
        let loss_gen = gen.fetch_add(1, Ordering::SeqCst) + 1; // window A resigns key
        gen.fetch_add(1, Ordering::SeqCst); // window B becomes key before the deferral elapses
        assert!(
            !should_emit_blur(loss_gen, gen.load(Ordering::SeqCst), false),
            "a gain after the loss must supersede the deferred blur"
        );

        // Control: an uncontested loss (real tab-away, no intervening gain) still commits.
        let solo = AtomicU64::new(0);
        let only_loss = solo.fetch_add(1, Ordering::SeqCst) + 1;
        assert!(
            should_emit_blur(only_loss, solo.load(Ordering::SeqCst), false),
            "an uncontested loss releases the mic"
        );
    }

    #[test]
    fn stop_capture_is_a_safe_idempotent_noop_without_an_active_capture() {
        // The app-exit path () calls stop_capture unconditionally, including when no
        // dictation was ever started. It must not panic and must leave the session clean, even
        // when called repeatedly.
        let state = DictationState::default();
        state.stop_capture();
        state.stop_capture();
        assert!(state.0.lock().unwrap().capture.is_none());
    }

    /// Every combination is asserted below, so name them once here rather than inline.
    const LIVE_OURS: Installed = Installed { alive: true, project_matches: true };
    const LIVE_OTHER: Installed = Installed { alive: true, project_matches: false };
    const DEAD_OURS: Installed = Installed { alive: false, project_matches: true };
    const DEAD_OTHER: Installed = Installed { alive: false, project_matches: false };

    #[test]
    fn cloud_reuse_reopens_for_another_project_even_when_already_routing() {
        // The billing rule. `active` true + wrong project is the focus-regain case: unpark resumes a
        // parked socket without knowing which project we're now dictating into, so if this returned
        // AlreadyRouting the new project's minutes would keep billing the old one (roborev 50498).
        assert_eq!(cloud_reuse(true, Some(LIVE_OTHER)), CloudReuse::Reopen);
        assert_eq!(cloud_reuse(false, Some(LIVE_OTHER)), CloudReuse::Reopen);
    }

    #[test]
    fn cloud_reuse_is_idempotent_for_the_same_project_and_resumes_a_warm_one() {
        assert_eq!(cloud_reuse(true, Some(LIVE_OURS)), CloudReuse::AlreadyRouting);
        assert_eq!(cloud_reuse(false, Some(LIVE_OURS)), CloudReuse::Resume);
    }

    #[test]
    fn cloud_reuse_opens_fresh_when_nothing_usable_is_installed() {
        // All four `installed` shapes are pinned at both `active` values: liveness gates reuse, so a
        // future arm reordering (say Some(alive:_, project_matches:false) => Reopen) can't silently
        // change the dead cases. (roborev 52647)
        assert_eq!(cloud_reuse(false, None), CloudReuse::Open);
        assert_eq!(cloud_reuse(false, Some(DEAD_OURS)), CloudReuse::Open, "dead → reopen fresh");
        assert_eq!(cloud_reuse(false, Some(DEAD_OTHER)), CloudReuse::Open);
        // A dead socket under an `active` flag is the mid-stream-death window the capture callback
        // already documents: let cloud-ended → stop_cloud_stream recover it rather than opening a
        // second stream underneath.
        assert_eq!(cloud_reuse(true, None), CloudReuse::AlreadyRouting);
        assert_eq!(cloud_reuse(true, Some(DEAD_OURS)), CloudReuse::AlreadyRouting);
        assert_eq!(cloud_reuse(true, Some(DEAD_OTHER)), CloudReuse::AlreadyRouting);
    }

    /// `raced_stream_disposition` takes five bools; at the call sites below that would read as
    /// `(false, true, true, true, false)` and be unreviewable. This names them once.
    #[derive(Clone, Copy)]
    struct Race {
        install: bool,
        same_generation: bool,
        armed: bool,
        slot_empty: bool,
        already_active: bool,
    }
    /// The salvageable race: a stop/blur landed mid-handshake on a live, armed, un-claimed session.
    const SALVAGEABLE: Race = Race {
        install: false,
        same_generation: true,
        armed: true,
        slot_empty: true,
        already_active: false,
    };
    fn disposition(r: Race) -> RacedStream {
        raced_stream_disposition(r.install, r.same_generation, r.armed, r.slot_empty, r.already_active)
    }

    #[test]
    fn a_stream_raced_by_a_stop_is_parked_for_reuse_not_thrown_away() {
        // "discarding cloud stream opened during a stop/again race" appears repeatedly in the
        // 2026-07-29 log, and every occurrence cost a full TLS+WS handshake AND an up-front
        // firstMinuteCents debit for a connection that carried no audio. The common triggers — a
        // window blur pausing capture, a stop landing mid-handshake — do not invalidate the
        // SESSION, only the routing, so the socket is still worth keeping.
        assert_eq!(
            disposition(SALVAGEABLE),
            RacedStream::ParkWarm,
            "same generation, still armed, empty slot: park it so the next utterance reuses it"
        );
        // cloud_reuse's Resume path is what then picks it up, with no second handshake.
        assert_eq!(cloud_reuse(false, Some(LIVE_OURS)), CloudReuse::Resume);
    }

    #[test]
    fn a_stream_raced_by_a_MUTE_is_discarded_not_parked_against_a_dead_mic() {
        // The guard that `same_generation` alone does NOT give you. `stop_dictation` (the mute)
        // disarms and empties the slot but does NOT rotate the cloud Arcs — only a fresh
        // `start_dictation` arm does — so a handshake landing just after a mute still reads as the
        // same generation. Parking there holds a live relay socket against a microphone the user
        // just turned off.
        //
        // And it is worse than waste: un-muting inside the 8s warm window installs fresh Arcs, which
        // DROPS the parked session, and `Drop for DeepgramSession` only signals Close — it does not
        // `silence_now()`. The worker then forwards its trailing transcripts and emits `cloud-ended`
        // into the generation that just armed: a stray final in the new composer, and a stray
        // cloud-ended that stops the successor's stream (roborev 50498/52646/53024).
        assert_eq!(
            disposition(Race { armed: false, ..SALVAGEABLE }),
            RacedStream::Discard,
            "muted: silence and close it — never park a socket against a mic the user turned off"
        );
    }

    #[test]
    fn a_stream_orphaned_by_its_own_arm_is_banked_for_the_next_hold() {
        // ── THE PUSH-TO-TALK DEFECT, PINNED (74.3% of all sockets: 735 of 989, Aug 1-9) ──────────
        // This asserted `Discard`, and that is what made short holds permanently preview-less.
        //
        // ONE gesture fires BOTH `start_cloud_stream` and `start_dictation`
        // (`setEnabled(true); setPhase("active")`), and they race: the handshake begins ~40ms before
        // `start_dictation` reaches `note_fresh_arm`, so it captures generation G and lands into
        // G+1 — rotated by ITS OWN ARM, with the user still holding the key. The old rule read that
        // as an unsalvageable orphan and silenced+closed it. Every hold therefore paid a fresh
        // ~490ms handshake and a fresh 6¢ first-minute debit for a socket that was destroyed on
        // arrival, and warm standby — the machinery built to prevent exactly this — was never once
        // reached on the push-to-talk path.
        //
        // Safe to bank precisely because such a socket has NEVER ROUTED AUDIO (see the Discard arm
        // in start_cloud_stream: "This orphan never routed audio, so muting loses nothing"), so
        // there are no trailing transcripts to leak into a successor.
        assert_eq!(
            disposition(Race { same_generation: false, ..SALVAGEABLE }),
            RacedStream::ParkCurrent,
            "rotated by its own arm, mic still armed, slot empty: bank it for the next hold"
        );
        // And it must be banked into the CURRENT Arcs, which is why this is a distinct variant
        // rather than a widened ParkWarm — the captured cloud_tx belongs to a generation that is
        // gone, and parking into it would leave the slot and the sender out of sync.
        assert_ne!(
            disposition(Race { same_generation: false, ..SALVAGEABLE }),
            RacedStream::ParkWarm,
            "a rotated socket must not be parked into the stale captured sender"
        );
        // Nor may we park on top of a socket someone else already owns, or while audio is routing.
        assert_eq!(
            disposition(Race { slot_empty: false, ..SALVAGEABLE }),
            RacedStream::Discard,
            "an occupied slot must never be clobbered"
        );
        assert_eq!(
            disposition(Race { already_active: true, ..SALVAGEABLE }),
            RacedStream::Discard,
            "never shadow a session that is actively routing"
        );
    }

    #[test]
    fn banking_across_a_rotation_keeps_every_guard_that_is_not_vacuous() {
        // Relaxing `same_generation` must not relax anything else. Each of these is a case where
        // banking would be actively wrong, and all three survive the rotation unchanged — so the
        // change is "a rotated socket is no longer AUTOMATICALLY doomed", not "parking is now
        // unguarded". Without this, the widened rule would be pinned only by the case it enables.
        assert_eq!(
            disposition(Race { same_generation: false, armed: false, ..SALVAGEABLE }),
            RacedStream::Discard,
            "muted: never bank a live socket against a mic the user turned off"
        );
        assert_eq!(
            disposition(Race { same_generation: false, slot_empty: false, ..SALVAGEABLE }),
            RacedStream::Discard,
            "the current generation already has a socket — clobbering it is the successor hazard"
        );
        assert_eq!(
            disposition(Race { same_generation: false, already_active: true, ..SALVAGEABLE }),
            RacedStream::Discard,
            "audio is already routing somewhere — never shadow it"
        );
        // The same three guards decide both park flavours, so neither can drift into being laxer
        // than the other.
        for armed in [true, false] {
            for slot_empty in [true, false] {
                for already_active in [true, false] {
                    let r = Race { install: false, same_generation: true, armed, slot_empty, already_active };
                    let rotated = Race { same_generation: false, ..r };
                    let parked_same = disposition(r) == RacedStream::ParkWarm;
                    let parked_rotated = disposition(rotated) == RacedStream::ParkCurrent;
                    assert_eq!(
                        parked_same, parked_rotated,
                        "the park decision must not depend on the generation, only WHERE it parks \
                         (armed={armed} slot_empty={slot_empty} already_active={already_active})"
                    );
                }
            }
        }
    }

    #[test]
    fn the_park_guard_reads_the_flag_of_the_generation_it_parks_into() {
        // The guard `raced_stream_disposition` calls `already_active` means "never shadow a session
        // that is actively routing" — so it has to describe the generation the socket lands in.
        // ParkWarm lands in the captured one, ParkCurrent in the CURRENT one, and reading the
        // captured flag on both paths left the guard inert in exactly the rotated case the new
        // variant enables. The pure table test above cannot see this: it never exercises where the
        // arguments come from (roborev 61450, Medium).
        //
        // Driven against a REAL session plus a distinct captured Arc, set to OPPOSITE values, so the
        // assertion is about which AtomicBool is actually read — not about two bools someone handed
        // in. The first version took `(same_generation, captured: bool, current: bool)`, and
        // reverting the call site (or swapping those two adjacent args) compiled and stayed green:
        // the helper was proven while the line that chose its inputs remained untested (roborev
        // 61465, Medium).
        let sess = DictationSession::default();
        let captured = Arc::new(AtomicBool::new(false));

        // Retired generation idle, CURRENT generation routing.
        captured.store(false, Ordering::Relaxed);
        sess.cloud_active.store(true, Ordering::Relaxed);
        assert!(
            park_target_active(false, &captured, &sess),
            "rotated: a CURRENT generation that is routing must block the park, even though the \
             retired generation's flag says otherwise"
        );
        assert!(
            !park_target_active(true, &captured, &sess),
            "same generation: the captured flag decides — reading `sess` here would be the bug \
             pointing the other way"
        );

        // And the mirror, so neither branch can be a constant.
        captured.store(true, Ordering::Relaxed);
        sess.cloud_active.store(false, Ordering::Relaxed);
        assert!(
            !park_target_active(false, &captured, &sess),
            "a retired generation that was routing must not block a park into an idle current one"
        );
        assert!(park_target_active(true, &captured, &sess), "same generation → the captured flag");
    }

    // ── WHERE THE "WHAT DOES THE PRELOAD SAVE?" MEASUREMENT LIVES ────────────────────────────────
    // A second on-machine timing test (`measure_real_model_load`) stood here and was DELETED rather
    // than kept (roborev 61716). `measure_model_load_split`, at the bottom of this file, already
    // resolves the same app-data path and already calls `load_model` three times, printing round 1
    // (cold: ONNX transducer init + VAD + verification) against rounds 2-3 (warm: served from
    // `DECODER_CACHE`) — the cold/warm delta this one re-measured was already on screen, and it now
    // prints that delta explicitly. Two copies were actively worse than one: `load_model` takes the
    // process-global `MODEL_LOAD` mutex and shares `DECODER_CACHE`, so the obvious invocation
    // `cargo test --lib -- --ignored --nocapture` ran both concurrently — whichever went second
    // timed a "cold" load that was already cache-warm, or timed its own wait on the other test's
    // mutex, and only the deleted one asserted on the ordering, so the contention could panic.

    #[test]
    fn the_capture_missed_payload_is_the_shape_typescript_parses() {
        // ── THE RUST HALF OF A HAND-WRITTEN SEAM (roborev 61729) ─────────────────────────────────
        // `dictation://capture-missed` crosses into TypeScript as JSON and the frontend picks which
        // REMEDY to show off `stage` — so a renamed key or a mistyped value does not merely spoil a
        // log line, it silently falls back to the capture branch and tells a user to "hold the key a
        // moment longer" against a 46-second model load. No type error, no runtime error, nothing
        // red. That is the Rust→TS trap AGENTS.md describes, where both halves stay green.
        //
        // ONE FIXTURE, READ BY BOTH SUITES — not two hand-written literals (roborev 61764). The
        // previous version asserted against its own copy on each side and CLAIMED they would fail
        // together; they would not. The realistic drift is a deliberate rename: change "stage" to
        // "phase" here, this test reddens right next to the edit, you update it, and the vitest —
        // different language, package and suite — stays green against the old token forever, while
        // `missedStageOf` returns "capture" for every model-load failure. Reading the same file is
        // what actually couples them.
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../src/fixtures/captureMissed.json"))
                .expect("the shared capture-missed fixture must parse");
        assert_eq!(
            capture_missed_payload(MissedStage::Model, 46_258),
            fixture["model"],
            "the model stage's wire shape — src/fixtures/captureMissed.json"
        );
        assert_eq!(
            capture_missed_payload(MissedStage::Capture, 2_083),
            fixture["capture"],
            "the capture stage's wire shape — src/fixtures/captureMissed.json"
        );
        assert_ne!(MissedStage::Capture.as_str(), MissedStage::Model.as_str());
        assert_eq!(MissedStage::Capture.as_str(), "capture");
        assert_eq!(MissedStage::Model.as_str(), "model");
    }

    #[test]
    fn only_a_hold_that_recorded_nothing_is_reported_to_the_user() {
        // The founder's "it doesn't seem to be recognizing the mic". `install_capture` decided this
        // with ONE `still_current` bool and logged all three rejections as "discarding a capture
        // built during a stop/blur race" — a line this file already records as having "sent two
        // investigations hunting a focus race". Only one of the three costs the user their words,
        // and only that one may raise a banner.
        assert_eq!(
            classify_capture_fate(true, true, true),
            CaptureFate::Install,
            "wanted, slot free, same generation: install it"
        );
        // THE USER-VISIBLE FAILURE: the hold ended before the mic finished starting, and no sibling
        // capture caught the words. Measured 12+ times on 2026-08-09 with capture_ms up to 2083ms
        // against ~345ms holds.
        assert_eq!(
            classify_capture_fate(false, true, true),
            CaptureFate::MissedTheHold,
            "nobody wants it and nothing else is live: this hold recorded NOTHING"
        );
        // NOT user-visible: a sibling is already installed and routing, so the audio was captured.
        // Reporting this one would fire a "nothing was recorded" banner over a working dictation.
        assert_eq!(
            classify_capture_fate(false, false, true),
            CaptureFate::LostToASibling,
            "a sibling holds the slot — the words were captured by it, nothing is owed"
        );
        assert_eq!(
            classify_capture_fate(true, false, true),
            CaptureFate::LostToASibling,
            "still a sibling even when the session wants a capture"
        );
        // NOT user-visible either: these words belong to a session the user already left.
        assert_eq!(
            classify_capture_fate(false, true, false),
            CaptureFate::Stale,
            "a rotated generation outranks everything — not this session's loss to report"
        );
        assert_eq!(
            classify_capture_fate(true, true, false),
            CaptureFate::Stale,
            "wanting a capture does not make a stale one this session's"
        );
    }

    #[test]
    fn exactly_one_capture_fate_is_ever_reported_to_the_user() {
        // The property, rather than the six sampled rows above: across the WHOLE input space there
        // must be exactly one combination that tells the user they lost their words. A widened rule
        // that started reporting a sibling loss or a rotated generation would fire a "nothing was
        // recorded" banner over dictation that worked — which is the same false-claim defect, just
        // pointing the other way.
        let mut reported = Vec::new();
        for wants in [true, false] {
            for slot_empty in [true, false] {
                for same_gen in [true, false] {
                    if classify_capture_fate(wants, slot_empty, same_gen)
                        == CaptureFate::MissedTheHold
                    {
                        reported.push((wants, slot_empty, same_gen));
                    }
                }
            }
        }
        assert_eq!(
            reported,
            vec![(false, true, true)],
            "exactly one input may report a lost hold: not wanted, slot empty, same generation"
        );
    }

    #[test]
    fn a_socket_banked_by_its_own_arm_reports_late_not_orphan() {
        // `Orphan` means "NO EVIDENCE EITHER WAY" — a handshake for a session the user already left,
        // which may be landing while a SUCCESSOR is live and painting interims, so reporting it
        // would describe a timing fault over a working stream (roborev 59692/60365).
        //
        // ParkCurrent is a different fact and must not inherit that silence: it is reached only with
        // the mic ARMED and the current slot EMPTY, so there is provably no successor stream to lie
        // about, and the socket has just been banked for the session the user is in right now.
        // Reporting `Late` is both honest and, unlike the orphan case, actionable — the next hold
        // reuses this socket with no handshake.
        assert_eq!(
            late_report_for(RacedStream::ParkCurrent, false),
            LateReport::Late,
            "banked for the live session: say we connected late, don't stay silent"
        );
        // The genuine orphan — nothing wanted the socket — keeps its silence.
        assert_eq!(late_report_for(RacedStream::Discard, false), LateReport::Orphan);
        assert_eq!(late_report_for(RacedStream::ParkWarm, true), LateReport::Late);
        assert_eq!(late_report_for(RacedStream::InstallLive, true), LateReport::Silent);
    }

    #[test]
    fn a_push_to_talk_release_parks_the_relay_socket_instead_of_burning_it() {
        // WHERE EVERY HOLD USED TO DIE. Push to talk RESTS at `setOff()` (`setEnabled(false)`), not
        // at a phase drop, so a release never reaches `stop_cloud_stream`'s keep-warm branch — it
        // lands in `stop_dictation`, which took the socket and `finish()`ed it unconditionally.
        // That is why warm standby only ever worked for the Speak tray, and why every hold paid a
        // fresh ~490ms handshake and a fresh 6¢ first-minute debit.
        let sess = DictationSession::default();
        let (session, rx) = crate::cloud::parkable_session();
        *sess.cloud.lock().unwrap() = Some(session);
        *sess.cloud_tx.lock().unwrap() =
            Some(sess.cloud.lock().unwrap().as_ref().unwrap().audio_sender());

        // A release of a LIVE cloud stream (cloud_active was true).
        let taken = park_or_take_on_stop(&sess, true);

        assert!(taken.is_none(), "a released hold must not hand the socket back for teardown");
        assert!(
            sess.cloud.lock().unwrap().is_some(),
            "the socket must stay in the slot — this is what the next arm carries forward"
        );
        assert!(
            sess.cloud.lock().unwrap().as_ref().unwrap().is_parked(),
            "and it must actually be PARKED, not merely left sitting there unpaused: an unparked \
             socket runs no warm timer and is not carryable by note_fresh_arm"
        );
        assert!(
            sess.cloud_tx.lock().unwrap().is_some(),
            "the sender stays installed alongside it, exactly as warm standby leaves the pair"
        );
        // The WORKER-VISIBLE effect, not just the flag: `pause()` is what Finalizes the released
        // utterance (so its trailing text still commits) and starts the warm timer. Asserting only
        // `is_parked()` would pass against a version that set the flag and sent nothing.
        assert!(
            rx.took_pause(),
            "the release must send Pause to the worker, or nothing finalizes and nothing warms"
        );
    }

    #[test]
    fn a_stop_with_nothing_worth_keeping_still_tears_the_socket_down() {
        // The other side, so the park cannot quietly become unconditional. A socket that never
        // routed and was never parked has NO warm timer behind it — leaving it in the slot would
        // strand a connection that nothing will ever close on schedule.
        let sess = DictationSession::default();
        let (session, _rx) = crate::cloud::parkable_session();
        *sess.cloud.lock().unwrap() = Some(session);
        *sess.cloud_tx.lock().unwrap() =
            Some(sess.cloud.lock().unwrap().as_ref().unwrap().audio_sender());

        // cloud_active false, never parked → nothing is holding it warm.
        let taken = park_or_take_on_stop(&sess, false);

        assert!(taken.is_some(), "an unparked, never-routing socket is handed back for teardown");
        assert!(sess.cloud.lock().unwrap().is_none(), "and it leaves the slot");
        assert!(
            sess.cloud_tx.lock().unwrap().is_none(),
            "the sender goes with it, or cloud_tx outlives the session it points at"
        );
        // An empty slot is simply nothing to do.
        let empty = DictationSession::default();
        assert!(park_or_take_on_stop(&empty, true).is_none());
    }

    #[test]
    fn a_fresh_arm_carries_a_warm_socket_instead_of_orphaning_it() {
        // THE OTHER HALF OF THE PUSH-TO-TALK FIX, and without it the first half is inert.
        //
        // A push-to-talk RELEASE goes all the way to `setEnabled(false)` (`useMicActions::setOff` —
        // the hold's resting state), so every hold ends in `stop_dictation` and every NEXT hold
        // starts here. Replacing the slot with an empty Arc dropped whatever was parked in it, so a
        // socket banked by hold N was destroyed by hold N+1's arm before `start_cloud_stream` could
        // ever reach `cloud_reuse`'s Resume path. Warm standby only ever worked for the Speak tray,
        // where `enabled` stays true and no rotation happens.
        let mut sess = DictationSession { armed: false, ..Default::default() };
        let (session, _rx) = crate::cloud::parkable_session();
        session.pause(); // what stop_dictation's keep-warm branch does on release
        assert!(session.is_parked() && session.is_alive(), "precondition: a warm, live socket");
        *sess.cloud.lock().unwrap() = Some(session);
        let old_cloud = sess.cloud.clone();

        note_fresh_arm(&mut sess);

        // The generation guards are UNCHANGED — this is what makes the carry safe rather than a
        // hole in the ptr_eq/epoch protocol.
        assert!(!Arc::ptr_eq(&old_cloud, &sess.cloud), "still a fresh generation");
        assert_eq!(sess.cloud_epoch.load(Ordering::SeqCst), 0, "epoch restarts");
        assert!(!sess.cloud_active.load(Ordering::Relaxed), "carried = parked, never routing");
        // What actually moved: the SESSION, into the new slot, where cloud_reuse finds it.
        assert!(
            sess.cloud.lock().unwrap().is_some(),
            "the warm socket must survive the arm — otherwise the next hold pays a full handshake"
        );
        assert!(
            sess.cloud_tx.lock().unwrap().is_some(),
            "the sender must be rebuilt alongside it, or the slot and the sender stop mirroring"
        );
        assert!(old_cloud.lock().unwrap().is_none(), "and it must not be left in the retired Arc too");
        // The payoff, stated as the decision the next start_cloud_stream actually takes.
        assert_eq!(
            cloud_reuse(false, Some(Installed { alive: true, project_matches: true })),
            CloudReuse::Resume,
            "the carried socket is what turns the next hold into a resume with no handshake"
        );
    }

    #[test]
    fn the_reuse_hold_resumes_BEFORE_the_arm_and_the_arm_must_not_drop_it() {
        // ── THE ORDERING THE FIRST VERSION OF THIS FIX GOT WRONG (roborev 61450, High) ───────────
        // The sibling test above calls `note_fresh_arm` on a STILL-PARKED session, which is not the
        // order the reuse hold actually runs in — so it could not see this, and the whole change was
        // inert (worse than inert) on the one path it exists for.
        //
        // On the reuse hold nothing has to handshake, so `start_cloud_stream` reaches `cloud_reuse`'s
        // Resume arm IMMEDIATELY: it calls `resume()` (clearing `parked`), flips `cloud_active` true
        // and returns `Resumed` — and only ~40ms later does `start_dictation` reach the arm. A carry
        // gated on `is_parked()` then declines, and replacing the slot drops the LAST handle to a
        // socket that is live and already being metered: `Drop` only signals Close (no
        // `silence_now()`), so it is torn down mid-hold, audio falls back on-device, and a
        // `cloud-ended` fires into the generation that just armed.
        let mut sess = DictationSession { armed: false, ..Default::default() };
        let (session, _rx) = crate::cloud::parkable_session();
        session.pause();
        *sess.cloud.lock().unwrap() = Some(session);

        // What start_cloud_stream's Resume arm does, in the order it really does it.
        sess.cloud.lock().unwrap().as_ref().unwrap().resume();
        sess.cloud_active.store(true, Ordering::Relaxed);
        assert!(
            !sess.cloud.lock().unwrap().as_ref().unwrap().is_parked(),
            "precondition: the resume already un-parked it — this is the state the arm meets"
        );

        note_fresh_arm(&mut sess);

        assert!(
            sess.cloud.lock().unwrap().is_some(),
            "the arm must NOT drop a live, already-metered socket it finds un-parked"
        );
        assert!(
            sess.cloud_active.load(Ordering::Relaxed),
            "and its routing flag must cross with it — otherwise the frontend was told `Resumed` \
             and started billing while the callback quietly routes on-device"
        );
        assert!(sess.cloud_tx.lock().unwrap().is_some(), "the sender crosses too, or nothing routes");
    }

    #[test]
    fn an_empty_slot_never_carries_a_routing_flag() {
        // The other half of preserving `cloud_active`: a `true` flag over an EMPTY slot tells the
        // capture callback to route at a sender that isn't there — frames dropped rather than
        // transcribed, with no cloud-ended to recover it (the invariant roborev 52647 pinned).
        let mut sess = DictationSession { armed: false, ..Default::default() };
        sess.cloud_active.store(true, Ordering::Relaxed);
        assert!(sess.cloud.lock().unwrap().is_none(), "precondition: nothing installed");

        note_fresh_arm(&mut sess);

        assert!(
            !sess.cloud_active.load(Ordering::Relaxed),
            "no session carried → the routing flag must not be carried either"
        );
    }

    #[test]
    fn a_fresh_arm_never_carries_a_dead_worker() {
        // The one thing the carry still refuses. A dead worker is a corpse — `cloud_reuse` gates on
        // `is_alive` and would reject it anyway, and carrying it would put a session in the slot
        // that can never route, hiding the empty-slot `Open` path behind a socket that is gone.
        // Left in the old Arc and dropped exactly as before, so this change cannot resurrect a
        // session that should have died.
        let mut sess = DictationSession { armed: false, ..Default::default() };
        let (session, _rx) = crate::cloud::parkable_session();
        session.pause();
        session.kill_for_test(); // warm expiry / socket death
        assert!(!session.is_alive(), "precondition: the worker has exited");
        *sess.cloud.lock().unwrap() = Some(session);

        note_fresh_arm(&mut sess);

        assert!(
            sess.cloud.lock().unwrap().is_none(),
            "a dead session must not cross a generation boundary"
        );
        assert!(sess.cloud_tx.lock().unwrap().is_none(), "and no sender may be invented for it");
        assert!(!sess.cloud_active.load(Ordering::Relaxed), "nor a routing flag");
    }

    #[test]
    fn an_orphan_of_a_rotated_generation_is_reported_as_no_evidence_not_as_nothing() {
        // ── THE BANNER'S OWN SPEAK-INTO-THE-SUCCESSOR HAZARD (roborev 59692) ────────────────────
        // Every arm above that reaches Discard emits `dictation://cloud-late`, which paints
        // "connected too late for THAT utterance". Two of those Discards are the current session's
        // own (a mute, an occupied slot) and reporting them is the whole point. The third —
        // `same_generation: false` — is an orphan of a session the user already stopped, landing
        // 1-6 s late (measured) while a fresh start_dictation may already be live and painting
        // interims. The banner has no expiry short of its TTL, so reporting that one states a
        // timing fault about a stream that is working. Same hazard `silence_now()` covers for the
        // transcript, aimed at the banner.
        // ORPHAN, NOT SILENT, and the difference is the whole finding (roborev 60365). Saying
        // nothing is indistinguishable from a handshake that never completed, so the orphan's
        // Ok(false) still fell through to the corroboration counter — which is GLOBAL, so it was
        // charged to the SUCCESSOR episode. Two rapid re-holds (the ordinary push-to-talk pattern)
        // then reached the threshold and claimed Sparkle "can't reach the cloud transcription
        // service" over a relay that had just completed two handshakes: a STRONGER false claim than
        // the banner this gate was added to prevent. It has to be silent on both axes, and only a
        // signal the frontend can recognise makes that possible.
        assert_eq!(
            late_report_for(RacedStream::Discard, false),
            LateReport::Orphan,
            "a rotated-generation orphan must be reported as no-evidence, never as nothing at all"
        );

        // The pair that keeps the assertion above meaning "discriminated" rather than "muted": the
        // cases this event EXISTS for still report, or the too-slow reason is unreachable again.
        assert_eq!(
            late_report_for(RacedStream::Discard, true),
            LateReport::Late,
            "this generation's own late handshake is exactly what the banner must report"
        );
        assert_eq!(
            late_report_for(RacedStream::ParkWarm, true),
            LateReport::Late,
            "parked-for-reuse still means WE CONNECTED and did not install — Ok(false) cannot say so"
        );
        // Nothing went wrong on the install path: the caller answers Ok(true) and the frontend
        // calls noteCloudLive, so a report here would light a banner over a live stream.
        assert_eq!(late_report_for(RacedStream::InstallLive, true), LateReport::Silent);
    }

    #[test]
    fn parking_banks_the_socket_in_the_slot_with_its_sender_and_without_routing() {
        // The SIDE EFFECTS, which the boolean table above cannot see. roborev 55291 made the point
        // by example: the missing `armed` guard was invisible to a table test because a table test
        // cannot say which session states its booleans are reachable from.
        let (session, rx) = crate::cloud::parkable_session();
        let cloud: Mutex<Option<DeepgramSession>> = Mutex::new(None);
        let cloud_tx: Mutex<Option<CloudAudioSender>> = Mutex::new(None);
        let cloud_active = AtomicBool::new(false);

        park_raced_stream(&cloud, &cloud_tx, session);

        let guard = cloud.lock().unwrap();
        let parked = guard.as_ref().expect("the socket must be banked in the slot, not dropped");
        // BOTH halves of pause(), because the flag is the lesser one: the atomic only tells
        // stop_cloud_stream to keep the socket, while the MESSAGE is what stops the worker
        // forwarding audio and starts the warm timer (roborev 55315).
        assert!(parked.is_parked(), "the parked flag must be set, or a stop will close the socket");
        assert!(rx.took_pause(), "a Pause must REACH the worker, or the socket keeps relaying audio");
        assert!(
            cloud_tx.lock().unwrap().is_some(),
            "cloud_tx must mirror the slot, exactly as warm standby leaves it"
        );
        assert!(
            !cloud_active.load(Ordering::Relaxed),
            "parked is NOT routing — flipping this would meter a stream carrying no audio"
        );
        // And `cloud_reuse` is what picks it up: alive + parked + our project → Resume, no handshake.
        assert_eq!(
            cloud_reuse(
                false,
                Some(Installed { alive: parked.is_alive(), project_matches: true })
            ),
            CloudReuse::Resume
        );
    }

    #[test]
    fn a_live_install_never_drops_a_parked_socket_in_place() {
        // roborev 55291. Parking broke the invariant that the slot is empty at install time: start A
        // races a stop and parks, start B (holding the current epoch) then installs. A bare
        // assignment would drop A through `Drop for DeepgramSession`, which only signals Close — so
        // A's worker drains its transcripts into B's composer and emits a cloud-ended that stops B.
        let (parked, _rx_a) = crate::cloud::parkable_session();
        let (fresh, _rx_b) = crate::cloud::parkable_session();
        let cloud: Mutex<Option<DeepgramSession>> = Mutex::new(None);
        let cloud_tx: Mutex<Option<CloudAudioSender>> = Mutex::new(None);
        let cloud_active = AtomicBool::new(false);
        park_raced_stream(&cloud, &cloud_tx, parked);

        let displaced = install_live_stream(&cloud, &cloud_tx, &cloud_active, fresh);

        let displaced = displaced.expect("the occupant must be handed back, not dropped in place");
        assert!(
            displaced.is_silenced(),
            "a displaced socket must be muted AND suppressed before its close is handed off"
        );
        assert!(cloud.lock().unwrap().is_some(), "the fresh session takes the slot");
        assert!(cloud_tx.lock().unwrap().is_some(), "cloud_tx mirrors the slot");
        assert!(
            cloud_active.load(Ordering::Relaxed),
            "an installed live stream routes — this is the flag the capture callback reads"
        );
        displaced.finish();
    }

    // ── THE PUSH-TO-TALK PRE-CONNECT (sparkle-v3990, the latency half) ──────────────────────────

    /// What `start_cloud_stream` would ask `cloud_reuse` at the moment of a hold, read off a real
    /// session slot. The whole fix is a statement about this value, so it is computed the way the
    /// command computes it rather than hand-built — a fixture that constructs `Installed` itself
    /// would assert the test's own arithmetic instead of the session's state.
    fn reuse_at_hold_time(sess: &DictationSession) -> CloudReuse {
        let cloud = sess.cloud.lock().unwrap();
        let installed = cloud.as_ref().map(|s| Installed {
            alive: s.is_alive(),
            project_matches: s.is_for_project(None),
        });
        cloud_reuse(sess.cloud_active.load(Ordering::Relaxed), installed)
    }

    #[test]
    fn a_short_hold_finds_the_socket_already_connected_instead_of_paying_a_handshake() {
        // THE ONE ASSERTION THE WHOLE CHANGE EXISTS FOR, and it is deliberately taken at the
        // decision layer rather than through the command: `start_cloud_stream` needs an `AppHandle`,
        // a `State` and a live relay, and the arms that matter here cannot be driven to completion
        // in CI — the vacuous shape `plan_capture_for`'s doc warns about, where the test passes
        // identically with and without the fix.
        //
        // BEFORE — push to talk at rest, nothing banked. This is not a hypothetical: push to talk
        // rests DISARMED and PASSIVE, and the socket is opened on the passive→active edge, so this
        // is the state every single hold started from. `Open` means a full TLS+WS handshake (~490 ms
        // measured) inside a hold measured at 76-567 ms — the socket lands after the key comes up,
        // the utterance falls back on-device, and the on-device engine emits no interims at all.
        let cold = DictationSession::default();
        assert_eq!(
            reuse_at_hold_time(&cold),
            CloudReuse::Open,
            "the un-preconnected rest state is exactly the one that pays a handshake per hold"
        );

        // AFTER — the same rest state, plus the pre-connect firing when push to talk became the
        // armed tray position in a focused window.
        let mut sess = DictationSession::default();
        sess.focused = true;
        assert_eq!(
            preconnect_plan(true, sess.focused, reuse_at_hold_time(&sess), false, None),
            PreconnectPlan::Connect,
            "a focused, at-rest push-to-talk window with an empty slot is what a pre-connect is for"
        );
        // The handshake the plan authorised, landing while the user still has not pressed anything.
        let (socket, rx) = crate::cloud::parkable_session();
        let slot_empty = sess.cloud.lock().unwrap().is_none();
        assert_eq!(
            preconnect_landing(sess.focused, slot_empty, sess.cloud_active.load(Ordering::Relaxed)),
            PreconnectLanding::Park
        );
        park_preconnected_stream(&sess.cloud, &sess.cloud_tx, socket);

        // THE HOLD. Same question, same code path, at the same point in the gesture — and now the
        // answer is the one that costs nothing. `Resume` is `start_cloud_stream` returning without
        // ever reaching `DeepgramSession::start`, so the relay is live from the first syllable and
        // the interims that drive the word-by-word preview start arriving immediately.
        assert_eq!(
            reuse_at_hold_time(&sess),
            CloudReuse::Resume,
            "at the moment of the hold the socket must ALREADY be connected — Resume is the whole \
             fix, and Open here means the founder is back to a handshake he cannot outlast"
        );
        // And the reuse is real rather than nominal: the socket is genuinely parked with its warm
        // timer running, which is what `Resume`'s `resume()` un-parks.
        assert!(
            rx.took_pause(),
            "the banked socket must have been PAUSED, or it runs no warm timer, never closes on our \
             schedule, and `resume()` un-parks something that was never parked"
        );
    }

    #[test]
    fn a_pre_connected_socket_survives_the_arm_the_hold_itself_performs() {
        // THE HOP THAT MAKES THE FIX REACHABLE AT ALL, and it is invisible from the plan alone. A
        // pre-connect banks its socket while the mic is DISARMED (push to talk rests at
        // `setEnabled(false)`), so the hold's own `start_dictation` runs `note_fresh_arm` and
        // rotates all four cloud Arcs out from under it. If the socket did not cross that boundary
        // the pre-connect would be dead on arrival — every hold would find an empty slot and
        // handshake exactly as before, with nothing in the logs to say why.
        let mut sess = DictationSession::default();
        sess.focused = true;
        let (socket, _rx) = crate::cloud::parkable_session();
        park_preconnected_stream(&sess.cloud, &sess.cloud_tx, socket);

        // The hold: `setEnabled(true)` → start_dictation → note_fresh_arm.
        note_fresh_arm(&mut sess);

        assert_eq!(
            reuse_at_hold_time(&sess),
            CloudReuse::Resume,
            "the arm must CARRY the pre-connected socket into the new generation, not drop it"
        );
        assert!(
            sess.cloud_tx.lock().unwrap().is_some(),
            "and its sender crosses with it, or the slot and the sender stop mirroring each other"
        );
        assert!(
            !sess.cloud_active.load(Ordering::Relaxed),
            "the carried socket is still PARKED, not routing — an arm must not start a meter"
        );
        assert!(
            sess.cloud.lock().unwrap().as_ref().unwrap().is_speculative(),
            "and it is still a guess: the user has not spoken into it yet, so a blur may still \
             release it"
        );
    }

    #[test]
    fn a_pre_connected_socket_is_parked_and_never_meters() {
        // THE BILLING SEAM, ASSERTED RATHER THAN ARGUED. Parking deliberately does not meter — the
        // `Raced` arm's comment says "the caller must NOT start metering (nothing is streaming)" —
        // and a socket opened before the user pressed anything must be identical in that respect.
        // Charging the founder for sockets he never spoke into would be a worse bug than the latency
        // this fixes.
        let sess = DictationSession::default();
        let (socket, rx) = crate::cloud::parkable_session();

        park_preconnected_stream(&sess.cloud, &sess.cloud_tx, socket);

        assert!(
            !sess.cloud_active.load(Ordering::Relaxed),
            "cloud_active is the flag the capture callback routes on AND the state a live install \
             sets — a pre-connect must leave it false or it bills for silence"
        );
        let guard = sess.cloud.lock().unwrap();
        let parked = guard.as_ref().expect("the socket is banked, not dropped");
        assert!(parked.is_parked(), "and it is parked, so a stop keeps it instead of closing it");
        assert!(parked.is_speculative(), "marked as a guess, which is what a blur releases on");
        assert!(
            rx.took_pause(),
            "the Pause must REACH the worker: it is what starts the warm timer, and the warm timer \
             is the only thing that ever closes a socket the user never used"
        );
        assert!(
            sess.cloud_tx.lock().unwrap().is_some(),
            "cloud_tx mirrors the slot, exactly as warm standby leaves the pair"
        );
    }

    #[test]
    fn tabbing_away_hands_back_a_socket_that_was_only_ever_a_guess() {
        // `focused` is the OUTER term, mirroring `capture_should_be_live` for the microphone: a
        // relay connection held open to Sparkle's servers while the user is in another app is the
        // same class of promise as an open mic. Declining to open the NEXT one is not enough — the
        // one already open has to go back.
        let mut sess = DictationSession::default();
        sess.focused = true;
        let (socket, _rx) = crate::cloud::parkable_session();
        park_preconnected_stream(&sess.cloud, &sess.cloud_tx, socket);

        // The blur. `want` is still true (the tray has not moved) — focus alone must decide it.
        assert_eq!(
            preconnect_plan(true, false, reuse_at_hold_time(&sess), true, None),
            PreconnectPlan::Release
        );

        let taken = take_speculative_stream(&sess.cloud, &sess.cloud_tx)
            .expect("a speculative socket must actually leave the slot, not merely be planned away");
        assert!(
            taken.is_silenced(),
            "and leave silenced: Drop only signals Close, so an un-silenced session emits a \
             cloud-ended into whatever session comes up next"
        );
        assert!(sess.cloud.lock().unwrap().is_none(), "the slot is empty again");
        assert!(
            sess.cloud_tx.lock().unwrap().is_none(),
            "and the sender goes with it, or cloud_tx outlives the socket it points at"
        );
        taken.finish();
    }

    #[test]
    fn a_blur_never_takes_a_socket_the_user_actually_dictated_into() {
        // THE PAIR THAT MAKES THE TEST ABOVE MEAN "SPECULATIVE" RATHER THAN "ANY PARKED SOCKET".
        // Warm standby holds a socket across a blur ON PURPOSE — `park_cloud_for_blur` exists so a
        // quick tab-away and back resumes on the same connection instead of paying a handshake. A
        // release that could not tell the two apart would delete that.
        let mut sess = DictationSession::default();
        sess.focused = true;
        let (socket, _rx) = crate::cloud::parkable_session();
        park_preconnected_stream(&sess.cloud, &sess.cloud_tx, socket);

        // The user held the key and spoke: `cloud_reuse`'s Resume arm calls resume(), which is where
        // a socket stops being a guess.
        sess.cloud.lock().unwrap().as_ref().unwrap().resume();
        assert!(
            !sess.cloud.lock().unwrap().as_ref().unwrap().is_speculative(),
            "resume() retires the mark — the socket has carried an utterance now"
        );

        assert_eq!(
            preconnect_plan(true, false, reuse_at_hold_time(&sess), false, None),
            PreconnectPlan::Idle,
            "a blur must not release a socket the user dictated into"
        );
        assert!(
            take_speculative_stream(&sess.cloud, &sess.cloud_tx).is_none(),
            "and the take re-reads the mark itself, so a stale plan cannot close a live socket"
        );
        assert!(
            sess.cloud.lock().unwrap().is_some(),
            "the focus-regain resume must still have a socket to come back to"
        );
    }

    #[test]
    fn the_pre_connect_never_opens_a_second_socket_or_pre_empts_a_hold() {
        // `Open` is the ONLY reuse answer that means a hold would pay a handshake, so it is the only
        // one worth spending a `firstMinuteCents` debit on. Each of the others is a distinct reason
        // NOT to, and collapsing any of them into Connect costs real money or breaks a live stream.
        assert_eq!(preconnect_plan(true, true, CloudReuse::Open, false, None), PreconnectPlan::Connect);
        assert_eq!(
            preconnect_plan(true, true, CloudReuse::Resume, true, None),
            PreconnectPlan::Idle,
            "a warm socket is already banked — re-opening burns a second first-minute debit for a \
             connection the next hold already had"
        );
        assert_eq!(
            preconnect_plan(true, true, CloudReuse::AlreadyRouting, false, None),
            PreconnectPlan::Idle,
            "the user is mid-utterance; a speculative socket underneath a live one is the \
             speak-into-the-successor hazard, bought with money"
        );
        assert_eq!(
            preconnect_plan(true, true, CloudReuse::Reopen, false, None),
            PreconnectPlan::Idle,
            "a project mismatch is a BILLING decision start_cloud_stream owns — tearing down \
             another project's socket on spec is not the pre-connect's call"
        );
        // The two gates, each sufficient on its own.
        assert_eq!(
            preconnect_plan(true, false, CloudReuse::Open, false, None),
            PreconnectPlan::Idle,
            "unfocused: nothing is opened, whatever the tray says"
        );
        assert_eq!(
            preconnect_plan(false, true, CloudReuse::Open, false, None),
            PreconnectPlan::Idle,
            "the frontend's gate (tray position, rest state, the live AI prefs) is not advisory"
        );
        // A gate that is off with nothing speculative banked is simply nothing to do — it must not
        // become a release that reaches for someone else's socket.
        assert_eq!(preconnect_plan(false, true, CloudReuse::Resume, false, None), PreconnectPlan::Idle);
        assert_eq!(preconnect_plan(false, true, CloudReuse::Resume, true, None), PreconnectPlan::Release);
    }

    #[test]
    fn focus_churn_cannot_buy_more_than_one_speculative_minute_per_minute() {
        // THE COST FLOOR, AND IT IS THE BLUR RELEASE THAT MAKES IT NECESSARY. Releasing on blur is
        // the right privacy answer and it is exactly what turns a focus cycle into a fresh 6¢
        // debit: the blur empties the slot, so the refocus sees `Open` and buys another first
        // minute. Alt-tabbing between Sparkle and a browser would cost one relay minute per round
        // trip, for a microphone nobody touched — which is a worse bug than the latency this change
        // fixes, and unlike the latency it is silent.
        let just_now = PRECONNECT_COOLDOWN - Duration::from_secs(1);
        assert_eq!(
            preconnect_plan(true, true, CloudReuse::Open, false, Some(just_now)),
            PreconnectPlan::Idle,
            "a second speculative handshake inside the paid minute buys a minute already paid for"
        );
        // Never pre-connected, and cooled down: both must fire, or the feature is off rather than
        // merely bounded.
        assert_eq!(preconnect_plan(true, true, CloudReuse::Open, false, None), PreconnectPlan::Connect);
        assert_eq!(
            preconnect_plan(true, true, CloudReuse::Open, false, Some(PRECONNECT_COOLDOWN)),
            PreconnectPlan::Connect,
            "the boundary is inclusive — at exactly one paid minute the previous debit is spent"
        );
        // AND THE FLOOR MUST NEVER GATE A RELEASE. It exists to stop us SPENDING; applying it to
        // the give-back would leave a speculative socket open across a blur for up to a minute,
        // which is the privacy property inverted by a cost guard.
        assert_eq!(
            preconnect_plan(true, false, CloudReuse::Resume, true, Some(Duration::ZERO)),
            PreconnectPlan::Release
        );
        // Cheap, but the one relationship worth pinning: the floor is the BILLING quantum, not a
        // UX delay. A floor shorter than the paid minute is a floor that lets churn re-buy.
        assert_eq!(
            PRECONNECT_COOLDOWN,
            Duration::from_secs(60),
            "PRECONNECT_COOLDOWN is the relay's per-minute debit quantum; changing it changes what \
             a user can be charged for doing nothing"
        );
    }

    #[test]
    fn a_pre_connect_that_lands_too_late_is_discarded_rather_than_banked() {
        // The handshake takes hundreds of ms, and all three of these can happen inside it.
        assert_eq!(preconnect_landing(true, true, false), PreconnectLanding::Park);
        assert_eq!(
            preconnect_landing(true, false, false),
            PreconnectLanding::Discard,
            "a hold started and claimed the slot — banking over it would drop a live socket through \
             Drop, which only signals Close"
        );
        assert_eq!(
            preconnect_landing(true, true, true),
            PreconnectLanding::Discard,
            "never shadow a session that is routing"
        );
        assert_eq!(
            preconnect_landing(false, true, false),
            PreconnectLanding::Discard,
            "the window blurred while we connected — the same outer term, re-checked after the wait"
        );
    }

    #[test]
    fn an_unraced_stream_still_installs_live() {
        assert_eq!(disposition(Race { install: true, ..SALVAGEABLE }), RacedStream::InstallLive);
        // `install` wins outright: should_install_cloud already proved the intent is current, so no
        // combination of the park guards may downgrade a live install to a park.
        assert_eq!(
            disposition(Race { install: true, armed: false, slot_empty: false, ..SALVAGEABLE }),
            RacedStream::InstallLive
        );
    }

    #[test]
    fn should_install_cloud_only_when_intent_is_still_current() {
        // Happy path: same session generation, epoch unchanged, capture live, not already active.
        assert!(should_install_cloud(true, true, true, false));
        // Each race that can happen during the blocking handshake must reject (and the caller then
        // finish()es the orphan rather than installing it):
        assert!(!should_install_cloud(false, true, true, false), "generation swapped (stop+restart)");
        assert!(!should_install_cloud(true, false, true, false), "epoch bumped (stop_cloud_stream/stop)");
        assert!(!should_install_cloud(true, true, false, false), "capture torn down (stop_dictation)");
        assert!(!should_install_cloud(true, true, true, true), "a racing start already opened one");
        // All-false (e.g. stopped + restarted + already active) also rejects — makes the AND total.
        assert!(!should_install_cloud(false, false, false, true));
    }

    #[test]
    fn start_after_load_aborts_when_a_stop_landed_during_the_model_load() {
        // The resurrect race (two fresh-install users crashed on it): fresh install → mic OFF, so
        // the user's first click is ON → start_dictation blocks on a 482MB model download. The user
        // then unclicks the mic mid-download → stop_dictation disarms AND bumps the epoch. When the
        // load finishes, start must see the epoch moved and ABORT — not re-arm a muted mic. `armed`
        // is already false here (the stop cleared it), which is precisely why the epoch is needed.
        assert_eq!(
            start_after_load(0, 1, false),
            StartAfterLoad::AbortMutedDuringLoad,
            "a stop during the load (epoch advanced) must abort even though armed is false"
        );
        // Even if a racing start re-armed after that stop, the epoch still advanced → abort and
        // leave the other start's fresh session untouched.
        assert_eq!(
            start_after_load(0, 1, true),
            StartAfterLoad::AbortMutedDuringLoad,
            "epoch is checked first: a stop+re-arm during the load still aborts this start"
        );
    }

    #[test]
    fn start_after_load_reconciles_on_a_racing_start_and_arms_on_a_clean_load() {
        // Epoch unchanged + a racing start_dictation already armed → don't overwrite the live
        // transcriber without finalize(); just reconcile.
        assert_eq!(start_after_load(3, 3, true), StartAfterLoad::AlreadyArmed);
        // Epoch unchanged + not armed → the clean fresh-arm path installs the transcriber.
        assert_eq!(start_after_load(3, 3, false), StartAfterLoad::Arm);
    }

    /// The freeze guard itself, enforced by the compiler rather than at runtime — the two properties
    /// that keep the 631MB first-run load off the main thread, both of which are quietly lost by an
    /// innocent-looking edit:
    ///
    ///   - `start_dictation` RETURNS A FUTURE. Drop the `async` and tauri-macros silently reclassifies
    ///     it as `ExecutionContext::Blocking`, running the whole download inline on the IPC/event-loop
    ///     thread — the beachball this fix exists to remove. There's no warning; the app just freezes
    ///     again on a machine that doesn't have the model yet (i.e. never on a developer's).
    ///   - That future is `Send`. `respond_async_serialized` requires it, and the only realistic way
    ///     to lose it is holding the session's `std::sync::Mutex` guard across the `.await` — which is
    ///     precisely the mistake the epoch protocol cannot survive. This turns "don't hold the lock
    ///     across an await" from a comment into a compile error.
    #[test]
    fn start_dictation_is_async_and_its_future_is_send() {
        fn off_the_main_thread<'r, F: std::future::Future + Send>(
            _: fn(AppHandle, State<'r, DictationState>, Option<u64>) -> F,
        ) {
        }
        off_the_main_thread(super::commands::start_dictation);
    }

    /// The SAME freeze guard, for the two STOP commands (sparkle-aah5). `start_dictation` was moved
    /// off the main thread, but `stop_dictation` and `stop_cloud_stream` were left as sync
    /// `#[tauri::command]`s doing the blocking teardown — the decode-worker join, the Deepgram
    /// `finish()` flush, the on-device `finalize()` — INLINE on the IPC/event-loop thread, so muting
    /// or ending a cloud stream froze the UI exactly the way the first-run load once did.
    ///
    /// The fix is `async fn` + `spawn_blocking`, and this is the compile-time tripwire that keeps it
    /// that way: an async command returns a FUTURE, so both symbols coerce to a `fn(..) -> F` where
    /// `F: Future + Send`. Drop the `async` from either and tauri-macros silently reclassifies it as
    /// `ExecutionContext::Blocking` (inline on the main thread again) — its signature is then
    /// `fn(..) -> ()`, which does not satisfy `Future`, and THIS TEST STOPS COMPILING. `Send` is the
    /// second half: `respond_async_serialized` requires it, and the only realistic way to lose it is
    /// holding the session `std::sync::Mutex` guard across the `.await` — the precise mistake the
    /// epoch protocol cannot survive — so this also pins "drop the lock before awaiting the
    /// teardown" as a compile error rather than a comment.
    ///
    /// Asserting the SIGNATURE, not a runtime effect, is deliberate: the fix IS the signature (it is
    /// what selects the async execution context), the teardown itself needs a live Tauri `AppHandle`
    /// + `State` that a unit test cannot construct, and this is the same shape the sibling
    /// `start_dictation_is_async_and_its_future_is_send` uses for the identical property.
    #[test]
    fn the_stop_commands_are_async_and_their_futures_are_send() {
        // stop_dictation: (AppHandle, State) -> impl Future + Send
        fn stop_off_the_main_thread<'r, F: std::future::Future + Send>(
            _: fn(AppHandle, State<'r, DictationState>) -> F,
        ) {
        }
        stop_off_the_main_thread(super::commands::stop_dictation);

        // stop_cloud_stream: (State) -> impl Future + Send  (no AppHandle arg)
        fn stop_cloud_off_the_main_thread<'r, F: std::future::Future + Send>(
            _: fn(State<'r, DictationState>) -> F,
        ) {
        }
        stop_cloud_off_the_main_thread(super::commands::stop_cloud_stream);
    }

    /// ── THE 2026-08-05 "DICTATION CAPTURES NO AUDIO" REGRESSION ──────────────────────────────────
    ///
    /// The founder held push-to-talk, the button lit, the waveform turned blue, and NOTHING was ever
    /// captured. Cause: commit 1732ed7f5 made push-to-talk release the mic at rest, so
    /// `stop_dictation` dropped the transcriber on every release and the next hold re-ran the full
    /// ONNX transducer init (1977 of 2578 samples in that morning's hang stacks, inside
    /// `SherpaOnnxCreateOfflineRecognizer`). That load outlasts a hold, so the release always landed
    /// mid-load, `start_after_load` aborted the arm, and `sess.capture` stayed `None` — which then
    /// made every cloud handshake hit the stop/again discard guard, 261 times in one day.
    ///
    /// THE ASSERTION IS THE LOAD COUNT, not that a value came back. "It returned a decoder" was
    /// already true before the fix; what was false — and what actually broke the microphone — is that
    /// the SECOND arm paid for another ONNX init. A test that only checked the return value would
    /// have passed against the broken build.
    ///
    /// ── WHAT THIS DOES *NOT* PROVE, AND WHERE THAT GAP IS CLOSED INSTEAD (roborev 59063/59101) ──
    /// It pins the CONTRACT OF `cached_or_build`, not the WIRING — so do not read a green here as
    /// "the arm path is cached". That gap is not closeable by a unit test: pinning the wiring means
    /// constructing an `Arc<Decoder>`, which needs a real `OfflineRecognizer`, i.e. the ~661 MB
    /// model CI does not have.
    ///
    /// It is closed by the API SHAPE instead. `transcribe`'s uncached constructors (`load_decoder`,
    /// `with_decoder`) are private to that module and the cache sits beside them, so
    /// `ParakeetTdt::armed` is the only session constructor this module can reach and there is no
    /// uncached path for `load_model` to drift back into. An earlier attempt used `#[cfg(test)]` on
    /// an uncached `new()` and claimed the same thing; that was FALSE while the two builders stayed
    /// `pub`, because `with_decoder(m, load_decoder(m)?)` reproduced the bug and compiled.
    #[test]
    fn a_re_arm_reuses_the_loaded_decoder_instead_of_paying_for_another_onnx_init() {
        use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
        let cache: Mutex<Option<Arc<&'static str>>> = Mutex::new(None);
        let loads = AtomicUsize::new(0);
        let build = || -> Result<Arc<&'static str>, String> {
            loads.fetch_add(1, AtomicOrdering::SeqCst);
            Ok(Arc::new("onnx-recognizer"))
        };

        let first_arm = crate::transcribe::cached_or_build(&cache, build).expect("first arm loads");
        let second_arm = crate::transcribe::cached_or_build(&cache, build).expect("second arm reuses");

        assert_eq!(
            loads.load(AtomicOrdering::SeqCst),
            1,
            "the re-arm must NOT re-run the ONNX init — that multi-second window is what the \
             push-to-talk release lands in, aborting the arm and leaving the mic deaf",
        );
        assert!(
            Arc::ptr_eq(&first_arm, &second_arm),
            "and it must be the SAME recognizer, not an equal-looking second one",
        );
    }

    /// A load that FAILS must not be remembered. `verify_for_load` legitimately rejects a
    /// half-downloaded model, and caching that failure would brick the mic for the whole process —
    /// trading a transient error for a permanent one, which is the same shape of bug as the
    /// regression above.
    #[test]
    fn a_failed_load_is_not_cached_so_the_next_arm_can_still_recover() {
        use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
        let cache: Mutex<Option<Arc<&'static str>>> = Mutex::new(None);
        let attempts = AtomicUsize::new(0);

        let failed = crate::transcribe::cached_or_build(&cache, || -> Result<Arc<&'static str>, String> {
            attempts.fetch_add(1, AtomicOrdering::SeqCst);
            Err("model incomplete".into())
        });
        assert!(failed.is_err(), "the first arm surfaces the failure");
        assert!(
            cache.lock().unwrap().is_none(),
            "and nothing is cached, or every later arm would replay this failure",
        );

        let recovered = crate::transcribe::cached_or_build(&cache, || -> Result<Arc<&'static str>, String> {
            attempts.fetch_add(1, AtomicOrdering::SeqCst);
            Ok(Arc::new("onnx-recognizer"))
        });
        assert_eq!(*recovered.expect("the retry succeeds"), "onnx-recognizer");
        assert_eq!(
            attempts.load(AtomicOrdering::SeqCst),
            2,
            "the second arm genuinely retried the build rather than reading a cached failure",
        );
    }

    /// The model load must be mutually exclusive process-wide. Two concurrent loads promote into the
    /// SAME `root/ASR_DIR` via `remove_dir_all` + `rename`, so an unserialized second load can delete
    /// the tree the first has just verified and is handing to sherpa-onnx — an uncatchable C++ abort,
    /// not a recoverable error (see MODEL_LOAD). Newly reachable now that the loads run off-thread.
    ///
    /// Exclusion is the whole property, so that is what this asserts: while one load holds the guard,
    /// a second cannot acquire it and must wait.
    ///
    /// Deliberately ONE test rather than two: `MODEL_LOAD` is a global, and cargo runs tests on
    /// parallel threads, so a sibling test touching it would race this one's `try_lock` assertions
    /// (and the poison check below would leak into it — `try_lock` on a poisoned mutex reports
    /// `Poisoned`, not `WouldBlock`). Kept sequential here, so the ordering is deterministic.
    #[test]
    fn the_model_load_is_serialized_and_survives_a_panicked_load() {
        use std::sync::TryLockError;
        {
            let _held = super::MODEL_LOAD.lock().unwrap_or_else(|p| p.into_inner());
            assert!(
                matches!(super::MODEL_LOAD.try_lock(), Err(TryLockError::WouldBlock)),
                "a second load must WAIT for the first, never race its promote into the shared dest"
            );
        }
        assert!(super::MODEL_LOAD.try_lock().is_ok(), "and the guard is released when a load finishes");

        // A panicking load must not brick the mic for the rest of the process's lifetime. Every lock
        // in this module is poison-tolerant for that reason (), and the guard gating EVERY
        // first-run mic click is the last one that should wedge permanently.
        let _ = std::panic::catch_unwind(|| {
            let _g = super::MODEL_LOAD.lock().unwrap_or_else(|p| p.into_inner());
            panic!("model load blew up");
        });
        // `load_model` acquires exactly this way, so a later click still gets through.
        drop(super::MODEL_LOAD.lock().unwrap_or_else(|p| p.into_inner()));
    }

    // ── THE ARM-ORIGIN HANDOFF (sparkle-oyapv) ───────────────────────────────────────────────────
    //
    // The Rust half of the keydown handoff had NO test (roborev, Medium), while the TypeScript half
    // (`voice/holdOrigin`) was pinned from every direction. That asymmetry mattered because the two
    // guarantees below are the only thing stopping an abandoned hold from labelling an unrelated
    // capture — one rebuilt by a focus event or the watchdog — with somebody else's keydown. As
    // written before these rows, deleting the `< ARM_ORIGIN_MAX_AGE` check or turning the `.take()`
    // into a peek left the whole Rust suite green.
    //
    // These drive the REAL `set_arm_origin` / `take_arm_origin` against the real static rather than
    // an extracted predicate: a pure `is_fresh(age)` helper would be satisfied by a call site that
    // no longer consults it, which is the same vacuity one level up.

    /// Serializes the rows below. `ARM_ORIGIN` is ONE process-wide slot and cargo runs tests in
    /// parallel in one process, so without this the two tests would consume each other's origin —
    /// the same interference `audio::tests::DEVICE_TEST_LOCK` exists for, and the same reason it is
    /// not a statement about production (one arm sets the slot at a time there).
    static ARM_ORIGIN_TEST_LOCK: Mutex<()> = Mutex::new(());

    /// An origin whose keydown is `age` in the past, or `None` when this process has not been alive
    /// that long (`Instant::checked_sub` cannot go before the clock's base).
    fn origin_aged(age: std::time::Duration) -> Option<crate::audio::ArmOrigin> {
        let now = std::time::Instant::now();
        Some(crate::audio::ArmOrigin {
            keydown: now.checked_sub(age)?,
            reconcile_at: now,
            js_to_invoke_ms: 7,
            prelude_ms: 0,
            permission_ms: 0,
            model_ms: 0,
        })
    }

    #[test]
    fn a_fresh_arm_origin_is_handed_over_exactly_once() {
        let _serial = ARM_ORIGIN_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        // ONE-SHOT is the property. A second capture — the focus-event rebuild that follows a hold,
        // or the watchdog's — must find nothing, or it would publish a keydown span for a capture
        // no key press produced.
        super::set_arm_origin(origin_aged(std::time::Duration::ZERO).expect("zero age never fails"));

        let first = super::take_arm_origin();
        assert!(first.is_some(), "the capture this arm is building must receive the gesture");
        assert_eq!(first.unwrap().js_to_invoke_ms, 7, "and receive it intact");
        assert!(
            super::take_arm_origin().is_none(),
            "a SECOND capture must not be billed against the same keydown"
        );
    }

    #[test]
    fn a_stale_arm_origin_is_rejected_and_discarded() {
        let _serial = ARM_ORIGIN_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let Some(stale) = origin_aged(super::ARM_ORIGIN_MAX_AGE + std::time::Duration::from_secs(1))
        else {
            eprintln!("SKIPPED a_stale_arm_origin_is_rejected_and_discarded: process too young");
            return;
        };
        super::set_arm_origin(stale);

        assert!(
            super::take_arm_origin().is_none(),
            "an origin nobody claimed in time is not this capture's keydown"
        );
        // …and the slot is usable again, so one stale origin cannot wedge the reporting.
        super::set_arm_origin(origin_aged(std::time::Duration::ZERO).unwrap());
        assert!(super::take_arm_origin().is_some(), "a later real hold is still reported");

        // ── WHY THERE IS NO "…AND THE STALE ONE WAS DISCARDED" ROW HERE ──────────────────────────
        // The code review that asked for these tests also asked for that assertion — a second
        // `take` after the stale rejection, "so the discard is what's pinned rather than just the
        // rejection". It was written exactly that way, and MUTATION-CHECKED: rewriting
        // `take_arm_origin` to peek and leave a stale origin in the slot left it GREEN.
        //
        // It has to, and the reason is worth recording rather than rediscovering. A stale origin
        // that is left behind is STILL STALE on the next call, so it is rejected again — the two
        // implementations are indistinguishable through this API. `.take()` on the reject path is
        // defensive tidiness, not observable behaviour, and there is no test that can pin it.
        // Writing the row anyway would have added a guard that can never fail, which is this
        // repo's most common defect, arrived at by following a review suggestion literally.
    }

    /// MEASUREMENT, not an assertion (sparkle-oyapv, Task 3). What `model_ms` — the third stage of
    /// the keydown→first-sample span — actually costs, split into the part that is paid ONCE per
    /// process and the part every hold pays again.
    ///
    /// THE QUESTION IT ANSWERS. `transcribe::with_decoder` builds a fresh Silero VAD ORT session on
    /// every arm; it is the one remaining un-cached ORT construction on the arm path, and until now
    /// its cost had never been separated from the cached-decoder case in any log — the note at
    /// `start_dictation`'s `model_ms` says exactly that. `DECODER_CACHE` makes the separation
    /// trivial to observe: round 1 is `ONNX transducer init + VAD + verification`, and every later
    /// round is `VAD + verification` alone, because the recognizer is served from the cache. The
    /// difference between them IS the answer, and it needs no new instrumentation to read.
    ///
    /// `#[ignore]` because it loads ~661 MB of real model files from the user's app-data directory
    /// and takes seconds — run it deliberately:
    ///   cargo test --lib measure_model_load_split -- --ignored --nocapture
    ///
    /// It asserts NOTHING, for the same reason its `audio.rs` sibling does: whether the models are
    /// installed at all is a property of the machine, not of this code, and an assertion on that is
    /// the kind that gets deleted rather than read. It SKIPS loudly when they are absent.
    #[test]
    #[ignore = "loads ~661MB of real ONNX models; run with --ignored --nocapture"]
    fn measure_model_load_split() {
        // The RELEASE install location — the one a shipped build reads, which is the number that
        // matters for what the founder actually runs. Resolved by hand because there is no Tauri app
        // in a unit test.
        //
        // NOT identical to what THIS build's preload would read (roborev 61716). `app_data_dir` runs
        // the path through `dev_identity::apply_dev_suffix_path`, which appends `-dev` to the final
        // component whenever `is_dev()`, and `cargo test` is a debug build — so a debug-build
        // `preload_model_in_background` loads `ai.sparkle.desktop-dev/models`, which exists on this
        // machine as a separate install. Deliberately left pointing at the release copy: this is a
        // measurement of the cost the SHIPPED app pays, not a proof about the current binary, and
        // the two model directories hold the same files anyway. Do not read a pass here as evidence
        // that the preload wired up correctly — it measures `load_model`, not the boot path.
        let Some(home) = std::env::var_os("HOME") else {
            eprintln!("SKIPPED measure_model_load_split: no HOME");
            return;
        };
        let root = std::path::Path::new(&home)
            .join("Library/Application Support/ai.sparkle.desktop/models");
        if !root.join("silero_vad.onnx").exists() {
            eprintln!(
                "SKIPPED measure_model_load_split: no models installed at {} — arm the mic once \
                 in the app first, or run this on a machine that has.",
                root.display()
            );
            return;
        }

        let mut ms: Vec<Option<f64>> = Vec::new();
        for round in 1..=3 {
            let t = std::time::Instant::now();
            match super::load_model(&root, |_, _| {}) {
                Ok(_session) => {
                    let elapsed = t.elapsed().as_secs_f64() * 1000.0;
                    ms.push(Some(elapsed));
                    eprintln!(
                        "round {round}: load_model {elapsed:7.1} ms  ({})",
                        if round == 1 {
                            "ONNX transducer init + Silero VAD + file verification"
                        } else {
                            "Silero VAD + file verification ONLY — the transducer came from DECODER_CACHE"
                        }
                    );
                }
                // Not a panic: a busy or half-installed model directory is a property of the
                // machine. Later rounds are the interesting ones, so keep going.
                Err(e) => {
                    ms.push(None);
                    eprintln!("round {round}: SKIPPED — load_model failed ({e})");
                }
            }
        }

        // THE DELTA IS THE ANSWER TO "WHAT DOES THE BOOT PRELOAD BUY?", and it is printed here
        // rather than in a second test (see the note where that test used to live). Round 1 is what
        // the FIRST hold pays if nothing preloaded; round 2 is what every hold pays afterwards, so
        // the difference is the wait the preload moves off the hold path.
        //
        // Still no assertion, for this test's stated reason: which rounds succeeded is a property
        // of the machine. An absent round is reported as absent, never silently treated as zero.
        match (ms.first().copied().flatten(), ms.get(1).copied().flatten()) {
            (Some(cold), Some(warm)) => eprintln!(
                "PRELOAD SAVES: {:7.1} ms  (cold {cold:.1} ms → warm {warm:.1} ms)",
                cold - warm
            ),
            _ => eprintln!(
                "PRELOAD SAVES: unknown — a round failed above, so there is no cold/warm pair"
            ),
        }
    }

    /// A stand-in for the only two `DictationSession` fields the arm decision reads, so a whole
    /// start/stop interleaving can be driven deterministically — no AppHandle, no 631MB download, no
    /// threads. Every method mirrors exactly what the real command does to those fields inside its
    /// locked critical sections; the point is to pin the SEQUENCES, which `start_after_load`'s own
    /// unit tests (single decisions, hand-picked inputs) can't express.
    ///
    /// This matters more than it used to. `start_dictation` is now an `async fn` whose model load
    /// runs on a blocking thread, so the event loop stays live throughout: a stop_dictation, or a
    /// second start_dictation, can genuinely land mid-load. Before, both were sync commands running
    /// inline on the main thread, so they serialized and these interleavings were unreachable.
    #[derive(Default)]
    struct Guards {
        stop_epoch: u64,
        armed: bool,
        /// Mirrors `DictationSession::start_in_flight`: the epoch sampled by the start currently
        /// loading, so duplicate fan-out starts can be collapsed onto it.
        start_in_flight: Option<u64>,
        /// Model loads actually launched. The fan-out bug was invisible to the old harness because
        /// it never counted the WORK a decision commits to — only which decision came out.
        loads_started: u32,
    }

    impl Guards {
        /// `start_dictation`'s first critical section. `None` = no load runs (either the armed fast
        /// path or a coalesced duplicate); `Some(epoch)` = the sampled stop epoch, carried across
        /// the slow load.
        fn begin_start(&mut self) -> Option<u64> {
            match begin_start_decision(self.armed, self.stop_epoch, self.start_in_flight) {
                BeginStart::FastPathArmed | BeginStart::CoalesceWithInFlight => None,
                BeginStart::Load(epoch) => {
                    self.start_in_flight = Some(epoch);
                    self.loads_started += 1;
                    Some(epoch)
                }
            }
        }

        /// `stop_dictation`: disarm AND advance the epoch — but only when there is something to
        /// stop, so a broadcast mute doesn't advance the epoch once per open window.
        fn stop(&mut self) {
            // Mirrors the real command: "a start that could still arm", NOT "a start exists".
            let start_could_still_arm = self.start_in_flight == Some(self.stop_epoch);
            if stop_is_noop(self.armed, false, self.armed, start_could_still_arm) {
                return;
            }
            self.armed = false;
            self.stop_epoch = self.stop_epoch.wrapping_add(1);
        }

        /// `start_dictation`'s second critical section, once its load returns.
        fn finish_start(&mut self, sampled: u64) -> StartAfterLoad {
            // Release the in-flight claim only if it's still OURS: a newer start may have replaced
            // it while we loaded, and clearing that would let yet another duplicate start a load.
            if self.start_in_flight == Some(sampled) {
                self.start_in_flight = None;
            }
            let decision = start_after_load(sampled, self.stop_epoch, self.armed);
            if decision == StartAfterLoad::Arm {
                self.armed = true;
            }
            decision
        }
    }

    /// Two rapid mic clicks. B's first critical section runs while A is still loading and A hasn't
    /// armed yet, so B does not take the fast path — but B sampled the SAME epoch as A, so it is the
    /// same user intent arriving twice and it now COALESCES onto A's load instead of queuing a second
    /// one. A alone arms, for both.
    ///
    /// This test used to assert the opposite (that B loaded too). That was the behaviour behind the
    /// 2026-07-26 lockout: with ~10 windows open, one toggle queued ~18 model loads on a blocking
    /// pool already saturated by running agents, and they drained one at a time over 3.5 minutes.
    #[test]
    fn two_concurrent_starts_load_once_and_arm_exactly_once() {
        let mut g = Guards::default();
        let a = g.begin_start().expect("nothing armed yet, so A loads");
        assert_eq!(
            g.begin_start(),
            None,
            "B sampled A's epoch — same intent, so it must coalesce rather than load again"
        );
        assert_eq!(g.loads_started, 1, "exactly one model load for one intent");

        assert_eq!(g.finish_start(a), StartAfterLoad::Arm, "A arms on behalf of both");
        assert!(g.armed, "and the session ends armed exactly once");

        // The AlreadyArmed guard is now defence-in-depth rather than a routine outcome (coalescing
        // stops two same-epoch loads existing at all), so pin it directly: if a second load ever does
        // land on an armed session, it must discard its transcriber, never overwrite a live one.
        assert_eq!(
            start_after_load(a, g.stop_epoch, true),
            StartAfterLoad::AlreadyArmed,
            "a late duplicate must not overwrite the live transcriber without finalize()"
        );
    }

    /// The amplifier behind the incident: every open window runs its own `enabled` effect, so ONE
    /// mute broadcasts N `stop_dictation` calls (observed in clusters of 3-6 within 0-8ms). Each used
    /// to advance the single app-global epoch, so one mute could invalidate in-flight starts N times.
    /// One mute must move the epoch exactly once.
    #[test]
    fn a_mute_broadcast_to_every_window_advances_the_epoch_once() {
        let mut g = Guards::default();
        let a = g.begin_start().expect("armed by the user's unmute");
        assert_eq!(g.finish_start(a), StartAfterLoad::Arm);
        let before = g.stop_epoch;

        for _ in 0..8 {
            g.stop(); // eight windows, one broadcast mute
        }

        assert_eq!(
            g.stop_epoch,
            before + 1,
            "one mute = one epoch advance, however many windows relayed it"
        );
        assert!(!g.armed, "and the mic is genuinely muted");
    }

    /// The same broadcast, but landing DURING a model load — the case the fix is actually about, and
    /// the one the armed-session test above cannot reach.
    ///
    /// Nothing clears the in-flight claim until the load returns, so a bare "a start exists" test
    /// stays true for the whole load and every one of the N stops would keep advancing the epoch.
    /// See `stop_is_noop` for the invariant that makes the stops after the first genuine no-ops.
    #[test]
    fn a_mute_broadcast_during_a_load_also_advances_the_epoch_once() {
        let mut g = Guards::default();
        let a = g.begin_start().expect("a load is in flight");
        let before = g.stop_epoch;

        for _ in 0..8 {
            g.stop(); // eight windows relay one mute, mid-download
        }

        assert_eq!(
            g.stop_epoch,
            before + 1,
            "one mute during a load must still advance the epoch exactly once"
        );
        // The doomed start must still be doomed — de-amplifying must not reopen the resurrect race.
        assert_eq!(g.finish_start(a), StartAfterLoad::AbortMutedDuringLoad);
        assert!(!g.armed, "the mic the user muted must stay muted");
    }

    /// Interleaved fan-out: windows relay the mute and the re-arm interleaved (stop, start, stop,
    /// start, …) rather than as two clean bursts.
    ///
    /// KNOWN LIMITATION, asserted rather than described: this still costs one load per window,
    /// because each stop/start pair genuinely moves the epoch and the next window's start therefore
    /// reads a newer intent. Deduplicating it needs the frontend to stop relaying one user action
    /// from N windows (single-owner mic intent) — a larger change, tracked as the follow-up. The
    /// count is pinned so neither a regression toward the original incident shape nor a future fix
    /// that improves it can pass silently.
    ///
    /// What the incident was actually about DOES hold here: the mic is never left dead.
    #[test]
    fn interleaved_stop_start_fan_out_still_ends_armed() {
        const WINDOWS: usize = 8;
        let mut g = Guards::default();
        let a = g.begin_start().expect("a load is already in flight when the mute arrives");

        let mut sampled = vec![a];
        for _ in 0..WINDOWS {
            g.stop();
            if let Some(e) = g.begin_start() {
                sampled.push(e);
            }
        }

        assert_eq!(
            g.loads_started as usize,
            WINDOWS + 1,
            "known limitation: interleaved fan-out still costs one load per window"
        );

        // Every stale claim aborts; the last one standing is the live intent and must arm. Landing
        // them oldest-first is the order a saturated blocking pool actually produces.
        let live = *sampled.last().expect("at least one load ran");
        for epoch in sampled.iter().copied().filter(|e| *e != live) {
            assert_eq!(
                g.finish_start(epoch),
                StartAfterLoad::AbortMutedDuringLoad,
                "a stale claim must never arm"
            );
        }
        assert_eq!(g.finish_start(live), StartAfterLoad::Arm);
        assert!(g.armed, "no lockout: the user's re-arm wins even interleaved");
    }

    /// The 2026-07-26 lockout, end to end: eight windows, unmute → mute → unmute. The user's final
    /// intent is ON, so the mic MUST end armed — and the whole sequence must cost two model loads
    /// (one per real intent), not sixteen.
    ///
    /// Before the fix this sequence queued a load per window per toggle, and the mid-sequence mute
    /// advanced the epoch eight times, leaving every queued load dead on arrival: 18 consecutive
    /// `start_dictation aborted` lines over 3.5 minutes with the mic ring still claiming to listen.
    #[test]
    fn the_multi_window_mic_lockout_does_not_recur() {
        const WINDOWS: usize = 8;
        let mut g = Guards::default();

        let first: Vec<u64> = (0..WINDOWS).filter_map(|_| g.begin_start()).collect();
        for _ in 0..WINDOWS {
            g.stop();
        }
        let second: Vec<u64> = (0..WINDOWS).filter_map(|_| g.begin_start()).collect();

        assert_eq!(first.len(), 1, "the first unmute loads once, not once per window");
        assert_eq!(second.len(), 1, "and so does the second");
        assert_eq!(g.loads_started, 2, "two real intents = two loads, not {WINDOWS} * 2");
        // Asserted alongside the load count because they can diverge: the epoch is the state that
        // DECIDES the work, so counting loads alone can look correct while it still over-advances.
        assert_eq!(g.stop_epoch, 1, "the single mute advanced the epoch exactly once");

        // Both loads land, stale one first — the order the saturated pool actually produced.
        assert_eq!(
            g.finish_start(first[0]),
            StartAfterLoad::AbortMutedDuringLoad,
            "the pre-mute load is stale and must not resurrect the mic"
        );
        assert_eq!(g.finish_start(second[0]), StartAfterLoad::Arm);
        assert!(g.armed, "the user's final intent was ON — the mic must be live");
    }

    /// The load-bearing half of `stop_is_noop`: a mute landing DURING a model load must still bump
    /// the epoch. At that moment `armed` is false and nothing is installed yet, so dropping the
    /// `start_in_flight` term would make the stop look like a no-op, skip the bump, and let the load
    /// resurrect a mic the user just muted.
    #[test]
    fn a_mute_during_a_load_is_never_treated_as_a_no_op() {
        assert!(
            !stop_is_noop(false, false, false, true),
            "a start is in flight — this stop has something to cancel"
        );
        assert!(
            stop_is_noop(false, false, false, false),
            "nothing live and nothing loading: genuinely nothing to stop"
        );

        // And end to end: the mic must stay muted.
        let mut g = Guards::default();
        let a = g.begin_start().expect("not armed, so we load");
        g.stop();
        assert_eq!(g.finish_start(a), StartAfterLoad::AbortMutedDuringLoad);
        assert!(!g.armed, "the resurrect race must stay closed");
    }

    /// The freeze bug's own scenario, now that it can actually happen: fresh install → first click
    /// starts a minutes-long download → the user, seeing "nothing happening", clicks the mic off.
    /// The load must not resurrect the mic they just muted.
    #[test]
    fn a_stop_during_the_load_leaves_the_mic_muted() {
        let mut g = Guards::default();
        let a = g.begin_start().expect("fresh install: not armed, so we load");
        g.stop(); // user unclicks the mic mid-download
        assert_eq!(g.finish_start(a), StartAfterLoad::AbortMutedDuringLoad);
        assert!(!g.armed, "the mic must stay muted — this is the resurrect race");
    }

    /// start → stop → start, with the two loads finishing in EITHER order (nothing orders them:
    /// they're independent blocking tasks). Exactly one arm must win, it must be the live one, and
    /// the session must end armed either way.
    #[test]
    fn start_stop_start_arms_once_whichever_load_finishes_first() {
        for b_finishes_first in [false, true] {
            let mut g = Guards::default();
            let a = g.begin_start().expect("first click loads");
            g.stop(); // user mutes...
            let b = g.begin_start().expect("...then clicks again; still not armed, so B loads");
            assert_ne!(a, b, "B sampled AFTER the stop, so it carries a newer epoch");

            let (first, second) = if b_finishes_first { (b, a) } else { (a, b) };
            let decisions = [g.finish_start(first), g.finish_start(second)];

            // A is always stale (it sampled before the stop) and must abort no matter when it lands;
            // B is current and takes the clean arm.
            let expected = if b_finishes_first {
                [StartAfterLoad::Arm, StartAfterLoad::AbortMutedDuringLoad]
            } else {
                [StartAfterLoad::AbortMutedDuringLoad, StartAfterLoad::Arm]
            };
            assert_eq!(decisions, expected, "b_finishes_first={b_finishes_first}");
            assert_eq!(
                decisions.iter().filter(|d| **d == StartAfterLoad::Arm).count(),
                1,
                "exactly one arm, whatever the order"
            );
            assert!(g.armed, "the user's second click wins: the mic ends armed");
        }
    }

    /// Once armed, a start takes the fast path: no epoch sampled, no load, no cloud-Arc swap — just
    /// refresh focus + reconcile. Pins that a second window mounting can never re-download the model
    /// or drop a live transcriber.
    #[test]
    fn an_armed_session_takes_the_fast_path_and_never_reloads() {
        let mut g = Guards::default();
        let a = g.begin_start().unwrap();
        g.finish_start(a);
        assert!(g.armed);

        assert_eq!(g.begin_start(), None, "already armed → fast path, no model load");
        // ...and a stop re-opens the slow path for the next click.
        g.stop();
        assert!(g.begin_start().is_some(), "after a stop, the next start loads again");
    }

    #[test]
    fn choose_engine_requires_setting_signed_in_and_credits() {
        // Cloud only when ALL three hold.
        assert_eq!(choose_engine(true, true, true), Engine::Cloud);
        // Any one missing → fall back to the on-device model.
        assert_eq!(choose_engine(false, true, true), Engine::Local, "setting off");
        assert_eq!(choose_engine(true, false, true), Engine::Local, "signed out (no bearer)");
        assert_eq!(choose_engine(true, true, false), Engine::Local, "no credits");
        assert_eq!(choose_engine(false, false, false), Engine::Local);
    }

    /// Serializes the tests that touch the process-global `INTERIM_SEQ`. Rust runs unit tests on
    /// parallel threads by default, so two of them advancing one atomic would interleave.
    static SEQ_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn the_very_first_interim_is_always_logged() {
        // THE POINT OF THE WHOLE LINE. The bug that motivated it (bead sparkle-phdw2) presents as
        // "no interims reached the webview", and the only thing that can distinguish that from
        // "interims flowed but nothing painted them" is evidence that at least ONE was emitted.
        // A sample that skipped the first would go silent on exactly the short/aborted sessions
        // someone is reading the log to understand.
        assert!(should_log_interim(0), "the first interim must always be logged");
    }

    #[test]
    fn interims_are_sampled_rather_than_logged_every_time() {
        // Interims arrive several times a second; logging each would swamp the file and push the
        // `emit partial` lines beside them out of any practical tail. So the ones BETWEEN samples
        // must stay silent — this is the half that keeps the line cheap enough to ship enabled.
        for n in 1..INTERIM_LOG_EVERY {
            assert!(!should_log_interim(n), "interim {n} must not log");
        }
        assert!(should_log_interim(INTERIM_LOG_EVERY), "the sample boundary must log");
        assert!(should_log_interim(INTERIM_LOG_EVERY * 7), "sampling must keep going");
        assert!(
            !should_log_interim(INTERIM_LOG_EVERY * 7 + 1),
            "…and still stay quiet between samples late in a session"
        );
    }

    #[test]
    fn a_new_dictation_attempt_restarts_the_interim_sampling() {
        // THE HALF `should_log_interim` CANNOT SEE, and the one that makes the log line worth
        // shipping. "The first interim always logs" is only true per-ATTEMPT if the counter goes
        // back to zero when an attempt begins; with a process-lifetime counter, the app's very
        // first interim gets a line and then a later push-to-talk hold producing a handful of
        // interims logs NOTHING — precisely the intermittent attempt someone reads the log to
        // understand. `start_cloud_stream` calls the reset on every passive→active edge.
        //
        // Serialized against the other counter test via SEQ_LOCK: these share one process-global
        // atomic, and vitest-style parallel test threads would otherwise interleave the two and
        // make both flaky.
        let _g = SEQ_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        reset_interim_log_sampling();
        assert_eq!(next_interim_index(), 0, "a fresh attempt starts at 0");
        // Burn past the first sample boundary, so a missing reset would be visible below.
        for _ in 0..INTERIM_LOG_EVERY {
            next_interim_index();
        }
        assert!(next_interim_index() > 0, "the counter really did advance");

        reset_interim_log_sampling();
        let first_of_next_attempt = next_interim_index();
        assert_eq!(first_of_next_attempt, 0, "a NEW attempt must start at 0 again");
        assert!(
            should_log_interim(first_of_next_attempt),
            "…so the new attempt logs its own first interim",
        );
    }

    #[test]
    fn identical_text_yields_identical_fingerprint() {
        // The duplicate diagnosis relies on this: the same emitted segment must
        // produce the same fingerprint so "backend emitted twice" is visible in the log.
        assert_eq!(segment_fingerprint("hello world"), segment_fingerprint("hello world"));
    }

    #[test]
    fn different_text_yields_different_fingerprint() {
        // Distinct phrases should (overwhelmingly) differ, so non-duplicates aren't
        // misread as duplicates.
        assert_ne!(segment_fingerprint("turn left"), segment_fingerprint("turn right"));
    }

    #[test]
    fn fingerprint_is_fixed_width_regardless_of_input_size() {
        // Privacy guard: the logged fingerprint must be a fixed-size digest that cannot
        // grow to embed the transcript. A one-word phrase and a long paragraph must both
        // render to exactly 8 lowercase-hex chars — proving the output carries no more
        // information as the input grows. (This is a property that fails if someone later
        // logs the text or a length-proportional value instead.)
        let short = format!("{:08x}", segment_fingerprint("hi"));
        let long = format!("{:08x}", segment_fingerprint(&"word ".repeat(200)));
        for fp in [&short, &long] {
            assert_eq!(fp.len(), 8, "fingerprint must be fixed 8-hex width");
            assert!(fp.chars().all(|c| c.is_ascii_hexdigit()), "fingerprint must be hex-only");
        }
    }
