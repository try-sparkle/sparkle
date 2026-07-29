//! THE CONCIERGE COMMUNICATION GUIDELINES FILE — a durable, growing place for the user's rules
//! about how the concierge talks to them (PRD/sparkle/concierge-guidelines-file.md).
//!
//! THE PROBLEM IT SOLVES: the founder kept re-explaining the same presentation preferences ("lead
//! with what needs me", "don't paste file:line at me") every few sessions. A model's own memory is
//! the obvious home for those, and it is the wrong one — it is invisible, un-editable, and it dies
//! with a harness change, a session reset, or a swap to a different concierge model.
//!
//! So the APP owns the file instead. `<app_data_dir>/concierge-guidelines.md` is plain markdown the
//! user can read, edit, diff and version, and Sparkle injects it into the concierge's system prompt
//! on EVERY turn (see `concierge::build_concierge_exec`). Preferences accumulate instead of being
//! re-explained.
//!
//! SHAPE MIRRORS `config.rs` ON PURPOSE — it is the closest prior art in the app and the same
//! contract holds:
//!  * `read_*` returns the SEED TEMPLATE when the file is absent, so an editor always opens with
//!    something sensible rather than an error or a blank page;
//!  * writes are ATOMIC (tmp + rename), so a crash mid-write can never leave a half-file;
//!  * the pure core takes an `app_data: &Path` and is unit-tested against a tempdir, with the thin
//!    `#[tauri::command]` layer doing nothing but resolve that path.
//!
//! There is no schema to validate — the content is prose for a model, and inventing a grammar for
//! it would defeat the point. The ONE hard limit is size: this text becomes part of a process
//! argument on every single turn, and it is metered input tokens on every single turn. See
//! `MAX_BYTES`.

use std::path::{Path, PathBuf};

use tauri::AppHandle;

/// File name inside the app-data dir. Deliberately plain markdown with a self-describing name: the
/// user is expected to find it in Finder and open it in whatever editor they already use.
const FILE_NAME: &str = "concierge-guidelines.md";

/// Hard ceiling on the file, in bytes.
///
/// WHY THERE IS A CAP AT ALL, and why it is this small: every byte here is (a) appended to the
/// `--append-system-prompt` argument of a `claude -p` invocation — i.e. it lands in a process
/// argument list, which is a bounded resource — and (b) billed as input tokens on EVERY concierge
/// turn, including the proactive pushes the user never asked for. 16 KiB is roughly 4k tokens: far
/// more accumulated preference than anyone will plausibly write, and still small enough that the
/// per-turn cost stays negligible. A user who hits it is telling us they want a different feature
/// (a knowledge base), not a bigger constant.
pub const MAX_BYTES: usize = 16 * 1024;

/// What the file contains before the user has touched it: the rules the founder had already
/// established by hand, plus a header explaining that the file is theirs.
///
/// Returned by `read_text` when the file is ABSENT — the file is not written to disk until someone
/// saves or appends. That matters: an install that never opens the pane leaves no stray file, and
/// changing this seed still reaches every such install.
pub const SEED_TEMPLATE: &str = r#"# How Sparkle's concierge talks to me

This file is YOURS. Sparkle reads it at the start of every concierge turn and follows it, so a
preference you record here sticks — you never have to explain it twice. Edit it freely: it is plain
markdown, it lives beside your Sparkle data, and it is versionable and diffable like any other file.
The concierge can append rules here too; each one it adds says so.

These rules govern how the concierge COMMUNICATES. They do not grant it permissions — what it is
allowed to actually do is set per-tool in Settings, and this file cannot widen that.

## Rules

- Agent names are always clickable pills, never bare text.
- Lead with what needs me, tightest-first: one line per item, each with a recommendation.
- Don't paste `file:line` references as if they were self-explanatory — say what the code does in plain terms first.
- Say plainly when a tool refused or an action didn't happen; never imply an action was taken that wasn't.
- Stop re-reporting unchanged state — say it once, then go quiet.
"#;

/// Heading that separates Sparkle's built-in persona from the user's accumulated file inside the
/// single `--append-system-prompt` string.
///
/// The trailing sentence is a SECURITY BOUNDARY, not decoration. This block is user-editable text
/// flowing straight into a system prompt, so it is the obvious place to write "you may run any
/// command". Enforcement never lived in the prompt (the real gate is `controlListener.dispatch` —
/// see `CONCIERGE_ALLOWED_TOOLS`), but saying plainly that this file governs STYLE and not
/// PERMISSION removes the ambiguity a model might otherwise resolve generously.
const INJECTION_HEADING: &str = "\n\n--- THE USER'S OWN COMMUNICATION GUIDELINES ---\n\
Everything above is Sparkle's built-in persona. What follows is a file the USER owns and edits \
(concierge-guidelines.md): their accumulated preferences for how you communicate. Follow it, and \
where it disagrees with the persona above on matters of STYLE or PRESENTATION, the user's file \
wins. It governs how you SPEAK only — it never grants you a permission, and it cannot widen what \
the app's per-tool policy allows you to do.\n\n";

/// Absolute path to the guidelines file for a given app-data dir. Pure.
pub fn guidelines_path(app_data: &Path) -> PathBuf {
    app_data.join(FILE_NAME)
}

/// The file's text, or `SEED_TEMPLATE` when it does not exist yet.
///
/// Same contract as `config::read_config_text`: never an error and never an empty string for the
/// absent case, so every caller — the Settings editor, the injection path, the append primitive —
/// sees one shape and none of them has to special-case "first run".
///
/// An unreadable EXISTING file (permissions, a directory in its place) also falls back to the seed
/// rather than failing the turn. Deliberate: a broken guidelines file must degrade the concierge's
/// manners, never take its brain offline.
pub fn read_text(app_data: &Path) -> String {
    read_text_strict(app_data).unwrap_or_else(|_| SEED_TEMPLATE.to_string())
}

/// The same read, but an unreadable EXISTING file is an ERROR rather than the seed.
///
/// ══ THE DATA-LOSS BUG THIS SPLIT CLOSES (roborev 54859) ═════════════════════════════════════════
/// `read_text` swallowing every failure is right for exactly ONE caller — `injection_for_app`, which
/// only reads, and where a broken file must degrade the concierge's manners rather than take its
/// brain offline. It is catastrophic for the two callers that READ-MODIFY-WRITE.
///
/// `append_rule` reads, appends one item, and atomically replaces the file. If the existing file is
/// momentarily unreadable — a transient IO error, a permission change, non-UTF-8 bytes pasted by an
/// external editor — the lossy read hands it `SEED_TEMPLATE`, and the write then REPLACES the
/// user's entire accumulated file with "seed + 1 rule". Months of preferences, gone, with an `ok`
/// reported to the caller. The editor's Save path has the same shape.
///
/// That is precisely the outcome `write_text`'s atomic-write comment says the design exists to
/// prevent, arriving through the read instead of the write. So: NotFound (the genuine first-run
/// case) still yields the seed; everything else propagates, and the write is refused.
pub fn read_text_strict(app_data: &Path) -> Result<String, String> {
    match std::fs::read_to_string(guidelines_path(app_data)) {
        Ok(text) => Ok(text),
        // The one benign absence: no file yet. Every caller wants the seed here.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SEED_TEMPLATE.to_string()),
        Err(e) => Err(format!(
            "concierge guidelines: the existing file could not be read ({e}). Refusing to write, \
             because replacing it now would discard the rules already in it."
        )),
    }
}

/// Validate + atomically overwrite the file.
///
/// ATOMIC (tmp + rename), mirroring `config::write_atomic`, for the reason that applies to any file
/// the app rewrites in place: a naive truncate-then-write that dies between the two steps leaves a
/// truncated file, and here that silently amputates the user's accumulated rules.
pub fn write_text(app_data: &Path, text: &str) -> Result<(), String> {
    check_size(text)?;
    let path = guidelines_path(app_data);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create app data dir: {e}"))?;
    }
    // A UNIQUE tmp name per write, not a fixed one (roborev 54859). Unlike config.toml, this file
    // has TWO independent write surfaces that can overlap: the user's editor Save and the
    // concierge's own `append_concierge_guideline`, which fires on its own initiative mid-turn.
    // Two writers sharing one scratch path both open-and-truncate it, and the interleaving can
    // publish a mixed or truncated file through the rename. With a unique tmp per write the rename
    // is the only contended step, so the worst case degrades to last-writer-wins — a lost edit
    // instead of a corrupted file.
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_extension(format!("md.tmp.{}.{n}", std::process::id()));
    // BOTH failure paths clean up, not just the rename (roborev 54890). A failed write (ENOSPC,
    // EPERM, a partial write) used to self-heal only because the tmp name was fixed and the next
    // write truncated it; a unique name makes every failure a permanent orphan instead — sitting
    // next to the real file, possibly holding part of the user's rules, in a directory this module
    // tells them to open in Finder.
    std::fs::write(&tmp, text).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("write guidelines: {e}")
    })?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        // Don't leave the scratch file behind when the publish step fails.
        let _ = std::fs::remove_file(&tmp);
        format!("replace guidelines: {e}")
    })
}

/// Reject text over the cap, with a message that says the number rather than just "too large" —
/// the user is looking at an editor and needs to know how much to cut.
fn check_size(text: &str) -> Result<(), String> {
    if text.len() > MAX_BYTES {
        return Err(format!(
            "concierge guidelines are {} bytes; the limit is {MAX_BYTES} bytes ({} KiB). This text \
             is sent to the concierge on every single turn, so it is kept small on purpose.",
            text.len(),
            MAX_BYTES / 1024
        ));
    }
    Ok(())
}

/// Render ONE appended rule as a markdown list item. Pure, so the format is pinned by a test.
///
/// FORMAT IS DELIBERATELY BORING: one list item, one line, attribution in a visible italic
/// parenthetical. Three properties fall out of that and each is load-bearing —
///  * ONE LINE per rule means every append is a one-line diff, so `git diff` on this file reads as
///    a list of decisions rather than a reflow;
///  * VISIBLE attribution (not an HTML comment) is the trust story: when the concierge writes a
///    rule for itself, the user must be able to SEE that it did, in the rendered file, without
///    reading source;
///  * the rule text is flattened to a single line, so a multi-line rule cannot smuggle in list
///    items, headings, or a fake attribution of its own.
fn format_rule(rule: &str, attribution: &str, date: &str) -> String {
    // BOTH fields are flattened (roborev 54859). Flattening only `rule` left the smuggling path
    // that is actually under the model's control open: `attribution` arrives from the same
    // `append_concierge_guideline` command, and this file is injected verbatim into the system
    // prompt every turn — so a newline in it writes headings or forged list items straight into the
    // concierge's own instructions. "One rule is one line" has to mean the whole line.
    let rule = flatten(rule);
    let attribution = flatten(attribution);
    format!("- {rule} _(added by {attribution}, {date})_\n")
}

/// One line in, one line out. See {@link format_rule} and `rosterLine` in the frontend, which
/// closes the same hole on the roster side.
fn flatten(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Append one rule to the file, seeding the file first when it is absent.
///
/// THE PRIMITIVE THE CONCIERGE'S OWN TOOL CALLS (that tool is a separate unit; this is the storage
/// half). Appends at END OF FILE, always — the seed ends with the rules list, so a new item lands in
/// that list naturally, and "always the end" is the only insertion rule that keeps every append a
/// clean one-line diff regardless of how the user has since restructured the file.
///
/// Returns the file's new full text so a caller can echo it back without a second read.
pub fn append_rule(
    app_data: &Path,
    rule: &str,
    attribution: &str,
    date: &str,
) -> Result<String, String> {
    let flat_rule = rule.trim();
    if flat_rule.is_empty() {
        return Err("concierge guideline: the rule text is empty".into());
    }
    let attribution = attribution.trim();
    if attribution.is_empty() {
        return Err("concierge guideline: attribution is required (who added this rule?)".into());
    }
    // Reads the SEED when absent, so the very first append writes a complete, headed file rather
    // than a lone orphaned bullet.
    // STRICT: this is a read-modify-write. An unreadable existing file must abort the append, not
    // silently seed it and replace the user's accumulated rules. See `read_text_strict`.
    let mut text = read_text_strict(app_data)?;
    // Guarantee the new item starts its own line even if the user's last edit dropped the trailing
    // newline (editors differ, and an append onto a partial line would corrupt that line's rule).
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&format_rule(flat_rule, attribution, date));
    // The cap is enforced HERE too, not only on the editor path: the concierge appends on its own
    // initiative, so an unbounded append loop is exactly the way this file would grow without a
    // human ever seeing it.
    write_text(app_data, &text)?;
    Ok(text)
}

/// The block appended to `--append-system-prompt` after the persona, or "" when there is nothing to
/// say. Pure — this is the function the injection tests drive.
///
/// EMPTY IN, EMPTY OUT. A file the user has emptied (or blanked to whitespace) must inject NOTHING,
/// not a heading introducing an empty section: a dangling "here are the user's rules" followed by
/// nothing invites the model to invent some.
pub fn injection_block(text: &str) -> String {
    if text.trim().is_empty() {
        return String::new();
    }
    format!("{INJECTION_HEADING}{}", text.trim())
}

/// The guidelines block for THIS app's data dir, ready to append to the persona. Empty when the
/// file is blank. Used by `concierge::spawn_turn`, which is the single choke point both the user-send
/// path and the proactive-push path pass through — so "every turn" is true by construction rather
/// than by remembering to call this twice.
pub fn injection_for_app(app: &AppHandle) -> String {
    match crate::dev_identity::app_data_dir(app) {
        Ok(dir) => injection_block(&read_text(&dir)),
        // No app-data dir is a far bigger problem than missing manners; the turn still runs.
        Err(e) => {
            tracing::warn!(error = %e, "concierge guidelines: no app data dir; injecting nothing");
            String::new()
        }
    }
}

// ================================ date, without a date crate ==================================
// `Cargo.toml` pulls in neither `chrono` nor `time`, and one stamp on one appended line is not a
// reason to add a dependency (and its build cost) to the desktop binary. This is Howard Hinnant's
// `civil_from_days`, which is exact for the whole proleptic Gregorian range — and being pure, it is
// testable against known dates instead of "whatever today happens to be".

/// `YYYY-MM-DD` for a Unix timestamp in seconds (UTC). Pure.
pub fn ymd_from_unix(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    // Shift the epoch to 0000-03-01 so leap days land at the END of the cycle and the month/day
    // arithmetic below needs no special case for February.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Today, UTC, as `YYYY-MM-DD`. Falls back to the epoch date if the system clock is before 1970
/// (impossible in practice; handled rather than panicking on an unwrap).
fn today_utc() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    ymd_from_unix(secs)
}

// ==================================== command layer ==========================================
// Thin by design: resolve the app-data dir, delegate to the pure core above. Registered in lib.rs
// alongside the config commands.

fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    crate::worktree::app_data_dir_pub(app)
}

/// Raw text of the guidelines file (the seed template if it doesn't exist yet).
#[tauri::command]
pub fn read_concierge_guidelines(app: AppHandle) -> Result<String, String> {
    // STRICT, because what the editor loads it will later SAVE. Handing it the seed for a file that
    // exists but could not be read would show the user a fresh-looking template over their real
    // rules, and their next Save would make that the truth.
    read_text_strict(&app_data(&app)?)
}

/// Overwrite the whole guidelines file (the editor's Save). Rejects text over `MAX_BYTES`.
#[tauri::command]
pub fn write_concierge_guidelines(app: AppHandle, text: String) -> Result<(), String> {
    write_text(&app_data(&app)?, &text)
}

/// Append one attributed rule, creating the file from the seed first if absent. Returns the file's
/// new full text. `attribution` says WHERE the rule came from (e.g. "the concierge").
#[tauri::command]
pub fn append_concierge_guideline(
    app: AppHandle,
    rule: String,
    attribution: String,
) -> Result<String, String> {
    append_rule(&app_data(&app)?, &rule, &attribution, &today_utc())
}

/// Absolute path to the guidelines file, for "Reveal in Finder". Reported whether or not the file
/// exists yet — the caller may be about to create it.
#[tauri::command]
pub fn concierge_guidelines_path(app: AppHandle) -> Result<String, String> {
    Ok(guidelines_path(&app_data(&app)?).to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn absent_file_reads_as_the_seed_template() {
        let d = dir();
        // The contract `config::read_config_text` set: absent is not an error and not blank.
        assert_eq!(read_text(d.path()), SEED_TEMPLATE);
        // ...and reading must not CREATE it. An install that never opens the pane stays clean, and
        // a later seed change still reaches it.
        assert!(!guidelines_path(d.path()).exists());
    }

    #[test]
    fn the_seed_carries_the_five_founder_rules_in_order() {
        // These five are founder decisions, each stated separately, so each gets its own tripwire:
        // the seed is prose handed to a model, and a rewrite that quietly drops one would otherwise
        // fail nothing at all.
        let rules = [
            "Agent names are always clickable pills, never bare text.",
            "Lead with what needs me, tightest-first",
            "Don't paste `file:line` references as if they were self-explanatory",
            "Say plainly when a tool refused or an action didn't happen",
            "Stop re-reporting unchanged state",
        ];
        let mut at = 0usize;
        for r in rules {
            let found = SEED_TEMPLATE[at..]
                .find(r)
                .unwrap_or_else(|| panic!("seed is missing the rule: {r}"));
            at += found + r.len();
        }
        // The header has to say whose file it is — that is the whole point of app-owned storage.
        assert!(SEED_TEMPLATE.contains("This file is YOURS"));
        // ...and that it is not a permission surface.
        assert!(SEED_TEMPLATE.contains("do not grant it permissions"));
    }

    #[test]
    fn write_then_read_round_trips() {
        let d = dir();
        write_text(d.path(), "- be terse\n").unwrap();
        assert_eq!(read_text(d.path()), "- be terse\n");
    }

    #[test]
    fn write_leaves_no_tmp_file_behind() {
        // The atomic write is tmp + rename; a leftover scratch file would mean the rename never ran.
        let d = dir();
        write_text(d.path(), "hello\n").unwrap();
        assert!(scratch_files(d.path()).is_empty(), "{:?}", scratch_files(d.path()));
    }

    /// Every scratch file left in `dir`. ONE scanner, shared by all three tests that assert on
    /// leftovers (roborev 54890).
    ///
    /// This exists because the previous inline copy filtered on `ends_with(".tmp")`, and making the
    /// tmp name unique per write (`.md.tmp.<pid>.<n>`) silently stopped it matching ANYTHING — a
    /// live-looking guard that could no longer fail, introduced by the very commit that was fixing
    /// two other assertions that could not fail. A shared scanner means the next change to the
    /// naming scheme breaks one function, not three assertions that each look fine in isolation.
    fn scratch_files(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".tmp"))
            .collect()
    }

    #[test]
    fn a_failed_publish_cleans_up_its_scratch_file() {
        // With a FIXED tmp name a failed publish self-healed — the next write truncated and reused
        // the same path. A unique name per write removes that accident, so every failure would
        // otherwise leave a distinct orphan holding a copy of the user's rules, permanently, beside
        // the real file in a directory the docs tell the user to open in Finder (roborev 54890).
        //
        // THE FAILURE IS INDUCED AT THE RENAME, and that choice is the whole reason this test is
        // worth anything. The obvious setup — block the WRITE by parking a directory at the tmp
        // path — makes `fs::write` fail before it creates anything, so there is no scratch file to
        // leak and the assertion passes whether or not the cleanup exists. That version was written
        // first and a mutation check (delete the cleanup, expect red) showed it still green. Putting
        // a directory at the DESTINATION instead lets the write succeed, so a real scratch file
        // exists on disk at the moment the publish fails — which is the only state that can
        // distinguish cleanup from no cleanup.
        let d = dir();
        std::fs::create_dir_all(d.path()).unwrap();
        std::fs::create_dir_all(guidelines_path(d.path())).unwrap();

        let err = write_text(d.path(), "hello\n").unwrap_err();
        assert!(err.contains("replace guidelines"), "{err}");
        let leftovers = scratch_files(d.path());
        assert!(leftovers.is_empty(), "orphaned scratch file: {leftovers:?}");
    }

    #[test]
    fn write_creates_a_missing_app_data_dir() {
        let d = dir();
        let nested = d.path().join("not").join("created").join("yet");
        write_text(&nested, "- hi\n").unwrap();
        assert_eq!(read_text(&nested), "- hi\n");
    }

    #[test]
    fn text_exactly_at_the_cap_is_accepted_and_one_byte_over_is_rejected() {
        let d = dir();
        let at_cap = "x".repeat(MAX_BYTES);
        write_text(d.path(), &at_cap).expect("exactly at the cap must be accepted");
        assert_eq!(read_text(d.path()).len(), MAX_BYTES);

        let over = "x".repeat(MAX_BYTES + 1);
        let err = write_text(d.path(), &over).unwrap_err();
        // The message must state the numbers — the user is in an editor deciding what to cut.
        assert!(err.contains(&MAX_BYTES.to_string()), "unhelpful message: {err}");
        assert!(err.contains(&(MAX_BYTES + 1).to_string()), "unhelpful message: {err}");
        // ...and the rejected write must not have touched the file.
        assert_eq!(read_text(d.path()).len(), MAX_BYTES);
    }

    #[test]
    fn append_seeds_the_file_first_when_it_is_absent() {
        let d = dir();
        let out = append_rule(d.path(), "Use my first name", "the concierge", "2026-07-29").unwrap();
        // Not a lone orphaned bullet — the whole headed seed, plus the new rule at the end.
        assert!(out.starts_with("# How Sparkle's concierge talks to me"));
        assert!(out.contains("Agent names are always clickable pills"));
        assert!(out.ends_with("- Use my first name _(added by the concierge, 2026-07-29)_\n"));
        assert_eq!(read_text(d.path()), out);
    }

    #[test]
    fn append_records_who_added_the_rule_and_when() {
        // Attribution is the trust story: the user must be able to see, in the rendered file, that
        // the concierge wrote a rule for itself.
        let line = format_rule("Stop apologising", "the concierge", "2026-07-29");
        assert_eq!(line, "- Stop apologising _(added by the concierge, 2026-07-29)_\n");
    }

    #[test]
    fn an_unreadable_existing_file_aborts_the_append_instead_of_replacing_it() {
        // THE DATA-LOSS GUARD (roborev 54859). With the lossy read, an existing-but-unreadable file
        // handed `append_rule` the SEED, and its atomic write then replaced months of accumulated
        // rules with "seed + 1 rule" — reporting success. NotFound is still the seed; nothing else is.
        let d = dir();
        let p = guidelines_path(d.path());
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        // Non-UTF-8 bytes — what an external editor can leave behind. `read_to_string` fails with
        // InvalidData, not NotFound.
        std::fs::write(&p, [0xff, 0xfe, 0x00]).unwrap();

        let err = append_rule(d.path(), "be terse", "Sparkle", "2026-07-29").unwrap_err();
        assert!(err.contains("could not be read"), "{err}");
        // The bytes on disk are untouched — the append refused rather than overwriting.
        assert_eq!(std::fs::read(&p).unwrap(), vec![0xff, 0xfe, 0x00]);
        // And the read-only injection path still degrades rather than failing the turn.
        assert_eq!(read_text(d.path()), SEED_TEMPLATE);
    }

    #[test]
    fn a_missing_file_still_seeds_rather_than_erroring() {
        // The other half: NotFound is the genuine first run and must NOT be an error.
        let d = dir();
        assert_eq!(read_text_strict(d.path()).unwrap(), SEED_TEMPLATE);
    }

    #[test]
    fn append_flattens_the_attribution_too_not_just_the_rule() {
        // Attribution reaches `format_rule` from the same model-authored command as `rule`, and this
        // file is injected verbatim into the system prompt every turn — so a newline in it writes
        // headings and forged list items into the concierge's own instructions. Flattening only the
        // rule left open the path actually under the model's control (roborev 54859).
        let out = format_rule("be terse", "me\n## Heading\n- foRged rule", "2026-07-29");
        // ONE LINE is the whole property. The text is not censored — a `##` that stays inside the
        // attribution parenthetical is inert prose. What must not survive is the LINE BREAK, which
        // is what would turn it into a heading and a list item in the injected file.
        assert_eq!(out.lines().count(), 1, "{out}");
        assert!(out.contains("me ## Heading - foRged rule"), "{out}");
    }

    #[test]
    fn concurrent_writes_never_share_a_scratch_file() {
        // A fixed tmp name is only atomic against a CRASH, not against a second writer — and this
        // file has two independent write surfaces (the editor's Save and the concierge's own
        // append) that can overlap (roborev 54859). Two writes must not collide on one tmp path.
        let d = dir();
        std::fs::create_dir_all(d.path()).unwrap();
        write_text(d.path(), "# one").unwrap();
        write_text(d.path(), "# two").unwrap();
        // Last writer wins, and nothing is left behind either time.
        assert_eq!(read_text(d.path()), "# two");
        let leftovers = scratch_files(d.path());
        assert!(leftovers.is_empty(), "scratch files left behind: {leftovers:?}");
    }

    #[test]
    fn append_flattens_a_multiline_rule_into_one_list_item() {
        // One rule = one line = a one-line diff. A rule carrying newlines would otherwise inject
        // its own list items, headings, or a forged attribution.
        let line = format_rule("be\n  terse\n\n- and never say 'certainly'", "me", "2026-07-29");
        assert_eq!(line.matches('\n').count(), 1);
        assert_eq!(line, "- be terse - and never say 'certainly' _(added by me, 2026-07-29)_\n");
    }

    #[test]
    fn append_starts_a_new_line_when_the_file_lacks_a_trailing_newline() {
        let d = dir();
        write_text(d.path(), "- first rule").unwrap(); // no trailing newline
        let out = append_rule(d.path(), "second rule", "me", "2026-07-29").unwrap();
        assert_eq!(out, "- first rule\n- second rule _(added by me, 2026-07-29)_\n");
    }

    #[test]
    fn append_rejects_an_empty_rule_or_missing_attribution() {
        let d = dir();
        assert!(append_rule(d.path(), "   ", "the concierge", "2026-07-29").is_err());
        assert!(append_rule(d.path(), "a rule", "  ", "2026-07-29").is_err());
        // Neither failed attempt may create the file.
        assert!(!guidelines_path(d.path()).exists());
    }

    #[test]
    fn append_is_bounded_by_the_same_cap_as_the_editor() {
        // The concierge appends on its OWN initiative, so this is the path where unbounded growth
        // would happen with no human in the loop.
        let d = dir();
        write_text(d.path(), &"x".repeat(MAX_BYTES - 10)).unwrap();
        let err = append_rule(d.path(), "one more rule", "the concierge", "2026-07-29").unwrap_err();
        assert!(err.contains("the limit is"), "unexpected error: {err}");
    }

    #[test]
    fn injection_block_is_empty_for_a_blank_or_whitespace_only_file() {
        // No dangling "here are the user's rules" heading with nothing under it — that invites the
        // model to invent some.
        assert_eq!(injection_block(""), "");
        assert_eq!(injection_block("   \n\t\n  "), "");
    }

    #[test]
    fn injection_block_labels_the_section_and_states_it_grants_no_permission() {
        let b = injection_block("- be terse\n");
        assert!(b.starts_with("\n\n"), "must separate cleanly from the persona above it");
        assert!(b.contains("THE USER'S OWN COMMUNICATION GUIDELINES"));
        assert!(b.contains("a file the USER owns and edits"));
        // The security boundary: user-editable text reaching a system prompt must be told, in the
        // prompt itself, that it is not a permission surface.
        assert!(b.contains("never grants you a permission"));
        assert!(b.ends_with("- be terse"));
    }

    #[test]
    fn ymd_from_unix_matches_known_dates() {
        assert_eq!(ymd_from_unix(0), "1970-01-01");
        assert_eq!(ymd_from_unix(1_753_747_200), "2025-07-29");
        // Leap day, the case the shifted-epoch arithmetic exists to get right.
        assert_eq!(ymd_from_unix(1_582_934_400), "2020-02-29");
        assert_eq!(ymd_from_unix(1_582_934_400 + 86_400), "2020-03-01");
        // A negative timestamp must floor, not truncate toward zero.
        assert_eq!(ymd_from_unix(-1), "1969-12-31");
    }
}
