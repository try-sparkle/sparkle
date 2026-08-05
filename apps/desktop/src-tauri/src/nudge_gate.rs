//! MAY THE NUDGER WRITE A BYTE INTO THIS TERMINAL? — pure, deterministic, no model, ever.
//!
//! ── WHY THIS EXISTS IN RUST AT ALL ────────────────────────────────────────────────────────────
//! This is a deliberate SECOND implementation of a guard that already exists in TypeScript
//! (`voice/dictationTerminalRoute.ts` + `engine/screenClassifier.ts`), and that file's own header
//! argues — correctly — that a copy is the worse option, because "the two lists grew four entries
//! apiece from real misses found in the field, and a copy would have inherited the misses and not
//! the fixes."
//!
//! That argument is sound and it does not apply here, for one reason: the TypeScript guard runs in
//! the WebView. The whole premise of the nudger (bead sparkle-a94sr) is that it must keep working
//! when the WebView is wedged and when every model on earth is returning 529 — the state in which
//! the JS guard, the JS viewport registry, and every agent that could reason about a screen are all
//! simultaneously unavailable. A guard reachable only through the thing that is broken is not a
//! guard. So this is not a copy made out of convenience; it is the same decision made in the one
//! process that is still running.
//!
//! TWO THINGS KEEP IT FROM ROTTING INTO THE COPY THAT MISSED THE FIXES:
//!
//!   1. **It is tested against the SAME corpus, read from the TypeScript source at test time.**
//!      `capturedScreens.fixture.ts` holds real rendered Claude Code viewports; the tests below
//!      parse that file through `CARGO_MANIFEST_DIR` rather than restating its screens here. Add a
//!      screen there and this module is judged on it on the next `cargo test`, with no Rust edit.
//!   2. **The ported pattern literals are pinned against the TypeScript source.**
//!      `ported_typescript_patterns_have_not_drifted` asserts each regex this module transcribed is
//!      still present, verbatim, in the file it came from, and counts the `SHELL_PROMPTS` list so a
//!      newly added arm fails here rather than being silently missing from the port. When it goes
//!      red the fix is to port the change, never to update the expectation.
//!
//! Neither mechanism can prove full behavioural parity — that would need to RUN the TypeScript —
//! and full parity is not the contract anyway. The contract is ASYMMETRIC: this gate may refuse a
//! screen the TS guard would permit, and must never permit one the TS guard would refuse. A false
//! refusal costs one skipped nudge, with another look at most ten minutes later. A false permit
//! types into `vim` or a password field. Every deliberate divergence below is therefore in the
//! refusing direction, and says so where it occurs.
//!
//! ── WHAT IT READS ─────────────────────────────────────────────────────────────────────────────
//! The RENDERED screen, never the raw byte stream and never scrollback. Rust gets a rendered screen
//! by running its own headless VT emulator over the PTY bytes it already owns (see `nudger.rs`) —
//! which is also where the alternate-screen flag comes from. Scrollback is specifically wrong here
//! and the TS side learned it the expensive way (roborev 55170): history latches "a picker was once
//! on screen" true forever, so a guard fed scrollback refuses everything after the session's first
//! `(y/n)` and the feature silently stops working.

use std::sync::OnceLock;

use regex::Regex;

/// A rendered terminal screen, as this module needs to see it.
pub struct Screen<'a> {
    /// The visible grid, one rendered row per `\n`, trailing spaces trimmed.
    pub text: &'a str,
    /// xterm's alternate buffer is active: `vim`, `less`, `htop`, `lazygit`.
    pub alternate: bool,
}

/// Why the nudger did not write. Every arm is a refusal; none is an error.
///
/// These names are LOGGED VERBATIM on every tick (see `nudger.rs`), because the bead's one
/// non-optional requirement is that we can afterwards answer "does nudging actually work" with
/// counts rather than recollection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// The screen could not be read at all. FAIL CLOSED — this is the state in which a clean
    /// prompt and a `vim` session are indistinguishable.
    NoViewport,
    /// A full-screen application owns the terminal, and it is not Claude Code's own prompt.
    AlternateScreen,
    /// A turn is RUNNING. Never interrupt an agent that is producing output.
    Working,
    /// A picker, menu, or `(y/n)` is on screen. Free text aimed at a live picker presses a button
    /// nobody read.
    AwaitingInput,
    /// A password / passphrase / token prompt. These echo NOTHING, so a misrouted write is
    /// invisible as well as wrong.
    CredentialPrompt,
}

impl Refusal {
    /// Stable snake_case token for structured logs and metrics.
    pub fn as_str(self) -> &'static str {
        match self {
            Refusal::NoViewport => "no-viewport",
            Refusal::AlternateScreen => "alternate-screen",
            Refusal::Working => "working",
            Refusal::AwaitingInput => "awaiting-input",
            Refusal::CredentialPrompt => "credential-prompt",
        }
    }
}

/// Compile once. `support.rs` compiles its patterns per call and says so ("we avoid pulling in a
/// lazy-init crate"); that is fine for a support-ticket redaction that runs once, and wrong for a
/// gate that runs per agent per tick forever. `std::sync::OnceLock` is in std, so it costs no
/// dependency.
fn re(cell: &'static OnceLock<Regex>, pattern: &'static str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("nudge_gate pattern must compile"))
}

macro_rules! pattern {
    ($name:ident, $src:expr) => {
        fn $name() -> &'static Regex {
            static CELL: OnceLock<Regex> = OnceLock::new();
            re(&CELL, $src)
        }
    };
}

// ── THE CLAUDE CODE TUI ───────────────────────────────────────────────────────────────────────
// Ported from `engine/screenClassifier.ts`. Where a pattern below differs from its TS original the
// difference is noted and is always in the refusing direction.

// `SELECTION_CURSOR` — the highlighted option of an open menu, e.g. "❯ 1. Yes".
// TS: /^\s*[│|]?\s*[❯›]\s*\d+\.\s/m  — transcribed exactly.
pattern!(selection_cursor, r"(?m)^\s*[│|]?\s*[❯›]\s*\d+\.\s");

// `SHELL_PROMPTS` — classic CLI prompts. TS ships five; all five are here.
pattern!(shell_prompt_yn, r"(?i)[\(\[]y/n[\)\]]");
pattern!(shell_prompt_press_enter, r"(?i)press enter to continue");
pattern!(shell_prompt_overwrite, r"(?i)\boverwrite\?");
pattern!(shell_prompt_password, r"(?im)(^|\s)password:\s*$");
pattern!(shell_prompt_passphrase, r"(?i)enter passphrase");

// `FOOTER_LEGACY` — the pre-2.1.220 literal pairs, kept because they still match older builds.
pattern!(
    footer_legacy,
    r"(?i)enter to (select|confirm|submit)\b.*(navigate|cancel)|\besc to cancel\b.*\bctrl\+e to explain\b"
);

// `FOOTER_BAR` — a picker footer matched BY SHAPE: a line made of nothing but ">= 2" key hints
// separated by "·". Rebuilt rather than transcribed, because the TS form opens with a negative
// lookahead — `(?![^\n\r]*\bto interrupt\b)` — and Rust's `regex` crate has no lookaround by
// design. Splitting the screen into lines in code and testing `to interrupt` separately is exactly
// equivalent and removes the `\r`-framing subtlety the TS version had to be patched for (roborev
// 54749): we split on both `\n` and `\r`, so a hint bar and a spinner redraw in the same chunk can
// never be one "line" here.
const FOOTER_KEY_ATOM: &str = concat!(
    r"(?:(?:ctrl|control|cmd|command|alt|opt|option|shift|meta|fn)\s*\+\s*\w+",
    r"|enter|return|esc(?:ape)?|tab|space(?:bar)?|backspace|del(?:ete)?|home|end",
    r"|pg\s?up|pg\s?dn|page\s?up|page\s?down|up|down|left|right|[↑↓←→]|[a-z0-9])"
);

fn footer_bar() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    CELL.get_or_init(|| {
        let key = format!(r"{a}(?:\s*(?:/|,|\bor\b)\s*{a})*", a = FOOTER_KEY_ATOM);
        let hint = format!(r"{key}\s+to\s+[^·•∙]*[^\s·•∙]");
        let bar = format!(
            r"(?i)^[ \t]*[│|┃]?[ \t]*{hint}(?:[ \t]*[·•∙][ \t]*{hint})+[ \t]*[│|┃]?[ \t]*$"
        );
        Regex::new(&bar).expect("footer_bar must compile")
    })
}

/// The one verb that disqualifies a hint bar. "interrupt" means a turn is RUNNING, which is the
/// opposite of blocked — it marks Claude's always-present status bar, not a menu.
const NOT_A_FOOTER_VERB: &str = "to interrupt";

// ── THE WRITE-BLOCKING PROMPTS ────────────────────────────────────────────────────────────────
// Ported from `voice/dictationTerminalRoute.ts`. Deliberately broad: the bias runs one way here.

// TS `WRITE_BLOCKING_PROMPTS`, all three arms.
pattern!(
    write_block_password_colon,
    r"(?im)\bpass(word|phrase)\b[^\n]*:\s*$"
);
// WIDENED to match the TS pair, in BOTH axes.
//
// SPELLING: the old `\(\s*yes\s*/\s*no` matched only `(yes/no`, leaving `(y/n)` confirmations
// refused by nothing when they scrolled out of the detector's reach.
//
// WHITESPACE: a first cut fixed the spelling and silently dropped the `\s*` classes, which was the
// same hole in the other axis — `screenTail` joins rows with a SPACE, so a hard-wrapped prompt
// arrives as `"(yes /no)"` and an unspaced token matches none of it (roborev 58717).
//
// THREE COPIES OF THIS PATTERN EXIST, deliberately: this one, TS `YN`
// (services/suggestions/heuristics), and TS `YES_NO_PROMPT` (voice/dictationTerminalRoute). The TS
// pair is duplicated rather than shared by import because eight suites mock the heuristics module
// without supplying `YN`, so a module-scope alias reads `undefined` at import time and kills them at
// collection. `suggestions/yesNoAgreement.test.ts` polices the two TS copies against one corpus; the
// two needles in this file's drift test pin both of them for this port. Change one, change all three.
pattern!(
    write_block_yes_no,
    r"(?i)\by\s*/\s*n\b|\byes\s*/\s*no\b"
);
pattern!(write_block_type_yes, r#"(?i)\btype\s+["']?yes["']?\b"#);

// TS `CREDENTIAL_WORD` — broader than "password" on purpose: the hazard is a field that echoes
// nothing, and plenty of those are not spelled password (`gh auth login` asks "Paste your
// authentication token:", which is part of this repo's routine workflow).
pattern!(
    credential_word,
    r"(?i)\b(pass(word|phrase|code)|username|token|otp|one[-\s]?time\s+(code|password)|verification\s+code|2fa|two[-\s]?factor|pin)\b"
);
pattern!(ends_in_colon, r":\s*$");

// ── NUMBERED OPTIONS AND PROSE QUESTIONS ──────────────────────────────────────────────────────
// The bead names these explicitly as gate item 3 ("numbered options, y/n, 'Do you want to'").

// `MENU_LINE` from `services/suggestions/heuristics.ts:22` — "1) x", "2. x", "[3] x", "(4) x".
pattern!(menu_line, r"(?m)^\s*[\[\(]?\d{1,2}[\]\)\.]\s+\S");

// `QUESTION_OPENER` from `services/suggestions/pendingQuestion.ts:29`.
//
// NOTE THE DELIBERATE DIVERGENCE FROM `screenClassifier.ts`, which excludes prose on purpose:
// its header explains that Claude's conversational "Do you want…?" must not flip STATUS red,
// because its permission UI always pairs that text with the ❯ menu that is caught anyway. That
// reasoning is about a tab badge. Here the same false positive costs one skipped nudge and the
// same false NEGATIVE types into a live question, so the bias inverts — which is the identical
// argument `dictationTerminalRoute.ts` makes for being broader than the status classifier.
pattern!(
    question_opener,
    r"(?i)\b(want me to|should i\b|shall i\b|would you like|do you want|ok(?:ay)? to (?:go|proceed|land|push|commit)|ready for me to|which (?:one|of these|approach|option)|let me know (?:if|whether|which))"
);

// ── THE SESSION-LIMIT PICKER ──────────────────────────────────────────────────────────────────
//
// THE ONE SCREEN AT WHICH A MACHINE MAY SEND A KEY THAT `write_refusal` WOULD REFUSE — and the key
// is `Esc`, always and only. See `escape_refusal` below for the gate; this is the recognizer.
//
// Ported from `../src/services/sessionLimitScreen.ts`, which exists so this matcher can be enrolled
// in `ported_typescript_patterns_have_not_drifted` without W-RESUME editing `screenClassifier.ts`.
// That TS module's header carries the full rationale; the parts that constrain THIS code:
//
//   * The three options are account-level BILLING decisions ("Switch to usage credits" moves the
//     user onto paid overage; "Switch to Team plan" changes their subscription). A false positive
//     here means a machine pressed Esc at some OTHER live dialog — cancelling a tool approval a
//     human was mid-answer on. Every rule below therefore fails CLOSED.
//   * `PRD/sparkle/claude-account-identity-truth.md` §6 quotes this screen. Four independent
//     properties keep that block from matching: it renders its cursor as a bare `>` (which
//     `selection_cursor` rejects), its labels carry U+200B inside each keyword, its footer is
//     rewritten so no footer matcher fires, and prose continues beneath it (the bottom-anchor
//     rule). Any ONE of them is sufficient; all four hold.
//
// The trailing `s` in the credits pattern is REQUIRED, not optional: `\b` treats U+200B as a
// non-word character, so a permissive `credits?\b` matches the PRD's de-fanged `credit`+U+200B+`s`.

// TS: /^\s*[│|]?\s*[❯›]?\s*\d+\.\s+stop and wait for (?:the )?limit to reset\b/im
pattern!(
    session_limit_reset_option,
    r"(?im)^\s*[│|]?\s*[❯›]?\s*\d+\.\s+stop and wait for (?:the )?limit to reset\b"
);
// TS: /^\s*[│|]?\s*[❯›]?\s*\d+\.\s+switch to usage credits\b/im
pattern!(
    session_limit_credits_option,
    r"(?im)^\s*[│|]?\s*[❯›]?\s*\d+\.\s+switch to usage credits\b"
);
// TS: /^\s*[│|]?\s*[❯›]?\s*\d+\.\s+switch to team plan\b/im
pattern!(
    session_limit_team_option,
    r"(?im)^\s*[│|]?\s*[❯›]?\s*\d+\.\s+switch to team plan\b"
);

/// TS `MIN_OPTIONS_PRESENT`. The reset option is mandatory on top of this count — see
/// `session_limit_options_present`.
const MIN_OPTIONS_PRESENT: usize = 2;

/// TS `MAX_CHROME_BELOW_FOOTER`. The bottom-anchored rule: a live Ink dialog IS the bottom of the
/// grid, whereas a document quoting it continues underneath.
///
/// THIS WAS ZERO, AND ZERO WAS MEASURED AGAINST THE WRONG SCREENS. The old argument was that all
/// four pickers captured from 2.1.220 end at their footer — but none of those four is the
/// SESSION-LIMIT picker, and when that screen was captured in situ it carried FIVE rows of
/// persistent chrome beneath its footer. A zero-row rule rejects the one screen this gate exists to
/// recognize. Both ports were green because each tested its own fixtures (bead `sparkle-d2i0c`).
///
/// The rule is now "nothing UNRECOGNIZED follows", which keeps the anti-prose property zero was
/// protecting: prose and code fences are not chrome, so a document quoting the screen still fails.
const MAX_CHROME_BELOW_FOOTER: usize = 8;

/// TS `MAX_OPTION_FOOTER_GAP`. How many rendered rows may separate the LAST option row from the
/// footer — what makes "the same rendered frame" precise. Eight, measured: the gap across the four
/// captured 2.1.220 pickers is 2, 2, 2 and 6 (the `/model` picker is the wide one).
const MAX_OPTION_FOOTER_GAP: usize = 8;

fn is_session_limit_option_line(line: &str) -> bool {
    session_limit_reset_option().is_match(line)
        || session_limit_credits_option().is_match(line)
        || session_limit_team_option().is_match(line)
}

/// How many of the three labels this frame carries. Mirrors TS `sessionLimitOptionsPresent`.
fn session_limit_options_present(text: &str) -> usize {
    usize::from(session_limit_reset_option().is_match(text))
        + usize::from(session_limit_credits_option().is_match(text))
        + usize::from(session_limit_team_option().is_match(text))
}

/// Is this rendered line a picker FOOTER? Reuses the two matchers already ported rather than adding
/// raw literals, and applies the same `to interrupt` disqualifier `screen_awaits_input` does — a
/// line carrying it is Claude's always-present status bar, not a menu.
fn is_picker_footer_line(line: &str) -> bool {
    !line.to_ascii_lowercase().contains(NOT_A_FOOTER_VERB)
        && (footer_legacy().is_match(line) || footer_bar().is_match(line))
}

/// Is this row pure SEPARATION — no content — between a dialog's options and its footer?
///
/// Blank, or nothing but box decoration. Border-aware on purpose: every other matcher in this
/// module tolerates a frame (`selection_cursor` carries `[│|]?`, all three label patterns carry it,
/// both footer arms carry `[ \t]*[│|┃]?` on each side), and the classifier's own fixtures pin
/// Claude Code's `╭─ … ─╮` menu as a real screen. A literal `trim().is_empty()` treats the box's
/// spacer row (`│        │`) and its bottom border (`╰────────╯`) as CONTENT, so a genuinely
/// bordered session-limit picker would classify false — fail-closed, so nothing unsafe is armed,
/// but the feature would silently stop working for that shape and no fixture would catch it: the
/// sole captured picker is a screenshot transcription its own header flags as needing a proper
/// re-capture, so it is not authority on whether the real TUI boxes this dialog (roborev 58539).
fn is_separator_row(line: &str) -> bool {
    line.chars()
        .all(|c| {
            c.is_whitespace()
                || matches!(
                    c,
                    // sides and rules
                    '│' | '|' | '┃' | '─' | '━' | '┄' | '┈' | '═'
                    // rounded corners
                    | '╭' | '╮' | '╰' | '╯'
                    // square and heavy corners. These were absent, which made four of
                    // `is_closing_border`'s six glyphs UNREACHABLE: the trailing slot is only ever
                    // spent as `is_separator_row && is_closing_border`, so `└────┘` failed the
                    // first conjunct and could never be free — a false negative on a render this
                    // repo has already captured (`claude_code_screen`'s BOX_BOTTOM accepts `└`/`┘`,
                    // and a captured screen draws `└─────┘└─────┘`). Adding the OPENING squares too
                    // is behaviour-preserving — they were rejected for not being separator-class
                    // and are now rejected by `is_opening_border`, which is the rule that MEANS it
                    // — and it keeps every glyph in both border classes reachable (roborev 58581).
                    | '┌' | '┐' | '└' | '┘' | '┏' | '┓' | '┗' | '┛'
                )
        })
}

/// An OPENING box border, and therefore NOT separation (roborev 58557).
///
/// `is_separator_row` answers "does this row carry content"; it cannot tell a box CLOSING from a
/// box OPENING, and the difference is the whole safety argument. A closing `╰────╯` beneath the
/// options says the frame we already matched ended there. A `╭──────╮` says a DIFFERENT frame
/// STARTS here — which is positive evidence that whatever follows belongs to that new dialog, not
/// to our options. Treating it as blank space is what let a scrolled-past picker whose viewport
/// clips the top border of the live input box score zero trailing rows and arm `Esc` at whatever
/// was live underneath.
///
/// THE SQUARE/HEAVY CORNERS HERE ARE LOAD-BEARING — do not trim them as redundant. They were
/// decorative when this was written, because `is_separator_row` did not accept them and a row
/// carrying one already counted as content. Reaching the dead half of `is_closing_border` meant
/// widening that class (roborev 58581), which spent exactly that belt-and-braces defence: `┌ ┐ ┏ ┓`
/// in this predicate are now the ONLY thing rejecting a square or heavy top border, both in the
/// option→footer gap and beneath the footer. Removing one opens a real gap.
fn is_opening_border(line: &str) -> bool {
    line.chars().any(|c| matches!(c, '╭' | '╮' | '┌' | '┐' | '┏' | '┓'))
}

/// TS `AMBIENT_CHROME_LINE`, ported shape-for-shape — the persistent chrome Claude Code paints
/// below an open dialog. Kept in step by `ported_typescript_patterns_have_not_drifted`.
///
/// Four alternatives, after optional leading space/tab/NBSP:
///   1. a single status glyph (warning, pause, play, diamond, dot, check, cross, spinner frames),
///   2. a run of 4+ rule characters that IS THE WHOLE ROW,
///   3. a frame edge then 4+ rule characters, again ending the row,
///   4. an EMPTY composer: an optional frame edge, then a caret and nothing but whitespace after.
///
/// Alternative 4 is why this is not simply "starts with a box glyph": the composer's caret row is
/// chrome ONLY when empty. A caret with text after it is the user typing, which is content.
fn is_ambient_chrome_line(line: &str) -> bool {
    const STATUS: &[char] = &['⚠', '⏸', '▶', '◆', '●', '✓', '✗', '✻', '✽', '✢'];
    const RULE: &[char] = &['─', '━', '═', '▔', '▁', '_'];
    const HEAVY_RULE: &[char] = &['─', '━', '═'];
    const EDGE: &[char] = &['│', '|'];
    const CARET: &[char] = &['❯', '›', '>'];
    fn is_sp(c: char) -> bool {
        c == ' ' || c == '\t' || c == '\u{a0}'
    }

    let rest = line.trim_start_matches(is_sp);
    let Some(first) = rest.chars().next() else {
        return false; // a blank line is handled by the caller, not here
    };

    // 1. a lone status glyph.
    if STATUS.contains(&first) {
        return true;
    }
    // 2. a run of rule characters, 4 or more, THAT IS THE WHOLE ROW.
    //
    // The trailing check is the guard, not the count. Matching a four-glyph PREFIX and ignoring the
    // rest reads `──── Do you want to continue?` as chrome — a LIVE PROMPT discounted as
    // decoration, after which `escape_refusal` arms a keystroke at it (knightwatch probe 1 on
    // PR #1290). The TS pattern this was ported from had the same hole.
    if RULE.contains(&first) {
        let run = rest.chars().take_while(|c| RULE.contains(c)).count();
        if run >= 4 && rest.chars().skip(run).all(is_sp) {
            return true;
        }
    }
    // 3./4. anything else must start at a frame edge, or be a bare caret row.
    let at_edge = EDGE.contains(&first);
    let after_edge = if at_edge { &rest[first.len_utf8()..] } else { rest };
    let body = after_edge.trim_start_matches(is_sp);
    let Some(c) = body.chars().next() else {
        return false; // an edge with nothing after it is a frame, not chrome we recognize
    };
    // 3. edge then a heavy rule run — which must END the row, for the same reason.
    if at_edge && HEAVY_RULE.contains(&c) {
        let run = body.chars().take_while(|c| HEAVY_RULE.contains(c)).count();
        return run >= 4 && body.chars().skip(run).all(is_sp);
    }
    // 4. a caret with nothing but whitespace after it.
    if CARET.contains(&c) {
        return body[c.len_utf8()..].chars().all(is_sp);
    }
    false
}

/// A CLOSING box border — the only decoration the trailing budget may spend its one slot on.
///
/// `is_separator_row && !is_opening_border` is NOT the same predicate (roborev 58571). It frees any
/// row drawn from the separator class, and the class contains `─`, which is the full-width
/// TRANSCRIPT DIVIDER Claude Code draws between segments — `capturedScreens.fixture.ts` catches the
/// real TUI drawing one directly above "Session limit reached". A divider beneath the footer is the
/// same "a different frame starts here" evidence `is_opening_border` exists to reject, yet it was
/// consuming the free slot and scoring zero. Requiring a corner makes the code mean what the
/// budget's name, its comment and the shared doc block all already claimed it meant.
fn is_closing_border(line: &str) -> bool {
    line.chars().any(|c| matches!(c, '╰' | '╯' | '└' | '┘' | '┗' | '┛'))
}

/// True when the rendered viewport is Claude Code's SESSION-LIMIT picker specifically.
///
/// Requires ALL of: the mandatory reset label, at least `MIN_OPTIONS_PRESENT` labels overall, the
/// shared `selection_cursor` (so a markdown blockquote's `>` cannot qualify), a picker footer
/// BELOW the options, and NOTHING UNRECOGNIZED after that footer: blanks, up to
/// `MAX_CHROME_BELOW_FOOTER` ambient-chrome rows, and one closing border are free; an opening
/// border never is (roborev 58557, 58571; bead `sparkle-d2i0c` for why zero was wrong).
pub fn screen_is_session_limit_picker(text: &str) -> bool {
    // The label half, mirroring TS `hasSessionLimitOptions`. Reset is mandatory: both "Switch to …"
    // labels are generic enough to appear on some other settings picker, whereas "stop and wait for
    // limit to reset" exists on no other Claude Code screen.
    if !session_limit_reset_option().is_match(text) {
        return false;
    }
    if session_limit_options_present(text) < MIN_OPTIONS_PRESENT {
        return false;
    }
    let all: Vec<&str> = lines(text).collect();
    let Some(last_option) = all.iter().rposition(|l| is_session_limit_option_line(l)) else {
        return false;
    };
    // Rule (1): the selection cursor, reusing the SHARED matcher (`>` is not in its class) — and it
    // must sit ON AN OPTION ROW OF THIS DIALOG, not merely somewhere on the grid (roborev 58159).
    // Tested against the whole text, any `❯ 1. …` in the visible scrollback satisfied it, including
    // a permission menu hundreds of rows above; the exemption this gates is a keystroke.
    if !all
        .iter()
        .any(|l| is_session_limit_option_line(l) && selection_cursor().is_match(l))
    {
        return false;
    }
    // Rule (3): a picker footer, and it must sit BELOW the options — a footer above them belongs to
    // some earlier frame still on screen, not to this dialog.
    let Some(footer_idx) = all
        .iter()
        .enumerate()
        .skip(last_option + 1)
        .find(|(_, l)| is_picker_footer_line(l))
        .map(|(i, _)| i)
    else {
        return false;
    };
    // …and WITHIN the same rendered frame. TS `MAX_OPTION_FOOTER_GAP`: option rows scrolled far up
    // the viewport must not pair with an unrelated footer at the bottom of the grid.
    if footer_idx - last_option > MAX_OPTION_FOOTER_GAP {
        return false;
    }
    // …and the footer must BELONG to this option block. Positive ownership, not a blocklist:
    // only BLANK rows may separate the last option from its footer.
    //
    // The first attempt rejected an intervening CURSORED NUMBERED row, which closes exactly one
    // shape of foreign dialog and leaves the class open — a live slider footer
    // ("← or → to adjust · Del to remove limit") or a switcher carries no numbered row at all, so it
    // sailed through and `MAX_OPTION_FOOTER_GAP` was again the only defence, holding on height
    // alone. That is the reasoning this rule exists to reject, so keying on one shape was the same
    // mistake one level up (roborev 58527).
    //
    // The genuine article renders its footer immediately beneath option 3, so requiring whitespace
    // is not a guess — anything else on those rows belongs to something that is not this dialog.
    //
    // An OPENING border in that span is content no matter how box-drawn it looks: `╭──────╮`
    // between our options and a footer means a new frame began there, so the footer beneath it is
    // that frame's, not ours (roborev 58557).
    if all[last_option + 1..footer_idx]
        .iter()
        .any(|l| !is_separator_row(l) || is_opening_border(l))
    {
        return false;
    }
    // Rule (4): bottom-anchored — nothing UNRECOGNIZED may follow the footer.
    //
    // Free below the footer, in any order: blanks; up to `MAX_CHROME_BELOW_FOOTER` ambient-chrome
    // rows; and ONE closing border, which is not chrome (a corner is outside the chrome class) but
    // is the bordered dialog's own bottom edge. An OPENING border is never free at all — a frame
    // starting below the footer is the shape that would arm Esc at a dialog somebody is answering
    // (roborev 58557/58571). The old rule allowed none of the chrome and rejected the real screen.
    let mut chrome_below = 0usize;
    let mut closing_border_budget = 1usize;
    for l in &all[footer_idx + 1..] {
        if l.trim().is_empty() {
            continue; // a blank line was always free, and stays free
        }
        if is_opening_border(l) {
            return false;
        }
        if is_separator_row(l) && is_closing_border(l) && closing_border_budget > 0 {
            closing_border_budget -= 1; // the dialog's own closing border, once
            continue;
        }
        if !is_ambient_chrome_line(l) || chrome_below >= MAX_CHROME_BELOW_FOOTER {
            return false;
        }
        chrome_below += 1;
    }
    true
}

// ── THE RUNNING-TURN MARKER ───────────────────────────────────────────────────────────────────

// Claude Code's live spinner hint. This is the one marker `screenClassifier.ts` calls "reliable on
// the raw stream", and it is how this module answers "is the agent working?" WITHOUT asking the
// WebView — which matters, because a status pushed down from the frontend goes stale at exactly
// the moment the frontend wedges, and a stale status is the input that would let the nudger type
// into a running turn.
pattern!(esc_to_interrupt, r"(?i)\(\s*esc to interrupt");

// Claude Code's spinner glyphs (`statusEngine.ts:111`), paired with an elapsed-time reading. Either
// alone is too weak — the glyphs appear in ordinary output — so both must be on the same line.
pattern!(
    spinner_line,
    r"(?m)^\s*[✻✽✢✶✳·*∗+]\s.*\(\s*(?:\d+\s*[hms]\s*)+"
);

// ── THE INPUT BOX ─────────────────────────────────────────────────────────────────────────────

// Claude Code's input line: the box the user types into. Captures whatever is on it.
//
// `>` is accepted alongside `❯`/`›` here (unlike `SELECTION_CURSOR`, which excludes it) because a
// bare `>` is what the box renders as in several builds and fonts, and the consequence of a false
// match differs: `SELECTION_CURSOR` uses it to flip a status badge off any markdown blockquote,
// whereas here a matched line is only ever a candidate for "is there text waiting", and the
// bottom-most-line rule below keeps scrollback quotes out.
// NOTE THE NON-BREAKING SPACE in the horizontal-space class. Claude Code pads its input box with
// U+00A0, not U+0020 — the captured fixture's live box is literally "❯\u{a0}" — so a class of
// `[ \t]` alone stops absorbing the padding and the box stops parsing. Found by testing against the
// real corpus rather than a hand-written screen, which is the entire argument for reading the
// fixtures instead of restating them.
pattern!(
    input_line,
    r"(?m)^[ \t\u{a0}]*[│|┃]?[ \t\u{a0}]*[❯›>][ \t\u{a0}]*(.*?)[ \t\u{a0}]*[│|┃]?[ \t\u{a0}]*$"
);

// A horizontal rule — the box Claude draws around its input line.
pattern!(rule_line, r"(?m)^[ \t\u{a0}]*[─━▔▁]{8,}[ \t\u{a0}]*$");

/// How far up from the bottom the live input box may be. In a real viewport it is the bottom-most
/// thing except for the persistent chrome lines below it (`IDLE_AFTER_TURN_2_1_220` has two: the
/// transcript warning and the permission-mode bar). Six is comfortably clear of that and still far
/// from the echoed prompt higher in the transcript, which is the line a whole-screen scan would
/// wrongly read as "the user has typed something".
const INPUT_BOX_TAIL_ROWS: usize = 6;

/// How many trailing rows the wrap-tolerant credential check joins. Matches `screenTail`'s default
/// of 3 in `dictationTerminalRoute.ts`, and for the same reason: a prompt longer than the pane is
/// hard-wrapped onto its own rendered row, so the word and its colon land on different rows and
/// every `…:\s*$` pattern silently stops matching at some column widths.
const CREDENTIAL_TAIL_ROWS: usize = 3;

/// Split a rendered screen into lines on BOTH `\n` and `\r`.
///
/// `\r` matters: the PTY stream redraws in place, and a chunk can carry several frames separated by
/// carriage returns alone. Treating such a chunk as one line is what let a real picker footer be
/// suppressed by a spinner belonging to a different frame (roborev 54749).
fn lines(text: &str) -> impl Iterator<Item = &str> {
    text.split(['\n', '\r'])
}

/// The last `rows` non-blank rendered rows, joined with a space.
fn tail(text: &str, rows: usize) -> String {
    let all: Vec<&str> = lines(text).collect();
    let end = all
        .iter()
        .rposition(|l| !l.trim().is_empty())
        .map_or(0, |i| i + 1);
    let start = end.saturating_sub(rows);
    all[start..end].join(" ")
}

/// Is a picker / menu / blocking prompt on screen? The Rust counterpart of `screenAwaitsInput`,
/// widened per this module's asymmetric contract.
pub fn screen_awaits_input(text: &str) -> bool {
    if text.trim().is_empty() {
        return false;
    }
    if selection_cursor().is_match(text) {
        return true;
    }
    if footer_legacy().is_match(text) {
        return true;
    }
    // The shape arm, per rendered line, with the `to interrupt` disqualifier applied to that same
    // line — the lookahead the Rust regex crate cannot express.
    if lines(text)
        .any(|l| !l.to_ascii_lowercase().contains(NOT_A_FOOTER_VERB) && footer_bar().is_match(l))
    {
        return true;
    }
    if shell_prompt_yn().is_match(text)
        || shell_prompt_press_enter().is_match(text)
        || shell_prompt_overwrite().is_match(text)
        || shell_prompt_password().is_match(text)
        || shell_prompt_passphrase().is_match(text)
    {
        return true;
    }
    // The two CONFIRMATION arms of the TS `WRITE_BLOCKING_PROMPTS` list. They live here rather than
    // with the credential check because that is what they are: `ssh`'s
    // "…continue connecting (yes/no/[fingerprint])?" and "Type \"yes\" to confirm:" are questions
    // awaiting an answer, not concealed fields. Both were added to the TS list from real misses —
    // `screenAwaitsInput`'s bare `[([]y/n[)\]]` matches neither.
    write_block_yes_no().is_match(text) || write_block_type_yes().is_match(text)
}

/// Does the screen show a credential prompt? Split out from `screen_blocks_write` so the caller can
/// report WHICH refusal fired — the log is the point of the whole exercise.
pub fn screen_shows_credential_prompt(text: &str) -> bool {
    if write_block_password_colon().is_match(text) {
        return true;
    }
    // The wrap-tolerant arm: a credential word anywhere in the trailing region, and that region
    // ending in a colon — the shape of a prompt sitting there waiting, however it happened to wrap.
    let t = tail(text, CREDENTIAL_TAIL_ROWS);
    ends_in_colon().is_match(&t) && credential_word().is_match(&t)
}

/// Is a turn currently RUNNING? Derived from the screen alone, so it holds when the WebView does
/// not.
pub fn screen_is_working(text: &str) -> bool {
    esc_to_interrupt().is_match(text) || spinner_line().is_match(text)
}

/// Does the screen carry Claude Code's own prompt signature?
///
/// This is the alternate-screen carve-out and nothing else. Claude Code itself can hold the
/// alternate buffer, and refusing on the flag alone would disarm the nudger against the exact
/// agents it exists for. Requiring the input box AND its surrounding rule keeps `vim`, `less`,
/// `htop` and `lazygit` out — none of them draws that pair.
pub fn looks_like_claude_prompt(text: &str) -> bool {
    rule_line().is_match(text) && input_box_content(text).is_some()
}

/// The content of the LIVE input box: `Some("")` when the box is empty, `None` when no box is on
/// screen.
///
/// BOTTOM-MOST WINS, and that is the whole correctness of Shape A. `IDLE_AFTER_TURN_2_1_220` is the
/// worked example: it carries an ECHOED prompt line high in the transcript —
/// "❯ Reply with exactly: hello. Nothing else." — and the real, EMPTY box near the bottom. A
/// whole-screen scan finds the echo, reads it as text waiting to be submitted, and fires an Enter
/// into an empty prompt, which the bead is explicit is "a no-op at best and confirms a dialog at
/// worst".
/// The rows that belong to the LIVE prompt, as opposed to the transcript scrolled above it.
///
/// Prefer the STRUCTURAL anchor over a row count. Claude Code draws its input line inside a box — a
/// horizontal rule above it and another below — so the live region begins at the last rule on
/// screen. Keying on that is stable however much blank padding, chrome, or transcript sits around
/// it; a fixed row count is not, and would either miss the box on a screen with three chrome lines
/// under it or reach the echoed prompt on a dense transcript.
fn live_region(all: &[&str]) -> (usize, usize) {
    let end = all
        .iter()
        .rposition(|l| !l.trim().is_empty())
        .map_or(0, |i| i + 1);
    let last_rule = all[..end].iter().rposition(|l| rule_line().is_match(l));
    let start = match last_rule {
        // One row above the rule, because the box is sandwiched `rule / ❯ / rule` and the rule we
        // just found is usually the CLOSING one.
        Some(i) => i.saturating_sub(1),
        None => end.saturating_sub(INPUT_BOX_TAIL_ROWS),
    };
    (start, end)
}

fn input_box_content(text: &str) -> Option<String> {
    let all: Vec<&str> = lines(text).collect();
    let (start, end) = live_region(&all);
    all[start..end]
        .iter()
        .rev()
        .find_map(|line| input_line().captures(line).map(|c| c[1].trim().to_string()))
}

/// Is there text sitting on the prompt line, typed and never submitted?
///
/// This is the trigger for Shape A — the bare Enter — and it is the highest-value case in the bead:
/// five agents sat red overnight holding correct answers that had been typed and never sent
/// (sparkle-bhhu1). An Enter there costs zero tokens and clears the whole class.
pub fn prompt_line_has_text(text: &str) -> bool {
    input_box_content(text).is_some_and(|c| !c.is_empty())
}

/// THE GATE. `None` means every check passed and a write is permitted.
///
/// Order is by how specific the message is, not by safety — the checks are independent, and all of
/// them run against the same rendered screen.
pub fn write_refusal(screen: Option<&Screen>) -> Option<Refusal> {
    let Some(screen) = screen else {
        return Some(Refusal::NoViewport);
    };
    // Gate 2. The alternate buffer refuses UNLESS the screen is also Claude Code's own prompt.
    if screen.alternate && !looks_like_claude_prompt(screen.text) {
        return Some(Refusal::AlternateScreen);
    }
    // Gate 1. Never interrupt a running turn.
    if screen_is_working(screen.text) {
        return Some(Refusal::Working);
    }
    // Gate 4. Credentials before pickers: a password prompt that also looks like a menu must be
    // reported as the credential it is.
    if screen_shows_credential_prompt(screen.text) {
        return Some(Refusal::CredentialPrompt);
    }
    // Gate 3. Pickers, menus, numbered options, and prose questions.
    if screen_awaits_input(screen.text) {
        return Some(Refusal::AwaitingInput);
    }
    // SCOPED TO THE LIVE PROMPT REGION, unlike everything above it — and the distinction matters
    // enough that getting it wrong would have made this module inert.
    //
    // `menu_line` and `question_opener` come from MESSAGE-level heuristics (`heuristics.ts`,
    // `pendingQuestion.ts`), where they are aimed at one freshly-arrived block of text. Applied to a
    // whole rendered viewport they match the TRANSCRIPT: any numbered list still on screen ("1. Do
    // X / 2. Do Y") or any already-answered "Should I…?" left in the scrollback refuses every write
    // for as long as it stays visible. A stalled agent's final screen very often contains exactly
    // that, so the unscoped version degrades to observe-and-escalate for the "Mount Tells The Truth"
    // case this was built for — silently doing nothing while the log reads `awaiting-input`.
    //
    // The arms ABOVE are whole-screen on purpose: a live picker's selection cursor, its footer, and
    // a credential prompt are all bottom-anchored by construction and their false-positive cost is
    // a skipped nudge. These two have the opposite profile, so they get the narrower scope.
    let all: Vec<&str> = lines(screen.text).collect();
    let (start, end) = live_region(&all);
    let live = all[start..end].join("\n");
    if menu_line().is_match(&live) || question_opener().is_match(&live) {
        return Some(Refusal::AwaitingInput);
    }
    None
}

/// The ONE byte any machine may ever send at a session-limit picker: `Esc`, which CANCELS.
///
/// Never a numbered option, under any recovery path, ever. Options 2 and 3 on that picker are
/// billing decisions — paid overage and a subscription change — and pressing either on the user's
/// behalf is the exact harm `Refusal::AwaitingInput` exists to prevent ("free text aimed at a live
/// picker presses a button nobody read"). Exported as a constant rather than spelled at the call
/// site so a test can assert the whole recovery path's byte alphabet is `{ESC}`.
pub const ESCAPE_KEY: &str = "\x1b";

/// MAY THE MACHINE SEND `ESCAPE_KEY` INTO THIS TERMINAL? `None` means yes.
///
/// ── WHY THIS IS A SEPARATE FUNCTION AND NOT A HOLE IN `write_refusal` ─────────────────────────
/// The obvious shape — teach `write_refusal` to return `None` on a session-limit picker — would be
/// wrong in the dangerous direction: `write_refusal`'s `None` licenses the nudger's ARBITRARY TEXT
/// (a bracketed paste followed by a carriage return), and a paste-then-CR at a live picker submits
/// whichever option the cursor happens to sit on. The exemption §6c calls for is narrow, so it is
/// scoped by CONSTRUCTION: `write_refusal` is unchanged and still answers `AwaitingInput` here, and
/// the only caller that may consult this function is the one that writes exactly `ESCAPE_KEY`.
///
/// Every other refusal still applies, in the same order and for the same reasons. In particular a
/// RUNNING turn still refuses: a picker cannot be live while output is streaming, so a screen that
/// shows both is a stale or garbled grid, and pressing Esc into a running turn cancels the turn.
///
/// FAILS CLOSED on every unknown — no screen, an alternate buffer that is not Claude Code's own
/// prompt, a credential prompt, or any screen this module's Rust matcher does not positively
/// recognise as the session-limit picker. "The TypeScript side said so" is NOT an input here and
/// must never become one: this gate runs on the nudger thread precisely because the WebView may be
/// wedged, so a disagreement between the two sides can only be resolved by refusing.
pub fn escape_refusal(screen: Option<&Screen>) -> Option<Refusal> {
    let Some(screen) = screen else {
        return Some(Refusal::NoViewport);
    };
    if screen.alternate && !looks_like_claude_prompt(screen.text) {
        return Some(Refusal::AlternateScreen);
    }
    if screen_is_working(screen.text) {
        return Some(Refusal::Working);
    }
    if screen_shows_credential_prompt(screen.text) {
        return Some(Refusal::CredentialPrompt);
    }
    if screen_is_session_limit_picker(screen.text) {
        return None;
    }
    // Everything else — including every ORDINARY picker, which is the hazard `nudge_gate.rs`'s
    // `AwaitingInput` arm exists to prevent.
    Some(Refusal::AwaitingInput)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // The TypeScript sources this module is a port of, as WHOLE literal paths.
    //
    // Whole literals on purpose, not `join("../src").join(rel)`. `tools/tests/ci-workflow.test.mjs`
    // scans this crate for string literals containing `../` that resolve to a real FILE, and fails
    // CI if the workflow's RUST_RE does not gate them — that is what makes a change to one of these
    // TypeScript files re-run the Rust jobs. A path assembled from a runtime fragment resolves to a
    // directory, so the scanner would not see it, RUST_RE would not gate it, and an edit to
    // screenClassifier.ts would skip the very tests that exist to notice it. The scanner's own
    // header records that this exact mistake has already been made twice.
    const TS_CLASSIFIER: &str = "../src/engine/screenClassifier.ts";
    const TS_ROUTE: &str = "../src/voice/dictationTerminalRoute.ts";
    /// The picker detector. Enrolled because `dictationTerminalRoute`'s yes/no arm is now an ALIAS
    /// of `YN` here rather than its own literal, so this file is where that pattern actually lives.
    const TS_HEURISTICS: &str = "../src/services/suggestions/heuristics.ts";
    const TS_FIXTURE: &str = "../src/engine/capturedScreens.fixture.ts";
    const TS_SESSION_LIMIT: &str = "../src/services/sessionLimitScreen.ts";

    /// Read one of the TypeScript sources at TEST time, from the real tree, so the port is judged
    /// against the source of truth rather than against a copy of it.
    fn ts(rel: &str) -> String {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel);
        std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("cannot read {}: {e}", p.display()))
    }

    /// Pull `export const NAME = [ "…", "…" ]` out of a TS module.
    ///
    /// Deliberately a dumb literal scanner rather than anything clever: it only has to read one
    /// hand-written fixture file whose shape is fixed, and a parser that silently returned nothing
    /// would turn every assertion below into a vacuous pass. Hence the explicit emptiness check in
    /// `fixture_screen`.
    fn ts_string_array(src: &str, name: &str) -> Vec<String> {
        let anchor = format!("export const {name} = [");
        let start = src
            .find(&anchor)
            .unwrap_or_else(|| panic!("no fixture {name}"));
        let body = &src[start + anchor.len()..];
        // Close on the array's own `]` at column 0, NOT on `];`. The captured-screen fixtures end
        // `].join("\n");` and the flat lists end `];`, so keying on `];` over-reads the `.join`
        // ones straight through into the NEXT fixture — which is not a loud failure but a quiet
        // corruption: the idle screen silently acquired the picker-footer list that follows it and
        // the gate correctly refused it, making a real bug look like a broken assertion.
        let end = body
            .find("\n]")
            .unwrap_or_else(|| panic!("unterminated fixture {name}"));
        let body = &body[..end];

        let mut out = Vec::new();
        let mut chars = body.chars().peekable();
        while let Some(c) = chars.next() {
            if c != '"' {
                continue;
            }
            let mut s = String::new();
            while let Some(c) = chars.next() {
                match c {
                    '\\' => {
                        if let Some(esc) = chars.next() {
                            s.push(match esc {
                                'n' => '\n',
                                't' => '\t',
                                other => other,
                            });
                        }
                    }
                    '"' => break,
                    other => s.push(other),
                }
            }
            out.push(s);
        }
        out
    }

    /// One captured viewport, rejoined the way the fixture's own `.join("\n")` does.
    fn fixture_screen(name: &str) -> String {
        let src = ts(TS_FIXTURE);
        let rows = ts_string_array(&src, name);
        assert!(!rows.is_empty(), "fixture {name} parsed to nothing — the scanner is broken, and every assertion using it would pass vacuously");
        // Over-reading is the failure mode that does NOT announce itself: the scanner runs on into
        // the next fixture, the screen quietly grows rows it never had, and the assertion that
        // catches it reads as a bug in the gate. Both sentinels below fired for real during
        // development.
        for row in &rows {
            assert!(
                !row.contains("export const"),
                "fixture {name} over-read into the next declaration: {row:?}"
            );
        }
        rows.join("\n")
    }

    fn plain(text: &str) -> Option<Refusal> {
        write_refusal(Some(&Screen {
            text,
            alternate: false,
        }))
    }

    // ══ THE CORPUS ══════════════════════════════════════════════════════════════════════════════
    // Real rendered Claude Code 2.1.220 viewports, read from the TS fixture. Add a screen there and
    // it is judged here on the next `cargo test`, with no Rust edit — which is the mechanism that
    // keeps this port from becoming the copy that inherited the misses and not the fixes.

    #[test]
    fn every_captured_picker_is_refused() {
        for name in [
            "APPROVAL_2_1_220",
            "APPROVAL_OPTION_2_2_1_220",
            "ASK_USER_QUESTION_2_1_220",
            "MODEL_PICKER_2_1_220",
        ] {
            let screen = fixture_screen(name);
            assert_eq!(
                plain(&screen),
                Some(Refusal::AwaitingInput),
                "{name} is a live picker and must never be written into"
            );
        }
    }

    #[test]
    fn every_other_picker_footer_is_refused() {
        let src = ts(TS_FIXTURE);
        let footers = ts_string_array(&src, "OTHER_PICKER_FOOTERS_2_1_220");
        assert!(footers.len() >= 6, "fixture shrank unexpectedly");
        for footer in footers {
            assert!(
                screen_awaits_input(&footer),
                "picker footer must block a write: {footer:?}"
            );
        }
    }

    /// The mirror failure, and the more dangerous one to get wrong in the other direction: ambient
    /// chrome must NOT read as a picker, or the gate refuses every screen forever and the nudger is
    /// silently dead while looking healthy.
    #[test]
    fn ambient_chrome_is_not_mistaken_for_a_picker() {
        let src = ts(TS_FIXTURE);
        let chrome = ts_string_array(&src, "NON_PICKER_HINT_LINES_2_1_220");
        assert!(chrome.len() >= 10, "fixture shrank unexpectedly");
        for line in chrome {
            assert!(
                !screen_awaits_input(&line),
                "ambient chrome must not block: {line:?}"
            );
        }
    }

    #[test]
    fn a_finished_turn_at_the_idle_box_permits_a_write() {
        let screen = fixture_screen("IDLE_AFTER_TURN_2_1_220");
        assert_eq!(
            plain(&screen),
            None,
            "an idle finished turn is exactly what we may nudge"
        );
    }

    /// THE INERTNESS BUG, pinned. `menu_line` and `question_opener` come from MESSAGE-level
    /// heuristics; applied to a whole viewport they match the TRANSCRIPT, so any numbered list or
    /// any already-answered "Should I…?" still on screen would refuse every write for as long as it
    /// stayed visible.
    ///
    /// A stalled agent's final screen very often contains exactly that — which means the unscoped
    /// version degraded to observe-and-escalate for the "Mount Tells The Truth" case this module was
    /// built for, silently doing nothing while the log read `awaiting-input`.
    #[test]
    fn a_finished_turn_is_still_nudgeable_with_a_list_in_the_transcript() {
        let idle = fixture_screen("IDLE_AFTER_TURN_2_1_220");
        // Put a numbered list and an answered question in the SCROLLBACK, above the live box.
        let with_transcript = idle.replace(
            "⏺ hello",
            "⏺ Here is the plan:\n  1. Read the files\n  2. Write the port\n  3. Run the tests\n\n             Should I proceed? You said yes, so I did.",
        );
        assert!(
            with_transcript.contains("1. Read the files"),
            "precondition: list is on screen"
        );
        assert!(
            with_transcript.contains("Should I proceed?"),
            "precondition: question is on screen"
        );

        assert_eq!(
            plain(&with_transcript),
            None,
            "a numbered list and an answered question in the TRANSCRIPT must not refuse the write —              that is the whole class of screen this module exists to nudge"
        );
    }

    /// The other side of the same rule: the identical markers INSIDE the live prompt region still
    /// refuse, so scoping did not simply delete the guard.
    #[test]
    fn a_list_in_the_live_prompt_region_still_refuses() {
        assert_eq!(
            plain("────────────────────────\n  1. Yes\n  2. No"),
            Some(Refusal::AwaitingInput)
        );
        assert_eq!(
            plain("────────────────────────\n❯ Do you want me to land this?"),
            Some(Refusal::AwaitingInput)
        );
    }

    // ══ THE INPUT BOX ═══════════════════════════════════════════════════════════════════════════

    /// THE bug this rule exists for. `IDLE_AFTER_TURN_2_1_220` carries an ECHOED prompt high in the
    /// transcript ("❯ Reply with exactly: hello…") and the real, EMPTY box near the bottom. A
    /// whole-screen scan finds the echo, calls the prompt non-empty, and fires an Enter into an
    /// empty box — "a no-op at best and confirms a dialog at worst".
    #[test]
    fn an_echoed_prompt_in_scrollback_is_not_the_live_input_line() {
        let screen = fixture_screen("IDLE_AFTER_TURN_2_1_220");
        assert!(
            screen.contains("❯ Reply with exactly"),
            "fixture no longer carries the echoed prompt this test is about"
        );
        assert!(
            !prompt_line_has_text(&screen),
            "the LIVE box is empty; the echo above it must not count"
        );
    }

    #[test]
    fn text_typed_into_the_live_box_is_seen() {
        // The same fixture with an answer sitting unsent in the box — tonight's failure, verbatim
        // in shape: five agents held typed answers that were never submitted (sparkle-bhhu1).
        // NBSP, not a space — that is what the real box is padded with, and using a plain space
        // here would silently replace nothing and leave the assertion testing the empty box.
        let idle = fixture_screen("IDLE_AFTER_TURN_2_1_220");
        let box_line = "❯\u{a0}";
        assert!(
            idle.contains(box_line),
            "fixture no longer renders the box the way this test types into it"
        );
        let screen = idle.replace(box_line, "❯\u{a0}yes, finish the port and run the tests");
        assert!(
            prompt_line_has_text(&screen),
            "a non-empty live prompt must be detected"
        );
        assert_eq!(plain(&screen), None, "and it must still pass the gate");
    }

    #[test]
    fn a_screen_with_no_input_box_has_no_prompt_text() {
        assert!(!prompt_line_has_text("just some output\nand more output"));
    }

    // ══ THE DANGEROUS STATES ════════════════════════════════════════════════════════════════════

    #[test]
    fn a_vim_buffer_is_never_written_to() {
        let vim = "\n\
            1 fn main() {\n\
            2     println!(\"hello\");\n\
            3 }\n\
            ~\n~\n~\n\
            \"src/main.rs\" 3L, 42B";
        assert_eq!(
            write_refusal(Some(&Screen {
                text: vim,
                alternate: true
            })),
            Some(Refusal::AlternateScreen),
            "a full-screen app reads pasted text as COMMANDS"
        );
    }

    /// The carve-out, and it has to work or the nudger is disarmed against the agents it exists for:
    /// Claude Code itself can hold the alternate buffer.
    #[test]
    fn claude_code_on_the_alternate_screen_is_still_reachable() {
        let screen = fixture_screen("IDLE_AFTER_TURN_2_1_220");
        assert!(looks_like_claude_prompt(&screen));
        assert_eq!(
            write_refusal(Some(&Screen {
                text: &screen,
                alternate: true
            })),
            None,
            "the alt-screen guard must not refuse Claude Code's own prompt"
        );
    }

    #[test]
    fn an_unreadable_screen_fails_closed() {
        assert_eq!(write_refusal(None), Some(Refusal::NoViewport));
    }

    #[test]
    fn a_running_turn_is_never_interrupted() {
        let working = "⏺ Reading files…\n\n✻ Churning… (12s · esc to interrupt)";
        assert!(screen_is_working(working));
        assert_eq!(plain(working), Some(Refusal::Working));
    }

    #[test]
    fn credential_prompts_block_even_when_they_wrap() {
        // Every one of these was a real miss on the TS side before its list grew.
        for prompt in [
            "[sudo] password for someone:",
            "Password for 'https://github.com':",
            "Paste your authentication token:",
            "Verification code:",
            "Enter passphrase for key '/home/u/.ssh/id_ed25519':",
        ] {
            assert_eq!(
                plain(prompt),
                Some(Refusal::CredentialPrompt),
                "must refuse a credential prompt: {prompt:?}"
            );
        }
        // The wrap case: the word and its colon land on DIFFERENT rendered rows, which is what
        // broke every `…:\s*$` pattern at some column widths.
        let wrapped = "Enter the password for someone@example.com at\nmy.1password.com:";
        assert_eq!(plain(wrapped), Some(Refusal::CredentialPrompt));
    }

    #[test]
    fn confirmation_prompts_block() {
        assert!(screen_awaits_input(
            "Are you sure you want to continue connecting (yes/no)?"
        ));
        assert!(screen_awaits_input("Type \"yes\" to confirm:"));
        assert!(screen_awaits_input("Overwrite? [y/N]"));
        assert!(screen_awaits_input("Press enter to continue"));
    }

    #[test]
    fn numbered_options_and_prose_questions_block() {
        assert_eq!(plain("  1. Yes\n  2. No"), Some(Refusal::AwaitingInput));
        assert_eq!(
            plain("Do you want me to land this now?"),
            Some(Refusal::AwaitingInput)
        );
        assert_eq!(plain("Should I proceed?"), Some(Refusal::AwaitingInput));
    }

    #[test]
    fn a_spinner_redraw_sharing_a_chunk_with_a_footer_still_blocks() {
        // `\r`-framed frames in one chunk. The TS version had to be patched for exactly this
        // (roborev 54749): scanning across the `\r` let a spinner belonging to a LATER frame
        // suppress a real picker footer from an earlier one — a false calm on a blocked agent.
        let chunk = "Enter to select · ↑/↓ to navigate · Esc to cancel\r✻ Churning… (3s · esc to interrupt)";
        assert!(
            screen_awaits_input(chunk),
            "the footer frame must still be seen"
        );
    }

    // ══ THE SESSION-LIMIT PICKER, AND THE ESCAPE EXEMPTION ══════════════════════════════════════
    //
    // THE LIVE OPTION LABELS ARE ASSEMBLED AT RUNTIME, NEVER WRITTEN CONTIGUOUSLY. A test file is a
    // file agents `cat`, diff and review; whole labels sitting in this source would stream a genuine
    // trigger through the classifier and pin the READING agent at `waiting`. The PRD de-fangs its
    // reproduction for the same reason; splitting the strings does it here at no cost to the
    // assertion, because the matcher only ever sees the joined result.
    //
    // The PRD's own de-fanged block is asserted below by SHAPE rather than by reading the file: a
    // string literal here resolving to a real path outside the crate would oblige `RUST_RE` to match
    // `PRD/`, which would run the 10x macOS Rust legs on every progress-doc edit.

    fn reset_label() -> String {
        ["Stop and wait for", "limit to", "reset"].join(" ")
    }
    fn credits_label() -> String {
        ["Switch to", "usage", "credits"].join(" ")
    }
    fn team_label() -> String {
        ["Switch to", "Team", "plan"].join(" ")
    }
    const PICKER_FOOTER: &str = "Enter to confirm · Esc to cancel";

    /// The real screen, with `cursor` as the highlight glyph and `trailing` appended beneath the
    /// footer (empty for the genuine bottom-anchored article).
    fn session_limit_screen(cursor: &str, trailing: &str) -> String {
        let mut s = format!(
            "⏺ Reading files…\n\nWhat do you want to do?\n{cursor} 1. {}\n  2. {}\n  3. {}\n{PICKER_FOOTER}",
            reset_label(),
            credits_label(),
            team_label(),
        );
        if !trailing.is_empty() {
            s.push('\n');
            s.push_str(trailing);
        }
        s
    }

    #[test]
    fn the_session_limit_picker_is_recognised() {
        assert!(screen_is_session_limit_picker(&session_limit_screen("❯", "")));
    }

    /// THE CO-ASSERTION THAT KEEPS THE EXEMPTION NARROW: recognising the picker must NOT open
    /// `write_refusal`. Arbitrary text at a live picker is exactly what `Refusal::AwaitingInput`
    /// exists to prevent, and the nudger's own write is a bracketed paste followed by a carriage
    /// return — which would submit whichever billing option the cursor sits on.
    #[test]
    fn recognising_the_picker_does_not_license_free_text() {
        assert_eq!(
            plain(&session_limit_screen("❯", "")),
            Some(Refusal::AwaitingInput),
            "the ordinary write gate must be UNCHANGED at a session-limit picker"
        );
    }

    #[test]
    fn escape_is_permitted_at_the_session_limit_picker() {
        assert_eq!(
            escape_refusal(Some(&Screen {
                text: &session_limit_screen("❯", ""),
                alternate: false
            })),
            None,
        );
    }

    /// THE COMPOSITE SHAPE: session-limit option labels sitting in SCROLLBACK while a live ORDINARY
    /// picker occupies the bottom of the grid. Each rule can in principle be satisfied by a
    /// DIFFERENT thing on the same screen — the scrollback supplies the reset label and the option
    /// count, the live approval dialog supplies a `❯ 1.` row and a footer — and a matcher that
    /// tested each rule against the whole viewport independently would hand out the Esc exemption
    /// here, cancelling a tool approval a human is mid-answer on.
    ///
    /// WHAT THIS PINS, stated precisely: the OUTCOME, not any single rule. No individual rule can be
    /// mutated away and make this fail — cursor-on-an-option-row, footer-below-the-options,
    /// `MAX_OPTION_FOOTER_GAP` and the chrome-bounded bottom-anchor each independently
    /// reject this shape. That is defence in depth working as intended, and it is also why a
    /// per-rule mutation check is the wrong instrument here; the rules are pinned individually by
    /// their own tests. This one exists so the composite CANNOT regress silently if several are
    /// relaxed together — which is exactly how a laxer rewrite would arrive.
    #[test]
    fn scrollback_options_plus_a_live_ordinary_picker_never_earn_the_exemption() {
        for name in ["APPROVAL_2_1_220", "ASK_USER_QUESTION_2_1_220", "MODEL_PICKER_2_1_220"] {
            let live = fixture_screen(name);
            // Session-limit labels ABOVE, carrying no selection cursor of their own, then the live
            // dialog below — the ordinary way a limit banner scrolls up but stays on the grid.
            // Labels ASSEMBLED, never written contiguously — the module's own invariant, stated
            // above: a test file is a file agents `cat` and review, and whole labels sitting in this
            // source would stream a genuine trigger through the classifier and pin the READING agent
            // at `waiting`. I violated it in the first version of this test (roborev 58506).
            let composite = format!(
                "  1. {}\n  2. {}\n  3. {}\n{live}",
                reset_label(),
                credits_label(),
                team_label()
            );
            // The premise is real: the label half IS satisfied by the scrollback, so this screen
            // genuinely reaches the coherence rules rather than being rejected before them.
            assert_eq!(
                session_limit_options_present(&composite),
                3,
                "{name}: the scrollback must supply all three labels, or this test proves nothing"
            );
            assert!(
                !screen_is_session_limit_picker(&composite),
                "{name} under scrolled-up session-limit labels must NOT read as the session-limit picker"
            );
            assert_eq!(
                escape_refusal(Some(&Screen { text: &composite, alternate: false })),
                Some(Refusal::AwaitingInput),
                "{name} under scrolled-up labels must still refuse the keystroke"
            );
        }
    }

    /// THE CURSOR-BEARING COMPOSITE, which is the REALISTIC scrollback and the variant my first
    /// version missed. A session-limit picker that scrolled up KEEPS its highlight glyph — the real
    /// fixture renders `❯ 1. <reset>` — so the scrollback alone satisfies the mandatory reset label,
    /// the option count AND rule (1) cursor-on-an-option-row. The cursorless composite tested above
    /// is over-determined; here the only remaining defence is the option→footer distance.
    ///
    /// The short-dialog arm is the sharp one: a live approval whose footer sits within
    /// `MAX_OPTION_FOOTER_GAP` rows of the scrolled-up options. If that earned the exemption, a
    /// machine would press Esc on a tool approval a human is mid-answer on.
    #[test]
    fn a_cursor_bearing_scrollback_still_never_earns_the_exemption() {
        for name in ["APPROVAL_2_1_220", "ASK_USER_QUESTION_2_1_220", "MODEL_PICKER_2_1_220"] {
            let live = fixture_screen(name);
            let composite = format!(
                "❯ 1. {}\n  2. {}\n  3. {}\n{live}",
                reset_label(),
                credits_label(),
                team_label()
            );
            assert_eq!(
                session_limit_options_present(&composite),
                3,
                "{name}: the premise — the scrollback must carry all three labels"
            );
            assert!(
                !screen_is_session_limit_picker(&composite),
                "{name} under a CURSOR-BEARING scrolled-up picker must not read as the session-limit picker"
            );
            assert_eq!(
                escape_refusal(Some(&Screen { text: &composite, alternate: false })),
                Some(Refusal::AwaitingInput),
                "{name} under a cursor-bearing scrollback must still refuse the keystroke"
            );
        }

        // A live dialog with a footer but NO NUMBERED ROW AT ALL — a slider or a switcher. The
        // first ownership rule keyed on an intervening cursored numbered row, so this shape sailed
        // straight through it (roborev 58527); these are real captured 2.1.220 footers.
        for foreign in [
            "← or → to adjust · Del to remove limit",
            "←/→ to switch · ↓ to select · Esc to cancel",
        ] {
            let slider = format!(
                "❯ 1. {}\n  2. {}\n  3. {}\nAdjust the limit\n{foreign}",
                reset_label(),
                credits_label(),
                team_label()
            );
            assert!(
                !screen_is_session_limit_picker(&slider),
                "a cursorless live dialog's footer must not be adopted by scrolled-up options"
            );
            assert_eq!(
                escape_refusal(Some(&Screen { text: &slider, alternate: false })),
                Some(Refusal::AwaitingInput),
                "…and the keystroke must still be refused"
            );
        }

        // A BARE `>` OPTION ROW — and this comment has now been wrong in BOTH directions, so read
        // the scope carefully (roborev 58548, then knightwatch probe 1 on PR #1261).
        //
        // Version one said "the real approval fixture uses it". That was the inverse of the
        // evidence and 58548 was right to kill it. Version two over-corrected to "grepping the
        // fixtures for a bare-`>` cursor returns nothing" — true of `capturedScreens.fixture.ts`,
        // and MISLEADING, because it reads as "no live approval draws `>`". One does:
        // `screenClassifier.test.ts` pins a FOUNDER-REPORTED approval that rendered `>` instead of
        // `❯`, which is why that file's own test catches such prompts by their FOOTER.
        //
        // So the bare `>` is a real render, not merely a blockquote or a degraded font — which
        // makes this assertion MORE load-bearing than version two credited, not less. What does not
        // change is the remedy: `SELECTION_CURSOR` still must not accept `>`, because every markdown
        // blockquote in scrollback is `> …` and three separate guards exist to keep it out. The
        // positive ownership rule needs no glyph at all — `> 1. Yes` is CONTENT, so a footer beneath
        // it is not ours whatever drew the cursor — and that is exactly what this pins.
        let bare_gt = format!(
            "❯ 1. {}\n  2. {}\n  3. {}\nDo you want to proceed?\n> 1. Yes\n  2. No\n{}",
            reset_label(),
            credits_label(),
            team_label(),
            PICKER_FOOTER
        );
        assert!(
            !screen_is_session_limit_picker(&bare_gt),
            "a bare `>` approval under scrolled-up options must not earn the exemption either"
        );
        assert_eq!(
            escape_refusal(Some(&Screen { text: &bare_gt, alternate: false })),
            Some(Refusal::AwaitingInput)
        );

        // SHORT dialog: the options and the live footer are only a few rows apart, so
        // MAX_OPTION_FOOTER_GAP cannot carry the decision on height alone.
        let short = format!(
            "❯ 1. {}\n  2. {}\n  3. {}\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No\n{}",
            reset_label(),
            credits_label(),
            team_label(),
            PICKER_FOOTER
        );
        assert_eq!(session_limit_options_present(&short), 3, "premise: all three labels present");
        assert!(
            !screen_is_session_limit_picker(&short),
            "a SHORT live approval under scrolled-up session-limit options must not earn the exemption"
        );
        assert_eq!(
            escape_refusal(Some(&Screen { text: &short, alternate: false })),
            Some(Refusal::AwaitingInput),
            "and the keystroke must still be refused"
        );
    }

    /// THE NARROWNESS TEST. Every ordinary captured picker — permission dialogs, AskUserQuestion
    /// menus, the `/model` picker — must still be refused. This is the case where a laxer matcher
    /// would have a machine cancel a tool approval a human was mid-answer on.
    #[test]
    fn an_ordinary_picker_never_earns_the_escape_exemption() {
        for name in [
            "APPROVAL_2_1_220",
            "APPROVAL_OPTION_2_2_1_220",
            "ASK_USER_QUESTION_2_1_220",
            "MODEL_PICKER_2_1_220",
        ] {
            let screen = fixture_screen(name);
            assert!(
                !screen_is_session_limit_picker(&screen),
                "{name} is not the session-limit picker"
            );
            assert_eq!(
                escape_refusal(Some(&Screen {
                    text: &screen,
                    alternate: false
                })),
                Some(Refusal::AwaitingInput),
                "{name} is an ordinary picker and must never be cancelled by a machine"
            );
        }
    }

    /// An IDLE finished turn earns no exemption either — Esc there is not harmful, but licensing it
    /// would mean the gate is answering "is this not obviously dangerous" instead of "is this the
    /// one screen the exemption is for".
    #[test]
    fn an_idle_prompt_earns_no_escape_exemption() {
        let idle = fixture_screen("IDLE_AFTER_TURN_2_1_220");
        assert_eq!(
            escape_refusal(Some(&Screen {
                text: &idle,
                alternate: false
            })),
            Some(Refusal::AwaitingInput),
        );
    }

    /// The bottom-anchor rule: a document QUOTING the picker keeps going underneath it.
    #[test]
    fn prose_continuing_beneath_the_picker_disqualifies_it() {
        let quoted = session_limit_screen(
            "❯",
            "\nThe screenshot shows Claude Code's session-limit picker rendered into the PTY.\n\
             Nothing unblocks these agents today, and the reason is measured rather than guessed.\n\
             The classifier is not the defect; three separate things throw its answer away.\n\
             This paragraph is what a real picker never has beneath it.",
        );
        assert!(
            !screen_is_session_limit_picker(&quoted),
            "a picker with a document continuing under it is a QUOTE, not a live dialog"
        );
    }

    /// The bottom-anchor admits only RECOGNIZED chrome, pinned on the SHAPE of the trailing row.
    ///
    /// `prose_continuing_beneath_the_picker_disqualifies_it` appends four lines, which fails the
    /// gate at 3 as well as at 0 — so it could not see the constant change, and reverting the Rust
    /// value was invisible (roborev 58159). `ported_typescript_patterns_have_not_drifted` asserts
    /// the TYPESCRIPT text, not this side's number. One non-blank row is the discriminating case,
    /// and it is the realistic one: a markdown fence closing beneath a quoted screen.
    #[test]
    fn one_non_blank_row_beneath_the_footer_disqualifies_it() {
        assert!(
            screen_is_session_limit_picker(&session_limit_screen("❯", "")),
            "precondition: the same screen with nothing beneath it IS the picker"
        );
        assert!(!screen_is_session_limit_picker(&session_limit_screen("❯", "```")));
        // A BLANK row beneath is still fine — the rule counts non-blank rows only.
        assert!(screen_is_session_limit_picker(&session_limit_screen("❯", "\n   ")));
    }

    /// `MAX_OPTION_FOOTER_GAP` — the "same rendered frame" rule, which shipped with no Rust test at
    /// all, so the branch could have been inverted or off by one and `cargo test` stayed green.
    /// Pinned on BOTH sides of the boundary so an off-by-one cannot pass.
    #[test]
    fn options_far_above_the_footer_do_not_pair_with_it() {
        // CONTRACT CHANGED DELIBERATELY (roborev 58527), not worked around. This asserted that a
        // gap of up to MAX_OPTION_FOOTER_GAP filled with TRANSCRIPT lines was "still the same
        // frame". That tolerance is exactly the vulnerability: a live dialog rendered a few rows
        // under a scrolled-up session-limit picker supplies the footer, the scrollback supplies the
        // labels and the cursor, and the distance bound is the only thing left — which holds on
        // fixture height, not on any property of the screen. A live Ink dialog renders contiguously;
        // the genuine article puts its footer immediately beneath option 3. So only WHITESPACE may
        // separate them, and the distance bound remains as a cheap outer guard.
        let framed = |gap: usize| {
            format!(
                "What do you want to do?\n❯ 1. {}\n  2. {}{}\n{PICKER_FOOTER}",
                reset_label(),
                credits_label(),
                "\n⏺ …transcript scrolled past.".repeat(gap.saturating_sub(1)),
            )
        };
        // Non-blank (non-decoration) rows between the options and the footer disqualify at ANY
        // distance — the footer belongs to whatever rendered them. The DISTANCE bound is pinned on
        // both sides below, on the blank path, which is the only one that still reaches it.
        assert!(
            !screen_is_session_limit_picker(&framed(MAX_OPTION_FOOTER_GAP)),
            "transcript between the options and the footer means the footer is not theirs"
        );
        assert!(!screen_is_session_limit_picker(&framed(MAX_OPTION_FOOTER_GAP + 1)));

        // …while BLANK separation is still one frame, and the distance bound still bites beyond it.
        let spaced = |blanks: usize| {
            format!(
                "What do you want to do?\n❯ 1. {}\n  2. {}\n  3. {}{}\n{PICKER_FOOTER}",
                reset_label(),
                credits_label(),
                team_label(),
                "\n".repeat(blanks),
            )
        };
        assert!(
            screen_is_session_limit_picker(&spaced(1)),
            "a blank line between the options and their own footer is still one dialog"
        );
        // BOTH SIDES OF THE BOUNDARY, on the blank path — the only path that still reaches the
        // distance bound now that non-blank rows are rejected outright. `spaced(n)` puts the footer
        // n+1 rows after the last option, so these are gap == MAX and gap == MAX + 1. Without the
        // pair, mutating `>` to `>=` or drifting the constant anywhere in 2..=10 stays green,
        // INCLUDING the loosening direction on a rule that arms a keystroke (roborev 58539).
        assert!(
            screen_is_session_limit_picker(&spaced(MAX_OPTION_FOOTER_GAP - 1)),
            "a gap of exactly MAX_OPTION_FOOTER_GAP is still one dialog"
        );
        assert!(
            !screen_is_session_limit_picker(&spaced(MAX_OPTION_FOOTER_GAP)),
            "one row beyond it, the footer belongs to something else"
        );

        // A BORDERED render: the box's spacer and bottom border are decoration, not content, so a
        // genuine picker inside a frame must still match. Every other matcher here tolerates
        // `[│|┃]?`, and the classifier's fixtures pin Claude Code's `╭─ … ─╮` menu as real.
        let boxed = format!(
            "╭──────────────╮\n│ What do you want to do? │\n│ ❯ 1. {} │\n│   2. {} │\n│   3. {} │\n│              │\n│ {PICKER_FOOTER} │\n╰──────────────╯",
            reset_label(),
            credits_label(),
            team_label()
        );
        assert!(
            screen_is_session_limit_picker(&boxed),
            "a bordered session-limit picker is still the session-limit picker"
        );
    }

    /// THE OTHER BORDERED RENDER: the footer drawn BENEATH the closed box rather than inside it.
    ///
    /// This is the case where the accommodation and the ownership rule genuinely pull against each
    /// other, and roborev 58557 was right that it passed while nothing pinned it. A `╰────╯`
    /// between the last option and the footer is positive evidence the footer rendered OUTSIDE the
    /// options' frame — so is it a second dialog?
    ///
    /// No, and the reason is asymmetric. A CLOSING border says only that the frame we already
    /// matched ended; Ink routinely draws a menu's hint line just below its box, which is exactly
    /// this shape. An OPENING border would say a new frame STARTS, and that is the one we reject.
    /// The pair of tests below is the contract: closing → still ours, opening → never ours.
    #[test]
    fn a_footer_beneath_the_closed_box_is_still_this_dialog() {
        let footer_below = format!(
            "╭──────────────╮\n│ ❯ 1. {} │\n│   2. {} │\n│   3. {} │\n╰──────────────╯\n{PICKER_FOOTER}",
            reset_label(),
            credits_label(),
            team_label()
        );
        assert!(
            screen_is_session_limit_picker(&footer_below),
            "a hint line drawn just beneath a menu's closed box is that menu's own footer"
        );
    }

    /// AN OPENING BORDER IS NEVER SEPARATION — the half that actually guards the keystroke.
    #[test]
    fn an_opening_border_between_the_options_and_the_footer_disqualifies() {
        let new_frame = format!(
            "❯ 1. {}\n  2. {}\n  3. {}\n╭──────────────╮\n{PICKER_FOOTER}",
            reset_label(),
            credits_label(),
            team_label()
        );
        assert!(
            !screen_is_session_limit_picker(&new_frame),
            "a box that OPENS between our options and a footer means that footer is the new box's"
        );
    }

    /// THE TRAILING BUDGET IS BOUNDED, which my first version of the border accommodation was not.
    ///
    /// Discounting every decoration row without limit spent slack in the direction
    /// the bottom-anchor's own doc block refuses. The first case is the concrete regression
    /// roborev 58557 named: a scrolled-past picker whose viewport clips the TOP border of the live
    /// input box below scored zero trailing rows and armed `Esc` at whatever was live underneath.
    #[test]
    fn decoration_below_the_footer_is_bounded_to_one_closing_row() {
        let with_trailing = |trailing: &str| {
            format!(
                "❯ 1. {}\n  2. {}\n  3. {}\n{PICKER_FOOTER}\n{trailing}",
                reset_label(),
                credits_label(),
                team_label()
            )
        };

        // The one row the accommodation exists for.
        assert!(
            screen_is_session_limit_picker(&with_trailing("╰──────────────╯")),
            "the dialog's own closing border beneath its footer is free"
        );
        // …and only one.
        assert!(
            screen_is_session_limit_picker(&with_trailing("╰──────────────╯\n────────────────")),
            "a rule BELOW the closing border is ambient chrome — the real screen draws one"
        );
        assert!(
            !screen_is_session_limit_picker(&with_trailing("╰──────────────╯\n╰──────────────╯")),
            "but a SECOND closing border is not chrome, and the border budget is one"
        );
        // The clipped live input box. Decoration by shape, a live dialog by meaning.
        assert!(
            !screen_is_session_limit_picker(&with_trailing("╭──────────────╮")),
            "an OPENING border below the footer is another dialog starting, never free"
        );
        // Blank rows were free before this change and stay free, at any length.
        assert!(
            screen_is_session_limit_picker(&with_trailing("\n\n\n")),
            "blank rows beneath the footer were always ignored and still are"
        );

        // THE BUDGET IS ONE, asserted with rows that BOTH satisfy the closing-border conjunct.
        //
        // The `╰──╯` + `────` case below pins the closing-glyph rule, not the budget: its second
        // row fails `is_closing_border`, so it would still return false with the budget deleted
        // outright. Adding that conjunct silently un-pinned the counter it sits next to — the
        // "a fix makes an existing guard unable to fail" shape — and a scrolled-past picker
        // trailing several `╰──╯` rows would have scored zero and armed Esc (roborev 58581).
        assert!(
            !screen_is_session_limit_picker(&with_trailing("╰──────────────╯\n╰──────────────╯")),
            "TWO closing borders is one more than the budget, whatever their shape"
        );

        // A CLOSING BORDER WITH CONTENT ON THE SAME ROW IS NOT DECORATION — the `is_separator_row`
        // conjunct's own pin, and the THIRD one in this condition to need it (roborev 58615).
        // Nothing in the corpus was a row carrying both content and a closing glyph, so that
        // conjunct was deletable with every test green. Ink labels its borders — `╰─ press ? for
        // help ─╯`, `└─ tests ─┘` — and discounting one would score zero with genuine content
        // sitting beneath the footer, which is the exact claim the bottom-anchor rule makes.
        assert!(
            !screen_is_session_limit_picker(&with_trailing("╰──────────────╯ 3 files changed")),
            "a closing border with CONTENT on the same row is content, not decoration"
        );

        // A ROW THAT CLOSES OURS AND OPENS ANOTHER IS NEVER FREE — the `!is_opening_border`
        // conjunct's own pin (roborev 58608). Every other trailing case reaches `false` through the
        // closing-border rule first, including the lone `╭──────╮`, so that sibling conjunct could
        // be deleted from the Rust loop with every test still green — the same un-pinning the
        // closing conjunct did to the budget one round earlier, one conjunct over. Side-by-side
        // boxes are a shape this repo has captured, and spending the slot on one would score zero
        // and arm Esc at a frame that just started.
        assert!(
            !screen_is_session_limit_picker(&with_trailing("╰──────────────╯╭──────────────╮")),
            "a row that closes our frame AND opens another is never free"
        );

        // THE SLOT IS FOR A CLOSING BORDER, NOT FOR DECORATION IN GENERAL (roborev 58571).
        //
        // `is_separator_row && !is_opening_border` freed any row of the separator class, and that
        // class contains `─` — the full-width TRANSCRIPT DIVIDER the real TUI draws between
        // segments, captured in `capturedScreens.fixture.ts` directly above "Session limit
        // reached". A divider beneath the footer is the same "a different frame starts here"
        // evidence `is_opening_border` was added to reject, and it was consuming the slot and
        // scoring zero. Before the border work it counted, and the gate refused. These two cases
        // are the difference between the budget's NAME and its behaviour.
        // THE CONTRACT CHANGED HERE, deliberately (bead `sparkle-d2i0c`). A bare rule used to be
        // rejected on the reasoning that it "closes nothing". That reasoning was sound and the
        // premise was wrong: the real session-limit picker draws rules, the composer and status
        // bars beneath its footer, so rejecting them rejects the one screen this gate exists for.
        assert!(
            screen_is_session_limit_picker(&with_trailing("────────────────")),
            "a rule beneath the footer is ambient chrome, and the real screen draws one"
        );
        assert!(
            !screen_is_session_limit_picker(&with_trailing("│")),
            "a lone frame side is neither a closing border nor recognized chrome"
        );

        // THE REAL SCREEN, which the zero-row rule rejected: a rule, the composer, a rule, and two
        // status bars stacked beneath the footer. This is the case bead `sparkle-d2i0c` is about.
        let real_tail = "────────────────\n│ ❯\n────────────────\n⏸ plan mode\n✻ 2 agents";
        assert!(
            screen_is_session_limit_picker(&with_trailing(real_tail)),
            "five rows of persistent chrome beneath the footer is the REAL captured screen"
        );
        // …but the tail is BOUNDED, and prose is not chrome however much of it there is.
        let too_much = (0..MAX_CHROME_BELOW_FOOTER + 1)
            .map(|_| "────────────────")
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !screen_is_session_limit_picker(&with_trailing(&too_much)),
            "one row past MAX_CHROME_BELOW_FOOTER stops being a dialog at the bottom of the grid"
        );
        assert!(
            !screen_is_session_limit_picker(&with_trailing("and then the document keeps going")),
            "prose beneath the footer is not chrome — this is what keeps the gate off documents"
        );

        // A RULE IS CHROME ONLY WHEN THE RULE IS THE WHOLE ROW (knightwatch probe 1 on PR #1290).
        // Matching a four-glyph prefix and ignoring the rest discounts a LIVE PROMPT as decoration
        // and arms Esc at it. BOTH rule alternatives leaked this way — the bare run and the framed
        // run — and so did the TS pattern this was ported from.
        for tail in ["──── Do you want to continue?", "│ ──── Do you want to continue?"] {
            let screen = with_trailing(tail);
            assert!(
                !screen_is_session_limit_picker(&screen),
                "{tail:?}: a rule with a live prompt after it is content, not chrome"
            );
            assert_eq!(
                escape_refusal(Some(&Screen { text: &screen, alternate: false })),
                Some(Refusal::AwaitingInput),
                "{tail:?}: …and the keystroke must be refused"
            );
        }
        // The status-glyph alternative is deliberately NOT anchored: a status bar is a glyph
        // followed by its own text, so anchoring it would reject the real screen.
        assert!(
            screen_is_session_limit_picker(&with_trailing("⏸ plan mode")),
            "a status glyph with its label is chrome — why alternative 1 carries no anchor"
        );
    }

    /// EVERY GLYPH IN THE CLOSING CLASS CAN ACTUALLY SPEND THE SLOT, one at a time.
    ///
    /// Four of the six were UNREACHABLE when this class was added: the slot is only ever spent as
    /// `is_separator_row && is_closing_border`, and the separator class carried no square or heavy
    /// bottom corner, so `└────┘` failed the first conjunct and the picker went unrecognised on a
    /// render this repo has captured. Fail-closed, so never a safety hole — but a false negative,
    /// and the drift test had frozen the dead half of the class into both ports (roborev 58581).
    #[test]
    fn each_closing_glyph_can_spend_the_trailing_slot() {
        // ONE AT A TIME, not in pairs. The first version iterated `('╰','╯')`, `('└','┘')`,
        // `('┗','┛')` and put BOTH members on every row — and `is_closing_border` is an `any()`,
        // so dropping `╯`, `┘` or `┛` from the class left all three rows matching on their
        // left-hand partner and both suites green. Half the class was still unexercised, which is
        // the exact defect the previous round asked this test to fix (roborev 58608).
        for glyph in ['╰', '╯', '└', '┘', '┗', '┛'] {
            let trailing = format!("{glyph}──────────────");
            let screen = format!(
                "❯ 1. {}\n  2. {}\n  3. {}\n{PICKER_FOOTER}\n{trailing}",
                reset_label(),
                credits_label(),
                team_label()
            );
            assert!(
                screen_is_session_limit_picker(&screen),
                "{trailing:?} closes a frame, so it must be able to spend the one free slot"
            );
        }
    }

    /// EVERY GLYPH IN THE SEPARATOR CLASS IS LOAD-BEARING, asserted one at a time.
    ///
    /// The bordered fixtures above exercise `│` and space only, so deleting `┃ ━ ┄ ┈ ═ |` from
    /// either port left both suites green (roborev 58557). A class member nothing exercises is a
    /// class member that can be dropped by accident.
    #[test]
    fn each_separator_glyph_counts_as_separation() {
        for glyph in [
            '│', '|', '┃', '─', '━', '┄', '┈', '═', '╰', '╯', '└', '┘', '┗', '┛',
        ] {
            let gapped = format!(
                "❯ 1. {}\n  2. {}\n  3. {}\n{glyph}\n{PICKER_FOOTER}",
                reset_label(),
                credits_label(),
                team_label()
            );
            assert!(
                screen_is_session_limit_picker(&gapped),
                "{glyph:?} is in the separator class, so a row of it must not break ownership"
            );
        }
        // The opening corners are in the class too, but they are separation NOWHERE.
        for glyph in ['╭', '╮', '┌', '┐', '┏', '┓'] {
            let gapped = format!(
                "❯ 1. {}\n  2. {}\n  3. {}\n{glyph}\n{PICKER_FOOTER}",
                reset_label(),
                credits_label(),
                team_label()
            );
            assert!(
                !screen_is_session_limit_picker(&gapped),
                "{glyph:?} OPENS a frame, so it is content no matter how box-drawn it looks"
            );
        }
    }

    /// The cursor must sit on an OPTION ROW OF THIS DIALOG. Against the whole grid, an unrelated
    /// permission menu still in the viewport satisfied the gate for a picker nobody was highlighted
    /// on (roborev 58159).
    #[test]
    fn a_cursor_on_some_other_menu_does_not_count() {
        let elsewhere = format!(
            "❯ 1. Yes\n  2. No\n\nWhat do you want to do?\n  1. {}\n  2. {}\n{PICKER_FOOTER}",
            reset_label(),
            credits_label(),
        );
        assert!(
            selection_cursor().is_match(&elsewhere),
            "precondition: a cursor IS present on the grid, just not on this dialog's options"
        );
        assert!(!screen_is_session_limit_picker(&elsewhere));
    }

    /// A blockquoted reproduction renders its cursor as a bare `>`, which the SHARED
    /// `selection_cursor` deliberately rejects.
    #[test]
    fn a_blockquoted_picker_is_not_a_picker() {
        let quoted = session_limit_screen(">", "");
        assert!(!selection_cursor().is_match(&quoted));
        assert!(!screen_is_session_limit_picker(&quoted));
    }

    /// The PRD's de-fanged reproduction, by shape: a bare `>` cursor, U+200B inside each keyword,
    /// and a rewritten footer. Any one of the three is disqualifying; all three hold.
    #[test]
    fn the_defanged_reproduction_shape_is_not_a_picker() {
        let defanged = concat!(
            "What do you want to do?\n",
            "> 1. Stop and wait for limit to rese\u{200b}t\n",
            "  2. Switch to usage credit\u{200b}s\n",
            "  3. Switch to Team pla\u{200b}n\n",
            "[confirm-key] to confirm / [cancel-key] to cancel",
        );
        assert_eq!(
            session_limit_options_present(defanged),
            0,
            "the zero-width spaces must defeat every label — not merely the mandatory one"
        );
        assert!(!screen_is_session_limit_picker(defanged));
        assert_eq!(
            escape_refusal(Some(&Screen {
                text: defanged,
                alternate: false
            })),
            Some(Refusal::AwaitingInput),
        );
    }

    #[test]
    fn one_option_label_alone_is_not_a_picker() {
        let alone = format!("What do you want to do?\n❯ 1. {}\n{PICKER_FOOTER}", reset_label());
        assert_eq!(session_limit_options_present(&alone), 1);
        assert!(!screen_is_session_limit_picker(&alone));
    }

    /// The two "Switch to …" labels are generic enough to belong to some other settings picker, so
    /// the reset label is mandatory rather than merely one of three.
    #[test]
    fn the_billing_options_without_the_reset_option_are_not_a_picker() {
        let billing = format!(
            "What do you want to do?\n❯ 1. {}\n  2. {}\n{PICKER_FOOTER}",
            credits_label(),
            team_label(),
        );
        assert_eq!(session_limit_options_present(&billing), 2);
        assert!(!screen_is_session_limit_picker(&billing));
    }

    /// A footer ABOVE the options belongs to an earlier frame still on screen, not to this dialog.
    #[test]
    fn a_footer_above_the_options_does_not_count() {
        let inverted = format!(
            "{PICKER_FOOTER}\nWhat do you want to do?\n❯ 1. {}\n  2. {}",
            reset_label(),
            credits_label(),
        );
        assert!(!screen_is_session_limit_picker(&inverted));
    }

    /// The exemption fails closed on every unknown, in the documented order.
    #[test]
    fn the_escape_exemption_fails_closed() {
        assert_eq!(escape_refusal(None), Some(Refusal::NoViewport));

        // A full-screen app that is not Claude Code's own prompt.
        assert_eq!(
            escape_refusal(Some(&Screen {
                text: &session_limit_screen("❯", ""),
                alternate: true
            })),
            Some(Refusal::AlternateScreen),
            "a picker rendered inside an alternate buffer we cannot attribute to Claude Code is \
             unreadable evidence, not a licence"
        );

        // A picker AND a spinner on the same grid is a stale or garbled read, and Esc into a
        // running turn cancels the turn.
        let working = format!(
            "{}\n✻ Churning… (12s · esc to interrupt)",
            session_limit_screen("❯", "")
        );
        assert_eq!(
            escape_refusal(Some(&Screen {
                text: &working,
                alternate: false
            })),
            Some(Refusal::Working),
        );

        // Credentials outrank the picker, exactly as in `write_refusal`.
        //
        // The prompt sits ABOVE the dialog deliberately. Unrecognized rows are rejected, so anything
        // printed BENEATH the footer disqualifies the frame outright — which would make this test
        // pass for the wrong reason (the recogniser failing, not the ordering holding). Above, the
        // `password:` line still matches `write_block_password_colon` (it is `(?m)`-anchored per
        // line, not tail-scoped), so both facts are true at once and the ordering is what decides.
        let credential = format!(
            "Enter your password:\n{}",
            session_limit_screen("❯", "")
        );
        assert!(
            screen_is_session_limit_picker(&credential),
            "precondition: the picker itself still matches, so the CredentialPrompt below is the \
             ordering doing the work rather than the recogniser failing"
        );
        assert!(
            screen_shows_credential_prompt(&credential),
            "precondition: the credential prompt is genuinely detected on this frame"
        );
        assert_eq!(
            escape_refusal(Some(&Screen {
                text: &credential,
                alternate: false
            })),
            Some(Refusal::CredentialPrompt),
        );
    }

    /// THE SAFETY TEST. The only key any recovery path may send is `Esc`.
    ///
    /// Written to FAIL if someone later made the resume press "1": the assertion is on the byte
    /// alphabet, not on the constant's name, so renaming it or repointing it at an option digit
    /// both go red. Options 2 and 3 on that picker move the user onto paid overage and change their
    /// subscription; there is no recovery worth pressing them for.
    #[test]
    fn the_only_key_the_gate_licenses_is_escape() {
        assert_eq!(ESCAPE_KEY, "\u{1b}");
        assert_eq!(ESCAPE_KEY.len(), 1, "one byte — no chorded or suffixed key");
        assert!(
            !ESCAPE_KEY.chars().any(|c| c.is_ascii_digit()),
            "a digit here selects a BILLING option"
        );
        assert!(
            !ESCAPE_KEY.contains('\r') && !ESCAPE_KEY.contains('\n'),
            "a carriage return CONFIRMS whichever option the cursor sits on"
        );
    }

    // ══ THE PORT IS STILL A PORT ════════════════════════════════════════════════════════════════

    /// Assert the TypeScript patterns this module transcribed have NOT changed underneath it.
    ///
    /// This is the honest half of the drift story. The corpus tests above prove the Rust gate
    /// handles the screens we have captured; this proves nobody has edited the TS matchers since
    /// the port without a Rust change. When it fails, the fix is to port the edit — not to update
    /// the expected string.
    #[test]
    fn ported_typescript_patterns_have_not_drifted() {
        let classifier = ts(TS_CLASSIFIER);
        let route = ts(TS_ROUTE);

        for needle in [
            // screenClassifier.ts
            r"const SELECTION_CURSOR = /^\s*[│|]?\s*[❯›]\s*\d+\.\s/m;",
            // The two border predicates decide what counts as "no content" on the rule that arms
            // the keystroke, and pinning only their CALL SITES left the character classes free to
            // drift: add `>` to SEPARATOR_ROW, or drop `╰╯─`, and every call-site needle still
            // matched verbatim while the ports silently disagreed on which screens are pickers
            // (roborev 58557). The Rust side is the one that presses the key, so a TS-side
            // NARROWING leaves this gate strictly more permissive than the classifier meant to
            // bound it. Byte-for-byte, like every other ported regex here.
            r"const SEPARATOR_ROW = /^[\s│|┃╭╮╰╯┌┐└┘┏┓┗┛─━┄┈═]*$/;",
            r"const OPENING_BORDER = /[╭╮┌┐┏┓]/;",
            r"const CLOSING_BORDER = /[╰╯└┘┗┛]/;",
            r"/[([]y\/n[)\]]/i,",
            r"/press enter to continue/i,",
            r"/\boverwrite\?/i,",
            r"/(^|\s)password:\s*$/im,",
            r"/enter passphrase/i,",
        ] {
            assert!(
                classifier.contains(needle),
                "screenClassifier.ts changed a pattern this module ported: {needle}\n\
                 Port the change into nudge_gate.rs rather than editing this expectation."
            );
        }

        // STRUCTURE, not just literals. The loop above pins the ported REGEXES; it says nothing
        // about the RULES built on them — which is how the two ports came to disagree in the first
        // place. `screenClassifier.ts` grew the same four-rule session-limit matcher, and the
        // dialog-OWNERSHIP rule (a foreign cursored option row between the options and the footer
        // means that footer is not ours) existed in neither until a live Esc-exemption gap was found
        // on main. Deleting it from the TS side would leave every literal intact and this test green,
        // so pin the rule itself: these are the load-bearing fragments of each rule, chosen to be
        // stable under formatting.
        // VACUOUS-NEEDLE FIX (knightwatch probe 2 on PR #1261). The first three needles here were
        // BARE IDENTIFIERS — `MAX_OPTION_FOOTER_GAP`, `MAX_CHROME_BELOW_FOOTER`,
        // `isSessionLimitOptionLine` — and screenClassifier.ts IMPORTS all three (lines 26/27/29).
        // So each one matched the import statement, and every assertion below stayed green with the
        // rule BODIES deleted outright: precisely the "assertion was already true before the
        // change" shape AGENTS.md calls the #1 fleet-wide finding. Pin the USE SITE instead — an
        // expression cannot survive in a file whose rule has been removed.
        for needle in [
            // Rule 2a (TS's own numbering — the labels here were swapped, roborev 58564).
            "footerAt - lastOption > MAX_OPTION_FOOTER_GAP",
            // Rule 2b — bottom-anchored.
            "if (!AMBIENT_CHROME_LINE.test(line) || chromeBelow >= MAX_CHROME_BELOW_FOOTER) return false;",
            // Rule 1 — the cursor must sit on OUR option row, not a foreign dialog's.
            //
            // The scan-loop `continue` was pinned here first, and it was VACUOUS in the same way
            // the bare identifiers were: that loop must survive to compute `lastOption` for the
            // footer search and the distance bound, so reverting roborev 58159 — back to testing
            // SELECTION_CURSOR against the WHOLE snapshot, the widening that let a permission menu
            // hundreds of rows above satisfy this rule — left the needle matching byte-for-byte.
            // Mutation-verified: deleting both lines below kept the drift test green. Pin the two
            // that cannot outlive the rule (roborev 58564/58571).
            "if (SELECTION_CURSOR.test(lines[i]!)) cursorOnOption = true;",
            "if (lastOption < 0 || !cursorOnOption) return false;",
            "if (!isSessionLimitOptionLine(lines[i]!)) continue;",
            // The ownership rule. Deleting this loop is the regression this line exists to catch.
            "for (let i = lastOption + 1; i < footerAt; i++) {",
            "if (!isSeparatorRow(lines[i]!) || isOpeningBorder(lines[i]!)) return false;",
            // The bounded trailing budget. An unbounded decoration discount is the regression.
            "if (isOpeningBorder(line)) return false;",
            "isSeparatorRow(line) && isClosingBorder(line) && closingBorderBudget > 0",
            // THE BUDGET ITSELF. Adding the `isClosingBorder` conjunct silently un-pinned it: the
            // only case that had exercised it used a bare `────` as its second row, which now fails
            // the new conjunct, so it returns false for a reason unrelated to the budget and the
            // whole budget could be deleted with both suites green (roborev 58581). Pinned here and
            // asserted behaviourally by the two-closing-borders case in both ports.
            "closingBorderBudget > 0",
            "closingBorderBudget--;",
        ] {
            assert!(
                classifier.contains(needle),
                "screenClassifier.ts dropped a session-limit RULE this module mirrors: {needle}\n\
                 The two ports gate the same keystroke exemption; they must agree on the rules, not \
                 merely on the regexes. Port the change into nudge_gate.rs rather than editing this \
                 expectation."
            );
        }

        for needle in [
            // dictationTerminalRoute.ts
            r"/\bpass(word|phrase)\b[^\n]*:\s*$/im,",
            // THE WHOLE DECLARATION, not the bare literal (roborev 58550). This pattern moved out of
            // the array into its own const, because the TS side excludes that arm BY OBJECT IDENTITY
            // and a duplicate literal is a different object. A first cut simply dropped the trailing
            // comma — which also dropped the only RIGHT-ANCHOR the needle had: `contains` is a
            // substring test, so `/i` still matched `/im`, `/gi`, `/iu`, and the guard stayed green
            // through a flag edit. That is not theoretical: these regexes are shared objects whose
            // `.test()` is called repeatedly, so adding `g` makes matching stateful via `lastIndex`
            // and a `(yes/no)` screen would start blocking on alternate calls — an intermittent hole
            // in the write gate, with the drift guard reporting no drift.
            //
            // The trailing `;` restores the end-anchor AND re-asserts the pattern is still a
            // standalone const, which is the invariant the identity filter actually depends on.
            // Mirrors the detector's `YN` in spelling AND whitespace. Deliberately a DUPLICATE
            // rather than an import — eight suites mock the heuristics module without supplying
            // `YN`, so a module-scope alias reads `undefined` at import time and kills them at
            // collection. `suggestions/yesNoAgreement.test.ts` polices the duplication; the
            // heuristics block after this loop pins the other TS copy.
            r"const YES_NO_PROMPT = /\by\s*\/\s*n\b|\byes\s*\/\s*no\b/i;",
            r#"/\btype\s+["']?yes["']?\b/i,"#,
            r"pass(word|phrase|code)|username|token|otp|one[-\s]?time\s+(code|password)|verification\s+code|2fa|two[-\s]?factor|pin",
        ] {
            assert!(
                route.contains(needle),
                "dictationTerminalRoute.ts changed a pattern this module ported: {needle}\n\
                 Port the change into nudge_gate.rs rather than editing this expectation."
            );
        }

        // ── THE SHARED yes/no PATTERN, AT ITS REAL HOME ─────────────────────────────────────────
        // `dictationTerminalRoute`'s `YES_NO_PROMPT` is an alias of this, so pinning the alias alone
        // would let the actual pattern be widened or narrowed with the guard still green. That is not
        // hypothetical in the other direction: the arm USED to be a narrower local literal matching
        // only `(yes/no`, which left `(y/n)` confirmations refused by nothing.
        let heuristics = ts(TS_HEURISTICS);
        for needle in [r"export const YN = /\by\s*\/\s*n\b|\byes\s*\/\s*no\b/i;"] {
            assert!(
                heuristics.contains(needle),
                "heuristics.ts changed the yes/no pattern this module ported: {needle}\n\
                 It is shared with dictationTerminalRoute's write guard. Port the change into \
                 nudge_gate.rs rather than editing this expectation."
            );
        }

        // ── THE SESSION-LIMIT MATCHER ───────────────────────────────────────────────────────────
        // Enrolled here alongside `selection_cursor` / `footer_legacy` because the exemption it
        // grants — one `Esc` at a screen every other rule refuses — is only as safe as its
        // narrowness, and a TS-side widening that never reached this port would leave the Rust gate
        // exempting screens the TS classifier does not consider session-limit pickers at all.
        let session_limit = ts(TS_SESSION_LIMIT);
        for needle in [
            r"/^\s*[│|]?\s*[❯›]?\s*\d+\.\s+stop and wait for (?:the )?limit to reset\b/im;",
            r"/^\s*[│|]?\s*[❯›]?\s*\d+\.\s+switch to usage credits\b/im;",
            r"/^\s*[│|]?\s*[❯›]?\s*\d+\.\s+switch to team plan\b/im;",
        ] {
            assert!(
                session_limit.contains(needle),
                "sessionLimitScreen.ts changed a pattern this module ported: {needle}\n\
                 Port the change into nudge_gate.rs rather than editing this expectation."
            );
        }
        // The two thresholds are as load-bearing as the patterns: MIN_OPTIONS_PRESENT is what stops
        // one generic label from qualifying, and MAX_CHROME_BELOW_FOOTER bounds the tail that
        // stops prose quoting the picker from matching. A TS-side relaxation of either without the
        // matching Rust change is a silent widening of the exemption.
        // DERIVED FROM THE RUST CONSTANTS, not hardcoded. These read `= 2;` / `= 0;` / `= 8;` as
        // literals, which pinned the TS value against a number typed twice — so a drift on the RUST
        // side sailed through and the ports could disagree on the very thresholds this test exists
        // to keep in step. Measured: setting MAX_OPTION_FOOTER_GAP to 1000 left all 36 tests green,
        // because the boundary tests build their input RELATIVE to the constant and therefore scale
        // with it. That is the half of roborev 58539's second finding ("drifting the constant
        // anywhere in 2..=10 stays green") that re-pinning the boundary could not reach: the
        // boundary tests pin the off-by-one, and only this loop can pin the VALUE.
        for needle in [
            format!("export const MIN_OPTIONS_PRESENT = {MIN_OPTIONS_PRESENT};"),
            format!("export const MAX_CHROME_BELOW_FOOTER = {MAX_CHROME_BELOW_FOOTER};"),
            format!("export const MAX_OPTION_FOOTER_GAP = {MAX_OPTION_FOOTER_GAP};"),
            r#"export const SESSION_LIMIT_REASON = "session-limit-picker";"#.to_string(),
        ] {
            assert!(
                session_limit.contains(&needle),
                "sessionLimitScreen.ts and nudge_gate.rs disagree on a ported constant: {needle}\n\
                 This needle is DERIVED from the Rust constant, so this fires in BOTH directions — \
                 either the TS value drifted, or the Rust value did. Change the two together."
            );
        }

        // The shell-prompt list is the one most likely to GROW. Count its entries so a new arm
        // fails here instead of being silently absent from the Rust port.
        let shell_block = classifier
            .split("const SHELL_PROMPTS: RegExp[] = [")
            .nth(1)
            .and_then(|s| s.split("];").next())
            .expect("SHELL_PROMPTS list not found");
        assert_eq!(
            shell_block.matches("/i").count(),
            5,
            "SHELL_PROMPTS gained or lost an arm; nudge_gate.rs ports all of them individually"
        );
    }
}
