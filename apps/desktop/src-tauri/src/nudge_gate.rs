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
pattern!(write_block_yes_no, r"(?i)\(\s*yes\s*/\s*no");
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
    const TS_FIXTURE: &str = "../src/engine/capturedScreens.fixture.ts";

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

        for needle in [
            // dictationTerminalRoute.ts
            r"/\bpass(word|phrase)\b[^\n]*:\s*$/im,",
            r"/\(\s*yes\s*\/\s*no/i,",
            r#"/\btype\s+["']?yes["']?\b/i,"#,
            r"pass(word|phrase|code)|username|token|otp|one[-\s]?time\s+(code|password)|verification\s+code|2fa|two[-\s]?factor|pin",
        ] {
            assert!(
                route.contains(needle),
                "dictationTerminalRoute.ts changed a pattern this module ported: {needle}\n\
                 Port the change into nudge_gate.rs rather than editing this expectation."
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
