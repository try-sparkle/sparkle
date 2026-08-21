// observed_attention — A ROW'S COLOUR MUST NOT DEPEND ON SOMEONE HAVING LOOKED AT IT.
//
// ── THE BUG, IN THE FOUNDER'S WORDS ─────────────────────────────────────────────────────────────
// "it was green when I first clicked on it… I guess it turned red AFTER I clicked". That is not a
// colour bug. `runtimeStore.status` — the map the row colour reads — has exactly ONE continuous
// writer, `components/AgentPane.tsx`, and both of ITS inputs (the screen scraper and the hook-log
// watcher) are constructed inside the mounted pane. Panes mount LAZILY, per project, only once the
// user has visited that project this session. So for an agent nobody has opened, the colour is a
// FROZEN LAST READING with no writer that can ever move it — and `engine/movementRetraction.ts:12`
// says so in those words. The trigger is MOUNT, not focus: `engine/attention.ts` reads
// `windowFocused` only to suppress the OS banner, and its docstring notes the row recolour "always
// happens". Clicking the row did not turn it red; clicking the row created the writer that could.
//
// Green rather than gray because green is the LATCHED case: a hook stream that dies MID-TURN leaves
// `lastHook` frozen at `working` with no contradiction possible. Gray is the never-written case.
// Three fail-closed pierces already exist for exactly this shape (`errored`, `session-limit-picker`,
// `tool-approval-prompt`), each added after the founder found the same invisible-green state wearing
// a different dialog. This is the fourth sighting, and the first fix aimed at the writer rather than
// at one more dialog.
//
// ── WHY HERE ────────────────────────────────────────────────────────────────────────────────────
// `nudger.rs` already feeds a headless `vt100` parser off the PTY bytes for EVERY session and ticks
// once a second over all of them — its header: "neither requires the frontend to be alive". That
// loop is the writer the frontend cannot supply, so the verdict is emitted from there. This module
// is the PURE half, split out so the classification is assertable without a PTY, an `AppHandle`, or
// a clock — the same split `nudge_ladder` has from `nudger`.
//
// ── THREE VERDICTS, AND THE BOUNDARY BETWEEN THEM IS THE WHOLE POINT ─────────────────────────────
// The wire shape is frozen in `apps/desktop/shared/observed-attention.fixture.json`, which the test
// at the bottom of this file parses and the TypeScript parser parses too — one file, two suites, so
// the halves fail TOGETHER rather than silently agreeing to disagree.
//
//   awaiting   a human is owed an answer; the grid carries a prompt the classifier recognises.
//   unreadable WE COULD NOT TELL. Not "calm". Reporting an unreadable screen as calm is the bug.
//   calm       the grid was read and carries no prompt. A POSITIVE reading, not an absence.
//
// ── THIS MODULE'S RULE IS THE OPPOSITE OF THE LADDER'S, DELIBERATELY ────────────────────────────
// `nudge_ladder::stalled_on_a_prompt` EXCLUDES `alternate-screen` — "a full-screen app is exited and
// an unreadable grid recovers, so both can clear without a human and neither justifies a flag". That
// governs whether the NUDGER MAY TYPE. This governs whether the HUMAN IS TOLD. Different questions
// with opposite correct answers: nothing may be typed at a screen we cannot read, and precisely
// because we cannot read it we must not claim the agent is fine. Do NOT "fix" one to match the
// other — reuse `stalled_on_a_prompt` here and the founder's bug comes straight back.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde::Serialize;

use crate::nudge_gate;

/// The event name. MUST match `OBSERVED_ATTENTION_EVENT` in
/// `apps/desktop/src/services/observedAttentionListener.ts` and the `event` key of
/// `apps/desktop/shared/observed-attention.fixture.json`; the test below pins it to the fixture.
pub const OBSERVED_ATTENTION_EVENT: &str = "attention://observed";

/// What the grid said about whether a human is owed an answer.
///
/// Serialized lowercase, and every arm is a value the wire can carry — there is no `Unknown` that
/// means "we did not run", because not running produces no event at all. `unreadable` is the
/// explicit "we looked and could not tell", which is a reading, not an absence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Awaiting,
    Unreadable,
    Calm,
    /// THIS AGENT'S TERMINAL IS GONE — discard any reading you hold for it.
    ///
    /// Not a statement about a screen; there is no screen. It exists because the producer emits on
    /// CHANGE, and "the agent stopped existing" is a change the other three verdicts cannot carry.
    /// Without it a consumer that was seeded once keeps the last verdict forever for an agent whose
    /// PTY has been swept — so a `spin_down`ed agent whose final reading was `awaiting` stays RAISED
    /// against a terminal that no longer exists, with nothing on the wire that could retract it.
    /// That is a latched reading with no writer that can move it: precisely the bug in this module's
    /// header, reintroduced one layer up (roborev 67180).
    Gone,
}

impl Verdict {
    /// Stable lowercase token — the same bytes serde emits, for logs and for the fixture test.
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Awaiting => "awaiting",
            Verdict::Unreadable => "unreadable",
            Verdict::Calm => "calm",
            Verdict::Gone => "gone",
        }
    }
}

/// One agent's reading, as it crosses the wire.
///
/// NO OPTIONAL FIELDS, DELIBERATELY. A Rust `Option::None` crosses as `null`, never as an absent
/// key, and TypeScript's `field?: T` means `T | undefined` — which does not include `null`. A
/// parser written against the optional shape describes bytes this side cannot produce, and an
/// all-or-nothing parser that rejects one field discards the WHOLE payload and falls back to its
/// "we did not look" default, silently and permanently. Every field here is unconditionally
/// present so that trap has nowhere to live. A new field owes a value in every fixture sample.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedAttention {
    pub agent_id: String,
    pub verdict: Verdict,
    /// Travels ALONGSIDE the verdict rather than folded into it: "Claude Code is on the alternate
    /// buffer showing its own picker" is `awaiting` WITH `alternate: true`, and the consumer must
    /// not have to re-derive that from the verdict alone.
    pub alternate: bool,
    pub at_ms: u64,
}

/// Read one rendered grid.
///
/// Pure on purpose — `(text, alternate, reader_parked)` are plain values, so every branch is
/// assertable from a string literal with no PTY, no `AppHandle` and no clock.
///
/// ── IT DELEGATES TO `write_refusal` RATHER THAN RESTATING ITS GATES ─────────────────────────────
/// This function used to re-implement the gate's checks in the gate's order, with a comment
/// claiming the two "mirror" each other. They did not: `write_refusal` ends with a LIVE-REGION scan
/// for `menu_line`/`question_opener` that the copy dropped, so a plain numbered menu with no
/// selection cursor and no footer bar —
///
///     Select an option:
///     1) Continue
///     2) Abort
///
/// — was `AwaitingInput` to the gate and `Calm` here. That is the founder's invisible-green state
/// re-created inside the module written to remove it, and no test could see it because both halves
/// of the copy agreed with each other (roborev 67180).
///
/// So the mirroring is now STRUCTURAL. There is one matcher, and this maps its verdict onto the
/// three attention states. The `match` is exhaustive over `Refusal`, so a new arm in the gate is a
/// COMPILE ERROR here rather than a silent `Calm` — which is the property the prose version could
/// never have.
pub fn classify(text: &str, alternate: bool, reader_parked: bool) -> Verdict {
    // THE ONE CHECK THAT IS NOT THE GATE'S, because the gate cannot see it: the PTY reader is
    // PARKED, so this observer is not being fed and the grid is arbitrarily stale. The two
    // backpressure gates sit UPSTREAM of `read()`, so while a session is flow-controlled the child
    // can be producing furiously and we see none of it. A stale grid can show a clean prompt while
    // the live one shows a picker — "we could not tell", and not hypothetical for the case this
    // feature serves, because a wedged WebView is what latches those gates in the first place.
    if reader_parked {
        return Verdict::Unreadable;
    }
    let screen = nudge_gate::Screen { text, alternate };
    match nudge_gate::write_refusal(Some(&screen)) {
        // WE COULD NOT READ IT. A foreign full-screen app owns the buffer (the carve-out for Claude
        // Code holding it is inside `write_refusal`), or there is no viewport at all.
        Some(nudge_gate::Refusal::NoViewport) | Some(nudge_gate::Refusal::AlternateScreen) => {
            Verdict::Unreadable
        }
        // A TURN IS RUNNING — the one positive proof nobody is owed an answer yet.
        Some(nudge_gate::Refusal::Working) => Verdict::Calm,
        // A PROMPT IS ON SCREEN. A credential prompt counts: it echoes nothing, so it is the state
        // a human is most stuck in and least able to see from a row.
        Some(nudge_gate::Refusal::CredentialPrompt) => Verdict::Awaiting,
        // ⚠️ `AwaitingInput` IS RE-CONFIRMED AGAINST THE WHOLE-SCREEN PREDICATES, and this is the
        // ONE place this module deliberately does NOT inherit the gate's answer.
        //
        // TWO REVIEWS PULL IN OPPOSITE DIRECTIONS HERE AND BOTH ARE RIGHT ABOUT THEIR OWN COST.
        // roborev 67180 said a hand-written copy that omitted `write_refusal`'s final live-region
        // arm (`menu_line`/`question_opener`) missed a real prompt — true, and that is why this
        // delegates at all. roborev 67212 then observed that the SAME arm's false positives are
        // inverted for this consumer — also true, and it is the more expensive direction.
        //
        // `nudge_gate` documents the asymmetry itself: it widens the match because "the same false
        // positive costs one skipped nudge". Here it costs a RED row, and `waiting` is inside
        // `attention.needsAttention`, so it also costs a dock badge and an OS banner for an agent
        // that is owed nothing. On a screen with no `rule_line`, `live_region` degrades to the last
        // few non-empty rows, and `menu_line` matches an ordinary numbered summary — `1. Fixed the
        // parser` — so a shell agent that just finished would page the founder. He has complained
        // about exactly that class of false red six times in one day ("Why are all these agents
        // red? They don't seem to need anything from me").
        //
        // So: the gate decides UNREADABLE and WORKING, and a prompt must additionally satisfy one
        // of the bottom-anchored whole-screen predicates. Those are the arms whose false-positive
        // profile `nudge_gate` describes as bottom-anchored "by construction"; the live-region arm
        // is the one written for a different cost model. A prompt missed here is still caught by the
        // pane's own classifier the moment anyone opens it, which is the pre-existing behaviour —
        // a false red has no such backstop.
        Some(nudge_gate::Refusal::AwaitingInput) => {
            if nudge_gate::screen_awaits_input(text) {
                Verdict::Awaiting
            } else {
                Verdict::Calm
            }
        }
        // The gate found nothing to refuse: the grid was read and carries no prompt. A POSITIVE
        // reading — the only verdict that says "fine".
        None => Verdict::Calm,
    }
}

/// The last verdict emitted per agent, so the tick emits on CHANGE rather than once a second per
/// session.
///
/// ── WHY A PULL COMMAND EXISTS BESIDE THE EVENT ──────────────────────────────────────────────────
/// Emitting only on change means a listener that starts LATE has never seen a verdict — and the
/// frontend starts late by construction, every launch and every reload. The event is the
/// optimisation; `observed_attention` (the command) is the channel, and the listener calls it once
/// on startup to seed itself. This is the shape `nudger.rs` already uses for its flags, and its
/// header says the same thing: the event is "an optimisation on top, not the channel".
#[derive(Default)]
pub struct ObservedAttentionState(Mutex<HashMap<String, ObservedAttention>>);

impl ObservedAttentionState {
    /// Record a fresh reading. Returns the payload to emit ONLY when it differs from the last one
    /// for this agent — an unchanged verdict is not news and must not wake the frontend.
    pub fn record(&self, next: ObservedAttention) -> Option<ObservedAttention> {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let unchanged = map
            .get(&next.agent_id)
            .is_some_and(|prev| prev.verdict == next.verdict && prev.alternate == next.alternate);
        if unchanged {
            // ⚠️ `at_ms` IS THE ONSET OF THE CURRENT VERDICT, and the stored row is deliberately
            // LEFT ALONE so the seed and the event stream agree.
            //
            // It was briefly refreshed here, to make it mean AS-OF. That made the two channels
            // disagree: `list()` (the startup seed) carried as-of while the event stream — how
            // every consumer learns anything after startup — still carried onset, because an
            // unchanged reading emits nothing. The same agent's `at_ms` then meant different things
            // depending on whether the frontend had been seeded or streamed, with nothing on the
            // wire to tell them apart (roborev 67212).
            //
            // Onset is the meaning that is expressible on BOTH channels without re-emitting once a
            // second, and it is the more useful one: "how long has this agent been waiting" is a
            // question a row can ask. The hazard it carries — that a naive freshness rule would
            // discard the longest-waiting row first — is handled by the frozen contract stating
            // that NO VERDICT EXPIRES ON THE CONSUMER'S CLOCK, rather than by a timestamp trick.
            return None;
        }
        map.insert(next.agent_id.clone(), next.clone());
        Some(next)
    }

    /// Every agent's current reading. What the command returns and the listener seeds from.
    pub fn list(&self) -> Vec<ObservedAttention> {
        let map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let mut out: Vec<ObservedAttention> = map.values().cloned().collect();
        out.sort_by(|a, b| a.agent_id.cmp(&b.agent_id));
        out
    }

    /// Forget agents whose PTY is gone, so a long session does not accumulate dead rows — and so a
    /// verdict cannot outlive the terminal it described.
    /// Returns the `Gone` payloads the caller must EMIT — one per agent dropped. A silent prune
    /// leaves every consumer holding a verdict for a terminal that no longer exists, which is why
    /// this returns work rather than nothing (see `Verdict::Gone`).
    pub fn sweep(&self, live: &HashSet<&str>, at_ms: u64) -> Vec<ObservedAttention> {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let dead: Vec<String> = map
            .keys()
            .filter(|id| !live.contains(id.as_str()))
            .cloned()
            .collect();
        for id in &dead {
            map.remove(id);
        }
        dead.into_iter()
            .map(|agent_id| ObservedAttention {
                agent_id,
                verdict: Verdict::Gone,
                alternate: false,
                at_ms,
            })
            .collect()
    }
}

/// Every agent's current attention reading.
///
/// The frontend calls this once when its listener starts, because the event only fires on change.
#[tauri::command]
pub fn observed_attention(
    state: tauri::State<ObservedAttentionState>,
) -> Vec<ObservedAttention> {
    state.list()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ══ THE SHARED WIRE FIXTURE ═════════════════════════════════════════════════════════════════
    // The file these tests read is parsed by the TypeScript suite too
    // (`src/services/observedAttentionListener.wire.test.ts`). A drift on either side reds BOTH.

    fn fixture() -> serde_json::Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("shared")
            .join("observed-attention.fixture.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        serde_json::from_str(&raw).expect("fixture is valid JSON")
    }

    fn samples() -> Vec<serde_json::Value> {
        fixture()["samples"]
            .as_array()
            .expect("fixture has a samples array")
            .clone()
    }

    /// The event name is not a string this module gets to choose alone — it is the wire, so it is
    /// pinned to the fixture that both halves read.
    #[test]
    fn the_event_name_matches_the_shared_fixture() {
        assert_eq!(
            fixture()["event"].as_str(),
            Some(OBSERVED_ATTENTION_EVENT),
            "event name drifted from apps/desktop/shared/observed-attention.fixture.json"
        );
    }

    /// THE PRODUCER HALF OF THE CONTRACT: serializing this struct yields EXACTLY the fixture bytes.
    ///
    /// Asserts on the serialized VALUE, not on the struct's fields — a test that rebuilt the struct
    /// from the fixture and compared it to itself would pass with serde renaming everything wrong.
    /// The TypeScript suite asserts the mirror: that its parser ACCEPTS these same bytes.
    #[test]
    fn the_serializer_produces_the_fixture_bytes() {
        let samples = samples();
        assert!(
            !samples.is_empty(),
            "fixture has no samples — this test would pass vacuously"
        );
        for sample in &samples {
            let payload = &sample["payload"];
            let verdict = match payload["verdict"].as_str().expect("sample has a verdict") {
                "awaiting" => Verdict::Awaiting,
                "unreadable" => Verdict::Unreadable,
                "calm" => Verdict::Calm,
                "gone" => Verdict::Gone,
                other => panic!("fixture carries a verdict this enum cannot produce: {other}"),
            };
            let built = ObservedAttention {
                agent_id: payload["agentId"].as_str().expect("agentId").to_string(),
                verdict,
                alternate: payload["alternate"].as_bool().expect("alternate"),
                at_ms: payload["atMs"].as_u64().expect("atMs"),
            };
            let produced = serde_json::to_value(&built).expect("serializes");
            assert_eq!(
                &produced, payload,
                "serializer drifted from apps/desktop/shared/observed-attention.fixture.json \
                 (sample: {})",
                sample["why"]
            );
        }
    }

    /// EVERY field must be present in the produced bytes — the `Option::None` → `null` vs `field?:`
    /// trap is prevented by there being no optional field at all, and this is what keeps it that
    /// way when someone adds one.
    #[test]
    fn no_field_is_ever_absent_from_the_wire() {
        let produced = serde_json::to_value(ObservedAttention {
            agent_id: "a1".into(),
            verdict: Verdict::Calm,
            alternate: false,
            at_ms: 1,
        })
        .expect("serializes");
        let keys: HashSet<&str> = produced
            .as_object()
            .expect("object")
            .keys()
            .map(|k| k.as_str())
            .collect();
        let expected: HashSet<&str> = ["agentId", "verdict", "alternate", "atMs"].into();
        assert_eq!(
            keys, expected,
            "the wire's key set changed; update the fixture's samples in the SAME commit"
        );
    }

    /// The fixture must exercise every verdict, or the producer test above proves less than it
    /// looks like it proves.
    #[test]
    fn the_fixture_covers_every_verdict() {
        let seen: HashSet<String> = samples()
            .iter()
            .filter_map(|s| s["payload"]["verdict"].as_str().map(str::to_string))
            .collect();
        for v in [Verdict::Awaiting, Verdict::Unreadable, Verdict::Calm, Verdict::Gone] {
            assert!(
                seen.contains(v.as_str()),
                "fixture never exercises the `{}` verdict",
                v.as_str()
            );
        }
    }

    // ══ THE CLASSIFIER ══════════════════════════════════════════════════════════════════════════

    /// A prompt on the NORMAL buffer is the classic case the founder's row rendered green for.
    #[test]
    fn a_prompt_on_the_normal_buffer_is_awaiting() {
        let screen = "Do you want to proceed?\n❯ 1. Yes\n  2. No";
        assert_eq!(classify(screen, false, false), Verdict::Awaiting);
    }

    /// A full-screen app we cannot parse is UNREADABLE — never calm. This is the assertion the
    /// whole feature exists for: the previous behaviour had no verdict here at all, and an agent
    /// nobody could see rendered as fine.
    #[test]
    fn a_foreign_full_screen_app_is_unreadable_not_calm() {
        let vim = "~\n~\n~\n\"file.txt\" 12L, 340B";
        assert_eq!(classify(vim, true, false), Verdict::Unreadable);
        assert_ne!(classify(vim, true, false), Verdict::Calm);
    }

    /// …but Claude Code holding the alternate buffer is READABLE, and a picker there is a real
    /// claim. Without this carve-out the feature would be blind to the exact agents it serves.
    #[test]
    fn claude_code_on_the_alternate_buffer_still_yields_a_real_verdict() {
        let picker = concat!(
            "Do you want to proceed?\n",
            "❯ 1. Yes\n",
            "  2. No\n",
            "───────────────────────────────────────────\n",
            "> \n",
            "───────────────────────────────────────────\n",
        );
        // Only meaningful if the carve-out actually fires; otherwise this asserts the vim case.
        assert!(
            nudge_gate::looks_like_claude_prompt(picker),
            "fixture screen no longer matches Claude Code's prompt signature"
        );
        assert_eq!(classify(picker, true, false), Verdict::Awaiting);
    }

    /// THE ARM THIS MODULE DELIBERATELY DOES NOT INHERIT (roborev 67180 vs 67212).
    ///
    /// A bare numbered menu with no selection cursor IS a real prompt, and `write_refusal` catches
    /// it via the live-region arm. This module reads it as `calm` anyway, because that arm cannot
    /// tell it apart from a finished agent's numbered summary and the false-red cost here is a
    /// paged human. Pinned so the trade is visible rather than accidental: if someone widens this
    /// back, they should do it knowing what it costs.
    #[test]
    fn a_bare_numbered_menu_is_conceded_to_calm_to_keep_false_reds_out() {
        let menu = "Select an option:\n1) Continue\n2) Abort";
        assert!(
            !nudge_gate::screen_awaits_input(menu),
            "the whole-screen matcher now catches this; the concession below is no longer needed"
        );
        assert_eq!(classify(menu, false, false), Verdict::Calm);
    }

    /// THE FALSE RED THIS MODULE MUST NOT PRODUCE (roborev 67212). `menu_line` matches an ordinary
    /// numbered summary, and on a screen with no rule line `live_region` degrades to the last few
    /// rows — so a shell agent that just FINISHED would otherwise paint red, raise a dock badge and
    /// fire a banner for an agent owed nothing. `waiting` is inside `needsAttention`, so the cost
    /// here is the founder being paged, not a skipped nudge.
    #[test]
    fn a_finished_agents_numbered_summary_is_calm_not_awaiting() {
        let summary = "Done. Changes:\n1. Fixed the parser\n2. Added a test\n3. Updated the docs";
        // Non-vacuity: the gate REALLY does want to refuse this, so this asserts the re-confirmation
        // rather than some other arm quietly not firing.
        assert_eq!(
            nudge_gate::write_refusal(Some(&nudge_gate::Screen { text: summary, alternate: false })),
            Some(nudge_gate::Refusal::AwaitingInput),
            "the gate no longer refuses this; pick a screen only the live-region arm catches"
        );
        assert_eq!(classify(summary, false, false), Verdict::Calm);
    }

    /// The prose half of the same arm — a sign-off that reads like a question.
    #[test]
    fn a_closing_offer_in_prose_is_calm_not_awaiting() {
        let signoff = "All gates clean and the PR is open.\n\nShould I go ahead and merge it?";
        assert_eq!(classify(signoff, false, false), Verdict::Calm);
    }

    /// …and the PAIRED case, or the two tests above would also pass for a classifier that had
    /// stopped detecting prompts altogether — which is the whole feature.
    #[test]
    fn a_real_picker_still_reads_as_awaiting_after_the_narrowing() {
        let picker = "Do you want to proceed?\n❯ 1. Yes\n  2. No";
        assert_eq!(classify(picker, false, false), Verdict::Awaiting);
    }

    /// A PARKED READER is not being fed, so its grid is arbitrarily stale — and a stale grid can
    /// show a clean prompt while the live one shows a picker. Fail closed.
    #[test]
    fn a_parked_reader_is_unreadable_however_calm_its_stale_grid_looks() {
        let calm_looking = "$ ls\nREADME.md  src\n$ ";
        assert_eq!(classify(calm_looking, false, false), Verdict::Calm);
        assert_eq!(classify(calm_looking, false, true), Verdict::Unreadable);
    }

    /// A running turn is the one positive proof nobody is owed an answer yet.
    #[test]
    fn a_working_screen_is_calm() {
        let working = "· Thinking… (12s · esc to interrupt)";
        assert!(
            nudge_gate::screen_is_working(working),
            "fixture screen no longer reads as working"
        );
        assert_eq!(classify(working, false, false), Verdict::Calm);
    }

    /// This module and the ladder MUST disagree about the alternate screen, and that disagreement
    /// is load-bearing rather than an oversight. `stalled_on_a_prompt` excludes `alternate-screen`
    /// so the nudger never TYPES at a screen it cannot read; this module reports it so the human is
    /// TOLD. Someone will eventually try to reconcile them — this test is the argument against it.
    #[test]
    fn the_ladder_stays_silent_on_an_alternate_screen_where_this_module_speaks() {
        let vim = "~\n~\n~\n\"file.txt\" 12L, 340B";
        assert_eq!(classify(vim, true, false), Verdict::Unreadable);
        assert!(
            !crate::nudge_ladder::stalled_on_a_prompt(
                nudge_gate::Refusal::AlternateScreen.as_str()
            ),
            "the ladder started flagging alternate-screen; these two contracts are meant to differ"
        );
    }

    // ══ EMIT-ON-CHANGE ══════════════════════════════════════════════════════════════════════════

    fn reading(id: &str, verdict: Verdict, alternate: bool, at_ms: u64) -> ObservedAttention {
        ObservedAttention {
            agent_id: id.into(),
            verdict,
            alternate,
            at_ms,
        }
    }

    /// Asserts the SIDE EFFECT (what would be emitted), not that the map holds a row: a first
    /// reading is news, an identical one a second later is not, and a changed one is again.
    #[test]
    fn only_a_changed_verdict_is_emitted() {
        let state = ObservedAttentionState::default();
        assert!(
            state
                .record(reading("a1", Verdict::Calm, false, 1_000))
                .is_some(),
            "the first reading for an agent is always news"
        );
        assert!(
            state
                .record(reading("a1", Verdict::Calm, false, 2_000))
                .is_none(),
            "an unchanged verdict must not emit — at_ms moving is not news"
        );
        let changed = state
            .record(reading("a1", Verdict::Awaiting, false, 3_000))
            .expect("a changed verdict emits");
        assert_eq!(changed.verdict, Verdict::Awaiting);
        assert_eq!(changed.at_ms, 3_000);
    }

    /// `alternate` is part of the reading, so flipping it alone is a change the consumer must see.
    #[test]
    fn a_flip_of_alternate_alone_is_a_change() {
        let state = ObservedAttentionState::default();
        state.record(reading("a1", Verdict::Awaiting, false, 1));
        assert!(
            state
                .record(reading("a1", Verdict::Awaiting, true, 2))
                .is_some(),
            "alternate travels alongside the verdict and must not be swallowed"
        );
    }

    /// Two agents do not share a latch.
    #[test]
    fn agents_are_tracked_independently() {
        let state = ObservedAttentionState::default();
        state.record(reading("a1", Verdict::Calm, false, 1));
        assert!(
            state
                .record(reading("a2", Verdict::Calm, false, 1))
                .is_some(),
            "a second agent's first reading is its own news"
        );
        assert_eq!(state.list().len(), 2);
    }

    /// A verdict must not outlive the terminal it described — and the drop must be ANNOUNCED.
    ///
    /// Asserts the RETRACTION PAYLOAD, not merely that the row left the map: a silent prune passes
    /// a "the row is gone" assertion while leaving every consumer holding the stale verdict, which
    /// is the defect this returns work for.
    #[test]
    fn sweeping_emits_a_retraction_for_each_agent_whose_pty_is_gone() {
        let state = ObservedAttentionState::default();
        state.record(reading("a1", Verdict::Awaiting, false, 1));
        state.record(reading("a2", Verdict::Calm, false, 1));
        let live: HashSet<&str> = ["a2"].into();

        let retractions = state.sweep(&live, 9_000);

        assert_eq!(retractions.len(), 1, "exactly one agent was dropped");
        assert_eq!(retractions[0].agent_id, "a1");
        assert_eq!(retractions[0].verdict, Verdict::Gone);
        assert_eq!(retractions[0].at_ms, 9_000);

        let ids: Vec<String> = state.list().into_iter().map(|r| r.agent_id).collect();
        assert_eq!(ids, vec!["a2".to_string()]);
        // …and the swept agent's next reading is news again rather than being deduped against a
        // verdict from a terminal that no longer exists.
        assert!(state
            .record(reading("a1", Verdict::Awaiting, false, 2))
            .is_some());
    }

    /// A sweep that drops nothing must emit nothing — otherwise every tick broadcasts noise.
    #[test]
    fn sweeping_a_fully_live_fleet_emits_nothing() {
        let state = ObservedAttentionState::default();
        state.record(reading("a1", Verdict::Awaiting, false, 1));
        let live: HashSet<&str> = ["a1"].into();
        assert!(state.sweep(&live, 9_000).is_empty());
    }
}
