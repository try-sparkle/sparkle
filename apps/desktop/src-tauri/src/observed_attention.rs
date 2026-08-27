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
use crate::support::pattern;
use regex::Regex;

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
    /// DELEGATED WORK IS VISIBLE ON THE GRID — subagents are running, so this agent is ACTIVE.
    ///
    /// The founder's rule, verbatim: "DELEGATED WORK COUNTS AS ACTIVITY. If liveness derives only
    /// from the parent's own tool calls or hook events, an agent that fans out goes gray precisely
    /// when it is most productive." Two states must both read green — working WITH subagents live,
    /// and BLOCKED WAITING on them — and the second is the one that was missed, because from the
    /// parent's own PTY it looks exactly like doing nothing: no spinner, no output, for minutes.
    ///
    /// For a MOUNTED pane the app already answers this (`engine/workerRollup.withBackgroundTaskGreen`
    /// off `services/backgroundTaskRegistry`). This verdict is the complement and nothing more: the
    /// overlay that consumes it skips any agent with a live writer, so this covers exactly the rows
    /// nobody has opened — the case this module exists for.
    ///
    /// STRICTLY SUBORDINATE TO EVERY OTHER VERDICT, by construction: it is produced ONLY from the
    /// arm where `write_refusal` returned `None`, i.e. we read the grid and there is no prompt, no
    /// credential box, no foreign full-screen app and no running-turn marker. So it can never mask
    /// an `awaiting`, and a consumer may treat it as "green if this row is otherwise gray" without
    /// re-deriving that ordering. See `delegated_work_visible` for why it is NOT produced
    /// from the `Working` arm, which sits ABOVE the prompt gates.
    Delegating,
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
            Verdict::Delegating => "delegating",
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

// ── DELEGATED WORK ON THE GRID (the founder's "it has many sub agents working" report) ──────────
//
// TWO SURFACES, BOTH DRAWN BY CLAUDE CODE ITSELF, ported from the TypeScript readers so the two
// languages answer this question the same way. `apps/desktop/shared/delegated-work.fixture.json`
// is what holds them together: every screen in it is classified by BOTH halves, and the Rust test
// at the bottom of this file and `engine/delegatedWorkFixture.test.ts` assert the SAME partition.
// Without that, this is the shape AGENTS.md records as measured: two halves built in parallel
// against a frozen list, both suites green, the shipped feature never once running.
//
// ── WHY THIS IS NOT AN ARM OF `nudge_gate::screen_is_working` ────────────────────────────────────
// Because that function is a VETO — it decides whether the nudger may type. A false positive there
// suppresses a nudge AND makes this module report `Calm` for an agent standing at a real prompt.
// That exact regression shipped and was reverted (PR #2465): a spinner remnant in scrollback sat
// inside the bottom-rows window and made a prompt screen read as working. So the delegated-work
// reading lives HERE, on the attention side only, where its worst case is a green row rather than
// a swallowed prompt — and it is consulted only after every prompt gate has already declined.

// Claude Code's live-background-task footer. Mirrors TS `backgroundTaskFooter.BACKGROUND_TASK_FOOTER`.
// `tasks?` covers the singular and plural forms; `live` is required, which is what keeps this off
// the FOREGROUND "Running 1 shell command…" status line. Digits are bounded so a pathological run
// cannot backtrack. TS spells the leading guard `(?<!\d)`; Rust's regex crate has no lookbehind, and
// `\b` is exactly equivalent here — inside `13` there is no word boundary before the `3`, so the
// match still starts at the `1`.
//
// THE COUNT MUST BE STRICTLY POSITIVE, which is why the digits are spelled `0*[1-9][0-9]{0,3}`
// rather than `\d{1,4}`. TS parses the number and normalises `0` to `null` — "0 background tasks
// live" is not live work — so a plain `\d` port would call that screen delegating while the TS
// reader called it idle. A one-character divergence, and the shared fixture carries the screen that
// would catch it.
pattern!(
    background_task_footer,
    r"(?i)\b0*[1-9][0-9]{0,3}\s+background\s+tasks?\s+live\b"
);

// One row of Claude Code's live subagent roster: `◯ <kind>  <label>  <elapsed>`. Byte-for-byte the
// TS `claudeCodeScreen.BACKGROUND_TASK_ROW`. The ELAPSED SUFFIX is what makes the row structural
// rather than lexical — a document can quote a bullet glyph, but a live clock at the end of a
// gutter-glyph line is Claude Code's own.
pattern!(background_task_row, r"^\s*◯\s+\S.*\d+m\s*\d+s\s*$");

// ── THE WRAPPED STATUS BAR, PORTED FROM `claudeCodeScreen.chromeBarTailBelow` ────────────────────
//
// `nothing_unrecognized_below` is strictly LINE-ANCHORED, and on a narrow grid Claude Code's chrome
// does not arrive on one line: at 12 columns `  ⏸ manual mode on · ? for shortcuts` renders as three
// rows and only the FIRST carries a glyph the walk recognises (roborev 64464, High). Requiring that
// walk alone under the background-task footer therefore rejects a REAL narrow pane with subagents
// running (roborev 68275, High) — so the footer accepts EITHER the walk or this rejoined-tail test.
//
// WHAT KEEPS IT FROM ACCEPTING A DOCUMENT: the rows below are REJOINED (Ink split one logical bar
// across them) and the JOIN must OPEN with one of Claude's own bar phrases. "The tail contains one
// of Claude's phrases" is a weaker claim that a quoting document can satisfy; "the tail IS the bar"
// is what the anchor buys. `  ⏸ manual` + `mode on · ?` + `for shortcuts` rejoins to a line these
// recognise, while a paragraph about the footer opens with its own prose and does not.
//
// PORTED, so it can drift. `the_chrome_bar_catalogue_has_not_drifted_from_typescript` reads
// `engine/claudeCodeScreen.ts` and fails if an entry is added, removed or reworded there.

/// TS `claudeCodeScreen.BAR_GLYPHS` — the glyphs Claude Code actually OPENS a status bar with, as
/// escapes rather than literals for the reason that file gives: these are bytes we RECOGNIZE, not
/// bytes we render.
///
/// ⚠️ A STRICT SUBSET OF `STATUS_GLYPHS`, AND THAT IS THE POINT (roborev 68289, High). The wider
/// class contains ordinary text bullets — `●` `✓` `✗` `◆` `✻` — and the permission-mode bar is
/// purely STRUCTURAL, so together they accept any tail opening with a bullet and ≤29 letters ending
/// in ` on`: `✓ all tests pass on main`. In the TS scoring heuristic that costs one family; HERE it
/// would be the sole gate on a promotion that LATCHES, since a static pane quoting the footer has
/// nothing that could ever scroll the line away.
const BAR_GLYPHS: &str = "\\u{26a0}\\u{23f8}\\u{23f5}\\u{23f4}\\u{25b6}";

/// TS `MAX_NARROW_CHROME_ROWS`.
const MAX_NARROW_CHROME_ROWS: usize = 12;

/// TS `MAX_BAR_CHARS`. How long ONE logical status bar may be, rejoined from however many rows it
/// wrapped across.
///
/// ⚠️ THIS BOUNDS ONE BAR, NOT THE WHOLE TAIL (roborev 68308, High). The previous constant bounded
/// the entire rejoined tail at 64 and justified it with "the longest bar is 48 characters". Both
/// halves were wrong: the TS fixture's own catalogue of things only Claude Code draws OPENS with a
/// 74-character bar, and `MAX_NARROW_CHROME_ROWS` is 12 precisely because "there are two of them",
/// so a legitimate two-bar tail rejoins to ~150. Both errors point toward a false NEGATIVE, and a
/// false negative on THIS path is the founder's bug on the surface that works with no pane open:
/// the row goes gray while its subagents are listed on it.
///
/// No whole-tail number can work — two stacked real bars rejoin LONGER than the bar-plus-prose
/// document the bound exists to reject — so the tail is segmented per logical bar.
const MAX_BAR_CHARS: usize = 96;

pattern!(rule_line, r"^\s*[─━═]{8,}\s*$");
pattern!(box_bottom, r"^\s*[╰└][─━═]{6,}[╯┘]\s*$");

/// TS `claudeCodeScreen.BAR_OPENS_STRICT` — `CHROME_BAR`'s five phrases, re-anchored onto the BAR
/// glyphs only. One combined alternation rather than five accessors: nothing here needs to know
/// WHICH bar matched, and the drift test below pins the individual sources against the TS file.
fn chrome_bar_opens() -> &'static Regex {
    static CELL: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    CELL.get_or_init(|| {
        let g = BAR_GLYPHS;
        let alts = [
            r"\?\s+for shortcuts\b".to_string(),
            // TS `PERMISSION_MODE_BAR` — matched by SHAPE rather than by mode name, so it covers
            // the modes the two old literals missed.
            format!(r"[{g}][{g}]?\s+[a-z][a-z ]{{1,28}}\son\b"),
            r"\btranscript saving is off\b".to_string(),
            r"\bclaude is using your computer\b".to_string(),
            r"\bpaste again to expand\b".to_string(),
        ];
        Regex::new(&format!(r"(?i)^[\s{g}]*(?:{})", alts.join("|")))
            .expect("static pattern must compile")
    })
}

/// Is everything below `idx` the wrapped remainder of Claude's own status bar, or nothing at all?
fn chrome_bar_tail_below(all: &[&str], idx: usize) -> bool {
    let mut below: Vec<&str> = Vec::new();
    for l in all.iter().skip(idx + 1) {
        let t = l.trim();
        if t.is_empty() {
            continue;
        }
        if below.len() >= MAX_NARROW_CHROME_ROWS {
            return false;
        }
        below.push(t);
    }
    // Nothing below, or only rules: the footer still terminates the grid. Neither is a document.
    if below.is_empty() {
        return true;
    }
    let is_rule = |l: &str| rule_line().is_match(l) || box_bottom().is_match(l);
    if below.iter().all(|l| is_rule(l)) {
        return true;
    }
    // A divider between the footer and the bar is skipped first (roborev 64501): a leading rule is
    // already accepted on its own, so letting one push the bar out of the anchor's reach would
    // answer false on a screen a rules-only tail would have kept.
    let first = below.iter().position(|l| !is_rule(l)).unwrap_or(0);
    every_row_is_chrome_bar(&below[first..])
}

/// Does this row START a new logical status bar — i.e. open with one of Claude's bar glyphs?
///
/// ⚠️ SEGMENT ON THE GLYPH, NOT ON `chrome_bar_opens`. The obvious rule — "a new bar begins wherever
/// a row matches the anchor" — is WRONG: the WRAP pushes the words the anchor needs onto the next
/// row, so the first row of a wrapped `▶▶ bypass` / `permissions on` matches nothing on its own.
/// That is exactly why the original code joined before testing. The glyph survives the wrap.
fn bar_starts() -> &'static Regex {
    static CELL: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    CELL.get_or_init(|| {
        Regex::new(&format!(r"^\s*[{}]", BAR_GLYPHS)).expect("static pattern must compile")
    })
}

/// A continuation row that is PROSE rather than the rest of a wrapped bar.
///
/// Length alone cannot separate them: the document case rejoins to ~85 characters while a single
/// REAL bar reaches 74, and no threshold fits in an 11-character gap. Sentence shape does: no
/// captured bar ends in a full stop, and a wrapped fragment never does. The word count keeps a
/// terse fragment that merely ends in `.` from reading as prose.
fn looks_like_prose(line: &str) -> bool {
    line.trim_end().ends_with('.') && line.split_whitespace().count() >= 5
}

/// TS `everyRowIsChromeBar`. Split the tail into logical bars; every one must BE a bar.
fn every_row_is_chrome_bar(rows: &[&str]) -> bool {
    if rows.is_empty() {
        return true;
    }
    let mut segments: Vec<Vec<&str>> = Vec::new();
    for row in rows {
        if segments.is_empty() || bar_starts().is_match(row) {
            segments.push(vec![row]);
        } else {
            segments
                .last_mut()
                .expect("segments is non-empty here")
                .push(row);
        }
    }
    segments.iter().all(|seg| {
        if seg.iter().skip(1).any(|l| looks_like_prose(l)) {
            return false;
        }
        let join = seg.join(" ");
        join.chars().count() <= MAX_BAR_CHARS && chrome_bar_opens().is_match(&join)
    })
}

/// Is DELEGATED WORK visible on this rendered grid — either of Claude Code's two surfaces?
///
/// 1. the `N background task(s) live [ctrl+b to manage]` footer — work Claude has BACKGROUNDED;
/// 2. the `◯ <kind>  <label>  <elapsed>` roster — subagents running right now. This roster REPLACES
///    the composer box, so a screen showing it has no other sign of life on it at all, which is
///    precisely why the parent looks idle while it is blocked waiting on its fan-out.
///
/// ── BOTH SURFACES ARE POSITION-CHECKED ──────────────────────────────────────────────────────────
/// A bare row match alone would be a lexical test, and the bead describing this feature reproduces
/// `◯ general-purpose  Concierge agents as clickable rows  21m 55s` verbatim — so a pager showing
/// that document, or this file, trips the pattern. Claude's roster is always the LAST thing drawn
/// while it is live, so the last matching row must TERMINATE the grid
/// (`nudge_gate::nothing_unrecognized_below`, the same walk the dialog families use). The TS reader
/// applies the identical rule and the shared fixture pins them together.
///
/// ── BOTH SURFACES ARE POSITION-CHECKED, AND THE FOOTER'S EXEMPTION DID NOT SURVIVE REVIEW ──────
/// The footer was briefly exempted on the argument that `N background tasks live` is far less
/// likely to appear in quoted prose than a bullet row. That argument was falsified by the very
/// commit that made it (roborev 68247): the exact bytes now sit in this repo's shared fixture and
/// in `engine/backgroundTaskFooter.ts`'s header, so an agent reading either file ends its turn with
/// the phrase on screen. Both surfaces now take the LAST match and require it to terminate the
/// grid, and `parseBackgroundTaskCount` was changed in the same commit so the two cannot drift.
pub fn delegated_work_visible(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    let all: Vec<&str> = nudge_gate::lines(text).collect();
    // The footer, BOTTOM-ANCHORED like the roster below it. It was exempted at first on the
    // argument that its wording is far less quotable than a bullet row — and the commit that added
    // this reader made that false in the same breath (roborev 68247, High): the exact bytes
    // `3 background tasks live [ctrl+b to manage]` now sit in the shared fixture AND in
    // `engine/backgroundTaskFooter.ts`'s own header, two files an agent routinely `cat`s.
    //
    // Unchecked, that is a LATCH rather than a blip. The quoted line stays on a static viewport, no
    // prompt is present so every gate declines, and the row this promotes has no mounted writer to
    // correct it — green forever for an agent doing nothing, which is exactly what the roster's
    // walk exists to prevent. Claude's real footer TERMINATES the grid; a quoted one has prose
    // under it.
    if let Some(i) = all
        .iter()
        .rposition(|l| background_task_footer().is_match(l))
    {
        // EITHER shape of "terminates the grid". The line-anchored walk alone is a narrow-pane
        // false negative (roborev 68275) — see `chrome_bar_tail_below` directly above.
        if nudge_gate::nothing_unrecognized_below(&all, i) || chrome_bar_tail_below(&all, i) {
            return true;
        }
    }
    // Walk from the BOTTOM to the last roster row, exactly as TS `backgroundTaskRowCount` does: the
    // first row found from below is the end of the live list, and everything under it must be
    // recognised chrome or the list is a quoted one.
    match all.iter().rposition(|l| background_task_row().is_match(l)) {
        // EITHER shape of "terminates the grid", exactly as the footer arm above requires — and for
        // the same reason, in the SAME pane at the SAME width (roborev 68289, High). The
        // line-anchored walk cannot see Claude's Ink-wrapped status bar, and a roster commonly
        // appears with NO footer under it to fall back on, so requiring the walk alone left a narrow
        // pane's row gray with its subagents visibly listed on the grid.
        Some(i) => {
            nudge_gate::nothing_unrecognized_below(&all, i) || chrome_bar_tail_below(&all, i)
        }
        None => false,
    }
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
/// ```text
/// Select an option:
/// 1) Continue
/// 2) Abort
/// ```
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
        // The gate found nothing to refuse: the grid was read and carries no prompt.
        //
        // THIS IS THE ONLY ARM THAT MAY REPORT `Delegating`, and the placement is the safety
        // argument. Reaching here means every gate above declined: not the alternate buffer, not a
        // running-turn marker, not a credential box, not a picker, not a live-region question. So
        // promoting a grid that ALSO shows subagents cannot mask a prompt — there is provably none.
        //
        // In particular it is NOT reported from the `Working` arm, which sits ABOVE the credential
        // and prompt gates: a false `Working` (a spinner remnant in scrollback) would there turn a
        // screen with a real prompt on it GREEN. That is the regression PR #2465 reverted, one
        // layer down, and this ordering is what keeps it from coming back through the colour.
        None => {
            if delegated_work_visible(text) {
                Verdict::Delegating
            } else {
                // A POSITIVE reading — the verdict that says "fine".
                Verdict::Calm
            }
        }
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
///
/// `async` DELIBERATELY, even though the body is one mutex read. A SYNC `#[tauri::command]` runs
/// its body INLINE on the AppKit main thread, so it freezes the whole UI for its duration —
/// `cmd_timing`'s `every_tauri_command_is_async_or_explicitly_exempt` guard fails on any sync
/// command not in its debt list, and that list's own header is explicit that it is "SYNC-COMMAND
/// DEBT, NOT A LIST OF APPROVALS": adding a NEW name is adding new debt, and converting is the fix.
/// A cheap body is not a reason to stay sync — `frontend_log` was cheap too, at 90-145K invokes a
/// day, and sat unguarded on the main thread (bead sparkle-rfhu5).
#[tauri::command]
pub async fn observed_attention(
    state: tauri::State<'_, ObservedAttentionState>,
) -> Result<Vec<ObservedAttention>, ()> {
    Ok(state.list())
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
                "delegating" => Verdict::Delegating,
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

    /// THE ONSET CONTRACT, ASSERTED IN THE MODULE THAT OWNS IT.
    ///
    /// `only_a_changed_verdict_is_emitted` cannot cover this: it asserts `.is_none()`, which stays
    /// true whether or not the unchanged branch refreshes the stored stamp. So re-adding an
    /// `at_ms` refresh on that path — the exact regression roborev 67212 caught, where `list()`
    /// carries as-of while the event stream carries onset — used to leave this whole suite green,
    /// with the only guard living across the seam in `nudger.rs`. That is the filtered-run trap
    /// this branch already paid for once, mirrored to the other side (roborev 67283).
    ///
    /// Both directions are pinned, because "the stamp did not move" alone would also pass for a
    /// `record` that had stopped storing anything at all.
    #[test]
    fn an_unchanged_reading_keeps_the_onset_stamp_and_a_changed_one_moves_it() {
        let state = ObservedAttentionState::default();
        state.record(reading("a1", Verdict::Calm, false, 1_000));
        assert_eq!(state.list()[0].at_ms, 1_000);

        assert!(state
            .record(reading("a1", Verdict::Calm, false, 2_000))
            .is_none());
        assert_eq!(
            state.list()[0].at_ms,
            1_000,
            "an unchanged reading must not refresh onset — the seed and the event stream must agree"
        );

        assert!(state
            .record(reading("a1", Verdict::Awaiting, false, 3_000))
            .is_some());
        assert_eq!(
            state.list()[0].at_ms,
            3_000,
            "a CHANGED verdict must restamp, or 'how long has it been awaiting' is unanswerable"
        );
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

    // ── DELEGATED WORK: THE CROSS-LANGUAGE CONTRACT ─────────────────────────────────────────────
    //
    // These read `apps/desktop/shared/delegated-work.fixture.json`, and so does
    // `apps/desktop/src/engine/delegatedWorkFixture.test.ts`. One file, two suites: a matcher that
    // drifts in EITHER language reds one of them, which is the only structure that stops the two
    // halves from silently agreeing to disagree (AGENTS.md's measured incident).

    fn delegated_fixture() -> serde_json::Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("shared")
            .join("delegated-work.fixture.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        serde_json::from_str(&raw).expect("fixture is valid JSON")
    }

    /// (screen text, expected `delegating`, why) for every screen in the shared fixture.
    fn delegated_screens() -> Vec<(String, bool, String)> {
        delegated_fixture()["screens"]
            .as_array()
            .expect("fixture has a screens array")
            .iter()
            .map(|s| {
                let text = s["lines"]
                    .as_array()
                    .expect("screen has a lines array")
                    .iter()
                    .map(|l| l.as_str().expect("line is a string"))
                    .collect::<Vec<_>>()
                    .join("\n");
                (
                    text,
                    s["delegating"].as_bool().expect("screen has `delegating`"),
                    s["why"].as_str().unwrap_or("").to_string(),
                )
            })
            .collect()
    }

    /// THE PARTITION IS DERIVED, NOT RESTATED. Listing which screens are delegating and asserting
    /// that list is the vacuous shape AGENTS.md calls the #1 fleet-wide finding — it passes with the
    /// matcher deleted. This asks the matcher and compares, and the two guards below make BOTH
    /// directions of drift red: a fixture with no delegating screens (so a matcher stuck on `false`
    /// would pass) or none idle (so one stuck on `true` would).
    #[test]
    fn the_matcher_agrees_with_every_screen_in_the_shared_fixture() {
        let screens = delegated_screens();
        assert!(
            screens.iter().any(|(_, want, _)| *want),
            "fixture carries no DELEGATING screen — a matcher that always returned false would pass"
        );
        assert!(
            screens.iter().any(|(_, want, _)| !*want),
            "fixture carries no IDLE screen — a matcher that always returned true would pass"
        );
        for (text, want, why) in &screens {
            assert_eq!(
                delegated_work_visible(text),
                *want,
                "delegated_work_visible disagreed with apps/desktop/shared/delegated-work.fixture.json\n\
                 screen: {why}\n---\n{text}\n---"
            );
        }
    }

    /// THE WIRING, not just the matcher: a delegating grid must reach the WIRE as `delegating`.
    /// Without this the matcher could be perfect and `classify` still report `calm`, which is the
    /// state this whole change exists to leave behind — and every other test here would stay green.
    #[test]
    fn a_delegating_grid_classifies_as_delegating_and_an_idle_one_does_not() {
        for (text, want, why) in delegated_screens() {
            let verdict = classify(&text, false, false);
            if want {
                assert_eq!(
                    verdict,
                    Verdict::Delegating,
                    "a grid showing live delegated work must not be reported as {}: {why}",
                    verdict.as_str()
                );
            } else {
                assert_ne!(
                    verdict,
                    Verdict::Delegating,
                    "a grid with no live delegated work was reported as delegating: {why}"
                );
            }
        }
    }

    /// A PROMPT OUTRANKS DELEGATED WORK, and this is the arm that keeps the new verdict from ever
    /// costing the founder a red row. The same roster is on screen either way; the difference is a
    /// question underneath it. Reporting `delegating` here would paint an agent that is BLOCKED ON A
    /// HUMAN green — the exact invisible-green state this module was written to remove.
    #[test]
    fn a_prompt_beneath_a_live_roster_is_still_awaiting() {
        let with_prompt = "⏺ main\n  ◯ general-purpose  Draining findings  3m 04s\n\n\
             Do you want to proceed?\n❯ 1. Yes\n  2. No\n  3. No, and tell Claude what to do differently";
        assert_eq!(
            classify(with_prompt, false, false),
            Verdict::Awaiting,
            "a prompt must outrank delegated work — otherwise a blocked agent renders green"
        );
    }

    /// AND A PARKED READER STILL WINS. `unreadable` means the grid is arbitrarily stale, so a roster
    /// on it proves nothing about NOW. Ordering this after the parked check is what stops a frozen
    /// screenshot of a finished fan-out from holding a row green forever.
    #[test]
    fn a_parked_reader_outranks_delegated_work() {
        let roster = "⏺ main\n  ◯ general-purpose  Draining findings  3m 04s";
        assert_eq!(classify(roster, false, false), Verdict::Delegating);
        assert_eq!(
            classify(roster, false, true),
            Verdict::Unreadable,
            "a parked PTY reader means the grid is stale — no claim may be made from it"
        );
    }

    /// The token is the wire. A rename here is a silent no-op on every consumer that switches on it.
    #[test]
    fn the_delegating_token_is_the_one_the_wire_carries() {
        assert_eq!(Verdict::Delegating.as_str(), "delegating");
        assert_eq!(
            serde_json::to_value(Verdict::Delegating).expect("serializes"),
            serde_json::json!("delegating")
        );
    }

    /// THE PORTED CHROME-BAR CATALOGUE MUST NOT DRIFT FROM `engine/claudeCodeScreen.ts`.
    ///
    /// The Rust copy exists only because the mount-independent reader cannot call the TypeScript
    /// one. A phrase added, removed or reworded on the TS side and not here means the two readers
    /// disagree about the same narrow pane — one keeps the row green, the other lets it go gray —
    /// and nothing else in either suite can see it. Pinned by SOURCE TEXT, the same technique
    /// `nudge_gate::ported_typescript_patterns_have_not_drifted` uses.
    #[test]
    fn the_chrome_bar_catalogue_has_not_drifted_from_typescript() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("src")
            .join("engine")
            .join("claudeCodeScreen.ts");
        let ts = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        for needle in [
            r"/\?\s+for shortcuts\b/i,",
            r"/\btranscript saving is off\b/i,",
            r"/\bclaude is using your computer\b/i,",
            r"/\bpaste again to expand\b/i,",
            // The SHAPE pattern, which subsumes the mode literals it replaced.
            r"[a-z][a-z ]{1,28}\\son\\b",
            // The glyph class, which the anchoring depends on.
            // The STRICT glyph class this module anchors on, and the fact that the tail test uses
            // it rather than the wider one. Either edit on the TS side silently widens that gate.
            r#"const BAR_GLYPHS = "\\u26a0\\u23f8\\u23f5\\u23f4\\u25b6";"#,
            // THE SEGMENTATION RULE itself, not just its members. A whole-tail bound could never
            // fit both a two-bar tail (~150 chars) and the bar-plus-prose document (~85), so
            // collapsing this back to one join is the defect, and it must red here (roborev 68308).
            "return [...join].length <= MAX_BAR_CHARS && matchesAny(BAR_OPENS_STRICT, join);",
            // The per-segment PROSE guard. Length alone cannot reject the document case, so
            // deleting this leaves the bound intact and the gate wrong.
            "if (seg.slice(1).some(looksLikeProse)) return false;",
            // SEGMENT ON THE GLYPH. Segmenting on the anchor instead silently breaks every WRAPPED
            // bar, because the wrap pushes the anchor's words onto the next row.
            "if (segments.length === 0 || BAR_STARTS.test(row)) segments.push([row]);",
            // The BOUND and its value, pinning the WHOLE declaration so a flag/value edit reds.
            "const MAX_BAR_CHARS = 96;",
            // THE SPLIT THAT KEEPS FAMILY F STRICT. `hasBackgroundTaskList` gates a WRITE, so its
            // default must stay the line-anchored walk; only the attention reader passes the looser
            // test. Deleting the parameter would leave every literal above intact.
            //
            // Re-pointed for bead sparkle-gihgml: the split used to be an opaque `terminates`
            // callback and is now a NAMED strictness parameter, so what is pinned is the name, the
            // SAFE DEFAULT, and the one call that opts out of it. All three are needed — pinning
            // only the declaration would let the default be flipped to the lenient value in place,
            // which is the widening this port exists to notice.
            r#"type ScreenEvidenceUse ="#,
            r#"use: ScreenEvidenceUse = "authorize-keystrokes","#,
            r#"use === "colour-only""#,
            // …and that the LOOSER reading stays confined to the attention reader. A second caller
            // passing "colour-only" is the exact regression: colour is cheap, the write gate is not.
            r#"return backgroundTaskRowCount(snapshot.split("\n"), "colour-only");"#,
        ] {
            assert!(
                ts.contains(needle),
                "claudeCodeScreen.ts changed something this module ported: {needle}\n\
                 Port the change into observed_attention.rs rather than editing this expectation."
            );
        }
        // …and the count, so an ADDED bar cannot slip through the per-literal loop above.
        let entries = ts
            .split("const CHROME_BAR: RegExp[] = [")
            .nth(1)
            .expect("CHROME_BAR array not found")
            .split("];")
            .next()
            .expect("CHROME_BAR array not closed")
            .lines()
            .filter(|l| {
                let t = l.trim();
                !t.is_empty() && !t.starts_with("//") && !t.starts_with("*")
            })
            .count();
        assert_eq!(
            entries, 5,
            "CHROME_BAR gained or lost an entry — mirror it in `chrome_bar_opens` in the SAME commit"
        );
    }

    /// The wrapped narrow-pane bar is the case the strict walk cannot see, so assert BOTH halves:
    /// the walk rejects it (which is why the second arm exists) and the rejoined test accepts it.
    #[test]
    fn a_wrapped_status_bar_is_accepted_only_by_the_rejoined_tail() {
        let all = ["3 background tasks live [ctrl+b to manage]", "  ⏸ manual", "mode on · ?", "for shortcuts"];
        assert!(
            !nudge_gate::nothing_unrecognized_below(&all, 0),
            "if the line-anchored walk ever accepts this, the second arm is untested — and a test \
             that cannot fail is worse than no test"
        );
        assert!(chrome_bar_tail_below(&all, 0));
        assert!(delegated_work_visible(&all.join("\n")));
    }

    /// …and the anchor is what keeps a DOCUMENT out. A tail that merely CONTAINS one of Claude's
    /// phrases is prose; one that OPENS with it is the bar.
    #[test]
    fn a_tail_that_merely_mentions_a_bar_phrase_is_still_a_document() {
        let quoting = [
            "3 background tasks live [ctrl+b to manage]",
            "The status bar reads ? for shortcuts, which is Claude's own chrome and",
            "is quoted here so the matcher can be tested against it.",
        ];
        assert!(!chrome_bar_tail_below(&quoting, 0));
        assert!(!delegated_work_visible(&quoting.join("\n")));
    }

    /// THE WHOLE TAIL IS ACCOUNTED FOR, not only its opening (roborev 68294, High). A document that
    /// opens its tail with a REAL bar and then keeps going cleared the anchor, because everything
    /// after the opening was joined and never examined again.
    #[test]
    fn a_tail_that_opens_with_a_real_bar_and_keeps_going_is_still_a_document() {
        let bar_only = ["⏸ manual mode on · ? for shortcuts"];
        assert!(
            chrome_bar_tail_below(&["x", bar_only[0]], 0),
            "the bar alone must still be accepted, or this test proves nothing about the tail"
        );
        let bar_then_prose = [
            "  ◯ general-purpose  Draining roborev findings  3m 04s",
            "⏸ manual mode on · ? for shortcuts",
            "and the row must go green while that is on screen.",
        ];
        assert!(!chrome_bar_tail_below(&bar_then_prose, 0));
        assert!(!delegated_work_visible(&bar_then_prose.join("\n")));
    }

    /// The bound is a claim about how long ONE bar can be, so pin it against the LONGEST bar this
    /// repo has actually captured — not the shortest one that happened to be quoted.
    ///
    /// ⚠️ THE OLD VERSION OF THIS TEST IS WHY THE DEFECT SHIPPED. It measured
    /// `Claude is using your computer · press Esc to stop` (49 chars) and pronounced the bound safe,
    /// while `capturedScreens.fixture.ts` opened its catalogue with a 74-character bar that the
    /// bound REJECTED. A test that picks its own witness cannot falsify the claim it is guarding.
    #[test]
    fn the_bound_admits_the_longest_captured_bar_and_is_not_unbounded() {
        // The real maximum, verbatim from NON_PICKER_HINT_LINES_2_1_220[0].
        let longest = "▶▶ bypass permissions on (shift+tab to cycle) · PR #730 · esc to interrupt";
        assert_eq!(longest.chars().count(), 74, "the captured maximum moved; re-measure the bound");
        assert!(
            longest.chars().count() <= MAX_BAR_CHARS,
            "the longest captured bar ({} chars) no longer fits MAX_BAR_CHARS ({})",
            longest.chars().count(),
            MAX_BAR_CHARS
        );
        assert!(chrome_bar_tail_below(&["x", longest], 0));
        // TWO of them, which MAX_NARROW_CHROME_ROWS's own comment says is the real shape.
        assert!(chrome_bar_tail_below(&["x", longest, "⏸ manual mode on · ? for shortcuts"], 0));
        // And the WRAP, which is the entire reason this loose arm exists.
        assert!(chrome_bar_tail_below(
            &["x", "▶▶ bypass", "permissions on", "(shift+tab to", "cycle) · PR", "#730 · esc to", "interrupt"],
            0
        ));
        assert!(
            MAX_BAR_CHARS < 128,
            "an effectively unbounded segment is the defect this constant exists to close"
        );
    }
}
