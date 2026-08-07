//! Reading knightwatch's review probes for a PR, so the merge action can refuse to land work that
//! still carries an unanswered `[blocking]` probe.
//!
//! WHY THIS EXISTS: measured over the last 40 merged PRs in this repo, 39 carried a knightwatch
//! review, 24 carried at least one `[blocking]` probe (40 probes in total), and ALL 24 merged with
//! zero probe-citing reply. Nothing stopped them. GitHub branch protection is not available on this
//! plan (`repos/…/branches/main/protection` → 403 "Upgrade to GitHub Pro"), so a required status
//! check is not an option — but Sparkle owns the merge action, and [`crate::worktree::merge_pr`] is
//! the single sink for all six in-app merge paths (three UI buttons, the concierge tool, the
//! approval-resume path, and MCP). Gating there covers every one of them at once.
//!
//! THE PARSING CONTRACT IS FROZEN AND SHARED. `scripts/tests/fixtures/knightwatch/` holds the
//! corpus and `expected.json` holds the verdicts; the tests at the bottom of this file assert
//! against those exact files, and a shell implementation asserts against the same ones. That shared
//! corpus is the only thing keeping the two from drifting, so a number that looks wrong is a
//! conversation, never an edit.
//!
//! The four rules, each validated against real data:
//!
//!   1. A comment is a knightwatch REVIEW iff its body contains [`REVIEW_MARKER`]. The bot posts
//!      under a REAL HUMAN's account, so author equality is not a bot test in either direction —
//!      the marker is the ONLY discriminator (`impostor-no-marker.json` is that case).
//!   2. A probe is a line matching `^(\d+)\.\s+\[(blocking|open)\]`, optionally followed by
//!      `[from: <specialist>]`. Numbering RESTARTS in every review, so probe identity is
//!      `(comment_id, index)` and never the index alone.
//!   3. A probe is ANSWERED iff some NON-knightwatch comment posted AFTER that review and BEFORE
//!      the next knightwatch review cites it by number, case-insensitively:
//!      `\bprobes?\s*#?\s*<N>\b`. A later knightwatch comment can NEVER answer a probe — otherwise
//!      the bot clears its own gate (`self-answer-does-not-count.json`). NEITHER can one of THIS
//!      module's own override records ([`OVERRIDE_MARKER`]): a bypass is the opposite of an answer,
//!      and a record that named its probes in citation form would silently answer them on the next
//!      read — so a second merge attempt after a failed one would sail through with no refusal and
//!      no second record. Both halves are guarded: the record is excluded from the replier set, AND
//!      it names probes in a form the grammar does not match.
//!   4. WHOLE bodies are scanned. Real data (PR #1104) puts a citation more than 1500 chars into a
//!      reply; truncating the scan loses answers and turns an answered probe into a false refusal.
//!      BLOCKQUOTED lines are the one exception: a citation that exists only inside a `>` line is
//!      somebody else's words being shown, not an answer. Without that, the hole in rule 3 reopens
//!      one indirection out — the override record quotes the user's own reason, which may itself
//!      name the probe, so any bystander quoting the record would clear it by accident.
//!
//! TWO REFINEMENTS ABOVE ARE NOT YET IN THE SHARED CORPUS, and a second implementation built from
//! `expected.json` alone will get them wrong while passing every case in it: the override-record
//! test is ANCHORED (`trim_start().starts_with`, never `contains` — a `contains` form silently drops
//! a human's quote-reply answer and produces a false refusal), and the blockquote rule in 4. The
//! three fixtures that would pin them are specified in `PRD/sparkle/knightwatch-probe-gate.md`;
//! `scripts/` belongs to another worker, so they are escalated rather than added here.
//!
//! Lifecycle status posts (`👀 reviewing`, `⏸ knightwatch paused`, `⏭ review superseded`) carry the
//! marker but list no probes, so they need no special-casing — they contribute zero probes.
//!
//! THREE STATES, NEVER TWO — the same discipline as [`crate::roborev_probe`] and
//! `services/mergeGuard/types.ts`, and it is load-bearing here:
//!
//!   * NOT-APPLICABLE — the read SUCCEEDED and the PR carries no knightwatch comment at all
//!     (`applicable: false`). Every non-Sparkle project is in this state and must merge freely.
//!   * UNKNOWN — the `gh` read FAILED, or came back saturated (`applicable: true, probes: None`).
//!     This BLOCKS, consistent with the sibling roborev gate's "unknown blocks" doctrine, and it is
//!     survivable because the override below exists.
//!   * AUTHORITATIVE — `probes: Some(_)`, where `Some([])` means "asked; this PR has no probes".
//!
//! Collapsing UNKNOWN into either neighbour reintroduces exactly the hole this module closes.
//!
//! WHERE THE `[open]` WARNING GOES. `[open]` probes WARN and never block: knightwatch's own guidance
//! treats `[open]` as a requirement to ANSWER rather than to fix, and blocking every one of them
//! would stall the founder. `merge_pr` returns `Result<(), String>`, which has nowhere to put a
//! warning on a success — so the choice made here, deliberately, is TWO channels:
//!
//!   * `tracing::warn!(target: "knightwatch", …)` on the merge path, naming each unanswered `[open]`
//!     probe. That is the record; it does not block and it cannot fail the merge.
//!   * [`knightwatch_probe_gate`], a `#[tauri::command]` that returns the WHOLE reading (blocking
//!     and open, answered and not) for one PR. **This is the hook for the TypeScript side**: call
//!     `invoke("knightwatch_probe_gate", { root, number })` to surface open probes in the UI before
//!     or after a merge. Nothing in TS is required for the gate itself to work — the refusal travels
//!     on `merge_pr`'s `Err` — so surfacing the warning is a later, independent pass.

use std::process::Command;
use std::time::Duration;

/// The ONLY discriminator for a knightwatch review. See rule 1 in the module header: the bot posts
/// under a human account, so `login` proves nothing in either direction.
const REVIEW_MARKER: &str = "<!-- knightwatch-reviewer:auto-post -->";

/// Stamped into the comment that records an override, in the [`crate::pr_owner`] marker style: one
/// line, machine-findable, invisible in rendered markdown.
pub const OVERRIDE_MARKER: &str = "<!-- sparkle:probe-gate-override -->";

/// Bound the comment read. A paginated GitHub read of a busy PR is a handful of round-trips; the
/// case this guards is a hung remote, where a merge gate that hangs is worse than one that says
/// UNKNOWN — unknown at least blocks with a reason and an override.
const READ_TIMEOUT: Duration = Duration::from_secs(45);

/// Bound the override-recording comment. Same order as the merge it precedes.
const COMMENT_TIMEOUT: Duration = Duration::from_secs(60);

/// Page size asked of the API. Also the saturation threshold — see [`read_is_saturated`].
const PER_PAGE: usize = 100;

/// An override reason has to COST A SENTENCE. Shorter than this after trimming, or with no
/// whitespace at all, and it is a keystroke rather than a decision — "ok", "x", "because".
const MIN_OVERRIDE_REASON: usize = 15;

/// How much of a probe's text is quoted back in a refusal. Enough to recognise the probe without
/// turning a refusal into a wall.
const PROBE_TEXT_MAX: usize = 200;

/// A probe's severity, exactly the two spellings the contract recognises.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProbeSeverity {
    /// Unanswered ⇒ the merge is refused.
    Blocking,
    /// Unanswered ⇒ a warning, never a refusal. See the module header.
    Open,
}

/// One probe, resolved against the comments that followed it.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    /// The review comment that raised it. Half of the probe's identity — numbering restarts per
    /// review, so the index alone names nothing.
    pub comment_id: u64,
    /// 1-based, as written in the review.
    pub index: u32,
    pub severity: ProbeSeverity,
    /// The specialist named by `[from: …]`, when the review carried one.
    pub from: Option<String>,
    /// The probe's own text, truncated to [`PROBE_TEXT_MAX`]. Quoted back in a refusal so the reader
    /// can act without opening the PR.
    pub text: String,
    /// A link straight to the review comment.
    pub url: String,
    pub answered: bool,
}

impl Probe {
    /// The identity the shared contract uses: `<commentId>#<index>`.
    pub fn id(&self) -> String {
        format!("{}#{}", self.comment_id, self.index)
    }
}

/// What a read of one PR answers. See the module header for why `applicable` and `probes` are two
/// separate facts rather than one tri-state enum: a consumer that reads only one of them still
/// cannot confuse "not the gate here" with "could not find out".
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeGate {
    /// Did this PR carry ANY knightwatch comment? `false` only ever accompanies a successful read.
    pub applicable: bool,
    /// `None` is UNKNOWN — never an empty answer. `Some([])` is "asked; no probes".
    pub probes: Option<Vec<Probe>>,
    /// Why the read is unknown, in the tool's own words. Shown, never parsed.
    pub error: Option<String>,
    /// Does this PR already carry an override record NEWER than its newest knightwatch review?
    ///
    /// This is the CLI path's only possible escape hatch. `gh pr merge` has nowhere to put a
    /// sentence, so an agent blocked by the PreToolUse hook can only override out-of-band, by
    /// running `scripts/probe-gate.sh <n> --override "<reason>"` first — which posts the record and
    /// nothing else. If a recorded override did not clear the gate, that command would change
    /// nothing, the next `gh pr merge` would be denied identically, and the deny message would be
    /// telling the user to do the thing they had just done. Bounded to records newer than the newest
    /// review so one override cannot silence a PR forever: a new review re-arms the gate.
    pub overridden: bool,
    /// WHICH HEAD the newest review actually evaluated, as knightwatch printed it (it abbreviates,
    /// typically 7 chars — compare by PREFIX against a 40-char oid, never with `==`).
    ///
    /// `None` is UNKNOWN and must never be read as "covered": a PR with no review, a lifecycle
    /// status post, and a status form this parser does not recognise all yield it. The consumer's
    /// fail-closed direction is the OPPOSITE of the merge gate's — an unknown here suppresses a
    /// DISPATCH rather than blocking a merge — so a `None` read as "covered" would silently stop a
    /// PR being re-reviewed, which is the bug this field exists to fix.
    pub reviewed_head: Option<String>,
    /// Does the newest review self-label `⚠️ Stale: head moved from X to Y mid-run`?
    ///
    /// AUTHORITATIVE not-covered, and strictly better than our own SHA arithmetic: the bot knows
    /// what it actually diffed. `SKILL.md` Step 3.5 calls it "the single most useful field on the
    /// whole comment". It co-occurs WITH a recognised form rather than replacing one, so it is its
    /// own field and not a third state of [`Self::reviewed_head`].
    pub review_stale: bool,
}

impl ProbeGate {
    /// The read succeeded and this PR has no knightwatch comments. NOT "clean" — the gate does not
    /// apply at all, which is the state every non-Sparkle project is in.
    fn not_applicable() -> Self {
        Self {
            applicable: false,
            probes: Some(Vec::new()),
            error: None,
            overridden: false,
            reviewed_head: None,
            review_stale: false,
        }
    }

    /// We could not read the PR's comments. Blocks; overridable.
    fn unknown(error: String) -> Self {
        Self {
            applicable: true,
            probes: None,
            error: Some(error),
            overridden: false,
            reviewed_head: None,
            review_stale: false,
        }
    }

    /// Unanswered probes of one severity, in the order the reviews raised them.
    fn unanswered(&self, severity: ProbeSeverity) -> Vec<&Probe> {
        self.probes
            .as_deref()
            .unwrap_or_default()
            .iter()
            .filter(|p| p.severity == severity && !p.answered)
            .collect()
    }

    /// The probes that refuse a merge.
    pub fn unanswered_blocking(&self) -> Vec<&Probe> {
        self.unanswered(ProbeSeverity::Blocking)
    }

    /// The probes that only warn.
    pub fn unanswered_open(&self) -> Vec<&Probe> {
        self.unanswered(ProbeSeverity::Open)
    }
}

/// One PR comment, narrowed to what the contract reads. `login` is deliberately absent: it is not
/// part of the discriminator (rule 1), and parsing it would invite someone to use it.
#[derive(Debug, Clone)]
struct Comment {
    id: u64,
    body: String,
    url: String,
}

/// The comment as the API emits it. Every field but `id` is `#[serde(default)]`: GitHub adds fields
/// over time, and a read that fails to parse because the payload grew would report UNKNOWN — i.e.
/// block every merge — on a perfectly healthy machine.
#[derive(Debug, serde::Deserialize)]
struct RawComment {
    id: u64,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
}

// ── THE COVERAGE STATUS LINE ─────────────────────────────────────────────────────────────────────
// Every knightwatch review opens with a blockquoted status naming the head it evaluated. Parsing it
// is what lets a consumer tell "reviewed" from "reviewed something else"; the merge gate never
// needed to know, but a DISPATCHER does — a PR whose probes were all answered can then take four
// more commits that no review has ever seen (observed on #1273: reviewed `9c65efe`, head `4d3030a`).
//
// THE GRAMMAR IS NOT INVENTED HERE. `.claude/skills/babysit-pr/SKILL.md` Step 3.5 specifies it and
// has run against it live on #1104 and #1105; this is that table, in code. Keep the two in step.
//
// THE THIRD FORM IS NOT A VARIANT OF THE SECOND. When a rebase or force-push makes a clean
// incremental impossible, knightwatch evaluates the whole PR and names ONE sha instead of a
// from→to pair. SKILL.md records that omitting that row once turned the babysit loop into an
// infinite one: the parse fell through to "cannot tell", which is fail-closed, and a fail-closed
// default over an INCOMPLETE table never terminates. All three forms, or none of them.
const FIRST_REVIEW: &str = "First review of this PR";
const RE_REVIEW_CHANGES: &str = "Re-review of changes from";
const RE_REVIEW_AT: &str = "Re-review at";
const STALE_LABEL: &str = "Stale: head moved from";

/// The first backticked token after `marker`, when it looks like a SHA. `marker: ""` takes the
/// first token in `s`.
///
/// TOKENS, NEVER "the first sha-shaped thing in the line" — the line is FULL of decoys. Form 2
/// carries the from-sha, the to-sha AND both again inside `git diff X..Y`; the stale suffix adds two
/// more. Anchoring each read to the phrase that precedes the one we want is the whole difference
/// between reading the head that was reviewed and reading the head it was reviewed AGAINST.
fn backticked_after(s: &str, marker: &str) -> Option<String> {
    let at = s.find(marker)? + marker.len();
    let rest = &s[at..];
    let open = rest.find('`')? + 1;
    let close = rest[open..].find('`')?;
    let token = &rest[open..open + close];
    let sha_like = (7..=40).contains(&token.len()) && token.chars().all(|c| c.is_ascii_hexdigit());
    sha_like.then(|| token.to_string())
}

/// The content of a FIRST-LEVEL blockquote line (`> …`), or `None` for anything else — including a
/// NESTED one (`> > …`).
///
/// THE NESTING IS THE WHOLE POINT, and it is what stops a quote-reply being read as a review.
/// GitHub's "Quote reply" reproduces the quoted comment's raw markdown, HTML comments included —
/// the same fact the override-record filter above is anchored against — so quoting a knightwatch
/// review produces a comment that `is_knightwatch` accepts (the marker is genuinely in it) and whose
/// body carries the original status line, now at depth TWO.
///
/// Left unfiltered that is not a cosmetic mis-parse, it is a COST bug with no self-limit: the quote
/// is the newest marker-carrying comment, so its quoted `⚠️ Stale` banner or superseded sha becomes
/// the coverage record, `commits-pushed-since-last-review` goes permanently true, and the dispatcher
/// spends a full Claude session on that PR every cooldown window forever. Depth-1-only makes the
/// quote state NO coverage, so `evaluate` skips past it to the real review underneath.
///
/// `is_knightwatch` is deliberately NOT touched: it is the frozen shared contract that the fixture
/// corpus and a second shell implementation both assert against.
fn first_level_quote(line: &str) -> Option<&str> {
    let rest = line.trim_start().strip_prefix('>')?;
    let rest = rest.strip_prefix(' ').unwrap_or(rest);
    (!rest.trim_start().starts_with('>')).then_some(rest)
}

/// `(the head this review evaluated, does it self-label ⚠️ Stale)`.
///
/// Read ONLY from first-level blockquoted lines, which is where the status lives. A probe's own text
/// can quote anything — including a previous review — and a status parsed out of a finding, or out
/// of a quoted copy of an older review, would name a sha nobody reviewed.
fn parse_review_coverage(body: &str) -> (Option<String>, bool) {
    let quoted: Vec<&str> = body.lines().filter_map(first_level_quote).collect();

    // Detected INDEPENDENTLY of the form. The self-label is authoritative not-covered, so it must
    // survive a status shape this parser does not recognise — otherwise the one field SKILL.md calls
    // "the single most useful field on the whole comment" is lost to an unrelated wording change.
    let stale = quoted.iter().any(|l| l.contains(STALE_LABEL));

    let head = quoted.iter().find_map(|line| {
        if let Some(i) = line.find(RE_REVIEW_CHANGES) {
            // The `to` sha. Reading the `from` here would report the head as covered exactly when a
            // re-review proves it is not.
            return backticked_after(&line[i + RE_REVIEW_CHANGES.len()..], " to ");
        }
        if let Some(i) = line.find(RE_REVIEW_AT) {
            return backticked_after(&line[i + RE_REVIEW_AT.len()..], "");
        }
        if let Some(i) = line.find(FIRST_REVIEW) {
            return backticked_after(&line[i + FIRST_REVIEW.len()..], "reviewed");
        }
        None
    });

    (head, stale)
}

/// Is this comment a knightwatch review? The marker, and nothing else.
fn is_knightwatch(body: &str) -> bool {
    body.contains(REVIEW_MARKER)
}

/// ASCII word character, for the `\b` boundaries in rule 3. Deliberately ASCII-only: the shell
/// implementation's `grep -E` uses the same definition, and a Unicode-aware boundary would let the
/// two answers diverge on the emoji-laden bodies knightwatch actually posts.
fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Parse ONE probe line. `None` for every line that is not a probe.
///
/// Implements `^(\d+)\.\s+\[(blocking|open)\]\s*(\[from: …\])?` by hand, in the [`crate::pr_owner`]
/// style. `regex` is in the tree, but a hand-rolled scan keeps this function total, allocation-free
/// on the reject path (which is ~99% of lines), and readable next to the contract it implements.
fn parse_probe_line(line: &str) -> Option<(u32, ProbeSeverity, Option<String>, String)> {
    // `^(\d+)\.` — anchored with no leading-whitespace tolerance, exactly as the contract states.
    let digits_end = line.find(|c: char| !c.is_ascii_digit())?;
    if digits_end == 0 {
        return None;
    }
    let index: u32 = line[..digits_end].parse().ok()?;
    let rest = line[digits_end..].strip_prefix('.')?;

    // `\s+` — at least one.
    let after_ws = rest.trim_start();
    if after_ws.len() == rest.len() {
        return None;
    }

    // `\[(blocking|open)\]`
    let (severity, rest) = if let Some(r) = after_ws.strip_prefix("[blocking]") {
        (ProbeSeverity::Blocking, r)
    } else if let Some(r) = after_ws.strip_prefix("[open]") {
        (ProbeSeverity::Open, r)
    } else {
        return None;
    };

    // Optional `[from: <specialist>]`, and only when it is the very next token.
    let rest = rest.trim_start();
    let (from, text) = match rest.strip_prefix("[from:").and_then(|r| r.find(']').map(|e| (r, e))) {
        Some((r, end)) => {
            let name = r[..end].trim();
            let name = if name.is_empty() { None } else { Some(name.to_string()) };
            (name, &r[end + 1..])
        }
        None => (None, rest),
    };

    Some((index, severity, from, truncate_text(text.trim())))
}

/// Quote a probe's own words without letting one probe eat the whole refusal. Truncates on a CHAR
/// boundary — probe text routinely carries `—`, `’` and emoji, and slicing a `&str` mid-codepoint
/// panics.
fn truncate_text(text: &str) -> String {
    if text.chars().count() <= PROBE_TEXT_MAX {
        return text.to_string();
    }
    let kept: String = text.chars().take(PROBE_TEXT_MAX).collect();
    format!("{}…", kept.trim_end())
}

/// Does `body` cite probe `n`? Implements `\bprobes?\s*#?\s*<N>\b`, case-insensitive, over the WHOLE
/// body (rule 4).
///
/// The digits are compared LITERALLY rather than numerically, which is what the regex does: "probe
/// 01" does not cite probe 1, and "probe 12" does not cite probe 1 either. Numeric comparison would
/// diverge from the shell implementation on the first of those.
/// A citation only counts if the replier WROTE it — so BLOCKQUOTED lines are skipped.
///
/// Without this, the self-answer hole reopens one indirection out. The override record quotes the
/// user's own reason verbatim, and that reason may well name the probe ("Shipping over probe 1;
/// tracked elsewhere"). Anyone who quote-replies the record — to ask what it means, say — posts a
/// body whose quoted half cites probe 1 while saying nothing about it, and the next read would score
/// the probe ANSWERED. The same shape fires from a quote of the refusal message, which renders
/// `• probe 1 …` in citation form. Quoted text is somebody else's words being shown, never an answer.
/// Does `body` cite this probe by its DURABLE identity — `<commentId>#<index>`?
///
/// THE WINDOW HAS A HARD EDGE, and this is the way over it. A `Probe N` citation is attributed only
/// to the review the reply directly follows, because numbering RESTARTS every review and `Probe 1`
/// after review 2 must mean review 2's. The cost is that once a newer review posts, the older
/// review's probes become unreachable: no `Probe N` in any later reply can ever name them again, so
/// a probe that was genuinely FIXED can only be merged with an override — a recorded waiver for
/// work that was actually done. knightwatch re-reviews on ~1h inactivity, so a pass slower than that
/// has its window closed underneath it while it is still citing correctly (bead `sparkle-tv6ii`).
///
/// `<commentId>#<index>` has no such ambiguity — it names exactly one probe on the whole PR — so it
/// is honoured from ANY later reply. It is the same string the refusal prints, so the remedy the
/// gate suggests is one a reader can actually follow.
fn cites_probe_id(body: &str, comment_id: u64, index: u32) -> bool {
    let needle = format!("{comment_id}#{index}");
    body.lines()
        .filter(|l| !l.trim_start().starts_with('>'))
        .any(|l| {
            l.match_indices(&needle).any(|(at, _)| {
                // Bounded like `line_cites_probe`: neither side may extend the number, so
                // `15182769304#1` and `5182769304#12` are not this probe.
                let before_ok = at == 0 || !l.as_bytes()[at - 1].is_ascii_digit();
                let end = at + needle.len();
                let after_ok = end >= l.len() || !l.as_bytes()[end].is_ascii_digit();
                before_ok && after_ok
            })
        })
}

fn cites_probe(body: &str, n: u32) -> bool {
    body.lines()
        .filter(|l| !l.trim_start().starts_with('>'))
        .any(|l| line_cites_probe(l, n))
}

/// [`cites_probe`] for ONE already-de-quoted line. The grammar itself lives here.
fn line_cites_probe(body: &str, n: u32) -> bool {
    let bytes = body.as_bytes();
    let needle = n.to_string();
    let needle = needle.as_bytes();
    // ASCII-only patterns can only match at char boundaries in UTF-8, so byte scanning is safe.
    for start in 0..bytes.len() {
        if !starts_with_ci(&bytes[start..], b"probe") {
            continue;
        }
        // `\b` before: the previous byte must not be a word byte. A UTF-8 continuation byte is not
        // one, matching `grep -E`'s C-locale behaviour.
        if start > 0 && is_word_byte(bytes[start - 1]) {
            continue;
        }
        // `probes?` — try the longer alternative too, exactly as the regex engine backtracks.
        let after_probe = start + b"probe".len();
        let mut candidates = [Some(after_probe), None];
        if bytes.get(after_probe).is_some_and(|b| b.eq_ignore_ascii_case(&b's')) {
            candidates[1] = Some(after_probe + 1);
        }
        for pos in candidates.into_iter().flatten() {
            if matches_number_after(bytes, pos, needle) {
                return true;
            }
        }
    }
    false
}

/// `\s*#?\s*<needle>\b` starting at `pos`.
fn matches_number_after(bytes: &[u8], pos: usize, needle: &[u8]) -> bool {
    let mut i = pos;
    while bytes.get(i).is_some_and(u8::is_ascii_whitespace) {
        i += 1;
    }
    if bytes.get(i) == Some(&b'#') {
        i += 1;
    }
    while bytes.get(i).is_some_and(u8::is_ascii_whitespace) {
        i += 1;
    }
    if !bytes[i..].starts_with(needle) {
        return false;
    }
    // `\b` after: the next byte must not be a word byte.
    !bytes.get(i + needle.len()).copied().is_some_and(is_word_byte)
}

/// ASCII case-insensitive `starts_with`.
fn starts_with_ci(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.len() >= needle.len()
        && haystack[..needle.len()].eq_ignore_ascii_case(needle)
}

/// THE VERDICT. Pure, and the whole contract lives here.
///
/// `comments` must be in the order the API returns them (oldest first), which is what
/// `issues/<n>/comments` guarantees. A reply is attributed to the newest review AT OR BEFORE it,
/// which is the "answers only the review it follows" rule (`answered-across-reviews.json`).
fn evaluate(comments: &[Comment]) -> ProbeGate {
    let review_positions: Vec<usize> = comments
        .iter()
        .enumerate()
        .filter(|(_, c)| is_knightwatch(&c.body))
        .map(|(i, _)| i)
        .collect();
    if review_positions.is_empty() {
        return ProbeGate::not_applicable();
    }

    let mut probes = Vec::new();
    for (nth, &pos) in review_positions.iter().enumerate() {
        let review = &comments[pos];
        // THE WINDOW IS THE WHOLE OF RULE 3, and it enforces BOTH halves of it at once:
        //
        //   * "after THIS review, before the NEXT one" — a reply that lands after the next review
        //     answers that one, not this one (probe numbering restarts, so "Probe 1" in round 3 is
        //     a different probe from "Probe 1" in round 1).
        //   * "NON-knightwatch" — `review_positions` holds EVERY marker-carrying index, so this
        //     half-open range provably contains none of them. A later `.filter(|c|
        //     !is_knightwatch(…))` here would be dead code, and dead code that looks like a guard is
        //     worse than none: a mutation test proved the filter and the window each masked the
        //     other's failure, so removing it is what makes the window's own tests able to fail.
        let window_end = review_positions.get(nth + 1).copied().unwrap_or(comments.len());
        // THE ONE EXCLUSION the window cannot make for us: this module's OWN override records.
        // They carry [`OVERRIDE_MARKER`], not [`REVIEW_MARKER`], so they are ordinary replies as far
        // as the window is concerned — and a bypass is the OPPOSITE of an answer.
        //
        // WHAT THIS BUYS, precisely: the ACCOUNTING. A bypassed probe stays in
        // `unanswered_blocking()`, so every surface keeps reporting a bypass as a bypass rather than
        // silently relabelling it "answered", and a later reader can tell the two apart. It does NOT
        // decide the merge — `gate.overridden` in [`decide`] does that, and a recorded override
        // deliberately DOES clear the gate (it is the CLI path's only escape hatch). This comment
        // used to claim the filter was what stopped a recorded-then-failed merge sailing through on
        // the next attempt; that stopped being true when the hatch landed, and a rationale asserting
        // a safety property the code does not have is worse than none in a module whose comments are
        // read as the contract.
        //
        // ANCHORED AT THE START of the body, never `contains`. GitHub's "Quote reply" reproduces the
        // quoted comment's RAW markdown, HTML comments included — so a human who quotes the override
        // record while answering it posts a body that CONTAINS the marker. A substring test would
        // drop that reply from the replier set: the probe would stay unanswered, the merge would be
        // refused a second time, and the refusal would tell the user to do the exact thing they just
        // did, with their citation plainly visible on the PR. A false refusal from a lost answer is
        // the failure rule 4 exists to prevent. `override_comment_body` always builds the record
        // STARTING with the marker, so anchoring excludes every real record and no quote of one.
        let repliers: Vec<&Comment> = comments[pos + 1..window_end]
            .iter()
            .filter(|c| !c.body.trim_start().starts_with(OVERRIDE_MARKER))
            .collect();

        for line in review.body.lines() {
            let Some((index, severity, from, text)) = parse_probe_line(line) else {
                continue;
            };
            // Two ways to answer, and the second is deliberately NOT windowed. The windowed
            // `Probe N` form is the teachable one; the durable `<commentId>#<index>` form is the
            // only one that can still reach a probe after a newer review has closed its window.
            let answered = repliers.iter().any(|c| cites_probe(&c.body, index))
                || comments
                    .iter()
                    .skip(pos + 1)
                    .filter(|c| {
                        !is_knightwatch(&c.body)
                            && !c.body.trim_start().starts_with(OVERRIDE_MARKER)
                    })
                    .any(|c| cites_probe_id(&c.body, review.id, index));
            probes.push(Probe {
                comment_id: review.id,
                index,
                severity,
                from,
                text,
                url: review.url.clone(),
                answered,
            });
        }
    }

    // An override record counts only if it comes AFTER the newest review, so a review posted after
    // a bypass re-arms the gate rather than being pre-cleared by it. POSITION, not a timestamp:
    // `Comment` carries no `created_at`, and the whole module already treats the read order as
    // chronological (`evaluate`'s reply windows are built from positions). Using the same ordering
    // here keeps one notion of "after" in the file instead of two that could disagree.
    let overridden = review_positions.last().is_some_and(|&last| {
        comments[last + 1..].iter().any(|c| c.body.trim_start().starts_with(OVERRIDE_MARKER))
    });

    // COVERAGE COMES FROM THE NEWEST REVIEW THAT ACTUALLY STATES IT — not simply the newest
    // marker-carrying comment. Lifecycle status posts (`⏸ knightwatch paused`) carry the marker and
    // name no sha, and they re-post every couple of minutes for as long as an outage lasts. Keying
    // on the last marker would let one of those ERASE a real review's coverage for the whole outage,
    // reporting "we cannot tell" about a PR we can tell about perfectly well.
    let (reviewed_head, review_stale) = review_positions
        .iter()
        .rev()
        .map(|&i| parse_review_coverage(&comments[i].body))
        .find(|(head, stale)| head.is_some() || *stale)
        .unwrap_or((None, false));

    ProbeGate {
        applicable: true,
        probes: Some(probes),
        error: None,
        overridden,
        reviewed_head,
        review_stale,
    }
}

/// The exact `gh api` argv. PURE so the flags are assertable — `--paginate` in particular, without
/// which a busy PR silently loses its NEWEST comments (the API returns oldest-first), which is both
/// the latest review and every reply to it.
fn comments_argv(number: u64) -> Vec<String> {
    [
        "api".to_string(),
        format!("repos/{{owner}}/{{repo}}/issues/{number}/comments?per_page={PER_PAGE}"),
        "--paginate".to_string(),
        "-H".to_string(),
        "Accept: application/vnd.github+json".to_string(),
    ]
    .to_vec()
}

/// Parse `gh api --paginate` output into comments. An `Err` here is UNKNOWN — the caller must never
/// turn it into an empty answer.
///
/// Two shapes are accepted: the single merged array `gh` produces when it stitches pages, and a
/// CONCATENATION of per-page arrays (`[…][…]`), which is what a `gh` that stops merging would emit.
/// Accepting both means a gh behaviour change degrades to a correct read rather than to a repo-wide
/// block.
fn parse_comments(stdout: &str) -> Result<Vec<Comment>, String> {
    let trimmed = stdout.trim();
    // Silence is what `gh` prints when it dies before saying anything. Treating it as `[]` would
    // invent an authoritative "this PR has no comments" out of nothing.
    if trimmed.is_empty() {
        return Err("gh api produced no output for the PR's comments".to_string());
    }
    if let Ok(page) = serde_json::from_str::<Vec<RawComment>>(trimmed) {
        return Ok(page.into_iter().map(project_comment).collect());
    }
    let mut all = Vec::new();
    let stream = serde_json::Deserializer::from_str(trimmed).into_iter::<Vec<RawComment>>();
    for page in stream {
        match page {
            Ok(rows) => all.extend(rows),
            Err(e) => return Err(format!("could not parse the PR's comments: {e}")),
        }
    }
    if all.is_empty() {
        return Err("could not parse the PR's comments: no JSON array in gh's output".to_string());
    }
    Ok(all.into_iter().map(project_comment).collect())
}

fn project_comment(raw: RawComment) -> Comment {
    Comment {
        id: raw.id,
        body: raw.body.unwrap_or_default(),
        url: raw.html_url.unwrap_or_default(),
    }
}

/// Did the read come back exactly one page long?
///
/// With `--paginate` working, `gh` keeps fetching until a page comes back short, so any total that
/// is NOT exactly [`PER_PAGE`] proves pagination happened (or that one short page was the whole
/// story). A total of exactly [`PER_PAGE`] is the one ambiguous reading: either the PR really has
/// 100 comments, or `--paginate` did nothing and we are holding the OLDEST 100 while the newest
/// review — the one most likely to carry a live probe — sits on page 2 unseen.
///
/// That ambiguity resolves to UNKNOWN, which blocks. A PR with exactly 100 comments is rare, the
/// refusal names the reason, and the override clears it; silently missing the newest review is the
/// failure this whole module exists to prevent.
fn read_is_saturated(count: usize) -> bool {
    count == PER_PAGE
}

/// Turn a completed read into a gate answer. PURE, and extracted for exactly one reason: the
/// saturation decision would otherwise live inside the async command where no unit test can reach
/// it, and a mutation that treated a full page as authoritative would stay GREEN.
fn gate_from_stdout(stdout: &str, number: u64) -> ProbeGate {
    match parse_comments(stdout) {
        Ok(comments) if read_is_saturated(comments.len()) => ProbeGate::unknown(format!(
            "the comment read for PR #{number} came back exactly {PER_PAGE} comments long, so it \
             may be only the FIRST page — and GitHub returns comments oldest-first, which means the \
             newest knightwatch review could be missing entirely. Read it directly: `gh api \
             repos/{{owner}}/{{repo}}/issues/{number}/comments --paginate | jq length`."
        )),
        Ok(comments) => evaluate(&comments),
        Err(e) => ProbeGate::unknown(e),
    }
}

/// Keep `gh` from ever blocking on a prompt. Mirrors the same helper in `worktree.rs` /
/// `roborev_probe.rs` — each module carries its own copy by house precedent.
fn apply_noninteractive(cmd: &mut Command) {
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_ASKPASS", "true");
    cmd.env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes");
    cmd.env("GH_PROMPT_DISABLED", "1");
    cmd.env("GH_NO_UPDATE_NOTIFIER", "1");
}

/// Read one PR's probe state. Never `Err`s for a GitHub-side failure — see the module header; a
/// failure is the UNKNOWN state, which the caller has to be able to reason about.
pub(crate) fn read_gate(root: &str, number: u64) -> ProbeGate {
    let mut cmd = Command::new(crate::preflight::gh_program());
    // gh substitutes {owner}/{repo} from the repo at `current_dir`.
    cmd.args(comments_argv(number)).current_dir(root);
    apply_noninteractive(&mut cmd);
    // STRICT: this output is parsed as a whole JSON value, so a plausible-looking prefix would be
    // worse than an error — a truncated page could drop the review that carries the live probe.
    let output = match crate::worktree::output_with_timeout(cmd, READ_TIMEOUT) {
        Ok(o) => o,
        Err(e) => {
            return ProbeGate::unknown(format!("could not read PR #{number}'s comments: {e}"))
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        } else {
            stderr
        };
        return ProbeGate::unknown(format!("gh api exited non-zero reading PR #{number}: {msg}"));
    }
    gate_from_stdout(&String::from_utf8_lossy(&output.stdout), number)
}

/// One probe, rendered for a human. Named, linked, and quoted — a refusal the founder cannot act on
/// is just an obstacle.
fn describe_probe(p: &Probe) -> String {
    let from = match &p.from {
        Some(f) => format!(" [from: {f}]"),
        None => String::new(),
    };
    let url = if p.url.is_empty() { String::new() } else { format!("\n    {}", p.url) };
    format!(
        "  • probe {} [{}]{from} — \"{}\"{url}",
        p.index,
        p.id(),
        p.text
    )
}

/// The refusal. Names EVERY offending probe, says how to answer one, and says how to override.
fn blocking_refusal(number: u64, probes: &[&Probe]) -> String {
    let plural = if probes.len() == 1 { "probe" } else { "probes" };
    let listed = probes.iter().map(|p| describe_probe(p)).collect::<Vec<_>>().join("\n");
    format!(
        "Merge blocked: PR #{number} carries {} unanswered [blocking] knightwatch {plural}.\n\n\
         {listed}\n\n\
         To answer one, post a NEW comment on the PR citing it by the DURABLE id shown above — \
         \"5182769304#1 — applied, …\". That form names one probe on the whole PR and works from any \
         later comment. A bare \"Probe 1\" also works, but ONLY until the next review lands: it is \
         read against the review your reply follows, so a newer review puts older probes out of its \
         reach. Either way the citation has to be in a comment of YOUR own — a later knightwatch \
         comment never clears a probe. Then merge again.\n\
         To merge anyway, supply a knightwatch override reason (at least {MIN_OVERRIDE_REASON} \
         characters, more than one word) saying why. It is posted to the PR as a permanent record \
         BEFORE the merge runs.",
        probes.len()
    )
}

/// The refusal for the UNKNOWN state.
fn unknown_refusal(number: u64, error: &str) -> String {
    format!(
        "Merge blocked: could not determine whether PR #{number} carries unanswered [blocking] \
         knightwatch probes.\n\n  {error}\n\n\
         This is \"could not find out\", not \"clean\" — an unreadable review gate blocks, the same \
         way the roborev gate does. Fix the read (check `gh auth status` and the network) and merge \
         again, or supply a knightwatch override reason (at least {MIN_OVERRIDE_REASON} characters, \
         more than one word) to merge anyway. The reason is posted to the PR before the merge runs."
    )
}

// ── THE CONVERGENCE GATE ────────────────────────────────────────────────────────────────────────
//
// "Addressed" is not "converged". A review landing is not evidence it reviewed YOUR code: a run
// snapshots the head when it starts and takes 20–40 minutes, so anything pushed in that window is
// outside it. Merging on such a review reports a clean bill for code nobody looked at.
//
// This is the gap the reviewer's author found in PR #1273 and called the single hard gate of the
// whole loop: the last fix commit landed at 16:01, the newest review covered only up to `275f462`,
// and the merge ran at 16:23 with NO review ever having seen the final head.
//
// EVERYTHING THIS NEEDS WAS ALREADY HERE. `parse_review_coverage` has been populating
// `reviewed_head` and `review_stale` for the dispatcher all along; `decide` simply never consulted
// them, so the merge gate blocked on unanswered probes and waved through unreviewed code. The fix
// is a second, separate verdict — not a new field, and not a change to how probes are judged.
//
// WHY IT IS SEPARATE FROM `decide` RATHER THAN A FOURTH ARM OF IT: the two answer different
// questions ("were the reviewer's findings answered?" vs "did the reviewer read this code?") and a
// PR can fail either independently. Keeping them apart also keeps `decide`'s signature and its
// fourteen existing tests untouched, so this cannot silently change what any of them assert.

/// Whether the newest knightwatch review actually read the head we are about to merge.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Coverage {
    /// knightwatch never posted on this PR. The gate DOES NOT APPLY — warns, never blocks.
    ///
    /// Deliberately not a refusal, and this is the one place we knowingly depart from the skill's
    /// prose (which argues an unreviewed PR "has not converged, it has merely not been looked at").
    /// True, but the reviewer is an external service on someone else's machine: blocking every PR
    /// it never posted on would stall merges on every branch it simply is not watching, which is a
    /// fleet-wide outage traded for a gap this repo has never actually been bitten by. Blocking
    /// only when the reviewer IS engaged is the minimal change that makes #1273 impossible.
    NotApplicable,
    /// A non-stale review names a SHA that prefixes the current head.
    Covered,
    /// Authoritatively NOT covered, carrying the reason to show a human.
    NotCovered(String),
}

/// THE COVERAGE VERDICT, PURE — no clock, no network, so every branch is a unit test.
///
/// `head` is `None` when the head could not be read. That is UNKNOWN, and it lands in `NotCovered`
/// rather than in a third state on purpose: an unreadable head cannot be shown to be covered, and
/// the sibling roborev gate sets the same precedent that "could not find out" blocks.
pub(crate) fn coverage(gate: &ProbeGate, head: Option<&str>) -> Coverage {
    if !gate.applicable {
        return Coverage::NotApplicable;
    }
    // KNOWN GAP, deliberately left open rather than half-closed (roborev 59267 finding 3). A PR
    // whose only knightwatch comments are lifecycle posts (`⏸ knightwatch paused`, `👀 reviewing`)
    // has `applicable == true` and states no coverage, so it lands in NotCovered and BLOCKS —
    // during an outage, behind a remedy that cannot complete until the outage ends.
    //
    // Two candidate fixes were tried and both were wrong. A `reviewed` flag built from
    // `review_positions` is exactly equal to `applicable` (that list holds EVERY marker-carrying
    // comment, lifecycle ones included), so it would have been INERT — reading as a fix while
    // changing nothing. And keying on "no probes and no sha" cannot distinguish a lifecycle post
    // from a clean review that happened to name no sha; it silently turned
    // `a_review_that_names_no_sha_is_not_covered` from a refusal into a pass, which is the gate
    // failing open on the exact silence it exists to distrust.
    //
    // The real discriminator is the lifecycle PREFIX itself, which the skill already recognises.
    // Until that is implemented, the escape hatch is the recorded override.
    // AUTHORITATIVE, and checked FIRST because it beats any arithmetic we could do: the bot knows
    // what it actually diffed, and it co-occurs with a recognised status form rather than replacing
    // one — so a stale run can still name a SHA, and trusting that SHA would read as covered.
    if gate.review_stale {
        return Coverage::NotCovered(
            "the newest knightwatch review self-labelled \"⚠️ Stale: head moved mid-run\", so it \
             diffed a snapshot that is no longer this PR"
                .to_string(),
        );
    }
    let Some(reviewed) = gate.reviewed_head.as_deref().filter(|s| !s.is_empty()) else {
        return Coverage::NotCovered(
            "no knightwatch review on this PR names the SHA it read, so nothing establishes that \
             the current head has been reviewed. Never infer coverage from silence"
                .to_string(),
        );
    };
    let Some(head) = head else {
        return Coverage::NotCovered(format!(
            "the newest knightwatch review read {reviewed}, but this PR's current head could not \
             be read, so coverage cannot be established. This is \"could not find out\", not \
             \"covered\""
        ));
    };
    // PREFIX, never equality, and SHORT against the start of LONG — knightwatch abbreviates to ~7
    // chars while `headRefOid` is the full 40. Flipping these operands reports a stale review as
    // covered, which is the exact bug this gate exists to prevent.
    if head.starts_with(reviewed) {
        Coverage::Covered
    } else {
        Coverage::NotCovered(format!(
            "the newest knightwatch review read {reviewed}, but this PR's head is now {} — the \
             commits between them have never been reviewed",
            short_sha(head)
        ))
    }
}

/// Abbreviate an oid for a human, without assuming it is 40 chars.
fn short_sha(sha: &str) -> String {
    sha.chars().take(7).collect()
}

/// The refusal for an unreviewed head. Says what to do, and the remedy is one a caller can follow.
fn coverage_refusal(number: u64, reason: &str) -> String {
    format!(
        "Merge blocked: PR #{number} has not CONVERGED — no knightwatch review covers its current \
         head.\n\n  {reason}\n\n\
         \"Addressed\" is not \"converged\": applying a fix moves the head, which invalidates the \
         coverage of the review that asked for it. A clean review pinned to the exact SHA you are \
         merging is the gate.\n\n\
         To clear this, trigger an incremental re-review by posting `/srosro-update-review` as a \
         comment on the PR, wait for the review to land, and confirm its status names your current \
         head. Then merge again.\n\
         To merge anyway, supply a knightwatch override reason (at least {MIN_OVERRIDE_REASON} \
         characters, more than one word) saying why this head does not need review. It is posted to \
         the PR as a permanent record BEFORE the merge runs."
    )
}

/// BOTH gates failed and one rationale was supplied. It buys one bypass, not two.
///
/// EVERY REMEDY NAMED HERE MUST ACTUALLY WORK, and one earlier version's first remedy did not.
/// It said "if the head genuinely needs no review, say so about THE HEAD specifically and merge
/// again" — but there is only ONE override channel, and with blocking probes outstanding [`decide`]
/// consumes whatever sentence is supplied and returns `RecordThenAllow`, so `enforce` lands right
/// back here. The retry produced this identical refusal forever, and the author was told to keep
/// trying it. A refusal's suggested alternative is an instruction the reader will follow, so it
/// needs the same scrutiny as the path it replaces; the two exits below are the two that exist.
///
/// TWO STATES REACH THIS, and only one of them has probes to answer. `read_gate` returns
/// [`ProbeGate::unknown`] when the comment read fails or saturates, and that gate is
/// `applicable: true` with `probes: None` — so `decide` still consumes the rationale
/// (`RecordThenAllow { unknown: true }`) and `coverage` still reports `NotCovered`, landing here
/// with NO probe list in existence. Telling that author to "answer the [blocking] probes" is the
/// same unfollowable instruction this function was just rewritten to remove: there is nothing to
/// answer, and on a saturated read answering everything would not change what was read. So the
/// exit list is state-dependent, and `unknown` is carried in from the arm that already binds it.
fn both_gates_refusal(number: u64, reason: &str, unknown: bool) -> String {
    let (opening, first_exit) = if unknown {
        (
            format!(
                "Merge blocked: the [blocking] probes on PR #{number} could not be READ, so the \
                 override you supplied was taken as the bypass for that gate — but this PR ALSO \
                 has not converged, and one reason cannot bypass two different gates."
            ),
            "1. Re-run the merge once the probe read succeeds. It is a `gh` read, so a transient \
             failure or a comment thread too long to enumerate is the usual cause — and until it \
             succeeds there is no probe list to answer. With the probes readable and clear, your \
             rationale is the one that gets judged and recorded as the convergence override."
                .to_string(),
        )
    } else {
        (
            format!(
                "Merge blocked: the override you supplied answers the [blocking] probes on PR \
                 #{number}, but this PR ALSO has not converged — and one reason cannot bypass two \
                 different gates."
            ),
            "1. Answer the [blocking] probes, then merge again with a rationale about THE HEAD. \
             With the probes clear, that sentence is the one that gets judged and recorded as the \
             convergence override — so the thread shows someone decided about the unreviewed code \
             and not only about the probes."
                .to_string(),
        )
    };
    format!(
        "{opening}\n\n  \
         {reason}\n\n\
         The probe rationale was NOT posted; nothing has been recorded and nothing has merged.\n\n\
         Rewording this reason will not clear it: while the probe gate is unsatisfied, any \
         rationale you supply is read as the PROBE bypass — however you phrase it — so a retry \
         arrives back here unchanged. Two exits work:\n\n\
         {first_exit}\n\
         2. Or post `/srosro-update-review` on the PR, wait for the review to land, confirm its \
         status names your current head, and merge with your probe rationale as before."
    )
}

/// The exact `gh` argv for the head oid. PURE so the flags are assertable.
fn head_argv(number: u64) -> Vec<String> {
    [
        "pr".to_string(),
        "view".to_string(),
        number.to_string(),
        "--json".to_string(),
        "headRefOid".to_string(),
        "-q".to_string(),
        ".headRefOid".to_string(),
    ]
    .to_vec()
}

/// Read the PR's current head oid. `None` is UNKNOWN — never a guess, and never an empty string.
fn read_head(root: &str, number: u64) -> Option<String> {
    let mut cmd = Command::new(crate::preflight::gh_program());
    cmd.args(head_argv(number)).current_dir(root);
    apply_noninteractive(&mut cmd);
    let output = crate::worktree::output_with_timeout(cmd, READ_TIMEOUT).ok()?;
    if !output.status.success() {
        return None;
    }
    let head = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if head.is_empty() {
        None
    } else {
        Some(head)
    }
}

/// Validate an override reason. Returns the TRIMMED reason, or the refusal that says why not.
///
/// Two tests, both cheap for a real explanation and both fatal to a keystroke: it must survive
/// trimming at [`MIN_OVERRIDE_REASON`] characters, and it must contain whitespace — so "ok", "x"
/// and "because" are all refused, as is a single very long word.
fn validate_override(reason: &str) -> Result<String, String> {
    let trimmed = reason.trim();
    if trimmed.chars().count() < MIN_OVERRIDE_REASON {
        return Err(format!(
            "The knightwatch override reason is too short ({} characters; at least \
             {MIN_OVERRIDE_REASON} are required). This reason is posted to the PR as the permanent \
             record of why a blocking probe was bypassed, so it has to say something a reader can \
             evaluate — name the probe and why it does not apply.",
            trimmed.chars().count()
        ));
    }
    if !trimmed.chars().any(char::is_whitespace) {
        return Err(
            "The knightwatch override reason must be more than one word. It is posted to the PR as \
             the permanent record of why a blocking probe was bypassed — a single token explains \
             nothing to whoever reads it next."
                .to_string(),
        );
    }
    Ok(trimmed.to_string())
}

/// The body of the comment that RECORDS an override. Names every bypassed probe and quotes the
/// reason verbatim.
///
/// `bypassed` is empty when the override is clearing an UNKNOWN read rather than named probes; the
/// body says so rather than listing nothing, because "we could not read the gate" is a materially
/// different admission from "we read it and went anyway".
///
/// TWO THINGS THIS COPY MUST NOT DO, both learned the hard way:
///
///   * It must NOT say the PR "was merged". This record is written BEFORE the merge, on purpose,
///     and the merge can still be declined afterwards (`gh` refuses one whose required checks are
///     red). A record asserting a merge that did not happen is a lie left on the PR forever.
///   * It must NOT name a probe in CITATION form (`Probe 1`). [`cites_probe`] would match it —
///     `**` is not a word byte on either side — and the record would answer the very probes it says
///     it bypassed. `evaluate` excludes override records from the replier set as the durable guard;
///     this is the second lock on the same door.
fn override_comment_body(bypassed: &[&Probe], reason: &str, unknown: Option<&str>) -> String {
    let mut out = String::from(OVERRIDE_MARKER);
    out.push_str("\n## knightwatch probe gate — overridden\n\n");
    out.push_str(
        "A merge of this PR was initiated from Sparkle over its knightwatch probe gate. This record \
         is written BEFORE the merge runs — deliberately, because the merge is the irreversible \
         half — so the merge itself may still have been declined afterwards.\n\n",
    );
    if let Some(err) = unknown {
        out.push_str(
            "The probe state was UNREADABLE at the time, so it is not known whether any \
             `[blocking]` review item was outstanding:\n\n> ",
        );
        out.push_str(err);
        out.push_str("\n\n");
    }
    if !bypassed.is_empty() {
        let plural = if bypassed.len() == 1 { "item was" } else { "items were" };
        out.push_str(&format!(
            "{} unanswered `[blocking]` review {plural} outstanding and {} bypassed:\n\n",
            bypassed.len(),
            if bypassed.len() == 1 { "was" } else { "were" }
        ));
        for p in bypassed {
            let from = match &p.from {
                Some(f) => format!(" [from: {f}]"),
                None => String::new(),
            };
            // Deliberately NOT "Probe {n}" — see the doc comment. `review comment <id>, item <n>`
            // identifies it exactly as `(comment_id, index)` without tripping the citation grammar.
            out.push_str(&format!(
                "- review comment {}, item {}{from} — {}\n",
                p.comment_id, p.index, p.text
            ));
        }
        out.push('\n');
    }
    out.push_str("**Reason given:**\n\n> ");
    // Quote every line, so a multi-line reason stays inside the blockquote instead of breaking out
    // of it halfway down.
    out.push_str(&reason.replace('\n', "\n> "));
    out.push('\n');
    out
}

/// Post the override record to the PR. Returns the reason it failed, if it did.
///
/// The reason NEVER reaches a shell or an argv: it is written to a file and handed to
/// `--body-file`. (`--body-file -` would be the tighter form, but the shared
/// [`crate::worktree::output_with_timeout_lenient`] nulls the child's stdin by construction — a
/// property its whole process-group/drain design rests on — so a temp file is the way to keep the
/// text out of the command line without forking that machinery.)
fn post_override_comment(root: &str, number: u64, body: &str) -> Result<(), String> {
    let path = std::env::temp_dir().join(format!(
        "sparkle-probe-gate-override-{}-{number}.md",
        std::process::id()
    ));
    std::fs::write(&path, body)
        .map_err(|e| format!("could not stage the override record for PR #{number}: {e}"))?;
    let mut cmd = Command::new(crate::preflight::gh_program());
    cmd.arg("pr")
        .arg("comment")
        .arg(number.to_string())
        .arg("--body-file")
        .arg(&path)
        .current_dir(root);
    apply_noninteractive(&mut cmd);
    // Lenient: this is a MUTATING call, so the exit status is the truth and an unfinished pipe
    // drain must not report a posted comment as failed.
    let result = crate::worktree::output_with_timeout_lenient(cmd, COMMENT_TIMEOUT);
    let _ = std::fs::remove_file(&path);
    let captured = result.map_err(|e| format!("could not post the override record: {e}"))?;
    if captured.output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&captured.output.stderr).trim().to_string();
    let msg = if stderr.is_empty() {
        String::from_utf8_lossy(&captured.output.stdout).trim().to_string()
    } else {
        stderr
    };
    Err(format!(
        "could not post the override record to PR #{number}: {msg}{}",
        captured.truncation_note()
    ))
}

/// What the gate decided, before anything has been read from or written to GitHub.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Decision {
    /// Nothing to bypass — merge.
    Allow,
    /// Refuse, showing this message.
    Refuse(String),
    /// Post this body to the PR, THEN merge. Never the other order.
    RecordThenAllow {
        body: String,
        bypassed: usize,
        unknown: bool,
    },
}

/// THE DECISION, PURE. Extracted from [`enforce`] for exactly one reason: with the read and the
/// comment-post inlined, no test could reach this logic — replacing `enforce`'s body with `Ok(())`
/// left the whole suite green while the feature was 100% inert, which is the vacuous-coverage shape
/// AGENTS.md names as the repo's #1 fleet-wide finding. Every transition below is now tested.
fn decide(gate: &ProbeGate, number: u64, knightwatch_override: Option<&str>) -> Decision {
    let blocking = gate.unanswered_blocking();
    // UNKNOWN is a read FAILURE, and it blocks — the same doctrine as the sibling roborev gate. It
    // is only reachable when the read failed, so `probes.is_none()` is the whole test.
    let unknown = if gate.probes.is_none() { gate.error.as_deref() } else { None };

    if blocking.is_empty() && unknown.is_none() {
        // Nothing to bypass. An override supplied anyway is a NO-OP, and must NOT post a record
        // claiming items were bypassed when none were — a false record on the PR is worse than no
        // record, because a later reader cannot tell it from a true one.
        return Decision::Allow;
    }

    // A RECORDED OVERRIDE CLEARS THE GATE, and this is what keeps the CLI escape hatch alive. The
    // reason is already on the PR — the requirement is that a bypass is RECORDED, not that it is
    // re-typed once per attempt — and an agent driving `gh pr merge` has no in-band channel for a
    // sentence, so without this the hook's own remedy would be a dead instruction. Deliberately not
    // applied to UNKNOWN: a record written when the gate could not be read says nothing about what
    // it would have found.
    // ONLY when no reason was supplied on THIS call. Above the `RecordThenAllow` branch this
    // short-circuit swallowed a freshly typed reason: the app and concierge paths pass one in-band,
    // and a PR already carrying any record would have merged without validating, posting, or using
    // it — silently dropping the sentence the copy promises is "published under your name beside
    // that question", and leaving the SECOND bypass (different rationale, possibly a different
    // person) unrecorded. The hatch exists for the channel that has nowhere to put a sentence; a
    // caller that HAS one always takes the recording path.
    if unknown.is_none() && gate.overridden && knightwatch_override.is_none() {
        return Decision::Allow;
    }

    let Some(reason) = knightwatch_override else {
        return Decision::Refuse(match unknown {
            Some(e) => unknown_refusal(number, e),
            None => blocking_refusal(number, &blocking),
        });
    };
    let reason = match validate_override(reason) {
        Ok(r) => r,
        Err(e) => return Decision::Refuse(e),
    };
    Decision::RecordThenAllow {
        body: override_comment_body(&blocking, &reason, unknown),
        bypassed: blocking.len(),
        unknown: unknown.is_some(),
    }
}

/// THE GATE. Run before a merge; `Ok(())` means the merge may proceed.
///
/// The thin wiring around [`decide`]: read → decide → act. RECORD BEFORE MERGE, on purpose — the
/// merge is the irreversible half, and a merge that then failed to post its override record would
/// leave no record at all, the exact state this gate exists to make impossible. So the comment goes
/// first, and a failure to post refuses the merge.
pub(crate) fn enforce(
    root: &str,
    number: u64,
    knightwatch_override: Option<&str>,
) -> Result<(), String> {
    let gate = read_gate(root, number);

    // `[open]` probes WARN and never block — see the module header for where the warning goes.
    let open = gate.unanswered_open();
    if !open.is_empty() {
        tracing::warn!(
            target: "knightwatch",
            pr = number,
            count = open.len(),
            probes = %open.iter().map(|p| p.id()).collect::<Vec<_>>().join(", "),
            "merging with unanswered [open] knightwatch probes; these warn and do not block"
        );
    }

    // PROBES FIRST, then coverage. Both can fail at once, and answering the findings is the more
    // actionable instruction — it is also the order the loop runs in: answer the probes, push, then
    // re-review the new head. Leading with "go get a re-review" while findings sit unanswered would
    // send the author back for a round that the next review would only reopen.
    // BOTH GATES ARE JUDGED BEFORE EITHER ACTS, and that ordering is the fix — not a style choice.
    //
    // Two earlier cuts both let a PROBES rationale silently clear the HEAD check. The first
    // returned outright on an override. The second fell through but still ran the probe gate FIRST,
    // which is worse than it looks: a human blocked on probes only ever sees `blocking_refusal`,
    // types a rationale about the probes, retries — and that SAME string is handed to
    // `decide_coverage`, which validates it with the identical `validate_override` and so can never
    // reject it. `coverage_refusal`, the message that says the head is unreviewed and names
    // `/srosro-update-review`, was unreachable on that path. The author was never told. Only the
    // paper trail changed, and it changed into a FALSE one: a probes rationale quoted under
    // "convergence gate overridden", which is exactly the false-record shape `decide` argues
    // against.
    //
    // So a reason buys ONE bypass. When both gates fail and only one rationale was supplied, we
    // refuse and say the head is also unreviewed — the author decides about the head knowing it is
    // the head, or does not decide at all.
    let coverage_verdict = if gate.applicable {
        coverage(&gate, read_head(root, number).as_deref())
    } else {
        // The head read is skipped entirely when the reviewer was never here, so a repo it does
        // not watch pays no extra `gh` call per merge.
        Coverage::NotApplicable
    };

    match decide(&gate, number, knightwatch_override) {
        Decision::Refuse(msg) => return Err(msg),
        Decision::RecordThenAllow { body, bypassed, unknown } => {
            if let Coverage::NotCovered(reason) = &coverage_verdict {
                // Refuse BEFORE posting: the probe record must not land on the PR describing a
                // merge that is about to be declined for a different reason.
                return Err(both_gates_refusal(number, reason, unknown));
            }
            post_override_comment(root, number, &body)?;
            tracing::warn!(
                target: "knightwatch",
                pr = number,
                bypassed,
                unknown,
                "knightwatch probe gate overridden; the reason is recorded on the PR"
            );
            return Ok(());
        }
        Decision::Allow => {}
    }

    match decide_coverage_from(&coverage_verdict, number, knightwatch_override) {
        Decision::Allow => Ok(()),
        Decision::Refuse(msg) => Err(msg),
        Decision::RecordThenAllow { body, .. } => {
            post_override_comment(root, number, &body)?;
            tracing::warn!(
                target: "knightwatch",
                pr = number,
                "knightwatch convergence gate overridden; the reason is recorded on the PR"
            );
            Ok(())
        }
    }
}

/// THE COVERAGE DECISION, PURE — extracted from [`enforce`] for the same reason [`decide`] was.
/// With the head read and the comment post inlined, no test could reach this wiring: deleting the
/// call from `enforce` left every `coverage` test green while the gate was entirely inert, which is
/// the vacuous-coverage shape AGENTS.md names as the repo's #1 fleet-wide finding.
pub(crate) fn decide_coverage(
    gate: &ProbeGate,
    head: Option<&str>,
    number: u64,
    knightwatch_override: Option<&str>,
) -> Decision {
    decide_coverage_from(&coverage(gate, head), number, knightwatch_override)
}

/// The same decision, over an ALREADY-COMPUTED verdict — so `enforce` can judge both gates before
/// either acts without reading the head twice.
pub(crate) fn decide_coverage_from(
    verdict: &Coverage,
    number: u64,
    knightwatch_override: Option<&str>,
) -> Decision {
    let Coverage::NotCovered(reason) = verdict else {
        return Decision::Allow;
    };
    // DELIBERATELY NOT CLEARED BY `gate.overridden`, unlike the probe gate. That flag means "a
    // record exists newer than the newest REVIEW" — it is bounded against reviews, not against
    // commits, so it cannot express "I accept this specific unreviewed head". Honouring it here
    // would let one override permanently waive review for every commit pushed after it, which is
    // the failure this gate exists to stop. An explicit reason on THIS merge is the only exit.
    let Some(supplied) = knightwatch_override else {
        return Decision::Refuse(coverage_refusal(number, reason));
    };
    match validate_override(supplied) {
        Ok(text) => Decision::RecordThenAllow {
            body: coverage_override_body(reason, &text),
            bypassed: 0,
            unknown: false,
        },
        Err(e) => Decision::Refuse(e),
    }
}

/// The permanent record posted when an unreviewed head is merged anyway.
fn coverage_override_body(reason: &str, supplied: &str) -> String {
    // EVERY line quoted, not just the first. A multi-line reason with a bare leading `> ` renders
    // its second line onward as body text, breaking out of the blockquote — the same defect
    // `override_comment_body` documents on its own reason.
    let quoted = supplied
        .lines()
        .map(|l| format!("> {l}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "{OVERRIDE_MARKER}\n\n\
         **knightwatch convergence gate overridden** — this PR was merged without a review \
         covering its final head.\n\n\
         {reason}.\n\n\
         Reason given:\n\n{quoted}\n"
    )
}

/// The WHOLE probe reading for one PR — blocking and open, answered and not.
///
/// This is the channel the TypeScript side reads to surface `[open]` probes (and to preview a
/// refusal before the merge button is pressed). It never merges anything and never posts anything.
#[tauri::command]
pub async fn knightwatch_probe_gate(root: String, number: u64) -> Result<ProbeGate, String> {
    if root.trim().is_empty() {
        return Err("knightwatch_probe_gate requires a project root".to_string());
    }
    // spawn_blocking: this shells out, and the UI thread awaits the invoke.
    tauri::async_runtime::spawn_blocking(move || read_gate(&root, number))
        .await
        .map_err(|e| format!("knightwatch_probe_gate task failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// The SHARED corpus. Locating it from `CARGO_MANIFEST_DIR` (four levels up) is what keeps this
    /// implementation and the shell one asserting against the same bytes.
    fn fixture_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../scripts/tests/fixtures/knightwatch")
    }

    fn read_fixture(name: &str) -> String {
        let path = fixture_dir().join(name);
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("the shared fixture {} must exist: {e}", path.display()))
    }

    fn gate_for(name: &str) -> ProbeGate {
        let comments = parse_comments(&read_fixture(name)).expect("a fixture must parse");
        evaluate(&comments)
    }

    fn ids(probes: &[&Probe]) -> Vec<String> {
        probes.iter().map(|p| p.id()).collect()
    }

    /// "Is the citation TEXT present anywhere, quoting ignored?" — the sanity half of a test that
    /// wants to prove a citation exists before asserting it does not COUNT. Distinct from
    /// [`cites_probe`] on purpose: asserting the real function here would make those tests pass for
    /// the wrong reason the moment quoting changed.
    fn cites_ignoring_quoting(body: &str, n: u32) -> bool {
        body.lines()
            .map(|l| l.trim_start().trim_start_matches('>'))
            .any(|l| line_cites_probe(l, n))
    }

    /// THE CONTRACT TEST. Every case in `expected.json`, asserted against these exact numbers. A
    /// disagreement here is a conversation with the other implementation, never an edit to the
    /// fixture — that file is the only thing keeping the two from drifting.
    #[test]
    fn every_case_in_the_shared_contract_matches() {
        let raw = read_fixture("expected.json");
        let doc: serde_json::Value = serde_json::from_str(&raw).expect("expected.json parses");
        let cases = doc["cases"].as_object().expect("expected.json has cases");
        assert!(cases.len() >= 7, "the corpus must not shrink silently: {} cases", cases.len());

        for (name, want) in cases {
            let gate = gate_for(name);
            assert_eq!(
                gate.applicable,
                want["applicable"].as_bool().unwrap(),
                "{name}: applicability"
            );
            let probes = gate.probes.as_ref().expect("a fixture read is authoritative");
            assert_eq!(
                probes.len() as u64,
                want["probes"].as_u64().unwrap(),
                "{name}: probe count"
            );
            let want_blocking: Vec<String> = want["unansweredBlocking"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect();
            let want_open: Vec<String> = want["unansweredOpen"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect();
            assert_eq!(ids(&gate.unanswered_blocking()), want_blocking, "{name}: blocking");
            assert_eq!(ids(&gate.unanswered_open()), want_open, "{name}: open");

            // `blockingProbes` records the severity SPLIT, which the four fields above cannot
            // express: an answered `[open]` probe and an answered `[blocking]` one are
            // indistinguishable in them. The shell suite's `with-an-answered-BLOCKING-probe` floor
            // rests entirely on this number, so deriving it here from the fixture body is what
            // stops it being a hand-typed figure nothing checks — a case could otherwise record
            // every `[open]` probe as blocking and satisfy that floor with zero blocking probes.
            assert_eq!(
                probes.iter().filter(|p| p.severity == ProbeSeverity::Blocking).count() as u64,
                want["blockingProbes"].as_u64().expect("every case records blockingProbes"),
                "{name}: blocking-probe count"
            );
            // The CLI escape hatch is a decision both implementations make, so it is asserted here
            // like every other field rather than left to the shell suite alone.
            assert_eq!(
                gate.overridden,
                want["overridden"].as_bool().expect("every case records overridden"),
                "{name}: recorded-override state"
            );
        }
    }

    /// THE CLI ESCAPE HATCH. `gh pr merge` has nowhere to put a sentence, so an agent denied by the
    /// PreToolUse hook can only override out-of-band — run `probe-gate.sh <n> --override "<why>"`,
    /// which posts the record and nothing else, then retry the merge. If a recorded override did not
    /// clear the gate, that retry would be denied identically and the deny message would be telling
    /// the user to do the thing they had just done. This gate briefly WAS that, and this test is
    /// what stops it regressing there again.
    #[test]
    fn a_recorded_override_clears_the_gate_so_the_cli_hatch_works() {
        let gate = gate_for("override-record-does-not-answer.json");
        // The probe is NOT answered — a bypass is the opposite of an answer, and the accounting has
        // to keep saying so or a later reader cannot tell a bypass from a reply.
        assert_eq!(ids(&gate.unanswered_blocking()), vec!["1#1"]);
        assert!(gate.overridden, "the record is newer than the newest review");
        // …and yet the merge is ALLOWED, with no second reason demanded.
        assert_eq!(decide(&gate, 997, None), Decision::Allow);
    }

    /// A reason supplied on THIS call is always RECORDED, even when the PR already carries an older
    /// record. The hatch is for the channel that cannot carry a sentence; it must never swallow one
    /// that was typed, or the second bypass — different rationale, possibly a different person —
    /// goes unrecorded while the copy promises it is published on the PR.
    #[test]
    fn a_supplied_reason_is_recorded_even_when_an_older_override_exists() {
        let gate = gate_for("override-record-does-not-answer.json");
        assert!(gate.overridden, "precondition: an older record is present");
        // With no reason, the hatch clears it (the CLI path).
        assert_eq!(decide(&gate, 997, None), Decision::Allow);
        // With one, it is validated and RECORDED rather than dropped.
        match decide(&gate, 997, Some("the probe is about a file this PR does not touch")) {
            Decision::RecordThenAllow { body, bypassed, .. } => {
                assert_eq!(bypassed, 1);
                assert!(body.contains("the probe is about a file this PR does not touch"));
            }
            other => panic!("a supplied reason must be recorded, got {other:?}"),
        }
        // …and a reason that does not cost a sentence is still refused, not waved through by the
        // older record.
        assert!(matches!(decide(&gate, 997, Some("ok")), Decision::Refuse(_)));
    }

    /// The bound that stops one override silencing a PR for good: a review posted AFTER the record
    /// re-arms the gate.
    #[test]
    fn a_review_after_the_override_re_arms_the_gate() {
        let mut comments = parse_comments(&read_fixture("override-record-does-not-answer.json")).unwrap();
        comments.push(Comment {
            id: 500,
            url: "https://example.invalid/500".into(),
            body: format!("{REVIEW_MARKER}\n**Probes**\n\n1. [blocking] [from: tests] [bug] A new one."),
        });
        let gate = evaluate(&comments);
        assert!(!gate.overridden, "the record predates this review, so it cannot cover it");
        assert!(matches!(decide(&gate, 997, None), Decision::Refuse(_)));
    }

    /// THE STRING CONTRACT THE TS LAYER ANCHORS ON.
    ///
    /// `mergeGuard/knightwatch.ts` tells a rejected REASON apart from a real REFUSAL with
    /// `/^the knightwatch override reason\b/i`, because both refusals also contain the phrase
    /// "override reason" (each ends by explaining how to override) — an unanchored test disabled
    /// probe-refusal detection entirely and shipped, because the TS tests used paraphrases. The
    /// discriminator is therefore the literal OPENING of these strings, and it lives here. Reword
    /// them and this test fails, which is the point: the coupling is checked, not merely commented.
    #[test]
    fn rejected_reasons_open_with_the_phrase_the_ts_layer_anchors_on() {
        const ANCHOR: &str = "The knightwatch override reason";
        for bad in ["ok", "x", "supercalifragilistic"] {
            let err = validate_override(bad).unwrap_err();
            assert!(err.starts_with(ANCHOR), "a rejected reason must open with {ANCHOR:?}: {err}");
        }
        // …and NEITHER refusal may open with it, or the exclusion would swallow the real thing.
        let gate = gate_for("real-pr-1176.json");
        let refusal = blocking_refusal(1176, &gate.unanswered_blocking());
        assert!(!refusal.starts_with(ANCHOR), "a probe refusal must not open like a rejected reason");
        assert!(!unknown_refusal(1176, "gh exited 1").starts_with(ANCHOR));
        // They DO both mention the phrase, which is exactly why anchoring is required.
        assert!(refusal.to_lowercase().contains("override reason"));
        assert!(unknown_refusal(1176, "gh exited 1").to_lowercase().contains("override reason"));
    }

    /// THE FOUNDER'S CASE. #1176 merged on 2026-08-04 with this blocking probe unanswered; the gate
    /// must REFUSE it, and the refusal must be actionable — the probe's number, its specialist, a
    /// link, and its own words.
    #[test]
    fn the_gate_refuses_the_pr_that_actually_merged_unanswered() {
        let gate = gate_for("real-pr-1176.json");
        let blocking = gate.unanswered_blocking();
        assert_eq!(ids(&blocking), vec!["5182769304#1"]);

        let probe_id = blocking[0].id();
        let msg = blocking_refusal(1176, &blocking);
        assert!(msg.contains("Merge blocked"), "{msg}");
        assert!(msg.contains("probe 1"), "the probe's number: {msg}");
        assert!(msg.contains("[from: contract-drift]"), "the specialist: {msg}");
        assert!(msg.contains("#issuecomment-5182769304"), "a link to the comment: {msg}");
        assert!(
            msg.contains("The landing gate still checks only orchestration and mobile"),
            "the probe's own words: {msg}"
        );
        // THE REMEDY MUST LEAD WITH THE FORM THAT ALWAYS WORKS. A bare `Probe 1` is read against
        // the review the reply follows, so telling the reader to use it is telling them to use the
        // one form that CANNOT clear this probe once a newer review has landed — the
        // remedy-you-cannot-follow shape this gate has already shipped once.
        assert!(
            msg.contains("DURABLE id shown above"),
            "how to answer it, durable form first: {msg}"
        );
        assert!(msg.contains(&probe_id), "the durable id itself: {msg}");
        assert!(msg.contains("override"), "and how to override: {msg}");
    }

    /// A refusal must name EVERY offending probe, not just the first — merging after fixing one of
    /// three and being refused again with no new information is the shape that trains people to
    /// override reflexively.
    #[test]
    fn a_refusal_names_every_offending_probe() {
        let probes: Vec<Probe> = (1..=3)
            .map(|i| Probe {
                comment_id: 42,
                index: i,
                severity: ProbeSeverity::Blocking,
                from: Some(format!("specialist-{i}")),
                text: format!("finding number {i}"),
                url: "https://example.invalid/#c42".to_string(),
                answered: false,
            })
            .collect();
        let refs: Vec<&Probe> = probes.iter().collect();
        let msg = blocking_refusal(7, &refs);
        assert!(msg.contains("3 unanswered"), "{msg}");
        for i in 1..=3 {
            assert!(msg.contains(&format!("probe {i}")), "probe {i} missing: {msg}");
            assert!(msg.contains(&format!("finding number {i}")), "text {i} missing: {msg}");
            assert!(msg.contains(&format!("specialist-{i}")), "from {i} missing: {msg}");
        }
    }

    /// NOT-APPLICABLE, and it must be tellable apart from "clean". knightwatch posts under a real
    /// human's account, so a comment with probe-shaped lines but NO marker is not a review — and a
    /// project knightwatch has never touched must merge freely.
    #[test]
    fn a_marker_less_comment_is_not_a_review_and_the_merge_is_allowed() {
        let gate = gate_for("impostor-no-marker.json");
        assert!(!gate.applicable, "no marker ⇒ the gate does not apply");
        assert!(gate.unanswered_blocking().is_empty(), "and nothing blocks");
        assert_eq!(gate.probes.as_deref(), Some(&[][..]), "an ANSWER of zero probes");
        assert!(gate.error.is_none());
        // The impostor body really does contain probe-shaped lines — otherwise this test would pass
        // for the wrong reason (nothing to find rather than nothing counted).
        let body = read_fixture("impostor-no-marker.json");
        assert!(body.contains("[blocking]"), "the fixture must actually bait the parser");
    }

    /// THE SELF-ANSWER HOLE. A later marker-carrying comment must never clear an earlier probe, or
    /// the bot clears its own gate.
    #[test]
    fn a_later_knightwatch_comment_cannot_answer_a_probe() {
        let gate = gate_for("self-answer-does-not-count.json");
        assert_eq!(ids(&gate.unanswered_blocking()), vec!["1#1"]);
        // The bot's follow-up really does write "Probe 1" — so this asserts the FILTER, not the
        // absence of a citation. Checked with quoting stripped, because knightwatch renders its own
        // header line as a blockquote (`> 📋 Re-review …`) and rule 4 discounts quoted text; the
        // point here is that the TEXT is present and still does not count.
        let raw = read_fixture("self-answer-does-not-count.json");
        let comments = parse_comments(&raw).unwrap();
        assert!(
            cites_ignoring_quoting(&comments[1].body, 1),
            "the bot's reply does write 'Probe 1'"
        );
        assert!(is_knightwatch(&comments[1].body), "and it carries the marker");
    }

    /// `[open]` probes WARN and never block. The founder ships fast; blocking on every open probe
    /// would stall him.
    #[test]
    fn open_probes_never_block_but_are_still_reported() {
        let gate = gate_for("open-only.json");
        assert!(gate.applicable, "the gate DOES apply — there is a review");
        assert!(
            gate.unanswered_blocking().is_empty(),
            "an [open]-only PR merges clean"
        );
        assert_eq!(
            ids(&gate.unanswered_open()),
            vec!["1#1", "1#2"],
            "but the open probes are still surfaced for the warning"
        );
    }

    /// Build a comment list directly, for the window cases the shared corpus does not distinguish.
    fn comment(id: u64, body: &str) -> Comment {
        Comment { id, body: body.to_string(), url: format!("https://example.invalid/#c{id}") }
    }

    /// THE OTHER DIRECTION of the answer window, and the shared corpus cannot see it: a reply that
    /// lands after the NEXT review answers that review, not the earlier one. Probe numbering
    /// restarts every round, so "Probe 1" in a round-2 reply is a different probe from round 1's —
    /// and without the upper bound, one late reply retroactively clears every round before it.
    #[test]
    fn a_reply_after_the_next_review_does_not_reach_back_to_the_earlier_one() {
        let round_one = format!("{REVIEW_MARKER}\n1. [blocking] [from: a] round one finding");
        let round_two = format!("{REVIEW_MARKER}\n1. [blocking] [from: b] round two finding");
        let gate = evaluate(&[
            comment(1, &round_one),
            comment(2, &round_two),
            comment(3, "Probe 1 — applied."),
        ]);
        assert_eq!(
            ids(&gate.unanswered_blocking()),
            vec!["1#1"],
            "the reply answers round TWO's probe 1; round one's must stay unanswered"
        );
        // The same reply placed BEFORE the second review answers round one instead — same comments,
        // same citation, different window.
        let gate = evaluate(&[
            comment(1, &round_one),
            comment(3, "Probe 1 — applied."),
            comment(2, &round_two),
        ]);
        assert_eq!(ids(&gate.unanswered_blocking()), vec!["2#1"]);
    }

    /// A reply answers only the review it FOLLOWS. Numbering restarts per review, so "Probe 1" in a
    /// round-1 reply must not clear the round-2 probe 1.
    #[test]
    fn a_reply_answers_only_the_review_it_follows() {
        let gate = gate_for("answered-across-reviews.json");
        let probes = gate.probes.as_ref().unwrap();
        assert_eq!(probes.len(), 3);
        // Review 1's two probes are both cited by the reply that follows it.
        assert!(probes[0].answered && probes[1].answered, "round 1 is answered");
        // Review 3's probe 1 has no reply after it — and must NOT inherit round 1's citation.
        assert_eq!(ids(&gate.unanswered_blocking()), vec!["3#1"]);
        assert_ne!(probes[0].comment_id, probes[2].comment_id, "identity is (commentId, index)");
        assert_eq!(probes[0].index, probes[2].index, "and the index alone repeats");
    }

    /// Lifecycle chatter carries the marker but lists no probes. It must make the gate APPLY (a
    /// knightwatch comment exists) while contributing nothing — no per-prefix special-casing.
    #[test]
    fn lifecycle_status_posts_contribute_no_probes() {
        let gate = gate_for("status-posts.json");
        assert!(gate.applicable);
        assert_eq!(gate.probes.as_deref(), Some(&[][..]));
    }

    /// Real data (PR #1104) puts a citation more than 1500 chars into a reply. A parser that reads
    /// only the head of a body turns an answered probe into a false refusal.
    #[test]
    fn a_citation_deep_inside_a_long_body_still_counts() {
        let gate = gate_for("real-pr-1104.json");
        assert_eq!(ids(&gate.unanswered_blocking()), vec!["5173243619#1"]);
        // Prove the depth is real, so this test cannot pass on a short-body fixture.
        let comments = parse_comments(&read_fixture("real-pr-1104.json")).unwrap();
        let deep = comments
            .iter()
            .filter(|c| !is_knightwatch(&c.body))
            .filter_map(|c| {
                let lower = c.body.to_lowercase();
                lower.find("probe 1").filter(|_| cites_probe(&c.body, 1))
            })
            .max()
            .expect("some reply cites probe 1");
        assert!(deep > 1500, "the deepest citation sits at {deep} chars, not deep enough to prove it");
    }

    /// The probe line grammar, including the shapes that must NOT match.
    #[test]
    fn probe_lines_parse_and_near_misses_do_not() {
        let (i, sev, from, text) =
            parse_probe_line("1. [blocking] [from: security] [bug] The token is logged.").unwrap();
        assert_eq!(i, 1);
        assert_eq!(sev, ProbeSeverity::Blocking);
        assert_eq!(from.as_deref(), Some("security"));
        assert_eq!(text, "[bug] The token is logged.");

        let (i, sev, from, text) = parse_probe_line("12.  [open] no specialist here").unwrap();
        assert_eq!((i, sev), (12, ProbeSeverity::Open));
        assert_eq!(from, None);
        assert_eq!(text, "no specialist here");

        for line in [
            "1.[blocking] no space after the dot",
            "1 [blocking] no dot",
            "1. [medium] not a severity we gate on",
            "- [blocking] not numbered",
            "Probe 1. [blocking] prose before the number",
            "1. blocking without brackets",
            "",
        ] {
            assert!(parse_probe_line(line).is_none(), "must not parse: {line:?}");
        }
    }

    /// The citation grammar. Literal digits, not numeric — "probe 12" is not a citation of probe 1,
    /// and neither is "probe 01". Numeric comparison would diverge from the shell implementation.
    #[test]
    fn citation_matching_follows_the_frozen_grammar() {
        for body in ["probe 1", "Probe 1", "PROBE #1", "probes 1", "Probe#1", "probe  #  1", "probe1"]
        {
            assert!(cites_probe(body, 1), "must cite probe 1: {body:?}");
        }
        for body in ["probe 12", "probe 01", "probe 2", "microprobe 1", "no citation at all", "1"] {
            assert!(!cites_probe(body, 1), "must NOT cite probe 1: {body:?}");
        }
        assert!(cites_probe("### Probe 2 — topology — **applied**", 2));
        // Multibyte bodies must not shift the scan or panic.
        assert!(cites_probe("Round 3 — 👀 probe 3 declined", 3));
        assert!(!cites_probe("Round 3 — 👀 probe 3 declined", 1));
    }

    /// UNKNOWN must be distinguishable from "no probes". This is the conflation the three-state
    /// discipline exists to prevent.
    #[test]
    fn an_unreadable_response_is_unknown_and_never_an_empty_answer() {
        assert!(parse_comments("").is_err(), "silence is not an authoritative empty answer");
        assert!(parse_comments("   \n").is_err());
        assert!(parse_comments("{not json").is_err());
        // And the real empty answer still parses as an answer.
        assert!(parse_comments("[]").unwrap().is_empty());

        let unknown = gate_from_stdout("{not json", 9);
        assert!(unknown.applicable, "unknown is 'could not find out', not 'not the gate'");
        assert!(unknown.probes.is_none());
        assert!(unknown.error.is_some());

        let empty = gate_from_stdout("[]", 9);
        assert!(!empty.applicable);
        assert_eq!(empty.probes.as_deref(), Some(&[][..]));
        assert_ne!(unknown.probes, empty.probes, "'could not read it' != 'no probes'");
    }

    /// `gh --paginate` merges pages into one array, but a build that stops merging emits them
    /// concatenated. Both must read as the same comments rather than as a repo-wide block.
    #[test]
    fn concatenated_pages_parse_as_one_conversation() {
        let joined = r#"[{"id":1,"body":"a","html_url":"u1"}][{"id":2,"body":"b","html_url":"u2"}]"#;
        let comments = parse_comments(joined).expect("concatenated pages are readable");
        assert_eq!(comments.len(), 2);
        assert_eq!(comments[1].id, 2);
    }

    /// A read that is exactly one page long cannot be told apart from an unpaginated first page —
    /// and GitHub returns comments OLDEST-first, so the missing page is the one with the newest
    /// review on it. That is UNKNOWN, which blocks, not an authoritative clean answer.
    #[test]
    fn a_single_page_sized_read_is_unknown_not_authoritative() {
        let rows: Vec<String> = (0..PER_PAGE)
            .map(|i| format!(r#"{{"id":{i},"body":"chatter","html_url":"u"}}"#))
            .collect();
        let saturated = gate_from_stdout(&format!("[{}]", rows.join(",")), 5);
        assert!(saturated.probes.is_none(), "a page-sized read must NOT be authoritative");
        let err = saturated.error.expect("and it must say why");
        assert!(err.contains("100 comments long"), "naming the size: {err}");
        assert!(err.contains("oldest-first"), "and why that matters: {err}");
        assert!(err.contains("--paginate"), "and a runnable remedy: {err}");

        // One short of a page is a real answer.
        let short = gate_from_stdout(&format!("[{}]", rows[..PER_PAGE - 1].join(",")), 5);
        assert_eq!(short.probes.expect("authoritative").len(), 0);
        assert!(short.error.is_none());
    }

    /// A SHORT or one-word override is REFUSED. The reason is posted to the PR as the permanent
    /// record of a bypass, so it has to cost a sentence.
    #[test]
    fn a_short_or_one_word_override_reason_is_rejected() {
        for bad in ["", "ok", "x", "  because  ", "lgtm", "because-i-said-so-and-that-is-final"] {
            let err = validate_override(bad)
                .expect_err(&format!("must reject {bad:?} as an override reason"));
            assert!(
                err.contains("too short") || err.contains("more than one word"),
                "the refusal must say WHY: {err}"
            );
        }
        // And a real explanation is accepted, with surrounding whitespace trimmed.
        let ok = validate_override(
            "  Probe 1 is about a file this PR does not touch; verified against main.  ",
        )
        .expect("a real explanation is accepted");
        assert!(ok.starts_with("Probe 1"), "trimmed: {ok:?}");
        assert!(ok.ends_with("main."), "trimmed: {ok:?}");
        // The boundary itself, both sides. Exactly at the floor PASSES; one character short does
        // not — an off-by-one here either lets "ok" through or refuses a real explanation.
        let at_floor = "probe 1 is mine";
        assert_eq!(at_floor.chars().count(), MIN_OVERRIDE_REASON);
        assert!(validate_override(at_floor).is_ok(), "exactly at the floor must pass");
        assert!(
            validate_override(&at_floor[..MIN_OVERRIDE_REASON - 1]).is_err(),
            "one character short must not"
        );
    }

    /// The override record must name every bypassed probe and quote the reason, and it must carry
    /// the marker so the record is machine-findable later.
    #[test]
    fn the_override_record_names_the_probes_and_quotes_the_reason() {
        let gate = gate_for("real-pr-1176.json");
        let blocking = gate.unanswered_blocking();
        let body = override_comment_body(
            &blocking,
            "Shipping ahead of the fix;\nprobe 1 is tracked as sparkle-xxxx.",
            None,
        );
        assert!(body.starts_with(OVERRIDE_MARKER), "the marker leads the body: {body}");
        // Identified as (comment_id, index) — and deliberately NOT as "Probe 1", which the citation
        // grammar would read as an answer. See `an_override_record_never_answers_…`.
        assert!(body.contains("review comment 5182769304, item 1"), "the probe's identity: {body}");
        assert!(body.contains("[from: contract-drift]"), "the specialist: {body}");
        assert!(body.contains("The landing gate still checks"), "the probe's words: {body}");
        assert!(body.contains("Shipping ahead of the fix;"), "the reason: {body}");
        assert!(
            body.contains("\n> probe 1 is tracked as sparkle-xxxx."),
            "a multi-line reason stays inside the blockquote: {body}"
        );
        // It must NOT claim the merge happened: this record is written BEFORE the merge, which can
        // still be declined afterwards. A record asserting a merge that never ran is a permanent lie.
        assert!(!body.contains("was merged"), "the record must not claim the merge happened: {body}");
        assert!(body.contains("initiated from Sparkle"), "it says what DID happen: {body}");

        // The UNKNOWN flavour admits a DIFFERENT thing and must say so.
        let unknown_body =
            override_comment_body(&[], "network was down for the read", Some("gh exited 1"));
        assert!(unknown_body.contains("UNREADABLE"), "{unknown_body}");
        assert!(unknown_body.contains("gh exited 1"), "{unknown_body}");
        assert!(
            !unknown_body.contains("bypassed:"),
            "there is no probe list to render: {unknown_body}"
        );
    }

    /// The argv the API actually receives. `--paginate` is the load-bearing flag: without it a busy
    /// PR loses its NEWEST comments, which is both the latest review and every reply to it.
    #[test]
    fn the_comment_read_argv_paginates() {
        let argv = comments_argv(1176);
        assert!(argv.contains(&"--paginate".to_string()), "must paginate: {argv:?}");
        assert!(
            argv.iter().any(|a| a == "repos/{owner}/{repo}/issues/1176/comments?per_page=100"),
            "the endpoint, with a full page size: {argv:?}"
        );
        assert_eq!(argv[0], "api");
    }

    /// THE GATE'S OWN DECISION, all five transitions. Nothing covered this before: replacing
    /// `enforce`'s body with `Ok(())` left the whole suite green while the feature was inert.
    #[test]
    fn the_gate_decides_every_transition() {
        let refusing = gate_for("real-pr-1176.json");
        let clean = gate_for("open-only.json");
        let unknown = ProbeGate::unknown("gh api exited non-zero".to_string());
        let good = "Probe 1 is about a file this PR does not touch.";

        // 1. Unanswered blocking, no override ⇒ REFUSE, naming the probe.
        let Decision::Refuse(msg) = decide(&refusing, 1176, None) else {
            panic!("an unanswered [blocking] probe must refuse the merge");
        };
        assert!(msg.contains("Merge blocked") && msg.contains("probe 1"), "{msg}");

        // 2. Nothing to bypass ⇒ ALLOW. [open]-only merges clean.
        assert_eq!(decide(&clean, 9, None), Decision::Allow);
        // …and NOT-APPLICABLE likewise: a project knightwatch has never touched merges freely.
        assert_eq!(decide(&gate_for("impostor-no-marker.json"), 9, None), Decision::Allow);

        // 3. Unanswered blocking + a VALID override ⇒ record, then allow.
        let Decision::RecordThenAllow { body, bypassed, unknown: was_unknown } =
            decide(&refusing, 1176, Some(good))
        else {
            panic!("a valid override must record and then allow");
        };
        assert_eq!(bypassed, 1);
        assert!(!was_unknown);
        assert!(body.contains(OVERRIDE_MARKER) && body.contains(good), "{body}");

        // 4. A BAD override does not become a bypass — it is still a refusal.
        let Decision::Refuse(msg) = decide(&refusing, 1176, Some("ok")) else {
            panic!("a one-word override must not open the gate");
        };
        assert!(msg.contains("too short"), "{msg}");

        // 5. UNKNOWN blocks, and an override clears it — with a record that admits WHICH thing
        //    happened, since "we could not read the gate" is a different admission from "we read it
        //    and went anyway".
        let Decision::Refuse(msg) = decide(&unknown, 9, None) else {
            panic!("an unreadable gate must block, not pass by default");
        };
        assert!(msg.contains("could not determine"), "{msg}");
        assert!(msg.contains("gh api exited non-zero"), "in the tool's own words: {msg}");
        let Decision::RecordThenAllow { body, bypassed, unknown: was_unknown } =
            decide(&unknown, 9, Some(good))
        else {
            panic!("an override must clear UNKNOWN too — it is the only way past it");
        };
        assert_eq!(bypassed, 0);
        assert!(was_unknown);
        assert!(body.contains("UNREADABLE"), "{body}");

        // 6. An override supplied when there is nothing to bypass posts NOTHING. A false record on
        //    the PR is worse than none — a later reader cannot tell it from a true one.
        assert_eq!(decide(&clean, 9, Some(good)), Decision::Allow);
    }

    /// THE SELF-ANSWER HOLE, SECOND DOOR. Our OWN override record is not a knightwatch comment, so
    /// the review window happily treats it as a reply. If it cited the probes it bypassed, the next
    /// read would score them ANSWERED — so a merge that recorded an override and then failed (red
    /// required checks) would sail through on the retry with no refusal and no second record.
    #[test]
    fn an_override_record_never_answers_the_probes_it_bypassed() {
        let review = format!("{REVIEW_MARKER}\n1. [blocking] [from: a] a real finding");
        let gate = evaluate(&[comment(1, &review)]);
        let bypassed = gate.unanswered_blocking();
        assert_eq!(ids(&bypassed), vec!["1#1"], "the probe starts out unanswered");

        // The record this module would actually post, replayed as a later comment on the same PR.
        let record = override_comment_body(&bypassed, "Shipping over probe 1; tracked elsewhere.", None);
        let after = evaluate(&[comment(1, &review), comment(2, &record)]);
        assert_eq!(
            ids(&after.unanswered_blocking()),
            vec!["1#1"],
            "the override record must NOT answer the probe it bypassed"
        );

        // THREE independent locks, each asserted on its own so no one of them can hide a regression
        // in the others.
        //
        // 1. The record's own probe list avoids citation form. Checked with the user's reason
        //    removed, so this measures what THIS module renders, not what the user wrote.
        let generated_only = record.replace("Shipping over probe 1; tracked elsewhere.", "");
        assert!(
            !cites_ignoring_quoting(&generated_only, 1),
            "the generated record must not name a probe in citation form, quoted or not: {record}"
        );
        // 2. The user's reason DOES name the probe — that text is not ours to sanitise, and it is
        //    the reason locks 3 and 4 have to exist. (Present in the raw text…)
        assert!(
            cites_ignoring_quoting(&record, 1),
            "the user's reason really does write 'probe 1'"
        );
        // 3. …but the record renders that reason inside a BLOCKQUOTE, so rule 4 already discounts it.
        assert!(!cites_probe(&record, 1), "and the record quotes it, so it is not a citation");
        // 4. And the marker anchoring excludes the record from the replier set regardless.
        assert!(
            record.trim_start().starts_with(OVERRIDE_MARKER),
            "the record must START with the marker — anchoring is what excludes it"
        );
    }

    /// THE OTHER SIDE of that exclusion, and it must not be widened into it. GitHub's "Quote reply"
    /// reproduces the quoted comment's RAW markdown, HTML comments included — so a human answering a
    /// probe while quoting the override record posts a body that CONTAINS the marker. Excluding on
    /// `contains` would drop that reply, leaving the probe unanswered and the merge refused a second
    /// time, with the refusal telling the user to do the exact thing they just did while their
    /// citation sits visible on the PR. A false refusal from a lost answer is the failure rule 4
    /// exists to prevent, so the exclusion is anchored at the START of the body.
    #[test]
    fn a_reply_that_quotes_the_override_record_still_answers_the_probe() {
        let review = format!("{REVIEW_MARKER}\n1. [blocking] [from: a] a real finding");
        let gate = evaluate(&[comment(1, &review)]);
        let record = override_comment_body(
            &gate.unanswered_blocking(),
            "Shipping now; the finding is tracked elsewhere.",
            None,
        );
        // Exactly what GitHub's quote-reply produces: every line prefixed with "> ", marker included.
        let quoted = format!(
            "> {}\n\nProbe 1 — declined, and here is why.",
            record.trim_end().replace('\n', "\n> ")
        );
        assert!(quoted.contains(OVERRIDE_MARKER), "the quote really does carry the marker");
        assert!(
            !quoted.trim_start().starts_with(OVERRIDE_MARKER),
            "but it does not START with it — that is the whole discriminator"
        );

        let after = evaluate(&[comment(1, &review), comment(2, &record), comment(3, &quoted)]);
        assert!(
            after.unanswered_blocking().is_empty(),
            "a human's answer must count even when it quotes the override record: {:?}",
            ids(&after.unanswered_blocking())
        );
        // And the record ITSELF still does not answer — both facts hold at once.
        let record_only = evaluate(&[comment(1, &review), comment(2, &record)]);
        assert_eq!(ids(&record_only.unanswered_blocking()), vec!["1#1"]);
    }

    /// THE THIRD DOOR, opened by anchoring the exclusion: a quote-reply is no longer excluded, and
    /// the record it quotes carries the USER'S OWN REASON verbatim — which may name the probe. So a
    /// bystander who quotes the record just to ask about it would have scored the probe answered
    /// without saying anything about it. Quoted text is somebody else's words being shown, never an
    /// answer, so a citation inside a `>` line does not count.
    #[test]
    fn a_citation_that_exists_only_inside_quoted_text_does_not_answer() {
        let review = format!("{REVIEW_MARKER}\n1. [blocking] [from: a] a real finding");
        let gate = evaluate(&[comment(1, &review)]);
        // The reason cites the probe — the module's own comments say this is expected and untouchable.
        let record = override_comment_body(
            &gate.unanswered_blocking(),
            "Shipping over probe 1; tracked elsewhere.",
            None,
        );
        let bystander = format!(
            "> {}\n\nWhat does this mean for the release?",
            record.trim_end().replace('\n', "\n> ")
        );
        // The quoted half really does carry a citation — otherwise this passes for the wrong reason.
        assert!(
            bystander.lines().any(|l| l.trim_start().starts_with('>') && line_cites_probe(l, 1)),
            "the quoted text must actually cite probe 1: {bystander}"
        );
        assert!(!cites_probe(&bystander, 1), "but quoted text is not a citation");

        let after = evaluate(&[comment(1, &review), comment(2, &record), comment(3, &bystander)]);
        assert_eq!(
            ids(&after.unanswered_blocking()),
            vec!["1#1"],
            "a bystander quoting the record must not answer the probe"
        );
        // The same shape from a quote of the REFUSAL, which renders `• probe 1 …` in citation form.
        let quoted_refusal = blocking_refusal(9, &gate.unanswered_blocking())
            .lines()
            .map(|l| format!("> {l}"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!cites_probe(&quoted_refusal, 1), "a quoted refusal is not an answer either");
    }

    /// STRUCTURAL: `merge_pr` must actually CALL the gate, and PROPAGATE its refusal. Deleting that
    /// one line leaves every test in this module green while the feature is entirely inert — the
    /// same reason `worktree.rs` carries a structural guard for `gh_program`.
    ///
    /// Three things this asserts that a looser version did not, each a way the guard was satisfiable
    /// while the gate did nothing:
    ///   * The search is SCOPED to `merge_pr`'s body. A file-wide `contains` is satisfied by the
    ///     function's own DOC COMMENT, which names `crate::knightwatch::enforce` in prose — one
    ///     added paren there would pass with no call anywhere.
    ///   * It requires the `?;` PROPAGATING form. `let _ = crate::knightwatch::enforce(…);` compiles
    ///     and swallows every refusal; `unused_must_use` is warn-by-default and nothing in this
    ///     crate (no `[lints]` in `Cargo.toml`, no `deny` in `lib.rs`/`main.rs`) or in CI promotes it
    ///     to an error, so the suite would stay green with the gate fully disarmed.
    ///   * It requires the call to sit BEFORE the merge argv — a gate that runs after a merge is not
    ///     a gate.
    ///   * It matches a whole trimmed LINE, not a substring, so `// crate::knightwatch::enforce(…)?;`
    ///     fails. Commenting the call out is the cheapest way anyone "temporarily" disarms a gate,
    ///     and it is cheaper than the `let _ =` form above — a substring test waves both through.
    #[test]
    fn merge_pr_actually_runs_the_gate() {
        const CALL: &str =
            "crate::knightwatch::enforce(&root, number, knightwatch_override.as_deref())?;";
        let src = include_str!("worktree.rs");
        // Slice from the signature, so the doc comment above it cannot satisfy the search.
        let start = src.find("pub async fn merge_pr(").expect("merge_pr's signature");
        let body = &src[start..];
        // The argv is built by `merge_argv(…)` — the pure builder that owns the `--merge` and
        // `--match-head-commit` rules — so THAT call is the merge landmark, not the literal.
        let merge = body.find("merge_argv(number,").expect("the merge argv");
        assert!(
            body[..merge].lines().any(|l| l.trim() == CALL),
            "merge_pr must call the gate as a STATEMENT, with `?`, BEFORE `gh pr merge`. Matching a \
             whole line is deliberate: `let _ = …;` compiles and silently swallows every refusal \
             (unused_must_use is only a warning in this crate), and `// …` disarms the gate outright \
             — a substring test passes for both."
        );
    }

    /// The structural guard `worktree.rs` carries, applied to this module too: a Finder-launched app
    /// does not inherit the login-shell PATH, so a bare `gh` cannot be found — and every gh caller
    /// here degrades a spawn failure into UNKNOWN, which would block every merge in the repo.
    #[test]
    fn every_gh_invocation_goes_through_gh_program() {
        let needle = format!("Command::new(\"{}\")", "gh"); // built at runtime so this can't match itself
        assert!(
            !include_str!("knightwatch.rs").contains(&needle),
            "spawn gh via crate::preflight::gh_program(), not the bare name"
        );
    }

    /// The three states must be tellable apart by a consumer reading only the struct.
    #[test]
    fn the_three_gate_states_are_distinguishable() {
        let na = ProbeGate::not_applicable();
        let unknown = ProbeGate::unknown("gh is not installed".to_string());
        let answered = gate_for("open-only.json");
        assert!(!na.applicable && na.probes.is_some());
        assert!(unknown.applicable && unknown.probes.is_none());
        assert!(answered.applicable && answered.probes.is_some());
        assert_ne!(na.applicable, unknown.applicable, "'not the gate' != 'could not read it'");
        assert_ne!(unknown.probes, answered.probes, "'could not read it' != 'read it'");
    }

    /// Probe text is truncated on a CHAR boundary. Probe bodies routinely carry `—`, `’` and emoji,
    /// and slicing a `&str` mid-codepoint panics — inside a merge gate, that is a crash on the
    /// founder's merge button.
    #[test]
    fn long_multibyte_probe_text_truncates_without_panicking() {
        let long = "— ".repeat(400);
        let line = format!("1. [blocking] {long}");
        let (_, _, _, text) = parse_probe_line(&line).expect("parses");
        assert!(text.chars().count() <= PROBE_TEXT_MAX + 1, "truncated: {}", text.chars().count());
        assert!(text.ends_with('…'), "and marked as truncated");
        // Short text is left exactly alone.
        let (_, _, _, short) = parse_probe_line("1. [blocking] tiny").unwrap();
        assert_eq!(short, "tiny");
    }

    // ── COVERAGE: WHICH HEAD DID THE NEWEST REVIEW ACTUALLY READ ─────────────────────────────────
    // Every status below is copied from a real knightwatch post (#1249, #1256, #1251, #1273), so a
    // wording change upstream fails these rather than silently degrading to "cannot tell".

    /// A review of the head is COVERED — the baseline the other cases are read against.
    #[test]
    fn a_first_review_names_the_head_it_read() {
        let body = format!(
            "{REVIEW_MARKER}\n> 📋 First review of this PR — reviewed `c977040`. 🧪 Tests not run.\n"
        );
        let gate = evaluate(&[comment(1, &body)]);
        assert_eq!(gate.reviewed_head.as_deref(), Some("c977040"));
        assert!(!gate.review_stale, "nothing self-labelled it stale");
    }

    /// Form 2 names a FROM and a TO, and `git diff FROM..TO` repeats both. The head that was
    /// reviewed is the TO — reading the FROM would report a PR as covered at the exact moment a
    /// re-review proves it moved.
    #[test]
    fn a_re_review_of_changes_names_the_to_sha_not_the_from() {
        let body = format!(
            "{REVIEW_MARKER}\n> 📋 Re-review of changes from `c977040` to `9769dc7` \
             (`git diff c977040..9769dc7`). 🧪 Tests not run.\n"
        );
        let gate = evaluate(&[comment(1, &body)]);
        assert_eq!(gate.reviewed_head.as_deref(), Some("9769dc7"), "the TO sha");
        assert_ne!(gate.reviewed_head.as_deref(), Some("c977040"), "never the FROM sha");
    }

    /// Form 3 is a DIFFERENT form, not a variant of form 2: one sha (the head it read) plus the
    /// sha it could not diff against. SKILL.md records that omitting this row made the babysit loop
    /// non-terminating, so the assertion is specifically that the head wins over the decoy.
    #[test]
    fn a_re_review_at_names_the_head_it_evaluated_not_the_unavailable_base() {
        let body = format!(
            "{REVIEW_MARKER}\n> 📋 Re-review at `e129301` — clean incremental unavailable for \
             `9150dfe` (rebase, force-push, or merge from base branch); evaluated full PR.\n"
        );
        let gate = evaluate(&[comment(1, &body)]);
        assert_eq!(gate.reviewed_head.as_deref(), Some("e129301"), "the head it read");
        assert_ne!(gate.reviewed_head.as_deref(), Some("9150dfe"), "not the base it could not use");
    }

    // ── THE CONVERGENCE GATE ────────────────────────────────────────────────────────────────────
    //
    // These assert the VERDICT, not the parse. The fields these read have been parsed correctly for
    // as long as they have existed — the defect was that nothing consulted them — so a test that
    // asserted `reviewed_head` was populated would have passed before this gate existed and proven
    // nothing about whether a merge is refused.

    /// A gate with a review that read `reviewed`, not self-labelled stale.
    fn covering(reviewed: &str) -> ProbeGate {
        let body = format!(
            "{REVIEW_MARKER}\n> 📋 First review of this PR — reviewed `{reviewed}`.\n"
        );
        evaluate(&[comment(1, &body)])
    }

    #[test]
    fn a_review_naming_the_current_head_is_covered() {
        // The bot abbreviates to 7; the oid is 40. Prefix, and this is the only Covered branch.
        assert_eq!(coverage(&covering("9c65efe"), Some("9c65efe1122334455667788990011223344556677")), Coverage::Covered);
    }

    /// PR #1273 VERBATIM — the merge this whole gate exists to refuse. The review read `275f462`;
    /// the head had moved to `1867679` by the time the merge ran.
    #[test]
    fn a_head_that_outran_the_review_is_not_covered() {
        let Coverage::NotCovered(why) = coverage(&covering("275f462"), Some("1867679aabbccddeeff00112233445566778899a"))
        else {
            panic!("a head the reviewer never read must not be covered");
        };
        assert!(why.contains("275f462"), "names what was reviewed: {why}");
        assert!(why.contains("1867679"), "names what is being merged: {why}");
    }

    /// The operand order, pinned on its own because flipping it is silent and inverts the gate:
    /// `reviewed.starts_with(head)` is false for a genuinely covered PR and true for nothing
    /// useful, so the gate would block every merge and get "fixed" by being deleted.
    #[test]
    fn the_prefix_runs_short_against_long_never_the_reverse() {
        let full = "9c65efe1122334455667788990011223344556677";
        assert_eq!(coverage(&covering("9c65efe"), Some(full)), Coverage::Covered);
        // The reverse relation does not hold, which is what makes the direction load-bearing.
        assert!(!"9c65efe".starts_with(full));
    }

    /// AUTHORITATIVE, and it must beat the SHA arithmetic: a stale run still NAMES a sha, and here
    /// that sha matches the head exactly. Trusting the arithmetic alone would call this covered.
    #[test]
    fn a_self_labelled_stale_review_blocks_even_when_its_sha_matches_the_head() {
        let body = format!(
            "{REVIEW_MARKER}\n> 📋 First review of this PR — reviewed `9c65efe`. ⚠️ Stale: head \
             moved from `9c65efe` to `4d3030a` mid-run — see commands below to re-run.\n"
        );
        let gate = evaluate(&[comment(1, &body)]);
        assert_eq!(gate.reviewed_head.as_deref(), Some("9c65efe"), "precondition: it names a sha");
        let Coverage::NotCovered(why) = coverage(&gate, Some("9c65efe1122334455667788990011223344556677"))
        else {
            panic!("the bot's own stale label outranks our sha comparison");
        };
        assert!(why.contains("Stale"), "says the bot self-labelled it: {why}");
    }

    /// Never infer coverage from silence. A lifecycle status post, or a form this parser does not
    /// recognise, names no sha — and "no evidence it was reviewed" is not "it was reviewed".
    #[test]
    fn a_review_that_names_no_sha_is_not_covered() {
        let gate = evaluate(&[comment(1, &format!("{REVIEW_MARKER}\n> 📋 Something new.\n"))]);
        assert_eq!(gate.reviewed_head, None, "precondition: nothing parsed a sha");
        assert!(matches!(coverage(&gate, Some("9c65efe112233")), Coverage::NotCovered(_)));
    }

    /// UNKNOWN blocks, the same doctrine the probe gate applies to an unreadable comment list.
    #[test]
    fn an_unreadable_head_is_not_covered() {
        let Coverage::NotCovered(why) = coverage(&covering("9c65efe"), None) else {
            panic!("\"could not find out\" is not \"covered\"");
        };
        assert!(why.contains("could not be read"), "says which read failed: {why}");
    }

    /// The deliberate carve-out. A repo the reviewer does not watch must keep merging — this is the
    /// one branch that intentionally departs from the skill's prose, so it is pinned explicitly.
    #[test]
    fn a_pr_the_reviewer_never_posted_on_does_not_block() {
        let gate = ProbeGate::not_applicable();
        assert_eq!(coverage(&gate, None), Coverage::NotApplicable);
        assert_eq!(coverage(&gate, Some("9c65efe112233")), Coverage::NotApplicable);
    }

    /// THE WIRING, not the pure verdict. Deleting `decide_coverage`'s call from `enforce` left
    /// every `coverage` test above green while the gate was entirely inert, so the decision that
    /// actually refuses a merge is asserted here.
    #[test]
    fn an_uncovered_head_refuses_the_merge_and_an_override_records_it() {
        let gate = covering("275f462");
        let head = Some("1867679aabbccddeeff00112233445566778899a");

        assert!(matches!(decide_coverage(&gate, head, 1273, None), Decision::Refuse(_)));

        // A covered head is simply allowed — the gate must not block what it has no quarrel with.
        let covered = Some("275f462aabbccddeeff00112233445566778899a");
        assert_eq!(decide_coverage(&gate, covered, 1273, None), Decision::Allow);

        // An override RECORDS before it allows, and the record is what makes the bypass auditable.
        let good = "the runner was offline and this head is a version bump only";
        let Decision::RecordThenAllow { body, .. } = decide_coverage(&gate, head, 1273, Some(good))
        else {
            panic!("a valid override must record and allow");
        };
        assert!(body.contains(OVERRIDE_MARKER), "the record is machine-findable");
        assert!(body.contains("275f462"), "it names the head that WAS reviewed: {body}");

        // A keystroke is not a reason.
        assert!(matches!(decide_coverage(&gate, head, 1273, Some("ok")), Decision::Refuse(_)));
    }

    /// A multi-line reason must stay inside the blockquote. With a bare leading `> ` the second
    /// line onward renders as body text — the same defect `override_comment_body` documents.
    #[test]
    fn every_line_of_an_override_reason_is_quoted() {
        let body = coverage_override_body("the review read 275f462", "first line\nsecond line");
        assert!(body.contains("> first line"), "{body}");
        assert!(body.contains("> second line"), "the second line must be quoted too: {body}");
    }

    /// THE WIRING, STRUCTURALLY — because calling `decide_coverage` from a test asserts the same
    /// pure verdict the `coverage` tests already did. Deleting the call from `enforce`, or
    /// restoring the `return Ok(())` in the probe override arm, left all 55 of those green: the
    /// vacuity had been RELOCATED from `coverage` to `decide_coverage`, not closed.
    ///
    /// So this reds on the exact two edits the fix consists of, using the same `include_str!` +
    /// body-scoped whole-line technique as `merge_pr_actually_runs_the_gate`.
    #[test]
    fn enforce_judges_coverage_and_no_override_arm_returns_before_it() {
        let src = include_str!("knightwatch.rs");
        // Slice from the signature so the doc comment above it cannot satisfy the search.
        let start = src.find("pub(crate) fn enforce(").expect("enforce's signature");
        let body = &src[start..];
        // TERMINATE ON AN ITEM THAT REALLY FOLLOWS `enforce`, and hard-fail if it moves. The
        // previous delimiter (`\n/// BOTH gates`) is the doc comment on `both_gates_refusal`, which
        // sits ABOVE `enforce` — so the search never matched, `unwrap_or(body.len())` widened the
        // slice to EOF, and the first assertion below then found its own source literal inside
        // `mod tests`. It passed with the head read deleted from `enforce`: this guard against
        // relocated vacuity was itself vacuous. Never `unwrap_or(body.len())` for a delimiter whose
        // absence silently widens the scope.
        let end = body
            .find("\n/// THE COVERAGE DECISION, PURE")
            .expect("the item that follows enforce — re-scope this slice rather than widening it");
        let body = &body[..end];

        assert!(
            body.contains("coverage(&gate, read_head(root, number).as_deref())"),
            "enforce must actually READ the head and compute coverage; without this call the whole \
             gate is inert while every `coverage` unit test stays green"
        );
        assert!(
            body.lines().any(|l| l.trim().starts_with("match decide_coverage_from(")),
            "enforce must dispatch on the coverage verdict as a STATEMENT — `let _ = …` compiles \
             and silently swallows the refusal, and a substring test passes for it"
        );

        // The probe override arm must NOT return before coverage is judged. That early return is
        // precisely how a probes rationale silently waived the head check, twice.
        let probe_arm = body
            .find("Decision::RecordThenAllow { body, bypassed, unknown } => {")
            .expect("the probe override arm");
        let arm = &body[probe_arm..];
        // Same rule as the slice above: an absent delimiter must FAIL, never silently widen.
        let arm_end = arm.find("Decision::Allow => {}").expect("the arm that ends the probe match");
        assert!(
            arm[..arm_end].contains("both_gates_refusal(number, reason, unknown)"),
            "the probe override arm must refuse when coverage ALSO failed — one rationale buys one \
             bypass, and without this the same string clears both gates and `coverage_refusal` is \
             never shown to the author"
        );
    }

    /// One reason does not buy two bypasses, asserted on the decision rather than the wiring.
    #[test]
    fn a_probes_rationale_does_not_also_clear_an_unreviewed_head() {
        let msg = both_gates_refusal(1273, "the newest review read 275f462", false);
        assert!(msg.contains("275f462"), "names what was reviewed: {msg}");
        assert!(
            msg.contains("NOT posted"),
            "must say nothing was recorded — a refusal that leaves a record implies a merge: {msg}"
        );
        assert!(msg.contains("/srosro-update-review"), "names the remedy: {msg}");
    }

    /// THE REMEDY IT NAMES HAS TO BE REACHABLE. Asserted on the DECISION, not on the sentence: the
    /// old copy told the author to re-type the reason "about THE HEAD specifically and merge
    /// again", and that retry cannot work — there is one override channel, and while blocking
    /// probes are outstanding `decide` consumes any supplied rationale as the PROBE bypass and
    /// returns `RecordThenAllow`, so `enforce` refuses in the same place with the same words. A
    /// text-only test could not see that; this drives the same input the retry would.
    #[test]
    fn the_retry_the_refusal_used_to_promise_takes_the_identical_path() {
        let body = format!(
            "{REVIEW_MARKER}\n> 📋 First review of this PR — reviewed `275f462`.\n\n\
             1. [blocking] [from: tests] [bug] an unanswered finding\n"
        );
        let gate = evaluate(&[comment(1, &body)]);

        // Precondition: BOTH gates fail — that is the only state this refusal is reached from.
        assert_eq!(ids(&gate.unanswered_blocking()), vec!["1#1"], "the probe gate must fail");
        let head = "1867679aabbccddeeff00112233445566778899a";
        assert!(
            matches!(coverage(&gate, Some(head)), Coverage::NotCovered(_)),
            "the coverage gate must fail too"
        );

        // A rationale written squarely about the head is STILL taken as the probe bypass, so the
        // second attempt reaches `both_gates_refusal` exactly as the first did.
        for reason in [
            "the newest review read 275f462 and that is the code that matters",
            "THE HEAD specifically needs no review: the delta is comments only",
        ] {
            assert!(
                matches!(decide(&gate, 1273, Some(reason)), Decision::RecordThenAllow { .. }),
                "a supplied reason is always consumed by the probe gate, so re-typing it cannot \
                 reach decide_coverage_from — reason: {reason}"
            );
        }

        // …so the copy must name the two exits that DO work, and say the retry does not.
        let msg = both_gates_refusal(1273, "the newest review read 275f462", false);
        assert!(
            msg.contains("Rewording this reason will not clear it"),
            "must not send the author back for a retry that lands here again: {msg}"
        );
        assert!(msg.contains("Answer the [blocking] probes"), "names the first working exit: {msg}");
        assert!(msg.contains("/srosro-update-review"), "names the second working exit: {msg}");
    }

    /// THE UNREADABLE GATE REACHES THE SAME REFUSAL WITH NOTHING TO ANSWER. `read_gate` returns
    /// `ProbeGate::unknown` on a failed or saturated comment read; that gate is `applicable: true`
    /// with `probes: None`, so `decide` still consumes the rationale and `coverage` still reports
    /// `NotCovered` — landing on `both_gates_refusal` in a state where "answer the [blocking]
    /// probes" names a list that does not exist, and where a saturated read would not change if
    /// the author answered every probe on the PR. The first exit has to be state-dependent, so
    /// this pins BOTH branches: the readable one keeps the answer-the-probes exit, the unreadable
    /// one must not offer it.
    #[test]
    fn the_unreadable_probe_gate_is_not_told_to_answer_probes_it_cannot_list() {
        let gate = ProbeGate::unknown("gh: could not read the comment thread".to_string());
        let head = "1867679aabbccddeeff00112233445566778899a";

        // Precondition: this really is the both-gates state — the arm that calls the refusal.
        assert!(
            matches!(
                decide(&gate, 1273, Some("the head needs no review, the delta is comments only")),
                Decision::RecordThenAllow { unknown: true, .. }
            ),
            "an unreadable gate still consumes the rationale as the probe bypass"
        );
        assert!(
            matches!(coverage(&gate, Some(head)), Coverage::NotCovered(_)),
            "and coverage still fails, since no review named this head"
        );

        let msg = both_gates_refusal(1273, "no review names 1867679", true);
        assert!(
            !msg.contains("Answer the [blocking] probes"),
            "must not name a probe list that could not be read: {msg}"
        );
        assert!(
            msg.contains("could not be READ") && msg.contains("Re-run the merge once the probe read succeeds"),
            "must say the read failed and name the exit that exists for it: {msg}"
        );
        assert!(msg.contains("/srosro-update-review"), "the review exit works in this state too: {msg}");
    }

    #[test]
    fn the_head_read_asks_github_for_the_head_ref_oid() {
        let argv = head_argv(1273);
        assert!(argv.contains(&"headRefOid".to_string()), "must request the oid: {argv:?}");
        assert!(argv.contains(&"1273".to_string()), "for the PR it was asked about: {argv:?}");
    }

    /// The refusal has to be followable. A remedy naming no command is an obstacle, and AGENTS.md
    /// calls out the remedy-that-cannot-be-followed shape specifically.
    #[test]
    fn the_coverage_refusal_names_the_trigger_that_clears_it() {
        let msg = coverage_refusal(1273, "the newest review read 275f462");
        assert!(msg.contains("/srosro-update-review"), "names the re-review trigger: {msg}");
        assert!(msg.contains("override"), "names the escape hatch: {msg}");
    }

    /// The self-label CO-OCCURS with a recognised form — it does not replace one. Both facts must
    /// survive, which is why they are two fields. This is #1273 verbatim, the PR that produced the
    /// whole change: reviewed `9c65efe` while the head had already moved to `4d3030a`.
    #[test]
    fn the_stale_self_label_survives_alongside_the_reviewed_head() {
        let body = format!(
            "{REVIEW_MARKER}\n> 📋 First review of this PR — reviewed `9c65efe`. ⚠️ Stale: head \
             moved from `9c65efe` to `4d3030a` mid-run — see commands below to re-run.\n"
        );
        let gate = evaluate(&[comment(1, &body)]);
        assert_eq!(gate.reviewed_head.as_deref(), Some("9c65efe"), "still names what it read");
        assert!(gate.review_stale, "AND reports that the head has already moved past it");
    }

    /// The label is detected independently of the form, so an unrecognised status still yields the
    /// one field SKILL.md calls the most useful on the comment.
    #[test]
    fn the_stale_self_label_survives_a_status_form_we_cannot_parse() {
        let body = format!(
            "{REVIEW_MARKER}\n> 📋 Some future wording nobody has written yet. ⚠️ Stale: head \
             moved from `aaa1111` to `bbb2222` mid-run.\n"
        );
        let gate = evaluate(&[comment(1, &body)]);
        assert_eq!(gate.reviewed_head, None, "the form is genuinely unknown");
        assert!(gate.review_stale, "but not-covered is still authoritative");
    }

    /// An unrecognised status with no self-label is UNKNOWN, never "covered". Fail-closed against a
    /// dispatch: we report nothing rather than inventing a head.
    #[test]
    fn an_unparseable_status_yields_unknown_and_never_a_guess() {
        let body = format!("{REVIEW_MARKER}\n> 📋 Reviewed the thing. Looks fine.\n");
        let gate = evaluate(&[comment(1, &body)]);
        assert_eq!(gate.reviewed_head, None);
        assert!(!gate.review_stale);
    }

    /// THE REPOST-STORM CASE. `⏸ knightwatch paused` posts carry the marker, name no sha, and
    /// re-post every couple of minutes for as long as an outage lasts. Keying coverage on the last
    /// MARKER-carrying comment would let one erase a real review's coverage for the whole outage.
    #[test]
    fn a_lifecycle_status_post_does_not_erase_the_real_review_it_follows() {
        let review = format!(
            "{REVIEW_MARKER}\n> 📋 First review of this PR — reviewed `c977040`. 🧪 Tests not run.\n"
        );
        let paused = format!("{REVIEW_MARKER}\n> ⏸ knightwatch paused — upstream outage.\n");
        let gate = evaluate(&[comment(1, &review), comment(2, &paused)]);
        assert_eq!(
            gate.reviewed_head.as_deref(),
            Some("c977040"),
            "the newest comment that actually STATES coverage wins, not the newest marker"
        );
    }

    /// A newer real review supersedes an older one — the whole point of reading the newest.
    #[test]
    fn the_newest_real_review_supersedes_the_older_one() {
        let first = format!("{REVIEW_MARKER}\n> 📋 First review of this PR — reviewed `aaa1111`.\n");
        let second = format!(
            "{REVIEW_MARKER}\n> 📋 Re-review of changes from `aaa1111` to `bbb2222` \
             (`git diff aaa1111..bbb2222`).\n"
        );
        let gate = evaluate(&[comment(1, &first), comment(2, &second)]);
        assert_eq!(gate.reviewed_head.as_deref(), Some("bbb2222"));
    }

    /// Coverage is read from the BLOCKQUOTED status only. A probe may quote anything — including a
    /// previous review's status — and a head parsed out of a finding would name a sha nobody read.
    #[test]
    fn a_status_shaped_line_inside_a_probe_is_not_coverage() {
        let body = format!(
            "{REVIEW_MARKER}\n> 📋 First review of this PR — reviewed `c977040`.\n\n\
             1. [blocking] [from: a] First review of this PR — reviewed `dead123` is what it said.\n"
        );
        let gate = evaluate(&[comment(1, &body)]);
        assert_eq!(gate.reviewed_head.as_deref(), Some("c977040"), "the status, not the probe");
        // The decoy really is in the body, so this test cannot pass for lack of anything to find.
        assert!(body.contains("dead123"));
    }

    /// Both non-authoritative constructors carry UNKNOWN coverage. `not_applicable` in particular
    /// must not read as "covered" — every non-Sparkle PR is in that state.
    #[test]
    fn the_non_authoritative_gates_carry_no_coverage() {
        for gate in [ProbeGate::not_applicable(), ProbeGate::unknown("boom".into())] {
            assert_eq!(gate.reviewed_head, None, "{gate:?}");
            assert!(!gate.review_stale, "{gate:?}");
        }
    }

    /// Against the FROZEN shared corpus, so the parser is pinned to a real bot post and not only to
    /// strings written in this file.
    #[test]
    fn the_shared_corpus_review_reports_the_head_it_named() {
        assert_eq!(gate_for("real-pr-1176.json").reviewed_head.as_deref(), Some("01c5ed7"));
    }

    /// A HUMAN QUOTE-REPLY MUST NOT BECOME THE COVERAGE RECORD (roborev 58746, Medium).
    ///
    /// GitHub's "Quote reply" reproduces raw markdown, marker included, so the quote IS a review as
    /// far as the frozen `is_knightwatch` contract is concerned — and it is the NEWEST one. If its
    /// quoted status were read as coverage, a superseded sha (or worse, a quoted `⚠️ Stale` banner)
    /// would pin `commits-pushed-since-last-review` true forever and spend a Claude session on that
    /// PR every cooldown window, permanently. The nesting is what distinguishes them.
    #[test]
    fn a_quote_reply_does_not_overwrite_the_real_reviews_coverage() {
        // The quote must name a DIFFERENT sha from the newest real review, or the test passes
        // whether or not the guard works — a first draft quoted the newest review and was vacuous
        // under mutation for exactly that reason. So: a human quotes the OLD round-1 review, after
        // round 2 has already landed.
        let round_one =
            format!("{REVIEW_MARKER}\n> 📋 First review of this PR — reviewed `aaa1111`.\n");
        let round_two = format!(
            "{REVIEW_MARKER}\n> 📋 Re-review of changes from `aaa1111` to `bbb2222` \
             (`git diff aaa1111..bbb2222`).\n"
        );
        // Exactly what GitHub's quote-reply produces: EVERY line prefixed with "> ", so the original
        // marker lands at depth 1 and the original status at depth 2.
        let quoted_round_one: String =
            round_one.lines().map(|l| format!("> {l}\n")).collect::<String>()
                + "\nStill relevant — see above.\n";

        // The premises this rests on. Without them it could pass for lack of anything to find.
        assert!(is_knightwatch(&quoted_round_one), "a quote-reply really does read as a review");
        assert!(quoted_round_one.contains("aaa1111"), "and it really does carry the STALE sha");

        let gate = evaluate(&[
            comment(1, &round_one),
            comment(2, &round_two),
            comment(3, &quoted_round_one),
        ]);
        assert_eq!(
            gate.reviewed_head.as_deref(),
            Some("bbb2222"),
            "round 2's head survives; the quote of round 1 must not drag coverage backwards"
        );
    }

    /// The same defence for the field that would do the most damage: a quoted `⚠️ Stale` banner
    /// would make the PR permanently uncovered.
    #[test]
    fn a_quoted_stale_banner_does_not_mark_the_pr_stale() {
        let review = format!(
            "{REVIEW_MARKER}\n> 📋 First review of this PR — reviewed `c977040`. ⚠️ Stale: head \
             moved from `c977040` to `9769dc7` mid-run.\n"
        );
        let quoted: String = review.lines().map(|l| format!("> {l}\n")).collect();
        // The QUOTE alone, with no real review before it, must state nothing at all.
        let gate = evaluate(&[comment(1, &quoted)]);
        assert_eq!(gate.reviewed_head, None, "a quote states no coverage of its own");
        assert!(!gate.review_stale, "and cannot pin the PR stale forever");
    }

    /// Depth-1 content is returned; deeper nesting and non-quotes are refused.
    #[test]
    fn first_level_quote_accepts_only_depth_one() {
        assert_eq!(first_level_quote("> 📋 status"), Some("📋 status"));
        assert_eq!(first_level_quote(">no space"), Some("no space"));
        assert_eq!(first_level_quote("  > indented"), Some("indented"));
        assert_eq!(first_level_quote("> > nested"), None);
        assert_eq!(first_level_quote(">> nested tight"), None);
        assert_eq!(first_level_quote("plain text"), None);
    }
}
